"use strict";
// ---------------------------------------------------------------------------
// v1.7.23: importing a shared playlist, and the store it lands in.
//
// Two trust boundaries meet here and both are hostile in principle:
//
//   1. The blob is authored by someone else. It is decompressed, parsed and
//      turned into records that persist on the data volume. Nothing in it may
//      reach storage except through a fresh object literal built from a named
//      field list.
//   2. playlists.json is the ONLY copy of something the user made. Every other
//      versioned file on that volume is a derived cache that can be discarded
//      and rebuilt; this one cannot. A version mismatch must preserve it.
//
// And the resolver has its own rule: an entry it cannot identify with
// confidence must be REPORTED, never guessed at. Two albums sharing a title is
// a coin flip, and a coin flip that silently puts the wrong record in someone's
// playlist is worse than a miss they can see.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { loadIndexFunctions } = require("../lib/extract");

// A tiny stand-in library. `nTitle`/`nArtist` are what the real snapshot
// precomputes, so the resolver sees exactly the shape it sees in production.
const ALBUMS = [
  { offset: 10, title: "Perfect From Now On", subtitle: "Built to Spill",
    nTitle: "perfect from now on", nArtist: "built to spill", image_key: "a10" },
  { offset: 20, title: "Goo", subtitle: "Sonic Youth",
    nTitle: "goo", nArtist: "sonic youth", image_key: "a20" },
  // Two different records with the SAME title — the coin flip.
  { offset: 30, title: "Reunion", subtitle: "Band One",
    nTitle: "reunion", nArtist: "band one", image_key: "a30" },
  { offset: 31, title: "Reunion", subtitle: "Band Two",
    nTitle: "reunion", nArtist: "band two", image_key: "a31" },
  // A compilation, exactly as Roon files one: the album is credited to Various
  // Artists while a shared playlist names the TRACK's artist. No title+artist
  // identity can bridge that, which is the case the import bug was about.
  { offset: 40, title: "The Best Of The Cranberries (20th Century Masters)",
    subtitle: "Various Artists", nTitle: "the best of the cranberries 20th century masters",
    nArtist: "various artists", image_key: "a40" },
];

const {
  userTrackRecord, userPlaylistRecord, decodeSharePayload,
  encodeSharePayload, buildShareDoc, shareMagic,
  userPlNameMax, userPlTracksMax, albumKeys, resolveSharedEntry, findSharedAlbum,
} = loadIndexFunctions(
  ["userTrackRecord", "userPlaylistRecord", "decodeSharePayload", "shareTrackRecord",
   "encodeSharePayload", "buildShareDoc", "shareMagic", "shareText", "shareInt",
   "shareUriList", "sharePrune", "shareTrackEntry",
   "shareTextMax", "shareNameMax", "shareTrackMax", "shareUriMax",
   "shareNsTrack", "shareNsPlaylist",
   "userPlNameMax", "userPlTracksMax", "userPlMax", "normalize", "canonText",
   "canonArtist", "albumKeys", "albumTitleVariants", "creditHasArtist",
   // v1.7.44: the resolver reads names the way the rest of index.js does, and
   // falls back to the play history when the shared album is not this
   // library's grouping. All of it is EXTRACTED — a stubbed matcher would be
   // testing the stub's tolerance, which is the whole subject here.
   "resolveSharedAlbum", "findSharedAlbum", "libraryLookup", "playsForTrack",
   "resolveSharedEntry", "namesEqualLoose",
   // v1.7.46: the resolver stopped letting a bare title outvote the artist,
   // gained a containment rung for Roon's longer names, and gained a track
   // index. All extracted for the same reason as above.
   "isCompilationCredit", "sharedCreditAgrees", "titleContainsPhrase",
   "findSharedAlbumByContainment", "sharedContainmentMinWords",
   "trackTitleKeys", "albumKeysForTrack", "resolveSharedByTrackIndex", "albumKey"],
  {
    zlib,
    pkg: { version: "9.9.9" },
    albumIndex: { albums: ALBUMS, builtAt: 1 },
    ambiguousAlbumKeys: new Set(),
    splitCreditIntoArtists: (s) => [String(s || "")],
    // SHAPE-FAITHFUL. The real creditIdentities returns { c, first, names };
    // a stub returning an array leaves `qId.c` undefined, so creditHasArtist
    // returns false for everything and the disambiguation tests below pass
    // without ever reaching the comparison they claim to be about.
    creditIdentities: (s) => {
      const c = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return { c, first: c, names: c ? [c] : [] };
    },
    // No play history in these cases; the history rung has its own tests.
    labelsDb: null,
    DEBUG: false,
    // libraryLookup's memo. Injected so each load gets its own rather than
    // sharing one across test files.
    _libLookup: { builtAt: -1, byKey: null, byTitle: null, byAkey: null, canon: null },
  });

