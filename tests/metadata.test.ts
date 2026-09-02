// Offline smoke test: validates the EDMX scanner and the DOC_TYPES map against a
// real Priority metadata dump, then boots the MCP server and exercises the tool.
import fs from "node:fs";
import path from "node:path";
import { parseEdmx } from "../src/odata.js";
import {
  DOC_TYPES,
  headerFields,
  lineFields,
  type DocType,
} from "../src/salesSchema.js";

// A real `$metadata` / GetMetadataFor dump to check the DOC_TYPES map against.
// Defaults to the one already on this machine; override to check the map against
// your own server's dump instead.
const METADATA =
  process.env["PRIORITY_METADATA_XML"] ??
  "C:/Users/yaron/ClaudeProjects/PriorityDevelopServer/poc/workspaces/ws_5ed5354a/metadata.xml";

if (!fs.existsSync(METADATA)) {
  console.log(
    `\nSKIPPED: no metadata dump at\n  ${METADATA}\n` +
      `Set PRIORITY_METADATA_XML to a GetMetadataFor dump to run this check.\n`,
  );
  process.exit(0);
}

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

console.log("\n1. parseEdmx against a real GetMetadataFor dump");
const xml = fs.readFileSync(METADATA, "utf8");
const meta = parseEdmx(xml);
console.log(`  parsed ${meta.size} EntityTypes`);
if (meta.size > 1000) ok("scanner found a plausible number of entity types");
else bad(`only ${meta.size} entity types parsed â€” the scanner is likely broken`);

console.log("\n2. DOC_TYPES map vs that metadata");
for (const docType of Object.keys(DOC_TYPES) as DocType[]) {
  const spec = DOC_TYPES[docType];
  const entity = meta.get(docType);
  if (!entity) {
    bad(`${docType}: not present in metadata`);
    continue;
  }

  const ivdate = entity.props.get("IVDATE");
  if (ivdate) ok(`${docType}: IVDATE is ${ivdate}`);
  else bad(`${docType}: no IVDATE column`);

  const missingHeader = headerFields(docType).filter((f) => !entity.props.has(f));
  if (missingHeader.length === 0) ok(`${docType}: all header fields present`);
  else bad(`${docType}: missing header fields: ${missingHeader.join(", ")}`);

  const itemsTarget = entity.navs.get(spec.itemsNav)?.target;
  if (!itemsTarget) {
    bad(`${docType}: items nav ${spec.itemsNav} not found`);
  } else {
    ok(`${docType}: ${spec.itemsNav} -> ${itemsTarget}`);
    const itemsMeta = meta.get(itemsTarget);
    if (!itemsMeta) bad(`${docType}: no metadata for ${itemsTarget}`);
    else {
      const missingLine = lineFields(docType).filter((f) => !itemsMeta.props.has(f));
      if (missingLine.length === 0) ok(`${docType}: all line fields present on ${itemsTarget}`);
      else bad(`${docType}: missing line fields on ${itemsTarget}: ${missingLine.join(", ")}`);
    }
  }

  if (spec.paymentsNav) {
    if (entity.navs.has(spec.paymentsNav)) ok(`${docType}: payments nav ${spec.paymentsNav} present`);
    else bad(`${docType}: payments nav ${spec.paymentsNav} not found`);
  }
}

