import type { PriorityODataClient } from "./odata.js";
import type { PriorityDictionary } from "./dictionary.js";

// Priority's own help text, per entity.
//
// Each KIND of entity keeps its help under its own generator screen, with its
// own sub-form. The operator supplied the routes and they are measured here:
//
//   F screen     EFORM(ENAME='X',TYPE='F')/FORMHELP_SUBFORM
//   R report     EREP (ENAME='X',TYPE='R')/REPHELP_SUBFORM
//   P procedure  EPROG(ENAME='X',TYPE='P')/PROGHELP_SUBFORM
//   M menu       EMENU(ENAME='X',TYPE='M')/MENUHELP_SUBFORM
//   I interface  -- EINTER exists but has NO help sub-form at all
//
// All five parents key on (ENAME, TYPE), so a single-key path answers HTTP 400
// "The number of keys specified in the URI does not match".
//
// This replaces a wrong route. Every kind used to be read through
// EXEC(ENAME,TYPE)/FORMHELP_SUBFORM, which answers 403 on this installation --
// so the server reported "the API user is not permitted to read help" for every
// screen, report and procedure, while EFORM returns the text for the same screen
// perfectly well. The 403 was real and the conclusion drawn from it was not.
//
// TWO MEASURED TRAPS on these paths, and they point opposite ways:
//
//   * `$expand=FORMHELP_SUBFORM` is accepted and returns NOTHING. Only the keyed
//     path returns text. A negative result from an $expand here proves nothing.
//   * On the keyed SUB-FORM path the status codes are inverted from the obvious
//     reading: an entity that EXISTS but has no help row answers HTTP 404, while
//     a name that does not exist at all answers 200 with zero rows. So a 404 here
//     means "no help recorded", not "wrong name" -- and the name is checked
//     against the dictionary to tell the caller which of the two it is.
/** EXEC's TYPE letter -> what kind of thing it is. */
export const ENTITY_KINDS: Record<string, string> = {
  F: "screen",
  R: "report",
  P: "procedure",
  I: "interface",
  M: "menu",
};

/** Where each kind's help lives: its generator screen and that screen's sub-form. */
const HELP_ROUTES: Record<string, { parent: string; nav: string }> = {
  F: { parent: "EFORM", nav: "FORMHELP_SUBFORM" },
  R: { parent: "EREP", nav: "REPHELP_SUBFORM" },
  P: { parent: "EPROG", nav: "PROGHELP_SUBFORM" },
  M: { parent: "EMENU", nav: "MENUHELP_SUBFORM" },
  // No I: EINTER has no help sub-form, so there is nothing to read.
};

/** Entity kinds this server can fetch help for. */
export const HELP_TYPES = Object.keys(HELP_ROUTES);

export interface HelpReference {
  /** Entity name as written in the help text. */
  name: string;
  /** EXEC TYPE letter. */
  type: string;
  /** Human-readable kind, e.g. "screen". */
  kind: string;
  /** Hebrew title, when it can be resolved. */
  title: string | null;
}

export interface ScreenHelp {
  text: string;
  references: HelpReference[];
  /** Present when the source text was longer than the cap. */
  truncated?: boolean;
}

/** Keep one help entry from crowding out the description it accompanies. */
const MAX_HELP_CHARS = 6000;

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Reduce Priority's help HTML to readable text.
 *
 * Deliberately not a general HTML converter. The input is a narrow, known shape:
 * an inline `<style>` block, `dir=rtl` paragraphs, `<br>` breaks, and an HTML
 * comment carrying the screen's own code and title. The comment is dropped
 * because it duplicates fields the caller already has, and the style block is
 * dropped because otherwise its CSS text survives tag-stripping and reads as
 * content.
 */
export function helpHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    // Collapse runs of blank lines, and trailing spaces on each line, without
    // flattening the paragraph structure that makes the text readable.
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pull `{ENTITY.T}` cross-references out of a help text.
 *
 * These are how Priority's help points at related screens -- AINVOICES's help
 * names {AINVOICEITEMS.F} as the sub-form holding its lines -- so surfacing them
 * as structured data turns prose into something a caller can act on.
 */
