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

const { sanitizeLibView, smartPlaylistRecord, smartLimitDefault, smartLimitMax,
        libPlayedIds, libFacetDefs, libFacetChipMax, smartModes, smartModeDefault,
        smartOrders, smartOrderDefault } =
  loadIndexFunctions(
  // libSortIds/libPlayedIds/smartNameMax are extracted too, not injected — the
  // whole point is that the test reads the SHIPPING vocabulary.
  ["sanitizeLibView", "smartPlaylistRecord", "libSortIds", "libPlayedIds", "smartNameMax",
   "smartLimitDefault", "smartLimitMax", "smartLimitOptions",
   "smartModes", "smartModeDefault", "smartOrders", "smartOrderDefault",
   "libFacetDefs", "libFacetChipMax"]);

// Built FROM the shipping facet table, so a facet added to libFacetDefs() has
// to appear in every saved view — which is what stops a new facet from working
// on the Library screen and silently vanishing when the view is saved.
const FACET_IDS = libFacetDefs().map(f => f.id);
const DEFAULTS = Object.assign(
  { sort: "album", dir: "asc", seed: 1, played: "any" },
  Object.fromEntries(FACET_IDS.map(id => [id, []])));

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
    for (const p of libPlayedIds()) {
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

  await t.test("facet values survive as strings", () => {
    // v1.7.35 widened these from a fixed vocabulary to free text: genre and
    // label values are NAMES, which no list can enumerate. They are still
    // normalised to strings, because the query builder appends them verbatim.
    assert.deepEqual(sanitizeLibView({ decade: [1990, 2000] }).decade, ["1990", "2000"]);
    assert.deepEqual(sanitizeLibView({ decade: "1990" }).decade, ["1990"], "a bare value is a list of one");
    assert.deepEqual(sanitizeLibView({ genre: ["Jazz", "Pop/Rock"] }).genre, ["Jazz", "Pop/Rock"]);
    assert.deepEqual(sanitizeLibView({ label: ["Blue Note"] }).label, ["Blue Note"]);
  });

  await t.test("an excluded value keeps its ! and is not mistaken for junk", () => {
    // Roon's tap-again-to-invert is encoded in the value. Stripping it here
    // would silently turn "everything except Pop" into "only Pop".
    assert.deepEqual(sanitizeLibView({ genre: ["!Pop"] }).genre, ["!Pop"]);
    assert.deepEqual(sanitizeLibView({ decade: ["!1990"] }).decade, ["!1990"]);
  });

  await t.test("empty and whitespace-only facet values are dropped", () => {
    // An empty string appended to the query matches nothing, which reads as an
    // empty library rather than as a filter that was never really set.
    assert.deepEqual(sanitizeLibView({ genre: ["", "  ", null, undefined] }).genre, []);
  });

  await t.test("duplicates collapse in every facet", () => {
    // A duplicate would be harmless for filtering but shows twice in the
    // description, which looks like a bug in the saved playlist.
    for (const id of FACET_IDS) {
      assert.deepEqual(sanitizeLibView({ [id]: ["x", "x"] })[id], ["x"], id);
    }
  });

  await t.test("a runaway facet list is capped", () => {
    const many = Array.from({ length: 400 }, (_, i) => "s" + i);
    for (const id of FACET_IDS) {
      assert.equal(sanitizeLibView({ [id]: many })[id].length, libFacetChipMax(), id);
    }
  });

  await t.test("an absurdly long facet value is truncated, not stored whole", () => {
    assert.equal(sanitizeLibView({ genre: ["x".repeat(9000)] }).genre[0].length, 120);
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
      ["dir", "played", "seed", "sort"].concat(FACET_IDS).sort());
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

  // v1.7.27: how many albums the playlist actually delivers.
  await t.test("a playlist saved before limits existed takes the default", () => {
    // The important direction: every record already on disk lacks the field,
    // and must come back capped rather than unbounded. An uncapped legacy
    // playlist would still queue its whole library on the first tap.
    const r = smartPlaylistRecord({ id: "sp1", name: "Old one" });
    assert.equal(r.limit, smartLimitDefault());
  });

  await t.test("a stored limit is kept", () => {
    assert.equal(smartPlaylistRecord({ id: "sp1", name: "X", limit: 25 }).limit, 25);
    assert.equal(smartPlaylistRecord({ id: "sp1", name: "X", limit: "50" }).limit, 50,
      "a hand-edited settings.json holds strings");
  });

  await t.test("a limit past the play-time ceiling is clamped, not honoured", () => {
    // 400 albums is already ~3,200 Roon calls; nothing above it is playable.
    assert.equal(smartPlaylistRecord({ id: "sp1", name: "X", limit: 99999 }).limit,
                 smartLimitMax());
  });

  await t.test("a nonsense limit falls back to the default", () => {
    for (const bad of [0, -5, "many", null, {}, NaN]) {
      assert.equal(smartPlaylistRecord({ id: "sp1", name: "X", limit: bad }).limit,
                   smartLimitDefault(), `limit ${JSON.stringify(bad)} should have defaulted`);
    }
  });
});

// v1.7.36. The user built a Tracks playlist and got its tracks in album order,
// one record at a time. Both axes are now explicit and both are stored, because
// a playlist that forgets its order re-reads as the default the next time it is
// opened — which is exactly the complaint.
test("mode and order are stored, defaulted and validated", async (t) => {
  await t.test("a record saved before either existed takes the defaults", () => {
    const r = smartPlaylistRecord({ id: "sp1", name: "Old one" });
    assert.equal(r.mode, smartModeDefault());
    assert.equal(r.order, smartOrderDefault());
  });

  await t.test("every real mode and order survives", () => {
    for (const m of smartModes()) {
      assert.equal(smartPlaylistRecord({ id: "s", name: "n", mode: m }).mode, m);
    }
    for (const o of smartOrders()) {
      assert.equal(smartPlaylistRecord({ id: "s", name: "n", order: o }).order, o);
    }
  });

  await t.test("nonsense falls back rather than reaching the endpoints", () => {
    // The endpoints branch on these strings. An unrecognised value passed
    // through would take whichever branch its !== comparison happened to miss.
    for (const bad of ["", "Tracks", "shuffle", null, 7, {}]) {
      assert.equal(smartPlaylistRecord({ id: "s", name: "n", mode: bad }).mode, smartModeDefault());
      assert.equal(smartPlaylistRecord({ id: "s", name: "n", order: bad }).order, smartOrderDefault());
    }
  });

  await t.test("they are separate axes", () => {
    // Random applies to an Albums playlist too — it shuffles which albums and
    // what order they play in.
    const r = smartPlaylistRecord({ id: "s", name: "n", mode: "albums", order: "random" });
    assert.equal(r.mode, "albums");
    assert.equal(r.order, "random");
  });
});
