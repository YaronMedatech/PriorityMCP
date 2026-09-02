import { PriorityODataClient } from "./odata.js";
import { helpHtmlToText } from "./help.js";

// AI skills authored INSIDE Priority.
//
// Priority 26 has a screen for them -- AIWORKFLOWS, titled "AI סקילז", with the
// prompt text in its AIWORKFLOWSTEXT sub-form ("פרומפט") -- and Priority's own MCP
// exposes it as skill_list / skill_fetch. The idea is the same as this server's
// glossary.json and examples.json: instructions a person wrote for the model. The
// difference is who owns them. The glossary is the operator's; skills belong to
// whoever administers Priority, and they travel with the installation.
//
// Measured 2026-09-02 on the reference installation: AIWORKFLOWS is listed in the
// service document and answers HTTP 400 "לא ניתן להפעיל API למסך זה" in every
// company. So this module is built to say WHY it has nothing rather than to
// pretend the feature does not exist, and the column names below are read from
// metadata at run time rather than assumed -- nobody here has seen a row yet.

export interface SkillSummary {
  /** The key value(s) that identify the skill, as `COL=value` pairs. */
  key: Record<string, string | number>;
  /** Best-effort title: the first text column whose name looks like a title. */
  title: string | null;
  /** Every non-empty scalar column, so nothing is hidden behind a guess. */
  fields: Record<string, unknown>;
}

export type SkillsOutcome =
  | { available: true; count: number; skills: SkillSummary[]; keyColumns: string[]; note?: string }
  | { available: false; reason: string; permission?: true };

export type SkillOutcome =
  | { available: true; key: Record<string, string | number>; title: string | null; text: string; lines: number }
  | { available: false; reason: string; permission?: true };

const SCREEN = "AIWORKFLOWS";
const TEXT_SUBFORM = "AIWORKFLOWSTEXT_SUBFORM";
const CACHE_TTL_MS = 10 * 60_000;

interface Cached {
  at: number;
  outcome: SkillsOutcome;
  keys: string[];
}

/** Per installation+company, since skills are DATA and differ by company. */
const cache = new Map<string, Cached>();

/** Test seam. */
export function resetSkillsCache(): void {
  cache.clear();
}

function explain(err: unknown): SkillsOutcome & { available: false } {
  const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
  if (/HTTP 403/.test(msg)) {
    return {
      available: false,
      permission: true,
      reason:
        `Priority refused to read ${SCREEN} (HTTP 403): the API user is not permitted. ` +
        `Skills exist in Priority; an administrator can grant this user the screen.`,
    };
  }
  if (/not available to the API|לא ניתן להפעיל API/.test(msg)) {
    return {
      available: false,
      permission: true,
      reason:
        `Priority answers "לא ניתן להפעיל API למסך זה" for ${SCREEN} (AI סקילז). Either the ` +
        `screen is not opened for the API in the form generator, or the API user lacks ` +
        `the "תחזוקת מערכת" module. Skills may well be defined; this server cannot see ` +
        `them until one of those changes. Say that rather than "there are no skills".`,
    };
  }
  return { available: false, reason: `${SCREEN} could not be read: ${msg}` };
}

const looksLikeTitle = (name: string): boolean => /DES$|NAME$|TITLE|SUBJECT|^DESC/i.test(name);

/**
 * All skills the current company defines.
 *
 * Reads metadata first for the key columns, then the rows. Both are cached for
 * ten minutes per company, INCLUDING a refusal: a screen that is closed answers
 * fast, but search_screens consults this on every call and should not pay even
 * that when the answer cannot have changed.
 */
