// Draw docs/coverage-map.svg: a world map shaded by what this server covers, built from
// the source registry so it never drifts from the code. Country outlines: Natural Earth
// 1:110m admin-0 (public domain), downloaded on each run.
// Usage: node scripts/coverage-map.js   (also run by `npm run readme`)

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOURCES, NO_REGISTRY_NOTES } from "../src/sources/index.js";

const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const OUT = fileURLToPath(new URL("../docs/coverage-map.svg", import.meta.url));

// Countries whose deep boreholes are in the pan-European EU-GSEU compilation.
const GSEU = ["AL", "AT", "BE", "CH", "CZ", "DE", "DK", "ES", "FR", "GB", "GR", "HR", "HU", "IS", "IT", "LT", "NL", "NO", "PL", "PT", "RO", "RS", "SI", "SK", "UA"];

const live = new Set(SOURCES.map((s) => s.country).filter((c) => c !== "EU"));
const status = (iso) =>
  live.has(iso) ? "live" : GSEU.includes(iso) ? "gseu" : NO_REGISTRY_NOTES.some((n) => n.countries.includes(iso)) ? "none" : "unchecked";

const STYLE = {
  live: { fill: "#1f7a5c", label: "Live well registry" },
  gseu: { fill: "#7cc4a4", label: "Deep boreholes via EU-GSEU" },
  none: { fill: "#e3a35b", label: "Checked: no public registry" },
  unchecked: { fill: "#d9dde3", label: "Not covered" },
};

const W = 1000;
const H = 500;
// Equirectangular, latitudes -60..85 (Antarctica dropped).
const px = ([lon, lat]) => [((lon + 180) / 360) * W, ((85 - lat) / 145) * H];

function ringPath(ring) {
  let d = "";
  let prev = null;
  for (const pt of ring) {
    const [x, y] = px(pt).map((v) => Math.round(v * 10) / 10);
    if (prev && prev[0] === x && prev[1] === y) continue;
    d += `${d ? "L" : "M"}${x} ${y}`;
    prev = [x, y];
  }
  return `${d}Z`;
}

const geomPath = (g) =>
  (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map((poly) => poly.map(ringPath).join("")).join("");

const res = await fetch(NE_URL);
if (!res.ok) throw new Error(`Natural Earth download failed: HTTP ${res.status}`);
const world = await res.json();

const counts = { live: 0, gseu: 0, none: 0, unchecked: 0 };
const paths = [];
for (const f of world.features) {
  const p = f.properties;
  if (p.CONTINENT === "Antarctica") continue;
  // ISO_A2 is -99 for France and Norway in this edition; ISO_A2_EH fills it.
  const iso = [p.ISO_A2_EH, p.ISO_A2].find((v) => v && v !== "-99");
  const s = status(iso);
  counts[s]++;
  paths.push(`<path class="${s}" d="${geomPath(f.geometry)}"><title>${p.NAME}</title></path>`);
}

// Offshore and island areas too small for a 1:110m map get a marker.
const MARKERS = [
  ["Guadeloupe (FR-BSS)", -61.6, 16.2, "live"],
  ["Gulf of America OCS", -90.5, 27.5, "live"],
  ["Norwegian shelf", 3.5, 61, "live"],
  ["UK continental shelf", 1.5, 57.5, "live"],
];
const markers = MARKERS.map(([name, lon, lat, s]) => {
  const [x, y] = px([lon, lat]);
  return `<circle class="${s} marker" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${name}</title></circle>`;
});

const legendY = H + 16;
const legend = Object.entries(STYLE)
  .map(([k, v], i) => {
    const x = 20 + i * 210;
    return `<rect class="${k}" x="${x}" y="${legendY}" width="14" height="14" rx="2"/><text x="${x + 20}" y="${legendY + 11.5}">${v.label}</text>`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 44}" role="img" aria-label="World map of well-data coverage">
<title>well-data-mcp coverage: ${SOURCES.length} sources</title>
<style>
.bg{fill:#f7f8fa}
path{stroke:#ffffff;stroke-width:0.4;stroke-linejoin:round}
${Object.entries(STYLE).map(([k, v]) => `.${k}{fill:${v.fill}}`).join("\n")}
.marker{stroke:#ffffff;stroke-width:1.2}
text{font:12px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#2b2f36}
</style>
<rect class="bg" width="${W}" height="${H + 44}" rx="8"/>
${paths.join("\n")}
${markers.join("\n")}
${legend}
</svg>
`;

mkdirSync(fileURLToPath(new URL("../docs/", import.meta.url)), { recursive: true });
writeFileSync(OUT, svg);
console.log(`docs/coverage-map.svg: ${counts.live} countries live, ${counts.gseu} via GSEU, ${counts.none} checked with no registry (${(svg.length / 1024).toFixed(0)} KB)`);
