"use strict";
// ---------------------------------------------------------------------------
// v1.7.77: what a zone has already played.
//
// Roon's queue API can only look forward — `subscribe_queue` reports the
// current track and what is coming, and a track that has played or been
// skipped past is gone from it. The record has to be built from the zone push
// instead, at the one moment the outgoing track and its elapsed time are both
// known.
//
// That makes the rules here load-bearing in a way a display helper usually
// is not: nothing downstream can recover a departure this module drops, and
// nothing can tell a wrongly-recorded one from a real one.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { HISTORY_MAX, MULTI_MAX, playCounted, historyEntry, pushHistory, recentHistory,
        playNextSendOrder, queueSendOrder, sendOrderFor } =
  require("../../lib/queue-history");

const prev = (o) => Object.assign(
  { track: "T", artist: "A", album: "Al", image_key: "k", duration: 240, elapsed: 0 }, o);

test("played or skipped, on the scrobbler's own rule", async (t) => {
  await t.test("under 30 seconds is a skip however long the track is", () => {
    assert.equal(playCounted(prev({ elapsed: 0 })), false);
    assert.equal(playCounted(prev({ elapsed: 29, duration: 30 })), false);
    // The boundary itself counts — 30s is the floor, not the first value above it.
    assert.equal(playCounted(prev({ elapsed: 30, duration: 60 })), true);
  });

  await t.test("half the track counts", () => {
    assert.equal(playCounted(prev({ elapsed: 119, duration: 240 })), false);
    assert.equal(playCounted(prev({ elapsed: 120, duration: 240 })), true);
  });

  await t.test("four minutes counts however long the track is", () => {
    // A 20-minute side would otherwise need ten minutes before it registered.
    assert.equal(playCounted(prev({ elapsed: 240, duration: 1200 })), true);
    assert.equal(playCounted(prev({ elapsed: 239, duration: 1200 })), false);
  });

  await t.test("a track with no duration still counts on time alone", () => {
    // Roon does not always give a length (a stream). `elapsed >= duration*0.5`
    // is then trivially true, which is the right answer: 30 seconds of
    // something with no known end is not a skip.
    assert.equal(playCounted(prev({ elapsed: 30, duration: 0 })), true);
    assert.equal(playCounted(prev({ elapsed: 5, duration: 0 })), false);
  });

  await t.test("nothing at all is not a play", () => {
    assert.equal(playCounted(null), false);
    assert.equal(playCounted(undefined), false);
    assert.equal(playCounted({}), false);
  });
});

test("building an entry", async (t) => {
  await t.test("it carries what the row needs and marks the skip", () => {
    const e = historyEntry(prev({ elapsed: 12 }), 1000);
    assert.deepEqual(e, {
      track: "T", artist: "A", album: "Al", image_key: "k",
      duration: 240, elapsed: 12, played: false, ts: 1000,
    });
  });

  await t.test("elapsed is rounded and never negative", () => {
    // It is accumulated from seek deltas, so it is a float and a clock jump
    // could in principle drive it below zero.
    assert.equal(historyEntry(prev({ elapsed: 12.7 }), 1).elapsed, 13);
    assert.equal(historyEntry(prev({ elapsed: -5 }), 1).elapsed, 0);
  });

  await t.test("a track with no title is not an entry", () => {
    // A zone can report a now_playing with empty text — a stream mid-handshake,
    // a zone waking. A blank row in the fold-out is worse than a missing one.
    assert.equal(historyEntry(prev({ track: "" }), 1), null);
    assert.equal(historyEntry(prev({ track: "   " }), 1), null);
    assert.equal(historyEntry(null, 1), null);
  });

  await t.test("missing fields become empty, never undefined", () => {
    const e = historyEntry({ track: "Only a title" }, 5);
    assert.equal(e.artist, "");
    assert.equal(e.album, "");
    assert.equal(e.image_key, null);
    assert.equal(e.duration, 0);
    assert.equal(e.played, false);
  });
});

