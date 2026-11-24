// Call the server's tools over stdio, the way an MCP client would.
//
// One call:
//   node scripts/call-tool.js <tool> ['<json args>']
//   node scripts/call-tool.js list_sources '{"country":"NO"}'
//   node scripts/call-tool.js wells_near '{"latitude":38.5,"longitude":-112.9,"radius_km":5}'
//
// Many calls through one server (its caches and failovers are kept between calls):
//   node scripts/call-tool.js --batch [--concurrency 4] < calls.jsonl > results.jsonl
// Each input line is {"tool": "...", "args": {...}, "id": <anything, echoed back>}.
// Each output line, in input order, is {"line", "id", "tool", "ok", "result"} or
// {"line", "id", "tool", "ok": false, "error"}; `result` is the tool's parsed JSON.
// Exit status: 0 when every call succeeded, 1 otherwise.
//
// A running HTTP server (node src/index.js --http ...) is used instead of starting one when
// --url <http://host:port/mcp> or WELL_DATA_MCP_URL names it: its caches are already warm.
// A token goes in --token-file <path>, WELL_DATA_MCP_TOKEN_FILE or WELL_DATA_MCP_TOKEN.
// A machine that runs such a server for one checkout can say so once, in
// $XDG_CONFIG_HOME/well-data-mcp/client.json (default ~/.config/...):
//   {"servers": [{"checkout": "/path/to/well-data-mcp", "url": "http://127.0.0.1:8110/mcp", "tokenFile": "..."}]}
// call-tool.js from that checkout then uses the server; copies elsewhere (a development
// clone) keep starting their own. --local always starts its own.
// If the server cannot be reached, or goes away mid-batch (a restart or a busy 503), the calls
// carry on through a local stdio server (with a note on stderr); calls already running on the
// HTTP server finish there.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CALL_TIMEOUT_MS = 180_000; // slow regulators exist; the server has its own per-request timeouts
const CONNECT_TIMEOUT_MS = 5_000; // how long a named HTTP server gets to answer before the local fallback
const RETRY_AFTER_MS = 2_000; // a server mid-restart is back within a second or two

const argv = process.argv.slice(2);
/** Remove `--name value` from argv and return the value. */
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const batch = argv.includes("--batch");
if (batch) argv.splice(argv.indexOf("--batch"), 1);
const local = argv.includes("--local");
if (local) argv.splice(argv.indexOf("--local"), 1);
const concurrency = Math.max(1, Number(flag("--concurrency")) || 4);
const urlFlag = flag("--url");
const tokenFlag = flag("--token-file");
const [tool, rawArgs = "{}"] = batch ? [] : argv;

if (!batch && !tool) {
  console.error(
    "Usage: node scripts/call-tool.js [--url <http://host:port/mcp> | --local] <tool> ['<json args>']\n       node scripts/call-tool.js [--url ... | --local] --batch [--concurrency N] < calls.jsonl"
  );
  process.exit(2);
}

const here = fileURLToPath(new URL("..", import.meta.url));
const expandHome = (p) => String(p).replace(/^~(?=$|\/)/, homedir());
const samePath = (a, b) => {
  try {
    return realpathSync(expandHome(a)) === realpathSync(b);
  } catch {
    return false;
  }
};

/** The server this machine runs for this checkout, from client.json, or null. */
function configured() {
  try {
    const dir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const cfg = JSON.parse(readFileSync(join(dir, "well-data-mcp", "client.json"), "utf8"));
    return (cfg.servers ?? []).find((s) => s?.url && s.checkout && samePath(s.checkout, here)) ?? null;
  } catch {
    return null;
  }
}

const target = local ? null : urlFlag ? { url: urlFlag } : process.env.WELL_DATA_MCP_URL ? { url: process.env.WELL_DATA_MCP_URL } : configured();
const tokenFile = tokenFlag ?? process.env.WELL_DATA_MCP_TOKEN_FILE ?? target?.tokenFile;
const tokenOf = () => (tokenFile ? readFileSync(expandHome(tokenFile), "utf8").trim() : process.env.WELL_DATA_MCP_TOKEN?.trim() || null);

const stdio = () =>
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
    env: process.env, // the SDK passes only a few variables by default: let WELL_DATA_* and UV_THREADPOOL_SIZE through
    stderr: "ignore",
  });

async function localClient() {
  const client = new Client({ name: "call-tool", version: "1.2.0" });
  await client.connect(stdio());
  return client;
}

