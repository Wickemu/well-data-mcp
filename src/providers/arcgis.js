// ArcGIS REST layer provider (MapServer + FeatureServer layers). Most regulators
// run ArcGIS, and the query grammar is identical everywhere, so this one wrapper
// serves the majority of sources.

import { fetchJson } from "../http.js";
import { apiCountySequence, apiDashed } from "../api-number.js";
import { radiusToBbox } from "../geo.js";
import { nameWords, splitBore } from "../name-match.js";
import { idTokens, sameIdTokens, idTokenRun, hasLetters, idAlsoValue, partialWorthy } from "../ids.js";
import { parseUwi, uwiForms, uwiCore, uwiCompact } from "../uwi.js";
import { containsWords } from "./snapshot.js";
import { cachedValue } from "../disk-cache.js";

// ArcGIS reports a failed query inside a 200 answer; 500/503/504 there are usually a busy
// back end (a burst that clears on the next try) and 429 a rate limit, so those are asked once
// more, after a longer pause for 429.
const RETRY_ARCGIS_CODES = new Set([429, 500, 503, 504]);

// Longer GET URLs are refused by some firewalls (gis.boem.gov stops near 2,000 characters):
// such a query goes as a form POST, which every ArcGIS Server takes for /query.
const MAX_GET_URL = 1800;

