"use strict";
// ---------------------------------------------------------------------------
// v1.8.65: live state — the server half.
//
// The report: the Home "Library" row showed an order (and source badges) the
// Library wall it heads had long since stopped showing. The row counted itself
// fresh whenever the SORT matched, so a copy saved under the current sort was
// reused across visits, cold opens and upgrades. The fix is a contract: every
// screen shows what the server holds NOW, and the server says cheaply when
// that has moved. These tests hold the server's end of it:
//
//   * liveRevisions reports one revision per kind of data, each moving with
//     the thing it names and nothing else — a revision that moves too often
//     costs requests, one that does not move is the stale screen again;
//   * the memoised library views key on plays where they READ plays, or a
//     Most played wall re-read after a play gets the order from before it;
//   * the random rows are a DRAW that can be re-read: a seed fixes it, and a
//     re-read returns the same albums less any that stopped qualifying.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

function revisions(over) {
  const inj = Object.assign({
    albumIndex: { builtAt: 1000 },
    libraryMetaVersion: 3,
    libraryDateVersion: 4,
    playsVersion: 5,
    settingsVersion: 6,
    labelsEnabled: true,
    labelsIndex: { builtAt: 2000, map: new Map([["a", {}], ["b", {}]]) },
    picksVersion: 7,
    discoverVersion: 8,
    smartDayKey: () => "2026-09-27",
  }, over || {});
  return loadIndexFunctions(["liveRevisions"], inj).liveRevisions();
}

test("liveRevisions: one revision per kind of data, moving with it and nothing else", async (t) => {
  const base = revisions();

  await t.test("every key the app follows is there, as a string", () => {
    assert.deepEqual(Object.keys(base).sort(),
      ["dates", "day", "discover", "labels", "library", "picks", "plays", "settings", "snapshot"]);
    for (const [k, v] of Object.entries(base)) assert.equal(typeof v, "string", k + " is not a string");
  });

  await t.test("THE one: a year or a badge arriving moves `library` and NOT `snapshot`", () => {
    // `snapshot` is what the genre buttons follow, and those are read from the
    // Core. Moving it on every metadata bump would cost a Core browse every
    // twenty seconds of a label scan while Home is on screen.
    const bumped = revisions({ libraryMetaVersion: 4 });
    assert.notEqual(bumped.library, base.library, "a metadata bump did not move `library`");
    assert.equal(bumped.snapshot, base.snapshot, "a metadata bump moved `snapshot`");
  });

  await t.test("a rebuilt index moves both", () => {
    const rebuilt = revisions({ albumIndex: { builtAt: 1001 } });
    assert.notEqual(rebuilt.snapshot, base.snapshot);
    assert.notEqual(rebuilt.library, base.library);
  });

  await t.test("each counter moves its own key only", () => {
    const cases = {
      dates:    { libraryDateVersion: 9 },
      plays:    { playsVersion: 9 },
      settings: { settingsVersion: 9 },
      picks:    { picksVersion: 9 },
      discover: { discoverVersion: 9 },
      day:      { smartDayKey: () => "2026-09-28" },
    };
    for (const [key, over] of Object.entries(cases)) {
      const moved = revisions(over);
      for (const k of Object.keys(base)) {
        if (k === key) assert.notEqual(moved[k], base[k], key + " did not move");
        else assert.equal(moved[k], base[k], "changing " + key + " also moved " + k);
      }
    }
  });

  await t.test("labels moves with the scan, the switch and a rebuilt label index", () => {
    assert.notEqual(revisions({ labelsEnabled: false }).labels, base.labels);
    assert.notEqual(revisions({ labelsIndex: { builtAt: 2000, map: new Map([["a", {}]]) } }).labels, base.labels);
    assert.notEqual(revisions({ labelsIndex: { builtAt: 2001, map: new Map([["a", {}], ["b", {}]]) } }).labels,
      base.labels);
  });
});

