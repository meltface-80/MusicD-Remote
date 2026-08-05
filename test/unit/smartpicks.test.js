"use strict";
// ---------------------------------------------------------------------------
// v1.7.41: Smart Picks — six albums a day by artists NOT in the library.
//
// Almost everything here is a POLICY decision rather than a mechanism, which
// makes it unusually easy to break without anything looking broken: a pick list
// that quietly fills with famous names still renders six tiles, still refreshes
// daily, and still passes any test that only counts them. So these tests pin
// the properties that decide whether the feature is any good at all:
//
//   1. SEEDS COME FROM THE OBSCURE END. Similarity quality inverts with seed
//      popularity — Radiohead returns Nirvana/RHCP/Coldplay, Bark Psychosis
//      returns Mogwai/Talk Talk/Slint/Labradford. If hub artists leak into the
//      seed list the whole feature degrades to a worse Roon Radio.
//   2. RANKING IS BY DISTANCE, NOT SIMILARITY. A candidate reachable from ONE
//      seed must outrank one reachable from twelve. Sorting by score — the
//      obvious thing, and what every other recommender does — inverts this.
//   3. SILENCE IS NOT REJECTION. Only an explicit tap may block an artist.
//   4. NOTHING ALREADY KNOWN GETS THROUGH. Owned, famous, blocked and recently
//      shown are four different reasons and all four must be enforced.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// canonArtist is EXTRACTED, not stubbed. It decides whether "already owned",
// "famous", "blocked" and "shown recently" actually match a candidate, so a
// hand-written stand-in would put these tests in a key space production never
// uses — and the empty-canon assertion below would then be proving a property
// of the stub. It is four lines and its only dependencies (canonText,
// normalize) are top-level functions with no module state.
const PURE = [
  "smartPickSeeds", "smartStretchGenres", "collectSmartCandidates",
  "rankSmartCandidates", "diversifySmartCandidates", "smartPickExcluded",
  "smartPickReason", "smartDayKey", "smartAdjacentCount", "smartStretchCount",
  "smartSeedCount", "smartPickKinds", "smartStretchShare", "smartSeenDays",
  "smartPoolCount", "smartMaxResolves", "smartMaxStretchGenres",
  "smartMaxStretchRoster", "normalize", "canonText", "canonArtist",
];

const F = loadIndexFunctions(PURE, {});
const canonArtist = F.canonArtist;

// Convenience: an exclusion-set bundle with everything empty by default.
function sets(over) {
  return Object.assign({
    library: new Set(), hubs: new Set(), blocked: new Set(), seen: new Set()
  }, over || {});
}
// A library artist profile from a compact spec.
function profile(spec) {
  const m = new Map();
  for (const [name, albums, plays] of spec) {
    m.set(canonArtist(name), { canon: canonArtist(name), name, albums, plays });
  }
  return m;
}

// ---------------------------------------------------------------------------
test("the shipped shape is five adjacent plus one stretch", async (t) => {
  await t.test("counts match what the user asked for", () => {
    assert.equal(F.smartAdjacentCount(), 5);
    assert.equal(F.smartStretchCount(), 1);
  });
  await t.test("both kinds exist and nothing else does", () => {
    // The kind string is persisted and read back by the client; a third kind
    // appearing here without UI would render as a blank row.
    assert.deepEqual(F.smartPickKinds().slice().sort(), ["adjacent", "stretch"]);
  });
  await t.test("more seeds are walked than picks are shown", () => {
    // Picks are filtered hard (owned/famous/blocked/seen, then "is it even
    // addable"). Walking only five seeds would routinely yield fewer than five
    // picks and the row would look broken on a normal day.
    assert.ok(F.smartSeedCount() > F.smartAdjacentCount() * 2,
      "the seed count leaves no headroom for candidates that get filtered out");
    assert.ok(F.smartPoolCount() > F.smartSeedCount());
  });
});