// v1.7.46 folded resolveSharedTrack into resolveSharedEntry — it used to
// resolve the album a SECOND time to produce the record, which doubled the SQL
// on the history rung and would have doubled it again on the track rung. The
// assertions below are about resolution, not about which of the two functions
// you call, so they keep running against the real path through this shim.
function resolveSharedTrack(entry) {
  const found = resolveSharedEntry(entry);
  return found ? found.track : null;
}

// Production builds srcKeys with albumKeys(title, subtitle) in indexRecord().
// Computing them the same way here is what lets the identity rung be exercised
// at all — the previous placeholders ("k1", "k2"…) matched nothing, so every
// resolution silently fell through to the title rungs.
for (const al of ALBUMS) al.srcKeys = albumKeys(al.title, al.subtitle);

test("userTrackRecord stores only what can actually be played", async (t) => {
  const good = {
    album_offset: 10, album_title: "Perfect From Now On", album_subtitle: "Built to Spill",
    track_index: 3, title: "Randy Described Eternity", subtitle: "Built to Spill",
    image_key: "a10", track_no: 1,
  };

  await t.test("a complete entry round-trips", () => {
    assert.deepEqual(userTrackRecord(good), good);
  });

  await t.test("an entry with no album is refused", () => {
    // Nothing can be opened on the Core without one, so it could never play.
    // Storing it would inflate the count with rows that are dead on arrival.
    assert.equal(userTrackRecord(Object.assign({}, good, { album_title: "" })), null);
  });

  await t.test("an entry with no title, or no offset, is refused", () => {
    assert.equal(userTrackRecord(Object.assign({}, good, { title: "" })), null);
    assert.equal(userTrackRecord(Object.assign({}, good, { album_offset: "nope" })), null);
    assert.equal(userTrackRecord(Object.assign({}, good, { album_offset: -1 })), null);
    for (const bad of [null, undefined, "a string", 7, []]) {
      assert.equal(userTrackRecord(bad), null);
    }
  });

  await t.test("nothing outside the field list survives", () => {
    const r = userTrackRecord(Object.assign({}, good, {
      qobuzPasswordMd5: "leak", item_key: "session-scoped", __proto__: { pwn: 1 },
    }));
    assert.deepEqual(Object.keys(r).sort(), [
      "album_offset", "album_subtitle", "album_title", "image_key",
      "subtitle", "title", "track_index", "track_no",
    ]);
    assert.equal({}.pwn, undefined, "prototype must not be polluted");
  });

  await t.test("an item_key can never be stored", () => {
    // Roon item_keys are session-scoped; persisting one produces a reference
    // that is already invalid by the time anyone reads it back.
    const r = userTrackRecord(Object.assign({}, good, { item_key: "abc123" }));
    assert.ok(!("item_key" in r));
  });
});

test("userPlaylistRecord bounds what one playlist can hold", async (t) => {
  await t.test("a nameless or idless playlist is dropped", () => {
    assert.equal(userPlaylistRecord({ id: "up_1", name: "" }), null);
    assert.equal(userPlaylistRecord({ name: "X" }), null);
    assert.equal(userPlaylistRecord(null), null);
  });

  await t.test("the name is clamped", () => {
    const r = userPlaylistRecord({ id: "up_1", name: "z".repeat(500) });
    assert.equal(r.name.length, userPlNameMax());
  });

  await t.test("unusable tracks are dropped, and the list is capped", () => {
    const tracks = [];
    for (let i = 0; i < userPlTracksMax() + 50; i++) {
      tracks.push({ album_offset: 10, album_title: "A", title: "T" + i });
    }
    tracks.push({ title: "no album" });   // unusable
    const r = userPlaylistRecord({ id: "up_1", name: "X", tracks });
    assert.equal(r.tracks.length, userPlTracksMax());
  });
});

