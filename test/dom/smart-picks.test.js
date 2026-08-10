"use strict";
// ---------------------------------------------------------------------------
// v1.7.41: the Smart Picks screen and Home row.
//
// These albums are NOT in the library. That single fact is what every failure
// mode here comes from:
//
//   1. THEY CANNOT BE PLAYED. Every other tile in this app carries an offset
//      into Roon's albums hierarchy and its tap handlers assume one. A pick has
//      no offset, so reusing the ordinary album tile would produce something
//      that looks playable, and taps into a 409 or plays a different record.
//   2. ADD IS THE ONLY ACTION, AND IT IS ONE-WAY. It favourites the album on
//      the streaming service so Roon imports it. A second tap must not silently
//      un-favourite the thing the user just asked for.
//   3. "NOT FOR ME" MUST BE EXPLICIT. Ignoring a pick cannot count as
//      rejection — the premise is albums the user would not otherwise reach
//      for, so silence has to mean "maybe later".
//   4. THE STRETCH PICK MUST BE LABELLED. One of the six is deliberately unlike
//      the library. Unmarked, it reads as a bad recommendation rather than the
//      point of the feature.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const PICKS = [
  // Roon has imported this one — it has an offset, so it is playable.
  { kind: "adjacent", artist: "Labradford", album: "Mi Media Naranja",
    album_id: "q1", service: "qobuz", image: "", reason: "Because you play Stars of the Lid", genre: "",
    added: true, offset: 42, library_title: "Mi Media Naranja", library_subtitle: "Labradford",
    image_key: "k42" },
  // Favourited on Qobuz but Roon has not imported it yet.
  { kind: "adjacent", artist: "Bowery Electric", album: "Beat",
    album_id: "q2", service: "qobuz", image: "", reason: "Because you play Slowdive", genre: "",
    added: true, offset: null },
  { kind: "adjacent", artist: "Flying Saucer Attack", album: "Further",
    album_id: "q3", service: "qobuz", image: "", reason: "Because you play Bark Psychosis", genre: "" },
  { kind: "adjacent", artist: "Seefeel", album: "Quique",
    album_id: "q4", service: "qobuz", image: "", reason: "Because you play Labradford", genre: "" },
  { kind: "adjacent", artist: "Windy & Carl", album: "Depths",
    album_id: "q5", service: "qobuz", image: "", reason: "Because you play Low", genre: "" },
];

const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [],
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  now_playing: null,
};

