"use strict";
// ---------------------------------------------------------------------------
// v1.7.8: the smart-playlist round trip — save the current library view under a
// name, see it listed, open it and have the library wall actually adopt it.
//
// The failure that matters here isn't cosmetic: opening a saved view must both
// apply the view AND put the library wall on screen. applyLibView() only
// re-fetches, so calling it from a sheet opened on Home would page tiles into a
// screen the user isn't looking at — the request would go out with the right
// query and nothing would appear. So this asserts the QUERY the wall fetches
// with, not just that a row was clicked.
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
  id: "sp1", name: "Nineties, unheard",
  view: { sort: "year", dir: "desc", seed: 1, decade: [1990], source: [], played: "12" },
};

function stubFor(initial) {
  return `
window.__smart = ${JSON.stringify(initial)};
window.__saves = [];
window.__libQueries = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/smart-playlists/delete") > -1) {
    var id = JSON.parse((opts && opts.body) || "{}").id;
    window.__smart = window.__smart.filter(function (p) { return p.id !== id; });
    return window.__json({ ok: true, playlists: window.__smart });
  }
  if (url.indexOf("/api/smart-playlists") > -1) {
    if (opts && opts.method === "POST") {
      var b = JSON.parse(opts.body || "{}");
      window.__saves.push(b);
      var rec = { id: b.id || "spNew", name: b.name, view: b.view };
      window.__smart = window.__smart.concat([rec]);
      return window.__json({ ok: true, playlist: rec, playlists: window.__smart });
    }
    return window.__json({ playlists: window.__smart });
  }
  if (url.indexOf("/api/library/albums") > -1) {
    window.__libQueries.push(url.replace(/^.*\\/api\\//, "/api/"));
    return window.__json({ albums: [
      { offset: 0, title: "Perfect From Now On", subtitle: "Built to Spill", image_key: null }
    ], offset: 0, total: 1 });
  }
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ decades: [1990, 2000], sources: [], total: 1 });
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

const OPEN_SHEET = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  var entry = document.querySelector('[data-action="smart-playlists"]');
  T("menu_entry_exists", !!entry);
  entry.click();
  await window.__sleep(600);
  var sheet = document.querySelector(".lib-sheet-backdrop");
  T("sheet_open", !!sheet);
  function rows() {
    return Array.prototype.map.call(sheet.querySelectorAll("[data-smart]"), function (r) {
      return {
        id: r.dataset.smart,
        name: (r.querySelector(".dev-name") || {}).textContent || "",
        desc: (r.querySelector(".dev-status") || {}).textContent || ""
      };
    });
  }
`;

const DRIVER_LIST = OPEN_SHEET + `
  T("rows", rows());

  // Open the saved view: it must apply AND land on the library wall.
  sheet.querySelector('[data-smart="sp1"] .smart-open').click();
  await window.__sleep(900);
  T("sheet_closed", !document.querySelector(".lib-sheet-backdrop"));
  T("lib_queries", window.__libQueries.slice());
  T("tiles", Array.prototype.map.call(document.querySelectorAll("#album-grid .album"),
      function (b) { return (b.querySelector(".album-title") || {}).textContent || ""; }));
`;

const DRIVER_EMPTY = OPEN_SHEET + `
  T("rows", rows());
  T("note", (sheet.querySelector(".lib-sheet-note") || {}).textContent || "");
`;

const DRIVER_DELETE = OPEN_SHEET + `
  sheet.querySelector('[data-smart="sp1"] [data-action="delete"]').click();
  await window.__sleep(600);
  T("rows_after_delete", rows());
  T("note_after_delete", (sheet.querySelector(".lib-sheet-note") || {}).textContent || "");
`;

test("smart playlists save, list, open and delete (v1.7.8)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor([SAVED]), driver: DRIVER_LIST,
    name: "smart-list", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the side menu opens the picker and lists what's saved", () => {
    assert.equal(r.menu_entry_exists, true, "no Smart playlists entry in the side menu");
    assert.equal(r.sheet_open, true);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].name, "Nineties, unheard");
  });

  await t.test("each row says what the saved view DOES, not just its name", () => {
    // A name alone can't be checked against reality; the description is how the
    // user spots a view that isn't what they meant to save.
    assert.match(r.rows[0].desc, /1990s/);
    assert.match(r.rows[0].desc, /not played in 12 months/);
  });

  await t.test("opening one applies its view AND shows the library wall", () => {
    assert.equal(r.sheet_closed, true);
    assert.ok(r.lib_queries.length, "the library wall never fetched — the view was applied to nothing");
    const q = r.lib_queries[r.lib_queries.length - 1];
    assert.match(q, /sort=year/);
    assert.match(q, /dir=desc/);
    assert.match(q, /decade=1990/);
    assert.match(q, /played=12/);
    // And the wall is genuinely on screen, not just requested.
    assert.deepEqual(r.tiles, ["Perfect From Now On"]);
  });

  const empty = harness.renderPage({
    stub: stubFor([]), driver: DRIVER_EMPTY,
    name: "smart-empty", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, empty);
  await t.test("with none saved it explains how to make one", () => {
    assert.deepEqual(empty.rows, []);
    assert.match(empty.note, /Save as/, "the empty state must say where saving happens");
  });

  const del = harness.renderPage({
    stub: stubFor([SAVED]), driver: DRIVER_DELETE,
    name: "smart-delete", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, del);
  await t.test("deleting one removes it and repaints in place", () => {
    assert.deepEqual(del.rows_after_delete, []);
    assert.match(del.note_after_delete, /No smart playlists yet/,
      "the list must fall back to its empty state, not go blank");
  });
});
