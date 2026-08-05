"use strict";
// ---------------------------------------------------------------------------
// v1.6.58 regression: the Library Sort / Focus sheets rendered underneath the
// mini transport bar.
//
// .lib-sheet-backdrop was z-index 60. .mini-transport is z-index 70 and is
// fixed to the bottom of the viewport, so whenever anything was playing the
// bar painted straight over the foot of the sheet: the last sort rows and the
// whole "Clear all / Show albums" footer were invisible AND untappable.
//
// A z-index assertion in CSS text would be brittle (the bar could move layers
// instead). This test asserts the BEHAVIOUR the user reported, against the
// real shipping index.html + app.js + style.css at a phone viewport:
//
//   * every control in an open sheet is hit-testable — document.elementFromPoint
//     at its centre lands inside the sheet, not on the transport bar;
//   * the sheet's own box fits inside the viewport.
//
// A control assertion proves the detector works: the transport bar must
// genuinely overlap the sheet's rectangle, otherwise "nothing is covered" is
// vacuously true and this file proves nothing.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// Enough categories and values that the Focus sheet's body overflows a phone
// screen with everything expanded — that is the case where a squeezed footer
// would be lost. The payload is the v1.7.35 shape (a `facets` array the sheet
// renders generically); the old decades/sources shape rendered NOTHING here,
// which quietly made "no control is covered" a test of an almost empty sheet.
const dec = (d, n) => ({ value: String(d), label: d + "s", count: n });
const FACETS = {
  total: 626,
  coverage: { decade: 600, genre: 610, label: 400, format: 320, added: 300 },
  sources_derived: false,
  hasPlays: true,
  facets: [
    { id: "genre", label: "Genre", total_values: 40, values: [
      { value: "Pop/Rock", label: "Pop/Rock", count: 300 },
      { value: "Jazz", label: "Jazz", count: 88 },
      { value: "Electronic", label: "Electronic", count: 61 },
      { value: "Classical", label: "Classical", count: 40 },
    ] },
    { id: "source", label: "Source", total_values: 3, values: [
      { value: "local", label: "Local albums", count: 320 },
      { value: "qobuz", label: "Qobuz", count: 210 },
      { value: "tidal", label: "TIDAL", count: 96 },
    ] },
    { id: "decade", label: "Decade", total_values: 8, values: [
      dec(2020, 55), dec(2010, 142), dec(2000, 96), dec(1990, 130),
      dec(1980, 71), dec(1970, 88), dec(1960, 40), dec(1950, 12),
    ] },
    { id: "label", label: "Record label", total_values: 212, values: [
      { value: "Blue Note", label: "Blue Note", count: 40 },
      { value: "4AD", label: "4AD", count: 22 },
    ] },
    { id: "format", label: "Format", total_values: 3, values: [
      { value: "FLAC", label: "FLAC", count: 280 },
      { value: "MP3", label: "MP3", count: 40 },
    ] },
    { id: "rate", label: "Sample rate", total_values: 3, values: [
      { value: "44100", label: "44.1 kHz", count: 250 },
      { value: "96000", label: "96 kHz", count: 70 },
    ] },
    { id: "bits", label: "Bit depth", total_values: 2, values: [
      { value: "16", label: "16-bit", count: 250 },
      { value: "24", label: "24-bit", count: 70 },
    ] },
    { id: "letter", label: "Starts with", total_values: 27, values: [
      { value: "A", label: "A", count: 40 }, { value: "B", label: "B", count: 51 },
    ] },
    { id: "added", label: "Added in the last", total_values: 4, values: [
      { value: "7", label: "7 days", count: 3 },
      { value: "30", label: "30 days", count: 12 },
      { value: "90", label: "3 months", count: 44 },
      { value: "365", label: "A year", count: 190 },
    ] },
  ],
};

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist One", image_key: "k0" },
  { offset: 1, title: "Album B", subtitle: "Artist One", image_key: "k1" },
  { offset: 2, title: "Album C", subtitle: "Artist Two", image_key: "k2" },
];

// A zone that is genuinely playing, so app.js reveals the mini transport bar
// through its own poll loop and KEEPS it revealed. Forcing the `hidden` class
// off by hand is not enough — the 1.5s poll puts it straight back.
const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "playing", outputs: [],
  now_playing: {
    line1: "Leaving (Album Version)",
    line2: "Youssou N'Dour / Mathew Russell",
    line3: "Rokku Mi Rokka",
    length: 240, seek_position: 30,
  },
};

