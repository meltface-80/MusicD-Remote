"use strict";
// ---------------------------------------------------------------------------
// v1.7.19: exporting a playlist as a shareable JSPF document.
//
// A share file is forever. Once it has been sent to someone it cannot be
// recalled, corrected, or re-versioned — so the encoder has exactly one chance
// to get the shape right, and every one of these assertions is about a failure
// that would only be discovered by the person on the other end.
//
// Three classes of bug are pinned here:
//
//   1. Leakage. The export is built field-by-field from a known list. Anything
//      that passes a caller's object through would put whatever else was on it
//      into a document the user is about to hand to a stranger.
//   2. Silent loss. A cap that trims the list, or an entry that gets dropped,
//      must be COUNTED and reported. v1.7.17 shipped a cap nobody was told
//      about and it read as complete success.
//   3. Empty-vs-absent. JSPF treats an empty string as a claim that the value
//      IS empty. Emitting `"album": ""` tells a reader to stop looking for the
//      album; omitting the key tells it we never knew. Those are different
//      facts and the difference decides whether a track resolves.
//
// The blob is decoded here with plain zlib + JSON.parse rather than a decoder
// from index.js — that is deliberate. It proves the format is readable by an
// implementation that shares no code with the encoder, which is the only thing
// that matters when the reader is someone else's copy of the app.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { loadIndexFunctions } = require("../lib/extract");

const {
  shareText, shareInt, shareUriList, sharePrune,
  shareTrackEntry, buildShareDoc, encodeSharePayload,
  shareMagic, shareTrackMax, shareTextMax, shareNsTrack, shareNsPlaylist,
} = loadIndexFunctions(
  // Every limit and namespace is EXTRACTED, never injected — the point is to
  // read the shipping vocabulary. Only genuinely ambient module state is
  // supplied: the real zlib, and a stand-in for package.json.
  ["shareText", "shareInt", "shareUriList", "sharePrune",
   "shareTrackEntry", "buildShareDoc", "encodeSharePayload",
   "shareMagic", "shareTrackMax", "shareTextMax", "shareNameMax", "shareUriMax",
   "shareNsTrack", "shareNsPlaylist"],
  { zlib, pkg: { version: "9.9.9" } });

// An independent reader. No index.js code involved.
function decodeBlob(blob) {
  const [magic, payload] = String(blob).split(":");
  assert.equal(magic, shareMagic(), "blob must carry the version magic");
  return JSON.parse(zlib.gunzipSync(Buffer.from(payload, "base64url")).toString("utf8"));
}

test("shareText / shareInt / shareUriList coerce rather than trust", async (t) => {
  await t.test("non-strings become empty, never the value itself", () => {
    for (const bad of [null, undefined, 42, {}, [], true, () => {}]) {
      assert.equal(shareText(bad), "");
    }
  });

  await t.test("whitespace is collapsed and the value is clamped", () => {
    assert.equal(shareText("  Teen   Age\n\tRiot  "), "Teen Age Riot");
    assert.equal(shareText("x".repeat(9000)).length, shareTextMax());
    assert.equal(shareText("abcdef", 3), "abc");
  });

  await t.test("shareInt refuses anything outside its range", () => {
    assert.equal(shareInt("7", 1, 999), 7);
    assert.equal(shareInt(7, 1, 999), 7);
    assert.equal(shareInt(0, 1, 999), null);
    assert.equal(shareInt(1000, 1, 999), null);
    assert.equal(shareInt("not a number", 1, 999), null);
    assert.equal(shareInt(null, 1, 999), null);
    assert.equal(shareInt(NaN, 1, 999), null);
  });

  await t.test("shareUriList keeps only things that are actually URIs", () => {
    assert.deepEqual(
      shareUriList(["https://musicbrainz.org/recording/abc", "not a uri", "isrc:GBAYE0601498"]),
      ["https://musicbrainz.org/recording/abc", "isrc:GBAYE0601498"],
      "a bare string has no scheme and would be mistaken for a URI by a reader");
    assert.deepEqual(shareUriList("https://x.example/1"), [],
      "a bare string is not a list");
    assert.deepEqual(shareUriList(null), []);
    // Duplicates and unbounded lists are both ways to inflate a document.
    assert.deepEqual(shareUriList(["a:1", "a:1", "a:1"]), ["a:1"]);
    assert.equal(shareUriList(["a:1", "b:2", "c:3", "d:4", "e:5", "f:6"]).length, 4);
  });

  await t.test("sharePrune drops empty values but keeps real falsy ones", () => {
    assert.deepEqual(sharePrune({ a: "x", b: "", c: null, d: undefined, e: [], f: {} }),
      { a: "x" });
    // 0 and false are VALUES. Dropping them would be a different bug.
    assert.deepEqual(sharePrune({ n: 0, t: false }), { n: 0, t: false });
  });
});

