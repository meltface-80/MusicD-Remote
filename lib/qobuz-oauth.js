"use strict";
/*
 * qobuz-oauth.js — signing in to Qobuz on Qobuz's own page.
 *
 * WHY THIS EXISTS. The streaming waveform needs a SIGNED request, and a Qobuz
 * signature needs three things that must all belong to the same application:
 * an app_id, that app's secret, and a login token minted BY that app. This
 * extension's ordinary Qobuz login (username + password, the arrangement the
 * LMS plugin uses) produces a token for an app whose secret it does not have,
 * so no combination of what it already held could ever sign. Six versions were
 * spent discovering that.
 *
 * The way out is the redirect flow Qobuz publishes for third-party apps: the
 * user signs in on qobuz.com, Qobuz sends their browser back here with a
 * one-time code, and that code trades for a token minted by the app whose
 * secret we hold. Nothing is typed into this app and no password passes
 * through it.
 *
 * THE REDIRECT URL IS DERIVED FROM THE REQUEST, not configured. Whatever
 * address the user reached the settings page on — 192.168.1.50:3399, a
 * hostname, a reverse proxy — is the address Qobuz is told to send them back
 * to. That is what makes this work inside Docker, where the container has no
 * idea what address it is reached on, and from a phone on the same network.
 *
 * The application credentials below are the ones the Qobuz desktop app is
 * registered with, published in the open by the author of an existing
 * open-source Qobuz client. They identify the APPLICATION, never a user, and
 * they are not a password: without a token minted through the sign-in above
 * they grant nothing at all.
 *
 * Pure and offline apart from exchangeCode's single request, so the URL
 * building and the code parsing are testable without an account.
 */

const APP_ID      = "304027809";
const PRIVATE_KEY = "6lz8C03UDIC7";
const APP_SECRET  = "96c4538ca81015a5be0c1d5bd9573844";

const SIGNIN_URL = "https://www.qobuz.com/signin/oauth";
const API_BASE   = "https://www.qobuz.com/api.json/0.2";
const CODE_PARAM = "code_autorisation";

/**
 * Where Qobuz should send the browser back to.
 *
 * Taken from the request's own Host header rather than a setting, so it is
 * right by construction on a LAN address, a hostname, or behind a proxy. The
 * forwarded headers are honoured first because a proxy rewrites Host to its
 * upstream, which would send the user back to an address only the proxy can
 * reach.
 *
 * @param {object} req   an Express-style request (headers, protocol, secure)
 * @param {string} path  the callback path, e.g. "/api/qobuz/oauth/callback"
 */
function callbackUrlFrom(req, path) {
  const h = (req && req.headers) || {};
  const host = h["x-forwarded-host"] || h.host || "";
  if (!host) return "";
  // A forwarded proto is the only reliable signal of the scheme the USER used;
  // req.secure describes the hop into this process, which behind a proxy is
  // plain http even when the browser is on https.
  const proto = String(h["x-forwarded-proto"] || "").split(",")[0].trim()
             || (req && req.secure ? "https" : "http");
  return proto + "://" + host + path;
}

/** The page to send the user to. They sign in there, not here. */
function buildAuthorizeUrl(redirectUrl, appId) {
  if (!redirectUrl) throw new Error("redirect_url is required to start the Qobuz sign-in");
  const q = new URLSearchParams({
    ext_app_id: String(appId || APP_ID),
    redirect_url: String(redirectUrl),
  });
  return SIGNIN_URL + "?" + q.toString();
}

/**
 * Pull the one-time code out of whatever came back.
 *
 * Accepts the full redirect URL, a bare query string, or the code on its own.
 * The redirect normally lands here by itself; the paste path exists for the
 * case where it cannot — signing in on a phone that is not on the same
 * network as the box, say — and someone copying an address bar may bring back
 * any of those three shapes.
 *
 * @returns {string} the code, or "" when there is none to find.
 */
function extractCode(urlOrCode) {
  const v = String(urlOrCode == null ? "" : urlOrCode).trim();
  if (!v) return "";
  if (v.startsWith("http") || v.includes("?") || v.includes("&") || v.includes("=")) {
    const qs = v.includes("?") ? v.slice(v.indexOf("?") + 1) : v.replace(/^\?/, "");
    const got = new URLSearchParams(qs).get(CODE_PARAM);
    if (got) return got.trim();
    // Looked like a URL and carried no code: an error page, a cancelled
    // sign-in, or the wrong address copied. Reporting "" lets the caller say
    // so, where returning the whole URL as a "code" would fail later as an
    // opaque rejection from Qobuz.
    return "";
  }
  return v;
}

/**
 * Trade the one-time code for a login token.
 *
 * Codes are single-use and short-lived, so a failure here is nearly always
 * "start again" rather than anything the user can fix — which is what the 404
 * message says, because Qobuz's own status code for a spent code is a 404 and
 * that reads like a broken app rather than an expired code.
 *
 * @returns {{token:string, userId:string}}
 * @throws  {Error} with a message meant to be shown to a person
 */
async function exchangeCode(code, opts) {
  const o = opts || {};
  const fetchFn = o.fetch || globalThis.fetch;
  if (!code) throw new Error("No sign-in code to exchange");

  const q = new URLSearchParams({ code: String(code), private_key: o.privateKey || PRIVATE_KEY });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs || 20000);
  let res, body;
  try {
    res = await fetchFn(API_BASE + "/oauth/callback?" + q.toString(), {
      headers: { "X-App-Id": String(o.appId || APP_ID) },
      signal: ctl.signal,
    });
    body = await res.text();
  } catch (e) {
    throw new Error("Could not reach Qobuz to finish signing in: " + (e && e.message));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw new Error("Qobuz rejected the sign-in code. Codes can only be used once and " +
                    "expire quickly — start the sign-in again.");
  }
  if (!res.ok) {
    throw new Error("Qobuz refused the sign-in (HTTP " + res.status + ")");
  }

  let data = null;
  try { data = JSON.parse(body); } catch (e) { data = null; }
  const token  = data && data.token;
  const userId = data && data.user_id;
  if (!token || !userId) throw new Error("Qobuz returned no token for that sign-in code");
  return { token: String(token), userId: String(userId) };
}

module.exports = {
  APP_ID, PRIVATE_KEY, APP_SECRET, SIGNIN_URL, API_BASE, CODE_PARAM,
  callbackUrlFrom, buildAuthorizeUrl, extractCode, exchangeCode,
};
