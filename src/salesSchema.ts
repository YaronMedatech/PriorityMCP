import { z } from "zod";

// The four sales document screens, and the per-screen differences that the
// normalizer in sales.ts exists to absorb. Verified against a live server's
// GetMetadataFor output -- `npm run probe` re-verifies it against yours.

export interface DocTypeSpec {
  /** Hebrew label, surfaced to the model so it can name the document type. */
  label: string;
  /** English label, for the tool description. */
  labelEn: string;
  /** Navigation property holding the item lines. */
  itemsNav: string;
  /** Header column holding the customer code. */
  customerField: string;
  /** Header column holding the VAT amount -- NOT the same on every screen. */
  vatField: string;
  /** Line column holding the line total -- NOT the same on every screen. */
  lineTotalField: string;
  /** Navigation property holding payment lines, where the document has any. */
  paymentsNav: string | null;
  /** True for export documents, which are denominated in foreign currency. */
  foreign: boolean;
}

// Deliberately absent: a per-screen `sign`.
//
// An earlier version carried one and set it to -1 for CINVOICES, on the
// assumption that the C stood for "credit". It does not — Priority's own
// dictionary titles that screen `חשבוניות מרכזות` (consolidated invoices), and
// measuring the data showed 174 of its 187 final rows are ordinary positive
// debits. Negating the screen inverted a large part of the totals.
//
// Direction is a property of the ROW, not of the screen. All four screens share
// the `INVOICES` table; `IVTYPE` (A/E/F/C) merely says which screen a row belongs
// to, while `DEBIT` (D/C) carries the actual debit-or-credit direction. So the
// sign is read from `DEBIT` per row, and `TOTPRICE` keeps whatever sign Priority
// already gave it.

export const DOC_TYPES = {
  AINVOICES: {
    label: 'חשבונית מס',
    labelEn: "tax invoice",
    itemsNav: "AINVOICEITEMS_SUBFORM",
    customerField: "CUSTNAME",
    vatField: "VAT",
    lineTotalField: "TOTPRICE",
    paymentsNav: null,
    foreign: false,
  },
  EINVOICES: {
    label: 'חשבונית מס-קבלה',
    labelEn: "tax invoice + receipt",
    itemsNav: "EINVOICEITEMS_SUBFORM",
    customerField: "CUSTNAME",
    vatField: "VAT",
    lineTotalField: "TOTPRICE",
    // An invoice-receipt settles itself, so it carries payment lines alongside
    // the item lines. They are returned separately, never merged into `lines`.
    paymentsNav: "EPAYMENT_SUBFORM",
    foreign: false,
  },
  FINVOICES: {
    label: 'חשבונית חו"ל',
    labelEn: "export invoice",
    itemsNav: "FINVOICEITEMS_SUBFORM",
    customerField: "CUSTNAME",
    // The two ways FINVOICES differs from its siblings: the header VAT column is
    // TAXSUM rather than VAT, and FINVOICEITEMS has no TOTPRICE column at all.
    vatField: "TAXSUM",
    lineTotalField: "QPRICE",
    paymentsNav: null,
    // Export documents are denominated in foreign currency, which is why every
    // total this tool reports is grouped by currency.
    foreign: true,
  },
  CINVOICES: {
    // Priority's own title for this screen. It is NOT a credit note, which the
    // "C" invites you to assume -- credit notes live on SALECREDITINVOICES.
    label: 'חשבוניות מרכזות',
    labelEn: "consolidated invoice",
    itemsNav: "CINVOICEITEMS_SUBFORM",
    customerField: "CUSTNAME",
    vatField: "VAT",
    lineTotalField: "TOTPRICE",
    paymentsNav: null,
    foreign: false,
  },
} as const satisfies Record<string, DocTypeSpec>;

export type DocType = keyof typeof DOC_TYPES;

export const DOC_TYPE_NAMES = Object.keys(DOC_TYPES) as [DocType, ...DocType[]];

