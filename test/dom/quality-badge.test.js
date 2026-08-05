"use strict";
// ---------------------------------------------------------------------------
// v1.7.36: sample rate / bit depth on the artwork, off by default.
//
// The badge makes a confident claim about a file in two characters, so the ways
// it goes wrong are all about saying something untrue:
//
//   1. SHOWING WHEN IT SHOULDN'T. It is opt-in. A default-on badge would put
//      "16/44.1" over every cover for everyone who never asked for it.
//   2. APPEARING ON AN ALBUM WITH NO FILE. A streamed album has no format this
//      extension can read. No badge is the honest answer; an empty box is not.
//   3. NOT TAKING EFFECT. The value rides on every album payload, so the switch
//      is a class on <body> rather than a refetch — which means it must change
//      what is ALREADY on screen, not just what is drawn next.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [
  // Hi-res, CD, lossy, and one with no local file at all.
  { offset: 0, title: "Hi Res",  subtitle: "Artist A", image_key: "k0",
    quality: "24/96",   hires: true },
  { offset: 1, title: "Redbook", subtitle: "Artist B", image_key: "k1",
    quality: "16/44.1" },
  { offset: 2, title: "Lossy",   subtitle: "Artist C", image_key: "k2",
    quality: "MP3" },
  { offset: 3, title: "Streamed", subtitle: "Artist D", image_key: "k3" },
];

const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [],
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  now_playing: null,
};

