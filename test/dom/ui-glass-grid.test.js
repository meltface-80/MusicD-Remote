"use strict";
// ---------------------------------------------------------------------------
// v1.7.81: the UI pass — one grid everywhere, a list mode, and a glass pill.
//
// Three of these are ordinary UI assertions. The fourth is not:
//
// The transport's backdrop blur was REMOVED in v1.6.15 because iOS Safari
// re-blurs everything beneath it on every scroll frame, and it was the main
// scroll-jank source while music was playing. v1.7.81 brought it back and
// stripped it for the duration of each scroll so the look and the frame rate
// could coexist; v1.7.84 stopped the background changing with it, on the
// reasoning that two states differing only by a blur would be invisible.
//
// They were not, and the reason is worth writing down, because it is the part
// that was wrong twice: `saturate(180%)` DOES NOT ONLY SOFTEN THE BACKDROP, IT
// BRIGHTENS IT. Whatever fraction of the page shows through the pill is vivid
// while the filter is on and muted while it is off — so the bar visibly changed
// face on every scroll no matter how opaque its background was. A wall of album
// covers is the worst case and is where it was reported, twice.
//
// There is no conditional filter that is invisible, and an unconditional one is
// the documented jank. So the pill has NO backdrop-filter, and that is pinned
// below: this suite cannot measure iOS frame rates, but it can measure that the
// bar has exactly one appearance.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// getComputedStyle gives "rgb(a, b, c)" or "rgba(a, b, c, x)". These two turn
// that into a comparable flat colour so a translucent surface can be checked
// against what it actually paints as.
function parse(v) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/
    .exec(String(v || "").trim());
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
const norm = (v) => { const c = parse(v); return c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : String(v); };
function over(fg, bg) {
  const f = parse(fg), b = parse(bg);
  if (!f || !b) return String(fg);
  const mix = (x, y) => Math.round(x * f.a + y * (1 - f.a));
  return `rgb(${mix(f.r, b.r)}, ${mix(f.g, b.g)}, ${mix(f.b, b.b)})`;
}

// Enough tiles that the wall is TALLER THAN THE SCREEN on a 390x844 phone.
// The clearance test below scrolls to the bottom and measures what is under the
// floating pill; with a wall that fits, there is nothing at the bottom to be
// covered and the test passes without ever exercising the thing it names.
const ALBUMS = [];
for (let i = 0; i < 30; i++) {
  ALBUMS.push({ offset: i, title: "Album " + i, subtitle: "Artist " + i, image_key: null });
}
const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: { line1: "Our First Trip", line2: "The Odyssey Cult", line3: "Vol. 3",
                 image_key: "cover-key", length: 212, seek_position: 40 },
};
const ZONE_NO_ART = JSON.parse(JSON.stringify(ZONE));
ZONE_NO_ART.now_playing.image_key = "";
ZONE_NO_ART.now_playing.line1 = "A Stream";

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.removeItem("rra-album-view");
  localStorage.removeItem("rra-transport");
} catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 30, filtered: false });
  if (u.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, offset: 0, total: 30 });
  if (u.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 30, dated: 0, decades: [], sources: [], hasPlays: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/settings") > -1)   return window.__json({});
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  return undefined;
});
`;

const HELPERS = `
  var grid = document.getElementById("album-grid");
  function tiles() { return grid.querySelectorAll(".album"); }
  function artWidth() {
    var a = grid.querySelector(".album .album-art-wrap");
    return a ? Math.round(a.getBoundingClientRect().width) : -1;
  }
  async function waitForTiles(n) {
    for (var i = 0; i < 60; i++) {
      if (tiles().length >= (n || 1)) return true;
      await window.__sleep(100);
    }
    return false;
  }
  async function openRandomWall() {
    document.getElementById("menu-toggle").click();
    await window.__sleep(250);
    document.querySelector('.menu-item[data-action="shuffle"]').click();
    await window.__sleep(700);
    await waitForTiles(3);
  }
