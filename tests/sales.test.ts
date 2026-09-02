// Exercises the normalizer and the summary against a stubbed OData layer.
// These are the numbers a user will act on, so the per-currency split, the
// document direction, and the FINVOICES column differences all get pinned here.
import type { PriorityODataClient } from "../src/odata.js";
import { getSales } from "../src/sales.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const eq = (label: string, actual: unknown, expected: unknown) =>
  actual === expected ? ok(`${label} = ${String(actual)}`) : bad(`${label}: got ${String(actual)}, expected ${String(expected)}`);

/** Stands in for the OData client, returning canned rows per screen. */
function stub(rowsByEntity: Record<string, Record<string, unknown>[]>): PriorityODataClient {
  return {
    baseUrl: "https://stub",
    async metadataFor() {
      return new Map([["X", { props: new Map([["IVDATE", "Edm.DateTimeOffset"]]), navs: new Map() }]]);
    },
    async query(entity: string) {
      return rowsByEntity[entity] ?? [];
    },
  } as unknown as PriorityODataClient;
}

const range = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };

// ---------------------------------------------------------------------------
console.log("\n1. Direction comes from DEBIT, not from the screen; currencies stay separate");

const client = stub({
  AINVOICES: [
    { IVNUM: "A1", IVDATE: "2026-01-05T00:00:00+02:00", CUSTNAME: "C1", CDES: "לקוח א", CODE: "", QPRICE: 1000, VAT: 170, TOTPRICE: 1170, FINAL: "Y", DEBIT: "D", IVTYPE: "A" },
    { IVNUM: "A2", IVDATE: "2026-01-06T00:00:00+02:00", CUSTNAME: "C2", CDES: "לקוח ב", CODE: "", QPRICE: 500, VAT: 85, TOTPRICE: 585, FINAL: "Y", DEBIT: "D", IVTYPE: "A" },
  ],
  CINVOICES: [
    // A consolidated invoice with DEBIT='D' is an ordinary positive sale. The old
    // code negated the whole CINVOICES screen and inverted exactly this row.
    { IVNUM: "C1", IVDATE: "2026-01-10T00:00:00+02:00", CUSTNAME: "C1", CDES: "לקוח א", CODE: "", QPRICE: 200, VAT: 34, TOTPRICE: 234, FINAL: "Y", DEBIT: "D", IVTYPE: "C" },
    // DEBIT='C' is the real credit marker, and it does reduce sales.
    { IVNUM: "C2", IVDATE: "2026-01-11T00:00:00+02:00", CUSTNAME: "C1", CDES: "לקוח א", CODE: "", QPRICE: 100, VAT: 17, TOTPRICE: 117, FINAL: "Y", DEBIT: "C", IVTYPE: "C" },
  ],
  FINVOICES: [
    { IVNUM: "F1", IVDATE: "2026-01-12T00:00:00+02:00", CUSTNAME: "C9", CDES: "Acme Inc", CODE: "USD", QPRICE: 800, TAXSUM: 0, TOTPRICE: 800, CRDES: "USA", FINAL: "Y", DEBIT: "D", IVTYPE: "F" },
  ],
  EINVOICES: [],
});

const res = await getSales(client, range);

eq("documents returned", res.documents.length, 5);

const local = res.summary.byCurrency.find((c) => c.currency === "LOCAL");
const usd = res.summary.byCurrency.find((c) => c.currency === "USD");

if (!local || !usd) {
  bad("expected both a LOCAL and a USD currency bucket");
} else {
  // Gross local = 1170 + 585 + 234 + 117 = 2106.
  // Net local subtracts only the DEBIT='C' row: 2106 - 2*117 = 1872.
  eq("LOCAL gross total", local.total, 2106);
  eq("LOCAL net total (only the DEBIT='C' row subtracted)", local.netTotal, 1872);
  eq("LOCAL document count", local.documents, 4);
  // The export invoice must not be folded into the local figures.
  eq("USD net total", usd.netTotal, 800);
  eq("USD document count", usd.documents, 1);
}

