"use strict";
// ---------------------------------------------------------------------------
// splitCreditIntoArtists / creditIdentities / creditHasArtist
//
// These decide which artist links an album shows, and which albums appear on
// an artist's screen. Two shipped bugs live here:
//
//   * substring matching put "Jordan Prince" and 'Bonnie "Prince" Billy'
//     under Prince (and would equally put Kate Bush under Bush) — fixed by
//     whole-name equality in canonArtist() space;
//   * splitting bare slashes unconditionally tore "AC/DC" into two dead links,
//     while refusing to split them left "T-Bone Walker/Big Joe Turner/Otis
//     Spann" as one dead-end link.
//
// splitCreditIntoArtists reads the library's artist set (knownArtistSet) to
// gate the risky separators, so every test states the library it assumes.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const NAMES = [
  "normalize", "canonText", "canonArtist",
  "splitCreditIntoArtists", "creditIdentities", "creditHasArtist",
];

// Build a fresh function set over a stated library of known artists.
// `known` holds normalize()d names, exactly as knownArtistSet() does.
function withLibrary(artists) {
  const known = new Set();
  const F = loadIndexFunctions(NAMES, { knownArtistSet: () => known });
  for (const a of artists) known.add(F.normalize(a));
  return F;
}

const EMPTY_LIBRARY = [];
const JAZZ_LIBRARY = ["Miles Davis", "John Coltrane", "Bill Evans", "Otis Spann"];
const PRINCE_LIBRARY = ["Prince", "The Revolution", "Kate Bush", "Bush", "Sheena Easton"];

test("splitCreditIntoArtists — Roon's own separators split unconditionally", async (t) => {
  const F = withLibrary(EMPTY_LIBRARY);

  await t.test("spaced slash splits even with an empty library", () => {
    assert.deepEqual(F.splitCreditIntoArtists("Miles Davis / John Coltrane"),
      ["Miles Davis", "John Coltrane"]);
  });

  await t.test("feat. / featuring / ft. all split", () => {
    for (const sep of [" feat. ", " feat ", " featuring ", " ft. ", " ft "]) {
      assert.deepEqual(
        F.splitCreditIntoArtists("Alpha" + sep + "Beta"),
        ["Alpha", "Beta"],
        `separator "${sep}" should split`
      );
    }
  });

  await t.test("a blank credit yields no artists at all", () => {
    assert.deepEqual(F.splitCreditIntoArtists(""), []);
    assert.deepEqual(F.splitCreditIntoArtists(null), []);
    assert.deepEqual(F.splitCreditIntoArtists("   "), []);
  });
});

test("splitCreditIntoArtists — the unspaced slash is evidence-gated", async (t) => {
  await t.test("AC/DC must NOT split, in any library", () => {
    // Both fragments are single words AND too short to be looked up, so there
    // is no evidence of a multi-artist credit. Splitting produced two links
    // that went nowhere.
    for (const lib of [EMPTY_LIBRARY, JAZZ_LIBRARY, PRINCE_LIBRARY]) {
      assert.deepEqual(withLibrary(lib).splitCreditIntoArtists("AC/DC"), ["AC/DC"]);
    }
  });

  await t.test("'T-Bone Walker/Big Joe Turner/Otis Spann' splits into 3", () => {
    // Every fragment is multi-word — that alone is the evidence, so this works
    // even when the library knows none of them.
    assert.deepEqual(
      withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("T-Bone Walker/Big Joe Turner/Otis Spann"),
      ["T-Bone Walker", "Big Joe Turner", "Otis Spann"]
    );
  });

  await t.test("a single-word fragment splits only when the library knows one", () => {
    // "Prince/Madonna" — both single words, so the all-multi-word evidence is
    // absent and the library has to supply it.
    assert.deepEqual(
      withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("Prince/Madonna"),
      ["Prince/Madonna"]
    );
    assert.deepEqual(
      withLibrary(["Prince"]).splitCreditIntoArtists("Prince/Madonna"),
      ["Prince", "Madonna"]
    );
  });

  await t.test("other short band names with a bare slash stay intact", () => {
    assert.deepEqual(withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("Ol/ive"), ["Ol/ive"]);
  });
});

test("splitCreditIntoArtists — mixed separators split all the way down", async (t) => {
  await t.test("'Miles Davis/John Coltrane & Bill Evans' yields 3 with the library", () => {
    // The regression this guards: the slash stage used to stop half-way,
    // leaving "John Coltrane & Bill Evans" as one link.
    assert.deepEqual(
      withLibrary(JAZZ_LIBRARY).splitCreditIntoArtists("Miles Davis/John Coltrane & Bill Evans"),
      ["Miles Davis", "John Coltrane", "Bill Evans"]
    );
  });

  await t.test("without library evidence the '&' half stays joined", () => {
    // Pinned deliberately: the "&" stage is evidence-gated, so an unknown
    // "Earth, Wind & Fire"-shaped name is never torn apart on a guess.
    assert.deepEqual(
      withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("Miles Davis/John Coltrane & Bill Evans"),
      ["Miles Davis", "John Coltrane & Bill Evans"]
    );
    assert.deepEqual(
      withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("Earth, Wind & Fire"),
      ["Earth, Wind & Fire"]
    );
  });

  await t.test("'Prince & The Revolution' splits when both are known", () => {
    assert.deepEqual(
      withLibrary(PRINCE_LIBRARY).splitCreditIntoArtists("Prince & The Revolution"),
      ["Prince", "The Revolution"]
    );
  });

  await t.test("repeated names are deduplicated to one link each", () => {
    assert.deepEqual(
      withLibrary(EMPTY_LIBRARY).splitCreditIntoArtists("Big Joe Turner/Big Joe Turner"),
      ["Big Joe Turner"]
    );
  });
});

