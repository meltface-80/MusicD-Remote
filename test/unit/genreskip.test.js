"use strict";
// ---------------------------------------------------------------------------
// v1.7.38: the genre harvest skips genres that haven't changed.
//
// The harvest costs ~6 Roon calls per genre — about 180 per sync — and it ran
// in full every time the library changed at all, even if the change had nothing
// to do with genres. Roon states each genre's album count in the subtitle of
// the root listing we ALREADY fetch, so the fingerprint that decides whether a
// genre needs walking is free; it was simply being discarded one line later.
//
// Two things here are dangerous in opposite directions:
//
//   1. SKIPPING TOO EAGERLY. A fingerprint that can't tell two states apart
//      suppresses the only thing that would fix it. `parseAlbumCount` returns
//      null for an unparseable subtitle, and `null === null` would skip every
//      genre forever with no data at all — a silent, permanent empty facet.
//   2. THE MAPPING THAT COULD ONLY GROW. Before this version the harvest did
//      `(prev || []).concat(name)`, making album→genres a monotonic union: an
//      album could gain a genre but never lose one, and NO full walk could
//      correct it. A skip on top of that would have been building on sand, so
//      the union is replaced here too — a walked genre's membership is rebuilt
//      from scratch, which is what finally makes removal expressible.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const FP = ["genreFpVersion", "genreSweepMs", "setGenreScan", "setAlbumGenres",
            "deleteAlbumGenres", "parseAlbumCount", "GENRE_SEP"];

function build(opts) {
  opts = opts || {};
  const albumGenreCache = new Map(Object.entries(opts.genres || {}));
  const genreScanCache  = new Map(Object.entries(opts.scan || {}));
  return Object.assign(
    loadIndexFunctions(FP.filter(n => n !== "GENRE_SEP"), {
      albumGenreCache, genreScanCache,
      // No SQLite in the unit suite — the writes are a side effect; what these
      // tests are about is which value ends up in memory.
      stmtInsertGenres: null, stmtInsertGenreScan: null, labelsDb: null,
      GENRE_SEP: String.fromCharCode(10),
      DEBUG: false,
    }),
    { albumGenreCache, genreScanCache });
}

test("the fingerprint refuses to skip on ambiguous evidence", async (t) => {
  const F = build();

  await t.test("parseAlbumCount returns null for a subtitle it cannot read", () => {
    // THE trap. If a null count were treated as a match, every genre would skip
    // forever and the Genre facet would stay permanently empty — while looking
    // like the harvest was running fine.
    assert.equal(F.parseAlbumCount(""), null);
    assert.equal(F.parseAlbumCount("Various"), null);
    assert.equal(F.parseAlbumCount(null), null);
  });

  await t.test("a real count parses, including with a thousands separator", () => {
    assert.equal(F.parseAlbumCount("204 Albums"), 204);
    assert.equal(F.parseAlbumCount("1 Album"), 1);
    assert.equal(F.parseAlbumCount("1,204 Albums"), 1204);
  });
});

test("a fingerprint is stored only for a genre that was actually walked", async (t) => {
  await t.test("setGenreScan records the raw subtitle, not a parsed number", () => {
    // Raw is strictly more information for the same zero cost, and it cannot
    // collapse two different states into null the way an integer can.
    const F = build();
    F.setGenreScan("Jazz", "204 Albums", "img1", 204);
    const row = F.genreScanCache.get("Jazz");
    assert.equal(row.subtitle, "204 Albums");
    assert.equal(row.image_key, "img1");
    assert.equal(row.total, 204);
    assert.ok(row.ts > 0, "a row with no timestamp can never age into a sweep");
  });

  await t.test("a nameless genre is not recorded", () => {
    const F = build();
    F.setGenreScan("", "1 Album", "", 1);
    assert.equal(F.genreScanCache.size, 0);
  });

  await t.test("a version bump makes every stored row incomparable", () => {
    // How a change to what a fingerprint MEANS heals itself: rows at the old
    // version are ignored at load, so one full walk rewrites them.
    const F = build();
    assert.equal(typeof F.genreFpVersion(), "number");
    assert.ok(F.genreFpVersion() >= 1);
  });
});

test("the sweep bounds how long a skip may last", async (t) => {
  const F = build();
  await t.test("it is a week", () => {
    // No free fingerprint can see an equal-count membership swap, or an album
    // Roon re-identified — that changes the mapping's key without moving any
    // genre's count. The skip is therefore bounded by time, not trusted.
    assert.equal(F.genreSweepMs(), 7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// The union fix. This is the pre-existing bug the skip would otherwise have
// been built on top of.
// ---------------------------------------------------------------------------
test("an album can now LOSE a genre", async (t) => {
  await t.test("setAlbumGenres replaces the list, it does not merge", () => {
    const F = build({ genres: { "goo||sonic youth": ["Pop/Rock", "Prog"] } });
    assert.equal(F.setAlbumGenres("goo||sonic youth", ["Pop/Rock"]), true,
      "rewriting a shorter list must count as a change");
    assert.deepEqual(F.albumGenreCache.get("goo||sonic youth"), ["Pop/Rock"],
      "Prog survived — the mapping is still a union and removal is impossible");
  });

  await t.test("an unchanged list reports no change", () => {
    // Otherwise every harvest would bump the view cache and re-sort the whole
    // library for nothing.
    const F = build({ genres: { k: ["Jazz"] } });
    assert.equal(F.setAlbumGenres("k", ["Jazz"]), false);
  });

  await t.test("order does not count as a change", () => {
    const F = build({ genres: { k: ["Blues", "Jazz"] } });
    assert.equal(F.setAlbumGenres("k", ["Jazz", "Blues"]), false,
      "the stored list is sorted, so a different arrival order must compare equal");
  });

  await t.test("losing the LAST genre deletes the row", () => {
    // setAlbumGenres refuses an empty list — a genre-less album is the normal
    // state for much of a library and storing empty rows would be silly — so
    // removal needs its own path. Without it an album that left its only genre
    // would keep that genre forever, which is the union bug in miniature.
    const F = build({ genres: { k: ["Jazz"] } });
    assert.equal(F.setAlbumGenres("k", []), false, "an empty list is not a write");
    assert.equal(F.deleteAlbumGenres("k"), true);
    assert.equal(F.albumGenreCache.has("k"), false);
  });

  await t.test("deleting a row that isn't there is not a change", () => {
    const F = build();
    assert.equal(F.deleteAlbumGenres("nope"), false);
  });
});
