# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server over a live **Priority ERP** installation, in TypeScript. Thirteen tools
over Priority's OData v4 API plus a second channel through `priority-web-sdk` for
running Priority programs. Two transports, one tool set.

`README.md` is the reference document and is kept current — the full table of measured
Priority behaviours lives there. This file is the operating guide.

## Commands

There is **no build step**. `tsx` runs the TypeScript directly, so the code in `src/`
is the code that runs.

```powershell
npm run typecheck                 # tsc --noEmit. Run this before restarting the service.
npm test                          # 16 offline suites -- no server, no Priority
npm run test:live                 # 15 suites against the real installation
npx tsx tests/live.http.ts        # the HTTP transport, as a remote client
npx tsx tests/live.headerauth.ts  # all four accepted and four refused auth paths

npm run probe                     # verify connectivity and what Priority exposes
npm run server                    # stdio, for a local MCP client
npm run server:http               # HTTPS on :3401
npm run chat                      # CLI chat client (Anthropic + MCP), free-text Hebrew
npm run web                       # browser chat on 127.0.0.1:3400
npm run inspector                 # MCP inspector against the stdio server
```

Every test is a plain `tsx` script that counts its own failures — **run a single suite
with `npx tsx tests/<name>.test.ts`**. There is no test runner and no filtering flag.

Live tests need `NODE_EXTRA_CA_CERTS=<repo>\certs\mcp-ca.pem` when TLS is on. A live
suite that cannot reach a resource **skips with a stated reason** rather than passing
quietly — a closed Priority permission must not read as a green test. Preserve that
when adding one.

### Deploying

The server runs as a Windows service (WinSW) from this directory, so **deploying a
change is `Restart-Service PriorityMCP`** — no reinstall. Reinstall only when
`service/priority-mcp.xml` itself changes. Run `npm run typecheck` first: the service
retries three times on failure and then stays down, so one syntax error is an outage.
Logs are in `service/logs/`.

## The design rule

The first version had one curated tool built on a hand-coded map of four invoice
screens. One guess in that map was wrong — `CINVOICES` was coded as "credit invoices"
and its amounts multiplied by `-1`, while `EFORM.TITLE` says `חשבוניות מרכזות`
(**consolidated** invoices). Every total was wrong and nothing in the output looked
wrong.

So: **the model asks Priority what things are.** Screen names are opaque English codes
whose meaning lives in a Hebrew title, and inferring one from the other is the mistake
this server exists to prevent. `get_sales` still exists but is hidden by default
(`PRIORITY_ENABLE_GET_SALES=1`) — when it is available the model reaches for it and
never exercises discovery.

The corollary shows up in almost every recent commit: **a reply must distinguish causes
that call for opposite responses.** 403 (permission) vs 404 (nothing recorded) vs empty
(wrong name); a caller's bad argument (`CallerError`) vs a Priority failure; "the report
failed" vs "the report ran and was empty" (`status: 'no_data'`). Collapsing two of those
into one message is the bug class here, not a wording preference.

## Architecture

```
src/
  server.ts       buildServer(): tool registration + the model-facing instructions
  http.ts         Streamable HTTP transport, TLS, sessions, authentication
  odata.ts        the Priority OData client, EDMX parsing, the measured quirks
  dictionary.ts   the EFORM/EXEC dictionary, disk cache, Hebrew search and ranking
  discovery.ts    search_screens / describe_screen / query / column sources
  aggregate.ts    grouping and totals, computed here
  companies.ts    per-company context over one shared dictionary
  auth.ts         shared / headers / elicit
  help.ts         per-kind help routes, HTML cleaning, {XXXX.T} references
  programs.ts     the priority-web-sdk channel, one-call and session
  programselect.ts  which programs may be run, and name -> program
```

Load-bearing structure:

- **`buildServer()` in `server.ts` is the single tool registration.** Both the stdio
  entry point and `http.ts` call it, so the two transports cannot drift. Register a tool
  once, there.
