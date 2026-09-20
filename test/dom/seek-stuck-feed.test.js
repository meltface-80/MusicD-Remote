"use strict";
// ---------------------------------------------------------------------------
// v1.8.29: the progress bar against a zone feed that has stopped moving.
//
// Reported as "0 to 4 seconds then returns to 0, and repeats all the time".
// That period is not a coincidence — it is this code's own arithmetic:
//
//   the position is a BASE plus elapsed wall clock (v1.7.69), and the poll
//   re-baselines to the server whenever the two disagree by more than 3s.
//   If the server's seek_position never advances, the local clock counts up,
//   crosses 3s, gets yanked back to the same stale number, and starts again.
//   A ~4s sawtooth, forever.
//
// The reconcile was doing exactly what it was written to do. What it lacked
// was any notion that a repeated value is not news: it treated "the server
// says 0 again" as evidence worth overriding a clock with, when a zone that
// reports the same position twice while claiming to play is a stuck feed, and
// the wall clock is the better answer.
//
// Three fixtures, because a fix here can fail in two opposite directions:
//
//   live   — a healthy feed must stay smooth (no over-correcting);
//   frozen — the reported bug: the bar must keep going, with no snap-back;
//   jump   — an external seek from Roon's own app must STILL be followed,
//            which is the whole reason the reconcile exists. A "fix" that
//            simply stopped trusting the server would pass `frozen` and
//            quietly break this one.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

function stubFor(mode) {
  return `
window.__t0 = Date.now();
window.__mode = ${JSON.stringify(mode)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
function zoneNow() {
  var elapsed = (Date.now() - window.__t0) / 1000;
  var pos;
  if (window.__mode === "live")        pos = elapsed;
  // A zone cache whose seek updates never land: the position the server
  // reports is the one the track started at, poll after poll.
  else if (window.__mode === "frozen") pos = 0;
  // Someone seeked to 100s in Roon's own app 8s in — the feed keeps MOVING,
  // just from a new origin.
  else if (window.__mode === "jump")   pos = elapsed < 8 ? elapsed : 100 + (elapsed - 8);
  else pos = elapsed;
  return { zone_id: "z1", display_name: "Zone", state: "playing", is_seek_allowed: true,
           outputs: [{ output_id: "o1", display_name: "Zone", is_muted: false,
                       volume: { type: "number", min: 0, max: 100, value: 45, step: 1, is_muted: false } }],
           now_playing: { line1: "Steam Train", line2: "Baby Bird", line3: "Bad Shave",
                          length: 600, seek_position: pos, image_key: "k" } };
}
window.__installFetch(function (u) {
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: zoneNow() });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [zoneNow()] });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

// Samples the seek slider over ~20s of page time. Every number comes from the
// same element read in the same driver, so nothing here compares a value taken
// at one moment against one taken at another.
const DRIVER = `
  await window.__sleep(900);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(600);
  T("slider_found", !!document.getElementById("np-seek"));
  var samples = [];
  for (var i = 0; i < 40; i++) {
    await window.__sleep(500);
    var s = document.getElementById("np-seek");
    samples.push(s ? Number(s.value) : null);
  }
  T("samples", samples);
`;

function run(mode) {
  const r = harness.renderPage({ stub: stubFor(mode), driver: DRIVER,
                                 name: "seek-" + mode, windowSize: "390x844", budgetMs: 40000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.slider_found, true, "the now-playing seek bar never appeared (" + mode + ")");
  assert.ok(r.samples && r.samples.length === 40, "the driver did not finish sampling (" + mode + ")");
  return r.samples;
}

// A drop of more than half a second, which no forward-running clock produces.
function backwardsJumps(vals) {
  let n = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1] - 0.5) n++;
  return n;
}

test("the progress bar against a zone feed that has stopped moving", { concurrency: 1 }, async (t) => {
  await t.test("a healthy feed runs smoothly and never goes backwards", () => {
    const vals = run("live");
    assert.equal(backwardsJumps(vals), 0,
      "the bar went backwards on a HEALTHY feed: " + vals.join(" "));
    assert.ok(vals[vals.length - 1] - vals[0] >= 12,
      "the bar barely moved over 20s of playback: " + vals.join(" "));
  });

  await t.test("a stuck feed does not sawtooth — THE reported bug", () => {
    const vals = run("frozen");
    const drops = backwardsJumps(vals);
    assert.equal(drops, 0,
      "the bar snapped backwards " + drops + " times against a stuck feed — the 0-to-4-and-" +
      "back-to-0 sawtooth. The poll is re-baselining to a seek_position that has not moved " +
      "since the last poll, which is a stuck feed rather than new information.\\n  " +
      vals.join(" "));
    // Not just "no drops" — a bar frozen at 0 also has no drops, and would be
    // its own bug. The clock must actually be running.
    assert.ok(vals[vals.length - 1] - vals[0] >= 12,
      "the bar stopped advancing altogether against a stuck feed: " + vals.join(" "));
  });

  await t.test("an external seek is still followed", () => {
    // The guard on the fix itself. Ignoring the server outright would pass the
    // test above and break this one.
    const vals = run("jump");
    assert.ok(Math.max(...vals) >= 100,
      "a seek to 100s from another remote was never picked up — the reconcile has been " +
      "disabled rather than narrowed: " + vals.join(" "));
    const landed = vals.findIndex(v => v >= 100);
    assert.ok(landed > 0 && landed < vals.length - 2,
      "the jump was followed, but not promptly: " + vals.join(" "));
    // And having followed it, it keeps running from the new origin.
    assert.ok(vals[vals.length - 1] > vals[landed],
      "the bar stalled after following the seek: " + vals.join(" "));
  });
});
