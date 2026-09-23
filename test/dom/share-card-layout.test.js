"use strict";
// ---------------------------------------------------------------------------
// The share card's description sits BELOW the cover, and the card grows for it.
//
// It used to live in the column beside a 424px cover, which left it ~600px to
// wrap in and whatever vertical room the title and artist had not already
// taken — on a four-line title, none. The text the server had gone and fetched
// was routinely dropped, and a card with no description looks exactly like a
// card for a record that has none.
//
// Underneath, it has the full pane width and the card grows to hold it.
//
// WHY THIS IS A PIXEL TEST. The card is a PNG drawn on a canvas: there is no
// DOM to query, no element to measure, and the layout arithmetic is arithmetic
// (test/unit/sharecard-layout.test.js pins that directly). What only a render
// can answer is whether the text is actually PAINTED where the arithmetic says
// — the canvas is resized mid-render, which resets the context, and a mistake
// there produces a blank card rather than an error.
//
// The cover is WHITE, deliberately: that is the worst ground the card can be
// given, and the one nobody checks by eye because the covers to hand are never
// white.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const REVIEW =
  "Zebra IV is the fourth studio album by American hard rock trio Zebra. It was " +
  "released on 8 July 2003, 20 years after their 1983 debut album, and 17 years " +
  "after their last studio effort, 3.V from 1986. Although Zebra had continued to " +
  "be active in the years following its release, this was the band's last studio " +
  "album for 23 years until the release of their upcoming fifth studio album V.";

// Renders two cards — one with a description, one without — and reports the
// geometry plus an ink scan of the band under the cover.
const DRIVER = `
  // A solid WHITE cover. The worst surface this card can be handed.
  const cov = document.createElement('canvas');
  cov.width = cov.height = 64;
  const cctx = cov.getContext('2d');
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(0, 0, 64, 64);
  const coverUrl = cov.toDataURL('image/png');

  async function draw(extra) {
    const blob = await ShareCard.render(Object.assign({
      coverUrl, wordmarkUrl: null,
      title: 'Zebra IV', artist: 'Zebra',
      releaseRaw: '2003-07-08', label: 'Mayhem Records',
      score: null, bestNewMusic: false,
    }, extra));
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error('decode'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return { w: img.width, h: img.height, ctx: c.getContext('2d') };
  }

  // How much INK is in a box: pixels whose luminance is far from that row's own
  // median. The median is the background, whatever the softened sleeve made it,
  // so this needs no knowledge of the palette.
  function ink(ctx, x0, y0, w, h) {
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let row = 0; row < h; row++) {
      const lums = [];
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        lums.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      }
      const med = lums.slice().sort((a, b) => a - b)[Math.floor(w / 2)];
      for (const L of lums) if (Math.abs(L - med) > 28) n++;
    }
    return n;
  }

  const withDesc = await draw({ review: ${JSON.stringify(REVIEW)}, reviewSource: 'Wikipedia' });
  const bare     = await draw({ review: '', reviewSource: '' });

  T('w', withDesc.w);
  T('h_with', withDesc.h);
  T('h_bare', bare.h);

  // The pane's content box. INSET 48 + PANE_PAD 40 = 88 from the card edge.
  const ART_X = 88, ART_W = 424, ART_H = 424;
  // The art is centred in the header, and with a one-line title the header IS
  // the art, so the cover's bottom is the top of the band under it. Start well
  // clear of the hairline.
  const contentTop = 88;
  const bandY = contentTop + ART_H + 70;
  const bandH = 150;

  // UNDER THE COVER: x inside the art's own column. Nothing was ever drawn
  // here before — the description lived to the RIGHT of x=516.
  T('ink_under_art', ink(withDesc.ctx, ART_X, bandY, 380, bandH));
  // The CONTROL, and it has to be a box that exists on the bare card. A bare
  // card is 600 tall, so the band above is off the bottom of it entirely —
  // clamping into range just slides the box back over the artwork and measures
  // the sleeve. The strip between the cover's bottom edge and the pane's is the
  // only empty pane a bare card has, and it is exactly where a hairline and the
  // first line of a description would land.
  T('ink_under_art_bare', ink(bare.ctx, ART_X, contentTop + ART_H + 6, 380, 28));
  // THE SAME STRIP ON THE SAME IMAGE that reports 400+ below. It is the quiet
  // gap between the cover and the first line of text (the hairline sitting in
  // it is rgba(255,255,255,.16), far below the ink threshold on purpose — it is
  // a hairline, not a rule). A detector that reports ~0 here and 400+ eighty
  // pixels lower is measuring text, not the sleeve.
  T('ink_gap_with', ink(withDesc.ctx, ART_X, contentTop + ART_H + 6, 380, 28));
  // And the full content width is in use, not just the old right-hand column.
  T('ink_right_half', ink(withDesc.ctx, 700, bandY, 380, bandH));
`;

test("the description is drawn below the cover, and the card grows for it", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({ name: "share-card-layout", driver: DRIVER, budgetMs: 30000 });
  harness.assertNoPageError(assert, r);

  await t.test("the card is 1200 wide and keeps its floor without a description", () => {
    assert.equal(r.w, 1200);
    assert.equal(r.h_bare, 600,
      `a card with no description is ${r.h_bare}px tall — it should be exactly the ` +
      `600 it always was, or the change moved cards that have nothing to show`);
  });

  await t.test("a description makes the card TALLER", () => {
    assert.ok(r.h_with > r.h_bare + 150,
      `with a ${REVIEW.length}-character description the card is ${r.h_with}px against ` +
      `${r.h_bare}px bare — it did not grow, so the text is being squeezed into the ` +
      `old fixed frame instead of being given room`);
  });

  await t.test("THE one: there is text UNDER the cover", () => {
    // The column below the art. Before this change the description lived
    // entirely to the right of x=516, so ink here is the whole claim.
    assert.ok(r.ink_under_art > 400,
      `only ${r.ink_under_art} ink pixels under the cover — the description is not ` +
      `being drawn there. (The same box on a card with no description has ` +
      `${r.ink_under_art_bare}.)`);
  });

  await t.test("…and the same strip is empty without one, so the scan means something", () => {
    // Without this the assertions above would pass on a card with a merely
    // noisy background, and would keep passing if the text moved back.
    assert.ok(r.ink_under_art_bare < 60,
      `a card with NO description has ${r.ink_under_art_bare} ink pixels in the strip ` +
      `under its cover, so the scan is measuring the background rather than the text`);
    // And the decisive one: the SAME image, the same scan, 80px higher — in the
    // gap between the cover and the first line of text. Near zero there and
    // 400+ below is the difference between reading text and reading a sleeve.
    assert.ok(r.ink_gap_with < 60 && r.ink_under_art > r.ink_gap_with + 300,
      `the gap above the description scans ${r.ink_gap_with} and the description ` +
      `band ${r.ink_under_art} on the same card — too close together for the scan ` +
      `to be distinguishing text from the background`);
  });

  await t.test("the text uses the full pane width, not the old right column", () => {
    assert.ok(r.ink_right_half > 400,
      `${r.ink_right_half} ink pixels in the right half of the band — the description ` +
      `is not spanning the pane`);
  });
});
