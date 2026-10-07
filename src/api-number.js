// US API well numbers: SS-CCC-NNNNN[-SS-EE]. The first two digits are a state
// code from API Bulletin D12A (not FIPS), so a 10-14 digit API number tells us
// which state's sources to ask - get_well uses that instead of querying all of them.

export const API_STATE_CODES = {
  "01": "AL", "02": "AZ", "03": "AR", "04": "CA", "05": "CO", "06": "CT", "07": "DE", "08": "DC",
  "09": "FL", "10": "GA", "11": "ID", "12": "IL", "13": "IN", "14": "IA", "15": "KS", "16": "KY",
  "17": "LA", "18": "ME", "19": "MD", "20": "MA", "21": "MI", "22": "MN", "23": "MS", "24": "MO",
  "25": "MT", "26": "NE", "27": "NV", "28": "NH", "29": "NJ", "30": "NM", "31": "NY", "32": "NC",
  "33": "ND", "34": "OH", "35": "OK", "36": "OR", "37": "PA", "38": "RI", "39": "SC", "40": "SD",
  "41": "TN", "42": "TX", "43": "UT", "44": "VT", "45": "VA", "46": "WA", "47": "WV", "48": "WI",
  "49": "WY", "50": "AK", "51": "HI",
  // Federal offshore (OCS) areas
  "55": "OCS-AK", "56": "OCS-PAC", "60": "OCS-GOM", "61": "OCS-ATL",
};

/**
 * Which US state an API number belongs to, or null when it can't tell
 * (fewer than 10 digits = no state prefix, or an unknown prefix).
 */
export function apiStateOf(api) {
  const digits = String(api).replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 14) return null;
  return API_STATE_CODES[digits.slice(0, 2)] ?? null;
}

/**
 * County code + 5-digit sequence of an API number in any shape: digits 3-10 of a
 * 10/12/14-digit API (after the state prefix), else the trailing 8 digits (sources
 * that store county+sequence only). Returns { county, sequence } or null if too short.
 */
export function apiCountySequence(api) {
  const digits = String(api).replace(/\D/g, "");
  const core = digits.length >= 10 ? digits.slice(2, 10) : digits.slice(-8);
  if (!core) return null;
  return { county: core.slice(0, -5), sequence: core.slice(-5) };
}

/** The conventional dashed 10-digit form 'SS-CCC-NNNNN', or null without a state prefix. */
export function apiDashed(api) {
  const d = String(api).replace(/\D/g, "");
  return d.length >= 10 ? `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5, 10)}` : null;
}

/** Heuristic: does this look like a US API number (8-14 digits, at most cosmetic separators)? */
export function looksLikeUsApi(id) {
  const s = String(id).trim();
  const digits = s.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 && /^[\d\s-]+$/.test(s);
}
