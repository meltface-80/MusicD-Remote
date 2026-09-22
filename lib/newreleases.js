"use strict";
/*
 * newreleases.js — what came out recently by the acts you actually listen to.
 *
 * The Discover screen's one real engine. Pure: every function takes plain data
 * and returns a decision. The fetching, the cache and the daily schedule live
 * in index.js, next to Smart Picks' equivalents.
 *
 * WHY THIS IS SEEDED FROM PLAYS AND NOT FROM THE LIBRARY. They are different
 * questions and only one of them is this feature's. The library is what you
 * OWN — it includes the record a friend recommended once, the box set bought
 * for one disc, and everything imported in bulk years ago. Seeding from it
 * makes "new from artists you play" a promise the data cannot keep. The plays
 * table is what you came BACK to, which is the whole claim in the row's title.
 *
 * AND THE TRACK ARTIST IS THE RIGHT ARTIST HERE, which is the opposite of the
 * call the Home history row makes. That row deliberately takes the artist from
 * the snapshot, because `plays.artist` is the TRACK artist and a compilation
 * would name a performer rather than the record. Here the performer is exactly
 * what is wanted: if you play one track off a compilation forty times, that
 * act is one you listen to, and the compilation's "Various Artists" is not.
 *
 * DEEZER, FOR THE SAME REASON lib/similar.js GIVES. There is no keyless
 * new-release feed keyed on an artist anywhere else: MusicBrainz can browse
 * release-groups by artist but rate-limits to one request a second and carries
 * no artwork, and the streaming services' own "new releases" are editorial
 * charts rather than anything to do with who you play. Deezer answers
 * `/artist/<id>/albums` with dates, cover art and a record type, and this
 * codebase already reads that exact endpoint for the share card's suggestions.
 *
 * THE ONE THING DEEZER CANNOT TELL US is whether a 2026 date is a new record
 * or a reissue of an old one: the listing carries the date of THAT EDITION and
 * there is no original-release field. A remaster presented as new is the
 * failure mode this module is mostly built to avoid — see isReissue.
 */

const WANTED_PER_ARTIST = 2;   // at most this many records from any one act
const SEED_ARTISTS      = 40;  // acts asked about per build — see index.js's budget

/* Fold to letters, digits and single spaces. The same shape as index.js's
 * normalize() and lib/similar.js's, kept here so this module's decisions
 * cannot change from somewhere else. */
