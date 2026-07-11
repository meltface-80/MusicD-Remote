/*
 * Lite Tidal API client — new releases, featured lists, catalog search,
 * artist discographies, and the user's own favourites.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * IMPORTANT: This uses the UNOFFICIAL Tidal API (the same client credentials
 * the Lyrion/LMS "Tidal" community plugin uses). It is NOT a sanctioned Tidal
 * integration and is against Tidal's Terms of Service. It may break at any
 * time and is used at the user's own risk. Login is via Tidal's OAuth device
 * flow — the user approves a code on tidal.com, so we never see (or store)
 * the password. Scope:
 *   - featured album lists (/featured — new, top, rising, recommended),
 *   - catalog search (/search/albums, /search/artists),
 *   - artist discographies (/artists/{id}/albums), and
 *   - add/remove albums in the user's OWN Tidal favourites
 *     (/users/{id}/favorites/albums).
 * No downloading and no streaming — Roon handles all playback. We never
 * request stream URLs.
 */

const AUTH_BASE = "https://auth.tidal.com";
const API_BASE  = "https://api.tidal.com/v1";
// Client credentials from the LMS/Lyrion Tidal plugin. Used only for the
// OAuth device flow and the catalog/favourites endpoints above.
const CLIENT_ID     = "4N3n6Q1x95LL5K7p";
const CLIENT_SECRET = "oKOXfJW371cX6xaZ0PyhgGNBdNLlBZd4AKKYougMjik=";
// The literal scope string Tidal expects. Its "+" must reach the server
// as-is: URLSearchParams would emit "%2B" and a raw "+" in a form body
// decodes to a space, so the auth body is form-encoded manually with the
// scope value passed through untouched (see formEncode).
const SCOPE = "r_usr+w_usr";

// Manual application/x-www-form-urlencoded encoder. Every value is
// encodeURIComponent'd EXCEPT `scope`, which must keep its literal "+"
// (see the SCOPE comment above).
function formEncode(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    parts.push(encodeURIComponent(k) + "=" + (k === "scope" ? String(v) : encodeURIComponent(String(v))));
  }
  return parts.join("&");
}

// Single POST against the Tidal auth API (Basic client auth + form body).
// Returns { status, data } WITHOUT throwing on non-2xx: the device-flow
// token poll answers HTTP 400 "authorization_pending" while the user hasn't
// approved yet, so callers must be able to inspect error bodies. `data` is
// null when the body isn't JSON (e.g. an HTML error/maintenance page).
async function tidalAuthPost(path, bodyParams, timeoutMs = 12000) {
  const body = formEncode(Object.assign({ client_id: CLIENT_ID }, bodyParams));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(AUTH_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")
      },
      body,
      signal: ctl.signal
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      // Non-JSON body — leave data null; callers fall back to the HTTP
      // status when building their error messages.
      data = null;
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Best human-readable message from a Tidal auth error body.
function authErrMessage(status, data) {
  return (data && (data.error_description || data.userMessage || data.error)) || ("HTTP " + status);
}

// Single request against the Tidal data API. Adds the Bearer header; the
// caller supplies countryCode in `params` (every data endpoint requires it).
// Throws Error with .code on 401/429, mirroring lib/qobuz.js's qobuzGet.
// An empty success body (favourite add/remove) resolves to null; a non-empty
// non-JSON body throws a clean error instead of a JSON-parser SyntaxError.
async function tidalRequest(method, path, params, token, formBody, timeoutMs = 12000) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const url = API_BASE + path + (qs.toString() ? "?" + qs.toString() : "");
  const headers = { "Authorization": "Bearer " + token };
  const opts = { method, headers };
  if (formBody !== undefined && formBody !== null) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = formBody;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  opts.signal = ctl.signal;
  try {
    const res = await fetch(url, opts);
    if (res.status === 401) { const e = new Error("Tidal auth failed (401)"); e.code = 401; throw e; }
    if (res.status === 429) { const e = new Error("Tidal rate limited (429)"); e.code = 429; throw e; }
    if (!res.ok) throw new Error("Tidal HTTP " + res.status);
    const text = await res.text();
    if (!text) return null; // 204 / empty body (favourite add/remove)
    try {
      return JSON.parse(text);
    } catch (e) {
      // A 200 with a non-JSON body (e.g. an HTML error/maintenance page).
      throw new Error("Tidal returned an unexpected (non-JSON) response");
    }
  } finally {
    clearTimeout(timer);
  }
}

function tidalGet(path, params, token) {
  return tidalRequest("GET", path, params, token, null);
}

// Defensive `{ items, total }` guard for paged Tidal responses
// ({ items, totalNumberOfItems }) — either field may be missing or malformed.
function pagedSection(r) {
  return {
    items: (r && Array.isArray(r.items)) ? r.items : [],
    total: (r && Number.isFinite(r.totalNumberOfItems)) ? r.totalNumberOfItems : 0
  };
}

