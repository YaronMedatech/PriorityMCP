import { ConfigError } from "./config.js";
import {
  PriorityODataClient,
  PriorityAuthError,
  PriorityTlsError,
  ScreenNotEnabledForApi,
} from "./odata.js";
import { DOC_TYPES, headerFields, lineFields, type DocType } from "./salesSchema.js";

// Run this FIRST, against your own server, before trusting anything else.
//
// The DOC_TYPES map in salesSchema.ts was derived from one Priority
// installation's metadata. This script re-derives the same facts from YOUR
// server and reports every disagreement, so a mismatch shows up here as a clear
// line of output rather than as a confusing wrong answer in a chat session.

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const warn = (s: string) => console.log(`  ! ${s}`);

let problems = 0;

async function main(): Promise<void> {
  const client = new PriorityODataClient();

  console.log(`\nPriority OData probe`);
  console.log(`  ${client.baseUrl}\n`);

  // -- 1. connectivity + credentials + TLS ----------------------------------
  console.log("1. Connection");
  let sets: string[];
  try {
    sets = await client.entitySets();
    ok(`connected and authenticated — server exposes ${sets.length} entity sets`);
  } catch (err) {
    problems++;
    if (err instanceof PriorityTlsError || err instanceof PriorityAuthError) {
      bad(err.message);
    } else {
      bad(`could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("\nStopping here — nothing else can be checked without a connection.\n");
    process.exit(1);
  }

  // -- 2. per-screen metadata -----------------------------------------------
  console.log("\n2. Sales screens");
  const available: DocType[] = [];

  for (const docType of Object.keys(DOC_TYPES) as DocType[]) {
    const spec = DOC_TYPES[docType];
    console.log(`\n  ${docType} — ${spec.label} (${spec.labelEn})`);

    if (!sets.includes(docType)) {
      problems++;
      bad(`not in the service document — this server does not publish ${docType}`);
      continue;
    }

    let meta;
    try {
      meta = await client.metadataFor(docType);
    } catch (err) {
      problems++;
      bad(
        err instanceof ScreenNotEnabledForApi
          ? "not enabled for the API on this server"
          : `GetMetadataFor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const entity = meta.get(docType);
    if (!entity) {
      problems++;
      bad(`GetMetadataFor returned no EntityType named ${docType}`);
      continue;
    }

    // The date column type decides which OData literal the filter must use.
    const ivdate = entity.props.get("IVDATE");
    if (ivdate) ok(`IVDATE is ${ivdate}`);
    else {
      problems++;
      bad("no IVDATE column — the date-range filter cannot be built");
    }

    // Header columns this tool selects.
    const missingHeader = headerFields(docType).filter((f) => !entity.props.has(f));
    if (missingHeader.length === 0) ok(`all ${headerFields(docType).length} header fields present`);
    else {
      problems++;
      bad(`missing header field(s): ${missingHeader.join(", ")}`);
    }

    // The screen's own Hebrew title, straight from the metadata annotation.
    if (entity.title) ok(`title: ${entity.title}`);
    else warn("no Hebrew title on this entity type");

    // The item-lines navigation property.
    if (entity.navs.has(spec.itemsNav)) {
      const itemsType = entity.navs.get(spec.itemsNav)!.target;
      ok(`items nav ${spec.itemsNav} -> ${itemsType}`);
      const itemsMeta = meta.get(itemsType);
      if (itemsMeta) {
        const missingLine = lineFields(docType).filter((f) => !itemsMeta.props.has(f));
        if (missingLine.length === 0) ok(`all line fields present on ${itemsType}`);
        else {
          problems++;
          bad(`missing line field(s) on ${itemsType}: ${missingLine.join(", ")}`);
        }
      } else {
        warn(`metadata for ${itemsType} not returned — line fields unverified`);
      }
    } else {
      problems++;
      const candidates = [...entity.navs.keys()].filter((n) => /ITEM/i.test(n));
      bad(
        `items nav ${spec.itemsNav} NOT FOUND. ` +
          (candidates.length ? `Candidates: ${candidates.join(", ")}` : "No ITEM-like nav found."),
      );
    }

    // The payments navigation property, where the screen is meant to have one.
    if (spec.paymentsNav) {
      if (entity.navs.has(spec.paymentsNav)) ok(`payments nav ${spec.paymentsNav}`);
      else {
        problems++;
        bad(`payments nav ${spec.paymentsNav} NOT FOUND`);
      }
    }

    available.push(docType);
  }

  // -- 3. one live row per screen -------------------------------------------
  console.log("\n3. Sample row per screen");
  for (const docType of available) {
    try {
      const rows = await client.query(docType, { select: headerFields(docType), top: 1 });
      if (rows.length === 0) {
        warn(`${docType}: query succeeded but the screen has no rows`);
        continue;
      }
      const r = rows[0]!;
      ok(
        `${docType}: IVNUM=${String(r["IVNUM"] ?? "?")} ` +
          `IVDATE=${String(r["IVDATE"] ?? "?")} ` +
          `CODE=${String(r["CODE"] ?? "(local)")} ` +
          `TOTPRICE=${String(r["TOTPRICE"] ?? "?")}`,
      );
    } catch (err) {
      problems++;
      bad(`${docType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    problems === 0
      ? "\nAll checks passed. The DOC_TYPES map matches this server.\n"
      : `\n${problems} problem(s) found. Fix DOC_TYPES in src/salesSchema.ts to match this server ` +
          `(or open the screens for the API in Priority) before relying on results.\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`\nConfiguration error:\n\n${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
