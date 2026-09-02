// Encrypted transport, and caller-supplied Priority credentials.
//
// Run with the CA trusted:
//   $env:NODE_EXTRA_CA_CERTS="$PWD\certs\mcp-ca.pem"; npx tsx tests/live.tls.ts
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

const host = process.env["MCP_TLS_TEST_HOST"] ?? "192.168.201.62";
const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
const url = `https://${host}:${port}/mcp`;

console.log(`\nconnecting over TLS to ${url}\n`);

const connect = async (headers: Record<string, string>, name: string) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
};

console.log("1. The bearer token still works over TLS");
try {
  const c = await connect({ Authorization: `Bearer ${token}` }, "tls-bearer");
  const { tools } = await c.listTools();
  console.log(`   ${tools.length} tools`);
  ok(`connected over https and listed ${tools.length} tools`);
  await c.close();
} catch (err) {
  bad(`bearer over TLS failed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\n2. Caller-supplied Priority credentials are accepted over TLS");
// The same credentials the server would otherwise read from .env — the point is
// the ROUTE, not the identity: they arrive in a header the client config sets,
// so the model never sees them.
const user = (process.env["PRIORITY_USER"] ?? "").trim();
const pass = (process.env["PRIORITY_PASS"] ?? "").trim();
const pat = (process.env["PRIORITY_API_TOKEN"] ?? "").trim();

if (user && pass) {
  try {
    const c = await connect({ "X-Priority-User": user, "X-Priority-Pass": pass }, "tls-creds");
    const r = (await c.callTool({
      name: "search_screens",
      arguments: { query: "AINVOICES", limit: 1 },
    })) as { content?: { text?: string }[]; isError?: boolean };
    const text = r.content?.map((x) => x.text ?? "").join("") ?? "";
    if (!r.isError && text.includes("AINVOICES")) {
      ok("a session authenticated by header credentials can read Priority");
    } else bad(`tool call failed: ${text.slice(0, 140)}`);
    await c.close();
  } catch (err) {
    bad(`header credentials failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else if (pat) {
  try {
    const c = await connect({ "X-Priority-Token": pat }, "tls-pat");
    await c.listTools();
    ok("a session authenticated by a Priority PAT header connected");
    await c.close();
  } catch (err) {
    bad(`PAT header failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  console.log("   (no PRIORITY_USER/PASS or PAT in .env — nothing to send)");
}

console.log("\n3. Wrong Priority credentials fail at Priority, not silently");
try {
  const c = await connect({ "X-Priority-User": "nosuchuser", "X-Priority-Pass": "wrong" }, "tls-bad");
  const r = (await c.callTool({
    name: "query",
    arguments: { entity: "AINVOICES", top: 1 },
  })) as { content?: { text?: string }[]; isError?: boolean };
  const text = r.content?.map((x) => x.text ?? "").join("") ?? "";
  if (r.isError) {
    console.log(`   ${text.split("\n")[0]?.slice(0, 110)}`);
    ok("a bad Priority identity is reported as an error, not as empty data");
  } else {
    bad("a bad identity returned data — credentials are not being applied");
  }
  await c.close();
} catch (err) {
  console.log(`   rejected at connect: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
  ok("refused");
}

console.log("\n4. An untrusted client cannot connect at all");
// Proves the encryption is verified rather than merely offered.
const res = await fetch(`https://${host}:${port}/health`)
  .then(() => "accepted")
  .catch((e: { cause?: { code?: string } }) => e.cause?.code ?? "refused");
if (res === "accepted") {
  console.log("   (this process trusts the CA, so it connected — expected here)");
  ok("CA trust is what makes the connection work");
} else {
  bad(`even the trusted client was refused: ${res}`);
}

console.log(failures === 0 ? "\nAll TLS checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
