// The aggregation / profiling / explain capabilities, over the wire the way a
// remote client will use them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
// Follow whatever the server is actually configured for. With TLS on, the host
// must be a name in the certificate — 127.0.0.1 is, localhost is.
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const endpoint = `${tlsOn ? "https" : "http"}://127.0.0.1:${port}/mcp`;
const ENTITY = process.env["NEWTOOLS_ENTITY"] ?? "AINVOICES";

const client = new Client({ name: "newtools", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = (await client.callTool({ name, arguments: args })) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
  if (r.isError) throw new Error(text.slice(0, 200));
  return JSON.parse(text);
};

console.log("\n1. Server-level instructions reach the client");
const caps = client.getInstructions?.();
if (caps && caps.length > 100) {
  console.log(`   ${caps.length} chars of system-prompt guidance`);
  ok("instructions are advertised on initialize");
} else bad(`no instructions returned (${caps ? caps.length : "none"})`);

console.log("\n2. aggregate answers a total question in one call");
const agg = await call("aggregate", {
  entity: ENTITY,
  groupBy: ["IVTYPE"],
  aggregate: [{ fn: "count" }],
});
console.log(`   ${agg.groupCount} group(s), ${agg.rowsScanned} rows scanned, complete=${agg.complete}`);
for (const g of agg.groups.slice(0, 3)) console.log(`     ${JSON.stringify(g)}`);
if (agg.groupCount > 0 && agg.complete) ok("grouped totals returned and marked complete");
else bad(`unexpected: ${JSON.stringify(agg).slice(0, 150)}`);

console.log("\n3. column_values shows what a code column holds");
const dv = await call("column_values", { entity: ENTITY, column: "IVTYPE" });
console.log(
  `   ${dv.distinctCount} distinct: ${dv.values.map((v: any) => `${JSON.stringify(v.value)}×${v.count}`).join(", ")}`,
);
if (dv.values.length) ok("values returned with counts");
else bad("no values");

console.log("\n4. explain returns the URL without calling Priority");
const ex = await call("query", {
  entity: ENTITY,
  filter: "IVDATE ge 2024-01-01T00:00:00Z",
  top: 10,
  explain: true,
});
console.log(`   ${String(ex.url).slice(0, 120)}`);
// `$` arrives percent-encoded as %24 — that is what actually goes on the wire.
if (ex.executed === false && /(\$|%24)filter/.test(String(ex.url))) {
  ok("dry run shows the resolved URL and did not execute");
} else bad(`unexpected explain shape: ${JSON.stringify(ex).slice(0, 150)}`);
if (!String(ex.url).toLowerCase().includes("basic ")) ok("no credentials in the URL");
else bad("credentials leaked into the explain output");

console.log("\n5. search_screens returns glossary and examples");
const s = await call("search_screens", { query: "מה המחזור ב-2024", limit: 3 });
console.log(`   glossary: ${(s.glossary ?? []).map((g: any) => g.term).join(", ") || "(none)"}`);
console.log(`   examples: ${(s.examples ?? []).length}`);
if (s.glossary?.length) ok("a business term resolved through the glossary");
else bad("no glossary match for a revenue question");
if (s.examples?.length) ok("a worked example was surfaced");
else bad("no example matched");

console.log("\n6. readiness_report finds the real gaps");
const rr = await call("readiness_report", {});
console.log(`   ${rr.totals.screens} screens, ${rr.totals.glossaryTerms} glossary terms`);
for (const i of rr.issues.slice(0, 4)) console.log(`     [${i.severity}] ${i.kind}: ${i.count}`);
if (rr.issues.length) ok(`${rr.issues.length} issue types reported with severity`);
else bad("no issues at all — suspicious");
if (!rr.issues.some((i: any) => i.kind === "stale-glossary")) ok("no stale glossary entries");
else bad("glossary references a missing screen");

console.log("\n7. describe_screen carries help and column sources by default");
const d = await call("describe_screen", { screen: ENTITY, columns: "CUSTNAME" });
const withSource = (d.columns ?? []).filter((c: any) => c.readsFrom);
console.log(
  `   help=${d.help ? `${String(d.help).length} chars` : "none"}, columns with a source: ${withSource.length}`,
);
if (withSource.length) ok(`readsFrom present by default (e.g. ${withSource[0].name} ← ${withSource[0].readsFrom})`);
else console.log("   (no column sources on this installation — FCLMN may be closed)");

console.log("\n8. depth + subform is refused, not silently ignored");
const clash = await call("describe_screen", {
  screen: ENTITY,
  subform: "AINVOICEITEMS_SUBFORM",
  depth: 2,
});
if (clash.error) ok("the conflicting combination is reported");
else bad("depth was silently dropped");

await client.close();
console.log(failures === 0 ? "\nAll new-capability checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
