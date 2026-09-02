import fs from "node:fs";
import { createRequire } from "node:module";
import { loadWebSdkConfig, type WebSdkConfig } from "./config.js";

// Running Priority programs and reports, over the Web SDK.
//
// This is a second channel, not an extension of the OData one, and the split is
// forced by Priority rather than chosen: OData cannot run a program at all, and
// the SDK needs a real Priority user where OData accepts a PAT.
//
// The catalog is a file the operator maintains, because Priority offers no way
// to enumerate runnable programs: APPS/APP answer 404 and PROGDESIGN/FREPORTS are
// closed to the API. So the catalog is not merely a safety list -- without it a
// caller has no way to learn that a program exists at all.

const require = createRequire(import.meta.url);

/**
 * One step of a running program.
 *
 * `procStart` resolves to this rather than driving a callback: you inspect
 * `type`, then call the matching method on `proc` to advance, and the run is over
 * when `type` is `end`. The callback argument exists but carries progress, not
 * the steps.
 */
interface ProcStep {
  type?: string;
  message?: string;
  messagetype?: string;
  input?: { EditFields?: EditField[]; Options?: unknown[] };
  Urls?: { datauri?: string; url?: string }[];
  proc?: ProcMethods;
}

interface EditField {
  field?: number;
  title?: string;
  code?: string;
  mandatory?: boolean;
}

interface ProcMethods {
  inputFields?: (n: number, payload: unknown) => Promise<ProcStep>;
  inputOptions?: (a: number, b: number) => Promise<ProcStep>;
  reportOptions?: (a: number, format: string, opts: unknown) => Promise<ProcStep>;
  documentOptions?: (a: number, format: string, opts: unknown) => Promise<ProcStep>;
  message?: (n: number) => Promise<ProcStep>;
  inputHelp?: (n: number) => Promise<ProcStep>;
  continueProc?: () => Promise<ProcStep>;
  cancel?: () => Promise<unknown>;
}

export interface CatalogEntry {
  name: string;
  /** 'P' = procedure, 'R' = report. */
  type: "P" | "R";
  description: string;
  notes?: string;
}

export interface ProgramRunResult {
  program: string;
  type: "P" | "R";
  status:
    | "completed"
    | "needs_input"
    | "message"
    | "not_found"
    | "error"
    | "unmatched_inputs";
  messages: string[];
  /** Parameters the program is waiting for, with their Hebrew titles. */
  inputFields?: { field: number; title: string; code?: string; mandatory: boolean }[];
  /**
   * Supplied keys that matched no parameter. Present only when the run was
   * refused because of them.
   */
  unmatchedInputs?: string[];
  /** Report output, as text extracted from the HTML Priority returns. */
  output?: string;
  /**
   * The unconverted HTML, when explicitly asked for. Kept available because
   * adapting the text conversion to an unfamiliar report is guesswork without it,
   * and it is far too large to return by default.
   */
  html?: string;
  truncated?: boolean;
  steps: number;
}

const MAX_OUTPUT_CHARS = 60_000;
const MAX_STEPS = 40;

/** Priority's answer when a program name does not exist. Not an error, a message. */
const NOT_FOUND_MARKER = "No such Tabula Entity";

export class ProgramRunner {
  private sdk: Record<string, unknown> | undefined;
  private loggedIn = false;
  private readonly cfg: WebSdkConfig | { error: string };

  /**
   * @param company Run programs against this Priority company rather than the
   *   default. A program acts on data, so it must target the same company the
   *   session is reading — otherwise it would change data the caller never saw.
   */
  constructor(company?: string) {
    this.cfg = loadWebSdkConfig(company);
  }

  get configError(): string | null {
    return "error" in this.cfg ? this.cfg.error : null;
  }

  private config(): WebSdkConfig {
    if ("error" in this.cfg) throw new Error(this.cfg.error);
    return this.cfg;
  }

  // -- catalog ---------------------------------------------------------------