export async function listSkills(client: PriorityODataClient): Promise<SkillsOutcome> {
  const cacheKey = client.baseUrl;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.outcome;

  let keys: string[] = [];
  let outcome: SkillsOutcome;
  try {
    const md = (await client.metadataFor(SCREEN)).get(SCREEN);
    keys = md?.keys ?? [];
    const rows = await client.query(SCREEN, { pageSize: 500 });
    const columns = md ? [...md.columns.keys()] : Object.keys(rows[0] ?? {});
    const titleCol = columns.find((c) => looksLikeTitle(c) && !keys.includes(c)) ?? columns.find(looksLikeTitle) ?? null;

    const skills: SkillSummary[] = rows.map((r) => {
      const key: Record<string, string | number> = {};
      for (const k of keys) {
        const v = r[k];
        if (typeof v === "number" || typeof v === "string") key[k] = v;
      }
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("@") || k === TEXT_SUBFORM) continue;
        if (v === null || v === "" || v === 0 || v === false) continue;
        fields[k] = v;
      }
      return { key, title: titleCol ? (str(r[titleCol]) ?? null) : null, fields };
    });

    outcome = {
      available: true,
      count: skills.length,
      skills,
      keyColumns: keys,
      ...(titleCol
        ? {}
        : { note: "No column looked like a title; read 'fields' on each skill to pick one." }),
    };
  } catch (err) {
    outcome = explain(err);
  }

  cache.set(cacheKey, { at: Date.now(), outcome, keys });
  return outcome;
}

/**
 * One skill's full text, from the AIWORKFLOWSTEXT sub-form by keyed path.
 *
 * A keyed path and not `$expand`, on the strength of two measurements on this
 * server: FORMHELP and FCLMNHELP both come back EMPTY through an expand and full
 * through the keyed path. A text sub-form is the shape that trap takes.
 */
export async function fetchSkill(
  client: PriorityODataClient,
  key: Record<string, string | number>,
): Promise<SkillOutcome> {
  const listed = await listSkills(client);
  if (!listed.available) return listed;

  const keyCols = listed.keyColumns;
  const missing = keyCols.filter((k) => key[k] === undefined);
  if (missing.length) {
    return {
      available: false,
      reason: `The skill key needs ${keyCols.join(", ")}; missing ${missing.join(", ")}. Take 'key' from list_skills.`,
    };
  }
  const summary = listed.skills.find((s) => keyCols.every((k) => String(s.key[k]) === String(key[k])));
  if (!summary) {
    return { available: false, reason: `No skill with key ${JSON.stringify(key)} in list_skills.` };
  }

  const keyPath = keyCols
    .map((k) => `${k}=${typeof key[k] === "number" ? String(key[k]) : `'${String(key[k]).replace(/'/g, "''")}'`}`)
    .join(",");
  let rows: Record<string, unknown>[];
  try {
    rows = await client.queryRawPath(`${SCREEN}(${keyPath})/${TEXT_SUBFORM}`);
  } catch (err) {
    return explain(err);
  }

  // The text column is not known in advance either: take the longest string
  // column per row, which is what a prompt body is, and keep the rows in the
  // order Priority returned them.
  const pieces = rows.map((r) => {
    const strings = Object.entries(r)
      .filter(([k, v]) => !k.startsWith("@") && typeof v === "string")
      .map(([, v]) => v as string);
    return strings.sort((a, b) => b.length - a.length)[0] ?? "";
  });
  const raw = pieces.join("\n");
  const text = /<[a-z][\s\S]*>/i.test(raw) ? helpHtmlToText(raw) : raw.trim();

  return { available: true, key: summary.key, title: summary.title, text, lines: rows.length };
}

/** Skills whose title or fields mention the query. For search_screens. */
export function matchSkills(outcome: SkillsOutcome, query: string, limit = 3): SkillSummary[] {
  if (!outcome.available) return [];
  const q = query.toLocaleLowerCase().trim();
  if (q.length < 2) return [];
  return outcome.skills
    .filter((s) => {
      const hay = [s.title ?? "", ...Object.values(s.fields).map(String)].join(" ").toLocaleLowerCase();
      return hay.includes(q) || q.split(/\s+/).some((w) => w.length > 2 && hay.includes(w));
    })
    .slice(0, limit);
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
