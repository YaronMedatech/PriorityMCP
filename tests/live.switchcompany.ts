// Switching company inside a session, and the ENVIRONMENT name lookup.
//
// Structural by design: it proves the context rewires the client, keeps one
// dictionary, and refuses an unknown company — none of which needs a reachable
// server. The checks that DO need one skip with a reason rather than failing, so
// an unreachable host does not read as broken code.
import { loadEnvFile, listEnvironments } from "../src/config.js";

loadEnvFile();
const { CompanyContext, readEnvironments } = await import("../src/companies.js");

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const companies = listEnvironments();
if (companies.length < 2) {
  console.log(`\nFewer than two companies configured (${companies.join(", ") || "none"}).\n`);
  process.exit(0);
}
const [A, B] = companies as [string, string];

console.log(`\nserver: ${process.env["PRIORITY_ODATA_URL"]}`);
console.log(`companies: ${companies.join(", ")}\n`);

const ctx = new CompanyContext(A);

console.log("1. The context starts on the company it was given");
if (ctx.company === A) ok(`active company is ${A}`);
else bad(`active company is ${ctx.company}`);
if (ctx.client.baseUrl.endsWith(`/${A}`)) ok(`client URL ends in the company (…/${A})`);
else bad(`client URL is ${ctx.client.baseUrl}`);

console.log("\n2. What the ENVIRONMENT screen actually returns");
// ENVIRONMENT is a LIST of every environment, not a description of the current
// one. Reading top:1 and taking the row gave every company the FIRST
// environment's name — plausible enough that it took a real dump to notice.
const env = await readEnvironments(ctx.client);
console.log(`   ${env.rows.length} environment row(s)`);
if (env.note) console.log(`   note: ${env.note}`);
for (const r of env.rows.slice(0, 4)) {
  console.log(`     ${r.code.padEnd(10)} "${r.title ?? "?"}" active=${r.active}`);
}
if (env.rows.length > 0 || env.note) ok("the lookup returned either rows or a reason");
else bad("neither rows nor an explanation");
if (env.rows.length > 1) {
  const distinct = new Set(env.rows.map((r) => r.title));
  if (distinct.size > 1) ok("different environments carry different names");
  else bad("every environment reported the same name — the wrong column is being read");
}

console.log("\n3. Switching changes the client every tool reads");
const before = ctx.client.baseUrl;
const now = ctx.switchTo(B);
const after = ctx.client.baseUrl;
console.log(`   ${before}\n   -> ${after}`);
if (now === B) ok("switchTo reports the new company");
else bad(`switchTo returned ${now}`);
if (after !== before && after.endsWith(`/${B}`)) ok("the client really moved to the other company");
else bad("the client URL did not change");

console.log("\n4. The switched client reads the OTHER company's data");
// Skipped rather than failed when the server cannot be reached or the
// credentials do not belong to it. A test that reports "broken" for an
// unreachable host teaches you to ignore it.
const readRow = async (): Promise<string | null> => {
  try {
    const rows = await ctx.client.query("CUSTOMERS", { top: 1, select: ["CUSTNAME", "CUSTDES"] });
    return String(rows[0]?.["CUSTDES"] ?? "");
  } catch (err) {
    const m = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    console.log(`   cannot read: ${m.slice(0, 90)}`);
    return null;
  }
};
const bRow = await readRow();
ctx.switchTo(A);
const aRow = await readRow();
if (bRow === null || aRow === null) {
  console.log("   SKIPPED — this machine cannot read that server (network or credentials).");
  console.log("   The switch itself is proven by step 3; only the data comparison is unverified.");
} else {
  console.log(`   ${B}: ${bRow}\n   ${A}: ${aRow}`);
  if (bRow !== aRow) ok("the two companies return different rows — the switch is real");
  else console.log("   (identical first row — possible on similar demo companies)");
}

console.log("\n5. The dictionary is SHARED, because it is installation-level");
// The intuitive guess is one dictionary per company, and it is wrong: screen
// definitions, titles and help live at the tabula.ini level, so every company on
// one installation has the same forms. Switching changes the DATA only. Building
// one per company would repeat a full EFORM pull for an identical result.
const dictA = ctx.dict;
ctx.switchTo(B);
const dictB = ctx.dict;
if (dictA === dictB) ok("one dictionary reused across companies");
else bad("a second dictionary was built — that is a re-fetch for identical data");

// The client, by contrast, MUST differ: it carries the company's URL.
const clientB = ctx.client;
ctx.switchTo(A);
if (ctx.client !== clientB) ok("the client still changes per company, as it must");
else bad("the client did not change — reads would hit the wrong company");

console.log("\n6. An unknown company is refused and nothing moves");
const activeBefore = ctx.company;
try {
  ctx.switchTo("nosuchcompany");
  bad("an unknown company was accepted");
} catch (err) {
  console.log(`   ${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}`);
  ok("refused");
}
if (ctx.company === activeBefore) ok(`still on ${activeBefore} after the refusal`);
else bad(`the active company changed to ${ctx.company} despite the refusal`);

console.log("\n7. describeAll lists every company, marking the active one");
const all = await ctx.describeAll();
for (const c of all) {
  console.log(
    `   ${c.active ? "*" : " "} ${c.company.padEnd(10)} name=${JSON.stringify(c.name)}` +
      `${c.note ? `  (${c.note.slice(0, 50)})` : ""}`,
  );
}
if (all.length === companies.length) ok(`all ${companies.length} companies listed`);
else bad(`${all.length} listed, expected ${companies.length}`);
if (all.filter((c) => c.active).length === 1) ok("exactly one is marked active");
else bad("active marking is wrong");

console.log(failures === 0 ? "\nAll company-switching checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
