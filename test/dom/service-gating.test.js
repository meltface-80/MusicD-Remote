"use strict";
// ---------------------------------------------------------------------------
// v1.7.20: a disconnected streaming service must leave no way in.
//
// Qobuz was gated on ONE thing — the Disconnect button in Settings. The top-bar
// button and the side-menu entry were never touched, and loadQobuzStatus() was
// never called at boot, so after logging out of Qobuz the browser stayed one
// tap away from an account that no longer existed and every catalogue call
// behind it threw "Qobuz not connected".
//
// Tidal had the gating from the start (it was built second). This test holds
// BOTH services to the same rule, in both directions, so the next service
// cannot be added with half the wiring either.
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

function stub(qobuzConnected, tidalConnected) {
  return `
window.__installFetch(function (url) {
  if (url.indexOf("/api/settings/qobuz") > -1)
    return window.__json({ connected: ${qobuzConnected}, displayName: "Someone" });
  if (url.indexOf("/api/settings/tidal") > -1)
    return window.__json({ connected: ${tidalConnected}, displayName: "Someone" });
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

// Read the gating WITHOUT opening Settings — that is the whole point. A user who
// logs out and never reopens Settings must still see the entries disappear.
const DRIVER = `
  await window.__sleep(700);
  function shown(id) {
    var el = document.getElementById(id);
    return el ? !el.classList.contains("hidden") : null;
  }
  T("qobuz_topbar", shown("qobuz-toggle"));
  T("qobuz_menu",   shown("menu-item-qobuz"));
  T("tidal_topbar", shown("tidal-toggle"));
  T("tidal_menu",   shown("menu-item-tidal"));

  // And the entry must not merely be invisible — it must be absent from the
  // menu a user actually reads.
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  T("visible_menu_labels", Array.prototype.filter.call(
    document.querySelectorAll(".menu-drawer .menu-item"),
    function (b) { return !b.classList.contains("hidden"); })
    .map(function (b) { return (b.querySelector("span") || {}).textContent || ""; }));
`;

test("a disconnected service disappears everywhere (v1.7.20)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const off = harness.renderPage({
    stub: stub(false, false), driver: DRIVER, name: "service-gating-off", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, off);

  await t.test("logged out of both: no top-bar buttons", () => {
    assert.equal(off.qobuz_topbar, false,
      "the Qobuz top-bar button must go when the account does");
    assert.equal(off.tidal_topbar, false);
  });

  await t.test("logged out of both: no side-menu entries", () => {
    assert.equal(off.qobuz_menu, false,
      "this is the reported bug — Qobuz stayed in the side menu after logout");
    assert.equal(off.tidal_menu, false);
    assert.ok(!off.visible_menu_labels.includes("Qobuz"),
      "Qobuz must not be listed in the drawer at all");
    assert.ok(!off.visible_menu_labels.includes("Tidal"));
  });

  await t.test("the gating happens at boot, not on opening Settings", () => {
    // The driver never opens Settings. If the toggle only ran from the Settings
    // loader, everything above would still be visible here.
    assert.ok(off.visible_menu_labels.includes("Home"),
      "sanity: the drawer rendered, so the assertions above mean something");
  });

  const on = harness.renderPage({
    stub: stub(true, true), driver: DRIVER, name: "service-gating-on", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, on);

  await t.test("connected: both services are reachable again", () => {
    // The other direction matters just as much — hiding them permanently would
    // be a worse bug than showing them permanently.
    assert.equal(on.qobuz_topbar, true);
    assert.equal(on.qobuz_menu, true);
    assert.equal(on.tidal_topbar, true);
    assert.equal(on.tidal_menu, true);
    assert.ok(on.visible_menu_labels.includes("Qobuz"));
    assert.ok(on.visible_menu_labels.includes("Tidal"));
  });

  const mixed = harness.renderPage({
    stub: stub(true, false), driver: DRIVER, name: "service-gating-mixed", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, mixed);

  await t.test("each service is gated on its OWN connection", () => {
    assert.equal(mixed.qobuz_menu, true);
    assert.equal(mixed.tidal_menu, false,
      "one service's state must not decide another's");
  });
});
