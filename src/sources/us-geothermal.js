// State geological surveys' contributions to the National Geothermal Data System (AASG,
// 2011-2014): borehole temperature layers in the standard AASG schema, one record per
// temperature measurement, plus Iowa's well headers (Iowa has no oil & gas regulator layer).
// The original host (Arizona Geological Survey) is gone; these copies survive at NBMG,
// the Illinois State Geological Survey and the WV Geological Survey. Verified 2026-10-23.

import { msToIso, num, geomFirst } from "./normalize.js";

const NBMG = "https://web2.nbmg.unr.edu/arcgis/rest/services";
const ISGS = "https://geothermal.isgs.illinois.edu/arcgis/rest/services/aasggeothermal";
const WVGS = "https://atlas.wvgs.wvnet.edu/arcgis/rest/services/aasg";

const HOSTED_BY = {
  [NBMG]: "served by the Nevada Bureau of Mines and Geology",
  [ISGS]: "served by the Illinois State Geological Survey",
  [WVGS]: "served by the West Virginia Geological and Economic Survey",
};

const STATE_NAMES = {
  CO: "Colorado", ID: "Idaho", MT: "Montana", NV: "Nevada", SD: "South Dakota", UT: "Utah", WY: "Wyoming",
  IL: "Illinois", IN: "Indiana", MA: "Massachusetts", MI: "Michigan", MO: "Missouri", NY: "New York",
  OH: "Ohio", PA: "Pennsylvania", VT: "Vermont", WV: "West Virginia", IA: "Iowa",
};

// AASG placeholders: 1900-01-01 for an unknown date, -9999 / -99999 for an unknown number.
const aasgDate = (v) => (v == null || v <= -2208988800000 ? null : msToIso(v));
const aasgNum = (v) => {
  const n = num(v);
  return n == null || n <= -999 ? null : n;
};
// ...and 'Missing' / 'nil:missing' for unknown text.
const aasgText = (v) => (v == null || v === "" || /^(nil:)?missing$/i.test(String(v).trim()) ? null : v);
const unitOf = (u) => (/^\s*m/i.test(u ?? "") ? "m" : /^\s*f/i.test(u ?? "") ? "ft" : null);
const toC = (t, unit) => {
  const v = aasgNum(t);
  if (v == null) return null;
  if (/^\s*f/i.test(unit ?? "")) return Math.round((((v - 32) * 5) / 9) * 10) / 10;
  return /^\s*c/i.test(unit ?? "") ? Math.round(v * 10) / 10 : null;
};

const AASG_FIELDS = {
  api: "APINo",
  well_name: "WellName",
  operator: "Operator",
  county: "County",
  field: "Field",
  status: "Status",
  well_type: "WellType",
};

function wellHeader(a, g) {
  return {
    api: a.APINo || null,
    wellName: a.WellName,
    operator: aasgText(a.Operator),
    status: aasgText(a.Status),
    wellType: aasgText(a.WellType),
    field: aasgText(a.Field),
    county: a.County,
    ...geomFirst(a, g, "LatDegree", "LongDegree"),
    spudDate: aasgDate(a.SpudDate),
    endDrillDate: aasgDate(a.EndedDrillingDate),
    depthMD: aasgNum(a.DrillerTotalDepth),
    depthTVD: aasgNum(a.TrueVerticalDepth),
    depthUnit: unitOf(a.LengthUnits),
    formationAtTD: a.FormationTD || null,
  };
}

