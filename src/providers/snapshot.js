// In-memory provider for small layers that are cheapest to fetch whole (a few hundred
// to a few tens of thousands of records): an API with no attribute filter (swisstopo's
// geo.admin.ch), a static GeoJSON or CSV file. The source's load() returns every record
// once as [{ attrs, geometry: { x: lon, y: lat } | null }]; searches, id lookups, radius
// searches and operator lists then run locally with the same semantics as the server-side
// providers: case-insensitive contains where whitespace runs match anything, ANDed.
// Records are refetched after source.ttlMs (default 12 h); a failed refresh keeps
// serving the previous copy.

import { haversineKm } from "../geo.js";

const DEFAULT_TTL_MS = 12 * 3600_000;
const cache = new Map(); // source key -> { at, rows, loading }

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

async function rowsOf(source) {
  const entry = cache.get(source.key);
  const fresh = entry?.rows && Date.now() - entry.at < (source.ttlMs ?? DEFAULT_TTL_MS);
  if (fresh) return entry.rows;
  if (entry?.loading) return entry.loading;
  const loading = source
    .load()
    .then((rows) => {
      cache.set(source.key, { at: Date.now(), rows });
      return rows;
    })
    .catch((e) => {
      if (entry?.rows) {
        cache.set(source.key, { ...entry, loading: null });
        return entry.rows; // stale beats nothing
      }
      cache.delete(source.key);
      throw e;
    });
  cache.set(source.key, { ...entry, loading });
  return loading;
}

function matcher(source, filters, near) {
  const tests = [];
  const unsupported = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) unsupported.push(k);
    else tests.push(k === "api" ? (a) => sameId(a[field], v) : (a) => containsWords(a[field], v));
  }
  if (near) {
    tests.push((_a, g) => g && haversineKm(near.latitude, near.longitude, g.y, g.x) <= near.radiusKm);
  }
  return { test: (r) => tests.every((t) => t(r.attrs, r.geometry)), unsupported };
}

export const snapshotProvider = {
  canRaw: () => false,

  async search(source, filters, { limit, offset = 0, near = null }) {
    const { test, unsupported } = matcher(source, filters, near);
    const hits = (await rowsOf(source)).filter(test);
    return { rows: hits.slice(offset, offset + limit), moreAvailable: hits.length > offset + limit, unsupported };
  },

  async count(source, filters, { near = null } = {}) {
    const { test, unsupported } = matcher(source, filters, near);
    return { count: (await rowsOf(source)).filter(test).length, unsupported };
  },

  async findById(source, id) {
    const field = source.searchFields.api;
    const rows = await rowsOf(source);
    const exact = rows.filter((r) => sameId(r.attrs[field], id));
    return (exact.length ? exact : rows.filter((r) => containsWords(r.attrs[field], id))).slice(0, 5);
  },

  async distinct(source, fieldKey, text) {
    const field = source.searchFields[fieldKey];
    const values = (await rowsOf(source)).map((r) => r.attrs[field]).filter((v) => containsWords(v, text));
    return [...new Set(values)];
  },
};
