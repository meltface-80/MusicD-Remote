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
     "claimingServices", "unclaimedIsLocal"],
    { localAlbumKeys, qobuzAlbumKeys, tidalAlbumKeys, ambiguousAlbumKeys,
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
