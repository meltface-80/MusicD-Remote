"use strict";
// ---------------------------------------------------------------------------
// v1.8.66: step to the previous / next album from the album view.
//
// Asked for on the Roon forum: "When looking at a detail card, I'd love to be
// able to swipe left or right to see previous/next … it's so clunky to go back
// to the page and click the next one if you can avoid it."
//
// Previous and next are the album tiles either side of the one the card was
// opened from. A step clicks that tile, because each screen opens its albums
// its own way — Home's tiles insist on full-library offsets, a genre wall's
// resolve inside the genre — so the test checks the REQUEST each step makes,
// not only the title on screen: a step that opened the right title through the
// wrong list would play the wrong album.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const tile = (offset, title, subtitle) => ({ offset, title, subtitle, image_key: "k" + offset });
const LIB = [tile(10, "Alpha", "Ann"), tile(11, "Bravo", "Bob"), tile(12, "Charlie", "Cy"), tile(13, "Delta", "Di")];
const GENRE = [tile(70, "Kind of Blue", "Miles Davis"), tile(71, "Blue Train", "John Coltrane"), tile(72, "Moanin'", "Art Blakey")];
const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  settings: { shuffle: false, loop: "disabled", auto_radio: false }, queue_items_remaining: 1,
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: { line1: "So What", line2: "Miles Davis", line3: "Kind of Blue", artists: [], length: 300, seek_position: 3 },
};

const STUB = `
window.__albumAsks = [];
window.__lib = window.__libOverride || ${JSON.stringify(LIB)};
window.__rev = { snapshot: "1", library: "1", dates: "1", plays: "1", settings: "1",
                 labels: "1", picks: "1", discover: "1", day: "1" };
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.removeItem("rra-home-cache-v1");
  localStorage.removeItem("rra-library-view");
  localStorage.removeItem("rra-filter");
} catch (e) { /* storage optional here */ }
window.__installFetch(function (url) {
  var q = new URLSearchParams(url.split("?")[1] || "");
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 4, dated: 0, decades: [], sources: [], hasPlays: false });
  // Live answers only where a test asks for them (window.__liveOn).
  if (window.__liveOn && url.indexOf("/api/live") > -1)
    return window.__json({ rev: JSON.parse(JSON.stringify(window.__rev)) });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: window.__lib, offset: 0, total: window.__lib.length });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: q.get("filter_type") ? ${JSON.stringify(GENRE)} : ${JSON.stringify(LIB)},
                           total: 4, filtered: !!q.get("filter_type") });
  if (url.indexOf("/api/home/unplayed") > -1)
    return window.__json({ albums: ${JSON.stringify(LIB.slice(0, 2))}, total: 2 });
  if (url.indexOf("/api/home/album-of-the-day") > -1) return window.__json({ album: ${JSON.stringify(tile(99, "Today", "Tess"))} });
  if (url.indexOf("/api/album/extras") > -1) return window.__json({ year: 2001 });
  if (url.indexOf("/api/album/release-date") > -1) return window.__json({ release_date: null });
  if (url.indexOf("/api/album?") > -1) {
    window.__albumAsks.push({ offset: q.get("offset"), title: q.get("title"), filter: q.get("filter_type") || null });
    return window.__json({ title: q.get("title"), subtitle: q.get("subtitle"), image_key: "k",
      actions: [{ kind: "play_now", title: "Play Now" }], tracks: [{ title: "One", subtitle: "x" }] });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;

const HELPERS = `
  var modal = document.getElementById("album-modal");
  function title() { return document.getElementById("modal-title").textContent; }
  // Rendered, not merely un-classed: on screen with a size.
  function shown(id) {
    var el = document.getElementById(id);
    var b = el.getBoundingClientRect();
    return getComputedStyle(el).display !== "none" && b.width > 0 && b.height > 0;
  }
  // What a finger at the middle of the element would actually press.
  function hits(id) {
    var el = document.getElementById(id), b = el.getBoundingClientRect();
    var top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!top && (top === el || el.contains(top));
  }
  function open() { return !modal.classList.contains("hidden"); }
  function tileIn(rowId, name) {
    var tiles = document.querySelectorAll("#" + rowId + " .album");
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i].querySelector(".album-title");
      if (t && t.textContent === name) return tiles[i];
    }
    return null;
  }
  // A one-finger drag on the card, from (x0, y) to (x1, y + dy). drag() keeps
  // the finger down and reports what the card looks like mid-gesture; the
  // caller then lifts it with the lift function it returns.
  function touch(type, x, yy) {
    var body = modal.querySelector(".modal-body");
    var t = new Touch({ identifier: 1, target: body, clientX: x, clientY: yy });
    var list = type === "touchend" ? [] : [t];
    body.dispatchEvent(new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: [t],
                                              bubbles: true, cancelable: true }));
  }
  function drag(x0, x1, dy) {
    var y = 420, steps = 6;
    touch("touchstart", x0, y);
    for (var i = 1; i <= steps; i++) touch("touchmove", x0 + (x1 - x0) * i / steps, y + (dy || 0) * i / steps);
    return {
      cardShift: modal.querySelector(".modal-body").style.transform || "",
      lift: function () { touch("touchend", x1, y + (dy || 0)); },
    };
  }
  function swipe(x0, x1, dy) { drag(x0, x1, dy).lift(); }