- **`stdout` IS the protocol channel** for stdio. A stray `console.log` corrupts the
  JSON-RPC stream and the client disconnects with a parse error pointing nowhere near
  the cause. Every diagnostic goes to stderr, through the local `log()`.
- **`CompanyContext` holds the active company, read at CALL time.** That is what makes
  `use_company` take effect for everything already registered. Per company: the OData
  client and the program runner. **Shared: the dictionary** — screen definitions live at
  the `tabula.ini` level, so every company on one installation has the same forms.
  Switching company changes the DATA and nothing else. The disk cache is keyed on the
  installation base URL for the same reason.
- **Two channels, forced by Priority rather than chosen.** OData cannot run a program;
  the Web SDK needs its own identity and URL. `loadWebSdkConfig()` is deliberately
  separate from `loadConfig()` so a missing SDK setting disables one tool instead of
  failing startup.
- **Per-session request budget** (`ratelimit.ts`, `PRIORITY_MAX_REQUESTS_PER_MIN`).
  Every other limit bounds a single call; this bounds the calls, because `aggregate`
  over 50,000 rows is hundreds of sequential requests.

## Invariants worth knowing before editing

These are measured against the live installation, not documentation. The full list is
in `README.md`; these are the ones that break code silently.

- **Screen and column names are case-sensitive**, and ten pairs differ only by case
  (`DOCUMENTS_E` / `DOCUMENTS_e`). Never case-fold a screen name anywhere. Program names
  *are* case-insensitive — that asymmetry is real.
- **`$apply` and `$count` are accepted and silently ignored**, and there is no
  `@odata.nextLink`. So aggregation is done here while paging, a short page is the only
  end-of-data signal, and there is no row total available at all. `$top` caps the
  **total** rows, not the page size. `$orderby` is ignored by some screens.
- **The result ceilings are configurable and the tool descriptions quote them.**
  `LIMITS` in `discovery.ts` is read once at module load, because `rowsPerQuery`
  becomes a zod `.max()` that clients cache for the session. If you change what a
  ceiling does, change the description in the same edit — `tests/limits.test.ts`
  asserts the number in the prose matches the one in the schema, because a
  description saying "capped at 500" on a server configured otherwise is a false
  statement placed directly in the model's system prompt.
- **A parent `$select` plus `$expand` truncates the response mid-JSON.** The select is
  dropped whenever an expand is present, with a note in the reply. A nested `$select`
  inside the expand is safe.
- **`in` is refused (HTTP 403)**; `contains()`/`startswith()`/`endswith()` work. Filters
  use chained `or`, chunked at ~50 terms (~25 alongside an expand) because of URL length.
- **Help lives under each kind's own generator screen**, all keyed `(ENAME, TYPE)`:
  `EFORM`/`EREP`/`EPROG`/`EMENU`. A single-key path answers 400. `$expand` on a help
  sub-form is accepted and returns nothing — only the keyed path returns text, so a
  negative result from an expand here proves nothing. And the statuses are **inverted**:
  an entity that exists with no help answers 404 (an answer), a name that does not exist
  answers 200 with zero rows.
- **A program the model may see is one a Priority USER can reach.** EREP's
  `REPMENU`/`REPPROG`/`REPDOC` and EPROG's `PROGMENU`/`PROGPROG` say how; linked from
  none of them, nobody can run it from the UI, and `search_screens` hides it. The
  third state is the one to protect: `reachableFrom: undefined` means EREP/EPROG
  could not be READ, and treating that as "unreachable" would hide every program on
  an installation that keeps those screens closed — which is the state this one was
  in until an operator opened them.
- **`EPROG.RS='R'` marks a PROCEDURE that is really a report** — a third of them.
  The program tools warn that a procedure can change, post or delete data, and for
  those that warning is false. Only `R` is interpreted; `d`, `N`, `G`, `M`, `p`,
  `E`, `F`, `l` and `S` also occur and are passed through uninterpreted, because
  nobody has said what they mean.
