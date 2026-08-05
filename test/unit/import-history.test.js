"use strict";
// ---------------------------------------------------------------------------
// v1.7.44: the play history as a last resort when importing a playlist.
//
// A shared playlist names an album. Two servers indexing the SAME files group
// and title compilations differently, so the name a share carries is sometimes
// one this library has never heard of — not because the music is missing, but
// because Roon files that recording somewhere else entirely.
//
// The `plays` table already knows where. It records `line3` from Roon's own
// now-playing feed, so for any track this household has played it holds ROON'S
// name for the album that track sits on. That is precisely the fact the share
// cannot carry and the snapshot cannot infer, and it costs zero Roon calls to
// read.
//
// The danger is the obvious one: this rung fires only after the album rung has
// failed, so it is operating on weaker evidence and must not start guessing.
// It matches on the track title AND the artist, and it still hands off to the
// same album resolver, which still refuses anything ambiguous.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  // Optional native build; the suite skips rather than failing for an
  // unrelated reason.
}

// The real DDL, read out of index.js so the test cannot drift from the schema.
function playsDdl() {
  const m = /CREATE TABLE IF NOT EXISTS plays\s*\([\s\S]*?\n\s*\);/.exec(indexSource());
  if (!m) throw new Error("the plays DDL was not found in index.js");
  return m[0];
}

// Roon's grouping: the Cranberries compilation is credited to Various Artists,
// and the original album sits alongside it under its own name.
const ALBUMS = [
  { offset: 10, title: "Everybody Else Is Doing It, So Why Can't We?",
    subtitle: "The Cranberries", nTitle: "everybody else is doing it so why can t we",
    nArtist: "the cranberries", image_key: "a10" },
  { offset: 20, title: "Greatest Hits", subtitle: "Foo Fighters",
    nTitle: "greatest hits", nArtist: "foo fighters", image_key: "a20" },
  { offset: 21, title: "Greatest Hits", subtitle: "Queen",
    nTitle: "greatest hits", nArtist: "queen", image_key: "a21" },
];

function build(rows) {
  const db = new Database(":memory:");
  db.exec(playsDdl());
  const ins = db.prepare(
    "INSERT INTO plays (ts, zone, track, artist, album, image_key, duration) " +
    "VALUES (?,?,?,?,?,?,?)");
  for (const r of rows || []) {
    for (let i = 0; i < (r.n || 1); i++) {
      ins.run(Date.now(), "Zone", r.track, r.artist, r.album, "", 200);
    }
  }

  const F = loadIndexFunctions(
    ["resolveSharedAlbum", "findSharedAlbum", "libraryLookup", "playsForTrack",
     "shareTrackRecord", "resolveSharedEntry", "userTrackRecord",
     "shareText", "shareInt", "shareTextMax",
     "normalize", "canonText", "canonArtist", "albumKey", "albumKeys",
     "albumTitleVariants", "creditHasArtist", "namesEqualLoose",
     "isCompilationCredit", "sharedCreditAgrees", "titleContainsPhrase",
     "findSharedAlbumByContainment", "sharedContainmentMinWords",
     "trackTitleKeys", "albumKeysForTrack", "resolveSharedByTrackIndex"],
    {
      labelsDb: db,
      DEBUG: false,
      albumIndex: { albums: ALBUMS, builtAt: 1 },
      ambiguousAlbumKeys: new Set(),
      _libLookup: { builtAt: -1, byKey: null, byTitle: null },
      splitCreditIntoArtists: (s) => [String(s || "")],
      creditIdentities: (s) => {
        const c = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        return { c, first: c, names: c ? [c] : [] };
      },
    });
  for (const al of ALBUMS) al.srcKeys = F.albumKeys(al.title, al.subtitle);
  return { F, db };
}

