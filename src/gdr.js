// DOE Geothermal Data Repository catalog (gdr.openei.org/data.json, DCAT-US, ~6 MB,
// CC BY 4.0 datasets). Unlike the OSTI index it carries each dataset's map footprint
// and direct file links, so it answers "what geothermal data exists near this point".
// Fetched once and kept in memory for a day.

import { fetchJson } from "./http.js";
import { radiusToBbox, haversineKm } from "./geo.js";

const CATALOG = "https://gdr.openei.org/data.json";
const TTL_MS = 24 * 3600 * 1000;
const MAX_SPAN_DEG = 30; // larger footprints are placeholders (some datasets list the whole globe)

let cache = null; // { at, datasets }

async function catalog() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.datasets;
  const data = await fetchJson(CATALOG, { timeoutMs: 90_000 });
  const datasets = (data.dataset ?? []).map((d) => ({ ...d, _bbox: footprint(d.spatial) }));
  cache = { at: Date.now(), datasets };
  return datasets;
}

/** [minLon, minLat, maxLon, maxLat] of a GeoJSON footprint string, or null. */
function footprint(spatial) {
  if (!spatial) return null;
  try {
    const g = typeof spatial === "string" ? JSON.parse(spatial) : spatial;
    const pts = JSON.stringify(g.coordinates).match(/-?\d+(\.\d+)?(e-?\d+)?/gi)?.map(Number) ?? [];
    const xs = pts.filter((_, i) => i % 2 === 0);
    const ys = pts.filter((_, i) => i % 2 === 1);
    if (!xs.length) return null;
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } catch {
    return null;
  }
}

const intersects = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);

export async function searchGdr({ query, latitude, longitude, radiusKm = 25, rows = 15 }) {
  const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const spatial = latitude != null && longitude != null;
  const box = spatial ? radiusToBbox(latitude, longitude, radiusKm * 1000) : null;
  let hits = (await catalog()).filter((d) => {
    if (terms.length) {
      const hay = [d.title, d.description, d.projectTitle, ...(d.keyword ?? [])].join(" ").toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (spatial) {
      const b = d._bbox;
      if (!b || b[2] - b[0] > MAX_SPAN_DEG || b[3] - b[1] > MAX_SPAN_DEG || !intersects(b, box)) return false;
    }
    return true;
  });
  // Tightest footprints first for a place search; newest first otherwise.
  hits = spatial
    ? hits.sort((a, b) => area(a._bbox) - area(b._bbox))
    : hits.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return {
    catalog: "DOE Geothermal Data Repository (gdr.openei.org)",
    query: query ?? null,
    ...(spatial ? { center: { latitude, longitude }, radius_km: radiusKm } : {}),
    matched: hits.length,
    returned: Math.min(hits.length, rows),
    datasets: hits.slice(0, rows).map((d) => {
      const b = d._bbox;
      const files = d.distribution ?? [];
      return {
        title: d.title,
        url: d.landingPage ?? d.identifier,
        issued: (d.issued ?? "").slice(0, 10) || null,
        modified: (d.modified ?? "").slice(0, 10) || null,
        publisher: d.publisher?.name ?? null,
        project: d.projectTitle ?? null,
        keywords: (d.keyword ?? []).slice(0, 10),
        description: (d.description ?? "").slice(0, 400),
        footprint: b,
        ...(spatial && b
          ? { distanceKm: Math.round(haversineKm(latitude, longitude, (b[1] + b[3]) / 2, (b[0] + b[2]) / 2) * 10) / 10 }
          : {}),
        fileCount: files.length,
        files: files.slice(0, 12).map((f) => ({ title: f.title ?? null, url: f.downloadURL ?? f.accessURL ?? null, format: f.format ?? null })),
        license: d.license ?? null,
      };
    }),
  };
}
