"use strict";
// ---------------------------------------------------------------------------
// v1.6.58 Library sort controls — Roon ARC's arrow, in the real UI.
//
// The requirement was a single arrow that reverses the order when tapped and
// puts it back when tapped again, replacing the previous wordy
// "Order: A → Z (tap to reverse)" row. That gives four orderings from two
// controls: A→Z / Z→A on the alphabetical sorts, and newest→oldest /
// oldest→newest on Release year.
//
// What makes this worth a test rather than eyeballing: the arrow is only
// honest if the request it produces matches what it draws. An arrow that flips
// on screen while the server keeps sorting the old way looks completely normal.
// So every assertion here pairs the GLYPH with the `dir=` actually sent.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist One", image_key: "k0" },
  { offset: 1, title: "Album B", subtitle: "Artist One", image_key: "k1" },
];

const STUB = `
var ALBUMS = ${JSON.stringify(ALBUMS)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 10, dated: 4, decades: [{ value: 1990, label: "1990s", count: 4 }],
                           sources: [], hasPlays: true });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
// A clean slate: a persisted view from a previous run would decide the
// starting sort and make these assertions depend on test order.
try { localStorage.removeItem("rra-library-view"); } catch (e) {}
`;

const DRIVER = `
  await window.__sleep(400);

  // The most recent /api/library/albums request — what the controls ACTUALLY
  // asked the server for, as opposed to what they drew.
  function lastQuery() {
    var hits = window.__calls.filter(function (u) { return u.indexOf("/api/library/albums") > -1; });
    if (!hits.length) return null;
    var q = hits[hits.length - 1].split("?")[1] || "";
    var p = new URLSearchParams(q);
    return { sort: p.get("sort"), dir: p.get("dir"), seed: p.get("seed") };
  }
  var bar = function () { return document.getElementById("library-controls"); };
  var dirBtn = function () { return bar().querySelector(".lib-dir-btn"); };
  var sortPill = function () { return bar().querySelectorAll(".lib-pill")[0]; };
  function pillValue() { return sortPill().querySelector(".lib-pill-value").textContent; }

  document.getElementById("home-library-title").click();
  await window.__sleep(400);

  T("controls_present", !!bar() && !bar().classList.contains("hidden"));
  T("pill_count", bar().querySelectorAll(".lib-pill").length);
  T("dir_btn_present", !!dirBtn());

  // ---- default state ------------------------------------------------------
  T("default_pill", pillValue());
  T("default_arrow", dirBtn().textContent);
  T("default_query", lastQuery());

  // ---- one tap reverses, another puts it back -----------------------------
  // Focus it first: the arrow is a repeat-tap control, and the rebuild that
  // follows each tap replaces the very button that was pressed.
  dirBtn().focus();
  T("focus_before_tap", document.activeElement.className);
  dirBtn().click();
  await window.__sleep(250);
  T("after_one_tap_arrow", dirBtn().textContent);
  T("after_one_tap_query", lastQuery());
  T("focus_after_tap", document.activeElement.className);
  T("focus_survives_tap", document.activeElement === dirBtn());
  T("arrow_aria_after_tap", dirBtn().getAttribute("aria-label"));

  dirBtn().click();
  await window.__sleep(250);
  T("after_two_taps_arrow", dirBtn().textContent);
  T("after_two_taps_query", lastQuery());

  // ---- the sheet: only the selected row carries an arrow -------------------
  function openSort() { sortPill().click(); }
  function sheetRows() {
    return Array.prototype.slice.call(document.querySelectorAll(".lib-sort-row"));
  }
  function rowByLabel(label) {
    return sheetRows().filter(function (r) {
      var el = r.querySelector(".lib-sort-label");
      return el && el.textContent === label;
    })[0];
  }
  function arrowsShown() {
    return sheetRows().map(function (r) {
      var a = r.querySelector(".lib-sort-arrow");
      return (a && a.textContent) || "";
    });
  }
  function closeSheet() {
    var b = document.querySelector(".lib-sheet-backdrop");
    if (b) b.remove();
  }

  openSort();
  await window.__sleep(200);
  T("sheet_row_count", sheetRows().length);
  T("sheet_arrows", arrowsShown());

  // The wordy direction row is gone. Scanned over the SHEET's rendered text
  // only — document.body.textContent includes this driver's own <script>, so a
  // whole-page scan matches the needle written here and always "finds" it.
  // The needle is assembled at runtime for the same reason.
  var needle = ["tap", "to", "reverse"].join(" ");
  var sheetText = document.querySelector(".lib-sheet").textContent.toLowerCase();
  T("sheet_visible_text_has_needle", sheetText.indexOf(needle) > -1);
  T("legacy_dir_row_count", document.querySelectorAll(".lib-row-dir").length);
  T("sheet_selected_labels", sheetRows().filter(function (r) {
    return r.classList.contains("is-on");
  }).map(function (r) { return r.querySelector(".lib-sort-label").textContent; }));

  // ---- tapping the SELECTED row reverses in place, sheet stays open --------
  var before = arrowsShown().join("");
  rowByLabel("Album name").click();
  await window.__sleep(250);
  T("resel_sheet_still_open", !!document.querySelector(".lib-sheet"));
  T("resel_arrows", arrowsShown());
  T("resel_arrow_changed", arrowsShown().join("") !== before);
  T("resel_query", lastQuery());

  // ---- tapping a DIFFERENT row switches sort at its own default direction --
  rowByLabel("Release year").click();
  await window.__sleep(300);
  T("year_sheet_closed", !document.querySelector(".lib-sheet"));
  T("year_pill", pillValue());
  T("year_arrow", dirBtn().textContent);
  T("year_query", lastQuery());
  T("year_arrow_title", dirBtn().title);

  // Newest→oldest and oldest→newest are both reachable from that arrow.
  dirBtn().click();
  await window.__sleep(250);
  T("year_reversed_arrow", dirBtn().textContent);
  T("year_reversed_query", lastQuery());

  // ---- Most played defaults to descending ---------------------------------
  closeSheet();
  openSort();
  await window.__sleep(200);
  rowByLabel("Most played").click();
  await window.__sleep(300);
  T("plays_query", lastQuery());
  T("plays_arrow", dirBtn().textContent);

  // ---- Random has no direction: the slot becomes a reshuffle --------------
  openSort();
  await window.__sleep(200);
  rowByLabel("Random").click();
  await window.__sleep(300);
  T("random_pill", pillValue());
  T("random_is_shuffle", dirBtn().classList.contains("is-shuffle"));
  T("random_btn_label", dirBtn().getAttribute("aria-label"));
  var seedBefore = lastQuery().seed;
  dirBtn().click();
  await window.__sleep(300);
  var seedAfter = lastQuery().seed;
  T("random_reshuffled", !!seedBefore && !!seedAfter && seedBefore !== seedAfter);

  // ---- the choice survives leaving and re-entering the wall ---------------
  closeSheet();
  window.__showHome();
  await window.__sleep(200);
  document.getElementById("home-library-title").click();
  await window.__sleep(400);
  T("persisted_pill", pillValue());
`;

