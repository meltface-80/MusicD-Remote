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
  ["albumKey", "albumKeys", "albumTitleVariants", "canonText", "canonArtist", "normalize",
   "splitCreditIntoArtists"],
  { knownArtistSet: () => new Set() }
);

function harness(opts) {
  opts = opts || {};
  const albumYearCache = new Map(Object.entries(opts.known || {}));
  // key -> source name, mirroring the album_years.src column. Tests that seed
  // `known` may also seed `knownSrc` to say where those years came from.
  const albumYearSource = new Map(Object.entries(opts.knownSrc || {}));
  // key -> the finer date beside that year (v1.8.60), mirroring album_years.date.
  const albumDateCache = new Map(Object.entries(opts.knownDate || {}));
  // key -> which source stated that date, mirroring album_years.date_src.
  const albumDateSource = new Map(Object.entries(opts.knownDateSrc || {}));
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
    ["yearOfDate", "releaseDateOf", "fileTagDate", "addHarvestedYear", "harvestAlbumYears",
     "setAlbumYear", "dateRefines", "yearSourceRank", "albumYearKey"],
    {
      albumKey: K.albumKey,
      albumYearCache,
      albumYearSource,
      albumDateCache,
      albumDateSource,
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
  return { F, albumYearCache, albumYearSource, albumDateCache, albumDateSource,
           bumps: () => bumps, errors: () => logged };
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

// fileTagYear until v1.8.60, which returned the year alone. The YEAR it picks
// is unchanged and still asserted first; the date is what rides along with it.
test("fileTagDate prefers the ORIGINAL release date over the reissue", async (t) => {
  const { F } = harness();

  await t.test("ORIGINALDATE wins over DATE and music-metadata's derived year", () => {
    // The case this exists for: a 1973 album remastered in 2011. Taggers put the
    // reissue in DATE and the original in ORIGINALDATE, and music-metadata
    // derives common.year from DATE — so preferring `year` files the album in
    // the 2010s. That is not the decade the user thinks it's in.
    assert.equal(F.fileTagDate({ originaldate: "1973-03-01", date: "2011-09-26", year: 2011 }),
      "1973-03-01");
  });

  await t.test("falls back through year, then date — with DATE's day when it agrees", () => {
    assert.equal(F.fileTagDate({ year: 1994, date: "1994-06-01" }), "1994-06-01");
    assert.equal(F.fileTagDate({ date: "1988-01-01" }), "1988-01-01");
    assert.equal(F.fileTagDate({ originaldate: "1969" }), "1969");
    assert.equal(F.fileTagDate({ year: 1994 }), "1994");
  });

  await t.test("a DATE from a different year does not lend its day to YEAR", () => {
    // YEAR and DATE can disagree when both tags are present. The year comes
    // from YEAR, as it always did; attaching DATE's month and day to it would
    // invent a date that no tag states.
    assert.equal(F.fileTagDate({ year: 1994, date: "1995-06-01" }), "1994");
  });

  await t.test("junk in a tag falls through instead of being stored", () => {
    // An unparseable ORIGINALDATE must not shadow a perfectly good DATE.
    assert.equal(F.fileTagDate({ originaldate: "unknown", date: "1977-05-06" }), "1977-05-06");
    assert.equal(F.fileTagDate({ originaldate: "", year: 0, date: "" }), null);
    assert.equal(F.fileTagDate({}), null);
    assert.equal(F.fileTagDate(null), null);
  });

  await t.test("the year is exactly what fileTagYear returned, for every tag shape", () => {
    // The Decade filter reads this year, and v1.8.60 was not meant to move a
    // single album between decades. The old rule, restated, against the new.
    const oldYear = (c) => !c ? null :
      F.yearOfDate(c.originaldate) || F.yearOfDate(c.year) || F.yearOfDate(c.date);
    const shapes = [
      { originaldate: "1973-03-01", date: "2011-09-26", year: 2011 },
      { originaldate: "1973", date: "2011-09-26", year: 2011 },
      { originaldate: "junk", date: "2011-09-26", year: 2011 },
      { year: 1994, date: "1994-06-01" }, { year: 1994, date: "1995-06-01" },
      { date: "1988-01-01" }, { date: "1988" }, { year: "1988" }, { originaldate: "1969-13-40" },
      { date: "2024-00-00" }, { originaldate: "", year: 0, date: "" }, {}, null,
    ];
    for (const c of shapes) {
      const d = F.fileTagDate(c);
      assert.equal(d === null ? null : d.slice(0, 4), oldYear(c), JSON.stringify(c));
    }
  });
});

test("releaseDateOf keeps as much of a date as the value really states", async (t) => {
  const { F } = harness();

  await t.test("full dates, months and bare years", () => {
    assert.equal(F.releaseDateOf("1975-03-21"), "1975-03-21");           // Qobuz / TIDAL
    assert.equal(F.releaseDateOf("2015-03-09T08:00:00Z"), "2015-03-09"); // iTunes releaseDate
    assert.equal(F.releaseDateOf("1975-03"), "1975-03");                 // MusicBrainz, partial
    assert.equal(F.releaseDateOf("1975"), "1975");
    assert.equal(F.releaseDateOf(1999), "1999");                         // music-metadata year
    assert.equal(F.releaseDateOf(" 1968-11-22 "), "1968-11-22");
  });

  await t.test("a month or day that cannot exist is dropped, not rounded", () => {
    assert.equal(F.releaseDateOf("2024-00-00"), "2024");      // a common "unknown" in tags
    assert.equal(F.releaseDateOf("2024-13-01"), "2024");
    assert.equal(F.releaseDateOf("2024-03-00"), "2024-03");
    assert.equal(F.releaseDateOf("2023-02-29"), "2023-02");   // not a leap year
    assert.equal(F.releaseDateOf("2024-02-29"), "2024-02-29"); // a leap year
    assert.equal(F.releaseDateOf("2024-04-31"), "2024-04");
    assert.equal(F.releaseDateOf("2024-12-31"), "2024-12-31");
  });

  await t.test("a shape it does not recognise keeps the year and invents nothing", () => {
    assert.equal(F.releaseDateOf("1975/03/21"), "1975");
    assert.equal(F.releaseDateOf("1975-3-21"), "1975");
  });

  await t.test("the year is always yearOfDate's, and null exactly when that is", () => {
    for (const v of [null, undefined, "", "0", "75", "n/a", "abcd", "-1975", {}, [], "197",
                     "1975", "1975-03-21", "2015-03-09T08:00:00Z", 1999, "2024-13-01",
                     "19755", " 1968 "]) {
      const d = F.releaseDateOf(v);
      assert.equal(d === null ? null : d.slice(0, 4), F.yearOfDate(v), JSON.stringify(v));
    }
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

// ---------------------------------------------------------------------------
// v1.8.60: the DATE beside the year.
//
// Reported: the Library's date sort ordered by year alone, so a record
// released yesterday was not at the top newest-first, nor at the bottom
// oldest-first — it sat anywhere among this year's albums. Every source this
// store is fed from states a day (file DATE tags, Qobuz release_date_original,
// TIDAL releaseDate, MusicBrainz first-release-date, iTunes releaseDate), and
// every one of them was cut to four digits on the way in.
//
// The YEAR's rules are untouched (the tests above still hold them). What these
// pin is the date: it rides with the year, a same-or-lower source may REFINE
// it when it agrees on the year, and nothing may CONTRADICT it from below.
// ---------------------------------------------------------------------------
test("setAlbumYear keeps the release date beside the year", async (t) => {
  const K1 = "album x||artist";

  await t.test("a new album gets its year AND its date", () => {
    const h = harness();
    assert.equal(h.F.setAlbumYear(K1, "2026-09-25", { src: "release" }), true);
    assert.equal(h.albumYearCache.get(K1), "2026", "the year readers see must stay four digits");
    assert.equal(h.albumDateCache.get(K1), "2026-09-25");
  });

  await t.test("a bare year stores no date", () => {
    const h = harness();
    h.F.setAlbumYear(K1, "2026", { src: "file" });
    assert.equal(h.albumYearCache.get(K1), "2026");
    assert.equal(h.albumDateCache.has(K1), false);
  });

  await t.test("a lower source REFINES the date when it agrees on the year", () => {
    // File tags say only "2024" and outrank Qobuz; Qobuz knows the day. The
    // two do not disagree, so the day is kept — and the year's provenance is
    // still the file's.
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "file" } });
    assert.equal(h.F.setAlbumYear(K1, "2024-03-15", { src: "release" }), true);
    assert.equal(h.albumYearCache.get(K1), "2024");
    assert.equal(h.albumYearSource.get(K1), "file", "refining the day changed the year's source");
    assert.equal(h.albumDateCache.get(K1), "2024-03-15");
    assert.equal(h.albumDateSource.get(K1), "release", "the day is not recorded as Qobuz's");
  });

  await t.test("a lower source may take a known MONTH to the day", () => {
    // The file tags say March 2024; Qobuz says the 15th. More of the same
    // date, contradicting nothing — the first cut kept this, and so must this.
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "file" },
                        knownDate: { [K1]: "2024-03" }, knownDateSrc: { [K1]: "file" } });
    assert.equal(h.F.setAlbumYear(K1, "2024-03-15", { src: "release" }), true,
      "a lower source could not add the day to a month the file already agreed on");
    assert.equal(h.albumDateCache.get(K1), "2024-03-15");
    assert.equal(h.albumDateSource.get(K1), "release");
  });

  await t.test("a lower source may NOT contradict the day on file", () => {
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "file" },
                        knownDate: { [K1]: "2024-03" } });
    assert.equal(h.F.setAlbumYear(K1, "2024-05-01", { src: "release" }), false);
    assert.equal(h.albumDateCache.get(K1), "2024-03");
  });

  await t.test("a lower source's day for a DIFFERENT year is not attached to this one", () => {
    const h = harness({ known: { [K1]: "1973" }, knownSrc: { [K1]: "file" } });
    assert.equal(h.F.setAlbumYear(K1, "2011-09-26", { src: "edition" }), false);
    assert.equal(h.albumYearCache.get(K1), "1973");
    assert.equal(h.albumDateCache.has(K1), false);
  });

  await t.test("a better source that says LESS keeps the finer date it agrees with", () => {
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "release" },
                        knownDate: { [K1]: "2024-03-15" } });
    assert.equal(h.F.setAlbumYear(K1, "2024", { src: "file" }), true);
    assert.equal(h.albumYearSource.get(K1), "file");
    assert.equal(h.albumDateCache.get(K1), "2024-03-15",
      "a better source with only a year threw away a day nothing contradicts");
    assert.equal(h.albumDateSource.get(K1), "release",
      "the day took the year's new source — it is still the release date's word, not the file's");
  });

  await t.test("a better source's own day replaces a conflicting one", () => {
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "edition" },
                        knownDate: { [K1]: "2024-03-15" } });
    assert.equal(h.F.setAlbumYear(K1, "2024-05-01", { src: "file" }), true);
    assert.equal(h.albumDateCache.get(K1), "2024-05-01");
  });

  await t.test("a better source correcting the YEAR drops the old year's date", () => {
    const h = harness({ known: { [K1]: "2011" }, knownSrc: { [K1]: "edition" },
                        knownDate: { [K1]: "2011-09-26" } });
    assert.equal(h.F.setAlbumYear(K1, "1973", { src: "file" }), true);
    assert.equal(h.albumYearCache.get(K1), "1973");
    assert.equal(h.albumDateCache.has(K1), false,
      "the 2011 reissue's day survived the year's correction to 1973");
  });

  await t.test("the same date again changes nothing and bumps nothing", () => {
    const h = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "release" },
                        knownDate: { [K1]: "2024-03-15" } });
    assert.equal(h.F.setAlbumYear(K1, "2024-03-15", { src: "release" }), false);
    assert.equal(h.F.setAlbumYear(K1, "2024-03", { src: "edition" }), false);
    assert.equal(h.F.setAlbumYear(K1, "2024", { src: "catalog" }), false);
    assert.equal(h.bumps(), 0);
  });

  await t.test("the date reaches the database beside the year and its source", () => {
    const rows = [];
    const h = harness({ stmtInsertYear: { run: (...a) => rows.push(a) },
                        labelsDb: { transaction: (fn) => fn } });
    h.F.setAlbumYear(K1, "2026-09-25", { src: "release" });
    assert.deepEqual(rows[0], [K1, "2026", "release", "2026-09-25", "release"]);
    // A refinement writes the row whole — the year and ITS source unchanged.
    const h2 = harness({ known: { [K1]: "2024" }, knownSrc: { [K1]: "file" },
                         stmtInsertYear: { run: (...a) => rows.push(a) },
                         labelsDb: { transaction: (fn) => fn } });
    h2.F.setAlbumYear(K1, "2024-03-15", { src: "release" });
    assert.deepEqual(rows[1], [K1, "2024", "file", "2024-03-15", "release"]);
    // A year with no finer date writes NULL for both, not the year twice.
    h2.F.setAlbumYear("other||x", "1999", { src: "file" });
    assert.deepEqual(rows[2], ["other||x", "1999", "file", null, null]);
  });
});

