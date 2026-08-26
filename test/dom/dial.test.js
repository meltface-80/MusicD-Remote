"use strict";
// ---------------------------------------------------------------------------
// v1.7.72: the dial — a second installable page at /dial.
//
// It is a canvas, so almost nothing about it is inspectable the way a DOM
// screen is: there are no elements to query, no classes to assert, and a
// screenshot comparison would pin the artwork rather than the behaviour. What
// CAN be tested is the part that matters and the part most likely to break —
// the arithmetic between a gesture and the request it produces.
//
// The dial is ported from the Android build's DialView, and the numbers are
// deliberately shared: 320 degrees of rotation covers the output's full range,
// travel is quantised to the output's own `step`, and the fraction below a
// step is carried rather than rounded away. Those three are what make it feel
// like a knob instead of a slider, and all three are invisible until they are
// wrong.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// A 0-100 output stepping by 1, and a dB output stepping by 0.5 — the two
// shapes that behave differently under the same gesture.
function rig({ volume, softLimit, muted, state = "playing" } = {}) {
  const vol = volume === null ? null : Object.assign(
    { type: "number", min: 0, max: 100, step: 1, value: 40 }, volume,
    softLimit != null ? { soft_limit: softLimit } : {});
  return `
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u, opts) {
  if (opts && opts.method === "POST") {
    window.__posts.push({ url: String(u).split("?")[0], body: JSON.parse(opts.body) });
    return window.__json({ ok: true });
  }
  var z = { zone_id: "z1", display_name: "Kitchen", state: ${JSON.stringify(state)},
            outputs: [{ output_id: "o1", display_name: "Kitchen",
                        is_muted: ${muted ? "true" : "false"},
                        volume: ${vol === null ? "null" : JSON.stringify(vol)} }],
            now_playing: { line1: "So What", line2: "Miles Davis", line3: "Kind of Blue",
                           length: 545, seek_position: 30, image_key: "k" } };
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [z] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: z });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

// Sweeps the ring by `degrees`, in small increments, the way a thumb does.
// Starting at 12 o'clock and moving clockwise is a volume increase.
const SWEEP = `
  function ringPoint(deg) {
    var rect = c.getBoundingClientRect();
    var cx = rect.width / 2, cy = rect.height / 2;
    var radius = Math.min(rect.width, rect.height) / 2 - 8;
    var ringW = radius * 0.115;
    var r = radius - ringW / 2;
    var rad = (deg - 90) * Math.PI / 180;
    return { x: rect.left + cx + r * Math.cos(rad), y: rect.top + cy + r * Math.sin(rad) };
  }
  async function sweep(degrees) {
    var steps = Math.max(2, Math.round(Math.abs(degrees) / 4));
    var p = ringPoint(0);
    c.dispatchEvent(new PointerEvent("pointerdown",
      { clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true }));
    for (var i = 1; i <= steps; i++) {
      p = ringPoint(degrees * i / steps);
      c.dispatchEvent(new PointerEvent("pointermove",
        { clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true }));
    }
    c.dispatchEvent(new PointerEvent("pointerup",
      { clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true }));
    await window.__sleep(400);
  }
`;

const READY = `
  var c = document.getElementById("dial");
  await window.__sleep(600);
` + SWEEP;

function volumeOf(posts) {
  return posts.filter(p => p.url.indexOf("/api/volume") > -1);
}

test("the dial's ring turns rotation into volume steps", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  await t.test("a full sweep of 320 degrees covers the whole range", () => {
    const r = harness.renderPage({
      page: "dial.html", name: "dial-range", windowSize: "390x844",
      stub: rig(),
      driver: READY + `
        await sweep(320);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const steps = r.sent.reduce((n, b) => n + (b.relative_step || 0), 0);
    // 0-100 stepping by 1: 320 degrees is the whole range, so ~100 steps.
    // Tolerance covers the residual left mid-flight when the gesture ends.
    assert.ok(Math.abs(steps - 100) <= 3,
      "320 degrees moved " + steps + " steps, not ~100. DEGREES_FOR_FULL_RANGE " +
      "is what makes the sweep independent of the units the device counts in.");
  });

  await t.test("half a sweep is half the range", () => {
    const r = harness.renderPage({
      page: "dial.html", name: "dial-half", windowSize: "390x844",
      stub: rig(),
      driver: READY + `
        await sweep(160);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const steps = r.sent.reduce((n, b) => n + (b.relative_step || 0), 0);
    assert.ok(Math.abs(steps - 50) <= 3, "160 degrees moved " + steps + " steps, not ~50");
  });

  await t.test("a dB output moves in ITS steps, not in units", () => {
    // min -80, max 0, step 0.5: the same 320 degrees is 80 dB of travel, which
    // is 160 steps. A control that sent units would send 80 and move the
    // volume a quarter of the way.
    const r = harness.renderPage({
      page: "dial.html", name: "dial-db", windowSize: "390x844",
      stub: rig({ volume: { type: "db", min: -80, max: 0, step: 0.5, value: -40 } }),
      driver: READY + `
        await sweep(320);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const steps = r.sent.reduce((n, b) => n + (b.relative_step || 0), 0);
    assert.ok(Math.abs(steps - 160) <= 5,
      "320 degrees on a 0.5-step dB output moved " + steps + " steps, not ~160. " +
      "Quantising to the output's own step is the difference between a knob " +
      "with detents and a slider.");
  });

  await t.test("it sends steps, never an absolute value", () => {
    const r = harness.renderPage({
      page: "dial.html", name: "dial-verb", windowSize: "390x844",
      stub: rig(),
      driver: READY + `
        await sweep(60);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const vol = r.sent.filter(b => b.relative_step !== undefined || b.value !== undefined);
    assert.ok(vol.length > 0, "the sweep sent nothing");
    for (const b of vol) {
      assert.equal(b.value, undefined,
        "the dial sent an absolute value. Computing one client-side means being " +
        "right about a scale it only samples; relative_step lets Roon do the " +
        "arithmetic against the device's real range.");
      assert.equal(b.zone_or_output_id, "z1");
    }
  });

  await t.test("an incremental output gets relative nudges, not steps", () => {
    // No range is reported, so there is no scale to step through and Roon's
    // guidance is a relative +/-1. relative_step against no range is undefined.
    const r = harness.renderPage({
      page: "dial.html", name: "dial-incr", windowSize: "390x844",
      stub: rig({ volume: { type: "incremental", min: 0, max: 0, step: 1, value: 0 } }),
      driver: READY + `
        await sweep(90);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const vol = volumeOf(r.sent.map((b, i) => ({ url: "/api/volume", body: b })))
      .map(p => p.body).filter(b => b.relative !== undefined || b.relative_step !== undefined);
    assert.ok(vol.length > 0, "the sweep sent nothing on an incremental output");
    for (const b of vol) {
      assert.equal(b.relative_step, undefined,
        "an incremental control has no range, so stepping through it is meaningless");
      assert.ok(b.relative !== undefined, "expected a relative nudge");
    }
  });

  await t.test("the soft limit is a ceiling the sweep cannot pass", () => {
    // Roon's soft limit is set on the device precisely so a remote cannot go
    // past it. A ring that swept to `max` would drive the volume somewhere its
    // owner had already said it must not go.
    const r = harness.renderPage({
      page: "dial.html", name: "dial-soft", windowSize: "390x844",
      stub: rig({ softLimit: 60 }),
      driver: READY + `
        await sweep(320);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    const steps = r.sent.reduce((n, b) => n + (b.relative_step || 0), 0);
    // The usable span is 0-60, so a full sweep is ~60 steps, not ~100.
    assert.ok(Math.abs(steps - 60) <= 3,
      "a full sweep against a soft limit of 60 moved " + steps + " steps. The " +
      "ring must span min..soft_limit, or it drives past the owner's ceiling " +
      "and Roon clamps it — which reads as the dial sticking.");
  });
});

test("the dial's taps reach the right endpoint", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The transport sits at a known place in the geometry; tapping it is the
  // only way to reach these, because there is no element to click.
  const TAP = `
    function tapControl(index) {
      var rect = c.getBoundingClientRect();
      var cx = rect.width / 2, cy = rect.height / 2;
      var radius = Math.min(rect.width, rect.height) / 2 - 8;
      var ringW = radius * 0.115;
      var inner = radius - ringW - 10;
      var spacing = inner * 0.38;
      var xs = [cx - spacing * 1.5, cx - spacing * 0.5, cx + spacing * 0.5, cx + spacing * 1.5];
      var y = cy + inner * 0.58;
      var p = { x: rect.left + xs[index], y: rect.top + y };
      c.dispatchEvent(new PointerEvent("pointerdown", { clientX: p.x, clientY: p.y, pointerId: 2, bubbles: true }));
      c.dispatchEvent(new PointerEvent("pointerup",   { clientX: p.x, clientY: p.y, pointerId: 2, bubbles: true }));
    }
  `;

  const r = harness.renderPage({
    page: "dial.html", name: "dial-taps", windowSize: "390x844",
    stub: rig(),
    driver: READY + TAP + `
      tapControl(0); await window.__sleep(150);
      tapControl(1); await window.__sleep(150);
      tapControl(2); await window.__sleep(150);
      T("sent", window.__posts.map(function (p) { return p.url + ":" + (p.body.command || ""); }));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("previous, play/pause and next map to /api/control", () => {
    assert.deepEqual(r.sent, [
      "/api/control:previous",
      "/api/control:playpause",
      "/api/control:next",
    ], "the transport taps sent " + JSON.stringify(r.sent));
  });
});

test("the dial degrades honestly", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  await t.test("an output with no volume control sends nothing", () => {
    // Plenty of outputs report no volume object at all — a DAC fed at unity,
    // or anything going into an amp with its own knob. Sweeping the ring there
    // must be inert rather than throwing or sending a nonsense request.
    const r = harness.renderPage({
      page: "dial.html", name: "dial-novol", windowSize: "390x844",
      stub: rig({ volume: null }),
      driver: READY + `
        await sweep(320);
        T("sent", window.__posts.map(function (p) { return p.body; }));
      `,
    });
    harness.assertNoPageError(assert, r);
    assert.deepEqual(r.sent, [],
      "the ring sent " + JSON.stringify(r.sent) + " on an output with no volume " +
      "control at all");
  });

  await t.test("the page renders without a zone rather than throwing", () => {
    const r = harness.renderPage({
      page: "dial.html", name: "dial-nozone", windowSize: "390x844",
      stub: `
window.__posts = [];
window.__installFetch(function (u) {
  if (u.indexOf("/api/zones") > -1) return window.__json({ zones: [] });
  if (u.indexOf("/api/") > -1)      return window.__json({});
  return undefined;
});`,
      driver: `
        await window.__sleep(700);
        var c = document.getElementById("dial");
        T("canvas_sized", c.width > 0 && c.height > 0);
      `,
    });
    harness.assertNoPageError(assert, r);
    assert.equal(r.canvas_sized, true, "the canvas never got a backing store");
  });
});
