// Offline tests for source filters and lookups: plainSql value batches, the forgiving id
// lookup past the first page, coded-label matching, KS and ND status/type words, BO-MHE
// status, HU well names and WFS paging order. Ids, names and figures are invented.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arcgisProvider, buildWhere, codedClause, inClause, labelHolds, matchingCodes } from "../src/providers/arcgis.js";
import { wfsProvider } from "../src/providers/wfs.js";
import { SOURCES } from "../src/sources/index.js";
import { ksStatusWhere } from "../src/sources/us-codes.js";
import { BC_ACTIVITY } from "../src/sources/americas-codes.js";

const src = (key) => SOURCES.find((s) => s.key === key);
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

async function withFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "well-data-fix-sources-"));
  const before = process.env.WELL_DATA_CACHE_DIR;
  process.env.WELL_DATA_CACHE_DIR = dir;
  globalThis.fetch = async (url, init) => handler(new URL(String(url)), init);
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.WELL_DATA_CACHE_DIR;
    else process.env.WELL_DATA_CACHE_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Query params of a GET or form-POST ArcGIS request. */
const paramsOf = (u, init) => (init?.body ? new URLSearchParams(String(init.body)) : u.searchParams);

// ---------------------------------------------------------------- plainSql

test("plainSql: every matching value is sent, in batches; count sums them and search pages across them", async () => {
  // 250 licensees hold 'Zephyr': three batches of 100, 100 and 50. Each licensee has 2 wells.
  const names = Array.from({ length: 250 }, (_, i) => `Zephyr ${String(i).padStart(3, "0")} Ltd.`);
  const wells = names.flatMap((n, i) => [{ LIC: `${i}a`, OP: n }, { LIC: `${i}b`, OP: n }]);
  const source = { key: "TEST-PLAIN-BATCH", url: "https://example.test/arcgis/rest/services/X/MapServer/1", pageMax: 1000, plainSql: true, idKind: "id", searchFields: { api: "LIC", operator: "OP" } };
  let inFlight = 0;
  let peak = 0;
  await withFetch(async (u, init) => {
    const p = paramsOf(u, init);
    if (p.get("returnDistinctValues") === "true") return reply({ features: [...names, "Other Co"].map((n) => ({ attributes: { OP: n } })) });
    const where = p.get("where");
    const ops = [...where.matchAll(/OP = '([^']+)'/g)].map((m) => m[1]);
    assert.ok(ops.length <= 100, "at most 100 values per request");
    const hits = wells.filter((w) => ops.includes(w.OP));
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (p.get("returnCountOnly") === "true") return reply({ count: hits.length });
    const offset = Number(p.get("resultOffset"));
    const n = Number(p.get("resultRecordCount"));
    return reply({ features: hits.slice(offset, offset + n).map((a) => ({ attributes: a, geometry: { x: 1, y: 2 } })), exceededTransferLimit: hits.length > offset + n });
  }, async () => {
    const built = await buildWhere(source, { operator: "Zephyr" });
    assert.equal(built.batches.length, 3);
    assert.equal(built.where, built.batches[0]);
    assert.equal((await arcgisProvider.count(source, { operator: "Zephyr" })).count, 500, "all 250 licensees, not the first 100");
    assert.ok(peak <= 4, "batch counts run at most four at a time");
    // offset 198, limit 5: the last two wells of batch 1 (200 wells), then three of batch 2.
    const page = await arcgisProvider.search(source, { operator: "Zephyr" }, { limit: 5, offset: 198 });
    assert.deepEqual(page.rows.map((r) => r.attrs.LIC), ["99a", "99b", "100a", "100b", "101a"]);
    assert.equal(page.moreAvailable, true);
    const last = await arcgisProvider.search(source, { operator: "Zephyr" }, { limit: 10, offset: 495 });
    assert.deepEqual(last.rows.map((r) => r.attrs.LIC), ["247b", "248a", "248b", "249a", "249b"]);
    assert.equal(last.moreAvailable, false);
    // A filter matching 100 values or fewer is one clause.
    assert.equal((await buildWhere(source, { operator: "Other" })).batches, undefined);
  });
});

// ---------------------------------------------------------------- forgiving id lookup

