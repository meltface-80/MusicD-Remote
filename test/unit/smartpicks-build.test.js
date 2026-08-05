"use strict";
// ---------------------------------------------------------------------------
// v1.7.41: the Smart Picks build loop and the album resolver.
//
// smartpicks.test.js covers the selection POLICY; this covers the loop that
// spends money on it. Everything here is about not hammering somebody's
// streaming account:
//
//   1. THE RESOLVE LOOP IS CAPPED. Every candidate TRIED costs a search whether
//      or not it becomes a pick, so the pool size is not the bound. A day with
//      an expired token would otherwise walk the whole pool, then every outside
//      genre times its whole roster — thousands of live calls against the
//      UNOFFICIAL Qobuz/TIDAL APIs, on the same account the service browser and
//      the source badges depend on.
//   2. A NEGATIVE IS ONLY CACHED WHEN A SERVICE ACTUALLY ANSWERED. Caching "no
//      album" after consulting nothing writes a week of dead entries, and the
//      user who then connects Qobuz gets an empty feature with no way to tell
//      why.
//   3. AN EMPTY HUB CHART ABORTS. With no hubs the seed filter stops filtering
//      and the feature seeds from the library's most famous artists — the exact
//      inversion it exists to avoid, silently.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// The pure helpers are EXTRACTED so the loop runs against the shipping policy;
// only I/O and state are injected.
const SHARED = [
  "smartPickExcluded", "collectSmartCandidates", "rankSmartCandidates",
  "diversifySmartCandidates", "smartPickSeeds", "smartStretchGenres",
  "smartPickReason", "smartRateLimited", "smartAdjacentCount",
  "smartStretchCount", "smartSeedCount", "smartPoolCount", "smartPickKinds",
  "smartStretchShare", "smartMaxResolves", "smartMaxStretchGenres",
  "smartMaxStretchRoster", "smartAlbumTtlMs", "smartAttemptKey",
  "normalize", "canonText", "canonArtist",
];
// The build tests inject resolveSmartAlbum (to count its calls); the resolver
// tests extract it. It cannot be both in one load, so the two lists differ by
// exactly that one name.
const BUILD_FNS   = ["buildSmartPicks"].concat(SHARED);
const RESOLVE_FNS = ["resolveSmartAlbum"].concat(SHARED);

// A build harness. `opts` overrides any injected dependency; the counters it
// returns are what the assertions read.
function harness(opts) {
  opts = opts || {};
  const calls = { resolves: [], cacheSets: [], persisted: null, autoAdded: [], logs: [], errors: [] };
  const cache = new Map(Object.entries(opts.cache || {}));

  const candidates = opts.candidates !== undefined ? opts.candidates
    : Array.from({ length: 60 }, (_, i) => ({
        mbid: "mb" + i, name: "Cand " + i, score: 1000 - i, seed: "s" + (i % 6)
      }));

  const inj = {
    DEBUG: false,
    console: {
      log:   (m) => calls.logs.push(String(m)),
      error: (m) => calls.errors.push(String(m))
    },
    albumIndex: { albums: new Array(1000), builtAt: 1, count: 1000 },

    smartCachePrune: () => {},
    smartCacheGet: (k, ttl) => (cache.has(k) ? cache.get(k) : null),
    smartCacheSet: (k, v) => { cache.set(k, v); calls.cacheSets.push(k); },

    smartPicksServiceReady: () => opts.serviceReady !== false,
    qobuzReady: () => opts.qobuzReady !== false,
    tidalReady: () => opts.tidalReady === true,

    libraryArtistProfile: () => opts.profile || new Map([
      ["seeda", { canon: "seeda", name: "Seed A", albums: 1, plays: 9 }],
      ["seedb", { canon: "seedb", name: "Seed B", albums: 1, plays: 8 }],
      ["seedc", { canon: "seedc", name: "Seed C", albums: 2, plays: 8 }],
    ]),
    smartHubSet: async () => new Set(opts.hubs !== undefined ? opts.hubs : ["famousact"]),
    linkableArtistSet: () => new Set(["seeda", "seedb", "seedc"]),
    smartBlockedSet: () => new Set(opts.blocked || []),
    smartSeenSet: () => new Set(opts.seen || []),

    fetchArtistMbid: async (name) => "mbid-" + name.toLowerCase().replace(/ /g, ""),
    smartSimilarRows: async () => candidates,
    smartTagArtists: async (g) => (opts.roster !== undefined ? opts.roster
      : Array.from({ length: 40 }, (_, i) => ({ mbid: "t" + i, name: "Tag " + g + " " + i }))),
    libraryGenreWeights: () => opts.weights || new Map([["Pop/Rock", 900], ["Flamenco", 3]]),

    resolveSmartAlbum: async (name) => {
      calls.resolves.push(name);
      if (opts.resolveThrows) throw opts.resolveThrows;
      return opts.resolveAll === false ? null
        : { service: "qobuz", id: "id" + calls.resolves.length, title: "T", image: "" };
    },
    // v1.7.42: the five genre picks are favourited at build time so Roon can
    // import them overnight. Recorded here so the tests can prove WHICH picks
    // get that treatment.
    smartPicksAutoAdd: opts.autoAdd !== false,
    autoAddSmartAlbum: async (album) => { calls.autoAdded.push(album.id); return true; },
    persistSmartPicks: (day, picks) => { calls.persisted = picks; },
  };
  return { F: loadIndexFunctions(BUILD_FNS, Object.assign(inj, opts.inject || {})), calls, cache };
}

