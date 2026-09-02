import {
  PriorityODataClient,
  ScreenNotEnabledForApi,
  type QueryOptions,
} from "./odata.js";
import {
  DEFAULT_MAX_ROWS,
  DOC_TYPES,
  PAYMENT_FIELDS,
  headerFields,
  lineFields,
  type DocType,
  type SalesInput,
} from "./salesSchema.js";

// Reads the four sales screens and flattens them into one shape. The point of
// the normalization is that the model sees a single row type and never has to
// know that FINVOICES alone uses TAXSUM instead of VAT, or that FINVOICEITEMS
// has no TOTPRICE column.

export interface SalesLine {
  part: string | null;
  description: string | null;
  qty: number | null;
  unit: string | null;
  price: number | null;
  lineTotal: number | null;
}

export interface SalesPayment {
  payDate: string | null;
  amount: number | null;
  currency: string | null;
  details: string | null;
}

export interface SalesDoc {
  docType: DocType;
  docLabel: string;
  docNum: string | null;
  date: string | null;
  customer: string | null;
  customerName: string | null;
  currency: string;
  /** Destination country. Export invoices only; null elsewhere. */
  country: string | null;
  beforeVat: number | null;
  vat: number | null;
  total: number | null;
  /** +1 for a sale, -1 for a credit note. */
  sign: 1 | -1;
  /** `total * sign` -- the value to add up for net sales. */
  totalSigned: number | null;
  status: string | null;
  isFinal: boolean;
  /** True for a cancelled (storno) document. Excluded by default. */
  isCancelled: boolean;
  /** Priority's `DEBIT` column: 'D' debit, 'C' credit. The source of `sign`. */
  debit: string | null;
  /** Priority's `IVTYPE`: which screen the row belongs to, not its direction. */
  ivType: string | null;
  agent: string | null;
  details: string | null;
  lines?: SalesLine[];
  payments?: SalesPayment[];
}

export interface CurrencySummary {
  currency: string;
  documents: number;
  beforeVat: number;
  vat: number;
  total: number;
  /** Total after subtracting credit notes. This is the net sales figure. */
  netTotal: number;
}

export interface DocTypeSummary {
  docType: DocType;
  label: string;
  documents: number;
  /** Per-currency totals, because a single cross-currency total is meaningless. */
  byCurrency: CurrencySummary[];
}

export interface CancellationReport {
  documentsIncluded: number;
  /** Reversing pairs with both halves inside the range. These net to zero. */
  matchedPairs: number;
  /**
   * Cancelled documents whose counterpart falls OUTSIDE the date range.
   *
   * Each one moves the period total by its full amount with nothing to offset
   * it — a lone negative reversal of a sale booked in an earlier period, or a
   * sale whose reversal lands in a later one. Not an error: that is how the
   * books read. But it is the explanation for a total that looks wrong.
   */
  straddlingRange: {
    docType: DocType;
    docNum: string | null;
    date: string | null;
    customer: string | null;
    currency: string;
    total: number | null;
  }[];
  note: string;
}

export interface SalesResult {
  dateFrom: string;
  dateTo: string;
  filters: {
    customer?: string;
    part?: string;
    finalOnly: boolean;
    includeCancelled: boolean;
    /** How many cancelled documents were dropped, when includeCancelled is false. */
    cancelledExcluded: number;
  };
  /** Present when any cancelled document falls inside the range. */
  cancellations?: CancellationReport;
  /**
   * Totals grouped by currency. There is deliberately no single global total:
   * FINVOICES are denominated in foreign currency, so adding them to shekel
   * documents would produce a number that means nothing.
   */
  summary: {
    note: string;
    /** Interpretation risks the data cannot settle — surfaced, not resolved. */
    warnings?: string[];
    byCurrency: CurrencySummary[];
    byDocType: DocTypeSummary[];
  };
  documents: SalesDoc[];
  truncated: boolean;
  truncationNote?: string;
  /** Screens that are not open to the API on this server, if any. */
  skipped?: { docType: DocType; reason: string }[];
}

// ---------------------------------------------------------------------------
// Date literals
// ---------------------------------------------------------------------------

// Priority declares IVDATE as either Edm.Date or Edm.DateTimeOffset depending on
// the screen and version, and the two need different filter literals. Rather
// than guess, read it once from GetMetadataFor and cache it for the process.
const dateTypeCache = new Map<string, string>();

