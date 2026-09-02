/*
 * Lite Qobuz API client — new releases, featured lists, catalog search,
 * artist discographies, and the user's own favourites.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * IMPORTANT: This uses the UNOFFICIAL Qobuz API (the same app_id the
 * Lyrion/LMS "Qobuz" community plugin uses). It is NOT a sanctioned Qobuz
 * integration and is against Qobuz's Terms of Service. It may break at any
 * time and is used at the user's own risk. Scope:
 *   - list featured albums (album/getFeatured — new releases, best sellers, …),
 *   - full catalog search (catalog/search),
 *   - artist discographies (artist/get), and
 *   - add/remove albums in the user's OWN Qobuz favourites (favorite/*),
 *   - one album's track list (album/get), and
 *   - v1.8.6: a time-limited stream URL for ONE track (track/getFileUrl).
 *
 * Everything but the last is unsigned and needs only the app_id and the
 * user_auth_token from login. getFileUrl is the exception: it hands back audio
 * and requires a signed request, which needs an app_secret.
 *
 * THE APP_SECRET IS NOT SHIPPED. The user supplies it in Settings; with none
 * configured, getFileUrl is never called and streaming tracks keep the plain
 * progress bar. It rotates whenever Qobuz updates their web player, so baking
 * one in would guarantee a build that silently stops working.
 *
 * What the audio is for: it is piped through ffmpeg into a thousand peak values
 * and discarded. Nothing is written to disk and Roon still handles all playback.
 */
const crypto = require("crypto");

const QOBUZ_BASE = "https://www.qobuz.com/api.json/0.2/";
// app_id from the LMS/Lyrion Qobuz plugin. The app_secret that goes with signed
// requests is deliberately absent — it is a user setting, see the header.
const APP_ID = "942852567";
// The signing for track/getFileUrl. Kept in its own module because it is pure
// and therefore testable without an account — see lib/qobuz-sig.js.
const SIG = require("./qobuz-sig");

function md5Hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

// Single GET against the Qobuz API. Throws Error with .code on 401/429.
async function qobuzGet(endpoint, params, token, timeoutMs = 12000) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  qs.append("app_id", APP_ID);
  const url = QOBUZ_BASE + endpoint + "?" + qs.toString();
  const headers = { "X-App-Id": APP_ID };
  if (token) headers["X-User-Auth-Token"] = token;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (res.status === 401) { const e = new Error("Qobuz auth failed (401)"); e.code = 401; throw e; }
    if (res.status === 429) { const e = new Error("Qobuz rate limited (429)"); e.code = 429; throw e; }
    if (!res.ok) throw new Error("Qobuz HTTP " + res.status);
    try {
      return await res.json();
    } catch (e) {
      // A 200 with a non-JSON body (e.g. an HTML error/maintenance page) — surface
      // a clean message instead of leaking a JSON-parser SyntaxError to the caller.
      throw new Error("Qobuz returned an unexpected (non-JSON) response");
    }
  } finally {
    clearTimeout(timer);
  }
}

// Log in. `password` is plaintext unless `alreadyHashed` is true (re-login with
// a stored md5). The Qobuz API expects the password MD5-hashed (matches LMS).
// Returns { token, userId, displayName, passwordMd5 }.
async function login(username, password, alreadyHashed) {
  if (!username || !password) throw new Error("username and password required");
  const passwordMd5 = alreadyHashed ? String(password) : md5Hex(password);
  const r = await qobuzGet("user/login", { username, password: passwordMd5 }, null);
  const token = r && r.user_auth_token;
  if (!token || !r.user || !r.user.id) throw new Error("Qobuz login failed — check email/password");
  return {
    token,
    userId: r.user.id,
    displayName: r.user.display_name || r.user.login || username,
    passwordMd5
  };
}

// Best image URL from a Qobuz album/artist object's `image` block (or the
// legacy flat `picture` field on artists). One definition so every caller —
// albums, search artists, artist pages — picks sizes identically.
function pickImage(o) {
  if (!o) return null;
  const im = o.image;
  if (im && (im.large || im.small || im.thumbnail)) return im.large || im.small || im.thumbnail;
  return o.picture || null;
}

// Defensive `{ items, total }` section guard for paged Qobuz responses —
// any section (albums, artists, …) may be missing or malformed entirely.
function pagedSection(s) {
  return {
    items: (s && Array.isArray(s.items)) ? s.items : [],
    total: (s && Number.isFinite(s.total)) ? s.total : 0
  };
}

// Featured albums. `type` defaults to "new-releases-full". Returns album items[].
async function getFeaturedAlbums(token, type, limit) {
  const r = await qobuzGet("album/getFeatured", {
    type: type || "new-releases-full",
    limit: limit || 100
  }, token);
  return (r && r.albums && Array.isArray(r.albums.items)) ? r.albums.items : [];
}

// Add an album to the user's Qobuz favourites by Qobuz album id. Idempotent
// (favouriting an already-favourited album succeeds without error).
async function favoriteAlbum(token, albumId) {
  if (!token) throw new Error("not logged in");
  if (!albumId) throw new Error("albumId required");
  return await qobuzGet("favorite/create", { type: "albums", album_ids: albumId }, token);
}