async function arcgisJson(url, params, headers, timeoutMs, hedgeAfterMs = 0) {
  const all = { f: "json", ...params };
  const form = new URLSearchParams(all).toString();
  const opts =
    url.length + 1 + form.length > MAX_GET_URL
      ? { method: "POST", body: form, headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, timeoutMs, hedgeAfterMs }
      : { params: all, headers, timeoutMs, hedgeAfterMs };
  let data = await fetchJson(url, opts);
  if (RETRY_ARCGIS_CODES.has(data.error?.code)) {
    await new Promise((r) => setTimeout(r, data.error.code === 429 ? 2000 : 750));
    data = await fetchJson(url, opts);
  }
  if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message} (${url})`);
  // A site whose back end is down answers 200 with { status: "error", messages: [...] }: an outage, not "no wells".
  if (data.status === "error") throw new Error(`ArcGIS server error: ${[].concat(data.messages ?? []).join("; ") || "no details"} (${url})`);
  return data;
}

// SQL string-literal escape for the where clause.
export function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Case-insensitive contains: UPPER(field) LIKE UPPER('%value%'). Runs of whitespace in
// the search text match anything, so 'Energy Geoscience' finds 'ENERGY  GEOSCIENCE INST'.
export function likeClause(field, value) {
  const pattern = `%${String(value).trim().replace(/\s+/g, "%")}%`;
  // A wildcard followed by digits reads to some firewalls as an encoded character ('%16',
  // '%00' as control characters; gis.geo-zs.si blocks '%5%' and '%20%' too) and gets the
  // request blocked. Doubling the wildcard means the same to SQL and passes them all.
  return `UPPER(${field}) LIKE UPPER(${sqlQuote(pattern.replace(/%(?=\d)/g, "%%"))})`;
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

/**
 * Numeric API fields (stored as Double): equality on the digits, then on the 10-digit API.
 * width14: the layer stores every API as a 14-digit number (USGS orphaned wells), so a
 * 10- or 12-digit API is padded with zero sidetrack/event digits first.
 */
export function numericApiClauses(field, api, width14 = false) {
  const digits = String(api).replace(/\D/g, "");
  const values = [digits];
  if (width14 && [10, 12, 14].includes(digits.length)) {
    values.splice(0, 1, digits.padEnd(14, "0"), digits.slice(0, 10).padEnd(14, "0"));
  } else if (digits.length > 10) values.push(digits.slice(0, 10));
  return [...new Set(values.map(stripZeros))].map((v) => `${field} = ${v}`);
}

// Lease words too common to search on alone.
const GENERIC_WORDS = new Set(["SECTION", "STATE", "UNIT", "FEDERAL", "LEASE", "GOVERNMENT", "COMMUNITY", "NORTH", "SOUTH", "EAST", "WEST", "WELL", "FIELD", "RANCH", "CREEK"]);
/** Enough of a well number to search on alone: three characters with a digit. */
const distinctive = (text) => text.length >= 3 && /\d/.test(text);

/** How many tiers wellNameWhere has. */
export const NAME_TIERS = 4;

/** `text` in the lease field, in the number field, or split between them (leading words + last one to three). */
function splitNameClause(field, number, words, numberWords = (w) => w) {
  const like = (f, w) => likeClause(f, w.join(" "));
  const alts = [like(field, words), like(number, numberWords(words))];
  for (let k = 1; k <= Math.min(3, words.length - 1); k++) {
    alts.push(`(${like(field, words.slice(0, -k))} AND ${like(number, numberWords(words.slice(-k)))})`);
  }
  return `(${alts.join(" OR ")})`;
}

/**
 * The well_name filter, in tiers from exact to loose. The caller ranks each tier's rows by
 * name similarity (rankByName) and asks the next tier only when one finds nothing, so a
 * name the registry spells the same way is never crowded out by look-alikes.
 *   tier 0   the text as typed (words in order, case-insensitive). For a source that
 *            keeps the well number in its own field (wellNumberField): all of it in the
 *            lease, all of it in the number, or its leading words in the lease with its
 *            last one to three in the number.
 *   tier 1   the same, forgiving: punctuation and zero padding are wildcards and a
 *            sidetrack suffix is dropped ('K&L 02-9 RD1' finds 'K & L 2-9'; 'Quintal
 *            310-512K' finds lease 'Quintal 310' + number '512 K')
 *   tier 2   the well number alone, when it is distinctive: the registry files the well
 *            under another lease name ('RVF 62-30' under its federal lease 'CA-12345',
 *            'Hot Creek 47A-26' as 'Well 47A-26', '22K-0450BT' as 'Larkin 0450BT')
 *   tier 3   the name's longest word alone: the number is written differently
 *            ('Garnet 4B' is 'Garnet 4', 'West Harbor 2' is 'W HARBOR 2')
 * Returns null when the name has no such tier, or the tier would repeat the one before.
 */
export function wellNameWhere(source, text, tier = 0) {
  const field = source.searchFields.well_name;
  const number = source.wellNumberField;
  const typed = String(text).trim().split(/\s+/).filter(Boolean);
  // wellNameAlso: a second field to look in, for a layer that leaves the name empty on many rows.
  const either = (words) => (source.wellNameAlso ? `(${likeClause(field, words.join(" "))} OR ${likeClause(source.wellNameAlso, words.join(" "))})` : likeClause(field, words.join(" ")));
  // One hyphenated word ('IW-5') may be a lease and a number stored apart.
  const parts = number && typed.length === 1 && /^[A-Z]+-\S/i.test(typed[0]) ? [typed[0].slice(0, typed[0].indexOf("-")), typed[0].slice(typed[0].indexOf("-") + 1)] : typed;
  const exact = number && parts.length ? splitNameClause(field, number, parts) : typed.length ? either(typed) : likeClause(field, text);
  if (tier === 0) return exact;
  const base = splitBore(text).base;
  const runs = nameWords(base);
  if (!runs.length) return null;
  const like = (f, words) => likeClause(f, words.join(" "));
  // In a number field, a letter/digit boundary may be punctuated or spaced: 'K418' is stored 'K-418', '512K' as '512 K'.
  const spaced = (words) => words.flatMap((w) => w.match(/[A-Z]+|\d+/g) ?? []);
  if (tier === 1) {
    // Letters and digits apart too: '15/9-19A' finds '15/9-19 A', 'HE10' finds 'HE-10'.
    const loose = number ? splitNameClause(field, number, runs, spaced) : either(spaced(runs));
    return loose.toUpperCase() === exact.toUpperCase() ? null : loose;
  }
  if (tier === 2) {
    const lastWord = nameWords(base.split(/\s+/).pop());
    const lastRun = runs.at(-1);
    // The last run alone when it is enough ('0450BT' of '22K-0450BT'), else the whole last word ('27X-15').
    if (distinctive(lastRun) && runs.length > 1) return like(number ?? field, number ? spaced([lastRun]) : [lastRun]);
    return distinctive(lastWord.join("")) && lastWord.length < runs.length ? like(number ?? field, number ? spaced(lastWord) : lastWord) : null;
  }
  if (tier === 3) {
    // The two longest words, either one: a registry may cut a long lease short ('Nowlin
    // Partnersh') or spell its longest word differently ('Wilbur Hot Sprng').
    const words = [...new Set(runs.filter((r) => /^[A-Z]{4,}$/.test(r) && !GENERIC_WORDS.has(r)))].sort((x, y) => y.length - x.length).slice(0, 2);
    if (!words.length || runs.length < 2) return null;
    return words.length === 1 ? like(field, words) : `(${words.map((w) => like(field, [w])).join(" OR ")})`;
  }
  return null;
}

/**
 * The exact WHERE clause for a non-API identifier (UWI, wellbore name, licence no). The
 * forgiving lookups (same tokens, then whole tokens inside a longer id) run in findById,
 * because a plain contains-match finds the wrong wells ('AWG-1' is inside 'AWG-101').
 */
export function idMatchClauses(field, id) {
  return [eqClause(field, String(id).trim())];
}

/** Starts with the text, case-insensitive: a descriptive sibling of a code field ('Plugged' -> 'Plugged Well', not 'Unplugged Well'). */
const prefixClause = (field, text) => `UPPER(${field}) LIKE UPPER(${sqlQuote(`${String(text).trim()}%`)})`;

const NEGATIONS = new Set(["NOT", "NON", "NEVER", "NO"]);
const foldUpper = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/**
 * Does a code's label hold the filter text (3 characters or more) at the start of a word,
 * not right after a negation? 'Drilled' is in 'Drilled and cased' but not in 'Authorized
 * (not drilled)' or 'Undrilled'; 'Plug' is in 'Plugged and abandoned'.
 */
export function labelHolds(label, text) {
  const l = foldUpper(label);
  const t = foldUpper(text).trim();
  if (t.length < 3) return false;
  for (let i = l.indexOf(t); i >= 0; i = l.indexOf(t, i + 1)) {
    if (i > 0 && /[A-Z0-9]/.test(l[i - 1])) continue; // inside a word
    const before = l.slice(0, i).match(/([A-Z]+)[^A-Z0-9]*$/);
    if (!before || !NEGATIONS.has(before[1])) return true;
  }
  return false;
}

/** The codes of a table a filter selects: the code as typed, or the codes whose label holds the text (labelHolds). */
export function matchingCodes(table, text) {
  const t = String(text).trim().toUpperCase();
  return Object.entries(table)
    .filter(([code, label]) => code.toUpperCase() === t || labelHolds(label, t))
    .map(([code]) => code);
}

/**
 * A status or type filter on a coded field (source.codes): the code typed, or the codes
 * whose label holds the text at a word start ('Suspended' finds SUSP, 'SUSP' still works;
 * 'Drilled' does not find '(not drilled)'), never a code that merely contains it ('A' must
 * not find 'PA'). `also`: a descriptive sibling field matched by prefix (source.codeAlso).
 */
export function codedClause(field, text, table, also = null) {
  const codes = matchingCodes(table, text);
  const exact = codes.length ? inClause(field, codes) : eqClause(field, String(text).trim());
  return also ? `(${exact} OR ${prefixClause(also, text)})` : exact;
}

/** A field of short codes with no table (source.codeFields): exact, so 'A' does not find 'PA'; plus a descriptive sibling by prefix. */
export function codeFieldClause(field, text, also = null) {
  const exact = eqClause(field, String(text).trim());
  return also ? `(${exact} OR ${prefixClause(also, text)})` : exact;
}

/**
 * Query a layer with pagination. Returns { features, exceededLimit }.
 * Each feature: { attributes, geometry } with geometry in WGS84 (lon/lat).
 * noReproject: some servers 500 on outSR reprojection (e.g. NZPAM); those layers
 *   carry explicit lat/lon attribute fields, so skip geometry entirely.
 * noPaging: some servers 400 on resultOffset/resultRecordCount (DOGAMI, Colombia's SGC);
 *   page them by object id instead: fetch the matching ids, then one page of records.
 */
export async function queryLayer(layerUrl, { where = "1=1", outFields = "*", limit = 100, offset = 0, geometryParams = null, distinct = false, noReproject = false, noPaging = false, orderBy = null, headers, timeoutMs, hedgeAfterMs = 0 } = {}) {
  const base = {
    where,
    outFields,
    ...(noReproject ? { returnGeometry: "false" } : { outSR: 4326, returnGeometry: distinct ? "false" : "true" }),
  };
  if (geometryParams) Object.assign(base, geometryParams);
  if (noPaging && !distinct) return queryByIds(layerUrl, base, { limit, offset, headers, timeoutMs, hedgeAfterMs });
  if (!noPaging) Object.assign(base, { resultOffset: String(offset), resultRecordCount: String(limit) });
  if (distinct) base.returnDistinctValues = "true";
  if (orderBy) base.orderByFields = orderBy;
  const data = await arcgisJson(`${layerUrl}/query`, base, headers, timeoutMs, hedgeAfterMs);
  return { features: data.features ?? [], exceededLimit: Boolean(data.exceededTransferLimit) };
}

/** Paging for servers without resultOffset: ids first (uncapped), then one page by objectIds. */
async function queryByIds(layerUrl, base, { limit, offset, headers, timeoutMs, hedgeAfterMs = 0 }) {
  const { where, geometry, geometryType, inSR, distance, units, spatialRel } = base;
  const idParams = { where, returnIdsOnly: "true", ...(geometry ? { geometry, geometryType, inSR, distance, units, spatialRel } : {}) };
  const ids = (await arcgisJson(`${layerUrl}/query`, idParams, headers, timeoutMs, hedgeAfterMs)).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const page = ids.slice(offset, offset + limit);
  if (!page.length) return { features: [], exceededLimit: false };
  const { outFields, outSR, returnGeometry } = base;
  const data = await arcgisJson(
    `${layerUrl}/query`,
    { objectIds: page.join(","), outFields, returnGeometry: returnGeometry ?? "true", ...(outSR ? { outSR } : {}) },
    headers,
    timeoutMs,
    hedgeAfterMs
  );
  return { features: data.features ?? [], exceededLimit: ids.length > offset + limit };
}

/** Count matching records without pulling them. */
export async function countLayer(layerUrl, { where = "1=1", geometryParams = null, headers, timeoutMs, hedgeAfterMs = 0 } = {}) {
  const base = { where, returnCountOnly: "true" };
  if (geometryParams) Object.assign(base, geometryParams);
  const data = await arcgisJson(`${layerUrl}/query`, base, headers, timeoutMs, hedgeAfterMs);
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

/** The circle's bounding box, for servers that ignore a point query's distance. */
export function envelopeParams(latitude, longitude, radiusMeters) {
  const [xmin, ymin, xmax, ymax] = radiusToBbox(latitude, longitude, radiusMeters);
  return {
    geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryEnvelope",
    inSR: 4326,
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
//   hedgeAfterMs   send a request a second time when it has no answer after this long, and
//                  take the first answer (servers whose instances sometimes stall: BOEM)
//   noReproject, noPaging, emptyResultBug   server quirks, see queryLayer/querySource
//   nearAsEnvelope radius searches send the circle's bounding box (the server ignores a
//                  point query's distance); the caller trims results to the circle
//   apiNumeric     the api field is a number, so match it with '=' not UPPER/LIKE
//   apiDigits14    with apiNumeric: every API is stored as a 14-digit number
//   dedupeBy       attribute that identifies a well when a layer repeats rows
//   orderBy        sort for every query (with dedupeBy: which repeated row is kept, e.g. the latest)
//   fallbackUrl    the same layer on a second service, used when url fails (then for the rest of the process)
//   layerName      the layer's name, so a renumbered layer can be found again in a service with many
//   prepare()      async; loads lookup tables the normalizer needs (called before each query)
//   operatorWhere(text)  async; custom SQL for the operator filter (e.g. names -> company numbers)
//   wellNumberField the well number, where the layer keeps it apart from the lease / farm
//                  name that searchFields.well_name points at (see wellNameWhere)
//   wellNameAlso   a second field a name search looks in (a layer whose name field is
//                  empty on many rows, so the record shows its id as the name)
//   codes          { status | well_type: { CODE: 'Label' } }: decoded in the output, and a
//                  filter word finds the codes whose label holds it (see codedClause)
//   codeFields     filters whose field holds short codes with no table: matched exactly
//   codeAlso       { status | well_type: field }: a descriptive sibling, matched by prefix
//   filterWhere    { filter: async (text) => SQL }: custom SQL for one filter (a county
//                  stored as a code, say); operatorWhere is the same for the operator
//   nameWhere(text, tier)  async; custom SQL for a name tier, null when the tier does not
//                  apply, undefined to use the usual tiers (OCS lease-qualified names)
//   uwi            { style, field? }: Canadian UWIs any spelling (src/uwi.js)
//   idAlso         { field, test?, pad? }: a second field an id may be in
//   plainSql       the server's firewall rejects SQL functions, IN and '%' (AER): text
//                  filters become equality on the layer's own distinct values, kept a day
//   idFormat(id)   with plainSql: the stored form of an id ('33885' -> '0033885')

// plainSql sources: their distinct values of a field, fetched page by page, kept a day.
const distinctLists = new Map(); // `${key}|${field}` -> cachedValue
function distinctValues(source, field) {
  const key = `${source.key}|${field}`;
  if (!distinctLists.has(key)) {
    distinctLists.set(
      key,
      cachedValue(
        `distinct-${key}`,
        async () => {
          const out = [];
          for (let offset = 0; ; offset += source.pageMax) {
            const { features, exceededLimit } = await querySource(source, { where: "1=1", outFields: field, distinct: true, orderBy: field, limit: source.pageMax, offset });
            out.push(...features.map((f) => f.attributes?.[field]).filter((v) => v != null && String(v).trim() !== ""));
            if (!exceededLimit || !features.length) break;
          }
          return out;
        },
        { ttlMs: 24 * 3600_000 }
      )
    );
  }
  return distinctLists.get(key).get();
}

// plainSql: values per OR-joined clause, and the most clauses one filter may need (search and
// count send one request per clause, so a filter matching more values than this is refused).
const PLAIN_BATCH = 100;
const PLAIN_MAX_BATCHES = 50;

/**
 * plainSql: a contains-match done here, sent as equality on the matching values (the server
 * ignores trailing pad spaces). Every matching value is sent, PLAIN_BATCH to a clause: the
 * clauses are alternatives over disjoint values, and search and count run each of them.
 */
async function plainContains(source, field, text) {
  const hits = [...new Set((await distinctValues(source, field)).filter((v) => containsWords(v, text)).map((v) => String(v).trimEnd()))];
  if (!hits.length) return ["1=0"];
  const batches = [];
  for (let i = 0; i < hits.length; i += PLAIN_BATCH) batches.push(`(${hits.slice(i, i + PLAIN_BATCH).map((v) => `${field} = ${sqlQuote(v)}`).join(" OR ")})`);
  return batches;
}

/**
 * An API filter that finds the well however the layer writes the number: every exact form
 * in one IN, or the dash-tolerant county + sequence. Layers behind a firewall that rejects
 * OR-joined tests (BOEM's, the ones with apiPattern) get the IN alone.
 */
function usApiFilter(source, field, v) {
  const digits = String(v).replace(/\D/g, "");
  const exact = inClause(field, [String(v).trim(), digits, apiDashed(v), ...(digits.length === 10 ? [`${digits}00`, `${digits}0000`] : [])].filter(Boolean));
  const cs = apiCountySequence(v);
  return cs && !source.apiPattern ? `(${exact} OR ${likeClause(field, `${cs.county}%${cs.sequence}`)})` : exact;
}

const plainId = (source, id) => `${source.searchFields.api} = ${sqlQuote(source.idFormat ? source.idFormat(id) : String(id).trim())}`;

/**
 * Build a WHERE clause from normalized filters against one source's field map.
 * nameTier picks the well_name tier (see wellNameWhere); `where` is null when the source has none.
 * `batches` (plainSql, a filter matching more than PLAIN_BATCH values): WHERE clauses over
 * disjoint sets of records that together make the answer; `where` is the first of them.
 */
export async function buildWhere(source, filters, { nameTier = 0 } = {}) {
  const clauses = source.baseWhere ? [`(${source.baseWhere})`] : [];
  const unsupported = [];
  const split = []; // [clause index, alternative clauses] for plainSql filters with several batches
  let noTier = false;
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) {
      unsupported.push(k);
      continue;
    }
    if (source.filterWhere?.[k]) clauses.push(await source.filterWhere[k](v));
    else if (k === "operator" && source.operatorWhere) clauses.push(await source.operatorWhere(v));
    else if (source.plainSql) {
      if (k === "well_name" && nameTier > 0) noTier = true;
      else if (k === "api") clauses.push(plainId(source, v));
      else {
        const batches = await plainContains(source, field, v);
        if (batches.length > 1) split.push([clauses.length, batches, k, v]);
        clauses.push(batches[0]);
      }
    } else if (k === "api" && source.apiDigits14) clauses.push(`(${numericApiClauses(field, v, true).join(" OR ")})`);
    // A numeric-id source's ids are numbers: text with letters is a name, never one of them.
    else if (k === "api" && source.apiNumeric) clauses.push(`${field} = ${(source.idKind !== "us-api" && hasLetters(v) ? "" : stripZeros(String(v).replace(/\D/g, ""))) || -1}`);
    else if ((k === "status" || k === "well_type") && source.codes?.[k]) clauses.push(codedClause(field, v, source.codes[k], source.codeAlso?.[k]));
    else if (source.codeFields?.includes(k)) clauses.push(codeFieldClause(field, v, source.codeAlso?.[k]));
    else if (k === "well_name") {
      const custom = source.nameWhere ? await source.nameWhere(v, nameTier) : undefined;
      const clause = custom === undefined ? wellNameWhere(source, v, nameTier) : custom;
      if (clause) clauses.push(clause);
      else noTier = true;
    } else if (k === "api" && source.idKind === "us-api") clauses.push(usApiFilter(source, field, v));
    else clauses.push(k === "api" ? eqClause(field, v) : likeClause(field, v));
  }
  if (noTier || (nameTier > 0 && !filters.well_name)) return { where: null, unsupported };
  if (!split.length) return { where: clauses.length ? clauses.join(" AND ") : "1=1", unsupported };
  let combos = [clauses];
  for (const [i, alternatives, k, v] of split) {
    combos = combos.flatMap((c) => alternatives.map((alt) => c.map((x, j) => (j === i ? alt : x))));
    if (combos.length > PLAIN_MAX_BATCHES) {
      throw new Error(`${source.key}: the ${k} filter '${v}' matches too many of the layer's values to send (${source.key} takes only exact values); use a longer or more specific text`);
    }
  }
  const batches = combos.map((c) => c.join(" AND "));
  return { where: batches[0], batches, unsupported };
}

