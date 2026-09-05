import { z } from "zod";
import {
  PriorityODataClient,
  ScreenNotEnabledForApi,
  type ColumnMetadata,
  type EntityMetadata,
} from "./odata.js";
import type { PriorityDictionary, ScreenEntry } from "./dictionary.js";
import { fetchColumnHelp, fetchEntityHelp, fetchEntityHelpOutcome, type HelpOutcome, type HelpReference } from "./help.js";
import type { Examples, Glossary } from "./glossary.js";
import { CallerError } from "./errors.js";
import { loadResultLimits, uncapped } from "./config.js";

// The generic discovery + query layer: find a screen, learn what its columns
// mean, then read it. Replaces the need to hardcode a per-domain method, which
// is what previously let a wrong assumption about one screen (CINVOICES) sit in
// the code unchallenged.

/**
 * The configured ceilings. Read once at module load, because `rowsPerQuery`
 * becomes a zod `.max()` on the tool's input schema and clients cache that.
 */
export const LIMITS = loadResultLimits();

/**
 * Character ceiling on a tool response, independent of the row ceiling.
 *
 * Both are needed and neither implies the other: 500 narrow rows is a small
 * payload, while 500 rows of a 200-column screen is enough to crowd out the rest
 * of a conversation. PRIORITY_MAX_RESPONSE_CHARS=0 removes it.
 */
export const MAX_RESPONSE_CHARS = uncapped(LIMITS.responseChars);

/** Hard ceiling on columns described in one call, to keep a reply readable. */
const MAX_COLUMNS_SHOWN = 150;

/** Raised when a raw `path` would leave the configured company. */
export class UnsafePathError extends CallerError {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Validate a raw OData `path` before it is appended to the company URL.
 *
 * A third-party test walked out of the configured company with
 * `../../tabula.ini,1/demo/CUSTOMERS` and read another tenant's customer rows.
 * Re-measured here: the plain form, the `%2F`-encoded form AND a backslash form
 * all reached the neighbouring company.
 *
 * That last one is the reason this is an ALLOWLIST rather than a filter for `..`
 * and friends. A blacklist has to anticipate every spelling of "go up" across two
 * decoders -- ours and Priority's -- and the backslash variant was already a
 * spelling nobody had thought of. What a legitimate path can look like is a much
 * smaller, closed set: a known entity, optional key parentheses, then navigation
 * segments. Everything else is refused, including `$metadata` and `$count`, which
 * are not reads of a screen.
 */
export function assertSafePath(raw: string, dict: PriorityDictionary): void {
  const [pathPart = "", ...rest] = raw.split("?");
  const query = rest.join("?");

  // Decode until stable so a %252F cannot survive one decode pass and be
  // unwrapped by the next layer. Ours is not the only decoder in the chain.
  let decoded = pathPart;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new UnsafePathError(`path is not valid URL encoding: ${pathPart}`);
    }
    if (next === decoded) break;
    decoded = next;
  }

  if (decoded !== pathPart) {
    throw new UnsafePathError(
      `path must not be percent-encoded at the segment level (decoded to '${decoded}'). ` +
        `Write the entity and navigation names literally; encode only values inside key parentheses.`,
    );
  }

  // Shape: ENTITY[(key)][/NAV[(key)]]... Key contents are deliberately permissive
  // -- they carry Hebrew, quotes, commas and dots -- but they cannot contain a
  // slash, which is what keeps them from opening a new segment.
  const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*(\([^/]*\))?$/;
  const segments = decoded.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new UnsafePathError('path is empty. Give an entity, e.g. "CUSTOMERS?$top=10".');
  }
  if (decoded.startsWith("/")) {
    throw new UnsafePathError("path must be relative to the company, so it cannot start with '/'.");
  }
  for (const seg of segments) {
    if (!SEGMENT.test(seg)) {
      throw new UnsafePathError(
        `path segment '${seg}' is not a plain entity or navigation name. ` +
          `Traversal ('..'), backslashes, absolute URLs and service paths like ` +
          `$metadata or $count are refused: this tool reads screens inside one ` +
          `company only.`,
      );
    }
  }

  // The first segment must be a screen this server actually knows. This is what
  // makes the rule an allowlist instead of a shape check.
  const entity = segments[0]!.replace(/\(.*$/, "");
  if (!dict.get(entity)) {
    throw new UnsafePathError(
      `'${entity}' is not a known screen, so this path will not be sent. ` +
        `Screen names are CASE-SENSITIVE — use search_screens to find the exact name.`,
    );
  }

  if (query.includes("://")) {
    throw new UnsafePathError("path query string must not contain an absolute URL.");
  }
}

