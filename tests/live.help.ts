// Help end to end: screen, report, procedure and column, against the live server.
//
// Two of these are expected to be REFUSED on the reference installation (FORMHELP
// is 403 for this API user) and one is expected to WORK (FCLMNHELP). The point of
// the suite is that both outcomes are reported truthfully: a refusal must say
// "permission", never "no help", and a permission refusal is a SKIP here, not a
// failure -- it is Priority's setting, not this code's.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen } from "../src/discovery.js";
import { fetchColumnHelp, fetchEntityHelpOutcome } from "../src/help.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
await dict.ready();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};
const skip = (m: string) => console.log(`  SKIP ${m}`);

console.log("\n1. Entity help: one of each kind, through its own generator screen");
// Measured 2026-09-03: these three carry help. FORMTRIGREP and FORMMSG do NOT,
// and their 404 is Priority saying "none recorded" rather than a fault -- so the
// suite names entities known to have text, and still treats "none recorded" for
// any single name as a skip, since an installation may document different ones.
for (const [name, type] of [
  ["AINVOICES", "F"],
  ["PARTFAMILY", "R"],
  ["BUDREPDET", "P"],
] as const) {
  const o = await fetchEntityHelpOutcome(client, dict, name, type);
  if (o.available) {
    ok(`${name}(${type}): ${o.text.length} chars, ${o.references.length} reference(s)`);
    if (/[<>]/.test(o.text)) bad(`${name}: markup survived`);
  } else if (o.permission) {
    skip(`${name}(${type}): refused by permission — reported as such: "${o.reason.slice(0, 70)}…"`);
    if (/no help/i.test(o.reason.split("Do not")[0] ?? "")) bad("a permission refusal was worded as missing help");
  } else if (/no help recorded/.test(o.reason)) {
    skip(`${name}(${type}): Priority records none — an answer, not a failure`);
  } else {
    bad(`${name}(${type}): ${o.reason}`);
  }
}

console.log("\n2. Column help through FCLMNHELP");
const col = await fetchColumnHelp(client, dict, "AINVOICES", "CUSTNAME");
if (col.available) {
  ok(`AINVOICES.CUSTNAME: ${col.text.length} chars`);
  console.log(`       ${col.text.slice(0, 160).replace(/\n/g, " / ")}…`);
  if (/[<>]|font-family|margin:/i.test(col.text)) bad("HTML or CSS survived in column help");
  else ok("HTML and the inline style block are gone");
} else if (col.permission) {
  skip(`column help refused by permission: ${col.reason.slice(0, 80)}`);
} else {
  bad(`column help: ${col.reason}`);
}

console.log("\n3. The wrong kind reads the wrong generator, and says so");
// AINVOICES is a screen. Asked for as a report it looks in EREP, where no such
// row exists -- which on these paths returns 200 with zero rows, not a 404.
const wrong = await fetchEntityHelpOutcome(client, dict, "AINVOICES", "R");
if (!wrong.available && /no entity of that name and type exists|no such entity/.test(wrong.reason)) {
  ok(`AINVOICES as a report: "${wrong.reason.slice(0, 80)}…"`);
} else bad(`wrong-kind wording: ${JSON.stringify(wrong).slice(0, 200)}`);
// An interface has no help sub-form anywhere, so this is answered without a request.
const noRoute = await fetchEntityHelpOutcome(client, dict, "SOMETHING", "I");
if (!noRoute.available && /nothing to read/.test(noRoute.reason)) {
  ok("an interface says Priority keeps no help for that kind at all");
} else bad(`interface wording: ${JSON.stringify(noRoute).slice(0, 160)}`);

console.log("\n4. describe_screen carries the reason, and column help on request");
const desc = (await describeScreen(client, dict, {
  screen: "AINVOICES",
  columns: "CUSTNAME",
  includeColumnSources: true,
  includeColumnHelp: true,
})) as {
  help?: string | null;
  helpNote?: string;
  columnHelpNote?: string;
  columns: { name: string; help?: string | null; hidden?: boolean; formReadOnly?: unknown; width?: number }[];
};
if (desc.help) ok("screen help present");
else if (desc.helpNote && /permission|403/i.test(desc.helpNote)) ok(`screen help refused and the note says so: "${desc.helpNote.slice(0, 60)}…"`);
else bad(`help=${JSON.stringify(desc.help)} note=${JSON.stringify(desc.helpNote)}`);

const custname = desc.columns.find((c) => c.name === "CUSTNAME");
if (custname?.help) ok(`CUSTNAME carries its own help (${custname.help.length} chars)`);
else if (desc.columnHelpNote) skip(`column help: ${desc.columnHelpNote.slice(0, 80)}`);
else bad(`CUSTNAME has no help and no note: ${JSON.stringify(custname).slice(0, 200)}`);
if (custname && ("width" in custname || "formReadOnly" in custname)) ok(`FCLMN flags passed through (width=${String(custname.width)}, formReadOnly=${String(custname.formReadOnly)})`);
else bad("no FCLMN flags on CUSTNAME");

console.log(failures === 0 ? "\nAll help checks passed (see SKIPs for Priority permissions).\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
