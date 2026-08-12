"use strict";
// ---------------------------------------------------------------------------
// v1.7.69: the progress fills must not carry a CSS width transition.
//
// Both progress bars are painted from a clock by JS, four times a second:
// app.js's 250ms painter for `.mt-progress-fill`, display.js's for `.bb-fill`.
// A `transition: width` on top of that does not smooth anything — it fights
// the painter. `.mt-progress-fill` carried `.4s linear`, restarted every 250ms,
// so it could never reach the value it was animating towards: the fill sat
// permanently behind the position just computed, while continuously animating a
// property that is not compositor-accelerated. `.bb-fill` had `.25s`, exactly
// its own tick, so it trailed by a full frame of the poll.
//
// The transitions made sense when the position advanced once a second and the
// transition WAS the interpolation. That stopped being true in v1.7.68.
//
// This is a static test rather than a DOM one for the same reason safearea's
// is: a headless page cannot observe it. `element.style.width` reports the
// inline value the painter wrote, which a transition does not change, and
// virtual time does not advance animations — so no assertion in the DOM
// harness can tell a transitioned fill from a plain one. What can be checked is
// that the declaration is not there.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Honour MUSICD_PUBLIC_DIR, like the DOM harness does. Without it a mutation
// run cannot reach this file and every assertion below is permanently green —
// the exact failure that let two v1.7.60 assertions pass against a broken head.
const PUBLIC = process.env.MUSICD_PUBLIC_DIR
  ? path.resolve(process.env.MUSICD_PUBLIC_DIR)
  : path.resolve(__dirname, "..", "..", "public");

// Comments are stripped first. A bare text search matches the word "transition"
// inside the comment that explains why there isn't one — a check that cries
// wolf gets waved through, which is how a real one gets missed.
function ruleBody(css, selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const i = bare.indexOf(selector);
  assert.notEqual(i, -1, "selector not found: " + selector);
  const open = bare.indexOf("{", i);
  const close = bare.indexOf("}", open);
  assert.ok(open > -1 && close > open, "unterminated rule for " + selector);
  return bare.slice(open + 1, close);
}

const CASES = [
  ["style.css", ".mt-progress-fill", "app.js paints it every 250ms"],
  ["display.css", ".bb-fill", "display.js paints it every 250ms"],
];

test("the JS-painted progress fills carry no width transition", () => {
  for (const [file, selector, why] of CASES) {
    const css = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    const body = ruleBody(css, selector);
    const decls = body.split(";").map(d => d.trim()).filter(Boolean);
    const offenders = decls.filter(d =>
      /^transition(-property)?\s*:/.test(d) && /\bwidth\b|\ball\b/.test(d));
    assert.deepEqual(offenders, [],
      file + " " + selector + " declares " + JSON.stringify(offenders) + ". " +
      why + ", so a width transition cannot smooth it — it restarts before it " +
      "completes and leaves the fill trailing the position by the transition's " +
      "own duration, animating a non-composited property the whole time.");
  }
});
