// Offline tests: identifiers typed differently from how a registry stores them, Canadian
// UWIs, coded fields, tidy numbers, the second name field, and looser name tiers.
// Every name and figure here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { idTokens, sameIdTokens, idTokenRun, partialWorthy, hasLetters, idAlsoValue } from "../src/ids.js";
import { parseUwi, uwiForms, uwiCore, uwiCompact, sameDlsLocation } from "../src/uwi.js";
import { normalizeRecord, tidyNumber } from "../src/sources/normalize.js";
import { codedClause, wellNameWhere, inClause, likeClause, eqClause } from "../src/providers/arcgis.js";
import { filterParams } from "../src/providers/wfs.js";
import { rankByName } from "../src/search.js";
import { scoreCandidate } from "../src/match.js";

process.env.WELL_DATA_CACHE_DIR = "off";

test("ids: the same id whatever the spacing, punctuation, case or zero padding - and never digits inside digits", () => {
  assert.deepEqual(idTokens("ZQX-01"), ["ZQX", "1"]);
  assert.ok(sameIdTokens("99/9-19A", "99/9-19 A"));
  assert.ok(sameIdTokens("9/93a-20B", "9/93a- 20B"));
  assert.ok(sameIdTokens("ZQX-1", "ZQX-01"));
  assert.ok(!sameIdTokens("ZQX-1", "ZQX-101"));
  assert.ok(idTokenRun("Inventa-1", "Inventa"));
  assert.ok(!idTokenRun("ZQX-101", "ZQX-1"), "a token run, not a substring");
  assert.ok(!idTokenRun("100061608318W600", "00061"));
  assert.ok(partialWorthy("Inventa") && partialWorthy("ZQ 4") && !partialWorthy("4") && !partialWorthy("00061"));
  assert.ok(hasLetters("Inventa-4") && !hasLetters("12-345"));
  assert.equal(idAlsoValue({ idAlso: { field: "WA", test: /^\d{1,5}$/, pad: 5 } }, "61"), "00061");
  assert.equal(idAlsoValue({ idAlso: { field: "WA", test: /^\d{1,5}$/, pad: 5 } }, "Inventa"), null);
});

test("uwi: Canadian UWIs in every common spelling, in the form each layer stores", () => {
  for (const text of ["100/06-12-034-05W5/00", "100061203405W500", "SK-WI-100061203405W500", "100.06-12-034-05W5.00"]) {
    const u = parseUwi(text);
    assert.ok(u, text);
    assert.equal(uwiCompact(u), "100061203405W500", text);
  }
  const loc = parseUwi("6-12-34-5 W5M");
  assert.equal(uwiCompact(loc), null, "no exception code or event sequence: the location only");
  assert.equal(uwiCore(loc), "061203405W5");
  assert.deepEqual(uwiForms(loc, "dls"), ["06-12-034-05W5"]);
  assert.deepEqual(uwiForms(loc, "mb"), ["06-12-34-05 W5"]);
  assert.deepEqual(uwiForms(parseUwi("100/06-12-034-05W5/00"), "sk"), ["SK-WI-100061203405W500"]);
  const nts = parseUwi("200/A-079-B/094-H-04/00");
  assert.equal(uwiCompact(nts), "200A079B094H0400");
  assert.equal(uwiCompact(parseUwi("A-79-B/94-H-4")), null);
  assert.equal(uwiCore(parseUwi("A-79-B/94-H-4")), "A079B094H04");
  assert.equal(parseUwi("17-12-034-05W5"), null, "LSD 17 does not exist");
  assert.equal(parseUwi("99/9-19 A"), null);
  assert.equal(parseUwi("43-007-31022"), null, "a US API number is not a UWI");
  assert.ok(sameDlsLocation("A06A-12-34-05 W5", loc));
});

