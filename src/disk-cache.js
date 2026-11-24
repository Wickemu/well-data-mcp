// A small JSON cache on disk, shared by every process on the machine: snapshot layers,
// BOEM's company names, FracFocus's operator list, the GDR catalog. A one-off process (a
// script, a client that starts a server per lookup) then starts from the last download
// instead of repeating it, and still has data while the server it came from is down.
//
// Directory: WELL_DATA_CACHE_DIR (default: well-data-mcp-cache in the OS temp folder);
// "off" keeps everything in memory only. Each entry records the server version that wrote
// it, and a copy written by another version counts as absent (a loader may build its
// records differently). Writes go to a temp file and are renamed into place, so a reader
// never sees half a file. A cache that cannot be read or written is never an error.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "./meta.js";
import { detached } from "./call-context.js";

export function cacheDir() {
  const dir = process.env.WELL_DATA_CACHE_DIR;
  if (dir && /^(off|none|0|false)$/i.test(dir.trim())) return null;
  return dir || join(tmpdir(), "well-data-mcp-cache");
}

const pathOf = (dir, key) => join(dir, `${String(key).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** The saved entry, or null: { at, value }. */
export async function readCache(key) {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    const entry = JSON.parse(await readFile(pathOf(dir, key), "utf8"));
    if (entry?.version !== VERSION || !Number.isFinite(entry.at) || !("value" in entry)) return null;
    return { at: entry.at, value: entry.value };
  } catch {
    return null;
  }
}

/** Save a value (anything JSON can hold), stamped with when it was fetched. Best effort. */
export async function writeCache(key, value, at = Date.now()) {
  const dir = cacheDir();
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const file = pathOf(dir, key);
    const partial = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part`;
    await writeFile(partial, JSON.stringify({ version: VERSION, at, value }));
    await rename(partial, file);
  } catch {
    // a read-only disk or a full one: carry on without the copy
  }
}

// After a failed refresh, keep serving the stale copy this long before trying again, so a
// source whose server is down does not cost a full download timeout on every call.
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/**
 * A value fetched by load(), kept in memory and on disk for ttlMs.
 *   get()      the value: from memory, else a fresh enough disk copy, else load(). A load
 *              that fails falls back to any copy at hand, however old ("stale beats nothing"),
 *              and is not retried for 10 minutes.
 *   peek()     what is in memory right now, or null (never fetches)
 *   forget()   drop the memory copy (tests: stands in for a new process)
 * Concurrent get() calls share one load.
 */
export function cachedValue(key, load, { ttlMs }) {
  let memory = null; // { at, value }
  let retryAt = 0; // while a stale copy is served after a failed refresh
  let loading = null;
  const fresh = (e) => e && Date.now() - e.at < ttlMs;
  async function refresh() {
    const disk = memory ? null : await readCache(key);
    if (fresh(disk)) return (memory = disk).value;
    const stale = memory ?? disk;
    try {
      // Detached: callers share this load, so one caller's deadline must not cancel it.
      const entry = { at: Date.now(), value: await detached(load) };
      memory = entry;
      retryAt = 0;
      await writeCache(key, entry.value, entry.at); // awaited: a one-off process may exit right after answering
      return entry.value;
    } catch (e) {
      if (!stale) throw e;
      memory = stale;
      retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      return stale.value;
    }
  }
  return {
    async get() {
      if (fresh(memory) || (memory && Date.now() < retryAt)) return memory.value;
      loading ??= refresh().finally(() => (loading = null));
      return loading;
    },
    peek: () => memory?.value ?? null,
    /** When the value in memory was fetched (ms), or null. */
    fetchedAt: () => memory?.at ?? null,
    forget() {
      memory = null;
      retryAt = 0;
    },
  };
}
