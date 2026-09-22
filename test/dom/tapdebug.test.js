"use strict";
// ---------------------------------------------------------------------------
// v1.8.43: the tap instrument.
//
// It exists because "rotate to landscape and back and no button works" has
// survived two fixes, each shipped on a mechanism no assertion here could
// observe. This harness is headless Chromium — no rotation, no iOS, no visual
// viewport of its own — so it cannot watch the bug happen and this file does
// not pretend to.
//
// What it CAN pin is the two properties that decide whether the instrument is
// usable at all, and both are the kind of thing that is easy to get wrong:
//
//   1. IT IS INERT UNLESS SWITCHED ON. It ships to everyone, loads before
//      everything, and must add no listener and no element until asked.
//   2. IT CANNOT EAT A TAP. An instrument that intercepted a press would be
//      indistinguishable from the fault it is looking for — and it is a fixed,
//      full-width, top-of-the-screen element, which is exactly the shape of
//      the thing under suspicion.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: { line1: "Lump", line2: "James Holden", line3: "The Idiots Are Winning",
                 image_key: "k", length: 285, seek_position: 62 },
};

function stub(enable) {
  return `
window.__posted = [];
try { ${enable ? `localStorage.setItem("musicd-tapdebug", "1");`
                : `localStorage.removeItem("musicd-tapdebug");`} } catch (e) {}
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/debug/taps") > -1) {
    window.__posted.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true });
  }
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [{ offset: 0, title: "A", subtitle: "B", image_key: "k" }],
                           total: 1, filtered: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(900);
  var panel = document.getElementById("tapdebug");
  T("present", !!panel);
  if (panel) {
    var cs = getComputedStyle(panel);
    var b = panel.getBoundingClientRect();
    T("panel", {
      pointerEvents: cs.pointerEvents,
      position: cs.position,
      zIndex: cs.zIndex,
      top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
    });
    // What is on top at the panel's own coordinates? If the instrument were
    // tappable this would name it, and every tap in that band would be eaten
    // by the thing measuring taps.
    var mid = document.elementFromPoint(Math.round(window.innerWidth / 2),
                                        Math.max(2, Math.round(b.height / 2)));
    T("under_panel", mid ? (mid.id || mid.tagName.toLowerCase()) : null);
    T("text_has_metrics", /win \\d+x\\d+/.test(panel.textContent));
  }

  // A real press on a real control still reaches that control.
  var hits = 0;
  var menu = document.getElementById("menu-toggle");
  menu.addEventListener("click", function () { hits++; }, true);
  var r = menu.getBoundingClientRect();
  var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  T("menu_topmost", (function () {
    var el = document.elementFromPoint(x, y);
    return !!(el && (el === menu || menu.contains(el)));
  })());
  menu.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true,
                                               clientX: x, clientY: y }));
  await window.__sleep(150);
  T("menu_click_landed", hits);

  // And the recorder noticed it, without changing it.
  if (panel) T("recorded_click", /click/.test(panel.textContent));

  // The headline. In a healthy frame there is no verdict and the panel says
  // so rather than leaving a reader to decide that silence means well.
  if (panel) {
    T("standalone_stated", /standalone=(YES|no)/.test(panel.textContent));
    // indexOf, not a regex. A backslash escape inside this template literal
    // collapses before the driver ever sees it — /\*\*\*/ arrives as /***/,
    // which JS reads as the start of a block comment and takes the rest of the
    // driver with it. The whole file went red at once, which is at least an
    // honest way to find out.
    T("verdict_shown", panel.textContent.indexOf("***") > -1);
    T("bg", getComputedStyle(panel).backgroundColor);
  }

  // A rotation cannot be simulated here, but the sampler that records one can
  // be driven directly — three samples per turn, because iOS fires
  // orientationchange before the web view has finished resizing.
  window.dispatchEvent(new Event("orientationchange"));
  await window.__sleep(1400);
  if (panel) T("turn_logged", panel.textContent.indexOf("#1 +1000ms") > -1);
`;

function render(enable) {
  const r = harness.renderPage({ name: "tapdebug-" + (enable ? "on" : "off"),
                                 windowSize: "390x844", stub: stub(enable),
                                 driver: DRIVER, budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the tap instrument", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  await t.test("is not there at all until it is switched on", () => {
    const r = render(false);
    assert.equal(r.present, false,
      "tapdebug drew itself for somebody who never asked for it");
    assert.equal(r.menu_click_landed, 1, "the menu button stopped working");
  });

  await t.test("cannot eat a tap", () => {
    const r = render(true);
    assert.equal(r.present, true, "it was switched on and did not appear");
    // THE assertion in this file. It is fixed, full-width and at the top of
    // the screen — the exact shape of the thing being hunted.
    assert.equal(r.panel.pointerEvents, "none",
      "the instrument is tappable, so it would eat every press in its own band " +
      "and look exactly like the fault it exists to find");
    assert.notEqual(r.under_panel, "tapdebug",
      "the panel is hit-testable at its own coordinates: " + r.under_panel);
  });

  await t.test("does not change what a tap does", () => {
    const r = render(true);
    assert.equal(r.menu_topmost, true,
      "the instrument covers a real control at the top of the screen");
    assert.equal(r.menu_click_landed, 1,
      "a press on the menu button did not reach it with the instrument running");
    assert.equal(r.recorded_click, true, "the press was not recorded");
  });

  await t.test("says whether it is a home-screen app, and gives a verdict", () => {
    // The bug happens ONLY in a standalone home-screen app — Safari and Chrome
    // on the same phone are fine — so a reading that does not state which it
    // came from cannot be compared with another one.
    const r = render(true);
    assert.equal(r.standalone_stated, true,
      "the readout does not say whether this is a home-screen app");
    // Headless Chromium at a sane size is a healthy frame, so there must be no
    // verdict — a detector that cries wolf here would cry wolf on a phone.
    assert.equal(r.verdict_shown, false,
      "a verdict was raised on a viewport with nothing wrong with it");
    assert.match(r.bg, /^rgba?\(0, 0, 0/,
      "the panel went to its alarm colour with no fault to report: " + r.bg);
  });

  await t.test("a rotation is sampled until it settles, not once on the event", () => {
    // iOS fires orientationchange before the web view has finished resizing,
    // and a standalone app settles later than a tabbed one. One reading taken
    // on the event catches the middle of the transition and calls a viewport
    // stale when it is only mid-flight.
    const r = render(true);
    assert.equal(r.turn_logged, true,
      "the rotation was not still being sampled a second later");
  });

  await t.test("shows the viewport numbers without being asked", () => {
    // It has to be readable with no interaction: when the bug is present the
    // app cannot be tapped, so a panel you have to open is a panel nobody can
    // open.
    const r = render(true);
    assert.equal(r.text_has_metrics, true,
      "the readout does not show the viewport numbers: " + JSON.stringify(r.panel));
  });
});