test("normalize: storage noise rounded off measured values, positions untouched, coded fields decoded", () => {
  assert.equal(tidyNumber(1219.199951171875), 1219.2);
  assert.equal(tidyNumber(304.299999), 304.3);
  assert.equal(tidyNumber(0.1 + 0.2), 0.3);
  assert.equal(tidyNumber(1283947200000), 1283947200000);
  const source = {
    codes: { status: { SUSP: "Suspended", ACT: "Active" } },
    normalize: (a) => ({ api: a.ID, wellName: a.NAME, status: a.ST, depthMD: a.TD, latitude: a.LAT, longitude: a.LON, bottomHoleLatitude: a.BHL }),
  };
  const n = normalizeRecord(source, { ID: "X1", NAME: "Inventa 1", ST: "SUSP", TD: 1104.9000244140625, LAT: 56.0824712345, LON: -121.0806498765, BHL: 56.10123456789 }, null);
  assert.equal(n.status, "Suspended");
  assert.equal(n.statusCode, "SUSP");
  assert.equal(n.depthMD, 1104.9);
  assert.equal(n.latitude, 56.0824712345);
  assert.equal(n.bottomHoleLatitude, 56.10123456789);
  assert.equal(normalizeRecord(source, { ST: "WEIRD" }, null).status, "WEIRD", "unknown codes stay as they are");
});

test("coded filters: a word finds the codes whose label holds it; the raw code still works", () => {
  const table = { SUSP: "Suspended", ABAN: "Abandoned", ABNZ: "Abandoned zone" };
  assert.equal(codedClause("ST", "abandoned", table), inClause("ST", ["ABAN", "ABNZ"]));
  assert.equal(codedClause("ST", "SUSP", table), inClause("ST", ["SUSP"]));
  assert.equal(codedClause("ST", "A", { A: "Active", PA: "Plugged and abandoned" }), inClause("ST", ["A"]), "'A' must not find 'PA'");
  assert.equal(codedClause("ST", "flowing", table), eqClause("ST", "flowing"));
  assert.equal(codedClause("ST", "Plugged", { PA: "Plugged" }, "GENERAL"), `(${inClause("ST", ["PA"])} OR UPPER(GENERAL) LIKE UPPER('Plugged%'))`);
  const wfs = { dialect: "cql", searchFields: { status: "ST" }, codes: { status: table } };
  assert.match(filterParams(wfs, [{ anyOf: [[{ field: "ST", value: "SUSP", op: "eq" }], [{ field: "ST", value: "susp", op: "like" }]] }]).CQL_FILTER, /strToUpperCase\(ST\) = 'SUSP'/);
});

test("name tiers: the forgiving tier splits letters from digits where there is no number field", () => {
  const single = { searchFields: { well_name: "NAME" } };
  // ('%%' before a digit is the firewall guard in likeClause: '%19' or '%5' can read as an encoded character.)
  assert.equal(wellNameWhere(single, "99/9-19A", 1), "UPPER(NAME) LIKE UPPER('%%99%%9%%19%A%')");
  assert.equal(wellNameWhere(single, "QX10", 1), "UPPER(NAME) LIKE UPPER('%QX%%10%')");
  assert.equal(wellNameWhere(single, "Inventa 1", 1), null, "nothing to forgive: would repeat tier 0");
  // WFS: the same split, and a second name field.
  const wfs = { dialect: "cql", searchFields: { well_name: "NAME" }, wellNameAlso: "CODE" };
  const { CQL_FILTER } = filterParams(wfs, [{ anyOf: [[{ field: "NAME", value: "ZQX 1", op: "like" }], [{ field: "CODE", value: "ZQX 1", op: "like" }]] }]);
  assert.match(CQL_FILTER, /NAME ILIKE '%ZQX%1%'\) OR \(CODE ILIKE '%ZQX%1%'/);
});

test("fes quirks: fesNoEscape turns special characters into one-character wildcards; eqAsLike compares without wildcards", () => {
  const noEscape = { dialect: "fes", fesNoEscape: true };
  assert.match(filterParams(noEscape, [{ field: "N", value: "Inventa F.B. 42 (1.)", op: "like" }]).FILTER, /\*Inventa\*F\.B\.\*42\*\.1\.\.\*/);
  const asLike = { dialect: "fes", eqAsLike: true };
  const f = filterParams(asLike, [{ field: "ID", value: "15/9-19 A", op: "eq" }]).FILTER;
  assert.match(f, /PropertyIsLike[^>]*><fes:ValueReference>ID<\/fes:ValueReference><fes:Literal>15\/9-19 A<\/fes:Literal>/);
});

