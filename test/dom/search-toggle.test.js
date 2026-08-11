"use strict";
// ---------------------------------------------------------------------------
// v1.7.50: the search field opens from a magnifying glass, and a tap anywhere
// away from it closes AND clears it.
//
// The search bar had NO test coverage at all before this — it was the largest
// untested surface in the client. That mattered here because the change is
// almost entirely about state that is invisible in a screenshot: whether the
// field is open, whether the glass is showing, and whether a closed field is
// still holding a query.
//
// Two things are worth pinning beyond "it opens and closes":
//
//   CLOSING CLEARS. A field that reopens holding last week's query, with the
//   results long gone and the Home rows back, is a worse state than an empty
//   one — it looks like the search silently stopped working.
//
//   THE TOP BAR STOPS CHANGING HEIGHT. The permanently-present box measured
//   48px against 40px icon buttons, so .topbar-row was 48px on Home and 40px
//   everywhere else and the header visibly jumped on every navigation. The
//   collapsed state is what fixes that, so the heights are MEASURED rather
//   than assumed.
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
  if (url.indexOf("/api/search/external") > -1)
    return window.__json({ qobuz: null, tidal: null, pitchfork: null });
  if (url.indexOf("/api/search") > -1)
    return window.__json({ albums: ALBUMS, artists: [], labels: [] });
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
try { localStorage.removeItem("rra-library-view"); } catch (e) {}
`;

const DRIVER = `
  await window.__sleep(400);

  var glass = function () { return document.getElementById("search-open"); };
  var row   = function () { return document.getElementById("search-row"); };
  var input = function () { return document.getElementById("search-input"); };
  var wrap  = function () { return document.getElementById("topbar-search"); };
  function isOpen() { return row().classList.contains("open"); }
  function h(el) { return el ? Math.round(el.getBoundingClientRect().height) : -1; }

  // ---- resting state -------------------------------------------------------
  T("glass_exists", !!glass());
  T("closed_at_rest", !isOpen());
  T("glass_visible_at_rest", !!glass() && !glass().classList.contains("hidden"));
  T("topbar_h_closed", h(document.querySelector(".topbar-row")));

  // ---- opening -------------------------------------------------------------
  glass().click();
  await window.__sleep(120);
  T("open_after_tap", isOpen());
  T("glass_hidden_when_open", glass().classList.contains("hidden"));
  T("focused_on_open", document.activeElement === input());
  T("aria_expanded_open", glass().getAttribute("aria-expanded"));
  T("topbar_h_open", h(document.querySelector(".topbar-row")));

  // ---- typing runs a search ------------------------------------------------
  input().value = "album";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await window.__sleep(400);
  T("searched", window.__calls.some(function (u) { return u.indexOf("/api/search?") > -1; }));

  // ---- tap away closes AND clears -----------------------------------------
  document.body.click();
  await window.__sleep(120);
  T("closed_after_tap_away", !isOpen());
  T("cleared_after_tap_away", input().value);
  T("glass_back", !glass().classList.contains("hidden"));
  T("aria_expanded_closed", glass().getAttribute("aria-expanded"));

  // ---- a tap INSIDE the field must not close it ---------------------------
  glass().click();
  await window.__sleep(120);
  input().value = "keep";
  input().click();
  await window.__sleep(120);
  T("stayed_open_on_inside_tap", isOpen());
  T("kept_text_on_inside_tap", input().value);

  // ---- Escape closes and clears too ---------------------------------------
  var esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  input().dispatchEvent(esc);
  await window.__sleep(120);
  T("closed_after_escape", !isOpen());
  T("cleared_after_escape", input().value);
