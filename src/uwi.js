// Canadian Unique Well Identifiers written any common way, and the forms each provincial
// layer stores them in.
//   DLS (Dominion Land Survey: AB, SK, MB, north-east BC): '1' + location exception (2) +
//     LSD-SEC-TWP-RGE W meridian + event sequence:
//     '100/06-12-034-05W5/00', '100061203405W500', 'SK-WI-100061203405W500',
//     '1AA/06-12-034-05W5/0', or the location alone: '06-12-034-05W5', '06-12-34-5 W5M', '6-12-34-5-W5'
//   NTS (National Topographic System: BC): '2' + exception (2) + quarter-unit-block /
//     map-letter-sheet + event sequence: '200/A-079-B/094-H-04/00', '200A079B094H0400', 'A-79-B/94-H-4'
// Sources opt in with `uwi: { style, field? }` (style: how the layer stores it; field: the
// layer's UWI field when it is not searchFields.api).

const pad = (v, n) => String(Number(v)).padStart(n, "0");

const inRange = (u) =>
  u.system === "DLS"
    ? +u.lsd >= 1 && +u.lsd <= 16 && +u.sec >= 1 && +u.sec <= 36 && +u.twp >= 1 && +u.twp <= 126 && +u.rge >= 1 && +u.rge <= 34
    : +u.unit >= 1 && +u.unit <= 100 && +u.map >= 82 && +u.map <= 114 && +u.sheet >= 1 && +u.sheet <= 16;

function parseForm(text) {
  const s = String(text ?? "").trim().toUpperCase().replace(/^SK-WI-/, "");
  let m = /^(1)([0-9A-Z]{2})(\d{2})(\d{2})(\d{3})(\d{2})W(\d)([0-9A-Z]{1,2})$/.exec(s);
  if (m) return { system: "DLS", le: m[2], lsd: m[3], sec: m[4], twp: m[5], rge: m[6], mer: m[7], es: m[8].padStart(2, "0") };
  m = /^(?:(1)\s*([0-9A-Z]{2})\s*[/.\s-]\s*)?(\d{1,2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,3})\s*-\s*(\d{1,2})\s*-?\s*W\s*([1-6])\s*M?\s*(?:[/.\s-]\s*([0-9A-Z]{1,2}))?$/.exec(s);
  if (m) return { system: "DLS", le: m[2] ?? null, lsd: pad(m[3], 2), sec: pad(m[4], 2), twp: pad(m[5], 3), rge: pad(m[6], 2), mer: m[7], es: m[8] ? m[8].padStart(2, "0") : null };
  m = /^(2)([0-9A-Z]{2})([A-D])(\d{3})([A-L])(\d{3})([A-P])(\d{2})([0-9A-Z]{1,2})$/.exec(s);
  if (m) return { system: "NTS", le: m[2], q: m[3], unit: m[4], block: m[5], map: m[6], letter: m[7], sheet: m[8], es: m[9].padStart(2, "0") };
  m = /^(?:(2)\s*([0-9A-Z]{2})\s*[/.\s-]\s*)?([A-D])\s*-\s*(\d{1,3})\s*-\s*([A-L])\s*\/\s*(\d{1,3})\s*-\s*([A-P])\s*-\s*(\d{1,2})\s*(?:[/.\s-]\s*([0-9A-Z]{1,2}))?$/.exec(s);
  if (m) return { system: "NTS", le: m[2] ?? null, q: m[3], unit: pad(m[4], 3), block: m[5], map: pad(m[6], 3), letter: m[7], sheet: pad(m[8], 2), es: m[9] ? m[9].padStart(2, "0") : null };
  return null;
}

/** The parts of a Canadian UWI, or null when the text is not one (or a part is out of range). */
export function parseUwi(text) {
  const u = parseForm(text);
  return u && inRange(u) ? u : null;
}

/** The location part alone ('061203405W5', 'A079B094H04'): what every stored form contains. */
export function uwiCore(u) {
  return u.system === "DLS" ? `${u.lsd}${u.sec}${u.twp}${u.rge}W${u.mer}` : `${u.q}${u.unit}${u.block}${u.map}${u.letter}${u.sheet}`;
}

/** The full 16-character UWI, when the text gave the exception code and event sequence. */
export function uwiCompact(u) {
  if (u.le == null || u.es == null) return null;
  return `${u.system === "DLS" ? 1 : 2}${u.le}${uwiCore(u)}${u.es}`;
}

/**
 * The exact forms to look for in a layer storing UWIs in `style`:
 *   compact '100061203405W500' · sk 'SK-WI-100061203405W500' · dls '06-12-034-05W5' · mb '06-12-34-05 W1'
 */
export function uwiForms(u, style) {
  const c = uwiCompact(u);
  if (style === "compact") return c ? [c] : [];
  if (style === "sk") return c ? [`SK-WI-${c}`] : [];
  if (u.system !== "DLS") return [];
  if (style === "dls") return [`${u.lsd}-${u.sec}-${u.twp}-${u.rge}W${u.mer}`];
  if (style === "mb") return [`${u.lsd}-${u.sec}-${pad(u.twp, 2)}-${u.rge} W${u.mer}`];
  return [];
}

/** Manitoba's LOCATION ('08-31-05-29 W1', 'A05A-04-10-28 W1'): the same LSD-SEC-TWP-RGE W#, letters ignored. */
const MB_LOCATION = /^[A-Z]*-?(\d{2})[A-Z]?-(\d{2})-(\d{2})-(\d{2})\s*W(\d)$/;
export function sameDlsLocation(stored, u) {
  const m = MB_LOCATION.exec(String(stored ?? "").trim().toUpperCase());
  return Boolean(m && u.system === "DLS" && +m[1] === +u.lsd && +m[2] === +u.sec && +m[3] === +u.twp && +m[4] === +u.rge && m[5] === u.mer);
}