function describeColumn(c: ColumnMetadata) {
  return {
    name: c.name,
    title: c.title,
    type: c.type,
    ...(c.maxLength === null ? {} : { maxLength: c.maxLength }),
    ...(c.isKey ? { isKey: true } : {}),
    ...(c.mandatory ? { mandatory: true } : {}),
    ...(c.dateType ? { dateType: c.dateType } : {}),
    ...(c.autoUnique ? { autoUnique: true } : {}),
    ...(c.readOnly ? { readOnly: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// search_screens
// ---------------------------------------------------------------------------

export const searchScreensShape = {
  query: z
    .string()
    .describe(
      "What to look for, in Hebrew or English. Matches the screen's Hebrew title, " +
        "its internal name, its module and its table — e.g. 'מלאי', 'זיכוי', " +
        "'INVOICES'. Leave empty to list screens.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum screens to return. Default 25."),
  includeUnavailable: z
    .boolean()
    .optional()
    .describe(
      "Also return screens that are neither readable directly nor reachable " +
        "through a parent. Default false. Sub-forms are ALREADY included by " +
        "default — this flag only adds screens that genuinely cannot be read, " +
        "which is useful to confirm a screen exists at all.",
    ),
  kinds: z
    .array(z.enum(["F", "P", "R"]))
    .optional()
    .describe(
      "What to search: F screens (the default, and the only kind unless you say " +
        "otherwise), P procedures, R reports. Pass ['P','R'] to find a program by " +
        "its Hebrew title, or ['F','P','R'] for everything. Programs are described " +
        "with help{name, type} and carry 'runnable' saying whether this server " +
        "will run them.",
    ),
};

export async function searchScreens(
  dict: PriorityDictionary,
  input: {
    query: string;
    limit?: number;
    includeUnavailable?: boolean;
    includeUnpublished?: boolean;
    kinds?: ("F" | "P" | "R")[];
  },
  glossary?: Glossary,
  examples?: Examples,
  /**
   * Which programs this server will run, and why.
   *
   * `catalogued` is the operator's list; `policy` says whether that list is the
   * LIMIT. Passing only the list was wrong once the policy could be opened: with
   * PRIORITY_ALLOW_ALL_PROGRAMS every program is runnable, yet every result said
   * `runnable: false` because it was not catalogued -- so a model could read
   * "cannot be run" about a program run_program would happily run.
   */
  programs: { catalogued: Set<string>; policy: "catalog" | "all" } = {
    catalogued: new Set(),
    policy: "catalog",
  },
): Promise<unknown> {
  await dict.ready();
  // includeUnpublished is the former name of this flag. Still honoured so a
  // client that learned the old schema does not silently get filtered results.
  const wantAll = input.includeUnavailable === true || input.includeUnpublished === true;
  const result = dict.search(input.query, {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.kinds?.length ? { kinds: input.kinds } : {}),
    onlyReadable: !wantAll,
  });

  const notes: string[] = [];

  // Programs carry one more fact than screens: whether this server may run them.
  // Priority has no way to enumerate runnable programs, so the catalog is the
  // operator's decision, and a program outside it can be read about but not run.
  const openPolicy = programs.policy === "all";
  const matches = result.matches.map((m) => {
    if (m.kind === "F") return m;
    const catalogued = programs.catalogued.has(m.screen.toUpperCase());
    return {
      ...m,
      // Runnable means "this server will run it", not "it is documented".
      runnable: catalogued || openPolicy,
      ...(catalogued
        ? { documented: true as const }
        : openPolicy
          ? {
              documented: false as const,
              catalogNote:
                "Runnable, but not in programs.json — nothing is recorded here about what " +
                "it does. Read help{name, type} first, and for a procedure ask the user.",
            }
          : {
              documented: false as const,
              catalogNote: "Not in programs.json, so this server will not run it.",
            }),
    };
  });
  const programsShown = matches.filter((m) => m.kind !== "F").length;
  if (programsShown) {
    notes.push(
      `${programsShown} of these are programs (kind P = procedure, R = report), not screens. ` +
        `They cannot be queried. Read what one does with help{name, type}. ` +
        (openPolicy
          ? `This server runs ANY procedure or report, so 'runnable' is true throughout; ` +
            `'documented: false' means the operator recorded no notes for it, which makes ` +
            `reading help and asking the user before a procedure your responsibility. `
          : `'runnable: true' means run_program accepts it; false means the operator must ` +
            `add it to programs.json first -- say so rather than trying another name. `) +
        `A name can exist as several kinds; pass the kind letter you mean.`,
    );
  }

  // Glossary hits are returned ALONGSIDE the ranked matches rather than merged
  // into them, and deliberately so: a curated mapping is a different kind of
  // claim from a title match. Merging would hide which screens were chosen by a
  // person and which by string similarity, and the model should weight those
  // differently.
  const termHits = (glossary?.match(input.query) ?? []).slice(0, 4);
  const glossaryOut = termHits.map((t) => ({
    term: t.term,
    matched: t.matched,
    screens: (t.screens ?? []).map((s) => {
      const e = dict.get(s);
      return {
        screen: s,
        title: e?.title ?? null,
        access: e?.access ?? "unknown",
        ...(e?.parents ? { parents: e.parents } : {}),
        ...(e ? {} : { warning: "not found in the dictionary — the glossary may be stale" }),
      };
    }),
    ...(t.columns ? { columns: t.columns } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
  }));

  if (glossaryOut.length) {
    notes.push(
      `'glossary' holds curated business-term mappings maintained by the operator. ` +
        `PREFER THEM over 'screens' below: they were chosen by a person who knows ` +
        `what the term means, while 'screens' is title similarity. Read each ` +
        `glossary entry's 'notes' before using its screens — they record traps ` +
        `that the titles do not show.`,
    );
  }

  if (result.totalMatches > result.shown) {
    notes.push(
      `Showing ${result.shown} of ${result.totalMatches} matches. Narrow the query ` +
        `or raise limit — do not assume these are all of them.`,
    );
  }

  // 'access' exists because 'published' alone made a sub-form look identical to a
  // closed screen, and those need opposite responses.
  notes.push(
    "Read 'access' on each result, not 'published'. access='direct': read it with " +
      "query{entity}. access='via-parent': it is a SUB-FORM and is not listed as an " +
      "entity set, so read it through a screen in its 'parents' list — " +
      "query{entity:PARENT, expand:'CHILD_SUBFORM'} or " +
      "query{path:\"PARENT(key='...')/CHILD_SUBFORM\"}; describe_screen on the child " +
      "works too and names the parent. That route ALWAYS works. Reading a " +
      "'via-parent' screen directly as an entity sometimes works as well on this " +
      "installation, so it is worth one attempt before concluding anything — the " +
      "service document under-reports here. access='unavailable': not reachable by " +
      "any route we know of.",
  );
  // Observed on the live server: PARTBAL and several other balance screens are
  // published yet still refuse to be read. Promising more than that would send a
  // caller down a dead end believing the name was wrong.
  notes.push(
    "access='direct' is necessary but not sufficient: such a screen can still be " +
      "switched off for the API and answer 'לא ניתן להפעיל API למסך זה' when read " +
      "(PARTBAL does). Only an actual read settles it.",
  );

  const children = result.matches.filter((m) => m.access === "via-parent");
  if (children.length) {
    notes.push(
      `${children.length} of these are sub-forms: ` +
        children
          .slice(0, 8)
          .map((c) => `${c.screen} (via ${(c.parents ?? []).slice(0, 3).join(" / ")})`)
          .join(", "),
    );
  }

  const worked = examples?.match(input.query) ?? [];
  if (worked.length) {
    notes.push(
      "'examples' are worked answers to similar questions, kept because they took " +
        "more than one attempt to get right. Follow the SHAPE — which tool, which " +
        "trap — not the literal values.",
    );
  }

  return {
    query: input.query,
    ...(glossaryOut.length ? { glossary: glossaryOut } : {}),
    ...(worked.length ? { examples: worked } : {}),
    totalMatches: result.totalMatches,
    shown: result.shown,
    notes,
    screens: matches,
    dictionary: dict.stats(),
  };
}

// ---------------------------------------------------------------------------
// describe_screen
// ---------------------------------------------------------------------------

export const describeScreenShape = {
  screen: z
    .string()
    .describe(
      "Internal screen name, e.g. AINVOICES. CASE-SENSITIVE — some screens differ " +
        "only by letter case. Get it from search_screens.",
    ),
  subform: z
    .string()
    .optional()
    .describe(
      "Describe one of the screen's sub-forms instead of the screen itself, e.g. " +
        "AINVOICEITEMS_SUBFORM. Sub-forms hold the line items and are not screens " +
        "of their own.",
    ),
  columns: z
    .string()
    .optional()
    .describe(
      "Only return columns whose name or Hebrew title contains this text. Use it " +
        "on wide screens instead of reading every column.",
    ),
  depth: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe(
      "Walk the screen's sub-forms recursively to this depth. 0 (default) is the " +
        "screen alone. 1 adds its sub-forms with their columns, 2 adds theirs, and " +
        "so on. Use it to understand a whole document structure — header plus " +
        "lines plus the lines' own sub-forms — in one call. The reply is capped; " +
        "read 'budget' to see whether anything was left out.",
    ),
  includeHelp: z
    .boolean()
    .optional()
    .describe(
      "Include Priority's own help text for the screen, in Hebrew, with its " +
        "{ENTITY.TYPE} cross-references resolved to names and titles. Default true. " +
        "This is the screen's actual documentation — what it is for and how it " +
        "relates to other screens — and is usually the fastest way to understand " +
        "one. In a deep walk it is fetched for child screens too, up to a cap.",
    ),
  includeColumnSources: z
    .boolean()
    .optional()
    .describe(
      "Per-column form definitions from Priority's own FCLMN table: position on " +
        "the form, the form-specific label, and — most usefully — the table and " +
        "column each value is READ FROM, which is how you know what joins to what. " +
        "Default true; set false to skip the extra request. Root screen only.",
    ),
  includeColumnHelp: z
    .boolean()
    .optional()
    .describe(
      "Also fetch each shown column's own Priority help text. One request per " +
        "column, so it is off by default and capped -- combine with 'columns' to " +
        "target the ones you need. Column help is permitted separately from screen " +
        "help on some installations, so it can be present when 'help' is refused.",
    ),
};

/**
 * Ceilings for a recursive describe.
 *
 * A document tree grows fast: AINVOICES alone has 200 columns and 16 navigation
 * properties, and screens like DOCTODOLIST hang off nearly everything. Without a
 * budget, depth 2 would return a reply larger than the conversation it is meant to
 * inform, and the caller would have no idea what it was missing.
 */
const MAX_TREE_SCREENS = 40;
const MAX_TREE_COLUMNS = 500;
const MAX_CHILD_COLUMNS = 60;
/** Extra GetMetadataFor calls a deep walk may make beyond the first document. */
const MAX_TREE_FETCHES = 12;
/** Help is one keyed request per screen, so a wide tree needs a ceiling too. */
const MAX_HELP_FETCHES = 25;
/** Column help is one keyed request per COLUMN; a 200-column screen needs a ceiling. */
const MAX_COLUMN_HELP = 40;
const COLUMN_HELP_CONCURRENCY = 4;

export async function describeScreen(
  client: PriorityODataClient,
  dict: PriorityDictionary,
  input: {
    screen: string;
    subform?: string;
    columns?: string;
    depth?: number;
    includeHelp?: boolean;
    includeColumnSources?: boolean;
    includeColumnHelp?: boolean;
  },
): Promise<unknown> {
  await dict.ready();
  const entry = dict.get(input.screen);

  if (entry && !entry.published) {
    // "Not published" has two very different causes, and an earlier version
    // reported both as "not exposed to the API" -- which is wrong advice for the
    // common one. A sub-form is never an entity set BY DESIGN; it is reached
    // through its parent, and its columns are usually described inside the
    // parent's metadata document. So look for the parent before declaring it
    // unreachable.
    return describeAsSubform(client, dict, entry, input);
  }

  let meta: Map<string, EntityMetadata>;
  try {
    meta = await client.metadataFor(input.screen);
  } catch (err) {
    if (err instanceof ScreenNotEnabledForApi) {
      return { screen: input.screen, published: false, error: err.message };
    }
    throw err;
  }

  const parent = meta.get(input.screen);
  if (!parent) {
    return {
      screen: input.screen,
      error:
        `GetMetadataFor returned no definition for ${input.screen}. Check the ` +
        `spelling and letter case against search_screens.`,
    };
  }

  // A sub-form is described by resolving the navigation property to its target
  // type, which usually arrives in the same metadata document as the parent.
  let target = parent;
  if (input.subform) {
    const nav = parent.navs.get(input.subform);
    if (!nav) {
      return {
        screen: input.screen,
        error: `${input.screen} has no sub-form named ${input.subform}.`,
        availableSubforms: [...parent.navs.values()].map((n) => ({
          name: n.name,
          target: n.target,
          title: n.title,
        })),
      };
    }

    // The parent declares the nav but does not always include the target's TYPE.
    // One installation ships it, another does not, and the difference is not
    // visible from the nav itself — so ask for the child's own metadata before
    // giving up. Failing here reported "metadata was not returned alongside",
    // which is true and unhelpful when the child answers perfectly well on its
    // own.
    let resolved = meta.get(nav.target);
    if (!resolved) {
      try {
        const ownMeta = await client.metadataFor(nav.target);
        resolved = ownMeta.get(nav.target);
        // Keep it for the rest of this call, including a deep walk.
        for (const [k, v] of ownMeta) if (!meta.has(k)) meta.set(k, v);
      } catch {
        // Fall through to the error below, which now means both routes failed.
      }
    }
    if (!resolved) {
      return {
        screen: input.screen,
        subform: input.subform,
        error:
          `The structure of ${nav.target} could not be read: it is not in ` +
          `${input.screen}'s metadata document, and a direct request for it also ` +
          `failed. The sub-form itself is still readable — use ` +
          `query{entity:'${input.screen}', expand:'${input.subform}'} and inspect ` +
          `the rows.`,
      };
    }
    target = resolved;
  }

  if ((input.depth ?? 0) > 0 && input.subform) {
    // Silently ignoring one of two supplied arguments is how a caller ends up
    // believing it saw a subtree it never received.
    return {
      screen: input.screen,
      subform: input.subform,
      error:
        `'depth' and 'subform' cannot be combined: depth walks the tree from ` +
        `${input.screen}, while subform describes one child on its own. Call with ` +
        `depth alone to see ${input.subform} in context, or with subform alone for ` +
        `just its columns.`,
    };
  }

  // A deep walk replaces the flat reply entirely: returning both would repeat the
  // root screen's columns twice in the same payload.
  if ((input.depth ?? 0) > 0 && !input.subform) {
    return describeTree(client, dict, meta, target, {
      depth: input.depth ?? 0,
      ...(input.columns === undefined ? {} : { columns: input.columns }),
      help: input.includeHelp !== false,
      title: entry?.title ?? null,
      table: entry?.table ?? null,
      module: entry?.module ?? null,
    });
  }

  // The dictionary entry for the thing ACTUALLY being described.
  //
  // With `subform`, `entry` is the parent screen — that is what the caller named
  // — but the columns below come from the sub-form. Reporting the parent's
  // table, module and published state alongside the child's columns produced a
  // reply that was internally inconsistent: describing TRANSORDER_D through
  // DOCUMENTS_D said table=DOCUMENTS (the parent's) while describing the same
  // screen directly said TRANSORDER. A caller reading `table` to build a query
  // got the wrong one, and nothing about the reply looked suspect.
  const subject = input.subform ? (dict.get(target.name) ?? entry) : entry;

  const filter = input.columns ? input.columns.toLocaleLowerCase() : null;
  const all = [...target.columns.values()];
  const selected = filter
    ? all.filter(
        (c) =>
          c.name.toLocaleLowerCase().includes(filter) ||
          (c.title ?? "").toLocaleLowerCase().includes(filter),
      )
    : all;
  const shown = selected.slice(0, MAX_COLUMNS_SHOWN);

  // Help and column definitions follow the DESCRIBED entity too, for the same
  // reason as `subject` above. A sub-form has its own help and its own FCLMN
  // rows, and they say different things: DOCUMENTS_D's help describes the
  // delivery-note header, TRANSORDER_D's describes its lines. Returning the
  // parent's prose next to the child's columns is a quietly wrong answer.
  const described = input.subform ? target.name : input.screen;
  const [sources, help] = await Promise.all([
    input.includeColumnSources === false
      ? Promise.resolve(undefined)
      : columnSources(client, described),
    input.includeHelp === false
      ? Promise.resolve(undefined)
      : fetchEntityHelpOutcome(client, dict, described, "F"),
  ]);

  // Column help: opt-in, capped, and probed once first. A permission refusal
  // applies to every column alike, and forty identical 403s would say nothing
  // the first one did not -- while costing forty round trips.
  let columnHelp: Map<string, HelpOutcome> | undefined;
  let columnHelpNote: string | undefined;
  if (input.includeColumnHelp) {
    columnHelp = new Map();
    const wanted = shown.slice(0, MAX_COLUMN_HELP);
    const lead = wanted[0];
    const probe = lead ? await fetchColumnHelp(client, dict, described, lead.name) : undefined;
    if (lead && probe && !probe.available && probe.permission) {
      columnHelpNote = probe.reason;
    } else {
      if (lead && probe) columnHelp.set(lead.name, probe);
      for (let i = 1; i < wanted.length; i += COLUMN_HELP_CONCURRENCY) {
        const chunk = wanted.slice(i, i + COLUMN_HELP_CONCURRENCY);
        const results = await Promise.all(chunk.map((c) => fetchColumnHelp(client, dict, described, c.name)));
        chunk.forEach((c, n) => columnHelp!.set(c.name, results[n]!));
      }
      if (shown.length > wanted.length) {
        columnHelpNote =
          `Column help was fetched for the first ${wanted.length} of ${shown.length} columns ` +
          `shown. Narrow with 'columns' to reach the others.`;
      }
    }
  }

  return {
    screen: input.screen,
    ...(help === undefined
      ? {}
      : help.available
        ? { help: help.text, helpReferences: help.references.length ? help.references : undefined }
        : { help: null, helpNote: help.reason }),
    ...(input.subform ? { subform: input.subform, describing: target.name } : {}),
    title: target.title ?? subject?.title ?? null,
    // From the described entity, not from whatever screen the caller named.
    table: subject?.table ?? null,
    module: subject?.module ?? null,
    published: subject?.published ?? true,
    ...(subject?.access ? { access: subject.access } : {}),
    ...(subject?.parents ? { parents: subject.parents } : {}),
    keys: target.keys,
    keyNote:
      target.keys.length > 1
        ? `Composite key — a keyed path needs every part: ${target.keys.join(", ")}.`
        : undefined,
    columnCount: all.length,
    columnsShown: shown.length,
    ...(selected.length > shown.length
      ? {
          note: `Showing ${shown.length} of ${selected.length} matching columns. Use the columns filter to narrow.`,
        }
      : {}),
    columns: shown.map((c) => {
      const base = describeColumn(c);
      const src = sources?.get(c.name);
      const h = columnHelp?.get(c.name);
      return {
        ...base,
        ...(src ?? {}),
        ...(h ? (h.available ? { help: h.text } : { help: null }) : {}),
      };
    }),
    ...(columnHelpNote ? { columnHelpNote } : {}),
    ...(sources?.size
      ? {
          columnSourceNote:
            "From Priority's FCLMN form definition. 'readsFrom' is the underlying " +
            "table.column a value comes from (CUSTNAME -> CUSTOMERS.CUSTNAME), " +
            "which often explains a column the title alone does not; readsFrom:null " +
            "means the column is computed or display-only rather than stored. " +
            "'joinedVia' appears on the few columns with an explicit join, and " +
            "'formLabel'/'formPosition' are the label and ordering as laid out on " +
            "the screen. 'hidden' marks a column the form does not display; " +
            "'formReadOnly', 'width', 'decimals' and 'formType' are FCLMN's own " +
            "flags, passed through as Priority stores them. This is structural, not " +
            "prose: the screen's written documentation is in the 'help' field.",
        }
      : {}),
    ...(input.includeColumnSources !== false && !sources?.size
      ? {
          columnSourceNote:
            "No FCLMN definition rows were returned for this screen, so no column " +
            "sources are available. This is a gap in the data, not an error.",
        }
      : {}),
    subforms: [...target.navs.values()].map((n) => ({
      name: n.name,
      target: n.target,
      title: n.title,
    })),
    subformNote:
      target.navs.size > 0
        ? "Sub-forms are not entity sets. Read them with $expand on this screen, " +
          "or with a keyed path via the query tool's path argument."
        : undefined,
  };
}

/**
 * Per-column form definitions from FCLMN, keyed by column name.
 *
 * `readsFrom` is the useful part. A column like CUSTNAME joined from CUSTOMERS
 * explains itself once you can see the join; the Hebrew title alone does not.
 */
async function columnSources(
  client: PriorityODataClient,
  screen: string,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  try {
    const safe = screen.replace(/'/g, "''");
    const rows = await client.query("EFORM", {
      top: 1,
      filter: `ENAME eq '${safe}'`,
      expand: "FCLMN_SUBFORM($top=400)",
    });
    const defs = (rows[0]?.["FCLMN_SUBFORM"] ?? []) as Record<string, unknown>[];
    for (const d of defs) {
      const name = typeof d["NAME"] === "string" ? d["NAME"] : null;
      if (!name || out.has(name)) continue;
      const entry: Record<string, unknown> = {};
      if (d["TITLE"]) entry["formLabel"] = d["TITLE"];
      if (typeof d["POS"] === "number") entry["formPosition"] = d["POS"];

      // TNAME/CNAME is the underlying table and column -- CUSTNAME resolves to
      // CUSTOMERS.CUSTNAME. JTNAME/JCNAME is a different, much rarer thing (an
      // explicit join) and is null on all but a handful of columns, so reading
      // the source from it alone returned almost nothing.
      if (d["TNAME"] && d["CNAME"]) entry["readsFrom"] = `${String(d["TNAME"])}.${String(d["CNAME"])}`;
      if (d["JTNAME"] && d["JCNAME"]) entry["joinedVia"] = `${String(d["JTNAME"])}.${String(d["JCNAME"])}`;
      // The flags form_columns in Priority's own MCP reports (Hidden, Readonly,
      // Width, Decimal) are all here in FCLMN. Passed through as stored rather
      // than interpreted: READONLY has been seen as 'M' as well as 'Y', and a
      // guess at what 'M' means would be exactly the kind of assumption this
      // server exists to avoid.
      if (d["HIDEBOOL"] === "Y") entry["hidden"] = true;
      if (d["READONLY"]) entry["formReadOnly"] = d["READONLY"];
      if (typeof d["WIDTH"] === "number") entry["width"] = d["WIDTH"];
      if (typeof d["DEC"] === "number") entry["decimals"] = d["DEC"];
      if (d["TYPE"]) entry["formType"] = d["TYPE"];
      // No source at all means the value is computed or display-only rather than
      // stored, which is itself worth knowing about a column.
      if (!entry["readsFrom"] && !entry["joinedVia"] && (d["TITLE"] || d["COLTITLE"])) {
        entry["readsFrom"] = null;
      }
      if (Object.keys(entry).length) out.set(name, entry);
    }
  } catch {
    // Enrichment only. A screen with no FCLMN rows, or an EFORM that declines the
    // expand, must not fail the description the caller actually asked for.
  }
  return out;
}

interface TreeNode {
  screen: string;
  title: string | null;
  /** Navigation property to reach this node from its parent, for use in expand. */
  via?: string;
  keys: string[];
  columnCount: number;
  columns?: ReturnType<typeof describeColumn>[];
  columnsOmitted?: number;
  help?: string;
  helpReferences?: HelpReference[];
  children?: TreeNode[];
  childrenOmitted?: number;
  note?: string;
}

/**
 * Walk a screen and its sub-forms recursively.
 *
 * One GetMetadataFor document usually covers the whole first level: Priority
 * returns the requested entity *and its relatives*, which is normally wasteful
 * and here is exactly what is wanted. Deeper levels need extra documents, so
 * those are counted and capped rather than fetched freely.
 *
 * Cycles are real, not hypothetical: DOCTODOLIST, GENCUSTNOTES and similar hang
 * off nearly every screen and can point back, so a visited set is what keeps this
 * from recursing forever.
 */
async function describeTree(
  client: PriorityODataClient,
  dict: PriorityDictionary,
  doc: Map<string, EntityMetadata>,
  root: EntityMetadata,
  opts: {
    depth: number;
    columns?: string;
    help: boolean;
    title: string | null;
    table: string | null;
    module: string | null;
  },
): Promise<unknown> {
  const filter = opts.columns ? opts.columns.toLocaleLowerCase() : null;
  const matches = (c: ColumnMetadata) =>
    !filter ||
    c.name.toLocaleLowerCase().includes(filter) ||
    (c.title ?? "").toLocaleLowerCase().includes(filter);

  let screensUsed = 0;
  let columnsUsed = 0;
  let fetches = 0;
  let truncated = false;
  const visited = new Set<string>();

  /** Resolve an entity from the shared document, fetching only if affordable. */
  const resolve = async (name: string): Promise<EntityMetadata | undefined> => {
    const local = doc.get(name);
    if (local) return local;
    if (fetches >= MAX_TREE_FETCHES) {
      truncated = true;
      return undefined;
    }
    fetches++;
    try {
      const extra = await client.metadataFor(name);
      for (const [k, v] of extra) if (!doc.has(k)) doc.set(k, v);
      return doc.get(name);
    } catch {
      // A child whose metadata is closed is a fact about the screen, not an
      // error in the walk: record it as a node without columns.
      return undefined;
    }
  };

  const build = async (
    entity: EntityMetadata,
    level: number,
    via: string | undefined,
  ): Promise<TreeNode> => {
    visited.add(entity.name);
    screensUsed++;

    const all = [...entity.columns.values()];
    const selected = all.filter(matches);
    const perScreenCap = level === 0 ? MAX_COLUMNS_SHOWN : MAX_CHILD_COLUMNS;
    const room = Math.max(0, MAX_TREE_COLUMNS - columnsUsed);
    const take = Math.min(selected.length, perScreenCap, room);
    columnsUsed += take;
    if (take < selected.length) truncated = true;

    const node: TreeNode = {
      screen: entity.name,
      title: entity.title ?? (level === 0 ? opts.title : null),
      ...(via ? { via } : {}),
      keys: entity.keys,
      columnCount: all.length,
      columns: selected.slice(0, take).map(describeColumn),
      ...(take < selected.length ? { columnsOmitted: selected.length - take } : {}),
    };

    if (level >= opts.depth) {
      if (entity.navs.size > 0) {
        node.childrenOmitted = entity.navs.size;
        node.note = `${entity.navs.size} sub-form(s) not expanded — raise depth to see them.`;
      }
      return node;
    }

    const children: TreeNode[] = [];
    let skipped = 0;
    for (const nav of entity.navs.values()) {
      if (screensUsed >= MAX_TREE_SCREENS) {
        skipped++;
        truncated = true;
        continue;
      }
      // A screen already described elsewhere in the tree is referenced, not
      // repeated -- DOCTODOLIST alone would otherwise appear dozens of times.
      if (visited.has(nav.target)) {
        children.push({
          screen: nav.target,
          title: nav.title ?? null,
          via: nav.name,
          keys: [],
          columnCount: 0,
          note: "Already described elsewhere in this tree; not repeated.",
        });
        continue;
      }
      const child = await resolve(nav.target);
      if (!child) {
        children.push({
          screen: nav.target,
          title: nav.title ?? null,
          via: nav.name,
          keys: [],
          columnCount: 0,
          note: "Metadata not available for this sub-form.",
        });
        continue;
      }
      children.push(await build(child, level + 1, nav.name));
    }
    if (children.length) node.children = children;
    if (skipped) node.childrenOmitted = skipped;
    return node;
  };

  const tree = await build(root, 0, undefined);

  // Help is fetched after the tree is built, not during it: one keyed request per
  // screen, run concurrently and capped, rather than serialised inside the walk.
  let helpFetched = 0;
  let helpOmitted = 0;
  if (opts.help) {
    const nodes: TreeNode[] = [];
    const collect = (n: TreeNode) => {
      // Nodes without columns are placeholders (already-described, or metadata
      // closed) and have nothing to attach help to.
      if (n.columns) nodes.push(n);
      for (const c of n.children ?? []) collect(c);
    };
    collect(tree);
    const targets = nodes.slice(0, MAX_HELP_FETCHES);
    helpOmitted = nodes.length - targets.length;

    const results = await Promise.all(
      targets.map((n) => fetchEntityHelp(client, dict, n.screen, "F").catch(() => null)),
    );
    results.forEach((h, i) => {
      if (!h) return;
      helpFetched++;
      const node = targets[i]!;
      node.help = h.text;
      if (h.references.length) node.helpReferences = h.references;
    });
  }

  return {
    screen: root.name,
    title: opts.title ?? root.title ?? null,
    table: opts.table,
    module: opts.module,
    depth: opts.depth,
    tree,
    budget: {
      screensDescribed: screensUsed,
      columnsShown: columnsUsed,
      extraMetadataRequests: fetches,
      ...(opts.help ? { helpFetched, helpOmitted } : {}),
      truncated,
      limits: {
        screens: MAX_TREE_SCREENS,
        columns: MAX_TREE_COLUMNS,
        columnsPerChild: MAX_CHILD_COLUMNS,
      },
    },
    notes: [
      "'via' on each node is the navigation property that reaches it from its " +
        "parent — use it directly in query{expand} or in a keyed path.",
      truncated
        ? "TRUNCATED: some screens or columns were left out to keep the reply " +
          "readable. Narrow with the columns filter, or describe a specific " +
          "sub-form on its own, rather than assuming this is everything."
        : "Complete within the requested depth.",
    ],
  };
}

/**
 * Describe an unpublished screen by finding the parent that owns it.
 *
 * Bounded on purpose: each candidate costs a GetMetadataFor round trip, so this
 * probes a short module-scoped shortlist rather than searching exhaustively. A
 * miss returns honest uncertainty instead of a false "does not exist".
 */
async function describeAsSubform(
  client: PriorityODataClient,
  dict: PriorityDictionary,
  entry: ScreenEntry,
  input: { screen: string; columns?: string; includeHelp?: boolean; includeColumnSources?: boolean },
): Promise<unknown> {
  const navName = `${input.screen}_SUBFORM`;
  const candidates = dict.candidateParents(entry);
  const probed: string[] = [];

  for (const parent of candidates) {
    probed.push(parent);
    let meta;
    try {
      meta = await client.metadataFor(parent);
    } catch {
      continue; // A blocked or missing parent tells us nothing; try the next.
    }

    const parentMeta = meta.get(parent);
    if (!parentMeta?.navs.has(navName)) continue;

    // The parent's document declares the nav but does not always carry the
    // target's TYPE. It used to on one installation and does not on another —
    // SALES still says `SALECREDITINVOICES_SUBFORM -> SALECREDITINVOICES` while
    // omitting that entity — and the old code then reported the sub-form as
    // having zero columns, which reads as "this screen is empty" rather than
    // "look somewhere else". Asking for the child's own metadata works.
    let child = meta.get(input.screen);
    if (!child) {
      try {
        const ownMeta = await client.metadataFor(input.screen);
        child = ownMeta.get(input.screen);
      } catch {
        // Leave it undefined; the reply below says the structure is unavailable
        // rather than pretending the screen has no columns.
      }
    }
    const parentEntry = dict.get(parent);

    // Whether the parent can actually be READ is a separate question from whether
    // it describes the child. Answer both, because "here is the parent" is useless
    // if the parent is itself closed.
    let parentReadable = true;
    let parentError: string | undefined;
    try {
      await client.query(parent, { top: 1 });
    } catch (err) {
      parentReadable = false;
      parentError = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    }

    // Everything the parent-route reply carries, so the two agree.
    //
    // They did not: reaching a sub-form directly returned no help, no access, and
    // ignored the `columns` filter entirely, while reaching the same sub-form
    // through its parent returned all three. A caller comparing the two would
    // conclude the sub-form had no documentation, when it has its own.
    const [sources, help] = await Promise.all([
      input.includeColumnSources === false
        ? Promise.resolve(undefined)
        : columnSources(client, input.screen),
      input.includeHelp === false
        ? Promise.resolve(null)
        : fetchEntityHelp(client, dict, input.screen, "F"),
    ]);

    const filter = input.columns ? input.columns.toLocaleLowerCase() : null;
    const allCols = child ? [...child.columns.values()] : [];
    const selected = filter
      ? allCols.filter(
          (c) =>
            c.name.toLocaleLowerCase().includes(filter) ||
            (c.title ?? "").toLocaleLowerCase().includes(filter),
        )
      : allCols;
    const shownCols = selected.slice(0, MAX_COLUMNS_SHOWN);

    return {
      screen: input.screen,
      ...(help
        ? { help: help.text, helpReferences: help.references.length ? help.references : undefined }
        : input.includeHelp === false
          ? {}
          : { help: null, helpNote: "Priority has no help text recorded for this screen." }),
      title: child?.title ?? entry.title,
      table: entry.table,
      module: entry.module,
      published: false,
      access: entry.access,
      ...(entry.parents ? { parents: entry.parents } : {}),
      isSubform: true,
      parent,
      parentTitle: parentEntry?.title ?? parentMeta.title,
      navigationProperty: navName,
      keys: child?.keys ?? [],
      columnCount: allCols.length,
      columnsShown: shownCols.length,
      ...(child
        ? {}
        : {
            structureNote:
              `The columns of ${input.screen} could not be read: neither ${parent}'s ` +
              `metadata document nor a direct request for it returned a definition. ` +
              `This is NOT the same as the screen having no columns — read it through ` +
              `${parent} and inspect the rows to see what it holds.`,
          }),
      ...(selected.length > shownCols.length
        ? { note: `Showing ${shownCols.length} of ${selected.length} matching columns.` }
        : {}),
      columns: shownCols.map((c) => {
        const base = describeColumn(c);
        const src = sources?.get(c.name);
        return src ? { ...base, ...src } : base;
      }),
      parentReadable,
      howToRead: parentReadable
        ? `query with entity='${parent}' and expand='${navName}', or a keyed path ` +
          `'${parent}(<key>)/${navName}'. It has no entity set of its own.`
        : `${parent} is itself not readable on this server (${parentError}), so this ` +
          `sub-form cannot be reached even though its structure is known.`,
      note:
        `${input.screen} is a SUB-FORM of ${parent}, not a standalone screen. That is ` +
        `why reading it directly returns 404 — sub-forms are never entity sets. Its ` +
        `structure is shown above because it is defined inside ${parent}'s metadata.`,
    };
  }

  return {
    screen: input.screen,
    title: entry.title,
    table: entry.table,
    module: entry.module,
    published: false,
    access: entry.access,
    error:
      `${input.screen} ("${entry.title ?? "?"}") is not published as an OData entity ` +
      `set. It is most likely a sub-form of another screen — sub-forms are never ` +
      `entity sets — but the owning screen could not be identified.`,
    probedParents: probed,
    suggestion:
      `Search for a likely parent with search_screens (same module: ` +
      `${entry.module ?? "?"}, same table: ${entry.table ?? "?"}), then call ` +
      `describe_screen on it and look for '${navName}' in its subforms.`,
  };
}

// ---------------------------------------------------------------------------
// aggregate / column_values input shapes
// ---------------------------------------------------------------------------

const AGG_FNS = ["count", "sum", "avg", "min", "max"] as const;

export const aggregateShape = {
  entity: z.string().describe("Screen to aggregate, e.g. AINVOICES. CASE-SENSITIVE."),
  groupBy: z
    .array(z.string())
    .optional()
    .describe(
      'Columns to group by, e.g. ["IVDATE"] or ["CUSTNAME","IVTYPE"]. Omit for a ' +
        "single grand-total row. A DateTimeOffset column is grouped by DAY — " +
        "grouping on the raw timestamp would give one group per row.",
    ),
  aggregate: z
    .array(
      z.object({
        fn: z.enum(AGG_FNS).describe("count, sum, avg, min or max."),
        column: z
          .string()
          .optional()
          .describe("Column to aggregate. Required for everything except count."),
        as: z.string().optional().describe("Output name. Defaults to e.g. sum_QPRICE."),
      }),
    )
    .min(1)
    .describe('What to compute per group, e.g. [{"fn":"sum","column":"QPRICE"}].'),
  filter: z
    .string()
    .optional()
    .describe(
      "OData $filter applied before grouping. Same limits as query: no `in`, no " +
        "contains(). Filtering first is the main way to keep a scan cheap.",
    ),
  maxRows: LIMITS.scanRows > 0
    ? z
        .number()
        .int()
        .positive()
        .max(LIMITS.scanRows)
        .optional()
        .describe(
          `Ceiling on rows scanned, default ${LIMITS.scanRows}. Hitting it makes totals a lower bound.`,
        )
    : z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Ceiling on rows scanned. This server has no ceiling configured " +
            "(PRIORITY_MAX_SCAN_ROWS=0), so a scan runs until the data ends — pass a " +
            "value to bound it. Scanned rows cost requests and time, not context: " +
            "they are summed here and only the group rows come back.",
        ),
};

export const distinctShape = {
  entity: z.string().describe("Screen to inspect, e.g. AINVOICES. CASE-SENSITIVE."),
  column: z.string().describe("Column whose values you need, e.g. IVTYPE."),
  filter: z.string().optional().describe("Optional OData $filter to narrow the scan."),
  limit: z.number().int().positive().max(500).optional().describe("Values to return, default 50."),
};

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

export const queryShape = {
  entity: z
    .string()
    .optional()
    .describe("Screen to read, e.g. AINVOICES. CASE-SENSITIVE. Omit when using path."),
  path: z
    .string()
    .optional()
    .describe(
      "Raw OData path instead of entity, for what entity cannot express — a keyed " +
        "row or a sub-form: \"AINVOICES(IVNUM='IN224000031',DEBIT='D',IVTYPE='A')/" +
        'AINVOICEITEMS_SUBFORM". Include the query string yourself.',
    ),
  filter: z
    .string()
    .optional()
    .describe(
      "OData $filter, e.g. \"IVDATE ge 2025-01-01T00:00:00Z and FINAL eq 'Y'\". " +
        "Text matching works: contains(CUSTDES,'כהן'), startswith(...), endswith(...). " +
        "The `in` operator is NOT supported (this server answers HTTP 403 to it) — " +
        "use chained `or` instead. Avoid `ne` on a nullable column: it evaluates to " +
        "null for the null rows and silently drops them.",
    ),
  select: z
    .string()
    .optional()
    .describe(
      "Comma-separated columns. IGNORED when expand is set — on this server a " +
        "parent $select combined with $expand makes the response abort mid-JSON.",
    ),
  expand: z
    .string()
    .optional()
    .describe(
      'Sub-form to include, e.g. "AINVOICEITEMS_SUBFORM($select=PARTNAME,QUANT)". ' +
        "A nested $select is safe and keeps the payload down.",
    ),
  orderby: z.string().optional().describe("OData $orderby. Silently ignored by some screens."),
  top: LIMITS.rowsPerQuery > 0
    ? z
        .number()
        .int()
        .positive()
        .max(LIMITS.rowsPerQuery)
        .optional()
        .describe(
          `Maximum rows, default 50, hard maximum ${LIMITS.rowsPerQuery}. On this server ` +
            "$top caps the TOTAL rows rather than setting a page size.",
        )
    : z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum rows, default 50. This server sets no hard maximum " +
            "(PRIORITY_MAX_ROWS_PER_QUERY=0), so ask for what you can actually USE: " +
            "every row returned goes into the conversation, and a large reply crowds " +
            "out the context it was meant to inform. For a total or a count use " +
            "aggregate, which pages the whole set outside the conversation and " +
            "returns only the group rows. On this server $top caps the TOTAL rows " +
            "rather than setting a page size.",
        ),
  skip: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Rows to skip before the first returned row — the offset for paging past " +
        "the row cap. To read a whole screen, repeat the call raising skip by " +
        "the number of rows SHOWN each time (the response tells you the exact " +
        "value in nextSkip). Keep entity, filter, select, expand and orderby " +
        "identical across pages, or the rows re-shuffle and skip will miss some.",
    ),
  explain: z
    .boolean()
    .optional()
    .describe(
      "Dry run: return the exact URL these arguments produce and what would be " +
        "applied or dropped, WITHOUT sending anything to Priority. Use it to check " +
        "a filter or a column name before spending a call, or when a result looks " +
        "wrong and you want to see what was actually asked.",
    ),
};

export async function runQuery(
  client: PriorityODataClient,
  dict: PriorityDictionary,
  input: {
    entity?: string;
    path?: string;
    filter?: string;
    select?: string;
    expand?: string;
    orderby?: string;
    top?: number;
    skip?: number;
    explain?: boolean;
  },
): Promise<unknown> {
  if (!input.entity && !input.path) {
    throw new Error("Provide either entity or path.");
  }
  if (input.entity && input.path) {
    throw new Error("Provide entity or path, not both.");
  }

  const top = input.top ?? 50;
  const skip = input.skip ?? 0;
  let rows: Record<string, unknown>[];
  let describedAs: string;
  const notes: string[] = [];

  // Dry run: show what the arguments became, touch nothing.
  if (input.explain) {
    const willDropSelect = Boolean(input.expand) && Boolean(input.select);
    const url = input.path
      ? `${client.baseUrl}/${input.path.replace(/^\/+/, "")}`
      : client.previewUrl(input.entity!, {
          top,
          ...(skip ? { skip } : {}),
          ...(input.filter ? { filter: input.filter } : {}),
          ...(input.orderby ? { orderby: input.orderby } : {}),
          ...(input.expand ? { expand: input.expand } : {}),
          ...(input.select && !willDropSelect
            ? { select: input.select.split(",").map((s) => s.trim()) }
            : {}),
        });

    const wouldApply: string[] = [];
    if (input.path) {
      await dict.ready();
      try {
        assertSafePath(input.path, dict);
        wouldApply.push("path passes the entity allowlist");
      } catch (err) {
        wouldApply.push(`path WOULD BE REFUSED: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (input.skip !== undefined) wouldApply.push("skip would be ignored (path owns its query string)");
    } else {
      wouldApply.push(`top=${top} rows maximum`);
      if (skip) wouldApply.push(`starting at row ${skip + 1}`);
      if (willDropSelect) {
        wouldApply.push("select WOULD BE DROPPED — it truncates the response alongside expand");
      }
    }

    return {
      explain: true,
      executed: false,
      url,
      wouldApply,
      notes: [
        "Nothing was sent to Priority. This is what the arguments resolve to — " +
          "check the filter and the column names, then call again without explain.",
        "The URL carries no credentials; those travel in a header.",
      ],
    };
  }

  if (input.path) {
    // Before anything else: the dictionary must be loaded for the entity
    // allowlist to mean anything, and an unvalidated path must never reach the
    // client.
    await dict.ready();
    assertSafePath(input.path, dict);
    describedAs = input.path;
    if (input.skip !== undefined) {
      notes.push(
        "skip was ignored: with 'path' you own the whole query string, so put " +
          "$skip in the path yourself.",
      );
    }
    rows = await client.queryRawPath(input.path);
  } else {
    describedAs = input.entity!;
    const dropSelect = Boolean(input.expand) && Boolean(input.select);
    if (dropSelect) {
      notes.push(
        "select was ignored: combining a parent $select with $expand truncates the " +
          "response on this server. All header columns were returned instead.",
      );
    }
    rows = await client.query(input.entity!, {
      top,
      ...(skip ? { skip } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.orderby ? { orderby: input.orderby } : {}),
      ...(input.expand ? { expand: input.expand } : {}),
      ...(input.select && !dropSelect
        ? { select: input.select.split(",").map((s) => s.trim()) }
        : {}),
    });
  }

  // Two ceilings, not one. A row cap alone lets a wide screen blow the response
  // size, and a size cap alone lets a narrow screen return more rows than a
  // caller can use. Both have to report themselves, because a capped result
  // presented as complete produces wrong totals.
  let shown = rows;
  let charCapped = false;
  // The Number.isFinite guard is not cosmetic: with the cap lifted, serialising
  // the whole result just to compare it against Infinity is the one expensive
  // thing left in this function, and it is pure waste.
  if (Number.isFinite(MAX_RESPONSE_CHARS) && JSON.stringify(rows).length > MAX_RESPONSE_CHARS) {
    charCapped = true;
    let size = 0;
    const kept: Record<string, unknown>[] = [];
    for (const row of rows) {
      size += JSON.stringify(row).length + 1;
      if (size > MAX_RESPONSE_CHARS) break;
      kept.push(row);
    }
    shown = kept;
    notes.push(
      `Response exceeded ${MAX_RESPONSE_CHARS} characters, so only ${kept.length} of ` +
        `${rows.length} fetched rows are shown. This is a PARTIAL RESULT. Pass ` +
        `select to fetch fewer columns, or narrow the filter.`,
    );
  }

  // nextSkip counts rows SHOWN, not rows fetched. Counting fetched rows would
  // skip past the ones dropped for size, losing them for good.
  const hasMore = charCapped || (!input.path && rows.length >= top);
  const nextSkip = skip + shown.length;

  if (hasMore) {
    notes.push(
      input.path
        ? "This may be a partial result. With 'path' you control $top/$skip yourself."
        : `PARTIAL RESULT: ${rows.length} rows came back at top=${top}. Call again with ` +
          `skip=${nextSkip}, keeping every other argument byte-identical, until ` +
          `hasMore is false. Do not treat this page as the whole screen.`,
    );
  }

  notes.push(
    "There is no row total available: this server accepts $count and silently " +
      "ignores it. A count taken from one page is a lower bound, never the answer.",
  );

  return {
    source: describedAs,
    rowCount: shown.length,
    hasMore,
    ...(hasMore ? { nextSkip } : {}),
    notes,
    rows: shown,
  };
}
