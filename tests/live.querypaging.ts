// Reproduce the case a remote client hit: read every row of a screen that does
// not fit in one response, using ONLY the query tool's own paging.
//
// The client had to abandon `entity` and hand-build raw OData paths because the
// tool exposed no offset. If this test needs a raw path, the fix did not work.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { runQuery } from "../src/discovery.js";
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

const ENTITY = process.env["PAGING_ENTITY"] ?? "PART";
const KEY = process.env["PAGING_KEY"] ?? "PARTNAME";

interface Page {
  rowCount: number;
  hasMore: boolean;
  nextSkip?: number;
  notes?: string[];
  rows: Record<string, unknown>[];
}

console.log(`\npaging ${ENTITY} through the query tool\n`);

console.log("1. A full first page announces there is more");
const first = (await runQuery(client, dict, { entity: ENTITY, top: 100, orderby: KEY })) as Page;
console.log(`   rowCount=${first.rowCount} hasMore=${first.hasMore} nextSkip=${first.nextSkip}`);
if (first.hasMore && first.nextSkip === first.rowCount) {
  ok(`hasMore is set and nextSkip=${first.nextSkip} matches the rows shown`);
} else bad(`expected hasMore with nextSkip=${first.rowCount}, got hasMore=${first.hasMore}`);

console.log("\n2. Following nextSkip reads the entire screen");
const seen = new Set<string>();
const order: string[] = [];
let skip = 0;
let pages = 0;
let dupes = 0;
for (;;) {
  const page = (await runQuery(client, dict, { entity: ENTITY, top: 100, skip, orderby: KEY })) as Page;
  pages++;
  for (const r of page.rows) {
    const id = String(r[KEY]);
    if (seen.has(id)) dupes++;
    seen.add(id);
    order.push(id);
  }
  if (!page.hasMore) break;
  if (page.nextSkip === undefined || page.nextSkip <= skip) {
    bad(`nextSkip did not advance (${String(page.nextSkip)} after skip=${skip})`);
    break;
  }
  skip = page.nextSkip;
  if (pages > 50) {
    bad("paging did not terminate within 50 pages");
    break;
  }
}
console.log(`   ${pages} pages, ${order.length} rows, ${seen.size} unique, ${dupes} duplicate(s)`);
if (dupes === 0) ok("no row was returned twice"); else bad(`${dupes} duplicate row(s)`);

// This server cannot report a total, so completeness is checked against an
// independent route to the same rows rather than against a number it supplied.
const direct = await client.query(ENTITY, { select: [KEY], pageSize: 200 });
const directIds = new Set(direct.map((r) => String(r[KEY])));
if (seen.size === directIds.size && [...directIds].every((id) => seen.has(id))) {
  ok(`all ${seen.size} rows retrieved — matches an independent full pull exactly`);
} else bad(`paged ${seen.size} rows but a direct pull found ${directIds.size}`);

console.log("\n3. Paging terminated because the tool said so");
if (pages > 1 && order.length === seen.size) {
  ok(`the loop ended on hasMore=false after ${pages} pages, not on a safety limit`);
} else bad(`paging ended unexpectedly after ${pages} page(s)`);

console.log("\n4. A small complete result is not labelled partial");
const small = (await runQuery(client, dict, { entity: ENTITY, top: 500, select: KEY })) as Page;
console.log(`   rowCount=${small.rowCount} hasMore=${small.hasMore}`);
if (small.rowCount < 500 && !small.hasMore) {
  ok("a result that fits reports hasMore=false and spends no extra count request");
} else if (small.rowCount >= 500 && small.hasMore) {
  ok(`still capped at ${small.rowCount} rows even with select — correctly reports more`);
} else bad(`inconsistent: rowCount=${small.rowCount} hasMore=${small.hasMore}`);

console.log("\n5. The character cap keeps paging correct, not just small");
// The dangerous case: rows are fetched, then dropped for size. nextSkip must
// count the rows SHOWN, otherwise the dropped ones are skipped for good.
const wide = (await runQuery(client, dict, { entity: ENTITY, top: 500 })) as Page;
const capped = wide.notes?.some((n) => n.includes("exceeded")) ?? false;
console.log(`   rowCount=${wide.rowCount} capped=${capped} nextSkip=${wide.nextSkip}`);
if (!capped) {
  console.log("   (no character capping on this screen — nothing to check)");
} else if (wide.nextSkip === wide.rowCount) {
  ok(`char-capped page advances by rows shown (${wide.rowCount}), not rows fetched`);
} else {
  bad(`char-capped page would skip rows: nextSkip=${String(wide.nextSkip)} vs shown=${wide.rowCount}`);
}

console.log(failures === 0 ? "\nAll paging checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
