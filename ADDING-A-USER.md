# Adding a user

What to do on the server, and what to do on the person's machine, to give someone
access to Priority through this MCP server.

`README.md` is the reference and `CLAUDE.md` is the operating guide. This is the
runbook for the one task an operator repeats.

---

## First: which identity model is in force

This decides whether there is a server step at all, so check before anything else.

```powershell
Test-Path C:\PriorityMCP\users.json
```

| | **False — shared identity** | **True — per-caller identity** |
|---|---|---|
| Server step | none | add a row to `users.json` |
| What the client config holds | the person's Priority **username and password** | a random **token**, no password |
| Who Priority thinks is asking | that person | that person |
| Revoking one person | change their Priority password | delete their row |

Both give each person their own Priority permissions. The difference is where the
password lives: on every laptop, or once on the server.

**Prefer per-caller.** A password in a config file is copied, backed up and
mailed around; a token is revocable on its own and is worth nothing anywhere
else. Turning it on is `users.example.json` → `users.json` and a restart.

---

## Part A — the server, once per person

Skip this entirely if `users.json` does not exist. In shared mode there is
nothing to do on the server: a new person needs no server change at all.

**A1. Generate a token.** On the server, or anywhere:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

Under 16 characters is rejected at startup with a warning rather than accepted,
so do not shorten it.

**A2. Add the row.** Edit `C:\PriorityMCP\users.json`:

```json
{
  "users": [
    {
      "token": "the-token-from-A1",
      "label": "sivan-laptop",
      "priorityUser": "SIVAN_PRIORITY_USERNAME",
      "priorityPass": "SIVAN_PRIORITY_PASSWORD"
    }
  ]
}
```

`label` is what appears in the server log against every call that person makes.
It must never be a secret — it is written to `service\logs\` in clear.

A Personal Access Token works instead of the password, and is better where
Priority offers one: replace both `priorityUser` and `priorityPass` with
`"priorityToken": "..."`.

**A3. Restart and confirm the count.**

```powershell
Restart-Service PriorityMCP
Get-Content C:\PriorityMCP\service\logs\priority-mcp.err.log -Tail 20
```

Look for the line naming how many identities loaded. An entry with a short,
duplicate or credential-less token is **skipped with a warning**, not accepted —
so a count lower than expected means one of yours was rejected, and the warning
says which.

**A4. Never commit it.** `users.json` is gitignored because it holds credentials.
Check with `git status` if you edited it inside the checkout.

---

## Part B — the person's machine

Three steps, in this order. The order is the point: each one is verifiable on its
own, so a failure names itself instead of being hunted in the wrong place.

### B1. Trust the certificate

Node does **not** read the Windows certificate store, and every one of these
clients runs on Node. Importing the certificate into Windows, or issuing one from
the domain CA, does not help them. `NODE_EXTRA_CA_CERTS` is what works.

Paste the block from the operator (the one that writes `C:\priority-mcp\mcp-ca.pem`
and sets `NODE_EXTRA_CA_CERTS`). No administrator rights are needed.

### B2. Verify before configuring anything

```powershell
curl --cacert C:\priority-mcp\mcp-ca.pem --ssl-revoke-best-effort https://192.168.50.12:3401/health
```

Expect `{"ok":true,"transport":"streamable-http","auth":"bearer"}`.

Read the failure rather than moving on:

| What you see | What it means |
|---|---|
| a certificate error | B1 did not take. Re-check the thumbprint |
| a timeout | routing or firewall. The server allows inbound 3401 on the **Domain and Private** profiles only |
| connection refused | the server is down. `Get-Service PriorityMCP` on TATINT |

**Never add `-k` or `--insecure` to get past this.** They accept any server
claiming that address, which is the one thing the certificate prevents.
`--ssl-revoke-best-effort` is not that: curl on Windows uses schannel, which
insists on a revocation source, and a private CA publishes no CRL. The signature
and the host name are still checked.

### B3. Configure the client

Pick the section for the client the person actually uses. In every one, the
credentials block is one of these two, matching the model from the top of this
file:

```jsonc
// shared identity — the person's own Priority credentials
"headers": { "X-Priority-User": "...", "X-Priority-Pass": "..." }