function stub(seed) {
  return `
var ALBUMS = ${JSON.stringify(ALBUMS)};
var ZONE = ${JSON.stringify(ZONE)};
try {
  localStorage.removeItem("rra-library-view");
  ${seed === undefined ? "localStorage.removeItem('rra-show-quality');"
                       : `localStorage.setItem('rra-show-quality', ${JSON.stringify(seed)});`}
} catch (e) {}
window.__installFetch(function (url) {
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 4, facets: [], coverage: {}, hasPlays: false });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/version") > -1)    return window.__json({ version: "test" });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(400);
  document.getElementById("home-library-title").click();
  await window.__sleep(500);

  function badges() {
    return Array.prototype.map.call(document.querySelectorAll("#album-grid .album"), function (t) {
      var q = t.querySelector(".album-quality");
      return (t.querySelector(".album-title") || {}).textContent + "=" +
             (q ? q.textContent : "-");
    });
  }
  // What is actually PAINTED, not what is in the DOM. display:none is how the
  // badge is hidden, and a test that only counted elements would pass with
  // every badge on screen.
  // Scoped to the library wall. The page also holds Home's carousels and the
  // album view's own badge; counting those would make the numbers depend on
  // which other screens happen to be built, not on this setting.
  function visible() {
    return Array.prototype.filter.call(
      document.querySelectorAll("#album-grid .album-quality"), function (q) {
        return q.getBoundingClientRect().height > 0;
      }).length;
  }

  T("tiles", document.querySelectorAll("#album-grid .album").length);
  T("badges_in_dom", badges());
  T("visible_before", visible());
  T("body_class_before", document.body.classList.contains("show-quality"));

  // ---- the toggle lives in Appearance ------------------------------------
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="appearance"]').click();
  await window.__sleep(250);
  var toggle = document.getElementById("quality-toggle");
  T("toggle_found", !!toggle);
  T("toggle_in_appearance",
    !!toggle && !!toggle.closest('[data-pane="appearance"]'));
  T("toggle_checked_before", !!toggle.checked);

  toggle.click();
  await window.__sleep(250);
  T("toggle_checked_after", !!toggle.checked);
  T("body_class_after", document.body.classList.contains("show-quality"));
  T("stored", (function () { try { return localStorage.getItem("rra-show-quality"); }
                             catch (e) { return null; } })());

  // Close the sheet and look at the wall that was ALREADY drawn.
  var back = document.querySelector('[data-settings-close], #settings-close');
  if (back) back.click(); else document.getElementById("settings-overlay").classList.add("hidden");
  await window.__sleep(250);
  T("visible_after", visible());
  T("hires_marked", document.querySelectorAll("#album-grid .album-quality.is-hires").length);

  // Reading the badge's own box: it must sit on the artwork, clear of the
  // source badge in the opposite corner.
  (function () {
    var q = document.querySelector("#album-grid .album-quality");
    var art = q && q.closest(".album-art-wrap");
    if (!q || !art) { T("badge_on_art", null); return; }
    var qr = q.getBoundingClientRect(), ar = art.getBoundingClientRect();
    T("badge_on_art", qr.left >= ar.left - 1 && qr.right <= ar.right + 1 &&
                      qr.top >= ar.top - 1 && qr.bottom <= ar.bottom + 1);
    T("badge_bottom_left", (qr.left - ar.left) < ar.width / 2 &&
                           (ar.bottom - qr.bottom) < ar.height / 2);
  })();

  // ---- turning it back off clears the wall again -------------------------
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="appearance"]').click();
  await window.__sleep(250);
  document.getElementById("quality-toggle").click();
  await window.__sleep(250);
  T("stored_off", (function () { try { return localStorage.getItem("rra-show-quality"); }
                                 catch (e) { return null; } })());
  T("body_class_off", document.body.classList.contains("show-quality"));
`;

test("sample rate on artwork is opt-in and takes effect at once (v1.7.36)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: stub(), driver: DRIVER, name: "quality-badge", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("it is off until asked for", () => {
      assert.equal(r.tiles, 4);
      assert.equal(r.body_class_before, false);
      assert.equal(r.visible_before, 0,
        "the badge showed without the setting being on — this is opt-in, and a " +
        "default-on rate over every cover is exactly what was not asked for");
      assert.equal(r.toggle_checked_before, false);
    });

    await t.test("an album with no local file gets no badge, not an empty one", () => {
      // The honest gap: Roon streams have no file to read a rate from.
      assert.deepEqual(r.badges_in_dom, [
        "Hi Res=24/96", "Redbook=16/44.1", "Lossy=MP3", "Streamed=-",
      ]);
    });

    await t.test("the switch is in Appearance", () => {
      assert.equal(r.toggle_found, true);
      assert.equal(r.toggle_in_appearance, true);
    });

    await t.test("switching it on changes the wall already on screen", () => {
      // No refetch and no navigation: the value rides on every payload, so a
      // toggle that only affected the NEXT screen would read as broken.
      assert.equal(r.toggle_checked_after, true);
      assert.equal(r.body_class_after, true);
      assert.equal(r.visible_after, 3,
        "three of the four albums have a format; the streamed one must stay bare");
      assert.equal(r.stored, "1", "the choice has to survive a reload");
    });

    await t.test("hi-res is marked, CD and lossy are not", () => {
      assert.equal(r.hires_marked, 1);
    });

    await t.test("the badge sits on the artwork, bottom-left", () => {
      assert.equal(r.badge_on_art, true,
        "the badge escaped the artwork box — it would overlap the title");
      assert.equal(r.badge_bottom_left, true,
        "the source badge owns the top-right corner; these must not collide");
    });

    await t.test("switching it off clears them again", () => {
      assert.equal(r.body_class_off, false);
      assert.equal(r.stored_off, "0");
    });

    // A separate page, booted with the preference already stored — the reload
    // path, which the toggle test above cannot cover because it never reloads.
    const kept = harness.renderPage({
      stub: stub("1"), driver: `
        await window.__sleep(400);
        document.getElementById("home-library-title").click();
        await window.__sleep(500);
        T("body_class", document.body.classList.contains("show-quality"));
        T("visible", Array.prototype.filter.call(
          document.querySelectorAll("#album-grid .album-quality"),
          function (q) { return q.getBoundingClientRect().height > 0; }).length);
        document.getElementById("settings-toggle").click();
        await window.__sleep(300);
        document.querySelector('.settings-nav-item[data-pane="appearance"]').click();
        await window.__sleep(250);
        T("toggle_checked", !!document.getElementById("quality-toggle").checked);
      `, name: "quality-badge-kept", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, kept);

    await t.test("the preference survives a reload, and the switch agrees", () => {
      assert.equal(kept.body_class, true);
      assert.equal(kept.visible, 3);
      assert.equal(kept.toggle_checked, true,
        "the badges came back but the switch read off — the two would disagree " +
        "and tapping it would appear to do nothing");
    });
  });
