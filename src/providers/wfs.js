// OGC WFS 2.0 provider (GeoJSON output). Two filter dialects:
//   "cql" (default) - GeoServer: CQL_FILTER with ILIKE and BBOX(geom, ...).
//   "fes"           - MapServer, deegree, cardo.map: a FES 2.0 XML FILTER. These servers
//                     silently ignore CQL_FILTER (returning everything), and MapServer
//                     rejects the bbox parameter combined with FILTER, so the bbox goes
//                     inside the FES filter whenever there is also an attribute filter.
// Source options: url, typeName, geometryName (BBOX target), dialect, outputFormat,
// srsName, sortBy, wellNumberField (the well number, where the layer keeps it apart from
// the name that searchFields.well_name points at), baseCql (cql only), noPaging (server ignores startIndex: fetch
// offset+limit and slice), fallbackUrl (tried when url fails - e.g. a host whose HTTPS
// front end blocks some networks; remembered for the rest of the process),
// bboxAttrs { lat, lon } (cql only: a layer whose spatial filters return nothing is
// boxed on its latitude/longitude attributes instead), wellNameAlso (a second field a name
// search looks in), alsoSearch { filter: field } (a filter matches either field, e.g. the
// operator as well as the licence holder), codes { status | well_type: { CODE: label } },
// idAlso { field, test?, pad? } (a second id field), and two FES server quirks:
// fesNoEscape (the server takes '!' escapes literally and rejects '(': special characters
// become the single-character wildcard instead) and eqAsLike (the server cannot compare a
// digit-led literal for equality: send a wildcard-free PropertyIsLike instead), and
// unsortedFirstPage (ask for the first page without startIndex and sortBy; see getFeatures).

import { fetchJson, fetchText } from "../http.js";
import { radiusToBbox } from "../geo.js";
import { apiCountySequence, apiDashed } from "../api-number.js";
import { nameWords, splitBore } from "../name-match.js";
import { idTokens, sameIdTokens, idTokenRun, hasLetters, idAlsoValue, partialWorthy } from "../ids.js";
import { openRing } from "../sources/normalize.js";
import { matchingCodes } from "./arcgis.js";

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
  const a = source.bboxAttrs;
  if (a) return `${a.lat} BETWEEN ${minLat} AND ${maxLat} AND ${a.lon} BETWEEN ${minLon} AND ${maxLon}`;
  // 'EPSG:4326' (not the urn form) keeps GeoServer in lon/lat axis order.
  return `BBOX(${source.geometryName}, ${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 'EPSG:4326')`;
}

// apiNumeric: the id field is a number - compare it as one so the server can use its index.
function cqlEqFor(source, c) {
  if (!(source.apiNumeric && c.field === source.searchFields.api)) return cqlEq(c.field, c.value);
  // A numeric-id source's ids are numbers: text with letters is a name, never one of them.
  const digits = source.idKind !== "us-api" && hasLetters(c.value) ? "" : String(c.value).replace(/\D/g, "");
  return `${c.field} = ${digits ? digits.replace(/^0+(?=\d)/, "") : -1}`;
}

function cqlFilter(source, conditions, box) {
  const parts = source.baseCql ? [`(${source.baseCql})`] : [];
  const one = (c) => (c.op === "eq" ? cqlEqFor(source, c) : cqlLike(c.field, c.value));
  // anyOf: alternatives, each a list of conditions that must all hold
  for (const c of conditions) parts.push(c.anyOf ? `(${c.anyOf.map((all) => `(${all.map(one).join(" AND ")})`).join(" OR ")})` : one(c));
  if (box) parts.push(cqlBbox(source, box));
  return parts.length ? parts.join(" AND ") : null;
}

