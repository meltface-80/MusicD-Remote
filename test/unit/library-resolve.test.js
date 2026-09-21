"use strict";
// ---------------------------------------------------------------------------
// v1.8.35: matching a suggested record to the Roon library.
//
// This answer becomes a QUEUE. Getting it wrong does not show the wrong text —
// it plays the wrong record, which is the one failure a suggestion row must
// not have. So the title is matched STRICTLY (exact once normalised) and the
// artist FORGIVINGLY ("Eno" has to find "Brian Eno", and an edition credited
// to the band rather than the frontman is the same album).
//
// resolveLibraryAlbum lives in index.js, which cannot be required without a
// Core. The function is lifted out of the source and run against fixtures —
// so what is pinned is the RULE, which is the part that decides what plays.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");

function lift(albums) {
  const norm  = /\nfunction normalize\(s\) \{[\s\S]*?\n\}/.exec(SRC);
  const over  = /\nfunction namesOverlap\(a, b\) \{[\s\S]*?\n\}/.exec(SRC);
  const key   = /\nfunction albumTitleKey\(s\) \{[\s\S]*?\n\}/.exec(SRC);
  const resol = /\nfunction resolveLibraryAlbum\(title, artist\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(norm && over && key && resol, "could not lift the resolver out of index.js");
  const make = new Function("albumIndex",
    norm[0] + over[0] + key[0] + resol[0] + "\nreturn resolveLibraryAlbum;");
  return make({ albums: albums.slice() });
}

const LIB = [
  { offset: 1, title: "Here Come the Warm Jets", subtitle: "Brian Eno", artistNames: ["Brian Eno"] },
  { offset: 2, title: "The Idiot",               subtitle: "Iggy Pop",  artistNames: ["Iggy Pop"] },
  { offset: 3, title: "Rocket",                  subtitle: "Goldfrapp", artistNames: ["Goldfrapp"] },
  { offset: 4, title: "Rocket",                  subtitle: "Alex G",    artistNames: ["Alex G"] },
  { offset: 5, title: "Low",                     subtitle: "David Bowie", artistNames: ["David Bowie"] },
  { offset: 6, title: "Low",                     subtitle: "David Bowie", artistNames: ["David Bowie"] }, // an edition
];

test("an exact title with the right artist resolves", () => {
  const r = lift(LIB);
  assert.equal(r("Here Come the Warm Jets", "Brian Eno").offset, 1);
  assert.equal(r("The Idiot", "Iggy Pop").offset, 2);
});

test("the title must match, not merely contain", () => {
  // The whole reason the title half is strict: "Low" must not find
  // "Low Estate", and a suggestion for a record nobody has must say so.
  const r = lift(LIB);
  assert.equal(r("Warm Jets", "Brian Eno"), null);
  assert.equal(r("Here Come the Warm Jets Deluxe", "Brian Eno"), null);
  assert.equal(r("The Idiots", "Iggy Pop"), null);
});

test("punctuation and case do not matter, because Deezer's are not Roon's", () => {
  // THE ONE THAT NEARLY SHIPPED WRONG. normalize() turns a run of
  // non-alphanumerics into one SPACE, so Roon's "Pepper's" is "pepper s" and
  // Deezer's "Peppers" is "peppers" — not equal. Every apostrophe in the
  // library was a missed match, and a missed match sends a record you own out
  // to a streaming service.
  const r = lift([{ offset: 9, title: "Sgt. Pepper's Lonely Hearts Club Band",
                    subtitle: "The Beatles", artistNames: ["The Beatles"] }]);
  assert.ok(r("sgt peppers lonely hearts club band", "Beatles"),
    "an apostrophe the other catalogue does not write cost a match");
  assert.equal(r("sgt peppers lonely hearts club band", "Beatles").offset, 9);
  assert.equal(r("SGT. PEPPER'S LONELY HEARTS CLUB BAND", "The Beatles").offset, 9);
  assert.equal(r("Sgt Peppers Lonely Hearts Club Band", "The Beatles").offset, 9);
});

test("the two spellings of an ampersand are the same record", () => {
  const r = lift([{ offset: 11, title: "Rock & Roll Animal",
                    subtitle: "Lou Reed", artistNames: ["Lou Reed"] }]);
  assert.equal(r("Rock and Roll Animal", "Lou Reed").offset, 11);
  assert.equal(r("Rock & Roll Animal", "Lou Reed").offset, 11);
});

test("the artist separates two records that share a title", () => {
  // The case index.js already records as a real one: Roon plays Alex G's
  // "Rocket" while the library holds Goldfrapp's.
  const r = lift(LIB);
  assert.equal(r("Rocket", "Goldfrapp").offset, 3);
  assert.equal(r("Rocket", "Alex G").offset, 4);
});

test("a shared title with NO artist to separate it is not an answer", () => {
  const r = lift(LIB);
  assert.equal(r("Rocket", ""), null,
    "two different records share that title — queueing either would be a guess");
  assert.equal(r("Rocket", null), null);
});

test("a title that is unique needs no artist", () => {
  const r = lift(LIB);
  assert.equal(r("The Idiot", "").offset, 2);
});

test("the artist match is forgiving, which is the half that has to be", () => {
  const r = lift(LIB);
  // Deezer says "Eno", Roon says "Brian Eno".
  assert.equal(r("Here Come the Warm Jets", "Eno").offset, 1);
  // …but not so forgiving that a different act wins.
  assert.equal(r("Rocket", "Nobody At All"), null);
});

test("several editions of the same record all answer, and the first will do", () => {
  const r = lift(LIB);
  const hit = r("Low", "David Bowie");
  assert.ok(hit && [5, 6].includes(hit.offset));
});

test("an empty library, or an empty title, resolves to nothing", () => {
  assert.equal(lift([])("Low", "David Bowie"), null);
  const r = lift(LIB);
  assert.equal(r("", "David Bowie"), null);
  assert.equal(r(null, "David Bowie"), null);
  assert.equal(r("   ", "David Bowie"), null);
});
