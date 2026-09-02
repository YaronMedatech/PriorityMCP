// Validate PRIORITY_ENVIRONMENTS against the server.
//
// A name in that list is an allowlist entry, and a wrong one fails much later as
// a confusing 400 on whatever the user happened to ask. Priority distinguishes
// two failures that look alike in a log, and the difference decides who fixes it:
//
//   "שם החברה שנשלח לא תקין"        -> the COMPANY does not exist. Fix the list.
//   "לא ניתן להפעיל API למסך זה"     -> the company is fine, the SCREEN is closed
//                                       to the API (or this token lacks rights).
//
// Run after editing the list, or when a company answers nothing.
import { loadEnvFile, listEnvironments } from "../src/config.js";

loadEnvFile();
const { CompanyContext, readEnvironments } = await import("../src/companies.js");

const companies = listEnvironments();
if (companies.length === 0) {
  console.log("\nNo companies configured (PRIORITY_ENVIRONMENTS is empty).\n");
  process.exit(0);
}

const BAD_COMPANY = /שם החברה/;
const CLOSED_SCREEN = /לא ניתן להפעיל API/;
/** A screen every installation has, used only to prove the company resolves. */
const PROBE_SCREEN = process.env["COMPANY_PROBE_SCREEN"] ?? "CUSTOMERS";

const ctx = new CompanyContext(companies[0]!);
const invalid: string[] = [];
let closed = 0;

console.log(`\nchecking ${companies.length} configured companies against the server\n`);

for (const c of companies) {
  ctx.switchTo(c);
  let verdict: string;
  try {
    await ctx.client.query(PROBE_SCREEN, { top: 1 });
    verdict = "OK — company valid and the probe screen is readable";
  } catch (err) {
    const m = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    if (BAD_COMPANY.test(m)) {
      verdict = "NOT A REAL COMPANY — remove it from PRIORITY_ENVIRONMENTS";
      invalid.push(c);
    } else if (CLOSED_SCREEN.test(m)) {
      verdict = `company OK, but ${PROBE_SCREEN} is closed to the API`;
      closed++;
    } else {
      verdict = m.slice(0, 110);
    }
  }
  console.log(`  ${c.padEnd(12)} ${verdict}`);
}

// ENVIRONMENT lists EVERY environment on the installation, so it is read once
// and matched by code — not once per company.
console.log("\nENVIRONMENT screen (the source of the display names):");
const { rows, note } = await readEnvironments(ctx.client);
let named = 0;
if (note) console.log(`  ${note}`);
for (const c of companies.filter((x) => !invalid.includes(x))) {
  const row = rows.find((r) => r.code === c);
  if (row?.title) {
    named++;
    console.log(`  ${c.padEnd(12)} "${row.title}"${row.active ? "" : "   (INACTIVE in Priority)"}`);
  } else {
    console.log(`  ${c.padEnd(12)} not listed in ENVIRONMENT`);
  }
}

// Environments Priority has that this server does not offer. An operator who
// added a company and forgot PRIORITY_ENVIRONMENTS sees it here.
const extra = rows.filter((r) => r.active && !companies.includes(r.code));
if (extra.length) {
  console.log(`\n${extra.length} active environment(s) NOT offered by this server:`);
  for (const r of extra) console.log(`  ${r.code.padEnd(12)} "${r.title ?? "?"}"`);
  console.log("Add any you want reachable to PRIORITY_ENVIRONMENTS.");
}

console.log("");
if (invalid.length) {
  console.log(`${invalid.length} name(s) are not real companies: ${invalid.join(", ")}`);
  console.log(
    "Remove them from PRIORITY_ENVIRONMENTS — the allowlist should only hold companies that exist.",
  );
}
if (named === 0) {
  console.log(
    "No company names could be read. list_companies will fall back to the codes, which " +
      "still work but mean nothing to an end user. Opening the ENVIRONMENT screen for the " +
      "API in Priority makes the names appear — no code change needed.",
  );
}
if (closed) {
  console.log(
    `${closed} compan${closed === 1 ? "y" : "ies"} could not read ${PROBE_SCREEN}. That is a ` +
      `Priority-side setting (screen not opened for the API, or the token lacks rights), ` +
      `not a problem with the company list.`,
  );
}
process.exit(invalid.length ? 1 : 0);
