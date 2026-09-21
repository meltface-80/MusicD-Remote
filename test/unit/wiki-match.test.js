"use strict";
// ---------------------------------------------------------------------------
// v1.8.34: which Wikipedia article is about which album.
//
// Reported: Airbourne's self-titled 2026 album showed the article for Runnin'
// Wild, their 2007 debut. The rule was "the page title must contain the album
// title as whole words", applied to the WHOLE page title — disambiguator and
// all — so for a SELF-TITLED record, where the album name is the act's name,
// the parenthetical that exists to tell their albums apart matched every one
// of them and the first search result won.
//
// Self-titled albums are where album-matching heuristics go wrong, and they
// are common enough — a debut, a reinvention, a comeback — that they get their
// own cases here rather than one passing mention.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const W = require("../../lib/wiki-match");

test("THE BUG: a self-titled album does not match the act's other records", () => {
  // Every one of these contains "Airbourne" in its disambiguator.
  for (const page of ["Runnin' Wild (Airbourne album)",
                      "No Guts. No Glory. (Airbourne album)",
                      "Black Dog Barking (Airbourne album)",
                      "Boneshaker (Airbourne album)"]) {
    assert.equal(W.albumPageTitleMatches("Airbourne", page), false,
      '"Airbourne" (the self-titled album) matched ' + JSON.stringify(page) +
      " — the disambiguator names the BAND, so reading it matches every record " +
      "they ever made and the first search result wins");
  }
  // …and the one that is actually about it still does.
  assert.equal(W.albumPageTitleMatches("Airbourne", "Airbourne (Airbourne album)"), true);
  assert.equal(W.albumPageTitleMatches("Airbourne", "Airbourne (album)"), true);
});

test("the ordinary case still matches", () => {
  assert.equal(W.albumPageTitleMatches("Low", "Low (David Bowie album)"), true);
  assert.equal(W.albumPageTitleMatches("Pang", "Pang (album)"), true);
  assert.equal(W.albumPageTitleMatches("Everything Forever",
    "Everything Forever (Victories at Sea album)"), true);
  assert.equal(W.albumPageTitleMatches("The Wall", "The Wall"), true);
  assert.equal(W.albumPageTitleMatches("Kind of Blue", "Kind of Blue"), true);
  // Accents and punctuation fold the same on both sides.
  assert.equal(W.albumPageTitleMatches("Ágætis byrjun", "Ágætis byrjun"), true);
  assert.equal(W.albumPageTitleMatches("Sgt. Pepper's Lonely Hearts Club Band",
    "Sgt. Pepper's Lonely Hearts Club Band"), true);
});

test("a short title still cannot match inside a longer word", () => {
  // The reason the check is whole-word in the first place.
  assert.equal(W.albumPageTitleMatches("Up", "Group (album)"), false);
  assert.equal(W.albumPageTitleMatches("Up", "Setup (album)"), false);
  assert.equal(W.albumPageTitleMatches("Up", "Up (R.E.M. album)"), true);
});

test("only a TRAILING parenthetical is a disambiguator", () => {
  assert.equal(W.stripDisambiguator("Low (David Bowie album)"), "Low");
  assert.equal(W.stripDisambiguator("Pang (album)"), "Pang");
  assert.equal(W.stripDisambiguator("The Wall"), "The Wall");
  // One in the MIDDLE is part of the name and must survive, or the album loses
  // half its title and stops matching itself.
  assert.equal(W.stripDisambiguator("Live (Sound of Music) Tour"), "Live (Sound of Music) Tour");
  assert.equal(W.albumPageTitleMatches("Live (Sound of Music) Tour",
    "Live (Sound of Music) Tour"), true);
  // Nested or unbalanced parentheses are left alone rather than guessed at.
  assert.equal(W.stripDisambiguator("Weird ((title"), "Weird ((title");
});

test("an album title with no word in it matches nothing, rather than everything", () => {
  // Sigur Rós's "( )". The old rule padded both sides, so an empty needle was
  // " anything ".includes(" ") — true for every page, and the first search
  // result won. No description beats a confident wrong one.
  assert.equal(W.albumPageTitleMatches("( )", "Runnin' Wild (Airbourne album)"), false);
  assert.equal(W.albumPageTitleMatches("", "Low (David Bowie album)"), false);
  assert.equal(W.albumPageTitleMatches(null, "Low"), false);
  assert.equal(W.albumPageTitleMatches("   ", "Low"), false);
});

test("a page whose whole title is a parenthetical falls back to the full title", () => {
  // Stripping would leave nothing, so the full title is used rather than the
  // candidate being thrown away.
  assert.equal(W.albumPageTitleMatches("album", "(album)"), true);
});

test("normalize agrees with index.js's, character for character", () => {
  // This module carries its OWN copy, because the rule and the comparison that
  // implements it belong together. A copy is a drift risk, so the copy is
  // checked against the original rather than described as matching it: the
  // real normalize() is lifted out of index.js and both are run over the same
  // battery. (Ligatures are the interesting ones — NFKD does not decompose
  // "æ", so it falls to the non-alphanumeric rule and becomes a space. Both
  // sides have to agree on that, not just on the easy cases.)
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");
  const m = /\nfunction normalize\(s\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "could not find normalize() in index.js");
  const theirs = new Function(m[0] + "\nreturn normalize;")();

  const battery = [
    "Sgt. Pepper's Lonely Hearts Club Band", "Ágætis byrjun", "( )", "AC/DC",
    "Mötley Crüe", "Beyoncé", "F# A# ∞", "  MULTIPLE   spaces ", "Låpsley",
    "Œuvre", "Encyclopædia", "中島みゆき", "Naïve", "ÅÄÖ", "",
    "Airbourne (Airbourne album)", "Runnin' Wild",
  ];
  for (const s of battery) {
    assert.equal(W.normalize(s), theirs(s),
      "the two normalize() implementations disagree on " + JSON.stringify(s) +
      " — lib/wiki-match.js has drifted from index.js");
  }
  assert.equal(W.normalize(null), theirs(null));
  assert.equal(W.normalize(undefined), theirs(undefined));

  // A couple of outright expectations too, so the pair cannot drift TOGETHER
  // into something neither of them should do.
  assert.equal(W.normalize("Sgt. Pepper's"), "sgt pepper s");
  assert.equal(W.normalize("  MULTIPLE   spaces "), "multiple spaces");
});
