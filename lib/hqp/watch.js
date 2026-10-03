"use strict";
// ---------------------------------------------------------------------------
// Did playback survive a change? Judged from Status samples taken after it.
// Ported from hqpweb (apps/server/src/watch.ts), MIT, (c) 2026
// statelycurmudgeon — see ./LICENSE.
//
// Measured failure: an invalid rate/modulator combination goes state 3 → 0 and
// stays stopped. Inferred, not yet measured: a CPU/GPU overload shows as the
// position advancing slower than real time while the state stays 2. Overload
// can leave an HQPlayer needing a restart (an operator's report), so slow
// progress is judged early rather than at the end of the window.
// ---------------------------------------------------------------------------

/**
 * graceMs: ignored after the change, because filters pause briefly (≤ ~1 s, measured).
 * healthyMs: healthy progress needed after the grace period to pass early.
 * maxMs: give up and judge with what there is.
 * minSpeed: below this fraction of real time counts as not keeping up.
 * stoppedMs: not playing for this long after the grace period is a stop.
 *   (hqpweb has 1000 written into the judgement; it is a setting here only so
 *   the test suite can shorten it, and the default is the same.)
 */
const DEFAULT_TIMING = { graceMs: 1500, healthyMs: 1500, maxMs: 6000, sampleMs: 250, minSpeed: 0.85, stoppedMs: 1000 };
/** Mode changes take ~3 s before HQPlayer replies (measured): allow more after one. */
const MAJOR_TIMING = Object.assign({}, DEFAULT_TIMING, { graceMs: 2500, maxMs: 10000 });

/**
 * Judge the samples so far ({t: ms since the watch began, state, position: s}).
 * `final` = no more samples are coming. Verdicts: playing | stopped |
 * struggling | inconclusive (someone paused, or too few samples) | pending.
 */
function judge(samples, timing, final) {
  if (samples.some((s) => s.state === 1)) return { kind: "inconclusive", detail: "playback was paused during the check" };
  const after = samples.filter((s) => s.t >= timing.graceMs);
  if (after.length < 2) return final ? { kind: "inconclusive", detail: "too few samples" } : { kind: "pending" };

  const last = after[after.length - 1];
  let since = null;
  for (const s of after) since = s.state === 2 ? null : (since === null ? s.t : since);
  const stoppedFor = since === null ? 0 : last.t - since;
  if (stoppedFor >= (timing.stoppedMs || 1000) || (final && last.state !== 2))
    return { kind: "stopped", detail: last.state === 3 ? "HQPlayer is stopping playback" : "playback stopped" };

  // Progress over the trailing run, restarting after a track change (the
  // position jumps backwards) or any non-playing sample.
  let start = 0;
  for (let i = 1; i < after.length; i++) {
    if (after[i].position < after[i - 1].position - 0.5 || after[i].state !== 2) start = i;
  }
  const run = after.slice(start);
  const span = run[run.length - 1].t - run[0].t;
  if (span < timing.healthyMs) return final ? judgeSpeed(run, timing, true) : { kind: "pending" };
  return judgeSpeed(run, timing, final);
}

function judgeSpeed(run, timing, final) {
  const a = run[0];
  const b = run[run.length - 1];
  const wall = (b.t - a.t) / 1000;
  if (wall <= 0) return final ? { kind: "inconclusive", detail: "too few samples" } : { kind: "pending" };
  const speed = (b.position - a.position) / wall;
  if (speed >= timing.minSpeed) return { kind: "playing" };
  // Consistently slow for twice the healthy window: no need to wait for the deadline.
  if (!final && b.t - a.t < 2 * timing.healthyMs) return { kind: "pending" };
  return speed <= 0.05
    ? { kind: "stopped", detail: "position is not advancing" }
    : { kind: "struggling", detail: "playing at " + (speed * 100).toFixed(0) + "% of real time" };
}

/** Sample until a verdict is reached or time runs out. */
async function watchPlayback(sample, timing) {
  const t0 = Date.now();
  const samples = [];
  for (;;) {
    const s = await sample();
    const t = Date.now() - t0;
    samples.push({ t, state: s.state, position: s.position });
    const v = judge(samples, timing, t >= timing.maxMs);
    if (v.kind !== "pending") return v;
    await new Promise((r) => setTimeout(r, timing.sampleMs));
  }
}

module.exports = { DEFAULT_TIMING, MAJOR_TIMING, judge, watchPlayback };
