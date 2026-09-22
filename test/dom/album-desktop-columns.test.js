"use strict";
// ---------------------------------------------------------------------------
// v1.8.38: the cover stopped sitting on the track list at desktop widths.
//
// Reported from a desktop browser (and the same in Chrome, Edge and Firefox,
// which is the shape of a specificity bug rather than an engine quirk): the
// artwork covered the track NUMBERS of every row inside its own height, and
// the start of the TRACKS heading with it — "ACKS".
//
// THE CAUSE WAS SPECIFICITY, NOT LAYOUT. v1.7.84's full-bleed hero is written
// as `.modal:not(.np-mode) .modal-art` (three classes) and cancels the body's
// 18px side padding with `margin: 0 -18px`. The two-column block is written as
// plain `.modal-art` (one class) inside `@media (min-width: 720px)` — and a
// MEDIA QUERY ADDS NO SPECIFICITY, so coming later in the file bought it
// nothing. The negative margin won at every width and pulled the track column
// 18px under the art, with the hero's `gap: 0` also beating the 28px here so
// nothing absorbed it.
//
// What is pinned below is the RESULT (the columns do not touch) rather than
// any declaration, because the same overlap could come back from any new rule
// that out-specifies this one.
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
                 image_key: "k", length: 285, seek_position: 34 },
};
const ALBUMS = [{ offset: 0, title: "Outrospective", subtitle: "Faithless", image_key: "k" }];
// Five tracks, so the first few fall inside the art's 320px height and the
// last few below it — the asymmetry in the report ("1-3 have no number, 4 and
// 5 do") is what says the art is the thing covering them.
const DETAIL = {
  title: "Outrospective", subtitle: "Faithless", image_key: "k", year: 2001,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [
    { title: "Donny X", subtitle: "Faithless, Rollo, Sister Bliss, Maxi Jazz" },
    { title: "Not Enuff Love", subtitle: "Faithless, Rollo, Sister Bliss, Maxi Jazz" },
    { title: "We Come 1", subtitle: "Faithless, Rollo, Sister Bliss, Maxi Jazz" },
    { title: "Crazy English Summer", subtitle: "Faithless, Rollo, Sister Bliss" },
    { title: "Muhammad Ali", subtitle: "Faithless, Rollo, Sister Bliss, Maxi Jazz" },
  ],
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

const DRIVER = `
  function boxOf(el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right),
             top: Math.round(b.top), bottom: Math.round(b.bottom),
             w: Math.round(b.width), h: Math.round(b.height) };
  }
  await window.__sleep(700);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(1200);

  var modal = document.getElementById("album-modal");
  var body  = modal.querySelector(".modal-body");
  var art   = modal.querySelector(".modal-art");
  var info  = modal.querySelector(".modal-info");
  T("np_mode", modal.classList.contains("np-mode"));
  T("flex_dir", getComputedStyle(body).flexDirection);
  T("art", boxOf(art));
  T("info", boxOf(info));
  // Every row, and the widest right edge of anything drawn inside the art's
  // own vertical band — the rows the report says lost their numbers.
  var rows = Array.prototype.slice.call(document.querySelectorAll("#modal-tracks li"));
  T("rows", rows.map(boxOf));
  T("row_count", rows.length);
  // The heading that rendered as "ACKS".
  var heads = Array.prototype.slice.call(modal.querySelectorAll("h3, .tracks-head, .modal-section-title"));
  var head = heads.filter(function (h) { return /TRACKS/i.test(h.textContent || ""); })[0];
  T("head", head ? boxOf(head) : null);
  T("head_text", head ? head.textContent.trim() : null);
  // The fade belongs to the single-column hero; beside a track list it just
  // makes the cover look like it failed to load.
  var img = document.getElementById("modal-img");
  T("mask", String(getComputedStyle(img).maskImage || getComputedStyle(img).webkitMaskImage || "none"));
  // The bleed must not reopen a horizontal scrollport either (v1.7.84's rule).
  T("hscroll", { scrollW: Math.round(body.scrollWidth), clientW: Math.round(body.clientWidth) });
`;

function render(size) {
  const r = harness.renderPage({ name: "album-desktop-" + size, windowSize: size,
                                 stub: STUB, driver: DRIVER, budgetMs: 30000 });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the album view's two columns do not overlap at desktop widths",
     { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Both a laptop and the 1920-wide window the report came from. The panel is
  // width: min(960px, 100%), so these are the same layout — which is the point:
  // the overlap was a fixed 18px at EVERY desktop width, not a squeeze.
  for (const size of ["1400x900", "1920x1080"]) {
    await t.test("at " + size, () => {
      const r = render(size);
      assert.equal(r.np_mode, false, "this is the album view, not Now playing");
      assert.equal(r.flex_dir, "row", "the two-column layout did not engage");

      // THE BUG: the art's right edge was PAST the track column's left edge.
      assert.ok(r.art.right <= r.info.left,
        "the cover overlaps the track column by " + (r.art.right - r.info.left) +
        "px — it covers the number of every row inside its own height");

      // And they are separated rather than merely touching.
      assert.ok(r.info.left - r.art.right >= 20,
        "only " + (r.info.left - r.art.right) + "px between the cover and the tracks");

      // Every row starts clear of the art, including the ones beside it.
      const beside = r.rows.filter(b => b.top < r.art.bottom);
      assert.ok(beside.length >= 2,
        "the fixture needs rows level with the art to be testing anything");
      for (const b of beside) {
        assert.ok(b.left >= r.art.right,
          "a track row level with the cover starts at " + b.left +
          ", under an art that ends at " + r.art.right);
      }

      // The heading that read "ACKS". The DOM holds "Tracks"; the capitals in
      // the report are text-transform, which is exactly why the clipped word
      // read as "ACKS" rather than as "acks".
      assert.equal(r.head_text, "Tracks");
      assert.ok(r.head.left >= r.art.right,
        "the TRACKS heading starts under the cover (left " + r.head.left +
        " vs art right " + r.art.right + ") — it renders as 'ACKS'");

      // No fade beside a track list.
      assert.equal(r.mask, "none",
        "the hero's bottom fade is still on the desktop cover: " + r.mask);

      // v1.7.84's rule still holds: no horizontal scrollport.
      assert.ok(r.hscroll.scrollW <= r.hscroll.clientW + 1,
        "the album view scrolls sideways: " + JSON.stringify(r.hscroll));
    });
  }
});
