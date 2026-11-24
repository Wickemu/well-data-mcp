// Offline tests of the HTTP mode's edges: unreadable request targets, oversized bodies,
// Host/Origin checks without a token, clients that leave while queued, the graceful stop,
// long timers in upkeep, and call-tool's move to a local server.
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serveHttp } from "../src/http-server.js";
import { waitThen } from "../src/upkeep.js";

const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fileURLToPath(new URL("..", import.meta.url));

/** An MCP server with one tool, list_sources, that waits `ms` (or for `gate`) and counts its runs. */
function slowTools(ms, runs = { n: 0 }, gate = null) {
  return () => {
    const s = new McpServer({ name: "slow", version: "1" });
    s.registerTool("list_sources", { inputSchema: { country: z.string().optional() } }, async () => {
      runs.n++;
      await (gate ?? sleep(ms));
      return { content: [{ type: "text", text: '{"from":"http"}' }] };
    });
    return s;
  };
}

async function start(opts) {
  const http = await serveHttp({ host: "127.0.0.1", port: 0, createServer: slowTools(0), log: quiet, signals: false, ...opts });
  return { http, port: http.address().port };
}

const callBody = (id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_sources", arguments: {} } });

/** A raw request, so Host and the request target can be anything. Resolves with { status, headers, text } or { error }. */
function raw(port, { path = "/mcp", method = "POST", headers = {}, body = callBody(), agent } = {}) {
  return new Promise((resolve) => {
    const r = request(
      { host: "127.0.0.1", port, path, method, agent, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    r.on("error", (e) => resolve({ error: e.code ?? e.message }));
    r.setTimeout(3000, () => r.destroy(new Error("no answer in 3 s")));
    r.end(body);
  });
}

test("http: a request target that is not a URL gets 400, and the server keeps serving", async () => {
  const { http, port } = await start({});
  try {
    assert.equal((await raw(port, { path: "//" })).status, 400);
    assert.equal((await raw(port, { path: "/healthz", method: "GET", body: undefined })).status, 200);
  } finally {
    http.close();
  }
});

test("http: a body over 1 MB is answered 413, not a reset connection", async () => {
  const { http, port } = await start({});
  try {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(1_000_050) });
    const res = await raw(port, { body: big });
    assert.equal(res.status, 413);
    assert.match(JSON.parse(res.text).error.message, /over 1000000 bytes/);
  } finally {
    http.close();
  }
});

test("http: without a token, /mcp answers local and listed host names only, and local origins only", async () => {
  process.env.WELL_DATA_HTTP_ALLOWED_HOSTS = "wells.example.org, other.example.org:8443";
  let open;
  try {
    open = await start({});
  } finally {
    delete process.env.WELL_DATA_HTTP_ALLOWED_HOSTS;
  }
  const { http, port } = open;
  const withToken = await start({ token: "s3cret" });
  try {
    const status = async (headers, p = port) => (await raw(p, { headers })).status;
    assert.equal(await status({ Host: `127.0.0.1:${port}` }), 200);
    assert.equal(await status({ Host: `localhost:${port}` }), 200);
    assert.equal(await status({ Host: `[::1]:${port}` }), 200);
    assert.equal(await status({ Host: "192.168.1.20:8110" }), 200, "an IP address cannot be a rebound name");
    assert.equal(await status({ Host: "wells.example.org" }), 200);
    assert.equal(await status({ Host: "other.example.org" }), 200);
    assert.equal(await status({ Host: "evil.example" }), 403);
    assert.equal(await status({ Host: `localhost:${port}`, Origin: "http://evil.example" }), 403);
    assert.equal(await status({ Host: `localhost:${port}`, Origin: "null" }), 403);
    assert.equal(await status({ Host: `localhost:${port}`, Origin: "http://localhost:6274" }), 200);
    // /healthz is not gated.
    assert.equal((await raw(port, { path: "/healthz", method: "GET", body: undefined, headers: { Host: "evil.example" } })).status, 200);
    // With a token, a proxy's public name is fine.
    assert.equal(await status({ Host: "welldata.example.org", Authorization: "Bearer s3cret" }, withToken.port), 200);
  } finally {
    http.close();
    withToken.http.close();
  }
});

test("http: a queued request whose client left does not run its tool", async () => {
  const runs = { n: 0 };
  const { http, port } = await start({ createServer: slowTools(600, runs), maxCalls: 1 });
  try {
    const base = `http://127.0.0.1:${port}/mcp`;
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const a = fetch(base, { method: "POST", headers, body: callBody(1) });
    await sleep(100);
    const ctl = new AbortController();
    const b = fetch(base, { method: "POST", headers, body: callBody(2), signal: ctl.signal }).catch(() => "aborted");
    await sleep(100);
    ctl.abort();
    assert.equal((await a).status, 200);
    assert.equal(await b, "aborted");
    await sleep(800);
    assert.equal(runs.n, 1);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.active, 0);
    assert.equal(health.queued, 0);
  } finally {
    http.close();
  }
});

