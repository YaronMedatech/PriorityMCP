// Reported bug: describe_screen with `subform` reported the PARENT's table.
//
// The general rule this pins down: when a sub-form is described, EVERY fact in
// the reply must be about the sub-form. Mixing parent-level and target-level
// facts produced a reply that was internally inconsistent and gave no sign of it
// — describing TRANSORDER_D through DOCUMENTS_D said table=DOCUMENTS, while
// describing the same screen directly said TRANSORDER.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen } from "../src/discovery.js";
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

const PARENT = process.env["SUBFORM_PARENT"] ?? "DOCUMENTS_D";
const CHILD = process.env["SUBFORM_CHILD"] ?? "TRANSORDER_D";

type Reply = Record<string, unknown>;

const meta = await client.metadataFor(PARENT);
const nav = [...(meta.get(PARENT)?.navs.values() ?? [])].find((n) => n.target === CHILD);
if (!nav) {
  console.log(`\n${CHILD} is not a sub-form of ${PARENT} on this server — cannot run.\n`);
  process.exit(0);
}

console.log(`\ndescribing ${CHILD} two ways: directly, and via ${PARENT}/${nav.name}\n`);

const direct = (await describeScreen(client, dict, { screen: CHILD })) as Reply;
const viaSub = (await describeScreen(client, dict, { screen: PARENT, subform: nav.name })) as Reply;

console.log("1. The two routes agree on the facts about the sub-form");
for (const field of ["table", "module", "published", "access"] as const) {
  const a = direct[field];
  const b = viaSub[field];
  console.log(`   ${field.padEnd(10)} direct=${JSON.stringify(a)}  viaSubform=${JSON.stringify(b)}`);
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${field} matches`);
  else bad(`${field} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

console.log("\n2. The table is the sub-form's own, taken from the dictionary");
const expectedTable = dict.get(CHILD)?.table;
const parentTable = dict.get(PARENT)?.table;
console.log(`   expected ${expectedTable}, parent's is ${parentTable}`);
if (viaSub["table"] === expectedTable) ok(`table = ${String(expectedTable)}`);
else bad(`table = ${String(viaSub["table"])}, expected ${String(expectedTable)}`);
if (viaSub["table"] !== parentTable || expectedTable === parentTable) {
  ok("the parent's table is not leaking through");
} else bad("still reporting the parent's table");

console.log("\n3. Help is the sub-form's own, not the parent's");
const parentHelp = (await describeScreen(client, dict, { screen: PARENT })) as Reply;
const hSub = String(viaSub["help"] ?? "");
const hParent = String(parentHelp["help"] ?? "");
const hDirect = String(direct["help"] ?? "");
console.log(`   viaSubform=${hSub.length} chars, direct=${hDirect.length}, parent=${hParent.length}`);
if (hSub && hSub === hDirect) ok("help matches what the sub-form returns on its own");
else if (!hSub && !hDirect) ok("neither route has help for this sub-form — consistent");
else bad("help differs between the two routes");
if (hSub && hParent && hSub === hParent && hDirect !== hParent) {
  bad("the parent's help is being returned for the sub-form");
} else ok("the parent's help is not substituted");

console.log("\n4. The columns are still the sub-form's");
const dCols = (direct["columns"] as { name: string }[] | undefined)?.map((c) => c.name) ?? [];
const sCols = (viaSub["columns"] as { name: string }[] | undefined)?.map((c) => c.name) ?? [];
console.log(`   direct=${dCols.length} columns, viaSubform=${sCols.length}`);
if (dCols.length > 0 && JSON.stringify(dCols) === JSON.stringify(sCols)) {
  ok("identical column sets — the fix did not disturb what already worked");
} else bad(`column sets differ (${dCols.length} vs ${sCols.length})`);

console.log("\n5. The reply still says which screen was asked for");
if (viaSub["screen"] === PARENT && viaSub["describing"] === CHILD) {
  ok("'screen' names the parent asked for, 'describing' names the sub-form");
} else bad(`screen=${String(viaSub["screen"])} describing=${String(viaSub["describing"])}`);

console.log(failures === 0 ? "\nAll sub-form fact checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
