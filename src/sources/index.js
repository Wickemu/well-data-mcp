// Source registry: every live well-data source, grouped by region file.
// A source is a plain object: key, country (ISO 3166-1 alpha-2), state (subdivision
// or null), label, agency, kind (provider; default "arcgis"), url, pageMax,
// idKind ("us-api" | "id"), extent ([minLon, minLat, maxLon, maxLat] or a list),
// searchFields (filter name -> source field), normalize(attrs, geometry), caveat?, license?.

import { US_SOURCES } from "./us.js";
import { BOEM_SOURCES } from "./boem.js";
import { AMERICAS_SOURCES } from "./americas.js";
import { EUROPE_SOURCES } from "./europe.js";
import { AFRICA_ASIA_SOURCES } from "./africa-asia.js";
import { OCEANIA_SOURCES } from "./oceania.js";

export { normalizeRecord, msToIso, usDateToIso, isoDate, dmyToIso, ymdToIso, namedDateToIso } from "./normalize.js";

export const SOURCES = [
  ...US_SOURCES,
  ...BOEM_SOURCES,
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
  { countries: ["DM", "KN", "MS", "LC", "GD", "VC"], name: "Eastern Caribbean geothermal islands", note: "Dominica, St Kitts & Nevis, Montserrat, St Lucia, Grenada, St Vincent: no machine-readable well data found (reports and PDF tables only; the regional CHARIM GeoNode is offline). Guadeloupe and Martinique boreholes are in FR-BSS. Project level: search_gem_projects." },
  { countries: ["SV", "HN", "NI", "CR", "PA"], name: "Central American geothermal", note: "El Salvador, Honduras, Nicaragua, Costa Rica, Panama: no public geothermal well service found (Ahuachapán, Berlín, Momotombo, San Jacinto-Tizate, Miravalles are operator-held). Project level: search_gem_projects." },
  { countries: ["MX"], name: "Mexico (geothermal)", note: "CFE publishes no geothermal well data (Cerro Prieto, Los Azufres, Los Humeros). Oil & gas wells are in MX (a 2024 snapshot). The former CNH map (mapa.hidrocarburos.gob.mx) is offline." },
  { countries: ["EC"], name: "Ecuador", note: "The hydrocarbon regulator's geoportal requires a login; well data is released only by formal request." },
  { countries: ["BO"], name: "Bolivia", note: "GeoBolivia (geo.gob.bo) is unreachable; no other official well service found." },
  { countries: ["TT"], name: "Trinidad & Tobago", note: "The Ministry of Energy publishes only PDF data-package listings for bid rounds; no well service." },
  { countries: ["CL"], name: "Chile (geothermal)", note: "No geothermal well service found (Cerro Pabellón is operator-held); open-data and ministry GIS searches return nothing." },
  { countries: ["CA"], name: "Alberta and Manitoba", note: "Not yet supported: Alberta's AER publishes its well list (ST37) only as a 565 MB monthly bulk download, and its live map layer covers abandoned wells only and blocks text search. Manitoba publishes a 0.7 MB shapefile download (wells.zip) but no working query service." },
  // ------------------------------------------------------------------- Europe
  { countries: ["TR"], name: "Turkey", note: "MTA's earth-science viewer exposes no data endpoint; no public well service found. Some Turkish boreholes may appear in EU-GSEU." },
  { countries: ["HU", "AT", "HR", "RO", "GR", "PT", "ES"], name: "Hungary, Austria, Croatia, Romania, Greece, Portugal (incl. Azores), Spain", note: "No national keyless well service found (or only names and basins, as with Spain's IGME layer). Use EU-GSEU, which carries deep boreholes - many geothermal, with bottom-hole temperatures - from these countries' surveys." },
  { countries: ["IT"], name: "Italy", note: "Not yet supported: the ministry (UNMIG) publishes producing hydrocarbon wells only as CSV/KML downloads, without dates or depths; historic wells (ViDEPI) are PDF logs. Italian deep boreholes appear in EU-GSEU." },
  { countries: ["CH"], name: "Switzerland", note: "Not yet supported: swisstopo publishes wells deeper than 500 m (incl. Basel-1 and other geothermal wells) through the geo.admin.ch API, which needs its own adapter. Swiss boreholes appear in EU-GSEU." },
  // ------------------------------------------------------------------- Africa
  { countries: ["KE"], name: "Kenya", note: "No official machine-readable registry. Petroleum exploration wells: KE-PET, an unofficial copy of the State Department for Petroleum's map. Geothermal wells (Olkaria, Menengai) are held by KenGen and GDC, whose GIS hosts are not public; some Olkaria research data is in the DOE GDR (search_geothermal_datasets); plant level: search_gem_projects." },
  { countries: ["NA"], name: "Namibia", note: "No public well registry. The Ministry of Mines and Energy's petroleum licence layers (Landfolio cadastre) need a token, and NAMCOR sells E&P data (incl. the offshore Orange Basin discoveries). Field level: search_gem_projects." },
  { countries: ["UG", "GH", "NG", "ET", "TZ", "RW", "SN", "EG"], name: "Uganda, Ghana, Nigeria, Ethiopia, Tanzania, Rwanda, Senegal, Egypt", note: "No keyless official well service found: Uganda's and Ghana's petroleum ArcGIS services require tokens, Egypt's upstream gateway requires a login, and the others publish HTML/PDF or nothing. Field level: search_gem_projects." },
  // --------------------------------------------------------- Asia-Pacific
  { countries: ["NZ"], name: "New Zealand (national geothermal database)", note: "GNS Science's GGW database is a click-through web app whose terms allow internal use only (no publishing), so it is not used. Geothermal wells come from regional councils instead: NZ-WAIKATO and NZ-BOP. NZP&M petroleum wells are in NZ-PET." },
  { countries: ["AU"], name: "Victoria, New South Wales, Northern Territory, Tasmania", note: "Not yet wired: Victoria and NSW publish petroleum wells via WFS, the NT as a CSV download, Tasmania inside a mixed borehole layer. AU-GA covers these states from the national database." },
  { countries: ["JP"], name: "Japan", note: "Not yet supported: the Geological Survey of Japan publishes borehole temperatures (GT-4) only as static GeoJSON files; no well registry service found." },
  { countries: ["PH", "IN", "MY", "PG", "TL"], name: "Philippines, India, Malaysia, Papua New Guinea, Timor-Leste", note: "No keyless well service found: India's national data repository needs a login, Timor-Leste's is a virtual data room, and the others publish PDFs or nothing." },
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
