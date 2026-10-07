// Print the README coverage tables (markdown) from the source registry, so the
// README never drifts from what the server actually serves.
// Usage: node scripts/coverage-table.js > coverage.md   (then paste into README.md)

import { SOURCES, NO_REGISTRY_NOTES } from "../src/sources/index.js";

const REGIONS = [
  ["United States", (s) => s.country === "US" && !s.key.startsWith("OCS-")],
  ["US federal offshore", (s) => s.key.startsWith("OCS-")],
  ["Canada", (s) => s.country === "CA"],
  ["Latin America & Caribbean", (s) => ["BZ", "MX", "CO", "BR", "PE", "AR"].includes(s.country)],
  ["Europe", (s) => ["FR", "NO", "GB", "NL", "IS", "DE", "PL", "IE", "DK", "EU"].includes(s.country)],
  ["Africa & Asia", (s) => ["ID", "ZA", "MZ", "KE"].includes(s.country)],
  ["Oceania", (s) => ["AU", "NZ"].includes(s.country)],
  ["Other", () => true],
];

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
const protocol = (s) => ({ arcgis: "ArcGIS", wfs: s.dialect === "fes" ? "WFS (FES)" : "WFS", "rrc-ewa": "RRC query" })[s.kind ?? "arcgis"];

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
