// Offline tests for the Africa/Asia and Oceania source definitions: date parsers, field
// mapping and the GT-4 merge. Every well name and figure here is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AFRICA_ASIA_SOURCES, pasaDate, eqgDate, mergeGt4 } from "../src/sources/africa-asia.js";
import { OCEANIA_SOURCES, nzLocalDate } from "../src/sources/oceania.js";

const src = (key) => [...AFRICA_ASIA_SOURCES, ...OCEANIA_SOURCES].find((s) => s.key === key);
const norm = (key, attrs, g = { x: 10, y: -20 }) => src(key).normalize(attrs, g);

test("pasaDate reads DD/MM/YY with a century pivot, and still reads 4-digit years", () => {
  assert.equal(pasaDate("04/09/97"), "1997-09-04");
  assert.equal(pasaDate("27/11/02"), "2002-11-27");
  assert.equal(pasaDate("15/06/1985"), "1985-06-15");
  assert.equal(pasaDate("0"), null);
  assert.equal(pasaDate("1922-"), null);
  assert.equal(pasaDate("02/76"), null);
  assert.equal(pasaDate("12/28/97"), null); // month 28: garbage, not a date
  assert.equal(pasaDate(null), null);
});

test("ZA-PASA maps the licence block, DD/MM/YY dates, logger depth and trims blanks", () => {
  const w = norm("ZA-PASA", {
    uwi: "ZZ-1", Well_name: "ZZ-1", lease_name: "Block 99", Block: null, Rigrel: "05/04/91", Fin_drillI: "01/04/91",
    Spud_date: "01/02/1991", Depth_md: null, Drillers_TD: 0, Log_TD: 2100, elevation: 0, elevation_: "KB", Final_well: " ", HC_status: " ",
  });
  assert.equal(w.field, "Block 99");
  assert.equal(w.spudDate, "1991-02-01");
  assert.equal(w.tdDate, "1991-04-01");
  assert.equal(w.rigReleaseDate, "1991-04-05");
  assert.equal(w.depthMD, 2100);
  assert.equal(w.result, null);
  assert.equal(w.hydrocarbonStatus, null);
  assert.equal("elevationRef" in w, false); // no elevation, so no reference either
  assert.equal(src("ZA-PASA").searchFields.field, "lease_name");
  const e = norm("ZA-PASA", { elevation: 31.5, elevation_: "RT", Final_well: "Dry well" });
  assert.deepEqual([e.elevationM, e.elevationRef, e.result], [31.5, "RT", "Dry well"]);
});

test("eqgDate: month-first when a time is given, day-first without one", () => {
  assert.equal(eqgDate("8/23/1993 12:00:00 AM"), "1993-08-23");
  assert.equal(eqgDate("10/01/1971 00:00"), "1971-10-01");
  assert.equal(eqgDate("29/11/2003"), "2003-11-29");
  assert.equal(eqgDate("05/02/2004"), "2004-02-05");
  assert.equal(eqgDate(""), null);
  assert.equal(eqgDate(null), null);
  const w = norm("GQ-MMH", { Well_Name: "Imaginary-1", Spud_Date: "3/15/2005 12:00:00 AM", Year: "2005", KBE_m: 25.9 });
  assert.deepEqual([w.spudDate, w.drillYear, w.kbElevationM], ["2005-03-15", 2005, 25.9]);
});

test("JO-MEMR falls back to the short name and searches it too", () => {
  const w = norm("JO-MEMR", { short_well_name: "QQ-7", Full_well_name: null, RTKBM: 812.4, GL_m: 807.1, Spud_Date: "3rd May 1991" });
  assert.equal(w.wellName, "QQ-7");
  assert.equal(w.kbElevationM, 812.4);
  assert.equal(w.groundElevationM, 807.1);
  assert.equal(w.spudDate, "1991-05-03");
  assert.equal(src("JO-MEMR").wellNameAlso, "short_well_name");
  assert.equal(norm("JO-MEMR", { short_well_name: "QQ-8", Full_well_name: "Qasr Imaginary-8" }).wellName, "Qasr Imaginary-8");
});

test("KE-PET is keyed on the well name, not the map row number", () => {
  const s = src("KE-PET");
  assert.equal(s.apiNumeric, undefined);
  assert.equal(s.searchFields.api, "WELL_NAME");
  const w = norm("KE-PET", { KEID_Wells: 7, WELL_NAME: "Zzimaginary-92", DRILLED_IN: "99A ", ELEVATION: "512.5m AMSL" });
  assert.deepEqual([w.api, w.mapId, w.block, w.elevation, w.elevationM], ["Zzimaginary-92", 7, "99A", "512.5m AMSL", 512.5]);
  const blank = norm("KE-PET", { WELL_NAME: "Zzimaginary-93", DRILLED_IN: " ", ELEVATION: "NA" });
  assert.deepEqual([blank.block, blank.elevation, blank.elevationM], [null, null, null]);
});

