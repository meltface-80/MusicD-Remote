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
// Sending the nested `three_line` wrapper instead leaves every field undefined,
// which renders but exercises nothing.
//
// The zone id is seeded into localStorage only to pin WHICH zone is selected.
// loadZones() falls back to zones[0] on its own, so this is not what makes the
// page work — it just removes the dependency on that fallback.
const NP = { line1: "How to Be Dead", line2: "Snow Patrol", line3: "Final Straw",
             length: 200, image_key: "k" };

const STUB = `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
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
window.__vol = 37;            // NOT index.html-s static 50 — see the start assertion
window.__posts = [];
window.__softLimit = undefined;   // set by the soft-limit driver
window.__t0 = Date.now();
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
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
              volume: { type: "number", min: 0, max: 100, value: window.__vol,
                        step: 1, soft_limit: window.__softLimit, is_muted: false } };
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
      assert.equal(r.start, 37,
        "the slider shows " + r.start + ", not the server's 37. index.html ships " +
        'value="50", so a stub that also said 50 could not tell "rendered the ' +
        'server value" from "never ran at all" — which is why it says 37.');
      assert.equal(r.after_tap, 38,
        "one tap moved to " + r.after_tap + ". The step is the zone's own (1 here), " +
        "not a hardcoded 2 that moves two positions on a step-1 output.");
    });

    await t.test("THE one: stale polls do not drag it back", () => {
      assert.equal(r.after_stale_polls, 38,
        "the slider fell back to " + r.after_stale_polls + " after the poll " +
        "returned the server's pre-tap value. That is the reported jump-back: " +
        "the guard only ever covered a drag, never the +/- buttons.");
    });

    await t.test("the second tap is not swallowed", () => {
      assert.equal(r.after_second_tap, 39,
        "the second tap landed on " + r.after_second_tap + ". Stepping from the " +
        "painted value instead of the pending one recomputes a value already " +
        "sent, and the tap is lost.");
      assert.deepEqual(r.sent, [38, 39],
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

// ---------------------------------------------------------------------------
// v1.7.69: the defects an 8-angle review found in v1.7.68's own fix.
//
// Each of these is a bug the previous version introduced or left behind, and
// none of them was reachable by the assertions above — which is the point.
// ---------------------------------------------------------------------------

// A stub whose zone state the driver can rewrite between polls: play state,
// track length, volume, and which zone is selected.
const RIG = `
window.__vol = 40;
window.__softLimit = undefined;
window.__state = "playing";
window.__len = 200;
window.__zoneId = "z1";
window.__posts = [];
window.__applied = [];
window.__hang = false;
window.__slow = false;
window.__played = 0;             // ms of actual playback, the way a server counts
window.__lastSample = Date.now();
window.__lag = 1200;
// Flip play state through this, so the accumulator closes off the interval at
// the moment of the transition rather than at the next poll.
window.__setState = function (s) {
  var now = Date.now();
  if (window.__state === "playing") window.__played += now - window.__lastSample;
  window.__lastSample = now;
  window.__state = s;
};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/volume") > -1 && opts && opts.method === "POST") {
    var body = JSON.parse(opts.body);
    window.__posts.push(body);
    // Never settles on its own — but honours the abort signal, which is what a
    // real fetch does and the only reason a bounded caller can recover.
    if (window.__hang) return new Promise(function (res, rej) {
      if (opts && opts.signal) {
        opts.signal.addEventListener("abort", function () {
          rej(new DOMException("Aborted", "AbortError"));
        });
      }
    });
    // Only the ordering test asks for slow responses; everything else wants a
    // prompt server so its timings stay about the poll, not about the write.
    // Lower values take longer, so a naive fire-and-forget burst lands out of
    // order deterministically and the LAST value applied is the wrong one. The
    // spread must exceed the gap between taps, or send order decides it anyway
    // and a missing serialisation looks correct.
    var delay = window.__slow ? Math.max(0, (100 - (body.value || 0)) * 40) : 0;
    return new Promise(function (res) {
      setTimeout(function () {
        window.__applied.push(body.value);
        res(new Response(JSON.stringify({ ok: true }),
            { status: 200, headers: { "Content-Type": "application/json" } }));
      }, delay);
    });
  }
  var out = { output_id: "o1", display_name: "Zone",
              volume: { type: "number", min: 0, max: 100, value: window.__vol,
                        step: 1, soft_limit: window.__softLimit, is_muted: false } };
  var extra = window.__state === "playing" ? (Date.now() - window.__lastSample) : 0;
  var pos = Math.max(0, Math.floor((window.__played + extra - window.__lag) / 1000));
  var z = { zone_id: window.__zoneId, display_name: "Zone", state: window.__state,
            is_seek_allowed: true, outputs: [out],
            now_playing: { line1: "T", line2: "A", line3: "Al",
                           length: window.__len, seek_position: pos, image_key: "k" } };
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [z] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: z });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const READY = `
  await window.__sleep(700);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  function pct() {
    var f = document.getElementById("mt-progress-fill");
    return f && f.style.width ? parseFloat(f.style.width) : null;
  }
`;

