// Code tables and small helpers for the US state sources in us.js, kept here so the source
// list stays readable. Each table says where its meanings come from.

import { eqClause, inClause, likeClause, sqlQuote } from "../providers/arcgis.js";
import { joinName, isoDate } from "./normalize.js";

// CalGEM geothermal FieldName: a 5-letter code (padded), with no domain on the layer. The
// names follow each code's county, leases and operators (checked 2026-11-24): GEYSR is Lake
// and Sonoma, SNSEA and HEBER Imperial, CASAD Mono, LAKE the Surprise Valley wells in Modoc.
// NAEF (one City of Susanville well) has no clear name and stays a code.
export const CA_GEO_FIELDS = {
  AMEDE: "Amedee",
  BRWLY: "Brawley",
  CALIS: "Calistoga",
  CALST: "Calistoga",
  CASAD: "Casa Diablo",
  COSO: "Coso",
  DHS: "Desert Hot Springs",
  EMESA: "East Mesa",
  GEYSR: "The Geysers",
  GLASS: "Glass Mountain",
  GLEN: "Glen Ivy",
  HEBER: "Heber",
  HMSPA: "Hot Mineral Spa",
  LAKE: "Lake City (Surprise Valley)",
  LITCH: "Litchfield",
  SNBER: "San Bernardino",
  SNSEA: "Salton Sea",
  SONO: "Sonoma",
  SUSAN: "Susanville",
  WENDL: "Wendel",
  "WEN-2": "Wendel",
};

/** CA-GEO field filter: the text in the stored code, or every code whose field name holds it ('Geysers' -> GEYSR). */
export function caGeoFieldWhere(text) {
  const t = String(text).trim().toUpperCase();
  const codes = Object.entries(CA_GEO_FIELDS)
    .filter(([code, name]) => code === t || (t.length >= 3 && name.toUpperCase().includes(t)))
    .map(([code]) => code);
  return codes.length ? `(${likeClause("FieldName", text)} OR ${inClause("FieldName", codes)})` : likeClause("FieldName", text);
}

// Colorado ECMC facility status (wellstat) and well class (well_class). The layer has no
// domain and the meanings are inferred from the codes' usual ECMC sense and their counts
// (not checked against an ECMC code list): AP (approved permit, not drilled) and LO
// (location; it pairs with status AL) in particular. statusCode / wellTypeCode keep the code.
export const CO_STATUS = {
  AB: "Abandoned",
  AC: "Active",
  AL: "Abandoned location",
  AP: "Approved permit",
  DA: "Dry and abandoned",
  DG: "Drilling",
  DM: "Domestic",
  EP: "Expired permit",
  IJ: "Injecting",
  PA: "Plugged and abandoned",
  PR: "Producing",
  SI: "Shut in",
  SO: "Suspended operations",
  TA: "Temporarily abandoned",
  WO: "Waiting on completion",
};
export const CO_CLASS = {
  CBM: "Coalbed methane",
  "CLASS I EPA": "EPA Class I injection",
  "CLASS II EPA": "EPA Class II injection",
  CO2: "Carbon dioxide",
  DA: "Dry and abandoned",
  DM: "Domestic",
  DSPW: "Disposal",
  ERIW: "Enhanced recovery injection",
  "GEO-SCI": "Geoscience test",
  GW: "Gas",
  HE: "Helium",
  LO: "Location (not drilled)",
  OBW: "Observation",
  OTH: "Other",
  OW: "Oil",
  STOW: "Gas storage",
  "STOW INTERSTATE": "Gas storage (interstate)",
  "STOW INTRASTATE": "Gas storage (intrastate)",
  STRT: "Stratigraphic test",
};

// Kansas STATUS: KGS's map class, type and plugging state in one code. Copied from the
// layer's own subtypes (typeIdField STATUS), 2026-11-24.
export const KS_SYMBOL = {
  CBM: "Coal Bed Methane",
  "CBM-P&A": "Coal Bed Methane, Plugged-Abandoned",
  "D&A": "Dry and Abandoned",
  EOR: "Enhanced Oil Recovery",
  "EOR-P&A": "Enhanced Oil Recovery, Plugged-Abandoned",
  GAS: "Gas",
  "GAS-P&A": "Gas, Plugged-Abandoned",
  INJ: "Injection",
  "INJ-P&A": "Injection, Plugged-Abandoned",
  INTENT: "Intent",
  LOC: "Location",
  "O&G": "Oil and Gas",
  "O&G-P&A": "Oil and Gas, Plugged-Abandoned",
  OIL: "Oil",
  "OIL-P&A": "Oil, Plugged-Abandoned",
  OTHER: "Other",
  "OTHER-P&A": "Other, Plugged-Abandoned",
  SWD: "Salt Water Disposal",
  "SWD-P&A": "Salt Water Disposal, Plugged-Abandoned",
};

/** The plugging state a KS map class carries ('OIL-P&A' -> plugged), the only part of it that is a status. */
function ksState(code) {
  if (code.endsWith("-P&A")) return "Plugged and abandoned";
  return { "D&A": "Dry and abandoned", LOC: "Location", INTENT: "Intent to drill" }[code] ?? "";
}

/**
 * KS status filter: the KCC status text (WELL_CLASS, 'Plugged and Abandoned'), the map class
 * code as typed, the classes whose plugging state holds the word, or the classes ending in
 * the plugging part typed ('P&A' or '-P&A' finds OIL-P&A, GAS-P&A...). WELL_CLASS is blank on
 * about 55,000 rows, so 'Plugged' or 'Dry' also asks for OIL-P&A, D&A and the like; a type
 * word ('Oil') does not pull in the plugged OIL-P&A wells.
 */
