"use strict";
// ---------------------------------------------------------------------------
// libraryView — the Library wall's sort + focus engine.
//
// Two things here have already gone wrong once and are invisible when they do,
// because a wrongly-ordered list still looks like a list:
//
//   1. Unknown release years. v1.6.57 reversed the WHOLE list for descending,
//      which floated every undated album to the top of "newest first". They are
//      unknown, not year zero, and must sit at the end in BOTH directions.
//   2. What `dir` means. Before v1.6.58 the server inverted plays/lastplayed,
//      so "asc" produced most-played-first while "asc" everywhere else produced
//      least-first. One arrow control cannot point two ways, so the inversion
//      was removed and the client now picks each sort's default direction. If
//      it ever comes back, the arrow silently lies.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// A minimal indexRecord — only the fields libraryView and its comparators read.
function rec(offset, title, artist, sortTitle) {
  return {
    offset, title, subtitle: artist,
    nTitle: title.toLowerCase(), nArtist: artist.toLowerCase(),
    sortTitle: (sortTitle || title).toLowerCase(),
    cFirst: artist.toLowerCase(),
    // Populated so albumAddedOf() can find a first-seen date the way it does
    // live — it looks the album up under every identity it is keyed by.
    srcKeys: [title.toLowerCase() + "||" + artist.toLowerCase()],
  };
}

const ALBUMS = [
  rec(0, "Bravo",   "Delta"),
  rec(1, "Alpha",   "Charlie"),
  rec(2, "Charlie", "Bravo"),
  rec(3, "Delta",   "Alpha"),
];

// title -> year. Deliberately leaves "Charlie" undated.
const YEARS = { alpha: "1975", bravo: "1999", delta: "2008" };

function build(opts) {
  opts = opts || {};
  // opts.albums/years/dates replace the fixture wholesale (v1.8.60's day-level
  // cases need their own library); every other test uses the one above.
  const albums = opts.albums || ALBUMS;
  const years  = opts.years  || YEARS;
  const albumYearCache = new Map();
  // key -> the finer release date beside the year, as setAlbumYear keeps it.
  const albumDateCache = new Map();
  for (const al of albums) {
    const y = years[al.nTitle];
    if (y) albumYearCache.set(al.nTitle + "||" + al.nArtist, y);
    const d = opts.dates && opts.dates[al.nTitle];
    if (d) albumDateCache.set(al.nTitle + "||" + al.nArtist, d);
  }
  const albumIndex = { albums: albums.slice(), builtAt: 1, count: albums.length };
  // Alpha and Delta have a first-seen date; Bravo and Charlie do not. Keys
  // match ALBUMS' srcKeys so albumAddedOf() finds them the way it does live.
  const albumSeenCache = new Map(opts.seen || [
    ["alpha||charlie", { ts: 1000, src: "file" }],
    ["delta||alpha",   { ts: 3000, src: "first-seen" }],
  ]);
  const F = loadIndexFunctions(
    // libFacetDefs and facetMatch are EXTRACTED, not stubbed: they are the
    // shipping facet vocabulary, and a stub beside them would let a facet's
    // predicate change without a single test noticing.
    ["libraryView", "libraryPrefix", "libraryPrefixMax", "albumMatchesPrefix", "normalize", "albumPlayKey", "albumYearOf", "albumYearKey", "albumDateOf", "albumAddedOf", "seededRank",
     "libFacetDefs", "facetMatch", "albumGenresOf", "albumFileFactsOf", "albumFileFacts",
     "rateLabel", "channelLabel", "libAddedWindows"],
    {
      // libFacetDefs publishes "Record label" only when Labels is on.
      labelsEnabled: true,
      albumYearCache,
      albumDateCache,
      albumSeenCache,
      albumGenreCache: opts.genres || new Map(),
      albumFileCache:  opts.files  || new Map(),
      albumIndex,
      libraryMetaVersion: 0,
      // A fresh cache per build, so memoisation can never leak an ordering
      // from one test case into the next.
      libraryViewCache: new Map(),
      LIBRARY_VIEW_CACHE_MAX: 8,
      LIB_SORTS: new Set(["album", "artist", "year", "added", "plays", "lastplayed", "random"]),
      albumSource: (t, s, rec) => (opts.sources && opts.sources[rec.nTitle]) || null,
      resolveAlbumLabelName: (al) => (opts.labels && opts.labels[al.nTitle]) || null,
      getPlayedTitlesSince: () => opts.played || new Set(),
      playedTitleSet: () => opts.played || new Set(),
      playStats: () => opts.stats || { count: new Map(), last: new Map() },
    }
  );
  return F;
}