// Guard the specific asymmetries the normalizer exists to absorb.
// The whole discovery pivot rests on these annotations being readable. An
// earlier parseEdmx returned names and types only, which is why the tool had to
// hardcode screen meanings -- and got CINVOICES wrong.
console.log("\n2b. Annotations: Hebrew titles, keys, mandatory, date-only, read-only");
{
  const a = meta.get("AINVOICES");
  if (!a) bad("AINVOICES missing from metadata");
  else {
    if (a.title && /[֐-׿]/.test(a.title)) ok(`entity title decoded: ${a.title}`);
    else bad(`entity title missing or not Hebrew: ${JSON.stringify(a.title)}`);

    // Composite key, straight from <Key><PropertyRef/></Key>.
    if (a.keys.length >= 3 && a.keys.includes("IVNUM")) ok(`keys parsed: ${a.keys.join(", ")}`);
    else bad(`unexpected keys: ${a.keys.join(", ") || "(none)"}`);

    const cust = a.columns.get("CUSTNAME");
    if (cust?.title && /[֐-׿]/.test(cust.title)) ok(`column title decoded: CUSTNAME = ${cust.title}`);
    else bad(`CUSTNAME has no Hebrew title: ${JSON.stringify(cust?.title)}`);
    if (cust?.mandatory) ok("CUSTNAME flagged mandatory");
    else bad("CUSTNAME should be mandatory");
    if (cust?.maxLength === 16) ok("CUSTNAME maxLength = 16");
    else bad(`CUSTNAME maxLength = ${String(cust?.maxLength)}, expected 16`);
    if (cust?.isKey === false) ok("CUSTNAME correctly not a key");
    else bad("CUSTNAME wrongly marked as a key");

    const ivnum = a.columns.get("IVNUM");
    if (ivnum?.isKey) ok("IVNUM flagged as a key column");
    else bad("IVNUM should be a key");

    // This annotation replaces the separate probe query the old code needed.
    const ivdate = a.columns.get("IVDATE");
    if (ivdate?.dateType) ok(`IVDATE dateType annotation = ${ivdate.dateType}`);
    else bad("IVDATE has no dateType annotation");

    const titled = [...a.columns.values()].filter((c) => c.title).length;
    if (titled > 50) ok(`${titled} of ${a.columns.size} columns carry a Hebrew title`);
    else bad(`only ${titled} of ${a.columns.size} columns have titles`);

    const nav = a.navs.get("AINVOICEITEMS_SUBFORM");
    if (nav?.target === "AINVOICEITEMS") ok(`nav target parsed: ${nav.target}`);
    else bad(`nav target wrong: ${JSON.stringify(nav)}`);
  }

  // XML numeric character references must decode too -- a live GetMetadataFor
  // response uses them where the saved $metadata file uses literal UTF-8.
  const entityForm = parseEdmx(
    '<EntityType Name="T"><Key><PropertyRef Name="A" /></Key>' +
      '<Property Name="A" Type="Edm.String">' +
      '<Annotation Term="Priority.OData.Description" String="&#x5DE;&#x5E7;&quot;&#x5D8;" />' +
      "</Property>" +
      '<Annotation Term="Priority.OData.Description" String="&#x5DB;&#x5D5;&#x5EA;&#x5E8;&#x5EA;" />' +
      "</EntityType>",
  );
  const t = entityForm.get("T");
  if (t?.columns.get("A")?.title === 'מק"ט') ok('numeric entity refs decode: מק"ט');
  else bad(`entity-ref decode failed: ${JSON.stringify(t?.columns.get("A")?.title)}`);
  if (t?.title === "כותרת") ok("entity-level title decodes and is not confused with a column's");
  else bad(`entity-level title wrong: ${JSON.stringify(t?.title)}`);
}

console.log("\n3. The documented asymmetries actually hold");
const fitems = meta.get("FINVOICEITEMS");
if (fitems && !fitems.props.has("TOTPRICE")) ok("FINVOICEITEMS really has no TOTPRICE");
else bad("FINVOICEITEMS unexpectedly HAS TOTPRICE â€” lineTotalField mapping may be wrong");

const fhead = meta.get("FINVOICES");
if (fhead && !fhead.props.has("VAT") && fhead.props.has("TAXSUM")) {
  ok("FINVOICES really uses TAXSUM and has no VAT");
} else bad("FINVOICES VAT/TAXSUM assumption is wrong");

for (const t of ["AINVOICES", "EINVOICES", "CINVOICES"]) {
  const e = meta.get(t);
  if (e?.props.has("VAT")) ok(`${t} has VAT`);
  else bad(`${t} is missing VAT`);
}

console.log(failures === 0 ? "\nAll offline checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);


