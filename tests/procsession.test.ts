// The program step machine, offline, against a scripted fake of the Web SDK.
//
// Two things are pinned here that a live test cannot pin reliably: that a choice
// is never made by the server, and that the interactive path hands every kind of
// step back with the action that answers it. The fake speaks the SDK's own step
// vocabulary (inputFields, inputOptions, reportOptions, displayUrl, message, end)
// so the mapping to the public one (input, choose, askprint, ...) is exercised.
import { ProgramRunner, htmlToText } from "../src/programs.js";
import { CallerError } from "../src/errors.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

type Step = Record<string, unknown> & { type: string; proc?: Record<string, unknown> };

/** A program that asks for a form name, offers two variants, then renders. */
function scriptedProgram(log: string[], opts: { withMessage?: boolean } = {}) {
  const html = "data:text/html;base64," + Buffer.from("<table><tr><td>Form</td><td>ORDERS</td></tr><tr><td>Trigger</td><td>POST-INSERT</td></tr></table>").toString("base64");
  const end: Step = { type: "end" };
  const display: Step = {
    type: "displayUrl",
    Urls: [{ datauri: html, type: "html" }],
    proc: { continueProc: async () => (log.push("continueProc"), end) },
  };
  const report: Step = {
    type: "reportOptions",
    // Priority's real shape: ids, titles, and its own preselection.
    input: {
      formats: [
        { format: 1, selected: 0, title: "Standard", template: 0 },
        { format: -101, selected: 1, title: "Detailed", template: 0 },
      ],
    },
    proc: { reportOptions: async (_a: number, fmt: number) => (log.push(`reportOptions:${fmt}`), display) },
  };
  const choose: Step = {
    type: "inputOptions",
    input: { Options: [{ title: "Full listing" }, { title: "Summary only" }] },
    proc: {
      inputOptions: async (_a: number, n: number) => (log.push(`inputOptions:${n}`), report),
      cancel: async () => (log.push("cancel"), undefined),
    },
  };
  const message: Step = {
    type: "message",
    message: "This will take a while.",
    messagetype: "warning",
    proc: { message: async () => (log.push("message"), choose), cancel: async () => (log.push("cancel"), undefined) },
  };
  const input: Step = {
    type: "inputFields",
    // Shaped like a real reply, measured 2026-09-03 on FORMTRIGREP: a remembered
    // value AND a remembered operator, per-field help, a lookup, and the dialog.
    input: {
      title: "Parameter Input",
      text: "This report displays the contents of row and form triggers.",
      Operators: [{ op: 0, name: "= " }, { op: 5, name: "<>" }, { op: 6, name: "- " }],
      EditFields: [
        {
          field: 1,
          title: "Form Name",
          mandatory: 1,
          helpstring: "\nSpecify the name of the form(s).",
          code: "Str",
          type: "text",
          value: "ORDERS",
          value1: "",
          operator: 5,
          maxlength: 60,
          haszoom: 1,
          zoom: "Search",
          formName: "EXEC",
          columnName: "ENAME",
          ispassword: 0,
          readonly: 0,
        },
        { field: 2, title: "Secret", mandatory: 0, ispassword: 1, value: "hunter2", code: "Str", type: "text" },
      ],
    },
    proc: {
      inputFields: async (_n: number, payload: { EditFields: { field: number; op: number; value: string; value2: string }[] }) => (
        log.push(payload.EditFields.map((e) => `f${e.field}:op${e.op}:${e.value}${e.value2 ? `..${e.value2}` : ""}`).join(",")),
        opts.withMessage ? message : choose
      ),
      cancel: async () => (log.push("cancel"), undefined),
    },
  };
  return {
    login: async () => undefined,
    procStart: async (name: string, type: string) => (log.push(`procStart:${name}:${type}`), input),
  };
}

// Keep the SDK config valid regardless of the developer's .env: the seam skips
// login, but loadWebSdkConfig() still wants these to exist.
process.env["PRIORITY_ODATA_URL"] ??= "https://example.test/odata/Priority/tabula.ini,1/demo";
process.env["PRIORITY_USER"] ??= "u";
process.env["PRIORITY_PASS"] ??= "p";

