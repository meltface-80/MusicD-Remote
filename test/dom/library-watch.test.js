"use strict";
// ---------------------------------------------------------------------------
// v1.8.68: the album view heals itself when the library watch re-reads Roon.
//
// Asked for: "following new album(s) added to the Roon library the extension
// rescans to prevent the error note that's set on an album because it's
// moved. It needs to be as close to a live reflection of Roon as possible."
//
// The server half (the watch: when it looks, when it re-reads, what that costs)
// is driven in test/unit/librarychange.test.js. This is the half on screen. An
// album view showing "your Roon library changed after this list was built", or
// an error from an album that moved, used to stay that way until someone closed
// it and opened the album again — which the note had to tell them to do. Now,
// when the watch publishes a new snapshot, the view asks for the album again
// and the server finds it in the fresh one.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUM = { offset: 4, title: "Red - Early Recordings", subtitle: "Three Lower Colours", image_key: "k4" };
const TRACKS = [{ title: "Red", subtitle: "Three Lower Colours" }];
const GOOD = { actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
               tracks: TRACKS, offset: 9 };

const stub = (first) => `
window.__albumAsks = 0;
window.__album = ${JSON.stringify(first)};
window.__rev = { snapshot: "1", library: "1.0", dates: "1", plays: "1", settings: "1",
                 labels: "1", picks: "1", discover: "1", day: "1" };
window.__installFetch(function (url) {
  if (url.indexOf("/api/live") > -1) return window.__json({ rev: JSON.parse(JSON.stringify(window.__rev)) });
  if (url.indexOf("/api/album?") > -1) {
    window.__albumAsks++;
    // What the server knew when the request ARRIVED — answered __albumDelay ms later.
    var a = window.__album;
    var answer = function () {
      return a.__status ? window.__json({ error: a.error }, a.__status) : window.__json(a);
    };
    var d = window.__albumDelay || 0;
    if (!d) return answer();
    return new Promise(function (r) { setTimeout(function () { r(answer()); }, d); });
  }
  if (url.indexOf("/api/album") > -1)      return window.__json({});
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  return undefined;
});
`;

const DRIVER = (after) => `
  await window.__sleep(800);
  window.__openAlbum(${JSON.stringify(ALBUM)});
  await window.__sleep(600);
  function view() {
    var err = document.querySelector("#modal-actions .modal-error");
    return { note: err ? err.textContent : "",
             play: !!Array.prototype.find.call(document.querySelectorAll("#modal-actions .action-btn"),
                                                function (b) { return /Play Now/.test(b.textContent); }) };
  }
  T("before", view());
  T("asks_before", window.__albumAsks);
  window.__album = ${JSON.stringify(after)};
  // The watch re-read Roon and published: the snapshot revision moves.
  window.__rev.snapshot = "2"; window.__rev.library = "2.0";
  await window.__sleep(5000);
  T("after", view());
  T("asks_after", window.__albumAsks);
`;

function run(name, first, after) {
  const r = harness.renderPage({ name, windowSize: "390x844", stub: stub(first), driver: DRIVER(after),
                                 budgetMs: 30000 });
  harness.assertNoPageError(assert, r);
  return r;
}

