"use strict";
// ---------------------------------------------------------------------------
// The share card's height arithmetic.
//
// The card is 1200 wide and as tall as its content needs, which means the
// height is a RESULT: measure the title, the artist and the description, then
// size the canvas, then draw. `measure()` owns that and draws nothing, so it
// can be checked here without a canvas — it needs only ctx.font (which it sets)
// and ctx.measureText (which it reads).
//
// The pixel side — that the text is actually PAINTED where this says — is
// test/dom/share-card-layout.test.js. Neither is sufficient alone: arithmetic
// that is right and never drawn produces a blank card, and a render test
// cannot tell you why a number came out the way it did.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const ShareCard = require("../../public/sharecard.js");

// A stand-in for a 2D context. fitText only ever sets .font and reads
// .measureText, so a fixed advance width is enough to exercise every branch —
// and it makes the line counts below arithmetic rather than font-dependent.
function stubCtx(perChar = 12) {
  return { font: "", measureText: (s) => ({ width: String(s).length * perChar }) };
}

const BASE = { title: "Zebra IV", artist: "Zebra",
               releaseRaw: "2003-07-08", label: "Mayhem Records" };

const REVIEW =
  "Zebra IV is the fourth studio album by American hard rock trio Zebra. It was " +
  "released on 8 July 2003, 20 years after their 1983 debut album, and 17 years " +
  "after their last studio effort, 3.V from 1986.";

test("a card with no description is exactly the height it always was", () => {
  // The floor is not decoration: a card with art, title and artist and nothing
  // else looked right at 600, and changing that would move every card that has
  // nothing to show.
  const m = ShareCard.measure(stubCtx(), BASE);
  assert.equal(m.cardH, ShareCard.MIN_CARD_H);
  assert.equal(m.cardH, 600);
  assert.equal(m.desc, null);
});

test("a description makes the card taller", () => {
  const bare = ShareCard.measure(stubCtx(), BASE);
  const full = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW });
  assert.ok(full.cardH > bare.cardH,
    `${full.cardH} vs ${bare.cardH} — the card is not growing, so the description ` +
    `is being squeezed into a fixed frame again`);
  assert.ok(full.desc && full.desc.lines.length >= 2);
});

test("the description wraps to the PANE width, not the column beside the art", () => {
  // The whole point of moving it. CONTENT_W is roughly double TEXT_W, so the
  // same prose takes about half as many lines.
  assert.ok(ShareCard.CONTENT_W > ShareCard.TEXT_W * 1.6,
    `CONTENT_W ${ShareCard.CONTENT_W} is not meaningfully wider than the old ` +
    `column ${ShareCard.TEXT_W} — the description gained no room`);
  // And it shows in the result: at 12px a character, this prose needs about
  // this many lines at each width, and the two are far enough apart that the
  // line count alone says which width was used.
  const wide = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW });
  const ifNarrow = Math.ceil((REVIEW.length * 12) / ShareCard.TEXT_W);
  assert.ok(wide.desc.lines.length < ifNarrow,
    `${wide.desc.lines.length} lines, and the old ${ShareCard.TEXT_W}px column ` +
    `would need about ${ifNarrow} — the description is still being wrapped narrow`);
});

test("the card never grows past its ceiling", () => {
  // app.js already trims to ~10 sentences; this is the backstop for prose that
  // is long even after that. A card taller than this is not displayed at a
  // sensible size anywhere it would be shared.
  const huge = ShareCard.measure(stubCtx(), { ...BASE, review: "word ".repeat(4000) });
  assert.ok(huge.cardH <= ShareCard.MAX_CARD_H,
    `${huge.cardH}px exceeds the ${ShareCard.MAX_CARD_H}px ceiling`);
  assert.ok(huge.desc, "a very long description was dropped rather than fitted");
});

test("the source is only reported when there is text for it to attribute", () => {
  // "Wikipedia" under nothing is a label for an absence.
  const withText = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW, reviewSource: "Wikipedia" });
  assert.equal(withText.srcText, "Wikipedia");

  const noText = ShareCard.measure(stubCtx(), { ...BASE, review: "", reviewSource: "Wikipedia" });
  assert.equal(noText.srcText, "", "the source is attributed to a description that is not there");
  assert.equal(noText.cardH, 600, "an orphaned source line still grew the card");
});

test("the source line adds height, so it cannot be drawn off the card", () => {
  const without = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW });
  const with_   = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW, reviewSource: "Wikipedia" });
  assert.ok(with_.cardH > without.cardH,
    `the card is ${with_.cardH} either way — the source line is drawn below the ` +
    `description without any room being reserved for it`);
});

test("a tall header makes the card taller rather than evicting the description", () => {
  // THE regression this layout exists to prevent. A four-line title used to eat
  // the description's vertical room, because both lived in the same column and
  // the card could not grow. Now the header pushes the card down instead.
  const longTitle = "An Extremely Long Album Title That Will Wrap Over Several Lines Indeed Yes";
  const a = ShareCard.measure(stubCtx(), { ...BASE, review: REVIEW });
  const b = ShareCard.measure(stubCtx(), { ...BASE, title: longTitle, review: REVIEW });
  assert.ok(b.desc, "a long title dropped the description again");
  assert.equal(b.desc.lines.length, a.desc.lines.length,
    `the description lost lines (${b.desc.lines.length} vs ${a.desc.lines.length}) ` +
    `because the title got longer — they are competing for height again`);
  assert.ok(b.cardH >= a.cardH, "the card did not absorb the taller header");
});

test("the header is never shorter than the cover", () => {
  // The art is 424px and is drawn inside the header row; a header measured from
  // the text alone would let a one-line title crop it.
  const m = ShareCard.measure(stubCtx(), BASE);
  assert.ok(m.headerH >= 424, `headerH ${m.headerH} is shorter than the 424px cover`);
});

test("it survives an album with nothing but a title", () => {
  const m = ShareCard.measure(stubCtx(), { title: "X" });
  assert.equal(typeof m.cardH, "number");
  assert.ok(m.cardH >= 600);
  assert.equal(m.metaText, null);
});
