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
 *   -ac 1            downmix to mono: a stereo waveform drawn in one bar is
 *                    the max of the two channels anyway
 *   -ar 16000        see DECODE_RATE below. Low enough that the decode is a
 *                    fraction of the source rate, high enough that a cymbal or
 *                    a snare still reaches the peak detector — an 8 kHz decode
 *                    lowpasses at 4 kHz and quietly loses them
 *
 * The spawn is injected so the whole path can be tested without ffmpeg on the
 * machine, and so a test can make it fail, hang, or dribble bytes.
 */

const { createPeaks, BUCKETS } = require("./waveform");

/*
 * The rate the audio is decoded to before peaks are taken.
 *
 * 16 kHz, not the 8 kHz this shipped with, and the reason is amplitude rather
 * than time. Resampling to 8 kHz makes ffmpeg lowpass at 4 kHz FIRST, so every
 * cymbal, snare crack and sibilant — most of whose energy sits above that — was
 * being filtered away before it could register as a peak. Measured over a track
 * of transients, 8 kHz under-read the drawn bars by a mean of 16/255 and by as
 * much as 52/255 on one, and it under-read on the large majority of them: a
 * systematic flattening, not noise.
 *
 * It is close to free. The decode of the compressed source dominates, and
 * doubling the PCM that comes out of it did not move the wall clock: 134ms at
 * 8 kHz against 141ms at 16 kHz on the same three-minute track, with 44.1 kHz —
 * five times the bytes — also landing at 133ms.
 *
 * Higher buys nothing: 22.05 and 44.1 kHz differ from 16 kHz by less than they
 * differ from 8 kHz, because the content that was missing is all below 8 kHz.
 *
 * CHANGING THIS INVALIDATES EVERY STORED WAVEFORM. Rows analysed at a different
 * rate have genuinely different shapes, and a library holding both would draw
 * two kinds of picture with no way to tell which is which — see the rate check
 * in index.js, which clears the table when this value moves.
 */
const DECODE_RATE = 16000;

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
          "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", String(DECODE_RATE), "-"];
}

/*
 * The same decode, reading from a pipe instead of a path.
 *
 * For a streaming track there is no file and there must not be one: the bytes
 * come off an HTTPS response, through ffmpeg, and out as a thousand numbers.
 * Writing them down first and deleting them afterwards would be a promise to
 * keep — one that a crash mid-track breaks — where piping is simply a fact
 * about how the data moved. It is also faster, because the decode overlaps the
 * download instead of waiting for it.
 *
 * `-nostdin` is dropped here for the obvious reason: stdin is the input.
 */
function pipeArgs() {
  return ["-v", "error", "-i", "pipe:0",
          "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", String(DECODE_RATE), "-"];
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

    const acc = createPeaks();
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
                   DECODE_RATE, DEFAULT_TIMEOUT_MS };
