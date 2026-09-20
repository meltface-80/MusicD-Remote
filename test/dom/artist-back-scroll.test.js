"use strict";
// ---------------------------------------------------------------------------
// v1.8.26: Back from an artist view lands where you were on the wall.
//
// exitArtistView() has restored `saved.scrollTop` since v1.6.52, under a
// comment reading "Land back where the user was, not at the top of the wall."
// It never could. showArtistAlbums() captured the snapshot like this:
//
//     while (grid.firstChild) gridNodes.appendChild(grid.firstChild);  // drain
//     ...
//     saved = { ..., scrollTop: mainEl.scrollTop }                     // read
//
// Draining the grid moves every tile out of <main>, which collapses from a few
// thousand pixels to a few hundred. A scroller that no longer has the range
// clamps scrollTop to 0 immediately — so the read stored 0, and the restore
// put 0 back, faithfully. Nothing about the restore looked wrong, which is why
// it survived: the bug is an ORDERING one, twenty lines earlier.
//
// Measured, not asserted from the source. The wall is scrolled to a real
// offset, the round trip is driven, and the position is read back — plus
// scrollHeight at the same moment, because "scrollTop is 0" means nothing if
// the page is too short to hold anything else. Both numbers come from the same
// frame (CLAUDE.md: two numbers from two different moments are not a
// measurement).
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = Array.from({ length: 60 }, (_, i) => ({
  offset: i, title: "Album " + i, subtitle: "Artist " + (i % 7), image_key: "k" + i,
}));

const STUB = `
var ALBUMS = ${JSON.stringify(ALBUMS)};
var N = ALBUMS.length;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u) {
  if (u.indexOf("/api/artist-albums") > -1) return window.__json({ primary: ALBUMS.slice(0, 4), featured: [] });
  if (u.indexOf("/api/artist-bio") > -1)    return window.__json({ bio: null });
  if (u.indexOf("/api/random-albums") > -1) return window.__json({ albums: ALBUMS, total: N, filtered: false });
  if (u.indexOf("/api/library/albums") > -1) return window.__json({ albums: ALBUMS, offset: 0, total: N });
  if (u.indexOf("/api/zones") > -1)         return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1)    return window.__json({ zone: null });
  if (u.indexOf("/api/queue") > -1)         return window.__json({ items: [] });
  if (u.indexOf("/api/filters") > -1)       return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)         return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)        return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)              return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(700);
  var main = document.querySelector("main");
  var grid = document.getElementById("album-grid");

  window.__showWall({ loadIfEmpty: true });
  await window.__sleep(600);
  T("tiles_on_wall", grid.querySelectorAll(".album").length);

  // A real offset, well down a wall tall enough to hold it.
  main.scrollTop = 800;
  await window.__sleep(120);
  T("wall_scrollHeight", main.scrollHeight);
  T("scrolled_to", main.scrollTop);

  await window.__showArtistAlbums("Artist 1");
  await window.__sleep(500);
  T("artist_view_active", !!(window.__artistViewActive && window.__artistViewActive()));

  var back = document.getElementById("artist-back-btn");
  T("back_present", !!back);
  back.click();
  await window.__sleep(400);

  // Both numbers out of the same frame: a restored position means nothing
  // without the height that makes it reachable.
  T("after_back_scroll", main.scrollTop);
  T("after_back_scrollHeight", main.scrollHeight);
  T("after_back_tiles", grid.querySelectorAll(".album").length);
`;

test("Back from an artist view lands where you were on the wall", { concurrency: 1 }, async (t) => {
  for (const size of ["390x844", "768x1024"]) {
    await t.test(size, () => {
      const r = harness.renderPage({ stub: STUB, driver: DRIVER, name: "artist-scroll-" + size.split("x")[0], windowSize: size });
      harness.assertNoPageError(assert, r);

      assert.ok(r.tiles_on_wall >= 20, "the fixture wall only rendered " + r.tiles_on_wall + " tiles");
      assert.ok(r.scrolled_to > 0, "the wall never scrolled, so this proves nothing");
      assert.equal(r.artist_view_active, true, "the artist view did not open");
      assert.equal(r.back_present, true, "the artist view has no Back button");

      assert.equal(r.after_back_tiles, r.tiles_on_wall,
        "the wall came back with " + r.after_back_tiles + " tiles instead of " + r.tiles_on_wall);
      // The height proves the position was reachable — without it, "scrollTop
      // is 0" could just mean the restored page is one screen tall.
      assert.ok(r.after_back_scrollHeight >= r.scrolled_to,
        "the restored wall is only " + r.after_back_scrollHeight + "px tall, so " +
        r.scrolled_to + " was never reachable and this assertion cannot speak");
      assert.equal(r.after_back_scroll, r.scrolled_to,
        "Back landed at " + r.after_back_scroll + " instead of " + r.scrolled_to +
        " at " + size + ". The snapshot reads main.scrollTop AFTER the grid has been " +
        "drained into a fragment — <main> has already collapsed by then and clamped " +
        "the value to 0, so the restore puts 0 back.");
    });
  }
});