test("TH-DMF sorts with an OBJECTID tiebreak so pages do not repeat wells", () => {
  assert.match(src("TH-DMF").orderBy, /OBJECTID DESC$/);
});

test("IL-GII maps KB (or RT) and ground elevation, 0 as missing", () => {
  const w = norm("IL-GII", { Name: "IMAGINARY 01", KB: 0, RT: 18.3, GL: 0 });
  assert.deepEqual([w.kbElevationM, w.groundElevationM], [18.3, null]);
});

test("GT-4: merge per-depth files by id, keep the longest clean name, flag implausible temperatures", () => {
  const pt = (id, name, extra) => ({ type: "Feature", geometry: { type: "Point", coordinates: [140.1, 38.2] }, properties: { ID_No: id, Name: name, Refer: "JAEA", Elevation: 120, ...extra } });
  const rows = mergeGt4({
    "0500": { features: [pt("JAEA9001", "Imagin", { T_0500: 40.5 }), pt("TG9002", null, { T_0500: 30 })] },
    "1000": { features: [pt("JAEA9001", "Imaginary�", { T_1000: 70.25 })] },
    "2000": { features: [pt("JAEA9001", "Imag", { T_2000: 455.5 })] },
  });
  assert.equal(rows.length, 2);
  const r = rows.find((x) => x.attrs.ID_No === "JAEA9001");
  assert.equal(r.attrs.Name, "Imaginary");
  assert.deepEqual([r.attrs.T_0500, r.attrs.T_1000, r.attrs.T_1500, r.attrs.T_2000], [40.5, 70.25, undefined, 455.5]);
  assert.deepEqual(r.geometry, { x: 140.1, y: 38.2 });
  const w = src("JP-GSJ-GT4").normalize(r.attrs, r.geometry);
  assert.deepEqual([w.api, w.wellName, w.temp500mC, w.temp1500mC, w.temp2000mC], ["JAEA9001", "Imaginary", 40.5, null, 455.5]);
  assert.match(w.temperatureNote, /temp2000mC 455.5 °C is implausible/);
  const tg = rows.find((x) => x.attrs.ID_No === "TG9002");
  const t = src("JP-GSJ-GT4").normalize({ ...tg.attrs, Elevation: -999 }, tg.geometry);
  assert.deepEqual([t.wellName, t.elevationM, "temperatureNote" in t], [null, null, false]);
});

test("nzLocalDate turns NZ local midnight (11:00Z or 12:00Z the day before) into the local day", () => {
  assert.equal(nzLocalDate(Date.UTC(2011, 0, 14, 11)), "2011-01-15"); // NZDT
  assert.equal(nzLocalDate(Date.UTC(2011, 5, 14, 12)), "2011-06-15"); // NZST
  assert.equal(nzLocalDate(null), null);
  const s = src("NZ-BOP");
  assert.equal(s.searchFields.well_name, "BOPRC_Ref");
  const w = s.normalize({ BOPRC_Ref: "XX123", DrillingDate: Date.UTC(1999, 6, 1, 12), CasingDepth_m: 42 }, null);
  assert.deepEqual([w.spudDate, w.casingDepthM], ["1999-07-02", 42]);
});

test("AU-TAS: Hobart local midnight, spud date only when dated to the day", () => {
  const day = norm("AU-TAS", { DRILL_ID: 1, NAME: "Imaginary 1", DATE_DRILLED: Date.UTC(1975, 2, 3, 14), DATE_ACCURACY: "Day" });
  assert.deepEqual([day.spudDate, day.drillYear], ["1975-03-04", 1975]);
  const summer = norm("AU-TAS", { DATE_DRILLED: Date.UTC(1975, 0, 9, 13), DATE_ACCURACY: "Day" });
  assert.equal(summer.spudDate, "1975-01-10");
  // Before 1895 Hobart kept local mean time (+10:10:44).
  const year = norm("AU-TAS", { DATE_DRILLED: Date.UTC(1880, 11, 31, 14, 10, 44), DATE_ACCURACY: "Year" });
  assert.deepEqual([year.spudDate, year.drillYear, year.dateAccuracy], [null, 1881, "Year"]);
  const undated = norm("AU-TAS", { DATE_DRILLED: null, DATE_ACCURACY: null });
  assert.deepEqual([undated.spudDate, undated.drillYear], [null, null]);
});