`;

test("every album wall uses the same tile size", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The random wall used to measure the screen and SHRINK its artwork so four
  // rows fit without scrolling, which made it the one wall whose tiles were a
  // different size from all the others. Same width now, or the change did not
  // happen.
  const r = harness.renderPage({
    name: "ui-grid-parity", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      T("random_tiles", tiles().length);
      T("random_art", artWidth());
      T("random_fit_class", grid.className);
      T("random_phone_art_var", grid.style.getPropertyValue("--phone-art"));

      // Now the Library wall, through its own entry point.
      document.getElementById("topbar-back").click();
      await window.__sleep(500);
      document.getElementById("home-library-title").click();
      await window.__sleep(800);
      await waitForTiles(3);
      T("library_art", artWidth());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the random wall actually rendered", () => {
    assert.ok(r.random_tiles >= 3, `only ${r.random_tiles} tiles — the wall never loaded`);
  });

  await t.test("its artwork is the same width as the Library's", () => {
    assert.ok(r.random_art > 0 && r.library_art > 0,
      `could not measure (random ${r.random_art}, library ${r.library_art})`);
    assert.ok(Math.abs(r.random_art - r.library_art) <= 1,
      `random wall art is ${r.random_art}px, Library is ${r.library_art}px — the two ` +
      `walls are still sized differently`);
  });

  await t.test("and nothing fit-sizes the grid any more", () => {
    assert.ok(!/phone-fit/.test(r.random_fit_class),
      "the grid still carries the fit-to-screen class");
    assert.equal(r.random_phone_art_var, "",
      "the grid still has an inline --phone-art size on it");
  });
});

test("grid and list are one remembered choice", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "ui-list-mode", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      var btn = document.getElementById("topbar-view");
      T("btn_shown", !!btn && !btn.classList.contains("hidden"));
      T("grid_default", grid.className);

      var before = tiles()[0];
      btn.click();
      await window.__sleep(250);
      T("is_list", grid.classList.contains("as-list"));
      T("stored", (function () { try { return localStorage.getItem("rra-album-view"); }
                                catch (e) { return null; } })());
      T("pressed", btn.getAttribute("aria-pressed"));
      // The SAME node, not a rebuilt one: a re-render would drop every listener
      // on every tile (CLAUDE.md pre-flight step 4).
      T("same_node", tiles()[0] === before);

      // The SHAPE OF THE ROW ITSELF, not just its bounding box. A tile whose
      // children are still stacked in a column is a full-width block that is
      // comfortably wider than it is tall, so an aspect-ratio check calls it a
      // row and passes — which is exactly what shipped. What makes it a row is
      // the cover and the text being SIDE BY SIDE.
      var t0 = tiles()[0];
      var b  = t0.getBoundingClientRect();
      var a  = t0.querySelector(".album-art-wrap").getBoundingClientRect();
      var mt = t0.querySelector(".album-meta").getBoundingClientRect();
      T("row_shape", { w: Math.round(b.width), h: Math.round(b.height) });
      T("thumb", { w: Math.round(a.width), h: Math.round(a.height) });
      T("lay", {
        art_left:  Math.round(a.left),  art_right:  Math.round(a.right),
        meta_left: Math.round(mt.left), meta_right: Math.round(mt.right),
        art_mid:   Math.round(a.top + a.height / 2),
        meta_top:  Math.round(mt.top),  meta_bottom: Math.round(mt.bottom),
        row_left:  Math.round(b.left),  row_right:  Math.round(b.right),
      });
      T("rows_stack", (function () {
        // Two consecutive rows must not sit beside each other — that is a grid.
        var r0 = tiles()[0].getBoundingClientRect();
        var r1 = tiles()[1].getBoundingClientRect();
        return Math.round(r1.top - r0.top);
      })());

      btn.click();
      await window.__sleep(200);
      T("back_to_grid", !grid.classList.contains("as-list"));
      T("stored_after", (function () { try { return localStorage.getItem("rra-album-view"); }
                                       catch (e) { return null; } })());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the control is offered on an album wall", () => {
    assert.equal(r.btn_shown, true, "no grid/list control on the random wall");
    assert.ok(!/as-list/.test(r.grid_default), "the wall opens in list mode — grid is the default");
  });

  await t.test("switching to list restyles the tiles that are already there", () => {
    assert.equal(r.is_list, true);
    assert.equal(r.same_node, true,
      "the tiles were rebuilt to change view — that drops every listener on them");
    assert.ok(r.row_shape.w > r.row_shape.h * 2,
      `a list row is ${JSON.stringify(r.row_shape)} — that is still a grid cell`);
    assert.ok(r.thumb.w > 0 && Math.abs(r.thumb.w - r.thumb.h) <= 2,
      `the list thumbnail is ${JSON.stringify(r.thumb)} — it should be a small square`);

    // The cover is LEFT OF the text, not above it. This is the assertion the
    // first cut needed and did not have: `display: flex` on a tile that is
    // already flex-direction: column changes nothing about the axis, so the
    // cover stayed on top and align-items: center then centred the lot.
    const L = r.lay;
    assert.ok(L.art_right <= L.meta_left,
      `the cover ends at x=${L.art_right} and the text starts at x=${L.meta_left} — ` +
      `they are stacked, not side by side (${JSON.stringify(L)})`);
    // ...and beside means vertically level with it, not merely to one side.
    assert.ok(L.art_mid > L.meta_top && L.art_mid < L.meta_bottom,
      `the cover's middle (y=${L.art_mid}) is outside the text block ` +
      `(${L.meta_top}..${L.meta_bottom}) — the row is not level`);
    // The text takes the width the grid used to give the whole column.
    assert.ok(L.meta_right - L.meta_left > (L.row_right - L.row_left) * 0.5,
      `the text column is only ${L.meta_right - L.meta_left}px of a ` +
      `${L.row_right - L.row_left}px row`);
    // One row per line. In a grid, tile 1 sits beside tile 0 and this is 0.
    assert.ok(r.rows_stack >= r.row_shape.h - 2,
      `the next row starts ${r.rows_stack}px down a ${r.row_shape.h}px row — ` +
      `the rows are still laid out in columns`);
    assert.equal(r.pressed, "true");
  });

  await t.test("and the choice is remembered", () => {
    assert.equal(r.stored, "list");
    assert.equal(r.back_to_grid, true);
    assert.equal(r.stored_after, "grid");
  });
});