// ---------------------------------------------------------------------------
// The view cache and plays.
// ---------------------------------------------------------------------------
function rec(offset, title, artist) {
  return {
    offset, title, subtitle: artist,
    nTitle: title.toLowerCase(), nArtist: artist.toLowerCase(),
    sortTitle: title.toLowerCase(), cFirst: artist.toLowerCase(),
    srcKeys: [title.toLowerCase() + "||" + artist.toLowerCase()],
  };
}
const ALBUMS = [rec(0, "Alpha", "A"), rec(1, "Bravo", "B"), rec(2, "Charlie", "C")];

// Two loads of libraryView sharing ONE cache, the way the live process does:
// the second load is the same server after `playsVersion` has moved (or not).
function viewAt(playsVersion, cache, stats) {
  return loadIndexFunctions(
    ["libraryView", "libraryPrefix", "libraryPrefixMax", "albumMatchesPrefix", "normalize",
     "albumPlayKey", "albumYearOf", "albumYearKey", "albumDateOf", "albumAddedOf", "seededRank",
     "libFacetDefs", "facetMatch", "albumGenresOf", "albumFileFactsOf", "albumFileFacts",
     "rateLabel", "channelLabel", "libAddedWindows"],
    {
      labelsEnabled: true,
      albumYearCache: new Map([["alpha||a", "1990"], ["bravo||b", "2000"], ["charlie||c", "2010"]]),
      albumDateCache: new Map(), albumSeenCache: new Map(),
      albumGenreCache: new Map(), albumFileCache: new Map(),
      albumIndex: { albums: ALBUMS.slice(), builtAt: 1, count: ALBUMS.length },
      libraryMetaVersion: 0, libraryDateVersion: 0, playsVersion,
      libraryViewCache: cache, LIBRARY_VIEW_CACHE_MAX: 8,
      LIB_SORTS: new Set(["album", "artist", "year", "added", "plays", "lastplayed", "random"]),
      albumSource: () => null, resolveAlbumLabelName: () => null,
      getPlayedTitlesSince: () => new Set(Object.keys(stats.count)),
      playedTitleSet: () => new Set(Object.keys(stats.count)),
      playStats: () => ({ count: new Map(Object.entries(stats.count)), last: new Map() }),
    }).libraryView;
}
const titles = (list) => list.map(a => a.title);

test("the view cache cannot serve a play-ordered view from before a play", async (t) => {
  await t.test("THE one: a play re-sorts Most played once playsVersion moves", () => {
    const cache = new Map();
    const before = viewAt(0, cache, { count: { alpha: 5, bravo: 1 } });
    assert.deepEqual(titles(before({ sort: "plays", dir: "desc" })), ["Alpha", "Bravo", "Charlie"]);
    // Charlie is played ten times. The server bumps playsVersion with each play.
    const after = viewAt(1, cache, { count: { alpha: 5, bravo: 1, charlie: 10 } });
    assert.deepEqual(titles(after({ sort: "plays", dir: "desc" })), ["Charlie", "Alpha", "Bravo"],
      "the Most played order is the one memoised before the play — the view's signature " +
      "does not include playsVersion, so a live re-read of the wall changes nothing");
  });

  await t.test("the Listening focus reads plays too", () => {
    const cache = new Map();
    const before = viewAt(0, cache, { count: { alpha: 1 } });
    assert.deepEqual(titles(before({ sort: "album", dir: "asc", played: "never" })), ["Bravo", "Charlie"]);
    const after = viewAt(1, cache, { count: { alpha: 1, bravo: 1 } });
    assert.deepEqual(titles(after({ sort: "album", dir: "asc", played: "never" })), ["Charlie"],
      "a Never played view still lists an album played since it was first asked for");
  });

  await t.test("an order that reads no plays is NOT re-sorted by one", () => {
    // Every track change bumps playsVersion. Keying views that never read the
    // plays table on it would re-sort the whole library every few minutes for
    // nothing — the reason the key is conditional at all.
    const cache = new Map();
    const first = viewAt(0, cache, { count: {} })({ sort: "year", dir: "desc" });
    const again = viewAt(1, cache, { count: { alpha: 3 } })({ sort: "year", dir: "desc" });
    assert.equal(again, first, "a plays bump invalidated a Release date view, which reads no plays");
  });
});

// ---------------------------------------------------------------------------
// Seeded draws.
// ---------------------------------------------------------------------------
const S = loadIndexFunctions(["seededPick", "seededMix", "seededRank", "requestSeed", "pickFromIndex"], {
  withSource: (a) => a,
});

