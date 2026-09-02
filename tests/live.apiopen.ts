// Re-measure what the API exposes after opening screens in Priority.
//
// Two things can change independently: which forms are PUBLISHED as entity sets,
// and which published screens are actually switched on for the API. The second is
// the one that used to bite -- PARTBAL was published and still refused to be read.
import { PriorityODataClient, ScreenNotEnabledForApi } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";

const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
await dict.ready();

const stats = dict.stats();
console.log(
  `\ndictionary: ${stats.forms} forms, ${stats.published} published, ` +
    `${stats.entitySets} entity sets, ${stats.entitySetsWithoutForm} sets without a form`,
);

// Screens that previously refused to be read, plus the dictionary tables. If any
// of these now work, discovery gets richer than EFORM alone.
const probes = [
  "PARTBAL",
  "PARTBALENV",
  "LASTPARTBAL",
  "ACCBAL",
  "DOCUMENTSA",
  "SALECREDITINVOICES",
  "TABTITLES",
  "COLTITLES",
  "TITLES",
  "COLUMNS",
  "FREPORTS",
  "PROGDESIGN",
  "APPS",
];

console.log("\nreadability (was blocked before the change):");
let nowOpen = 0;
for (const name of probes) {
  const entry = dict.get(name);
  const pub = entry ? (entry.published ? "published" : "NOT published") : "not in dictionary";
  try {
    const rows = await client.query(name, { top: 1 });
    console.log(`  READS   ${name.padEnd(20)} ${pub.padEnd(16)} ${rows.length} row(s)  '${entry?.title ?? "?"}'`);
    nowOpen++;
  } catch (err) {
    const why =
      err instanceof ScreenNotEnabledForApi
        ? "screen not enabled for API"
        : err instanceof Error
          ? err.message.split("\n")[0]?.slice(0, 60)
          : String(err);
    console.log(`  BLOCKED ${name.padEnd(20)} ${pub.padEnd(16)} ${why}`);
  }
}

console.log(`\n${nowOpen} of ${probes.length} probed screens are readable.`);
process.exit(0);
