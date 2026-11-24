// New Zealand and Australia. Every endpoint and field name below was verified against
// a live response on 2026-10-06.

import { msToIso, localMidnightToIso, isoDate, usDateToIso, coord, num, geomFirst } from "./normalize.js";
import { fetchJson } from "../http.js";

const nz = (v) => num(v, { zeroIsNull: true });
const AUSTRALIA = [112.0, -45.0, 155.0, -9.0];

// BOPRC stores NZ local midnight: 11:00Z (NZDT) or 12:00Z (NZST) the day before. Rounding to the
// nearest UTC midnight would send the 11:00Z ones back a day, so shift past NZ's largest offset.
export const nzLocalDate = (v) => (v == null || v === "" ? null : msToIso(Number(v) + 13 * 3_600_000));

// Waikato's database uses 1899-12-31 for "no date" (its only value before 1901).
const waikatoDate = (v) => {
  const d = msToIso(v);
  return d && d >= "1900-01-01" ? d : null;
};

// South Australia's petroleum and geothermal wells, from the SARIG map viewer's ArcGIS
// service (the drillholes WFS workspace was withdrawn in November 2026). The URL form is
// SARIG's own: /ArcGIS/SARIG/..., not /rest/services. The viewer's identify service holds
// the same layers under the same ids, as a fallback.
const SARIG = "https://map.sarig.sa.gov.au/ArcGIS/SARIG";

function sarig({ key, layer, layerName, label, probe, caveat }) {
  return {
    key,
    country: "AU",
    state: "SA",
    label,
    probe,
    layerName, // found again by name if SARIG renumbers its 600-layer service
    agency: "Government of South Australia, Department for Energy and Mining (SARIG)",
    url: `${SARIG}/sarig_map/MapServer/${layer}`,
    fallbackUrl: `${SARIG}/sarig_identify_query/MapServer/${layer}`,
    pageMax: 2000,
    idKind: "id",
    idLabel: "SARIG drillhole number",
    apiNumeric: true, // DHDB is an integer
    extent: [129.0, -38.1, 141.0, -26.0],
    license: "CC BY 4.0",
    caveat,
    searchFields: {
      api: "DHDB",
      well_name: "WELLDISPLAY",
      operator: "OPERATOR",
      county: "BASIN",
      field: "NAME",
      status: "STATUSRR",
      well_type: "TYPE",
    },
    normalize: (a, g) => ({
      // ~110 wells have no drillhole number; WELL_ID is always set.
      api: a.DHDB ? String(a.DHDB) : null,
      wellId: a.WELL_ID ?? null,
      wellName: a.WELLDISPLAY,
      operator: a.OPERATOR,
      status: a.STATUSRR,
      wellType: a.TYPE,
      wellClass: a.CLASS,
      field: a.NAME,
      county: a.BASIN,
      ...geomFirst(a, g, "Y", "X"),
      spudDate: msToIso(a.SPUDDED),
      rigReleaseDate: msToIso(a.RIGREL),
      openFileDate: msToIso(a.WHENOPEN),
      deviation: a.DEVIATION,
      depthMD: nz(a.TD),
      depthUnit: "m",
      kbElevationM: nz(a.KB),
      tenement: [a.TENEMENT, [a.TENNUM, a.TENNUM2].filter((n) => n != null).join("/")].filter(Boolean).join(" ") || null,
      access: a.SECURITY,
    }),
  };
}

