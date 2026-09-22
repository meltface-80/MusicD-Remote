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
