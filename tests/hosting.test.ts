// PRIORITY_HOSTING: explicit beats detected, detection reads the host name, and
// the two hosting kinds produce the two Web SDK URLs and identity orders that
// were measured. Offline.
import { ConfigError, detectHosting, loadWebSdkConfig, webSdkUrlFor } from "../src/config.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL ${m}`); };

const CLOUD = "https://t.eu.priority-connect.online/odata/Priority/tabb6b4c.ini";
const ONPREM = "https://priority.example.local/odata/Priority/tabula.ini,1/baccara";

console.log("\n1. Detection from the OData host name");
let h = detectHosting({ PRIORITY_ODATA_URL: CLOUD });
if (h.hosting === "cloud" && h.source === "detected" && /pin it with PRIORITY_HOSTING=cloud/.test(h.detail)) ok(`cloud detected: ${h.detail}`);
else bad(JSON.stringify(h));
h = detectHosting({ PRIORITY_ODATA_URL: ONPREM });
if (h.hosting === "self-hosted" && h.source === "detected") ok(`self-hosted detected for ${new URL(ONPREM).hostname}`);
else bad(JSON.stringify(h));
h = detectHosting({});
if (h.hosting === "self-hosted" && /no OData URL/.test(h.detail)) ok("no URL at all: self-hosted, and the detail says why");
else bad(JSON.stringify(h));

console.log("\n2. Explicit wins, spellings are forgiven, nonsense is refused");
h = detectHosting({ PRIORITY_ODATA_URL: CLOUD, PRIORITY_HOSTING: "self-hosted" });
if (h.hosting === "self-hosted" && h.source === "PRIORITY_HOSTING") ok("PRIORITY_HOSTING=self-hosted overrides a cloud host name");
else bad(JSON.stringify(h));
for (const [raw, want] of [["Cloud", "cloud"], ["SaaS", "cloud"], ["onprem", "self-hosted"], ["on-prem", "self-hosted"], ["local", "self-hosted"]] as const) {
  const got = detectHosting({ PRIORITY_HOSTING: raw }).hosting;
  if (got === want) ok(`'${raw}' -> ${want}`); else bad(`'${raw}' -> ${got}`);
}
try {
  detectHosting({ PRIORITY_HOSTING: "aws" });
  bad("'aws' was accepted");
} catch (err) {
  if (err instanceof ConfigError && /cloud|self-hosted/.test(err.message)) ok("an unknown value is a ConfigError naming the accepted ones");
  else bad(`unexpected error: ${String(err)}`);
}

console.log("\n3. The Web SDK URL per hosting kind");
if (webSdkUrlFor("https://t.eu.priority-connect.online/", "cloud") === "https://t.eu.priority-connect.online/wcf/service.svc") ok("cloud: <origin>/wcf/service.svc");
else bad(webSdkUrlFor("https://t.eu.priority-connect.online/", "cloud"));
if (webSdkUrlFor("https://priority.example.local/", "self-hosted") === "https://priority.example.local/") ok("self-hosted: the host root, untouched");
else bad(webSdkUrlFor("https://priority.example.local/", "self-hosted"));
if (webSdkUrlFor("https://t.eu.priority-connect.online/", "self-hosted") === "https://t.eu.priority-connect.online/") ok("a cloud host name pinned self-hosted keeps the root -- the flag, not the name, decides");
else bad("host name overrode the flag");

console.log("\n4. Identity order follows the hosting kind");
const saved = { ...process.env };
const withEnv = (vars: Record<string, string>) => {
  for (const k of ["PRIORITY_HOSTING", "PRIORITY_HOST_URL", "PRIORITY_API_TOKEN", "PRIORITY_USER", "PRIORITY_PASS", "PRIORITY_COMPANY", "PRIORITY_ENVIRONMENTS", "PRIORITY_ODATA_URL"]) delete process.env[k];
  Object.assign(process.env, vars);
  const cfg = loadWebSdkConfig("demo");
  return "error" in cfg ? cfg : cfg;
};
let cfg = withEnv({ PRIORITY_ODATA_URL: CLOUD, PRIORITY_API_TOKEN: "tok", PRIORITY_USER: "u", PRIORITY_PASS: "p" });
if (!("error" in cfg) && cfg.identity === "pat" && cfg.username === "tok" && cfg.password === "PAT" && cfg.url.endsWith("/wcf/service.svc") && cfg.hosting === "cloud") ok("cloud with both: PAT first, cloud URL");
else bad(JSON.stringify(cfg));
cfg = withEnv({ PRIORITY_ODATA_URL: ONPREM, PRIORITY_API_TOKEN: "tok", PRIORITY_USER: "u", PRIORITY_PASS: "p" });
if (!("error" in cfg) && cfg.identity === "user" && cfg.username === "u" && cfg.url === "https://priority.example.local/" && cfg.hosting === "self-hosted") ok("self-hosted with both: named user first, host root");
else bad(JSON.stringify(cfg));
cfg = withEnv({ PRIORITY_ODATA_URL: ONPREM, PRIORITY_API_TOKEN: "tok" });
if (!("error" in cfg) && cfg.identity === "pat") ok("self-hosted with only a PAT falls back to it");
else bad(JSON.stringify(cfg));
cfg = withEnv({ PRIORITY_ODATA_URL: CLOUD, PRIORITY_USER: "u", PRIORITY_PASS: "p" });
if (!("error" in cfg) && cfg.identity === "user") ok("cloud with only a user falls back to it");
else bad(JSON.stringify(cfg));
cfg = withEnv({ PRIORITY_ODATA_URL: CLOUD });
if ("error" in cfg && /PRIORITY_API_TOKEN or PRIORITY_USER\+PRIORITY_PASS/.test(cfg.error)) ok("neither identity: the error names both options");
else bad(JSON.stringify(cfg));
cfg = withEnv({ PRIORITY_ODATA_URL: CLOUD, PRIORITY_API_TOKEN: "tok", PRIORITY_HOST_URL: "https://elsewhere.example/svc/Service.svc" });
if (!("error" in cfg) && cfg.url === "https://elsewhere.example/svc/Service.svc") ok("PRIORITY_HOST_URL overrides the derived URL");
else bad(JSON.stringify(cfg));
process.env = saved;

console.log(failures === 0 ? "\nAll hosting checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
