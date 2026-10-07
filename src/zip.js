// Read one entry out of a .zip held in memory (stored or deflated entries only),
// so small agency bulk files can be used without adding a dependency.

import { inflateRawSync } from "node:zlib";

/** Map of entry name -> { method, compressedSize, offset } from the central directory. */
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    out.set(buf.toString("utf8", p + 46, p + 46 + nameLen), { method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Return the bytes of the entry whose name ends with `suffix` (e.g. 'mv_companies_all.txt'). */
export function unzipEntry(buf, suffix) {
  const all = entries(buf);
  const name = [...all.keys()].find((k) => k.endsWith(suffix));
  if (!name) throw new Error(`zip has no entry ending in '${suffix}' (has: ${[...all.keys()].join(", ")})`);
  const { method, compressedSize, offset } = all.get(name);
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  const data = buf.subarray(start, start + compressedSize);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip entry '${name}' uses unsupported compression method ${method}`);
}
