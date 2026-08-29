"use strict";
// ---------------------------------------------------------------------------
// v1.7.84: the album view and Now playing lead with the artwork itself.
//
// The cover used to be a 280px square floating in the middle of a padded
// column. It is now edge to edge, dissolving into the page ground, with the
// title underneath.
//
// TWO of the assertions here are load-bearing rather than cosmetic:
//
//   1. FULL-BLEED FROM INSIDE A PADDED COLUMN. .modal-body pads 18px either
//      side, and the art cancels that with a negative margin. .modal-body also
//      declares overflow-y: auto, and a box with one axis scrollable and the
//      other `visible` computes the visible one to `auto` — so without an
//      explicit overflow-x the negative margins give the whole album view a
//      horizontal scrollbar. That is asserted by measuring, not by reading the
//      declaration.
//
//   2. THE TEXT NEVER SITS ON THE ARTWORK. The design this follows can put a
//      title over the bottom of a cover because its ground is always dark and
//      the art fades into that dark. Two of this app's four palettes have a
//      near-white ground and near-black text, so the same overlap puts dark
//      text on whatever the sleeve happens to be. The first cut did exactly
//      that and the album title was invisible on the first cover tried.
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
  now_playing: { line1: "Sunday", line2: "David Bowie", line3: "Heathen",
                 image_key: "k", length: 285, seek_position: 34 },
};
const ALBUMS = [{ offset: 0, title: "Heathen", subtitle: "David Bowie", image_key: "k" }];
const DETAIL = {
  title: "Heathen", subtitle: "David Bowie", image_key: "k", year: 2002,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [{ title: "Sunday", subtitle: "David Bowie" },
           { title: "Cactus", subtitle: "David Bowie" }],
};

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/album") > -1)          return window.__json(${JSON.stringify(DETAIL)});
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 1, filtered: false });
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

const MEASURE = `
  function boxOf(el) {
    var b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right),
             top: Math.round(b.top), bottom: Math.round(b.bottom),
             w: Math.round(b.width), h: Math.round(b.height) };
  }
  function maskOf(el) {
    var c = getComputedStyle(el);
    return String(c.maskImage || c.webkitMaskImage || "none");
  }
`;

test("the album view leads with the artwork, edge to edge", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "hero-album", windowSize: "390x844", stub: STUB,
    driver: `
      ${MEASURE}
      await window.__sleep(700);
      document.getElementById("menu-toggle").click();
      await window.__sleep(250);
      document.querySelector('.menu-item[data-action="shuffle"]').click();
      await window.__sleep(900);
      document.querySelectorAll("#album-grid .album")[0].click();
      await window.__sleep(1100);

      var modal = document.getElementById("album-modal");
      T("np_mode", modal.classList.contains("np-mode"));
      var panel = modal.querySelector(".modal-panel");
      var body  = modal.querySelector(".modal-body");
      var art   = modal.querySelector(".modal-art");
      var img   = document.getElementById("modal-img");
      var h2    = document.getElementById("modal-title");
      var sub   = document.getElementById("modal-subtitle");
      var acts  = document.getElementById("modal-actions");

      T("panel", boxOf(panel));
      T("art",   boxOf(art));
      T("title", boxOf(h2));
      T("title_text", h2.textContent);
      T("mask", maskOf(img));
      T("align", { title: getComputedStyle(h2).textAlign,
                   sub:   getComputedStyle(sub).textAlign,
                   acts:  getComputedStyle(acts).justifyContent });
      // The measured proof that the negative margins did not open a
      // horizontal scrollport (see the header).
      T("hscroll", { scrollW: Math.round(body.scrollWidth),
                     clientW: Math.round(body.clientWidth),
                     overflowX: getComputedStyle(body).overflowX });
      // A track row must still read left-aligned — centring .modal-info would
      // have centred every row in the list.
      var row = document.querySelector("#modal-tracks li");
      T("row_align", row ? getComputedStyle(row).textAlign : null);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the album view opened, not Now playing", () => {
    assert.equal(r.np_mode, false, "the modal opened in np-mode — wrong screen");
    assert.equal(r.title_text, "Heathen");
  });

  await t.test("the cover really does start at the top of the screen", () => {
    // The album view is the ONE screen allowed to give up the status-bar
    // reserve (test/static/safearea.test.js pins that it is the only one), and
    // this is the reason it may: what ends up under the status bar is artwork,
    // never text. If the art ever stops starting at the panel's top edge, that
    // trade has been given away for nothing.
    assert.ok(r.art.top <= r.panel.top + 1,
      `the hero starts ${r.art.top - r.panel.top}px down the panel — the top ` +
      `inset was dropped but the artwork is not filling the space it freed`);
  });

  await t.test("the cover spans the full width of the panel", () => {
    assert.ok(r.art.w >= r.panel.w - 1 && r.art.left <= r.panel.left + 1,
      `the cover is ${r.art.w}px inside a ${r.panel.w}px panel starting at ` +
      `x=${r.art.left} — it is still a boxed square, not a hero`);
    // Square, and big: it is the first thing on the screen.
    assert.ok(Math.abs(r.art.h - r.art.w) <= 2,
      `the hero is ${r.art.w}x${r.art.h} — it should stay square`);
  });

  await t.test("and dissolves into the page rather than ending on a hard edge", () => {
    assert.match(r.mask, /gradient/,
      `the cover has no fade mask (${r.mask}) — it ends on a hard horizontal edge`);
    assert.match(r.mask, /rgba\(0, 0, 0, 0\)|transparent/,
      `the mask never reaches transparent (${r.mask}), so nothing actually fades`);
  });

  await t.test("THE one: no text is ever laid over the artwork", () => {
    assert.ok(r.title.top >= r.art.bottom - 1,
      `the title starts at y=${r.title.top} and the artwork ends at ` +
      `y=${r.art.bottom} — dark text is sitting on an unknown album cover, ` +
      `which is invisible on any sleeve that happens to be dark`);
  });

  await t.test("the header is centred and the track list is not", () => {
    assert.equal(r.align.title, "center");
    assert.equal(r.align.sub, "center");
    assert.equal(r.align.acts, "center");
    assert.notEqual(r.row_align, "center",
      "the track rows are centred too — .modal-info was centred wholesale " +
      "instead of just its header");
  });

  await t.test("and the full-bleed art did not open a sideways scroll", () => {
    assert.ok(r.hscroll.scrollW <= r.hscroll.clientW + 1,
      `the album view scrolls ${r.hscroll.scrollW - r.hscroll.clientW}px sideways: ` +
      `overflow-y:auto computes overflow-x to auto, so the art's negative margins ` +
      `became a horizontal scrollport (overflow-x is ${r.hscroll.overflowX})`);
  });
});