function pool(n, len) {
  // Keys of one fixed length when `len` is given: the case seededRank handles
  // worst, because the seed then shifts every key by the same amount.
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = len ? ("t" + String(i).padStart(len - 1, "0")) : ("title " + i);
    out.push({ offset: i, title: t, subtitle: "x", nTitle: t, nArtist: "x", image_key: null });
  }
  return out;
}

test("a seeded draw is the same draw every time it is read", async (t) => {
  const P = pool(200);

  await t.test("same pool and seed: the same albums in the same order", () => {
    const a = S.seededPick(P, 30, 12345).map(x => x.offset);
    const b = S.seededPick(P.slice(), 30, 12345).map(x => x.offset);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 30, "a draw held the same album twice");
  });

  await t.test("THE one: an album dropping out moves nothing but the ones after it", () => {
    // Played from "Not played in 6 months", it leaves the pool. The row the
    // user is looking at loses that tile and gains one at the end — it is not
    // a new draw.
    const drawn = S.seededPick(P, 30, 777);
    const gone = drawn[10];
    const again = S.seededPick(P.filter(x => x !== gone), 30, 777);
    assert.deepEqual(again.slice(0, 29).map(x => x.offset),
      drawn.filter(x => x !== gone).map(x => x.offset),
      "removing one album reshuffled the rest of the draw");
    assert.ok(!drawn.includes(again[29]), "the last place was not taken by the next album");
  });

  await t.test("another seed is another draw", () => {
    const a = S.seededPick(P, 30, 1).map(x => x.offset);
    const b = S.seededPick(P, 30, 2).map(x => x.offset);
    const shared = a.filter(x => b.includes(x)).length;
    assert.ok(shared < 20, "two seeds drew nearly the same albums (" + shared + " of 30)");
  });

  await t.test("seededMix exists because seededRank only ROTATES keys of one length", () => {
    // seededRank is (seed * 31^n + H(key)) mod 2^32: for keys of one length
    // the seed adds the same constant to all of them, and sorting values after
    // adding a constant mod 2^32 is a rotation of one fixed order. Replace
    // seededMix with seededRank and every "random" draw is a window onto the
    // same circle of albums.
    const P8 = pool(64, 8);
    const order = (fn, seed) => P8.slice().sort((x, y) => fn(x.nTitle + x.nArtist, seed) - fn(y.nTitle + y.nArtist, seed))
      .map(x => x.offset);
    const isRotation = (a, b) => (b.concat(b)).join(",").includes(a.join(","));
    assert.equal(isRotation(order(S.seededRank, 11), order(S.seededRank, 99)), true,
      "seededRank no longer rotates — this test's premise changed, re-read seededMix");
    assert.equal(isRotation(order(S.seededMix, 11), order(S.seededMix, 99)), false,
      "seededMix still only rotates keys of one length: a new seed is not a new shuffle");
    // And the draw itself is built on the mix, not on the rank beneath it.
    const drawOrder = (seed) => S.seededPick(P8, P8.length, seed).map(x => x.offset);
    assert.equal(isRotation(drawOrder(11), drawOrder(99)), false,
      "seededPick orders by something that only rotates between seeds");
  });

  await t.test("pickFromIndex: seeded is the seeded draw, unseeded is any `want` distinct albums", () => {
    const seeded = S.pickFromIndex(P, 12, 4242).map(x => x.offset);
    assert.deepEqual(seeded, S.seededPick(P, 12, 4242).map(x => x.offset));
    const free = S.pickFromIndex(P, 12, null);
    assert.equal(free.length, 12);
    assert.equal(new Set(free.map(x => x.offset)).size, 12);
  });

  await t.test("requestSeed: a positive integer or nothing — every other caller is unchanged", () => {
    assert.equal(S.requestSeed("12"), 12);
    for (const bad of [undefined, "", "0", "-4", "abc", null]) {
      assert.equal(S.requestSeed(bad), null, JSON.stringify(bad) + " was taken as a seed");
    }
  });
});

