import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { loadConfig, safeHost, type PriorityConfig } from "./config.js";
import { RequestBudget } from "./ratelimit.js";

// A thin Priority OData client. The value here is not the HTTP plumbing -- it is
// the set of Priority-specific behaviours encoded below. Each one was measured
// against a live Priority server, and the comments are the reason the code looks
// like this.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const EDM_NS_MARKER = "EntityType";

/** Priority says this in Hebrew, inside a JSON error body, under a 400. */
const API_DISABLED_MARKER = "לא ניתן להפעיל API";

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export class PriorityODataError extends Error {}

/**
 * A screen exists in Priority but is not exposed to the API.
 *
 * Its own words, escaped inside a JSON body, are `לא ניתן להפעיל API למסך זה`
 * under an HTTP 400 -- which reads like a bad request from our side and is not.
 * It is the most common Priority-side blocker, so it gets its own type.
 */
export class ScreenNotEnabledForApi extends PriorityODataError {
  constructor(public readonly entity: string) {
    super(
      `The Priority screen ${entity} is not available to the API ` +
        `(HTTP 400 "לא ניתן להפעיל API למסך זה").\n\n` +
        `Two different causes produce this identical message, and the second is ` +
        `easy to misread as the first:\n` +
        `  1. The screen is not opened for the API in Priority at all.\n` +
        `  2. It is open, but the AUTHENTICATING USER lacks permission for it. ` +
        `Observed on a real server: a PAT could read AINVOICES/CINVOICES and got ` +
        `this error on EINVOICES/FINVOICES, while a named user reached all four.\n\n` +
        `Before changing the screen definition, try the other set of credentials ` +
        `(PRIORITY_USER/PRIORITY_PASS vs PRIORITY_API_TOKEN).`,
    );
  }
}

export class PriorityAuthError extends PriorityODataError {}

export class PriorityTlsError extends PriorityODataError {}

function tlsHelp(host: string): string {
  return `The Priority server's TLS certificate is not trusted by this machine.
Almost every on-prem Priority server uses a self-signed one. Two fixes, each a
single line in .env:

  PREFERRED -- keep verifying, and trust their certificate. Export it with this
  (Windows PowerShell 5.1, no extra tools):

    $h = '${host}'
    $t = New-Object Net.Sockets.TcpClient($h, 443)
    $s = New-Object Net.Security.SslStream($t.GetStream(), $false, { $true })
    $s.AuthenticateAsClient($h)
    $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2($s.RemoteCertificate)
    "-----BEGIN CERTIFICATE-----\`n" +
      [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks') +
      "\`n-----END CERTIFICATE-----" | Set-Content priority-ca.pem -Encoding ascii
    $s.Dispose(); $t.Close()

  then in .env:
    PRIORITY_CA_BUNDLE=priority-ca.pem

  That pins the server's own certificate, which is what a self-signed one needs.
  If instead it was issued by the customer's internal CA, ask their IT for the
  CA certificate and point at that -- the leaf alone will not validate a chain.

  QUICK -- stop verifying at all. Acceptable only on a trusted internal
  network: it gives up protection against a man in the middle.
    PRIORITY_VERIFY_SSL=0`;
}

/**
 * `COL eq 'a' or COL eq 'b' or ...`
 *
 * Not `COL in ('a','b')`: Priority answers 501 Not Implemented to the `in`
 * operator. Single quotes are doubled, per OData string literal escaping.
 */
export function orFilter(column: string, values: readonly string[]): string {
  return values.map((v) => `${column} eq '${String(v).replace(/'/g, "''")}'`).join(" or ");
}

/**
 * Fixed-size chunks, because the filter goes in the URL and the URL has a length
 * limit. Measured against Priority: an or-chain holds about 50 values on its
 * own, but only ~25 once sub-forms are expanded, since the `$expand` clause
 * shares the same budget. Beyond that the server answers 404 on a URL it will
 * not parse.
 */
export function batched<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export const OR_CHAIN_LIMIT = 50;
export const OR_CHAIN_LIMIT_WITH_EXPAND = 25;

/** Stable serialization, so a row's digest does not depend on key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * A short, stable identity for one record, used to detect a page repeating rows
 * an earlier page already returned.
 */
function rowDigest(row: unknown): string {
  return crypto.createHash("sha1").update(stableStringify(row)).digest("base64");
}

