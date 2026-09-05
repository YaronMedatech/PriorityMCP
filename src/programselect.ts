import type { CatalogEntry } from "./programs.js";
import type { PriorityDictionary } from "./dictionary.js";

// Which programs this server may run, and how a name turns into one.
//
// Two policies, chosen per installation in .env:
//
//   catalog (default)  only the programs in programs.json. Priority cannot
//                      enumerate runnable programs over the API, so the catalog
//                      is both the safety gate AND the discovery surface.
//   all                any entity EXEC lists as a procedure (P) or a report (R)
//                      -- 9,229 of them on the reference installation.
//
// Opening it up is a real change in what this server can do to an ERP, which is
// why it is a flag and not a default: a procedure can post, delete and upgrade,
// and KAR_EXECUPGRADES runs a live DBI upgrade if handed a file path. The
// catalog stays useful either way -- it carries the operator's own description
// and notes, and those are attached to the reply when the program is in it.
//
// What does NOT change with the policy: an unknown name is still refused (the
// dictionary is checked, so a typo cannot become a run), a first call without
// inputs still only reports parameters, a choice is still never made here, and
// a deny list still wins over everything.

export type ProgramPolicy = "catalog" | "all";

export interface ResolvedProgram {
  name: string;
  type: "P" | "R";
  /**
   * The same name of the OTHER kind, when Priority has one.
   *
   * Worth carrying even on success: measured on BUDREPDET, the report answers
   * `No values in report.` while the procedure of the same name is the one with
   * the input dialog that produces them. A model that only sees the empty report
   * reports failure; one that is told the twin exists can go and look.
   */
  twin?: ProgramCandidate;
  /** Hebrew title from EXEC, when the dictionary knows it. */
  title: string | null;
  /** Where the permission came from. */
  source: "catalog" | "dictionary";
  /** The operator's own notes, when the program is catalogued. */
  catalogEntry?: CatalogEntry;
  /** Present when nothing is documented about this program here. */
  caution?: string;
  /**
   * True for a report, and for a PROCEDURE Priority marks as one with
   * EPROG.RS='R'. The second half is what makes this worth carrying: the
   * program tools warn that a procedure can change data, and on the
   * installation this was measured against a third of them are reports, for
   * which that warning is false and discourages a harmless read.
   */
  reportLike?: boolean;
  /**
   * How a Priority user reaches it: menu, program, document. An empty array
   * means nothing links to it, so no one can run it from the UI -- worth saying
   * before running it here. Absent means EREP/EPROG could not be read.
   */
  reachableFrom?: ("menu" | "program" | "document")[];
}

export interface ProgramCandidate {
  name: string;
  type: string;
  title: string | null;
}

export interface ProgramRefusal {
  refused: true;
  reason: string;
  /**
   * The choices behind an ambiguous or mistyped name, as DATA.
   *
   * A refusal used to be prose only, so a model that hit `BUDREPDET exists as
   * both a procedure and a report` had to parse a sentence to offer the user a
   * choice. These are the same facts in a shape it can put on screen.
   */
  candidates?: ProgramCandidate[];
  /** Programs whose name is close to what was asked for. */
  didYouMean?: ProgramCandidate[];
  available?: string[];
}

export function loadProgramPolicy(env: NodeJS.ProcessEnv = process.env): ProgramPolicy {
  const raw = (env["PRIORITY_ALLOW_ALL_PROGRAMS"] ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "all"].includes(raw) ? "all" : "catalog";
}

