import fs from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { loadWebSdkConfig, type WebSdkConfig } from "./config.js";
import { CallerError } from "./errors.js";

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
//
// Two ways to run. `run()` drives a program to the end in one call and is right
// for a report with known parameters. A SESSION (`start()` / `continue()`) hands
// every decision back to the caller: a choice between options, a warning to
// acknowledge, an output format. The one-call path used to make those decisions
// itself -- it picked option 1 of every choice, silently -- which is how a model
// runs the wrong variant of a procedure and reports "completed". It now stops.

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
  Urls?: { datauri?: string; url?: string; type?: string }[];
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

export interface InputField {
  field: number;
  title: string;
  code?: string;
  mandatory: boolean;
}

/** A choice the program offers. `index` is what continue{choose} takes. */
export interface ChoiceOption {
  index: number;
  label: string;
}

export interface ProgramRunResult {
  program: string;
  type: "P" | "R";
  status:
    | "completed"
    | "needs_input"
    | "needs_choice"
    | "message"
    | "not_found"
    | "error"
    | "unmatched_inputs";
  messages: string[];
  /** Parameters the program is waiting for, with their Hebrew titles. */
  inputFields?: InputField[];
  /** Present with `needs_choice`: the program stopped at a choice this call will not make. */
  options?: ChoiceOption[];
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

/**
 * The vocabulary a session speaks. Deliberately the one Priority's own MCP uses
 * (input / choose / warning / askprint / displayurl / end), so a model that has
 * seen either server recognises the other.
 */
export type StepKind = "input" | "choose" | "message" | "askprint" | "displayurl" | "end";

export interface SessionStep {
  kind: StepKind;
  /** `input`: the parameters wanted. Answer with continue{input}. */
  fields?: InputField[];
  /** `choose`: the options offered. Answer with continue{choose: index}. */
  options?: ChoiceOption[];
  /** `message`: what Priority said. Answer with continue{acknowledge: true}. */
  message?: string;
  messageType?: string;
  /** `askprint`: output formats this server can ask for. Answer with continue{output}. */
  formats?: string[];
  /** `displayurl` / `end`: report output as text, plus any URLs Priority handed back. */
  output?: string;
  truncated?: boolean;
  urls?: { url?: string; type?: string; bytes?: number }[];
  /** Everything Priority said along the way, oldest first. */
  messages: string[];
  /** What to do next, in words. */
  next: string;
}

export interface SessionReply {
  session: string;
  program: string;
  type: "P" | "R";
  /** True once the program has ended or been cancelled; the session id is then invalid. */
  done: boolean;
  step: SessionStep;
  steps: number;
}

export type SessionAction = {
  input?: Record<string, string>;
  choose?: number;
  acknowledge?: true;
  output?: { format?: "HTML" | "PDF" };
  poll?: true;
  cancel?: true;
};

interface LiveSession {
  id: string;
  program: string;
  type: "P" | "R";
  step: ProcStep | undefined;
  messages: string[];
  html: string;
  urls: { url?: string; type?: string; bytes?: number }[];
  steps: number;
  timer: NodeJS.Timeout;
}

const MAX_OUTPUT_CHARS = 60_000;
const MAX_STEPS = 40;
/**
 * An abandoned session is cancelled after this long. A Priority procedure left
 * open holds server-side state, and a model that wandered off mid-run will not
 * come back to close it.
 */
export const SESSION_TTL_MS = 5 * 60_000;

/** Priority's answer when a program name does not exist. Not an error, a message. */
const NOT_FOUND_MARKER = "No such Tabula Entity";

export class ProgramRunner {
  private sdk: Record<string, unknown> | undefined;
  private loggedIn = false;
  private readonly cfg: WebSdkConfig | { error: string };
  private readonly sessions = new Map<string, LiveSession>();

