#!/usr/bin/env node
// well-data-mcp — MCP server for oil & gas / geothermal well data from public
// regulator and geological-survey services worldwide. Stdio transport; register with:
//   claude mcp add --scope user well-data -- node <path>/src/index.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SOURCES, findSources, normalizeRecord, NO_REGISTRY_NOTES } from "./sources/index.js";
import { providerFor } from "./providers/index.js";
import { apiStateOf, looksLikeUsApi } from "./api-number.js";
import { radiusToBbox, extentIntersects, withinRadius, haversineKm } from "./geo.js";
import { searchGem, gemDatasets } from "./gem.js";
import { searchGeothermalDatasets } from "./osti.js";
import { searchGdr } from "./gdr.js";
import { searchHeatFlow, heatflowDataset } from "./heatflow.js";
import { VERSION } from "./meta.js";

const server = new McpServer({ name: "well-data", version: VERSION });

const COUNTRY_KEYS = [...new Set(SOURCES.map((s) => s.country))].sort();
// Countries a caller may name: those with sources plus those with a no-registry note.
const COUNTRY_ARGS = [...new Set([...COUNTRY_KEYS, ...NO_REGISTRY_NOTES.flatMap((n) => n.countries)])].sort();
const STATE_KEYS = [...new Set(SOURCES.map((s) => s.state).filter(Boolean))].sort();
const SOURCE_KEYS = SOURCES.map((s) => s.key);
const FILTER_KEYS = ["operator", "well_name", "api", "county", "field", "status", "well_type"];

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function normalizeRows(source, rows) {
  return rows.map((r) => ({
    source: source.key,
    country: source.country,
    ...(source.state ? { state: source.state } : {}),
    ...normalizeRecord(source, r.attrs, r.geometry),
  }));
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

function withFailures(body, failures) {
  return failures.length ? { ...body, sourceErrors: failures } : body;
}

function unsupportedNote(source, unsupported) {
  if (!unsupported?.length) return {};
  return {
    unsupportedFilters: unsupported,
    note: `${source.key} cannot filter on: ${unsupported.join(", ")} (not in its data); those filters were ignored.`,
  };
}

async function searchOneSource(source, filters, { limit, offset, near = null, countOnly = false }) {
  const provider = providerFor(source);
  const asked = Object.keys(filters);
  if (source.requiresOneOf && !asked.some((k) => source.requiresOneOf.includes(k))) {
    return {
      source: source.key,
      label: source.label,
      skipped: true,
      note: `${source.key} needs one of: ${source.requiresOneOf.join(", ")} (a statewide query would be too large).`,
    };
  }
  if (asked.length && asked.every((k) => !source.searchFields[k])) {
    // None of the filters apply here; querying anyway would return the whole layer unfiltered.
    return {
      source: source.key,
      label: source.label,
      skipped: true,
      note: `${source.key} cannot filter on ${asked.join(", ")}; searchable here: ${Object.keys(source.searchFields).join(", ")}.`,
    };
  }
  if (countOnly) {
    const { count, approximate, unsupported } = await provider.count(source, filters, { near });
    return {
      source: source.key,
      label: source.label,
      count,
      ...(approximate ? { approximate: true } : {}),
      ...unsupportedNote(source, unsupported),
    };
  }
  // Radius searches over-fetch: servers return matches in arbitrary order (and bbox-only
  // providers return the box corners too), so take extra, trim to the circle, keep the nearest.
  const fetchLimit = near ? Math.min(limit * 3, source.pageMax) : limit;
  const result = await provider.search(source, filters, { limit: fetchLimit, offset, near });
  const { rows, unsupported } = result;
  let { moreAvailable } = result;
  let wells = normalizeRows(source, rows);
  if (near) {
    wells = withinRadius(wells, near).map((w) => ({
      ...w,
      distanceKm: Math.round(haversineKm(near.latitude, near.longitude, w.latitude, w.longitude) * 100) / 100,
    }));
    wells.sort((a, b) => a.distanceKm - b.distanceKm);
    if (wells.length > limit) moreAvailable = true;
    wells = wells.slice(0, limit);
  }
  return {
    source: source.key,
    label: source.label,
    agency: source.agency,
    returned: wells.length,
    moreAvailable,
    wells,
    ...unsupportedNote(source, unsupported),
    ...(source.caveat ? { caveat: source.caveat } : {}),
  };
}

const countryArg = z
  .enum(COUNTRY_ARGS)
  .optional()
  .describe(`ISO 3166-1 alpha-2 country code. With sources: ${COUNTRY_KEYS.join(", ")} (EU = pan-European). Others listed return a note on why there is no registry.`);
const stateArg = z
  .enum(STATE_KEYS)
  .optional()
  .describe(
    "State / province / region code within the country: US postal codes (CA, UT, TX...) and OCS-GOM / OCS-PAC / OCS-AK / OCS-ATL for federal offshore, Canadian provinces (BC, SK, ON...), Australian states (SA, QLD, WA), NZ regions (WKO, BOP). WA alone matches both Washington and Western Australia; add country to pick one."
  );
const sourceArg = z.enum(SOURCE_KEYS).optional().describe("Exact source key from list_sources (e.g. CA-GEO). Overrides country/state.");

function selectSources({ source, country, state }) {
  return source ? findSources({ key: source }) : findSources({ country, state });
}

/** Error body for a country/state with no sources, carrying any no-registry note. */
function noSources(country, state) {
  const notes = NO_REGISTRY_NOTES.filter((n) => country && n.countries.includes(country));
  return {
    error: `No sources match country=${country ?? "*"} state=${state ?? "*"}.`,
    ...(notes.length ? { noRegistry: notes } : {}),
    hint: "search_gem_projects has plant/field-level data worldwide; list_sources shows coverage.",
  };
}

// ---------------------------------------------------------------- list_sources

function sourceDetail(s) {
  return {
    key: s.key,
    country: s.country,
    ...(s.state ? { state: s.state } : {}),
    label: s.label,
    agency: s.agency,
    protocol: s.kind ?? "arcgis",
    endpoint: s.url,
    searchableFilters: Object.keys(s.searchFields),
    idType: s.idKind === "us-api" ? "US API number" : s.idLabel ?? "source well identifier",
    maxPageSize: s.pageMax,
    radiusSearch: !s.noNear,
    ...(s.license ? { license: s.license } : {}),
    ...(s.caveat ? { caveat: s.caveat } : {}),
  };
}

server.registerTool(
  "list_sources",
  {
    title: "List well-data sources",
    description:
      "List the well-data sources this server can query - US state regulators, provincial and national regulators, and geological surveys worldwide - plus places checked and found to have no public machine-readable registry. Call this first. Without arguments it returns a compact index (key, country, state, label); pass country, state or source for full detail (endpoint, searchable filters, id type, caveats, licence).",
    inputSchema: { country: countryArg, state: stateArg, source: sourceArg },
  },
  async ({ country, state, source }) => {
    const sources = selectSources({ source, country, state });
    const detailed = Boolean(country || state || source);
    const notes = NO_REGISTRY_NOTES.filter((n) => !country || n.countries.includes(country));
    return json({
      sources: detailed
        ? sources.map(sourceDetail)
        : sources.map((s) => ({ key: s.key, country: s.country, ...(s.state ? { state: s.state } : {}), label: s.label })),
      ...(detailed
        ? {}
        : {
            countries: COUNTRY_KEYS,
            geothermalProjectData:
              "For DOE-funded geothermal datasets (logs, stimulation, flow tests, microseismic - incl. Fervo Cape Station, Utah FORGE), use search_geothermal_datasets; give it a latitude/longitude to find datasets covering a place.",
            globalProjects:
              "For plant/field-level coverage worldwide, including countries with no well registry, use search_gem_projects (bundled Global Energy Monitor trackers).",
            heatFlow:
              "For heat flow, temperature gradients and thermal conductivity anywhere in the world (geothermal screening, incl. countries with no well registry), use search_heat_flow (bundled IHFC Global Heat Flow Database).",
            gemReleases: await gemDatasets(),
            heatFlowRelease: await heatflowDataset(),
          }),
      ...(notes.length ? { noRegistry: notes } : {}),
    });
  }
);

// ---------------------------------------------------------------- search_wells

server.registerTool(
  "search_wells",
  {
    title: "Search wells",
    description:
      "Search well registries by operator, well name, county/area, field, status, or type. Returns normalized records (well id, name, operator, status, type, field, county, lat/lon, dates, depths where available) plus source-specific extras. All *Date fields are ISO 'YYYY-MM-DD' strings (or null) regardless of how the source stores them. Text filters are case-insensitive partial matches combined with AND. Set count_only=true to size a query first. Omitting country/state/source searches every source (slow) - set one when you can.",
    inputSchema: {
      country: countryArg,
      state: stateArg,
      source: sourceArg,
      operator: z.string().optional().describe("Operator/company/licensee name, partial match (e.g. 'Fervo', 'Equinor')."),
      well_name: z.string().optional().describe("Well, wellbore or lease name, partial match."),
      api: z.string().optional().describe("Well identifier exactly as the source formats it (US API number, UWI, wellbore name). For a lookup that tolerates formatting differences use get_well."),
      county: z.string().optional().describe("County / district / area name, partial match."),
      field: z.string().optional().describe("Field name, partial match."),
      status: z.string().optional().describe("Well status, partial match (vocabulary varies by source: 'Active', 'Plugged', 'P&A', ...)."),
      well_type: z.string().optional().describe("Well type or purpose, partial match (e.g. 'Oil', 'Gas', 'Geothermal', 'Injection'; vocabulary varies by source)."),
      limit: z.number().int().min(1).max(500).default(25).describe("Max records per source (default 25)."),
      offset: z.number().int().min(0).default(0).describe("Pagination offset within each source."),
      count_only: z.boolean().default(false).describe("If true, return only match counts per source."),
    },
  },
  async (args) => {
    const { country, state, source, limit, offset, count_only } = args;
    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, args[k]]).filter(([, v]) => v != null && v !== ""));
    const sources = selectSources({ source, country, state });
    if (!sources.length) return json(noSources(country, state));
    if (!Object.keys(filters).length && !count_only) {
      return err(`Provide at least one filter (${FILTER_KEYS.join(", ")}), or set count_only=true.`);
    }
    const { results, failures } = await acrossSources(sources, (s) =>
      searchOneSource(s, filters, { limit, offset, countOnly: count_only })
    );
    const skipped = results.filter((r) => r.skipped);
    const answered = results.filter((r) => !r.skipped && (count_only ? r.count !== 0 : r.returned > 0));
    const empty = results.filter((r) => !r.skipped && !answered.includes(r)).map((r) => r.source);
    return json(
      withFailures(
        {
          results: answered,
          ...(empty.length ? { noMatchesIn: empty } : {}),
          ...(skipped.length ? { skipped: skipped.map(({ source, note }) => ({ source, note })) } : {}),
        },
        failures
      )
    );
  }
);