function stub(opts) {
  opts = opts || {};
  const picks = opts.picks === undefined ? PICKS : opts.picks;
  const ready = opts.serviceReady === undefined ? true : opts.serviceReady;
  return `
var ZONE = ${JSON.stringify(ZONE)};
window.__favCalls = [];
window.__blockCalls = [];
window.__installFetch(function (url, init) {
  if (url.indexOf("/api/smart-picks/block") > -1) {
    window.__blockCalls.push(JSON.parse(init.body));
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/smart-picks") > -1)
    return window.__json({ day: "2026-08-04", service_ready: ${JSON.stringify(ready)},
                           picks: ${JSON.stringify(picks)} });
  if (url.indexOf("/favorite") > -1) {
    window.__favCalls.push({ url: url, body: JSON.parse(init.body) });
    return window.__json({ ok: true });
  }
  if (url.indexOf("/unfavorite") > -1) {
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
  await window.__sleep(500);

  // ---- the Home row ------------------------------------------------------
  var row = document.getElementById("home-picks");
  var sec = row ? row.closest(".home-section") : null;
  T("home_row_shown", !!sec && !sec.classList.contains("hidden"));
  T("home_tiles", row ? row.querySelectorAll(".pick-card").length : -1);
  // A pick has no offset, so it must NOT be built as an ordinary album tile —
  // those carry play/queue handlers that would fire against nothing.
  T("home_uses_album_tile", row ? row.querySelectorAll(".album").length : -1);
  // The Home row is a plain tile: no reason line, no buttons competing with the
  // rows around it.
  T("home_has_actions", row ? row.querySelectorAll(".pick-actions").length : -1);
  T("home_has_reason",  row ? row.querySelectorAll(".pick-reason").length : -1);

  // Tiles must sit side by side in a scrolling carousel, not stack.
  (function () {
    var cards = row ? row.querySelectorAll(".pick-card") : [];
    if (cards.length < 2) { T("home_side_by_side", null); return; }
    var a = cards[0].getBoundingClientRect(), b = cards[1].getBoundingClientRect();
    T("home_side_by_side", b.left > a.left && Math.abs(b.top - a.top) < 4);
  })();

  // ---- the full screen, opened from the side menu ------------------------
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  var item = document.querySelector('.menu-item[data-action="smart-picks"]');
  T("menu_item_found", !!item);
  T("menu_item_label", item ? item.textContent.trim() : null);
  item.click();
  await window.__sleep(600);

  T("screen_title", (document.getElementById("album-count") || {}).textContent);
  var cards = document.querySelectorAll("#album-grid .pick-card-full");
  T("full_cards", cards.length);
  T("full_reasons", document.querySelectorAll("#album-grid .pick-reason").length);
  T("full_adds", document.querySelectorAll("#album-grid .pick-add").length);
  T("full_blocks", document.querySelectorAll("#album-grid .pick-block").length);
  T("first_reason", (document.querySelector("#album-grid .pick-reason") || {}).textContent);
  T("first_artist", (document.querySelector("#album-grid .pick-artist") || {}).textContent);

  // MEASURED, not counted. #album-grid is a 3-to-9 column grid, so a container
  // appended into it without a full-width grid-column lands in ONE cell — the
  // whole screen rendered at ~110px wide while every element was still present
  // and every count still correct. Only a rect can see that.
  (function () {
    var list = document.querySelector("#album-grid .pick-list");
    var g = document.getElementById("album-grid");
    if (!list || !g) { T("list_spans_grid", null); return; }
    var lr = list.getBoundingClientRect(), gr = g.getBoundingClientRect();
    T("list_width", Math.round(lr.width));
    T("grid_width", Math.round(gr.width));
    T("list_spans_grid", lr.width > gr.width * 0.9);
    var card = document.querySelector("#album-grid .pick-card-full");
    var art  = card ? card.querySelector(".pick-art") : null;
    var add  = card ? card.querySelector(".pick-add") : null;
    if (card && art && add) {
      var cr = card.getBoundingClientRect(), ar = art.getBoundingClientRect(),
          br = add.getBoundingClientRect();
      // Nothing may spill outside its own card.
      T("art_inside_card", ar.right <= cr.right + 1);
      T("button_inside_card", br.right <= cr.right + 1 && br.left >= cr.left - 1);
    } else { T("art_inside_card", null); T("button_inside_card", null); }
  })();

  // ---- Add favourites the album, once --------------------------------------
  // Which state each card landed in — Play / waiting / Add.
  T("action_labels", Array.prototype.map.call(
    document.querySelectorAll("#album-grid .pick-card-full"), function (c) {
      var b = c.querySelector(".pick-add");
      return b ? b.textContent.trim() : null;
    }));
  T("play_buttons", document.querySelectorAll("#album-grid .pick-play").length);

  // The Add flow is exercised on a card that is genuinely not added yet.
  var add = null;
  Array.prototype.forEach.call(document.querySelectorAll("#album-grid .pick-add"), function (b) {
    if (!add && !b.disabled && b.textContent.indexOf("Add") > -1 &&
        b.textContent.indexOf("Added") === -1) add = b;
  });
  T("found_addable", !!add);
  add.click();
  await window.__sleep(350);
  T("fav_calls", window.__favCalls.length);
  T("fav_url", window.__favCalls.length ? window.__favCalls[0].url : null);
  T("fav_body", window.__favCalls.length ? window.__favCalls[0].body : null);
  T("add_is_disabled_after", !!add.disabled);
  T("add_label_after", add.textContent);
  T("add_disabled_after", !!add.disabled);

  // A second tap must not un-favourite what the user just added.
  add.click();
  await window.__sleep(300);
  T("fav_calls_after_second_tap", window.__favCalls.length);

  // ---- Not for me is explicit, and removes the card ----------------------
  var before = document.querySelectorAll("#album-grid .pick-card-full").length;
  var block = document.querySelectorAll("#album-grid .pick-block")[1];
  var blockedArtist = block.closest(".pick-card-full").querySelector(".pick-artist").textContent;
  block.click();
  await window.__sleep(350);
  T("block_calls", window.__blockCalls.length);
  T("block_body", window.__blockCalls.length ? window.__blockCalls[0] : null);
  T("blocked_artist_matches", window.__blockCalls.length
      ? window.__blockCalls[0].artist === blockedArtist : null);
  T("cards_after_block", document.querySelectorAll("#album-grid .pick-card-full").length);
  T("cards_before_block", before);
  // Nothing else may be blocked as a side effect of simply rendering.
  T("block_calls_total", window.__blockCalls.length);
`;

test("Smart Picks: six a day, addable, never playable (v1.7.41)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: stub(), driver: DRIVER, name: "smart-picks", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the Home row shows the day's picks", () => {
      assert.equal(r.home_row_shown, true);
      assert.equal(r.home_tiles, 5, "the day's five picks");
      assert.equal(r.home_side_by_side, true,
        "the tiles stacked instead of forming a carousel");
    });

    await t.test("a pick is NEVER built as a playable album tile", () => {
      // THE one. An .album tile carries play/queue handlers that resolve an
      // offset into Roon's hierarchy. A pick has none, so a tile that looked
      // ordinary would tap through to nothing — or to a different record.
      assert.equal(r.home_uses_album_tile, 0,
        "a pick was rendered as an ordinary album tile — those handlers need " +
        "an offset, and an album that is not in the library has none");
    });

    await t.test("the Home row stays a plain carousel", () => {
      assert.equal(r.home_has_actions, 0);
      assert.equal(r.home_has_reason, 0);
    });

    await t.test("the side menu opens the full screen", () => {
      assert.equal(r.menu_item_found, true);
      assert.equal(r.menu_item_label, "Smart Picks");
      assert.equal(r.screen_title, "Smart Picks");
      assert.equal(r.full_cards, 5);
    });

    await t.test("the screen spans the shared grid, not one of its cells", () => {
      // #album-grid is a 3-to-9 column grid. A container appended into it
      // without a full-width grid-column sat in a single cell — 110px on a
      // phone, 125px on desktop — while every element was present and every
      // count correct, so nothing but a measurement can see it.
      assert.equal(r.list_spans_grid, true,
        "the pick list occupied " + r.list_width + "px of a " + r.grid_width +
        "px grid — it is sitting in one column cell");
      assert.equal(r.art_inside_card, true, "the artwork overflowed its card");
      assert.equal(r.button_inside_card, true, "an action button overflowed its card");
    });

    await t.test("the picks come back in the rank the server assigned", () => {
      // The read once sorted on `kind` as well as rank, which reordered the
      // set behind the server's back. Rank alone now.
      assert.equal(r.first_artist, "Labradford");
      assert.match(r.first_reason, /Because you play/);
    });

    await t.test("every card on the full screen explains itself", () => {
      assert.equal(r.full_reasons, 5,
        "a pick with no reason is indistinguishable from a random album");
      assert.match(r.first_reason, /Because you play/);
    });

    await t.test("a pick Roon has imported offers Play, not Add", () => {
      // THE fix for the reported bug. The first version latched "Added" on the
      // button and nowhere else, so a reopen showed "+ Add" for albums already
      // sitting in the user's Qobuz library — and tapping it asked to add them
      // again. State now comes from the server on every load.
      assert.equal(r.play_buttons, 1, "the imported pick did not offer Play");
      assert.match(r.action_labels[0], /Play/);
    });

    await t.test("a pick added but not yet imported says so, and cannot be re-added", () => {
      // Roon decides when it imports. Showing "+ Add" here is what made the
      // feature look broken; showing a dead "Added" with no explanation would
      // be nearly as bad.
      assert.match(r.action_labels[1], /Added/);
      assert.match(r.action_labels[1], /waiting for Roon/i);
    });

    await t.test("only genuinely un-added picks offer Add", () => {
      assert.equal(r.found_addable, true);
      assert.match(r.action_labels[2], /Add$/);
      assert.match(r.action_labels[4], /Add$/);
    });

    await t.test("Add favourites the album on its own service", () => {
      assert.equal(r.fav_calls, 1);
      assert.match(r.fav_url, /\/api\/qobuz\/favorite/);
      assert.deepEqual(r.fav_body, { album_id: "q3" },
        "Add hit the wrong card — it must act on the one it is attached to");
    });

    await t.test("Add latches — a second tap cannot un-favourite it", () => {
      // The service browser's button is a deliberate toggle. This one is not:
      // the user asked for the album to enter their library, and an accidental
      // second tap silently taking it out again is much worse than a no-op.
      assert.match(r.add_label_after, /Added/);
      assert.match(r.add_label_after, /waiting for Roon/i,
        "a bare \"Added\" leaves the user wondering why they still cannot play it");
      assert.equal(r.add_disabled_after, true);
      assert.equal(r.fav_calls_after_second_tap, 1,
        "a second tap sent another request — Add is one-way");
    });

    await t.test("Not for me blocks the artist it is attached to", () => {
      assert.equal(r.block_calls, 1);
      assert.equal(r.blocked_artist_matches, true,
        "the wrong artist was blocked — the button read a different card");
      assert.equal(r.cards_after_block, r.cards_before_block - 1);
    });

    await t.test("nothing is blocked without an explicit tap", () => {
      // Silence must never count as rejection. One tap, one block.
      assert.equal(r.block_calls_total, 1);
    });
  });

