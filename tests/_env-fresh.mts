import { loadEnvFile } from "../src/config.js";
loadEnvFile();
const { PriorityODataClient } = await import("../src/odata.js");
const { readEnvironments, resetEnvironmentCache } = await import("../src/companies.js");

console.log("A. fresh process, PAT from .env:");
let r = await readEnvironments(new PriorityODataClient());
console.log(`   ${r.rows.length} rows  ${r.note ?? ""}`);
for (const x of r.rows.slice(0, 6)) console.log(`     ${x.code.padEnd(10)} ${x.title}`);

console.log("\nB. now a BAD identity reads it, then the good one again:");
resetEnvironmentCache();
const bad = new PriorityODataClient({ authHeader: "Basic " + Buffer.from("nobody:wrong").toString("base64") } as any);
r = await readEnvironments(bad);
console.log(`   bad identity : ${r.rows.length} rows  ${(r.note ?? "").slice(0, 70)}`);
r = await readEnvironments(new PriorityODataClient());
console.log(`   good identity: ${r.rows.length} rows  ${(r.note ?? "").slice(0, 70)}`);
console.log(r.rows.length === 0 ? "   -> the failure was CACHED and served to the good identity" : "   -> recovered");
process.exit(0);
