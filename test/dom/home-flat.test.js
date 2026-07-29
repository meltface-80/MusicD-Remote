"use strict";
// ---------------------------------------------------------------------------
// v1.6.61: the Home screen is flat.
//
// Home sections used to be tinted rounded panels with decorative watermarks.
// They are now Roon-style: bold title, hairline rule, content — on the flat
// page background.
//
// The reason this needs a test is that the panel recipe was written as FIVE
// SHARED SELECTOR LISTS covering both the Home sections AND the album modal's
// Tracks / About / Queue panels, which still want it. Flattening meant editing
// each list to drop only the Home half. Delete one line too many and the album
// modal silently loses its tint and watermark; delete one too few and a Home
// section keeps its card. Neither throws, and neither shows up in any other
// test — both are pure computed-style outcomes.
//
// So this asserts BOTH halves, in BOTH themes: Home flat, modal unchanged.
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
  test(`Home is flat and the album modal is not — ${theme} theme (v1.6.61)`,
    { concurrency: 1 }, async (t) => {
      if (!harness.available) {
        t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
        return;
      }

      const r = harness.renderPage({
        stub: STUB, driver: driverFor(theme), name: "home-flat-" + theme,
        windowSize: "390x844", budgetMs: 25000,
      });
      harness.assertNoPageError(assert, r);

      await t.test("the album modal keeps its tinted panels and watermarks", () => {
        for (const key of ["tracks", "bio", "queue"]) {
          const p = r[key];
          assert.equal(p.present, true, `${key} panel is missing entirely`);
          assert.equal(p.transparent, false,
            `${key} lost its tint — the Home flattening deleted a shared selector ` +
            "list instead of trimming the Home half out of it");
          assert.equal(p.radius, 16, `${key} lost its corner radius`);
          assert.equal(p.padTop, 14, `${key} lost its padding`);
          assert.equal(p.hasWatermark, true, `${key} lost its watermark`);
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