const STUB = `
var ALBUMS = ${JSON.stringify(ALBUMS)};
var FACETS = ${JSON.stringify(FACETS)};
var ZONE = ${JSON.stringify(ZONE)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/library/facets") > -1) return window.__json(FACETS);
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)    return window.__json({ zones: [ZONE] });
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
  await window.__sleep(400);                       // let app.js finish booting

  // Reproduce the reported condition: the stubbed zone is playing, so app.js's
  // own poll reveals the mini transport bar — exactly as in the screenshots.
  var bar = document.getElementById("mini-transport");
  // The bar appears on the transport poll, not at load — wait for it rather
  // than guessing a sleep length.
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  T("bar_shown_by_app", !bar.classList.contains("hidden"));
  var barRect = bar.getBoundingClientRect();
  T("bar_height", Math.round(barRect.height));
  T("bar_title", (document.getElementById("mt-title") || {}).textContent);

  // Enter the Library wall the way a user does — tap the Home section header.
  document.getElementById("home-library-title").click();
  await window.__sleep(400);

  var controls = document.getElementById("library-controls");
  T("controls_present", !!controls && !controls.classList.contains("hidden"));
  // v1.7.35: Focus first, Sort second — Roon's own order.
  var focusCtl = controls && controls.querySelector(".lib-ctl-focus");
  var sortCtl  = controls && controls.querySelector(".lib-ctl-sort");
  T("ctl_count", controls ? controls.querySelectorAll(".lib-ctl").length : 0);

  // Is the point at (x,y) owned by the open sheet? Walk up from whatever
  // Chromium hit-tests there; if we reach .lib-sheet the control is reachable,
  // if we reach .mini-transport the bar is covering it.
  function ownerAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return "none";
    while (el) {
      if (el.classList && el.classList.contains("lib-sheet")) return "sheet";
      if (el.classList && el.classList.contains("mini-transport")) return "transport";
      el = el.parentElement;
    }
    return "other";
  }

  // Report, for one open sheet: its box, whether the transport overlaps that
  // box at all (the control), and the owner of every control's centre point.
  async function probeSheet(label) {
    var sheet = document.querySelector(".lib-sheet");
    if (!sheet) { T(label + "_open", false); return; }
    T(label + "_open", true);

    // Scroll the body to the bottom — the last rows are what got clipped.
    var body = sheet.querySelector(".lib-sheet-body");
    if (body) { body.scrollTop = body.scrollHeight; }
    await window.__sleep(80);

    var r = sheet.getBoundingClientRect();
    T(label + "_fits_viewport",
      Math.round(r.bottom) <= window.innerHeight && Math.round(r.top) >= 0);

    // CONTROL: measure the bar HERE, not at boot. The transport poll can hide
    // it again between sheets, and a stale rect would make "nothing is
    // covered" vacuously true — which is exactly how the first draft of this
    // test passed against the un-fixed CSS.
    var live = bar.getBoundingClientRect();
    T(label + "_bar_visible_now", live.height > 40);
    T(label + "_bar_overlaps_sheet", live.top < r.bottom && live.bottom > r.top);

    // Every tappable thing in the sheet. Keep this list in step with the sheet
    // builders — a renamed row class silently empties it, and "no control is
    // covered" would then be true because no control was looked at.
    var controlsIn = sheet.querySelectorAll(
      ".lib-row, .lib-sort-row, .lib-chip, .lib-sheet-section-head, .lib-sheet-foot button");
    T(label + "_control_count", controlsIn.length);

    var covered = [];
    for (var i = 0; i < controlsIn.length; i++) {
      var c = controlsIn[i];
      var cr = c.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) continue;
      // Only points that are on screen AND inside the scrollport can be hit;
      // anything scrolled out of the body is legitimately not visible.
      var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      if (cy < 0 || cy > window.innerHeight) continue;
      if (body) {
        var br = body.getBoundingClientRect();
        var inBody = c.closest(".lib-sheet-body");
        if (inBody && (cy < br.top || cy > br.bottom)) continue;
      }
      var who = ownerAt(cx, cy);
      if (who !== "sheet") {
        covered.push((c.textContent || "").trim().slice(0, 40) + " -> " + who);
      }
    }
    T(label + "_covered", covered);

    // The footer specifically: it is pinned, so it is ALWAYS on screen and
    // must always be reachable.
    var foot = sheet.querySelector(".lib-sheet-foot");
    if (foot) {
      var fr = foot.getBoundingClientRect();
      T(label + "_foot_visible", fr.height > 0 && fr.bottom <= window.innerHeight);
      T(label + "_foot_owner", ownerAt(fr.left + fr.width / 2, fr.top + fr.height / 2));
    } else {
      T(label + "_foot_visible", null);
    }
  }

  function closeSheet() {
    var back = document.querySelector(".lib-sheet-backdrop");
    if (back) back.remove();
  }

  // ---- Sort sheet ---------------------------------------------------------
  sortCtl.click();
  await window.__sleep(200);
  await probeSheet("sort");
  closeSheet();
  await window.__sleep(100);

  // ---- Focus sheet (has the pinned footer) --------------------------------
  focusCtl.click();
  await window.__sleep(400);          // fetches /api/library/facets first
  // Expand every category first: collapsed sections are the default now, and a
  // sheet that is short because nothing is open would make "no control is
  // covered by the transport bar" vacuously true — which is precisely how the
  // first draft of this test passed against the un-fixed CSS.
  var heads = document.querySelectorAll(".lib-sheet-section-head");
  for (var h = 0; h < heads.length; h++) {
    if (document.querySelectorAll(".lib-sheet-section-head")[h]) {
      var live = document.querySelectorAll(".lib-sheet-section-head")[h];
      if (live.getAttribute("aria-expanded") === "false") live.click();
      await window.__sleep(30);
    }
  }
  T("focus_section_count", document.querySelectorAll(".lib-sheet-section-head").length);
  await probeSheet("focus");

  // The footer buttons must genuinely still work, not merely be visible.
  var sheet2 = document.querySelector(".lib-sheet");
  var showBtn = sheet2 && sheet2.querySelector(".lib-sheet-foot button.primary");
  T("focus_show_button_present", !!showBtn);
  if (showBtn) {
    showBtn.click();
    await window.__sleep(200);
    T("focus_show_closes_sheet", !document.querySelector(".lib-sheet"));
  }
`;

