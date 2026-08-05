"use strict";
// ---------------------------------------------------------------------------
// v1.7.46: the import resolver, after a diagnosis of three real misses.
//
// A user imported a six-track playlist shared from a Logitech Media Server
// pointed at the SAME files and the same Qobuz account. Three tracks came back
// "couldn't be matched":
//
//     Dreams      · The Cranberries · The Best Of The Cranberries (20th …)
//     Linger      · The Cranberries · The Best Of The Cranberries (20th …)
//     All My Life · Foo Fighters    · Greatest Hits
//
// Investigating those produced one alarming discovery and two structural ones.
//
// THE ALARMING ONE. The title-only rung did not look at the artist at all, so
// with Queen's "Greatest Hits" in the library and no Foo Fighters one, that
// third entry resolved to QUEEN — reported as a clean match, not flagged as a
// substitution. A miss is a visible, honest outcome; a silent wrong record in
// somebody's playlist is the failure this whole report was built to prevent.
//
// THE STRUCTURAL ONES.
//   1. v1.7.44 began stripping edition suffixes to build identities, which
//      makes "Greatest Hits" and "Greatest Hits (Deluxe Edition)" by one artist
//      both claim the same key. They are then ambiguous BY CONSTRUCTION and
//      every later rung declined — so owning both editions resolved worse than
//      owning neither, and worse than the same library did before v1.7.44.
//   2. Every rung compared NAMES, and Roon's name for a compilation is
//      routinely a superset of the one on disk. No amount of suffix-stripping
//      reaches "20th Century Masters - The Millennium Collection: The Best of
//      The Cranberries" from "The Best Of The Cranberries (20th Century
//      Masters)", because the extra words are on the front.
//
// And underneath all of it: nothing in this extension knew which tracks are on
// which album. Not the snapshot, not the /music scan, not any service client.
// So "which record holds this track, then?" had no answer at any price. The
// album_tracks table is that answer, recorded free from every album the app
// opens for any reason.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  // Optional native build; the suite skips rather than failing for an
  // unrelated reason.
}

// The real DDL, read out of index.js so these tests cannot drift from the
// schema they are asserting against.
function ddl(name) {
  const re = new RegExp("CREATE TABLE IF NOT EXISTS " + name + "\\s*\\([\\s\\S]*?\\n\\s*\\);");
  const m = re.exec(indexSource());
  if (!m) throw new Error("the " + name + " DDL was not found in index.js");
  return m[0];
}

const EXTRACT = [
  "resolveSharedAlbum", "findSharedAlbum", "libraryLookup", "playsForTrack",
  "shareTrackRecord", "resolveSharedEntry", "userTrackRecord",
  "shareText", "shareInt", "shareTextMax",
  "normalize", "canonText", "canonArtist", "albumKey", "albumKeys",
  "albumTitleVariants", "creditHasArtist", "namesEqualLoose",
  "isCompilationCredit", "sharedCreditAgrees", "titleContainsPhrase",
  "findSharedAlbumByContainment", "sharedContainmentMinWords",
  "trackTitleKeys", "albumKeysForTrack", "resolveSharedByTrackIndex",
  "rememberAlbumTracks", "indexedAlbumKeys",
];

