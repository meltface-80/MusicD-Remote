"use strict";
// ---------------------------------------------------------------------------
// v1.7.89: the share card's text on the worst sleeve it can be given.
//
// The card is a glass pane over the album's own cover, softened and scrimmed.
// That means the surface the text sits on is not a fixed colour — it is
// whatever the album looks like, flattened through two scrims and the pane.
// A white sleeve is the case that decides readability, and it is the one case
// nobody looks at while designing, because the covers to hand are never white.
//
// The card is a PNG rendered on a canvas, so no DOM assertion can see any of
// this — the colours are literals in a drawing routine. What CAN be checked is
// the arithmetic, from the literals themselves rather than from numbers copied
// into a comment.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = process.env.MUSICD_PUBLIC_DIR
  ? path.resolve(process.env.MUSICD_PUBLIC_DIR)
  : path.resolve(__dirname, "..", "..", "public");
const SRC = fs.readFileSync(path.join(PUBLIC, "sharecard.js"), "utf8");

const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (fg, a, bg) => fg.map((v, i) => v * a + bg[i] * (1 - a));
const hex = (h) => [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16));

// Pull the literals out of the drawing routine. Anchored on the names so a
// renamed constant fails loudly here rather than silently measuring the wrong
// colour.
function rgba(name) {
  const m = new RegExp(name + "\\s*=\\s*'rgba\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)\\)'")
    .exec(SRC);
  assert.ok(m, `could not find ${name} in sharecard.js`);
  return { c: [+m[1], +m[2], +m[3]], a: +m[4] };
}
function scrimAlpha() {
  const m = /ctx\.fillStyle = 'rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)';\s*\n\s*ctx\.fillRect\(0, 0, CARD_W, CARD_H\)/
    .exec(SRC);
  assert.ok(m, "could not find the flat scrim over the softened cover");
  return { c: [+m[1], +m[2], +m[3]], a: +m[4] };
}
function fill(after) {
  const m = new RegExp(after + "[\\s\\S]{0,400}?ctx\\.fillStyle = '(#[0-9a-f]{6})'").exec(SRC);
  assert.ok(m, `could not find the fill colour after ${after}`);
  return hex(m[1]);
}

test("the card's text survives a white sleeve", async (t) => {
  const pane  = rgba("PANE_FILL");
  const scrim = scrimAlpha();

  // The worst surface the card can put under its text: a fully white cover,
  // softened (which cannot make it darker), then the flat scrim, then the pane.
  const worst = over(pane.c, pane.a, over(scrim.c, scrim.a, [255, 255, 255]));

  const TIERS = [
    // [what, the fill, the floor that applies]
    ["the title",  hex("#ffffff"), 4.5],
    // Both of these are set right after their own comment/marker in render().
    ["the artist", fill("--- Artist ---"), 4.5],
    ["the release line", fill("if \\(metaText\\) \\{"), 4.5],
  ];

  for (const [what, colour, floor] of TIERS) {
    await t.test(`${what} clears ${floor}:1 on it`, () => {
      const c = contrast(colour, worst);
      assert.ok(c >= floor,
        `${what} is rgb(${colour.join(",")}) on a worst-case pane of ` +
        `rgb(${worst.map(Math.round).join(",")}) — ${c.toFixed(2)}:1, need ${floor}. ` +
        `A white album cover is the surface this has to survive, and it is the ` +
        `one nobody tests against by eye.`);
    });
  }

  await t.test("the pane is genuinely translucent", () => {
    // If it were opaque the softened cover behind it would be invisible and the
    // card would be a flat slab again — which is what it was before v1.7.89.
    assert.ok(pane.a > 0 && pane.a < 1,
      `the pane is ${pane.a} opaque — at 1 the artwork behind it does not show ` +
      `at all and the glass is decorative only`);
    assert.ok(scrim.a < 1,
      `the scrim over the cover is ${scrim.a} — at 1 it hides the artwork it is ` +
      `meant to be darkening`);
  });
});
