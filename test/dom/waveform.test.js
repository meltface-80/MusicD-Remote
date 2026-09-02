"use strict";
// ---------------------------------------------------------------------------
// v1.7.90: the waveform on the Now playing progress bar.
//
// The thing worth pinning is not that a canvas draws — it is that the bar
// SURVIVES every way this can fail, because it fails routinely and by design:
//
//   * a Qobuz or TIDAL track has no audio any extension can reach, so there is
//     no waveform and never will be
//   * the setting is off by default
//   * a file can be undecodable, or the server busy with another track
//
// In all of those the progress bar has to be exactly the control it was before
// this feature existed — draggable, keyboard-operable, showing elapsed. The
// canvas is decoration UNDER it, and a decoration that breaks the control it
// decorates is worse than no decoration.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: {
    three_line: { line1: "Sunday", line2: "David Bowie", line3: "Heathen" },
    line1: "Sunday", line2: "David Bowie", line3: "Heathen",
    image_key: "k", length: 285, seek_position: 40,
  },
};

// 200 peaks: a quiet first half, a loud second.
const PEAKS = Buffer.from(
  Array.from({ length: 200 }, (_, i) => (i < 100 ? 20 : 240))
).toString("base64");

const stub = (opts) => `
window.__wfCalls = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/settings/waveform") > -1)
    return window.__json({ enabled: ${opts.enabled}, decoder: true });
  if (u.indexOf("/api/waveform") > -1) {
    window.__wfCalls.push(u);
    return window.__json(${JSON.stringify(opts.answer)});
  }
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
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

// Open Now playing from the mini transport and report the bar's state.
const DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(1600);

  var wave = document.getElementById("np-wave");
  var seek = document.getElementById("np-seek");
  var prog = document.querySelector(".np-progress");
  T("wave_exists", !!wave);
  T("wave_hidden", !wave || wave.classList.contains("hidden"));
  T("has_wave_class", !!prog && prog.classList.contains("has-wave"));
  T("calls", window.__wfCalls.length);
  T("call_url", window.__wfCalls[0] || "");

  // The control itself, in every case.
  var sb = seek.getBoundingClientRect();
  T("seek", {
    exists: !!seek, tag: seek.tagName, type: seek.type,
    max: seek.max, disabled: seek.disabled,
    w: Math.round(sb.width), h: Math.round(sb.height),
    // What a tap in the middle of the bar actually lands on. A canvas that
    // swallowed this would leave the bar looking draggable and not being it.
    hit: (function () {
      var el = document.elementFromPoint(sb.left + sb.width / 2, sb.top + sb.height / 2);
      return el === seek ? "seek" : (el && (el.id || el.className)) || "nothing";
    })(),
  });
  // Geometry for the pixel check below. The canvas and the input occupy the
  // same box, so layout alone cannot say which of them is on top.
  var wb = wave ? wave.getBoundingClientRect() : null;
  T("boxes", {
    seek: { x: sb.left, y: sb.top, w: sb.width, h: sb.height },
    wave: wb ? { x: wb.left, y: wb.top, w: wb.width, h: wb.height } : null,
    value: Number(seek.value), max: Number(seek.max),
    dpr: window.devicePixelRatio || 1,
  });
  T("tokens", (function () {
    var cs = getComputedStyle(document.documentElement);
    return { text: cs.getPropertyValue("--text").trim(),
             accent: cs.getPropertyValue("--accent").trim(),
             bg: cs.getPropertyValue("--bg").trim() };
  })());
  // Which of the two won for the range's own 4px track: paintSeek writes this
  // INLINE (so it beats the stylesheet) and must remove it while a waveform is
  // showing. The pixel test proves the outcome; this names the mechanism, so a
  // failure says which half broke.
  T("seek_fill", getComputedStyle(seek).getPropertyValue("--seek-fill").trim());
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
`;