test("the harvest carries whole dates, and dates an existing install's years", async (t) => {
  await t.test("the favourites' full date lands, not just its year", () => {
    const albums = [rec(0, "New Record", "Artist")];
    const m = new Map();
    const h = harness({ albums, qobuz: m });
    h.F.addHarvestedYear(m, "New Record", null, ["Artist"], "2026-09-25");
    assert.equal(h.F.harvestAlbumYears("test"), 1);
    assert.equal(h.albumYearCache.get("new record||artist"), "2026");
    assert.equal(h.albumDateCache.get("new record||artist"), "2026-09-25");
  });

  await t.test("THE upgrade path: a year stored before v1.8.60 gains its day", () => {
    // Every row written before this version has a year and no date. The very
    // next favourites read states the same year to the day, from the SAME
    // source — equal rank, which may not change a year, but may refine it.
    // Without this, nothing already in the library would sort by day until
    // something made its year change.
    const albums = [rec(0, "Album X", "Artist")];
    const ykey = "album x||artist";
    const h = harness({
      albums, known: { [ykey]: "2024" }, knownSrc: { [ykey]: "release" },
      qobuz: new Map([[K.albumKey("Album X", "Artist"), "2024-03-15"]]),
    });
    assert.equal(h.F.harvestAlbumYears("startup"), 1,
      "an existing year was not given the day its own source now states");
    assert.equal(h.albumDateCache.get(ykey), "2024-03-15");
    assert.equal(h.albumYearSource.get(ykey), "release");
    assert.equal(h.F.harvestAlbumYears("again"), 0, "a second pass rewrote an unchanged row");
  });

  await t.test("in ONE pass, a bare file year takes the day a service agrees on", () => {
    // The harvest picks the year's source first (file tags), and that source
    // says only "2024". The Qobuz favourite in the same pass says 2024-03-15.
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const ykey = "album x||artist";
    const h = harness({ albums, file: new Map([[key, "2024"]]),
                        qobuz: new Map([[key, "2024-03-15"]]) });
    assert.equal(h.F.harvestAlbumYears("test"), 1);
    assert.equal(h.albumYearCache.get(ykey), "2024");
    assert.equal(h.albumYearSource.get(ykey), "file", "the day's source took over the year");
    assert.equal(h.albumDateCache.get(ykey), "2024-03-15",
      "the file's bare year hid the day the Qobuz favourite states");
    assert.equal(h.albumDateSource.get(ykey), "release",
      "Qobuz's day was filed under the file tags' name");
  });

  await t.test("...but never a day from a year that lost", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const ykey = "album x||artist";
    const h = harness({ albums, file: new Map([[key, "1973"]]),
                        tidal: new Map([[key, "2011-09-26"]]) });
    assert.equal(h.F.harvestAlbumYears("test"), 1);
    assert.equal(h.albumYearCache.get(ykey), "1973");
    assert.equal(h.albumDateCache.has(ykey), false,
      "the 2011 remaster's day was attached to the 1973 original");
  });

  await t.test("file tags that state only a year keep the service's day", () => {
    const albums = [rec(0, "Album X", "Artist")];
    const key = K.albumKey("Album X", "Artist");
    const ykey = "album x||artist";
    // Round 1: Qobuz lands first, to the day.
    const h = harness({ albums, qobuz: new Map([[key, "2024-03-15"]]) });
    h.F.harvestAlbumYears("stream");
    // Round 2: the walk reports YEAR=2024 and nothing finer. It outranks
    // Qobuz for the year — and agrees with it, so the day stays.
    const h2 = harness({
      albums, known: { [ykey]: "2024" }, knownSrc: { [ykey]: "release" },
      knownDate: { [ykey]: h.albumDateCache.get(ykey) },
      file: new Map([[key, "2024"]]),
    });
    assert.equal(h2.F.harvestAlbumYears("file tags"), 1);
    assert.equal(h2.albumYearSource.get(ykey), "file");
    assert.equal(h2.albumDateCache.get(ykey), "2024-03-15");
  });
});