test("creditIdentities", async (t) => {
  const F = withLibrary(PRINCE_LIBRARY);

  await t.test("a plain single-artist credit reports names === null", () => {
    assert.deepEqual(F.creditIdentities("Prince"),
      { c: "prince", first: "prince", names: null });
  });

  await t.test("a multi-artist credit lists the whole credit AND each artist", () => {
    const id = F.creditIdentities("Prince & The Revolution");
    assert.equal(id.c, "prince the revolution");
    assert.equal(id.first, "prince");
    assert.deepEqual(id.names, ["prince the revolution", "prince", "revolution"]);
  });

  await t.test("a punctuation-only credit yields an empty, unmatched identity", () => {
    // Must never produce c === "" that then matches another empty credit.
    assert.deepEqual(F.creditIdentities("!!!"), { c: "", first: "", names: null });
    assert.deepEqual(F.creditIdentities(""), { c: "", first: "", names: null });
    assert.deepEqual(F.creditIdentities(null), { c: "", first: "", names: null });
  });

  await t.test("a quoted nickname stays part of ONE name", () => {
    const id = F.creditIdentities('Bonnie "Prince" Billy');
    assert.equal(id.c, "bonnie prince billy");
    assert.equal(id.names, null, "must not be treated as a multi-artist credit");
  });

  await t.test("stage-1 parts the client renders always resolve here too", () => {
    // The client draws links for the " / " and "feat." parts before /api/album
    // answers; if those names did not appear in `names`, tapping one showed an
    // empty artist screen.
    const id = F.creditIdentities("Miles Davis / John Coltrane");
    assert.ok(id.names.includes("miles davis"));
    assert.ok(id.names.includes("john coltrane"));
  });
});

test("creditHasArtist — whole-name equality, never substring", async (t) => {
  const F = withLibrary(PRINCE_LIBRARY);

  await t.test("Prince must NOT match 'Jordan Prince'", () => {
    // The shipped "Also appears on" bug, in both directions.
    assert.equal(F.creditHasArtist("Jordan Prince", "Prince"), false);
    assert.equal(F.creditHasArtist("Prince", "Jordan Prince"), false);
  });

  await t.test('Prince must NOT match \'Bonnie "Prince" Billy\'', () => {
    assert.equal(F.creditHasArtist('Bonnie "Prince" Billy', "Prince"), false);
    assert.equal(F.creditHasArtist("Prince", 'Bonnie "Prince" Billy'), false);
  });

  await t.test("Prince MUST match 'Prince & The Revolution'", () => {
    assert.equal(F.creditHasArtist("Prince & The Revolution", "Prince"), true);
    assert.equal(F.creditHasArtist("Prince", "Prince & The Revolution"), true);
  });

  await t.test("the whole family of substring false-positives stays closed", () => {
    const J = withLibrary(JAZZ_LIBRARY);
    for (const [credit, artist] of [
      ["Kate Bush", "Bush"],
      ["Bush", "Kate Bush"],
      ["Air Supply", "Air"],
      ["Princess Nokia", "Prince"],
      ["Yesterday", "Yes"],
      ["Stinger", "Sting"],
      ["The Beatles", "Beat"],
    ]) {
      assert.equal(J.creditHasArtist(credit, artist), false,
        `"${artist}" must not match credit "${credit}"`);
      assert.equal(J.creditHasArtist(artist, credit), false,
        `"${credit}" must not match credit "${artist}"`);
    }
  });

  await t.test("exact names still match, including 'The' variants", () => {
    const J = withLibrary(JAZZ_LIBRARY);
    assert.equal(J.creditHasArtist("Miles Davis", "Miles Davis"), true);
    assert.equal(J.creditHasArtist("The Beatles", "Beatles"), true);
    assert.equal(J.creditHasArtist("Beatles", "The Beatles"), true);
  });

  await t.test("both sides may be full credits rendered differently", () => {
    // The stale-offset resolver compares a stored credit against a live one;
    // treating the query as a single name failed on exactly the multi-artist
    // albums it exists to rescue.
    const J = withLibrary(JAZZ_LIBRARY);
    assert.equal(J.creditHasArtist("Miles Davis/John Coltrane", "Miles Davis"), true);
    assert.equal(J.creditHasArtist("Miles Davis", "Miles Davis/John Coltrane"), true);
    assert.equal(J.creditHasArtist("Miles Davis/John Coltrane", "John Coltrane"), true);
  });

  await t.test("'&' vs 'and' and accents do not block a real match", () => {
    const F2 = withLibrary(["Bjork"]);
    assert.equal(F2.creditHasArtist("Björk", "Bjork"), true);
    assert.equal(F2.creditHasArtist("Earth, Wind & Fire", "Earth, Wind and Fire"), true);
  });

  await t.test("an empty or punctuation-only side never matches anything", () => {
    // Two blank credits must not be judged the same artist.
    assert.equal(F.creditHasArtist("", "Prince"), false);
    assert.equal(F.creditHasArtist("Prince", ""), false);
    assert.equal(F.creditHasArtist("", ""), false);
    assert.equal(F.creditHasArtist("!!!", "!!!"), false);
    assert.equal(F.creditHasArtist(null, undefined), false);
  });
});