export function ksStatusWhere(text) {
  const t = String(text).trim().toUpperCase();
  const suffix = t.replace(/^-/, "").replace(/\s+/g, "");
  const codes = Object.keys(KS_SYMBOL).filter(
    (code) => code === t || (suffix.includes("&") && code.endsWith(`-${suffix}`)) || (t.length >= 3 && ksState(code).toUpperCase().includes(t))
  );
  return `(${likeClause("WELL_CLASS", text)} OR ${codes.length ? inClause("STATUS", codes) : eqClause("STATUS", String(text).trim())})`;
}

// Ohio WELL_TYP: the layer's coded-value domain, copied 2026-11-24.
export const OH_WELL_TYP = {
  BR_R: "Brine Production",
  ER_R: "Class II Enhanced Recovery",
  GS_R: "Gas Storage",
  IW_R: "Class I Industrial Waste",
  MN_R: "Monitor/Observation",
  OG_R: "Oil & Gas",
  SM_R: "Class III Solution Mining",
  ST_R: "Stratigraphic Test",
  SW_R: "Class II Disposal Wells Brine/Waste",
  UN_R: "Unknown",
};

// West Virginia county FIPS codes (the WV layer's county field, and digits 3-5 of a WV API).
export const WV_COUNTIES = {
  "001": "Barbour", "003": "Berkeley", "005": "Boone", "007": "Braxton", "009": "Brooke",
  "011": "Cabell", "013": "Calhoun", "015": "Clay", "017": "Doddridge", "019": "Fayette",
  "021": "Gilmer", "023": "Grant", "025": "Greenbrier", "027": "Hampshire", "029": "Hancock",
  "031": "Hardy", "033": "Harrison", "035": "Jackson", "037": "Jefferson", "039": "Kanawha",
  "041": "Lewis", "043": "Lincoln", "045": "Logan", "047": "McDowell", "049": "Marion",
  "051": "Marshall", "053": "Mason", "055": "Mercer", "057": "Mineral", "059": "Mingo",
  "061": "Monongalia", "063": "Monroe", "065": "Morgan", "067": "Nicholas", "069": "Ohio",
  "071": "Pendleton", "073": "Pleasants", "075": "Pocahontas", "077": "Preston", "079": "Putnam",
  "081": "Raleigh", "083": "Randolph", "085": "Ritchie", "087": "Roane", "089": "Summers",
  "091": "Taylor", "093": "Tucker", "095": "Tyler", "097": "Upshur", "099": "Wayne",
  "101": "Webster", "103": "Wetzel", "105": "Wirt", "107": "Wood", "109": "Wyoming",
};

/** WV county filter: a FIPS code as typed ('39' -> '039'), or the codes of the counties whose name holds the text. */
export function wvCountyWhere(text) {
  const t = String(text).trim();
  if (/^\d{1,3}$/.test(t)) return `county = ${sqlQuote(t.padStart(3, "0"))}`;
  const codes = Object.entries(WV_COUNTIES)
    .filter(([, name]) => name.toUpperCase().includes(t.toUpperCase()))
    .map(([code]) => code);
  return codes.length ? `county IN (${codes.map(sqlQuote).join(", ")})` : "1=0";
}

/** WV dates: DEP fills a missing date with '1900/01/01' (2,400 completion dates, most on never-drilled permits). */
export const wvDate = (v) => (/^\s*1900\/0?1\/0?1\b/.test(String(v ?? "")) ? null : isoDate(v));

/**
 * Mississippi DispName is '<lease> <no> <no> <API>' on most rows ('MCGEHEE 2 2 23...'):
 * drop the API, then the repeated well number ('X 6 6' -> 'X 6', 'X # 7 # 7' -> 'X # 7',
 * 'X #2 2' -> 'X #2'). Only a repeat holding a digit is dropped, so a name that really
 * ends in a doubled word stays as it is.
 */
export function msWellName(disp, api) {
  let n = String(disp ?? "");
  if (api) n = n.replace(new RegExp(`\\s*${String(api).replace(/\D/g, "")}\\s*$`), "");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/(\s)((?:#\s?)?\S*\d\S*) \2$/, "$1$2").replace(/(\s#\s?(\S*\d\S*)) \2$/, "$1");
  return n || null;
}

/** Township, range, section and meridian as one string ('T11N R8W S23 MD'), or null without a township and range. */
export function trsLocation(township, range, section, meridian) {
  if (!township || !range) return null;
  return joinName(`T${township}`, `R${range}`, section != null && section !== "" ? `S${section}` : null, meridian ? String(meridian).toUpperCase() : null);
}

/** A URL field, or null when the agency filled it with text ('NO PRODUCTION DATA', 'Not Available'). */
export const urlOrNull = (v) => (/^https?:\/\//i.test(String(v ?? "").trim()) ? String(v).trim() : null);

/** DOGAMI's GTILO-2 marks a missing number with -999. */
export const notSentinel = (v) => {
  const n = v == null || v === "" ? null : Number(v);
  return n != null && Number.isFinite(n) && n > -999 ? n : null;
};

/** A placeholder text ('Unknown', 'NULL', 'N/A') as null. */
export const unknownToNull = (v) => (v == null || /^\s*(unknown|null|n\/?a|none)?\s*$/i.test(String(v)) ? null : v);
