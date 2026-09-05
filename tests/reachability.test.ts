// Which programs the model is shown, and how they are described.
//
// Two facts from the generator screens drive this, and both were operator
// knowledge before they were code:
//
//   EREP's REPMENU / REPPROG / REPDOC and EPROG's PROGMENU / PROGPROG say how a
//   Priority USER reaches a program. Linked from none of them, nobody can run it
//   from the UI, so offering it to a model offers something the business does
//   not have.
//
//   EPROG.RS='R' marks a PROCEDURE that is really a report. A third of them on
//   the reference installation carry it, and the program tools warn that a
//   procedure can change, post or delete data -- a warning that is false for
//   every one of those, and that discourages a harmless read.
//
// The distinction this suite exists to protect is the third state. "Linked from
// nothing" and "the screen that would have said was closed" must never be
// treated alike: EREP and EPROG are system-maintenance screens, and an
// installation that keeps them shut would otherwise have EVERY program hidden.
import type { PriorityODataClient } from "../src/odata.js";
import { PriorityDictionary } from "../src/dictionary.js";
import { searchScreens } from "../src/discovery.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const forms = [{ ENAME: "AINVOICES", TITLE: "חשבוניות מס", TNAME: "INVOICES", MODULENAME: "m", FLINK_SUBFORM: [] }];

// Four programs covering every case the code distinguishes.
const exec = [
  { ENAME: "ONMENU", TYPE: "R", TITLE: "דוח על תפריט", MODULENAME: "m" },
  { ENAME: "VIAPROG", TYPE: "R", TITLE: "דוח דרך תוכנית", MODULENAME: "m" },
  { ENAME: "ORPHANREP", TYPE: "R", TITLE: "דוח יתום", MODULENAME: "m" },
  { ENAME: "REPORTPROC", TYPE: "P", TITLE: "פרוצדורת דוח", MODULENAME: "m" },
  { ENAME: "ACTINGPROC", TYPE: "P", TITLE: "פרוצדורה שפועלת", MODULENAME: "m" },
  { ENAME: "ODDCODE", TYPE: "P", TITLE: "פרוצדורה עם קוד לא מוכר", MODULENAME: "m" },
];

const erep = [
  { ENAME: "ONMENU", REPMENU_SUBFORM: [{ ENAME: "SOMEMENU" }], REPPROG_SUBFORM: [], REPDOC_SUBFORM: [] },
  { ENAME: "VIAPROG", REPMENU_SUBFORM: [], REPPROG_SUBFORM: [{ ENAME: "SOMEPROG" }], REPDOC_SUBFORM: [] },
  { ENAME: "ORPHANREP", REPMENU_SUBFORM: [], REPPROG_SUBFORM: [], REPDOC_SUBFORM: [] },
];
const eprog = [
  { ENAME: "REPORTPROC", RS: "R", PROGMENU_SUBFORM: [{ ENAME: "SOMEMENU" }], PROGPROG_SUBFORM: [] },
  { ENAME: "ACTINGPROC", RS: "", PROGMENU_SUBFORM: [{ ENAME: "SOMEMENU" }], PROGPROG_SUBFORM: [] },
  { ENAME: "ODDCODE", RS: "d", PROGMENU_SUBFORM: [{ ENAME: "SOMEMENU" }], PROGPROG_SUBFORM: [] },
];

function client(opts: { links: boolean }): PriorityODataClient {
  return {
    entitySets: async () => ["AINVOICES"],
    query: async (entity: string) => {
      if (entity === "EFORM") return forms;
      if (entity === "EXEC") return exec;
      if (entity === "EREP") {
        if (!opts.links) throw new Error("HTTP 400 the screen is not available to the API");
        return erep;
      }
      if (entity === "EPROG") {
        if (!opts.links) throw new Error("HTTP 400 the screen is not available to the API");
        return eprog;
      }
      throw new Error(`unexpected entity ${entity}`);
    },
  } as unknown as PriorityODataClient;
}

const PROGRAMS = { catalogued: new Set<string>(), policy: "all" as const };
const names = (r: unknown): string[] =>
  ((r as { screens: { screen: string }[] }).screens ?? []).map((s) => s.screen);

