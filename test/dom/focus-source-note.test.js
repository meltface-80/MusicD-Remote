"use strict";
// ---------------------------------------------------------------------------
// v1.8.61: the Source note names the fact it rests on.
//
// When nothing streams INTO Roon, every album in the library came from the
// user's own files, and the Focus sheet says so under Source. It used to give
// one reason for that — "No streaming service is connected" — which was the
// extension's OWN sign-ins. The report that prompted v1.8.61 is the case that
// sentence gets wrong: the extension signed in to Qobuz for its own features,
// Roon signed in to nothing. Saying "no service is connected" there
// contradicts Settings, which shows Qobuz connected.
//
// The server says which fact the count rests on (`sources_derived_why`), and
// the note must follow it — both ways, or a note that always named Roon would
// pass a test written for the new case alone.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [
  { offset: 0, title: "Album A", subtitle: "Artist One", image_key: "k0" },
];

const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [],
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  now_playing: null,
};

function facets(why) {
  return {
    total: 120,
    coverage: {},
    sources_derived: true,
    sources_derived_why: why,
    hasPlays: false,
    facets: [
      { id: "source", label: "Source", total_values: 1, values: [
        { value: "local", label: "Local albums", count: 120 },
      ] },
    ],
  };
}

function stub(why) {
  return `
var ALBUMS = ${JSON.stringify(ALBUMS)};
var FACETS = ${JSON.stringify(facets(why))};
var ZONE = ${JSON.stringify(ZONE)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/library/facets") > -1) return window.__json(FACETS);
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ALBUMS, offset: 0, total: ALBUMS.length });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ALBUMS, total: ALBUMS.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(400);
  document.getElementById("home-library-title").click();
  await window.__sleep(400);
  document.querySelector(".library-controls .lib-ctl-focus").click();
  await window.__sleep(500);
  // Looked up afresh after the tap: expanding re-renders the sheet, so the
  // header found before it belongs to a section that is no longer on screen.
  function sourceHead() {
    return Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-section-head"),
      function (h) {
        var el = h.querySelector(".lib-sheet-section-label");
        return el && el.textContent === "Source";
      })[0];
  }
  var head = sourceHead();
  T("source_found", !!head);
  if (head && head.getAttribute("aria-expanded") === "false") head.click();
  await window.__sleep(150);
  head = sourceHead();
  T("source_notes", head ? Array.prototype.map.call(
    head.parentElement.querySelectorAll(".lib-facet-note"),
    function (n) { return n.textContent; }) : null);
`;

test("Focus: the Source note says whose services it counted (v1.8.61)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    await t.test("Roon signed in to nothing: the note names ROON", () => {
      const r = harness.renderPage({
        stub: stub("roon"), driver: DRIVER, name: "focus-source-note-roon", windowSize: "390x844",
      });
      harness.assertNoPageError(assert, r);
      assert.equal(r.source_found, true);
      assert.deepEqual(r.source_notes, [
        "Roon isn't signed in to any streaming service, so every album in your " +
        "Roon library came from your own files.",
      ], "with Qobuz connected in Settings, \"no streaming service is connected\" " +
         "contradicts the screen the user just left");
    });

    await t.test("Roon's services not yet read: the note names the extension's", () => {
      const r = harness.renderPage({
        stub: stub("extension"), driver: DRIVER, name: "focus-source-note-ext", windowSize: "390x844",
      });
      harness.assertNoPageError(assert, r);
      assert.equal(r.source_found, true);
      assert.deepEqual(r.source_notes, [
        "No streaming service is connected, so every album in your Roon library " +
        "came from your own files.",
      ]);
    });
  });
