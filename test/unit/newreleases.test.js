"use strict";
// ---------------------------------------------------------------------------
// v1.8.37: what came out recently by the acts you actually listen to.
//
// Deezer's artist listing carries the date of THE EDITION and no original
// release date, so "released this month" and "is a new record" are different
// claims and the gap between them is where this feature fails. A remaster
// presented as new is not a near miss — the row's whole promise is that these
// are records you have not heard.
//
// Nearly every test below is therefore about NOT showing something.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const NR = require("../../lib/newreleases");

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);          // 2026-09-21
const SINCE = NOW - 60 * DAY;

function album(title, date, extra) {
  return Object.assign({ title, release_date: date, record_type: "album",
                         id: title.length, cover_medium: "c.jpg" }, extra || {});
}
function listing(...rows) { return NR.readArtistAlbums({ data: rows }); }

// ---------------------------------------------------------------------------
// Reading the listing
// ---------------------------------------------------------------------------

test("the cover is taken from whichever field Deezer filled in", () => {
  // Nothing in this codebase had ever DRAWN a Deezer cover before v1.8.39, so
  // an always-null field would have gone unnoticed since v1.8.34. The list is
  // wide rather than clever.
  assert.equal(NR.coverOf({ cover_medium: "m", cover: "c" }), "m");
  assert.equal(NR.coverOf({ cover_big: "b", cover: "c" }), "b");
  assert.equal(NR.coverOf({ cover: "c" }), "c");
});

