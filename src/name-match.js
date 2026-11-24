// Well-name matching. The same well is written differently by the regulator, the operator
// and the service companies on site: 'K & L 2-9' / 'K&L #2-9', '7K 0815TX' / '07K_0815TX',
// 'Juniper 1' / 'Juniper 1 ST1', and a registry that keeps lease and well number apart
// ('Maya' + '6-KH') is usually asked for the number alone or for both run together.
// Two halves: words for a deliberately loose server-side filter, and a 0-1 similarity
// score that ranks what comes back.

const fold = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

// A trailing sidetrack / redrill / workover / deepening designator: 'ST1', 'RD 2', 'Redrill',
// 'Sidetrack #1', '(ST2)', '/ST2', 'WO', 'Deepened'.
const BORE_SPACED = /^(.*\d.*?)[\s,_(/-]+(ST|S\/T|SDTK|SIDE ?TRACK|RD|R\/D|RE-?DRILL|RE-?ENTRY|WO|W\/O|WORK ?OVER|DEEPEN(?:ING|ED)?)[\s.#-]*(\d{0,2})\)?\s*$/;
// A directional plan or lateral leg after the bore: 'Tamarind 44X-9 ST1 Leg 2', '7-3H1 ST2 Plan 2'.
const PLAN_LEG = /\s+(?:PLAN|LEG)\s*#?\d{1,2}\s*$/;
// The same glued to the well number: '120ST2', '5RD2', '120ST'.
const BORE_GLUED = /^(.*\d)(ST|RD)(\d?)$/;
// A trailing bypass, alone or after a sidetrack: 'A-11 ST1 BP1', BOEM's 'A011 ST01BP01'.
const BYPASS = /^(.*\d.*?)[\s,_(/-]*(?:BP|BYPASS)[\s.#-]*(\d{1,2})\)?\s*$/;

/**
 * Split a trailing sidetrack / redrill / workover / bypass designator off a well name
 * (a plan or leg number after it is dropped):
 * 'Juniper 1 ST1' -> { base: 'Juniper 1', bore: 'ST1' }; 'A011 ST01BP01' -> bore 'ST1BP1'
 * (numbers without their zero padding). BOEM's 'ST00BP00' is the original hole: no bore.
 * Names without one come back whole with bore null. Only stripped when a digit remains,
 * so 'County Rd' stays intact.
 */
export function splitBore(name) {
  let s = fold(name).trim().replace(PLAN_LEG, "");
  let bypass = null;
  const b = BYPASS.exec(s);
  if (b) {
    s = b[1].trim();
    bypass = String(Number(b[2]));
  }
  const m = BORE_SPACED.exec(s) ?? BORE_GLUED.exec(s);
  if (!m && bypass == null) return { base: s, bore: null };
  const kind = m ? (/^S/.test(m[2]) ? "ST" : /^W/.test(m[2]) ? "WO" : /^D/.test(m[2]) ? "DP" : "RD") : null;
  const n = m?.[3] ? String(Number(m[3])) : "";
  const base = m ? m[1].trim() : s;
  if (kind === "ST" && n === "0" && (bypass == null || bypass === "0")) return { base, bore: null };
  const bore = `${kind ? `${kind}${n}` : ""}${bypass != null && bypass !== "0" ? `BP${bypass}` : ""}`;
  return { base, bore: bore || null };
}

/** 'No. 15', 'NO 1', 'Num 3', '#4' -> the bare number. */
const dropNumberSign = (s) => s.replace(/\bN(?:O|UM(?:BER)?)\.?\s*(?=\d)/g, " ").replace(/#/g, " ");

// Compass words are abbreviated as often as not: 'West Harbor 2' is filed as 'W HARBOR 2'.
const COMPASS = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW" };

// Placeholder lease names registries use when a well has none, and 'and', which one side
// writes as '&' ('Sullivan and Lodge' = 'Sullivan & Lodge').
const NOISE = new Set(["UNSPECIFIED", "UNNAMED", "WELL", "AND"]);
// What kind of well it is, written into the name by geothermal registries ('Industrial Production
// Well 12-34', 'Thermal Gradient Well TG 5(b)', 'Observation Well 77-9'): says nothing about which well.
const DESCRIPTOR = new Set(["INDUSTRIAL", "COMMERCIAL", "PRODUCTION", "INJECTION", "OBSERVATION", "THERMAL", "TEMPERATURE", "GRADIENT", "GEOTHERMAL", "MONITORING", "MONITOR"]);
// Abbreviations written either way: 'Ironbark IW-4' is 'Ironbark Inj 4'.
const ALIAS = { INJ: "IW" };
// A placeholder lease 'Lease by <operator>': the operator's name is not part of the well's.
const ORG_END = new Set(["CO", "CORP", "CORPORATION", "INC", "LLC", "LP", "LTD", "COMPANY"]);

/**
 * Comparable tokens of a well name: upper case, accents and punctuation dropped, letters
 * and digits split apart, leading zeros removed ('07K_0815TX' -> 7 K 815 TX).
 */
export function nameTokens(name) {
  // Dotted initials are one word: 'R.T. Ashby' is 'RT Ashby', 'J.V.' is 'JV', 'U.S.A.' is 'USA'.
  const dotted = fold(name).replace(/\b(?:[A-Z]\.\s*){2,}/g, (m) => `${m.replace(/[.\s]/g, "")} `);
  // Apostrophes join rather than split: "Gov't" is GOVT, "O'Brien" is OBRIEN.
  const runs = dropNumberSign(dotted.replace(/['\u2019`]/g, "")).match(/[A-Z]+|\d+/g) ?? [];
  let tokens = runs.map((t) => (/^\d/.test(t) ? t.replace(/^0+(?=\d)/, "") : COMPASS[t] ?? ALIAS[t] ?? t));
  if (tokens[0] === "LEASE" && tokens[1] === "BY") {
    const end = tokens.findLastIndex((t) => ORG_END.has(t));
    if (end > 1 && end < tokens.length - 1) tokens = tokens.slice(end + 1);
  }
  const kept = tokens.filter((t) => !NOISE.has(t) && !DESCRIPTOR.has(t));
  return kept.length ? kept : tokens;
}

/**
 * Words for a contains-filter where every gap is a wildcard: punctuation becomes a gap and
 * a zero-led number loses its zeros (cutting the word there), so the filter for
 * 'K&L 02-9' also finds 'K & L 2-9'. Always a superset of the plain text match.
 */
export function nameWords(text) {
  const runs = (dropNumberSign(fold(text)).match(/[A-Z0-9]+/g) ?? []).filter((r) => r !== "AND");
  // A lease glued to its number ('Sinclair15', the 8.3 file-name habit) is two words.
  return runs.flatMap((run) => run.split(/(?<=[A-Z])(?=\d)/)).flatMap((run) => run.split(/(?<![1-9]\d*)0+(?=\d)/).filter(Boolean));
}

/**
 * The text a provider's contains-filter should look for when asked for a well name:
 * sidetrack suffix dropped, then nameWords. Falls back to the text itself when nothing
 * searchable is left.
 */
export function looseNameText(text) {
  return nameWords(splitBore(text).base).join(" ") || String(text);
}

const isNum = (t) => /^\d/.test(t);
const sameSeq = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
const endsWith = (a, b) => b.length <= a.length && sameSeq(a.slice(a.length - b.length), b);
const startsWith = (a, b) => b.length <= a.length && sameSeq(a.slice(0, b.length), b);
const contains = (a, b) => a.some((_, i) => i + b.length <= a.length && sameSeq(a.slice(i, i + b.length), b));
/** A well number worth matching on its own: three characters or more with a digit ('204', '62-30', '6-KH'), not '15' or 'K-1'. */
const specific = (t) => t.join("").length >= 3 && t.some(isNum);

function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [ra, rb] = a.length === b.length ? [a.slice(i + 1), b.slice(i + 1)] : a.length > b.length ? [a.slice(i + 1), b.slice(i)] : [a.slice(i), b.slice(i + 1)];
  return ra === rb;
}

const sameWord = (a, b) =>
  a === b ||
  (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) || // TRUST / TRUSTS
  (Math.min(a.length, b.length) >= 5 && editDistanceAtMost1(a, b));

/** Does some run of consecutive words, written together, spell exactly `joined`? ('JV' in CANYON JV; not 'RK' in PARKFIELD) */
function hasJoinedRun(words, joined) {
  for (let i = 0; i < words.length; i++) {
    let run = "";
    for (let j = i; j < words.length && run.length < joined.length; j++) run += words[j];
    if (run === joined) return true;
  }
  return false;
}

/** How much of the shorter word list is found in the longer one, 0-1 ('J.V.' ~ 'Canyon JV'). */
export function wordOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const hit = short.filter((w) => long.some((x) => sameWord(w, x))).length / short.length;
  // One side written together is a whole word, or run of words, of the other: 'J V' is the JV of 'CANYON JV'.
  const [x, y] = [a.join(""), b.join("")];
  const inside = (x.length >= 2 && hasJoinedRun(b, x)) || (y.length >= 2 && hasJoinedRun(a, y));
  return inside ? Math.max(hit, 0.8) : hit;
}

/**
 * Spell out initials: an all-letter token of `a` that is the initials of two or more
 * consecutive words of `b` is replaced by those words ('PCU D1' against 'Pine Creek
 * Unit D1'). Returns the expanded list, or null when nothing was expanded.
 */
function expandInitials(a, b) {
  let changed = false;
  const out = a.flatMap((t) => {
    if (isNum(t) || t.length < 2 || t.length > 5) return [t];
    for (let i = 0; i + t.length <= b.length; i++) {
      const words = b.slice(i, i + t.length);
      if (words.every((w, k) => !isNum(w) && w.length > 1 && w[0] === t[k])) {
        changed = true;
        return words;
      }
    }
    return [t];
  });
  return changed ? out : null;
}

function sequenceScore(q, c) {
  if (sameSeq(q, c)) return 1;
  if (endsWith(c, q)) return 0.9; // asked without the lease
  if (endsWith(q, c)) return specific(c) ? 0.85 : 0.5; // registry holds the number only
  if (startsWith(c, q)) return 0.6; // asked for the lease only
  if (contains(c, q)) return 0.55;
  const [qn, cn] = [q.filter(isNum), c.filter(isNum)];
  const words = wordOverlap(q.filter((t) => !isNum(t)), c.filter((t) => !isNum(t)));
  if (!qn.length && !cn.length) return 0.7 * words;
  // Same numbers, lease worded differently. A bare '4' proves little without the lease.
  if (qn.length && sameSeq(qn, cn)) return specific(qn) ? 0.6 + 0.25 * words : 0.3 + 0.55 * words;
  return 0.2 * words; // the numbers disagree
}

/**
 * Similarity of a well name as asked to a registry record, 0-1:
 *   1      the same name after folding          0.9   the record's name ends with it (lease left off)
 *   0.85   same numbers, lease worded differently 0.7   well number matches, lease does not
 *   0.5-0.6 a plain contains-match              < 0.3  different numbers
 * `candidate` is { name } or, for a registry that stores them apart, { lease, number }.
 * A sidetrack / redrill suffix on either side is set aside first; when both carry one,
 * agreement nudges the score up and disagreement down. A name with a bracketed part is also
 * read without it and as the bracketed part alone (see nameReadings).
 */
export function nameScore(query, candidate) {
  const qs = nameReadings(query);
  const cs = candidate.name != null ? nameReadings(candidate.name).map(({ text, weight }) => ({ c: { name: text }, weight })) : [{ c: candidate, weight: 1 }];
  if (qs.length === 1 && cs.length === 1) return nameScoreOne(query, candidate);
  const best = Math.max(...qs.flatMap((q) => cs.map(({ c, weight }) => q.weight * weight * nameScoreOne(q.text, c))));
  return Math.round(best * 100) / 100;
}

// The name in brackets is the well's other name (an old number, a permit designation): it
// counts a shade less, so that '33(34)-9' does not tie with the well filed as '34-9'.
const ALT_WEIGHT = 0.95;

/**
 * The ways a name with a parenthetical can be read: as written, without it, the part in
 * brackets alone ('18-30 (Industrial Production Well PW-4)' -> '18-30', 'Industrial Production
 * Well PW-4'), and a number with an alternative in brackets either way ('62(41)-17' -> '62-17',
 * '41-17'). A short part in brackets is the well's own ('TG 5(b)' stays as 'TG 5 B').
 */
export function nameReadings(name) {
  const s = String(name ?? "");
  if (!/\([^)]*\)/.test(s)) return [{ text: s, weight: 1 }];
  const out = [{ text: s, weight: 1 }];
  const inner = /(\d+[A-Z]?)\((\d+[A-Z]?)\)(-\d+[A-Z]?)/i.exec(s);
  if (inner) {
    out.push({ text: s.replace(inner[0], inner[1] + inner[3]), weight: 1 }, { text: s.replace(inner[0], inner[2] + inner[3]), weight: ALT_WEIGHT });
  }
  const m = /^(.*?)\s*\(([^)]{2,})\)\s*(.*)$/.exec(s);
  if (m && !inner) {
    const outside = `${m[1]} ${m[3]}`.trim();
    if (/\d/.test(outside)) out.push({ text: outside, weight: 1 });
    if (/\d/.test(m[2])) out.push({ text: m[2], weight: ALT_WEIGHT });
  }
  return out;
}

function nameScoreOne(query, candidate) {
  const q = splitBore(query);
  const full = candidate.name ?? [candidate.lease, candidate.number].filter((p) => p != null && String(p).trim() !== "").join(" ");
  const c = splitBore(full);
  const qt = nameTokens(q.base);
  const ct = nameTokens(c.base);
  if (!qt.length || !ct.length) return 0;
  let score = sequenceScore(qt, ct);
  // Initials on either side, a shade below the spelled-out match.
  const [qx, cx] = [expandInitials(qt, ct), expandInitials(ct, qt)];
  if (qx) score = Math.max(score, 0.95 * sequenceScore(qx, ct));
  if (cx) score = Math.max(score, 0.95 * sequenceScore(qt, cx));
  if (candidate.number != null && String(candidate.number).trim() !== "") {
    // Lease and number stored apart: the number is the dependable half.
    const nt = nameTokens(splitBore(candidate.number).base);
    if (nt.length && endsWith(qt, nt)) {
      const rest = qt.slice(0, qt.length - nt.length);
      const lease = rest.length ? wordOverlap(rest, nameTokens(candidate.lease ?? "")) : 0;
      score = Math.max(score, !rest.length ? 0.9 : specific(nt) ? 0.7 + 0.25 * lease : 0.3 + 0.6 * lease);
    }
  }
  // A letter the registry runs into the well number that the name asked for lacks makes it
  // another well: '62A-17' is the twin of '62-17', 'B-04XX' a sidetrack of 'B-04'. (The other
  // way round is common shorthand: 'Garnet 4B' for a registry's 'Garnet 4'.)
  if (score > 0.6 && suffixLetters(c.base).some((l) => !suffixLetters(q.base).includes(l))) score -= 0.15;
  // The classic contains-match never scores as a miss ('Port' finds 'Sam Porter 15').
  if (score < 0.5 && fold(full).replace(/\s+/g, " ").includes(fold(query).trim().replace(/\s+/g, " "))) score = 0.5;
  if (score > 0 && q.bore && c.bore) score += q.bore === c.bore ? 0.02 : -0.05;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

/** Letters run onto the end of a number: '62A-17' -> ['A'], 'B-04XX' -> ['XX'], 'Sandcrest S12' -> []. */
function suffixLetters(base) {
  return [...fold(base).matchAll(/\d([A-Z]{1,2})(?![A-Z])/g)].map((m) => m[1]);
}

/** Rows scoring below this against a loosened filter are noise, not partial matches. */
export const NAME_SCORE_FLOOR = 0.3;