test("Library sort: one arrow drives all four orderings (v1.6.58)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: STUB, driver: DRIVER, name: "library-sort", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the controls render as Sort | arrow | Focus", () => {
      assert.equal(r.controls_present, true);
      assert.equal(r.pill_count, 2);
      assert.equal(r.dir_btn_present, true, "the direction arrow never rendered");
    });

    await t.test("the old wordy direction row is gone", () => {
      assert.equal(r.legacy_dir_row_count, 0);
      assert.equal(r.sheet_visible_text_has_needle, false,
        'the "Order: A → Z (tap to reverse)" wording is still rendered in the ' +
        "sheet — the arrow was meant to replace it, not sit beside it");
    });

    await t.test("it opens on Album name, A→Z", () => {
      assert.equal(r.default_pill, "Album name");
      assert.equal(r.default_arrow, "↑");
      assert.equal(r.default_query.sort, "album");
      assert.equal(r.default_query.dir, "asc");
    });

    await t.test("one tap reverses and a second tap puts it back", () => {
      assert.equal(r.after_one_tap_arrow, "↓");
      assert.equal(r.after_one_tap_query.dir, "desc",
        "the arrow flipped on screen but the request still asked for the old " +
        "direction — the control is lying about what it did");
      assert.equal(r.after_two_taps_arrow, "↑");
      assert.equal(r.after_two_taps_query.dir, "asc");
    });

    await t.test("the arrow keeps focus across its own rebuild", () => {
      assert.equal(r.focus_before_tap, "lib-dir-btn");
      assert.equal(r.focus_survives_tap, true,
        "tapping the arrow rebuilds the controls row and replaces the button " +
        "that was just pressed — without restoring focus, one Enter reverses " +
        "the order and the next does nothing because focus fell to <body>");
      assert.equal(r.arrow_aria_after_tap, "Reverse order — currently Z → A",
        "the refocused button must state the NEW direction — that is what a " +
        "screen reader announces when focus lands on it");
    });

    await t.test("only the selected row carries an arrow", () => {
      // 7 since v1.7.31 added "Recently added". Asserted as a count rather
      // than a list because this test is about the ARROW, not the vocabulary —
      // libSortIds() is what pins the ids, in the unit suite.
      assert.equal(r.sheet_row_count, 7);
      const filled = r.sheet_arrows.filter(Boolean);
      assert.equal(filled.length, 1,
        `expected exactly one arrow in the sheet, got ${JSON.stringify(r.sheet_arrows)}`);
      assert.deepEqual(r.sheet_selected_labels, ["Album name"]);
    });

    await t.test("re-tapping the selected row reverses it in place", () => {
      assert.equal(r.resel_arrow_changed, true, "the arrow did not flip");
      assert.equal(r.resel_query.dir, "desc");
      assert.equal(r.resel_sheet_still_open, true,
        "the sheet closed on a reverse — ARC keeps it open so the arrow can be " +
        "tapped back without reopening");
    });

    await t.test("picking Release year opens newest-first, and reverses", () => {
      assert.equal(r.year_sheet_closed, true);
      assert.equal(r.year_pill, "Release year");
      // Newest first is what "sort by year" means to a listener; it must not
      // inherit the previous sort's direction.
      assert.equal(r.year_arrow, "↓");
      assert.equal(r.year_query.sort, "year");
      assert.equal(r.year_query.dir, "desc");
      assert.equal(r.year_arrow_title, "Newest first",
        "the arrow's tooltip must say what it means for THIS sort");
      assert.equal(r.year_reversed_arrow, "↑");
      assert.equal(r.year_reversed_query.dir, "asc");
    });

    await t.test("Most played opens most-first, not least-first", () => {
      assert.equal(r.plays_query.sort, "plays");
      assert.equal(r.plays_query.dir, "desc",
        "the server no longer inverts plays/lastplayed, so the client must ask " +
        "for desc — asc would list the least-played albums first");
      assert.equal(r.plays_arrow, "↓");
    });

    await t.test("Random swaps the arrow for a reshuffle", () => {
      assert.equal(r.random_pill, "Random");
      assert.equal(r.random_is_shuffle, true,
        "Random has no direction — an arrow there would do nothing");
      assert.equal(r.random_btn_label, "Shuffle again");
      assert.equal(r.random_reshuffled, true, "the reshuffle sent the same seed again");
    });

    await t.test("the sort survives leaving and re-entering the wall", () => {
      assert.equal(r.persisted_pill, "Random");
    });
  });