// Build a library + database from plain descriptions. `albums` are
// {offset,title,subtitle}; srcKeys are computed with the SHIPPING albumKeys so
// the fixture cannot describe an identity the real code would never produce.
function build(albums, opts) {
  const o = opts || {};
  const db = new Database(":memory:");
  db.exec(ddl("plays"));
  db.exec(ddl("album_tracks"));
  db.exec("CREATE INDEX IF NOT EXISTS album_tracks_tkey ON album_tracks(tkey);");

  const list = albums.map(a => Object.assign({ image_key: "img" + a.offset }, a));
  // Injected by reference, so the derived contents below are visible to the
  // extracted functions without the harness needing a setter.
  const ambiguous = new Set();
  const F = loadIndexFunctions(EXTRACT, {
    labelsDb: db,
    DEBUG: false,
    albumIndex: { albums: list, builtAt: 1 },
    ambiguousAlbumKeys: ambiguous,
    _libLookup: { builtAt: -1, byKey: null, byTitle: null, byAkey: null, canon: null },
    splitCreditIntoArtists: (s) => [String(s || "")],
    creditIdentities: (s) => {
      // Faithful to the real one's SHAPE — {c, first, names} — because a stub
      // returning an array makes creditHasArtist silently always false, which
      // is how a previous fixture in this suite lied for two versions.
      const c = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const names = c ? c.split(/\s*(?:,| and | & )\s*/).filter(Boolean) : [];
      return { c, first: names[0] || c, names: names.length ? names : (c ? [c] : []) };
    },
  });
  for (const al of list) al.srcKeys = F.albumKeys(al.title, al.subtitle);

  // Ambiguity is DERIVED, exactly as rebuildAmbiguousAlbumKeys derives it: a
  // key belongs to more than one album. Hand-listing it would let a test
  // assert against an ambiguity the real index would never produce.
  const seen = new Map();
  for (const al of list) {
    for (const k of al.srcKeys) {
      const owner = seen.get(k);
      if (owner === undefined) seen.set(k, al.offset);
      else if (owner !== al.offset) ambiguous.add(k);
    }
  }

  for (const t of (o.tracks || [])) F.rememberAlbumTracks(t.album, t.artist, t.titles.map(x => ({ title: x })));
  const ins = db.prepare(
    "INSERT INTO plays (ts, zone, track, artist, album, image_key, duration) VALUES (?,?,?,?,?,?,?)");
  for (const r of (o.plays || [])) {
    for (let i = 0; i < (r.n || 1); i++) ins.run(Date.now(), "Z", r.track, r.artist, r.album, "", 200);
  }
  return { F, db, list };
}

test("a title on its own must never outvote the artist", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("THE one: a lone Greatest Hits by someone else is NOT the match", () => {
    // The library has Queen's Greatest Hits and no Foo Fighters record at all.
    // Before this fix the title-only rung returned Queen and the report called
    // it a clean match. Wrong music in a playlist, presented as right.
    const { F, db } = build([{ offset: 0, title: "Greatest Hits", subtitle: "Queen" }]);
    assert.equal(F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    }), null, "a Foo Fighters track resolved to Queen's album");
    db.close();
  });

  await t.test("a compilation credit is still allowed to stay silent", () => {
    // The reason the title-only rung exists: a Various Artists album cannot
    // name the track's artist, so requiring it would delete the rung.
    const { F, db } = build([
      { offset: 0, title: "Now That's What I Call Music 40", subtitle: "Various Artists" },
    ]);
    const got = F.resolveSharedEntry({
      title: "Some Song", creator: "Some Band", album: "Now That's What I Call Music 40",
    });
    assert.ok(got, "a Various Artists compilation stopped resolving");
    assert.equal(got.track.album_offset, 0);
    db.close();
  });

  await t.test("an entry with no artist at all still resolves on the title", () => {
    const { F, db } = build([{ offset: 0, title: "Kind Of Blue", subtitle: "Miles Davis" }]);
    const got = F.resolveSharedEntry({ title: "So What", album: "Kind Of Blue" });
    assert.ok(got);
    assert.equal(got.track.album_offset, 0);
    db.close();
  });

  await t.test("the right artist among several sharing a title still wins", () => {
    const { F, db } = build([
      { offset: 0, title: "Greatest Hits", subtitle: "Queen" },
      { offset: 1, title: "Greatest Hits", subtitle: "Foo Fighters" },
    ]);
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    });
    assert.equal(got.track.album_offset, 1);
    assert.equal(got.via, "album");
    db.close();
  });
});