  /**
   * @param company Run programs against this Priority company rather than the
   *   default. A program acts on data, so it must target the same company the
   *   session is reading — otherwise it would change data the caller never saw.
   * @param sdk Test seam: an already-logged-in SDK object. Skips the vendored
   *   module and the login, so the step machine can be exercised offline.
   */
  constructor(company?: string, sdk?: Record<string, unknown>) {
    this.cfg = loadWebSdkConfig(company);
    if (sdk) {
      this.sdk = sdk;
      this.loggedIn = true;
    }
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

    try {
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
    } catch (err) {
      // The SDK rejects with a plain object, and String() of that is
      // "[object Object]" -- which hides the one fact that matters.
      const detail = err instanceof Error ? err.message : JSON.stringify(err);
      const who = cfg.identity === "pat" ? "the PAT" : `user ${cfg.username}`;
      throw new Error(
        `The Web SDK could not log in to ${cfg.url} (tabula ${cfg.tabulaini}, company ` +
          `${cfg.company}, hosting ${cfg.hosting}) as ${who}: ${detail}. Unless the URL ` +
          `ends in .svc the SDK appends /wcf/wcf/Service.svc to it; Priority's cloud ` +
          `wants https://<host>/wcf/service.svc instead. The URL and the identity order ` +
          `follow PRIORITY_HOSTING (cloud / self-hosted; detected from the host name ` +
          `when unset), and PRIORITY_HOST_URL overrides the URL outright. "Can't ` +
          `connect to server" is also what the SDK says when the identity is refused, ` +
          `so check the token or user before the network.`,
      );
    }

    this.sdk = sdk;
    this.loggedIn = true;
    return sdk;
  }

  private async procStart(name: string, type: "P" | "R"): Promise<ProcStep> {
    const sdk = await this.ensureLogin();
    const company = "error" in this.cfg ? undefined : this.cfg.company;
    const start = sdk["procStart"] as (
      n: string,
      t: string,
      cb: (p: unknown) => void,
      o: unknown,
    ) => Promise<ProcStep>;
    return start(name, type, () => {}, { company });
  }

  // -- one-call running ------------------------------------------------------

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
    const result: ProgramRunResult = {
      program: name,
      type,
      status: "completed",
      messages: [],
      steps: 0,
    };
    let html = "";

    let step: ProcStep | undefined = await this.procStart(name, type);

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
        result.inputFields = describeFields(fields);

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
        const unmatched = unmatchedKeys(fields, inputs);
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

        step = await proc?.inputFields?.(1, { EditFields: editPayload(fields, inputs) });
        continue;
      }