// ---------------------------------------------------------------------------
// The persisted view is read at module-init time, and the v2 migration calls
// libSortDefaultDir() while doing it. That forced LIB_SORT_OPTIONS to move
// above libView in the file: a `const` referenced before its declaration
// throws ReferenceError, and a throw during app.js init is a blank app.
//
// Nothing else in the suite exercises that path, because a fresh browser has no
// saved view at all — the migration only runs when a v1 blob is present, i.e.
// on every existing user's first load of this version and nobody else's.
// ---------------------------------------------------------------------------
const V1_STUB = STUB.replace(
  'try { localStorage.removeItem("rra-library-view"); } catch (e) {}',
  // A v1 blob exactly as v1.6.57 wrote it: no "v" key, and dir=asc meaning
  // "most played first" under the old inverted server semantics.
  'try { localStorage.setItem("rra-library-view", JSON.stringify(' +
  '{ sort: "plays", dir: "asc", seed: 7, decade: ["1990"], source: ["local"], played: "never" }' +
  ')); } catch (e) {}'
);

const V1_DRIVER = `
  await window.__sleep(400);
  document.getElementById("home-library-title").click();
  await window.__sleep(400);

  var bar = document.getElementById("library-controls");
  T("booted", !!bar);
  T("pill", bar.querySelectorAll(".lib-pill")[0].querySelector(".lib-pill-value").textContent);
  T("arrow", bar.querySelector(".lib-dir-btn").textContent);
  T("focus_pill", bar.querySelectorAll(".lib-pill")[1].querySelector(".lib-pill-value").textContent);

  var hits = window.__calls.filter(function (u) { return u.indexOf("/api/library/albums") > -1; });
  var p = new URLSearchParams((hits[hits.length - 1] || "").split("?")[1] || "");
  T("query", { sort: p.get("sort"), dir: p.get("dir"),
               decade: p.getAll("decade"), source: p.getAll("source"), played: p.get("played") });

  var saved = JSON.parse(localStorage.getItem("rra-library-view") || "null");
  T("saved_version", saved && saved.v);
`;

