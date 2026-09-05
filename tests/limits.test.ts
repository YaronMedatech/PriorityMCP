// The result ceilings, and what a CLIENT is actually offered when they change.
//
// Two halves, because two different things can go wrong. loadResultLimits is
// checked directly: it has to reject a value that is not a whole number rather
// than quietly coercing one, since a silently-wrong ceiling is the kind of
// setting nobody revisits. And the tool schema is checked through a real MCP
// handshake, because the ceiling is a zod `.max()` on the input schema AND a
// number quoted in the tool description -- a description that still says
// "capped at 500" on a server configured otherwise is a false statement placed
// directly in the model's system prompt.
//
// Same harness as toolgate.test.ts, pointed at an unroutable address so nothing
// external is contacted.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadResultLimits, uncapped } from "../src/config.js";

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
  const mcp = new Client({ name: "limits", version: "0.0.0" });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  return { mcp, tools };
}

/** The JSON Schema one tool advertises for one of its arguments. */
function argSchema(
  tools: { name: string; inputSchema?: unknown }[],
  tool: string,
  arg: string,
): Record<string, unknown> | undefined {
  const found = tools.find((t) => t.name === tool);
  const props = (found?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props?.[arg] as Record<string, unknown> | undefined;
}

function descriptionOf(tools: { name: string; description?: string }[], tool: string): string {
  return tools.find((t) => t.name === tool)?.description ?? "";
}

console.log("\n1. Defaults, when nothing is configured");
{
  const l = loadResultLimits({});
  if (l.rowsPerQuery === 500 && l.responseChars === 200_000 && l.scanRows === 50_000 && l.groups === 5_000) {
    ok("the shipped defaults are unchanged by adding the settings");
  } else bad(`defaults drifted: ${JSON.stringify(l)}`);
}

console.log("\n2. A configured value is read, and 0 means no ceiling");
{
  const l = loadResultLimits({
    PRIORITY_MAX_ROWS_PER_QUERY: "2000",
    PRIORITY_MAX_RESPONSE_CHARS: "0",
    PRIORITY_MAX_SCAN_ROWS: "1000000",
    PRIORITY_MAX_GROUPS: "0",
  } as NodeJS.ProcessEnv);
  if (l.rowsPerQuery === 2000 && l.scanRows === 1_000_000) ok("explicit values are read");
  else bad(`explicit values were not read: ${JSON.stringify(l)}`);

  // 0 is carried as 0 and turned into Infinity at the point of use, so that
  // arithmetic downstream needs no special case.
  if (l.responseChars === 0 && l.groups === 0) ok("0 survives parsing as 0");
  else bad(`0 was not preserved: ${JSON.stringify(l)}`);
  if (uncapped(l.responseChars) === Infinity && uncapped(500) === 500) {
    ok("uncapped() maps 0 to Infinity and leaves a real ceiling alone");
  } else bad("uncapped() does not map 0 to Infinity");
}

console.log("\n3. A value that is not a whole number is refused, not coerced");
{
  for (const [name, value] of [
    ["PRIORITY_MAX_ROWS_PER_QUERY", "-1"],
    ["PRIORITY_MAX_SCAN_ROWS", "1.5"],
    ["PRIORITY_MAX_GROUPS", "lots"],
  ] as const) {
    let threw = "";
    try {
      loadResultLimits({ [name]: value } as NodeJS.ProcessEnv);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    if (threw.includes(name)) ok(`${name}=${value} is refused, and the message names the setting`);
    else bad(`${name}=${value} was accepted or the error did not name it (got: ${threw || "no throw"})`);
  }
}

console.log("\n4. The default ceiling reaches the client as a schema bound AND as prose");
{
  const s = await boot({});
  const top = argSchema(s.tools, "query", "top");
  if (top?.["maximum"] === 500) ok("query.top advertises maximum 500");
  else bad(`query.top does not advertise maximum 500: ${JSON.stringify(top)}`);

  const maxRows = argSchema(s.tools, "aggregate", "maxRows");
  if (maxRows?.["maximum"] === 50_000) ok("aggregate.maxRows advertises maximum 50000");
  else bad(`aggregate.maxRows does not advertise maximum 50000: ${JSON.stringify(maxRows)}`);

  if (descriptionOf(s.tools, "query").includes("capped at 500 per call")) {
    ok("the query description quotes the ceiling it enforces");
  } else bad("the query description does not quote the 500-row ceiling");
  await s.mcp.close();
}

console.log("\n5. Raising the ceiling changes the schema and the description together");
{
  const s = await boot({ PRIORITY_MAX_ROWS_PER_QUERY: "2000" });
  const top = argSchema(s.tools, "query", "top");
  if (top?.["maximum"] === 2000) ok("query.top advertises the configured maximum 2000");
  else bad(`query.top did not follow the setting: ${JSON.stringify(top)}`);

  const desc = descriptionOf(s.tools, "query");
  if (desc.includes("capped at 2000 per call")) ok("the description quotes 2000, not 500");
  else bad("the description still quotes the old ceiling — it would be lying to the model");
  if (!desc.includes("capped at 500")) ok("no stale 500 left anywhere in the description");
  else bad("the description mentions 500 as well as 2000");
  await s.mcp.close();
}

console.log("\n6. PRIORITY_MAX_ROWS_PER_QUERY=0 removes the bound entirely");
{
  const s = await boot({ PRIORITY_MAX_ROWS_PER_QUERY: "0" });
  const top = argSchema(s.tools, "query", "top");
  // Not `undefined`: zod puts Number.MAX_SAFE_INTEGER on every `.int()`, because
  // that is the largest integer JavaScript can represent exactly. So "no ceiling"
  // shows up as the safe-integer bound rather than as an absent one, and a test
  // asserting `undefined` would fail forever against correct behaviour.
  if (top?.["maximum"] === Number.MAX_SAFE_INTEGER) {
    ok("query.top advertises no ceiling beyond the JS safe-integer bound");
  } else bad(`query.top still advertises a real maximum: ${JSON.stringify(top?.["maximum"])}`);

  const desc = descriptionOf(s.tools, "query");
  if (!/capped at \d+ per call/.test(desc)) ok("the description no longer claims a per-call cap");
  else bad("the description still claims a cap that is not enforced");

  // Lifting the cap must not lift the WARNING: the reply still goes into the
  // model's context, and that is the real constraint the number was standing in
  // for. A tool that silently invites a 50,000-row reply is worse than one that
  // caps it. The warning lives on the ARGUMENT, next to the value being chosen,
  // which is where a model reads it when deciding what to pass.
  const topDoc = String(top?.["description"] ?? "");
  if (/crowds\s+out the context/.test(topDoc) && /aggregate/.test(topDoc)) {
    ok("top still says why a huge reply is a bad idea, and what to use instead");
  } else bad(`the uncapped top description dropped the reason the cap existed: ${topDoc}`);
  if (/USE 'aggregate' INSTEAD/.test(desc)) ok("the tool description still routes totals to aggregate");
  else bad("the tool description stopped pointing at aggregate for totals");
  await s.mcp.close();
}

console.log(failures === 0 ? "\nAll limit checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
