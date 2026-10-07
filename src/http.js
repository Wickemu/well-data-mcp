// Shared HTTP helpers: timeout, User-Agent, a per-host concurrency cap, one retry on
// connection-level failures, and errors that say what came back.

import { USER_AGENT } from "./meta.js";
import { completeChain, CHAIN_ERRORS } from "./tls-aia.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// A search across every source fires dozens of requests at once, several to the same
// host (four Argentina layers, four BOEM regions...). Some servers drop connections
// under that; queueing per host keeps it polite and reliable.
const MAX_PER_HOST = 4;
const RETRY_DELAY_MS = 750;

const active = new Map(); // host -> in-flight count
const queues = new Map(); // host -> [resolve]

async function acquire(host) {
  if ((active.get(host) ?? 0) < MAX_PER_HOST) {
    active.set(host, (active.get(host) ?? 0) + 1);
    return;
  }
  await new Promise((resolve) => {
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(resolve);
  });
}

function release(host) {
  const next = queues.get(host)?.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else active.set(host, (active.get(host) ?? 1) - 1);
}

function snippet(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for failures before any HTTP response (reset, refused, DNS hiccup) - worth one retry. */
const isNetworkError = (e) => e?.name === "TypeError" && /fetch failed/i.test(e.message);

async function fetchOnce(full, host, { timeoutMs, headers, method, body, binary }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(full, { method, body, signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}: ${snippet(await res.text())}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function request(url, { params, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = "GET", body, binary = false } = {}) {
  const full = params ? `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(params)}` : url;
  const host = new URL(url).host;
  const opts = { timeoutMs, headers, method, body, binary };
  await acquire(host);
  try {
    try {
      return await fetchOnce(full, host, opts);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // A server that omits its intermediate certificate: fetch it the way browsers do, then retry.
      if (CHAIN_ERRORS.has(e.cause?.code) && new URL(url).protocol === "https:") await completeChain(new URL(url).hostname);
      else await sleep(RETRY_DELAY_MS);
      return await fetchOnce(full, host, opts);
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${host}`);
    if (isNetworkError(e)) throw new Error(`Could not reach ${host} (${e.cause?.code ?? e.cause?.message ?? "network error"})`);
    throw e;
  } finally {
    release(host);
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

/** fetchText + JSON.parse, with a readable error when a server answers with HTML (firewall, maintenance page). */
export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} returned non-JSON (firewall or maintenance page?): ${snippet(text)}`);
  }
}
