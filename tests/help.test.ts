// Offline checks for the help paths and the failure wording. No Priority needed.
//
// The paths matter because they are the ONLY routes that return anything on this
// server -- $expand on either help sub-form is accepted and comes back empty -- so
// a wrong quote or a wrong key name fails in a way that looks like "no help".
import { columnHelpPath, entityHelpPath, explainHelpFailure } from "../src/help.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const eq = (label: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\n1. Paths");
eq("screen help goes through EXEC with the type letter", entityHelpPath("AINVOICES", "F"), "EXEC(ENAME='AINVOICES',TYPE='F')/FORMHELP_SUBFORM");
eq("report help is the same route with TYPE='R'", entityHelpPath("FORMTRIGREP", "R"), "EXEC(ENAME='FORMTRIGREP',TYPE='R')/FORMHELP_SUBFORM");
eq(
  "column help goes EFORM -> FCLMN(NAME) -> FCLMNHELP, the key measured on the server",
  columnHelpPath("AINVOICES", "CUSTNAME"),
  "EFORM(ENAME='AINVOICES',TYPE='F')/FCLMN_SUBFORM(NAME='CUSTNAME')/FCLMNHELP_SUBFORM",
);
eq("a quote in a name is doubled, not dropped", entityHelpPath("O'BRIEN", "F"), "EXEC(ENAME='O''BRIEN',TYPE='F')/FORMHELP_SUBFORM");

console.log("\n2. Failure wording");
const forbidden = explainHelpFailure(
  new Error("Priority accepted the credentials but refused access to EXEC(ENAME='X',TYPE='F')/FORMHELP_SUBFORM (HTTP 403)."),
  "the help for screen X",
);
if (!forbidden.available && forbidden.permission && /exists/.test(forbidden.reason) && !/no help/i.test(forbidden.reason.split("Do not")[0] ?? "")) {
  ok("403 is reported as a permission refusal that says the help EXISTS");
} else bad(`403 wording: ${JSON.stringify(forbidden)}`);

const missing = explainHelpFailure(new Error("GET ... -> HTTP 404: not found"), "the help for report NOPE");
if (!missing.available && !("permission" in missing) && /404/.test(missing.reason)) ok("404 is reported as not found, without a permission claim");
else bad(`404 wording: ${JSON.stringify(missing)}`);

const other = explainHelpFailure(new Error("socket hang up\nsecond line"), "the help for screen X");
if (!other.available && other.reason.includes("socket hang up") && !other.reason.includes("second line")) {
  ok("any other error is passed through, first line only");
} else bad(`other wording: ${JSON.stringify(other)}`);

console.log(failures === 0 ? "\nAll help checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
