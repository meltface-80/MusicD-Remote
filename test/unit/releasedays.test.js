"use strict";
// ---------------------------------------------------------------------------
// v1.8.61: where the Release date sort's DAYS come from, and why v1.8.60's
// order disagreed with Roon's.
//
// Reported with two screenshots: Roon's library sorted newest-first, and this
// extension's. Every one of the extension's top albums wore the Q badge; none
// of Roon's newest did.
//
// Roon publishes no release dates to an extension, so every date here comes
// from somewhere else, and a DAY only from a source that states one: the Qobuz
// favourites always do, a file's tags often stop at the year. A year alone
// sorts at the start of that year, below every album of it with a day — so the
// sort ordered by which source knew the day. MusicBrainz states the day for
// almost every album; the day lookups ask it, newest year first, day only.
//
// And the badge half of the same report: Roon was not signed in to Qobuz, the
// extension was, and local albums were badged Q. Roon's browse root says which
// services Roon has (roonServicesFromRoot).
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const TEXT = ["normalize", "canonText", "canonArtist", "albumTitleVariants"];

// ---------------------------------------------------------------------------
// The matcher: a MusicBrainz release-group search -> one day, or none.
// ---------------------------------------------------------------------------
const M = loadIndexFunctions(
  ["mbReleaseDayFrom", "creditNameSet", "mbCreditMatches", "releaseDateOf", "yearOfDate",
   "albumKeys"].concat(TEXT),
  {});

function rg(title, artist, date, type, secondary) {
  return {
    title, "first-release-date": date, "primary-type": type || "Album",
    "secondary-types": secondary || [],
    "artist-credit": [{ name: artist, artist: { name: artist } }],
  };
}

test("mbReleaseDayFrom takes a day only when it is unambiguous", async (t) => {
  await t.test("the album, its artist, its year: its day", () => {
    const groups = [rg("Wild in the Streets", "Clinic", "2026-09-25")];
    assert.equal(M.mbReleaseDayFrom(groups, "Wild In The Streets", "Clinic", "2026"), "2026-09-25");
  });

  await t.test("a day from another year is not taken — the year on file stands", () => {
    // A same-named record from another year is the commonest wrong match there
    // is, and the year check is what refuses it.
    const groups = [rg("Floating", "Emile Parisien", "2019-05-03")];
    assert.equal(M.mbReleaseDayFrom(groups, "Floating", "Emile Parisien", "2026"), null);
  });

  await t.test("another artist's record of the same name is not taken", () => {
    const groups = [rg("Floating", "Someone Else", "2026-03-14")];
    assert.equal(M.mbReleaseDayFrom(groups, "Floating", "Emile Parisien", "2026"), null);
  });

  await t.test("a year or a month is not a day", () => {
    assert.equal(M.mbReleaseDayFrom([rg("X", "A", "2026")], "X", "A", "2026"), null);
    assert.equal(M.mbReleaseDayFrom([rg("X", "A", "2026-09")], "X", "A", "2026"), null);
  });

  await t.test("the album's day, not its lead single's", () => {
    // The single of the same name comes out first, in the same year — taking
    // the earliest day, as the album page's lookup does, would date the album
    // to the single.
    const groups = [rg("Come This Madness", "Europe", "2026-06-06", "Single"),
                    rg("Come This Madness", "Europe", "2026-09-25", "Album")];
    assert.equal(M.mbReleaseDayFrom(groups, "Come This Madness", "Europe", "2026"), "2026-09-25");
  });

  await t.test("the studio album's day, not the live album's of the same name", () => {
    const groups = [rg("Hard Life", "The Tubs", "2026-11-01", "Album", ["Live"]),
                    rg("Hard Life", "The Tubs", "2026-02-13", "Album")];
    assert.equal(M.mbReleaseDayFrom(groups, "Hard Life", "The Tubs", "2026"), "2026-02-13");
  });

  await t.test("two plain albums of one name in one year: no day rather than a guess", () => {
    const groups = [rg("Untitled", "A", "2026-01-10"), rg("Untitled", "A", "2026-08-01")];
    assert.equal(M.mbReleaseDayFrom(groups, "Untitled", "A", "2026"), null);
  });

  await t.test("Roon's edition suffix still finds the album", () => {
    const groups = [rg("Floating", "Emile Parisien", "2026-03-14")];
    assert.equal(M.mbReleaseDayFrom(groups, "Floating (Deluxe Edition)", "Emile Parisien", "2026"),
      "2026-03-14");
  });

  await t.test("an exact title beats an edition-stripped one", () => {
    const groups = [rg("Floating (Live)", "Emile Parisien", "2026-10-01", "Album", ["Live"]),
                    rg("Floating", "Emile Parisien", "2026-03-14")];
    assert.equal(M.mbReleaseDayFrom(groups, "Floating", "Emile Parisien", "2026"), "2026-03-14");
  });

  await t.test("MusicBrainz's decorated title does not stand for Roon's plain one", () => {
    // Only Roon's own edition suffix is stripped. Stripping MusicBrainz's
    // would let a same-year remix album date the record it remixes whenever
    // the record itself was missing from the results.
    const groups = [rg("Hard Life (Remixes)", "The Tubs", "2026-10-09", "Album", ["Remix"])];
    assert.equal(M.mbReleaseDayFrom(groups, "Hard Life", "The Tubs", "2026"), null);
  });

  await t.test("the live album's own day when Roon's album IS the live one", () => {
    // Exact-first is what decides this: by rank alone the plainer studio album
    // of the base title would win, and the live record would take its day.
    const groups = [rg("Hard Life", "The Tubs", "2026-02-13"),
                    rg("Hard Life (Live)", "The Tubs", "2026-11-01", "Album", ["Live"])];
    assert.equal(M.mbReleaseDayFrom(groups, "Hard Life (Live)", "The Tubs", "2026"), "2026-11-01");
  });

  await t.test("a credit of several artists matches on any of them", () => {
    const g = rg("Duo", "x", "2026-04-04");
    g["artist-credit"] = [{ name: "Emile Parisien", joinphrase: " & " }, { name: "Yaron Herman" }];
    assert.equal(M.mbReleaseDayFrom([g], "Duo", "Emile Parisien / Yaron Herman", "2026"), "2026-04-04");
    assert.equal(M.mbReleaseDayFrom([g], "Duo", "Yaron Herman", "2026"), "2026-04-04");
  });

  await t.test("credits are split the way the album's own keys split them", () => {
    // A third way of reading a credit, as the first cut had, missed Roon's
    // "ft." and " + " — the album's keys have always split on both.
    const g = rg("Together", "x", "2026-05-05");
    g["artist-credit"] = [{ name: "Arlo Parks", joinphrase: " feat. " }, { name: "Phoebe Bridgers" }];
    assert.equal(M.mbReleaseDayFrom([g], "Together", "Arlo Parks ft. Phoebe Bridgers", "2026"), "2026-05-05");
    assert.equal(M.mbReleaseDayFrom([g], "Together", "Arlo Parks + Phoebe Bridgers", "2026"), "2026-05-05");
  });

  await t.test("no artist, no title, or no year: nothing is asked of the data", () => {
    const groups = [rg("X", "A", "2026-01-01")];
    assert.equal(M.mbReleaseDayFrom(groups, "X", "", "2026"), null);
    assert.equal(M.mbReleaseDayFrom(groups, "", "A", "2026"), null);
    assert.equal(M.mbReleaseDayFrom(groups, "X", "A", null), null);
    assert.equal(M.mbReleaseDayFrom(null, "X", "A", "2026"), null);
  });
});

