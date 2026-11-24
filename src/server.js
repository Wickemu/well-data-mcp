// well-data-mcp — the MCP tools for oil & gas / geothermal well data from public
// regulator and geological-survey services worldwide. createServer() returns a server
// with every tool registered; src/index.js connects it over stdio or HTTP.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SOURCES, findSources, NO_REGISTRY_NOTES } from "./sources/index.js";
import { providerFor } from "./providers/index.js";
import { apiStateOf, looksLikeUsApi } from "./api-number.js";
import { parseUwi } from "./uwi.js";
import { radiusToBbox, extentIntersects, haversineKm } from "./geo.js";
import { searchGem, gemDatasets } from "./gem.js";
import { searchGeothermalDatasets } from "./osti.js";
import { searchGdr } from "./gdr.js";
import { searchHeatFlow, heatflowDataset } from "./heatflow.js";
import { VERSION } from "./meta.js";
import { callContext } from "./call-context.js";
import { sourceHealth } from "./upkeep.js";
import { normalizeRows, searchOneSource } from "./search.js";
import { scoreCandidate, parseDateHint, wellKey, confidenceOf, worthShowing, hintText, numberParts, mainNumber, derivedNames, lastNumber } from "./match.js";
import { nameScore, nameTokens } from "./name-match.js";

// Tools are declared once here and registered on every server createServer() makes: one
// for stdio, one per request over stateless HTTP. Caches live in the modules, so all
// servers in a process share them.
const TOOLS = [];
function tool(name, config, handler) {
  TOOLS.push([name, config, handler]);
}

// Every tool only reads. The live ones reach out to agency servers; the bundled datasets do not.
const LIVE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const OFFLINE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const OFFLINE_TOOLS = new Set(["search_heat_flow", "search_gem_projects"]);

const INSTRUCTIONS = `Well data from public oil & gas and geothermal registries worldwide, queried live.
- Identify one well from a working name plus facts (operator, field, county, position, spud date): match_well. Only a "strong" answer is settled.
- Look up an identifier (US API number in any format, UWI, wellbore name): get_well.
- Wells around a point: wells_near. Search by operator, name, county, field, status or type: search_wells.
- Coverage, and places with no public registry: list_sources.
- Answers marked incomplete: true are missing the sources in sourceErrors; "not found" then means "not found in the sources that answered".`;

