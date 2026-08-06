"use strict";
// ---------------------------------------------------------------------------
// Random Album Radio's decision — the only thing in this extension that writes
// to a queue without a user asking.
//
// It had no tests at all, which is how v1.7.45's bug survived: a STOPPED zone
// whose payload omitted `queue_items_remaining` was treated as having an empty
// queue, and the action that follows is "play" — Roon's Play Now, which
// REPLACES the queue. So a Core that simply didn't mention the field could have
// had somebody's queue wiped and a random album started over it.
//
// `queue_items_remaining` is optional in Roon's transport payload. Absent means
// "the Core didn't say", not "there is nothing there". This project has been
// bitten by that exact confusion before — v1.7.1 documented it as «"Unknown"
// read as "none"» after an absent can_group_with_output_ids was read as
// "cannot group" — which is why it is worth a file of its own.
//
// The asymmetry that makes this safe is deliberate and is what these tests pin:
//   "queue" APPENDS, so acting on thin evidence costs an extra album;
//   "play"  REPLACES, so it may only fire on positive evidence of an empty queue.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { radioDecision, radioResumeDecision, radioQueueFloor,
        radioResumeMaxTries } = require("../../lib/radio");

// A zone, with only the fields the decision reads.
function zone(over) {
  return Object.assign({ zone_id: "z1", state: "playing", queue_items_remaining: 5 }, over || {});
}

test("radio does nothing unless it is switched on for that zone", async (t) => {
  await t.test("disabled means silence, whatever the zone is doing", () => {
    assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: 0 }), false), null);
    assert.equal(radioDecision(zone({ queue_items_remaining: 0 }), false), null);
  });

  await t.test("no zone at all is not a crash", () => {
    assert.equal(radioDecision(null, true), null);
    assert.equal(radioDecision(undefined, true), null);
  });
});

test("it stands down for Roon's own radio", async (t) => {
  await t.test("auto_radio on means Roon is handling it", () => {
    // Both filling the same queue is the one way to get a genuinely confusing
    // result — two albums interleaved from two sources.
    assert.equal(radioDecision(
      zone({ queue_items_remaining: 0, settings: { auto_radio: true } }), true), null);
    assert.equal(radioDecision(
      zone({ state: "stopped", queue_items_remaining: 0, settings: { auto_radio: true } }), true), null);
  });

  await t.test("auto_radio off, or absent, does not stand down", () => {
    assert.equal(radioDecision(
      zone({ queue_items_remaining: 1, settings: { auto_radio: false } }), true), "queue");
    assert.equal(radioDecision(zone({ queue_items_remaining: 1 }), true), "queue");
  });
});

test("while playing, it tops the queue up before it runs dry", async (t) => {
  await t.test("the last track is playing — append the next album", () => {
    // Gapless is the point: appending once the queue is already empty means a
    // silence between albums.
    assert.equal(radioDecision(zone({ queue_items_remaining: 1 }), true), "queue");
    assert.equal(radioDecision(zone({ state: "loading", queue_items_remaining: 1 }), true), "queue");
  });

  await t.test("two left also appends — the append is not instant", () => {
    // Eight sequential Roon round-trips with no parallelism stand between the
    // decision and the album actually landing. One track of audio was the
    // entire budget; if the calls outlast it the album arrives in a queue that
    // has already stopped. Two costs nothing, because "queue" only APPENDS.
    assert.equal(radioQueueFloor(), 2);
    assert.equal(radioDecision(zone({ queue_items_remaining: 2 }), true), "queue");
  });

  await t.test("plenty left — nothing to do", () => {
    assert.equal(radioDecision(zone({ queue_items_remaining: 3 }), true), null);
    assert.equal(radioDecision(zone({ queue_items_remaining: 50 }), true), null);
  });

  await t.test("an absent count while playing appends nothing", () => {
    // Safe either way here — "queue" only appends — but acting on a field the
    // Core did not send would still be inventing evidence.
    assert.equal(radioDecision(zone({ queue_items_remaining: undefined }), true), null);
  });
});