// ---------------------------------------------------------------------------
test("seeds are taken from the obscure end of the library", async (t) => {
  await t.test("a hub artist is never seeded from", () => {
    // THE one. Seeding from the library's most famous act is what turns a
    // discovery tool into a worse Roon Radio, and nothing downstream can
    // recover from it — the candidates are already mainstream by then.
    const p = profile([["Radiohead", 9, 500], ["Bark Psychosis", 1, 4]]);
    const hubs = new Set([canonArtist("Radiohead")]);
    const seeds = F.smartPickSeeds(p, hubs, 10).map(s => s.name);
    assert.ok(!seeds.includes("Radiohead"),
      "a hub artist was used as a seed — this is the failure that makes the " +
      "whole feature return Coldplay");
    assert.deepEqual(seeds, ["Bark Psychosis"]);
  });

  await t.test("plays per album owned decides, not plays alone", () => {
    // Four plays across one album is a stronger statement than six spread over
    // twelve. Sorting on raw plays would put the big box-set artists first,
    // which is the popularity ordering by another name.
    const p = profile([["Sprawling", 12, 6], ["Deliberate", 1, 4]]);
    const seeds = F.smartPickSeeds(p, new Set(), 10).map(s => s.name);
    assert.deepEqual(seeds, ["Deliberate", "Sprawling"]);
  });

  await t.test("an unplayed artist ranks below every played one", () => {
    const p = profile([["Owned", 30, 0], ["Played", 1, 1]]);
    const seeds = F.smartPickSeeds(p, new Set(), 10).map(s => s.name);
    assert.equal(seeds[0], "Played",
      "an artist with no plays outranked one the user actually listens to");
  });

  await t.test("a library with NO play history still produces seeds", () => {
    // A fresh install has an empty plays table. Returning [] here would leave
    // Smart Picks permanently empty on a brand-new setup, and it would look
    // like the feature was broken rather than waiting.
    const p = profile([["A", 5, 0], ["B", 9, 0], ["C", 1, 0]]);
    const seeds = F.smartPickSeeds(p, new Set(), 10).map(s => s.name);
    assert.equal(seeds.length, 3);
    assert.equal(seeds[0], "B", "the fallback should lead with the most-owned artist");
  });

  await t.test("the top-up never duplicates an artist already seeded", () => {
    // The played list and the fallback list are drawn from the same pool, so a
    // careless top-up walks the same artist twice — and a duplicated seed MBID
    // doubles that artist's weight in the candidate pool for nothing.
    const p = profile([["A", 2, 5], ["B", 3, 0], ["C", 4, 0]]);
    const seeds = F.smartPickSeeds(p, new Set(), 10).map(s => s.name);
    assert.equal(new Set(seeds).size, seeds.length, "a seed was listed twice");
    assert.equal(seeds.length, 3);
  });

  await t.test("the limit is respected", () => {
    const p = profile([["A", 1, 9], ["B", 1, 8], ["C", 1, 7], ["D", 1, 6]]);
    assert.equal(F.smartPickSeeds(p, new Set(), 2).length, 2);
  });

  await t.test("ties break deterministically", () => {
    // Two runs on the same library must choose the same seeds, or the daily
    // set changes every time the process restarts.
    const p = profile([["Alpha", 2, 4], ["Beta", 2, 4], ["Gamma", 2, 4]]);
    const once  = F.smartPickSeeds(p, new Set(), 2).map(s => s.name);
    const twice = F.smartPickSeeds(p, new Set(), 2).map(s => s.name);
    assert.deepEqual(once, twice);
    assert.deepEqual(once, ["Alpha", "Beta"]);
  });

  await t.test("an empty library yields no seeds rather than throwing", () => {
    assert.deepEqual(F.smartPickSeeds(new Map(), new Set(), 5), []);
  });
});