// per-caller identity — the token from A1, no password
"headers": { "Authorization": "Bearer ..." }
```

---

## Claude Code

**Verified working.**

A file named `.mcp.json` in the root of the folder they open:

```json
{
  "mcpServers": {
    "priority": {
      "type": "http",
      "url": "https://192.168.50.12:3401/mcp",
      "headers": {
        "X-Priority-User": "...",
        "X-Priority-Pass": "..."
      }
    }
  }
}
```

Then restart the terminal or VS Code **completely** — not a window reload — and
run `/mcp`. A project-scoped server asks for approval the first time. Thirteen
tools should appear.

> **The trap that costs an hour:** Windows Explorer hides known extensions, so
> renaming a text file to `.mcp.json` actually produces `.mcp.json.txt`, and
> Claude Code never sees it. Check with `Get-ChildItem <folder> -Force`.

## Claude Desktop

**Partly unverified — read the caveat.**

Settings → **Developer** → Edit Config. Not "Connectors"; older builds have no
such tab. It opens `%APPDATA%\Claude\claude_desktop_config.json`.

That file already has content. **Add** `mcpServers` alongside it — do not paste
over the file, or the person loses their preferences:

```json
{
  "coworkUserFilesPath": "...",
  "preferences": { },
  "mcpServers": {
    "priority": {
      "type": "http",
      "url": "https://192.168.50.12:3401/mcp",
      "headers": { "X-Priority-User": "...", "X-Priority-Pass": "..." }
    }
  }
}
```

Mind the comma after the `}` that closes `preferences`. Without it the JSON is
invalid and Claude Desktop ignores the whole file **silently** — including the
person's own settings, which is how a broken paste looks like the app resetting
itself.

Quit completely and reopen. Not minimise.

> **Caveat:** whether this build accepts `type: "http"` in that file is not
> confirmed. Claude Desktop historically configured **stdio** servers only. If
> the server does not appear after a full restart, that is the answer, and the
> fallback is an `mcp-remote` bridge — which needs Node on that machine and is
> written up separately when someone first needs it.
>
> Claude Desktop also does **not** support MCP elicitation (`src/auth.ts`), so
> `PRIORITY_AUTH_MODE=elicit` would not prompt there. With
> `PRIORITY_AUTH_FALLBACK=shared` it would quietly fall back to the server's own
> identity instead — the person would silently get someone else's permissions.

## VS Code Copilot

**Unverified here.** Use the command, not a hand-written file: Command Palette →
**`MCP: Add Server`** → HTTP → the URL. VS Code writes the file itself, which
avoids guessing at a schema that has changed between versions.

Copilot **does** support elicitation, so it is the client to test with if
per-session prompting is ever adopted.

## Gemini CLI

**Template shipped by `scripts/client-kit.ps1`, not verified end to end here.**

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "priority": {
      "httpUrl": "https://192.168.50.12:3401/mcp",
      "headers": { "X-Priority-User": "...", "X-Priority-Pass": "..." },
      "timeout": 120000,
      "trust": false,
      "excludeTools": ["run_program"]
    }
  }
}
```

Note `httpUrl`, not `url`. Gemini CLI does not support elicitation either, and
answers `Method not found` if asked.

---

## What the person gets, and what to think about first

Thirteen tools. Ten read, three run Priority programs.

`PRIORITY_ALLOW_ALL_PROGRAMS=1` is set on this server, which means **any** of the
installation's ~9,200 procedures and reports may be run — including ones that
post, delete and upgrade. For someone who only needs to ask questions, exclude
them in that person's own config:

```json
"excludeTools": ["run_program", "start_program", "continue_program"]
```

Or take it away for everyone with `PRIORITY_READ_ONLY=1` in the server's `.env`,
which removes those three from the tool list entirely rather than hiding them
from one client.

Discovery and read tools are never gated, deliberately: without them a model
cannot learn a screen name and goes back to inferring one from an English code,
which is the failure this whole server exists to prevent.

---

## Removing a person

**Per-caller identity:** delete their row from `users.json` and restart. Their
token stops working immediately and nothing else is affected.

**Shared identity:** there is no server-side revocation — their config holds
their own Priority password, so the answer is a Priority password change. This
asymmetry is the strongest argument for adopting `users.json` before the number
of people grows.

Either way, `MCP_AUTH_TOKEN` in `.env` is a separate key that grants the
server's own identity. Anyone holding it has access regardless of `users.json`,
so treat it as an administrative credential rather than something to hand out.
