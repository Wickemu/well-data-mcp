// Offline tests for the Canadian and Latin American source definitions: code tables,
// placeholder dates and sentinels, derived fields, and the id / UWI options each layer uses.
// Every well name, id and figure here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { AMERICAS_SOURCES, coDate, referenceUrls, nlStatus } from "../src/sources/americas.js";
import { mbStatusText, MB_HZ, BC_ACTIVITY } from "../src/sources/americas-codes.js";
import { normalizeRecord } from "../src/sources/normalize.js";
import { idTiers, codedClause } from "../src/providers/arcgis.js";
import { parseUwi, uwiForms } from "../src/uwi.js";

process.env.WELL_DATA_CACHE_DIR = "off";

const src = (key) => {
  const s = AMERICAS_SOURCES.find((x) => x.key === key);
  assert.ok(s, `source ${key}`);
  return s;
};

test("americas: Manitoba status in words, horizontal wells decoded from their code", () => {
  assert.equal(mbStatusText({ MAP_STATUS: "Producer", STATUS: "COOP" }), "Producer");
  assert.equal(mbStatusText({ MAP_STATUS: MB_HZ, STATUS: "COOP" }), "Producer");
  assert.equal(mbStatusText({ MAP_STATUS: MB_HZ, STATUS: "susp  coop" }), "Suspended producer");
  assert.equal(mbStatusText({ MAP_STATUS: MB_HZ, STATUS: "ZZZ" }), "ZZZ", "an unknown code stays as it is");
  assert.equal(mbStatusText({ MAP_STATUS: MB_HZ, STATUS: null }), null);
  const mb = src("MB");
  assert.equal(mb.searchFields.status, "STATUS_TEXT");
  const n = normalizeRecord(mb, { LICENCE: 9901, NAME: "Inventa Flats HZ", MAP_STATUS: MB_HZ, STATUS: "WIW", STATUS_TEXT: "Water injection well" }, { x: -101, y: 49.5 });
  assert.equal(n.status, "Water injection well");
  assert.equal(n.statusCode, "WIW");
  assert.equal(n.api, "9901");
  // A copy cached before STATUS_TEXT existed still shows the words.
  assert.equal(normalizeRecord(mb, { LICENCE: 9902, MAP_STATUS: MB_HZ, STATUS: "ABD D" }, null).status, "Dry and abandoned");
});

test("americas: BC status and fluid codes decode, and a status word finds its codes", () => {
  const bc = src("BC");
  const n = normalizeRecord(bc, { UNIQUE_WELL_IDENTIFIER: "200Z099Z099Z0900", WELL_AUTHORITY_NUMBER: "99999", WELL_ACTIVITY: "SUSP", BORE_FLUID_TYPE: "MGAS" }, { x: -121, y: 57 });
  assert.equal(n.status, "Suspended");
  assert.equal(n.statusCode, "SUSP");
  assert.equal(n.wellType, "MGAS", "an ambiguous fluid code stays a code");
  const where = codedClause("WELL_ACTIVITY", "Abandoned", BC_ACTIVITY);
  assert.match(where, /'ABAN'/);
  assert.match(where, /'ABNZ'/);
  assert.doesNotMatch(where, /'SUSP'/);
  assert.match(src("BC-SURFACE").codes.status.WAG, /not drilled/);
});

test("americas: BC well authority numbers go to their own field, padded; UWIs never do", () => {
  const bc = src("BC");
  const [tier] = idTiers(bc, "61");
  assert.match(tier, /WELL_AUTHORITY_NUMBER\) = UPPER\('00061'\)/);
  const [uwiTier] = idTiers(bc, "100999909999W600");
  assert.doesNotMatch(uwiTier, /WELL_AUTHORITY_NUMBER/);
});

test("americas: each Canadian layer looks for a UWI in the form it stores", () => {
  const u = parseUwi("100/06-12-034-05W5/00");
  assert.deepEqual(uwiForms(u, src("SK").uwi.style), ["SK-WI-100061203405W500"]);
  assert.deepEqual(uwiForms(u, src("SK-HZ").uwi.style), ["SK-WI-100061203405W500"]);
  assert.deepEqual(uwiForms(u, src("BC").uwi.style), ["100061203405W500"]);
  assert.deepEqual(uwiForms(u, src("AB").uwi.style), ["06-12-034-05W5"]);
  for (const k of ["AB-GEO-SWANHILLS", "AB-GEO-GRANITEWASH", "AB-GEO-LEDUC"]) assert.equal(src(k).uwi.style, "compact");
  assert.deepEqual(src("MB").uwi, { style: "mb", field: "LOCATION" });
  assert.deepEqual(uwiForms(parseUwi("200/C-012-D/093-P-05/00"), src("BC").uwi.style), ["200C012D093P0500"]);
});