test("numeric-id sources: a name with letters is never one of their ids", () => {
  const wfs = { dialect: "cql", apiNumeric: true, idKind: "id", searchFields: { api: "PT" } };
  assert.equal(filterParams(wfs, [{ field: "PT", value: "Inventa-4", op: "eq" }]).CQL_FILTER, "PT = -1");
  assert.equal(filterParams(wfs, [{ field: "PT", value: "0012920", op: "eq" }]).CQL_FILTER, "PT = 12920");
});

test("rankByName: a row found through the second name field is scored on it", () => {
  const source = { key: "T", searchFields: { well_name: "NAME" }, wellNameAlso: "REGNO", normalize: (a) => ({ wellName: a.NAME }) };
  const rows = [{ attrs: { NAME: "INVENTA HALL 1", REGNO: "L99/99- 9" } }];
  const ranked = rankByName(source, "L99/99-9", rows);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].score, 1);
});

test("searchOneSource: a weak match as typed does not stop the looser tiers; the answers are merged", async () => {
  const { searchOneSource } = await import("../src/search.js");
  const { snapshotProvider } = await import("../src/providers/snapshot.js");
  const original = { search: snapshotProvider.search, nameTiers: snapshotProvider.nameTiers };
  const source = { key: "TEST-WEAK", kind: "snapshot", pageMax: 1000, searchFields: { well_name: "NAME" }, normalize: (a) => ({ wellName: a.NAME }) };
  const asked = [];
  try {
    snapshotProvider.nameTiers = 2;
    snapshotProvider.search = async (_s, _f, { nameTier = 0 }) => {
      asked.push(nameTier);
      return nameTier === 0
        ? { rows: [{ attrs: { OBJECTID: 1, NAME: "QUINTAL WESTGAT-101" } }], moreAvailable: false }
        : { rows: [{ attrs: { OBJECTID: 2, NAME: "QUINTAL WESTGAT-01" } }, { attrs: { OBJECTID: 1, NAME: "QUINTAL WESTGAT-101" } }], moreAvailable: false };
    };
    const r = await searchOneSource(source, { well_name: "Quintal Westgat-1" }, { limit: 5, offset: 0 });
    assert.deepEqual(asked, [0, 1]);
    assert.equal(r.wells[0].wellName, "QUINTAL WESTGAT-01");
    assert.equal(r.wells[0].nameMatch, 1);
    assert.equal(r.wells.length, 2, "the row both tiers found is listed once");
  } finally {
    Object.assign(snapshotProvider, original);
  }
});

test("snapshot get_well: exact, then the same tokens, then whole tokens inside a longer id (flagged partial)", async () => {
  const { snapshotProvider: p, forgetSnapshots } = await import("../src/providers/snapshot.js");
  forgetSnapshots();
  const rows = [
    { attrs: { ID: "ZQX-01" }, geometry: null },
    { attrs: { ID: "ZQX-101" }, geometry: null },
    { attrs: { ID: "Inventa-1" }, geometry: null },
  ];
  const src = { key: "TEST-IDS", kind: "snapshot", searchFields: { api: "ID" }, load: async () => rows };
  assert.deepEqual((await p.findById(src, "ZQX-1")).map((r) => [r.attrs.ID, Boolean(r.partial)]), [["ZQX-01", false]]);
  assert.deepEqual((await p.findById(src, "Inventa")).map((r) => [r.attrs.ID, Boolean(r.partial)]), [["Inventa-1", true]]);
  assert.deepEqual(await p.findById(src, "1"), [], "a bare number is not looked for inside other ids");
  forgetSnapshots();
});

test("match_well: a year-only registry's drillYear counts as spud evidence", () => {
  const known = { names: ["Inventa 1"], spud: { year: 1973 } };
  const c = scoreCandidate(known, { wellName: "INVENTA 001", drillYear: 1973 });
  assert.equal(c.evidence.spudYearMatches, true);
  const off = scoreCandidate(known, { wellName: "INVENTA 001", drillYear: 1980 });
  assert.ok(c.score > off.score);
  const iso = scoreCandidate({ names: ["Inventa 1"], spud: { iso: "1973-05-02" } }, { wellName: "INVENTA 001", drillYear: 1973 });
  assert.equal(iso.evidence.spudYearMatches, true, "a full date against a year-only record compares the years");
});