test("a stopped zone: 'play' REPLACES the queue, so it needs proof", async (t) => {
  await t.test("stopped with a genuinely empty queue starts something", () => {
    assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: 0 }), true), "play");
  });

  await t.test("stopped with tracks still queued is left alone", () => {
    // The user's queue is theirs. Whatever stopped it, replacing what they
    // lined up is not this feature's business.
    assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: 3 }), true), null);
    assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: 1 }), true), null);
  });

  await t.test("stopped with an ABSENT count is left alone", () => {
    // THE one. `queue_items_remaining` is optional in Roon's payload, so an
    // absent field means the Core did not say — not that the queue is empty.
    // Returning "play" here replaces a queue on no evidence at all.
    assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: undefined }), true), null,
      "an absent queue count was read as an empty queue, and the action that " +
      "follows REPLACES the queue");
    const noField = { zone_id: "z1", state: "stopped" };
    assert.equal(radioDecision(noField, true), null);
  });

  await t.test("a non-numeric count is absent, not zero", () => {
    // Defensive against a shape change rather than a real payload: null and a
    // string must not coerce their way into "the queue is empty".
    for (const bad of [null, "0", "", false, NaN]) {
      assert.equal(radioDecision(zone({ state: "stopped", queue_items_remaining: bad }), true), null,
        JSON.stringify(bad) + " was treated as an empty queue");
    }
  });
});

// ---------------------------------------------------------------------------
// v1.7.46. The user's report was "playback stops at the end of an album even
// when another track is queued up", and /api/radio confirmed the radio was on
// for one of their zones.
//
// The mechanism: the append fires during the last track but takes eight
// sequential Roon calls to land. If the audio runs out first, Roon stops — and
// our album arrives in a queue that is now stopped. Nothing restarted it,
// because the only start verb the radio had was Roon's browse Play Now, which
// REPLACES a queue, so it is correctly never used on a queue with items in it.
//
// "resume" is the missing third verb: the transport's play command, which
// resumes what is there. These tests pin the thing that makes it safe — it
// finishes what the extension started, and nothing else.
// ---------------------------------------------------------------------------

// The episode: state latched at the moment the stop is seen.
function ep(over) { return Object.assign({ strandedAt: 111, resumed: false }, over || {}); }

