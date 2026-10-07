// Offline unit tests (no network). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { apiMatchClauses, likeClause, eqClause } from "../src/providers/arcgis.js";

test("apiMatchClauses: exact, digits, then dash-tolerant county%sequence", () => {
  const [exact, digits, contains] = apiMatchClauses("id", "30-025-36283"); // already dashed: no 3rd eq
  assert.equal(exact, eqClause("id", "30-025-36283"));
  assert.equal(digits, eqClause("id", "3002536283"));
  assert.equal(contains, likeClause("id", "025%36283"));
  const undashed = apiMatchClauses("id", "3002536283");
  assert.equal(undashed[2], eqClause("id", "30-025-36283"));
  assert.equal(undashed[3], likeClause("id", "025%36283"));
  assert.match(contains, /'%025%36283%'/);
});

test("apiMatchClauses: any input shape yields the dash-spanning county%sequence pattern", () => {
  for (const [input, expected] of [
    ["3002536283", "025%36283"], // NM stores 30-025-36283
    ["3301500001", "015%00001"], // ND stores 33-015-00001-00-00
    ["00905201", "009%05201"], // CO stores 009-05201
    ["2700190335", "001%90335"], // NV stores 27-001-90335
    ["33015000010000", "015%00001"], // API-14: county+sequence, not the sidetrack/event digits
    ["500010000200", "001%00002"], // API-12
    ["40 005 05001", "005%05001"], // SD stores space-separated
  ]) {
    assert.equal(apiMatchClauses("f", input).at(-1), likeClause("f", expected), input);
  }
});

test("apiMatchClauses: short inputs degrade to a plain contains on the digits", () => {
  assert.equal(apiMatchClauses("f", "12345").at(-1), likeClause("f", "%12345"));
  assert.equal(apiMatchClauses("f", "5201").at(-1), likeClause("f", "%5201"));
});

test("usDateToIso: CalGEM 'MM/DD/YYYY' strings -> ISO, null-safe, ISO passes, junk -> null", async () => {
  const { usDateToIso, msToIso } = await import("../src/sources/index.js");
  assert.equal(usDateToIso("02/17/1988"), "1988-02-17");
  assert.equal(usDateToIso("5/3/2001"), "2001-05-03");
  assert.equal(usDateToIso("12/07/1999 00:00:00"), "1999-12-07");
  assert.equal(usDateToIso(null), null);
  assert.equal(usDateToIso(""), null);
  assert.equal(usDateToIso("2001-05-03"), "2001-05-03");
  assert.equal(usDateToIso("unknown"), null);
  assert.equal(usDateToIso("13/45/2001"), null);
  assert.equal(usDateToIso(Date.UTC(2001, 4, 3)), "2001-05-03"); // epoch ms, same as msToIso
  assert.equal(msToIso(-703382400000), "1947-09-18"); // CO spud_date sample
  assert.equal(msToIso(null), null);
});

test("CA-OG normalizer emits ISO spudDate", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/sources/index.js");
  const ca = SOURCES.find((s) => s.key === "CA-OG");
  const n = normalizeRecord(ca, { API: "0402120521", LeaseName: "X", WellNumber: "1", SpudDate: "02/17/1988" }, null);
  assert.equal(n.spudDate, "1988-02-17");
});

test("CO normalizer maps county/field/class/dates/depths from the live ECMC schema", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/sources/index.js");
  const co = SOURCES.find((s) => s.key === "CO");
  assert.deepEqual(
    ["api", "well_name", "operator", "county", "field", "status", "well_type"].map((k) => co.searchFields[k]),
    ["API", "WellName", "Operator", "COUNTY", "field_name", "wellstat", "well_class"]
  );
  // attributes exactly as the live layer returned them on 2026-09-15 (note padded well_class)
  const n = normalizeRecord(
    co,
    { API: "001-05000", WellName: "UPRR-JOLLY 1", Operator: "TOMBERLIN* BILL", wellstat: "PA", BASIN: "Denver (DJ) Basin",
      COUNTY: "ADAMS", field_name: "WILDCAT", spud_date: -385430400000, max_m_depth: 5404, max_tv_depth: 0,
      well_class: "DA                       ", status_date: -384825600000 },
    { x: -104.6, y: 39.9 }
  );
  assert.equal(n.county, "ADAMS");
  assert.equal(n.field, "WILDCAT");
  assert.equal(n.wellType, "DA");
  assert.equal(n.spudDate, "1957-10-15");
  assert.equal(n.statusDate, "1957-10-22");
  assert.equal(n.depthMD, 5404);
  assert.equal(n.depthTVD, null); // 0 means not recorded
  assert.equal(n.basin, "Denver (DJ) Basin");
  assert.equal(n.latitude, 39.9);
});

