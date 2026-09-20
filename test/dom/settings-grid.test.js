"use strict";
// ---------------------------------------------------------------------------
// v1.8.27: the Settings landing as two columns of cards.
//
// It was one full-width row per category — icon, title, description, caret.
// Nine categories filled the sheet, and the Share Card pages take it past a
// dozen. Two columns of icon-over-title cards halve the height; the caret went
// (nothing else on the tile was tappable, so it pointed at itself) and the
// description MOVED into the panel it describes.
//
// Three things are worth pinning, and only one of them is the layout:
//
//   1. Two columns, measured from the tiles' own boxes, with no sideways
//      scroll. A grid track's default min-width is its CONTENT, so `1fr`
//      alone lets a long title push its column past its share and the sheet
//      scrolls sideways — the reason for minmax(0, 1fr).
//   2. Every tile reaches a panel and every panel has a tile. This is the
//      assertion that earns its keep as categories are added: a new tile whose
//      data-pane is misspelt is a dead button, and a new panel with no tile is
//      unreachable. Neither shows up in a screenshot.
//   3. The description moved rather than being copied — no tile still carries
//      one, every panel has one. CLAUDE.md: no partial migrations.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const STUB = `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u) {
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(600);
  document.getElementById("settings-overlay").classList.remove("hidden");
  await window.__sleep(300);

  var nav = document.querySelector(".settings-nav");
  var items = Array.prototype.slice.call(document.querySelectorAll(".settings-nav-item"));
  T("count", items.length);

  // Boxes, all from this one frame.
  T("boxes", items.map(function (b) {
    var r = b.getBoundingClientRect();
    return { pane: b.getAttribute("data-pane"),
             x: Math.round(r.left), y: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height) };
  }));
  T("nav_overflow", nav.scrollWidth - nav.clientWidth);

  // The minmax(0,1fr) guard, exercised rather than assumed. Today's titles all
  // fit, so a plain 1fr passes every measurement above — the track only widens
  // past its share once something in it cannot shrink. One long unbreakable
  // title is that something, and it is what a new category could arrive with.
  var victim = document.querySelector('.settings-nav-item .settings-nav-title');
  var realTitle = victim.textContent;
  victim.textContent = "Supercalifragilisticexpialidocious";
  await window.__sleep(120);
  T("overflow_with_long_title", nav.scrollWidth - nav.clientWidth);
  var boxesLong = Array.prototype.map.call(document.querySelectorAll(".settings-nav-item"),
    function (b) { return Math.round(b.getBoundingClientRect().width); });
  T("widths_with_long_title", boxesLong);
  victim.textContent = realTitle;
  await window.__sleep(120);

  // Wiring: tiles vs panels.
  T("tile_panes",  items.map(function (b) { return b.getAttribute("data-pane"); }));
  T("panel_panes", Array.prototype.map.call(
      document.querySelectorAll('.settings-pane[data-pane]'),
      function (p) { return p.getAttribute("data-pane"); }));

  // The move, not a copy.
  T("tiles_with_desc",  document.querySelectorAll(".settings-nav-item .settings-nav-desc").length);
  T("tiles_with_caret", document.querySelectorAll(".settings-nav-item .settings-nav-caret").length);
  T("panels_with_desc", document.querySelectorAll(".settings-pane .settings-pane-desc").length);

  // And it still navigates: a tile opens its panel, Back returns to the grid.
  var first = document.querySelector('.settings-nav-item[data-pane="playback"]');
  first.click();
  await window.__sleep(300);
  var pane = document.querySelector('.settings-pane[data-pane="playback"]');
  T("pane_open", !pane.classList.contains("hidden"));
  T("pane_desc_text", (pane.querySelector(".settings-pane-desc") || {}).textContent || null);
  var back = pane.querySelector("[data-settings-back]");
  back.click();
  await window.__sleep(300);
  T("back_to_grid", !nav.closest(".settings-view").classList.contains("hidden"));