export function parseHelpReferences(text: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\.([A-Z])\}/g)) {
    const name = m[1]!;
    const type = m[2]!;
    const key = `${name}.${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, type });
  }
  return out;
}

/** Replace `{X.F}` with a readable form once the reference is resolved. */
function inlineReferences(text: string, refs: HelpReference[]): string {
  let out = text;
  for (const r of refs) {
    const label = r.title ? `${r.name} (${r.title})` : r.name;
    out = out.split(`{${r.name}.${r.type}}`).join(label);
  }
  return out;
}

/**
 * What a help read produced, including WHY it produced nothing.
 *
 * `null` used to stand for every failure, and a caller turned it into "Priority
 * has no help text recorded for this screen" -- which on this installation is
 * false for every screen: the help is there and the API user is refused it (HTTP
 * 403). A model told "no help exists" stops looking; a model told "you are not
 * permitted to read it" can say so and the operator can fix it.
 */
export type HelpOutcome =
  | { available: true; text: string; references: HelpReference[]; truncated?: boolean }
  | { available: false; reason: string; permission?: true };

const esc = (v: string): string => v.replace(/'/g, "''");

/** The keyed help path for one entity, or null when its kind has no help route. */
export function entityHelpPath(ename: string, type: string): string | null {
  const route = HELP_ROUTES[type];
  if (!route) return null;
  return `${route.parent}(ENAME='${esc(ename)}',TYPE='${esc(type)}')/${route.nav}`;
}

/**
 * Column help hangs off the form generator, not off EXEC:
 * EFORM -> FCLMN (keyed by NAME) -> FCLMNHELP. Measured 2026-09-02: this path
 * returns the text while the nested `$expand` form of the same request returns
 * FCLMN rows with an empty FCLMNHELP_SUBFORM on every one -- the same silent-empty
 * shape as FORMHELP. Also measured: FCLMNHELP reads fine on an installation where
 * FORMHELP is refused with 403, so column help can exist where screen help does
 * not. The two are permitted separately.
 */
export function columnHelpPath(screen: string, column: string): string {
  return `EFORM(ENAME='${esc(screen)}',TYPE='F')/FCLMN_SUBFORM(NAME='${esc(column)}')/FCLMNHELP_SUBFORM`;
}

/**
 * Turn the OData client's error into a reason a caller can act on.
 *
 * @param known Whether the dictionary recognises the name. It is what separates
 *   the two readings of a 404 on these paths -- see the note at the top.
 */
export function explainHelpFailure(
  err: unknown,
  what: string,
  known?: boolean,
): HelpOutcome & { available: false } {
  const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
  if (/HTTP 403/.test(msg)) {
    return {
      available: false,
      permission: true,
      reason:
        `Priority refused to return ${what} (HTTP 403): the API user is not permitted to ` +
        `read this help sub-form. The help itself may well exist; an operator can grant the ` +
        `permission in Priority. Do not conclude that no help is recorded.`,
    };
  }
  if (/HTTP 404/.test(msg)) {
    // Inverted on purpose, and measured: on a help sub-form path an entity that
    // exists without a help row answers 404, so 404 is the ORDINARY "none
    // recorded" case rather than a bad name.
    return {
      available: false,
      reason:
        known === false
          ? `${what}: Priority has no such entity. Check the name, the letter case and the ` +
            `type letter -- search_screens finds the right one.`
          : `${what}: Priority has no help recorded for it. That is an answer, not a failure; ` +
            `say so rather than retrying or trying a different name.`,
    };
  }
  return { available: false, reason: `${what} could not be read: ${msg}` };
}

async function readHelp(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  path: string,
  what: string,
  known?: boolean,
): Promise<HelpOutcome> {
  let rows: Record<string, unknown>[];
  try {
    rows = await client.queryRawPath(path);
  } catch (err) {
    return explainHelpFailure(err, what, known);
  }

  const raw = String(rows[0]?.["TEXT"] ?? "");
  if (!raw.trim()) {
    // Zero rows on this path is the shape a NON-EXISTENT name takes; an existing
    // one without help 404s instead. Worth saying, because the obvious reading of
    // "empty" is the other way round.
    return {
      available: false,
      reason:
        known === false
          ? `${what}: Priority returned nothing, and no entity of that name and type exists. ` +
            `Check the name and the letter case with search_screens.`
          : `Priority returned no help text for ${what}.`,
    };
  }

  let text = helpHtmlToText(raw);
  const truncated = text.length > MAX_HELP_CHARS;
  if (truncated) text = `${text.slice(0, MAX_HELP_CHARS)}\n…[truncated]`;

  const refs = parseHelpReferences(text);
  const references: HelpReference[] = refs.map((r) => ({
    name: r.name,
    type: r.type,
    kind: ENTITY_KINDS[r.type] ?? r.type,
    // Screen titles come from the cached dictionary, so resolving them costs
    // nothing. Other kinds live in EXEC, which is not cached here.
    title: r.type === "F" ? (dict?.get(r.name)?.title ?? null) : null,
  }));

  return {
    available: true,
    text: inlineReferences(text, references),
    references,
    ...(truncated ? { truncated } : {}),
  };
}

/** Help for a screen (F), report (R), procedure (P) or menu (M). */
export async function fetchEntityHelpOutcome(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  ename: string,
  type = "F",
): Promise<HelpOutcome> {
  const kind = ENTITY_KINDS[type] ?? `type ${type}`;
  const path = entityHelpPath(ename, type);
  if (!path) {
    return {
      available: false,
      reason:
        `Priority keeps no help for a ${kind} (type '${type}'). Help lives under each kind's ` +
        `generator screen, and the one for this kind has no help sub-form -- so there is ` +
        `nothing to read, on any installation. Available kinds: ${HELP_TYPES.join(", ")}.`,
    };
  }
  // Does Priority have this entity at all? It decides how to read a 404, and the
  // dictionary already knows without a request.
  const known = dict
    ? type === "F"
      ? dict.get(ename) !== undefined
      : dict.getProgram(ename, type === "P" || type === "R" ? type : undefined).length > 0
    : undefined;
  return readHelp(client, dict, path, `the help for ${kind} ${ename}`, known);
}

/** Help for one column of one screen, from FCLMNHELP. */
export function fetchColumnHelp(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  screen: string,
  column: string,
): Promise<HelpOutcome> {
  return readHelp(client, dict, columnHelpPath(screen, column), `the help for column ${column} of ${screen}`);
}

/**
 * Fetch and clean the help for one entity, or null.
 *
 * Kept for callers that only want the text. Anything that will TELL a user why
 * there is no help should use fetchEntityHelpOutcome instead, because null here
 * hides a permission refusal behind the same value as genuinely absent text.
 */
export async function fetchEntityHelp(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  ename: string,
  type = "F",
): Promise<ScreenHelp | null> {
  const outcome = await fetchEntityHelpOutcome(client, dict, ename, type);
  if (!outcome.available) return null;
  const { text, references, truncated } = outcome;
  return { text, references, ...(truncated ? { truncated } : {}) };
}
