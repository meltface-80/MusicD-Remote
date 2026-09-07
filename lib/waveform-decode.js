"use strict";
/*
 * waveform-decode.js — get PCM out of an audio file and peaks out of the PCM.
 *
 * ffmpeg is the decoder because the library is mixed: FLAC, ALAC in m4a, AAC,
 * MP3, WAV, AIFF, and DSD in some collections. A per-format JS decoder would be
 * a stack of dependencies that still misses one.
 *
 * WHAT IS ASKED OF IT, and why each flag:
 *
 *   -v error         nothing on stderr but real failures, so the buffer below
 *                    stays small and a non-zero exit has a usable message
 *   -nostdin         never wait on a terminal that is not there
 *   -i <file>
 *   -map 0:a:0       the FIRST audio stream only. Some rips carry a second
 *                    (commentary, a different mix); without this ffmpeg picks
 *                    by its own rules and the waveform could be of the wrong one
 *   -f s16le         raw samples, no container to parse on this side
 *   -ac 2            BOTH CHANNELS. See DECODE_CHANNELS below — the mono
 *                    downmix this used to ask for is an ADDITION, and an
 *                    out-of-phase passage adds to silence
 *   -ar 44100        see DECODE_RATE below. Not a reduction any more: nearly
 *                    every source already is 44.1 kHz, so asking for it means
 *                    ffmpeg has nothing to resample and no lowpass to run
 *
 * The spawn is injected so the whole path can be tested without ffmpeg on the
 * machine, and so a test can make it fail, hang, or dribble bytes.
 */

const { createPeaks, BUCKETS, LEVEL_MS } = require("./waveform");

/*
 * The rate the audio is decoded to before levels are taken.
 *
 * 44.1 kHz, WHICH IS NOT SLOWER THAN THE 16 kHz IT REPLACED. The old reasoning
 * was that the extra PCM had to be paid for somewhere; measured, it is not,
 * because nearly every file in a library already IS 44.1 kHz and asking for it
 * means ffmpeg has nothing to resample. The same three-minute track measured
 * 134ms at 8 kHz, 141ms at 16 kHz and 133ms at 44.1 kHz — five times the bytes
 * and the same wall clock, because the anti-alias filter costs more than the
 * bytes it saves.
 *
 * And it is more honest. Dropping to 16 kHz lowpasses at 8 kHz first, so
 * cymbals and sibilance are filtered away before they can count towards the
 * level — up to 4.9% of full height on deliberately bright material. Small next
 * to what the old peak-of-the-slice reduction was costing, but it is free, so
 * there is no argument for keeping it.
 *
 * CHANGING THIS INVALIDATES EVERY STORED WAVEFORM. Rows analysed at a different
 * rate have genuinely different shapes, and a library holding both would draw
 * two kinds of picture with no way to tell which is which — see the analysis
 * check in index.js, which clears the table when this value, the channel count
 * or WAVE_GEN moves.
 */
const DECODE_RATE = 44100;

/*
 * BOTH CHANNELS, because a downmix is an ADDITION and additions cancel.
 *
 * `-ac 1` does not take the louder of the two, whatever the comment above it
 * used to claim — ffmpeg averages them. On a stereo file whose channels are
 * inverted against each other the mono downmix comes back at RMS 0, dead
 * silence, where the two channels together are RMS 2896. Any record with a
 * phase-flipped or heavily decorrelated passage — a wide mix, a mid/side
 * master, an out-of-phase reissue — reads quieter than it is, and in the limit
 * reads as nothing at all.
 *
 * NOTHING IN THE ACCUMULATOR HAS TO KNOW. It sums the square of every sample
 * and divides by how many there were, and the root of the mean of L² and R²
 * over a window IS the level of the pair — so interleaved stereo falls out
 * correctly on its own. The only thing that changes is that a window of ten
 * milliseconds now holds twice as many samples, which is why the stride below
 * is computed from this.
 *
 * A mono source is unaffected: `-ac 2` hands back the same channel twice, and
 * the sum and the count both double.
 */
