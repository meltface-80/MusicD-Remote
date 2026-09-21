"use strict";
/*
 * similar.js — acts worth hearing next, given the one that is playing.
 *
 * Ported from MusicD Share Card (Similar.kt). Pure: every function here takes
 * a parsed JSON body and returns a decision. The fetching lives in index.js.
 *
 * ARTISTS, NOT ALBUMS, AND THE NAME OF THE FEATURE IS A COMPROMISE. Nothing
 * keyless does album-to-album similarity. Every route available without a
 * developer account answers "artists like this artist", so what this finds is
 * a handful of acts and then ONE record by each — which is why the row says
 * "If you like this" rather than promising a recommendation engine.
 *
 * DEEZER ONLY, AND THAT IS A DELIBERATE NARROWING OF THE PORT. The original
 * tries ListenBrainz first, keyed on a MusicBrainz artist id, and falls back
 * to Deezer. Its own note on that path reads "this has never once answered in
 * the field", and the dataset name its query needs was never verified from the
 * machine it was written on. Porting a path that has never worked would be
 * porting the appearance of a feature, so this carries the half that does. If
 * ListenBrainz's similar-artists endpoint is ever confirmed working, it slots
 * in ahead of readDeezerArtists with the same shape.
 *
 * NOTHING HERE GOES ON THE CARD. The card is the whole message and what it
 * says is what is playing; a suggestion is the page's business.
 */

const WANTED      = 3;    // acts to suggest
const SEARCH_ROWS = 10;   // artist-search rows to consider
const CANDIDATES  = 3;    // how many of them are worth a second call

/*
 * Whether two act names are the same act. Mirrors index.js's namesOverlap:
 * whole-name containment either way, then a leading "The" discounted.
 *
 * A COPY, AND FOR THE SAME REASON AS lib/wiki-match.js — the rule and the
 * decision it drives belong together, and this module has to be usable without
 * dragging index.js in. The test runs both over one battery.
 */
function normalize(s) {
  return String(s == null ? "" : s).toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function namesOverlap(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return false;
  const pad = s => " " + s + " ";
  if (pad(a).includes(pad(b)) || pad(b).includes(pad(a))) return true;
  const strip = s => s.replace(/^the /, "");
  return strip(a) === strip(b);
}

/**
 * The Deezer artists worth trying for this name, best first.
 *
 * THE NAME GUARD APPLIES TO EVERY ROW, not just the first: a search that
 * returns SOMETHING is not evidence that it returned this act. Deezer answers
 * "Sting" with a dozen tribute acts and covers bands, and taking row one on
 * trust suggests records by whoever happens to rank highest.
 *
 * AN EXACT NAME BEATS A CONTAINING ONE, WHICH IS A DEVIATION FROM THE PORT.
 * The shared namesOverlap() is whole-WORD containment in either direction,
 * because it also has to call "Prince" and "Prince & The Revolution" the same
 * act. That permissiveness lets "Sting Tribute Band" through the guard, and
 * the original then orders purely by follower count — so a tribute act with
 * more followers than the artist would be asked for related acts first. Rare,
 * but the failure is silent and the whole row would be wrong. Exact matches
 * sort ahead of partial ones here; `nb_fan` breaks ties within each group.
 *
 * `nb_fan` is a TIE-BREAK, never the filter — it orders acts that already
 * carry the right name and never promotes one that does not.
 */
function readDeezerArtists(json, artist) {
  const data = (json && Array.isArray(json.data)) ? json.data : null;
  if (!data) return [];
  const out = [];
  for (const a of data) {
    if (!a) continue;
    const id = a.id == null ? null : String(a.id);
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!id || !name) continue;
    if (!namesOverlap(name, artist)) continue;
    out.push({ id, name, fans: Number(a.nb_fan) || 0,
               exact: normalize(name) === normalize(artist) });
  }
  return out.sort((x, y) => (Number(y.exact) - Number(x.exact)) || (y.fans - x.fans));
}

/** Up to WANTED related acts, in Deezer's order, de-duplicated by id. */
function readDeezerRelated(json, wanted) {
  const limit = wanted || WANTED;
  const data = (json && Array.isArray(json.data)) ? json.data : null;
  if (!data) return [];
  const seen = new Set();
  const out = [];
  for (const a of data) {
    if (!a) continue;
    const id = a.id == null ? null : String(a.id);
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, picture: a.picture_medium || a.picture || null });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * One record by an act: their EARLIEST full album.
 *
 * Not their newest and not their most popular. A suggestion is "start here",
 * and a debut is the record that answers that question — where the newest is
 * whatever they happen to have put out, and the most popular is usually a
 * compilation.
 *
 * `record_type` must be "album": Deezer's artist listing mixes in singles and
 * EPs, and a two-track single is not an answer to "what should I hear".
 */
function readDeezerAlbums(json) {
  const data = (json && Array.isArray(json.data)) ? json.data : null;
  if (!data) return { title: null, year: null, cover: null };
  let best = null;
  for (const album of data) {
    if (!album) continue;
    if (String(album.record_type || "").toLowerCase() !== "album") continue;
    const title = typeof album.title === "string" ? album.title.trim() : "";
    if (!title) continue;
    const year = yearOf(album.release_date);
    if (year == null) continue;
    if (!best || year < best.year) {
      best = { title, year, cover: album.cover_medium || album.cover || null };
    }
  }
  return best || { title: null, year: null, cover: null };
}

/** The year from a Deezer "YYYY-MM-DD", or null for anything else. */
function yearOf(releaseDate) {
  const m = /^(\d{4})/.exec(String(releaseDate == null ? "" : releaseDate).trim());
  if (!m) return null;
  const y = Number(m[1]);
  // A release date of 0000-00-00 is Deezer's "we do not know", and a year in
  // the future is a typo in their catalogue rather than a record to recommend.
  if (!Number.isFinite(y) || y < 1900 || y > new Date().getFullYear() + 1) return null;
  return y;
}

/**
 * An act is worth showing even when no record by them could be named — the row
 * degrades to names rather than disappearing.
 */
function toAct(artist, album) {
  return {
    name:  artist.name,
    id:    artist.id,
    album: (album && album.title) || null,
    year:  (album && album.year) || null,
    cover: (album && album.cover) || artist.picture || null,
  };
}

module.exports = {
  WANTED, SEARCH_ROWS, CANDIDATES,
  normalize, namesOverlap,
  readDeezerArtists, readDeezerRelated, readDeezerAlbums, yearOf, toAct,
};