test("the play history rescues a track whose album this library groups differently",
  { concurrency: 1 }, async (t) => {
    if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

    await t.test("a compilation the library does not have resolves to the real album", () => {
      // THE one. The share says "The Best Of The Cranberries (20th Century
      // Masters)" — a title this library has never seen. The history knows
      // Roon plays "Dreams" from the original album.
      const { F, db } = build([{ track: "Dreams", artist: "The Cranberries",
        album: "Everybody Else Is Doing It, So Why Can't We?", n: 3 }]);
      const got = F.resolveSharedEntry({
        title: "Dreams", creator: "The Cranberries",
        album: "The Best Of The Cranberries (20th Century Masters)",
      });
      assert.ok(got, "the track was reported missing though the history knows where it is");
      assert.equal(got.track.album_offset, 10);
      assert.equal(got.via, "history",
        "it must be reported as a substitution, not as a direct album match");
      assert.equal(got.track.title, "Dreams");
      db.close();
    });

    await t.test("the direct album match still wins when it exists", () => {
      // The history rung is a fallback. If it ever ran first it would prefer
      // whatever the user happened to play over what the share actually named.
      const { F, db } = build([{ track: "All My Life", artist: "Foo Fighters",
        album: "Everybody Else Is Doing It, So Why Can't We?", n: 9 }]);
      const got = F.resolveSharedEntry({
        title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
      });
      assert.equal(got.via, "album");
      assert.equal(got.track.album_offset, 20, "the history overrode a perfectly good match");
      db.close();
    });

    await t.test("a different artist's play of the same track title is not used", () => {
      // Track titles collide constantly. Without the artist check, one
      // household's play of a cover version would redirect somebody else's
      // import to the wrong record.
      const { F, db } = build([{ track: "Dreams", artist: "Fleetwood Mac",
        album: "Everybody Else Is Doing It, So Why Can't We?", n: 5 }]);
      assert.equal(F.resolveSharedEntry({
        title: "Dreams", creator: "The Cranberries", album: "Some Compilation",
      }), null, "a play by a different artist was used to resolve the track");
      db.close();
    });

    await t.test("history pointing at an ambiguous album still refuses", () => {
      // "Greatest Hits" belongs to two albums here. The history rung hands off
      // to the same resolver, so the coin flip is declined exactly as it would
      // be on the direct path — the fallback must not be a way around the
      // safety rule.
      const { F, db } = build([{ track: "Mystery Song", artist: "Someone",
        album: "Greatest Hits", n: 4 }]);
      assert.equal(F.resolveSharedEntry({
        title: "Mystery Song", creator: "Someone", album: "Not In This Library",
      }), null);
      db.close();
    });

    await t.test("a track never played resolves nothing", () => {
      const { F, db } = build([]);
      assert.equal(F.resolveSharedEntry({
        title: "Never Heard", creator: "Nobody", album: "Not In This Library",
      }), null);
      db.close();
    });

    await t.test("an entry with NO album at all can now resolve", () => {
      // Roon playlist rows carry no album — Roon does not put one on the row —
      // so shares made from them were previously unresolvable by construction.
      // The history does not need the share to name an album.
      const { F, db } = build([{ track: "Dreams", artist: "The Cranberries",
        album: "Everybody Else Is Doing It, So Why Can't We?", n: 2 }]);
      const got = F.resolveSharedEntry({ title: "Dreams", creator: "The Cranberries" });
      assert.ok(got, "an album-less entry is still unresolvable");
      assert.equal(got.track.album_offset, 10);
      db.close();
    });

    await t.test("the most-played album wins when a track appears on several", () => {
      // A track legitimately sits on both the original and a compilation. The
      // one the household actually plays is the better answer.
      const { F, db } = build([
        { track: "Dreams", artist: "The Cranberries", album: "Greatest Hits", n: 1 },
        { track: "Dreams", artist: "The Cranberries",
          album: "Everybody Else Is Doing It, So Why Can't We?", n: 7 },
      ]);
      const got = F.resolveSharedEntry({
        title: "Dreams", creator: "The Cranberries", album: "Not In This Library",
      });
      assert.equal(got.track.album_offset, 10);
      db.close();
    });
  });

test("playsForTrack reads the history safely", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("it groups by album and orders by play count", () => {
    const { F, db } = build([
      { track: "Dreams", artist: "The Cranberries", album: "B", n: 2 },
      { track: "Dreams", artist: "The Cranberries", album: "A", n: 6 },
    ]);
    assert.deepEqual(F.playsForTrack("Dreams").map(r => r.album), ["A", "B"]);
    db.close();
  });

  await t.test("matching ignores case and surrounding space", () => {
    const { F, db } = build([{ track: "Dreams", artist: "X", album: "A", n: 1 }]);
    assert.equal(F.playsForTrack("  dreams  ").length, 1);
    db.close();
  });

  await t.test("rows with no album are not offered", () => {
    // A play recorded before Roon reported line3 has nothing to resolve to.
    const { F, db } = build([{ track: "Dreams", artist: "X", album: "", n: 3 }]);
    assert.deepEqual(F.playsForTrack("Dreams"), []);
    db.close();
  });

  await t.test("an empty or missing title asks nothing of the database", () => {
    const { F, db } = build([{ track: "Dreams", artist: "X", album: "A", n: 1 }]);
    assert.deepEqual(F.playsForTrack(""), []);
    assert.deepEqual(F.playsForTrack(null), []);
    db.close();
  });

  await t.test("no database at all degrades to nothing, not a throw", () => {
    // labelsDb is null whenever the data volume could not be opened. Import
    // must still work; it just loses this rung.
    const F = loadIndexFunctions(["playsForTrack"], { labelsDb: null, DEBUG: false });
    assert.deepEqual(F.playsForTrack("Dreams"), []);
  });
});
