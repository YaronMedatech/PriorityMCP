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
  /** Hebrew title from EXEC, when the dictionary knows it. */
  title: string | null;
  /** Where the permission came from. */
  source: "catalog" | "dictionary";
  /** The operator's own notes, when the program is catalogued. */
  catalogEntry?: CatalogEntry;
  /** Present when nothing is documented about this program here. */
  caution?: string;
}

export interface ProgramRefusal {
  refused: true;
  reason: string;
  /** Programs whose name is close to what was asked for. */
  didYouMean?: { name: string; type: string; title: string | null }[];
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
    return {
      name: catalogued.name,
      type: catalogued.type,
      title: opts.dict.getProgram(catalogued.name, catalogued.type)[0]?.title ?? null,
      source: "catalog",
      catalogEntry: catalogued,
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
        `'${wanted}' exists as BOTH a procedure and a report ` +
        `(${known.map((k) => `${k.kind}: ${k.title ?? "?"}`).join("; ")}), and they are ` +
        `different things to run. Pass type:'P' or type:'R' to say which you mean.`,
    };
  }

  const entry = known[0]!;
  return {
    name: entry.screen,
    type: entry.kind as "P" | "R",
    title: entry.title,
    source: "dictionary",
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
