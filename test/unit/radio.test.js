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
const { radioDecision } = require("../../lib/radio");

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

  await t.test("plenty left — nothing to do", () => {
    assert.equal(radioDecision(zone({ queue_items_remaining: 2 }), true), null);
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
