// Local lookup over the bundled IHFC Global Heat Flow Database extract
// (data/ihfc-heatflow.json.gz, built by scripts/convert-ihfc.py). CC BY 4.0 -
// results carry the citation. Loaded once on first use (~2 MB gzipped).

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { haversineKm, radiusToBbox } from "./geo.js";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "ihfc-heatflow.json.gz");

let cache = null;

async function load() {
  if (!cache) {
    const bundle = JSON.parse(gunzipSync(await readFile(FILE)).toString("utf8"));
    const { fields, rows, ...meta } = bundle;
    cache = { meta, records: rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))) };
  }
  return cache;
}

/** Release metadata for list_sources (null when the bundle is missing). */
export async function heatflowDataset() {
  try {
    const { meta, records } = await load();
    return { release: meta.release, measurements: records.length, license: meta.license };
  } catch {
    return null;
  }
}

const contains = (hay, needle) => hay != null && String(hay).toLowerCase().includes(needle);

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const round = (x) => Math.round(x * 10) / 10;
  return {
    n: v.length,
    min: v[0],
    median: round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2),
    mean: round(v.reduce((s, x) => s + x, 0) / v.length),
    max: v[v.length - 1],
  };
}

/**
 * Filters (all optional, ANDed): near { latitude, longitude, radiusKm }, name, purpose,
 * method, environment (substring), minHeatFlow, minDepth (metres, TVD or else MD).
 * Returns summary statistics over every match plus up to `limit` records
 * (nearest first for a radius search, else hottest first).
 */
export async function searchHeatFlow({ near = null, name, purpose, method, environment, minHeatFlow, minDepth, limit = 25 }) {
  const { meta, records } = await load();
  const [N, P, M, E] = [name, purpose, method, environment].map((s) => s?.trim().toLowerCase() || null);
  const box = near ? radiusToBbox(near.latitude, near.longitude, near.radiusKm * 1000) : null;
  let hits = [];
  for (const r of records) {
    if (box && (r.latitude < box[1] || r.latitude > box[3] || r.longitude < box[0] || r.longitude > box[2])) continue;
    if (N && !contains(r.name, N)) continue;
    if (P && !contains(r.purpose, P)) continue;
    if (M && !contains(r.method, M)) continue;
    if (E && !contains(r.environment, E)) continue;
    if (minHeatFlow != null && !(r.heatFlow >= minHeatFlow)) continue;
    if (minDepth != null && !((r.depthTVD ?? r.depthMD) >= minDepth)) continue;
    if (near) {
      const d = haversineKm(near.latitude, near.longitude, r.latitude, r.longitude);
      if (d > near.radiusKm) continue;
      hits.push({ ...r, distanceKm: Math.round(d * 100) / 100 });
    } else hits.push(r);
  }
  hits.sort(near ? (a, b) => a.distanceKm - b.distanceKm : (a, b) => (b.heatFlow ?? -1) - (a.heatFlow ?? -1));
  return {
    dataset: "IHFC Global Heat Flow Database",
    release: meta.release,
    matched: hits.length,
    sites: new Set(hits.map((r) => r.siteId)).size,
    summary: hits.length
      ? {
          heatFlow_mW_m2: stats(hits.map((r) => r.heatFlow)),
          gradient_K_km: stats(hits.map((r) => r.gradient)),
          conductivity_W_mK: stats(hits.map((r) => r.conductivity)),
        }
      : null,
    returned: Math.min(hits.length, limit),
    records: hits.slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v != null))),
    citation: meta.citation,
    license: meta.license,
  };
}
