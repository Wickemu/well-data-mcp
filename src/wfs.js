// Minimal OGC WFS (GeoJSON) client — used for BRGM's Banque du Sous-Sol.

import { USER_AGENT } from "./meta.js";

const TIMEOUT_MS = 40_000;

/**
 * Fetch BSS borehole points from BRGM geologie WFS for a bbox.
 * bbox: [minLat, minLon, maxLat, maxLon] (EPSG:4326, lat-first per WFS 2.0 axis order).
 */
export async function queryBssBoreholes({ bbox, count = 100 }) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const qs = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typenames: "ms:BSS_TOTAL_SANS_LABEL",
    bbox: `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`,
    count: String(count),
    outputFormat: "geojson",
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://geoservices.brgm.fr/geologie?${qs}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`BRGM WFS HTTP ${res.status}`);
    const data = await res.json();
    return data.features ?? [];
  } finally {
    clearTimeout(t);
  }
}
