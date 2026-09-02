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

  const byTitle = list.filter((t) => t && canon(t.title) === want);
  if (!byTitle.length) {
    return { track: null, reason: `no track called "${title}" on the album` };
  }

  const fits = byTitle.filter((t) =>
    Number.isFinite(t.duration) && Math.abs(t.duration - seconds) <= tol);

  if (!fits.length) {
    // The title is there and the length is not. This is the interesting
    // failure: a different edition of the same album, so naming the gap is
    // worth more than "not found".
    const got = byTitle.map((t) => t.duration).join("/");
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

  return { track: fits[0], reason: "matched on title and duration" };
}

module.exports = { matchTrack, canon, DURATION_TOLERANCE_S };
