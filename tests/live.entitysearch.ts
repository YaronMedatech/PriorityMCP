// Procedures and reports against the live dictionary.
//
// The regression that matters most is the one a passing new feature hides: a
// screen search must return exactly what it returned before programs existed.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { searchScreens } from "../src/discovery.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const started = Date.now();
await dict.ready();
const stats = dict.stats();
console.log(`\ndictionary ready in ${((Date.now() - started) / 1000).toFixed(1)}s: ${stats.forms} forms, ${stats.programs} programs`);

console.log("\n1. Programs were loaded");
if (stats.programs > 5000) ok(`${stats.programs} procedures and reports indexed`);
else bad(`only ${stats.programs} programs — EXEC read failed or was filtered`);

console.log("\n2. A screen search returns screens only");
for (const q of ["חשבוניות מס", "מלאי", "לקוחות"]) {
  const r = dict.search(q, {});
  const nonScreens = r.matches.filter((m) => m.kind !== "F");
  if (nonScreens.length === 0) ok(`'${q}': ${r.shown} screen(s), no programs`);
  else bad(`'${q}' returned ${nonScreens.length} program(s) without being asked`);
}

console.log("\n3. Known programs are found by title and by name");
const trig = dict.search("הפעלות מסך", { kinds: ["R"] });
if (trig.matches[0]?.screen === "FORMTRIGREP") ok(`'הפעלות מסך' -> ${trig.matches[0].screen} (R)`);
else bad(`'הפעלות מסך' top: ${JSON.stringify(trig.matches.slice(0, 3))}`);
const tree = dict.getProgram("FORMTREE", "P");
if (tree.length === 1 && tree[0]?.title === "עץ מסכים") ok(`FORMTREE (P): ${tree[0].title}`);
else bad(`FORMTREE: ${JSON.stringify(tree)}`);
const msg = dict.getProgram("FORMMSG");
if (msg.length === 2 && msg.map((m) => m.kind).sort().join() === "P,R") ok("FORMMSG exists as both P and R, and get('FORMMSG') is still the screen");
else bad(`FORMMSG programs: ${JSON.stringify(msg)}`);
if (dict.get("FORMMSG")?.kind === "F") ok("get('FORMMSG').kind === 'F'");
else bad(`get('FORMMSG') = ${JSON.stringify(dict.get("FORMMSG"))}`);

console.log("\n4. The tool reply marks runnable programs from the catalog");
const reply = (await searchScreens(dict, { query: "מסך", kinds: ["P", "R"], limit: 10 }, undefined, undefined, new Set(["FORMTRIGREP", "FORMMSG", "FORMTREE", "FORMCLTRIGREP"]))) as {
  screens: { screen: string; kind: string; runnable?: boolean }[];
  totalMatches: number;
};
console.log(`   ${reply.totalMatches} program(s) match 'מסך'; first: ${reply.screens.slice(0, 5).map((s) => `${s.screen}(${s.kind})${s.runnable ? "*" : ""}`).join(", ")}`);
if (reply.screens.every((s) => typeof s.runnable === "boolean")) ok("every program result carries runnable");
else bad("a program result lacks runnable");

console.log("\n5. Titles are on every program");
const all = dict.allEntries().filter((e) => e.kind !== "F");
const untitled = all.filter((e) => !e.title);
if (untitled.length === 0) ok(`all ${all.length} programs have a title`);
else console.log(`   ${untitled.length} untitled program(s) — e.g. ${untitled.slice(0, 3).map((e) => e.screen).join(", ")}`);

console.log(failures === 0 ? "\nAll live entity-search checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
