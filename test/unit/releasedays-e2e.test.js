"use strict";
// ---------------------------------------------------------------------------
// v1.8.61, end to end: the library from the report, through the real pipeline.
//
// Two screenshots, the same library sorted newest-first: Roon's top was
// ACTORS, Clinic, Emile Parisien, Europe; this extension's was Beck, Rhiannon
// Giddens, The Proclaimers — every one of them wearing the Q badge.
//
// Everything below is the shipping code, extracted: the favourites harvest,
// the /music walk's harvest (tags read through fileTagDate, as the walk reads
// them), setAlbumYear's rules, the MusicBrainz day lookups (MusicBrainz itself
// stubbed to the true dates), and the Library's own sort. The true dates are
// the order Roon shows.
//
// The TAGS are the fixture's one assumption, and the one thing this test
// cannot check against the real library: the local albums' tags state only
// the year, as many taggers write them. Under it, stage 1 — every source this
// extension read before v1.8.61, at any time after a start — IS the reported
// order: the favourites are the only albums with a day, so they lead, and the
// sort orders by which source knew the day. `GET /api/debug/dates` shows,
// album by album, what the real library holds.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const K = loadIndexFunctions(
  ["albumKey", "albumKeys", "albumTitleVariants", "canonText", "canonArtist", "normalize",
   "splitCreditIntoArtists"],
  { knownArtistSet: () => new Set() });

// title, artist, the TRUE release day (what Roon sorts by), the file's tags as
// music-metadata reports them, and — for a Qobuz favourite — Qobuz's date.
//
// The days: Roon's top four came out the same Friday — its list ties them in
// artist order — and the others are what MusicBrainz states for them (checked
// live while writing this). MusicBrainz is STUBBED below to answer with these
// days; whether it knows a given album yet is a separate question, answered
// per album by /api/debug/dates (Clinic's was not in it the day after release).
const LIBRARY = [
  ["Our Love Will Live Forever", "ACTORS",           "2026-09-25", { year: 2026 },                   null],
  ["Wild In The Streets",        "Clinic",           "2026-09-25", { year: 2026, date: "2026" },     null],
  ["Floating",                   "Emile Parisien",   "2026-09-25", { year: 2026 },                   null],
  ["Come This Madness",          "Europe",           "2026-09-25", { originaldate: "2026" },         null],
  ["Ride Lonesome",              "Beck",             "2026-09-18", { year: 2026 },                   "2026-09-18"],
  ["Hope Is the Thing with Feathers", "Rhiannon Giddens", "2026-09-18", { year: 2026 },              "2026-09-18"],
  ["You May Offend",             "The Proclaimers",  "2026-09-11", { year: 2026 },                   "2026-09-11"],
  ["Necropolitan",               "Green Lung",       "2026-03-06", { year: 2026, date: "2026-03-06" }, "2026-03-06"],
  ["Kind of Blue",               "Miles Davis",      "1959-08-17", { originaldate: "1959", date: "1997", year: 1997 }, null],
];

function rec(offset, title, artist) {
  const nTitle = K.normalize(title), nArtist = K.normalize(artist);
  return { offset, title, subtitle: artist, nTitle, nArtist,
           sortTitle: nTitle.replace(/^(the|a|an) /, ""), cFirst: nArtist,
           srcKeys: K.albumKeys(title, artist) };
}

