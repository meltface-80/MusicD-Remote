"use strict";
// ---------------------------------------------------------------------------
// The waveform's ACCURACY — is the shape on screen a true picture of the audio,
// and is it in the right place?
//
// test/dom/waveform.test.js pins that the control survives every way the
// feature can fail. This file pins the two claims the feature is FOR, both of
// which can be wrong while everything above still passes:
//
//   1. A BAR IS THE LEVEL OF ITS SLICE. The stored values are RMS levels, so
//      the browser has to fold them by RMS too. Fold by maximum and a limited
//      record draws a brick — every bar the same height, because the loudest
//      moment in a second of it is the same number everywhere. Fold by mean and
//      a sparse loud passage reads quiet. Neither shows up as an error; both
//      just draw the wrong picture, confidently.
//
//   2. THE SHAPE IS UNDER THE PLAYHEAD. A range input cannot let its thumb hang
//      off either end, so the thumb's centre travels from thumbW/2 to
//      width - thumbW/2. Bars laid from 0 to width instead disagree with it by
//      thumbW * (0.5 - frac): half a thumb ahead of the music at the start,
//      level in the middle, half a thumb behind at the end. Zero at the halfway
//      point is exactly why it survived being looked at.
//
// EVERY NUMBER HERE IS TAKEN AT DRIVER TIME, out of the canvas's own
// getImageData and getBoundingClientRect in the same frame. Nothing is compared
// against a screenshot pixel — see CLAUDE.md on v1.7.90, where a driver-time
// rect measured against a shot taken seconds later reported an 8.5px
// misalignment that did not exist.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const LENGTH = 285;

function zone(seekPosition, state) {
  return {
    zone_id: "z1", display_name: "Living Room", state: state || "paused",
    is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
    settings: { shuffle: false, loop: "disabled", auto_radio: false },
    outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
                volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
    now_playing: {
      three_line: { line1: "Sunday", line2: "David Bowie", line3: "Heathen" },
      line1: "Sunday", line2: "David Bowie", line3: "Heathen",
      image_key: "k", length: LENGTH, seek_position: seekPosition,
    },
  };
}

const b64 = (arr) => Buffer.from(Uint8Array.from(arr)).toString("base64");

const stub = (z, peaks) => `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/settings/waveform") > -1)
    return window.__json({ enabled: true, decoder: true });
  if (u.indexOf("/api/waveform") > -1)
    return window.__json({ peaks: ${JSON.stringify(peaks)}, n: 4000, cached: true });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(z)} });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(z)}] });
  if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/settings") > -1)   return window.__json({});
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;

// Open Now playing, then report the drawn canvas as one number per device-pixel
// column: how many rows of that column carry ink.
//
// A bar is one device pixel wide with a gap beside it, so a column of zero on
// its own means nothing — the height of a BAR is the taller of each adjacent
// pair, which is what `cols` is read as at the other end.
const DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(1600);

  var wave = document.getElementById("np-wave");
  var seek = document.getElementById("np-seek");
  T("wave_hidden", !wave || wave.classList.contains("hidden"));
  var wb = wave.getBoundingClientRect(), sb = seek.getBoundingClientRect();
  T("geom", {
    dpr: window.devicePixelRatio || 1,
    canvasW: wave.width, canvasH: wave.height,
    cssW: wb.width, cssH: wb.height, cssLeft: wb.left,
    seekLeft: sb.left, seekW: sb.width,
    value: Number(seek.value), max: Number(seek.max),
    thumb: parseFloat(getComputedStyle(document.querySelector(".np-progress"))
                        .getPropertyValue("--seek-thumb")) || 0,
  });
  T("fits", (function () {
    var row = document.querySelector(".np-transport");
    if (!row) return null;
    var rr = row.getBoundingClientRect();
    var panel = document.querySelector(".np-panel") || document.body;
    return { rowBottom: Math.round(rr.bottom), vh: window.innerHeight,
             panelScroll: panel.scrollHeight - panel.clientHeight };
  })());
  T("cols", (function () {
    var c = wave.getContext("2d");
    if (!c) return null;
    var d = c.getImageData(0, 0, wave.width, wave.height).data;
    var out = [];
    for (var x = 0; x < wave.width; x++) {
      var n = 0;
      for (var y = 0; y < wave.height; y++) {
        // Half opacity or better. The track ahead is drawn at .72 alpha and a
        // fractional bar height antialiases the two end caps, so a bare "any
        // ink at all" would count a cap twice over.
        if (d[(y * wave.width + x) * 4 + 3] > 128) n++;
      }
      out.push(n);
    }
    return out;
  })());
`;

