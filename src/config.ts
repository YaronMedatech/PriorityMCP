import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Credentials live here and nowhere else. The MCP tools take an entity name and
// a date range; the model never sees a token, so no tool call can echo one back.

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load `.env`, then delete any credential variable that came back empty.
 *
 * An empty assignment (`ANTHROPIC_API_KEY=`) is worse than an absent one: dotenv
 * sets the variable to `""`, and the Anthropic SDK resolves credentials by first
 * match, not first *non-empty* match. So an empty key still wins its slot and the
 * request authenticates with nothing, instead of falling through to an
 * `ant auth login` profile -- which surfaces as a confusing 401 rather than as
 * the missing-credential error it actually is.
 *
 * Exported because the chat client needs the same treatment but must not require
 * Priority credentials to start.
 */
export function loadEnvFile(): void {
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (process.env[key]?.trim() === "") delete process.env[key];
  }
}

loadEnvFile();

/**
 * Where Priority runs. The two differ in how the Web SDK is reached and in
 * which identity it accepts, and nowhere else so far.
 *
 * Set explicitly with PRIORITY_HOSTING; detected from the OData host name when
 * unset (*.priority-connect.online is Priority's cloud). Explicit wins, because
 * this server is configured for several installations and a heuristic that is
 * right for one host name is a silent wrong guess on the next.
 */
export type Hosting = "cloud" | "self-hosted";

export interface HostingInfo {
  hosting: Hosting;
  /** Whether .env said so, or the host name was read. */
  source: "PRIORITY_HOSTING" | "detected";
  /** One line for the startup log. */
  detail: string;
}

const HOSTING_VALUES: Record<string, Hosting> = {
  cloud: "cloud",
  saas: "cloud",
  "self-hosted": "self-hosted",
  selfhosted: "self-hosted",
  "on-prem": "self-hosted",
  onprem: "self-hosted",
  local: "self-hosted",
};

export function detectHosting(e: NodeJS.ProcessEnv = process.env): HostingInfo {
  const raw = (e["PRIORITY_HOSTING"] ?? "").trim().toLowerCase();
  if (raw) {
    const hosting = HOSTING_VALUES[raw];
    if (!hosting) {
      throw new ConfigError(
        `PRIORITY_HOSTING is '${e["PRIORITY_HOSTING"]}', which is not a value this server knows. ` +
          `Use 'cloud' for Priority's cloud (*.priority-connect.online) or 'self-hosted' ` +
          `for an installation on your own or a partner's servers. Leave it empty to detect ` +
          `from the OData host name.`,
      );
    }
    return { hosting, source: "PRIORITY_HOSTING", detail: `${hosting} (PRIORITY_HOSTING=${raw})` };
  }
  let host = "";
  try {
    host = new URL((e["PRIORITY_ODATA_URL"] ?? "").trim()).hostname;
  } catch {
    // No usable URL: assume self-hosted, and say so.
  }
  const hosting: Hosting = /\.priority-connect\.online$/i.test(host) ? "cloud" : "self-hosted";
  return {
    hosting,
    source: "detected",
    detail: `${hosting} (detected from ${host || "no OData URL"}; pin it with PRIORITY_HOSTING=${hosting})`,
  };
}

export interface WebSdkConfig {
  /**
   * The Web SDK's service URL. Self-hosted: the HOST ROOT (`https://host/`; the
   * SDK appends `/wcf/wcf/Service.svc`). Cloud: the documented
   * `https://<host>/wcf/service.svc` -- one `wcf`, ending in `.svc` so the SDK
   * appends nothing. Never the OData path.
   */
  url: string;
  company: string;
  /**
   * Either a real Priority user, or a PAT sent as `username=<token>,
   * password='PAT'` (documented since Priority 19.1). Which is tried first
   * depends on hosting: the cloud refused the named user and accepted the PAT
   * (measured 2026-09-02); older self-hosted versions are the other way round.
   */
  username: string;
  password: string;
  /** Which of the two the identity is, for logs. */
  identity: "pat" | "user";
  hosting: Hosting;
  tabulaini: string;
  /** Absolute path to the runnable-program catalog. */
  catalogPath: string;
}

