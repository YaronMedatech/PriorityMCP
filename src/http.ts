import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { listEnvironments, loadEnvFile, resolveEnvironment } from "./config.js";
import { buildServer } from "./server.js";
import { UserDirectory } from "./users.js";

// The MCP server over HTTP, so a client on another machine can use these tools.
//
// The stdio entry point in server.ts is per-client-process and inherently local.
// This one listens on the network, which changes the threat model completely:
// the process holds Priority credentials, and every tool reads live ERP data. A
// listener without authentication would hand the whole database to anyone who can
// reach the port, so a token is required rather than encouraged -- see below.

loadEnvFile();

const log = (msg: string) => process.stderr.write(`[priority-http] ${msg}\n`);

const PORT = Number(process.env["MCP_HTTP_PORT"] ?? 3401);
const HOST = process.env["MCP_HTTP_HOST"] ?? "0.0.0.0";
const TOKEN = (process.env["MCP_AUTH_TOKEN"] ?? "").trim();

const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------
// Without this the bearer token crosses the network in a header on every request,
// readable by anything on the segment. That is a defensible trade on a trusted
// LAN for a token that only unlocks this server -- and it stops being defensible
// the moment a caller sends its own PRIORITY PASSWORD, which is why the
// credential headers below refuse to work over plain HTTP.
function readTls(): { pfx?: Buffer; passphrase?: string; cert?: Buffer; key?: Buffer } | null {
  const pfxPath = (process.env["MCP_TLS_PFX"] ?? "").trim();
  const certPath = (process.env["MCP_TLS_CERT"] ?? "").trim();
  const keyPath = (process.env["MCP_TLS_KEY"] ?? "").trim();

  try {
    if (pfxPath) {
      const passphrase = process.env["MCP_TLS_PFX_PASSWORD"] ?? "";
      return { pfx: fs.readFileSync(pfxPath), passphrase };
    }
    if (certPath && keyPath) {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    }
  } catch (err) {
    // Misconfigured TLS must not silently downgrade to plaintext: someone who
    // configured a certificate believes the channel is encrypted.
    log(`refusing to start: TLS is configured but unreadable — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  return null;
}

const tls = readTls();
const scheme = tls ? "https" : "http";

// Refuse rather than warn. A warning on a network listener protecting ERP data is
// something you scroll past once and then forget is there.
if (!TOKEN && !isLoopback) {
  log(
    "refusing to start.\n\n" +
      `MCP_AUTH_TOKEN is not set and this would listen on ${HOST}, which is reachable\n` +
      "from the network. Every tool here reads live Priority data, so an open port is\n" +
      "an open database.\n\n" +
      "Set a token in .env:\n" +
      `  MCP_AUTH_TOKEN=${randomUUID()}\n\n` +
      "Or bind to loopback only with MCP_HTTP_HOST=127.0.0.1 if you meant to tunnel.",
  );
  process.exit(1);
}
if (TOKEN.length > 0 && TOKEN.length < 16) {
  log(`refusing to start: MCP_AUTH_TOKEN is only ${TOKEN.length} characters. Use at least 16.`);
  process.exit(1);
}

/** Constant-time comparison, so a wrong token cannot be found byte by byte. */
function tokenMatches(supplied: string): boolean {
  if (supplied.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

// Per-caller Priority identities, when users.json exists.
const users = new UserDirectory();
for (const w of users.warnings) log(`users.json: ${w}`);
if (users.count > 0) {
  log(`${users.count} caller identit${users.count === 1 ? "y" : "ies"} loaded — each acts as its own Priority user`);
} else {
  log("no users.json — every caller shares the single Priority identity from .env");
}

/** The bearer token on a request, or null. */
function bearer(req: http.IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const [authScheme, value] = header.split(" ");
  if (!value || authScheme?.toLowerCase() !== "bearer") return null;
  return value.trim();
}

interface Caller {
  label: string;
  authHeader: string | null;
  /** Priority company for this session, or null for the server default. */
  company: string | null;
}

/**
 * Which Priority company this caller asked for.
 *
 * Returns the raw header; validation happens in resolveEnvironment, which
 * matches against the configured allowlist. That check is a SECURITY control,
 * not a nicety: the name is concatenated into the OData URL path, the same place
 * `../../tabula.ini,1/demo/CUSTOMERS` once escaped through.
 */
function requestedCompany(req: http.IncomingMessage): string | null {
  const v = req.headers["x-priority-company"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Priority credentials supplied by the caller itself, as HTTP headers.
 *
 * Headers, NOT tool arguments — and that distinction is the whole design. A
 * credential passed as a tool argument is chosen by the model, so it lands in the
 * conversation, in the transcript and in every log that records a tool call. A
 * header is set once in the client's own config file: the model never sees it and
 * cannot echo it back.
 *
 * Refused over plain HTTP. A bearer token crossing a trusted LAN in clear text is
 * a trade; a Priority password crossing it is a different order of exposure, and
 * silently accepting one would defeat the reason for offering this at all.
 */
function callerCredentials(req: http.IncomingMessage, encrypted: boolean): Caller | null | "insecure" {
  const h = (n: string): string | null => {
    const v = req.headers[n];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const user = h("x-priority-user");
  const pass = h("x-priority-pass");
  const pat = h("x-priority-token");
  if (!pat && !(user && pass)) return null;

  if (!encrypted && !isLoopback) return "insecure";

  const authHeader = pat
    ? "Basic " + Buffer.from(`${pat}:PAT`).toString("base64")
    : "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return { label: pat ? "header-pat" : `header:${user}`, authHeader, company: requestedCompany(req) };
}

function authenticate(req: http.IncomingMessage): Caller | null | "insecure" {
  // Caller-supplied Priority credentials take precedence: they are the most
  // specific statement of who is asking.
  const supplied = callerCredentials(req, Boolean(tls));
  if (supplied) return supplied;

  const token = bearer(req);
  if (!token) return TOKEN ? null : { label: "loopback", authHeader: null, company: requestedCompany(req) };

  const known = users.resolve(token);
  if (known) return { label: known.label, authHeader: known.authHeader, company: requestedCompany(req) };

  if (TOKEN && tokenMatches(token)) {
    return { label: "shared-token", authHeader: null, company: requestedCompany(req) };
  }
  return null;
}

// One transport per MCP session, not one shared across every request.
//
// A single long-lived transport looks like the tidy option and does not work: a
// connected StreamableHTTPServerTransport is bound to one client's message
// stream, and feeding a second client's requests through it fails inside
// handleRequest with a bare 500. The protocol carries a session id for exactly
// this reason, so the transport is keyed on it and the initialize request is what
// creates the entry.
interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildServer>;
  lastSeen: number;
}
const sessions = new Map<string, Session>();

// Sessions are reaped on a timer rather than trusted to close themselves.
//
// The client's close() does NOT tell the server anything -- only an explicit
// terminateSession() sends the DELETE, and a client that crashes or drops off the
// network sends nothing at all. Waiting to be told would mean one leaked session,
// holding an McpServer and its dictionary, for every client that ever connected.
const IDLE_MS = Number(process.env["MCP_SESSION_IDLE_MS"] ?? 30 * 60 * 1000);
// Derived rather than fixed, so a short idle window is actually enforceable --
// a hard-coded minute would make any timeout under a minute meaningless.
const SWEEP_MS = Math.min(60_000, Math.max(1_000, Math.floor(IDLE_MS / 2)));

async function openSession(caller: Caller): Promise<StreamableHTTPServerTransport> {
  const server = buildServer({
    ...(caller.authHeader ? { authHeader: caller.authHeader } : {}),
    ...(caller.company ? { company: caller.company } : {}),
    identity: caller.company ? `${caller.label} @ ${caller.company}` : caller.label,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => {
      sessions.set(id, { transport, server, lastSeen: Date.now() });
      log(`session opened (${id.slice(0, 8)}...), ${sessions.size} active`);
    },
  });

  await server.connect(transport);

  // Registered AFTER connect, and chaining to what connect installed. connect()
  // assigns its own transport.onclose, so a handler set before this line is
  // overwritten without complaint and the map grows for the life of the process,
  // one entry per client that ever connected.
  const closeServerSide = transport.onclose;
  transport.onclose = () => {
    closeServerSide?.();
    const id = transport.sessionId;
    if (id && sessions.delete(id)) {
      log(`session closed (${id.slice(0, 8)}...), ${sessions.size} active`);
    }
    void server.close().catch(() => undefined);
  };

  return transport;
}

const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, transport: "streamable-http", auth: TOKEN ? "bearer" : "none" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found. The MCP endpoint is /mcp\n");
    return;
  }

  const caller = authenticate(req);

  if (caller === "insecure") {
    log(`refused plaintext credentials from ${req.socket.remoteAddress ?? "?"}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Priority credentials were sent over an unencrypted connection and have " +
          "been refused. Configure TLS on this server (see scripts/make-cert.ps1) " +
          "and use https:// in the client URL. Treat the credentials you just sent " +
          "as exposed and change them.",
      }),
    );
    return;
  }

  if (!caller) {
    log(`rejected unauthorized ${req.method} from ${req.socket.remoteAddress ?? "?"}`);
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="priority-mcp"',
    });
    res.end(JSON.stringify({ error: "unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>" }));
    return;
  }

  // Body is read here rather than by the transport so the JSON-RPC payload can be
  // handed over already parsed, which is what handleRequest expects. GET (the SSE
  // stream) and DELETE (session teardown) carry no body.
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }

      const sessionId = req.headers["mcp-session-id"];
      let transport: StreamableHTTPServerTransport;

      if (typeof sessionId === "string" && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastSeen = Date.now();
        transport = session.transport;
      } else if (!sessionId && isInitializeRequest(body)) {
        // Validate the company HERE, before buildServer sees it.
        //
        // buildServer treats a ConfigError as fatal and exits the process, which
        // is right for a server started with a broken .env and catastrophically
        // wrong for a per-request value: one caller sending an unknown company
        // header would take the server down for everyone else. So a bad company
        // is answered as this caller's error.
        if (caller.company) {
          try {
            resolveEnvironment(caller.company);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`refused unknown company '${caller.company}' from ${req.socket.remoteAddress ?? "?"}`);
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: message, availableCompanies: listEnvironments() }));
            return;
          }
        }
        log(`session opening for '${caller.label}'`);
        transport = await openSession(caller);
      } else {
        // Either a stale session id (the server restarted while a client kept its
        // id) or a request that skipped initialize. Both are recoverable by the
        // client only if it is told to start over, so say which one it is.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: sessionId
                ? "unknown session id -- the server restarted; reconnect to start a new session"
                : "no session: send an initialize request first",
            },
            id: null,
          }),
        );
        return;
      }

      await transport.handleRequest(req, res, body);
    })().catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });
};

const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);

// unref so an idle sweep never keeps the process alive on its own.
setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      log(`reaping idle session (${id.slice(0, 8)}...)`);
      void session.transport.close().catch(() => undefined);
    }
  }
}, SWEEP_MS).unref();

server.listen(PORT, HOST, () => {
  log(`listening on ${scheme}://${HOST}:${PORT}/mcp  (auth: ${TOKEN ? "bearer token" : "NONE, loopback only"})`);
  const envs = listEnvironments();
  log(
    envs.length > 1
      ? `companies: ${envs.join(", ")} — callers pick one with the X-Priority-Company header (default ${envs[0]})`
      : `company: ${envs[0] ?? "(none configured)"}`,
  );
  if (tls) {
    log("TLS on — callers may send their own Priority credentials in X-Priority-* headers.");
  } else if (!isLoopback) {
    log(
      "NOT ENCRYPTED. The bearer token crosses the network in clear text on every " +
        "request, and caller-supplied Priority credentials are refused. Run " +
        "scripts/make-cert.ps1 to enable TLS.",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    const closing = [...sessions.values()].map((s) => s.server.close().catch(() => undefined));
    void Promise.all(closing).finally(() => process.exit(0));
  });
}