test("Now playing leads with the same artwork", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "hero-np", windowSize: "390x844", stub: STUB,
    driver: `
      ${MEASURE}
      await window.__sleep(700);
      document.getElementById("menu-toggle").click();
      await window.__sleep(250);
      document.querySelector('.menu-item[data-action="shuffle"]').click();
      await window.__sleep(900);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(1200);

      var modal = document.getElementById("album-modal");
      T("np_mode", modal.classList.contains("np-mode"));
      T("tab_album", modal.classList.contains("tab-album"));
      var panel = modal.querySelector(".modal-panel");
      var art   = modal.querySelector(".modal-art");
      var img   = document.getElementById("modal-img");
      var track = document.getElementById("np-track");
      T("panel", boxOf(panel));
      T("art",   boxOf(art));
      T("img",   boxOf(img));
      T("track", boxOf(track));
      T("mask",  maskOf(img));
      T("fit",   getComputedStyle(img).objectFit);
      T("radius", getComputedStyle(img).borderTopLeftRadius);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("Now playing opened", () => {
    assert.equal(r.np_mode, true);
    assert.equal(r.tab_album, true);
  });

  await t.test("the cover fills the width and crops rather than letterboxes", () => {
    assert.ok(r.img.w >= r.panel.w - 1,
      `the cover is ${r.img.w}px in a ${r.panel.w}px panel — still a framed card`);
    assert.equal(r.fit, "cover",
      "object-fit is not cover, so a full-width box letterboxes the art instead " +
      "of filling it");
    assert.ok(parseFloat(r.radius) < 1,
      `the cover still has a ${r.radius} corner radius — rounded corners are how a ` +
      `floating card reads, and this one runs off both screen edges`);
  });

  await t.test("it fades out, and the live block sits below the fade", () => {
    assert.match(r.mask, /gradient/, `no fade on the Now playing cover (${r.mask})`);
    assert.ok(r.track.top >= r.art.bottom - 1,
      `the track name starts at y=${r.track.top} and the artwork ends at ` +
      `y=${r.art.bottom} — text over an unknown cover again`);
  });
});

test("a landscape tablet keeps the framed cover", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // ≥720px landscape puts art and controls side by side in a grid. Nothing
  // bleeds off a screen edge there, so a hard-cropped full-width cover would
  // just look like a mistake — the hero rules are undone for that layout, and
  // "undone" is easy to half-do.
  const r = harness.renderPage({
    name: "hero-landscape", windowSize: "1180x820", stub: STUB,
    driver: `
      ${MEASURE}
      await window.__sleep(700);
      document.getElementById("menu-toggle").click();
      await window.__sleep(250);
      document.querySelector('.menu-item[data-action="shuffle"]').click();
      await window.__sleep(900);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(1200);
      var img = document.getElementById("modal-img");
      var panel = document.querySelector("#album-modal .modal-panel");
      T("panel", boxOf(panel));
      T("img", boxOf(img));
      T("mask", maskOf(img));
      T("fit", getComputedStyle(img).objectFit);
      T("radius", parseFloat(getComputedStyle(img).borderTopLeftRadius) || 0);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the art is a framed column, not a full-width hero", () => {
    assert.ok(r.img.w < r.panel.w * 0.7,
      `the cover is ${r.img.w}px of a ${r.panel.w}px panel — the phone hero rules ` +
      `are leaking into the two-column landscape layout`);
    assert.equal(r.mask, "none",
      `the cover is still masked in landscape (${r.mask}) — it fades into nothing ` +
      `in the middle of the screen`);
    assert.equal(r.fit, "contain");
    assert.ok(r.radius >= 4, `the framed cover lost its ${r.radius}px corner radius`);
  });
});
