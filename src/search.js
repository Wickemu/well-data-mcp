// One source, one search: the filter checks, name ranking and nearest-first radius
// searches shared by search_wells, wells_near and match_well.

import { normalizeRecord } from "./sources/index.js";
import { providerFor } from "./providers/index.js";
import { withinRadius, haversineKm } from "./geo.js";
import { nameScore, NAME_SCORE_FLOOR } from "./name-match.js";

export function normalizeRows(source, rows) {
  return rows.map((r) => ({
    source: source.key,
    country: source.country,
    ...(source.state ? { state: source.state } : {}),
    ...normalizeRecord(source, r.attrs, r.geometry),
  }));
}

function unsupportedNote(source, unsupported) {
  if (!unsupported?.length) return {};
  return {
    unsupportedFilters: unsupported,
    note: `${source.key} cannot filter on: ${unsupported.join(", ")} (not in its data); those filters were ignored.`,
  };
}

const LOOSE_NAME_KINDS = new Set(["arcgis", "wfs", "snapshot"]); // providers that loosen the name filter
const GOOD_NAME_MATCH = 0.85; // a name match this good ends the search for looser spellings
// The name itself found whole inside a registry name (tiers 0-1, e.g. 'K-17Q' in 'Smith K-17Q-4')
// is trusted over the guessier tiers that look for the number alone or one word.
const WHOLE_NAME_MATCH = 0.55;

/** One identity per row, so a well found by two name tiers is listed once. */
function rowKey(source, row) {
  const a = row.attrs ?? {};
  const id = (source.dedupeBy && a[source.dedupeBy]) ?? a.OBJECTID ?? a.objectid ?? a.FID ?? a._featureId;
  return id != null ? `id:${id}` : JSON.stringify([a, row.geometry]);
}

/**
 * Score rows against the well name asked for, best first (see name-match.js). Each row is
 * scored on the name it displays, on the field the filter searched and, where the layer
 * keeps them apart, on lease + number. Providers that loosen their name filter let through
 * rows that are not name matches at all; those are dropped.
 */
