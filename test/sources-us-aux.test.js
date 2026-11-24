// Offline tests for the AASG geothermal layers (us-geothermal.js), BLM APDs (us-federal.js)
// and FracFocus (fracfocus.js). Every name and figure here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { aasgWellName, aasgDepthReference, iaDetailUrl, iaDriller, AASG_SOURCES } from "../src/sources/us-geothermal.js";
import { FEDERAL_SOURCES } from "../src/sources/us-federal.js";
import { FRACFOCUS_SOURCES } from "../src/sources/fracfocus.js";

process.env.WELL_DATA_CACHE_DIR = "off";

const src = (key) => [...AASG_SOURCES, ...FEDERAL_SOURCES, ...FRACFOCUS_SOURCES].find((s) => s.key === key);

test("AASG well name: the operator prefix comes off, LeaseName gives lease-then-number", () => {
  // CO: '<operator> <number> <lease>'
  assert.equal(aasgWellName({ WellName: "ACME DRLG CO 2 FOXTAIL", Operator: "ACME DRLG CO", LeaseName: "FOXTAIL" }), "FOXTAIL 2");
  assert.equal(aasgWellName({ WellName: "ACME DRLG CO TR 12-34-567 FOXTAIL", Operator: "ACME DRLG CO", LeaseName: "FOXTAIL" }), "FOXTAIL TR 12-34-567");
  // PA: the lease already holds the number, and zero padding does not matter
  assert.equal(aasgWellName({ WellName: "ZEPHYR GAS INC  03  Q R MEADOWLARK", Operator: "ZEPHYR GAS INC", LeaseName: "Q R MEADOWLARK 3" }), "Q R MEADOWLARK 3");
  // IL: '<operator> - <well>', quoted number in LeaseName
  assert.equal(aasgWellName({ WellName: "Quill, B. Ray - Thistlewood 4", Operator: "Quill, B. Ray", LeaseName: 'Thistlewood "4"' }), "Thistlewood 4");
  // MO: no operator prefix
  assert.equal(aasgWellName({ WellName: "Bramble 1", Operator: "Nowhere Petroleum Company", LeaseName: "Bramble  1" }), "Bramble 1");
  // MI: underscore-separated
  assert.equal(aasgWellName({ WellName: "LAKESIDE GAS CO_PINECONE FARMS_1-22", Operator: "LAKESIDE GAS CO" }), "PINECONE FARMS 1-22");
  // WY: operator at the end
  assert.equal(aasgWellName({ WellName: "7 HOLLOW UNIT GRANITE PEAK OIL LP", Operator: "GRANITE PEAK OIL LP" }), "7 HOLLOW UNIT");
});

test("AASG well name: a LeaseName that names another well is ignored, and a bare number keeps the operator", () => {
  assert.equal(aasgWellName({ WellName: "BIRCHWOOD ENERGY CORP 2 OTTERBURN TRUST", Operator: "BIRCHWOOD ENERGY CORP", LeaseName: "MAPLEDENE" }), "2 OTTERBURN TRUST");
  assert.equal(aasgWellName({ WellName: "Fernhill Gas Co. 5 Ida & Max Quarry", Operator: "Fernhill Gas Co.", LeaseName: "Imperial 99999" }), "5 Ida & Max Quarry");
  assert.equal(aasgWellName({ WellName: "ACME OIL CO 1", Operator: "ACME OIL CO" }), "ACME OIL CO 1");
  assert.equal(aasgWellName({ WellName: "11-Q GRANITE PEAK OIL LP", Operator: "GRANITE PEAK OIL LP" }), "11-Q GRANITE PEAK OIL LP");
  // an operator that is only a prefix of the first word is not the operator
  assert.equal(aasgWellName({ WellName: "SMITHFIELD 3", Operator: "SMITH" }), "SMITHFIELD 3");
  // no operator, or an operator that is not in the name (ID: the driller)
  assert.equal(aasgWellName({ WellName: "Larkspur Dairy", Operator: "Pebble Well Drilling" }), "Larkspur Dairy");
  assert.equal(aasgWellName({ WellName: "Sugarloaf 2-1", Operator: null }), "Sugarloaf 2-1");
  assert.equal(aasgWellName({ WellName: "", Operator: "X" }), null);
});

test("AASG normalize: display name, registryName, elevations and depth reference", () => {
  const co = src("CO-BHT");
  const row = co.normalize(
    { WellName: "ACME DRLG CO 2 FOXTAIL", Operator: "ACME DRLG CO", LeaseName: "FOXTAIL", ElevationGL: 5123, ElevationKB: -9999, ElevationDF: 0, DepthReferencePoint: "G.L.", LengthUnits: "ft", LatDegree: 40.1, LongDegree: -104.2 },
    null
  );
  assert.equal(row.wellName, "FOXTAIL 2");
  assert.equal(row.registryName, "ACME DRLG CO 2 FOXTAIL");
  assert.equal(row.groundElevation, 5123);
  assert.equal(row.kbElevation, null);
  assert.equal(row.dfElevation, null); // 0 is a placeholder
  assert.equal(row.depthReference, "GL");
  assert.equal(row.depthUnit, "ft");
  const same = co.normalize({ WellName: "Bramble 1", Operator: "Nowhere Petroleum Company", LeaseName: "Bramble 1" }, null);
  assert.equal(same.registryName, null);
  for (const [v, want] of [["KB", "KB"], ["K", "KB"], ["G.L.", "GL"], ["GL", "GL"], ["DF", "DF"], ["", null], ["nil:missing", null], ["Unknown", null], [null, null]]) {
    assert.equal(aasgDepthReference(v), want, String(v));
  }
});