function normalize(s) {
  return String(s == null ? "" : s).toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* A title key blind to the punctuation two catalogues disagree about.
 * Identical to the rule /api/similar resolves library albums with (v1.8.35):
 * spaces squashed out and "&" spelled, so Roon's "Sgt. Pepper's" and Deezer's
 * "Sgt. Peppers" are one key rather than two. */
function titleKey(s) {
  return normalize(String(s == null ? "" : s).replace(/&/g, " and ")).replace(/ /g, "");
}

/*
 * Words that name an EDITION rather than a record.
 *
 * This list is never used on its own to reject anything — see isReissue. It is
 * one half of a conjunction, and a word list used alone is exactly the kind of
 * rule that throws away a real album for being called "Deluxe".
 */
const EDITION_WORDS = new RegExp(
  "\\b(" + [
    "remaster", "remastered", "remasters",
    "reissue", "reissued",
    "deluxe", "expanded", "extended",
    "anniversary", "edition", "version",
    "mono", "stereo",
    "bonus", "collector", "collectors", "special",
    "super", "legacy", "definitive",
  ].join("|") + ")\\b", "i");

/*
 * A title with its trailing edition suffix removed, and whether one was there.
 *
 * Two shapes carry it, and both are stripped from the END only:
 *
 *   "Rumours (2021 Remaster)"        a trailing bracketed group, repeatable
 *   "Rumours - 2021 Remaster"        a trailing dash tail
 *
 * A DASH TAIL IS ONLY REMOVED WHEN IT NAMES AN EDITION, because " - " belongs
 * to plenty of real titles and removing it blind would rename the record. A
 * bracketed group is removed whichever words it holds — but `edition` still
 * reports whether those words named an edition, and that flag is what the
 * caller acts on. Sault's "Untitled (Black Is)" and "Untitled (Rise)" both
 * reduce to "Untitled" here and NEITHER is an edition of anything; a rule that
 * acted on the reduction alone would have thrown the second one away.
 *
 * Stripping everything would leave Sigur Rós's "( )" with no title at all, so
 * a strip that empties the name is not applied.
 */
function stripEdition(title) {
  let s = String(title == null ? "" : title).trim();
  let edition = false;
  for (;;) {
    const m = /\s*[([]([^()[\]]*)[)\]]\s*$/.exec(s);
    if (!m) break;
    const rest = s.slice(0, m.index).trim();
    if (!rest) break;                       // "( )" — the brackets ARE the title
    if (EDITION_WORDS.test(m[1])) edition = true;
    s = rest;
  }
  const dash = /\s+[-–—]\s+([^-–—]*)$/.exec(s);
  if (dash && EDITION_WORDS.test(dash[1])) {
    const rest = s.slice(0, dash.index).trim();
    if (rest) { s = rest; edition = true; }
  }
  return { base: s, edition };
}

/* The year in a "YYYY-MM-DD", or null. Deezer writes 0000-00-00 for "we do
 * not know", and a year far in the future is a catalogue typo. */
function yearOf(releaseDate) {
  const m = /^(\d{4})/.exec(String(releaseDate == null ? "" : releaseDate).trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (!Number.isFinite(y) || y < 1900 || y > new Date().getFullYear() + 2) return null;
  return y;
}

/* A release date as a timestamp, or null when it is not a full date. Parsed as
 * UTC noon rather than midnight: a date-only string is midnight UTC, and a
 * server west of Greenwich would read yesterday's date back out of it. */
function dateMs(releaseDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(releaseDate == null ? "" : releaseDate).trim());
  if (!m) return null;
  if (yearOf(releaseDate) == null) return null;
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(Number(m[1]), month - 1, day, 12, 0, 0);
}

/**
 * Deezer's `/artist/<id>/albums` payload, normalised.
 *
 * Singles and EPs are dropped here rather than downstream: `record_type` must
 * be "album", because a two-track single is not the thing anybody means by a
 * new record. Rows without a usable date are dropped too — a release that
 * cannot be placed in time is no use to a feature whose whole subject is time.
 *
 * Newest first, which is the order everything below assumes.
 */
function readArtistAlbums(json) {
  const data = (json && Array.isArray(json.data)) ? json.data : null;
  if (!data) return [];
  const out = [];
  for (const a of data) {
    if (!a) continue;
    if (String(a.record_type || "").toLowerCase() !== "album") continue;
    const title = typeof a.title === "string" ? a.title.trim() : "";
    if (!title) continue;
    const ts = dateMs(a.release_date);
    if (ts == null) continue;
    const ed = stripEdition(title);
    out.push({
      id:      a.id == null ? null : String(a.id),
      title,
      base:    ed.base,
      baseKey: titleKey(ed.base),
      edition: ed.edition,
      date:    String(a.release_date).slice(0, 10),
      ts,
      year:    yearOf(a.release_date),
      cover:   a.cover_medium || a.cover_big || a.cover || null,
    });
  }
  return out.sort((x, y) => y.ts - x.ts);
}

/**
 * Is this row a re-release of a record the same act already put out?
 *
 * TWO INDEPENDENT SIGNALS, BOTH REQUIRED, and the conjunction is the whole
 * design:
 *
 *   1. the title names an edition ("… (2021 Remaster)", "… - Deluxe"), and
 *   2. the same act has an OLDER album that reduces to the same base title.
 *
 * Either alone is wrong in a way that shows. On (1) alone, the deluxe pressing
 * of a record released last week is thrown away for its name. On (2) alone,
 * "Untitled (Black Is)" is discarded as a reissue of "Untitled (Rise)" five
 * months earlier — two different albums, one act, one reduced title.
 *
 * `older` is compared by date, not by position, because the listing is sorted
 * by date and an identically-dated pair is not evidence of anything.
 */
function isReissue(row, all) {
  if (!row || !row.edition || !row.baseKey) return false;
  for (const other of all || []) {
    if (!other || other === row) continue;
    if (other.baseKey !== row.baseKey) continue;
    if (other.ts < row.ts) return true;
  }
  return false;
}

/**
 * The records by one act that count as new, newest first.
 *
 * @param {Array}  albums  readArtistAlbums output
 * @param {object} opts    { now, sinceMs, wanted, ownedKeys }
 *   now       ms — treated as the present. Anything dated after it is dropped:
 *             Deezer carries announced records, and an album that cannot be
 *             played yet is a disappointment rather than a discovery.
 *   sinceMs   ms — the start of the window.
 *   ownedKeys Set of titleKey()s already in the library. A record you own is
 *             not a discovery however recently this edition of it was filed,
 *             and this is also what catches the reissues isReissue cannot see
 *             (the ones whose original Deezer no longer lists).
 *   wanted    cap per act, so one prolific reissue campaign cannot fill the
 *             screen on its own.
 */
function pickNewReleases(albums, opts) {
  opts = opts || {};
  const now     = Number.isFinite(opts.now) ? opts.now : Date.now();
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
  const wanted  = Number.isFinite(opts.wanted) ? opts.wanted : WANTED_PER_ARTIST;
  const owned   = opts.ownedKeys instanceof Set ? opts.ownedKeys : new Set();
  const all     = Array.isArray(albums) ? albums : [];

  const inWindow = all.filter(a =>
    a && a.ts >= sinceMs && a.ts <= now &&
    !owns(owned, a) && !isReissue(a, all));

  /*
   * A standard and a deluxe pressing of one new album are ONE release, and
   * showing both reads as a bug. But two different albums can reduce to the
   * same base title too, and collapsing THOSE loses a record.
   *
   * THE SAME DISTINCTION isReissue MAKES, and it has to be made twice or the
   * second rule undoes the first: a bucket's PLAIN rows are different records
   * and all survive, while its edition rows are packagings of them and are
   * dropped as soon as any plain row is present. Sault's "Untitled (Black Is)"
   * and "Untitled (Rise)" are both plain, share a base, and both belong on the
   * screen — isReissue already refuses to call them reissues, and the first
   * version of this map then merged them anyway and kept the older one.
   *
   * With no plain row in the window (the original is older than the window, or
   * the record was only ever issued as an edition) the earliest edition row
   * stands in for it, because something is better than nothing there.
   */
  const buckets = new Map();
  for (const a of inWindow) {
    let b = buckets.get(a.baseKey);
    if (!b) { b = { plain: new Map(), editions: [] }; buckets.set(a.baseKey, b); }
    // Deezer lists the same record twice often enough to matter; identical
    // titles are one row whatever else is in the bucket.
    if (a.edition) b.editions.push(a);
    else if (!b.plain.has(titleKey(a.title))) b.plain.set(titleKey(a.title), a);
  }

  const out = [];
  for (const b of buckets.values()) {
    if (b.plain.size) { for (const a of b.plain.values()) out.push(a); continue; }
    if (b.editions.length) {
      out.push(b.editions.reduce((best, a) => (a.ts < best.ts ? a : best)));
    }
  }
  return out.sort((x, y) => y.ts - x.ts).slice(0, Math.max(0, wanted));
}

/*
 * Is this record already in the library?
 *
 * THE ARTIST IS PART OF THE QUESTION. The first version compared title keys
 * alone, so owning any record called "Greatest Hits" — or any "Untitled" —
 * suppressed every other act's, silently and for ever. A false negative here
 * is invisible: the row simply never appears, and nothing says why.
 *
 * `ownedKeys` is therefore SCOPED TO THIS ACT by the caller — the titles this
 * artist already has in the library, and nobody else's. That also puts the
 * decision about what counts as the same act where it belongs: index.js uses
 * the permissive rule the library resolver uses, so "Eno" finds "Brian Eno",
 * and this module never has to know what a library is.
 *
 * Both the reduced title and the full one are tried, because an owned
 * "Rumours" must suppress "Rumours (2026 Remaster)" and an owned
 * "Untitled (Rise)" must suppress a re-listing of itself.
 */
function owns(ownedKeys, album) {
  if (!ownedKeys || !ownedKeys.size) return false;
  for (const k of [album.baseKey, titleKey(album.title)]) {
    if (!k) continue;
    if (ownedKeys.has(k)) return true;
  }
  return false;
}

/**
 * The acts to ask about, best first, from rows of the plays table.
 *
 * Each row is { artist, ts }. The ranking is DISTINCT DAYS PLAYED and not the
 * number of plays, with recency breaking ties. One long evening with one
 * record would otherwise own the entire seed list — forty plays in a night is
 * an evening, while eight plays on eight different days is a habit, and a
 * habit is what predicts wanting the next record.
 *
 * `split` is injected rather than imported so the credit rule stays in one
 * place: index.js passes lib/share-links.js's primaryArtist, which knows that
 * "Hall & Oates" is one act and "A feat. B" is two.
 */
function playedArtists(rows, opts) {
  opts = opts || {};
  const split = typeof opts.split === "function" ? opts.split : (s => s);
  const limit = Number.isFinite(opts.limit) ? opts.limit : SEED_ARTISTS;
  const seen = new Map();   // key -> { name, days:Set, last }
  for (const r of rows || []) {
    if (!r) continue;
    const name = String(split(r.artist || "") || "").trim();
    if (!name) continue;
    const key = normalize(name);
    // "Various Artists" is a compilation's filing, never an act. It reaches
    // this table whenever Roon reports it as the track artist.
    if (!key || key === "various artists" || key === "various" || key === "va") continue;
    const ts = Number(r.ts) || 0;
    let e = seen.get(key);
    if (!e) { e = { name, days: new Set(), last: 0 }; seen.set(key, e); }
    e.days.add(Math.floor(ts / 86400000));
    if (ts > e.last) e.last = ts;
  }
  return [...seen.values()]
    .map(e => ({ name: e.name, days: e.days.size, last: e.last }))
    .sort((a, b) => (b.days - a.days) || (b.last - a.last))
    .slice(0, Math.max(0, limit));
}

module.exports = {
  WANTED_PER_ARTIST, SEED_ARTISTS, EDITION_WORDS,
  normalize, titleKey, stripEdition, yearOf, dateMs,
  readArtistAlbums, isReissue, owns, pickNewReleases, playedArtists,
};
