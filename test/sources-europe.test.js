// Offline tests for the European source definitions: field maps, date and placeholder
// handling, code tables, the EOV grid conversion and the snapshot row builders.
// Every well name, id and figure here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { EUROPE_SOURCES, swissText, skRegNo, ddmmyyyy, gsniYear, nsta, ieDate, BGR_PURPOSE, BGR_STATUS, geusGeothermalWells, hugeoThermalRow } from "../src/sources/europe.js";
import { normalizeRecord } from "../src/sources/normalize.js";
import { eovToWgs84 } from "../src/eov.js";

process.env.WELL_DATA_CACHE_DIR = "off";

const src = (key) => {
  const s = EUROPE_SOURCES.find((x) => x.key === key);
  assert.ok(s, `no source ${key}`);
  return s;
};
const norm = (key, attrs, geometry = { x: 10, y: 50 }) => normalizeRecord(src(key), attrs, geometry);

test("europe: source keys are unique and the new sources are registered", () => {
  const keys = EUROPE_SOURCES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ["DK-GEO", "HU-HUGEO", "HU-HUGEO-GEO"]) assert.ok(keys.includes(k), k);
  for (const s of EUROPE_SOURCES) {
    assert.ok(s.probe && s.searchFields?.api && typeof s.normalize === "function", s.key);
    if (s.kind === "snapshot") assert.equal(typeof s.load, "function", s.key);
  }
});

test("NSTA: the 'No Data Available' placeholder is no value; datum and TD-reached date are kept", () => {
  assert.equal(nsta("No Data Available"), null);
  assert.equal(nsta(" no data available "), null);
  assert.equal(nsta("ZEPHYR FIELD"), "ZEPHYR FIELD");
  const on = norm("GB-NSTA-ON", {
    WELLREGNO: "L99/99- 9",
    NAME: "INVENTED HALL 1",
    SUBAREAOP: null,
    TDOPERATOR: "No Data Available",
    TARGETFLD: "No Data Available",
    DATUMTYPE: "Rotary Table",
    DATELEV_M: 31.729599964326207,
    GRNDELEV_M: 19.5,
    FLOWCLASS: "Dry Hole",
    DATETDREAC: Date.UTC(1990, 4, 6),
  });
  assert.equal(on.operator, null);
  assert.equal(on.field, null);
  assert.equal(on.datumType, "Rotary Table");
  assert.equal(on.datumElevationM, 31.7296);
  assert.equal(on.groundElevationM, 19.5);
  assert.equal(on.result, "Dry Hole");
  assert.equal(on.tdReachedDate, "1990-05-06");
  const off = norm("GB-NSTA-OFF", { WELLREGNO: "99/9- 1", TDOPERATOR: "INVENTED ENERGY LTD", TARGETFLD: "ZEPHYR" });
  assert.equal(off.operator, "INVENTED ENERGY LTD");
  assert.equal(off.field, "ZEPHYR");
  assert.ok(!("groundElevationM" in off));
});

test("Ireland: long-form and day-first dates, rig release, rig, and feet onshore", () => {
  assert.equal(ieDate("Wednesday, April 25, 2001"), "2001-04-25");
  assert.equal(ieDate("04/06/2011"), "2011-06-04"); // day first: 4 June
  assert.equal(ieDate("09/11/1964\n"), "1964-11-09");
  assert.equal(ieDate(null), null);
  const off = norm("IE-OFF", { WELL_NUM: "99/9-1", WELL_SPUD: "14/03/2012", RIGRELEASE: "02/05/2012", RIG_NAME: "Invented Explorer", RIG_DATUM: 81.6, WELL_DEPTH: 4000, UNIT: "Feet" });
  assert.equal(off.spudDate, "2012-03-14");
  assert.equal(off.completionDate, "2012-05-02");
  assert.equal(off.rig, "Invented Explorer");
  assert.equal(off.rigDatum, 81.6);
  assert.equal(off.depthUnit, "ft");
  assert.equal(norm("IE-OFF", { WELL_NUM: "99/9-2", UNIT: "m" }).depthUnit, "m");
  const on = norm("IE-ON", { WELL_NUM: "Inventedbeg-1", WELL_SPUD: "Tuesday, March 9, 1976", WELL_DEPTH: 9000 });
  assert.equal(on.spudDate, "1976-03-09");
  assert.equal(on.depthUnit, "ft"); // the onshore layer has no UNIT field; its depths are feet
});