/** Names the operator has blocked outright, upper-cased. Wins over everything. */
export function loadProgramDenyList(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env["PRIORITY_PROGRAMS_DENY"] ?? "")
      .split(/[;,]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Turn a requested name into a program this server will run, or a refusal that
 * says why and what to do instead.
 *
 * @param type Which kind, when the caller knows. One name can be BOTH a
 *   procedure and a report -- FORMMSG is -- and running the wrong one is a
 *   different action, so an ambiguous name is refused rather than guessed.
 */
export function resolveProgram(
  name: string,
  opts: {
    policy: ProgramPolicy;
    deny: Set<string>;
    catalog: CatalogEntry[];
    dict: PriorityDictionary;
    type?: "P" | "R";
  },
): ResolvedProgram | ProgramRefusal {
  const wanted = name.trim();
  const upper = wanted.toUpperCase();

  if (opts.deny.has(upper)) {
    return {
      refused: true,
      reason:
        `'${wanted}' is on this server's deny list (PRIORITY_PROGRAMS_DENY) and will not be ` +
        `run whatever the policy. Report that to the user; do not look for another way to run it.`,
    };
  }

  // Program names are case-insensitive in Priority, unlike screen names.
  const catalogued = opts.catalog.find((p) => p.name.trim().toUpperCase() === upper);
  const known = opts.dict.getProgram(wanted, opts.type);

  if (catalogued && (!opts.type || catalogued.type === opts.type)) {
    const known0 = opts.dict.getProgram(catalogued.name, catalogued.type)[0];
    return {
      name: catalogued.name,
      type: catalogued.type,
      title: known0?.title ?? null,
      source: "catalog",
      reportLike: catalogued.type === "R" || known0?.rs === "R",
      ...(known0?.reachableFrom ? { reachableFrom: known0.reachableFrom } : {}),
      catalogEntry: catalogued,
      ...twinOf(catalogued.name, catalogued.type, opts.dict),
    };
  }

  if (opts.policy === "catalog") {
    const refusal: ProgramRefusal = {
      refused: true,
      reason:
        `'${wanted}' is not in the program catalog, so this server will not run it: it has ` +
        `no way to know the program's parameters or what running it would do. ` +
        (known.length
          ? `It DOES exist in Priority (${known.map((k) => `${k.kind}: ${k.title ?? "?"}`).join("; ")}), ` +
            `so the operator can add it to programs.json. `
          : `No procedure or report of that name exists either. `) +
        `Report this rather than trying a different name.`,
      available: opts.catalog.map((p) => `${p.name} (${p.type}) — ${p.description}`),
    };
    return refusal;
  }

  // policy 'all': the dictionary decides. A name it does not know is a typo, and
  // sending it to Priority anyway just gets "No such Tabula Entity" one round
  // trip later, with no hint of what was meant.
  if (known.length === 0) {
    const near = nearMatches(wanted, opts.dict);
    return {
      refused: true,
      reason:
        `Priority has no procedure or report named '${wanted}'. Names are matched ` +
        `case-insensitively, so this is not a capitalisation problem. ` +
        (near.length ? `Close names are listed in 'didYouMean'. ` : ``) +
        `Find the right one with search_screens{kinds:['P','R']} rather than guessing.`,
      ...(near.length ? { didYouMean: near } : {}),
    };
  }
  if (known.length > 1) {
    return {
      refused: true,
      reason:
        `'${wanted}' exists as BOTH a procedure and a report, and they are different ` +
        `things to run: the report renders output, the procedure can act. Show the user ` +
        `'candidates' and pass type:'P' or type:'R' with their answer. A common Priority ` +
        `pattern is a report that only displays what its procedure twin prepares.`,
      candidates: known.map((k) => ({ name: k.screen, type: k.kind, title: k.title })),
    };
  }

  const entry = known[0]!;
  return {
    name: entry.screen,
    type: entry.kind as "P" | "R",
    title: entry.title,
    source: "dictionary",
    reportLike: entry.kind === "R" || entry.rs === "R",
    ...(entry.reachableFrom ? { reachableFrom: entry.reachableFrom } : {}),
    ...twinOf(entry.screen, entry.kind, opts.dict),
    caution:
      `This program is NOT in the operator's catalog, so nothing is recorded here about ` +
      `what it does or what its parameters mean — only Priority's own title ` +
      `(${entry.title ?? "untitled"}). Read help{name:'${entry.screen}', type:'${entry.kind}'} ` +
      `first, and for a procedure (P) tell the user what you are about to run and why ` +
      `before you supply any inputs: supplying them is what makes it act.`,
  };
}

/** Programs whose name starts with, contains, or is contained by the request. */
function nearMatches(wanted: string, dict: PriorityDictionary) {
  const q = wanted.toUpperCase();
  const out: { name: string; type: string; title: string | null }[] = [];
  for (const e of dict.allEntries()) {
    if (e.kind === "F") continue;
    const n = e.screen.toUpperCase();
    if (n.startsWith(q) || n.includes(q) || (q.length > 3 && q.includes(n))) {
      out.push({ name: e.screen, type: e.kind, title: e.title });
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** The same program name of the other kind, if Priority has one. */
function twinOf(
  name: string,
  kind: string,
  dict: PriorityDictionary,
): { twin: ProgramCandidate } | Record<string, never> {
  const other = dict.getProgram(name).find((p) => p.kind !== kind);
  return other ? { twin: { name: other.screen, type: other.kind, title: other.title } } : {};
}