// ---------------------------------------------------------------- get_well

/** Which sources get_well should ask for an identifier, and why. */
function routeIdLookup(id, { source, country, state }) {
  if (source || country || state) return { sources: selectSources({ source, country, state }) };
  if (looksLikeUsApi(id)) {
    const apiState = apiStateOf(id);
    const usApi = SOURCES.filter((s) => s.idKind === "us-api");
    if (!apiState) return { sources: usApi };
    const inState = usApi.filter((s) => s.state === apiState || s.apiStates?.includes(apiState));
    return {
      sources: inState,
      routedBy: `API prefix ${String(id).replace(/\D/g, "").slice(0, 2)} = ${apiState}`,
      ...(inState.length ? {} : { uncovered: apiState }),
    };
  }
  return { sources: SOURCES.filter((s) => s.idKind !== "us-api") };
}

server.registerTool(
  "get_well",
  {
    title: "Get a well by its identifier",
    description:
      "Look up one well by identifier and return its FULL raw record plus the normalized summary. US API numbers in any format (dashes, 10/12/14 digits) are routed to the right state by their 2-digit API state prefix and matched dash-tolerantly. Non-US identifiers (Canadian UWI, Norwegian wellbore name like '15/9-19 A', NLOG/BSS codes...) are matched exactly, then as a contains-match; pass country or source for these to avoid asking every source.",
    inputSchema: {
      api: z.string().min(3).describe("Well identifier: US API number (e.g. 04-029-12345, 4300712345), UWI, wellbore name, or the source's own well code."),
      country: countryArg,
      state: stateArg,
      source: sourceArg,
    },
  },
  async ({ api, country, state, source }) => {
    const route = routeIdLookup(api, { source, country, state });
    if (!route.sources.length && !route.uncovered) return json(noSources(country, state));
    if (route.uncovered) {
      const other = findSources({ state: route.uncovered }).map((s) => s.key);
      return json({
        found: false,
        message: other.length
          ? `API number '${api}' belongs to ${route.uncovered}, whose sources (${other.join(", ")}) do not index API numbers. Try search_wells with state=${route.uncovered}.`
          : `API number '${api}' belongs to ${route.uncovered}, which has no registered source. Call list_sources for coverage.`,
      });
    }
    const task = async (s) => {
      const rows = await providerFor(s).findById(s, api);
      if (!rows.length) return null;
      return {
        source: s.key,
        label: s.label,
        agency: s.agency,
        matches: rows.map((r) => ({ normalized: normalizeRows(s, [r])[0], raw: r.attrs })),
      };
    };
    const { results, failures } = await acrossSources(route.sources, task);
    const hits = results.filter(Boolean);
    const body = hits.length
      ? { found: true, results: hits }
      : { found: false, message: `No well matching '${api}' in ${route.sources.map((s) => s.key).join(", ") || "any source"}.` };
    if (route.routedBy) body.routedBy = route.routedBy;
    return json(withFailures(body, failures));
  }
);

