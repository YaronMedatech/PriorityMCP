// Exercises the discovery layer against the live server: dictionary search,
// screen description, and the generic query -- plus the regression check that
// motivated the whole pivot.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen, runQuery, searchScreens } from "../src/discovery.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);

// ---------------------------------------------------------------------------
console.log("\n1. Dictionary loads and reports its own scale");
const t0 = Date.now();
await dict.ready();
const stats = dict.stats();
console.log(
  `  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${stats.forms} forms, ${stats.published} published, ${stats.entitySets} entity sets`,
);
if (stats.forms > 1000) ok(`${stats.forms} forms indexed`);
else bad(`only ${stats.forms} forms indexed`);
if (stats.published > 500 && stats.published < stats.forms) {
  ok(`${stats.published} published — fewer than total, as expected`);
} else bad(`published count looks wrong: ${stats.published} of ${stats.forms}`);

// ---------------------------------------------------------------------------
console.log("\n2. THE REGRESSION TEST: what is CINVOICES really?");
const cinv = dict.get("CINVOICES");
console.log(`  CINVOICES -> title='${cinv?.title}' table=${cinv?.table} module=${cinv?.module}`);
if (cinv?.title && !/זיכוי/.test(cinv.title)) {
  ok(`title is '${cinv.title}', NOT a credit note — the hardcoded label was wrong`);
} else bad(`unexpected CINVOICES title: ${JSON.stringify(cinv?.title)}`);

// The real credit-note screen should be findable by its Hebrew name.
const credit = await searchScreens(dict, { query: "זיכוי", includeUnpublished: true, limit: 10 });
const creditJson = credit as { screens: { screen: string; title: string | null; published: boolean }[] };
const salecredit = creditJson.screens.find((s) => s.screen === "SALECREDITINVOICES");
if (salecredit) {
  ok(`found the real credit-note screen: ${salecredit.screen} = '${salecredit.title}' (published=${salecredit.published})`);
} else bad(`searching 'זיכוי' did not surface SALECREDITINVOICES`);

// ---------------------------------------------------------------------------
console.log("\n3. Hebrew search finds screens by business concept");
for (const q of ["מלאי", "הזמנת רכש", "לקוחות"]) {
  const r = (await searchScreens(dict, { query: q, limit: 5 })) as {
    totalMatches: number;
    screens: { screen: string; title: string | null }[];
  };
  if (r.totalMatches > 0) {
    ok(`'${q}' -> ${r.totalMatches} matches; top: ${r.screens.slice(0, 3).map((s) => `${s.screen} (${s.title})`).join(", ")}`);
  } else bad(`'${q}' matched nothing`);
}

// Gershayim normalization: Priority stores an ASCII quote, keyboards produce ״.
const g1 = (await searchScreens(dict, { query: 'חו"ל', limit: 3 })) as { totalMatches: number };
const g2 = (await searchScreens(dict, { query: "חו״ל", limit: 3 })) as { totalMatches: number };
if (g1.totalMatches > 0 && g1.totalMatches === g2.totalMatches) {
  ok(`quote variants match identically (${g1.totalMatches} each) — ASCII " and gershayim ״`);
} else bad(`quote normalization failed: ASCII=${g1.totalMatches}, gershayim=${g2.totalMatches}`);

// ---------------------------------------------------------------------------
console.log("\n4. describe_screen returns Hebrew column titles");
const desc = (await describeScreen(client, dict, { screen: "AINVOICES" })) as {
  title: string | null;
  keys: string[];
  columnCount: number;
  columns: { name: string; title: string | null; mandatory?: boolean; key?: boolean }[];
  subforms: { name: string; target: string }[];
};
if (desc.title) ok(`title: ${desc.title}`);
else bad("no title");
if (desc.keys.length === 3) ok(`composite key surfaced: ${desc.keys.join(", ")}`);
else bad(`keys: ${desc.keys.join(", ")}`);
const withTitles = desc.columns.filter((c) => c.title).length;
if (withTitles === desc.columns.length) ok(`all ${withTitles} columns have Hebrew titles`);
else bad(`only ${withTitles}/${desc.columns.length} columns have titles`);
if (desc.subforms.some((s) => s.name === "AINVOICEITEMS_SUBFORM")) ok(`subforms listed (${desc.subforms.length})`);
else bad("AINVOICEITEMS_SUBFORM not listed");
console.log(`       e.g. ${desc.columns.slice(0, 4).map((c) => `${c.name}='${c.title}'`).join(", ")}`);

