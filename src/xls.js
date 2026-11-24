// Minimal reader for old binary Excel files (.xls): the cells of the first worksheet, as
// rows of strings and numbers. Enough for the flat permit lists some agencies still
// publish this way, without adding a dependency. Handles the OLE2 container (regular and
// mini streams), BIFF5 and BIFF8 cell records LABEL, NUMBER, RK, MULRK and LABELSST with
// a shared-string table that fits its records. Formulas, styles and later sheets are
// ignored; anything else fails loudly rather than returning half a table.

const MAGIC = "d0cf11e0a1b11ae1";
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

/** Follow a sector chain through an allocation table and return the sectors' bytes joined. */
function chain(start, table, sector, limit) {
  const parts = [];
  const seen = new Set();
  for (let s = start; s !== END_OF_CHAIN && s !== FREE; s = table[s]) {
    if (s >= table.length || seen.has(s)) throw new Error("corrupt .xls (broken sector chain)");
    seen.add(s);
    parts.push(sector(s));
  }
  const all = Buffer.concat(parts);
  return limit == null ? all : all.subarray(0, limit);
}

/** The named stream of an OLE2 compound file (first name that exists), or null. */
export function readOleStream(buf, names) {
  if (buf.length < 512 || buf.toString("hex", 0, 8) !== MAGIC) throw new Error("not an .xls file (no OLE2 header)");
  const size = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const miniCutoff = buf.readUInt32LE(56);
  const sector = (n) => buf.subarray((n + 1) * size, (n + 2) * size);

  // DIFAT: where the FAT's own sectors are. 109 entries in the header, the rest chained.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) fatSectors.push(buf.readUInt32LE(76 + i * 4));
  for (let s = buf.readUInt32LE(68), n = buf.readUInt32LE(72); n > 0 && s !== END_OF_CHAIN && s !== FREE; n--) {
    const d = sector(s);
    for (let i = 0; i < size / 4 - 1; i++) fatSectors.push(d.readUInt32LE(i * 4));
    s = d.readUInt32LE(size - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    if (s === FREE || s === END_OF_CHAIN) continue;
    const d = sector(s);
    for (let i = 0; i < size / 4; i++) fat.push(d.readUInt32LE(i * 4));
  }

  const dir = chain(buf.readUInt32LE(48), fat, sector);
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dir.readUInt16LE(p + 64);
    if (!nameLen) continue;
    entries.push({
      name: dir.toString("utf16le", p, p + nameLen - 2),
      type: dir[p + 66],
      start: dir.readUInt32LE(p + 116),
      size: dir.readUInt32LE(p + 120),
    });
  }
  const entry = names.map((n) => entries.find((e) => e.type === 2 && e.name === n)).find(Boolean);
  if (!entry) return null;
  if (entry.size >= miniCutoff) return chain(entry.start, fat, sector, entry.size);
  // Small streams live in the mini stream (the root entry's data), in 64-byte sectors.
  const root = entries.find((e) => e.type === 5);
  const mini = chain(root.start, fat, sector, root.size);
  const miniFatBytes = chain(buf.readUInt32LE(60), fat, sector);
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => miniFatBytes.readUInt32LE(i * 4));
  return chain(entry.start, miniFat, (n) => mini.subarray(n * miniSize, (n + 1) * miniSize), entry.size);
}

/** An RK value: a 30-bit integer or the top 30 bits of a double, optionally divided by 100. */
function rk(v) {
  let n;
  if (v & 2) n = v >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(v & 0xfffffffc, 4);
    n = b.readDoubleLE(0);
  }
  return v & 1 ? n / 100 : n;
}

/** The BIFF8 shared-string table (plain and UTF-16 strings; rich-text and phonetic runs skipped). */
function sharedStrings(d) {
  const out = [];
  const total = d.readUInt32LE(4);
  let p = 8;
  while (out.length < total && p + 3 <= d.length) {
    const chars = d.readUInt16LE(p);
    const flags = d[p + 2];
    p += 3;
    const runs = flags & 8 ? d.readUInt16LE(p) : 0;
    if (flags & 8) p += 2;
    const ext = flags & 4 ? d.readUInt32LE(p) : 0;
    if (flags & 4) p += 4;
    const bytes = flags & 1 ? chars * 2 : chars;
    if (p + bytes > d.length) throw new Error("unsupported .xls (shared strings span several records)");
    out.push(d.toString(flags & 1 ? "utf16le" : "latin1", p, p + bytes));
    p += bytes + runs * 4 + ext;
  }
  return out;
}

/**
 * Rows of the first worksheet: an array of arrays holding strings, numbers or null.
 * Dates come back as Excel serial numbers; see excelDate.
 */
export function readXlsSheet(buf) {
  const book = readOleStream(buf, ["Workbook", "Book"]);
  if (!book) throw new Error("not an Excel workbook (no Workbook stream)");
  const rows = [];
  const set = (r, c, v) => ((rows[r] ??= [])[c] = v);
  let strings = [];
  let sheet = 0; // 0 before the first worksheet, 1 inside it, 2 after
  for (let p = 0; p + 4 <= book.length; ) {
    const id = book.readUInt16LE(p);
    const len = book.readUInt16LE(p + 2);
    const d = book.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    if (id === 0x0809 && d.readUInt16LE(2) === 0x0010 && sheet === 0) sheet = 1; // BOF, worksheet
    else if (id === 0x000a && sheet === 1) break; // EOF of the first worksheet
    else if (id === 0x00fc) strings = sharedStrings(d);
    else if (sheet !== 1) continue;
    else if (id === 0x0204) {
      // LABEL: BIFF5 holds bytes; BIFF8 puts a flags byte first (bit 0 = UTF-16)
      const n = d.readUInt16LE(6);
      if (d.length === 8 + n) set(d.readUInt16LE(0), d.readUInt16LE(2), d.toString("latin1", 8, 8 + n));
      else set(d.readUInt16LE(0), d.readUInt16LE(2), d.toString(d[8] & 1 ? "utf16le" : "latin1", 9, 9 + (d[8] & 1 ? n * 2 : n)));
    } else if (id === 0x0203) set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    else if (id === 0x027e) set(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readUInt32LE(6)));
    else if (id === 0x00bd) {
      for (let c = d.readUInt16LE(2), q = 4; q + 6 <= d.length - 2; c++, q += 6) set(d.readUInt16LE(0), c, rk(d.readUInt32LE(q + 2)));
    } else if (id === 0x00fd) set(d.readUInt16LE(0), d.readUInt16LE(2), strings[d.readUInt32LE(6)] ?? null);
  }
  if (sheet === 0) throw new Error("no worksheet found in the .xls file");
  const width = Math.max(0, ...Array.from(rows, (r) => r?.length ?? 0)); // Array.from: empty rows are holes
  return Array.from(rows, (r) => Array.from({ length: width }, (_, c) => r?.[c] ?? null));
}

/** Rows as objects keyed by the first row's headings; fully empty rows dropped. */
export function xlsObjects(rows) {
  const [head = [], ...body] = rows;
  const keys = head.map((h) => (h == null ? "" : String(h).trim()));
  return body
    .filter((r) => r.some((v) => v != null && v !== ""))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, typeof r[i] === "string" ? r[i].trim() : r[i]]).filter(([k]) => k)));
}

/** An Excel serial date (1900 system) -> 'YYYY-MM-DD'; null for anything that is not a plausible date. */
export function excelDate(serial) {
  if (typeof serial !== "number" || !Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}
