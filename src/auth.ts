import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Where a session's Priority credentials come from.
//
// Three sources, chosen in .env, because they suit genuinely different setups:
//
//   shared   one identity from .env for everyone. Right for a single operator,
//            and the reason a token-holder currently sees whatever that identity
//            sees.
//   headers  each caller puts its own credentials in its client config. The
//            model never sees them, and they never enter the conversation.
//   elicit   the CLIENT asks the user, at first use, through its own UI.
//
// `elicit` is the only one that lets a person type credentials during a session
// without the model reading them: the answer travels client -> server and never
// enters the model's context. That is the whole reason it exists, and it is why
// a `login(user, password)` TOOL is not offered instead — a tool argument is
// chosen by the model, so it lands in the transcript, in this server's own tool
// log, and in whatever the client sends to the model provider.
//
// NOT EVERY CLIENT SUPPORTS IT. Claude Code and VS Code Copilot do; Claude
// Desktop and Gemini CLI do not — Gemini CLI answers `Method not found`. So the
// mode declares a preference and the fallback decides what happens when the
// preference is unavailable, rather than the session simply failing.

export type AuthMode = "shared" | "headers" | "elicit";
export type AuthFallback = "shared" | "refuse";

export interface AuthPolicy {
  mode: AuthMode;
  fallback: AuthFallback;
}

const MODES: AuthMode[] = ["shared", "headers", "elicit"];

export function loadAuthPolicy(env: NodeJS.ProcessEnv = process.env): AuthPolicy {
  const raw = (env["PRIORITY_AUTH_MODE"] ?? "shared").trim().toLowerCase();
  const mode = (MODES as string[]).includes(raw) ? (raw as AuthMode) : "shared";

  const rawFallback = (env["PRIORITY_AUTH_FALLBACK"] ?? "shared").trim().toLowerCase();
  const fallback: AuthFallback = rawFallback === "refuse" ? "refuse" : "shared";

  return { mode, fallback };
}

/** Basic auth for a PAT: Priority takes the literal string "PAT" as the password. */
export function patHeader(token: string): string {
  return "Basic " + Buffer.from(`${token}:PAT`).toString("base64");
}

export function userHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

export interface ElicitOutcome {
  authHeader?: string;
  /** Present when nothing was obtained; explains what the caller should do. */
  problem?: string;
  /** True when the client cannot do elicitation at all, so retrying is pointless. */
  unsupported?: boolean;
}

/**
 * Ask the USER — through the client — for Priority credentials.
 *
 * The reply goes straight back to this server. It is not part of the
 * conversation, so the model cannot read it, quote it, or include it in a
 * summary, and it never reaches the model provider.
 */
export async function elicitCredentials(
  server: McpServer,
  company: string,
): Promise<ElicitOutcome> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) {
    return {
      unsupported: true,
      problem:
        "This client cannot prompt for credentials (it does not support MCP " +
        "elicitation). Claude Code and VS Code Copilot do; Claude Desktop and " +
        "Gemini CLI do not. Send X-Priority-User/X-Priority-Pass (or " +
        "X-Priority-Token) in the client configuration instead.",
    };
  }

  try {
    const result = await server.server.elicitInput({
      message:
        `Sign in to Priority (company '${company}').\n\n` +
        `These credentials go straight to the MCP server. They are not part of the ` +
        `conversation and are not sent to the AI model.`,
      requestedSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            title: "Priority username",
            description: "Leave blank if you are using a Personal Access Token below.",
          },
          password: {
            type: "string",
            title: "Password",
            description: "Your Priority password.",
          },
          token: {
            type: "string",
            title: "Personal Access Token (instead of username/password)",
            description: "Preferred: revocable and scoped. If set, it wins over the username.",
          },
        },
        required: [],
      },
    });

    if (result.action !== "accept" || !result.content) {
      return {
        problem:
          result.action === "decline"
            ? "You declined to provide Priority credentials, so nothing can be read."
            : "The credential prompt was cancelled, so nothing can be read.",
      };
    }

    const c = result.content as Record<string, unknown>;
    const token = typeof c["token"] === "string" ? c["token"].trim() : "";
    const username = typeof c["username"] === "string" ? c["username"].trim() : "";
    const password = typeof c["password"] === "string" ? c["password"].trim() : "";

    if (token) return { authHeader: patHeader(token) };
    if (username && password) return { authHeader: userHeader(username, password) };

    return {
      problem:
        "No credentials were entered. Provide either a Personal Access Token, or " +
        "both a username and a password.",
    };
  } catch (err) {
    // A client that advertises the capability but answers "Method not found" is
    // a real case (Gemini CLI has shipped that combination), so a throw here is
    // treated as "unsupported" rather than as a broken session.
    const message = err instanceof Error ? err.message : String(err);
    return {
      unsupported: true,
      problem:
        `This client did not answer the credential prompt (${message.slice(0, 120)}). ` +
        `Send X-Priority-User/X-Priority-Pass in the client configuration instead.`,
    };
  }
}