// ---------------------------------------------------------------- wells_near

server.registerTool(
  "wells_near",
  {
    title: "Find wells near a point",
    description:
      "Find wells within a radius of a lat/lon point - all wells on or around a pad, lease, field or project site. Only sources whose coverage area overlaps the circle are asked, so this works anywhere in the world without picking a source. Results are sorted by distance.",
    inputSchema: {
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radius_km: z.number().min(0.01).max(100).default(3).describe("Search radius in kilometers (default 3)."),
      country: countryArg,
      state: stateArg,
      source: sourceArg,
      limit: z.number().int().min(1).max(500).default(50).describe("Max records per source."),
    },
  },
  async ({ latitude, longitude, radius_km, country, state, source, limit }) => {
    const box = radiusToBbox(latitude, longitude, radius_km * 1000);
    const sources = selectSources({ source, country, state }).filter(
      (s) => !s.noNear && (source || extentIntersects(s.extent, box))
    );
    if (!sources.length) {
      return json({
        center: { latitude, longitude },
        radius_km,
        results: [],
        message: "No registered source covers this location. Try search_gem_projects for plant/field-level data, or list_sources for coverage.",
        ...(country ? { ...noSources(country, state), error: undefined } : {}),
      });
    }
    const near = { latitude, longitude, radiusKm: radius_km };
    const { results, failures } = await acrossSources(sources, (s) => searchOneSource(s, {}, { limit, offset: 0, near }));
    const found = results.filter((r) => r.returned > 0);
    // Nothing nearby: say what is known about coverage in the countries asked.
    const askedCountries = new Set(sources.map((s) => s.country));
    const notes = found.length ? [] : NO_REGISTRY_NOTES.filter((n) => n.countries.some((c) => askedCountries.has(c)));
    return json(
      withFailures(
        {
          center: { latitude, longitude },
          radius_km,
          sourcesAsked: sources.map((s) => s.key),
          results: found,
          ...(found.length ? {} : { hint: "No wells found in range. search_gem_projects has plant/field-level data; search_geothermal_datasets covers DOE geothermal studies." }),
          ...(notes.length ? { noRegistry: notes } : {}),
        },
        failures
      )
    );
  }
);

