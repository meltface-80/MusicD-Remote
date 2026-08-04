"use strict";
// ---------------------------------------------------------------------------
// v1.7.34: locality by elimination.
//
// The Source facet used to be answered only one way — prove each album is local
// by matching a file tag against Roon's album title. That join is lossy by
// construction, because Roon REPLACES file tags with its own metadata for every
// album it identifies, so the two sides legitimately disagree about the name.
// On an entirely local 2,234-album library it left 281 albums uncounted, and no
// amount of matching work closes a gap whose cause is that both sides are
// right.
//
// Roon's library is local files plus streaming albums you have added, and
// adding a streaming album favourites it in the service. So when no service is
// connected there is nothing else an album can be, and locality does not need
// proving album-by-album at all — it follows.
//
// The dangerous half is knowing when NOT to reason that way: with a service
// connected, an unclaimed album could be local or could be from a service that
// isn't connected here. And a connected service whose favourites failed to load
// knows nothing, so its silence must not be read as "claims nothing".
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

function build(opts) {
  opts = opts || {};
  return loadIndexFunctions(
    ["withSource", "albumSource", "sourceBadgesDistinguish",
     "claimingServices", "unclaimedIsLocal", "albumKeys",
     "albumTitleVariants", "canonText", "canonArtist", "normalize"],
    {
      localAlbumKeys:  new Set(opts.local || []),
      qobuzAlbumKeys:  new Set(opts.qobuz || []),
      tidalAlbumKeys:  new Set(opts.tidal || []),
      ambiguousAlbumKeys: new Set(opts.ambiguous || []),
      qobuzToken:       opts.qobuzToken || "",
      qobuzUsername:    opts.qobuzUsername || "",
      qobuzPasswordMd5: opts.qobuzPasswordMd5 || "",
      tidalRefreshToken: opts.tidalRefreshToken || "",
    });
}

const album = (title, artist) => ({ title, subtitle: artist });

test("with no streaming service connected, everything is local", async (t) => {
  await t.test("an album with no file evidence at all is still local", () => {
    // THE case. Roon calls it "Rumours (Deluxe Edition)", the file says
    // "Rumours", the join misses — and it is local anyway, because nothing
    // else could have put it in the library.
    const F = build();
    assert.equal(F.unclaimedIsLocal(), true);
    assert.equal(F.albumSource("Anything At All", "Someone"), "local");
  });

  await t.test("file evidence still wins where it exists", () => {
    const F = build({ local: ["goo||sonic youth"] });
    assert.equal(F.albumSource("Goo", "Sonic Youth"), "local");
  });

  await t.test("an ambiguous identity is local too, rather than unknown", () => {
    // Ambiguity suppression exists to stop a BADGE being a coin flip between
    // two albums. When nothing else can claim either of them, both are local
    // and refusing to say so just under-counts.
    const F = build({ ambiguous: ["reunion||band one"] });
    assert.equal(F.albumSource("Reunion", "Band One"), "local");
  });
});

// v1.7.35. Elimination is what makes the Local COUNT right, and it is also what
// made every tile in the library carry the same badge — because with nothing
// else in play, every album really is local. A badge on everything is not a
// fact about an album, so the badge and the count were split apart: the count
// still says 2,234, and the tiles say nothing.
test("a badge that would be on every album is not drawn", async (t) => {
  await t.test("no service connected: the truth is local, the badge is nothing", () => {
    const F = build();
    assert.equal(F.sourceBadgesDistinguish(), false);
    assert.equal(F.albumSource("Goo", "Sonic Youth"), "local",
      "Focus still counts it — that number is the whole point");
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, null,
      "but no tile carries a badge every other tile also carries");
  });

  await t.test("proved-local albums are suppressed too, not just derived ones", () => {
    // The suppression is about whether the badge DISTINGUISHES, not about how
    // confident we are in any one album. With one source in the library, even a
    // file-tag match tells the user nothing they can act on.
    const F = build({ local: ["goo||sonic youth"] });
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, null);
  });

  await t.test("connect a service and the badges come back", () => {
    const F = build({ qobuzToken: "t", qobuz: ["goo||sonic youth"] });
    assert.equal(F.sourceBadgesDistinguish(), true);
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, "qobuz");
  });
});

test("with a service connected, elimination is switched off", async (t) => {
  await t.test("an unclaimed album stays unknown, not local", () => {
    // It could be local, or from a service the user has NOT connected here.
    // Guessing would badge someone's TIDAL album as a local file.
    const F = build({ qobuzToken: "t", qobuz: ["something||else"] });
    assert.equal(F.unclaimedIsLocal(), false);
    assert.equal(F.withSource(album("Unknown Album", "Someone")).source, null);
  });

  await t.test("the service's own albums are still identified", () => {
    const F = build({ qobuzToken: "t", qobuz: ["goo||sonic youth"] });
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, "qobuz");
  });

  await t.test("file evidence still wins", () => {
    const F = build({ qobuzToken: "t", qobuz: ["x||y"], local: ["goo||sonic youth"] });
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, "local");
  });
});

test("a connected service that told us nothing does not count as claiming", async (t) => {
  await t.test("credentials without favourites is silence, not an answer", () => {
    // A failed or not-yet-run favourites fetch leaves the key set empty.
    // Treating that as "this service claims nothing" would call every one of
    // its albums local — confidently, and wrongly.
    const F = build({ qobuzToken: "t", qobuz: [] });
    assert.deepEqual(F.claimingServices(), []);
    assert.equal(F.unclaimedIsLocal(), true,
      "with no usable streaming evidence the library is local by elimination");
  });

  await t.test("a stored login counts the same as a live token", () => {
    // qobuzToken expires and is re-fetched from the saved credentials, so the
    // saved pair is just as much "connected" as a token in hand.
    const F = build({ qobuzUsername: "a@b.c", qobuzPasswordMd5: "x", qobuz: ["k"] });
    assert.deepEqual(F.claimingServices(), ["qobuz"]);
  });

  await t.test("both services are reported when both are live", () => {
    const F = build({ qobuzToken: "t", qobuz: ["a"], tidalRefreshToken: "r", tidal: ["b"] });
    assert.deepEqual(F.claimingServices(), ["qobuz", "tidal"]);
    assert.equal(F.unclaimedIsLocal(), false);
  });
});