test("match_well: field and county hints break a tie between two perfect name matches", async () => {
  const { confidenceOf } = await import("../src/match.js");
  const known = { names: ["Quintal 1"], field: "Example Field", county: "Inventa" };
  const a = scoreCandidate(known, { wellName: "Quintal 1", field: "Other", county: "Elsewhere" });
  const b = scoreCandidate(known, { wellName: "Quintal 1", field: "Example Field", county: "Inventa" });
  assert.equal(a.score, 1);
  assert.equal(b.score, 1, "the shown score stays capped at 1");
  assert.ok(b.rank > a.rank, "the hints still count when ranking");
  assert.equal(confidenceOf([b, a].map((c) => ({ ...c, evidence: { ...c.evidence } }))), "probable");
});

test("names: 'and' is '&', a lease glued to its number is two words, the two longest words in tier 3", async () => {
  const { nameScore, nameWords } = await import("../src/name-match.js");
  assert.equal(nameScore("Quintal and Inventa 1", { lease: "Quintal & Inventa", number: "1" }), 1);
  assert.deepEqual(nameWords("Quintal15"), ["QUINTAL", "15"]);
  assert.deepEqual(nameWords("K&L 02-9"), ["K", "L", "2", "9"]);
  const split = { searchFields: { well_name: "LEASE" }, wellNumberField: "NUM" };
  assert.match(wellNameWhere(split, "Quintal15", 1), /UPPER\(LEASE\) LIKE UPPER\('%QUINTAL%'\) AND UPPER\(NUM\) LIKE UPPER\('%%?15%'\)/);
  const single = { searchFields: { well_name: "NAME" } };
  assert.equal(wellNameWhere(single, "Inventa Partnership 1", 3), "(UPPER(NAME) LIKE UPPER('%PARTNERSHIP%') OR UPPER(NAME) LIKE UPPER('%INVENTA%'))");
  // One hyphenated word may be a lease and a number stored apart ('ZQ-5' = lease 'ZQ' + number '5').
  assert.match(wellNameWhere(split, "ZQ-5", 0), /UPPER\(LEASE\) LIKE UPPER\('%ZQ%'\) AND UPPER\(NUM\) LIKE UPPER\('%%5%'\)/);
});

test("search_wells api filter: every exact form, or the dash-tolerant county + sequence; IN alone behind an OR-shy firewall", async () => {
  const { buildWhere } = await import("../src/providers/arcgis.js");
  const plainSource = { idKind: "us-api", searchFields: { api: "API" } };
  const { where } = await buildWhere(plainSource, { api: "46-041-00188" });
  assert.match(where, /^\(UPPER\(API\) IN \(.*\) OR UPPER\(API\) LIKE UPPER\('%%?041%%00188%'\)\)$/);
  const ocs = { idKind: "us-api", apiPattern: /^60/, searchFields: { api: "API" } };
  assert.doesNotMatch((await buildWhere(ocs, { api: "60-811-40322" })).where, / OR /);
});

test("wellKey: an 8-digit county + sequence id joins the full API of the same well; placeholder ids stay apart", async () => {
  const { wellKey } = await import("../src/match.js");
  assert.equal(wellKey({ source: "T1", country: "US", state: "CO", api: "045-05056" }, "us-api"), "US:0504505056");
  assert.equal(wellKey({ source: "T2", country: "US", state: "CO", api: "05-045-05056-0000" }), "US:0504505056");
  assert.equal(wellKey({ source: "T1", country: "US", state: "CO", api: "045-05056" }, "id"), "T1:045-05056", "not for sources with their own ids");
  assert.notEqual(
    wellKey({ source: "T3", country: "US", api: "Unknown", wellName: "QX-1", latitude: 36.1, longitude: -83.1 }),
    wellKey({ source: "T3", country: "US", api: "Unknown", wellName: "QX-2", latitude: 36.2, longitude: -83.2 })
  );
});

test("centroid: a closed ring's repeated first vertex does not pull the centre", async () => {
  const { centroid } = await import("../src/sources/normalize.js");
  const ring = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.deepEqual(centroid({ rings: [ring] }), { x: 1, y: 1 });
});
