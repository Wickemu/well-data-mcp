// OGC WFS 2.0 provider (GeoJSON output). Two filter dialects:
//   "cql" (default) - GeoServer: CQL_FILTER with ILIKE and BBOX(geom, ...).
//   "fes"           - MapServer, deegree, cardo.map: a FES 2.0 XML FILTER. These servers
//                     silently ignore CQL_FILTER (returning everything), and MapServer
//                     rejects the bbox parameter combined with FILTER, so the bbox goes
//                     inside the FES filter whenever there is also an attribute filter.
// Source options: url, typeName, geometryName (BBOX target), dialect, outputFormat,
// srsName, sortBy, baseCql (cql only), noPaging (server ignores startIndex: fetch
// offset+limit and slice), fallbackUrl (tried when url fails - e.g. a host whose HTTPS
// front end blocks some networks; remembered for the rest of the process).

import { fetchJson, fetchText } from "../http.js";
import { radiusToBbox } from "../geo.js";
import { apiCountySequence, apiDashed } from "../api-number.js";

const DEFAULTS = {
  cql: { outputFormat: "application/json", srsName: "EPSG:4326" },
  fes: { outputFormat: "geojson", srsName: "urn:ogc:def:crs:EPSG::4326" },
};

const opt = (source, key) => source[key] ?? DEFAULTS[source.dialect ?? "cql"][key];
const words = (v) => String(v).trim().split(/\s+/).filter(Boolean);

// ------------------------------------------------------------------ CQL

function cqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// GeoServer's ECQL has no LIKE escape, so user text loses % and _; whitespace runs match anything.
const cqlLike = (field, v) => `${field} ILIKE ${cqlQuote(`%${words(String(v).replace(/[%_]/g, " ")).join("%")}%`)}`;
const cqlEq = (field, v) => `strToUpperCase(${field}) = ${cqlQuote(String(v).trim().toUpperCase())}`;

function cqlBbox(source, [minLon, minLat, maxLon, maxLat]) {
  // 'EPSG:4326' (not the urn form) keeps GeoServer in lon/lat axis order.
  return `BBOX(${source.geometryName}, ${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 'EPSG:4326')`;
}

function cqlFilter(source, conditions, box) {
  const parts = source.baseCql ? [`(${source.baseCql})`] : [];
  for (const c of conditions) parts.push(c.op === "eq" ? cqlEq(c.field, c.value) : cqlLike(c.field, c.value));
  if (box) parts.push(cqlBbox(source, box));
  return parts.length ? parts.join(" AND ") : null;
}

// ------------------------------------------------------------------ FES

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// FES LIKE with '*' wildcard, '.' single char and '!' escape: escape those in user text.
const fesLiteral = (v) => words(v).map((w) => w.replace(/[!*.]/g, (c) => `!${c}`)).join("*");

function fesCondition(c) {
  if (c.op === "eq") {
    // No matchCase attribute: some servers (GEUS) fail on it; the contains attempt that follows is case-insensitive.
    return `<fes:PropertyIsEqualTo><fes:ValueReference>${c.field}</fes:ValueReference><fes:Literal>${xmlEscape(String(c.value).trim())}</fes:Literal></fes:PropertyIsEqualTo>`;
  }
  return `<fes:PropertyIsLike wildCard="*" singleChar="." escapeChar="!" matchCase="false"><fes:ValueReference>${c.field}</fes:ValueReference><fes:Literal>*${xmlEscape(fesLiteral(c.value))}*</fes:Literal></fes:PropertyIsLike>`;
}

function fesBbox(source, [minLon, minLat, maxLon, maxLat]) {
  return `<fes:BBOX><fes:ValueReference>${source.geometryName}</fes:ValueReference><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326"><gml:lowerCorner>${minLat} ${minLon}</gml:lowerCorner><gml:upperCorner>${maxLat} ${maxLon}</gml:upperCorner></gml:Envelope></fes:BBOX>`;
}

function fesFilter(source, conditions, box) {
  const parts = conditions.map(fesCondition);
  if (box) parts.push(fesBbox(source, box));
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0] : `<fes:And>${parts.join("")}</fes:And>`;
  return `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">${body}</fes:Filter>`;
}

// ------------------------------------------------------------------ requests

/** Request params for a set of conditions + optional bbox, in the source's dialect. */
export function filterParams(source, conditions, box) {
  if ((source.dialect ?? "cql") === "cql") {
    const cql = cqlFilter(source, conditions, box);
    return cql ? { CQL_FILTER: cql } : {};
  }
  if (!conditions.length && box) {
    const [minLon, minLat, maxLon, maxLat] = box;
    return { bbox: `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326` };
  }
  const fes = fesFilter(source, conditions, box);
  return fes ? { FILTER: fes } : {};
}

function baseParams(source, extra) {
  const p = {
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: source.typeName,
    outputFormat: opt(source, "outputFormat"),
    srsName: opt(source, "srsName"),
    ...extra,
  };
  if (source.sortBy) p.sortBy = source.sortBy;
  return p;
}

const useFallback = new Set(); // source keys whose primary url failed

/** fetchJson/fetchText against the source url, falling back to source.fallbackUrl once if it fails. */
async function wfsFetch(source, fetcher, params) {
  if (source.fallbackUrl && useFallback.has(source.key)) return fetcher(source.fallbackUrl, { params, timeoutMs: 60_000 });
  try {
    return await fetcher(source.url, { params, timeoutMs: source.fallbackUrl ? 20_000 : 60_000 });
  } catch (e) {
    if (!source.fallbackUrl) throw e;
    useFallback.add(source.key);
    return fetcher(source.fallbackUrl, { params, timeoutMs: 60_000 });
  }
}

