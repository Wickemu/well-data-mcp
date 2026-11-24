// Comparing well identifiers that are typed differently from how a registry stores them:
// '15/9-19A' vs '15/9-19 A', '9/13a-20B' vs '9/13a- 20B', 'AWG-1' vs 'AWG-01'. An id is
// reduced to its tokens - letter runs and number runs, case and accents folded, leading
// zeros dropped - and two ids are the same when their tokens are. A bare contains-match
// is not good enough for ids: 'AWG-1' is inside 'AWG-101' and '00061' inside a UWI.

const fold = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/** 'AWG-01' -> ['AWG', '1']; '15/9-19 A' -> ['15', '9', '19', 'A']. */
export function idTokens(v) {
  return (fold(v).match(/[A-Z]+|\d+/g) ?? []).map((t) => (/^\d/.test(t) ? t.replace(/^0+(?=\d)/, "") : t));
}

/** The same identifier, whatever the punctuation, spacing, case or zero padding. */
export function sameIdTokens(a, b) {
  const x = idTokens(a).join(" ");
  return x !== "" && x === idTokens(b).join(" ");
}

/**
 * Does the stored id contain the asked one as whole tokens, in order ('Qulleq' in
 * 'Qulleq-1', '19 A' in '15/9-19 A')? Unlike a substring test, 'AWG-1' is not in 'AWG-101'.
 */
export function idTokenRun(stored, asked) {
  const s = idTokens(stored);
  const a = idTokens(asked);
  if (!a.length || a.length > s.length) return false;
  for (let i = 0; i + a.length <= s.length; i++) if (a.every((t, k) => s[i + k] === t)) return true;
  return false;
}

/** Worth looking for inside longer ids: two tokens or more, or a word of three letters or more (not '4' or '00061'). */
export function partialWorthy(id) {
  const t = idTokens(id);
  return t.length >= 2 || t.some((x) => /^[A-Z]{3,}$/.test(x));
}

/** An id with letters in it is a name, not one of a numeric-id source's ids ('Ngamia-1', 'Moomba 1'). */
export const hasLetters = (id) => /[A-Za-z]/.test(String(id));

/**
 * A second field a source's id may be in (source.idAlso: { field, test?, pad? }), with the
 * value to look for there, or null when the id does not fit it ('00061' for a BC well
 * authority number given as '61', an old BSS code '1152ZZ0001/S').
 */
export function idAlsoValue(source, id) {
  const also = source.idAlso;
  if (!also) return null;
  const t = String(id).trim();
  if (also.test && !also.test.test(t)) return null;
  return also.pad && /^\d+$/.test(t) ? t.padStart(also.pad, "0") : t;
}