// ---------------------------------------------------------------- raw_query

const RAW_SOURCE_KEYS = SOURCES.filter((s) => providerFor(s).canRaw?.(s)).map((s) => s.key);

server.registerTool(
  "raw_query",
  {
    title: "Raw layer query",
    description:
      "Escape hatch: run a raw filter against one source and get raw attributes back - SQL-92 WHERE for ArcGIS sources, CQL for GeoServer WFS sources. Field names are the source's own (see searchableFilters in list_sources, or query with where='1=1' limit=1 to inspect a record). Use it for filters the normalized search does not cover (dates, depths, cumulative production).",
    inputSchema: {
      source: z.enum(RAW_SOURCE_KEYS).describe("Source key, e.g. UT or CA-OG."),
      where: z.string().describe("Filter expression, e.g. \"totcum_oil > 1000000 AND county = 'BEAVER'\""),
      out_fields: z.string().default("*").describe("Comma-separated field list, or * for all."),
      limit: z.number().int().min(1).max(1000).default(50),
      offset: z.number().int().min(0).default(0),
    },
  },
  async ({ source, where, out_fields, limit, offset }) => {
    const [s] = findSources({ key: source });
    if (!s) return err(`Unknown source '${source}'.`);
    try {
      const { rows, moreAvailable } = await providerFor(s).raw(s, { where, outFields: out_fields, limit, offset });
      return json({
        source: s.key,
        returned: rows.length,
        moreAvailable,
        records: rows.map((r) => ({ ...r.attrs, _lat: r.geometry?.y ?? null, _lon: r.geometry?.x ?? null })),
      });
    } catch (e) {
      return err(`Query failed: ${e.message}. Check the filter against this source's field names.`);
    }
  }
);

