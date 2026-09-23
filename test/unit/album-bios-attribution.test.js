"use strict";
// ---------------------------------------------------------------------------
// v1.8.32: whose words the album description is.
//
// fetchAlbumBios picks ONE winner for the album — Pitchfork, then Qobuz, then
// Wikipedia — and the Pitchfork branch emitted `description: null`, because
// their written review must not be displayed (UK law; only the score, the Best
// New Music flag and a link to read it at theirs).
//
// The effect nobody intended: any record Pitchfork had reviewed showed NO text
// at all, on the album view and on the share card, while the Wikipedia article
// fetched in the same Promise.all sat unused two lines away. Reported as "the
// wiki reviews, if available, weren't added to the share card".
//
// The rule is about THEIR prose, not about the album having none. So Wikipedia
// supplies the text on that branch — and the moment it does, `source` (where
// the LINK goes: Pitchfork) stops describing whose words are on screen. Two
// fields, and this file is the line between them: showing Wikipedia's
// paragraph under a link reading "Read the full review on Pitchfork" would be
// a misattribution, which is the same failure the compliance rule exists to
// prevent, pointing the other way.
//
// fetchAlbumBios talks to three networks, so the shape is asserted through a
// pure re-implementation of its selection rules. That is worth stating plainly:
// this pins the CONTRACT the client relies on (description_source names the
// prose; source names the link; they may differ on exactly one path), not the
// function's own wiring.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");

test("the Pitchfork branch no longer emits a null description", () => {
  // Read from the source, because this is the exact line that was wrong and
  // the one a future edit would most plausibly put back.
  const branch = /if \(pitchfork && pitchfork\.description\) \{[\s\S]*?album = \{([\s\S]*?)\};/.exec(SRC);
  assert.ok(branch, "could not find the Pitchfork branch of fetchAlbumBios");
  const body = branch[1];
  assert.match(body, /description:\s*pfText/,
    "the Pitchfork branch is not supplying any text — a reviewed album will show " +
    "a score and no words at all, which is what was reported");
  assert.match(body, /description_source:\s*pfSource/,
    "the text has no attribution, so the album view cannot tell it apart from " +
    "the Pitchfork review it links to");
  assert.match(body, /source:\s*"Pitchfork"/,
    "the LINK should still be the Pitchfork review — only the text changed");
});

test("a Pitchfork-reviewed album falls back to Qobuz when Wikipedia has nothing", () => {
  // THE second half of the same defect. v1.8.32 wired Wikipedia into this
  // branch and stopped, which left Qobuz's paragraph sitting unused in exactly
  // the way Wikipedia's had been — so a reviewed album whose encyclopaedia
  // lookup came back empty still showed a score and no words. Reported against
  // Bruce Springsteen's *Western Stars*, which shares its title with a 2019
  // documentary film.
  //
  // Asserted on the SELECTION, which is where the precedence lives, rather
  // than on the branch body that consumes it.
  const sel = /const pfText\s*=([^;]*);/.exec(SRC);
  assert.ok(sel, "could not find the Pitchfork branch's prose selection (pfText)");
  assert.match(sel[1], /wikiText/, "Wikipedia is no longer a candidate");
  assert.match(sel[1], /qobuzText/,
    "Qobuz's description is not a fallback, so a missed Wikipedia lookup still " +
    "leaves a Pitchfork-reviewed album with no words at all");
  // Order matters: an album showing an article today must not start showing a
  // different paragraph tomorrow because both exist.
  assert.ok(sel[1].indexOf("wikiText") < sel[1].indexOf("qobuzText"),
    "Qobuz is taking precedence over Wikipedia in the Pitchfork branch — it is " +
    "meant to be the fallback, not a competitor");

  const src = /const pfSource\s*=([^;]*);/.exec(SRC);
  assert.ok(src, "could not find pfSource");
  assert.match(src[1], /wikiText \? "Wikipedia"/, "Wikipedia text is misattributed");
  assert.match(src[1], /"Qobuz"/,
    "text that fell back to Qobuz is not attributed to Qobuz, which is the " +
    "misattribution description_source exists to prevent");
});

test("Pitchfork's own prose still never leaves the server", () => {
  // The compliance rule, from the other end. `pitchfork.description` is read
  // by the branch gate and by fetchPitchfork's artist check, and must not be
  // assigned to anything that goes out.
  const branch = /if \(pitchfork && pitchfork\.description\) \{[\s\S]*?album = \{([\s\S]*?)\};/.exec(SRC);
  const body = branch[1];
  assert.ok(!/description:\s*pitchfork\.description/.test(body),
    "Pitchfork's review text is being emitted — only the score, the Best New " +
    "Music flag and a LINK are allowed out (see the note in fetchAlbumBios)");
  assert.ok(!/description_source:\s*"Pitchfork"/.test(body),
    "the text is attributed to Pitchfork, which would say their words are on screen");
});

test("every branch states where its text came from", () => {
  // A uniform contract: if there is a description, something names its source.
  const fn = /async function fetchAlbumBios\([\s\S]*?\n}/.exec(SRC);
  assert.ok(fn, "could not find fetchAlbumBios");
  const bodies = [...fn[0].matchAll(/album = \{([\s\S]*?)\};/g)].map(m => m[1]);
  assert.equal(bodies.length, 4, "expected four branches, found " + bodies.length);
  for (const body of bodies) {
    // NOT a negative lookahead after \s* — that backtracks to a single space
    // and passes on "description: null", which is how the first version of
    // this assertion reported a branch that was perfectly fine.
    const hasDesc = !/description:\s*null\s*,/.test(body);
    assert.match(body, /description_source:/,
      "a branch sets no description_source at all:\n" + body);
    if (hasDesc) {
      assert.ok(!/description_source:\s*null/.test(body) ||
                /description_source:\s*wikiText \?/.test(body),
        "a branch emits text with description_source hardcoded to null:\n" + body);
    }
  }
});

test("dropping the text for a wrong artist drops its attribution too", () => {
  // The guard that discards a description whose lead name does not match the
  // album's artist. Leaving description_source behind would offer "From
  // Wikipedia" under a paragraph that is no longer there.
  assert.match(SRC,
    /if \(!album\.description\) \{ album\.description_source = null; album\.description_url = null; \}/,
    "the artist-mismatch guard clears the text but leaves its source and url set");
});