// --- pause drift -----------------------------------------------------------
// The position clock is base + elapsed. If the base is not re-anchored while
// paused, the paused seconds are added on resume: the bar runs permanently
// ahead, silently, because the error stays under the 3s reconcile threshold —
// until enough short pauses accumulate past it and it yanks back by MORE than
// three seconds.
const PAUSE_DRIVER = READY + `
  await window.__sleep(2000);
  var samples = [];
  function sample() { samples.push(pct()); }
  sample();

  // Three short pauses. Each is under the 3s reconcile threshold, so nothing
  // corrects the drift each one causes — they accumulate until together they
  // cross it, and THAT is when the bar snaps.
  for (var i = 0; i < 3; i++) {
    window.__setState("paused");
    for (var a = 0; a < 8; a++) { await window.__sleep(280); sample(); }
    window.__setState("playing");
    for (var b = 0; b < 8; b++) { await window.__sleep(280); sample(); }
  }
  for (var c = 0; c < 6; c++) { await window.__sleep(280); sample(); }
  T("samples", samples);
`;

test("paused time is not counted as playback", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: PAUSE_DRIVER, name: "seek-pause", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("pausing settles the bar, it does not yank it", () => {
    // THE assertion, and note what it does NOT say. Pausing legitimately moves
    // the bar back a little: between the real pause and the poll that reports
    // it, the local clock painted playback that never happened, and the
    // server's position is the exact pause point. Correcting that is right, and
    // it is bounded by the detection lag — about 0.4% here.
    //
    // What must never happen is the accumulating version. If npBaseAt is not
    // re-anchored across a pause, each pause leaves the bar ahead by its own
    // duration, silently, because one pause alone stays under the 3s reconcile
    // threshold. Three together cross it and the reconcile yanks the bar back
    // by more than three seconds — a bigger jerk than the ~1s one this whole
    // release exists to remove, just rarer.
    const s = r.samples.filter(v => typeof v === "number");
    assert.ok(s.length >= 40, "not enough samples: " + JSON.stringify(r.samples));
    let worst = 0, at = -1;
    for (let i = 1; i < s.length; i++) {
      const back = s[i - 1] - s[i];
      if (back > worst) { worst = back; at = i; }
    }
    // 1% of a 200s track is 2s. A settle is ~0.4%; an accumulated-drift yank is
    // over 2%. Nothing lands in between.
    assert.ok(worst < 1,
      "the bar jumped back " + worst.toFixed(2) + "% at sample " + at +
      " — that is " + (worst * 2).toFixed(1) + "s, far more than the settle a " +
      "pause justifies. Full sequence: " + JSON.stringify(s));
  });

  await t.test("and advances only by the time actually played", () => {
    const s = r.samples.filter(v => typeof v === "number");
    const moved = s[s.length - 1] - s[0];
    // 3 x 2240ms playing plus a final 1680ms after the baseline sample, against
    // 15.4s of wall clock over the same window: 4.2% versus 7.7%.
    const expected = ((3 * 2240 + 1680) / 1000 / 200) * 100;
    assert.ok(Math.abs(moved - expected) < 1.2,
      "the bar moved " + moved.toFixed(2) + "% but only " + expected.toFixed(2) +
      "% was played (wall clock over the same window would be " +
      ((15400 / 1000 / 200) * 100).toFixed(2) + "%)");
  });
});

// --- the volume hold must not survive a zone switch ------------------------
const ZONESWITCH_DRIVER = READY + `
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  var sl = document.getElementById("mt-vol-slider");
  T("start", parseFloat(sl.value));

  document.getElementById("mt-vol-plus").click();   // 40 -> 41 on zone z1
  await window.__sleep(120);
  T("after_tap", parseFloat(sl.value));

  // Switch to a different zone, sitting at a very different volume, INSIDE the
  // 2s hold window.
  window.__zoneId = "z2";
  window.__vol = 12;
  await window.__sleep(1000);
  T("after_switch", parseFloat(sl.value));

  window.__posts = [];
  document.getElementById("mt-vol-plus").click();
  await window.__sleep(150);
  T("sent_after_switch", window.__posts.map(function (p) { return p.value; }));
`;