test("with no named cover, one is built from md5_image", () => {
  // Last resort, and safe BECAUSE it is last: if the pattern is wrong the
  // image fails to load and the row keeps the empty tile it would have had
  // with no cover at all. It can only turn "no cover" into "no cover".
  const url = NR.coverOf({ md5_image: "abc123" });
  // The host is the one Deezer actually serves, taken from a real
  // /api/discover response rather than from memory — v1.8.39 guessed
  // "e-cdns-images" and had the path shape right and the host wrong.
  assert.match(url, /^https:\/\/cdn-images\.dzcdn\.net\/images\/cover\/abc123\//);
  assert.equal(NR.coverOf({}), null);
});

test("a cover field never overrides a real one with the built URL", () => {
  assert.equal(NR.coverOf({ cover_medium: "m", md5_image: "abc" }), "m");
});

test("singles and EPs are not new records", () => {
  const out = listing(
    album("Real Album", "2026-09-01"),
    album("A Single",   "2026-09-05", { record_type: "single" }),
    album("An EP",      "2026-09-06", { record_type: "ep" }));
  assert.deepEqual(out.map(a => a.title), ["Real Album"]);
});

test("an EP-length release is not an album, when Deezer says how long it is", () => {
  // Singles and EPs were reported on a screen that already filtered for
  // record_type === "album". The track count is the belt to that braces, and
  // it is only consulted when Deezer actually sends one.
  const out = listing(
    album("Proper Record", "2026-09-01", { nb_tracks: 11 }),
    album("Four Tracker",  "2026-09-02", { nb_tracks: 4 }),
    album("Unstated",      "2026-09-03"));
  assert.deepEqual(out.map(a => a.title).sort(), ["Proper Record", "Unstated"],
    "a row with no track count must not be rejected for a field it does not have");
});

test("classify names the rule that rejected a row", () => {
  // The build and the debug endpoint both call this, so the probe can never
  // describe a decision the screen did not make.
  assert.equal(NR.classify({ record_type: "single", title: "x", release_date: "2026-01-01" }).reason,
    "record_type is single");
  assert.equal(NR.classify({ title: "x", release_date: "2026-01-01" }).reason,
    "record_type is missing");
  assert.match(NR.classify({ record_type: "album", nb_tracks: 2, title: "x",
                             release_date: "2026-01-01" }).reason, /2 tracks/);
  assert.match(NR.classify({ record_type: "album", title: "x",
                             release_date: "0000-00-00" }).reason, /release_date/);
  assert.equal(NR.classify({ record_type: "album", title: "x",
                             release_date: "2026-01-01" }).ok, true);
});

test("a row with no usable date is dropped, not dated today", () => {
  // Deezer writes 0000-00-00 for "we do not know". Treating that as now would
  // put the act's entire unknown-date back catalogue on a screen headed "new".
  const out = listing(
    album("Known",   "2026-09-01"),
    album("Unknown", "0000-00-00"),
    album("Blank",   ""),
    album("Partial", "2026"));
  assert.deepEqual(out.map(a => a.title), ["Known"]);
});

test("a date-only string is read as the date it says, west of Greenwich too", () => {
  // Parsed at UTC noon: midnight UTC is the previous day in every negative
  // offset, and a release would read as a day early on a US server.
  assert.equal(new Date(NR.dateMs("2026-09-01")).getUTCDate(), 1);
  assert.ok(NR.dateMs("2026-09-01") - Date.UTC(2026, 8, 1) >= 11 * 3600000);
});

test("the listing comes back newest first", () => {
  const out = listing(album("Old", "2020-01-01"), album("New", "2026-09-01"),
                      album("Mid", "2023-05-05"));
  assert.deepEqual(out.map(a => a.title), ["New", "Mid", "Old"]);
});

// ---------------------------------------------------------------------------
// stripEdition — one half of the reissue rule
// ---------------------------------------------------------------------------

test("a trailing edition bracket is stripped and flagged", () => {
  assert.deepEqual(NR.stripEdition("Rumours (2021 Remaster)"),
    { base: "Rumours", edition: true });
  assert.deepEqual(NR.stripEdition("Rumours (Deluxe Edition) (Remastered)"),
    { base: "Rumours", edition: true });
});

test("a dash tail is stripped ONLY when it names an edition", () => {
  // " - " belongs to real titles, and removing it blind renames the record.
  assert.deepEqual(NR.stripEdition("Rumours - 2021 Remaster"),
    { base: "Rumours", edition: true });
  assert.deepEqual(NR.stripEdition("Sgt. Pepper - Reprise"),
    { base: "Sgt. Pepper - Reprise", edition: false });
});

test("a bracket that is not an edition reduces the title but is not flagged", () => {
  // This distinction is the whole reason `edition` is a separate field from
  // the reduction: Sault's two 2020 albums reduce to the same base and neither
  // is an edition of anything.
  assert.deepEqual(NR.stripEdition("Untitled (Black Is)"),
    { base: "Untitled", edition: false });
});

test("a title that is nothing but brackets keeps its name", () => {
  // Sigur Rós's "( )". Stripping to empty leaves a record with no title.
  assert.equal(NR.stripEdition("( )").base, "( )");
  assert.equal(NR.stripEdition("()").base, "()");
});

// ---------------------------------------------------------------------------
// isReissue — the conjunction, and both halves of it
// ---------------------------------------------------------------------------

test("a remaster of a record the act already released is a reissue", () => {
  const all = listing(album("Rumours (2021 Remaster)", "2026-09-01"),
                      album("Rumours", "1977-02-04"));
  assert.equal(NR.isReissue(all[0], all), true);
});

test("an edition name ALONE is not a reissue", () => {
  // The deluxe pressing of a record released last week is new.
  const all = listing(album("Brand New (Deluxe Edition)", "2026-09-01"));
  assert.equal(NR.isReissue(all[0], all), false);
});

test("a shared base title ALONE is not a reissue", () => {
  // Sault, 2020: "Untitled (Rise)" in June, "Untitled (Black Is)" in
  // September. Same act, same reduced title, two different albums. A rule
  // that acted on the reduction alone would throw the later one away.
  const all = listing(album("Untitled (Black Is)", "2026-09-01"),
                      album("Untitled (Rise)",     "2026-06-01"));
  assert.equal(NR.isReissue(all[0], all), false);
});

test("an identically dated pair is not evidence either way", () => {
  // `older` is compared by date, not by position in a date-sorted list.
  const all = listing(album("Record (Remastered)", "2026-09-01"),
                      album("Record",              "2026-09-01"));
  assert.equal(NR.isReissue(all[0], all), false);
});

// ---------------------------------------------------------------------------
// pickNewReleases
// ---------------------------------------------------------------------------

test("a record released after today is not a discovery", () => {
  // Deezer carries announced records. An album nobody can play yet is a
  // disappointment, and Roon will not have it either.
  const out = NR.pickNewReleases(
    listing(album("Announced", "2026-12-01"), album("Out Now", "2026-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["Out Now"]);
});

test("a record outside the window is not new", () => {
  const out = NR.pickNewReleases(
    listing(album("Recent", "2026-09-01"), album("Last Year", "2025-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["Recent"]);
});

test("a record already in the library is never offered", () => {
  // This is also what catches the reissues isReissue cannot see: one whose
  // original Deezer no longer lists still matches what you own.
  const owned = new Set([NR.titleKey("Rumours")]);
  const out = NR.pickNewReleases(
    listing(album("Rumours (2026 Remaster)", "2026-09-01"),
            album("Tusk",                    "2026-09-02")),
    { now: NOW, sinceMs: SINCE, ownedKeys: owned });
  assert.deepEqual(out.map(a => a.title), ["Tusk"]);
});

test("the owned check is blind to the punctuation two catalogues disagree about", () => {
  // v1.8.35's apostrophe bug, one layer along: Roon writes "Sgt. Pepper's",
  // Deezer writes "Sgt. Peppers", and a missed match recommends a record the
  // user already owns.
  const owned = new Set([NR.titleKey("Sgt. Pepper's Lonely Hearts Club Band")]);
  const out = NR.pickNewReleases(
    listing(album("Sgt. Peppers Lonely Hearts Club Band", "2026-09-01")),
    { now: NOW, sinceMs: SINCE, ownedKeys: owned });
  assert.deepEqual(out, []);
});

test("a remaster is dropped even when you do NOT own the original", () => {
  // The owned check catches most reissues, so it is easy to believe this rule
  // is doing work it is not. Here the act's 1977 record is not in the library
  // at all: only isReissue stands between its 2026 remaster and a screen that
  // says "new".
  const out = NR.pickNewReleases(
    listing(album("Rumours (2021 Remaster)", "2026-09-01"),
            album("Rumours",                 "1977-02-04"),
            album("Something Else",          "2026-09-02")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["Something Else"]);
});

test("a standard and a deluxe pressing released the SAME day are one release", () => {
  // Same day, so isReissue cannot help (it needs a strictly older record) and
  // the dedup preference is the only thing choosing between them.
  const out = NR.pickNewReleases(
    listing(album("New Record (Deluxe Edition)", "2026-09-01"),
            album("New Record",                  "2026-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["New Record"],
    "the plain edition is the record; the other is a packaging of it");
});

test("a standard and a deluxe pressing of one new album are one release", () => {
  const out = NR.pickNewReleases(
    listing(album("New Record (Deluxe Edition)", "2026-09-03"),
            album("New Record",                  "2026-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["New Record"],
    "the plain edition is the record; the other is a packaging of it");
});

test("two different albums that reduce to the same base BOTH survive", () => {
  // The bug a review found in the first version of this function: isReissue
  // correctly refuses to call Sault's two 2020 albums editions of each other,
  // and then the dedup map merged them anyway and kept the OLDER one — so the
  // newer record was silently dropped. The distinction has to be made twice,
  // or the second rule undoes the first.
  const out = NR.pickNewReleases(
    listing(album("Untitled (Black Is)", "2026-09-01"),
            album("Untitled (Rise)",     "2026-08-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["Untitled (Black Is)", "Untitled (Rise)"]);
});

test("the same record listed twice is still one row", () => {
  const out = NR.pickNewReleases(
    listing(album("New Record", "2026-09-01"), album("New Record", "2026-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.equal(out.length, 1);
});

test("an edition with no plain pressing in the window still stands in", () => {
  // The original is older than the window, so dropping every edition row would
  // mean showing nothing at all for a record that really was just reissued and
  // really is not in the library.
  const out = NR.pickNewReleases(
    listing(album("Old One (Deluxe Edition)", "2026-09-01")),
    { now: NOW, sinceMs: SINCE });
  assert.deepEqual(out.map(a => a.title), ["Old One (Deluxe Edition)"]);
});

test("the owned set is the ACT's titles, not every title in the library", () => {
  // Compared on title alone, owning any record called "Greatest Hits" — or any
  // "Untitled" — suppressed every other act's for ever, invisibly. The caller
  // scopes the set; owns() tries the reduced title and the full one.
  const mine = new Set([NR.titleKey("Rumours")]);
  assert.equal(NR.owns(mine, { baseKey: NR.titleKey("Rumours"),
                               title: "Rumours (2026 Remaster)" }), true);
  assert.equal(NR.owns(mine, { baseKey: NR.titleKey("Tusk"), title: "Tusk" }), false);
  assert.equal(NR.owns(new Set(), { baseKey: "x", title: "x" }), false);
});

test("one act cannot fill the screen", () => {
  const out = NR.pickNewReleases(
    listing(album("One", "2026-09-01"), album("Two", "2026-08-01"),
            album("Three", "2026-07-25")),
    { now: NOW, sinceMs: SINCE, wanted: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.title), ["One", "Two"], "newest first");
});

// ---------------------------------------------------------------------------
// playedArtists — the seed
// ---------------------------------------------------------------------------

const splitFirst = s => String(s).split(/\s+feat\.\s+/i)[0];

test("distinct DAYS rank an act, not the number of plays", () => {
  // Forty plays in one night is an evening. Eight plays on eight days is a
  // habit, and a habit is what predicts wanting the next record.
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ artist: "One Night", ts: NOW + i * 60000 });
  for (let d = 0; d < 8; d++)  rows.push({ artist: "Every Week", ts: NOW - d * DAY });
  const out = NR.playedArtists(rows, { split: splitFirst });
  assert.equal(out[0].name, "Every Week");
  assert.equal(out[0].days, 8);
  assert.equal(out[1].days, 1);
});

test("recency breaks a tie on days", () => {
  const out = NR.playedArtists([
    { artist: "Older", ts: NOW - 10 * DAY },
    { artist: "Newer", ts: NOW },
  ], { split: splitFirst });
  assert.deepEqual(out.map(a => a.name), ["Newer", "Older"]);
});

test("Various Artists is a filing, never an act", () => {
  const out = NR.playedArtists([
    { artist: "Various Artists", ts: NOW }, { artist: "Various", ts: NOW },
    { artist: "VA", ts: NOW }, { artist: "Real Act", ts: NOW },
  ], { split: splitFirst });
  assert.deepEqual(out.map(a => a.name), ["Real Act"]);
});

test("the credit rule is injected, not reimplemented", () => {
  // index.js passes lib/share-links.js's primaryArtist so the rule that knows
  // "Hall & Oates" is one act lives in exactly one place.
  const shareLinks = require("../../lib/share-links");
  const out = NR.playedArtists([
    { artist: "Hall & Oates", ts: NOW },
    { artist: "Artist A feat. Artist B", ts: NOW - DAY },
  ], { split: shareLinks.primaryArtist });
  const names = out.map(a => a.name);
  assert.ok(names.includes("Hall & Oates"), "an ampersand band was split: " + names);
  assert.ok(names.includes("Artist A") && !names.includes("Artist B"),
    "a featured credit was not reduced to the lead: " + names);
});

test("one act counted under two spellings is one seed", () => {
  const out = NR.playedArtists([
    { artist: "Sigur Rós", ts: NOW }, { artist: "Sigur Ros", ts: NOW - DAY },
  ], { split: splitFirst });
  assert.equal(out.length, 1);
  assert.equal(out[0].days, 2);
});

test("an empty or missing artist never becomes a seed", () => {
  const out = NR.playedArtists([
    { artist: "", ts: NOW }, { artist: null, ts: NOW }, {}, null,
    { artist: "   ", ts: NOW }, { artist: "Good", ts: NOW },
  ], { split: splitFirst });
  assert.deepEqual(out.map(a => a.name), ["Good"]);
});
