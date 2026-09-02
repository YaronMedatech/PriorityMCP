import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installationBase } from "./config.js";
import { PriorityODataClient } from "./odata.js";

// Priority's screen dictionary, cached in the server process.
//
// EFORM is the only dictionary table this API exposes: TABTITLES, COLTITLES,
// TITLES, COLUMNS, FREPORTS and PROGDESIGN all answer
// "לא ניתן להפעיל API למסך זה", and APPS/APP answer 404. So the Hebrew name of
// every screen comes from here or from nowhere.
//
// It is cached and searched in memory rather than server-side. The original
// reason was that the reference installation answered 501 Not Implemented to
// contains(); the current one (t.eu.priority-connect.online, measured 2026-09-02)
// accepts contains(), startswith() and endswith(). The design stands on its own
// regardless: ranking, gershayim normalisation and Hebrew stemming are not things
// an OData $filter can express, and one load of the table is cheaper than a
// round trip per question.

export interface ScreenEntry {
  /** Internal screen name, e.g. `AINVOICES`. Case is significant. */
  screen: string;
  /** Hebrew title as the user sees it in Priority, e.g. `חשבוניות מס`. */
  title: string | null;
  /** Underlying table, e.g. `INVOICES`. Several screens share one table. */
  table: string | null;
  /** Priority module, e.g. `חשבוניות לקוח`. */
  module: string | null;
  /**
   * Whether the screen is published as an OData entity set.
   *
   * NEITHER DIRECTION IS A GUARANTEE. An earlier version of this comment claimed
   * `published: false` reliably meant "cannot be read as an entity set". Measured
   * on an installation with every screen opened to the API, that is false:
   * AINVOICEITEMS is absent from the service document and reads perfectly well as
   * an entity, while SALECREDITINVOICES is absent and genuinely refuses. The
   * service document under-reports on some installations.
   *
   * So this flag is a hint in both directions, and only an actual read settles
   * it. Anything told to a caller must be worded so that trying is still allowed.
   */
  published: boolean;
  /**
   * How this screen can actually be read.
   *
   * `published` alone conflated two situations that call for opposite responses,
   * and callers acted on the wrong one: a model told `published: false` for a
   * SUB-FORM concluded the data was unavailable and stopped, when the rows were
   * there all along behind the parent screen. Measured on the reference server,
   * thousands of screens are children of another form and none is a top-level
   * entity set -- so under the old flag every one of them looked closed.
   *
   * - `direct`      read it with `entity`
   * - `via-parent`  not listed as an entity set, but a sub-form of a readable
   *                 screen: read it through {@link ScreenEntry.parents}
   * - `unavailable` neither published nor a child of anything readable
   * - `program`     not a screen at all: a procedure or report. It is never
   *                 queried; it is described with `help` and run through the
   *                 program tools, and only if the operator's catalog lists it.
   */
  access: "direct" | "via-parent" | "unavailable" | "program";
  /**
   * Readable screens that own this one as a sub-form, from EFORM's own
   * parent/child graph. Present only when `access` is `via-parent`.
   */
  parents?: string[];
  /**
   * What kind of entity this is: `F` screen, `P` procedure, `R` report.
   *
   * Screens come from EFORM; procedures and reports from EXEC, which lists every
   * entity in the installation with its Hebrew title. One name can exist as
   * several kinds -- FORMMSG is a screen, a report AND a procedure -- so the
   * kind is part of the identity, not a label on it.
   */
  kind: "F" | "P" | "R";
}

export interface SearchResult {
  matches: ScreenEntry[];
  /** How many screens matched in total, which may exceed `matches.length`. */
  totalMatches: number;
  shown: number;
}

export interface DictionaryStats {
  forms: number;
  published: number;
  entitySets: number;
  /** Entity sets with no EFORM row — published but undocumented. */
  entitySetsWithoutForm: number;
  /** Procedures and reports known from EXEC. */
  programs: number;
}

