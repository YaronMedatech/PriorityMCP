// An interactive program session against the real Web SDK.
//
// Skips with the SDK's own reason when it cannot log in -- on the hosted
// installation measured 2026-09-02 the WCF endpoint answers 403 -- because that
// is a fact about the host, not about this code, and the offline suite already
// pins the step machine.
import { ProgramRunner } from "../src/programs.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const runner = new ProgramRunner();
if (runner.configError) {
  console.log(`\nSKIP — Web SDK not configured: ${runner.configError.split("\n")[0]}\n`);
  process.exit(0);
}

console.log("\n1. start FORMTRIGREP");
let first;
try {
  first = await runner.start("FORMTRIGREP", "R");
} catch (err) {
  console.log(`  SKIP — the Web SDK could not start a program:\n       ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}\n`);
  process.exit(0);
}
console.log(`  step: ${first.step.kind} — ${first.step.next.slice(0, 80)}`);
if (first.step.kind === "input" && first.step.fields?.length) ok(`asks for ${first.step.fields.map((f) => `'${f.title}'`).join(", ")}`);
else bad(`unexpected first step: ${JSON.stringify(first.step).slice(0, 200)}`);

console.log("\n2. answer, then walk to the end, choosing HTML when asked");
let reply = await runner.continue(first.session, { input: { [first.step.fields?.[0]?.title ?? "Form Name"]: "ORDERS" } });
let guard = 0;
while (!reply.done && guard++ < 10) {
  console.log(`  step: ${reply.step.kind}`);
  if (reply.step.kind === "askprint") reply = await runner.continue(reply.session, { output: { format: "HTML" } });
  else if (reply.step.kind === "message") reply = await runner.continue(reply.session, { acknowledge: true });
  else if (reply.step.kind === "displayurl") reply = await runner.continue(reply.session, { poll: true });
  else if (reply.step.kind === "choose") {
    console.log(`  the program offers a choice: ${JSON.stringify(reply.step.options)} — cancelling, a test must not choose`);
    reply = await runner.continue(reply.session, { cancel: true });
  } else break;
}
if (reply.done) ok(`ended after ${reply.steps} step(s); output ${reply.step.output?.length ?? 0} chars`);
else bad(`did not end: ${JSON.stringify(reply.step).slice(0, 200)}`);
if (reply.step.output && reply.step.output.length > 100) console.log(`  first 200: ${reply.step.output.slice(0, 200).replace(/\n/g, " / ")}`);

console.log(failures === 0 ? "\nAll live session checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
