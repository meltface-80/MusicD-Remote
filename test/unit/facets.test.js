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
    ["libraryView", "libFacetDefs", "facetMatch", "albumGenresOf", "albumFileFactsOf",
     "albumYearOf", "albumAddedOf", "seededRank", "rateLabel", "channelLabel",
     "libAddedWindows", "countWithAny"],
    {
      albumIndex, albumYearCache, albumGenreCache, albumFileCache,
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
