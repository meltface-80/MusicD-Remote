"use strict";
// ---------------------------------------------------------------------------
// v1.7.22: long-press multi-select, on album grids and on album-view tracks.
//
// The rules this pins, each one a thing that was wrong or absent before:
//
//   1. Long press ARMS the mode and selects NOTHING. Previously the album grid
//      appeared to do this, but only because of a bug: the long-press callback
//      selected the tile, then the click the browser still dispatches on
//      release selected it again — toggling it straight back off. The right
//      behaviour resting on a double-fire is not the right behaviour.
//   2. The actions menu appears only once something is selected, and it
//      reports how many.
//   3. Selection is available on grids that pass their own opener — the
//      Library wall, Home carousels and label albums were excluded purely
//      because `buildAlbumTile` inferred "selectable" from "no opener".
//      Playlist tiles must stay NON-selectable: a playlist is not an album.
//   4. Track rows show a hollow circle that only becomes a tick when tapped.
//   5. Selected tracks play in ALBUM order, not tap order, and only the first
//      one honours the requested kind — otherwise "play now" on four tracks
//      leaves the last one playing alone, having wiped the three before it.
//   6. Every /api/play-track body carries the ALBUM's identity, so a drifted
//      offset is relocated instead of playing the wrong record.
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

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist A", image_key: null },
  { offset: 1, title: "Album B", subtitle: "Artist B", image_key: null },
  { offset: 2, title: "Album C", subtitle: "Artist C", image_key: null },
];

const DETAIL = {
  title: "Album A", subtitle: "Artist A", image_key: null,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [
    { title: "One",   subtitle: "Artist A" },
    { title: "Two",   subtitle: "Artist A" },
    { title: "Three", subtitle: "Artist A" },
  ],
};

const STUB = `
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/play-track") > -1) {
    window.__posts.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true, action: "Queue", track: "x" });
  }
  if (url.indexOf("/api/user-playlists/add-albums") > -1) {
    window.__posts.push({ url: "/api/user-playlists/add-albums",
                          body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true, id: "up_1", name: "Mix", added: 24, skipped: 0,
                           full: false, albums_read: 2, albums_failed: [], track_total: 24 });
  }
  if (url.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (url.indexOf("/api/play-multi") > -1) {
    window.__posts.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true, queued: 2, failed: 0, total: 2 });
  }
  if (url.indexOf("/api/album") > -1)      return window.__json(${JSON.stringify(DETAIL)});
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 3, filtered: false });
  return undefined;
});

// A real long press: press, wait past the 500ms threshold, release. The
// release dispatches a click exactly as a browser does — which is the whole
// point, because that click is what used to undo the selection.
window.__longPress = async function (el) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await window.__sleep(700);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await window.__sleep(80);
};
`;

