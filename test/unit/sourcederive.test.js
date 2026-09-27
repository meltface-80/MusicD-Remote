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
     // v1.8.51: the one definition of "is Qobuz connected", extracted for real
     // — see the note in source.test.js.
     "qobuzReady", "tidalReady",
     "albumTitleVariants", "canonText", "canonArtist", "normalize",
     // v1.8.4: the rung albumSource falls to when nothing can key. It must not
     // change the elimination rules these tests pin, so it is extracted for
     // real rather than stubbed out.
     "titleOnlySource",
     "albumFileFacts", "albumQualityLabel", "albumIsHiRes", "rateShort",
     // v1.8.61: whether ROON is signed in to a service, from its browse root.
     "roonHasService", "roonClaimSets"],
    {
      AK: require("../../lib/albumkeys"),
      NO_CLAIMS: new Set(),
      // null = never read, which keeps the behaviour before it existed.
      roonServices: opts.roonServices === undefined ? null : opts.roonServices,
      albumFileCache:  new Map(opts.files || []),
      localAlbumKeys:  new Set(opts.local || []),
      qobuzAlbumKeys:  new Set(opts.qobuz || []),
      tidalAlbumKeys:  new Set(opts.tidal || []),
      ambiguousAlbumKeys: new Set(opts.ambiguous || []),
      qobuzToken:       opts.qobuzToken || "",
      qobuzUsername:    opts.qobuzUsername || "",
      qobuzPasswordMd5: opts.qobuzPasswordMd5 || "",
      // The browser sign-in. Since v1.8.20 this is the ONLY Qobuz credential a
      // new install can obtain, so it is the default shape, not an exotic one.
      qobuzWaveToken:   opts.qobuzWaveToken || "",
      tidalRefreshToken: opts.tidalRefreshToken || "",
      tidalUserId:      opts.tidalUserId || "",
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
    const F = build({ qobuzToken: "t", qobuz: ["a"], tidalRefreshToken: "r",
                      tidalUserId: "u", tidal: ["b"] });
    assert.deepEqual(F.claimingServices(), ["qobuz", "tidal"]);
    assert.equal(F.unclaimedIsLocal(), false);
  });

  await t.test("THE v1.8.51 one: the browser sign-in counts on its own", () => {
    // Since v1.8.20 the browser sign-in is the only Qobuz credential the app
    // offers a way to get — `qobuzToken` and the username/password pair are
    // legacy and nothing sets them any more. This gate tested ONLY those, so
    // it was false on every install connected the way the app connects, and
    // Qobuz silently stopped counting as a service that claims anything.
    //
    // Same defect, same line, took the Qobuz favourites read with it — which
    // is what stopped Qobuz waveforms: no favourites, no album ids, nothing to
    // fetch a track list with.
    const F = build({ qobuzWaveToken: "signed-in", qobuz: ["goo||sonic youth"] });
    assert.deepEqual(F.claimingServices(), ["qobuz"],
      "a Qobuz account connected by the browser sign-in is not being counted " +
      "as connected — the legacy-credential gate is back");
    assert.equal(F.unclaimedIsLocal(), false,
      "with Qobuz claiming, an album no service claims can no longer be " +
      "assumed local by elimination");
  });

  await t.test("a TIDAL refresh token with no user id is not connected", () => {
    // claimingServices() used to ask for the refresh token alone while every
    // other site required the user id as well — tidalWithToken cannot make a
    // call without it, so a half-connected account claimed albums it could
    // never have read.
    const F = build({ tidalRefreshToken: "r", tidal: ["a||b"] });
    assert.deepEqual(F.claimingServices(), []);

    const G = build({ tidalRefreshToken: "r", tidalUserId: "u", tidal: ["a||b"] });
    assert.deepEqual(G.claimingServices(), ["tidal"]);
  });

  await t.test("and with no credential at all, Qobuz still claims nothing", () => {
    // The other half: widening the gate must not make a disconnected account
    // count. Without this, the assertion above passes for a broken reason.
    const F = build({ qobuz: ["goo||sonic youth"] });
    assert.deepEqual(F.claimingServices(), []);
    assert.equal(F.unclaimedIsLocal(), true);
  });
});

