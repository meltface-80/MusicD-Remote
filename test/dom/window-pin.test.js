"use strict";
// ---------------------------------------------------------------------------
// v1.8.45: the iOS home-screen-app freeze, and what it actually was.
//
// Two versions shipped a theory about this and both were wrong. The
// instrument added in v1.8.43/44 settled it from a phone with dead buttons:
//
//     win 440x894   doc 440x894          the layout viewport is NOT stale
//     vv  440x894 scale=1                the page is NOT scaled
//     vv off=0,62   page=0,62
//     scrollXY 0,62                <---- THE WINDOW IS SCROLLED 62px
//     every tap: top=img#modal-img
//
// The buttons were never dead. The window had scrolled 62px — this device's
// top safe-area inset — so hit-testing ran 62px below the paint. A press on
// Back at (35, 31) was tested at (35, 93) and landed on the album artwork.
// Every control on every screen goes at once, which is why it reads as
// "nothing works" rather than as a misplaced tap. Only a standalone app has
// live safe-area insets, which is why Safari and Chrome were fine.
//
// WHAT THIS FILE CAN TEST. Not the freeze — headless Chromium has no rotation,
// no iOS and no safe areas, and CLAUDE.md is explicit that no assertion here
// can observe that. What it can test is the RULE the fix enforces: the window
// is pinned at zero, and the one place where pinning it would be wrong is left
// alone. The scroll itself is provoked directly rather than by rotating, since
// a rotation is the thing that cannot be simulated.
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

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
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

// The window cannot actually be scrolled here — html/body are overflow:hidden,
// which is the very invariant being enforced — so the OFFSET is faked and what
// is measured is whether the app tries to put it back. Faking the reading is
// the only way to ask the question at all, and it is the same reading the
// phone produced.
const DRIVER = `
  await window.__sleep(900);
  var calls = [];
  var realScrollTo = window.scrollTo.bind(window);
  window.scrollTo = function (x, y) { calls.push([x, y]); };
  function fakeScroll(y) {
    try {
      Object.defineProperty(window, "scrollY", { configurable: true, get: function () { return y; } });
      Object.defineProperty(window, "scrollX", { configurable: true, get: function () { return 0; } });
    } catch (e) { T("CANNOT_FAKE", String(e)); }
  }

  // 1. The reading the phone gave: scrolled by the top inset.
  fakeScroll(62);
  window.dispatchEvent(new Event("scroll"));
  T("after_scroll_event", calls.slice());

  // 2. A rotation settles late, so the pin must not be a single check on the
  //    event — the offset appears after it.
  calls.length = 0;
  fakeScroll(0);
  window.dispatchEvent(new Event("orientationchange"));
  fakeScroll(62);                       // the offset arrives DURING the settle
  await window.__sleep(1400);
  T("after_rotation", calls.slice());

  // 3. A focused text field is the one case where iOS scrolls on purpose:
  //    it lifts the input clear of the keyboard, and fighting it would park
  //    the field under the keys.
  calls.length = 0;
  var input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);
  input.focus();
  T("focused", document.activeElement === input);
  fakeScroll(62);
  window.dispatchEvent(new Event("scroll"));
  T("while_typing", calls.slice());
  input.blur();
  document.body.removeChild(input);

  // 4. Already at zero: nothing to do, and no scrollTo storm.
  calls.length = 0;
  fakeScroll(0);
  window.dispatchEvent(new Event("scroll"));
  T("when_already_zero", calls.slice());

  window.scrollTo = realScrollTo;

  // The reading that decides the NEXT step if the offset comes back: did the
  // reset move the number, or not? "Tried and failed" and "never tried" need
  // opposite answers and the panel shows the same thing for both.
  T("pin_stats", window.__pinStats ? {
    installed: window.__pinStats.installed,
    fired: window.__pinStats.fired > 0,
    reports_moved: window.__pinStats.moved !== null,
  } : null);
`;

function render() {
  const r = harness.renderPage({ name: "window-pin", windowSize: "440x894",
                                 stub: STUB, driver: DRIVER, budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.CANNOT_FAKE, undefined, "the driver could not fake a scroll: " + r.CANNOT_FAKE);
  return r;
}

test("the window is pinned at zero", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = render();

  await t.test("a scrolled window is put straight back", () => {
    // THE fix. 62px of window scroll is 62px of hit-testing offset, and every
    // control on the screen misses at once.
    assert.deepEqual(r.after_scroll_event, [[0, 0]],
      "the window was left scrolled, so every tap lands 62px below the button " +
      "it was aimed at: " + JSON.stringify(r.after_scroll_event));
  });

  await t.test("a rotation is re-checked after it settles", () => {
    // iOS fires orientationchange before the web view has finished resizing,
    // and the offset appears as it settles — the instrument had to sample a
    // turn three times for the same reason. One check on the event runs
    // before the thing it is checking for exists.
    assert.ok(r.after_rotation.length >= 1,
      "nothing re-checked the scroll after the rotation settled");
    for (const c of r.after_rotation) assert.deepEqual(c, [0, 0]);
  });

  await t.test("a focused text field is left alone", () => {
    assert.equal(r.focused, true, "the fixture never focused the input");
    assert.deepEqual(r.while_typing, [],
      "the app fought iOS while an input was focused, which parks the field " +
      "under the keyboard: " + JSON.stringify(r.while_typing));
  });

  await t.test("the pin records whether the number actually moved", () => {
    // v1.8.45 shipped the reset and the offset came back anyway, and nothing
    // could say whether the reset had run and failed or had never run at all.
    // Those need opposite next steps.
    assert.ok(r.pin_stats, "the pin keeps no record of what it did");
    assert.equal(r.pin_stats.installed, true);
    assert.equal(r.pin_stats.fired, true, "the pin never fired in this run");
    assert.equal(r.pin_stats.reports_moved, true,
      "the pin does not report whether the scroll moved when it reset it");
  });

  await t.test("a window already at zero is not touched", () => {
    assert.deepEqual(r.when_already_zero, [],
      "scrollTo is being called when there is nothing to reset, which on a " +
      "scroll listener is how a loop starts");
  });
});