console.log("\n1. run_program stops at a choice instead of choosing");
{
  const log: string[] = [];
  const runner = new ProgramRunner(undefined, scriptedProgram(log) as unknown as Record<string, unknown>);
  const r = await runner.run("FORMTRIGREP", "R", { "Form Name": "ORDERS" });
  if (r.status === "needs_choice" && r.options?.length === 2 && r.options[1]?.label === "Summary only") {
    ok(`status=needs_choice with ${r.options.length} options`);
  } else bad(`status=${r.status} options=${JSON.stringify(r.options)}`);
  if (!log.some((l) => l.startsWith("inputOptions:"))) ok("inputOptions was never called -- nothing was chosen");
  else bad(`a choice was made: ${log.join(" > ")}`);
  if (log.includes("cancel")) ok("the run was cancelled cleanly");
  else bad("no cancel after stopping");
}

console.log("\n2. A session hands each step back and answers it");
{
  const log: string[] = [];
  const runner = new ProgramRunner(undefined, scriptedProgram(log, { withMessage: true }) as unknown as Record<string, unknown>);
  const s1 = await runner.start("FORMTRIGREP", "R");
  if (s1.step.kind === "input" && s1.step.fields?.[0]?.title === "Form Name" && !s1.done) ok("start -> input, with the field titles");
  else bad(`start: ${JSON.stringify(s1.step).slice(0, 200)}`);

  let refused = false;
  try {
    await runner.continue(s1.session, { choose: 1 });
  } catch (err) {
    refused = /input.{0,40}step|does not answer/i.test(String(err));
  }
  if (refused) ok("answering an input step with 'choose' is refused without touching the program");
  else bad("a wrong action was accepted");

  const f1 = s1.step.fields?.[0];
  if (f1?.help === "Specify the name of the form(s)." && f1.defaultValue === "ORDERS" && f1.lookup === "EXEC.ENAME" && f1.maxLength === 60) {
    ok("the field carries help, defaultValue, lookup and maxLength");
  } else bad(`field 1: ${JSON.stringify(f1)}`);
  const secret = s1.step.fields?.[1];
  if (secret?.isPassword === true && secret.defaultValue === undefined) ok("a password field is flagged and its value is NOT echoed");
  else bad(`password field: ${JSON.stringify(secret)}`);
  if (s1.step.dialog?.text?.startsWith("This report displays") && s1.step.operators?.length === 3) {
    ok("the dialog text and the operator list come through");
  } else bad(`dialog=${JSON.stringify(s1.step.dialog)} operators=${JSON.stringify(s1.step.operators)}`);

  const s2 = await runner.continue(s1.session, { input: { "Form Name": "ORDERS" } });
  if (log.some((l) => l.includes("f1:op0:ORDERS"))) ok("a plain string sends operator 0 (=), not the remembered 5");
  else bad(`payload: ${log.join(" > ")}`);
  if (log.some((l) => /f2:op0:hunter2/.test(l))) ok("an untouched field keeps its remembered value");
  else bad(`untouched field was blanked: ${log.join(" > ")}`);
  if (s2.step.kind === "message" && /take a while/.test(s2.step.message ?? "")) ok("input -> message (a warning the user must see)");
  else bad(`after input: ${JSON.stringify(s2.step).slice(0, 200)}`);

  const s3 = await runner.continue(s2.session, { acknowledge: true });
  if (s3.step.kind === "choose" && s3.step.options?.length === 2) ok("message -> choose, with both options");
  else bad(`after acknowledge: ${JSON.stringify(s3.step).slice(0, 200)}`);

  let outOfRange = false;
  try {
    await runner.continue(s3.session, { choose: 7 });
  } catch {
    outOfRange = true;
  }
  if (outOfRange) ok("an option index out of range is refused");
  else bad("choose: 7 was accepted for 2 options");

  const s4 = await runner.continue(s3.session, { choose: 2 });
  if (s4.step.kind === "askprint" && s4.step.formats?.length === 2 && s4.step.formats[1]?.title === "Detailed") {
    ok("choose -> askprint, carrying PRIORITY's own format list with titles");
  } else bad(`after choose: ${JSON.stringify(s4.step).slice(0, 250)}`);
  let badFormat = false;
  try {
    await runner.continue(s4.session, { output: { format: 999 } });
  } catch {
    badFormat = true;
  }
  if (badFormat) ok("a format id the program does not offer is refused");
  else bad("format 999 was accepted");
  let notADoc = false;
  try {
    await runner.continue(s4.session, { output: { signature: true } });
  } catch {
    notADoc = true;
  }
  if (notADoc) ok("signature on a REPORT step is refused -- it is a document flag");
  else bad("signature was accepted on a report step");
  if (log.includes("inputOptions:2")) ok("the USER's choice (2) reached the program");
  else bad(`choice not forwarded: ${log.join(" > ")}`);

  const s5 = await runner.continue(s4.session, { output: {} });
  if (log.some((l) => l === "reportOptions:-101")) ok("output:{} takes Priority's PRESELECTED format (-101), not a guess");
  else bad(`format sent: ${log.filter((l) => l.startsWith("reportOptions")).join(",")}`);
  if (s5.done && s5.step.kind === "end" && /ORDERS\tPOST-INSERT|Form\tORDERS/.test(s5.step.output ?? "")) {
    ok("output -> end, with the report flattened to tab-separated text");
  } else bad(`after output: ${JSON.stringify(s5.step).slice(0, 300)}`);
  if (runner.openSessions === 0) ok("the session was closed on end");
  else bad(`${runner.openSessions} session(s) still open`);

  let gone = false;
  try {
    await runner.continue(s5.session, { poll: true });
  } catch (err) {
    gone = /No open program session/.test(String(err));
  }
  if (gone) ok("a finished session id is refused with a clear message");
  else bad("a finished session was still usable");
}

