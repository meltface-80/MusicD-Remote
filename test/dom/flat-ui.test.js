"use strict";
// ---------------------------------------------------------------------------
// The flat UI: no tinted panels, no decorative watermarks, anywhere.
//
// v1.6.61 flattened the Home sections; v1.6.62 flattened the album view's
// Tracks and About panels and the Queue tab. The tinted-panel recipe and every
// watermark motif are now gone from the app entirely.
//
// This test exists because that recipe was written as SHARED SELECTOR LISTS
// spanning all eight surfaces. Flattening was done in two passes, each trimming
// selectors out of the same lists — the exact edit where deleting one line too
// many, or one too few, leaves a surface in the wrong state. None of it throws;
// it is all computed style, invisible to every other test.
//
// So this asserts the end state on EVERY surface, in BOTH themes: nothing is
// tinted, nothing is rounded like a card, nothing paints a watermark.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUM = { offset: 0, title: "Kind of Blue", subtitle: "Miles Davis", image_key: "k0" };

const STUB = `
window.__installFetch(function (url) {
  if (url.indexOf("/api/album?") > -1)
    return window.__json({ album: ${JSON.stringify(ALBUM)}, offset: 0, artists: ["Miles Davis"],
      tracks: [{ title: "So What", artist: "Miles Davis", length: 545 }], actions: [] });
  if (url.indexOf("/api/album/extras") > -1) return window.__json({ bio: "A bio." });
  if (url.indexOf("/api/queue") > -1)   return window.__json({ items: [] });
  if (url.indexOf("/api/zones") > -1)   return window.__json({ zones: [] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/filters") > -1) return window.__json({ genres: [{ title: "Jazz" }] });
  if (url.indexOf("/api/home/") > -1)   return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/random-albums") > -1) return window.__json({ albums: [], total: 0, filtered: false });
  if (url.indexOf("/api/status") > -1)  return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  return undefined;
});
`;

function driverFor(theme) {
  return `
  await window.__sleep(400);
  document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
  await window.__sleep(120);

  function probe(sel) {
    var el = document.querySelector(sel);
    if (!el) return { present: false };
    var cs = getComputedStyle(el), be = getComputedStyle(el, "::before");
    return {
      present: true,
      transparent: cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent",
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      padTop: parseFloat(cs.paddingTop) || 0,
      hasWatermark: (be.maskImage || be.webkitMaskImage || "none") !== "none"
    };
  }

  // The album modal first — it must keep the panel recipe.
  window.__openAlbum(${JSON.stringify(ALBUM)}, { source: "search" });
  await window.__sleep(700);
  T("tracks", probe(".track-list-wrap"));
  T("bio", probe("#album-bio-section"));
  var qt = document.querySelector('.modal-tab[data-tab="queue"]');
  if (qt) qt.click();
  await window.__sleep(300);
  T("queue", probe("#tab-queue"));

  // Now Home — it must have none of it.
  window.__showHome();
  await window.__sleep(500);
  for (var s of ["unplayed", "random", "library", "lotw", "genres"]) {
    T("home_" + s, probe(".home-section-" + s));
  }

  // The section head: a hairline under a bold title, and the row left-aligned
  // and bleeding past main's gutter.
  var title = document.getElementById("home-unplayed-title");
  var tcs = getComputedStyle(title);
  T("title_size", Math.round(parseFloat(tcs.fontSize)));
  T("title_weight", tcs.fontWeight);
  T("title_rule_width", Math.round(parseFloat(tcs.borderBottomWidth)));
  T("title_rule_style", tcs.borderBottomStyle);
  T("title_full_width", (function () {
    var main = document.querySelector("main");
    // The rule must span the content column, not shrink-wrap the words.
    return title.getBoundingClientRect().width >
           main.getBoundingClientRect().width * 0.7;
  })());

  var car = document.querySelector(".home-carousel");
  var ccs = getComputedStyle(car);
  T("carousel_justify", ccs.justifyContent);
  T("carousel_bleeds", Math.round(parseFloat(ccs.marginLeft)));
  T("carousel_padding", Math.round(parseFloat(ccs.paddingLeft)));
  T("tile_width", ccs.gridAutoColumns);
  T("tile_gap", ccs.columnGap);
  `;
}