export function createServer() {
  const server = new McpServer({ name: "well-data", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const [name, config, handler] of TOOLS) {
    server.registerTool(name, { ...config, annotations: { title: config.title, ...(OFFLINE_TOOLS.has(name) ? OFFLINE : LIVE) } }, handler);
  }
  return server;
}

const COUNTRY_KEYS = [...new Set(SOURCES.map((s) => s.country))].sort();
// Countries a caller may name: those with sources plus those with a no-registry note.
const COUNTRY_ARGS = [...new Set([...COUNTRY_KEYS, ...NO_REGISTRY_NOTES.flatMap((n) => n.countries)])].sort();
const STATE_KEYS = [...new Set(SOURCES.map((s) => s.state).filter(Boolean))].sort();
const SOURCE_KEYS = SOURCES.map((s) => s.key);
const SOURCE_BY_KEY = new Map(SOURCES.map((s) => [s.key, s]));
const FILTER_KEYS = ["operator", "well_name", "api", "county", "field", "status", "well_type"];

// Compact JSON: about 40% fewer tokens than indented, so busy areas stay inside the
// output limits MCP clients put on a tool's answer (scripts/call-tool.js re-indents it).
function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// A call that asks several sources answers after this long with whatever has come back;
// the slow ones are listed in sourceErrors. One stalled server (a cold ArcGIS service can
// take 40 s to wake) should not hold up the registries that answered in one. A call that
// names its source waits for it.
const BUDGET_MS = Number(process.env.WELL_DATA_BUDGET_MS) || 25_000;
const LATE = Symbol("late");
const DEEP_NAME_SOURCES = 8;

/**
 * Run a task across selected sources, tolerating per-source failures and slow sources.
 * Each task runs inside the call's context (src/call-context.js): when the budget runs out,
 * or `signal` (the client cancelled or went away) fires, the requests still running for
 * the late sources are abandoned, so they stop holding their hosts' request slots.
 */
async function acrossSources(sources, task, { budgetMs = sources.length > 1 ? BUDGET_MS : 0, signal = null } = {}) {
  const ctrl = new AbortController();
  const onCancel = () => ctrl.abort(new Error("the client cancelled the call"));
  if (signal?.aborted) onCancel();
  signal?.addEventListener?.("abort", onCancel, { once: true });
  let timer;
  const deadline = budgetMs ? new Promise((resolve) => (timer = setTimeout(() => resolve(LATE), budgetMs))) : null;
  let settled;
  try {
    settled = await Promise.all(
      sources.map((s) => {
        const run = callContext
          .run({ signal: ctrl.signal }, () => Promise.resolve().then(() => task(s)))
          .then((value) => ({ value }), (reason) => ({ reason }));
        return deadline ? Promise.race([run, deadline]) : run;
      })
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCancel);
    // Whatever is still running belongs to a late source: nobody will read its answer.
    if (!ctrl.signal.aborted) ctrl.abort(new Error(`the call answered after its ${budgetMs / 1000} s budget`));
  }
  const results = [];
  const failures = [];
  settled.forEach((r, i) => {
    const key = sources[i].key;
    if (r === LATE) failures.push({ source: key, error: `No answer within ${budgetMs / 1000} s. Ask again with source=${key} to wait for it.`, timedOut: true });
    else if ("value" in r) results.push(r.value);
    else failures.push({ source: key, error: String(r.reason?.message ?? r.reason) });
  });
  return { results, failures };
}

/** Sources that failed or ran out of time make the answer incomplete: "not found" then means "not found in the rest". */
function withFailures(body, failures) {
  return failures.length ? { ...body, incomplete: true, sourceErrors: failures } : body;
}

const countryArg = z
  .enum(COUNTRY_ARGS)
  .optional()
  .describe(`ISO 3166-1 alpha-2 country code. With sources: ${COUNTRY_KEYS.join(", ")} (EU = pan-European). Others listed return a note on why there is no registry.`);
const stateArg = z
  .enum(STATE_KEYS)
  .optional()
  .describe(
    "State / province / region code within the country: US postal codes (CA, UT, TX...) and OCS-GOM / OCS-PAC / OCS-AK / OCS-ATL for federal offshore, Canadian provinces (AB, BC, SK, MB, ON, QC, NB, NS...), Australian states (QLD, NSW, VIC, TAS, SA, WA, NT), NZ regions (WKO, BOP). WA alone matches both Washington and Western Australia; add country to pick one. Nationwide US datasets (FracFocus, orphaned wells, BLM) have no state: use country=US or source."
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
  // A long-running server checks every source daily (src/upkeep.js): show the last result.
  const check = sourceHealth()?.sources?.[s.key];
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
    ...(check ? { lastCheck: { at: sourceHealth().checkedAt, answered: check.ok, ...(check.error ? { error: check.error } : {}) } } : {}),
  };
}

