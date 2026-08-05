"use strict";
// ---------------------------------------------------------------------------
// v1.7.25: one playlist screen, a shorter side menu, and the unheard action on
// Home.
//
// What's worth pinning, and why each one could regress silently:
//
//   1. There is ONE Playlists screen. Stored playlists and Roon's appear on it
//      together, stored ones first — an import that landed under Roon's list
//      would read as an import that failed.
//   2. Roon being unreachable must not hide the playlists on this disk. The
//      two sources are fetched together and tolerated separately.
//   3. The side menu no longer carries Filter (it lives on the Library screen)
//      or Play something unheard (now on Home), and the playlist entries are
//      in the order asked for.
//   4. "Play something unheard" leads the Not-played carousel, and pressing it
//      spins THAT tile — an earlier version forwarded the click to the hidden
//      top-bar button, which left the pressed tile inert for two seconds.
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

const ROON_PLAYLISTS = [
  { offset: 0, title: "Late Night", subtitle: "42 tracks", image_key: "k0", art_keys: ["x1"] },
];
const MY_PLAYLISTS = [
  { id: "up_1", name: "Imported mix", track_total: 2, art_keys: ["a10"], updated_at: 1 },
];
const UNPLAYED = [
  { offset: 5, title: "Album X", subtitle: "Artist X", image_key: null },
];

function stub(roonOk) {
  return `
window.__unheardCalls = 0;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/play-unheard") > -1) {
    window.__unheardCalls++;
    return window.__json({ ok: true, album: "Something" });
  }
  if (url.indexOf("/api/playlists") > -1) {
    if (!${roonOk}) return { ok: false, status: 503,
      json: function () { return Promise.resolve({ error: "Not paired" }); } };
    return window.__json({ playlists: ${JSON.stringify(ROON_PLAYLISTS)}, total: 1 });
  }
  if (url.indexOf("/api/user-playlists") > -1)
    return window.__json({ playlists: ${JSON.stringify(MY_PLAYLISTS)} });
  if (url.indexOf("/api/playlist/art") > -1)
    return window.__json({ title: "Late Night", art_keys: [] });
  if (url.indexOf("/api/home/unplayed") > -1)
    return window.__json({ albums: ${JSON.stringify(UNPLAYED)}, aotd: null });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(900);

  // --- Home: the unheard tile leads the Not-played row ---
  var row = document.getElementById("home-unplayed");
  var first = row ? row.firstElementChild : null;
  T("first_tile_id", first ? first.id : null);
  T("first_tile_label", first ? (first.querySelector(".album-title") || {}).textContent || "" : "");
  T("row_tiles", row ? row.querySelectorAll(".album").length : 0);

  // Pressing it must spin THAT tile, not something off-screen.
  first.click();
  await window.__sleep(200);
  T("tile_spinning", first.classList.contains("spinning"));
  await window.__sleep(2600);
  T("unheard_calls", window.__unheardCalls);
  T("tile_spinning_after", first.classList.contains("spinning"));

  // --- The side menu ---
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  T("menu_labels", Array.prototype.filter.call(
      document.querySelectorAll(".menu-drawer .menu-item"),
      function (b) { return !b.classList.contains("hidden"); })
    .map(function (b) { return (b.querySelector("span") || {}).textContent || ""; }));

  // --- One Playlists screen ---
  document.querySelector('[data-action="playlists"]').click();
  await window.__sleep(900);
  T("tiles", Array.prototype.map.call(document.querySelectorAll("#album-grid .album"),
      function (b) { return (b.querySelector(".album-title") || {}).textContent || ""; }));
  T("banner", (document.getElementById("status-banner") || {}).textContent || "");
`;

test("one playlist screen, a shorter menu, unheard on Home (v1.7.25)",
  { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    stub: stub(true), driver: DRIVER, name: "menu-layout", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("Play something unheard leads the Not-played row", () => {
    assert.equal(r.first_tile_id, "home-unheard-tile",
      "the action must be the FIRST thing in the row, not buried after the albums");
    assert.equal(r.first_tile_label, "Play something unheard");
    assert.equal(r.row_tiles, 2, "the row still shows its albums alongside the action");
  });

  await t.test("pressing it spins that tile and makes the request", () => {
    assert.equal(r.tile_spinning, true,
      "forwarding the click elsewhere left the pressed tile inert for two seconds");
    assert.equal(r.unheard_calls, 1);
    assert.equal(r.tile_spinning_after, false, "the spin must stop when the request finishes");
  });

  await t.test("the side menu drops Filter and the unheard action", () => {
    assert.ok(!r.menu_labels.includes("Filter"),
      "Filter lives on the Library screen — it has no business here too");
    assert.ok(!r.menu_labels.includes("Play something unheard"));
    assert.ok(!r.menu_labels.includes("My playlists"),
      "there is one playlist screen now, so there is one entry for it");
  });

  await t.test("the playlist entries are in the order asked for", () => {
    const pl = r.menu_labels.filter(l => /playlist/i.test(l));
    assert.deepEqual(pl, ["Dynamic Playlists", "Playlists", "Import a playlist"]);
  });

  await t.test("Playlists shows stored and Roon playlists together, stored first", () => {
    assert.deepEqual(r.tiles, ["Imported mix", "Late Night"],
      "an import listed under Roon's playlists reads as an import that failed");
    assert.equal(r.banner, "", "nothing to warn about when both sources answered");
  });

  const offline = harness.renderPage({
    stub: stub(false), driver: DRIVER, name: "menu-layout-offline", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, offline);

  await t.test("Roon being unreachable doesn't hide what's stored here", () => {
    assert.deepEqual(offline.tiles, ["Imported mix"],
      "playlists on this disk don't depend on Roon answering");
    assert.match(String(offline.banner), /Couldn't reach Roon/,
      "…but the user has to be told the list is incomplete");
  });
});