- **`published: false` is a hint in both directions, never a guarantee.** The service
  document under-reports. `ScreenEntry.access` (`direct` / `via-parent` / `unavailable`
  / `program`) is what callers act on; `published` alone made a sub-form look identical
  to a closed screen.
- **The service document takes ~70s.** Metadata calls get their own 180s budget,
  separate from the 45s query budget, because MCP clients commonly give up at 60s.
- **A supplied program parameter sends operator 0 (`=`) explicitly.** Inheriting the
  operator Priority remembered from the previous run turned
  `Trigger Name: POST-INSERT` into `Trigger Name <>'POST-INSERT'`. A parameter the
  caller does not mention keeps both its value and its operator — it is not blanked.

## Security constraints that are load-bearing

- **No credential is ever a tool argument.** A tool argument is chosen by the model, so
  it lands in the conversation, the transcript and every log of a tool call. That is why
  there is no `login()` tool and why caller identities arrive as `X-Priority-*` HTTP
  headers or through MCP elicitation (`auth.ts`). Header credentials are **refused over
  plain HTTP**. Keep it that way.
- **`PRIORITY_ENVIRONMENTS` is an allowlist, not a hint.** The company name is
  concatenated into the OData URL path — the same place
  `../../tabula.ini,1/demo/CUSTOMERS` escaped through. Validated in
  `resolveEnvironment()`, at the transport and again in `switchTo()`.
- **`assertSafePath()` in `discovery.ts` is an allowlist, not a `..` filter.** A
  blacklist must anticipate every spelling of "go up" across two decoders (ours and
  Priority's); the backslash variant was already one nobody had thought of. The first
  segment must be a screen the dictionary knows.
- **Nothing that can fail per-caller may be cached globally or fail the process.** A
  `ConfigError` is fatal at startup and catastrophic per request — one caller's unknown
  company header would take the server down for everyone, so `http.ts` validates it
  before `buildServer()` sees it. Likewise the `ENVIRONMENT` cache is keyed per identity
  and **never caches a failure**.
- **`MCP_AUTH_TOKEN` is required** whenever the listener is not loopback-only; the server
  refuses to start rather than warning.

## Tool descriptions are part of the product

Clients put the server `instructions` and each tool's `description` into the model's
system prompt, and they carry the rules that belong to no single tool: the discovery
order, case sensitivity, never summing currencies, how reversals work. They are long on
purpose. When a behaviour changes, the description changes with it — a gate that leaves
a tool in `tools/list` has not gated anything, however clearly the code reads
(`tests/toolgate.test.ts` checks this through a real handshake).

Two flags shape what a client sees: `PRIORITY_READ_ONLY=1` removes `run_program` /
`start_program` / `continue_program`, and `PRIORITY_ALLOW_ALL_PROGRAMS=1` opens
`run_program` to any of the installation's ~9,200 procedures and reports. Discovery and
read tools are **never** gated: without them a model cannot learn a screen name and goes
back to inferring one.

## Not in git

`.env` (holds the PAT, password and bearer token), `certs/` (**regenerate** with
`scripts/make-cert.ps1` — a copied certificate names the wrong machine),
`service/priority-mcp.exe` (WinSW, a third-party binary), `node_modules/`, and the
generated `client-kit/`, `users.json`, `remote-mcp-config.json` and dictionary cache.
Everything else regenerates.

`programs.json` and `glossary.json` are **maintained by hand** and are checked in.
Priority cannot enumerate runnable programs over the API, so `programs.json` is both the
safety gate and the discovery surface; a wrong `glossary.json` entry sends the model
confidently to the wrong screen, which is worse than no entry, so
`tests/live.glossary.ts` verifies every screen name against the live dictionary.
