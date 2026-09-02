# PriorityMCP

An MCP server over a live **Priority ERP** installation. It gives an LLM the tools to
find the right screen, learn what its columns mean, and query it — rather than a
hard-coded method per business question.

Ten tools over Priority's OData v4 API, plus a second channel through
`priority-web-sdk` for running Priority programs. Serves both transports: stdio for a
local client, and Streamable HTTP over TLS so clients on other machines can connect.

---

## Why discovery rather than a method per domain

The first version of this server had one curated tool, `get_sales`, built on a
hand-coded map of four invoice screens. Building that map required guessing what each
screen meant, and one of the guesses was wrong: `CINVOICES` was coded as "credit
invoices" and its amounts multiplied by `-1`.

`EFORM.TITLE` on the server says `חשבוניות מרכזות` — **consolidated** invoices. Credit
invoices are a different screen entirely (`SALECREDITINVOICES`, table `CUSTSALES`),
and on that installation it is not exposed to the API at all. Every total produced
from that mapping was wrong, and nothing in the output looked wrong. The database had
held the correct answer the whole time, in a table nobody had queried.

So the design rule here is: **the model asks Priority what things are.** Screen names
are opaque English codes whose meaning lives in a Hebrew title, and inferring one from
the other is exactly the mistake to prevent. `get_sales` still exists but is hidden by
default (`PRIORITY_ENABLE_GET_SALES=1` to expose it) — when it is available the model
reaches for it and never exercises discovery.

---

## Quick start

Requires Node 20+. There is **no build step**: `tsx` runs the TypeScript directly, so
the code in `src/` is the code that runs.

```powershell
npm install
copy .env.example .env      # then fill it in -- every field is documented in place
npm run probe               # verifies the connection and what Priority exposes
npm run server              # stdio, for a local MCP client
```

