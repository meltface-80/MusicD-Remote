"use strict";
// ---------------------------------------------------------------------------
// Focus facets — v1.7.35.
//
// The Focus sheet went from three categories to ten, and the two ways it can
// go wrong are both silent:
//
//   1. COUNTING AND FILTERING DISAGREEING. The sheet says "Jazz (212)" and the
//      wall then shows 190 albums. Neither number looks broken on its own, and
//      the user has no way to tell which one lied. That is why both sides read
//      libFacetDefs() — and why the tests below drive the shipping table rather
//      than a copy declared beside them. A duplicated vocabulary is how a facet
//      whose predicate changed would sail past a green suite.
//
//   2. EXCLUSION READING AS INCLUSION. Roon's tap-again-to-invert is encoded in
//      the value ("!Pop"), so a single missing "!" turns "everything except
//      Pop" into "only Pop" — a filter that still returns albums, just the
//      complement of the ones asked for.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// A minimal indexRecord carrying only what the facet predicates read.
function rec(offset, title, artist) {
  const nTitle = title.toLowerCase(), nArtist = artist.toLowerCase();
  return {
    offset, title, subtitle: artist, nTitle, nArtist,
    sortTitle: nTitle.replace(/^(the|a|an) /, ""),
    image_key: "k" + offset,
    srcKeys: [nTitle + "||" + nArtist],
  };
}

const ALBUMS = [
  rec(0, "Kind of Blue",  "Miles Davis"),
  rec(1, "The Wall",      "Pink Floyd"),
  rec(2, "Goo",           "Sonic Youth"),
  rec(3, "1999",          "Prince"),
];

function build(opts) {
  opts = opts || {};
  const albumIndex = { albums: ALBUMS.slice(), builtAt: 1, count: ALBUMS.length };
  const albumYearCache = new Map(Object.entries(opts.years || {
    "kind of blue||miles davis": "1959",
    "the wall||pink floyd":      "1979",
    "goo||sonic youth":          "1990",
    // "1999" is deliberately undated — an album with no value for a facet must
    // match only while that facet is unselected.
  }));
  const albumGenreCache = new Map(Object.entries(opts.genres || {
    "kind of blue||miles davis": ["Jazz"],
    "the wall||pink floyd":      ["Pop/Rock", "Prog"],
    "goo||sonic youth":          ["Pop/Rock"],
  }));
  const albumFileCache = new Map(Object.entries(opts.files || {
    "kind of blue||miles davis": { container: "FLAC", bits: 24, rate: 96000, chan: 2, lossless: true },
    "the wall||pink floyd":      { container: "FLAC", bits: 16, rate: 44100, chan: 2, lossless: true },
    "goo||sonic youth":          { container: "MP3",  bits: null, rate: 44100, chan: 2, lossless: false },
  }));

  return loadIndexFunctions(
    ["libraryView", "albumPlayKey", "libFacetDefs", "facetMatch", "albumGenresOf", "albumFileFactsOf",
     "albumYearOf", "albumAddedOf", "seededRank", "rateLabel", "channelLabel",
     "libAddedWindows", "countWithAny", "smartPlaylistAlbums", "smartOrderDefault",
     "smartOrders", "albumFileFacts", "albumQualityLabel", "albumIsHiRes", "rateShort",
     "albumKeys", "albumTitleVariants", "canonText", "canonArtist", "normalize", "albumKey",
     "setAlbumFileFacts", "formatSourceRank", "qobuzQualityOf", "tidalQualityOf",
     "addHarvestedQuality"],
    {
      albumIndex, albumYearCache, albumGenreCache, albumFileCache,
      // No SQLite in the unit suite: the writes are a side effect, and what
      // these tests are about is which value WINS in memory.
      stmtInsertFileFacts: null,
      DEBUG: false,
      albumSeenCache: new Map(Object.entries(opts.seen || {})),
      libraryMetaVersion: 0,
      libraryViewCache: new Map(),
      LIBRARY_VIEW_CACHE_MAX: 8,
      LIB_SORTS: new Set(["album", "artist", "year", "added", "plays", "lastplayed", "random"]),
      albumSource: (t, s, r) => (opts.sources || {})[r.nTitle] || null,
      resolveAlbumLabelName: (al) => (opts.labels || {
        "kind of blue": "Columbia", "the wall": "Harvest", "goo": "DGC",
      })[al.nTitle] || null,
      getPlayedTitlesSince: () => new Set(opts.played || []),
      playedTitleSet: () => new Set(opts.played || []),
      playStats: () => ({ count: new Map(), last: new Map() }),
    });
}

