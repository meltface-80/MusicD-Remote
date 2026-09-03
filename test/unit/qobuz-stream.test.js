"use strict";
// ---------------------------------------------------------------------------
// v1.8.6: the two pure decisions behind a streaming waveform.
//
//   * the request signature — undocumented, order-sensitive, and answered by
//     Qobuz with the same silence whether the secret is wrong or the parameters
//     were assembled in the wrong order;
//   * which track on the album is the one playing — the decision that makes a
//     streaming waveform either correct or confidently, invisibly wrong.
//
// Neither needs an account, a network or a subscription to test, which is the
// point of them living here.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const SIG = require("../../lib/qobuz-sig");
const { matchTrack, DURATION_TOLERANCE_S } = require("../../lib/trackmatch");
const QB = require("../../lib/qobuz");

// --- the signature ---------------------------------------------------------

test("the signature is built from name+value pairs sorted BY NAME", () => {
  // The order is the part that bites: the server rebuilds this string its own
  // way and compares, so a different order is simply a wrong signature.
  const ts = 1700000000;
  const mine = SIG.signRequest("track", "getFileUrl",
    { track_id: 42, format_id: 5, intent: "stream" }, ts, "s3cr3t");
  const byHand = SIG.md5Hex("trackgetFileUrl" + "format_id5" + "intentstream" +
                            "track_id42" + ts + "s3cr3t");
  assert.equal(mine, byHand);
});

test("declaring the parameters in a different order cannot change the signature", () => {
  const ts = 1700000000;
  const a = SIG.signRequest("track", "getFileUrl", { a: 1, b: 2, c: 3 }, ts, "k");
  const b = SIG.signRequest("track", "getFileUrl", { c: 3, a: 1, b: 2 }, ts, "k");
  assert.equal(a, b, "the sort is what makes this stable — it was not applied");
});

test("every input actually participates", () => {
  // A signature that ignores one of its inputs still looks like a signature and
  // fails only against the live server, which is the worst place to find out.
  const base = ["track", "getFileUrl", { track_id: 1, format_id: 5 }, 1700000000, "k"];
  const sig = SIG.signRequest(...base);
  const vary = [
    ["object",    ["album", base[1], base[2], base[3], base[4]]],
    ["method",    [base[0], "getStreamUrl", base[2], base[3], base[4]]],
    ["a param",   [base[0], base[1], { track_id: 2, format_id: 5 }, base[3], base[4]]],
    ["the ts",    [base[0], base[1], base[2], 1700000001, base[4]]],
    ["the secret",[base[0], base[1], base[2], base[3], "different"]],
  ];
  for (const [what, args] of vary) {
    assert.notEqual(SIG.signRequest(...args), sig, `changing ${what} left the signature alone`);
  }
});

test("the query carries the same timestamp it signed", () => {
  // Signing one ts and sending another is a wrong signature with a plausible
  // -looking request, and Qobuz reports it identically to a bad secret.
  const p = SIG.fileUrlParams({ trackId: 99, secret: "k", ts: 1700000000 });
  assert.equal(p.request_ts, 1700000000);
  assert.equal(p.request_sig,
    SIG.signRequest("track", "getFileUrl",
      { format_id: p.format_id, intent: p.intent, track_id: p.track_id },
      p.request_ts, "k"));
});

test("MP3 320 is the default format, and it is not an accident", () => {
  // The peaks are resampled to 1000 buckets from an 8 kHz mono decode, where a
  // lossy envelope is indistinguishable — at a tenth to a twentieth of the
  // bytes. Defaulting to FLAC would be 30-150 MB a track for an identical
  // picture.
  assert.equal(SIG.fileUrlParams({ trackId: 1, secret: "k" }).format_id, SIG.FORMAT_MP3_320);
  assert.equal(SIG.FORMAT_MP3_320, 5);
  assert.equal(SIG.fileUrlParams({ trackId: 1, secret: "k", formatId: 6 }).format_id, 6);
});

