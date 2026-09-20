"use strict";
// ---------------------------------------------------------------------------
// v1.8.31: what the share card is actually given.
//
// The card fetched a release year, a label, a description and a Pitchfork
// score on every open — and drew the first of them. `render()` read
// coverUrl, wordmarkUrl, releaseRaw, title and artist, and nothing else; the
// other three were computed (the description trimmed to ten sentences) and
// dropped on the floor. Nobody noticed because a card with no description
// looks exactly like a card for a record that has none.
//
// The contrast maths lives in test/static/sharecard.test.js, which reads the
// literals out of the drawing routine. What that CANNOT see is whether the
// values ever arrive, so this stubs the renderer and reads its argument. A
// canvas assertion could not tell "no description was sent" from "no
// description exists" either.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

function extras(album) {
  return { year: 1977, album, artist: null, links: { services: [], reviews: [] } };
}

const PITCHFORK = extras({
  description: null,                       // the server nulls Pitchfork prose
  year: 1977, label: "RCA",
  url: "https://pitchfork.com/reviews/albums/bowie-low/",
  source: "Pitchfork", score: 9.6, isBestNewMusic: true,
});

const WIKIPEDIA = extras({
  description: "Low is the eleventh studio album by David Bowie.",
  year: 1977, label: "RCA Victor",
  url: "https://en.wikipedia.org/wiki/Low_(David_Bowie_album)",
  source: "Wikipedia", score: null, isBestNewMusic: false,
});

function stubFor(payload) {
  return `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u) {
  if (u.indexOf("/api/album/extras") > -1) return window.__json(${JSON.stringify(payload)});
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

// The renderer is replaced with one that records its argument and hands back a
// one-pixel PNG, so nothing here depends on canvas, fonts or image decoding.
const DRIVER = `
  await window.__sleep(600);
  window.__rendered = null;
  // The METHOD is replaced, not the object. ShareCard is a script-scope const
  // (public/sharecard.js), so it is not a property of window and assigning
  // window.ShareCard just creates an unrelated one that app.js never reads —
  // which is what the first version of this test did, and it failed with "the
  // renderer was never called" rather than with a wrong value.
  ShareCard.render = function (data) {
    window.__rendered = data;
    return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  };
  window.__openShareCard({ title: "Low", artist: "David Bowie", image_key: "k0" });
  for (var w = 0; w < 60 && !window.__rendered; w++) await window.__sleep(100);
  var d = window.__rendered || {};
  T("got", !!window.__rendered);
  T("data", {
    title: d.title, artist: d.artist,
    releaseRaw: String(d.releaseRaw == null ? "" : d.releaseRaw),
    label: d.label || "",
    review: d.review || "",
    score: d.score === undefined ? "undefined" : d.score,
    bestNewMusic: d.bestNewMusic === undefined ? "undefined" : !!d.bestNewMusic,
  });
`;

function run(payload) {
  const r = harness.renderPage({ stub: stubFor(payload), driver: DRIVER,
                                 name: "share-card-data", windowSize: "390x844" });
  harness.assertNoPageError(assert, r);
  assert.equal(r.got, true, "the share card never called the renderer");
  return r.data;
}

test("the share card is given everything it fetched", { concurrency: 1 }, async (t) => {
  await t.test("a Pitchfork album: the score and the flag, never the prose", () => {
    const d = run(PITCHFORK);
    assert.equal(d.title, "Low");
    assert.equal(d.artist, "David Bowie");
    assert.equal(d.releaseRaw, "1977");
    assert.equal(d.label, "RCA", "the label was fetched and then dropped on the floor");
    assert.equal(d.score, 9.6,
      "the Pitchfork score never reached the renderer (got " + d.score + ")");
    assert.equal(d.bestNewMusic, true, "the Best New Music flag never reached the renderer");
    // The compliance rule, from the other end: index.js nulls Pitchfork's text
    // before it leaves the server, so there is nothing to draw and the card
    // must not invent any.
    assert.equal(d.review, "", "Pitchfork prose must never reach the card");
  });

  await t.test("a Wikipedia album: the description, and no score", () => {
    const d = run(WIKIPEDIA);
    assert.equal(d.review, "Low is the eleventh studio album by David Bowie.",
      "the description was fetched, trimmed, and then not passed to the renderer");
    assert.equal(d.label, "RCA Victor");
    assert.equal(d.score, null, "a score appeared for an album that has none");
    assert.equal(d.bestNewMusic, false);
  });
});
