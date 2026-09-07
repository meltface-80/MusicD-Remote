"use strict";
/*
 * waveform.js — turning decoded audio into the handful of numbers a progress
 * bar can draw, with no I/O and no ffmpeg, so all of it is testable in node.
 *
 * The shape of the problem:
 *
 *   ffmpeg hands us signed 16-bit interleaved PCM on a pipe, in chunks of
 *   whatever size the OS feels like. We do not know the track's length up front
 *   (a container's header can lie, and ffmpeg will happily decode past it), and
 *   we want a fixed number of buckets at the end regardless.
 *
 *   So this accumulates at a FIXED STRIDE while the audio streams — one level
 *   per `stride` samples, which at the rate lib/waveform-decode asks for is one
 *   every 10ms — and resamples that down to the final bucket count once the
 *   length is known. A five-minute track holds ~30,000 intermediate values, so
 *   the memory cost is a rounding error and nothing has to be buffered whole.
 *
 * WHAT A STORED VALUE IS: the RMS of that slice of the track. Nothing else, at
 * any scale.
 *
 * It took two wrong answers to arrive there, and both are worth stating because
 * both looked right.
 *
 *   It began as the loudest SAMPLE in the slice, which on a modern master draws
 *   a BRICK: a limiter puts something on the ceiling inside almost any window
 *   you care to name, so the answer to "was anything loud in here?" is yes
 *   everywhere and every bar comes out the same height. That is what v1.7.90
 *   through v1.8.22 drew.
 *
 *   Measuring an RMS and then keeping the loudest one is the same mistake one
 *   layer down — two rounds of "the loudest moment in here" over a second and a
 *   half is very nearly a constant.
 *
 * SO THE REDUCTION IS THE SAME STATISTIC AS THE MEASUREMENT. Combining RMS
 * values by RMS — sqrt of the mean of the squares — is not an average of peaks
 * and loses nothing: it is EXACTLY the RMS of the whole span, so a value folded
 * twice equals the value computed once over the same audio. That is what makes
 * the picture independent of how many times it was folded — here, and again in
 * the browser, which folds the stored buckets down to the bars it can draw.
 *
 * The rule the first version broke was never "prefer peaks"; it was DO NOT
 * AVERAGE PEAKS, which this does not do. Whatever the statistic is, ask what it
 * saturates at, and reduce with the same one at every scale.
 */

/*
 * The stored resolution.
 *
 * 1000 was chosen against a phone drawing ~190 bars and is not enough any more:
 * the bars are drawn at device-pixel pitch now, so a phone asks for ~360 and
 * the wall display well over a thousand — at which point 1000 buckets is being
 * STRETCHED and the extra bars show nothing that is not already in their
 * neighbours. 4000 costs one byte each, so a track is 4 KB, and the decode is
 * not touched by it at all: the buckets are a resample of an intermediate that
 * was going to be computed anyway.
 */
const BUCKETS = 4000;

/*
 * The window each intermediate level is taken over, in MILLISECONDS rather than
 * samples — the decode rate has moved twice already, and a stride in samples
 * silently means a different length of time when it does.
 *
 * 10ms is short enough that a snare registers as its own level rather than
 * being smoothed into the one around it, and it is finer than any bucket: a
 * five-minute track at 4000 buckets is 75ms a bucket.
 */
const LEVEL_MS = 10;

/*
 * The default when a caller does not say — 10ms of stereo at the rate
 * lib/waveform-decode asks for. Anything that cares passes its own, and the
 * decoder always does, computed from the rate and the channel count so the two
 * cannot drift.
 */
const STRIDE = 882;

/*
 * The generation of the ANALYSIS, stored beside every waveform.
 *
 * The decode rate was already recorded, because a shape measured at a different
 * rate is a different shape. So is a shape measured with a different STATISTIC,
 * and nothing said so — which would have left every track analysed before this
 * release drawing the old brick for ever, since a stored row is never decoded
 * again. Bump it whenever the numbers would come out different for audio that
 * has not changed:
 *
 *   1 — the loudest SAMPLE in each slice, mono downmix (v1.7.90–v1.8.22)
 *   2 — the RMS of the slice, reduced by RMS, from BOTH channels
 */
const WAVE_GEN = 2;

/**
 * A streaming level accumulator. Feed it PCM as it arrives; ask for buckets at
 * the end.
 *
 * @param {object} [opts]
 * @param {number} [opts.stride] samples per intermediate level
 */