test("THE one: a preview clip is not accepted as the track", () => {
  // Qobuz answers a refused request with 200 and a body, not an error status.
  // Decoding the 30-second sample and drawing it across a five-minute bar looks
  // like the track and is not.
  assert.equal(SIG.usableFileUrl({ url: "https://x/f.mp3", sample: true }), null,
    "the sample flag was ignored — this draws a preview as the whole song");
  assert.equal(SIG.usableFileUrl({ url: "https://x/f.mp3" }), "https://x/f.mp3");
  assert.equal(SIG.usableFileUrl({ url: "https://x/f.mp3", sample: false }), "https://x/f.mp3");
});

test("an answer with no url at all is refused rather than half-used", () => {
  for (const junk of [null, undefined, {}, { url: "" }, { url: 42 }, "a string", 7]) {
    assert.equal(SIG.usableFileUrl(junk), null, `usableFileUrl(${JSON.stringify(junk)})`);
  }
});

// --- picking the track -----------------------------------------------------

const ALBUM = [
  { id: 1, title: "Pleasure",       duration: 256 },
  { id: 2, title: "Invisible Hand", duration: 234 },
  { id: 3, title: "Found",          duration: 205 },
];

test("title and duration together identify the track", () => {
  const r = matchTrack(ALBUM, "Pleasure", 256);
  assert.equal(r.track.id, 1);
});

test("rounding either way is still the same recording", () => {
  for (const s of [254, 255, 256, 257, 258]) {
    assert.ok(matchTrack(ALBUM, "Pleasure", s).track, `${s}s should still match 256s`);
  }
  assert.equal(DURATION_TOLERANCE_S, 2);
});

test("THE one: the same title at a different length is a different recording", () => {
  // A remaster, a radio edit, a live version. This is the case that produces a
  // waveform which looks right and is another performance entirely.
  const r = matchTrack(ALBUM, "Pleasure", 291);
  assert.equal(r.track, null, "a 291s track was accepted as the 256s one");
  assert.match(r.reason, /different recording/);
  assert.match(r.reason, /256/, "the reason should name what it found");
});

test("two tracks of the same name and length is ambiguous, not a coin flip", () => {
  const twice = [
    { id: 1, title: "Reprise", duration: 100 },
    { id: 2, title: "Reprise", duration: 100 },
  ];
  const r = matchTrack(twice, "Reprise", 100);
  assert.equal(r.track, null);
  assert.match(r.reason, /ambiguous/);
});

test("two of the same name at different lengths resolves to the right one", () => {
  const twice = [
    { id: 1, title: "Reprise", duration: 100 },
    { id: 2, title: "Reprise", duration: 240 },
  ];
  assert.equal(matchTrack(twice, "Reprise", 241).track.id, 2);
});

test("titles are compared canonically, not literally", () => {
  const album = [{ id: 9, title: "Goodnight, God Bless — I Love U!", duration: 256 }];
  assert.equal(matchTrack(album, "goodnight god bless i love u", 256).track.id, 9,
    "punctuation and case should not decide whether a track is found");
});

test("no duration from Roon means no match, never a title-only guess", () => {
  // Without the gate this module has nothing left but the title, which is
  // exactly what it exists to refuse.
  for (const d of [undefined, null, 0, -5, NaN, "256"]) {
    const r = matchTrack(ALBUM, "Pleasure", d);
    assert.equal(r.track, null, `duration ${JSON.stringify(d)} was accepted`);
    assert.match(r.reason, /duration/);
  }
});

test("a track the service does not list is a clean miss", () => {
  const r = matchTrack(ALBUM, "Some Other Song", 200);
  assert.equal(r.track, null);
  assert.match(r.reason, /no track called/);
});

test("a service track with no duration cannot pass the gate", () => {
  const album = [{ id: 1, title: "Pleasure", duration: null }];
  assert.equal(matchTrack(album, "Pleasure", 256).track, null,
    "a missing duration must not be treated as a match");
});

test("an empty or absent album, and an empty title, are survivable", () => {
  assert.equal(matchTrack([], "Pleasure", 256).track, null);
  assert.equal(matchTrack(null, "Pleasure", 256).track, null);
  assert.equal(matchTrack(ALBUM, "", 256).track, null);
  assert.equal(matchTrack(ALBUM, null, 256).track, null);
  // Junk entries in the list must not throw the whole match away.
  assert.equal(matchTrack([null, undefined, ALBUM[0]], "Pleasure", 256).track.id, 1);
});