// ---------------------------------------------------------------------------
// v1.8.61: the extension signed in to a service Roon is NOT signed in to.
//
// Reported: "I don't have Roon logged in to Qobuz but I have within the
// extension. The extension seems to think my local files are from Qobuz."
// Every rule above took "the extension is connected" to mean "Roon is", and a
// Roon without Qobuz can only be playing local files — so its Qobuz favourites
// say nothing about where Roon's albums come from.
// ---------------------------------------------------------------------------
test("a service Roon itself is not signed in to claims nothing", async (t) => {
  const qobuzOnly = { qobuzWaveToken: "tok", qobuz: ["goo||sonic youth", "rumours||fleetwood mac"] };

  await t.test("THE report: a local album that is also a Qobuz favourite is not badged Q", () => {
    const F = build(Object.assign({}, qobuzOnly, { roonServices: { qobuz: false, tidal: false } }));
    assert.notEqual(F.albumSource("Goo", "Sonic Youth"), "qobuz",
      "a Qobuz favourite was called a Qobuz album on a Roon that is not signed in to Qobuz");
  });

  await t.test("with no service in Roon, everything is local again — elimination holds", () => {
    const F = build(Object.assign({}, qobuzOnly, { roonServices: { qobuz: false, tidal: false } }));
    assert.deepEqual(F.claimingServices(), []);
    assert.equal(F.unclaimedIsLocal(), true);
    assert.equal(F.albumSource("Rumours", "Fleetwood Mac"), "local");
    // ...so the badge is decoration and is not sent, exactly as with no
    // service connected at all.
    assert.equal(F.sourceBadgesDistinguish(), false);
    assert.equal(F.withSource(album("Goo", "Sonic Youth")).source, null);
  });

  await t.test("the title-only rung does not reach for the service either", () => {
    const F = build(Object.assign({}, qobuzOnly, { roonServices: { qobuz: false, tidal: false } }));
    assert.equal(F.albumSource("Goo", ""), "local");
  });

  await t.test("Roon signed in to Qobuz: exactly the behaviour before", () => {
    const F = build(Object.assign({}, qobuzOnly, { roonServices: { qobuz: true, tidal: false } }));
    assert.deepEqual(F.claimingServices(), ["qobuz"]);
    assert.equal(F.albumSource("Goo", "Sonic Youth"), "qobuz");
  });

  await t.test("never read (null): exactly the behaviour before — a failed read takes nothing away", () => {
    const F = build(Object.assign({}, qobuzOnly));
    assert.deepEqual(F.claimingServices(), ["qobuz"]);
    assert.equal(F.albumSource("Goo", "Sonic Youth"), "qobuz");
  });

  await t.test("one service in Roon and another not: only Roon's counts", () => {
    const F = build({ qobuzWaveToken: "tok", tidalRefreshToken: "r", tidalUserId: "u",
                      qobuz: ["goo||sonic youth"], tidal: ["rumours||fleetwood mac"],
                      roonServices: { qobuz: false, tidal: true } });
    assert.deepEqual(F.claimingServices(), ["tidal"]);
    assert.equal(F.albumSource("Rumours", "Fleetwood Mac"), "tidal");
    assert.notEqual(F.albumSource("Goo", "Sonic Youth"), "qobuz");
  });
});

// ---------------------------------------------------------------------------
// v1.8.61 review: the elimination is asked of ROON once Roon's services are
// known. The first cut set aside the claims of a service Roon lacks and then
// still asked the EXTENSION whether anything could claim an album — so with
// the extension on Qobuz and Roon on TIDAL, nothing "could", and every TIDAL
// album was called local.
// ---------------------------------------------------------------------------
test("everything is local only when ROON streams nothing", async (t) => {
  await t.test("THE regression: Roon on TIDAL, the extension on Qobuz only", () => {
    const F = build({ qobuzWaveToken: "tok", qobuz: ["goo||sonic youth"],
                      roonServices: { qobuz: false, tidal: true } });
    assert.equal(F.unclaimedIsLocal(), false,
      "a TIDAL album the extension cannot see into was concluded to be a local file");
    assert.equal(F.albumSource("Some TIDAL Record", "Someone"), null);
    assert.equal(F.sourceBadgesDistinguish(), true, "badges still distinguish local from the rest");
  });

  await t.test("Roon on Qobuz, the extension signed in to nothing: not everything is local", () => {
    // Before Roon was asked, "nothing connected here" meant "everything local"
    // — true only if Roon streamed nothing either.
    const F = build({ roonServices: { qobuz: true, tidal: false } });
    assert.equal(F.unclaimedIsLocal(), false);
    assert.equal(F.albumSource("A Qobuz Record", "Someone"), null);
  });

  await t.test("a service this extension cannot see into at all keeps it honest too", () => {
    const F = build({ roonServices: { qobuz: false, tidal: false, other: true } });
    assert.equal(F.unclaimedIsLocal(), false);
  });

  await t.test("Roon on nothing: every album is local, whatever is signed in here", () => {
    const F = build({ qobuzWaveToken: "tok", tidalRefreshToken: "r", tidalUserId: "u",
                      qobuz: ["goo||sonic youth"], tidal: ["rumours||fleetwood mac"],
                      roonServices: { qobuz: false, tidal: false, other: false } });
    assert.equal(F.unclaimedIsLocal(), true);
    assert.equal(F.albumSource("Rumours", "Fleetwood Mac"), "local");
    assert.equal(F.sourceBadgesDistinguish(), false);
  });
});
