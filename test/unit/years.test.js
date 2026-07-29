"use strict";
// ---------------------------------------------------------------------------
// Release-year harvesting — the Decade focus's only source of data.
//
// Roon's browse API publishes no release year at all, so every year the Decade
// filter uses has to come from somewhere else. Before v1.6.58 it came only as a
// by-product of the LABEL scan, whose work list is "albums with no cached
// label" — so once an album had a label it could never acquire a year, and on
// an established install the year passes stopped running entirely. Coverage
// froze at a fraction of the library.
//
// v1.6.58 harvests years from payloads already being fetched for other reasons
// (local file tags, and the Qobuz/TIDAL favourites pages read for source
// badges) and joins them onto the snapshot through each album's srcKeys — the
// same tolerant identity matcher the badges use.
//
// The join is the part that has to be right. Writing a service's own spelling
// straight into the year cache only lands when Roon normalises identically,
// which is exactly the mismatch that already stranded most file-tag years.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// The real key builders, so the join is tested against production key shapes
// rather than a test-local imitation of them.
const K = loadIndexFunctions(
  ["albumKey", "albumKeys", "canonText", "canonArtist", "normalize", "splitCreditIntoArtists"],
  { knownArtistSet: () => new Set() }
);

function harness(opts) {
  opts = opts || {};
  const albumYearCache = new Map(Object.entries(opts.known || {}));
  // key -> source name, mirroring the album_years.src column. Tests that seed
  // `known` may also seed `knownSrc` to say where those years came from.
  const albumYearSource = new Map(Object.entries(opts.knownSrc || {}));
  const albumIndex = { albums: opts.albums || [], builtAt: 1 };
  let bumps = 0;
  const logged = [];

  // setAlbumYear is EXTRACTED, not stubbed. A hand-written stub of it hid two
  // real mutations: it skipped any key already present (the shipping function
  // overwrites when the value differs) and it ignored `deferBump` entirely, so
  // "bump once, not once per album" could not fail. Run the shipping bytes.
  const F = loadIndexFunctions(
    // yearSourceRank is EXTRACTED too, not injected. Injecting the ranking
    // shadowed the shipping one, so a mutation that reordered the real table
    // changed nothing and the suite stayed green.
    ["yearOfDate", "fileTagYear", "addHarvestedYear", "harvestAlbumYears",
     "setAlbumYear", "yearSourceRank"],
    {
      albumKey: K.albumKey,
      albumYearCache,
      albumYearSource,
      albumIndex,
      ambiguousAlbumKeys: opts.ambiguous || new Set(),
      fileAlbumYears:  opts.file  || new Map(),
      qobuzAlbumYears: opts.qobuz || new Map(),
      tidalAlbumYears: opts.tidal || new Map(),
      bumpLibraryMeta: () => { bumps++; },
      // No real SQLite in the unit suite — the cache is the observable side
      // effect. Tests that care about the transaction wrapper pass a fake.
      labelsDb: opts.labelsDb || null,
      stmtInsertYear: opts.stmtInsertYear || null,
      // Captured, not discarded: a swallowed exception inside the harvest is
      // reported here, and a test that silently lost one would look like a pass.
      console: { log() {}, error: (...a) => logged.push(a.join(" ")) },
    }
  );
  // The cache IS the observable effect — harvestAlbumYears calls setAlbumYear
  // from inside the shared compiled scope, so wrapping the returned reference
  // would not intercept anything. Assert on albumYearCache instead.
  return { F, albumYearCache, albumYearSource, bumps: () => bumps, errors: () => logged };
}

// An indexRecord as the real snapshot builds one: Roon's strings normalised for
// the year cache, plus the badge-space identities.
function rec(offset, title, artist) {
  return {
    offset, title, subtitle: artist,
    nTitle: K.normalize(title), nArtist: K.normalize(artist),
    srcKeys: K.albumKeys(title, artist),
  };
}

