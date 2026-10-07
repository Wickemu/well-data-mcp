// Call one tool on the server over stdio, the way an MCP client would.
// Usage: node scripts/call-tool.js <tool> ['<json args>']
//   node scripts/call-tool.js list_sources '{"country":"NO"}'
//   node scripts/call-tool.js wells_near '{"latitude":38.5,"longitude":-112.9,"radius_km":5}'

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("Usage: node scripts/call-tool.js <tool> ['<json args>']");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  stderr: "ignore",
});
const client = new Client({ name: "call-tool", version: "1.0.0" });
await client.connect(transport);
try {
  const res = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
  for (const c of res.content ?? []) console.log(c.type === "text" ? c.text : JSON.stringify(c));
  process.exitCode = res.isError ? 1 : 0;
} finally {
  await client.close();
}
