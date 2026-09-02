// Pull everything from UNIT in the demo company, the way the tools would.
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const { CompanyContext } = await import("../src/companies.js");
const { describeScreen } = await import("../src/discovery.js");

const COMPANY = process.env["UNIT_COMPANY"] ?? "demo";
const SCREEN = process.env["UNIT_SCREEN"] ?? "UNIT";

const ctx = new CompanyContext(COMPANY);
await ctx.dict.ready();

console.log(`\ncompany: ${ctx.company}  (${(await ctx.currentName()) ?? "?"})`);
console.log(`url:     ${ctx.client.baseUrl}\n`);

const entry = ctx.dict.get(SCREEN);
console.log(`1. What is ${SCREEN}?`);
if (!entry) {
  console.log(`   NOT in the dictionary. Closest matches:`);
  for (const m of ctx.dict.search(SCREEN, { limit: 8 }).matches) {
    console.log(`     ${m.screen.padEnd(20)} ${m.access.padEnd(11)} ${m.title ?? "?"}`);
  }
  process.exit(1);
}
console.log(`   title=${entry.title}  table=${entry.table}  module=${entry.module}`);
console.log(`   access=${entry.access}${entry.parents ? `  parents=${entry.parents.join(", ")}` : ""}`);

console.log(`\n2. Columns`);
const desc = (await describeScreen(ctx.client, ctx.dict, {
  screen: SCREEN,
  includeHelp: false,
  includeColumnSources: false,
})) as { columns?: { name: string; title: string | null; type: string }[]; keys?: string[]; error?: string };
if (desc.error) {
  console.log(`   ${desc.error.split("\n")[0]}`);
} else {
  console.log(`   keys: ${JSON.stringify(desc.keys)}`);
  for (const c of desc.columns ?? []) {
    console.log(`     ${c.name.padEnd(18)} ${String(c.type).replace("Edm.", "").padEnd(16)} ${c.title ?? ""}`);
  }
}

console.log(`\n3. Every row (paged until a short page arrives)`);
const started = Date.now();
try {
  // pageSize rather than top: top caps the TOTAL on this server, so it would
  // silently truncate. Paging is the only way to be sure this is everything.
  const rows = await ctx.client.query(SCREEN, { pageSize: 500 });
  console.log(`   ${rows.length} row(s) in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  const cols = rows.length ? Object.keys(rows[0]!).filter((k) => !k.startsWith("@")) : [];
  console.log(`   columns returned: ${cols.join(", ")}\n`);

  for (const r of rows) {
    const line = cols.map((c) => `${c}=${r[c] === null ? "" : String(r[c])}`).join("  ");
    console.log(`     ${line}`);
  }

  // Written out too: a long table is easier to read in a file than in a terminal.
  const fs = await import("node:fs");
  fs.writeFileSync(`unit-${ctx.company}.json`, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n   also written to unit-${ctx.company}.json`);
} catch (err) {
  console.log(`   FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
