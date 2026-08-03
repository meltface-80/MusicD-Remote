"use strict";
// ---------------------------------------------------------------------------
// v1.7.12: smart playlists open like Roon playlists — a wall of tiles, then a
// detail screen listing TRACKS.
//
// The behaviour this replaces was the bug: opening one applied the saved view
// and showed the library wall, which was the query working perfectly and
// reading as "it just took me to the library screen". A smart playlist has to
// look like a playlist.
//
// What's worth pinning:
//   1. Tracks, not albums — and each row carries the artwork of the album it
//      came from, which is the only way a flat track list stays readable.
//   2. Tracks are paged BY ALBUM, because every album has to be opened on the
//      Core. A page that silently stops is indistinguishable from a short
//      playlist, so the remaining count and the Load more control are asserted.
//   3. Play now / Queue go through /api/play-multi with the resolved albums —
//      the path that already has batching and the stale-offset defense.
//   4. Editing writes back to the SAME record. A save that minted a new id
//      would leave the user with two near-identical playlists and no clue why.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "stopped",
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: null,
};

const SAVED = {
  id: "sp1", name: "Nineties, unheard", album_total: 3, art_keys: ["k1", "k2", "k3", "k4"],
  view: { sort: "year", dir: "desc", seed: 1, decade: [1990], source: [], played: "12" },
};

// Two album-pages worth of tracks, so paging is exercised rather than assumed.
const PAGE1 = {
  id: "sp1", name: "Nineties, unheard", view: SAVED.view,
  tracks: [
    { album_offset: 10, album_title: "Perfect From Now On", album_artist: "Built to Spill",
      image_key: "art10", track_index: 0, title: "Randy Described Eternity", subtitle: "Built to Spill" },
    { album_offset: 10, album_title: "Perfect From Now On", album_artist: "Built to Spill",
      image_key: "art10", track_index: 1, title: "I Would Hurt a Fly", subtitle: "Built to Spill" },
  ],
  album_offset: 0, albums_expanded: 2, album_total: 3, done: false,
};
const PAGE2 = {
  id: "sp1", name: "Nineties, unheard", view: SAVED.view,
  tracks: [
    { album_offset: 20, album_title: "Goo", album_artist: "Sonic Youth",
      image_key: null, track_index: 0, title: "Dirty Boots", subtitle: "Sonic Youth" },
  ],
  album_offset: 2, albums_expanded: 1, album_total: 3, done: true,
};

function stubFor(initial) {
  return `
window.__smart = ${JSON.stringify(initial)};
window.__posts = [];
window.__pageCalls = [];
window.__albumCalls = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/smart-playlist/albums") > -1) {
    window.__albumCalls.push(url.replace(/^.*\\/api\\//, "/api/"));
    // Two albums returned out of a stated total of 3 — the truncated case.
    return window.__json({ id: "sp1", name: "Nineties, unheard", total: 3, albums: [
      { offset: 10, title: "Perfect From Now On", subtitle: "Built to Spill", image_key: "art10" },
      { offset: 20, title: "Goo", subtitle: "Sonic Youth", image_key: null }
    ] });
  }
  if (url.indexOf("/api/smart-playlist?") > -1) {
    window.__pageCalls.push(url.replace(/^.*\\/api\\//, "/api/"));
    var m = /offset=(\\d+)/.exec(url);
    var off = m ? parseInt(m[1], 10) : 0;
    return window.__json(off === 0 ? ${JSON.stringify(PAGE1)} : ${JSON.stringify(PAGE2)});
  }
  if (url.indexOf("/api/smart-playlists/delete") > -1) {
    window.__smart = [];
    return window.__json({ ok: true, playlists: [] });
  }
  if (url.indexOf("/api/smart-playlists") > -1) {
    if (opts && opts.method === "POST") {
      var b = JSON.parse(opts.body || "{}");
      window.__posts.push(b);
      var rec = { id: b.id || "spNEW", name: b.name, view: b.view, album_total: 3 };
      return window.__json({ ok: true, playlist: rec, playlists: [rec] });
    }
    return window.__json({ playlists: window.__smart });
  }
  if (url.indexOf("/api/play-multi") > -1) {
    window.__posts.push({ url: "/api/play-multi", body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/play-track") > -1) {
    window.__posts.push({ url: "/api/play-track", body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true, invoked: "Play Now" });
  }
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ decades: [1990, 2000], sources: [], total: 3 });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: [], offset: 0, total: 0 });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
window.confirm = function () { return true; };
`;
}

