// match_well scoring: which registry record is this well? The caller knows a well by a
// working name and a few facts (operator, field, a GPS fix, a spud date); candidates come
// from name searches and a radius search, and each is scored on the evidence both sides
// have. Name and location decide; the spud date sharpens. County and field count for a US
// record that agrees and against one that differs; the operator only ever adds, because
// operators change hands.

import { nameScore, nameTokens, wordOverlap, splitBore } from "./name-match.js";
import { haversineKm } from "./geo.js";
import { isoDate, usDateToIso, namedDateToIso } from "./sources/normalize.js";
import { API_STATE_CODES } from "./api-number.js";

const STATE_API_CODE = Object.fromEntries(Object.entries(API_STATE_CODES).map(([code, state]) => [state, code]));

const WEIGHTS = { name: 0.5, distance: 0.3, spud: 0.2 };
// What a hint is worth when both sides have it. Measured on a few hundred US wells with known API
// numbers: the right well's county disagreed with the one given 1 time in 334, its field 5 in
// 253 (all placeholders or codes), its operator 168 in 363 (operators change hands). So county
// and field count for and against; the operator only ever adds.
const HINT = {
  county: { agrees: 0.05, differs: -0.25 },
  field: { agrees: 0.05, differs: -0.25 },
  operator: { agrees: 0.03, differs: 0 },
};
// Field values that are not a field name: no evidence either way.
const FIELD_PLACEHOLDER = /^(ANY FIELD|WILDCAT|EXPLORATORY|EXPLORATION|UNKNOWN|NONE|N\/?A$|\*)/i;
// A field code the source could not decode ('ABCDE'): no evidence either way.
const isCode = (v) => /^[A-Z0-9-]{2,5}$/.test(String(v).trim());
// A permit that was cancelled or expired was never drilled.
const NEVER_DRILLED = /cancel|permit expired/i;
const NEVER_DRILLED_COST = 0.05;
const round2 = (n) => Math.round(n * 100) / 100;

// Words that say nothing about which company or field it is.
const ORG_NOISE = new Set(["INC", "LLC", "LP", "LTD", "CO", "CORP", "CORPORATION", "COMPANY", "THE", "OF", "AND", "USA", "U", "S", "A", "OPERATING", "PRODUCTION", "FIELD", "COUNTY", "AREA", "UNIT",
  "OIL", "GAS", "ENERGY", "RESOURCES", "PETROLEUM", "EXPLORATION", "GEOTHERMAL", "POWER", "PARTNERS", "PARTNERSHIP", "HOLDINGS", "GROUP", "NATURAL", "CALIFORNIA", "NEVADA", "ALASKA", "OREGON", "WASHINGTON", "OFFSHORE"]);
const hintTokens = (v) => nameTokens(v).filter((t) => !ORG_NOISE.has(t));

/**
 * A hint cut down to the words a registry is likely to share, for use as a search filter:
 * 'Acme Western Oil Corp.' -> 'ACME WESTERN', 'N. Coyote Hills' -> 'COYOTE HILLS'.
 */
export function hintText(v) {
  return hintTokens(v).filter((t) => /^[A-Z]{3,}$/.test(t)).slice(0, 2).join(" ");
}

/**
 * The well-number halves of a working name worth looking up on their own: from the first
 * word with a digit to the end, and the last word alone when that differs
 * ('Opal 310-512' -> ['310-512']; 'Section 4 5-6' -> ['4 5-6', '5-6']). Empty when the
 * name has no lease words in front of its number.
 */
export function numberParts(name) {
  const words = splitBore(name).base.split(/\s+/).filter(Boolean);
  let i = words.findIndex((w) => /\d/.test(w));
  if (i <= 0) return [];
  // A short letter designator before the number belongs to it: 'Ironbark IW 5' -> 'IW 5'.
  if (i > 1 && /^[A-Z]{1,3}$/.test(words[i - 1])) i--;
  const last = words.at(-1);
  return [...new Set([words.slice(i).join(" "), ...(/\d/.test(last) ? [last] : [])])];
}

/**
 * The longest number in a working name ('KR3456HB-78' -> '3456'): what to look for among
 * the wells around a position when the name as a whole finds nothing. Null under two digits.
 */
export function mainNumber(name) {
  const runs = (splitBore(name).base.match(/\d+/g) ?? []).map((r) => r.replace(/^0+(?=\d)/, ""));
  const longest = runs.sort((a, b) => b.length - a.length)[0];
  return longest && longest.length >= 2 ? longest : null;
}

/** The last number in a working name with its letter suffix ('State 7720-6' -> '6', 'Quill QX-214' -> '214'). */
export function lastNumber(name) {
  const m = /(\d+[A-Z]?)\D*$/.exec(splitBore(name).base);
  return m ? m[1].replace(/^0+(?=\d)/, "") : null;
}

