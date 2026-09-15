// Live smoke test: one real query against every registered source.
// Run: npm run smoke
import { queryLayer, likeClause, nearParams } from "../src/arcgis.js";
import { SOURCES, normalizeRecord } from "../src/states.js";

// Per-source probe: an operator (or name) known to exist in that state's data.
const PROBES = {
  "CA-OG": { filter: "operator", value: "California Resources" },
  "CA-GEO": { filter: "operator", value: "Calpine" },
  UT: { filter: "operator", value: "Ovintiv" },
  NM: { filter: "operator", value: "Devon" },
  CO: { filter: "operator", value: "Chevron" },
  ND: { filter: "operator", value: "Continental" },
  TX: { filter: "api", value: "42" }, // TX has no operator field; just prove the layer answers
  "NV-GEO": { filter: "operator", value: "Ormat" },
  "NZ-PET": { filter: "operator", value: "Todd" },
  "GP-BSS": { filter: "well_name", value: "S" }, // bbox-based; Bouillante boreholes
};

let failures = 0;

for (const s of SOURCES) {
  if (s.kind === "wfs-bss") continue; // exercised via the MCP-level test below
  const probe = PROBES[s.key];
  const field = s.searchFields[probe.filter];
  const where = likeClause(field, probe.value);
  const t0 = Date.now();
  try {
    const { features } = await queryLayer(s.url, { where, limit: 3, noReproject: s.noReproject });
    const ms = Date.now() - t0;
    if (!features.length) {
      console.log(`FAIL  ${s.key.padEnd(7)} 0 results for ${probe.filter}~'${probe.value}' (${ms}ms)`);
      failures++;
      continue;
    }
    const n = normalizeRecord(s, features[0].attributes, features[0].geometry);
    console.log(
      `ok    ${s.key.padEnd(7)} ${String(features.length)} hit(s) ${ms}ms  e.g. api=${n.api} name=${JSON.stringify(
        n.wellName
      )} op=${JSON.stringify(n.operator)} status=${JSON.stringify(n.status)} lat=${n.latitude?.toFixed?.(4)} lon=${n.longitude?.toFixed?.(4)}`
    );
  } catch (e) {
    console.log(`FAIL  ${s.key.padEnd(7)} ${e.message}`);
    failures++;
  }
}

// Radius test: wells near Milford, Utah (Fervo Cape Station country).
try {
  const ut = SOURCES.find((s) => s.key === "UT");
  const { features } = await queryLayer(ut.url, {
    limit: 5,
    geometryParams: nearParams(38.5, -112.9, 15_000),
  });
  console.log(`ok    NEAR    ${features.length} well(s) within 15 km of 38.5,-112.9 (Milford UT)`);
  for (const f of features.slice(0, 5)) {
    const n = normalizeRecord(ut, f.attributes, f.geometry);
    console.log(`      - ${n.api} ${n.wellName} [${n.operator}] ${n.status ?? ""}`);
  }
} catch (e) {
  console.log(`FAIL  NEAR    ${e.message}`);
  failures++;
}

// Bundled GEM data test (local, no network).
try {
  const { searchGem } = await import("../src/gem.js");
  const r = await searchGem({ dataset: "geothermal", operator: "Fervo", limit: 3 });
  const n = r[0]?.matched ?? 0;
  if (n > 0) {
    console.log(`ok    GEM     ${n} Fervo geothermal unit(s) in bundle (${r[0].release})`);
  } else {
    console.log("FAIL  GEM     no Fervo units in bundle");
    failures++;
  }
} catch (e) {
  console.log(`FAIL  GEM     ${e.message}`);
  failures++;
}

process.exit(failures ? 1 : 0);
