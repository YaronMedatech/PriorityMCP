// Skills against the live installation, in every configured company.
//
// On the reference installation AIWORKFLOWS answers 400 everywhere, so the
// expected outcome today is available:false with a reason that names the fix.
// The day an administrator opens the screen, this same script prints every
// skill with its text -- it is the "list all skills" the operator asked for,
// waiting on a permission.
import { loadEnvFile, listEnvironments } from "../src/config.js";

loadEnvFile();
const { CompanyContext } = await import("../src/companies.js");
const { fetchSkill, listSkills } = await import("../src/skills.js");

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

for (const company of listEnvironments()) {
  console.log(`\n${company}`);
  const ctx = new CompanyContext(company);
  const listed = await listSkills(ctx.client);
  if (!listed.available) {
    if (listed.permission && /תחזוקת מערכת|opened for the API|permitted/.test(listed.reason)) {
      console.log(`  SKIP closed to this API user — the reason names the fix:\n       ${listed.reason.slice(0, 160)}…`);
    } else bad(`unexpected failure shape: ${listed.reason}`);
    continue;
  }
  ok(`${listed.count} skill(s); key columns: ${listed.keyColumns.join(", ")}`);
  for (const s of listed.skills) {
    const full = await fetchSkill(ctx.client, s.key);
    console.log(`  - ${JSON.stringify(s.key)} ${s.title ?? ""}`);
    if (full.available) console.log(`      ${full.lines} line(s): ${full.text.slice(0, 200).replace(/\n/g, " / ")}${full.text.length > 200 ? "…" : ""}`);
    else console.log(`      text: ${full.reason}`);
  }
}

console.log(failures === 0 ? "\nSkills check finished (SKIP = Priority permission, not a defect).\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
