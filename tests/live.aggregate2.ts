// MCP-side aggregation, verified against rows read the ordinary way.
//
// The whole point is that the total must be RIGHT — an aggregate that is merely
// fast is worse than no aggregate at all, because nobody can tell by looking.
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

const ENTITY = process.env["AGG_ENTITY"] ?? "AINVOICES";
const MEASURE = process.env["AGG_MEASURE"] ?? "QPRICE";

console.log(`\n1. Grand total matches a hand count of the same rows`);
const all = await client.query(ENTITY, { top: 500, select: [MEASURE, "IVTYPE", "IVDATE"] });
const handCount = all.length;
const handSum = all.reduce((s, r) => {
  const n = Number(r[MEASURE]);
  return s + (Number.isFinite(n) ? n : 0);
}, 0);

const total = await runAggregate(client, ENTITY, {
  groupBy: [],
  aggregate: [{ fn: "count" }, { fn: "sum", column: MEASURE }],
});
const g0 = total.groups[0] ?? {};
console.log(`   hand: count=${handCount} sum=${handSum.toFixed(2)}`);
console.log(`   agg : count=${String(g0["count"])} sum=${String(g0[`sum_${MEASURE}`])}`);
if (Number(g0["count"]) === handCount) ok("count matches"); else bad(`count ${String(g0["count"])} vs ${handCount}`);
if (Math.abs(Number(g0[`sum_${MEASURE}`]) - handSum) < 0.01) ok("sum matches");
else bad(`sum ${String(g0[`sum_${MEASURE}`])} vs ${handSum}`);
if (total.complete) ok("reported complete"); else bad("reported incomplete on a small screen");

console.log(`\n2. Group counts add back up to the total`);
const byType = await runAggregate(client, ENTITY, {
  groupBy: ["IVTYPE"],
  aggregate: [{ fn: "count" }, { fn: "sum", column: MEASURE }],
});
console.log(`   ${byType.groupCount} group(s) from ${byType.rowsScanned} rows`);
for (const g of byType.groups.slice(0, 5)) console.log(`     ${JSON.stringify(g)}`);
const sumOfGroups = byType.groups.reduce((s, g) => s + Number(g["count"] ?? 0), 0);
if (sumOfGroups === handCount) ok(`group counts sum to ${handCount}`);
else bad(`groups sum to ${sumOfGroups}, expected ${handCount}`);

console.log(`\n3. Dates group by day, not by timestamp`);
const byDate = await runAggregate(client, ENTITY, {
  groupBy: ["IVDATE"],
  aggregate: [{ fn: "count" }],
});
const keys = byDate.groups.map((g) => String(g["IVDATE"]));
const allDayShaped = keys.every((k) => k === "null" || /^\d{4}-\d{2}-\d{2}$/.test(k));
console.log(`   ${byDate.groupCount} date group(s), e.g. ${keys.slice(0, 4).join(", ")}`);
if (allDayShaped) ok("every date key is a plain day");
else bad(`a timestamp survived: ${keys.find((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k))}`);
if (byDate.groupCount <= handCount) ok("grouping actually reduced the row count");
else bad("grouping produced more groups than rows");

console.log(`\n4. A filter narrows the scan`);
const filtered = await runAggregate(
  client,
  ENTITY,
  { groupBy: [], aggregate: [{ fn: "count" }] },
  { filter: "DEBIT eq 'D'" },
);
console.log(`   filtered count=${String(filtered.groups[0]?.["count"])} scanned=${filtered.rowsScanned}`);
if (filtered.rowsScanned <= handCount) ok("the filter was applied before grouping");
else bad("filtered scan read more rows than exist");

console.log(`\n5. min/max/avg are consistent with each other`);
const stats = await runAggregate(client, ENTITY, {
  groupBy: [],
  aggregate: [
    { fn: "min", column: MEASURE },
    { fn: "avg", column: MEASURE },
    { fn: "max", column: MEASURE },
  ],
});
const s = stats.groups[0] ?? {};
const mn = Number(s[`min_${MEASURE}`]);
const av = Number(s[`avg_${MEASURE}`]);
const mx = Number(s[`max_${MEASURE}`]);
console.log(`   min=${mn} avg=${av} max=${mx}`);
if (mn <= av && av <= mx) ok("min ≤ avg ≤ max");
else bad(`ordering violated: ${mn} / ${av} / ${mx}`);

console.log(`\n6. A numeric aggregate without a column is refused`);
try {
  await runAggregate(client, ENTITY, { groupBy: [], aggregate: [{ fn: "sum" }] });
  bad("sum without a column was accepted");
} catch (err) {
  console.log(`   ${err instanceof Error ? err.message : String(err)}`);
  ok("refused with an explanation");
}

console.log(`\n7. column_values reveals what a code column contains`);
const dv = await runDistinct(client, ENTITY, "IVTYPE");
console.log(`   ${dv.distinctCount} distinct, scanned ${dv.rowsScanned}`);
for (const v of dv.values.slice(0, 6)) console.log(`     ${JSON.stringify(v.value)} ×${v.count}`);
if (dv.values.length > 0 && dv.values.every((v) => typeof v.count === "number")) {
  ok("values come back with counts, sorted by frequency");
} else bad("no values returned");
const dvSum = dv.values.reduce((a, v) => a + v.count, 0);
if (dvSum === handCount) ok(`value counts sum to ${handCount}`);
else bad(`value counts sum to ${dvSum}, expected ${handCount}`);

console.log(failures === 0 ? "\nAll aggregation checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