export interface PriorityConfig {
  /** Company base URL, no trailing slash. */
  odataUrl: string;
  /** Which Priority company this config reads. Part of every cache key. */
  company: string;
  /** Ready-to-send `Authorization` header value. */
  authHeader: string;
  /** false = do not verify TLS at all. */
  verifySsl: boolean;
  /** PEM contents of a CA bundle (or the server's own self-signed cert). */
  caBundle?: string;
  timeoutMs: number;
  /**
   * Requests one session may send to Priority in a rolling minute. 0 lifts the
   * cap. Every other limit here bounds a single call; this one bounds the calls.
   */
  maxRequestsPerMinute: number;
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Priority accepts basic auth two ways: a PAT (as the user, with the literal
// string "PAT" as the password) or a real Priority user's credentials.
function buildAuthHeader(): string {
  const token = env("PRIORITY_API_TOKEN");
  const user = env("PRIORITY_USER");
  const pass = env("PRIORITY_PASS");

  // Two credential slots sit next to each other in .env and one silently wins,
  // so pasting a key into the wrong one surfaces only as an auth failure against
  // Priority -- which reads like a Priority problem. An Anthropic key is
  // recognisable on sight, so say so instead.
  if (token?.startsWith("sk-ant-")) {
    throw new ConfigError(
      "PRIORITY_API_TOKEN holds what looks like an Anthropic API key (it starts " +
        'with "sk-ant-").\n\n' +
        "That is the key for ANTHROPIC_API_KEY. PRIORITY_API_TOKEN is for a " +
        "Priority Personal Access Token; leave it empty to authenticate with " +
        "PRIORITY_USER / PRIORITY_PASS instead.",
    );
  }

  if (token) return "Basic " + Buffer.from(`${token}:PAT`).toString("base64");
  if (user && pass) return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  throw new ConfigError(
    "No Priority credentials configured.\n\n" +
      "Set either PRIORITY_API_TOKEN (a Personal Access Token), or both\n" +
      "PRIORITY_USER and PRIORITY_PASS, in .env — see .env.example.",
  );
}

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------
// Environments (Priority companies)
// ---------------------------------------------------------------------------
//
// One installation serves several companies, distinguished only by the last
// segment of the OData URL:
//
//   https://host/odata/Priority/tabula.ini,1/<company>
//
// PRIORITY_ODATA_URL may stop before that segment, and PRIORITY_ENVIRONMENTS
// lists the companies a caller may pick from, so one server can serve all of
// them instead of one process per company.
//
// THE LIST IS A SECURITY CONTROL, NOT A CONVENIENCE. The chosen name is
// concatenated into a URL path, which is exactly the shape that let
// `../../tabula.ini,1/demo/CUSTOMERS` walk out of the configured company before
// the allowlist in discovery.ts closed it. A company name that arrives in a
// header is caller-supplied input reaching the same place, so it is matched
// against a fixed list and never merely sanitised.

/** Split on ';' -- the separator asked for, and one no company name contains. */
function parseEnvironments(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(";").map((s) => s.trim()).filter(Boolean))];
}

/**
 * The tabula segment: `tabula.ini`, `tabula.ini,1`, `tabb6b4c.ini`, ...
 *
 * The language suffix is OPTIONAL. An earlier version of this keyed on the comma
 * in `tabula.ini,1` and was wrong on the first installation that did not use one:
 * `.../tabb6b4c.ini` has no comma, so a base URL would have been read as a
 * company and the company segment stripped off the wrong end. The `.ini` is the
 * part that is actually always there.
 */
const TABULA_SEGMENT = /\.ini(,\d+)?$/i;

/**
 * Does this URL already end in a company, or stop at the tabula segment?
 *
 * Detecting it keeps every existing .env working unchanged: a URL that still ends
 * in a company simply yields that one company.
 */
