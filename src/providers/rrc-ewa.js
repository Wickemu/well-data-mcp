// Texas Railroad Commission "EWA" wellbore query - the public RRC web query whose
// CSV export carries operator, lease, field and county for every Texas wellbore
// (the RRC GIS layer has only API + location). Keyless GET requests, no session.
//   1. operator name -> P-5 operator numbers   (operatorQueryAction, XML)
//   2. wellbore query by operator / API / county / well type   (wellboreQueryAction, CSV)
//   3. coordinates joined from the RRC GIS well layer on the 8-digit API
// Lease and field names have no server-side filter; they are matched here on the CSV.

import { fetchText } from "../http.js";
import { parseCsv, csvObjects } from "../csv.js";
import { queryLayer, sqlQuote } from "./arcgis.js";
import { TX_COUNTY_CODES, TX_WELL_TYPE_CODES } from "../sources/tx-rrc-codes.js";
import { apiCountySequence } from "../api-number.js";

const EWA = "https://webapps2.rrc.texas.gov/EWA";
const TX_GIS_WELLS = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/1";
const MAX_OPERATORS = 60; // operator numbers per wellbore query (a broad name can match hundreds)

const decodeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export async function rrcOperators(name) {
  const xml = await fetchText(`${EWA}/operatorQueryAction.do`, {
    params: {
      ajaxRef: "OperatorQueryFunctions/SearchByName",
      methodToCall: "searchByName",
      name: String(name).trim(),
      wildcard: "contains",
      searchType: "",
    },
  });
  return [...xml.matchAll(/OprtrNmbr_OgOprtr="(\d+)"\s+OrgnztnNm_EwOrgnztn="([^"]*)"/g)].map((m) => ({
    number: m[1],
    name: decodeXml(m[2]).trim(),
  }));
}

/** Resolve text to one code from a {LABEL: code} table: exact label, else a unique contains-match. */
function pickCode(table, text, what) {
  const t = String(text).trim().toUpperCase();
  if (table[t]) return { code: table[t], label: t };
  const hits = Object.entries(table).filter(([label]) => label.includes(t));
  if (hits.length === 1) return { code: hits[0][1], label: hits[0][0] };
  const options = (hits.length ? hits : Object.entries(table)).map(([l]) => l);
  throw new Error(`${hits.length ? "Ambiguous" : "Unknown"} Texas RRC ${what} '${text}'. ${hits.length ? "Matches" : "Valid values"}: ${options.slice(0, 40).join(", ")}${options.length > 40 ? ", ..." : ""}`);
}

/** RRC's API prefix (3-digit county) + suffix (5-digit sequence) from any API shape. */
function apiParts(api) {
  const cs = apiCountySequence(api);
  return cs?.county.length === 3 ? { prefix: cs.county, suffix: cs.sequence } : null;
}

async function wellboreQuery(args) {
  const params = {
    methodToCall: "generateWellboreCriteriaReportCsv",
    "searchArgs.scheduleTypeArgHndlr.inputValue": "Both",
  };
  for (const [k, v] of Object.entries(args)) params[`searchArgs.${k}ArgHndlr.inputValue`] = v;
  const text = await fetchText(`${EWA}/wellboreQueryAction.do`, { params, timeoutMs: 120_000 });
  const rows = parseCsv(text);
  const header = rows.findIndex((r) => r[0] === "API No.");
  return header < 0 ? [] : csvObjects(rows, header);
}

/** { '31730829': {x, y} } from the RRC GIS well layer. */
async function coordinatesFor(apis) {
  const unique = [...new Set(apis.filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { features } = await queryLayer(TX_GIS_WELLS, {
      where: `API IN (${chunk.map(sqlQuote).join(",")})`,
      outFields: "API,GIS_LAT83,GIS_LONG83",
      limit: 1000,
    });
    for (const f of features) {
      const a = f.attributes;
      const x = a.GIS_LONG83 || f.geometry?.x;
      const y = a.GIS_LAT83 || f.geometry?.y;
      if (a.API && x && y && !out[a.API]) out[a.API] = { x, y };
    }
  }
  return out;
}

// The GIS layer keys wells by the 8-digit county+sequence API, zero-padded.
const api8 = (r) => String(r["API No."] ?? "").padStart(8, "0");

async function withCoordinates(rows) {
  const coords = await coordinatesFor(rows.map(api8));
  return rows.map((r) => ({ attrs: r, geometry: coords[api8(r)] ?? null }));
}

/** Server-side query args + client-side filters for a set of normalized filters. */
async function plan(filters) {
  const args = {};
  const local = [];
  const unsupported = [];
  let statusLabel = null;
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    if (k === "operator") {
      const ops = await rrcOperators(v);
      if (!ops.length) return { empty: true };
      args.operatorNumbers = ops.slice(0, MAX_OPERATORS).map((o) => o.number).join(",");
    } else if (k === "api") {
      const parts = apiParts(v);
      if (!parts) return { empty: true };
      args.apiNoPrefix = parts.prefix;
      args.apiNoSuffix = parts.suffix;
    } else if (k === "county") {
      args.countyCode = pickCode(TX_COUNTY_CODES, v, "county").code;
    } else if (k === "status" || k === "well_type") {
      if (args.wellType) {
        unsupported.push(k); // RRC takes one well-type code per query
        continue;
      }
      const { code, label } = pickCode(TX_WELL_TYPE_CODES, v, "well type/status");
      args.wellType = code;
      statusLabel = label;
    } else if (k === "well_name") {
      local.push((r) => `${r["Lease Name"]} ${r["Well No."]}`.toUpperCase().includes(String(v).trim().toUpperCase()));
    } else if (k === "field") {
      local.push((r) => String(r["Field Name"]).toUpperCase().includes(String(v).trim().toUpperCase()));
    } else unsupported.push(k);
  }
  return { args, local, unsupported, statusLabel };
}

async function run(filters) {
  const p = await plan(filters);
  if (p.empty) return { rows: [], unsupported: [] };
  let rows = await wellboreQuery(p.args);
  for (const keep of p.local) rows = rows.filter(keep);
  if (p.statusLabel) rows = rows.map((r) => ({ ...r, _rrcWellType: p.statusLabel }));
  return { rows, unsupported: p.unsupported };
}

export const rrcEwaProvider = {
  async search(_source, filters, { limit, offset = 0 }) {
    const { rows, unsupported } = await run(filters);
    const page = rows.slice(offset, offset + limit);
    return { rows: await withCoordinates(page), moreAvailable: rows.length > offset + limit, unsupported };
  },

  async count(_source, filters) {
    const { rows, unsupported } = await run(filters);
    return { count: rows.length, unsupported };
  },

  async findById(_source, id) {
    const parts = apiParts(id);
    if (!parts) return [];
    const rows = await wellboreQuery({ apiNoPrefix: parts.prefix, apiNoSuffix: parts.suffix });
    return withCoordinates(rows.slice(0, 20));
  },

  async distinct(_source, _fieldKey, text) {
    return (await rrcOperators(text)).map((o) => `${o.name} (P-5 ${o.number})`);
  },
};
