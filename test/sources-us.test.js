// Offline tests for the US state sources (us.js, us-codes.js). Well names and figures are
// invented; attribute names and value shapes follow the live layers.
import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES, normalizeRecord } from "../src/sources/index.js";
import { buildWhere } from "../src/providers/arcgis.js";
import {
  msWellName, caGeoFieldWhere, wvCountyWhere, wvDate, ksStatusWhere, trsLocation, urlOrNull, notSentinel, unknownToNull,
} from "../src/sources/us-codes.js";

const src = (key) => SOURCES.find((s) => s.key === key);
const norm = (key, attrs, geometry = null) => normalizeRecord(src(key), attrs, geometry);
const where = async (key, filters) => (await buildWhere(src(key), filters)).where;

test("MS: the repeated well number and the API are dropped from DispName", () => {
  assert.equal(msWellName("FOXTAIL         3 3 2399999999", "2399999999"), "FOXTAIL 3");
  assert.equal(msWellName("FOXTAIL # 3 # 3 2399999999", "2399999999"), "FOXTAIL # 3");
  assert.equal(msWellName("FOX TAIL ET AL #2 2 2399999999", "2399999999"), "FOX TAIL ET AL #2");
  assert.equal(msWellName("JOHN Q FOXTAIL B-1 B-1 2399999999", "2399999999"), "JOHN Q FOXTAIL B-1");
  // not doubled: left as they are
  assert.equal(msWellName("FOXTAIL UNIT # 1 2399999999", "2399999999"), "FOXTAIL UNIT # 1");
  assert.equal(msWellName("FOXTAIL-BRANT 50-10 1 2399999999", "2399999999"), "FOXTAIL-BRANT 50-10 1");
  assert.equal(msWellName("BIG A A 2399999999", "2399999999"), "BIG A A", "a doubled word without a digit stays");
  assert.equal(norm("MS", { API: "2399999999", DispName: "FOXTAIL   7 7 2399999999" }).wellName, "FOXTAIL 7");
});

test("CA-GEO: field codes decode to names, and a field name filter asks for its code", () => {
  const n = norm("CA-GEO", { APINumber: "09999999", LeaseName: "Foxtail", WellNumber: "1", FieldName: "GEYSR", Township: "11N", Range: "8W", TownshipSection: 23, BaseMeridian: "MD" });
  assert.equal(n.field, "The Geysers");
  assert.equal(n.fieldCode, "GEYSR");
  assert.equal(n.legalLocation, "T11N R8W S23 MD");
  assert.equal(norm("CA-GEO", { FieldName: "NAEF" }).field, "NAEF", "an unknown code stays");
  assert.match(caGeoFieldWhere("Geysers"), /IN \(UPPER\('GEYSR'\)\)/);
  assert.match(caGeoFieldWhere("Salton Sea"), /'SNSEA'/);
  assert.match(caGeoFieldWhere("snsea"), /'SNSEA'/);
  assert.doesNotMatch(caGeoFieldWhere("Nowhere"), / IN /);
});

test("CA-OG / CA-GEO legal location", () => {
  assert.equal(trsLocation("19N", "01W", "34", "md"), "T19N R01W S34 MD");
  assert.equal(trsLocation(null, "01W", "34", "MD"), null);
  assert.equal(norm("CA-OG", { API: "0499999999", LeaseName: "Foxtail", WellNumber: "2", Section: "4", Township: "9S", Range: "12E", BaseMeridian: "SB" }).legalLocation, "T9S R12E S4 SB");
});

test("WV: county FIPS codes shown as names; county filter takes a name or a code; 1900/01/01 is no date", () => {
  const n = norm("WV", { api: "4703999999", county: "039", farmname: "FOXTAIL", wellnumber: "1", compdate: "1900/01/01", issuedate: "1987/05/04" });
  assert.equal(n.county, "Kanawha");
  assert.equal(n.countyCode, "039");
  assert.equal(n.completionDate, null);
  assert.equal(n.issueDate, "1987-05-04");
  assert.equal(wvDate("1900/1/1"), null);
  assert.equal(wvDate("1900/03/02"), "1900-03-02", "only the exact placeholder is dropped");
  assert.equal(wvCountyWhere("Kanawha"), "county IN ('039')");
  assert.equal(wvCountyWhere("39"), "county = '039'");
  assert.equal(wvCountyWhere("Nowhere"), "1=0");
  assert.match(wvCountyWhere("wood"), /'107'/);
});