if (res.summary.byCurrency.length === 2) ok("no single cross-currency total is produced");
else bad(`expected exactly 2 currency buckets, got ${res.summary.byCurrency.length}`);

// THE REGRESSION GUARD for the bug that motivated the discovery pivot: a
// consolidated invoice must NOT be treated as a credit note.
const consolidated = res.documents.find((d) => d.docNum === "C1");
eq("consolidated invoice (DEBIT=D) counts POSITIVE", consolidated?.sign, 1);
eq("consolidated invoice totalSigned", consolidated?.totalSigned, 234);

const credit = res.documents.find((d) => d.docNum === "C2");
eq("DEBIT='C' row counts negative", credit?.sign, -1);
eq("DEBIT='C' totalSigned", credit?.totalSigned, -117);
eq("debit surfaced on the row", credit?.debit, "C");
eq("ivType surfaced on the row", credit?.ivType, "C");

// Mixing CINVOICES with other screens risks double-counting; that must be said
// rather than silently resolved.
if (res.summary.warnings?.some((w) => w.includes("consolidated"))) {
  ok("double-counting warning present when CINVOICES is mixed with other screens");
} else bad("expected a consolidated-invoice double-counting warning");

const exportDoc = res.documents.find((d) => d.docType === "FINVOICES");
eq("export invoice country", exportDoc?.country, "USA");
eq("export invoice VAT read from TAXSUM", exportDoc?.vat, 0);
eq("local invoice country is null", res.documents.find((d) => d.docType === "AINVOICES")?.country, null);

if (res.documents.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? ""))) {
  ok("dates normalized to YYYY-MM-DD");
} else bad("some dates were not normalized");

// ---------------------------------------------------------------------------
console.log("\n2. FINVOICES line totals come from QPRICE, not TOTPRICE");

const lineClient = stub({
  AINVOICES: [],
  EINVOICES: [],
  CINVOICES: [],
  FINVOICES: [
    {
      IVNUM: "F2", IVDATE: "2026-01-15T00:00:00Z", CUSTNAME: "C9", CODE: "EUR",
      QPRICE: 300, TAXSUM: 0, TOTPRICE: 300, FINAL: "Y", DEBIT: "D", IVTYPE: "F",
      FINVOICEITEMS_SUBFORM: [
        // Note: no TOTPRICE key at all -- that column does not exist on this screen.
        { PARTNAME: "P1", PDES: "Widget", QUANT: 3, UNITNAME: "יח'", PRICE: 100, QPRICE: 300 },
      ],
    },
  ],
});

const withLines = await getSales(lineClient, { ...range, includeLines: true });
const line = withLines.documents[0]?.lines?.[0];
eq("line part", line?.part, "P1");
eq("line total sourced from QPRICE", line?.lineTotal, 300);

// ---------------------------------------------------------------------------
console.log("\n3. Truncation is reported rather than hidden");

const many = Array.from({ length: 5 }, (_, i) => ({
  IVNUM: `A${i}`, IVDATE: "2026-01-05T00:00:00Z", CUSTNAME: "C1", CODE: "",
  QPRICE: 100, VAT: 17, TOTPRICE: 117, FINAL: "Y", DEBIT: "D", IVTYPE: "A",
}));
const truncClient = stub({ AINVOICES: many, EINVOICES: [], FINVOICES: [], CINVOICES: [] });
const trunc = await getSales(truncClient, { ...range, maxRows: 5 });
eq("truncated flag", trunc.truncated, true);
if ((trunc.truncationNote ?? "").includes("INCOMPLETE")) ok("truncation note states results are incomplete");
else bad("truncation note missing or unclear");

// ---------------------------------------------------------------------------
console.log("\n4. A complete storno pair nets to zero and is reported as matched");