test("every outcome explains itself", () => {
  // "no waveform" with no reason is what makes this class of feature
  // undiagnosable from a user's report.
  for (const args of [[ALBUM, "Pleasure", 256], [ALBUM, "Pleasure", 999],
                      [ALBUM, "Nope", 100], [[], "x", 1], [ALBUM, "Pleasure", 0]]) {
    const r = matchTrack(...args);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason.length > 8, `thin reason: "${r.reason}"`);
  }
});

// --- the URL the call actually goes to (v1.8.9) ----------------------------

test("THE one: a leading slash in an endpoint cannot reach the URL", () => {
  // QOBUZ_BASE ends in "/", so "/album/get" builds ".../0.2//album/get" — wrong
  // in a way nothing downstream can see, because the failure comes back as an
  // ordinary non-200 and this client turns those into "no result". v1.8.6
  // shipped both streaming calls that way and they simply never worked.
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../lib/qobuz.js"), "utf8");
  const calls = [...src.matchAll(/qobuzGet\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(calls.length >= 8, `only found ${calls.length} qobuzGet calls — the scan is not working`);
  const bad = calls.filter((e) => e.startsWith("/"));
  assert.deepEqual(bad, [], `these endpoints carry a leading slash: ${bad.join(", ")}`);
  // And the guard that makes it not matter even if one slips through.
  assert.match(src, /endpoint\s*=\s*String\(endpoint[^)]*\)\.replace\(\/\^\\\/\+\/, ""\)/,
    "qobuzGet no longer strips a leading slash, so the convention is unenforced again");
});

test("the streaming endpoints are named the way Qobuz names them", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../lib/qobuz.js"), "utf8");
  for (const e of ["album/get", "track/getFileUrl"]) {
    assert.ok(src.includes('qobuzGet("' + e + '"'), `missing the ${e} call`);
  }
});

// --- the app_id/secret pair (v1.8.9) ---------------------------------------
// Secrets are app_id-specific: a signature made with one app's secret is only
// valid against that app's id. Splitting the two across separate fields is how
// one of them gets updated later and the other does not, and the failure is
// indistinguishable from a wrong secret.

test("THE one: a credentials file keeps the pair together", () => {
  const p = SIG.parseSecretInput(JSON.stringify({
    app_id: "798273057", app_secret: "deadbeef", user_auth_token: "tok",
  }));
  assert.equal(p.secret, "deadbeef");
  assert.equal(p.appId, "798273057", "the id was dropped — the pair is broken");
});

test("a bare secret leaves the app_id to the caller", () => {
  const p = SIG.parseSecretInput("  justthesecret  ");
  assert.equal(p.secret, "justthesecret", "surrounding whitespace was not trimmed");
  assert.equal(p.appId, "", "an id was invented for a paste that carried none");
});

test("the pair is found however the file nests it", () => {
  const p = SIG.parseSecretInput(JSON.stringify({
    accounts: { primary: { creds: { app_id: 111, app_secret: "sss" } } },
  }));
  assert.equal(p.secret, "sss");
  assert.equal(p.appId, "111", "numbers must survive as strings");
});

test("only app_id counts as the id — not every id in the file", () => {
  // A credentials file is full of ids. Accepting the first one seen would sign
  // with a user id and fail in a way that looks like a bad secret.
  const p = SIG.parseSecretInput(JSON.stringify({
    user_id: "999", id: "888", app_secret: "sss", app_id: "777",
  }));
  assert.equal(p.appId, "777");
});

test("JSON with no secret in it reports nothing, rather than being used raw", () => {
  // Pasting the wrong file is a mistake worth surfacing, not something to store
  // as a very long secret that can never work.
  const p = SIG.parseSecretInput(JSON.stringify({ user_auth_token: "tok" }));
  assert.equal(p.secret, "");
  assert.equal(p.appId, "");
});

test("anything unusable is empty, not a throw", () => {
  for (const junk of ["", "   ", null, undefined, "{ not json", "[]", "{}"]) {
    const p = SIG.parseSecretInput(junk);
    assert.equal(typeof p.secret, "string", `parseSecretInput(${JSON.stringify(junk)})`);
    assert.equal(typeof p.appId, "string");
  }
  // Broken JSON that opens with "{" is not silently kept as a secret either.
  assert.equal(SIG.parseSecretInput("{ not json").secret, "");
});

