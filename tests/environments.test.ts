// Company selection, checked without touching Priority.
//
// The allowlist here is a SECURITY control, not a convenience: the chosen name is
// concatenated into the OData URL path, which is the same place
// `../../tabula.ini,1/demo/CUSTOMERS` escaped through before discovery.ts closed
// it. So the refusals matter as much as the acceptances.
//
// No `instanceof` against a statically imported class: each case re-imports
// config.js under a fresh URL, so its ConfigError is a DIFFERENT class object and
// instanceof is false even for the error it just threw. Assert on the message.

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const BASE = "https://example.invalid/odata/Priority/tabula.ini,1";

/** Reload the module fresh so it re-reads the environment. */
async function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // A cache-busting query keeps each case independent of the last.
  return (await import(`../src/config.js?case=${Math.random().toString(36).slice(2)}`)) as
    typeof import("../src/config.js");
}

console.log("\n1. A ';' list is parsed, in order");
{
  const c = await withEnv({
    PRIORITY_ODATA_URL: BASE,
    PRIORITY_ENVIRONMENTS: "hafaza;demo;third",
    PRIORITY_COMPANY: "",
  });
  const envs = c.listEnvironments();
  if (JSON.stringify(envs) === JSON.stringify(["hafaza", "demo", "third"])) {
    ok(`${envs.length} companies, order preserved`);
  } else bad(`got ${JSON.stringify(envs)}`);
  if (c.defaultEnvironment() === "hafaza") ok("the first is the default");
  else bad(`default was ${String(c.defaultEnvironment())}`);
}

console.log("\n2. Whitespace and empty entries survive a hand-edited .env");
{
  const c = await withEnv({ PRIORITY_ODATA_URL: BASE, PRIORITY_ENVIRONMENTS: " hafaza ; ; demo ;" });
  if (JSON.stringify(c.listEnvironments()) === JSON.stringify(["hafaza", "demo"])) {
    ok("trimmed, blanks dropped");
  } else bad(`got ${JSON.stringify(c.listEnvironments())}`);
}

console.log("\n3. A URL that still ends in a company keeps working");
{
  // Every existing .env looks like this; the feature must not require an edit.
  // "" rather than undefined: config.js re-runs loadEnvFile on every import, and
  // dotenv refills any key that is absent from process.env -- but skips one that
  // is present and empty, which env() then reads as unset.
  const c = await withEnv({
    PRIORITY_ODATA_URL: `${BASE}/legacyco`,
    PRIORITY_ENVIRONMENTS: "",
    PRIORITY_COMPANY: "",
  });
  if (JSON.stringify(c.listEnvironments()) === JSON.stringify(["legacyco"])) {
    ok("the embedded company is discovered from the URL");
  } else bad(`got ${JSON.stringify(c.listEnvironments())}`);
  if (c.odataUrlFor("legacyco") === `${BASE}/legacyco`) ok("the URL is rebuilt unchanged");
  else bad(`built ${c.odataUrlFor("legacyco")}`);
}

console.log("\n3b. A tabula segment with NO language suffix");
{
  // Found on a real installation: `.../tabb6b4c.ini/ztest`, no `,1`. The first
  // version of this keyed on the comma, so a base URL ending in `tabb6b4c.ini`
  // was read as a COMPANY and the real base lost a segment. Nothing about the
  // resulting 404 would have pointed here.
  const NOCOMMA = "https://example.invalid/odata/Priority/tabb6b4c.ini";
  const c = await withEnv({
    PRIORITY_ODATA_URL: NOCOMMA,
    PRIORITY_ENVIRONMENTS: "zepc;ztest",
    PRIORITY_COMPANY: "",
  });
  if (c.odataUrlFor("ztest") === `${NOCOMMA}/ztest`) ok("a base ending in .ini is recognised as a base");
  else bad(`built ${c.odataUrlFor("ztest")}`);

  // And the same shape WITH a company on the end still splits correctly.
  const c2 = await withEnv({
    PRIORITY_ODATA_URL: `${NOCOMMA}/ztest/`,
    PRIORITY_ENVIRONMENTS: "",
    PRIORITY_COMPANY: "",
  });
  if (JSON.stringify(c2.listEnvironments()) === JSON.stringify(["ztest"])) {
    ok("a trailing company after a comma-less .ini is still found");
  } else bad(`got ${JSON.stringify(c2.listEnvironments())}`);
  if (c2.odataUrlFor("ztest") === `${NOCOMMA}/ztest`) ok("the trailing slash is normalised away");
  else bad(`built ${c2.odataUrlFor("ztest")}`);
}

