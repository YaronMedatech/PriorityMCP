import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, detectHosting, listEnvironments, loadConfig, resolveEnvironment } from "./config.js";
import { CompanyContext } from "./companies.js";
import { elicitCredentials, loadAuthPolicy } from "./auth.js";
import { PriorityODataError } from "./odata.js";
import { CallerError } from "./errors.js";
import { Examples, Glossary } from "./glossary.js";
import { ENTITY_KINDS, fetchColumnHelp, fetchEntityHelpOutcome } from "./help.js";
import { fetchSkill, listSkills, matchSkills } from "./skills.js";
import type { InputValue, SessionAction } from "./programs.js";
import { loadProgramDenyList, loadProgramPolicy, resolveProgram } from "./programselect.js";
import {
  aggregateShape,
  describeScreen,
  describeScreenShape,
  distinctShape,
  queryShape,
  runQuery,
  searchScreens,
  searchScreensShape,
} from "./discovery.js";
import { runAggregate, runDistinct, type AggFn } from "./aggregate.js";
import { buildReadiness } from "./readiness.js";
import { getSales } from "./sales.js";
import { salesInputShape, salesInputSchema } from "./salesSchema.js";
import { z } from "zod";

// MCP server over Priority's OData API.
//
// The shape is discovery-first: find a screen by its Hebrew name, learn what its
// columns mean, then read it. get_sales remains as a curated fast path, but it is
// no longer the only way in -- which matters because a hand-written map of screen
// semantics is exactly what got CINVOICES wrong.
//
// stdout IS the protocol channel. A stray console.log here corrupts the JSON-RPC
// stream and the client disconnects with a parse error that points nowhere near
// the real cause. Every diagnostic in this file goes to stderr.
const log = (msg: string) => process.stderr.write(`[priority-mcp] ${msg}\n`);

/** One spelling of "on" for every flag, so .env behaves the same everywhere. */
const envFlag = (name: string): boolean =>
  ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());

const SALES_DESCRIPTION = `Read sales documents from Priority ERP for a date range.

A curated shortcut over four invoice screens, with per-currency totals and
storno pairing already worked out. For anything else -- or to check what a screen
actually is -- use search_screens, describe_screen and query instead.

  AINVOICES  tax invoice
  EINVOICES  tax invoice + receipt; also carries payment lines
  FINVOICES  export invoice
  CINVOICES  consolidated invoice

Reading the result:
- Every total is grouped BY CURRENCY, and there is deliberately no single global
  total. ANY document type can be denominated in a foreign currency -- not just
  export invoices -- so always read each row's 'currency' rather than assuming one
  from the document type. Never add figures from different currencies together;
  report each currency separately, with its currency named.
- Each document carries 'sign' and 'totalSigned' (total*sign), and 'netTotal' in
  the summary applies those signs. Read them from the data rather than assuming a
  screen's direction from its name.
- If 'truncated' is true the results are INCOMPLETE and the totals are a lower
  bound. Say so; do not present them as final.
- Cancelled (storno) documents ARE included by default, because a cancellation is
  a real dated event in the books. Priority cancels by writing a mirror-image
  reversing document, so a cancellation is a PAIR that nets to zero.
- The two halves are dated independently -- a sale booked in one month can be
  reversed in a later one; the reversal is NOT backdated. So check the
  'cancellations' block: 'straddlingRange' lists cancelled documents whose
  counterpart falls outside the requested range. Each shifts the totals by its
  full amount with nothing here to offset it, and is usually the explanation for
  a period that looks unexpectedly negative or inflated. Say so when it is
  non-empty, and offer to widen the date range.
- 'skipped' lists screens the Priority server does not expose to the API. Those
  document types are missing from the totals entirely -- report that too.

Set includeLines only when the question is about parts or quantities; lines
multiply the response size considerably.`;

/**
 * Build the server with its tools registered, independent of transport.
 *
 * Exported so the stdio entry point and the HTTP one expose exactly the same
 * tools. Duplicating the registrations per transport is how the two drift.
 */