test("a volume hold does not follow you to another zone", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: ZONESWITCH_DRIVER, name: "vol-zoneswitch", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the new zone shows its own volume, not the old zone's", () => {
    assert.equal(r.start, 40);
    assert.equal(r.after_tap, 41);
    assert.equal(r.after_switch, 12,
      "after switching zones the slider still reads " + r.after_switch +
      " — the previous zone's number. The hold is keyed to nothing, so it " +
      "suppresses the new zone's value for the rest of its 2s window.");
  });

  await t.test("and the next tap steps from the new zone's volume", () => {
    // This is the damaging half: stepping from a stale display sends an
    // absolute value to a zone the user never touched.
    assert.deepEqual(r.sent_after_switch, [13],
      "tapping + on the new zone sent " + JSON.stringify(r.sent_after_switch) +
      " instead of [13] — an absolute jump on a zone that was sitting at 12.");
  });
});

// --- a track change must re-baseline even inside our own seek hold ---------
const TRACKCHANGE_DRIVER = READY + `
  document.querySelector(".mt-info").click();
  await window.__sleep(500);
  var sk = document.getElementById("np-seek");

  // Scrub to near the end of the track — a normal way to skip on.
  sk.value = 195;
  sk.dispatchEvent(new Event("change", { bubbles: true }));
  await window.__sleep(150);
  T("after_scrub", pct());

  // Roon moves to the next track well inside the 1.5s seek hold.
  window.__len = 100;
  window.__played = 0; window.__lastSample = Date.now();   // new track, from the top
  await window.__sleep(1000);
  T("during_hold", pct());
`;

test("a track change re-baselines even inside the seek hold", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: TRACKCHANGE_DRIVER, name: "seek-trackchange", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the next track does not open at 100%", () => {
    assert.ok(r.after_scrub > 90, "the scrub did not take: " + r.after_scrub);
    assert.ok(r.during_hold < 30,
      "the new track opened at " + r.during_hold + "%. The seek hold was gating " +
      "the track-change branch as well as the position branch, so the old " +
      "track's 195s base was clamped against the new track's length and the " +
      "bar sat pinned at 100% until the hold lapsed.");
  });
});

// --- soft_limit is Roon's ceiling and must bound both paths ----------------
const SOFTLIMIT_DRIVER = READY + `
  window.__softLimit = 45;
  window.__vol = 43;
  await window.__sleep(1700);
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  var sl = document.getElementById("mt-vol-slider");
  T("slider_max", parseFloat(sl.max));
  T("scale_max", document.getElementById("mt-vol-max").textContent);

  window.__posts = [];
  for (var i = 0; i < 5; i++) { document.getElementById("mt-vol-plus").click(); await window.__sleep(60); }
  T("sent", window.__posts.map(function (p) { return p.value; }));
  T("final", parseFloat(sl.value));
`;

test("volume stops at Roon's soft limit", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: SOFTLIMIT_DRIVER, name: "vol-softlimit", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the buttons stop there", () => {
    assert.equal(r.final, 45,
      "five taps from 43 reached " + r.final + ", past the soft limit of 45. " +
      "Roon clamps the request and the next poll drags the thumb back down, " +
      "which is indistinguishable from the jitter this release is fixing.");
    assert.ok(Math.max.apply(null, r.sent) <= 45,
      "a value above the soft limit was sent: " + JSON.stringify(r.sent));
  });

  await t.test("and so does the slider itself", () => {
    // Clamping only the buttons leaves dragging able to request a value the
    // zone will never report back, so the hold waits on an echo that cannot
    // arrive and then snaps.
    assert.equal(r.slider_max, 45,
      "the slider still spans to " + r.slider_max + ", so a drag can ask for " +
      "more than the zone will accept");
    assert.equal(r.scale_max, "45", "the scale label disagrees with the slider's range");
  });
});

// --- the write queue, the debounce cancel, and a hung request -------------
// The most intricate code in this change, and the part with no coverage until
// now: absolute writes issued over separate connections, a 90ms debounce that
// can outlive the gesture that scheduled it, and a serialisation gate that must
// not be able to jam shut.

const STALE_DEBOUNCE_DRIVER = READY + `
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  var sl = document.getElementById("mt-vol-slider");
  window.__posts = []; window.__applied = [];

  // Mid-drag value, then the release 40ms later — INSIDE the 90ms debounce, so
  // the queued write for the old value is still pending when the final one is
  // sent.
  sl.value = 55; sl.dispatchEvent(new Event("input",  { bubbles: true }));
  await window.__sleep(40);
  sl.value = 78; sl.dispatchEvent(new Event("change", { bubbles: true }));
  await window.__sleep(1200);
  T("sent", window.__posts.map(function (p) { return p.value; }));
`;