function splitODataUrl(url: string): { base: string; company: string | null } {
  const trimmed = url.replace(/\/+$/, "");
  const last = trimmed.split("/").at(-1) ?? "";
  if (TABULA_SEGMENT.test(last)) return { base: trimmed, company: null };
  return { base: trimmed.slice(0, trimmed.length - last.length - 1), company: last };
}

/** Companies this server may serve, in the order they were configured. */
export function listEnvironments(): string[] {
  const configured = parseEnvironments(env("PRIORITY_ENVIRONMENTS"));
  if (configured.length) return configured;

  // No list: fall back to whatever the URL already names, so a single-company
  // install needs no new setting at all.
  const url = env("PRIORITY_ODATA_URL");
  const embedded = url ? splitODataUrl(url).company : null;
  return embedded ? [embedded] : [];
}

/** The company used when a caller does not choose one. */
export function defaultEnvironment(): string | null {
  const explicit = env("PRIORITY_COMPANY");
  const known = listEnvironments();
  if (explicit && known.includes(explicit)) return explicit;
  return known[0] ?? explicit ?? null;
}

/**
 * Resolve a requested company to one this server actually serves.
 *
 * Throws rather than falling back to the default. Silently serving company A to
 * a caller who asked for company B would answer every later question with the
 * wrong company's data, and nothing in the reply would show it.
 */
export function resolveEnvironment(requested?: string | null): string {
  const known = listEnvironments();
  const fallback = defaultEnvironment();

  if (!requested) {
    if (!fallback) {
      throw new ConfigError(
        "No Priority company configured.\n\n" +
          "Either end PRIORITY_ODATA_URL with a company, or set PRIORITY_ENVIRONMENTS\n" +
          "to a ';'-separated list, e.g.\n" +
          "  PRIORITY_ENVIRONMENTS=hafaza;demo",
      );
    }
    return fallback;
  }

  const wanted = requested.trim();

  // Shape check before the list check, so a hostile value is refused even if the
  // list itself was configured with something odd.
  if (!/^[A-Za-z0-9_-]+$/.test(wanted)) {
    throw new ConfigError(
      `'${wanted}' is not a valid company name. Letters, digits, '-' and '_' only — ` +
        `a name is a single path segment, never a path.`,
    );
  }

  // Case-sensitive: Priority company names are, and folding them here would let
  // a near-miss resolve to a real company the caller did not ask for.
  if (!known.includes(wanted)) {
    throw new ConfigError(
      `Unknown Priority company '${wanted}'.\n\n` +
        `This server serves: ${known.length ? known.join(", ") : "(none configured)"}\n` +
        `Names are case-sensitive. Add it to PRIORITY_ENVIRONMENTS in .env if it should be available.`,
    );
  }
  return wanted;
}

/**
 * The installation URL, without the company.
 *
 * This is the identity of the DICTIONARY, not of the data. Screen definitions,
 * column titles and help live at the tabula.ini level and are identical for every
 * company on it; only the business data differs. So anything derived from the
 * dictionary is keyed on this, and anything derived from data is keyed on the
 * company.
 */
export function installationBase(): string {
  const url = env("PRIORITY_ODATA_URL");
  if (!url) throw new ConfigError("PRIORITY_ODATA_URL is not set.");
  return splitODataUrl(url).base;
}

/** The full OData URL for one company. */
export function odataUrlFor(company: string): string {
  const url = env("PRIORITY_ODATA_URL");
  if (!url) throw new ConfigError("PRIORITY_ODATA_URL is not set.");
  const { base } = splitODataUrl(url);
  return `${base}/${company}`;
}

// Keyed by company: one process now serves several, and a single slot would
// hand the second caller the first caller's URL.
const cached = new Map<string, PriorityConfig>();

