"use strict";
// ---------------------------------------------------------------------------
// v1.6.60: per-artist links on the Now Playing screen.
//
// The album view has offered these for a while; this gives the same control to
// the now-playing screen. Three things here are easy to get wrong and invisible
// when you do:
//
//   1. The screen is repainted by a poll every 1.5s. Rebuilding the button row
//      on every tick drops keyboard focus mid-press and thrashes the DOM behind
//      the artwork, so the render is signature-gated. A test that only checks
//      "the links exist" would never see that.
//   2. #np-screen lives INSIDE the album modal, and showArtistAlbums parks the
//      grid/topbar/labels but knows nothing about the modal. Navigating without
//      closing it first renders the artist grid behind a full-screen modal with
//      body scroll still locked.
//   3. Roon's line2 is the TRACK artist, so a name may have no library screen.
//      Those render as plain text, not as links to an empty page.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// A zone playing a two-artist track where only one artist is in the library.
const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "playing", outputs: [],
  now_playing: {
    line1: "So What",
    line2: "Miles Davis / Session Player",
    line3: "Kind of Blue",
    artists: [
      { name: "Miles Davis",    linkable: true  },
      { name: "Session Player", linkable: false },
    ],
    length: 545, seek_position: 30,
  },
};

const STUB = `
var ZONE = ${JSON.stringify(ZONE)};
window.__zone = JSON.parse(JSON.stringify(ZONE));
window.__installFetch(function (url) {
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (url.indexOf("/api/artist-albums") > -1)
    return window.__json({ artist: "Miles Davis", primary: [
      { offset: 0, title: "Kind of Blue", subtitle: "Miles Davis", image_key: "k0" }
    ], featured: [] });
  if (url.indexOf("/api/artist-bio") > -1) return window.__json({ bio: null });
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

const DRIVER = `
  await window.__sleep(400);

  // Open the now-playing screen the way a user does: tap the mini transport.
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  T("bar_shown", !bar.classList.contains("hidden"));
  document.querySelector(".mt-info").click();
  await window.__sleep(500);

  var modal = document.getElementById("album-modal");
  T("np_open", modal.classList.contains("np-mode") && !modal.classList.contains("hidden"));

  var npArtist = document.getElementById("np-artist");
  function linkTexts() {
    return Array.prototype.map.call(npArtist.querySelectorAll(".np-artist-link"),
      function (b) { return b.textContent; });
  }
  function plainTexts() {
    return Array.prototype.map.call(npArtist.querySelectorAll(".np-artist-plain"),
      function (s) { return s.textContent; });
  }

  T("links", linkTexts());
  T("plain", plainTexts());
  T("line_text", npArtist.textContent);
  T("link_is_button", (function () {
    var b = npArtist.querySelector(".np-artist-link");
    return b ? b.tagName : null;
  })());

  // ---- the 1.5s poll must NOT rebuild the row -----------------------------
  // Stamp the live node; an expando cannot survive a rebuild.
  var first = npArtist.querySelector(".np-artist-link");
  first.__liveTag = "LIVE";
  first.focus();
  T("focused_before", document.activeElement === first);
  await window.__sleep(4000);           // several poll ticks
  var after = npArtist.querySelector(".np-artist-link");
  T("same_node_after_polls", after && after.__liveTag === "LIVE");
  T("focus_survives_polls", document.activeElement === after);

  // ---- a track change DOES re-render --------------------------------------
  window.__zone.now_playing = {
    line1: "Blue in Green", line2: "Bill Evans", line3: "Kind of Blue",
    artists: [{ name: "Bill Evans", linkable: true }],
    length: 337, seek_position: 5
  };
  await window.__sleep(3000);
  T("links_after_track_change", linkTexts());

  // ---- tapping a link closes the modal and opens the artist ---------------
  window.__zone.now_playing = JSON.parse(JSON.stringify(ZONE.now_playing));
  await window.__sleep(3000);
  var target = npArtist.querySelector(".np-artist-link");
  T("target_text", target ? target.textContent : null);
  target.click();
  await window.__sleep(600);

  T("modal_closed", document.getElementById("album-modal").classList.contains("hidden"));
  T("body_overflow", document.body.style.overflow || "");
  T("artist_view_active", !!(window.__artistViewActive && window.__artistViewActive()));
  T("artist_fetched", window.__callsMatching("/api/artist-albums") > 0);
  T("artist_requested", (function () {
    var hits = window.__calls.filter(function (u) { return u.indexOf("/api/artist-albums") > -1; });
    if (!hits.length) return null;
    return decodeURIComponent((hits[hits.length - 1].split("artist=")[1] || "").split("&")[0]);
  })());
  // The grid must be genuinely on top, not behind a still-open modal.
  T("grid_visible", (function () {
    var g = document.getElementById("album-grid");
    return !!g && !g.classList.contains("hidden");
  })());