test("Library sort: a v1.6.57 saved view migrates without breaking (v1.6.58)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: V1_STUB, driver: V1_DRIVER, name: "library-sort-v1", windowSize: "390x844",
    });
    // assertNoPageError is the real assertion here: a TDZ ReferenceError during
    // app.js init would surface as an uncaught page error, not a failed check.
    harness.assertNoPageError(assert, r);

    await t.test("the app boots with a v1 blob in localStorage", () => {
      assert.equal(r.booted, true, "the library controls never rendered");
    });

    await t.test("the stale direction is replaced by the sort's own default", () => {
      assert.equal(r.pill, "Most played");
      assert.equal(r.arrow, "↓");
      assert.equal(r.query.dir, "desc",
        "a v1 blob's dir=asc used to mean most-played-first; carried over " +
        "verbatim it now means LEAST played first — the migration must drop it");
    });

    await t.test("everything else in the blob survives", () => {
      assert.equal(r.query.sort, "plays");
      assert.deepEqual(r.query.decade, ["1990"]);
      assert.deepEqual(r.query.source, ["local"]);
      assert.equal(r.query.played, "never");
      assert.equal(r.focus_pill, "3 active");
    });

    await t.test("the blob is rewritten at the new version, so this runs once", () => {
      assert.equal(r.saved_version, 2);
    });
  });

// The migration must be NARROW. Only plays/lastplayed changed meaning between
// v1 and v2; album/artist/year meant the same thing, so resetting those would
// throw away a real preference — and because the migrated blob is written
// straight back, throw it away permanently.
function v1Case(name, blob, driverExtra) {
  const stub = STUB.replace(
    'try { localStorage.removeItem("rra-library-view"); } catch (e) {}',
    'try { localStorage.setItem("rra-library-view", ' +
    JSON.stringify(JSON.stringify(blob)) + '); } catch (e) {}'
  );
  const driver = `
    await window.__sleep(400);
    document.getElementById("home-library-title").click();
    await window.__sleep(400);
    var bar = document.getElementById("library-controls");
    T("booted", !!bar);
    T("pill", bar.querySelectorAll(".lib-pill")[0].querySelector(".lib-pill-value").textContent);
    T("arrow", bar.querySelector(".lib-dir-btn").textContent);
    var hits = window.__calls.filter(function (u) { return u.indexOf("/api/library/albums") > -1; });
    var p = new URLSearchParams((hits[hits.length - 1] || "").split("?")[1] || "");
    T("query", { sort: p.get("sort"), dir: p.get("dir"),
                 decade: p.getAll("decade"), source: p.getAll("source"), played: p.get("played") });
    ${driverExtra || ""}
  `;
  return harness.renderPage({ stub, driver, name, windowSize: "390x844" });
}

test("Library sort: the v2 migration only touches what v2 changed", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
    return;
  }

  await t.test("an alphabetical Z→A preference survives the upgrade", () => {
    const r = v1Case("v1-alpha", { sort: "album", dir: "desc", seed: 1,
                                   decade: [], source: [], played: "any" });
    harness.assertNoPageError(assert, r);
    assert.equal(r.query.sort, "album");
    assert.equal(r.query.dir, "desc",
      "album/artist/year meant the same thing in v1 — resetting their stored " +
      "direction silently flips a Z→A wall back to A→Z and, since the migrated " +
      "blob is saved immediately, loses the preference for good");
    assert.equal(r.arrow, "↓");
  });

  await t.test("a Release year oldest-first preference survives too", () => {
    const r = v1Case("v1-year", { sort: "year", dir: "asc", seed: 1,
                                  decade: [], source: [], played: "any" });
    harness.assertNoPageError(assert, r);
    assert.equal(r.query.dir, "asc");
    assert.equal(r.arrow, "↑");
  });

  // A blob can be valid JSON and still the wrong shape — a partial write, a
  // synced value, a hand edit. Object.assign copies it verbatim and the load's
  // try/catch only covers the parse, so an unvalidated `decade: null` throws
  // later, at render time, inside an un-awaited async handler: the wall opens
  // empty with no error and no way out short of clearing site data.
  await t.test("a malformed blob cannot brick the Library wall", () => {
    for (const [label, blob] of [
      ["decade null",        { sort: "album", decade: null, source: null, played: "never" }],
      ["decade not a list",  { sort: "album", decade: 123, source: "local", played: "any" }],
      ["unknown played",     { sort: "album", decade: [], source: [], played: "banana" }],
      ["nonsense dir",       { sort: "album", dir: "sideways", decade: [], source: [] }],
      ["unknown sort",       { sort: "nope", dir: "asc", decade: [], source: [] }],
      ["NaN seed",           { sort: "random", seed: "abc", decade: [], source: [] }],
    ]) {
      const r = v1Case("v1-bad", blob);
      harness.assertNoPageError(assert, r);
      assert.equal(r.booted, true, `${label}: the library controls never rendered`);
      assert.ok(["asc", "desc"].includes(r.query.dir), `${label}: dir=${r.query.dir}`);
      assert.ok(r.query.sort, `${label}: no sort was sent`);
    }
  });
});