export interface QueryOptions {
  select?: readonly string[];
  filter?: string;
  /** Raw `$expand` clause, e.g. `ITEMS_SUBFORM($select=PARTNAME,QUANT)`. */
  expand?: string;
  orderby?: string;
  /**
   * Measured against Priority: `$top` caps the TOTAL rows returned rather than
   * setting a page size. That is exactly what a "give me at most N" cap wants.
   */
  top?: number;
  /** Rows to skip before the first returned row — the offset for paging. */
  skip?: number;
  /** Split the pull into `$skip`/`$top` windows. Ignored when `top` is set. */
  pageSize?: number;
}

/**
 * Budget for the requests that build the dictionary and read metadata.
 *
 * Separate from PRIORITY_TIMEOUT_MS on purpose: raising that would also delay
 * every ordinary failure, and MCP clients commonly give up at 60s. Measured on
 * an installation with every screen opened to the API, the service document
 * takes ~70s to generate for only 0.14 MB, and GetMetadataFor can exceed 45s.
 */
const SLOW_METADATA_TIMEOUT_MS = 180_000;

interface RawResponse {
  status: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Metadata shapes
// ---------------------------------------------------------------------------

export interface ColumnMetadata {
  name: string;
  type: string;
  /** Hebrew title from `Priority.OData.Description`. */
  title: string | null;
  maxLength: number | null;
  nullable: boolean;
  isKey: boolean;
  mandatory: boolean;
  /** `Date` where Priority distinguishes it from a full DateTimeOffset. */
  dateType: string | null;
  autoUnique: boolean;
  readOnly: boolean;
}

export interface NavMetadata {
  name: string;
  target: string;
  title: string | null;
}

export interface EntityMetadata {
  name: string;
  title: string | null;
  keys: string[];
  columns: Map<string, ColumnMetadata>;
  navs: Map<string, NavMetadata>;
  /**
   * Column name -> OData type, the flat view.
   *
   * Kept alongside the richer `columns` map because sales.ts and probe.ts only
   * ever ask "does this column exist, and what type is it" — and reading
   * `columns.get(x)?.type` at every one of those sites would be noise.
   */
  props: Map<string, string>;
}

export class PriorityODataClient {
  private readonly cfg: PriorityConfig;
  /**
   * Per-client, and therefore per-session: stdio gives each client its own
   * process, and `openSession` in http.ts builds a fresh client per session.
   */
  private readonly budget: RequestBudget;

  constructor(cfg?: PriorityConfig) {
    this.cfg = cfg ?? loadConfig();
    this.budget = new RequestBudget(this.cfg.maxRequestsPerMinute);
  }

  get baseUrl(): string {
    return this.cfg.odataUrl;
  }

  /** The Priority company this client reads. */
  get company(): string {
    return this.cfg.company;
  }

  // -- low level -----------------------------------------------------------