test("owning two editions must not be worse than owning one", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("the plain edition is found even though the deluxe shares its key", () => {
    // Both emit "greatest hits||foo fighters" once the suffix is stripped, so
    // the identity is ambiguous by construction. The share named the plain one
    // exactly; there is nothing to flip a coin about.
    const { F, db } = build([
      { offset: 0, title: "Greatest Hits", subtitle: "Foo Fighters" },
      { offset: 1, title: "Greatest Hits (Deluxe Edition)", subtitle: "Foo Fighters" },
    ]);
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    });
    assert.ok(got, "an edition twin made a perfectly nameable album unresolvable");
    assert.equal(got.track.album_offset, 0);
    db.close();
  });

  await t.test("and the deluxe edition is found when the share names THAT", () => {
    const { F, db } = build([
      { offset: 0, title: "Greatest Hits", subtitle: "Foo Fighters" },
      { offset: 1, title: "Greatest Hits (Deluxe Edition)", subtitle: "Foo Fighters" },
    ]);
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits (Deluxe Edition)",
    });
    assert.equal(got.track.album_offset, 1);
    db.close();
  });

  await t.test("a genuine duplicate — same title, same artist — still declines", () => {
    // A local rip beside a streaming copy Roon did not group. Nothing
    // distinguishes them, so picking one IS a coin flip and the rule stands.
    const { F, db } = build([
      { offset: 0, title: "Greatest Hits", subtitle: "Foo Fighters" },
      { offset: 1, title: "Greatest Hits", subtitle: "Foo Fighters" },
    ]);
    assert.equal(F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    }), null, "an unresolvable duplicate was resolved anyway");
    db.close();
  });
});

test("Roon's name for a record can be a superset of the share's", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  const ROON_TITLE =
    "20th Century Masters - The Millennium Collection: The Best of The Cranberries";

  await t.test("THE one: the compilation resolves through containment", () => {
    const { F, db } = build([{ offset: 0, title: ROON_TITLE, subtitle: "The Cranberries" }]);
    const got = F.resolveSharedEntry({
      title: "Dreams", creator: "The Cranberries",
      album: "The Best Of The Cranberries (20th Century Masters)",
    });
    assert.ok(got, "no rung could reach Roon's longer name for the same record");
    assert.equal(got.track.album_offset, 0);
    assert.equal(got.via, "album");
    db.close();
  });

  await t.test("two albums containing the phrase decline rather than guess", () => {
    const { F, db } = build([
      { offset: 0, title: ROON_TITLE, subtitle: "The Cranberries" },
      { offset: 1, title: "The Best of The Cranberries Live", subtitle: "The Cranberries" },
    ]);
    assert.equal(F.resolveSharedEntry({
      title: "Dreams", creator: "The Cranberries",
      album: "The Best Of The Cranberries (Something Else Entirely)",
    }), null, "two containment candidates produced a guess");
    db.close();
  });

  await t.test("the credit must NAME the artist — a compilation is not enough here", () => {
    // Rung 3's compilation escape is deliberately not extended to containment:
    // containment is the loosest comparison in the file, and "Various Artists"
    // plus a partial title is not evidence.
    const { F, db } = build([
      { offset: 0, title: ROON_TITLE, subtitle: "Various Artists" },
    ]);
    assert.equal(F.resolveSharedEntry({
      title: "Dreams", creator: "The Cranberries",
      album: "The Best Of The Cranberries (20th Century Masters)",
    }), null);
    db.close();
  });

  await t.test("a short title never matches by containment", () => {
    // "Greatest Hits" is two words. Allowing it would make every Greatest Hits
    // in the library a candidate for every other.
    const { F, db } = build([
      { offset: 0, title: "Greatest Hits Volume One", subtitle: "Foo Fighters" },
    ]);
    assert.equal(F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    }), null, "a two-word title was matched loosely");
    assert.equal(F.sharedContainmentMinWords(), 3);
    db.close();
  });

  await t.test("with no artist to confirm against, containment never fires", () => {
    const { F, db } = build([{ offset: 0, title: ROON_TITLE, subtitle: "The Cranberries" }]);
    assert.equal(F.resolveSharedEntry({
      title: "Dreams", album: "The Best Of The Cranberries (20th Century Masters)",
    }), null);
    db.close();
  });

  await t.test("whole words only — never a substring", () => {
    // The v1.6.56 lesson: substring matching is how "Also appears on" listed
    // the wrong artists at 13 call sites.
    assert.equal(F0().titleContainsPhrase("living in the past", "live"), false);
    assert.equal(F0().titleContainsPhrase("live in the past", "live"), true);
    assert.equal(F0().titleContainsPhrase("a live album", "live"), true);
    assert.equal(F0().titleContainsPhrase("recorded live", "live"), true);
  });
});

