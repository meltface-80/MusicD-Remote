"use strict";
// ---------------------------------------------------------------------------
// v1.7.67: the volume popover's row alignment.
//
// Reported from a screenshot: "the layout isn't aligned". It was, by 8px, and
// the cause is the kind that reads as correct in the source.
//
// `.vol-controls` is a flex row of three things: the readout (icon + number),
// the slider wrapper, and the two step buttons. The wrapper was a COLUMN
// holding the slider with the 0/100 scale beneath it, which made it ~20px
// taller than the slider alone. `align-items: center` then did exactly what it
// says — centred every sibling against the wrapper's FULL height — so the
// readout and both buttons sat centred on slider-plus-scale while the slider
// sat centred on itself. Everything was 8px low relative to the track it
// belongs to, and nothing in the CSS looks wrong.
//
// The scale is positioned now, so the wrapper is exactly the slider's height.
// This is measured rather than asserted from the stylesheet, because the
// stylesheet is precisely what looked fine.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const VOL = { type: "number", min: 0, max: 100, value: 13, step: 1, is_muted: false };
const OUT = { output_id: "o1", display_name: "Zone", volume: VOL };

// now_playing is FLAT (line1/line2/line3) — that is the shape renderZone reads.
// The zone id is seeded into localStorage because selectedZoneId() reads the
// topbar <select>, and with no stored zone fetchState() returns before it ever
// calls renderZone: currentZone stays null, the slider keeps the static
// value="50" out of index.html, and every volume handler early-returns.
const NP = { line1: "How to Be Dead", line2: "Snow Patrol", line3: "Final Straw",
             length: 200, image_key: "k" };

const STUB = `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  var z = { zone_id: "z1", display_name: "Zone", state: "playing", is_seek_allowed: true,
            outputs: [${JSON.stringify(OUT)}],
            now_playing: Object.assign({ seek_position: 5 }, ${JSON.stringify(NP)}) };
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [z] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: z });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

// The popover is revealed directly rather than by tapping the button: the point
// here is geometry, and driving the open animation only adds a timing variable.
const DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  var pop = document.getElementById("mt-vol-popover");
  pop.classList.remove("hidden");
  await window.__sleep(250);

  function midOf(sel) {
    var e = document.querySelector(sel);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return r.height ? Math.round(r.top + r.height / 2) : null;
  }
  T("slider_mid",  midOf("#mt-vol-popover .vol-range"));
  T("readout_mid", midOf("#mt-vol-popover .vol-readout"));
  T("minus_mid",   midOf("#mt-vol-minus"));
  T("plus_mid",    midOf("#mt-vol-plus"));

  var sc  = document.querySelector("#mt-vol-popover .vol-scale");
  var sl  = document.querySelector("#mt-vol-popover .vol-range");
  T("scale_gap",     sc && sl ? Math.round(sc.getBoundingClientRect().top - sl.getBoundingClientRect().bottom) : null);
  T("scale_clear",   sc ? Math.round(pop.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom) : null);
  T("scale_visible", sc ? getComputedStyle(sc).display !== "none" : null);
  T("min_label", sc ? sc.firstElementChild.textContent : null);
  T("max_label", sc ? sc.lastElementChild.textContent : null);
`;

function measure(name, size) {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER, name, windowSize: size });
  harness.assertNoPageError(assert, r);
  assert.ok(r.slider_mid, "the volume popover did not render at " + size);
  return r;
}

