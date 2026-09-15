// Registry of verified state well-data sources (all ArcGIS REST layers).
// Every endpoint and field name below was verified live on 2026-08-28.
// Adding a state = adding an entry here.

// Date contract: every normalized *Date field is an ISO 'YYYY-MM-DD' string or null.
// ArcGIS date fields arrive as epoch milliseconds (msToIso); CalGEM's WellSTAR
// layers carry US-formatted strings 'MM/DD/YYYY' instead (usDateToIso).

export function msToIso(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  try {
    return new Date(n).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** 'MM/DD/YYYY' (optionally followed by a time) -> 'YYYY-MM-DD'; null-safe; other shapes pass through. */
export function usDateToIso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return msToIso(v);
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v));
  if (!m) return String(v).trim();
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function coord(attrs, key, geometry, axis) {
  const v = attrs[key];
  if (v != null && v !== 0) return v;
  return geometry ? geometry[axis] ?? null : null;
}

export const SOURCES = [
  {
    key: "CA-OG",
    state: "CA",
    label: "California oil & gas wells",
    agency: "CalGEM (WellSTAR)",
    url: "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0",
    pageMax: 5000,
    searchFields: {
      api: "API",
      well_name: "LeaseName",
      operator: "OperatorName",
      county: "CountyName",
      field: "FieldName",
      status: "WellStatus",
      well_type: "WellTypeLabel",
    },
    normalize: (a, g) => ({
      api: a.API,
      wellName: [a.LeaseName, a.WellNumber].filter(Boolean).join(" "),
      operator: a.OperatorName,
      status: a.WellStatus,
      wellType: a.WellTypeLabel ?? a.WellType,
      field: a.FieldName,
      county: a.CountyName,
      latitude: coord(a, "Latitude", g, "y"),
      longitude: coord(a, "Longitude", g, "x"),
      spudDate: usDateToIso(a.SpudDate),
      district: a.District,
      confidential: a.isConfidential,
    }),
  },
  {
    key: "CA-GEO",
    state: "CA",
    label: "California geothermal wells",
    agency: "CalGEM (WellSTAR)",
    url: "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/1",
    pageMax: 5000,
    searchFields: {
      api: "APINumber",
      well_name: "LeaseName",
      operator: "OperatorName",
      county: "CountyName",
      field: "FieldName",
      status: "WellStatusDescription",
      well_type: "WellType",
    },
    normalize: (a, g) => ({
      api: a.APINumber,
      wellName: [a.LeaseName, a.WellNumber].filter(Boolean).join(" ").trim() || a.WellDesignation,
      operator: a.OperatorName,
      status: a.WellStatusDescription ?? a.WellStatus,
      wellType: a.WellType,
      field: a.FieldName,
      county: a.CountyName,
      latitude: coord(a, "Lat83", g, "y"),
      longitude: coord(a, "Long83", g, "x"),
      // live layer types these as Integer and they are null on every row checked 2026-09-15;
      // usDateToIso handles either a US string or an epoch number if CalGEM starts filling them
      spudDate: usDateToIso(a.SpudDate),
      completionDate: usDateToIso(a.CompDate),
      abandonDate: usDateToIso(a.ABDdate),
      directional: a.Directional,
    }),
  },
  {
    key: "UT",
    state: "UT",
    label: "Utah oil & gas wells",
    agency: "Utah DOGM (via SITLA trustlands GIS)",
    caveat:
      "Oil & gas only. Utah geothermal wells (e.g. Fervo Cape Station) are regulated by the Utah Division of Water Rights, which publishes NO machine-readable well registry (historic scans only). For Cape Station project data use the search_geothermal_datasets tool (DOE GDR).",
    url: "https://gis.trustlands.utah.gov/mapping/rest/services/Energy_Wells_DOGM/FeatureServer/4",
    pageMax: 2000,
    searchFields: {
      api: "api",
      well_name: "wellname",
      operator: "operator",
      county: "county",
      field: "fieldname",
      status: "wellstatus",
      well_type: "welltype",
    },
    normalize: (a, g) => ({
      api: a.api,
      wellName: a.wellname,
      operator: a.operator,
      status: a.wellstatus,
      wellType: a.welltype,
      field: a.fieldname,
      county: a.county,
      latitude: g ? g.y ?? null : null,
      longitude: g ? g.x ?? null : null,
      spudDate: null,
      completionDate: msToIso(a.origcompld),
      abandonDate: msToIso(a.abandondat),
      cumOilBbl: a.totcum_oil,
      cumGasMcf: a.totcum_gas,
      cumWaterBbl: a.totcum_wat,
      leaseType: a.leasetype,
      unitName: a.unitname,
    }),
  },
  {
    key: "NM",
    state: "NM",
    label: "New Mexico oil & gas wells",
    agency: "NM OCD (EMNRD)",
    url: "https://gis.emnrd.nm.gov/arcgis/rest/services/OCDView/Wells_Public/FeatureServer/0",
    pageMax: 6000,
    searchFields: {
      api: "id",
      well_name: "name",
      operator: "ogrid_name",
      county: "county",
      status: "status",
      well_type: "type",
    },
    normalize: (a, g) => ({
      api: a.id,
      wellName: a.name,
      operator: a.ogrid_name,
      status: a.status,
      wellType: a.type,
      field: a.pool_id_list ?? null,
      county: a.county,
      latitude: coord(a, "latitude", g, "y"),
      longitude: coord(a, "longitude", g, "x"),
      spudDate: msToIso(a.spud_date),
      depthMD: a.measured_vertical_depth,
      depthTVD: a.true_vertical_depth,
      lastProductionDate: msToIso(a.last_production_date),
      plugDate: msToIso(a.plug_date),
      directional: a.directional_status,
    }),
  },
  {
    key: "CO",
    state: "CO",
    label: "Colorado wells (API spots)",
    agency: "Colorado ECMC (via DNR GIS)",
    // Field names re-verified against …/MapServer/0?f=json on 2026-09-15 (post ECMC cutover).
    url: "https://gisdnr.state.co.us/arcgis/rest/services/ECMC_Public/ECMC_Wells/MapServer/0",
    pageMax: 2000,
    searchFields: {
      api: "API",
      well_name: "WellName",
      operator: "Operator",
      county: "COUNTY",
      field: "field_name",
      status: "wellstat",
      well_type: "well_class",
    },
    normalize: (a, g) => ({
      api: a.API,
      wellName: a.WellName ?? a.well_name,
      operator: a.Operator,
      status: a.wellstat,
      wellType: a.well_class || null,
      field: a.field_name || a.BASIN || null,
      county: a.COUNTY ?? null,
      latitude: coord(a, "lat", g, "y"),
      longitude: coord(a, "long", g, "x"),
      spudDate: msToIso(a.spud_date),
      statusDate: msToIso(a.status_date),
      depthMD: a.max_m_depth || null,
      depthTVD: a.max_tv_depth || null,
      basin: a.BASIN ?? null,
    }),
  },
  {
    key: "ND",
    state: "ND",
    label: "North Dakota oil & gas wells",
    agency: "ND DMR Oil & Gas Division",
    url: "https://gis.dmr.nd.gov/dmrpublicservices/rest/services/OilGasPublicMapDataVectorTiles/Wells/FeatureServer/0",
    pageMax: 10000,
    searchFields: {
      api: "api_no",
      well_name: "well_name",
      operator: "operator",
      county: "County",
      field: "field_name",
      status: "status",
      well_type: "well_type",
    },
    normalize: (a, g) => ({
      api: a.api_no ?? a.api,
      wellName: a.well_name,
      operator: a.operator,
      status: a.status,
      wellType: a.well_type,
      field: a.field_name,
      county: a.County,
      latitude: coord(a, "latitude", g, "y"),
      longitude: coord(a, "longitude", g, "x"),
      spudDate: msToIso(a.spud_date),
      depthMD: a.td,
      ndicFileNo: a.fileno,
    }),
  },
  {
    key: "TX",
    state: "TX",
    label: "Texas well locations (location + API only)",
    agency: "Texas RRC public GIS",
    url: "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/1",
    pageMax: 1000,
    searchFields: {
      api: "API",
      well_name: "GIS_WELL_NUMBER",
    },
    caveat:
      "TX RRC GIS carries only API number, well number, symbol and coordinates. Operator/lease/status detail lives in RRC non-GIS systems (imaged records, PDQ dumps).",
    normalize: (a, g) => ({
      api: a.API,
      wellName: a.GIS_WELL_NUMBER,
      operator: null,
      status: null,
      wellType: a.GIS_SYMBOL_DESCRIPTION,
      field: null,
      county: null,
      latitude: coord(a, "GIS_LAT83", g, "y"),
      longitude: coord(a, "GIS_LONG83", g, "x"),
      spudDate: null,
    }),
  },
  {
    key: "NV-GEO",
    state: "NV",
    label: "Nevada geothermal wells",
    agency: "NBMG (UNR) / NGDS",
    url: "https://gisweb.unr.edu/nbmg/rest/services/MineralsAndEnergy/GeothermalWells/MapServer/0",
    pageMax: 1000,
    searchFields: {
      api: "apino",
      well_name: "wellname",
      operator: "operator_",
      county: "county",
      status: "status",
      well_type: "welltype",
    },
    normalize: (a, g) => ({
      api: a.apino,
      wellName: a.wellname,
      operator: a.operator_,
      status: a.status,
      wellType: a.welltype,
      field: null,
      county: a.county,
      latitude: coord(a, "latdegree", g, "y"),
      longitude: coord(a, "longdegree", g, "x"),
      spudDate: msToIso(a.spuddatetime),
      thermalClass: a.thermalclass,
      permitNo: a.permitno,
    }),
  },
  {
    key: "NZ-PET",
    state: "NZ",
    label: "New Zealand petroleum wells (nationwide, incl. offshore)",
    agency: "NZ Petroleum & Minerals (NZP&M)",
    url: "https://gis.nzpam.govt.nz/server/rest/services/Public/GeodataCatalogue_Layers/FeatureServer/4",
    pageMax: 2000,
    noReproject: true, // server 500s on outSR; layer has Latitude/Longitude fields
    emptyResultBug: true, // server also 500s on zero-match queries instead of returning []

    caveat:
      "Petroleum wells only. NZ geothermal wells (Taupo Volcanic Zone) are regulated regionally; GNS Science's GGW database has them but requires a signed data agreement (gns.cri.nz).",
    searchFields: {
      api: "UWI",
      well_name: "Title",
      operator: "Operator",
      field: "Prospect_Field",
      status: "Status_Public",
      well_type: "Type",
    },
    normalize: (a, g) => ({
      api: a.UWI,
      wellName: a.Title,
      alias: a.Alias || null,
      operator: a.Operator,
      status: a.Status_Public,
      wellType: a.Type,
      purpose: a.Purpose,
      field: a.Prospect_Field,
      county: null,
      latitude: coord(a, "Latitude", g, "y"),
      longitude: coord(a, "Longitude", g, "x"),
      spudDate: msToIso(a.Start_Date),
      endDate: msToIso(a.End_Date),
      depthMD: a.Total_Depth_Public,
      permit: a.Permit,
      openFile: a.Open_File,
    }),
  },
  {
    key: "GP-BSS",
    state: "GP",
    kind: "wfs-bss",
    label: "Guadeloupe / France boreholes (Banque du Sous-Sol)",
    agency: "BRGM (French geological survey)",
    url: "https://geoservices.brgm.fr/geologie (WFS, ms:BSS_TOTAL_SANS_LABEL)",
    pageMax: 500,
    // Guadeloupe bbox [minLat, minLon, maxLat, maxLon]; BSS covers all of France incl. overseas departements
    defaultBbox: [15.8, -61.95, 16.65, -60.95],
    caveat:
      "BSS is a borehole registry (all drilling: geothermal, water, exploration). No operator/status fields. Searches default to a Guadeloupe bbox; wells_near works anywhere in France incl. overseas territories. Each record links to its InfoTerre detail sheet.",
    searchFields: {
      well_name: "designation",
    },
    normalize: (a, g) => ({
      api: a.bss_id ?? a.indice,
      wellName: a.nom_local || a.designation || a.indice,
      operator: null,
      status: null,
      wellType: a.nature ?? null,
      field: null,
      county: null,
      latitude: g ? g.y ?? null : null,
      longitude: g ? g.x ?? null : null,
      spudDate: null,
      bssReference: a.reference,
      detailSheet: a.bss_id ? `https://ficheinfoterre.brgm.fr/InfoterreFiche/ficheBss.action?id=${a.bss_id}` : null,
    }),
  },
];

