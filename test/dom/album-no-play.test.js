"use strict";
// ---------------------------------------------------------------------------
// v1.7.58: the red line users actually reported.
//
// It reads "Roon offered no playback options for this album." and sits under
// the album title in the album view. It is NOT the server's noActionError —
// that one is a toast on the play path. This sentence is composed in the
// CLIENT, from /api/album's empty action list, and it had no
// explanation of any kind attached.
//
// So the v1.7.57 pass that added "why / what next / how to fix it" to every
// message on this path went straight past the one people were looking at. The
// lesson is narrow and worth keeping: a message the server also knows how to
// build is not proof the server is what built the one on screen.
//
// The two branches wait on different clocks, and the test pins that too. When
// library_moved is set, the server has already armed the recheck chain — five
// minutes. When it is not, the next look is the background watch — ten.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUM = { offset: 0, title: "Red - Early Recordings",
                subtitle: "Three Lower Colours", image_key: "k0" };

function stubFor(detail) {
  return `
window.__installFetch(function (url) {
  // The route is /api/album?offset=..., NOT /api/album-detail — matching the
  // wrong path made both cases fall through to an empty object, so the test
  // passed against a response the server never sends.
  if (url.indexOf("/api/album?") > -1) return window.__json(${JSON.stringify(detail)});
  if (url.indexOf("/api/album-extras") > -1 || url.indexOf("/api/album/") > -1)
    return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [${JSON.stringify(ALBUM)}], total: 1, filtered: false });
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
}

const DRIVER = `
  await window.__sleep(400);
  window.__openAlbum(${JSON.stringify(ALBUM)});
  await window.__sleep(500);
  var e = document.querySelector(".modal-error");
  T("shown", !!e);
  T("text", e ? e.textContent : "");
`;

function errText(detail, name) {
  const r = harness.renderPage({
    stub: stubFor(detail), driver: DRIVER, name, windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.shown, true, "the album view showed no error line at all");
  return r.text;
}

const NO_ACTIONS = { actions: [], tracks: [{ title: "Red - Early Recordings",
                                             subtitle: "Three Lower Colours" }] };

test("the album view's no-playback line explains itself", { concurrency: 1 }, async (t) => {
  await t.test("THE one: the unproven branch is no longer a bare sentence", () => {
    // Exactly what was on screen: one red line, no cause, no next step, no way
    // out. It is also the branch the server cannot reach, which is why it
    // survived the pass that fixed the others.
    const txt = errText(Object.assign({ library_moved: false }, NO_ACTIONS), "album-noplay-plain");
    assert.match(txt, /no playback options/, "the symptom itself is gone: " + JSON.stringify(txt));
    assert.match(txt, /added or identified/, "it still does not say WHY");
    assert.match(txt, /Rescan library/,
      "it still leaves the user with nothing to do when the automatic check " +
      "does not clear it");
  });

  await t.test("each branch quotes the clock it is actually waiting on", () => {
    // Not cosmetic. A proven change has a recheck armed at 5 minutes; an
    // unproven one waits for the 10-minute background watch. One number for
    // both is wrong in one of the two cases.
    const moved = errText(Object.assign({ library_moved: true }, NO_ACTIONS), "album-noplay-moved");
    assert.match(moved, /already scheduled/,
      "a proven change does not say a check is already on its way: " + JSON.stringify(moved));
    assert.match(moved, /about 5 minutes/,
      "a proven change quotes the wrong wait — the recheck chain runs at 5 minutes");

    const plain = errText(Object.assign({ library_moved: false }, NO_ACTIONS), "album-noplay-watch");
    assert.match(plain, /every 10 minutes/,
      "an unproven cause quotes the wrong wait — nothing was armed, so the next " +
      "look is the 10-minute watch");
    assert.ok(!/about 5 minutes/.test(plain),
      "an unproven cause promises a 5-minute recheck that was never scheduled");
  });

  await t.test("a proven change is stated, an unproven one is hedged", () => {
    const moved = errText(Object.assign({ library_moved: true }, NO_ACTIONS), "album-noplay-sure");
    assert.ok(!/usually means/.test(moved), "a proven library change is hedged as a guess");
    const plain = errText(Object.assign({ library_moved: false }, NO_ACTIONS), "album-noplay-hedge");
    assert.match(plain, /usually means/, "a guess is stated as established fact");
  });
});