function boreholeTemperatures(state, host, service, probe) {
  return {
    key: `${state}-BHT`,
    state,
    label: `${STATE_NAMES[state]} borehole temperatures (bottom-hole and log temperatures by well)`,
    probe,
    agency: `${STATE_NAMES[state]} state geological survey data in the National Geothermal Data System (AASG), ${HOSTED_BY[host]}`,
    url: `${host}/${service}/MapServer/0`,
    pageMax: 1000,
    caveat:
      "One record per temperature measurement (a well can have several), compiled 2011-2014 for the National Geothermal Data System - for geothermal screening, not current well status. temperatureC / correctedTemperatureC are converted to deg C (correctedTemperatureC is the survey's BHT correction, where made); depthOfMeasurement and depths are in depthUnit.",
    searchFields: AASG_FIELDS,
    normalize: (a, g) => ({
      ...wellHeader(a, g),
      temperatureC: toC(a.MeasuredTemperature, a.TemperatureUnits),
      correctedTemperatureC: toC(a.CorrectedTemperature, a.TemperatureUnits),
      depthOfMeasurement: aasgNum(a.DepthOfMeasurement),
      measurementProcedure: a.MeasurementProcedure || null,
      timeSinceCirculation: a.TimeSinceCirculation || null,
      measurementDate: aasgDate(a.MeasurementDateTime),
      measurementFormation: a.MeasurementFormation || null,
    }),
  };
}

export const AASG_SOURCES = [
  boreholeTemperatures("CO", NBMG, "CO_Data/COBoreholeTemperatures", { county: "Weld" }),
  boreholeTemperatures("ID", NBMG, "ID_Data/IDBoreholeTemperatures", { county: "Ada" }),
  boreholeTemperatures("MT", NBMG, "MT_Data/MTBoreholeTemperatures", { county: "Richland" }),
  boreholeTemperatures("NV", NBMG, "NV_Data/NVBoreholeTemperatures", { county: "Washoe" }),
  boreholeTemperatures("SD", NBMG, "SD_Data/SDBoreholeTemperatures", { county: "Harding" }),
  boreholeTemperatures("UT", NBMG, "UT_Data/UTBoreholeTemperatures", { county: "Beaver" }),
  boreholeTemperatures("WY", NBMG, "WY_Data/WYBoreholeTemperatures", { county: "Campbell" }),
  boreholeTemperatures("IL", ISGS, "ILBoreholeTemperatures", { county: "White" }),
  boreholeTemperatures("IN", ISGS, "INBoreholeTemperatures", { county: "Posey" }),
  boreholeTemperatures("MA", ISGS, "MABoreholeTemperatures", { county: "Middlesex" }),
  boreholeTemperatures("MI", ISGS, "MIBoreholeTemperatures", { county: "Grand Traverse" }),
  boreholeTemperatures("MO", ISGS, "MOBoreholeTemperatures", { operator: "Cities Service" }),
  boreholeTemperatures("NY", ISGS, "NYBoreholeTemperatures", { county: "Chautauqua" }),
  boreholeTemperatures("OH", ISGS, "OHBoreholeTemperatures", { county: "Washington" }),
  boreholeTemperatures("PA", ISGS, "PABoreholeTemperatures", { county: "Washington" }),
  boreholeTemperatures("VT", ISGS, "VTBoreholeTemperatures", { operator: "Champlain" }),
  boreholeTemperatures("WV", WVGS, "WVBoreholeTemperatures", { county: "Mercer" }),
  {
    key: "IA",
    state: "IA",
    label: "Iowa wells (Iowa Geological Survey GeoSam: water, exploration, gas-storage and oil tests)",
    probe: { well_type: "Gas storage" },
    agency: `Iowa Geological Survey (GeoSam) data in the National Geothermal Data System, ${HOSTED_BY[ISGS]}`,
    url: `${ISGS}/IAWellHeaders/MapServer/0`,
    pageMax: 1000,
    idKind: "id",
    idLabel: "Iowa well label (e.g. 'IA-W-1')",
    caveat:
      "Iowa has no oil & gas regulator layer; this is the Iowa Geological Survey's well database as compiled for the NGDS (2013): ~153,000 wells, mostly water wells, with ~1,400 gas-storage and ~10,800 exploration holes. Depths in depthUnit.",
    searchFields: { ...AASG_FIELDS, api: "Label" },
    normalize: (a, g) => ({ ...wellHeader(a, g), api: a.Label, apiNumber: a.APINo || null, driller: a.Driller || null }),
  },
];
