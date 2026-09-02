"use strict";
// ---------------------------------------------------------------------------
// wfAlbumKey — which /music folder (if any) the playing album is.
//
// This is the lookup the waveform is built on, and getting it wrong does not
// produce "no waveform": it produces the WRONG album's shape under the track,
// which looks authoritative and is simply a different record.
//
// v1.8.4 added a title-only fallback here for the albums Roon names without an
// artist, and left out the guard that keeps it from firing when the artist IS
// usable. It shipped, and the very first dump caught it: Roon playing Alex G's
// "Rocket" from Qobuz, a Goldfrapp "Rocket" in the library, and the lookup
// handing back the Goldfrapp folder. These tests exist so that cannot recur.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

function fixture(dirs) {
  const localAlbumDirs = new Map(dirs || []);
  const F = loadIndexFunctions(
    ["wfAlbumKey", "albumKeys", "albumKey", "albumTitleVariants",
     "canonText", "canonArtist", "normalize"],
    { localAlbumDirs, AK: require("../../lib/albumkeys") }
  );
  return { ...F, localAlbumDirs };
}

test("the keyed match is used when it exists", () => {
  const f = fixture();
  const k = f.albumKey("Rocket", "Alex G");
  f.localAlbumDirs.set(k, "/music/Alex G/Rocket");
  assert.equal(f.wfAlbumKey("Rocket", "Alex G"), k);
});

test("THE regression: a usable artist never falls back to the title", () => {
  // The v1.8.4 defect, from the live dump. The library holds Goldfrapp's
  // "Rocket"; Roon is playing Alex G's from Qobuz and says so. Answering with
  // the Goldfrapp folder is worse than answering with nothing.
  const f = fixture([[ "rocket||goldfrapp", "/music/Goldfrapp/Rocket" ]]);
  assert.equal(f.wfAlbumKey("Rocket", "Alex G"), null,
    "a different artist's album of the same name was claimed as this one's file");
});

test("and the same holds when the local album is the streamed one's namesake", () => {
  // Mirror image: the local copy is the one with the artist we were given.
  const f = fixture([[ "rocket||alex g", "/music/Alex G/Rocket" ]]);
  assert.equal(f.wfAlbumKey("Rocket", "Goldfrapp"), null);
});

test("THE point of the fallback: no artist, and the album is in one folder", () => {
  // Roon sends three_line.line2 as "" for a real share of a library. Without
  // this rung those albums get no waveform at all, sitting in /music.
  const f = fixture([[ "blind man s zoo||10 000 maniacs", "/music/10,000 Maniacs/Blind Man's Zoo" ]]);
  assert.equal(f.wfAlbumKey("Blind Man's Zoo", ""), "blind man s zoo||10 000 maniacs");
});

test("several artist spellings of one folder is still that folder", () => {
  // The /music walk files a directory under its album-artist AND track-artist
  // tags on purpose, so two matching keys is the ordinary case.
  const dir = "/music/10,000 Maniacs/Blind Man's Zoo";
  const f = fixture([
    ["blind man s zoo||10 000 maniacs", dir],
    ["blind man s zoo||10", dir],
  ]);
  assert.ok(f.wfAlbumKey("Blind Man's Zoo", ""), "one folder under two names was refused");
  assert.equal(f.localAlbumDirs.get(f.wfAlbumKey("Blind Man's Zoo", "")), dir);
});

test("no artist and two different folders is refused", () => {
  const f = fixture([
    ["greatest hits||queen", "/music/Queen/Greatest Hits"],
    ["greatest hits||abba",  "/music/ABBA/Greatest Hits"],
  ]);
  assert.equal(f.wfAlbumKey("Greatest Hits", ""), null,
    "two albums sharing a title must not resolve to either");
});

test("an artist that canonicalises to nothing counts as no artist", () => {
  // "!!!" and friends normalise away entirely, so keying is impossible and the
  // fallback is the only thing that can answer.
  const f = fixture([[ "analogue||a ha", "/music/a-ha/Analogue" ]]);
  assert.ok(f.wfAlbumKey("Analogue", "!!!"),
    "an artist string that carries no letters or digits should not block the fallback");
});

test("nothing local, with or without an artist, is null rather than a throw", () => {
  const f = fixture();
  assert.equal(f.wfAlbumKey("Anything", "Anyone"), null);
  assert.equal(f.wfAlbumKey("Anything", ""), null);
  assert.equal(f.wfAlbumKey("", ""), null);
  assert.equal(f.wfAlbumKey(null, null), null);
});