test("GSNI: full dates and the year of month-only and year-only dates", () => {
  assert.equal(ddmmyyyy("05031961"), "1961-03-05");
  assert.equal(ddmmyyyy("1958"), null);
  assert.equal(gsniYear("05031961"), 1961);
  assert.equal(gsniYear("071966"), 1966);
  assert.equal(gsniYear("1958"), 1958);
  assert.equal(gsniYear(""), null);
  assert.equal(gsniYear("12"), null);
  const r = norm("GB-GSNI", { Borehole_ID: "9ZZ9", BNAME: "INVENTED NO.1", DDATE: "1958" });
  assert.equal(r.spudDate, null);
  assert.equal(r.drillYear, 1958);
});

test("Sodir: plugged dates stored at Oslo midnight land on the right day; entry dates stay UTC", () => {
  const r = norm("NO-SODIR", {
    wlbWellboreName: "99/9-99 A",
    wlbEntryDate: Date.UTC(2009, 8, 21),
    wlbPluggedDate: Date.UTC(2010, 2, 3, 23), // 4 March 2010 00:00 CET
    wlbPluggedAbandonDate: Date.UTC(2018, 7, 11, 22), // 12 August 2018 00:00 CEST
    wlbKellyBushElevation: 37,
    wlbDrillingFacility: "INVENTED RIG ",
    wlbDrillPermit: "9999-P",
    wlbAgeAtTd: "                    ",
  });
  assert.equal(r.spudDate, "2009-09-21");
  assert.equal(r.pluggedDate, "2010-03-04");
  assert.equal(r.pluggedAbandonedDate, "2018-08-12");
  assert.equal(r.kbElevationM, 37);
  assert.equal(r.drillingFacility, "INVENTED RIG");
  assert.equal(r.drillPermit, "9999-P");
  assert.equal(r.ageAtTd, null);
});

test("DE-LBEG: the current field names (OPERATOR_AKT, B_KLASSE_L, A_HOEHE...)", () => {
  const s = src("DE-LBEG");
  assert.equal(s.searchFields.operator, "OPERATOR_AKT");
  assert.equal(s.fesNoEscape, true);
  const r = norm("DE-LBEG", {
    IDENTIFIER: "099999000101",
    LOCHNAME: "Erfundenstedt 7 (1.)",
    OPERATOR_AKT: "Invented Energy GmbH",
    OPERATOR_ORIG: "Invented Erdoel AG",
    B_KLASSE_L: "Produktionsbohrung",
    ATS_E_HORI_L: "Zechstein",
    LOG_DIGITAL: "Ja",
    A_HOEHE: 61.299998474121094,
    WASSERTIEFE: -9999,
    BUNDESLAND: "Niedersachsen",
    ENDTIEFE: 812.6000244140625,
    BOHRENDE: "23.04.1971 00:00:00",
  });
  assert.equal(r.operator, "Invented Energy GmbH");
  assert.equal(r.originalOperator, "Invented Erdoel AG");
  assert.equal(r.wellClass, "Produktionsbohrung");
  assert.equal(r.formationAtTd, "Zechstein");
  assert.equal(r.logs, "Ja");
  assert.equal(r.groundElevationM, 61.3);
  assert.equal(r.waterDepth, null);
  assert.equal(r.stateName, "Niedersachsen");
  assert.equal(r.depthMD, 812.6);
  assert.equal(r.endDrillDate, "1971-04-23");
  // Today's operator missing: fall back to the original one.
  assert.equal(norm("DE-LBEG", { IDENTIFIER: "1", OPERATOR_ORIG: "Invented Erdoel AG", A_HOEHE: -9999 }).operator, "Invented Erdoel AG");
  assert.equal(norm("DE-LBEG", { IDENTIFIER: "1", A_HOEHE: -9999 }).groundElevationM, null);
});

test("DE-BGR: BoreholeML codes decode to labels and keep the code", () => {
  const s = src("DE-BGR");
  assert.equal(s.codes.well_type, BGR_PURPOSE);
  assert.equal(s.codes.status, BGR_STATUS);
  const r = norm("DE-BGR", { gml_ID: "BIS-ZZ_0000ZZ000000", drillingPurpose: "GTH", boreholeStatus: "vf", surfaceLevel: "433,17", lastHorizon: "ZZQ" });
  assert.equal(r.wellType, "Geothermal energy");
  assert.equal(r.wellTypeCode, "GTH");
  assert.equal(r.status, "Backfilled (plugged)");
  assert.equal(r.statusCode, "vf");
  assert.equal(r.elevationM, 433.17);
  assert.equal(r.formationAtTd, "ZZQ");
  // An unknown code stays as published.
  assert.equal(norm("DE-BGR", { gml_ID: "x", drillingPurpose: "QQ" }).wellType, "QQ");
});