function withBase(source, where) {
  return source.baseWhere ? `(${source.baseWhere}) AND (${where})` : where;
}

const useFallback = new Set(); // source keys whose primary url failed
const relocated = new Map(); // source key -> layer url found after its configured layer id went away

/**
 * A service republished under a new layer id (ArcGIS Online does this when its owner
 * overwrites it; agencies renumber when they reload): among the service's data layers
 * (group layers left out), the one named source.layerName, or the only one.
 */
async function findMovedLayer(source) {
  const m = /^(.*\/(?:FeatureServer|MapServer))\/\d+$/.exec(source.url);
  if (!m) return null;
  const service = await arcgisJson(m[1], {}, source.headers, source.timeoutMs);
  const data = (service.layers ?? []).filter((l) => !l.subLayerIds?.length && (!l.type || /feature layer/i.test(l.type)));
  const named = source.layerName ? data.filter((l) => String(l.name).trim().toUpperCase() === source.layerName.toUpperCase()) : data;
  const pick = source.layerName ? named[0] : named.length === 1 ? named[0] : null;
  const moved = pick ? `${m[1]}/${pick.id}` : null;
  return moved && moved !== source.url ? moved : null;
}

/** Did this error come from a layer id that no longer exists (as opposed to a query the layer rejects)? */
async function layerGone(source, e) {
  const msg = String(e?.message);
  if (/error 400: Invalid URL/i.test(msg)) return true;
  // Some servers answer a missing layer id like a bad query: ask for the layer itself to tell them apart.
  if (!/error 400: Invalid or missing input parameters/i.test(msg)) return false;
  return arcgisJson(source.url, {}, source.headers, source.timeoutMs).then(() => false, () => true);
}