      if (kind === "inputOptions") {
        // A choice is a decision, and this path has no caller to make it. It
        // used to pick option 1 here, which ran whichever variant happened to be
        // listed first and reported success. Stop instead: the caller can use a
        // session, where the choice is theirs.
        result.status = "needs_choice";
        result.options = describeOptions(step.input?.Options ?? []);
        result.messages.push(
          `Not run to completion: ${name} asks for a choice between ${result.options.length} ` +
            `option(s), and run_program does not choose for you. Use start_program and ` +
            `continue_program{choose} to make that choice.`,
        );
        await proc?.cancel?.().catch(() => undefined);
        return finish(result, html, keepHtml);
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

  // -- interactive sessions --------------------------------------------------

  /**
   * Start a program and advance it to the first point that needs the caller.
   *
   * Nothing is decided here. Input is not invented, choices are not made,
   * messages are not waved through: each is handed back as the current step,
   * and the run waits until continue() answers it or the TTL cancels it.
   */
  async start(name: string, type: "P" | "R"): Promise<SessionReply> {
    this.sweep();
    const step = await this.procStart(name, type);
    const sess: LiveSession = {
      id: randomUUID(),
      program: name,
      type,
      step,
      messages: [],
      html: "",
      urls: [],
      steps: 0,
      // Placeholder; touch() arms the real TTL timer against the session id,
      // which does not exist until this literal is complete.
      timer: setTimeout(() => undefined, 0),
    };
    this.touch(sess);
    this.sessions.set(sess.id, sess);
    return this.settle(sess);
  }

  /** Answer the current step of a session and advance to the next one. */
  async continue(sessionId: string, action: SessionAction): Promise<SessionReply> {
    this.sweep();
    const sess = this.sessions.get(sessionId);
    if (!sess) {
      throw new CallerError(
        `No open program session '${sessionId}'. It has ended, been cancelled, or ` +
          `expired after ${SESSION_TTL_MS / 60_000} minutes without activity. Call ` +
          `start_program again.`,
      );
    }
    const keys = (Object.keys(action) as (keyof SessionAction)[]).filter((k) => action[k] !== undefined);
    if (keys.length !== 1) {
      throw new CallerError(
        `continue_program takes exactly ONE action; got ${keys.length ? keys.join(", ") : "none"}. ` +
          `Use one of: input, choose, acknowledge, output, poll, cancel.`,
      );
    }
    this.touch(sess);

    if (action.cancel) {
      await sess.step?.proc?.cancel?.().catch(() => undefined);
      this.close(sess);
      return this.reply(sess, {
        kind: "end",
        messages: sess.messages,
        next: "Cancelled. Nothing further will run.",
      });
    }

    const proc = sess.step?.proc;
    const current = String(sess.step?.type ?? "");
    const mismatch = (wanted: string): never => {
      throw new CallerError(
        `The session is at the '${publicKind(current)}' step, which '${wanted}' does not answer. ` +
          `Read 'step.next' in the last reply and send the action it asks for.`,
      );
    };

    if (action.input) {
      if (current !== "inputFields") mismatch("input");
      const fields = sess.step?.input?.EditFields ?? [];
      const unmatched = unmatchedKeys(fields, action.input);
      if (unmatched.length) {
        throw new CallerError(
          `These input keys match no parameter of ${sess.program}: ${unmatched.join(", ")}. ` +
            `Use the exact 'title', 'code' or 'field' from the step's fields. Nothing was sent.`,
        );
      }
      sess.step = await proc?.inputFields?.(1, { EditFields: editPayload(fields, action.input) });
    } else if (action.choose !== undefined) {
      if (current !== "inputOptions") mismatch("choose");
      const n = describeOptions(sess.step?.input?.Options ?? []).length;
      if (!Number.isInteger(action.choose) || action.choose < 1 || (n && action.choose > n)) {
        throw new CallerError(`choose must be an option index from 1 to ${n || "?"}; got ${action.choose}.`);
      }
      sess.step = await proc?.inputOptions?.(1, action.choose);
    } else if (action.acknowledge) {
      if (current !== "message") mismatch("acknowledge");
      sess.step = await proc?.message?.(1);
    } else if (action.output) {
      if (current !== "reportOptions" && current !== "documentOptions") mismatch("output");
      const format = action.output.format ?? "HTML";
      sess.step =
        current === "reportOptions"
          ? await proc?.reportOptions?.(1, format, {})
          : await proc?.documentOptions?.(1, format, {});
    } else if (action.poll) {
      sess.step = await proc?.continueProc?.();
    }
    sess.steps++;
    return this.settle(sess);
  }

  /** Open sessions, for diagnostics. */
  get openSessions(): number {
    return this.sessions.size;
  }

  /**
   * Advance through the steps that need nobody -- help screens, report output
   * being handed over -- and stop at the first that needs the caller, or at end.
   */
  private async settle(sess: LiveSession): Promise<SessionReply> {
    while (sess.step && sess.steps < MAX_STEPS) {
      const proc = sess.step.proc;
      const kind = String(sess.step.type ?? "");

      if (kind === "end") {
        this.close(sess);
        return this.reply(sess, {
          kind: "end",
          ...outputOf(sess),
          messages: sess.messages,
          next: "Finished. The session is closed.",
        });
      }
      if (kind === "message") {
        const text = String(sess.step.message ?? "");
        sess.messages.push(text);
        if (text.includes(NOT_FOUND_MARKER)) {
          await proc?.cancel?.().catch(() => undefined);
          this.close(sess);
          return this.reply(sess, {
            kind: "end",
            message: text,
            messages: sess.messages,
            next: `Priority has no program named ${sess.program} of type ${sess.type}. Nothing ran.`,
          });
        }
        return this.reply(sess, {
          kind: "message",
          message: text,
          messageType: String(sess.step.messagetype ?? "") || undefined,
          messages: sess.messages,
          next:
            "Priority is showing a message. Relay it to the user. If they want to go on, " +
            "send continue{acknowledge: true}; otherwise continue{cancel: true}.",
        });
      }
      if (kind === "inputFields") {
        return this.reply(sess, {
          kind: "input",
          fields: describeFields(sess.step.input?.EditFields ?? []),
          messages: sess.messages,
          next:
            "The program wants parameters. Ask the user for any you do not have, then " +
            "send continue{input: {<title or code or field>: value}}. Do not invent values.",
        });
      }
      if (kind === "inputOptions") {
        return this.reply(sess, {
          kind: "choose",
          options: describeOptions(sess.step.input?.Options ?? []),
          messages: sess.messages,
          next:
            "The program offers a choice. Show the options to the user and send " +
            "continue{choose: index} with THEIR answer. Do not pick one yourself.",
        });
      }
      if (kind === "reportOptions" || kind === "documentOptions") {
        return this.reply(sess, {
          kind: "askprint",
          formats: ["HTML", "PDF"],
          messages: sess.messages,
          next:
            "The output is ready to be produced. Send continue{output: {format: 'HTML'}} " +
            "for text you can read here, or 'PDF' for a file URL when Priority provides one.",
        });
      }
      if (kind === "inputHelp") {
        sess.step = await proc?.inputHelp?.(1);
        sess.steps++;
        continue;
      }
      if (kind === "displayUrl") {
        for (const u of sess.step.Urls ?? []) {
          if (u.datauri) {
            const decoded = decodeDataUri(u.datauri);
            if (/^\s*</.test(decoded) || /text\/html/i.test(u.datauri.slice(0, 40))) sess.html += decoded;
            else sess.urls.push({ type: u.type, bytes: Math.floor((u.datauri.length * 3) / 4) });
          }
          if (u.url) sess.urls.push({ url: u.url, type: u.type });
        }
        sess.step = await proc?.continueProc?.();
        sess.steps++;
        continue;
      }
      if (kind === "waitProcess" || kind === "waitExecution") {
        return this.reply(sess, {
          kind: "displayurl",
          ...outputOf(sess),
          messages: sess.messages,
          next: "Priority is still working. Send continue{poll: true} to check again.",
        });
      }

      await proc?.cancel?.().catch(() => undefined);
      this.close(sess);
      return this.reply(sess, {
        kind: "end",
        message: `Unhandled step type '${kind}' -- the run was cancelled here.`,
        messages: sess.messages,
        next: "The run stopped at a step this server does not know. Report it.",
      });
    }

    if (sess.steps >= MAX_STEPS) {
      await sess.step?.proc?.cancel?.().catch(() => undefined);
      this.close(sess);
      return this.reply(sess, {
        kind: "end",
        message: `Gave up after ${MAX_STEPS} steps without reaching the end.`,
        messages: sess.messages,
        next: "The program did not finish within the step limit and was cancelled.",
      });
    }
    // step became undefined: the SDK ended without an 'end' step.
    this.close(sess);
    return this.reply(sess, { kind: "end", ...outputOf(sess), messages: sess.messages, next: "Finished." });
  }

  private reply(sess: LiveSession, step: SessionStep): SessionReply {
    return {
      session: sess.id,
      program: sess.program,
      type: sess.type,
      done: step.kind === "end",
      step,
      steps: sess.steps,
    };
  }

  private touch(sess: LiveSession): void {
    clearTimeout(sess.timer);
    sess.timer = setTimeout(() => void this.expire(sess.id), SESSION_TTL_MS);
    sess.timer.unref();
  }

  private close(sess: LiveSession): void {
    clearTimeout(sess.timer);
    this.sessions.delete(sess.id);
  }

  private async expire(id: string): Promise<void> {
    const sess = this.sessions.get(id);
    if (!sess) return;
    await sess.step?.proc?.cancel?.().catch(() => undefined);
    this.close(sess);
  }

  /** Test seam and belt-and-braces: cancel anything whose timer somehow did not fire. */
  private sweep(): void {
    // Timers do the work; this exists so a session cannot outlive the TTL because
    // a timer was cleared without being re-armed.
    for (const sess of this.sessions.values()) {
      if (!sess.timer.hasRef?.() && this.sessions.size > 50) void this.expire(sess.id);
    }
  }
}

// -- helpers -----------------------------------------------------------------

function describeFields(fields: EditField[]): InputField[] {
  return fields.map((f) => ({
    field: Number(f.field ?? 0),
    title: String(f.title ?? ""),
    ...(f.code ? { code: String(f.code) } : {}),
    mandatory: Boolean(f.mandatory),
  }));
}

/**
 * Options as the SDK hands them. Their shape has not been measured on a real
 * program yet, so the label is best effort: whatever text-like field is there,
 * else the JSON. The index is what matters -- it is what inputOptions() takes.
 */
function describeOptions(options: unknown[]): ChoiceOption[] {
  return options.map((o, i) => {
    const r = (o ?? {}) as Record<string, unknown>;
    const label = r["title"] ?? r["text"] ?? r["name"] ?? r["value"] ?? (typeof o === "string" ? o : JSON.stringify(o));
    return { index: i + 1, label: String(label) };
  });
}

function unmatchedKeys(fields: EditField[], inputs: Record<string, string>): string[] {
  const accepted = new Set<string>();
  for (const f of fields) {
    for (const k of [f.title, f.code, f.field]) {
      if (k !== undefined && k !== null && String(k) !== "") accepted.add(String(k));
    }
  }
  return Object.keys(inputs).filter((k) => !accepted.has(k));
}

/** Match supplied values by Hebrew title, by code, or by field number. */
function editPayload(fields: EditField[], inputs: Record<string, string>) {
  return fields.map((f) => ({
    field: Number(f.field ?? 0),
    op: 0,
    value: inputs[String(f.title ?? "")] ?? inputs[String(f.code ?? "")] ?? inputs[String(f.field ?? "")] ?? "",
    op2: 0,
    value2: "",
  }));
}

function outputOf(sess: LiveSession): Pick<SessionStep, "output" | "truncated" | "urls"> {
  const out: Pick<SessionStep, "output" | "truncated" | "urls"> = {};
  if (sess.html) {
    const text = htmlToText(sess.html);
    out.output = text.slice(0, MAX_OUTPUT_CHARS);
    if (text.length > MAX_OUTPUT_CHARS) out.truncated = true;
  }
  if (sess.urls.length) out.urls = sess.urls;
  return out;
}

function publicKind(sdkType: string): string {
  return (
    {
      inputFields: "input",
      inputOptions: "choose",
      message: "message",
      reportOptions: "askprint",
      documentOptions: "askprint",
      displayUrl: "displayurl",
      end: "end",
    } as Record<string, string>
  )[sdkType] ?? sdkType;
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
export function htmlToText(html: string): string {
  // Structure is marked with sentinels BEFORE tags are stripped, then restored
  // last. Substituting "\n" for </tr> directly does not survive: Priority's report
  // HTML is pretty-printed, so the source newlines sitting between </td> and <td>
  // remain after the tags are gone and put every cell on its own line, destroying
  // the table. Collapsing all whitespace is the only way to get rid of those --
  // which means the real boundaries have to be something whitespace-collapsing
  // cannot touch. Control characters, not letters: an earlier " C " / " R " pair
  // needed the surrounding spaces to be recognised, and the last cell of a row
  // ("</td></tr>") kept a stray " C" because the row sentinel ate one of them.
  const ROW = "";
  const CELL = "";

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