test("KS: status is the KCC status, the map class kept as symbol; a status word also finds the map classes", async () => {
  const n = norm("KS", { API_NUMBER: "15-999-99999", LEASE_NAME: "Foxtail", WELL_NAME: "1", STATUS: "OIL-P&A", WELL_CLASS: "Plugged and Abandoned", WELL_TYPE: "OIL", ELEVATION_KB: 2100, ELEVATION_GL: 0 });
  assert.equal(n.status, "Plugged and Abandoned");
  assert.equal(n.wellType, "OIL");
  assert.equal(n.symbol, "Oil, Plugged-Abandoned");
  assert.equal(n.symbolCode, "OIL-P&A");
  assert.equal(n.kbElevationFt, 2100);
  assert.equal(n.groundElevationFt, null);
  // WELL_CLASS blank: the map class stands in
  assert.equal(norm("KS", { STATUS: "D&A", WELL_CLASS: " " }).status, "Dry and Abandoned");
  const dry = ksStatusWhere("Dry");
  assert.match(dry, /UPPER\(WELL_CLASS\) LIKE UPPER\('%Dry%'\)/);
  assert.match(dry, /UPPER\(STATUS\) IN \(UPPER\('D&A'\)\)/);
  assert.match(ksStatusWhere("Plugged"), /'OIL-P&A'/);
  assert.doesNotMatch(ksStatusWhere("Oil"), /P&A/, "a type word does not pull in plugged wells");
  assert.match(ksStatusWhere("OIL"), /UPPER\(STATUS\) IN \(UPPER\('OIL'\)\)/, "the code typed");
  assert.match(await where("KS", { status: "Dry" }), /WELL_CLASS/);
});

test("ND / OK / NY: code fields match exactly, a word matches the descriptive sibling by prefix", async () => {
  assert.match(await where("ND", { status: "A" }), /UPPER\(status\) = UPPER\('A'\)/);
  const ny = await where("NY", { status: "Plugged" });
  assert.match(ny, /UPPER\(WELL_STATUS\) = UPPER\('Plugged'\)/);
  assert.match(ny, /UPPER\(GENERALWELLSTATUS\) LIKE UPPER\('Plugged%'\)/);
  assert.match(await where("OK", { status: "Orphan" }), /symbol_class\) LIKE UPPER\('Orphan%'\)/);
  assert.match(await where("OK", { well_type: "OIL" }), /UPPER\(welltype\) = UPPER\('OIL'\)/);
});

test("CO: ECMC status and class decoded, codes kept; a status word finds its code", async () => {
  const n = norm("CO", { API_Label: "099-99999", WellName: "FOXTAIL 1", wellstat: "PR", well_class: "GW                ", ground_elev: 6100, scout_card_public: "https://ecmc.example/FacilityDetail?api=09999999" });
  assert.equal(n.status, "Producing");
  assert.equal(n.statusCode, "PR");
  assert.equal(n.wellType, "Gas");
  assert.equal(n.wellTypeCode, "GW");
  assert.equal(n.groundElevationFt, 6100);
  assert.match(n.detailUrl, /^https:/);
  assert.match(await where("CO", { status: "Producing" }), /UPPER\(wellstat\) IN \(UPPER\('PR'\)\)/);
  assert.match(await where("CO", { status: "PA" }), /IN \(UPPER\('PA'\)\)/);
});

test("OH: well type decoded from the domain; the relative well-card path is not a URL", async () => {
  const n = norm("OH", { API_NO: "34999999990000", WELL_NAME: "FOXTAIL 1", WELL_TYP: "OG_R", PDF_LINK: "999\\34999999990000.pdf", ELEV_GR: 900 });
  assert.equal(n.wellType, "Oil & Gas");
  assert.equal(n.wellTypeCode, "OG_R");
  assert.equal(n.documentsUrl, null);
  assert.equal(n.wellCardFile, "999/34999999990000.pdf");
  assert.equal(n.groundElevationFt, 900);
  assert.equal(norm("OH", { PDF_LINK: "nowellcard.htm" }).wellCardFile, null);
  assert.match(await where("OH", { well_type: "Oil & Gas" }), /'OG_R'/);
});

test("NM: 9999-12-31 placeholders and zero depths are not data; agency links kept", () => {
  const n = norm("NM", { id: "30-099-99999", name: "FOXTAIL #001", spud_date: 253402239600000, plug_date: 253402239600000, measured_vertical_depth: 0, true_vertical_depth: 0, details: "https://ocd.example/WellDetails.aspx?api=30-099-99999", files: "http://ocd.example/WellFileView.aspx?RefID=1", ulstr: "K-10-18S-33E" });
  assert.equal(n.spudDate, null);
  assert.equal(n.plugDate, null);
  assert.equal(n.depthMD, null);
  assert.equal(n.depthTVD, null);
  assert.equal(n.legalLocation, "K-10-18S-33E");
  assert.match(n.detailUrl, /WellDetails/);
  assert.match(n.wellFileUrl, /WellFileView/);
  // local midnight (07:00Z) is that day
  assert.equal(norm("NM", { spud_date: Date.UTC(2004, 2, 1, 7) }).spudDate, "2004-03-01");
});

