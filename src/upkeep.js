// Upkeep for a long-running server (HTTP mode):
// - warm: every hour, refresh any downloaded lookup table or snapshot layer whose copy has
//   expired (BOEM company names, FracFocus operators, the GDR catalog, the snapshot
//   sources), so no caller waits on a refresh;
// - check: once a day, ask every source its own probe query, so a registry that moved or
//   broke shows in /healthz and /sources before a user runs into it.
// The last check is kept in the disk cache, so a restarted server shows it straight away.

import { SOURCES } from "./sources/index.js";
import { providerFor } from "./providers/index.js";
import { warmGdr } from "./gdr.js";
import { readCache, writeCache } from "./disk-cache.js";

const WARM_EVERY_MS = 60 * 60_000;
const CHECK_CONCURRENCY = 6;
const CHECK_TIMEOUT_MS = 90_000;
const FIRST_CHECK_DELAY_MS = 2 * 60_000; // let the warm-up go first
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once for anything longer (about 24.8 days)

/**
 * setTimeout for any delay: past MAX_TIMER_MS it waits in steps until the due time.
 * The timers are unref'd. Returns a function that cancels the wait.
 */
export function waitThen(ms, fn, { maxStep = MAX_TIMER_MS } = {}) {
  const due = Date.now() + Math.max(0, ms);
  let timer;
  const arm = () => {
    const left = Math.max(0, due - Date.now());
    timer = setTimeout(left > maxStep ? arm : fn, Math.min(left, maxStep));
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}

let health = null; // { checkedAt, ms, sources: { KEY: { ok, ms, error? } } }

/** Refresh whatever has expired. Resolves with the errors, one line each. */
export async function warmOnce() {
  const tasks = SOURCES.map((s) => {
    const provider = providerFor(s);
    const warm = s.warm ? () => s.warm() : provider.warm ? () => provider.warm(s) : null;
    return warm ? warm().then(() => null, (e) => `${s.key}: ${e.message}`) : null;
  }).filter(Boolean);
  tasks.push(warmGdr().then(() => null, (e) => `GDR catalog: ${e.message}`));
  return (await Promise.all(tasks)).filter(Boolean);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}

async function checkOne(s) {
  const t0 = Date.now();
  if (!s.probe) return { ok: true, ms: 0, note: "no probe query defined" };
  try {
    const { rows } = await withTimeout(providerFor(s).search(s, s.probe, { limit: 1, offset: 0 }), CHECK_TIMEOUT_MS);
    return rows.length ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, error: `the probe query ${JSON.stringify(s.probe)} found nothing` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 240) };
  }
}

/** Ask every source its probe query, a few at a time. Resolves with the full result and keeps it. */
export async function checkSources(sources = SOURCES) {
  const t0 = Date.now();
  const results = {};
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const s = sources[next++];
      results[s.key] = await checkOne(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, sources.length) }, worker));
  health = { checkedAt: new Date().toISOString(), ms: Date.now() - t0, sources: results };
  await writeCache("source-health", health);
  return health;
}

/** The last check in full (for /sources), or null before the first one. */
export function sourceHealth() {
  return health;
}

/** A short form for /healthz: when, how many answered, which did not. */
export function sourceHealthSummary() {
  if (!health) return null;
  const entries = Object.entries(health.sources);
  const failing = entries.filter(([, r]) => !r.ok).map(([key]) => key);
  return { checkedAt: health.checkedAt, answering: entries.length - failing.length, of: entries.length, failing };
}

/**
 * Start the background upkeep. checkEveryHours 0 turns the daily check off.
 * Timers are unref'd: they never keep a process alive on their own.
 */
export async function startUpkeep({ checkEveryHours = 24, log = (line) => console.error(line) } = {}) {
  const stamp = () => new Date().toISOString();
  const warm = async () => {
    const errors = await warmOnce();
    if (errors.length) log(`${stamp()} warm-up: ${errors.length} refresh(es) failed: ${errors.join("; ")}`);
  };
  warm();
  setInterval(warm, WARM_EVERY_MS).unref();

  if (!(checkEveryHours > 0)) return;
  const every = checkEveryHours * 3600_000;
  const saved = await readCache("source-health");
  if (saved?.value?.sources) health = saved.value;
  const check = async () => {
    try {
      const h = await checkSources();
      const s = sourceHealthSummary();
      log(`${stamp()} source check: ${s.answering}/${s.of} answered in ${Math.round(h.ms / 1000)} s${s.failing.length ? `; not answering: ${s.failing.join(", ")}` : ""}`);
    } catch (e) {
      log(`${stamp()} source check failed: ${e?.stack ?? e}`);
    } finally {
      waitThen(every, check);
    }
  };
  const age = health ? Date.now() - Date.parse(health.checkedAt) : Infinity;
  waitThen(Math.max(FIRST_CHECK_DELAY_MS, every - age), check);
}