/**
 * Run a request against the source's url. If its layer id is gone, look for the layer
 * under its new id; if it fails otherwise and the source names a fallbackUrl (the same
 * layer published by a second service), retry there. Either way, stay with what worked
 * for the rest of the process.
 */
async function withFallback(source, request) {
  if (relocated.has(source.key)) return request(relocated.get(source.key));
  if (source.fallbackUrl && useFallback.has(source.key)) return request(source.fallbackUrl);
  try {
    return await request(source.url);
  } catch (e) {
    if (await layerGone(source, e)) {
      const moved = await findMovedLayer(source).catch(() => null);
      if (moved) {
        const result = await request(moved);
        relocated.set(source.key, moved);
        return result;
      }
    }
    if (!source.fallbackUrl || /error 400/i.test(String(e.message))) throw e; // a bad query fails on both
    const result = await request(source.fallbackUrl);
    useFallback.add(source.key);
    return result;
  }
}

/** queryLayer with per-source quirks applied (reprojection bug, 500-on-empty bug, duplicate rows). */
async function querySource(source, opts) {
  await source.prepare?.();
  let result;
  try {
    result = await withFallback(source, (url) =>
      queryLayer(url, {
        outFields: source.outFields ?? "*",
        orderBy: source.orderBy ?? null,
        ...opts,
        noReproject: source.noReproject,
        noPaging: source.noPaging,
        headers: source.headers,
        timeoutMs: source.timeoutMs,
        hedgeAfterMs: source.hedgeAfterMs,
      })
    );
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
function geometryFor(source, near) {
  if (!near) return null;
  return (source.nearAsEnvelope ? envelopeParams : nearParams)(near.latitude, near.longitude, near.radiusKm * 1000);
}

/**
 * One test for several exact values. Written as IN, not as '=' joined by OR: firewalls in
 * front of some servers (BOEM) reject the OR form as an injection attempt.
 */
export function inClause(field, values) {
  return `UPPER(${field}) IN (${[...new Set(values.map(String))].map((v) => `UPPER(${sqlQuote(v)})`).join(", ")})`;
}

/**
 * WHERE clauses get_well tries in order: every exact form in one query, then the contains
 * form - so a miss costs two requests. For a 10-digit API the exact forms include the
 * 12- and 14-digit numbers of the original hole ('...00', '...0000').
 */
export function idTiers(source, id) {
  const field = source.searchFields.api;
  if (source.plainSql) return [plainId(source, id)];
  const digits = String(id).replace(/\D/g, "");
  if (source.apiNumeric) {
    if (!digits || (source.idKind !== "us-api" && hasLetters(id))) return [];
    const values = source.idKind === "us-api" ? numericApiClauses(field, id, source.apiDigits14).map((c) => c.split(" = ")[1]) : [stripZeros(digits)];
    return [values.length > 1 ? `${field} IN (${values.join(", ")})` : `${field} = ${values[0]}`];
  }
  if (source.idKind !== "us-api") {
    const also = idAlsoValue(source, id);
    const [exact] = idMatchClauses(field, id);
    return [also != null ? `(${exact} OR ${eqClause(source.idAlso.field, also)})` : exact];
  }
  const exact = [String(id).trim(), digits, apiDashed(id), ...(digits.length === 10 ? [`${digits}00`, `${digits}0000`] : [])].filter(Boolean);
  const cs = apiCountySequence(id);
  // A 10-digit API names the well: every bore of it ('...00', '...01', '...0100'), the sidetracks and the live bore included.
  const bores = digits.length === 10 ? [`${field} LIKE ${sqlQuote(`${digits}%`)}`] : [];
  return [...bores, inClause(field, exact), ...(cs ? [likeClause(field, `${cs.county}%${cs.sequence}`)] : [])];
}

/**
 * A Canadian UWI, written any way (src/uwi.js), in the form the layer stores it (source.uwi):
 * the well itself, else (no exception code or event sequence given, or none stored) every
 * well at that location, flagged partial. null when the source keeps no UWIs or the id is not one.
 */
async function findByUwi(source, id) {
  if (!source.uwi) return null;
  const u = parseUwi(id);
  if (!u) return null;
  const field = source.uwi.field ?? source.searchFields.api;
  const forms = uwiForms(u, source.uwi.style);
  if (forms.length) {
    const { features } = await querySource(source, { where: withBase(source, inClause(field, forms)), limit: 10 });
    // A layer that keeps only the surface location ('dls') cannot single out the bore a full
    // UWI names (its LSD is the bottom hole's): those hits are wells at that location.
    const located = source.uwi.style === "dls" && uwiCompact(u) != null;
    if (features.length) return toRows(features).map((r) => (located ? { ...r, partial: true } : r));
  }
  if (source.uwi.style !== "compact" && source.uwi.style !== "sk") return [];
  const { features } = await querySource(source, { where: withBase(source, likeClause(field, uwiCore(u))), limit: 10 });
  return toRows(features).map((r) => ({ ...r, partial: true }));
}

/**
 * After the exact tiers miss, for a source with its own ids: the same id written another
 * way ('15/9-19A' = '15/9-19 A', 'AWG-1' = 'AWG-01'), else the id as whole tokens inside a
 * longer one ('Qulleq' in 'Qulleq-1'), flagged partial - never digits inside other digits.
 */
async function findByIdTokens(source, id) {
  const field = source.searchFields.api;
  const toks = idTokens(id);
  if (!toks.length) return [];
  // An id that is a name plus a number the layer keeps apart (NS-OFF 'Onondaga E-84').
  const words = String(id).trim().split(/\s+/);
  if (source.wellNumberField && words.length >= 2) {
    const where = `(${eqClause(field, words.slice(0, -1).join(" "))} AND ${eqClause(source.wellNumberField, words.at(-1))})`;
    const { features } = await querySource(source, { where: withBase(source, where), limit: 5 });
    if (features.length) return toRows(features);
  }
  const like = withBase(source, likeClause(field, toks.join(" ")));
  let ids;
  try {
    ids = await candidateIds(source, field, like, (v) => sameIdTokens(v, id));
  } catch {
    // A server that refuses distinct queries: the first rows of the contains-match only.
    const { features } = await querySource(source, { where: like, limit: Math.min(200, source.pageMax) });
    ids = features.map((f) => f.attributes?.[field]);
  }
  const rowsFor = async (values) => (values.length ? toRows((await querySource(source, { where: withBase(source, inClause(field, values)), limit: 5 })).features) : []);
  const same = ids.filter((v) => sameIdTokens(v, id));
  if (same.length) return rowsFor(same.slice(0, 5));
  if (!partialWorthy(id)) return [];
  return (await rowsFor(ids.filter((v) => idTokenRun(v, id)).slice(0, 5))).map((r) => ({ ...r, partial: true }));
}

// Distinct ids findByIdTokens reads, at most, before it gives up on finding the same id.
const ID_SCAN_PAGES = 5;

/**
 * The stored ids a contains-match finds, read as distinct values of the id field alone, page
 * by page until `done` holds for one of them or the ids run out (ID_SCAN_PAGES at most). A
 * broad pattern ('%99%1%2%' for '99/1-2') can match thousands of rows before the one that is
 * the same id with its zero padding ('99/01- 2').
 */
async function candidateIds(source, field, where, done) {
  const out = [];
  for (let page = 0, offset = 0; page < ID_SCAN_PAGES; page++, offset += source.pageMax) {
    const { features, exceededLimit } = await querySource(source, { where, outFields: field, distinct: true, orderBy: field, limit: source.pageMax, offset });
    const values = features.map((f) => f.attributes?.[field]).filter((v) => v != null);
    out.push(...values);
    if (values.some(done) || !exceededLimit || !features.length || source.noPaging) break;
  }
  return out;
}

const countWhere = (source, where, near) =>
  withFallback(source, (url) => countLayer(url, { where, geometryParams: geometryFor(source, near), headers: source.headers, timeoutMs: source.timeoutMs, hedgeAfterMs: source.hedgeAfterMs }));

/** fn over items, at most `n` at a time, results in item order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * One page of a search split into WHERE batches over disjoint records (buildWhere): the
 * batches in order, as if one answer. Batches wholly before the offset are counted, not read.
 */
async function searchBatches(source, batches, { limit, offset, near }) {
  const rows = [];
  let skip = offset;
  for (let i = 0; i < batches.length; i++) {
    if (rows.length >= limit) return { rows, moreAvailable: true };
    if (skip > 0) {
      const n = await countWhere(source, batches[i], near);
      if (n != null && n <= skip) {
        skip -= n;
        continue;
      }
    }
    const { features, exceededLimit } = await querySource(source, { where: batches[i], limit: limit - rows.length, offset: skip, geometryParams: geometryFor(source, near) });
    skip = 0;
    rows.push(...toRows(features));
    if (exceededLimit) return { rows, moreAvailable: true };
  }
  return { rows, moreAvailable: false };
}

export const arcgisProvider = {
  canRaw: () => true,
  nameTiers: NAME_TIERS, // search() takes nameTier 0..NAME_TIERS-1; 0 and 1 are the name itself

  async search(source, filters, { limit, offset = 0, near = null, nameTier = 0 }) {
    const { where, batches, unsupported } = await buildWhere(source, filters, { nameTier });
    if (where == null) return { rows: [], moreAvailable: false, unsupported, noTier: true };
    if (batches) return { ...(await searchBatches(source, batches, { limit: Math.min(limit, source.pageMax), offset, near })), unsupported };
    const { features, exceededLimit } = await querySource(source, {
      where,
      limit: Math.min(limit, source.pageMax),
      offset,
      geometryParams: geometryFor(source, near),
    });
    return { rows: toRows(features), moreAvailable: exceededLimit, unsupported };
  },

  async count(source, filters, { near = null } = {}) {
    const { where, batches, unsupported } = await buildWhere(source, filters);
    let count;
    if (batches) {
      const counts = await mapLimit(batches, 4, (w) => countWhere(source, w, near));
      count = counts.some((n) => n == null) ? null : counts.reduce((a, b) => a + b, 0);
    } else count = await countWhere(source, where, near);
    // A name is counted as typed; search also ranks, trims and tries looser spellings, so the two can differ.
    const approximate = (near && source.nearAsEnvelope) || Boolean(filters.well_name && source.searchFields.well_name);
    return { count, ...(approximate ? { approximate: true } : {}), unsupported };
  },

  async findById(source, id) {
    const byUwi = await findByUwi(source, id);
    if (byUwi?.some((r) => !r.partial)) return byUwi;
    for (const where of idTiers(source, id)) {
      const { features } = await querySource(source, { where: withBase(source, where), limit: 20 });
      if (features.length) return toRows(features);
    }
    if (byUwi?.length) return byUwi;
    if (source.idKind === "us-api" || source.apiNumeric || source.plainSql) return [];
    return findByIdTokens(source, id);
  },

  async distinct(source, fieldKey, text, limit = 200) {
    const field = source.searchFields[fieldKey];
    if (source.plainSql) return (await distinctValues(source, field)).filter((v) => containsWords(v, text)).slice(0, limit);
    const { where } = await buildWhere(source, { [fieldKey]: text });
    // Many servers (ArcGIS Server on an enterprise geodatabase) answer a paged distinct
    // query with a bare 400 unless it is also ordered, so always order by the field.
    const { features } = await querySource(source, {
      where,
      outFields: field,
      limit: Math.min(source.pageMax, limit),
      distinct: true,
      orderBy: field,
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