test("decodeSharePayload refuses what it cannot positively identify", async (t) => {
  const blob = encodeSharePayload(
    buildShareDoc({ name: "Late Night" }, [{ title: "One", album: "A", artist: "B" }]).doc);

  await t.test("a blob this app made comes back", () => {
    const doc = decodeSharePayload(blob);
    assert.equal(doc.playlist.title, "Late Night");
    assert.equal(doc.playlist.track.length, 1);
  });

  await t.test("a foreign or missing magic is refused, not guessed at", () => {
    for (const bad of ["", "   ", "hello", "OTHER1:abc", "MDRP2:abc", blob.slice(6)]) {
      assert.throws(() => decodeSharePayload(bad), /doesn't look like/);
    }
  });

  // v1.7.29: a real paste is not a clean string.
  await t.test("line wrapping does not break it", () => {
    // Every clipboard, chat app and mail client wraps a 3 KB single-token
    // string. The first version demanded the magic at character zero of a
    // trimmed string, so a wrapped paste was rejected as "not a playlist"
    // while holding a perfectly good one.
    const wrapped = blob.replace(/(.{40})/g, "$1\n");
    assert.equal(decodeSharePayload(wrapped).playlist.title, "Late Night");
  });

  await t.test("leading and trailing text around it does not break it", () => {
    assert.equal(
      decodeSharePayload("Here's that playlist:\n\n" + blob + "\n\nEnjoy!").playlist.title,
      "Late Night");
  });

  await t.test("mail-style quote markers do not break it", () => {
    const quoted = blob.replace(/(.{40})/g, "> $1\n");
    assert.equal(decodeSharePayload(quoted).playlist.title, "Late Night");
  });

  await t.test("spaces inside the payload are ignored", () => {
    assert.equal(decodeSharePayload(blob.replace(/(.{10})/g, "$1 ")).playlist.title,
      "Late Night");
  });

  await t.test("a lowercased marker still works — iOS autocorrect does this", () => {
    // Autocorrect treats MDRP1 as an unknown word and lowercases it on paste.
    // The payload is untouched, so the playlist is perfectly good.
    const mangled = blob.replace(/^MDRP1:/, "mdrp1:");
    assert.notEqual(mangled, blob, "control: the fixture must actually differ");
    assert.equal(decodeSharePayload(mangled).playlist.title, "Late Night");
  });

  await t.test("but the PAYLOAD's case is never normalised", () => {
    // base64url is case-sensitive: "A" and "a" are different bytes. Lowercasing
    // the payload to be helpful would silently decode to something else, or —
    // as here — fail the gzip checksum. Failing is correct.
    const payload = blob.slice("MDRP1:".length);
    assert.throws(() => decodeSharePayload("MDRP1:" + payload.toLowerCase()),
      /damaged|cut short/);
  });

  await t.test("the marker with nothing after it says so", () => {
    assert.throws(() => decodeSharePayload("MDRP1:"), /empty/);
  });

  await t.test("tolerance cannot rescue a genuinely corrupt payload", () => {
    // The point of stripping whitespace is to survive transport, never to make
    // a bad blob look good — gzip and JSON are still the real check.
    assert.throws(() => decodeSharePayload("MDRP1:bm90Z3ppcHBlZGF0YWF0YWxs"), /damaged/);
  });

  await t.test("a truncated blob says it was cut short", () => {
    // The failure a copy-paste through a messaging app actually produces.
    assert.throws(() => decodeSharePayload(blob.slice(0, blob.length - 20)),
      /damaged/);
  });

  await t.test("valid gzip that isn't a playlist is refused", () => {
    const notAPlaylist = shareMagic() + ":" +
      zlib.gzipSync(Buffer.from(JSON.stringify({ hello: "world" }))).toString("base64url");
    assert.throws(() => decodeSharePayload(notAPlaylist), /no tracks/);
  });

  await t.test("a playlist with an empty trackList is a valid document", () => {
    // Empty and absent are different facts — this one decodes and reports zero.
    const empty = shareMagic() + ":" + zlib.gzipSync(Buffer.from(
      JSON.stringify({ playlist: { title: "X", track: [] } }))).toString("base64url");
    assert.deepEqual(decodeSharePayload(empty).playlist.track, []);
  });
});

test("resolveSharedTrack matches this library, or reports a miss", async (t) => {
  await t.test("an exact album + artist match resolves", () => {
    const r = resolveSharedTrack({
      title: "Randy Described Eternity", creator: "Built to Spill",
      album: "Perfect From Now On", trackNum: 1,
    });
    assert.equal(r.album_offset, 10);
    assert.equal(r.album_title, "Perfect From Now On");
    assert.equal(r.title, "Randy Described Eternity");
    assert.equal(r.image_key, "a10", "the row should render with the album's art");
    assert.equal(r.track_no, 1);
    // The share carries no index; the title is what actually finds the track.
    assert.equal(r.track_index, 0);
  });

  await t.test("a unique album title resolves even without the artist", () => {
    const r = resolveSharedTrack({ title: "Dirty Boots", album: "Goo" });
    assert.equal(r.album_offset, 20);
  });

  await t.test("an album this library doesn't have is a miss, not a guess", () => {
    assert.equal(resolveSharedTrack({ title: "X", album: "Never Owned This" }), null);
  });

  await t.test("an entry with no album can never resolve", () => {
    assert.equal(resolveSharedTrack({ title: "Orphan" }), null);
    assert.equal(resolveSharedTrack({ album: "Goo" }), null, "nor one with no title");
  });

  await t.test("two albums sharing a title do NOT resolve on the title alone", () => {
    // The coin flip. Reporting a miss the user can see beats silently putting
    // the wrong record in their playlist.
    assert.equal(resolveSharedTrack({ title: "Song", album: "Reunion" }), null);
  });

  await t.test("…but the artist disambiguates them", () => {
    assert.equal(resolveSharedTrack({ title: "Song", album: "Reunion", creator: "Band Two" })
                   .album_offset, 31);
    assert.equal(resolveSharedTrack({ title: "Song", album: "Reunion", creator: "Band One" })
                   .album_offset, 30);
  });

  // -------------------------------------------------------------------------
  // v1.7.44. A playlist shared from another server that indexes THE SAME files
  // reported tracks as missing. The resolver compared normalize(album) for
  // exact equality — stricter than anything else in this file — so any
  // difference in how the two servers title or credit a record was fatal.
  // Three real examples, all compilations:
  //   Dreams / Linger · The Cranberries · "The Best Of The Cranberries (20th
  //   Century Masters)", and All My Life · Foo Fighters · "Greatest Hits".
  // -------------------------------------------------------------------------
  await t.test("an edition suffix in the shared title no longer defeats the match", () => {
    // albumTitleVariants strips a trailing bracketed chunk, and every other
    // identity path in this file has used it for versions. The import path
    // simply never did.
    assert.equal(resolveSharedTrack({
      title: "Dreams", creator: "The Cranberries",
      album: "The Best Of The Cranberries",
    }).album_offset, 40);
  });

  await t.test("a compilation credited to Various Artists resolves", () => {
    // THE one. The share names the TRACK's artist; Roon credits the ALBUM to
    // Various Artists. No title+artist identity can bridge that, so the title
    // rung has to carry it — and it is safe here precisely because exactly one
    // album in the library has that title.
    const r = resolveSharedTrack({
      title: "Dreams", creator: "The Cranberries",
      album: "The Best Of The Cranberries (20th Century Masters)",
    });
    assert.ok(r, "a compilation the library HAS was still reported as missing");
    assert.equal(r.album_offset, 40);
    assert.equal(r.title, "Dreams", "the track title must survive the album substitution");
  });

  await t.test("a leading The, an ampersand and case are all tolerated", () => {
    // canonArtist/canonText tolerance, which the old exact-normalize path had
    // no access to.
    assert.equal(resolveSharedTrack({
      title: "x", album: "goo", creator: "The Sonic Youth",
    }).album_offset, 20);
  });

  await t.test("the coin flip is STILL refused", () => {
    // The tolerance must not have become looseness. Two albums share "Reunion"
    // and the share names neither artist — that is exactly the case this
    // resolver has always declined, and widening the matching must not have
    // quietly turned it into a guess.
    assert.equal(resolveSharedTrack({ title: "Song", album: "Reunion" }), null);
  });

  await t.test("an album this library genuinely lacks is still a miss", () => {
    assert.equal(resolveSharedTrack({
      title: "X", album: "Never Owned This", creator: "Nobody",
    }), null);
  });

  await t.test("a match reports WHICH rung found it", () => {
    // A track found under an album the share did not name is a substitution,
    // and this project shows substitutions rather than making them quietly.
    const direct = resolveSharedEntry({
      title: "Dirty Boots", album: "Goo", creator: "Sonic Youth",
    });
    assert.equal(direct.via, "album");
  });

  await t.test("matching ignores case and punctuation drift", () => {
    assert.equal(resolveSharedTrack({ title: "x", album: "  GOO  ", creator: "sonic youth" })
                   .album_offset, 20);
  });

  await t.test("what comes out is a storable record, not the shared entry", () => {
    const r = resolveSharedTrack({
      title: "Dirty Boots", album: "Goo", creator: "Sonic Youth",
      extension: { evil: true }, location: ["javascript:alert(1)"],
    });
    assert.ok(!("extension" in r));
    assert.ok(!("location" in r));
  });
});

test("a shared playlist survives the whole round trip", () => {
  // Export from one library, import into another — the journey the feature
  // exists for, end to end, through the real encoder and the real decoder.
  const built = buildShareDoc({ name: "For You" }, [
    { title: "Randy Described Eternity", artist: "Built to Spill", album: "Perfect From Now On" },
    { title: "Dirty Boots", artist: "Sonic Youth", album: "Goo" },
    { title: "Unknown Song", artist: "Nobody", album: "Not In This Library" },
  ]);
  const doc = decodeSharePayload(encodeSharePayload(built.doc));

  const resolved = [], missing = [];
  for (const e of doc.playlist.track) {
    const hit = resolveSharedTrack(e);
    if (hit) resolved.push(hit); else missing.push(e);
  }

  assert.equal(resolved.length, 2);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].title, "Unknown Song",
    "the entry this library can't answer for must be reported, not dropped");
  // And what resolved must be storable as-is.
  for (const r of resolved) assert.ok(userTrackRecord(r), "a resolved entry must be storable");
  assert.deepEqual(resolved.map(r => r.album_offset), [10, 20],
    "the shared order is the playlist's order");
});