/** A date in any common shape -> { iso } or, for a bare year, { year }; null when unreadable. */
export function parseDateHint(v) {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return { year: Number(s) };
  const iso = isoDate(s) ?? (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s) ? usDateToIso(s) : null) ?? namedDateToIso(s);
  return iso ? { iso } : null;
}

const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** The year a record was drilled: from its spud date, else the drillYear that year-only registries give. */
const recordYear = (well) => (well.spudDate ? Number(well.spudDate.slice(0, 4)) : Number(well.drillYear) || null);

/**
 * 1 for the same day or two, fading to 0 past about a year (a redrill keeps the original
 * spud date). When only a year is known on either side, the years are compared.
 */
function spudScore(hint, well) {
  if (!hint) return null;
  const year = recordYear(well);
  if (!year) return null;
  const hintYear = hint.year ?? Number(hint.iso.slice(0, 4));
  if (hint.year || !well.spudDate) return year === hintYear ? 0.7 : Math.abs(year - hintYear) === 1 ? 0.3 : 0;
  const d = days(hint.iso, well.spudDate);
  return d <= 3 ? 1 : d <= 45 ? 0.8 : d <= 400 ? 0.4 : 0;
}

/** 1 within 100 m, fading to 0 at the search radius. */
function distanceScore(km, radiusKm) {
  if (km == null) return null;
  return km <= 0.1 ? 1 : Math.max(0, 1 - (km - 0.1) / Math.max(radiusKm - 0.1, 0.1));
}

/**
 * Score one normalized registry record against what is known about the well.
 * known: { names: [..], derived?: [..] (see derivedNames), operator?, field?, county?,
 *   near?: { latitude, longitude, radiusKm }, spud?: parseDateHint(), areaCounty?: Set of source
 *   keys whose county slot holds a basin or district }
 * `nameMatch` is the record's score from a name search (it saw lease and number apart), if any.
 * Returns { score, rank, evidence } with only the evidence both sides have.
 */
export function scoreCandidate(known, well, nameMatch = null) {
  const shown = Math.max(...known.names.map((n) => nameScore(n, { name: well.wellName ?? "" })));
  // Readings of the name the caller did not give (see derivedNames) count a shade less.
  const derived = Math.max(0, ...(known.derived ?? []).map((n) => DERIVED_WEIGHT * nameScore(n, { name: well.wellName ?? "" })));
  const name = round2(Math.max(shown, derived, nameMatch ?? 0));
  const km =
    known.near && Number.isFinite(well.latitude) && Number.isFinite(well.longitude)
      ? haversineKm(known.near.latitude, known.near.longitude, well.latitude, well.longitude)
      : null;
  const parts = { name, distance: distanceScore(km, known.near?.radiusKm), spud: spudScore(known.spud, well) };
  let total = 0;
  let weight = 0;
  for (const [k, v] of Object.entries(parts)) {
    if (v == null) continue;
    total += WEIGHTS[k] * v;
    weight += WEIGHTS[k];
  }
  let score = total / weight;
  const evidence = { name: round2(name) };
  if (km != null) evidence.distanceKm = round2(km);
  if (parts.spud != null && known.spud.iso && well.spudDate) evidence.spudDaysApart = Math.round(days(known.spud.iso, well.spudDate));
  else if (parts.spud != null) evidence.spudYearMatches = recordYear(well) === (known.spud.year ?? Number(known.spud.iso.slice(0, 4)));
  for (const k of ["operator", "field", "county"]) {
    if (!known[k] || !well[k] || !String(well[k]).trim()) continue;
    if (k === "field" && (FIELD_PLACEHOLDER.test(String(well[k]).trim()) || FIELD_PLACEHOLDER.test(known[k].trim()) || isCode(well[k]))) continue;
    if (k === "county" && known.areaCounty?.has(well.source)) continue; // a basin or district, not a county
    const agree = wordOverlap(hintTokens(known[k]), hintTokens(well[k]));
    evidence[k] = agree >= 0.5 ? "agrees" : "differs";
    // Measured on US state registries only. Elsewhere the county slot is often a basin, licence
    // or locality and field names are spelled more ways: disagreement there costs nothing.
    score += evidence[k] === "differs" && well.country !== "US" ? 0 : HINT[k][evidence[k]];
  }
  // A permit never drilled ranks just below an otherwise equal record.
  if (NEVER_DRILLED.test(well.status ?? "")) score -= NEVER_DRILLED_COST;
  // score is held to 0-1 for display; rank keeps the hint bonuses past 1, so two perfect name
  // matches are told apart by the one whose field and county also agree.
  return { score: round2(Math.max(0, Math.min(1, score))), rank: round2(score), evidence };
}

const DERIVED_WEIGHT = 0.9;

