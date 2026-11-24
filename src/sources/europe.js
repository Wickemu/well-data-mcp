// Europe, including overseas France. Every endpoint and field name below was verified
// against a live response on 2026-10-06.

import { msToIso, localMidnightToIso, isoDate, dmyToIso, namedDateToIso, num, looseNum, geomFirst } from "./normalize.js";
import { fetchJson } from "../http.js";
import { eovToWgs84 } from "../eov.js";

const nz = (v) => num(v, { zeroIsNull: true });

// Greenland (GL-GEUS): GEUS's layer of every Greenland drillhole (~4,800, mostly mineral),
// fetched whole (3.5 MB) and cut to the oil and gas ones. Filtering on the server instead
// (a FES filter on purpose_hidden) silently drops the 11 North-East Greenland cores.
const GEUS_OWS = "https://data.geus.dk/geusmap/ows/4326.jsp";
// GEUS gives the summary-sheet link with the name unencoded ('GANK#1', '79N12W/12 SC1'): encode it.
const geusSheetUrl = (report) => {
  const m = /^(.*[?&]iWellName=)(.*)$/.exec(report ?? "");
  return m ? m[1] + encodeURIComponent(m[2]) : report || null;
};
const deeperOf = (a, b) => (Math.abs(num(a) ?? 0) >= Math.abs(num(b) ?? 0) ? a : b);
/** One record per drillhole: GEUS lists a well cored in several runs once per run. */
function mergeCoreRuns(x, y) {
  const a = { ...x.attrs };
  for (const [k, v] of Object.entries(y.attrs)) if ((a[k] == null || a[k] === "") && v !== "") a[k] = v;
  const starts = [x.attrs.start_date, y.attrs.start_date].filter(Boolean).sort();
  const ends = [x.attrs.end_date, y.attrs.end_date].filter(Boolean).sort();
  a.start_date = starts[0] ?? "";
  a.end_date = ends.at(-1) ?? "";
  a.depth_to = deeperOf(x.attrs.depth_to, y.attrs.depth_to);
  return { attrs: a, geometry: x.geometry ?? y.geometry };
}
async function loadGreenlandWells() {
  const data = await fetchJson(GEUS_OWS, {
    params: { service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ms:totalcore", outputFormat: "geojson", srsName: "urn:ogc:def:crs:EPSG::4326", count: "20000" },
    timeoutMs: 60_000,
  });
  const byId = new Map();
  for (const f of data.features ?? []) {
    const a = f.properties ?? {};
    if (a.purpose_hidden !== "Oil and Gas Exploration") continue;
    const [x, y] = f.geometry?.coordinates ?? [];
    const row = { attrs: a, geometry: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null };
    const id = a.id_hidden || a.drillhole_identifer;
    byId.set(id, byId.has(id) ? mergeCoreRuns(byId.get(id), row) : row);
  }
  if (!byId.size) throw new Error("GEUS ms:totalcore: no oil and gas drillholes in the response");
  return [...byId.values()];
}

/**
 * Every feature of a geo.admin.ch (swisstopo) layer, via the identify service over the
 * whole country. Small layers only: identify pages 200 at a time and has no attribute filter.
 */
async function geoAdminLayer(layer) {
  const ch = "5.9,45.8,10.5,47.9";
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const data = await fetchJson("https://api3.geo.admin.ch/rest/services/api/MapServer/identify", {
      params: {
        geometryType: "esriGeometryEnvelope",
        geometry: ch,
        mapExtent: ch,
        imageDisplay: "1000,1000,96",
        tolerance: "0",
        layers: `all:${layer}`,
        sr: "4326",
        returnGeometry: "true",
        geometryFormat: "geojson",
        limit: "200",
        offset: String(offset),
      },
    });
    const page = data.results ?? [];
    for (const f of page) {
      const [x, y] = f.geometry?.coordinates ?? [];
      rows.push({ attrs: { ...f.properties, featureId: f.featureId }, geometry: Number.isFinite(x) ? { x, y } : null });
    }
    if (page.length < 200) return rows;
  }
}

/** swisstopo writes unknown values as '-', ' -' or 'No data' / 'no data' (numbers like '~327.5' go through looseNum). */
export const swissText = (v) => (v == null || /^\s*-?\s*$/.test(String(v)) || /^no data$/i.test(String(v).trim()) ? null : v);
// ŠGÚDŠ stores missing text as the literal string '<Null>'.
const skText = (v) => (v == null || v === "<Null>" || String(v).trim() === "" ? null : v);
// ŠGÚDŠ geothermal wells without a registration number carry 'bez RČ' ("no reg. no.") in that field.
export const skRegNo = (v) => (/^bez\s*R[ČC]\.?$/i.test(String(skText(v) ?? "").trim()) ? null : skText(v));
// GSNI drilling dates are 'ddmmyyyy' strings; ~3,500 give only 'mmyyyy' or 'yyyy'.
export const ddmmyyyy = (v) => (/^\d{8}$/.test(String(v ?? "").trim()) ? dmyToIso(`${String(v).trim().slice(0, 2)}.${String(v).trim().slice(2, 4)}.${String(v).trim().slice(4)}`) : null);
export const gsniYear = (v) => Number(/^(?:\d{2}|\d{4})?((?:1[89]|20)\d\d)$/.exec(String(v ?? "").trim())?.[1]) || null;
// NSTA writes 'No Data Available' where a value is unknown.
export const nsta = (v) => (v == null || /^no data available$/i.test(String(v).trim()) ? null : v);
// Irish well dates: long form ('Wednesday, April 25, 2001') or day first ('03/05/2006').
export const ieDate = (v) => namedDateToIso(v) ?? dmyToIso(v);
const yearOf = (...vs) => Number(vs.map((v) => /\b(1[89]|20)\d\d\b/.exec(String(v ?? ""))?.[0]).find(Boolean)) || null;

// Orkustofnun's one-letter purpose codes (idtilgangur) for the common geothermal classes.
const ICELAND_PURPOSE = {
  G: "Steam production",
  H: "Hot water production",
  N: "Reinjection",
  T: "Temperature gradient",
  R: "Power plant research",
  A: "Other",
};

// BoreholeML codelists (BGR, v2.1, 2025-04-25): drilling purpose and borehole status.
export const BGR_PURPOSE = {
  AUD: "Brownfields, environment, landfill",
  BOD: "Pedological survey", // not "soil": a filter word matches inside labels, and "oil" must not find it
  EE: "Energy resources (oil, gas, coal)",
  EM: "Ores and industrial minerals",
  G: "Geological survey",
  GC: "Geochemical survey",
  GTE: "Geotechnical investigation",
  GTH: "Geothermal energy",
  GY: "Geophysical survey",
  HY: "Hydrogeology, water management",
  RO: "Raw materials exploration and extraction",
  SE: "Aggregates and building stone",
  SO: "Other purpose",
  UG: "Underground storage",
  UN: "Unknown",
};
export const BGR_STATUS = {
  pla: "Planned",
  ag: "Filed",
  bo: "Drilled",
  bon: "Drilled, no casing", // not "not completed": "completed" must find only au
  zbo: "Drilling",
  uf: "Unfinished",
  au: "Completed (cased)",
  f: "Performance test",
  w: "Maintenance",
  r: "Regeneration",
  ti: "Deepened",
  aw: "Widened",
  ueb: "Overdrilling, reaming",
  sa: "Workover",
  rei: "Cleaned",
  an: "Casing replaced",
  atn: "Casing partly replaced",
  bin: "Well installation renewed",
  bsn: "Well chamber renewed",
  akn: "Well cap replaced",
  vw: "Abandoning",
  rb: "Being removed",
  rg: "Removed",
  rgt: "Partly removed",
  v: "Being backfilled",
  vf: "Backfilled (plugged)",
  vft: "Partly backfilled",
  ng: "Not used",
  af: "Abandoned",
  aft: "Abandoned, dry",
  afw: "Abandoned, too little water",
  afq: "Abandoned, poor water quality",
  ka: "Unknown",
};

/**
 * GEUS's geothermal layer has one row per report: merge them into one record per well,
 * keeping every report's title and link.
 */
export function geusGeothermalWells(features) {
  const by = new Map();
  for (const f of features ?? []) {
    const p = f.properties ?? {};
    const name = String(p.title ?? "").trim();
    if (!name) continue;
    let row = by.get(name);
    if (!row) {
      const [x, y] = f.geometry?.coordinates ?? [];
      row = { attrs: { name, summary_sheet: p.summary_sheet || null, reports: [] }, geometry: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null };
      by.set(name, row);
    }
    if (p.report) row.attrs.reports.push({ title: p.file_title || null, url: p.report });
  }
  return [...by.values()];
}

// HUGEO text fields write a missing value as '<Null>'.
const huText = (v) => (v == null || v === "<Null>" || String(v).trim() === "" ? null : v);

/**
 * One HUGEO thermal-well record with its position from the EOV attributes (the service
 * withholds geometry). EOVX and EOVY are swapped on some rows; EOV eastings (> 380 km) and
 * northings (< 380 km) never overlap, so the larger one is the easting.
 */
