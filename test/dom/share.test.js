"use strict";
// ---------------------------------------------------------------------------
// v1.7.19: the Share button on a playlist and on a smart playlist.
//
// The encoder is unit-tested; what can only be checked here is what the CLIENT
// puts into the request, because that is where a share silently becomes wrong:
//
//   1. The entries are built field-by-field from the rows on screen. Handing
//      the server response straight back would put image_key, item-level state
//      and anything else it carried into a document the user is about to give
//      to someone else.
//   2. A smart playlist is a QUERY. Its tracks are not known until each album
//      has been opened on the Core, so Share has to finish the paging the
//      "Load more" button drives — sharing only the first page would look
//      identical to sharing the whole thing.
//   3. Tapping Share while the first page is still in flight must WAIT for it,
//      not see "already loading" and give up with an empty list.
//   4. Whatever the server says it left out has to reach the user.
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
  id: "sp1", name: "Nineties, unheard", album_total: 3, art_keys: ["k1"],
  view: { sort: "year", dir: "desc", seed: 1, decade: [1990], source: [], played: "12" },
};

// Two album pages, so Share has to keep going after the first.
const PAGE1 = {
  id: "sp1", name: "Nineties, unheard", view: SAVED.view,
  tracks: [
    { album_offset: 10, album_title: "Perfect From Now On", album_artist: "Built to Spill",
      image_key: "art10", track_index: 0, track_no: 1,
      title: "Randy Described Eternity", subtitle: "Built to Spill" },
  ],
  album_offset: 0, albums_expanded: 1, album_total: 2, done: false,
};
const PAGE2 = {
  id: "sp1", name: "Nineties, unheard", view: SAVED.view,
  tracks: [
    { album_offset: 20, album_title: "Goo", album_artist: "Sonic Youth",
      image_key: "art20", track_index: 0, track_no: 3,
      title: "Dirty Boots", subtitle: "Sonic Youth" },
  ],
  album_offset: 1, albums_expanded: 1, album_total: 2, done: true,
};

function stub(extra) {
  return `
window.__encodes = [];
window.__pageCalls = [];
window.__copied = null;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
// navigator.clipboard is a prototype getter, so a plain assignment is silently
// dropped and the stub never runs. defineProperty is the only way to replace it.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } },
});
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/share/encode") > -1) {
    window.__encodes.push(JSON.parse((opts && opts.body) || "{}"));
    // The SERVER's own truncation flag stays FALSE here on purpose. Hardcoding
    // it true made the "a truncated export must say so" assertion pass for a
    // reason unrelated to the client-side caps it was named after — the same
    // shape as v1.7.16, a test asserting the right sentence about the wrong
    // mechanism. Client caps are asserted from client state below.
    return window.__json({ blob: "MDRP1:ZmFrZQ", bytes: 13,
                           track_count: 2, skipped: 1, truncated: false });
  }
  if (url.indexOf("/api/smart-playlist?") > -1) {
    window.__pageCalls.push(url.replace(/^.*\\/api\\//, "/api/"));
    var m = /offset=(\\d+)/.exec(url);
    return window.__json((m && m[1] === "0") ? ${JSON.stringify(PAGE1)} : ${JSON.stringify(PAGE2)});
  }
  if (url.indexOf("/api/smart-playlists") > -1)
    return window.__json({ playlists: [${JSON.stringify(SAVED)}] });
  if (url.indexOf("/api/playlists") > -1)
    return window.__json({ playlists: [
      { offset: 0, title: "Late Night", subtitle: "2 tracks", image_key: null }
    ], total: 1 });
  if (url.indexOf("/api/playlist/art") > -1)
    return window.__json({ title: "Late Night", art_keys: [] });
  if (url.indexOf("/api/playlist") > -1) {
    return window.__json({
      title: "Late Night", subtitle: "2 tracks", image_key: null,
      tracks: [
        { index: 0, title: "Teen Age Riot", subtitle: "Sonic Youth",
          image_key: "kk1", track_no: 1 },
        { index: 1, title: "Tomorrow", subtitle: "Built to Spill",
          image_key: null, track_no: null }
      ],
      total: 2, truncated: false, can_play: true
    });
  }
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ decades: [1990], sources: [], total: 2 });
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
${extra || ""}
`;
}