test("get_well forgiving id lookup reads the id field past the first page until the same id turns up", async () => {
  // '99/1-2' is stored as '99/01- 2', far down a broad contains-match.
  const ids = [...Array.from({ length: 2500 }, (_, i) => `99/1${i}-2${i}`), "99/01- 2"]; // the server's order
  const source = { key: "TEST-ID-SCAN", url: "https://example.test/arcgis/rest/services/X/MapServer/0", pageMax: 1000, idKind: "id", searchFields: { api: "WELL_ID" } };
  const distinctPages = [];
  await withFetch(async (u, init) => {
    const p = paramsOf(u, init);
    const where = p.get("where");
    if (p.get("returnDistinctValues") === "true") {
      const offset = Number(p.get("resultOffset"));
      const n = Number(p.get("resultRecordCount"));
      distinctPages.push(offset);
      return reply({ features: ids.slice(offset, offset + n).map((v) => ({ attributes: { WELL_ID: v } })), exceededTransferLimit: ids.length > offset + n });
    }
    if (/ IN \(/.test(where)) {
      const wanted = [...where.matchAll(/UPPER\('([^']*)'\)/g)].map((m) => m[1]);
      return reply({ features: ids.filter((v) => wanted.includes(v)).map((v) => ({ attributes: { WELL_ID: v, NAME: "Invented" }, geometry: { x: 1, y: 2 } })) });
    }
    return reply({ features: [] }); // the exact tier misses
  }, async () => {
    const rows = await arcgisProvider.findById(source, "99/1-2");
    assert.deepEqual(rows.map((r) => r.attrs.WELL_ID), ["99/01- 2"]);
    assert.ok(!rows[0].partial);
    assert.deepEqual(distinctPages, [0, 1000, 2000], "paged until the id turned up");
  });
});

// ---------------------------------------------------------------- coded labels

test("coded filters match labels at a word start and not after a negation", () => {
  assert.equal(labelHolds("Well authorization granted (not drilled)", "Drilled"), false);
  assert.equal(labelHolds("Undrilled location", "drilled"), false);
  assert.equal(labelHolds("Drilled and cased", "drilled"), true);
  assert.equal(labelHolds("Plugged and abandoned", "Plug"), true);
  assert.equal(labelHolds("Non-producing", "producing"), false);
  assert.equal(labelHolds("Overdrilling, reaming", "Drilling"), false);
  assert.equal(labelHolds("Completing/Completed", "Completed"), true);
  assert.equal(labelHolds("Oil", "Oi"), false, "two letters are too short to match a label");
  assert.deepEqual(matchingCodes(BC_ACTIVITY, "Drilled"), [], "'Drilled' does not select the undrilled wells");
  assert.deepEqual(matchingCodes(BC_ACTIVITY, "Drilling"), ["DRIL", "DSUS"]);
  assert.deepEqual(matchingCodes(BC_ACTIVITY, "abandoned"), ["ABAN", "ABNZ"]);
  assert.equal(codedClause("WELL_ACTIVITY", "WAG", BC_ACTIVITY), inClause("WELL_ACTIVITY", ["WAG"]), "the code itself still works");
});

test("WFS coded filters use the same label rule", async () => {
  const source = { key: "TEST-WFS-CODES", url: "https://example.test/wfs", typeName: "W", pageMax: 100, codes: { status: { WAG: "Granted (not drilled)", DRL: "Drilled" } }, searchFields: { status: "ST" } };
  let cql = null;
  await withFetch(async (u) => {
    cql = u.searchParams.get("CQL_FILTER");
    return reply({ type: "FeatureCollection", features: [], numberMatched: 0 });
  }, async () => {
    await wfsProvider.search(source, { status: "drilled" }, { limit: 5 });
  });
  assert.equal(cql, "((strToUpperCase(ST) = 'DRL'))");
});

// ---------------------------------------------------------------- KS, ND, BO-MHE, HU

test("KS status 'P&A' finds the plugged map classes; a type word does not", () => {
  const pa = ksStatusWhere("P&A");
  for (const code of ["OIL-P&A", "GAS-P&A", "SWD-P&A"]) assert.ok(pa.includes(`UPPER('${code}')`), code);
  assert.ok(!pa.includes("UPPER('D&A')"));
  assert.equal(ksStatusWhere("-P&A").match(/-P&A'\)/g).length, 8);
  assert.ok(!ksStatusWhere("Oil").includes("OIL-P&A"), "'Oil' stays the unplugged class");
});

test("ND well_type: 'Gas' finds GASD, GASC and GASN; a code still matches exactly", async () => {
  const nd = src("ND");
  assert.equal((await buildWhere(nd, { well_type: "Gas" })).where, inClause("well_type", ["GASD", "GASC", "GASN"]));
  assert.equal((await buildWhere(nd, { well_type: "GASC" })).where, inClause("well_type", ["GASC"]));
  assert.equal((await buildWhere(nd, { well_type: "Oil" })).where, inClause("well_type", ["OG"]));
  assert.equal((await buildWhere(nd, { status: "A" })).where, "UPPER(status) = UPPER('A')", "status codes stay exact");
});

test("BO-MHE status filter looks in the abandonment state and the result", async () => {
  const { where } = await buildWhere(src("BO-MHE"), { status: "abandono" });
  assert.match(where, /UPPER\(o_abandono\) LIKE UPPER\('%abandono%'\) OR UPPER\(o_resultados\) LIKE UPPER\('%abandono%'\)/);
});

test("HU-HUGEO-GEO: get_well finds a well by its name as well as its cadastral number", async () => {
  const hu = src("HU-HUGEO-GEO");
  const { snapshotProvider } = await import("../src/providers/snapshot.js");
  const rows = [
    { attrs: { Heviz_kat: "9-1", MBFH: "Kútfalva B-3" }, geometry: null },
    { attrs: { Heviz_kat: "9-2", MBFH: "Kútfalva B-4" }, geometry: null },
  ];
  const fake = { ...hu, key: "TEST-HU-NAME", load: async () => rows };
  await withFetch(async () => {
    throw new Error("no requests expected");
  }, async () => {
    const found = await snapshotProvider.findById(fake, "Kútfalva B-4");
    assert.deepEqual(found.map((r) => r.attrs.Heviz_kat), ["9-2"]);
    assert.deepEqual((await snapshotProvider.findById(fake, "9-1")).map((r) => r.attrs.MBFH), ["Kútfalva B-3"]);
  });
});

test("WFS forgiving id lookup reads on past the first page; a later page the server refuses keeps what was read", async () => {
  const ids = [...Array.from({ length: 450 }, (_, i) => `99/1${i}-2${i}`), "99/01- 2"];
  const source = { key: "TEST-WFS-IDSCAN", url: "https://example.test/wfs", typeName: "W", sortBy: "FID", pageMax: 200, idKind: "id", searchFields: { api: "WID" } };
  const starts = [];
  let refuseAfter = Infinity;
  await withFetch(async (u) => {
    const cql = u.searchParams.get("CQL_FILTER");
    if (!/ILIKE/.test(cql)) return reply({ type: "FeatureCollection", features: [], numberMatched: 0 }); // exact tier
    const start = Number(u.searchParams.get("startIndex") ?? 0);
    starts.push(start);
    if (start >= refuseAfter) return new Response("bad request", { status: 400 });
    const n = Number(u.searchParams.get("count"));
    const features = ids.slice(start, start + n).map((v, i) => ({ id: `W.${start + i}`, properties: { WID: v }, geometry: null }));
    return reply({ type: "FeatureCollection", features, numberMatched: ids.length });
  }, async () => {
    const rows = await wfsProvider.findById(source, "99/1-2");
    assert.deepEqual(rows.map((r) => r.attrs.WID), ["99/01- 2"]);
    assert.deepEqual(starts, [0, 200, 400]);
    starts.length = 0;
    refuseAfter = 200;
    const partial = await wfsProvider.findById(source, "99/10");
    assert.ok(partial.length && partial.every((r) => r.partial), "the first page's partial matches come back");
  });
});

// ---------------------------------------------------------------- WFS paging order

test("WFS unsortedFirstPage: the unsorted page is used only when it holds the whole answer", async () => {
  const source = { key: "TEST-WFS-UNSORTED", url: "https://example.test/wfs", typeName: "W", sortBy: "PKEY", unsortedFirstPage: true, pageMax: 100, searchFields: { well_type: "WT" } };
  const requests = [];
  let total = 3;
  await withFetch(async (u) => {
    const sorted = u.searchParams.has("sortBy");
    requests.push({ sorted, startIndex: u.searchParams.get("startIndex") });
    const n = Number(u.searchParams.get("count"));
    const features = Array.from({ length: Math.min(n, total) }, (_, i) => ({ id: `W.${i}`, properties: { PKEY: sorted ? `s${i}` : `u${i}` }, geometry: null }));
    return reply({ type: "FeatureCollection", features, numberMatched: total });
  }, async () => {
    // Small answer: one fast unsorted request.
    let page = await wfsProvider.search(source, { well_type: "Gas" }, { limit: 5, offset: 0 });
    assert.deepEqual(page.rows.map((r) => r.attrs.PKEY), ["u0", "u1", "u2"]);
    assert.deepEqual(requests, [{ sorted: false, startIndex: null }]);
    // Long answer: the first page is asked for again sorted, the same order as page two.
    requests.length = 0;
    total = 50;
    page = await wfsProvider.search(source, { well_type: "Gas" }, { limit: 5, offset: 0 });
    assert.deepEqual(page.rows.map((r) => r.attrs.PKEY), ["s0", "s1", "s2", "s3", "s4"]);
    assert.deepEqual(requests.map((r) => r.sorted), [false, true]);
    requests.length = 0;
    await wfsProvider.search(source, { well_type: "Gas" }, { limit: 5, offset: 5 });
    assert.deepEqual(requests, [{ sorted: true, startIndex: "5" }]);
  });
});
