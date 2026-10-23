// FracFocus: the national registry of hydraulic-fracturing chemical disclosures, run by
// the Ground Water Protection Council and the Interstate Oil & Gas Compact Commission.
// Over 20 states make it their official disclosure filing. Each record is one frac job on
// one well (API number, operator, location, job dates, true vertical depth, water volume);
// get_well returns the job's full chemical list.

import { API_STATE_CODES } from "../api-number.js";
import { usDateToIso, num } from "./normalize.js";

const nz = (v) => num(v, { zeroIsNull: true });

export const FRACFOCUS_SOURCES = [
  {
    key: "US-FRACFOCUS",
    country: "US",
    state: null,
    kind: "fracfocus",
    label: "US hydraulic-fracturing disclosures (one record per frac job, with the chemical list)",
    probe: { operator: "Diamondback" },
    agency: "FracFocus (Ground Water Protection Council / Interstate Oil & Gas Compact Commission)",
    url: "https://fracfocus.org/api/api",
    pageMax: 1000,
    timeoutMs: 60_000,
    idKind: "us-api",
    apiStates: Object.values(API_STATE_CODES), // every state's API numbers can have disclosures
    requiresOneOf: ["api", "well_name", "operator"], // ~250,000 disclosures: no unfiltered listing
    extent: [[-125.0, 24.0, -66.5, 49.5], [-170.0, 51.0, -129.0, 71.5]],
    license:
      "FracFocus terms: site content may not be republished or used commercially; the bulk data download (fracfocus.org/data-download) may be used without restriction if unaltered. Query it live; for reuse, take the download.",
    caveat:
      "Frac jobs since 2011, as reported by operators - not a well registry: wells never fractured are absent and a refractured well appears once per job. operator matches FracFocus's own operator names (up to 20 matching names are asked). No status or field; county is reported but cannot be filtered on. depthTVD is in feet, baseWaterVolumeGal in US gallons. get_well (US API number) adds the chemical list: ingredient, CAS number, % of the frac fluid, mass.",
    searchFields: {
      api: "APINumber",
      well_name: "WellName",
      operator: "OperatorClean",
    },
    normalize: (a, g) => ({
      api: a.APINumber,
      wellName: a.WellName,
      operator: a.OperatorClean,
      status: null,
      wellType: a.WellType,
      county: a.CountyName,
      stateName: a.StateName,
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
      jobStartDate: usDateToIso(a.JobStartDate),
      jobEndDate: usDateToIso(a.JobEndDate),
      depthTVD: nz(a.TVD),
      depthUnit: "ft",
      baseWaterVolumeGal: nz(a.TotalBaseWaterVolume),
      baseNonWaterVolume: nz(a.TotalBaseNonWaterVolume),
      federalWell: a.FederalWell === "true",
      tribalWell: a.IndianWell === "true",
      ...(Array.isArray(a.Ingredients) ? { ingredientCount: a.Ingredients.length } : {}),
    }),
  },
];