export function loadConfig(company?: string): PriorityConfig {
  const resolved = resolveEnvironment(company ?? null);
  const hit = cached.get(resolved);
  if (hit) return hit;

  const odataUrl = env("PRIORITY_ODATA_URL");
  if (!odataUrl) {
    throw new ConfigError(
      "PRIORITY_ODATA_URL is not set.\n\n" +
        "Copy .env.example to .env and fill it in. Either end it with a company:\n" +
        "  https://your-host/odata/Priority/tabula.ini,1/yourcompany\n" +
        "or stop before the company and list them in PRIORITY_ENVIRONMENTS:\n" +
        "  PRIORITY_ODATA_URL=https://your-host/odata/Priority/tabula.ini,1\n" +
        "  PRIORITY_ENVIRONMENTS=hafaza;demo",
    );
  }
  if (!/^https?:\/\//i.test(odataUrl)) {
    throw new ConfigError(`PRIORITY_ODATA_URL must start with http:// or https:// (got: ${odataUrl})`);
  }

  // Built from the resolved company rather than taken from the setting, so the
  // URL always matches the company this config is for. The service document and
  // every entity path hang off it, so no trailing slash.
  const normalizedUrl = odataUrlFor(resolved);

  let caBundle: string | undefined;
  const caPath = env("PRIORITY_CA_BUNDLE");
  if (caPath) {
    const resolvedPath = path.isAbsolute(caPath) ? caPath : path.join(PROJECT_ROOT, caPath);
    try {
      caBundle = fs.readFileSync(resolvedPath, "utf8");
    } catch (err) {
      throw new ConfigError(
        `PRIORITY_CA_BUNDLE points at ${resolvedPath}, which could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const timeoutRaw = env("PRIORITY_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 45_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(
      `PRIORITY_TIMEOUT_MS must be a positive number of milliseconds (got: ${timeoutRaw}).`,
    );
  }

  // Deliberately under the 60s request deadline MCP clients commonly default to.
  const budgetRaw = env("PRIORITY_MAX_REQUESTS_PER_MIN");
  const maxRequestsPerMinute = budgetRaw ? Number(budgetRaw) : 240;
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 0) {
    throw new ConfigError(
      `PRIORITY_MAX_REQUESTS_PER_MIN must be a whole number, 0 or greater (got: ${budgetRaw}).\n\n` +
        "It caps how many requests one session may send to Priority in a rolling\n" +
        "minute, which is the guard against a model in a retry loop hammering a\n" +
        "production server. Set it to 0 to lift the cap entirely.",
    );
  }

  const config: PriorityConfig = {
    odataUrl: normalizedUrl,
    company: resolved,
    authHeader: buildAuthHeader(),
    // Anything other than an explicit "0"/"false" keeps verification on: the
    // safe direction to fail in.
    verifySsl: !["0", "false", "no"].includes((env("PRIORITY_VERIFY_SSL") ?? "1").toLowerCase()),
    caBundle,
    timeoutMs,
    maxRequestsPerMinute,
  };
  cached.set(resolved, config);
  return config;
}

/**
 * Config for the Web SDK channel, which runs programs and reports.
 *
 * Separate from `loadConfig()` on purpose: the OData tools must keep working on
 * an installation where nobody has configured the SDK, so a missing value here
 * disables one tool rather than failing the server at startup.
 */
export function loadWebSdkConfig(company_?: string): WebSdkConfig | { error: string } {
  // The OData URL already encodes the host, the tabula.ini and the company:
  //   https://host/odata/Priority/tabula.ini,1/company
  // Deriving them removes a genuine foot-gun -- PRIORITY_HOST_URL and
  // PRIORITY_ODATA_URL read like the same setting but must differ, and setting
  // the SDK one to the OData path produces a login failure that points nowhere.
  // Explicit values still win, for an install where the two really do differ.
  const derived = deriveFromODataUrl(env("PRIORITY_ODATA_URL"));
  const { hosting } = detectHosting();

  const url = env("PRIORITY_HOST_URL") ?? (derived?.host ? webSdkUrlFor(derived.host, hosting) : undefined);
  // The session's company wins over both the setting and the URL. A program run
  // against a different company from the one being read would act on data the
  // caller never looked at.
  const company =
    company_ ?? env("PRIORITY_COMPANY") ?? (derived?.company || undefined) ?? defaultEnvironment() ?? undefined;

  // Which identity first depends on where Priority runs. Cloud: the PAT -- it is
  // what OData uses, so both channels act as one user, and measured 2026-09-02
  // the named user was refused where the token logged in. Self-hosted: the named
  // user -- the SDK there historically wanted a real user, and PAT support
  // arrived only in 19.1. Whichever is not first is still the fallback, so a
  // .env that carries both works on either kind of installation.
  const token = env("PRIORITY_API_TOKEN");
  const user = env("PRIORITY_USER");
  const pass = env("PRIORITY_PASS");
  const asPat = token ? { username: token, password: "PAT", identity: "pat" as const } : undefined;
  const asUser = user && pass ? { username: user, password: pass, identity: "user" as const } : undefined;
  const identity = hosting === "cloud" ? (asPat ?? asUser) : (asUser ?? asPat);

  const missing = [
    ["PRIORITY_HOST_URL", url],
    ["PRIORITY_COMPANY", company],
    ["PRIORITY_API_TOKEN or PRIORITY_USER+PRIORITY_PASS", identity],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k as string);

  if (missing.length) {
    return {
      error:
        `Running programs needs the Web SDK channel, which is not configured: ` +
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset in .env ` +
        `and could not be derived from PRIORITY_ODATA_URL.\n\n` +
        `PRIORITY_HOST_URL is the SDK service URL: the host root (https://your-host/) ` +
        `on a self-hosted Priority, or https://<host>/wcf/service.svc on Priority's ` +
        `cloud (derived from PRIORITY_HOSTING, or from the host name when unset). The ` +
        `identity is the PAT or PRIORITY_USER/PRIORITY_PASS, tried in the order the ` +
        `hosting kind calls for; either one is enough.`,
    };
  }

  const catalog = env("PRIORITY_PROGRAMS_FILE") ?? "programs.json";
  return {
    url: url!,
    company: company!,
    ...identity!,
    hosting,
    tabulaini: env("PRIORITY_TABULAINI") ?? derived?.tabulaini ?? "tabula.ini",
    catalogPath: path.isAbsolute(catalog) ? catalog : path.join(PROJECT_ROOT, catalog),
  };
}

/**
 * The Web SDK service URL for a host root, by hosting kind.
 *
 * Self-hosted: the root itself; the SDK appends `/wcf/wcf/Service.svc`.
 * Cloud: Priority's SDK documentation gives `https://<host>/wcf/service.svc` --
 * one `wcf`, and ending in `.svc` so the SDK appends nothing. Measured
 * 2026-09-02 on t.eu.priority-connect.online: the derived `/wcf/wcf/Service.svc`
 * answered 403 and the SDK reported "Can't connect to server"; the documented
 * URL logged in.
 */
export function webSdkUrlFor(hostRoot: string, hosting: Hosting): string {
  if (hosting !== "cloud") return hostRoot;
  try {
    return `${new URL(hostRoot).origin}/wcf/service.svc`;
  } catch {
    // Not a URL we can inspect; hand it back and let the SDK say so.
    return hostRoot;
  }
}

function deriveFromODataUrl(
  odataUrl: string | undefined,
): { host: string; company: string; tabulaini: string } | null {
  if (!odataUrl) return null;
  try {
    const u = new URL(odataUrl);
    // .../odata/Priority/<tabulaini>[,<lang>][/<company>]
    const parts = u.pathname.split("/").filter(Boolean);

    // Find the tabula segment rather than counting back a fixed number of
    // positions: the company may or may not be present now that the URL can stop
    // at the base, and the language suffix is optional. Counting positions was
    // wrong in both directions.
    const iniIndex = parts.findIndex((p) => TABULA_SEGMENT.test(p));
    if (iniIndex === -1) return null;
    const iniSegment = parts[iniIndex]!;

    return {
      host: `${u.protocol}//${u.host}/`,
      company: parts[iniIndex + 1] ?? "",
      tabulaini: iniSegment.split(",")[0] ?? "tabula.ini",
    };
  } catch {
    return null;
  }
}

/** Host name only — for error messages that must never leak the credentials. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
