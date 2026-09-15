// Live smoke test: one real query against every registered source.
// Run: npm run smoke
import { queryLayer, likeClause, apiMatchClauses, nearParams } from "../src/arcgis.js";
import { SOURCES, normalizeRecord } from "../src/states.js";
import { queryBssBoreholes } from "../src/wfs.js";
import { USER_AGENT } from "../src/meta.js";

// Per-source probe: an operator/name/api value known to exist in that state's data.
// TX has no operator field, and a short api substring ('42') used to false-positive
// against stub rows (API='421', GIS_API5 blank) - probe a specific real 8-digit API
// instead so a hit actually proves the layer matched a real well.
// GP-BSS is WFS (not ArcGIS SQL) and is probed separately below, so it has no entry here.
const PROBES = {
  "CA-OG": { filter: "operator", value: "California Resources" },
  "CA-GEO": { filter: "operator", value: "Calpine" },
  UT: { filter: "operator", value: "Ovintiv" },
  NM: { filter: "operator", value: "Devon" },
  CO: { filter: "operator", value: "Chevron" },
  ND: { filter: "operator", value: "Continental" },
  TX: { filter: "api", value: "42130441" },
  "NV-GEO": { filter: "operator", value: "Ormat" },
  "NZ-PET": { filter: "operator", value: "Todd" },
};

// Sources that STORE dashed API numbers (WD-1). Once the loop below finds a live
// sample well, it re-looks it up here with the dashes stripped to prove get_well's
// dash-tolerant match (apiMatchClauses) actually finds it against the real service.
const DASH_STORED_SOURCES = ["NM", "CO", "ND", "NV-GEO"];

// get_well's contract is a dash-tolerant match on "county + sequence" (its own
// description says so) - not on any extra dash-separated groups a source appends
// beyond that. ND stores full API-14 (state-county-sequence-sidetrack-event, e.g.
// '33-015-00001-00-00'); stripping ALL its dashes and matching on the last 8 digits
// can land inside the sidetrack/event suffix instead, which does not roundtrip
// (verified live: the digits-derived pattern then does not occur in the dashed
// original). Trim to the first 3 groups - the canonical API a user would type -
// before stripping dashes, same as NM/CO/NV-GEO already are (<=3 groups, no-op).
function coreApiDigits(raw) {
  const groups = String(raw).split("-");
  const core = groups.length > 3 ? groups.slice(0, 3).join("-") : raw;
  return String(core).replace(/\D/g, "");
}

let failures = 0;
const sampleApiBySource = {};

for (const s of SOURCES) {
  if (s.kind === "wfs-bss") continue; // WFS, not ArcGIS SQL - see the GP-BSS block below
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
    if (n.api) sampleApiBySource[s.key] = n.api;
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

// get_well dash-tolerant match (WD-1): strip the dashes off the sample API the loop
// above just found and confirm apiMatchClauses still finds the same well live.
for (const key of DASH_STORED_SOURCES) {
  const s = SOURCES.find((x) => x.key === key);
  const sample = sampleApiBySource[key];
  if (!sample) {
    console.log(`FAIL  ${key.padEnd(7)} dash-strip probe skipped - no sample API from the probe above`);
    failures++;
    continue;
  }
  const digits = coreApiDigits(sample);
  const field = s.searchFields.api;
  const t0 = Date.now();
  try {
    let hit = null;
    for (const where of apiMatchClauses(field, digits)) {
      const { features } = await queryLayer(s.url, { where, limit: 1, noReproject: s.noReproject });
      if (features.length) {
        hit = features[0];
        break;
      }
    }
    const ms = Date.now() - t0;
    if (!hit) {
      console.log(`FAIL  ${key.padEnd(7)} dash-strip '${digits}' (from ${sample}) matched nothing (${ms}ms)`);
      failures++;
      continue;
    }
    const found = normalizeRecord(s, hit.attributes, hit.geometry).api;
    console.log(`ok    ${key.padEnd(7)} dash-strip '${digits}' -> api=${found} ${ms}ms`);
  } catch (e) {
    console.log(`FAIL  ${key.padEnd(7)} dash-strip probe: ${e.message}`);
    failures++;
  }
}

// GP-BSS (WFS, not ArcGIS): the only non-ArcGIS live source. Query its default bbox
// directly and confirm real boreholes with geometry come back.
try {
  const bss = SOURCES.find((s) => s.key === "GP-BSS");
  const t0 = Date.now();
  const features = await queryBssBoreholes({ bbox: bss.defaultBbox, count: 5 });
  const ms = Date.now() - t0;
  const coords = features[0]?.geometry?.coordinates;
  if (!features.length || !coords) {
    console.log(`FAIL  GP-BSS  ${features.length} feature(s), geometry.coordinates=${JSON.stringify(coords)} (${ms}ms)`);
    failures++;
  } else {
    const [lon, lat] = coords;
    console.log(`ok    GP-BSS  ${features.length} borehole(s) ${ms}ms  e.g. lon=${lon?.toFixed?.(4)} lat=${lat?.toFixed?.(4)}`);
  }
} catch (e) {
  console.log(`FAIL  GP-BSS  ${e.message}`);
  failures++;
}

// OSTI Data Explorer - the exact URL/params search_geothermal_datasets builds.
try {
  const t0 = Date.now();
  const qs = `q=${encodeURIComponent("cape egs")}&rows=5`;
  const res = await fetch(`https://www.osti.gov/dataexplorer/api/v1/records?${qs}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const recs = await res.json();
  if (!Array.isArray(recs) || !recs.length) {
    console.log(`FAIL  OSTI    expected a non-empty array, got ${Array.isArray(recs) ? recs.length + " record(s)" : typeof recs} (${ms}ms)`);
    failures++;
  } else {
    console.log(`ok    OSTI    ${recs.length} dataset(s) ${ms}ms  e.g. ${JSON.stringify(recs[0].title)}`);
  }
} catch (e) {
  console.log(`FAIL  OSTI    ${e.message}`);
  failures++;
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
