"use strict";
// ---------------------------------------------------------------------------
// v1.7.26 regression: selecting a track in the album view produced ticks and no
// way to act on them.
//
// The multi-select actions menu lives in the top bar. The album view is a
// full-viewport modal (#album-modal, z-index 50) painted OVER the whole app
// shell (z-index 0, with the top bar at 20 INSIDE it), so while an album is
// open the menu was both invisible and untappable. Every piece of logic was
// working — the count was right, the handlers were bound — and the feature was
// still unusable. That is a stacking failure, and a logic assertion cannot see
// it.
//
// So this test asserts the BEHAVIOUR, the way library-sheet.test.js does for
// the sort sheet: with a track selected, document.elementFromPoint at the
// menu button's centre must land ON the button. A control assertion proves the
// detector works — the same probe against the top bar's own position must fail,
// otherwise "it's hit-testable" would be true of anything.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "stopped",
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: { one_line: { line1: "Something" }, length: 200, seek_position: 10 },
};

const ALBUM = { offset: 0, title: "000 CHANNEL BLACK", subtitle: "_BY.ALEXANDER", image_key: null };
const DETAIL = {
  title: "000 CHANNEL BLACK", subtitle: "_BY.ALEXANDER", image_key: null,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [
    { title: "Le Merveilleux Résumé", subtitle: "Alex da Kid" },
    { title: "Trumpets", subtitle: "Alex da Kid, 070 Shake" },
    { title: "The Absence", subtitle: "Alex da Kid" },
  ],
};

const STUB = `
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/play-track") > -1) {
    window.__posts.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true, action: "Queue", track: "x" });
  }
  if (url.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (url.indexOf("/api/album") > -1)      return window.__json(${JSON.stringify(DETAIL)});
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
window.__longPress = async function (el) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await window.__sleep(700);
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await window.__sleep(80);
};
// Does a click at the centre of this element actually reach it?
window.__hits = function (el) {
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return "zero-size";
  var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return "nothing";
  return el.contains(hit) || hit === el ? "self" : (hit.className || hit.tagName);
};
`;

const DRIVER = `
  await window.__sleep(600);
  window.__openAlbum(${JSON.stringify(ALBUM)}, { source: "search" });
  await window.__sleep(700);
  function rows() { return document.querySelectorAll("#modal-tracks .t-row"); }

  await window.__longPress(rows()[1]);
  rows()[0].querySelector(".t-mark").click();
  await window.__sleep(150);

  var wrap = document.getElementById("select-menu-wrap");
  var btn  = document.getElementById("select-menu-btn");
  T("wrap_shown", !wrap.classList.contains("hidden"));
  T("wrap_inside_modal", !!wrap.closest("#album-modal"));
  T("btn_rect", (function () { var r = btn.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               top: Math.round(r.top), right: Math.round(r.right) }; })());
  T("btn_hit", window.__hits(btn));

  // Control: the app's own top bar is underneath the modal, so a probe there
  // must NOT reach it. If this said "self" the detector would be worthless.
  T("topbar_hit", window.__hits(document.getElementById("menu-toggle")));

  // Open it and act.
  btn.click();
  await window.__sleep(150);
  T("menu_open", !document.getElementById("select-menu").classList.contains("hidden"));
  T("menu_hit", window.__hits(document.getElementById("select-menu")));
  T("items", Array.prototype.filter.call(
      document.querySelectorAll("#select-menu .sel-menu-item"),
      function (b) { return !b.classList.contains("hidden"); })
    .map(function (b) { return b.textContent; }));

  document.querySelector('[data-sel-act="queue"]').click();
  await window.__sleep(500);
  T("posts", window.__posts.slice());

  // Closing the album must hand the menu back to the top bar, or it would be
  // stranded inside a hidden modal for the rest of the session.
  document.querySelector("#album-modal [data-close]").click();
  await window.__sleep(300);
  T("wrap_back_in_topbar", !!wrap.closest(".topbar-row"));
  T("wrap_hidden_after", wrap.classList.contains("hidden"));
`;

test("the select menu is reachable inside the album view (v1.7.26)",
  { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "album-select-menu", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("control: the app's top bar really is buried by the modal", () => {
    assert.notEqual(r.topbar_hit, "self",
      "if the top bar were reachable under the modal, this whole test would prove nothing");
  });

  await t.test("selecting a track puts the menu INSIDE the album view", () => {
    assert.equal(r.wrap_shown, true, "a selection must produce a way to act on it");
    assert.equal(r.wrap_inside_modal, true,
      "left in the top bar it is painted over by the modal and cannot be tapped");
  });

  await t.test("and it is genuinely hit-testable, not merely present", () => {
    assert.ok(r.btn_rect.w > 0 && r.btn_rect.h > 0, "the button has no size");
    assert.equal(r.btn_hit, "self",
      `a tap at the button's centre landed on ${r.btn_hit} instead`);
    assert.ok(r.btn_rect.top >= 0 && r.btn_rect.top < 120,
      "it should sit in the album view's header band, not off-screen");
  });

  await t.test("the menu opens over the album and offers the track actions", () => {
    assert.equal(r.menu_open, true);
    assert.equal(r.menu_hit, "self", "the open menu is covered by something");
    assert.deepEqual(r.items,
      ["Play now", "Add to end of queue", "Add to playlist…", "Clear selection"]);
  });

  await t.test("acting on the selection reaches Roon", () => {
    assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0].kind, "queue");
    assert.equal(r.posts[0].track, 0);
    assert.equal(r.posts[0].album_title, "000 CHANNEL BLACK");
  });

  await t.test("closing the album returns the menu to the top bar", () => {
    assert.equal(r.wrap_back_in_topbar, true,
      "stranded inside a hidden modal it would never be seen again this session");
    assert.equal(r.wrap_hidden_after, true, "with nothing selected it must not show");
  });
});