test("yearOfDate accepts every date shape the sources actually send", async (t) => {
  const { F } = harness();

  await t.test("bare years, ISO dates and full timestamps", () => {
    assert.equal(F.yearOfDate("1975"), "1975");                  // TheAudioDB intYearReleased
    assert.equal(F.yearOfDate("1975-03-21"), "1975");            // Qobuz / TIDAL
    assert.equal(F.yearOfDate("2015-03-09T08:00:00Z"), "2015");  // iTunes releaseDate
    assert.equal(F.yearOfDate(1999), "1999");                    // music-metadata common.year
    assert.equal(F.yearOfDate(" 1968 "), "1968");
  });

  await t.test("anything that is not a 4-digit year is rejected", () => {
    for (const bad of [null, undefined, "", "0", "75", "n/a", "abcd", "-1975", {}, []]) {
      assert.equal(F.yearOfDate(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  await t.test("a year is never invented from a partial date", () => {
    // "197" must not become a year — the Decade filter would bucket it wrongly.
    assert.equal(F.yearOfDate("197"), null);
  });
});

test("fileTagYear prefers the ORIGINAL release date over the reissue", async (t) => {
  const { F } = harness();

  await t.test("ORIGINALDATE wins over DATE and music-metadata's derived year", () => {
    // The case this exists for: a 1973 album remastered in 2011. Taggers put the
    // reissue in DATE and the original in ORIGINALDATE, and music-metadata
    // derives common.year from DATE — so preferring `year` files the album in
    // the 2010s. That is not the decade the user thinks it's in.
    assert.equal(F.fileTagYear({ originaldate: "1973-03-01", date: "2011-09-26", year: 2011 }),
      "1973");
  });

  await t.test("falls back through year, then date", () => {
    assert.equal(F.fileTagYear({ year: 1994, date: "1994-06-01" }), "1994");
    assert.equal(F.fileTagYear({ date: "1988-01-01" }), "1988");
    assert.equal(F.fileTagYear({ originaldate: "1969" }), "1969");
  });

  await t.test("junk in a tag falls through instead of being stored", () => {
    // An unparseable ORIGINALDATE must not shadow a perfectly good DATE.
    assert.equal(F.fileTagYear({ originaldate: "unknown", date: "1977-05-06" }), "1977");
    assert.equal(F.fileTagYear({ originaldate: "", year: 0, date: "" }), null);
    assert.equal(F.fileTagYear({}), null);
    assert.equal(F.fileTagYear(null), null);
  });
});

test("addHarvestedYear keys a harvest the way the badge matcher keys favourites", async (t) => {
  await t.test("indexes under every credited artist", () => {
    const { F } = harness();
    const m = new Map();
    F.addHarvestedYear(m, "Album X", null, ["Miles Davis", "John Coltrane"], "1959");
    assert.equal(m.get(K.albumKey("Album X", "Miles Davis")), "1959");
    assert.equal(m.get(K.albumKey("Album X", "John Coltrane")), "1959");
  });

  await t.test("indexes the edition-suffixed title too", () => {
    // The services return the edition separately while Roon bakes it into the
    // title — the same reason addFavouriteKeys stores both spellings.
    const { F } = harness();
    const m = new Map();
    F.addHarvestedYear(m, "Album X", "Deluxe Edition", ["Artist"], "1980");
    assert.equal(m.get(K.albumKey("Album X", "Artist")), "1980");
    assert.equal(m.get(K.albumKey("Album X Deluxe Edition", "Artist")), "1980");
  });

  await t.test("blank artists and unusable dates are skipped, not stored", () => {
    const { F } = harness();
    const m = new Map();
    F.addHarvestedYear(m, "Album X", null, [null, "", undefined], "1980");
    assert.equal(m.size, 0);
    F.addHarvestedYear(m, "Album X", null, ["Artist"], "not a date");
    assert.equal(m.size, 0);
    F.addHarvestedYear(m, "", null, ["Artist"], "1980");
    assert.equal(m.size, 0);
  });

  await t.test("the first writer wins, so re-runs are stable", () => {
    const { F } = harness();
    const m = new Map();
    F.addHarvestedYear(m, "Album X", null, ["Artist"], "1980");
    F.addHarvestedYear(m, "Album X", null, ["Artist"], "2011");   // a reissue
    assert.equal(m.get(K.albumKey("Album X", "Artist")), "1980");
  });
});

test("harvestAlbumYears joins onto the snapshot", async (t) => {
  await t.test("writes under the key albumYearOf reads — Roon's, not the service's", () => {
    const albums = [rec(0, "Kind of Blue", "Miles Davis")];
    const qobuz = new Map([[K.albumKey("Kind of Blue", "Miles Davis"), "1959"]]);
    const { F, albumYearCache } = harness({ albums, qobuz });

    assert.equal(F.harvestAlbumYears("test"), 1);
    // THE key that matters: nTitle + "||" + nArtist. If the harvest wrote the
    // service's spelling or the badge key instead, the year would be stored and
    // never found.
    assert.equal(albumYearCache.get("kind of blue||miles davis"), "1959");
  });

  await t.test("matches through a spelling Roon and the service disagree on", () => {
    // Roon says "The Beatles" and uses "&"; the service says "Beatles" and
    // "and". canonArtist/canonText converge them — this is the whole reason the
    // join goes through srcKeys instead of a direct string compare.
    const albums = [rec(0, "Sgt Pepper & Friends", "The Beatles")];
    const tidal = new Map([[K.albumKey("Sgt Pepper and Friends", "Beatles"), "1967"]]);
    const { F, albumYearCache } = harness({ albums, tidal });

    assert.equal(F.harvestAlbumYears("test"), 1);
    assert.equal(albumYearCache.get(K.normalize("Sgt Pepper & Friends") + "||" +
                                    K.normalize("The Beatles")), "1967");
  });

  await t.test("matches a multi-artist album on one credited artist", () => {
    const albums = [rec(0, "Super Session", "Al Kooper / Mike Bloomfield")];
    const qobuz = new Map([[K.albumKey("Super Session", "Mike Bloomfield"), "1968"]]);
    const { F, albumYearCache } = harness({ albums, qobuz });

    assert.equal(F.harvestAlbumYears("test"), 1);
    assert.equal(albumYearCache.get(albums[0].nTitle + "||" + albums[0].nArtist), "1968");
  });

  await t.test("a year from the user's own file tags is never overwritten", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const known = { "album x||artist": "1975" };
    const knownSrc = { "album x||artist": "file" };
    const qobuz = new Map([[K.albumKey("Album X", "Artist"), "2011"]]);   // reissue date
    const { F, albumYearCache } = harness({ albums, known, knownSrc, qobuz });

    assert.equal(F.harvestAlbumYears("test"), 0);
    assert.equal(albumYearCache.get("album x||artist"), "1975",
      "a service's reissue date overwrote a year read from the user's own tags");
  });

  await t.test("file tags outrank the streaming services in the same pass", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const { F, albumYearCache, albumYearSource } = harness({
      albums,
      file:  new Map([[key, "1971"]]),
      qobuz: new Map([[key, "2011"]]),
      tidal: new Map([[key, "2019"]]),
    });
    assert.equal(F.harvestAlbumYears("test"), 1);
    assert.equal(albumYearCache.get("album x||artist"), "1971");
    assert.equal(albumYearSource.get("album x||artist"), "file");
  });

  // The reason precedence exists at all: the file walk takes MINUTES while the
  // favourites come back in SECONDS, so on any rescan the services land first.
  // Gap-only ("first writer wins") would make that permanent — a TIDAL 2011
  // remaster date stuck on a 1973 album, with the user's own ORIGINALDATE tag
  // arriving too late to correct it.
  await t.test("file tags CORRECT a service year that landed first", () => {
    const albums = [rec(0, "Dark Side of the Moon", "Pink Floyd")];
    const key = K.albumKey("Dark Side of the Moon", "Pink Floyd");
    const ykey = "dark side of the moon||pink floyd";

    // Round 1: the TIDAL favourites arrive while the disk walk is still running.
    const h = harness({ albums, tidal: new Map([[key, "2011"]]) });
    assert.equal(h.F.harvestAlbumYears("stream"), 1);
    assert.equal(h.albumYearCache.get(ykey), "2011");

    // Round 2: the file scan finishes and reports the album's real year.
    const h2 = harness({
      albums,
      known: { [ykey]: "2011" }, knownSrc: { [ykey]: "edition" },
      file: new Map([[key, "1973"]]),
    });
    assert.equal(h2.F.harvestAlbumYears("file tags"), 1,
      "the file scan could not correct a year the streaming service had already " +
      "written — on every rescan the services win the race, so gap-only means " +
      "the remaster date sticks forever");
    assert.equal(h2.albumYearCache.get(ykey), "1973");
    assert.equal(h2.albumYearSource.get(ykey), "file");
  });

  await t.test("a lower-ranked source may not overwrite a higher-ranked one", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const ykey = "album x||artist";
    const { F, albumYearCache } = harness({
      albums,
      known: { [ykey]: "1970" }, knownSrc: { [ykey]: "release" },
      tidal: new Map([[key, "2019"]]),          // edition < release
    });
    assert.equal(F.harvestAlbumYears("test"), 0);
    assert.equal(albumYearCache.get(ykey), "1970");
  });

  await t.test("a year with no recorded source is upgraded by any real source", () => {
    // Rows written before provenance existed rank 0, so the first identified
    // source corrects them — that is how an install poisoned by the old
    // unvalidated iTunes/TheAudioDB matches gets repaired.
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const ykey = "album x||artist";
    const { F, albumYearCache, albumYearSource } = harness({
      albums, known: { [ykey]: "2015" },        // legacy row, provenance unknown
      tidal: new Map([[key, "1978"]]),
    });
    assert.equal(F.harvestAlbumYears("test"), 1);
    assert.equal(albumYearCache.get(ykey), "1978");
    assert.equal(albumYearSource.get(ykey), "edition");
  });

  await t.test("an identity shared by two library albums is not guessed at", () => {
    // Same suppression withSource applies to badges: if two albums answer to
    // the same identity, we cannot tell which the harvested year belongs to.
    const albums = [rec(0, "Album X", "Artist"), rec(1, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const { F } = harness({
      albums, qobuz: new Map([[key, "1980"]]), ambiguous: new Set([key]),
    });
    assert.equal(F.harvestAlbumYears("test"), 0);
  });

  await t.test("no match leaves the album undated rather than guessing", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const qobuz = new Map([[K.albumKey("Something Else", "Nobody"), "1980"]]);
    const { F, albumYearCache } = harness({ albums, qobuz });
    assert.equal(F.harvestAlbumYears("test"), 0);
    assert.equal(albumYearCache.size, 0);
  });
});

test("harvestAlbumYears is safe and cheap to call at any time", async (t) => {
  await t.test("no-ops before the snapshot exists", () => {
    const qobuz = new Map([[K.albumKey("Album X", "Artist"), "1980"]]);
    const { F } = harness({ albums: [], qobuz });
    // Called on startup and on "service connected", both of which can run with
    // an empty index. It must not throw — the library sync calls it again.
    assert.equal(F.harvestAlbumYears("startup"), 0);
  });

  await t.test("no-ops when nothing has been harvested yet", () => {
    const { F } = harness({ albums: [rec(0, "Album X", "Artist")] });
    assert.equal(F.harvestAlbumYears("test"), 0);
  });

  await t.test("invalidates the ordered-view cache ONCE, not once per album", () => {
    const albums = [], qobuz = new Map();
    for (let i = 0; i < 25; i++) {
      albums.push(rec(i, "Album " + i, "Artist " + i));
      qobuz.set(K.albumKey("Album " + i, "Artist " + i), "19" + (50 + i));
    }
    const h = harness({ albums, qobuz });
    assert.equal(h.F.harvestAlbumYears("test"), 25);
    assert.equal(h.bumps(), 1,
      "the harvest bumped the library-meta version once per album — that " +
      "clears every memoised ordering thousands of times per sync");
  });

  await t.test("a second run over the same data adds nothing", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const qobuz = new Map([[K.albumKey("Album X", "Artist"), "1980"]]);
    const { F } = harness({ albums, qobuz });
    assert.equal(F.harvestAlbumYears("first"), 1);
    assert.equal(F.harvestAlbumYears("second"), 0);
  });

  await t.test("the whole join runs inside ONE database transaction", () => {
    // Unwrapped, the first run on a large library is one implicit transaction —
    // and one fsync — per album, which is minutes of disk on a big library.
    const albums = [], qobuz = new Map();
    for (let i = 0; i < 30; i++) {
      albums.push(rec(i, "Album " + i, "Artist " + i));
      qobuz.set(K.albumKey("Album " + i, "Artist " + i), "19" + (50 + i));
    }
    let txCount = 0, rowsInsideTx = 0, insideTx = false;
    const labelsDb = {
      transaction(fn) {
        return (...args) => {
          txCount++; insideTx = true;
          try { return fn(...args); } finally { insideTx = false; }
        };
      },
    };
    const stmtInsertYear = { run() { if (insideTx) rowsInsideTx++; } };
    const { F } = harness({ albums, qobuz, labelsDb, stmtInsertYear });

    assert.equal(F.harvestAlbumYears("test"), 30);
    assert.equal(txCount, 1, `the join opened ${txCount} transactions, expected 1`);
    assert.equal(rowsInsideTx, 30, "rows were written outside the transaction");
  });

  await t.test("it still works with no database at all", () => {
    // labelsDb is null until openLabelsDb() succeeds, and stays null if the
    // data volume is unwritable. The join must degrade to memory, not throw.
    const albums = [rec(0, "Album X", "Artist")];
    const qobuz = new Map([[K.albumKey("Album X", "Artist"), "1980"]]);
    const { F, albumYearCache } = harness({ albums, qobuz, labelsDb: null });
    assert.equal(F.harvestAlbumYears("test"), 1);
    assert.equal(albumYearCache.get("album x||artist"), "1980");
  });
});
