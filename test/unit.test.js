// Offline unit tests (no network). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { apiMatchClauses, likeClause, eqClause } from "../src/arcgis.js";

test("apiMatchClauses: exact, digits, then dash-tolerant county%sequence", () => {
  const [exact, digits, contains] = apiMatchClauses("id", "30-025-36283");
  assert.equal(exact, eqClause("id", "30-025-36283"));
  assert.equal(digits, eqClause("id", "3002536283"));
  assert.equal(contains, likeClause("id", "025%36283"));
  assert.match(contains, /'%025%36283%'/);
});

test("apiMatchClauses: undashed input still yields the dash-spanning pattern", () => {
  for (const [input, expected] of [
    ["3002536283", "025%36283"], // NM stores 30-025-36283
    ["3301500001", "015%00001"], // ND stores 33-015-00001-00-00
    ["00905201", "009%05201"], // CO stores 009-05201
    ["2700190335", "001%90335"], // NV stores 27-001-90335
    ["33015000010000", "000%10000"], // API-14 with the trailing sidetrack/event digits
  ]) {
    assert.equal(apiMatchClauses("f", input)[2], likeClause("f", expected), input);
  }
});

test("apiMatchClauses: short inputs degrade to a plain contains on the digits", () => {
  assert.equal(apiMatchClauses("f", "12345")[2], likeClause("f", "%12345"));
  assert.equal(apiMatchClauses("f", "5201")[2], likeClause("f", "%5201"));
});

test("usDateToIso: CalGEM 'MM/DD/YYYY' strings -> ISO, null-safe, pass-through otherwise", async () => {
  const { usDateToIso, msToIso } = await import("../src/states.js");
  assert.equal(usDateToIso("02/17/1988"), "1988-02-17");
  assert.equal(usDateToIso("5/3/2001"), "2001-05-03");
  assert.equal(usDateToIso("12/07/1999 00:00:00"), "1999-12-07");
  assert.equal(usDateToIso(null), null);
  assert.equal(usDateToIso(""), null);
  assert.equal(usDateToIso("2001-05-03"), "2001-05-03");
  assert.equal(usDateToIso(Date.UTC(2001, 4, 3)), "2001-05-03"); // epoch ms, same as msToIso
  assert.equal(msToIso(-703382400000), "1947-09-18"); // CO spud_date sample
  assert.equal(msToIso(null), null);
});

test("CA-OG normalizer emits ISO spudDate", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/states.js");
  const ca = SOURCES.find((s) => s.key === "CA-OG");
  const n = normalizeRecord(ca, { API: "0402120521", LeaseName: "X", WellNumber: "1", SpudDate: "02/17/1988" }, null);
  assert.equal(n.spudDate, "1988-02-17");
});