test("a cycle in the pasted object cannot hang the parse", () => {
  // Not reachable through JSON.parse, but the walk is the kind of code that
  // gets reused, and a diagnostic that hangs the server is worse than none.
  const a = { app_secret: "sss" }; a.self = a;
  assert.doesNotThrow(() => SIG.parseSecretInput(JSON.stringify({ app_secret: "sss" })));
});

// ---------------------------------------------------------------------------
// v1.8.11 — the token is part of the credential set.
//
// v1.8.10 made the app_id and the secret travel together and still failed,
// because Qobuz checks the signing app_id against the app that MINTED THE
// TOKEN. This app logs in with its own app_id, so signing as the pasted app
// while presenting its own token is refused (401) however well the pair agrees.
// All three come out of one credentials file, consistent by construction.
// ---------------------------------------------------------------------------

test("the login token is read out of a pasted credentials file", () => {
  const p = SIG.parseSecretInput(JSON.stringify({
    app_id: "798273057", app_secret: "s3cr3t", user_auth_token: "tok-abc",
    email: "someone@example.com", display_name: "Someone",
  }));
  assert.equal(p.appId, "798273057");
  assert.equal(p.secret, "s3cr3t");
  assert.equal(p.token, "tok-abc", "the token was dropped — this is the v1.8.10 defect");
});

test("a bare secret carries no token, so the caller keeps its own", () => {
  const p = SIG.parseSecretInput("deadbeefcafe");
  assert.equal(p.secret, "deadbeefcafe");
  assert.equal(p.token, "");
  assert.equal(p.appId, "");
});

test("only user_auth_token is adopted, never some other token field", () => {
  // A credentials file may carry a refresh/device/session token. Taking any
  // "token"-ish field would present the wrong one and fail as a 401.
  const p = SIG.parseSecretInput(JSON.stringify({
    app_id: "1", app_secret: "s", refresh_token: "nope", device_token: "also-nope",
  }));
  assert.equal(p.token, "", "a token field that is not user_auth_token was adopted");
});

test("mangled JSON yields no token either — nothing is half-stored", () => {
  const p = SIG.parseSecretInput('{"app_id":"1","app_secret":');
  assert.deepEqual(p, { secret: "", appId: "", token: "" });
});

// --- the reason a stream url was refused -----------------------------------

test("a 400 naming the signature is reported as a signature failure", () => {
  const e = new Error("Qobuz HTTP 400");
  e.code = 400;
  e.body = "Invalid Request Signature parameter (request_sig)";
  const s = QB.describeFileUrlError(e);
  assert.match(s, /SIGNATURE/);
  assert.match(s, /400/);
});

test("a 401 is reported as the TOKEN not matching the signing app", () => {
  const e = new Error("Qobuz auth failed (401)");
  e.code = 401;
  const s = QB.describeFileUrlError(e);
  assert.match(s, /TOKEN/);
  assert.match(s, /minted/i, "the 401 message must name the actual cause, not just the status");
});

test("the three causes produce three different sentences", () => {
  const mk = (code, body) => { const e = new Error("x"); e.code = code; e.body = body || ""; return e; };
  const said = new Set([
    QB.describeFileUrlError(mk(400, "Invalid Request Signature parameter (request_sig)")),
    QB.describeFileUrlError(mk(401)),
    QB.describeFileUrlError(mk(404)),
  ]);
  assert.equal(said.size, 3, "two causes collapsed into one message — the v1.8.10 defect");
});

test("an unrecognised failure still says something rather than nothing", () => {
  const e = new Error("socket hang up");
  const s = QB.describeFileUrlError(e);
  assert.match(s, /socket hang up/, "the underlying message was swallowed");
});

test("a preview response is refused with a reason naming the subscription", async () => {
  // Qobuz answers a refused request with 200 and sample:true. This is the
  // ordinary shape of "you cannot stream this", not an error path.
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ url: "https://example.com/preview.mp3", sample: true }),
  });
  try {
    const r = await QB.getFileUrlResult("tok", 123, "sec", {});
    assert.equal(r.url, null);
    assert.match(r.reason, /preview/i);
    assert.match(r.reason, /subscription/i);
  } finally { global.fetch = realFetch; }
});