test("an album view showing that the library moved heals itself (v1.8.68)", async (t) => {
  await t.test("THE one: the 'library changed' note clears when the library is re-read", () => {
    const r = run("watch-heal-note", Object.assign({ library_moved: true }, { actions: [], tracks: TRACKS }), GOOD);
    assert.match(r.before.note, /library changed after this list was built/,
      "precondition: the note was never shown, so this measures nothing");
    assert.equal(r.before.play, false);
    assert.equal(r.asks_before, 1,
      "the note asked for the album again with nothing changed — " + r.asks_before +
      " requests before the library moved: a request loop against the server");
    assert.equal(r.asks_after, r.asks_before + 1,
      "the album was not asked for again when the library was re-read — the note stays until " +
      "somebody closes the album and opens it again");
    assert.equal(r.after.note, "", "the note is still there: " + r.after.note);
    assert.equal(r.after.play, true, "the album came back without its Play button");
  });

  await t.test("so does an album that failed to open because it moved", () => {
    const r = run("watch-heal-error",
      { __status: 409, error: "The library just changed and this album moved — close and reopen it." }, GOOD);
    assert.match(r.before.note, /moved/, "precondition: no error was shown");
    assert.equal(r.asks_before, 1, "the error re-fetched the album in a loop: " + r.asks_before);
    assert.equal(r.after.note, "", "the error is still on screen after the re-read: " + r.after.note);
    assert.equal(r.after.play, true);
  });

  await t.test("an album with nothing wrong is not asked for again", () => {
    const r = run("watch-heal-none", GOOD, GOOD);
    assert.equal(r.before.note, "");
    assert.equal(r.asks_after, r.asks_before,
      "a healthy album view re-fetched itself on every library re-read — a Core round trip per " +
      "open album for nothing");
  });
});

test("a re-read that lands while the album's answer is on its way still heals it", async (t) => {
  // The answer was composed before the library was re-read, so it carries the
  // note. The revision moved while it travelled — when nothing was flagged for
  // healing yet — so the one signal there was to act on had already gone by.
  const NOTE = Object.assign({ library_moved: true }, { actions: [], tracks: TRACKS });
  const driver = `
    await window.__sleep(800);
    window.__albumDelay = 6000;
    window.__openAlbum(${JSON.stringify(ALBUM)});
    await window.__sleep(500);
    window.__rev.snapshot = "2"; window.__rev.library = "2.0";   // re-read, mid-flight
    window.__album = ${JSON.stringify(GOOD)};                    // what the server says now
    window.__albumDelay = 0;
    await window.__sleep(4000);
    T("asks_mid", window.__albumAsks);
    await window.__sleep(9000);
    var err = document.querySelector("#modal-actions .modal-error");
    T("note", err ? err.textContent : "");
    T("asks", window.__albumAsks);
  `;
  const r = harness.renderPage({ name: "watch-heal-race", windowSize: "390x844", stub: stub(NOTE),
                                 driver, budgetMs: 30000 });
  harness.assertNoPageError(assert, r);

  await t.test("THE one: the note does not outlive a re-read it raced", () => {
    assert.equal(r.asks_mid, 1, "precondition: the first answer was still on its way when the revision moved");
    assert.equal(r.asks, 2, "the album was never asked for again — the note stays until the NEXT library change");
    assert.equal(r.note, "", "the note is still on screen: " + r.note);
  });
});

test("the side menu says when the library was last CHECKED, not last changed", async (t) => {
  const now = Date.now();
  const status = (extra) => `
window.__installFetch(function (url) {
  if (url.indexOf("/api/status") > -1)
    return window.__json(Object.assign({ paired: true, index_count: 12963,
                                         index_built_at: ${now} - 3 * 24 * 3600 * 1000 }, ${JSON.stringify(extra)}));
  if (url.indexOf("/api/zones") > -1) return window.__json({ zones: [] });
  if (url.indexOf("/api/home/") > -1) return window.__json({ albums: [], label: null });
  return undefined;
});`;
  const driver = `
    await window.__sleep(800);
    document.getElementById("menu-toggle").click();
    await window.__sleep(400);
    T("line", document.getElementById("rescan-sub").textContent);`;
  const looked = harness.renderPage({ name: "watch-sub-looked", windowSize: "390x844",
    stub: status({ library_checked_at: now - 30 * 1000 }), driver });
  harness.assertNoPageError(assert, looked);
  const old = harness.renderPage({ name: "watch-sub-old", windowSize: "390x844", stub: status({}), driver });
  harness.assertNoPageError(assert, old);

  await t.test("a library confirmed seconds ago says so, however old the snapshot is", () => {
    assert.match(looked.line, /12,963 albums · checked just now/,
      "the line still quotes when the snapshot last changed: " + looked.line);
  });
  await t.test("an older server without the field still gets a line", () => {
    assert.match(old.line, /checked 3 days ago/);
  });
});
