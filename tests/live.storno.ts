// How does this Priority installation actually record a cancellation?
// Prints every cancelled document in full, plus anything that references it, so
// the storno mechanism can be read off real data instead of assumed.
import { PriorityODataClient } from "../src/odata.js";
import { DOC_TYPES, type DocType } from "../src/salesSchema.js";

const from = process.argv[2] ?? "2020-01-01";
const to = process.argv[3] ?? "2030-01-01";

const client = new PriorityODataClient();

for (const docType of Object.keys(DOC_TYPES) as DocType[]) {
  const rows = await client.query(docType, {
    filter: `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z and STORNOFLAG eq 'Y'`,
    top: 20,
  });

  console.log(`\n${"=".repeat(72)}\n${docType}: ${rows.length} cancelled document(s)`);

  for (const r of rows) {
    // Print only the fields that carry a value, to keep the shape readable.
    const filled = Object.entries(r)
      .filter(([k, v]) => v !== null && v !== "" && v !== 0 && !k.startsWith("@"))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    console.log(`\n  --- ${String(r["IVNUM"])} (${String(r["IVDATE"]).slice(0, 10)})`);
    console.log(`      ${filled.join("\n      ")}`);
  }
}

// Does a cancellation leave a trace on the ORIGINAL document, or create a new
// reversing one? Compare counts of cancelled vs zero-valued documents.
console.log(`\n${"=".repeat(72)}\nAll documents whose STATDES mentions cancellation:`);
for (const docType of Object.keys(DOC_TYPES) as DocType[]) {
  const rows = await client.query(docType, {
    select: ["IVNUM", "IVDATE", "FINAL", "STATDES", "STORNOFLAG", "TOTPRICE", "IVREFA", "IVTYPE"],
    filter: `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z`,
    top: 500,
  });
  const cancelled = rows.filter(
    (r) => String(r["STORNOFLAG"] ?? "").toUpperCase() === "Y" || /מבוטל/.test(String(r["STATDES"] ?? "")),
  );
  console.log(`\n  ${docType}: ${cancelled.length} of ${rows.length}`);
  for (const r of cancelled) {
    console.log(
      `    ${String(r["IVNUM"]).padEnd(14)} date=${String(r["IVDATE"]).slice(0, 10)} ` +
        `FINAL=${String(r["FINAL"] ?? "")} STORNO=${String(r["STORNOFLAG"] ?? "")} ` +
        `TOT=${String(r["TOTPRICE"])} IVREFA=${String(r["IVREFA"] ?? "")} STAT=${String(r["STATDES"] ?? "")}`,
    );
  }
}
process.exit(0);