// How Priority really stores a cancellation: a mirror-image reversing document.
// Note the document numbers are NOT adjacent -- matching must be by amount.
const pairClient = stub({
  AINVOICES: [
    { IVNUM: "A1", IVDATE: "2026-01-05T00:00:00Z", CUSTNAME: "C1", CODE: "", QPRICE: 1000, VAT: 170, TOTPRICE: 1170, FINAL: "Y", DEBIT: "D", IVTYPE: "A" },
    { IVNUM: "A7", IVDATE: "2026-01-06T00:00:00Z", CUSTNAME: "C1", CODE: "", QPRICE: 900, VAT: 153, TOTPRICE: 1053, FINAL: "Y", DEBIT: "D", IVTYPE: "A", STORNOFLAG: "Y", STATDES: "מבוטלת" },
    { IVNUM: "A12", IVDATE: "2026-01-20T00:00:00Z", CUSTNAME: "C1", CODE: "", QPRICE: -900, VAT: -153, TOTPRICE: -1053, FINAL: "Y", DEBIT: "D", IVTYPE: "A", STORNOFLAG: "Y", STATDES: "מבוטלת" },
  ],
  EINVOICES: [], FINVOICES: [], CINVOICES: [],
});

const paired = await getSales(pairClient, range);
eq("cancelled documents included by default", paired.documents.length, 3);
eq("matched pairs found across non-adjacent numbers", paired.cancellations?.matchedPairs, 1);
eq("nothing straddles the range", paired.cancellations?.straddlingRange.length, 0);
// +1170 +1053 -1053 -- the pair cancels out, leaving only the real sale.
eq("pair nets to zero in the total", paired.summary.byCurrency[0]?.total, 1170);

console.log("\n5. A storno dated outside the range is flagged, not silently skewing totals");

// The case that matters: the sale is inside the window, its reversal is not.
const straddleClient = stub({
  AINVOICES: [
    { IVNUM: "A1", IVDATE: "2026-01-05T00:00:00Z", CUSTNAME: "C1", CODE: "", QPRICE: 1000, VAT: 170, TOTPRICE: 1170, FINAL: "Y", DEBIT: "D", IVTYPE: "A" },
    { IVNUM: "A7", IVDATE: "2026-01-06T00:00:00Z", CUSTNAME: "C1", CODE: "", QPRICE: 900, VAT: 153, TOTPRICE: 1053, FINAL: "Y", DEBIT: "D", IVTYPE: "A", STORNOFLAG: "Y", STATDES: "מבוטלת" },
    // its -1053 counterpart is dated in March, outside dateFrom..dateTo
  ],
  EINVOICES: [], FINVOICES: [], CINVOICES: [],
});

const straddled = await getSales(straddleClient, range);
eq("one document straddles the range", straddled.cancellations?.straddlingRange.length, 1);
eq("the straddling document is identified", straddled.cancellations?.straddlingRange[0]?.docNum, "A7");
eq("its full amount is reported", straddled.cancellations?.straddlingRange[0]?.total, 1053);
if ((straddled.cancellations?.note ?? "").includes("OUTSIDE this date range")) {
  ok("note explains the counterpart is outside the range");
} else bad("note does not explain the straddling counterpart");

const excluded = await getSales(straddleClient, { ...range, includeCancelled: false });
eq("includeCancelled=false still drops them", excluded.documents.length, 1);
eq("and reports how many were dropped", excluded.filters.cancelledExcluded, 1);

console.log("\n6. An empty range is rejected outright");
try {
  await getSales(client, { dateFrom: "2026-02-01", dateTo: "2026-01-01" });
  bad("reversed date range was accepted");
} catch (err) {
  if (err instanceof Error && err.message.includes("is after")) ok("reversed date range rejected");
  else bad(`unexpected error: ${String(err)}`);
}

console.log(failures === 0 ? "\nAll logic checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