const DRIVER_GRID = `
  await window.__sleep(600);
  // Build tiles through the shipping factory, the way artist-back.test.js
  // does — that IS the code path under test, and it avoids depending on which
  // screen happens to populate the grid at boot.
  var grid = document.getElementById("album-grid");
  grid.innerHTML = "";
  ${JSON.stringify(ALBUMS)}.forEach(function (a) {
    grid.appendChild(window.__buildAlbumTile(a));
  });
  await window.__sleep(60);
  function tiles() { return document.querySelectorAll("#album-grid .album"); }
  function menuShown() {
    var w = document.getElementById("select-menu-wrap");
    return w ? !w.classList.contains("hidden") : null;
  }
  T("tiles_present", tiles().length);
  T("menu_before", menuShown());

  await window.__longPress(tiles()[0]);
  T("menu_after_press", menuShown());
  T("selected_after_press", document.querySelectorAll(".album.is-selected").length);
  T("count_after_press", (document.getElementById("select-count") || {}).textContent || "");

  // Now actually select two, in a deliberate order.
  tiles()[2].click();
  await window.__sleep(60);
  tiles()[0].click();
  await window.__sleep(60);
  T("menu_after_select", menuShown());
  T("count_after_select", (document.getElementById("select-count") || {}).textContent || "");
  T("menu_title", (document.getElementById("select-menu-title") || {}).textContent || "");
  T("selected_count", document.querySelectorAll(".album.is-selected").length);

  // Open the menu and queue them.
  document.getElementById("select-menu-btn").click();
  await window.__sleep(120);
  T("menu_open", !document.getElementById("select-menu").classList.contains("hidden"));
  T("add_item_shown", !document.querySelector('[data-sel-act="add"]').classList.contains("hidden"));
  document.querySelector('[data-sel-act="queue"]').click();
  await window.__sleep(400);
  T("posts", window.__posts.slice());
  T("menu_after_action", menuShown());

  // Albums must be addable to a playlist too — they were refused with a toast.
  // The queue action above cleared the selection, so re-arm before selecting.
  await window.__longPress(tiles()[1]);
  tiles()[1].click();
  await window.__sleep(60);
  tiles()[0].click();
  await window.__sleep(60);
  window.prompt = function () { return "Mix"; };
  document.getElementById("select-menu-btn").click();
  await window.__sleep(120);
  document.querySelector('[data-sel-act="add"]').click();
  await window.__sleep(400);
  T("sheet_title", (document.querySelector(".lib-sheet-head h3") || {}).textContent || "");
  var rows = document.querySelectorAll(".lib-sheet-body .sheet-row");
  T("sheet_rows", Array.prototype.map.call(rows, function (b) { return b.textContent; }));
  rows[0].click();
  await window.__sleep(500);
  T("album_posts", window.__posts.filter(function (p) {
      return p.url === "/api/user-playlists/add-albums"; }));
  T("menu_after_add", menuShown());
`;

const DRIVER_TRACKS = `
  await window.__sleep(600);
  window.__openAlbum(${JSON.stringify(ALBUMS[0])}, { source: "search" });
  await window.__sleep(700);
  function rows() { return document.querySelectorAll("#modal-tracks .t-row"); }
  T("rows", rows().length);
  T("marks_hidden_before", getComputedStyle(rows()[0].querySelector(".t-mark")).display);

  await window.__longPress(rows()[1]);
  T("marks_visible_after", getComputedStyle(rows()[0].querySelector(".t-mark")).display);
  T("picked_after_press", document.querySelectorAll(".t-row.is-picked").length);
  T("menu_after_press", !document.getElementById("select-menu-wrap").classList.contains("hidden"));

  // Tap the circle on track 3, then track 1 — reverse of album order.
  rows()[2].querySelector(".t-mark").click();
  await window.__sleep(60);
  T("picked_one", document.querySelectorAll(".t-row.is-picked").length);
  T("pressed_attr", rows()[2].querySelector(".t-mark").getAttribute("aria-pressed"));
  rows()[0].querySelector(".t-mark").click();
  await window.__sleep(60);
  T("picked_two", document.querySelectorAll(".t-row.is-picked").length);
  T("menu_title", (document.getElementById("select-menu-title") || {}).textContent || "");

  // Tapping a selected row must not also open its action accordion.
  T("no_accordion", document.querySelectorAll("#modal-tracks .t-actions").length);

  document.getElementById("select-menu-btn").click();
  await window.__sleep(120);
  document.querySelector('[data-sel-act="play_now"]').click();
  await window.__sleep(700);
  T("posts", window.__posts.slice());
  T("picked_after_action", document.querySelectorAll(".t-row.is-picked").length);
`;