// A functions-only handle for the pure helpers, with no database at all.
let _f0 = null;
function F0() {
  if (!_f0) {
    _f0 = loadIndexFunctions(
      ["titleContainsPhrase", "isCompilationCredit", "canonText", "normalize",
       "trackTitleKeys", "albumTitleVariants"],
      { labelsDb: null, DEBUG: false });
  }
  return _f0;
}

test("the track index answers what no name comparison can", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("THE one: the share's album does not exist, the track does", () => {
    // Roon files "All My Life" on "One by One". The share calls the album
    // "Greatest Hits", which this library has never heard of under any reading
    // of the name. Only the contents of the record can bridge that.
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters",
                   titles: ["All My Life", "Times Like These", "Low"] }] });
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    });
    assert.ok(got, "the track was reported missing though the library holds it");
    assert.equal(got.track.album_offset, 0);
    assert.equal(got.via, "tracks", "it must be reported as a substitution");
    db.close();
  });

  await t.test("an entry with no album at all resolves from the track alone", () => {
    // Roon's own playlist rows carry no album, so shares made from them were
    // unresolvable by construction.
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters", titles: ["All My Life"] }] });
    const got = F.resolveSharedEntry({ title: "All My Life", creator: "Foo Fighters" });
    assert.ok(got);
    assert.equal(got.track.album_offset, 0);
    db.close();
  });

  await t.test("a track on two albums declines rather than picking one", () => {
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" },
       { offset: 1, title: "Skin and Bones", subtitle: "Foo Fighters" }],
      { tracks: [
        { album: "One by One",     artist: "Foo Fighters", titles: ["All My Life"] },
        { album: "Skin and Bones", artist: "Foo Fighters", titles: ["All My Life"] }] });
    assert.equal(F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Nowhere",
    }), null, "a track on two records was placed on one of them anyway");
    db.close();
  });

  await t.test("somebody else's cover of the same title is not used", () => {
    // Track titles collide constantly, which is exactly why the artist gate is
    // not optional on this rung.
    const { F, db } = build(
      [{ offset: 0, title: "Pin Ups", subtitle: "David Bowie" }],
      { tracks: [{ album: "Pin Ups", artist: "David Bowie", titles: ["Sorrow"] }] });
    assert.equal(F.resolveSharedEntry({
      title: "Sorrow", creator: "Bad Religion", album: "The Process of Belief",
    }), null, "a cover version resolved to the wrong artist's album");
    db.close();
  });

  await t.test("a remaster suffix on either side does not hide the track", () => {
    const { F, db } = build(
      [{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }],
      { tracks: [{ album: "Rumours", artist: "Fleetwood Mac",
                   titles: ["Dreams (2004 Remaster)"] }] });
    const got = F.resolveSharedEntry({
      title: "Dreams", creator: "Fleetwood Mac", album: "Not In This Library",
    });
    assert.ok(got, "a remaster suffix on Roon's side hid the track");
    assert.equal(got.track.album_offset, 0);
    db.close();
  });

  await t.test("a row whose album has left the library resolves to nothing", () => {
    // The table deliberately outlives individual snapshots, so it will hold
    // albums that are no longer there.
    const { F, db } = build(
      [{ offset: 0, title: "Something Else", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters", titles: ["All My Life"] }] });
    assert.equal(F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Nowhere",
    }), null);
    db.close();
  });

  await t.test("the named album still wins over the track index", () => {
    // The index is a FALLBACK. If it ever ran first it would prefer whatever
    // the household happens to have opened over what the share actually named.
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" },
       { offset: 1, title: "Greatest Hits", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters", titles: ["All My Life"] }] });
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Greatest Hits",
    });
    assert.equal(got.via, "album");
    assert.equal(got.track.album_offset, 1);
    db.close();
  });

  await t.test("the track index is consulted BEFORE the play history", () => {
    // Both can answer; the index is Roon's actual album contents, the history
    // is text Roon rendered on a now-playing line at some past moment.
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" },
       { offset: 1, title: "In Your Honor", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters", titles: ["All My Life"] }],
        plays: [{ track: "All My Life", artist: "Foo Fighters",
                  album: "In Your Honor", n: 9 }] });
    const got = F.resolveSharedEntry({
      title: "All My Life", creator: "Foo Fighters", album: "Nowhere",
    });
    assert.equal(got.via, "tracks");
    assert.equal(got.track.album_offset, 0);
    db.close();
  });
});