/**
 * Other readings of a working name that registries use, tried as extra names: a section and
 * township code before or after the well number ('512-14Q' is well 512 in section 14 - but
 * an H is a horizontal well's own number: '31-6H' stays whole -, '22D-3047' well 3047 in
 * 22D, 'S17QVX-3' well QVX-3 in section 17), letters run into a lease abbreviation
 * ('ZK4410H-2' -> '4410H-2').
 */
export function derivedNames(name) {
  const { base } = splitBore(name);
  const out = new Set();
  let m;
  if ((m = /^(.*?\d+[A-Z]?)-\d{1,2}[JPQRSZ]$/.exec(base)) && /\d/.test(m[1])) out.add(m[1]).add(m[1].replace(/^[A-Z](?=\d)/, "")); // 512-14Q, K712-3P
  if ((m = /^\d{1,2}(?!H)[A-Z]{1,2}[-_](\S*\d\S*)$/.exec(base))) out.add(m[1]); // 22D-3047, 29W_0617Z
  if ((m = /^S\d{1,2}([A-Z]{2,}[-\s]?\d.*)$/.exec(base))) out.add(m[1]); // S17QVX-3
  if ((m = /^\d{1,2}[A-Z](?=[A-Z])(\S+)$/.exec(base)) && /\d/.test(m[1])) out.add(m[1]); // 24DK-7-AB-JK
  if ((m = /^[A-Z]{2,3}(\d{3,}[A-Z]?(?:-\d+[A-Z]?)?)$/.exec(base))) out.add(m[1]); // ZK4410H-2
  if (/\b(IW|INJ)\b/.test(base)) out.add(base.replace(/\bIW\b/, "INJ").replace(/\bINJ\b(?=.*\bINJ\b)/, "IW")); // 'Ironbark IW-4' is filed as 'Ironbark Inj 4'
  out.delete(base);
  return [...out].filter((n) => /\d/.test(n));
}

/**
 * The same well listed by two sources (a state registry and a regional compilation): one key.
 * idKind: the source's ("us-api" lets an 8-digit county + sequence id, as CO and CA-GEO store
 * them, join the full API numbers of the same well elsewhere).
 */
export function wellKey(well, idKind = null) {
  const digits = String(well.api ?? "").replace(/\D/g, "");
  const plain = /^[\d\s-]+$/.test(String(well.api ?? ""));
  if (well.country === "US" && digits.length >= 10 && plain) return `US:${digits.slice(0, 10)}`;
  if (idKind === "us-api" && well.country === "US" && digits.length === 8 && plain && STATE_API_CODE[well.state]) return `US:${STATE_API_CODE[well.state]}${digits}`;
  // An id without a digit is usually a placeholder ('Unknown', 'N/A'): such wells are told apart by name and position.
  const id = /\d/.test(String(well.api ?? "")) ? well.api : null;
  return `${well.source}:${id ?? `${well.wellName}@${Number(well.latitude).toFixed(4)},${Number(well.longitude).toFixed(4)}`}`;
}

/** A second line of evidence beside the name: the record is at the position given, or was spudded when the well was. */
const corroborated = ({ evidence: e }) => (e.distanceKm != null && e.distanceKm <= 0.5) || (e.spudDaysApart != null && e.spudDaysApart <= 45);

/**
 * How far to trust the top candidate:
 *   strong     the name fits, the position or spud date agrees, and nothing else comes close
 *              (or what comes close is a neighbour whose name fits clearly less well)
 *   probable   a clear best candidate, but on one line of evidence (a name alone is never
 *              "strong": two wells in a state can carry the same name)
 *   ambiguous  two or more records fit about equally: more facts are needed to choose
 *   weak       nothing fits well
 */
export function confidenceOf(candidates) {
  const [top, second] = candidates;
  if (!top) return "none";
  const margin = (top.rank ?? top.score) - (second?.rank ?? second?.score ?? 0);
  // Neighbours on the same pad score close on position alone ('Ridge B 217' beside
  // 'Ridge B 217A'). They do not make the match unclear when the name tells them apart.
  const byName = second != null && top.evidence.name - second.evidence.name >= 0.1;
  // A best candidate in another county or field than the one given is never more than ambiguous,
  // unless a position or spud date that agrees outweighs a field or county spelled another way.
  const contradicted = top.evidence.county === "differs" || top.evidence.field === "differs";
  if (contradicted && !corroborated(top)) return top.score >= 0.6 ? "ambiguous" : "weak";
  if (top.score >= 0.85 && (margin >= 0.1 || byName) && top.evidence.name >= 0.6 && corroborated(top)) return "strong";
  if (top.score >= 0.7 && (margin >= 0.05 || byName)) return "probable";
  if (top.score >= 0.6) return "ambiguous";
  return "weak";
}

/** Candidates worth showing: a name match of some kind, or a record right at the given location. */
export const worthShowing = (c) => c.evidence.name >= 0.3 || (c.evidence.distanceKm != null && c.evidence.distanceKm <= 0.15);