// A smart playlist big enough to hit the client's album cap, and one whose
// pages fail part-way. Both are states the server's own `truncated` flag knows
// nothing about, so only the client can report them.
function stubPaging(mode) {
  return `
window.__encodes = [];
window.__pageCalls = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/share/encode") > -1) {
    window.__encodes.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ blob: "MDRP1:ZmFrZQ", bytes: 13,
                           track_count: 1, skipped: 0, truncated: false });
  }
  if (url.indexOf("/api/smart-playlist?") > -1) {
    window.__pageCalls.push(url);
    var m = /offset=(\\d+)/.exec(url);
    var off = m ? parseInt(m[1], 10) : 0;
    if ("${mode}" === "fail" && off > 0) {
      return { ok: false, status: 503,
               json: function () { return Promise.resolve({ error: "Roon went away" }); } };
    }
    // 60 albums a page, so two pages carry us past SHARE_ALBUM_MAX (100)
    // without the harness making a hundred round trips.
    return window.__json({
      id: "sp1", name: "Huge", view: ${JSON.stringify(SAVED.view)},
      tracks: [{ album_offset: off, album_title: "Album " + off, album_artist: "An Artist",
                 image_key: null, track_index: 0, track_no: 1,
                 title: "Track " + off, subtitle: "An Artist" }],
      album_offset: off, albums_expanded: 60, album_total: 900, done: false
    });
  }
  if (url.indexOf("/api/smart-playlists") > -1)
    return window.__json({ playlists: [{ id: "sp1", name: "Huge", album_total: 900,
                                         art_keys: [], view: ${JSON.stringify(SAVED.view)} }] });
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ decades: [1990], sources: [], total: 900 });
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
`;
}

