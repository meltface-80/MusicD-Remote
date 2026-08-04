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
    nTitle: "perfect from now on", nArtist: "built to spill", image_key: "a10", srcKeys: ["k1"] },
  { offset: 20, title: "Goo", subtitle: "Sonic Youth",
    nTitle: "goo", nArtist: "sonic youth", image_key: "a20", srcKeys: ["k2"] },
  // Two different records with the SAME title — the coin flip.
  { offset: 30, title: "Reunion", subtitle: "Band One",
    nTitle: "reunion", nArtist: "band one", image_key: "a30", srcKeys: ["k3"] },
  { offset: 31, title: "Reunion", subtitle: "Band Two",
    nTitle: "reunion", nArtist: "band two", image_key: "a31", srcKeys: ["k4"] },
];

const {
  userTrackRecord, userPlaylistRecord, decodeSharePayload, resolveSharedTrack,
  encodeSharePayload, buildShareDoc, shareMagic,
  userPlNameMax, userPlTracksMax,
} = loadIndexFunctions(
  ["userTrackRecord", "userPlaylistRecord", "decodeSharePayload", "resolveSharedTrack",
   "encodeSharePayload", "buildShareDoc", "shareMagic", "shareText", "shareInt",
   "shareUriList", "sharePrune", "shareTrackEntry",
   "shareTextMax", "shareNameMax", "shareTrackMax", "shareUriMax",
   "shareNsTrack", "shareNsPlaylist",
   "userPlNameMax", "userPlTracksMax", "userPlMax", "normalize", "canonText",
   "canonArtist", "albumKeys", "creditHasArtist"],
  {
    zlib,
    pkg: { version: "9.9.9" },
    albumIndex: { albums: ALBUMS },
    ambiguousAlbumKeys: new Set(),
    splitCreditIntoArtists: (s) => [String(s || "")],
    creditIdentities: (s) => [String(s || "").toLowerCase()],
  });

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
