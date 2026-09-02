// What statuses does `FINAL eq 'Y'` actually let through?
// Cancelled documents are the concern: if Priority marks them final, they land in
// the totals as if they were sales.
import { PriorityODataClient } from "../src/odata.js";

const from = process.argv[2] ?? "2025-01-01";
const to = process.argv[3] ?? "2026-01-01";

const client = new PriorityODataClient();
const filter = `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z and FINAL eq 'Y'`;

for (const entity of ["AINVOICES", "CINVOICES"]) {
  const rows = await client.query(entity, {
    select: ["IVNUM", "IVDATE", "FINAL", "STATDES", "STORNOFLAG", "TOTPRICE"],
    filter,
    top: 500,
  });

  const buckets = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const key = `STATDES=${String(r["STATDES"] ?? "")}  STORNOFLAG=${String(r["STORNOFLAG"] ?? "")}`;
    const b = buckets.get(key) ?? { count: 0, total: 0 };
    b.count += 1;
    b.total += Number(r["TOTPRICE"] ?? 0);
    buckets.set(key, b);
  }

  console.log(`\n${entity} — FINAL='Y', ${from}..${to}: ${rows.length} rows`);
  for (const [key, b] of [...buckets.entries()].sort((a, b2) => b2[1].count - a[1].count)) {
    console.log(`  ${String(b.count).padStart(3)} x  ${key.padEnd(46)} total=${b.total.toFixed(2)}`);
  }
}
process.exit(0);