tool(
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

tool(
  "search_wells",
  {
    title: "Search wells",
    description:
      "Search well registries by operator, well name, county/area, field, status, or type. Returns normalized records (well id, name, operator, status, type, field, county, lat/lon, dates, depths where available) plus source-specific extras. All *Date fields are ISO 'YYYY-MM-DD' strings (or null) regardless of how the source stores them. Text filters are case-insensitive partial matches combined with AND. well_name is forgiving - punctuation, '#', zero padding and a sidetrack suffix are ignored, and where a registry stores lease and well number apart it matches either or both - and those results come best-first with nameMatch (0-1); to pin down one well from a working name plus other facts use match_well. Set count_only=true to size a query first. An answer with incomplete: true is missing the sources listed in sourceErrors. Omitting country/state/source searches every source (slow) - set one when you can.",
    inputSchema: {
      country: countryArg,
      state: stateArg,
      source: sourceArg,
      operator: z.string().optional().describe("Operator/company/licensee name, partial match (e.g. 'Fervo', 'Equinor')."),
      well_name: z.string().optional().describe("Well, wellbore or lease name: 'Alder Unit B 27X-15', the number alone ('27X-15') or the lease alone."),
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
  async (args, extra) => {
    const { country, state, source, limit, offset, count_only } = args;
    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, args[k]]).filter(([, v]) => v != null && v !== ""));
    const sources = selectSources({ source, country, state });
    if (!sources.length) return json(noSources(country, state));
    if (!Object.keys(filters).length && !count_only) {
      return err(`Provide at least one filter (${FILTER_KEYS.join(", ")}), or set count_only=true.`);
    }
    // The looser name tiers cost extra requests on every miss: only when few sources are asked.
    const deepNames = sources.length <= DEEP_NAME_SOURCES;
    const { results, failures } = await acrossSources(sources, (s) => searchOneSource(s, filters, { limit, offset, countOnly: count_only, deepNames }), { signal: extra?.signal });
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
    // apiPattern: a source that holds only some of a state's numbers (offshore pseudo-counties).
    const digits = String(id).replace(/\D/g, "");
    const inState = usApi.filter((s) => (s.state === apiState || s.apiStates?.includes(apiState)) && (!s.apiPattern || s.apiPattern.test(digits)));
    return {
      sources: inState,
      routedBy: `API prefix ${String(id).replace(/\D/g, "").slice(0, 2)} = ${apiState}`,
      ...(inState.length ? {} : { uncovered: apiState }),
    };
  }
  // A Canadian UWI in any spelling: the sources that keep UWIs.
  const uwiSources = parseUwi(id) ? SOURCES.filter((s) => s.uwi) : [];
  if (uwiSources.length) return { sources: uwiSources, routedBy: "Canadian UWI" };
  return { sources: SOURCES.filter((s) => s.idKind !== "us-api") };
}

tool(
  "get_well",
  {
    title: "Get a well by its identifier",
    description:
      "Look up one well by identifier and return its FULL raw record plus the normalized summary. US API numbers in any format (dashes, 10/12/14 digits) are routed to the right state by their 2-digit API state prefix and matched dash-tolerantly; they also return any FracFocus hydraulic-fracturing disclosures for the well (job dates, water volume, full chemical list). Non-US identifiers (Canadian UWI, Norwegian wellbore name like '15/9-19 A', NLOG/BSS codes...) match whatever the spacing, punctuation, case or zero padding ('15/9-19A' = '15/9-19 A', 'AWG-1' = 'AWG-01'); Canadian UWIs in any common spelling ('100/06-12-034-05W5/00', '06-12-34-5 W5M', '200/A-079-B/094-H-04/00') go to the Canadian sources. When no record has the id exactly, records whose id contains it as whole words come back as partialMatches with found: false. Pass country or source for non-US ids to avoid asking every source. found: false with incomplete: true means the sources in sourceErrors did not answer, not that the well is absent.",
    inputSchema: {
      api: z.string().min(3).describe("Well identifier: US API number (e.g. 04-029-12345, 4300712345), UWI, wellbore name, or the source's own well code."),
      country: countryArg,
      state: stateArg,
      source: sourceArg,
    },
  },
  async ({ api, country, state, source }, extra) => {
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
        // partial: no record has this id exactly; these ids hold it as whole words ('Qulleq' in 'Qulleq-1').
        partial: rows.every((r) => r.partial),
        matches: rows.map((r) => ({ normalized: normalizeRows(s, [r])[0], raw: r.attrs })),
      };
    };
    const { results, failures } = await acrossSources(route.sources, task, { signal: extra?.signal });
    const hits = results.filter(Boolean);
    const exact = hits.filter((h) => !h.partial).map(({ partial, ...h }) => h);
    const partial = hits.filter((h) => h.partial).map(({ partial: _, ...h }) => h);
    const where = route.sources.map((s) => s.key).join(", ") || "any source";
    const body = exact.length
      ? { found: true, results: exact }
      : partial.length
        ? { found: false, message: `No record has the id '${api}' exactly; partialMatches holds records whose id contains it.`, partialMatches: partial }
        : { found: false, message: `No well matching '${api}' in ${where}.` };
    if (route.routedBy) body.routedBy = route.routedBy;
    return json(withFailures(body, failures));
  }
);

