// Does this server actually return a total, or only accept the parameter?
//
// live.paging.ts showed $count=true is not rejected, but countOf() came back
// null -- "accepted" and "honoured" are different things on this server, and the
// difference decides whether a caller can know a total before paging.
import { loadConfig, loadEnvFile } from "../src/config.js";

loadEnvFile();
const cfg = loadConfig();
const ENTITY = process.env["PAGING_ENTITY"] ?? "PART";

const headers = { Authorization: cfg.authHeader, Accept: "application/json" };

console.log(`\nprobing count support on ${ENTITY}\n`);

// 1. $count=true as a query option -- the envelope should carry @odata.count.
const url1 = `${cfg.odataUrl}/${ENTITY}?$select=PARTNAME&$top=1&$count=true`;
try {
  const res = await fetch(url1, { headers });
  const body = await res.text();
  console.log(`1. $count=true -> HTTP ${res.status}`);
  if (res.ok) {
    const json = JSON.parse(body) as Record<string, unknown>;
    const keys = Object.keys(json);
    console.log(`   envelope keys: ${keys.join(", ")}`);
    const countKey = keys.find((k) => k.toLowerCase().includes("count"));
    console.log(
      countKey
        ? `   OK   total present as '${countKey}' = ${String(json[countKey])}`
        : `   IGNORED — the parameter is accepted and no count is returned`,
    );
  } else {
    console.log(`   rejected: ${body.slice(0, 200)}`);
  }
} catch (err) {
  console.log(`   failed: ${err instanceof Error ? err.message : String(err)}`);
}

// 2. /$count as a path segment -- returns text/plain, not JSON.
const url2 = `${cfg.odataUrl}/${ENTITY}/$count`;
try {
  const res = await fetch(url2, { headers: { Authorization: cfg.authHeader } });
  const body = (await res.text()).trim();
  console.log(`\n2. /$count -> HTTP ${res.status}`);
  const n = Number(body);
  console.log(
    res.ok && Number.isFinite(n)
      ? `   OK   plain total = ${n}`
      : `   unusable: ${body.slice(0, 200)}`,
  );
} catch (err) {
  console.log(`   failed: ${err instanceof Error ? err.message : String(err)}`);
}

// 3. /$count with a filter -- a total is only useful if it respects the filter.
const url3 = `${cfg.odataUrl}/${ENTITY}/$count?$filter=${encodeURIComponent("PARTNAME ge 'M'")}`;
try {
  const res = await fetch(url3, { headers: { Authorization: cfg.authHeader } });
  const body = (await res.text()).trim();
  const n = Number(body);
  console.log(`\n3. /$count with $filter -> HTTP ${res.status}`);
  console.log(
    res.ok && Number.isFinite(n)
      ? `   OK   filtered total = ${n}`
      : `   unusable: ${body.slice(0, 200)}`,
  );
} catch (err) {
  console.log(`   failed: ${err instanceof Error ? err.message : String(err)}`);
}
