"use strict";
// ---------------------------------------------------------------------------
// lib/waveform.js — the level maths, with no ffmpeg and no disk.
//
// Everything here is arithmetic on buffers, which is exactly why it lives in a
// module of its own: the decode is a subprocess and the storage is SQLite, and
// neither of those is a thing worth mocking to find out whether a resample
// picked the right bucket.
//
// WHAT THESE PIN, above any individual assertion: a stored value is the RMS of
// its slice of the track, and every reduction of it is by the same statistic.
// That is the whole of the accuracy claim — measure loudness, fold loudness the
// way loudness folds — and the two shapes it replaced (the loudest sample in a
// slice, and the loudest RMS in a slice) both drew a brick on a modern master.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("../../lib/waveform");

// s16le mono PCM from a function of sample index.
function pcm(n, fn) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fn(i)))), i * 2);
  }
  return b;
}

test("peaks follow the shape of the audio", async (t) => {
  await t.test("silence stays silent, loud reads loud", () => {
    const acc = w.createPeaks();
    acc.push(pcm(16000, i => (i < 8000 ? 0 : 20000 * Math.sin(i / 3))));
    const p = acc.finish(20);
    assert.equal(p.length, 20);
    assert.equal(Math.max(...p.slice(0, 10)), 0, "the silent half is not silent");
    assert.equal(Math.max(...p.slice(10)), 255, "the loud half did not normalise to full");
  });

  await t.test("a quiet track still fills the bar", () => {
    // Normalisation is PER TRACK on purpose: a quietly-mastered record should
    // show its shape, not be a flat line because something else was louder.
    const acc = w.createPeaks();
    acc.push(pcm(8000, i => 300 * Math.sin(i / 5)));   // ~1% of full scale
    const p = acc.finish(16);
    assert.equal(Math.max(...p), 255,
      "a quiet track normalised to " + Math.max(...p) + " — it would draw as a hairline");
  });

  await t.test("digital silence does not divide by zero", () => {
    const acc = w.createPeaks();
    acc.push(pcm(4000, () => 0));
    const p = acc.finish(8);
    assert.equal(p.length, 8);
    assert.ok([...p].every(v => v === 0), "silence produced " + [...p].join(","));
  });

  await t.test("a full-scale negative run reads as full scale, not above it", () => {
    // -32768 is the only sample whose magnitude is not a valid int16, and the
    // peak version of this had to cap it by hand: |-32768| is 32768 in JS, one
    // above full scale, and normalise() divides everything by the maximum, so
    // one such sample quietly shrank every other bar in the track.
    //
    // Squaring has no such edge — this asserts the edge is GONE rather than
    // handled, which is why the cap could be deleted rather than kept.
    const acc = w.createPeaks({ stride: 4 });
    acc.push(pcm(4, () => -32768));
    assert.equal(acc.raw.length, 1);
    assert.equal(acc.raw[0], 32768,
      "a run of full-scale negative samples read as " + acc.raw[0] + ", not its own RMS");
  });

  await t.test("THE one: a level is the RMS of its slice, not its loudest sample", () => {
    // The difference between a shape and a brick. A slice that is one sample of
    // full scale and 999 of silence is very quiet audio; the old measurement
    // called it maximally loud, which on a limited master is every slice.
    const acc = w.createPeaks({ stride: 1000 });
    acc.push(pcm(1000, i => (i === 0 ? 32767 : 0)));
    const one = acc.raw[0];
    assert.ok(one < 32767 / 10,
      "a slice of one loud sample in a thousand read as " + Math.round(one) +
      " — that is the loudest SAMPLE, not the level, and it draws a brick");
    // sqrt(32767² / 1000) ≈ 1036
    assert.ok(Math.abs(one - Math.sqrt(32767 * 32767 / 1000)) < 1,
      "the level came out at " + one + ", which is not the RMS of that slice");
  });

  await t.test("out-of-phase channels do not cancel", () => {
    // WHY THE DECODE ASKS FOR TWO CHANNELS. Interleaved L/R where R = -L is a
    // perfectly loud passage; a mono downmix averages it to nothing. The
    // accumulator has to read the pair as loud, or -ac 2 would buy nothing.
    const acc = w.createPeaks({ stride: 8 });
    acc.push(pcm(8, i => (i % 2 === 0 ? 20000 : -20000)));
    assert.equal(Math.round(acc.raw[0]), 20000,
      "an out-of-phase stereo pair read as " + Math.round(acc.raw[0]) +
      " — a wide or phase-flipped mix would draw quieter than it is");
  });
});

test("a chunk boundary in the middle of a sample loses nothing", () => {
  // ffmpeg writes to a pipe; the OS splits it wherever it likes, including
  // between the two bytes of one sample. Feeding the same audio one byte at a
  // time has to give the same answer as feeding it whole.
  const buf = pcm(6000, i => 15000 * Math.sin(i / 7));
  const whole = w.createPeaks();
  whole.push(buf);
  const split = w.createPeaks();
  for (let i = 0; i < buf.length; i++) split.push(buf.subarray(i, i + 1));
  assert.deepEqual([...split.finish(32)], [...whole.finish(32)],
    "byte-at-a-time delivery produced a different waveform");
});

