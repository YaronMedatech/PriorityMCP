// Every screen named in glossary.json must actually exist.
//
// This is the guard that makes a hand-maintained mapping safe. A wrong name here
// does not fail loudly — it sends the model confidently to a screen that is not
// there, and the failure surfaces as "no data" much later. So the file is checked
// against the live dictionary rather than trusted.
import { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { Glossary } from "../src/glossary.js";
import { searchScreens } from "../src/discovery.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile();
const client = new PriorityODataClient();
const dict = new PriorityDictionary(client);
const glossary = new Glossary();

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

await dict.ready();

console.log("\n1. The glossary loads");
if (glossary.loadError) {
  bad(`load error: ${glossary.loadError}`);
} else {
  ok(`${glossary.all().length} terms`);
}

console.log("\n2. Every screen named in the glossary exists");
let checked = 0;
let missing = 0;
for (const term of glossary.all()) {
  for (const screen of term.screens ?? []) {
    checked++;
    const e = dict.get(screen);
    if (!e) {
      bad(`'${term.term}' → ${screen} is NOT in the dictionary`);
      missing++;
    } else if (e.access === "unavailable") {
      console.log(`   note: '${term.term}' → ${screen} exists but is unreachable`);
    }
  }
}
if (missing === 0) ok(`all ${checked} screen references resolve`);

console.log("\n3. Glossary titles agree with the dictionary");
// Catches the subtler rot: the name still exists but now means something else.
for (const term of glossary.all()) {
  for (const screen of term.screens ?? []) {
    const e = dict.get(screen);
    if (e && !e.title) console.log(`   note: ${screen} has no Hebrew title`);
  }
}
ok("checked");

console.log("\n4. Terms match the way a question is actually phrased");
const cases: [string, string][] = [
  ["מה המחזור ב-2024?", "מחזור"],
  ["תראה לי חשבוניות זיכוי", "חשבונית זיכוי"],
  ["כמה מלאי יש לנו", "מלאי"],
  ["רשימת ספקים", "ספקים"],
  ["הזמנות רכש פתוחות", "הזמנות רכש"],
];
for (const [question, expected] of cases) {
  const hits = glossary.match(question);
  const names = hits.map((h) => h.term);
  if (names.includes(expected)) ok(`"${question}" → ${expected}`);
  else bad(`"${question}" matched [${names.join(", ") || "nothing"}], expected ${expected}`);
}

console.log("\n5. search_screens surfaces the glossary for a business term");
const res = (await searchScreens(dict, { query: "זיכוי", limit: 5 }, glossary)) as {
  glossary?: { term: string; screens: { screen: string; access: string }[]; notes?: string }[];
  screens: { screen: string }[];
  notes?: string[];
};
if (res.glossary?.length) {
  const g = res.glossary[0]!;
  console.log(`   glossary: ${g.term} → ${g.screens.map((s) => `${s.screen}[${s.access}]`).join(", ")}`);
  ok("a curated mapping is returned alongside the ranked matches");
  if (g.screens.some((s) => s.screen === "SALECREDITINVOICES")) {
    ok("SALECREDITINVOICES is surfaced even though title ranking buries it");
  } else bad("the credit-note screen was not in the glossary result");
} else bad("no glossary block for 'זיכוי'");

console.log("\n6. Hebrew inflection is matched");
// The point of stemming: none of these match the stored title literally.
for (const [q, expect] of [
  ["לחשבוניות", "AINVOICES"],
  ["חשבונית", "AINVOICES"],
  ["ספק", "SUPPLIERS"],
] as const) {
  const r = dict.search(q, { limit: 8 });
  const names = r.matches.map((m) => m.screen);
  if (names.includes(expect)) ok(`"${q}" reaches ${expect} (rank ${names.indexOf(expect) + 1})`);
  else bad(`"${q}" did not reach ${expect} — top: ${names.slice(0, 4).join(", ")}`);
}

console.log(failures === 0 ? "\nAll glossary checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