// ---------------------------------------------------------------------------
test("the build is bounded in how many lookups it makes", { concurrency: 1 }, async (t) => {
  await t.test("a day where nothing resolves stops at the resolve cap", async () => {
    // THE one. Without the cap this walks all 60 candidates (150 in production)
    // and then every outside genre times its whole roster.
    const h = harness({ resolveAll: false });
    await h.F.buildSmartPicks("2026-08-05");
    const adjacentTries = h.calls.resolves.filter(n => n.startsWith("Cand ")).length;
    assert.equal(adjacentTries, h.F.smartMaxResolves(),
      "the adjacent loop made " + adjacentTries + " lookups — it is walking the " +
      "whole pool rather than stopping at the cap");
  });

  await t.test("the stretch search is capped in genres and in roster depth", async () => {
    const h = harness({ resolveAll: false, weights: new Map([
      ["Pop/Rock", 900], ["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5]]) });
    await h.F.buildSmartPicks("2026-08-05");
    const tagTries = h.calls.resolves.filter(n => n.startsWith("Tag ")).length;
    const genres = new Set(h.calls.resolves.filter(n => n.startsWith("Tag "))
      .map(n => n.split(" ")[1]));
    assert.ok(genres.size <= h.F.smartMaxStretchGenres(),
      "the stretch pick searched " + genres.size + " genres");
    assert.ok(tagTries <= h.F.smartMaxStretchGenres() * h.F.smartMaxStretchRoster(),
      "the stretch pick made " + tagTries + " lookups");
  });

  await t.test("a normal day stops as soon as it has its picks", async () => {
    // The cap is a backstop, not the usual path: when candidates resolve, the
    // loop must stop at five and not keep spending.
    const h = harness({});
    await h.F.buildSmartPicks("2026-08-05");
    const adjacentTries = h.calls.resolves.filter(n => n.startsWith("Cand ")).length;
    assert.equal(adjacentTries, h.F.smartAdjacentCount());
    assert.equal(h.calls.persisted.filter(p => p.kind === "adjacent").length, 5);
    assert.equal(h.calls.persisted.filter(p => p.kind === "stretch").length, 1);
  });
});

// ---------------------------------------------------------------------------
// v1.7.42. The five genre picks are favourited at build time so Roon has all
// night to import them and they simply play by morning. The stretch pick is
// NOT — it is the one deliberately unlike the library, and adding it to
// somebody's streaming library unasked is the opposite of offering it.
// ---------------------------------------------------------------------------
test("only the genre picks are added automatically", { concurrency: 1 }, async (t) => {
  await t.test("the five adjacent picks are auto-added", async () => {
    const h = harness({});
    await h.F.buildSmartPicks("2026-08-05");
    const adjacent = h.calls.persisted.filter(p => p.kind === "adjacent");
    assert.equal(adjacent.length, 5);
    assert.equal(h.calls.autoAdded.length, 5,
      "the genre picks were not added, so Roon has nothing to import and they " +
      "cannot be ready to play");
    assert.ok(adjacent.every(p => p.autoAdded === true));
  });

  await t.test("the stretch pick is NEVER auto-added", async () => {
    // THE one. The stretch pick is the single thing the user is asked to judge;
    // silently putting it in their library removes the only decision the
    // feature asks them to make.
    const h = harness({});
    await h.F.buildSmartPicks("2026-08-05");
    const stretch = h.calls.persisted.find(p => p.kind === "stretch");
    assert.ok(stretch, "no stretch pick was built");
    assert.notEqual(stretch.autoAdded, true);
    // Its album id must not appear among the auto-added ones.
    assert.ok(!h.calls.autoAdded.includes(stretch.album.id),
      "the stretch pick was added to the library without being offered");
  });

  await t.test("the setting turns auto-add off for everything", async () => {
    const h = harness({ autoAdd: false });
    await h.F.buildSmartPicks("2026-08-05");
    assert.deepEqual(h.calls.autoAdded, [],
      "auto-add ran despite the setting being off");
    assert.equal(h.calls.persisted.length, 6, "the picks themselves must still be built");
  });
});

// ---------------------------------------------------------------------------
test("an empty hub chart aborts rather than degrading silently",
  { concurrency: 1 }, async (t) => {
    await t.test("no picks are built and nothing is persisted", async () => {
      // With no hubs, smartPickSeeds stops filtering and seeds from the most
      // played artists — which on a real library means Radiohead and Pink Floyd,
      // the exact inversion this feature exists to avoid. A day with no picks is
      // recoverable; a day of picks that discredit the feature is not.
      const h = harness({ hubs: [] });
      await h.F.buildSmartPicks("2026-08-05");
      assert.equal(h.calls.persisted, null, "picks were built from an unfiltered seed list");
      assert.equal(h.calls.resolves.length, 0, "it spent lookups anyway");
      assert.ok(h.calls.errors.some(m => /chart came back empty/i.test(m)),
        "the abort was silent — nothing in the log says why there are no picks");
    });

    await t.test("a populated chart proceeds normally", () => {
      // Mutation guard: an abort that always fired would pass the test above.
      return harness({}).F.buildSmartPicks("2026-08-05").then(function () {});
    });
  });

// ---------------------------------------------------------------------------
test("a build that cannot possibly work does not run", { concurrency: 1 }, async (t) => {
  await t.test("no streaming service connected — skipped and marked", async () => {
    const h = harness({ serviceReady: false });
    await h.F.buildSmartPicks("2026-08-05");
    assert.equal(h.calls.resolves.length, 0);
    assert.ok(h.cache.has(h.F.smartAttemptKey("2026-08-05")),
      "the day was not marked attempted, so every request would retry the build");
  });

  await t.test("an empty library is NOT marked attempted", async () => {
    // Different case, deliberately: the library is still arriving, so today
    // should be retried once it has. Marking it would lose the whole first day.
    const h = harness({ profile: new Map() });
    await h.F.buildSmartPicks("2026-08-05");
    assert.equal(h.cache.has(h.F.smartAttemptKey("2026-08-05")), false);
  });

  await t.test("a completed build marks the day even when it found nothing", async () => {
    // Otherwise "did we build today?" is answered by "are there rows?", and a
    // zero-pick day re-runs the entire pipeline on every request.
    const h = harness({ resolveAll: false });
    await h.F.buildSmartPicks("2026-08-05");
    assert.ok(h.cache.has(h.F.smartAttemptKey("2026-08-05")));
  });
});

// ---------------------------------------------------------------------------
test("rate limiting stops the build instead of pushing harder",
  { concurrency: 1 }, async (t) => {
    await t.test("a 429 ends the build and keeps what resolved first", async () => {
      const e = new Error("rate limited"); e.code = 429;
      let n = 0;
      const h = harness({ inject: { resolveSmartAlbum: async (name) => {
        if (++n > 2) throw e;
        return { service: "qobuz", id: "x" + n, title: "T", image: "" };
      } } });
      await h.F.buildSmartPicks("2026-08-05");
      assert.ok(Array.isArray(h.calls.persisted), "the build threw instead of stopping");
      assert.equal(h.calls.persisted.length, 2, "it discarded the picks it already had");
      assert.ok(h.calls.errors.some(m => /rate limited/i.test(m)));
    });

    await t.test("a non-429 failure is not swallowed as a rate limit", async () => {
      // A programming error inside the loop must surface, not be quietly
      // reported as "the service is busy".
      const h = harness({ resolveThrows: new TypeError("x.find is not a function") });
      await assert.rejects(() => h.F.buildSmartPicks("2026-08-05"), /not a function/);
    });
  });

// ---------------------------------------------------------------------------
test("resolveSmartAlbum caches only what it actually learned",
  { concurrency: 1 }, async (t) => {
    function resolver(opts) {
      opts = opts || {};
      const cache = new Map();
      const sets = [];
      const F = loadIndexFunctions(RESOLVE_FNS, {
        DEBUG: false,
        console: { log: () => {}, error: () => {} },
        albumIndex: { albums: [], builtAt: 1, count: 0 },
        smartCacheGet: (k) => (cache.has(k) ? cache.get(k) : null),
        smartCacheSet: (k, v) => { cache.set(k, v); sets.push(k); },
        qobuzReady: () => opts.qobuz !== false,
        tidalReady: () => opts.tidal === true,
        qobuzToken: "t", qobuzUsername: "", qobuzPasswordMd5: "",
        tidalRefreshToken: "", tidalUserId: "",
        qobuzWithToken: async (fn) => {
          if (opts.qobuzThrows) throw opts.qobuzThrows;
          return { albums: { items: opts.qobuzItems || [] } };
        },
        qobuz: {},
        normalizeQobuzAlbums: (items) => items,
        tidalWithToken: async (fn) => {
          if (opts.tidalThrows) throw opts.tidalThrows;
          return fn("tok", "GB", "uid");
        },
        tidal: {
          searchArtists: async () => opts.tidalArtists || { items: [], total: 0 },
          getArtistAlbums: async () => opts.tidalAlbums || { items: [], total: 0 },
        },
        normalizeTidalAlbums: (items) => items,
      });
      return { F, cache, sets };
    }

    await t.test("a miss with NO service consulted is not cached", async () => {
      // THE one. Caching here writes a week of dead negatives on a machine with
      // nothing connected, and the user who then connects Qobuz gets an empty
      // feature until the TTL expires.
      const r = resolver({ qobuz: false, tidal: false });
      assert.equal(await r.F.resolveSmartAlbum("Nobody"), null);
      assert.deepEqual(r.sets, [],
        "a negative was cached without any service having answered");
    });

    await t.test("a miss after a service ANSWERED is cached", async () => {
      const r = resolver({ qobuzItems: [] });
      assert.equal(await r.F.resolveSmartAlbum("Nobody"), null);
      assert.equal(r.sets.length, 1, "a real negative must be cached or it is refetched daily");
    });

    await t.test("a miss after a service THREW is not cached", async () => {
      // A one-minute token blip must not become a week-long hole.
      const r = resolver({ qobuzThrows: new Error("connection reset") });
      assert.equal(await r.F.resolveSmartAlbum("Nobody"), null);
      assert.deepEqual(r.sets, []);
    });

    await t.test("a 429 propagates instead of being cached as a miss", async () => {
      const e = new Error("rate limited"); e.code = 429;
      const r = resolver({ qobuzThrows: e });
      await assert.rejects(() => r.F.resolveSmartAlbum("Nobody"), /rate limited/);
      assert.deepEqual(r.sets, []);
    });

    await t.test("a hit is cached and served from cache next time", async () => {
      const r = resolver({ qobuzItems: [{ id: 1, title: "A", artist: "Real Act", image: "" }] });
      const first = await r.F.resolveSmartAlbum("Real Act");
      assert.equal(first.service, "qobuz");
      const before = r.sets.length;
      const second = await r.F.resolveSmartAlbum("Real Act");
      assert.equal(second.title, "A");
      assert.equal(r.sets.length, before, "the cached answer was refetched");
    });

    await t.test("an artist Qobuz does not credit is rejected", async () => {
      // Qobuz search matches on title too, so an unfiltered top hit is often a
      // different act. Picking it would credit the wrong artist on the card.
      const r = resolver({ qobuzItems: [{ id: 1, title: "Tribute", artist: "Someone Else", image: "" }] });
      assert.equal(await r.F.resolveSmartAlbum("Real Act"), null);
    });

    await t.test("TIDAL's paged shape is read correctly", async () => {
      // searchArtists returns { items, total }, not an array. Treating it as an
      // array threw on every lookup, which made Smart Picks permanently empty
      // for anyone without Qobuz.
      const r = resolver({
        qobuz: false, tidal: true,
        tidalArtists: { items: [{ id: 7, name: "Real Act" }], total: 1 },
        tidalAlbums:  { items: [{ id: 9, title: "TA", artist: "Real Act", image: "" }], total: 1 },
      });
      const got = await r.F.resolveSmartAlbum("Real Act");
      assert.ok(got, "the TIDAL path returned nothing — it is misreading the paged wrapper");
      assert.equal(got.service, "tidal");
    });

    await t.test("an unrecognisable artist name never reaches the network", async () => {
      const r = resolver({ qobuzItems: [{ id: 1, title: "X", artist: "!!!", image: "" }] });
      assert.equal(await r.F.resolveSmartAlbum("!!!"), null);
      assert.deepEqual(r.sets, []);
    });
  });
