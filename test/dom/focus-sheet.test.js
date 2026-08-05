"use strict";
// ---------------------------------------------------------------------------
// v1.7.35: the Focus sheet, rebuilt to Roon's shape.
//
// The user's report was two-part: the Library control row "isn't in-keeping
// with Roon", and Roon's own Focus "scrolls up and down with multiple focus
// options" while ours had three. Ten categories on a phone only works if
// they collapse, so the failure modes to pin are the ones that hide a filter
// the user has already set:
//
//   1. A category that is ON must be VISIBLE. Collapsed-by-default is right
//      for an untouched sheet and wrong the moment something in it is
//      selected — a filter you cannot see is a filter you cannot clear, and
//      the wall looks broken instead of filtered.
//   2. Tap-again-to-invert must reach the SERVER as an exclusion. The chip
//      turning red proves nothing; "!Pop" has to appear in the query, because
//      a dropped "!" silently inverts what the user asked for.
//   3. The sheet is rendered from what the SERVER reports. A hard-coded list
//      of categories here would mean a facet the server grew never appeared,
//      which looks like the harvest failing rather than the client ignoring it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const dec = (d, n) => ({ value: String(d), label: d + "s", count: n });
const FACETS = {
  total: 626,
  // Deliberately short of `total` everywhere, so the coverage captions render.
  coverage: { decade: 600, genre: 610, label: 400, format: 320, added: 300 },
  sources_derived: false,
  hasPlays: true,
  facets: [
    { id: "genre", label: "Genre", total_values: 40, values: [
      { value: "Pop/Rock", label: "Pop/Rock", count: 300 },
      { value: "Jazz", label: "Jazz", count: 88 },
    ] },
    { id: "source", label: "Source", total_values: 2, values: [
      { value: "local", label: "Local albums", count: 320 },
      { value: "qobuz", label: "Qobuz", count: 210 },
    ] },
    { id: "decade", label: "Decade", total_values: 3, values: [
      dec(1990, 130), dec(1980, 71), dec(1970, 88),
    ] },
    { id: "format", label: "Format", total_values: 2, values: [
      { value: "FLAC", label: "FLAC", count: 280 },
      { value: "MP3", label: "MP3", count: 40 },
    ] },
    { id: "added", label: "Added in the last", total_values: 2, values: [
      { value: "7", label: "7 days", count: 3 },
      { value: "30", label: "30 days", count: 12 },
    ] },
  ],
};

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist One", image_key: "k0" },
  { offset: 1, title: "Album B", subtitle: "Artist One", image_key: "k1" },
];

const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [],
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  now_playing: null,
};

