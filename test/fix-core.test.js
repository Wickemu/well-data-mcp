// Offline tests: paging a layer that repeats rows (dedupeBy), the shared Texas RRC query
// when one call sharing it is abandoned, and the circuit breaker for requests that were
// waiting for a host slot when the host was closed off.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PROVIDERS } from "../src/providers/index.js";
import { searchOneSource } from "../src/search.js";
import { rrcEwaProvider } from "../src/providers/rrc-ewa.js";
import { fetchText, resetHosts } from "../src/http.js";
import { callContext } from "../src/call-context.js";

// ------------------------------------------------------------------ dedupeBy paging

// 1,300 server rows for 650 invented wells (each listed twice, side by side), served in
// pages like an ArcGIS layer; the provider drops repeats within one answer, as arcgis does.
const SERVER_ROWS = Array.from({ length: 1300 }, (_, i) => ({ WELL_ID: `W${String(Math.floor(i / 2)).padStart(4, "0")}`, WELL_NAME: `Imaginary ${Math.floor(i / 2)}` }));
PROVIDERS["fake-repeats"] = {
  async search(_source, _filters, { limit, offset = 0 }) {
    const page = SERVER_ROWS.slice(offset, offset + Math.min(limit, 500));
    const seen = new Set();
    const rows = page.filter((r) => !seen.has(r.WELL_ID) && seen.add(r.WELL_ID)).map((attrs) => ({ attrs, geometry: null }));
    return { rows, moreAvailable: SERVER_ROWS.length > offset + Math.min(limit, 500), unsupported: [] };
  },
};
const REPEATS = {
  key: "TEST-REPEATS",
  label: "Invented layer that repeats rows",
  kind: "fake-repeats",
  country: "ZZ",
  pageMax: 500,
  dedupeBy: "WELL_ID",
  searchFields: { api: "WELL_ID", well_name: "WELL_NAME", county: "COUNTY" },
  normalize: (a) => ({ api: a.WELL_ID, wellName: a.WELL_NAME }),
};

test("dedupeBy paging: offsets past one server answer still page, without repeats or gaps", async () => {
  const pages = [];
  for (const offset of [0, 240, 480, 500, 625]) {
    const r = await searchOneSource(REPEATS, { county: "Nowhere" }, { limit: 25, offset });
    pages.push({ offset, r });
  }
  const at = (o) => pages.find((p) => p.offset === o).r;
  assert.equal(at(0).returned, 25);
  assert.equal(at(0).moreAvailable, true);
  assert.equal(at(480).returned, 25, "a page that crosses a server answer is full");
  assert.equal(at(500).returned, 25, "offset 500 (= pageMax) is not empty");
  assert.equal(at(500).moreAvailable, true);
  assert.equal(at(625).returned, 25, "the last 25 of 650 wells");
  assert.equal(at(625).moreAvailable, false);
  // Unique row n is invented well n: page boundaries line up exactly.
  for (const { offset, r } of pages) assert.equal(r.wells[0].wellName, `Imaginary ${offset}`);
  assert.equal(at(480).wells.at(-1).wellName, "Imaginary 504");
  // Every well in order, once, when paged through.
  const all = [];
  for (let offset = 0; offset < 650; offset += 50) all.push(...(await searchOneSource(REPEATS, { county: "Nowhere" }, { limit: 50, offset })).wells.map((w) => w.wellName));
  assert.equal(all.length, 650);
  assert.equal(new Set(all).size, 650);
});

test("dedupeBy paging: an offset beyond the paged answers falls back to the server's paging with a note", async () => {
  const deep = { ...REPEATS, pageMax: 20 }; // 10 answers of 20 server rows = 100 wells read
  const r = await searchOneSource(deep, { county: "Nowhere" }, { limit: 5, offset: 400 });
  assert.ok(r.returned > 0, "not reported as no matches");
  assert.equal(r.moreAvailable, true);
  assert.match(r.note, /server's own paging/);
  // 200 server rows (100 wells) were read; unique row 400 is asked for at server row 200 + 300.
  assert.equal(r.wells[0].wellName, "Imaginary 250");
});

// ------------------------------------------------------------------ shared RRC query

test("rrc-ewa: when one call sharing the wellbore query is abandoned, the other still gets its answer", async () => {
  const realFetch = globalThis.fetch;
  let downloads = 0;
  const csv = "API No.,Lease Name,Well No.,Field Name,County\n00312345,INVENTED RANCH,1,NOWHERE (WOLFCAMP),ANDREWS\n";
  globalThis.fetch = async (url, { signal } = {}) => {
    const u = String(url);
    if (u.includes("wellboreQueryAction")) {
      downloads++;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 400);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return new Response(csv);
    }
    // the GIS coordinate join: no coordinates
    return new Response(JSON.stringify({ features: [] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const source = { key: "TX-RRC", kind: "rrc-ewa" };
    const filters = { county: "Andrews", field: "Nowhere" }; // a query no other test shares
    const ac = new AbortController();
    const a = callContext.run({ signal: ac.signal }, () => rrcEwaProvider.search(source, filters, { limit: 5 }));
    await new Promise((r) => setTimeout(r, 50));
    const b = callContext.run({ signal: null }, () => rrcEwaProvider.search(source, filters, { limit: 5 }));
    setTimeout(() => ac.abort(new Error("the call answered after its 25 s budget")), 150);
    const t0 = Date.now();
    await assert.rejects(a, /Abandoned: the call answered after its 25 s budget/);
    assert.ok(Date.now() - t0 < 300, "the abandoned call stops waiting at once");
    const answer = await b;
    assert.equal(answer.rows.length, 1);
    assert.equal(answer.rows[0].attrs["Lease Name"], "INVENTED RANCH");
    assert.equal(downloads, 1, "one shared download");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------------ circuit breaker

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test("http: requests queued for a slot when the host is closed off fail at once instead of each timing out", async () => {
  resetHosts();
  let seen = 0;
  const { server, base } = await serve(() => {
    seen++; // never answers
  });
  try {
    const t0 = Date.now();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => fetchText(`${base}/x`, { timeoutMs: 500 })));
    const took = Date.now() - t0;
    const timedOut = results.filter((r) => /Timed out/.test(r.reason?.message)).length;
    const skipped = results.filter((r) => /not answering/.test(r.reason?.message)).length;
    // The first round of four times out. The breaker closes on the third failure, so the
    // two waiters handed a slot by the first two failures still go out; the rest are skipped.
    assert.ok(timedOut <= 6, `at most six time out (${timedOut})`);
    assert.equal(timedOut + skipped, 12);
    assert.ok(skipped >= 6, `the queued requests are skipped (${skipped})`);
    assert.equal(seen, timedOut, "a skipped request never reaches the host");
    assert.ok(took < 1400, `two timeouts deep, not three (${took} ms)`);
  } finally {
    resetHosts();
    server.closeAllConnections?.();
    server.close();
  }
});