async function ivdateType(client: PriorityODataClient, entity: string): Promise<string> {
  const cached = dateTypeCache.get(entity);
  if (cached) return cached;

  let type = "Edm.DateTimeOffset";
  try {
    const meta = await client.metadataFor(entity);
    const found = meta.get(entity)?.props.get("IVDATE");
    if (found) type = found;
  } catch (err) {
    if (err instanceof ScreenNotEnabledForApi) throw err;
    // Metadata is a nicety here, not a requirement: fall back to the far more
    // common DateTimeOffset rather than failing the whole query.
  }
  dateTypeCache.set(entity, type);
  return type;
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * An inclusive `[from, to]` day range.
 *
 * Expressed as `>= from` and `< to+1day` rather than `<= to`, so a document
 * stamped partway through the last day is not dropped by a time component.
 */
function dateRangeFilter(edmType: string, from: string, to: string): string {
  if (edmType === "Edm.Date") {
    return `IVDATE ge ${from} and IVDATE le ${to}`;
  }
  return `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${nextDay(to)}T00:00:00Z`;
}

// ---------------------------------------------------------------------------
// Coercion helpers -- Priority is inconsistent about numeric vs string columns
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export async function getSales(
  client: PriorityODataClient,
  input: SalesInput,
): Promise<SalesResult> {
  const docTypes = (input.docTypes ?? (Object.keys(DOC_TYPES) as DocType[])) as DocType[];
  const finalOnly = input.finalOnly ?? true;
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  // A part filter is applied to the lines, so the lines have to be fetched.
  const includeLines = input.includeLines === true || input.part !== undefined;
  const includePayments = input.includePayments === true;

  if (input.dateFrom > input.dateTo) {
    throw new Error(
      `dateFrom (${input.dateFrom}) is after dateTo (${input.dateTo}) — the range is empty.`,
    );
  }

  // Default ON. A cancellation is a real, dated event in the books; dropping it
  // makes a period disagree with Priority's own reports.
  const includeCancelled = input.includeCancelled !== false;

  const documents: SalesDoc[] = [];
  const skipped: { docType: DocType; reason: string }[] = [];
  let truncated = false;
  let cancelledExcluded = 0;

  for (const docType of docTypes) {
    const spec = DOC_TYPES[docType];

    let filter: string;
    try {
      filter = dateRangeFilter(await ivdateType(client, docType), input.dateFrom, input.dateTo);
    } catch (err) {
      if (err instanceof ScreenNotEnabledForApi) {
        skipped.push({ docType, reason: err.message });
        continue;
      }
      throw err;
    }

    if (input.customer) {
      filter += ` and ${spec.customerField} eq ${odataQuote(input.customer)}`;
    }
    if (finalOnly) {
      filter += ` and FINAL eq 'Y'`;
    }

    const expandClauses: string[] = [];
    if (includeLines) {
      expandClauses.push(`${spec.itemsNav}($select=${lineFields(docType).join(",")})`);
    }
    if (includePayments && spec.paymentsNav) {
      expandClauses.push(`${spec.paymentsNav}($select=${PAYMENT_FIELDS.join(",")})`);
    }

    const opts: QueryOptions = {
      filter,
      // $top caps TOTAL rows on Priority, which is exactly the cap we want.
      top: maxRows,
      // Measured against a live server: combining `$select` on the PARENT with
      // `$expand` makes Priority abort the response part-way through the JSON --
      // HTTP 200, correct headers, then the connection closes mid-object. Every
      // variant carrying a parent `$select` alongside `$expand` failed; every
      // variant without one succeeded. So when lines are requested the parent
      // `$select` is dropped and the full header row is accepted. The nested
      // `$select` inside `$expand` is safe and still limits the line columns
      // (5.4 KB per 3 documents instead of 9.4 KB without it).
      //
      // Costs a wider header row; the normalizer reads only what it needs, and
      // the alternative is no line detail at all.
      ...(expandClauses.length
        ? { expand: expandClauses.join(",") }
        : { select: headerFields(docType) }),
    };

    let rows: Record<string, unknown>[];
    try {
      rows = await client.query(docType, opts);
    } catch (err) {
      if (err instanceof ScreenNotEnabledForApi) {
        skipped.push({ docType, reason: err.message });
        continue;
      }
      throw err;
    }

    if (rows.length >= maxRows) truncated = true;

    for (const row of rows) {
      const doc = normalizeDoc(docType, row, includeLines, includePayments);

      // Filtered here rather than in $filter on purpose. Priority leaves
      // STORNOFLAG null on live documents, and in OData `STORNOFLAG ne 'Y'`
      // evaluates to null for those rows -- which excludes them, silently
      // dropping every document that is NOT cancelled. Client-side has no such
      // trap; the cost is that cancelled rows still consume the maxRows cap.
      if (doc.isCancelled && !includeCancelled) {
        cancelledExcluded++;
        continue;
      }

      if (input.part) {
        const wanted = input.part.toUpperCase();
        const matching = (doc.lines ?? []).filter((l) => (l.part ?? "").toUpperCase() === wanted);
        if (matching.length === 0) continue;
        doc.lines = matching;
      }
      documents.push(doc);
    }
  }

  documents.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  const result: SalesResult = {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    filters: {
      ...(input.customer ? { customer: input.customer } : {}),
      ...(input.part ? { part: input.part } : {}),
      finalOnly,
      includeCancelled,
      cancelledExcluded,
    },
    summary: buildSummary(documents),
    documents,
    truncated,
  };

  const cancellations = analyseCancellations(documents);
  if (cancellations) result.cancellations = cancellations;

  if (truncated) {
    result.truncationNote =
      `At least one document type returned the maximum of ${maxRows} documents, so ` +
      `these results are INCOMPLETE and the totals are a lower bound. Report this to ` +
      `the user rather than presenting the totals as final. Narrow the date range, ` +
      `filter by customer, or raise maxRows (hard maximum 1000).`;
    if (input.part) {
      result.truncationNote +=
        ` The part filter was applied after fetching, so documents containing ` +
        `'${input.part}' beyond the cap were not seen at all.`;
    }
  }
  if (skipped.length) result.skipped = skipped;

  return result;
}

function normalizeDoc(
  docType: DocType,
  row: Record<string, unknown>,
  includeLines: boolean,
  includePayments: boolean,
): SalesDoc {
  const spec = DOC_TYPES[docType];
  const total = num(row["TOTPRICE"]);
  const debit = str(row["DEBIT"]);

  // Direction comes from the row, not from the screen. Measured on a live server:
  // CINVOICES rows are 174-positive / 11-negative debits, so negating the screen
  // (as this code once did, reading the "C" as "credit") inverted real sales.
  // DEBIT='C' is the actual credit marker, and it is rare.
  const sign: 1 | -1 = debit?.toUpperCase() === "C" ? -1 : 1;

  const doc: SalesDoc = {
    docType,
    docLabel: spec.label,
    docNum: str(row["IVNUM"]),
    date: str(row["IVDATE"])?.slice(0, 10) ?? null,
    customer: str(row[spec.customerField]),
    customerName: str(row["CDES"]),
    // An empty currency column means the company's local currency.
    currency: str(row["CODE"]) ?? "LOCAL",
    country: spec.foreign ? str(row["CRDES"]) : null,
    beforeVat: num(row["QPRICE"]),
    vat: num(row[spec.vatField]),
    total,
    sign,
    totalSigned: total === null ? null : total * sign,
    status: str(row["STATDES"]),
    isFinal: str(row["FINAL"])?.toUpperCase() === "Y",
    isCancelled: str(row["STORNOFLAG"])?.toUpperCase() === "Y",
    debit,
    ivType: str(row["IVTYPE"]),
    agent: str(row["AGENTNAME"]),
    details: str(row["DETAILS"]),
  };

  if (includeLines) {
    const raw = row[spec.itemsNav];
    doc.lines = (Array.isArray(raw) ? raw : []).map((l) => {
      const line = l as Record<string, unknown>;
      return {
        part: str(line["PARTNAME"]),
        description: str(line["PDES"]),
        qty: num(line["QUANT"]),
        unit: str(line["UNITNAME"]),
        price: num(line["PRICE"]),
        // FINVOICEITEMS has no TOTPRICE at all -- lineTotalField points at
        // QPRICE there. This is the whole reason the field is configurable.
        lineTotal: num(line[spec.lineTotalField]),
      };
    });
  }

  if (includePayments && spec.paymentsNav) {
    const raw = row[spec.paymentsNav];
    doc.payments = (Array.isArray(raw) ? raw : []).map((p) => {
      const pay = p as Record<string, unknown>;
      return {
        payDate: str(pay["PAYDATE"])?.slice(0, 10) ?? null,
        amount: num(pay["QPRICE"]),
        currency: str(pay["CODE"]),
        details: str(pay["DETAILS"]),
      };
    });
  }

  return doc;
}

/**
 * Pair up cancelled documents and report the ones left standing alone.
 *
 * Priority cancels by writing a mirror-image reversing document: same customer,
 * same currency, equal and opposite amount, both marked STORNOFLAG='Y'. Together
 * a pair nets to zero, so a range containing both halves is unaffected by them.
 *
 * The pairs are matched on AMOUNT, not on document number. Observed on a live
 * server: SI226000019 (+12,195.81) pairs with SI226000024 (-12,195.81) — five
 * numbers apart, with unrelated documents in between. Anything keyed on adjacency
 * would mis-pair them.
 *
 * The halves are dated independently, so a reversal can land in a later period
 * than the sale it cancels. When only one half falls inside the requested range,
 * the period total genuinely moves by that amount, and that is worth saying out
 * loud rather than leaving as an unexplained figure.
 */
function analyseCancellations(documents: SalesDoc[]): CancellationReport | undefined {
  const cancelled = documents.filter((d) => d.isCancelled);
  if (cancelled.length === 0) return undefined;

  const buckets = new Map<string, { positive: SalesDoc[]; negative: SalesDoc[] }>();
  for (const doc of cancelled) {
    const amount = Math.abs(round2(doc.total ?? 0));
    const key = `${doc.docType}|${doc.customer ?? ""}|${doc.currency}|${amount.toFixed(2)}`;
    const bucket = buckets.get(key) ?? { positive: [], negative: [] };
    ((doc.total ?? 0) < 0 ? bucket.negative : bucket.positive).push(doc);
    buckets.set(key, bucket);
  }

  let matchedPairs = 0;
  const straddling: SalesDoc[] = [];
  for (const { positive, negative } of buckets.values()) {
    const pairs = Math.min(positive.length, negative.length);
    matchedPairs += pairs;
    // Whichever side is longer has leftovers with no counterpart in range.
    straddling.push(...positive.slice(pairs), ...negative.slice(pairs));
  }

  const note =
    straddling.length === 0
      ? `All ${matchedPairs} cancellation pair(s) have both halves inside this date ` +
        `range, so they net to zero and do not affect the totals.`
      : `${straddling.length} cancelled document(s) have their reversing counterpart ` +
        `OUTSIDE this date range — a cancellation is dated when it happened, not ` +
        `backdated to the original. Each one shifts the totals by its full amount ` +
        `with nothing here to offset it, which is usually the reason a period looks ` +
        `unexpectedly high or negative. Widen the date range to see both halves. ` +
        `Report this when explaining the figures.`;

  return {
    documentsIncluded: cancelled.length,
    matchedPairs,
    straddlingRange: straddling.map((d) => ({
      docType: d.docType,
      docNum: d.docNum,
      date: d.date,
      customer: d.customer,
      currency: d.currency,
      total: d.total,
    })),
    note,
  };
}

function buildSummary(documents: SalesDoc[]): SalesResult["summary"] {
  const byCurrency = summarizeByCurrency(documents);

  const byDocType: DocTypeSummary[] = [];
  const grouped = new Map<DocType, SalesDoc[]>();
  for (const doc of documents) {
    const bucket = grouped.get(doc.docType);
    if (bucket) bucket.push(doc);
    else grouped.set(doc.docType, [doc]);
  }
  for (const [docType, docs] of grouped) {
    byDocType.push({
      docType,
      label: DOC_TYPES[docType].label,
      documents: docs.length,
      byCurrency: summarizeByCurrency(docs),
    });
  }

  const types = new Set(documents.map((d) => d.docType));
  const warnings: string[] = [];

  // CINVOICES is 'חשבוניות מרכזות' — consolidated invoices. Whether it aggregates
  // documents that also appear on their own screen is an accounting question the
  // data cannot answer, and getting it wrong double-counts revenue. Flag it
  // instead of silently picking an interpretation, which is the mistake that
  // produced the earlier wrong totals.
  if (types.has("CINVOICES") && types.size > 1) {
    warnings.push(
      "CINVOICES is 'חשבוניות מרכזות' (consolidated invoices), not credit notes. " +
        "If it consolidates documents that also appear on another screen in this " +
        "result, these totals double-count them. Confirm with the user how their " +
        "installation uses it before presenting a combined figure, or report the " +
        "document types separately.",
    );
  }

  return {
    note:
      "Totals are grouped by currency and MUST NOT be added across currencies. " +
      "Each document's direction comes from its DEBIT column ('C' = credit, " +
      "counted negatively), not from which screen it is on. netTotal applies " +
      "those signs.",
    ...(warnings.length ? { warnings } : {}),
    byCurrency,
    byDocType,
  };
}

function summarizeByCurrency(documents: SalesDoc[]): CurrencySummary[] {
  const acc = new Map<string, CurrencySummary>();

  for (const doc of documents) {
    let entry = acc.get(doc.currency);
    if (!entry) {
      entry = {
        currency: doc.currency,
        documents: 0,
        beforeVat: 0,
        vat: 0,
        total: 0,
        netTotal: 0,
      };
      acc.set(doc.currency, entry);
    }
    entry.documents += 1;
    entry.beforeVat += doc.beforeVat ?? 0;
    entry.vat += doc.vat ?? 0;
    entry.total += doc.total ?? 0;
    entry.netTotal += doc.totalSigned ?? 0;
  }

  return [...acc.values()]
    .map((e) => ({
      ...e,
      beforeVat: round2(e.beforeVat),
      vat: round2(e.vat),
      total: round2(e.total),
      netTotal: round2(e.netTotal),
    }))
    .sort((a, b) => b.total - a.total);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
