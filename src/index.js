#!/usr/bin/env node
// well-data-mcp — MCP server for oil & gas / geothermal well data from
// state regulator ArcGIS services. Stdio transport; register with:
//   claude mcp add --scope user well-data -- node <path>/src/index.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryLayer, countLayer, likeClause, eqClause, sqlQuote, nearParams } from "./arcgis.js";
import { SOURCES, findSources, normalizeRecord, INTERNATIONAL_NOTES } from "./states.js";
import { queryBssBoreholes } from "./wfs.js";
import { searchGem, gemDatasets } from "./gem.js";

const server = new McpServer({ name: "well-data", version: "0.1.0" });

const STATE_KEYS = [...new Set(SOURCES.map((s) => s.state))];
const SOURCE_KEYS = SOURCES.map((s) => s.key);

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Build a WHERE clause from normalized filters against one source's field map. */
function buildWhere(source, filters) {
  const clauses = [];
  const unsupported = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "") continue;
    const field = source.searchFields[k];
    if (!field) {
      unsupported.push(k);
      continue;
    }
    clauses.push(k === "api" ? eqClause(field, v) : likeClause(field, v));
  }
  return { where: clauses.length ? clauses.join(" AND ") : "1=1", unsupported };
}

function normalizeFeatures(source, features) {
  return features.map((f) => ({
    source: source.key,
    state: source.state,
    ...normalizeRecord(source, f.attributes, f.geometry),
  }));
}

function radiusToBbox(latitude, longitude, radiusMeters) {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((latitude * Math.PI) / 180));
  return [latitude - dLat, longitude - dLon, latitude + dLat, longitude + dLon];
}

async function searchBssSource(source, filters, { limit, bbox = null }) {
  const box = bbox ?? source.defaultBbox;
  const features = await queryBssBoreholes({ bbox: box, count: Math.min(limit * 5, source.pageMax) });
  const nameFilter = (filters.well_name ?? "").toUpperCase();
  const unsupported = Object.entries(filters)
    .filter(([k, v]) => v != null && v !== "" && k !== "well_name")
    .map(([k]) => k);
  let wells = features.map((f) => {
    const [x, y] = f.geometry?.coordinates ?? [null, null];
    return { source: source.key, state: source.state, ...normalizeRecord(source, f.properties, { x, y }) };
  });
  if (nameFilter) {
    wells = wells.filter((w) =>
      [w.wellName, w.api, w.bssReference].some((v) => v && String(v).toUpperCase().includes(nameFilter))
    );
  }
  wells = wells.slice(0, limit);
  return {
    source: source.key,
    label: source.label,
    agency: source.agency,
    bboxSearched: box,
    returned: wells.length,
    moreAvailable: features.length >= Math.min(limit * 5, source.pageMax),
    wells,
    ...(unsupported.length
      ? { unsupportedFilters: unsupported, note: `BSS supports only well_name + location filters; ignored: ${unsupported.join(", ")}.` }
      : {}),
    caveat: source.caveat,
  };
}

/** queryLayer with per-source quirks applied (reprojection bug, 500-on-empty bug). */
async function querySourceLayer(source, opts) {
  try {
    return await queryLayer(source.url, { ...opts, noReproject: source.noReproject });
  } catch (e) {
    if (source.emptyResultBug && /error 500/i.test(String(e.message))) {
      return { features: [], exceededLimit: false, emptyOr500: true };
    }
    throw e;
  }
}

async function searchOneSource(source, filters, { limit, offset, geometryParams = null, countOnly = false, bbox = null }) {
  if (source.kind === "wfs-bss") {
    if (countOnly) {
      const r = await searchBssSource(source, filters, { limit: source.pageMax, bbox });
      return { source: source.key, label: source.label, count: r.returned, approximate: true };
    }
    return searchBssSource(source, filters, { limit, bbox });
  }
  const { where, unsupported } = buildWhere(source, filters);
  if (countOnly) {
    const count = await countLayer(source.url, { where, geometryParams });
    return { source: source.key, label: source.label, count, unsupportedFilters: unsupported };
  }
  const capped = Math.min(limit, source.pageMax);
  const { features, exceededLimit } = await querySourceLayer(source, {
    where,
    limit: capped,
    offset,
    geometryParams,
  });
  const out = {
    source: source.key,
    label: source.label,
    agency: source.agency,
    returned: features.length,
    moreAvailable: exceededLimit,
    wells: normalizeFeatures(source, features),
  };
  if (unsupported.length) {
    out.unsupportedFilters = unsupported;
    out.note = `This source cannot filter on: ${unsupported.join(", ")} (fields not present in its GIS layer).`;
  }
  if (source.caveat) out.caveat = source.caveat;
  return out;
}

