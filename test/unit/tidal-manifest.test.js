"use strict";
// ---------------------------------------------------------------------------
// TIDAL hands back a base64 manifest, not a URL.
//
// Only the plain "BTS" kind carries audio this can read. The higher tiers come
// back as MPEG-DASH in a protected container, and refusing those is the correct
// answer rather than a gap — the track keeps the plain progress bar, which is
// what every other decline in this path also produces.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { streamUrlFrom, BTS_MIME } = require("../../lib/tidal-manifest");

function bts(obj) { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64"); }

test("a BTS manifest yields its first url", () => {
  const r = streamUrlFrom({
    manifestMimeType: BTS_MIME,
    manifest: bts({ codecs: "flac", urls: ["https://audio.tidal.com/a.flac", "https://b"] }),
  });
  assert.equal(r.url, "https://audio.tidal.com/a.flac");
  assert.equal(r.codec, "flac");
});

test("the mime is matched on prefix — TIDAL appends parameters to it", () => {
  const r = streamUrlFrom({
    manifestMimeType: BTS_MIME + "; charset=utf-8",
    manifest: bts({ urls: ["https://x/a.m4a"] }),
  });
  assert.equal(r.url, "https://x/a.m4a", "a charset parameter made a good manifest unreadable");
});

test("a DASH manifest is refused, and says WHY", () => {
  // Not lumped in with "unreadable": an encrypted tier is a different situation
  // from a track that cannot be played, and the user deserves to know which.
  const r = streamUrlFrom({ manifestMimeType: "application/dash+xml", manifest: "PG1wZD4=" });
  assert.equal(r.url, null);
  assert.match(r.reason, /dash/i);
  assert.match(r.reason, /encrypted/i);
});

test("an unknown manifest type is refused rather than guessed at", () => {
  const r = streamUrlFrom({ manifestMimeType: "application/octet-stream", manifest: "AAAA" });
  assert.equal(r.url, null);
  assert.match(r.reason, /octet-stream/);
});

test("a manifest that is not base64 JSON is refused, not thrown on", () => {
  const r = streamUrlFrom({ manifestMimeType: BTS_MIME, manifest: "!!!not base64 json!!!" });
  assert.equal(r.url, null);
  assert.match(r.reason, /could not be read/);
});

test("a BTS manifest with no urls is refused", () => {
  assert.equal(streamUrlFrom({ manifestMimeType: BTS_MIME, manifest: bts({ urls: [] }) }).url, null);
  assert.equal(streamUrlFrom({ manifestMimeType: BTS_MIME, manifest: bts({}) }).url, null);
});

test("non-string entries in urls are skipped, not returned", () => {
  const r = streamUrlFrom({
    manifestMimeType: BTS_MIME,
    manifest: bts({ urls: [null, 42, "", "https://good/a.flac"] }),
  });
  assert.equal(r.url, "https://good/a.flac");
});

test("no manifest, no response, and junk all decline without throwing", () => {
  for (const bad of [null, undefined, {}, { manifestMimeType: BTS_MIME }, "string", 7]) {
    const r = streamUrlFrom(bad);
    assert.equal(r.url, null);
    assert.ok(r.reason && r.reason.length > 0, "every decline must carry a reason");
  }
});

test("a missing mime with a readable BTS body is accepted", () => {
  // TIDAL has been observed omitting the type on some responses; the body is
  // still the thing that decides, and it parses or it does not.
  const r = streamUrlFrom({ manifest: bts({ urls: ["https://x/a.flac"] }) });
  assert.equal(r.url, "https://x/a.flac");
});