test("CH-SWISSTOPO: 'no data' in any case is no value; datum elevation and type are kept", () => {
  assert.equal(swissText("no data"), null);
  assert.equal(swissText("No data"), null);
  assert.equal(swissText(" - "), null);
  assert.equal(swissText("Invented Geo AG"), "Invented Geo AG");
  const r = norm("CH-SWISSTOPO", { name: "Erfunden-1", client: "no data", zgl: "412", zref: "421.5", ref_type_en: "Rotary table", spud: "xx.05.1999" }, null);
  assert.equal(r.operator, null);
  assert.equal(r.groundElevationM, 412);
  assert.equal(r.datumElevationM, 421.5);
  assert.equal(r.datumType, "Rotary table");
  assert.equal(r.drillYear, 1999);
});

test("SK-SGUDS-GEO: 'bez RČ' (no registration number) is no id; structure and elevation are kept", () => {
  assert.equal(skRegNo("bez RČ"), null);
  assert.equal(skRegNo("<Null>"), null);
  assert.equal(skRegNo("ZZ-014"), "ZZ-014");
  const r = norm("SK-SGUDS-GEO", { registracnecislo: "bez RČ", technickeoznaceniezdroja: "ZZ-1", nazovutvaru: "Invented structure", zteren: 142.3, otvorenyusekvrtu: "700-900" });
  assert.equal(r.api, null);
  assert.equal(r.wellName, "ZZ-1");
  assert.equal(r.field, "Invented structure");
  assert.equal(r.elevationM, 142.3);
  assert.equal(r.openIntervalM, "700-900");
});

test("small field maps: NL-NLOG datum and rig, PL-PGI drillYear, DARLINGe local name, BGS-HC dedupe, BE-DOV unknown client", () => {
  const nl = norm("NL-NLOG", { BOREHOLE_CODE: "ZZW-01", BOREHOLE_NAME: "INVENTED WEST-01", REFERENCE_LEVEL: "Rotary Table", REFERENCE_LEVEL_HEIGHT: 6.73, REFERENCE_LEVEL_RELATIVE_TO: "NAP", DRILLING_RIG_OR_PLATFORM: "Invented I", DRILLING_COMPANY: "Invented Drilling Ltd" });
  assert.deepEqual([nl.datumType, nl.datumElevationM, nl.datumRelativeTo, nl.rig, nl.drillingContractor], ["Rotary Table", 6.73, "NAP", "Invented I", "Invented Drilling Ltd"]);
  assert.equal(src("NL-NLOG").wellNameAlso, "BOREHOLE_CODE");
  const pl = norm("PL-PGI", { ID_CBDG: 999, NAZWA: "ZMYŚLONE 1", ROK: 2003, RZEDNA: 71.08, MIEJSCOWOSC: "Zmyślone" });
  assert.equal(pl.drillYear, 2003);
  assert.ok(!("year" in pl));
  assert.equal(pl.elevationM, 71.08);
  assert.equal(pl.locality, "Zmyślone");
  const dar = norm("EU-DARLINGE", { OBJ_ID: "99_9_O", NAME_OBJ: "999999", NAME_LOCAL_OBJ: "9-109", Z_OBJ_local: 93 });
  assert.equal(dar.localName, "9-109");
  assert.equal(dar.elevationM, 93);
  assert.equal(src("EU-DARLINGE").wellNameAlso, "NAME_LOCAL_OBJ");
  assert.equal(src("GB-BGS-HC").dedupeBy, "WELL_ID");
  assert.equal(norm("GB-BGS-HC", { WELL_ID: "L99/99- 1", DETAIL_URL: "http://example.invalid/item1" }).dataItemUrl, "http://example.invalid/item1");
  assert.equal(norm("BE-DOV", { boornummer: "B/9-9", opdrachtgever: "onbekend" }).operator, null);
  assert.equal(norm("DK-GEUS", { well_numb: "9999/99-01", rig: "Invented Epsilon" }).rig, "Invented Epsilon");
});