// Tidal returns its verification URIs WITHOUT a scheme ("link.tidal.com/XXXXX").
// A schemeless value used as an <a href> resolves relative to the extension's
// own origin (http://<host>/link.tidal.com/… → 404), so force https:// here.
function ensureHttps(uri) {
  const s = String(uri || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

// Start the OAuth device flow. Returns { deviceCode, userCode,
// verificationUri, verificationUriComplete, expiresIn, interval } — the user
// visits verificationUriComplete (or enters userCode at verificationUri) and
// approves, then pollDeviceToken() succeeds.
async function startDeviceAuth() {
  const { status, data } = await tidalAuthPost("/v1/oauth2/device_authorization", { scope: SCOPE });
  if (status < 200 || status >= 300 || !data || !data.deviceCode || !data.userCode) {
    throw new Error("Tidal device authorization failed: " + authErrMessage(status, data));
  }
  return {
    deviceCode:              data.deviceCode,
    userCode:                data.userCode,
    verificationUri:         ensureHttps(data.verificationUri || "link.tidal.com"),
    verificationUriComplete: ensureHttps(data.verificationUriComplete || ""),
    expiresIn:               Number.isFinite(data.expiresIn) ? data.expiresIn : 300,
    interval:                Number.isFinite(data.interval) ? data.interval : 2
  };
}

// Poll the device-flow token endpoint once. While the user hasn't approved
// yet, Tidal answers HTTP 400 with error "authorization_pending" — returned
// here as { pending: true } rather than thrown. On success returns the
// normalized connection:
//   { pending: false, accessToken, refreshToken, expiresIn,
//     userId, countryCode, displayName }.
// Any other outcome (denied, expired code, network) throws.
async function pollDeviceToken(deviceCode) {
  if (!deviceCode) throw new Error("deviceCode required");
  const { status, data } = await tidalAuthPost("/v1/oauth2/token", {
    scope:       SCOPE,
    grant_type:  "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode
  });
  if (status >= 200 && status < 300 && data && data.access_token) {
    const user = (data.user && typeof data.user === "object") ? data.user : {};
    const rawUserId = (data.user_id != null) ? data.user_id : user.userId;
    if (rawUserId == null || rawUserId === "") {
      throw new Error("Tidal device login succeeded but returned no user id");
    }
    let countryCode = user.countryCode || "US";
    if (countryCode === "UK") countryCode = "GB"; // Tidal says UK; ISO 3166 is GB
    return {
      pending:      false,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token || "",
      expiresIn:    Number.isFinite(data.expires_in) ? data.expires_in : 3600,
      userId:       String(rawUserId),
      countryCode,
      displayName:  user.nickname || user.username || user.email || "Tidal user"
    };
  }
  // Non-terminal poll outcomes (RFC 8628): authorization_pending = keep
  // polling; slow_down = keep polling but stretch the interval (the caller
  // reads slowDown and adds 5s).
  if (data && String(data.error) === "authorization_pending") return { pending: true };
  if (data && String(data.error) === "slow_down") return { pending: true, slowDown: true };
  const e = new Error("Tidal device login failed: " + authErrMessage(status, data));
  if (status === 401) e.code = 401;
  if (status === 429) e.code = 429;
  // A structured OAuth error (access_denied, expired_token, …) is a
  // DEFINITIVE outcome; a network/timeout failure has no oauthError and the
  // caller may retry the poll instead of aborting the whole login.
  if (data && data.error) e.oauthError = String(data.error);
  throw e;
}

// Exchange the long-lived refresh token for a fresh access token. Returns
// { accessToken, refreshToken, expiresIn }; refreshToken is null unless
// Tidal rotated it (store the new one when it's non-null).
async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("refreshToken required");
  const { status, data } = await tidalAuthPost("/v1/oauth2/token", {
    grant_type:    "refresh_token",
    refresh_token: refreshToken
  });
  if (status >= 200 && status < 300 && data && data.access_token) {
    return {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token || null,
      expiresIn:    Number.isFinite(data.expires_in) ? data.expires_in : 3600
    };
  }
  const e = new Error("Tidal token refresh failed: " + authErrMessage(status, data));
  if (status === 401) e.code = 401;
  if (status === 429) e.code = 429;
  // invalid_grant means the refresh token itself is dead (revoked/expired) —
  // surface it as a 401 so the caller degrades to "not connected" instead of
  // retrying a permanently broken token forever.
  if (data && String(data.error) === "invalid_grant") e.code = 401;
  throw e;
}

// Album catalog search. Returns { items, total }.
async function searchAlbums(token, cc, query, limit, offset) {
  const r = await tidalGet("/search/albums", {
    query,
    limit:       limit || 50,
    offset:      offset || 0,
    countryCode: cc
  }, token);
  return pagedSection(r);
}

// Artist catalog search. Returns { items, total } — each item is
// { id, name, picture (uuid or null) }.
async function searchArtists(token, cc, query, limit) {
  const r = await tidalGet("/search/artists", {
    query,
    limit:       limit || 8,
    offset:      0,
    countryCode: cc
  }, token);
  return pagedSection(r);
}

// Artist details. Returns { id (string), name, picture (uuid or null) },
// guarding every field.
async function getArtist(token, cc, artistId) {
  if (!artistId) throw new Error("artistId required");
  const r = await tidalGet("/artists/" + encodeURIComponent(artistId), { countryCode: cc }, token);
  return {
    id:      (r && r.id != null) ? String(r.id) : String(artistId),
    name:    (r && r.name) || "",
    picture: (r && r.picture) || null
  };
}

// Tidal's editorial artist bio (v1 /artists/{id}/bio). The text embeds
// [wimpLink …]Name[/wimpLink] markup around artist/album references —
// stripped here to the inner text. Returns the plain text or null; a 404
// (no bio for this artist) surfaces as a thrown HTTP error for the caller.
async function getArtistBio(token, cc, artistId) {
  if (!artistId) throw new Error("artistId required");
  const r = await tidalGet("/artists/" + encodeURIComponent(artistId) + "/bio", { countryCode: cc }, token);
  const raw = (r && (r.text || r.summary)) || "";
  const text = String(raw).replace(/\[wimpLink[^\]]*\]/g, "").replace(/\[\/wimpLink\]/g, "").trim();
  return text || null;
}