test("the volume row lines up on the slider track", { concurrency: 1 }, async (t) => {
  for (const size of ["360x780", "390x844", "768x1024"]) {
    await t.test(size + ": readout, slider and both step buttons share a centre line", () => {
      const r = measure("vol-align-" + size.split("x")[0], size);
      // 1px of tolerance for sub-pixel rounding, no more. The bug was 8px.
      for (const [label, v] of [["readout", r.readout_mid], ["minus", r.minus_mid], ["plus", r.plus_mid]]) {
        assert.ok(Math.abs(v - r.slider_mid) <= 1,
          label + " is centred at " + v + " but the slider track is at " + r.slider_mid +
          " (" + Math.abs(v - r.slider_mid) + "px out) at " + size + ". The 0/100 scale is " +
          "back in the flow, making the slider wrapper taller than the slider and " +
          "dragging every sibling down with align-items: center.");
      }
    });
  }

  await t.test("the scale still sits under the slider, inside the popover", () => {
    // Positioning it must not push it out of the sheet, or off the bottom of
    // the screen — which is the obvious way to "fix" the alignment wrongly.
    const r = measure("vol-align-scale", "390x844");
    assert.equal(r.scale_visible, true, "the 0/100 scale was hidden rather than repositioned");
    assert.equal(r.min_label, "0");
    assert.equal(r.max_label, "100");
    assert.ok(r.scale_gap >= 0 && r.scale_gap <= 8,
      "the scale sits " + r.scale_gap + "px from the slider — it should read as its label");
    assert.ok(r.scale_clear >= 4,
      "the scale is only " + r.scale_clear + "px above the popover's bottom edge, so the " +
      "sheet has no padding left for it and it will look clipped");
  });
});

// ---------------------------------------------------------------------------
// v1.7.68: the volume slider jumping back a step, and the seek bar's jerk.
//
// Reported as "increase it and it jumps back at times, vice versa" and "the
// track position bar is jerky as well". Two different bugs, one shape: an
// optimistic local paint, and a poll that overwrites it with what the server
// knew BEFORE the change.
//
// VOLUME. The only guard was a boolean set on the slider's `input` event and
// cleared on `change`. The −/+ buttons never touched it, so from the moment a
// tap painted 51 until Roon echoed 51 back, any poll tick wrote 50 straight
// over it — the thumb retreating after +, advancing after −. Worse, the next
// tap then computed its step from the REVERTED display and re-sent a value
// already sent, losing the tap outright.
//
// SEEK. A 1000ms ticker did `npPos += 1` while the 1500ms poll assigned the
// server's value unconditionally. Two unsynchronised timers on one variable,
// realigning every 3s: forward a second, back a second, forward two.
//
// The stub models the two things about the real server that make these
// possible, and nothing else:
//
//   * VOLUME lags. A POST is accepted but the reported value does not move,
//     as it does not for the round trip plus Roon's own ~1Hz event cadence.
//     `window.__vol` is moved by hand when the test wants the server to have
//     caught up — or to have been changed from somewhere else entirely.
//   * SEEK advances, in whole seconds, and is therefore up to a second BEHIND
//     the true position by the time it arrives. That lag is the whole problem.
//     A frozen position would make re-baselining correct and prove nothing.
// ---------------------------------------------------------------------------
const STALE_STUB = `
window.__vol = 50;            // what the server admits to, moved by hand below
window.__posts = [];
window.__t0 = Date.now();
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__seekPend = null;
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/volume") > -1 && opts && opts.method === "POST") {
    window.__posts.push(JSON.parse(opts.body));
    return window.__json({ ok: true });   // NOTE: server value deliberately unchanged
  }
  // A seek is ACCEPTED immediately and REFLECTED about a second later, which is
  // how Roon behaves. In between, the position reported is still the pre-seek
  // one — the window in which an ungated poll drags the bar back to where the
  // user just dragged it from.
  if (u.indexOf("/api/seek") > -1 && opts && opts.method === "POST") {
    window.__seekPend = { to: JSON.parse(opts.body).seconds, at: Date.now() };
    return window.__json({ ok: true });
  }
  if (window.__seekPend && Date.now() - window.__seekPend.at > 1000) {
    // Rebase the virtual clock so the reported position continues from the
    // seek target, keeping the same 1.2s staleness.
    window.__t0 = Date.now() - 1200 - (window.__seekPend.to - 5) * 1000;
    window.__seekPend = null;
  }
  var out = { output_id: "o1", display_name: "Zone",
              volume: { type: "number", min: 0, max: 100, value: window.__vol, step: 1, is_muted: false } };
  // Whole seconds, and ~1.2s old by the time it is read — Roon quantises to
  // the second and emits on its own ~1Hz cadence, so the position reported is
  // always behind the one already painted. THAT is what an unconditional
  // assignment yanks the bar back to. A perfectly fresh value would make
  // snapping harmless and leave the monotonicity assertion permanently green.
  var pos = Math.max(0, Math.floor(5 + (Date.now() - window.__t0 - 1200) / 1000));
  var z = { zone_id: "z1", display_name: "Zone", state: "playing", is_seek_allowed: true,
            outputs: [out],
            now_playing: { line1: "T", line2: "A", line3: "Al",
                           length: 200, seek_position: pos, image_key: "k" } };
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [z] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: z });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const VOL_DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  var sl = document.getElementById("mt-vol-slider");
  T("start", parseFloat(sl.value));

  // Tap + once. The server goes on reporting 50 for the whole round trip.
  document.getElementById("mt-vol-plus").click();
  await window.__sleep(120);
  T("after_tap", parseFloat(sl.value));

  // Let stale polls land. setVolume() pulls one at +200ms and the background
  // poll runs at 1500ms, so this window contains at least two answers of 50.
  await window.__sleep(1400);
  T("after_stale_polls", parseFloat(sl.value));

  // A second tap must step from what we SENT, not from a reverted display.
  document.getElementById("mt-vol-plus").click();
  await window.__sleep(150);
  T("after_second_tap", parseFloat(sl.value));
  T("sent", window.__posts.map(function (p) { return p.value; }));

  // Now let the server disagree for real — a change made in the Roon app, or a
  // hardware knob. Once the hold lapses this has to reach the slider.
  window.__vol = 80;
  await window.__sleep(5000);
  T("after_server_moves", parseFloat(sl.value));
`;

