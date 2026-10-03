"use strict";
// ---------------------------------------------------------------------------
// Did playback survive a change? (v1.8.74) The verdict that decides whether a
// filter change on somebody's HQPlayer is kept or rolled back. Ported from
// hqpweb's watch tests (MIT, (c) 2026 statelycurmudgeon — lib/hqp/LICENSE).
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { judge, DEFAULT_TIMING, MAJOR_TIMING } = require("../../lib/hqp/watch");

const T = { graceMs: 1000, healthyMs: 1000, maxMs: 4000, sampleMs: 250, minSpeed: 0.85 };

/** Samples every 250 ms from t=0 to `until`. */
const run = (until, state, pos) => {
  const out = [];
  for (let t = 0; t <= until; t += 250) out.push({ t, state: state(t), position: pos(t) });
  return out;
};

test("judging playback after a change", async (t) => {
  await t.test("steady playback passes after the grace period", () => {
    assert.deepEqual(judge(run(2000, () => 2, (t) => 100 + t / 1000), T, false), { kind: "playing" });
  });
  await t.test("a brief pause inside the grace period is ignored (filters pause ≤ ~1 s, measured)", () => {
    const pos = (t) => (t < 800 ? 100 : 100 + (t - 800) / 1000);
    assert.deepEqual(judge(run(2250, () => 2, pos), T, false), { kind: "playing" });
  });
  await t.test("it waits for more evidence before the healthy window is complete", () => {
    assert.deepEqual(judge(run(1250, () => 2, (t) => t / 1000), T, false), { kind: "pending" });
  });
  await t.test("THE one: the measured stall (state 3, then 0) fails fast", () => {
    const v = judge(run(2250, (t) => (t < 500 ? 2 : t < 1000 ? 3 : 0), () => 50), T, false);
    assert.equal(v.kind, "stopped");
  });
  await t.test("slow progress is 'struggling', at the end of the window", () => {
    const samples = run(4000, () => 2, (t) => 100 + (t / 1000) * 0.5);
    assert.deepEqual(judge(samples.slice(0, 9), T, false), { kind: "pending" });
    assert.deepEqual(judge(samples, T, true), { kind: "struggling", detail: "playing at 50% of real time" });
  });
  await t.test("...or early, once slow progress has lasted twice the healthy window", () => {
    const samples = run(3000, () => 2, (t) => 100 + (t / 1000) * 0.5);
    assert.equal(judge(samples, T, false).kind, "struggling");
  });
  await t.test("a frozen position with state 2 is stopped", () => {
    assert.equal(judge(run(4000, () => 2, () => 42), T, true).kind, "stopped");
  });
  await t.test("a track change (the position jumps back) is not a failure", () => {
    const pos = (t) => (t < 1500 ? 200 + t / 1000 : (t - 1500) / 1000);
    assert.deepEqual(judge(run(3000, () => 2, pos), T, false), { kind: "playing" });
  });
  await t.test("someone pausing makes it inconclusive, never a failure", () => {
    assert.equal(judge(run(2000, (t) => (t > 1200 ? 1 : 2), (t) => t / 1000), T, false).kind, "inconclusive");
  });
  await t.test("a mode change gets longer: HQPlayer takes ~3 s to answer one (measured)", () => {
    assert.ok(MAJOR_TIMING.graceMs > DEFAULT_TIMING.graceMs);
    assert.ok(MAJOR_TIMING.maxMs > DEFAULT_TIMING.maxMs);
  });
});