`;

function render(size) {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER,
                                 name: "settings-grid-" + size.split("x")[0], windowSize: size });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the Settings landing is a two-column grid that still reaches every panel", { concurrency: 1 }, async (t) => {
  await t.test("two columns at phone width, with no sideways scroll", () => {
    const r = render("390x844");
    assert.ok(r.count >= 9, "only " + r.count + " categories rendered");

    const [a, b, c] = r.boxes;
    assert.equal(a.y, b.y, "the first two tiles are on different rows (" + a.y + " vs " + b.y +
      ") — the landing is not laying out in two columns");
    assert.ok(b.x > a.x, "the second tile is not to the right of the first");
    assert.ok(c.y > a.y, "the third tile is still on the first row — that is three columns, not two");

    // Equal columns. minmax(0,1fr) is what holds this; plain 1fr lets a long
    // title widen its track and the pair stops matching.
    assert.ok(Math.abs(a.w - b.w) <= 1,
      "the two columns are " + a.w + "px and " + b.w + "px — they should be equal");
    assert.ok(r.nav_overflow <= 1,
      "the grid overflows its container by " + r.nav_overflow + "px, so Settings scrolls sideways");

    // A title that cannot wrap must not be able to widen its column. This is
    // the assertion minmax(0, 1fr) exists for; without it the column grows to
    // fit the word and the whole sheet scrolls sideways.
    assert.ok(r.overflow_with_long_title <= 1,
      "a long unbreakable title pushed the grid " + r.overflow_with_long_title +
      "px past its container. The columns need minmax(0, 1fr) — a grid track's " +
      "default min-width is its content, so plain 1fr lets one title widen its column.");
    const wide = r.widths_with_long_title;
    assert.ok(Math.max(...wide) - Math.min(...wide) <= 1,
      "with one long title the tiles measure " + wide.join(", ") +
      " — the columns stopped being equal");

    // Tap targets. A card that is short is worse than the row it replaced.
    for (const box of r.boxes) {
      assert.ok(box.h >= 44 && box.w >= 44,
        box.pane + " is " + box.w + "x" + box.h + " — under the 44px tap target");
    }
    // Every row matches in height, or the grid reads as broken.
    const byRow = new Map();
    for (const box of r.boxes) byRow.set(box.y, [...(byRow.get(box.y) || []), box]);
    for (const [y, row] of byRow) {
      if (row.length < 2) continue;
      assert.ok(Math.abs(row[0].h - row[1].h) <= 1,
        "the row at y=" + y + " has tiles of " + row[0].h + "px and " + row[1].h + "px");
    }
  });

  await t.test("every tile reaches a panel, and every panel has a tile", () => {
    const r = render("390x844");
    const tiles = [...r.tile_panes].sort();
    const panels = [...r.panel_panes].sort();
    assert.deepEqual(tiles, panels,
      "the Settings landing and its panels have drifted apart.\n" +
      "  tiles:  " + tiles.join(", ") + "\n" +
      "  panels: " + panels.join(", ") + "\n" +
      "A tile with no panel is a dead button; a panel with no tile cannot be opened.");
  });

  await t.test("the description moved into the panel rather than being copied", () => {
    const r = render("390x844");
    assert.equal(r.tiles_with_desc, 0,
      r.tiles_with_desc + " tiles still carry a description — the move is half done, and the " +
      "two copies will drift");
    assert.equal(r.tiles_with_caret, 0, "a tile still carries the caret the cards dropped");
    assert.equal(r.panels_with_desc, r.count,
      "only " + r.panels_with_desc + " of " + r.count + " panels got a description");
    assert.equal(r.pane_desc_text, "Output zone & random album radio",
      "the Playback panel's description is " + JSON.stringify(r.pane_desc_text));
  });

  await t.test("a tile opens its panel and Back returns to the grid", () => {
    const r = render("390x844");
    assert.equal(r.pane_open, true, "tapping a tile did not open its panel");
    assert.equal(r.back_to_grid, true, "Back from a panel did not return to the grid");
  });

  await t.test("it stays two columns on a tablet", () => {
    const r = render("768x1024");
    const [a, b, c] = r.boxes;
    assert.equal(a.y, b.y, "not two per row at 768px");
    assert.ok(c.y > a.y, "three or more per row at 768px");
    assert.ok(r.nav_overflow <= 1, "sideways overflow of " + r.nav_overflow + "px at 768px");
  });
});
