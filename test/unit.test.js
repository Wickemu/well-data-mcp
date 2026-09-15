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
