// Nationwide US federal well datasets (offshore BOEM layers are in boem.js).
// Verified 2026-10-23.

import { API_STATE_CODES } from "../api-number.js";
import { msToIso, isoDate, coord, joinName } from "./normalize.js";

const ALL_STATES = Object.values(API_STATE_CODES).filter((s) => !s.startsWith("OCS"));
const LOWER_48_AND_AK = [[-125.0, 24.0, -66.5, 49.5], [-170.0, 51.0, -129.0, 71.5]];

export const FEDERAL_SOURCES = [
  {
    key: "US-ORPHAN",
    country: "US",
    state: null,
    label: "US documented unplugged orphaned oil & gas wells (USGS national dataset, from state regulators)",
    probe: { well_name: "Stoneman" },
    agency: "U.S. Geological Survey - Documented Unplugged Orphaned Oil and Gas Well dataset (DOI 10.5066/P13FHBYG)",
    url: "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/US_Documented_Unplugged_Orphaned_Oil_and_Gas_Well_Dataset/FeatureServer/0",
    pageMax: 2000,
    idKind: "us-api",
    apiNumeric: true,
    apiDigits14: true, // API numbers are stored as 14-digit integers (leading zero dropped)
    apiStates: ALL_STATES,
    extent: LOWER_48_AND_AK,
    caveat:
      "~130,000 wells that state regulators list as orphaned and unplugged (2026 release), across ~27 states. api is the 14-digit API number where the state gives one; other identifier types (IGSID, ILRefNo, KYPermit) are in identifierType. status and type are each state's own terms. county filters by county name; the state is in stateName. Includes federal surface and mineral ownership.",
    searchFields: {
      api: "primary_identifier",
      well_name: "well_name",
      county: "county",
      status: "status",
      well_type: "type",
    },
    normalize: (a, g) => ({
      api:
        a.primary_identifier == null
          ? null
          : a.primary_identifier_type === "API"
            ? String(a.primary_identifier).padStart(14, "0")
            : String(a.primary_identifier),
      identifierType: a.primary_identifier_type,
      secondaryIdentifier: a.secondary_identifier,
      wellName: joinName(a.well_name, a.well_number),
      operator: null,
      status: a.status,
      wellType: a.type,
      county: a.county,
      stateName: a.state,
      latitude: coord(a, "latitude", g, "y"),
      longitude: coord(a, "longitude", g, "x"),
      sourceAgency: a.source,
      dataDate: isoDate(a.data_file_date),
      surfaceFederalAgency: a.surface_fed_agency,
      subsurfaceFederal: a.subsurface_owner_fed,
      notes: [a.well_info_notes, a.other_notes].filter(Boolean).join(" | ") || null,
    }),
  },
  {
    key: "US-BLM-NM",
    country: "US",
    state: null,
    label: "BLM applications for permit to drill (APDs) on federal minerals - New Mexico, Oklahoma, Kansas, Texas",
    probe: { operator: "Devon" },
    agency: "Bureau of Land Management, New Mexico State Office",
    url: "https://gis.blm.gov/nmarcgis/rest/services/Fluid_Minerals/BLM_NM_APD_NMSO/MapServer/0",
    pageMax: 2000,
    idKind: "id",
    idLabel: "APD tracking number",
    dedupeBy: "APD_TRACK_NUM", // the layer also maps each APD's bottom-hole and entry points
    extent: [-109.1, 25.8, -93.4, 40.1],
    caveat:
      "Drilling permit applications on federal minerals administered by BLM's New Mexico State Office (NM, OK, KS, TX), fiscal years 2008 on, incl. pending and withdrawn ones - permits, not drilled wells, with no API number or depth. One record per APD; locationType says whether the point shown is the surface, bottom-hole or entry point.",
    searchFields: {
      api: "APD_TRACK_NUM",
      well_name: "WELL_NAME",
      operator: "OPERATOR",
      status: "STATUS",
      well_type: "WELL_TYPE",
    },
    normalize: (a, g) => ({
      api: a.APD_TRACK_NUM,
      wellName: joinName(a.WELL_NAME, a.WELL_NUM),
      operator: a.OPERATOR,
      status: a.STATUS,
      wellType: a.WELL_TYPE,
      lease: a.LEASE_NUM,
      fiscalYear: a.FISCAL_YEAR,
      locationType: a.LOCATION,
      onsiteDate: msToIso(a.ONSITE_DATE),
      latitude: g?.y ?? null,
      longitude: g?.x ?? null,
    }),
  },
];
