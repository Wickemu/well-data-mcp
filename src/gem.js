// Local lookup over bundled Global Energy Monitor tracker extracts.
// Data: data/gem-geothermal.json (GGPT units) and data/gem-oilgas-fields.json
// (GOGET field-level). Refresh via scripts/convert-gem.py on a new GEM release.
// License: GEM data is CC BY 4.0 - cite "Global Energy Monitor" with release month.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { haversineKm } from "./geo.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const cache = {};

async function load(name) {
  if (!cache[name]) {
    const raw = await readFile(path.join(DATA_DIR, name), "utf-8");
    cache[name] = JSON.parse(raw);
  }
  return cache[name];
}

export async function gemDatasets() {
  const out = {};
  try {
    out.geothermal = (await load("gem-geothermal.json")).source;
  } catch {
    out.geothermal = null;
  }
  try {
    out.oilgas = (await load("gem-oilgas-fields.json")).source;
  } catch {
    out.oilgas = null;
  }
  return out;
}

function contains(hay, needle) {
  return hay && String(hay).toUpperCase().includes(needle);
}

/**
 * Search bundled GEM records. dataset: 'geothermal' | 'oilgas' | 'both'.
 * Text filters are case-insensitive substring matches.
 */
export async function searchGem({ dataset = "both", country, name, operator, status, near = null, limit = 25 }) {
  const wants = dataset === "both" ? ["geothermal", "oilgas"] : [dataset];
  const results = [];
  for (const kind of wants) {
    const file = kind === "geothermal" ? "gem-geothermal.json" : "gem-oilgas-fields.json";
    let data;
    try {
      data = await load(file);
    } catch {
      results.push({ dataset: kind, error: `${file} not bundled - run scripts/convert-gem.py` });
      continue;
    }
    const C = country?.toUpperCase();
    const N = name?.toUpperCase();
    const O = operator?.toUpperCase();
    const S = status?.toUpperCase();
    let recs = data.records.filter((r) => {
      if (C && !contains(r.country, C)) return false;
      if (N) {
        const names =
          kind === "geothermal" ? [r.project, r.unit, r.otherNames] : [r.name, r.otherNames, r.blocks];
        if (!names.some((v) => contains(v, N))) return false;
      }
      if (O && ![r.operator, r.owner, r.owners].some((v) => contains(v, O))) return false;
      if (S && !contains(r.status, S)) return false;
      if (near) {
        if (r.latitude == null || r.longitude == null) return false;
        if (haversineKm(near.latitude, near.longitude, r.latitude, r.longitude) > near.radius_km) return false;
      }
      return true;
    });
    const total = recs.length;
    if (near) {
      recs = recs
        .map((r) => ({ ...r, distanceKm: Math.round(haversineKm(near.latitude, near.longitude, r.latitude, r.longitude) * 10) / 10 }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    }
    results.push({
      dataset: kind,
      release: data.source,
      matched: total,
      returned: Math.min(total, limit),
      records: recs.slice(0, limit),
    });
  }
  return results;
}
