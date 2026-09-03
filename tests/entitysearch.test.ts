// Procedures and reports in the dictionary, offline.
//
// The invariants that matter: adding programs must not change what a screen
// search returns, a program must never answer a screen lookup of the same name,
// and one name that is a screen, a report AND a procedure must come back as
// three entries with three kinds.
import type { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { buildReadiness } from "../src/readiness.js";
import { searchScreens } from "../src/discovery.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

// FORMMSG is real: on the reference installation it is a screen (child of
// EFORM), a report and a procedure. The other names are real screens and
// programs with their real titles.
const forms = [
  { ENAME: "EFORM", TITLE: "מחולל מסכים", TNAME: "EXEC", MODULENAME: "מחולל מסכים", FLINK_SUBFORM: [{ FNAME: "FORMMSG" }] },
  { ENAME: "FORMMSG", TITLE: "הודעות שגיאה/אזהרה למסך", TNAME: "FORMMSG", MODULENAME: "מחולל מסכים", FLINK_SUBFORM: [] },
  { ENAME: "AINVOICES", TITLE: "חשבוניות מס", TNAME: "INVOICES", MODULENAME: "חשבוניות לקוח", FLINK_SUBFORM: [] },
  { ENAME: "ORPHAN", TITLE: "מסך יתום", TNAME: "ORPHAN", MODULENAME: "x", FLINK_SUBFORM: [] },
];
const exec = [
  { ENAME: "FORMTRIGREP", TYPE: "R", TITLE: "הפעלות מסך", MODULENAME: "מחולל מסכים" },
  { ENAME: "FORMMSG", TYPE: "R", TITLE: "הודעות שגיאה/אזהרה למסך", MODULENAME: "מחולל מסכים" },
  { ENAME: "FORMMSG", TYPE: "P", TITLE: "הודעות שגיאה/אזהרה למסך", MODULENAME: "מחולל מסכים" },
  { ENAME: "FORMTREE", TYPE: "P", TITLE: "עץ מסכים", MODULENAME: "מחולל מסכים" },
  { ENAME: "WEIRD", TYPE: "M", TITLE: "תפריט", MODULENAME: "x" }, // must be ignored: not P/R
];
const sets = ["EFORM", "AINVOICES"];

const calls: string[] = [];
const fake = {
  entitySets: async () => sets,
  query: async (entity: string, opts: { filter?: string; select?: string[] }) => {
    calls.push(`${entity}${opts.filter ? ` ${opts.filter}` : ""}`);
    if (entity === "EFORM") return forms;
    if (entity === "EXEC") return exec;
    throw new Error(`unexpected entity ${entity}`);
  },
} as unknown as PriorityODataClient;

const dict = new PriorityDictionary(fake, { cache: false });
await dict.ready();

console.log("\n1. Loading");
if (calls.some((c) => c.startsWith("EXEC") && c.includes("TYPE eq 'P' or TYPE eq 'R'"))) {
  ok("EXEC is read with chained or, not `in`");
} else bad(`EXEC call: ${JSON.stringify(calls)}`);
const stats = dict.stats();
if (stats.forms === 4) ok(`forms counted over screens only (${stats.forms})`);
else bad(`forms=${stats.forms}`);
if (stats.programs === 4) ok(`programs counted (${stats.programs}); the M row was ignored`);
else bad(`programs=${stats.programs}`);

console.log("\n2. A screen search is unchanged by the programs");
const screensOnly = dict.search("הודעות", {});
if (screensOnly.matches.every((m) => m.kind === "F")) ok("default search returns screens only");
else bad(`kinds in default search: ${screensOnly.matches.map((m) => m.kind).join(",")}`);
if (screensOnly.matches.some((m) => m.screen === "FORMMSG" && m.kind === "F")) ok("the FORMMSG screen is found");
else bad("FORMMSG screen missing from screen search");

console.log("\n3. Programs are searchable when asked for");
const progs = dict.search("הודעות", { kinds: ["P", "R"] });
const kinds = progs.matches.filter((m) => m.screen === "FORMMSG").map((m) => m.kind).sort();
if (JSON.stringify(kinds) === '["P","R"]') ok("FORMMSG comes back twice, once per program kind");
else bad(`FORMMSG program kinds: ${JSON.stringify(kinds)}`);
if (progs.matches.every((m) => m.access === "program" && !m.published)) ok("programs carry access='program'");
else bad("a program has screen-style access");
const trig = dict.search("טריגר", { kinds: ["R"] });
const everything = dict.search("הפעלות מסך", { kinds: ["F", "P", "R"] });
if (everything.matches[0]?.screen === "FORMTRIGREP" && everything.matches[0]?.kind === "R") {
  ok("an exact program title ranks first in an all-kinds search");
} else bad(`all-kinds top: ${JSON.stringify(everything.matches[0])}`);
console.log(`   (stemmed 'טריגר' -> ${trig.totalMatches} report(s); titles do not contain the word, so 0 is correct)`);

console.log("\n4. Lookups keep screens and programs apart");
const got = dict.get("FORMMSG");
if (got?.kind === "F" && got.table === "FORMMSG") ok("get('FORMMSG') is the SCREEN");
else bad(`get('FORMMSG') = ${JSON.stringify(got)}`);
const both = dict.getProgram("formmsg");
if (both.length === 2 && both.every((p) => p.kind !== "F")) ok("getProgram folds case and returns both program kinds");
else bad(`getProgram: ${JSON.stringify(both)}`);
if (dict.getProgram("FORMMSG", "R").length === 1) ok("getProgram with a type returns one");
else bad("type filter on getProgram failed");
if (dict.get("FORMTRIGREP") === undefined) ok("a report is not a screen: get() returns undefined");
else bad("get() returned a program");

console.log("\n5. search_screens decorates programs with runnable");
type ProgRow = { screen: string; kind: string; runnable?: boolean; documented?: boolean; catalogNote?: string };
const out = (await searchScreens(dict, { query: "הודעות", kinds: ["P", "R"] }, undefined, undefined, {
  catalogued: new Set(["FORMMSG"]),
  policy: "catalog",
})) as { screens: ProgRow[]; notes: string[] };
const p = out.screens.find((s) => s.screen === "FORMMSG" && s.kind === "P");
const r = out.screens.find((s) => s.screen === "FORMMSG" && s.kind === "R");
if (p?.runnable === true && r?.runnable === true) ok("catalogued programs are runnable");
else bad(`runnable flags: ${JSON.stringify([p, r])}`);
const plain = (await searchScreens(dict, { query: "עץ", kinds: ["P"] })) as {
  screens: ProgRow[];
  notes: string[];
};
const tree = plain.screens.find((s) => s.screen === "FORMTREE");
if (tree?.runnable === false && tree.documented === false && /will not run it/.test(tree.catalogNote ?? "")) {
  ok("under the catalog policy an uncatalogued program is runnable:false and says so");
} else bad(`FORMTREE: ${JSON.stringify(tree)}`);

// The regression this pair exists for: with the policy open, EVERY program is
// runnable, and reporting runnable:false because it lacks notes told a model
// "cannot be run" about a program run_program would happily run.
const open = (await searchScreens(dict, { query: "עץ", kinds: ["P"] }, undefined, undefined, {
  catalogued: new Set(["FORMMSG"]),
  policy: "all",
})) as { screens: ProgRow[]; notes: string[] };
const treeOpen = open.screens.find((s) => s.screen === "FORMTREE");
if (treeOpen?.runnable === true && treeOpen.documented === false && /Runnable, but not in programs.json/.test(treeOpen.catalogNote ?? "")) {
  ok("with the policy open it is runnable:true, documented:false");
} else bad(`FORMTREE open: ${JSON.stringify(treeOpen)}`);
if (open.notes.some((n) => /runs ANY procedure or report/.test(n))) ok("the note explains the open policy rather than the catalog rule");
else bad("open-policy note missing");
const msgOpen = open.screens.find((s) => s.screen === "FORMMSG");
if (msgOpen === undefined || (msgOpen.runnable === true && msgOpen.documented === true)) ok("a catalogued program is documented:true");
else bad(`FORMMSG open: ${JSON.stringify(msgOpen)}`);
if (plain.notes.some((n) => /programs/.test(n) && /help/.test(n))) ok("the reply explains programs and points at help");
else bad("no program note");
const screensReply = (await searchScreens(dict, { query: "חשבוניות" })) as { screens: { kind: string; runnable?: boolean }[] };
if (screensReply.screens.every((s) => s.kind === "F" && s.runnable === undefined)) ok("screen results are untouched");
else bad("screen results were decorated");

console.log("\n6. readiness counts screens and programs separately");
const rr = buildReadiness(dict, undefined, new Set(["FORMMSG"]));
if (rr.totals.screens === 4) ok(`totals.screens stays ${rr.totals.screens}`);
else bad(`totals.screens=${rr.totals.screens}`);
if (rr.totals.programs === 4 && rr.totals.documentedPrograms === 2) ok("programs=4, documented=2 (FORMMSG as P and as R)");
else bad(`programs=${rr.totals.programs} documented=${rr.totals.documentedPrograms}`);
const issue = rr.issues.find((i) => i.kind === "uncatalogued-programs");
if (issue && issue.count === 2 && issue.severity === "low") ok("uncatalogued-programs reported as low severity with the right count");
else bad(`issue: ${JSON.stringify(issue)}`);

console.log(failures === 0 ? "\nAll entity-search checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
