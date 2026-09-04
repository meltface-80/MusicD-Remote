"use strict";
// ---------------------------------------------------------------------------
// Signing in to Qobuz on Qobuz's own page.
//
// This is what finally makes a streaming waveform work with no setup. A Qobuz
// signature needs an app_id, that app's secret, and a token minted BY that app;
// the extension's ordinary username/password login produces a token for an app
// whose secret it does not have, so no arrangement of what it already held
// could ever sign. Six versions were spent discovering that.
//
// The redirect flow closes it: the user signs in on qobuz.com, and the code
// that comes back trades for a token belonging to the app whose secret ships
// here. Nothing is typed into the extension and no password passes through it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../../lib/qobuz-oauth");

// --- the redirect address --------------------------------------------------

test("the callback address comes from the request, not a setting", () => {
  // THE reason this works in Docker and from a phone: the container has no idea
  // what address it is reached on, and the request does.
  assert.equal(
    O.callbackUrlFrom({ headers: { host: "192.168.1.50:3399" } }, "/api/qobuz/oauth/callback"),
    "http://192.168.1.50:3399/api/qobuz/oauth/callback");
});

test("a proxy's forwarded headers win over the rewritten Host", () => {
  // Behind a proxy, Host is the upstream — sending the user back there would
  // point their browser at an address only the proxy can reach.
  assert.equal(
    O.callbackUrlFrom({
      headers: { host: "127.0.0.1:3399",
                 "x-forwarded-host": "music.example.com",
                 "x-forwarded-proto": "https" } }, "/cb"),
    "https://music.example.com/cb");
});

test("a comma-separated forwarded proto takes the first hop", () => {
  assert.equal(
    O.callbackUrlFrom({ headers: { host: "h", "x-forwarded-proto": "https, http" } }, "/cb"),
    "https://h/cb");
});

test("req.secure is honoured when nothing is forwarded", () => {
  assert.equal(O.callbackUrlFrom({ headers: { host: "h" }, secure: true }, "/cb"), "https://h/cb");
});

test("no Host at all yields no URL rather than a broken one", () => {
  assert.equal(O.callbackUrlFrom({ headers: {} }, "/cb"), "");
  assert.equal(O.callbackUrlFrom({}, "/cb"), "");
});

// --- the sign-in URL -------------------------------------------------------

test("the authorize URL carries the app id and the redirect, encoded", () => {
  const u = O.buildAuthorizeUrl("http://192.168.1.50:3399/cb");
  assert.ok(u.startsWith("https://www.qobuz.com/signin/oauth?"), u);
  const q = new URL(u).searchParams;
  assert.equal(q.get("ext_app_id"), O.APP_ID);
  assert.equal(q.get("redirect_url"), "http://192.168.1.50:3399/cb",
    "the redirect must survive encoding intact — a mangled one strands the user");
});

test("no redirect address is refused rather than sent half-formed", () => {
  assert.throws(() => O.buildAuthorizeUrl(""), /redirect_url is required/);
});

// --- reading the code back -------------------------------------------------

test("the code is found in a full callback URL", () => {
  assert.equal(
    O.extractCode("http://192.168.1.50:3399/cb?code_autorisation=ABC123&state=x"), "ABC123");
});

test("…in a bare query string, and on its own", () => {
  assert.equal(O.extractCode("?code_autorisation=ABC123"), "ABC123");
  assert.equal(O.extractCode("code_autorisation=ABC123"), "ABC123");
  assert.equal(O.extractCode("ABC123"), "ABC123");
  assert.equal(O.extractCode("  ABC123  "), "ABC123");
});

test("a URL with no code yields nothing, not the URL as a 'code'", () => {
  // A cancelled sign-in or the wrong address copied. Returning the whole URL
  // would fail later as an opaque rejection from Qobuz instead of a clear
  // "that address carried no code".
  assert.equal(O.extractCode("https://www.qobuz.com/signin?error=denied"), "");
  assert.equal(O.extractCode(""), "");
  assert.equal(O.extractCode(null), "");
});

// --- the exchange ----------------------------------------------------------

function stubFetch(status, body) {
  return async () => ({ status, ok: status >= 200 && status < 300,
                        text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
}

test("a good exchange returns the token and the user it belongs to", async () => {
  const got = await O.exchangeCode("CODE", {
    fetch: stubFetch(200, { token: "tok-abc", user_id: 4242 }) });
  assert.deepEqual(got, { token: "tok-abc", userId: "4242" });
});

test("the request presents the app id the secret belongs to", async () => {
  let sawUrl = "", sawHeaders = null;
  await O.exchangeCode("CODE", {
    fetch: async (url, opts) => {
      sawUrl = String(url); sawHeaders = (opts && opts.headers) || {};
      return { status: 200, ok: true, text: async () => JSON.stringify({ token: "t", user_id: 1 }) };
    },
  });
  assert.equal(sawHeaders["X-App-Id"], O.APP_ID,
    "signing later uses this app's secret, so the exchange must be made as that app");
  assert.match(sawUrl, /code=CODE/);
  assert.match(sawUrl, new RegExp("private_key=" + O.PRIVATE_KEY));
});

test("a spent code is explained as a spent code, not as a broken app", async () => {
  // Qobuz answers a used or expired code with 404, which reads like the
  // endpoint is gone. The message has to say what actually happened.
  await assert.rejects(
    () => O.exchangeCode("CODE", { fetch: stubFetch(404, "") }),
    /only be used once|expire/i);
});

test("any other refusal names its status", async () => {
  await assert.rejects(() => O.exchangeCode("CODE", { fetch: stubFetch(500, "") }), /HTTP 500/);
});

test("a 200 with no token is an error, not a silent empty sign-in", async () => {
  await assert.rejects(
    () => O.exchangeCode("CODE", { fetch: stubFetch(200, { ok: true }) }), /no token/i);
  await assert.rejects(
    () => O.exchangeCode("CODE", { fetch: stubFetch(200, "not json") }), /no token/i);
});

test("no code is refused before any request is made", async () => {
  let called = false;
  await assert.rejects(() => O.exchangeCode("", { fetch: async () => { called = true; } }),
                       /No sign-in code/);
  assert.equal(called, false);
});

test("a network failure says so rather than surfacing a raw stack", async () => {
  await assert.rejects(
    () => O.exchangeCode("CODE", { fetch: async () => { throw new Error("ECONNREFUSED"); } }),
    /Could not reach Qobuz/);
});

// --- the built-in application credentials ----------------------------------

test("the app id, private key and secret are all present and distinct", () => {
  // They identify the APPLICATION, never a user, and they grant nothing without
  // a token from the sign-in above. All three are needed and mixing them up
  // fails as an indistinguishable 401.
  for (const v of [O.APP_ID, O.PRIVATE_KEY, O.APP_SECRET]) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
  assert.equal(new Set([O.APP_ID, O.PRIVATE_KEY, O.APP_SECRET]).size, 3);
  assert.match(O.APP_SECRET, /^[a-f0-9]{32}$/, "the secret must be a 32-char hex md5 key");
});