test("the mini transport shows what is playing", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "ui-transport-art", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(400);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      var art = document.getElementById("mt-art");
      T("art_exists", !!art);
      T("art_shown", !!art && !art.classList.contains("hidden"));
      T("art_src", art ? art.getAttribute("src") : null);
      var ab = art.getBoundingClientRect();
      T("art_box", { w: Math.round(ab.width), h: Math.round(ab.height) });
      // It opens Now playing, like the text beside it.
      T("art_inside_info", !!art.closest(".mt-info"));

      // A zone with no artwork must not leave a broken-image glyph behind.
      window.__zone = ${JSON.stringify(ZONE_NO_ART)};
      await window.__sleep(2200);
      T("art_hidden_when_none", document.getElementById("mt-art").classList.contains("hidden"));
      T("src_cleared", document.getElementById("mt-art").getAttribute("src"));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the cover is there, square, and points at the zone's art", () => {
    assert.equal(r.art_exists, true, "#mt-art is missing from the transport");
    assert.equal(r.art_shown, true);
    assert.match(String(r.art_src), /\/api\/image\/cover-key/);
    assert.ok(r.art_box.w >= 32 && Math.abs(r.art_box.w - r.art_box.h) <= 2,
      `the cover is ${JSON.stringify(r.art_box)} — it should be a square of a usable size`);
    assert.equal(r.art_inside_info, true,
      "the cover is outside .mt-info, so tapping it does not open Now playing");
  });

  await t.test("and it goes away when there is no artwork", () => {
    assert.equal(r.art_hidden_when_none, true,
      "an artless zone leaves the <img> showing — that draws a broken-image glyph");
    assert.equal(r.src_cleared, null);
  });
});

