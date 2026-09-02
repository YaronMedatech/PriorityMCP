// Offline guards for the third-party findings. No Priority server needed.
//
// These run in `npm test` because a traversal fix that is only checked by a live
// script is a fix that stops being checked.
import assert from "node:assert/strict";
import { assertSafePath, UnsafePathError } from "../src/discovery.js";
import type { PriorityDictionary, ScreenEntry } from "../src/dictionary.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

// Just enough dictionary for the allowlist: CUSTOMERS and AINVOICES exist.
const KNOWN = new Set(["CUSTOMERS", "AINVOICES", "PART"]);
const dict = {
  get: (screen: string): ScreenEntry | undefined =>
    KNOWN.has(screen)
      ? { screen, title: screen, table: "T", module: "M", published: true, access: "direct" }
      : undefined,
} as unknown as PriorityDictionary;

const check = (label: string, path: string, shouldPass: boolean) => {
  let threw: unknown;
  try {
    assertSafePath(path, dict);
  } catch (err) {
    threw = err;
  }
  if (shouldPass && threw) {
    bad(`${label}: legitimate path was refused — ${(threw as Error).message.slice(0, 90)}`);
  } else if (!shouldPass && !threw) {
    bad(`${label}: UNSAFE path was allowed (${path})`);
  } else if (!shouldPass && !(threw instanceof UnsafePathError)) {
    bad(`${label}: refused but with the wrong error type (${String(threw)})`);
  } else {
    ok(label);
  }
};

console.log("\n1. Cross-company traversal is refused");
// All three of these reached another company on the live server before the fix.
check("plain ../../", "../../tabula.ini,1/demo/CUSTOMERS?$top=1", false);
check("percent-encoded ..%2F", "..%2F..%2Ftabula.ini%2C1%2Fdemo%2FCUSTOMERS?$top=1", false);
check("backslash ..\\..\\", "..\\..\\tabula.ini,1/demo/CUSTOMERS?$top=1", false);
check("double-encoded ..%252F", "..%252F..%252Ftabula.ini%252C1%252Fdemo%252FCUSTOMERS", false);
check("absolute url", "https://example.invalid/CUSTOMERS", false);
check("protocol-relative", "//example.invalid/CUSTOMERS", false);
check("leading slash", "/tabula.ini,1/demo/CUSTOMERS", false);
check("traversal in a later segment", "CUSTOMERS/../../demo/CUSTOMERS", false);

console.log("\n2. Service paths that are not screen reads are refused");
check("$metadata", "$metadata", false);
check("$count segment", "CUSTOMERS/$count", false);
check("$batch", "$batch", false);

console.log("\n3. Unknown entities are refused (the allowlist, not a shape check)");
check("unknown screen", "NOSUCHSCREEN?$top=1", false);
check("case mismatch is a different screen", "customers?$top=1", false);

console.log("\n4. Legitimate paths still work");
check("plain entity", "CUSTOMERS?$top=10", true);
check("entity with no query", "CUSTOMERS", true);
check(
  "keyed row",
  "AINVOICES(IVNUM='IN224000031',DEBIT='D',IVTYPE='A')",
  true,
);
check(
  "keyed row into a sub-form",
  "AINVOICES(IVNUM='IN224000031',DEBIT='D',IVTYPE='A')/AINVOICEITEMS_SUBFORM?$top=5",
  true,
);
check("filter with a comma and quotes", "CUSTOMERS?$filter=CUSTNAME eq '00000'&$top=1", true);
check("hebrew inside a key", "PART(PARTNAME='מק\"ט')", true);

console.log("\n5. The error explains what to do");
try {
  assertSafePath("../../tabula.ini,1/demo/CUSTOMERS", dict);
  bad("no error raised");
} catch (err) {
  const msg = (err as Error).message;
  assert.ok(msg.length > 0);
  if (/company/i.test(msg)) ok("the refusal says the read is confined to one company");
  else bad(`unhelpful message: ${msg}`);
}

console.log(failures === 0 ? "\nAll security checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