test("http: a graceful stop finishes the call in hand and closes its keep-alive connection right after", async () => {
  const { http, port } = await start({ createServer: slowTools(500) });
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  try {
    const answer = raw(port, { agent });
    await sleep(100);
    const t0 = Date.now();
    const stopped = http.stopGracefully("test");
    const res = await answer;
    assert.equal(res.status, 200);
    assert.equal(res.headers.connection, "close");
    await Promise.race([stopped, sleep(3000).then(() => assert.fail("the stop waited on an idle connection"))]);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    agent.destroy();
    http.close();
  }
});

test("upkeep: waitThen waits out delays longer than setTimeout allows, in steps", async () => {
  let fired = 0;
  const t0 = Date.now();
  await new Promise((resolve) =>
    waitThen(120, () => {
      fired++;
      resolve();
    }, { maxStep: 25 })
  );
  assert.equal(fired, 1);
  assert.ok(Date.now() - t0 >= 115, "it does not fire before the due time");

  // 720 hours: no overflow warning and no early run.
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  let ran = false;
  const cancel = waitThen(720 * 3600_000, () => (ran = true));
  await sleep(50);
  cancel();
  process.off("warning", onWarning);
  assert.equal(ran, false);
  assert.ok(!warnings.includes("TimeoutOverflowWarning"));
});

/** Run call-tool.js; resolves with { code, stdout, stderr }. */
function callTool(args, { input, env = {}, onStderr = () => {} } = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["WELL_DATA_MCP_URL", "WELL_DATA_MCP_TOKEN", "WELL_DATA_MCP_TOKEN_FILE"]) delete base[k];
    const child = spawn(process.execPath, [join(root, "scripts/call-tool.js"), ...args], { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => onStderr((stderr += d)));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

test("call-tool: when a busy server turns calls away, only those move to the local server; the rest finish over HTTP", { timeout: 60_000 }, async () => {
  // The HTTP calls hold until call-tool has switched, so the switch happens with calls in flight.
  let open;
  const gate = new Promise((r) => (open = r));
  const { http, port } = await start({ createServer: slowTools(0, undefined, gate), maxCalls: 1 });
  try {
    const input = Array.from({ length: 12 }, (_, i) => JSON.stringify({ tool: "list_sources", args: { country: "NO" }, id: i + 1 })).join("\n");
    const onStderr = (text) => /carrying on with a local server/.test(text) && setTimeout(open, 300);
    const { code, stdout, stderr } = await callTool(["--url", `http://127.0.0.1:${port}/mcp`, "--batch", "--concurrency", "12"], { input, onStderr });
    const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 12);
    assert.ok(lines.every((l) => l.ok), stdout);
    assert.equal(code, 0);
    const viaHttp = lines.filter((l) => l.result?.from === "http").length;
    assert.ok(viaHttp >= 8, `${viaHttp} answered over HTTP`);
    assert.ok(viaHttp < 12, "some were turned away and ran locally");
    assert.match(stderr, /carrying on with a local server/);
  } finally {
    open();
    http.close();
  }
});

test("call-tool: an unreadable tokenFile in client.json falls back to a local server with a note", { timeout: 60_000 }, async () => {
  const xdg = mkdtempSync(join(tmpdir(), "well-data-fix-http-"));
  mkdirSync(join(xdg, "well-data-mcp"));
  writeFileSync(join(xdg, "well-data-mcp", "client.json"), JSON.stringify({ servers: [{ checkout: root, url: "http://127.0.0.1:1/mcp", tokenFile: join(xdg, "no-such-token") }] }));
  let run;
  try {
    run = await callTool(["list_sources", '{"source":"UT"}'], { env: { XDG_CONFIG_HOME: xdg } });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
  const { code, stdout, stderr } = run;
  assert.equal(code, 0, stderr);
  assert.match(stderr, /cannot read the token file/);
  assert.equal(JSON.parse(stdout).sources[0].key, "UT");
});
