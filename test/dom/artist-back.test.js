"use strict";
// ---------------------------------------------------------------------------
// v1.6.52 regression: albums went untappable after Back from an artist view.
//
// showArtistAlbums() takes over the shared #album-grid and snapshots the screen
// it came from so its "← Back" can restore it. The bug was that the snapshot
// was taken by READING .innerHTML: the markup came back looking perfect, but
// re-parsing it built brand-new elements, dropping every click listener and the
// closure holding each album's offset. Every tile was dead.
//
// test/static/preflight.test.js catches the specific `.innerHTML` read. This
// test catches the BEHAVIOUR, whatever the mechanism — the tiles must still be
// clickable after Back, and they must be the very same DOM nodes.
//
// Two independent detectors, because either alone can be fooled:
//   * a JS expando property on the node — survives a move, cannot survive an
//     innerHTML serialise/re-parse;
//   * a real dispatched click that must reach openAlbum and fire /api/album.
// A control click before the round trip proves the detector works at all, so a
// failure can never be "the harness cannot detect clicks".
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist One", image_key: "k0" },
  { offset: 1, title: "Album B", subtitle: "Artist One", image_key: "k1" },
  { offset: 2, title: "Album C", subtitle: "Artist Two", image_key: "k2" },
];

const STUB = `
var ALBUMS = ${JSON.stringify(ALBUMS)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/artist-albums") > -1)
    return window.__json({ primary: [ALBUMS[0]], featured: [] });
  if (url.indexOf("/api/artist-bio") > -1)
    return window.__json({ bio: null });
  if (url.indexOf("/api/album?") > -1)
    return window.__json({ album: ALBUMS[0], tracks: [], actions: [], offset: 0, artists: ["Artist One"] });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(400);                       // let app.js finish booting

  var grid = document.getElementById("album-grid");
  T("grid_present", !!grid);

  // Paint a wall of real tiles and stamp each live node with an expando.
  // An innerHTML round trip cannot carry these across.
  function paintWall() {
    grid.innerHTML = "";
    for (var i = 0; i < 2; i++) {
      var tile = window.__buildAlbumTile(${JSON.stringify(ALBUMS)}[i]);
      tile.__liveNodeTag = "LIVE-" + i;
      grid.appendChild(tile);
    }
    grid.classList.remove("hidden");
  }

  // Dispatch a real click and report whether it reached openAlbum's fetch.
  async function clickReachesOpenAlbum(tile) {
    var before = window.__callsMatching("/api/album?");
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await window.__sleep(120);
    return window.__callsMatching("/api/album?") > before;
  }
  function closeModal() {
    var x = document.querySelector("#album-modal [data-close]");
    if (x) x.click();
  }

  // ---- control: tiles are clickable BEFORE any artist round trip ----------
  paintWall();
  T("tiles_before", grid.querySelectorAll(".album").length);
  T("clickable_before", await clickReachesOpenAlbum(grid.querySelectorAll(".album")[0]));
  closeModal();
  await window.__sleep(120);

  // ---- the reported path: wall -> artist view -> Back --------------------
  paintWall();
  await window.__showArtistAlbums("Artist One");
  await window.__sleep(300);
  T("artist_view_entered", window.__artistViewActive());
  var backBtn = document.getElementById("artist-back-btn");
  T("back_button_present", !!backBtn);

  backBtn.click();
  await window.__sleep(300);
  T("artist_view_exited", window.__artistViewActive());

  var tiles = grid.querySelectorAll(".album");
  T("tiles_after", tiles.length);
  T("titles_after", Array.prototype.map.call(tiles, function (t) {
    var el = t.querySelector(".album-title");
    return el ? el.textContent : null;
  }));

  // Detector 1 — same DOM nodes, not re-parsed markup.
  T("expandos_after", Array.prototype.map.call(tiles, function (t) {
    return t.__liveNodeTag === undefined ? null : t.__liveNodeTag;
  }));

  // Detector 2 — the tiles genuinely still open their album.
  T("clickable_after", tiles.length ? await clickReachesOpenAlbum(tiles[0]) : false);
  closeModal();
  await window.__sleep(100);

  // ---- chained artist -> artist -> Back restores the ORIGINAL wall -------
  paintWall();
  await window.__showArtistAlbums("Artist One");
  await window.__sleep(250);
  await window.__showArtistAlbums("Artist Two");
  await window.__sleep(250);
  document.getElementById("artist-back-btn").click();
  await window.__sleep(300);
  var chained = grid.querySelectorAll(".album");
  T("chained_tiles_after", chained.length);
  T("chained_expandos", Array.prototype.map.call(chained, function (t) {
    return t.__liveNodeTag === undefined ? null : t.__liveNodeTag;
  }));
  T("chained_clickable", chained.length ? await clickReachesOpenAlbum(chained[0]) : false);
`;

test("artist view Back leaves the album wall fully alive (v1.6.52)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
    return;
  }

  const r = harness.renderPage({ stub: STUB, driver: DRIVER, name: "artist-back" });
  harness.assertNoPageError(assert, r);

  await t.test("the harness itself works — tiles start clickable", () => {
    assert.equal(r.grid_present, true);
    assert.equal(r.tiles_before, 2);
    assert.equal(r.clickable_before, true,
      "control failed: a freshly built tile did not reach openAlbum, so the " +
      "rest of this test proves nothing. Fix the harness, not the assertion.");
  });

  await t.test("the artist view opens and offers a Back button", () => {
    assert.equal(r.artist_view_entered, true);
    assert.equal(r.back_button_present, true);
  });

  await t.test("Back restores the wall's tiles", () => {
    assert.equal(r.artist_view_exited, false);
    assert.equal(r.tiles_after, 2, "the wall came back empty");
    assert.deepEqual(r.titles_after, ["Album A", "Album B"]);
  });

  await t.test("the restored tiles are the SAME nodes, not re-parsed markup", () => {
    // If this fails with [null, null], the screen was saved by reading
    // .innerHTML — the exact v1.6.52 root cause.
    assert.deepEqual(r.expandos_after, ["LIVE-0", "LIVE-1"],
      "tile identity was lost — the screen was serialised to markup and " +
      "re-parsed instead of having its live nodes moved");
  });

  await t.test("the restored tiles are still clickable", () => {
    assert.equal(r.clickable_after, true,
      "THE REPORTED BUG: after Back the tiles render but no longer open " +
      "their album — their click listener and offset closure were dropped");
  });

  await t.test("artist -> artist -> Back also restores a live wall", () => {
    assert.equal(r.chained_tiles_after, 2);
    assert.deepEqual(r.chained_expandos, ["LIVE-0", "LIVE-1"]);
    assert.equal(r.chained_clickable, true);
  });
});