// ---------------------------------------------------------------------------
// The lookups themselves, with MusicBrainz stubbed.
// ---------------------------------------------------------------------------
function rec(title, artist) {
  return { title, subtitle: artist, nTitle: title.toLowerCase(), nArtist: artist.toLowerCase() };
}

function fill(opts) {
  opts = opts || {};
  const albums = opts.albums || [];
  const albumYearCache = new Map(Object.entries(opts.years || {}));
  const albumYearSource = new Map(Object.entries(opts.yearSrc || {}));
  const albumDateCache = new Map(Object.entries(opts.dates || {}));
  const albumDateSource = new Map();
  const dateFillTried = new Map(Object.entries(opts.tried || {}));
  const asked = [];        // albums asked about ALONE, by title
  const batches = [];      // each batched request, as its albums' titles
  const logs = [];
  const labelsIndex = { building: false };
  const bumps = { scheduled: 0 };
  const F = loadIndexFunctions(
    ["runReleaseDayFill", "releaseDayFillCandidates", "recordDateFill", "albumYearKey",
     "setAlbumYear", "releaseDateOf", "yearOfDate", "dateRefines", "yearSourceRank",
     "dateFillRetryMs", "releaseDayBatches", "mbBatchUrl", "mbAlbumClause", "mbQuote",
     "albumTitleVariants", "canonText", "normalize", "kickReleaseDayFill"],
    {
      albumIndex: { albums, count: albums.length, builtAt: 1 },
      isIndexBuilt: () => true, DATE_FILL_KICK_MS: 60 * 60 * 1000,
      dateFillLastKick: 0, dateFillAgain: null,
      albumYearCache, albumYearSource, albumDateCache, albumDateSource, dateFillTried,
      labelsDb: null, stmtInsertYear: null, stmtInsertDateFill: null, DEBUG: false,
      labelsIndex, dateFillRunning: false,
      DATE_FILL_RETRY_MS: 30 * 24 * 60 * 60 * 1000,
      DATE_FILL_RECENT_RETRY_MS: 3 * 24 * 60 * 60 * 1000,
      DATE_FILL_BATCH: opts.batchSize || 20, DATE_FILL_BATCH_URL_MAX: 4000, MB_SEARCH_PAGE: 100,
      bumpLibraryMeta: () => {}, scheduleLibraryMetaBump: () => {},
      scheduleLibraryDateBump: () => { bumps.scheduled++; }, libraryDateVersion: 0,
      console: { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
      // The batched request. By default it answers nothing, so every album
      // falls through to the one-at-a-time pass the older tests describe.
      fetchMbReleaseDays: async (batch) => {
        batches.push(batch.map(c => c.al.title));
        if (opts.batch) return opts.batch(batch);
        return new Map();
      },
      fetchMbReleaseDay: async (title, artist, year) => {
        asked.push(title);
        if (opts.fetch) return opts.fetch(title, artist, year, labelsIndex);
        return null;
      },
    });
  return { F, albumYearCache, albumDateCache, albumDateSource, dateFillTried, asked, batches,
           logs, labelsIndex, bumps };
}

test("the release-day lookups", async (t) => {
  await t.test("asks about year-only albums, newest year first, and fills their day", async () => {
    const albums = [rec("Old", "A"), rec("New", "B"), rec("Dated", "C"), rec("Undated", "D")];
    const h = fill({
      albums,
      years: { "old||a": "1999", "new||b": "2026", "dated||c": "2026" },
      dates: { "dated||c": "2026-05-01" },
      fetch: (title) => (title === "New" ? "2026-09-25" : null),
    });
    assert.equal(await h.F.runReleaseDayFill("test"), 1);
    assert.deepEqual(h.asked, ["New", "Old"],
      "the newest year was not asked about first, or a dated/undated album was asked about");
    assert.equal(h.albumDateCache.get("new||b"), "2026-09-25");
    assert.equal(h.albumDateSource.get("new||b"), "release");
    assert.equal(h.albumYearCache.get("new||b"), "2026");
  });

  await t.test("a day can never move the year it is for", async () => {
    const h = fill({ albums: [rec("X", "A")], years: { "x||a": "2011" }, yearSrc: { "x||a": "edition" },
                     fetch: () => "1973-03-01" });
    await h.F.runReleaseDayFill("test");
    assert.equal(h.albumYearCache.get("x||a"), "2011");
    assert.equal(h.albumDateCache.has("x||a"), false);
  });

  await t.test("every answer is remembered — misses too — and not asked again", async () => {
    const h = fill({ albums: [rec("X", "A"), rec("Y", "B")], years: { "x||a": "2026", "y||b": "2026" },
                     fetch: (title) => (title === "X" ? "2026-01-02" : null) });
    await h.F.runReleaseDayFill("first");
    assert.equal(h.dateFillTried.get("y||b").day, null, "a miss was not remembered");
    assert.equal(h.dateFillTried.get("x||a").day, "2026-01-02");
    h.asked.length = 0;
    assert.equal(await h.F.runReleaseDayFill("second"), 0);
    assert.deepEqual(h.asked, [], "an album already asked about was asked again");
  });

  await t.test("an older album's miss is asked again after a month, not before", async () => {
    const days = (n) => Date.now() - n * 24 * 60 * 60 * 1000;
    const early = fill({ albums: [rec("X", "A")], years: { "x||a": "1999" },
                         tried: { "x||a": { ts: days(29), day: null } }, fetch: () => "1999-02-02" });
    assert.equal(await early.F.runReleaseDayFill("test"), 0);
    assert.deepEqual(early.asked, [], "an old album's miss was asked about again inside the month");
    const late = fill({ albums: [rec("X", "A")], years: { "x||a": "1999" },
                        tried: { "x||a": { ts: days(31), day: null } }, fetch: () => "1999-02-02" });
    assert.equal(await late.F.runReleaseDayFill("test"), 1);
  });

  await t.test("a new album's miss is asked again after three days", async () => {
    // MusicBrainz is edited by people: Clinic's album had no entry the day
    // after it came out. A month's wait would keep it off the top of a
    // newest-first list for exactly the weeks it is newest.
    const days = (n) => Date.now() - n * 24 * 60 * 60 * 1000;
    const thisYear = String(new Date().getUTCFullYear());
    const lastYear = String(new Date().getUTCFullYear() - 1);
    for (const year of [thisYear, lastYear]) {
      const early = fill({ albums: [rec("X", "A")], years: { "x||a": year },
                           tried: { "x||a": { ts: days(2), day: null } }, fetch: () => year + "-02-02" });
      assert.equal(await early.F.runReleaseDayFill("test"), 0, year + ": asked again inside three days");
      const late = fill({ albums: [rec("X", "A")], years: { "x||a": year },
                          tried: { "x||a": { ts: days(4), day: null } }, fetch: () => year + "-02-02" });
      assert.equal(await late.F.runReleaseDayFill("test"), 1, year + ": not asked again after three days");
    }
    // ...and the boundary: two years back is an older record, on the month.
    const older = String(new Date().getUTCFullYear() - 2);
    const h = fill({ albums: [rec("X", "A")], years: { "x||a": older },
                     tried: { "x||a": { ts: days(4), day: null } }, fetch: () => older + "-02-02" });
    assert.equal(await h.F.runReleaseDayFill("test"), 0, older + ": asked again after only three days");
  });

  await t.test("a failed REQUEST is not an answer: not remembered, and five in a row stop it", async () => {
    const albums = [];
    const years = {};
    for (let i = 0; i < 8; i++) { albums.push(rec("T" + i, "A")); years["t" + i + "||a"] = "2026"; }
    const h = fill({ albums, years, fetch: () => { throw new Error("HTTP 503"); } });
    assert.equal(await h.F.runReleaseDayFill("test"), 0);
    assert.equal(h.asked.length, 5, "it kept asking a MusicBrainz that was not answering");
    assert.equal(h.dateFillTried.size, 0, "a failed request was recorded as the album having no day");
  });

  await t.test("a label scan starting does not stop it — the limiter is one queue now", async () => {
    // It used to stand down, because two loops through the old limiter could
    // fire together. That cost an hour: the kick had already been spent, so
    // nothing resumed until the next Release date view an hour later.
    const h = fill({ albums: [rec("X", "A"), rec("Y", "B")], years: { "x||a": "2026", "y||b": "2025" },
                     fetch: (title, artist, year, labelsIndex) => { labelsIndex.building = true; return null; } });
    await h.F.runReleaseDayFill("test");
    assert.deepEqual(h.asked, ["X", "Y"], "it stopped when the label scan started");
  });

  await t.test("an album with no credited artist is never asked about", async () => {
    const h = fill({ albums: [rec("X", "")], years: { "x||": "2026" }, fetch: () => "2026-01-01" });
    await h.F.runReleaseDayFill("test");
    assert.deepEqual(h.asked, []);
  });
});

// ---------------------------------------------------------------------------
// Roon's browse root -> which services Roon itself is signed in to.
// ---------------------------------------------------------------------------
test("roonServicesFromRoot reads the services off Roon's browse root", async (t) => {
  const R = loadIndexFunctions(["roonServicesFromRoot"], {});

  await t.test("a root without Qobuz is a Roon without Qobuz", () => {
    assert.deepEqual(R.roonServicesFromRoot(["Library", "Playlists", "Internet Radio", "Genres", "Settings"]),
      { qobuz: false, tidal: false, other: false });
  });

  await t.test("the services it lists are the services it has", () => {
    assert.deepEqual(R.roonServicesFromRoot(["Library", "Playlists", "TIDAL", "Qobuz", "Settings"]),
      { qobuz: true, tidal: true, other: false });
    assert.deepEqual(R.roonServicesFromRoot(["Library", "Tidal"]), { qobuz: false, tidal: true, other: false });
  });

  await t.test("a service this extension cannot see into is noted as one", () => {
    // Its albums can be neither claimed nor ruled out, so it alone stops
    // "every album is local".
    assert.equal(R.roonServicesFromRoot(["Library", "KKBOX"]).other, true);
    assert.equal(R.roonServicesFromRoot(["Library", "nugs.net"]).other, true);
  });

  await t.test("THE guard: a list that is not the root proves nothing", () => {
    // A read that landed somewhere else must not conclude "no Qobuz" and take
    // every Qobuz badge away from a Roon that really has it.
    assert.equal(R.roonServicesFromRoot(["Albums", "Artists", "Tracks"]), null);
    assert.equal(R.roonServicesFromRoot([]), null);
    assert.equal(R.roonServicesFromRoot(null), null);
  });
});

// ---------------------------------------------------------------------------
// GET /api/debug/dates — the instrument for the next report of this kind.
// ---------------------------------------------------------------------------
test("releaseDateReport says why each album sits where it does", async (t) => {
  const albums = [
    { title: "Wild In The Streets", subtitle: "Clinic", nTitle: "wild in the streets", nArtist: "clinic",
      srcKeys: ["wild in streets||clinic"] },
    { title: "Ride Lonesome", subtitle: "Beck", nTitle: "ride lonesome", nArtist: "beck",
      srcKeys: ["ride lonesome||beck"] },
    { title: "Old One", subtitle: "Band", nTitle: "old one", nArtist: "band", srcKeys: ["old one||band"] },
    { title: "Nowhen", subtitle: "Band", nTitle: "nowhen", nArtist: "band", srcKeys: ["nowhen||band"] },
  ];
  const years = new Map([["wild in the streets||clinic", "2026"], ["ride lonesome||beck", "2026"],
                         ["old one||band", "1999"]]);
  const dates = new Map([["ride lonesome||beck", "2026-09-18"], ["old one||band", "1999-05"]]);
  const R = loadIndexFunctions(
    ["releaseDateReport", "albumDateOf", "albumYearOf", "albumYearKey",
     "releaseDayFillCandidates", "dateFillRetryMs"].concat(TEXT),
    {
      albumIndex: { albums, count: albums.length, builtAt: 1 },
      albumYearCache: years, albumDateCache: dates,
      albumYearSource: new Map([["wild in the streets||clinic", "file"], ["ride lonesome||beck", "file"]]),
      albumDateSource: new Map([["ride lonesome||beck", "release"]]),
      dateFillTried: new Map([["wild in the streets||clinic", { ts: 1790000000000, day: null }]]),
      // The order, as the real sort gives it for these dates.
      libraryView: () => [albums[1], albums[0], albums[2], albums[3]],
      albumSource: () => "local", sourceBadgesDistinguish: () => false,
      localAlbumKeys: new Set(["wild in streets||clinic"]),
      qobuzAlbumKeys: new Set(["ride lonesome||beck"]),
      roonServices: { qobuz: false, tidal: false },
      qobuzReady: () => true, tidalReady: () => false, claimingServices: () => [],
      _fileScanRunning: false,
      dateFillRunning: false, dateFillLastKick: 0,
      DATE_FILL_RETRY_MS: 30 * 864e5, DATE_FILL_RECENT_RETRY_MS: 3 * 864e5,
    });

  const r = R.releaseDateReport({});
  await t.test("coverage: to the day, to the month, year only, undated", () => {
    assert.deepEqual(r.coverage, { albums: 4, to_the_day: 1, to_the_month: 1, year_only: 1, undated: 1 });
  });

  await t.test("the services question is answered from both sides", () => {
    assert.deepEqual(r.roon_services, { qobuz: false, tidal: false });
    assert.deepEqual(r.extension_signed_in, { qobuz: true, tidal: false });
  });

  await t.test("an album looked up by name shows its position and every reason", () => {
    const q = R.releaseDateReport({ q: "clinic" });
    assert.equal(q.albums.length, 1);
    const a = q.albums[0];
    assert.equal(a.position, 2);
    assert.equal(a.year, "2026");
    assert.equal(a.year_source, "file");
    assert.equal(a.date, null, "a year-only album reported a date");
    assert.equal(a.sorts_as, "2026-00-00");
    assert.equal(a.local_file, true);
    assert.equal(a.qobuz_favourite, false);
    assert.deepEqual(a.musicbrainz_lookup, { at: new Date(1790000000000).toISOString(), day: null });
  });

  await t.test("the default list is the top of the newest-first order", () => {
    assert.deepEqual(r.albums.map(a => a.title), ["Ride Lonesome", "Wild In The Streets", "Old One", "Nowhen"]);
    assert.equal(r.albums[0].date_source, "release");
    assert.equal(r.albums[0].qobuz_favourite, true);
    assert.equal(R.releaseDateReport({ limit: "1" }).albums.length, 1);
  });
});

// ---------------------------------------------------------------------------
// v1.8.61 review: how MusicBrainz is asked, and how often.
// ---------------------------------------------------------------------------
test("the release-day query finds an edition-suffixed title", async (t) => {
  // Checked against MusicBrainz itself in review: the phrase
  // release:"In Rainbows (Deluxe Edition)" matches nothing there, so the
  // matcher's edition-stripped rung never saw a candidate and the album was
  // recorded as having no day for a month.
  const urls = [];
  const Q = loadIndexFunctions(["fetchMbReleaseDay", "mbQuote"], {
    mbWait: async () => {}, MB_USER_AGENT: "test",
    httpJson: async (url) => { urls.push(decodeURIComponent(url)); return { "release-groups": [] }; },
    mbReleaseDayFrom: () => null,
  });
  await Q.fetchMbReleaseDay("In Rainbows (Deluxe Edition)", "Radiohead", "2007");
  // Lucene-escaped: a bare parenthesis inside the terms group would close it.
  const want = '(release:"In Rainbows \\(Deluxe Edition\\)" OR release:(In Rainbows \\(Deluxe Edition\\))) AND artist:"Radiohead"';
  assert.ok(urls[0].includes(want),
    "the query is the phrase alone, which finds nothing for a decorated title: " + urls[0]);
});

test("MusicBrainz is asked one request at a time", async (t) => {
  // The limiter read the clock, slept, then wrote it — so callers that arrived
  // together slept together and fired in the same millisecond. With the day
  // lookups running for an hour, every album-page lookup would have landed on
  // top of one of theirs.
  let now = 100000;
  const W = loadIndexFunctions(["mbWait"], {
    mbLastReq: now - 50,              // a request went out 50 ms ago
    mbQueue: Promise.resolve(),
    Date: { now: () => now },
    setTimeout: (fn, ms) => { now += ms; fn(); },
  });
  const fired = [];
  await Promise.all([1, 2, 3].map(() => W.mbWait().then(() => fired.push(now))));
  assert.equal(fired.length, 3);
  for (let i = 1; i < fired.length; i++) {
    assert.ok(fired[i] - fired[i - 1] >= 1100,
      "two MusicBrainz requests went out " + (fired[i] - fired[i - 1]) + " ms apart: " + fired.join(", "));
  }
});

test("the lookups re-sort only the date views, and not on every answer", async (t) => {
  const albums = [rec("A", "X"), rec("B", "Y")];
  const bumps = { meta: 0, dateScheduled: 0 };
  const F = loadIndexFunctions(
    ["runReleaseDayFill", "releaseDayFillCandidates", "recordDateFill", "albumYearKey",
     "setAlbumYear", "releaseDateOf", "yearOfDate", "dateRefines", "yearSourceRank",
     "dateFillRetryMs", "releaseDayBatches", "mbBatchUrl", "mbAlbumClause", "mbQuote",
     "albumTitleVariants", "canonText", "normalize"],
    {
      albumIndex: { albums, count: 2, builtAt: 1 },
      DATE_FILL_BATCH: 20, DATE_FILL_BATCH_URL_MAX: 4000, MB_SEARCH_PAGE: 100,
      fetchMbReleaseDays: async () => new Map(),
      albumYearCache: new Map([["a||x", "2026"], ["b||y", "2026"]]), albumYearSource: new Map(),
      albumDateCache: new Map(), albumDateSource: new Map(), dateFillTried: new Map(),
      labelsDb: null, stmtInsertYear: null, stmtInsertDateFill: null, DEBUG: false,
      labelsIndex: { building: false }, dateFillRunning: false, DATE_FILL_RETRY_MS: 1,
      DATE_FILL_RECENT_RETRY_MS: 1,
      libraryDateVersion: 0,
      bumpLibraryMeta: () => { bumps.meta++; },
      scheduleLibraryMetaBump: () => { bumps.meta++; },
      scheduleLibraryDateBump: () => { bumps.dateScheduled++; },
      console: { log() {}, error() {} },
      fetchMbReleaseDay: async () => "2026-02-02",
    });
  assert.equal(await F.runReleaseDayFill("test"), 2);
  assert.equal(bumps.meta, 0,
    "the day lookups invalidated every ordering and the genre lists, not just the date views");
  assert.equal(bumps.dateScheduled, 2, "the date views were never scheduled for a re-sort");
});

test("the album page keeps MusicBrainz's YEAR, never its day", async (t) => {
  // v1.8.60 stored the day of the EARLIEST of five loose hits for the title —
  // for a new album that is as often the lead single as the album itself, and
  // once an album has a day the lookups pass it by. The day comes from the
  // strict matcher (mbReleaseDayFrom) or not at all.
  // releaseDateOf extracted too, so a mutation that keeps the day fails on the
  // VALUE rather than on a missing function.
  const Y = loadIndexFunctions(["fetchAlbumYear", "yearOfDate", "releaseDateOf"], {
    normalize: (s) => String(s).toLowerCase(), mbCache: new Map(), mbWait: async () => {},
    mbQuote: (s) => s, MB_USER_AGENT: "test", DEBUG: false,
    httpJson: async () => ({ "release-groups": [
      { title: "Floating", "first-release-date": "2026-09-19", "primary-type": "Album" },
      { title: "Floating", "first-release-date": "2026-07-04", "primary-type": "Single" },
    ] }),
  });
  assert.equal(await Y.fetchAlbumYear("Floating", "Emile Parisien"), "2026");
});

// ---------------------------------------------------------------------------
// v1.8.62: many albums a request, started without waiting to be asked.
// ---------------------------------------------------------------------------
const BATCHING = ["mbBatchUrl", "mbAlbumClause", "mbQuote", "albumTitleVariants", "canonText", "normalize"];

test("mbAlbumClause: the title, its edition-stripped forms, and the artist", () => {
  const C = loadIndexFunctions(["mbAlbumClause", "mbQuote", "albumTitleVariants", "canonText", "normalize"], {});
  assert.equal(C.mbAlbumClause("In Rainbows (Deluxe Edition)", "Radiohead"),
    '(release:("In Rainbows \\(Deluxe Edition\\)" OR "in rainbows") AND artist:"Radiohead")');
  assert.equal(C.mbAlbumClause("Floating", "Emile Parisien"),
    '(release:("Floating") AND artist:"Emile Parisien")');
});

test("fetchMbReleaseDays: one request, and only the days it FOUND", async (t) => {
  const urls = [];
  const mk = (json) => loadIndexFunctions(["fetchMbReleaseDays"].concat(BATCHING), {
    mbWait: async () => {}, MB_USER_AGENT: "test", MB_SEARCH_PAGE: 100,
    httpJson: async (url) => { urls.push(decodeURIComponent(url)); return json; },
    // Stand-in matcher: the real one is tested above; here only the plumbing is.
    mbReleaseDayFrom: (groups, title, artist, year, seen) => {
      const g = groups.find(x => x.title === title);
      if (g && seen) seen.listed = true;
      return g ? g.day : null;
    },
  });
  const batch = [{ key: "a||x", al: { title: "A", subtitle: "X" }, year: "2026" },
                 { key: "b||y", al: { title: "B", subtitle: "Y" }, year: "2026" }];

  await t.test("both albums in one request, a hundred results a page", async () => {
    await mk({ count: 0, "release-groups": [] }).fetchMbReleaseDays(batch);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('(release:("A") AND artist:"X") OR (release:("B") AND artist:"Y")'), urls[0]);
    assert.ok(urls[0].endsWith("&fmt=json&limit=100"), urls[0]);
  });

  await t.test("a miss is ABSENT — a batch miss proves nothing, so it is never recorded as none", async () => {
    const got = await mk({ count: 1, "release-groups": [{ title: "A", day: "2026-09-25" }] }).fetchMbReleaseDays(batch);
    assert.deepEqual([...got], [["a||x", "2026-09-25"]]);
  });

  await t.test("an album LISTED with no day is answered — asking it alone would find the same", async () => {
    const got = await mk({ count: 1, "release-groups": [{ title: "B", day: null }] }).fetchMbReleaseDays(batch);
    assert.deepEqual([...got], [["b||y", null]]);
  });

  await t.test("a full page is not read at all: some album's release groups may be on the next", async () => {
    const got = await mk({ count: 150, "release-groups": [{ title: "A", day: "2026-09-25" }] }).fetchMbReleaseDays(batch);
    assert.equal(got, null, "a day read off a truncated page can be the lead single's");
    assert.equal(await mk({ "release-groups": [] }).fetchMbReleaseDays(batch), null,
      "no count at all is not proof of a whole page either");
  });
});

