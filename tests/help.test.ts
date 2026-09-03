// Offline checks for the help paths and the failure wording. No Priority needed.
//
// The paths matter because each KIND of entity keeps its help under its own
// generator screen, and reading the wrong one is not an empty answer but a
// misleading one: every kind used to be read through EXEC, which answers 403 on
// the reference installation, so the server reported "not permitted to read
// help" for every screen while EFORM returned the text for the same screen.
import { columnHelpPath, entityHelpPath, explainHelpFailure, HELP_TYPES } from "../src/help.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const eq = (label: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("\n1. Paths -- one generator screen per kind, all keyed (ENAME, TYPE)");
eq("screen -> EFORM/FORMHELP", entityHelpPath("AINVOICES", "F"), "EFORM(ENAME='AINVOICES',TYPE='F')/FORMHELP_SUBFORM");
eq("report -> EREP/REPHELP", entityHelpPath("FORMTRIGREP", "R"), "EREP(ENAME='FORMTRIGREP',TYPE='R')/REPHELP_SUBFORM");
eq("procedure -> EPROG/PROGHELP", entityHelpPath("BUDREPDET", "P"), "EPROG(ENAME='BUDREPDET',TYPE='P')/PROGHELP_SUBFORM");
eq("menu -> EMENU/MENUHELP", entityHelpPath("MENU", "M"), "EMENU(ENAME='MENU',TYPE='M')/MENUHELP_SUBFORM");
// EINTER exists but carries no help sub-form, so there is nothing to read on any
// installation. Returning null says that, rather than building a path that 404s.
eq("interface has no help route at all", entityHelpPath("SOMEIFACE", "I"), null);
eq("the kinds with a route are exactly F, R, P, M", HELP_TYPES, ["F", "R", "P", "M"]);
eq(
  "column help goes EFORM -> FCLMN(NAME) -> FCLMNHELP",
  columnHelpPath("AINVOICES", "CUSTNAME"),
  "EFORM(ENAME='AINVOICES',TYPE='F')/FCLMN_SUBFORM(NAME='CUSTNAME')/FCLMNHELP_SUBFORM",
);
eq(
  "a quote in a name is doubled, not dropped",
  entityHelpPath("O'BRIEN", "F"),
  "EFORM(ENAME='O''BRIEN',TYPE='F')/FORMHELP_SUBFORM",
);

console.log("\n2. Failure wording");
const forbidden = explainHelpFailure(
  new Error("Priority accepted the credentials but refused access to EFORM(ENAME='X',TYPE='F')/FORMHELP_SUBFORM (HTTP 403)."),
  "the help for screen X",
);
if (forbidden.available === false && forbidden.permission === true && /operator can grant/.test(forbidden.reason)) {
  ok("403 is a permission refusal, and names who can fix it");
} else bad(`403 wording: ${JSON.stringify(forbidden)}`);
if (forbidden.available === false && /Do not conclude that no help is recorded/.test(forbidden.reason)) {
  ok("403 tells the model NOT to report absent help");
} else bad("403 wording does not guard against the wrong conclusion");

// The inversion measured on these paths, and the reason `known` exists: an entity
// that EXISTS but has no help row answers 404, while a name that does not exist
// at all answers 200 with zero rows. The obvious reading of each is wrong.
const noHelp = explainHelpFailure(new Error("GET ... -> HTTP 404: not found"), "the help for report PARTFAMILY", true);
if (noHelp.available === false && !("permission" in noHelp) && /no help recorded/.test(noHelp.reason) && /not a failure/.test(noHelp.reason)) {
  ok("404 for a KNOWN entity reads as 'no help recorded' -- an answer, not an error");
} else bad(`404 known: ${JSON.stringify(noHelp)}`);
const noEntity = explainHelpFailure(new Error("GET ... -> HTTP 404: not found"), "the help for report NOPE", false);
if (noEntity.available === false && /no such entity/.test(noEntity.reason) && /letter case/.test(noEntity.reason)) {
  ok("404 for an UNKNOWN name says fix the name or the type");
} else bad(`404 unknown: ${JSON.stringify(noEntity)}`);

const other = explainHelpFailure(new Error("socket hang up\nsecond line"), "the help for screen X");
if (other.available === false && other.reason.includes("socket hang up") && !other.reason.includes("second line")) {
  ok("any other error is passed through, first line only");
} else bad(`other wording: ${JSON.stringify(other)}`);

console.log(failures === 0 ? "\nAll help checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
