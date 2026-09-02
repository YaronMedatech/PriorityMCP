// SALECREDITINVOICES was reported as "not exposed to the API". The user says it is
// a CHILD of SALES. If so, the 404 meant "not a top-level entity set", which is a
// different fact with different advice -- reach it through its parent.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";

const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
await dict.ready();

for (const name of ["SALES", "SALECREDITINVOICES"]) {
  const e = dict.get(name);
  console.log(
    `${name.padEnd(20)} title='${e?.title ?? "?"}' table=${e?.table ?? "?"} ` +
      `module='${e?.module ?? "?"}' published=${String(e?.published)}`,
  );
}

console.log("\n--- GetMetadataFor('SALES'): navigation properties ---");
try {
  const meta = await client.metadataFor("SALES");
  const sales = meta.get("SALES");
  if (!sales) {
    console.log("  SALES not present in its own metadata document");
  } else {
    console.log(`  SALES = '${sales.title}', ${sales.columns.size} columns, ${sales.navs.size} navs`);
    const navs = [...sales.navs.values()];
    const hit = navs.filter((n) => /SALECREDIT/i.test(n.name) || /SALECREDIT/i.test(n.target));
    console.log(`\n  navs mentioning SALECREDIT: ${hit.length}`);
    for (const n of hit) console.log(`    ${n.name}  ->  ${n.target}   '${n.title}'`);

    console.log(`\n  first 15 of ${navs.length} navs:`);
    for (const n of navs.slice(0, 15)) {
      console.log(`    ${n.name.padEnd(34)} -> ${String(n.target).padEnd(22)} '${n.title ?? ""}'`);
    }

    // If the child type is described in the same document, its columns are
    // available even though it has no entity set of its own.
    const child = meta.get("SALECREDITINVOICES");
    if (child) {
      console.log(
        `\n  SALECREDITINVOICES IS described here: '${child.title}', ` +
          `${child.columns.size} columns, keys=${child.keys.join(",")}`,
      );
      console.log(
        `    e.g. ${[...child.columns.values()].slice(0, 6).map((c) => `${c.name}='${c.title}'`).join(", ")}`,
      );
    } else {
      console.log("\n  SALECREDITINVOICES not described in SALES' metadata document");
    }
  }
} catch (err) {
  console.log(`  FAILED: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
}

console.log("\n--- can SALES itself be read? ---");
try {
  const rows = await client.query("SALES", { top: 2 });
  console.log(`  SALES readable: ${rows.length} row(s); keys: ${Object.keys(rows[0] ?? {}).slice(0, 10).join(", ")}`);
} catch (err) {
  console.log(`  SALES blocked: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
}

process.exit(0);
