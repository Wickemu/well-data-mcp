// Print the README coverage tables (markdown) from the source registry, so the
// README never drifts from what the server actually serves.
// Usage: node scripts/coverage-table.js > coverage.md   (then paste into README.md)

import { SOURCES, NO_REGISTRY_NOTES } from "../src/sources/index.js";

// Country (ISO 3166-1 alpha-2) -> README section. A country missing here lands in "Other".
const LATIN_AMERICA = "AR BO BR BZ CL CO CR CU DO EC GT GY HN HT JM MX NI PA PE PY SR SV TT UY VE GP MQ".split(" ");
const EUROPE = "AL AT BA BE BG BY CH CY CZ DE DK EE ES EU FI FO FR GB GE GL GR HR HU IE IS IT LT LU LV MD ME MK MT NL NO PL PT RO RS SE SI SK TR UA AZ AM".split(" ");
const AFRICA = "AO BF BJ BW CD CG CI CM DJ DZ EG ER ET GA GH GM GN GQ KE LR LY MA MG ML MR MU MW MZ NA NE NG RW SD SL SN SO SS TD TG TN TZ UG ZA ZM ZW".split(" ");
const ASIA = "AE AF BD BH BN CN HK ID IL IN IQ IR JO JP KG KH KR KW KZ LA LB LK MM MN MY NP OM PH PK QA SA SG SY TH TJ TL TM TW UZ VN YE".split(" ");
const REGIONS = [
  ["United States", (s) => s.country === "US" && !s.key.startsWith("OCS-")],
  ["US federal offshore", (s) => s.key.startsWith("OCS-")],
  ["Canada", (s) => s.country === "CA"],
  ["Latin America & Caribbean", (s) => LATIN_AMERICA.includes(s.country)],
  ["Europe", (s) => EUROPE.includes(s.country)],
  ["Africa", (s) => AFRICA.includes(s.country)],
  ["Asia & Middle East", (s) => ASIA.includes(s.country)],
  ["Oceania", (s) => ["AU", "NZ", "PG", "FJ"].includes(s.country)],
  ["Other", () => true],
];

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
const protocol = (s) => s.via ?? { arcgis: "ArcGIS", wfs: s.dialect === "fes" ? "WFS (FES)" : "WFS", "rrc-ewa": "RRC query" }[s.kind ?? "arcgis"];

const seen = new Set();
for (const [title, match] of REGIONS) {
  const rows = SOURCES.filter((s) => !seen.has(s.key) && match(s));
  if (!rows.length) continue;
  rows.forEach((s) => seen.add(s.key));
  console.log(`### ${title}\n`);
  console.log("| Key | Coverage | Agency | Via |");
  console.log("|---|---|---|---|");
  for (const s of rows) console.log(`| \`${s.key}\` | ${cell(s.label)} | ${cell(s.agency)} | ${protocol(s)} |`);
  console.log("");
}

console.log("### No public registry found\n");
for (const n of NO_REGISTRY_NOTES) console.log(`- **${n.name}** - ${n.note}`);
