// Streamable HTTP mode: one long-running server that many MCP clients share, so the caches
// (snapshot layers, BOEM company names, FracFocus operators, moved ArcGIS layers, failovers,
// fixed certificate chains) stay warm between calls.
//
// Stateless: every POST to /mcp gets a fresh McpServer + transport, and answers with plain
// JSON (no session, no SSE stream), so a restart is invisible to clients and any proxy
// works. GET /healthz needs no token and says what the server covers.
// Hardening: optional bearer token (constant-time compare), a cap on requests handled at
// once with a bounded queue (503 + Retry-After past it), a 1 MB body limit (413), and a
// graceful stop on SIGTERM/SIGINT. Without a token, /mcp answers only requests whose Host is
// an IP address, localhost, the listen host or a name in WELL_DATA_HTTP_ALLOWED_HOSTS
// (comma-separated), and whose Origin, if sent, is one of those too: a web page cannot
// reach a token-less server through DNS rebinding.

import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1_000_000;
const QUEUE_PER_SLOT = 8; // requests allowed to wait per concurrent slot before 503
const STOP_GRACE_MS = 15_000;
const DRAIN_MAX_BYTES = 16 * MAX_BODY_BYTES; // past this an oversized body is cut off instead of read to the end

/** "8110", "0.0.0.0:8110", "[::1]:8110", "localhost:8110" -> { host, port }; the host defaults to 127.0.0.1. */
export function parseListen(text) {
  const s = String(text).trim();
  let host = "127.0.0.1";
  let portText = s;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (v6) [, host, portText] = v6;
  else if (s.includes(":")) {
    const i = s.lastIndexOf(":");
    host = s.slice(0, i) || host;
    portText = s.slice(i + 1);
  }
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || !(port > 0 && port < 65536)) throw new Error(`Cannot read --http '${text}': use [host:]port, e.g. 8110 or 0.0.0.0:8110`);
  return { host, port };
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

const rpcError = (code, message) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1].trim() : null;
}

/**
 * The request body as text. A body over MAX_BODY_BYTES is read to the end and dropped, then
 * rejects with status 413, so the client is still listening when the 413 goes out.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooBig = () => Object.assign(new Error(`Request body over ${MAX_BODY_BYTES} bytes`), { status: 413 });
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else if (size > DRAIN_MAX_BYTES) {
        reject(tooBig());
        req.destroy();
      }
    });
    req.on("end", () => (size > MAX_BODY_BYTES ? reject(tooBig()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** The host name in a Host header ("example.org:8110", "[::1]:8110"), lower case, or "". */
function hostOf(header) {
  const h = String(header ?? "").trim().toLowerCase();
  const v6 = /^\[([^\]]*)\]/.exec(h);
  if (v6) return v6[1];
  return h.replace(/:\d*$/, "");
}

/** Host names a token-less server answers to: loopback names, the listen host, WELL_DATA_HTTP_ALLOWED_HOSTS. */
function allowedHostNames(listenHost) {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  const own = hostOf(listenHost.includes(":") && !listenHost.startsWith("[") ? `[${listenHost}]` : listenHost);
  if (own && own !== "0.0.0.0" && own !== "::") names.add(own);
  for (const h of String(process.env.WELL_DATA_HTTP_ALLOWED_HOSTS ?? "").split(",")) if (h.trim()) names.add(hostOf(h));
  return names;
}

/**
 * Why a token-less request looks like it came through DNS rebinding, or null when it is fine.
 * A browser sends the name it resolved as Host, so an IP address there cannot be a rebound name.
 */
function rebindingProblem(req, names) {
  const host = hostOf(req.headers.host);
  if (!host || !(names.has(host) || isIP(host))) return `Host '${req.headers.host ?? ""}' is not allowed`;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let name = "";
    try {
      name = hostOf(new URL(origin).host);
    } catch {}
    if (!name || !names.has(name)) return `Origin '${origin}' is not allowed`;
  }
  return null;
}

/** What a JSON-RPC body asks for, for the log: 'tools/call match_well', 'initialize', ... (never the arguments). */
function describe(body) {
  const list = Array.isArray(body) ? body : [body];
  return list.map((m) => (m?.method === "tools/call" ? `tools/call ${m.params?.name ?? "?"}` : m?.method ?? "response")).join(", ");
}

/** A counting semaphore with a bounded queue. */
function limiter(slots) {
  let active = 0;
  const waiting = [];
  return {
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
    /** Resolves to a release function, or null when the queue is full. */
    async acquire() {
      if (active < slots) {
        active++;
        return () => this.release();
      }
      if (waiting.length >= slots * QUEUE_PER_SLOT) return null;
      await new Promise((resolve) => waiting.push(resolve));
      return () => this.release();
    },
    release() {
      const next = waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else active--;
    },
  };
}

let processHooked = false;

/**
 * Listen for MCP over Streamable HTTP. Resolves with the node http.Server once listening
 * (port 0 picks a free one: read it from server.address().port).
 * createServer() must return a new McpServer with every tool registered.
 * signals: stop gracefully on SIGTERM/SIGINT and log stray rejections instead of crashing
 * (off for tests that start several servers in one process).
 */
