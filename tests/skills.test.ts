// Skills offline: the column-agnostic listing, the keyed-path fetch, and the
// wording when the screen is closed -- which is the state of the reference
// installation, so the closed path is the one users will actually see first.
import type { PriorityODataClient } from "../src/odata.js";
import { fetchSkill, listSkills, matchSkills, resetSkillsCache } from "../src/skills.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const meta = (keys: string[], cols: string[]) =>
  new Map([["AIWORKFLOWS", { name: "AIWORKFLOWS", title: null, keys, columns: new Map(cols.map((c) => [c, { name: c }])), navs: new Map(), props: new Map() }]]);

console.log("\n1. A closed screen is a reason, not an absence");
{
  const closed = {
    baseUrl: "https://h/odata/Priority/t.ini/zepc",
    metadataFor: async () => {
      throw new Error('The Priority screen AIWORKFLOWS is not available to the API (HTTP 400 "לא ניתן להפעיל API למסך זה").\n\nTwo causes...');
    },
    query: async () => [],
  } as unknown as PriorityODataClient;
  resetSkillsCache();
  const o = await listSkills(closed);
  if (!o.available && o.permission && /תחזוקת מערכת|opened for the API/.test(o.reason) && !/no skills/i.test(o.reason.split("Say that")[0] ?? "")) {
    ok("400 API-disabled explains both causes and does not say 'no skills'");
  } else bad(JSON.stringify(o));
  const s = await fetchSkill(closed, { CODE: "X" });
  if (!s.available && s.permission) ok("get_skill on a closed screen carries the same reason");
  else bad(JSON.stringify(s));
}

console.log("\n2. Listing reads keys and title from metadata, not from assumptions");
let queries: string[] = [];
const open = {
  baseUrl: "https://h/odata/Priority/t.ini/demo",
  metadataFor: async () => meta(["SKILLCODE"], ["SKILLCODE", "SKILLDES", "ACTIVE", "SORT"]),
  query: async (entity: string) => {
    queries.push(entity);
    return [
      { SKILLCODE: "INV-CLOSE", SKILLDES: "סגירת חשבונית", ACTIVE: "Y", SORT: 0 },
      { SKILLCODE: "PO-APPROVE", SKILLDES: "אישור הזמנת רכש", ACTIVE: "Y", SORT: 2 },
    ];
  },
  queryRawPath: async (path: string) => {
    queries.push(path);
    return [
      { LINE: 1, TEXT: "<p dir=rtl>שלב 1: פתח את {AINVOICES.F}</p>" },
      { LINE: 2, TEXT: "<p>שלב 2: ודא סטטוס</p>" },
    ];
  },
} as unknown as PriorityODataClient;
resetSkillsCache();
const list = await listSkills(open);
if (list.available && list.count === 2 && list.keyColumns.join() === "SKILLCODE") ok("two skills, key column from metadata");
else bad(JSON.stringify(list).slice(0, 200));
if (list.available && list.skills[0]?.title === "סגירת חשבונית" && list.skills[0].key["SKILLCODE"] === "INV-CLOSE") ok("title picked from the *DES column, key from the key column");
else bad(JSON.stringify(list.available ? list.skills[0] : list));
if (list.available && !("SORT" in list.skills[0]!.fields)) ok("zero-valued columns are dropped from 'fields'");
else bad("SORT=0 kept");

console.log("\n3. Fetch uses the KEYED PATH, never $expand");
queries = [];
const one = await fetchSkill(open, { SKILLCODE: "INV-CLOSE" });
if (one.available && /שלב 1/.test(one.text) && /שלב 2/.test(one.text) && !/<p/.test(one.text) && one.lines === 2) {
  ok("two text rows joined, HTML removed");
} else bad(JSON.stringify(one).slice(0, 200));
if (queries.some((q) => q === "AIWORKFLOWS(SKILLCODE='INV-CLOSE')/AIWORKFLOWSTEXT_SUBFORM")) ok("the path is AIWORKFLOWS(key)/AIWORKFLOWSTEXT_SUBFORM");
else bad(`queries: ${JSON.stringify(queries)}`);
if (!queries.some((q) => /expand/i.test(q))) ok("no $expand anywhere");
else bad("an expand was used");
const wrong = await fetchSkill(open, { SKILLCODE: "NOPE" });
if (!wrong.available && /No skill with key/.test(wrong.reason)) ok("an unknown key is refused before any request");
else bad(JSON.stringify(wrong));
const missing = await fetchSkill(open, {});
if (!missing.available && /needs SKILLCODE/.test(missing.reason)) ok("a missing key column is named");
else bad(JSON.stringify(missing));

console.log("\n4. Matching for search_screens");
if (matchSkills(list, "אישור הזמנת רכש").length === 1 && matchSkills(list, "x").length === 0) ok("a skill matches by title; a too-short query matches nothing");
else bad("matching");
if (matchSkills({ available: false, reason: "closed" }, "אישור").length === 0) ok("a closed outcome matches nothing, quietly");
else bad("closed outcome matched");

console.log("\n5. The listing is cached, including its refusal");
{
  let calls = 0;
  const counting = {
    baseUrl: "https://h/odata/Priority/t.ini/count",
    metadataFor: async () => {
      calls++;
      throw new Error("HTTP 403 refused");
    },
    query: async () => [],
  } as unknown as PriorityODataClient;
  resetSkillsCache();
  await listSkills(counting);
  await listSkills(counting);
  if (calls === 1) ok("second call within the TTL made no request");
  else bad(`${calls} requests`);
}

console.log(failures === 0 ? "\nAll skills checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