const DECODE_CHANNELS = 2;

/*
 * How much of a track has to actually decode for the shape to be about it.
 *
 * A waveform is a map from TIME to a picture: bucket 2000 of 4000 is the middle
 * of the track, and the playhead is drawn on that assumption. Decode only the
 * first two thirds of a file — a truncated download, a damaged rip ffmpeg gives
 * up on, a stream cut off — and those two thirds are stretched across the whole
 * bar. Nothing about it LOOKS wrong: the shape is real audio, in the right
 * order, at the right relative levels. It is simply about a different moment
 * than the one you are hearing, by a margin that grows through the track, and
 * it is written to the database as though it were the answer.
 *
 * So the caller may say how long the track is, and a decode falling short of
 * this fraction of it is no waveform at all. The plain bar tells the truth; a
 * confidently wrong shape does not.
 *
 * 0.9 rather than something tighter because the two numbers come from different
 * places — Roon's metadata, or a streaming service's, against what ffmpeg
 * actually decoded — and a second of disagreement on a three-minute track is
 * ordinary. Two thirds of a track is not.
 */
const MIN_COVERAGE = 0.9;

// Long enough for a 20-minute lossless track on a slow ARM box, short enough
// that a wedged process cannot hold a prefetch slot for the life of the server.
const DEFAULT_TIMEOUT_MS = 90000;

/** Where ffmpeg is. Resolved once, lazily, and cached — including the failure. */
let _ffmpegPath;
function ffmpegPath() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  // The npm binary first: it is pinned with the app, so the waveform does not
  // depend on what the host image happens to ship. A system ffmpeg on PATH is
  // the fallback for anyone running outside Docker.
  try {
    const p = require("ffmpeg-static");
    _ffmpegPath = (typeof p === "string" && p) ? p : "ffmpeg";
  } catch (e) {
    _ffmpegPath = "ffmpeg";   // not installed: hope for one on PATH
  }
  return _ffmpegPath;
}

function args(file) {
  return ["-v", "error", "-nostdin", "-i", file,
          "-map", "0:a:0", "-f", "s16le", "-ac", String(DECODE_CHANNELS),
          "-ar", String(DECODE_RATE), "-"];
}

/*
 * The same decode, reading from a pipe instead of a path.
 *
 * For a streaming track there is no file and there must not be one: the bytes
 * come off an HTTPS response, through ffmpeg, and out as a few thousand
 * numbers. Writing them down first and deleting them afterwards would be a
 * promise to keep — one that a crash mid-track breaks — where piping is simply
 * a fact about how the data moved. It is also faster, because the decode
 * overlaps the download instead of waiting for it.
 *
 * `-nostdin` is dropped here for the obvious reason: stdin is the input.
 */
function pipeArgs() {
  return ["-v", "error", "-i", "pipe:0",
          "-map", "0:a:0", "-f", "s16le", "-ac", String(DECODE_CHANNELS),
          "-ar", String(DECODE_RATE), "-"];
}

/**
 * Decode a file and return its waveform.
 *
 * Resolves to a Uint8Array of `buckets` values, or null when the file cannot be
 * decoded. NEVER rejects: a missing codec, a truncated file or a vanished mount
 * are all "this track has no waveform", and the caller draws the plain bar.
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {function} [opts.spawn]     injected for tests
 * @param {number}   [opts.buckets]
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.signal]    { aborted } polled at each chunk
 * @param {object}   [opts.input]     a Readable to decode INSTEAD of a file. The
 *   streaming path uses this so no audio is ever written to disk. `file` is
 *   ignored when it is given.
 * @param {number}   [opts.expectSeconds]  how long the track is meant to be. A
 *   decode covering less than MIN_COVERAGE of it resolves null — see above.
 *   Omitted or 0 means "no idea", and then whatever decoded is what there is.
 */