export async function serveHttp({ host = "127.0.0.1", port, token = null, maxCalls = 8, createServer, info = () => ({}), pages = {}, log = (line) => console.error(line), signals = true }) {
  const slots = limiter(Math.max(1, maxCalls));
  const startedAt = Date.now();
  const hostNames = allowedHostNames(host);
  let stopping = false;
  const running = new Set(); // responses of tool calls in progress, told to close their connection on a stop

  const handle = async (req, res) => {
    const t0 = Date.now();
    if (stopping) res.shouldKeepAlive = false; // Connection: close, so the socket does not hold up the stop
    let path;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendJson(res, 400, { error: "Cannot read the request target." }, { Connection: "close" });
    }
    if (path === "/healthz" || path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "GET only" }, { Allow: "GET" });
      return sendJson(res, stopping ? 503 : 200, { ok: !stopping, ...info(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), active: slots.active, queued: slots.queued });
    }
    // Read-only status pages (e.g. /sources: the last check of every source), no token needed.
    if (pages[path] && (req.method === "GET" || req.method === "HEAD")) {
      const body = pages[path]();
      return body == null ? sendJson(res, 404, { error: "Nothing to show yet." }) : sendJson(res, 200, body);
    }
    if (path !== "/mcp") return sendJson(res, 404, { error: "Not found. MCP is served at /mcp; /healthz answers health checks." });
    if (!token) {
      const problem = rebindingProblem(req, hostNames);
      if (problem) {
        log(`${new Date().toISOString()} 403 ${problem}`);
        return sendJson(res, 403, rpcError(-32000, `Forbidden: ${problem}. Without a token the server answers local names only; add others to WELL_DATA_HTTP_ALLOWED_HOSTS.`));
      }
    }
    if (token && !sameToken(bearerOf(req) ?? "", token)) {
      return sendJson(res, 401, rpcError(-32001, "Unauthorized: send Authorization: Bearer <token>"), { "WWW-Authenticate": 'Bearer realm="well-data-mcp"' });
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream to GET and no session to DELETE.
      return sendJson(res, 405, rpcError(-32000, "Method not allowed: POST JSON-RPC messages to /mcp."), { Allow: "POST" });
    }
    if (stopping) return sendJson(res, 503, rpcError(-32000, "Server is restarting; try again in a few seconds."), { "Retry-After": "5" });

    let body;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch (e) {
      return sendJson(res, e.status ?? 400, rpcError(-32700, e.status ? e.message : "Parse error: the body is not JSON"), e.status === 413 ? { Connection: "close" } : {});
    }
    const what = describe(body);
    // The client may go while the request waits for a slot: then the tool is not run at all.
    let gone = false;
    const onGone = () => (gone = true);
    res.once("close", onGone);
    const release = await slots.acquire();
    res.off("close", onGone);
    if (!release) {
      log(`${new Date().toISOString()} 503 busy ${what}`);
      return sendJson(res, 503, rpcError(-32000, "Server busy: too many requests waiting. Try again shortly."), { "Retry-After": "10" });
    }
    if (gone || res.destroyed || res.writableEnded) {
      release();
      log(`${new Date().toISOString()} gone ${what} (the client left while it waited) ${Date.now() - t0}ms`);
      return;
    }
    if (stopping) res.shouldKeepAlive = false;
    running.add(res);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      running.delete(res);
      release();
      transport.close().catch(() => {});
      server.close().catch(() => {});
      if (what !== "notifications/initialized") log(`${new Date().toISOString()} ${res.statusCode} ${what} ${Date.now() - t0}ms`);
      if (stopping) setImmediate(() => http.closeIdleConnections?.());
    };
    res.on("close", done);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`${new Date().toISOString()} error ${what}: ${e?.stack ?? e}`);
      sendJson(res, 500, rpcError(-32603, "Internal error"));
    } finally {
      if (res.writableEnded) done();
    }
  };

  const http = createHttpServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`${new Date().toISOString()} error ${req.method} ${req.url}: ${e?.stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal error"));
      else res.destroy();
    });
  });
  http.keepAliveTimeout = 65_000;
  http.headersTimeout = 70_000;

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });

  /**
   * Stop taking requests, finish the ones in hand, and close keep-alive connections as each
   * goes idle. Resolves once every connection has closed.
   */
  let stopped = null;
  http.stopGracefully = (why = "stop") => {
    if (stopped) return stopped;
    stopping = true;
    for (const res of running) if (!res.headersSent) res.shouldKeepAlive = false;
    log(`${new Date().toISOString()} ${why}: finishing ${slots.active} request(s), then stopping`);
    stopped = new Promise((resolve) => http.close(() => resolve()));
    http.closeIdleConnections?.();
    return stopped;
  };

  if (signals && !processHooked) {
    processHooked = true;
    // Keep serving through a stray rejection in one request; log it instead of crashing.
    process.on("unhandledRejection", (e) => log(`${new Date().toISOString()} unhandled rejection: ${e?.stack ?? e}`));
    const stop = (signal) => {
      if (stopping) return;
      http.stopGracefully(signal).then(() => process.exit(0));
      setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  }
  return http;
}
