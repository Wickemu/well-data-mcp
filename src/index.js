#!/usr/bin/env node
// well-data-mcp: MCP server for oil & gas / geothermal well data from public regulator
// and geological-survey services worldwide.
//
//   node src/index.js                       stdio (what MCP clients launch)
//   node src/index.js --http [host:]port    Streamable HTTP at http://host:port/mcp (default host 127.0.0.1)
//
// Register over stdio with:  claude mcp add --scope user well-data -- node <path>/src/index.js
// HTTP settings come from flags or the environment (see --help).

import "./threadpool.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { createServer, serverInfo, COVERAGE_LINE } from "./server.js";
import { serveHttp, parseListen } from "./http-server.js";
import { startUpkeep, sourceHealth, sourceHealthSummary } from "./upkeep.js";
import { skippedHosts } from "./http.js";

const HELP = `well-data-mcp ${serverInfo().version}

Usage:
  well-data-mcp                         serve over stdio (MCP clients launch it this way)
  well-data-mcp --http [host:]port      serve Streamable HTTP at http://host:port/mcp
                                        (host defaults to 127.0.0.1; GET /healthz answers without auth)

HTTP options (flag or environment variable):
  --http [host:]port        WELL_DATA_HTTP            where to listen
  --token-file <path>       WELL_DATA_HTTP_TOKEN_FILE file holding a bearer token clients must send
                            WELL_DATA_HTTP_TOKEN      the token itself (prefer the file)
  --max-calls <n>           WELL_DATA_HTTP_MAX_CALLS  requests handled at once; more wait (default 8)
  --check-hours <n>         WELL_DATA_CHECK_HOURS     ask every source its probe query this often and show
                                                      the result in /healthz and /sources (default 24; 0 = off)
The HTTP server also refreshes expired lookup tables and snapshot layers in the background.

Other environment: WELL_DATA_BUDGET_MS, WELL_DATA_CACHE_DIR, UV_THREADPOOL_SIZE (default 32; see README).`;

function option(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value == null || value.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

function readToken(file) {
  try {
    const token = readFileSync(file, "utf8").trim();
    if (!token) throw new Error("the file is empty");
    return token;
  } catch (e) {
    console.error(`Cannot read the token file ${file}: ${e.message}`);
    process.exit(2);
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const listen = option(argv, "--http") ?? process.env.WELL_DATA_HTTP;
if (listen) {
  let host, port;
  try {
    ({ host, port } = parseListen(listen));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const tokenFile = option(argv, "--token-file") ?? process.env.WELL_DATA_HTTP_TOKEN_FILE;
  const token = tokenFile ? readToken(tokenFile) : process.env.WELL_DATA_HTTP_TOKEN?.trim() || null;
  const maxCalls = Number(option(argv, "--max-calls") ?? process.env.WELL_DATA_HTTP_MAX_CALLS) || 8;
  const checkHours = Number(option(argv, "--check-hours") ?? process.env.WELL_DATA_CHECK_HOURS ?? 24);
  await serveHttp({
    host,
    port,
    token,
    maxCalls,
    createServer,
    info: () => ({ ...serverInfo(), sourceCheck: sourceHealthSummary(), skippedHosts: skippedHosts() }),
    pages: { "/sources": sourceHealth },
  });
  console.error(`well-data-mcp ${serverInfo().version} listening on http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp${token ? " (bearer token required)" : ""}: ${COVERAGE_LINE}`);
  await startUpkeep({ checkEveryHours: Number.isFinite(checkHours) ? checkHours : 24 });
} else {
  await createServer().connect(new StdioServerTransport());
  console.error(`well-data-mcp ready: ${COVERAGE_LINE}`);
}
