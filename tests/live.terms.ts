// Find the real screens behind common business terms, so the glossary is built
// from measurement rather than from my assumptions about Priority's naming.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
await dict.ready();

const TERMS = [
  "חשבונית",
  "הזמנת לקוח",
  "הזמנת רכש",
  "תעודת משלוch",
  "תעודת משלוח",
  "לקוחות",
  "ספקים",
  "פריטים",
  "מלאי",
  "יתרות",
  "חוב",
  "גבייה",
  "קבלות",
  "תנועות יומן",
  "כרטיס חשבון",
  "הצעת מחיר",
  "מחירון",
  "עובדים",
  "תמחיר",
  "החזרה",
  "זיכוי",
];

for (const t of TERMS) {
  const r = dict.search(t, { limit: 5 });
  const top = r.matches
    .map((m) => `${m.screen}${m.access === "direct" ? "" : `[${m.access}]`}=${m.title ?? "?"}`)
    .join("  |  ");
  console.log(`\n${t}  (${r.totalMatches} matches)\n   ${top || "(none)"}`);
}
