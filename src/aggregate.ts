import { PriorityODataClient } from "./odata.js";
import { loadResultLimits, uncapped } from "./config.js";

// Aggregation, performed by this server rather than by Priority.
//
// Measured on the reference server: `$apply` is ACCEPTED AND IGNORED. Seven forms
// -- aggregate($count), groupby, filter-then-groupby, distinct -- all returned
// HTTP 200 with every row and every column, unaggregated. Same trap as
// `$count=true`. So there is no server-side grouping to delegate to.
//
// The consequence is not merely inconvenience. Without this, "sales per month"
// means paging thousands of rows THROUGH THE MODEL'S CONTEXT and summing there:
// slow, expensive, capped at 500 rows per call, and bounded by how much the model
// can hold. Doing the same paging here costs no tokens at all, so the ceiling
// disappears and the reply is a handful of group rows instead of thousands of
// detail rows.

export type AggFn = "count" | "sum" | "avg" | "min" | "max";

export interface AggregateSpec {
  /** Columns to group by. Empty means one grand-total row. */
  groupBy: string[];
  /** Aggregations to compute, e.g. [{ fn: "sum", column: "QPRICE" }]. */
  aggregate: { fn: AggFn; column?: string; as?: string }[];
}

export interface AggregateResult {
  source: string;
  groupBy: string[];
  rowsScanned: number;
  groupCount: number;
  pagesFetched: number;
  complete: boolean;
  groups: Record<string, unknown>[];
  notes: string[];
}

/**
 * Rows read per request while scanning. The server's own hard ceiling.
 *
 * NOT a limit on the answer, and the easiest number here to misread as one: the
 * scan keeps requesting pages of this size until the data runs out.
 */
const SCAN_PAGE = 500;

const LIMITS = loadResultLimits();

/**
 * Safety ceiling on a scan.
 *
 * Aggregation reads every matching row, so an unfiltered scan of a large screen
 * is the one way this tool can be expensive. Stopping at a known point and saying
 * so beats either hanging or silently reporting a partial total as final.
 *
 * Those rows cost requests and time and no context at all -- they are summed here
 * and only the group rows are returned -- so this is the ceiling to raise when an
 * answer genuinely needs more data. PRIORITY_MAX_SCAN_ROWS=0 removes it, and then
 * a scan runs until the data ends or the per-session request budget stops it.
 */
const MAX_SCAN_ROWS = uncapped(LIMITS.scanRows);
/**
 * Ceiling on distinct groups.
 *
 * Guards against grouping by an identifier by accident, which turns an answer
 * into a row dump. Set well above what a real question needs: an ERP legitimately
 * has thousands of customers or parts, and 1000 turned out to be low enough to
 * cut off an ordinary group-by over 1084 parts.
 *
 * Hitting it aborts the scan rather than continuing without creating new groups.
 * Continuing would leave the groups already collected with counts that silently
 * omit later rows -- a wrong number that looks right.
 *
 * PRIORITY_MAX_GROUPS=0 removes it. Unlike the scan ceiling, every group DOES
 * land in the reply, so this one is a context cost as well as a memory one.
 */
const MAX_GROUPS = uncapped(LIMITS.groups);

const NUMERIC_FNS: AggFn[] = ["sum", "avg", "min", "max"];

/** Default output name, matching what a reader would expect to see. */
function outputName(a: { fn: AggFn; column?: string; as?: string }): string {
  if (a.as) return a.as;
  return a.fn === "count" ? "count" : `${a.fn}_${a.column ?? "value"}`;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Format a group key value for output.
 *
 * Dates are truncated to the day. Grouping by a raw DateTimeOffset produces one
 * group per timestamp, which is never what "group by date" means and quietly
 * turns a 12-row answer into a 4000-row one.
 */
function keyValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  return v;
}

