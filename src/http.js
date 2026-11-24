// Shared HTTP helpers: timeout, User-Agent, a per-host concurrency cap, one retry on
// connection-level failures and on "busy, try again" statuses, errors that say what came
// back, and two guards for a long-running server:
// - Calls: every request made on behalf of a tool call can be abandoned when that call no
//   longer needs it (its time budget ran out, or the client went away). The call's signal
//   travels with the work (src/call-context.js), so providers need not pass it along; an
//   abandoned request leaves its host's queue or aborts its fetch, which frees the slot for
//   the next caller. Shared downloads that outlive one call run detached().
// - Hosts that are down: after BREAK_AFTER outage-type failures in a row (no connection, a
//   timeout, 502/503/504) a host is skipped for BREAK_FOR_MS, so each request to it fails at
//   once instead of costing a full timeout; then requests flow again, and the next failures
//   close it off again. Any real answer, even an error status, resets the count.

import { USER_AGENT } from "./meta.js";
import { completeChain, CHAIN_ERRORS } from "./tls-aia.js";
import { callSignal } from "./call-context.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// A search across every source fires dozens of requests at once, several to the same
// host (four Argentina layers, four BOEM regions...). Some servers drop connections
// under that; queueing per host keeps it polite and reliable.
const MAX_PER_HOST = 4;
const RETRY_DELAY_MS = 750;
// Statuses that mean "not now" rather than "no": rate limit, gateway hiccup, restarting service.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const OUTAGE_STATUS = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5_000;
const BREAK_AFTER = 3;
const BREAK_FOR_MS = 120_000;

function abandoned(signal) {
  const e = new Error(`Abandoned: ${signal?.reason?.message ?? "the call no longer needs this answer"}`);
  e.abandoned = true;
  return e;
}

const active = new Map(); // host -> in-flight count
const queues = new Map(); // host -> [grant]

async function acquire(host, signal) {
  if (signal?.aborted) throw abandoned(signal);
  if ((active.get(host) ?? 0) < MAX_PER_HOST) {
    active.set(host, (active.get(host) ?? 0) + 1);
    return;
  }
  if (!queues.has(host)) queues.set(host, []);
  const queue = queues.get(host);
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = queue.indexOf(grant);
      if (i >= 0) queue.splice(i, 1);
      reject(abandoned(signal));
    };
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(grant);
  });
}

function release(host) {
  const next = queues.get(host)?.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else active.set(host, (active.get(host) ?? 1) - 1);
}

// ------------------------------------------------------------------ circuit breaker

const breakers = new Map(); // host -> { fails, until, reason }

function checkBreaker(host) {
  const b = breakers.get(host);
  if (b?.until > Date.now()) {
    const e = new Error(`${host} is not answering (${b.reason}; ${b.fails} failures in a row), so it is skipped for the next ${Math.ceil((b.until - Date.now()) / 1000)} s`);
    e.skipped = true;
    throw e;
  }
}

const isOutage = (e) => Boolean(e?.timeout || e?.unreachable || OUTAGE_STATUS.has(e?.status));

/** After a request's final outcome: an outage counts toward closing the host off; anything else reopens it. */
function noteOutcome(host, error) {
  if (error?.abandoned || error?.skipped) return; // says nothing about the host
  if (!isOutage(error)) {
    breakers.delete(host);
    return;
  }
  const b = breakers.get(host) ?? { fails: 0 };
  b.fails++;
  b.reason = error.status ? `HTTP ${error.status}` : error.timeout ? "timed out" : "unreachable";
  if (b.fails >= BREAK_AFTER) b.until = Date.now() + BREAK_FOR_MS;
  breakers.set(host, b);
}

/** Hosts being skipped right now, for /healthz: [{ host, reason, fails, seconds }]. */
export function skippedHosts() {
  const now = Date.now();
  return [...breakers].filter(([, b]) => b.until > now).map(([host, b]) => ({ host, reason: b.reason, fails: b.fails, seconds: Math.ceil((b.until - now) / 1000) }));
}

/** Forget every host's failures (tests). */
export function resetHosts() {
  breakers.clear();
}

// ------------------------------------------------------------------ requests