/** Run a task across selected sources, tolerating per-source failures. */
async function acrossSources(sources, task) {
  const settled = await Promise.allSettled(sources.map(task));
  const results = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") results.push(r.value);
    else failures.push({ source: sources[i].key, error: String(r.reason?.message ?? r.reason) });
  });
  return { results, failures };
}

// ---------------------------------------------------------------- list_sources

server.registerTool(
  "list_sources",
  {
    title: "List well-data sources",
    description:
      "List the state regulator well-data sources this server can query: coverage, agency, searchable filters, and caveats. Call this first to see what is available.",
    inputSchema: {},
  },
  async () =>
    json({
      sources: SOURCES.map((s) => ({
        key: s.key,
        state: s.state,
        label: s.label,
        agency: s.agency,
        endpoint: s.url,
        searchableFilters: Object.keys(s.searchFields),
        maxPageSize: s.pageMax,
        ...(s.caveat ? { caveat: s.caveat } : {}),
      })),
      geothermalProjectData:
        "For geothermal project/well datasets (logs, stimulation, flow tests, microseismic - incl. Fervo Cape Station, Utah FORGE), use search_geothermal_datasets.",
      globalProjects:
        "For plant/field-level coverage worldwide (incl. Kenya, Guatemala, Guadeloupe, Namibia, NZ), use search_gem_projects (bundled Global Energy Monitor trackers).",
      gemReleases: await gemDatasets(),
      noRegistryCountries: INTERNATIONAL_NOTES,
    })
);

// ---------------------------------------------------------------- search_wells

const searchShape = {
  state: z
    .enum(STATE_KEYS)
    .optional()
    .describe("Two-letter state code to search. Omit to search ALL states (slower; prefer setting it)."),
  source: z
    .enum(SOURCE_KEYS)
    .optional()
    .describe("Exact source key (e.g. CA-GEO for California geothermal only). Overrides state."),
  operator: z.string().optional().describe("Operator/company name, partial match, case-insensitive (e.g. 'Fervo', 'California Resources')."),
  well_name: z.string().optional().describe("Well or lease name, partial match."),
  api: z.string().optional().describe("API well number exactly as the state formats it. For cross-state API lookup use get_well instead."),
  county: z.string().optional().describe("County name, partial match."),
  field: z.string().optional().describe("Field name, partial match."),
  status: z.string().optional().describe("Well status, partial match (vocabulary varies by state: 'Active', 'Plugged', 'New', ...)."),
  well_type: z.string().optional().describe("Well type, partial match (e.g. 'OG', 'Geothermal', 'Water Disposal'; vocabulary varies by state)."),
  limit: z.number().int().min(1).max(500).default(25).describe("Max records per source (default 25)."),
  offset: z.number().int().min(0).default(0).describe("Pagination offset within each source."),
  count_only: z.boolean().default(false).describe("If true, return only match counts per source — cheap way to size a query first."),
};

server.registerTool(
  "search_wells",
  {
    title: "Search wells",
    description:
      "Search state regulator well databases by operator, well/lease name, county, field, status, or type. Returns normalized records (API number, name, operator, status, type, field, county, lat/lon, dates, depths where available) plus source-specific extras. Filters combine with AND. Set count_only=true to size a query before pulling records.",
    inputSchema: searchShape,
  },
  async (args) => {
    const { state, source, limit, offset, count_only, ...filters } = args;
    const sources = findSources(source ? { key: source } : { state });
    if (!sources.length) return err(`No sources match state=${state} source=${source}`);
    if (!Object.values(filters).some((v) => v != null && v !== "") && count_only !== true) {
      return err("Provide at least one filter (operator, well_name, api, county, field, status, well_type), or set count_only=true.");
    }
    const { results, failures } = await acrossSources(sources, (s) =>
      searchOneSource(s, filters, { limit, offset, countOnly: count_only })
    );
    return json({ results, ...(failures.length ? { sourceErrors: failures } : {}) });
  }
);

// ---------------------------------------------------------------- get_well

