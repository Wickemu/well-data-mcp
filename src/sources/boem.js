// US federal offshore (Outer Continental Shelf) wells from BOEM/BSEE's ArcGIS layers.
//
// The layers hold little: API number, a bare well name (' A011', '  001'), the operator as a
// 5-digit BOEM company number, spud/completion dates and water depth. Two BOEM files fill
// the gaps, each kept for a day in memory and on disk (src/disk-cache.js) so a new process
// does not download them again:
//   - the company file (CompanyRawData.zip, ~340 KB): operator searches match names and
//     results show them;
//   - the borehole file (BoreholeRawData.zip, ~3.5 MB, one row per API): lease, area/block,
//     sidetrack/bypass, MD/TVD, RKB, TD date and bottom-hole position. With it a name as a
//     mud log writes it ('OCS-G 11081 A-11', 'GC 645 A-11', 'OCS P-0999 #1') finds the bores
//     on that lease or block, instead of every A011 in the Gulf.
// Queries wait for the files briefly, then go ahead without them (operators show as
// company numbers, names fall back to the usual search).

import { fetchBuffer } from "../http.js";
import { unzipEntry } from "../zip.js";
import { parseCsv, csvObjects } from "../csv.js";
import { usDateToIso, msToIso, num, geomFirst } from "./normalize.js";
import { sqlQuote } from "../providers/arcgis.js";
import { cachedValue } from "../disk-cache.js";

const COMPANY_ZIP = "https://www.data.boem.gov/Company/Files/CompanyRawData.zip";
const BOREHOLE_ZIP = "https://www.data.boem.gov/Well/Files/BoreholeRawData.zip";
const DAY_MS = 24 * 3600_000;

// gis.boem.gov's firewall rejects a GET whose URL runs past about 2,000 characters (measured
// November 2026: a 60-value IN list passes, 100 do not). The ArcGIS provider sends a query
// that long as a form POST instead, which BOEM accepts with 300 values, so an IN list is
// cut to this many URL-encoded characters (about 300 company or API numbers).
const WHERE_BUDGET = 4500;

/**
 * `field IN ('v1','v2',...)` holding as many values as fit the URL budget, or "1=0" for none.
 * Plain IN without UPPER(): the values are digits, and UPPER() on each would halve the room.
 * Returns { sql, kept, total }.
 */
export function boundedIn(field, values, budget = WHERE_BUDGET) {
  const unique = [...new Set(values.map(String))];
  const kept = [];
  for (const v of unique) {
    const next = `${field} IN (${[...kept, v].map(sqlQuote).join(",")})`;
    if (kept.length && new URLSearchParams({ where: next }).toString().length > budget) break; // as the request encodes it
    kept.push(v);
  }
  return { sql: kept.length ? `${field} IN (${kept.map(sqlQuote).join(",")})` : "1=0", kept: kept.length, total: unique.length };
}

// ------------------------------------------------------------------ company file

// [[company number, name], ...]: a list, so the disk copy is plain JSON.
const companyList = cachedValue(
  "boem-companies",
  async () => {
    const zip = await fetchBuffer(COMPANY_ZIP, { timeoutMs: 60_000 });
    const text = unzipEntry(zip, "mv_companies_all.txt").toString("latin1");
    return csvObjects(parseCsv(text)).map((r) => [r.MMS_COMPANY_NUM, r.BUS_ASC_NAME?.trim()]);
  },
  { ttlMs: DAY_MS }
);
let companies = null; // Map number -> name, built from the list below
let companiesFrom = null;

async function loadCompanies() {
  const list = await companyList.get();
  if (list !== companiesFrom) {
    companies = new Map(list);
    companiesFrom = list;
  }
  return companies;
}

// ------------------------------------------------------------------ borehole file