// ---------------------------------------------------------------------------
test("Smart Picks degrades honestly when there is nothing to show (v1.7.41)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const DRIVER_EMPTY = `
      await window.__sleep(500);
      var row = document.getElementById("home-picks");
      var sec = row ? row.closest(".home-section") : null;
      T("home_row_hidden", !!sec && sec.classList.contains("hidden"));
      document.getElementById("menu-toggle").click();
      await window.__sleep(250);
      document.querySelector('.menu-item[data-action="smart-picks"]').click();
      await window.__sleep(600);
      var banner = document.getElementById("status-banner");
      T("banner_text", banner ? banner.textContent : null);
      T("banner_visible", banner ? !banner.classList.contains("hidden") : null);
      T("cards", document.querySelectorAll("#album-grid .pick-card-full").length);
    `;

    await t.test("no service connected says so instead of showing dead buttons", () => {
      const r = harness.renderPage({
        stub: stub({ picks: [], serviceReady: false }), driver: DRIVER_EMPTY,
        name: "smart-picks-noservice", windowSize: "390x844",
      });
      harness.assertNoPageError(assert, r);
      assert.equal(r.home_row_hidden, true,
        "an empty row on Home reads as a broken feature, not a waiting one");
      assert.equal(r.cards, 0);
      assert.match(r.banner_text, /Qobuz|TIDAL/,
        "the user was left with no idea why the screen is empty");
    });

    await t.test("a service IS connected but the build hasn't finished yet", () => {
      // Different cause, so it must be a different message: telling somebody to
      // connect Qobuz when Qobuz is already connected is worse than silence.
      const r = harness.renderPage({
        stub: stub({ picks: [], serviceReady: true }), driver: DRIVER_EMPTY,
        name: "smart-picks-building", windowSize: "390x844",
      });
      harness.assertNoPageError(assert, r);
      assert.match(r.banner_text, /Building/);
      assert.doesNotMatch(r.banner_text, /Connect Qobuz/);
    });
  });