/** Header columns shared by all four screens. */
const COMMON_HEADER_FIELDS = [
  "IVNUM",
  "IVDATE",
  "CDES",
  "CODE",
  "QPRICE",
  "TOTPRICE",
  "FINAL",
  "STATDES",
  // Cancellation (storno) marker. A cancelled document stays FINAL='Y', so
  // without this column the date+FINAL filter alone counts it as a sale.
  "STORNOFLAG",
  // Direction and document type. Both are part of the primary key on these
  // screens, and DEBIT ('D'/'C') is what actually says whether a row adds to or
  // subtracts from sales -- the screen name does not.
  "DEBIT",
  "IVTYPE",
  "AGENTNAME",
  "DETAILS",
] as const;

/** The `$select` list for one screen: shared columns plus its own variants. */
export function headerFields(docType: DocType): string[] {
  const spec = DOC_TYPES[docType];
  const fields = new Set<string>(COMMON_HEADER_FIELDS);
  fields.add(spec.customerField);
  fields.add(spec.vatField);
  // Country of destination -- only export invoices carry it.
  if (spec.foreign) fields.add("CRDES");
  return [...fields];
}

/** The nested `$select` for item lines on one screen. */
export function lineFields(docType: DocType): string[] {
  const spec = DOC_TYPES[docType];
  const fields = new Set<string>(["PARTNAME", "PDES", "QUANT", "UNITNAME", "PRICE"]);
  fields.add(spec.lineTotalField);
  return [...fields];
}

export const PAYMENT_FIELDS = ["PAYDATE", "QPRICE", "CODE", "DETAILS"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const salesInputShape = {
  docTypes: z
    .array(z.enum(DOC_TYPE_NAMES))
    .optional()
    .describe(
      "Which sales document screens to read. Defaults to all four " +
        "(AINVOICES, EINVOICES, FINVOICES, CINVOICES) = net sales. " +
        "AINVOICES = tax invoice. EINVOICES = tax invoice + receipt. " +
        "FINVOICES = export invoice, denominated in FOREIGN CURRENCY. " +
        "CINVOICES = credit note, counted NEGATIVELY.",
    ),
  dateFrom: z
    .string()
    .regex(ISO_DATE, "must be YYYY-MM-DD")
    .describe("Start of the document-date range, inclusive. Format YYYY-MM-DD."),
  dateTo: z
    .string()
    .regex(ISO_DATE, "must be YYYY-MM-DD")
    .describe("End of the document-date range, inclusive. Format YYYY-MM-DD."),
  customer: z
    .string()
    .optional()
    .describe("Filter to one customer code (Priority CUSTNAME), e.g. 'C00100'. Exact match."),
  part: z
    .string()
    .optional()
    .describe(
      "Filter to documents containing this part code (PARTNAME). " +
        "Requires includeLines=true; lines are filtered to this part as well.",
    ),
  includeLines: z
    .boolean()
    .optional()
    .describe(
      "Include item lines (part, quantity, price) per document. " +
        "Default false -- omit unless the question is about parts or quantities, " +
        "since lines multiply the response size.",
    ),
  includePayments: z
    .boolean()
    .optional()
    .describe(
      "Include payment lines. Only EINVOICES carries them; ignored for other types.",
    ),
  finalOnly: z
    .boolean()
    .optional()
    .describe("Only finalized documents (FINAL='Y'). Default true. Set false to include drafts."),
  includeCancelled: z
    .boolean()
    .optional()
    .describe(
      "Include cancelled (storno) documents. DEFAULT TRUE. Priority records a " +
        "cancellation as a mirror-image reversing document, and each half is dated " +
        "when it happened — the reversal is not backdated to the original. Keeping " +
        "both halves is what makes a period's figures match the books. Set false " +
        "only to see uncancelled activity in isolation.",
    ),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum documents per document type. Default 200, hard maximum 1000."),
};

export const salesInputSchema = z.object(salesInputShape);
export type SalesInput = z.infer<typeof salesInputSchema>;

export const DEFAULT_MAX_ROWS = 200;