export function buildServer(
  opts: { authHeader?: string; identity?: string; company?: string } = {},
): McpServer {
  // The company is held in a context rather than fixed here, so the model can
  // list what exists, offer it, and switch when the user picks one. `ctx.client`
  // and `ctx.dict` are read at CALL time, which is what makes a switch take
  // effect for everything registered below.
  let ctx: CompanyContext;
  try {
    // Fail fast and loudly on stderr: a config error surfaced as a tool error on
    // every call is far harder to diagnose than a refusal to start.
    const initial = resolveEnvironment(opts.company ?? null);
    loadConfig(initial);
    // Said once at startup so a wrong guess is visible before a program tool is
    // ever called. Configured for several installations, this is the setting
    // most likely to be right on one of them and wrong on another.
    log(`hosting: ${detectHosting().detail}`);
    ctx = new CompanyContext(initial, opts.authHeader);
  } catch (err) {
    if (err instanceof ConfigError) {
      log(`configuration error:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const glossary = new Glossary();
  const examples = new Examples();

  const glossaryError = glossary.loadError;
  if (glossaryError) {
    log(`glossary unavailable (${glossaryError}) — business-term mapping is off`);
  } else {
    log(`glossary loaded: ${glossary.all().length} terms`);
  }

  // Where this session's Priority credentials come from. See src/auth.ts.
  const authPolicy = loadAuthPolicy();

  // run_program is the only tool here that can change anything, so it is the only
  // thing read-only mode has to take away. The discovery and read tools are NEVER
  // gated: strip search_screens or describe_screen and the model has no way to
  // learn a screen name, so it starts inferring them from English codes -- which
  // is the exact failure this server exists to prevent.
  const readOnly = envFlag("PRIORITY_READ_ONLY");

  // Skills authored inside Priority (AIWORKFLOWS). Off by default: the operator
  // decided on 2026-09-02 not to pursue them for now, and on this installation the
  // screen is closed to the API anyway. Two tools that always answer "closed"
  // would cost the model ~1KB of instructions per session and invite calls that
  // cannot succeed. The code stays; the flag brings it back.
  const skillsEnabled = envFlag("PRIORITY_ENABLE_SKILLS");

  // Stated in the instructions, not just enforced in the registration. A client
  // puts these in its system prompt, and a model told it has a way to act will
  // keep hunting for the tool that provides it.
  const writeRule = readOnly
    ? `- This server is READ-ONLY. It cannot change Priority data and cannot run any
  program or procedure -- the operator turned that off. If a question can only be
  answered by changing something, say that it cannot be done here.`
    : `- This server is READ-ONLY except for run_program, start_program and
  continue_program, which can change data. run_program must be called without
  inputs first to see what it would do. When a program stops at a CHOICE or a
  MESSAGE, stop and put it to the user -- never choose or acknowledge for them.`;

  // Which company this session starts on, stated up front.
  //
  // Without it every answer is ambiguous: "we invoiced 659,283" means nothing
  // unless the reader knows which company was counted, and one installation here
  // serves several. The model CAN move between them with use_company, so the rule
  // is not "you are stuck here" but "say which company a figure came from, and
  // never mix two in one answer".
  const others = listEnvironments().filter((c) => c !== ctx.company);
  const companyRule =
    `- You are reading the Priority company '${ctx.company}'. Every figure you report ` +
    `comes from it and from no other, so name the company whenever a number could be ` +
    `mistaken for another company's.` +
    (others.length
      ? `\n- This installation also serves ${others.join(", ")}. Call list_companies to ` +
        `get their real names from Priority, SHOW THAT LIST TO THE USER and let them ` +
        `pick; then call use_company to switch. Do this whenever the user's question ` +
        `might be about a different company, when they ask which companies exist, or ` +
        `at the start of a session if it is not obvious which one they mean — do not ` +
        `assume the default is the one they want. After switching, say which company ` +
        `you moved to, and never mix figures from two companies in one answer.\n` +
        `- Switching company changes THE DATA ONLY. Screen names, column titles, help ` +
        `text and sub-form structure are defined for the whole installation and are ` +
        `identical in every company, so do NOT re-run search_screens or describe_screen ` +
        `after a switch — what you already learned about a screen still holds. Only the ` +
        `rows differ. What CAN differ is whether a given screen is open to the API in ` +
        `that company, so a read that fails after switching is a permission matter, not ` +
        `a different screen.`
      : "");

  // Server-level instructions: the rules that belong to NO single tool.
  //
  // Clients place this in the system prompt. Without it, cross-cutting rules --
  // case sensitivity, the discovery order, never summing currencies -- had to be
  // repeated inside several tool descriptions, which is both wasteful and how the
  // copies drift apart.
  const INSTRUCTIONS = `This server reads a live Priority ERP installation. Its data is real: figures
you report will be acted on, so accuracy matters more than completing an answer.

How to approach a question:
1. search_screens FIRST when the question names a business concept. Screen names
   are opaque English codes whose meaning lives in the Hebrew title, and inferring
   one from the other is unreliable -- CINVOICES reads like "credit invoices" and
   is in fact consolidated invoices.
2. describe_screen before reading a screen you have not used. Its help text says
   what the screen is FOR, which is faster and safer than guessing from columns.
   For a single column, a report or a procedure, use help -- it reads Priority's
   own documentation for that exact thing, including what a program will DO.
3. column_values before filtering on any code column. Nothing states that IVTYPE
   is 'A'; a filter on a value that does not exist returns zero rows and looks
   exactly like "there is no data".
4. aggregate for any total, count or "per X" question. query is for detail rows
   and is capped, so a total built from it is wrong as soon as the data exceeds
   one page.

Rules that apply throughout:
${companyRule}
- Screen and column names are CASE-SENSITIVE. Copy them; do not retype them.
- NEVER add amounts in different currencies together. Any document type here can
  be denominated in a foreign currency. Report each currency separately, named.
- A capped or partial result is not an answer. When a reply says hasMore,
  truncated, or complete:false, either continue paging or say plainly that the
  figure is a lower bound.
- Cancellations in Priority are mirror-image reversing documents, and the two
  halves can fall in different periods. A period that looks oddly negative or
  inflated is usually a reversal whose original lies outside the range.
${writeRule}
- If something cannot be reached, say so and say why. Do not substitute a
  different screen and present it as the answer.`;

  const server = new McpServer(
    { name: "priority", version: "0.3.0" },
    { instructions: INSTRUCTIONS },
  );

  /**
   * Make sure the session has an identity before anything reads Priority.
   *
   * Runs at most once per session and only when it has to. Returns a message to
   * hand back to the caller when it cannot, rather than throwing: "you are not
   * signed in" is an answer the model should relay to the user, not a crash.
   */
  let authAttempted = false;
  let authProblem: string | null = null;
  const ensureIdentity = async (): Promise<string | null> => {
    if (ctx.hasCallerIdentity) return null;
    if (authPolicy.mode === "shared") return null;

    if (authPolicy.mode === "headers") {
      return (
        `This server is configured to require each caller's own Priority credentials ` +
        `(PRIORITY_AUTH_MODE=headers), and none were sent. Add X-Priority-User and ` +
        `X-Priority-Pass — or X-Priority-Token — to the MCP server entry in your ` +
        `client's configuration file, then reconnect. They belong in the config, not ` +
        `in this conversation.`
      );
    }

    // elicit: ask once. A second prompt on every call would be worse than a
    // clear refusal, so the outcome is remembered either way.
    if (authAttempted) return authProblem;
    authAttempted = true;

    const outcome = await elicitCredentials(server, ctx.company);
    if (outcome.authHeader) {
      ctx.setAuthHeader(outcome.authHeader);
      log("credentials received from the user via elicitation");
      authProblem = null;
      return null;
    }

    if (outcome.unsupported && authPolicy.fallback === "shared") {
      log(`elicitation unavailable, falling back to the shared identity: ${outcome.problem ?? ""}`);
      authProblem = null;
      return null;
    }

    authProblem = outcome.problem ?? "Priority credentials are not available for this session.";
    return authProblem;
  };

  const registered: string[] = [];

  /** Shared wrapper: log the call, JSON the result, turn a throw into readable text. */
  const handler =
    <T>(name: string, run: (args: T) => Promise<unknown>) =>
    async (args: T) => {
      const started = Date.now();
      const who = opts.identity ? `[${opts.identity}] ` : "";

      // Logged BEFORE the call, and kept even though the outcome line below names
      // the tool again: a call that never comes back logs nothing else, and a
      // Priority server under load is exactly how that happens. This line is the
      // only record of what was in flight.
      //
      // Arguments go in unredacted deliberately. No tool here accepts a
      // credential -- that is why caller identities arrive as HTTP headers -- so
      // there is nothing in args worth hiding, and truncating them would cost the
      // filter that explains a wrong answer.
      log(`${who}${name} ${JSON.stringify(args)}`);
      try {
        // Identity before data. Only reached when the policy needs one and the
        // session does not have it yet; `shared` mode returns immediately.
        const missing = await ensureIdentity();
        if (missing) {
          log(`  -> refused: no Priority identity`);
          return {
            content: [{ type: "text" as const, text: `Not signed in to Priority.\n\n${missing}` }],
            isError: true,
          };
        }

        const result = await run(args);
        const text = JSON.stringify(result, null, 2);
        // Size in characters, not rows: results are different shapes per tool and
        // a generic row count would be a guess. Characters are comparable across
        // all of them, and a reply that came back enormous is worth seeing.
        log(`  -> ok ${Date.now() - started}ms, ${text.length} chars`);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        // Hand the model a sentence it can act on or relay, not a stack trace.
        const message =
          err instanceof PriorityODataError || err instanceof Error ? err.message : String(err);
        log(`  -> error ${Date.now() - started}ms: ${message}`);
        return {
          content: [{ type: "text" as const, text: `Priority call failed.\n\n${message}` }],
          isError: true,
        };
      }
    };

  /**
   * One parameter value: a bare string, or the object form that carries an
   * operator and a second value. Priority's input dialogs are filters as much as
   * they are forms -- 'between these two dates' is an operator, not a value --
   * and a string-only schema cannot say it.
   */
  const INPUT_VALUE = z.union([
    z.string(),
    z.object({
      value: z.string(),
      operator: z.number().int().optional().describe("An 'op' from the step's operators list."),
      value2: z.string().optional().describe("The upper bound, when the operator is a range."),
    }),
  ]);

  const READ_ONLY_HINTS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  /**
   * Upper-cased names of the programs the catalog allows. Read per call, not
   * once: the operator edits programs.json while the server runs, and a stale
   * copy would tell the model a program is not runnable after it was added.
   * A broken or missing catalog means "nothing is runnable", not an error here.
   */
  const runnableNames = (): Set<string> => {
    try {
      if (ctx.programs.configError) return new Set();
      return new Set(ctx.programs.readCatalog().map((p) => p.name.trim().toUpperCase()));
    } catch {
      return new Set();
    }
  };

  // How much of Priority the program tools may reach. Read once at startup: it
  // decides tool DESCRIPTIONS, which a client caches for the session, so it
  // could not vary per call even if that were wanted.
  const programPolicy = loadProgramPolicy();
  const programDeny = loadProgramDenyList();
  if (programPolicy === "all") {
    log(
      `programs: ALL procedures and reports may be run (PRIORITY_ALLOW_ALL_PROGRAMS)` +
        `${programDeny.size ? `, except ${[...programDeny].join(", ")}` : " — no deny list set"}`,
    );
  } else {
    log(`programs: only those in the catalog may be run (${runnableNames().size} listed)`);
  }

  /** The paragraph both program tools open with, so the model reads one rule. */
  const programScope =
    programPolicy === "all"
      ? `SCOPE: any procedure or report in this Priority may be run, not only the
catalogued ones. That makes YOU responsible for what a program does. Before
running anything not in list_programs:
  1. read help{name, type} -- Priority's own description of it;
  2. tell the user what it is and ask, if it is a procedure (P). A report (R)
     renders output; a PROCEDURE CAN CHANGE, POST OR DELETE DATA, and there is
     no undo.
A reply carrying 'caution' means nothing is documented here about that program.
Never run a name you inferred; find it with search_screens{kinds:['P','R']}.`
      : `SCOPE: only the programs in list_programs may be run. A name outside that
catalog is refused, and the refusal is the answer -- report it rather than
trying a different name.`;

  server.registerTool(
    "search_screens",
    {
      title: "Find Priority screens by name",
      annotations: READ_ONLY_HINTS,
      description: `Search Priority's screen dictionary by Hebrew title, internal name, module or table.

START HERE when a question names a business concept rather than a screen. Priority
screen names are opaque English codes and their meaning lives in the Hebrew title,
so inferring a screen's purpose from its code is unreliable: CINVOICES reads like
"credit invoices" and is in fact consolidated invoices, while credit notes are a
different screen entirely. Look it up rather than inferring it.

Returns for each match: the internal name to use elsewhere (CASE-SENSITIVE), the
Hebrew title, the underlying table, the module, and how to read it.
'totalMatches' may exceed what is shown -- never assume you have seen every match.

READ 'access' ON EVERY RESULT. It decides how the screen is queried, and guessing
wrong looks like missing data rather than a mistake:
  direct       a normal entity set -- query{entity: NAME}
  via-parent   a SUB-FORM, not listed as an entity set. Read it through a screen
               in 'parents': query{entity: PARENT, expand: "NAME_SUBFORM"} for
               many rows, or query{path: "PARENT(key='...')/NAME_SUBFORM"} for one
               parent's lines. describe_screen on the child also works and names
               the parent. THAT ROUTE ALWAYS WORKS. Reading it directly as an
               entity ALSO succeeds for some screens here -- the service document
               under-reports on this installation -- so one direct attempt is
               reasonable before ruling it out.
  unavailable  not reachable by any route we know of. Report that; do not retry.

Most screens in Priority are sub-forms, so 'via-parent' is the common case, not an
edge case. A child screen appearing in these results IS readable; it just is not
readable as an entity.

When the reply carries a 'glossary' block, PREFER IT over 'screens'. Those are
curated business-term mappings maintained by the operator, and they exist because
title similarity gets these wrong: searching 'זיכוי' ranks 'נקודות זיכוי' (tax
credit points) above 'חשבוניות זיכוי' (credit notes). Each entry's 'notes' records
traps the titles do not show -- read them before using the screens.

PROCEDURES AND REPORTS are searchable too, by the same Hebrew titles: pass
kinds: ['P','R'] (or ['F','P','R'] for everything). They are not screens and
cannot be queried; each result carries 'kind', 'runnable' (will this server run
it) and 'documented' (did the operator record notes for it). Read what one does
with help{name, type} before anything else. 'runnable: false' means this server
will not run it -- report that, do not try a different name. The same
name can be a screen, a report AND a procedure (FORMMSG is all three).`,
      inputSchema: searchScreensShape,
    },
    handler("search_screens", async (args) => {
      const result = (await searchScreens(ctx.dict, args, glossary, examples, {
        catalogued: runnableNames(),
        policy: programPolicy,
      })) as Record<string, unknown>;
      // Skills authored in Priority, when the installation lets us read them.
      // Cached for ten minutes including a refusal, so this costs nothing on an
      // installation where the screen is closed.
      if (!skillsEnabled) return result;
      const skills = matchSkills(await listSkills(ctx.client), String(args.query ?? ""));
      if (!skills.length) return result;
      return {
        ...result,
        skills,
        notes: [
          ...((result["notes"] as string[] | undefined) ?? []),
          "'skills' are instructions written INSIDE Priority by its administrator for tasks " +
            "like this one. Fetch the relevant one with get_skill and follow it; it outranks " +
            "title similarity and usually the glossary too.",
        ],
      };
    }),
  );
  registered.push("search_screens");

  server.registerTool(
    "describe_screen",
    {
      title: "Describe a Priority screen's columns",
      annotations: READ_ONLY_HINTS,
      description: `Get one screen's columns, each with its Hebrew title, plus its keys and sub-forms.

Use this before querying a screen you have not read before -- it tells you what the
columns actually mean, which are mandatory, which are date-only, which are
read-only, and which sub-forms hold the line items. Do not guess column names.

Notes that matter when building a query afterwards:
- 'keys' can be composite. A keyed path needs every part.
- 'subforms' are NOT screens. Read them via expand, or a keyed path in query.
- A column may show dateType 'Date' while its type is Edm.DateTimeOffset. Filter
  literals still need the time component, e.g. 2025-01-01T00:00:00Z.
- Wide screens: pass 'columns' to filter by name or Hebrew title instead of
  reading hundreds of them.

DEEP DIVE -- pass 'depth' (1-3) to walk the screen's sub-forms recursively and get
the whole document structure in one call: header, its lines, and the lines' own
sub-forms, each with columns and with 'via' naming the navigation property to
reach it. Depth 1 usually costs no extra requests, because Priority returns a
screen's relatives in the same metadata document. The reply is capped by screens
and by total columns -- read 'budget.truncated' rather than assuming you saw
everything, and combine 'depth' with 'columns' on wide screens.

'includeColumnSources' adds, per column, its position on the form, its
form-specific label, and the table.column a value is READ FROM. That last one
often explains a column the title alone does not.

HELP is included by default -- Priority's own Hebrew documentation for the screen,
saying what it is for and how it relates to other screens. It is usually the
fastest way to understand an unfamiliar screen, so read it before inferring
purpose from column names. Its {ENTITY.TYPE} cross-references are resolved inline
and also listed in 'helpReferences', which is how the help points you at the
sub-form holding the line items. A deep walk carries help for child screens too.
'help: null' comes with a 'helpNote' saying WHY. On some installations that reason
is a permission refusal (HTTP 403): the help exists and this API user may not read
it. Say that; do not report that the screen has no help.

'includeColumnHelp: true' adds each shown column's own Priority help. It is one
request per column and capped, so combine it with 'columns'. Column help is
permitted separately from screen help and can be available where the screen's is
refused.`,
      inputSchema: describeScreenShape,
    },
    handler("describe_screen", (args) => describeScreen(ctx.client, ctx.dict, args)),
  );
  registered.push("describe_screen");

  server.registerTool(
    "help",
    {
      title: "Priority's own help for a screen, column, report or procedure",
      annotations: READ_ONLY_HINTS,
      description: `Read Priority's own documentation for one thing: a screen (F), a report (R), a
procedure (P), an interface (I), a menu (M) -- or a single COLUMN of a screen.

describe_screen already includes a screen's help. Use this tool when you need:
- what a REPORT or PROCEDURE does BEFORE running it (type 'R' or 'P'). Short of
  running it, this is the only way to know.
- what one COLUMN means (pass 'column') when its Hebrew title is not enough.
  Priority documents columns individually; describe_screen fetches those only on
  request because it is one call per column.

The text is Priority's own, in Hebrew, with HTML removed and {ENTITY.TYPE}
references resolved to names and titles where known; 'references' lists them as
data.

'available: false' carries a 'reason' -- READ IT. 'permission: true' means the help
exists and this API user is not allowed to read it: say that, do not report that
no help exists. Names are CASE-SENSITIVE, and one name can exist as several types
(FORMMSG is both a report and a procedure), so pass the type you mean.`,
      inputSchema: {
        name: z.string().describe("Entity name, e.g. AINVOICES or FORMTRIGREP. CASE-SENSITIVE."),
        type: z
          .enum(["F", "P", "R", "I", "M"])
          .optional()
          .describe(
            "F screen (default), P procedure, R report, I interface, M menu. Ignored " +
              "when 'column' is given: column help belongs to screens.",
          ),
        column: z
          .string()
          .optional()
          .describe(
            "A column of the screen in 'name', e.g. CUSTNAME. Returns that column's " +
              "own help instead of the screen's.",
          ),
      },
    },
    handler("help", async (args: { name: string; type?: string; column?: string }) => {
      // Titles for {X.F} references come from the dictionary; make sure it is there.
      await ctx.dict.ready();
      if (args.column) {
        const outcome = await fetchColumnHelp(ctx.client, ctx.dict, args.name, args.column);
        return { name: args.name, column: args.column, kind: "column", ...outcome };
      }
      const type = args.type ?? "F";
      const outcome = await fetchEntityHelpOutcome(ctx.client, ctx.dict, args.name, type);
      return { name: args.name, type, kind: ENTITY_KINDS[type] ?? type, ...outcome };
    }),
  );
  registered.push("help");

  server.registerTool(
    "query",
    {
      title: "Read rows from a Priority screen",
      annotations: READ_ONLY_HINTS,
      description: `Read individual rows from any Priority screen. READ-ONLY.

FOR TOTALS, COUNTS OR "PER X" QUESTIONS, USE 'aggregate' INSTEAD. This tool returns
detail rows and is capped at 500 per call, so any total you build by adding up
what it returns is wrong the moment the data exceeds one page. 'aggregate' pages
the whole set outside the conversation and returns the grouped answer.

Use 'entity' for a normal read, or 'path' for a keyed row or a sub-form.

This server's OData has real limitations. Working around them after a failure
wastes a turn, so respect them up front:
- contains(), startswith() and endswith() work in filter. The 'in' operator does
  NOT (this server answers HTTP 403 to it) -- use chained 'or' instead.
- Long filters break the URL: about 50 'or' terms alone, ~25 alongside expand.
- 'select' is ignored when 'expand' is set -- that combination truncates the
  response on this server. Use a nested $select inside expand instead.
- Avoid 'ne' on a nullable column; it drops the null rows silently.
- 'top' caps TOTAL rows, not page size, and 500 is the ceiling.
- Sub-forms are not entity sets; reach them via expand or a keyed path.

READING A SCREEN LARGER THAN ONE PAGE -- use 'skip', not a hand-built path.
Two separate ceilings apply: 500 rows, and a response size cap that a wide screen
can hit well inside 500 rows. Either one makes the reply a PAGE, not the answer.
When that happens the response carries 'hasMore' and 'nextSkip'; call again with
skip=nextSkip, keeping entity, filter, select, expand and orderby byte-identical,
until hasMore is false. Then combine the pages yourself. Passing select to fetch
only the columns you need fits more rows per page and is usually faster.

There is NO row total available: this server accepts $count and silently ignores
it. So "how many are there?" can only be answered by paging to the end, and a
count taken from a single page is a lower bound, never the answer.

'path' is restricted to screens inside the configured company: a known entity,
optional key parentheses, then navigation segments. Traversal, absolute URLs,
$metadata and $count are refused.

Read 'notes' on the response -- it reports when a result was capped or an option
was ignored, and treating a capped result as complete produces wrong totals.`,
      inputSchema: queryShape,
    },
    handler("query", (args) => runQuery(ctx.client, ctx.dict, args)),
  );
  registered.push("query");

  server.registerTool(
    "aggregate",
    {
      title: "Group and total rows from a Priority screen",
      annotations: READ_ONLY_HINTS,
      description: `Group, count and total rows WITHOUT pulling them into the conversation.

USE THIS INSTEAD OF query FOR ANY "how much / how many / per month / by customer /
top N" QUESTION. Priority cannot aggregate -- it accepts OData's $apply and
silently ignores it, returning ungrouped rows -- so this server pages the data and
groups it here. That paging costs no context, which is the whole point: 'sales per
month' comes back as twelve rows instead of thousands, and the 500-row cap on
query stops applying.

Never try to aggregate by reading rows with query and adding them up. You would be
limited to 500 rows per call, and a total built from a capped page is wrong.

  groupBy    columns to group by; omit for one grand-total row
  aggregate  [{fn, column, as}] with fn = count | sum | avg | min | max
  filter     applied BEFORE grouping -- the main way to keep the scan cheap

A DateTimeOffset column is grouped by DAY, not by exact timestamp. For months or
years, group by the date and combine the days yourself, or filter to one period.

Read 'complete'. When false the scan hit its ceiling and every total is a LOWER
BOUND -- say so rather than presenting it as final. 'rowsScanned' tells you how
much was actually read.`,
      inputSchema: aggregateShape,
    },
    handler(
      "aggregate",
      (args: {
        entity: string;
        groupBy?: string[];
        aggregate: { fn: AggFn; column?: string; as?: string }[];
        filter?: string;
        maxRows?: number;
      }) =>
        runAggregate(
          ctx.client,
          args.entity,
          { groupBy: args.groupBy ?? [], aggregate: args.aggregate },
          {
            ...(args.filter === undefined ? {} : { filter: args.filter }),
            ...(args.maxRows === undefined ? {} : { maxRows: args.maxRows }),
          },
        ),
    ),
  );
  registered.push("aggregate");

  server.registerTool(
    "column_values",
    {
      title: "What values a column actually contains",
      annotations: READ_ONLY_HINTS,
      description: `List the values a column really takes, with how often each occurs.

Call this BEFORE filtering on any code column you have not seen. Nothing in the
metadata says that IVTYPE is 'A' or DEBIT is 'D', so filtering on a guessed value
is easy -- and it fails silently: a filter on a value that does not exist returns
zero rows, which reads as "there is no data" rather than "that code is wrong".
This is the quietest way to get a confidently wrong answer out of this server.

Also useful for spotting the shape of a column before grouping on it: a column
with thousands of distinct values is an identifier, not a category.

Returns values sorted by frequency. Read 'complete' -- when false, the scan was
capped and rare values may be missing.`,
      inputSchema: distinctShape,
    },
    handler("column_values", (args: { entity: string; column: string; filter?: string; limit?: number }) =>
      runDistinct(ctx.client, args.entity, args.column, {
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }),
    ),
  );
  registered.push("column_values");

  server.registerTool(
    "list_companies",
    {
      title: "Priority companies available to this session",
      annotations: READ_ONLY_HINTS,
      description: `List the Priority companies this server can work with, with their real names.

SHOW THIS LIST TO THE USER AND LET THEM CHOOSE. The 'company' field is the code
used in use_company; the 'name' field is what the company is actually called,
read from Priority's own ENVIRONMENT screen — that is the name to show a person,
because a code like 'zepc' means nothing to them.

Call it when the user asks which companies exist, when a question might concern a
different company than the current one, or at the start of a session when it is
not obvious which company is meant. Do not assume the active one is the intended
one just because it is the default.

'active: true' marks the company being read right now. 'name' can be null when
the ENVIRONMENT screen is unreadable or empty — 'note' says which.`,
      inputSchema: {},
    },
    handler("list_companies", async () => {
      const companies = await ctx.describeAll();
      const notOffered = await ctx.unofferedEnvironments();
      return {
        active: ctx.company,
        companies,
        ...(notOffered.length ? { notOfferedByThisServer: notOffered } : {}),
        note:
          "Show the user the 'name' of each company, not the code, and let them pick. " +
          "Then call use_company with that company's code.",
      };
    }),
  );
  registered.push("list_companies");

  server.registerTool(
    "use_company",
    {
      title: "Switch to another Priority company",
      annotations: READ_ONLY_HINTS,
      description: `Change which Priority company every later call reads.

Use it after the user picks one from list_companies. The switch applies to every
tool from that point on — search_screens, query, aggregate, everything — and lasts
for the rest of the session.

Say which company you switched to, and do not carry figures across the switch: a
total from the previous company is not comparable with one from this company
unless you state both companies explicitly.

An unknown company is refused and nothing changes; the reply lists what is
available. Names are CASE-SENSITIVE.`,
      inputSchema: {
        company: z.string().describe("Company code from list_companies, e.g. 'demo'. CASE-SENSITIVE."),
      },
    },
    handler("use_company", async (args: { company: string }) => {
      const previous = ctx.company;
      // switchTo validates through the same allowlist the transport uses; an
      // invalid name throws and the handler turns it into a readable tool error,
      // leaving the session on the company it was already using.
      const now = ctx.switchTo(args.company);
      const name = await ctx.currentName();
      log(`company switched: ${previous} -> ${now}`);
      return {
        switched: true,
        previousCompany: previous,
        company: now,
        name,
        note:
          `Every later call reads '${now}'${name ? ` (${name})` : ""}. Tell the user which ` +
          `company you moved to, and do not compare figures across the switch without ` +
          `naming both companies. THE DATA CHANGED, NOTHING ELSE: screen names, columns ` +
          `and help are the same across companies, so there is no need to re-run ` +
          `search_screens or describe_screen for screens you have already looked at.`,
      };
    }),
  );
  registered.push("use_company");

  server.registerTool(
    "readiness_report",
    {
      title: "Which screens can be asked about in natural language",
      annotations: { ...READ_ONLY_HINTS, openWorldHint: false },
      description: `Audit this installation for the gaps that make free-text questions fail.

Run it when a question returned nothing, or returned something that looks wrong,
and you want to know whether the data or the question was at fault. It reads the
cached dictionary only, so it costs no requests.

Reports, worst first: Hebrew titles shared by more than one readable screen (the
finding that produces confidently WRONG answers rather than visible failures),
readable screens with no Hebrew title, names that differ from another only by
letter case, screens unreachable by any route, and glossary entries pointing at
screens that no longer exist.

Each issue carries a suggested fix. Most of them are fixed by adding a glossary
entry rather than by changing anything in Priority.`,
      inputSchema: {},
    },
    handler("readiness_report", async () => {
      await ctx.dict.ready();
      const report = buildReadiness(ctx.dict, glossary, runnableNames());
      if (!skillsEnabled) return report;
      const skills = await listSkills(ctx.client);
      return {
        ...report,
        skills: skills.available
          ? { available: true, count: skills.count }
          : { available: false, reason: skills.reason },
      };
    }),
  );
  registered.push("readiness_report");

  if (!skillsEnabled) {
    log("skills tools are NOT registered (set PRIORITY_ENABLE_SKILLS=1 to expose list_skills / get_skill)");
  } else {
  server.registerTool(
    "list_skills",
    {
      title: "AI skills defined inside Priority",
      annotations: READ_ONLY_HINTS,
      description: `List the AI skills an administrator has written INSIDE Priority (the "AI סקילז"
screen, AIWORKFLOWS), for the current company.

A skill is a set of instructions for how to carry out a business task in this
installation -- which screens, which steps, which traps. When one matches the
user's task, fetch it with get_skill and FOLLOW IT: it was written by someone who
knows this installation, and it outranks anything inferred from screen titles.
The operator's glossary (search_screens) is a different, complementary source.

'available: false' carries a 'reason'. On many installations the screen is not
yet opened for the API; that is not "there are no skills" -- say what the reason
says.`,
      inputSchema: {},
    },
    handler("list_skills", async () => listSkills(ctx.client)),
  );
  registered.push("list_skills");

  server.registerTool(
    "get_skill",
    {
      title: "Read one Priority AI skill in full",
      annotations: READ_ONLY_HINTS,
      description: `Fetch the full text of one skill from list_skills, by its 'key'.

Pass the 'key' object exactly as list_skills returned it. The text is the
administrator's instructions for the task; follow them ahead of your own
inference about which screens to use.`,
      inputSchema: {
        key: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .describe("The 'key' object of a skill from list_skills, verbatim."),
      },
    },
    handler("get_skill", async (args: { key: Record<string, string | number> }) => fetchSkill(ctx.client, args.key)),
  );
  registered.push("get_skill");
  }

  server.registerTool(
    "list_programs",
    {
      title: "List runnable Priority programs",
      annotations: { ...READ_ONLY_HINTS, openWorldHint: false },
      description: `The programs and reports the operator has DOCUMENTED, with their notes.

'type' is 'R' for a report (renders output) or 'P' for a procedure (can change
data). Read 'notes' before running anything -- they record what the titles do not.

Whether this catalog is also the LIMIT of what may be run depends on the server:
read 'scope' in the reply. When it is not the limit, every procedure and report in
Priority can be run, and these are simply the ones with guidance attached; find
the others with search_screens{kinds:['P','R']} and read help{name,type} before
running them.`,
      inputSchema: {},
    },
    handler("list_programs", async () => {
      const err = ctx.programs.configError;
      if (err) return { available: false, reason: err };
      const catalog = ctx.programs.readCatalog();
      // Deliberately NOT awaiting the dictionary: this tool reads a local file
      // and must keep answering when Priority is unreachable. The count is a
      // nicety, so it is taken only if the dictionary happens to be loaded.
      const loaded = ctx.dict.stats().programs;
      const total = loaded > 0 ? String(loaded) : "all";
      return {
        available: true,
        count: catalog.length,
        programs: catalog,
        scope:
          programPolicy === "all"
            ? `ANY of the ${total} procedures and reports in this Priority may be run. ` +
              `These ${catalog.length} are the documented ones; the rest carry no notes, ` +
              `so read help{name,type} first and ask the user before running a procedure.` +
              (programDeny.size ? ` Blocked outright: ${[...programDeny].join(", ")}.` : "")
            : `ONLY these ${catalog.length} may be run. Priority cannot enumerate runnable ` +
              `programs over the API, so this list is both the permission and the only way ` +
              `to learn a program exists. A name outside it is refused; report that rather ` +
              `than trying another name.`,
        note:
          "This list is maintained by the operator, not discovered from Priority." +
          (readOnly
            ? " RUNNING IS DISABLED on this server (read-only mode): these can be " +
              "described but not executed."
            : ""),
      };
    }),
  );
  registered.push("list_programs");

  /**
   * Resolve a requested program name, loading the dictionary first.
   *
   * The dictionary is what makes the 'all' policy safe to offer at all: it holds
   * every procedure and report EXEC lists, so a typo is caught here instead of
   * becoming a round trip that answers "No such Tabula Entity" with no hint of
   * what was meant.
   */
  const pickProgram = async (name: string, type?: "P" | "R") => {
    await ctx.dict.ready();
    return resolveProgram(name, {
      policy: programPolicy,
      deny: programDeny,
      catalog: ctx.programs.readCatalog(),
      dict: ctx.dict,
      ...(type ? { type } : {}),
    });
  };

  /**
   * Turn a parameter's `TABLE.COLUMN` lookup into a screen the read tools can
   * actually query.
   *
   * Priority names the lookup by TABLE, and a table is not always an entity set:
   * measured, `GENLEDGERS` reads directly while `FAMILY` answers 404 and its rows
   * live behind the `FAMILY_LOG` screen. Resolving that here is the difference
   * between a model that can offer the user the real fiscal years and one that
   * has to guess a value into a mandatory field.
   */
  const resolveLookup = (lookup: string): Record<string, unknown> => {
    const [table = "", column = ""] = lookup.split(".");
    const direct = ctx.dict.get(table);
    const screen =
      direct && direct.access === "direct"
        ? direct
        : ctx.dict.allEntries().find((e) => e.kind === "F" && e.table === table && e.access === "direct");
    if (!screen) {
      return {
        lookup,
        lookupNote:
          `Values come from the ${table} table, but no screen over it is readable here, ` +
          `so the value cannot be listed. Ask the user for it.`,
      };
    }
    return {
      lookup,
      lookupScreen: screen.screen,
      lookupColumn: column,
      lookupNote:
        `List the legal values with query{entity:'${screen.screen}', select:'${column}'} ` +
        `and let the USER pick one. Do not invent a value for this field.`,
    };
  };

  /** Attach the resolved lookups, so a needs_input reply is self-sufficient. */
  const enrichFields = <T extends { inputFields?: { lookup?: string }[] }>(reply: T): T => {
    for (const f of reply.inputFields ?? []) {
      if (f.lookup) Object.assign(f, resolveLookup(f.lookup));
    }
    return reply;
  };

  /**
   * Say plainly when a program finished having produced nothing.
   *
   * Priority reports an empty report as a message of type 'error', which this
   * server turned into status:'error' -- so a model relayed "the report failed"
   * for a report that ran perfectly and simply had no rows. Measured on
   * BUDREPDET, whose data is prepared by a separate refresh procedure.
   */
  const explainEmpty = (reply: {
    status: string;
    output?: string;
    messages: string[];
    twin?: { name: string; type: string; title: string | null };
  }): Record<string, unknown> => {
    if (reply.output && reply.output.length > 0) return {};
    if (!reply.messages.length) return {};
    const twin = reply.twin;
    // Priority says "no rows" with a message of type 'error', which this server
    // turned into status:'error' -- and a model relayed "the report failed" for a
    // report that ran perfectly and simply had nothing to show. The status is
    // corrected to 'no_data' when the messages say that and only that, so a real
    // failure still reads as one.
    const said = reply.messages.join(" ").toLowerCase();
    const emptyPhrases = ["no values in report", "no data", "אין נתונים", "לא נמצאו נתונים"];
    const looksEmpty = emptyPhrases.some((phrase) => said.includes(phrase));
    return {
      producedNoOutput: true,
      ...(looksEmpty && reply.status === "error"
        ? {
            status: "no_data",
            originalStatus: "error",
            statusNote:
              "Priority reports an empty result as a message of type 'error'; this ran to " +
              "completion with nothing to show, so the status is corrected to 'no_data'. " +
              "The unchanged Priority messages are in 'messages'.",
          }
        : {}),
      note:
        `The program ran and produced no output. Priority's own words are in 'messages' -- ` +
        `relay them; a message like "No values in report" means the run succeeded and there ` +
        `was nothing to show, which is an answer, not a failure.` +
        (twin
          ? ` Note that '${twin.name}' also exists as ${twin.type === "P" ? "a procedure" : "a report"}` +
            ` (${twin.title ?? "untitled"}). In Priority a report is often only a view of data that ` +
            `its procedure twin, or a REFRESH<name> procedure, prepares -- check with help{} before ` +
            `concluding there is no data.`
          : ""),
    };
  };

  if (readOnly) {
    log("run_program is NOT registered (PRIORITY_READ_ONLY) — this server cannot change Priority data");
  } else {
    server.registerTool(
      "run_program",
      {
        title: "Run a Priority program or report",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        description: `Run a Priority procedure (P) or report (R), optionally with parameters.

${programScope}

Call it once WITHOUT inputs first. The reply does not run anything and carries
everything Priority knows about the dialog it would show a person:
  dialog.text     what the program DOES, in Priority's own words
  inputFields[]   each parameter with its title, its 'help' in prose, its type
                  and 'format' (a date says DD/MM/YY), 'maxLength', whether it is
                  'mandatory', and 'defaultValue' -- the value Priority already
                  has from the previous run
  inputFields[].lookup  where legal values come from. 'lookupScreen' is the
                  screen to read them with, already resolved -- a lookup names a
                  TABLE and a table is not always queryable. LIST THEM AND LET
                  THE USER CHOOSE rather than inventing a value
  operators[]     the comparisons a parameter may use

SHOW THAT TO THE USER before running a procedure: the titles and help are what a
Priority user sees, and 'defaultValue' is what will be used if you say nothing.
Then supply 'inputs' on the second call.

That two-step shape is not ceremony. Supplying parameters is what makes a
procedure act, so guessing them is how you run something you did not intend.

A parameter you do not mention KEEPS its defaultValue -- it is not blanked.

Status values: 'needs_input' (parameters listed, nothing ran), 'would_run',
'completed', 'no_data', 'message' (Priority said something -- read 'messages'),
'not_found' (no such program), 'unmatched_inputs', 'needs_choice', 'error'.

'no_data' means the program RAN and there was nothing to show. Priority reports
that as a message of type 'error', so the status is corrected here; say the
report is empty, not that it failed. 'producedNoOutput' is set, 'originalStatus'
records what Priority said, and a 'twin' -- the same name of the other kind --
is worth checking, since a report is often only a view of what its procedure
twin prepares.

'would_run' means the PROCEDURE takes no parameters at all, so there was nothing
to report and nothing was run -- it would have started acting immediately. Say
what it does and get the user's agreement, then call again with inputs:{} to run
it deliberately. Reports (R) do not stop this way; rendering output is harmless.

'needs_choice' means the program asked to choose between options and this tool
will not choose for you -- 'options' lists them and nothing ran. Use
start_program + continue_program, where the user makes that choice.

'unmatched_inputs' means one of your input keys matched no parameter and the
program was NOT run -- 'unmatchedInputs' lists them. Fix the key to the exact
'title', 'code' or 'field' from inputFields; do not retry with the same key.`,
        inputSchema: {
          name: z.string().describe("Program name. Case-insensitive, unlike screen names."),
          type: z
            .enum(["P", "R"])
            .optional()
            .describe(
              "P procedure or R report. Needed only when one name is both — FORMMSG is — " +
                "in which case the call is refused until you say which.",
            ),
          inputs: z
            .record(z.string(), INPUT_VALUE)
            .optional()
            .describe(
              "Parameter values keyed by the exact 'title', 'code' or 'field' number " +
                "from the first call's inputFields — any of the three works. A plain " +
                "string means 'equals'; {value, operator, value2} uses an operator from " +
                "the step's 'operators' list, which is the only way to express a range. " +
                "Omit this argument entirely to discover the parameters without running. " +
                "A key matching no parameter refuses the whole run rather than silently " +
                "using defaults.",
            ),
        },
      },
      handler(
        "run_program",
        async (args: { name: string; type?: "P" | "R"; inputs?: Record<string, InputValue> }) => {
          const err = ctx.programs.configError;
          if (err) return { available: false, reason: err };

          const chosen = await pickProgram(args.name, args.type);
          if ("refused" in chosen) return chosen;

          const result = enrichFields(
            args.inputs
              ? await ctx.programs.run(chosen.name, chosen.type, args.inputs)
              : await ctx.programs.probe(chosen.name, chosen.type),
          );
          const reply = {
            ...result,
            program: chosen.name,
            title: chosen.title,
            permittedBy: chosen.source,
            ...(chosen.twin ? { twin: chosen.twin } : {}),
            ...(chosen.catalogEntry ? { catalogEntry: chosen.catalogEntry } : {}),
            ...(chosen.caution ? { caution: chosen.caution } : {}),
          };
          return { ...reply, ...explainEmpty(reply) };
        },
      ),
    );
    registered.push("run_program");

    const PROGRAM_HINTS = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    } as const;

    server.registerTool(
      "start_program",
      {
        title: "Start a Priority program as an interactive session",
        annotations: PROGRAM_HINTS,
        description: `Start a procedure (P) or report (R) and stop at the first step that needs a decision.

${programScope}

Unlike run_program, nothing is decided here. The reply's 'step' says what Priority
is waiting for and 'step.next' says exactly which continue_program action answers
it:
  input      parameters wanted        -> continue{input: {...}}
             'fields' carries each parameter's help, type, format, maxLength,
             defaultValue and lookup; 'dialog.text' says what the program does;
             'operators' lists the comparisons available. Relay those to the
             user rather than paraphrasing -- they are Priority's own words.
  choose     a choice between options -> ask the USER, then continue{choose: index}
  message    Priority said something  -> relay it; continue{acknowledge: true} or {cancel: true}
  askprint   output is ready          -> continue{output: {}} for Priority's default,
             or {format:<id>} from the step's own 'formats' list (ids and titles
             come from Priority, so show the titles to the user). When
             'step.document' is true add as:'pdf'|'word'|'html' and
             signature:true; only 'html' returns readable text here
  displayurl still working            -> continue{poll: true}
  end        finished; 'output' holds the report text, 'urls' any file links

Choices and messages are the user's to make. A session left alone is cancelled
after 5 minutes. Use run_program instead for a report whose parameters you
already know and that asks no questions.`,
        inputSchema: {
          name: z.string().describe("Program name. Case-insensitive, unlike screen names."),
          type: z
            .enum(["P", "R"])
            .optional()
            .describe("P procedure or R report. Needed only when one name is both."),
        },
      },
      handler("start_program", async (args: { name: string; type?: "P" | "R" }) => {
        const err = ctx.programs.configError;
        if (err) return { available: false, reason: err };
        const chosen = await pickProgram(args.name, args.type);
        if ("refused" in chosen) return chosen;
        const started = await ctx.programs.start(chosen.name, chosen.type);
        enrichFields({ inputFields: started.step.fields });
        return {
          ...started,
          title: chosen.title,
          permittedBy: chosen.source,
          ...(chosen.twin ? { twin: chosen.twin } : {}),
          ...(chosen.catalogEntry ? { catalogEntry: chosen.catalogEntry } : {}),
          ...(chosen.caution ? { caution: chosen.caution } : {}),
        };
      }),
    );
    registered.push("start_program");

    server.registerTool(
      "continue_program",
      {
        title: "Answer the current step of a program session",
        annotations: PROGRAM_HINTS,
        description: `Send ONE action to a session opened by start_program and get the next step.

Exactly one of: input, choose, acknowledge, output, poll, cancel. The right one is
named in the previous reply's 'step.next'; sending a different one is refused
without touching the program. 'choose' takes the 1-based 'index' from
'step.options'. 'input' takes values keyed by a field's title, code or number.

'done: true' means the session is over; its id is no longer valid.`,
        inputSchema: {
          session: z.string().describe("The 'session' id from start_program."),
          action: z
            .object({
              input: z.record(z.string(), INPUT_VALUE).optional(),
              choose: z.number().int().positive().optional(),
              acknowledge: z.literal(true).optional(),
              output: z
                .object({
                  format: z
                    .number()
                    .int()
                    .optional()
                    .describe("A format id from the step's 'formats'. Omit for Priority's default."),
                  as: z
                    .enum(["pdf", "word", "html"])
                    .optional()
                    .describe(
                      "DOCUMENT steps only (step.document is true): the container. Only 'html' " +
                        "comes back as readable text; pdf and word arrive as a file.",
                    ),
                  signature: z
                    .boolean()
                    .optional()
                    .describe("DOCUMENT steps only: add the user's signature. PDF and Word only."),
                })
                .optional(),
              poll: z.literal(true).optional(),
              cancel: z.literal(true).optional(),
            })
            .describe("Exactly one key."),
        },
      },
      handler("continue_program", async (args: { session: string; action: SessionAction }) => {
        const err = ctx.programs.configError;
        if (err) return { available: false, reason: err };
        const reply = await ctx.programs.continue(args.session, args.action);
        enrichFields({ inputFields: reply.step.fields });
        return reply;
      }),
    );
    registered.push("continue_program");
  }

  // get_sales is off by default while the discovery tools are being evaluated.
  // Leaving it registered would let the model reach for the curated shortcut and
  // never exercise search_screens/describe_screen/query, which is precisely what
  // needs testing. Set PRIORITY_ENABLE_GET_SALES=1 in .env to bring it back --
  // the code is untouched, only the registration is gated.
  if (envFlag("PRIORITY_ENABLE_GET_SALES")) {
    server.registerTool(
      "get_sales",
      {
        title: "Priority sales documents",
        annotations: READ_ONLY_HINTS,
        description: SALES_DESCRIPTION,
        inputSchema: salesInputShape,
      },
      handler("get_sales", (args) => getSales(ctx.client, salesInputSchema.parse(args))),
    );
    registered.push("get_sales");
  } else {
    log("get_sales is hidden (set PRIORITY_ENABLE_GET_SALES=1 to expose it)");
  }

  // Name what IS registered rather than what is not. "Which tools does this
  // client actually see" is the first thing anyone asks of a log, and counting
  // absences is a poor way to answer it.
  log(
    `tools ready (${registered.length}): ${registered.join(", ")}` +
      `${readOnly ? "  [READ-ONLY]" : ""}`,
  );
  log(`serving ${ctx.client.baseUrl}${opts.identity ? ` as ${opts.identity}` : ""}`);
  return server;
}

/** stdio entry point. The HTTP one lives in http.ts. */
async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  log("connected over stdio");
}

// Only claim stdio when this file is the process entry point. Without the guard,
// http.ts importing buildServer() would also start a stdio server and both would
// fight over the same streams.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