// One page of an artist's albums (studio albums only — filter ALBUMS).
// Returns { items, total }.
async function getArtistAlbums(token, cc, artistId, limit, offset) {
  if (!artistId) throw new Error("artistId required");
  const r = await tidalGet("/artists/" + encodeURIComponent(artistId) + "/albums", {
    filter:      "ALBUMS",
    limit:       limit || 50,
    offset:      offset || 0,
    countryCode: cc
  }, token);
  return pagedSection(r);
}

// The /featured group list ("new", "top", "rising", "recommended", …).
// Group ids aren't guaranteed stable, so callers should match on id, name,
// or path. Defensive about the shape (bare array, { items } or { rows }
// wrapper). Returns an array of { id, name, path }.
async function getFeaturedGroups(token, cc) {
  const r = await tidalGet("/featured", { countryCode: cc }, token);
  const raw = Array.isArray(r) ? r
    : (r && Array.isArray(r.items)) ? r.items
    : (r && Array.isArray(r.rows))  ? r.rows
    : [];
  const groups = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const id   = (g.id   != null) ? String(g.id)   : "";
    const name = (g.name != null) ? String(g.name) : "";
    const path = (g.path != null) ? String(g.path) : "";
    if (!id && !name && !path) continue;
    groups.push({ id: id || path || name, name, path });
  }
  return groups;
}

// Albums of one featured group. Returns the raw album items[].
async function getFeaturedAlbums(token, cc, groupId, limit) {
  if (!groupId) throw new Error("groupId required");
  const r = await tidalGet("/featured/" + encodeURIComponent(groupId) + "/albums", {
    limit:       limit || 100,
    offset:      0,
    countryCode: cc
  }, token);
  return pagedSection(r).items;
}

// The user's favourite albums as raw { created, item } entries (item is the
// album object — unwrap .item). Single page of up to 5000, matching the LMS
// plugin's approach.
async function getFavoriteAlbums(token, cc, userId) {
  if (!userId) throw new Error("userId required");
  const r = await tidalGet("/users/" + encodeURIComponent(userId) + "/favorites/albums", {
    limit:       5000,
    countryCode: cc
  }, token);
  return pagedSection(r).items;
}

// Add an album to the user's Tidal favourites. Idempotent (SKIP on
// already-favourited / missing artifacts).
async function favoriteAlbum(token, cc, userId, albumId) {
  if (!userId) throw new Error("userId required");
  if (!albumId) throw new Error("albumId required");
  const body = "albumIds=" + encodeURIComponent(String(albumId)) + "&onArtifactNotFound=SKIP";
  return await tidalRequest("POST", "/users/" + encodeURIComponent(userId) + "/favorites/albums",
    { countryCode: cc }, token, body);
}

// Remove an album from the user's Tidal favourites. Idempotent.
async function unfavoriteAlbum(token, cc, userId, albumId) {
  if (!userId) throw new Error("userId required");
  if (!albumId) throw new Error("albumId required");
  return await tidalRequest("DELETE",
    "/users/" + encodeURIComponent(userId) + "/favorites/albums/" + encodeURIComponent(String(albumId)),
    { countryCode: cc }, token, null);
}

// Image URL for a Tidal cover/picture uuid. Sizes: "640x640" (album lists),
// "1280x1280" (album detail), "750x750" (artist pictures).
function coverUrl(uuid, size) {
  if (!uuid) return null;
  return "https://resources.tidal.com/images/" + String(uuid).replace(/-/g, "/") + "/" + (size || "640x640") + ".jpg";
}

module.exports = {
  startDeviceAuth, pollDeviceToken, refreshAccessToken,
  searchAlbums, searchArtists, getArtist, getArtistBio, getArtistAlbums,
  getFeaturedGroups, getFeaturedAlbums,
  getFavoriteAlbums, favoriteAlbum, unfavoriteAlbum,
  coverUrl
};