console.log("\n3. Cancel and two-actions-at-once");
{
  const log: string[] = [];
  const runner = new ProgramRunner(undefined, scriptedProgram(log) as unknown as Record<string, unknown>);
  const s1 = await runner.start("FORMTRIGREP", "R");
  let twoRefused = false;
  try {
    await runner.continue(s1.session, { input: { "Form Name": "X" }, cancel: true });
  } catch (err) {
    twoRefused = /exactly ONE action/.test(String(err));
  }
  if (twoRefused) ok("two actions in one call are refused");
  else bad("two actions were accepted");
  const c = await runner.continue(s1.session, { cancel: true });
  if (c.done && log.includes("cancel") && runner.openSessions === 0) ok("cancel closes the session and tells the SDK");
  else bad(`cancel: done=${c.done} log=${log.join(" > ")}`);
}

console.log("\n4. A program that does not exist");
{
  const log: string[] = [];
  const sdk = {
    login: async () => undefined,
    procStart: async () => ({
      type: "message",
      message: "No such Tabula Entity",
      proc: { message: async () => ({ type: "end" }), cancel: async () => (log.push("cancel"), undefined) },
    }),
  };
  const runner = new ProgramRunner(undefined, sdk as unknown as Record<string, unknown>);
  const s = await runner.start("NOPE", "P");
  if (s.done && /no program named NOPE/.test(s.step.next)) ok("start on a missing program ends with a plain explanation");
  else bad(`missing program: ${JSON.stringify(s.step).slice(0, 200)}`);
}

