"use strict";
// ---------------------------------------------------------------------------
// v1.8.74: Album of the day, the same on every device, from 00:01 to 00:01.
//
// Before, the pick was hash(date) % albums.length, worked out afresh on every
// ask. Two things followed from that and both were reported:
//   * a scan that added or removed ONE album moved the pick mid-day, and an
//     album already played came back as a "new" Album of the day;
//   * the day turned at midnight, not at the 00:01 the user asked for.
// The pick is now chosen once and kept (smart_cache, key "aotd"), as an album
// IDENTITY, and only a new day or the album leaving the library replaces it.
//
// And: "Not played in 6 months" offers nothing until the extension has six
// months of listening behind it (firstPlayTs).
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// albumKey stand-in: the real one canonicalises; identity is all that matters.
const albumKey = (t, a) => (t ? String(t).toLowerCase() + "||" + String(a || "").toLowerCase() : null);
const fnv1aHash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const smartDayKey = (t) => {
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
};

function albumsOf(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ offset: i, title: "Album " + i, subtitle: "Artist " + i });
  return out;
}

// One "server": a cache that survives between asks, and an index that can be
// swapped to simulate a rescan.
function server(albums) {
  const store = new Map();
  const state = { albumIndex: { albums, builtAt: 1 } };
  const inj = {
    albumIndex: state.albumIndex,
    smartCacheGet: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    smartCacheSet: (k, v) => store.set(k, JSON.stringify(v)),
    albumKey, fnv1aHash, smartDayKey,
    aotdMemo: { builtAt: -1, day: "", al: null },
  };
  const fns = loadIndexFunctions(["aotdDayKey", "aotdDayStart", "albumOfTheDay", "albumOfTheDayResolve"], inj);
  return { fns, inj, store };
}

test("the day turns at 00:01, not at midnight", () => {
  const { fns } = server(albumsOf(3));
  assert.equal(fns.aotdDayKey(new Date(2026, 9, 3, 0, 0, 30)), "2026-10-02",
    "half a minute past midnight is still yesterday's album");
  assert.equal(fns.aotdDayKey(new Date(2026, 9, 3, 0, 1, 0)), "2026-10-03");
  assert.equal(fns.aotdDayKey(new Date(2026, 9, 3, 23, 59, 0)), "2026-10-03");
  assert.equal(fns.aotdDayStart(new Date(2026, 9, 3, 14, 0)), new Date(2026, 9, 3, 0, 1).getTime(),
    "played-since is counted from 00:01");
  assert.equal(fns.aotdDayStart(new Date(2026, 9, 3, 0, 0, 30)), new Date(2026, 9, 2, 0, 1).getTime());
});

test("the pick is kept through a library change the same day", () => {
  const albums = albumsOf(50);
  const a = server(albums);
  const noon = new Date(2026, 9, 3, 12, 0);
  const first = a.fns.albumOfTheDay(noon);
  assert.ok(first, "no album chosen");
  assert.ok(a.store.has("aotd"), "the pick was not kept");

  // A rescan: one album added, the index rebuilt. The hash-mod rule would
  // usually land elsewhere now; the kept pick must not move.
  const grown = albums.concat([{ offset: 50, title: "Brand New", subtitle: "Someone" }]);
  const b = server(grown);
  for (const [k, v] of a.store) b.store.set(k, v);
  const later = b.fns.albumOfTheDay(new Date(2026, 9, 3, 18, 0));
  assert.equal(later.title, first.title, "a rescan moved the day's album");
});

test("a new day — and only a new day — chooses again", () => {
  const s = server(albumsOf(400));
  const picks = new Set();
  for (let d = 1; d <= 10; d++) {
    const al = s.fns.albumOfTheDay(new Date(2026, 9, d, 9, 0));
    // Same day, later: the same album.
    s.inj.aotdMemo.builtAt = -1;   // as if from a fresh process — read the kept one
    assert.equal(s.fns.albumOfTheDay(new Date(2026, 9, d, 23, 0)).title, al.title);
    picks.add(al.title);
  }
  assert.ok(picks.size >= 8, "ten days gave only " + picks.size + " different albums");
});

test("an album that left the library is replaced, not shown", () => {
  const albums = albumsOf(20);
  const a = server(albums);
  const noon = new Date(2026, 9, 3, 12, 0);
  const first = a.fns.albumOfTheDay(noon);
  const b = server(albums.filter((x) => x.title !== first.title));
  for (const [k, v] of a.store) b.store.set(k, v);
  const next = b.fns.albumOfTheDay(noon);
  assert.ok(next && next.title !== first.title);
});

test("an empty library has no album of the day", () => {
  assert.equal(server([]).fns.albumOfTheDay(new Date()), null);
});

// ---------------------------------------------------------------------------
// The 6-month gate, read from the route's own source: the route needs Express
// and a Core, so what is checked is that it asks firstPlayTs and returns
// no_history before it reads a single play.
// ---------------------------------------------------------------------------
test("Not played in 6 months waits for six months of history", () => {
  const src = require("../lib/extract").indexSource();
  const start = src.indexOf('app.get("/api/home/unplayed"');
  assert.ok(start > -1);
  const body = src.slice(start, src.indexOf("\n});", start));
  const gate = body.indexOf("firstPlayTs()");
  const heard = body.indexOf("getPlayedTitlesSince(");
  assert.ok(gate > -1, "the route does not ask when the first play was");
  assert.ok(gate < heard, "the route reads plays before checking there are six months of them");
  assert.match(body, /if \(!first \|\| first > cutoff\)/);
  assert.match(body, /no_history: true/);

  const { firstPlayTs } = loadIndexFunctions(["firstPlayTs"], {
    labelsDb: { prepare: () => ({ get: () => ({ ts: 1234 }) }) },
  });
  assert.equal(firstPlayTs(), 1234);
  const none = loadIndexFunctions(["firstPlayTs"], {
    labelsDb: { prepare: () => ({ get: () => ({ ts: null }) }) },
  });
  assert.equal(none.firstPlayTs(), null, "an empty plays table must read as no history");
  const noDb = loadIndexFunctions(["firstPlayTs"], { labelsDb: null });
  assert.equal(noDb.firstPlayTs(), null);
});
