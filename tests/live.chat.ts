// One-shot, non-interactive version of the chat client: asks a single Hebrew
// question and prints the answer. Same wiring as src/chat.ts, so it proves the
// whole LLM -> MCP -> Priority chain without needing a TTY.
// Run: npx tsx tests/live.chat.ts "כמה מכרנו ב-2025?"
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  mcpTools,
  type MCPCallToolResultLike,
  type MCPClientLike,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const question = process.argv[2] ?? "כמה מכרנו ב-2025, ובאילו מטבעות?";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(HERE, "..", "src", "server.ts"),
  ],
  stderr: "inherit",
});

const mcp = new Client({ name: "live-chat", version: "0.1.0" });
await mcp.connect(transport);
const { tools } = await mcp.listTools();

const caller: MCPClientLike = {
  async callTool(params): Promise<MCPCallToolResultLike> {
    const result = await mcp.callTool(params);
    if (Array.isArray(result["content"])) return result as unknown as MCPCallToolResultLike;
    return {
      content: [{ type: "text", text: JSON.stringify(result["toolResult"] ?? result) }],
      isError: result["isError"] === true,
    };
  },
};

const anthropic = new Anthropic();
const model = process.env["CLAUDE_MODEL"]?.trim() || "claude-opus-5";

console.log(`\nmodel: ${model}`);
console.log(`שאלה: ${question}\n${"-".repeat(70)}`);

const runner = anthropic.beta.messages.toolRunner({
  model,
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  system:
    `אתה עוזר לניתוח נתוני מכירות מ-Priority ERP. השתמש תמיד בכלי get_sales; ` +
    `לעולם אל תענה מהזיכרון. סכומים מקובצים לפי מטבע — כל סוג מסמך יכול להיות ` +
    `במטבע זר, אז קרא את שדה currency ואל תחבר מטבעות שונים. netTotal כבר מנכה ` +
    `זיכויים. אם truncated=true אמור שהתוצאות חלקיות. היום ${new Date().toISOString().slice(0, 10)}. ` +
    `ענה בעברית, בקצרה.`,
  tools: mcpTools(tools, caller),
  messages: [{ role: "user", content: question }],
});

let toolCalls = 0;
for await (const message of runner) {
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) console.log(`\n${block.text}`);
    else if (block.type === "tool_use") {
      toolCalls++;
      console.log(`  [כלי] ${block.name} ${JSON.stringify(block.input)}`);
    }
  }
}

const final = await runner.done();
console.log(`\n${"-".repeat(70)}`);
console.log(
  `tool calls: ${toolCalls}   stop_reason: ${final.stop_reason}   ` +
    `tokens in/out: ${final.usage.input_tokens}/${final.usage.output_tokens}`,
);
if (toolCalls === 0) console.log(`WARNING: answered without calling the tool — the data was not read.`);

await mcp.close();
process.exit(0);
