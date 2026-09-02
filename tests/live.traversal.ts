// Reproduce the third-party finding: does `path` escape the configured company?
//
// The report claims ../../tabula.ini,1/demo/CUSTOMERS reaches a DIFFERENT company
// on the same server. Confirm it against live data before changing anything, and
// keep this file afterwards as the regression guard.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { runQuery } from "../src/discovery.js";
import { loadConfig, loadEnvFile } from "../src/config.js";

loadEnvFile();
const cfg = loadConfig();
const client = new PriorityODataClient();

console.log(`\nconfigured environment: ${cfg.odataUrl}\n`);

const ATTACKS = [
  ["plain traversal", "../../tabula.ini,1/demo/CUSTOMERS?$top=1&$select=CUSTNAME,CUSTDES"],
  ["encoded traversal", "..%2F..%2Ftabula.ini%2C1%2Fdemo%2FCUSTOMERS?$top=1&$select=CUSTNAME,CUSTDES"],
  ["double-encoded", "..%252F..%252Ftabula.ini%252C1%252Fdemo%252FCUSTOMERS?$top=1"],
  ["backslash", "..\\..\\tabula.ini,1/demo/CUSTOMERS?$top=1"],
  ["absolute url", "https://example.invalid/anything"],
  ["leading slash", "/tabula.ini,1/demo/CUSTOMERS?$top=1"],
  ["metadata", "$metadata"],
  ["count path", "CUSTOMERS/$count"],
] as const;

// Baseline: the same customer, read the legitimate way.
let baseline = "(unavailable)";
try {
  const rows = await client.query("CUSTOMERS", { top: 1, select: ["CUSTNAME", "CUSTDES"] });
  baseline = JSON.stringify(rows[0] ?? {});
} catch (err) {
  baseline = `error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
}
console.log(`baseline CUSTOMERS row in the configured company:\n  ${baseline}\n`);

let reached = 0;

console.log("-- transport layer (client.queryRawPath) --");
for (const [label, path] of ATTACKS) {
  process.stdout.write(`${label.padEnd(18)} `);
  try {
    const rows = await client.queryRawPath(path);
    const first = rows[0] ? JSON.stringify(rows[0]).slice(0, 100) : "(no rows)";
    console.log(`REACHED  ${rows.length} row(s)  ${first}`);
    reached++;
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    console.log(`blocked  ${msg.slice(0, 100)}`);
  }
}

// The tool layer is the primary defence -- it has the dictionary and so can
// allowlist rather than filter. Check it independently of the transport guard.
console.log("\n-- tool layer (runQuery) --");
const dict = new PriorityDictionary(client);
await dict.ready();
for (const [label, path] of ATTACKS) {
  process.stdout.write(`${label.padEnd(18)} `);
  try {
    const res = (await runQuery(client, dict, { path })) as { rowCount: number };
    console.log(`REACHED  ${res.rowCount} row(s)`);
    reached++;
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    console.log(`blocked  ${msg.slice(0, 100)}`);
  }
}

// A fix that also breaks the legitimate use of `path` is not a fix: sub-forms and
// keyed rows are reachable no other way.
console.log("\n-- legitimate paths must still work --");
// A keyed row and a sub-form are the shapes most at risk from an allowlist, and
// they are reachable no other way -- so they are discovered from live data rather
// than hardcoded, and checked every run.
const legit = ["CUSTOMERS?$top=1&$select=CUSTNAME,CUSTDES", "PART?$top=2&$select=PARTNAME"];
try {
  const head = await client.query("AINVOICES", { top: 1, select: ["IVNUM", "DEBIT", "IVTYPE"] });
  const r = head[0];
  if (r) {
    const keyed = `AINVOICES(IVNUM='${String(r["IVNUM"])}',DEBIT='${String(r["DEBIT"])}',IVTYPE='${String(r["IVTYPE"])}')`;
    legit.push(keyed, `${keyed}/AINVOICEITEMS_SUBFORM?$top=3`);
  }
} catch {
  console.log("(could not sample an invoice for the keyed-path check)");
}

for (const good of legit) {
  process.stdout.write(`${good.slice(0, 40).padEnd(42)} `);
  try {
    const res = (await runQuery(client, dict, { path: good })) as { rowCount: number };
    console.log(`ok, ${res.rowCount} row(s)`);
  } catch (err) {
    console.log(`BROKEN: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    reached++;
  }
}

console.log(
  reached === 0
    ? "\nAll traversal attempts blocked and legitimate paths still work.\n"
    : `\n${reached} problem(s) — see above.\n`,
);
process.exit(reached === 0 ? 0 : 1);