console.log("\n1. A program linked from nothing is hidden; one linked anywhere is not");
{
  const dict = new PriorityDictionary(client({ links: true }), { cache: false });
  const shown = names(
    await searchScreens(dict, { query: "", limit: 50, kinds: ["P", "R"] }, undefined, undefined, PROGRAMS),
  );
  if (shown.includes("ONMENU")) ok("a report on a menu is shown");
  else bad("a report on a menu was hidden");
  if (shown.includes("VIAPROG")) ok("a report reached through a program is shown -- menu is not the only link");
  else bad("a report linked only from a program was hidden; REPPROG is being ignored");
  if (!shown.includes("ORPHANREP")) ok("a report linked from nothing is hidden");
  else bad("an unreachable report was offered to the model");
}

console.log("\n2. includeUnreachable brings the orphan back, for an audit");
{
  const dict = new PriorityDictionary(client({ links: true }), { cache: false });
  const shown = names(
    await searchScreens(
      dict,
      { query: "", limit: 50, kinds: ["P", "R"], includeUnreachable: true },
      undefined,
      undefined,
      PROGRAMS,
    ),
  );
  if (shown.includes("ORPHANREP")) ok("the orphan is returned when asked for");
  else bad("includeUnreachable did not bring it back");
}

console.log("\n3. UNKNOWN is not UNREACHABLE: a closed EREP/EPROG hides nothing");
{
  // The state this installation was actually in until an operator opened the
  // generator screens. Treating the two alike would have hidden all 9,550.
  const dict = new PriorityDictionary(client({ links: false }), { cache: false });
  const shown = names(
    await searchScreens(dict, { query: "", limit: 50, kinds: ["P", "R"] }, undefined, undefined, PROGRAMS),
  );
  for (const n of ["ONMENU", "VIAPROG", "ORPHANREP", "REPORTPROC", "ACTINGPROC"]) {
    if (!shown.includes(n)) bad(`${n} was hidden although reachability could not be read`);
  }
  if (shown.length === 6) ok("every program survives when the link screens are closed");
  else bad(`expected all 6 programs, got ${shown.length}: ${shown.join(", ")}`);
}

console.log("\n4. RS='R' marks a procedure as a report; other codes are not interpreted");
{
  const dict = new PriorityDictionary(client({ links: true }), { cache: false });
  const res = (await searchScreens(
    dict,
    { query: "", limit: 50, kinds: ["P", "R"] },
    undefined,
    undefined,
    PROGRAMS,
  )) as { screens: Record<string, unknown>[] };
  const by = (n: string) => res.screens.find((s) => s["screen"] === n) ?? {};

  const rep = by("REPORTPROC");
  if (rep["actuallyAReport"] === true && rep["reportLike"] === true) {
    ok("a P with RS='R' is flagged as a report");
  } else bad(`REPORTPROC not flagged: ${JSON.stringify(rep)}`);
  if (String(rep["rsNote"] ?? "").includes("does not apply")) {
    ok("and says the procedure warning does not apply to it");
  } else bad("no rsNote explaining why the warning is lifted");

  const acting = by("ACTINGPROC");
  if (!acting["actuallyAReport"] && acting["reportLike"] === false) {
    ok("a P with no RS stays a procedure that can act");
  } else bad(`ACTINGPROC was flagged as a report: ${JSON.stringify(acting)}`);

  const odd = by("ODDCODE");
  if (odd["reportLike"] === false && String(odd["rsNote"] ?? "").includes("does not know what it means")) {
    ok("an unrecognised RS code is passed through and explicitly NOT interpreted");
  } else bad(`ODDCODE mishandled: ${JSON.stringify(odd)}`);

  const onMenu = by("ONMENU");
  if (Array.isArray(onMenu["reachableFrom"]) && (onMenu["reachableFrom"] as string[])[0] === "menu") {
    ok("reachableFrom names the link kind");
  } else bad(`reachableFrom missing or wrong: ${JSON.stringify(onMenu["reachableFrom"])}`);
}

console.log(failures === 0 ? "\nAll reachability checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