for (const theme of ["dark", "light"]) {
  test(`Nothing is a tinted panel any more — ${theme} theme (v1.6.62)`,
    { concurrency: 1 }, async (t) => {
      if (!harness.available) {
        t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
        return;
      }

      const r = harness.renderPage({
        stub: STUB, driver: driverFor(theme), name: "flat-ui-" + theme,
        windowSize: "390x844", budgetMs: 25000,
      });
      harness.assertNoPageError(assert, r);

      await t.test("the album view and queue panels are flat too", () => {
        for (const key of ["tracks", "bio", "queue"]) {
          const p = r[key];
          assert.equal(p.present, true, `${key} panel is missing entirely`);
          assert.equal(p.transparent, true, `${key} still has a tinted background`);
          assert.equal(p.radius, 0, `${key} still has card corners`);
          assert.equal(p.hasWatermark, false, `${key} still draws a watermark`);
        }
      });

      await t.test("every Home section is flat", () => {
        for (const s of ["unplayed", "random", "library", "lotw", "genres"]) {
          const p = r["home_" + s];
          assert.equal(p.present, true, `the ${s} section is missing`);
          assert.equal(p.transparent, true, `the ${s} section still has a tinted background`);
          assert.equal(p.radius, 0, `the ${s} section still has rounded corners`);
          assert.equal(p.padTop, 0, `the ${s} section still has panel padding`);
          assert.equal(p.hasWatermark, false, `the ${s} section still draws a watermark`);
        }
      });

      await t.test("each section is headed by a bold title over a hairline", () => {
        assert.ok(r.title_size >= 19, `title is ${r.title_size}px — too small to head a section`);
        assert.ok(Number(r.title_weight) >= 600, `title weight is ${r.title_weight}`);
        assert.equal(r.title_rule_width, 1, "no hairline under the section title");
        assert.equal(r.title_rule_style, "solid");
        assert.equal(r.title_full_width, true,
          "the rule shrink-wrapped the title text instead of spanning the column — " +
          "the section-link display mode went back to inline-flex");
      });

      await t.test("the row is left-aligned and bleeds to the screen edge", () => {
        assert.equal(r.carousel_justify, "start",
          "a short row is still centred — that read fine inside a panel, but on " +
          "the flat layout it floats away from the title above it");
        assert.equal(r.carousel_bleeds, -14,
          "the row no longer bleeds past main's gutter, so no tile peeks at the edge");
        assert.equal(r.carousel_padding, 14,
          "the bleed was not paid back as scroller padding — the first tile will " +
          "not line up under the section title");
      });

      // The user asked for the flattening explicitly WITHOUT changing tile
      // sizing or grid layout. This is that promise, in assertion form.
      await t.test("tile sizing and gap are untouched", () => {
        assert.equal(r.tile_width, "150px");
        assert.equal(r.tile_gap, "12px");
      });
    });
}

// ---------------------------------------------------------------------------
// Queue rows go edge to edge.
//
// Two things make that non-obvious. The gutter being cancelled belongs to
// .modal-body, which is SHARED with the album view and the Now playing screen,
// so it is undone with a negative margin rather than removed — get the sign or
// the breakpoint wrong and the rows either stay inset or hang off the screen.
// And .modal.np-mode .modal-info caps every np pane at 460px, which on a tablet
// would leave a "full-width" queue floating in the middle of the screen. That
// one is invisible on a phone, because a phone is narrower than the cap.
// ---------------------------------------------------------------------------
const QUEUE_ZONE = {
  zone_id: "z1", display_name: "Zone", state: "playing", outputs: [],
  now_playing: { line1: "Valley Of Hearts Delight", line2: "Zalem", line3: "Album",
                 artists: [], image_key: "k0", length: 531, seek_position: 30 },
};
const QUEUE_ITEMS = Array.from({ length: 5 }, (_, i) => ({
  title: "Track " + (i + 1), subtitle: "Artist", length: 200, image_key: "q" + i,
}));