test("long-press multi-select on album grids (v1.7.22)", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    stub: STUB, driver: DRIVER_GRID, name: "multi-select-grid", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("long press arms the mode and selects nothing", () => {
    assert.equal(r.tiles_present, 3);
    assert.equal(r.menu_before, false, "the menu must not exist before a selection");
    assert.equal(r.selected_after_press, 0,
      "long press must ARM selection, not select the tile under the finger");
    assert.equal(r.menu_after_press, false,
      "with nothing selected there is nothing for the menu to act on");
  });

  await t.test("the menu appears with the first selection and counts it", () => {
    assert.equal(r.menu_after_select, true);
    assert.equal(r.count_after_select, "2");
    assert.equal(r.selected_count, 2);
    assert.match(String(r.menu_title), /2 albums selected/);
  });

  await t.test("albums can be added to a playlist (v1.7.28)", () => {
    // Previously refused outright with "Playlists hold tracks". A stored entry
    // does name a track — so the server reads each album's tracklist off the
    // Core — but that is our problem to solve, not the user's to work around.
    assert.equal(r.add_item_shown, true,
      "the option must be offered for an album selection");
    assert.match(String(r.sheet_title), /Add 2 albums to…/);
    assert.deepEqual(r.sheet_rows, ["＋ New playlist…"],
      "with no playlists yet, creating one is the only route");
    assert.equal(r.album_posts.length, 1);
    const body = r.album_posts[0].body;
    assert.equal(body.name, "Mix");
    assert.equal(body.albums.length, 2);
    // Identity travels so the server can relocate a drifted offset rather than
    // storing whatever record now sits there.
    for (const a of body.albums) {
      assert.ok(Number.isFinite(a.offset));
      assert.ok(a.title, "each album must carry its title");
    }
    assert.ok(!("tracks" in body), "albums go to the album route, not the track route");
    assert.equal(r.menu_after_add, false, "a completed add clears the selection");
  });

  await t.test("queueing sends every selected album with its identity", () => {
    assert.equal(r.menu_open, true, "the button must open the dropdown");
    assert.equal(r.posts.length, 1, "albums go in one batched play-multi call");
    const body = r.posts[0];
    assert.equal(body.kind, "queue");
    assert.equal(body.zone_or_output_id, "z1");
    assert.equal(body.items.length, 2);
    // Titles travel so play-multi's stale-offset defense can verify them.
    for (const it of body.items) assert.ok(it.title, "each item must carry its title");
    assert.equal(r.menu_after_action, false, "the menu goes when the selection does");
  });

  const k = harness.renderPage({
    stub: STUB, driver: DRIVER_TRACKS, name: "multi-select-tracks", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, k);

  await t.test("track circles are hidden until long press arms the list", () => {
    assert.equal(k.rows, 3);
    assert.equal(k.marks_hidden_before, "none",
      "an un-armed list must not show selection circles");
    assert.equal(k.marks_visible_after, "block");
    assert.equal(k.picked_after_press, 0,
      "long press must not select the track under the finger");
    assert.equal(k.menu_after_press, false);
  });

  await t.test("a circle becomes a tick only when tapped", () => {
    assert.equal(k.picked_one, 1);
    assert.equal(k.pressed_attr, "true");
    assert.equal(k.picked_two, 2);
    assert.match(String(k.menu_title), /2 tracks selected/);
    assert.equal(k.no_accordion, 0,
      "selecting a row must not also open its Play now / Queue accordion");
  });

  await t.test("selected tracks play in ALBUM order, first one only honouring the kind", () => {
    assert.equal(k.posts.length, 2, "one call per selected track");
    // Tapped 3 then 1; must be sent 1 then 3.
    assert.deepEqual(k.posts.map(p => p.track), [0, 2],
      "tracks must go in album order, not the order they were tapped");
    assert.deepEqual(k.posts.map(p => p.kind), ["play_now", "queue"],
      "play_now on every track would leave the last one playing alone");
    assert.deepEqual(k.posts.map(p => p.title), ["One", "Three"]);
  });

  await t.test("every play-track body carries the ALBUM's identity", () => {
    // Without this the offset is trusted blindly and a shifted library plays
    // whatever record now sits at that position.
    for (const p of k.posts) {
      assert.equal(p.album_title, "Album A");
      assert.equal(p.album_subtitle, "Artist A");
      assert.equal(p.zone_or_output_id, "z1");
      assert.ok(Number.isFinite(p.offset));
    }
    assert.equal(k.picked_after_action, 0, "a completed action clears the selection");
  });
});
