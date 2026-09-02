import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Per-caller Priority identities.
//
// Without this the whole server runs as ONE Priority user: everyone holding the
// bearer token sees exactly what that user sees, with no separation between
// callers. That was a theoretical concern while the listener was loopback-only
// and became a real one the moment a second machine on the LAN connected —
// Priority's own permissions are the only access control in the stack, and a
// single shared identity flattens them.
//
// Oracle's NL2SQL MCP server inherits the caller's identity, roles and row-level
// policies so the same enforcement applies through every channel. This is the
// same principle at the scale this server needs: each caller gets their own
// token, each token maps to a real Priority user, and every query that caller
// makes runs with that user's permissions.
//
// The file is OPTIONAL. Without it the server keeps its previous single-identity
// behaviour, which is correct for a local, single-operator setup.

export interface McpUser {
  /** Bearer token this caller presents. Must be unique and at least 16 chars. */
  token: string;
  /** Human label for the logs. Never a secret. */
  label: string;
  /** Priority username this caller acts as. */
  priorityUser?: string;
  priorityPass?: string;
  /** Or a Personal Access Token instead of user/pass. */
  priorityToken?: string;
}

export interface ResolvedUser {
  label: string;
  /** Ready-to-send Authorization header for Priority, or null to use .env. */
  authHeader: string | null;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usersPath(): string {
  const configured = (process.env["MCP_USERS_FILE"] ?? "").trim();
  if (!configured) return path.join(PROJECT_ROOT, "users.json");
  return path.isAbsolute(configured) ? configured : path.join(PROJECT_ROOT, configured);
}

/** Constant-time compare, so a token cannot be discovered byte by byte. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class UserDirectory {
  private users: McpUser[] = [];
  private loaded = false;
  private problems: string[] = [];

  private ensure(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = usersPath();
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { users?: McpUser[] };
      const seen = new Set<string>();
      for (const u of parsed.users ?? []) {
        if (!u.token || !u.label) {
          this.problems.push("an entry is missing token or label — skipped");
          continue;
        }
        // Refuse rather than accept: a short token on a network listener is the
        // kind of weakness that is never revisited once it works.
        if (u.token.length < 16) {
          this.problems.push(`'${u.label}' has a token under 16 characters — skipped`);
          continue;
        }
        if (seen.has(u.token)) {
          this.problems.push(`'${u.label}' reuses another entry's token — skipped`);
          continue;
        }
        if (!u.priorityToken && !(u.priorityUser && u.priorityPass)) {
          this.problems.push(`'${u.label}' has no Priority credentials — skipped`);
          continue;
        }
        seen.add(u.token);
        this.users.push(u);
      }
    } catch (err) {
      this.problems.push(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get count(): number {
    this.ensure();
    return this.users.length;
  }

  get warnings(): string[] {
    this.ensure();
    return this.problems;
  }

  /** The caller behind a bearer token, or null if the directory does not know it. */
  resolve(token: string): ResolvedUser | null {
    this.ensure();
    for (const u of this.users) {
      if (!tokensMatch(u.token, token)) continue;
      const authHeader = u.priorityToken
        ? "Basic " + Buffer.from(`${u.priorityToken}:PAT`).toString("base64")
        : "Basic " + Buffer.from(`${u.priorityUser}:${u.priorityPass}`).toString("base64");
      return { label: u.label, authHeader };
    }
    return null;
  }
}
