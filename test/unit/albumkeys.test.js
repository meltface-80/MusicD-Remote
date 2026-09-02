"use strict";
// ---------------------------------------------------------------------------
// v1.8.3: matching an album by its title when Roon supplies no artist.
//
// Roon sends three_line.line2 as "" for some albums, which makes the identity
// key "analogue||" and matches nothing — no source badge, no local-file lookup,
// no waveform. Title-only matching is the rung underneath, and the ONLY thing
// that makes it safe is refusing to answer when the title is ambiguous. That is
// what these tests are mostly about.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { titleOf, artistOf, titleOnlyMatches, locateByTitle } = require("../../lib/albumkeys");

test("a key splits into its title and artist halves", () => {
  assert.equal(titleOf("analogue||a-ha"), "analogue");
  assert.equal(artistOf("analogue||a-ha"), "a-ha");
  // The artist half is empty exactly when Roon gave us nothing — the case this
  // whole module exists for.
  assert.equal(titleOf("analogue||"), "analogue");
  assert.equal(artistOf("analogue||"), "");
});

test("something that is not a key yields nothing rather than throwing", () => {
  for (const junk of ["", null, undefined, "no separator here", "||orphan"]) {
    assert.equal(titleOf(junk), "", `titleOf(${JSON.stringify(junk)})`);
  }
});

test("titles match on the title half only, whatever the artist is", () => {
  const keys = new Set(["analogue||a-ha", "analogue||someone else", "hunting high and low||a-ha"]);
  const hits = titleOnlyMatches(keys, ["analogue"]);
  assert.deepEqual(hits.sort(), ["analogue||a-ha", "analogue||someone else"]);
});

test("an empty or missing title list matches nothing", () => {
  // Guard against the degenerate call: an album with no title must not sweep up
  // every key whose title half happens to be empty.
  const keys = new Set(["analogue||a-ha", "||orphan"]);
  assert.deepEqual(titleOnlyMatches(keys, []), []);
  assert.deepEqual(titleOnlyMatches(keys, [""]), []);
  assert.deepEqual(titleOnlyMatches(keys, null), []);
  assert.deepEqual(titleOnlyMatches(null, ["analogue"]), []);
});

test("all the title variants are accepted, not just the first", () => {
  // albumKeys produces several spellings of a title; a match on any is a match.
  const keys = new Set(["back in black||ac/dc"]);
  assert.equal(titleOnlyMatches(keys, ["backinblack", "back in black"]).length, 1);
});

test("THE one: a title in exactly one place is confident", () => {
  const r = locateByTitle(["analogue"], {
    local: new Set(["analogue||a-ha"]),
    qobuz: new Set(["hunting high and low||a-ha"]),
    tidal: new Set(),
  });
  assert.equal(r.confident, true);
  assert.equal(r.source, "local");
  assert.equal(r.total, 1);
  assert.deepEqual(r.places, ["local"]);
});

test("THE other one: the same title in two places is NOT confident", () => {
  // A record you own AND stream. Guessing here is how a waveform of the wrong
  // master ends up under the track — authoritative-looking and simply wrong.
  const r = locateByTitle(["analogue"], {
    local: new Set(["analogue||a-ha"]),
    qobuz: new Set(["analogue||a-ha"]),
    tidal: new Set(),
  });
  assert.equal(r.confident, false, "two places must never be a confident answer");
  assert.equal(r.total, 2);
  assert.deepEqual(r.places.sort(), ["local", "qobuz"]);
  // Local still wins the SOURCE question — the files are what actually plays —
  // even though it is not confident enough to fetch anything for.
  assert.equal(r.source, "local");
});

test("two albums sharing a title inside ONE service is not confident either", () => {
  // A reissue beside the original. Same trap, one place.
  const r = locateByTitle(["greatest hits"], {
    local: new Set(),
    qobuz: new Set(["greatest hits||queen", "greatest hits||abba"]),
    tidal: new Set(),
  });
  assert.equal(r.confident, false);
  assert.equal(r.total, 2);
  // One PLACE, so the source is still knowable even though the album is not.
  assert.equal(r.source, "qobuz");
});

test("no match anywhere says so without inventing a source", () => {
  const r = locateByTitle(["nothing here"], {
    local: new Set(["analogue||a-ha"]), qobuz: new Set(), tidal: new Set(),
  });
  assert.equal(r.confident, false);
  assert.equal(r.total, 0);
  assert.equal(r.source, null);
  assert.deepEqual(r.places, []);
});

test("a streaming-only title is located, and confidently", () => {
  // The case the Qobuz waveform actually needs: not local, in one service.
  const r = locateByTitle(["analogue"], {
    local: new Set(), qobuz: new Set(["analogue||a-ha"]), tidal: new Set(),
  });
  assert.equal(r.confident, true);
  assert.equal(r.source, "qobuz");
});

test("favourited in both services is unknowable, as it is everywhere else here", () => {
  // albumSource already refuses this case rather than flipping a coin; the
  // title-only rung must not be a way around that rule.
  const r = locateByTitle(["analogue"], {
    local: new Set(), qobuz: new Set(["analogue||a-ha"]), tidal: new Set(["analogue||a-ha"]),
  });
  assert.equal(r.confident, false);
  assert.equal(r.source, null, "a coin flip between two services is not an answer");
});

test("missing key sets are treated as empty, not as an error", () => {
  const r = locateByTitle(["analogue"], {});
  assert.equal(r.total, 0);
  assert.equal(r.confident, false);
  assert.deepEqual(locateByTitle(["analogue"], undefined).places, []);
});
