// Run FORMTREE and keep the output OUT of the context: convert the HTML to text,
// write the full result to disk, and print only structure and a small sample.
import fs from "node:fs";
import path from "node:path";
import { ProgramRunner } from "../src/programs.js";

const form = process.argv[2] ?? "SALES";
const type = (process.argv[3] ?? "P") as "P" | "R";
const runner = new ProgramRunner();

if (runner.configError) {
  console.log(runner.configError);
  process.exit(1);
}

console.log(`\n1. Probe FORMTREE (type=${type}) -- what does it want?`);
const probe = await runner.probe("FORMTREE", type);
console.log(`   status=${probe.status} steps=${probe.steps}`);
if (probe.messages.length) console.log(`   messages: ${probe.messages.slice(0, 3).join(" | ")}`);
if (probe.inputFields?.length) {
  for (const f of probe.inputFields) {
    console.log(`   field ${f.field}: '${f.title}'${f.mandatory ? " (mandatory)" : ""}`);
  }
} else {
  console.log("   (no input fields reported)");
}

if (probe.status === "not_found") {
  console.log(`\nFORMTREE does not exist as type='${type}'. Try the other type.`);
  process.exit(1);
}

// Feed the form name into whatever the first parameter turned out to be, rather
// than assuming a title.
const first = probe.inputFields?.[0];
const inputs: Record<string, string> = {};
if (first) inputs[first.title] = form;

console.log(`\n2. Run FORMTREE for '${form}'`);
const res = await runner.run("FORMTREE", type, inputs);
console.log(`   status=${res.status} steps=${res.steps} truncated=${String(res.truncated ?? false)}`);
if (res.messages.length) console.log(`   messages: ${res.messages.slice(0, 3).join(" | ")}`);

const text = res.output ?? "";
if (!text) {
  console.log("   no output produced");
  process.exit(1);
}

const outFile = path.join(process.cwd(), `formtree-${form}.txt`);
fs.writeFileSync(outFile, text, "utf8");

const lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
console.log(`\n3. Converted HTML -> text: ${text.length} chars, ${lines.length} non-empty lines`);
console.log(`   full output written to ${outFile}`);
console.log(`\n--- first 40 lines ---`);
for (const l of lines.slice(0, 40)) console.log(`   ${l}`);
console.log(`--- (${Math.max(0, lines.length - 40)} more lines in the file) ---`);

process.exit(0);