test("the transport has exactly one appearance", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // THE one that matters for something this suite cannot measure. See the file
  // header: a conditional backdrop-filter changed the bar's face on every
  // scroll, and an unconditional one is the documented iOS jank. So the pill
  // has none, and nothing about it may vary with scroll state.
  const r = harness.renderPage({
    name: "ui-glass-scroll", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);

      function face() {
        var c = getComputedStyle(bar);
        return { bg: c.backgroundColor,
                 filter: c.backdropFilter || c.webkitBackdropFilter || "none",
                 cls: bar.className };
      }
      T("rest", face());
      T("rest_radius", getComputedStyle(bar).borderTopLeftRadius);
      T("rest_left", Math.round(bar.getBoundingClientRect().left));

      var m = document.querySelector("main");
      m.scrollTop = 200;
      m.dispatchEvent(new Event("scroll", { bubbles: false }));
      await window.__sleep(60);
      T("scrolling", face());

      await window.__sleep(700);
      T("settled", face());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it is a translucent pane, and it floats", () => {
    assert.ok(parseFloat(r.rest_radius) >= 10,
      `corner radius is ${r.rest_radius} — a pill needs rounding`);
    assert.ok(r.rest_left > 0, "the bar is still welded to the left edge, not floating");
    // Translucent, or it is a slab and not glass at all.
    const a = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/
      .exec(String(r.rest.bg));
    const alpha = a ? (a[1] === undefined ? 1 : parseFloat(a[1])) : 1;
    assert.ok(alpha < 1, `the pill is fully opaque (${r.rest.bg}) — it is a slab, not a pane`);
    // ...but opaque enough that SHARP page content behind it reads as a tint.
    // There is no blur to soften it any more, so this floor is higher than the
    // one that applied while there was.
    assert.ok(alpha >= 0.9,
      `the pill is only ${alpha} opaque (${r.rest.bg}). Nothing blurs what shows ` +
      `through it now, so at this alpha a wall of album covers reads as clutter ` +
      `under the title`);
  });

  await t.test("THE one: no backdrop-filter, at any moment", () => {
    for (const [when, face] of [["at rest", r.rest], ["mid-scroll", r.scrolling],
                                ["after settling", r.settled]]) {
      assert.ok(!/blur|saturate/.test(String(face.filter)),
        `the pill has a backdrop-filter ${when} (${face.filter}). Unconditional, ` +
        `that is the iOS scroll jank v1.6.15 removed; conditional, it changes the ` +
        `bar's face on every scroll because saturate() brightens whatever shows ` +
        `through it — which was reported twice`);
    }
  });

  await t.test("and nothing else changes when the page moves", () => {
    assert.equal(r.scrolling.bg, r.rest.bg,
      `the bar is ${r.rest.bg} at rest and ${r.scrolling.bg} while scrolling`);
    assert.equal(r.settled.bg, r.rest.bg,
      `the bar is ${r.settled.bg} once the scroll stops and ${r.rest.bg} before it`);
    // No state class either: one that nothing styles is a scroll-frame handler
    // running for nothing, which is how the next conditional face gets added.
    assert.equal(r.scrolling.cls, r.rest.cls,
      `the bar's classes change on scroll (${r.rest.cls} -> ${r.scrolling.cls}) — ` +
      `there is a scroll listener still toggling state nothing renders`);
  });
});

test("the wall's controls sit in the top-right corner", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "ui-topbar-cluster", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      function box(id) {
        var el = document.getElementById(id);
        if (!el) return { missing: true };
        var b = el.getBoundingClientRect();
        return { hidden: el.classList.contains("hidden"),
                 left: Math.round(b.left), right: Math.round(b.right) };
      }
      function rowRight() {
        var row = document.querySelector(".topbar-row");
        return Math.round(row.getBoundingClientRect().right);
      }
      await window.__sleep(600);
      await openRandomWall();
      T("row_right", rowRight());
      T("random_view", box("topbar-view"));
      T("random_refresh", box("topbar-refresh"));

      document.getElementById("topbar-back").click();
      await window.__sleep(500);
      document.getElementById("home-library-title").click();
      await window.__sleep(800);
      await waitForTiles(3);
      T("library_view", box("topbar-view"));
      T("library_refresh", box("topbar-refresh"));
    `,
  });
  harness.assertNoPageError(assert, r);

  // "in the corner" = its right edge is at the row's right edge, allowing for
  // the button's own optical padding.
  const CORNER = 8;

  await t.test("on the random wall: view in the corner, refresh beside it", () => {
    assert.equal(r.random_view.hidden, false, "no grid/list control on the random wall");
    assert.equal(r.random_refresh.hidden, false, "no refresh control on the random wall");
    assert.ok(r.row_right - r.random_view.right <= CORNER,
      `the view control's right edge is at ${r.random_view.right}, the row ends at ` +
      `${r.row_right} — it is not in the corner`);
    assert.ok(r.random_refresh.right <= r.random_view.left,
      `refresh (…${r.random_refresh.right}) is not to the left of the view control ` +
      `(${r.random_view.left}… ) — the pair is in the wrong order`);
    // Beside it, not marooned at the other end of the bar.
    assert.ok(r.random_view.left - r.random_refresh.right <= 16,
      `there are ${r.random_view.left - r.random_refresh.right}px between refresh and ` +
      `the view control — they should read as one cluster`);
  });

  await t.test("on the Library wall: view takes the corner alone", () => {
    assert.equal(r.library_view.hidden, false, "no grid/list control on the Library wall");
    assert.equal(r.library_refresh.hidden, true,
      "the Library wall is showing a shuffle button — there is nothing to reshuffle");
    assert.ok(r.row_right - r.library_view.right <= CORNER,
      `with refresh hidden the view control fell back to ${r.library_view.right} ` +
      `instead of the row's edge at ${r.row_right} — the hidden sibling kept the push`);
  });
});

