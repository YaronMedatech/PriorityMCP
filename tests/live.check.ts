// A live end-to-end check against the configured Priority server.
// Not part of `npm test` -- it needs a real .env and real data.
// Run: npx tsx tests/live.check.ts [dateFrom] [dateTo]
import { PriorityODataClient } from "../src/odata.js";
import { getSales } from "../src/sales.js";

const dateFrom = process.argv[2] ?? "2025-07-01";
const dateTo = process.argv[3] ?? "2025-08-31";

const client = new PriorityODataClient();
console.log(`\nQuerying ${dateFrom} .. ${dateTo}\n`);

const res = await getSales(client, { dateFrom, dateTo, maxRows: 500 });

console.log(`documents: ${res.documents.length}   truncated: ${res.truncated}`);

if (res.skipped?.length) {
  console.log(`\nskipped (not open to the API on this server):`);
  for (const s of res.skipped) console.log(`  - ${s.docType}`);
}

if (res.cancellations) {
  const c = res.cancellations;
  console.log(
    `\ncancellations: ${c.documentsIncluded} document(s), ` +
      `${c.matchedPairs} complete pair(s), ${c.straddlingRange.length} straddling the range`,
  );
  for (const s of c.straddlingRange) {
    console.log(
      `  ! ${s.docType} ${s.docNum} ${s.date} ${s.customer} ` +
        `${s.currency} ${s.total} — counterpart outside the range`,
    );
  }
}

console.log(`\nby currency:`);
for (const c of res.summary.byCurrency) {
  console.log(
    `  ${c.currency.padEnd(8)} docs=${String(c.documents).padStart(4)}  ` +
      `gross=${c.total.toFixed(2).padStart(14)}  net=${c.netTotal.toFixed(2).padStart(14)}`,
  );
}

console.log(`\nby document type:`);
for (const d of res.summary.byDocType) {
  const per = d.byCurrency
    .map((c) => `${c.currency} net=${c.netTotal.toFixed(2)}`)
    .join(", ");
  console.log(`  ${d.docType.padEnd(10)} ${d.label.padEnd(18)} docs=${String(d.documents).padStart(4)}  ${per}`);
}

const sample = res.documents[0];
if (sample) {
  console.log(`\nfirst document:`);
  console.log(`  ${JSON.stringify(sample, null, 2).split("\n").join("\n  ")}`);
}

process.exit(0);
