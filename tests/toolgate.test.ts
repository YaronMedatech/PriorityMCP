// Read-only mode, checked through a real MCP handshake rather than by reading the
// source. What matters is what a CLIENT is offered: a gate that leaves the tool in
// tools/list has not gated anything, however clearly the code reads.
//
// Same harness as server.test.ts, pointed at an unroutable address so nothing
// external is contacted.
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

/** The tools that must survive every gate: without them the model has to guess. */
const DISCOVERY = [
  "search_screens",
  "describe_screen",
  "query",
  "aggregate",
  "column_values",
  "readiness_report",
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
  const mcp = new Client({ name: "toolgate", version: "0.0.0" });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  return { mcp, tools, names: tools.map((t) => t.name), instructions: mcp.getInstructions() ?? "" };
}

console.log("\n1. Writing is available by default");
{
  const s = await boot({});
  if (s.names.includes("run_program")) ok("run_program registered when read-only is off");
  else bad("run_program is missing even with read-only off");
  if (/except for run_program/.test(s.instructions)) {
    ok("the instructions tell the model run_program can act");
  } else bad("the instructions do not mention run_program as the way to act");
  await s.mcp.close();
}

console.log("\n2. PRIORITY_READ_ONLY=1 takes run_program away");
{
  const s = await boot({ PRIORITY_READ_ONLY: "1" });
  if (!s.names.includes("run_program")) ok("run_program is NOT offered to the client");
  else bad("run_program is still in tools/list — the gate did nothing");

  // The point of the mode: the only tool that can change data is the only one gone.
  const missing = DISCOVERY.filter((t) => !s.names.includes(t));
  if (missing.length === 0) ok(`all ${DISCOVERY.length} discovery/read tools still registered`);
  else bad(`read-only mode removed tools it must never touch: ${missing.join(", ")}`);

  if (s.names.includes("list_programs")) ok("list_programs survives, so the catalogue is still readable");
  else bad("list_programs was removed; the program catalogue became invisible");

  await s.mcp.close();
}

console.log("\n3. The model is TOLD, not just prevented");
{
  // A client puts these instructions in its system prompt. Leaving the old text in
  // place would have the model hunting for a tool that is not there, and promising
  // to run programs it cannot run.
  const s = await boot({ PRIORITY_READ_ONLY: "1" });
  if (/READ-ONLY/.test(s.instructions)) ok("instructions still state the server is read-only");
  else bad("instructions dropped the read-only statement");
  if (!/except for run_program/.test(s.instructions)) {
    ok("instructions no longer advertise run_program as a way to act");
  } else bad("instructions still tell the model it can run programs");
  if (/cannot run any\s+program|cannot .{0,40}run/i.test(s.instructions)) {
    ok("instructions say plainly that nothing can be run");
  } else bad("instructions do not say that running is unavailable");
  await s.mcp.close();
}

console.log("\n4. list_programs says running is off, instead of reading like a menu");
{
  const s = await boot({ PRIORITY_READ_ONLY: "1" });
  const res = (await s.mcp.callTool({ name: "list_programs", arguments: {} })) as {
    content?: { type: string; text?: string }[];
  };
  const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  // The Web SDK is unconfigured in this test env, so the tool may legitimately
  // report that instead of a catalogue. Only assert the note when there is one.
  if (/RUNNING IS DISABLED/.test(text)) {
    ok("the catalogue carries the read-only note");
  } else if (/"available":\s*false/.test(text)) {
    ok("no Web SDK configured here, so there is no catalogue to annotate (expected)");
  } else {
    bad(`catalogue returned without the read-only note: ${text.slice(0, 160)}`);
  }
  await s.mcp.close();
}

console.log(failures === 0 ? "\nAll read-only gate checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
