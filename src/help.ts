import { PriorityODataClient } from "./odata.js";
import type { PriorityDictionary } from "./dictionary.js";

// Priority's own help text, per entity.
//
// It lives on the EXEC screen -- which lists every entity in the system, not just
// forms -- as the FORMHELP sub-form, and it is reachable ONLY through a keyed
// path:
//
//   EXEC(ENAME='AINVOICES',TYPE='F')/FORMHELP_SUBFORM
//
// `$expand=FORMHELP_SUBFORM` is accepted and returns NOTHING. Measured: across all
// 15974 EXEC rows the expand yielded zero help rows, while the keyed path returns
// the text for the same entities. This is the same shape of trap as `$count=true`
// on this server -- accepted, silently empty -- and it is worth stating plainly
// because an earlier sweep of this project used the expand and concluded from it
// that no help existed anywhere. It does; the route was wrong. A negative result
// from an `$expand` on this server proves nothing on its own.
//
// EFORM also has a FORMHELP_SUBFORM nav, and it is empty on every form. The help
// hangs off EXEC, not EFORM -- checking the wrong parent is the other half of
// how this was missed.
//
// EXEC's key is composite (ENAME, TYPE), so the type letter is required: the same
// name exists as several entities (ABCRAW is both a report and a procedure).

/** EXEC's TYPE letter -> what kind of thing it is. */
export const ENTITY_KINDS: Record<string, string> = {
  F: "screen",
  R: "report",
  P: "procedure",
  I: "interface",
  M: "menu",
};

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

/** `EXEC(ENAME='X',TYPE='F')/FORMHELP_SUBFORM` -- the only route that returns anything. */
export function entityHelpPath(ename: string, type: string): string {
  return `EXEC(ENAME='${esc(ename)}',TYPE='${esc(type)}')/FORMHELP_SUBFORM`;
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

/** Turn the OData client's error into a reason a caller can act on. */
export function explainHelpFailure(err: unknown, what: string): HelpOutcome & { available: false } {
  const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
  if (/HTTP 403/.test(msg)) {
    return {
      available: false,
      permission: true,
      reason:
        `Priority refused to return ${what} (HTTP 403): the API user is not permitted to ` +
        `read the help sub-form. The help itself exists; an operator can grant the ` +
        `permission in Priority. Do not conclude that no help is recorded.`,
    };
  }
  if (/HTTP 404/.test(msg)) {
    return {
      available: false,
      reason: `${what} was not found (HTTP 404). Check the name, the type letter and the letter case.`,
    };
  }
  return { available: false, reason: `${what} could not be read: ${msg}` };
}

async function readHelp(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  path: string,
  what: string,
): Promise<HelpOutcome> {
  let rows: Record<string, unknown>[];
  try {
    rows = await client.queryRawPath(path);
  } catch (err) {
    return explainHelpFailure(err, what);
  }

  const raw = String(rows[0]?.["TEXT"] ?? "");
  if (!raw.trim()) {
    return { available: false, reason: `Priority returned no help text for ${what}.` };
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

/** Help for a screen (F), report (R), procedure (P), interface (I) or menu (M). */
export function fetchEntityHelpOutcome(
  client: PriorityODataClient,
  dict: PriorityDictionary | undefined,
  ename: string,
  type = "F",
): Promise<HelpOutcome> {
  const kind = ENTITY_KINDS[type] ?? `type ${type}`;
  return readHelp(client, dict, entityHelpPath(ename, type), `the help for ${kind} ${ename}`);
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
