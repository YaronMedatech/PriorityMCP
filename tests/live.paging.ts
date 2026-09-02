// What does this server actually do with $skip, $count and ordering?
//
// A remote client hit the 500-row and 200KB ceilings on PART and had to hand-build
// raw OData paths to page around them. Before exposing paging through the query
// tool, measure the behaviour rather than assume OData semantics hold -- this
// server already answers 501 to `in` and contains().
import { PriorityODataClient } from "../src/odata.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();

const ENTITY = process.env["PAGING_ENTITY"] ?? "PART";
const KEY = process.env["PAGING_KEY"] ?? "PARTNAME";

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r[KEY]));

console.log(`\nmeasuring paging on ${ENTITY} (key ${KEY})\n`);

// 1. Does $skip work, and does it compose with $top?
console.log("1. $skip + $top");
const page1 = await client.query(ENTITY, { select: [KEY], top: 10, orderby: KEY });
const page2raw = await client.queryRawPath(
  `${ENTITY}?$select=${KEY}&$top=10&$skip=10&$orderby=${KEY}`,
);
const a = ids(page1);
const b = ids(page2raw);
console.log(`   page1: ${a.length} rows, first=${a[0]} last=${a[a.length - 1]}`);
console.log(`   page2: ${b.length} rows, first=${b[0]} last=${b[b.length - 1]}`);
const overlap = a.filter((x) => b.includes(x));
console.log(
  overlap.length === 0
    ? `   OK   $skip=10 returns a disjoint page`
    : `   BAD  ${overlap.length} row(s) repeated across pages: ${overlap.slice(0, 3).join(", ")}`,
);

// 2. Is $count supported? The client's doc comment says no -- re-verify, because
//    the operator has since opened every screen to the API.
console.log("\n2. $count=true");
// queryRawPath discards the envelope, so this measures ACCEPTANCE: if the server
// rejects $count outright there is no point adding envelope plumbing for it.
try {
  const rows = await client.queryRawPath(`${ENTITY}?$select=${KEY}&$top=1&$count=true`);
  console.log(`   OK   $count=true was accepted (returned ${rows.length} row) -- worth plumbing through`);
} catch (err) {
  const first = err instanceof Error ? err.message.split("\n")[0] : String(err);
  console.log(`   $count=true rejected: ${first}`);
  console.log("   -> no cheap way to learn a total up front; paging must run until a short page");
}

// 3. Is the ordering stable WITHOUT $orderby? Paging across separate tool calls
//    has no cross-call duplicate detection, so an unstable default order would
//    silently skip rows -- the failure mode that produces a plausible wrong total.
console.log("\n3. default ordering stability (no $orderby)");
const u1 = ids(await client.query(ENTITY, { select: [KEY], top: 20 }));
const u2 = ids(await client.query(ENTITY, { select: [KEY], top: 20 }));
console.log(
  JSON.stringify(u1) === JSON.stringify(u2)
    ? "   OK   two identical unordered requests returned the same 20 rows in the same order"
    : "   BAD  unordered requests disagree -- $orderby is REQUIRED for safe paging",
);

// 4. Is the ordering CONSISTENT between requests?
//
// Not "does it match a sort I can compute here" -- Priority collates Hebrew,
// Latin and digits server-side and JS .sort() compares UTF-16 code units, so
// disagreement proves nothing about the server. The property paging depends on is
// weaker and testable: the first N rows must be a prefix of the first N+k. If
// that holds, consecutive $skip windows tile the set exactly once.
console.log("\n4. ordering consistency (the property paging actually needs)");
for (const ob of [`${KEY} asc`, undefined]) {
  const label = ob ?? "(no $orderby)";
  const short = ids(await client.query(ENTITY, { select: [KEY], top: 10, ...(ob ? { orderby: ob } : {}) }));
  const long = ids(await client.query(ENTITY, { select: [KEY], top: 30, ...(ob ? { orderby: ob } : {}) }));
  const isPrefix = short.every((id, i) => long[i] === id);
  console.log(
    isPrefix
      ? `   OK   ${label}: top-10 is a prefix of top-30 -- windows tile safely`
      : `   BAD  ${label}: top-10 is NOT a prefix of top-30 -- $skip paging would skip rows`,
  );
}
const asc = ids(await client.query(ENTITY, { select: [KEY], top: 10, orderby: `${KEY} asc` }));
const desc = ids(await client.query(ENTITY, { select: [KEY], top: 10, orderby: `${KEY} desc` }));
console.log(
  asc[0] !== desc[0]
    ? `   OK   asc and desc differ (asc=${asc[0]}, desc=${desc[0]}) -- $orderby has effect`
    : `   BAD  asc and desc are identical -- $orderby is ignored on this screen`,
);

// 5. Tile the whole entity with $skip and check it is complete and duplicate-free.
console.log("\n5. full tiling with $skip");
const PAGE = 200;
const all: string[] = [];
const seen = new Set<string>();
let dupes = 0;
for (let skip = 0; ; skip += PAGE) {
  const page = ids(
    await client.queryRawPath(`${ENTITY}?$select=${KEY}&$top=${PAGE}&$skip=${skip}&$orderby=${KEY}`),
  );
  for (const id of page) {
    if (seen.has(id)) dupes++;
    seen.add(id);
    all.push(id);
  }
  if (page.length < PAGE) break;
  if (skip > 20000) {
    console.log("   stopped at 20000 to avoid an unbounded loop");
    break;
  }
}
console.log(`   fetched ${all.length} rows, ${seen.size} unique, ${dupes} duplicate(s)`);
console.log(
  dupes === 0 && seen.size === all.length
    ? "   OK   $skip tiles the entity cleanly"
    : "   BAD  tiling produced duplicates",
);