const OPEN_WALL = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  var entry = document.querySelector('[data-action="smart-playlists"]');
  T("menu_entry_exists", !!entry);
  entry.click();
  await window.__sleep(700);
  function tiles() {
    return Array.prototype.map.call(document.querySelectorAll("#album-grid .album"), function (b) {
      var w = b.querySelector(".album-art-wrap");
      return { title: (b.querySelector(".album-title") || {}).textContent || "",
               sub:   (b.querySelector(".album-artist") || {}).textContent || "",
               art:   w ? (w.dataset.artKeys || "") : null };
    });
  }
`;

const DRIVER_MAIN = OPEN_WALL + `
  T("tiles", tiles());
  T("no_lib_sheet", !document.querySelector(".lib-sheet-backdrop"));

  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(800);
  T("detail_open", !!document.querySelector(".playlist-detail"));
  T("detail_title", (document.querySelector(".playlist-title") || {}).textContent || "");
  T("page_calls", window.__pageCalls.slice());

  function rows() {
    return Array.prototype.map.call(document.querySelectorAll(".playlist-tracks .track-row"),
      function (li) {
        var artEl = li.querySelector(".track-art");
        return {
          title: (li.querySelector(".track-title") || {}).textContent || "",
          artist: (li.querySelector(".track-artist") || {}).textContent || "",
          art: artEl ? (artEl.dataset.artKey || null) : null,
          albumOffset: li.dataset.albumOffset
        };
      });
  }
  T("rows_page1", rows());
  var more = document.querySelector(".playlist-more");
  T("more_visible_page1", !!more && !more.classList.contains("hidden"));

  more.click();
  await window.__sleep(700);
  T("rows_page2", rows());
  T("more_hidden_after", document.querySelector(".playlist-more").classList.contains("hidden"));
  T("page_calls_after", window.__pageCalls.slice());

  var btns = Array.prototype.map.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent; });
  T("action_buttons", btns);

  // Play now -> play-multi with the resolved albums.
  Array.prototype.filter.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Play now"; })[0].click();
  await window.__sleep(600);
  T("toast_after_play", (document.querySelector(".toast") || {}).textContent || "");

  // Send to Roon: fills the queue so Roon's own "save queue as playlist" can
  // finish the job the API refuses to do.
  Array.prototype.filter.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Send to Roon"; })[0].click();
  await window.__sleep(300);
  // It warns first that the queue is about to be replaced — confirm it.
  T("send_confirm_shown",
    !document.getElementById("confirm-overlay").classList.contains("hidden"));
  T("send_confirm_msg", (document.getElementById("confirm-msg") || {}).textContent || "");
  document.getElementById("confirm-yes").click();
  await window.__sleep(700);
  T("toast_after_send", (document.querySelector(".toast") || {}).textContent || "");

  // Tapping a track plays that track from its album.
  document.querySelectorAll(".playlist-tracks .track-row")[1].click();
  await window.__sleep(500);
  T("posts", window.__posts);
  T("album_calls", window.__albumCalls.slice());
