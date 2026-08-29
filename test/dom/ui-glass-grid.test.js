"use strict";
// ---------------------------------------------------------------------------
// v1.7.81: the UI pass — one grid everywhere, a list mode, and a glass pill.
//
// Three of these are ordinary UI assertions. The fourth is not:
//
// The transport's backdrop blur was REMOVED in v1.6.15 because iOS Safari
// re-blurs everything beneath it on every scroll frame, and it was the main
// scroll-jank source while music was playing. Bringing the glass back is only
// safe because the blur is dropped for the duration of a scroll. If that ever
// stops happening the look will still be perfect and the app will be slow again
// on a device none of this suite can measure — so the mechanism is pinned here,
// where a change to it has to be deliberate.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [];
for (let i = 0; i < 12; i++) {
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
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 12, filtered: false });
  if (u.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, offset: 0, total: 12 });
  if (u.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 12, dated: 0, decades: [], sources: [], hasPlays: false });
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

      // Rows, not columns: a row is wider than it is tall.
      var b = tiles()[0].getBoundingClientRect();
      T("row_shape", { w: Math.round(b.width), h: Math.round(b.height) });
      var a = tiles()[0].querySelector(".album-art-wrap").getBoundingClientRect();
      T("thumb", { w: Math.round(a.width), h: Math.round(a.height) });

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

test("the glass steps aside while the page scrolls", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // THE one that matters for something this suite cannot measure. See the file
  // header: the blur over scrolling content was the documented jank source.
  const r = harness.renderPage({
    name: "ui-glass-scroll", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      await openRandomWall();
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);

      var cs = getComputedStyle(bar);
      T("rest_filter", cs.backdropFilter || cs.webkitBackdropFilter || "");
      T("rest_radius", cs.borderTopLeftRadius);
      T("rest_left", Math.round(bar.getBoundingClientRect().left));

      var m = document.querySelector("main");
      m.scrollTop = 200;
      m.dispatchEvent(new Event("scroll", { bubbles: false }));
      await window.__sleep(60);
      var during = getComputedStyle(bar);
      T("scrolling_class", bar.classList.contains("is-scrolling"));
      T("scrolling_filter", during.backdropFilter || during.webkitBackdropFilter || "");

      await window.__sleep(700);
      var after = getComputedStyle(bar);
      T("settled_class", bar.classList.contains("is-scrolling"));
      T("settled_filter", after.backdropFilter || after.webkitBackdropFilter || "");
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it is glass, and it floats", () => {
    assert.match(String(r.rest_filter), /blur/,
      "the transport has no backdrop blur at rest — it is not glass");
    assert.ok(parseFloat(r.rest_radius) >= 10,
      `corner radius is ${r.rest_radius} — a pill needs rounding`);
    assert.ok(r.rest_left > 0, "the bar is still welded to the left edge, not floating");
  });

  await t.test("a scroll takes the blur away", () => {
    assert.equal(r.scrolling_class, true, "no is-scrolling class — nothing suspends the blur");
    assert.ok(!/blur/.test(String(r.scrolling_filter)),
      `the blur is still live mid-scroll (${r.scrolling_filter}) — this is the iOS ` +
      `jank v1.6.15 removed, reintroduced`);
  });

  await t.test("and it comes back once the scroll stops", () => {
    assert.equal(r.settled_class, false, "the bar never leaves its scrolling state");
    assert.match(String(r.settled_filter), /blur/, "the glass never returns after a scroll");
  });
});
