# How MusicD Remote draws waveforms for Qobuz and TIDAL

## The constraint

A Roon extension is given metadata and control. It is never given audio. There is no
API that hands you the PCM Roon is sending to a zone, and there should not be — so the
waveform under the seek bar cannot come from the thing you are listening to.

For local files that is straightforward: the extension can see `/music`, so it opens the
file itself. For a Qobuz or TIDAL stream there is no file, so the extension goes and
fetches its own copy of the audio from the service, independently of Roon, purely to
measure it. The bytes are reduced to a few thousand numbers and discarded. Roon still
does all the playback.

That is the whole feature. Everything below follows from it.

## Step 1 — work out what is playing

Roon reports a track title, an artist, an album and a duration. It does **not** report
which service the audio is coming from. There is no field for it — I dumped every key
exposed on a `now_playing` object while streaming to confirm that rather than assume it.

So identity is the only signal available. Every album, from any source, reduces to a key:

```
canonicalTitle || canonicalArtist        e.g.  "zebra iv||zebra"
```

Canonicalisation is NFKD, diacritics stripped, every run of non-alphanumerics collapsed
to a single space. That last clause does more work than it looks: it is what makes
`Don't Panic` and `Don’t Panic` the same string, and the same rule has to be applied on
both sides of every comparison in the system.

One album generates several keys — one per credited artist, because Roon credits
collaborations in full while the services usually credit one, and one per title variant,
so `Rumours (Deluxe Edition)` is filed under `rumours` as well as under its full title.
The lookup side and the index side call the same key builder. That is a hard requirement:
if the two can disagree, the source badge will claim an album is present that the
waveform then cannot find.

## Step 2 — turn an identity into a service album ID

You cannot ask Qobuz for a track list without its album ID, and an identity alone will
not get you one. There are two sources.

**Favourites.** On connect, and on each library sync, the extension pages the user's
favourite albums out of `favorite/getUserFavorites` (Qobuz) and
`/users/{id}/favorites/albums` (TIDAL), and builds `identityKey → albumId`. This is the
primary route and the correct one: an album in a Roon library that came from a streaming
service *is* a favourite in that service, because that is how Roon's integration works.

Both are paged to exhaustion, driven by the `total` each API states in the same response.
Reading that total back is what makes "we have everything" a checked fact rather than an
assumption — a read that stops early is indistinguishable from a complete one unless
something compares the two numbers.

**Catalogue search**, for an album played from search or an editorial list without being
added to the library. `catalog/search`, then an exact identity match using the same key
builder, and **decline on ambiguity**: Qobuz answers a query it cannot place with its
nearest guess rather than with nothing, so "the top result" is never treated as an answer,
and two distinct albums matching one identity is a question rather than a tie to break.

## Step 3 — pick the track

Fetch the album's track list — `album/get` on Qobuz, unsigned, paged, because that
endpoint paginates too and a box set would otherwise lose its tail. Then match on two
things:

- canonical title equality first; containment only if nothing matched exactly, and only
  when it is unambiguous;
- **and the duration must agree within ±2 seconds.**

The duration gate is the important half. Remasters, radio edits, live versions and deluxe
pressings all carry the same title, and a waveform of the wrong master looks entirely
authoritative while being a different recording. Both durations round to whole seconds
from the same metadata, so a ±2 tolerance separates rounding from a genuinely different
take.

It is also the safety net under every step above it. If the album ID resolved to the
wrong pressing, every track on it fails this check and nothing is drawn. An error
upstream costs a blank bar, never a wrong picture.

## Step 4 — get the audio

**Qobuz.** `track/getFileUrl` is the only signed endpoint in the whole client. The
signature is an MD5 over the object and method, then every parameter name immediately
followed by its value, sorted **by name**, then the unix timestamp, then the app secret.
The sort is not cosmetic: the server rebuilds the same string its own way and compares,
so a differently ordered one is simply a wrong signature, and it fails identically to a
wrong secret with no error distinguishing them.

A valid signed request needs three things that must all belong together — an `app_id`,
*that app's* secret, and a `user_auth_token` minted **by that same app**. The extension
gets all three by construction: the user signs in on Qobuz's own page through the
redirect flow, which mints a token under the app whose secret ships with the client. No
credentials are typed into this app, and the three parts cannot drift apart. The redirect
address is taken from the inbound request, so it works unchanged in Docker, behind a
reverse proxy, or from a phone, with nothing to configure.

Qobuz refuses by *answering*: HTTP 200 with `sample: true` is the 30-second preview,
which means the account cannot stream that track. That is checked explicitly, because
treating "we received JSON" as success would draw 30 seconds of audio across a
five-minute bar — which looks like the track and is not.

The request asks for format 5, MP3 320. The bytes are measured and thrown away, so
pulling a hi-res FLAC to compute an envelope would be bandwidth spent on nothing.

**TIDAL** signs nothing. The device sign-in already present carries a Bearer token that
refreshes itself, so there is no credential to go stale and nothing for the user to
reconnect. It is harder in one respect: `playbackinfopostpaywall` does not return a URL,
it returns a base64 manifest.

- `application/vnd.tidal.bt` — "BTS", plain JSON carrying direct audio URLs. This is the
  one the extension reads.
- `application/dash+xml` — the higher tiers, delivered in a protected container.
  **Refused outright.** Decrypting protected audio is a line this project does not cross,
  and that refusal is the correct outcome rather than a gap to be closed later.

Quality is requested as `LOW`, for the same reason as Qobuz's format 5.

## Step 5 — decode and measure

The response body arrives as a web `ReadableStream`, is adapted to a Node `Readable`, and
is piped into ffmpeg's stdin. Nothing is written to disk and nothing is buffered whole.

```
ffmpeg -i - -map 0:a:0 -f s16le -ac 2 -ar 44100 -
```

Two channels, not one. `-ac 1` *averages* the channels rather than taking the louder, so
an out-of-phase passage decodes to silence — measurably: RMS 0 against the pair's 2896.
And 44.1 kHz rather than a reduction, because nearly every source already is 44.1k, so
downsampling buys nothing while a low rate lowpasses the cymbals and snare transients
away before they can register.

**A stored value is the RMS of its slice.** Not the peak. A limiter puts something on the
ceiling inside almost any window you can name, so "was anything loud here?" answers yes
everywhere and every bar comes out the same height — a brick with no range left to show
anything. The reduction uses the same statistic for the same reason: the RMS of RMS
values *is* the RMS of the whole span, so a bucket folded twice equals one computed once
over the same audio. That is what makes the picture independent of how many times it has
been folded, which matters because it is folded again in the browser to whatever bar
count the screen can draw. Measuring a level and then keeping the loudest of them is the
same error one layer down.

Levels accumulate at a fixed 10 ms stride while the audio streams, then resample to 4000
buckets of one byte each — 4 KB per track. A five-minute track holds about 30,000
intermediate values, so nothing needs to be held whole and the length does not have to be
known up front.

If the decode covers less than 90% of the duration Roon reported, it is **refused**. A
truncated download is indistinguishable from a short track, and stretching two thirds of
a file across the whole bar puts the playhead over the wrong music by a margin that grows
as it plays, with nothing about it looking wrong.

## Step 6 — store it

SQLite on the data volume, keyed by `qobuz:<albumId>` or `tidal:<albumId>` plus the track
title. The analysis parameters — statistic, sample rate, channel count — are stamped
beside the table, and any change to them wipes it. A library holding two generations of
measurement would draw two kinds of picture with nothing to say which is which, which is
worse than either on its own because the inconsistency is invisible.

The next item in the queue is decoded while the current one plays. One ahead, never more:
the queue reshuffles constantly — a skip, a new album, Roon Radio picking something — so
anything further is CPU spent on a guess.

## On the client

The canvas is decoration **under** the range input, never a replacement for it. The input
keeps the drag, the keyboard, the thumb and the disabled state, and if any part of this
fails the bar is exactly what it was before.

One detail is worth stating because it is invisible until it is wrong: a range input
cannot let its thumb hang off either end, so the thumb travels from `thumbW/2` to
`w - thumbW/2` while anything drawn underneath is laid out from 0 to `w`. The two
mappings from time to x disagree by `thumbW * (0.5 - fraction)` — half a thumb ahead at
the start, level in the middle, half a thumb behind at the end. The waveform is therefore
inset to the control's actual travel, and the width both of them use is one number read
from a single CSS custom property.

## What it will not do

Every decline above resolves to the same outcome: the plain progress bar. No waveform is
always an acceptable answer. A wrong one never is.

To see where a particular track stops, `GET /api/debug/waveform?deep=1` walks the real
chain and names the exact step. It shares its implementation with the playback path
rather than reimplementing it, so it cannot report a route the player does not take.

---

# The code

Verbatim from the tree at v1.8.57. Presented in the order the chain runs: the pure
modules first, then the server, then the client.

## `lib/waveform.js`

The measurement itself: PCM in, buckets out. No I/O and no ffmpeg, so all of it is testable in node.

```js
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
```

## `lib/waveform-decode.js`

The ffmpeg boundary — argument construction, the pipe, the coverage floor.

```js
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

const fs = require("node:fs");
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

/**
 * Where ffmpeg is. Resolved once, lazily, and cached — including the failure.
 *
 * ffmpeg-static EXPORTS A PATH WHETHER OR NOT THE BINARY IS THERE. The package
 * downloads a platform build in a postinstall script, and `require` of it just
 * returns where that build was supposed to land — so a download that failed
 * (an offline or rate-limited `docker build`, an unsupported platform) leaves a
 * perfectly good-looking string pointing at nothing. Taking it on trust meant
 * every decode spawned a file that does not exist, got ENOENT, and resolved
 * null: the feature switched on, no waveforms, and not one line anywhere
 * saying why. The existsSync is what turns that into the PATH fallback the
 * comment already claimed to provide.
 */
let _ffmpegPath;
let _ffmpegSource = "";     // for the diagnostics — which of the two won, and why
function ffmpegPath() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  // The npm binary first: it is pinned with the app, so the waveform does not
  // depend on what the host image happens to ship. A system ffmpeg on PATH is
  // the fallback for anyone running outside Docker — and now also for anyone
  // whose ffmpeg-static download did not arrive.
  try {
    const p = require("ffmpeg-static");
    if (typeof p === "string" && p && fs.existsSync(p)) {
      _ffmpegPath = p;
      _ffmpegSource = "ffmpeg-static";
    } else {
      _ffmpegPath = "ffmpeg";
      _ffmpegSource = p ? "PATH (ffmpeg-static path does not exist: " + p + ")"
                        : "PATH (ffmpeg-static exported nothing)";
    }
  } catch (e) {
    _ffmpegPath = "ffmpeg";   // not installed: hope for one on PATH
    _ffmpegSource = "PATH (ffmpeg-static not installed)";
  }
  return _ffmpegPath;
}

/**
 * Which ffmpeg this process will use, and whether it actually runs.
 *
 * Exists because every way the decode can fail looks identical from outside —
 * `{peaks: null, reason: "undecodable"}` covers a missing binary, an
 * unreadable file and a corrupt stream alike. One call answers the first of
 * those without a release, which is the whole point (cf. the Qobuz probe).
 *
 * @param {object} [opts] {spawn} injected for tests
 * @returns {Promise<{path:string, source:string, ok:boolean, version:string, error:string}>}
 */
function ffmpegProbe(opts) {
  const o = opts || {};
  const spawn = o.spawn || require("child_process").spawn;
  const path = ffmpegPath();
  return new Promise((resolve) => {
    const done = (extra) => resolve(Object.assign(
      { path, source: _ffmpegSource, ok: false, version: "", error: "" }, extra));
    let child;
    try {
      child = spawn(path, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ error: e.message });
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
      done({ error: "timed out" });
    }, 5000);
    child.stdout.on("data", (b) => { if (out.length < 200) out += String(b); });
    child.on("error", (e) => { clearTimeout(timer); done({ error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const first = out.split("\n")[0].trim();
      done({ ok: code === 0, version: first,
             error: code === 0 ? "" : "exited " + code });
    });
  });
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

module.exports = { decodeWaveform, lastDecodeError, ffmpegPath, ffmpegProbe, args, pipeArgs,
                   DECODE_RATE, DECODE_CHANNELS, MIN_COVERAGE, DEFAULT_TIMEOUT_MS };
```

## `lib/trackmatch.js`

Which track on a service's album is the one Roon is playing. Pure: no network, no account.

```js
"use strict";
/*
 * trackmatch.js — which track in a service's album is the one Roon is playing.
 *
 * This is the decision that makes a streaming waveform either right or subtly,
 * confidently wrong. Roon gives a track title and a length; the service gives a
 * track list with ids and durations. Titles alone are not enough: remasters,
 * deluxe editions, radio edits and live versions all carry the same title, and
 * a waveform of the wrong master looks authoritative and is a different
 * recording.
 *
 * So the rule is title AND duration, and where that is not decisive, nothing.
 * The plain progress bar is always an acceptable answer here; a wrong shape
 * never is.
 *
 * Pure — no network, no ffmpeg, no account.
 */

// How far a service's stated duration may sit from Roon's and still be the same
// recording. Both round to whole seconds from the same master, so the honest
// disagreement is ±1; two allows for one of them rounding the other way on a
// half-second. A remaster or an edit differs by far more than this — the whole
// point of the gate is that it separates rounding from a different recording.
const DURATION_TOLERANCE_S = 2;

/** Same canonicalisation the rest of the app uses for titles. */
function canon(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {Array} tracks    the service's track list; each {id, title, duration}
 * @param {string} title    what Roon calls the track
 * @param {number} seconds  what Roon says it lasts
 * @param {object} [opts]
 * @param {number} [opts.tolerance]
 * @returns {{track:object, reason:string}|{track:null, reason:string}}
 *
 * `reason` is returned in both cases and is meant for a log line: "no waveform"
 * with no explanation is the thing that makes this class of feature impossible
 * to diagnose from a user's report.
 */
function matchTrack(tracks, title, seconds, opts) {
  const tol = (opts && Number.isFinite(opts.tolerance)) ? opts.tolerance : DURATION_TOLERANCE_S;
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return { track: null, reason: "the album has no track list" };

  const want = canon(title);
  if (!want) return { track: null, reason: "no track title to match on" };
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Without a duration there is no gate, and title alone is exactly what this
    // module exists to refuse.
    return { track: null, reason: "no duration from Roon to check against" };
  }

  let cands = list.filter((t) => t && canon(t.title) === want);

  // Roon's title can carry a suffix the service's does not, or the reverse:
  // "The Number 3 (Live at Sydney Opera House)" against Qobuz's plain "The
  // Number 3". wfResolveFile has matched local files by containment since the
  // beginning, with this same reasoning; the streaming side never got it, so
  // whole live albums resolved nothing.
  //
  // Only when there is NO exact match. An exact title whose length is wrong is
  // a different recording and must stay refused — reaching past it to a loosely
  // named neighbour is precisely the wrong-master failure this module exists to
  // prevent. And the duration gate below still applies either way, which makes
  // containment far safer here than in the local path, where it stands alone.
  let loose = false;
  if (!cands.length) {
    cands = list.filter((t) => {
      const c = t && canon(t.title);
      return c && (c.includes(want) || want.includes(c));
    });
    loose = cands.length > 0;
  }

  if (!cands.length) {
    return { track: null, reason: `no track called "${title}" on the album` };
  }

  const fits = cands.filter((t) =>
    Number.isFinite(t.duration) && Math.abs(t.duration - seconds) <= tol);

  if (!fits.length) {
    // The title is there and the length is not. This is the interesting
    // failure: a different edition of the same album, so naming the gap is
    // worth more than "not found".
    const got = cands.map((t) => t.duration).join("/");
    return { track: null,
             reason: `"${title}" is ${got}s on the service and ${seconds}s here — ` +
                     `a different recording, so no waveform` };
  }

  if (fits.length > 1) {
    // Two tracks, same title, both the right length — an album that genuinely
    // repeats a track (a reprise, a hidden duplicate). Picking one is a guess.
    return { track: null,
             reason: `${fits.length} tracks called "${title}" are the right length — ambiguous` };
  }

  return { track: fits[0],
           reason: loose ? "matched on a partial title and duration"
                         : "matched on title and duration" };
}

module.exports = { matchTrack, canon, DURATION_TOLERANCE_S };
```

