// Dump exactly what an LLM receives when it connects: the tool list as the
// protocol delivers it, with descriptions and input schemas verbatim.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
// Follow the server's configured scheme. Hard-coding http:// here survived the
// TLS switch and then failed with an HTTP parser error about a malformed
// response, which points at the server rather than at this line.
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const client = new Client({ name: "tool-dump", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${tlsOn ? "https" : "http"}://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const { tools } = await client.listTools();
const instructions = client.getInstructions() ?? "";
const out: string[] = [];
let totalChars = instructions.length;

for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
  const desc = t.description ?? "";
  const schema = JSON.stringify(t.inputSchema, null, 2);
  totalChars += desc.length + schema.length;
  out.push(`${"=".repeat(78)}\nTOOL: ${t.name}`);
  out.push(`TITLE: ${t.title ?? t.annotations?.title ?? "(none)"}`);
  out.push(`ANNOTATIONS: ${JSON.stringify(t.annotations ?? null)}`);
  out.push(`DESCRIPTION (${desc.length} chars):\n${desc}`);
  out.push(`INPUT SCHEMA:\n${schema}\n`);
}

const summary = [...tools]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((t) => `  ${t.name.padEnd(18)} ${String(t.description?.length ?? 0).padStart(5)} chars`)
  .join("\n");

const header =
  `${tools.length} tools, ~${totalChars} chars of instruction text ` +
  `(~${Math.round(totalChars / 3.5)} tokens, rough)\n` +
  `server instructions: ${instructions.length} chars\n\n${summary}\n`;

const file = path.join(process.cwd(), "tools-dump.txt");
fs.writeFileSync(
  file,
  `${header}\n${"=".repeat(78)}\nSERVER INSTRUCTIONS\n${instructions}\n\n${out.join("\n")}`,
  "utf8",
);
console.log(header);
console.log(`full dump written to ${file}`);
await client.close();
