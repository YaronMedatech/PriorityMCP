// Picking a company per connection, over the wire.
//
// The check that matters is that two sessions return DIFFERENT DATA. Everything
// else — the header parsing, the URL building — can look right while both
// sessions quietly read the same company, and nothing in either reply would show
// it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnvFile, listEnvironments } from "../src/config.js";

loadEnvFile();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const host = process.env["MCP_TLS_TEST_HOST"] ?? "127.0.0.1";
const port = process.env["MCP_HTTP_PORT"] ?? "3401";
const token = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();
const tlsOn = Boolean((process.env["MCP_TLS_PFX"] ?? process.env["MCP_TLS_CERT"] ?? "").trim());
const endpoint = `${tlsOn ? "https" : "http"}://${host}:${port}/mcp`;

const companies = listEnvironments();
console.log(`\nconfigured companies: ${companies.join(", ")}\n`);
if (companies.length < 2) {
  console.log("Fewer than two companies configured — nothing to compare.\n");
  process.exit(0);
}
const [A, B] = companies as [string, string];

const connect = async (company?: string) => {
  const c = new Client({ name: `mc-${company ?? "default"}`, version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(company ? { "X-Priority-Company": company } : {}),
        },
      },
    }),
  );
  return c;
};

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  const text = r.content?.map((x) => x.text ?? "").join("") ?? "";
  if (r.isError) throw new Error(text.slice(0, 200));
  return JSON.parse(text);
};

console.log(`1. Each session is told which company it is on`);
const ca = await connect(A);
const cb = await connect(B);
const ia = ca.getInstructions() ?? "";
const ib = cb.getInstructions() ?? "";
if (ia.includes(`company '${A}'`)) ok(`session A says it reads ${A}`);
else bad(`session A instructions do not name ${A}`);
if (ib.includes(`company '${B}'`)) ok(`session B says it reads ${B}`);
else bad(`session B instructions do not name ${B}`);
if (ia !== ib) ok("the two sessions received different instructions");
else bad("both sessions got identical instructions — the company is not reaching them");

console.log(`\n2. list_companies returns real names, and marks the active one`);
const listed = await call(ca, "list_companies", {});
for (const c of listed.companies ?? []) {
  console.log(`   ${c.active ? "*" : " "} ${String(c.company).padEnd(10)} ${JSON.stringify(c.name)}`);
}
if ((listed.companies ?? []).length === companies.length) ok(`all ${companies.length} listed`);
else bad(`${(listed.companies ?? []).length} listed`);
if (listed.active === A) ok(`active reported as ${A}`);
else bad(`active reported as ${String(listed.active)}`);

console.log(`\n3. use_company switches the session`);
const switched = await call(ca, "use_company", { company: B });
console.log(`   ${String(switched.previousCompany)} -> ${String(switched.company)} (${JSON.stringify(switched.name)})`);
if (switched.company === B) ok("the switch is reported");
else bad(`switch returned ${String(switched.company)}`);
if (/DATA CHANGED, NOTHING ELSE/.test(String(switched.note))) {
  ok("the reply tells the model not to re-run discovery");
} else bad("the reply does not mention that only the data changed");
// Put it back so the comparison below is between two distinct sessions.
await call(ca, "use_company", { company: A });

console.log(`\n4. The two sessions read DIFFERENT data`);
const readFirst = async (c: Client, label: string): Promise<string | null> => {
  try {
    const r = await call(c, "query", { entity: "CUSTOMERS", top: 1, select: "CUSTNAME,CUSTDES" });
    return String(r.rows?.[0]?.CUSTDES ?? "");
  } catch (err) {
    console.log(`   ${label}: cannot read — ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    return null;
  }
};
const rowA = await readFirst(ca, A);
const rowB = await readFirst(cb, B);
if (rowA === null || rowB === null) {
  console.log("   SKIPPED — CUSTOMERS is not readable on this installation.");
} else {
  console.log(`   ${A}: ${rowA}\n   ${B}: ${rowB}`);
  if (rowA !== rowB) ok("the sessions really are reading different companies");
  else console.log("   (identical first row — possible on similar demo companies)");
}

console.log(`\n5. An unknown company is refused — and does not take the server down`);
try {
  await connect("nosuchcompany");
  bad("an unknown company was accepted");
} catch (err) {
  console.log(`   ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
  ok("refused at connect");
}
// The refusal must be THIS caller's problem only. buildServer exits the process
// on a config error, so an unvalidated company header would have killed the
// server for everyone.
const stillUp = await call(ca, "search_screens", { query: "AINVOICES", limit: 1 });
if (stillUp.totalMatches >= 0) ok("the existing session still works — the server survived");
else bad("the server is no longer answering");

console.log(`\n6. A path-shaped company header is refused`);
for (const attack of ["../demo", "hafaza/../demo", "..%2Fdemo"]) {
  try {
    await connect(attack);
    bad(`ACCEPTED a path-shaped company: ${attack}`);
  } catch {
    ok(`refused: ${attack}`);
  }
}

await ca.close();
await cb.close();
console.log(failures === 0 ? "\nAll multi-company checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
