// Source registry: every live well-data source, grouped by region file.
// A source is a plain object: key, country (ISO 3166-1 alpha-2), state (subdivision
// or null), label, agency, kind (provider; default "arcgis"), url, pageMax,
// idKind ("us-api" | "id"), extent ([minLon, minLat, maxLon, maxLat] or a list),
// searchFields (filter name -> source field), normalize(attrs, geometry), caveat?, license?.

import { US_SOURCES } from "./us.js";
import { BOEM_SOURCES } from "./boem.js";
import { FRACFOCUS_SOURCES } from "./fracfocus.js";
import { FEDERAL_SOURCES } from "./us-federal.js";
import { AMERICAS_SOURCES } from "./americas.js";
import { EUROPE_SOURCES } from "./europe.js";
import { AFRICA_ASIA_SOURCES } from "./africa-asia.js";
import { OCEANIA_SOURCES } from "./oceania.js";

export { normalizeRecord, msToIso, usDateToIso, isoDate, dmyToIso, ymdToIso, namedDateToIso } from "./normalize.js";

export const SOURCES = [
  ...US_SOURCES,
  ...BOEM_SOURCES,
  ...FEDERAL_SOURCES,
  ...FRACFOCUS_SOURCES,
  ...AMERICAS_SOURCES,
  ...EUROPE_SOURCES,
  ...AFRICA_ASIA_SOURCES,
  ...OCEANIA_SOURCES,
];

/**
 * Places checked (October 2026) and found to have NO public, keyless, machine-readable
 * well registry - or only one this server cannot use yet. list_sources reports these so
 * a search there fails honestly instead of silently. `countries` are ISO 3166-1 alpha-2.
 */