  readCatalog(): CatalogEntry[] {
    const { catalogPath } = this.config();
    if (!fs.existsSync(catalogPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
        programs?: CatalogEntry[];
      };
      return Array.isArray(parsed.programs) ? parsed.programs : [];
    } catch (err) {
      throw new Error(
        `The program catalog at ${catalogPath} is not valid JSON: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  findInCatalog(name: string): CatalogEntry | undefined {
    // Program names are case-insensitive in Priority, unlike screen names.
    const wanted = name.trim().toUpperCase();
    return this.readCatalog().find((p) => p.name.trim().toUpperCase() === wanted);
  }

  // -- session ---------------------------------------------------------------

  private async ensureLogin(): Promise<Record<string, unknown>> {
    if (this.sdk && this.loggedIn) return this.sdk;
    const cfg = this.config();

    // Loaded lazily so an installation that never runs programs does not pay for
    // the SDK, and a missing vendored copy fails only this tool.
    const mod = require("priority-web-sdk") as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const sdk = (mod.default ?? mod) as Record<string, unknown>;

    await (sdk["login"] as (c: unknown) => Promise<unknown>)({
      url: cfg.url,
      tabulaini: cfg.tabulaini,
      language: 2,
      profile: { company: cfg.company },
      appname: "priority-mcp",
      username: cfg.username,
      password: cfg.password,
      devicename: "priority-mcp",
      appid: "priority-mcp",
      appkey: "",
    });

    this.sdk = sdk;
    this.loggedIn = true;
    return sdk;
  }

  // -- running ---------------------------------------------------------------

  /**
   * Check whether a program exists, without running it.
   *
   * `procStart` does not throw on a missing name: it opens successfully and
   * reports `No such Tabula Entity` as an ordinary message. So existence has to
   * be read out of the message text, and a caller that only checks for a thrown
   * error concludes that every name exists.
   *
   * Deliberately never sends input values. Supplying a parameter is what makes a
   * procedure act -- a file path handed to KAR_EXECUPGRADES runs a real upgrade --
   * so a probe that filled them in would not be a probe.
   */
  async probe(name: string, type: "P" | "R" = "P"): Promise<ProgramRunResult> {
    return this.drive(name, type, undefined, true, false);
  }

  async run(
    name: string,
    type: "P" | "R",
    inputs?: Record<string, string>,
    opts: { keepHtml?: boolean } = {},
  ): Promise<ProgramRunResult> {
    return this.drive(name, type, inputs, false, opts.keepHtml === true);
  }

  private async drive(
    name: string,
    type: "P" | "R",
    inputs: Record<string, string> | undefined,
    probeOnly: boolean,
    keepHtml: boolean,
  ): Promise<ProgramRunResult> {
    const sdk = await this.ensureLogin();
    const cfg = this.config();
    const result: ProgramRunResult = {
      program: name,
      type,
      status: "completed",
      messages: [],
      steps: 0,
    };
    let html = "";

    const procStart = sdk["procStart"] as (
      n: string,
      t: string,
      cb: (p: unknown) => void,
      o: unknown,
    ) => Promise<ProcStep>;

    let step: ProcStep | undefined = await procStart(name, type, () => {}, {
      company: cfg.company,
    });

    // Advance the program one step at a time. The bound is a guard against a
    // program that loops rather than an expected depth.
    while (step && step.type !== "end" && result.steps < MAX_STEPS) {
      result.steps++;
      const proc: ProcMethods | undefined = step.proc;
      const kind = String(step.type ?? "");

      if (kind === "message") {
        const text = String(step.message ?? "");
        result.messages.push(text);

        if (text.includes(NOT_FOUND_MARKER)) {
          result.status = "not_found";
          await proc?.cancel?.().catch(() => undefined);
          return finish(result, html, keepHtml);
        }
        if (String(step.messagetype ?? "").toLowerCase() === "error") result.status = "error";
        step = await proc?.message?.(1);
        continue;
      }

      if (kind === "inputFields") {
        const fields = step.input?.EditFields ?? [];
        result.inputFields = fields.map((f) => ({
          field: Number(f.field ?? 0),
          title: String(f.title ?? ""),
          ...(f.code ? { code: String(f.code) } : {}),
          mandatory: Boolean(f.mandatory),
        }));

        if (probeOnly || !inputs) {
          // The program exists and is waiting for parameters. Report them rather
          // than inventing values.
          result.status = "needs_input";
          await proc?.cancel?.().catch(() => undefined);
          return finish(result, html, keepHtml);
        }

        // Refuse the run if any supplied key matched no parameter.
        //
        // The alternative -- which this did before -- is to drop the unmatched
        // key and send "" for the parameter it was meant to fill. For a type 'P'
        // procedure that means a typo in a parameter name silently runs the
        // program against its DEFAULTS instead of the caller's intent, and the
        // reply says "completed". A caller cannot detect that, so it has to be
        // refused rather than reported alongside a run that already happened.
        const accepted = new Set<string>();
        for (const f of fields) {
          for (const k of [f.title, f.code, f.field]) {
            if (k !== undefined && k !== null && String(k) !== "") accepted.add(String(k));
          }
        }
        const unmatched = Object.keys(inputs).filter((k) => !accepted.has(k));
        if (unmatched.length > 0) {
          result.status = "unmatched_inputs";
          result.unmatchedInputs = unmatched;
          result.messages.push(
            `Not run. These input keys match no parameter of ${name}: ` +
              `${unmatched.join(", ")}. Use the exact 'title', 'code' or 'field' ` +
              `from inputFields above. Nothing was executed.`,
          );
          await proc?.cancel?.().catch(() => undefined);
          return finish(result, html, keepHtml);
        }

        // Match supplied values by Hebrew title, by code, or by field number --
        // the caller sees titles, but numbers are stabler across languages.
        const edit = fields.map((f) => ({
          field: Number(f.field ?? 0),
          op: 0,
          value:
            inputs[String(f.title ?? "")] ??
            inputs[String(f.code ?? "")] ??
            inputs[String(f.field ?? "")] ??
            "",
          op2: 0,
          value2: "",
        }));
        step = await proc?.inputFields?.(1, { EditFields: edit });
        continue;
      }

      if (kind === "inputOptions") {
        step = await proc?.inputOptions?.(1, 1);
        continue;
      }
      if (kind === "reportOptions") {
        // HTML is the only format worth asking for here: it is what carries the
        // report body back inline as a data URI.
        step = await proc?.reportOptions?.(1, "HTML", {});
        continue;
      }
      if (kind === "documentOptions") {
        step = await proc?.documentOptions?.(1, "HTML", {});
        continue;
      }
      if (kind === "inputHelp") {
        step = await proc?.inputHelp?.(1);
        continue;
      }
      if (kind === "displayUrl") {
        for (const u of step.Urls ?? []) html += decodeDataUri(u.datauri);
        step = await proc?.continueProc?.();
        continue;
      }

      result.messages.push(`Unhandled step type '${kind}' -- the run was cancelled here.`);
      result.status = "error";
      await proc?.cancel?.().catch(() => undefined);
      break;
    }

    if (result.steps >= MAX_STEPS) {
      result.status = "error";
      result.messages.push(`Gave up after ${MAX_STEPS} steps without reaching the end.`);
    }

    return finish(result, html, keepHtml);
  }
}

function finish(result: ProgramRunResult, html: string, keepHtml = false): ProgramRunResult {
  if (html) {
    if (keepHtml) result.html = html;
    const text = htmlToText(html);
    result.output = text.slice(0, MAX_OUTPUT_CHARS);
    if (text.length > MAX_OUTPUT_CHARS) result.truncated = true;
  }
  return result;
}

/** `data:text/html;base64,XXXX` -> decoded text. */
function decodeDataUri(uri: string | undefined): string {
  if (!uri) return "";
  const comma = uri.indexOf(",");
  const payload = comma === -1 ? uri : uri.slice(comma + 1);
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Flatten Priority's report HTML to text.
 *
 * Line structure is preserved on purpose: a helper in a sibling project extracts
 * only `<span>` contents, which destroys the line breaks in trigger source and
 * makes code output unreadable.
 */
function htmlToText(html: string): string {
  // Structure is marked with sentinels BEFORE tags are stripped, then restored
  // last. Substituting "\n" for </tr> directly does not survive: Priority's report
  // HTML is pretty-printed, so the source newlines sitting between </td> and <td>
  // remain after the tags are gone and put every cell on its own line, destroying
  // the table. Collapsing all whitespace is the only way to get rid of those --
  // which means the real boundaries have to be something whitespace-collapsing
  // cannot touch.
  const ROW = " R ";
  const CELL = " C ";

  return html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, ROW)
    .replace(/<\/(tr|p|h\d)>/gi, ROW)
    .replace(/<\/t[dh]>/gi, CELL)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    // Every remaining whitespace run is layout from the source, not content.
    .replace(/\s+/g, " ")
    .split(ROW)
    .map((row) =>
      row
        .split(CELL)
        .map((cell) => cell.trim())
        .filter((cell) => cell !== "")
        .join("\t"),
    )
    .filter((row) => row !== "")
    .join("\n")
    .trim();
}
