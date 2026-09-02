"use strict";
/*
 * albumkeys.js — matching identity keys by their TITLE half alone.
 *
 * Every album identity in this app is "title||artist" (see albumKeys in
 * index.js). That works whenever Roon supplies an artist, and falls over
 * entirely when it does not: an empty artist makes the key "analogue||", which
 * matches nothing, so an album Roon has no artist for gets no source badge, no
 * local-file lookup and no waveform.
 *
 * Matching on the title alone is the weaker rung underneath that. It is only
 * ever safe when the answer is UNAMBIGUOUS — one album of that title, in one
 * place — which is the same discipline wfResolveFile uses for track matching:
 * a confident answer or none at all. This module does the matching and the
 * counting; deciding what is confident enough belongs to the caller.
 *
 * Pure: it takes the key sets rather than reaching for them, so it is testable
 * without a library, a Core or a database.
 */

/** The title half of an identity key, or "" if it is not one. */
function titleOf(key) {
  const s = String(key || "");
  const i = s.indexOf("||");
  return i > 0 ? s.slice(0, i) : "";
}

/** The artist half, or "" for a key that carries none. */
function artistOf(key) {
  const s = String(key || "");
  const i = s.indexOf("||");
  return i >= 0 ? s.slice(i + 2) : "";
}

/**
 * Every key in `keys` whose title half is one of `titles`.
 *
 * @param {Set|Array} keys    identity keys, "title||artist"
 * @param {Array<string>} titles  title halves to accept (the variants an album
 *                                can be known by — see albumTitleVariants)
 * @returns {Array<string>} the matching keys, in the order the set yields them
 */
function titleOnlyMatches(keys, titles) {
  const want = new Set((titles || []).filter(Boolean));
  if (!want.size || !keys) return [];
  const out = [];
  for (const k of keys) {
    const t = titleOf(k);
    if (t && want.has(t)) out.push(k);
  }
  return out;
}

/**
 * Where an album title is found across the three key sets, and whether that
 * answer is good enough to act on.
 *
 * `confident` means exactly one match in exactly one place. Two albums sharing
 * a title — a reissue alongside an original, the same record in two services —
 * is precisely the case where guessing produces a waveform of the wrong master,
 * which looks authoritative and is simply a different recording.
 *
 * @param {Array<string>} titles
 * @param {{local?:Set, qobuz?:Set, tidal?:Set}} sets
 */
function locateByTitle(titles, sets) {
  const s = sets || {};
  const local = titleOnlyMatches(s.local, titles);
  const qobuz = titleOnlyMatches(s.qobuz, titles);
  const tidal = titleOnlyMatches(s.tidal, titles);
  const places = [
    local.length ? "local" : null,
    qobuz.length ? "qobuz" : null,
    tidal.length ? "tidal" : null,
  ].filter(Boolean);
  const total = local.length + qobuz.length + tidal.length;
  return {
    local, qobuz, tidal,
    places,
    total,
    // Local wins when it is one of the places, for the same reason albumSource
    // prefers it: the files are what actually plays.
    source: places.length === 1 ? places[0] : (local.length ? "local" : null),
    confident: total === 1,
  };
}

module.exports = { titleOf, artistOf, titleOnlyMatches, locateByTitle };
