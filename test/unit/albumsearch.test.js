"use strict";
// ---------------------------------------------------------------------------
// v1.8.55 — an album id from the CATALOGUE, not only from the favourites.
//
// Until now a streamed album had a waveform only if it was in the user's
// favourites, because that was the only place an album id could be harvested.
// A probe against 11,455 loaded favourites reported near: [] for the album
// playing at the time — not spelled differently, not absent by accident, just
// never favourited. Played from a search, it could never have had a waveform.
//
// The catalogue is searchable with the same token. What makes that safe is the
// decision pinned here, and what makes being wrong survivable is the duration
// gate downstream: a wrong pressing fails TM.matchTrack and draws nothing.
//
// The rule Qobuz forces: it answers a query it cannot place with its NEAREST
// GUESS rather than with nothing (v1.8.36 learned this on the share-card
// links), so "the first result" is never an answer.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickAlbumId } = require("../../lib/albumsearch");

const WANT = ["zebra iv||zebra"];

test("an exact identity match is taken", () => {
  const r = pickAlbumId(WANT, [
    { id: "nope", keys: ["something else||another band"] },
    { id: "yes",  keys: ["zebra iv||zebra"] },
  ]);
  assert.equal(r.id, "yes");
  assert.match(r.reason, /zebra iv\|\|zebra/);
});

test("THE one: a near-miss pile is refused, not ranked", () => {
  // Qobuz always answers. Every one of these is a plausible-looking result for
  // the query "Zebra IV Zebra" and not one of them is the record.
  const r = pickAlbumId(WANT, [
    { id: "a", keys: ["zebra||zebra"] },
    { id: "b", keys: ["no tellin lies||zebra"] },
    { id: "c", keys: ["zebra iv||a different band"] },
  ]);
  assert.equal(r.id, null, "a nearest guess was accepted as the album");
  assert.match(r.reason, /nearest guess/);
});

test("two different albums under one identity decline", () => {
  // A coin flip whose losing side is a waveform of another master — which
  // looks authoritative and is simply a different recording.
  const r = pickAlbumId(WANT, [
    { id: "one", keys: ["zebra iv||zebra"] },
    { id: "two", keys: ["zebra iv||zebra"] },
  ]);
  assert.equal(r.id, null);
  assert.match(r.reason, /ambiguous/);
});

test("the SAME album returned twice is not ambiguity", () => {
  // A service lists one album once per credited artist, and across sections.
  // Counting results instead of ids would decline on a perfectly clear answer —
  // which would make the whole fallback fire almost never.
  const r = pickAlbumId(["raising sand||robert plant", "raising sand||alison krauss"], [
    { id: "same", keys: ["raising sand||robert plant"] },
    { id: "same", keys: ["raising sand||alison krauss"] },
  ]);
  assert.equal(r.id, "same");
});

test("any of the wanted keys may be the one that matches", () => {
  // albumKeys() yields one per credited artist and per title variant. Reading
  // only the first would miss exactly the collaborations that miss most often.
  const r = pickAlbumId(["raising sand||robert plant", "raising sand||alison krauss"],
                        [{ id: "x", keys: ["raising sand||alison krauss"] }]);
  assert.equal(r.id, "x");
});

test("the match may be on any of a CANDIDATE's keys, not just its first", () => {
  // A real search result is keyed by favouriteTitleForms x every credited
  // artist, so its key list is several long and the one Roon's identity hits is
  // routinely not the first. Reading only keys[0] would silently switch the
  // fallback off for edition-suffixed titles and for collaborations — the two
  // cases it exists to cover.
  const r = pickAlbumId(["zebra iv||zebra"], [{
    id: "yes",
    keys: ["zebra iv remastered||zebra", "zebra iv remastered||zebra band", "zebra iv||zebra"],
  }]);
  assert.equal(r.id, "yes",
    "only the candidate's first key was compared, so a result keyed under its " +
    "full edition title first can never be found");
});

test("an empty search is a different answer from a search that missed", () => {
  const none = pickAlbumId(WANT, []);
  assert.equal(none.id, null);
  assert.match(none.reason, /no albums/);

  const missed = pickAlbumId(WANT, [{ id: "a", keys: ["other||band"] }]);
  assert.match(missed.reason, /none of the 1 search results/);
});

test("a result with no usable id can never be chosen", () => {
  for (const bad of [null, undefined, ""]) {
    const r = pickAlbumId(WANT, [{ id: bad, keys: ["zebra iv||zebra"] }]);
    assert.equal(r.id, null, `id ${JSON.stringify(bad)} was accepted`);
  }
});

test("it survives junk without throwing", () => {
  assert.equal(pickAlbumId(null, null).id, null);
  assert.equal(pickAlbumId([], [{ id: "a", keys: ["k"] }]).id, null);
  assert.equal(pickAlbumId(WANT, [{ id: "a" }]).id, null);
  assert.equal(pickAlbumId(WANT, [null, undefined]).id, null);
});