To serve other machines:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make-cert.ps1   # prints the two .env lines
npm run server:http                                              # HTTPS on :3401
powershell -File scripts/client-kit.ps1                          # a folder to hand to each client
```

As a Windows service (WinSW), so it survives logout and reboot:

```powershell
.\service\install-service.ps1     # as Administrator
```

The service runs `src/http.ts` from this directory, so **deploying a change is
`Restart-Service PriorityMCP`** — no reinstall. Reinstall only when
`service/priority-mcp.xml` itself changes. Run `npm run typecheck` before restarting:
the service retries three times on failure and then stays down, so one syntax error is
an outage.

---

## The tools

| Tool | What it is for |
|---|---|
| `search_screens` | Find a screen from a business concept, in Hebrew or English. Searches an in-memory dictionary; start here. |
| `describe_screen` | Columns with Hebrew titles, keys, types, sub-forms, screen help, and which table each column reads from. `depth` walks child screens. |
| `query` | Read rows. `entity` + `filter`/`select`/`expand`/`orderby`, or a raw `path` for keyed navigation. `explain: true` returns the URL without calling Priority. |
| `aggregate` | Totals, counts and "per X". Computed server-side **here**, by paging — see the `$apply` note below. |
| `column_values` | The distinct values a code column actually holds, with counts. Use before filtering on one. |
| `list_companies` | The configured companies with their real names from the `ENVIRONMENT` screen. |
| `use_company` | Switch the session's company. Changes the data only. |
| `readiness_report` | Where the glossary, examples and dictionary have gaps. |
| `list_programs` | The catalog of runnable programs (`programs.json`). |
| `run_program` | Run one, through the Web SDK. The only tool that can change anything; `PRIORITY_READ_ONLY=1` removes it. |

Clients also receive ~3,100 characters of server-level instructions on `initialize`
(the discovery order, case sensitivity, never summing currencies, how reversals work).
You do not need to write a system prompt for this.

---

## What was measured about this Priority server

These are findings from the live installation, not documentation. Each one shapes the
code, and several are silent failures — the reason the tools do not simply forward
OData:

| Behaviour | Consequence |
|---|---|
| `$top` caps the **total** rows, not the page size | Paging uses `pageSize`. A `top` on a total would truncate it and look complete. |
| `$apply` is **accepted and ignored** | `aggregate` pages the rows and groups them here. A server-side group-by returns ungrouped rows with a 200. |
| `$count` is likewise accepted and ignored | Counts come from paging, not from asking. |
| No `@odata.nextLink` | Paging is driven by `$skip` until a short page arrives. |
| `contains()` and `in` return **501** | Text search over Hebrew titles is client-side, on a cached dictionary. |
| `$select` on the parent **plus** `$expand` truncates the response mid-JSON | The parent `$select` is dropped whenever an expand is present. |
| URL length limits at roughly 50 `or` terms (~25 with an expand) | Filters are chunked. |
| The service document takes ~70 s | Metadata calls get their own 180 s budget, separate from the 45 s query budget. |
| Screen and column names are **case-sensitive**, and ten pairs differ only by case (`DOCUMENTS_E` / `DOCUMENTS_e`) | Names are never case-folded, anywhere. |
| `EXEC/FORMHELP_SUBFORM` is reachable only by a keyed path; `$expand` returns **silently empty** | A negative result from an `$expand` on this server proves nothing on its own. |
| `TABTITLES`, `COLTITLES`, `TITLES`, `COLUMNS`, `FREPORTS`, `PROGDESIGN` → 400; `APPS`/`APP` → 404 | `EFORM` is the only channel for screen titles, and `programs.json` has to be maintained by hand because programs cannot be enumerated. |

The dictionary comes from `EFORM` (~5,800 forms) and is cached on disk for 24 hours,
keyed per installation and **shared across companies** — screen definitions live at the
`tabula.ini` level, so every company on one installation has the same dictionary.

---

## Configuration

Everything is in `.env`, and every setting is documented where it is defined —
see [.env.example](.env.example). The three that decide the shape of a deployment:

- **`PRIORITY_ODATA_URL` + `PRIORITY_ENVIRONMENTS`** — end the URL at the `tabula.ini`
  and list companies to let callers choose one; end it with a company name for a
  single-company server. The list is an allowlist, not a hint: the name goes into a URL
  path, so anything unlisted is refused.
- **`PRIORITY_AUTH_MODE`** — `shared` (one identity from `.env`), `headers` (each caller
  supplies its own), or `elicit` (the client asks its user). Header and elicited
  credentials never enter the model's context, which is why there is no `login()` tool.
- **`PRIORITY_READ_ONLY`** — `1` removes `run_program`, leaving no way to change
  anything. Discovery and read tools are never gated: without them a model cannot learn
  a screen name and goes back to inferring one, which is the failure above.

`MCP_AUTH_TOKEN` is required whenever the listener is not loopback-only. The server
refuses to start without it rather than warning — it holds Priority credentials and
every tool reads live ERP data.

### Connecting a client

```json
{
  "mcpServers": {
    "priority": {
      "type": "http",
      "url": "https://<server>:3401/mcp",
      "headers": {
        "X-Priority-User": "...",
        "X-Priority-Pass": "...",
        "X-Priority-Company": "demo"
      }
    }
  }
}
```

Or `Authorization: Bearer <MCP_AUTH_TOKEN>` to use the server's own identity. Header
credentials require TLS and are refused over plain HTTP. `scripts/client-kit.ps1`
packages the CA and these templates into a folder to hand to each client machine.

On Windows, verifying with `curl` needs `--ssl-revoke-best-effort`: curl there uses
schannel, which requires a revocation source, and a private CA publishes no CRL. The
flag relaxes the revocation check only. Node-based clients do not need it.

---

## Tests

```powershell
npm run typecheck
npm test                          # 8 offline suites -- no server, no Priority
npm run test:live                 # 11 suites against the real installation
npx tsx tests/live.http.ts        # the HTTP transport, as a remote client
npx tsx tests/live.headerauth.ts  # all four accepted and four refused auth paths
```

Live tests need `NODE_EXTRA_CA_CERTS=<repo>\certs\mcp-ca.pem` when TLS is on.

A live suite that cannot reach a resource **skips with a stated reason** rather than
passing quietly — a Priority permission that is closed must not read as a green test.

---

## Layout

```
src/
  server.ts       tool registration, the model-facing instructions
  http.ts         Streamable HTTP transport, TLS, sessions, authentication
  odata.ts        the Priority OData client, EDMX parsing, the quirks above
  dictionary.ts   the EFORM screen dictionary, cache, Hebrew search
  discovery.ts    search_screens / describe_screen / query / column sources
  aggregate.ts    grouping and totals, computed here
  companies.ts    per-company context over one shared dictionary
  auth.ts         shared / headers / elicit
  help.ts         screen help from EXEC/FORMHELP, HTML and {XXXX.T} references
  programs.ts     the priority-web-sdk channel
service/          WinSW wrapper, install / uninstall
scripts/          make-cert.ps1, client-kit.ps1
tests/            *.test.ts offline, live.*.ts against the installation
```

`node_modules` is not in git (336 MB); `package-lock.json` is, so `npm install`
restores what this was verified against. `certs/`, `.env` and
`service/priority-mcp.exe` are also excluded — the repo alone does not reinstall the
service.
