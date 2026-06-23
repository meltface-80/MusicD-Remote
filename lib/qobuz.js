/*
 * Lite Qobuz API client — NEW RELEASES + ADD-TO-FAVOURITES ONLY.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * IMPORTANT: This uses the UNOFFICIAL Qobuz API (the same app_id the
 * Lyrion/LMS "Qobuz" community plugin uses). It is NOT a sanctioned Qobuz
 * integration and is against Qobuz's Terms of Service. It may break at any
 * time and is used at the user's own risk. Scope here is deliberately narrow:
 *   - list Qobuz "new releases" (album/getFeatured), and
 *   - add an album to the user's OWN Qobuz favourites (favorite/create).
 * No downloading and no streaming — Roon handles all playback. Because we
 * never request stream URLs, no request signing (and thus no app_secret) is
 * required; login + getFeatured + favorite/create need only the app_id and
 * the user_auth_token obtained at login.
 */
const crypto = require("crypto");

const QOBUZ_BASE = "https://www.qobuz.com/api.json/0.2/";
// app_id from the LMS/Lyrion Qobuz plugin. app_secret is only needed for
// signed (streaming) requests, which we never make — kept for reference only.
const APP_ID = "942852567";

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

module.exports = { login, getFeaturedAlbums, favoriteAlbum, unfavoriteAlbum, getFavoriteAlbumIds, md5Hex, APP_ID };
