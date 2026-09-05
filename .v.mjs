import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const t = new StreamableHTTPClientTransport(new URL("https://TATINT:3401/mcp"), { requestInit: { headers: { Authorization: `Bearer ${process.env.TOK}` } } });
const mcp = new Client({ name: "v", version: "0.0.0" });
await mcp.connect(t);
await mcp.callTool({ name: "use_company", arguments: { company: "tat002" } });
const j = (r) => JSON.parse(r.content[0].text);
let r = j(await mcp.callTool({ name: "start_program", arguments: { name: "AGEDEBTCUST3", type: "P" } }));
console.log(`start        -> kind=${r.step.kind}  formats=${(r.step.formats ?? []).length}`);
const sid = r.session;
r = j(await mcp.callTool({ name: "continue_program", arguments: { session: sid, action: { output: {} } } }));
console.log(`after output -> kind=${r.step.kind}  fields=${(r.step.fields ?? []).map(f => f.title).join("|")}`);
if (r.step.kind === "input") {
  r = j(await mcp.callTool({ name: "continue_program", arguments: { session: sid, action: { input: { Subsidiary: "000" } } } }));
  console.log(`after dlg1   -> kind=${r.step.kind}  fields=${(r.step.fields ?? []).map(f => f.title).join("|")}`);
  if (r.step.kind === "input") {
    r = j(await mcp.callTool({ name: "continue_program", arguments: { session: sid, action: { input: { "As of Date": "31/12/25" } } } }));
    console.log(`after dlg2   -> kind=${r.step.kind}  done=${r.done}  outputLen=${(r.step.output ?? "").length}`);
  }
}
if (!r.done) { await mcp.callTool({ name: "continue_program", arguments: { session: sid, action: { cancel: true } } }); }
await mcp.close();