test("resampling folds levels the way levels fold", async (t) => {
  await t.test("THE one: folding twice equals folding once", () => {
    // The property that makes the picture independent of how many times it
    // passed through here — the browser folds the stored buckets again to reach
    // the bars it can draw, and the answer has to be the same shape it would
    // have been had the track been analysed straight into that many.
    //
    // True of RMS and of max; NOT true of the mean, and the mean is the obvious
    // wrong turn once "do not average peaks" stops applying.
    const levels = Array.from({ length: 1200 }, (_, i) => 100 + 900 * Math.abs(Math.sin(i / 37)));
    const once = w.resample(levels, 12);
    const twice = w.resample(w.resample(levels, 120), 12);
    for (let i = 0; i < once.length; i++) {
      assert.ok(Math.abs(once[i] - twice[i]) < 1e-9,
        "bucket " + i + " came out " + twice[i] + " folded twice and " + once[i] +
        " folded once — the drawn shape depends on how many bars fit the screen");
    }
  });

  await t.test("a bucket is the RMS of its span, not its loudest member", () => {
    // What 0.4.53 of the server found the hard way: measuring an RMS and then
    // keeping the loudest one is the brick again, one layer down. The loudest
    // ten-millisecond window inside a second and a half of a limited record is
    // the same number in every second and a half of it.
    const spike = new Array(1000).fill(10);
    spike[500] = 1000;
    const out = w.resample(spike, 10);
    const bucket = out[5];
    assert.ok(bucket < 1000,
      "the bucket holding the spike came out at its maximum (" + bucket + ") — " +
      "a quiet bar with one loud moment in it is a quiet bar");
    // sqrt((99*10² + 1000²) / 100) ≈ 100.5
    assert.ok(Math.abs(bucket - Math.sqrt((99 * 100 + 1000000) / 100)) < 1e-6,
      "bucket 5 is " + bucket + ", which is not the RMS of its span");
  });

  await t.test("a spike still lifts the bucket it is in", () => {
    // The other half of the same claim, and the reason the mean is not good
    // enough either: a snare has to be visible above the bar it sits in.
    const flat = new Array(1000).fill(10);
    const spike = flat.slice();
    spike[500] = 1000;
    const a = w.resample(flat, 10), b = w.resample(spike, 10);
    assert.ok(b[5] > a[5] * 5,
      "the spike lifted its bucket from " + a[5] + " only to " + b[5] +
      " — it has been averaged away, which is the one thing a waveform is for");
  });

  await t.test("shorter than the bar is stretched, not left as a stub", () => {
    const out = w.resample([5, 9], 8);
    assert.equal(out.length, 8);
    assert.ok(out.every(v => v > 0),
      "a two-second clip drew a stub instead of filling the bar: " + out.join(","));
  });

  await t.test("empty input is empty output, not a crash", () => {
    assert.deepEqual(w.resample([], 4), [0, 0, 0, 0]);
  });
});

test("the analysis is stamped, so a change cannot go unnoticed", async (t) => {
  await t.test("the constants are the ones the store was written against", () => {
    // These three ARE the stamp index.js writes beside the table (with the
    // decode rate and channel count). If any of them moves, every stored row is
    // a different measurement of the same audio and has to be thrown away —
    // this is the line that makes that a deliberate act rather than a surprise.
    assert.equal(w.WAVE_GEN, 2, "the analysis generation moved without the store being cleared");
    assert.equal(w.BUCKETS, 4000);
    assert.equal(w.LEVEL_MS, 10);
  });

  await t.test("the default stride really is one level per LEVEL_MS", () => {
    // 10ms of 44.1 kHz stereo. Stated as a number for the callers that do not
    // pass their own; the decoder computes it from the rate and the channel
    // count, and the two have to agree or a level silently means a different
    // length of time depending on who asked.
    assert.equal(w.STRIDE, Math.round(44100 * 2 * w.LEVEL_MS / 1000));
  });
});

test("a stored waveform survives the round trip", async (t) => {
  await t.test("encode/decode is lossless", () => {
    const src = w.normalise([0, 128, 255, 7, 99]);
    assert.deepEqual([...w.decode(w.encode(src))], [...src]);
  });

  await t.test("a corrupt or missing row reads as no waveform", () => {
    // These rows outlive library rebuilds and app versions; one bad value must
    // mean "draw the plain bar", never an exception on the render path.
    // The non-string cases are the ones that would actually throw — a string of
    // junk does not, because Buffer.from skips characters outside the alphabet.
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.doesNotThrow(() => w.decode(bad), "decode threw on " + JSON.stringify(bad));
      assert.equal(w.decode(bad).length, 0, "decode(" + JSON.stringify(bad) + ") was not empty");
    }
    assert.equal(w.decode("").length, 0);
  });
});

test("the storage key is identity, never a position", async (t) => {
  await t.test("case and spacing do not make a second row", () => {
    assert.equal(w.trackKey("Kind of Blue", "So What"),
                 w.trackKey("kind of blue", "  so   what "));
  });

  await t.test("a missing half yields no key at all", () => {
    // Better to skip the lookup than to write a row under "" that every
    // untitled track would then share.
    assert.equal(w.trackKey("", "So What"), "");
    assert.equal(w.trackKey("Kind of Blue", ""), "");
    assert.equal(w.trackKey(null, null), "");
  });

  await t.test("different tracks on one album do not collide", () => {
    assert.notEqual(w.trackKey("a", "one"), w.trackKey("a", "two"));
  });
});