console.log("\n5. A probe of a PARAMETERLESS procedure does not run it");
{
  // The tool promises the first call runs nothing. A procedure with no input
  // dialog used to sail past that promise, because the loop only stopped at
  // 'inputFields'. With every procedure in the installation now reachable, the
  // promise has to hold for the ones that ask nothing too.
  const mk = (acted: string[]) => ({
    login: async () => undefined,
    procStart: async () => ({
      type: "message",
      message: "Posted 412 documents.",
      messagetype: "info",
      proc: {
        message: async () => (acted.push("RAN"), { type: "end" }),
        cancel: async () => (acted.push("cancelled"), undefined),
      },
    }),
  });
  let acted: string[] = [];
  let r = await new ProgramRunner(undefined, mk(acted) as unknown as Record<string, unknown>).probe("PARAMLESS", "P");
  if (r.status === "would_run" && !acted.includes("RAN") && acted.includes("cancelled")) {
    ok("a procedure probe stops with would_run and cancels");
  } else bad(`P probe: status=${r.status} acted=${acted.join(",")}`);
  const said = r.messages.join(" ");
  if (said.includes("inputs:{}") && said.includes("help{")) {
    ok("the message says how to run it deliberately, and to read help first");
  } else bad(`message: ${said}`);

  acted = [];
  r = await new ProgramRunner(undefined, mk(acted) as unknown as Record<string, unknown>).probe("PARAMLESS", "R");
  if (r.status === "completed" && acted.includes("RAN")) ok("a REPORT still renders -- that is what a report is");
  else bad(`R probe: status=${r.status} acted=${acted.join(",")}`);

  acted = [];
  r = await new ProgramRunner(undefined, mk(acted) as unknown as Record<string, unknown>).run("PARAMLESS", "P", {});
  if (r.status === "completed" && acted.includes("RAN")) ok("inputs:{} runs the procedure deliberately");
  else bad(`deliberate run: status=${r.status} acted=${acted.join(",")}`);
}

console.log("\n6. Session misuse is a CallerError, not a Priority failure");
{
  // The tool wrapper words the two differently, and the difference is what stops
  // a model reporting an ERP outage over an argument it chose itself.
  const log: string[] = [];
  const runner = new ProgramRunner(undefined, scriptedProgram(log) as unknown as Record<string, unknown>);
  const s1 = await runner.start("FORMTRIGREP", "R");
  const cases: [string, () => Promise<unknown>][] = [
    ["wrong action for the step", () => runner.continue(s1.session, { choose: 1 })],
    ["two actions at once", () => runner.continue(s1.session, { poll: true, cancel: true })],
    ["unknown session", () => runner.continue("no-such-session", { poll: true })],
    ["option index out of range", () => runner.continue(s1.session, { choose: 99 })],
  ];
  for (const [label, run] of cases) {
    try {
      await run();
      bad(`${label} was accepted`);
    } catch (err) {
      if (err instanceof CallerError) ok(`${label} -> CallerError`);
      else bad(`${label} -> ${err instanceof Error ? err.constructor.name : typeof err}`);
    }
  }
  await runner.continue(s1.session, { cancel: true });
}