## `lib/qobuz-sig.js`

The Qobuz request signature, and the check for a refusal that arrives as an HTTP 200.

```js
"use strict";
/*
 * qobuz-sig.js — the request signature Qobuz's stream endpoints require.
 *
 * Everything lib/qobuz.js did before this (favourites, search, artists, new
 * releases) is UNSIGNED and needs only the app_id. `track/getFileUrl` is the
 * exception: it is the endpoint that hands back audio, and it wants a signed
 * request, which means an app_secret.
 *
 * THE SECRET IS NOT SHIPPED. It is a setting the user provides, for two
 * reasons: it rotates whenever Qobuz updates their web player, so baking one in
 * guarantees a build that stops working with no way to fix it short of a
 * release; and asking for it puts the decision to use this path in the user's
 * hands rather than in a default. With no secret configured, none of this runs
 * and streaming tracks keep the plain progress bar.
 *
 * Pure and offline: the signing is arithmetic on strings, so it is testable
 * without an account, a network or a subscription.
 */

const crypto = require("node:crypto");

function md5Hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

/**
 * The signature string for a Qobuz API call.
 *
 * The recipe, which is not documented anywhere and is the whole reason this
 * lives in its own tested module: take the request's parameters, sort them BY
 * NAME, concatenate each name immediately followed by its value with no
 * separators at all, prefix the object and method ("track" + "getFileUrl"),
 * then append the unix timestamp and the secret. MD5 the result.
 *
 * Order is the part that bites. Sorting by name is not cosmetic — the server
 * builds the same string its own way and compares, so a different order is
 * simply a wrong signature, and Qobuz answers that the same way it answers a
 * wrong secret. There is no error that says "your parameters were misordered".
 *
 * @param {string} object   e.g. "track"
 * @param {string} method   e.g. "getFileUrl"
 * @param {object} params   the request parameters that take part in the signature
 * @param {number} ts       unix seconds — must be the SAME value sent as request_ts
 * @param {string} secret
 */
function signRequest(object, method, params, ts, secret) {
  const names = Object.keys(params || {}).sort();
  const body = names.map((n) => n + params[n]).join("");
  return md5Hex(String(object) + String(method) + body + String(ts) + String(secret));
}

/**
 * The full query for track/getFileUrl, signature included.
 *
 * `intent` is "stream" rather than "download": it is what the web player sends,
 * and it is the honest description of what this is for — the bytes are decoded
 * into a thousand peak values and discarded.
 *
 * @param {object} opts
 * @param {number|string} opts.trackId
 * @param {number} [opts.formatId]  5 = MP3 320. The default, deliberately: the
 *   peaks are resampled to 1000 buckets from a 16 kHz mono decode, where a
 *   lossy codec's envelope is indistinguishable from the original's — and it is
 *   ~7 MB a track instead of the 30-150 MB of hi-res FLAC.
 * @param {string} opts.secret
 * @param {number} [opts.ts]  injectable so the signature is testable
 */
function fileUrlParams(opts) {
  const o = opts || {};
  const ts = o.ts || Math.floor(Date.now() / 1000);
  const params = {
    format_id: o.formatId || FORMAT_MP3_320,
    intent: "stream",
    track_id: o.trackId,
  };
  return Object.assign({}, params, {
    request_ts: ts,
    request_sig: signRequest("track", "getFileUrl", params, ts, o.secret || ""),
  });
}

// Qobuz's format ids. 5 is MP3 320; 6/7/27 are FLAC at rising resolutions.
const FORMAT_MP3_320 = 5;
const FORMAT_FLAC_16 = 6;

/**
 * Is what came back actually usable audio?
 *
 * Qobuz answers a refused request with 200 and a body — a sample-only URL, or
 * a url-less object — rather than an error status. Treating "we got JSON" as
 * success is how you end up decoding a 30-second preview and drawing it as the
 * whole track.
 */
function usableFileUrl(j) {
  if (!j || typeof j !== "object") return null;
  if (!j.url || typeof j.url !== "string") return null;
  // `sample: true` is Qobuz saying "this is the 30-second preview". A waveform
  // of the preview stretched across a five-minute bar is worse than none: it
  // looks like the track and is not.
  if (j.sample === true) return null;
  return j.url;
}

/**
 * Read an app_id/secret pair out of whatever the user pasted.
 *
 * SECRETS ARE APP_ID-SPECIFIC: a signature made with one app's secret is only
 * valid against that app's id, so the two must arrive together or the request
 * is rejected in a way indistinguishable from a wrong secret. Asking for them
 * in two fields invites exactly one of them being updated later.
 *
 * AND THE TOKEN IS PART OF THE SET. A user_auth_token is minted BY an app, and
 * Qobuz checks the signing app_id against the app that issued the token — so a
 * token from one app signed with another app's pair is refused (HTTP 401) even
 * when the pair itself is perfectly matched. A client's credentials file holds
 * all three, mutually consistent by construction, which is the whole reason to
 * take the file rather than ask for pieces of it.
 *
 * So this accepts either:
 *   - the JSON a Qobuz client stores (any object with app_secret / app_id /
 *     user_auth_token, in any nesting) — paste the file, keep the set intact; or
 *   - a bare secret string, which uses the caller's default id and token.
 *
 * @returns {{secret:string, appId:string, token:string}} all "" when absent.
 */
function parseSecretInput(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { secret: "", appId: "", token: "" };

  if (raw.startsWith("{") || raw.startsWith("[")) {
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { doc = null; }
    // Looked like JSON and was not — a truncated or mangled paste. Falling
    // through to "treat it as a bare secret" would store "{ not json" as a
    // credential that can never work and report it as SET, which is a wrong
    // answer dressed as a right one. A secret never begins with a brace.
    if (!doc) return { secret: "", appId: "", token: "" };
    if (doc) {
      const found = { secret: "", appId: "", token: "" };
      // Walk it: a client may nest the pair under a profile or an account name,
      // and requiring a particular shape would reject a perfectly good file.
      const seen = new Set();
      (function walk(v) {
        if (!v || typeof v !== "object" || seen.has(v)) return;
        seen.add(v);
        for (const [k, val] of Object.entries(v)) {
          const key = k.toLowerCase().replace(/[^a-z]/g, "");
          if (typeof val === "string" || typeof val === "number") {
            const sv = String(val).trim();
            if (!sv) continue;
            if (!found.secret && key === "appsecret") found.secret = sv;
            // "appid", never "id" — an object full of ids would otherwise
            // volunteer the wrong one.
            else if (!found.appId && key === "appid") found.appId = sv;
            // The login token that belongs with this pair. Same rule: the exact
            // name, so a "token" field meaning something else is not adopted.
            else if (!found.token && key === "userauthtoken") found.token = sv;
          } else walk(val);
        }
      })(doc);
      // A JSON paste with no secret in it is a mistake worth reporting as one,
      // not something to treat as a very long secret.
      return found;
    }
  }
  // Not JSON: a bare secret, and the caller's own app_id and token.
  return { secret: raw, appId: "", token: "" };
}

module.exports = { md5Hex, signRequest, fileUrlParams, usableFileUrl, parseSecretInput,
                   FORMAT_MP3_320, FORMAT_FLAC_16 };
```

## `lib/tidal-manifest.js`

Getting a playable URL out of TIDAL's base64 manifest, and refusing the ones that are protected.

```js
"use strict";
/*
 * tidal-manifest.js — getting a playable URL out of TIDAL's playback response.
 *
 * Unlike Qobuz, TIDAL does not hand back a URL. It returns a base64-encoded
 * manifest whose type decides whether there is anything usable inside:
 *
 *   application/vnd.tidal.bt   "BTS" — plain JSON carrying direct audio URLs.
 *                              This is the one this reads.
 *   application/dash+xml       MPEG-DASH, used for the higher tiers. It can be
 *                              ENCRYPTED, and decrypting protected audio is a
 *                              line this project does not cross. Refused.
 *
 * So the rule is: BTS or nothing, and "nothing" means the track keeps the plain
 * progress bar — the same answer every other decline in the waveform path gives.
 * Refusing an unreadable manifest is not a gap to be closed later; it is the
 * correct outcome.
 *
 * Pure: base64 and JSON, no network, no account, no subscription.
 */

// The only manifest type this reads. Matched on prefix because TIDAL appends
// parameters to it ("application/vnd.tidal.bt; charset=utf-8" and similar).
const BTS_MIME = "application/vnd.tidal.bt";

/**
 * The first playable URL in a playbackinfo response, or null with a reason.
 *
 * @param {object} j  the parsed playbackinfopostpaywall body
 * @returns {{url:string|null, reason:string, codec?:string}}
 */
function streamUrlFrom(j) {
  if (!j || typeof j !== "object") return { url: null, reason: "no playback response" };

  const mime = String(j.manifestMimeType || "");
  if (!j.manifest) return { url: null, reason: "TIDAL returned no manifest for this track" };

  if (mime && mime.indexOf(BTS_MIME) !== 0) {
    // Named rather than lumped in with "unreadable": a DASH manifest means the
    // account is entitled to a tier delivered in a protected container, which is
    // a different situation from a track that cannot be played at all, and the
    // user deserves to know which.
    return { url: null,
             reason: "TIDAL returned a " + mime + " manifest rather than plain audio" +
                     (mime.indexOf("dash") >= 0
                        ? " — that tier is delivered encrypted, so there is no waveform for it"
                        : "") };
  }

  let doc;
  try {
    doc = JSON.parse(Buffer.from(String(j.manifest), "base64").toString("utf8"));
  } catch (e) {
    return { url: null, reason: "TIDAL's manifest could not be read" };
  }

  const urls = (doc && Array.isArray(doc.urls)) ? doc.urls.filter((u) => typeof u === "string" && u) : [];
  if (!urls.length) return { url: null, reason: "TIDAL's manifest carried no audio url" };

  return { url: urls[0], reason: "ok", codec: (doc && doc.codecs) ? String(doc.codecs) : "" };
}

module.exports = { streamUrlFrom, BTS_MIME };
```

## `lib/albumsearch.js`

Deciding whether any catalogue search result is the album that is playing.

```js
"use strict";
/*
 * albumsearch.js — is one of these search results the album that is playing?
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * WHY THIS EXISTS. A streaming waveform needs the service's own album id, and
 * until now the only place one could be had was the user's FAVOURITES. That is
 * a real limit and it was stated honestly — but it means an album played from a
 * search, from an editorial list, or from Roon's own browser has no waveform
 * and never can, however long you wait. A probe run against 11,455 loaded
 * favourites reported `near: []` for the album playing at the time: not spelled
 * differently, not absent by accident — simply never favourited.
 *
 * The catalogue is searchable with the same token that reads the favourites, so
 * the id IS obtainable. What makes it safe to use is the decision below, and
 * what makes it safe to be WRONG is the duration gate downstream: a search hit
 * that is a different pressing fails TM.matchTrack and draws nothing, rather
 * than putting a confident picture of another recording under the seek bar.
 *
 * THE RULE: an exact identity match, and only when exactly one album has it.
 * Qobuz answers a query it cannot place with its nearest guess rather than with
 * nothing (v1.8.36 learned this the expensive way on the share-card links), so
 * "the first result" is never an answer here. Two different albums matching is
 * not a tie to break, it is a question we cannot answer.
 *
 * Pure: identities in, a decision out. The keying is the caller's, because the
 * caller owns the key space and both sides must use the one builder.
 */

/**
 * @param {string[]} wanted     the identity keys for what Roon is playing
 * @param {Array<{id:*, keys:string[]}>} candidates  the search results, keyed
 *        by the SAME builder the favourites index uses
 * @returns {{id:*|null, reason:string}}
 */
function pickAlbumId(wanted, candidates) {
  const want = new Set((Array.isArray(wanted) ? wanted : []).filter(Boolean));
  const list = Array.isArray(candidates) ? candidates : [];
  if (!want.size) return { id: null, reason: "nothing to match on" };
  if (!list.length) return { id: null, reason: "the search returned no albums" };

  // Distinct IDS, not distinct results: a service can return the same album
  // twice (once per credited artist, or across sections), and counting those as
  // two candidates would decline for ambiguity on a perfectly clear answer.
  const hits = new Map();          // id -> the key that matched, for the log
  for (const c of list) {
    if (!c || c.id === undefined || c.id === null || c.id === "") continue;
    for (const k of (Array.isArray(c.keys) ? c.keys : [])) {
      if (want.has(k)) {
        if (!hits.has(c.id)) hits.set(c.id, k);
        break;
      }
    }
  }

  if (!hits.size) {
    return { id: null,
             reason: "none of the " + list.length + " search results is this album " +
                     "(Qobuz answers with its nearest guess, so a result is not a match)" };
  }
  if (hits.size > 1) {
    // Two genuinely different albums under one identity. Picking either is a
    // coin flip, and the cost of losing it is a waveform drawn from the wrong
    // master — which looks authoritative and is a different recording.
    return { id: null,
             reason: hits.size + " different albums match this identity — ambiguous, " +
                     "so no id rather than a guess" };
  }
  const [id, via] = [...hits.entries()][0];
  return { id, reason: 'matched on "' + via + '"' };
}

module.exports = { pickAlbumId };
```

## `lib/waveform-verdict.js`

The diagnostic sentence for `/api/debug/waveform` — why a streamed track has no waveform.