// ---------------------------------------------------------------------------
// The writers move the revisions. Each is loaded WITH liveRevisions, so the
// counter it bumps is the one liveRevisions reads — the only way to observe a
// module-level `let` from outside.
// ---------------------------------------------------------------------------
function withRevisions(names, inj) {
  return loadIndexFunctions(names.concat(["liveRevisions"]), Object.assign({
    albumIndex: { builtAt: 1 }, libraryMetaVersion: 0, libraryDateVersion: 0,
    playsVersion: 0, settingsVersion: 0, picksVersion: 0, discoverVersion: 0,
    labelsEnabled: false, labelsIndex: { builtAt: 0, map: new Map() },
    smartDayKey: () => "2026-09-27",
  }, inj));
}

test("every writer moves the revision the screens follow", async (t) => {
  await t.test("a settings write — from any device — moves `settings`", () => {
    const F = withRevisions(["savePersistedSettings"], {
      fs: { mkdirSync() {}, writeFileSync() {} },
      LABELS_DB_DIR: "/nowhere", SETTINGS_FILE: "/nowhere/settings.json",
      loadPersistedSettings: () => ({}),
    });
    const before = F.liveRevisions().settings;
    assert.equal(F.savePersistedSettings({ homeRows: [] }), true);
    assert.notEqual(F.liveRevisions().settings, before,
      "a saved setting did not move the revision, so another device's Home keeps the old layout");
  });

  await t.test("a failed settings write moves nothing", () => {
    const F = withRevisions(["savePersistedSettings"], {
      fs: { mkdirSync() {}, writeFileSync() { throw new Error("disk full"); } },
      LABELS_DB_DIR: "/nowhere", SETTINGS_FILE: "/nowhere/settings.json",
      loadPersistedSettings: () => ({}),
    });
    const before = F.liveRevisions().settings;
    assert.equal(F.savePersistedSettings({ a: 1 }), false);
    assert.equal(F.liveRevisions().settings, before);
  });

  await t.test("THE one for plays: a track starting moves `plays`", () => {
    // This is what makes Recently played and Not played follow the music: the
    // play row is written when a track starts, and the revision moves with it.
    const F = withRevisions(["scrobbleUpdate"], {
      labelsDb: {}, stmtInsertPlay: { run: () => ({ lastInsertRowid: 1 }) },
      stmtCompletePlay: { run() {} },
      scrobbleState: new Map(), zoneHistory: new Map(),
      historyEntry: () => null, pushHistory: (list) => list, playCounted: () => false,
    });
    const before = F.liveRevisions().plays;
    F.scrobbleUpdate({ zone_id: "z", display_name: "Z", state: "playing",
      now_playing: { three_line: { line1: "Track", line2: "Artist", line3: "Album" },
                     seek_position: 0, length: 200 } });
    assert.notEqual(F.liveRevisions().plays, before, "a recorded play did not move the revision");
    // The same track still playing is not a new play.
    const mid = F.liveRevisions().plays;
    F.scrobbleUpdate({ zone_id: "z", display_name: "Z", state: "playing",
      now_playing: { three_line: { line1: "Track", line2: "Artist", line3: "Album" },
                     seek_position: 5, length: 200 } });
    assert.equal(F.liveRevisions().plays, mid, "every position update moved the revision");
  });

  await t.test("pruning old plays moves `plays` — and pruning none does not", () => {
    const prune = (changes) => withRevisions(["pruneOldPlays"], {
      labelsDb: { prepare: () => ({ run: () => ({ changes }) }) },
      _historyPrunedAt: 0, playsRetentionDays: () => 400, DEBUG: false,
    });
    const some = prune(3);
    const before = some.liveRevisions().plays;
    some.pruneOldPlays();
    assert.notEqual(some.liveRevisions().plays, before, "pruned plays did not move the revision");
    // The prune runs on every History read (hourly at most); a revision moved
    // by a prune that deleted nothing would re-read every play screen for it.
    const none = prune(0);
    none.pruneOldPlays();
    assert.equal(none.liveRevisions().plays, before);
  });

  await t.test("a finished Smart Picks build moves `picks`", async () => {
    const F = withRevisions(["kickSmartPicks"], {
      smartPicksEnabled: true, readSmartPicks: () => [], smartAttemptedToday: () => false,
      smartPicksDue: () => true, buildSmartPicks: () => Promise.resolve(),
      bgRun: (name, fn) => Promise.resolve().then(fn), _smartBuilding: null,
    });
    const before = F.liveRevisions().picks;
    F.kickSmartPicks("scheduled");
    await new Promise(r => setImmediate(r));
    assert.notEqual(F.liveRevisions().picks, before,
      "the day's picks landed and nothing told the Home row to look");
  });

  await t.test("a finished Discover build moves `discover`", async () => {
    const F = withRevisions(["kickDiscover"], {
      discoverEnabled: true, core: {}, albumIndex: { builtAt: 1, count: 10 },
      discoverStampCurrent: () => false, readNewReleases: () => [], discoverAttemptedToday: () => false,
      discoverDue: () => true, buildNewReleases: () => Promise.resolve(),
      bgRun: (name, fn) => Promise.resolve().then(fn), _discoverBuilding: null,
    });
    const before = F.liveRevisions().discover;
    F.kickDiscover("scheduled");
    await new Promise(r => setImmediate(r));
    assert.notEqual(F.liveRevisions().discover, before);
  });
});

