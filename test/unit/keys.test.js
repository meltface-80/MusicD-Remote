"use strict";
// ---------------------------------------------------------------------------
// normalize / canonText / canonArtist / albumKey / albumKeys / addFavouriteKeys
//
// This is the key space every source badge is decided in. Getting it wrong is
// what put badges on the wrong albums (v1.6.55): titles that normalise to ""
// collided with each other, and multi-artist credits matched nothing at all.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const F = loadIndexFunctions(
  ["normalize", "canonText", "canonArtist", "albumKey", "albumKeys", "addFavouriteKeys"],
  {}
);
const { normalize, canonText, canonArtist, albumKey, albumKeys, addFavouriteKeys } = F;

test("normalize", async (t) => {
  await t.test("lowercases and collapses punctuation to single spaces", () => {
    assert.equal(normalize("  Hello,   World! "), "hello world");
  });

  await t.test("strips diacritics rather than dropping the letter", () => {
    assert.equal(normalize("Björk"), "bjork");
    assert.equal(normalize("Beyoncé"), "beyonce");
    assert.equal(normalize("Françoise Hardy"), "francoise hardy");
  });

  await t.test("nullish input yields the empty string, never a crash", () => {
    assert.equal(normalize(null), "");
    assert.equal(normalize(undefined), "");
    assert.equal(normalize(""), "");
  });

  await t.test("non-ASCII scripts collapse to empty — the empty-key hazard", () => {
    // This is WHY albumKey() has to reject blank titles. Pinned here so the
    // hazard stays visible if normalize() is ever changed.
    assert.equal(normalize("坂本龍一"), "");
    assert.equal(normalize("÷"), "");
    assert.equal(normalize("!!!"), "");
  });
});

test("canonText drops 'and' so '&' and 'and' spellings converge", async (t) => {
  await t.test("'&' and 'and' produce the same canonical title", () => {
    assert.equal(canonText("Songs of Love & Hate"), canonText("Songs of Love and Hate"));
    assert.equal(canonText("Songs of Love & Hate"), "songs of love hate");
  });

  await t.test("'and' inside a word is untouched", () => {
    assert.equal(canonText("Andromeda"), "andromeda");
  });

  await t.test("empty input yields empty string", () => {
    assert.equal(canonText(null), "");
  });
});

test("canonArtist additionally drops a leading 'the'", async (t) => {
  await t.test("'The Beatles' and 'Beatles' converge", () => {
    assert.equal(canonArtist("The Beatles"), "beatles");
    assert.equal(canonArtist("Beatles"), "beatles");
  });

  await t.test("a word merely starting with 'the' is not truncated", () => {
    // Guards the `startsWith("the ")` space — without it this became
    // "lonious monk".
    assert.equal(canonArtist("Thelonious Monk"), "thelonious monk");
    assert.equal(canonArtist("Therapy"), "therapy");
  });

  await t.test("'The The' collapses to 'the' (pinned current behaviour)", () => {
    // Documented, not endorsed: the leading-"the" strip is unconditional, so
    // this band's identity is the single token "the". Recorded here so any
    // change to the rule is a deliberate, visible decision.
    assert.equal(canonArtist("The The"), "the");
  });
});

test("albumKey", async (t) => {
  await t.test("composes canonical title || canonical artist", () => {
    assert.equal(albumKey("Kind of Blue", "Miles Davis"), "kind of blue||miles davis");
  });

  await t.test("returns null when the title canonicalises to nothing", () => {
    // The v1.6.55 wrong-badge root cause: a key of "||ed sheeran" would have
    // matched every symbol-titled album by that artist, and "||" keys from
    // different artists collided outright.
    assert.equal(albumKey("÷", "Ed Sheeran"), null);
    assert.equal(albumKey("坂本龍一", "坂本龍一"), null);
    assert.equal(albumKey("!!!", "Anyone"), null);
    assert.equal(albumKey("", "Anyone"), null);
  });

  await t.test("a missing artist still yields a usable key", () => {
    assert.equal(albumKey("Rumours", ""), "rumours||");
    assert.equal(albumKey("Rumours", null), "rumours||");
  });

  await t.test("'&' / 'and' and leading 'The' variants land on one key", () => {
    assert.equal(
      albumKey("Songs of Love & Hate", "The Leonard Cohen"),
      albumKey("Songs of Love and Hate", "Leonard Cohen")
    );
  });
});

