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

// EVERY declaration block whose selector list contains this selector.
//
// This used to take the first `indexOf` hit and read that one block, which
// silently asks a different question: "does the FIRST rule mentioning
// .modal-share carry the inset". v1.7.84 added an earlier rule that gives
// .modal-close and .modal-share a scrim over the album artwork, and that rule
// — correctly — has no `top` in it. The pin was still there, 200 lines further
// down, and the test failed anyway.
//
// The invariant was never "the first rule"; it is "the element IS pinned with
// the inset SOMEWHERE". So collect them all and let the caller ask.
//
// A brace-depth walk rather than a regex: rules live inside @media blocks in
// this file, and a flat /[^{}]*\{[^{}]*\}/ cannot see into one — it matches
// the media prelude and stops, which silently loses every rule that is only
// declared for a breakpoint.
function allRules() {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") { stack.push(buf.trim()); buf = ""; }
    else if (c === "}") {
      const sel = stack.pop();
      // An at-rule prelude (@media, @supports, @keyframes) is a container, not
      // a selector — its "body" is more rules, already collected on their own.
      if (sel && sel[0] !== "@") rules.push({ sel, body: buf });
      buf = "";
    } else buf += c;
  }
  return rules;
}
const RULES = allRules();

function blocks(selector) {
  const bare = selector.replace(/\s*\{\s*$/, "").trim();
  const out = RULES
    .filter(r => r.sel.split(",").some(s2 => s2.trim() === bare))
    .map(r => r.body);
  if (!out.length) throw new Error("selector not found in style.css: " + selector);
  return out;
}
// Joined, for the assertions that ask whether the element is styled a certain
// way at all rather than which rule does it.
function block(selector) { return blocks(selector).join("\n"); }

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
    // The BASE rule, not the joined text: v1.7.84's album-art hero deliberately
    // sets padding-top: 0 on the album view so the cover runs to the physical
    // top of the display, and a joined match would be satisfied by the base
    // rule while the effective value was zero.
    assert.match(blocks(".modal-body {")[0],
      /padding:\s*calc\([^)]*env\(safe-area-inset-top\)/,
      "the modal's content starts at the physical top of the display");
  });

  await t.test("...and only ARTWORK is allowed to give that reserve up", () => {
    // Exactly one rule may zero it, it must be the album view's, and the thing
    // that then sits under the status bar must be the cover — which is the
    // point of the hero and is asserted by measurement in
    // test/dom/album-hero.test.js ("the cover spans the full width", plus the
    // title clearing the art). If a second screen ever zeroes this, it is
    // putting its own first element under the dynamic island.
    const zeroed = RULES.filter(r =>
      /(^|;|\s)padding-top:\s*0(px)?\s*;/.test(r.body) &&
      r.sel.split(",").some(s2 => s2.trim().endsWith(".modal-body")));
    assert.equal(zeroed.length, 1,
      "expected exactly one .modal-body rule to drop the top inset, found " +
      zeroed.length + ": " + zeroed.map(z => z.sel).join(" | "));
    assert.match(zeroed[0].sel, /:not\(\.np-mode\)/,
      "a screen other than the album view is starting its content under the " +
      "status bar: " + zeroed[0].sel);
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