// ---------------------------------------------------------------------------
test("candidates are folded without losing which seeds reached them", async (t) => {
  const rows = [
    { mbid: "m1", name: "Mogwai",   score: 500, seed: "s1" },
    { mbid: "m1", name: "Mogwai",   score: 200, seed: "s2" },
    { mbid: "m2", name: "Slowdive", score: 170, seed: "s1" },
  ];
  const seedNames = new Map([["s1", "Bark Psychosis"], ["s2", "Labradford"]]);

  await t.test("one entry per candidate", () => {
    assert.equal(F.collectSmartCandidates(rows, seedNames).length, 2);
  });

  await t.test("EVERY seed that reached a candidate is remembered", () => {
    // THE one for ranking. If a second arrival overwrites the first instead of
    // appending, every candidate ends up with seeds.length === 1 and the
    // distance sort silently degenerates into a plain score sort.
    const c = F.collectSmartCandidates(rows, seedNames).find(x => x.mbid === "m1");
    assert.deepEqual(c.seeds.slice().sort(), ["s1", "s2"]);
    assert.deepEqual(c.seedNames.slice().sort(), ["Bark Psychosis", "Labradford"]);
  });

  await t.test("the strongest score across seeds is kept", () => {
    const c = F.collectSmartCandidates(rows, seedNames).find(x => x.mbid === "m1");
    assert.equal(c.score, 500);
  });

  await t.test("the same seed arriving twice is counted once", () => {
    const dup = [
      { mbid: "m1", name: "Mogwai", score: 1, seed: "s1" },
      { mbid: "m1", name: "Mogwai", score: 2, seed: "s1" },
    ];
    const c = F.collectSmartCandidates(dup, seedNames)[0];
    assert.deepEqual(c.seeds, ["s1"], "a repeated seed inflated the distance count");
  });

  await t.test("a row with no usable name is dropped, not keyed as \"\"", () => {
    // canonArtist("!!!") is "". Keeping it would merge every unrecognisable act
    // into a single phantom candidate that then wins the ranking.
    const bad = [{ mbid: "m9", name: "!!!", score: 900, seed: "s1" }];
    assert.deepEqual(F.collectSmartCandidates(bad, seedNames), []);
  });

  await t.test("malformed rows are skipped", () => {
    const junk = [null, {}, { mbid: "x" }, { name: "y" }];
    assert.deepEqual(F.collectSmartCandidates(junk, seedNames), []);
  });

  await t.test("no rows is not an error", () => {
    assert.deepEqual(F.collectSmartCandidates([], seedNames), []);
    assert.deepEqual(F.collectSmartCandidates(null, seedNames), []);
  });
});

// ---------------------------------------------------------------------------
test("ranking prefers distance from the library over similarity to it", async (t) => {
  const c = (canon, seeds, score) =>
    ({ canon, seeds: seeds, score, name: canon, mbid: canon });

  await t.test("fewer connections back to the library wins", () => {
    // THE one this feature exists for. An artist similar to twelve of your
    // artists is somebody you have had every chance to buy and have not. The
    // obvious implementation — sort by score descending — gets this backwards,
    // and would rank `broad` first here.
    const broad  = c("broad",  ["s1", "s2", "s3"], 9000);
    const narrow = c("narrow", ["s1"], 10);
    const out = F.rankSmartCandidates([broad, narrow]).map(x => x.canon);
    assert.deepEqual(out, ["narrow", "broad"],
      "ranked by similarity rather than by distance — this is the sort every " +
      "other recommender uses and the reason they all return the obvious");
  });

  await t.test("score decides only WITHIN a distance bucket", () => {
    const weak   = c("weak",   ["s1"], 10);
    const strong = c("strong", ["s1"], 900);
    assert.deepEqual(F.rankSmartCandidates([weak, strong]).map(x => x.canon),
      ["strong", "weak"]);
  });

  await t.test("the input array is not mutated", () => {
    // The pool is reused for the stretch pick's exclusion set; sorting in place
    // would reorder it under that caller.
    const list = [c("b", ["s1", "s2"], 1), c("a", ["s1"], 1)];
    const before = list.map(x => x.canon);
    F.rankSmartCandidates(list);
    assert.deepEqual(list.map(x => x.canon), before);
  });

  await t.test("ties break deterministically", () => {
    const list = [c("zeta", ["s1"], 5), c("alpha", ["s1"], 5)];
    assert.deepEqual(F.rankSmartCandidates(list).map(x => x.canon), ["alpha", "zeta"]);
  });

  await t.test("an empty pool is not an error", () => {
    assert.deepEqual(F.rankSmartCandidates([]), []);
    assert.deepEqual(F.rankSmartCandidates(null), []);
  });
});

