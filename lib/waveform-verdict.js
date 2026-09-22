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

  // 5. Favourites are known and this record is not among them. Roon never says
  //    which service is playing, so membership is the only signal there is.
  return "this album is in neither service's FAVOURITES (" + qKnown + " Qobuz, " +
         tKnown + " TIDAL known). Roon never says which service is playing, so " +
         "favourite membership is the only signal there is — playing from a " +
         "search is not enough";
}

module.exports = { streamingVerdict };
