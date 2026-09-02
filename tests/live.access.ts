// Does a caller learn that a child screen is readable through its parent?
//
// The failure this guards against is silent: a model searches for a sub-form,
// sees it is not an entity set, and reports "no data available" while the rows sit
// behind the parent screen.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { searchScreens, describeScreen } from "../src/discovery.js";
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

await dict.ready();

const CHILD = process.env["ACCESS_CHILD"] ?? "SALECREDITINVOICES";
const CHILD_TERM = process.env["ACCESS_TERM"] ?? "חשבוניות זיכוי";

console.log("\n1. Known child screens are classified as via-parent");
for (const [child, expectedParent] of [
  [CHILD, "SALES"],
  ["AINVOICEITEMS", "AINVOICES"],
] as const) {
  const e = dict.get(child);
  console.log(`   ${child}: access=${e?.access} parents=${JSON.stringify(e?.parents)}`);
  if (e?.access === "via-parent" && e.parents?.includes(expectedParent)) {
    ok(`${child} is via-parent and names ${expectedParent}`);
  } else bad(`${child}: expected via-parent naming ${expectedParent}, got ${e?.access}`);
}

console.log("\n2. A top-level screen is still direct, and a closed one is not mislabelled");
const ain = dict.get("AINVOICES");
if (ain?.access === "direct") ok("AINVOICES is direct");
else bad(`AINVOICES: ${ain?.access}`);
const pb = dict.get("PARTBAL");
console.log(`   PARTBAL: access=${pb?.access} published=${pb?.published}`);
if (pb && pb.access !== "via-parent") {
  ok(`PARTBAL is not mislabelled as a sub-form (access=${pb.access})`);
} else bad(`PARTBAL wrongly classified as ${pb?.access}`);

console.log("\n3. search_screens surfaces a child instead of hiding it");
// Before the change this searched only published screens, so a sub-form could not
// appear at all -- the caller was told the screen did not exist.
const res = (await searchScreens(dict, { query: CHILD_TERM, limit: 10 })) as {
  totalMatches: number;
  screens: { screen: string; access: string; parents?: string[] }[];
  notes?: string[];
};
const hit = res.screens.find((s) => s.screen === CHILD);
console.log(`   ${res.totalMatches} matches; ${CHILD} present: ${Boolean(hit)}`);
if (hit) {
  ok(`found by its Hebrew title with access=${hit.access}, parents=${JSON.stringify(hit.parents)}`);
} else bad(`${CHILD} did not appear in a search for its own Hebrew title`);
if (res.notes?.some((n) => n.includes("via-parent"))) {
  ok("the notes explain how to read a via-parent screen");
} else bad("the notes do not explain via-parent");

console.log("\n4. describe_screen on the child resolves the parent");
const desc = (await describeScreen(client, dict, { screen: CHILD })) as {
  columns?: unknown[];
  structureNote?: string;
};
console.log(`   columns: ${desc.columns?.length ?? 0}`);
if ((desc.columns?.length ?? 0) > 0) {
  ok("the child's columns are described despite having no entity set");
} else if (desc.structureNote) {
  console.log(`   ${desc.structureNote.slice(0, 120)}`);
  ok("no columns, but the reply says why rather than implying the screen is empty");
} else bad("describe_screen returned no columns and no explanation");

console.log("\n5. The advertised route actually returns rows");
// Proven on AINVOICES/AINVOICEITEMS rather than SALES: SALES is switched off for
// the API on some installations, so it cannot demonstrate anything. Advice this
// tool gives to every caller is worth proving at least once against a live parent.
try {
  const rows = await client.query("AINVOICES", { top: 1, expand: "AINVOICEITEMS_SUBFORM($top=3)" });
  const kids = rows[0] ? rows[0]["AINVOICEITEMS_SUBFORM"] : undefined;
  const n = Array.isArray(kids) ? kids.length : -1;
  console.log(`   AINVOICES expanded -> AINVOICEITEMS_SUBFORM: ${n} row(s)`);
  if (n >= 0) {
    ok("expand from the parent returns the child's rows — the advice works");
  } else bad(`expand returned ${typeof kids}, not an array of child rows`);
} catch (err) {
  const why = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
  bad(`the advertised route failed: ${why.slice(0, 100)}`);
}

console.log("\n6. 'via-parent' means not LISTED, which is weaker than not readable");
// Measured after every screen was opened to the API: AINVOICEITEMS is absent
// from the service document and still reads as an entity, while
// SALECREDITINVOICES is absent and genuinely refuses. So the flag cannot promise
// a direct read fails — it only promises the parent route works. The advice is
// worded to allow one direct attempt, and this records which way each behaves
// rather than asserting a guarantee that does not hold.
for (const child of ["AINVOICEITEMS", CHILD]) {
  const entry = dict.get(child);
  let direct: string;
  try {
    await client.query(child, { top: 1 });
    direct = "readable directly TOO";
  } catch (err) {
    const m = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    direct = `direct read refused (${m.slice(0, 50)}…)`;
  }
  console.log(`   ${child.padEnd(20)} access=${entry?.access} — ${direct}`);
}
ok("recorded; the parent route is the one the advice guarantees");

console.log(failures === 0 ? "\nAll access-classification checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
