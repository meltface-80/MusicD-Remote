"use strict";
// ---------------------------------------------------------------------------
// v1.8.42: the app must not take away the user's way out of a bad frame.
//
// Reported twice. "Rotate to landscape, rotate back to portrait, and no button
// on screen works. Force closing is the only way to restore function." The
// first attempt at it removed the landscape BLOCK — which was the only thing
// that added or removed a full-viewport layer on rotation, and a fair
// candidate — and the freeze survived it. That eliminated the candidate and
// left the cause somewhere else.
//
// It is here, in three lines that were all doing the same job:
//
//   `maximum-scale=1` in the viewport meta, which pins the page scale. Pinning
//   it is the documented cause of iOS leaving a page at the WRONG scale after
//   an orientation change: the layout viewport keeps one orientation's width
//   while the visual viewport has the other, so the page re-flows and looks
//   correct while every tap lands somewhere else.
//
//   `user-scalable=no`, which iOS Safari has ignored since iOS 10 on
//   accessibility grounds and which therefore never did anything.
//
//   preventDefault() on gesturestart/gesturechange/gestureend, which
//   re-imposed the pinch block iOS refuses — and pinching is the ONLY way a
//   person gets a mis-scaled page back. That is the "force closing is the only
//   way" half of the report: the app removed the escape.
//
// Plus one amplifier: a touchend that preventDefault()ed any tap within 320ms
// of the last. preventDefault on touchend cancels the CLICK, so an impatient
// second tap was suppressed too — it could only ever make a dead-feeling
// screen deader.
//
// THIS SUITE CANNOT SEE ANY OF THAT HAPPEN. It is static text over a headless
// project, and the symptom is iOS window behaviour, which CLAUDE.md is explicit
// no assertion here can observe. What it CAN do is keep a known-good state
// from being changed back silently, which is the same job the head allowlist
// does — and the reason those lines could reappear is that each of them looks
// like a reasonable thing to add.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = process.env.MUSICD_PUBLIC_DIR
  ? path.resolve(process.env.MUSICD_PUBLIC_DIR)
  : path.join(__dirname, "..", "..", "public");

const indexHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const appJs     = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const styleCss  = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");

function viewportContent() {
  const m = indexHtml.match(/<meta\s+name="viewport"\s+content="([^"]*)"/);
  assert.ok(m, "there is no viewport meta at all");
  return m[1];
}

test("the viewport does not pin the page scale", async (t) => {

  await t.test("no maximum-scale", () => {
    const c = viewportContent();
    assert.doesNotMatch(c, /maximum-scale/,
      "maximum-scale pins the scale, which is what leaves iOS at the wrong one " +
      "after a rotation — the page re-flows and looks right while every tap " +
      "lands somewhere else: " + c);
  });

  await t.test("no user-scalable=no", () => {
    const c = viewportContent();
    assert.doesNotMatch(c, /user-scalable\s*=\s*no/,
      "iOS Safari has ignored this since iOS 10, so it buys nothing, and it " +
      "asks other browsers to remove the only recovery from a bad frame: " + c);
  });

  await t.test("viewport-fit=cover and the width/scale pair are untouched", () => {
    // The whole iOS full-screen contract rests on these. Removing the scale
    // LIMITS must not become removing the viewport line's actual job.
    const c = viewportContent();
    assert.match(c, /viewport-fit=cover/, c);
    assert.match(c, /width=device-width/, c);
    assert.match(c, /initial-scale=1/, c);
  });

  await t.test("pinch-zoom is not blocked in script", () => {
    // gesturestart/change/end are iOS's pinch. Cancelling them re-imposes the
    // block the viewport meta no longer asks for, and takes the escape hatch
    // with it.
    for (const evt of ["gesturestart", "gesturechange", "gestureend"]) {
      assert.doesNotMatch(appJs, new RegExp('["\']' + evt + '["\']'),
        "app.js handles " + evt + " again. Blocking pinch removes the only way " +
        "a person can recover a mis-scaled page, which is the 'force closing is " +
        "the only way to restore function' half of the v1.8.42 report.");
    }
  });

  await t.test("no tap is cancelled for being a quick second one", () => {
    // preventDefault() on touchend cancels the click. Applied to rapid repeat
    // taps it suppresses exactly the taps of somebody whose first one missed.
    const touchEnd = appJs.match(/addEventListener\(\s*["']touchend["'][\s\S]{0,400}?\)/g) || [];
    for (const block of touchEnd) {
      // Per-element touchend handlers are fine — the volume hold uses one. What
      // must not come back is a DOCUMENT-level one that preventDefaults.
      if (!/^addEventListener/.test(block)) continue;
      assert.doesNotMatch(block, /preventDefault/,
        "a document-level touchend cancels the click for every listener after " +
        "it: " + block.slice(0, 120));
    }
    assert.doesNotMatch(appJs, /document\.addEventListener\(\s*["']touchend["']/,
      "a document-level touchend handler is back — see the header");
  });

  await t.test("double-tap zoom is still suppressed, the correct way", () => {
    // The hacks above are only safe to remove because this does their one
    // legitimate job: it kills the double-tap gesture and leaves pinch alone.
    assert.match(styleCss, /touch-action:\s*manipulation/,
      "touch-action: manipulation is gone from style.css — without it, removing " +
      "the meta's scale limits really does let a double tap zoom the app");
  });
});