// ------------------------------------------------------------------ FES

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// FES LIKE with '*' wildcard, '.' single char and '!' escape: escape those in user text.
// fesNoEscape servers take '!' escapes literally and reject '(': those characters become '.', one of anything.
const fesEscape = (w, source) => (source?.fesNoEscape ? w.replace(/[!*.()]/g, ".") : w.replace(/[!*.]/g, (c) => `!${c}`));
const fesLiteral = (v, source) => words(v).map((w) => fesEscape(w, source)).join("*");

function fesCondition(c, source) {
  if (c.anyOf) {
    const groups = c.anyOf.map((all) => (all.length === 1 ? fesCondition(all[0], source) : `<fes:And>${all.map((x) => fesCondition(x, source)).join("")}</fes:And>`));
    return groups.length === 1 ? groups[0] : `<fes:Or>${groups.join("")}</fes:Or>`;
  }
  if (c.op === "eq" && source?.eqAsLike) {
    // Equality as a wildcard-free, case-insensitive LIKE, for servers that cannot compare a digit-led literal.
    return `<fes:PropertyIsLike wildCard="*" singleChar="." escapeChar="!" matchCase="false"><fes:ValueReference>${c.field}</fes:ValueReference><fes:Literal>${xmlEscape(fesEscape(String(c.value).trim(), source))}</fes:Literal></fes:PropertyIsLike>`;
  }
  if (c.op === "eq") {
    // No matchCase attribute: some servers (GEUS) fail on it; the contains attempt that follows is case-insensitive.
    return `<fes:PropertyIsEqualTo><fes:ValueReference>${c.field}</fes:ValueReference><fes:Literal>${xmlEscape(String(c.value).trim())}</fes:Literal></fes:PropertyIsEqualTo>`;
  }
  return `<fes:PropertyIsLike wildCard="*" singleChar="." escapeChar="!" matchCase="false"><fes:ValueReference>${c.field}</fes:ValueReference><fes:Literal>*${xmlEscape(fesLiteral(c.value, source))}*</fes:Literal></fes:PropertyIsLike>`;
}

function fesBbox(source, [minLon, minLat, maxLon, maxLat]) {
  return `<fes:BBOX><fes:ValueReference>${source.geometryName}</fes:ValueReference><gml:Envelope srsName="urn:ogc:def:crs:EPSG::4326"><gml:lowerCorner>${minLat} ${minLon}</gml:lowerCorner><gml:upperCorner>${maxLat} ${maxLon}</gml:upperCorner></gml:Envelope></fes:BBOX>`;
}

