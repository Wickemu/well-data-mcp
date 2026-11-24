// Offline tests of the Streamable HTTP mode: auth, methods, health, the busy limit, and a
// real MCP client talking to the real tool set (list_sources needs no network).
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serveHttp, parseListen } from "../src/http-server.js";
import { createServer, serverInfo } from "../src/server.js";

const quiet = () => {};

async function start(opts) {
  const http = await serveHttp({ host: "127.0.0.1", port: 0, createServer, info: serverInfo, log: quiet, signals: false, ...opts });
  const { port } = http.address();
  return { http, base: `http://127.0.0.1:${port}` };
}

const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } });

test("parseListen: a port alone listens on loopback; host:port and [v6]:port are read as given", () => {
  assert.deepEqual(parseListen("8110"), { host: "127.0.0.1", port: 8110 });
  assert.deepEqual(parseListen("0.0.0.0:8110"), { host: "0.0.0.0", port: 8110 });
  assert.deepEqual(parseListen("[::1]:8110"), { host: "::1", port: 8110 });
  assert.throws(() => parseListen("localhost"), /\[host:\]port/);
  assert.throws(() => parseListen("99999"), /\[host:\]port/);
});

test("http: /healthz answers without a token; /mcp needs it; only POST is served", async () => {
  const { http, base } = await start({ token: "s3cret" });
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const h = await health.json();
    assert.equal(h.ok, true);
    assert.ok(h.sources > 100 && h.tools.includes("match_well"));

    assert.equal((await post(`${base}/mcp`, rpc("tools/list"))).status, 401);
    assert.equal((await post(`${base}/mcp`, rpc("tools/list"), { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer s3cret" } })).status, 405);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
    const bad = await post(`${base}/mcp`, "{not json", { Authorization: "Bearer s3cret" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
  } finally {
    http.close();
  }
});

test("http: an MCP client lists the tools, read-only annotations included, and calls one", async () => {
  const { http, base } = await start({ token: "s3cret" });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer s3cret" } } }));
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 10);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(tools.find((t) => t.name === "search_heat_flow").annotations.openWorldHint, false);
    const res = await client.callTool({ name: "list_sources", arguments: { source: "UT" } });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.sources[0].key, "UT");
  } finally {
    await client.close();
    http.close();
  }
});

test("http: past the concurrency cap requests wait; past the queue they get 503 with Retry-After", async () => {
  let releaseAll;
  const gate = new Promise((r) => (releaseAll = r));
  const slowServer = () => {
    const s = new McpServer({ name: "slow", version: "1" });
    s.registerTool("wait", { inputSchema: { n: z.number() } }, async () => {
      await gate;
      return { content: [{ type: "text", text: "done" }] };
    });
    return s;
  };
  const { http, base } = await start({ createServer: slowServer, maxCalls: 1 });
  try {
    const call = (n) => post(`${base}/mcp`, JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: "wait", arguments: { n } } }));
    // 1 running + 8 queued (QUEUE_PER_SLOT) fill it; the tenth is turned away.
    const held = Array.from({ length: 9 }, (_, i) => call(i));
    await new Promise((r) => setTimeout(r, 200));
    const turnedAway = await call(99);
    assert.equal(turnedAway.status, 503);
    assert.ok(turnedAway.headers.get("retry-after"));
    releaseAll();
    const answers = await Promise.all(held);
    assert.ok(answers.every((a) => a.status === 200));
  } finally {
    releaseAll();
    http.close();
  }
});