test("FR-BSS: equality sent as LIKE, the old BSS code as a second id, and a name better than 'S'", () => {
  const s = src("FR-BSS");
  assert.equal(s.eqAsLike, true);
  assert.ok(s.idAlso.test.test("9999ZZ0001/S"));
  assert.ok(!s.idAlso.test.test("BSS009ZZZZ"));
  assert.ok(!s.idAlso.test.test("99/9-19 A"));
  assert.equal(norm("FR-BSS", { bss_id: "BSS009ZZZZ", reference: "9999ZZ0001/S", designation: "S", nom_local: "S" }).wellName, "9999ZZ0001/S");
  assert.equal(norm("FR-BSS", { bss_id: "BSS009ZZZY", reference: "9999ZZ0002/F", designation: "F", nom_local: "GEOTHERMIE INVENTEE 1" }).wellName, "GEOTHERMIE INVENTEE 1");
});

test("DK-GEO: one record per well, every report kept", () => {
  const f = (title, report, x = 9.1, y = 55.1) => ({ properties: { title, summary_sheet: `https://example.invalid/${title}`, report, file_title: `${title} report` }, geometry: { coordinates: [x, y] } });
  const rows = geusGeothermalWells([f("ERFUNDEN-1", "https://example.invalid/r1"), f("ERFUNDEN-1", "https://example.invalid/r2"), f("PÅFUNDEN-2", "https://example.invalid/r3", 10.2, 56.3), { properties: { title: "" } }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attrs.reports.length, 2);
  assert.deepEqual(rows[1].geometry, { x: 10.2, y: 56.3 });
  const n = normalizeRecord(src("DK-GEO"), rows[0].attrs, rows[0].geometry);
  assert.equal(n.api, "ERFUNDEN-1");
  assert.equal(n.wellType, "Geothermal");
  assert.equal(n.reports[1].url, "https://example.invalid/r2");
  assert.equal(n.latitude, 55.1);
});

test("EOV (EPSG:23700) to WGS84: the projection origin, and nulls outside Hungary's grid", () => {
  const o = eovToWgs84(650000, 200000);
  assert.ok(Math.abs(o.latitude - 47.1444) < 0.002, String(o.latitude));
  assert.ok(Math.abs(o.longitude - 19.0486) < 0.002, String(o.longitude));
  // 100 km east of the origin is ~1.3 degrees of longitude at this latitude.
  const east = eovToWgs84(750000, 200000);
  assert.ok(east.longitude - o.longitude > 1.25 && east.longitude - o.longitude < 1.4, String(east.longitude));
  assert.deepEqual(eovToWgs84(100, 200), { latitude: null, longitude: null });
  assert.deepEqual(eovToWgs84("x", 200000), { latitude: null, longitude: null });
});

test("HU-HUGEO-GEO: swapped EOV attributes still give the right point; HU-HUGEO is numeric-id with drillYear", () => {
  const a = hugeoThermalRow({ Heviz_kat: "99-1", MBFH: "Kitalált K-1", EOVX: 650000, EOVY: 200000 });
  const b = hugeoThermalRow({ Heviz_kat: "99-2", MBFH: "Kitalált K-2", EOVX: 200000, EOVY: 650000 });
  assert.deepEqual(a.geometry, b.geometry);
  assert.ok(Math.abs(a.geometry.y - 47.1444) < 0.002);
  assert.equal(hugeoThermalRow({ EOVX: null, EOVY: null }).geometry, null);
  const n = normalizeRecord(src("HU-HUGEO-GEO"), { ...a.attrs, helyi_nev: "<Null>", furas_befej_eve: 1974, talpho: 71 }, a.geometry);
  assert.equal(n.localName, null);
  assert.equal(n.drillYear, 1974);
  assert.equal(n.bottomHoleTempC, 71);
  assert.equal(src("HU-HUGEO").apiNumeric, true);
  const h = norm("HU-HUGEO", { FRS_ID: 999999, JELSZAM: "Kitalált-1", DATUM: 1969, MELYSEG: 1874 });
  assert.equal(h.api, "999999");
  assert.equal(h.drillYear, 1969);
});

test("GL-GEUS: summary-sheet link encoded, TD from the core base, water depth from a negative collar", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/sources/index.js");
  const src = SOURCES.find((s) => s.key === "GL-GEUS");
  const gl = normalizeRecord(
    src,
    { drillhole_identifer: "TESTA#1", report: "https://data.geus.dk/geusmapmore/samba/info_samba.jsp?iSector=GREENLAND&iWellName=TESTA#1", depth_to: "-1234.50", collar_altitude: "-250", start_date: "1999-07-01" },
    { x: -55.1, y: 66.2 }
  );
  assert.match(gl.detailUrl, /iWellName=TESTA%231$/);
  assert.equal(gl.depthMD, 1234.5);
  assert.equal(gl.waterDepth, 250);
  assert.equal(gl.spudDate, "1999-07-01");
});
