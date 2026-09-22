"use strict";
/*
 * keymatch.js — what the index DOES hold that is close to what we looked for.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * WHY THIS EXISTS. An album identity is `canonTitle||canonArtist`, and a lookup
 * either hits or it does not. When it does not, every caller in this app says
 * the same thing: "this album is not in your favourites." That sentence is an
 * assumption wearing a conclusion's clothes — a key can miss because the record
 * genuinely is not there, or because the two sides spelled it differently, and
 * NOTHING in a failed Map lookup can tell those apart.
 *
 * v1.8.52's probe reported `album_id: null` for a record with 11,006 favourites
 * loaded and then stated, in the verdict, that the album was in neither
 * service's favourites. It did not know that. It could not have known that.
 *
 * So this answers the question a failed lookup cannot: given what we looked for
 * and everything the index holds, what is NEARBY, and how does it differ? An
 * answer of "nothing" is then a real finding — the record is absent — and an
 * answer naming a key is the spelling that has to be reconciled.
 *
 * Pure: strings in, strings out. No network, no state.
 */

/** Split "title||artist" into its halves, or null if it is not a key. */
function splitKey(k) {
  const s = String(k || "");
  const i = s.indexOf("||");
  if (i < 0) return null;
  return { title: s.slice(0, i), artist: s.slice(i + 2) };
}

/**
 * How two canonical halves relate, or null when they do not.
 *
 * "prefix" is ranked above "contains" on purpose: an edition suffix always
 * EXTENDS a title ("zebra iv" -> "zebra iv remastered"), so a shared start is
 * evidence of the same record, while a match somewhere in the middle is far
 * more often a coincidence between two unrelated titles.
 */
function relate(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b) return null;
  if (a === b) return "same";
  if (a.startsWith(b + " ") || b.startsWith(a + " ")) return "prefix";
  if (a.includes(b) || b.includes(a)) return "contains";
  return null;
}

// Lower sorts first. The order is "which of these is most likely to be the
// record we were looking for", which is the only order worth reporting in.
const RANK = {
  "same artist, title extended":            0,
  "same artist, title overlaps":            1,
  "same title, different artist":           2,
  "titles and artists both only overlap":   3,
};

/**
 * The keys in `haystack` closest to any of `wanted`.
 *
 * @param {string[]} wanted    the keys the lookup actually tried
 * @param {Iterable<string>} haystack  every key the index holds
 * @param {object} [opts]
 * @param {number} [opts.limit=12]  how many to report
 * @returns {Array<{key:string, why:string}>}
 *
 * An EXACT hit is never reported: if one were there the lookup would not have
 * failed, and listing it would describe a world the caller is not in.
 */
function nearKeys(wanted, haystack, opts) {
  const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : 12;
  const parts = (Array.isArray(wanted) ? wanted : []).map(splitKey).filter(Boolean);
  if (!parts.length) return [];
  const exact = new Set(Array.isArray(wanted) ? wanted : []);

  const found = new Map();   // key -> why (first/best reason wins)
  for (const raw of haystack || []) {
    const k = String(raw || "");
    if (exact.has(k)) continue;
    const h = splitKey(k);
    if (!h) continue;
    let best = null;
    for (const w of parts) {
      const t = relate(h.title, w.title);
      const a = relate(h.artist, w.artist);
      if (!t && !a) continue;
      let why = null;
      if (a === "same" && t === "prefix")        why = "same artist, title extended";
      else if (a === "same" && t)                why = "same artist, title overlaps";
      else if (t === "same" && a !== "same")     why = "same title, different artist";
      else if (t && a)                           why = "titles and artists both only overlap";
      if (why && (best === null || RANK[why] < RANK[best])) best = why;
    }
    if (best) {
      const had = found.get(k);
      if (!had || RANK[best] < RANK[had]) found.set(k, best);
    }
  }

  return [...found.entries()]
    .map(([key, why]) => ({ key, why }))
    .sort((x, y) => (RANK[x.why] - RANK[y.why]) || (x.key < y.key ? -1 : 1))
    .slice(0, limit);
}

/**
 * One sentence about a failed lookup, given what was nearby.
 *
 * The distinction it exists to make: "absent" and "spelled differently" need
 * completely different things from the person reading it.
 */
function missVerdict(where, wanted, near) {
  const n = Array.isArray(near) ? near : [];
  if (!n.length) {
    return "nothing in " + where + " resembles " +
           (wanted && wanted[0] ? '"' + wanted[0] + '"' : "this album") +
           ", so it really is absent rather than spelled differently";
  }
  const top = n[0];
  return where + " holds " + n.length + " near miss" + (n.length === 1 ? "" : "es") +
         ' — closest is "' + top.key + '" (' + top.why + "). The lookup is exact, " +
         "so the two spellings have to be reconciled; it is not absent";
}

module.exports = { splitKey, relate, nearKeys, missVerdict };