test("nothing is left under the floating transport", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The pill floats over <main>, so the space it occupies has to be reserved by
  // main's padding-bottom. Get that number wrong in either direction and it
  // shows: too small and the last row's title is behind the glass (what was
  // reported), too large and there is a band of nothing above the pill.
  const r = harness.renderPage({
    name: "ui-transport-clearance", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);

      var m = document.querySelector("main");
      m.scrollTop = m.scrollHeight;
      await window.__sleep(400);
      T("scrolled", Math.round(m.scrollTop) > 0);
      T("really_at_bottom",
        Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) <= 2);

      var all = tiles();
      var last = all[all.length - 1];
      var meta = last.querySelector(".album-meta").getBoundingClientRect();
      var pill = bar.getBoundingClientRect();
      T("gap", Math.round(pill.top - meta.bottom));
      T("pill", { top: Math.round(pill.top), h: Math.round(pill.height),
                  left: Math.round(pill.left),
                  bottom_gap: Math.round(window.innerHeight - pill.bottom) });
      // How much of the pill is glass around its contents. The reported symptom
      // was dead space, and the cover is the tallest thing inside it.
      var art = document.getElementById("mt-art").getBoundingClientRect();
      T("art_h", Math.round(art.height));
      // The cover must be the pill's HEIGHT DRIVER — nothing inside taller than
      // it. That is the rule that stops the bar growing by padding: to make it
      // taller you make the artwork bigger, and the space is cover, not glass.
      T("tallest_child", (function () {
        var max = 0, who = "";
        var kids = document.getElementById("mini-transport").querySelectorAll(
          ".mt-art, .mt-btn, .mt-playpause, .mt-info, .mt-controls, .mt-text");
        for (var i = 0; i < kids.length; i++) {
          var h = kids[i].getBoundingClientRect().height;
          if (h > max) { max = h; who = kids[i].className; }
        }
        return { h: Math.round(max), who: String(who) };
      })());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the wall really did scroll to its end", () => {
    assert.equal(r.scrolled, true, "the fixture wall fits on screen — nothing was tested");
    assert.equal(r.really_at_bottom, true, "the scroller did not reach the bottom");
  });

  await t.test("the last album's details clear the pill", () => {
    assert.ok(r.gap >= 0,
      `the last album's text runs ${-r.gap}px underneath the transport — main's ` +
      `padding-bottom does not reserve the pill's height`);
  });

  await t.test("and the reserve is not wildly generous either", () => {
    assert.ok(r.gap <= 44,
      `there are ${r.gap}px of empty page between the last album and the pill — ` +
      `main is reserving far more room than the pill occupies (${r.pill.h}px)`);
  });

  await t.test("the pill is not mostly padding", () => {
    // A RATIO, not a fixed slack. v1.7.83 grew the pill by a fifth on purpose,
    // and an absolute "no more than Npx of glass" would have to be renumbered
    // every time the bar is resized — which is how a threshold quietly becomes
    // whatever the current build happens to measure. What actually went wrong
    // in v1.7.81 was the PROPORTION: 42px of cover in a 68px bar, because the
    // home-indicator inset was applied twice.
    const filled = r.art_h / r.pill.h;
    assert.ok(filled >= 0.65,
      `the cover is ${r.art_h}px in a ${r.pill.h}px pill (${(filled * 100).toFixed(0)}%) — ` +
      `the rest is empty glass`);
    // ...and the cover is what sets that height. A control taller than the
    // artwork means the bar is sized by its buttons again.
    assert.ok(r.tallest_child.h <= r.art_h,
      `${r.tallest_child.who} is ${r.tallest_child.h}px, taller than the ${r.art_h}px ` +
      `cover — the buttons are driving the pill's height, not the artwork`);
    assert.ok(r.pill.left > 0 && r.pill.bottom_gap > 0,
      `the pill is welded to an edge (${JSON.stringify(r.pill)}) — it should float`);
  });
});

