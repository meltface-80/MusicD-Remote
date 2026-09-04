"use strict";
/*
 * waveform.js — turning decoded audio into the handful of numbers a progress
 * bar can draw, with no I/O and no ffmpeg, so all of it is testable in node.
 *
 * The shape of the problem:
 *
 *   ffmpeg hands us signed 16-bit mono PCM on a pipe, in chunks of whatever
 *   size the OS feels like. We do not know the track's length up front (a
 *   container's header can lie, and ffmpeg will happily decode past it), and we
 *   want a fixed number of buckets at the end regardless.
 *
 *   So this accumulates at a FIXED STRIDE while the audio streams — one peak
 *   per `stride` samples, which for the 16 kHz decode is ~62 values a
 *   second — and resamples that down to the final bucket count once the length
 *   is known. A five-minute track holds ~18,750 intermediate values, so the
 *   memory cost is a rounding error and nothing has to be buffered whole.
 *
 * Why peak and not RMS: a progress bar wants the track's SHAPE — where the
 * quiet intro ends, where the loud middle is. RMS flattens exactly that.
 */

// The stored resolution. 1000 is finer than any bar this app draws (the phone
// is ~390px, the wall display ~1920 and stretches), and it costs one byte per
// bucket, so a track is 1 KB. Changing this invalidates nothing — stored rows
// carry their own length and the renderer resamples — but it does mean two
// tracks analysed either side of the change hold different-sized blobs.
const BUCKETS = 1000;

// One intermediate peak per this many input samples. Left at 256 when the
// decode moved from 8 kHz to 16 kHz, so each peak now covers ~16ms rather than
// ~32ms — twice the time resolution, free, and comfortably short enough that a
// snare still registers as its own peak. A five-minute track holds ~18,750 of
// these before they are reduced to the stored bucket count, so there is ample
// headroom above it.
const STRIDE = 256;

/**
 * A streaming peak accumulator. Feed it PCM as it arrives; ask for buckets at
 * the end.
 *
 * @param {object} [opts]
 * @param {number} [opts.stride] samples per intermediate peak
 */
function createPeaks(opts) {
  const stride = (opts && opts.stride) || STRIDE;
  const peaks = [];      // intermediate maxima, one per `stride` samples
  let cur = 0;           // running max within the current stride
  let n = 0;             // samples seen in the current stride
  // A chunk can split a 16-bit sample down the middle, so a stray byte is
  // carried into the next push rather than being read as half a sample.
  let odd = null;

  function sample(v) {
    // |v|, capped at 32767. NOT because negating -32768 wraps — this is
    // JavaScript, where -(-32768) is a perfectly good 32768 — but so a peak is
    // always a real int16 magnitude. Without the cap one sample per track can
    // exceed full scale, and since normalise() divides by the maximum, that one
    // sample would quietly scale the entire waveform down.
    const a = v < 0 ? (v === -32768 ? 32767 : -v) : v;
    if (a > cur) cur = a;
    if (++n >= stride) { peaks.push(cur); cur = 0; n = 0; }
  }

  return {
    /** @param {Buffer} buf signed 16-bit little-endian mono PCM */
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
      if (n > 0) peaks.push(cur);   // the partial stride at the end is still audio
      return normalise(resample(peaks, buckets || BUCKETS));
    },
    /** For tests and diagnostics. */
    get raw() { return peaks; },
  };
}

/**
 * Reduce a run of peaks to exactly `buckets` values, by taking the MAX of each
 * span rather than the mean — averaging peaks turns a sharp track into mush,
 * which is the one thing a waveform is for.
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
    const b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / buckets));
    let m = 0;
    for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
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

module.exports = { BUCKETS, STRIDE, createPeaks, resample, normalise, encode, decode, trackKey };