const titles = (list) => list.map(a => a.title).sort();

// The counting the sheet shows, done exactly the way /api/library/facets does
// it — through the same table, so this helper cannot drift from the endpoint.
function countValues(F, id) {
  const def = F.libFacetDefs().find(d => d.id === id);
  const m = new Map();
  for (const al of ALBUMS) for (const v of def.values(al)) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

test("every facet filters what it counts", async (t) => {
  const F = build();

  // The headline property, run over EVERY facet in the shipping table. A facet
  // added later is covered the moment it is added — which is the point: the
  // ones that break this are always the newest.
  await t.test("selecting a value returns exactly as many albums as the chip claims", () => {
    for (const def of F.libFacetDefs()) {
      for (const [value, count] of countValues(F, def.id)) {
        const got = F.libraryView({ [def.id]: [value] }).length;
        assert.equal(got, count,
          `facet "${def.id}" value "${value}": the sheet would say ${count} and ` +
          `the wall would show ${got}`);
      }
    }
  });

  await t.test("an album with no value for a facet is excluded once it is used", () => {
    // "1999" has no year, no genre and no file. It must appear in an unfiltered
    // library and vanish from every facet — never sort in as "decade zero".
    assert.equal(F.libraryView({}).length, 4);
    for (const id of ["decade", "genre", "format"]) {
      const seen = F.libraryView({ [id]: [...countValues(F, id).keys()] });
      assert.ok(!titles(seen).includes("1999"),
        `facet "${id}" matched an album that has no value for it`);
    }
  });
});

test("facets compose as AND, the way Roon's do", async (t) => {
  const F = build();

  await t.test("two different facets narrow each other", () => {
    // Pop/Rock ∩ FLAC = The Wall. Goo is Pop/Rock but MP3.
    assert.deepEqual(titles(F.libraryView({ genre: ["Pop/Rock"], format: ["FLAC"] })),
      ["The Wall"]);
  });

  await t.test("two values WITHIN one facet are OR", () => {
    assert.deepEqual(titles(F.libraryView({ genre: ["Jazz", "Pop/Rock"] })),
      ["Goo", "Kind of Blue", "The Wall"]);
  });

  await t.test("an impossible combination returns nothing, it does not fall back", () => {
    // Falling back to the whole library would be far worse than an empty wall:
    // the user would believe the filter matched everything.
    assert.equal(F.libraryView({ genre: ["Jazz"], format: ["MP3"] }).length, 0);
  });
});

test("tap-again-to-invert excludes rather than includes", async (t) => {
  const F = build();

  await t.test("an excluded value removes exactly its own albums", () => {
    // NOT the complement of an include — everything except Pop/Rock, including
    // the album that has no genre at all.
    assert.deepEqual(titles(F.libraryView({ genre: ["!Pop/Rock"] })),
      ["1999", "Kind of Blue"]);
  });

  await t.test("excluding is not the same as including", () => {
    const inc = titles(F.libraryView({ genre: ["Pop/Rock"] }));
    const exc = titles(F.libraryView({ genre: ["!Pop/Rock"] }));
    assert.notDeepEqual(inc, exc);
    for (const x of inc) assert.ok(!exc.includes(x), `${x} is in both halves`);
  });

  await t.test("an exclude beats an include naming the same value", () => {
    // Reachable by tapping one chip and its own value from another category;
    // the safe reading is the restrictive one.
    assert.equal(F.libraryView({ genre: ["Pop/Rock", "!Pop/Rock"] }).length, 0);
  });

  await t.test("include and exclude combine within one facet", () => {
    // "Pop/Rock but not Prog" — The Wall is both, so only Goo survives.
    assert.deepEqual(titles(F.libraryView({ genre: ["Pop/Rock", "!Prog"] })), ["Goo"]);
  });

  await t.test("facetMatch on its own: no selection matches everything", () => {
    assert.equal(F.facetMatch([], ["Jazz"]), true);
    assert.equal(F.facetMatch([], []), true);
  });
});

test("the view cache cannot serve one facet's answer for another", async (t) => {
  const F = build();
  // The signature used to list decade and source by name. A facet added without
  // touching it would share a cache entry with the unfiltered library — which
  // shows as Focus doing nothing at all, intermittently.
  await t.test("two different facet selections do not share an entry", () => {
    const jazz = titles(F.libraryView({ genre: ["Jazz"] }));
    const rock = titles(F.libraryView({ genre: ["Pop/Rock"] }));
    assert.notDeepEqual(jazz, rock);
    assert.deepEqual(titles(F.libraryView({ genre: ["Jazz"] })), jazz, "and it is still stable");
  });

  await t.test("a facet selection is not confused with no selection", () => {
    assert.notEqual(F.libraryView({}).length, F.libraryView({ format: ["MP3"] }).length);
  });

  await t.test("the same values in a different order hit the same entry", () => {
    // Purely a cache-efficiency property, but it is what stops the 8-entry LRU
    // thrashing every time a chip is tapped in a different order.
    const a = F.libraryView({ genre: ["Jazz", "Pop/Rock"] });
    const b = F.libraryView({ genre: ["Pop/Rock", "Jazz"] });
    assert.equal(a, b, "the two orderings built separate cache entries");
  });
});

test("Listening covers played as well as unplayed", async (t) => {
  await t.test("never played excludes anything in the history", () => {
    const F = build({ played: ["goo"] });
    assert.ok(!titles(F.libraryView({ played: "never" })).includes("Goo"));
  });

  await t.test("played is its exact complement", () => {
    // Roon's own Focus has no "never" value; ours does, and having one without
    // the other left no way to ask the obvious opposite question.
    const F = build({ played: ["goo"] });
    assert.deepEqual(titles(F.libraryView({ played: "played" })), ["Goo"]);
    const never = titles(F.libraryView({ played: "never" }));
    assert.equal(never.length + 1, ALBUMS.length);
  });
});

test("facet value labels say what the value means", async (t) => {
  const F = build();

  await t.test("sample rates read as kHz, not as a raw integer", () => {
    assert.equal(F.rateLabel(44100), "44.1 kHz");
    assert.equal(F.rateLabel(96000), "96 kHz");
    assert.equal(F.rateLabel(0), null);
  });

  await t.test("channel counts read as words where words exist", () => {
    assert.equal(F.channelLabel(1), "Mono");
    assert.equal(F.channelLabel(2), "Stereo");
    assert.equal(F.channelLabel(6), "6 channels");
    assert.equal(F.channelLabel(0), null);
  });

  await t.test("decades are bucketed by ten, not by exact year", () => {
    const m = countValues(F, "decade");
    assert.deepEqual([...m.keys()].sort(), ["1950", "1970", "1990"]);
  });

  await t.test("the alphabet bucket ignores a leading article", () => {
    // "The Wall" files under W — the same rule the A-Z wall uses, and the
    // reason sortTitle exists at all.
    const m = countValues(F, "letter");
    assert.equal(m.get("W"), 1, "The Wall should be filed under W");
    assert.equal(m.get("#"), 1, "1999 starts with a digit, not a letter");
  });
});

test("Added in the last uses nesting windows", async (t) => {
  const DAY = 86400000;
  const now = Date.now();
  const F = build({
    seen: {
      "kind of blue||miles davis": { ts: now - 2 * DAY,   src: "file" },
      "the wall||pink floyd":      { ts: now - 200 * DAY, src: "file" },
    },
  });

  await t.test("an album added yesterday is in every window that contains it", () => {
    // The windows nest, so picking "3 months" must not exclude this week's
    // additions — which is what a bucket-per-album scheme would do.
    assert.ok(titles(F.libraryView({ added: ["7"] })).includes("Kind of Blue"));
    assert.ok(titles(F.libraryView({ added: ["365"] })).includes("Kind of Blue"));
  });

  await t.test("an older album is only in the wider windows", () => {
    assert.ok(!titles(F.libraryView({ added: ["7"] })).includes("The Wall"));
    assert.ok(titles(F.libraryView({ added: ["365"] })).includes("The Wall"));
  });

  await t.test("an album with no date is in no window at all", () => {
    for (const w of F.libAddedWindows()) {
      assert.ok(!titles(F.libraryView({ added: [w.value] })).includes("Goo"),
        `Goo has no first-seen date but appeared in the ${w.label} window`);
    }
  });
});

test("coverage is counted per album, not per value", async (t) => {
  const F = build();
  await t.test("an album with two genres counts once", () => {
    // The Wall is Pop/Rock AND Prog. Summing the per-value counts would report
    // four genred albums out of a library of four with one ungenred — a number
    // that is not merely imprecise, it is impossible.
    const defs = F.libFacetDefs();
    assert.equal(F.countWithAny(defs, "genre"), 3);
    const summed = [...countValues(F, "genre").values()].reduce((a, b) => a + b, 0);
    assert.equal(summed, 4, "the per-value counts do double-count, as expected");
  });

  await t.test("a facet nothing has reports zero rather than throwing", () => {
    const bare = build({ genres: {}, files: {}, years: {} });
    assert.equal(bare.countWithAny(bare.libFacetDefs(), "genre"), 0);
    assert.equal(bare.libraryView({}).length, ALBUMS.length,
      "an empty facet must not empty the library");
  });
});

// ---------------------------------------------------------------------------
// v1.7.36: playlist order.
//
// The report: a Tracks playlist came out in album order, one record at a time.
// Random has to shuffle, but it CANNOT use Math.random(): tracks are paged by
// album, so a fresh shuffle per request would repeat some tracks and skip
// others as the user scrolls. It is seeded, and that stability is the property
// worth pinning — a shuffle that reshuffles under you is worse than no shuffle.
// ---------------------------------------------------------------------------
test("playlist order — random shuffles, and stays shuffled", async (t) => {
  const F = build();
  const sp = (order, extra) => Object.assign(
    { id: "sp", name: "n", limit: 100, mode: "tracks", order, view: { sort: "album", dir: "asc", seed: 7 } },
    extra || {});
  const titlesOf = (list) => list.map(a => a.title);

  await t.test("album order is the view's own sort", () => {
    assert.deepEqual(titlesOf(F.smartPlaylistAlbums(sp("album"))),
      titlesOf(F.libraryView({ sort: "album", dir: "asc" })));
  });

  await t.test("a playlist with no order at all behaves as album order", () => {
    // Every record saved before v1.7.36 lacks the field.
    const legacy = { id: "sp", name: "n", limit: 100, view: { sort: "album", dir: "asc", seed: 7 } };
    assert.deepEqual(titlesOf(F.smartPlaylistAlbums(legacy)),
      titlesOf(F.smartPlaylistAlbums(sp("album"))));
  });

  await t.test("random is a different order from the sort", () => {
    const shuffled = titlesOf(F.smartPlaylistAlbums(sp("random")));
    assert.notDeepEqual(shuffled, titlesOf(F.smartPlaylistAlbums(sp("album"))));
    // …and it is a permutation, not a filter. A shuffle that drops albums
    // would look like the query having changed.
    assert.deepEqual(shuffled.slice().sort(),
      titlesOf(F.smartPlaylistAlbums(sp("album"))).slice().sort());
  });

  await t.test("the same playlist shuffles the same way every time", () => {
    // THE property. Page 2 is a separate request; if this were Math.random()
    // the second page would re-roll and the user would see duplicates and gaps.
    const a = titlesOf(F.smartPlaylistAlbums(sp("random")));
    const b = titlesOf(F.smartPlaylistAlbums(sp("random")));
    assert.deepEqual(a, b);
  });

  await t.test("a different seed gives a different shuffle", () => {
    // Otherwise "random" would hand every playlist the identical order.
    const orders = new Set();
    for (const seed of [1, 2, 3, 7, 11, 19]) {
      orders.add(titlesOf(F.smartPlaylistAlbums(
        sp("random", { view: { sort: "album", dir: "asc", seed } }))).join("|"));
    }
    assert.ok(orders.size > 1,
      "every seed produced the same order — the seed is not reaching the shuffle");
  });

  await t.test("the result is UNSLICED, so the caller can report what it left out", () => {
    // Slicing inside would make "100 of 1,179" read "100 of 100".
    assert.equal(F.smartPlaylistAlbums(sp("random", { limit: 2 })).length, ALBUMS.length);
  });

  await t.test("the focus still applies before the shuffle", () => {
    const jazzOnly = sp("random", { view: { sort: "album", dir: "asc", seed: 7, genre: ["Jazz"] } });
    assert.deepEqual(titlesOf(F.smartPlaylistAlbums(jazzOnly)), ["Kind of Blue"]);
  });
});

// ---------------------------------------------------------------------------
// v1.7.36: the quality badge.
//
// It is two characters of shorthand claiming a fact about a file, so the way it
// goes wrong is by being CONFIDENTLY WRONG rather than absent — an MP3 badged
// "16/44.1" reads as CD quality, and a streamed album given any badge at all is
// a statement about a file that does not exist.
// ---------------------------------------------------------------------------
test("the quality badge says only what it knows", async (t) => {
  const F = build();
  const q = (f) => F.albumQualityLabel(f);

  await t.test("lossless reads as bits over kHz", () => {
    assert.equal(q({ container: "FLAC", bits: 24, rate: 96000, lossless: true }), "24/96");
    assert.equal(q({ container: "FLAC", bits: 16, rate: 44100, lossless: true }), "16/44.1");
    assert.equal(q({ container: "FLAC", bits: 24, rate: 192000, lossless: true }), "24/192");
  });

  await t.test("a lossy file shows its type, never a bit depth", () => {
    // music-metadata reports a bitsPerSample for MP3 that describes the
    // DECODER, not the recording. Printing "16/44.1" on an MP3 would claim CD
    // quality for a 128kbps rip.
    assert.equal(q({ container: "MP3", bits: 16, rate: 44100, lossless: false }), "MP3");
    assert.equal(q({ container: "AAC", bits: 16, rate: 44100, lossless: false }), "AAC");
  });

  await t.test("no local file means no badge at all", () => {
    // A streamed album has no file to read. Any badge here would be invented.
    assert.equal(q(null), null);
    assert.equal(q(undefined), null);
  });

  await t.test("partial information degrades instead of guessing", () => {
    assert.equal(q({ container: "FLAC", bits: null, rate: 44100, lossless: true }), "44.1 kHz");
    assert.equal(q({ container: "FLAC", bits: null, rate: null, lossless: true }), "FLAC");
    assert.equal(q({ container: null, bits: null, rate: null, lossless: true }), null);
  });

  await t.test("hi-res is anything better than CD, on either axis", () => {
    assert.equal(F.albumIsHiRes({ bits: 24, rate: 44100, lossless: true }), true, "24-bit");
    assert.equal(F.albumIsHiRes({ bits: 16, rate: 96000, lossless: true }), true, "96 kHz");
    assert.equal(F.albumIsHiRes({ bits: 16, rate: 48000, lossless: true }), false, "48k is not hi-res");
    assert.equal(F.albumIsHiRes({ bits: 16, rate: 44100, lossless: true }), false, "CD");
    // A lossy file is never hi-res whatever its header claims.
    assert.equal(F.albumIsHiRes({ bits: 24, rate: 96000, lossless: false }), false);
    assert.equal(F.albumIsHiRes(null), false);
  });

  await t.test("rates read the way people say them", () => {
    assert.equal(F.rateShort(44100), "44.1");
    assert.equal(F.rateShort(48000), "48");
    assert.equal(F.rateShort(96000), "96");
    assert.equal(F.rateShort(2822400), "2822.4");   // DSD64
    assert.equal(F.rateShort(0), null);
  });

  await t.test("an album's facts are found through every identity it is keyed by", () => {
    // Same join as the source badge: the file scan and Roon may know the album
    // under different names, and the badge has to survive that.
    const al = ALBUMS[0];
    assert.equal(F.albumFileFacts(al.title, al.subtitle, al).container, "FLAC");
    // …and with no record at all, from the title and credit alone.
    assert.ok(F.albumFileFacts("Kind of Blue", "Miles Davis", null));
  });
});

// ---------------------------------------------------------------------------
// v1.7.37: formats for albums with no local file.
//
// Roon's library is local files plus streaming albums you added, and adding one
// favourites it in the service — so the favourites pages already being fetched
// for the source badges also state what the service will stream. Reading one
// more field off a response we already have is the whole mechanism.
//
// The hazard is PRECEDENCE. A service describes the album it would send you;
// the file on disk is what actually plays. If a rip of the CD sits alongside a
// hi-res favourite, the badge must say 16/44.1 — claiming 24/96 for audio the
// user will never hear is exactly the confident lie this badge must not tell.
// ---------------------------------------------------------------------------
test("streaming formats fill the gap, and never outrank a local file", async (t) => {
  const F = build();
  const FILE   = { container: "FLAC", bits: 16, rate: 44100, chan: 2, lossless: true };
  const QOBUZ  = { container: null,   bits: 24, rate: 96000, chan: null, lossless: true };

  await t.test("a local file beats a streaming claim, whichever lands first", () => {
    // Both orders, because the scan and the favourites refresh race: the file
    // walk is slow and the favourites fetch is one HTTP call.
    const a = build();
    a.setAlbumFileFacts("k", QOBUZ, "qobuz");
    a.setAlbumFileFacts("k", FILE,  "file");
    assert.equal(a.albumQualityLabel(a.albumFileFacts(null, null, { srcKeys: ["k"] })), "16/44.1");

    const b = build();
    b.setAlbumFileFacts("k", FILE,  "file");
    b.setAlbumFileFacts("k", QOBUZ, "qobuz");
    assert.equal(b.albumQualityLabel(b.albumFileFacts(null, null, { srcKeys: ["k"] })), "16/44.1",
      "the service overwrote the file — the badge would claim audio that never plays");
  });

  await t.test("Qobuz outranks TIDAL, because it states numbers rather than a tier", () => {
    assert.ok(F.formatSourceRank("file")  > F.formatSourceRank("qobuz"));
    assert.ok(F.formatSourceRank("qobuz") > F.formatSourceRank("tidal"));
    assert.ok(F.formatSourceRank("tidal") > F.formatSourceRank(""));
    assert.equal(F.formatSourceRank("nonsense"), 0, "an unknown source loses to everything");
  });

  await t.test("a row written before the column existed is corrected", () => {
    // v1.7.35-36 wrote no src at all, so those rows read back as rank 0 and
    // must yield to the first identified source rather than being permanent.
    const a = build();
    a.setAlbumFileFacts("k", QOBUZ, undefined);
    assert.equal(a.setAlbumFileFacts("k", FILE, "file"), true);
  });

  await t.test("the same source twice keeps the first write", () => {
    // The file walk recurses into disc subdirectories, so a 2-disc album is
    // parsed twice under one key.
    const a = build();
    a.setAlbumFileFacts("k", FILE, "file");
    assert.equal(a.setAlbumFileFacts("k", QOBUZ, "file"), false);
  });
});

test("reading a service's own words for the format", async (t) => {
  const F = build();

  await t.test("Qobuz gives exact numbers, converted from kHz to Hz", () => {
    const q = F.qobuzQualityOf({ maximum_bit_depth: 24, maximum_sampling_rate: 96 });
    assert.deepEqual(q, { container: null, bits: 24, rate: 96000, chan: null, lossless: true });
    assert.equal(F.albumQualityLabel(q), "24/96");
    // 44.1 kHz is the one that rounds badly if it is treated as an integer.
    assert.equal(F.albumQualityLabel(
      F.qobuzQualityOf({ maximum_bit_depth: 16, maximum_sampling_rate: 44.1 })), "16/44.1");
  });

  await t.test("Qobuz with nothing to say produces nothing", () => {
    // A guessed rate is worse than a bare tile.
    assert.equal(F.qobuzQualityOf({}), null);
    assert.equal(F.qobuzQualityOf({ maximum_bit_depth: 24 }), null);
    assert.equal(F.qobuzQualityOf({ maximum_bit_depth: 0, maximum_sampling_rate: 0 }), null);
    assert.equal(F.qobuzQualityOf({ maximum_bit_depth: "x", maximum_sampling_rate: "y" }), null);
  });

  await t.test("TIDAL states a tier, and the badge says the tier", () => {
    // TIDAL hi-res spans 24/44.1 to 24/192. Turning the tier into "24/96"
    // would be inventing both numbers.
    const hires = F.tidalQualityOf({ audioQuality: "HI_RES_LOSSLESS" });
    assert.equal(F.albumQualityLabel(hires), "Hi-Res");
    assert.equal(F.albumIsHiRes(hires), true, "a tier hi-res must still be marked hi-res");
    assert.equal(F.albumQualityLabel(F.tidalQualityOf({ audioQuality: "LOSSLESS" })), "Lossless");
    assert.equal(F.albumQualityLabel(F.tidalQualityOf({ audioQuality: "HIGH" })), "AAC");
    assert.equal(F.tidalQualityOf({ audioQuality: "SOMETHING_NEW" }), null);
    assert.equal(F.tidalQualityOf({}), null);
  });

  await t.test("TIDAL's newer tag list is read too", () => {
    const q = F.tidalQualityOf({ mediaMetadata: { tags: ["HIRES_LOSSLESS"] } });
    assert.equal(F.albumQualityLabel(q), "Hi-Res");
  });

  await t.test("a lossy tier is never hi-res, whatever else it says", () => {
    assert.equal(F.albumIsHiRes(F.tidalQualityOf({ audioQuality: "HIGH" })), false);
  });

  await t.test("the harvest keys on every identity, including the version", () => {
    const a = build();
    // Roon bakes the edition into the title; the service keeps it in `version`.
    const n = a.addHarvestedQuality("Rumours", "Deluxe Edition", ["Fleetwood Mac"],
                                    { bits: 24, rate: 96000, lossless: true }, "qobuz");
    assert.ok(n >= 2, "both the plain and the versioned title should be keyed");
    assert.ok(a.albumFileFacts("Rumours", "Fleetwood Mac", null));
    assert.ok(a.albumFileFacts("Rumours Deluxe Edition", "Fleetwood Mac", null));
  });

  await t.test("nothing is written without a title or facts", () => {
    const a = build();
    assert.equal(a.addHarvestedQuality("", null, ["X"], { bits: 24, rate: 96000 }, "qobuz"), 0);
    assert.equal(a.addHarvestedQuality("T", null, ["X"], null, "qobuz"), 0);
    assert.equal(a.addHarvestedQuality("T", null, [null, undefined], { bits: 24, rate: 96000 }, "qobuz"), 0);
  });
});
