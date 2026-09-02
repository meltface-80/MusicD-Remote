"use strict";
// ---------------------------------------------------------------------------
// withSource — which badge (local / qobuz / tidal / none) an album gets.
//
// v1.6.55 was an entire release spent closing wrong-badge paths. The rules the
// badge depends on:
//
//   * local wins over a streaming match — the files are what actually plays;
//   * an album favourited in BOTH services is unknowable — no badge beats a
//     coin flip;
//   * an identity held by more than one library album is ambiguous — no badge;
//   * a title that canonicalises to "" produces no keys at all, so it can
//     never collide with an unrelated album.
//
// "No badge" is always the safe answer. Every assertion below that expects
// null is asserting that the code declines to guess.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// A fresh, fully-isolated key space per test.
function fixture() {
  const localAlbumKeys = new Set();
  const qobuzAlbumKeys = new Set();
  const tidalAlbumKeys = new Set();
  const ambiguousAlbumKeys = new Set();
  const F = loadIndexFunctions(
    ["normalize", "canonText", "canonArtist", "albumKey", "albumKeys", "albumTitleVariants",
     "addFavouriteKeys", "withSource", "albumSource", "sourceBadgesDistinguish",
     "claimingServices", "unclaimedIsLocal",
     // v1.8.4: the rung albumSource falls to when Roon supplies no artist and
     // nothing can key. Extracted rather than stubbed, so these tests see the
     // real rule about when it is allowed to speak.
     "titleOnlySource",
     // withSource now attaches the quality badge too, so its helpers come with
     // it — extracted rather than stubbed, so a change to what a badge SAYS is
     // visible to the tests that assert badges.
     "albumFileFacts", "albumQualityLabel", "albumIsHiRes", "rateShort"],
    { localAlbumKeys, qobuzAlbumKeys, tidalAlbumKeys, ambiguousAlbumKeys,
      albumFileCache: new Map(),
      // titleOnlySource matches by title half against the same key sets.
      AK: require("../../lib/albumkeys"),
      // A CONNECTED Qobuz with at least one favourite. Every assertion in this
      // file is about identifying a source from POSITIVE evidence, and since
      // v1.7.34 that logic only runs while a service is connected — with none
      // connected, an unclaimed album is local by elimination and there is
      // nothing left to get wrong. sourcederive.test.js covers that half.
      qobuzToken: "connected", qobuzUsername: "", qobuzPasswordMd5: "",
      tidalRefreshToken: "" }
  );
  qobuzAlbumKeys.add("__a_connected_service_has_at_least_one_favourite__");
  return {
    ...F,
    localAlbumKeys, qobuzAlbumKeys, tidalAlbumKeys, ambiguousAlbumKeys,
    // Convenience: badge of a Roon-shaped album record.
    badge: (title, subtitle, rec) => F.withSource({ title, subtitle }, rec).source,
  };
}

test("withSource — precedence", async (t) => {
  await t.test("local beats a streaming match", () => {
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Kind of Blue", "Miles Davis"));
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Kind of Blue", null, ["Miles Davis"]);
    assert.equal(f.badge("Kind of Blue", "Miles Davis"), "local");
  });

  await t.test("a Qobuz-only favourite badges qobuz", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Rumours", null, ["Fleetwood Mac"]);
    assert.equal(f.badge("Rumours", "Fleetwood Mac"), "qobuz");
  });

  await t.test("a TIDAL-only favourite badges tidal", () => {
    const f = fixture();
    f.addFavouriteKeys(f.tidalAlbumKeys, "Rumours", null, ["Fleetwood Mac"]);
    assert.equal(f.badge("Rumours", "Fleetwood Mac"), "tidal");
  });

  await t.test("favourited in BOTH services yields no badge, not a coin flip", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Random Access Memories", null, ["Daft Punk"]);
    f.addFavouriteKeys(f.tidalAlbumKeys, "Random Access Memories", null, ["Daft Punk"]);
    assert.equal(f.badge("Random Access Memories", "Daft Punk"), null);
  });

  await t.test("an album in neither the library nor any service is unbadged", () => {
    const f = fixture();
    assert.equal(f.badge("Nothing Here", "Nobody"), null);
  });
});

