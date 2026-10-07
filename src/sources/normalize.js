// Field-normalization helpers shared by every source definition.
//
// Date contract: every normalized *Date field is an ISO 'YYYY-MM-DD' string or null -
// never a raw source string. ArcGIS date fields arrive as epoch milliseconds (msToIso);
// other layers carry US 'MM/DD/YYYY' (usDateToIso), European 'DD.MM.YYYY' (dmyToIso),
// ISO-ish strings (isoDate) or month names ('16-NOV-2017', 'April 25, 2001': namedDateToIso).
// Anything a parser cannot read becomes null.

const pad = (n) => String(n).padStart(2, "0");

function ymd(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!(yy > 1800 && yy < 2200 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  return `${yy}-${pad(mm)}-${pad(dd)}`;
}

export function msToIso(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return isoDate(v);
  try {
    return new Date(n).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** ISO-ish date or datetime string, 'YYYY/MM/DD', 'YYYYMMDD', or epoch ms -> 'YYYY-MM-DD'; else null. */
export function isoDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return msToIso(v);
  const m = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v));
  if (m) return ymd(m[1], m[2], m[3]);
  const compact = /^\s*(\d{4})(\d{2})(\d{2})\s*$/.exec(String(v));
  if (compact) return ymd(compact[1], compact[2], compact[3]);
  return null;
}

/** 'MM/DD/YYYY' (optionally followed by a time) -> 'YYYY-MM-DD'; falls back to isoDate. */
export function usDateToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return msToIso(v);
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v));
  return m ? ymd(m[3], m[1], m[2]) : isoDate(v);
}

/** 'DD/MM/YYYY', 'DD.MM.YYYY' or 'DD-MM-YYYY' (day first) -> 'YYYY-MM-DD'; falls back to isoDate. */
export function dmyToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return msToIso(v);
  const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(String(v));
  return m ? ymd(m[3], m[2], m[1]) : isoDate(v);
}

// English and Spanish month abbreviations (first three letters).
const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  ENE: 1, ABR: 4, AGO: 8, DIC: 12,
};
const monthOf = (name) => MONTHS[String(name).slice(0, 3).toUpperCase()] ?? null;

/** Two-digit years pivot on the current year: '67' -> 1967, '19' -> 2019. */
function fullYear(y) {
  if (String(y).length === 4) return Number(y);
  const n = Number(y);
  return n <= new Date().getUTCFullYear() % 100 ? 2000 + n : 1900 + n;
}

/**
 * Dates with month names: '16-NOV-2017', '04-DIC-2017', '7-Jun-67', 'April 25, 2001',
 * 'Wednesday, April 25, 2001', '17 December 1972'. Falls back to isoDate.
 */
export function namedDateToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return msToIso(v);
  const s = String(v);
  let m = /(\d{1,2})[-\s.]([A-Za-z]{3,})[-\s.,]+(\d{2,4})/.exec(s); // day-month-year
  if (m && monthOf(m[2])) return ymd(fullYear(m[3]), monthOf(m[2]), m[1]);
  m = /([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s); // month day, year
  if (m && monthOf(m[1])) return ymd(m[3], monthOf(m[1]), m[2]);
  return isoDate(v);
}

/** Integer date YYYYMMDD (e.g. 20250106) -> 'YYYY-MM-DD'; 0 / null -> null. */
export function ymdToIso(v) {
  if (v == null || v === "" || Number(v) === 0) return null;
  return isoDate(String(v));
}

/** Numeric value or null; treats '', 0-as-missing (when zeroIsNull) and non-numbers as null.
 *  Strings may carry thousands separators ('1,327'). */
export function num(v, { zeroIsNull = false } = {}) {
  if (v == null || v === "") return null;
  const n = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
  if (!Number.isFinite(n)) return null;
  if (zeroIsNull && n === 0) return null;
  return n;
}

/** Prefer a lat/lon attribute; fall back to the returned point geometry. 0 counts as missing. */
export function coord(attrs, key, geometry, axis) {
  const v = num(attrs[key], { zeroIsNull: true });
  if (v != null) return v;
  return geometry ? geometry[axis] ?? null : null;
}

/** Number written with a decimal comma ('2209,5') or a unit suffix ('967.70 mkb'); else null. */
export function looseNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(v));
  return m ? Number(m[0].replace(",", ".")) : null;
}

/** Point for any ArcGIS geometry: the point itself, or the vertex average of a polygon's first ring. */
export function centroid(geometry) {
  if (!geometry) return null;
  if (geometry.x != null) return { x: geometry.x, y: geometry.y };
  const ring = geometry.rings?.[0] ?? geometry.paths?.[0];
  if (!ring?.length) return null;
  return { x: ring.reduce((s, p) => s + p[0], 0) / ring.length, y: ring.reduce((s, p) => s + p[1], 0) / ring.length };
}

/** First non-empty value among the given attribute keys. */
export function first(attrs, ...keys) {
  for (const k of keys) {
    const v = attrs[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function trimAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

/** Normalize one record via its source's field map (trims padded strings first, coerces lat/lon). */
export function normalizeRecord(source, attrs, geometry) {
  const n = source.normalize(trimAttrs(attrs ?? {}), geometry ?? null);
  for (const [k, v] of Object.entries(n)) if (v === "") n[k] = null;
  n.latitude = num(n.latitude);
  n.longitude = num(n.longitude);
  return n;
}

/**
 * { latitude, longitude } preferring the server-reprojected geometry (WGS84) over
 * attribute coordinates, which are often NAD27/ED50 or sign-flipped (west positive).
 */
export function geomFirst(attrs, geometry, latKey, lonKey) {
  const c = centroid(geometry);
  return {
    latitude: c?.y ?? (latKey ? num(attrs[latKey], { zeroIsNull: true }) : null),
    longitude: c?.x ?? (lonKey ? num(attrs[lonKey], { zeroIsNull: true }) : null),
  };
}

/** Join non-empty parts with a space ('LEASE' + '1' -> 'LEASE 1'). */
export function joinName(...parts) {
  return parts.filter((p) => p != null && String(p).trim() !== "").join(" ").trim() || null;
}