test("AASG lease-name layers search LeaseName, and keep rows with no LeaseName findable", async () => {
  for (const key of ["CO-BHT", "IL-BHT", "MO-BHT", "PA-BHT"]) {
    assert.equal(src(key).searchFields.well_name, "LeaseName", key);
    assert.equal(typeof src(key).nameWhere, "function", key);
  }
  for (const key of ["WV-BHT", "OH-BHT", "WY-BHT", "IA"]) {
    assert.equal(src(key).searchFields.well_name, "WellName", key);
    assert.equal(src(key).nameWhere, undefined, key);
  }
  // PA / IL / MO: LeaseName holds the number; WellName only where LeaseName is blank
  const pa = await src("PA-BHT").nameWhere("Foxtail 2", 0);
  assert.match(pa, /LeaseName\) LIKE UPPER\('%Foxtail%%2%'\)/);
  assert.match(pa, /LeaseName IS NULL OR LeaseName = ''\) AND UPPER\(WellName\) LIKE/);
  const t3 = await src("IL-BHT").nameWhere("Foxtail 3-34", 3);
  assert.match(t3, /UPPER\(LeaseName\) LIKE UPPER\('%FOXTAIL%'\)/);
  assert.match(t3, /AND UPPER\(WellName\) LIKE UPPER\('%FOXTAIL%'\)/);
  assert.equal(await src("PA-BHT").nameWhere("Foxtail", 3), null); // no such tier
  // CO: LeaseName is the lease alone, so the number is looked for in WellName
  const co = await src("CO-BHT").nameWhere("Foxtail 2", 0);
  assert.match(co, /UPPER\(LeaseName\) LIKE UPPER\('%Foxtail%'\) AND UPPER\(WellName\) LIKE UPPER\('%%2%'\)/);
  assert.match(co, /UPPER\(WellName\) LIKE UPPER\('%Foxtail%%2%'\)/);
  assert.match(await src("CO-BHT").nameWhere("Foxtail RWF 442-10", 2), /WellName/); // the number alone
});

test("IA: GeoSam detail link from the old link or the label, and blank drillers", () => {
  assert.equal(iaDetailUrl({ RelatedResource: "http://www.igsb.uiowa.edu/webapps/geosam/Scripts/geocard.asp?wnumber=424242", Label: "IA-W-424242" }), "https://igs.iihr.uiowa.edu/igs/geosam/well/424242/general-information");
  assert.equal(iaDetailUrl({ RelatedResource: "http://resources.usgin.org/uri-gin/iags/welllog_pdf/NOWHERE/DrillerLogs/w77777/", Label: "IAGS:77777" }), "https://igs.iihr.uiowa.edu/igs/geosam/well/77777/general-information");
  assert.equal(iaDetailUrl({ RelatedResource: "http://programs.iowadnr.gov/pwts/ViewReport.aspx?x", Label: "IA-PWTS-1234567" }), null);
  assert.equal(iaDriller("NULL"), null);
  assert.equal(iaDriller(" unknown "), null);
  assert.equal(iaDriller(""), null);
  assert.equal(iaDriller("PEBBLE WELL CO."), "PEBBLE WELL CO.");
  const row = src("IA").normalize({ WellName: "PEBBLETOWN NO.2", Operator: "PEBBLETOWN, CITY OF", Label: "IA-W-9", Driller: "NULL", RelatedResource: "http://www.igsb.uiowa.edu/webapps/geosam/Scripts/geocard.asp?wnumber=9", ElevationGL: 812, DepthReferencePoint: "GL", LengthUnits: "ft" }, null);
  assert.equal(row.wellName, "PEBBLETOWN NO.2"); // Iowa names water wells after the owner: kept whole
  assert.equal(row.api, "IA-W-9");
  assert.equal(row.driller, null);
  assert.equal(row.groundElevation, 812);
  assert.match(row.detailUrl, /geosam\/well\/9\//);
});

test("US-BLM-NM keeps the surface row of each APD", () => {
  const blm = src("US-BLM-NM");
  assert.equal(blm.dedupeBy, "APD_TRACK_NUM");
  assert.equal(blm.orderBy, "APD_TRACK_NUM DESC, LOCATION DESC, LOC_STATUS");
});

test("FracFocus: one api shape for search rows and full disclosures, with the disclosure id", () => {
  const ff = src("US-FRACFOCUS");
  const search = ff.normalize({ APINumber: "42999123450000", WellName: "Foxtail 1H", pKey: null, JobStartDate: null, JobEndDate: "3/4/2021 12:00:00 AM", TVD: 9876.5 }, null);
  const full = ff.normalize({ APINumber: "42-999-12345-00-00", WellName: "Foxtail 1H", pKey: "00000000-0000-0000-0000-000000000001", JobEndDate: "3/4/2021", TVD: 9876.5, Ingredients: [{}, {}] }, null);
  assert.equal(search.api, "42999123450000");
  assert.equal(full.api, search.api);
  assert.equal("disclosureId" in search, false);
  assert.equal(full.disclosureId, "00000000-0000-0000-0000-000000000001");
  assert.equal(full.jobEndDate, "2021-03-04");
  assert.equal("jobStartDate" in search, false);
  assert.equal(full.ingredientCount, 2);
  assert.equal(ff.normalize({ APINumber: null }, null).api, null);
});