// Field order of one compact borehole record (an array, so the disk copy stays a few MB of
// JSON instead of ~130 MB of parsed CSV objects).
const B = { api: 0, region: 1, name: 2, suffix: 3, botLease: 4, area: 5, block: 6, surfLease: 7, md: 8, tvd: 9, rkb: 10, td: 11, dLat: 12, dLon: 13 };

const trimmed = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
// Beyond this (about 16 km) a bottom-hole offset is a typing error, not a bore (one in the
// November 2026 file).
const MAX_OFFSET_DEG = 0.15;
const offset = (bottom, surface) => {
  const [b, s] = [num(trimmed(bottom)), num(trimmed(surface))];
  if (!b || !s) return null; // missing, or a zero placeholder
  const d = Math.round((b - s) * 1e7) / 1e7;
  return d === 0 || Math.abs(d) > MAX_OFFSET_DEG ? null : d;
};

/** One row of mv_boreholes_all.txt -> the compact record. */
export function boreRecord(r) {
  const out = [];
  out[B.api] = trimmed(r.API_WELL_NUMBER);
  out[B.region] = trimmed(r.REGION_CODE);
  out[B.name] = trimmed(r.WELL_NAME);
  out[B.suffix] = trimmed(r.WELL_NAME_SUFFIX);
  out[B.botLease] = trimmed(r.BOTM_LEASE_NUMBER);
  out[B.area] = trimmed(r.BOTM_AREA_CODE);
  out[B.block] = trimmed(r.BOTM_BLOCK_NUMBER)?.replace(/\s+/g, "") ?? null;
  out[B.surfLease] = trimmed(r.SURF_LEASE_NUMBER);
  out[B.md] = num(trimmed(r.BH_TOTAL_MD), { zeroIsNull: true });
  out[B.tvd] = num(trimmed(r.WELL_BORE_TVD), { zeroIsNull: true });
  out[B.rkb] = num(trimmed(r.RKB_ELEVATION));
  out[B.td] = usDateToIso(trimmed(r.TOTAL_DEPTH_DATE));
  // The bottom hole as an offset from the surface: the file's Gulf positions are NAD27
  // (~35 m from WGS84), so the offset is applied to the layer's geometry instead.
  const [dLat, dLon] = [offset(r.BOTM_LATITUDE, r.SURF_LATITUDE), offset(r.BOTM_LONGITUDE, r.SURF_LONGITUDE)];
  const junk = (v, b, s) => v == null && num(trimmed(b)) !== num(trimmed(s)); // one half unusable: drop both
  [out[B.dLat], out[B.dLon]] = junk(dLat, r.BOTM_LATITUDE, r.SURF_LATITUDE) || junk(dLon, r.BOTM_LONGITUDE, r.SURF_LONGITUDE) ? [null, null] : [dLat, dLon];
  return out;
}

const boreholeList = cachedValue(
  "boem-boreholes",
  async () => {
    const zip = await fetchBuffer(BOREHOLE_ZIP, { timeoutMs: 90_000 });
    const text = unzipEntry(zip, "mv_boreholes_all.txt").toString("latin1");
    return csvObjects(parseCsv(text)).map(boreRecord).filter((r) => r[B.api]);
  },
  { ttlMs: DAY_MS }
);

// Lease numbers compared as letter + number: 'G11081' -> 'G|11081', old Gulf ' 00299' -> '|299'.
export function leaseKey(v) {
  const m = /^\s*([A-Z]?)\s*0*(\d+)\s*$/i.exec(v ?? "");
  return m ? `${m[1].toUpperCase()}|${m[2]}` : null;
}

