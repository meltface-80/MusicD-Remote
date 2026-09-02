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
 *   peaks are resampled to 1000 buckets from an 8 kHz mono decode, where a
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

module.exports = { md5Hex, signRequest, fileUrlParams, usableFileUrl,
                   FORMAT_MP3_320, FORMAT_FLAC_16 };
