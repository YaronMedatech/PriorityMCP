import type { PriorityDictionary, ScreenEntry } from "./dictionary.js";
import type { Glossary } from "./glossary.js";

// Is this installation ready to be asked questions in natural language?
//
// SAP ships a "model readiness check" for exactly this: it scans the analytical
// models and reports missing semantics, ambiguous labels and unclear hierarchies,
// with a severity and a recommended fix for each. The insight worth copying is
// that natural-language accuracy is mostly a DATA QUALITY property, and that the
// gaps are findable before anyone asks a question and gets a bad answer.
//
// Everything below is computed from the cached dictionary, so the report costs no
// requests. It answers "why did that question fail" with a list rather than a
// guess.

export interface ReadinessIssue {
  kind: string;
  severity: "high" | "medium" | "low";
  count: number;
  detail: string;
  fix: string;
  examples: string[];
}

export interface ReadinessReport {
  totals: {
    screens: number;
    direct: number;
    viaParent: number;
    unavailable: number;
    withHebrewTitle: number;
    glossaryTerms: number;
  };
  issues: ReadinessIssue[];
  notes: string[];
}

const MAX_EXAMPLES = 8;

export function buildReadiness(dict: PriorityDictionary, glossary?: Glossary): ReadinessReport {
  const all = dict.allEntries();

  const direct = all.filter((e) => e.access === "direct");
  const viaParent = all.filter((e) => e.access === "via-parent");
  const unavailable = all.filter((e) => e.access === "unavailable");
  const titled = all.filter((e) => (e.title ?? "").trim().length > 0);

  const issues: ReadinessIssue[] = [];

  // 1. Ambiguous titles. This is the one SAP calls out by name, and it is the
  //    most damaging: two screens with the same Hebrew title cannot be told apart
  //    from the question, so the model picks one and may be silently wrong.
  const byTitle = new Map<string, ScreenEntry[]>();
  for (const e of all) {
    const t = (e.title ?? "").trim();
    if (!t) continue;
    const list = byTitle.get(t) ?? [];
    list.push(e);
    byTitle.set(t, list);
  }
  const ambiguous = [...byTitle.entries()].filter(([, v]) => v.filter((e) => e.access === "direct").length > 1);
  if (ambiguous.length) {
    ambiguous.sort((a, b) => b[1].length - a[1].length);
    issues.push({
      kind: "ambiguous-title",
      severity: "high",
      count: ambiguous.length,
      detail:
        `${ambiguous.length} Hebrew titles are shared by more than one READABLE screen. ` +
        `A question naming one of these cannot be resolved from the title alone.`,
      fix:
        "Add a glossary entry pinning the term to the screen that should answer it, " +
        "so the mapping does not depend on ranking.",
      examples: ambiguous
        .slice(0, MAX_EXAMPLES)
        .map(([title, list]) => `"${title}" → ${list.filter((e) => e.access === "direct").map((e) => e.screen).join(", ")}`),
    });
  }

  // 2. Readable screens with no Hebrew title at all. Nothing to match a question
  //    against except an opaque English code.
  const untitled = direct.filter((e) => !(e.title ?? "").trim());
  if (untitled.length) {
    issues.push({
      kind: "no-title",
      severity: "medium",
      count: untitled.length,
      detail:
        `${untitled.length} readable screens have no Hebrew title. They are entity sets ` +
        `Priority publishes but EFORM does not describe, so a search in Hebrew will never find them.`,
      fix: "Reachable by exact name only. Add a glossary entry for any that matter.",
      examples: untitled.slice(0, MAX_EXAMPLES).map((e) => e.screen),
    });
  }

  // 3. Case-only twins. Folding these would merge genuinely different screens,
  //    so the dictionary keeps them apart -- but a caller who lowercases a name
  //    silently gets the wrong one.
  const byLower = new Map<string, string[]>();
  for (const e of all) {
    const k = e.screen.toLocaleLowerCase();
    const list = byLower.get(k) ?? [];
    list.push(e.screen);
    byLower.set(k, list);
  }
  const caseTwins = [...byLower.values()].filter((v) => v.length > 1);
  if (caseTwins.length) {
    issues.push({
      kind: "case-only-difference",
      severity: "medium",
      count: caseTwins.length,
      detail:
        `${caseTwins.length} screen names differ from another ONLY by letter case. ` +
        `Getting the case wrong silently reads a different screen.`,
      fix: "Always copy the name from search_screens rather than retyping it.",
      examples: caseTwins.slice(0, MAX_EXAMPLES).map((v) => v.join(" / ")),
    });
  }

  // 4. Sub-forms whose parents are all unreadable. Genuinely unreachable, and
  //    worth knowing before someone spends a question on one.
  if (unavailable.length) {
    issues.push({
      kind: "unreachable",
      severity: "low",
      count: unavailable.length,
      detail:
        `${unavailable.length} screens are neither published nor children of anything readable. ` +
        `They exist in Priority and cannot be read through this API.`,
      fix: "Open the screen for the API in Priority if it is needed, or accept it is out of scope.",
      examples: unavailable.slice(0, MAX_EXAMPLES).map((e) => `${e.screen} (${e.title ?? "?"})`),
    });
  }

  // 5. Glossary coverage. Not a defect, but the lever most likely to be under-used.
  const terms = glossary?.all() ?? [];
  const stale: string[] = [];
  for (const t of terms) {
    for (const s of t.screens ?? []) if (!dict.get(s)) stale.push(`${t.term} → ${s}`);
  }
  if (stale.length) {
    issues.push({
      kind: "stale-glossary",
      severity: "high",
      count: stale.length,
      detail: `${stale.length} glossary entries name a screen that does not exist.`,
      fix: "Correct the name in glossary.json — a wrong mapping is worse than no mapping.",
      examples: stale.slice(0, MAX_EXAMPLES),
    });
  }

  const notes: string[] = [
    "Computed from the cached dictionary; no requests were made.",
    "Ambiguous titles are the finding worth acting on first — they produce " +
      "confidently wrong answers rather than visible failures.",
  ];
  if (!terms.length) {
    notes.push(
      "The glossary is empty. It is the single highest-value input to natural-language " +
        "accuracy, because Priority's screen titles are Priority's wording rather than " +
        "the words people actually use.",
    );
  }

  return {
    totals: {
      screens: all.length,
      direct: direct.length,
      viaParent: viaParent.length,
      unavailable: unavailable.length,
      withHebrewTitle: titled.length,
      glossaryTerms: terms.length,
    },
    issues: issues.sort((a, b) => rank(b.severity) - rank(a.severity)),
    notes,
  };
}

function rank(s: ReadinessIssue["severity"]): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}