test("albumKeys — every identity an album could be known by", async (t) => {
  await t.test("offers the whole credit AND each individual artist", () => {
    // Roon credits all performers; Qobuz/TIDAL report only the primary one.
    // Without the per-artist keys this collaboration matched nothing (a 100%
    // miss on every multi-artist album).
    const keys = albumKeys("Super Black Blues", "T-Bone Walker/Big Joe Turner/Otis Spann");
    assert.deepEqual(keys, [
      "super black blues||t bone walker big joe turner otis spann",
      "super black blues||t bone walker",
      "super black blues||big joe turner",
      "super black blues||otis spann",
    ]);
  });

  await t.test("the whole credit is always first, so it wins ties", () => {
    const keys = albumKeys("X", "A & B");
    assert.equal(keys[0], albumKey("X", "A & B"));
  });

  await t.test("splits on every separator the artist links use", () => {
    for (const credit of [
      "Alpha / Beta", "Alpha/Beta", "Alpha feat. Beta", "Alpha featuring Beta",
      "Alpha ft. Beta", "Alpha, Beta", "Alpha & Beta", "Alpha + Beta",
    ]) {
      const keys = albumKeys("Title", credit);
      assert.ok(keys.includes("title||alpha"), `"${credit}" should yield an "alpha" key`);
      assert.ok(keys.includes("title||beta"), `"${credit}" should yield a "beta" key`);
    }
  });

  await t.test("returns [] — never a bare '||' key — for a blank title", () => {
    assert.deepEqual(albumKeys("!!!", "Anyone"), []);
    assert.deepEqual(albumKeys("", "Anyone"), []);
    assert.deepEqual(albumKeys(null, "Anyone"), []);
  });

  await t.test("deduplicates repeated names in a badly-tagged credit", () => {
    // "Artist/Artist" offers three identities (whole credit + two fragments)
    // but only two are distinct — the repeated fragment must collapse, not
    // appear twice.
    const keys = albumKeys("Title", "Artist/Artist");
    assert.equal(new Set(keys).size, keys.length, "keys must be unique");
    assert.deepEqual(keys, ["title||artist artist", "title||artist"]);
  });

  await t.test("one-character fragments are dropped, not keyed", () => {
    // A stray initial must not become a key that matches half the library.
    const keys = albumKeys("Title", "A, Real Artist");
    assert.ok(!keys.includes("title||a"));
    assert.ok(keys.includes("title||real artist"));
  });

  await t.test("a single-artist credit yields exactly one key", () => {
    assert.deepEqual(albumKeys("Rumours", "Fleetwood Mac"), ["rumours||fleetwood mac"]);
  });
});

test("addFavouriteKeys — indexes a service favourite under every identity", async (t) => {
  await t.test("adds one key per credited artist", () => {
    const keys = new Set();
    addFavouriteKeys(keys, "Super Black Blues", null, ["T-Bone Walker", "Big Joe Turner"]);
    assert.ok(keys.has("super black blues||t bone walker"));
    assert.ok(keys.has("super black blues||big joe turner"));
  });

  await t.test("indexes both the plain title and the title+version form", () => {
    // Services return the edition separately; Roon bakes it into the title.
    const keys = new Set();
    addFavouriteKeys(keys, "Rumours", "Deluxe Edition", ["Fleetwood Mac"]);
    assert.ok(keys.has(albumKey("Rumours", "Fleetwood Mac")));
    assert.ok(keys.has(albumKey("Rumours (Deluxe Edition)", "Fleetwood Mac")));
  });

  await t.test("never stores a null key from a blank title", () => {
    const keys = new Set();
    addFavouriteKeys(keys, "÷", null, ["Ed Sheeran"]);
    assert.equal(keys.size, 0);
  });

  await t.test("skips empty artist entries", () => {
    const keys = new Set();
    addFavouriteKeys(keys, "Title", null, ["", null, undefined, "Real"]);
    assert.deepEqual([...keys], ["title||real"]);
  });
});

// ---------------------------------------------------------------------------
// v1.7.27: the local-albums count was too low because the two sides of the
// join built their keys with DIFFERENT functions.
//
// The library index stores albumKeys() for every album — the whole credit plus
// each name within it. The /music file scanner stored albumKey() — the whole
// credit only. That made the match one-directional, and a one-directional
// match is invisible: nothing errors, the count is just quietly short.
//
// buildFileLabelMap itself cannot be unit-tested (it is an async fs walk inside
// a 150-line function), so what is pinned here is the property the fix relies
// on: that the two directions are only symmetric when BOTH sides use albumKeys.
// ---------------------------------------------------------------------------
test("a multi-artist tag and a single-artist credit must be able to meet", async (t) => {
  // The file's ALBUMARTIST tag names everyone; Roon's album credit names one.
  const fileTagCredit = "Robert Plant & Alison Krauss";
  const roonCredit    = "Robert Plant";

  await t.test("albumKey alone cannot match them — the bug", () => {
    const fileKey = albumKey("Raising Sand", fileTagCredit);
    const roonKeys = albumKeys("Raising Sand", roonCredit);
    assert.ok(!roonKeys.includes(fileKey),
      "if these matched, the old code would not have under-counted");
  });

  await t.test("albumKeys on both sides does match them — the fix", () => {
    const fileKeys = albumKeys("Raising Sand", fileTagCredit);
    const roonKeys = albumKeys("Raising Sand", roonCredit);
    assert.ok(fileKeys.some(k => roonKeys.includes(k)),
      `no overlap between ${JSON.stringify(fileKeys)} and ${JSON.stringify(roonKeys)}`);
  });

  await t.test("the reverse direction always worked, which is why this hid", () => {
    // Roon rich, tag single: the index side already split, so it matched.
    const fileKey = albumKey("Raising Sand", roonCredit);
    assert.ok(albumKeys("Raising Sand", fileTagCredit).includes(fileKey));
  });

  await t.test("it does not make unrelated albums collide", () => {
    // Sharing an artist is not sharing an album — the title still has to match.
    const a = albumKeys("Raising Sand", fileTagCredit);
    const b = albumKeys("Led Zeppelin IV", "Led Zeppelin");
    assert.ok(!a.some(k => b.includes(k)));
  });
});
