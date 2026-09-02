// The Web SDK channel: catalog, existence probing, and a real report run.
//
// Existence probing needs two controls or the result means nothing, because
// procStart reports a missing program as an ordinary message rather than an
// error: a program known to exist must read as present, and a fabricated name
// must read as missing. Without both, "everything exists" and "nothing exists"
// are indistinguishable from a passing test.
import { ProgramRunner } from "../src/programs.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const runner = new ProgramRunner();

console.log("\n1. Configuration and catalog");
const cfgErr = runner.configError;
if (cfgErr) {
  console.log(`  SKIPPED — Web SDK not configured:\n${cfgErr}\n`);
  process.exit(0);
}
ok("Web SDK channel configured (host/company derived from the OData URL)");

const catalog = runner.readCatalog();
if (catalog.length >= 3) ok(`catalog holds ${catalog.length} programs`);
else bad(`catalog holds only ${catalog.length}`);
for (const p of catalog) console.log(`       ${p.name} (${p.type}) — ${p.description}`);

console.log("\n2. Existence probing, with both controls");

// Control A: a program that exists in every Priority installation.
const known = await runner.probe("FORMMSG", "P");
console.log(`  FORMMSG -> status=${known.status} messages=${JSON.stringify(known.messages).slice(0, 120)}`);
if (known.status !== "not_found") {
  ok(`FORMMSG reads as present (status=${known.status})`);
} else bad("FORMMSG reported as not_found — the probe cannot distinguish anything");

// Control B: a name that cannot exist.
const fake = await runner.probe("KARZ_NOSUCHPROC_XYZ", "P");
console.log(`  KARZ_NOSUCHPROC_XYZ -> status=${fake.status}`);
if (fake.status === "not_found") {
  ok("a fabricated name reads as not_found");
} else bad(`fabricated name returned status=${fake.status}, so the probe is not discriminating`);

if (known.status !== "not_found" && fake.status === "not_found") {
  ok("both controls agree — probe results are meaningful");
} else bad("controls disagree; treat probe results as unreliable");

console.log("\n3. Parameters are reported, not guessed");
if (known.inputFields?.length) {
  ok(`FORMMSG asked for ${known.inputFields.length} parameter(s) and nothing was run`);
  for (const f of known.inputFields.slice(0, 5)) {
    console.log(`       field ${f.field}: '${f.title}'${f.mandatory ? " (mandatory)" : ""}`);
  }
} else {
  console.log(`       (no inputFields step seen; status=${known.status})`);
}

console.log("\n4. Running a report end to end");
// Parameter titles on these system reports are English, not Hebrew -- taken from
// what the probe above actually reported rather than assumed.
const rep = await runner.run("FORMTRIGREP", "R", { "Form Name": "ORDERS" });
console.log(`  FORMTRIGREP(ORDERS) -> status=${rep.status}, output=${rep.output?.length ?? 0} chars`);
if (rep.messages.length) console.log(`       messages: ${rep.messages.slice(0, 3).join(" | ")}`);
if (rep.output && rep.output.length > 100) {
  ok(`report produced ${rep.output.length} characters of text`);
  console.log(`       first 200: ${rep.output.slice(0, 200).replace(/\n/g, " / ")}`);
} else if (rep.status === "needs_input") {
  console.log(`       still awaiting input — parameter titles: ${JSON.stringify(rep.inputFields)}`);
  bad("report did not run; the input title did not match");
} else {
  bad(`report produced no usable output (status=${rep.status})`);
}

console.log(failures === 0 ? "\nAll program-channel checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