test("shareTrackEntry builds a JSPF track from a known field list", async (t) => {
  await t.test("the ordinary case maps onto JSPF's own names", () => {
    assert.deepEqual(
      shareTrackEntry({ title: "Teen Age Riot", artist: "Sonic Youth",
                        album: "Daydream Nation", track_no: 1 }),
      { title: "Teen Age Riot", creator: "Sonic Youth",
        album: "Daydream Nation", trackNum: 1 });
  });

  await t.test("fields we don't have are ABSENT, not empty", () => {
    const e = shareTrackEntry({ title: "Tomorrow" });
    assert.deepEqual(e, { title: "Tomorrow" });
    // Each of these would tell a reader "we checked, there is none".
    assert.ok(!("album" in e), "an unknown album must be omitted, not empty");
    assert.ok(!("creator" in e));
    assert.ok(!("trackNum" in e));
    assert.ok(!("duration" in e));
    assert.ok(!("extension" in e));
  });

  await t.test("a track with no title is refused", () => {
    // Unresolvable by anyone, and counting it would inflate the total the
    // user is shown with entries that can never match.
    for (const bad of [{}, { title: "" }, { title: "   " }, { artist: "x" },
                       null, undefined, "a string", 5]) {
      assert.equal(shareTrackEntry(bad), null);
    }
  });

  await t.test("nothing outside the field list survives", () => {
    const e = shareTrackEntry({
      title: "Cannonball", artist: "The Breeders",
      qobuzPasswordMd5: "leak", item_key: "42", __proto__: { polluted: true },
      image_key: "k1", zone_or_output_id: "z1",
    });
    assert.deepEqual(Object.keys(e).sort(), ["creator", "title"]);
    assert.equal({}.polluted, undefined, "prototype must not be polluted");
  });

  await t.test("identifiers ride in the MusicBrainz extension namespace", () => {
    const e = shareTrackEntry({
      title: "Gigantic", artist: "Pixies", isrc: "GBAYE0601498",
      year: 1988, disc: 1,
      identifier: ["https://musicbrainz.org/recording/abc"],
    });
    assert.deepEqual(e.identifier, ["https://musicbrainz.org/recording/abc"]);
    assert.deepEqual(e.extension[shareNsTrack()].additional_metadata,
      { isrc: "GBAYE0601498", year: 1988, disc: 1 });
  });

  await t.test("a nonsense year or disc is dropped, not carried", () => {
    const e = shareTrackEntry({ title: "x", year: 12345, disc: 0 });
    assert.ok(!("extension" in e),
      "an extension block containing nothing usable should not exist");
  });
});