function fesFilter(source, conditions, box) {
  const parts = conditions.map((c) => fesCondition(c, source));
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

function baseParams(source, extra, { sort = true } = {}) {
  const p = {
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: source.typeName,
    outputFormat: opt(source, "outputFormat"),
    srsName: opt(source, "srsName"),
    ...extra,
  };
  if (source.sortBy && sort) p.sortBy = source.sortBy;
  return p;
}

const useFallback = new Set(); // source keys whose primary url failed
const ID_SCAN_PAGES = 5; // pages get_well's forgiving id lookup reads, at most

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

// MapServer (BRGM) answers a GetFeature that matches nothing with an empty 200 body.
const fetchFeatureCollection = (url, opts) => fetchJson(url, { ...opts, ifEmpty: { type: "FeatureCollection", features: [] } });

/**
 * One page of features. unsortedFirstPage: a server that answers a first page ten times
 * faster without paging or sort parameters (WY-LIVE: 2 s against 20-50 s). That page is in
 * feature-id order, not sortBy order, so with `paged` (a caller that may ask for the next
 * page) it is kept only when it holds the whole answer; otherwise the page is asked for
 * again, sorted, so every page follows the same order.
 */
async function getFeatures(source, { conditions = [], box = null, limit, offset = 0, paged = false }) {
  const filter = filterParams(source, conditions, box);
  if (offset === 0 && source.unsortedFirstPage && !source.noPaging) {
    const data = await fetchPage(source, { count: String(limit) }, filter, false);
    const total = matched(data);
    if (!paged || (total != null ? total <= data.features.length : data.features.length < limit)) return data;
  }
  const paging = source.noPaging ? { count: String(offset + limit) } : { count: String(limit), startIndex: String(offset) };
  const data = await fetchPage(source, paging, filter, true);
  if (source.noPaging) data.features = data.features.slice(offset, offset + limit);
  return data;
}

async function fetchPage(source, paging, filter, sort) {
  const data = await wfsFetch(source, fetchFeatureCollection, baseParams(source, { ...paging, ...filter }, { sort }));
  if (!Array.isArray(data.features)) throw new Error(`WFS ${source.typeName}: unexpected response (no features array)`);
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
  const line = geom.type === "Polygon" ? geom.coordinates[0] : geom.type === "LineString" ? geom.coordinates : null;
  if (!line?.length) return null;
  const ring = geom.type === "Polygon" ? openRing(line) : line;
  return { x: ring.reduce((s, c) => s + c[0], 0) / ring.length, y: ring.reduce((s, c) => s + c[1], 0) / ring.length };
}

function toRows(features) {
  return features.map((f) => ({ attrs: { ...f.properties, _featureId: f.id }, geometry: pointOf(f.geometry) }));
}

/**
 * The condition for a well name. Tier 0 looks for the text as typed, tier 1 for its
 * forgiving form (punctuation, zero padding and a sidetrack suffix ignored). Where the
 * layer keeps the well number apart (wellNumberField) the text may be the name, the
 * number, or leading words in one and the last one to three in the other.
 * Null when tier 1 would repeat tier 0.
 */
function nameCondition(source, text, tier) {
  const field = source.searchFields.well_name;
  const typed = words(text);
  const number = source.wellNumberField;
  const runs = nameWords(splitBore(text).base);
  // Without a number field, letters and digits apart too: '15/9-19A' finds '15/9-19 A', 'HE10' finds 'HE-10'.
  const loose = number ? runs : runs.flatMap((x) => x.match(/[A-Z]+|\d+/g) ?? []);
  if (tier > 0 && (!loose.length || loose.join(" ") === typed.join(" ").toUpperCase())) return null;
  const parts = tier > 0 ? loose : typed;
  const like = (f, w) => ({ field: f, value: w.join(" "), op: "like" });
  if (!number || !parts.length) {
    const w = parts.length ? parts : [text];
    return source.wellNameAlso ? { anyOf: [[like(field, w)], [like(source.wellNameAlso, w)]] } : like(field, w);
  }
  // In a number field a letter/digit boundary may be punctuated: 'A10' is also 'A-10'.
  const inNumber = (w) => (tier > 0 ? w.flatMap((x) => x.match(/[A-Z]+|\d+/g) ?? []) : w);
  const anyOf = [[like(field, parts)], [like(number, inNumber(parts))]];
  for (let k = 1; k <= Math.min(3, parts.length - 1); k++) anyOf.push([like(field, parts.slice(0, -k)), like(number, inNumber(parts.slice(-k)))]);
  return { anyOf };
}

/** Normalized filters -> provider conditions on this source's fields; `conditions` is null when the name tier asked for does not exist. */
function conditionsFor(source, filters, nameTier = 0) {
  const conditions = [];
  const unsupported = [];
  let none = nameTier > 0 && !(filters.well_name && source.searchFields.well_name);
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) unsupported.push(k);
    else if (k === "well_name") {
      const condition = nameCondition(source, v, nameTier);
      if (condition) conditions.push(condition);
      else none = true;
    } else if ((k === "status" || k === "well_type") && source.codes?.[k]) {
      // A coded field: the code typed, or the codes whose label holds the text - never a code that merely contains it.
      const codes = matchingCodes(source.codes[k], v);
      conditions.push(codes.length ? { anyOf: codes.map((code) => [{ field, value: code, op: "eq" }]) } : { field, value: String(v).trim(), op: "eq" });
    } else if (source.codeFields?.includes(k)) {
      conditions.push({ field, value: String(v).trim(), op: "eq" });
    } else if (source.alsoSearch?.[k]) {
      conditions.push({ anyOf: [[{ field, value: v, op: "like" }], [{ field: source.alsoSearch[k], value: v, op: "like" }]] });
    } else conditions.push({ field, value: v, op: k === "api" ? "eq" : "like" });
  }
  return { conditions: none ? null : conditions, unsupported };
}