```js
"use strict";
/*
 * waveform-verdict.js — why a streamed track has no waveform.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * The streaming half of GET /api/debug/waveform. Pure: it is handed what the
 * server already knows and returns one sentence.
 *
 * THE ORDER IS THE WHOLE THING. wfQobuzTrack and wfTidalTrack check in a fixed
 * sequence, and each stop has a different fix: a missing credential is a
 * sign-in, an album that is not a favourite is a different problem entirely,
 * and anything past those two can only be seen by making the attempt. A
 * verdict that named the second cause while the first was also true would send
 * somebody to the wrong screen, which is worse than saying nothing — this
 * endpoint exists precisely because "no waveform" was already one silence
 * covering five causes.
 *
 * So the branches below are in the same order the code checks, and the test
 * pins that order rather than the wording.
 *
 * ONE OF THEM IS HERE BECAUSE IT HAPPENED (branch 3, v1.8.51). "Connected and
 * knows nothing" and "not connected" both used to fall into the same sentence,
 * which told a signed-in user to sign in. That was the exact state the drifted
 * favourites gate produced, on every install, for thirty versions — so the one
 * report this endpoint most needed to be able to make was the one it could not.
 */

/**
 * @param {object} q Qobuz state: { album_id, signed_in_for_waveforms,
 *                   has_pasted_secret, account_connected,
 *                   favourite_albums_known }
 * @param {object} t TIDAL state: { album_id, account_connected,
 *                   favourite_albums_known }
 * @returns {string}
 */
function streamingVerdict(q, t) {
  q = q || {}; t = t || {};
  const qKnown = Number(q.favourite_albums_known) || 0;
  const tKnown = Number(t.favourite_albums_known) || 0;
  // "Connected" for Qobuz means any of the three credentials the server will
  // actually use, which is what qobuzReady() reports into account_connected.
  const qConn = !!(q.signed_in_for_waveforms || q.has_pasted_secret || q.account_connected);
  const tConn = !!t.account_connected;

  // 0. A TRUNCATED favourites read outranks everything below it, including a
  //    successful album id. Every branch after this reasons from "what the
  //    index holds", and if the index is short then "not a favourite" and
  //    "nothing resembles it" are both statements about a partial list. Qobuz
  //    was read under a ceiling of ten thousand albums until v1.8.56, and the
  //    probe reported the KEY count — always larger than the library — so
  //    nothing about the number on screen could reveal it.
  const short = (o) => o && o.favourites_complete === false;
  if (short(q) || short(t)) {
    const o = short(q) ? q : t;
    const who = short(q) ? "Qobuz" : "TIDAL";
    return "the " + who + " favourites read is INCOMPLETE — " +
           (Number(o.favourite_albums_read) || 0) + " albums read of " +
           (Number(o.favourite_albums_total) || 0) + " the service states. " +
           "Everything else here reasons from that list, so any answer about " +
           "whether this album is a favourite is about a partial one. Run a " +
           "Rescan; if it stays short, the log line '[stream] " + who +
           " favourites' says how far it got";
  }

  // 1. The album IS reachable and the credential is not there. First because
  //    it is the only stop with a one-click fix, and because it is the default
  //    state — nothing is signed in until somebody signs it in.
  if (q.album_id && !q.signed_in_for_waveforms && !q.has_pasted_secret) {
    return "this album IS a Qobuz favourite, but the extension is not signed in " +
           "to Qobuz for waveforms — Settings -> Playback -> Qobuz waveforms -> Connect";
  }

  // 2. Identified, credentials present. Everything past here needs the attempt
  //    itself, and the attempt logs its own reason per track.
  if (q.album_id || t.album_id) {
    return "the album is known to " + (q.album_id ? "Qobuz" : "TIDAL") + " and the " +
           "credentials are present, so any failure is later in the chain (track " +
           "match, file url, or the decode) — those are logged per track: grep the " +
           "log for '[waveform]'";
  }

  // 3. A service is connected and knows NOTHING. Ahead of "not a favourite",
  //    because with an empty set every album looks like it is not a favourite
  //    and that sentence would be a true statement about a false premise.
  if ((qConn && !qKnown) || (tConn && !tKnown)) {
    const who = (qConn && !qKnown) ? "Qobuz" : "TIDAL";
    return who + " is CONNECTED but none of its favourites have been read, so there " +
           "is no album id to fetch a track list with and no streamed track can be " +
           "identified. Search the log for '[stream] " + who + " favourites': if the " +
           "line is absent the read never ran at all, and if it is present it says " +
           "how many albums it got and why";
  }

  // 4. Nothing connected, nothing known. Different problem, different fix.
  if (!qKnown && !tKnown) {
    return "no favourites have been read from either service, so no streamed track " +
           "can be identified at all — connect Qobuz or TIDAL, or run a Rescan";
  }

  // 5. Favourites are known and the lookup missed. Two different findings live
  //    here and v1.8.52 collapsed them into the confident one:
  //
  //      the record is ABSENT from the favourites, or
  //      it is THERE under a different spelling and the exact key missed.
  //
  //    A failed lookup cannot tell those apart — lib/keymatch.js can, by asking
  //    what the index holds that is close. Saying "not in your favourites" when
  //    it is sitting there as "Album (Remastered)" sends somebody to favourite
  //    a record they already have, and it was said against 11,006 loaded
  //    favourites with nothing behind it but the miss itself.
  const near = []
    .concat(Array.isArray(q.near) ? q.near.map(n => ({ svc: "Qobuz", n })) : [])
    .concat(Array.isArray(t.near) ? t.near.map(n => ({ svc: "TIDAL", n })) : []);
  if (near.length) {
    const top = near[0];
    return "the exact identity missed, but " + top.svc + " holds " + near.length +
           " near miss" + (near.length === 1 ? "" : "es") + ' — closest is "' +
           top.n.key + '" (' + top.n.why + "). So this record is NOT absent from " +
           "your favourites; the two spellings have to be reconciled. See " +
           "streaming." + top.svc.toLowerCase() + ".keys_tried against that key";
  }
  // Not a favourite, and nothing close. Until v1.8.55 that was the end of the
  // road and this sentence said so ("favourite membership is the only signal
  // there is"). It is not any more: the catalogue is searchable with the same
  // token, so an album played from a search or an editorial list is reachable.
  // Saying otherwise would send somebody to go and favourite a record to fix a
  // problem the next poll may already have solved.
  return "this album is in neither service's FAVOURITES (" + qKnown + " Qobuz, " +
         tKnown + " TIDAL known) and nothing in either resembles it, so it was " +
         "genuinely never favourited. That is no longer the end of it — the " +
         "Qobuz CATALOGUE is searched as a fallback, and whether that found the " +
         "album is what ?deep=1 reports";
}

/**
 * The verdict once the chain has actually been WALKED (?deep=1).
 *
 * streamingVerdict above reports from state already in memory and can only ever
 * reach "the credentials are present, so any failure is later in the chain" —
 * true, and the least useful true thing to be told. This one names the stop,
 * because the walk made the calls.
 *
 * @param {object} d the deep report: { stop, detail, tried, album_tracks_on_qobuz,
 *                  roon_says_seconds, qobuz_says_seconds, got_audio_url }
 * @returns {string}
 */
function deepVerdict(d) {
  d = d || {};
  const tried = Array.isArray(d.tried) && d.tried.length ? " Qobuz said: " + d.tried.join(" | ") : "";

  if (d.stop === "no-credentials") {
    return "no Qobuz sign-in and no pasted app secret — Settings -> Playback -> " +
           "Qobuz waveforms -> Connect";
  }

  if (d.stop === "album") {
    // The album id resolved but nothing could READ it. A dead token and an id
    // that is no longer in the catalogue both land here and read differently in
    // `tried`, which is why it is quoted rather than summarised.
    return "the album id is known but no credential set could read the album from " +
           "Qobuz." + tried;
  }

  if (d.stop === "track") {
    const roon = Number(d.roon_says_seconds) || 0;
    const qob  = Number(d.qobuz_says_seconds) || 0;
    if (roon && qob && Math.abs(roon - qob) > 2) {
      // THE interesting one. Roon streams the album it is streaming, so its
      // length comes from Qobuz's own metadata — a disagreement means the id
      // resolved to a DIFFERENT EDITION of this record, not that the matcher is
      // too strict. Every track on that album will fail the same way.
      return "the album was read, but this track is " + qob + "s on the Qobuz album " +
             "we resolved and " + roon + "s here — so that is a different edition of " +
             "the record, and every track on it will fail the same way. The id came " +
             "from your favourites: favouriting the edition you actually play fixes it";
    }
    if (!roon) {
      return "the album was read, but no track length was supplied to check against, " +
             "and title alone is refused on purpose — pass &length=<seconds> or run " +
             "this while the track is playing. (" + (d.detail || "no match") + ")";
    }
    return "the album was read (" + (d.album_tracks_on_qobuz || 0) + " tracks) and the " +
           "track was not matched in it: " + (d.detail || "no match") +
           ". Compare the spelling with the Qobuz track list";
  }

  if (d.stop === "audio") {
    // Identified, and refused. This is an entitlement answer far more often
    // than a bug: the 30-second preview means the account cannot stream it.
    return "the track was identified and Qobuz would not hand back the audio." + tried;
  }

  if (d.stop === "ok" || d.got_audio_url) {
    return "the whole chain works for this track — the audio url came back, so if " +
           "there is still no waveform the failure is in the DECODE: play it and " +
           "grep the log for '[waveform] qobuz'";
  }

  return "the walk did not run — see streaming.deep.why";
}

module.exports = { streamingVerdict, deepVerdict };
```

## `index.js` — the waveform section (lines 13450–15146)

The server side end to end: storage, the local-file path, the Qobuz and TIDAL
stream paths, the Qobuz sign-in routes, and the two endpoints.