`;

test("the album view steps to the albums either side of the one it came from", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "album-steps-home", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      tileIn("home-library", "Bravo").click();
      await window.__sleep(500);
      T("opened", title());
      T("hints_mid", [shown("modal-prev"), shown("modal-next")]);
      T("hints_tappable", [hits("modal-prev"), hits("modal-next")]);

      document.getElementById("modal-next").click();
      await window.__sleep(700);
      T("after_next", title());

      (document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await window.__sleep(700);
      T("after_key", title());
      T("hints_end", [shown("modal-prev"), shown("modal-next")]);

      swipe(300, 120, 8);                     // right to left: towards the NEXT album — there is none
      await window.__sleep(700);
      T("after_swipe_at_end", title());       // nothing after Delta

      swipe(120, 300, 6);                     // rightwards: back to the previous album
      await window.__sleep(700);
      T("after_swipe_back", title());

      var sideways = drag(300, 250, 4);        // the card follows a sideways drag…
      T("follows_sideways", sideways.cardShift);
      sideways.lift();                         // …and springs back when it is too short to step
                                               // (50px: a step needs 18% of the width, 70px here)
      await window.__sleep(800);
      T("after_short", title());
      var pinch = drag(300, 250, 2);           // a second finger lands mid-drag…
      T("pinch_moved", pinch.cardShift);
      (function () {
        var body = modal.querySelector(".modal-body");
        var a = new Touch({ identifier: 1, target: body, clientX: 250, clientY: 422 });
        var b = new Touch({ identifier: 2, target: body, clientX: 120, clientY: 500 });
        body.dispatchEvent(new TouchEvent("touchstart", { touches: [a, b], targetTouches: [a, b],
                                                          changedTouches: [b], bubbles: true, cancelable: true }));
      })();
      T("pinch_card", modal.querySelector(".modal-body").style.transform || "");
      pinch.lift();
      await window.__sleep(500);
      T("after_pinch", title());
      var vertical = drag(260, 170, 320);      // mostly vertical: a scroll, not a step
      T("follows_vertical", vertical.cardShift);
      vertical.lift();
      await window.__sleep(500);
      T("after_vertical", title());

      swipe(10, 250, 0);                      // from the screen's very edge: the system's, not ours
      await window.__sleep(500);
      T("after_edge", title());

      T("asks", window.__albumAsks);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("opens with both ways open in the middle of the row", () => {
    assert.equal(r.opened, "Bravo");
    assert.deepEqual(r.hints_mid, [true, true]);
    assert.deepEqual(r.hints_tappable, [true, true],
      "a chevron is drawn but something else on the cover takes the tap");
  });
  await t.test("the chevron and the arrow key step forward", () => {
    assert.equal(r.after_next, "Charlie");
    assert.equal(r.after_key, "Delta");
  });
  await t.test("at the end of the row there is no next — hint gone, swipe does nothing", () => {
    assert.deepEqual(r.hints_end, [true, false]);
    assert.equal(r.after_swipe_at_end, "Delta");
  });
  await t.test("a swipe the other way steps back", () => {
    assert.equal(r.after_swipe_back, "Charlie");
  });
  await t.test("the card follows a sideways drag, and a short one springs back", () => {
    assert.match(r.follows_sideways, /translateX\(-?\d+px\)/, "the card did not move with the finger");
    assert.equal(r.after_short, "Charlie");
  });
  await t.test("a second finger ends the swipe and puts the card back", () => {
    assert.match(r.pinch_moved, /translateX\(-?\d+px\)/);
    assert.equal(r.pinch_card, "", "the card was left shifted when a second finger landed");
    assert.equal(r.after_pinch, "Charlie");
  });
  await t.test("a vertical drag and a drag from the screen's edge are not steps", () => {
    assert.equal(r.follows_vertical, "", "a vertical scroll dragged the card sideways");
    assert.equal(r.after_vertical, "Charlie");
    assert.equal(r.after_edge, "Charlie");
  });
  await t.test("every step opened its album the way Home's tiles do (full-library offsets)", () => {
    assert.deepEqual(r.asks.map(a => [a.offset, a.title, a.filter]),
      [["11", "Bravo", null], ["12", "Charlie", null], ["13", "Delta", null], ["12", "Charlie", null]]);
  });
});

test("a step on a genre wall opens the album inside the genre, as its tile does", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "album-steps-genre", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      window.__applyFilter({ type: "genre", value: "Jazz" });
      await window.__sleep(900);
      var tiles = document.querySelectorAll("#album-grid .album");
      tiles[0].click();
      await window.__sleep(500);
      document.getElementById("modal-next").click();
      await window.__sleep(700);
      T("title", title());
      T("asks", window.__albumAsks);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the second album was asked for through the genre", () => {
    assert.equal(r.title, "Blue Train");
    assert.deepEqual(r.asks.map(a => [a.offset, a.filter]), [["70", "genre"], ["71", "genre"]],
      "a step bypassed the tile's own opener and asked for the album outside its list");
  });
});

test("only albums are stepped to, and never from Now playing", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "album-steps-edges", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      // Not played: "Play something unheard", then Album of the day, then albums.
      tileIn("home-unplayed", "Today").click();
      await window.__sleep(500);
      T("aotd_hints", [shown("modal-prev"), shown("modal-next")]);
      document.getElementById("modal-next").click();
      await window.__sleep(700);
      T("after_aotd", title());
      // A sheet over the card (an import, an add-to-playlist): the keys are its.
      window.__openImportSheet();
      await window.__sleep(300);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await window.__sleep(500);
      T("under_sheet", title());
      document.querySelector(".lib-sheet-backdrop").remove();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await window.__sleep(500);
      T("sheet_gone", title());
      // A track selection being made (long press on a row): a stray swipe or
      // arrow key must not take the user's picks off the screen.
      var row = document.querySelector("#modal-tracks li");
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await window.__sleep(700);
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await window.__sleep(100);
      T("selecting", modal.querySelectorAll("#modal-tracks .t-mark").length > 0 &&
                     getComputedStyle(modal.querySelector("#modal-tracks .t-mark")).display !== "none");
      T("sel_hints", [shown("modal-prev"), shown("modal-next")]);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await window.__sleep(300);
      swipe(300, 100, 0);
      await window.__sleep(500);
      T("sel_title", title());
      document.querySelector("#album-modal [data-close]").click();
      await window.__sleep(300);
      // Now playing is the zone's screen, not a list.
      var bar = document.getElementById("mini-transport");
      for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(600);
      T("np_mode", modal.classList.contains("np-mode"));
      T("np_hints", [shown("modal-prev"), shown("modal-next")]);
      var before = title();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await window.__sleep(500);
      T("np_after_key", title() === before);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the 'Play something unheard' tile is not an album to step back to", () => {
    assert.deepEqual(r.aotd_hints, [false, true]);
    assert.equal(r.after_aotd, "Alpha");
  });
  await t.test("no step while a track selection is being made", () => {
    assert.equal(r.selecting, true, "the long press did not start a selection, so this measures nothing");
    assert.deepEqual(r.sel_hints, [false, false]);
    assert.equal(r.sel_title, "Bravo", "a step took the selection being made off the screen");
  });
  await t.test("the arrow keys do not change the album under a sheet opened over it", () => {
    assert.equal(r.under_sheet, "Alpha", "the album changed underneath an open sheet");
    assert.equal(r.sheet_gone, "Bravo");
  });
  await t.test("Now playing has no steps", () => {
    assert.equal(r.np_mode, true);
    assert.deepEqual(r.np_hints, [false, false]);
    assert.equal(r.np_after_key, true);
  });
});

test("the steps follow the row when it changes under an open album", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "album-steps-live", windowSize: "390x844", stub: "window.__liveOn = true;\n" + STUB,
    budgetMs: 30000,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      tileIn("home-library", "Delta").click();
      await window.__sleep(500);
      T("before", [shown("modal-prev"), shown("modal-next")]);
      // An album added to the library while Delta is open: the row behind the
      // card re-reads itself (v1.8.65) and Echo now sits after Delta.
      window.__lib = window.__lib.concat([{ offset: 14, title: "Echo", subtitle: "Ed", image_key: "k14" }]);
      window.__rev.library = "2";
      await window.__sleep(6000);
      T("row", Array.prototype.map.call(document.querySelectorAll("#home-library .album-title"),
                                        function (e) { return e.textContent; }));
      T("after", [shown("modal-prev"), shown("modal-next")]);
      document.getElementById("modal-next").click();
      await window.__sleep(700);
      T("stepped", title());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the next hint appears once there is a next", () => {
    assert.deepEqual(r.before, [true, false]);
    assert.deepEqual(r.row, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"], "the row never re-read");
    assert.deepEqual(r.after, [true, true], "the hint still describes the row as it was when the album opened");
    assert.equal(r.stepped, "Echo");
  });
});

test("a step keeps the album it lands on in view behind the card, clear of the top bar", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const MANY = Array.from({ length: 30 }, (_, i) => tile(100 + i, "Album " + (i + 1), "Artist " + (i + 1)));
  const r = harness.renderPage({
    name: "album-steps-reveal", windowSize: "390x844",
    stub: "window.__libOverride = " + JSON.stringify(MANY) + ";\n" + STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      document.getElementById("home-library-title").click();
      await window.__sleep(1200);
      var main = document.querySelector("main");
      var tiles = document.querySelectorAll("#album-grid .album");
      T("count", tiles.length);
      tiles[10].click();
      await window.__sleep(500);
      // The open album's tile parked right at the top of the list, under the
      // translucent bar; the one before it is under the bar or above the screen.
      main.scrollTop += tiles[10].getBoundingClientRect().top - main.getBoundingClientRect().top - 2;
      document.getElementById("modal-prev").click();
      await window.__sleep(700);
      T("title", title());
      T("bar", parseFloat(getComputedStyle(main).getPropertyValue("--topbar-h")) || 0);
      T("top", Math.round(tiles[9].getBoundingClientRect().top - main.getBoundingClientRect().top));
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the previous album's tile is brought out from under the top bar", () => {
    assert.equal(r.count, 30);
    assert.equal(r.title, "Album 10");
    assert.ok(r.bar > 20, "the harness reported no top bar height (" + r.bar + "), so this measures nothing");
    assert.ok(r.top >= r.bar, "the tile was revealed at " + r.top + "px, under the " + r.bar + "px top bar");
  });
});

test("on a desktop-width screen the chevrons are on the cover and take the click", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  // Two columns at this width: the cover is a 320px square beside the tracks,
  // not the full-bleed hero, and the dialog's own buttons sit at its corners.
  const r = harness.renderPage({
    name: "album-steps-desktop", windowSize: "1400x900", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      tileIn("home-library", "Bravo").click();
      await window.__sleep(500);
      var art = modal.querySelector(".modal-art").getBoundingClientRect();
      function inside(id) {
        var b = document.getElementById(id).getBoundingClientRect();
        return b.left >= art.left && b.right <= art.right && b.top >= art.top && b.bottom <= art.bottom;
      }
      T("shown", [shown("modal-prev"), shown("modal-next")]);
      T("on_cover", [inside("modal-prev"), inside("modal-next")]);
      T("tappable", [hits("modal-prev"), hits("modal-next")]);
      document.getElementById("modal-next").click();
      await window.__sleep(700);
      T("after", title());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("both drawn, inside the cover, and on top", () => {
    assert.deepEqual(r.shown, [true, true]);
    assert.deepEqual(r.on_cover, [true, true]);
    assert.deepEqual(r.tappable, [true, true]);
    assert.equal(r.after, "Charlie");
  });
});
