// Offline tests of the shared disk cache and the daily source check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedValue, readCache } from "../src/disk-cache.js";
import { checkSources, sourceHealthSummary } from "../src/upkeep.js";
import { PROVIDERS } from "../src/providers/index.js";

async function withCacheDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "well-data-cache-"));
  const before = process.env.WELL_DATA_CACHE_DIR;
  process.env.WELL_DATA_CACHE_DIR = dir;
  try {
    await fn(dir);
  } finally {
    process.env.WELL_DATA_CACHE_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
}

test("cachedValue: one load shared by concurrent callers, saved for the next process", async () => {
  await withCacheDir(async (dir) => {
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return [["00001", "Example Offshore LLC"]];
    };
    const a = cachedValue("test-list", load, { ttlMs: 60_000 });
    const [x, y] = await Promise.all([a.get(), a.get()]);
    assert.equal(loads, 1);
    assert.deepEqual(x, y);
    assert.deepEqual(await readdir(dir), ["test-list.json"]);
    // A second process (a new cachedValue on the same key) reads the disk copy.
    const b = cachedValue("test-list", load, { ttlMs: 60_000 });
    assert.deepEqual(await b.get(), x);
    assert.equal(loads, 1);
  });
});

test("cachedValue: an expired copy is served when the refresh fails, and the refresh waits before trying again", async () => {
  await withCacheDir(async () => {
    let calls = 0;
    let fail = false;
    const c = cachedValue("test-flaky", async () => {
      calls++;
      if (fail) throw new Error("server down");
      return { n: calls };
    }, { ttlMs: 0 }); // always expired
    assert.deepEqual(await c.get(), { n: 1 });
    fail = true;
    assert.deepEqual(await c.get(), { n: 1 }, "stale beats nothing");
    assert.deepEqual(await c.get(), { n: 1 });
    assert.equal(calls, 2, "no second refresh attempt right after a failure");
    c.forget();
    assert.deepEqual(await c.get(), { n: 1 }, "after a restart, the disk copy is the stale copy");
    const none = cachedValue("test-never", async () => {
      throw new Error("server down");
    }, { ttlMs: 60_000 });
    await assert.rejects(none.get(), /server down/, "no copy at all: the error surfaces");
    assert.equal(await readCache("test-never"), null);
  });
});

test("source check: probes every source, records failures, summarizes for /healthz", async () => {
  await withCacheDir(async () => {
    const original = PROVIDERS.snapshot;
    PROVIDERS.snapshot = {
      ...original,
      async search(source) {
        if (source.key === "T-DOWN") throw new Error("HTTP 404 from example.org");
        return { rows: source.key === "T-EMPTY" ? [] : [{ attrs: {}, geometry: null }], moreAvailable: false };
      },
    };
    try {
      const mk = (key) => ({ key, kind: "snapshot", probe: { well_name: "Example" }, searchFields: { well_name: "NAME" } });
      const h = await checkSources([mk("T-OK"), mk("T-DOWN"), mk("T-EMPTY")]);
      assert.equal(h.sources["T-OK"].ok, true);
      assert.match(h.sources["T-DOWN"].error, /404/);
      assert.match(h.sources["T-EMPTY"].error, /found nothing/);
      assert.deepEqual(sourceHealthSummary().failing.sort(), ["T-DOWN", "T-EMPTY"]);
      assert.equal((await readCache("source-health")).value.sources["T-OK"].ok, true, "kept for a restarted server");
    } finally {
      PROVIDERS.snapshot = original;
    }
  });
});