// Remove an album from the user's Qobuz favourites by Qobuz album id. Idempotent.
async function unfavoriteAlbum(token, albumId) {
  if (!token) throw new Error("not logged in");
  if (!albumId) throw new Error("albumId required");
  return await qobuzGet("favorite/delete", { type: "albums", album_ids: albumId }, token);
}

// Full catalog search (albums + artists). Unsigned endpoint — no app_secret
// needed. Defensive about the response shape: every section may be missing.
// Returns { albums: { items, total }, artists: { items, total } } with items
// defaulting to [] and total to 0.
async function searchCatalog(token, query, limit, offset) {
  const r = await qobuzGet("catalog/search", {
    query,
    limit: limit || 50,
    offset: offset || 0
  }, token);
  return {
    albums:  pagedSection(r && r.albums),
    artists: pagedSection(r && r.artists)
  };
}

// Artist details + discography page. Returns
// { artist: { id, name, image }, albums: { items, total } }, guarding every
// level of the response (image/picture may be missing entirely).
async function getArtist(token, artistId, limit, offset) {
  if (!artistId) throw new Error("artistId required");
  const r = await qobuzGet("artist/get", {
    artist_id: artistId,
    extra: "albums",
    limit: limit || 50,
    offset: offset || 0
  }, token);
  return {
    artist: {
      id:    (r && r.id != null) ? String(r.id) : String(artistId),
      name:  (r && r.name) || "",
      image: pickImage(r)
    },
    // Qobuz's editorial artist bio (biography.content, falling back to the
    // shorter summary). HTML-ish text — callers strip markup/entities.
    biography: (r && r.biography && (r.biography.content || r.biography.summary)) || null,
    albums: pagedSection(r && r.albums)
  };
}

// Set of the user's favourited album ids (as strings). Lets the UI show which
// new releases are already in the user's Qobuz library, on any device. Defensive
// about the response shape (ids endpoint returns arrays of ids per type).
async function getFavoriteAlbumIds(token) {
  if (!token) return new Set();
  const r = await qobuzGet("favorite/getUserFavoriteIds", {}, token);
  const out = new Set();
  const al = r && r.albums;
  if (Array.isArray(al)) {
    for (const x of al) out.add(String(typeof x === "object" && x ? x.id : x));
  } else if (al && Array.isArray(al.items)) {
    for (const x of al.items) out.add(String(typeof x === "object" && x ? x.id : x));
  }
  return out;
}

// The user's favourite albums WITH metadata (title/artist), unlike
// getFavoriteAlbumIds above which returns bare ids. Used to work out which
// library albums came from Qobuz — matching needs names, not ids. One page of
// up to `limit` (Qobuz caps around 500 per request).
async function getFavoriteAlbums(token, limit = 500, offset = 0) {
  if (!token) return [];
  const r = await qobuzGet("favorite/getUserFavorites",
    { type: "albums", limit, offset }, token);
  const al = r && r.albums;
  const items = (al && Array.isArray(al.items)) ? al.items : (Array.isArray(al) ? al : []);
  return items.filter(Boolean);
}

/**
 * One album with its track list. Unsigned — the catalog is readable with just
 * the app_id, like search and favourites.
 *
 * Returns { id, title, tracks: [{ id, title, duration, number }] }, or null for
 * anything at all: this feeds a waveform, and a waveform's absence is a normal
 * outcome that must never become an exception at the call site.
 */
async function getAlbum(token, albumId, timeoutMs = 12000) {
  if (!albumId) return null;
  let j;
  try {
    j = await qobuzGet("/album/get", { album_id: albumId }, token, timeoutMs);
  } catch (e) {
    return null;
  }
  if (!j || !j.id) return null;
  const items = (j.tracks && j.tracks.items) || [];
  return {
    id: j.id,
    title: j.title || "",
    tracks: items.map((t) => ({
      id: t.id,
      title: t.title || "",
      // Qobuz calls it `duration` and gives whole seconds, the same unit Roon
      // reports — which is what makes the duration gate a straight comparison.
      duration: Number.isFinite(t.duration) ? t.duration : null,
      number: t.track_number || null,
    })),
  };
}

/**
 * A time-limited URL for one track's audio.
 *
 * THE ONLY SIGNED CALL IN THIS FILE, and the only one that touches audio. It
 * needs an app_secret, which is NOT shipped with the app — the user supplies it
 * in Settings, because it rotates whenever Qobuz updates their web player and
 * because retrieving audio should be a decision someone made rather than a
 * default.
 *
 * Resolves to a URL string, or null. Qobuz answers a refused request with 200
 * and a body rather than an error status, so the answer goes through
 * usableFileUrl: a `sample: true` response is the 30-second preview, and
 * drawing that across a five-minute bar looks like the track and is not.
 */
async function getFileUrl(token, trackId, secret, opts) {
  const o = opts || {};
  if (!token || !trackId || !secret) return null;
  let j;
  try {
    j = await qobuzGet("/track/getFileUrl",
                       SIG.fileUrlParams({ trackId, secret, formatId: o.formatId, ts: o.ts }),
                       token, o.timeoutMs || 15000);
  } catch (e) {
    return null;
  }
  return SIG.usableFileUrl(j);
}

module.exports = { login, getFeaturedAlbums, searchCatalog, getArtist, favoriteAlbum, unfavoriteAlbum, getFavoriteAlbumIds, getFavoriteAlbums, getAlbum, getFileUrl, pickImage, md5Hex, APP_ID };