`;

test("Now Playing artist names are per-artist links (v1.6.60)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
    return;
  }

  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "np-artist-links", windowSize: "390x844", budgetMs: 40000,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the harness reaches the now-playing screen", () => {
    assert.equal(r.bar_shown, true, "the mini transport never appeared");
    assert.equal(r.np_open, true, "the now-playing screen never opened");
  });

  await t.test("linkable artists render as buttons, the rest as plain text", () => {
    assert.deepEqual(r.links, ["Miles Davis"]);
    assert.equal(r.link_is_button, "BUTTON");
    assert.deepEqual(r.plain, ["Session Player"],
      "a track artist the library has no screen for was offered as a link — " +
      "tapping it opens an empty artist page");
    // Both names still READ as one credit, whatever their affordance.
    assert.match(r.line_text, /Miles Davis/);
    assert.match(r.line_text, /Session Player/);
  });

  await t.test("the 1.5s poll does not rebuild the row", () => {
    assert.equal(r.focused_before, true, "control failed: the link never took focus");
    assert.equal(r.same_node_after_polls, true,
      "the artist row was rebuilt by the poll — the buttons are replaced every " +
      "1.5s, which thrashes the DOM and drops focus mid-press");
    assert.equal(r.focus_survives_polls, true,
      "keyboard focus was lost to a poll tick");
  });

  await t.test("a track change re-renders the row", () => {
    assert.deepEqual(r.links_after_track_change, ["Bill Evans"],
      "the signature guard is too strong — the row stopped following the music");
  });

  await t.test("tapping a link leaves the modal and opens that artist", () => {
    assert.equal(r.target_text, "Miles Davis");
    assert.equal(r.modal_closed, true,
      "THE TRAP: #np-screen is inside the album modal, and showArtistAlbums " +
      "knows nothing about the modal — leaving it open renders the artist grid " +
      "behind a full-screen overlay");
    assert.equal(r.body_overflow, "",
      "body scroll was left locked by the modal that was never closed");
    assert.equal(r.artist_view_active, true);
    assert.equal(r.artist_fetched, true);
    assert.equal(r.artist_requested, "Miles Davis");
    assert.equal(r.grid_visible, true);
  });
});

// The now-playing links reuse the album view's renderer. That renderer was
// extracted from setModalArtist to be shared, so the album view has to be
// re-proved: it is the caller that already worked, and the one a refactor
// regression would break silently.
const ALBUM = { offset: 0, title: "Kind of Blue", subtitle: "Miles Davis / John Coltrane",
                image_key: "k0" };

const ALBUM_STUB = `
var ALBUM = ${JSON.stringify(ALBUM)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/album?") > -1)
    return window.__json({ album: ALBUM, tracks: [], actions: [], offset: 0,
                           artists: ["Miles Davis", "John Coltrane"] });
  if (url.indexOf("/api/album/extras") > -1) return window.__json({});
  if (url.indexOf("/api/artist-albums") > -1)
    return window.__json({ artist: "John Coltrane", primary: [], featured: [] });
  if (url.indexOf("/api/artist-bio") > -1) return window.__json({ bio: null });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [ALBUM], total: 1, filtered: false });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;

const ALBUM_DRIVER = `
  await window.__sleep(400);
  window.__openAlbum(${JSON.stringify(ALBUM)}, { source: "search" });
  await window.__sleep(600);          // let /api/album land and re-render validated

  var sub = document.getElementById("modal-subtitle");
  var links = Array.prototype.map.call(sub.querySelectorAll(".modal-artist-link"),
    function (b) { return b.textContent; });
  T("links", links);
  T("box_present", !!document.getElementById("modal-artist-names"));

  var second = sub.querySelectorAll(".modal-artist-link")[1];
  second.click();
  await window.__sleep(500);
  T("modal_closed", document.getElementById("album-modal").classList.contains("hidden"));
  T("artist_requested", (function () {
    var hits = window.__calls.filter(function (u) { return u.indexOf("/api/artist-albums") > -1; });
    if (!hits.length) return null;
    return decodeURIComponent((hits[hits.length - 1].split("artist=")[1] || "").split("&")[0]);
  })());
`;

test("the album view's artist links still work after the shared extraction",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: ALBUM_STUB, driver: ALBUM_DRIVER, name: "album-artist-links", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the validated server split renders one link per artist", () => {
      assert.deepEqual(r.links, ["Miles Davis", "John Coltrane"]);
      assert.equal(r.box_present, true,
        "#modal-artist-names is gone — renderExtras appends the year/label/score " +
        "spans after it, and without it the late validated re-render wipes them");
    });

    await t.test("tapping one closes the modal and opens that artist", () => {
      assert.equal(r.modal_closed, true);
      assert.equal(r.artist_requested, "John Coltrane");
    });
  });