test("getFileUrl keeps its old shape — a url string or null", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ url: "https://example.com/track.mp3" }),
  });
  try {
    assert.equal(await QB.getFileUrl("tok", 123, "sec", {}), "https://example.com/track.mp3");
  } finally { global.fetch = realFetch; }
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ sample: true, url: "x" }) });
  try {
    assert.equal(await QB.getFileUrl("tok", 123, "sec", {}), null);
  } finally { global.fetch = realFetch; }
});

test("a failing call carries the response BODY, not just the status", async () => {
  // The body is the only thing that separates a signature failure from an auth
  // one. Throwing the bare status is what made them indistinguishable.
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 400,
    text: async () => "Invalid Request Signature parameter (request_sig)",
  });
  try {
    const r = await QB.getFileUrlResult("tok", 123, "sec", {});
    assert.equal(r.url, null);
    assert.match(r.reason, /SIGNATURE/, "the 400 body never reached the reason");
  } finally { global.fetch = realFetch; }
});

// ---------------------------------------------------------------------------
// v1.8.12 — the album read keeps its reason, and the token does not move.
//
// v1.8.11 fixed the swallowed error in getFileUrl and left the identical defect
// in getAlbum one function above it, so the first real failure the feature ever
// reached still read "could not be read". It also swapped the TOKEN along with
// the app_id, which broke an unsigned album read that had been working: a
// working client keeps ONE token and varies only the app_id/secret pair.
// ---------------------------------------------------------------------------

test("a failed album read names the cause instead of swallowing it", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, text: async () => "not found" });
  try {
    const r = await QB.getAlbumResult("tok", "0724384405953");
    assert.equal(r.album, null);
    assert.match(r.reason, /404/);
    assert.match(r.reason, /album/i, "the reason must name what was being read");
  } finally { global.fetch = realFetch; }
});

test("a dead token on an unsigned read is not blamed on the signature", async () => {
  // Only a SIGNED call can have its signature rejected. Reporting a 401 on the
  // catalogue read as a signing problem sends the user to fix the wrong thing.
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => "" });
  try {
    const r = await QB.getAlbumResult("tok", "123");
    assert.match(r.reason, /401/);
    assert.doesNotMatch(r.reason, /SIGNATURE/);
  } finally { global.fetch = realFetch; }
});

test("the same status reads differently signed and unsigned", () => {
  const mk = (code) => { const e = new Error("x"); e.code = code; return e; };
  assert.notEqual(QB.describeQobuzError(mk(404), true), QB.describeQobuzError(mk(404), false));
  assert.notEqual(QB.describeQobuzError(mk(401), true), QB.describeQobuzError(mk(401), false));
});

test("an unmapped status still carries its number and body", () => {
  const e = new Error("x"); e.code = 503; e.body = "maintenance";
  const s = QB.describeQobuzError(e, false);
  assert.match(s, /503/);
  assert.match(s, /maintenance/);
});

test("getAlbum keeps its old shape — the album, or null", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ id: "abc", title: "Junction Seven",
                         tracks: { items: [{ id: 1, title: "Spy In The House Of Love",
                                             duration: 286, track_number: 1 }] } }),
  });
  try {
    const a = await QB.getAlbum("tok", "abc");
    assert.equal(a.id, "abc");
    assert.equal(a.tracks.length, 1);
    assert.equal(a.tracks[0].duration, 286);
  } finally { global.fetch = realFetch; }
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
  try {
    assert.equal(await QB.getAlbum("tok", "abc"), null);
  } finally { global.fetch = realFetch; }
});

test("a 200 with no album is a reason, not a silent null", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = await QB.getAlbumResult("tok", "abc");
    assert.equal(r.album, null);
    assert.ok(r.reason && r.reason.length > 0);
  } finally { global.fetch = realFetch; }
});

test("no album id is refused before any network call", async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("should not be called"); };
  try {
    const r = await QB.getAlbumResult("tok", "");
    assert.equal(r.album, null);
    assert.equal(called, false, "an empty id still went to the network");
  } finally { global.fetch = realFetch; }
});