// ---------------------------------------------------------------------------
// Found by running the real pipeline against the live APIs, not by reading it.
// A library seeded from Bark Psychosis, Slint, Stars of the Lid, Labradford and
// Tortoise returned five candidates that were ALL neighbours of Stars of the
// Lid — five ambient records saying one thing between them. Ranking cannot
// prevent that on its own: once most candidates sit in the one-seed bucket the
// sort decides on score, and the loudest seed takes every slot.
// ---------------------------------------------------------------------------
test("the day's picks are spread across different corners of the library", async (t) => {
  const c = (canon, seed, score) =>
    ({ canon, mbid: canon, name: canon, seeds: [seed], score });

  await t.test("one seed cannot take every slot", () => {
    // THE one. Without the round-robin this returns a1,a2,a3 — three picks that
    // are all neighbours of the same record the user already owns.
    const ranked = [
      c("a1", "seedA", 900), c("a2", "seedA", 800), c("a3", "seedA", 700),
      c("b1", "seedB", 600), c("c1", "seedC", 500),
    ];
    const top3 = F.diversifySmartCandidates(ranked).slice(0, 3).map(x => x.canon);
    assert.deepEqual(top3, ["a1", "b1", "c1"],
      "every early pick came from one seed — that is a monoculture, not a day's discoveries");
  });

  await t.test("the strongest candidate overall still leads", () => {
    // Diversity must not cost the best find its place; it only stops that find
    // bringing four relatives with it.
    const ranked = [c("best", "seedA", 999), c("other", "seedB", 10)];
    assert.equal(F.diversifySmartCandidates(ranked)[0].canon, "best");
  });

  await t.test("nothing is lost — every candidate still appears", () => {
    // The result feeds the pool the stretch pick excludes against, and drives
    // the fallback when a pick cannot be resolved to an addable album. Dropping
    // candidates here would silently shrink both.
    const ranked = [
      c("a1", "seedA", 9), c("a2", "seedA", 8), c("b1", "seedB", 7), c("b2", "seedB", 6),
    ];
    const out = F.diversifySmartCandidates(ranked);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(x => x.canon).slice().sort(), ["a1", "a2", "b1", "b2"]);
  });

  await t.test("rank order is preserved within a seed", () => {
    const ranked = [c("a1", "seedA", 9), c("a2", "seedA", 8), c("a3", "seedA", 7)];
    assert.deepEqual(F.diversifySmartCandidates(ranked).map(x => x.canon),
      ["a1", "a2", "a3"], "a seed's own candidates must stay strongest-first");
  });

  await t.test("later rounds deal fairly too", () => {
    const ranked = [
      c("a1", "seedA", 9), c("a2", "seedA", 8), c("a3", "seedA", 7),
      c("b1", "seedB", 6), c("b2", "seedB", 5),
    ];
    assert.deepEqual(F.diversifySmartCandidates(ranked).map(x => x.canon),
      ["a1", "b1", "a2", "b2", "a3"]);
  });

  await t.test("a single seed still yields its whole list", () => {
    // A small library, or a day when only one seed resolved. Must degrade to
    // plain rank order, not to one pick.
    const ranked = [c("a1", "s", 9), c("a2", "s", 8), c("a3", "s", 7)];
    assert.equal(F.diversifySmartCandidates(ranked).length, 3);
  });

  await t.test("candidates with no seed at all are still dealt", () => {
    // Reachable when the endpoint omits reference_mbid. They must not vanish.
    const ranked = [{ canon: "x", mbid: "x", name: "x", seeds: [], score: 5 }];
    assert.equal(F.diversifySmartCandidates(ranked).length, 1);
  });

  await t.test("an empty pool is not an error", () => {
    assert.deepEqual(F.diversifySmartCandidates([]), []);
    assert.deepEqual(F.diversifySmartCandidates(null), []);
  });
});

