"use strict";
// ---------------------------------------------------------------------------
// v1.7.7: Roon playlists (read + play) via the official `playlists` browse
// hierarchy.
//
// The things worth pinning here are the ones that would silently do the wrong
// thing rather than visibly break:
//
//   1. Every request must carry BOTH offset and title. A playlist's item_key is
//      session-scoped server-side, so (offset, title) is its cross-request
//      identity — the offset is a hint and the title is the check. Dropping the
//      title turns a drifted offset into "opened/played the wrong playlist",
//      which is exactly the class of bug the album path took v1.6.38–.49 to fix.
//   2. Playing a track must target the LIVE zone selector, not a captured one —
//      the same defect just fixed in the Queue tab (v1.7.6).
//   3. Drilling into a playlist and pressing Back must return to the playlist
//      list, not dump the user on Home.
//   4. An empty library must explain itself rather than render a blank screen.
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
const ZONE2 = Object.assign({}, ZONE, { zone_id: "z2", display_name: "Kitchen" });

const PLAYLISTS = [
  { offset: 0, title: "Late Night",  subtitle: "42 tracks", image_key: "k0" },
  { offset: 1, title: "Road Trip",   subtitle: "18 tracks", image_key: null },
];

function stubFor(playlists) {
  return `
window.__playlists = ${JSON.stringify(playlists)};
window.__asks = [];
window.__artCalls = [];
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/playlists") > -1) {
    window.__asks.push(url.replace(/^.*\\/api\\//, "/api/"));
    return window.__json({ playlists: window.__playlists, total: window.__playlists.length });
  }
  if (url.indexOf("/api/playlist/art") > -1) {
    window.__artCalls.push(url.replace(/^.*\\/api\\//, "/api/"));
    var t = /title=([^&]*)/.exec(url);
    var name = t ? decodeURIComponent(t[1].replace(/\\+/g, " ")) : "";
    return window.__json({ title: name,
      art_keys: name === "Late Night" ? ["a1", "a2", "a3", "a4"] : [] });
  }
  if (url.indexOf("/api/playlist/play-track") > -1 || url.indexOf("/api/playlist/play") > -1) {
    window.__posts.push({ url: url.replace(/^.*\\/api\\//, "/api/"),
                          body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true, invoked: "Play Now" });
  }
  if (url.indexOf("/api/playlist") > -1) {
    window.__asks.push(url.replace(/^.*\\/api\\//, "/api/"));
    return window.__json({
      title: "Late Night", subtitle: "42 tracks", image_key: "k0",
      tracks: [
        { index: 0, title: "Teen Age Riot", subtitle: "Sonic Youth", image_key: null },
        { index: 1, title: "Tomorrow",      subtitle: "Built to Spill", image_key: null }
      ],
      total: 2, truncated: false, can_play: true
    });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [${JSON.stringify(ZONE)}, ${JSON.stringify(ZONE2)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;
}

const OPEN = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  var entry = document.querySelector('[data-action="playlists"]');
  T("menu_entry_exists", !!entry);
  entry.click();
  await window.__sleep(600);
  function tiles() {
    return Array.prototype.map.call(document.querySelectorAll("#album-grid .album"),
      function (b) { return (b.querySelector(".album-title") || {}).textContent || ""; });
  }
`;

const DRIVER_MAIN = OPEN + `
  T("tiles", tiles());
  T("asks_after_list", window.__asks.slice());

  // The mosaics fill in behind the grid; give the throttled workers a moment.
  await window.__sleep(800);
  T("art_calls_titles", window.__artCalls.map(function (u) {
    var m = /title=([^&]*)/.exec(u);
    return m ? decodeURIComponent(m[1].replace(/\\+/g, " ")) : "";
  }));
  var wraps = document.querySelectorAll("#album-grid .album .album-art-wrap");
  T("mosaic_keys", wraps[0] ? (wraps[0].dataset.artKeys || "") : null);
  T("mosaic_flag", wraps[0] ? (wraps[0].dataset.mosaic || null) : null);
  T("second_tile_keys", wraps[1] ? (wraps[1].dataset.artKeys || "") : null);
  T("second_tile_placeholder", wraps[1] ? wraps[1].classList.contains("no-image") : null);

  // Drill into the first playlist.
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(600);
  var detail = document.querySelector(".playlist-detail");
  T("detail_open", !!detail);
  T("detail_title", (document.querySelector(".playlist-title") || {}).textContent || "");
  T("detail_asks", window.__asks.slice());
  T("track_titles", Array.prototype.map.call(
      document.querySelectorAll(".playlist-tracks .track-title"),
      function (e) { return e.textContent; }));

  // Play the whole playlist.
  var playBtn = Array.prototype.filter.call(
    document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Play now"; })[0];
  T("play_btn_exists", !!playBtn);
  playBtn.click();
  await window.__sleep(400);

  // Switch zone, then play a single track — it must target the NEW zone.
  var sel = document.getElementById("zone-select");
  sel.value = "z2";
  sel.dispatchEvent(new Event("change"));
  await window.__sleep(300);
  document.querySelectorAll(".playlist-tracks .track-row")[1].click();
  await window.__sleep(400);
  T("posts", window.__posts);

  // Back must return to the playlist LIST, not Home.
  var back = document.querySelector(".playlist-back");
  T("back_exists", !!back);
  back.click();
  await window.__sleep(600);
  T("back_to_list", tiles());
  T("detail_gone", !document.querySelector(".playlist-detail"));
`;

const DRIVER_EMPTY = OPEN + `
  T("tiles", tiles());
  T("banner", (document.getElementById("status-banner") || {}).textContent || "");
`;

test("Roon playlists list, open and play (v1.7.7)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor(PLAYLISTS), driver: DRIVER_MAIN,
    name: "playlists", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the side menu opens the playlist list", () => {
    assert.equal(r.menu_entry_exists, true, "no Playlists entry in the side menu");
    assert.deepEqual(r.tiles, ["Late Night", "Road Trip"]);
    assert.equal(r.asks_after_list[0], "/api/playlists",
      "the list must be fetched first, before any artwork");
  });

  await t.test("playlist tiles get a cover mosaic built from their tracks", () => {
    // Roon gives a playlist no image_key of its own, so without this every tile
    // is a music-note placeholder.
    assert.deepEqual(r.art_calls_titles, ["Late Night", "Road Trip"],
      "artwork should be requested once per playlist that has none");
    assert.equal(r.mosaic_keys, "a1,a2,a3,a4", "four distinct covers should fill the tile");
    assert.equal(r.mosaic_flag, "4", "four covers should be laid out as a 2x2");
    // The playlist with no artwork keeps its placeholder rather than going blank.
    assert.equal(r.second_tile_keys, "");
    assert.equal(r.second_tile_placeholder, true);
  });

  await t.test("opening one sends offset, title AND zone", () => {
    assert.equal(r.detail_open, true);
    assert.equal(r.detail_title, "Late Night");
    const open = r.detail_asks.find(u => u.startsWith("/api/playlist?"));
    assert.ok(open, "no /api/playlist request was made");
    assert.match(open, /offset=0/);
    // Roon needs a zone to RESOLVE a smart playlist's contents — without it the
    // playlist opens with no tracks at all (v1.7.9).
    assert.match(open, /zone=z1/, "the zone must travel with the read");
    // The title is the check that makes a drifted offset safe. Without it the
    // server would open whatever moved into position 0.
    assert.match(open, /title=Late(%20|\+)Night/,
      "the title must travel with the offset — it is the identity check");
  });

  await t.test("its tracks are listed", () => {
    assert.deepEqual(r.track_titles, ["Teen Age Riot", "Tomorrow"]);
    assert.equal(r.play_btn_exists, true);
  });

  await t.test("play-all and play-track carry the identity and the LIVE zone", () => {
    assert.equal(r.posts.length, 2);

    assert.equal(r.posts[0].url, "/api/playlist/play");
    assert.deepEqual(r.posts[0].body, {
      zone_or_output_id: "z1", offset: 0, title: "Late Night", kind: "play_now",
    });

    // The zone was switched between the two clicks. A captured zone id would
    // still say z1 here — the same defect fixed in the Queue tab in v1.7.6.
    assert.equal(r.posts[1].url, "/api/playlist/play-track");
    assert.deepEqual(r.posts[1].body, {
      zone_or_output_id: "z2", offset: 0, title: "Late Night",
      track_index: 1, track_title: "Tomorrow", kind: "play_now",
    });
  });

  await t.test("Back returns to the playlist list, not Home", () => {
    assert.equal(r.back_exists, true);
    assert.equal(r.detail_gone, true);
    assert.deepEqual(r.back_to_list, ["Late Night", "Road Trip"],
      "Back from a playlist must land on the playlist list");
  });

  const empty = harness.renderPage({
    stub: stubFor([]), driver: DRIVER_EMPTY,
    name: "playlists-empty", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, empty);
  await t.test("no playlists explains itself rather than showing a blank screen", () => {
    assert.deepEqual(empty.tiles, []);
    assert.match(String(empty.banner), /No playlists/);
  });
});
