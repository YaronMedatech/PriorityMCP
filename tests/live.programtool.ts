// The program tools as a remote client uses them, through the running service.
// Probes and cancels only: nothing here runs a procedure to completion.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL ${m}`); };

const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const client = new Client({ name: "programtool", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${tlsOn ? "https" : "http"}://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { text?: string }[]; isError?: boolean };
  const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
  if (r.isError) throw new Error(text.slice(0, 300));
  return JSON.parse(text);
};

const { tools } = await client.listTools();
if (!tools.some((t) => t.name === "run_program")) {
  console.log("\nSKIP — the server is read-only (PRIORITY_READ_ONLY); no program tools to test.\n");
  await client.close();
  process.exit(0);
}

console.log("\n1. run_program without inputs probes and does not run");
const probe = await call("run_program", { name: "FORMMSG" });
if (probe.status === "needs_input" && probe.inputFields?.length === 2) ok(`FORMMSG: needs_input, fields ${probe.inputFields.map((f: any) => `'${f.title}'`).join(", ")}`);
else bad(JSON.stringify(probe).slice(0, 300));

console.log("\n2. start_program opens a session at an input step");
const s = await call("start_program", { name: "FORMTRIGREP" });
if (s.session && s.step?.kind === "input" && !s.done) ok(`session ${String(s.session).slice(0, 8)}…: step=${s.step.kind}, next="${String(s.step.next).slice(0, 50)}…"`);
else bad(JSON.stringify(s).slice(0, 300));

console.log("\n3. a wrong action is refused without touching the program");
try {
  await call("continue_program", { session: s.session, action: { choose: 1 } });
  bad("choose was accepted at an input step");
} catch (err) {
  ok(`refused: ${String(err instanceof Error ? err.message : err).slice(0, 90)}`);
}

console.log("\n4. cancel closes the session");
const c = await call("continue_program", { session: s.session, action: { cancel: true } });
if (c.done && c.step?.kind === "end") ok("cancelled; done=true");
else bad(JSON.stringify(c).slice(0, 200));
try {
  await call("continue_program", { session: s.session, action: { poll: true } });
  bad("a cancelled session was still usable");
} catch {
  ok("the cancelled session id is no longer valid");
}

console.log("\n5. an uncatalogued name is refused, not guessed");
const refused = await call("run_program", { name: "KAR_EXECUPGRADES" });
if (refused.refused === true) ok("KAR_EXECUPGRADES is not in programs.json and was not started");
else bad(JSON.stringify(refused).slice(0, 200));

await client.close();
console.log(failures === 0 ? "\nAll over-the-wire program checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
