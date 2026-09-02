import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A business vocabulary layer over the screen dictionary.
//
// Priority stores a screen's meaning in its Hebrew title, and that title is
// Priority's term, not the user's. Someone asks about "מחזור" and the screen is
// called "חשבוניות מס"; asks about "חוב לקוחות" and the data is in "יתרות פתוחות".
// No amount of string matching bridges that, because the words genuinely differ.
//
// Both SAP and Oracle treat this as the decisive input to natural-language
// accuracy -- SAP exposes synonyms on measures and dimensions, Oracle stores
// annotations and a business glossary alongside the schema. This file is the same
// idea in the smallest form that works: a maintained mapping from what people say
// to the screens and columns that answer it.
//
// It is maintained by hand ON PURPOSE. A wrong entry here sends the model
// confidently to the wrong screen, which is worse than no entry at all, so
// tests/live.glossary.ts verifies every screen name against the live dictionary.

export interface GlossaryTerm {
  /** The canonical business term, in Hebrew. */
  term: string;
  /** Other ways people say it, including English. */
  aliases?: string[];
  /** Screens that answer questions about this term, best first. */
  screens?: string[];
  /** Columns that carry the value, as `SCREEN.COLUMN` or bare column names. */
  columns?: string[];
  /** Anything a caller must know before using these screens for this term. */
  notes?: string;
}

export interface GlossaryMatch extends GlossaryTerm {
  /** Which of the term's spellings the query hit. */
  matched: string;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function glossaryPath(): string {
  const configured = (process.env["PRIORITY_GLOSSARY_FILE"] ?? "").trim();
  if (!configured) return path.join(PROJECT_ROOT, "glossary.json");
  return path.isAbsolute(configured) ? configured : path.join(PROJECT_ROOT, configured);
}

/** Same folding as the dictionary: gershayim, bidi marks, whitespace. */
function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[״“”″"]/g, '"')
    .replace(/[׳‘’′']/g, "'")
    .replace(/[‎‏‪-‮]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WorkedExample {
  question: string;
  keywords?: string[];
  calls: string[];
  notes?: string;
}

/**
 * Worked examples, matched by keyword.
 *
 * Oracle names few-shot examples as one of the strongest levers on NL2SQL
 * accuracy and builds them from a feedback loop into a vector index. This is the
 * same idea at the scale this server needs: a maintained file and keyword
 * matching, which is enough while the set is small and can be replaced with
 * embeddings if it ever stops being.
 */
export class Examples {
  private items: WorkedExample[] = [];
  private loaded = false;
  private error: string | null = null;

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const configured = (process.env["PRIORITY_EXAMPLES_FILE"] ?? "").trim();
    const file = configured
      ? path.isAbsolute(configured)
        ? configured
        : path.join(PROJECT_ROOT, configured)
      : path.join(PROJECT_ROOT, "examples.json");
    try {
      if (!fs.existsSync(file)) {
        this.error = `no examples at ${file}`;
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { examples?: WorkedExample[] };
      this.items = (parsed.examples ?? []).filter((e) => e.question && Array.isArray(e.calls));
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.items = [];
    }
  }

  get loadError(): string | null {
    this.ensure();
    return this.error;
  }

  all(): WorkedExample[] {
    this.ensure();
    return this.items;
  }

  /** Examples whose question or keywords overlap the query. Best first. */
  match(query: string, limit = 2): WorkedExample[] {
    this.ensure();
    const q = normalize(query);
    if (!q) return [];

    const scored = this.items
      .map((ex) => {
        let score = 0;
        for (const k of ex.keywords ?? []) {
          const n = normalize(k);
          if (n.length > 1 && q.includes(n)) score += n.length;
        }
        // A shared word with the stored question is a weaker but real signal.
        for (const word of q.split(" ")) {
          if (word.length > 2 && normalize(ex.question).includes(word)) score += 1;
        }
        return { ex, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.ex);
  }
}

export class Glossary {
  private terms: GlossaryTerm[] = [];
  private loaded = false;
  private error: string | null = null;

  /** Read the file once. A missing or broken glossary degrades, never throws. */
  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = glossaryPath();
    try {
      if (!fs.existsSync(file)) {
        this.error = `no glossary at ${file}`;
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { terms?: GlossaryTerm[] };
      this.terms = (parsed.terms ?? []).filter((t) => typeof t.term === "string" && t.term.trim());
    } catch (err) {
      // A broken glossary must not take the discovery tools down with it.
      this.error = err instanceof Error ? err.message : String(err);
      this.terms = [];
    }
  }

  get loadError(): string | null {
    this.ensure();
    return this.error;
  }

  all(): GlossaryTerm[] {
    this.ensure();
    return this.terms;
  }

  /**
   * Terms whose name or an alias appears in the query.
   *
   * Substring rather than equality, because a real question is a sentence:
   * "מה המחזור ב-2024" has to hit "מחזור". Longest spelling first, so a specific
   * phrase wins over a generic word contained inside it.
   */
  match(query: string): GlossaryMatch[] {
    this.ensure();
    const q = normalize(query);
    if (!q) return [];

    const hits: GlossaryMatch[] = [];
    for (const term of this.terms) {
      const spellings = [term.term, ...(term.aliases ?? [])]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const found = spellings.find((s) => {
        const n = normalize(s);
        return n.length > 1 && (q.includes(n) || n.includes(q));
      });
      if (found) hits.push({ ...term, matched: found });
    }

    // A longer matched spelling is the more specific reading of the question.
    return hits.sort((a, b) => b.matched.length - a.matched.length);
  }
}