const titles = (list) => list.map(a => a.title);

// v1.7.31: Roon publishes no import date, so every value behind this sort is
// the extension's own evidence and coverage is partial by construction. The
// undated albums are the interesting case: on an established library they are
// the MAJORITY at first, and a sort that put them at position zero — or, worse,
// floated them to the top when reversed — would look broken rather than
// incomplete.
test("libraryView — recently added holds undated albums out of the ordering", async (t) => {
  const F = build();

  await t.test("only dated albums take part in the ordering", () => {
    // Alpha ts=1000, Delta ts=3000; Bravo and Charlie have no date.
    assert.deepEqual(titles(F.libraryView({ sort: "added", dir: "asc" })),
      ["Alpha", "Delta", "Bravo", "Charlie"]);
  });

  await t.test("reversing reverses the DATED ones and leaves the rest at the end", () => {
    // The whole point: desc must not put undated albums first.
    assert.deepEqual(titles(F.libraryView({ sort: "added", dir: "desc" })),
      ["Delta", "Alpha", "Bravo", "Charlie"]);
  });

  await t.test("undated albums keep a stable alphabetical order of their own", () => {
    // Otherwise the tail of the list reshuffles between requests while paging.
    const asc = titles(F.libraryView({ sort: "added", dir: "asc" })).slice(2);
    const desc = titles(F.libraryView({ sort: "added", dir: "desc" })).slice(2);
    assert.deepEqual(asc, ["Bravo", "Charlie"]);
    assert.deepEqual(desc, ["Bravo", "Charlie"]);
  });

  await t.test("a library with no dates at all is alphabetical, not empty", () => {
    // The first-run state. It must degrade to something sensible rather than
    // returning nothing or an arbitrary order.
    const none = build({ seen: [] });
    assert.deepEqual(titles(none.libraryView({ sort: "added", dir: "desc" })),
      ["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  await t.test("albumAddedOf reports null rather than zero for an undated album", () => {
    // Zero would sort as 1970 and quietly claim to be a date.
    const dated = F.libraryView({ sort: "added", dir: "asc" });
    assert.equal(F.albumAddedOf(dated.find(a => a.title === "Bravo")), null);
    assert.equal(F.albumAddedOf(dated.find(a => a.title === "Alpha")), 1000);
  });
});

test("libraryView — alphabetical sorts run both ways", async (t) => {
  const F = build();

  await t.test("album asc is A→Z, desc is Z→A", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "album", dir: "asc" })),
      ["Alpha", "Bravo", "Charlie", "Delta"]);
    assert.deepEqual(titles(F.libraryView({ sort: "album", dir: "desc" })),
      ["Delta", "Charlie", "Bravo", "Alpha"]);
  });

  await t.test("artist asc is A→Z by artist, desc reverses it", () => {
    // Artists are Alpha/Bravo/Charlie/Delta on titles Delta/Charlie/Alpha/Bravo.
    assert.deepEqual(titles(F.libraryView({ sort: "artist", dir: "asc" })),
      ["Delta", "Charlie", "Alpha", "Bravo"]);
    assert.deepEqual(titles(F.libraryView({ sort: "artist", dir: "desc" })),
      ["Bravo", "Alpha", "Charlie", "Delta"]);
  });

  await t.test("an unknown sort falls back to album, it does not throw", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "nonsense", dir: "asc" })),
      ["Alpha", "Bravo", "Charlie", "Delta"]);
  });
});

