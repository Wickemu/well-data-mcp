// Minimal dBASE III (.dbf) reader: the attribute table of a shapefile. Character,
// numeric, float, logical and date (YYYYMMDD -> 'YYYY-MM-DD') fields; deleted rows skipped.

export function readDbf(buf, encoding = "latin1") {
  const count = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; p < headerLen - 1 && buf[p] !== 0x0d; p += 32) {
    const name = buf.toString("latin1", p, p + 11).replace(/\0.*$/, "").trim();
    fields.push({ name, type: String.fromCharCode(buf[p + 11]), length: buf[p + 16] });
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = headerLen + i * recordLen;
    if (start + recordLen > buf.length) break;
    if (buf[start] === 0x2a) continue; // '*' = deleted
    const row = {};
    let p = start + 1;
    for (const f of fields) {
      const raw = buf.toString(encoding, p, p + f.length).trim();
      p += f.length;
      if (raw === "") row[f.name] = null;
      else if (f.type === "N" || f.type === "F") row[f.name] = Number.isFinite(Number(raw)) ? Number(raw) : null;
      else if (f.type === "L") row[f.name] = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
      else if (f.type === "D") row[f.name] = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
      else row[f.name] = raw;
    }
    rows.push(row);
  }
  return rows;
}
