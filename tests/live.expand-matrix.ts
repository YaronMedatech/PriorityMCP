// Priority truncates some $expand responses mid-JSON. Find which combinations
// survive, so the query builder can avoid the ones that do not.
import https from "node:https";
import { URL } from "node:url";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
const FILTER = "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2022-12-31T00:00:00Z and FINAL eq 'Y'";
const HEADER_SELECT = "IVNUM,IVDATE,CDES,CODE,QPRICE,TOTPRICE,FINAL,STATDES,STORNOFLAG,AGENTNAME,DETAILS,CUSTNAME,VAT";
const LINE_SELECT = "PARTNAME,PDES,QUANT,UNITNAME,PRICE,TOTPRICE";

function get(params: URLSearchParams): Promise<{ status: number; body: string }> {
  const target = new URL(`${cfg.odataUrl}/AINVOICES?${params.toString()}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        timeout: 60_000,
        rejectUnauthorized: cfg.verifySsl,
        headers: { Authorization: cfg.authHeader, Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { body += c; });
        // Same premature-close guard as the real client, or a truncated response
        // leaves this promise pending and the whole matrix stalls on case 1.
        const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
        res.on("aborted", () => done(() => reject(new Error(`aborted after ${body.length} chars`))));
        res.on("end", () => done(() =>
          res.complete
            ? resolve({ status: res.statusCode ?? 0, body })
            : reject(new Error(`truncated after ${body.length} chars`)),
        ));
        res.on("close", () => done(() => reject(new Error(`closed after ${body.length} chars`))));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    req.end();
  });
}

interface Case { label: string; params: Record<string, string> }

const cases: Case[] = [
  { label: "parent $select + nested $select  (current)", params: { $select: HEADER_SELECT, $expand: `AINVOICEITEMS_SUBFORM($select=${LINE_SELECT})`, $top: "3" } },
  { label: "parent $select + bare $expand",              params: { $select: HEADER_SELECT, $expand: "AINVOICEITEMS_SUBFORM", $top: "3" } },
  { label: "NO parent $select + nested $select",         params: { $expand: `AINVOICEITEMS_SUBFORM($select=${LINE_SELECT})`, $top: "3" } },
  { label: "NO parent $select + bare $expand",           params: { $expand: "AINVOICEITEMS_SUBFORM", $top: "3" } },
  { label: "parent $select + nested $select, $top=1",    params: { $select: HEADER_SELECT, $expand: `AINVOICEITEMS_SUBFORM($select=${LINE_SELECT})`, $top: "1" } },
  { label: "parent $select incl. nav name + nested",     params: { $select: `${HEADER_SELECT},AINVOICEITEMS_SUBFORM`, $expand: `AINVOICEITEMS_SUBFORM($select=${LINE_SELECT})`, $top: "3" } },
  { label: "nested $select of ONE column",               params: { $select: HEADER_SELECT, $expand: "AINVOICEITEMS_SUBFORM($select=PARTNAME)", $top: "3" } },
  { label: "no $expand at all (control)",                params: { $select: HEADER_SELECT, $top: "3" } },
];

for (const c of cases) {
  const params = new URLSearchParams({ $filter: FILTER, ...c.params });
  try {
    const { status, body } = await get(params);
    let verdict: string;
    try {
      const parsed = JSON.parse(body) as { value?: unknown[] };
      const rows = parsed.value?.length ?? 0;
      const lines = (parsed.value as Record<string, unknown>[] | undefined)?.reduce(
        (n, r) => n + ((r["AINVOICEITEMS_SUBFORM"] as unknown[] | undefined)?.length ?? 0), 0,
      );
      verdict = `ok    HTTP ${status}  ${body.length} chars  ${rows} row(s)` +
        (c.params["$expand"] ? `  ${lines} line(s)` : "");
    } catch {
      verdict = `TRUNC HTTP ${status}  ${body.length} chars  <- invalid JSON`;
    }
    console.log(`  ${verdict.padEnd(56)} | ${c.label}`);
  } catch (err) {
    console.log(`  ERROR ${(err as Error).message.padEnd(50)} | ${c.label}`);
  }
}
process.exit(0);