test("libraryView — release year", async (t) => {
  const F = build();

  await t.test("asc is oldest first", () => {
    const out = titles(F.libraryView({ sort: "year", dir: "asc" }));
    assert.deepEqual(out.slice(0, 3), ["Alpha", "Bravo", "Delta"]);   // 1975, 1999, 2008
  });

  await t.test("desc is newest first", () => {
    const out = titles(F.libraryView({ sort: "year", dir: "desc" }));
    assert.deepEqual(out.slice(0, 3), ["Delta", "Bravo", "Alpha"]);
  });

  // THE v1.6.57 BUG. Reversing the whole list put undated albums first.
  await t.test("undated albums sort LAST in both directions", () => {
    for (const dir of ["asc", "desc"]) {
      const out = titles(F.libraryView({ sort: "year", dir }));
      assert.equal(out[out.length - 1], "Charlie",
        `an album with no release year led/floated in dir=${dir} — it is ` +
        "UNKNOWN, not year zero, and must never outrank a dated album");
    }
  });

  await t.test("the decade focus excludes undated albums entirely", () => {
    const out = titles(F.libraryView({ sort: "album", decade: ["1990"] }));
    assert.deepEqual(out, ["Bravo"]);
    // Undated albums belong to no decade — they must not leak into a filter.
    assert.ok(!out.includes("Charlie"));
  });

  await t.test("multiple decades combine as OR", () => {
    const out = titles(F.libraryView({ sort: "album", decade: ["1970", "2000"] }));
    assert.deepEqual(out, ["Alpha", "Delta"]);
  });
});

// v1.8.60: the sort orders by DAY where a date is known. Reported as "an album
// released yesterday isn't at the top newest-first, and isn't at the bottom
// oldest-first" — by year alone it sat wherever its title put it among the
// year's albums. The fixture is a year with that shape: the album out
// yesterday is titled to sort FIRST alphabetically, so a year-only ordering
// (title tie-break) puts it in the wrong place in BOTH directions.
test("libraryView — release date orders by the day", async (t) => {
  const albums = [
    rec(0, "Aardvark",  "New"),     // released yesterday — first by title
    rec(1, "Mango",     "Spring"),  // earlier this year
    rec(2, "Zebra",     "January"), // the first day of the year
    rec(3, "Kiwi",      "Yearly"),  // this year, day unknown
    rec(4, "Lime",      "Monthly"), // this year, month known, day not
    rec(5, "Oak",       "Last"),    // last year, to the day
    rec(6, "Pine",      "Nowhen"),  // no date at all
  ];
  const years = { aardvark: "2026", mango: "2026", zebra: "2026", kiwi: "2026",
                  lime: "2026", oak: "2025" };
  const dates = { aardvark: "2026-09-25", mango: "2026-03-14", zebra: "2026-01-01",
                  lime: "2026-05", oak: "2025-12-31" };
  const F = build({ albums, years, dates });

  await t.test("THE report: yesterday's album heads newest-first", () => {
    const out = titles(F.libraryView({ sort: "year", dir: "desc" }));
    assert.equal(out[0], "Aardvark",
      "the album released yesterday is not first newest-first: " + out.join(", "));
  });

  await t.test("THE report, other way: it is the last DATED album oldest-first", () => {
    const out = titles(F.libraryView({ sort: "year", dir: "asc" }));
    // Last of the dated albums; only the undated one may follow it.
    assert.deepEqual(out.slice(-2), ["Aardvark", "Pine"],
      "the album released yesterday is not at the bottom oldest-first: " + out.join(", "));
  });

  await t.test("the whole order, to the day, both ways", () => {
    // A year alone reads as the START of that year, and a month alone as the
    // start of that month: a date nobody stated can never outrank one that is
    // known — above all, never above yesterday's.
    assert.deepEqual(titles(F.libraryView({ sort: "year", dir: "asc" })),
      ["Oak", "Kiwi", "Zebra", "Mango", "Lime", "Aardvark", "Pine"]);
    assert.deepEqual(titles(F.libraryView({ sort: "year", dir: "desc" })),
      ["Aardvark", "Lime", "Mango", "Zebra", "Kiwi", "Oak", "Pine"]);
  });

  await t.test("a date for some OTHER year is not used", () => {
    // setAlbumYear never stores one; the reader refuses one anyway, because the
    // year is what every other screen shows and the two must not disagree.
    const G = build({ albums, years, dates: Object.assign({}, dates, { oak: "2031-01-01" }) });
    const out = titles(G.libraryView({ sort: "year", dir: "desc" }));
    assert.equal(out[0], "Aardvark", "a mismatched date lifted an album out of its own year");
    assert.equal(out[out.length - 2], "Oak");
  });

  await t.test("two albums on the same day fall back to title, both ways", () => {
    // Listed Plum-then-Apple in the index, so a sort that dropped the title
    // tie-break would keep that order (Array#sort is stable) and fail here.
    const pair = [rec(0, "Plum", "Same"), rec(1, "Apple", "Day")];
    const G = build({ albums: pair, years: { plum: "2026", apple: "2026" },
                      dates: { plum: "2026-03-14", apple: "2026-03-14" } });
    assert.deepEqual(titles(G.libraryView({ sort: "year", dir: "asc" })), ["Apple", "Plum"]);
    assert.deepEqual(titles(G.libraryView({ sort: "year", dir: "desc" })), ["Plum", "Apple"]);
  });

  await t.test("undated means what the Decade focus means by it", () => {
    // A year that is not a number (a damaged row) is undated to albumYearOf,
    // so the Decade focus leaves it out — and this sort must hold it out of the
    // ordering too, rather than filing "n/a-00-00" among the dated albums.
    const G = build({ albums, years: Object.assign({}, years, { oak: "n/a" }), dates });
    for (const dir of ["asc", "desc"]) {
      const out = titles(G.libraryView({ sort: "year", dir }));
      assert.deepEqual(out.slice(-2), ["Oak", "Pine"],
        "dir=" + dir + ": an album the Decade focus calls undated was sorted among the " +
        "dated ones: " + out.join(", "));
    }
    assert.ok(!titles(G.libraryView({ sort: "album", decade: ["2020"] })).includes("Oak"));
  });

  await t.test("the Decade focus still reads the year alone", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "album", decade: ["2020"] })),
      ["Aardvark", "Kiwi", "Lime", "Mango", "Oak", "Zebra"]);
  });
});