// Queensland's petroleum and coal-seam-gas layers share one schema.
function queensland({ key, layer, label, probe, baseWhere, caveat }) {
  return {
    key,
    country: "AU",
    state: "QLD",
    label,
    probe,
    agency: "Geological Survey of Queensland",
    url: `https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/Boreholes/MapServer/${layer}`,
    pageMax: 2000,
    idKind: "id",
    idLabel: "GSQ borehole number",
    apiNumeric: true,
    extent: [137.9, -29.2, 153.6, -9.0],
    license: "CC BY 4.0",
    ...(baseWhere ? { baseWhere } : {}),
    caveat: caveat ?? "Updated nightly. No spud date (rigReleaseDate is the end of drilling). Depths in metres.",
    searchFields: {
      api: "bore_no",
      well_name: "bore_name",
      operator: "operator_name",
      status: "status",
      well_type: "bore_subtype",
    },
    normalize: (a, g) => ({
      api: a.bore_no != null ? String(a.bore_no) : null,
      wellName: a.bore_name,
      operator: a.operator_name,
      status: a.status,
      wellType: a.bore_subtype || a.bore_type,
      result: a.result,
      // The served geometry is snapped to a ~1/16384° grid (8-22 m off); prefer the agency's 6-decimal GDA94 attributes.
      latitude: coord(a, "latitude", g, "y"),
      longitude: coord(a, "longitude", g, "x"),
      rigReleaseDate: msToIso(a.rig_release_date),
      depthMD: nz(a.total_depth_driller) ?? nz(a.total_depth_logger),
      depthUnit: "m",
      tenure: [a.tenure_type, a.tenure_no].filter(Boolean).join(" ") || null,
      // company_report_link is always empty; the report page URL is in company_report_no.
      reportUrl: a.company_report_link || (/^https?:\/\//.test(a.company_report_no ?? "") ? a.company_report_no : null),
      dataUrl: a.qdex_data_link,
    }),
  };
}

// Victoria's DbMap uses 1899-12-30 for "no date" (real spud dates go back to 1886).
const after1900 = (v) => {
  const d = isoDate(v);
  return d && d !== "1899-12-30" ? d : null;
};

// GSNSW's drillhole layers share one schema (petroleum/CSG wells, and all drillholes).
function nswDrillholes({ key, typeName, baseCql, label, probe, caveat }) {
  return {
    key,
    country: "AU",
    state: "NSW",
    kind: "wfs",
    label,
    probe,
    agency: "Geological Survey of New South Wales",
    url: "https://public-gs.geoscience.nsw.gov.au/geoserver/ows",
    typeName,
    geometryName: "geom",
    sortBy: "gsnsw_drill_id",
    ...(baseCql ? { baseCql } : {}),
    pageMax: 2000,
    idKind: "id",
    idLabel: "GSNSW drillhole id (e.g. 'PET_000001')",
    extent: [140.9, -37.6, 153.7, -28.1],
    license: "CC BY 4.0",
    caveat,
    searchFields: {
      api: "gsnsw_drill_id",
      well_name: "hole_name",
      operator: "licence_holder",
      county: "title",
      status: "well_status",
      well_type: "business_purpose",
    },
    // The record shows operator || licence holder, so the operator filter searches both.
    alsoSearch: { operator: "operator" },
    normalize: (a, g) => ({
      api: a.gsnsw_drill_id,
      wellName: a.hole_name,
      alias: a.alternate_name,
      operator: a.operator || a.licence_holder,
      licenceHolder: a.licence_holder,
      status: a.well_status,
      wellType: a.business_purpose,
      purpose: a.hole_purpose,
      county: a.title,
      // GeoServer rounds the geometry to 4 decimals (up to ~7 m); latgda94/longda94 are full precision.
      latitude: coord(a, "latgda94", g, "y"),
      longitude: coord(a, "longda94", g, "x"),
      drillYear: a.year_drilled ?? null,
      depthMD: nz(a.end_depth),
      depthUnit: "m",
      topStratigraphy: a.top_stratigraphy,
      baseStratigraphy: a.base_stratigraphy,
    }),
  };
}

// The Northern Territory's STRIKE map serves its petroleum wells only through WMS
// GetFeatureInfo: a one-pixel request over the whole territory returns every well.
// Blank values arrive as the string 'Null'; '&' arrives escaped (sometimes twice).
const ntText = (v) => (v == null || v === "Null" ? null : String(v).replace(/&(amp;)+/g, "&"));
async function loadNorthernTerritory() {
  const data = await fetchJson("https://strike.nt.gov.au/wms", {
    params: {
      service: "WMS",
      version: "1.1.1",
      request: "GetFeatureInfo",
      layers: "Petroleum Wells",
      query_layers: "Petroleum Wells",
      styles: "",
      srs: "EPSG:4326",
      bbox: "110,-30,145,0",
      width: "1",
      height: "1",
      x: "0",
      y: "0",
      info_format: "application/geojson",
      feature_count: "100000",
      format: "image/png",
    },
    timeoutMs: 60_000,
  });
  return (data.features ?? []).map((f) => {
    const attrs = Object.fromEntries(Object.entries(f.properties ?? {}).map(([k, v]) => [k, ntText(v)]));
    const x = Number(attrs.LONGITUDE);
    const y = Number(attrs.LATITUDE);
    return { attrs, geometry: Number.isFinite(x) && Number.isFinite(y) && (x || y) ? { x, y } : null };
  });
}

export const OCEANIA_SOURCES = [
  // ------------------------------------------------------------ New Zealand
  {
    key: "NZ-PET",
    country: "NZ",
    state: null,
    label: "New Zealand petroleum wells (nationwide, incl. offshore)",
    probe: { operator: "Todd" },
    agency: "NZ Petroleum & Minerals (NZP&M)",
    url: "https://gis.nzpam.govt.nz/server/rest/services/Public/GeodataCatalogue_Layers/FeatureServer/4",
    pageMax: 2000,
    idKind: "id",
    idLabel: "UWI",
    extent: [165.0, -52.0, 179.99, -33.0],
    noReproject: true, // server 500s on outSR; layer has Latitude/Longitude fields
    emptyResultBug: true, // server also 500s on zero-match queries instead of returning []
    caveat: "Petroleum wells only. Geothermal wells: NZ-WAIKATO and NZ-BOP (regional councils).",
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
      // NZP&M stores UTC midnight plus the NZ offset (12:00/13:00Z): the UTC day is the right one.
      spudDate: msToIso(a.Start_Date),
      endDate: msToIso(a.End_Date),
      rigReleaseDate: msToIso(a.Rig_Release_Date),
      result: a.Result_Public ?? null,
      depthMD: nz(a.Total_Depth_Public),
      depthUnit: "m",
      elevationM: num(a.Elevation),
      elevationRef: num(a.Elevation) == null ? null : [a.Reference_Point, a.Datum].filter(Boolean).join(" above ") || null,
      sidetrack: a.Sidetrack && a.Sidetrack !== "0" ? a.Sidetrack : null, // '0' = the original hole
      permit: a.Permit,
      openFile: a.Open_File,
    }),
  },
  {
    key: "NZ-WAIKATO",
    country: "NZ",
    state: "WKO",
    label: "Waikato geothermal wells (Taupō Volcanic Zone, incl. deep production wells)",
    probe: { status: "Existing" },
    agency: "Waikato Regional Council (National Wells Database)",
    url: "https://services.arcgis.com/2bzQ0Ix3iO7MItUa/arcgis/rest/services/WDP_WELLS_UNIQUE/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "Waikato well identifier (e.g. '72_3342')",
    baseWhere: "GEOTHERMAL = 'Yes'",
    // Address/location-description fields hold home addresses of domestic bores: never requested.
    outFields:
      "WELL_ID,IDENTIFIER,WELL_NAME,WELL_TYPE,WELL_STATUS,DRILLING_DATE,COMPANY_NAME,ACTUAL_LATITUDE,ACTUAL_LONGITUDE,LOCATION_ACCURACY,ACTUAL_DEPTH_DRILLED,MAX_TEMPERATURE,AQUIFER_TYPE,GEOTHERMAL,HAS_GEOTHERMAL_INFLUENCE",
    extent: [174.4, -39.4, 176.9, -36.5],
    license: "CC BY 4.0 (Waikato Regional Council)",
    caveat:
      "Geothermal wells only (from shallow heating bores to deep power-station wells). Names are generic ('Bore 72 - Station 3342'), not operator well names; driller is the drilling contractor, not the operator. Depths in metres.",
    searchFields: {
      api: "IDENTIFIER",
      well_name: "WELL_NAME",
      status: "WELL_STATUS",
      well_type: "WELL_TYPE",
    },
    normalize: (a, g) => ({
      api: a.IDENTIFIER,
      wellId: a.WELL_ID,
      wellName: a.WELL_NAME,
      operator: null,
      driller: a.COMPANY_NAME,
      status: a.WELL_STATUS,
      wellType: a.WELL_TYPE,
      ...geomFirst(a, g, "ACTUAL_LATITUDE", "ACTUAL_LONGITUDE"),
      spudDate: waikatoDate(a.DRILLING_DATE),
      depthMD: nz(a.ACTUAL_DEPTH_DRILLED),
      maxTemperature: num(a.MAX_TEMPERATURE),
      aquifer: a.AQUIFER_TYPE,
    }),
  },
  {
    key: "NZ-BOP",
    country: "NZ",
    state: "BOP",
    label: "Bay of Plenty geothermal bores (Rotorua, Tauranga...)",
    probe: { field: "Rotorua" },
    agency: "Bay of Plenty Regional Council",
    url: "https://services1.arcgis.com/TWsoAGve3wb3oFHK/arcgis/rest/services/WellBoreLocations/FeatureServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "BOPRC bore reference (e.g. 'BN-1000115')",
    baseWhere: "BoreType = 'Geothermal'",
    outFields:
      "BOPRC_Ref,Status,BoreStatus,BoreUse,BoreType,GeothermalField,BoreDepth_m,CasingDepth_m,DrillingDate,BoreTemp_degC,ConsentNumber,Purpose,DataSource",
    extent: [175.8, -39.5, 178.6, -37.3],
    license: "CC BY-ND (Bay of Plenty Regional Council): query live; don't redistribute modified extracts",
    caveat: "Consented geothermal bores; the Kawerau power-station wells are largely absent. Depths in metres, temperatures in deg C.",
    searchFields: {
      api: "BOPRC_Ref",
      well_name: "BOPRC_Ref", // the bores have no other name
      field: "GeothermalField",
      status: "BoreStatus",
      well_type: "BoreUse",
    },
    normalize: (a, g) => ({
      api: a.BOPRC_Ref,
      wellName: a.BOPRC_Ref,
      operator: null,
      status: a.BoreStatus || a.Status,
      wellType: a.BoreUse,
      purpose: a.Purpose,
      field: a.GeothermalField,
      ...geomFirst(a, g),
      spudDate: nzLocalDate(a.DrillingDate),
      depthMD: nz(a.BoreDepth_m),
      depthUnit: "m",
      casingDepthM: nz(a.CasingDepth_m),
      temperatureC: num(a.BoreTemp_degC),
      consent: a.ConsentNumber,
    }),
  },

  // ---------------------------------------------------------------- Australia
  {
    key: "AU-GA",
    country: "AU",
    state: null,
    kind: "wfs",
    label: "Australia national borehole database (petroleum, coal-seam gas, geothermal, stratigraphic)",
    probe: { well_type: "geothermal" },
    agency: "Geoscience Australia",
    url: "https://services.ga.gov.au/gis/boreholes/wfs",
    typeName: "bh:Boreholes",
    geometryName: "SHAPE",
    sortBy: "ENO",
    pageMax: 2000,
    idKind: "id",
    idLabel: "GA borehole number (ENO)",
    extent: AUSTRALIA,
    license: "CC BY 4.0",
    caveat:
      "National compilation (~52k boreholes, onshore and offshore). State sources (AU-SA-*, AU-QLD-*, AU-WA) are fresher and richer for their states. field filters by basin / geological province (basin). Lengths in metres; elevationM is negative offshore (the seabed). reportUrl opens GA's borehole page.",
    searchFields: {
      api: "ENO",
      well_name: "NAME",
      operator: "OPERATOR",
      field: "GEOLOGICAL_PROVINCES",
      status: "STATUS",
      well_type: "PURPOSE",
    },
    normalize: (a, g) => ({
      api: a.ENO != null ? String(a.ENO) : null,
      wellName: a.NAME,
      operator: a.OPERATOR,
      status: a.STATUS,
      wellType: a.PURPOSE,
      ...geomFirst(a, g, "COLLAR_LAT_GDA94", "COLLAR_LONG_GDA94"),
      alias: a.ALTERNATE_NAMES && a.ALTERNATE_NAMES !== a.NAME ? a.ALTERNATE_NAMES : null,
      stateCode: a.STATE ?? null,
      basin: a.GEOLOGICAL_PROVINCES ?? null,
      spudDate: isoDate(a.DRILLSTARTDATE),
      endDrillDate: isoDate(a.DRILLENDDATE),
      rigReleaseDate: isoDate(a.RIG_RELEASE_DATE),
      depthMD: nz(a.BOREHOLELENGTH_M),
      depthUnit: "m",
      elevationM: num(a.ELEVATION_M),
      rig: a.RIG_NAME && a.RIG_NAME !== "Unknown" ? a.RIG_NAME : null,
      reportUrl: a.BOREHOLE_REPORT_URI ?? null,
      startPoint: a.STARTPOINT,
      custodian: a.DATA_CUSTODIAN,
      uri: a.IDENTIFIER,
    }),
  },
  sarig({
    key: "AU-SA-PET",
    layer: 69,
    layerName: "Petroleum Wells",
    label: "South Australia petroleum wells (Cooper/Eromanga...)",
    probe: { operator: "Delhi" },
    caveat: "Depths in metres. field is the field/prospect name. About 110 wells have no drillhole number (id is null; find them by well_name): nearly all are confidential wells, which also show no spud date or status.",
  }),
  sarig({
    key: "AU-SA-GEO",
    layer: 58,
    layerName: "Geothermal Wells",
    label: "South Australia geothermal wells (incl. Habanero)",
    probe: { well_name: "Habanero" },
    caveat: "Hot-rock and hot-sedimentary-aquifer geothermal wells. Depths in metres.",
  }),
  queensland({
    key: "AU-QLD-PET",
    layer: 8,
    label: "Queensland petroleum wells",
    probe: { operator: "Santos" },
  }),
  queensland({
    key: "AU-QLD-CSG",
    layer: 1,
    label: "Queensland coal-seam-gas wells",
    probe: { well_name: "Broadmeadow" },
  }),
  queensland({
    key: "AU-QLD-GEO",
    layer: 9,
    label: "Queensland geothermal heat-flow bores",
    probe: { well_name: "Georgetown" },
    baseWhere: "bore_subtype = 'GEOTHERMAL HEAT FLOW BORE'",
    caveat: "The Geological Survey of Queensland's heat-flow bores (2010-2011, 70-320 m deep), from its stratigraphic-bores layer. Depths in metres.",
  }),
  {
    key: "AU-VIC",
    country: "AU",
    state: "VIC",
    kind: "wfs",
    label: "Victoria petroleum and geothermal wells (onshore and offshore: Gippsland, Otway, Bass)",
    probe: { operator: "Esso" },
    agency: "Geological Survey of Victoria (DbMap petroleum well database), Department of Energy, Environment and Climate Action",
    url: "https://opendata.maps.vic.gov.au/geoserver/wfs",
    typeName: "open-data-platform:pet_wells",
    geometryName: "geom",
    sortBy: "uwi",
    pageMax: 2000,
    idKind: "id",
    idLabel: "UWI",
    extent: [[140.9, -39.9, 150.1, -33.9], [143.0, -41.5, 149.0, -38.0]],
    license: "CC BY 4.0",
    caveat:
      "~1,600 wells, actively maintained, incl. Gippsland and Otway offshore and ~40 geothermal wells (type GT_WILDCAT); a few Bass Strait wells off SA, Tasmania and NSW too. status codes: P&A, PRODUCER, SUS...; type codes: D_HC_PROD, E_WILDCAT, E_APPRAISAL, GT_WILDCAT... field is the basin, county the title (lease). Depths in metres.",
    wellNumberField: "well_number", // "BARRACOUTA" + "A10"
    searchFields: {
      api: "uwi",
      well_name: "well_name",
      operator: "operator",
      county: "lease_name",
      field: "basin",
      status: "current_status",
      well_type: "current_class",
    },
    normalize: (a, g) => ({
      api: a.uwi,
      wellName: [a.well_name, a.well_number].filter(Boolean).join(" ") || null,
      operator: a.operator,
      status: a.current_status,
      wellType: a.current_class,
      result: a.symbol_desc,
      field: a.basin,
      county: a.lease_name,
      onshore: a.onshore_ind === "Y",
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: after1900(a.spud_date),
      rigReleaseDate: after1900(a.rig_release_date),
      depthMD: nz(a.drill_td) ?? nz(a.final_td),
      depthTVD: nz(a.max_tvd),
      depthUnit: "m",
      kbElevationM: nz(a.kb_elev),
      waterDepthM: nz(a.abswaterdepth),
    }),
  },
  nswDrillholes({
    key: "AU-NSW",
    typeName: "drilling:drilling_drillholes_petroleum",
    label: "New South Wales petroleum and coal-seam-gas wells",
    probe: { operator: "Santos" },
    caveat:
      "~1,200 wells: ~900 coal-seam methane wells and the conventional petroleum and stratigraphic wells. operator is the licence holder where no operator is recorded; the operator filter matches either. Year drilled only (no spud date). county is the petroleum title. Depths in metres.",
  }),
  nswDrillholes({
    key: "AU-NSW-GEO",
    typeName: "drilling:drilling_drillholes",
    baseCql: "project = 'GTHM'",
    label: "New South Wales geothermal drillholes",
    probe: { well_name: "Geothermal" },
    caveat: "The ~20 geothermal exploration holes (Bulga, Bulli...) in GSNSW's drillhole database. Year drilled only. Depths in metres.",
  }),
  {
    key: "AU-NT",
    country: "AU",
    state: "NT",
    kind: "snapshot",
    via: "STRIKE WMS (whole layer)",
    label: "Northern Territory petroleum wells (Amadeus, Beetaloo, McArthur, Georgina...)",
    probe: { operator: "Santos" },
    agency: "Northern Territory Geological Survey (STRIKE)",
    url: "https://strike.nt.gov.au/wms",
    load: loadNorthernTerritory,
    pageMax: 1000,
    idKind: "id",
    idLabel: "well name (e.g. 'Shenandoah 1')",
    extent: [128.9, -26.1, 138.1, -10.9],
    license: "CC BY 4.0",
    caveat:
      "All ~300 petroleum wells, current (2026 spuds included). type is the purpose (Exploration, Development, Appraisal), field the basin, county the title. depthMD is the measured total depth (m). eno is Geoscience Australia's number (AU-GA). reportSearchUrl searches the well's reports in GEMIS.",
    searchFields: {
      api: "WELLNAME",
      well_name: "WELLNAME",
      operator: "OPERATOR",
      county: "TITLE_ID",
      field: "BASIN",
      status: "STATUS",
      well_type: "PURPOSE",
    },
    normalize: (a, g) => ({
      api: a.WELLNAME,
      eno: a.ENO && a.ENO !== "0" ? a.ENO : null, // '0' on ~100 wells GA has not numbered
      wellName: a.WELLNAME,
      alias: a.WELL_ALIAS,
      operator: a.OPERATOR,
      status: a.STATUS,
      wellType: a.PURPOSE,
      classification: a.CLASS_POST,
      shows: a.HCSHOWS,
      field: a.BASIN,
      county: a.TITLE_ID,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      spudDate: usDateToIso(a.DT_SPUD),
      tdDate: usDateToIso(a.DT_DEPTH),
      rigReleaseDate: usDateToIso(a.DT_RELEASE),
      depthMD: nz(a.TOTAL_MEAS), // TOTAL_DEPTH is not a TVD (it can exceed the measured depth)
      depthUnit: "m",
      elevationM: nz(a.ELEVATION),
      elevationRef: nz(a.ELEVATION) == null || !a.DATUM_MEAS || a.DATUM_MEAS === "NR" ? null : a.DATUM_MEAS,
      rig: a.DRILLRIG ?? null,
      rigContractor: a.CONTRACTOR ?? null,
      reportSearchUrl: a.HANDLE_URL,
    }),
  },
  {
    key: "AU-TAS",
    country: "AU",
    state: "TAS",
    label: "Tasmania fuel (petroleum, coal, oil shale) and geothermal boreholes",
    probe: { operator: "Esso" },
    agency: "Mineral Resources Tasmania",
    url: "https://data.stategrowth.tas.gov.au/ags/rest/services/MRT/Boreholes_and_Traces/MapServer/0",
    baseWhere: "PURPOSE LIKE '%Fuels%' OR PURPOSE LIKE '%Geothermal%'",
    pageMax: 2000,
    idKind: "id",
    idLabel: "MRT drill id",
    apiNumeric: true,
    extent: [[143.5, -44.0, 148.6, -39.4], [143.0, -41.5, 149.0, -38.0]],
    license: "CC BY 4.0 (Mineral Resources Tasmania)",
    caveat:
      "The ~1,700 boreholes MRT classes as fuels (coal, oil shale and petroleum, incl. the Bass and Sorell offshore wells - the ~50 deeper than 1,000 m are essentially the petroleum wells) or geothermal (~45). operator is the drilling company; county searches the locality keywords. No status. spudDate only where MRT dates the hole to the day (dateAccuracy Day); otherwise drillYear, and MRT's undated holes carry a nominal early-January date. For the Bass and Sorell offshore wells, AU-OFF and AU-GA hold the spud date. Depths (hole length) in metres. detailUrl opens MRT's drilling record.",
    searchFields: { api: "DRILL_ID", well_name: "NAME", operator: "COMPANY", county: "KEYWORDS", well_type: "PURPOSE" },
    normalize: (a, g) => ({
      api: a.DRILL_ID != null ? String(a.DRILL_ID) : null,
      wellName: a.NAME,
      operator: a.COMPANY,
      status: null,
      wellType: a.PURPOSE,
      drillType: a.DRILL_TYPE,
      county: a.KEYWORDS?.trim() || null,
      tenements: a.ASSOCIATED_TENEMENTS,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      ...(() => {
        // MRT stores Hobart local midnight (13:00/14:00Z the day before; 14:10:44Z, local mean time, before 1895).
        const drilled = localMidnightToIso(a.DATE_DRILLED);
        return {
          spudDate: a.DATE_ACCURACY === "Day" ? drilled : null,
          drillYear: drilled ? Number(drilled.slice(0, 4)) : null,
          dateAccuracy: a.DATE_ACCURACY ?? null,
        };
      })(),
      depthMD: nz(a.LENGTH),
      depthUnit: "m",
      reports: a.RELATED_REPORTS,
      detailUrl: a.DETAILS,
    }),
  },
  {
    key: "AU-OFF",
    country: "AU",
    state: null,
    label: "Australia offshore petroleum wells and boreholes (NOPTA titles register)",
    probe: { well_name: "Pluto" },
    agency: "National Offshore Petroleum Titles Administrator (NOPTA)",
    url: "https://arcgis.nopta.gov.au/arcgis/rest/services/Public/Petroleum_Wells/MapServer/0",
    pageMax: 8000,
    idKind: "id",
    idLabel: "UWI (Geoscience Australia ENO, e.g. 'ENO0595735')",
    extent: [105.0, -48.0, 160.0, -8.0],
    license: "CC BY 4.0",
    caveat:
      "One record per borehole (~8,000; sidetracks separate, boreholeId), incl. ~4,000 legacy onshore records. Adds what AU-GA lacks: operator, title, rig and spud (kick-off) date. type is the purpose (Exploration, Development, Appraisal), wellCategory Petroleum, Stratigraphic or Greenhouse Gas; field is the basin, county the adjacent state. No depth or status. Wells appear once their basic data is released.",
    searchFields: {
      api: "Uwi",
      well_name: "WellName",
      operator: "Operator",
      county: "OffshoreArea",
      field: "Basin",
      well_type: "Purpose",
    },
    normalize: (a, g) => ({
      api: a.Uwi,
      boreholeId: a.Ubhi,
      wellName: a.WellName,
      boreholeName: a.BHName,
      operator: a.Operator,
      status: null,
      wellType: a.Purpose,
      wellCategory: a.Type,
      field: a.Basin,
      subBasin: a.SubBasin,
      county: a.OffshoreArea,
      jurisdiction: a.Jurisdiction,
      offshore: a.IsOffshore === "Yes",
      title: a.TitleNumber,
      ...geomFirst(a, g, "Latitude", "Longitude"),
      spudDate: msToIso(a.KickOffDate),
      rigReleaseDate: msToIso(a.RigReleaseDate),
      dataReleaseDate: msToIso(a.BasicReleaseDate),
      rig: a.Rig,
      rigContractor: a.RigContractor,
    }),
  },
  {
    key: "AU-WA",
    country: "AU",
    state: "WA",
    label: "Western Australia onshore petroleum wells",
    probe: { county: "Perth" },
    agency: "WA Department of Energy, Mines, Industry Regulation and Safety (DMIRS-025)",
    url: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Industry_and_Mining/MapServer/13",
    // The same layer on SLIP's twin service; on 2026-10-23 the first one answered every query with a 503.
    fallbackUrl: "https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Industry_and_Mining_WFS/MapServer/13",
    pageMax: 2000,
    idKind: "id",
    idLabel: "UWI",
    extent: [112.9, -35.2, 129.1, -13.6],
    license: "CC BY 4.0",
    caveat: "Onshore wells, updated daily. county filters by basin. No depth field.",
    searchFields: {
      api: "uwi",
      well_name: "well_name",
      operator: "operator",
      county: "basin",
      field: "field",
      status: "status",
      well_type: "class",
    },
    normalize: (a, g) => ({
      api: a.uwi,
      wellName: a.well_name,
      operator: a.operator,
      status: a.status,
      wellType: a.class,
      field: a.field,
      county: a.basin,
      ...geomFirst(a, g, "lat", "long"),
      spudDate: msToIso(a.spud_date),
      rigReleaseDate: msToIso(a.rig_release_date),
      lease: a.lease_no,
    }),
  },
];
