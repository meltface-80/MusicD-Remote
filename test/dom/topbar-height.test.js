"use strict";
// ---------------------------------------------------------------------------
// v1.8.47: the Home screen opened one safe-area inset too far down.
//
// Reported after the rotation work, with two screenshots a minute apart: the
// same rows in the same order, the whole lot pushed down by an empty band
// about 62px tall — this device's top safe-area inset, the same number as the
// scroll offset in v1.8.45.
//
// THE MECHANISM, and it is a one-word bug. `--topbar-h` is published from
// `getBoundingClientRect().height`, which INCLUDES padding, and the bar's
// padding is `calc(12px + env(safe-area-inset-top))` — so the inset is inside
// it. The ResizeObserver watching the bar used default options, which watch
// the CONTENT box. The inset is not in the content box. A change to the safe
// area could therefore move the bar's real height without the observer firing
// at all, leaving `--topbar-h` holding a value from the orientation before —
// and `main` reserves that number as its top padding.
//
// A rotation is the one thing that changes an inset, which is why this showed
// up only now: before v1.8.40 the app refused to run in landscape.
//
// WHAT THIS FILE CAN AND CANNOT TEST. It has no safe areas (CLAUDE.md), so the
// inset is simulated the only way it can be: by changing the bar's PADDING,
// which is where the inset lives and is exactly what the observer was blind
// to. And ResizeObserver never fires in this headless harness at all —
// measured, not assumed: an observer installed here does not even get the
// single callback `observe()` is supposed to deliver. So the observer half of
// the fix is not observable from here.
//
// The half that IS, and the half that matters for a rotation, is the viewport
// events. Before this version the `resize` and `orientationchange` listeners
// existed ONLY in the `else` branch taken when ResizeObserver is missing — so
// on every modern browser a rotation notified nothing at all, and the only
// thing that could have updated `--topbar-h` was the observer that cannot see
// padding. That is the gap, and it is what these assertions close.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = Array.from({ length: 6 }, (_, i) => ({
  offset: i, title: "Album " + (i + 1), subtitle: "Artist " + (i + 1), image_key: "k" }));

const STUB = `
window.__installFetch(function (u) {
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 6, filtered: false });
  if (u.indexOf("/api/home/") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, label: null });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [] });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(900);
  var bar = document.querySelector(".topbar");
  var app = document.querySelector(".app");
  var read = function () {
    return {
      varPx: parseFloat(getComputedStyle(app).getPropertyValue("--topbar-h")) || 0,
      barH: Math.round(bar.getBoundingClientRect().height),
    };
  };
  T("settled", read());

  /*
   * The inset lives in the bar's padding, so growing the padding is exactly
   * what a rotation into a taller inset does to this element — and it leaves
   * the CONTENT box untouched, which is the blind spot.
   */
  var before = read();
  bar.style.paddingTop = (parseFloat(getComputedStyle(bar).paddingTop) + 62) + "px";
  // A rotation changes the inset AND fires this. Dispatching it is what makes
  // the test a test of the fix rather than of the observer the harness cannot
  // run.
  window.dispatchEvent(new Event("resize"));
  await window.__sleep(1400);
  T("after_inset_grew", read());
  T("bar_really_grew", read().barH - before.barH);

  // And back again, the way rotating back does.
  bar.style.paddingTop = "";
  window.dispatchEvent(new Event("orientationchange"));
  await window.__sleep(1400);
  T("after_inset_shrank", read());

  // What the Home screen actually reserves, which is the thing people see.
  T("main_pad", Math.round(parseFloat(getComputedStyle(document.querySelector("main")).paddingTop)));
`;

test("the top bar's measured height follows the safe-area inset", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({ name: "topbar-height", windowSize: "440x894",
                                 stub: STUB, driver: DRIVER, budgetMs: 45000 });
  harness.assertNoPageError(assert, r);

  await t.test("it starts in step with the bar", () => {
    assert.ok(r.settled.varPx > 0, "--topbar-h was never published");
    assert.ok(Math.abs(r.settled.varPx - r.settled.barH) <= 1,
      "--topbar-h (" + r.settled.varPx + ") does not match the bar (" + r.settled.barH + ")");
  });

  await t.test("a taller inset moves it", () => {
    // THE bug. The bar really did get 62px taller; if --topbar-h does not
    // follow, main reserves the old number and Home opens an inset too far
    // down — or, coming back the other way, with a band of empty above it.
    assert.equal(r.bar_really_grew, 62, "the fixture did not change the bar's height");
    assert.ok(Math.abs(r.after_inset_grew.varPx - r.after_inset_grew.barH) <= 1,
      "--topbar-h stayed at " + r.after_inset_grew.varPx + " while the bar became " +
      r.after_inset_grew.barH + " — the inset changed inside the PADDING, and " +
      "nothing that a rotation fires went and re-measured it");
  });

  await t.test("and a shorter one moves it back", () => {
    assert.ok(Math.abs(r.after_inset_shrank.varPx - r.after_inset_shrank.barH) <= 1,
      "--topbar-h is stuck at " + r.after_inset_shrank.varPx + " with the bar at " +
      r.after_inset_shrank.barH);
  });

  await t.test("main reserves the bar's height, not a stale one", () => {
    // The user-visible end of it: an empty band above the first Home row.
    assert.ok(r.main_pad >= r.after_inset_shrank.barH,
      "main reserves " + r.main_pad + " for a bar of " + r.after_inset_shrank.barH);
    assert.ok(r.main_pad - r.after_inset_shrank.barH < 40,
      "main reserves " + r.main_pad + " for a bar of " + r.after_inset_shrank.barH +
      " — that gap is the empty band people see above the first row");
  });
});