  private send(url: string, timeoutMs: number): Promise<RawResponse> {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      // 'close' always follows 'end', and a destroyed request can emit both
      // 'error' and 'close'. First outcome wins; later ones are noise.
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };

      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: {
            Authorization: this.cfg.authHeader,
            Accept: "application/json",
          },
          timeout: timeoutMs,
          // TLS options are ignored by the http module; harmless to always pass.
          rejectUnauthorized: this.cfg.verifySsl,
          ca: this.cfg.caBundle,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));

          const abort = (why: string) =>
            settle(() =>
              reject(new Error(`${why} from ${safeHost(url)} after ${chunks.length} chunk(s)`)),
            );

          res.on("aborted", () => abort("response aborted"));
          res.on("end", () => {
            // A premature close looks EXACTLY like a short body: valid JSON from
            // the front, silently missing rows. res.complete is the only way to
            // tell, and treating a truncated body as data is how a total goes
            // quietly wrong.
            if (!res.complete) {
              abort("truncated body");
              return;
            }
            settle(() =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
            );
          });
          res.on("close", () => abort("socket closed"));
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error(`no response from ${safeHost(url)} within ${timeoutMs}ms`));
      });
      req.on("error", (err) => settle(() => reject(err)));
      req.end();
    });
  }

  /**
   * One request, with retries, bounded by a single overall deadline.
   *
   * The budget spans every attempt and every backoff, not each attempt
   * separately. Per-attempt timeouts alone let a dead host burn
   * `attempts x timeout + backoff` before reporting anything, which outlasts the
   * caller's own deadline and replaces a precise error with a generic one.
   */
  private async request(
    url: string,
    entityForErrors: string,
    maxRetries = 4,
    timeoutMsOverride?: number,
  ): Promise<RawResponse> {
    // Overridable because one request is legitimately far slower than the rest:
    // this server takes ~70s to generate its service document once every screen
    // is open to the API. Raising PRIORITY_TIMEOUT_MS for everything would push
    // ordinary query failures past the 60s many MCP clients allow, turning a
    // clear error into a client-side timeout.
    const budgetMs = timeoutMsOverride ?? this.cfg.timeoutMs;
    const deadline = Date.now() + budgetMs;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (Date.now() >= deadline) break;

      // Budget first, and OUTSIDE the try below: being over budget is not a
      // transport failure, and letting it fall into that catch would retry it
      // as though the server had hiccuped.
      const verdict = await this.budget.acquire(deadline);
      if (!verdict.granted) {
        throw new PriorityODataError(
          `Over the Priority request budget for this session ` +
            `(${this.budget.limit} requests/minute): a free slot is ${Math.ceil(verdict.wouldWaitMs / 1000)}s ` +
            `away and this call's ${budgetMs}ms deadline expires first.\n\n` +
            `Nothing was sent. This normally means a scan is much larger than it looks — ` +
            `narrow the filter, or lower maxRows on aggregate. If the budget is genuinely ` +
            `too tight for the work, raise PRIORITY_MAX_REQUESTS_PER_MIN in .env (0 lifts it).`,
        );
      }

      // Measured after acquire, not before: acquire() may have slept, and a
      // per-attempt timeout computed before the wait would be too generous.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      try {
        const res = await this.send(url, remaining);

        if (res.status === 400 && res.body.includes(API_DISABLED_MARKER)) {
          throw new ScreenNotEnabledForApi(entityForErrors);
        }

        if (res.status === 200) return res;

        // 401 and 403 are different problems and were reported as one, which sent
        // the reader to the wrong place: a 403 on EXEC's FORMHELP sub-form said
        // "check PRIORITY_API_TOKEN" while the same token was reading EXEC itself
        // perfectly well. 401 means the credentials were not accepted; 403 means
        // they were, and this particular thing is still not allowed.
        if (res.status === 401) {
          throw new PriorityAuthError(
            `Priority rejected the credentials (HTTP 401) for ${safeHost(url)}.\n` +
              `Check PRIORITY_API_TOKEN, or PRIORITY_USER / PRIORITY_PASS, in .env.`,
          );
        }

        if (res.status === 403) {
          throw new PriorityAuthError(
            `Priority accepted the credentials but refused access to ${entityForErrors} ` +
              `(HTTP 403).\n\n` +
              `The credentials are fine — something else is reading successfully with ` +
              `them. This specific screen, sub-form or action is not permitted for this ` +
              `user, so it is a Priority permission to grant rather than a setting here.`,
          );
        }

        if (!RETRY_STATUS.has(res.status)) {
          throw new PriorityODataError(
            `GET ${url} -> HTTP ${res.status}: ${res.body.slice(0, 400)}`,
          );
        }

        lastError = new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      } catch (err) {
        // These are conclusions, not transport hiccups: retrying cannot change
        // the answer, and doing so would hide the real message behind a timeout.
        if (
          err instanceof ScreenNotEnabledForApi ||
          err instanceof PriorityAuthError ||
          err instanceof PriorityODataError
        ) {
          throw err;
        }

        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (TLS_ERROR_CODES.has(code)) {
          throw new PriorityTlsError(`${code} for ${safeHost(url)}.\n\n${tlsHelp(safeHost(url))}`);
        }

        lastError = err as Error;
      }

      if (!(await backoff(attempt, deadline))) break;
    }

    throw new PriorityODataError(
      `Could not read ${entityForErrors} from ${safeHost(url)} within ` +
        `${budgetMs}ms.\nLast error: ${lastError?.message ?? "unknown"}\n\n` +
        `Check that PRIORITY_ODATA_URL points at a reachable Priority server, or ` +
        `raise PRIORITY_TIMEOUT_MS if the query is simply slow.`,
    );
  }

  private async getJson(
    url: string,
    entityForErrors: string,
    timeoutMsOverride?: number,
  ): Promise<Record<string, unknown>> {
    const res = await this.request(url, entityForErrors, 4, timeoutMsOverride);
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch (err) {
      // Show the END of the body as well as the start. A truncated response looks
      // perfectly valid from the front, so a head-only excerpt makes a transport
      // problem read like a Priority problem.
      throw new PriorityODataError(
        `${entityForErrors}: response was not parseable JSON ` +
          `(${res.body.length} chars). ${(err as Error).message}\n` +
          `head: ${res.body.slice(0, 200)}\n` +
          `tail: ${res.body.slice(-200)}`,
      );
    }
  }

  // -- URL building ----------------------------------------------------------

  private buildUrl(entity: string, opts: QueryOptions): string {
    const params = new URLSearchParams();

    // $select is DROPPED when $expand is present. Measured: combining a parent
    // $select with $expand makes this server abort the response mid-JSON, which
    // surfaces as unparseable JSON rather than as an error. A nested $select
    // inside the expand clause is safe and is the way to keep the payload down.
    if (opts.select?.length && !opts.expand) params.set("$select", opts.select.join(","));
    if (opts.filter) params.set("$filter", opts.filter);
    if (opts.expand) params.set("$expand", opts.expand);
    if (opts.orderby) params.set("$orderby", opts.orderby);
    if (opts.top !== undefined) params.set("$top", String(opts.top));
    if (opts.skip) params.set("$skip", String(opts.skip));

    const qs = params.toString();
    return `${this.cfg.odataUrl}/${encodeURIComponent(entity)}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The URL a query WOULD request, without requesting it.
   *
   * Exists so a caller can inspect what its arguments actually became before
   * spending a round trip -- the same reason Oracle's Select AI offers `showsql`
   * alongside `runsql`. Credentials live in a header, never in the URL, so this
   * is safe to hand back to a caller.
   */
  previewUrl(entity: string, opts: QueryOptions): string {
    return this.buildUrl(entity, opts);
  }

  // -- reads -----------------------------------------------------------------

  /**
   * Fetch rows from `entity`.
   *
   * With `pageSize` and no `top`, walks `$skip`/`$top` windows until a short page
   * arrives. This server sends no `@odata.nextLink` and reports no total, so a
   * short page is the only end-of-data signal there is.
   */
  async query(entity: string, opts: QueryOptions = {}): Promise<Record<string, unknown>[]> {
    if (opts.top === undefined && opts.pageSize) {
      return this.queryPaged(entity, opts, opts.pageSize);
    }
    const payload = await this.getJson(this.buildUrl(entity, opts), entity);
    return asRows(payload);
  }

  private async queryPaged(
    entity: string,
    opts: QueryOptions,
    pageSize: number,
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let skip = opts.skip ?? 0;

    for (;;) {
      const page = await this.query(entity, { ...opts, top: pageSize, skip, pageSize: undefined });
      if (page.length === 0) break;

      // A server that ignores $skip returns page one forever. Detecting the
      // repeat stops an infinite loop that would otherwise look like a very slow
      // query.
      let fresh = 0;
      for (const row of page) {
        const id = rowDigest(row);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(row);
        fresh++;
      }
      if (fresh === 0) break;

      if (page.length < pageSize) break;
      skip += page.length;
    }
    return out;
  }

  /**
   * A raw relative path, for what `entity` cannot express: a keyed row or a
   * sub-form. buildUrl's encodeURIComponent would destroy both.
   */
  async queryRawPath(relativePath: string): Promise<Record<string, unknown>[]> {
    const trimmed = relativePath.replace(/^\/+/, "");
    const base = `${this.cfg.odataUrl}/`;

    // Confinement check, independent of the tool-layer allowlist in
    // discovery.ts. That allowlist is the real defence; this exists so a future
    // caller reaching queryRawPath directly cannot walk into another company the
    // way `../../tabula.ini,1/demo/CUSTOMERS` once did.
    //
    // Two distinct escapes have to be refused, because they are decoded by
    // different parties:
    //   - `../` and `..\`, which OUR URL resolution collapses
    //   - `..%2F`, which we pass through intact and PRIORITY then decodes
    // so a resolution check alone is not enough.
    const pathPortion = trimmed.split("?")[0] ?? "";
    if (/%2e|%2f|%5c/i.test(pathPortion)) {
      throw new PriorityODataError(
        `Refusing path '${relativePath}': it percent-encodes a path separator or dot ` +
          `segment, which this server would decode into a traversal out of the ` +
          `configured company.`,
      );
    }

    // Service paths are not screen reads and are refused here as well as at the
    // tool layer. Neither is harmless on this server: the full `$metadata`
    // document is large and slow, and `/$count` hangs until the request deadline
    // and then answers 500. Legitimate metadata goes through metadataFor(),
    // which asks for one entity.
    if (pathPortion.split("/").some((seg) => seg.startsWith("$"))) {
      throw new PriorityODataError(
        `Refusing path '${relativePath}': OData service paths like $metadata, $count ` +
          `and $batch are not reads of a screen. Use metadataFor() for metadata; a ` +
          `row total is not available on this server at all.`,
      );
    }

    let resolved: URL;
    try {
      resolved = new URL(trimmed, base);
    } catch {
      throw new PriorityODataError(`Refusing path '${relativePath}': it is not a valid relative URL.`);
    }
    if (!resolved.href.startsWith(base)) {
      throw new PriorityODataError(
        `Refusing path '${relativePath}': it resolves to ${resolved.href}, outside the ` +
          `configured company ${this.cfg.odataUrl}.`,
      );
    }

    // The original string is what gets sent, not resolved.href: re-serialising
    // through URL would re-encode quotes and Hebrew inside key parentheses and
    // change the meaning of a keyed path. The check above is a gate, not a
    // rewrite.
    const url = `${base}${trimmed}`;
    const payload = await this.getJson(url, relativePath);
    return asRows(payload);
  }

  /**
   * Every entity set this company publishes.
   *
   * Takes a longer budget than an ordinary query because it IS slower by a
   * different order: measured at ~70s on an installation with every screen open
   * to the API, for only 0.14 MB -- the cost is Priority generating the document,
   * not transferring it. It is fetched once per dictionary load and then cached
   * for a day, so the wait is paid once rather than per question.
   */
  async entitySets(): Promise<string[]> {
    const payload = await this.getJson(
      this.cfg.odataUrl,
      "<service document>",
      Math.max(this.cfg.timeoutMs, SLOW_METADATA_TIMEOUT_MS),
    );
    const value = Array.isArray(payload["value"]) ? payload["value"] : [];
    return (value as { name?: unknown }[])
      .map((v) => (typeof v.name === "string" ? v.name : ""))
      .filter(Boolean);
  }

  /**
   * Parsed metadata for one entity AND its relatives.
   *
   * Priority returns the requested entity plus everything it references, which is
   * normally wasteful and is exactly what a deep describe wants.
   */
  async metadataFor(entity: string): Promise<Map<string, EntityMetadata>> {
    const safe = entity.replace(/'/g, "''");
    const url = `${this.cfg.odataUrl}/GetMetadataFor(entity='${encodeURIComponent(safe)}')`;
    // Same longer budget as the service document: metadata generation is slow on
    // an installation with every screen open, and TRANSORDER_D was measured
    // exceeding the ordinary 45s. This is schema, fetched rarely and cached by
    // the caller, so waiting beats failing.
    const res = await this.request(url, entity, 4, Math.max(this.cfg.timeoutMs, SLOW_METADATA_TIMEOUT_MS));
    if (!res.body.includes(EDM_NS_MARKER)) {
      throw new PriorityODataError(
        `GetMetadataFor(${entity}) did not return EDMX: ${res.body.slice(0, 300)}`,
      );
    }
    return parseEdmx(res.body);
  }
}

function asRows(payload: Record<string, unknown>): Record<string, unknown>[] {
  const value = payload["value"];
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  // A keyed path returns the entity itself rather than a collection.
  if (payload["@odata.context"]) return [payload];
  return [];
}

/** Exponential backoff that refuses to sleep past the caller's deadline. */
async function backoff(attempt: number, deadline: number): Promise<boolean> {
  const wait = Math.min(500 * 2 ** (attempt - 1), 4000);
  if (Date.now() + wait >= deadline) return false;
  await new Promise((r) => setTimeout(r, wait));
  return true;
}

// ---------------------------------------------------------------------------
// EDMX parsing
// ---------------------------------------------------------------------------

/**
 * Decode the XML entities Priority uses for Hebrew.
 *
 * Titles arrive as `&#x5DE;&#x5E7;&quot;&#x5D8;` rather than as literal text, so
 * skipping this leaves the model reading numeric escapes instead of `מק"ט`.
 */
function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function annotationValue(block: string, term: string): string | null {
  const re = new RegExp(`<Annotation[^>]*Term="${term}"[^>]*String="([^"]*)"`, "i");
  const m = re.exec(block);
  return m?.[1] !== undefined ? decodeXmlText(m[1]) : null;
}

function annotationBool(block: string, term: string): boolean {
  const re = new RegExp(`<Annotation[^>]*Term="${term}"[^>]*Bool="(true|false)"`, "i");
  return re.exec(block)?.[1] === "true";
}

/**
 * Parse an EDMX document into one entry per EntityType.
 *
 * Deliberately regex-based rather than a full XML parse: the documents reach
 * hundreds of KB and only a handful of attributes matter, and adding an XML
 * dependency for that trade was not worth it.
 */
export function parseEdmx(xml: string): Map<string, EntityMetadata> {
  const out = new Map<string, EntityMetadata>();

  const typeRe = /<EntityType\s+Name="([^"]+)"([\s\S]*?)<\/EntityType>/gi;
  for (const match of xml.matchAll(typeRe)) {
    const name = match[1]!;
    const body = match[2] ?? "";

    const keys = [...body.matchAll(/<PropertyRef\s+Name="([^"]+)"/gi)].map((m) => m[1]!);
    const keySet = new Set(keys);

    const columns = new Map<string, ColumnMetadata>();
    const propRe = /<Property\s+([^>]*?)(\/>|>([\s\S]*?)<\/Property>)/gi;
    for (const p of body.matchAll(propRe)) {
      const attrs = p[1] ?? "";
      const inner = p[3] ?? "";
      const colName = /Name="([^"]+)"/i.exec(attrs)?.[1];
      if (!colName) continue;

      const maxLenRaw = /MaxLength="(\d+)"/i.exec(attrs)?.[1];
      columns.set(colName, {
        name: colName,
        type: /Type="([^"]+)"/i.exec(attrs)?.[1] ?? "",
        title: annotationValue(inner, "Priority\\.OData\\.Description"),
        maxLength: maxLenRaw ? Number(maxLenRaw) : null,
        nullable: /Nullable="false"/i.test(attrs) ? false : true,
        isKey: keySet.has(colName),
        mandatory: annotationBool(inner, "Priority\\.OData\\.Mandatory"),
        dateType: annotationValue(inner, "Priority\\.OData\\.DateType"),
        autoUnique: annotationBool(inner, "Priority\\.OData\\.AutoUnique"),
        readOnly: /Read["']?\s*$/i.test(
          annotationValue(inner, "Org\\.OData\\.Core\\.V1\\.Permissions") ?? "",
        ),
      });
    }

    const navs = new Map<string, NavMetadata>();
    const navRe = /<NavigationProperty\s+([^>]*?)(\/>|>([\s\S]*?)<\/NavigationProperty>)/gi;
    for (const n of body.matchAll(navRe)) {
      const attrs = n[1] ?? "";
      const inner = n[3] ?? "";
      const navName = /Name="([^"]+)"/i.exec(attrs)?.[1];
      if (!navName) continue;
      const rawType = /Type="([^"]+)"/i.exec(attrs)?.[1] ?? "";
      // `Collection(Priority.OData.AINVOICEITEMS)` -> `AINVOICEITEMS`
      const target = rawType.replace(/^Collection\(/, "").replace(/\)$/, "").split(".").pop() ?? "";
      navs.set(navName, {
        name: navName,
        target,
        title: annotationValue(inner, "Priority\\.OData\\.Description"),
      });
    }

    // The entity's own title is the annotation left AFTER the Property and
    // NavigationProperty elements are removed. Searching the whole body would
    // otherwise return the first column's title as the screen's title.
    const trailing = body
      .replace(/<Property\s+[\s\S]*?(\/>|<\/Property>)/gi, "")
      .replace(/<NavigationProperty\s+[\s\S]*?(\/>|<\/NavigationProperty>)/gi, "");

    out.set(name, {
      name,
      title: annotationValue(trailing, "Priority\\.OData\\.Description"),
      keys,
      columns,
      navs,
      props: new Map([...columns.values()].map((c) => [c.name, c.type])),
    });
  }

  return out;
}