test("WY: the 2099 status-date placeholder is dropped", () => {
  assert.equal(norm("WY", { STATUSDATE: 20990909 }).statusDate, null);
  assert.equal(norm("WY", { STATUSDATE: 19621113 }).statusDate, "1962-11-13");
});

test("TX: the county + sequence id is shown as the full 42- API", () => {
  const n = norm("TX", { API: "00399999", GIS_WELL_NUMBER: "1" });
  assert.equal(n.api, "42-003-99999");
  assert.equal(n.apiCountySequence, "00399999");
  assert.equal(norm("TX", { API: null }).api, null);
});

test("SD: placeholder text in URL fields becomes null", () => {
  const n = norm("SD", { API_Number: "40 999 99999", Production_URL: "NO PRODUCTION DATA", core_pics_url: "Not Available", Scanned_Elogs_URL: "https://sd.example/oglogs/4099999999", Kelly_Bushing_Elevation: 3208 });
  assert.equal(n.productionUrl, null);
  assert.equal(n.corePhotosUrl, null);
  assert.match(n.elogsUrl, /oglogs/);
  assert.equal(n.kbElevationFt, 3208);
  assert.equal(urlOrNull("  "), null);
});

test("OR-GEO: -999 sentinels are null; the DOGAMI id is searchable", () => {
  const n = norm("OR-GEO", { WellName_: "1", OtherName: "GP-999", MaximumRec: -999, DepthOfMea: -999, ElevationK: -999, DrillerTot: 218, TWP: "019S", RGE: "012E", Section: 30, PLSS_Merid: "Willamette" });
  assert.equal(n.maxTemperature, null);
  assert.equal(n.temperatureDepth, null);
  assert.equal(n.kbElevation, null);
  assert.equal(n.depth, 218);
  assert.equal(n.otherName, "GP-999");
  assert.equal(n.legalLocation, "T019S R012E S30 WILLAMETTE");
  assert.equal(src("OR-GEO").wellNameAlso, "OtherName");
  assert.equal(notSentinel(-999), null);
  assert.equal(notSentinel(0), 0);
});

test("NV-GEO maps field, function, depths and dates; NV-NBMG takes the exact geometry", () => {
  const n = norm("NV-GEO", { apino: "27-999-99999", wellname: "FT-1", geothermalareaname: "Foxtail Flat", function_: "Observation", drillertotaldepth_m: 2938.577, enddrillingdatetime: Date.UTC(1979, 4, 31), elevationgl_m: 1400.556 });
  assert.equal(n.field, "Foxtail Flat");
  assert.equal(n.function, "Observation");
  assert.equal(n.depthMD, 2938.577);
  assert.equal(n.depthUnit, "m");
  assert.equal(n.endDrillDate, "1979-05-31");
  assert.equal(src("NV-GEO").searchFields.field, "geothermalareaname");
  const b = norm("NV-NBMG", { latitude_wgs84: 39.76, longitude_wgs84: -118.926 }, { x: -118.926218, y: 39.759708 });
  assert.equal(b.latitude, 39.759708);
  assert.equal(b.longitude, -118.926218);
});

test("VA: three DGO layers share one definition; VA-HIST placeholders are null", () => {
  for (const k of ["VA", "VA-PLUGGED", "VA-UNDRILLED"]) {
    assert.equal(src(k).idKind, "id");
    assert.match(src(k).url, /DGO_wells\/MapServer\/[045]$/);
  }
  assert.equal(norm("VA-UNDRILLED", { FiNo: "XX-9999", FiFarm: null, FiOperation: "ZZ-99 W/PL" }).wellName, "ZZ-99 W/PL", "no farm name: the operator's designation");
  assert.equal(src("VA").wellNameAlso, "FiOperation");
  const h = norm("VA-HIST", { Well: "XX-0001", API_Number: "Unknown", Operator: "Unknown", Formation_at_TD: "Unknown", ElevationGL_m: 459.943, Lithology_Log: "Not Available" });
  assert.equal(h.api, null);
  assert.equal(h.operator, null);
  assert.equal(h.formationAtTD, null);
  assert.equal(h.groundElevationM, 459.943);
  assert.equal(h.lithologyLogUrl, null);
  assert.equal(unknownToNull("NULL"), null);
  assert.equal(unknownToNull("Foxtail Oil"), "Foxtail Oil");
});

test("WY-LIVE asks for its first page unsorted; ID-GEO temperatures are in deg F", () => {
  assert.equal(src("WY-LIVE").unsortedFirstPage, true);
  assert.equal(norm("ID-GEO", { WellID: 1, MaxWaterTemp: 180 }).temperatureUnit, "F");
});
