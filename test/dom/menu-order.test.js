"use strict";
// ---------------------------------------------------------------------------
// v1.8.69: the side menu in Mandarin's order.
//
// Asked for: "Side menu to remain untouched other than place things in a
// similar order to that of Mandarin's side menu."
//
// Mandarin's drawer runs Home, Listen later, Random albums | Labels, Qobuz,
// Tidal, Pitchfork, Discover, Smart Picks, Dynamic Playlists, Playlists, Import
// a playlist | Rescan library | Settings. This app's differed in one place:
// Listen later sat after Discover. The Wall display row (v1.8.66) has no
// counterpart in Mandarin and keeps its place at the end of the first group.
// The rows themselves are moved, not edited, so their own tests still hold.
//
// v1.8.74: HQPlayer joins the end of the first group, after Wall display —
// where the user asked for it ("accessed from the side menu"). Like Wall
// display it is hidden until switched on; this stub switches it on so its
// place is pinned too.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const STUB = `
window.__installFetch(function (u) {
  if (u.indexOf("/api/hqp/settings") > -1) return window.__json({ enabled: true });
  if (u.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)       return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(600);
  document.getElementById("menu-toggle").click();
  await window.__sleep(300);
  var list = document.querySelector("#menu-overlay .menu-list");
  T("order", Array.prototype.map.call(list.children, function (el) {
    if (el.classList.contains("menu-sep")) return "|";
    return el.getAttribute("data-action") || el.getAttribute("data-target") || el.tagName;
  }));
  T("labels", Array.prototype.map.call(list.querySelectorAll(".menu-item"), function (b) {
    var lines = b.querySelector(".menu-item-lines > span");
    return (lines || b.querySelector("span")).textContent.trim();
  }));
`;

test("the side menu runs in Mandarin's order (v1.8.69)", async (t) => {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER, name: "menu-order", windowSize: "390x844" });
  harness.assertNoPageError(assert, r);

  await t.test("THE one: Home, Listen later, Random albums first, as in Mandarin", () => {
    assert.deepEqual(r.order.slice(0, 3), ["home", "listen-later", "shuffle"],
      "the drawer opens " + r.order.slice(0, 3).join(", ") + " — Mandarin's opens Home, Listen later, Random albums");
  });

  await t.test("the whole drawer, groups and all", () => {
    assert.deepEqual(r.order, [
      "home", "listen-later", "shuffle", "wall-display", "hqplayer", "|",
      "labels-toggle", "qobuz-toggle", "tidal-toggle", "pitchfork-toggle", "discover",
      "smart-picks", "smart-playlists", "playlists", "import-playlist", "|",
      "rescan-library", "|",
      "settings-toggle",
    ]);
  });

  await t.test("every row is still there, under its own name", () => {
    assert.deepEqual(r.labels, [
      "Home", "Listen later", "Random albums", "Wall display", "HQPlayer",
      "Labels", "Qobuz", "Tidal", "Pitchfork", "Discover",
      "Smart Picks", "Dynamic Playlists", "Playlists", "Import a playlist",
      "Rescan library", "Settings",
    ]);
  });
});
