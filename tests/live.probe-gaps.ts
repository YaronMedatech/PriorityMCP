// Step 0 of the gap-closing plan: MEASURE before writing code.
//
// Every question here decides a design choice in a later step, and each one has
// already been guessed wrong at least once on this server (contains() "should"
// work, $expand "should" return help). So this prints what the server does and
// draws no conclusions of its own. Read-only throughout: no procedure is run with
// inputs that change data, and the one report run is the trigger listing.
import { createRequire } from "node:module";
import { loadEnvFile, loadWebSdkConfig, listEnvironments } from "../src/config.js";

loadEnvFile();
const { PriorityODataClient } = await import("../src/odata.js");
const { CompanyContext } = await import("../src/companies.js");

const client = new PriorityODataClient();
const first = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const q = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;
const keyPath = (keys: string[], row: Record<string, unknown>): string =>
  keys.map((k) => `${k}=${typeof row[k] === "number" ? String(row[k]) : q(row[k])}`).join(",");
const section = (n: number, title: string): void => console.log(`\n${n}. ${title}`);

console.log(`\nreading from ${client.baseUrl}`);

// ---------------------------------------------------------------------------
section(1, "EXEC — the entity catalogue: columns, and what a P/R fetch costs");
// Decides step 2: EXEC filtered by TYPE, or EPROG + EREP.
try {
  const md = (await client.metadataFor("EXEC")).get("EXEC");
  if (!md) throw new Error("GetMetadataFor(EXEC) returned no EXEC type");
  console.log(`   keys: ${md.keys.join(", ")}`);
  console.log(
    `   columns (${md.columns.size}): ${[...md.columns.values()]
      .map((c) => `${c.name}${c.title ? `(${c.title})` : ""}`)
      .join(", ")}`,
  );
  console.log(`   navs: ${[...md.navs.values()].map((n) => `${n.name}->${n.target}`).join(", ")}`);

  const sample = await client.query("EXEC", { top: 500, select: ["ENAME", "TYPE"] });
  const types = new Map<string, number>();
  for (const r of sample) types.set(String(r["TYPE"]), (types.get(String(r["TYPE"])) ?? 0) + 1);
  console.log(`   TYPE values in the first 500 rows: ${[...types.entries()].map(([t, n]) => `${t}×${n}`).join(", ")}`);

  const started = Date.now();
  const pr = await client.query("EXEC", {
    pageSize: 500,
    select: ["ENAME", "TYPE", "TITLE"],
    filter: "TYPE eq 'P' or TYPE eq 'R'",
  });
  const withTitle = pr.filter((r) => String(r["TITLE"] ?? "").trim()).length;
  const byType = new Map<string, number>();
  for (const r of pr) byType.set(String(r["TYPE"]), (byType.get(String(r["TYPE"])) ?? 0) + 1);
  console.log(
    `   P/R rows: ${pr.length} (${[...byType.entries()].map(([t, n]) => `${t}=${n}`).join(", ")}), ` +
      `${withTitle} with a title, fetched in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  for (const r of pr.filter((x) => /^(FORMTRIGREP|FORMMSG|FORMTREE|FORMCLTRIGREP)$/.test(String(x["ENAME"])))) {
    console.log(`     ${String(r["ENAME"]).padEnd(16)} ${String(r["TYPE"])}  ${String(r["TITLE"])}`);
  }
} catch (err) {
  console.log(`   FAILED: ${first(err)}`);
}

// ---------------------------------------------------------------------------
section(2, "FCLMN — its key, its flags, and whether column help is reachable");
// Decides step 1's column-help path and whether describe_screen can report
// Hidden/IsStatus the way form_columns does.
let fclmnEntity = "FCLMN";
let fclmnKeys: string[] = [];
let eformKeys: string[] = [];
try {
  const md = await client.metadataFor("EFORM");
  const eform = md.get("EFORM");
  eformKeys = eform?.keys ?? [];
  const nav = eform?.navs.get("FCLMN_SUBFORM");
  fclmnEntity = nav?.target ?? "FCLMN";
  const fclmn = md.get(fclmnEntity);
  fclmnKeys = fclmn?.keys ?? [];
  console.log(`   EFORM keys: ${eformKeys.join(", ")}`);
  console.log(`   FCLMN_SUBFORM -> ${fclmnEntity}, keys: ${fclmnKeys.join(", ")}`);
  const flagish = [...(fclmn?.columns.values() ?? [])].filter((c) =>
    /HID|READ|STAT|WIDTH|DECIM|MAND|KEY|TYPE|FORMAT|LINK/i.test(c.name),
  );
  console.log(`   FCLMN columns (${fclmn?.columns.size ?? 0}); flag-like: ${flagish.map((c) => `${c.name}${c.title ? `(${c.title})` : ""}`).join(", ")}`);
  console.log(`   FCLMN navs: ${[...(fclmn?.navs.values() ?? [])].map((n) => `${n.name}->${n.target}`).join(", ") || "(none)"}`);
} catch (err) {
  console.log(`   metadata FAILED: ${first(err)}`);
}

const eformKey = eformKeys.includes("TYPE") ? `ENAME='AINVOICES',TYPE='F'` : `ENAME='AINVOICES'`;
try {
  const cols = await client.queryRawPath(`EFORM(${eformKey})/FCLMN_SUBFORM?$top=3`);
  console.log(`   EFORM(${eformKey})/FCLMN_SUBFORM -> ${cols.length} row(s); first: ${JSON.stringify(cols[0] ?? {}).slice(0, 300)}`);
  const row = cols.find((c) => c["NAME"] === "CUSTNAME") ?? cols[0];
  // GetMetadataFor(EFORM) describes EFORM alone, so FCLMN's key has to be found
  // by trying: a keyed read that returns exactly the one row is the key.
  const candidates: string[][] = fclmnKeys.length ? [fclmnKeys] : [["NAME"], ["IDCOLUMNE"], ["POS"], ["NAME", "POS"]];
  if (row) {
    for (const keys of candidates) {
      const keyed = `EFORM(${eformKey})/FCLMN_SUBFORM(${keyPath(keys, row)})`;
      try {
        const one = await client.queryRawPath(keyed);
        console.log(`   ${keyed} -> ${one.length} row(s)${one.length === 1 ? " — THIS IS THE KEY" : ""}`);
        if (one.length === 1) {
          try {
            const help = await client.queryRawPath(`${keyed}/FCLMNHELP_SUBFORM`);
            console.log(`   …/FCLMNHELP_SUBFORM -> ${help.length} row(s); first: ${JSON.stringify(help[0] ?? {}).slice(0, 300)}`);
          } catch (err) {
            console.log(`   …/FCLMNHELP_SUBFORM -> ${first(err)}`);
          }
          break;
        }
      } catch (err) {
        console.log(`   ${keyed} -> ${first(err)}`);
      }
    }
  }
  try {
    const direct = (await client.metadataFor("FCLMN")).get("FCLMN");
    console.log(`   GetMetadataFor(FCLMN) -> keys: ${direct?.keys.join(", ") ?? "(no FCLMN type)"}`);
  } catch (err) {
    console.log(`   GetMetadataFor(FCLMN) -> ${first(err)}`);
  }
  // The expand route, for the record. On this server an expand of a text
  // sub-form has come back silently empty before.
  try {
    const viaExpand = await client.queryRawPath(
      `EFORM(${eformKey})?$expand=FCLMN_SUBFORM($top=3;$expand=FCLMNHELP_SUBFORM)`,
    );
    const sub = (viaExpand[0]?.["FCLMN_SUBFORM"] ?? []) as Record<string, unknown>[];
    const helped = sub.filter((s) => Array.isArray(s["FCLMNHELP_SUBFORM"]) && (s["FCLMNHELP_SUBFORM"] as unknown[]).length);
    console.log(`   nested $expand: ${sub.length} FCLMN row(s), ${helped.length} carrying help rows`);
  } catch (err) {
    console.log(`   nested $expand FAILED: ${first(err)}`);
  }
} catch (err) {
  console.log(`   FCLMN_SUBFORM FAILED: ${first(err)}`);
}

// ---------------------------------------------------------------------------
section(3, "Help for a report, a procedure and a screen through EXEC/FORMHELP");
for (const [name, type] of [
  ["FORMTRIGREP", "R"],
  ["FORMMSG", "P"],
  ["AINVOICES", "F"],
] as const) {
  try {
    const rows = await client.queryRawPath(`EXEC(ENAME='${name}',TYPE='${type}')/FORMHELP_SUBFORM`);
    const text = String(rows[0]?.["TEXT"] ?? "");
    console.log(`   ${name}(${type}): ${rows.length} row(s), ${text.length} chars${text ? `: ${text.replace(/<[^>]+>/g, "").slice(0, 80)}…` : ""}`);
  } catch (err) {
    console.log(`   ${name}(${type}): ${first(err)}`);
  }
}

// ---------------------------------------------------------------------------
section(4, "AIWORKFLOWS (AI skills) in every configured company");
for (const company of listEnvironments()) {
  try {
    const rows = await new CompanyContext(company).client.query("AIWORKFLOWS", { top: 3 });
    console.log(`   ${company}: OK, ${rows.length} row(s)${rows.length ? ` — ${JSON.stringify(rows[0]).slice(0, 200)}` : ""}`);
  } catch (err) {
    console.log(`   ${company}: ${first(err)}`);
  }
}

// ---------------------------------------------------------------------------
section(5, "Does a $filter / $orderby INSIDE $expand take effect?");
// Decides whether query can offer form_fetch-style per-child filtering.
// A baseline first: the same invoices with their items unfiltered. Without it,
// zero items under a filter cannot be told apart from zero items at all.
try {
  const baseline = await client.query("AINVOICES", {
    top: 5,
    filter: "FINAL eq 'Y'",
    expand: "AINVOICEITEMS_SUBFORM($select=KLINE,QUANT;$top=5)",
  });
  const withItems = baseline.filter((r) => ((r["AINVOICEITEMS_SUBFORM"] ?? []) as unknown[]).length > 0);
  console.log(`   baseline: ${baseline.length} invoice(s), ${withItems.length} with items`);
  const target = withItems[0];
  if (!target) {
    console.log("   inconclusive — no invoice with items in the sample");
  } else {
    const items = target["AINVOICEITEMS_SUBFORM"] as Record<string, unknown>[];
    console.log(`   ${String(target["IVNUM"])} unfiltered: ${items.map((i) => `KLINE=${String(i["KLINE"])} QUANT=${String(i["QUANT"])}`).join("; ")}`);
    const keys = ["IVNUM", "DEBIT", "IVTYPE"].map((k) => `${k}=${q(target[k])}`).join(",");
    const filtered = await client.queryRawPath(
      `AINVOICES(${keys})?$expand=AINVOICEITEMS_SUBFORM($select=KLINE,QUANT;$filter=KLINE gt 1;$orderby=KLINE desc)`,
    );
    const got = (filtered[0]?.["AINVOICEITEMS_SUBFORM"] ?? []) as Record<string, unknown>[];
    console.log(`   same invoice, $filter=KLINE gt 1;$orderby=KLINE desc: ${got.map((i) => `KLINE=${String(i["KLINE"])}`).join("; ") || "(none)"}`);
    const hasLine1 = got.some((i) => Number(i["KLINE"]) === 1);
    const descending = got.every((i, n) => n === 0 || Number(got[n - 1]!["KLINE"]) >= Number(i["KLINE"]));
    console.log(`   nested $filter ${hasLine1 ? "IGNORED (line 1 came back)" : "honoured"}; nested $orderby ${descending ? "honoured" : "IGNORED"}`);
  }
} catch (err) {
  console.log(`   FAILED: ${first(err)}`);
}

// ---------------------------------------------------------------------------
section(6, "Text functions and `in` in $filter — the tool descriptions say contains() and `in` are 501");
for (const [entity, f] of [
  ["CUSTOMERS", "startswith(CUSTDES,'א')"],
  ["CUSTOMERS", "endswith(CUSTDES,'ם')"],
  ["CUSTOMERS", "contains(CUSTDES,'א')"],
  ["AINVOICES", "contains(CUSTDES,'א')"],
  ["AINVOICES", "IVTYPE in ('A','C')"],
  ["CUSTOMERS", "tolower(CUSTNAME) eq '1'"],
] as const) {
  try {
    const rows = await client.query(entity, { top: 3, filter: f, select: ["CUSTNAME", "CUSTDES"] });
    console.log(`   ${entity.padEnd(10)} ${f.padEnd(28)} -> 200, ${rows.length} row(s): ${rows.map((r) => String(r["CUSTDES"])).join(" | ")}`);
  } catch (err) {
    console.log(`   ${entity.padEnd(10)} ${f.padEnd(28)} -> ${first(err)}`);
  }
}

// ---------------------------------------------------------------------------
section(7, "Web SDK: does the named user still log in, and what does a PDF report return?");
// Decides whether step 4 is even possible with the current credentials, and the
// shape of PDF output.
const sdkCfg = loadWebSdkConfig();
if ("error" in sdkCfg) {
  console.log(`   Web SDK not configured: ${sdkCfg.error.split("\n")[0]}`);
} else {
  const require = createRequire(import.meta.url);
  try {
    const mod = require("priority-web-sdk") as Record<string, unknown> & { default?: Record<string, unknown> };
    const sdk = (mod.default ?? mod) as Record<string, unknown>;
    await (sdk["login"] as (c: unknown) => Promise<unknown>)({
      url: sdkCfg.url,
      tabulaini: sdkCfg.tabulaini,
      language: 2,
      profile: { company: sdkCfg.company },
      appname: "priority-mcp-probe",
      username: sdkCfg.username,
      password: sdkCfg.password,
      devicename: "priority-mcp-probe",
      appid: "priority-mcp-probe",
      appkey: "",
    });
    console.log(`   login OK as ${sdkCfg.username} against ${sdkCfg.url} (${sdkCfg.company})`);

    type Step = {
      type?: string;
      message?: string;
      input?: { EditFields?: { field?: number; title?: string }[]; Options?: unknown[] };
      Urls?: { datauri?: string; url?: string; type?: string }[];
      proc?: Record<string, (...a: unknown[]) => Promise<Step>>;
    };
    const procStart = sdk["procStart"] as (n: string, t: string, cb: () => void, o: unknown) => Promise<Step>;
    let step: Step | undefined = await procStart("FORMTRIGREP", "R", () => {}, { company: sdkCfg.company });
    let guard = 0;
    while (step && step.type !== "end" && guard++ < 12) {
      const kind = String(step.type);
      if (kind === "inputFields") {
        const fields: { field?: number; title?: string }[] = step.input?.EditFields ?? [];
        console.log(`   inputFields: ${fields.map((f) => `${f.field}:'${f.title}'`).join(", ")}`);
        const edit: { field: number; op: number; value: string; op2: number; value2: string }[] = fields.map((f) => ({
          field: Number(f.field ?? 0),
          op: 0,
          value: /form/i.test(String(f.title)) ? "ORDERS" : "",
          op2: 0,
          value2: "",
        }));
        step = await step.proc?.["inputFields"]?.(1, { EditFields: edit });
      } else if (kind === "reportOptions" || kind === "documentOptions") {
        console.log(`   ${kind}: asking for PDF`);
        step = await step.proc?.[kind]?.(1, "PDF", {});
      } else if (kind === "displayUrl") {
        for (const u of step.Urls ?? []) {
          const head = String(u.datauri ?? "").slice(0, 40);
          console.log(`   displayUrl: url=${u.url ?? "(none)"} type=${u.type ?? "?"} datauri=${u.datauri ? `${u.datauri.length} chars, starts ${head}` : "(none)"}`);
        }
        step = await step.proc?.["continueProc"]?.();
      } else if (kind === "message") {
        console.log(`   message: ${String(step.message).slice(0, 120)}`);
        step = await step.proc?.["message"]?.(1);
      } else if (kind === "inputOptions") {
        console.log(`   inputOptions: ${JSON.stringify(step.input?.Options ?? []).slice(0, 200)} — cancelling rather than choosing`);
        await step.proc?.["cancel"]?.();
        break;
      } else {
        console.log(`   unhandled step '${kind}' — cancelling`);
        await step.proc?.["cancel"]?.();
        break;
      }
    }
    console.log(`   finished at step type '${step?.type ?? "?"}' after ${guard} step(s)`);
  } catch (err) {
    // The SDK rejects with a plain object, not an Error, so first() would print
    // "[object Object]" and hide the one thing worth knowing.
    const detail = err instanceof Error ? err.message : JSON.stringify(err);
    console.log(`   FAILED: ${String(detail).slice(0, 400)}`);
  }
}

console.log("\nDone. Nothing above is a conclusion; the plan's steps 1-4 read these results.\n");
process.exit(0);