export function rankByName(source, wellName, rows) {
  const field = source.searchFields.well_name;
  const floor = LOOSE_NAME_KINDS.has(source.kind ?? "arcgis") ? NAME_SCORE_FLOOR : 0;
  const scored = rows.map((row) => {
    const attrs = row.attrs ?? {};
    // rankFiledName false: the field as filed misleads (an operator in front of the well name)
    // and the normalizer shows a cleaned name, so only that is scored.
    const candidates = [{ name: normalizeRecord(source, attrs, row.geometry).wellName }, ...(source.rankFiledName === false ? [] : [{ name: attrs[field] }])];
    if (source.wellNumberField) candidates.push({ lease: attrs[field], number: attrs[source.wellNumberField] });
    if (source.wellNameAlso) candidates.push({ name: attrs[source.wellNameAlso] }); // the row may have been found by it
    return { row, score: Math.max(...candidates.map((c) => nameScore(wellName, c))) };
  });
  return scored.filter((r) => r.score >= floor).sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ nearest wells
//
// A radius request returns the wells in the circle in no particular order, and only as
// many as the server gives in one answer. In a dense field the circle holds thousands, so
// "the nearest of what came back" is not the nearest: the well on the spot is usually
// missing. So when the circle comes back cut short, the search asks again closer in until
// an answer comes back whole, widens once or twice while it stays whole, and builds the
// list from the whole circle plus, beyond it, the samples already in hand.

const NEAR_ROWS_MIN = 300; // rows asked per radius request, at least
const NEAR_SHRINKS = 3; // closer-in requests, each a quarter of the radius before
const NEAR_GROWS = 2; // widening requests once one came back whole
const NEAR_MIN_KM = 0.03;
const NEAR_ALL_ROWS_KM = 0.2; // at or inside this radius, ask for every row the server allows

/** One radius request: the wells inside the circle with their distance, and whether the answer was whole. */
async function radiusPass(provider, source, filters, center, radiusKm, cap) {
  const near = { ...center, radiusKm };
  const answer = await provider.search(source, filters, { limit: cap, offset: 0, near });
  const wells = withinRadius(normalizeRows(source, answer.rows), near).map((w) => ({
    well: w,
    km: haversineKm(center.latitude, center.longitude, w.latitude, w.longitude),
  }));
  // A full page counts as cut short too: not every server says so.
  const whole = Boolean(provider.nearSorted) || (!answer.moreAvailable && answer.rows.length < cap);
  return { radiusKm, wells, whole, more: Boolean(answer.moreAvailable), unsupported: answer.unsupported };
}

/**
 * The wells nearest a point, nearest first.
 * Returns { wells, moreAvailable, completeWithinKm?, unsupported }. completeWithinKm is set
 * only when the circle held more than one answer carries: every well within that distance
 * is in the list, anything farther is a sample (0: no closer-in answer came back whole, so
 * the whole list is a sample). keepWithinKm: never trim wells closer than this, whatever the limit.
 */
async function nearestWells(provider, source, filters, near, limit, keepWithinKm = 0) {
  const center = { latitude: near.latitude, longitude: near.longitude };
  const cap = Math.min(Math.max(limit * 3, NEAR_ROWS_MIN), source.pageMax);
  const pass = (radiusKm, rows = cap) => radiusPass(provider, source, filters, center, radiusKm, rows);
  const trim = (list) => {
    list.sort((a, b) => a.km - b.km);
    const keep = Math.max(limit, list.filter((x) => x.km <= keepWithinKm).length);
    return { kept: list.slice(0, keep), cut: list.length > keep };
  };
  const out = (list) => list.map(({ well, km }) => ({ ...well, distanceKm: Math.round(km * 100) / 100 }));

  const outer = await pass(near.radiusKm);
  if (outer.whole) {
    const { kept, cut } = trim(outer.wells);
    return { wells: out(kept), moreAvailable: cut || outer.more, unsupported: outer.unsupported };
  }

  // Closer in, until an answer comes back whole. A provider that pads its box (nearPadKm)
  // cannot ask for less than the pad, so radii inside it would only repeat the request.
  const floor = Math.max(NEAR_MIN_KM, provider.nearPadKm?.(source) ?? 0);
  const short = [outer]; // answers that were cut short, widest first
  let whole = null;
  for (let r = near.radiusKm / 4, i = 0; i < NEAR_SHRINKS && r >= floor && !whole; r /= 4, i++) {
    const p = await pass(r);
    if (p.whole) whole = p;
    else short.push(p);
  }
  // Still cut short close in: many wells share one surface position (a platform, a drilling
  // island). Ask once for every row the server allows.
  const tightest = short.at(-1);
  if (!whole && tightest.radiusKm <= NEAR_ALL_ROWS_KM && source.pageMax > cap) {
    const p = await pass(tightest.radiusKm, source.pageMax);
    if (p.whole) {
      whole = p;
      short.pop();
    }
  }
  // Widen while the whole circle holds fewer wells than asked for: halfway (in area terms)
  // to the tightest circle that was cut short.
  for (let i = 0; whole && short.length && i < NEAR_GROWS && whole.wells.length < limit; i++) {
    const p = await pass(Math.sqrt(whole.radiusKm * short.at(-1).radiusKm));
    if (p.whole) whole = p;
    else short.push(p);
  }

  // The whole circle, then from each cut-short answer only the ring outside the next one in:
  // no well is taken twice, and none needs an id to tell it from another.
  const list = whole ? [...whole.wells] : [];
  let inner = whole ? whole.radiusKm : -1;
  for (const p of [...short].sort((a, b) => a.radiusKm - b.radiusKm)) {
    if (p.radiusKm <= inner) continue;
    list.push(...p.wells.filter((x) => x.km > inner));
    inner = p.radiusKm;
  }
  const { kept } = trim(list);
  const complete = !whole ? 0 : whole.wells.length >= kept.length ? kept.at(-1)?.km ?? whole.radiusKm : whole.radiusKm;
  return { wells: out(kept), moreAvailable: true, completeWithinKm: Math.floor(complete * 100) / 100, unsupported: outer.unsupported };
}

// A layer that repeats rows (dedupeBy) is paged from its first row: the provider drops
// repeats within one server answer, and the pages here drop them across answers, so page
// 2 continues page 1 with neither short pages nor wells listed twice. Past DEDUPE_PAGES_MAX
// server answers the offset goes to the server as it is.
const DEDUPE_PAGES_MAX = 10;

/** One page of a dedupeBy layer: { rows, moreAvailable, unsupported, serverPaged? }. */
async function dedupedPage(provider, source, filters, offset, limit) {
  const want = offset + limit;
  const seen = new Set();
  const rows = [];
  let unsupported;
  let serverOffset = 0;
  let more = true;
  for (let page = 0; more && rows.length <= want && page < DEDUPE_PAGES_MAX; page++) {
    const size = page === 0 ? Math.min(Math.max(want * 4, 200), source.pageMax) : source.pageMax;
    const answer = await provider.search(source, filters, { limit: size, offset: serverOffset });
    unsupported ??= answer.unsupported;
    for (const row of answer.rows) {
      const key = rowKey(source, row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    more = Boolean(answer.moreAvailable);
    serverOffset += size;
  }
  if (rows.length <= offset && more) {
    // Deeper than the pages read here: the server's own paging, from past the rows already
    // read, repeats dropped within the page.
    const answer = await provider.search(source, filters, { limit, offset: serverOffset + (offset - rows.length) });
    return { rows: answer.rows, moreAvailable: Boolean(answer.moreAvailable), unsupported: answer.unsupported, serverPaged: true };
  }
  return { rows: rows.slice(offset, want), moreAvailable: more || rows.length > want, unsupported };
}

/**
 * A name search asks the provider's name tiers in turn until one has a match: the name as
 * typed, then its forgiving form. deepNames adds the last two (the well number alone, then
 * the name's longest word) - up to two more requests on a miss, so callers asking many
 * sources at once leave it off.
 * rankName: the name to rank rows against, when the well_name filter is only part of it
 * (match_well filters on the well number and ranks on the whole name).
 * near: a radius search - the nearest wells first (see nearestWells); keepWithinKm keeps
 * every well closer than that even past the limit.
 */
export async function searchOneSource(source, filters, { limit, offset, near = null, countOnly = false, deepNames = true, rankName = filters.well_name, keepWithinKm = 0 }) {
  const provider = providerFor(source);
  const asked = Object.keys(filters);
  if (source.requiresOneOf && !near && !asked.some((k) => source.requiresOneOf.includes(k))) {
    return {
      source: source.key,
      label: source.label,
      skipped: true,
      note: `${source.key} needs one of: ${source.requiresOneOf.join(", ")} (a statewide query would be too large).`,
    };
  }
  if (asked.length && asked.every((k) => !source.searchFields[k])) {
    // None of the filters apply here; querying anyway would return the whole layer unfiltered.
    return {
      source: source.key,
      label: source.label,
      skipped: true,
      note: `${source.key} cannot filter on ${asked.join(", ")}; searchable here: ${Object.keys(source.searchFields).join(", ")}.`,
    };
  }
  if (countOnly) {
    const { count, approximate, unsupported } = await provider.count(source, filters, { near });
    return {
      source: source.key,
      label: source.label,
      count,
      ...(approximate ? { approximate: true } : {}),
      ...unsupportedNote(source, unsupported),
    };
  }
  if (near) {
    const found = await nearestWells(provider, source, filters, near, limit, keepWithinKm);
    return {
      source: source.key,
      label: source.label,
      agency: source.agency,
      returned: found.wells.length,
      moreAvailable: found.moreAvailable,
      ...(found.completeWithinKm != null ? { completeWithinKm: found.completeWithinKm } : {}),
      wells: found.wells,
      ...unsupportedNote(source, found.unsupported),
      ...(source.caveat ? { caveat: source.caveat } : {}),
    };
  }
  // A name search over-fetches: servers return matches in arbitrary order, so it takes
  // extra, keeps the best-named, ranks one window from the top and pages within it, so
  // page 2 continues page 1. A layer that repeats rows (dedupeBy) is paged by dedupedPage.
  const byName = Boolean(filters.well_name && source.searchFields.well_name);
  if (!byName && source.dedupeBy) {
    const page = await dedupedPage(provider, source, filters, offset, limit);
    const wells = normalizeRows(source, page.rows);
    const unsupportedNotes = unsupportedNote(source, page.unsupported);
    const deepNote = page.serverPaged ? `Offset ${offset} is past the ${DEDUPE_PAGES_MAX} server answers paged here, so this page comes from the server's own paging: a well the layer lists more than once can appear on two pages.` : null;
    return {
      source: source.key,
      label: source.label,
      agency: source.agency,
      returned: wells.length,
      moreAvailable: page.moreAvailable,
      wells,
      ...unsupportedNotes,
      ...(deepNote ? { note: [unsupportedNotes.note, deepNote].filter(Boolean).join(" ") } : {}),
      ...(source.caveat ? { caveat: source.caveat } : {}),
    };
  }
  const window = byName;
  const fetchLimit = window ? Math.min(Math.max((offset + limit) * 4, 200), source.pageMax) : limit;
  const fetchOffset = window ? 0 : offset;
  const tiers = byName ? Math.min(provider.nameTiers ?? 1, deepNames ? Infinity : 2) : 1;
  let result;
  let ranked = null;
  let failed = null;
  let more = false;
  const seen = new Set();
  // Looser tiers are asked until a match is good: a tier that finds only look-alikes
  // ('Ameland Westgat-1' as typed finds the -101 wells, 0.5) does not stop the search, and
  // what each tier finds is merged, best first. The name found whole (tiers 0-1, >= 0.55)
  // stops it, as does any match >= 0.85.
  let wholeName = false;
  for (let tier = 0; tier < tiers && !wholeName && !(ranked?.[0]?.score >= GOOD_NAME_MATCH); tier++) {
    let answer;
    try {
      answer = await provider.search(source, filters, { limit: fetchLimit, offset: fetchOffset, nameTier: tier });
    } catch (e) {
      if (ranked?.length) break; // a looser tier failed: keep what the stricter ones found
      // A name with characters the server's filter parser rejects ('Bockstedt 42 (1.)'):
      // the forgiving tier asks for letters and digits only, so let it try.
      if (tier > 0 || tiers < 2) throw failed ?? e;
      failed = e;
      continue;
    }
    if (answer.noTier) continue; // the name has no such tier: nothing was asked
    result ??= answer;
    more ||= Boolean(answer.moreAvailable);
    if (!byName) break;
    const fresh = rankByName(source, rankName, answer.rows).filter(({ row }) => {
      const key = rowKey(source, row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    ranked = [...(ranked ?? []), ...fresh].sort((a, b) => b.score - a.score);
    if (tier <= 1 && fresh.some((r) => r.score >= WHOLE_NAME_MATCH)) wholeName = true;
  }
  if (!result) throw failed ?? new Error(`${source.key}: no search was run`);
  const { unsupported } = result;
  let moreAvailable = more;
  let wells = ranked ? ranked.map(({ row, score }) => ({ ...normalizeRows(source, [row])[0], nameMatch: score })) : normalizeRows(source, result.rows);
  if (window) {
    if (wells.length > offset + limit) moreAvailable = true;
    wells = wells.slice(offset, offset + limit);
  }
  return {
    source: source.key,
    label: source.label,
    agency: source.agency,
    returned: wells.length,
    moreAvailable,
    wells,
    ...unsupportedNote(source, unsupported),
    ...(source.caveat ? { caveat: source.caveat } : {}),
  };
}