function decodeWaveform(file, opts) {
  const o = opts || {};
  const spawn = o.spawn || require("child_process").spawn;
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const buckets = o.buckets || BUCKETS;
  const piped = !!o.input;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath(), piped ? pipeArgs() : args(file),
                    { stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve(null);   // no ffmpeg at all
    }

    // The level window in SAMPLES: ten milliseconds of FRAMES, times the
    // channels in each one. Stated here rather than baked into the accumulator,
    // so moving the rate or the channel count again cannot silently change how
    // long a level is.
    const acc = createPeaks({
      stride: Math.max(1, Math.round(DECODE_RATE * DECODE_CHANNELS * LEVEL_MS / 1000)),
    });
    let stderr = "";
    let done = false;
    let bytes = 0;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
      // Stop the download too. Without this a cancelled prefetch keeps pulling
      // the rest of a track nobody is going to look at — the bandwidth version
      // of the orphaned-process problem the timer above exists to prevent.
      if (o.input && typeof o.input.destroy === "function") {
        try { o.input.destroy(); } catch (e) { /* already closed */ }
      }
      resolve(value);
    };

    // NOT unref'd. This timer is the only thing bounding the decode, so while
    // one is in flight it should hold the loop — an unref'd one lets node exit
    // with ffmpeg still running as an orphan. finish() clears it the moment the
    // decode ends either way, so it is only ever pending while we are busy.
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on("data", (b) => {
      // Cancellation is checked HERE rather than only up front: a prefetch for
      // the next track is routinely overtaken by the user skipping, and a
      // 20-minute decode nobody wants any more is 20 minutes of a core.
      if (o.signal && o.signal.aborted) return finish(null);
      bytes += b.length;
      acc.push(b);
    });
    // stderr is bounded. ffmpeg can emit a line per frame on a damaged file,
    // and holding all of it to print four lines is how a decode of one bad rip
    // takes the server's memory with it.
    child.stderr.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString("utf8", 0, 4096 - stderr.length);
    });

    if (piped) {
      // EPIPE is the NORMAL end of this: ffmpeg has all the audio it needs and
      // closes stdin while the response is still arriving. Letting that reach
      // the process as an unhandled stream error would take the server down for
      // a decode that actually succeeded.
      o.input.on("error", () => finish(null));
      child.stdin.on("error", () => { /* see above — ffmpeg closed first */ });
      o.input.pipe(child.stdin);
    }

    child.on("error", () => finish(null));   // ENOENT: no ffmpeg on PATH either
    child.on("close", (code) => {
      if (done) return;
      // A non-zero exit AFTER usable audio still yields a waveform: a truncated
      // or slightly damaged file decodes most of the way and then complains,
      // and most of the way is a perfectly good picture of the track.
      if (bytes === 0) {
        if (code !== 0 && stderr) lastError = stderr.trim().split("\n")[0];
        return finish(null);
      }
      // How much of the track actually came through. s16le: two bytes a sample,
      // DECODE_CHANNELS samples a frame, DECODE_RATE frames a second.
      const secs = bytes / (2 * DECODE_CHANNELS * DECODE_RATE);
      const want = Number(o.expectSeconds) || 0;
      if (want > 0 && secs < want * MIN_COVERAGE) {
        lastError = "decoded " + secs.toFixed(1) + "s of a " + want.toFixed(1) +
                    "s track — the shape would be stretched over the whole bar" +
                    (stderr ? ": " + stderr.trim().split("\n")[0] : "");
        return finish(null);
      }
      finish(acc.finish(buckets));
    });
  });
}

// The most recent decode failure, for the log line at the call site. Not an
// error channel — decodeWaveform resolves null on purpose — just the reason,
// so "no waveform" is diagnosable without turning on debug.
let lastError = "";
function lastDecodeError() { return lastError; }

module.exports = { decodeWaveform, lastDecodeError, ffmpegPath, args, pipeArgs,
                   DECODE_RATE, DECODE_CHANNELS, MIN_COVERAGE, DEFAULT_TIMEOUT_MS };
