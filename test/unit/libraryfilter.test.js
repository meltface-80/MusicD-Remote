"use strict";
// ---------------------------------------------------------------------------
// v1.7.50: the Library wall's text filter, and the prefix matcher behind it.
//
// A user asked for an A-Z rail down the edge of the screen. It worked under
// "Album name" and "Artist" and did nothing under the others — correctly, and
// unfixably: a letter index is meaningless the moment the wall is ordered by
// year, play count or random. A letter is a position in an alphabetical list,
// and there is no such position when the list is not alphabetical.
//
// A filter is orthogonal to sorting, so it works under every sort, and it can
// reach ARTISTS as well as titles — which a rail down the side of an album
// grid structurally cannot. That is why this replaced the request rather than
// implementing it.
//
// The matcher's two rules are the interesting part:
//   - titles match on `sortTitle`, the article-stripped key the wall already
//     sorts by, so "The Wall" narrows under W exactly where the wall files it;
//   - artists match per credited name, so "F" finds Fela Kuti inside
//     "Tony Allen / Fela Kuti" — and it is startsWith, never includes, because
//     v1.6.56 was spent removing substring artist matching from thirteen
//     call sites.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const F = loadIndexFunctions(
  ["libraryPrefix", "libraryPrefixMax", "albumMatchesPrefix", "normalize"], {});

// Records shaped the way indexRecord() builds them.
function rec(title, artist, names) {
  const nTitle = F.normalize(title);
  return {
    title, subtitle: artist,
    nTitle,
    nArtist: F.normalize(artist),
    sortTitle: nTitle.replace(/^(the|a|an) /, ""),
    artistNames: (names || [artist]).map(n => ({ name: n, n: F.normalize(n) })),
  };
}

test("the typed text is normalised the one way this file normalises anything", async (t) => {
  await t.test("case and surrounding space do not matter", () => {
    assert.equal(F.libraryPrefix("  Fela  "), "fela");
    assert.equal(F.libraryPrefix("FELA"), "fela");
  });

  await t.test("accents fold, so typing e finds Émilie", () => {
    assert.equal(F.libraryPrefix("É"), "e");
  });

  await t.test("empty, absent and junk all mean no filter", () => {
    for (const v of ["", "   ", null, undefined, "!!!"]) {
      assert.equal(F.libraryPrefix(v), "", JSON.stringify(v));
    }
  });

  await t.test("it is bounded — this arrives on a query string", () => {
    // Unbounded, a megabyte of "a" is compared against every album in the
    // library, synchronously, on a route anyone on the LAN can call.
    const long = F.libraryPrefix("a".repeat(5000));
    assert.equal(long.length, F.libraryPrefixMax());
    assert.ok(F.libraryPrefixMax() <= 200);
  });
});

