"use strict";
// ---------------------------------------------------------------------------
// v1.7.90: the waveform on the WALL DISPLAY's bottom strip.
//
// The display is a different page with its own HTML, CSS and JS, and it has a
// constraint the phone does not: the strip is the ONLY thing on the screen that
// says how far through the track you are. There is no seek input to fall back
// on and nobody standing at the wall to poke it. So the two states that matter
// are:
//
//   * a waveform arrived  → the shape replaces the plain fill, not sits on it.
//     `.bb-track.has-wave .bb-fill { display: none }` — a 4px white bar drawn
//     through the middle of a 40px waveform is a scratch across it.
//   * no waveform (which is EVERY Qobuz and TIDAL track, i.e. most libraries)
//     → the plain fill is exactly the strip it has always been, and moving.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Kitchen", state: "playing",
  outputs: [{ output_id: "o1", display_name: "Kitchen" }],
  now_playing: {
    three_line: { line1: "Sunday", line2: "David Bowie", line3: "Heathen" },
    line1: "Sunday", line2: "David Bowie", line3: "Heathen",
    image_key: "k", length: 285, seek_position: 60,
  },
};

const PEAKS = Buffer.from(
  Array.from({ length: 200 }, (_, i) => (i < 100 ? 20 : 240))
).toString("base64");

const stub = (opts) => `
window.__wfCalls = [];
window.__installFetch(function (u) {
  if (u.indexOf("/api/settings/waveform") > -1)
    return window.__json({ enabled: ${opts.enabled}, decoder: true });
  if (u.indexOf("/api/waveform") > -1) {
    window.__wfCalls.push(u);
    return window.__json(${JSON.stringify(opts.answer)});
  }
  if (u.indexOf("/api/settings/display") > -1)
    return window.__json({ enabled: true, seconds: 20 });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (u.indexOf("/api/display/content") > -1)
    return window.__json({ art: [], photos: [], review: null, bio: null, grids: [] });
  return undefined;
});
`;

const DRIVER = `
  // The display boots on its own timers: checkSettings, then tick, then a
  // paintProgress every 250ms. Wait for the strip rather than a fixed delay.
  var bar = document.getElementById("bottombar");
  for (var i = 0; i < 60 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
  await window.__sleep(1200);

  var wave  = document.getElementById("bb-wave");
  var fill  = document.getElementById("bb-fill");
  var track = document.querySelector(".bb-track");

  T("bar_shown", !bar.classList.contains("hidden"));
  T("wave_exists", !!wave);
  T("wave_hidden", !wave || wave.classList.contains("hidden"));
  T("has_wave_class", !!track && track.classList.contains("has-wave"));
  T("calls", window.__wfCalls.length);
  T("call_url", window.__wfCalls[0] || "");
  T("title", (document.getElementById("bb-title") || {}).textContent || "");

  // The plain fill: is it on screen, and has it moved off zero?
  var fs = fill ? getComputedStyle(fill) : null;
  var fr = fill ? fill.getBoundingClientRect() : { width: 0, height: 0 };
  T("fill", {
    display: fs ? fs.display : "",
    styleWidth: fill ? fill.style.width : "",
    w: Math.round(fr.width), h: Math.round(fr.height),
  });
  T("track_h", track ? Math.round(track.getBoundingClientRect().height) : 0);
  T("canvas_pointer_events", wave ? getComputedStyle(wave).pointerEvents : "");
  T("canvas_aria_hidden", wave ? wave.getAttribute("aria-hidden") : "");
  T("painted", (function () {
    if (!wave || wave.classList.contains("hidden")) return 0;
    try {
      var c = wave.getContext("2d");
      var d = c.getImageData(0, 0, wave.width, wave.height).data;
      var n = 0;
      for (var k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
      return n;
    } catch (e) { return -1; }
  })());
  // Left third vs right third of the canvas. The fixture is quiet then loud,
  // so a waveform that is actually the TRACK's shape is lopsided; one that is
  // a placeholder, a flat bar or a stretched single value is not.
  T("halves", (function () {
    if (!wave || wave.classList.contains("hidden")) return null;
    try {
      var c = wave.getContext("2d");
      function ink(x0, x1) {
        var d = c.getImageData(x0, 0, x1 - x0, wave.height).data, n = 0;
        for (var k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
        return n;
      }
      var third = Math.floor(wave.width / 3);
      return { left: ink(0, third), right: ink(wave.width - third, wave.width) };
    } catch (e) { return null; }
  })());
`;

