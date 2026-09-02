// Diagnostic: why does a screen return fewer rows than expected?
// Run: npx tsx tests/live.diag.ts AINVOICES 2025-01-01 2026-12-31
import { PriorityODataClient } from "../src/odata.js";
import { headerFields, type DocType } from "../src/salesSchema.js";

const entity = (process.argv[2] ?? "AINVOICES") as DocType;
const from = process.argv[3] ?? "2025-01-01";
const to = process.argv[4] ?? "2026-12-31";

const client = new PriorityODataClient();
const select = headerFields(entity);

const dateFilter = `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z`;

for (const [label, filter] of [
  ["no filter at all", undefined],
  ["date range only", dateFilter],
  ["date range + FINAL eq 'Y'", `${dateFilter} and FINAL eq 'Y'`],
  ["FINAL eq 'Y' only", `FINAL eq 'Y'`],
] as const) {
  try {
    const rows = await client.query(entity, { select, top: 5, ...(filter ? { filter } : {}) });
    console.log(`\n${label}: ${rows.length} row(s)`);
    for (const r of rows.slice(0, 5)) {
      console.log(
        `   IVNUM=${String(r["IVNUM"]).padEnd(14)} IVDATE=${String(r["IVDATE"]).slice(0, 10)} ` +
          `FINAL=${String(r["FINAL"])} STATDES=${String(r["STATDES"] ?? "")} TOTPRICE=${String(r["TOTPRICE"])}`,
      );
    }
  } catch (err) {
    console.log(`\n${label}: ERROR ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}
process.exit(0);
