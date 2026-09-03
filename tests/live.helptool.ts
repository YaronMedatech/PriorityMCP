// The new tools as a remote client sees them, through the running service.
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
const client = new Client({ name: "helptool", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${tlsOn ? "https" : "http"}://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { text?: string }[]; isError?: boolean };
  const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
  if (r.isError) throw new Error(text.slice(0, 200));
  return JSON.parse(text);
};

console.log("\n1. help for a column, over the wire");
const col = await call("help", { name: "AINVOICES", column: "CUSTNAME" });
if (col.available && col.kind === "column" && String(col.text).length > 100) ok(`AINVOICES.CUSTNAME: ${String(col.text).length} chars — "${String(col.text).slice(0, 60)}…"`);
else bad(JSON.stringify(col).slice(0, 200));

console.log("\n2. help for a report: refused as a permission, not as absence");
const rep = await call("help", { name: "FORMTRIGREP", type: "R" });
if (rep.available === false && rep.permission === true) ok(`FORMTRIGREP(R): permission — "${String(rep.reason).slice(0, 70)}…"`);
else if (rep.available) ok(`FORMTRIGREP(R): ${String(rep.text).length} chars (permission has been opened)`);
else bad(JSON.stringify(rep).slice(0, 200));

console.log("\n3. search_screens finds programs when asked, and not otherwise");
const progs = await call("search_screens", { query: "הפעלות מסך", kinds: ["R"], limit: 3 });
const top = progs.screens?.[0];
if (top?.screen === "FORMTRIGREP" && top.kind === "R" && typeof top.runnable === "boolean") ok(`'הפעלות מסך' -> ${top.screen} (${top.kind}), runnable=${top.runnable}`);
else bad(JSON.stringify(top));
const plain = await call("search_screens", { query: "הפעלות מסך", limit: 3 });
if ((plain.screens ?? []).every((s: any) => s.kind === "F")) ok(`without kinds: ${plain.screens.length} screen(s), no programs`);
else bad("programs leaked into a screen search");

console.log("\n4. list_skills, when the operator has enabled it");
const { tools } = await client.listTools();
if (tools.some((t) => t.name === "list_skills")) {
  const skills = await call("list_skills", {});
  if (skills.available === false && /תחזוקת מערכת|opened for the API/.test(String(skills.reason))) ok(`closed — reason names the fix`);
  else if (skills.available) ok(`${skills.count} skill(s) available`);
  else bad(JSON.stringify(skills).slice(0, 200));
} else {
  console.log("   SKIP — skills tools are off (PRIORITY_ENABLE_SKILLS), as decided");
}

console.log("\n5. readiness carries programs");
const rr = await call("readiness_report", {});
if (rr.totals?.programs > 5000 && typeof rr.totals?.runnablePrograms === "number") ok(`programs=${rr.totals.programs}, runnable=${rr.totals.runnablePrograms}${rr.skills ? `, skills.available=${rr.skills.available}` : ""}`);
else bad(JSON.stringify(rr.totals));

await client.close();
console.log(failures === 0 ? "\nAll over-the-wire checks of the new tools passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
