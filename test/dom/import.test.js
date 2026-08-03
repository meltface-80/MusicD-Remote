"use strict";
// ---------------------------------------------------------------------------
// v1.7.23: the import side of playlist sharing.
//
// The encoder, decoder and resolver are unit-tested. What only shows up here is
// whether the user is told the truth about what they just imported:
//
//   1. The report leads with "N of M found", not with a success message.
//   2. Entries this library couldn't match are LISTED, not just counted. Every
//      tool in this space quietly substitutes the wrong version; showing the
//      misses is what makes it trustworthy.
//   3. Saving is a separate, named act — an import that resolved nothing must
//      not offer to save nothing.
//   4. A blob that isn't ours produces the server's refusal, in place, rather
//      than a generic failure.
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

const RESOLVED = [
  { album_offset: 10, album_title: "Perfect From Now On", album_subtitle: "Built to Spill",
    track_index: 0, title: "Randy Described Eternity", subtitle: "Built to Spill",
    image_key: "a10", track_no: 1 },
  { album_offset: 20, album_title: "Goo", album_subtitle: "Sonic Youth",
    track_index: 0, title: "Dirty Boots", subtitle: "Sonic Youth",
    image_key: "a20", track_no: 3 },
];

function stub(mode) {
  return `
window.__imports = [];
window.__adds = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.prompt = function () { return "Imported mix"; };
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/share/import") > -1) {
    window.__imports.push(JSON.parse((opts && opts.body) || "{}"));
    if ("${mode}" === "bad") {
      return { ok: false, status: 400, json: function () {
        return Promise.resolve({ error: "That doesn't look like a MusicD Remote playlist" }); } };
    }
    if ("${mode}" === "none") {
      return window.__json({ ok: true, name: "Nothing", total: 2, truncated: false,
        resolved: [], missing: [
          { title: "A", artist: "B", album: "C" },
          { title: "D", artist: "E", album: "F" }] });
    }
    return window.__json({ ok: true, name: "Shared mix", total: 3, truncated: false,
      resolved: ${JSON.stringify(RESOLVED)},
      missing: [{ title: "Unknown Song", artist: "Nobody", album: "Not Here" }] });
  }
  if (url.indexOf("/api/user-playlists/add") > -1) {
    window.__adds.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true, id: "up_1", name: "Imported mix",
                           added: 2, skipped: 0, full: false, track_total: 2 });
  }
  if (url.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
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

const OPEN = `
  await window.__sleep(500);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  var entry = document.querySelector('[data-action="import-playlist"]');
  T("menu_entry", !!entry);
  entry.click();
  await window.__sleep(400);
  T("sheet_open", !!document.querySelector(".lib-sheet-backdrop"));
  document.getElementById("import-blob").value = "MDRP1:ZmFrZQ";
  Array.prototype.filter.call(document.querySelectorAll(".lib-sheet-foot button"),
    function (b) { return b.textContent === "Import"; })[0].click();
  await window.__sleep(500);
  function warns() {
    return Array.prototype.map.call(document.querySelectorAll("#import-result .share-warn"),
      function (e) { return e.textContent; });
  }
`;

const DRIVER_OK = OPEN + `
  T("posted", window.__imports.slice());
  T("summary", (document.querySelector("#import-result .share-sum") || {}).textContent || "");
  T("warnings", warns());
  T("missing_rows", Array.prototype.map.call(
      document.querySelectorAll("#import-result .import-missing li"),
      function (e) { return e.textContent; }));
  var save = document.querySelector(".import-save");
  T("save_label", save ? save.textContent : null);
  save.click();
  await window.__sleep(500);
  T("adds", window.__adds.slice());
  T("save_after", (document.querySelector(".import-save") || {}).textContent || "");
`;

const DRIVER_NONE = OPEN + `
  T("summary", (document.querySelector("#import-result .share-sum") || {}).textContent || "");
  T("warnings", warns());
  T("save_present", !!document.querySelector(".import-save"));
`;

const DRIVER_BAD = OPEN + `
  T("result_text", (document.getElementById("import-result") || {}).textContent || "");
  T("save_present", !!document.querySelector(".import-save"));
`;

test("importing a shared playlist reports what it could and couldn't match (v1.7.23)",
  { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    stub: stub("ok"), driver: DRIVER_OK, name: "import-ok", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the side menu opens an import sheet and posts the blob", () => {
    assert.equal(r.menu_entry, true, "there must be a way in — this was the reported gap");
    assert.equal(r.sheet_open, true);
    assert.equal(r.posted.length, 1);
    assert.equal(r.posted[0].blob, "MDRP1:ZmFrZQ");
  });

  await t.test("the report leads with how many of how many", () => {
    assert.match(String(r.summary), /2 of 3 tracks found in your library/);
  });

  await t.test("unmatched entries are listed, not merely counted", () => {
    assert.ok(r.warnings.some(w => /1 couldn't be matched/.test(w)),
      `expected a miss count, got ${JSON.stringify(r.warnings)}`);
    assert.deepEqual(r.missing_rows, ["Unknown Song · Nobody · Not Here"],
      "the user has to see WHICH track is missing to do anything about it");
  });

  await t.test("saving is a separate, named act and sends the resolved tracks", () => {
    assert.match(String(r.save_label), /Save 2 tracks as a playlist/);
    assert.equal(r.adds.length, 1);
    assert.equal(r.adds[0].name, "Imported mix");
    assert.equal(r.adds[0].tracks.length, 2);
    // Storable identity, not the shared entry: offset is the hint, titles the check.
    assert.equal(r.adds[0].tracks[0].album_title, "Perfect From Now On");
    assert.equal(r.adds[0].tracks[0].album_offset, 10);
    assert.equal(r.adds[0].tracks[0].title, "Randy Described Eternity");
    assert.equal(r.save_after, "Saved", "a saved import must not invite a second save");
  });

  const none = harness.renderPage({
    stub: stub("none"), driver: DRIVER_NONE, name: "import-none", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, none);

  await t.test("an import that matched nothing does not offer to save nothing", () => {
    assert.match(String(none.summary), /0 of 2 tracks/);
    assert.ok(none.warnings.some(w => /Nothing here matched/.test(w)));
    assert.equal(none.save_present, false);
  });

  const bad = harness.renderPage({
    stub: stub("bad"), driver: DRIVER_BAD, name: "import-bad", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, bad);

  await t.test("a blob that isn't ours shows the server's own refusal", () => {
    assert.match(String(bad.result_text), /doesn't look like a MusicD Remote playlist/,
      "a generic failure would leave the user guessing what they pasted");
    assert.equal(bad.save_present, false);
  });
});
