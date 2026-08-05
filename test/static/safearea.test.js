"use strict";
// ---------------------------------------------------------------------------
// v1.7.42: nothing pinned to the top of the screen may ignore the status bar.
//
// Reported as "occasionally when I reopen the extension and go to the now
// playing screen it is stretched too high above the top of the screen".
//
// The page is served with `viewport-fit=cover`, which is what lets the app fill
// the display edge to edge — and which also means the layout viewport STARTS at
// the physical top of the screen, underneath the status bar and the dynamic
// island. Anything pinned there has to add `env(safe-area-inset-top)` back.
//
// The topbar always did. The modal never did, and the Now playing screen is the
// place it shows worst: its whole design is a short 14px top padding so the tabs
// sit up beside the corner buttons, so it had the least room to spare. It only
// appears in the INSTALLED PWA — in a browser tab the address bar occupies that
// space — which is why it read as "occasional".
//
// This is a static test, not a DOM one, because headless Chromium reports no
// insets: env(safe-area-inset-top) is 0 there, so a rendered page cannot tell
// a correct rule from a missing one. What can be checked is that the rule is
// written at all.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.resolve(__dirname, "..", "..", "public");
const CSS  = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");
const HTML = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

// The declaration block for a selector, as written. Good enough for these
// single-block selectors and it reads the shipping file rather than a copy.
function block(selector) {
  const i = CSS.indexOf(selector);
  if (i < 0) throw new Error("selector not found in style.css: " + selector);
  const open = CSS.indexOf("{", i);
  const close = CSS.indexOf("}", open);
  assert.ok(open > -1 && close > open, "unterminated block for " + selector);
  return CSS.slice(open + 1, close);
}

test("the app opts into the full screen, which is what creates the obligation", () => {
  // If this ever goes away the insets below become unnecessary rather than
  // wrong — so the test that depends on it should say so out loud.
  assert.match(HTML, /viewport-fit=cover/,
    "without viewport-fit=cover the layout viewport already excludes the " +
    "status bar and none of the rules below would be needed");
});

test("everything pinned to the top of the modal clears the status bar", async (t) => {
  const pinned = [
    [".modal-close {", "the × button"],
    [".modal-share {", "the share button"],
    [".modal.np-mode .modal-home {", "the Now playing Home button"],
  ];
  for (const [sel, what] of pinned) {
    await t.test(what + " adds the top inset", () => {
      const b = block(sel);
      assert.match(b, /top:\s*calc\([^)]*env\(safe-area-inset-top\)/,
        what + " is pinned with a bare `top` — on a phone it sits under the " +
        "status bar / dynamic island");
    });
  }

  await t.test("the modal body reserves room for it", () => {
    assert.match(block(".modal-body {"), /padding:\s*calc\([^)]*env\(safe-area-inset-top\)/,
      "the modal's content starts at the physical top of the display");
  });

  await t.test("the Now playing body reserves room for it", () => {
    // THE one. This block deliberately shortens the top padding to 14px so the
    // tabs sit beside the corner buttons, which leaves nothing to absorb a
    // ~59px status bar.
    assert.match(block(".modal.np-mode .modal-body {"),
      /padding-top:\s*calc\([^)]*env\(safe-area-inset-top\)/,
      "the Now playing screen starts under the status bar — this is the " +
      "\"stretched too high above the top of the screen\" report");
  });
});

test("the surfaces that already got this right still have it", async (t) => {
  // Guards the opposite regression: these were correct before v1.7.42 and the
  // change must not have disturbed them.
  await t.test("the topbar", () => {
    assert.match(CSS, /padding-top:\s*calc\(12px \+ env\(safe-area-inset-top\)\)/,
      "the topbar lost its inset");
  });

  await t.test("the bottom inset is still respected in more places than the top", () => {
    // Sanity on the file itself rather than on any one rule: the bottom inset
    // has always been handled thoroughly here, and a count that collapses to
    // zero means something drastic happened to the stylesheet.
    const bottom = (CSS.match(/env\(safe-area-inset-bottom\)/g) || []).length;
    assert.ok(bottom >= 10, "safe-area-inset-bottom handling has been lost (" + bottom + " uses)");
  });
});
