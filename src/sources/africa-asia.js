// Africa, Asia and the Middle East. Every endpoint and field name below was verified against a live
// response on 2026-10-06. Apart from the Geological Survey of Japan (JP-GSJ-GT4), none of these
// agencies states a licence: query live, don't republish extracts.

import { msToIso, dmyToIso, usDateToIso, namedDateToIso, num, looseNum, geomFirst } from "./normalize.js";
import { fetchJson } from "../http.js";

const nz = (v) => num(v, { zeroIsNull: true });

// Dates some layers carry as garbage far in the future (Thailand has spud years ~6984).
const plausibleDate = (v) => {
  const d = msToIso(v);
  return d && d <= String(new Date().getFullYear() + 1) ? d : null;
};

// Tanzania mixes Excel serial dates ('27076'), DD/MM/YYYY and bare years.
const excelOrDmy = (v) => {
  const t = String(v ?? "").trim();
  if (/^\d{5}$/.test(t)) return msToIso((Number(t) - 25569) * 86_400_000);
  return dmyToIso(t);
};

/** Blank-padded text (' ') as null. */
const text = (v) => (v == null ? null : String(v).trim() || null);

// PASA keeps rig-release and final-drilling dates as 'DD/MM/YY' ('01/03/97'); a few spud dates too.
// Two-digit years up to this year's are 20xx, the rest 19xx: on 727 of 736 rows that also have a
// 4-digit spud date this lands within two years of it (the rest are typing errors either way).
export const pasaDate = (v) => {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2})\s*$/.exec(String(v ?? ""));
  if (!m) return dmyToIso(v);
  const yy = Number(m[3]);
  return dmyToIso(`${m[1]}/${m[2]}/${yy <= new Date().getUTCFullYear() % 100 ? 2000 + yy : 1900 + yy}`);
};

// Equatorial Guinea's Spud_Date mixes 'M/D/YYYY 12:00:00 AM' and 'MM/DD/YYYY 00:00' (both
// month-first: the second number runs past 12) with time-less 'DD/MM/YYYY' (mostly the Ceiba wells,
// where only the day-first reading puts each sidetrack after its parent well).
export const eqgDate = (v) => {
  const t = String(v ?? "").trim();
  return /\d:\d\d/.test(t) ? usDateToIso(t) : dmyToIso(t);
};

// ---------------------------------------------------------------- Japan GT-4
// GSJ publishes the Geothermal Potential Map's borehole temperatures as one GeoJSON file per
// depth; a borehole appears in each file it reached. Merged by ID_No into one record per borehole.
const GT4 = "https://gbank.gsj.jp/geonavi/docdata/db/GT4";
const GT4_DEPTHS = ["0500", "1000", "1500", "2000"];
// Above this a temperature at 500-2,000 m is not credible (the next-highest value in the files is ~342 °C).
const GT4_IMPLAUSIBLE_C = 400;

/** Merge GT-4's per-depth feature collections ({ '0500': fc, ... }) into one row per borehole. */
export function mergeGt4(collections) {
  const wells = new Map();
  for (const d of GT4_DEPTHS) {
    for (const f of collections[d]?.features ?? []) {
      const p = f.properties ?? {};
      if (p.ID_No == null) continue;
      let w = wells.get(p.ID_No);
      if (!w) {
        const [x, y] = f.geometry?.coordinates ?? [];
        w = { attrs: { ID_No: p.ID_No, Name: null, Refer: p.Refer, Elevation: p.Elevation }, geometry: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null };
        wells.set(p.ID_No, w);
      }
      // The source cuts some (JAEA) names mid-character, differently in each file: keep the
      // longest copy, without a trailing broken character.
      const name = String(p.Name ?? "").replace(/\uFFFD+$/, "").trim();
      if (name.length > (w.attrs.Name ?? "").length) w.attrs.Name = name;
      w.attrs[`T_${d}`] = p[`T_${d}`];
    }
  }
  return [...wells.values()];
}

async function loadGt4() {
  const collections = {};
  for (const d of GT4_DEPTHS) collections[d] = await fetchJson(`${GT4}/T_${d}_P.geojson`, { timeoutMs: 60_000 });
  return mergeGt4(collections);
}