test("the ring", async (t) => {
  await t.test("appends oldest first", () => {
    let l = pushHistory(null, historyEntry(prev({ track: "one" }), 1));
    l = pushHistory(l, historyEntry(prev({ track: "two" }), 3000));
    assert.deepEqual(l.map(e => e.track), ["one", "two"]);
  });

  await t.test("it is bounded, and drops the OLDEST", () => {
    let l = [];
    for (let i = 0; i < 10; i++) l = pushHistory(l, historyEntry(prev({ track: "t" + i }), i * 3000), 4);
    assert.equal(l.length, 4);
    assert.deepEqual(l.map(e => e.track), ["t6", "t7", "t8", "t9"]);
  });

  await t.test("the default cap is the module's own", () => {
    let l = [];
    for (let i = 0; i < HISTORY_MAX + 25; i++) {
      l = pushHistory(l, historyEntry(prev({ track: "t" + i }), i * 3000));
    }
    assert.equal(l.length, HISTORY_MAX);
  });

  await t.test("the same track twice in a row, quickly, is one departure", () => {
    // A zone re-announces the same now_playing with different text as metadata
    // settles (line3 arriving late), and the caller's change test compares that
    // text — so one track can present as a change twice.
    let l = pushHistory([], historyEntry(prev({ track: "same" }), 1000));
    l = pushHistory(l, historyEntry(prev({ track: "same" }), 1500));
    assert.equal(l.length, 1);
  });

  await t.test("but the same track played again later is two", () => {
    // Repeat-one, or simply playing it again. The guard is about a stuttering
    // announcement, not about refusing to record a track twice.
    let l = pushHistory([], historyEntry(prev({ track: "same" }), 1000));
    l = pushHistory(l, historyEntry(prev({ track: "same" }), 400000));
    assert.equal(l.length, 2);
  });

  await t.test("a null entry changes nothing", () => {
    const l = pushHistory([], null);
    assert.deepEqual(l, []);
  });
});

test("what the screen is served", async (t) => {
  const build = (n) => {
    let l = [];
    for (let i = 0; i < n; i++) l = pushHistory(l, historyEntry(prev({ track: "t" + i }), i * 3000));
    return l;
  };

  await t.test("newest first, capped", () => {
    assert.deepEqual(recentHistory(build(10), 3).map(e => e.track), ["t9", "t8", "t7"]);
  });

  await t.test("asking for more than there is returns what there is", () => {
    assert.equal(recentHistory(build(2), 50).length, 2);
  });

  await t.test("it does not disturb the stored list", () => {
    // reverse() is in-place on Array. Reversing the caller's own history would
    // corrupt the ring and then the NEXT read would be wrong in a way nothing
    // else could explain.
    const l = build(4);
    const before = l.map(e => e.track);
    recentHistory(l, 4);
    assert.deepEqual(l.map(e => e.track), before);
  });

  await t.test("nothing recorded is an empty list, never null", () => {
    assert.deepEqual(recentHistory(undefined, 5), []);
    assert.deepEqual(recentHistory([], 5), []);
  });
});

// ---------------------------------------------------------------------------
// v1.7.78: several played tracks at once, in the order they were picked.
//
// Picking order is not display order, so the ONLY thing that makes the feature
// correct is sending the tracks in whatever order causes them to arrive the way
// they were chosen. That depends on how Roon's "Add Next" behaves when it is
// issued repeatedly, which is the one thing here that could not be verified
// without a live Core — and cannot be probed either, because finding out costs
// a real insert and the API has no verb to remove one again.
//
// So it is an assumption, isolated to one function and pinned here. If a build
// ever comes out backwards, this is the test that says exactly what to change.
// ---------------------------------------------------------------------------
test("the order tracks are sent in", async (t) => {
  const picks = ["first", "second", "third"];

  await t.test("play next goes out BACKWARDS, because it stacks", () => {
    // Each Add Next lands immediately after the current track, in front of the
    // one before it. Sending third, second, first is what leaves the queue
    // playing first, second, third.
    assert.deepEqual(playNextSendOrder(picks), ["third", "second", "first"]);
  });

  await t.test("adding to the end goes out forwards, because appending keeps order", () => {
    assert.deepEqual(queueSendOrder(picks), ["first", "second", "third"]);
  });

  await t.test("one function decides it, and nothing else", () => {
    assert.deepEqual(sendOrderFor("play_next", picks), playNextSendOrder(picks));
    assert.deepEqual(sendOrderFor("queue", picks), queueSendOrder(picks));
  });

  await t.test("neither disturbs the caller's list", () => {
    // The caller holds the selection and repaints from it after the send. An
    // in-place reverse would leave the numbered badges disagreeing with what
    // was actually queued.
    const src = picks.slice();
    playNextSendOrder(src); queueSendOrder(src); sendOrderFor("play_next", src);
    assert.deepEqual(src, ["first", "second", "third"]);
  });

  await t.test("a single track is the same either way", () => {
    // Worth stating: the single-tap path and a one-track selection must not
    // behave differently, and a reversal of one item hides a wrong strategy.
    assert.deepEqual(playNextSendOrder(["only"]), ["only"]);
    assert.deepEqual(queueSendOrder(["only"]), ["only"]);
  });

  await t.test("nothing at all is an empty list, never null", () => {
    for (const f of [playNextSendOrder, queueSendOrder]) {
      assert.deepEqual(f([]), []);
      assert.deepEqual(f(null), []);
      assert.deepEqual(f(undefined), []);
    }
  });

  await t.test("there is a cap, and it is a real number", () => {
    // Each track is a full browse navigation. The cap is what stops one tap
    // becoming minutes of Core traffic.
    assert.ok(Number.isInteger(MULTI_MAX) && MULTI_MAX > 1 && MULTI_MAX <= 50,
      "MULTI_MAX is " + MULTI_MAX);
  });
});