test("withSource — ambiguity suppression", async (t) => {
  await t.test("an identity shared by two library albums is suppressed", () => {
    const f = fixture();
    f.ambiguousAlbumKeys.add(f.albumKey("Greatest Hits", "Queen"));
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Greatest Hits", null, ["Queen"]);
    assert.equal(f.badge("Greatest Hits", "Queen"), null);
  });

  await t.test("ambiguity outranks even a local match", () => {
    const f = fixture();
    const k = f.albumKey("Greatest Hits", "Queen");
    f.ambiguousAlbumKeys.add(k);
    f.localAlbumKeys.add(k);
    assert.equal(f.badge("Greatest Hits", "Queen"), null);
  });

  await t.test("an ambiguous key is skipped, not fatal — later keys still count", () => {
    const f = fixture();
    // Whole-credit identity is ambiguous, but the per-artist identity is not.
    f.ambiguousAlbumKeys.add(f.albumKey("Session", "Alpha Band & Beta Band"));
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Session", null, ["Beta Band"]);
    assert.equal(f.badge("Session", "Alpha Band & Beta Band"), "qobuz");
  });
});

test("withSource — multi-artist credits", async (t) => {
  await t.test("matches when Roon credits everyone and the service credits one", () => {
    // The 100%-miss case: Qobuz stores only the primary artist.
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Super Black Blues", null, ["T-Bone Walker"]);
    assert.equal(
      f.badge("Super Black Blues", "T-Bone Walker/Big Joe Turner/Otis Spann"),
      "qobuz"
    );
  });

  await t.test("the TITLE must still match — a shared artist alone is not enough", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Some Other Album", null, ["T-Bone Walker"]);
    assert.equal(f.badge("Super Black Blues", "T-Bone Walker/Otis Spann"), null);
  });

  await t.test("same title, different artist, gets no badge", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Greatest Hits", null, ["Queen"]);
    assert.equal(f.badge("Greatest Hits", "ABBA"), null);
  });
});

test("withSource — tolerant matching", async (t) => {
  await t.test("'&' in the library vs 'and' in the service still matches", () => {
    const f = fixture();
    f.addFavouriteKeys(f.tidalAlbumKeys, "That's The Way Of The World", null,
      ["Earth, Wind and Fire"]);
    assert.equal(f.badge("That's the Way of the World", "Earth, Wind & Fire"), "tidal");
  });

  await t.test("a leading 'The' on either side is not a mismatch", () => {
    const f = fixture();
    f.addFavouriteKeys(f.tidalAlbumKeys, "Dark Side of the Moon", null, ["Pink Floyd"]);
    assert.equal(f.badge("Dark Side of the Moon", "The Pink Floyd"), "tidal");
  });

  await t.test("Roon's baked-in edition matches the service's version field", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Rumours", "Deluxe Edition", ["Fleetwood Mac"]);
    assert.equal(f.badge("Rumours (Deluxe Edition)", "Fleetwood Mac"), "qobuz");
    assert.equal(f.badge("Rumours", "Fleetwood Mac"), "qobuz");
  });
});

test("withSource — the empty-key hazard", async (t) => {
  await t.test("a symbol-only title can never be badged", () => {
    // If albumKey() ever returns "||artist" again, one such album would badge
    // every other symbol-titled album. Guarded from both directions.
    const f = fixture();
    f.localAlbumKeys.add("||ed sheeran");
    f.localAlbumKeys.add("||");
    assert.equal(f.badge("÷", "Ed Sheeran"), null);
    assert.equal(f.badge("!!!", "Anyone At All"), null);
  });

  await t.test("two unrelated CJK titles do not badge each other", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "坂本龍一", null, ["坂本龍一"]);
    assert.equal(f.badge("久石譲", "久石譲"), null);
  });
});

test("withSource — record shape and precomputed keys", async (t) => {
  await t.test("uses rec.srcKeys when the index already computed them", () => {
    // The hot list paths pass the index record so no string work happens here.
    const f = fixture();
    f.qobuzAlbumKeys.add("precomputed||key");
    assert.equal(f.badge("Unrelated Title", "Unrelated Artist",
      { srcKeys: ["precomputed||key"] }), "qobuz");
  });

  await t.test("falls back to computing keys when rec has none", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Rumours", null, ["Fleetwood Mac"]);
    assert.equal(f.badge("Rumours", "Fleetwood Mac", {}), "qobuz");
    assert.equal(f.badge("Rumours", "Fleetwood Mac", null), "qobuz");
    assert.equal(f.badge("Rumours", "Fleetwood Mac", undefined), "qobuz");
  });

  await t.test("mutates and returns the SAME album object", () => {
    // Callers rely on this being in-place; returning a copy would silently
    // drop the badge on every list path.
    const f = fixture();
    const album = { title: "Rumours", subtitle: "Fleetwood Mac" };
    assert.equal(f.withSource(album), album);
    assert.equal(album.source, null);
  });

  await t.test("always sets .source explicitly, never leaves it undefined", () => {
    const f = fixture();
    const album = { title: "Nothing", subtitle: "Nobody", source: "stale" };
    f.withSource(album);
    assert.equal(album.source, null, "a stale badge must be cleared, not kept");
  });
});

