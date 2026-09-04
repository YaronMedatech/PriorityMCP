import { PriorityDictionary } from "../src/dictionary.js";
import { PriorityODataClient } from "../src/odata.js";

// Can the screen dictionary be built against this installation?
//
// This is the deployment gate that `probe` is not. probe checks the connection
// and then validates the DOC_TYPES map for get_sales, which is hidden by
// default -- so it can fail for reasons that do not matter. The dictionary is
// different: EFORM is the only source of a screen's Hebrew title, its table and
// its parent/child graph, and dictionary.ts deliberately does NOT catch a
// failure on it the way it catches one on EXEC. Without it search_screens,
// describe_screen, help and readiness_report all fail, and a model with no way
// to look a screen up goes back to inferring one from its English code -- the
// mistake this server exists to prevent.
//
// Measured on one installation: EFORM is listed in the service document and
// still answers 400 "the API cannot be enabled for this screen" until the API
// user is given the system-maintenance module. The message is identical whether
// the screen is closed or the user is unprivileged, so this script says both.
//
// Caching is left ON: a successful run writes the on-disk cache, so the first
// real question does not pay the fetch.

const started = Date.now();
const dict = new PriorityDictionary(new PriorityODataClient());

try {
  await dict.ready();
} catch (err) {
  const message = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
  console.error(`\nDICTFAIL ${message}\n`);
  process.exit(1);
}

const s = dict.stats();
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nDICTOK  built in ${secs}s`);
console.log(`  forms described by EFORM   ${s.forms}`);
console.log(`  published as entity sets   ${s.published}`);
console.log(`  entity sets in the service document ${s.entitySets}`);
console.log(`  entity sets with no EFORM row       ${s.entitySetsWithoutForm}`);
console.log(`  procedures and reports from EXEC    ${s.programs}`);

// Programs are an addition, not the basis: dictionary.ts logs and continues when
// EXEC is refused. Worth saying so here rather than letting a zero pass silently.
if (s.programs === 0) {
  console.log(
    `\n  NOTE: no procedures or reports were read from EXEC, so search_screens\n` +
      `  {kinds:['P','R']} will find nothing and no program can be looked up by\n` +
      `  title. Screens are unaffected. EXEC is a system-maintenance screen; the\n` +
      `  API user usually needs that module.`,
  );
}

process.exit(0);
