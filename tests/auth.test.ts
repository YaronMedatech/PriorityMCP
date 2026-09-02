// Credential modes, over a real MCP handshake.
//
// Two clients are simulated: one that supports elicitation and one that does not
// — which is the actual split in the wild (Claude Code and VS Code Copilot do;
// Claude Desktop and Gemini CLI do not). The fallback is the part that matters,
// because without it half the clients would simply stop working.
//
// Points at an unroutable address, so nothing external is contacted and every
// Priority call fails the same way regardless of identity.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadAuthPolicy, patHeader, userHeader } from "../src/auth.js";

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

interface BootOpts {
  env: Record<string, string>;
  /** null = advertise elicitation but never answer; undefined = no capability. */
  onElicit?: ((msg: string) => Record<string, string> | "decline") | null;
}

async function boot({ env, onElicit }: BootOpts) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SERVER_ARGS,
    stderr: "ignore",
    env: {
      ...(process.env as Record<string, string>),
      PRIORITY_ODATA_URL: "https://192.0.2.1/odata/Priority/tabula.ini,1",
      PRIORITY_ENVIRONMENTS: "acme",
      PRIORITY_COMPANY: "",
      PRIORITY_API_TOKEN: "shared-token-from-env",
      PRIORITY_USER: "",
      PRIORITY_PASS: "",
      PRIORITY_VERIFY_SSL: "0",
      PRIORITY_TIMEOUT_MS: "2500",
      PRIORITY_MAX_REQUESTS_PER_MIN: "0",
      ...env,
    },
  });

  const capabilities = onElicit !== undefined ? { elicitation: {} } : {};
  const mcp = new Client({ name: "auth-test", version: "0.0.0" }, { capabilities });

  if (onElicit !== undefined) {
    mcp.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = String((req.params as { message?: string }).message ?? "");
      if (onElicit === null) throw new Error("Method not found");
      const answer = onElicit(message);
      if (answer === "decline") return { action: "decline" as const };
      return { action: "accept" as const, content: answer };
    });
  }

  await mcp.connect(transport);
  return mcp;
}

/** Call a tool and report whether it was refused for want of an identity. */
async function probe(mcp: Client) {
  const r = (await mcp.callTool({ name: "search_screens", arguments: { query: "x", limit: 1 } })) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
  return { refused: /Not signed in to Priority/.test(text), text };
}

console.log("\n1. The policy is read from .env, with safe defaults");
{
  const d = loadAuthPolicy({} as NodeJS.ProcessEnv);
  if (d.mode === "shared" && d.fallback === "shared") ok("defaults to shared/shared");
  else bad(`defaults were ${d.mode}/${d.fallback}`);

  const e = loadAuthPolicy({ PRIORITY_AUTH_MODE: "ELICIT", PRIORITY_AUTH_FALLBACK: "refuse" } as never);
  if (e.mode === "elicit" && e.fallback === "refuse") ok("case-insensitive, both settings honoured");
  else bad(`parsed ${e.mode}/${e.fallback}`);

  // An unreadable value must not silently disable authentication.
  const junk = loadAuthPolicy({ PRIORITY_AUTH_MODE: "nonsense" } as never);
  if (junk.mode === "shared") ok("an unrecognised mode falls back to shared, not to nothing");
  else bad(`unrecognised mode became ${junk.mode}`);
}

console.log("\n2. Header building");
{
  const p = patHeader("abc");
  if (Buffer.from(p.slice(6), "base64").toString() === "abc:PAT") ok("a PAT pairs with the literal 'PAT'");
  else bad("PAT header is wrong");
  const u = userHeader("bob", "s3cret");
  if (Buffer.from(u.slice(6), "base64").toString() === "bob:s3cret") ok("user/pass header is correct");
  else bad("user header is wrong");
}

console.log("\n3. shared mode: no prompt, the .env identity is used");
{
  const mcp = await boot({ env: { PRIORITY_AUTH_MODE: "shared" }, onElicit: () => ({ token: "t" }) });
  const { refused, text } = await probe(mcp);
  if (!refused) ok("the call proceeded without asking for an identity");
  else bad(`refused unexpectedly: ${text.slice(0, 120)}`);
  await mcp.close();
}

console.log("\n4. headers mode: refuses, and says where the credentials belong");
{
  const mcp = await boot({ env: { PRIORITY_AUTH_MODE: "headers" } });
  const { refused, text } = await probe(mcp);
  if (refused) ok("refused when no caller credentials were supplied");
  else bad("proceeded without an identity");
  if (/configuration file/.test(text) && /not.{0,10}in this conversation/i.test(text)) {
    ok("the message points at the client config, not at the chat");
  } else bad(`message does not steer the user correctly: ${text.slice(0, 160)}`);
  await mcp.close();
}

console.log("\n5. elicit mode: the client is asked, and the answer is used");
{
  let asked = "";
  const mcp = await boot({
    env: { PRIORITY_AUTH_MODE: "elicit" },
    onElicit: (msg) => {
      asked = msg;
      return { token: "user-supplied-pat" };
    },
  });
  const { refused } = await probe(mcp);
  if (asked) ok("the server prompted the user through the client");
  else bad("no elicitation request was made");
  if (/not sent to the AI model/i.test(asked)) {
    ok("the prompt tells the user the value does not reach the model");
  } else bad(`prompt text was: ${asked.slice(0, 120)}`);
  if (!refused) ok("the supplied credentials were accepted and the call proceeded");
  else bad("still refused after credentials were provided");
  await mcp.close();
}

console.log("\n6. elicit mode: the user declines");
{
  const mcp = await boot({
    env: { PRIORITY_AUTH_MODE: "elicit", PRIORITY_AUTH_FALLBACK: "refuse" },
    onElicit: () => "decline",
  });
  const { refused, text } = await probe(mcp);
  if (refused && /declined/i.test(text)) ok("a decline is reported as a decline, not as a Priority error");
  else bad(`unexpected: ${text.slice(0, 140)}`);
  await mcp.close();
}

console.log("\n7. A client with NO elicitation support (Gemini CLI, Claude Desktop)");
{
  // fallback=shared: keep working under the .env identity.
  const a = await boot({ env: { PRIORITY_AUTH_MODE: "elicit", PRIORITY_AUTH_FALLBACK: "shared" } });
  const ra = await probe(a);
  if (!ra.refused) ok("falls back to the shared identity, so the client still works");
  else bad(`refused despite fallback=shared: ${ra.text.slice(0, 120)}`);
  await a.close();

  // fallback=refuse: stop, and say why rather than failing obscurely.
  const b = await boot({ env: { PRIORITY_AUTH_MODE: "elicit", PRIORITY_AUTH_FALLBACK: "refuse" } });
  const rb = await probe(b);
  if (rb.refused && /does not support MCP elicitation/.test(rb.text)) {
    ok("refuses with the real reason, and names the clients that do support it");
  } else bad(`unexpected: ${rb.text.slice(0, 160)}`);
  await b.close();
}

console.log("\n8. A client that advertises elicitation but throws (the Gemini CLI bug)");
{
  const mcp = await boot({
    env: { PRIORITY_AUTH_MODE: "elicit", PRIORITY_AUTH_FALLBACK: "shared" },
    onElicit: null,
  });
  const { refused } = await probe(mcp);
  if (!refused) ok("a 'Method not found' answer is treated as unsupported and falls back");
  else bad("a throwing client broke the session instead of falling back");
  await mcp.close();
}

console.log(failures === 0 ? "\nAll credential-mode checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