test("apiStateOf routes 10-14 digit API numbers by their API (not FIPS) state prefix", async () => {
  const { apiStateOf, looksLikeUsApi } = await import("../src/api-number.js");
  assert.equal(apiStateOf("43-001-30009"), "UT");
  assert.equal(apiStateOf("4300130009"), "UT");
  assert.equal(apiStateOf("33-015-00001-00-00"), "ND");
  assert.equal(apiStateOf("42-421-30441"), "TX");
  assert.equal(apiStateOf("04-029-12345"), "CA");
  assert.equal(apiStateOf("60-817-40001"), "OCS-GOM");
  assert.equal(apiStateOf("00905201"), null); // county+sequence only: no state prefix
  assert.equal(apiStateOf("9900000000"), null); // unknown prefix
  assert.ok(looksLikeUsApi("30-025-36283"));
  assert.ok(looksLikeUsApi("42130441"));
  assert.ok(!looksLikeUsApi("15/9-19 A")); // Norwegian wellbore name
  assert.ok(!looksLikeUsApi("100/06-12-045-21W4/00")); // Canadian DLS UWI
});

test("geo: extents, radius boxes and the radius trim", async () => {
  const { extentIntersects, radiusToBbox, withinRadius } = await import("../src/geo.js");
  const milford = radiusToBbox(38.5, -112.9, 5000);
  assert.ok(extentIntersects([-114.1, 36.9, -109.0, 42.1], milford)); // UT
  assert.ok(!extentIntersects([-109.1, 31.3, -103.0, 37.1], milford)); // NM
  assert.ok(extentIntersects(null, milford)); // no extent = global
  assert.ok(extentIntersects([[0, 0, 1, 1], [-114.1, 36.9, -109.0, 42.1]], milford)); // multi-box
  const rows = [
    { latitude: 38.5, longitude: -112.9 },
    { latitude: 38.6, longitude: -112.9 }, // ~11 km north
    { latitude: null, longitude: -112.9 },
  ];
  assert.equal(withinRadius(rows, { latitude: 38.5, longitude: -112.9, radiusKm: 5 }).length, 1);
});

test("normalizeRecord blanks empty strings and coerces string coordinates", async () => {
  const { normalizeRecord } = await import("../src/sources/index.js");
  const fake = { normalize: (a) => ({ api: a.id, field: a.f, latitude: a.lat, longitude: a.lon }) };
  const n = normalizeRecord(fake, { id: " 123 ", f: "  ", lat: "38.5", lon: "-112.9" }, null);
  assert.deepEqual(n, { api: "123", field: null, latitude: 38.5, longitude: -112.9 });
});

test("date helpers: European and ISO-ish shapes", async () => {
  const { dmyToIso, isoDate } = await import("../src/sources/index.js");
  assert.equal(dmyToIso("17.02.1988"), "1988-02-17");
  assert.equal(dmyToIso("3/5/2001"), "2001-05-03");
  assert.equal(isoDate("2001-05-03T00:00:00Z"), "2001-05-03");
  assert.equal(isoDate("20010503"), "2001-05-03");
  assert.equal(isoDate(null), null);
  assert.equal(isoDate("2001/5/3"), "2001-05-03");
  assert.equal(dmyToIso("29.04.2004"), "2004-04-29");
  assert.equal(dmyToIso("Ekki skráð"), null); // Icelandic 'not recorded'
  assert.equal(dmyToIso("xx.05.2006"), null);
});

test("namedDateToIso: month names in English and Spanish, 2- and 4-digit years", async () => {
  const { namedDateToIso } = await import("../src/sources/index.js");
  assert.equal(namedDateToIso("16-NOV-2017"), "2017-11-16");
  assert.equal(namedDateToIso("04-DIC-2017"), "2017-12-04");
  assert.equal(namedDateToIso("12-ENE-1998"), "1998-01-12");
  assert.equal(namedDateToIso("7-Jun-67"), "1967-06-07");
  assert.equal(namedDateToIso("3-Mar-19"), "2019-03-03");
  assert.equal(namedDateToIso("Wednesday, April 25, 2001"), "2001-04-25");
  assert.equal(namedDateToIso("December 17, 1972"), "1972-12-17");
  assert.equal(namedDateToIso("17 December 1972"), "1972-12-17");
  assert.equal(namedDateToIso("1999-12-31"), "1999-12-31");
  assert.equal(namedDateToIso("n/a"), null);
});

test("every registered source is complete enough for the tools and the smoke test", async () => {
  const { SOURCES } = await import("../src/sources/index.js");
  const { providerFor } = await import("../src/providers/index.js");
  const keys = new Set();
  for (const s of SOURCES) {
    assert.ok(!keys.has(s.key), `duplicate key ${s.key}`);
    keys.add(s.key);
    assert.match(s.country, /^[A-Z]{2}$/, `${s.key} country`);
    assert.ok(s.label && s.agency && s.url, `${s.key} label/agency/url`);
    assert.ok(["us-api", "id"].includes(s.idKind), `${s.key} idKind`);
    assert.ok(s.searchFields && Object.keys(s.searchFields).length, `${s.key} searchFields`);
    assert.equal(typeof s.normalize, "function", `${s.key} normalize`);
    assert.ok(s.probe && Object.keys(s.probe).every((k) => s.searchFields[k]), `${s.key} probe uses a searchable filter`);
    assert.ok(Number.isInteger(s.pageMax) && s.pageMax > 0, `${s.key} pageMax`);
    assert.ok(providerFor(s), `${s.key} provider`);
    const boxes = s.extent && (Array.isArray(s.extent[0]) ? s.extent : [s.extent]);
    for (const b of boxes ?? []) assert.ok(b.length === 4 && b[0] < b[2] && b[1] < b[3], `${s.key} extent ${b}`);
  }
});