test("with a waveform, the bar gains a shape and loses nothing", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "wf-on", windowSize: "390x844",
    stub: stub({ enabled: true, answer: { peaks: PEAKS, n: 200, cached: true } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it asked for the track that is playing", () => {
    assert.ok(r.calls >= 1, "no waveform was requested at all");
    assert.match(r.call_url, /track=Sunday/);
    assert.match(r.call_url, /album=Heathen/);
    // The album is what resolves a local file: the server matches album+artist
    // to a /music directory and only then looks for the track inside it.
    assert.match(r.call_url, /artist=David(\+|%20)Bowie/);
  });

  await t.test("the canvas is shown and actually drew something", () => {
    assert.equal(r.wave_exists, true, "#np-wave is missing from the markup");
    assert.equal(r.wave_hidden, false, "the canvas stayed hidden with peaks in hand");
    assert.equal(r.has_wave_class, true, "the progress row was not put into waveform mode");
    assert.ok(r.painted > 0,
      `the canvas has ${r.painted} opaque pixels — it is shown but blank`);
  });

  await t.test("THE one: the seek control is untouched", () => {
    // Everything the bar could do before, it still does. A waveform that costs
    // the user the ability to scrub is a bad trade at any price.
    assert.equal(r.seek.tag, "INPUT");
    assert.equal(r.seek.type, "range");
    assert.equal(r.seek.disabled, false, "the bar became undraggable");
    assert.equal(r.seek.max, "285", "the range lost the track's length");
    assert.ok(r.seek.w > 100, `the seek input collapsed to ${r.seek.w}px wide`);
    assert.equal(r.seek.hit, "seek",
      `a tap in the middle of the bar lands on "${r.seek.hit}" — the canvas is ` +
      `over the control instead of under it`);
  });

  await t.test("and the canvas is inert to pointers and to screen readers", () => {
    assert.equal(r.canvas_pointer_events, "none");
    assert.equal(r.canvas_aria_hidden, "true",
      "the decorative canvas is announced to assistive technology");
  });

  await t.test("the range's own track is switched off", () => {
    assert.equal(r.seek_fill, "transparent",
      `--seek-fill is "${r.seek_fill}" — the 4px track is still being painted, ` +
      `and it lands exactly on the waveform's midline`);
  });

  await t.test("the draggable area covers the whole shape", () => {
    // The input is grown to the canvas's height so the waveform is grabbable
    // anywhere, not only along the 4px line the plain bar occupies.
    const { seek, wave } = r.boxes;
    assert.ok(wave, "no canvas box was reported");
    assert.ok(Math.abs(seek.y - wave.y) <= 1 && Math.abs(seek.h - wave.h) <= 1,
      `the seek input is ${seek.h}px at y=${seek.y} but the waveform is ` +
      `${wave.h}px at y=${wave.y} — part of the shape is not draggable`);
  });
});