test("the wall display draws the waveform instead of the plain fill", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "wf-display", page: "display", windowSize: "1920x1080", budgetMs: 25000,
    stub: stub({ enabled: true, answer: { peaks: PEAKS, n: 200, cached: true } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the strip came up for the playing track", () => {
    assert.equal(r.bar_shown, true, "the bottom bar never appeared");
    assert.match(String(r.title), /Sunday/);
  });

  await t.test("it asked for the track, with the album and artist", () => {
    assert.ok(r.calls >= 1, "the display made no waveform request at all");
    assert.match(r.call_url, /track=Sunday/);
    assert.match(r.call_url, /album=Heathen/);
    assert.match(r.call_url, /artist=David(\+|%20)Bowie/);
  });

  await t.test("the canvas is shown and drew the track's actual shape", () => {
    assert.equal(r.wave_exists, true, "#bb-wave is missing from display.html");
    assert.equal(r.wave_hidden, false, "the canvas stayed hidden with peaks in hand");
    assert.equal(r.has_wave_class, true, "the strip was not put into waveform mode");
    assert.ok(r.painted > 0,
      `the canvas has ${r.painted} opaque pixels — it is shown but blank`);
    assert.ok(r.halves, "could not read the canvas back");
    assert.ok(r.halves.right > r.halves.left * 2,
      `the fixture is quiet for its first half and loud for its second, but the ` +
      `canvas has ${r.halves.left} lit pixels on the left and ${r.halves.right} on ` +
      `the right — that is not this track's shape`);
  });

  await t.test("THE one: the plain fill is out of the way, not drawn through it", () => {
    // Without this the 4px white bar runs straight across the middle of the
    // 40px waveform, and from across a room it reads as a scratch on the screen.
    assert.equal(r.fill.display, "none",
      "the plain fill is still displayed under the waveform");
    assert.ok(r.track_h > 20,
      `the strip is ${r.track_h}px tall — it never grew from the 4px line to a waveform`);
  });

  await t.test("and the canvas is inert to pointers and to screen readers", () => {
    assert.equal(r.canvas_pointer_events, "none");
    assert.equal(r.canvas_aria_hidden, "true");
  });
});

test("with no waveform the wall display keeps its plain progress strip", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Every Qobuz and TIDAL track lands here, so this is the display's normal
  // state for most libraries, not a corner of it.
  const r = harness.renderPage({
    name: "wf-display-plain", page: "display", windowSize: "1920x1080", budgetMs: 25000,
    stub: stub({ enabled: true, answer: { peaks: null, reason: "no-local-file" } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("nothing is drawn and the strip is not in waveform mode", () => {
    assert.equal(r.wave_hidden, true, "the canvas was shown with no peaks to draw");
    assert.equal(r.has_wave_class, false);
  });

  await t.test("the fill is visible and has moved off zero", () => {
    // 60s into a 285s track: about 21%. The exact number is the poll's
    // business; that it is neither hidden nor still at 0% is this test's.
    assert.notEqual(r.fill.display, "none", "the only progress indicator is hidden");
    assert.ok(r.fill.w > 0,
      `the fill is ${r.fill.w}px wide at 60s into a 285s track — the strip is dead`);
    assert.match(String(r.fill.styleWidth), /^[1-9]/,
      `the fill is at "${r.fill.styleWidth}" — it never left the start`);
  });
});

test("with the setting off the wall display asks for nothing", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Off is the default. A display polling every 2s must not turn that into a
  // waveform request per poll for a feature nobody switched on.
  const r = harness.renderPage({
    name: "wf-display-off", page: "display", windowSize: "1920x1080", budgetMs: 25000,
    stub: stub({ enabled: false, answer: { peaks: null, reason: "off" } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("no waveform request is made", () => {
    assert.equal(r.calls, 0,
      `${r.calls} waveform requests were made with the feature switched off`);
  });

  await t.test("and the plain strip is untouched", () => {
    assert.equal(r.wave_hidden, true);
    assert.equal(r.has_wave_class, false);
    assert.notEqual(r.fill.display, "none");
    assert.ok(r.fill.w > 0);
  });
});
