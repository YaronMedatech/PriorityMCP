// Raw HTTP against Priority with $expand, bypassing the client, to see exactly
// what the server does with it.
import https from "node:https";
import { URL } from "node:url";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
const params = new URLSearchParams();
params.set("$select", "IVNUM,IVDATE,CDES,CODE,QPRICE,TOTPRICE,FINAL,STATDES,STORNOFLAG,AGENTNAME,DETAILS,CUSTNAME,VAT");
params.set("$filter", "IVDATE ge 2022-01-01T00:00:00Z and IVDATE lt 2022-12-31T00:00:00Z and FINAL eq 'Y'");
params.set("$expand", "AINVOICEITEMS_SUBFORM($select=PARTNAME,PDES,QUANT,UNITNAME,PRICE,TOTPRICE)");
params.set("$top", "2");

const url = `${cfg.odataUrl}/AINVOICES?${params.toString()}`;
console.log(`URL length: ${url.length}`);
console.log(`URL: ${url}\n`);

const target = new URL(url);
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const req = https.request(
  {
    method: "GET",
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    timeout: 30_000,
    rejectUnauthorized: cfg.verifySsl,
    headers: { Authorization: cfg.authHeader, Accept: "application/json" },
  },
  (res) => {
    console.log(`[${elapsed()}] response: HTTP ${res.statusCode}`);
    console.log(`[${elapsed()}] headers: ${JSON.stringify(res.headers)}`);
    let body = "";
    let chunks = 0;
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      body += c;
      chunks++;
      if (chunks <= 3) console.log(`[${elapsed()}] chunk ${chunks}: ${c.length} chars`);
    });
    res.on("end", () => {
      console.log(`[${elapsed()}] END — ${chunks} chunk(s), ${body.length} chars`);
      console.log(`body head: ${body.slice(0, 900)}`);
      process.exit(0);
    });
    res.on("close", () => console.log(`[${elapsed()}] response 'close'`));
    res.on("aborted", () => console.log(`[${elapsed()}] response 'aborted'`));
    res.on("error", (e) => console.log(`[${elapsed()}] response error: ${e.message}`));
  },
);

req.on("timeout", () => {
  console.log(`[${elapsed()}] socket timeout — destroying`);
  req.destroy(new Error("socket timeout"));
});
req.on("error", (e) => {
  console.log(`[${elapsed()}] request error: ${e.message}`);
  process.exit(1);
});
req.on("close", () => console.log(`[${elapsed()}] request 'close'`));
req.end();

// Hard wall-clock guard, so a hang reports rather than exiting silently.
setTimeout(() => {
  console.log(`[${elapsed()}] STILL PENDING after 60s — giving up`);
  process.exit(2);
}, 60_000);