test("the thumb rides ON the waveform, not above or below it", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // THE assertion layout cannot make, and the one that pays for the screenshot
  // machinery. The canvas is positioned against .np-progress while the input
  // sits in flow below the UA's 2px margin, so the shape and the thumb that is
  // supposed to ride along it can be drawn on different lines — and both
  // elements report boxes that look right, because the boxes ARE right. Only
  // the pixels disagree.
  //
  // EVERY MEASUREMENT HERE COMES OUT OF THE SAME SCREENSHOT. Comparing a
  // getBoundingClientRect taken by the driver against a pixel from the shot is
  // meaningless: --screenshot fires when the virtual time budget expires, and
  // the page has moved by then (8.5px, in this fixture). An earlier draft of
  // this test did exactly that and reported a misalignment that did not exist.
  //
  // TWO THINGS THE FIXTURE HAS TO GET RIGHT, both learned from a surviving
  // mutant: the waveform is at FULL SCALE so the bars actually reach the thumb
  // (a canvas is transparent between its bars, and over a quiet passage
  // anything looks aligned), and the zone is PAUSED so the playhead does not
  // walk away between the driver and the shot.
  const LOUD = Buffer.from(Array.from({ length: 200 }, () => 255)).toString("base64");
  const MID = JSON.parse(JSON.stringify(ZONE));
  MID.now_playing.seek_position = 140;   // ~49% of 285s: mid-bar, clear of both ends
  MID.state = "paused";

  const r = harness.renderPage({
    name: "wf-thumb", windowSize: "390x844", screenshot: true,
    stub: stub({ enabled: true, answer: { peaks: LOUD, n: 200, cached: true } })
            .replace(JSON.stringify(ZONE), JSON.stringify(MID)),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.wave_hidden, false, "no waveform was showing, so there is no shape to ride");

  const { decodePng, pixel } = require("../../lib/png");
  const img = decodePng(r.__png);
  const { seek, wave, value, max, dpr } = r.boxes;
  assert.ok(value > 0, "the playhead never left the start");

  // Colours read from the PAGE, not assumed: this suite renders whichever
  // palette the browser defaults to, and two of the four are a near-black thumb
  // on a near-white ground.
  const hex = (h) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim());
    assert.ok(m, `a colour token came back as "${h}", which is not hex`);
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  };
  const want = hex(r.tokens.text);
  const isThumb = (px) => Math.abs(px[0] - want[0]) <= 12 &&
                          Math.abs(px[1] - want[1]) <= 12 &&
                          Math.abs(px[2] - want[2]) <= 12;
  // The played bars are --accent at .95 over the ground; "blue-dominant" picks
  // them out of any of the four palettes without pinning an exact value.
  const acc = hex(r.tokens.accent);
  const isBar = (px) => Math.abs(px[0] - acc[0]) <= 60 &&
                        Math.abs(px[1] - acc[1]) <= 60 &&
                        Math.abs(px[2] - acc[2]) <= 60;

  // A band generous enough that a thumb drawn OUTSIDE the shape is still found
  // and reported, rather than missed and called absent.
  const y0 = Math.floor(wave.y) - 25, y1 = Math.ceil(wave.y + wave.h) + 25;
  const scan = (hit, x0, x1) => {
    let lo = Infinity, hi = -Infinity, n = 0, xlo = Infinity, xhi = -Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!hit(pixel(img, x * dpr, y * dpr))) continue;
        n++;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
        if (x < xlo) xlo = x;
        if (x > xhi) xhi = x;
      }
    }
    return { n, lo, hi, xlo, xhi, mid: (lo + hi) / 2, w: xhi - xlo + 1 };
  };

  // The thumb is the only --text-coloured mark inside the bar's own width.
  const thumb = scan(isThumb, Math.floor(seek.x), Math.ceil(seek.x + seek.w));
  // The bars are sampled well to the LEFT of the thumb, so its own pixels
  // cannot contribute to where the shape's midline is measured.
  const expected = seek.x + 7 + (value / max) * (seek.w - 14);
  const bars = scan(isBar, Math.floor(seek.x) + 4, Math.round(expected) - 20);

  await t.test("both the shape and the thumb are actually on the screen", () => {
    assert.ok(bars.n > 200, `only ${bars.n} waveform pixels found — nothing was drawn`);
    assert.ok(thumb.n > 60, `only ${thumb.n} pixels of ${r.tokens.text} (the thumb) found`);
    assert.ok(thumb.w >= 10 && thumb.w <= 18,
      `the mark found is ${thumb.w}px across — that is not the 14px thumb`);
    assert.ok(Math.abs((thumb.xlo + thumb.xhi) / 2 - expected) <= 4,
      `the thumb is at x=${(thumb.xlo + thumb.xhi) / 2} but ${value}s of ${max}s ` +
      `is x=${expected.toFixed(1)}`);
  });

  await t.test("THE one: they are on the same line", () => {
    assert.ok(Math.abs(thumb.mid - bars.mid) <= 1,
      `the waveform's midline is at y=${bars.mid} and the thumb's centre at ` +
      `y=${thumb.mid} — the thumb rides ${Math.abs(thumb.mid - bars.mid).toFixed(1)}px ` +
      `off the shape it is meant to be on`);
  });

  await t.test("and the shape is not drawn across the thumb", () => {
    // Inside the disc at r=4 rather than 7, so the antialiased rim is not
    // counted as a foreign colour.
    const cx = (thumb.xlo + thumb.xhi) / 2, cy = thumb.mid;
    let solid = 0, foreign = 0;
    for (let y = Math.round(cy) - 4; y <= Math.round(cy) + 4; y++) {
      for (let x = Math.round(cx) - 4; x <= Math.round(cx) + 4; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > 16) continue;
        if (isThumb(pixel(img, x * dpr, y * dpr))) solid++; else foreign++;
      }
    }
    assert.ok(solid > 20, `the thumb has only ${solid} of its own pixels left`);
    assert.equal(foreign, 0,
      `${foreign} pixels inside the thumb are not the thumb — the waveform's bars ` +
      `are being drawn across it, so the one control on this screen looks faulty`);
  });
});

