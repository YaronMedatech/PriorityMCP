import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
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

// A local web chat over the same MCP server the CLI uses. Exists so the tool can
// be exercised in free-form Hebrew from a browser instead of a terminal.
//
// Deliberately local-only: it holds the Anthropic key and Priority credentials in
// process, so it binds to 127.0.0.1 and is not something to expose on a network.

loadEnvFile();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env["WEB_PORT"] ?? 3400);
const MODEL = process.env["CLAUDE_MODEL"]?.trim() || "claude-opus-5";

const SYSTEM_PROMPT = systemPrompt();

/** Adapts MCP's callTool union to the shape mcpTools() accepts. See chat.ts. */
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

async function main(): Promise<void> {
  // One MCP server process, shared by every browser session.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(HERE, "server.ts"),
    ],
    stderr: "inherit",
  });
  const mcp = new Client({ name: "priority-web", version: "0.1.0" });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  const runnableTools = mcpTools(tools, asAnthropicToolCaller(mcp));

  const anthropic = new Anthropic();

  // Conversation history per browser session, so follow-up questions work.
  const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, "public"),
    prefix: "/",
  });
  // The markdown + sanitiser browser builds, served from node_modules so the page
  // needs no CDN -- this machine cannot reach the npm registry, let alone a CDN.
  await app.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, "node_modules", "marked", "lib"),
    prefix: "/vendor/marked/",
    decorateReply: false,
  });
  await app.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, "node_modules", "dompurify", "dist"),
    prefix: "/vendor/dompurify/",
    decorateReply: false,
  });

  app.get("/api/meta", async () => ({
    model: MODEL,
    tools: tools.map((t) => t.name),
  }));

  app.post<{ Body: { sessionId?: string; message?: string } }>("/api/chat", async (req, reply) => {
    const message = (req.body?.message ?? "").trim();
    const sessionId = req.body?.sessionId ?? "default";
    if (!message) {
      return reply.code(400).send({ error: "message is required" });
    }

    const history = sessions.get(sessionId) ?? [];
    history.push({ role: "user", content: message });
    sessions.set(sessionId, history);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Streamed responses are useless if a proxy buffers them.
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const runner = anthropic.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        tools: runnableTools,
        messages: history,
        stream: true,
      });

      for await (const stream of runner) {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send("delta", { text: event.delta.text });
          }
        }
        // Tool calls are announced once the turn resolves: their arguments arrive
        // as partial JSON fragments while streaming, which are not worth showing
        // half-formed.
        const finished = await stream.finalMessage();
        for (const block of finished.content) {
          if (block.type === "tool_use") {
            send("tool", { name: block.name, input: block.input });
          }
        }
        send("turn_end", {});
      }

      const final = await runner.done();
      // The runner keeps its own copy of the history; adopt it so the next
      // question in this session continues the same conversation.
      sessions.set(sessionId, [...runner.params.messages]);
      send("done", {
        stopReason: final.stop_reason,
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[priority-web] chat error: ${detail}\n`);
      send("error", { message: detail });
      // Drop the failed turn so the session is not poisoned for the next one.
      const trimmed = sessions.get(sessionId) ?? [];
      const lastUser = trimmed.findLastIndex((m) => m.role === "user");
      if (lastUser >= 0) sessions.set(sessionId, trimmed.slice(0, lastUser));
    } finally {
      reply.raw.end();
    }
  });

  app.post<{ Body: { sessionId?: string } }>("/api/reset", async (req) => {
    sessions.delete(req.body?.sessionId ?? "default");
    return { ok: true };
  });

  // Loopback only. This process holds the Anthropic key and the Priority
  // credentials, and the page has no authentication of its own.
  await app.listen({ port: PORT, host: "127.0.0.1" });
  process.stderr.write(
    `\n[priority-web] http://localhost:${PORT}  (model: ${MODEL}, tools: ${tools
      .map((t) => t.name)
      .join(", ")})\n\n`,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await mcp.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
