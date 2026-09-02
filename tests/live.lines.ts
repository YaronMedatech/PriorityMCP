// Does $expand of the item sub-form actually work against a live Priority server?
// Covered only by stubs until now, which cannot catch an OData-side rejection.
import { PriorityODataClient } from "../src/odata.js";
import { getSales } from "../src/sales.js";
import { DOC_TYPES, headerFields, lineFields, type DocType } from "../src/salesSchema.js";

const from = process.argv[2] ?? "2022-01-01";
const to = process.argv[3] ?? "2022-12-31";

const client = new PriorityODataClient();

const filter = `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z and FINAL eq 'Y'`;

// The quirk this file exists to pin down: a parent $select alongside $expand
// makes Priority abort the response mid-JSON. Both halves are asserted, because
// "expand works" and "expand works only without a parent $select" are different
// facts and only the second one is true.
console.log(`\n1. $expand per screen, with and without a parent $select (${from}..${to})`);
for (const docType of Object.keys(DOC_TYPES) as DocType[]) {
  const spec = DOC_TYPES[docType];
  const expand = `${spec.itemsNav}($select=${lineFields(docType).join(",")})`;

  let brokenRejected = false;
  try {
    await client.query(docType, { select: headerFields(docType), filter, expand, top: 3 });
  } catch {
    brokenRejected = true;
  }

  try {
    const rows = await client.query(docType, { filter, expand, top: 3 });
    const withLines = rows.filter(
      (r) => Array.isArray(r[spec.itemsNav]) && (r[spec.itemsNav] as []).length,
    );
    const verdict = brokenRejected ? "ok  " : "HUH ";
    console.log(
      `  ${verdict} ${docType.padEnd(10)} no-parent-select: ${rows.length} row(s), ` +
        `${withLines.length} with lines` +
        (brokenRejected ? "" : "  <-- parent $select UNEXPECTEDLY worked"),
    );
  } catch (err) {
    console.log(
      `  FAIL ${docType}: even without a parent $select — ` +
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
}

console.log(`\n2. Through getSales with includeLines`);
try {
  const res = await getSales(client, { dateFrom: from, dateTo: to, includeLines: true, maxRows: 20 });
  const withLines = res.documents.filter((d) => (d.lines?.length ?? 0) > 0);
  console.log(`  documents: ${res.documents.length}, with lines: ${withLines.length}`);
  const sample = withLines[0];
  if (sample) {
    console.log(`  ${sample.docType} ${sample.docNum} ${sample.date} ${sample.customerName}`);
    for (const l of sample.lines!.slice(0, 5)) {
      console.log(
        `     ${String(l.part).padEnd(16)} ${String(l.description ?? "").slice(0, 24).padEnd(26)} ` +
          `qty=${l.qty} ${l.unit ?? ""} price=${l.price} total=${l.lineTotal}`,
      );
    }
  } else {
    console.log(`  !! no document came back with any lines`);
  }
} catch (err) {
  console.log(`  FAIL ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\n3. Filtering by a part code`);
try {
  const probe = await getSales(client, { dateFrom: from, dateTo: to, includeLines: true, maxRows: 50 });
  const anyPart = probe.documents.flatMap((d) => d.lines ?? []).find((l) => l.part)?.part;
  if (!anyPart) {
    console.log(`  !! no part code found to test with`);
  } else {
    const byPart = await getSales(client, { dateFrom: from, dateTo: to, part: anyPart, maxRows: 50 });
    console.log(`  part '${anyPart}' -> ${byPart.documents.length} document(s)`);
  }
} catch (err) {
  console.log(`  FAIL ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