// One height per BAR position, from the per-column counts: a bar is ink beside
// a gap, so the taller of each adjacent pair is the bar.
function barHeights(cols) {
  const out = [];
  for (let x = 0; x < cols.length - 1; x++) out.push(Math.max(cols[x], cols[x + 1]));
  return out;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

test("THE one: a bar is the LEVEL of its slice, not its loudest moment", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  /*
   * TWO PASSAGES AT THE SAME LEVEL, WRITTEN DIFFERENTLY.
   *
   * The first half is a steady 128. The second is one bucket of 255 in every
   * four and silence between them — whose RMS is sqrt(255² / 4) = 127.5, the
   * same passage by the only measure that matters. Sparse and loud, or steady
   * and moderate; a listener hears them at the same level and the bar should be
   * the same height.
   *
   * That is a fixture the three candidate folds disagree about violently:
   *
   *   RMS      the two halves draw the same height          (ratio 1.0)
   *   maximum  the sparse half draws twice as tall          (ratio 2.0)
   *   mean     the sparse half draws half as tall           (ratio 0.5)
   *
   * so the assertion needs no tolerance argument to be worth anything. A bar
   * covers 20-30 stored buckets here, and whether it catches five spikes or six
   * moves its RMS by a few percent — hence 20%, which is nowhere near either
   * wrong answer.
   */
  const peaks = new Array(4000);
  for (let i = 0; i < 2000; i++) peaks[i] = 128;
  for (let i = 2000; i < 4000; i++) peaks[i] = (i % 4 === 0) ? 255 : 0;

  const r = harness.renderPage({
    name: "wf-fold", windowSize: "390x844",
    stub: stub(zone(0), b64(peaks)), driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.wave_hidden, false, "no waveform was drawn, so there is nothing to measure");
  assert.ok(Array.isArray(r.cols) && r.cols.length > 100, "the canvas gave up no pixels");

  const bars = barHeights(r.cols);
  // Sampled well clear of both ends: the first and last bar of the shape are
  // partly the canvas edge, and the halfway point is where the two passages
  // meet inside a single bar.
  const n = bars.length;
  const steady = bars.slice(Math.round(n * 0.10), Math.round(n * 0.40));
  const sparse = bars.slice(Math.round(n * 0.60), Math.round(n * 0.90));
  const a = median(steady), b = median(sparse);

  await t.test("both passages actually drew something to compare", () => {
    assert.ok(a > 4, "the steady passage drew " + a + "px bars — nothing to measure");
    assert.ok(b > 4, "the sparse passage drew " + b + "px bars — nothing to measure");
  });

  await t.test("a sparse loud passage draws the same height as a steady one at its level", () => {
    const ratio = b / a;
    assert.ok(Math.abs(ratio - 1) <= 0.2,
      "the steady half draws " + a + "px and the sparse half " + b + "px (ratio " +
      ratio.toFixed(2) + "). At 2.0 the browser is folding by MAXIMUM, which draws " +
      "a limited record as a brick; at 0.5 it is folding by MEAN, which erases " +
      "every transient. Both are the same audio and both should be " + a + "px.");
  });

  await t.test("and the picture has real range in it, not one height everywhere", () => {
    // The other half of the same claim: equal is only meaningful if unequal
    // audio draws unequal. The fixture's silence between spikes is folded into
    // its bar, so this looks at the SHORTEST bar against the tallest.
    const lo = Math.min(...bars.slice(2, n - 2)), hi = Math.max(...bars);
    assert.ok(hi >= lo * 1.5,
      "every bar came out between " + lo + " and " + hi + "px — the shape is flat");
  });
});

test("THE other one: the shape sits under the playhead, at every point in the track",
     async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  /*
   * A 10% SILENT NOTCH centred at 90% of the track, with the track paused at
   * exactly 90%. The notch is where the thumb is, so its centre and the thumb's
   * centre are the same number — that is the whole assertion.
   *
   * 90% rather than the middle for the reason in the header: the error is
   * thumbW * (0.5 - frac), which is ZERO halfway through. A test written at the
   * midpoint passes against both mappings and says nothing.
   *
   * The thumb's own position is the browser's, computed here from the rule the
   * screenshot test in waveform.test.js checks against real thumb pixels
   * ("the thumb is at x=… but Ns of Ms is x=…"). This test does not re-derive
   * that rule; it holds the CANVAS to it.
   */
  const AT = 0.9;
  const peaks = new Array(4000).fill(255);
  for (let i = 3400; i < 3800; i++) peaks[i] = 0;   // centred on bucket 3600 = 90%

  const r = harness.renderPage({
    name: "wf-map", windowSize: "390x844",
    stub: stub(zone(LENGTH * AT), b64(peaks)), driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.wave_hidden, false, "no waveform was drawn, so there is nothing to place");

  const g = r.geom;
  const bars = barHeights(r.cols);
  /*
   * A silent bucket still draws the 1px floor, so the notch is "shorter than
   * anything the loud track draws", not "empty".
   *
   * The LONGEST such run, because it is not the only one: the shape is inset to
   * the thumb's travel, which leaves half a thumb of untouched canvas at each
   * end. Those margins are the fix itself, seen from the side — and they are
   * seven pixels against the notch's thirty-five, so the longest run is the
   * notch by a wide margin.
   */
  const runs = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i] > 3) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else runs.push({ start: i, end: i });
  }
  runs.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const notch = runs[0] || { start: 0, end: 0 };
  const notchW = notch.end - notch.start + 1;

  await t.test("the notch is on screen, and it is the width it was written to be", () => {
    assert.ok(runs.length, "no quiet columns at all — the fixture drew no notch");
    // 10% of the thumb's travel, in device pixels. A run of the wrong width is
    // not the notch, and the centre of something else is not worth comparing.
    const want = (g.seekW - g.thumb) * 0.1 * g.dpr;
    assert.ok(Math.abs(notchW - want) <= Math.max(6, want * 0.25),
      "the longest quiet run is " + notchW + " device px where the notch should be " +
      want.toFixed(1) + " — this is not the silence the fixture drew");
    // And it must beat the end margins clearly, or "longest" picked by luck.
    const second = runs[1] ? runs[1].end - runs[1].start + 1 : 0;
    assert.ok(notchW > second * 2,
      "the notch (" + notchW + "px) is not clearly the longest quiet run (next: " +
      second + "px)");
  });

  await t.test("THE one: the notch is centred on the thumb, not half a thumb off it", () => {
    // Device pixels back to page coordinates, in the frame they were read in.
    const centre = g.cssLeft + ((notch.start + notch.end + 1) / 2) / g.dpr;
    const frac = g.value / g.max;
    const expected = g.seekLeft + g.thumb / 2 + frac * (g.seekW - g.thumb);
    const off = centre - expected;
    assert.ok(Math.abs(off) <= 2,
      "the silence in the track is drawn at x=" + centre.toFixed(1) + " and the " +
      "playhead is at x=" + expected.toFixed(1) + " — " + off.toFixed(1) + "px apart. " +
      "The expected error from laying the bars across the whole canvas instead of " +
      "the thumb's travel is " + (g.thumb * (0.5 - frac)).toFixed(1) + "px here, so " +
      "the shape does not line up with what you can hear.");
  });

  await t.test("the thumb token really is declared, so the maths above is not a default", () => {
    assert.ok(g.thumb >= 8 && g.thumb <= 32,
      "--seek-thumb read back as " + g.thumb + "px — the canvas and the stylesheet " +
      "are no longer agreeing on one number");
  });
});

