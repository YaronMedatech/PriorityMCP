// Multi-page aggregation must be exact.
//
// The invoice screen has 90 rows and never crosses a page boundary, so it cannot
// prove the scan loop. PART has ~1084 and does. An off-by-one in the paging here
// would produce a total that is quietly wrong — the worst possible failure for an
// aggregate, because nothing about the answer looks unusual.
import { PriorityODataClient } from "../src/odata.js";
import { runAggregate, runDistinct } from "../src/aggregate.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const ENTITY = process.env["PAGE_ENTITY"] ?? "PART";
const KEY = process.env["PAGE_KEY"] ?? "PARTNAME";

console.log(`\n1. A scan that crosses page boundaries counts exactly (${ENTITY})`);
const t0 = Date.now();
const total = await runAggregate(client, ENTITY, { groupBy: [], aggregate: [{ fn: "count" }] });
const counted = Number(total.groups[0]?.["count"] ?? 0);
console.log(
  `   count=${counted} scanned=${total.rowsScanned} pages=${total.pagesFetched} ` +
    `complete=${total.complete} (${Date.now() - t0}ms)`,
);

// Independent route to the same rows: this server reports no total, so the only
// honest check is a second full pull done a different way.
const direct = await client.query(ENTITY, { select: [KEY], pageSize: 200 });
console.log(`   independent full pull: ${direct.length} rows`);
if (counted === direct.length) ok(`exact across ${total.pagesFetched} pages`);
else bad(`aggregate counted ${counted}, independent pull found ${direct.length}`);
if (total.pagesFetched > 1) ok("more than one page was actually fetched");
else console.log("   (single page — the boundary was not exercised)");
if (total.complete) ok("reported complete"); else bad("reported incomplete");

console.log(`\n2. Grouping by the key gives one group per row`);
const byKey = await runAggregate(client, ENTITY, {
  groupBy: [KEY],
  aggregate: [{ fn: "count" }],
});
console.log(`   ${byKey.groupCount} groups from ${byKey.rowsScanned} rows`);
if (byKey.groupCount === direct.length) ok("a unique column yields exactly one group per row");
else bad(`${byKey.groupCount} groups for ${direct.length} unique rows`);

console.log(`\n3. Hitting the group ceiling is reported, never silent`);
// Forced with a tiny row budget so the ceiling path is exercised on demand rather
// than only on a screen that happens to be large enough.
const capped = await runAggregate(
  client,
  ENTITY,
  { groupBy: [KEY], aggregate: [{ fn: "count" }] },
  { maxRows: 500 },
);
console.log(`   scanned=${capped.rowsScanned} complete=${capped.complete}`);
if (!capped.complete) ok("a truncated scan reports complete=false");
else bad("a truncated scan claimed to be complete");
if (capped.notes.some((n) => n.includes("LOWER BOUND"))) {
  ok("the note says the totals are a lower bound");
} else bad(`no lower-bound warning: ${capped.notes.join(" | ").slice(0, 120)}`);

console.log(`\n4. column_values on the same screen`);
const dv = await runDistinct(client, ENTITY, KEY, { limit: 5 });
console.log(`   ${dv.distinctCount} distinct values over ${dv.rowsScanned} rows`);
if (dv.distinctCount === direct.length) ok("distinct count matches the row count for a key column");
else bad(`distinct ${dv.distinctCount} vs ${direct.length}`);
if (dv.values.length === 5) ok("limit respected");
else bad(`limit ignored: got ${dv.values.length}`);

console.log(failures === 0 ? "\nAll multi-page aggregation checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