test("numeric API fields match by equality, then on the 10-digit API", async () => {
  const { numericApiClauses } = await import("../src/providers/arcgis.js");
  assert.deepEqual(numericApiClauses("api", "35-001-00002"), ["api = 3500100002"]);
  assert.deepEqual(numericApiClauses("api", "35001000020000"), ["api = 35001000020000", "api = 3500100002"]);
  assert.deepEqual(numericApiClauses("api", "04-029-12345"), ["api = 402912345"]);
});

test("likeClause lets whitespace runs match anything", () => {
  assert.equal(likeClause("Owner", "Energy Geoscience"), "UPPER(Owner) LIKE UPPER('%Energy%Geoscience%')");
});

test("WFS filters: GeoServer CQL with ILIKE, wildcard-safe text and a lon/lat BBOX", async () => {
  const { filterParams } = await import("../src/providers/wfs.js");
  const src = { dialect: "cql", geometryName: "GEOM" };
  const p = filterParams(src, [{ field: "OP", value: "Trias  West_100%", op: "like" }, { field: "ID", value: "nlw-gt-01", op: "eq" }], [4, 51, 5, 52]);
  assert.equal(
    p.CQL_FILTER,
    "OP ILIKE '%Trias%West%100%' AND strToUpperCase(ID) = 'NLW-GT-01' AND BBOX(GEOM, 4, 51, 5, 52, 'EPSG:4326')"
  );
  assert.deepEqual(filterParams({ dialect: "cql" }, [], null), {});
});

test("WFS filters: FES for MapServer - bbox param alone, BBOX inside FILTER when combined", async () => {
  const { filterParams } = await import("../src/providers/wfs.js");
  const src = { dialect: "fes", geometryName: "msGeometry" };
  assert.deepEqual(filterParams(src, [], [-61.9, 15.8, -60.9, 16.6]), { bbox: "15.8,-61.9,16.6,-60.9,urn:ogc:def:crs:EPSG::4326" });
  const { FILTER } = filterParams(src, [{ field: "recherche", value: "géo*thermie", op: "like" }], [-61.9, 15.8, -60.9, 16.6]);
  assert.match(FILTER, /^<fes:Filter .*<fes:And>/);
  assert.match(FILTER, /matchCase="false"><fes:ValueReference>recherche<\/fes:ValueReference><fes:Literal>\*géo!\*thermie\*<\/fes:Literal>/);
  assert.match(FILTER, /<gml:lowerCorner>15.8 -61.9<\/gml:lowerCorner><gml:upperCorner>16.6 -60.9<\/gml:upperCorner>/);
  const eq = filterParams(src, [{ field: "id", value: "A&B", op: "eq" }], null).FILTER;
  assert.match(eq, /<fes:PropertyIsEqualTo><fes:ValueReference>id<\/fes:ValueReference><fes:Literal>A&amp;B<\/fes:Literal>/);
});

test("looseNum reads decimal commas and unit suffixes", async () => {
  const { looseNum, num } = await import("../src/sources/normalize.js");
  assert.equal(looseNum("2209,5"), 2209.5);
  assert.equal(looseNum("967.70 mkb"), 967.7);
  assert.equal(looseNum(""), null);
  assert.equal(num("1,327"), 1327);
});

test("heat flow bundle: loads, filters, radius search nearest-first with summary stats", async () => {
  const { searchHeatFlow, heatflowDataset } = await import("../src/heatflow.js");
  const meta = await heatflowDataset();
  assert.ok(meta && meta.measurements > 80_000, "bundle present with the full release");
  assert.match(meta.license, /CC BY 4\.0/);
  const near = await searchHeatFlow({ near: { latitude: 38.5, longitude: -112.9, radiusKm: 20 }, limit: 5 }); // Milford, UT
  assert.ok(near.matched > 50);
  assert.ok(near.records.every((r, i, a) => i === 0 || a[i - 1].distanceKm <= r.distanceKm), "nearest first");
  assert.ok(near.summary.heatFlow_mW_m2.median > 80, "Roosevelt Hot Springs area runs hot");
  assert.match(near.citation, /Global Heat Flow/);
  const deep = await searchHeatFlow({ purpose: "geothermal", minDepth: 1000, limit: 3 });
  assert.ok(deep.records.every((r) => r.purpose.includes("geothermal") && (r.depthTVD ?? r.depthMD) >= 1000));
  assert.ok(deep.records.every((r, i, a) => i === 0 || a[i - 1].heatFlow >= r.heatFlow), "hottest first without a point");
  const none = await searchHeatFlow({ near: { latitude: 0, longitude: -140, radiusKm: 0.5 } });
  assert.equal(none.matched, 0);
  assert.equal(none.summary, null);
});
