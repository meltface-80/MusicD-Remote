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

// ---------------------------------------------------------------------------
// THE COUPLING. app.js decides how much review can be sent; sharecard.js
// decides how much it will draw. They are two numbers in two files and nothing
// connected them, so the card silently ellipsized anything app.js was willing
// to send past about a thousand characters — which is most Wikipedia openings.
//
// This reads the cap out of app.js rather than repeating it, so raising the
// trim without raising DESC_MAX fails here instead of on a user's card.
// ---------------------------------------------------------------------------
const APP_JS = require("node:fs")
  .readFileSync(require("node:path").join(__dirname, "..", "..", "public", "app.js"), "utf8");

function appJsReviewCap() {
  // The line that hard-caps the description before it is handed to the card.
  // Anchored through to `reviewText = t` so it is this cap and not some other
  // length check that happens to be in the file.
  const m = /if \(t\.length > (\d+)\) t = t\.slice\(0, \d+\)[\s\S]{0,120}?reviewText = t;/
    .exec(APP_JS);
  assert.ok(m, "could not find the description length cap in public/app.js");
  return +m[1];
}

test("the longest review app.js can send is not cut off", () => {
  const cap = appJsReviewCap();
  // Real prose, repeated to the cap: short words wrap more generously than
  // long ones, so this is measured with an ordinary word length rather than a
  // best case.
  const word = "album ";
  const text = word.repeat(Math.ceil(cap / word.length)).slice(0, cap).trim();
  assert.ok(text.length >= cap - word.length, "the fixture is not actually at the cap");

  // ~13.5px a character is Manrope at 26px. The stub cannot load the real font,
  // so this is the metric the cap was chosen against.
  const m = ShareCard.measure(stubCtx(13.5), { ...BASE, review: text, reviewSource: "Wikipedia" });
  assert.ok(m.desc, "the longest review app.js can send was dropped entirely");
  const last = m.desc.lines[m.desc.lines.length - 1];
  assert.ok(!last.endsWith("\u2026"),
    `a ${cap}-character review — the longest app.js will send — is ellipsized at ` +
    `${m.desc.lines.length} lines. DESC_MAX and the app.js trim are a pair: raise ` +
    `one and the other has to follow, or the card quietly cuts most of a ` +
    `Wikipedia opening.`);
});

test("even the worst header plus the longest review stays under the ceiling", () => {
  // The ceiling is a backstop, not a budget — but it has to actually clear the
  // worst case, or a four-line title on a long review would be cropped.
  const cap = appJsReviewCap();
  const text = "album ".repeat(Math.ceil(cap / 6)).slice(0, cap).trim();
  const m = ShareCard.measure(stubCtx(13.5), {
    ...BASE,
    title: "An Extremely Long Album Title That Will Wrap Over Several Lines Indeed Yes Truly",
    artist: "A Very Long Collaborative Artist Credit Naming Several Different People",
    review: text, reviewSource: "Wikipedia",
  });
  assert.ok(m.cardH <= ShareCard.MAX_CARD_H,
    `${m.cardH}px against a ${ShareCard.MAX_CARD_H}px ceiling`);
  assert.ok(m.desc.lines.length >= 15,
    `only ${m.desc.lines.length} description lines survived a tall header — the ` +
    `header is eating the review again`);
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