test("recording an album's contents", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("it stores one row per track, in order", () => {
    const { F, db } = build([{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }]);
    const n = F.rememberAlbumTracks("Rumours", "Fleetwood Mac",
      [{ title: "Second Hand News" }, { title: "Dreams" }, { title: "Never Going Back Again" }]);
    assert.equal(n, 3);
    const rows = db.prepare("SELECT title, n FROM album_tracks ORDER BY n").all();
    assert.deepEqual(rows.map(r => r.title),
      ["Second Hand News", "Dreams", "Never Going Back Again"]);
    assert.deepEqual(rows.map(r => r.n), [0, 1, 2]);
    db.close();
  });

  await t.test("re-recording REPLACES, so a changed album keeps no phantoms", () => {
    // A re-rip or a different edition taking the same identity must not leave
    // tracks behind that the album no longer has — those would resolve imports
    // onto a record that does not contain them.
    const { F, db } = build([{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }]);
    F.rememberAlbumTracks("Rumours", "Fleetwood Mac", [{ title: "Dreams" }, { title: "Gone" }]);
    F.rememberAlbumTracks("Rumours", "Fleetwood Mac", [{ title: "Dreams" }]);
    const titles = db.prepare("SELECT title FROM album_tracks").all().map(r => r.title);
    assert.deepEqual(titles, ["Dreams"], "a track the album no longer has survived");
    db.close();
  });

  await t.test("empty, blank and punctuation-only entries are skipped, not stored", () => {
    const { F, db } = build([{ offset: 0, title: "X", subtitle: "Y" }]);
    assert.equal(F.rememberAlbumTracks("Rumours", "Fleetwood Mac",
      [{ title: "" }, { title: "   " }, { title: "!!!" }, { title: "Dreams" }]), 1);
    db.close();
  });

  await t.test("an album with no canonical title is never keyed", () => {
    // normalize() collapses an all-symbol title to "", and keying those would
    // make unrelated albums collide — the rule albumKey already states.
    const { F, db } = build([{ offset: 0, title: "X", subtitle: "Y" }]);
    assert.equal(F.rememberAlbumTracks("+++", "Someone", [{ title: "Dreams" }]), 0);
    db.close();
  });

  await t.test("no tracks, or no database, is zero rather than a throw", () => {
    const { F, db } = build([{ offset: 0, title: "X", subtitle: "Y" }]);
    assert.equal(F.rememberAlbumTracks("Rumours", "Fleetwood Mac", []), 0);
    assert.equal(F.rememberAlbumTracks("Rumours", "Fleetwood Mac", null), 0);
    db.close();
    const G = loadIndexFunctions(["rememberAlbumTracks", "albumKey", "canonText", "normalize"],
      { labelsDb: null, DEBUG: false });
    assert.equal(G.rememberAlbumTracks("Rumours", "Fleetwood Mac", [{ title: "Dreams" }]), 0);
  });

  await t.test("indexedAlbumKeys lists what has been recorded, and degrades to empty", () => {
    const { F, db } = build(
      [{ offset: 0, title: "One by One", subtitle: "Foo Fighters" }],
      { tracks: [{ album: "One by One", artist: "Foo Fighters", titles: ["All My Life"] }] });
    assert.deepEqual([...F.indexedAlbumKeys()], [F.albumKey("One by One", "Foo Fighters")]);
    db.close();
    const G = loadIndexFunctions(["indexedAlbumKeys"], { labelsDb: null, DEBUG: false });
    assert.equal(G.indexedAlbumKeys().size, 0);
  });
});