test("the taller shape does not push the transport off a small phone", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  /*
   * The waveform went from 34px to 64, which is 30px the Now playing screen did
   * not have to find before. That screen is built to fit without scrolling, and
   * the control it would push off the bottom is the transport — the play button.
   *
   * MEASURED, IT ABSORBS IT: the transport's bottom edge is at the same y with
   * the canvas at 34px and at 64, and still on screen with it at 300 — the
   * space comes out of the flexible middle of the panel rather than off the end.
   * So this is a GUARD rather than a discovery: it fails the day a change makes
   * the panel stop absorbing it, which is the day the play button goes missing
   * on the smallest phone this is opened on.
   *
   * 360x640 with a full-scale shape is that worst case: the smallest common
   * screen, and the tallest the canvas ever draws.
   */
  const r = harness.renderPage({
    name: "wf-fits", windowSize: "360x640",
    stub: stub(zone(0), b64(new Array(4000).fill(255))), driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.wave_hidden, false, "no waveform was drawn, so nothing was pushed anywhere");

  await t.test("the transport is still on the screen with the shape showing", () => {
    assert.ok(r.fits, "the transport row was not found at all");
    assert.ok(r.fits.rowBottom <= r.fits.vh,
      "the play button's row ends at y=" + r.fits.rowBottom + " on a " + r.fits.vh +
      "px screen — the waveform's height has pushed the transport off the bottom");
  });
});
