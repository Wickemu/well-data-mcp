// Code tables for the Canadian sources in americas.js, kept here so the source list stays readable.

// BC Energy Regulator well activity codes (WELL_ACTIVITY). The layers publish no domain;
// the meanings follow BCER's usage. WAG, CANC and DSUS occur only in the surface-hole layer.
export const BC_ACTIVITY = {
  ABAN: "Abandoned",
  ABNZ: "Abandoned zone",
  ACT: "Active",
  CANC: "Cancelled",
  CASE: "Cased",
  COMP: "Completed",
  DRIL: "Drilling",
  DSUS: "Drilling suspended",
  SUSP: "Suspended",
  WAG: "Well authorization granted (not drilled)",
};

// BORE_FLUID_TYPE: only the unambiguous codes. MGAS, MOG, MOIL, AGAS and SOLV stay as codes.
export const BC_FLUID = { GAS: "Gas", OIL: "Oil", WATR: "Water", UND: "Undefined" };

// Newfoundland & Labrador offshore: the layer's WellOperations domain on Well_Statu, used
// for wells with operations under way. Other wells hold plain text ('Oil Producer').
export const NL_OPERATIONS = {
  Mobilizing: "Mobilizing to Wellsite",
  SpudPrep: "Preparing to Spud",
  DrillingOps: "Drilling Operations",
  WellInt: "Well Intervention/Workover Operations",
  "Compling-ed": "Completing/Completed",
  "Suspended-ing": "Suspending/Suspended",
  "Abandoning-ed": "Abandoned/Abandoning",
  OpsOngoing: "Operations Ongoing",
  WOW: "Waiting on Weather",
};

// Manitoba STATUS codes, in the layer's own MAP_STATUS wording (cross-tabulated on vertical
// wells, which carry both). The three 'Suspended ...' labels are ours: the layer files
// suspended vertical wells under the unsuspended label.
export const MB_STATUS = {
  COOP: "Producer",
  "SUSP COOP": "Suspended producer",
  "RESUMED COOP": "Producer",
  "ABD P": "Abandoned producer",
  "ABD D": "Dry and abandoned",
  WIW: "Water injection well",
  "SUSP WIW": "Suspended water injection well",
  "ABD WIW": "Abandoned water injection well",
  SWD: "Salt water disposal",
  "SUSP SWD": "Suspended salt water disposal",
  "RESUMED SWD": "Salt water disposal",
  "ABD SWD": "Abandoned salt water disposal",
  WSW: "Water supply well",
  "ABD WSW": "Abandoned water supply well",
  CAN: "Cancelled Well",
  LOC: "Location",
  COMP: "Standing",
  WOSR: "Standing",
  "ABD J": "Junked and abandoned",
  "ABD STH": "Abandoned structure test hole",
  "ABD PTH": "Abandoned potash",
  SSW: "Salt solution well",
  "ABD DUAL": "Abandoned dual completion",
};

// Manitoba gives horizontal / directional wells this map status instead of a description.
export const MB_HZ = "Horizontal or directional surface location";

/** Manitoba's status in words: the map status, or for a horizontal well its code decoded. */
export function mbStatusText(a) {
  if (a.MAP_STATUS !== MB_HZ) return a.MAP_STATUS ?? null;
  const code = a.STATUS == null ? null : String(a.STATUS).trim().replace(/\s+/g, " ");
  return (code && MB_STATUS[code.toUpperCase()]) ?? code ?? null;
}
