// Third-party finding #2: a misspelled parameter name was silently dropped and
// the program ran against its defaults, reporting "completed".
//
// FORMMSG is the control program -- present in every installation and read-only,
// so it is safe to attempt. The point is that the attempt must NOT happen.
import { ProgramRunner } from "../src/programs.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const programs = new ProgramRunner();
if (programs.configError) {
  console.log(`\nWeb SDK not configured: ${programs.configError}\n`);
  process.exit(0);
}

console.log("\n1. Discover the real parameter names (no inputs sent)");
const probe = await programs.probe("FORMMSG", "P");
console.log(`   status=${probe.status}`);
for (const f of probe.inputFields ?? []) {
  console.log(`   field ${f.field}: "${f.title}"${f.mandatory ? " (mandatory)" : ""}`);
}
const realTitle = probe.inputFields?.[0]?.title;
if (probe.status === "needs_input" && realTitle) {
  ok(`FORMMSG reports its parameters without running`);
} else bad(`expected needs_input with fields, got ${probe.status}`);

console.log("\n2. An unknown input key is refused, not swallowed");
const wrong = await programs.run("FORMMSG", "P", { NoSuchParam: "X" });
console.log(`   status=${wrong.status} unmatchedInputs=${JSON.stringify(wrong.unmatchedInputs)}`);
if (wrong.status === "unmatched_inputs" && wrong.unmatchedInputs?.includes("NoSuchParam")) {
  ok("the run was refused and the offending key is named");
} else {
  bad(`expected status=unmatched_inputs naming NoSuchParam, got status=${wrong.status}`);
}
if (wrong.messages.some((m) => m.includes("Nothing was executed"))) {
  ok("the reply states plainly that nothing ran");
} else bad("the reply does not say whether the program ran");

console.log("\n3. A typo alongside a VALID key is still refused");
// The dangerous shape: one key lands, one does not. Accepting the good one and
// dropping the bad one runs a partly-configured program.
if (realTitle) {
  const mixed = await programs.run("FORMMSG", "P", { [realTitle]: "ORDERS", Typoo: "1" });
  console.log(`   status=${mixed.status} unmatchedInputs=${JSON.stringify(mixed.unmatchedInputs)}`);
  if (mixed.status === "unmatched_inputs" && mixed.unmatchedInputs?.includes("Typoo")) {
    ok("a partly-valid input set does not run either");
  } else bad(`expected refusal, got ${mixed.status}`);
} else {
  console.log("   (skipped — no parameter title discovered)");
}

console.log("\n4. The correct key still runs");
if (realTitle) {
  const good = await programs.run("FORMMSG", "P", { [realTitle]: "ORDERS" });
  console.log(`   status=${good.status} steps=${good.steps}`);
  if (good.status !== "unmatched_inputs") {
    ok(`a correctly-keyed run is not blocked (status=${good.status})`);
  } else bad(`a valid key was rejected: ${JSON.stringify(good.unmatchedInputs)}`);
} else {
  console.log("   (skipped — no parameter title discovered)");
}

console.log(failures === 0 ? "\nAll run_program input checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