// ---------------------------------------------------------------------------
test("four different reasons to exclude a candidate, all enforced", async (t) => {
  const cases = [
    ["library", "already in the library — recommending it is not discovery"],
    ["hubs",    "one of the world's biggest artists — famous is not a discovery"],
    ["blocked", "the user tapped Not for me — that must be permanent"],
    ["seen",    "shown recently — the daily set has to turn over"],
  ];
  for (const [which, why] of cases) {
    await t.test("excluded when in " + which, () => {
      const s = sets({ [which]: new Set(["target"]) });
      assert.equal(F.smartPickExcluded("target", s), true, why);
    });
  }

  await t.test("a candidate in none of them passes", () => {
    assert.equal(F.smartPickExcluded("target", sets()), false);
  });

  await t.test("an empty canon is always excluded", () => {
    // canonArtist returns "" for punctuation-only names. Letting "" through
    // would make one phantom artist that matches nothing and can never resolve
    // to an album, wasting a pick slot every single day.
    assert.equal(F.smartPickExcluded("", sets()), true);
    assert.equal(F.smartPickExcluded(null, sets()), true);
  });
});

// ---------------------------------------------------------------------------
test("the stretch band is the outside edge of the library", async (t) => {
  await t.test("a genre at or below the share ceiling is outside", () => {
    const w = new Map([["Pop/Rock", 900], ["Flamenco", 2]]);
    const out = F.smartStretchGenres(w, 1000).map(g => g.genre);
    assert.deepEqual(out, ["Flamenco"]);
  });

  await t.test("the least-owned genre comes first", () => {
    // The stretch pick takes the first genre it can fill, so the ordering IS
    // the policy: the furthest-out genre gets first refusal.
    const w = new Map([["B", 15], ["A", 3], ["C", 8]]);
    const out = F.smartStretchGenres(w, 1000).map(g => g.genre);
    assert.deepEqual(out, ["A", "C", "B"]);
  });

  await t.test("the ceiling is a SHARE, not a count", () => {
    // A fixed count would mean a 500-album library and a 50,000-album one used
    // the same threshold, and on the big one every genre would look "outside".
    const w = new Map([["G", 20]]);
    assert.equal(F.smartStretchGenres(w, 100).length, 0, "20% of the library is not outside it");
    assert.equal(F.smartStretchGenres(w, 10000).length, 1, "0.2% of the library is outside it");
  });

  await t.test("the ceiling is a small minority of the library", () => {
    assert.ok(F.smartStretchShare() > 0 && F.smartStretchShare() <= 0.05,
      "a wide ceiling would make the stretch pick indistinguishable from the adjacent ones");
  });

  await t.test("an empty library yields no stretch genres rather than dividing by zero", () => {
    assert.deepEqual(F.smartStretchGenres(new Map([["G", 1]]), 0), []);
  });

  await t.test("a nameless genre is not offered", () => {
    const w = new Map([["", 1], ["Real", 1]]);
    assert.deepEqual(F.smartStretchGenres(w, 1000).map(g => g.genre), ["Real"]);
  });

  await t.test("ties break deterministically", () => {
    const w = new Map([["Zydeco", 2], ["Ambient", 2]]);
    assert.deepEqual(F.smartStretchGenres(w, 1000).map(g => g.genre), ["Ambient", "Zydeco"]);
  });
});

// ---------------------------------------------------------------------------
test("the reason line is derived from the chain, so it is always true", async (t) => {
  await t.test("an adjacent pick names the seed it came from", () => {
    const r = F.smartPickReason({ kind: "adjacent", seedNames: ["Stars of the Lid"] });
    assert.match(r, /Stars of the Lid/);
  });

  await t.test("two seeds are both named", () => {
    const r = F.smartPickReason({ kind: "adjacent", seedNames: ["Labradford", "Talk Talk"] });
    assert.match(r, /Labradford/);
    assert.match(r, /Talk Talk/);
  });

  await t.test("a stretch pick names its genre and does NOT claim similarity", () => {
    // A stretch pick saying "because you play X" would be a lie — it was chosen
    // precisely because it is unlike everything in the library.
    const r = F.smartPickReason({ kind: "stretch", genre: "Flamenco", seedNames: [] });
    assert.match(r, /Flamenco/);
    assert.doesNotMatch(r, /Because you play/);
  });

  await t.test("an adjacent pick with no seed names still reads as a sentence", () => {
    // Reachable when a seed's display name is missing from the map. Must not
    // render "Because you play undefined".
    const r = F.smartPickReason({ kind: "adjacent", seedNames: [] });
    assert.ok(r && !/undefined|null/.test(r), "the reason line leaked a missing value: " + r);
  });

  await t.test("a stretch pick with no genre still reads as a sentence", () => {
    const r = F.smartPickReason({ kind: "stretch", genre: "", seedNames: [] });
    assert.ok(r && !/undefined|null/.test(r), "the reason line leaked a missing value: " + r);
  });
});