console.log("\n7. A program that asks TWICE, behind a format step");
{
  // Shaped on AGEDEBTCUST3, measured 2026-09-05: its first step is a format
  // question and TWO parameter dialogs follow it. The old code checked supplied
  // keys against one dialog at a time, so a key for the second was refused at
  // the first and a key for the first was refused at the second -- both correct,
  // neither ever accepted, and the run impossible to parameterise at all.
  const scripted = (log: string[]) => {
    const end: Step = { type: "end" };
    const display: Step = {
      type: "displayUrl",
      Urls: [{ datauri: "data:text/html;base64," + Buffer.from("<table><tr><td>ok</td></tr></table>").toString("base64"), type: "html" }],
      proc: {
        continueProc: async () => (log.push("continueProc"), end),
        // The real SDK offers cancel on every step; without it here the test
        // cannot tell "stopped before output" from "never tried to stop".
        cancel: async () => (log.push("cancel"), undefined),
      },
    };
    const second: Step = {
      type: "inputFields",
      input: { EditFields: [{ field: 2, title: "As of Date", mandatory: 1, value: "05/09/26" }] },
      proc: {
        inputFields: async (_n: number, payload: { EditFields: { field: number; value: string }[] }) => {
          log.push(`dlg2:${payload.EditFields.map((f) => `${f.field}=${f.value}`).join(",")}`);
          return display;
        },
        cancel: async () => (log.push("cancel"), undefined),
      },
    };
    const first: Step = {
      type: "inputFields",
      input: { EditFields: [{ field: 1, title: "Subsidiary", value: "000" }] },
      proc: {
        inputFields: async (_n: number, payload: { EditFields: { field: number; value: string }[] }) => {
          log.push(`dlg1:${payload.EditFields.map((f) => `${f.field}=${f.value}`).join(",")}`);
          return second;
        },
        cancel: async () => (log.push("cancel"), undefined),
      },
    };
    // The format question comes FIRST, before either dialog.
    const fmt: Step = {
      type: "reportOptions",
      input: { formats: [{ format: 1, selected: 1, title: "Standard" }] },
      proc: { reportOptions: async () => first, cancel: async () => (log.push("cancel"), undefined) },
    };
    return fmt;
  };
  const sdkFor = (log: string[]) =>
    ({ login: async () => undefined, procStart: async () => scripted(log) }) as unknown as Record<string, unknown>;

  {
    const log: string[] = [];
    const runner = new ProgramRunner("demo", sdkFor(log));
    const r = await runner.run("TWODLG", "R", { Subsidiary: "000", "As of Date": "31/12/25" });
    if (r.status === "completed") ok("keys for BOTH dialogs are accepted in one call");
    else bad(`status=${r.status} messages=${r.messages.join(" | ")}`);
    if (log.includes("dlg1:1=000") && log.includes("dlg2:2=31/12/25")) {
      ok("each key reached the dialog that owns it");
    } else bad(`payloads: ${log.join(" ; ")}`);
  }

  {
    const log: string[] = [];
    const runner = new ProgramRunner("demo", sdkFor(log));
    const r = await runner.run("TWODLG", "R", { "As of Date": "31/12/25" });
    if (r.status === "completed") ok("a key for the SECOND dialog alone is accepted");
    else bad(`status=${r.status} -- refused at the first dialog again`);
  }

  {
    const log: string[] = [];
    const runner = new ProgramRunner("demo", sdkFor(log));
    const r = await runner.run("TWODLG", "R", { Nonsense: "x" });
    if (r.status === "unmatched_inputs" && r.unmatchedInputs?.[0] === "Nonsense") {
      ok("a key no dialog accepts is still refused");
    } else bad(`a bogus key produced status=${r.status}`);
    // It cancels before OUTPUT, which is as early as Priority allows: dialog two
    // is invisible until dialog one has been submitted, so a multi-dialog
    // program cannot be validated without walking its questions.
    if (log.includes("cancel") && !log.includes("continueProc")) {
      ok("the refusal cancels before any output is produced");
    } else bad(`refusal came too late: ${log.join(" ; ")}`);
    // And it must not claim nothing happened, because the dialogs were answered.
    const said = r.messages.join(" ");
    if (said.includes("remembered defaults") && !said.includes("Nothing was executed")) {
      ok("and says the dialogs were answered rather than claiming nothing ran");
    } else bad(`message hides what happened: ${said}`);
  }

  {
    const log: string[] = [];
    const runner = new ProgramRunner("demo", sdkFor(log));
    const r = await runner.probe("TWODLG", "P");
    // A format question is not the program acting, so a probe walks past it and
    // reports the parameters instead of claiming there are none.
    if (r.status === "needs_input" && (r.inputFields ?? [])[0]?.title === "Subsidiary") {
      ok("a probe passes the format step and reports the real first dialog");
    } else bad(`probe gave status=${r.status}: ${r.messages.join(" | ")}`);
  }
}

console.log("\n8. htmlToText keeps rows and cells apart");
const t = htmlToText("<html><head><style>x</style></head><body><table>\n  <tr>\n    <td>a</td>\n    <td>b</td>\n  </tr>\n  <tr><td>c</td></tr></table></body></html>");
if (t === "a\tb\nc") ok("pretty-printed HTML flattens to a\\tb / c");
else bad(`got ${JSON.stringify(t)}`);

console.log(failures === 0 ? "\nAll program-session checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