test("the progress line follows the pill's curve", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // v1.7.83. The line used to be a 2px strip stretched across the top with
  // `border-radius: 18px 18px 0 0` on it. That radius never existed: CSS scales
  // every corner down until the two on a side fit that side's length, and the
  // strip's left side is 2px long — so an 18px corner became a 2px one and the
  // blue line ran on straight past the pill's glass at both ends.
  //
  // The clip is a real geometric constraint, and the harness cannot sample
  // pixels — so what is asserted is the thing that made the radius unusable:
  // a corner has to FIT the box it is on.
  const r = harness.renderPage({
    name: "ui-progress-curve", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);

      var prog = document.querySelector(".mt-progress");
      var fill = document.getElementById("mt-progress-fill");
      var pb = bar.getBoundingClientRect(), gb = prog.getBoundingClientRect();
      var gs = getComputedStyle(prog), fs = getComputedStyle(fill);
      T("clip", {
        h: Math.round(gb.height), pill_h: Math.round(pb.height),
        w: Math.round(gb.width),  pill_w: Math.round(pb.width),
        radius: parseFloat(gs.borderTopLeftRadius) || 0,
        pill_radius: parseFloat(getComputedStyle(bar).borderTopLeftRadius) || 0,
        overflow: gs.overflowX,
        pointer: gs.pointerEvents,
      });
      T("line", {
        border_top: parseFloat(fs.borderTopWidth) || 0,
        bg: fs.backgroundColor,
        radius: parseFloat(fs.borderTopLeftRadius) || 0,
        box: fs.boxSizing,
      });
      // The painter still drives it through style.width — unchanged, and three
      // seek tests in volume-row.test.js read that property.
      T("painted_width", fill.style.width);

      // The popovers open UPWARDS out of the transport. A clip on the wrong
      // element would swallow them, and the clip added here is one element away
      // from doing exactly that.
      document.getElementById("mt-vol-btn").click();
      await window.__sleep(300);
      var pop = document.getElementById("mt-vol-popover").getBoundingClientRect();
      T("popover", { top: Math.round(pop.top), pill_top: Math.round(pb.top),
                     h: Math.round(pop.height) });
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the clip is the shape of the pill, not a strip across its top", () => {
    const c = r.clip;
    assert.ok(c.h >= c.pill_h - 4,
      `the progress clip is ${c.h}px tall inside a ${c.pill_h}px pill — it is still ` +
      `a strip, and a strip cannot carry the pill's corner`);
    assert.ok(c.w >= c.pill_w - 4, `the clip is ${c.w}px wide in a ${c.pill_w}px pill`);
    assert.equal(c.overflow, "hidden", "nothing clips the line to the pill's outline");
    assert.equal(c.pointer, "none", "the progress overlay is eating taps on the pill");
  });

  await t.test("...and its corner actually fits the box it is on", () => {
    // THE root cause, stated directly. 18px of radius on a 2px-tall box is not
    // an 18px corner, it is a 2px one — the browser scales it to fit and the
    // declaration silently means something else.
    const c = r.clip;
    assert.ok(c.radius >= 12,
      `the clip's corner radius is ${c.radius}px — too small to follow an ` +
      `${c.pill_radius}px pill`);
    assert.ok(c.radius * 2 <= c.h,
      `a ${c.radius}px radius does not fit a ${c.h}px-tall box: CSS will scale it ` +
      `down to ${(c.h / 2).toFixed(1)}px and the line will cut a straight chord ` +
      `across the corner instead of following it`);
    assert.ok(Math.abs(c.radius - c.pill_radius) <= 2,
      `the clip curves at ${c.radius}px and the pill at ${c.pill_radius}px — the ` +
      `line will not sit on the edge`);
  });

  await t.test("the line is a drawn edge, not a block filling the pill", () => {
    // The clip is full-height now, so a fill that still painted a background
    // would paint the WHOLE pill accent-coloured.
    const l = r.line;
    assert.ok(l.border_top >= 1.5,
      `the fill has no top border (${l.border_top}px) — nothing draws the line`);
    assert.match(String(l.bg), /rgba\(0, 0, 0, 0\)|transparent/,
      `the fill has background ${l.bg} in a full-height clip — that floods the ` +
      `entire pill with accent colour`);
    assert.equal(l.box, "border-box",
      "height:100% plus a top border on content-box makes the fill overflow the clip");
    assert.ok(String(r.painted_width).endsWith("%"),
      `app.js paints style.width and it reads ${JSON.stringify(r.painted_width)} — ` +
      `the seek tests in volume-row.test.js read the same property`);
  });

  await t.test("and the popovers still escape the transport", () => {
    assert.ok(r.popover.h > 0, "the volume popover did not open");
    assert.ok(r.popover.top < r.popover.pill_top,
      `the volume popover opens at y=${r.popover.top} but the pill starts at ` +
      `y=${r.popover.pill_top} — it is being clipped inside the bar`);
  });
});

