// Package identity, read once from package.json so the version is typed in one place
// (McpServer info + the User-Agent every outbound fetch sends).
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json");

export const NAME = pkg.name;
export const VERSION = pkg.version;
export const USER_AGENT = `${pkg.name}/${pkg.version}`;
