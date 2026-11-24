// Offline unit tests (no network). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { apiMatchClauses, likeClause, eqClause, wellNameWhere, idTiers } from "../src/providers/arcgis.js";
import { splitBore, nameTokens, nameWords, nameScore } from "../src/name-match.js";
import { rankByName } from "../src/search.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WELL_DATA_CACHE_DIR = "off"; // unit tests keep snapshots in memory unless a test opts in

test("apiMatchClauses: exact, digits, then dash-tolerant county%sequence", () => {
  const [exact, digits, contains] = apiMatchClauses("id", "30-025-36283"); // already dashed: no 3rd eq
  assert.equal(exact, eqClause("id", "30-025-36283"));
  assert.equal(digits, eqClause("id", "3002536283"));
  assert.equal(contains, likeClause("id", "025%36283"));
  const undashed = apiMatchClauses("id", "3002536283");
  assert.equal(undashed[2], eqClause("id", "30-025-36283"));
  assert.equal(undashed[3], likeClause("id", "025%36283"));
  assert.match(contains, /'%%025%%36283%'/); // '%02' doubled: firewalls read it as a control character
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

test("normalizeRecord collapses fixed-width padding in names but keeps the id as stored", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/sources/index.js");
  const src = (key) => SOURCES.find((s) => s.key === key);
  // attributes as the live layers returned them on 2026-10-23
  const mt = normalizeRecord(src("MT"), { APIWellNumber: "25015050140000", WellName: "NICHOLS       1" }, null);
  assert.equal(mt.wellName, "NICHOLS 1");
  const ms = normalizeRecord(src("MS"), { API: "2300120730", DispName: "ANNIE G BARNUM         6 6 2300120730" }, null);
  assert.equal(ms.wellName, "ANNIE G BARNUM 6"); // the repeated well number is dropped too
  const oh = normalizeRecord(src("OH"), { API_NO: "34001200010000", WELL_NAME: "ELLISON FRANK     1", WELL_NO: "1" }, null);
  assert.equal(oh.wellName, "ELLISON FRANK 1");
  const uk = normalizeRecord(src("GB-NSTA-OFF"), { WELLREGNO: "15/27-  10" }, null);
  assert.equal(uk.api, "15/27-  10");
  const sa = normalizeRecord(src("AU-SA-PET"), { DHDB: null, WELL_ID: 4421, WELLDISPLAY: "Example Creek 7", SPUDDED: 1045267200000, TD: 2450.5 }, null);
  assert.equal(sa.api, null); // no drillhole number (a confidential well)
  assert.equal(sa.wellId, 4421);
  assert.equal(sa.wellName, "Example Creek 7");
  assert.equal(sa.spudDate, "2003-02-15");
  assert.equal(sa.depthMD, 2450.5);
});

test("CO normalizer maps county/field/class/dates/depths from the live ECMC schema", async () => {
  const { SOURCES, normalizeRecord } = await import("../src/sources/index.js");
  const co = SOURCES.find((s) => s.key === "CO");
  assert.deepEqual(
    ["api", "well_name", "operator", "county", "field", "status", "well_type"].map((k) => co.searchFields[k]),
    ["API_Label", "WellName", "Operator", "County", "field_name", "wellstat", "well_class"]
  );
  // attributes as the live layer returns them (2026-11-12: API undashed, API_Label dashed; note padded well_class)
  const n = normalizeRecord(
    co,
    { API: "00105000", API_Label: "001-05000", WellName: "UPRR-JOLLY 1", Operator: "TOMBERLIN* BILL", wellstat: "PA", BASIN: "Denver (DJ) Basin",
      County: "ADAMS", field_name: "WILDCAT", spud_date: -385430400000, max_m_depth: 5404, max_tv_depth: 0,
      well_class: "DA                       ", status_date: -384825600000 },
    { x: -104.6, y: 39.9 }
  );
  assert.equal(n.api, "001-05000");
  assert.equal(n.county, "ADAMS");
  assert.equal(n.field, "WILDCAT");
  assert.equal(n.wellType, "Dry and abandoned"); // ECMC class code decoded
  assert.equal(n.wellTypeCode, "DA");
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

test("snapshot provider: accent-insensitive word search, ids, radius, distinct, caching", async () => {
  const { snapshotProvider: p, containsWords } = await import("../src/providers/snapshot.js");
  assert.ok(containsWords("Geothermie Genève", "geneve"));
  assert.ok(containsWords("ENERGY  GEOSCIENCE INST", "energy geoscience"));
  assert.ok(!containsWords("Geoscience Energy", "energy geoscience"), "words must appear in order");
  let loads = 0;
  const src = {
    key: "TEST-SNAP",
    searchFields: { api: "name", well_name: "name", operator: "client", status: "status" },
    load: async () => {
      loads++;
      return [
        { attrs: { name: "Basel-1", client: "Geopower Basel AG", status: "Open" }, geometry: { x: 7.5956, y: 47.5854 } },
        { attrs: { name: "Basel-2", client: "Geopower Basel AG", status: "Plugged" }, geometry: { x: 7.6, y: 47.59 } },
        { attrs: { name: "Genève GEo-01", client: "SIG", status: "Open" }, geometry: { x: 6.1, y: 46.2 } },
      ];
    },
  };
  assert.equal((await p.search(src, { operator: "geopower basel" }, { limit: 1 })).moreAvailable, true);
  assert.deepEqual((await p.search(src, { operator: "basel", status: "open" }, { limit: 10 })).rows.map((r) => r.attrs.name), ["Basel-1"]);
  assert.deepEqual((await p.search(src, { well_type: "x" }, { limit: 10 })).unsupported, ["well_type"]);
  assert.deepEqual((await p.findById(src, "basel-1")).map((r) => r.attrs.name), ["Basel-1"], "exact id first");
  assert.equal((await p.findById(src, "geneve")).length, 1, "then contains");
  const near = await p.search(src, {}, { limit: 10, near: { latitude: 47.5854, longitude: 7.5956, radiusKm: 1 } });
  assert.equal(near.rows.length, 2);
  assert.equal((await p.count(src, { status: "open" })).count, 2);
  assert.deepEqual(await p.distinct(src, "operator", "basel"), ["Geopower Basel AG"]);
  assert.equal(loads, 1, "loaded once, then served from memory");
});

test("fracFocusApi: the 14 or 10 digits FracFocus accepts, from any API format", async () => {
  const { fracFocusApi } = await import("../src/providers/fracfocus.js");
  assert.equal(fracFocusApi("42-317-40237"), "4231740237");
  assert.equal(fracFocusApi("42-317-40237-00-00"), "42317402370000");
  assert.equal(fracFocusApi("423174023700"), "4231740237"); // API-12: drop the sidetrack digits
  assert.equal(fracFocusApi("31740237"), null); // county + sequence only
});

test("localMidnightToIso: local midnight stored as UTC rounds to the right day; placeholders drop", async () => {
  const { localMidnightToIso } = await import("../src/sources/normalize.js");
  assert.equal(localMidnightToIso("2006-01-27T03:00:00.761Z"), "2006-01-27"); // Neuquén, UTC-3
  assert.equal(localMidnightToIso(-1460491200000), "1923-09-21"); // Bolivia, UTC-4 (04:00Z)
  assert.equal(localMidnightToIso(Date.UTC(2999, 11, 31)), null); // planned-well placeholder
  assert.equal(localMidnightToIso(null), null);
});

test("numericApiClauses width14: 10/12/14-digit APIs match a 14-digit integer field", async () => {
  const { numericApiClauses } = await import("../src/providers/arcgis.js");
  assert.deepEqual(numericApiClauses("f", "01-003-01005", true), ["f = 1003010050000"]);
  assert.deepEqual(numericApiClauses("f", "37003004340001", true), ["f = 37003004340001", "f = 37003004340000"]);
  assert.deepEqual(numericApiClauses("f", "3700300434"), ["f = 3700300434"]); // default: as stored
});

test("envelopeParams: the circle's bounding box for servers that ignore distance", async () => {
  const { envelopeParams } = await import("../src/providers/arcgis.js");
  const p = envelopeParams(43.24, 10.88, 5000);
  const g = JSON.parse(p.geometry);
  assert.equal(p.geometryType, "esriGeometryEnvelope");
  assert.ok(g.xmin < 10.88 && g.xmax > 10.88 && g.ymin < 43.24 && g.ymax > 43.24);
  assert.ok(Math.abs(g.ymax - 43.24 - 5000 / 111_320) < 1e-9);
});

test("utmToLatLon inverts UTM (checked against agency lat/lon)", async () => {
  const { utmToLatLon } = await import("../src/geo.js");
  const ns = utmToLatLon(640456, 5107451, 20); // Nova Scotia P-1, zone 20N
  assert.ok(Math.abs(ns.latitude - 46.10618) < 1e-4 && Math.abs(ns.longitude - -61.18259) < 1e-4);
  const bo = utmToLatLon(359818.0027, 7486514.0074, 20, true); // Bolivia BERMEJO-X2, zone 20S
  assert.ok(Math.abs(bo.latitude - -22.72286) < 1e-5 && Math.abs(bo.longitude - -64.36501) < 1e-5);
});

test("readDbf reads character, numeric and date fields and skips deleted rows", async () => {
  const { readDbf } = await import("../src/dbf.js");
  const fields = [["NAME", "C", 10], ["LICENCE", "N", 6], ["STATUS_DAT", "D", 8]];
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, f) => n + f[2], 0);
  const rows = [[" ", "Tundra 1", "905", "19550816"], ["*", "gone", "1", "20000101"], [" ", "Melita", "12324", ""]];
  const buf = Buffer.alloc(headerLen + rows.length * recordLen + 1, 0x20);
  buf.writeUInt8(3, 0);
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt16LE(headerLen, 8);
  buf.writeUInt16LE(recordLen, 10);
  fields.forEach(([name, type, len], i) => {
    const p = 32 + i * 32;
    buf.fill(0, p, p + 32);
    buf.write(name, p, "latin1");
    buf.write(type, p + 11, "latin1");
    buf.writeUInt8(len, p + 16);
  });
  buf.writeUInt8(0x0d, headerLen - 1);
  rows.forEach((r, i) => {
    let p = headerLen + i * recordLen;
    buf.write(r[0], p++, "latin1");
    fields.forEach(([, , len], j) => {
      buf.write(r[j + 1].padEnd(len), p, "latin1");
      p += len;
    });
  });
  assert.deepEqual(readDbf(buf), [
    { NAME: "Tundra 1", LICENCE: 905, STATUS_DAT: "1955-08-16" },
    { NAME: "Melita", LICENCE: 12324, STATUS_DAT: null },
  ]);
});

// ---------------------------------------------------------------- well names

test("splitBore: sidetrack and redrill suffixes come off, plain names stay whole", () => {
  assert.deepEqual(splitBore("Juniper 1 ST1"), { base: "JUNIPER 1", bore: "ST1" });
  assert.deepEqual(splitBore("Alder Unit B 27X-15 Redrill"), { base: "ALDER UNIT B 27X-15", bore: "RD" });
  assert.deepEqual(splitBore("K&L 2-9 RD1"), { base: "K&L 2-9", bore: "RD1" });
  assert.deepEqual(splitBore("D-120ST2"), { base: "D-120", bore: "ST2" });
  assert.deepEqual(splitBore("12K4-3QV/ST2"), { base: "12K4-3QV", bore: "ST2" });
  assert.deepEqual(splitBore("Elm St 4"), { base: "ELM ST 4", bore: null });
  assert.deepEqual(splitBore("County Rd"), { base: "COUNTY RD", bore: null }); // no digit left: not a redrill
});

test("nameTokens / nameWords: punctuation, '#', 'No.' and zero padding fold away", () => {
  assert.deepEqual(nameTokens("07K_0815TX"), ["7", "K", "815", "TX"]);
  assert.deepEqual(nameTokens("Fairview No. 3"), nameTokens("FAIRVIEW #03"));
  assert.deepEqual(nameTokens("Unspecified RT-5XY"), ["RT", "5", "XY"]); // placeholder lease dropped
  assert.deepEqual(nameTokens("Well"), ["WELL"]); // ...unless nothing else is left
  assert.deepEqual(nameWords("K&L 02-9"), ["K", "L", "2", "9"]);
  assert.deepEqual(nameWords("A01 1001"), ["A", "1", "1001"]); // only leading zeros are padding
});

test("nameScore: the same well under the names registries and rigs give it", () => {
  const split = (lease, number) => ({ lease, number });
  assert.equal(nameScore("07K 0412K", split("7K", "0412K")), 1);
  assert.equal(nameScore("Sam Porter 2", { name: "Sam Porter #02" }), 1);
  assert.equal(nameScore("6-KH", split("Maya", "6-KH")), 0.9); // lease left off
  assert.equal(nameScore("Hot Creek 47A(P)-26", { name: "Well 47A(P)-26" }), 0.85); // registry has the number only
  assert.equal(nameScore("Canyon JV 12H-30", split("J.V.", "12H-30")), 0.95); // dotted initials are one word
  assert.equal(nameScore("RVF 62-30", split("CA-12345", "62-30")), 0.7); // filed under a federal lease number
  assert.equal(nameScore("Miller Trust 54X-9", split("Miller Trusts", "54X-9")), 0.95);
  assert.equal(nameScore("Sam Porter", { name: "Sam Porter #15" }), 0.6); // lease only
  assert.equal(nameScore("Port", { name: "Sam Porter #15" }), 0.5); // plain contains
  // different wells
  assert.ok(nameScore("Sam Porter 2", { name: "Sam Porter #12" }) < 0.3);
  assert.ok(nameScore("Section 4 17", split("Section 4", "41-7")) < 0.3);
  assert.ok(nameScore("State 4", split("Fee", "4")) < 0.5); // a bare '4' proves little
  assert.equal(nameScore("Gov't 77", { name: "Govt 77" }), 1);
  assert.equal(nameScore("K418", split("Lease by Harbor Oil Co.", "K-418")), 1); // placeholder lease set aside
  assert.equal(nameScore("Section 4 5-6", split("Unspecified", "5-6")), 0.5); // a short number under a placeholder lease
  assert.ok(nameScore("RK-28", { name: "Parkfield-28" }) < 0.5); // two letters inside a longer word are not a match
  // initials and compass words
  assert.equal(nameScore("PCU D1", split("Pine Creek Unit", "D1")), 0.95);
  assert.equal(nameScore("West Harbor 2", { name: "W HARBOR 2" }), 1);
  assert.equal(nameScore("Garnet 4B", split("Garnet", "4")), 0.85); // a letter suffix the registry leaves off
  assert.equal(nameScore("OCS-P 0999 K-1", { name: "K001" }), 0.5); // 'K 1' is too little to stand alone
  // sidetracks: set aside, then used as a tie-breaker
  assert.equal(nameScore("Juniper 1 ST1", { name: "Juniper 1" }), 1);
  assert.ok(nameScore("Carver 1 RD2", { name: "Carver 1 RD2" }) > nameScore("Carver 1 RD2", { name: "Carver 1 RD1" }));
});

test("wellNameWhere: as typed first, then forgiving, then the number, then the longest word", () => {
  const single = { searchFields: { well_name: "NAME" } };
  const splitSrc = { searchFields: { well_name: "LEASE" }, wellNumberField: "NUM" };
  // tier 0: the text as typed
  assert.equal(wellNameWhere(single, "Sam Porter #02 ST1"), "UPPER(NAME) LIKE UPPER('%Sam%Porter%#02%ST1%')");
  assert.equal(
    wellNameWhere(splitSrc, "Section 4 20"),
    "(UPPER(LEASE) LIKE UPPER('%Section%%4%%20%') OR UPPER(NUM) LIKE UPPER('%Section%%4%%20%') OR (UPPER(LEASE) LIKE UPPER('%Section%%4%') AND UPPER(NUM) LIKE UPPER('%%20%')) OR (UPPER(LEASE) LIKE UPPER('%Section%') AND UPPER(NUM) LIKE UPPER('%%4%%20%')))"
  );
  // tier 1: forgiving
  assert.equal(wellNameWhere(single, "Sam Porter #02 ST1", 1), "UPPER(NAME) LIKE UPPER('%SAM%PORTER%%2%')");
  assert.equal(wellNameWhere(single, "Juniper 1", 1), null); // nothing to forgive: would repeat tier 0
  const loose = wellNameWhere(splitSrc, "State PRC 310-512K", 1);
  assert.match(loose, /UPPER\(LEASE\) LIKE UPPER\('%STATE%PRC%%310%'\) AND UPPER\(NUM\) LIKE UPPER\('%%512%K%'\)/);
  assert.match(loose, /^\(UPPER\(LEASE\) LIKE UPPER\('%STATE%PRC%%310%%512K%'\) OR UPPER\(NUM\) LIKE /);
  assert.match(wellNameWhere(splitSrc, "K418", 1), /UPPER\(NUM\) LIKE UPPER\('%K%%418%'\)/); // the registry writes K-418
  // tier 2: the well number alone
  assert.equal(wellNameWhere(single, "Hot Creek 47A(P)-26", 2), "UPPER(NAME) LIKE UPPER('%%47A%P%%26%')");
  assert.equal(wellNameWhere(single, "Sam Porter 2", 2), null); // '2' is not distinctive
  assert.equal(wellNameWhere(splitSrc, "RVF 62-30", 2), "UPPER(NUM) LIKE UPPER('%%62%%30%')");
  assert.equal(wellNameWhere(splitSrc, "62-30", 2), null); // nothing to drop: already asked
  assert.equal(wellNameWhere(splitSrc, "22K-0450BT", 2), "UPPER(NUM) LIKE UPPER('%%450%BT%')"); // the last run is enough
  // tier 3: the longest word
  assert.equal(wellNameWhere(splitSrc, "West Harbor 2", 3), "UPPER(LEASE) LIKE UPPER('%HARBOR%')");
  assert.equal(wellNameWhere(splitSrc, "Section 4 5-8", 3), null); // 'Section' alone says nothing
  assert.equal(wellNameWhere(splitSrc, "Garnet 4B", 4), null);
});

test("rankByName: best name first; rows a loosened filter let through are dropped", () => {
  const source = { searchFields: { well_name: "LEASE" }, wellNumberField: "NUM", normalize: (a) => ({ wellName: `${a.LEASE} ${a.NUM}` }) };
  const rows = [
    { attrs: { LEASE: "Section 4", NUM: "20-9" } },
    { attrs: { LEASE: "Section 46 Unit", NUM: "120" } },
    { attrs: { LEASE: "Section 4", NUM: "20" } },
  ];
  const ranked = rankByName(source, "Section 4 20", rows);
  assert.deepEqual(ranked.map((r) => [r.row.attrs.NUM, r.score]), [["20", 1], ["20-9", 0.6]]);
});

test("idTiers: one IN query for every exact API form, then the dash-tolerant contains; own ids exact only", () => {
  const src = { idKind: "us-api", searchFields: { api: "API" } };
  const [bores, exact, loose, ...rest] = idTiers(src, "04-311-29999");
  assert.equal(bores, "API LIKE '0431129999%'", "a 10-digit API asks for every bore of the well first (sidetracks, the live bore)");
  assert.equal(idTiers(src, "043112999901")[0].startsWith("UPPER(API) IN"), true, "a 12-digit API is one bore: exact forms only");
  assert.equal(exact, "UPPER(API) IN (UPPER('04-311-29999'), UPPER('0431129999'), UPPER('043112999900'), UPPER('04311299990000'))");
  assert.equal(loose, likeClause("API", "311%29999"));
  assert.equal(rest.length, 0);
  assert.doesNotMatch(exact, / OR /); // firewalls reject OR-joined equality
  assert.deepEqual(idTiers({ idKind: "us-api", apiNumeric: true, searchFields: { api: "N" } }, "04-029-1234500"), ["N IN (40291234500, 402912345)"]);
  // A source's own ids: the exact form only here; findById then compares tokens (never a bare contains).
  assert.deepEqual(idTiers({ idKind: "id", searchFields: { api: "UWI" } }, "15/9-19 A"), [eqClause("UWI", "15/9-19 A")]);
  // A numeric-id source: a name with letters is none of its ids; digits with punctuation still are.
  assert.deepEqual(idTiers({ idKind: "id", apiNumeric: true, searchFields: { api: "N" } }, "Moomba 1"), []);
  assert.deepEqual(idTiers({ idKind: "id", apiNumeric: true, searchFields: { api: "N" } }, "12-345"), ["N = 12345"]);
  // A second id field, padded the way the layer stores it.
  assert.deepEqual(idTiers({ idKind: "id", idAlso: { field: "WA", test: /^\d{1,5}$/, pad: 5 }, searchFields: { api: "UWI" } }, "61"), [`(${eqClause("UWI", "61")} OR ${eqClause("WA", "00061")})`]);
});

test("snapshot disk cache: a new process starts from the saved copy and survives an outage", async () => {
  const { snapshotProvider: p, forgetSnapshots } = await import("../src/providers/snapshot.js");
  const dir = await mkdtemp(join(tmpdir(), "well-data-test-"));
  process.env.WELL_DATA_CACHE_DIR = dir;
  try {
    let loads = 0;
    const rows = [{ attrs: { name: "Basel-1" }, geometry: { x: 7.6, y: 47.6 } }];
    const src = { key: "TEST/DISK", searchFields: { api: "name", well_name: "name" }, load: async () => (loads++, rows) };
    assert.equal((await p.count(src, {})).count, 1);
    await forgetSnapshots();
    assert.deepEqual(await readdir(dir), ["TEST_DISK.json"], "saved under a file-safe name");
    assert.equal((await p.count(src, {})).count, 1);
    assert.equal(loads, 1, "second process read the disk copy instead of downloading again");
    await forgetSnapshots();
    const down = { ...src, ttlMs: 0, load: async () => { throw new Error("server down"); } };
    assert.deepEqual((await p.findById(down, "Basel-1")).map((r) => r.attrs.name), ["Basel-1"], "expired copy still served when the refresh fails");
    await forgetSnapshots();
    process.env.WELL_DATA_CACHE_DIR = "off";
    await assert.rejects(p.count(down, {}), /server down/, "no cache, no copy: the error surfaces");
  } finally {
    process.env.WELL_DATA_CACHE_DIR = "off";
    await forgetSnapshots();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- match_well

test("parseDateHint: ISO, US, month-name dates and bare years", async () => {
  const { parseDateHint } = await import("../src/match.js");
  assert.deepEqual(parseDateHint("2023-08-18"), { iso: "2023-08-18" });
  assert.deepEqual(parseDateHint("Aug 18, 2023"), { iso: "2023-08-18" });
  assert.deepEqual(parseDateHint("8/18/2023"), { iso: "2023-08-18" });
  assert.deepEqual(parseDateHint("2011"), { year: 2011 });
  assert.equal(parseDateHint("soon"), null);
  assert.equal(parseDateHint(""), null);
});

test("scoreCandidate: name and location decide, spud sharpens, the operator only adds", async () => {
  const { scoreCandidate, confidenceOf, wellKey, worthShowing, hintText, numberParts, mainNumber } = await import("../src/match.js");
  const known = {
    names: ["07K 0412K"],
    operator: "Acme",
    field: "Cedar Flat",
    near: { latitude: 35.1, longitude: -119.4, radiusKm: 2 },
    spud: { iso: "2020-03-10" },
  };
  const right = { source: "CA-OG", country: "US", api: "0402900001", wellName: "7K 0412K", operator: "Acme Oil U.S.A. Inc.", field: "Cedar Flat", latitude: 35.1, longitude: -119.4, spudDate: "2020-03-09" };
  const neighbour = { ...right, api: "0402900002", wellName: "7K 0612Z", latitude: 35.1009, spudDate: "2013-02-17" };
  const a = scoreCandidate(known, right);
  const b = scoreCandidate(known, neighbour);
  assert.equal(a.score, 1);
  assert.deepEqual(a.evidence, { name: 1, distanceKm: 0, spudDaysApart: 1, operator: "agrees", field: "agrees" });
  assert.ok(b.score < 0.6, "same pad, different well: the name and spud date tell them apart");
  assert.equal(confidenceOf([a, b]), "strong");
  assert.equal(confidenceOf([a, { ...a }]), "ambiguous", "two records that fit equally");
  assert.equal(confidenceOf([]), "none");
  // a neighbour on the same pad scores close on position alone; the name tells them apart
  const sameSpot = { ...known, spud: null };
  const exact = scoreCandidate(sameSpot, { ...right, spudDate: null });
  const sibling = scoreCandidate(sameSpot, { ...right, api: "0402900003", wellName: "7K 0412", spudDate: null });
  assert.ok(exact.score - sibling.score < 0.1 && exact.evidence.name - sibling.evidence.name >= 0.1);
  assert.equal(confidenceOf([exact, sibling]), "strong");
  assert.equal(mainNumber("KR3456HB-78"), "3456");
  assert.equal(mainNumber("Ridge 0412K ST1"), "412");
  assert.equal(mainNumber("Section 4 5-6"), null);
  // a name alone, however exact and unique, is one line of evidence
  assert.equal(confidenceOf([scoreCandidate({ names: ["Juniper 1"] }, { wellName: "Juniper 1" })]), "probable");
  assert.equal(hintText("Acme Western Oil Corp."), "ACME WESTERN");
  assert.equal(hintText("N. Coyote Hills"), "COYOTE HILLS");
  assert.deepEqual(numberParts("Opal 310-512 ST1"), ["310-512"]);
  assert.deepEqual(numberParts("Section 4 5-6"), ["4 5-6", "5-6"]);
  assert.deepEqual(numberParts("310-512"), []);
  assert.deepEqual(numberParts("Kettleman North Dome"), []);
  // a different operator never lowers the score
  assert.equal(scoreCandidate({ names: ["Juniper 1"], operator: "Summit" }, { wellName: "Juniper 1", operator: "Valley Resources" }).score, 1);
  // a name search saw lease and number apart: its score stands when the joined name reads worse
  assert.equal(scoreCandidate({ names: ["RVF 62-30"] }, { wellName: "CA-12345 62-30" }, 0.7).evidence.name, 0.7);
  // the same US well from two sources is one candidate; other ids stay per source
  assert.equal(wellKey({ source: "UT", country: "US", api: "4300130001" }), wellKey({ source: "UT-BHT", country: "US", api: "43-001-30001-0000" }));
  assert.notEqual(wellKey({ source: "NO-SODIR", country: "NO", api: "15/9-19 A" }), wellKey({ source: "GB-NSTA-OFF", country: "GB", api: "15/9-19 A" }));
  assert.ok(worthShowing({ evidence: { name: 0.1, distanceKm: 0.05 } }) && !worthShowing({ evidence: { name: 0.1, distanceKm: 1.2 } }));
});

test("scoreCandidate: county and field count for and against a US well, never on placeholders", async () => {
  const { scoreCandidate, confidenceOf, derivedNames, lastNumber, numberParts } = await import("../src/match.js");
  const known = { names: ["Quintal 4"], county: "Inventa", field: "Example Flat" };
  const us = { source: "CA-OG", country: "US", wellName: "Quintal 4" };
  const elsewhere = scoreCandidate(known, { ...us, county: "Elsewhere" });
  assert.equal(elsewhere.score, 0.75, "another county costs a US well");
  assert.equal(elsewhere.evidence.county, "differs");
  assert.equal(scoreCandidate(known, { ...us, county: "Inventa", field: "Example Flat" }).rank, 1.1, "county and field agree: +0.05 each");
  assert.equal(scoreCandidate(known, { ...us, source: "NO-SODIR", country: "NO", county: "Elsewhere" }).score, 1, "outside the US a differing county costs nothing");
  assert.deepEqual(scoreCandidate({ ...known, areaCounty: new Set(["AK"]) }, { ...us, source: "AK", county: "Some Basin" }).evidence, { name: 1 }, "a basin in the county slot is not compared");
  assert.deepEqual(scoreCandidate(known, { ...us, field: "Wildcat" }).evidence, { name: 1 }, "a placeholder field is no evidence");
  assert.deepEqual(scoreCandidate(known, { ...us, field: "QXZRT" }).evidence, { name: 1 }, "nor is an undecoded field code");
  assert.equal(scoreCandidate({ names: ["Quintal 4"] }, { ...us, status: "Permit Cancelled" }).score, 0.95, "a cancelled permit ranks below a drilled well");
  // a best candidate in another county is at most ambiguous, unless the position agrees
  const top = { score: 1, rank: 0.8, evidence: { name: 1, county: "differs" } };
  assert.equal(confidenceOf([top]), "ambiguous");
  assert.equal(confidenceOf([{ ...top, evidence: { ...top.evidence, distanceKm: 0.1 } }]), "strong");
  // other readings of a working name, and its last number
  assert.deepEqual(derivedNames("512-14Q"), ["512"]);
  assert.deepEqual(derivedNames("22D-3047"), ["3047"]);
  assert.deepEqual(derivedNames("ZK4410H-2"), ["4410H-2"]);
  assert.deepEqual(derivedNames("Ironbark IW-4"), ["IRONBARK INJ-4"]);
  assert.deepEqual(derivedNames("31-6H"), [], "an H is the well's own");
  assert.equal(lastNumber("Quill QX-214"), "214");
  assert.equal(lastNumber("State 7720-06"), "6");
  assert.deepEqual(numberParts("Ironbark IW 5"), ["IW 5", "5"], "a short designator goes with its number");
});

test("nameScore: descriptor words, aliases, bracketed alternatives and suffix letters", async () => {
  const { nameScore, splitBore } = await import("../src/name-match.js");
  assert.equal(nameScore("Inventa Production Well 21-7", { name: "Inventa 21-7" }), 1, "what kind of well it is says nothing about which");
  assert.equal(nameScore("Quintal IW-3", { name: "Quintal Inj 3" }), 1);
  assert.equal(nameScore("Quintal 58(23)-11", { name: "Quintal 58-11" }), 1);
  assert.equal(nameScore("Quintal 58(23)-11", { name: "Quintal 23-11" }), 0.95, "the bracketed number counts a shade less");
  assert.equal(nameScore("Quintal 58-11", { name: "Quintal 58B-11" }), 0.7, "a letter the name lacks is another well");
  assert.equal(nameScore("Quintal 58B-11", { name: "Quintal 58-11" }), 0.85, "the other way round is shorthand");
  assert.equal(nameScore("Q.R. Inventa 2", { name: "QR Inventa 2" }), 1);
  assert.deepEqual(splitBore("Quintal 3-9 WO"), { base: "QUINTAL 3-9", bore: "WO" });
  assert.deepEqual(splitBore("Quintal 31X-4 ST1 Leg 2"), { base: "QUINTAL 31X-4", bore: "ST1" });
});

// ---------------------------------------------------------------- .xls and Oregon permits

/** A minimal OLE2 file holding one BIFF5 'Book' stream (512-byte sectors, no mini stream). */
function tinyXls(cells) {
  const rec = (id, data) => Buffer.concat([Buffer.from([id & 255, id >> 8, data.length & 255, data.length >> 8]), data]);
  const u16 = (...v) => Buffer.from(v.flatMap((n) => [n & 255, n >> 8]));
  const cell = ([r, c, v]) => {
    if (typeof v === "string") return rec(0x0204, Buffer.concat([u16(r, c, 0, v.length), Buffer.from(v, "latin1")]));
    const d = Buffer.alloc(8);
    d.writeDoubleLE(v);
    return rec(0x0203, Buffer.concat([u16(r, c, 0), d]));
  };
  const book = Buffer.concat([rec(0x0809, u16(0x0500, 0x0005)), rec(0x000a, Buffer.alloc(0)), rec(0x0809, u16(0x0500, 0x0010)), ...cells.map(cell), rec(0x000a, Buffer.alloc(0))]);
  const size = Math.max(book.length, 4096); // 4096 and up: stored in regular sectors
  const dataSectors = Math.ceil(size / 512);
  const header = Buffer.alloc(512, 0);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header);
  header.writeUInt16LE(9, 30); // 512-byte sectors
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); // one FAT sector
  header.writeUInt32LE(1, 48); // directory in sector 1
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60);
  header.writeUInt32LE(0xfffffffe, 68);
  header.fill(0xff, 76);
  header.writeUInt32LE(0, 76); // FAT is sector 0
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  for (let i = 0; i < dataSectors; i++) fat.writeUInt32LE(i === dataSectors - 1 ? 0xfffffffe : 3 + i, (2 + i) * 4);
  const dir = Buffer.alloc(512, 0);
  const entry = (at, name, type, start, len) => {
    dir.write(name, at, "utf16le");
    dir.writeUInt16LE(name.length * 2 + 2, at + 64);
    dir[at + 66] = type;
    dir.writeUInt32LE(start, at + 116);
    dir.writeUInt32LE(len, at + 120);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  entry(128, "Book", 2, 2, size);
  const data = Buffer.alloc(dataSectors * 512, 0);
  book.copy(data);
  return Buffer.concat([header, fat, dir, data]);
}

test("xls reader: strings, numbers and dates out of an old binary workbook", async () => {
  const { readXlsSheet, xlsObjects, excelDate } = await import("../src/xls.js");
  const rows = readXlsSheet(tinyXls([[0, 0, "PermitID"], [0, 1, "Depth"], [0, 2, "ApplicationDate"], [1, 0, "36-009-00901 "], [1, 1, 2500], [1, 2, 40000], [3, 0, "36-009-00902"]]));
  assert.deepEqual(rows[1], ["36-009-00901 ", 2500, 40000]);
  assert.deepEqual(xlsObjects(rows), [
    { PermitID: "36-009-00901", Depth: 2500, ApplicationDate: 40000 },
    { PermitID: "36-009-00902", Depth: null, ApplicationDate: null },
  ]); // trimmed; the empty row 2 dropped
  assert.equal(excelDate(40000), "2009-07-06");
  assert.equal(excelDate("n/a"), null);
  assert.throws(() => readXlsSheet(Buffer.from("PK\u0003\u0004 not an xls")), /not an \.xls file/);
});

test("Oregon permits: one record per permit, bad positions dropped, packed DMS converted", async () => {
  const { permitRecords, OREGON_SOURCES } = await import("../src/sources/us-oregon.js");
  const { normalizeRecord } = await import("../src/sources/index.js");
  const base = { Permittee: "Example Gas LP", County: "Columbia", Township: "5N", Range: "4W", Section: "12", QrtSection: "SE" };
  const recs = permitRecords(
    [
      { ...base, PermitID: "36-009-00901", WellName: "CC 12-34-56 Sasquatch", SiteName: "", ApplicationDate: 40000, Depth: 2500, Latitude: 45.91, Longitude: -123.18 },
      { ...base, PermitID: "36-009-00901", WellName: "CC 12-34-56 Sasquatch", SiteName: "", ApplicationDate: 41000, Depth: 2500, Latitude: 45.91, Longitude: -123.18 },
      { ...base, PermitID: "36-009-00903", WellName: "", SiteName: "Alder 1", ApplicationDate: null, Latitude: 1300000, Longitude: 880000 },
      // 42 deg 57 min 00 sec N, 120 deg 26 min 24 sec W written as 42.57, -120.2624: four townships from T30S R20E
      { PermitID: "36-037-90901", WellName: "12-34", SiteName: "Example Hot Springs", Permittee: "Example Geothermal Company", Township: "30S", Range: "20E", Section: "34", Latitude: 42.57, Longitude: -120.2624 },
    ],
    "OG_Permits_20260126.xls"
  );
  assert.equal(recs.length, 3, "the renewal row folds into its permit");
  const [og] = OREGON_SOURCES;
  const well = normalizeRecord(og, recs[0].attrs, recs[0].geometry);
  assert.equal(well.applicationDate, "2009-07-06");
  assert.equal(well.renewalDate, "2012-04-01");
  assert.equal(well.legalLocation, "T5N R4W S12 SE");
  assert.equal(well.depthFt, 2500);
  assert.equal(recs[1].geometry, null, "state-plane feet are not a position");
  assert.equal(normalizeRecord(og, recs[1].attrs, null).wellName, "Alder 1");
  const packed = normalizeRecord(og, recs[2].attrs, recs[2].geometry);
  assert.equal(packed.wellName, "12-34");
  assert.equal(packed.field, "Example Hot Springs");
  assert.ok(Math.abs(packed.latitude - 42.95) < 1e-6 && Math.abs(packed.longitude + 120.44) < 1e-6, "42.57 is 42 deg 57 min");
  assert.match(packed.positionNote, /degrees-minutes-seconds/);
});

test("snapshot provider: API numbers match whatever the punctuation; names in any word order", async () => {
  const { snapshotProvider: p, forgetSnapshots } = await import("../src/providers/snapshot.js");
  await forgetSnapshots();
  const src = {
    key: "TEST-API",
    idKind: "us-api",
    searchFields: { api: "id", well_name: "name" },
    load: async () => [{ attrs: { id: "36-009-00904", name: "CC 12-34-56 Sasquatch" } }, { attrs: { id: "36-009-00906-01", name: "CC 13-01-65 RD 1" } }],
  };
  for (const asked of ["3600900904", "36-009-00904", "360090090400", "00900904"]) {
    assert.deepEqual((await p.findById(src, asked)).map((r) => r.attrs.id), ["36-009-00904"], asked);
  }
  assert.equal((await p.findById(src, "3600900905")).length, 0);
  assert.deepEqual((await p.search(src, { well_name: "Sasquatch CC 12-34-56" }, { limit: 5 })).rows.map((r) => r.attrs.id), ["36-009-00904"]);
  assert.equal((await p.search(src, { well_name: "Sasquatch CC 12-34-57" }, { limit: 5 })).rows.length, 0);
});

test("WFS name filters: alternatives across name and number fields, in CQL and FES", async () => {
  const { filterParams } = await import("../src/providers/wfs.js");
  const anyOf = [[{ field: "well_name", value: "BARRACOUTA A10", op: "like" }], [{ field: "well_name", value: "BARRACOUTA", op: "like" }, { field: "well_number", value: "A10", op: "like" }]];
  assert.equal(
    filterParams({ dialect: "cql" }, [{ anyOf }], null).CQL_FILTER,
    "((well_name ILIKE '%BARRACOUTA%A10%') OR (well_name ILIKE '%BARRACOUTA%' AND well_number ILIKE '%A10%'))"
  );
  const fes = filterParams({ dialect: "fes" }, [{ anyOf }], null).FILTER;
  assert.match(fes, /<fes:Or><fes:PropertyIsLike[^>]*><fes:ValueReference>well_name<.*<fes:And><fes:PropertyIsLike.*well_number.*<\/fes:And><\/fes:Or>/);
});

test("searchOneSource: name tiers stop at the first match; a failed exact tier is not mistaken for no match", async () => {
  const { searchOneSource } = await import("../src/search.js");
  const { snapshotProvider } = await import("../src/providers/snapshot.js");
  const { providerFor } = await import("../src/providers/index.js");
  // A stand-in provider through the snapshot kind's slot: record the tiers asked.
  const asked = [];
  const original = { search: snapshotProvider.search, nameTiers: snapshotProvider.nameTiers };
  const source = { key: "TEST-TIERS", kind: "snapshot", pageMax: 1000, searchFields: { well_name: "NAME" }, normalize: (a) => ({ wellName: a.NAME }) };
  assert.equal(providerFor(source), snapshotProvider);
  try {
    snapshotProvider.nameTiers = 4;
    const script = (byTier) => async (_s, _f, { nameTier = 0 }) => {
      asked.push(nameTier);
      const step = byTier[nameTier];
      if (step instanceof Error) throw step;
      return step ?? { rows: [], noTier: true };
    };
    const hit = { rows: [{ attrs: { NAME: "Garnet 4" } }], moreAvailable: false };
    const none = { rows: [], moreAvailable: false };

    snapshotProvider.search = script({ 0: none, 1: none, 2: none, 3: hit });
    assert.equal((await searchOneSource(source, { well_name: "Garnet 4B" }, { limit: 5, offset: 0 })).wells[0].nameMatch, 0.85);
    assert.deepEqual(asked.splice(0), [0, 1, 2, 3]);

    await searchOneSource(source, { well_name: "Garnet 4B" }, { limit: 5, offset: 0, deepNames: false });
    assert.deepEqual(asked.splice(0), [0, 1], "many sources asked: only the name itself, typed and forgiving");

    snapshotProvider.search = script({ 0: hit });
    await searchOneSource(source, { well_name: "Garnet 4" }, { limit: 5, offset: 0 });
    assert.deepEqual(asked.splice(0), [0], "found as typed: nothing looser is asked");

    // exact tier rejected by the server, forgiving tier answers
    snapshotProvider.search = script({ 0: new Error("parse error"), 1: hit });
    assert.equal((await searchOneSource(source, { well_name: "Garnet (4.)" }, { limit: 5, offset: 0 })).returned, 1);
    // exact tier failed and no other tier exists for this name: the failure surfaces
    snapshotProvider.search = script({ 0: new Error("server down") });
    await assert.rejects(searchOneSource(source, { well_name: "Garnet 4" }, { limit: 5, offset: 0 }), /server down/);
    // ...and when a later tier fails too, the first error is the one reported
    snapshotProvider.search = script({ 0: new Error("server down"), 1: new Error("still down") });
    await assert.rejects(searchOneSource(source, { well_name: "Garnet 4" }, { limit: 5, offset: 0 }), /server down/);
  } finally {
    Object.assign(snapshotProvider, original);
    if (original.nameTiers === undefined) delete snapshotProvider.nameTiers;
  }
});

test("arcgis provider: an error-status body is an outage; a republished layer is found under its new id", async () => {
  const { arcgisProvider } = await import("../src/providers/arcgis.js");
  const realFetch = globalThis.fetch;
  const calls = [];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  try {
    // 1. the whole site is down but answers 200
    globalThis.fetch = async () => reply({ status: "error", messages: ["Could not access any server machines."] });
    const down = { key: "TEST-DOWN", url: "https://example.test/arcgis/rest/services/W/MapServer/3", pageMax: 100, searchFields: { operator: "OP" } };
    await assert.rejects(arcgisProvider.search(down, { operator: "x" }, { limit: 5 }), /ArcGIS server error: Could not access any server machines/);

    // 2. layer 106 is gone; the service now holds one layer, 114
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u.replace(/\?.*$/, ""));
      if (u.includes("/FeatureServer/106/")) return reply({ error: { code: 400, message: "Invalid URL" } });
      if (/\/FeatureServer\?/.test(u)) return reply({ layers: [{ id: 114, name: "Wells" }] });
      if (u.includes("/FeatureServer/114/")) return reply({ features: [{ attributes: { OP: "Acme" }, geometry: { x: 1, y: 2 } }] });
      throw new Error(`unexpected request ${u}`);
    };
    const moved = { key: "TEST-MOVED", url: "https://example.test/arcgis/rest/services/W/FeatureServer/106", pageMax: 100, searchFields: { operator: "OP" } };
    assert.equal((await arcgisProvider.search(moved, { operator: "acme" }, { limit: 5 })).rows[0].attrs.OP, "Acme");
    await arcgisProvider.search(moved, { operator: "acme" }, { limit: 5 });
    assert.deepEqual(calls.map((c) => c.split("/services/W/")[1]), ["FeatureServer/106/query", "FeatureServer", "FeatureServer/114/query", "FeatureServer/114/query"], "the new id is remembered");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- nearest wells

/**
 * A stand-in registry: `wells` are [name, km east of the centre]. Its radius search answers
 * like a real server - the wells in the circle, farthest first (the worst case for a caller
 * that keeps "the nearest of what came back"), cut at the row limit.
 */
function denseField(wells, { pageMax = 1000, flagMore = true } = {}) {
  const centre = { latitude: 35, longitude: -119 };
  const kmPerDegLon = 111.32 * Math.cos((35 * Math.PI) / 180);
  const rows = wells.map(([name, km]) => ({ attrs: { NAME: name }, geometry: { x: centre.longitude + km / kmPerDegLon, y: centre.latitude }, km }));
  const asked = [];
  const provider = {
    async search(_source, _filters, { limit, near }) {
      asked.push([Math.round(near.radiusKm * 1000) / 1000, limit]);
      const inside = rows.filter((r) => r.km <= near.radiusKm).sort((a, b) => b.km - a.km);
      return { rows: inside.slice(0, limit), moreAvailable: flagMore && inside.length > limit, unsupported: [] };
    },
  };
  const source = { key: "TEST-DENSE", kind: "test-dense", pageMax, searchFields: {}, normalize: (a, g) => ({ wellName: a.NAME, latitude: g.y, longitude: g.x }) };
  return { centre, provider, source, asked };
}

test("radius search: the nearest wells are the nearest, even when the circle holds thousands", async () => {
  const { searchOneSource } = await import("../src/search.js");
  const { PROVIDERS } = await import("../src/providers/index.js");
  // 4,000 wells spread evenly out to 2 km, plus one 20 m from the point
  const spread = Array.from({ length: 4000 }, (_, i) => [`W${i}`, 0.05 + (1.95 * i) / 4000]);
  const field = denseField([["ON THE SPOT", 0.02], ...spread]);
  PROVIDERS["test-dense"] = field.provider;
  try {
    const near = { ...field.centre, radiusKm: 2 };
    const r = await searchOneSource(field.source, {}, { limit: 5, offset: 0, near });
    assert.equal(r.wells[0].wellName, "ON THE SPOT");
    assert.deepEqual(r.wells.map((w) => w.distanceKm), [0.02, 0.05, 0.05, 0.05, 0.05]);
    assert.equal(r.moreAvailable, true);
    assert.equal(r.completeWithinKm, 0.05, "the five listed are the five nearest");
    assert.deepEqual(field.asked.map(([km]) => km), [2, 0.5, 0.125], "asked closer in until an answer came back whole");

    // asked for more than the whole circle holds: widen, then fill from the samples beyond it
    field.asked.length = 0;
    const many = await searchOneSource(field.source, {}, { limit: 100, offset: 0, near });
    assert.equal(many.wells.length, 100);
    assert.equal(many.wells[0].wellName, "ON THE SPOT");
    assert.ok(many.completeWithinKm >= 0.09 && many.completeWithinKm <= 0.13, `complete within ${many.completeWithinKm} km`);
    const names = many.wells.map((w) => w.wellName);
    assert.equal(new Set(names).size, names.length, "no well listed twice");
    assert.ok(many.wells.every((w, i, a) => i === 0 || a[i - 1].distanceKm <= w.distanceKm), "nearest first");
    // every well inside the complete radius is there
    const inside = spread.filter(([, km]) => km <= many.completeWithinKm).length + 1;
    assert.equal(many.wells.filter((w) => w.distanceKm <= many.completeWithinKm).length >= Math.min(inside, 100) - 2, true);
  } finally {
    delete PROVIDERS["test-dense"];
  }
});

test("radius search: a sparse area costs one request; wells sharing one spot are all fetched; a silent server is handled", async () => {
  const { searchOneSource } = await import("../src/search.js");
  const { PROVIDERS } = await import("../src/providers/index.js");
  try {
    // sparse: one request, no completeWithinKm
    const sparse = denseField([["A", 0.4], ["B", 0.1], ["C", 1.5]]);
    PROVIDERS["test-dense"] = sparse.provider;
    const s = await searchOneSource(sparse.source, {}, { limit: 2, offset: 0, near: { ...sparse.centre, radiusKm: 2 } });
    assert.deepEqual(s.wells.map((w) => w.wellName), ["B", "A"]);
    assert.equal(s.moreAvailable, true, "three in the circle, two asked for");
    assert.equal(s.completeWithinKm, undefined);
    assert.equal(sparse.asked.length, 1);

    // a platform: 600 wells at one surface position, more than one ordinary answer holds
    const platform = denseField([...Array.from({ length: 600 }, (_, i) => [`P${i}`, 0.001]), ...Array.from({ length: 900 }, (_, i) => [`F${i}`, 0.3 + i / 1000])], { pageMax: 2000 });
    PROVIDERS["test-dense"] = platform.provider;
    const p = await searchOneSource(platform.source, {}, { limit: 100, offset: 0, near: { ...platform.centre, radiusKm: 2 }, keepWithinKm: 0.15 });
    assert.equal(p.wells.length, 600, "every well on the spot is kept, past the limit");
    assert.ok(p.wells.every((w) => w.wellName.startsWith("P")));
    assert.deepEqual(platform.asked.at(-1), [0.031, 2000], "asked once for every row the server allows");

    // a server that never says there is more: a full page is treated as cut short
    const silent = denseField([["ON THE SPOT", 0.02], ...Array.from({ length: 2000 }, (_, i) => [`W${i}`, 0.2 + i / 1200])], { flagMore: false });
    PROVIDERS["test-dense"] = silent.provider;
    const q = await searchOneSource(silent.source, {}, { limit: 5, offset: 0, near: { ...silent.centre, radiusKm: 2 } });
    assert.equal(q.wells[0].wellName, "ON THE SPOT");
    assert.ok(silent.asked.length > 1);

    // nothing whole even close in and no bigger page to ask for: the list is a sample, and says so
    const packed = denseField(Array.from({ length: 5000 }, (_, i) => [`W${i}`, 0.001]), { pageMax: 300 });
    PROVIDERS["test-dense"] = packed.provider;
    const z = await searchOneSource(packed.source, {}, { limit: 5, offset: 0, near: { ...packed.centre, radiusKm: 2 } });
    assert.equal(z.completeWithinKm, 0);
    assert.equal(z.wells.length, 5);
  } finally {
    delete PROVIDERS["test-dense"];
  }
});

test("snapshot radius search returns the nearest first", async () => {
  const { snapshotProvider: p, forgetSnapshots } = await import("../src/providers/snapshot.js");
  forgetSnapshots();
  const src = {
    key: "TEST-NEAR",
    searchFields: { well_name: "name" },
    load: async () => [0.9, 0.1, 0.5, 0.02].map((km) => ({ attrs: { name: `at ${km}` }, geometry: { x: -119 + km / 91.19, y: 35 } })),
  };
  const r = await p.search(src, {}, { limit: 2, near: { latitude: 35, longitude: -119, radiusKm: 2 } });
  assert.deepEqual(r.rows.map((x) => x.attrs.name), ["at 0.02", "at 0.1"]);
  assert.equal(r.moreAvailable, true);
});
