"use strict";
// ---------------------------------------------------------------------------
// v1.8.34: acts worth hearing next.
//
// Ported from MusicD Share Card (Similar.kt), Deezer half only — the original
// tries ListenBrainz first and its own note on that path reads "this has never
// once answered in the field", with an unverified dataset name in the query.
// Porting a path that has never worked would be porting the appearance of a
// feature.
//
// The rules that matter are all about NOT suggesting the wrong thing:
// a search that returns something is not evidence it returned this act, and a
// two-track single is not an answer to "what should I hear next".
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../../lib/similar");

test("the name guard runs on EVERY row, not just the first", () => {
  // Deezer answers "Sting" with tribute acts and covers bands. Taking row one
  // on trust suggests records by whoever happens to rank highest.
  const json = { data: [
    { id: 1, name: "Sting Tribute Band", nb_fan: 900000 },
    { id: 2, name: "The Stings",         nb_fan: 500 },
    { id: 3, name: "Sting",              nb_fan: 1200000 },
    { id: 4, name: "Stinger",            nb_fan: 10 },
  ] };
  const out = S.readDeezerArtists(json, "Sting");
  // "The Stings" and "Stinger" fail the whole-word guard outright.
  assert.ok(!out.some(c => /Stings|Stinger/.test(c.name)),
    "a name that merely looks similar got through: " + JSON.stringify(out.map(c => c.name)));
  // "Sting Tribute Band" DOES pass it — namesOverlap is whole-word containment
  // in either direction, because it also has to call "Prince" and "Prince &
  // The Revolution" the same act. So the ordering is what protects the row,
  // and an exact name must come first even when the tribute act is followed
  // more. The original sorted on followers alone.
  assert.equal(out[0].name, "Sting",
    "the exact name must be tried first, not whoever has the most followers: " +
    JSON.stringify(out.map(c => c.name)));
  assert.equal(out[0].exact, true);
});

test("an exact name outranks a better-followed partial one", () => {
  const out = S.readDeezerArtists({ data: [
    { id: 1, name: "Sting Tribute Band", nb_fan: 99999999 },
    { id: 2, name: "Sting",              nb_fan: 1 },
  ] }, "Sting");
  assert.equal(out[0].name, "Sting",
    "a tribute act with more followers was going to be asked for related acts " +
    "first, and the whole row would have been about the wrong artist");
});

test("fans are the tie-break, never the filter", () => {
  const json = { data: [
    { id: 1, name: "Nirvana", nb_fan: 100 },      // the 60s UK Nirvana
    { id: 2, name: "Nirvana", nb_fan: 9000000 },
  ] };
  const out = S.readDeezerArtists(json, "Nirvana");
  assert.equal(out.length, 2, "both are legitimately named Nirvana");
  assert.equal(out[0].id, "2", "the more-followed act should be tried first");
  // …but a huge following never promotes a name that does not match.
  const wrong = S.readDeezerArtists(
    { data: [{ id: 9, name: "Completely Different", nb_fan: 50000000 }] }, "Nirvana");
  assert.deepEqual(wrong, []);
});

test("'The' is discounted, so the same act is still the same act", () => {
  assert.ok(S.namesOverlap("The Beatles", "Beatles"));
  assert.ok(S.namesOverlap("Beatles", "The Beatles"));
  assert.ok(!S.namesOverlap("The Beatles", "The Rutles"));
});

test("a suggestion is a full ALBUM, and the earliest one", () => {
  // Not the newest (whatever they happened to put out) and not the most
  // popular (usually a compilation). A debut answers "start here".
  const json = { data: [
    { record_type: "single", title: "A Single",   release_date: "1990-01-01" },
    { record_type: "album",  title: "Third",      release_date: "2005-03-02" },
    { record_type: "ep",     title: "An EP",      release_date: "1991-01-01" },
    { record_type: "album",  title: "The Debut",  release_date: "1994-06-01", cover_medium: "c.jpg" },
    { record_type: "album",  title: "Second",     release_date: "1999-01-01" },
  ] };
  const best = S.readDeezerAlbums(json);
  assert.equal(best.title, "The Debut");
  assert.equal(best.year, 1994);
  assert.equal(best.cover, "c.jpg");
});

test("an album with no usable date is not the earliest by default", () => {
  // Deezer writes 0000-00-00 for "we do not know". Treating that as year zero
  // would make every unknown date win.
  const json = { data: [
    { record_type: "album", title: "Unknown date", release_date: "0000-00-00" },
    { record_type: "album", title: "Real",         release_date: "2001-05-05" },
  ] };
  assert.equal(S.readDeezerAlbums(json).title, "Real");
  assert.equal(S.yearOf("0000-00-00"), null);
  assert.equal(S.yearOf(""), null);
  assert.equal(S.yearOf(null), null);
  assert.equal(S.yearOf("not a date"), null);
  assert.equal(S.yearOf("1977-01-01"), 1977);
  // A year past next year is a catalogue typo, not a record to recommend.
  assert.equal(S.yearOf((new Date().getFullYear() + 5) + "-01-01"), null);
});

test("related acts are capped, de-duplicated, and keep Deezer's order", () => {
  const json = { data: [
    { id: 1, name: "One" }, { id: 1, name: "One again" },
    { id: 2, name: "Two" }, { id: 3, name: "Three" }, { id: 4, name: "Four" },
  ] };
  const out = S.readDeezerRelated(json);
  assert.deepEqual(out.map(a => a.name), ["One", "Two", "Three"]);
});

test("an act with no nameable record still appears", () => {
  // The row degrades to names rather than losing a suggestion.
  const act = S.toAct({ id: "7", name: "Somebody", picture: "p.jpg" },
                      { title: null, year: null, cover: null });
  assert.equal(act.name, "Somebody");
  assert.equal(act.album, null);
  assert.equal(act.cover, "p.jpg", "the act's own picture is the fallback");
});

test("malformed answers are empty, never a throw", () => {
  for (const junk of [null, undefined, {}, { data: null }, { data: "nope" },
                      { data: [null, undefined, {}] }]) {
    assert.deepEqual(S.readDeezerArtists(junk, "X"), []);
    assert.deepEqual(S.readDeezerRelated(junk), []);
    assert.deepEqual(S.readDeezerAlbums(junk), { title: null, year: null, cover: null });
  }
});

test("namesOverlap agrees with index.js's, over one battery", () => {
  // A copy, for the same reason lib/wiki-match.js carries one; checked rather
  // than described as matching.
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");
  const norm = /\nfunction normalize\(s\) \{[\s\S]*?\n\}/.exec(src);
  const over = /\nfunction namesOverlap\(a, b\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(norm && over, "could not lift normalize/namesOverlap out of index.js");
  const theirs = new Function(norm[0] + over[0] + "\nreturn namesOverlap;")();

  const pairs = [
    ["Sting", "Sting Tribute Band"], ["The Beatles", "Beatles"],
    ["AC/DC", "ACDC"], ["Mötley Crüe", "Motley Crue"], ["Sting", "Stinger"],
    ["", "Sting"], ["Nirvana", "Nirvana"], ["The The", "The"],
    ["Hall & Oates", "Hall and Oates"], ["Beyoncé", "Beyonce"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(S.namesOverlap(a, b), theirs(a, b),
      "the two namesOverlap implementations disagree on " + JSON.stringify([a, b]));
  }
});