// ---------------------------------------------------------------------------
test("the day key is local, stable and sortable", async (t) => {
  await t.test("it is zero-padded ISO, so string order is date order", () => {
    // The day column is compared as TEXT in SQL. "2026-8-4" would sort after
    // "2026-12-01", so an unpadded key silently breaks any range query later.
    assert.equal(F.smartDayKey(new Date(2026, 7, 4)), "2026-08-04");
    assert.equal(F.smartDayKey(new Date(2026, 11, 25)), "2026-12-25");
  });

  await t.test("it uses LOCAL time, not UTC", () => {
    // Picks change at the user's midnight, not at UTC midnight. Reading this
    // off toISOString would roll the set over mid-evening west of Greenwich.
    const d = new Date(2026, 0, 1, 2, 0, 0);   // 02:00 local on New Year's Day
    assert.equal(F.smartDayKey(d), "2026-01-01");
  });

  await t.test("two calls in the same day agree", () => {
    assert.equal(F.smartDayKey(new Date(2026, 4, 9, 0, 0, 1)),
                 F.smartDayKey(new Date(2026, 4, 9, 23, 59, 59)));
  });

  await t.test("consecutive days differ", () => {
    assert.notEqual(F.smartDayKey(new Date(2026, 4, 9)), F.smartDayKey(new Date(2026, 4, 10)));
  });
});

// ---------------------------------------------------------------------------
// A build talks to the UNOFFICIAL Qobuz/TIDAL APIs, on the same account that
// powers the service browser and the source badges. The pool size is not the
// bound that matters — every candidate TRIED costs a search whether or not it
// becomes a pick — so these caps are what stand between a day with expired
// credentials and several thousand live calls against an API that is not ours.
// ---------------------------------------------------------------------------
test("a build is bounded in how many upstream lookups it may make", async (t) => {
  await t.test("more resolves are allowed than picks are needed", () => {
    // Candidates that resolve to nothing still have to be skipped past, so a
    // cap equal to the pick count would routinely return fewer than five.
    assert.ok(F.smartMaxResolves() > F.smartAdjacentCount(),
      "no headroom for candidates that fail to resolve");
  });

  await t.test("the cap is well below the pool size", () => {
    // THE one. Without a cap the loop walks the whole pool, and a build with a
    // dead token spends 150 searches discovering that every one fails.
    assert.ok(F.smartMaxResolves() < F.smartPoolCount(),
      "the resolve loop can walk the entire candidate pool — that is the " +
      "unbounded-call path this cap exists to close");
  });

  await t.test("the stretch search is bounded in both dimensions", () => {
    // Genres × roster is a product: uncapped it is every outside genre times
    // sixty artists, each one a network call.
    assert.ok(F.smartMaxStretchGenres() > 0 && F.smartMaxStretchGenres() <= 5);
    assert.ok(F.smartMaxStretchRoster() > 0 && F.smartMaxStretchRoster() <= 25);
    assert.ok(F.smartMaxStretchGenres() * F.smartMaxStretchRoster() <= F.smartMaxResolves() + 20,
      "the stretch pick alone can outspend the entire adjacent pass");
  });
});

// ---------------------------------------------------------------------------
test("a shown artist stays out of the pool long enough to matter", async (t) => {
  await t.test("the window is months, not days", () => {
    // Too short and the same six names cycle back before the user has forgotten
    // them, which reads as the feature being stuck.
    assert.ok(F.smartSeenDays() >= 30, "shown artists come back too soon to feel like discovery");
  });
});
