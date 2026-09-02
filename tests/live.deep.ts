// Deep investigation of a screen: does depth walk the sub-form tree, stay inside
// its budget, and name the navigation property for each node?
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen } from "../src/discovery.js";
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

const SCREEN = process.env["DEEP_SCREEN"] ?? "AINVOICES";

interface Node {
  screen: string;
  title: string | null;
  via?: string;
  keys: string[];
  columnCount: number;
  columns?: { name: string }[];
  children?: Node[];
  note?: string;
}
interface Deep {
  tree: Node;
  depth: number;
  budget: { screensDescribed: number; columnsShown: number; extraMetadataRequests: number; truncated: boolean };
  notes?: string[];
}

const draw = (n: Node, indent = "") => {
  const via = n.via ? ` (via ${n.via})` : "";
  const cols = n.columnCount ? `, ${n.columns?.length ?? 0}/${n.columnCount} cols` : "";
  console.log(`${indent}${n.screen}${via} — ${n.title ?? "?"}${cols}${n.note ? `  [${n.note}]` : ""}`);
  for (const c of n.children ?? []) draw(c, indent + "  ");
};

const count = (n: Node): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);

console.log(`\n1. depth 0 is unchanged (flat description of ${SCREEN})`);
const flat = (await describeScreen(client, dict, { screen: SCREEN })) as {
  columns?: unknown[];
  subforms?: unknown[];
  tree?: unknown;
};
if (flat.tree === undefined && Array.isArray(flat.columns)) {
  ok(`flat reply has ${flat.columns.length} columns and no tree`);
} else bad("depth 0 changed shape");

console.log(`\n2. depth 1 walks the sub-forms`);
const t0 = Date.now();
const d1 = (await describeScreen(client, dict, { screen: SCREEN, depth: 1 })) as Deep;
console.log(`   ${Date.now() - t0}ms, ${d1.budget.extraMetadataRequests} extra metadata request(s)`);
draw(d1.tree);
const n1 = count(d1.tree);
if (n1 > 1) ok(`${n1} screens in the tree`); else bad("depth 1 produced no children");
if ((d1.tree.children ?? []).every((c) => c.via)) {
  ok("every child names the navigation property to reach it");
} else bad("a child is missing 'via'");
if (d1.budget.extraMetadataRequests === 0) {
  ok("depth 1 cost no extra requests — relatives came in the first document");
} else {
  console.log(`   (depth 1 needed ${d1.budget.extraMetadataRequests} extra request(s))`);
}

console.log(`\n3. depth 2 goes deeper and still respects the budget`);
const d2 = (await describeScreen(client, dict, { screen: SCREEN, depth: 2 })) as Deep;
const n2 = count(d2.tree);
console.log(
  `   ${n2} screens, ${d2.budget.columnsShown} columns, ` +
    `${d2.budget.extraMetadataRequests} extra request(s), truncated=${d2.budget.truncated}`,
);
if (n2 >= n1) ok(`depth 2 covers at least as much as depth 1 (${n2} vs ${n1})`);
else bad(`depth 2 returned fewer screens (${n2}) than depth 1 (${n1})`);
if (d2.budget.screensDescribed <= 40 && d2.budget.columnsShown <= 500) {
  ok("stayed inside the screen and column ceilings");
} else bad(`budget exceeded: ${JSON.stringify(d2.budget)}`);

console.log("\n4. A repeated screen is referenced, not duplicated");
const seen = new Map<string, number>();
const tally = (n: Node) => {
  if (n.columns?.length) seen.set(n.screen, (seen.get(n.screen) ?? 0) + 1);
  for (const c of n.children ?? []) tally(c);
};
tally(d2.tree);
const dupes = [...seen.entries()].filter(([, c]) => c > 1);
if (dupes.length === 0) ok("no screen has its columns listed twice");
else bad(`duplicated: ${dupes.map(([s, c]) => `${s}x${c}`).join(", ")}`);

console.log("\n5. The columns filter applies across the whole tree");
const filtered = (await describeScreen(client, dict, {
  screen: SCREEN,
  depth: 2,
  columns: "DATE",
})) as Deep;
const names: string[] = [];
const collect = (n: Node) => {
  for (const c of n.columns ?? []) names.push(c.name);
  for (const k of n.children ?? []) collect(k);
};
collect(filtered.tree);
console.log(`   ${names.length} columns matched "DATE" across ${count(filtered.tree)} screens`);
if (names.length && names.every((n) => n.toUpperCase().includes("DATE"))) {
  ok("every returned column matches the filter, at every level");
} else if (!names.length) {
  bad("the filter removed everything");
} else bad(`non-matching column returned: ${names.find((n) => !n.toUpperCase().includes("DATE"))}`);

console.log("\n6. includeColumnSources adds where a value is read from");
const withSrc = (await describeScreen(client, dict, {
  screen: SCREEN,
  includeColumnSources: true,
})) as { columns?: { name: string; readsFrom?: string; formPosition?: number }[]; columnSourceNote?: string };
const sourced = (withSrc.columns ?? []).filter((c) => c.readsFrom);
console.log(`   ${sourced.length} of ${withSrc.columns?.length ?? 0} columns name a source`);
for (const c of sourced.slice(0, 4)) console.log(`     ${c.name} <- ${c.readsFrom}`);
if (sourced.length > 0) ok("join sources are attached to columns");
else console.log(`   (none on this screen — note: ${withSrc.columnSourceNote ?? "n/a"})`);

console.log(failures === 0 ? "\nAll deep-dive checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