test("buildShareDoc reports everything it left out", async (t) => {
  const meta = { name: "Late Night" };

  await t.test("the document is a JSPF playlist", () => {
    const built = buildShareDoc(meta, [{ title: "One" }, { title: "Two" }]);
    assert.equal(built.doc.playlist.title, "Late Night");
    assert.equal(built.doc.playlist.track.length, 2);
    assert.equal(built.track_count, 2);
    assert.equal(built.skipped, 0);
    assert.equal(built.truncated, false);
    assert.ok(built.doc.playlist.date, "a share should say when it was made");
    assert.deepEqual(
      built.doc.playlist.extension[shareNsPlaylist()].additional_metadata,
      { generator: "MusicD Remote", generator_version: "9.9.9" });
  });

  await t.test("untitled entries are counted, not silently dropped", () => {
    const built = buildShareDoc(meta, [{ title: "One" }, {}, { title: "" }, { title: "Two" }]);
    assert.equal(built.track_count, 2);
    assert.equal(built.skipped, 2,
      "the user must be able to see that two entries didn't make it");
  });

  await t.test("the cap is applied AND declared", () => {
    const many = Array.from({ length: shareTrackMax() + 5 }, (_, i) => ({ title: "T" + i }));
    const built = buildShareDoc(meta, many);
    assert.equal(built.track_count, shareTrackMax());
    assert.equal(built.truncated, true,
      "a cap the caller isn't told about reads as success (v1.7.17)");
  });

  await t.test("a playlist exactly at the cap is not called truncated", () => {
    const exact = Array.from({ length: shareTrackMax() }, (_, i) => ({ title: "T" + i }));
    assert.equal(buildShareDoc(meta, exact).truncated, false);
  });

  await t.test("a nameless playlist still produces a usable document", () => {
    assert.equal(buildShareDoc({}, [{ title: "One" }]).doc.playlist.title, "Shared playlist");
    assert.equal(buildShareDoc(null, [{ title: "One" }]).doc.playlist.title, "Shared playlist");
  });

  await t.test("junk instead of a track list yields an empty document, not a throw", () => {
    for (const bad of [null, undefined, "tracks", 7, {}]) {
      const built = buildShareDoc(meta, bad);
      assert.equal(built.track_count, 0);
    }
  });

  await t.test("playlist metadata cannot smuggle extra keys either", () => {
    const built = buildShareDoc(
      { name: "X", tidalRefreshToken: "leak", track: [{ title: "injected" }] },
      [{ title: "One" }]);
    assert.equal(built.doc.playlist.track.length, 1);
    assert.equal(built.doc.playlist.track[0].title, "One");
    assert.ok(!("tidalRefreshToken" in built.doc.playlist));
  });
});

test("the blob round-trips through an independent reader", async (t) => {
  const built = buildShareDoc({ name: "Road Trip" }, [
    { title: "Randy Described Eternity", artist: "Built to Spill",
      album: "Perfect From Now On", track_no: 1 },
    { title: "Goo", artist: "Sonic Youth" },
  ]);
  const blob = encodeSharePayload(built.doc);

  await t.test("it is prefixed so a reader can reject what it can't parse", () => {
    assert.ok(blob.startsWith(shareMagic() + ":"));
  });

  await t.test("base64url survives being pasted into a URL or a chat window", () => {
    const payload = blob.slice(shareMagic().length + 1);
    assert.doesNotMatch(payload, /[+/=]/,
      "standard base64 would be mangled by URL encoding and by some chat clients");
  });

  await t.test("what comes back out is what went in", () => {
    const doc = decodeBlob(blob);
    assert.equal(doc.playlist.title, "Road Trip");
    assert.deepEqual(doc.playlist.track[0], {
      title: "Randy Described Eternity", creator: "Built to Spill",
      album: "Perfect From Now On", trackNum: 1,
    });
    assert.deepEqual(doc.playlist.track[1], { title: "Goo", creator: "Sonic Youth" });
  });

  await t.test("compression is doing real work on a realistic playlist", () => {
    // A share is meant to be pasted into a message. If it isn't much smaller
    // than the raw JSON, the copy-paste transport doesn't hold up.
    const many = Array.from({ length: 200 }, (_, i) => ({
      title: "Track " + i, artist: "Some Artist", album: "Some Album", track_no: (i % 12) + 1,
    }));
    const big = buildShareDoc({ name: "Big" }, many);
    const raw = JSON.stringify(big.doc).length;
    const enc = encodeSharePayload(big.doc).length;
    assert.ok(enc < raw / 2, `expected the blob (${enc}) to be well under half the JSON (${raw})`);
    // And it must still decode.
    assert.equal(decodeBlob(encodeSharePayload(big.doc)).playlist.track.length, 200);
  });

  await t.test("unicode survives the trip", () => {
    const doc = decodeBlob(encodeSharePayload(
      buildShareDoc({ name: "Björk & 坂本龍一" },
                    [{ title: "Jóga", artist: "Björk" }]).doc));
    assert.equal(doc.playlist.title, "Björk & 坂本龍一");
    assert.equal(doc.playlist.track[0].title, "Jóga");
  });
});
