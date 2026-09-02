"use strict";
// ---------------------------------------------------------------------------
// lib/waveform.js — the peak maths, with no ffmpeg and no disk.
//
// Everything here is arithmetic on buffers, which is exactly why it lives in a
// module of its own: the decode is a subprocess and the storage is SQLite, and
// neither of those is a thing worth mocking to find out whether a resample
// picked the right bucket.
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

  await t.test("no peak can exceed full scale", () => {
    // -32768 is the only sample whose magnitude is not a valid int16. In JS
    // -(-32768) is 32768, so it does not wrap — but it does land one above full
    // scale, and normalise() divides everything by the maximum. One such sample
    // would scale the whole track down by that ratio for no reason.
    const acc = w.createPeaks({ stride: 4 });
    acc.push(pcm(4, () => -32768));
    assert.equal(acc.raw.length, 1);
    assert.ok(acc.raw[0] > 0, "full-scale negative read as " + acc.raw[0]);
    assert.ok(acc.raw[0] <= 32767,
      "a peak of " + acc.raw[0] + " is above int16 full scale, so every other " +
      "sample in the track normalises against a ceiling that cannot be reached");
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

test("resampling keeps peaks instead of averaging them away", async (t) => {
  await t.test("a lone spike survives being squashed", () => {
    // THE reason this takes max and not mean. A snare in a quiet bar is one
    // value among hundreds; averaging erases it, which is the one thing a
    // waveform exists to show.
    const peaks = new Array(1000).fill(10);
    peaks[500] = 1000;
    const out = w.resample(peaks, 10);
    assert.equal(Math.max(...out), 1000, "the spike was averaged away: " + out.join(","));
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