function createPeaks(opts) {
  const stride = (opts && opts.stride) || STRIDE;
  const peaks = [];      // one RMS level per `stride` samples
  let sum = 0;           // sum of squares within the current stride
  let n = 0;             // samples seen in the current stride
  // A chunk can split a 16-bit sample down the middle, so a stray byte is
  // carried into the next push rather than being read as half a sample.
  let odd = null;

  // The level of the stride just finished. Guarded on n because finish() calls
  // this for a partial stride, and a stride of no samples has no level — it
  // would be 0/0.
  function level() { return n > 0 ? Math.sqrt(sum / n) : 0; }

  function sample(v) {
    // SQUARED, so the sign goes away on its own. The old code took |v| and
    // capped it at 32767, because -32768 has no positive twin in int16 and one
    // uncapped sample per track would have been the maximum normalise() divides
    // by — quietly shrinking every other bar. Squaring has no such edge:
    // (-32768)² is an ordinary number, and the loudest a stride can possibly
    // read is full scale.
    sum += v * v;
    if (++n >= stride) { peaks.push(level()); sum = 0; n = 0; }
  }

  return {
    /** @param {Buffer} buf signed 16-bit little-endian PCM, interleaved */
    push(buf) {
      if (!buf || !buf.length) return;
      let i = 0;
      if (odd !== null) {
        sample(((buf[0] << 8) | odd) << 16 >> 16);
        odd = null;
        i = 1;
      }
      const end = buf.length - 1;
      for (; i < end; i += 2) sample(buf.readInt16LE(i));
      if (i === buf.length - 1) odd = buf[i];
    },
    /**
     * @param {number} [buckets]
     * @returns {Uint8Array} 0-255 per bucket, normalised so the loudest is 255
     */
    finish(buckets) {
      if (n > 0) peaks.push(level());   // the partial stride at the end is still audio
      return normalise(resample(peaks, buckets || BUCKETS));
    },
    /** For tests and diagnostics. */
    get raw() { return peaks; },
  };
}

/**
 * Reduce a run of levels to exactly `buckets` values, BY THE SAME STATISTIC
 * THEY ARE: sqrt of the mean of the squares, which is exactly the RMS of the
 * whole span. Folding twice therefore gives what folding once would have, and
 * the drawn shape does not depend on how many times it passed through here.
 *
 * NOT the maximum, which is what shipped and what flattened the picture: the
 * loudest moment in a second and a half of a limited record is the same number
 * everywhere in it. NOT the mean either — averaging LEVELS is not averaging
 * peaks, but the mean of RMS values is not the RMS of anything.
 *
 * Shorter input than buckets is stretched (nearest), so a two-second clip still
 * fills the bar instead of drawing a stub.
 */
function resample(peaks, buckets) {
  const out = new Array(buckets).fill(0);
  if (!peaks.length) return out;
  if (peaks.length <= buckets) {
    for (let i = 0; i < buckets; i++) {
      out[i] = peaks[Math.min(peaks.length - 1, Math.floor(i * peaks.length / buckets))];
    }
    return out;
  }
  for (let i = 0; i < buckets; i++) {
    const a = Math.floor(i * peaks.length / buckets);
    const b = Math.min(peaks.length, Math.max(a + 1, Math.floor((i + 1) * peaks.length / buckets)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += peaks[j] * peaks[j];
    out[i] = Math.sqrt(sum / (b - a));
  }
  return out;
}

/**
 * Scale so the loudest bucket is 255.
 *
 * PER TRACK, deliberately. A bar drawn from absolute level would leave a
 * quietly-mastered record as a flat line next to a loud one — the comparison is
 * true but it is not what the control is for, which is seeing the shape of the
 * track you are listening to.
 *
 * Silence stays silence: an all-zero track normalises to all zeros rather than
 * dividing by nothing.
 */
function normalise(peaks) {
  const out = new Uint8Array(peaks.length);
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  // Explicit rather than relying on the fallthrough. A zero max would make
  // every bucket 0*255/0 = NaN, and Uint8Array happens to coerce NaN to 0, so
  // the OUTPUT would be right by accident — this says so on purpose instead.
  if (max <= 0) return out;
  for (let i = 0; i < peaks.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(peaks[i] * 255 / max)));
  }
  return out;
}

/** Base64, so a row is a TEXT column like everything else in this database. */
function encode(u8) { return Buffer.from(u8).toString("base64"); }

/**
 * @returns {Uint8Array} empty for anything unparseable — never throws.
 *
 * The type guard is the whole defence and it is enough: Buffer.from(x,
 * "base64") throws only for a non-string, and skips junk characters silently
 * for a string. A try/catch round it would be unreachable code, which is worse
 * than none — it reads as though a case is handled that never arrives.
 */
function decode(s) {
  if (typeof s !== "string" || !s) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * The identity a waveform is stored under.
 *
 * Album key + canonical title, mirroring album_tracks.tkey — NEVER an offset.
 * Offsets are positions in a list that reshuffles on every library change, and
 * these rows are meant to outlive many of those.
 */
function trackKey(albumKey, title) {
  const a = String(albumKey || "").toLowerCase().trim();
  const t = String(title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return a && t ? a + " " + t : "";
}

module.exports = { BUCKETS, STRIDE, LEVEL_MS, WAVE_GEN, createPeaks, resample,
                   normalise, encode, decode, trackKey };