export function hugeoThermalRow(a) {
  const e = Math.max(num(a.EOVX) ?? 0, num(a.EOVY) ?? 0);
  const n = Math.min(num(a.EOVX) ?? 0, num(a.EOVY) ?? 0);
  const p = eovToWgs84(e, n);
  return { attrs: a, geometry: p.latitude == null ? null : { x: p.longitude, y: p.latitude } };
}

const HUGEO_THERMAL = "https://map.hugeo.hu/arcgis/rest/services/geoterm_en/MGT_well/MapServer";

/** Every thermal well: layers 1-4 are active, inactive, liquidated and no-information wells. */
async function loadHugeoThermal() {
  const rows = [];
  for (const layer of [1, 2, 3, 4]) {
    for (let offset = 0; ; offset += 1000) {
      const d = await fetchJson(`${HUGEO_THERMAL}/${layer}/query`, {
        params: { where: "1=1", outFields: "*", returnGeometry: "false", orderByFields: "OBJECTID", resultOffset: offset, resultRecordCount: 1000, f: "json" },
        timeoutMs: 60_000,
      });
      if (d.error) throw new Error(`ArcGIS error ${d.error.code}: ${d.error.message} (${HUGEO_THERMAL}/${layer})`);
      for (const f of d.features ?? []) rows.push(hugeoThermalRow(f.attributes ?? {}));
      if (!d.exceededTransferLimit) break;
    }
  }
  return rows;
}

const ISLAND_BOXES = {
  metropole: [-5.3, 41.3, 9.7, 51.2],
  guadeloupe: [-61.9, 15.8, -60.9, 16.6],
  martinique: [-61.3, 14.3, -60.7, 14.9],
  guyane: [-54.7, 2.1, -51.5, 5.9],
  reunion: [55.2, -21.4, 55.9, -20.8],
  mayotte: [44.9, -13.1, 45.4, -12.6],
};