test("the play history reads more tolerantly than byte-for-byte", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("a remastered title in the history still matches a plain share", () => {
    // Roon renders "Dreams (Remastered 2020)" on the now-playing line; the
    // share carries "Dreams". Byte-exact equality missed every one of these.
    const { F, db } = build(
      [{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }],
      { plays: [{ track: "Dreams (Remastered 2020)", artist: "Fleetwood Mac",
                  album: "Rumours", n: 4 }] });
    const got = F.resolveSharedEntry({
      title: "Dreams", creator: "Fleetwood Mac", album: "Not In This Library",
    });
    assert.ok(got, "an edition suffix in the history hid a track this library has");
    assert.equal(got.via, "history");
    db.close();
  });

  await t.test("the artist column belongs to its own group", () => {
    // Grouping by album alone made `artist` a bare column over a group —
    // SQLite returns an arbitrary member's value — and the caller uses it as a
    // veto. One oddly-rendered credit among many plays could kill the album.
    const { F, db } = build(
      [{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }],
      { plays: [
        { track: "Dreams", artist: "Fleetwood Mac / Stevie Nicks", album: "Rumours", n: 1 },
        { track: "Dreams", artist: "Fleetwood Mac", album: "Rumours", n: 6 }] });
    const rows = F.playsForTrack("Dreams");
    assert.equal(rows.length, 2, "the two credits were collapsed into one arbitrary row");
    assert.equal(rows[0].artist, "Fleetwood Mac", "the most-played credit did not come first");
    const got = F.resolveSharedEntry({
      title: "Dreams", creator: "Fleetwood Mac", album: "Not In This Library",
    });
    assert.ok(got, "an odd credit on one play vetoed an album with six good ones");
    db.close();
  });

  await t.test("an exact hit never pays for the canonical scan", () => {
    const { F, db } = build(
      [{ offset: 0, title: "Rumours", subtitle: "Fleetwood Mac" }],
      { plays: [{ track: "Dreams", artist: "Fleetwood Mac", album: "Rumours", n: 2 }] });
    const rows = F.playsForTrack("Dreams");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].album, "Rumours");
    db.close();
  });
});

test("the two Roon-reading caps are real numbers, not comments", async (t) => {
  const F = loadIndexFunctions(["shareDeepAlbumMax", "shareDeepPerEntryMax"],
    { labelsDb: null, DEBUG: false });
  await t.test("an import cannot open an unbounded number of albums", () => {
    assert.ok(F.shareDeepAlbumMax() >= 1 && F.shareDeepAlbumMax() <= 100);
    assert.ok(F.shareDeepPerEntryMax() >= 1);
    assert.ok(F.shareDeepPerEntryMax() <= F.shareDeepAlbumMax(),
      "one entry may consume the whole import's budget");
  });
});
