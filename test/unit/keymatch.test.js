"use strict";
// ---------------------------------------------------------------------------
// v1.8.53 — telling "absent" apart from "spelled differently".
//
// An album identity is `canonTitle||canonArtist` and a lookup either hits or it
// does not. When it misses, every caller said the same thing: "not in your
// favourites". That is an assumption wearing a conclusion's clothes — a key
// misses because the record is absent OR because the two sides spelled it
// differently, and a failed Map lookup cannot tell those apart.
//
// v1.8.52's probe reported album_id: null against 11,006 loaded favourites and
// then stated the album was in neither service's favourites. It did not know
// that. These tests pin the thing that does.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitKey, relate, nearKeys, missVerdict } = require("../../lib/keymatch");

test("a key splits on the FIRST separator", () => {
  // A title containing "||" would otherwise take the artist with it.
  assert.deepEqual(splitKey("rumours||fleetwood mac"),
                   { title: "rumours", artist: "fleetwood mac" });
  assert.deepEqual(splitKey("a||b||c"), { title: "a", artist: "b||c" });
  assert.equal(splitKey("no separator"), null);
  assert.equal(splitKey(""), null);
});

test("relate ranks an extension above a mid-string coincidence", () => {
  assert.equal(relate("zebra iv", "zebra iv"), "same");
  assert.equal(relate("zebra iv remastered", "zebra iv"), "prefix");
  assert.equal(relate("zebra iv", "zebra iv remastered"), "prefix");
  // Contained, but not at the start — far weaker evidence.
  assert.equal(relate("the zebra iv sessions", "zebra iv"), "contains");
  assert.equal(relate("wholly different", "zebra iv"), null);
  assert.equal(relate("", "zebra iv"), null);
});

test("a word boundary is required for 'prefix'", () => {
  // "zebra ivory" must not read as an extension of "zebra iv" — without the
  // space this matches and the report names an unrelated record with
  // confidence.
  assert.notEqual(relate("zebra ivory", "zebra iv"), "prefix");
});

test("THE case: an edition suffix on the index side is found and named", () => {
  // The asymmetry this was built to expose. The lookup side strips "(Remastered)"
  // from ROON's title; the index side never stripped it from QOBUZ's, so a
  // favourite whose title carries the suffix inline could not be found by a
  // clean title — and the report said "not a favourite".
  const near = nearKeys(["zebra iv||zebra"],
                        ["zebra iv remastered||zebra", "something else||another band"]);
  assert.equal(near.length, 1);
  assert.equal(near[0].key, "zebra iv remastered||zebra");
  assert.equal(near[0].why, "same artist, title extended");
});

test("an exact hit is never reported as a near miss", () => {
  // If one were there the lookup would not have failed, and listing it would
  // describe a world the caller is not in.
  const near = nearKeys(["rumours||fleetwood mac"],
                        ["rumours||fleetwood mac", "rumours deluxe||fleetwood mac"]);
  assert.equal(near.length, 1);
  assert.equal(near[0].key, "rumours deluxe||fleetwood mac");
});

test("the same title under a different artist is reported, and ranked below", () => {
  // Roon credits the album to the band, the service to the frontman — a real
  // and common miss, but weaker evidence than an edition suffix.
  const near = nearKeys(["greatest hits||queen"],
                        ["greatest hits||abba", "greatest hits deluxe||queen"]);
  assert.equal(near[0].key, "greatest hits deluxe||queen", "the artist match must rank first");
  assert.equal(near[1].key, "greatest hits||abba");
  assert.equal(near[1].why, "same title, different artist");
});

test("an unrelated index produces nothing, which is the real finding", () => {
  const near = nearKeys(["zebra iv||zebra"],
                        ["kind of blue||miles davis", "rumours||fleetwood mac"]);
  assert.deepEqual(near, []);
  assert.match(missVerdict("your Qobuz favourites", ["zebra iv||zebra"], near),
               /really is absent/);
});

test("with near misses the verdict refuses to say absent", () => {
  // THE distinction. Saying "absent" when the record is sitting there under
  // another spelling sends somebody to go and favourite an album they already
  // have — which is the advice v1.8.52 gave.
  const near = nearKeys(["zebra iv||zebra"], ["zebra iv remastered||zebra"]);
  const v = missVerdict("your Qobuz favourites", ["zebra iv||zebra"], near);
  // The CLAIM, not the word — the sentence ends "it is not absent", which a
  // blunt /absent/ would flag. A check that fires on its own correct answer is
  // the kind that gets loosened until it catches nothing.
  assert.doesNotMatch(v, /really is absent/, v);
  assert.match(v, /it is not absent/, v);
  assert.match(v, /zebra iv remastered\|\|zebra/, v);
  assert.match(v, /reconciled/, v);
});

test("every key the lookup tried is considered, not just the first", () => {
  // albumKeys() yields one key per credited artist and per title variant. A
  // near-miss search that read only wanted[0] would go quiet on exactly the
  // multi-artist albums that miss most often.
  const near = nearKeys(["raising sand||robert plant", "raising sand||alison krauss"],
                        ["raising sand deluxe||alison krauss"]);
  assert.equal(near.length, 1);
  assert.equal(near[0].why, "same artist, title extended");
});

test("the report is capped and the best survives the cap", () => {
  const hay = Array.from({ length: 40 }, (_, i) => "greatest hits " + i + "||someone " + i);
  hay.push("zebra iv remastered||zebra");
  const near = nearKeys(["zebra iv||zebra"], hay, { limit: 3 });
  assert.ok(near.length <= 3);
  assert.equal(near[0].key, "zebra iv remastered||zebra");
});

test("it survives junk without throwing", () => {
  assert.deepEqual(nearKeys(null, null), []);
  assert.deepEqual(nearKeys([], ["a||b"]), []);
  assert.deepEqual(nearKeys(["a||b"], null), []);
  assert.deepEqual(nearKeys(["not a key"], ["a||b"]), []);
  assert.equal(typeof missVerdict("x", [], []), "string");
});