test("a streaming track keeps the plain bar", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The server answers no-local-file for anything Roon streams. This is the
  // COMMON case for a mixed library, not an edge one.
  const r = harness.renderPage({
    name: "wf-streaming", windowSize: "390x844",
    stub: stub({ enabled: true, answer: { peaks: null, reason: "no-local-file" } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("nothing is drawn", () => {
    assert.equal(r.wave_hidden, true,
      "a track with no waveform still showed the canvas — it would be blank or stale");
    assert.equal(r.has_wave_class, false);
  });

  await t.test("and the bar is exactly what it was", () => {
    assert.equal(r.seek.disabled, false);
    assert.equal(r.seek.max, "285");
    assert.equal(r.seek.hit, "seek");
    // THE fill, not just the control. Switching the track off is right only
    // while a waveform is showing; doing it here would leave every streaming
    // track — most of a mixed library — with no progress indication at all.
    assert.match(r.seek_fill, /gradient/,
      `--seek-fill is "${r.seek_fill}" — the plain bar lost its elapsed fill`);
  });
});

test("with the setting off, nothing is even asked for", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Off is the default, so this is what almost every install looks like. It has
  // to cost nothing: no canvas, and no request per track either.
  const r = harness.renderPage({
    name: "wf-off", windowSize: "390x844",
    stub: stub({ enabled: false, answer: { peaks: null, reason: "off" } }),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("no waveform request is made", () => {
    assert.equal(r.calls, 0,
      `${r.calls} waveform requests were made with the feature switched off`);
  });

  await t.test("the canvas stays hidden and the bar is untouched", () => {
    assert.equal(r.wave_hidden, true);
    assert.equal(r.has_wave_class, false);
    assert.equal(r.seek.disabled, false);
    assert.equal(r.seek.hit, "seek");
  });
});

test("a waveform that arrives after the track changed is dropped", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Decoding takes seconds; a skip takes none. The answer for the track you
  // WERE on must not be painted under the one you are on now — it looks
  // authoritative and it is simply a different song's shape.
  //
  // THE TRICK THAT MAKES THIS TEST MEAN ANYTHING: the two tracks get DIFFERENT
  // answers. The first is slow and has peaks; the second replies at once with
  // none (it is a streaming track — the common case). So after the skip there
  // is exactly one waveform in the world that could be painted, and it is the
  // stale one. An earlier version of this test answered both requests with the
  // same peaks and asserted "the canvas is hidden" — which the SECOND, entirely
  // correct answer also failed, so it went red on a healthy build and could
  // never have told the two apart.
  const OTHER = JSON.parse(JSON.stringify(ZONE));
  OTHER.now_playing.three_line = { line1: "Slip Away", line2: "David Bowie", line3: "Heathen" };
  OTHER.now_playing.line1 = "Slip Away";

  const r = harness.renderPage({
    name: "wf-stale", windowSize: "390x844", budgetMs: 30000,
    stub: `
      window.__zone = ${JSON.stringify(ZONE)};
      window.__wfCalls = [];
      try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
      window.__installFetch(function (u) {
        if (u.indexOf("/api/settings/waveform") > -1)
          return window.__json({ enabled: true, decoder: true });
        if (u.indexOf("/api/waveform") > -1) {
          window.__wfCalls.push(u);
          // The track we skip AWAY from: slow, like a real decode, and it has a
          // shape. It is still in flight when the skip happens.
          if (u.indexOf("Sunday") > -1) {
            return new Promise(function (res) {
              setTimeout(function () {
                res(new Response(JSON.stringify({ peaks: ${JSON.stringify(PEAKS)}, n: 200 }),
                  { status: 200, headers: { "Content-Type": "application/json" } }));
              }, 2500);
            });
          }
          // The track we skip TO: no local file, answered immediately. Nothing
          // legitimate can put a waveform on screen from here on.
          return window.__json({ peaks: null, reason: "no-local-file" });
        }
        if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
        if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
        if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
        if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
        if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
        if (u.indexOf("/api/settings") > -1)   return window.__json({});
        if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
        if (u.indexOf("/api/random-albums") > -1)
          return window.__json({ albums: [], total: 0, filtered: false });
        return undefined;
      });
    `,
    driver: `
      await window.__sleep(700);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(900);
      T("asked_for_first", (window.__wfCalls[0] || "").indexOf("Sunday") > -1);

      // Skip, while the first request is still out.
      window.__zone = ${JSON.stringify(OTHER)};
      await window.__sleep(1200);
      T("track_now", (document.getElementById("np-track") || {}).textContent || "");
      T("asked_for_second", window.__wfCalls.some(function (u) {
        return u.indexOf("Slip") > -1;
      }));

      // Let the FIRST (now stale) answer land.
      await window.__sleep(3000);
      var wave = document.getElementById("np-wave");
      var prog = document.querySelector(".np-progress");
      T("stale_painted", !wave.classList.contains("hidden"));
      T("stale_has_wave_class", !!prog && prog.classList.contains("has-wave"));
      T("calls", window.__wfCalls.length);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the skip happened while the first request was out", () => {
    assert.equal(r.asked_for_first, true, "the first request was not for the first track");
    assert.match(String(r.track_now), /Slip Away/, "the screen did not follow the skip");
    assert.equal(r.asked_for_second, true,
      "no waveform was requested for the track skipped to — the identity check is " +
      "not noticing track changes at all, which makes the rest of this vacuous");
  });

  await t.test("the stale waveform is not drawn under the new track", () => {
    assert.equal(r.stale_painted, false,
      "the first track's waveform was painted under the second — it is the wrong " +
      "shape for what is playing, and it looks authoritative");
    assert.equal(r.stale_has_wave_class, false,
      "the progress row stayed in waveform mode with no waveform to show");
  });
});

test("switching the setting off mid-decode drops the answer that is already out", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The other half of the same guard, and the only case that isolates it. A
  // track SKIP bumps both the generation and the key, so either check alone
  // catches it; turning the switch off does not bump the generation at all —
  // it only blanks the key — so this is what makes `npWaveKey !== id.key` earn
  // its place rather than being a second spelling of the line beside it.
  //
  // Asserted as "never visible, not once", sampled every 50ms, because the
  // 1500ms poll would itself clear a stale waveform on its next pass: a check
  // taken only at the end would watch the bug repair itself and call it a pass.
  const r = harness.renderPage({
    name: "wf-off-mid", windowSize: "390x844", budgetMs: 30000,
    stub: `
      window.__wfOn = true;
      window.__wfCalls = [];
      try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
      window.__installFetch(function (u, opts) {
        if (u.indexOf("/api/settings/waveform") > -1) {
          if (opts && opts.method === "POST") {
            window.__wfOn = !!JSON.parse(opts.body).enabled;
            return window.__json({ enabled: window.__wfOn });
          }
          return window.__json({ enabled: window.__wfOn, decoder: true });
        }
        if (u.indexOf("/api/waveform") > -1) {
          window.__wfCalls.push(u);
          // Slower than the user takes to reach the switch.
          return new Promise(function (res) {
            setTimeout(function () {
              res(new Response(JSON.stringify({ peaks: ${JSON.stringify(PEAKS)}, n: 200 }),
                { status: 200, headers: { "Content-Type": "application/json" } }));
            }, 3000);
          });
        }
        if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
        if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
        if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
        if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
        if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
        if (u.indexOf("/api/settings") > -1)   return window.__json({});
        if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
        if (u.indexOf("/api/random-albums") > -1)
          return window.__json({ albums: [], total: 0, filtered: false });
        return undefined;
      });
    `,
    driver: `
      await window.__sleep(700);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(800);
      T("asked", window.__wfCalls.length);

      var wave = document.getElementById("np-wave");
      // Watch continuously from here: a flash counts as a failure.
      var everShown = false;
      var watcher = setInterval(function () {
        if (wave && !wave.classList.contains("hidden")) everShown = true;
      }, 50);

      // Flip the switch off through its real handler while the decode is out.
      var sw = document.getElementById("waveform-enabled");
      T("switch_exists", !!sw);
      sw.checked = false;
      sw.dispatchEvent(new Event("change"));
      await window.__sleep(700);
      T("flag_off", window.__waveformOn === false);
      T("server_off", window.__wfOn === false);

      // Let the answer that was already in flight come back.
      await window.__sleep(4000);
      clearInterval(watcher);
      T("ever_shown", everShown);
      T("hidden_at_end", wave.classList.contains("hidden"));
      T("calls", window.__wfCalls.length);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the decode really was in flight when the switch was thrown", () => {
    assert.equal(r.switch_exists, true, "#waveform-enabled is missing from Settings");
    assert.equal(r.asked, 1, `${r.asked} waveform requests before the switch was thrown`);
    assert.equal(r.flag_off, true, "the switch did not turn the feature off in the page");
    assert.equal(r.server_off, true, "the switch never reached the server");
  });

  await t.test("and the waveform never appears", () => {
    assert.equal(r.ever_shown, false,
      "a waveform was painted after the feature was switched off — the request " +
      "was already out, and its answer landed anyway");
    assert.equal(r.hidden_at_end, true);
    assert.equal(r.calls, 1,
      `${r.calls} waveform requests — switching off must stop asking, not just stop drawing`);
  });
});

test("a 'busy' answer is retried, not taken as the final word", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The server decodes one track at a time, so a second asker gets
  // {peaks: null, reason: "busy"} — and this app is REGULARLY two askers: a
  // phone and the wall display pointed at the same zone. The client latches a
  // track's key the moment it asks, so treating "busy" like "no waveform" left
  // that track showing a plain bar for its whole length even though the server
  // was free a second later.
  const r = harness.renderPage({
    name: "wf-busy", windowSize: "390x844", budgetMs: 25000,
    stub: `
      window.__wfCalls = [];
      try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
      window.__installFetch(function (u) {
        if (u.indexOf("/api/settings/waveform") > -1)
          return window.__json({ enabled: true, decoder: true });
        if (u.indexOf("/api/waveform") > -1) {
          window.__wfCalls.push(u);
          // Busy for the first two asks, then the real answer.
          if (window.__wfCalls.length <= 2)
            return window.__json({ peaks: null, reason: "busy" });
          return window.__json({ peaks: ${JSON.stringify(PEAKS)}, n: 200 });
        }
        if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
        if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
        if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
        if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
        if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
        if (u.indexOf("/api/settings") > -1)   return window.__json({});
        if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
        if (u.indexOf("/api/random-albums") > -1)
          return window.__json({ albums: [], total: 0, filtered: false });
        return undefined;
      });
    `,
    driver: `
      await window.__sleep(700);
      var bar = document.getElementById("mini-transport");
      for (var i = 0; i < 40 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(900);
      T("after_busy", {
        calls: window.__wfCalls.length,
        hidden: document.getElementById("np-wave").classList.contains("hidden"),
      });
      // Three polls at 1.5s is ample for the two busy answers to be re-asked.
      await window.__sleep(6000);
      var wave = document.getElementById("np-wave");
      T("calls", window.__wfCalls.length);
      T("hidden", wave.classList.contains("hidden"));
      T("has_wave_class",
        document.querySelector(".np-progress").classList.contains("has-wave"));
      // The track never changed, so every request must be for the same track:
      // a retry, not the key being churned by something else.
      T("all_same_track", window.__wfCalls.every(function (u) {
        return u.indexOf("track=Sunday") > -1;
      }));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("busy really was the first answer, and nothing was drawn for it", () => {
    assert.ok(r.after_busy.calls >= 1, "no waveform was requested at all");
    assert.equal(r.after_busy.hidden, true,
      "something was drawn from a busy answer, which carries no peaks");
  });

  await t.test("it asked again, and the waveform arrives", () => {
    assert.ok(r.calls >= 3,
      `only ${r.calls} requests after two busy answers — the track was latched ` +
      `to no waveform for the rest of its play`);
    assert.equal(r.all_same_track, true, "the retries were for a different track");
    assert.equal(r.hidden, false,
      "the waveform never appeared even though the server stopped being busy");
    assert.equal(r.has_wave_class, true);
  });
});

test("THE one for v1.7.91: the range's own track is not drawn through the shape", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Reported on a phone: the waveform drew, and a grey line ran edge to edge
  // through the middle of it with the played part in blue — the range input's
  // own 4px track, sitting exactly where the waveform's midline is.
  //
  // The stylesheet had `--seek-fill: transparent` for this case and it did
  // nothing, because paintSeek writes that property INLINE four times a second
  // and an inline custom property beats a stylesheet rule however specific.
  // Nothing in the DOM says which of the two won, so this is a pixel test.
  //
  // HOW IT TELLS A LINE FROM THE WAVEFORM, given both sit on the same midline:
  // the fixture is SILENT for its second half, where the bars are the 1px floor
  // drawn 2px on / 1px off. Nothing the canvas draws there can be continuous,
  // so the longest unbroken horizontal run separates the two outright — 156px
  // (the full width) with the line, single digits without it.
  const HALF = Buffer.from(
    Array.from({ length: 200 }, (_, i) => (i < 80 ? 255 : 0))
  ).toString("base64");
  const EARLY = JSON.parse(JSON.stringify(ZONE));
  EARLY.now_playing.seek_position = 10;   // barely started, like the report
  EARLY.state = "paused";                 // so the playhead cannot walk off

  const r = harness.renderPage({
    name: "wf-no-track", windowSize: "390x844", screenshot: true,
    stub: stub({ enabled: true, answer: { peaks: HALF, n: 200 } })
            .replace(JSON.stringify(ZONE), JSON.stringify(EARLY)),
    driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.wave_hidden, false, "no waveform was showing, so there is nothing to draw through");

  const { decodePng, pixel } = require("../../lib/png");
  const img = decodePng(r.__png);
  const { seek, dpr } = r.boxes;
  const hex = (h) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim());
    assert.ok(m, `--bg came back as "${h}", which is not a hex colour`);
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  };
  const bg = hex(r.tokens.bg);
  const ink = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 12;

  // The bars' own rows, found in THIS image from the loud half: a bar row is
  // ~2/3 covered (2px on, 1px off), while the times underneath are sparse text.
  // Taken by coverage rather than by extent so a label below cannot widen the
  // band being searched.
  const lx0 = Math.floor(seek.x) + 10, lx1 = Math.floor(seek.x + seek.w * 0.35);
  const rows = [];
  for (let y = Math.floor(seek.y) - 30; y <= Math.ceil(seek.y + seek.h) + 30; y++) {
    let n = 0;
    for (let x = lx0; x < lx1; x++) if (ink(pixel(img, x * dpr, y * dpr))) n++;
    if (n > (lx1 - lx0) * 0.4) rows.push(y);
  }

  // The silent half, well clear of the loud/quiet boundary and the bar's ends.
  const sx0 = Math.floor(seek.x + seek.w * 0.55), sx1 = Math.ceil(seek.x + seek.w) - 4;
  let longest = 0, atRow = -1;
  for (const y of rows) {
    let run = 0;
    for (let x = sx0; x < sx1; x++) {
      if (ink(pixel(img, x * dpr, y * dpr))) {
        if (++run > longest) { longest = run; atRow = y; }
      } else run = 0;
    }
  }

  await t.test("the fixture really did draw a waveform to look through", () => {
    assert.ok(rows.length >= 8,
      `only ${rows.length} rows of waveform found — the shape is not there to test against`);
  });

  await t.test("nothing continuous is drawn across the silent half", () => {
    assert.ok(longest <= 16,
      `a solid ${longest}px line runs across the waveform at y=${atRow} (the silent ` +
      `stretch is ${sx1 - sx0}px wide, and the canvas can only draw 2px dashes ` +
      `there) — the seek input's own track is being painted through the shape`);
  });
});