// Column filtering, for wide screens.
const filtered = (await describeScreen(client, dict, { screen: "AINVOICES", columns: "לקוח" })) as {
  columnsShown: number;
  columns: { name: string; title: string | null }[];
};
if (filtered.columnsShown > 0 && filtered.columnsShown < desc.columnCount) {
  ok(`Hebrew column filter works: 'לקוח' -> ${filtered.columnsShown} of ${desc.columnCount}`);
} else bad(`column filter returned ${filtered.columnsShown}`);

// A sub-form described via its parent.
const sub = (await describeScreen(client, dict, {
  screen: "AINVOICES",
  subform: "AINVOICEITEMS_SUBFORM",
})) as { describing?: string; columns: { name: string }[] };
if (sub.describing === "AINVOICEITEMS" && sub.columns.some((c) => c.name === "PARTNAME")) {
  ok(`sub-form described: ${sub.describing}, ${sub.columns.length} columns`);
} else bad(`sub-form description wrong: ${JSON.stringify(sub.describing)}`);

// ---------------------------------------------------------------------------
console.log("\n5. An unpublished screen is resolved to its parent, not written off");
// SALECREDITINVOICES is a sub-form of SALES. Reading it directly 404s because
// sub-forms are never entity sets -- which is a different fact, with different
// advice, from "this screen is closed to the API".
const unq = (await describeScreen(client, dict, { screen: "SALECREDITINVOICES" })) as {
  published: boolean;
  isSubform?: boolean;
  parent?: string;
  navigationProperty?: string;
  columnCount?: number;
  parentReadable?: boolean;
  howToRead?: string;
  title?: string | null;
  error?: string;
};

if (unq.isSubform && unq.parent === "SALES") {
  ok(`resolved to its parent: ${unq.parent} via ${unq.navigationProperty}`);
} else bad(`expected a sub-form resolution to SALES, got ${JSON.stringify(unq).slice(0, 200)}`);

if ((unq.columnCount ?? 0) > 0) {
  ok(`described ${unq.columnCount} columns from the parent's metadata despite no entity set`);
} else bad("no columns recovered from the parent's metadata");

// Knowing the parent is useless if the parent is itself closed; both must be said.
if (unq.parentReadable === false && /not readable/.test(unq.howToRead ?? "")) {
  ok("reports that the parent is itself unreadable, so the data is still out of reach");
} else if (unq.parentReadable === true && /expand/.test(unq.howToRead ?? "")) {
  ok("parent is readable and the expand path is given");
} else bad(`howToRead is unclear: ${unq.howToRead}`);

// ---------------------------------------------------------------------------
console.log("\n6. Generic query, including a keyed sub-form path");
const q1 = (await runQuery(client, dict, {
  entity: "AINVOICES",
  filter: "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2023-01-01T00:00:00Z and FINAL eq 'Y'",
  select: "IVNUM,IVDATE,CUSTNAME,TOTPRICE,DEBIT,IVTYPE",
  top: 3,
})) as { rowCount: number; rows: Record<string, unknown>[] };
if (q1.rowCount === 3) ok(`entity query returned ${q1.rowCount} rows`);
else bad(`entity query returned ${q1.rowCount}`);

const first = q1.rows[0];
if (first) {
  // Keyed path onto a sub-form -- the thing buildUrl's encoding cannot express.
  const path =
    `AINVOICES(IVNUM='${String(first["IVNUM"])}',DEBIT='${String(first["DEBIT"])}',` +
    `IVTYPE='${String(first["IVTYPE"])}')/AINVOICEITEMS_SUBFORM?$select=PARTNAME,QUANT,PRICE`;
  const q2 = (await runQuery(client, dict, { path })) as { rowCount: number; rows: Record<string, unknown>[] };
  if (q2.rowCount > 0) {
    ok(`keyed sub-form path returned ${q2.rowCount} line(s): ${JSON.stringify(q2.rows[0])}`);
  } else bad(`keyed sub-form path returned nothing (${path})`);
}

// select must be dropped when expanding, or the response truncates.
const q3 = (await runQuery(client, dict, {
  entity: "AINVOICES",
  filter: "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2023-01-01T00:00:00Z and FINAL eq 'Y'",
  select: "IVNUM,TOTPRICE",
  expand: "AINVOICEITEMS_SUBFORM($select=PARTNAME,QUANT)",
  top: 2,
})) as { rowCount: number; notes?: string[] };
if (q3.rowCount === 2 && q3.notes?.some((n) => n.includes("select was ignored"))) {
  ok("parent select dropped when expanding, and the caller is told why");
} else bad(`expand+select handling wrong: rows=${q3.rowCount} notes=${JSON.stringify(q3.notes)}`);

console.log(failures === 0 ? "\nAll discovery checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
