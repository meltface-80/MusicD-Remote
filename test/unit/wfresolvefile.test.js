"use strict";
// ---------------------------------------------------------------------------
// wfResolveFile — which FILE in the album's folder is the playing track.
//
// THE BUG THIS EXISTS FOR (v1.8.54), found in a user's own probe output:
//
//     Roon says     Don't Panic      (U+0027, the typewriter apostrophe)
//     the tag says  Don’t Panic      (U+2019, what nearly every tagger writes)
//
// wfCanon lowercased and collapsed whitespace and did nothing else, so those
// two are not equal — and neither contains the other, so the containment
// fallback missed as well. The track resolved to no file, the waveform never
// appeared, and nothing was logged. Every track whose tag carries a
// typographic apostrophe, in any library, had no local waveform.
//
// The streaming path never had this: TM.canon strips punctuation, so Qobuz and
// TIDAL matched these titles from the day they were written. Two spellings of
// one question, and they had already drifted. There is one now.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// The folder listing wfAlbumFiles would have produced, injected directly: this
// is about title matching, not about reading tags off a disk.
function fixture(titles) {
  const _wfDirCache = new Map([["k", titles.map((t, i) => ({
    file: "/music/Album/" + String(i + 1).padStart(2, "0") + ".flac", title: t,
  }))]]);
  const F = loadIndexFunctions(
    ["wfResolveFile", "wfCanon", "wfAlbumFiles"],
    { _wfDirCache, localAlbumDirs: new Map([["k", "/music/Album"]]),
      TM: require("../../lib/trackmatch"),
      fs: require("node:fs"), path: require("node:path"),
      WF_AUDIO_RE: /\.(flac|mp3|m4a|wav|aiff?|ogg|opus|wv|ape)$/i,
      DEBUG: false, console }
  );
  return F;
}

const PARACHUTES = [
  "Don’t Panic", "Shiver", "Spies", "Sparks", "Yellow", "Trouble",
  "Parachutes", "High Speed", "We Never Change",
  "Everything’s Not Lost / Life Is for Living",
];

test("THE one: a typographic apostrophe in the tag still matches Roon's", async () => {
  const F = fixture(PARACHUTES);
  const hit = await F.wfResolveFile("k", "Don't Panic");
  assert.ok(hit, "\"Don't Panic\" resolved to no file — the apostrophe bug is back");
  assert.match(hit, /01\.flac$/, "it matched the wrong file: " + hit);
});

test("…and the other way round, tag straight and Roon curly", async () => {
  // Neither side is authoritative about which apostrophe it uses.
  const F = fixture(["Don't Panic", "Shiver"]);
  const hit = await F.wfResolveFile("k", "Don’t Panic");
  assert.match(String(hit), /01\.flac$/);
});

test("the hidden-track slash title matches too", async () => {
  // Roon shows one half, the tag carries both around a slash — the containment
  // fallback, which needs the canon to agree before it can even see them.
  const F = fixture(PARACHUTES);
  const hit = await F.wfResolveFile("k", "Everything's Not Lost");
  assert.match(String(hit), /10\.flac$/);
});

test("accents and punctuation generally, not just apostrophes", async () => {
  const F = fixture(["Café Bleu", "Motörhead", "E.T.", "Yeah! Yeah! Yeah!"]);
  assert.match(String(await F.wfResolveFile("k", "Cafe Bleu")),   /01\.flac$/);
  assert.match(String(await F.wfResolveFile("k", "Motorhead")),   /02\.flac$/);
  assert.match(String(await F.wfResolveFile("k", "Yeah Yeah Yeah")), /04\.flac$/);
});

test("a genuinely different track still does not match", async () => {
  // The loosening must not turn into "anything matches anything". This is what
  // stops the fix from being worse than the bug.
  const F = fixture(PARACHUTES);
  assert.equal(await F.wfResolveFile("k", "Clocks"), null);
  assert.equal(await F.wfResolveFile("k", "Viva La Vida"), null);
});

test("two files with the same title decline rather than guess", async () => {
  // `find` took the first and said nothing — a coin flip presented as an
  // answer. TM.matchTrack refuses this on the streaming side for the same
  // reason, and a wrong waveform looks authoritative.
  const F = fixture(["Reprise", "Reprise", "Something Else"]);
  assert.equal(await F.wfResolveFile("k", "Reprise"), null);
  // …and an unambiguous one on the same album is unaffected.
  assert.match(String(await F.wfResolveFile("k", "Something Else")), /03\.flac$/);
});

test("an ambiguous containment match is still refused", async () => {
  // Pre-existing behaviour that must survive the change.
  const F = fixture(["Untitled 1", "Untitled 2"]);
  assert.equal(await F.wfResolveFile("k", "Untitled"), null);
});

test("an empty or punctuation-only title resolves to nothing", async () => {
  // A SINGLE-FILE folder, deliberately. Every string contains "", so with a
  // ten-file fixture the containment fallback finds ten candidates, declines
  // for being ambiguous, and the test passes whether or not the empty-title
  // guard exists at all — which is what it did when first written. With one
  // file the fallback would match it, so only the guard can produce null.
  const one = fixture(["Yellow"]);
  assert.equal(await one.wfResolveFile("k", ""), null,
    "an empty track title matched a file by containing nothing");
  assert.equal(await one.wfResolveFile("k", "!!!"), null,
    "a title that canonicalises to nothing must not match whatever is there");
  assert.equal(await one.wfResolveFile("k", null), null);
  // …and the same folder still resolves a real title, so the guard is not
  // simply refusing everything.
  assert.match(String(await one.wfResolveFile("k", "Yellow")), /01\.flac$/);
});