test("resuming a queue the radio stranded", async (t) => {
  await t.test("THE one: stopped, with the album we just appended sitting in it", () => {
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12 }), true, ep()), true);
  });

  await t.test("no episode means this was not our doing — never touch it", () => {
    // A user pressing Stop on a loaded queue looks IDENTICAL from the zone
    // payload; Roon carries no cause. The only discriminator is whether our
    // own append was in flight when the stop arrived, and that is what opens
    // an episode. Without one, silence.
    const z = zone({ state: "stopped", queue_items_remaining: 12 });
    assert.equal(radioResumeDecision(z, true, null), false);
    assert.equal(radioResumeDecision(z, true, {}), false);
    assert.equal(radioResumeDecision(z, true, ep({ strandedAt: 0 })), false);
  });

  await t.test("one shot per episode", () => {
    // An album that cannot play bounces straight back to stopped, and zone
    // events arrive about once a second. Without the latch that is a resume
    // command every second, indefinitely.
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12 }), true, ep({ resumed: true })), false);
  });

  await t.test("an EMPTY queue is not a resume", () => {
    // Nothing to resume; radioDecision's "play" is the right answer there, and
    // returning true here would press play on silence.
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 0 }), true, ep()), false);
  });

  await t.test("an ABSENT count is not a full queue", () => {
    // Same rule the stopped branch already follows, and the same error class
    // v1.7.1 named: "Unknown" must not be read as a value.
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: undefined }), true, ep()), false);
    assert.equal(radioResumeDecision({ zone_id: "z1", state: "stopped" }, true, ep()), false);
    // NaN is spelled out because JSON.stringify renders it as "null" — which
    // is how it hid here in the first place. It is the interesting one: NaN
    // passes `typeof x === "number"`, and every comparison against it is
    // false, so it reads as "not empty" AND "not full" at the same time.
    for (const [name, bad] of [["null", null], ['"12"', "12"], ['""', ""],
                               ["false", false], ["NaN", NaN]]) {
      assert.equal(radioResumeDecision(
        zone({ state: "stopped", queue_items_remaining: bad }), true, ep()), false,
        name + " was treated as a queue with items in it");
      assert.notEqual(radioDecision(
        zone({ state: "stopped", queue_items_remaining: bad }), true), "play",
        name + " was treated as an empty queue by the queue-replacing verb");
    }
  });

  await t.test("only a STOPPED zone is resumed", () => {
    // Paused is a user decision; playing needs nothing. Pressing play on
    // either would be overriding something deliberate.
    for (const st of ["playing", "loading", "paused", "buffering", undefined]) {
      assert.equal(radioResumeDecision(
        zone({ state: st, queue_items_remaining: 12 }), true, ep()), false, st + " was resumed");
    }
  });

  await t.test("Roon saying the zone cannot play is respected", () => {
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12, is_play_allowed: false }), true, ep()),
      false);
    // Absent means "the Core didn't say", which is not "cannot" — the same
    // rule as everywhere else in this file.
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12, is_play_allowed: undefined }), true, ep()),
      true);
  });

  await t.test("it stands down for Roon's own radio, like every other verb", () => {
    // /api/zone-settings tells the user our radio stands down when Roon Radio
    // is on. If this verb did not, that statement would simply be false — and
    // the two would be filling and starting one queue against each other.
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12,
             settings: { auto_radio: true } }), true, ep()), false);
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12,
             settings: { auto_radio: false } }), true, ep()), true);
  });

  await t.test("a refusal is allowed to be transient, but not forever", () => {
    // A resume Roon rejects (output momentarily unavailable, zone mid-regroup)
    // must not be terminal — that leaves exactly the silent-zone-with-a-full-
    // queue this verb exists to clear. But a zone that will not start must not
    // be asked once a second for the rest of the day either.
    const z = zone({ state: "stopped", queue_items_remaining: 12 });
    assert.equal(radioResumeDecision(z, true, ep({ resumeTries: 1 })), true);
    assert.equal(radioResumeDecision(
      z, true, ep({ resumeTries: radioResumeMaxTries() })), false);
    assert.equal(radioResumeDecision(
      z, true, ep({ resumeTries: radioResumeMaxTries() + 5 })), false);
  });

  await t.test("radio off, or no zone, decides nothing", () => {
    assert.equal(radioResumeDecision(
      zone({ state: "stopped", queue_items_remaining: 12 }), false, ep()), false);
    assert.equal(radioResumeDecision(null, true, ep()), false);
    assert.equal(radioResumeDecision(undefined, true, ep()), false);
  });

  await t.test("resume and the two browse verbs are mutually exclusive", () => {
    // They mean different things to a queue: append, replace, and continue.
    // A zone that qualifies for one must never qualify for another.
    const stranded = zone({ state: "stopped", queue_items_remaining: 12 });
    assert.equal(radioResumeDecision(stranded, true, ep()), true);
    assert.equal(radioDecision(stranded, true), null,
      "the queue-replacing verb was offered for a queue with music in it");

    const empty = zone({ state: "stopped", queue_items_remaining: 0 });
    assert.equal(radioDecision(empty, true), "play");
    assert.equal(radioResumeDecision(empty, true, ep()), false);
  });
});

test("states it deliberately ignores", async (t) => {
  await t.test("paused is never touched", () => {
    // Paused is a user decision. Queueing behind it or replacing it would both
    // be overriding something deliberate.
    assert.equal(radioDecision(zone({ state: "paused", queue_items_remaining: 0 }), true), null);
    assert.equal(radioDecision(zone({ state: "paused", queue_items_remaining: 1 }), true), null);
  });

  await t.test("an unknown state does nothing", () => {
    assert.equal(radioDecision(zone({ state: "buffering", queue_items_remaining: 0 }), true), null);
    assert.equal(radioDecision(zone({ state: undefined, queue_items_remaining: 0 }), true), null);
  });
});

test("the two verbs mean different things and must not be confused", async (t) => {
  await t.test("only a stopped zone can ever produce 'play'", () => {
    // "play" is the queue-replacing one. If a playing zone could produce it,
    // the radio would interrupt the music it is supposed to be extending.
    for (const st of ["playing", "loading", "paused", "buffering"]) {
      for (const n of [0, 1, 2, undefined]) {
        assert.notEqual(radioDecision(zone({ state: st, queue_items_remaining: n }), true), "play",
          st + " with remaining=" + n + " produced the queue-replacing action");
      }
    }
  });

  await t.test("only a playing or loading zone can produce 'queue'", () => {
    for (const st of ["stopped", "paused", "buffering"]) {
      for (const n of [0, 1, 2, undefined]) {
        assert.notEqual(radioDecision(zone({ state: st, queue_items_remaining: n }), true), "queue");
      }
    }
  });
});
