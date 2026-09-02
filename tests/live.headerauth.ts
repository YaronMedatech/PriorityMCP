// Every authentication path a remote client can use, exercised as a remote client.
//
// Worth testing over the wire rather than reading off http.ts: callerCredentials()
// runs BEFORE the token check and independently of PRIORITY_AUTH_MODE, so which
// combinations actually work is a property of the running server, not of the
// config. The generated client kit hands out the header-credential form, and that
// form must be known to work before it is handed to anyone.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

// The LAN address by default, not loopback: header credentials are refused over
// an unencrypted connection but ALLOWED on loopback, so testing against
// 127.0.0.1 would pass a case a real client cannot reach.
const host = process.env["MCP_HTTP_TEST_HOST"] ?? "192.168.201.62";
const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const endpoint = `${tlsOn ? "https" : "http"}://${host}:${port}/mcp`;

const user = (process.env["PRIORITY_USER"] ?? "").trim();
const pass = (process.env["PRIORITY_PASS"] ?? "").trim();
const pat = (process.env["PRIORITY_API_TOKEN"] ?? "").trim();
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();

let failures = 0;

/** @param expect whether a client sending these headers should get in. */
const attempt = async (label: string, headers: Record<string, string>, expect: boolean): Promise<void> => {
  const c = new Client({ name: "headerauth", version: "1" });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } }));
    const { tools } = await c.listTools();
    const company = /company '([^']+)'/.exec(c.getInstructions() ?? "")?.[1] ?? "?";
    await c.close();
    if (expect) console.log(`  ok      ${label}\n            -> ${tools.length} tools, company ${company}`);
    else {
      failures++;
      console.log(`  FAIL    ${label}\n            -> ACCEPTED, and should not have been`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
    if (expect) {
      failures++;
      console.log(`  FAIL    ${label}\n            -> refused: ${msg}`);
    } else console.log(`  ok      ${label}\n            -> refused, as intended`);
  }
};

console.log(`\n${endpoint}\n`);
await attempt("Authorization: Bearer <MCP_AUTH_TOKEN>", { Authorization: `Bearer ${token}` }, true);
await attempt("X-Priority-User + X-Priority-Pass", { "X-Priority-User": user, "X-Priority-Pass": pass }, true);
await attempt("X-Priority-Token (PAT)", { "X-Priority-Token": pat }, true);
await attempt("Bearer + X-Priority-Company: demo", { Authorization: `Bearer ${token}`, "X-Priority-Company": "demo" }, true);
await attempt("no credentials at all", {}, false);
await attempt("wrong bearer token", { Authorization: "Bearer 0000000000000000000000000000000000" }, false);
await attempt("username with no password", { "X-Priority-User": user }, false);
await attempt("unknown company", { Authorization: `Bearer ${token}`, "X-Priority-Company": "nosuchco" }, false);

console.log(failures === 0 ? "\nAll authentication paths behave as documented.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
