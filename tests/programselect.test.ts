// Which programs may be run, under each policy. Offline.
//
// The 'all' policy removes the only thing that stood between a model and
// KAR_EXECUPGRADES, so what remains has to be pinned: an unknown name is still
// refused, an ambiguous one is still refused, the deny list still wins, and a
// program with no documentation says so.
import type { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { loadProgramDenyList, loadProgramPolicy, resolveProgram } from "../src/programselect.js";
import type { CatalogEntry } from "../src/programs.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL ${m}`); };

const forms = [{ ENAME: "AINVOICES", TITLE: "חשבוניות מס", TNAME: "INVOICES", MODULENAME: "x", FLINK_SUBFORM: [] }];
const exec = [
  { ENAME: "FORMTRIGREP", TYPE: "R", TITLE: "הפעלות מסך", MODULENAME: "מחולל מסכים" },
  { ENAME: "FORMMSG", TYPE: "R", TITLE: "הודעות", MODULENAME: "מחולל מסכים" },
  { ENAME: "FORMMSG", TYPE: "P", TITLE: "הודעות", MODULENAME: "מחולל מסכים" },
  { ENAME: "KAR_EXECUPGRADES", TYPE: "P", TITLE: "ביצוע שדרוגים", MODULENAME: "תחזוקה" },
  { ENAME: "WWWSHOWPRICE", TYPE: "P", TITLE: "מחירון", MODULENAME: "מכירות" },
];
const fake = {
  entitySets: async () => ["AINVOICES"],
  query: async (e: string) => (e === "EFORM" ? forms : exec),
} as unknown as PriorityODataClient;
const dict = new PriorityDictionary(fake, { cache: false });
await dict.ready();

const catalog: CatalogEntry[] = [
  { name: "FORMTRIGREP", type: "R", description: "דוח טריגרים", notes: "read-only" },
];
const base = { deny: new Set<string>(), catalog, dict };

console.log("\n1. Reading the policy and the deny list");
if (loadProgramPolicy({}) === "catalog") ok("default policy is catalog");
else bad("default is not catalog");
for (const v of ["1", "true", "yes", "all", "ALL"]) {
  if (loadProgramPolicy({ PRIORITY_ALLOW_ALL_PROGRAMS: v }) === "all") ok(`'${v}' -> all`);
  else bad(`'${v}' did not open the policy`);
}
if (loadProgramPolicy({ PRIORITY_ALLOW_ALL_PROGRAMS: "0" }) === "catalog") ok("'0' stays on catalog");
else bad("'0' opened the policy");
const deny = loadProgramDenyList({ PRIORITY_PROGRAMS_DENY: "kar_execupgrades; WWWSHOWPRICE ,x" });
if (deny.has("KAR_EXECUPGRADES") && deny.has("WWWSHOWPRICE") && deny.size === 3) ok("deny list splits on , and ; and upper-cases");
else bad([...deny].join("|"));

console.log("\n2. Catalog policy: only the catalogued ones");
let r = resolveProgram("formtrigrep", { ...base, policy: "catalog" });
if (!("refused" in r) && r.name === "FORMTRIGREP" && r.source === "catalog" && r.catalogEntry?.notes === "read-only") ok("a catalogued program resolves, case-insensitively, with its notes");
else bad(JSON.stringify(r).slice(0, 200));
if (!("refused" in r) && r.title === "הפעלות מסך") ok("the Hebrew title comes from the dictionary");
else bad("no title");
r = resolveProgram("KAR_EXECUPGRADES", { ...base, policy: "catalog" });
if ("refused" in r && /DOES exist in Priority/.test(r.reason) && /programs\.json/.test(r.reason)) ok("an uncatalogued program is refused, and the refusal says it exists");
else bad(JSON.stringify(r).slice(0, 200));

console.log("\n3. All policy: anything Priority has");
r = resolveProgram("KAR_EXECUPGRADES", { ...base, policy: "all" });
if (!("refused" in r) && r.type === "P" && r.source === "dictionary" && r.caution) ok(`KAR_EXECUPGRADES runs, marked source=dictionary with a caution`);
else bad(JSON.stringify(r).slice(0, 200));
if (!("refused" in r) && /CHANGE|help\{/.test(r.caution ?? "") === false) bad("the caution does not tell the model to read help");
else ok("the caution names help{} and the program's title");
r = resolveProgram("FORMTRIGREP", { ...base, policy: "all" });
if (!("refused" in r) && r.source === "catalog" && !r.caution) ok("a catalogued program still resolves via the catalog, with no caution");
else bad(JSON.stringify(r).slice(0, 200));

console.log("\n4. What 'all' does NOT loosen");
r = resolveProgram("FORMTRIGRE", { ...base, policy: "all" });
if ("refused" in r && /no procedure or report named/.test(r.reason) && r.didYouMean?.some((d) => d.name === "FORMTRIGREP")) ok("a typo is refused, with the near match offered");
else bad(JSON.stringify(r).slice(0, 250));
r = resolveProgram("FORMMSG", { ...base, policy: "all" });
if ("refused" in r && /BOTH a procedure and a report/.test(r.reason)) ok("a name that is both P and R is refused until the type is given");
else bad(JSON.stringify(r).slice(0, 200));
if ("refused" in r && r.candidates?.length === 2 && r.candidates.every((c) => c.name === "FORMMSG" && c.title)) {
  ok("the refusal carries the choice as DATA, not only as prose");
} else bad(`candidates: ${JSON.stringify("refused" in r ? r.candidates : null)}`);
r = resolveProgram("FORMMSG", { ...base, policy: "all", type: "P" });
if (!("refused" in r) && r.type === "P") ok("with type:'P' it resolves to the procedure");
else bad(JSON.stringify(r).slice(0, 200));
if (!("refused" in r) && r.twin?.type === "R") ok("and it names the report twin, so an empty run has somewhere to look");
else bad(`twin: ${JSON.stringify("refused" in r ? null : r.twin)}`);
const solo = resolveProgram("KAR_EXECUPGRADES", { ...base, policy: "all" });
if (!("refused" in solo) && solo.twin === undefined) ok("a program with no twin carries none");
else bad(`unexpected twin: ${JSON.stringify(solo)}`);
r = resolveProgram("KAR_EXECUPGRADES", { ...base, policy: "all", deny: new Set(["KAR_EXECUPGRADES"]) });
if ("refused" in r && /deny list/.test(r.reason)) ok("the deny list beats the open policy");
else bad(JSON.stringify(r).slice(0, 200));
r = resolveProgram("FORMTRIGREP", { ...base, policy: "catalog", deny: new Set(["FORMTRIGREP"]) });
if ("refused" in r && /deny list/.test(r.reason)) ok("the deny list beats the catalog too");
else bad(JSON.stringify(r).slice(0, 200));
r = resolveProgram("AINVOICES", { ...base, policy: "all" });
if ("refused" in r) ok("a SCREEN is not runnable, even wide open");
else bad("a screen resolved as a program");

console.log(failures === 0 ? "\nAll program-selection checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