console.log("\n4. The URL is built per company");
{
  const c = await withEnv({ PRIORITY_ODATA_URL: BASE, PRIORITY_ENVIRONMENTS: "hafaza;demo" });
  if (c.odataUrlFor("demo") === `${BASE}/demo`) ok("odataUrlFor appends the company");
  else bad(`built ${c.odataUrlFor("demo")}`);
  if (c.odataUrlFor("hafaza") !== c.odataUrlFor("demo")) ok("two companies get two URLs");
  else bad("both companies produced the same URL");
  if (c.installationBase() === BASE) ok("installationBase strips the company");
  else bad(`installationBase = ${c.installationBase()}`);
}

console.log("\n5. An unknown company is refused, not silently defaulted");
{
  const c = await withEnv({ PRIORITY_ODATA_URL: BASE, PRIORITY_ENVIRONMENTS: "hafaza;demo" });
  try {
    c.resolveEnvironment("production");
    bad("an unknown company was accepted");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/hafaza, demo/.test(msg)) {
      ok("refused, and the message lists what IS available");
    } else bad(`wrong error: ${msg.slice(0, 80)}`);
  }
}

console.log("\n6. Path-shaped values are refused before the list is even consulted");
// The whole point of the allowlist. Each of these would otherwise be pasted
// straight into a URL path.
{
  const c = await withEnv({ PRIORITY_ODATA_URL: BASE, PRIORITY_ENVIRONMENTS: "hafaza;demo" });
  const attacks = [
    "../demo",
    "../../tabula.ini,1/demo",
    "hafaza/../demo",
    "..%2Fdemo",
    "demo?x=1",
    "demo#frag",
    "de mo",
    "demo/CUSTOMERS",
    "https://evil.invalid/x",
    "hafaza;demo",
  ];
  let refused = 0;
  for (const a of attacks) {
    try {
      c.resolveEnvironment(a);
      bad(`ACCEPTED a path-shaped company: ${a}`);
    } catch {
      refused++;
    }
  }
  if (refused === attacks.length) ok(`all ${attacks.length} path-shaped values refused`);
}

console.log("\n7. Matching is case-sensitive");
{
  const c = await withEnv({ PRIORITY_ODATA_URL: BASE, PRIORITY_ENVIRONMENTS: "hafaza;demo" });
  try {
    c.resolveEnvironment("HAFAZA");
    bad("case-folded to a real company the caller did not name");
  } catch {
    ok("HAFAZA does not silently resolve to hafaza");
  }
  if (c.resolveEnvironment("hafaza") === "hafaza") ok("the exact name resolves");
  else bad("the exact name failed");
}

console.log("\n8. PRIORITY_COMPANY picks the default from the list");
{
  const c = await withEnv({
    PRIORITY_ODATA_URL: BASE,
    PRIORITY_ENVIRONMENTS: "hafaza;demo",
    PRIORITY_COMPANY: "demo",
  });
  if (c.defaultEnvironment() === "demo") ok("the configured default wins over first-in-list");
  else bad(`default was ${String(c.defaultEnvironment())}`);
  if (c.resolveEnvironment(null) === "demo") ok("no request resolves to the default");
  else bad("no-request did not use the default");
}

console.log("\n9. loadConfig returns a different URL per company");
{
  const c = await withEnv({
    PRIORITY_ODATA_URL: BASE,
    PRIORITY_ENVIRONMENTS: "hafaza;demo",
    PRIORITY_COMPANY: "",
    PRIORITY_API_TOKEN: "test-token-not-real",
  });
  const a = c.loadConfig("hafaza");
  const b = c.loadConfig("demo");
  if (a.odataUrl !== b.odataUrl) ok(`two configs, two URLs (${a.company} vs ${b.company})`);
  else bad("both companies produced the same config URL");
  if (a.company === "hafaza" && b.company === "demo") ok("each config names its own company");
  else bad(`companies were ${a.company} / ${b.company}`);
  // The cache is per company now; a shared slot would return the first one twice.
  if (c.loadConfig("demo").odataUrl === b.odataUrl) ok("the per-company cache returns the right entry");
  else bad("cache returned another company's config");
}

console.log(failures === 0 ? "\nAll environment checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