`;

test("search opens from the glass and closes on a tap away", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "search-toggle", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the glass is the resting state", () => {
    assert.equal(r.glass_exists, true, "there is no magnifying glass to tap");
    assert.equal(r.closed_at_rest, true, "the field is still permanently open");
    assert.equal(r.glass_visible_at_rest, true);
  });

  await t.test("tapping it opens the field, focused and ready", () => {
    assert.equal(r.open_after_tap, true);
    assert.equal(r.focused_on_open, true,
      "the field opened without focus — that is a second tap for no reason");
    assert.equal(r.glass_hidden_when_open, true,
      "the glass and the field are both in the bar at once");
    assert.equal(r.aria_expanded_open, "true");
  });

  await t.test("typing still searches", () => {
    // The whole feature is worthless if the plumbing broke behind the new
    // affordance.
    assert.equal(r.searched, true, "opening the field stopped the search working");
  });

  await t.test("THE one: tapping away closes AND clears", () => {
    assert.equal(r.closed_after_tap_away, true, "a tap outside did not close the field");
    assert.equal(r.cleared_after_tap_away, "",
      "the field closed still holding its query — reopening it would show a " +
      "search box full of text with no results behind it");
    assert.equal(r.glass_back, true);
    assert.equal(r.aria_expanded_closed, "false");
  });

  await t.test("a tap inside the field is not a dismissal", () => {
    // The containment test is on the whole #topbar-search container, so the
    // X button and the status text count as inside. Getting this wrong makes
    // the clear button close the bar instead of clearing it.
    assert.equal(r.stayed_open_on_inside_tap, true,
      "tapping the input itself closed the search");
    assert.equal(r.kept_text_on_inside_tap, "keep");
  });

  await t.test("Escape does the same thing as tapping away", () => {
    assert.equal(r.closed_after_escape, true);
    assert.equal(r.cleared_after_escape, "");
  });

  await t.test("the top bar no longer changes height between screens", () => {
    // MEASURED. The old permanently-present box was 48px tall against 40px
    // icon buttons, so the header was one height on Home and another
    // everywhere else. Open, it may legitimately grow; closed, it must match
    // the icon-button row.
    assert.ok(r.topbar_h_closed > 0, "the topbar did not render");
    assert.ok(r.topbar_h_closed <= 44,
      "the collapsed topbar is " + r.topbar_h_closed + "px — the search box is " +
      "still setting the row height even while closed");
  });
});

// ---------------------------------------------------------------------------
// v1.7.50: two bugs the v1.7.48 review found in the Home Screen settings page.
//
// Both shipped because `test/unit/homerows.test.js` covers only the SERVER's
// layout-repair rules. Nothing exercised the client, and both failures are
// invisible in a screenshot of the settings sheet — the switch moves, the row
// just never comes back.
//
//   1. applyHomeLayout only ever ADDED `.hidden`. Switching a row off worked;
//      switching it back on did nothing, because no code removed the class and
//      the row renderers write into the carousel div rather than the section
//      wrapper. The row stayed gone until a full reload.
//
//   2. After the first save, the server's reply REPLACED the draft array with
//      freshly built objects — orphaning every checkbox handler that closed
//      over the old ones. The second toggle in a session mutated a discarded
//      object, and the POST went out with the old value. The sheet lied.
// ---------------------------------------------------------------------------

const ROWS_STUB = `
window.__saved = [];
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/settings/home-rows") > -1) {
    if (opts && opts.method === "POST") {
      var body = JSON.parse(opts.body);
      window.__saved.push(body.rows);
      // Answer with NEW objects, exactly as the server does — this is what
      // orphaned the handlers.
      return window.__json({ ok: true, rows: body.rows.map(function (r) {
        return { id: r.id, on: r.on !== false };
      }) });
    }
    return window.__json({ rows: [
      { id: "unplayed", on: true }, { id: "history", on: true },
      { id: "picks", on: true }, { id: "random", on: true },
      { id: "library", on: true }, { id: "lotw", on: true },
      { id: "genres", on: true }
    ] });
  }
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [{ offset: 0, title: "A", subtitle: "B", image_key: "k" }], total: 1 });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: [{ offset: 0, title: "A", subtitle: "B", image_key: "k" }], offset: 0, total: 1 });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Z", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;

const ROWS_DRIVER = `
  await window.__sleep(500);

  function section(id) { return document.querySelector('[data-row="' + id + '"]'); }
  function shown(id) { var s = section(id); return !!s && !s.classList.contains("hidden"); }

  T("random_shown_initially", shown("random"));

  // Open Settings -> Home Screen.
  document.getElementById("settings-toggle").click();
  await window.__sleep(200);
  var nav = Array.prototype.find.call(
    document.querySelectorAll(".settings-nav-item"),
    function (b) { return b.getAttribute("data-pane") === "homescreen"; });
  T("home_pane_exists", !!nav);
  nav.click();
  await window.__sleep(300);

  var items = document.querySelectorAll("#home-rows-list .home-row-item");
  T("rows_listed", items.length);

  function boxFor(id) {
    var li = document.querySelector('#home-rows-list .home-row-item[data-row="' + id + '"]');
    return li ? li.querySelector('input[type="checkbox"]') : null;
  }

  // ---- switch Random off, then back on --------------------------------
  boxFor("random").click();
  await window.__sleep(300);
  T("random_hidden_after_off", !shown("random"));

  boxFor("random").click();
  await window.__sleep(300);
  T("random_shown_after_on_again", shown("random"));

  // ---- a SECOND, different toggle must still reach the server ---------
  boxFor("library").click();
  await window.__sleep(300);
  var last = window.__saved[window.__saved.length - 1] || [];
  var lib = last.filter(function (r) { return r.id === "library"; })[0];
  T("second_toggle_sent", lib ? lib.on : null);
  T("library_hidden", !shown("library"));
`;

