// Priority's help text, end to end: fetched by the keyed path, cleaned of HTML,
// and with {ENTITY.TYPE} cross-references resolved.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen } from "../src/discovery.js";
import { fetchEntityHelp, helpHtmlToText, parseHelpReferences } from "../src/help.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

await dict.ready();
const SCREEN = process.env["HELP_SCREEN"] ?? "AINVOICES";

// Help lives behind EXEC's FORMHELP sub-form, which an installation can refuse
// independently of EXEC itself (measured: EXEC reads fine, the sub-form answers
// 403). That is a Priority permission to grant, not a defect here, so the
// server-dependent checks are SKIPPED rather than failed — a suite that cries
// "broken" for a permission is a suite people learn to ignore.
const helpProbe = await fetchEntityHelp(client, dict, SCREEN, "F");
const helpAvailable = Boolean(helpProbe?.text);
if (!helpAvailable) {
  console.log(
    `\nHelp is not reachable on this installation, so the live checks are skipped.\n` +
      `EXEC/FORMHELP_SUBFORM must be permitted for this user; the pure-function\n` +
      `checks below still run.\n`,
  );
}

const help = helpAvailable ? helpProbe : null;

console.log("\n1. The keyed path returns help where $expand returns nothing");
if (!helpAvailable) {
  console.log("   SKIPPED — help is not permitted on this installation");
} else {
  const viaExpand = await client.query("EXEC", {
    top: 1,
    filter: `ENAME eq '${SCREEN}' and TYPE eq 'F'`,
    expand: "FORMHELP_SUBFORM",
  });
  const expandGot = Array.isArray(viaExpand[0]?.["FORMHELP_SUBFORM"])
    ? (viaExpand[0]!["FORMHELP_SUBFORM"] as unknown[]).length
    : 0;
  console.log(`   $expand -> ${expandGot} row(s); keyed path -> ${help!.text.length} chars`);
  ok("help retrieved through the keyed path");
  if (expandGot === 0) ok("confirms the quirk: $expand is accepted and silently empty");
}

console.log("\n2. HTML is gone, Hebrew survives");
if (help) {
  const t = help.text;
  if (!/[<>]/.test(t)) ok("no angle brackets remain");
  else bad(`markup survived: ${t.slice(t.indexOf("<"), t.indexOf("<") + 60)}`);
  if (!/margin:0cm|font-family/i.test(t)) ok("the inline <style> block was removed, not flattened into text");
  else bad("CSS leaked into the text");
  if (/[֐-׿]/.test(t)) ok("Hebrew text is intact");
  else bad("no Hebrew in the result");
  console.log(`\n   --- help for ${SCREEN} ---\n${t.split("\n").map((l) => `   ${l}`).join("\n")}\n   --- end ---`);
}

console.log("\n3. Cross-references are parsed and resolved");
if (help) {
  console.log(`   ${help.references.length} reference(s)`);
  for (const r of help.references) {
    console.log(`     {${r.name}.${r.type}} -> ${r.kind}, title=${JSON.stringify(r.title)}`);
  }
  if (help.references.length > 0) {
    ok(`${help.references.length} reference(s) extracted`);
    if (!/\{[A-Za-z_]+\.[A-Z]\}/.test(help.text)) ok("no raw {X.T} tokens left in the readable text");
    else bad("a raw reference token survived in the text");
    const resolved = help.references.filter((r) => r.type === "F" && r.title);
    if (resolved.length) ok(`${resolved.length} screen reference(s) resolved to a Hebrew title`);
    else console.log("   (no screen references resolved — none of type F, or unknown names)");
  } else console.log("   (this screen's help contains no cross-references)");
}

console.log("\n4. Pure-function checks");
const sample = `<style>p{margin:0cm}</style><!-- קוד:X --><p dir=rtl>ראה {AINVOICEITEMS.F} וגם {FORMTREE.P}.<br>שורה שנייה</p>`;
const cleaned = helpHtmlToText(sample);
console.log(`   cleaned: ${JSON.stringify(cleaned)}`);
if (!cleaned.includes("margin") && !cleaned.includes("קוד:X")) ok("style block and HTML comment both dropped");
else bad(`leftover: ${cleaned}`);
if (cleaned.includes("\n")) ok("<br> became a line break");
else bad("line structure lost");
const refs = parseHelpReferences(sample);
if (refs.length === 2 && refs[0]?.name === "AINVOICEITEMS" && refs[1]?.type === "P") {
  ok("both references parsed with their type letters");
} else bad(`parsed ${JSON.stringify(refs)}`);

console.log("\n5. describe_screen includes help by default");
if (!helpAvailable) {
  console.log("   SKIPPED");
} else {
  const desc = (await describeScreen(client, dict, { screen: SCREEN })) as { help?: string | null };
  if (typeof desc.help === "string" && desc.help.length > 0) ok("help present without asking for it");
  else bad(`describe_screen help = ${JSON.stringify(desc.help)?.slice(0, 80)}`);
}

const off = (await describeScreen(client, dict, { screen: SCREEN, includeHelp: false })) as {
  help?: unknown;
};
if (off.help === undefined) ok("includeHelp:false omits it entirely");
else bad("includeHelp:false still returned help");

console.log("\n6. A deep walk carries help for child screens too");
const deep = (await describeScreen(client, dict, { screen: SCREEN, depth: 1, columns: "IVDATE" })) as {
  tree: { screen: string; help?: string; children?: { screen: string; help?: string }[] };
  budget: { helpFetched?: number; helpOmitted?: number };
};
const kidsWithHelp = (deep.tree.children ?? []).filter((c) => c.help);
console.log(`   helpFetched=${deep.budget.helpFetched} helpOmitted=${deep.budget.helpOmitted}`);
console.log(`   ${kidsWithHelp.length} child screen(s) carry help`);
for (const k of kidsWithHelp.slice(0, 3)) {
  console.log(`     ${k.screen}: ${k.help?.slice(0, 80).replace(/\n/g, " ")}…`);
}
if (!helpAvailable) {
  console.log("   SKIPPED");
} else if ((deep.budget.helpFetched ?? 0) > 1) {
  ok("help fetched for the root and for children");
} else bad(`only ${deep.budget.helpFetched} help record(s) in the tree`);

console.log(failures === 0 ? "\nAll screen-help checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