async function getFeatures(source, { conditions = [], box = null, limit, offset = 0 }) {
  const paging = source.noPaging ? { count: String(offset + limit) } : { count: String(limit), startIndex: String(offset) };
  const params = baseParams(source, { ...paging, ...filterParams(source, conditions, box) });
  const data = await wfsFetch(source, fetchJson, params);
  if (!Array.isArray(data.features)) throw new Error(`WFS ${source.typeName}: unexpected response (no features array)`);
  if (source.noPaging) data.features = data.features.slice(offset, offset + limit);
  return data;
}

function matched(data) {
  const n = data.numberMatched ?? data.totalFeatures;
  return typeof n === "number" ? n : null;
}

/** Point coordinates of a GeoJSON geometry (centroid of the first ring/line for non-points). */
function pointOf(geom) {
  if (!geom) return null;
  if (geom.type === "Point") return { x: geom.coordinates[0], y: geom.coordinates[1] };
  if (geom.type === "MultiPoint" && geom.coordinates.length) return { x: geom.coordinates[0][0], y: geom.coordinates[0][1] };
  const ring = geom.type === "Polygon" ? geom.coordinates[0] : geom.type === "LineString" ? geom.coordinates : null;
  if (!ring?.length) return null;
  return { x: ring.reduce((s, c) => s + c[0], 0) / ring.length, y: ring.reduce((s, c) => s + c[1], 0) / ring.length };
}

function toRows(features) {
  return features.map((f) => ({ attrs: { ...f.properties, _featureId: f.id }, geometry: pointOf(f.geometry) }));
}

/** Normalized filters -> provider conditions on this source's fields. */
function conditionsFor(source, filters) {
  const conditions = [];
  const unsupported = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) unsupported.push(k);
    else conditions.push({ field, value: v, op: k === "api" ? "eq" : "like" });
  }
  return { conditions, unsupported };
}

/** Lookups get_well tries in order: exact, then (US API) digits and dash-tolerant county+sequence, else contains. */
function idAttempts(source, id) {
  if (source.idKind !== "us-api") return [{ op: "eq", value: id }, { op: "like", value: id }];
  const cs = apiCountySequence(id);
  const dashed = apiDashed(id);
  return [
    { op: "eq", value: id },
    { op: "eq", value: String(id).replace(/\D/g, "") },
    // The dashed form first: some WAFs reject the contains pattern '%005%...' as an encoded NUL.
    ...(dashed && dashed !== id ? [{ op: "eq", value: dashed }] : []),
    ...(cs ? [{ op: "like", value: `${cs.county} ${cs.sequence}` }] : []), // whitespace = wildcard
  ];
}

// MapServer's bbox test is approximate (it can miss a point at the very centre of a 2 km box),
// so FES sources get a padded box; the caller trims results to the exact circle anyway.
function nearBox(source, near) {
  if (!near) return null;
  const km = (source.dialect ?? "cql") === "fes" ? near.radiusKm * 1.5 + 2 : near.radiusKm;
  return radiusToBbox(near.latitude, near.longitude, km * 1000);
}

export const wfsProvider = {
  async search(source, filters, { limit, offset = 0, near = null }) {
    const { conditions, unsupported } = conditionsFor(source, filters);
    const capped = Math.min(limit, source.pageMax);
    const data = await getFeatures(source, { conditions, box: nearBox(source, near), limit: capped, offset });
    const total = matched(data);
    return {
      rows: toRows(data.features),
      moreAvailable: total != null && !source.noPaging ? total > offset + data.features.length : data.features.length >= capped,
      unsupported,
    };
  },

  async count(source, filters, { near = null } = {}) {
    const { conditions, unsupported } = conditionsFor(source, filters);
    const params = baseParams(source, { resultType: "hits", ...filterParams(source, conditions, nearBox(source, near)) });
    delete params.outputFormat; // hits responses are XML on every server
    const xml = await wfsFetch(source, fetchText, params);
    const m = /numberMatched="(\d+)"/.exec(xml);
    return { count: m ? Number(m[1]) : null, unsupported };
  },

  async findById(source, id) {
    const field = source.searchFields.api;
    for (const { op, value } of idAttempts(source, id)) {
      const data = await getFeatures(source, { conditions: [{ field, value, op }], limit: 5 });
      if (data.features.length) return toRows(data.features);
    }
    return [];
  },

  async distinct(source, fieldKey, text, limit = 1000) {
    const field = source.searchFields[fieldKey];
    const data = await getFeatures(source, { conditions: [{ field, value: text, op: "like" }], limit: Math.min(limit, source.pageMax) });
    return data.features.map((f) => f.properties?.[field]);
  },
};

// raw_query passthrough for GeoServer sources only (a CQL expression).
wfsProvider.canRaw = (source) => (source.dialect ?? "cql") === "cql";
wfsProvider.raw = async function raw(source, { where, outFields = "*", limit, offset = 0 }) {
  if ((source.dialect ?? "cql") !== "cql") throw new Error(`${source.key} is a ${source.dialect} WFS; raw_query supports CQL (GeoServer) sources only`);
  const cql = source.baseCql ? `(${source.baseCql}) AND (${where})` : where;
  const capped = Math.min(limit, source.pageMax);
  const params = baseParams(source, { count: String(capped), startIndex: String(offset), CQL_FILTER: cql });
  if (outFields !== "*") params.propertyName = outFields;
  const data = await wfsFetch(source, fetchJson, params);
  const total = matched(data);
  return {
    rows: toRows(data.features ?? []),
    moreAvailable: total != null ? total > offset + (data.features?.length ?? 0) : (data.features?.length ?? 0) >= capped,
  };
};
