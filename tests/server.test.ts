// Boots the real MCP server as a child process and drives it over stdio.
// Points it at an unroutable address so nothing external is contacted: the goal
// is to prove the server boots, registers its tools with usable schemas, and
// turns a failure into a readable message rather than a crash.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const SERVER_ARGS = [
  path.join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(HERE, "..", "src", "server.ts"),
];

/** Boot a server with a given env overlay and return its tool names. */
async function boot(extraEnv: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SERVER_ARGS,
    stderr: "inherit",
    env: {
      ...(process.env as Record<string, string>),
      // TEST-NET-1 (RFC 5737): reserved for documentation, never routable.
      PRIORITY_ODATA_URL: "https://192.0.2.1/odata/Priority/tabula.ini,1/testco",
      PRIORITY_API_TOKEN: "not-a-real-token",
      PRIORITY_VERIFY_SSL: "0",
      PRIORITY_TIMEOUT_MS: "3000",
      ...extraEnv,
    },
  });
  const mcp = new Client({ name: "smoke", version: "0.0.0" });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  return { mcp, tools };
}

console.log("\n1. Server boot and tool registration");
const { mcp, tools } = await boot({});
ok("server started and completed the MCP handshake");

const names = tools.map((t) => t.name);
console.log(`       tools: ${names.join(", ")}`);

for (const expected of ["search_screens", "describe_screen", "query", "list_programs", "run_program"]) {
  if (names.includes(expected)) ok(`${expected} registered`);
  else bad(`${expected} NOT registered`);
}

// Hidden by default so the discovery tools actually get exercised.
if (!names.includes("get_sales")) ok("get_sales hidden by default");
else bad("get_sales is registered even though it should be gated off");

console.log("\n2. The query tool's schema and description");
const query = tools.find((t) => t.name === "query");
if (!query) {
  bad("query tool missing");
} else {
  const schema = query.inputSchema as { properties?: Record<string, unknown> };
  const props = Object.keys(schema.properties ?? {});
  const expected = ["entity", "path", "filter", "select", "expand", "orderby", "top"];
  const missing = expected.filter((p) => !props.includes(p));
  if (missing.length === 0) ok(`schema exposes all ${expected.length} parameters`);
  else bad(`schema missing: ${missing.join(", ")}`);

  const desc = query.description ?? "";
  // These are the measured server limitations. A caller that does not know them
  // burns a turn rediscovering each one.
  for (const [label, re] of [
    ["read-only", /READ-ONLY/i],
    ["the 501 operators", /501/],
    ["the select+expand truncation", /select.{0,40}ignored|expand/i],
  ] as const) {
    if (re.test(desc)) ok(`description warns about ${label}`);
    else bad(`description does not mention ${label}`);
  }
}

console.log("\n3. search_screens warns that its own flag is not a guarantee");
const search = tools.find((t) => t.name === "search_screens");
if (/CASE-SENSITIVE/i.test(search?.description ?? "")) ok("search_screens warns about case sensitivity");
else bad("search_screens does not warn about case sensitivity");

console.log("\n4. Unreachable server becomes a readable tool error");
const start = Date.now();
const res = (await mcp.callTool({
  name: "query",
  arguments: { entity: "AINVOICES", top: 1 },
})) as { isError?: boolean; content?: { type: string; text?: string }[] };
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";

if (res.isError) ok(`returned isError after ${elapsed}s rather than crashing`);
else bad("unreachable host did not produce an error result");
if (/Priority call failed/.test(text)) ok("error text is the tool's own message, not a raw stack");
else bad(`unexpected error text: ${text.slice(0, 200)}`);
if (!/not-a-real-token/.test(text)) ok("credentials do not appear in the error text");
else bad("SECURITY: the token leaked into the tool error text");

await mcp.close();

console.log("\n5. The get_sales gate opens when asked");
const second = await boot({ PRIORITY_ENABLE_GET_SALES: "1" });
if (second.tools.some((t) => t.name === "get_sales")) {
  ok("PRIORITY_ENABLE_GET_SALES=1 exposes get_sales again");
} else bad("the gate did not re-expose get_sales");
await second.mcp.close();

console.log(failures === 0 ? "\nAll server smoke checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