test("NZ-WAIKATO treats 1899-12-31 as no date", () => {
  assert.equal(norm("NZ-WAIKATO", { DRILLING_DATE: Date.UTC(1899, 11, 31) }).spudDate, null);
  assert.equal(norm("NZ-WAIKATO", { DRILLING_DATE: Date.UTC(1985, 3, 2) }).spudDate, "1985-04-02");
});

test("NZ-PET maps result, elevation with its reference, rig release and depth unit", () => {
  const w = norm("NZ-PET", { Title: "Imaginary-1", Result_Public: "dry", Elevation: 31.2, Reference_Point: "KB", Datum: "MSL", Rig_Release_Date: Date.UTC(2001, 4, 6, 12), Total_Depth_Public: 2500, Sidetrack: "0" });
  assert.deepEqual([w.result, w.elevationM, w.elevationRef, w.rigReleaseDate, w.depthMD, w.depthUnit, w.sidetrack], ["dry", 31.2, "KB above MSL", "2001-05-06", 2500, "m", null]);
  assert.equal(norm("NZ-PET", { Elevation: null, Reference_Point: "KB" }).elevationRef, null);
});

test("AU-QLD: report URL from company_report_no, logger depth fallback, attribute coordinates", () => {
  const w = norm("AU-QLD-PET", {
    bore_no: 99999, latitude: "-26.123456", longitude: "148.654321", company_report_link: null,
    company_report_no: "https://example.invalid/report/cr000001", total_depth_driller: null, total_depth_logger: 1234.5,
  }, { x: 148.65429, y: -26.12341 });
  assert.deepEqual([w.latitude, w.longitude, w.reportUrl, w.depthMD], [-26.123456, 148.654321, "https://example.invalid/report/cr000001", 1234.5]);
  assert.equal(norm("AU-QLD-CSG", { company_report_no: "CR 1234" }).reportUrl, null);
});

test("AU-NSW: full-precision lat/lon and an operator filter over both fields", () => {
  const s = src("AU-NSW");
  assert.deepEqual(s.alsoSearch, { operator: "operator" });
  const w = s.normalize({ latgda94: -30.123456789, longda94: 150.987654321, operator: null, licence_holder: "Imaginary Gas Pty Ltd" }, { x: 150.9877, y: -30.1235 });
  assert.deepEqual([w.latitude, w.longitude, w.operator], [-30.123456789, 150.987654321, "Imaginary Gas Pty Ltd"]);
  assert.equal(src("AU-NSW-GEO").alsoSearch.operator, "operator");
});

test("AU-GA maps rig release, report page, elevation, basin and searches basin as field", () => {
  const s = src("AU-GA");
  assert.equal(s.searchFields.field, "GEOLOGICAL_PROVINCES");
  const w = s.normalize({ ENO: 1, NAME: "Imaginary 1", ALTERNATE_NAMES: "Imaginary 1", RIG_RELEASE_DATE: "1980-02-03", BOREHOLE_REPORT_URI: "https://example.invalid/bh/1", ELEVATION_M: -61.5, GEOLOGICAL_PROVINCES: "Imaginary Basin", RIG_NAME: "Unknown" }, null);
  assert.deepEqual([w.alias, w.rigReleaseDate, w.reportUrl, w.elevationM, w.basin, w.rig], [null, "1980-02-03", "https://example.invalid/bh/1", -61.5, "Imaginary Basin", null]);
  assert.equal(s.normalize({ NAME: "Imaginary 2", ALTERNATE_NAMES: "Fictional 2" }, null).alias, "Fictional 2");
});

test("AU-NT maps TD date, elevation, rig and drops the '0' ENO", () => {
  const w = norm("AU-NT", { WELLNAME: "Imaginary 1", ENO: "0", DT_DEPTH: "9/14/2015", ELEVATION: "151", DATUM_MEAS: "KB", DRILLRIG: "Rig 9", CONTRACTOR: "Fictional Drilling" });
  assert.deepEqual([w.eno, w.tdDate, w.elevationM, w.elevationRef, w.rig, w.rigContractor], [null, "2015-09-14", 151, "KB", "Rig 9", "Fictional Drilling"]);
  assert.equal(norm("AU-NT", { ENO: "123456", ELEVATION: "0", DATUM_MEAS: "RT" }).elevationRef, null);
  assert.equal(norm("AU-NT", { ENO: "123456" }).eno, "123456");
});