/**
 * Countries HWL works in that have NO public machine-readable well registry.
 * Reported via list_sources so searches there fail honestly instead of silently.
 */
export const INTERNATIONAL_NOTES = [
  { country: "Guatemala", note: "MEM (Ministerio de Energia y Minas) publishes statistics/PDFs only; no well API. Geothermal (Zunil, Amatitlan) operator data is private (Ormat). Project-level data: search_geothermal_datasets or Global Energy Monitor trackers (form-gated download)." },
  { country: "Belize", note: "Geology & Petroleum Department publishes no machine-readable well registry. O&G records (Spanish Lookout) are paper/PDF." },
  { country: "Kenya", note: "No public well registry. KenGen and GDC (Olkaria, Menengai) hold well data privately. Some Olkaria research data appears in DOE GDR and academic sources - use search_geothermal_datasets." },
  { country: "Namibia", note: "NAMCOR / Ministry of Mines and Energy publish no public well API (incl. offshore Orange Basin discoveries). Announcements only." },
  { country: "New Zealand (geothermal)", note: "GNS Science GGW database holds geothermal well data but requires a signed data agreement: gns.cri.nz/data-and-resources/gns-geothermal-and-groundwater-ggw-database. NZP&M petroleum wells are in the NZ-PET source." },
];

function trimAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

/** Normalize one ArcGIS feature via its source's field map (trims padded strings first). */
export function normalizeRecord(source, attrs, geometry) {
  return source.normalize(trimAttrs(attrs ?? {}), geometry ?? null);
}

export function findSources({ state, key } = {}) {
  let list = SOURCES;
  if (key) list = list.filter((s) => s.key.toUpperCase() === String(key).toUpperCase());
  if (state) list = list.filter((s) => s.state.toUpperCase() === String(state).toUpperCase());
  return list;
}