// Well names compared as letters + number: ' A011' / 'A-11' -> 'A|11', '  001' / '#1' -> '|1', 'SN001' -> 'SN|1'.
export function wellKey(v) {
  const s = String(v ?? "")
    .toUpperCase()
    .replace(/^\s*(?:WELL|NO\.?)\s*/, "")
    .replace(/#/g, " ");
  const m = /^\s*([A-Z]{0,3})[\s-]*0*(\d{1,4})([A-Z]?)\s*$/.exec(s);
  return m ? `${m[1]}|${m[2]}${m[3]}` : null;
}
const wellDigits = (key) => key?.split("|")[1]?.replace(/\D/g, "") || null;

// Blocks compared without spaces or zero padding: 'GC','  645' -> 'GC|645'; 'BA','A  19' -> 'BA|A19'.
export function blockKey(area, block) {
  const a = String(area ?? "").trim().toUpperCase();
  const m = /^([A-Z]?)0*(\d+)([A-Z]?)$/.exec(String(block ?? "").replace(/[\s-]/g, "").toUpperCase());
  return a && m ? `${a}|${m[1]}${m[2]}${m[3]}` : null;
}

/** The sidetrack and bypass numbers of a BOEM suffix: 'ST01BP00' -> { st: 1, bp: 0 }. */
export function suffixParts(suffix) {
  const m = /^ST(\d+)BP(\d+)$/i.exec(String(suffix ?? "").trim());
  return m ? { st: Number(m[1]), bp: Number(m[2]) } : null;
}

/** 'G11081' -> 'OCS-G 11081', ' 00299' -> 'OCS 00299'; leases that are not numbers ('DPST', 'NOLEASE') -> null. */
export function leaseLabel(lease) {
  const m = /^\s*([A-Z]?)\s*(\d+)\s*$/i.exec(lease ?? "");
  return m ? `OCS${m[1] ? `-${m[1].toUpperCase()}` : ""} ${m[2]}` : null;
}

/**
 * The name to show for a bore: the surface lease (it nearly always stays the same through a
 * well's sidetracks - 101 of 39,570 wells in November 2026 - while the bottom lease changes
 * on 1,325) and the well name, plus ' ST1' for a
 * sidetrack. A bypass is left to `bore`: name matching reads 'ST1' as a sidetrack, not 'BP1'.
 */
export function boreName(rec) {
  const name = rec[B.name];
  if (!name) return null;
  const lease = leaseLabel(rec[B.surfLease] ?? rec[B.botLease]);
  const parts = suffixParts(rec[B.suffix]);
  const st = parts && parts.st > 0 && parts.bp === 0 ? ` ST${parts.st}` : "";
  return `${lease ? `${lease} ` : ""}${name}${st}`;
}

/** Maps for lookup: by API, and by (lease | block) + well, across every region. */
export function buildBoreIndex(list) {
  const byApi = new Map();
  const byLeaseWell = new Map(); // `${leaseKey}|${wellKey}` -> [api], under both bottom and surface lease
  const byBlockWell = new Map(); // `${blockKey}|${wellKey}` -> [api], bottom area/block
  const byLease = new Map(); // leaseKey -> [api]
  const byBlock = new Map(); // blockKey -> [api]
  const areas = new Set();
  const add = (map, key, api) => {
    const list = map.get(key);
    if (!list) map.set(key, [api]);
    else if (!list.includes(api)) list.push(api);
  };
  for (const rec of list) {
    const api = rec[B.api];
    byApi.set(api, rec);
    const w = wellKey(rec[B.name]);
    for (const l of new Set([leaseKey(rec[B.botLease]), leaseKey(rec[B.surfLease])])) {
      if (!l) continue;
      add(byLease, l, api);
      if (w) add(byLeaseWell, `${l}|${w}`, api);
    }
    const b = blockKey(rec[B.area], rec[B.block]);
    if (b) {
      areas.add(rec[B.area].toUpperCase());
      add(byBlock, b, api);
      if (w) add(byBlockWell, `${b}|${w}`, api);
    }
  }
  return { byApi, byLeaseWell, byBlockWell, byLease, byBlock, areas };
}

let boreIndex = null;
let boreIndexFrom = null;

async function loadBoreholes() {
  const list = await boreholeList.get();
  if (list !== boreIndexFrom) {
    boreIndex = buildBoreIndex(list);
    boreIndexFrom = list;
  }
  return boreIndex;
}

// ------------------------------------------------------------------ lease-qualified names

// A lease then the well: 'OCS-G 11081 A-11', 'OCS P-0999 #1', 'OCS 0299 #19', 'G-11081 A-2'.
// The letter is the lease prefix (G Gulf, P Pacific, Y Alaska, A Atlantic, S and D special).
const LEASE_RE = /^\s*(OCS)?[\s-]*([GPYASD])?[\s-]*(\d{3,6})\b[\s,;:/-]*(.*)$/i;
// An area and block then the well: 'GC 645 A-11', 'EI 128A #5', 'BA A-19 #1', 'MC Block 807 A-1'.
const BLOCK_RE = /^\s*([A-Z0-9]{2})[\s-]*(?:BLOCK|BLK)?[\s-]*([A-Z]?)[\s-]*(\d{1,4})([A-Z]?)\b[\s,;:/-]*(.*)$/i;
// A trailing bore designator on the well part: 'A-11 ST1', 'A011 ST01BP00', 'A-11 BP1'.
const BORE_TAIL = /^(.*?\d[A-Z]?)[\s,_(/-]*(?:(?:ST|S\/T|SDTK|SIDE ?TRACK)[\s.#-]*(\d{1,2}))?(?:[\s,_/-]*BP[\s.#-]*(\d{1,2}))?\)?\s*$/i;

// A well part that is only a bore designator: 'SS001 ST1' is well SS001, not block SS 1 well 'ST1'.
const ONLY_BORE = /^(?:ST|S\/T|SDTK|SIDE ?TRACK|RD|BP)[\s.#-]*\d{0,2}(?:[\s,_/-]*BP[\s.#-]*\d{1,2})?$/i;

function wellPart(rest) {
  const t = String(rest ?? "").trim();
  if (!t || ONLY_BORE.test(t)) return { well: null, st: null, bp: null };
  const m = BORE_TAIL.exec(t);
  if (!m) return { well: wellKey(t), st: null, bp: null };
  return { well: wellKey(m[1]), st: m[2] != null ? Number(m[2]) : null, bp: m[3] != null ? Number(m[3]) : null };
}

/**
 * A name qualified by its lease or area/block, or null. With `index` (the borehole maps),
 * a bare lease letter ('G-11081 A-2', 4+ digits) counts only for a lease in the file, and
 * an area code only when it is one in the file. Without it, only the 'OCS ...' lease form
 * is recognised. Returns { kind: 'lease'|'block', key, well, st, bp } (well is null when
 * the name has no well part, or one this cannot read).
 */
export function parseOcsName(text, index = null) {
  const s = String(text ?? "").trim();
  let m = LEASE_RE.exec(s);
  if (m && (m[1] || (m[2] && index && m[3].length >= 4))) {
    const digits = m[3].replace(/^0+(?=\d)/, "");
    let key = `${(m[2] ?? "").toUpperCase()}|${digits}`;
    // An old Gulf lease has no letter, but people write 'OCS-G 0299' for it too.
    if (index && !index.byLease.has(key) && index.byLease.has(`|${digits}`)) key = `|${digits}`;
    if (m[1] || index.byLease.has(key)) return { kind: "lease", key, ...wellPart(m[4]) };
  }
  m = BLOCK_RE.exec(s);
  if (m && index?.areas.has(m[1].toUpperCase())) {
    const key = blockKey(m[1], `${m[2]}${m[3]}${m[4]}`);
    if (key) return { kind: "block", key, ...wellPart(m[5]) };
  }
  return null;
}

/**
 * The bores a lease- or block-qualified name points at, from the borehole maps.
 *   exact  same lease/block and the same well ('A-11' = 'A011'), narrowed to the sidetrack /
 *          bypass the name gives when such bores exist
 *   loose  same lease/block and the same well number with any letters ('A-11' finds 'B011')
 * Only bores of `region` (the source's BOEM region code) count.
 */
export function ocsCandidates(index, parsed, region) {
  const inRegion = (api) => !region || index.byApi.get(api)?.[B.region] === region;
  const wellMap = parsed.kind === "lease" ? index.byLeaseWell : index.byBlockWell;
  const allMap = parsed.kind === "lease" ? index.byLease : index.byBlock;
  let exact = (parsed.well ? wellMap.get(`${parsed.key}|${parsed.well}`) ?? [] : []).filter(inRegion);
  if (parsed.st != null || parsed.bp != null) {
    const bore = exact.filter((api) => {
      const p = suffixParts(index.byApi.get(api)[B.suffix]);
      return p && (parsed.st == null || p.st === parsed.st) && (parsed.bp == null || p.bp === parsed.bp);
    });
    if (bore.length) exact = bore;
  }
  const digits = wellDigits(parsed.well);
  const loose = digits ? (allMap.get(parsed.key) ?? []).filter((api) => inRegion(api) && wellDigits(wellKey(index.byApi.get(api)[B.name])) === digits) : [];
  return { exact, loose };
}

const newestFirst = (apis) => [...apis].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

/**
 * nameWhere for an OCS layer (see arcgis.js): SQL for one name tier, null when the tier
 * does not apply, undefined to leave the name to the usual tiers.
 *   tier 0   the matching bores' APIs ("1=0" when there are none, so tier 1 still runs)
 *   tier 1   the same lease/block with the well number written any way; null when that
 *            finds nothing new
 *   tier 2+  null: a lease-qualified name never falls back to a Gulf-wide number search
 * A name with a lease or block but no readable well part is left to the usual tiers.
 */
export function ocsNameWhere(index, region, text, tier, field = "API_NUMBER") {
  const parsed = parseOcsName(text, index);
  if (!parsed?.well) return undefined;
  const { exact, loose } = ocsCandidates(index, parsed, region);
  if (tier === 0) return boundedIn(field, newestFirst(exact)).sql;
  if (tier === 1) {
    const extra = loose.filter((api) => !exact.includes(api));
    return extra.length ? boundedIn(field, newestFirst(extra)).sql : null;
  }
  return null;
}

// ------------------------------------------------------------------ waiting for the files

// How long a query waits for a file it would like but can do without.
const FILE_WAIT_MS = 10_000;

// After a wait runs out, later queries go ahead at once for this long (the download carries
// on in the background), so one query's tiers do not each wait again past the tool deadline.
const GIVE_UP_MS = 60_000;
let waitAgainAt = 0;

/** Wait up to `ms` for a promise to settle, unless a recent wait already ran out. */
async function within(promise, ms) {
  if (Date.now() < waitAgainAt) return;
  let timer;
  let timedOut = false;
  const wait = new Promise((resolve) => {
    timer = setTimeout(() => resolve((timedOut = true)), ms);
    timer.unref?.();
  });
  await Promise.race([promise.catch(() => null), wait]);
  clearTimeout(timer);
  if (timedOut) waitAgainAt = Date.now() + GIVE_UP_MS;
}

/**
 * Before each query: with both files at hand, go ahead (an old copy refreshes in the
 * background). Without, give them a few seconds, then go ahead without them. A failed
 * download is retried later.
 */
async function prepareFiles() {
  const loading = Promise.all([loadCompanies().catch(() => null), loadBoreholes().catch(() => null)]);
  if (companies && boreIndex) return;
  await within(loading, FILE_WAIT_MS);
}

/** A long-running server refreshes both files before anyone waits on them. */
async function warmFiles() {
  const results = await Promise.allSettled([loadCompanies(), loadBoreholes()]);
  const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? String(r.reason));
  if (failed.length) throw new Error(`BOEM files: ${failed.join("; ")}`);
}

// ------------------------------------------------------------------ operator filter

/** OPERATOR IN (...) for every BOEM company whose name contains the search words. */
async function operatorWhere(text) {
  const t = String(text).trim();
  if (/^\d{5}$/.test(t)) return `OPERATOR = ${sqlQuote(t)}`;
  let map;
  try {
    map = await loadCompanies();
  } catch (e) {
    throw new Error(`BOEM's company list could not be loaded (${e.message}); search by the 5-digit BOEM company number instead`);
  }
  const words = t.toUpperCase().split(/\s+/);
  const numbers = [...map].filter(([, name]) => name && words.every((w) => name.toUpperCase().includes(w))).map(([n]) => n);
  const { sql, kept, total } = boundedIn("OPERATOR", numbers);
  // BOEM's firewall turns a longer list away, and dropping companies silently would hide wells.
  if (kept < total) throw new Error(`'${t}' matches ${total} BOEM companies, more than one query can hold (${kept}); give more of the company name, or its 5-digit BOEM company number`);
  return sql;
}

const companyName = (n) => (companies?.get(n) ?? null);

// ------------------------------------------------------------------ normalize

/** The borehole file's facts for one bore, its bottom hole placed from the layer's geometry. */
export function boreFacts(rec, position) {
  const parts = suffixParts(rec[B.suffix]);
  const area = rec[B.area];
  const block = rec[B.block];
  const out = {
    lease: rec[B.botLease],
    surfaceLease: rec[B.surfLease],
    areaBlock: area && block ? `${area} ${block}` : null,
    bore: rec[B.suffix],
    ...(parts ? { sidetrack: parts.st, bypass: parts.bp } : {}),
    depthMD: rec[B.md],
    depthTVD: rec[B.tvd],
    depthUnit: rec[B.md] != null || rec[B.tvd] != null ? "ft" : null,
    rkbElevationFt: rec[B.rkb],
    tdDate: rec[B.td],
  };
  const [lat, lon] = [num(position?.latitude), num(position?.longitude)];
  if ((rec[B.dLat] != null || rec[B.dLon] != null) && lat != null && lon != null) {
    out.bottomHoleLatitude = Math.round((lat + (rec[B.dLat] ?? 0)) * 1e7) / 1e7;
    out.bottomHoleLongitude = Math.round((lon + (rec[B.dLon] ?? 0)) * 1e7) / 1e7;
  }
  return out;
}

// BOEM region code of each layer's bores in the borehole file.
const REGION_CODE = { "OCS-GOM": "G", "OCS-PAC": "P", "OCS-AK": "Y", "OCS-ATL": "A" };

function ocsSource({ key, region, label, url, extent, apiStates, apiPattern, probe }) {
  const regionCode = REGION_CODE[key];
  return {
    key,
    country: "US",
    state: region,
    label,
    probe,
    agency: "BOEM / BSEE (federal offshore)",
    url,
    pageMax: 2000,
    timeoutMs: 90_000, // gis.boem.gov can take ~40 s on the Alaska layer
    hedgeAfterMs: 4_000, // some gis.boem.gov instances stall for ~40 s: ask again after 4 s, take the first answer
    idKind: "us-api",
    apiStates,
    apiPattern,
    extent,
    prepare: prepareFiles,
    warm: warmFiles,
    operatorWhere,
    async nameWhere(text, tier) {
      // Only a name of two or more parts can carry a lease or block ('A011' cannot).
      if (!/\S[\s-]+\S/.test(String(text))) return undefined;
      if (!boreIndex) await within(loadBoreholes(), FILE_WAIT_MS);
      return boreIndex ? ocsNameWhere(boreIndex, regionCode, text, tier) : undefined;
    },
    displayOperator: (n) => (companyName(n) ? `${companyName(n)} (${n})` : n),
    caveat:
      "Federal waters only (state waters are in the state sources). waterDepthFt is water depth, not well depth. The operator filter matches BOEM company names. " +
      "From BOEM's borehole file: wellName carries the surface lease ('OCS-G 11081 A011', ' ST1' for a sidetrack); lease and areaBlock are where the bore bottoms, surfaceLease where it starts; " +
      "bore is BOEM's suffix (ST01BP00 = sidetrack 1, no bypass); depthMD, depthTVD and rkbElevationFt are in feet. " +
      "A name written with its lease or area/block ('OCS-G 11081 A-11', 'GC 645 A-11', 'OCS P-0999 #1') finds only bores there.",
    searchFields: {
      api: "API_NUMBER",
      well_name: "WELL_NAME",
      operator: "OPERATOR",
      status: "STATUS_DESCRIPTION",
      well_type: "TYPE_CODE_DESC",
    },
    normalize: (a, g) => {
      const position = geomFirst(a, g); // X/Y attributes are NAD27 in the Gulf
      const rec = boreIndex?.byApi.get(String(a.API_NUMBER ?? "").trim());
      return {
        api: a.API_NUMBER,
        wellName: (rec && boreName(rec)) || a.WELL_NAME,
        operator: companyName(a.OPERATOR) ?? a.OPERATOR,
        operatorNumber: a.OPERATOR,
        status: a.STATUS_DESCRIPTION,
        wellType: a.TYPE_CODE_DESC,
        ...position,
        spudDate: typeof a.SPUD_DATE === "number" ? msToIso(a.SPUD_DATE) : usDateToIso(a.SPUD_DATE),
        completionDate: msToIso(a.COMPLETION),
        waterDepthFt: num(a.DEPTH),
        ...(rec ? boreFacts(rec, position) : {}),
      };
    },
  };
}

const BOEM = "https://gis.boem.gov/arcgis/rest/services/BOEM_BSEE";

export const BOEM_SOURCES = [
  ocsSource({
    key: "OCS-GOM",
    region: "OCS-GOM",
    label: "US Gulf federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/GOA_Layers/FeatureServer/1`,
    extent: [-98.0, 23.0, -81.0, 31.0],
    // Gulf OCS API numbers carry the adjacent state's prefix (17 LA, 42 TX...) or 60, with
    // an offshore pseudo-county: 17-7xx, 42-7xx, 60-8xx, 01-2xx in the layer (November 2026;
    // ten wells coded 17-0xx are reachable with source=OCS-GOM).
    apiStates: ["LA", "TX", "MS", "AL", "FL"],
    apiPattern: /^(?:60|177|427|012)/,
    probe: { operator: "Shell Offshore" },
  }),
  ocsSource({
    key: "OCS-PAC",
    region: "OCS-PAC",
    label: "US Pacific federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/POC_Layers/FeatureServer/1`,
    extent: [-126.0, 31.5, -116.5, 49.0],
    apiStates: ["CA", "OR", "WA"],
    apiPattern: /^(?:56|04[2-9]|36[2-9]|46[2-9])/, // 56-xxx, or 04-311/312/313: county 200 and up is offshore
    probe: { well_type: "Development" },
  }),
  ocsSource({
    key: "OCS-AK",
    region: "OCS-AK",
    label: "US Alaska federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/AK_Layers/FeatureServer/1`,
    extent: [[-180.0, 50.0, -129.0, 73.5], [165.0, 50.0, 180.0, 66.0]],
    apiStates: ["AK"],
    probe: { well_type: "Exploratory" },
  }),
  ocsSource({
    key: "OCS-ATL",
    region: "OCS-ATL",
    label: "US Atlantic federal offshore wells (Outer Continental Shelf)",
    url: `${BOEM}/ATL_Layers/FeatureServer/1`,
    extent: [-82.0, 24.0, -65.0, 45.0],
    probe: { well_type: "Exploratory" },
  }),
];
