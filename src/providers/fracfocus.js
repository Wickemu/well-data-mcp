// FracFocus hydraulic-fracturing disclosure registry (Ground Water Protection Council and
// Interstate Oil & Gas Compact Commission), through the JSON API its own well finder uses
// (fracfocus.org/api/api). One row per disclosure: a well fractured twice has two.
// Server-side filters: api (9/10/14 digits), well_name (contains), operator (FracFocus's
// exact operator strings - matched here against its published operator list), and a
// bounding box. A full disclosure with its chemical list needs the 14-digit API number.

import { fetchJson } from "../http.js";
import { containsWords } from "./snapshot.js";
import { radiusToBbox } from "../geo.js";
import { cachedValue } from "../disk-cache.js";

const API = "https://fracfocus.org/api/api";
const OPERATOR_TTL_MS = 12 * 3600_000;
const MAX_OPERATOR_NAMES = 20; // an operator filter matching more names asks about the first 20

let operators = null; // FracFocus's operator names, kept in memory and on disk (src/disk-cache.js)

// Asked for application/json, the API answers with the JSON encoded a second time as a string.
async function ffJson(path, params, source) {
  const data = await fetchJson(`${API}/${path}`, { params, timeoutMs: source.timeoutMs });
  return typeof data === "string" ? JSON.parse(data) : data;
}

function operatorNames(source) {
  operators ??= cachedValue(
    "fracfocus-operators",
    async () => (await ffJson("operator/operators", undefined, source)).map((o) => o.OperatorName).filter(Boolean),
    { ttlMs: OPERATOR_TTL_MS }
  );
  return operators.get();
}

/** The digits FracFocus accepts: 14 or 10 (an API-12 drops its sidetrack digits); else null. */
export function fracFocusApi(id) {
  let d = String(id).replace(/\D/g, "");
  if (d.length === 12) d = d.slice(0, 10);
  return [9, 10, 14].includes(d.length) ? d : null;
}

// Drop the empty trade-secret claimant fields and nulls that pad every ingredient row.
function compactIngredient(i) {
  return Object.fromEntries(Object.entries(i).filter(([k, v]) => v != null && v !== "" && !/^pKey|String$/.test(k)));
}

function toRow(w) {
  const attrs = { ...w };
  if (Array.isArray(w.Ingredients)) attrs.Ingredients = w.Ingredients.map(compactIngredient);
  if (Array.isArray(w.Purposes) && !w.Purposes.length) delete attrs.Purposes;
  const x = Number(w.Longitude);
  const y = Number(w.Latitude);
  return { attrs, geometry: Number.isFinite(x) && Number.isFinite(y) && (x || y) ? { x, y } : null };
}

/** Server params for the filters it understands, plus the operator names to ask about. */
async function plan(source, filters) {
  const params = {};
  const unsupported = [];
  let names = [null];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    if (k === "api") {
      const d = fracFocusApi(v);
      params.api_number = d ?? "0"; // not an API number: match nothing
    } else if (k === "well_name") params.well_name = String(v).trim();
    else if (k === "operator") names = (await operatorNames(source)).filter((n) => containsWords(n, v)).slice(0, MAX_OPERATOR_NAMES);
    else unsupported.push(k);
  }
  return { params, names, unsupported };
}

async function searchPage(source, params, pageSize) {
  return ffJson("fracfocus/search", { ...params, page: "1", pagesize: String(pageSize) }, source);
}

export const fracFocusProvider = {
  canRaw: () => false,
  warm: (source) => operatorNames(source), // keep the operator list fresh in a long-running server

  async search(source, filters, { limit, offset = 0, near = null }) {
    const want = offset + limit;
    if (near) {
      // The box endpoint takes no other filters: fetch the box, filter here.
      const [west, south, east, north] = radiusToBbox(near.latitude, near.longitude, near.radiusKm * 1000);
      const data = await ffJson("fracfocus/wellsinbounds", { north, south, east, west, page: "1", pagesize: String(source.pageMax), orderby: "WellName" }, source);
      const unsupported = Object.keys(filters).filter((k) => !source.searchFields[k]);
      const test = (w) =>
        Object.entries(filters).every(([k, v]) => {
          const field = source.searchFields[k];
          if (!field || v == null || v === "") return true;
          return k === "api" ? String(w[field]).startsWith(fracFocusApi(v) ?? "-") : containsWords(w[field], v);
        });
      const hits = (data.Wells ?? []).filter(test);
      return { rows: hits.slice(offset, want).map(toRow), moreAvailable: hits.length > want || (data.Count ?? 0) > (data.Wells?.length ?? 0), unsupported };
    }
    const { params, names, unsupported } = await plan(source, filters);
    const wells = [];
    let more = false;
    for (const name of names) {
      const data = await searchPage(source, name ? { ...params, operator_name: name } : params, Math.min(want, source.pageMax));
      wells.push(...(data.Wells ?? []));
      if ((data.Count ?? 0) > (data.Wells?.length ?? 0)) more = true;
      if (wells.length >= want) break;
    }
    return { rows: wells.slice(offset, want).map(toRow), moreAvailable: more || wells.length > want, unsupported };
  },

  async count(source, filters, { near = null } = {}) {
    if (near) {
      const { rows, moreAvailable } = await this.search(source, filters, { limit: source.pageMax, near });
      return { count: rows.length, ...(moreAvailable ? { approximate: true } : {}), unsupported: [] };
    }
    const { params, names, unsupported } = await plan(source, filters);
    let count = 0;
    for (const name of names) count += (await searchPage(source, name ? { ...params, operator_name: name } : params, 1)).Count ?? 0;
    return { count, unsupported };
  },

  /** Every disclosure for an API number, each with its full chemical list. */
  async findById(source, id) {
    const d = fracFocusApi(id);
    if (!d) return [];
    const list = await searchPage(source, { api_number: d }, 20);
    const api14s = [...new Set((list.Wells ?? []).map((w) => String(w.APINumber).replace(/\D/g, "")))].slice(0, 5);
    const full = await Promise.all(
      api14s.map((a) => ffJson("FracFocus/WellByApiNumber", { api14: a }, source))
    );
    return full.flatMap((f) => f.Wells ?? []).map(toRow);
  },

  async distinct(source, fieldKey, text) {
    if (fieldKey !== "operator") return [];
    return (await operatorNames(source)).filter((n) => containsWords(n, text));
  },
};
