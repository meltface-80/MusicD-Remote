"use strict";
// ---------------------------------------------------------------------------
// v1.8.59: the side menu opens OVER the mini transport bar.
//
// Reported: with something playing, the floating now-playing pill sat on top of
// the open side menu — over the drawer's lower rows and over the dimmed
// backdrop beside it.
//
// It was never the menu's z-index. `.menu-overlay` is `z-index: 95` and the
// pill is 70, but the overlay lived INSIDE `.app`, and `.app` is
// `position: fixed; z-index: 0` — a stacking context of its own. A z-index
// only ranks an element among the other members of its context, so the menu's
// 95 was measured against the top bar and <main>, while the whole `.app`
// context sat at 0 in the root, under the pill at 70. No number on the menu
// could have lifted it out; `position: fixed` makes the context by itself.
//
// The menu is the one thing allowed over the pill, and the pill still sits over
// the page behind it — both halves are asserted, because a fix that simply put
// the page over the pill would pass the first half.
//
// Asserted by hit-testing, as the Library sheets are (v1.6.58): what the user
// sees on top is what document.elementFromPoint returns, and a z-index read
// out of CSS text would pass with the stacking context still in the way.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// A zone that is genuinely playing, so app.js reveals the pill through its own
// poll loop and keeps it revealed.
const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "playing", outputs: [],
  now_playing: {
    line1: "Safe from Harm", line2: "Massive Attack", line3: "Blue Lines",
    length: 318, seek_position: 30,
  },
};

const STUB = `
var ZONE = ${JSON.stringify(ZONE)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  if (url.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  T("bar_shown", !bar.classList.contains("hidden"));

  // Who owns the point: the open menu, the pill, or something else.
  function ownerAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return "none";
    for (; el; el = el.parentElement) {
      if (el.id === "menu-overlay") return "menu";
      if (el.classList && el.classList.contains("mini-transport")) return "transport";
    }
    return "other";
  }

  var r = bar.getBoundingClientRect();
  T("bar_rect", { left: Math.round(r.left), right: Math.round(r.right),
                  top: Math.round(r.top), bottom: Math.round(r.bottom) });
  var midY = r.top + r.height / 2;
  // With the menu shut, the pill is on top of the page — the rule the menu is
  // the one exception to.
  T("closed_owner", ownerAt(r.left + r.width / 2, midY));

  // The drawer slides in with a CSS animation, and this harness never advances
  // one: measured, the drawer stays at its first frame, translateX(-100%),
  // entirely off screen. Stacking is the subject here, not the slide, so the
  // drawer is shown where the animation ends.
  var still = document.createElement("style");
  still.textContent = ".menu-drawer { animation: none !important; }";
  document.head.appendChild(still);

  document.getElementById("menu-toggle").click();
  await window.__sleep(400);
  var overlay = document.getElementById("menu-overlay");
  T("menu_open", !overlay.classList.contains("hidden"));
  var drawer = overlay.querySelector(".menu-drawer").getBoundingClientRect();
  T("drawer_right", Math.round(drawer.right));

  // Inside the pill's box: once where the DRAWER is, once where the BACKDROP is.
  var onDrawer   = r.left + 16;
  var onBackdrop = r.right - 16;
  T("drawer_side_in_bar",   onDrawer   < drawer.right);
  T("backdrop_side_in_bar", onBackdrop > drawer.right);
  T("open_owner_drawer_side",   ownerAt(onDrawer, midY));
  T("open_owner_backdrop_side", ownerAt(onBackdrop, midY));
  var hit = document.elementFromPoint(onDrawer, midY);
  T("drawer_side_is_drawer", !!(hit && hit.closest && hit.closest(".menu-drawer")));

  // A tap on the dimmed area over the pill closes the menu, as a tap on the
  // dimmed area anywhere else does — rather than pressing a transport button
  // hidden under the veil.
  var tapped = document.elementFromPoint(onBackdrop, midY);
  if (tapped) tapped.click();
  await window.__sleep(200);
  T("closed_by_tap_over_bar", overlay.classList.contains("hidden"));

  // And shut again, the pill is back on top.
  T("reclosed_owner", ownerAt(r.left + r.width / 2, midY));
`;

test("the side menu opens over the mini transport bar, and only the menu does", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({ name: "menu-over-transport", windowSize: "390x844",
                                 stub: STUB, driver: DRIVER });
  harness.assertNoPageError(assert, r);

  // Controls: without these the assertions below prove nothing.
  assert.equal(r.bar_shown, true, "the pill never appeared — nothing to be covered");
  assert.equal(r.menu_open, true, "the menu did not open");
  assert.equal(r.drawer_side_in_bar, true,
    "the drawer does not reach into the pill's box — the drawer-side probe tests nothing");
  assert.equal(r.backdrop_side_in_bar, true,
    "the backdrop does not reach into the pill's box — the backdrop-side probe tests nothing");

  assert.equal(r.closed_owner, "transport",
    "with the menu shut the pill is not on top of the page — the rule the menu is the " +
    "one exception to has been broken");
  assert.equal(r.open_owner_drawer_side, "menu",
    "the pill is painted over the open drawer (" + r.open_owner_drawer_side + ")");
  assert.equal(r.drawer_side_is_drawer, true, "the drawer is not what a press there reaches");
  assert.equal(r.open_owner_backdrop_side, "menu",
    "the pill is painted over the menu's backdrop (" + r.open_owner_backdrop_side + ")");
  assert.equal(r.closed_by_tap_over_bar, true,
    "a tap on the veil over the pill did not close the menu");
  assert.equal(r.reclosed_owner, "transport", "the pill did not come back on top");
});