/**
 * Fold the variations a person actually types into one comparable form.
 *
 * Hebrew makes this load-bearing rather than cosmetic: Priority stores
 * `חשבוניות חו"ל` with an ASCII quote, while a Hebrew keyboard produces the
 * gershayim `״` (U+05F4) and a word processor may produce a right double
 * quotation mark. Comparing raw strings means a user searching `חו״ל` finds
 * nothing, with no hint as to why.
 */
function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[״“”″"]/g, '"')
    .replace(/[׳‘’′']/g, "'")
    .replace(/[‎‏‪-‮]/g, "") // bidi marks
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip the Hebrew inflection that makes a literal match fail.
 *
 * A person asks about `לחשבוניות` or `חשבונית`; Priority stores `חשבוניות`. Neither
 * is a typo and neither matches literally, so a search that only compares strings
 * finds nothing and the screen looks absent. Hebrew attaches prepositions and the
 * definite article directly to the word, so this is the common case rather than an
 * edge one.
 *
 * Deliberately shallow: one leading particle and one ending, and only on words
 * long enough that removing a letter still leaves something meaningful. Because
 * stemmed hits are scored BELOW literal ones, an over-eager rule here would
 * quietly outrank exact matches.
 */
function stemHebrew(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      let w = word;
      // ו/ה/ב/ל/מ/כ/ש plus the combinations that stack a particle on the article.
      const particle = /^(כשה|ומה|וכש|מה|שה|וה|ול|וב|ומ|וכ|ול|[ובלמכשה])(?=.{3,})/.exec(w);
      if (particle) w = w.slice(particle[1]!.length);
      // Number and gender endings — and no more than that.
      //
      // The set is deliberately shallow, and ־יות / ־ית are deliberately ABSENT.
      // Stripping them folded `חשבוניות` (invoices) and `חשבונות` (accounts) onto
      // the same stem, so a search for invoices returned the chart of accounts
      // first. Those are different words that merely share a root.
      //
      // Taking only ־ות and ־ת keeps them apart while still meeting in the
      // middle: `חשבוניות` → `חשבוני` and `חשבונית` → `חשבוני`, while
      // `חשבונות` → `חשבונ`. The lazy prefix is what picks the shorter ending
      // first, which is what makes that work.
      const ending = /^(.{3,}?)(ות|ים|יה|ה|ת)$/.exec(w);
      if (ending) w = ending[1]!;
      return w;
    })
    .join(" ");
}

interface IndexedEntry extends ScreenEntry {
  /** Pre-normalized haystack, built once at load rather than per search. */
  haystack: string;
  normScreen: string;
  normTitle: string;
  /** Inflection-stripped forms, for the fallback matching pass. */
  stemHaystack: string;
  stemTitle: string;
}

export class PriorityDictionary {
  private entries: IndexedEntry[] = [];
  /** Screens only. A program sharing a screen's name must not shadow it here. */
  private byScreen = new Map<string, IndexedEntry>();
  /** Programs by name; several kinds can share one name. */
  private byProgram = new Map<string, IndexedEntry[]>();
  private entitySetCount = 0;
  private withoutForm = 0;
  private programCount = 0;
  private loading: Promise<void> | undefined;
  /** child screen -> every screen that owns it as a sub-form, readable or not. */
  private childToParents = new Map<string, string[]>();

  /**
   * @param opts.cache Read and write the on-disk cache. Off in tests, which
   *   would otherwise load whatever installation the developer's .env points at
   *   instead of the rows the test supplied.
   */
  constructor(
    private readonly client: PriorityODataClient,
    private readonly opts: { cache?: boolean } = {},
  ) {}

  /** Load once per process; concurrent callers share the same in-flight load. */
  async ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const cached = readCache(installationBase());
    if (cached) {
      this.ingest(cached.sets, cached.forms, cached.programs);
      process.stderr.write(
        `[priority-mcp] dictionary from cache (${cached.forms.length} forms, ` +
          `${cached.programs.length} programs, age ${Math.round(cached.ageMs / 3600_000)}h)\n`,
      );
      return;
    }

    const started = Date.now();
    // Four things are needed, and none substitutes for another: EFORM says what
    // a screen MEANS, the service document says whether it can be QUERIED
    // DIRECTLY, FLINK_SUBFORM says which screens are children of which -- the
    // only way to tell a closed screen from one that is merely a sub-form -- and
    // EXEC names every procedure and report, which EFORM does not cover at all.
    //
    // Note the missing parent $select on EFORM. It is not an oversight: combining
    // a parent $select with $expand makes this server abort the response
    // mid-JSON, so the full EFORM row comes back and is trimmed below instead.
    // The nested $select inside the expand is safe and does keep the link rows
    // small. EXEC has no expand, so its $select is fine.
    //
    // EXEC is filtered to P and R with chained `or`, not `in`: this server refuses
    // `in` (HTTP 403). Measured: 9,229 rows, every one titled, in ~6 seconds.
    const [sets, raw, exec] = await Promise.all([
      this.client.entitySets(),
      this.client.query("EFORM", {
        expand: "FLINK_SUBFORM($select=FNAME)",
        pageSize: 500,
      }),
      this.client
        .query("EXEC", {
          select: ["ENAME", "TYPE", "TITLE", "MODULENAME"],
          filter: "TYPE eq 'P' or TYPE eq 'R'",
          pageSize: 500,
        })
        .catch((err: unknown) => {
          // Programs are an addition to the dictionary, not its basis. An
          // installation that closes EXEC still gets every screen.
          process.stderr.write(
            `[priority-mcp] EXEC not readable, programs will not be searchable: ` +
              `${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}\n`,
          );
          return [] as Record<string, unknown>[];
        }),
    ]);

    const programs = exec.map((r) => ({
      ENAME: r["ENAME"],
      TYPE: r["TYPE"],
      TITLE: r["TITLE"],
      MODULENAME: r["MODULENAME"],
    }));

    // Trim before caching: the un-selectable parent row carries every EFORM
    // column, which is a large amount of mostly-unused JSON on disk otherwise.
    const forms = raw.map((r) => ({
      ENAME: r["ENAME"],
      TITLE: r["TITLE"],
      TNAME: r["TNAME"],
      MODULENAME: r["MODULENAME"],
      FLINK_SUBFORM: (Array.isArray(r["FLINK_SUBFORM"]) ? r["FLINK_SUBFORM"] : [])
        .map((l) => ({ FNAME: (l as Record<string, unknown>)["FNAME"] }))
        .filter((l) => l.FNAME),
    }));

    process.stderr.write(
      `[priority-mcp] dictionary fetched in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(${forms.length} forms, ${programs.length} programs)\n`,
    );

    this.ingest(sets, forms, programs);
    if (this.opts.cache !== false) writeCache(installationBase(), sets, forms, programs);
  }

  private ingest(sets: string[], forms: Record<string, unknown>[], programs: Record<string, unknown>[]): void {
    const published = new Set(sets);
    this.entitySetCount = sets.length;

    // child -> parents, from EFORM's own link rows. Built first because a
    // screen's access depends on whether anything readable owns it.
    for (const row of forms) {
      const parent = str(row["ENAME"]);
      if (!parent) continue;
      const links = Array.isArray(row["FLINK_SUBFORM"]) ? row["FLINK_SUBFORM"] : [];
      for (const link of links) {
        const child = str((link as Record<string, unknown>)["FNAME"]);
        if (!child || child === parent) continue;
        const list: string[] = this.childToParents.get(child) ?? [];
        if (!list.includes(parent)) list.push(parent);
        this.childToParents.set(child, list);
      }
    }

    const seen = new Set<string>();
    for (const row of forms) {
      const screen = str(row["ENAME"]);
      if (!screen) continue;
      seen.add(screen);

      const title = str(row["TITLE"]);
      const table = str(row["TNAME"]);
      const module = str(row["MODULENAME"]);
      // Exact, case-sensitive membership. Ten screen names on the reference
      // server differ from another only by letter case (DOCUMENTS_E vs
      // DOCUMENTS_e, TRANSORDER_Q vs TRANSORDER_q), and case-folding here
      // would silently merge them.
      const isPublished = published.has(screen);
      // Only parents that can themselves be read are worth naming: routing a
      // caller to a parent that is also closed just moves the dead end.
      const readableParents = (this.childToParents.get(screen) ?? []).filter((p) => published.has(p));
      const entry: IndexedEntry = {
        screen,
        title,
        table,
        module,
        published: isPublished,
        access: isPublished ? "direct" : readableParents.length ? "via-parent" : "unavailable",
        ...(!isPublished && readableParents.length ? { parents: readableParents } : {}),
        kind: "F",
        haystack: normalize([screen, title, table, module].filter(Boolean).join(" ")),
        normScreen: normalize(screen),
        normTitle: normalize(title ?? ""),
        stemHaystack: stemHebrew(normalize([screen, title, table, module].filter(Boolean).join(" "))),
        stemTitle: stemHebrew(normalize(title ?? "")),
      };
      this.entries.push(entry);
      this.byScreen.set(screen, entry);
    }

    // Entity sets Priority publishes but EFORM does not describe. Rare, but a
    // caller searching only the dictionary would never see them.
    for (const name of sets) {
      if (seen.has(name)) continue;
      this.withoutForm++;
      const entry: IndexedEntry = {
        screen: name,
        title: null,
        table: null,
        module: null,
        published: true,
        access: "direct",
        kind: "F",
        haystack: normalize(name),
        normScreen: normalize(name),
        normTitle: "",
        stemHaystack: stemHebrew(normalize(name)),
        stemTitle: "",
      };
      this.entries.push(entry);
      this.byScreen.set(name, entry);
    }

    // Procedures and reports. They share the index and the scoring so a search
    // for "טריגרים" can surface FORMTRIGREP, but they are kept OUT of byScreen:
    // FORMMSG the report must not answer a get() for FORMMSG the screen.
    for (const row of programs) {
      const name = str(row["ENAME"]);
      const type = str(row["TYPE"]);
      if (!name || (type !== "P" && type !== "R")) continue;
      const title = str(row["TITLE"]);
      const module = str(row["MODULENAME"]);
      const entry: IndexedEntry = {
        screen: name,
        title,
        table: null,
        module,
        published: false,
        access: "program",
        kind: type,
        haystack: normalize([name, title, module].filter(Boolean).join(" ")),
        normScreen: normalize(name),
        normTitle: normalize(title ?? ""),
        stemHaystack: stemHebrew(normalize([name, title, module].filter(Boolean).join(" "))),
        stemTitle: stemHebrew(normalize(title ?? "")),
      };
      this.entries.push(entry);
      const list = this.byProgram.get(name) ?? [];
      list.push(entry);
      this.byProgram.set(name, list);
      this.programCount++;
    }
  }

  stats(): DictionaryStats {
    const screens = this.entries.filter((e) => e.kind === "F");
    return {
      forms: screens.length - this.withoutForm,
      published: screens.filter((e) => e.published).length,
      entitySets: this.entitySetCount,
      entitySetsWithoutForm: this.withoutForm,
      programs: this.programCount,
    };
  }

  /** Exact, case-sensitive lookup of a SCREEN. Programs are found with getProgram. */
  get(screen: string): ScreenEntry | undefined {
    return this.byScreen.get(screen);
  }

  /**
   * Procedures and reports by exact name. Program names are case-insensitive in
   * Priority (unlike screen names), so the lookup folds case. Several may come
   * back: pass `type` to pick one kind.
   */
  getProgram(name: string, type?: "P" | "R"): ScreenEntry[] {
    const wanted = name.trim().toUpperCase();
    const hits = this.byProgram.get(wanted) ?? [];
    return strip(type ? hits.filter((h) => h.kind === type) : hits);
  }

  /** Every entry, for whole-dictionary analysis rather than search. */
  allEntries(): ScreenEntry[] {
    return strip(this.entries);
  }

  /**
   * Published screens that might be the parent of `child`, best guess first.
   *
   * The declared parents come first and are not guesses: EFORM's FLINK_SUBFORM
   * states the parent/child graph outright. `FLINK` is not an entity set of its
   * own (that route answers 404, which is what once made this look impossible),
   * but expanding it off EFORM works and costs one request at load.
   *
   * The heuristic below it survives as a fallback for children the graph does not
   * mention: a sub-form and its parent are defined together and share a module,
   * and a shared table is tighter still.
   */
  candidateParents(child: ScreenEntry, limit = 15): string[] {
    const declared = (this.childToParents.get(child.screen) ?? []).filter(
      (p) => this.byScreen.get(p)?.published,
    );

    const sameTable: string[] = [];
    const sameModule: string[] = [];
    for (const e of this.entries) {
      if (!e.published || e.screen === child.screen || declared.includes(e.screen)) continue;
      if (child.table && e.table === child.table) sameTable.push(e.screen);
      else if (child.module && e.module === child.module) sameModule.push(e.screen);
    }
    return [...declared, ...sameTable, ...sameModule].slice(0, limit);
  }

  /**
   * Rank matches so the most likely intent comes first.
   *
   * Ordering matters more than it looks: a search for `מלאי` can match a hundred
   * screens, and the caller sees only the first `limit` of them. An exact name or
   * title match must therefore outrank an incidental mention in a module name.
   */
  search(
    query: string,
    opts: { limit?: number; onlyReadable?: boolean; kinds?: ("F" | "P" | "R")[] } = {},
  ): SearchResult {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    const onlyReadable = opts.onlyReadable !== false;
    // Screens only by default. Programs were added to the index later, and a
    // caller who learned the tool as a screen search must keep getting exactly
    // the results it got before -- 9,229 programs would otherwise dilute every
    // query that did not ask for them.
    const kinds = new Set<string>(opts.kinds?.length ? opts.kinds : ["F"]);
    const q = normalize(query);

    // The default filter is "readable", not "published". Those differ by
    // thousands of screens: every sub-form is absent from the service document,
    // so filtering on `published` hid child screens completely and a caller
    // searching for one was told it did not exist.
    const pool = this.entries.filter(
      (e) => kinds.has(e.kind) && (!onlyReadable || e.access !== "unavailable"),
    );

    if (!q) {
      return {
        matches: strip(pool.slice(0, limit)),
        totalMatches: pool.length,
        shown: Math.min(limit, pool.length),
      };
    }

    // Stemmed matching is a FALLBACK tier, never a replacement: every literal
    // match outranks every inflected one, so loosening the rule cannot reorder
    // results that already matched exactly.
    const qs = stemHebrew(q);
    const scored: { entry: IndexedEntry; score: number }[] = [];
    for (const entry of pool) {
      let score = 0;
      if (entry.normScreen === q || entry.normTitle === q) score = 100;
      else if (entry.normScreen.startsWith(q) || entry.normTitle.startsWith(q)) score = 80;
      // A title that BEGINS with the term is about the term; a title that merely
      // contains it is usually about something else that refers to it. Measured:
      // searching `חשבונית` put `סטטוסים לחשבונית`, `לוג...` and three more
      // qualifier screens above `חשבוניות מס`, because they contain the singular
      // literally while the invoice screen only matches after stemming. Ranking
      // the head noun above a mid-phrase mention fixes that without needing the
      // inflection to match exactly.
      else if (entry.stemTitle.startsWith(qs)) score = 70;
      else if (entry.normTitle.includes(q)) score = 60;
      else if (entry.normScreen.includes(q)) score = 50;
      else if (entry.stemTitle.includes(qs)) score = 40;
      else if (entry.haystack.includes(q)) score = 20;
      else if (entry.stemHaystack.includes(qs)) score = 15;

      // A top-level screen outranks a sub-form. Measured need: searching
      // `חשבונית` returned AINVOICESCONT, CINVOICESCONT and three more
      // "חשבונית - פרטים נוספים" sub-forms before AINVOICES itself, because the
      // singular appears literally in the qualifier titles while the main screen
      // only matches after stemming. Sub-forms outnumber top-level screens, so
      // without this they crowd out the answer.
      //
      // The bonus is a full tier so it can overturn that, but it is added to the
      // score rather than applied as a tie-break, which keeps an exact title
      // match on a sub-form ahead of a merely-stemmed match on a screen.
      if (score > 0 && entry.access === "direct") score += 25;
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score || a.entry.screen.localeCompare(b.entry.screen));

    return {
      matches: strip(scored.slice(0, limit).map((s) => s.entry)),
      totalMatches: scored.length,
      shown: Math.min(limit, scored.length),
    };
  }
}