/** The HTTP server if it answers, else null. */
async function httpClient(url) {
  let token;
  try {
    token = tokenOf();
  } catch (e) {
    console.error(`call-tool: cannot read the token file ${tokenFile} (${e.message}); using a local server instead`);
    return null;
  }
  const client = new Client({ name: "call-tool", version: "1.2.0" });
  const http = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined);
  let timer;
  try {
    await Promise.race([
      client.connect(http),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS))),
    ]);
    return client;
  } catch (e) {
    console.error(`call-tool: ${url} is not reachable (${e.message}); using a local server instead`);
    await client.close().catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let client = target ? await httpClient(target.url) : null;
const httpOne = client; // the HTTP client, if any; calls running on it finish even after a switch
client ??= await localClient();
let switching = null; // one switch to the local server, however many calls notice the loss at once
let onHttp = 0; // calls in progress on httpOne
let retired = false; // httpOne is replaced: close it once its last call settles
const closeHttp = () => httpOne.close().catch(() => {});

/** The HTTP server went away or is restarting (as opposed to a tool answering with an error). */
// The SDK's StreamableHTTPError carries the HTTP status in `code`; its message does not.
const lostServer = (e) =>
  [502, 503, 504].includes(e?.code) || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|terminated|restarting|server busy/i.test(`${e?.message} ${e?.cause?.code ?? ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callOn(c, name, args) {
  if (c !== httpOne) return c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  onHttp++;
  try {
    return await c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  } finally {
    if (--onHttp === 0 && retired) closeHttp();
  }
}

/** Use the local server from now on. Calls still running on the HTTP server carry on there. */
function switchToLocal(why) {
  switching ??= (async () => {
    console.error(`call-tool: lost ${target.url} (${why}); carrying on with a local server`);
    client = await localClient();
    retired = true;
    if (onHttp === 0) closeHttp();
  })();
  return switching;
}

// On the HTTP server: a lost-server error is retried once after a pause, then the call (only
// that one) moves to the local server. Errors from the local server are final.
async function call(name, args) {
  for (let attempt = 0; ; attempt++) {
    const c = client;
    try {
      return await callOn(c, name, args);
    } catch (e) {
      if (c !== httpOne || !lostServer(e)) throw e;
      if (client !== c) continue; // another call already switched: run this one locally
      if (attempt === 0) await sleep(RETRY_AFTER_MS);
      else await switchToLocal(e.message);
    }
  }
}

const textOf = (res) => (res.content ?? []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runBatch() {
  const calls = [];
  let n = 0;
  for await (const raw of createInterface({ input: process.stdin })) {
    n++;
    if (!raw.trim()) continue;
    try {
      const { tool: name, args = {}, id } = JSON.parse(raw);
      if (typeof name !== "string") throw new Error('missing "tool"');
      calls.push({ line: n, id, tool: name, args });
    } catch (e) {
      calls.push({ line: n, bad: `line ${n} is not a call: ${e.message}` });
    }
  }
  const out = new Array(calls.length);
  let next = 0; // first call not yet started
  let printed = 0; // results print in input order as soon as their turn comes
  let failed = 0;
  const flush = () => {
    while (printed < calls.length && out[printed]) console.log(JSON.stringify(out[printed++]));
  };
  const worker = async () => {
    while (next < calls.length) {
      const i = next++;
      const { line, id, tool: name, args, bad } = calls[i];
      const head = { line, ...(id !== undefined ? { id } : {}), ...(name ? { tool: name } : {}) };
      if (bad) out[i] = { ...head, ok: false, error: bad };
      else {
        try {
          const res = await call(name, args);
          const body = parsed(textOf(res));
          out[i] = res.isError ? { ...head, ok: false, error: body?.error ?? body } : { ...head, ok: true, result: body };
        } catch (e) {
          out[i] = { ...head, ok: false, error: e.message };
        }
      }
      if (!out[i].ok) failed++;
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
  return failed;
}

try {
  if (batch) process.exitCode = (await runBatch()) ? 1 : 0;
  else {
    const res = await call(tool, JSON.parse(rawArgs));
    const text = textOf(res);
    const body = parsed(text);
    console.log(typeof body === "string" ? text : JSON.stringify(body, null, 2)); // the server answers compact JSON
    process.exitCode = res.isError ? 1 : 0;
  }
} finally {
  await client.close();
  if (httpOne && client !== httpOne) await closeHttp();
}