test("floating things share one material; grounded things share one ground", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // v1.7.86 put the top bar on the transport pill's material. v1.7.87 splits
  // that in two, because they are not the same kind of surface:
  //
  //   FLOATING (--glass-bg, translucent): the transport pill and both volume
  //   sheets. These really do sit over content and the translucency reads.
  //
  //   GROUNDED (--bg): the page, the top bar, and the full-screen panels
  //   (album view, Now playing). .topbar is a flex SIBLING of <main>, so
  //   nothing ever scrolls behind it — giving it a translucent material bought
  //   nothing and left a visible seam between it and the page, which is what
  //   was reported.
  //
  // Neither group may carry a backdrop-filter: saturate() brightens whatever
  // shows through, which is the effect that made the pill change face on every
  // scroll, twice (see the file header).
  const r = harness.renderPage({
    name: "ui-one-surface", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      function face(el) {
        var c = getComputedStyle(el);
        return { bg: c.backgroundColor,
                 filter: c.backdropFilter || c.webkitBackdropFilter || "none" };
      }
      await window.__sleep(600);
      await openRandomWall();
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);

      T("pill",   face(bar));
      var tb = document.querySelector(".topbar");
      T("topbar", face(tb));
      T("body",   face(document.body));
      var tbb = tb.getBoundingClientRect();
      T("topbar_box", { top: Math.round(tbb.top), h: Math.round(tbb.height) });
      T("topbar_h", parseFloat(getComputedStyle(document.querySelector(".app"))
        .getPropertyValue("--topbar-h")) || 0);
      // main's OWN box, and its first child whatever that is. Using the first
      // album tile made this vacuous whenever a notice was above the grid: the
      // tile is far down the page either way, so the reserve could be missing
      // entirely and the assertion still passed.
      var mmEl = document.querySelector("main");
      T("main_top", Math.round(mmEl.getBoundingClientRect().top));
      T("first_child_top",
        Math.round(mmEl.firstElementChild.getBoundingClientRect().top));

      // Scroll into the middle of the wall, then ask whether any tile actually
      // OCCUPIES the strip the bar covers — not whether one particular tile
      // ended up above it, which a tile scrolled far off the top satisfies for
      // the wrong reason.
      var mm = document.querySelector("main");
      mm.scrollTop = Math.round(mm.scrollHeight / 2);
      await window.__sleep(150);
      var tb2 = tb.getBoundingClientRect();
      T("behind_bar", (function () {
        var all = tiles(), n = 0;
        for (var k = 0; k < all.length; k++) {
          var b = all[k].getBoundingClientRect();
          if (b.top < tb2.bottom && b.bottom > tb2.top) n++;
        }
        return n;
      })());
      T("bar_moved", Math.round(tb2.top) !== Math.round(tbb.top));
      T("scrolled", Math.round(mm.scrollTop));
      mm.scrollTop = 0;
      await window.__sleep(150);

      document.getElementById("mt-vol-btn").click();
      await window.__sleep(300);
      var mtVol = document.getElementById("mt-vol-popover");
      T("mt_vol", face(mtVol));
      T("mt_vol_open", !mtVol.classList.contains("hidden"));
      document.getElementById("mt-vol-btn").click();
      await window.__sleep(200);

      document.querySelector(".mt-info").click();
      await window.__sleep(1000);
      T("panel", face(document.querySelector("#album-modal .modal-panel")));
      document.getElementById("np-volbtn").click();
      await window.__sleep(300);
      var npVol = document.getElementById("np-vol-popover");
      T("np_vol", face(npVol));
      T("np_vol_open", !npVol.classList.contains("hidden"));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("both volume sheets actually opened", () => {
    assert.equal(r.mt_vol_open, true, "the mini bar's volume sheet did not open");
    assert.equal(r.np_vol_open, true, "the now-playing volume sheet did not open");
  });

  await t.test("the volume sheets are the pill's material", () => {
    for (const [name, face] of [["the mini bar's volume sheet", r.mt_vol],
                                ["the now-playing volume sheet", r.np_vol]]) {
      assert.equal(face.bg, r.pill.bg,
        `${name} is ${face.bg} and the transport pill is ${r.pill.bg} — they are ` +
        `meant to read as one material, not two near-miss greys`);
    }
  });

  await t.test("THE one: every screen RESOLVES to the same colour", () => {
    // The reported symptom: a step under the header on the album wall and on
    // Home, and a third tone again on Now playing.
    //
    // "Resolves to", not "equals": as of v1.7.88 the top bar is translucent so
    // album art can pass under it, which means its computed backgroundColor is
    // an rgba() and never string-equal to the page's rgb(). What has to hold is
    // that it composites onto the page as the page — i.e. the veil is the
    // GROUND with alpha, not some lighter colour with alpha. A lighter one
    // brings the seam straight back the moment nothing is behind it, which is
    // the whole complaint. Compositing catches the wrong hue as well as the
    // wrong tone; string equality could not have.
    assert.equal(over(r.topbar.bg, r.body.bg), norm(r.body.bg),
      `the top bar (${r.topbar.bg}) over the page (${r.body.bg}) resolves to ` +
      `${over(r.topbar.bg, r.body.bg)} — with nothing scrolled behind it that is ` +
      `a visible step across the top of every screen`);
    assert.equal(over(r.panel.bg, r.body.bg), norm(r.body.bg),
      `the Now playing / album panel is ${r.panel.bg} against a ${r.body.bg} page`);

    // ...and the bar has to be genuinely translucent, or the whole overlay is
    // pointless: an opaque bar resolves to the ground too and passes the check
    // above while showing nothing of what scrolls beneath it.
    const veil = parse(r.topbar.bg);
    assert.ok(veil && veil.a < 1,
      `the top bar is opaque (${r.topbar.bg}) — the page passes underneath it now ` +
      `and none of it can be seen`);
    assert.ok(veil.a >= 0.7,
      `the top bar is only ${veil.a} opaque — with no blur to soften it, a bright ` +
      `sleeve scrolling under the header washes out the title on it`);
  });

  await t.test("...and the page really does pass underneath the bar", () => {
    // The other half of the ask, and the reason the bar had to leave the flow:
    // it was a flex SIBLING of <main>, so there was never anything behind it to
    // be translucent about.
    assert.ok(r.scrolled > 0, "the wall never scrolled — nothing was tested");
    // THE structural fact, and the one that has to be measured directly: the
    // scroller's box has to START at or above the bar. A tile's own rect is not
    // enough — getBoundingClientRect knows nothing about the scroller's clip, so
    // a tile scrolled out of view above <main> reports a position "behind" the
    // bar even when <main> begins entirely below it. That is exactly what a
    // build with the bar back in the flow does, and it passed.
    assert.ok(r.main_top <= r.topbar_box.top,
      `<main> starts at y=${r.main_top} and the bar at y=${r.topbar_box.top} — the ` +
      `scroller begins below the bar, so nothing can ever pass underneath it`);
    assert.ok(r.behind_bar > 0,
      `after scrolling ${r.scrolled}px, not one album tile occupies the strip the ` +
      `bar covers`);
    assert.equal(r.bar_moved, false,
      "the top bar scrolled away with the content — it is not pinned");
    // The reserve has to be the bar's real height, or the first row is either
    // clipped at rest or floating below a gap.
    assert.ok(Math.abs(r.topbar_h - r.topbar_box.h) <= 1,
      `--topbar-h is ${r.topbar_h}px but the bar measures ${r.topbar_box.h}px`);
    assert.ok(r.first_child_top >= r.topbar_box.h - 1,
      `at scroll 0 the scroller's first child starts at y=${r.first_child_top}, ` +
      `under a ${r.topbar_box.h}px bar — <main> is not reserving the bar's height, ` +
      `so the top of every screen opens hidden behind the header`);
  });

  await t.test("...and the floating material still reads above that ground", () => {
    assert.notEqual(r.pill.bg, r.body.bg,
      `the transport pill is exactly the page colour (${r.pill.bg}) — it has ` +
      `flattened into the background instead of floating over it`);
  });

  await t.test("and none of them has a backdrop-filter", () => {
    for (const [name, face] of [["the transport pill", r.pill], ["the top bar", r.topbar],
                                ["the mini bar's volume sheet", r.mt_vol],
                                ["the now-playing volume sheet", r.np_vol]]) {
      assert.ok(!/blur|saturate/.test(String(face.filter)),
        `${name} has a backdrop-filter (${face.filter}) — saturate() brightens ` +
        `whatever shows through, which is the effect that made the pill change ` +
        `face on every scroll, twice`);
    }
  });
});