// ---------------------------------------------------------------- operators

server.registerTool(
  "list_operators",
  {
    title: "List operators matching a name",
    description:
      "Find the exact operator name strings a source uses (they rarely match what you would guess - 'Fervo Energy Company', 'CALIFORNIA RESOURCES PRODUCTION CORPORATION', 'Equinor Energy AS'). Returns distinct operator names containing the search text, per source. Use before search_wells when an operator search returns nothing.",
    inputSchema: {
      name: z.string().min(2).describe("Partial operator name, case-insensitive."),
      country: countryArg,
      state: stateArg,
    },
  },
  async ({ name, country, state }) => {
    const sources = findSources({ country, state }).filter((s) => s.searchFields.operator && providerFor(s).distinct);
    const task = async (s) => {
      const values = await providerFor(s).distinct(s, "operator", name);
      const names = [...new Set(values.filter(Boolean).map((v) => String(v).trim()))].sort();
      return { source: s.key, operators: names.slice(0, 50), truncated: names.length > 50 };
    };
    const { results, failures } = await acrossSources(sources, task);
    return json(withFailures({ results: results.filter((r) => r.operators.length) }, failures));
  }
);

// ------------------------------------------------ search_gem_projects

server.registerTool(
  "search_gem_projects",
  {
    title: "Search global energy projects (GEM)",
    description:
      "Search bundled Global Energy Monitor tracker data: geothermal power units worldwide (Geothermal Power Tracker) and upstream oil & gas fields/discoveries (Oil & Gas Extraction Tracker). Project/field level, NOT well level - the fallback for countries with no public well registry (Kenya, Guatemala, Namibia, Indonesia...). Filters are ANDed, case-insensitive substrings. Local data - fast, works offline. Cite 'Global Energy Monitor' when publishing results.",
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

// ---------------------------------------------------- search_heat_flow

server.registerTool(
  "search_heat_flow",
  {
    title: "Search heat flow measurements (IHFC)",
    description:
      "Search the bundled IHFC Global Heat Flow Database: ~91,000 heat-flow measurements at ~72,000 sites worldwide, from boreholes (oil & gas, geothermal, mining, groundwater, research), ocean and lake probes, mines and tunnels. Each record has heat flow (mW/m2), and where measured the temperature gradient (K/km), thermal conductivity (W/mK), depth, purpose and year. Use it for geothermal screening anywhere - including countries with no public well registry (Kenya, Namibia, Indonesia...). A radius search returns the nearest first plus summary statistics over every match. Local data - fast, works offline. Typical continental heat flow is 50-80 mW/m2; geothermal areas run far higher, and very shallow holes in volcanic ground can show extreme values - add min_depth_m to drop them. quality is the IHFC quality code (U = uncertainty, M = method score; x = not assessed). Cite the IHFC Global Heat Flow Database (the citation is in every response).",
    inputSchema: {
      latitude: z.number().min(-90).max(90).optional().describe("With longitude + radius_km: measurements within the radius, nearest first."),
      longitude: z.number().min(-180).max(180).optional(),
      radius_km: z.number().min(0.1).max(2000).default(50),
      name: z.string().optional().describe("Site or well name, partial match (e.g. 'Habanero', 'Olkaria')."),
      purpose: z.string().optional().describe("Purpose of the hole: geothermal, hydrocarbon, mining, groundwater, research, mapping."),
      method: z.string().optional().describe("Exploration method: drilling, probing, mining, tunneling."),
      environment: z.string().optional().describe("onshore or offshore (also 'marine', 'lake')."),
      min_heat_flow: z.number().min(0).optional().describe("Only measurements at or above this heat flow (mW/m2)."),
      min_depth_m: z.number().min(0).optional().describe("Only holes at least this deep (metres, TVD or else MD)."),
      limit: z.number().int().min(1).max(200).default(25),
    },
  },
  async ({ latitude, longitude, radius_km, name, purpose, method, environment, min_heat_flow, min_depth_m, limit }) => {
    const spatial = latitude != null && longitude != null;
    if (!spatial && !name && !purpose && !method && !environment && min_heat_flow == null && min_depth_m == null) {
      return err("Provide latitude + longitude, or at least one filter (name, purpose, method, environment, min_heat_flow, min_depth_m).");
    }
    try {
      return json(
        await searchHeatFlow({
          near: spatial ? { latitude, longitude, radiusKm: radius_km } : null,
          name,
          purpose,
          method,
          environment,
          minHeatFlow: min_heat_flow,
          minDepth: min_depth_m,
          limit,
        })
      );
    } catch (e) {
      return err(`Heat flow data not available: ${e.message}. Run scripts/convert-ihfc.py on a GHFDB release.`);
    }
  }
);

// ------------------------------------------- search_geothermal_datasets

server.registerTool(
  "search_geothermal_datasets",
  {
    title: "Search DOE geothermal datasets (GDR)",
    description:
      "Search U.S. DOE-funded geothermal datasets: well logs, stimulation and flow-test data, microseismic, DTS, temperature, geologic models. THE source for Fervo Cape Station (search 'cape egs' or 'fervo' - 'cape station' also matches Cape Grim air station), Utah FORGE, Newberry, and some international geothermal studies. Two catalogs: 'osti' (default for text) searches the OSTI Data Explorer index, returning titles, DOIs and links; 'gdr' searches the Geothermal Data Repository's own catalog and returns each dataset's map footprint and direct file download links. Give latitude/longitude to find datasets whose footprint covers a place (uses 'gdr', tightest footprints first). Terms are ANDed.",
    inputSchema: {
      query: z.string().min(2).optional().describe("Search terms, e.g. 'cape egs', 'utah forge stimulation', 'olkaria kenya'. Optional with latitude/longitude."),
      latitude: z.number().min(-90).max(90).optional().describe("With longitude: datasets whose footprint overlaps radius_km around this point."),
      longitude: z.number().min(-180).max(180).optional(),
      radius_km: z.number().min(0.1).max(500).default(25),
      catalog: z.enum(["osti", "gdr"]).optional().describe("Force a catalog. Default: gdr for place searches, osti otherwise."),
      rows: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ query, latitude, longitude, radius_km, catalog, rows }) => {
    const spatial = latitude != null && longitude != null;
    if (!query && !spatial) return err("Provide query, or latitude + longitude.");
    const useGdr = spatial || catalog === "gdr";
    try {
      return json(
        useGdr
          ? await searchGdr({ query, latitude, longitude, radiusKm: radius_km, rows })
          : await searchGeothermalDatasets(query, rows)
      );
    } catch (e) {
      return err(`${useGdr ? "GDR catalog" : "OSTI"} query failed: ${e.message}`);
    }
  }
);

// ---------------------------------------------------------------- main

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`well-data-mcp ready: ${SOURCES.length} sources in ${COUNTRY_KEYS.length} countries (${COUNTRY_KEYS.join(", ")})`);
