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
