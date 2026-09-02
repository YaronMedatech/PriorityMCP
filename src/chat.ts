import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  mcpTools,
  type MCPCallToolResultLike,
  type MCPClientLike,
} from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnvFile } from "./config.js";
import { systemPrompt } from "./prompt.js";

// The chat client reads CLAUDE_MODEL and the Anthropic credentials from .env
// too, so it has to load the file itself -- the MCP server is a separate process
// and loading it there does nothing for this one.
loadEnvFile();

// A terminal chat that talks to Claude, with the MCP server wired in as a tool.
// This exists to test the LLM -> MCP -> Priority chain end to end in free-form
// Hebrew, not to be a product.

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Adapts an MCP `Client` to the shape `mcpTools()` expects.
 *
 * `Client.callTool()` returns a union: the current `{ content: [...] }` result,
 * or the legacy `{ toolResult: unknown }` shape that predates content blocks and
 * carries no `content` at all. The Anthropic helper only accepts the former, so
 * rather than assert the difference away, fold the legacy shape into a text
 * block — a server still speaking it stays usable instead of failing at runtime
 * on an undefined `content`.
 */
function asAnthropicToolCaller(mcp: Client): MCPClientLike {
  return {
    async callTool(params): Promise<MCPCallToolResultLike> {
      const result = await mcp.callTool(params);
      if (Array.isArray(result["content"])) {
        return result as unknown as MCPCallToolResultLike;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result["toolResult"] ?? result) }],
        isError: result["isError"] === true,
      };
    },
  };
}

const SYSTEM_PROMPT = systemPrompt();

async function main(): Promise<void> {
  const anthropic = new Anthropic();
  const model = process.env["CLAUDE_MODEL"]?.trim() || "claude-opus-5";

  // Spawn the MCP server as a child process and speak JSON-RPC over its stdio.
  // Its stderr is inherited so its diagnostics land in this terminal.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(HERE, "server.ts")],
    stderr: "inherit",
  });

  const mcp = new Client({ name: "priority-chat", version: "0.1.0" });
  await mcp.connect(transport);

  const { tools } = await mcp.listTools();
  console.log(`\nמחובר ל-MCP. כלים זמינים: ${tools.map((t) => t.name).join(", ")}`);
  console.log(`מודל: ${model}`);
  console.log(`הקלד שאלה בעברית, או "exit" ליציאה.\n`);

  const runnableTools = mcpTools(tools, asAnthropicToolCaller(mcp));
  const messages: Anthropic.Beta.BetaMessageParam[] = [];

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    for (;;) {
      let question: string;
      try {
        question = (await rl.question("> ")).trim();
      } catch {
        // stdin closed -- Ctrl+C, Ctrl+D, or piped input running out. readline
        // rejects rather than returning, so without this the natural way to
        // leave a REPL ends in an ERR_USE_AFTER_CLOSE stack trace.
        console.log();
        break;
      }
      if (!question) continue;
      if (["exit", "quit", "יציאה"].includes(question.toLowerCase())) break;

      messages.push({ role: "user", content: question });

      try {
        const runner = anthropic.beta.messages.toolRunner({
          model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: SYSTEM_PROMPT,
          tools: runnableTools,
          messages,
        });

        // Each iteration is one assistant turn. Surfacing the tool calls makes
        // it obvious whether Claude actually queried Priority or answered from
        // its own head — which is the entire point of this harness.
        for await (const message of runner) {
          for (const block of message.content) {
            if (block.type === "text" && block.text.trim()) {
              console.log(`\n${block.text}\n`);
            } else if (block.type === "tool_use") {
              console.log(`  [כלי] ${block.name} ${JSON.stringify(block.input)}`);
            }
          }
        }

        // The runner keeps its own copy of the history; mirror it back so the
        // next question continues the same conversation.
        const final = await runner.done();
        messages.push(...runner.params.messages.slice(messages.length));
        void final;
      } catch (err) {
        console.error(`\nשגיאה: ${err instanceof Error ? err.message : String(err)}\n`);
        // Drop the failed turn so the next question starts from a valid history.
        messages.length = messages.findLastIndex((m) => m.role === "user");
      }
    }
  } finally {
    rl.close();
    await mcp.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
