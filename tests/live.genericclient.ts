// Can a NON-Claude client reach this server?
//
// Gemini CLI, Google ADK and anything else speaking Streamable HTTP use plain
// JSON-RPC over https with headers — no Anthropic SDK anywhere. This test uses
// raw fetch for exactly that reason: it proves the server is client-agnostic
// rather than proving our own SDK talks to itself.
//
// Run with the CA trusted:
//   $env:NODE_EXTRA_CA_CERTS="$PWD\certs\mcp-ca.pem"; npx tsx tests/live.genericclient.ts
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const host = process.env["MCP_TLS_TEST_HOST"] ?? "192.168.201.62";
const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const endpoint = `https://${host}:${port}/mcp`;

// Credentials as headers, the way a client config supplies them.
const base: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const user = (process.env["PRIORITY_USER"] ?? "").trim();
const pass = (process.env["PRIORITY_PASS"] ?? "").trim();
if (user && pass) {
  base["X-Priority-User"] = user;
  base["X-Priority-Pass"] = pass;
} else {
  base["Authorization"] = `Bearer ${(process.env["MCP_AUTH_TOKEN"] ?? "").trim()}`;
}

const rpc = async (headers: Record<string, string>, body: unknown) =>
  fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });

console.log(`\nplain JSON-RPC over TLS to ${endpoint}\n`);

console.log("1. initialize");
const init = await rpc(base, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "generic-http-client", version: "1" },
  },
});
const sid = init.headers.get("mcp-session-id");
const initBody = await init.text();
console.log(`   HTTP ${init.status}, session ${sid ? `${sid.slice(0, 8)}...` : "none"}`);
if (init.status === 200 && sid) ok("a client with no MCP SDK completed the handshake");
else bad(`initialize returned ${init.status}`);
if (initBody.includes("instructions")) ok("server instructions delivered to a generic client");
else bad("no instructions in the initialize result");

const withSession = { ...base, "mcp-session-id": sid ?? "" };
await rpc(withSession, { jsonrpc: "2.0", method: "notifications/initialized" });

console.log("\n2. tools/list");
const lt = await rpc(withSession, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const listBody = await lt.text();
const names = [...new Set([...listBody.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]!))];
console.log(`   HTTP ${lt.status}: ${names.join(", ")}`);
if (names.length === 8) ok("all 8 tools advertised");
else bad(`expected 8 tools, saw ${names.length}`);
if (listBody.includes("readOnlyHint")) ok("annotations delivered, so a client can auto-approve safely");
else bad("no annotations in the tool list");

console.log("\n3. a real call, with Hebrew in and Hebrew out");
const call = await rpc(withSession, {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "search_screens", arguments: { query: "מחזור", limit: 2 } },
});
const callBody = await call.text();
console.log(`   HTTP ${call.status}, ${callBody.length} bytes`);
if (callBody.includes("AINVOICES")) ok("a Hebrew business term resolved end to end");
else bad(`unexpected reply: ${callBody.slice(0, 160)}`);

console.log("\n4. aggregate over the same channel");
const agg = await rpc(withSession, {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "aggregate",
    arguments: { entity: "AINVOICES", groupBy: [], aggregate: [{ fn: "count" }] },
  },
});
const aggBody = await agg.text();
if (aggBody.includes("groupCount")) ok("aggregation works for a non-Claude client");
else bad(`aggregate failed: ${aggBody.slice(0, 160)}`);

console.log(failures === 0 ? "\nThe server is client-agnostic.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
