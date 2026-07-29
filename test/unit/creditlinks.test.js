"use strict";
// ---------------------------------------------------------------------------
// creditLinks — the now-playing screen's artist links.
//
// The album view splits an album credit into per-artist links using the
// library-validated splitter. v1.6.60 gives the now-playing screen the same
// control, but its credit is a DIFFERENT string: Roon's line2 is the TRACK
// artist, not the album credit. Two consequences this file pins:
//
//   1. The split itself must stay the validated one — AC/DC must not become
//      two links just because it is now being applied to a track credit.
//   2. Each name must be flagged with whether the library can actually open a
//      screen for it. On a compilation most track artists have no album of
//      their own, and /api/artist-albums would answer with an empty list — a
//      link to nowhere. The album view never needed this because an album
//      credit always belongs to at least the album it came from.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// Build a harness whose "library" is the given list of album credits.
function harness(credits) {
  const albums = (credits || []).map((subtitle, i) => ({
    offset: i, title: "Album " + i, subtitle,
  }));
  const albumIndex = { albums, builtAt: 1, count: albums.length };

  const F = loadIndexFunctions(
    ["creditLinks", "linkableArtistSet", "splitCreditIntoArtists",
     "creditIdentities", "applyCreditIdentities", "knownArtistSet",
     "canonArtist", "canonText", "normalize"],
    {
      albumIndex,
      // Module-level caches these functions close over. loadIndexFunctions only
      // extracts `function` declarations, so the consts have to be supplied —
      // fresh per harness, so one test's memo can never answer another's.
      _creditLinkCache: new Map(),
      CREDIT_LINK_CACHE_MAX: 300,
      _linkableArtistCache: { builtAt: -1, set: new Set() },
      _knownArtistCache: { builtAt: -1, set: new Set() },
    }
  );
  // knownArtistSet reads al.nArtist, which indexRecord would have set.
  for (const al of albums) al.nArtist = F.normalize(al.subtitle);
  return F;
}

const names = (list) => list.map(x => x.name);
const linkable = (list) => list.filter(x => x.linkable).map(x => x.name);

test("creditLinks keeps the library-validated split", async (t) => {
  await t.test("AC/DC is one artist, not two", () => {
    const F = harness(["AC/DC", "Pink Floyd"]);
    assert.deepEqual(names(F.creditLinks("AC/DC")), ["AC/DC"]);
  });

  await t.test("a spaced slash always splits", () => {
    const F = harness(["Miles Davis", "John Coltrane"]);
    assert.deepEqual(names(F.creditLinks("Miles Davis / John Coltrane")),
      ["Miles Davis", "John Coltrane"]);
  });

  await t.test("an unspaced slash splits when the library recognises a name", () => {
    const F = harness(["T-Bone Walker", "Big Joe Turner", "Otis Spann"]);
    assert.deepEqual(names(F.creditLinks("T-Bone Walker/Big Joe Turner/Otis Spann")),
      ["T-Bone Walker", "Big Joe Turner", "Otis Spann"]);
  });

  await t.test("'&' splits only on library evidence", () => {
    // No library evidence for the fragments — stays whole.
    const plain = harness(["Earth, Wind & Fire"]);
    assert.deepEqual(names(plain.creditLinks("Earth, Wind & Fire")), ["Earth, Wind & Fire"]);
    // Evidence present — splits.
    const known = harness(["Panda Bear", "Sonic Boom", "Adrian Sherwood"]);
    assert.deepEqual(names(known.creditLinks("Panda Bear, Sonic Boom & Adrian Sherwood")),
      ["Panda Bear", "Sonic Boom", "Adrian Sherwood"]);
  });

  await t.test("featured-artist markers split", () => {
    const F = harness(["Massive Attack", "Tracey Thorn"]);
    assert.deepEqual(names(F.creditLinks("Massive Attack feat. Tracey Thorn")),
      ["Massive Attack", "Tracey Thorn"]);
  });
});

test("creditLinks flags which names the library can actually open", async (t) => {
  await t.test("an artist with an album of their own is linkable", () => {
    const F = harness(["Pink Floyd"]);
    assert.deepEqual(linkable(F.creditLinks("Pink Floyd")), ["Pink Floyd"]);
  });

  await t.test("an artist the library has never seen is NOT linkable", () => {
    // THE compilation case: the track artist appears nowhere in the library, so
    // /api/artist-albums would return an empty list. Render it as text.
    const F = harness(["Pink Floyd"]);
    const out = F.creditLinks("Some Session Player");
    assert.deepEqual(names(out), ["Some Session Player"]);
    assert.deepEqual(linkable(out), [],
      "a track artist with no albums was offered as a link — tapping it opens " +
      "an empty artist screen");
  });

  await t.test("a mixed credit links only the names that resolve", () => {
    const F = harness(["Miles Davis"]);
    const out = F.creditLinks("Miles Davis / Nobody At All");
    assert.deepEqual(names(out), ["Miles Davis", "Nobody At All"]);
    assert.deepEqual(linkable(out), ["Miles Davis"]);
  });

  await t.test("an artist credited only as part of a larger credit still links", () => {
    // "Prince" plays a track from an album credited "Prince & The Revolution".
    // creditIdentities puts both on the album, so the artist screen HAS a page
    // for Prince — the flag must reflect that, not just whole-credit equality.
    const F = harness(["Prince & The Revolution", "Prince"]);
    assert.deepEqual(linkable(F.creditLinks("Prince")), ["Prince"]);
  });

  await t.test("matching is whole-name, never substring", () => {
    // The v1.6.56 rule. "Prince" must not be made linkable by the presence of
    // 'Bonnie "Prince" Billy', and vice versa.
    const F = harness(['Bonnie "Prince" Billy', "Jordan Prince"]);
    assert.deepEqual(linkable(F.creditLinks("Prince")), [],
      "a substring match made a dead name look linkable");
  });

  await t.test("leading 'The' is tolerated, as it is everywhere else", () => {
    // canonArtist strips a leading "the", so Roon saying "Beatles" and the
    // library saying "The Beatles" must still resolve.
    const F = harness(["The Beatles"]);
    assert.deepEqual(linkable(F.creditLinks("Beatles")), ["Beatles"]);
  });
});

test("creditLinks degrades safely", async (t) => {
  await t.test("an empty credit yields no links at all", () => {
    const F = harness(["Pink Floyd"]);
    assert.deepEqual(F.creditLinks(""), []);
    assert.deepEqual(F.creditLinks(null), []);
    assert.deepEqual(F.creditLinks("   "), []);
  });

  await t.test("with no library yet, the raw credit shows as plain text", () => {
    // Before the first scan there is nothing to validate against. The name must
    // still be displayed — just not offered as a link that cannot work.
    const F = harness([]);
    const out = F.creditLinks("Miles Davis / John Coltrane");
    assert.deepEqual(names(out), ["Miles Davis / John Coltrane"],
      "an unbuilt library must not be split on guesswork");
    assert.deepEqual(linkable(out), []);
  });

  await t.test("repeated calls are stable (the response is polled every 1.5s)", () => {
    const F = harness(["Miles Davis", "John Coltrane"]);
    const a = F.creditLinks("Miles Davis / John Coltrane");
    const b = F.creditLinks("Miles Davis / John Coltrane");
    assert.deepEqual(a, b);
    assert.equal(a, b, "the memo returned a fresh array — the cache is not being hit");
  });

  await t.test("a duplicated name yields one link, not two", () => {
    const F = harness(["Miles Davis"]);
    assert.deepEqual(names(F.creditLinks("Miles Davis / Miles Davis")), ["Miles Davis"]);
  });
});
