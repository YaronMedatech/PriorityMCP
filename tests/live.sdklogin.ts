// Just the Web SDK login, nothing else -- against the URL Priority's own SDK
// documentation gives for the cloud, which is NOT what the SDK derives itself:
//   https://prioritysoftware.github.io/api/global/#login
//   cloud test EU:  https://t.eu.priority-connect.online/wcf/service.svc
// (one "wcf", ending in .svc so the SDK appends nothing). The docs also say a
// PAT logs in as username=<token>, password='PAT', so both identities are tried.
// Nothing secret is printed.
import { createRequire } from "node:module";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const require = createRequire(import.meta.url);
const mod = require("priority-web-sdk") as Record<string, unknown> & { default?: Record<string, unknown> };
const sdk = (mod.default ?? mod) as { login: (c: unknown) => Promise<unknown>; procStart?: unknown };

const odata = (process.env["PRIORITY_ODATA_URL"] ?? "").trim();
const host = new URL(odata).origin;
const tabulaini = /\/(tab[a-z0-9]*\.ini)(,\d+)?/i.exec(odata)?.[1] ?? "tabula.ini";
const company = (process.env["PRIORITY_COMPANY"] ?? "").trim() || (process.env["PRIORITY_ENVIRONMENTS"] ?? "").split(";")[0]?.trim() || "zepc";
const user = (process.env["PRIORITY_USER"] ?? "").trim();
const pass = (process.env["PRIORITY_PASS"] ?? "").trim();
const pat = (process.env["PRIORITY_API_TOKEN"] ?? "").trim();

const urls = [
  `${host}/wcf/service.svc`,            // documented for priority-connect.online
  `${host}/wcf/wcf/Service.svc`,        // what the SDK derives for a host root
  `${host}`,                            // host root (SDK appends /wcf/wcf/Service.svc)
];
const identities = [
  ...(user && pass ? [{ label: `user ${user}`, username: user, password: pass }] : []),
  ...(pat ? [{ label: "PAT (username=token, password='PAT')", username: pat, password: "PAT" }] : []),
];
const licenses = [
  { label: "our appid, empty appkey", appid: "priority-mcp", appkey: "" },
  { label: "docs demo appid/appkey", appid: "APP001", appkey: "15nXqSDXnNeaIEFQSSDXkNeZ16DXodeV16TXmSDXoteb16nXmdeVISEh" },
];

console.log(`\nhost ${host}, tabulaini ${tabulaini}, company ${company}\n`);
let success: string | null = null;
outer: for (const url of urls) {
  for (const id of identities) {
    for (const lic of licenses) {
      const started = Date.now();
      try {
        await sdk.login({
          url, tabulaini, language: 2, profile: { company },
          appname: "priority-mcp", devicename: "priority-mcp",
          username: id.username, password: id.password, appid: lic.appid, appkey: lic.appkey,
        });
        success = `${url}  |  ${id.label}  |  ${lic.label}`;
        console.log(`LOGIN OK   ${success}  (${Date.now() - started}ms)`);
        break outer;
      } catch (err) {
        const e = err as { code?: string; message?: string; type?: string };
        const detail = err instanceof Error ? err.message : `${e.code ?? "?"}: ${String(e.message ?? JSON.stringify(err)).slice(0, 140)}`;
        console.log(`fail       ${url.replace(host, "")||"/"}  |  ${id.label}  |  ${lic.label}  ->  ${detail}  (${Date.now() - started}ms)`);
      }
    }
  }
}
console.log(success ? `\nLogged in. Use PRIORITY_HOST_URL=${success.split("  |  ")[0]}\n` : "\nNo combination logged in.\n");
process.exit(success ? 0 : 1);