export const NO_REGISTRY_NOTES = [
  // ---------------------------------------------------------------- Americas
  { countries: ["GT"], name: "Guatemala", note: "No official registry. The Energy & Mines ministry (mem.gob.gt) and the open-data portal sit behind a browser challenge scripts cannot pass; the national spatial data infrastructure (IDEG/SEGEPLAN) WFS has no hydrocarbon or geothermal layers. Geothermal well data (Zunil, Amatitlán) is operator-held. Project level: search_gem_projects." },
  { countries: ["DM", "KN", "MS", "LC", "GD", "VC"], name: "Eastern Caribbean geothermal islands", note: "Dominica, St Kitts & Nevis, Montserrat, St Lucia, Grenada, St Vincent: no machine-readable well data found (reports and PDF tables only; the regional CHARIM GeoNode domain now serves only a static copy of its homepage). Guadeloupe and Martinique boreholes are in FR-BSS. Project level: search_gem_projects." },
  { countries: ["SV", "HN", "NI", "CR", "PA"], name: "Central American geothermal", note: "El Salvador, Honduras, Nicaragua, Costa Rica, Panama: no public geothermal well service found (Ahuachapán, Berlín, Momotombo, San Jacinto-Tizate, Miravalles are operator-held). Project level: search_gem_projects." },
  { countries: ["MX"], name: "Mexico (geothermal)", note: "CFE publishes no geothermal well data (Cerro Prieto, Los Azufres, Los Humeros). Oil & gas wells are in MX (a 2024 snapshot). The former CNH map (mapa.hidrocarburos.gob.mx) is offline." },
  { countries: ["EC"], name: "Ecuador (official)", note: "The hydrocarbon regulator's geoportal requires a login and the open-data API refuses scripts; EC is an unofficial university-hosted copy of the ministry's 2020 well list." },
  { countries: ["TT"], name: "Trinidad & Tobago", note: "The Ministry of Energy publishes PDF data-package listings for bid rounds and an ArcGIS Online map of blocks and fields, but no well layer." },
  { countries: ["CL"], name: "Chile (geothermal)", note: "No geothermal well service found (Cerro Pabellón is operator-held); open-data and ministry GIS searches return nothing." },
  { countries: ["UY", "GY", "DO", "VE", "CU", "JM"], name: "Uruguay, Guyana, Dominican Republic, Venezuela, Cuba, Jamaica", note: "No keyless official well service found: Uruguay's mining geoportal has groundwater bores only, Guyana publishes blocks and FPSO locations, the Dominican Republic a dozen historic well and seep points without ids or depths, and the others nothing machine-readable." },
  { countries: ["US"], name: "Oregon oil & gas, Maryland, Georgia, the Carolinas, New Jersey, Minnesota, Wisconsin", note: "No live well service: Oregon's oil & gas permits (Mist gas field) are a dated .xls download (OR-GEO has its geothermal wells), and the others publish PDF circulars or nothing. Their orphaned wells, if any, are in US-ORPHAN and their frac jobs in US-FRACFOCUS." },
  { countries: ["CA"], name: "Alberta (well details), PEI, Nunavut", note: "Alberta's AB source has every well's location and status but no names or licensees: AER's own map services are internal-only, and the details exist only as bulk files (ST37, 184 MB; Petrinex 'Well Licence', 18 MB zip; 'Well Infrastructure', 67 MB zip). Prince Edward Island and the Arctic islands (Nunavut) publish no well layer; the federal frontier-wells services need a token." },
  // ------------------------------------------------------------------- Europe
  { countries: ["TR"], name: "Turkey", note: "MTA's earth-science viewer exposes no data endpoint; no public well service found. Some Turkish boreholes may appear in EU-GSEU." },
  { countries: ["HU", "AT", "RO", "GR", "ES", "BG", "RS", "LT", "LV", "EE", "UA"], name: "Hungary, Austria, Romania, Greece, Spain, Bulgaria, Serbia, the Baltics, Ukraine", note: "No national keyless deep-well service found: Hungary's geothermal well cadastre server is broken, Spain's IGME layer has only names and basins, Austria publishes thermal springs and a core store, Estonia's service blocks text search, and Ukraine's well register sits behind the e-subsoil login. EU-GSEU carries deep boreholes (many geothermal, with bottom-hole temperatures) from these surveys, and EU-DARLINGE adds Hungarian, Romanian and Serbian thermal-water wells." },
  // ------------------------------------------------------------------- Africa
  { countries: ["SA", "IQ", "IR", "OM", "KW", "AE", "QA", "BH", "YE", "SY", "LB", "KZ", "MN", "CY"], name: "Gulf states, Iraq, Iran, Kazakhstan, Mongolia", note: "No public well service: the Saudi Geological Survey's data services need a token, Kazakhstan's subsoil-fund GIS is unreachable, and the national oil companies publish nothing machine-readable. Field level: search_gem_projects; heat flow: search_heat_flow." },
  { countries: ["ID"], name: "Indonesia (geothermal)", note: "The energy ministry's geoportal publishes geothermal prospects and working areas but no wells. ID-MIGAS is oil and gas." },
  { countries: ["KE"], name: "Kenya", note: "No official machine-readable registry. Petroleum exploration wells: KE-PET, an unofficial copy of the State Department for Petroleum's map. Geothermal wells (Olkaria, Menengai) are held by KenGen and GDC, whose GIS hosts are not public; some Olkaria research data is in the DOE GDR (search_geothermal_datasets); heat flow and temperature gradients across the Kenya Rift: search_heat_flow; plant level: search_gem_projects." },
  { countries: ["NA"], name: "Namibia", note: "No public well registry. The Ministry of Mines and Energy's petroleum licence layers (Landfolio cadastre) need a token, and NAMCOR sells E&P data (incl. the offshore Orange Basin discoveries). Heat flow: search_heat_flow; field level: search_gem_projects." },
  { countries: ["UG", "GH", "NG", "ET", "RW", "SN", "EG", "MA", "TN", "DZ", "LY", "MR", "CM", "GA", "CD", "BW", "ZM", "MG"], name: "Uganda, Ghana, Nigeria, Ethiopia, Egypt and the rest of Africa without a source", note: "No keyless official well service found. Uganda's (PAU) and Ghana's (GNPC) ArcGIS Online well layers answer 'Token Required' - apparently lapsed subscriptions, so they may return. Egypt's and Nigeria's data repositories need a login; Morocco, Tunisia and the others publish licences, blocks or nothing. Heat flow: search_heat_flow; field level: search_gem_projects." },
  // --------------------------------------------------------- Asia-Pacific
  { countries: ["NZ"], name: "New Zealand (national geothermal database)", note: "GNS Science's GGW database is a click-through web app whose terms allow internal use only (no publishing), so it is not used. Geothermal wells come from regional councils instead: NZ-WAIKATO and NZ-BOP. NZP&M petroleum wells are in NZ-PET." },
  { countries: ["JP"], name: "Japan", note: "Not yet supported: the Geological Survey of Japan publishes borehole temperatures (GT-4) only as static GeoJSON files; no well registry service found." },
  { countries: ["PH", "IN", "MY", "PG", "TL", "PK", "BD", "TW", "VN", "CN", "MM", "BN", "LK"], name: "Philippines, India, Malaysia, Pakistan and the rest of South and East Asia without a source", note: "No keyless well service found: India's national data repository and Pakistan's PPIS need a login, the Philippine DOE's GIS times out, Timor-Leste's data sit in a virtual data room, Taiwan's files are behind a bot block, and the others publish PDFs or nothing." },
];

/** Sources matching a key, country and/or state (all case-insensitive; omitted = any). */
export function findSources({ country, state, key } = {}) {
  const eq = (a, b) => String(a ?? "").toUpperCase() === String(b).toUpperCase();
  let list = SOURCES;
  if (key) list = list.filter((s) => eq(s.key, key));
  if (country) list = list.filter((s) => eq(s.country, country));
  if (state) list = list.filter((s) => eq(s.state, state));
  return list;
}