test("Library Sort/Focus sheets clear the mini transport bar (v1.6.58)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: STUB, driver: DRIVER, name: "library-sheet", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the harness reaches the library wall with the bar showing", () => {
      assert.equal(r.bar_shown_by_app, true,
        "control failed: app.js never revealed the mini transport for the " +
        "playing zone, so there is nothing to cover the sheets");
      assert.equal(r.bar_title, "Leaving (Album Version)");
      assert.ok(r.bar_height > 40,
        `control failed: the mini transport rendered ${r.bar_height}px tall, so ` +
        "it cannot cover anything and the rest of this test proves nothing");
      assert.equal(r.controls_present, true, "the Sort/Focus row never rendered");
      assert.equal(r.ctl_count, 2);
    });

    for (const label of ["sort", "focus"]) {
      await t.test(`the ${label} sheet is fully usable`, () => {
        assert.equal(r[`${label}_open`], true, `the ${label} sheet did not open`);
        assert.equal(r[`${label}_bar_visible_now`], true,
          "control failed: the transport bar was not on screen while the " +
          `${label} sheet was probed, so nothing could have been covered`);
        assert.equal(r[`${label}_bar_overlaps_sheet`], true,
          "control failed: the transport bar does not overlap the sheet at all, " +
          "so this test cannot detect the bug it exists to catch");
        assert.ok(r[`${label}_control_count`] > 0, "the sheet rendered no controls");
        assert.deepEqual(r[`${label}_covered`], [],
          "THE REPORTED BUG: these sheet controls are painted over by the mini " +
          "transport bar, so they are invisible and untappable");
        assert.equal(r[`${label}_fits_viewport`], true,
          "the sheet's own box extends outside the viewport");
      });
    }

    await t.test("the Focus footer stays pinned, visible and working", () => {
      assert.equal(r.focus_foot_visible, true,
        "the Clear all / Show albums footer was squeezed away by a long body");
      assert.equal(r.focus_foot_owner, "sheet",
        "the footer is on screen but something else owns its hit area");
      assert.equal(r.focus_show_button_present, true);
      assert.equal(r.focus_show_closes_sheet, true,
        "the Show albums button rendered but its click never reached the handler");
    });
  });