`;

const DRIVER_EDIT = OPEN_WALL + `
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(800);
  Array.prototype.filter.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Edit"; })[0].click();
  await window.__sleep(600);
  var sheet = document.querySelector(".lib-sheet-backdrop");
  T("focus_sheet_open", !!sheet);
  var save = Array.prototype.filter.call(sheet.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Save as…"; })[0];
  T("save_btn_exists", !!save);
  window.prompt = function (msg, suggested) { T("prompt_default", suggested); return "Renamed"; };
  save.click();
  await window.__sleep(700);
  T("posts", window.__posts);
`;


// Abandoning an edit must not leave the next save pointed at that playlist.
const DRIVER_ABANDON = OPEN_WALL + `
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(800);
  Array.prototype.filter.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Edit"; })[0].click();
  await window.__sleep(600);

  // Close the editor WITHOUT saving — the X button.
  var sheet = document.querySelector(".lib-sheet-backdrop");
  sheet.querySelector(".lib-sheet-head .icon-btn").click();
  await window.__sleep(400);
  T("sheet_closed", !document.querySelector(".lib-sheet-backdrop"));

  // Now reach the Library wall the way a user does, and open Focus from there.
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  document.querySelector('[data-action="home"]').click();
  await window.__sleep(500);
  document.getElementById("home-library-title").click();
  await window.__sleep(700);
  var focusBtn = Array.prototype.filter.call(
    document.querySelectorAll(".library-controls .lib-pill"),
    function (b) { return /Focus/.test(b.textContent); })[0];
  T("focus_btn_found", !!focusBtn);
  focusBtn.click();
  await window.__sleep(600);
  var sheet2 = document.querySelector(".lib-sheet-backdrop");
  var save2 = Array.prototype.filter.call(sheet2.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Save as…"; })[0];
  window.prompt = function (msg, suggested) { T("prompt_default2", suggested); return "Brand new"; };
  save2.click();
  await window.__sleep(700);
  T("posts", window.__posts);
`;

test("smart playlists open as a playlist screen with tracks (v1.7.12)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor([SAVED]), driver: DRIVER_MAIN,
    name: "smart-detail", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the side menu shows a wall of tiles, not a sheet", () => {
    assert.equal(r.menu_entry_exists, true);
    assert.equal(r.no_lib_sheet, true, "the cramped sheet must be gone");
    assert.deepEqual(r.tiles, [{ title: "Nineties, unheard", sub: "3 Albums",
                                 art: "k1,k2,k3,k4" }]);
  });

  await t.test("opening one shows a playlist detail screen, not the library wall", () => {
    assert.equal(r.detail_open, true, "a smart playlist must open its own screen");
    assert.equal(r.detail_title, "Nineties, unheard");
    assert.equal(r.page_calls.length, 1);
    assert.match(r.page_calls[0], /id=sp1/);
    assert.match(r.page_calls[0], /offset=0/);
  });

  await t.test("it lists TRACKS, each with its own album's artwork", () => {
    assert.equal(r.rows_page1.length, 2);
    assert.equal(r.rows_page1[0].title, "Randy Described Eternity");
    // The artwork is the point — a flat track list without it is unreadable.
    assert.equal(r.rows_page1[0].art, "art10");
    // And the row says which album it came from.
    assert.match(r.rows_page1[0].artist, /Perfect From Now On/);
    assert.equal(r.rows_page1[0].albumOffset, "10");
  });

  await t.test("tracks page by album, and the control disappears when done", () => {
    assert.equal(r.more_visible_page1, true, "more albums remain — Load more must be offered");
    assert.equal(r.rows_page2.length, 3, "the second page appends rather than replacing");
    assert.equal(r.rows_page2[2].title, "Dirty Boots");
    assert.equal(r.more_hidden_after, true);
    assert.equal(r.page_calls_after.length, 2);
    assert.match(r.page_calls_after[1], /offset=2/, "the next page resumes after the albums already expanded");
  });

  await t.test("it offers the same actions an album does, plus edit and delete", () => {
    assert.deepEqual(r.action_buttons,
      ["Play now", "Queue", "Send to Roon", "Edit", "Delete"]);
  });

  await t.test("Send to Roon queues the albums and says what to do next", () => {
    // Roon's API cannot create a playlist, so the only honest outcome is a
    // filled queue plus the two taps that finish it in Roon.
    // Replacing the queue is destructive, so it must be confirmed and must say so.
    assert.equal(r.send_confirm_shown, true, "Send to Roon must confirm before replacing the queue");
    assert.match(String(r.send_confirm_msg), /replaces what's in the queue/i);
    assert.match(String(r.send_confirm_msg), /Add the queue to a Playlist/i,
      "the confirm should spell out the Roon-side step");
    const sends = r.posts.filter(p => p.url === "/api/play-multi");
    assert.equal(sends.length, 2, "Play now and Send to Roon should each queue once");
    assert.deepEqual(sends[1].body.items.map(i => i.offset), [10, 20],
      "the queue must be built in the saved view's order");
    assert.match(String(r.toast_after_send), /save the queue as a playlist in Roon/i,
      "the user must be told the step only Roon can do");
  });

  await t.test("a capped Play/Queue says how many of how many (v1.7.17)", () => {
    // The cap used to be silent AND low: the client asked for no `max`, the
    // server defaulted to 100, and a 1,179-album playlist queued 100 while the
    // toast said "Playing <name>". Both halves are asserted here — the ceiling
    // that is actually requested, and the count that is actually reported.
    assert.equal(r.album_calls.length, 2, "Play now and Send to Roon each resolve the albums");
    for (const u of r.album_calls) {
      assert.match(u, /max=400/, "the client must ask for the full ceiling, not the default 100");
    }
    // The stub hands back 2 albums of a stated 3, so both toasts must own up.
    assert.match(String(r.toast_after_play), /2 of 3 albums/,
      "a truncated Play now must say how much of the playlist it started");
    assert.match(String(r.toast_after_send), /2 of 3 albums/,
      "a truncated Send to Roon must say how much of the playlist reached the queue");
  });

  await t.test("Play now goes through play-multi; a track plays from its album", () => {
    const multi = r.posts.find(p => p.url === "/api/play-multi");
    assert.ok(multi, "Play now must use the batched play-multi path");
    assert.equal(multi.body.zone_or_output_id, "z1");
    assert.equal(multi.body.kind, "play_now");
    // Titles travel so play-multi's stale-offset defense can verify them.
    assert.deepEqual(multi.body.items.map(i => i.offset), [10, 20]);
    assert.equal(multi.body.items[0].title, "Perfect From Now On");

    const track = r.posts.find(p => p.url === "/api/play-track");
    assert.ok(track, "tapping a track must play it");
    assert.equal(track.body.offset, 10, "played from the album the track came from");
    // /api/play-track destructures `track` and `title`. Asserting the playlist
    // route's `track_index`/`track_title` here is what let a 400-on-every-tap
    // ship green — the stub accepts any body, so only the real names bite.
    assert.equal(track.body.track, 1);
    assert.equal(track.body.title, "I Would Hurt a Fly");
  });

  const ed = harness.renderPage({
    stub: stubFor([SAVED]), driver: DRIVER_EDIT,
    name: "smart-edit", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, ed);

  await t.test("Edit reopens the focus editor and saves back to the SAME record", () => {
    assert.equal(ed.focus_sheet_open, true);
    assert.equal(ed.save_btn_exists, true);
    assert.equal(ed.prompt_default, "Nineties, unheard",
      "editing should offer the existing name, not a generated description");
    const save = ed.posts.find(p => p.name === "Renamed");
    assert.ok(save, "no save was posted");
    // The id is what makes this an edit. Without it the server mints a new
    // record and the user ends up with two near-identical playlists.
    assert.equal(save.id, "sp1");
    assert.equal(save.view.sort, "year");
    // Strings: the client compares decades against String(value) throughout, so
    // the edited view must hand them back in that form. The server parses them.
    assert.deepEqual(save.view.decade, ["1990"]);
  });

  const ab = harness.renderPage({
    stub: stubFor([SAVED]), driver: DRIVER_ABANDON,
    name: "smart-abandon", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, ab);

  await t.test("abandoning an edit doesn't hijack the next save (v1.7.14)", () => {
    assert.equal(ab.sheet_closed, true);
    assert.equal(ab.focus_btn_found, true, "couldn't reach Focus from the library screen");
    // The default name proves which record the save is aimed at: the edited
    // playlist's name here would mean the abandoned edit is still in effect.
    assert.notEqual(ab.prompt_default2, "Nineties, unheard",
      "an abandoned edit must not pre-fill the next save with its name");
    const save = ab.posts.find(p => p.name === "Brand new");
    assert.ok(save, "no save was posted");
    assert.ok(!save.id,
      "the save carried the abandoned playlist's id — it would overwrite it");
  });
});
