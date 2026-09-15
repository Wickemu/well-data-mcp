// Generic ArcGIS REST layer query client (MapServer + FeatureServer layers).
// All state regulator endpoints speak the same query grammar; this is the one wrapper.

const TIMEOUT_MS = 30_000;

async function fetchJson(url, params) {
  const qs = new URLSearchParams({ f: "json", ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const data = await res.json();
    if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message} (${url})`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

// SQL string-literal escape for the where clause.
export function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Case-insensitive contains: UPPER(field) LIKE UPPER('%value%')
export function likeClause(field, value) {
  return `UPPER(${field}) LIKE UPPER(${sqlQuote(`%${value}%`)})`;
}

export function eqClause(field, value) {
  return `UPPER(${field}) = UPPER(${sqlQuote(value)})`;
}

/**
 * WHERE clauses get_well tries in order for an API number in any common format:
 *   1. exact as given
 *   2. exact on the digits only (CA/UT/TX/NZ store undashed strings)
 *   3. dash-tolerant contains on county + sequence: the trailing 8 digits with a
 *      wildcard between the 3-digit county and 5-digit sequence, e.g. '%025%36283%',
 *      so it also matches sources that STORE dashes — NM '30-025-36283',
 *      ND '33-015-00001-00-00', CO '009-05201', NV '27-001-90335'.
 */
export function apiMatchClauses(field, api) {
  const digits = String(api).replace(/\D/g, "");
  return [
    eqClause(field, api),
    eqClause(field, digits),
    likeClause(field, `${digits.slice(-8, -5)}%${digits.slice(-5)}`),
  ];
}

/**
 * Query a layer with pagination. Returns { features, exceededLimit }.
 * Each feature: { attributes, geometry } with geometry in WGS84 (lon/lat).
 */
export async function queryLayer(layerUrl, { where = "1=1", outFields = "*", limit = 100, offset = 0, geometryParams = null, distinct = false, noReproject = false } = {}) {
  // noReproject: some servers 500 on outSR reprojection (e.g. NZPAM); those layers
  // carry explicit lat/lon attribute fields, so skip geometry entirely.
  const base = {
    where,
    outFields,
    ...(noReproject ? { returnGeometry: "false" } : { outSR: 4326, returnGeometry: distinct ? "false" : "true" }),
    resultOffset: String(offset),
    resultRecordCount: String(limit),
  };
  if (distinct) base.returnDistinctValues = "true";
  if (geometryParams) Object.assign(base, geometryParams);
  const data = await fetchJson(`${layerUrl}/query`, base);
  return {
    features: data.features ?? [],
    exceededLimit: Boolean(data.exceededTransferLimit),
  };
}

/** Count matching records without pulling them. */
export async function countLayer(layerUrl, { where = "1=1", geometryParams = null } = {}) {
  const base = { where, returnCountOnly: "true" };
  if (geometryParams) Object.assign(base, geometryParams);
  const data = await fetchJson(`${layerUrl}/query`, base);
  return data.count ?? null;
}

/** Point-radius geometry params (meters). */
export function nearParams(latitude, longitude, radiusMeters) {
  return {
    geometry: JSON.stringify({ x: longitude, y: latitude, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    distance: String(radiusMeters),
    units: "esriSRUnit_Meter",
    spatialRel: "esriSpatialRelIntersects",
  };
}
