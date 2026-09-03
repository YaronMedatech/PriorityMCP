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
| `search_screens` | Find a screen from a business concept, in Hebrew or English. Searches an in-memory dictionary; start here. `kinds: ['P','R']` searches the 9,000+ procedures and reports by title too, marking which the catalog allows to run. |
| `describe_screen` | Columns with Hebrew titles, keys, types, sub-forms, screen help, and which table each column reads from. `depth` walks child screens; `includeColumnHelp` adds per-column help. |
| `help` | Priority's own help for a screen, report, procedure, interface or menu — or for one column. The way to learn what a program DOES before running it. A permission refusal is reported as such, never as "no help". |
| `query` | Read rows. `entity` + `filter`/`select`/`expand`/`orderby`, or a raw `path` for keyed navigation. `explain: true` returns the URL without calling Priority. |
| `aggregate` | Totals, counts and "per X". Computed server-side **here**, by paging — see the `$apply` note below. |
| `column_values` | The distinct values a code column actually holds, with counts. Use before filtering on one. |
| `list_companies` | The configured companies with their real names from the `ENVIRONMENT` screen. |
| `use_company` | Switch the session's company. Changes the data only. |
| `readiness_report` | Where the glossary, examples and dictionary have gaps. |
| `list_programs` | The catalog of runnable programs (`programs.json`). |
| `run_program` | Run one to completion, through the Web SDK. Stops with `needs_choice` rather than picking an option itself. `PRIORITY_READ_ONLY=1` removes it and the two below. |
| `start_program` / `continue_program` | The same programs as an interactive session: `input`, `choose`, `message`, `askprint`, `displayurl`, `end` — the vocabulary Priority's own MCP uses. Every decision goes back to the user; an idle session is cancelled after 5 minutes. |
| `list_skills` / `get_skill` | AI skills written inside Priority (`AIWORKFLOWS`, "AI סקילז"), listed and read in full. **Off by default** (`PRIORITY_ENABLE_SKILLS=1`): deferred, and the screen is not API-enabled on the reference installation. |

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
| `in` is refused (**HTTP 403**); `contains()`, `startswith()`, `endswith()` work — re-measured 2026-09-02 on `t.eu.priority-connect.online`; an earlier installation answered **501** to `contains()` | Filters use chained `or`. Screen-title search stays client-side anyway, for ranking and Hebrew stemming. |
| A `$filter` / `$orderby` **inside** `$expand` is honoured | `query`'s `expand` can carry per-child filters: `ITEMS_SUBFORM($filter=KLINE gt 1;$orderby=KLINE desc)`. |
| `$select` on the parent **plus** `$expand` truncates the response mid-JSON | The parent `$select` is dropped whenever an expand is present. |
| URL length limits at roughly 50 `or` terms (~25 with an expand) | Filters are chunked. |
| The service document takes ~70 s | Metadata calls get their own 180 s budget, separate from the 45 s query budget. |
| Screen and column names are **case-sensitive**, and ten pairs differ only by case (`DOCUMENTS_E` / `DOCUMENTS_e`) | Names are never case-folded, anywhere. |
| `EXEC/FORMHELP_SUBFORM` is reachable only by a keyed path; `$expand` returns **silently empty** | A negative result from an `$expand` on this server proves nothing on its own. |
| `EXEC/FORMHELP_SUBFORM` answers **403** for screens, reports and procedures alike, while `EFORM(…)/FCLMN_SUBFORM(NAME=…)/FCLMNHELP_SUBFORM` returns text | Screen help and column help are permitted separately in Priority. `help` and `describe_screen` report a 403 as a permission, not as absent help. FCLMN's key is `NAME`. |
| `EXEC` lists every entity with its title: 9,229 procedures and reports (P=4,806, R=4,423), all titled, fetched in ~6 s | It is the source for searching programs, since `PROGDESIGN`/`FREPORTS` are closed. |
| `AIWORKFLOWS` ("AI סקילז") is in the service document yet answers **400 "לא ניתן להפעיל API למסך זה"** in every company | Skills exist as a feature; reading them needs the screen opened for the API or the API user given the "תחזוקת מערכת" module. `list_skills` says so. |
| On Priority's cloud the Web SDK URL is **`https://<host>/wcf/service.svc`** (one `wcf`, per Priority's SDK docs), not the `<host>/wcf/wcf/Service.svc` the SDK derives from a host root — that one answers **403**. The **PAT logs in** as `username=<token>, password='PAT'`; the named user was refused. | `loadWebSdkConfig` derives the cloud URL for `*.priority-connect.online` and prefers the PAT, so OData and programs act as one identity. Measured end to end: `FORMTRIGREP(ORDERS)` returned 60,000 characters of trigger source. |
| The cloud web UI itself authenticates with **OIDC** (`<host>/auth/`, scope `wcf_api`) and no password grant exists; Basic user/password on OData answers **401** for a valid web user. | Per-caller identities on the cloud are PATs (`X-Priority-Token`), not passwords. The SDK also accepts an OIDC `accessToken` (`oidc_jwt`) should a client credential ever be issued. |
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
- **`PRIORITY_HOSTING`** — `cloud` or `self-hosted`; detected from the host name when
  empty and stated in the startup log. It decides how the Web SDK is reached
  (`https://<host>/wcf/service.svc` on the cloud, the host root elsewhere) and which
  identity is tried first (PAT on the cloud, the named user elsewhere). Pin it when one
  `.env` serves several installations.
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

## Deploying to another server

The repository is the whole application: there is no build, so a clone plus
`npm ci` is a running server. Four things are deliberately **not** in git and have
to exist on the new machine.

```powershell
git clone https://github.com/<you>/PriorityMCP.git
cd PriorityMCP
npm ci                                  # package-lock.json pins what this was verified against
copy .env.example .env                  # then fill it in -- every setting is documented in place
npm run probe                           # first proof: credentials and connectivity
```

| Not in git | What to do on the new server | Why it is excluded |
|---|---|---|
| `.env` | Copy `.env.example` and fill it in. Set **`PRIORITY_HOSTING`** for that installation. | Holds the PAT, the password and the bearer token. |
| `certs/` | `powershell -ExecutionPolicy Bypass -File scripts/make-cert.ps1` — **regenerate, do not copy**. | The certificate names the machine it was made on; another server's name and IP are not in it, so a copied one fails host verification. |
| `service/priority-mcp.exe` | Download WinSW (`WinSW-x64.exe`) and save it under that name, or copy it across. | A third-party binary; `service/*.exe` keeps binaries out of history. |
| `node_modules/` | `npm ci`. | 336 MB. |

Everything else regenerates: the dictionary cache refetches on first use (~20 s),
`client-kit/` comes from `scripts/client-kit.ps1`, and `service/logs/` is created by
the service.

Then install it as a service, exactly as above. `service/priority-mcp.xml` needs no
editing — its paths use WinSW's `%BASE%`, so they follow the checkout. The one line
to check is `<executable>`: it points at `C:\Program Files\nodejs\node.exe`, the
default install location.

Per-installation settings worth a second look before starting: `PRIORITY_HOSTING`,
`PRIORITY_ODATA_URL` + `PRIORITY_ENVIRONMENTS`, `PRIORITY_READ_ONLY`, and a **new**
`MCP_AUTH_TOKEN` — a token shared between two servers means one leak exposes both.

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