const STUB = `
var ALBUMS = ${JSON.stringify(ALBUMS)};
var FACETS = ${JSON.stringify(FACETS)};
var ZONE = ${JSON.stringify(ZONE)};
try {
  // A saved view naming a genre OUTSIDE the server's top-40 list, plus an
  // excluded one. Both are active filters the sheet must still be able to show
  // and clear — the server sends only the commonest values.
  localStorage.setItem("rra-library-view", JSON.stringify({
    v: 2, sort: "album", dir: "asc", seed: 1, played: "any",
    genre: ["Klezmer", "!Sea Shanty"]
  }));
} catch (e) {}
window.__calls = [];
window.__installFetch(function (url) {
  window.__calls.push(url);
  if (url.indexOf("/api/library/facets") > -1) return window.__json(FACETS);
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(400);

  // What the wall last ASKED FOR, which is the only thing that proves a chip
  // did what it drew.
  function lastQuery() {
    var hits = window.__calls.filter(function (u) { return u.indexOf("/api/library/albums") > -1; });
    if (!hits.length) return null;
    var p = new URLSearchParams(hits[hits.length - 1].split("?")[1] || "");
    var out = {};
    ["genre", "source", "decade", "format", "added"].forEach(function (k) {
      var v = p.getAll(k); if (v.length) out[k] = v;
    });
    if (p.get("played") && p.get("played") !== "any") out.played = p.get("played");
    return out;
  }
  function heads() {
    return Array.prototype.slice.call(document.querySelectorAll(".lib-sheet-section-head"));
  }
  function headByLabel(label) {
    return heads().filter(function (h) {
      var el = h.querySelector(".lib-sheet-section-label");
      return el && el.textContent === label;
    })[0];
  }
  function chipsUnder(label) {
    var h = headByLabel(label);
    if (!h) return [];
    return Array.prototype.slice.call(h.parentElement.querySelectorAll(".lib-chip"));
  }
  function chipByText(label, needle) {
    return chipsUnder(label).filter(function (c) { return c.textContent.indexOf(needle) === 0; })[0];
  }
  // Open a category only if it is CLOSED — an active one comes back expanded on
  // its own, and clicking it blindly would shut it.
  function expand(label) {
    var h = headByLabel(label);
    if (h && h.getAttribute("aria-expanded") === "false") h.click();
  }
  function openFocus() {
    document.querySelector(".library-controls .lib-ctl-focus").click();
  }
  function closeSheet() {
    var b = document.querySelector(".lib-sheet-backdrop");
    if (b) b.remove();
  }

  document.getElementById("home-library-title").click();
  await window.__sleep(400);

  openFocus();
  await window.__sleep(500);
  T("sheet_open", !!document.querySelector(".lib-sheet"));

  // ---- a selected value the server did not list still gets a chip ---------
  T("offlist_section_expanded", headByLabel("Genre").getAttribute("aria-expanded"));
  T("offlist_chips", chipsUnder("Genre").map(function (c) {
    return c.textContent + "|" + c.className;
  }));
  chipByText("Genre", "Klezmer").click();     // on -> not
  chipByText("Genre", "Klezmer").click();     // not -> off
  await window.__sleep(150);
  T("offlist_cleared", !chipByText("Genre", "Klezmer"));
  // Clear the seeded state so the rest of the driver starts from nothing.
  Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Clear all"; })[0].click();
  await window.__sleep(400);
  openFocus();
  await window.__sleep(500);

  // ---- categories come from the SERVER ------------------------------------
  T("section_labels", heads().map(function (h) {
    return h.querySelector(".lib-sheet-section-label").textContent;
  }));
  T("all_collapsed_initially", heads().every(function (h) {
    return h.getAttribute("aria-expanded") === "false";
  }));
  T("no_chips_while_collapsed", document.querySelectorAll(".lib-chip").length);

  // ---- a category opens on tap and closes again ---------------------------
  headByLabel("Genre").click();
  await window.__sleep(150);
  T("genre_open", headByLabel("Genre").getAttribute("aria-expanded"));
  T("genre_chip_labels", chipsUnder("Genre").map(function (c) { return c.textContent; }));
  // Only the tapped one — that is what keeps the sheet short.
  T("open_count_after_one", heads().filter(function (h) {
    return h.getAttribute("aria-expanded") === "true"; }).length);

  headByLabel("Genre").click();
  await window.__sleep(150);
  T("genre_closed_again", headByLabel("Genre").getAttribute("aria-expanded"));

  // ---- include -> exclude -> clear ----------------------------------------
  headByLabel("Genre").click();
  await window.__sleep(150);
  chipByText("Genre", "Pop/Rock").click();
  await window.__sleep(150);
  T("after_one_tap_class", chipByText("Genre", "Pop/Rock").className);

  chipByText("Genre", "Pop/Rock").click();
  await window.__sleep(150);
  T("after_two_taps_class", chipByText("Genre", "Pop/Rock").className);
  T("after_two_taps_aria", chipByText("Genre", "Pop/Rock").getAttribute("aria-label"));

  // Apply it and see what the server was actually asked for.
  Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Show albums"; })[0].click();
  await window.__sleep(400);
  T("excluded_query", lastQuery());

  // A third tap clears it.
  openFocus();
  await window.__sleep(500);
  // An EXCLUDED genre counts as active, so Genre comes back already expanded.
  T("excluded_section_expanded", headByLabel("Genre").getAttribute("aria-expanded"));
  expand("Genre");
  await window.__sleep(150);
  chipByText("Genre", "Pop/Rock").click();
  await window.__sleep(150);
  T("after_three_taps_class", chipByText("Genre", "Pop/Rock").className);

  // ---- an ACTIVE category is expanded when the sheet reopens --------------
  chipByText("Genre", "Jazz").click();
  await window.__sleep(150);
  expand("Decade");
  await window.__sleep(150);
  chipByText("Decade", "1990s").click();
  await window.__sleep(150);
  Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Show albums"; })[0].click();
  await window.__sleep(400);
  T("two_facet_query", lastQuery());
  T("badge_after_two", (document.querySelector(".lib-ctl-focus .lib-ctl-badge") || {}).textContent);

  openFocus();
  await window.__sleep(500);
  T("reopen_expanded", heads().filter(function (h) {
    return h.getAttribute("aria-expanded") === "true";
  }).map(function (h) { return h.querySelector(".lib-sheet-section-label").textContent; }));
  T("reopen_counts", heads().map(function (h) {
    var n = h.querySelector(".lib-sheet-section-count");
    return h.querySelector(".lib-sheet-section-label").textContent + ":" + (n ? n.textContent : "");
  }));

  // ---- coverage captions say where the numbers came from ------------------
  // Two captions hang off this section — how many values are shown, and how
  // many albums the facet actually covers. Read the whole section rather than
  // the first note, so the order of the two can change without this lying.
  T("genre_section_text", headByLabel("Genre").parentElement.textContent);
  T("genre_note_count", headByLabel("Genre").parentElement
      .querySelectorAll(".lib-facet-note").length);

  // ---- Clear all empties every facet, not just the ones it knew about -----
  Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Clear all"; })[0].click();
  await window.__sleep(400);
  T("cleared_query", lastQuery());
  T("badge_after_clear", !!document.querySelector(".lib-ctl-focus .lib-ctl-badge"));
`;