/** Drop the internal index fields before handing entries to a caller. */
function strip(entries: IndexedEntry[]): ScreenEntry[] {
  return entries.map(({ screen, title, table, module, published, access, parents, kind }) => ({
    screen,
    title,
    table,
    module,
    published,
    access,
    ...(parents ? { parents } : {}),
    kind,
  }));
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

// ---------------------------------------------------------------------------
// On-disk cache
// ---------------------------------------------------------------------------

// This server runs over stdio, which means it is spawned fresh for every client
// session -- a new process each time a client connects. Paying the full
// dictionary fetch on every spawn would put that latency in front of the user's
// first question, every time. The dictionary is a schema, not data: it changes
// when someone edits a form, not when an invoice is issued, so a day-old copy is
// as good as a new one.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One cache file per INSTALLATION, shared by every company on it.
 *
 * The dictionary is not company data. Screen definitions, column titles and help
 * live at the tabula.ini level, so every company on one installation sees exactly
 * the same forms -- switching company changes the DATA and nothing else.
 *
 * An earlier version keyed this per company, on the reasoning that one company's
 * screen list must never be served under another's name. That reasoning is sound
 * and the premise was wrong: there is only one screen list. Keying per company
 * bought nothing and cost a full re-fetch for every company a session touched.
 */
function cacheFileFor(installationUrl: string): string {
  const slug = createHash("sha1").update(installationUrl).digest("hex").slice(0, 12);
  return path.join(PROJECT_DIR, `.dictionary-cache.${slug}.json`);
}

interface CacheFile {
  // Bumped to 2 when the parent/child graph was added: a v1 cache has no link
  // rows, so every child screen would silently look `unavailable` until the TTL
  // expired. Bumped to 3 when procedures and reports were added from EXEC: a v2
  // cache has no programs, so a search for them would find nothing for a day.
  version: 3;
  fetchedAt: number;
  /** Which installation this was fetched from -- another one's cache is wrong. */
  source: string;
  sets: string[];
  forms: Record<string, unknown>[];
  programs: Record<string, unknown>[];
}

function readCache(
  sourceUrl: string,
): { sets: string[]; forms: Record<string, unknown>[]; programs: Record<string, unknown>[]; ageMs: number } | null {
  try {
    const file = cacheFileFor(sourceUrl);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile;
    if (parsed.version !== 3) return null;
    // Keyed to the connection: pointing .env at another installation must not
    // serve that installation's screen names.
    if (parsed.source !== sourceUrl) return null;
    const ageMs = Date.now() - parsed.fetchedAt;
    if (ageMs > CACHE_TTL_MS || ageMs < 0) return null;
    if (!Array.isArray(parsed.sets) || !Array.isArray(parsed.forms) || !Array.isArray(parsed.programs)) return null;
    return { sets: parsed.sets, forms: parsed.forms, programs: parsed.programs, ageMs };
  } catch {
    // A corrupt cache must never break startup -- refetching is always correct.
    return null;
  }
}

function writeCache(
  sourceUrl: string,
  sets: string[],
  forms: Record<string, unknown>[],
  programs: Record<string, unknown>[],
): void {
  try {
    const payload: CacheFile = {
      version: 3,
      fetchedAt: Date.now(),
      source: sourceUrl,
      sets,
      forms,
      programs,
    };
    fs.writeFileSync(cacheFileFor(sourceUrl), JSON.stringify(payload), "utf8");
  } catch {
    // Best effort. A read-only directory costs a slow start, not a failure.
  }
}

// The cache is keyed on the INSTALLATION URL -- the base without the company.
// That is the identity of a dictionary: every company on one tabula.ini shares
// the same screen definitions, titles and help, and only the data differs.