test("the Home Screen settings list actually controls the Home screen",
  { concurrency: 1 }, async (t) => {
    const r = harness.renderPage({
      stub: ROWS_STUB, driver: ROWS_DRIVER, name: "home-rows", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the page lists every row", () => {
      assert.equal(r.home_pane_exists, true, "the Home Screen settings page is missing");
      assert.equal(r.rows_listed, 7);
    });

    await t.test("switching a row off hides it", () => {
      assert.equal(r.random_shown_initially, true);
      assert.equal(r.random_hidden_after_off, true);
    });

    await t.test("THE one: switching it back on brings it back", () => {
      assert.equal(r.random_shown_after_on_again, true,
        "a row switched off could not be switched back on — applyHomeLayout " +
        "only ever ADDED .hidden, so nothing removed it until a reload");
    });

    await t.test("THE other one: the second toggle is not silently dropped", () => {
      assert.equal(r.second_toggle_sent, false,
        "the second switch in a session sent the OLD value — the server's " +
        "reply replaced the draft array and orphaned every checkbox handler");
      assert.equal(r.library_hidden, true);
    });
  });

// ---------------------------------------------------------------------------
// v1.7.54: the glass belongs on the RIGHT of the top bar, at every width.
//
// It shipped beside the hamburger on the left, which is where the always-open
// search box used to live — sensible when the box owned the whole bar, wrong
// once it collapsed to a single icon, because the left cluster is the
// navigation cluster (menu / back) and the icon read as a third nav control.
//
// Measured rather than asserted from the stylesheet, because the rule that
// places it is an auto margin sharing a row with a grow factor, and which of
// those wins is not visible in the source. It is the grow factor: auto margins
// only divide the space still free after flexible lengths resolve, so the
// collapsed glass sits right AND the opened field still fills the bar. Both
// halves of that are measured, because reading the CSS gets it wrong.
// ---------------------------------------------------------------------------
const GLASS_DRIVER = `
  await window.__sleep(400);
  var row   = document.querySelector(".topbar-row");
  var wrap  = document.getElementById("topbar-search");
  var glass = document.getElementById("search-open");
  var menu  = document.getElementById("menu-toggle");
  var b = row.getBoundingClientRect();
  var g = glass.getBoundingClientRect();
  var m = menu.getBoundingClientRect();
  T("row_w", Math.round(b.width));
  T("visible", !wrap.classList.contains("hidden"));
  T("right_gap", Math.round(b.right - g.right));
  T("glass_left_of_row", Math.round(g.left - b.left));
  T("clears_menu", Math.round(g.left - m.right));
  T("closed_w", Math.round(wrap.getBoundingClientRect().width));

  glass.click();
  await window.__sleep(150);
  var o = wrap.getBoundingClientRect();
  T("open_w", Math.round(o.width));
  T("open_right_gap", Math.round(b.right - o.right));
`;

test("the search glass sits at the right of the top bar at every width",
  { concurrency: 1 }, async (t) => {
    for (const size of ["360x780", "390x844", "768x1024", "1280x900"]) {
      await t.test(size + ": glass hugs the right edge and the field grows to fill", () => {
        const r = harness.renderPage({
          stub: STUB, driver: GLASS_DRIVER, name: "glass-right-" + size.split("x")[0],
          windowSize: size,
        });
        harness.assertNoPageError(assert, r);
        assert.equal(r.visible, true, "the search container is not shown on Home at " + size);

        assert.ok(r.right_gap <= 4,
          "the glass is " + r.right_gap + "px off the right edge at " + size);

        // The direction of the move, stated as the thing that was wrong: it used
        // to sit immediately after the hamburger, so its left offset was a
        // handful of pixels regardless of how wide the window got.
        assert.ok(r.glass_left_of_row > r.row_w / 2,
          "at " + size + " the glass starts " + r.glass_left_of_row + "px into a " +
          r.row_w + "px bar — it is still parked in the left-hand nav cluster");
        assert.ok(r.clears_menu > 0, "the glass overlaps the hamburger at " + size);

        // Right-anchoring must not cost the open field its width. Everything in
        // the row but the hamburger is hidden on Home, so a field that grows
        // properly reaches within one button-and-gap of the left edge.
        assert.ok(r.open_w >= r.row_w - 80,
          "the opened field is " + r.open_w + "px in a " + r.row_w + "px bar at " + size +
          " — it stayed near its collapsed " + r.closed_w + "px instead of filling the row");
        assert.ok(r.open_right_gap <= 4,
          "the opened field left " + r.open_right_gap + "px at the right edge at " + size +
          " — it should grow leftwards from where the glass was");
      });
    }
  });