test("Focus: ten categories, collapsed, with include/exclude (v1.7.35)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: STUB, driver: DRIVER, name: "focus-sheet", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("a filter the server didn't list is still visible and clearable", () => {
      // Genre and Label are truncated to the commonest values, so a saved
      // playlist can easily name one that is not in the list. An active filter
      // with no chip is invisible AND unclearable except by wiping every other
      // filter with it.
      assert.equal(r.offlist_section_expanded, "true",
        "a category holding active filters must open on its own");
      assert.deepEqual(r.offlist_chips, [
        "Pop/Rock (300)|lib-chip",
        "Jazz (88)|lib-chip",
        "Klezmer|lib-chip is-on",
        "Sea Shanty|lib-chip is-not",
      ], "the off-list values must render after the listed ones, in their real states");
      assert.equal(r.offlist_cleared, true,
        "cycling an off-list chip past off must remove it — otherwise it can " +
        "never be cleared");
    });

    await t.test("the categories are whatever the server reported", () => {
      assert.equal(r.sheet_open, true);
      // Listening is the client's own — it runs on this extension's play
      // history rather than on anything harvested — and leads because it is the
      // one category that is always available. Everything after it is the
      // server's list, in the server's order.
      assert.deepEqual(r.section_labels,
        ["Listening", "Genre", "Source", "Decade", "Format", "Added in the last"]);
    });

    await t.test("nothing is expanded until it is asked for", () => {
      assert.equal(r.all_collapsed_initially, true,
        "a sheet that opens fully expanded is unusable on a phone with ten " +
        "categories — that is the whole reason they collapse");
      assert.equal(r.no_chips_while_collapsed, 0,
        "collapsed sections still rendered their chips, so nothing was saved");
    });

    await t.test("tapping a category opens just that one", () => {
      assert.equal(r.genre_open, "true");
      assert.deepEqual(r.genre_chip_labels, ["Pop/Rock (300)", "Jazz (88)"],
        "each chip states its own count — a facet that would return nothing " +
        "should never have been offered");
      assert.equal(r.open_count_after_one, 1);
      assert.equal(r.genre_closed_again, "false", "the header does not toggle shut");
    });

    await t.test("a chip cycles include → exclude → off", () => {
      assert.match(r.after_one_tap_class, /is-on/);
      assert.doesNotMatch(r.after_one_tap_class, /is-not/);
      assert.match(r.after_two_taps_class, /is-not/);
      assert.doesNotMatch(r.after_two_taps_class, /is-on/);
      assert.equal(r.after_two_taps_aria, "Excluding Pop/Rock (300)",
        "red alone does not say 'excluded' to a screen reader");
      assert.equal(r.after_three_taps_class, "lib-chip", "a third tap must clear it");
    });

    await t.test("an excluded chip reaches the server as an exclusion", () => {
      // THE assertion. The chip turning red proves only that the chip turned
      // red; a dropped "!" would show the complement of what was asked for and
      // still look like a working filter.
      assert.deepEqual(r.excluded_query, { genre: ["!Pop/Rock"] });
    });

    await t.test("two categories combine in one query", () => {
      assert.deepEqual(r.two_facet_query, { genre: ["Jazz"], decade: ["1990"] });
      assert.equal(r.badge_after_two, "2", "the row's badge counts every active filter");
    });

    await t.test("reopening expands exactly the categories that are ON", () => {
      // The one that matters. A filter the user set and cannot see is a filter
      // they cannot clear, and the wall reads as broken rather than filtered.
      assert.deepEqual(r.reopen_expanded, ["Genre", "Decade"]);
      assert.deepEqual(r.reopen_counts, [
        "Listening:", "Genre:1", "Source:", "Decade:1", "Format:", "Added in the last:",
      ], "a collapsed category must still say whether it is doing anything");
    });

    await t.test("each category says where its numbers came from", () => {
      assert.match(r.genre_section_text, /610 of 626/,
        "coverage is stated with real numbers — chips that don't add up to the " +
        "library otherwise read as a bug rather than as partial data");
      assert.match(r.genre_section_text, /most common of 40/,
        "a truncated value list must say it is truncated; 2 of 40 values " +
        "shown silently looks like a library with 2 genres in it");
      assert.equal(r.genre_note_count, 2);
    });

    await t.test("Clear all empties every category", () => {
      assert.deepEqual(r.cleared_query, {},
        "a facet left behind by Clear all is invisible and unclearable");
      assert.equal(r.badge_after_clear, false, "the count badge should be gone");
    });
  });