test("releaseDayBatches: twenty a request, in order, and no over-long URL", () => {
  const B = loadIndexFunctions(["releaseDayBatches"].concat(BATCHING),
    { DATE_FILL_BATCH: 20, DATE_FILL_BATCH_URL_MAX: 4000, MB_SEARCH_PAGE: 100 });
  const todo = Array.from({ length: 45 }, (_, i) =>
    ({ key: "k" + i, al: { title: "Album " + i, subtitle: "Artist " + i }, year: "2026" }));
  const out = B.releaseDayBatches(todo);
  assert.deepEqual(out.map(b => b.length), [20, 20, 5]);
  assert.deepEqual(out.flat().map(c => c.key), todo.map(c => c.key), "the newest-first order was lost");
  const long = Array.from({ length: 20 }, (_, i) =>
    ({ key: "l" + i, al: { title: "Title " + i + " " + "x".repeat(300), subtitle: "Artist" }, year: "2026" }));
  const cut = B.releaseDayBatches(long);
  assert.ok(cut.length > 1, "twenty very long titles went into one request");
  for (const b of cut) assert.ok(b.length === 1 || B.mbBatchUrl(b).length <= 4000);
  assert.deepEqual(cut.flat().map(c => c.key), long.map(c => c.key));
});

test("the lookups, many albums a request", async (t) => {
  await t.test("a batch's answers are taken; what it missed is asked alone, in order", async () => {
    const albums = [rec("A", "X"), rec("B", "Y"), rec("C", "Z")];
    const h = fill({ albums, years: { "a||x": "2026", "b||y": "2025", "c||z": "2026" },
      batch: () => new Map([["a||x", "2026-09-25"]]),
      fetch: (title) => (title === "C" ? "2026-01-02" : null) });
    assert.equal(await h.F.runReleaseDayFill("test"), 2);
    assert.deepEqual(h.batches, [["A", "C", "B"]], "not one request, newest year first");
    assert.deepEqual(h.asked, ["C", "B"], "the batch's misses were not asked alone, in order");
    assert.equal(h.albumDateCache.get("a||x"), "2026-09-25");
    assert.equal(h.albumDateCache.get("c||z"), "2026-01-02");
    assert.equal(h.dateFillTried.get("b||y").day, null, "a miss ALONE is an answer, and is remembered");
  });

  await t.test("a batch's 'listed, no day' is remembered as a miss, not asked again alone", async () => {
    const h = fill({ albums: [rec("Old", "X")], years: { "old||x": "1971" },
      batch: () => new Map([["old||x", null]]), fetch: () => "1971-03-19" });
    assert.equal(await h.F.runReleaseDayFill("test"), 0);
    assert.deepEqual(h.asked, [], "an album MusicBrainz lists without a day was asked about again");
    assert.equal(h.dateFillTried.get("old||x").day, null);
  });

  await t.test("a full page is split until it can be read — down to one album, then alone", async () => {
    const albums = ["T0", "T1", "T2", "T3"].map(t => rec(t, "A"));
    const years = {}; for (const a of albums) years[a.nTitle + "||a"] = "2026";
    const h = fill({ albums, years,
      batch: (b) => (b.length > 1 || b[0].al.title === "T3" ? null
                     : new Map([[b[0].key, "2026-02-1" + b[0].al.title.slice(1)]])),
      fetch: () => "2026-03-03" });
    assert.equal(await h.F.runReleaseDayFill("test"), 4);
    assert.deepEqual(h.batches.map(b => b.length), [4, 2, 1, 1, 2, 1, 1]);
    assert.deepEqual(h.asked, ["T3"], "an album no page could hold was never asked alone");
    assert.equal(h.albumDateCache.get("t0||a"), "2026-02-10");
    assert.equal(h.albumDateCache.get("t3||a"), "2026-03-03");
  });

  await t.test("a refused batch is asked once more after the rest", async () => {
    const albums = [rec("A", "X"), rec("B", "Y")];
    let refusals = 0;
    const h = fill({ albums, years: { "a||x": "2026", "b||y": "2026" }, batchSize: 1,
      batch: (b) => {
        if (b[0].al.title === "A" && refusals++ === 0) throw new Error("HTTP 503");
        return new Map([[b[0].key, "2026-05-05"]]);
      } });
    assert.equal(await h.F.runReleaseDayFill("test"), 2);
    assert.deepEqual(h.batches, [["A"], ["B"], ["A"]]);
    assert.equal(h.dateFillTried.size, 2);
  });

  await t.test("five refused requests in a row stop it, and record nothing", async () => {
    const albums = ["A", "B", "C"].map(t => rec(t, "X"));
    const years = {}; for (const a of albums) years[a.nTitle + "||x"] = "2026";
    const h = fill({ albums, years, batchSize: 1, batch: () => { throw new Error("HTTP 503"); } });
    assert.equal(await h.F.runReleaseDayFill("test"), 0);
    assert.equal(h.batches.length, 5, "it kept asking a MusicBrainz that was not answering");
    assert.deepEqual(h.asked, [], "it went on to ask one at a time after MusicBrainz stopped answering");
    assert.equal(h.dateFillTried.size, 0, "a refused request was recorded as the album having no day");
  });
});

