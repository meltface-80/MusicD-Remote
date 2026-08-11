"use strict";
// ---------------------------------------------------------------------------
// v1.7.57: the library-changed messages have to be readable.
//
// The messages now explain three things — why the error appeared, what the
// extension is doing about it, and the manual Rescan to fall back on — which
// makes them roughly 330 characters. The toast they land in was built for
// "Queued 12 albums": a fixed pill with `border-radius: 999px`, no max-width,
// centred with translateX(-50%), and dismissed after 2.4 seconds.
//
// So the longer text would have been laid out as one enormous line, centred on
// a viewport it no longer fitted, with both ends off-screen — and then removed
// before anybody could read the part that was visible. A better-worded message
// nobody can read is not an improvement, so the geometry is MEASURED at phone
// width rather than assumed from the stylesheet.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const STUB = `
window.__installFetch(function (url) {
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

// The real thing, as the server composes it.
const LONG =
  "Couldn't play from here: Roon offered no playback options for this album. " +
  "Your Roon library changed after this list was built — normally because albums " +
  "are being added or identified. The extension re-checks every 10 minutes and " +
  "refreshes itself once Roon settles, so this usually clears on its own. If it " +
  "hasn't, open the side menu and tap Rescan library.";

const DRIVER = `
  await window.__sleep(400);
  var LONG = ${JSON.stringify(LONG)};

  window.__showToast(LONG, "error");
  await window.__sleep(120);
  var t = document.getElementById("toast") || document.querySelector(".toast");
  var r = t.getBoundingClientRect();
  T("found", !!t);
  T("text_ok", t.textContent === LONG);
  T("vw", window.innerWidth);
  T("left", Math.round(r.left));
  T("right", Math.round(r.right));
  T("width", Math.round(r.width));
  T("height", Math.round(r.height));
  T("wrapped", r.height > 60);
  T("visible", getComputedStyle(t).opacity);

  // Lifetime is tracked through the .hidden class, NOT .show: .show is added
  // inside a requestAnimationFrame, and headless Chromium in --dump-dom mode
  // paints no frames, so rAF never runs here. .hidden is removed synchronously
  // when the toast is raised and re-added 250ms after it is dismissed, which is
  // the signal that survives this environment.
  await window.__sleep(3200);
  T("still_up", !(document.getElementById("toast") || document.querySelector(".toast"))
      .classList.contains("hidden"));

  // A short toast must not have been made sluggish by the same change.
  window.__showToast("Queued 12 albums");
  await window.__sleep(120);
  var s = (document.getElementById("toast") || document.querySelector(".toast"));
  T("short_h", Math.round(s.getBoundingClientRect().height));
  await window.__sleep(3200);
  T("short_gone", s.classList.contains("hidden"));
`;

test("a long library-changed message is readable on a phone", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "toast-long", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("it is on screen, in full, and inside the viewport", () => {
    assert.equal(r.found, true, "there is no toast element");
    assert.equal(r.text_ok, true, "the toast is not showing the message it was given");
    assert.ok(r.left >= 0,
      "the toast starts at x=" + r.left + " on a " + r.vw + "px screen — the left " +
      "end of the message is off the edge, which is what a centred pill with no " +
      "max-width does to 330 characters");
    assert.ok(r.right <= r.vw,
      "the toast ends at x=" + r.right + " on a " + r.vw + "px screen — the right " +
      "end is off the edge");
  });

  await t.test("it wraps rather than running off as one line", () => {
    assert.equal(r.wrapped, true,
      "the toast is only " + r.height + "px tall for a 330-character message, so it " +
      "is being laid out on one line");
  });

  await t.test("it uses the width of the screen, not a column up the middle", () => {
    // The real defect, and not the one it looks like. `left: 50%` makes the
    // containing block half the viewport, and a shrink-to-fit box cannot
    // exceed it — so this was 195px wide and 270px TALL on a 390px phone: a
    // narrow ribbon of text running up the centre of the screen. Reading the
    // stylesheet suggests nothing of the sort; only measuring shows it.
    assert.ok(r.width > r.vw * 0.8,
      "the toast is " + r.width + "px wide on a " + r.vw + "px screen (" +
      r.height + "px tall) — it is boxed into half the viewport by `left: 50%` " +
      "and needs `width: max-content` to escape it");
  });

  await t.test("THE one: it stays up long enough to be read", () => {
    // 2.4s was the fixed lifetime. Explaining the cause, the automatic recovery
    // AND the manual fallback in that time is not possible.
    assert.equal(r.still_up, true,
      "the message was dismissed within the old 2.4s toast lifetime — the user " +
      "gets a red flash they cannot read instead of an explanation");
  });

  await t.test("short toasts are unchanged", () => {
    // The scaling must not make every confirmation linger.
    assert.ok(r.short_h <= 60, "a one-line toast grew to " + r.short_h + "px");
    assert.equal(r.short_gone, true,
      "an ordinary confirmation now sits on screen for eleven seconds");
  });
});