```js
/* ------------------------------------------------------------------ */
/*  Waveforms                                                          */
/* ------------------------------------------------------------------ */
/*
 * Roon's extension API exposes no audio at all — the Core decodes and streams to
 * the endpoint, never to an extension — so nothing here can read what you are
 * listening to. There are two ways round that and the whole section is built on
 * the difference between them:
 *
 *   LOCAL FILES are on disk, so the file is opened directly. The resolution is
 *     LAZY on purpose: the /music walk records one directory per album
 *     (localAlbumDirs), and when a track starts the tags of the files in just
 *     that folder are read and the title matched. A dozen reads for the album
 *     you are listening to, against ~70,000 for a track-level index of the
 *     whole library, most of which would never be asked about.
 *
 *   QOBUZ AND TIDAL have no file, so a copy of the audio is fetched from the
 *     service with the user's own account, independently of Roon, purely to
 *     measure it — see wfQobuzTrack and wfTidalTrack. The album is identified
 *     by identity key against the favourites (or, for Qobuz, the catalogue),
 *     the track by title AND duration, and the bytes are piped through ffmpeg
 *     and discarded. Nothing is written to disk and Roon still does all the
 *     playback.
 *
 * Anything that cannot be identified confidently, or that a service delivers in
 * a protected container, falls back to the plain progress bar. That is always an
 * acceptable answer here; a waveform of the wrong recording never is.
 */
const WF = require("./lib/waveform");
const WFV = require("./lib/waveform-verdict");
// What the index holds NEAR a key that missed. The difference between "this
// album is not in your favourites" and "it is, spelled differently".
const KM = require("./lib/keymatch");
// Which catalogue search result (if any) is the album that is playing. Pure —
// the decision only; the keying stays here, where the key space lives.
const ABS = require("./lib/albumsearch");
const WFD = require("./lib/waveform-decode");
// Field listing for /api/debug/zone-dump. Pure, no I/O — see lib/objshape.js.
const SHAPE = require("./lib/objshape");
// Picking the right track out of a service's album, by title AND duration. Pure
// — see lib/trackmatch.js, which is where the rule about refusing to guess is.
const TM = require("./lib/trackmatch");

/*
 * What this app can work out about an album, both ways.
 *
 * `keyed` is the normal path: title + artist. `title_only` is the rung
 * underneath, for the case Roon supplies no artist at all — which it does, for
 * some albums, sending three_line.line2 as "". Without the fallback those
 * albums are invisible to every identity lookup here: no source badge, no local
 * file, no waveform.
 *
 * Reported rather than acted on. Whether the weaker rung is safe enough to use
 * depends on how often it comes back ambiguous, and that is what the dump is
 * for finding out.
 */
function identityReport(album, artist) {
  const titles = albumKeys(album, "").map(AK.titleOf).filter(Boolean);
  return {
    keyed: {
      album_source: albumSource(album, artist, null),
      has_local_file: !!wfAlbumKey(album, artist),
    },
    title_only: Object.assign(
      { titles },
      AK.locateByTitle(titles, {
        local: localAlbumKeys, qobuz: qobuzAlbumKeys, tidal: tidalAlbumKeys,
      })
    ),
  };
}

// Module-scope copies. buildFileLabelMap declares its own AUDIO_RE and resolves
// parseFile INSIDE the function, so referencing either from here is a
// ReferenceError at runtime that `node --check` cannot see (CLAUDE.md's
// declaration-before-use rule, and the pre-flight step 3 it added).
const WF_AUDIO_RE = /\.(flac|mp3|m4a|aac|ogg|opus|wv|ape|wav|aiff?)$/i;
let _wfParseFile;
function wfParseFile(file, opts) {
  if (_wfParseFile === undefined) {
    try {
      const mm = require("music-metadata");
      _wfParseFile = mm.parseFile || (mm.default && mm.default.parseFile) || null;
    } catch (e) { _wfParseFile = null; }
  }
  if (!_wfParseFile) return Promise.resolve({ common: {} });
  return _wfParseFile(file, opts);
}

function wfGet(tkey) {
  if (!labelsDb || !tkey) return null;
  try {
    const row = labelsDb.prepare("SELECT peaks, n FROM waveforms WHERE tkey = ?").get(tkey);
    return row ? { peaks: row.peaks, n: row.n } : null;
  } catch (e) { return null; }   // a read failure is "no waveform", not an outage
}
/*
 * Throw away every stored waveform when the ANALYSIS changes.
 *
 * A waveform is only comparable with others taken the same way, and there are
 * three ways "the same way" can move:
 *
 *   the decode RATE — 16 kHz lowpasses at 8 kHz and loses the top of every
 *     cymbal; 44.1 kHz keeps it, and the two draw visibly different shapes for
 *     the same audio
 *   the CHANNEL COUNT — a mono downmix is an addition, so an out-of-phase
 *     passage reads as silence where both channels read as full scale
 *   the STATISTIC (WF.WAVE_GEN) — the loudest sample in a slice and the RMS of
 *     that slice are different numbers about the same audio, and the first one
 *     draws a brick
 *
 * None of those is visible on screen, and a stored row is never re-decoded, so
 * a library holding two generations would draw two kinds of picture with
 * nothing to say which is which — worse than either on its own, because the
 * inconsistency is invisible and unexplainable.
 *
 * So the whole stamp is recorded next to the data, and any change to it wipes
 * the table. That costs a re-analysis: local files are re-read from disk, and
 * streamed tracks are fetched again the next time they play. Both are the
 * ordinary first-play cost, paid once.
 */
function wfAnalysisStamp() {
  return WF.WAVE_GEN + ":" + WFD.DECODE_RATE + ":" + WFD.DECODE_CHANNELS;
}

function wfCheckAnalysis() {
  if (!labelsDb) return;
  const want = wfAnalysisStamp();
  // A missing key is a mismatch on purpose: it is either a fresh install (the
  // table is empty, so the wipe is free) or an upgrade from a version that
  // recorded only the rate — whose rows were measured with the old statistic
  // and have to go regardless of what that rate was.
  const had = String(_persisted.waveformAnalysis || "");
  if (had === want) return;
  try {
    const n = labelsDb.prepare("SELECT COUNT(*) c FROM waveforms").get().c;
    if (n) {
      labelsDb.prepare("DELETE FROM waveforms").run();
      console.log("[waveform] analysis " + (had || "unset") + " → " + want +
                  " (gen:rate:channels): cleared " + n + " stored waveform" +
                  (n === 1 ? "" : "s") + ", they will be re-analysed on next play");
    }
    // waveformRate is the key this replaced. Set to undefined rather than
    // left behind: JSON.stringify omits an undefined value, so the old key
    // goes out of settings.json instead of sitting there meaning nothing.
    savePersistedSettings({ waveformAnalysis: want, waveformRate: undefined });
  } catch (e) {
    // A failure here means the table is unreadable, which the next wfGet will
    // report anyway. Not fatal: the feature degrades to the plain bar rather
    // than taking startup with it.
    console.error("[waveform] could not clear waveforms for the analysis change:", e.message);
  }
}

function wfPut(tkey, u8) {
  if (!labelsDb || !tkey || !u8 || !u8.length) return;
  try {
    labelsDb.prepare(
      "INSERT OR REPLACE INTO waveforms (tkey, peaks, n, ts) VALUES (?, ?, ?, ?)"
    ).run(tkey, WF.encode(u8), u8.length, Date.now());
  } catch (e) {
    if (DEBUG) console.error("[waveform] store failed:", e.message);
  }
}

// Run once at startup, here rather than beside the schema: WF and WFD are both
// required at the top of this section, and _persisted and the database are
// ready long before it.
wfCheckAnalysis();

/*
 * Say once, at startup, whether ffmpeg is actually there.
 *
 * Every decode failure resolves to the same silent null, so an image built
 * without a working ffmpeg-static binary produced "the switch is on and
 * nothing is drawn" with not one line anywhere to explain it. One spawn of
 * `ffmpeg -version` at boot costs nothing and turns that into an answer in the
 * log — and names WHICH ffmpeg won, because "the npm one" and "whatever is on
 * PATH" fail in different ways.
 *
 * Unconditional, not gated on the setting: the setting can be switched on at
 * any time, and the line is worth having in the log from before that happens.
 */
WFD.ffmpegProbe().then(p => {
  if (p.ok) {
    console.log("[waveform] ffmpeg ready via " + p.source + (p.version ? " — " + p.version : ""));
  } else {
    console.error("[waveform] NO WORKING FFMPEG (" + p.source + "): " +
                  (p.error || "unknown") + " — no waveforms can be produced. " +
                  "GET /api/debug/waveform for the whole chain.");
  }
}).catch(() => { /* the probe is diagnostics; it must never take startup down */ });

// Which albumKey (if any) this album/artist is known locally under.
//
// The second rung is for the albums Roon supplies no artist for — it sends
// three_line.line2 as "" for a real share of a library, which makes the key
// "blind man s zoo||" and matches nothing, so an album sitting in /music got no
// waveform at all. Falling back to the TITLE alone would normally be too loose;
// what makes it safe is asking the question in directories rather than keys.
// The walk deliberately files one folder under several artist spellings, so
// several matching keys is the ordinary case; two distinct FOLDERS is the
// ambiguous one, and that gets nothing.
function wfAlbumKey(album, artist) {
  for (const k of albumKeys(album || "", artist || "")) {
    if (localAlbumDirs.has(k)) return k;
  }
  // ONLY when the artist is unusable. With a real artist a miss is a real
  // answer — "we do not have this album" — and falling to the title would claim
  // whatever else shares the name: Roon plays Alex G's "Rocket" from Qobuz, the
  // library holds Goldfrapp's "Rocket", and v1.8.4 handed back the Goldfrapp
  // folder. wfResolveFile's track-title check caught it in practice, but the
  // answer was wrong before it got there, and a shared track title would have
  // put a different record's shape under the song. Same guard titleOnlySource
  // carries; it was missing here.
  if (canonArtist(artist || "")) return null;
  const titles = albumKeys(album || "", "").map(AK.titleOf).filter(Boolean);
  const hits = AK.titleOnlyMatches(localAlbumDirs.keys(), titles);
  return AK.soleTargetKey(hits, localAlbumDirs);
}

// The audio files in an album's directory, with their title tags. One readdir
// plus a tag read per file, cached per album.
async function wfAlbumFiles(albumKey) {
  if (_wfDirCache.has(albumKey)) return _wfDirCache.get(albumKey);
  const dir = localAlbumDirs.get(albumKey);
  if (!dir) return [];
  let out = [];
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && WF_AUDIO_RE.test(e.name))
      .map(e => e.name)
      .sort();
    for (const name of names) {
      const full = path.join(dir, name);
      let title = "";
      try {
        const meta = await wfParseFile(full, { duration: false, skipCovers: true });
        title = (meta.common && meta.common.title) || "";
      } catch (e) { /* unreadable or untagged: the filename fallback below */ }
      // No title tag is common on older rips. The filename minus its extension
      // and any leading track number is a decent stand-in, and a wrong match
      // here costs a wrong picture, not wrong playback.
      if (!title) title = name.replace(/\.[^.]+$/, "").replace(/^\s*\d+[\s._-]+/, "");
      out.push({ file: full, title });
    }
  } catch (e) {
    if (DEBUG) console.error("[waveform] cannot read " + dir + ":", e.message);
  }
  _wfDirCache.set(albumKey, out);
  return out;
}

/*
 * Is this the same track title?
 *
 * TM.canon, THE SAME ONE THE STREAMING MATCHER USES. This was its own weaker
 * rule — lowercase and collapse whitespace, nothing else — and it made the two
 * halves of one question disagree about punctuation:
 *
 *     Roon says   Don't Panic      (U+0027 apostrophe)
 *     the tag says Don’t Panic      (U+2019, what nearly every tagger writes)
 *
 * Those are not equal, and they are not CONTAINED in one another either, so the
 * fallback missed too and the track resolved to no file at all. Every track
 * whose tag carries a typographic apostrophe — a huge share of any real library
 * — silently had no local waveform, while the Qobuz and TIDAL paths handled it
 * from the day they were written because they canonicalise properly.
 *
 * Found from a user's probe output: Parachutes resolved to its folder, all ten
 * files listed, and matched_file null with "Don't Panic" sitting one line above
 * "Don’t Panic". (v1.8.54.)
 *
 * ONE definition of "same title", not two. The same reason the Qobuz gates had
 * to stop being spelled out three ways in v1.8.51: a second spelling of one
 * question is a bug waiting for the day the two drift, and this one had already
 * drifted.
 */
// A declaration, not a const arrow: the test suite extracts this by name, and a
// helper that decides which track you are looking at should be reachable by the
// tests that pin what "the same title" means.
function wfCanon(t) { return TM.canon(t); }

async function wfResolveFile(albumKey, trackTitle) {
  const want = wfCanon(trackTitle);
  if (!want) return null;
  const files = await wfAlbumFiles(albumKey);
  // Every file that canonicalises the same, not the FIRST one. An album really
  // can list a title twice (a reprise, a hidden duplicate), and picking one is
  // a guess — the same guess TM.matchTrack refuses on the streaming side, for
  // the same reason: a waveform of the wrong track looks authoritative and is
  // simply a different song. `find` took the first and said nothing.
  const exact = files.filter(f => wfCanon(f.title) === want);
  if (exact.length > 1) {
    console.log("[waveform] " + exact.length + " files in that folder are called \"" +
                trackTitle + "\" — ambiguous, so no waveform rather than a guess");
    return null;
  }
  let hit = exact[0];
  // Roon's track title can carry a suffix the tag does not (or the reverse),
  // so containment is the fallback — but only when it is UNAMBIGUOUS. Two
  // candidates means we do not know, and a waveform of the wrong track is
  // worse than none: it looks authoritative and it is simply a different song.
  if (!hit) {
    const near = files.filter(f => {
      const t = wfCanon(f.title);
      return t && (t.includes(want) || want.includes(t));
    });
    if (near.length === 1) hit = near[0];
  }
  return hit ? hit.file : null;
}

// One decode at a time, plus one queued prefetch. Decoding is the only CPU this
// extension spends in bulk, and the box it runs on also has to serve the UI.
let _wfBusy = null;          // tkey currently decoding
let _wfPrefetch = null;      // { tkey, signal } the queued next-track decode
// tkey -> the in-flight wfCompute for it, so two askers share one decode. This
// is the normal case here, not a corner: a phone and the wall display pointed
// at the same zone both request the track that just started, within a second of
// each other. Without this the second one either spawns a duplicate ffmpeg for
// the same file or is told "busy" about a decode of the very thing it wants.
const _wfInflight = new Map();
// zoneId -> the track that was playing last time we looked. The zone push
// arrives many times a second while a track plays (seek position alone), and
// wfPeekNext costs a Core round trip, so nothing below it may run per-push.
const _wfLastNp = new Map();

function wfCompute(albumKey, track, signal, seconds) {
  const tkey = WF.trackKey(albumKey, track);
  if (!tkey) return Promise.resolve(null);
  const have = wfGet(tkey);
  if (have) return Promise.resolve(have);
  const already = _wfInflight.get(tkey);
  if (already) return already;
  const p = wfDecodeOnce(albumKey, track, tkey, signal, seconds)
    .finally(() => { _wfInflight.delete(tkey); });
  _wfInflight.set(tkey, p);
  return p;
}

async function wfDecodeOnce(albumKey, track, tkey, signal, seconds) {
  const file = await wfResolveFile(albumKey, track);
  if (!file) return null;
  const t0 = Date.now();
  // The track's length goes with the decode. A waveform is a map from time to a
  // picture, so a file that decodes two thirds of the way — a damaged rip, a
  // half-copied download — draws those two thirds across the WHOLE bar and puts
  // the playhead over the wrong moment. decodeWaveform refuses rather than
  // storing it; see MIN_COVERAGE.
  const peaks = await WFD.decodeWaveform(file, { signal, expectSeconds: seconds || 0 });
  if (!peaks) {
    const why = WFD.lastDecodeError();
    console.log("[waveform] no waveform for " + track + (why ? " (" + why + ")" : ""));
    return null;
  }
  wfPut(tkey, peaks);
  console.log("[waveform] " + track + " in " + (Date.now() - t0) + "ms");
  return { peaks: WF.encode(peaks), n: peaks.length };
}

/*
 * The next track, decoded while the current one plays.
 *
 * ONE ahead, never more. The queue reshuffles constantly — a skip, a new album,
 * Roon Radio picking something — so anything past the next item is CPU spent on
 * tracks that will not play. One ahead is the whole win anyway: it turns the
 * only visible wait (a cold track) into an instant one.
 *
 * The in-flight prefetch is cancelled rather than awaited when the queue moves,
 * because a 20-minute decode nobody wants any more is 20 minutes of a core the
 * playing track needs.
 */
/*
 * The next item in a zone's queue.
 *
 * RoonApiTransport has no one-shot get_queue, so this is the same
 * subscribe / read the first payload / unsubscribe dance /api/queue does. Two
 * items is all it asks for, and it runs once per track change — cheap next to
 * the ~8 browse round trips a single track resolution costs elsewhere.
 *
 * Resolves null for anything at all rather than rejecting: this is a
 * best-effort warm-up, and a queue it cannot read simply means the next track
 * is decoded on demand like the current one was.
 */
function peekQueueRaw(zoneId, count) {
  return new Promise((resolve) => {
    if (!core || !zoneId) return resolve([]);
    let done = false, sub = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sub) { try { sub.unsubscribe(() => {}); } catch (e) { /* already gone */ } }
      resolve(v);
    };
    const timer = setTimeout(() => finish([]), 5000);
    if (timer.unref) timer.unref();
    try {
      sub = core.services.RoonApiTransport.subscribe_queue(zoneId, count, (response, msg) => {
        if (response !== "Subscribed") return;
        finish((msg && msg.items) || []);
      });
    } catch (e) { finish([]); }
  });
}

async function wfPeekNext(zoneId) {
  // [0] is what is playing; [1] is the one worth warming.
  const it = (await peekQueueRaw(zoneId, 2))[1];
  if (!it) return null;
  const t3 = it.three_line || {};
  return {
    track:  t3.line1 || (it.one_line && it.one_line.line1) || "",
    artist: t3.line2 || "",
    album:  t3.line3 || "",
    // The queue item carries its length, and the streaming path needs it: the
    // duration gate is the only thing separating this track from a remaster of
    // it with the same title.
    seconds: Number.isFinite(it.length) ? it.length : 0,
  };
}

async function wfPrefetchNext(zone) {
  if (!waveformEnabled || !labelsDb) return;
  const zid = zone && zone.zone_id;
  if (!zid) return;
  const nowTrack = (zone.now_playing && zone.now_playing.three_line &&
                    zone.now_playing.three_line.line1) ||
                   (zone.now_playing && zone.now_playing.line1) || "";
  if (!nowTrack || _wfLastNp.get(zid) === nowTrack) return;   // same track: nothing to do
  _wfLastNp.set(zid, nowTrack);
  const next = await wfPeekNext(zid);
  if (!next || !next.track) return;
  const akey = wfAlbumKey(next.album, next.artist);
  if (!akey) {
    // Not under /music. If it is a favourite on either service it can still be
    // warmed, and the wait it saves is larger here than for a local file: this
    // one has a download in front of the decode.
    wfQobuzTrack(next.album, next.artist, next.track, next.seconds || 0)
      .then((got) => got || wfTidalTrack(next.album, next.artist, next.track, next.seconds || 0))
      .catch(() => { /* best effort; the endpoint asks again on demand */ });
    return;
  }
  const tkey = WF.trackKey(akey, next.track);
  if (!tkey || tkey === _wfBusy) return;
  if (_wfPrefetch && _wfPrefetch.tkey === tkey) return;   // already queued
  if (wfGet(tkey)) return;                 // already known
  if (_wfPrefetch) _wfPrefetch.signal.aborted = true;
  const signal = { aborted: false };
  _wfPrefetch = { tkey, signal };
  wfCompute(akey, next.track, signal, next.seconds || 0)
    .catch(e => { if (DEBUG) console.error("[waveform] prefetch:", e.message); })
    .finally(() => { if (_wfPrefetch && _wfPrefetch.tkey === tkey) _wfPrefetch = null; });
}

/* ===================== Streaming waveforms (Qobuz) =====================
 *
 * Roon streams Qobuz to the endpoint and never to an extension, so there is no
 * audio here to read. This fetches the track from Qobuz directly, with the
 * user's own account, decodes it to peaks and throws the audio away.
 *
 * OFF BY DEFAULT AND GATED ON A SECRET THE APP DOES NOT SHIP. track/getFileUrl
 * is a signed endpoint; the app_secret is a Settings field the user fills in
 * themselves. With it blank none of this runs. That is deliberate on two
 * counts: the secret rotates whenever Qobuz updates their web player, so baking
 * one in would guarantee a build that quietly stops working; and retrieving
 * audio from an unofficial API is against Qobuz's terms, which should be a
 * decision someone made rather than a default they inherited.
 *
 * NOTHING IS WRITTEN TO DISK. The HTTPS response is piped straight into ffmpeg
 * (see decodeWaveform's `input`), so "no audio is stored" is a fact about how
 * the bytes moved rather than a cleanup promise a crash could break. MP3 320 is
 * requested rather than FLAC: the peaks are resampled to 1000 buckets from an
 * 8 kHz mono decode, where a lossy envelope is indistinguishable — at ~7 MB a
 * track instead of 30-150.
 *
 * Every step can decline, and declining means the plain progress bar:
 *   1. the feature is off, or no secret is set;
 *   2. the album is not confidently ONE Qobuz favourite (locateByTitle);
 *   3. Qobuz will not name a track of that title AND that length (matchTrack);
 *   4. the URL comes back a preview, or not at all;
 *   5. ffmpeg cannot decode what arrives.
 */

/*
 * The whole streaming path for one track: cache, identify, fetch, store.
 *
 * Keyed "qobuz:<album id> <title>" rather than by the album identity the local
 * path uses. Those keys come from Roon's spelling of an album, which is exactly
 * what is unreliable here — it is why this feature needed a title-only rung at
 * all. The Qobuz album id is stable, and it is what the peaks actually came
 * from.
 */
/*
 * Say a thing once per reason, not once per request.
 *
 * The clients poll, so a decline that logs every time turns the reason into
 * noise and buries it — which is the same outcome as not logging it. Keyed by
 * reason so a DIFFERENT decline still gets through immediately.
 */
async function wfQobuzTrack(album, artist, track, seconds) {
  if (!waveformEnabled || !labelsDb) return null;
  // Every decline below says why. v1.8.6 returned from these three in silence,
  // so the one failure that actually happened — no album ids after a restart —
  // produced no waveform, no error and no log line to look at.
  if (!qobuzWaveToken && !String(qobuzAppSecret || "").trim()) {
    // NOT behind DEBUG. This is the likeliest reason of them all — it is the
    // default state — and hiding it behind a flag is what made v1.8.6 look
    // broken rather than switched off. Said ONCE, because the clients poll and
    // a line per request would bury the log it belongs in.
    wfQobuzSayOnce("no-signin",
      "[waveform] qobuz: a Qobuz album is playing and this extension is not " +
      "signed in to Qobuz for waveforms — Settings → Playback → " +
      "Qobuz waveforms → Connect. Local files are unaffected.");
    return null;
  }
  // The favourites first — free, already in memory, and the only source that
  // needs no call. Then the catalogue, which is what makes an album played from
  // a search reachable at all. See wfQobuzSearchAlbumId.
  let albumId = wfQobuzAlbumId(album, artist);
  if (!albumId) albumId = await wfQobuzSearchAlbumId(album, artist);
  if (!albumId) {
    // Keyed by ALBUM: the clients re-ask every poll, and one line per album is
    // the useful amount — enough to see which records are unreachable, not
    // enough to drown the log.
    wfQobuzSayOnce("noid:" + album,
      "[waveform] qobuz: no Qobuz album id for \"" + album + "\" by \"" +
      (artist || "(none)") + "\" — not among the " + qobuzAlbumIds.size +
      " favourites and the catalogue search did not identify it either" +
      (qobuzAlbumIds.size ? "" : " (favourites not read yet)"));
    return null;
  }

  const tkey = WF.trackKey("qobuz:" + albumId, track);
  if (!tkey) return null;
  const have = wfGet(tkey);
  if (have) return { peaks: have.peaks, n: have.n, cached: true, source: "qobuz" };

  // The same sharing the local decode uses: a phone and the wall display asking
  // together must fetch this once, not twice.
  const already = _wfInflight.get(tkey);
  if (already) {
    const p = await already;
    return p ? { peaks: p.peaks, n: p.n, cached: false, source: "qobuz" } : null;
  }
  const job = (async () => {
    const peaks = await wfQobuzCompute(albumId, track, seconds, null);
    if (!peaks) return null;
    wfPut(tkey, peaks);
    return { peaks: WF.encode(peaks), n: peaks.length };
  })().finally(() => { _wfInflight.delete(tkey); });
  _wfInflight.set(tkey, job);

  const out = await job;
  return out ? { peaks: out.peaks, n: out.n, cached: false, source: "qobuz" } : null;
}

/** The Qobuz album id for what Roon is playing, or null. */
function wfQobuzAlbumId(album, artist) {
  for (const k of albumKeys(album || "", artist || "")) {
    if (qobuzAlbumIds.has(k)) return qobuzAlbumIds.get(k);
  }
  // The title-only rung, for the albums Roon names without a usable artist —
  // "†††" canonicalises to nothing, so no key can ever match. Only when the
  // title lands on exactly one album in exactly one place.
  if (canonArtist(artist || "")) return null;
  const titles = albumKeys(album || "", "").map(AK.titleOf).filter(Boolean);
  const found = AK.locateByTitle(titles, {
    local: localAlbumKeys, qobuz: qobuzAlbumKeys, tidal: tidalAlbumKeys,
  });
  if (!found.confident || found.source !== "qobuz") return null;
  return qobuzAlbumIds.get(found.qobuz[0]) || null;
}

/*
 * The Qobuz album id for something that is NOT in the favourites.
 *
 * Until v1.8.55 the favourites were the only place an album id could come from,
 * and that was stated as a hard limit — an album played from a search, an
 * editorial list or Roon's own browser had no waveform and never would. A probe
 * against 11,455 loaded favourites answered `near: []` for the album playing at
 * the time: not spelled differently, not absent by accident, simply never
 * favourited. It could have waited for ever.
 *
 * The catalogue is searchable with the token that already reads the favourites,
 * so the id IS obtainable. Three things make using it safe:
 *
 *   the MATCH is an exact identity, built by favouriteTitleForms — the same
 *     builder the favourites index uses, so a search hit and a favourite are
 *     keyed the same way and cannot disagree;
 *   AMBIGUITY DECLINES (lib/albumsearch.js). Qobuz answers a query it cannot
 *     place with its nearest guess rather than with nothing, so "the first
 *     result" is never an answer here;
 *   and being wrong is survivable anyway: TM.matchTrack gates on title AND
 *     duration, so a different pressing draws nothing rather than putting a
 *     confident picture of another recording under the seek bar.
 *
 * Memoised per identity INCLUDING the misses, so an album that is not on Qobuz
 * costs one search for the life of the process rather than one per poll.
 */
const _wfQobuzSearched = new Map();    // wanted key -> album id or null
const _wfQobuzSearching = new Map();   // wanted key -> in-flight promise
async function wfQobuzSearchAlbumId(album, artist) {
  if (!qobuzReady()) return null;
  const wanted = albumKeys(album || "", artist || "");
  if (!wanted.length) return null;
  // Keyed on the FIRST identity, which is the whole-credit one: it is the same
  // for every call about this album, while the list itself is order-stable but
  // longer than a cache key wants to be.
  const ck = wanted[0];
  if (_wfQobuzSearched.has(ck)) return _wfQobuzSearched.get(ck);
  const already = _wfQobuzSearching.get(ck);
  if (already) return already;

  const job = (async () => {
    let items = [];
    try {
      const r = await qobuzWithToken((t) =>
        qobuz.searchCatalog(t, (album || "") + " " + (artist || ""), 20, 0));
      items = (r && r.albums && r.albums.items) || [];
    } catch (e) {
      // A failed search is NOT cached as "not on Qobuz": a rate limit or a
      // network blip would otherwise switch the fallback off for this album
      // until the container restarts.
      console.log("[waveform] qobuz: catalogue search failed for \"" + album +
                  "\": " + ((e && e.message) || "unknown"));
      return undefined;
    }
    const candidates = items.map((a) => ({
      id: a && a.id,
      keys: favouriteTitleForms(a && a.title, a && a.version)
        .flatMap((t) => [(a.artist && a.artist.name), (a.performer && a.performer.name)]
          .filter(Boolean)
          .map((who) => albumKey(t, who)))
        .filter(Boolean),
    }));
    const picked = ABS.pickAlbumId(wanted, candidates);
    console.log("[waveform] qobuz: \"" + album + "\" is not a favourite; catalogue " +
                "search " + (picked.id ? "found album " + picked.id + " — " + picked.reason
                                       : "declined — " + picked.reason));
    return picked.id || null;
  })().finally(() => { _wfQobuzSearching.delete(ck); });

  _wfQobuzSearching.set(ck, job);
  const got = await job;
  // undefined means the search itself failed — try again next time.
  if (got !== undefined) _wfQobuzSearched.set(ck, got);
  return got || null;
}

/**
 * Everything up to the audio: which credentials work, which track this is, and
 * the time-limited url for it. Returns { url, stop, detail, tried }.
 *
 * SPLIT OUT OF wfQobuzCompute IN v1.8.52 so /api/debug/waveform can report the
 * chain by RUNNING it rather than by re-implementing it. A probe that walks its
 * own copy of this ladder answers about itself, and the first time the two drift
 * the probe starts lying with total confidence — which is worse than no probe,
 * because it is believed. One body, two callers.
 *
 * `stop` names where it got to: "no-credentials" | "album" | "track" | "audio"
 * | "ok". `detail` is the sentence for a human; `tried` is what each credential
 * set said, which is the difference between a diagnosis and a shrug.
 */
async function wfQobuzResolveAudio(albumId, track, seconds) {
  const secret = String(qobuzAppSecret || "").trim();
  // Off entirely only when there is neither a sign-in nor a legacy pasted secret.
  if (!secret && !qobuzWaveToken) {
    return { url: null, stop: "no-credentials", tried: [],
             detail: "no Qobuz sign-in and no pasted app secret" };
  }

  // ONE TOKEN, SEVERAL PAIRS — the shape a working Qobuz client actually uses.
  // v1.8.11 swapped the TOKEN along with the app_id and broke the album read,
  // which had been fine: `album/get` is unsigned, and this app's own login is
  // the token known to be live, since it is what read the favourites these
  // album ids came from. The token stays put; what varies is the app_id, which
  // pairs with the secret for the SIGNATURE only.
  //
  // Which combination Qobuz accepts cannot be determined from outside, so the
  // credential sets are tried in order and the first that yields audio wins.
  // The credential sets to try, best first, each resolved LAZILY. Minting costs
  // a login round trip and, for a signing app that does not accept passwords,
  // can only ever fail — so building it up front spent a doomed request and a
  // log line every 60s behind a pasted token that was already working.
  const attempts = [];
  // FIRST: the token from signing in on Qobuz's own page. It is minted by the
  // app whose secret is built in, so this set needs nothing from the user
  // beyond that one sign-in — nothing pasted, no credentials typed in here.
  if (qobuzWaveToken) {
    attempts.push({
      label: "the Qobuz sign-in",
      get: () => qobuzWaveToken,
      readAppId: QOA.APP_ID,
      secret: QOA.APP_SECRET,
    });
  }
  // Then a token supplied with a pasted pair. No UI offers this any more, but
  // an install that already had one keeps working instead of going dark on
  // upgrade.
  if (qobuzSignToken) {
    attempts.push({
      label: "the token saved from a pasted file",
      get: () => qobuzSignToken,
      readAppId: qobuzSignAppId || undefined,
    });
  }
  // Then one minted under the signing app, for a secret whose app DOES accept a
  // password login. Only reached when there is no pasted token or it failed.
  if (qobuzSignAppId) {
    attempts.push({
      label: "a token minted under app " + qobuzSignAppId,
      get: () => qobuzSigningToken(),
      readAppId: qobuzSignAppId,
    });
  }
  // Last, this app's own login — right when the secret belongs to this app's
  // own app_id, which is the case for a bare secret paste.
  attempts.push({
    label: "this app's Qobuz login",
    get: () => null,                   // null = the app's own, via qobuzWithToken
    readAppId: undefined,              // its own app_id, which minted that token
  });
  const signAs = qobuzSignAppId || undefined;

  const reasons = [];
  // Declared here, not with `var` inside the loop: the loop assigns it and the
  // check below reads it, and a hoisted declaration inside a block is the exact
  // shape this project has been bitten by (see the declaration-before-use rule).
  //
  // What the album read produced, if any set got that far. It is how "no
  // credential could read the album" is told apart from "the album read fine
  // and the audio was refused" once the loop has ended.
  let matched = null;
  for (const a of attempts) {
    // Resolved here, not above: reaching this entry is what makes its cost worth
    // paying, and the common case never reaches past the first.
    const tok = await a.get();
    if (tok === undefined || (tok === null && a.readAppId)) {
      // A mint that failed. It logged its own reason; record that this set was
      // unavailable rather than silently trying it as "this app's login".
      reasons.push(a.label + ": could not be obtained");
      continue;
    }
    // An attempt may bring its own signing pair — the built-in sign-in does,
    // and its secret belongs to its app_id and to no other. The rest fall back
    // to whatever is configured.
    const useSecret = a.secret || secret;
    const useSignAs = a.secret ? a.readAppId : signAs;
    const withTok = (fn) => tok ? fn(tok) : qobuzWithToken(fn);

    const got = await withTok((t) => qobuz.getAlbumResult(t, albumId, 12000, a.readAppId))
      .catch((e) => ({ album: null, reason: qobuz.describeQobuzError(e, false) }));
    if (!got || !got.album) {
      reasons.push(a.label + ": " + ((got && got.reason) || "unknown"));
      if (tok && _qobuzSignTok && tok === _qobuzSignTok.token) _qobuzSignTok = null;
      continue;
    }

    // The track match does not depend on the credentials, so a failure here is
    // final — retrying with another login would ask the same question twice.
    const m = TM.matchTrack(got.album.tracks, track, seconds);
    if (!m.track) {
      // Final, not a reason to try the next credential set: the track list is
      // the same whoever asks, so retrying would put the identical question a
      // second time. The album's track COUNT rides along because "no track
      // called X" and "no track called X in the 50 of 137 we were sent" are
      // different findings — see the paging fix in lib/qobuz.js.
      return { url: null, stop: "track", tried: reasons, detail: m.reason,
               album_title: got.album.title || "",
               album_tracks: got.album.tracks.length };
    }

    const f = await withTok((t) => qobuz.getFileUrlResult(t, m.track.id, useSecret, { appId: useSignAs }))
      .catch((e) => ({ url: null, reason: qobuz.describeFileUrlError(e) }));
    if (f && f.url) {
      return { url: f.url, stop: "ok", tried: reasons, detail: m.reason,
               album_title: got.album.title || "",
               album_tracks: got.album.tracks.length,
               track_id: m.track.id, track_duration: m.track.duration,
               credentials: a.label };
    }
    reasons.push(a.label + ": " + ((f && f.reason) || "unknown"));
    matched = { title: got.album.title || "", n: got.album.tracks.length,
                reason: m.reason, duration: m.track.duration };
    // A minted token that stops working has expired. Forget it so the next play
    // mints a fresh one rather than replaying a dead credential forever.
    if (tok && _qobuzSignTok && tok === _qobuzSignTok.token) _qobuzSignTok = null;
  }

  // Nothing yielded audio. Whether the track was ever even identified decides
  // which stop this is: an album that could not be READ and a track that could
  // not be STREAMED need different things from the user.
  return { url: null, stop: matched ? "audio" : "album", tried: reasons,
           detail: matched ? matched.reason : "no credential set could read the album",
           album_title: matched ? matched.title : "",
           album_tracks: matched ? matched.n : 0,
           track_duration: matched ? matched.duration : null };
}

/**
 * The waveform for a Qobuz track, or null with a logged reason.
 *
 * `reason` is always logged rather than swallowed: "no waveform" with no
 * explanation is what makes this class of feature impossible to diagnose from a
 * user's report, and there are five separate ways to decline here.
 */
async function wfQobuzCompute(albumId, track, seconds, signal) {
  const got = await wfQobuzResolveAudio(albumId, track, seconds);
  if (!got.url) {
    if (got.stop === "no-credentials") return null;   // already said at the gate
    if (got.stop === "track") { console.log("[waveform] qobuz: " + got.detail); return null; }
    // Every set that was tried, and what Qobuz said to each. One line, because
    // a cause per attempt is the difference between a diagnosis and a shrug.
    console.log("[waveform] qobuz: no audio for \"" + track + "\" — " +
                (got.tried.length ? got.tried.join(" | ") : got.detail));
    return null;
  }
  const url = got.url;

  const t0 = Date.now();
  let peaks = null;
  try {
    const ctl = new AbortController();
    // The decode's own cancellation reaches the download through this: an
    // overtaken prefetch must stop pulling bytes, not just stop caring.
    const poll = setInterval(() => { if (signal && signal.aborted) ctl.abort(); }, 500);
    if (poll.unref) poll.unref();
    let r;
    try {
      r = await fetch(url, { signal: ctl.signal });
    } finally { clearInterval(poll); }
    if (!r.ok || !r.body) {
      console.log("[waveform] qobuz: stream HTTP " + r.status);
      return null;
    }
    // Node's fetch gives a web ReadableStream; ffmpeg wants a node Readable.
    const input = require("node:stream").Readable.fromWeb(r.body);
    // The length goes with it for the same reason as a local file, and it
    // matters more here: a download cut off halfway looks exactly like a short
    // track, and the shape would be stored as the answer for that recording.
    peaks = await WFD.decodeWaveform(null, { input, signal, expectSeconds: seconds || 0 });
  } catch (e) {
    console.log("[waveform] qobuz: stream failed for \"" + track + "\": " + e.message);
    return null;
  }
  if (!peaks) {
    // WITH the reason. The local path has said why since v1.8.30 and this one
    // did not, so the single most common streaming failure after a successful
    // fetch — a truncated download refused by MIN_COVERAGE, which is
    // indistinguishable from a short track and must be refused — arrived as
    // four words with no cause in them.
    const why = WFD.lastDecodeError();
    console.log("[waveform] qobuz: could not decode \"" + track + "\"" +
                (why ? " (" + why + ")" : ""));
    return null;
  }
  console.log("[waveform] qobuz: " + track + " in " + (Date.now() - t0) + "ms");
  return peaks;
}

/* ---------------------------------------------------------------------------
 * TIDAL waveforms.
 *
 * Simpler than Qobuz in the one way that matters: TIDAL signs nothing. Its API
 * takes a Bearer token from the device sign-in this app already does, and that
 * sign-in REFRESHES ITSELF — so unlike Qobuz there is no credential to go stale
 * and nothing for the user to reconnect.
 *
 * Harder in one way: it does not hand back a URL. The playback call answers with
 * a base64 manifest, and only the plain "BTS" kind carries audio this can read.
 * Higher tiers arrive in a protected container and are refused outright — see
 * lib/tidal-manifest.js. That refusal is the correct answer, not a gap.
 * ------------------------------------------------------------------------ */

/** The TIDAL album id for what Roon is playing, or null. */
function wfTidalAlbumId(album, artist) {
  for (const k of albumKeys(album || "", artist || "")) {
    if (tidalAlbumIds.has(k)) return tidalAlbumIds.get(k);
  }
  // The title-only rung, for albums Roon names without a usable artist. Only
  // when the title lands on exactly one album in exactly one place — the same
  // discipline the Qobuz side uses, and for the same reason.
  if (canonArtist(artist || "")) return null;
  const titles = albumKeys(album || "", "").map(AK.titleOf).filter(Boolean);
  const found = AK.locateByTitle(titles, {
    local: localAlbumKeys, qobuz: qobuzAlbumKeys, tidal: tidalAlbumKeys,
  });
  if (!found.confident || found.source !== "tidal") return null;
  return tidalAlbumIds.get(found.tidal[0]) || null;
}

async function wfTidalCompute(albumId, track, seconds, signal) {
  const alb = await tidalWithToken((t, cc) => tidal.getAlbumTracks(t, cc, albumId))
    .catch(() => null);
  if (!alb) { console.log("[waveform] tidal: album " + albumId + " could not be read"); return null; }

  const m = TM.matchTrack(alb.tracks, track, seconds);
  if (!m.track) { console.log("[waveform] tidal: " + m.reason); return null; }

  const got = await tidalWithToken((t, cc) => tidal.getTrackStream(t, cc, m.track.id))
    .catch((e) => ({ url: null, reason: (e && e.message) || "playback request failed" }));
  if (!got || !got.url) {
    console.log("[waveform] tidal: no audio for \"" + track + "\" — " +
                ((got && got.reason) || "unknown reason"));
    return null;
  }

  const t0 = Date.now();
  let peaks = null;
  try {
    const ctl = new AbortController();
    const poll = setInterval(() => { if (signal && signal.aborted) ctl.abort(); }, 500);
    if (poll.unref) poll.unref();
    let r;
    try { r = await fetch(got.url, { signal: ctl.signal }); }
    finally { clearInterval(poll); }
    if (!r.ok || !r.body) { console.log("[waveform] tidal: stream HTTP " + r.status); return null; }
    const input = require("node:stream").Readable.fromWeb(r.body);
    // As with Qobuz: a truncated download is indistinguishable from a short
    // track unless the length is stated, and the wrong shape would be stored.
    peaks = await WFD.decodeWaveform(null, { input, signal, expectSeconds: seconds || 0 });
  } catch (e) {
    console.log("[waveform] tidal: stream failed for \"" + track + "\": " + e.message);
    return null;
  }
  if (!peaks) {
    const why = WFD.lastDecodeError();
    console.log("[waveform] tidal: could not decode \"" + track + "\"" +
                (why ? " (" + why + ")" : ""));
    return null;
  }
  console.log("[waveform] tidal: " + track + " in " + (Date.now() - t0) + "ms");
  return peaks;
}

const _wfTidalSaid = new Set();
async function wfTidalTrack(album, artist, track, seconds) {
  if (!waveformEnabled || !labelsDb) return null;
  if (!tidalReady()) {
    if (!_wfTidalSaid.has("no-tidal")) {
      _wfTidalSaid.add("no-tidal");
      console.log("[waveform] tidal: a TIDAL album is playing and TIDAL is not connected. " +
                  "Settings → Streaming accounts.");
    }
    return null;
  }
  const albumId = wfTidalAlbumId(album, artist);
  if (!albumId) {
    if (!_wfTidalSaid.has("noid:" + album)) {
      _wfTidalSaid.add("noid:" + album);
      console.log("[waveform] tidal: no TIDAL album id for \"" + album + "\" by \"" +
                  (artist || "(none)") + "\" — " + tidalAlbumIds.size + " ids known" +
                  (tidalAlbumIds.size ? " (is it in your TIDAL FAVOURITES? playing from search is not enough)"
                                      : " (favourites not read yet)"));
    }
    return null;
  }

  const tkey = WF.trackKey("tidal:" + albumId, track);
  if (!tkey) return null;
  const have = wfGet(tkey);
  if (have) return { peaks: have.peaks, n: have.n, cached: true, source: "tidal" };

  const already = _wfInflight.get(tkey);
  if (already) {
    const p = await already;
    return p ? { peaks: p.peaks, n: p.n, cached: false, source: "tidal" } : null;
  }
  const job = (async () => {
    const peaks = await wfTidalCompute(albumId, track, seconds, null);
    if (!peaks) return null;
    wfPut(tkey, peaks);
    return { peaks: WF.encode(peaks), n: peaks.length };
  })().finally(() => { _wfInflight.delete(tkey); });
  _wfInflight.set(tkey, job);

  const out = await job;
  return out ? { peaks: out.peaks, n: out.n, cached: false, source: "tidal" } : null;
}

/*
 * Signing in to Qobuz for waveforms.
 *
 * Three routes, and the whole point of them is that no credential is ever typed
 * into this app: /start hands back a qobuz.com URL, the user signs in THERE, and
 * Qobuz redirects their browser to /callback with a one-time code that trades
 * for a token. The password never comes near this process.
 *
 * The redirect address is taken from the request that asked for it, so whatever
 * the user reached this page on — a LAN IP, a hostname, a reverse proxy — is
 * where Qobuz sends them back. Nothing to configure, and it works unchanged
 * inside Docker, which has no idea what address it is reached on.
 */
app.get("/api/qobuz/oauth/start", (req, res) => {
  const cb = QOA.callbackUrlFrom(req, "/api/qobuz/oauth/callback");
  if (!cb) return res.status(400).json({ error: "could not work out this server's address" });
  res.json({ url: QOA.buildAuthorizeUrl(cb), redirect_url: cb });
});

// Where Qobuz sends the browser back. Answers HTML, not JSON: a person is
// looking at this, having just come from a sign-in page.
app.get("/api/qobuz/oauth/callback", async (req, res) => {
  const page = (title, body) =>
    "<!doctype html><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>" + title + "</title>" +
    "<body style=\"font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:12vh auto;padding:0 24px\">" +
    body + "</body>";

  const code = QOA.extractCode(req.originalUrl || "");
  if (!code) {
    return res.status(400).send(page("Sign-in incomplete",
      "<h2>Qobuz did not send a sign-in code back.</h2><p>The sign-in may have been " +
      "cancelled. Close this tab and try Connect again.</p>"));
  }
  try {
    const got = await QOA.exchangeCode(code);
    qobuzWaveToken = got.token;
    qobuzWaveUser  = got.userId;
    qobuzWaveName  = qobuzDisplayName || "";
    savePersistedSettings({ qobuzWaveToken, qobuzWaveUser, qobuzWaveName });
    // The whole Qobuz session moves to this token now, so every call has to
    // present its app_id, and the favourites read under the old one is stale.
    qobuzSyncAppId();
    refreshStreamAlbumKeys('qobuz sign-in');
    // The declines logged so far were about the old state; forget them so the
    // next play reports what is true now instead of staying quiet about it.
    _wfQobuzSaid.clear();
    console.log("[waveform] qobuz: signed in for waveforms (user " + got.userId + ")");
    res.send(page("Connected",
      "<h2>Qobuz connected.</h2><p>Waveforms will now be drawn for Qobuz tracks. " +
      "You can close this tab and go back to MusicD Remote.</p>"));
  } catch (e) {
    console.log("[waveform] qobuz: sign-in failed — " + (e && e.message));
    res.status(400).send(page("Sign-in failed",
      "<h2>Could not finish signing in.</h2><p>" +
      String((e && e.message) || "Unknown error").replace(/[<>&]/g, "") +
      "</p><p>Close this tab and try Connect again.</p>"));
  }
});

// The fallback for a sign-in done on a device that cannot reach this server —
// a phone on mobile data, say. The user lands on an address that fails to load
// and pastes it here instead. Same exchange, different way in.
app.post("/api/qobuz/oauth/paste", async (req, res) => {
  const code = QOA.extractCode((req.body && req.body.url) || "");
  if (!code) return res.status(400).json({ error: "no sign-in code found in that address" });
  try {
    const got = await QOA.exchangeCode(code);
    qobuzWaveToken = got.token;
    qobuzWaveUser  = got.userId;
    qobuzWaveName  = qobuzDisplayName || "";
    savePersistedSettings({ qobuzWaveToken, qobuzWaveUser, qobuzWaveName });
    // The whole Qobuz session moves to this token now, so every call has to
    // present its app_id, and the favourites read under the old one is stale.
    qobuzSyncAppId();
    refreshStreamAlbumKeys('qobuz sign-in');
    _wfQobuzSaid.clear();
    res.json({ ok: true, connected: true });
  } catch (e) {
    res.status(400).json({ error: (e && e.message) || "sign-in failed" });
  }
});

app.post("/api/qobuz/oauth/disconnect", (req, res) => {
  qobuzWaveToken = qobuzWaveUser = qobuzWaveName = "";
  savePersistedSettings({ qobuzWaveToken: "", qobuzWaveUser: "", qobuzWaveName: "" });
  qobuzSyncAppId();
  _wfQobuzSaid.clear();
  res.json({ ok: true, connected: false });
});

app.get("/api/waveform", async (req, res) => {
  if (!waveformEnabled) return res.json({ peaks: null, reason: "off" });
  const track  = String(req.query.track  || "").trim();
  const album  = String(req.query.album  || "").trim();
  const artist = String(req.query.artist || "").trim();
  if (!track) return res.status(400).json({ error: "track required" });

  const akey = wfAlbumKey(album, artist);
  if (!akey) {
    // No local file. Roon streams Qobuz and TIDAL to the endpoint and no
    // extension can see that audio — but if this is a Qobuz favourite and the
    // user configured a secret, it can be fetched from Qobuz directly.
    // Qobuz first, then TIDAL. Roon does not say which service is playing, so
    // the album's presence in one favourites list is the only signal there is —
    // and an album in neither declines from both, cheaply, without a call.
    const secs = Number(req.query.length) || 0;
    let out = await wfQobuzTrack(album, artist, track, secs);
    if (!out) out = await wfTidalTrack(album, artist, track, secs);
    if (out) {
      res.set("Cache-Control", "public, max-age=604800, immutable");
      return res.json(out);
    }
    return res.json({ peaks: null, reason: "no-local-file" });
  }

  const tkey = WF.trackKey(akey, track);
  const cached = wfGet(tkey);
  if (cached) {
    // Immutable: a waveform is a property of the audio, and the audio for a
    // given track does not change. A week matches the artwork policy.
    res.set("Cache-Control", "public, max-age=604800, immutable");
    return res.json({ peaks: cached.peaks, n: cached.n, cached: true });
  }

  // Busy only means "another TRACK is decoding". A request for the one already
  // in flight joins it below rather than being turned away.
  if (_wfBusy && _wfBusy !== tkey && !_wfInflight.has(tkey)) {
    return res.json({ peaks: null, reason: "busy" });
  }
  _wfBusy = tkey;
  try {
    const out = await wfCompute(akey, track, null, Number(req.query.length) || 0);
    if (!out) return res.json({ peaks: null, reason: "undecodable" });
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.json({ peaks: out.peaks, n: out.n, cached: false });
  } catch (e) {
    res.json({ peaks: null, reason: "error" });
  } finally {
    _wfBusy = null;
  }
});

/*
 * GET /api/debug/waveform[?track=&album=&artist=][&zone=<id>]
 *
 * Why a waveform is not being drawn — every step of the chain, in one request.
 *
 * WHY THIS EXISTS: the whole pipeline answers with the same four words. A
 * missing ffmpeg, an unmounted /music, an album the walk never recorded a
 * directory for, a track title that does not match any tag in that folder and
 * a genuinely corrupt file are all `{peaks: null, reason: "undecodable"}` or
 * `"no-local-file"`, and nothing is logged for any of them. "It is switched on
 * and there are no waveforms" is therefore un-actionable from outside, and the
 * only way to tell the five apart was to ship a build with a log line in it and
 * wait. Five versions went that way on the Qobuz signature before a probe
 * endpoint ended it in one; this is that lesson applied before the fact rather
 * than after.
 *
 * Read-only and cheap: it reads the same caches the real route reads, does not
 * decode, and does not touch the Core beyond the zone it is already told about.
 * With no track given it uses whatever the zone is playing, which is the case
 * anybody actually wants to ask about.
 */
app.get("/api/debug/waveform", async (req, res) => {
  const out = { enabled: waveformEnabled, analysis: wfAnalysisStamp() };

  // 1. ffmpeg. First because it is the one failure that affects every track at
  //    once, and the one that no amount of staring at a library can explain.
  try {
    out.ffmpeg = await WFD.ffmpegProbe();
  } catch (e) {
    out.ffmpeg = { ok: false, error: e.message };
  }

  // 2. The /music mount and what the last walk recorded from it. dirs is the
  //    one the waveform needs: an index written before v1.7.90 carries keys
  //    but no directories, and then nothing local can ever resolve.
  out.music = {
    dir: MUSIC_DIR,
    mounted: musicDirMounted(),
    local_album_keys: localAlbumKeys.size,
    local_album_dirs: localAlbumDirs.size,
  };

  // 3. The track. Either the one asked about, or whatever the zone is playing.
  let track  = String(req.query.track  || "").trim();
  let album  = String(req.query.album  || "").trim();
  let artist = String(req.query.artist || "").trim();
  // The LENGTH, taken here with the rest of it. The duration gate is what tells
  // this recording from another edition of the same album, so a probe run with
  // no length has the one check that matters switched off — and the zone is
  // holding the number. (?length= still wins, for asking about an album that is
  // not playing.)
  let seconds = Number(req.query.length) || 0;
  if (!track) {
    const zone = req.query.zone ? zones[String(req.query.zone)]
                                : Object.values(zones).find(z => z && z.state === "playing");
    const np = zone && zone.now_playing;
    const tl = (np && np.three_line) || {};
    if (np) {
      track  = tl.line1 || np.line1 || "";
      artist = tl.line2 || np.line2 || "";
      album  = tl.line3 || np.line3 || "";
      if (!seconds && Number.isFinite(np.length)) seconds = np.length;
      out.from_zone = zone.display_name || zone.zone_id;
    }
  }
  out.track = { track, album, artist, seconds: seconds || null };
  if (!track) {
    out.verdict = "nothing playing and no track given — pass ?track=&album=&artist=";
    return res.json(out);
  }

  /*
   * 3b. THE STREAMING CHAIN, reported for every track and not only when the
   * local one fails.
   *
   * This endpoint used to stop at step 4 with "it is a streamed track" and say
   * nothing else, which left the Qobuz and TIDAL path with exactly the problem
   * the local one was given this endpoint to cure: several ways to fail and one
   * silence between them. It is the same five-versions lesson one path along.
   *
   * Reported in the order wfQobuzTrack and wfTidalTrack actually check, so the
   * first `false` in each row is the thing to fix. Read-only: no audio is
   * fetched, nothing is decoded, no service is called — every value below is
   * already in memory.
   */
  const qId = wfQobuzAlbumId(album, artist);
  const tId = wfTidalAlbumId(album, artist);
  // What the lookup actually asked for, and — when it missed — what the index
  // holds that is CLOSE. Without this a miss is reported as "not in your
  // favourites", which is a guess: an exact-key lookup fails identically
  // whether the record is absent or spelled differently, and those need
  // opposite things from the user. See lib/keymatch.js.
  const wantKeys = albumKeys(album || "", artist || "");
  out.streaming = {
    qobuz: {
      // Either credential is enough: the browser token signs, and a pasted
      // secret is the older route that still works.
      signed_in_for_waveforms: !!qobuzWaveToken,
      signed_in_as: qobuzWaveName || qobuzWaveUser || null,
      has_pasted_secret: !!String(qobuzAppSecret || "").trim(),
      account_connected: qobuzReady(),
      // ALBUMS read vs albums Qobuz states. `identity_keys` is the old
      // `favourite_albums_known` under its real name: it counts KEYS, one album
      // is filed under several, and reporting it as an album count is what hid
      // a ten-thousand-album ceiling behind the number 11455.
      favourite_albums_read: qobuzFavouritesRead,
      favourite_albums_total: qobuzFavouritesTotal || null,
      favourites_complete: !qobuzFavouritesTotal || qobuzFavouritesRead >= qobuzFavouritesTotal,
      identity_keys: qobuzAlbumIds.size,
      favourite_albums_known: qobuzAlbumIds.size,   // kept: older probes quote it
      album_id: qId || null,
      stored: qId ? !!wfGet(WF.trackKey("qobuz:" + qId, track)) : false,
      keys_tried: qId ? undefined : wantKeys,
      near: qId ? undefined : KM.nearKeys(wantKeys, qobuzAlbumIds.keys()),
    },
    tidal: {
      account_connected: tidalReady(),
      favourite_albums_read: tidalFavouritesRead,
      favourite_albums_total: tidalFavouritesTotal || null,
      favourites_complete: !tidalFavouritesTotal || tidalFavouritesRead >= tidalFavouritesTotal,
      identity_keys: tidalAlbumIds.size,
      favourite_albums_known: tidalAlbumIds.size,
      album_id: tId || null,
      stored: tId ? !!wfGet(WF.trackKey("tidal:" + tId, track)) : false,
      keys_tried: tId ? undefined : wantKeys,
      near: tId ? undefined : KM.nearKeys(wantKeys, tidalAlbumIds.keys()),
    },
  };

  // The first thing standing in the way, named. The order matters and is the
  // code's own — see lib/waveform-verdict.js.
  out.streaming.verdict = WFV.streamingVerdict(out.streaming.qobuz, out.streaming.tidal);

  /*
   * 3c. WALK IT (?deep=1). Opt-in, because unlike everything above it CALLS
   * Qobuz — the album read and the signed file-url request, exactly the two the
   * real path makes, through wfQobuzResolveAudio itself rather than a copy. It
   * stops before the audio: no bytes are pulled and nothing is decoded or
   * stored, so it is safe to run repeatedly.
   *
   * WHY IT EXISTS: v1.8.51 fixed the reason NO album had a waveform, and left
   * the harder report — SOME albums do not. Everything static is already above
   * and it is not enough, because the remaining stops (the track list, the
   * duration gate, whether this account may stream this record) can only be
   * seen by asking Qobuz about THAT album. Without this the only instrument is
   * "play it and read the log", which cannot be pointed at an album on request.
   *
   * The url itself is deliberately NOT reported: it is a time-limited signed
   * link to audio, and a diagnostic endpoint is not the place to hand one out.
   * Whether one came back is the whole finding.
   */
  if (String(req.query.deep || "") === "1") {
    // The favourites id if there is one, otherwise the CATALOGUE — which is
    // what the playback path now does, so the probe has to do it too or it
    // reports a dead end the real code walks straight past. (The static section
    // above stays call-free and reports the favourites answer alone; this is
    // the opt-in that is allowed to spend a request.)
    let useId = qId;
    if (!useId) {
      useId = await wfQobuzSearchAlbumId(album, artist);
      out.streaming.qobuz.album_id_from_search = useId || null;
    }
    if (!useId) {
      out.streaming.deep = { ran: false,
        why: "this album is not in your Qobuz favourites AND the catalogue search " +
             "did not identify it either, so there is no id to ask Qobuz about. " +
             "Check the log for '[waveform] qobuz: ... catalogue search' — it says " +
             "whether the search missed or declined for ambiguity" };
    } else {
      const secs = seconds || 0;
      const got = await wfQobuzResolveAudio(useId, track, secs);
      out.streaming.deep = {
        ran: true,
        stop: got.stop,
        detail: got.detail,
        // What each credential set said. Empty on a clean first-try success.
        tried: got.tried,
        album_title_on_qobuz: got.album_title || null,
        album_tracks_on_qobuz: got.album_tracks || 0,
        album_id_used: useId,
        album_id_came_from: qId ? "favourites" : "catalogue search",
        roon_says_seconds: secs || null,
        qobuz_says_seconds: got.track_duration != null ? got.track_duration : null,
        got_audio_url: !!got.url,
        credentials_used: got.credentials || null,
      };
      if (!secs) {
        out.streaming.deep.note =
          "no track length was supplied, and the duration gate is what separates " +
          "this recording from another edition of it — pass &length=<seconds> " +
          "(or run this while the track is playing)";
      }
      out.streaming.verdict = WFV.deepVerdict(out.streaming.deep);
    }
  }

  // 4. Does the walk know a directory for this album?
  const akey = wfAlbumKey(album, artist);
  out.album_key = akey || null;
  if (!akey) {
    // NOT "so it is a streamed track". That was an inference stated as a fact:
    // the local index missing an album means the local index missed it, which
    // happens both because the album really is streamed AND because the walk
    // filed it under a different spelling. The second is a LOCAL waveform bug
    // and the old sentence sent anybody who hit it off to read about Qobuz.
    out.local_near = KM.nearKeys(wantKeys, localAlbumDirs.keys());
    out.verdict = !localAlbumDirs.size
      ? "the /music walk has recorded no directories at all (see music.local_album_dirs)"
      : out.local_near.length
        ? "no local directory matched, but the /music index holds " +
          out.local_near.length + " near miss" + (out.local_near.length === 1 ? "" : "es") +
          ' — closest is "' + out.local_near[0].key + '" (' + out.local_near[0].why +
          "). This may be a LOCAL album the walk filed under a different spelling, " +
          "not a streamed one: compare it with streaming.qobuz.keys_tried"
        : "no local directory for this album and nothing in the /music index " +
          "resembles it, so it is a streamed track — read streaming.verdict above";
    return res.json(out);
  }
  out.album_dir = localAlbumDirs.get(akey) || null;

  // 5. Which files are in it, and does the playing title match one of them?
  //    The titles come from the tags, and Roon's title is what is matched
  //    against them — so a mismatch here is the answer, and it is visible.
  let files = [];
  try { files = await wfAlbumFiles(akey); } catch (e) { out.files_error = e.message; }
  out.files = files.map(f => ({ file: path.basename(f.file), title: f.title }));
  const file = await wfResolveFile(akey, track);
  out.matched_file = file ? path.basename(file) : null;
  if (!file) {
    out.verdict = files.length
      ? "no file in that folder has a title matching \"" + track + "\" — compare it with files[] above"
      : "that folder holds no audio files this build recognises";
    return res.json(out);
  }
  try {
    out.matched_file_bytes = fs.statSync(file).size;
  } catch (e) {
    out.verdict = "the matched file cannot be read: " + e.message;
    return res.json(out);
  }

  // 6. Is it already stored? A stored row is served without decoding, so a
  //    track that is stored AND not drawing is a client-side problem.
  const tkey = WF.trackKey(akey, track);
  const cached = wfGet(tkey);
  out.stored = !!cached;
  out.stored_buckets = cached ? cached.n : 0;

  out.verdict = !out.ffmpeg.ok
    ? "everything resolves, but ffmpeg does not run — no track can ever be decoded (see ffmpeg)"
    : (cached ? "stored and ready: if no waveform is drawn, the problem is in the client"
              : "resolves to a readable file and ffmpeg runs — play this track and it should decode");
  res.json(out);
});

/*
 * GET /api/debug/zone-dump?zone=<id>
 *
 * Everything Roon sends about a zone, and about the next few queue items,
 * exactly as it arrives — plus a sorted listing of every field path in it.
 *
 * WHY: /api/zone-state hand-picks the fields this app knows about, so a field
 * the Core sends that nobody here has looked at is invisible from inside the
 * app. Before the streaming waveform is built on an INFERENCE about where the
 * audio comes from (albumSource, which really answers "is this album in your
 * favourites"), this answers whether Roon states it outright.
 *
 * Read-only, and it starts no subscription it does not immediately close. The
 * zone comes from the cache the transport subscription already maintains, so
 * asking costs the Core nothing; the queue read is the same one-shot
 * subscribe/read/unsubscribe the waveform prefetch uses.
 */
/*
 * POST /api/debug/qobuz-probe   {app_id, secret, token?, album?, artist?}
 *
 * POST, not GET, for one reason: the [http] logger records req.originalUrl, and
 * those lines go to the rotating log files on the data volume. A secret in a
 * query string would be written to disk in plaintext and kept for ~88 MB of
 * history. A JSON body is not logged.
 *
 * WHICH COMBINATION DOES QOBUZ ACTUALLY ACCEPT?
 *
 * Five versions have now been spent testing one hypothesis per Docker rebuild,
 * because the only way to try a credential combination was to ship it. That is
 * the wrong loop: the question is empirical, it has a small answer space, and
 * nothing about it needs a release. This tries every token this box can produce
 * against a caller-supplied signing pair and reports what Qobuz said to each.
 *
 * A signature is only valid against the app_id its secret belongs to, AND the
 * token must have been minted by that same app — so the working combination is
 * a PAIR OF PAIRS, and knowing which one it is takes evidence, not reasoning.
 *
 * Nothing here is persisted and no secret or token is ever echoed back: the
 * answer is a grid of labels, HTTP statuses and reasons. Supply the candidate
 * pair yourself — this app ships no secret and this endpoint does not store one.
 */
// GET answers with how to call it, so a mistyped probe explains itself rather
// than 404ing — and so nobody puts a secret in a URL to find that out.
app.get("/api/debug/qobuz-probe", (req, res) => res.status(405).json({
  error: "POST this, do not GET it",
  how: "curl -s -X POST http://<host>:<port>/api/debug/qobuz-probe " +
       "-H 'Content-Type: application/json' " +
       "-d '{\"app_id\":\"...\",\"secret\":\"...\",\"token\":\"optional\"}'",
  why: "a secret in a query string is written to the log files on the data volume",
}));

app.post("/api/debug/qobuz-probe", async (req, res) => {
  const body   = req.body || {};
  const secret = String(body.secret || "").trim();
  const given  = String(body.token  || "").trim();
  // app_id is OPTIONAL, and omitting it is the most useful case: it means "this
  // app's own id", which is the LMS plugin's — the same id whose username and
  // md5-password login this app already uses successfully. A secret issued for
  // THAT app therefore completes a set that is already consistent, with no new
  // sign-in flow at all. Requiring an app_id here hid that whole arrangement
  // behind a field nobody would think to leave blank.
  const appId = String(body.app_id || "").trim() || qobuz.APP_ID;
  if (!secret) {
    return res.status(400).json({
      error: "secret is required",
      how: "POST {\"secret\":\"<secret>\"} — app_id defaults to this app's own (" +
           qobuz.APP_ID + "), which is the LMS plugin's, so a secret issued for " +
           "that app needs nothing else. Add \"app_id\" and \"token\" only to " +
           "test a different app's pair.",
      note: "Nothing is saved. The reply carries no secrets, only what Qobuz answered.",
    });
  }

  // Which album to ask about. The playing one if named, else any harvested id —
  // the probe only needs a track id that exists, not a particular record.
  let albumId = null, albumFrom = "";
  const album = String(body.album || "").trim();
  const artist = String(body.artist || "").trim();
  if (album) { albumId = wfQobuzAlbumId(album, artist); albumFrom = "the album named"; }
  if (!albumId && qobuzAlbumIds.size) {
    albumId = qobuzAlbumIds.values().next().value;
    albumFrom = "the first harvested favourite";
  }
  if (!albumId) {
    return res.status(409).json({ error: "no Qobuz album id available to test with",
                                  hint: "connect Qobuz so favourites are read, or pass album=&artist=" });
  }

  // Every token this box can lay hands on, labelled by where it came from.
  const tokens = [];
  if (qobuzToken)      tokens.push({ label: "this app's login (app_id " + qobuz.APP_ID + ")", token: qobuzToken });
  if (given)           tokens.push({ label: "the token in this request",                      token: given });
  if (qobuzSignToken)  tokens.push({ label: "the token saved from a pasted file",             token: qobuzSignToken });
  if (qobuzUsername && qobuzPasswordMd5) {
    try {
      const r = await qobuz.login(qobuzUsername, qobuzPasswordMd5, true, appId);
      tokens.push({ label: "minted now by password under app " + appId, token: r.token });
    } catch (e) {
      tokens.push({ label: "minted now by password under app " + appId, token: null,
                    mint_error: qobuz.describeQobuzError(e, false) });
    }
  }
  if (!tokens.length) {
    return res.status(409).json({ error: "no Qobuz token available to test with",
                                  hint: "connect Qobuz under Settings, or pass token=" });
  }

  const results = [];
  for (const t of tokens) {
    if (!t.token) { results.push({ token: t.label, mint: t.mint_error || "could not be obtained" }); continue; }
    const row = { token: t.label };

    // Unsigned catalogue read, signed with nothing — proves the token is alive.
    const alb = await qobuz.getAlbumResult(t.token, albumId, 12000, appId)
      .catch((e) => ({ album: null, reason: qobuz.describeQobuzError(e, false) }));
    row.album_read = alb.album ? "ok (" + (alb.album.tracks || []).length + " tracks)" : alb.reason;
    if (!alb.album || !alb.album.tracks || !alb.album.tracks.length) { results.push(row); continue; }

    // The signed call — the one that actually gates the feature.
    const trackId = alb.album.tracks[0].id;
    const f = await qobuz.getFileUrlResult(t.token, trackId, secret, { appId })
      .catch((e) => ({ url: null, reason: qobuz.describeFileUrlError(e) }));
    // The URL is a time-limited link to audio: report only WHETHER there is one.
    row.stream = f.url ? "OK — this combination works" : f.reason;
    results.push(row);
  }

  // A Qobuz error body is quoted into the reason, and this request carried a
  // secret and possibly a token. Nothing observed echoes them, but "nothing
  // observed" is not a guarantee for a value the caller just handed us.
  const hide = [secret, given].filter((v) => v && v.length >= 8);
  const scrub = (v) => {
    let out = String(v == null ? "" : v);
    for (const h of hide) out = out.split(h).join("<redacted>");
    return out;
  };
  for (const r of results) for (const k of Object.keys(r)) r[k] = scrub(r[k]);

  const winner = results.find((r) => r.stream === "OK — this combination works");
  res.json({
    signing_app_id: appId,          // not a credential — it travels in every URL
    album_id_tested: albumId,
    album_chosen: albumFrom,
    answer: winner
      ? "WORKS with: " + winner.token + ". Paste that app_id, that secret and that " +
        "token together into Settings → Qobuz waveforms."
      : "No combination worked. Every token available here was refused by this pair.",
    results,
  });
});

app.get("/api/debug/zone-dump", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });

  const all = Object.values(zones);
  // Prefer a zone that HAS something loaded, not merely one that is playing: a
  // paused zone still carries the now_playing this exists to inspect, and a
  // stopped one carries nothing at all. Falling back to "the first zone" is how
  // the first version of this quietly returned an idle endpoint and an answer
  // that looked complete while saying nothing.
  const rank = (z) => (
    !z.now_playing ? 0 :
    z.state === "playing" || z.state === "loading" ? 3 :
    z.state === "paused" ? 2 : 1
  );
  let zoneId = req.query.zone;
  if (!zoneId) {
    const best = all.slice().sort((a, b) => rank(b) - rank(a))[0];
    zoneId = best && best.zone_id;
  }
  const zone = zoneId && zones[zoneId];
  if (!zone) {
    return res.status(404).json({ error: "no such zone", known: Object.keys(zones) });
  }

  const count = Math.max(1, Math.min(10, parseInt(req.query.items, 10) || 3));
  let queue = [];
  try {
    queue = await peekQueueRaw(zoneId, count);
  } catch (e) {
    // A queue we cannot read is not a reason to withhold the zone, which is the
    // more interesting half.
    queue = [];
  }

  const np = zone.now_playing || null;
  const t3 = (np && np.three_line) || {};
  const album = t3.line3 || "", artist = t3.line2 || "";

  res.json({
    // Said first and said plainly. A dump of a stopped zone has no now_playing
    // and no queue, so it cannot answer anything — and it looks like a full
    // answer if nothing points that out.
    note: np
      ? "OK — this zone has a track loaded."
      : "THIS ZONE IS IDLE (state: " + (zone.state || "?") + "). It carries no " +
        "now_playing and no queue, so this dump cannot show what a playing track " +
        "looks like. Start playback and reload, or use ?zone=<id> from the list " +
        "below. The `samples` further down were captured as tracks changed and " +
        "do not need anything to be playing right now.",
    zones: all.map(z => ({
      zone_id: z.zone_id,
      name: z.display_name || "",
      state: z.state || "",
      has_now_playing: !!z.now_playing,
      track: ((z.now_playing && z.now_playing.three_line) || {}).line1 || "",
    })),

    // What this app concludes today, so anything Roon turns out to send can be
    // read straight against the inference it would replace.
    app_thinks: Object.assign({ track: t3.line1 || "", album, artist },
                             identityReport(album, artist)),

    /*
     * The captured samples: the last few now_playing payloads, recorded as the
     * track changed. THIS is the part that answers the question — play a Qobuz
     * album and a local one, then read `sample_fields`, where `seen` says how
     * many of the samples carried each field. A field that appears for some
     * tracks and not others is exactly what a source marker would look like.
     */
    // Streaming waveforms need an album id, not just a key. Reported here
    // because zero of them is the difference between "declined for a good
    // reason" and "the favourites have not been read yet".
    qobuz: {
      album_keys: qobuzAlbumKeys.size,
      album_ids: qobuzAlbumIds.size,
      secret_set: !!String(qobuzAppSecret || "").trim(),
      sign_app_id: qobuzSignAppId || "(module default)",
      sign_token_set: !!qobuzSignToken,
      connected: qobuzReady(),
    },
    sample_count: npSamples.length,
    sample_fields: SHAPE.formatPaths(SHAPE.unionPaths(npSamples.map(x => x.now_playing))),
    samples: npSamples.map(x => ({ at: x.at, zone: x.zone_name, state: x.state,
                                   app_thinks: x.app_thinks })),
    samples_raw: npSamples.map(x => x.now_playing),

    zone_shape:  SHAPE.formatPaths(SHAPE.keyPaths(zone)),
    queue_shape: SHAPE.formatPaths(SHAPE.keyPaths(queue[0] || null)),
    zone_raw:  zone,
    queue_raw: queue,
  });
});

app.get("/api/settings/waveform", (req, res) => {
  res.json({
    enabled: waveformEnabled,
    decoder: !!WFD.ffmpegPath(),
    // Whether a secret is SET, never the secret itself — this endpoint is
    // polled by every open client and a credential has no business in it.
    qobuz_secret_set: !!String(qobuzAppSecret || "").trim(),
    // The ID is not a credential and naming it is how a mismatched pair becomes
    // visible: a secret from the web player signed with the Lyrion plugin's id
    // fails exactly like a wrong secret.
    qobuz_sign_app_id: qobuzSignAppId || null,
    // Whether a token came WITH the pair. Not the token — that is a credential,
    // and this endpoint is polled by every open client.
    qobuz_sign_token_set: !!qobuzSignToken,
    // Whether the Qobuz sign-in has been done. Not the token — this endpoint is
    // polled by every open client and a credential has no business in it. The
    // user id is not one: it identifies an account to its owner, who is the only
    // person who can see this page.
    qobuz_connected: !!qobuzWaveToken,
    qobuz_user: qobuzWaveToken ? (qobuzWaveName || qobuzWaveUser || "") : "",
    qobuz_ready: !!(qobuzWaveToken ||
                    (String(qobuzAppSecret || "").trim() && qobuzReady())),
  });
});
app.post("/api/settings/waveform", (req, res) => {
  const body = req.body || {};
  // The secret can be set on its own, without touching the switch.
  if (body.qobuz_secret !== undefined) {
    // Accepts a bare secret OR the JSON a Qobuz client stores, so the app_id
    // and the secret cannot be separated on their way in here.
    const pair = SIG.parseSecretInput(body.qobuz_secret);
    qobuzAppSecret = pair.secret;
    qobuzSignAppId = pair.appId;
    // KEEP A WORKING TOKEN WHEN ONLY THE PAIR IS BEING CORRECTED. Updating the
    // app_id and secret while leaving the token out is the ordinary way to fix
    // a mismatch — the token was never the wrong part — and wiping it would
    // destroy the one credential that works, for a paste that never mentioned
    // it. Only a paste that CARRIES an app_id may inherit, so a bare secret
    // (which means "sign as this app itself") still starts clean, and clearing
    // the field clears everything, which is the way to remove one deliberately.
    qobuzSignToken = pair.token || (pair.appId ? qobuzSignToken : "");
    // A token minted BY THIS APP, though, belongs to the app_id it was minted
    // under. Keeping that across a change would sign as one app with another's
    // token — the very failure this path exists to avoid. It costs one login to
    // rebuild, unlike a pasted one, which cannot be rebuilt here at all.
    _qobuzSignTok = null;
    _qobuzSignTokAt = 0;
    savePersistedSettings({ qobuzAppSecret, qobuzSignAppId, qobuzSignToken });
    // The reasons logged so far were about the old state. Forget them, so the
    // next play says what is true now rather than staying quiet about it.
    _wfQobuzSaid.clear();
    if (body.enabled === undefined) {
      return res.json({ ok: true, enabled: waveformEnabled,
                        qobuz_secret_set: !!qobuzAppSecret,
                        qobuz_sign_app_id: qobuzSignAppId || null,
                        qobuz_sign_token_set: !!qobuzSignToken });
    }
  }
  if (body.enabled === undefined) return res.status(400).json({ error: "enabled required" });
  waveformEnabled = !!body.enabled;
  savePersistedSettings({ waveformEnabled });
  // Switched off mid-decode: stop the prefetch rather than letting it finish
  // for a feature nobody is looking at.
  if (!waveformEnabled && _wfPrefetch) { _wfPrefetch.signal.aborted = true; _wfPrefetch = null; }
  res.json({ ok: true, enabled: waveformEnabled,
             qobuz_secret_set: !!String(qobuzAppSecret || "").trim(),
             qobuz_sign_app_id: qobuzSignAppId || null,
             qobuz_sign_token_set: !!qobuzSignToken });
});

// Labels on/off. The scan's own gate lives inside runLabelsIndexScan, at the
// boundary between the /music tag read (which other features are built on) and
```