test("the volume slider does not jump back when the server is behind",
  { concurrency: 1 }, async (t) => {
    const r = harness.renderPage({
      stub: STALE_STUB, driver: VOL_DRIVER, name: "vol-race", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("a tap moves exactly one step", () => {
      assert.equal(r.start, 50, "the slider never took the server's value — it is " +
        "showing index.html's static default, so nothing below is exercising the app");
      assert.equal(r.after_tap, 51,
        "one tap moved to " + r.after_tap + ". The step is the zone's own (1 here), " +
        "not a hardcoded 2 that moves two positions on a step-1 output.");
    });

    await t.test("THE one: stale polls do not drag it back", () => {
      assert.equal(r.after_stale_polls, 51,
        "the slider fell back to " + r.after_stale_polls + " after the poll " +
        "returned the server's pre-tap value. That is the reported jump-back: " +
        "the guard only ever covered a drag, never the +/- buttons.");
    });

    await t.test("the second tap is not swallowed", () => {
      assert.equal(r.after_second_tap, 52,
        "the second tap landed on " + r.after_second_tap + ". Stepping from the " +
        "painted value instead of the pending one recomputes a value already " +
        "sent, and the tap is lost.");
      assert.deepEqual(r.sent, [51, 52],
        "the writes sent were " + JSON.stringify(r.sent) + " — two taps must be " +
        "two distinct absolute values");
    });

    await t.test("the server still wins once it actually disagrees", () => {
      // The hold must not become a one-way door: a change made elsewhere has to
      // reach the slider, or the app is showing a number nothing stands behind.
      assert.equal(r.after_server_moves, 80,
        "an external volume change never reached the slider — the hold is " +
        "swallowing real server state, not just stale echoes");
    });
  });

const SEEK_DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  function pct() {
    var f = document.getElementById("mt-progress-fill");
    return f && f.style.width ? parseFloat(f.style.width) : null;
  }
  var samples = [];
  for (var i = 0; i < 20; i++) { samples.push(pct()); await window.__sleep(400); }
  T("samples", samples);

  // Someone seeks 60s forward in the Roon app. Winding __t0 back is how the
  // stub reports a position that jumped without us asking. The local clock has
  // no way to know, so only the server can tell us — the bar must follow.
  window.__t0 -= 60000;
  await window.__sleep(2600);           // one poll at 1500ms, plus margin
  T("after_external_seek", pct());
`;

test("the progress bar advances without going backwards", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: STALE_STUB, driver: SEEK_DRIVER, name: "seek-smooth", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("it never moves backwards", () => {
    // The old pairing — a 1000ms +1 counter against a 1500ms unconditional snap
    // to a server quantised to whole seconds — stepped back repeatedly. With the
    // clock as the source of truth and the snap gated on a tolerance, monotonic.
    const s = r.samples.filter(v => typeof v === "number");
    assert.ok(s.length >= 12, "not enough samples: " + JSON.stringify(r.samples));
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i] >= s[i - 1] - 0.01,
        "the bar went backwards, " + s[i - 1] + "% then " + s[i] + "%, at sample " + i +
        ". Full sequence: " + JSON.stringify(s));
    }
  });

  await t.test("it actually advances, and in fine steps", () => {
    const s = r.samples.filter(v => typeof v === "number");
    assert.ok(s[s.length - 1] > s[0], "the bar never moved: " + JSON.stringify(s));
    // A whole-second counter on a 200s track jumps 0.5% at a time. Painting from
    // the clock every 250ms, sampled every 400ms, should stay well under that.
    const steps = [];
    for (let i = 1; i < s.length; i++) if (s[i] > s[i - 1]) steps.push(s[i] - s[i - 1]);
    const biggest = Math.max.apply(null, steps);
    assert.ok(biggest < 0.4,
      "the largest forward step was " + biggest.toFixed(3) + "% — that is a " +
      "whole-second jump, not a smooth advance");
  });

  await t.test("a real external seek is still followed", () => {
    // The counterweight to the tolerance. Ignoring the server is a perfectly
    // smooth way to be wrong, and every assertion above would still pass —
    // so one of them has to insist the bar can be moved from outside.
    const before = r.samples.filter(v => typeof v === "number").pop();
    assert.ok(r.after_external_seek > before + 20,
      "someone seeked 60s forward in the Roon app and the bar went from " +
      before + "% to " + r.after_external_seek + "%. The tolerance is swallowing " +
      "real events, not just the ~2s of staleness it is meant to absorb.");
  });
});

const OWN_SEEK_DRIVER = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  function pct() {
    var f = document.getElementById("mt-progress-fill");
    return f && f.style.width ? parseFloat(f.style.width) : null;
  }
  T("before", pct());

  // Open the now-playing screen and scrub, the way a user does.
  document.querySelector(".mt-info").click();
  await window.__sleep(500);
  var sk = document.getElementById("np-seek");
  T("seek_enabled", !sk.disabled);
  sk.value = 150;
  sk.dispatchEvent(new Event("change", { bubbles: true }));

  // Watch across the whole window in which the server is still answering with
  // the PRE-seek position — including the deliberate refresh at +200ms.
  var s = [];
  for (var i = 0; i < 9; i++) { s.push(pct()); await window.__sleep(300); }
  T("after_seek", s);
`;

test("our own seek is not yanked back by the refresh that follows it",
  { concurrency: 1 }, async (t) => {
    const r = harness.renderPage({
      stub: STALE_STUB, driver: OWN_SEEK_DRIVER, name: "seek-own", windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the bar stays where it was dragged to", () => {
      assert.equal(r.seek_enabled, true, "the scrubber was disabled — nothing was exercised");
      assert.ok(r.before < 10, "the track did not start near the beginning: " + r.before);
      // 150 of 200s is 75%. seek() sets the base itself and holds off
      // re-baselining for 1500ms; without that hold the refresh it schedules at
      // +200ms answers with the pre-seek position and the bar snaps back to ~4%,
      // then jumps forward again when Roon catches up. Two visible yanks.
      const low = Math.min.apply(null, r.after_seek.filter(v => typeof v === "number"));
      assert.ok(low >= 74,
        "after seeking to 75% the bar dropped to " + low + "%. Sequence: " +
        JSON.stringify(r.after_seek));
    });
  });
