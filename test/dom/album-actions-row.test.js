"use strict";
// ---------------------------------------------------------------------------
// v1.8.60: two things on the album view's artwork and action row, both
// reported from a phone screenshot.
//
//   THE OVERFLOW BUTTON MATCHES THE ROW. Play Now and Queue are outlined pills
//   the row's full height; the "more" button beside them was a bare 26px ring
//   drawn inside a transparent 40px box, so what the eye measured was the ring
//   — well short of the buttons it sits between. Measured on what is SEEN: the
//   button's own box carries the outline now, so its rect is the visible
//   extent, and the test also checks the outline really is painted. A test on
//   the rect alone would pass with the old transparent box enlarged around a
//   ring that stayed small.
//
//   NO SOURCE BADGE ON THE ARTWORK. The local / Qobuz / TIDAL mark sat in the
//   art's top-right corner, which is exactly where the Share button floats, so
//   it peeked out from under it. The album view and Now playing are one modal
//   with one .modal-art, so the element is checked for ANY badge in the DOM,
//   painted or not — which covers both screens. (Now playing never had a
//   badge path of its own to test: the album it opens with carries no source,
//   and fetchNowPlayingDetail, the one caller that passed the server's source,
//   is never called.) The grid tiles keep their badges, and that is checked
//   too, or "remove the badge" could pass by removing every badge.
//
//   The playlist screens put the same overflow button beside the same Play now
//   and Queue pills, so the smart-playlist screen is measured as well — there
//   the pills are FILLED rather than outlined, and the button takes the
//   finish of its own row.
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
// A Qobuz album: under the old code this is what drew the badge on the art.
const ALBUMS = [{ offset: 0, title: "Heathen", subtitle: "David Bowie", image_key: "k",
                  source: "qobuz" }];
// All five actions, so two go on the row and three behind the overflow.
const DETAIL = {
  title: "Heathen", subtitle: "David Bowie", image_key: "k", year: 2002,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" },
            { kind: "play_next", title: "Play Next" }, { kind: "shuffle", title: "Shuffle" },
            { kind: "radio", title: "Start Radio" }],
  tracks: [{ title: "Sunday", subtitle: "David Bowie" },
           { title: "Cactus", subtitle: "David Bowie" }],
};
const NP_DETAIL = {
  album: { title: "Heathen", subtitle: "David Bowie", image_key: "k", source: "qobuz" },
  tracks: [{ title: "Sunday", subtitle: "David Bowie" }],
};

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) { /* storage optional: the zone falls back to the first */ }
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/album/now-playing") > -1) return window.__json(${JSON.stringify(NP_DETAIL)});
  if (u.indexOf("/api/album/extras") > -1)   return window.__json({});
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
    var b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
             w: b.width, h: b.height };
  }
  // Is anything drawn at this element's box edge? A border that exists but is
  // transparent, or zero wide, draws nothing.
  function outlined(el) {
    var c = getComputedStyle(el);
    var w = parseFloat(c.borderTopWidth) || 0;
    var col = c.borderTopColor || "";
    var clear = /rgba\\([^)]*,\\s*0\\)$/.test(col) || col === "transparent";
    return w >= 1 && !clear && c.borderTopStyle !== "none";
  }
  // A badge counts as shown only if it would actually paint.
  function painted(el) {
    if (!el || !el.isConnected) return false;
    var c = getComputedStyle(el);
    if (c.display === "none" || c.visibility === "hidden") return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }

  await window.__sleep(700);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);

  // The tile keeps its badge.
  var tile = document.querySelectorAll("#album-grid .album")[0];
  T("tile_badge", painted(tile && tile.querySelector(".album-source")));

  tile.click();
  await window.__sleep(1100);
  var modal = document.getElementById("album-modal");
  T("np_mode", modal.classList.contains("np-mode"));

  var acts = document.getElementById("modal-actions");
  var pills = acts.querySelectorAll(".action-btn");
  var more  = acts.querySelector(".overflow-btn");
  T("pill_count", pills.length);
  T("has_more", !!more);
  if (pills.length && more) {
    var p0 = boxOf(pills[0]), p1 = boxOf(pills[1]), m = boxOf(more);
    T("pill_h", [p0.h, p1.h]);
    T("more_h", m.h);
    T("more_w", m.w);
    T("pill_mid", (p0.top + p0.bottom) / 2);
    T("more_mid", (m.top + m.bottom) / 2);
    T("more_outlined", outlined(more));
    T("pill_outlined", outlined(pills[1]));
    // The finish of the row it sits in, not merely "an" outline: Queue's own
    // border colour and fill (outlined on the page, on this screen).
    var mc = getComputedStyle(more), qc = getComputedStyle(pills[1]);
    T("finish", { border: mc.borderTopColor, queue_border: qc.borderTopColor,
                  bg: mc.backgroundColor, queue_bg: qc.backgroundColor });
    // The ring glyph must not be drawn INSIDE an outline — two circles, one in
    // the other, is the old small ring with a frame round it.
    var svg = more.querySelector("svg");
    var rings = svg ? Array.prototype.filter.call(svg.querySelectorAll("circle"), function (c) {
      return painted(c) && parseFloat(c.getAttribute("r")) > 3;
    }).length : -1;
    T("inner_rings", rings);
    var dots = svg ? svg.getBoundingClientRect() : null;
    T("glyph_inside", !!dots && dots.left >= m.left && dots.right <= m.right &&
                      dots.top >= m.top && dots.bottom <= m.bottom);
    T("row_right", boxOf(acts).right);
    T("more_right", m.right);

    // It still opens its menu, with the three actions behind it.
    more.click();
    await window.__sleep(200);
    var menu = acts.querySelector(".overflow-menu");
    T("menu_open", !!menu && !menu.classList.contains("hidden"));
    T("menu_items", menu ? Array.prototype.map.call(menu.querySelectorAll(".sel-menu-item"),
      function (b) { return b.textContent; }) : []);
  }

  // The album view's artwork carries no source badge, though this album is
  // a Qobuz one and the tile above showed it.
  var art = modal.querySelector(".modal-art");
  T("album_art_badge_painted", Array.prototype.some.call(
    art.querySelectorAll(".album-source"), painted));
  T("modal_badges_in_dom", modal.querySelectorAll(".album-source").length);