/** Lookups get_well tries in order: exact, then (US API) digits and dash-tolerant county+sequence, else contains. */
function idAttempts(source, id) {
  const t = String(id).trim();
  // A numeric-id source: one exact attempt for a number, none for a name (a contains-match on a number column errors).
  if (source.apiNumeric && source.idKind !== "us-api") return hasLetters(t) || !/\d/.test(t) ? [] : [{ op: "eq", value: t }];
  if (source.idKind !== "us-api") {
    const also = idAlsoValue(source, t);
    return [{ op: "eq", value: t }, ...(also != null ? [{ op: "eq", value: also, field: source.idAlso.field }] : [])];
  }
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
  nameTiers: 2, // search() takes nameTier 0 (as typed) and 1 (forgiving)
  // The padding nearBox adds: a radius search cannot ask for a box tighter than this.
  nearPadKm: (source) => ((source.dialect ?? "cql") === "fes" ? 2 : 0),

  async search(source, filters, { limit, offset = 0, near = null, nameTier = 0 }) {
    const { conditions, unsupported } = conditionsFor(source, filters, nameTier);
    if (!conditions) return { rows: [], moreAvailable: false, unsupported, noTier: true };
    const capped = Math.min(limit, source.pageMax);
    const data = await getFeatures(source, { conditions, box: nearBox(source, near), limit: capped, offset, paged: true });
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
    let refused = null;
    for (const { op, value, field: f = field } of idAttempts(source, id)) {
      try {
        const data = await getFeatures(source, { conditions: [{ field: f, value, op }], limit: 5 });
        if (data.features.length) return toRows(data.features);
      } catch (e) {
        // An exact form the server cannot parse (MapServer and a digit-led literal): try the next one.
        if (op !== "eq") throw e;
        refused = e;
      }
    }
    if (source.idKind === "us-api" || source.apiNumeric) {
      if (refused) throw refused;
      return [];
    }
    // The same id written another way, else the id as whole tokens inside a longer one (flagged partial).
    const toks = idTokens(id);
    if (!toks.length) return [];
    // A broad pattern can match thousands of features before the same id with its zero
    // padding ('99/01- 2' for '99/1-2'): read on, page by page, until it turns up (ID_SCAN_PAGES at most).
    const features = [];
    let same = [];
    for (let page = 0, offset = 0; page < ID_SCAN_PAGES; page++) {
      const limit = page === 0 ? Math.min(200, source.pageMax) : source.pageMax;
      let data;
      try {
        data = await getFeatures(source, { conditions: [{ field, value: toks.join(" "), op: "like" }], limit, offset, paged: true });
      } catch (e) {
        if (page === 0) throw e;
        break; // a server that refuses a later page: answer from what was read
      }
      features.push(...data.features);
      same = features.filter((ft) => sameIdTokens(ft.properties?.[field], id));
      const total = matched(data);
      offset += data.features.length;
      if (same.length || data.features.length < limit || (total != null && total <= offset)) break;
    }
    if (same.length) return toRows(same.slice(0, 5));
    if (!partialWorthy(id)) return [];
    return toRows(features.filter((ft) => idTokenRun(ft.properties?.[field], id)).slice(0, 5)).map((r) => ({ ...r, partial: true }));
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
  const data = await wfsFetch(source, fetchFeatureCollection, params);
  const total = matched(data);
  return {
    rows: toRows(data.features ?? []),
    moreAvailable: total != null ? total > offset + (data.features?.length ?? 0) : (data.features?.length ?? 0) >= capped,
  };
};