test("americas: Colombia's 1900-01-01 placeholder is dropped, real dates kept", () => {
  assert.equal(coDate(Date.UTC(1900, 0, 1, 5)), null);
  assert.equal(coDate(Date.UTC(1989, 7, 2, 5)), "1989-08-02");
  assert.equal(coDate(null), null);
  const n = normalizeRecord(src("CO-EPIS"), { UWI: "ZZZZ0001", WELL_NAME: "INVENTA-1", WELL_SPUD_: Date.UTC(1900, 0, 1, 5), WELL_DRILL: 9100, WELL_KB_EL: 1001, WELL_GROUN: 0 }, null);
  assert.equal(n.spudDate, null);
  assert.equal(n.depthUnit, "ft");
  assert.equal(n.kbElevationFt, 1001);
  assert.equal(n.groundElevationFt, null);
});

test("americas: Alberta geothermal sentinels (-9999 and -999.99) are dropped", () => {
  const n = normalizeRecord(src("AB-GEO-GRANITEWASH"), { UWI: "100999909999W500", Eltr_pwr: -999.99, Therm_pwr: 0.5, Avg_temp_C: 61.2, KB_el_masl: -9999 }, null);
  assert.equal(n.electricPower, null);
  assert.equal(n.kbElevationM, null);
  assert.equal(n.thermalPower, 0.5);
  assert.equal(n.formationTempC, 61.2);
});

test("americas: Nova Scotia offshore names carry the grid number", () => {
  const ns = src("NS-OFF");
  assert.equal(ns.wellNumberField, "Well_Nam_1");
  const n = normalizeRecord(ns, { Well_Name: "Inventa", Well_Nam_1: "Q-99", Well: "dry hole", Well_1: "P&A", RT_Elevati: 31.5 }, null);
  assert.equal(n.wellName, "Inventa Q-99");
  assert.equal(n.api, "Inventa");
  assert.equal(n.status, "P&A");
  assert.equal(n.result, "dry hole");
  assert.equal(n.rtElevationM, 31.5);
});

test("americas: Newfoundland offshore operations codes decode; '<Null>' and blanks are no status", async () => {
  const nl = src("NL-OFF");
  assert.equal(normalizeRecord(nl, { Unique_Wel: "300Z99", Well_Statu: "DrillingOps" }, null).status, "Drilling Operations");
  assert.equal(normalizeRecord(nl, { Unique_Wel: "300Z99", Well_Statu: "Oil Producer" }, null).status, "Oil Producer");
  assert.equal(nlStatus("<Null>"), null);
  assert.equal(nlStatus(" "), null);
  const where = await nl.filterWhere.status("Suspended");
  assert.match(where, /'SUSPENDED-ING'/i, "the domain code");
  assert.match(where, /LIKE/, "and the plain-text statuses");
});

test("americas: Yukon reference links keep only the URLs", () => {
  assert.equal(referenceUrls("https://example.org/a.pdf; https://example.org/b.pdf; Library hard copy"), "https://example.org/a.pdf; https://example.org/b.pdf");
  assert.equal(referenceUrls("Report to be published"), null);
  assert.equal(referenceUrls(null), null);
});

test("americas: AER licence numbers are zero-padded to seven digits; NETL's too", () => {
  const aer = src("AB-AER-ABANDONED");
  assert.equal(aer.plainSql, true);
  assert.equal(aer.idFormat("4321"), "0004321");
  assert.equal(aer.idFormat(" 0004321 "), "0004321");
  assert.equal(aer.idFormat("Inventa"), "Inventa");
  assert.deepEqual(idTiers(aer, "4321"), ["Well_Licence_Number = '0004321'"]);
  const [tier] = idTiers(src("AB-NAMES-2016"), "4321");
  assert.match(tier, /UPPER\(type\) = UPPER\('0004321'\)/);
});

test("americas: new sources have the fields every source needs", () => {
  for (const key of ["BC-SURFACE", "AB-AER-ABANDONED", "AB-NAMES-2016", "BO-MHE"]) {
    const s = src(key);
    for (const f of ["country", "label", "probe", "agency", "url", "pageMax", "idKind", "extent", "searchFields", "normalize", "caveat"]) assert.ok(s[f] != null, `${key}.${f}`);
  }
  const n = normalizeRecord(src("BO-MHE"), { o_sigla: "ZZZ-X1", o_nombre_pozo: "INVENTA-X1", o_resultados: "NEGATIVO", o_profundidad_md_m: 4012.5, latitud_wgs84: -21.5, longitud_wgs84: -63.9 }, null);
  assert.equal(n.status, "NEGATIVO");
  assert.equal(n.depthUnit, "m");
  assert.equal(n.latitude, -21.5);
});
