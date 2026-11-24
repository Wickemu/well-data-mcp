// State geological surveys' contributions to the National Geothermal Data System (AASG,
// 2011-2014): borehole temperature layers in the standard AASG schema, one record per
// temperature measurement, plus Iowa's well headers (Iowa has no oil & gas regulator layer).
// The original host (Arizona Geological Survey) is gone; these copies survive at NBMG,
// the Illinois State Geological Survey and the WV Geological Survey. Verified 2026-10-23.

import { msToIso, num, geomFirst } from "./normalize.js";
import { wellNameWhere } from "../providers/arcgis.js";

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

// An elevation of exactly 0 is a placeholder too (WY DF, SD KB). A coastal well at 0 ft
// (MA, NY) loses its elevation, a smaller harm than thousands of false sea-level wells.
const aasgElevation = (v) => {
  const n = aasgNum(v);
  return n === 0 ? null : n;
};
// DepthReferencePoint is spelled 'KB', 'K', 'G.L.', 'GL', 'DF', or left empty / 'Unknown'.
export function aasgDepthReference(v) {
  const t = String(aasgText(v) ?? "").trim();
  if (!t || /^unknown$/i.test(t)) return null;
  if (/^k(b|elly)?\b/i.test(t)) return "KB";
  if (/^g\.?\s*l\.?$|^ground/i.test(t)) return "GL";
  if (/^d\.?\s*f\.?$|^derrick/i.test(t)) return "DF";
  return t;
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const nameTokens = (s) =>
  squash(s)
    .toUpperCase()
    .split(/[\s,.#_"-]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^0+(?=\d)/, ""));
// A name worth showing has a word in it, not just a number ('1', 'NO.2').
const hasNameWord = (s) => /[A-Z]{2,}/i.test(String(s).replace(/\bNO\b\.?/gi, ""));

/**
 * The well's own name. Most AASG layers file it as '<operator> <well>' ('ACME DRLG CO 2
 * FOXTAIL', 'Acme Oil - Foxtail 2', MI 'ACME OIL CO_FOXTAIL_2-14'), WY as '<well>
 * <operator>'; the operator is in its own field, so it is taken off. Where LeaseName
 * holds the same words it gives the usual lease-then-number order ('FOXTAIL 2'); a
 * LeaseName that does not (some OH and WV rows hold another well's) is ignored.
 */
export function aasgWellName(a) {
  const raw = squash(a.WellName);
  if (!raw) return null;
  const op = squash(aasgText(a.Operator));
  let rest = raw;
  if (op && raw.length > op.length && raw.toUpperCase().startsWith(op.toUpperCase()) && !/[A-Z0-9]/i.test(raw[op.length])) {
    const cut = raw.slice(op.length).replace(/^[\s_-]+/, "").replace(/_+/g, " ").trim();
    if (hasNameWord(cut)) rest = cut; // 'ACME OIL CO 1' stays whole: '1' alone names nothing
  } else if (op && raw.toUpperCase().endsWith(` ${op.toUpperCase()}`)) {
    const cut = raw.slice(0, -op.length).trim();
    if (hasNameWord(cut)) rest = cut;
  }
  const lease = squash(String(aasgText(a.LeaseName) ?? "").replace(/"/g, ""));
  if (lease) {
    const have = new Set(nameTokens(rest));
    const consistent = nameTokens(lease).every((t) => have.has(t));
    if (consistent && /\d/.test(lease)) return lease; // PA 'S G FULTON DW1', IL 'Ackelson "1"'
    if (consistent && rest.toUpperCase().endsWith(lease.toUpperCase())) {
      const number = rest.slice(0, rest.length - lease.length).trim();
      return number ? `${lease} ${number}` : lease; // CO '1 PARKER' -> 'PARKER 1'
    }
  }
  return rest;
}

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
    groundElevation: aasgElevation(a.ElevationGL),
    kbElevation: aasgElevation(a.ElevationKB),
    dfElevation: aasgElevation(a.ElevationDF),
    depthReference: aasgDepthReference(a.DepthReferencePoint),
    formationAtTD: a.FormationTD || null,
  };
}

// Each name tier asks LeaseName, and WellName on the rows with no LeaseName (CO: ~1%):
// a name search otherwise never finds those rows.
const ON_LEASE = { searchFields: { well_name: "LeaseName" } };
const ON_WELL_NAME = { searchFields: { well_name: "WellName" } };
export function leaseOrWellName(text, tier) {
  const lease = wellNameWhere(ON_LEASE, text, tier);
  const filed = wellNameWhere(ON_WELL_NAME, text, tier);
  if (!lease) return null;
  return filed ? `(${lease} OR ((LeaseName IS NULL OR LeaseName = '') AND ${filed}))` : lease;
}
// CO's LeaseName is the lease alone ('PARKER'); the number is only in WellName ('<operator>
// 1 PARKER'). So WellName serves as the number field: the lease words in LeaseName and the
// number in WellName, or all of it in WellName (which also covers rows with no LeaseName);
// the number-alone tier looks in WellName. Operator-name hits that come back with it rank
// low on the displayed name.
const LEASE_THEN_FILED = { searchFields: { well_name: "LeaseName" }, wellNumberField: "WellName" };
export const leaseAndFiledNumber = (text, tier) => wellNameWhere(LEASE_THEN_FILED, text, tier);

// leaseName: the layer's LeaseName is filled on (nearly) every row, so a name search looks
// there rather than in '<operator> <well>', where 'Parker 1' finds the operator Parker's
// wells first. 'number': LeaseName holds lease + number (PA, IL, MO); 'lease-only': the
// number is in WellName (CO).
function boreholeTemperatures(state, host, service, probe, { leaseName = null } = {}) {
  return {
    key: `${state}-BHT`,
    state,
    label: `${STATE_NAMES[state]} borehole temperatures (bottom-hole and log temperatures by well)`,
    probe,
    agency: `${STATE_NAMES[state]} state geological survey data in the National Geothermal Data System (AASG), ${HOSTED_BY[host]}`,
    url: `${host}/${service}/MapServer/0`,
    pageMax: 1000,
    caveat:
      "One record per temperature measurement (a well can have several), compiled 2011-2014 for the National Geothermal Data System - for geothermal screening, not current well status. temperatureC / correctedTemperatureC are converted to deg C (correctedTemperatureC is the survey's BHT correction, where made); depthOfMeasurement, depths and the ground / KB / DF elevations are in depthUnit, and depthReference says what depths are measured from. Where the survey filed the name as '<operator> <well>', wellName leaves the operator out and registryName keeps the name as filed.",
    searchFields: leaseName ? { ...AASG_FIELDS, well_name: "LeaseName" } : AASG_FIELDS,
    // WellName is filed as '<operator> <well>': rank on the cleaned wellName only, or an
    // operator's name ('Columbia 1' vs 'Columbian Carbon Co.') outranks the well's.
    ...(leaseName ? {} : { rankFiledName: false }),
    ...(leaseName ? { nameWhere: async (text, tier) => (leaseName === "lease-only" ? leaseAndFiledNumber : leaseOrWellName)(text, tier) } : {}),
    normalize: (a, g) => ({
      ...wellHeader(a, g),
      ...bhtName(a),
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

function bhtName(a) {
  const wellName = aasgWellName(a);
  return { wellName, registryName: wellName && wellName !== squash(a.WellName) ? a.WellName : null };
}

// Iowa's GeoSam cards moved from igsb.uiowa.edu (gone) to igs.iihr.uiowa.edu; the well
// number is in the old link ('geocard.asp?wnumber=1072') or the label ('IAGS:24986').
// PWTS (Iowa DNR private well) records have no GeoSam card.
export function iaDetailUrl(a) {
  const n = /wnumber=(\d+)/i.exec(a.RelatedResource ?? "")?.[1] ?? /^IAGS:(\d+)$/i.exec(String(a.Label ?? "").trim())?.[1];
  return n ? `https://igs.iihr.uiowa.edu/igs/geosam/well/${n}/general-information` : null;
}
// 'NULL' (22,000 rows) and 'UNKNOWN' are the survey's blanks.
export const iaDriller = (v) => (/^(null|unknown|none)?$/i.test(String(v ?? "").trim()) ? null : String(v).trim());

export const AASG_SOURCES = [
  boreholeTemperatures("CO", NBMG, "CO_Data/COBoreholeTemperatures", { county: "Weld" }, { leaseName: "lease-only" }),
  boreholeTemperatures("ID", NBMG, "ID_Data/IDBoreholeTemperatures", { county: "Ada" }),
  boreholeTemperatures("MT", NBMG, "MT_Data/MTBoreholeTemperatures", { county: "Richland" }),
  boreholeTemperatures("NV", NBMG, "NV_Data/NVBoreholeTemperatures", { county: "Washoe" }),
  boreholeTemperatures("SD", NBMG, "SD_Data/SDBoreholeTemperatures", { county: "Harding" }),
  boreholeTemperatures("UT", NBMG, "UT_Data/UTBoreholeTemperatures", { county: "Beaver" }),
  boreholeTemperatures("WY", NBMG, "WY_Data/WYBoreholeTemperatures", { county: "Campbell" }),
  boreholeTemperatures("IL", ISGS, "ILBoreholeTemperatures", { county: "White" }, { leaseName: "number" }),
  boreholeTemperatures("IN", ISGS, "INBoreholeTemperatures", { county: "Posey" }),
  boreholeTemperatures("MA", ISGS, "MABoreholeTemperatures", { county: "Middlesex" }),
  boreholeTemperatures("MI", ISGS, "MIBoreholeTemperatures", { county: "Grand Traverse" }),
  boreholeTemperatures("MO", ISGS, "MOBoreholeTemperatures", { operator: "Cities Service" }, { leaseName: "number" }),
  boreholeTemperatures("NY", ISGS, "NYBoreholeTemperatures", { county: "Chautauqua" }),
  boreholeTemperatures("OH", ISGS, "OHBoreholeTemperatures", { county: "Washington" }),
  boreholeTemperatures("PA", ISGS, "PABoreholeTemperatures", { county: "Washington" }, { leaseName: "number" }),
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
      "Iowa has no oil & gas regulator layer; this is the Iowa Geological Survey's well database as compiled for the NGDS (2013): ~153,000 wells, mostly water wells, with ~1,400 gas-storage and ~10,800 exploration holes. Depths and elevations in depthUnit; detailUrl is the well's GeoSam card where it has one.",
    searchFields: { ...AASG_FIELDS, api: "Label" },
    normalize: (a, g) => ({ ...wellHeader(a, g), api: a.Label, apiNumber: a.APINo || null, driller: iaDriller(a.Driller), detailUrl: iaDetailUrl(a) }),
  },
];