server.registerTool(
  "get_well",
  {
    title: "Get well by API number",
    description:
      "Look up a specific well by API number and return its FULL raw record from the state source plus the normalized summary. Handles formatting differences (dashes, state prefixes): tries exact match first, then a contains-match on the digits. If state is omitted, tries every state.",
    inputSchema: {
      api: z.string().describe("API well number in any common format (e.g. 04-029-12345, 0402912345, 33-053-04652, 4300712345)."),
      state: z.enum(STATE_KEYS).optional().describe("Two-letter state code if known (much faster)."),
    },
  },
  async ({ api, state }) => {
    const digits = api.replace(/\D/g, "");
    if (digits.length < 5) return err("API number too short after removing non-digits.");
    const sources = findSources({ state });
    const task = async (s) => {
      if (s.kind === "wfs-bss") return null; // BSS ids are not API numbers; use search_wells well_name instead
      const field = s.searchFields.api;
      if (!field) throw new Error("source has no API field");
      // exact as given, exact digits, then contains on the trailing 8 digits
      const attempts = [
        eqClause(field, api),
        eqClause(field, digits),
        likeClause(field, digits.slice(-8)),
      ];
      for (const where of attempts) {
        const { features } = await querySourceLayer(s, { where, limit: 5 });
        if (features.length) {
          return {
            source: s.key,
            label: s.label,
            agency: s.agency,
            matches: features.map((f) => ({
              normalized: { source: s.key, state: s.state, ...normalizeRecord(s, f.attributes, f.geometry) },
              raw: f.attributes,
            })),
          };
        }
      }
      return null;
    };
    const { results, failures } = await acrossSources(sources, task);
    const hits = results.filter(Boolean);
    if (!hits.length) {
      return json({
        found: false,
        message: `No well matching '${api}' in ${sources.map((s) => s.key).join(", ")}.`,
        ...(failures.length ? { sourceErrors: failures } : {}),
      });
    }
    return json({ found: true, results: hits, ...(failures.length ? { sourceErrors: failures } : {}) });
  }
);

// ---------------------------------------------------------------- wells_near