// ---------------------------------------------------------------- wells_near

tool(
  "wells_near",
  {
    title: "Find wells near a point",
    description:
      "Find wells within a radius of a lat/lon point - all wells on or around a pad, lease, field or project site. Only sources whose coverage area overlaps the circle are asked, so this works anywhere in the world without picking a source. Each source lists its nearest wells first. In a dense field the circle can hold more wells than a source returns in one answer; the source is then asked again closer in, and its result carries completeWithinKm: every well within that distance is listed, anything farther is a sample (0 = the whole list is a sample; use a smaller radius).",
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
  async ({ latitude, longitude, radius_km, country, state, source, limit }, extra) => {
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
    const { results, failures } = await acrossSources(sources, (s) => searchOneSource(s, {}, { limit, offset: 0, near }), { signal: extra?.signal });
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

// ---------------------------------------------------------------- match_well

const MATCH_NAME_ROWS = 40; // name candidates kept per source and name
const MATCH_NEAR_ROWS = 100; // nearest wells weighed per source
const MATCH_ON_THE_SPOT_KM = 0.15; // every well this close is weighed, however many share the spot
const GOOD_NAME = 0.85; // a name match this good ends the search for more candidates
const DERIVED_NAME_WEIGHT = 0.9; // name matches found through a derived reading of the name (see derivedNames)
const SAME_SPOT_KM = 0.05; // an id-less record this close to one with an id, under a matching name, is the same well
const TWIN_KM = 1; // ...or this close under the same well number (compilations place the same well up to ~0.75 km apart)
const NO_ID_COST = 0.03; // a record with no id ranks just below an otherwise equal one with an id
const AREA_COUNTY = new Set(SOURCES.filter((s) => s.countyIsArea).map((s) => s.key));

tool(
  "match_well",
  {
    title: "Identify a well in the registry",
    description:
      "Find the registry record for a well you know by a working name - the name on a mud log, a rig report or a job sheet - plus whatever else is known. Names are matched loosely (lease left off or worded differently, '#', zero padding, sidetrack suffixes), a latitude/longitude adds the wells nearest that point, and each candidate is scored on the evidence: name, distance, spud date, with operator, field and county as supporting hints (for US wells a county or field that differs counts against a candidate, and its confidence is at most ambiguous unless position or spud date agree). Returns candidates best-first with the evidence for each and a confidence: strong (name plus position or spud date agree and nothing else comes close), probable (a clear best candidate on the name alone), ambiguous (several records fit equally - add facts) or weak. Give state, country or source, or a latitude/longitude. Use get_well afterwards for the full record.",
    inputSchema: {
      name: z.string().min(1).describe("The well's name as you have it, e.g. 'Canyon JV 12H-30', '6-KH', 'Sam Porter #2 ST1'."),
      other_names: z.array(z.string().min(1)).max(5).optional().describe("Other names the same well goes by (a file name, a permit designation)."),
      operator: z.string().optional().describe("Operator as you know it. Supporting evidence only: operators change."),
      field: z.string().optional().describe("Field or prospect name. For a US well, a record in another field scores lower."),
      county: z.string().optional().describe("County / district. For a US well, a record in another county scores lower."),
      latitude: z.number().min(-90).max(90).optional().describe("With longitude: a position for the well (surface location, rig GPS)."),
      longitude: z.number().min(-180).max(180).optional(),
      radius_km: z.number().min(0.05).max(50).default(2).describe("How far from that position to look (default 2)."),
      spud_date: z.string().optional().describe("Spud date or year in any common format ('2023-08-18', 'Aug 18, 2023', '2011')."),
      country: countryArg,
      state: stateArg,
      source: sourceArg,
      limit: z.number().int().min(1).max(25).default(5).describe("Candidates to return (default 5)."),
    },
  },
  async ({ name, other_names, operator, field, county, latitude, longitude, radius_km, spud_date, country, state, source, limit }, extra) => {
    const near = latitude != null && longitude != null ? { latitude, longitude, radiusKm: radius_km } : null;
    if (!near && !source && !country && !state) return err("Give state, country or source, or a latitude and longitude, so the right registries are asked.");
    const spud = parseDateHint(spud_date);
    if (spud_date && !spud) return err(`Could not read spud_date '${spud_date}'. Use YYYY-MM-DD, 'Aug 18, 2023' or a year.`);
    let sources = selectSources({ source, country, state });
    if (near && !source) {
      const box = radiusToBbox(latitude, longitude, radius_km * 1000);
      sources = sources.filter((s) => extentIntersects(s.extent, box));
    }
    sources = sources.filter((s) => s.searchFields.well_name || (near && !s.noNear));
    if (!sources.length) return json(noSources(country, state));
    const names = [...new Set([name, ...(other_names ?? [])].map((n) => n.trim()).filter(Boolean))];
    const derived = [...new Set(names.flatMap(derivedNames))].filter((d) => !names.some((n) => n.toUpperCase() === d));
    const known = { names, derived, operator, field, county, near, spud, areaCounty: AREA_COUNTY };
    // Hints as search filters, cut down to the words a registry is likely to share.
    const hints = Object.entries({ field, county, operator }).map(([k, v]) => [k, v ? hintText(v) : ""]).filter(([, v]) => v);
    // Follow-up lookups (a name narrowed by a hint, a well number under another lease) may fail
    // without failing the source, but the answer says so: a missing follow-up can hide the well.
    const partial = new Map();
    const missed = (s) => (e) => {
      if (!partial.has(s.key)) partial.set(s.key, String(e?.message ?? e));
      return {};
    };
    const rows = (s, filters, rankName) => searchOneSource(s, filters, { limit: MATCH_NAME_ROWS, offset: 0, deepNames: false, rankName }).catch(missed(s));

    const task = async (s) => {
      const usable = hints.filter(([k]) => s.searchFields[k]);
      const lookups = [];
      if (s.searchFields.well_name) {
        for (const n of [...names, ...derived]) {
          // The name as given. Too many wells by that name: narrow by each hint. A derived
          // reading's name matches count a shade less than the name's own, and a failed lookup
          // for one is a follow-up that failed, not a failed source.
          const own = names.includes(n);
          const scaled = (ws) => (own ? ws : ws.map((w) => ({ ...w, nameMatch: w.nameMatch != null ? Math.round(w.nameMatch * DERIVED_NAME_WEIGHT * 100) / 100 : w.nameMatch })));
          const lookup = searchOneSource(s, { well_name: n }, { limit: MATCH_NAME_ROWS, offset: 0 }).then(async (r) => {
            if (!r.moreAvailable) return scaled(r.wells ?? []);
            const narrowed = await Promise.all(usable.map(([k, v]) => rows(s, { well_name: n, [k]: v }, n)));
            return scaled([...(r.wells ?? []), ...narrowed.flatMap((x) => x.wells ?? [])]);
          });
          lookups.push(own ? lookup : lookup.catch((e) => (missed(s)(e), [])));
        }
      }
      if (near && !s.noNear) {
        lookups.push(searchOneSource(s, {}, { limit: MATCH_NEAR_ROWS, offset: 0, near, keepWithinKm: MATCH_ON_THE_SPOT_KM }).then((r) => r.wells ?? []));
      }
      const found = (await Promise.all(lookups)).flat();
      // Nothing by that name here, at that position or anywhere: look for the well number under
      // whatever lease the registry uses, within each hint ('Opal 310-512' is 'State PRC 310 512'
      // in the same field), and for the name's main number among the wells around the position
      // (the nearest hundred do not reach far in a dense field). Ranked on the full name.
      // Skipped when a good name match is in hand, because each of these is one more request.
      // A good name match ends the search only if it does not contradict the county or field
      // given: an exact 'Section 6 2-2' in another county is not the well asked for.
      const named = (w) => {
        const { evidence } = scoreCandidate(known, w, w.nameMatch);
        return evidence.name >= GOOD_NAME && evidence.county !== "differs" && evidence.field !== "differs";
      };
      if (!s.searchFields.well_name || found.some(named)) return found;
      const extra = [];
      // Field and county together narrow enough to look up even a short well number - unless
      // a candidate that fits the name at least loosely is already in that field or county.
      const placed = found.some((w) => {
        const { evidence: e } = scoreCandidate(known, w, w.nameMatch);
        return e.name >= 0.5 && e.county !== "differs" && e.field !== "differs" && (e.county === "agrees" || e.field === "agrees");
      });
      const place = usable.filter(([k]) => k === "field" || k === "county");
      const scopes = place.length > 1 ? [Object.fromEntries(place), ...place.map(([k, v]) => ({ [k]: v }))] : place.map(([k, v]) => ({ [k]: v }));
      for (const n of names) {
        for (const number of numberParts(n)) {
          for (const [k, v] of usable) extra.push(rows(s, { well_name: number, [k]: v }, n).then((r) => r.wells ?? []));
        }
        for (const number of new Set([mainNumber(n), lastNumber(n)].filter(Boolean))) {
          if (placed || numberParts(n).includes(number)) continue;
          for (const scope of scopes) extra.push(rows(s, { well_name: number, ...scope }, n).then((r) => r.wells ?? []));
        }
        const number = near && !s.noNear ? mainNumber(n) : null;
        if (number) extra.push(searchOneSource(s, { well_name: number }, { limit: MATCH_NEAR_ROWS, offset: 0, near }).then((r) => r.wells ?? [], (e) => (missed(s)(e), [])));
      }
      return [...found, ...(await Promise.all(extra)).flat()];
    };
    const { results, failures } = await acrossSources(sources, task, { signal: extra?.signal });
    for (const [key, error] of partial) {
      if (!failures.some((f) => f.source === key)) failures.push({ source: key, error: `Some follow-up lookups failed (${error}); a candidate may be missing.`, partial: true });
    }

    const best = new Map(); // one entry per well, however many sources and lookups returned it
    for (const { nameMatch, distanceKm, ...well } of results.flat()) {
      const candidate = { ...scoreCandidate(known, well, nameMatch), well };
      if (!worthShowing(candidate)) continue;
      const key = wellKey(well, SOURCE_BY_KEY.get(well.source)?.idKind);
      const prev = best.get(key);
      const others = new Set(prev ? [...prev.alsoIn, prev.well.source] : []);
      if (!prev || candidate.rank > prev.rank) best.set(key, { ...candidate, alsoIn: others });
      else others.forEach((o) => prev.alsoIn.add(o)), prev.alsoIn.add(well.source);
    }
    // A record without an id (a temperature compilation, a duplicate row) at the same spot as one
    // with an id, under a name for the same well, is that well: keep the one with the id.
    const all = [...best.values()];
    const twinName = (a, b) => Math.max(nameScore(a.wellName ?? "", { name: b.wellName ?? "" }), nameScore(b.wellName ?? "", { name: a.wellName ?? "" }));
    const sameCounty = (a, b) => !a.county || !b.county || String(a.county).trim().toUpperCase() === String(b.county).trim().toUpperCase();
    for (const c of all.filter((x) => !x.well.api && Number.isFinite(x.well.latitude))) {
      const twin = all.find((o) => {
        if (o === c || !o.well.api || o.merged || !Number.isFinite(o.well.latitude) || !sameCounty(c.well, o.well)) return false;
        const km = haversineKm(c.well.latitude, c.well.longitude, o.well.latitude, o.well.longitude);
        const nm = twinName(c.well, o.well);
        return (km <= SAME_SPOT_KM && nm >= 0.6) || (km <= TWIN_KM && nm >= 0.85);
      });
      if (!twin) continue;
      c.merged = true;
      twin.alsoIn.add(c.well.source);
      if (c.rank > twin.rank) Object.assign(twin, { score: c.score, rank: c.rank, evidence: { ...c.evidence, ...twin.evidence, name: Math.max(c.evidence.name, twin.evidence.name) } });
    }
    // Ties: a record with an id first, then the name with the fewest words more or less than the name asked for.
    const extraWords = (w) => Math.abs(nameTokens(w.wellName ?? "").length - Math.min(...names.map((n) => nameTokens(n).length)));
    const order = (c) => c.rank - (c.well.api ? 0 : NO_ID_COST);
    const ranked = all
      .filter((c) => !c.merged)
      .sort((a, b) => order(b) - order(a) || Boolean(b.well.api) - Boolean(a.well.api) || extraWords(a.well) - extraWords(b.well));
    const candidates = ranked.slice(0, limit).map(({ alsoIn, well, rank, merged, ...c }) => {
      alsoIn.delete(well.source);
      return { ...c, well, ...(alsoIn.size ? { alsoIn: [...alsoIn] } : {}) };
    });
    const askedCountries = new Set(sources.map((s) => s.country));
    const notes = candidates.length ? [] : NO_REGISTRY_NOTES.filter((n) => n.countries.some((c) => askedCountries.has(c)));
    return json(
      withFailures(
        {
          confidence: confidenceOf(ranked),
          candidates,
          ...(ranked.length > limit ? { moreCandidates: ranked.length - limit } : {}),
          sourcesAsked: sources.map((s) => s.key),
          ...(candidates.length ? {} : { hint: "No candidate. Try another spelling in other_names, add a latitude/longitude, or check coverage with list_sources." }),
          ...(notes.length ? { noRegistry: notes } : {}),
        },
        failures
      )
    );
  }
);

// ---------------------------------------------------------------- raw_query

const RAW_SOURCE_KEYS = SOURCES.filter((s) => providerFor(s).canRaw?.(s)).map((s) => s.key);

tool(
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

tool(
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
  async ({ name, country, state }, extra) => {
    const sources = findSources({ country, state }).filter((s) => s.searchFields.operator && providerFor(s).distinct);
    const task = async (s) => {
      const values = await providerFor(s).distinct(s, "operator", name);
      const names = [...new Set(values.filter(Boolean).map((v) => String(v).trim()))].sort();
      return { source: s.key, operators: names.slice(0, 50), truncated: names.length > 50 };
    };
    const { results, failures } = await acrossSources(sources, task, { signal: extra?.signal });
    return json(withFailures({ results: results.filter((r) => r.operators.length) }, failures));
  }
);

// ------------------------------------------------ search_gem_projects

tool(
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

tool(
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

tool(
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

/** One line for logs and /healthz: what this server covers. */
export function serverInfo() {
  return { name: "well-data", version: VERSION, sources: SOURCES.length, countries: COUNTRY_KEYS.length, tools: TOOLS.map(([name]) => name) };
}

export const COVERAGE_LINE = `${SOURCES.length} sources in ${COUNTRY_KEYS.length} countries (${COUNTRY_KEYS.join(", ")})`;
