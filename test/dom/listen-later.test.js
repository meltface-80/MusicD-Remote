"use strict";
// ---------------------------------------------------------------------------
// v1.8.67: Listen later — the Home row, the screen, and the Smart Picks button.
//
// An entry is one of two things, and every control turns on which:
//
//   IN THE LIBRARY  it has an offset, so it is an ordinary album tile and the
//                   screen offers Play.
//   NOT YET         a Smart Pick sent here instead of to the streaming library.
//                   No offset, so nothing can play it — the tile must NOT be a
//                   selectable album tile (its handlers would fire against an
//                   offset that does not exist), and the screen offers Add to
//                   library and Open in Qobuz instead.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const LATER = [
  // Put aside from the album view; Roon has it.
  { key: "blue||joni mitchell", title: "Blue", artist: "Joni Mitchell", service: "", album_id: "",
    image: "", source: "album", added_at: Date.now() - 2 * 86400000, added: null, service_url: null,
    offset: 7, library_title: "Blue", library_subtitle: "Joni Mitchell", image_key: "k7" },
  // A Smart Pick sent here, not in the library and not favourited.
  { key: "further||flying saucer attack", title: "Further", artist: "Flying Saucer Attack",
    service: "qobuz", album_id: "q3", image: "https://static.qobuz.com/images/covers/q3.jpg",
    source: "picks", added_at: Date.now(), added: false,
    service_url: "https://open.qobuz.com/album/q3",
    offset: null, library_title: "", library_subtitle: "", image_key: null },
  // A Smart Pick favourited but not imported yet.
  { key: "beat||bowery electric", title: "Beat", artist: "Bowery Electric",
    service: "qobuz", album_id: "q2", image: "", source: "picks", added_at: Date.now(), added: true,
    service_url: "https://open.qobuz.com/album/q2",
    offset: null, library_title: "", library_subtitle: "", image_key: null },
];

const PICKS = [
  { kind: "adjacent", artist: "Seefeel", album: "Quique", album_id: "q4", service: "qobuz",
    image: "https://static.qobuz.com/images/covers/q4.jpg", reason: "Because you play Labradford",
    genre: "", added: false, offset: null, later: false },
];

const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [],
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  now_playing: null,
};