test("kickReleaseDayFill: new albums start it at once; a view at most hourly", async (t) => {
  const tick = () => new Promise(r => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  let open;
  const gate = new Promise(r => { open = r; });
  const albums = [rec("A", "X")];
  const h = fill({ albums, years: { "a||x": "2026" },
    batch: async (b) => { if (b[0].al.title === "A") await gate; return new Map(); } });

  h.F.kickReleaseDayFill("Release date view");
  await settle();
  assert.deepEqual(h.batches, [["A"]], "a Release date view did not start the lookups");

  // While it runs, a walk finds a new album dated only to the year...
  albums.push(rec("B", "Y"));
  h.albumYearCache.set("b||y", "2026");
  h.F.kickReleaseDayFill("another view");           // a view: ignored while running
  h.F.kickReleaseDayFill("after the /music walk", true);
  open();
  await settle();
  assert.deepEqual(h.batches, [["A"], ["B"]],
    "the walk's new album waited for the next view instead of being asked straight after the run");

  // Everything asked now. A view within the hour starts nothing; new albums do.
  albums.push(rec("C", "Z"));
  h.albumYearCache.set("c||z", "2026");
  h.F.kickReleaseDayFill("Release date view");
  await settle();
  assert.equal(h.batches.length, 2, "a view inside the hour started another run");
  h.F.kickReleaseDayFill("after the favourites read", true);
  await settle();
  assert.deepEqual(h.batches[2], ["C"], "a forced start was throttled like a view");
});

test("the album page: the sort's own date, and its day looked up on the spot", async (t) => {
  function page(opts) {
    const albumYearCache = new Map(Object.entries(opts.years || {}));
    const albumDateCache = new Map(Object.entries(opts.dates || {}));
    const dateFillTried = new Map(Object.entries(opts.tried || {}));
    const asked = [];
    const P = loadIndexFunctions(
      ["lookUpAlbumDay", "storedReleaseDate", "recordDateFill", "setAlbumYear", "releaseDateOf",
       "yearOfDate", "dateRefines", "yearSourceRank", "dateFillRetryMs"],
      {
        albumYearCache, albumYearSource: new Map(), albumDateCache, albumDateSource: new Map(),
        dateFillTried, labelsDb: null, stmtInsertYear: null, stmtInsertDateFill: null, DEBUG: false,
        DATE_FILL_RETRY_MS: 30 * 864e5, DATE_FILL_RECENT_RETRY_MS: 3 * 864e5,
        bumpLibraryMeta: () => {}, scheduleLibraryDateBump: () => {},
        console: { log() {}, error() {} },
        fetchMbReleaseDay: async (title, artist, year) => { asked.push(title); return opts.fetch(year); },
      });
    return { P, asked, albumDateCache, dateFillTried };
  }

  await t.test("a day already known is shown, and nothing is asked", async () => {
    const h = page({ years: { "k": "2026" }, dates: { "k": "2026-09-25" }, fetch: () => "2026-01-01" });
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "A"), false);
    assert.deepEqual(h.asked, []);
    assert.equal(h.P.storedReleaseDate("k"), "2026-09-25");
  });

  await t.test("a year and no day: asked now, stored, shown — and not asked again", async () => {
    const h = page({ years: { "k": "2026" }, fetch: (y) => y + "-09-25" });
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "A"), true);
    assert.equal(h.P.storedReleaseDate("k"), "2026-09-25");
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "A"), false);
    assert.deepEqual(h.asked, ["T"]);
  });

  await t.test("a miss is remembered; the page shows the year", async () => {
    const h = page({ years: { "k": "2026" }, fetch: () => null });
    await h.P.lookUpAlbumDay("k", "T", "A");
    await h.P.lookUpAlbumDay("k", "T", "A");
    assert.deepEqual(h.asked, ["T"], "a miss was asked about again on the next open");
    assert.equal(h.P.storedReleaseDate("k"), "2026");
  });

  await t.test("a refused request is not remembered — the next open asks again", async () => {
    let n = 0;
    const h = page({ years: { "k": "2026" }, fetch: () => { if (n++ === 0) throw new Error("HTTP 503"); return "2026-02-02"; } });
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "A"), false);
    assert.equal(h.dateFillTried.size, 0);
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "A"), true);
  });

  await t.test("no year, no artist: nothing is asked", async () => {
    const h = page({ years: { "k": "2026" }, fetch: () => "2026-02-02" });
    assert.equal(await h.P.lookUpAlbumDay("none", "T", "A"), false);
    assert.equal(await h.P.lookUpAlbumDay("k", "T", "  "), false);
    assert.deepEqual(h.asked, []);
    assert.equal(h.P.storedReleaseDate("none"), null);
  });

  await t.test("a day for some other year is never shown", async () => {
    const h = page({ years: { "k": "2026" }, dates: { "k": "2025-12-31" }, fetch: () => null });
    assert.equal(h.P.storedReleaseDate("k"), "2026");
  });
});

test("mbReleaseDayFrom reports an album listed without a day (v1.8.62)", () => {
  const groups = [
    rg("Songs of Love and Hate", "Leonard Cohen", "1971", "Album"),
    rg("Songs of Love and Hate", "Someone Else", "1971-03-19", "Album"),
  ];
  const seen = {};
  assert.equal(M.mbReleaseDayFrom(groups, "Songs of Love and Hate", "Leonard Cohen", "1971", seen), null);
  assert.equal(seen.listed, true, "MusicBrainz's year-only entry for the album was not noticed");
  const other = {};
  M.mbReleaseDayFrom(groups, "Songs of Love and Hate", "Leonard Cohen", "1972", other);
  assert.equal(other.listed, undefined, "an entry for another YEAR counted as this album listed");
  const none = {};
  M.mbReleaseDayFrom(groups, "Songs of Hate", "Leonard Cohen", "1971", none);
  assert.equal(none.listed, undefined, "another title counted as this album listed");
});
