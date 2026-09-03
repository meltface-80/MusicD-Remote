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