export const EUROPE_SOURCES = [
  {
    key: "FR-BSS",
    country: "FR",
    state: null,
    kind: "wfs",
    dialect: "fes", // MapServer: CQL_FILTER is silently ignored
    label: "France boreholes incl. overseas departments (Guadeloupe/Bouillante, Martinique, Réunion...)",
    probe: { county: "Bouillante" },
    agency: "BRGM - Banque du Sous-Sol (BSS)",
    url: "https://geoservices.brgm.fr/geologie",
    // geoservices.brgm.fr's HTTPS front end rejects some networks outright ("Request Rejected");
    // the same MapServer answers on plain HTTP.
    fallbackUrl: "http://geoservices.brgm.fr/geologie",
    typeName: "ms:BSS_TOTAL_SANS_LABEL",
    geometryName: "msGeometry",
    pageMax: 1000,
    // MapServer sends a digit-led equality literal to PostGIS unquoted (HTTP 403 for '15/9-19 A'
    // or '1152ZZ0001/S'); a wildcard-free PropertyIsLike is the same exact match and works.
    eqAsLike: true,
    idKind: "id",
    idLabel: "BSS id (e.g. BSS002NLFW) or old BSS code (e.g. 1152ZZ0001/S)",
    // The pre-2018 BSS code (sheet + 'X' + number / designation), still quoted in French reports.
    idAlso: { field: "reference", test: /^\d{4,5}[A-Z]{1,2}\d{4}\/\S+$/i },
    wellNameAlso: "reference", // a name search also finds the old BSS code ('1152ZZ0001/S')
    extent: Object.values(ISLAND_BOXES),
    caveat:
      "A registry of every borehole (geothermal, water, mining, geotechnical...), not only deep wells. well_type matches the declared purpose ('geothermie'); county matches the commune. No operator or status fields. Each record links its InfoTerre detail sheet.",
    searchFields: {
      api: "bss_id",
      well_name: "designation",
      county: "nom_commune",
      well_type: "recherche",
    },
    normalize: (a, g) => ({
      api: a.bss_id,
      reference: a.reference,
      // nom_local and designation are often a generic letter ('S', 'S1' = sondage); the old BSS code says more.
      wellName: (a.nom_local && a.nom_local.length > 2 ? a.nom_local : null) || a.reference || a.designation || a.indice,
      operator: null,
      status: a.etat_ouvrage,
      wellType: a.recherche || a.utilisation || null,
      boreholeKind: a.nature,
      county: a.nom_commune,
      department: a.nom_departement,
      ...geomFirst(a, g, "latitude", "longitude"),
      completionDate: isoDate(a.date_realisation),
      depth: looseNum(a.prof_atteinte),
      depthUnit: "m",
      detailSheet: a.bss_id ? `http://ficheinfoterre.brgm.fr/InfoterreFiche/ficheBss.action?id=${a.bss_id}` : null,
    }),
  },
  {
    key: "NO-SODIR",
    country: "NO",
    state: null,
    label: "Norway offshore wellbores (all: exploration, development, other)",
    probe: { operator: "Equinor" },
    agency: "Sodir - Norwegian Offshore Directorate (FactMaps)",
    url: "https://factmaps.sodir.no/api/rest/services/Factmaps/FactMapsWGS84/FeatureServer/201",
    pageMax: 1000,
    idKind: "id",
    idLabel: "wellbore name (e.g. '15/9-19 A')",
    extent: [-2.0, 56.0, 38.0, 75.0],
    license: "Norwegian Licence for Open Government Data (NLOD)",
    caveat: "Synced daily. Depths in metres. Coordinates come from the geometry (the wlbNsDecDeg/wlbEwDecDeg attributes are ED50).",
    searchFields: {
      api: "wlbWellboreName",
      well_name: "wlbWellboreName", // contains-match: a well name ("30/6-C-7") finds all its wellbores
      operator: "wlbDrillingOperator",
      county: "wlbMainArea",
      field: "wlbField",
      status: "wlbStatus",
      well_type: "wlbPurpose",
    },
    normalize: (a, g) => ({
      api: a.wlbWellboreName,
      npdid: a.wlbNpdidWellbore,
      wellName: a.wlbWellboreName,
      well: a.wlbWell,
      operator: a.wlbDrillingOperator,
      status: a.wlbStatus,
      wellType: a.wlbWellType,
      purpose: a.wlbPurpose,
      content: a.wlbContent,
      field: a.wlbField,
      discovery: a.wlbDiscovery,
      county: a.wlbMainArea,
      licence: a.wlbProductionLicence,
      ...geomFirst(a, g),
      spudDate: msToIso(a.wlbEntryDate),
      completionDate: msToIso(a.wlbCompletionDate),
      depthMD: nz(a.wlbTotalDepth),
      depthTVD: nz(a.wlbFinalVerticalDepth),
      waterDepth: nz(a.wlbWaterDepth),
      bottomHoleTempC: nz(a.wlbBottomHoleTemperature),
      formationAtTd: a.wlbFormationAtTd,
      ageAtTd: a.wlbAgeAtTd || null,
      // Entry and completion dates are stored at UTC midnight; the plugged dates at Oslo midnight (22:00/23:00 UTC).
      pluggedDate: localMidnightToIso(a.wlbPluggedDate),
      pluggedAbandonedDate: localMidnightToIso(a.wlbPluggedAbandonDate),
      kbElevationM: nz(a.wlbKellyBushElevation),
      drillingFacility: a.wlbDrillingFacility || null,
      drillingFacilityType: a.wlbFacilityTypeDrilling || null,
      drillPermit: a.wlbDrillPermit || null,
      drillingDays: nz(a.wlbDrillingDays),
      factPageUrl: a.wlbFactPageUrl,
    }),
  },
  ...[
    {
      key: "GB-NSTA-OFF",
      label: "UK offshore wellbores (UKCS)",
      url: "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/arcgis/rest/services/UKCS_offshore_wellbore_top_holes_(WGS84)/FeatureServer/0",
      operatorField: "TDOPERATOR",
      probe: { operator: "Harbour" },
      extent: [-12.0, 49.0, 4.0, 62.5],
    },
    {
      key: "GB-NSTA-ON",
      label: "England onshore petroleum wells",
      url: "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/arcgis/rest/services/UKCS%20onshore%20petroleum%20wells%20top%20holes%20WGS84/FeatureServer/0",
      operatorField: "SUBAREAOP", // TDOPERATOR is mostly 'No Data Available' onshore
      probe: { operator: "Cuadrilla" },
      extent: [-6.5, 49.8, 2.0, 56.0],
      onshore: true,
    },
  ].map((v) => ({
    key: v.key,
    country: "GB",
    state: null,
    label: v.label,
    probe: v.probe,
    agency: "North Sea Transition Authority (NSTA)",
    url: v.url,
    pageMax: 1000,
    idKind: "id",
    idLabel: "well registration number (e.g. '9/13a- 20B')",
    extent: v.extent,
    license: "NSTA Open User Licence",
    caveat: "Depths in metres (TVDSS = true vertical depth sub-sea); datumElevationM is the log depth reference (datumType, usually the rotary table). Coordinates come from the geometry (TOPHOLEXDD/YDD are ED50 strings).",
    wellNameAlso: "WELLREGNO", // NAME is empty on many rows; those display the registration number
    searchFields: {
      api: "WELLREGNO",
      well_name: "NAME",
      operator: v.operatorField,
      field: "TARGETFLD",
      status: "WELLOPSTAT",
      well_type: "ORIGINTENT",
      ...(v.onshore ? { county: "ONS_COUNTY" } : {}),
    },
    normalize: (a, g) => ({
      api: a.WELLREGNO,
      wellName: a.NAME || a.WELLREGNO,
      operator: nsta(a[v.operatorField]) || nsta(a.TDOPERATOR) || null,
      status: a.WELLOPSTAT,
      completionStatus: a.COMPLESTAT,
      wellType: a.ORIGINTENT,
      currentIntent: a.CURRWELLIN,
      result: nsta(a.FLOWCLASS),
      field: nsta(a.TARGETFLD),
      licence: nsta(a.LICNO),
      ...(v.onshore ? { county: a.ONS_COUNTY, unconventionalType: a.UNCWELTYP, groundElevationM: nz(a.GRNDELEV_M) } : {}),
      ...geomFirst(a, g),
      spudDate: msToIso(a.SPUDDATE),
      tdReachedDate: msToIso(a.DATETDREAC),
      completionDate: msToIso(a.COMPLEDATE),
      datumType: nsta(a.DATUMTYPE),
      datumElevationM: nz(a.DATELEV_M),
      depthMD: nz(a.TDMDDEPM),
      depthTVDSS: nz(a.TDTVDSSM),
      waterDepth: nz(a.WATDEP_M),
      fluids: a.FLUIDTYPES,
      maxTempC: nz(a.MXTDTEMPC),
      deviation: a.DEVTYPE,
    }),
  })),
  {
    key: "GB-BGS",
    country: "GB",
    state: null,
    label: "Great Britain borehole index (all onshore drilling, incl. deep geothermal)",
    probe: { well_name: "geothermal" },
    agency: "British Geological Survey (Single Onshore Borehole Index)",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/boreholes/MapServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "BGS borehole reference (e.g. SW74SW114)",
    extent: [-8.7, 49.8, 2.0, 61.0],
    caveat: "Over a million boreholes of every kind, with no operator, status or purpose: geothermal wells are only findable by name (e.g. 'United Downs', 'Eden') or location. depth -1 means unknown.",
    searchFields: {
      api: "REFERENCE",
      well_name: "NAME",
    },
    normalize: (a, g) => ({
      api: a.REFERENCE,
      wellName: a.NAME,
      operator: null,
      status: null,
      wellType: null,
      ...geomFirst(a, g),
      depth: a.LENGTH > 0 ? a.LENGTH : null,
      depthUnit: "m",
      yearKnown: a.YEAR_KNOWN,
      gridRef: a.GRID_REF,
      scanUrl: a.SCAN_URL,
    }),
  },
  {
    key: "NL-NLOG",
    country: "NL",
    state: null,
    kind: "wfs",
    label: "Netherlands deep boreholes (oil, gas, geothermal, salt, storage; onshore and offshore)",
    probe: { operator: "Trias" },
    agency: "TNO / NLOG (Dutch Oil and Gas Portal)",
    url: "https://www.gdngeoservices.nl/geoserver/ows",
    typeName: "nlog:gdw_ng_wll_all_utm",
    geometryName: "GEOMETRY",
    sortBy: "BOREHOLE_CODE",
    pageMax: 2000,
    idKind: "id",
    idLabel: "borehole code (e.g. 'NLW-GT-01')",
    wellNameAlso: "BOREHOLE_CODE", // people type the code ('AWG-1') as often as the name ('Ameland Westgat-1')
    extent: [2.5, 50.7, 7.3, 55.9],
    caveat: "Includes ~150 geothermal wells: well_type 'geothermic' (types 'Geothermic energy exploration' and 'Development geothermic energy production'). well_name also searches the borehole code ('AWG-01'). Depths in metres along hole (MD) and true vertical (TVD) below the datum (datumType, datumElevationM above datumRelativeTo: NAP or MSL).",
    searchFields: {
      api: "BOREHOLE_CODE",
      well_name: "BOREHOLE_NAME",
      operator: "CURRENT_OWNER",
      field: "FIELD_NAME",
      status: "STATUS",
      well_type: "BOREHOLE_TYPE_DESCRIPTION",
    },
    normalize: (a, g) => ({
      api: a.BOREHOLE_CODE,
      uwi: a.UWI,
      wellName: a.BOREHOLE_NAME,
      operator: a.CURRENT_OWNER,
      originalOperator: a.ORIGINAL_OPERATOR,
      status: a.STATUS,
      wellType: a.BOREHOLE_TYPE_DESCRIPTION,
      result: a.BOREHOLE_RESULT_DESCRIPTION,
      field: a.FIELD_NAME,
      facility: a.MINING_FACILITY_NAME,
      offshore: a.ON_OFFSHORE_CODE === "OFF" ? true : a.ON_OFFSHORE_CODE === "ON" ? false : null,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: isoDate(a.START_DATE_DRILLING),
      endDrillDate: isoDate(a.END_DATE_DRILLING),
      depthMD: nz(a.END_DEPTH_MAH),
      depthTVD: nz(a.END_DEPTH_MTVD),
      formationAtTd: a.LITHOSTRAT_CODE_AT_END_DEPTH,
      datumType: a.REFERENCE_LEVEL ?? null,
      datumElevationM: num(a.REFERENCE_LEVEL_HEIGHT),
      datumRelativeTo: a.REFERENCE_LEVEL_RELATIVE_TO ?? null,
      rig: a.DRILLING_RIG_OR_PLATFORM ?? null,
      drillingContractor: a.DRILLING_COMPANY ?? null,
      detailUrl: a.URL,
    }),
  },
  {
    key: "IS-OS",
    country: "IS",
    state: null,
    kind: "wfs",
    label: "Iceland borehole registry (geothermal production, reinjection, gradient wells...)",
    probe: { field: "Hellishei" },
    agency: "Orkustofnun (National Energy Authority) via the national geoportal",
    url: "https://gis.lmi.is/geoserver/ows",
    typeName: "orkustofnun:gisborhola",
    geometryName: "geom",
    sortBy: "audkenni",
    pageMax: 2000,
    idKind: "id",
    idLabel: "Orkustofnun borehole number (audkenni)",
    extent: [-24.6, 63.2, -13.3, 66.6],
    caveat:
      "Field names are Icelandic: field = geothermal area (svaedisnafn), operator = client (verkkaupi), well_type = purpose (e.g. 'Gufu' steam, 'Heitavatn' hot water, 'Niðurdæling' reinjection). Search Icelandic text without accents where possible ('Hellishei'). Borehole names like 'HE-10' are not unique.",
    searchFields: {
      api: "audkenni",
      well_name: "borholunofn",
      operator: "verkkaupi",
      county: "heitinew",
      field: "svaedisnafn",
      well_type: "tilgangurborunar",
    },
    normalize: (a, g) => ({
      api: a.audkenni != null ? String(a.audkenni) : null,
      wellName: a.borholunofn,
      operator: a.verkkaupi,
      owner: a.eigandiholu && a.eigandiholu !== "Ekki skráð" ? a.eigandiholu : null,
      status: null,
      wellType: a.tilgangurborunar,
      purpose: ICELAND_PURPOSE[a.idtilgangur] ?? null,
      field: a.svaedisnafn,
      county: a.heitinew,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: dmyToIso(a.borun),
      depth: looseNum(a.dypi),
      depthUnit: "m",
      drillingContractor: a.eigandibors || null,
      detailUrl: a.tengill || null,
    }),
  },
  {
    key: "DE-LBEG",
    country: "DE",
    state: null,
    kind: "wfs",
    dialect: "fes", // cardo.map server
    label: "Germany deep wells (hydrocarbon, storage, salt, geothermal) - North German Basin, North Sea, Upper Rhine",
    probe: { well_name: "Bockstedt" },
    agency: "LBEG - Landesamt für Bergbau, Energie und Geologie (NIBIS)",
    url: "https://nibis.lbeg.de/net3/public/ogc.ashx?NodeId=287",
    typeName: "cls:L377",
    geometryName: "SHAPE",
    outputFormat: "application/geo+json",
    noPaging: true, // the server ignores startIndex
    fesNoEscape: true, // cardo.map: '!' escapes are taken literally and '(' is a parse error ('Bockstedt 42 (1.)')
    alsoSearch: { operator: "OPERATOR_ORIG" }, // 'Wintershall' finds the wells it drilled that Harbour now operates
    pageMax: 2000,
    idKind: "id",
    idLabel: "LBEG well identifier",
    extent: [3.9, 47.5, 15.1, 55.9],
    caveat:
      "Labels are German: status (L_STATUS) Verfüllt = plugged, Offen = open; well_type (B_ART) e.g. Erdölbohrung (oil), Gasbohrung (gas), Geothermikbohrung (geothermal); wellClass e.g. Produktionsbohrung, Aufschlussbohrung; result e.g. Ölfündig (oil found), Nicht fündig (dry). operator is today's operator (originalOperator drilled it); the operator filter matches either. Names carry the bore number ('Bockstedt 42 (1.)'). Depths in metres. Bavaria is not covered.",
    searchFields: {
      api: "IDENTIFIER",
      well_name: "LOCHNAME",
      operator: "OPERATOR_AKT",
      status: "L_STATUS",
      well_type: "B_ART",
    },
    normalize: (a, g) => ({
      api: a.IDENTIFIER,
      wellName: a.LOCHNAME,
      operator: a.OPERATOR_AKT || a.OPERATOR_ORIG || null,
      originalOperator: a.OPERATOR_ORIG || null,
      status: a.L_STATUS,
      wellType: a.B_ART,
      wellClass: a.B_KLASSE_L || null,
      result: a.G_ERGEBNIS || a.T_ERGEBNIS || null,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: dmyToIso(a.BOHRBEGINN),
      endDrillDate: dmyToIso(a.BOHRENDE),
      depthMD: nz(a.ENDTIEFE),
      depthUnit: "m",
      groundElevationM: a.A_HOEHE > -999 ? a.A_HOEHE : null, // -9999 = unknown
      waterDepth: a.WASSERTIEFE > 0 ? a.WASSERTIEFE : null,
      formationAtTd: a.ATS_E_HORI_L || a.E_HORIZONT_L || null,
      logs: a.LOG_DIGITAL || null, // digital logs held: 'Ja' / 'Nein'
      stateName: a.BUNDESLAND || null,
      shortName: a.KURZNAME || null,
    }),
  },
  {
    key: "PL-PGI",
    country: "PL",
    state: null,
    label: "Poland borehole database (all purposes, incl. geothermal)",
    probe: { well_type: "Earth's heat" },
    agency: "Polish Geological Institute (PGI-PIB, CBDG)",
    url: "https://cbdgmapa.pgi.gov.pl/arcgis/rest/services/cbdg_otwory_web/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "CBDG borehole id",
    apiNumeric: true,
    extent: [14.0, 49.0, 24.2, 55.0],
    caveat: "All boreholes (deposits, research, hydrogeology, engineering...). well_type 'Earth's heat' = geothermal. No operator or status; year only. Polish diacritics in search text may not match.",
    searchFields: {
      api: "ID_CBDG",
      well_name: "NAZWA",
      county: "WOJEWODZTWO",
      well_type: "CEL_W_EN",
    },
    normalize: (a, g) => ({
      api: a.ID_CBDG != null ? String(a.ID_CBDG) : null,
      wellName: a.NAZWA,
      operator: null,
      status: null,
      wellType: a.CEL_W_EN,
      county: a.WOJEWODZTWO,
      district: a.POWIAT,
      ...geomFirst(a, g),
      locality: a.MIEJSCOWOSC || null,
      drillYear: a.ROK || null,
      depth: nz(a.GLEBOKOSC),
      depthUnit: "m",
      elevationM: num(a.RZEDNA),
      formationAtTd: a.STRAT_EN,
    }),
  },
  ...[
    // Dates are long-form ('Wednesday, April 25, 2001') or DD/MM/YYYY, on both layers (ieDate).
    ["IE-OFF", 1, "Ireland offshore petroleum wells", { operator: "Shell" }, [-18.0, 48.0, -5.0, 57.5], "Depths in the unit given (depthUnit, usually ft); rigDatum is the rig floor height, apparently in the same unit."],
    // The onshore layer has no UNIT field; its depths are feet (Doonbeg-1 10,715).
    ["IE-ON", 2, "Ireland onshore petroleum wells", { operator: "Aran" }, [-10.7, 51.3, -5.9, 55.5], "Depths in feet."],
  ].map(([key, layer, label, probe, extent, units]) => ({
    key,
    country: "IE",
    state: null,
    label,
    probe,
    agency: "Petroleum Affairs Division (Department of the Environment, Climate and Communications)",
    url: `https://services2.arcgis.com/9g6TNz2FCkMRX6Tw/arcgis/rest/services/GSRO_Offshore_Data/FeatureServer/${layer}`,
    pageMax: 2000,
    idKind: "id",
    idLabel: "well number (e.g. '48/25-4')",
    extent,
    caveat: `Small dataset on a departmental ArcGIS Online account. ${units} completionDate is the rig release date.`,
    searchFields: {
      api: "WELL_NUM",
      well_name: "WELL_NUM",
      operator: "OPERATOR",
      status: "STATUS",
      ...(layer === 1 ? { well_type: "WELL_CLASS" } : {}),
    },
    normalize: (a, g) => ({
      api: a.WELL_NUM,
      wellName: a.WELL_NUM,
      operator: a.OPERATOR,
      status: a.STATUS,
      result: a.RESULT,
      wellType: a.WELL_CLASS ?? null,
      ...geomFirst(a, g),
      spudDate: ieDate(a.WELL_SPUD), // START_DATE is only the year's first day
      completionDate: ieDate(a.RIGRELEASE), // rig release
      rig: a.RIG_NAME || null,
      depth: nz(a.WELL_DEPTH),
      depthUnit: a.UNIT ? (/^f/i.test(a.UNIT) ? "ft" : a.UNIT) : layer === 2 ? "ft" : null,
      rigDatum: nz(a.RIG_DATUM),
      waterDepth: nz(a.WATER_DEP),
    }),
  })),
  {
    key: "DK-GEUS",
    country: "DK",
    state: null,
    kind: "wfs",
    dialect: "fes", // MapServer
    label: "Denmark released exploration wells (onshore and offshore)",
    probe: { operator: "Texaco" },
    agency: "GEUS - Geological Survey of Denmark and Greenland (Samba)",
    url: "https://data.geus.dk/geusmap/ows/4326.jsp",
    typeName: "ms:samba_petroleum_wellbores_test",
    geometryName: "msGeometry",
    pageMax: 1000,
    idKind: "id",
    idLabel: "well number (e.g. '5410/05-01')",
    extent: [3.0, 54.4, 15.3, 58.0],
    caveat: "Released exploration wells only (no development wells). Danish letters matter: 'MÆRSK' does not match 'maersk'.",
    searchFields: {
      api: "well_numb",
      well_name: "well_name",
      operator: "operator",
      well_type: "classification",
    },
    normalize: (a, g) => ({
      api: a.well_numb,
      wellName: a.well_name,
      operator: a.operator,
      status: a.content_status || null,
      wellType: a.classification,
      content: a.content,
      licence: a.licence,
      offshore: a.location === "OFFSHORE" ? true : a.location === "ONSHORE" ? false : null,
      ...geomFirst(a, g, "n_degrees", "e_degrees"),
      spudDate: isoDate(a.spud_da),
      completionDate: isoDate(a.comp_da),
      rig: a.rig || null,
      detailUrl: a.well_info,
    }),
  },
  {
    key: "DE-BGR",
    country: "DE",
    state: null,
    label: "Germany - every released borehole from the state geological surveys (incl. Bavaria, NRW, Saxony, Thuringia)",
    probe: { county: "Pullach" },
    agency: "BGR - Federal Institute for Geosciences and Natural Resources (German Borehole Locations, GBL)",
    url: "https://services.bgr.de/arcgis/rest/services/geologie/gbl/MapServer/4",
    pageMax: 2000,
    // BoreholeML codelists v2.1 (schemas.bgr.de/boreholeml/codelists/v2/*.xml), English names.
    codes: { status: BGR_STATUS, well_type: BGR_PURPOSE },
    idKind: "id",
    idLabel: "BoreholeML id (e.g. 'BIS-BY_6138BG015016')",
    extent: [5.8, 47.2, 15.1, 55.1],
    caveat:
      "3.1 million boreholes, nearly all shallow: ~30,000 are deeper than 400 m (hydrocarbon, geothermal incl. the Munich-area Molasse wells, salt and storage). For deep wells add a depth filter with raw_query (totalLength > 1000). Hessen, Rhineland-Palatinate and Saarland are not included. Bavarian boreholes are named only by BIS-BY code, so search them by place (county = municipality). wellType and status are decoded from the BoreholeML codelists (wellTypeCode / statusCode keep the code: GTH = geothermal, EE = energy resources, UG = underground storage; vf = backfilled); a filter takes the code or a word of its label ('geothermal', 'storage'). No operator. DE-LBEG has richer records for Lower Saxony, the North Sea and the Upper Rhine.",
    searchFields: { api: "gml_ID", well_name: "fullName", county: "locationName", status: "boreholeStatus", well_type: "drillingPurpose" },
    normalize: (a, g) => ({
      api: a.gml_ID,
      wellName: a.fullName || a.shortName,
      operator: null,
      status: a.boreholeStatus,
      wellType: a.drillingPurpose,
      county: a.locationName,
      stateCode: a.SGD,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: msToIso(a.drillingDate),
      depthMD: nz(a.totalLength),
      depthUnit: "m",
      elevationM: looseNum(a.surfaceLevel), // decimal comma: '598,99'
      formationAtTd: a.lastHorizon || null, // the state survey's stratigraphic code
      project: a.project,
      detailUrl: a.boreholeWebLink,
      databaseSource: a.databaseSource,
    }),
  },
  {
    key: "IT-UNMIG",
    country: "IT",
    state: null,
    label: "Italy hydrocarbon wells, onshore and offshore (ministry list, published by ISPRA)",
    probe: { well_name: "Malossa" },
    agency: "ISPRA - Servizio Geologico d'Italia (Ministry of Environment and Energy Security hydrocarbon wells, UNMIG/ViDEPI)",
    url: "https://sgi2.isprambiente.it/arcgis/rest/services/servizi/SondaggiEsplorativi/MapServer/1",
    pageMax: 1000,
    noPaging: true, // resultOffset/resultRecordCount are ignored
    nearAsEnvelope: true, // a point query's distance is ignored (ArcGIS 10.21)
    idKind: "id",
    idLabel: "well name (e.g. 'MALOSSA 001')",
    extent: [6.6, 35.4, 18.6, 47.1],
    caveat:
      "~6,900 deep wells drilled for oil and gas since the 1950s (ViDEPI). status is the outcome (Gas, Olio, Non produttivo, Indiziato...), type the purpose (Esplorativo, Sviluppo, Stratigrafico); county is onshore/offshore (Terra/Mare). Year only. Depths in metres. detailUrl opens the ViDEPI page with the well's scanned documents.",
    searchFields: { api: "Nome_pozzo", well_name: "Nome_pozzo", operator: "Operatore", status: "esito", well_type: "scopo", county: "ubicazione" },
    normalize: (a, g) => ({
      api: a.Nome_pozzo,
      wellName: a.Nome_pozzo,
      operator: a.Operatore,
      status: a.esito,
      wellType: a.scopo,
      county: a.ubicazione,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: a.Anno ?? null,
      depthMD: nz(a.Prof),
      depthUnit: "m",
      detailUrl: a.url,
    }),
  },
  {
    key: "IT-GEO",
    country: "IT",
    state: null,
    label: "Italy geothermal wells (Larderello, Amiata, Travale, Latium, Campania...)",
    probe: { field: "Larderello" },
    agency: "ISPRA - Servizio Geologico d'Italia (national geothermal well inventory)",
    url: "https://sgi2.isprambiente.it/arcgis/rest/services/servizi/SondaggiEsplorativi/MapServer/2",
    pageMax: 1000,
    noPaging: true,
    nearAsEnvelope: true,
    idKind: "id",
    idLabel: "well name (e.g. 'ABBADIA 2')",
    extent: [6.6, 35.4, 18.6, 47.1],
    caveat:
      "~940 geothermal wells, mostly ENEL's in Tuscany. field is the concession (titolo), county the province code. purposeCode and outcomeCode are the inventory's codes as published. Year only. Depths in metres.",
    searchFields: { api: "NOME_POZZO", well_name: "NOME_POZZO", operator: "OPERATORE", field: "TITOLO", county: "PR" },
    normalize: (a, g) => ({
      api: a.NOME_POZZO,
      wellName: a.NOME_POZZO,
      operator: a.OPERATORE,
      status: null,
      wellType: "Geothermal",
      purposeCode: a.SCOPO?.trim() || null,
      outcomeCode: a.ES?.trim() || null,
      field: a.TITOLO,
      county: a.PR,
      region: a.REGIONE,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: a.ANNO || null,
      depthMD: nz(a.PROFONDITA),
      depthUnit: "m",
    }),
  },
  {
    key: "CZ-CGS",
    country: "CZ",
    state: null,
    label: "Czech Republic borehole register (all purposes, incl. ~2,300 oil & gas wells)",
    probe: { well_name: "Jablunka" },
    agency: "Czech Geological Survey (ČGS) - borehole database",
    url: "https://mapy.geology.cz/arcgis/rest/services/Prozkoumanost/Vrtna_prozkoumanost/MapServer/1",
    pageMax: 3000,
    idKind: "id",
    idLabel: "ČGS borehole key (klic)",
    apiNumeric: true,
    extent: [12.0, 48.5, 18.9, 51.1],
    caveat:
      "~747,000 boreholes of every kind, mostly shallow engineering and water holes; ~5,400 are deeper than 400 m and ~2,300 were drilled for oil and gas (type 'ložiskový na ropu nebo zemní plyn'). Use raw_query for depth (hloubka > 1000). No operator, status or municipality; year only. Depths in metres. reportRefs are Geofond report numbers.",
    searchFields: { api: "klic", well_name: "puv_nazev", well_type: "ucel_obj" },
    normalize: (a, g) => ({
      api: a.klic != null ? String(a.klic) : null,
      wellName: a.puv_nazev,
      operator: null,
      status: null,
      wellType: a.ucel_obj,
      boreholeKind: a.druh_obj,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: a.rok_obj || null,
      depthMD: nz(a.hloubka),
      depthUnit: "m",
      elevationM: nz(a.z),
      rockAtTD: a.hornina,
      stratigraphyAtTD: a.strat,
      reportRefs: a.signatury,
    }),
  },
  {
    key: "SI-GEOZS",
    country: "SI",
    state: null,
    label: "Slovenia borehole register (hydrocarbon, geothermal, gas storage, hydrogeological)",
    probe: { well_type: "Geotermalna" },
    agency: "Geological Survey of Slovenia (GeoZS)",
    url: "https://gis.geo-zs.si/server/rest/services/vrtine/VRTINE/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "GeoZS borehole id",
    apiNumeric: true,
    extent: [13.3, 45.4, 16.7, 46.9],
    caveat:
      "~3,800 boreholes, ~320 deeper than 400 m (Lendava/Petišovci oil and gas, Pannonian geothermal wells). operator is the client (naročnik); contractor and investor are separate. Purpose, status and resources are in Slovenian. Depths (borehole length) in metres.",
    searchFields: { api: "id", well_name: "ime", operator: "narocnik", county: "lokalnost", status: "status", well_type: "namen" },
    normalize: (a, g) => ({
      api: a.id != null ? String(a.id) : null,
      wellName: a.ime,
      operator: a.narocnik,
      contractor: a.izvajalec,
      investor: a.investitor,
      status: a.status,
      wellType: a.namen,
      resources: a.surovine,
      county: a.lokalnost,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: msToIso(a.zacetek_vrtanja),
      endDrillDate: msToIso(a.konec_vrtanja),
      depthMD: nz(a.dolzina),
      depthUnit: "m",
      elevationM: nz(a.nmv),
    }),
  },
  {
    key: "HR-AZU-ON",
    country: "HR",
    state: null,
    label: "Croatia onshore oil, gas and geothermal wells",
    probe: { well_name: "Molve" },
    agency: "Croatian Hydrocarbon Agency (Agencija za ugljikovodike)",
    url: "https://gis.azu.hr/server/rest/services/Wells_CCS/MapServer/0",
    pageMax: 2000,
    noPaging: true, // 'Pagination is not supported'
    idKind: "id",
    idLabel: "UWI",
    apiNumeric: true,
    extent: [13.4, 42.3, 19.5, 46.6],
    caveat:
      "~730 onshore wells (Pannonian basin: Molve, Kalinovac, Žutica...). Status in Croatian: Likvidirana (abandoned), Konzervirana (suspended), Proizvodna-naftna / -plinska (producing oil / gas), Utisna (injection), Mjerna (observation), Geotermalna, Istražna (exploration). registryNumber is the national 'MB' (year-number). No operator or dates. Depths in metres.",
    searchFields: { api: "Geodb_DBO_", well_name: "Geodb_DBO1", status: "Geodb_DB_6" },
    normalize: (a, g) => ({
      api: a.Geodb_DBO_ != null ? String(a.Geodb_DBO_) : null,
      wellName: a.Geodb_DBO1,
      shortName: a.Geodb_DB_2,
      registryNumber: a.Geodb_DB_1,
      operator: null,
      status: a.Geodb_DB_6,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      depthMD: nz(a.Geodb_DB_4),
      depthUnit: "m",
      elevationM: nz(a.Geodb_DB_5),
    }),
  },
  {
    key: "HR-AZU-OFF",
    country: "HR",
    state: null,
    label: "Croatia offshore (Adriatic) wells",
    probe: { status: "Proizvodna" },
    agency: "Croatian Hydrocarbon Agency (Agencija za ugljikovodike)",
    url: "https://gis.azu.hr/server/rest/services/Wells_CCS/MapServer/1",
    pageMax: 2000,
    noPaging: true,
    idKind: "id",
    idLabel: "UWI",
    apiNumeric: true,
    extent: [12.5, 41.9, 19.5, 45.9],
    caveat: "~170 Adriatic wells. Status in Croatian (see HR-AZU-ON). No operator or dates. Depths in metres.",
    searchFields: { api: "UWI", well_name: "Naziv_buš", status: "Status" },
    normalize: (a, g) => ({
      api: a.UWI != null ? String(a.UWI) : null,
      wellName: a["Naziv_buš"],
      shortName: a.Kratica,
      registryNumber: a.MB,
      operator: null,
      status: a.Status,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      depthMD: nz(a.TD),
      depthUnit: "m",
      elevationM: num(a.Nadmorska_),
    }),
  },
  {
    key: "SK-SGUDS-GEO",
    country: "SK",
    state: null,
    label: "Slovakia geothermal wells (with wellhead temperature, yield and thermal power)",
    probe: { county: "Košice" },
    agency: "State Geological Institute of Dionýz Štúr (ŠGÚDŠ) - geothermal well register",
    url: "https://ags.geology.sk/arcgis/rest/services/WebServices/VRTY/MapServer/2",
    pageMax: 1000,
    idKind: "id",
    idLabel: "registration number (e.g. 'KO-014')",
    extent: [16.8, 47.7, 22.6, 49.7],
    license: "Free use with attribution: copyright ŠGÚDŠ",
    caveat:
      "~310 geothermal wells: wellhead temperature (deg C), yield (l/s), thermal power (MWt), mineralisation (g/l), aquifer age and lithology. status says whether the well still exists, wellType how it is used; field is the geothermal structure. ~50 wells have no registration number ('bez RČ'): api is null, find them by name. Year only. Depths in metres.",
    searchFields: {
      api: "registracnecislo",
      well_name: "technickeoznaceniezdroja",
      operator: "prevadzkovatel",
      county: "lokalita",
      status: "existenciavrtu",
      well_type: "vyuzivanie",
    },
    normalize: (a, g) => ({
      api: skRegNo(a.registracnecislo),
      wellName: skText(a.technickeoznaceniezdroja) ?? skText(a.nazovzdroja),
      operator: skText(a.prevadzkovatel),
      owner: skText(a.vlastnik),
      status: skText(a.existenciavrtu),
      wellType: skText(a.vyuzivanie),
      county: a.lokalita,
      field: skText(a.nazovutvaru), // the geothermal structure / groundwater body
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: a.rokrealizacie || null,
      depthMD: nz(a.hlbkavrtu),
      elevationM: num(a.zteren),
      openIntervalM: skText(a.otvorenyusekvrtu),
      depthUnit: "m",
      wellheadTempC: num(a.teplotanausti),
      yieldLps: num(a.vydatnost),
      thermalPowerMWt: looseNum(skText(a.tepelnyvykon)),
      mineralisationGL: num(a.mineralizacia),
      aquiferAge: skText(a.vekkolektora),
      aquiferLithology: skText(a.litologiakolektora),
    }),
  },
  {
    key: "SK-SGUDS",
    country: "SK",
    state: null,
    label: "Slovakia borehole register (exploration, hydrogeological and engineering boreholes)",
    probe: { well_type: "prieskum" },
    agency: "State Geological Institute of Dionýz Štúr (ŠGÚDŠ) - register of other boreholes",
    url: "https://ags.geology.sk/arcgis/rest/services/WebServices/VRTY/MapServer/1",
    pageMax: 1000,
    idKind: "id",
    idLabel: "borehole designation (not unique)",
    extent: [16.8, 47.7, 22.6, 49.7],
    license: "Free use with attribution: copyright ŠGÚDŠ",
    caveat:
      "~95,000 boreholes, ~3,300 deeper than 400 m; geothermal wells are in SK-SGUDS-GEO. No dates, operator or location name; archiveNumber is the Geofond report number. Use raw_query for depth (hlbkadiela > 1000). Depths in metres.",
    searchFields: { api: "oznacenievrtuvsprave", well_name: "oznacenievrtuvsprave", well_type: "ucelvrtu" },
    normalize: (a, g) => ({
      api: a.oznacenievrtuvsprave,
      wellName: a.oznacenievrtuvsprave,
      operator: null,
      status: null,
      wellType: a.ucelvrtu,
      boreholeKind: a.druhdiela,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      depthMD: nz(a.hlbkadiela),
      depthUnit: "m",
      archiveNumber: a.archivnecislo,
      notes: a.poznamka,
    }),
  },
  {
    key: "PT-LNEG",
    country: "PT",
    state: null,
    label: "Portugal deep boreholes incl. petroleum wells onshore and offshore (Sondabase)",
    probe: { well_name: "Lula" },
    agency: "LNEG - National Laboratory of Energy and Geology (Sondabase)",
    url: "https://sig.lneg.pt/server/rest/services/Sondabase/MapServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "Sondabase id",
    apiNumeric: true,
    extent: [[-10.5, 36.0, -6.1, 42.2], [-31.5, 36.8, -24.9, 39.8], [-17.4, 32.3, -16.2, 33.2]],
    caveat:
      "~3,500 boreholes held by LNEG, incl. the petroleum exploration wells onshore and offshore (Lula 1, Barreiro 1, Algarve 1...) and mineral and geothermal research holes; 3 in the Azores. No operator or status; year completed only. Depths (borehole length) in metres. detailUrl opens the Sondabase record.",
    searchFields: { api: "IDSondagem", well_name: "denominacao", county: "localidade" },
    normalize: (a, g) => ({
      api: a.IDSondagem != null ? String(a.IDSondagem) : null,
      wellName: a.denominacao,
      operator: null,
      status: null,
      county: a.localidade,
      offshore: a.offshore === "sim",
      ...geomFirst(a, g, "P", "M"),
      drillYear: a.anoFim || null,
      depthMD: nz(a.comprimento),
      depthUnit: "m",
      elevationM: num(a.cota),
      detailUrl: a.Link,
    }),
  },
  {
    key: "GB-GSNI",
    country: "GB",
    state: null,
    label: "Northern Ireland borehole index (incl. hydrocarbon and geothermal wells)",
    probe: { well_name: "Larne" },
    agency: "Geological Survey of Northern Ireland (via the British Geological Survey GeoIndex)",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_GSNI/GSNI_Enquiries/MapServer/1",
    pageMax: 2000,
    idKind: "id",
    idLabel: "GSNI borehole id (e.g. '2SW1')",
    extent: [-8.3, 53.9, -5.3, 55.4],
    caveat:
      "~24,000 boreholes, ~40 deeper than 400 m (Larne No.2 geothermal, Marathon and Aran Energy hydrocarbon wells, lignite and mineral exploration). The operator filter searches comments, which often name the operator or purpose; purposeCode is GSNI's one-letter code (H = hydrocarbon). Depths in metres.",
    searchFields: { api: "Borehole_ID", well_name: "BNAME", operator: "COMMENTS" },
    normalize: (a, g) => ({
      api: a.Borehole_ID,
      wellName: a.BNAME,
      operator: null,
      status: null,
      comments: a.COMMENTS?.trim() || null,
      purposeCode: a.PURP,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: ddmmyyyy(a.DDATE),
      drillYear: gsniYear(a.DDATE), // also for the 'mmyyyy' and 'yyyy' dates
      depthMD: nz(a.TOTDEPTH),
      depthUnit: "m",
      elevationM: num(a.ODLEV),
    }),
  },
  {
    key: "GB-BGS-HC",
    country: "GB",
    state: null,
    label: "UK onshore hydrocarbon wells incl. Scotland (BGS index)",
    probe: { operator: "Canadian Superior" },
    agency: "British Geological Survey - onshore hydrocarbon well data index",
    url: "https://map.bgs.ac.uk/arcgis/rest/services/GeoIndex_Onshore/hydrocarbon_well_data/MapServer/0",
    pageMax: 2000,
    dedupeBy: "WELL_ID", // one row per archived data item: ~4,000 rows for ~2,300 wells
    idKind: "id",
    idLabel: "well id (e.g. 'L51/26- 1')",
    extent: [-8.7, 49.8, 1.9, 60.9],
    caveat:
      "~2,300 onshore hydrocarbon wells (one row per archived data item, merged by well id) incl. ~240 in Scotland, which GB-NSTA-ON (England only) lacks. Index only: well id, name, original operator and a link to one archived data item (dataItemUrl).",
    searchFields: { api: "WELL_ID", well_name: "WELL_NAME", operator: "ORIGINAL_OPERATOR" },
    normalize: (a, g) => ({
      api: a.WELL_ID,
      wellName: a.WELL_NAME,
      operator: a.ORIGINAL_OPERATOR,
      status: null,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      dataItemUrl: a.DETAIL_URL || null,
    }),
  },
  {
    key: "BE-DOV",
    country: "BE",
    state: null,
    kind: "wfs",
    label: "Belgium (Flanders) borehole database incl. the Balmatt deep geothermal wells",
    probe: { well_name: "MOL-GT" },
    agency: "Databank Ondergrond Vlaanderen (DOV) - Flemish Government",
    url: "https://www.dov.vlaanderen.be/geoserver/wfs",
    typeName: "dov-pub:Boringen",
    geometryName: "geom",
    sortBy: "id",
    pageMax: 2000,
    idKind: "id",
    idLabel: "DOV borehole number (e.g. 'B/1-102786')",
    extent: [2.5, 50.6, 5.95, 51.55],
    caveat:
      "~188,000 boreholes in Flanders, mostly shallow; ~320 deeper than 400 m, incl. the Balmatt (Mol) geothermal wells MOL-GT-01 to -05. well_type 'Geothermie' also matches ~25,000 shallow heat-pump holes - add a depth filter with raw_query (diepte_tot_m > 1000). operator is the client (opdrachtgever); driller is separate. Wallonia is not included. Depths in metres.",
    searchFields: { api: "boornummer", well_name: "namen", operator: "opdrachtgever", county: "gemeente", well_type: "doel" },
    normalize: (a, g) => ({
      api: a.boornummer,
      wellName: a.namen,
      operator: /^onbekend$/i.test(String(a.opdrachtgever ?? "").trim()) ? null : a.opdrachtgever, // 'onbekend' = unknown
      driller: /^onbekend$/i.test(String(a.uitvoerder ?? "").trim()) ? null : a.uitvoerder,
      status: null,
      wellType: a.doel,
      method: a.methode,
      county: a.gemeente,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: isoDate(a.datum_aanvang),
      depthMD: nz(a.diepte_tot_m),
      depthUnit: "m",
      elevationM: num(a.Z_mTAW),
      detailUrl: a.fiche,
      reportUrl: a.rapport,
    }),
  },
  {
    key: "DK-DEEP",
    country: "DK",
    state: null,
    kind: "wfs",
    dialect: "fes",
    label: "Denmark deep onshore wells (GEUS Jupiter database)",
    probe: { well_name: "Thisted" },
    agency: "GEUS - Geological Survey of Denmark and Greenland (Jupiter)",
    url: "https://data.geus.dk/geusmap/ows/4326.jsp",
    typeName: "ms:deep_wells_jupiter",
    geometryName: "msGeometry",
    pageMax: 1000,
    idKind: "id",
    idLabel: "DGU number (e.g. '9.317')",
    extent: [8.0, 54.5, 15.3, 57.8],
    caveat:
      "~174 deep onshore wells drilled up to 2001 (exploration, storage, research; Thisted-2). Newer geothermal wells (Margretheholm, Sønderborg) are in DK-GEUS and DK-GEO. wellName is the location description. Year only. Depths in metres. detailUrl opens the Jupiter borehole report.",
    searchFields: { api: "dgunr", well_name: "sted", well_type: "formaal_tekst" },
    normalize: (a, g) => ({
      api: a.dgunr,
      wellName: a.sted,
      operator: null,
      status: null,
      wellType: a.formaal_tekst,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: num(a.aar_num),
      depthMD: num(a.dybde_num),
      depthUnit: "m",
      detailUrl: a.url,
    }),
  },
  {
    key: "DK-GEO",
    country: "DK",
    state: null,
    kind: "snapshot",
    via: "GEUS WFS, fetched whole",
    label: "Denmark geothermal wells and geothermal evaluations of deep wells (GEUS Samba), with their reports",
    probe: { well_name: "Thisted" },
    agency: "GEUS - Geological Survey of Denmark and Greenland (Samba)",
    url: "https://data.geus.dk/geusmap/ows/4326.jsp",
    load: async () => {
      const d = await fetchJson("https://data.geus.dk/geusmap/ows/4326.jsp", {
        params: { service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ms:samba_wells_geotermi", outputFormat: "geojson", srsName: "urn:ogc:def:crs:EPSG::4326", count: "2000" },
        timeoutMs: 60_000,
      });
      return geusGeothermalWells(d.features);
    },
    pageMax: 500,
    idKind: "id",
    idLabel: "well name (e.g. 'THISTED-3')",
    extent: [8.0, 54.5, 15.3, 57.8],
    caveat:
      "~66 wells drilled or evaluated for geothermal energy (Sønderborg-1/2, Margretheholm-1, Thisted-1 to -4, Tønder, Aars, Frederikshavn...), each with its GEUS reports (reports: title and link) and summary sheet. Name and location only. Search matches 'a' for 'å' but not 'o' for 'ø' or 'ae' for 'æ': type 'SØNDERBORG'.",
    searchFields: { api: "name", well_name: "name" },
    normalize: (a, g) => ({
      api: a.name,
      wellName: a.name,
      operator: null,
      status: null,
      wellType: "Geothermal",
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      summarySheetUrl: a.summary_sheet || null,
      reports: a.reports ?? [],
    }),
  },
  {
    key: "GL-GEUS",
    country: "GL",
    state: null,
    kind: "snapshot",
    via: "GEUS WFS (whole layer)",
    label: "Greenland petroleum wells and cores (onshore Nuussuaq, offshore West and North-East Greenland)",
    probe: { well_name: "Hellefisk" },
    agency: "GEUS - Geological Survey of Denmark and Greenland (Greenland drillhole localities)",
    url: GEUS_OWS,
    load: loadGreenlandWells,
    pageMax: 1000,
    idKind: "id",
    idLabel: "well name (e.g. 'Qulleq-1')",
    extent: [-74.0, 59.0, -10.0, 84.0],
    caveat:
      "The ~150 drillholes GEUS classes as oil and gas exploration: about 20 deep wells (Hellefisk-1, Ikermiut-1, Kangâmiut-1, Nukik-1/2, Qulleq-1, the 2010-11 Capricorn (Cairn) wells Alpha-1, AT2-1, LF7-1, T8-1..., and onshore GANE/GANK/GANT/GANW#1 and GRO 3), the rest shallow cores and seabed samples (Fylla GC98, Block 9, North-East Greenland 'SC' cores). operator is the company that drilled it. depthMD (m) is the drilled TD for wells but the core base below sea level for the shallow cores. waterDepth (m) only where GEUS records the seabed. detailUrl opens GEUS's well data summary sheet (nearly empty for the cores).",
    searchFields: { api: "drillhole_identifer", well_name: "drillhole_identifer", operator: "company_name", county: "locality" },
    normalize: (a, g) => {
      const bottom = num(a.depth_to);
      const collar = num(a.collar_altitude);
      return {
        api: a.drillhole_identifer,
        wellName: a.drillhole_identifer,
        alias: a.historic_identifier && a.historic_identifier !== a.drillhole_identifer ? a.historic_identifier : null,
        operator: a.company_name || null,
        status: null,
        wellType: a.purpose_hidden,
        county: a.locality,
        licence: a.licence_number && !/^(n\/a|unknown)$/i.test(a.licence_number) ? a.licence_number : null,
        latitude: g?.y ?? num(a.latitude),
        longitude: g?.x ?? num(a.longitude),
        spudDate: isoDate(a.start_date),
        endDrillDate: isoDate(a.end_date),
        // Wells: TD drilled below the reference point (the summary sheet's 'TD drill'); cores: core base below sea level.
        depthMD: bottom == null ? null : Math.abs(bottom),
        depthUnit: "m",
        // collar_altitude is the seabed (negative) offshore, the ground onshore; 0 means not recorded.
        waterDepth: collar < 0 ? -collar : null,
        groundElevationM: collar > 0 ? collar : null,
        detailUrl: geusSheetUrl(a.report),
      };
    },
  },
  {
    key: "EU-DARLINGE",
    country: "EU",
    state: null,
    label: "Danube-region geothermal wells (Hungary, Romania, Slovenia, Croatia, Serbia, Bosnia) - DARLINGe",
    probe: { county: "Szeged" },
    agency: "DARLINGe Interreg project (national geological surveys), hosted by the Geological Survey of Slovenia",
    url: "https://gis.geo-zs.si/server/rest/services/DARLINGe/wellsAndSpringsGDB/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "DARLINGe object id (e.g. '386_1_O')",
    wellNameAlso: "NAME_LOCAL_OBJ", // Hungarian NAME_OBJ is a registry number; the local name ('3-102') is here
    extent: [13.3, 42.5, 29.8, 48.6],
    caveat:
      "A 2017-19 snapshot of ~760 thermal-water wells and springs in the southern Pannonian basin: ~590 in Hungary, the rest in Romania, Slovenia, Croatia, Serbia and Bosnia. county filters by locality; the country is in countryName. Hungarian names are registry numbers; localName (also searched by well_name) is the local well name. Depths in metres (operationalDepthM is the screened depth).",
    searchFields: { api: "OBJ_ID", well_name: "NAME_OBJ", county: "LOCALITY_OBJ", status: "ACTIVITY_ID", well_type: "PURPOSE_ID" },
    normalize: (a, g) => ({
      api: a.OBJ_ID,
      wellName: a.NAME_OBJ || a.NAME_LOCAL_OBJ,
      operator: null,
      objectType: a.OBJ_TYPE_ID,
      status: a.ACTIVITY_ID,
      wellType: a.PURPOSE_ID,
      county: a.LOCALITY_OBJ,
      countryName: a.CNT_NAME,
      localName: a.NAME_LOCAL_OBJ || null,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      elevationM: num(a.Z_OBJ_local),
      drillYear: a.YEAR_DRILL || null,
      depthMD: nz(a.DEPTH_WELL_m),
      operationalDepthM: nz(a.DEPTH_OPERATIONAL_m),
      depthUnit: "m",
    }),
  },
  {
    key: "HU-HUGEO",
    country: "HU",
    state: null,
    label: "Hungary borehole archive (all purposes, incl. ~8,400 hydrocarbon wells and thermal-water wells)",
    probe: { well_type: "szénhidrogén" },
    agency: "Hungarian Geological Survey (HUGEO, formerly MBFSZ) - borehole archive (Adattári fúrások)",
    url: "https://map.hugeo.hu/arcgis/rest/services/furas/map_frs_adt_web_mercator/MapServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "HUGEO borehole id (FRS_ID, a number)",
    apiNumeric: true,
    extent: [16.1, 45.7, 22.9, 48.6],
    license: "No licence stated on the service (HUGEO public map service)",
    caveat:
      "~178,000 archived boreholes. well_type is the Hungarian purpose: 'szénhidrogén' = hydrocarbon (~8,400), 'hévíz' = thermal water, 'vízkutató' = water exploration, 'szénkutató' = coal, 'bauxit'... Names use the Hungarian well codes ('Baján-1', 'B-10'); county is the megye. The server matches accents exactly: type 'Algyő', not 'Algyo'. Year only, no operator or status. depthMD is in metres.",
    searchFields: {
      api: "FRS_ID",
      well_name: "JELSZAM",
      county: "MEGYE",
      well_type: "jelleg",
    },
    normalize: (a, g) => ({
      api: a.FRS_ID != null ? String(a.FRS_ID) : null,
      wellName: a.JELSZAM,
      operator: null,
      status: null,
      wellType: a.jelleg,
      county: a.MEGYE,
      settlement: a.KZG_TLP ?? a.TLP,
      settlementWhenDrilled: a.TLP,
      ...geomFirst(a, g),
      drillYear: nz(a.DATUM),
      depthMD: nz(a.MELYSEG),
      depthUnit: "m",
      elevationM: nz(a.EOV_Z),
      archiveNumber: a.dok_mafi,
      archiveRef: a.dok_egyeb,
      documentsInArchive: a.isAdattar,
      remark: a.megj_MBFH,
    }),
  },
  {
    key: "HU-HUGEO-GEO",
    country: "HU",
    state: null,
    kind: "snapshot",
    via: "ArcGIS map service, fetched whole",
    label: "Hungary thermal-water well cadastre (outflow and bottom-hole temperatures, yield, aquifer)",
    probe: { well_name: "Harkány" },
    agency: "Hungarian Geological Survey (HUGEO) - National Geothermal System (OGRe) thermal well cadastre",
    url: `${HUGEO_THERMAL}/1`,
    load: loadHugeoThermal,
    pageMax: 500,
    idKind: "id",
    idLabel: "thermal well cadastral number (e.g. '1-3') or well name",
    idAlso: { field: "MBFH" }, // the well name
    extent: [16.1, 45.7, 22.9, 48.6],
    license: "No licence stated on the service (HUGEO public map service)",
    caveat:
      "~1,800 thermal-water wells (active, inactive, liquidated) with outflow temperature, bottom-hole temperature and its depth, yield, screened interval, aquifer age and water type. Year of drilling only. Positions are converted from the EOV grid (EPSG:23700) because the service withholds geometry. Names are Hungarian ('Algyő'); this copy also matches them typed without accents.",
    searchFields: {
      api: "Heviz_kat",
      well_name: "MBFH",
      status: "statusz",
      well_type: "hasznositas_modja",
    },
    wellNameAlso: "helyi_nev",
    normalize: (a, g) => ({
      api: a.Heviz_kat,
      wellName: a.MBFH,
      localName: huText(a.helyi_nev),
      operator: null,
      status: huText(a.statusz),
      wellType: huText(a.hasznositas_modja),
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: nz(a.furas_befej_eve),
      depthMD: nz(a.talpmely),
      depthUnit: "m",
      outflowTempC: num(a.kifolyo_hom_),
      bottomHoleTempC: num(a.talpho),
      bottomHoleTempDepthM: nz(a.talpho_melyseg),
      maxYieldLpm: num(a.Q_max),
      screenTopM: num(a.szuro_teteje),
      screenBottomM: num(a.szuro_alja),
      aquiferAge: huText(a.kor_teljes),
      aquiferLithology: huText(a.szurozott_szakasz_litologia),
      waterType: huText(a.viztipus),
      tdsGpl: huText(a.tds),
      groundwaterBody: huText(a.viztest),
    }),
  },
  {
    key: "CH-SWISSTOPO",
    country: "CH",
    state: null,
    kind: "snapshot",
    via: "geo.admin.ch API",
    label: "Switzerland deep wells over 500 m (hydrocarbon, geothermal, salt, thermal water, research)",
    probe: { well_name: "Basel" },
    agency: "swisstopo - Federal Office of Topography (geo.admin.ch)",
    url: "https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.geologie-bohrungen_tiefer_500",
    load: () => geoAdminLayer("ch.swisstopo.geologie-bohrungen_tiefer_500"),
    pageMax: 500,
    idKind: "id",
    idLabel: "well name (e.g. 'Basel-1', 'St-Gallen GT-1')",
    extent: [5.9, 45.8, 10.5, 47.9],
    license: "Swiss open government data: free use, source must be cited (swisstopo)",
    caveat:
      "All ~160 Swiss wells deeper than 500 m, incl. geothermal Basel-1, St-Gallen GT-1 and Nagra research holes. operator is the client who commissioned the well (owner is the rights holder); county is the canton code (BE, VD...). Many drilling dates are given only to the month or year ('xx.05.2006') - drillYear has the year. temperature is swisstopo's text, e.g. '173.7°C @ 4600m MD'. datumElevationM is the depth reference (datumType, e.g. rotary table) in metres above sea level. About a third of the records link a swissgeol.ch borehole page (detailUrl) or reports (documentationUrl).",
    searchFields: {
      api: "name",
      well_name: "name",
      operator: "client",
      county: "canton",
      status: "status_en",
      well_type: "purpose_en",
    },
    normalize: (a, g) => ({
      api: a.name,
      wellName: a.name,
      operator: swissText(a.client),
      owner: swissText(a.owner),
      status: swissText(a.status_en),
      wellType: swissText(a.purpose_en),
      county: a.canton,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: dmyToIso(a.spud),
      endDrillDate: dmyToIso(a.end),
      drillYear: yearOf(a.spud, a.end),
      depthMD: looseNum(a.td_m_md),
      depthTVD: looseNum(a.td_m_tvd),
      depthUnit: "m",
      groundElevationM: looseNum(swissText(a.zgl)),
      datumElevationM: looseNum(swissText(a.zref)),
      datumType: swissText(a.ref_type_en),
      formationAtTD: swissText(a.fm_at_td),
      shows: swissText(a.discover_en),
      temperature: swissText(a.temp),
      reference: swissText(a.info_en),
      detailUrl: swissText(a.swissgeol),
      documentationUrl: swissText(a.web_link),
    }),
  },
  {
    key: "EU-GSEU",
    country: "EU",
    state: null,
    kind: "wfs",
    dialect: "fes", // MapServer
    label: "Pan-European deep boreholes with bottom-hole temperatures (25 national surveys)",
    probe: { operator: "Orkuveita" },
    agency: "Geological Service for Europe (GSEU) via EGDI",
    url: "https://maps.europe-geology.eu/wfs/",
    typeName: "ms:gseu_level0_boreholes",
    geometryName: "msGeometry",
    pageMax: 1000,
    idKind: "id",
    idLabel: "GSEU borehole id (e.g. 'IS_well_026')",
    extent: [-32.0, 34.0, 45.0, 72.0],
    caveat:
      "Harmonised compilation (~42k boreholes) from 25 surveys - the only keyless deep-borehole source found for Austria, Romania, Greece and Spain, and the bottom-hole temperatures for Hungary, Croatia and Portugal incl. the Azores (whose registries are HU-HUGEO, HR-AZU-* and PT-LNEG). county filters by country name. Labels are inconsistent across countries (and some characters are mangled); drill year only. bhtC = bottom-hole temperature.",
    searchFields: {
      api: "id",
      well_name: "well_name",
      operator: "company",
      county: "country",
      status: "status",
      well_type: "purpose",
    },
    normalize: (a, g) => ({
      api: a.id,
      wellName: a.well_name,
      operator: a.company,
      status: a.status,
      wellType: a.purpose,
      county: a.country,
      ...geomFirst(a, g),
      drillYear: a.drill_year,
      depthTVD: nz(a.tvd),
      bhtC: nz(a.bht),
      gradient: nz(a.gradient),
      meanSurfaceTempC: nz(a.mean_sur_t),
      tdsMgL: nz(a.geoch_tds),
      contributingSurvey: a.source,
    }),
  },
];