// ---------------------------------------------------------------------------
// The badge sets. Which albums wear a local / Q / T badge — and what the Source
// focus selects — is read straight off three key sets. Replacing one with a set
// that differs has to move the library revision; before v1.8.65 the favourites
// refresh moved it only when it also found new formats, and the /music walk
// never did, so the badges on every open screen (and the memoised Source focus)
// stayed as they were until something unrelated bumped.
// ---------------------------------------------------------------------------
test("a changed badge set moves the library revision; the same set does not", async (t) => {
  const K = loadIndexFunctions(["sameKeySet"], {});

  await t.test("sameKeySet compares members, not identity or order", () => {
    assert.equal(K.sameKeySet(new Set(["a", "b"]), new Set(["b", "a"])), true);
    assert.equal(K.sameKeySet(new Set(["a"]), new Set(["a", "b"])), false);
    assert.equal(K.sameKeySet(new Set(["a", "c"]), new Set(["a", "b"])), false);
    assert.equal(K.sameKeySet(new Set(), new Set()), true);
  });

  await t.test("THE one: the /music walk finding a different set of local albums", () => {
    let bumps = 0;
    const walk = () => loadIndexFunctions(["setLocalAlbumKeys", "sameKeySet"], {
      localAlbumKeys: new Set(["a||x", "b||y"]), localAlbumDirs: new Map(),
      _wfDirCache: new Map(), writeJsonAtomic() {}, LOCAL_ALBUMS_FILE: "/nowhere",
      SOURCE_KEY_VERSION: 1, MUSIC_DIR: "/music", bumpLibraryMeta: () => { bumps++; },
    });
    walk().setLocalAlbumKeys(new Set(["a||x", "b||y", "c||z"]), new Map());
    assert.equal(bumps, 1, "a new local album's badge would not reach any screen");
    walk().setLocalAlbumKeys(new Set(["b||y", "a||x"]), new Map());
    assert.equal(bumps, 1, "the same set again re-read every screen for nothing");
  });

  await t.test("the favourites refresh bumps on moved keys, for both services", () => {
    const src = require("../lib/extract").indexSource();
    for (const svc of ["qobuz", "tidal"]) {
      const moved = svc + "KeysMoved";
      assert.match(src, new RegExp("const " + moved + " = !sameKeySet\\(" + svc + "AlbumKeys, keys\\);"),
        svc + ": the refresh no longer compares the old key set with the new one");
      assert.match(src, new RegExp("if \\(qualities \\|\\| " + moved + "\\) bumpLibraryMeta\\(\\);"),
        svc + ": a changed favourites set does not bump the library revision");
      // Compared BEFORE the new set is assigned — after it, the two are one set.
      const cmp = src.indexOf("const " + moved + " = ");
      const assign = src.indexOf(svc + "AlbumKeys = keys;");
      assert.ok(cmp > -1 && assign > cmp, svc + ": the comparison runs after the assignment, so it can never differ");
    }
  });
});