server.registerTool(
  "wells_near",
  {
    title: "Find wells near a point",
    description:
      "Find wells within a radius of a lat/lon point — e.g. all wells on or around a pad, lease, or project site. Searches the geographically relevant sources unless state/source is given.",
    inputSchema: {
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radius_km: z.number().min(0.01).max(100).default(3).describe("Search radius in kilometers (default 3)."),
      state: z.enum(STATE_KEYS).optional(),
      source: z.enum(SOURCE_KEYS).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
  },
  async ({ latitude, longitude, radius_km, state, source, limit }) => {
    const sources = findSources(source ? { key: source } : { state });
    const geometryParams = nearParams(latitude, longitude, radius_km * 1000);
    const bbox = radiusToBbox(latitude, longitude, radius_km * 1000);
    const { results, failures } = await acrossSources(sources, (s) =>
      searchOneSource(s, {}, { limit, offset: 0, geometryParams, bbox })
    );
    const nonEmpty = results.filter((r) => r.returned > 0);
    return json({
      center: { latitude, longitude },
      radius_km,
      results: nonEmpty,
      ...(failures.length ? { sourceErrors: failures } : {}),
    });
  }
);

// ---------------------------------------------------------------- raw_query

server.registerTool(
  "raw_query",
  {
    title: "Raw ArcGIS query",
    description:
      "Escape hatch: run a raw SQL-92 WHERE clause against one source's ArcGIS layer and get raw attributes back. Use list_sources for source keys; field names are the layer's own (see the searchableFilters mapping, or query with where='1=1' limit=1 to inspect a record). Useful for filters the normalized search does not cover (dates, depths, cumulative production).",
    inputSchema: {
      source: z.enum(SOURCE_KEYS).describe("Source key, e.g. UT or CA-OG."),
      where: z.string().describe("ArcGIS SQL-92 where clause, e.g. \"totcum_oil > 1000000 AND county = 'BEAVER'\""),
      out_fields: z.string().default("*").describe("Comma-separated field list, or * for all."),
      limit: z.number().int().min(1).max(1000).default(50),
      offset: z.number().int().min(0).default(0),
    },
  },
  async ({ source, where, out_fields, limit, offset }) => {
    const [s] = findSources({ key: source });
    if (!s) return err(`Unknown source '${source}'.`);
    try {
      const { features, exceededLimit } = await querySourceLayer(s, {
        where,
        outFields: out_fields,
        limit: Math.min(limit, s.pageMax),
        offset,
      });
      return json({
        source: s.key,
        returned: features.length,
        moreAvailable: exceededLimit,
        records: features.map((f) => ({ ...f.attributes, _lat: f.geometry?.y ?? null, _lon: f.geometry?.x ?? null })),
      });
    } catch (e) {
      return err(`Query failed: ${e.message}. Check the where clause against this layer's field names.`);
    }
  }
);

// ---------------------------------------------------------------- operators

server.registerTool(
  "list_operators",
  {
    title: "List operators matching a name",
    description:
      "Find the exact operator name strings a state uses (they rarely match what you would guess — 'Fervo Energy Company', 'CALIFORNIA RESOURCES PRODUCTION CORPORATION'). Returns distinct operator names containing the search text, per source. Use before search_wells when an operator search returns nothing.",
    inputSchema: {
      name: z.string().min(2).describe("Partial operator name, case-insensitive."),
      state: z.enum(STATE_KEYS).optional(),
    },
  },
  async ({ name, state }) => {
    const sources = findSources({ state }).filter((s) => s.searchFields.operator);
    const task = async (s) => {
      const field = s.searchFields.operator;
      const { features } = await querySourceLayer(s, {
        where: likeClause(field, name),
        outFields: field,
        limit: Math.min(s.pageMax, 200),
        distinct: true,
      });
      const names = [...new Set(features.map((f) => f.attributes[field]).filter(Boolean))].sort();
      return { source: s.key, operators: names.slice(0, 50), truncated: names.length > 50 };
    };
    const { results, failures } = await acrossSources(sources, task);
    return json({
      results: results.filter((r) => r.operators.length),
      ...(failures.length ? { sourceErrors: failures } : {}),
    });
  }
);

// ------------------------------------------------ search_gem_projects

server.registerTool(
  "search_gem_projects",
  {
    title: "Search global energy projects (GEM)",
    description:
      "Search bundled Global Energy Monitor tracker data: geothermal power units worldwide (Geothermal Power Tracker - covers Kenya/Olkaria, New Zealand, Guadeloupe/Bouillante, Guatemala, US) and upstream oil & gas fields/discoveries (Oil & Gas Extraction Tracker - covers Namibia Orange Basin, Guatemala, NZ). Project/field level, NOT well level. Filters are ANDed, case-insensitive substrings. Local data - fast, works offline. Cite 'Global Energy Monitor' when publishing results.",
    inputSchema: {
      dataset: z.enum(["geothermal", "oilgas", "both"]).default("both"),
      country: z.string().optional().describe("Country/area name, e.g. 'Kenya', 'Namibia', 'New Zealand'."),
      name: z.string().optional().describe("Project/unit/field name (also matches other names and blocks), e.g. 'Olkaria', 'Venus', 'Bouillante'."),
      operator: z.string().optional().describe("Operator or owner name, e.g. 'KenGen', 'Ormat', 'TotalEnergies'."),
      status: z.string().optional().describe("Status substring: operating, construction, announced, discovered, producing, shelved, cancelled, retired..."),
      latitude: z.number().min(-90).max(90).optional().describe("With longitude + radius_km: only projects within the radius, sorted by distance."),
      longitude: z.number().min(-180).max(180).optional(),
      radius_km: z.number().min(0.1).max(2000).optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
  },
  async ({ dataset, country, name, operator, status, latitude, longitude, radius_km, limit }) => {
    if (!country && !name && !operator && !status && latitude == null) {
      return err("Provide at least one filter (country, name, operator, status, or latitude/longitude/radius_km).");
    }
    const near =
      latitude != null && longitude != null && radius_km != null ? { latitude, longitude, radius_km } : null;
    const results = await searchGem({ dataset, country, name, operator, status, near, limit });
    return json({ results, attribution: "Global Energy Monitor (CC BY 4.0)" });
  }
);

// ------------------------------------------- search_geothermal_datasets

const OSTI_DE = "https://www.osti.gov/dataexplorer/api/v1/records";

server.registerTool(
  "search_geothermal_datasets",
  {
    title: "Search DOE geothermal datasets (GDR)",
    description:
      "Search U.S. DOE-funded geothermal project datasets via OSTI Data Explorer - this indexes the Geothermal Data Repository (gdr.openei.org): well logs, stimulation and flow-test data, microseismic, DTS, geologic models. THE source for Fervo Cape Station (search 'cape egs' or 'fervo' - note 'cape station' also matches Cape Grim air station), Utah FORGE, and some international geothermal studies. Terms are ANDed. Returns titles, DOIs, dates, and links to the data.",
    inputSchema: {
      query: z.string().min(2).describe("Search terms, e.g. 'cape station', 'utah forge stimulation', 'olkaria kenya'."),
      rows: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ query, rows }) => {
    const qs = `q=${encodeURIComponent(query)}&rows=${rows}`; // OSTI treats '+' literally; must use %20
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(`${OSTI_DE}?${qs}`, {
        signal: ctrl.signal,
        headers: { Accept: "application/json", "User-Agent": "well-data-mcp/0.1" },
      });
      if (!res.ok) return err(`OSTI Data Explorer HTTP ${res.status}`);
      const recs = await res.json();
      if (!Array.isArray(recs)) return err("Unexpected OSTI response shape.");
      return json({
        query,
        returned: recs.length,
        datasets: recs.map((r) => ({
          title: r.title,
          doi: r.doi ?? null,
          published: (r.publication_date ?? "").slice(0, 10) || null,
          authors: (r.authors ?? []).slice(0, 4),
          researchOrgs: r.research_orgs ?? null,
          description: (r.description ?? "").slice(0, 400),
          links: (r.links ?? [])
            .filter((l) => ["fulltext", "doi"].includes(l.rel))
            .map((l) => l.href),
        })),
      });
    } catch (e) {
      return err(`OSTI query failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  }
);

// ---------------------------------------------------------------- main

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`well-data-mcp ready: ${SOURCES.length} sources (${STATE_KEYS.join(", ")})`);
