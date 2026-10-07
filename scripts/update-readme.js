// Regenerate the coverage section of README.md between the coverage markers.
// Usage: node scripts/update-readme.js
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const readme = fileURLToPath(new URL("../README.md", import.meta.url));
const table = execFileSync(process.execPath, [fileURLToPath(new URL("./coverage-table.js", import.meta.url))], { encoding: "utf8" });
const text = readFileSync(readme, "utf8");
const start = text.indexOf("<!-- coverage:start");
const end = text.indexOf("<!-- coverage:end -->");
if (start < 0 || end < 0) throw new Error("README.md has no coverage markers");
const head = text.slice(0, text.indexOf("\n", start) + 1);
writeFileSync(readme, `${head}\n## Coverage\n\n${table.trim()}\n\n${text.slice(end)}`);
console.log("README coverage section updated");
