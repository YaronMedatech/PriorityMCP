// Walks the discovery path a model would take for an inventory question, with no
// LLM involved: search by Hebrew concept -> describe -> query. Proves the server
// side is ready independently of Claude API credit.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { describeScreen, runQuery, searchScreens } from "../src/discovery.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);

console.log("\n1. Find inventory screens by Hebrew concept");
const found = (await searchScreens(dict, { query: "מלאי נוכחי", limit: 5 })) as {
  totalMatches: number;
  screens: { screen: string; title: string | null; published: boolean }[];
};
if (found.totalMatches > 0) {
  ok(`'מלאי נוכחי' -> ${found.totalMatches} matches`);
  for (const s of found.screens) console.log(`       ${s.screen.padEnd(18)} '${s.title}'`);
} else bad("no inventory screens found");

console.log("\n2. Describe the balance screen");
const desc = (await describeScreen(client, dict, { screen: "PARTBAL" })) as {
  title?: string | null;
  error?: string;
  columnCount?: number;
  columns?: { name: string; title: string | null }[];
};
if (desc.error) {
  bad(`PARTBAL still not describable: ${desc.error.split("\n")[0]}`);
} else {
  ok(`PARTBAL = '${desc.title}', ${desc.columnCount} columns`);
  console.log(
    `       ${(desc.columns ?? []).slice(0, 6).map((c) => `${c.name}='${c.title}'`).join(", ")}`,
  );
}

console.log("\n3. Read actual stock rows");
const rows = (await runQuery(client, dict, {
  entity: "PARTBAL",
  select: "PARTNAME,PARTDES,WARHSNAME,BALANCE,UNITNAME",
  top: 5,
})) as { rowCount: number; rows: Record<string, unknown>[] };
if (rows.rowCount > 0) {
  ok(`read ${rows.rowCount} stock rows from PARTBAL`);
  for (const r of rows.rows) {
    console.log(
      `       ${String(r["PARTNAME"] ?? "").padEnd(14)} ` +
        `${String(r["PARTDES"] ?? "").slice(0, 26).padEnd(28)} ` +
        `${String(r["WARHSNAME"] ?? "").padEnd(10)} ${String(r["BALANCE"] ?? "")}`,
    );
  }
} else bad("PARTBAL returned no rows");

console.log(
  failures === 0
    ? "\nThe discovery path works end to end without an LLM.\n"
    : `\n${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
