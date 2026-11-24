// In-memory provider for small layers that are cheapest to fetch whole (a few hundred
// to a few tens of thousands of records): an API with no attribute filter (swisstopo's
// geo.admin.ch), a static GeoJSON or CSV file. The source's load() returns every record
// once as [{ attrs, geometry: { x: lon, y: lat } | null }]; searches, id lookups, radius
// searches and operator lists then run locally with the same semantics as the server-side
// providers: case-insensitive contains where whitespace runs match anything, ANDed.
// Records are refetched after source.ttlMs (default 12 h); a failed refresh keeps
// serving the previous copy (and waits 10 minutes before trying again). Each copy is also
// written to disk (src/disk-cache.js), so a new process (a one-off script, a restarted
// client) starts from the last download instead of repeating it, and still has data when
// the server is down. The directory is WELL_DATA_CACHE_DIR (default: well-data-mcp-cache
// in the OS temp folder); "off" keeps copies in memory only.

import { haversineKm } from "../geo.js";
import { looseNameText, nameScore } from "../name-match.js";
import { cachedValue } from "../disk-cache.js";
import { sameIdTokens, idTokenRun, idAlsoValue, partialWorthy } from "../ids.js";
import { parseUwi, sameDlsLocation } from "../uwi.js";
import { labelHolds } from "./arcgis.js"; // circular, but used only at call time

const DEFAULT_TTL_MS = 12 * 3600_000;
const cache = new Map(); // source key -> cachedValue of its rows

/** Drop the in-memory copies (tests: stands in for a new process). */
export function forgetSnapshots() {
  cache.clear();
}

/** Lower case without accents, so 'Genève' matches 'geneve' and 'MÜNCHEN' matches 'münchen'. */
export function fold(v) {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The likeClause test: every word of the search text, in order, anywhere in the value. */
export function containsWords(value, text) {
  const words = fold(text).trim().split(/\s+/).filter(Boolean);
  const hay = fold(value);
  let at = 0;
  for (const w of words) {
    const i = hay.indexOf(w, at);
    if (i < 0) return false;
    at = i + w.length;
  }
  return true;
}

const sameId = (value, id) => fold(value).trim() === fold(id).trim();

/** Every word of the search text somewhere in the value, in any order ('Sasquatch CC 12' finds 'CC 12-34-56 Sasquatch'). */
export function containsAllWords(value, text) {
  const hay = fold(value);
  return fold(text).trim().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Does a stored US API number match the one asked for, whatever the punctuation? Compared on
 * the 10-digit well number (state, county, sequence), or on county + sequence when the
 * caller gave only those 8 digits.
 */
function sameApi(value, id) {
  const [have, want] = [String(value ?? ""), String(id)].map((v) => v.replace(/\D/g, ""));
  if (have.length < 10) return false;
  return want.length >= 10 ? have.slice(0, 10) === want.slice(0, 10) : want.length === 8 && have.slice(2, 10) === want;
}

async function rowsOf(source) {
  if (!cache.has(source.key)) cache.set(source.key, cachedValue(source.key, () => source.load(), { ttlMs: source.ttlMs ?? DEFAULT_TTL_MS }));
  const rows = await cache.get(source.key).get();
  if (!Array.isArray(rows)) throw new Error(`${source.key}: the snapshot loader returned no list of records`);
  return rows;
}

function matcher(source, filters, near) {
  const tests = [];
  const unsupported = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) unsupported.push(k);
    else if (k === "api") tests.push((a) => sameId(a[field], v));
    else if (k === "well_name") {
      // Well names: as typed, or loosely (punctuation, zero padding, sidetrack suffix, word order), in either name field.
      const loose = looseNameText(v);
      const named = (x) => containsWords(x, v) || containsAllWords(x, loose);
      tests.push((a) => named(a[field]) || (source.wellNameAlso != null && named(a[source.wellNameAlso])));
    } else if ((k === "status" || k === "well_type") && source.codes?.[k]) {
      // A coded field: the code typed, or a label that holds the text - never a code that merely contains it.
      const table = source.codes[k];
      const t = String(v).trim();
      tests.push((a) => sameId(a[field], t) || labelHolds(table[String(a[field] ?? "").trim()] ?? "", t));
    } else if (source.codeFields?.includes(k)) tests.push((a) => sameId(a[field], v));
    else tests.push((a) => containsWords(a[field], v));
  }
  if (near) {
    tests.push((_a, g) => g && haversineKm(near.latitude, near.longitude, g.y, g.x) <= near.radiusKm);
  }
  return { test: (r) => tests.every((t) => t(r.attrs, r.geometry)), unsupported };
}

export const snapshotProvider = {
  canRaw: () => false,
  warm: (source) => rowsOf(source), // refetch an expired layer before anyone waits on it
  nearSorted: true, // a radius search returns the nearest first, so its first rows are the nearest

  async search(source, filters, { limit, offset = 0, near = null }) {
    const { test, unsupported } = matcher(source, filters, near);
    const hits = (await rowsOf(source)).filter(test);
    // Everything is in memory, so a name search can hand back its best matches rather than the first ones.
    const nameField = filters.well_name ? source.searchFields.well_name : null;
    if (nameField) {
      const scoreOf = (r) => Math.max(nameScore(filters.well_name, { name: r.attrs[nameField] }), source.wellNameAlso ? nameScore(filters.well_name, { name: r.attrs[source.wellNameAlso] }) : 0);
      const score = new Map(hits.map((r) => [r, scoreOf(r)]));
      hits.sort((x, y) => score.get(y) - score.get(x));
    } else if (near) {
      const km = new Map(hits.map((r) => [r, haversineKm(near.latitude, near.longitude, r.geometry.y, r.geometry.x)]));
      hits.sort((x, y) => km.get(x) - km.get(y));
    }
    return { rows: hits.slice(offset, offset + limit), moreAvailable: hits.length > offset + limit, unsupported };
  },

  async count(source, filters, { near = null } = {}) {
    const { test, unsupported } = matcher(source, filters, near);
    return { count: (await rowsOf(source)).filter(test).length, unsupported };
  },

  async findById(source, id) {
    const field = source.searchFields.api;
    const rows = await rowsOf(source);
    // A Canadian UWI in any spelling, against a layer that keeps only the location (Manitoba).
    const uwi = source.uwi?.style === "mb" ? parseUwi(id) : null;
    if (uwi) {
      const at = rows.filter((r) => sameDlsLocation(r.attrs[source.uwi.field ?? field], uwi));
      if (at.length) return at.slice(0, 10);
    }
    const also = idAlsoValue(source, id);
    const exact = rows.filter((r) => sameId(r.attrs[field], id) || (also != null && sameId(r.attrs[source.idAlso.field], also)));
    if (exact.length) return exact.slice(0, 5);
    if (source.idKind === "us-api") return rows.filter((r) => sameApi(r.attrs[field], id)).slice(0, 5);
    // The same id written another way, else the id as whole tokens inside a longer one (flagged partial).
    const same = rows.filter((r) => sameIdTokens(r.attrs[field], id));
    if (same.length) return same.slice(0, 5);
    if (!partialWorthy(id)) return [];
    return rows
      .filter((r) => idTokenRun(r.attrs[field], id))
      .slice(0, 5)
      .map((r) => ({ ...r, partial: true }));
  },

  async distinct(source, fieldKey, text) {
    const field = source.searchFields[fieldKey];
    const values = (await rowsOf(source)).map((r) => r.attrs[field]).filter((v) => containsWords(v, text));
    return [...new Set(values)];
  },
};