export async function runAggregate(
  client: PriorityODataClient,
  entity: string,
  spec: AggregateSpec,
  opts: { filter?: string; maxRows?: number } = {},
): Promise<AggregateResult> {
  const notes: string[] = [];
  const maxRows = Math.min(opts.maxRows ?? MAX_SCAN_ROWS, MAX_SCAN_ROWS);

  for (const a of spec.aggregate) {
    if (NUMERIC_FNS.includes(a.fn) && !a.column) {
      throw new Error(`'${a.fn}' needs a column; only 'count' can be used without one.`);
    }
  }

  // Fetch only what the aggregation reads. This is the difference between paging
  // a 200-column screen and paging three columns, and it is safe here because
  // aggregation never combines $select with $expand.
  const needed = new Set<string>(spec.groupBy);
  for (const a of spec.aggregate) if (a.column) needed.add(a.column);
  const select = [...needed];

  interface Acc {
    key: Record<string, unknown>;
    count: number;
    sums: Map<string, number>;
    mins: Map<string, number>;
    maxs: Map<string, number>;
    counts: Map<string, number>;
    nonNumeric: Set<string>;
  }
  const acc = new Map<string, Acc>();

  let scanned = 0;
  let pages = 0;
  let complete = true;

  for (;;) {
    const page = await client.query(entity, {
      top: SCAN_PAGE,
      ...(scanned ? { skip: scanned } : {}),
      ...(opts.filter ? { filter: opts.filter } : {}),
      ...(select.length ? { select } : {}),
    });
    pages++;
    if (page.length === 0) break;
    scanned += page.length;

    for (const row of page) {
      const key: Record<string, unknown> = {};
      for (const g of spec.groupBy) key[g] = keyValue(row[g]);
      const id = JSON.stringify(spec.groupBy.map((g) => key[g]));

      let bucket = acc.get(id);
      if (!bucket) {
        if (acc.size >= MAX_GROUPS) {
          complete = false;
          notes.push(
            `Stopped adding groups at ${MAX_GROUPS}. '${spec.groupBy.join(", ")}' has too ` +
              `many distinct values to group by usefully — filter first, or group by a ` +
              `coarser column.`,
          );
          break;
        }
        bucket = {
          key,
          count: 0,
          sums: new Map(),
          mins: new Map(),
          maxs: new Map(),
          counts: new Map(),
          nonNumeric: new Set(),
        };
        acc.set(id, bucket);
      }

      bucket.count++;
      for (const a of spec.aggregate) {
        if (!a.column) continue;
        const raw = row[a.column];
        if (raw === null || raw === undefined) continue;
        const n = toNumber(raw);
        if (n === null) {
          bucket.nonNumeric.add(a.column);
          continue;
        }
        bucket.counts.set(a.column, (bucket.counts.get(a.column) ?? 0) + 1);
        bucket.sums.set(a.column, (bucket.sums.get(a.column) ?? 0) + n);
        const mn = bucket.mins.get(a.column);
        if (mn === undefined || n < mn) bucket.mins.set(a.column, n);
        const mx = bucket.maxs.get(a.column);
        if (mx === undefined || n > mx) bucket.maxs.set(a.column, n);
      }
    }

    // A short page means the end. This server has no nextLink and no total, so
    // the page being under the ceiling is the only end-of-data signal there is.
    if (page.length < SCAN_PAGE) break;
    if (scanned >= maxRows) {
      complete = false;
      notes.push(
        `Stopped after ${scanned} rows (the scan ceiling). These totals cover only ` +
          `the rows read so far and are a LOWER BOUND, not the answer. Add a filter ` +
          `to narrow the scan.`,
      );
      break;
    }
    if (!complete) break;
  }

  const groups = [...acc.values()].map((b) => {
    const out: Record<string, unknown> = { ...b.key };
    for (const a of spec.aggregate) {
      const name = outputName(a);
      if (a.fn === "count") {
        out[name] = b.count;
        continue;
      }
      const col = a.column!;
      const n = b.counts.get(col) ?? 0;
      if (n === 0) {
        out[name] = null;
        continue;
      }
      if (a.fn === "sum") out[name] = round(b.sums.get(col) ?? 0);
      else if (a.fn === "avg") out[name] = round((b.sums.get(col) ?? 0) / n);
      else if (a.fn === "min") out[name] = round(b.mins.get(col) ?? 0);
      else if (a.fn === "max") out[name] = round(b.maxs.get(col) ?? 0);
    }
    return out;
  });

  // Largest first: with a cap on what is shown, the big groups are the ones that
  // carry the answer.
  const firstNumeric = spec.aggregate.find((a) => a.fn !== "count");
  const sortKey = firstNumeric ? outputName(firstNumeric) : "count";
  const hasCount = spec.aggregate.some((a) => a.fn === "count");
  if (hasCount || firstNumeric) {
    groups.sort((x, y) => Number(y[sortKey] ?? 0) - Number(x[sortKey] ?? 0));
  }

  const nonNumeric = new Set<string>();
  for (const b of acc.values()) for (const c of b.nonNumeric) nonNumeric.add(c);
  if (nonNumeric.size) {
    notes.push(
      `Non-numeric values were skipped in: ${[...nonNumeric].join(", ")}. Those rows ` +
        `counted toward 'count' but not toward the numeric aggregates.`,
    );
  }

  if (complete) {
    notes.push(
      `Complete: every matching row was read (${scanned} rows over ${pages} request(s)) ` +
        `and these totals are final.`,
    );
  }

  notes.push(
    "Aggregated by this server, not by Priority — the OData $apply option is " +
      "accepted and silently ignored here, so grouping is done while paging.",
  );

  return {
    source: entity,
    groupBy: spec.groupBy,
    rowsScanned: scanned,
    groupCount: groups.length,
    pagesFetched: pages,
    complete,
    groups,
    notes,
  };
}

/** Money and quantities: avoid 0.30000000000000004 in a total. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// distinct values
// ---------------------------------------------------------------------------

export interface DistinctResult {
  source: string;
  column: string;
  rowsScanned: number;
  distinctCount: number;
  complete: boolean;
  values: { value: unknown; count: number }[];
  notes: string[];
}

/**
 * The values a column actually takes, with counts.
 *
 * This closes the quietest failure mode there is. Nothing in the metadata says
 * that IVTYPE is 'A' or DEBIT is 'D', so a model has to guess; a filter on a value
 * that does not exist returns zero rows, and zero rows reads as "no data" rather
 * than "wrong guess". One call removes the whole class.
 */
export async function runDistinct(
  client: PriorityODataClient,
  entity: string,
  column: string,
  opts: { filter?: string; limit?: number; maxRows?: number } = {},
): Promise<DistinctResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const result = await runAggregate(
    client,
    entity,
    { groupBy: [column], aggregate: [{ fn: "count", as: "count" }] },
    { ...(opts.filter === undefined ? {} : { filter: opts.filter }), ...(opts.maxRows === undefined ? {} : { maxRows: opts.maxRows }) },
  );

  const values = result.groups
    .map((g) => ({ value: g[column] ?? null, count: Number(g["count"] ?? 0) }))
    .sort((a, b) => b.count - a.count);

  const notes = [...result.notes];
  if (values.length > limit) {
    notes.push(
      `${values.length} distinct values found; showing the ${limit} most common. ` +
        `A column with this many values is probably an identifier rather than a code.`,
    );
  }

  return {
    source: entity,
    column,
    rowsScanned: result.rowsScanned,
    distinctCount: values.length,
    complete: result.complete,
    values: values.slice(0, limit),
    notes,
  };
}