const DRIVER_BIG = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  document.querySelector('[data-action="smart-playlists"]').click();
  await window.__sleep(700);
  // Skips the create tile, which leads the wall since v1.7.32.
  document.querySelector("#album-grid .album:not(#new-smart-tile)").click();
  await window.__sleep(700);
  Array.prototype.filter.call(document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Share"; })[0].click();
  await window.__sleep(1800);
  T("warnings", Array.prototype.map.call(document.querySelectorAll(".share-warn"),
      function (e) { return e.textContent; }));
  T("page_count", window.__pageCalls.length);
  T("encodes", window.__encodes.length);
`;

const OPEN_MENU = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
`;

// --- a Roon playlist -------------------------------------------------------
const DRIVER_PLAYLIST = OPEN_MENU + `
  document.querySelector('[data-action="playlists"]').click();
  await window.__sleep(600);
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(600);

  var share = Array.prototype.filter.call(
    document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Share"; })[0];
  T("share_exists", !!share);
  share.click();
  await window.__sleep(500);

  T("encodes", window.__encodes.slice());
  var sheet = document.querySelector(".lib-sheet-backdrop");
  T("sheet_open", !!sheet);
  T("sheet_summary", (document.querySelector(".share-sum") || {}).textContent || "");
  T("warnings", Array.prototype.map.call(document.querySelectorAll(".share-warn"),
      function (e) { return e.textContent; }));
  T("blob_value", (document.getElementById("share-blob") || {}).value || "");

  var copy = Array.prototype.filter.call(
    document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Copy"; })[0];
  T("copy_exists", !!copy);
  copy.click();
  await window.__sleep(300);
  T("copied", window.__copied);

  T("download_exists", Array.prototype.some.call(
    document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Download"; }));
`;

// --- a smart playlist: Share must finish the paging ------------------------
const DRIVER_SMART = OPEN_MENU + `
  document.querySelector('[data-action="smart-playlists"]').click();
  await window.__sleep(700);
  // Skips the create tile, which leads the wall since v1.7.32.
  document.querySelector("#album-grid .album:not(#new-smart-tile)").click();
  // Deliberately NOT waiting for the first page — Share is tapped while it is
  // still in flight, which is the race that used to yield an empty share.
  await window.__sleep(60);
  var share = Array.prototype.filter.call(
    document.querySelectorAll(".playlist-actions button"),
    function (b) { return b.textContent === "Share"; })[0];
  T("share_exists", !!share);
  share.click();
  await window.__sleep(1600);
  T("page_calls", window.__pageCalls.slice());
  T("encodes", window.__encodes.slice());
`;

test("sharing a playlist exports a description, not the app's state (v1.7.19)",
  { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stub(), driver: DRIVER_PLAYLIST, name: "share-playlist", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("a Roon playlist offers Share alongside Play now and Queue", () => {
    assert.equal(r.share_exists, true);
  });

  await t.test("only the shareable fields are sent", () => {
    assert.equal(r.encodes.length, 1, "one encode request per Share tap");
    const body = r.encodes[0];
    assert.equal(body.name, "Late Night");
    assert.deepEqual(body.tracks, [
      { title: "Teen Age Riot", artist: "Sonic Youth", track_no: 1 },
      { title: "Tomorrow", artist: "Built to Spill", track_no: null },
    ]);
    // image_key is app state — it means nothing on someone else's Core and has
    // no business travelling in a document handed to a stranger.
    for (const tr of body.tracks) {
      assert.ok(!("image_key" in tr), "artwork keys must not leave the app");
      assert.ok(!("index" in tr), "row positions are meaningless to a reader");
    }
  });

  await t.test("the sheet shows the blob and owns up to what was left out", () => {
    assert.equal(r.sheet_open, true);
    assert.equal(r.blob_value, "MDRP1:ZmFrZQ");
    // The stub reports 2 shared, 1 skipped, truncated — all three must show.
    assert.match(String(r.sheet_summary), /2 tracks/);
    assert.match(String(r.warnings.join(" ")), /1 entry had no title and was left out/,
      "entries that couldn't be shared must be counted, not dropped in silence");
  });

  await t.test("Copy puts the blob on the clipboard, and Download is offered", () => {
    assert.equal(r.copy_exists, true);
    assert.equal(r.copied, "MDRP1:ZmFrZQ");
    assert.equal(r.download_exists, true);
  });

  const s = harness.renderPage({
    stub: stub(), driver: DRIVER_SMART, name: "share-smart", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, s);

  const capped = harness.renderPage({
    stub: stubPaging("cap"), driver: DRIVER_BIG, name: "share-capped", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, capped);

  const failed = harness.renderPage({
    stub: stubPaging("fail"), driver: DRIVER_BIG, name: "share-failed", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, failed);

  await t.test("Share on a smart playlist expands every album first", () => {
    assert.equal(s.share_exists, true);
    // A smart playlist's tracks don't exist until each album is opened. One
    // page would have shared 1 track of 2 and looked complete.
    assert.equal(s.page_calls.length, 2, "both album pages must be read before encoding");
    assert.match(s.page_calls[1], /offset=1/, "paging must resume where it left off");
  });

  await t.test("stopping at the album cap is REPORTED, not silent (v1.7.21)", () => {
    // The server's `truncated` describes only the list it was handed, so it is
    // false here — this warning can come from nowhere but client state. Before
    // this, a 900-album smart playlist shared ~100 albums' worth of tracks and
    // the sheet said nothing at all.
    assert.ok(capped.page_count >= 2, "the crawl must have run more than one page");
    assert.equal(capped.encodes, 1);
    assert.ok(capped.warnings.some(w => /first 100 albums/.test(w)),
      `expected an album-cap warning, got: ${JSON.stringify(capped.warnings)}`);
  });

  await t.test("a page that fails mid-crawl marks the file INCOMPLETE (v1.7.21)", () => {
    // `done` is set both when the playlist ends and when a page errors. Sharing
    // on the strength of that flag alone announced a complete export of
    // whatever had loaded before Roon went away.
    assert.equal(failed.encodes, 1, "what did load is still worth offering");
    assert.ok(failed.warnings.some(w => /INCOMPLETE/.test(w)),
      `expected an incomplete warning, got: ${JSON.stringify(failed.warnings)}`);
  });

  await t.test("it shares what the paging actually produced", () => {
    assert.equal(s.encodes.length, 1);
    const body = s.encodes[0];
    assert.equal(body.name, "Nineties, unheard");
    // Both pages, in order, with the album each track came from — that album
    // is the strongest identity a text-only share can carry.
    assert.deepEqual(body.tracks, [
      { title: "Randy Described Eternity", artist: "Built to Spill",
        album: "Perfect From Now On", track_no: 1 },
      { title: "Dirty Boots", artist: "Sonic Youth",
        album: "Goo", track_no: 3 },
    ]);
  });
});
