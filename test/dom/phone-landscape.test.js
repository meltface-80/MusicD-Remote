"use strict";
// ---------------------------------------------------------------------------
// v1.8.40: a phone in landscape is not blocked.
//
// There used to be a full-viewport `position: fixed` layer that appeared at
// (orientation: landscape) and (max-height: 500px) and said "please rotate
// your device to portrait mode". Reported: coming back to portrait left the
// screen unresponsive, and force-quitting was the only way out.
//
// WHAT THIS FILE CAN AND CANNOT SAY. It cannot reproduce the freeze — that is
// iOS window behaviour and this harness is headless Chromium, where there is
// no rotation, no browser chrome and no safe areas (CLAUDE.md is explicit
// about this, and writing assertions that pretend otherwise buys confidence
// and no coverage). What it CAN do is pin the two things that are checkable
// and that together made the block indefensible:
//
//   1. nothing covers the app at a phone-landscape viewport, and
//   2. the layout underneath it works — which is why the block was hiding
//      something usable rather than protecting anyone from a mess.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: { line1: "Lump", line2: "James Holden", line3: "The Idiots Are Winning",
                 image_key: "k", length: 285, seek_position: 62 },
};
const ALBUMS = Array.from({ length: 12 }, (_, i) => ({
  offset: i, title: "Album " + (i + 1), subtitle: "Artist " + (i + 1), image_key: "k" }));

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 12, filtered: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  function boxOf(el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top),
             right: Math.round(b.right), bottom: Math.round(b.bottom),
             w: Math.round(b.width), h: Math.round(b.height) };
  }
  await window.__sleep(900);

  T("viewport", { w: window.innerWidth, h: window.innerHeight });

  /*
   * ANYTHING THAT COVERS THE VIEWPORT, found by asking the page rather than by
   * naming an element. The block is gone, so a test for "#landscape-block is
   * absent" would pass for ever and say nothing; this fails for the NEXT
   * full-screen layer that appears at this shape too.
   */
  var mainEl = document.querySelector("main");
  var covering = [];
  var all = document.body.querySelectorAll("*");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // The app shell is itself a fixed, viewport-sized box. It CONTAINS the
    // content, which is exactly what a blocker does not — so an ancestor of
    // <main> is the frame, not a lid on it.
    if (mainEl && el.contains(mainEl)) continue;
    var cs = getComputedStyle(el);
    if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
    if (parseFloat(cs.opacity) === 0) continue;
    if (cs.pointerEvents === "none") continue;
    var b = el.getBoundingClientRect();
    if (b.width >= window.innerWidth * 0.98 && b.height >= window.innerHeight * 0.98) {
      covering.push({ id: el.id || null, cls: String(el.className || "").slice(0, 60) });
    }
  }
  T("covering", covering);

  // What is actually at the middle of the screen — an invisible blocker shows
  // up here even if the sweep above missed it.
  var mid = document.elementFromPoint(Math.round(window.innerWidth / 2),
                                      Math.round(window.innerHeight / 2));
  T("mid_point", mid ? { tag: mid.tagName, id: mid.id || null,
                         cls: String(mid.className || "").slice(0, 60) } : null);

  // The shell laid out and scrollable.
  var main = document.querySelector("main");
  T("main", boxOf(main));
  T("scrollable", main ? main.scrollHeight > main.clientHeight : null);
  T("topbar", boxOf(document.querySelector(".topbar")));

  // Now playing: the screen most likely to justify a block on a 390px-tall
  // viewport. v1.6.14 built a two-column landscape layout for exactly this.
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(900);
  T("np_open", document.getElementById("album-modal").classList.contains("np-mode"));
  T("np_art",  boxOf(document.querySelector("#album-modal .modal-art")));
  T("np_play", boxOf(document.getElementById("np-playpause")));
  T("np_seek", boxOf(document.getElementById("np-seek")));
`;

function render(size) {
  const r = harness.renderPage({ name: "phone-landscape-" + size, windowSize: size,
                                 stub: STUB, driver: DRIVER, budgetMs: 35000 });
  harness.assertNoPageError(assert, r);
  return r;
}

test("a phone in landscape is not blocked", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Two common phone-landscape shapes. 844x390 is the one the old rule caught
  // squarely (height well under its 500px threshold).
  for (const size of ["844x390", "932x430"]) {
    await t.test("at " + size, () => {
      const r = render(size);

      assert.deepEqual(r.covering, [],
        "something covers the whole viewport in landscape: " + JSON.stringify(r.covering));
      assert.ok(r.mid_point, "nothing is hit-testable at the centre of the screen");
      assert.doesNotMatch(r.mid_point.cls || "", /landscape-block/,
        "the rotate overlay is still there: " + JSON.stringify(r.mid_point));

      // The layout the block was hiding.
      assert.ok(r.main.h > 0 && r.main.w >= r.viewport.w - 2,
        "the shell did not lay out: " + JSON.stringify(r.main));
      assert.equal(r.scrollable, true, "the wall does not scroll in landscape");
      assert.ok(r.topbar.h > 0, "no top bar in landscape");

      // Now playing, whole and inside the viewport.
      //
      // THE ARTWORK IS DELIBERATELY NOT ASSERTED. In np-mode the art is
      // height-driven flex sized from leftover space, and this harness cannot
      // serve /api/image/<key> — so the img fails, the box collapses, and a
      // size assertion would be measuring the fixture's missing picture rather
      // than the landscape layout. What decides whether a phone can be left in
      // landscape is whether the CONTROLS are reachable, which is what these
      // are.
      assert.equal(r.np_open, true, "Now playing did not open");
      for (const [name, box] of [["play", r.np_play], ["seek", r.np_seek]]) {
        assert.ok(box && box.h > 0 && box.w > 0, "the " + name + " has no size in landscape");
        assert.ok(box.bottom <= r.viewport.h + 1 && box.top >= -1,
          "the " + name + " is off-screen in landscape: " + JSON.stringify(box) +
          " in a viewport " + r.viewport.h + " tall");
      }
    });
  }
});
