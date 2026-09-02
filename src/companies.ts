import { loadConfig, listEnvironments, resolveEnvironment } from "./config.js";
import { PriorityDictionary } from "./dictionary.js";
import { PriorityODataClient } from "./odata.js";
import { ProgramRunner } from "./programs.js";

// Working against one Priority company at a time, switchable during a session.
//
// The company used to be fixed when the connection was made, which meant an end
// user could not be offered a choice: by the time anyone was talking to the model
// the company was already decided. Holding it here instead lets the model list
// what exists, ask, and switch -- while everything downstream keeps reading a
// single "current" client and knows nothing about the mechanism.
//
// What is per company, and what is not:
//
//   per company   the OData client (it carries that company's URL) and the
//                 program runner (a program acts on one company's data)
//   shared        the DICTIONARY, and with it every screen name, column title
//                 and help text
//
// The split follows Priority: screen definitions live at the tabula.ini level, so
// every company on one installation has the same forms. Switching company
// changes the DATA and nothing else.
//
// That is worth stating because the opposite is the intuitive guess, and acting
// on it is expensive rather than wrong-looking: a dictionary per company means a
// full EFORM pull for each one, producing identical results every time.

/** A company, with whatever ENVIRONMENT calls it. */
export interface CompanyInfo {
  /** The code used in the URL and in `use_company`. */
  company: string;
  /** The company's real name from ENVIRONMENT, e.g. `פלסן בע"מ`. */
  name: string | null;
  /** True for the company this session is reading right now. */
  active: boolean;
  /** Priority's own active flag for the environment. */
  environmentActive?: boolean;
  /** The colour Priority tags it with — how users recognise it in the UI. */
  colour?: string | null;
  /** Why the name is missing, when it is. */
  note?: string;
}

/** One row of the ENVIRONMENT screen. */
export interface EnvironmentRow {
  /** Company code, as it appears in the URL. */
  code: string;
  /** The company's real name, e.g. `פלסן בע"מ`. */
  title: string | null;
  active: boolean;
  /** Display order Priority itself uses. */
  position: number | null;
  /** The colour Priority tags this environment with, if any. */
  colour: string | null;
}

/** Read once per installation; the screen is identical from every company. */
let environmentCache: Promise<{ rows: EnvironmentRow[]; note?: string }> | undefined;

/**
 * The ENVIRONMENT screen: EVERY environment on this installation, one row each.
 *
 * Not "the current company" -- that was the mistake this replaced. Reading
 * `top: 1` and taking the row returned the FIRST environment's name no matter
 * which company was being asked, so all five companies reported the same name and
 * it looked plausible enough to miss.
 *
 * The real shape is a list: DNAME is the code, TITLE is the name. It is
 * installation-level like the dictionary, so it is fetched once and shared.
 */
export async function readEnvironments(
  client: PriorityODataClient,
): Promise<{ rows: EnvironmentRow[]; note?: string }> {
  environmentCache ??= (async () => {
    try {
      const raw = await client.query("ENVIRONMENT", { top: 500 });
      const rows: EnvironmentRow[] = raw
        .map((r) => ({
          code: String(r["DNAME"] ?? "").trim(),
          title: typeof r["TITLE"] === "string" && r["TITLE"].trim() ? r["TITLE"].trim() : null,
          active: String(r["ACTIVE"] ?? "").toUpperCase() === "Y",
          position: typeof r["POS"] === "number" ? r["POS"] : null,
          colour: typeof r["COLORNAME"] === "string" ? r["COLORNAME"] : null,
        }))
        .filter((r) => r.code);
      if (!rows.length) return { rows, note: "ENVIRONMENT is readable but empty." };
      return { rows };
    } catch (err) {
      // Not fatal: every company code still works. Only the friendly names are
      // missing, and saying why beats an unexplained null.
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
      return { rows: [], note: `ENVIRONMENT could not be read: ${message}` };
    }
  })();
  return environmentCache;
}

/** Test seam: forget the cached ENVIRONMENT read. */
export function resetEnvironmentCache(): void {
  environmentCache = undefined;
}

interface CompanyChannel {
  client: PriorityODataClient;
  programs: ProgramRunner;
}