`;

for (const size of ["390x844", "360x780", "1280x900"]) {
  test("album view at " + size + ": the overflow button matches Play Now and Queue", async (t) => {
    if (!harness.available) { t.skip("no chromium binary available"); return; }
    const r = harness.renderPage({ name: "album-actions-" + size.split("x")[0],
                                   windowSize: size, stub: STUB, driver: DRIVER });
    harness.assertNoPageError(assert, r);

    // Controls.
    assert.equal(r.np_mode, false, "the album view did not open — the Now playing screen did");
    assert.equal(r.pill_count, 2, "expected Play Now and Queue on the row");
    assert.equal(r.has_more, true, "no overflow button — three actions had nowhere to go");
    assert.equal(r.pill_outlined, true,
      "Queue is not outlined — the row's own look has changed under this test");

    const [h0, h1] = r.pill_h;
    assert.ok(Math.abs(h0 - h1) < 0.5, "Play Now and Queue differ in height: " + r.pill_h);
    assert.ok(Math.abs(r.more_h - h0) < 0.5,
      "the overflow button is " + r.more_h.toFixed(1) + "px tall against " + h0.toFixed(1) +
      "px for Play Now and Queue — the reported mismatch");
    assert.ok(Math.abs(r.more_mid - r.pill_mid) < 0.5,
      "the overflow button is not centred on the row (" + r.more_mid + " vs " + r.pill_mid + ")");
    assert.equal(r.more_outlined, true,
      "the overflow button has no visible outline, so its box is not what is seen — a tall " +
      "transparent box round a small ring measures right and looks wrong");
    assert.ok(Math.abs(r.more_w - r.more_h) < 0.5,
      "the overflow button is not round (" + r.more_w + " x " + r.more_h + ")");
    assert.equal(r.finish.border, r.finish.queue_border,
      "the overflow button's outline is not Queue's");
    assert.equal(r.finish.bg, r.finish.queue_bg,
      "the overflow button's fill is not Queue's — on the album view both are outlined");
    assert.equal(r.inner_rings, 0,
      "a ring is still drawn inside the outlined button — a circle within a circle");
    assert.equal(r.glyph_inside, true, "the dots spill outside the button");
    assert.ok(r.more_right <= r.row_right + 0.5, "the overflow button overflows its row");

    assert.equal(r.menu_open, true, "the overflow button no longer opens its menu");
    assert.deepEqual(r.menu_items, ["Next", "Shuffle", "Radio"]);

    assert.equal(r.tile_badge, true,
      "the grid tile lost its source badge — only the album view's artwork was to lose it");
    assert.equal(r.album_art_badge_painted, false,
      "the album view's artwork still shows a source badge — it sits under the Share button");
    assert.equal(r.modal_badges_in_dom, 0,
      "a source badge element is still inside the album modal — Now playing shares this " +
      "artwork, so one there can be shown on either screen");
  });
}

