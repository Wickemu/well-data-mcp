// Live smoke test: real queries against every registered source.
// Run: npm run smoke            (all sources)
//      npm run smoke -- UT NO   (only sources whose key, country or state matches)
//
// Per source, three checks through the same provider code the tools use:
//   search  - the source's own `probe` filter returns at least one record
//   id      - get_well's findById finds that record again by its identifier
//             (US API numbers are re-looked-up with dashes stripped, which proves
//             the dash-tolerant match against sources that store dashed numbers)
//   near    - a 2 km radius search around that record's coordinates finds it
import { SOURCES, normalizeRecord } from "../src/sources/index.js";
import { providerFor } from "../src/providers/index.js";
import { searchGeothermalDatasets } from "../src/osti.js";
import { searchGem } from "../src/gem.js";

const only = process.argv.slice(2).map((a) => a.toUpperCase());
const selected = only.length
  ? SOURCES.filter((s) => [s.key, s.country, s.state].some((v) => v && only.includes(String(v).toUpperCase())))
  : SOURCES;

// get_well's contract is a dash-tolerant match on "county + sequence" - not on any
// extra groups a source appends. ND stores full API-14 ('33-015-00001-00-00');
// trim to the first 3 groups (the API a user would type) before stripping dashes.
function coreApiDigits(raw) {
  const groups = String(raw).split("-");
  const core = groups.length > 3 ? groups.slice(0, 3).join("-") : raw;
  return String(core).replace(/\D/g, "");
}

let failures = 0;
const fmt = (ok, key, check, msg) => {
  if (!ok) failures++;
  return `${ok ? "ok  " : "FAIL"}  ${key.padEnd(10)} ${check.padEnd(6)} ${msg}`;
};
const line = (...a) => console.log(fmt(...a));

async function timed(fn) {
  const t0 = Date.now();
  const value = await fn();
  return [value, Date.now() - t0];
}

// Collects one source's result lines so parallel checks print grouped, not interleaved.
async function checkSource(s) {
  const lines = [];
  const line = (...a) => lines.push(fmt(...a));
  await runChecks(s, line);
  return lines;
}

async function runChecks(s, line) {
  const provider = providerFor(s);
  if (!s.probe) return line(false, s.key, "search", "no probe defined in the source entry");
  let sample;
  try {
    const [{ rows }, ms] = await timed(() => provider.search(s, s.probe, { limit: 3 }));
    if (!rows.length) return line(false, s.key, "search", `0 results for ${JSON.stringify(s.probe)} (${ms}ms)`);
    sample = normalizeRecord(s, rows[0].attrs, rows[0].geometry);
    line(true, s.key, "search", `${rows.length} hit(s) ${ms}ms  e.g. id=${sample.api} name=${JSON.stringify(sample.wellName)} op=${JSON.stringify(sample.operator)} status=${JSON.stringify(sample.status)} lat=${sample.latitude?.toFixed?.(4)} lon=${sample.longitude?.toFixed?.(4)}`);
  } catch (e) {
    return line(false, s.key, "search", e.message);
  }

  if (s.searchFields.api && sample.api != null) {
    const id = s.idKind === "us-api" ? coreApiDigits(sample.api) : String(sample.api);
    try {
      const [rows, ms] = await timed(() => provider.findById(s, id));
      const found = rows.length ? normalizeRecord(s, rows[0].attrs, rows[0].geometry).api : null;
      line(rows.length > 0, s.key, "id", rows.length ? `'${id}' -> ${found} ${ms}ms` : `'${id}' (from ${sample.api}) matched nothing (${ms}ms)`);
    } catch (e) {
      line(false, s.key, "id", e.message);
    }
  }

  if (s.noNear) return;
  if (Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude)) {
    const near = { latitude: sample.latitude, longitude: sample.longitude, radiusKm: 2 };
    try {
      const [{ rows }, ms] = await timed(() => provider.search(s, {}, { limit: 10, near }));
      line(rows.length > 0, s.key, "near", `${rows.length} record(s) within 2 km of the sample (${ms}ms)`);
    } catch (e) {
      line(false, s.key, "near", e.message);
    }
  } else {
    line(false, s.key, "near", "sample record has no coordinates");
  }
}

// Sources are independent; run them in parallel, print each source's lines together.
for (const lines of await Promise.all(selected.map(checkSource))) for (const l of lines) console.log(l);

if (!only.length) {
  try {
    const [r, ms] = await timed(() => searchGeothermalDatasets("cape egs", 5));
    line(r.returned > 0, "OSTI", "search", `${r.returned} dataset(s) ${ms}ms  e.g. ${JSON.stringify(r.datasets[0]?.title)}`);
  } catch (e) {
    line(false, "OSTI", "search", e.message);
  }
  try {
    const { searchHeatFlow } = await import("../src/heatflow.js");
    // Cooper Basin (Habanero): one of the world's best-known hot-rock heat-flow areas
    const r = await searchHeatFlow({ near: { latitude: -27.8, longitude: 140.75, radiusKm: 50 }, limit: 3 });
    line(r.matched > 0, "IHFC", "local", `${r.matched} heat-flow measurement(s) within 50 km of Habanero, median ${r.summary?.heatFlow_mW_m2?.median} mW/m2 (${r.release})`);
  } catch (e) {
    line(false, "IHFC", "local", e.message);
  }
  try {
    const r = await searchGem({ dataset: "geothermal", operator: "Fervo", limit: 3 });
    line((r[0]?.matched ?? 0) > 0, "GEM", "local", `${r[0]?.matched ?? 0} Fervo geothermal unit(s) in bundle (${r[0]?.release})`);
  } catch (e) {
    line(false, "GEM", "local", e.message);
  }
}

console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"} across ${selected.length} source(s)`);
process.exit(failures ? 1 : 0);
