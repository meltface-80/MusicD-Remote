"use strict";
// ---------------------------------------------------------------------------
// v1.7.8: smart playlists — named, saved library views.
//
// A smart playlist is a saved `libraryView` query, re-evaluated on open. The
// dangerous part isn't the saving, it's the LOADING: settings.json is a plain
// file on the data volume that can be hand-edited, half-written, or carried
// over from an older version. A view that survives sanitising with a bogus
// field doesn't error — it quietly returns the whole library, or nothing, and
// the user just sees a smart playlist that "doesn't work".
//
// So these tests are about the sanitiser refusing to pass anything through that
// libraryView() wouldn't itself accept, and about a corrupt record being
// dropped rather than taking the whole list down with it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const { sanitizeLibView, smartPlaylistRecord } = loadIndexFunctions(
  // libSortIds/libPlayedIds/smartNameMax are extracted too, not injected — the
  // whole point is that the test reads the SHIPPING vocabulary.
  ["sanitizeLibView", "smartPlaylistRecord", "libSortIds", "libPlayedIds", "smartNameMax"]);

const DEFAULTS = { sort: "album", dir: "asc", seed: 1, decade: [], source: [], played: "any" };

test("sanitizeLibView accepts only what libraryView accepts", async (t) => {
  await t.test("an empty or absent view becomes the default", () => {
    assert.deepEqual(sanitizeLibView(undefined), DEFAULTS);
    assert.deepEqual(sanitizeLibView(null), DEFAULTS);
    assert.deepEqual(sanitizeLibView({}), DEFAULTS);
    assert.deepEqual(sanitizeLibView("nope"), DEFAULTS);
  });

  await t.test("every real sort survives", () => {
    for (const s of ["album", "artist", "year", "plays", "lastplayed", "random"]) {
      assert.equal(sanitizeLibView({ sort: s }).sort, s);
    }
  });

  await t.test("an unknown sort falls back rather than reaching libraryView", () => {
    // libraryView would itself fall back, but then the SAVED playlist and the
    // view it produces disagree — the picker would describe a sort the results
    // don't use.
    for (const s of ["", "Album", "title", null, 7, {}]) {
      assert.equal(sanitizeLibView({ sort: s }).sort, "album");
    }
  });

  await t.test("dir is exactly asc or desc", () => {
    assert.equal(sanitizeLibView({ dir: "desc" }).dir, "desc");
    for (const d of ["asc", "", "DESC", "down", null, 1]) {
      assert.equal(sanitizeLibView({ dir: d }).dir, "asc");
    }
  });

  await t.test("played is one of the offered windows", () => {
    for (const p of ["any", "never", "6", "12"]) {
      assert.equal(sanitizeLibView({ played: p }).played, p);
    }
    for (const p of ["3", "24", "sometimes", "", null, {}]) {
      assert.equal(sanitizeLibView({ played: p }).played, "any",
        `played ${JSON.stringify(p)} should fall back to any`);
    }
    // A numeric 6 is the 6-month window, not junk — a JSON round-trip or a
    // hand-edited file can easily produce one, and coercing it is the right
    // answer rather than silently dropping the user's filter.
    assert.equal(sanitizeLibView({ played: 6 }).played, "6");
    assert.equal(sanitizeLibView({ played: 12 }).played, "12");
  });

  await t.test("decades must be real decade numbers", () => {
    assert.deepEqual(sanitizeLibView({ decade: [1990, 2000] }).decade, [1990, 2000]);
    assert.deepEqual(sanitizeLibView({ decade: "1990" }).decade, [1990], "a bare value is a list of one");
    // 1995 isn't a decade; 90 and 12000 aren't years. Passing any of them makes
    // the filter match nothing, which reads as an empty library.
    assert.deepEqual(sanitizeLibView({ decade: [1995, 90, 12000, "x", null] }).decade, []);
  });

  await t.test("duplicate decades and sources collapse", () => {
    // A duplicate would be harmless for filtering but shows twice in the
    // description, which looks like a bug in the saved playlist.
    assert.deepEqual(sanitizeLibView({ decade: [1990, 1990] }).decade, [1990]);
    assert.deepEqual(sanitizeLibView({ source: ["qobuz", "qobuz"] }).source, ["qobuz"]);
  });

  await t.test("a runaway source list is capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => "s" + i);
    assert.equal(sanitizeLibView({ source: many }).source.length, 12);
  });

  await t.test("seed is a positive integer", () => {
    assert.equal(sanitizeLibView({ seed: 42 }).seed, 42);
    for (const s of [0, -1, "abc", null, undefined, 1.5e-9]) {
      assert.equal(sanitizeLibView({ seed: s }).seed, 1,
        `seed ${JSON.stringify(s)} should fall back to 1`);
    }
  });

  await t.test("the result never carries extra keys through", () => {
    // An unknown key reaching the query string is how a saved view could smuggle
    // a parameter libraryView never validated.
    const out = sanitizeLibView({ sort: "album", evil: "1", offset: 999, count: 9999 });
    assert.deepEqual(Object.keys(out).sort(),
      ["decade", "dir", "played", "seed", "sort", "source"]);
  });
});

test("smartPlaylistRecord drops what it cannot salvage", async (t) => {
  await t.test("a good record is normalised, not rejected", () => {
    const r = smartPlaylistRecord({ id: "sp1", name: "  Late Night  ", view: { sort: "year", dir: "desc" } });
    assert.equal(r.id, "sp1");
    assert.equal(r.name, "Late Night", "the name is trimmed");
    assert.equal(r.view.sort, "year");
    assert.equal(r.view.dir, "desc");
  });

  await t.test("a record with no name or no id is dropped", () => {
    // Dropped, not defaulted: a nameless row in the picker is untappable and a
    // record with no id can never be deleted.
    assert.equal(smartPlaylistRecord({ id: "sp1", name: "   " }), null);
    assert.equal(smartPlaylistRecord({ name: "No id" }), null);
    assert.equal(smartPlaylistRecord({}), null);
    assert.equal(smartPlaylistRecord(null), null);
    assert.equal(smartPlaylistRecord("string"), null);
  });

  await t.test("a missing view becomes the default instead of dropping the record", () => {
    // The name is the user's work; a lost view is recoverable by re-saving.
    const r = smartPlaylistRecord({ id: "sp1", name: "Keeps its name" });
    assert.deepEqual(r.view, DEFAULTS);
  });

  await t.test("an over-long name is truncated, not rejected", () => {
    const r = smartPlaylistRecord({ id: "sp1", name: "x".repeat(500) });
    assert.equal(r.name.length, 60);
  });
});
