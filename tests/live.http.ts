// Connects a real MCP client over HTTP, the way another machine will.
// Requires `npm run server:http` to be running.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const host = process.env["MCP_HTTP_TEST_HOST"] ?? "127.0.0.1";
const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
// Follow the server's actual scheme; it switches to HTTPS when a certificate is
// configured, and a test hard-coded to http:// would then fail for the wrong reason.
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const endpoint = `${tlsOn ? "https" : "http"}://${host}:${port}/mcp`;

console.log(`\nconnecting to ${endpoint}`);

console.log("\n1. A wrong token is refused");
try {
  const badClient = new Client({ name: "http-test-bad", version: "1" });
  await badClient.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: "Bearer definitely-not-the-token" } },
    }),
  );
  bad("a wrong token was accepted");
  await badClient.close();
} catch {
  ok("a wrong token is rejected before any tool is reachable");
}

console.log("\n2. The correct token connects and lists the same tools");
const client = new Client({ name: "http-test", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`   tools: ${names.join(", ")}`);

// Same set the stdio transport exposes -- both share buildServer().
const expected = [
  "aggregate",
  "column_values",
  "describe_screen",
  "list_companies",
  "list_programs",
  "query",
  "readiness_report",
  "run_program",
  "search_screens",
  "use_company",
];
if (JSON.stringify(names) === JSON.stringify(expected)) {
  ok(`all ${expected.length} tools exposed over HTTP, identical to stdio`);
} else bad(`tool set differs: ${names.join(", ")}`);

console.log("\n3. A tool call works over the wire");
const res = (await client.callTool({
  name: "search_screens",
  arguments: { query: "חשבוניות מס", limit: 3 },
})) as { content?: { type: string; text?: string }[]; isError?: boolean };

const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
if (res.isError) {
  bad(`tool call errored: ${text.slice(0, 200)}`);
} else {
  const parsed = JSON.parse(text) as { totalMatches: number; screens: { screen: string; title: string }[] };
  ok(`search_screens returned ${parsed.totalMatches} matches over HTTP`);
  for (const s of parsed.screens.slice(0, 3)) console.log(`       ${s.screen} — ${s.title}`);
}

console.log("\n4. A second client can connect while the first is still open");
// This is the regression guard for the session bug: with one shared transport
// the first client works and the second fails with an opaque 500, which is
// exactly the shape a single-client test cannot see.
const second = new Client({ name: "http-test-2", version: "1" });
try {
  await second.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const both = await Promise.all([client.listTools(), second.listTools()]);
  if (both[0].tools.length === both[1].tools.length && both[0].tools.length > 0) {
    ok(`two concurrent clients each see ${both[0].tools.length} tools`);
  } else {
    bad(`concurrent clients disagree: ${both[0].tools.length} vs ${both[1].tools.length}`);
  }
  await second.close();
} catch (err) {
  bad(`second concurrent client failed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\n5. An explicit termination frees the session server-side");
// close() alone sends nothing on the wire -- only terminateSession() does. This
// checks the server's teardown path actually runs when it IS told, which is what
// the onclose chain in http.ts exists for. Sessions from clients that never say
// goodbye are handled by the idle reaper instead.
const third = new Client({ name: "http-test-3", version: "1" });
const thirdTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
try {
  await third.connect(thirdTransport);
  await third.listTools();
  await thirdTransport.terminateSession();
  // The id is cleared locally on success; reusing it must now be refused.
  const res2 = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": thirdTransport.sessionId ?? "already-cleared",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  });
  if (res2.status === 400 || res2.status === 404) {
    ok(`a terminated session is no longer usable (HTTP ${res2.status})`);
  } else {
    bad(`a terminated session still answered with HTTP ${res2.status}`);
  }
  await third.close();
} catch (err) {
  bad(`termination check failed: ${err instanceof Error ? err.message : String(err)}`);
}

await client.close();

// The config another machine needs, written out rather than described.
//
// The address is resolved here rather than left as a placeholder: the other
// machine cannot reach "localhost", and a config that looks complete but points
// at the wrong host is the most likely way this goes wrong.
const lanAddress = (): string => {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "<THIS-MACHINE-IP>";
};

const cfg = {
  mcpServers: {
    priority: {
      type: "http",
      url: `${tlsOn ? "https" : "http"}://${lanAddress()}:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
};
const outFile = path.join(process.cwd(), "remote-mcp-config.json");
fs.writeFileSync(outFile, JSON.stringify(cfg, null, 2), "utf8");
console.log(`\nclient config written to ${outFile} (contains the token -- gitignored)`);

console.log(failures === 0 ? "\nAll HTTP transport checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