function world() {
  const albums = LIBRARY.map((r, i) => rec(i, r[0], r[1]));
  const albumYearCache = new Map(), albumYearSource = new Map();
  const albumDateCache = new Map(), albumDateSource = new Map();
  const qobuzAlbumYears = new Map(), fileAlbumYears = new Map();
  const libraryViewCache = new Map();
  const requests = [];     // albums per MusicBrainz request, in order
  const F = loadIndexFunctions(
    ["harvestAlbumYears", "addHarvestedYear", "setAlbumYear", "releaseDateOf", "yearOfDate",
     "dateRefines", "yearSourceRank", "albumYearKey", "fileTagDate",
     "runReleaseDayFill", "releaseDayFillCandidates", "recordDateFill", "dateFillRetryMs",
     "releaseDayBatches", "mbBatchUrl", "mbAlbumClause", "mbQuote", "albumTitleVariants",
     "canonText",
     "libraryView", "libraryPrefix", "libraryPrefixMax", "albumMatchesPrefix", "albumPlayKey",
     "albumYearOf", "albumDateOf", "albumAddedOf", "seededRank", "libFacetDefs", "facetMatch",
     "albumGenresOf", "albumFileFactsOf", "albumFileFacts", "rateLabel", "channelLabel",
     "libAddedWindows", "normalize"],
    {
      albumKey: K.albumKey,
      albumIndex: { albums, count: albums.length, builtAt: 1 },
      albumYearCache, albumYearSource, albumDateCache, albumDateSource,
      fileAlbumYears, qobuzAlbumYears, tidalAlbumYears: new Map(),
      ambiguousAlbumKeys: new Set(),
      dateFillTried: new Map(), dateFillRunning: false, DATE_FILL_RETRY_MS: 30 * 864e5,
      DATE_FILL_RECENT_RETRY_MS: 3 * 864e5,
      labelsIndex: { building: false },
      labelsDb: null, stmtInsertYear: null, stmtInsertDateFill: null, DEBUG: false,
      // A cache invalidation is what makes the next view re-sort.
      bumpLibraryMeta: () => libraryViewCache.clear(),
      scheduleLibraryMetaBump: () => libraryViewCache.clear(),
      scheduleLibraryDateBump: () => {},   // the run's own final bump is what shows its days
      console: { log() {}, error() {} },
      // MusicBrainz, answering with the true day — twenty albums a request,
      // and one at a time for anything a batch left unanswered.
      DATE_FILL_BATCH: 20, DATE_FILL_BATCH_URL_MAX: 4000, MB_SEARCH_PAGE: 100,
      fetchMbReleaseDays: async (batch) => {
        requests.push(batch.length);
        const found = new Map();
        for (const c of batch) {
          const day = (LIBRARY.find(r => r[0] === c.al.title) || [])[2];
          if (day) found.set(c.key, day);
        }
        return found;
      },
      fetchMbReleaseDay: async (title) => {
        requests.push(1);
        return (LIBRARY.find(r => r[0] === title) || [])[2] || null;
      },
      labelsEnabled: false,
      albumSeenCache: new Map(), albumGenreCache: new Map(), albumFileCache: new Map(),
      libraryMetaVersion: 0, libraryDateVersion: 0, libraryViewCache, LIBRARY_VIEW_CACHE_MAX: 8,
      LIB_SORTS: new Set(["album", "artist", "year", "added", "plays", "lastplayed", "random"]),
      albumSource: () => null, resolveAlbumLabelName: () => null,
      getPlayedTitlesSince: () => new Set(), playedTitleSet: () => new Set(),
      playStats: () => ({ count: new Map(), last: new Map() }),
    });
  const newestFirst = () => F.libraryView({ sort: "year", dir: "desc" }).map(a => a.subtitle);
  return { F, qobuzAlbumYears, fileAlbumYears, newestFirst, requests };
}

// Roon's order: the true days, newest first; a day's albums by artist, A→Z.
const ROON = LIBRARY.slice()
  .sort((a, b) => (a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0) ||
                  K.normalize(a[1]).localeCompare(K.normalize(b[1])))
  .map(r => r[1]);

test("the reported library, through the real pipeline", async (t) => {
  const w = world();

  // Stage 1 — what every start reads: the Qobuz favourites (seconds after
  // start) and the /music walk (minutes after pairing), in either order.
  for (const r of LIBRARY) if (r[4]) w.F.addHarvestedYear(w.qobuzAlbumYears, r[0], null, [r[1]], r[4]);
  w.F.harvestAlbumYears("stream favourites: startup");
  for (const r of LIBRARY) w.F.addHarvestedYear(w.fileAlbumYears, r[0], null, [r[1]], w.F.fileTagDate(r[3]));
  w.F.harvestAlbumYears("file tags");

  await t.test("stage 1 is the report: the only albums with a day lead", () => {
    const top = w.newestFirst().slice(0, 3);
    assert.deepEqual(top, ["Beck", "Rhiannon Giddens", "The Proclaimers"],
      "this fixture no longer reproduces what was reported, so stage 2 proves nothing");
  });

  await t.test("stage 1's years are right — it is the DAY that is missing", () => {
    // Kind of Blue: ORIGINALDATE beats the 1997 reissue's DATE, as it always has.
    assert.equal(w.newestFirst().slice(-1)[0], "Miles Davis");
  });

  // Stage 2 — a Release date view starts the MusicBrainz lookups for the rest.
  await w.F.runReleaseDayFill("Release date view");

  await t.test("every album that needed a day asked about in ONE request", () => {
    // Five albums dated only to the year (the favourites and Green Lung's tag
    // already had days). One album a request was the whole cost before v1.8.62.
    assert.deepEqual(w.requests, [5]);
  });

  await t.test("THE result: newest-first is Roon's order", () => {
    assert.deepEqual(w.newestFirst(), ROON);
  });

  await t.test("the head of it is the screenshot's, in the screenshot's order", () => {
    assert.deepEqual(w.newestFirst().slice(0, 4), ["ACTORS", "Clinic", "Emile Parisien", "Europe"]);
  });

  await t.test("oldest-first reverses the days and keeps each day's albums A→Z", () => {
    const days = [...new Set(LIBRARY.map(r => r[2]))].sort();
    const want = [];
    for (const d of days) {
      want.push(...LIBRARY.filter(r => r[2] === d).map(r => r[1])
        .sort((a, b) => K.normalize(a).localeCompare(K.normalize(b))));
    }
    assert.deepEqual(w.F.libraryView({ sort: "year", dir: "asc" }).map(a => a.subtitle), want);
  });
});