function stub(later) {
  return `
var ZONE = ${JSON.stringify(ZONE)};
window.__laterPosts = [];
window.__favCalls = [];
window.__installFetch(function (url, init) {
  if (url.indexOf("/api/listen-later") > -1) {
    if (init && init.method === "POST") {
      var b = JSON.parse(init.body);
      window.__laterPosts.push(b);
      return window.__json({ ok: true, on: b.on });
    }
    return window.__json({ albums: ${JSON.stringify(later)} });
  }
  if (url.indexOf("/api/smart-picks") > -1)
    return window.__json({ day: "2026-10-02", service_ready: true, picks: ${JSON.stringify(PICKS)} });
  if (url.indexOf("/favorite") > -1) {
    window.__favCalls.push({ url: url, body: JSON.parse(init.body) });
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: [], offset: 0, total: 0 });
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 0, facets: [], coverage: {}, hasPlays: false });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
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
  await window.__sleep(600);

  // ---- the Home row ------------------------------------------------------
  var row = document.getElementById("home-later");
  var sec = row ? row.closest(".home-section") : null;
  T("home_row_shown", !!sec && !sec.classList.contains("hidden"));
  T("home_tiles", row ? row.children.length : -1);
  var tiles = row ? row.children : [];
  T("lib_tile_offset", tiles[0] ? tiles[0].dataset.offset || null : null);
  T("svc_tile_class", tiles[1] ? tiles[1].classList.contains("later-tile-service") : null);
  // An album Roon does not have must not be a selectable album tile.
  T("svc_tile_offset", tiles[1] ? (tiles[1].dataset.offset === undefined ? null : tiles[1].dataset.offset) : "none");
  // The cover URL as given — the <img> itself removes itself when it fails,
  // and this harness has no network to load it from.
  var ext = tiles[1] ? tiles[1].querySelector(".album-art-wrap") : null;
  T("svc_tile_img", ext ? ext.dataset.artSrc || null : null);
  T("svc_tile_title", tiles[1] ? (tiles[1].querySelector(".album-title") || {}).textContent : null);

  // Tiles must sit side by side in a carousel.
  (function () {
    if (tiles.length < 2) { T("home_side_by_side", null); return; }
    var a = tiles[0].getBoundingClientRect(), b = tiles[1].getBoundingClientRect();
    T("home_side_by_side", b.left > a.left && Math.abs(b.top - a.top) < 4);
  })();

  // ---- the side menu entry ------------------------------------------------
  var item = document.querySelector('.menu-item[data-action="listen-later"]');
  T("menu_item_label", item ? item.textContent.trim() : null);

  // ---- the full screen, from the section header -----------------------------
  document.getElementById("home-later-title").click();
  await window.__sleep(500);
  T("screen_title", (document.getElementById("album-count") || {}).textContent);
  var cards = document.querySelectorAll("#album-grid .later-card");
  T("cards", cards.length);
  T("card_labels", Array.prototype.map.call(cards, function (c) {
    return Array.prototype.map.call(c.querySelectorAll(".pick-actions > *"), function (b) {
      return b.textContent.trim();
    });
  }));
  T("card_status", Array.prototype.map.call(cards, function (c) {
    return (c.querySelector(".pick-reason") || {}).textContent;
  }));
  var link = cards[1] ? cards[1].querySelector("a.pick-link") : null;
  T("open_href", link ? link.getAttribute("href") : null);
  T("open_target", link ? link.getAttribute("target") : null);
  T("waiting_disabled", cards[2] ? !!cards[2].querySelector(".pick-add.is-done").disabled : null);

  (function () {
    var list = document.querySelector("#album-grid .later-list");
    var g = document.getElementById("album-grid");
    if (!list || !g) { T("list_spans_grid", null); return; }
    T("list_spans_grid", list.getBoundingClientRect().width > g.getBoundingClientRect().width * 0.9);
    var inside = true;
    Array.prototype.forEach.call(cards, function (c) {
      var cr = c.getBoundingClientRect();
      Array.prototype.forEach.call(c.querySelectorAll(".pick-actions > *"), function (b) {
        var br = b.getBoundingClientRect();
        if (br.right > cr.right + 1 || br.left < cr.left - 1) inside = false;
      });
    });
    T("buttons_inside_cards", inside);
  })();

  // ---- Add to library favourites the right album ------------------------------
  var add = cards[1] ? cards[1].querySelector(".pick-add") : null;
  if (add) add.click();
  await window.__sleep(300);
  T("fav_url", window.__favCalls.length ? window.__favCalls[0].url : null);
  T("fav_body", window.__favCalls.length ? window.__favCalls[0].body : null);

  // ---- Remove takes the right entry off ------------------------------------
  var rm = cards[1] ? cards[1].querySelector(".later-remove") : null;
  if (rm) rm.click();
  await window.__sleep(300);
  T("remove_post", window.__laterPosts.length ? window.__laterPosts[0] : null);
  T("cards_after_remove", document.querySelectorAll("#album-grid .later-card").length);

  // ---- the Smart Picks card puts a pick aside --------------------------------
  window.__showSmartPicks();
  await window.__sleep(500);
  var later = document.querySelector("#album-grid .pick-card-full .pick-later");
  T("pick_later_label", later ? later.textContent.trim() : null);
  if (later) later.click();
  await window.__sleep(300);
  T("pick_later_post", window.__laterPosts.length > 1 ? window.__laterPosts[1] : null);
  T("pick_later_label_after", later ? later.textContent.trim() : null);
  T("pick_later_pressed", later ? later.getAttribute("aria-pressed") : null);
  (function () {
    var card = document.querySelector("#album-grid .pick-card-full");
    if (!card) { T("pick_buttons_inside", null); return; }
    var cr = card.getBoundingClientRect(), inside = true;
    Array.prototype.forEach.call(card.querySelectorAll(".pick-actions > *"), function (b) {
      var br = b.getBoundingClientRect();
      if (br.right > cr.right + 1 || br.left < cr.left - 1) inside = false;
    });
    T("pick_buttons_inside", inside);
  })();

  // ---- the Settings destination ---------------------------------------------
  var dest = document.getElementById("picks-dest");
  T("dest_options", dest ? Array.prototype.map.call(dest.options, function (o) { return o.value; }) : null);
  T("old_switch_gone", !document.getElementById("picks-autoadd"));
`;

const EMPTY_DRIVER = `
  await window.__sleep(600);
  var row = document.getElementById("home-later");
  var sec = row ? row.closest(".home-section") : null;
  T("home_row_hidden", !!sec && sec.classList.contains("hidden"));
  T("home_tiles", row ? row.children.length : -1);
  window.__showListenLater();
  await window.__sleep(400);
  var banner = document.getElementById("status-banner");
  T("banner", banner && !banner.classList.contains("hidden") ? banner.textContent : null);
`;

test("Listen later: the Home row, the screen, and Smart Picks (v1.8.67)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: stub(LATER), driver: DRIVER, name: "listen-later", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the Home row shows the list as one shelf of album tiles", () => {
      assert.equal(r.home_row_shown, true);
      assert.equal(r.home_tiles, 3);
      assert.equal(r.home_side_by_side, true, "the tiles stacked instead of forming a carousel");
    });

    await t.test("an album Roon has is an ordinary album tile", () => {
      assert.equal(r.lib_tile_offset, "7");
    });

    await t.test("an album Roon does not have is NOT a playable tile", () => {
      // THE one. A selectable album tile carries an offset its handlers act
      // on; a pick Roon has not imported has none.
      assert.equal(r.svc_tile_class, true);
      assert.equal(r.svc_tile_offset, null,
        "a not-in-library entry was given an offset — its handlers would act on nothing");
      assert.equal(r.svc_tile_title, "Further");
      assert.equal(r.svc_tile_img, "https://static.qobuz.com/images/covers/q3.jpg",
        "the service's cover was not shown for an album Roon has no art for");
    });

    await t.test("the side menu has the entry", () => {
      assert.equal(r.menu_item_label, "Listen later");
    });

    await t.test("the screen offers what each entry can actually do", () => {
      assert.equal(r.screen_title, "Listen later");
      assert.equal(r.cards, 3);
      assert.deepEqual(r.card_labels[0], ["▶ Play", "Remove"]);
      assert.deepEqual(r.card_labels[1], ["＋ Add to library", "Open in Qobuz", "Remove"]);
      assert.deepEqual(r.card_labels[2], ["✓ Added — waiting for Roon", "Open in Qobuz", "Remove"]);
      assert.equal(r.waiting_disabled, true, "a favourited pick could be added again");
      assert.match(r.card_status[0], /Put aside 2 days ago/);
      assert.match(r.card_status[1], /From Smart Picks · Not in your library yet — on Qobuz/);
      assert.equal(r.open_href, "https://open.qobuz.com/album/q3");
      assert.equal(r.open_target, "_blank");
    });

    await t.test("the screen spans the grid and nothing spills out of a card", () => {
      assert.equal(r.list_spans_grid, true);
      assert.equal(r.buttons_inside_cards, true);
    });

    await t.test("Add to library favourites the entry's own album", () => {
      assert.match(r.fav_url || "", /\/api\/qobuz\/favorite/);
      assert.deepEqual(r.fav_body, { album_id: "q3" });
    });

    await t.test("Remove asks for the entry OFF, by its identity, and drops its card", () => {
      assert.deepEqual(r.remove_post, { title: "Further", artist: "Flying Saucer Attack", on: false });
      assert.equal(r.cards_after_remove, 2);
    });

    await t.test("a Smart Pick can be put aside without touching the library", () => {
      assert.equal(r.pick_later_label, "＋ Listen later");
      assert.deepEqual(r.pick_later_post, {
        title: "Quique", artist: "Seefeel", service: "qobuz", album_id: "q4",
        image: "https://static.qobuz.com/images/covers/q4.jpg", source: "picks", on: true,
      }, "the entry lost what it needs to be added from the list later");
      assert.equal(r.pick_later_label_after, "✓ Listen later");
      assert.equal(r.pick_later_pressed, "true");
      assert.equal(r.pick_buttons_inside, true,
        "the pick's buttons spilled out of the card on a phone");
    });

    await t.test("Settings chooses where the day's picks go", () => {
      assert.deepEqual(r.dest_options, ["library", "later", "ask"]);
      assert.equal(r.old_switch_gone, true);
    });
  });

test("Listen later: an empty list shows no shelf, and the screen says how to fill it",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }
    const r = harness.renderPage({
      stub: stub([]), driver: EMPTY_DRIVER, name: "listen-later-empty", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);
    await t.test("no empty labelled shelf on Home", () => {
      assert.equal(r.home_row_hidden, true);
      assert.equal(r.home_tiles, 0);
    });
    await t.test("the screen explains itself", () => {
      assert.match(r.banner || "", /Listen later from its ⋯ menu/);
    });
  });