test("a mid-drag write cannot land after the release", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: STALE_DEBOUNCE_DRIVER, name: "vol-debounce", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the released value is the last thing sent", () => {
    assert.ok(r.sent.length >= 1, "the drag sent nothing: " + JSON.stringify(r.sent));
    assert.equal(r.sent[r.sent.length - 1], 78,
      "the writes were " + JSON.stringify(r.sent) + ". The debounced write for " +
      "the mid-drag value was still pending at release; not cancelling it leaves " +
      "the zone at a value the user dragged past, and the poll then faithfully " +
      "drags the thumb back to it.");
  });
});

const ORDER_DRIVER = READY + `
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  window.__posts = []; window.__applied = []; window.__slow = true;

  // Four fast taps. stepVolume has no debounce, so these are four immediate
  // absolute writes — the case the serialisation exists for.
  for (var i = 0; i < 4; i++) {
    document.getElementById("mt-vol-plus").click();
    await window.__sleep(20);
  }
  await window.__sleep(9000);
  T("sent", window.__posts.map(function (p) { return p.value; }));
  T("applied", window.__applied.slice());
`;

// A write already in flight when the user changes zone must still be addressed
// to the zone it was made for.
const MIDFLIGHT_ZONE_DRIVER = READY + `
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);
  window.__posts = []; window.__applied = []; window.__slow = true;

  document.getElementById("mt-vol-plus").click();   // in flight, slow
  await window.__sleep(20);
  document.getElementById("mt-vol-plus").click();   // queued behind it
  window.__zoneId = "z2";                           // user switches zone now
  await window.__sleep(9000);
  T("zones", window.__posts.map(function (p) { return p.zone_or_output_id; }));
`;

test("a queued volume write keeps the zone it was made for", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: MIDFLIGHT_ZONE_DRIVER, name: "vol-midflight", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("both writes go to the original zone", () => {
    assert.ok(r.zones.length >= 2, "expected two writes, got " + JSON.stringify(r.zones));
    assert.deepEqual(r.zones, r.zones.map(() => "z1"),
      "the writes went to " + JSON.stringify(r.zones) + ". The zone id used to be " +
      "read off currentZone inside the send loop, which is after an await on " +
      "every iteration but the first — so changing zone mid-drag posted the " +
      "queued value to the zone just switched TO.");
  });
});

test("rapid taps are applied in the order they were made", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: ORDER_DRIVER, name: "vol-order", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the zone ends on the value the user asked for last", () => {
    // Intermediate values are deliberately dropped — that is what latest-wins
    // means. What matters is where the zone ENDS UP.
    assert.equal(r.sent[r.sent.length - 1], 44,
      "four taps from 40 sent " + JSON.stringify(r.sent) + "; the last must be 44");
    assert.equal(r.applied[r.applied.length - 1], 44,
      "the writes ARRIVED in the order " + JSON.stringify(r.applied) + ". These " +
      "are absolute values over separate connections, so without one in flight " +
      "at a time an earlier, slower write lands last and leaves the zone at a " +
      "volume the user already moved past.");
  });
});

const HANG_DRIVER = READY + `
  document.getElementById("mt-vol-popover").classList.remove("hidden");
  await window.__sleep(200);

  // One request that never answers — a Core that drops mid-call. /api/volume
  // has no timeout of its own; it replies only when Roon calls back.
  window.__hang = true;
  document.getElementById("mt-vol-plus").click();
  await window.__sleep(500);
  window.__hang = false;

  // Well past the 5s abort. Volume must still work.
  await window.__sleep(6000);
  window.__posts = [];
  document.getElementById("mt-vol-plus").click();
  await window.__sleep(400);
  T("sent_after_hang", window.__posts.map(function (p) { return p.value; }));
`;

test("a hung volume request does not wedge the control", { concurrency: 1 }, async (t) => {
  const r = harness.renderPage({
    stub: RIG, driver: HANG_DRIVER, name: "vol-hang", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("later taps still reach the server", () => {
    assert.ok(r.sent_after_hang.length > 0,
      "after one request that never answered, no further volume write was ever " +
      "sent. Serialising writes without bounding them means volInFlight stays " +
      "true forever and every later tap queues behind a promise that will never " +
      "settle — volume dead for the lifetime of the page.");
  });
});