function snippet(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(abandoned(signal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** True for failures before any HTTP response (reset, refused, DNS hiccup) - worth one retry. */
const isNetworkError = (e) => e?.name === "TypeError" && /fetch failed/i.test(e.message);

async function fetchOnce(full, host, { timeoutMs, headers, method, body, binary, signal, cancel = null }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onCallAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onCallAbort, { once: true });
  cancel?.addEventListener("abort", onCallAbort, { once: true }); // a hedged twin answered first
  try {
    const res = await fetch(full, { method, body, signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, ...headers } });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} from ${host}: ${snippet(await res.text())}`);
      e.status = res.status;
      e.retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || null; // seconds form only
      throw e;
    }
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onCallAbort);
    cancel?.removeEventListener("abort", onCallAbort);
  }
}

/**
 * fetchOnce, hedged: when no answer has come after `after` ms, the same request goes out a
 * second time and the first answer wins (the other is aborted). For servers whose instances
 * sometimes stall (gis.boem.gov answers some requests in ~40 s and the rest in 0.5 s). An
 * error before the second request goes out is reported at once; after it, the other request
 * still gets its chance.
 */
function hedgedFetch(full, host, opts, after) {
  return new Promise((resolve, reject) => {
    const cancels = [];
    let settled = false;
    let twinSent = false;
    let failures = 0;
    let firstError = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of cancels) c.abort();
      fn(value);
    };
    const send = () => {
      const cancel = new AbortController();
      cancels.push(cancel);
      fetchOnce(full, host, { ...opts, cancel: cancel.signal }).then(
        (v) => {
          cancels.splice(cancels.indexOf(cancel), 1);
          finish(resolve, v);
        },
        (e) => {
          failures++;
          firstError ??= e;
          if (!twinSent || failures === 2) finish(reject, firstError);
        }
      );
    };
    send();
    const timer = setTimeout(() => {
      if (settled) return;
      twinSent = true;
      send();
    }, after);
  });
}

async function request(url, { params, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = "GET", body, binary = false, hedgeAfterMs = 0 } = {}) {
  const full = params ? `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(params)}` : url;
  const host = new URL(url).host;
  const signal = callSignal();
  const opts = { timeoutMs, headers, method, body, binary, signal };
  checkBreaker(host);
  await acquire(host, signal);
  let outcome = null;
  try {
    checkBreaker(host); // the host may have been closed off while this request waited for a slot
    try {
      return await (hedgeAfterMs > 0 ? hedgedFetch(full, host, opts, hedgeAfterMs) : fetchOnce(full, host, opts));
    } catch (e) {
      if (signal?.aborted) throw e;
      if (RETRY_STATUS.has(e.status)) await sleep(Math.min(e.retryAfterMs ?? RETRY_DELAY_MS * 2, MAX_RETRY_AFTER_MS), signal);
      else if (!isNetworkError(e)) throw e;
      // A server that omits its intermediate certificate: fetch it the way browsers do, then retry.
      else if (CHAIN_ERRORS.has(e.cause?.code) && new URL(url).protocol === "https:") await completeChain(new URL(url).hostname);
      else await sleep(RETRY_DELAY_MS, signal);
      checkBreaker(host);
      return await fetchOnce(full, host, opts);
    }
  } catch (e) {
    if (signal?.aborted) outcome = abandoned(signal);
    else if (e.name === "AbortError") outcome = Object.assign(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${host}`), { timeout: true });
    else if (isNetworkError(e)) outcome = Object.assign(new Error(`Could not reach ${host} (${e.cause?.code ?? e.cause?.message ?? "network error"})`), { unreachable: true });
    else outcome = e;
    throw outcome;
  } finally {
    release(host);
    noteOutcome(host, outcome);
  }
}

/**
 * GET (or POST) a URL and return the response body as text.
 * `params` are appended as a query string; pass a prebuilt URL instead when a
 * server needs '%20' rather than '+' for spaces (OSTI, Overpass).
 */
export const fetchText = (url, opts) => request(url, { ...opts, binary: false });

/** Same as fetchText, returning a Buffer (zip files). */
export const fetchBuffer = (url, opts) => request(url, { ...opts, binary: true });

/**
 * fetchText + JSON.parse, with a readable error when a server answers with HTML (firewall, maintenance page).
 * `ifEmpty`: what an empty body means, for servers that answer "no results" with nothing at all.
 */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  if (opts.ifEmpty !== undefined && !text.trim()) return opts.ifEmpty;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} returned non-JSON (firewall or maintenance page?): ${snippet(text)}`);
  }
}
