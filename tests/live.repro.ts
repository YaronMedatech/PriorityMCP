// Narrow the hang: same request, once through the client, with a wall-clock guard.
import { PriorityODataClient } from "../src/odata.js";
import { headerFields, lineFields } from "../src/salesSchema.js";

const started = Date.now();
const el = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const guard = setTimeout(() => {
  console.log(`[${el()}] STILL PENDING — client.query() hung`);
  process.exit(2);
}, 60_000);

const client = new PriorityODataClient();

console.log(`[${el()}] A: query WITHOUT expand`);
const noExpand = await client.query("AINVOICES", {
  select: headerFields("AINVOICES"),
  filter: "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2022-12-31T00:00:00Z and FINAL eq 'Y'",
  top: 3,
});
console.log(`[${el()}] A done: ${noExpand.length} rows`);

console.log(`[${el()}] B: query WITH expand`);
const withExpand = await client.query("AINVOICES", {
  select: headerFields("AINVOICES"),
  filter: "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2022-12-31T00:00:00Z and FINAL eq 'Y'",
  expand: `AINVOICEITEMS_SUBFORM($select=${lineFields("AINVOICES").join(",")})`,
  top: 3,
});
console.log(`[${el()}] B done: ${withExpand.length} rows`);
console.log(`first row keys: ${Object.keys(withExpand[0] ?? {}).join(", ")}`);

clearTimeout(guard);
process.exit(0);