// The v1.8.60 review's finding, reproduced first and fixed second. The first
// cut had the harvest borrow a finer day from ANY source and store it under the
// name of the source that set the YEAR — so TIDAL's day went in with file-tag
// rank, overwrote a MusicBrainz day, and from then on setAlbumYear judged every
// correction by the year's rank and refused them all. The day has its own
// provenance now, and every source offers its day under its own name.
test("the day is judged by who stated the DAY, not who stated the year", async (t) => {
  const ykey = "album x||artist";
  const albums = [rec(0, "Album X", "Artist")];
  const key = K.albumKey("Album X", "Artist");

  await t.test("THE finding: a worse source's day never replaces a better one's", () => {
    // MusicBrainz (release) said 1973-03-01 when the album was opened. The
    // file tag says only "1973"; TIDAL (edition) says 1973-01-01.
    const h = harness({
      albums, known: { [ykey]: "1973" }, knownSrc: { [ykey]: "release" },
      knownDate: { [ykey]: "1973-03-01" }, knownDateSrc: { [ykey]: "release" },
      file: new Map([[key, "1973"]]), tidal: new Map([[key, "1973-01-01"]]),
    });
    h.F.harvestAlbumYears("test");
    assert.equal(h.albumYearSource.get(ykey), "file", "the file tags should still take the year");
    assert.equal(h.albumDateCache.get(ykey), "1973-03-01",
      "TIDAL's day overwrote MusicBrainz's — a worse source for the day replaced a better one");
    assert.equal(h.albumDateSource.get(ykey), "release");
  });

  await t.test("...and a better source for the day can still correct it", () => {
    const h = harness({
      known: { [ykey]: "1973" }, knownSrc: { [ykey]: "file" },
      knownDate: { [ykey]: "1973-01-01" }, knownDateSrc: { [ykey]: "edition" },
    });
    assert.equal(h.F.setAlbumYear(ykey, "1973-03-01", { src: "release" }), true,
      "a release date could not correct an edition date, because the YEAR is the file's");
    assert.equal(h.albumDateCache.get(ykey), "1973-03-01");
    assert.equal(h.albumDateSource.get(ykey), "release");
    assert.equal(h.albumYearSource.get(ykey), "file", "correcting the day touched the year");
    // ...but an equally-ranked source does not flip it back.
    assert.equal(h.F.setAlbumYear(ykey, "1973-03-24", { src: "release" }), false);
    assert.equal(h.albumDateCache.get(ykey), "1973-03-01");
  });

  await t.test("the same day from a better source takes over its provenance", () => {
    const h = harness({
      known: { [ykey]: "1973" }, knownSrc: { [ykey]: "file" },
      knownDate: { [ykey]: "1973-03-01" }, knownDateSrc: { [ykey]: "edition" },
    });
    assert.equal(h.F.setAlbumYear(ykey, "1973-03-01", { src: "release" }), true);
    assert.equal(h.albumDateSource.get(ykey), "release");
    // So a release-ranked conflicting day can no longer displace it.
    assert.equal(h.F.setAlbumYear(ykey, "1973-06-01", { src: "release" }), false);
  });

  await t.test("dayOnly never moves the year, even from a better source", () => {
    const h = harness({ known: { [ykey]: "2011" }, knownSrc: { [ykey]: "edition" } });
    assert.equal(h.F.setAlbumYear(ykey, "1973-03-01", { src: "file", dayOnly: true }), false);
    assert.equal(h.albumYearCache.get(ykey), "2011");
    assert.equal(h.albumYearSource.get(ykey), "edition");
    assert.equal(h.albumDateCache.has(ykey), false);
  });

  await t.test("dayOnly on an album with no year does nothing", () => {
    const h = harness();
    assert.equal(h.F.setAlbumYear(ykey, "2024-03-15", { src: "release", dayOnly: true }), false);
    assert.equal(h.albumYearCache.has(ykey), false);
    assert.equal(h.bumps(), 0);
  });

  await t.test("a day stored without a source of its own reads as the year's", () => {
    // Nothing writes that shape, but a seeded or hand-edited row must still be
    // protected by the year's rank rather than by none.
    const h = harness({ known: { [ykey]: "2024" }, knownSrc: { [ykey]: "file" },
                        knownDate: { [ykey]: "2024-03-15" } });
    assert.equal(h.F.setAlbumYear(ykey, "2024-05-01", { src: "release" }), false);
    assert.equal(h.albumDateCache.get(ykey), "2024-03-15");
  });

  // The three sequences the line-by-line review reproduced against the first
  // cut. Each ended with the RIGHT source refused, permanently.
  await t.test("upgrade path: the user's own file day replaces a service day that landed first", () => {
    // Pre-v1.8.60 row: a file-tag year and no day. Qobuz's day lands first
    // (the favourites read beats the /music walk), then the walk reports the
    // file's own DATE.
    const h = harness({ known: { [ykey]: "2024" }, knownSrc: { [ykey]: "file" } });
    assert.equal(h.F.setAlbumYear(ykey, "2024-03-15", { src: "release" }), true);
    assert.equal(h.F.setAlbumYear(ykey, "2024-05-01", { src: "file" }), true,
      "the user's own tag could not set its own day");
    assert.equal(h.albumDateCache.get(ykey), "2024-05-01");
    assert.equal(h.albumDateSource.get(ykey), "file");
  });

  await t.test("an edition's day does not block the original release date", () => {
    const h = harness({ known: { [ykey]: "2024" }, knownSrc: { [ykey]: "release" } });
    h.F.setAlbumYear(ykey, "2024-05-01", { src: "edition" });      // TIDAL fills the day
    assert.equal(h.albumDateCache.get(ykey), "2024-05-01");
    assert.equal(h.F.setAlbumYear(ykey, "2024-03-15", { src: "release" }), true,
      "Qobuz's original release date was refused because TIDAL got there first");
    assert.equal(h.albumDateCache.get(ykey), "2024-03-15");
  });

  await t.test("a year-only write does not relabel someone else's day", () => {
    const h = harness();
    h.F.setAlbumYear(ykey, "2024-06-07", { src: "catalog" });      // iTunes
    h.F.setAlbumYear(ykey, "2024", { src: "release" });            // a label-scan year
    assert.equal(h.albumYearSource.get(ykey), "release");
    assert.equal(h.albumDateSource.get(ykey), "catalog",
      "a write that stated no day took ownership of the day");
    assert.equal(h.F.setAlbumYear(ykey, "2024-03-15", { src: "release" }), true,
      "the release date was refused by a day that was only ever iTunes'");
    assert.equal(h.albumDateCache.get(ykey), "2024-03-15");
  });

  await t.test("the harvest still settles: a second pass writes nothing", () => {
    const h = harness({
      albums, file: new Map([[key, "1973"]]),
      qobuz: new Map([[key, "1973-03-01"]]), tidal: new Map([[key, "1973-01-01"]]),
    });
    assert.equal(h.F.harvestAlbumYears("first"), 1);
    assert.equal(h.albumDateCache.get(ykey), "1973-03-01", "the release date should win the day");
    assert.equal(h.albumDateSource.get(ykey), "release");
    assert.equal(h.F.harvestAlbumYears("second"), 0);
    assert.equal(h.F.harvestAlbumYears("third"), 0);
  });
});