test("withSource — dual-service short-circuit (pinned behaviour)", async (t) => {
  await t.test("a both-services hit stops the scan before later keys", () => {
    // OBSERVATION, pinned so a change is deliberate: the "favourited in both"
    // branch `break`s out of the key loop, so a local match on a LATER
    // (per-artist) key is never reached. The outcome is a missing badge, not a
    // wrong one — the conservative direction — but it does mean "local wins"
    // is not absolute. See test/README.md.
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Dual", null, ["Alpha Band"]);
    f.addFavouriteKeys(f.tidalAlbumKeys, "Dual", null, ["Alpha Band"]);
    f.localAlbumKeys.add(f.albumKey("Dual", "Alpha"));
    assert.equal(f.badge("Dual", "Alpha Band"), null);
  });
});

test("withSource — the title-only rung (v1.8.4)", async (t) => {
  // Roon sends three_line.line2 as "" for a real share of a library, which
  // makes every key "<title>||" and matches nothing: no badge, no local file,
  // no waveform, for albums plainly sitting in /music. This rung answers from
  // the title alone — but only where that cannot mislead.

  await t.test("THE one: no artist, and the title is in one place", () => {
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Blind Man's Zoo", "10,000 Maniacs"));
    // Roon named the album and gave us nothing else.
    assert.equal(f.badge("Blind Man's Zoo", ""), "local",
      "an album we can see in /music went unbadged because Roon named no artist");
  });

  await t.test("a streaming-only album is found the same way", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Truth Rising", null, ["Hed P.E."]);
    assert.equal(f.badge("Truth Rising", ""), "qobuz");
  });

  await t.test("THE guard: with a usable artist, a miss stays a miss", () => {
    // The rung exists because a blank artist makes keying impossible. Where the
    // artist IS usable, "we do not have this album" is a real answer and must
    // not be second-guessed by a looser match — otherwise every unmatched album
    // starts collecting badges from same-titled records by other artists.
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Greatest Hits", "ABBA"));
    assert.equal(f.badge("Greatest Hits", "Queen"), null,
      "Queen's album was badged from ABBA's, because the title happened to match");
  });

  await t.test("the same title in two places is still no badge", () => {
    // Owned AND favourited. The keyed path already refuses to guess here; the
    // looser rung must not become a way around that.
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Blind Man's Zoo", "10,000 Maniacs"));
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Blind Man's Zoo", null, ["10,000 Maniacs"]);
    assert.equal(f.badge("Blind Man's Zoo", ""), "local",
      "local wins when it is one of the places — the files are what plays");
  });

  await t.test("favourited in both services stays unknowable", () => {
    const f = fixture();
    f.addFavouriteKeys(f.qobuzAlbumKeys, "Analogue", null, ["a-ha"]);
    f.addFavouriteKeys(f.tidalAlbumKeys, "Analogue", null, ["a-ha"]);
    assert.equal(f.badge("Analogue", ""), null,
      "a coin flip between two services is not an answer, keyed or not");
  });

  await t.test("several artist spellings of ONE album is one place, not two", () => {
    // The /music walk files a folder under its album-artist AND its track-artist
    // tag on purpose, so two keys for one album is the ordinary case.
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Blind Man's Zoo", "10,000 Maniacs"));
    f.localAlbumKeys.add(f.albumKey("Blind Man's Zoo", "10"));
    assert.equal(f.badge("Blind Man's Zoo", ""), "local");
  });

  await t.test("no artist and no match anywhere invents nothing", () => {
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Something Else", "Someone"));
    assert.equal(f.badge("Never Heard Of It", ""), null);
  });

  await t.test("no artist and no title is not a wildcard", () => {
    // "" canonicalises to no keys at all; it must not sweep up every album.
    const f = fixture();
    f.localAlbumKeys.add(f.albumKey("Blind Man's Zoo", "10,000 Maniacs"));
    assert.equal(f.badge("", ""), null);
    assert.equal(f.badge("!!!", ""), null, "a symbol-only title keys to nothing");
  });
});