export class CompanyContext {
  private active: string;
  private readonly channels = new Map<string, CompanyChannel>();
  /** Shared across every company: the dictionary is installation-level. */
  private sharedDict: PriorityDictionary | undefined;

  constructor(
    initial: string,
    private authHeader?: string,
  ) {
    this.active = resolveEnvironment(initial);
  }

  /** Whether this session already knows who it is acting as. */
  get hasCallerIdentity(): boolean {
    return Boolean(this.authHeader);
  }

  /**
   * Adopt credentials that arrived after the session opened.
   *
   * Every built channel is discarded: a client carries its Authorization header
   * for life, so reusing one would keep reading as the previous identity while
   * the session believed it had switched. The dictionary goes too — it was
   * fetched under the old identity and a different user may see a different set
   * of screens.
   */
  setAuthHeader(header: string): void {
    this.authHeader = header;
    this.channels.clear();
    this.sharedDict = undefined;
    // The environment list was read under the old identity too.
    resetEnvironmentCache();
  }

  get company(): string {
    return this.active;
  }

  get client(): PriorityODataClient {
    return this.channel().client;
  }

  /**
   * ONE dictionary for the whole session, whatever company is active.
   *
   * Screen definitions, column titles and help live at the tabula.ini level, so
   * every company on this installation sees the same forms; switching company
   * changes the DATA and nothing else. Building one per company would re-fetch an
   * identical dictionary each time -- a full EFORM pull against Priority, for no
   * difference in the result.
   *
   * Bound to whichever client was active when it was first needed. That only
   * decides which company's URL carries the EFORM request, not what comes back.
   */
  get dict(): PriorityDictionary {
    this.sharedDict ??= new PriorityDictionary(this.client);
    return this.sharedDict;
  }

  get programs(): ProgramRunner {
    return this.channel().programs;
  }

  /**
   * Switch the company every later call reads.
   *
   * Validates through resolveEnvironment, so a name that is not on the allowlist
   * is refused here exactly as it is at connect time -- the value still ends up
   * in a URL path either way.
   */
  switchTo(company: string): string {
    this.active = resolveEnvironment(company);
    return this.active;
  }

  /**
   * Companies this server serves, with their real names.
   *
   * ONE request, not one per company: ENVIRONMENT lists every environment and is
   * the same from all of them.
   */
  async describeAll(): Promise<CompanyInfo[]> {
    const allowed = listEnvironments();
    const { rows, note } = await readEnvironments(this.client);
    const byCode = new Map(rows.map((r) => [r.code, r]));

    return allowed.map((code) => {
      const row = byCode.get(code);
      return {
        company: code,
        name: row?.title ?? null,
        active: code === this.active,
        ...(row ? { environmentActive: row.active, colour: row.colour } : {}),
        ...(note
          ? { note }
          : row
            ? {}
            : { note: "Allowed here, but Priority's ENVIRONMENT screen does not list it." }),
      };
    });
  }

  /**
   * Environments on this installation that are not on the allowlist.
   *
   * Worth surfacing: an operator who added a company in Priority and forgot
   * PRIORITY_ENVIRONMENTS sees the gap instead of wondering why it is missing.
   */
  async unofferedEnvironments(): Promise<{ company: string; name: string | null }[]> {
    const allowed = new Set(listEnvironments());
    const { rows } = await readEnvironments(this.client);
    return rows
      .filter((r) => r.active && !allowed.has(r.code))
      .map((r) => ({ company: r.code, name: r.title }));
  }

  /** The current company's display name. */
  async currentName(): Promise<string | null> {
    const { rows } = await readEnvironments(this.client);
    return rows.find((r) => r.code === this.active)?.title ?? null;
  }

  private channel(company = this.active): CompanyChannel {
    const hit = this.channels.get(company);
    if (hit) return hit;

    const base = loadConfig(company);
    const client = new PriorityODataClient(
      this.authHeader ? { ...base, authHeader: this.authHeader } : base,
    );
    const channel: CompanyChannel = { client, programs: new ProgramRunner(company) };
    this.channels.set(company, channel);
    return channel;
  }
}
