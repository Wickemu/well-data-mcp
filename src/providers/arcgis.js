// ArcGIS REST layer provider (MapServer + FeatureServer layers). Most regulators
// run ArcGIS, and the query grammar is identical everywhere, so this one wrapper
// serves the majority of sources.

import { fetchJson } from "../http.js";
import { apiCountySequence, apiDashed } from "../api-number.js";

async function arcgisJson(url, params, headers, timeoutMs) {
  const data = await fetchJson(url, { params: { f: "json", ...params }, headers, timeoutMs });
  if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message} (${url})`);
  return data;
}

// SQL string-literal escape for the where clause.
export function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Case-insensitive contains: UPPER(field) LIKE UPPER('%value%'). Runs of whitespace in
// the search text match anything, so 'Energy Geoscience' finds 'ENERGY  GEOSCIENCE INST'.
export function likeClause(field, value) {
  const pattern = String(value).trim().replace(/\s+/g, "%");
  return `UPPER(${field}) LIKE UPPER(${sqlQuote(`%${pattern}%`)})`;
}

export function eqClause(field, value) {
  return `UPPER(${field}) = UPPER(${sqlQuote(value)})`;
}

/**
 * WHERE clauses get_well tries in order for an API number in any common format:
 *   1. exact as given
 *   2. exact on the digits only (CA/UT/TX/NZ store undashed strings)
 *   3. exact on the dashed 'SS-CCC-NNNNN' form (cheap, and avoids a LIKE)
 *   4. dash-tolerant contains on county + sequence, with a wildcard between the
 *      3-digit county and 5-digit sequence, e.g. '%025%36283%', so it also matches
 *      sources that STORE dashes or spaces — NM '30-025-36283', ND '33-015-00001-00-00',
 *      CO '009-05201', SD '40 005 05001'. County + sequence are digits 3-10 of a
 *      10/12/14-digit API, or the trailing 8 digits of a shorter one (no state prefix).
 */
export function apiMatchClauses(field, api) {
  const digits = String(api).replace(/\D/g, "");
  const cs = apiCountySequence(api);
  const dashed = apiDashed(api);
  return [
    eqClause(field, api),
    eqClause(field, digits),
    ...(dashed && dashed !== api ? [eqClause(field, dashed)] : []),
    ...(cs ? [likeClause(field, `${cs.county}%${cs.sequence}`)] : []),
  ];
}

const stripZeros = (d) => d.replace(/^0+(?=\d)/, "");

/** Numeric API fields (stored as Double): equality on the digits, then on the 10-digit API. */
export function numericApiClauses(field, api) {
  const digits = String(api).replace(/\D/g, "");
  const clauses = [`${field} = ${stripZeros(digits)}`];
  if (digits.length > 10) clauses.push(`${field} = ${stripZeros(digits.slice(0, 10))}`);
  return clauses;
}

/** WHERE clauses for a non-API identifier (UWI, wellbore name, licence no): exact, then contains. */
export function idMatchClauses(field, id) {
  return [eqClause(field, String(id).trim()), likeClause(field, String(id).trim())];
}

/**
 * Query a layer with pagination. Returns { features, exceededLimit }.
 * Each feature: { attributes, geometry } with geometry in WGS84 (lon/lat).
 * noReproject: some servers 500 on outSR reprojection (e.g. NZPAM); those layers
 *   carry explicit lat/lon attribute fields, so skip geometry entirely.
 * noPaging: some servers 400 on resultOffset/resultRecordCount (DOGAMI, Colombia's SGC);
 *   page them by object id instead: fetch the matching ids, then one page of records.
 */
export async function queryLayer(layerUrl, { where = "1=1", outFields = "*", limit = 100, offset = 0, geometryParams = null, distinct = false, noReproject = false, noPaging = false, orderBy = null, headers, timeoutMs } = {}) {
  const base = {
    where,
    outFields,
    ...(noReproject ? { returnGeometry: "false" } : { outSR: 4326, returnGeometry: distinct ? "false" : "true" }),
  };
  if (geometryParams) Object.assign(base, geometryParams);
  if (noPaging && !distinct) return queryByIds(layerUrl, base, { limit, offset, headers, timeoutMs });
  if (!noPaging) Object.assign(base, { resultOffset: String(offset), resultRecordCount: String(limit) });
  if (distinct) base.returnDistinctValues = "true";
  if (orderBy) base.orderByFields = orderBy;
  const data = await arcgisJson(`${layerUrl}/query`, base, headers, timeoutMs);
  return { features: data.features ?? [], exceededLimit: Boolean(data.exceededTransferLimit) };
}

/** Paging for servers without resultOffset: ids first (uncapped), then one page by objectIds. */
async function queryByIds(layerUrl, base, { limit, offset, headers, timeoutMs }) {
  const { where, geometry, geometryType, inSR, distance, units, spatialRel } = base;
  const idParams = { where, returnIdsOnly: "true", ...(geometry ? { geometry, geometryType, inSR, distance, units, spatialRel } : {}) };
  const ids = (await arcgisJson(`${layerUrl}/query`, idParams, headers, timeoutMs)).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const page = ids.slice(offset, offset + limit);
  if (!page.length) return { features: [], exceededLimit: false };
  const { outFields, outSR, returnGeometry } = base;
  const data = await arcgisJson(
    `${layerUrl}/query`,
    { objectIds: page.join(","), outFields, returnGeometry: returnGeometry ?? "true", ...(outSR ? { outSR } : {}) },
    headers,
    timeoutMs
  );
  return { features: data.features ?? [], exceededLimit: ids.length > offset + limit };
}

/** Count matching records without pulling them. */
export async function countLayer(layerUrl, { where = "1=1", geometryParams = null, headers, timeoutMs } = {}) {
  const base = { where, returnCountOnly: "true" };
  if (geometryParams) Object.assign(base, geometryParams);
  const data = await arcgisJson(`${layerUrl}/query`, base, headers, timeoutMs);
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

// ------------------------------------------------------------- provider
//
// Per-source options this provider honours (besides url/searchFields/pageMax):
//   baseWhere      clause ANDed into every query (e.g. drop placeholder rows)
//   outFields      field list to request instead of '*' (layers with blob columns)
//   headers        extra request headers (e.g. a User-Agent a server insists on)
//   timeoutMs      per-request timeout for slow servers (default 30 s)
//   noReproject, noPaging, emptyResultBug   server quirks, see queryLayer/querySource
//   apiNumeric     the api field is a number, so match it with '=' not UPPER/LIKE
//   dedupeBy       attribute that identifies a well when a layer repeats rows
//   prepare()      async; loads lookup tables the normalizer needs (called before each query)
//   operatorWhere(text)  async; custom SQL for the operator filter (e.g. names -> company numbers)

/** Build a WHERE clause from normalized filters against one source's field map. */
export async function buildWhere(source, filters) {
  const clauses = source.baseWhere ? [`(${source.baseWhere})`] : [];
  const unsupported = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) {
      unsupported.push(k);
      continue;
    }
    if (k === "operator" && source.operatorWhere) clauses.push(await source.operatorWhere(v));
    else if (k === "api" && source.apiNumeric) clauses.push(`${field} = ${stripZeros(String(v).replace(/\D/g, "")) || -1}`);
    else clauses.push(k === "api" ? eqClause(field, v) : likeClause(field, v));
  }
  return { where: clauses.length ? clauses.join(" AND ") : "1=1", unsupported };
}

function withBase(source, where) {
  return source.baseWhere ? `(${source.baseWhere}) AND (${where})` : where;
}

/** queryLayer with per-source quirks applied (reprojection bug, 500-on-empty bug, duplicate rows). */
async function querySource(source, opts) {
  await source.prepare?.();
  let result;
  try {
    result = await queryLayer(source.url, {
      outFields: source.outFields ?? "*",
      ...opts,
      noReproject: source.noReproject,
      noPaging: source.noPaging,
      headers: source.headers,
      timeoutMs: source.timeoutMs,
    });
  } catch (e) {
    if (source.emptyResultBug && /error 500/i.test(String(e.message))) return { features: [], exceededLimit: false };
    throw e;
  }
  if (source.dedupeBy && !opts.distinct) {
    const seen = new Set();
    result.features = result.features.filter((f) => {
      const id = f.attributes?.[source.dedupeBy];
      if (id == null) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return result;
}

const toRows = (features) => features.map((f) => ({ attrs: f.attributes, geometry: f.geometry ?? null }));
const geometryFor = (near) => (near ? nearParams(near.latitude, near.longitude, near.radiusKm * 1000) : null);

function idClauses(source, id) {
  const field = source.searchFields.api;
  if (source.apiNumeric) {
    const digits = String(id).replace(/\D/g, "");
    if (!digits) return [];
    return source.idKind === "us-api" ? numericApiClauses(field, id) : [`${field} = ${stripZeros(digits)}`];
  }
  return source.idKind === "us-api" ? apiMatchClauses(field, id) : idMatchClauses(field, id);
}

export const arcgisProvider = {
  canRaw: () => true,

  async search(source, filters, { limit, offset = 0, near = null }) {
    const { where, unsupported } = await buildWhere(source, filters);
    const { features, exceededLimit } = await querySource(source, {
      where,
      limit: Math.min(limit, source.pageMax),
      offset,
      geometryParams: geometryFor(near),
    });
    return { rows: toRows(features), moreAvailable: exceededLimit, unsupported };
  },

  async count(source, filters, { near = null } = {}) {
    const { where, unsupported } = await buildWhere(source, filters);
    const count = await countLayer(source.url, { where, geometryParams: geometryFor(near), headers: source.headers, timeoutMs: source.timeoutMs });
    return { count, unsupported };
  },

  async findById(source, id) {
    for (const where of idClauses(source, id)) {
      const { features } = await querySource(source, { where: withBase(source, where), limit: 5 });
      if (features.length) return toRows(features);
    }
    return [];
  },

  async distinct(source, fieldKey, text, limit = 200) {
    const field = source.searchFields[fieldKey];
    const { where } = await buildWhere(source, { [fieldKey]: text });
    const { features } = await querySource(source, {
      where,
      outFields: field,
      limit: Math.min(source.pageMax, limit),
      distinct: true,
    });
    // A source whose operator field is a code (BOEM company numbers) shows names instead.
    const show = source.displayOperator;
    return features.map((f) => (fieldKey === "operator" && show ? show(f.attributes[field]) : f.attributes[field]));
  },

  async raw(source, { where, outFields = "*", limit, offset = 0 }) {
    const { features, exceededLimit } = await querySource(source, {
      where: withBase(source, where),
      outFields: outFields === "*" ? source.outFields ?? "*" : outFields,
      limit: Math.min(limit, source.pageMax),
      offset,
    });
    return { rows: toRows(features), moreAvailable: exceededLimit };
  },
};