## `public/app.js` — the canvas (lines 8531–8765)

Fetching, folding and drawing, inset to the range input's own travel.

```js
  /* ---------------- Waveform ---------------- */
  /*
   * The shape of the track, drawn under the seek bar.
   *
   * Local files and streamed ones alike: Roon sends audio to the endpoint and
   * never to an extension, so the server reads a local file directly and
   * fetches a streamed track from Qobuz or TIDAL with the user's own account to
   * measure it. Either way this end is the same — it asks /api/waveform for a
   * few thousand levels and draws them; a track the server cannot identify
   * answers with none and keeps the plain bar.
   *
   * The canvas is decoration UNDER the range input, never a replacement for it:
   * the input keeps the drag, the keyboard, the thumb and the disabled state,
   * and if any of this fails the bar is exactly what it was before.
   */
  const npWave = document.getElementById("np-wave");
  const npProgressEl = document.querySelector(".np-progress");
  let npWavePeaks = null;     // Uint8Array for the current track, or null
  let npWaveKey = "";         // which track those peaks are for
  let npWaveReq = 0;          // generation, so a slow answer cannot land late

  function npWaveIdentity() {
    const np = (currentZone && currentZone.now_playing) || null;
    if (!np) return null;
    const t3 = np.three_line || {};
    const track  = t3.line1 || np.line1 || "";
    const artist = t3.line2 || np.line2 || "";
    const album  = t3.line3 || np.line3 || "";
    return track ? { track, artist, album, key: track + " " + album } : null;
  }

  function drawWave(pos) {
    if (!npWave || !npProgressEl) return;
    const peaks = npWavePeaks;
    if (!peaks || !peaks.length) {
      npWave.classList.add("hidden");
      npProgressEl.classList.remove("has-wave");
      return;
    }
    npWave.classList.remove("hidden");
    npProgressEl.classList.add("has-wave");

    // Size the backing store to the DEVICE pixels actually on screen, or the
    // bars are soft on every phone made in the last decade.
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(npWave.clientWidth));
    const h = Math.max(1, Math.round(npWave.clientHeight));
    if (npWave.width !== w * dpr || npWave.height !== h * dpr) {
      npWave.width = w * dpr; npWave.height = h * dpr;
    }
    const ctx = npWave.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(document.documentElement);
    const played = cs.getPropertyValue("--accent").trim() || "#4cb7e6";
    // The track ahead is drawn in the TEXT colour, not the border colour: it is
    // the shape of the music and it should be as legible as the title above it.
    // `--text` is near-white on the dark palettes and near-black on the light
    // ones, so "white" here means "reads clearly", in both.
    const ahead  = cs.getPropertyValue("--text").trim() || "#e9eaec";
    const at = Number.isFinite(pos) ? pos : npNow();
    const frac = npLen > 0 ? Math.max(0, Math.min(1, at / npLen)) : 0;

    /*
     * WHERE THE THUMB ACTUALLY IS, which is not frac * width.
     *
     * A range input cannot let its thumb hang off either end, so the CENTRE
     * travels from thumbW/2 to width - thumbW/2 rather than from 0 to width.
     * The bars were laid from 0 to w regardless, so the two mappings from TIME
     * to X disagreed by thumbW * (0.5 - frac): half a thumb ahead of the music
     * at the start, level in the middle, half a thumb behind it at the end. On
     * a phone that is seven pixels of a ~350px bar — several seconds of a
     * five-minute track — and it reads as the waveform failing to keep up.
     * Zero in the middle, which is how it survived being looked at.
     *
     * So the shape is inset to the thumb's travel and both are computed from
     * `span`. A peak is then under the dot at the moment you hear it, at every
     * point in the track rather than only halfway through.
     */
    // Read from the PROGRESS block, which is where --seek-thumb is declared —
    // a custom property inherits downward, so asking documentElement (its
    // ancestor, not its descendant) would silently get nothing and fall back.
    const thumbW = parseFloat(
      getComputedStyle(npProgressEl).getPropertyValue("--seek-thumb")) || 14;
    const inset = thumbW / 2;
    const span = Math.max(1, w - thumbW);
    const head = inset + frac * span;

    /*
     * ONE BAR PER DEVICE-PIXEL PITCH, not per 2 CSS pixels.
     *
     * A phone has three device pixels to every CSS one and the old step threw
     * two of them away: ~190 bars for a five-minute track, a second and a half
     * each, which is a coarse picture of a record however well it is measured.
     * Two device pixels of ink and one of gap gives ~360 on the same phone, and
     * each one lands on a whole device pixel, so they stay separate instead of
     * blurring into a band. The store holds 4000 values, so there is data for
     * them.
     *
     * Drawn in DEVICE pixels for that reason — the transform is dropped here
     * and put back at the end. A screen with no pixels to spare keeps the old
     * one-and-one, because at 1x a two-pixel bar and a one-pixel gap is a
     * different, worse drawing rather than a finer one.
     */
    const pitch = dpr >= 2 ? 3 : 2;
    const ink = pitch - 1;
    const devSpan = span * dpr, devInset = inset * dpr, devHead = head * dpr;
    const bars = Math.max(1, Math.floor(devSpan / pitch));
    // Fractional so the bars fill the travel exactly; the LEFT EDGE of each is
    // rounded, which is what keeps them crisp.
    const step = devSpan / bars;
    const mid = Math.round((h / 2) * dpr);
    const height = (h - 2) * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < bars; i++) {
      /*
       * Folded the way the server folds, and for the same reason: these are RMS
       * levels, so the RMS of them is exactly the level of the whole span — a
       * bar drawn from eleven stored values is the same height it would be if
       * the track had been analysed straight into this many buckets. A MAXIMUM
       * here would put the flattening straight back, because the loudest bucket
       * in a bar of a limited record is the same number in every bar of it.
       */
      const a = Math.floor(i * peaks.length / bars);
      const b = Math.min(peaks.length, Math.max(a + 1, Math.floor((i + 1) * peaks.length / bars)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += peaks[j] * peaks[j];
      const v = Math.sqrt(sum / (b - a));
      /*
       * NOT ROUNDED TO A WHOLE PIXEL. Everything up to here is exact and then
       * the height used to be snapped to a pixel, which threw away more than
       * the stored value ever had: at 34px a whole pixel is 2.9% of full scale
       * against a stored value good to 0.4%. A fractional height antialiases
       * the two END CAPS and nothing else — the bar stays on whole device
       * pixels horizontally, so the top edge gains precision rather than the
       * whole shape losing crispness.
       *
       * The floor stays, in device pixels: silence is a line rather than a gap,
       * because a gap reads as "the waveform stopped loading".
       */
      const barH = Math.max(1, (v / 255) * height);
      const x = Math.round(devInset + i * step);
      // A bar counts as played once its MIDDLE is behind the playhead, so the
      // boundary lands where the dot is rather than a bar's width either side.
      const done = (x + ink / 2) <= devHead;
      ctx.fillStyle = done ? played : ahead;
      // The played side goes to full strength so the accent still reads as the
      // position marker against a now-bright track ahead of it.
      ctx.globalAlpha = done ? 1 : 0.72;
      // Centred on the midline exactly. Rounding the offset as well as the
      // height pushed an odd-numbered bar half a pixel upwards, every time.
      ctx.fillRect(x, mid - barH / 2, ink, barH);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // The switch's state, fetched once. loadWaveformEnabled() in the settings
  // module also writes window.__waveformOn, but that only runs when the
  // Settings pane is opened — without this the waveform stayed invisible on a
  // fresh load until you happened to go and look at the setting.
  let waveFlagPending = null;
  function waveformOn() {
    if (window.__waveformOn !== undefined) return Promise.resolve(window.__waveformOn);
    if (!waveFlagPending) {
      waveFlagPending = fetch("/api/settings/waveform")
        .then(r => (r.ok ? r.json() : null))
        .then(j => { window.__waveformOn = !!(j && j.enabled); return window.__waveformOn; })
        .catch(() => { window.__waveformOn = false; return false; });
    }
    return waveFlagPending;
  }

  async function loadWaveform() {
    if (!npWave) return;
    const on = await waveformOn();
    const id = npWaveIdentity();
    if (!id || !on) {
      npWavePeaks = null; npWaveKey = "";
      drawWave();
      return;
    }
    if (id.key === npWaveKey) return;    // same track: what we have still applies
    npWaveKey = id.key;
    npWavePeaks = null;
    drawWave();                          // plain bar while we ask
    const mine = ++npWaveReq;
    try {
      // The LENGTH goes with it. For a streaming track the server has no file
      // and matches the track on the service by title AND duration — without
      // this it cannot tell a song from a remaster of it that shares the title,
      // so it declines rather than guessing and nothing is ever drawn.
      const q = "track=" + encodeURIComponent(id.track) +
                "&album=" + encodeURIComponent(id.album) +
                "&artist=" + encodeURIComponent(id.artist) +
                "&length=" + encodeURIComponent(npLen || 0);
      const r = await fetch("/api/waveform?" + q);
      if (!r.ok) return;
      const j = await r.json();
      // The track may have moved on while the server was decoding. Landing a
      // stale waveform under a different song is worse than none: it looks
      // authoritative and it is simply the wrong shape.
      //
      // The KEY check is the one that does the work, and it catches two things:
      // a skip (the key is now the next track's) and the setting being switched
      // off mid-decode (__repaintWaveform blanks the key without touching the
      // generation). The generation is belt and braces — every path that bumps
      // it without changing the key is a repeat request for the SAME track, so
      // a late answer there is the right shape anyway. It stays because it is
      // what keeps this correct if the key logic is ever changed.
      if (mine !== npWaveReq || npWaveKey !== id.key) return;
      // "busy" means the server is decoding a DIFFERENT track and will be free
      // in a moment. Leaving the key set would latch this track to no waveform
      // for as long as it plays, so drop it and let the next poll ask again —
      // the request costs nothing while the server is busy, because it answers
      // without decoding.
      if (j && j.reason === "busy") { npWaveKey = ""; return; }
      if (!j || !j.peaks) return;
      const bin = atob(j.peaks);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      npWavePeaks = u8;
      drawWave();
    } catch (e) {
      /* No waveform is a normal answer — a streaming track, an undecodable
         file, the server busy. The plain bar is already showing. */
    }
  }

  // The settings switch repaints through this rather than reaching into the
  // module: turning it off must clear a waveform already on screen.
  window.__repaintWaveform = () => { npWaveKey = ""; loadWaveform(); };

```
