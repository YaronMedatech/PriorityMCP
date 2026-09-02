// What actually determines whether a document adds to or subtracts from sales?
//
// The old code assumed it from the screen name and got CINVOICES wrong. DEBIT and
// IVTYPE are both part of AINVOICES' primary key, which makes them the likely
// carriers of document direction. This measures that rather than assuming it.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";

const from = process.argv[2] ?? "2020-01-01";
const to = process.argv[3] ?? "2027-01-01";

const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
await dict.ready();

for (const screen of ["AINVOICES", "EINVOICES", "FINVOICES", "CINVOICES"]) {
  const title = dict.get(screen)?.title ?? "?";
  let rows: Record<string, unknown>[];
  try {
    rows = await client.query(screen, {
      select: ["IVNUM", "IVDATE", "TOTPRICE", "DEBIT", "IVTYPE", "STORNOFLAG"],
      filter: `IVDATE ge ${from}T00:00:00Z and IVDATE lt ${to}T00:00:00Z and FINAL eq 'Y'`,
      top: 500,
    });
  } catch (err) {
    console.log(`\n${screen} (${title}): ERROR ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    continue;
  }

  console.log(`\n${screen} — ${title}   (${rows.length} final rows)`);

  const groups = new Map<string, { n: number; pos: number; neg: number; zero: number; sum: number }>();
  for (const r of rows) {
    const key = `DEBIT=${String(r["DEBIT"] ?? "-")} IVTYPE=${String(r["IVTYPE"] ?? "-")}`;
    const g = groups.get(key) ?? { n: 0, pos: 0, neg: 0, zero: 0, sum: 0 };
    const t = Number(r["TOTPRICE"] ?? 0);
    g.n++;
    g.sum += t;
    if (t > 0) g.pos++;
    else if (t < 0) g.neg++;
    else g.zero++;
    groups.set(key, g);
  }

  for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `   ${key.padEnd(26)} n=${String(g.n).padStart(4)}  ` +
        `TOTPRICE +${String(g.pos).padStart(4)} / -${String(g.neg).padStart(4)} / 0:${String(g.zero).padStart(3)}  ` +
        `sum=${g.sum.toFixed(2).padStart(14)}`,
    );
  }
}

console.log(`
Reading this: if a screen's rows are all TOTPRICE>0 then the screen itself carries
no direction and must NOT be negated. A screen that mixes signs carries direction
per row, in TOTPRICE, and negating the whole screen would double-count it.`);

process.exit(0);