test("a prefix matches by title or by artist", async (t) => {
  await t.test("an album title", () => {
    assert.equal(F.albumMatchesPrefix(rec("Rumours", "Fleetwood Mac"), "rum"), true);
    assert.equal(F.albumMatchesPrefix(rec("Rumours", "Fleetwood Mac"), "xyz"), false);
  });

  await t.test("THE one: a leading article is stripped, as the wall does", () => {
    // The wall files "The Wall" under W, and the "Starts with" facet buckets it
    // under W. A filter that put it under T would disagree with the screen it
    // is filtering.
    const wall = rec("The Wall", "Pink Floyd");
    assert.equal(F.albumMatchesPrefix(wall, "w"), true, "The Wall did not narrow under W");
    // "the wall" is still reachable — nTitle is checked too — so somebody who
    // types what they see is not told the album does not exist.
    assert.equal(F.albumMatchesPrefix(wall, "the w"), true);
  });

  await t.test("an artist name", () => {
    assert.equal(F.albumMatchesPrefix(rec("Rumours", "Fleetwood Mac"), "fleet"), true);
  });

  await t.test("THE other one: any credited artist, not just the billed one", () => {
    // A rail down the side of an album grid cannot do this at all, which is
    // part of why it was the wrong shape for the request.
    const al = rec("Rejoice", "Tony Allen / Fela Kuti", ["Tony Allen", "Fela Kuti"]);
    assert.equal(F.albumMatchesPrefix(al, "fela"), true,
      "a collaborator who is not billed first was unreachable");
    assert.equal(F.albumMatchesPrefix(al, "tony"), true);
  });

  await t.test("STARTS with, never CONTAINS", () => {
    // v1.6.56's lesson. A substring test puts Prince's records in front of
    // somebody typing "prince" for Bonnie "Prince" Billy, and vice versa.
    const bpb = rec("I See A Darkness", 'Bonnie "Prince" Billy');
    assert.equal(F.albumMatchesPrefix(bpb, "prince"), false,
      "substring artist matching is back — the exact bug v1.6.56 eradicated");
    assert.equal(F.albumMatchesPrefix(bpb, "bonnie"), true);

    const rum = rec("Rumours", "Fleetwood Mac");
    assert.equal(F.albumMatchesPrefix(rum, "mours"), false, "a mid-word match was accepted");
  });

  await t.test("an empty prefix matches everything", () => {
    // The filter being off must not narrow the wall to nothing.
    assert.equal(F.albumMatchesPrefix(rec("Rumours", "Fleetwood Mac"), ""), true);
  });

  await t.test("a record with missing fields does not throw", () => {
    // The snapshot is rebuilt in stages; a partially-populated record must
    // narrow the wall rather than break the screen.
    for (const bad of [{}, { sortTitle: null }, { artistNames: null },
                       { artistNames: [{}] }, { nArtist: undefined }]) {
      assert.doesNotThrow(() => F.albumMatchesPrefix(bad, "a"), JSON.stringify(bad));
    }
  });

  await t.test("a single letter is a real answer, not a special case", () => {
    // The whole point of the request: type F, see F.
    const albums = [rec("Further", "Flying Saucer Attack"),
                    rec("Rumours", "Fleetwood Mac"),
                    rec("Kind of Blue", "Miles Davis")];
    const hits = albums.filter(a => F.albumMatchesPrefix(a, "f"));
    assert.equal(hits.length, 2, "F matched " + hits.length + " of three known albums");
  });
});

test("the filter runs in the FILTER chain, before the comparator", async (t) => {
  // This is the claim that makes a filter better than a letter rail, and it is
  // structural rather than behavioural: the prefix narrows `list` before the
  // sort touches it, so there is no per-sort code path that could disagree.
  // libraryView is 90 lines of closure over module state and is not loadable
  // in isolation, so the ordering is asserted on the source — the same
  // approach the Labels gate uses.
  const { indexSource } = require("../lib/extract");
  const src = indexSource();
  const fn = src.slice(src.indexOf("function libraryView(q) {"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));

  await t.test("the prefix filter precedes the sort", () => {
    const filterAt = body.indexOf("albumMatchesPrefix(al, prefix)");
    // The COMPARATOR, not any .sort() — the cache-signature line sorts a facet
    // list and would otherwise match first, making this assertion vacuous.
    const sortAt = body.indexOf("list.slice().sort(cmp)");
    assert.ok(filterAt > 0, "the prefix filter is no longer in libraryView");
    assert.ok(sortAt > 0, "the comparator call moved — this test is anchored to it");
    assert.ok(filterAt < sortAt,
      "the prefix is applied after the comparator — it has become a property " +
      "of the ordering rather than of the set, which is exactly what made the " +
      "A-Z rail work under two sorts and not the rest");
  });

  await t.test("the prefix is part of the cache signature", () => {
    // Absent from the signature, a filtered request and an unfiltered one share
    // a cache entry, and the funnel appears to do nothing intermittently.
    const sigLine = body.slice(body.indexOf("const sig ="), body.indexOf("const hit"));
    assert.ok(/prefix/.test(sigLine),
      "the cache key ignores the prefix — the wall will serve unfiltered " +
      "results for a filtered request");
  });

  await t.test("a filtered view is not cached at all", () => {
    // Free text is unbounded: every keystroke is a new key, and a fixed-size
    // cache would be evicted down to nothing by one session of typing.
    assert.ok(/const hit = prefix \? null :/.test(body),
      "filtered views are being cached — a fixed-size cache cannot hold an " +
      "unbounded key space, and the entries the cache exists for get evicted");
  });
});