const GT4_COMPILATION = { NEDO: "NEDO geothermal survey well", JAEA: "JAEA borehole compilation", Thermal_Gradient: "temperature-gradient compilation" };

export const AFRICA_ASIA_SOURCES = [
  {
    key: "ID-MIGAS",
    country: "ID",
    state: null,
    label: "Indonesia oil & gas wells",
    probe: { well_name: "Minas" },
    agency: "Directorate General of Oil and Gas (Ditjen Migas), Ministry of Energy and Mineral Resources - MDR",
    // Moved from /arcgis/ (502 since November 2026) to /server/; layer 0 is now a group layer.
    // The feature layer is named for its load date (UPDATE_WELL_TO_MDRE_20261030): a reload may renumber it.
    url: "https://datamigas.esdm.go.id/server/rest/services/MDR2/well/MapServer/1",
    pageMax: 1000,
    noPaging: true, // server 400s on resultOffset/resultRecordCount
    idKind: "id",
    idLabel: "UWI",
    extent: [94.0, -11.5, 141.5, 6.5],
    caveat: "No licence stated, and Ditjen Migas sells data downloads: query live, don't republish. operator is the operator's short name (BA_LN). Placeholder spud dates (00/00/0000) come back as null.",
    searchFields: {
      api: "UWI",
      well_name: "WELL_NAME",
      operator: "BA_LN",
      field: "FIELD_NAME",
      status: "STTS_TYPE",
      well_type: "WELL_CLASS",
    },
    normalize: (a, g) => ({
      api: a.UWI,
      wellName: a.WELL_NAME,
      alias: a.ALIAS_LN || null,
      operator: a.BA_LN,
      status: a.STTS_TYPE,
      wellType: a.WELL_CLASS,
      field: a.FIELD_NAME,
      workingArea: a.AREA_ID,
      environment: a.ENVRMT_TYP,
      ...geomFirst(a, g, "LAT", "LONG"),
      spudDate: dmyToIso(a.SPUD_DATE),
    }),
  },
  {
    key: "ZA-PASA",
    country: "ZA",
    state: null,
    label: "South Africa petroleum wells (mostly offshore: Bredasdorp, Orange...)",
    probe: { county: "Bredasdorp" },
    agency: "Petroleum Agency SA (PASA)",
    url: "https://geoportal.petroleumagencysa.com/arcgis/rest/services/Storefront/Quick_Find/MapServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "UWI",
    extent: [10.0, -38.0, 35.0, -22.0],
    caveat:
      "PASA's website reserves all rights: query live, don't republish. county filters by basin; field is the licence block ('Block 9'). Depths in metres. tdDate is the end of drilling.",
    searchFields: {
      api: "uwi",
      well_name: "Well_name",
      operator: "Operator",
      county: "Basin",
      field: "lease_name", // the Block column is empty on every row
      status: "crstatus",
      well_type: "Well_type",
    },
    normalize: (a, g) => ({
      api: a.uwi,
      wellName: a.Well_name,
      operator: a.Operator,
      licensee: a.Licensee,
      status: a.crstatus,
      wellType: a.Well_type,
      hydrocarbonStatus: text(a.HC_status),
      result: text(a.Final_well),
      field: text(a.lease_name) ?? text(a.Block),
      county: a.Basin,
      ...geomFirst(a, g),
      spudDate: pasaDate(a.Spud_date),
      tdDate: pasaDate(a.Fin_drillI),
      rigReleaseDate: pasaDate(a.Rigrel),
      depthMD: nz(a.Depth_md) ?? nz(a.Drillers_TD) ?? nz(a.Log_TD),
      depthTVD: nz(a.TVD),
      depthUnit: "m",
      waterDepth: nz(a.Water_dept),
      ...(nz(a.elevation) != null ? { elevationM: nz(a.elevation), elevationRef: text(a.elevation_) } : {}),
      rig: text(a.rig_name),
    }),
  },
  {
    key: "MZ-INP",
    country: "MZ",
    state: null,
    label: "Mozambique exploration & production wells",
    probe: { operator: "Sasol" },
    agency: "Instituto Nacional de Petróleo (INP)",
    url: "https://services3.arcgis.com/GwpN7CU0VUHlIXMI/arcgis/rest/services/Actividades_de_Pesquisa/FeatureServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "short well name (e.g. 'P-25')",
    extent: [30.0, -27.0, 45.0, -10.0],
    caveat: "Published from an INP staff ArcGIS Online account; no licence stated.",
    searchFields: {
      api: "Well_short",
      well_name: "Well_long",
      operator: "Long_name",
      field: "Concession",
      well_type: "Well_kind",
    },
    normalize: (a, g) => ({
      api: a.Well_short,
      wellName: a.Well_long,
      operator: a.Long_name,
      status: null,
      wellType: a.Well_kind,
      content: a.Well_conte,
      discovery: a.Discovery,
      field: a.Concession,
      ...geomFirst(a, g),
      spudDate: msToIso(a.Spud_date),
      completionDate: msToIso(a.Completion),
    }),
  },
  {
    key: "KE-PET",
    country: "KE",
    state: null,
    label: "Kenya petroleum exploration wells (unofficial copy of the ministry map)",
    probe: { well_name: "Ngamia" },
    agency: "State Department for Petroleum map, re-hosted on ArcGIS Online by a third-party account",
    url: "https://services1.arcgis.com/IQkrFigagkCSClLX/arcgis/rest/services/Kenya_Upstream_Petroleum_Exploration_Map_WFL1/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    // KEID_Wells is only the map's row number (1 = Lamu 1): the well name is the id people use.
    idLabel: "well name (e.g. 'Ngamia-1')",
    extent: [33.8, -4.8, 42.0, 5.1],
    caveat:
      "Unofficial: an ArcGIS Online copy of the State Department for Petroleum's upstream exploration map (December 2024), not published by the ministry itself; no licence stated. Exploration, appraisal and stratigraphic wells (Lokichar/Turkana, Lamu, Anza, Mandera); no geothermal wells. block is the licence block the well was drilled in. Depths in metres below rotary table; elevation is as published, with its reference (AMSL, GL or RT) where given.",
    searchFields: {
      api: "WELL_NAME",
      well_name: "WELL_NAME",
      operator: "OPERATOR",
      field: "Basin",
      status: "Well_Statu",
      well_type: "Well_Type",
    },
    normalize: (a, g) => ({
      api: a.WELL_NAME,
      mapId: a.KEID_Wells ?? null,
      wellName: a.WELL_NAME,
      operator: a.OPERATOR,
      status: a.Well_Statu,
      wellType: a.Well_Type,
      content: a.Well_Conte,
      field: a.Basin?.replace(/\s+/g, " ") ?? null,
      prospect: a.PROSPECT_N,
      block: text(a.DRILLED_IN),
      elevation: /\d/.test(a.ELEVATION ?? "") ? text(a.ELEVATION) : null,
      elevationM: looseNum(a.ELEVATION),
      ...geomFirst(a, g, "Latitude", "Longitude"),
      spudDate: msToIso(a.SPUD_DATE),
      completionDate: msToIso(a.Completion),
      depthMD: nz(a.TMD_MDRT),
      depthTVD: nz(a.TVD_TVDRT),
      waterDepth: looseNum(a.WaterDepth),
      rig: a.Rig_Name,
      comment: a.COMMENT,
    }),
  },
  // ------------------------------------------------- added 2026-10-23
  {
    key: "TH-DMF",
    country: "TH",
    state: null,
    label: "Thailand oil & gas wells, onshore and Gulf of Thailand (2003 to date)",
    probe: { operator: "Valeura" },
    agency: "Department of Mineral Fuels (DMF), Ministry of Energy, Thailand",
    url: "https://gis.dmf.go.th/arcgis/rest/services/DMF/DMF_Operation_Dashboard/MapServer/6",
    pageMax: 2000,
    dedupeBy: "WELL_NAME", // a monthly drilling log: one row per well per month while it is drilled
    orderBy: "YEAR DESC, MONTH DESC, OBJECTID DESC", // OBJECTID: some wells have two rows for one month; keeps the sort stable across pages
    idKind: "id",
    idLabel: "well name (e.g. 'Kaphong J-03')",
    extent: [97.3, 5.5, 105.7, 20.5],
    caveat:
      "DMF's monthly drilling log since 2003 (~13,700 wells, current to the latest month): one record per well, its latest month. status is the result (Oil, Gas, Dry, P&A...; drillingState is Drilling while active), type DEV / APP / EXP. field is the concession block. Depths in metres. Search Latin-script names; Thai-script values do not match. count_only counts monthly report rows, not wells.",
    searchFields: { api: "WELL_NAME", well_name: "WELL_NAME", operator: "OPERATOR", field: "BLOCK", status: "RESULT", well_type: "WELL_TYPE" },
    normalize: (a, g) => ({
      api: a.WELL_NAME,
      wellName: a.WELL_NAME,
      operator: a.OPERATOR,
      status: a.RESULT,
      drillingState: a.SYMBOL,
      wellType: a.WELL_TYPE,
      field: a.BLOCK,
      environment: a["DMFGIS.Well_NEW.AREA"] ?? a.AREA ?? null,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: plausibleDate(a.SPUD_DATE),
      tdDate: plausibleDate(a.TD_DATE),
      depthMD: nz(a.MD__M__),
      depthTVD: nz(a.TVD__M__),
      depthUnit: "m",
      rig: a.RIG,
      reportMonth: a.YEAR && a.MONTH ? `${a.YEAR - 543}-${String(a.MONTH).padStart(2, "0")}` : null,
    }),
  },
  {
    key: "IL-GII",
    country: "IL",
    state: null,
    label: "Israel oil & gas wells, onshore and offshore (2015 snapshot)",
    probe: { well_name: "Tamar" },
    agency: "Geophysical Institute of Israel - National Geophysical Data-Base",
    url: "https://services2.arcgis.com/6ByCdz8rvMt1m9hg/arcgis/rest/services/Oil_Gas_Wells_ITM_29_10_2015/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "well number",
    extent: [32.0, 29.4, 35.95, 33.4],
    caveat:
      "A snapshot of October 2015: ~550 onshore and offshore wells (Tamar, Leviathan, Heletz...). No operator or field. wellType is the database's code for target and result as published (e.g. G-GW, O-DH). Depths in metres; waterDepthM for offshore wells.",
    searchFields: { api: "WellNo", well_name: "Name", well_type: "Type" },
    normalize: (a, g) => ({
      api: a.WellNo,
      wellName: a.Name,
      operator: null,
      status: null,
      wellType: a.Type,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: msToIso(a.SpudDate),
      completionDate: msToIso(a.CompDate),
      depthMD: nz(a.TD),
      depthUnit: "m",
      waterDepthM: a.WD ? Math.abs(a.WD) : null,
      kbElevationM: nz(a.KB) ?? nz(a.RT),
      groundElevationM: nz(a.GL),
      ageAtTD: a.AgeTD,
    }),
  },
  {
    key: "JO-MEMR",
    country: "JO",
    state: null,
    label: "Jordan petroleum wells",
    probe: { county: "Risha" },
    agency: "Ministry of Energy and Mineral Resources of Jordan (petroleum opportunities map)",
    url: "https://services7.arcgis.com/NkrZE0oq3mYEhCdR/arcgis/rest/services/Petrolum_Oppotrunities_MEMR/FeatureServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "short well name (e.g. 'AD-1')",
    wellNameAlso: "short_well_name", // Full_well_name is empty on ~50 rows (all the Risha RH-* wells)
    extent: [34.9, 29.1, 39.4, 33.4],
    caveat:
      "~140 exploration and appraisal wells (CGG compilation, 2016). county is the contract area (Risha, Azraq, Sirhan...). status is the shows (Dry, Gas, Oil shows...). Operator is often blank. Depths in metres.",
    searchFields: { api: "short_well_name", well_name: "Full_well_name", operator: "Company", county: "Contract_Area", status: "SHOWS" },
    normalize: (a, g) => ({
      api: a.short_well_name,
      wellName: a.Full_well_name || a.short_well_name,
      operator: a.Company,
      status: a.SHOWS,
      hydrocarbons: a.Hydrocarbons ?? null,
      tests: a.Tests ?? null,
      county: a.Contract_Area,
      ...geomFirst(a, g, "Latitude", "Longitude"),
      spudDate: namedDateToIso(String(a.Spud_Date ?? "").replace(/(\d)(st|nd|rd|th)\b/, "$1")),
      drillYear: Number(/\b(19|20)\d\d\b/.exec(a.Spud_Date ?? "")?.[0]) || null,
      depthMD: nz(a.TD_m_MD),
      depthUnit: "m",
      kbElevationM: nz(a.RTKBM),
      groundElevationM: nz(a.GL_m),
      formationAtTD: a.Formation,
      objective: a.Objective,
    }),
  },
  {
    key: "AO-ANPG",
    country: "AO",
    state: null,
    label: "Angola oil & gas wells, onshore and offshore",
    probe: { well_name: "Dalia" },
    agency: "ANPG - Agência Nacional de Petróleo, Gás e Biocombustíveis (Angola)",
    url: "https://gis.anpg.co.ao/hosting/rest/services/Hosted/AGO_Wells/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "short name (e.g. 'CC-09')",
    extent: [8.5, -18.1, 24.1, -4.3],
    caveat:
      "~3,500 wells, onshore Kwanza and Congo basins and deepwater blocks; the newest spud dates are around 2016, so recent wells are missing. field is a coded field name (17_DALIA = Block 17, Dália), county the province. No depth or well type.",
    searchFields: { api: "short_name", well_name: "well_name", operator: "operator", county: "province", field: "field", status: "current_st" },
    normalize: (a, g) => ({
      api: a.short_name,
      wellName: a.well_name,
      operator: a.operator,
      status: a.current_st?.trim() || null,
      field: a.field,
      block: a.block,
      county: a.province,
      latitude: g?.y ?? null, // lat_dc / long_dc are swapped in the source
      longitude: g?.x ?? null,
      spudDate: msToIso(a.spud_date),
    }),
  },
  {
    key: "TZ-PURA",
    country: "TZ",
    state: null,
    label: "Tanzania petroleum wells (statutory Petroleum Activity Reference Map)",
    probe: { well_name: "Songo" },
    agency: "Petroleum Upstream Regulatory Authority (PURA), Tanzania",
    url: "https://services6.arcgis.com/8RkuyaahJfr9evxe/arcgis/rest/services/Tanzania_Petroleum_Activity_Reference_Map_WFL1/FeatureServer/4",
    pageMax: 2000,
    idKind: "id",
    idLabel: "well name",
    extent: [29.3, -11.8, 41.5, -0.9],
    caveat:
      "~90 exploration and appraisal wells onshore and offshore (Songo Songo, Mnazi Bay, the deepwater gas discoveries). county is the contract area; shows the hydrocarbons found. Operator is mostly blank. Depths in metres.",
    searchFields: { api: "NAME", well_name: "NAME", county: "CONTRACT", status: "STATUS", well_type: "WELL_TYPE" },
    normalize: (a, g) => ({
      api: a.NAME,
      wellName: a.NAME,
      operator: a.OPERATOR?.trim() || null,
      status: a.STATUS,
      wellType: a.WELL_TYPE,
      shows: a.HC_PRESENT,
      county: a.CONTRACT,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: excelOrDmy(a.SPUD_DATE),
      completionDate: excelOrDmy(a.COMPL_DATE),
      depthMD: nz(a.TD_m),
      depthUnit: "m",
      formationAtTD: a.FORMATION,
      rig: a.RIG_NAME,
    }),
  },
  {
    key: "GQ-MMH",
    country: "GQ",
    state: null,
    label: "Equatorial Guinea petroleum wells (licensing-round map)",
    probe: { well_name: "Alba" },
    agency: "Ministry of Hydrocarbons of Equatorial Guinea (EG Ronda map, hosted by Perceptum)",
    url: "https://services8.arcgis.com/P8e9VWKMOZOXB4PX/arcgis/rest/services/EG_Wells_2024/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "well name (e.g. '10A-1X')",
    extent: [5.5, -1.5, 11.4, 4.0],
    caveat:
      "~180 wells (2024 map): operator is the company that drilled; field is the basin; dataPackage names the block or field data package. spudDate is the map's Spud_Date (on ~160 wells): dates on the 1st of a month are often month-precision only, and a few disagree with drillYear (the map's Year) or with operators' announcements. Depths in metres (0 = not reported).",
    searchFields: { api: "Well_Name", well_name: "Well_Name", operator: "Drilled_by", field: "Basin", status: "Status", well_type: "Type" },
    normalize: (a, g) => ({
      api: a.Well_Name,
      wellName: a.Well_Name,
      operator: a.Drilled_by,
      status: a.Status,
      wellType: a.Type,
      result: a.Symbology,
      field: a.Basin,
      dataPackage: a.Available,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: eqgDate(a.Spud_Date),
      drillYear: Number(a.Year) || null,
      depthMD: nz(a.TD_m),
      depthTVD: nz(a.TVD_m),
      depthUnit: "m",
      kbElevationM: nz(a.KBE_m),
      waterDepthM: nz(a.Water_Depth_m),
    }),
  },
  {
    key: "SL-PDSL",
    country: "SL",
    state: null,
    label: "Sierra Leone offshore wells",
    probe: { well_name: "A-1" },
    agency: "Petroleum Directorate of Sierra Leone (PDSL) data portal",
    url: "https://services1.arcgis.com/IB7Kf2F8K18M2LKr/arcgis/rest/services/PDSL_WebPortal/FeatureServer/0",
    pageMax: 1000,
    idKind: "id",
    idLabel: "well name",
    extent: [-15.5, 5.5, -10.2, 10.0],
    caveat: "The 8 offshore wells drilled (1982-2013): name, year and result only.",
    searchFields: { api: "wellname", well_name: "wellname", status: "symbology" },
    normalize: (a, g) => ({
      api: a.wellname,
      wellName: a.wellname,
      operator: null,
      status: a.symbology,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      drillYear: a.year ?? null,
    }),
  },
  // ------------------------------------------------- added 2026-11-24
  {
    key: "JP-GSJ-GT4",
    country: "JP",
    state: null,
    kind: "snapshot",
    via: "static GeoJSON files",
    label: "Japan borehole temperatures at 500, 1,000, 1,500 and 2,000 m (GSJ Geothermal Potential Map GT-4)",
    probe: { well_type: "NEDO" },
    agency: "Geological Survey of Japan (AIST) - Digital Geoscience Map GT-4, Geothermal Potential Map of Japan (2009)",
    url: `${GT4}/T_0500_P.geojson`,
    load: loadGt4,
    ttlMs: 7 * 24 * 3600_000, // static files, unchanged since 2017
    pageMax: 500,
    idKind: "id",
    idLabel: "GT-4 point id (e.g. 'NEDO217', 'JAEA0448', 'TG0090')",
    extent: [122.9, 24.0, 146.0, 45.6],
    license: "GSJ terms of use (Government of Japan Standard Terms of Use 2.0, compatible with CC BY 4.0): cite 'Geological Survey of Japan, AIST'",
    caveat:
      "~3,000 boreholes (NEDO geothermal survey wells, JAEA and temperature-gradient compilations) with the temperature GSJ read from each at 500/1,000/1,500/2,000 m depth (°C), not drilling records: no operator, dates or total depth. Only NEDO wells have reliable names ('N58-TS-6'); JAEA names are cut short in the source files and gradient holes have none. well_type is the compilation (NEDO, JAEA, Thermal_Gradient). A temperature above 400 °C is kept as published and flagged in temperatureNote.",
    searchFields: {
      api: "ID_No",
      well_name: "Name",
      well_type: "Refer",
    },
    normalize: (a, g) => {
      const temps = { temp500mC: a.T_0500, temp1000mC: a.T_1000, temp1500mC: a.T_1500, temp2000mC: a.T_2000 };
      const odd = Object.entries(temps).filter(([, t]) => t > GT4_IMPLAUSIBLE_C);
      return {
        api: a.ID_No,
        wellName: a.Name || null,
        operator: null,
        status: null,
        wellType: a.Refer,
        compilation: GT4_COMPILATION[a.Refer] ?? a.Refer ?? null,
        latitude: g?.y ?? null,
        longitude: g?.x ?? null,
        elevationM: a.Elevation == null || a.Elevation === -999 ? null : a.Elevation,
        ...Object.fromEntries(Object.entries(temps).map(([k, t]) => [k, typeof t === "number" && t !== -999 ? t : null])),
        ...(odd.length ? { temperatureNote: `${odd.map(([k, t]) => `${k} ${t} °C`).join(", ")} is implausible at this depth, as published by GSJ` } : {}),
      };
    },
  },
];