// The v1.6.58 change: `dir` must mean the same thing for every sort, so that
// one arrow button can drive all of them.
test("libraryView — dir means the same thing for every sort", async (t) => {
  const stats = {
    count: new Map([["alpha", 10], ["bravo", 5], ["charlie", 1], ["delta", 0]]),
    last:  new Map([["alpha", 400], ["bravo", 300], ["charlie", 200], ["delta", 100]]),
  };
  const F = build({ stats });

  await t.test("plays desc is most-played first", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "plays", dir: "desc" })),
      ["Alpha", "Bravo", "Charlie", "Delta"],
      "desc must mean descending here exactly as it does for every other sort — " +
      "the server used to invert plays/lastplayed, which made the direction " +
      "arrow point the wrong way for these two sorts only");
  });

  await t.test("plays asc is least-played first", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "plays", dir: "asc" })),
      ["Delta", "Charlie", "Bravo", "Alpha"]);
  });

  await t.test("lastplayed desc is most-recent first", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "lastplayed", dir: "desc" })),
      ["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  await t.test("lastplayed asc is longest-ago first", () => {
    assert.deepEqual(titles(F.libraryView({ sort: "lastplayed", dir: "asc" })),
      ["Delta", "Charlie", "Bravo", "Alpha"]);
  });
});

test("libraryView — random is stable per seed and reshuffles when it changes", async (t) => {
  const F = build();

  await t.test("the same seed returns the same order every time", () => {
    const a = titles(F.libraryView({ sort: "random", seed: "42" }));
    const b = titles(F.libraryView({ sort: "random", seed: "42" }));
    assert.deepEqual(a, b,
      "paging a random wall re-requests it — an unstable order would show " +
      "duplicates and holes as the user scrolls");
    assert.equal(a.length, ALBUMS.length);
  });

  await t.test("a different seed can produce a different order", () => {
    const orders = new Set();
    for (let s = 1; s <= 12; s++) orders.add(titles(F.libraryView({ sort: "random", seed: String(s) })).join("|"));
    assert.ok(orders.size > 1, "every seed produced the same order — reshuffle is a no-op");
  });
});

test("libraryView — result caching cannot serve the wrong ordering", async (t) => {
  const F = build();

  await t.test("two different option sets do not share a cache entry", () => {
    const asc  = titles(F.libraryView({ sort: "album", dir: "asc" }));
    const desc = titles(F.libraryView({ sort: "album", dir: "desc" }));
    assert.notDeepEqual(asc, desc);
    // Re-request the first one: it must still be ascending, not whatever was
    // computed most recently.
    assert.deepEqual(titles(F.libraryView({ sort: "album", dir: "asc" })), asc);
  });
});