const QUEUE_STUB = `
var ZONE = ${JSON.stringify(QUEUE_ZONE)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/queue") > -1) return window.__json({ items: ${JSON.stringify(QUEUE_ITEMS)} });
  if (url.indexOf("/api/zones") > -1) return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/home/") > -1) return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/random-albums") > -1) return window.__json({ albums: [], total: 0, filtered: false });
  if (url.indexOf("/api/filters") > -1) return window.__json({ genres: [] });
  if (url.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  return undefined;
});
`;

const QUEUE_DRIVER = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(600);
  document.querySelector('.modal-tab[data-tab="queue"]').click();
  await window.__sleep(800);

  var body = document.querySelector(".modal-body");
  var rows = document.querySelectorAll("#tab-queue .queue-list li:not(.q-divider)");
  T("row_count", rows.length);
  T("vw", window.innerWidth);
  T("body_pad", Math.round(parseFloat(getComputedStyle(body).paddingLeft)));

  var first = rows[0];
  var fr = first.getBoundingClientRect();
  T("row_left", Math.round(fr.left));
  T("row_right", Math.round(fr.right));
  // Text must still line up with the summary line above, despite the bleed.
  var art = first.querySelector(".q-art");
  T("art_left", art ? Math.round(art.getBoundingClientRect().left) : null);
  // Compare CONTENT edges: both elements are full-bleed boxes that pay the
  // gutter back as padding, so their border-box lefts are both 0.
  var sum = document.querySelector("#tab-queue .queue-summary");
  T("summary_left", Math.round(
    sum.getBoundingClientRect().left + parseFloat(getComputedStyle(sum).paddingLeft)));

  var cs = getComputedStyle(first);
  T("now_radius", Math.round(parseFloat(cs.borderTopLeftRadius)) || 0);
  T("now_transparent", cs.backgroundColor === "rgba(0, 0, 0, 0)");
  T("row_border", Math.round(parseFloat(cs.borderBottomWidth)));
  T("info_maxw", getComputedStyle(document.querySelector(".modal-info")).maxWidth);
  T("doc_overflow_x", document.documentElement.scrollWidth > window.innerWidth);
`;

for (const size of ["390x844", "820x1180"]) {
  test(`Queue rows run edge to edge — ${size} (v1.6.62)`, { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: QUEUE_STUB, driver: QUEUE_DRIVER, name: "queue-bleed-" + size,
      windowSize: size, budgetMs: 25000,
    });
    harness.assertNoPageError(assert, r);

    await t.test("the queue rendered", () => {
      assert.equal(r.row_count, QUEUE_ITEMS.length);
      assert.ok(r.body_pad > 0, "control failed: .modal-body has no gutter to cancel");
    });

    await t.test("rows reach both screen edges", () => {
      assert.equal(r.row_left, 0,
        `row starts at ${r.row_left}px — the gutter was not cancelled, so the ` +
        "rows are still inset like the old panel");
      assert.equal(r.row_right, r.vw,
        `row ends at ${r.row_right}px of ${r.vw}px — on a tablet this is the ` +
        "460px np-mode column cap, which leaves the queue floating mid-screen");
      assert.equal(r.info_maxw, "none");
      assert.equal(r.doc_overflow_x, false,
        "the bleed overshot and the page scrolls sideways");
    });

    await t.test("row content still lines up with the header above it", () => {
      assert.equal(r.art_left, r.summary_left,
        "the bleed was not paid back as row padding, so the thumbnails no " +
        "longer align with the summary line");
    });

    await t.test("the now-playing row is a full-bleed block, not an inset pill", () => {
      assert.equal(r.now_radius, 0, "the now-playing row still has rounded corners");
      assert.equal(r.now_transparent, false, "the now-playing row lost its highlight");
      assert.equal(r.row_border, 1, "rows lost their hairline separator");
    });
  });
}
