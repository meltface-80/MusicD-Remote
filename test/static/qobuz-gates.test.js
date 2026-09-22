"use strict";
/*
 * qobuz-gates.test.js — one spelling of "is Qobuz connected".
 *
 * THE BUG THIS EXISTS FOR (v1.8.51). Three separate places decided whether
 * Qobuz was usable by testing the LEGACY password login:
 *
 *     qobuzToken || (qobuzUsername && qobuzPasswordMd5)
 *
 * v1.8.20 removed that login — the browser sign-in replaced it and sets
 * `qobuzWaveToken` instead — and nothing updated the three gates. They were
 * therefore false forever on any install connected the only way the app still
 * offers, which silently switched off the Qobuz favourites read (and with it
 * every Qobuz streaming waveform, because the album ids come from that read),
 * the Qobuz source badges, and the Qobuz artist bio.
 *
 * `qobuzReady()` already existed, with a comment saying the pre-existing gates
 * had drifted. Naming a drift is not fixing it, and nothing failed when they
 * stayed drifted. This is the thing that fails.
 *
 * WHY A GREP AND NOT A BEHAVIOURAL TEST: the gates are inline conditions in an
 * 15k-line module that opens a database and talks to Roon on require. The
 * defect is a DUPLICATED PREDICATE, and duplication is a property of the text.
 *
 * WHY IT DOES NOT CRY WOLF: comment lines are skipped. The fix's own comment
 * quotes the dead expression verbatim — that is the clearest way to say what
 * was wrong — and a check that flagged the explanation of its own absence is
 * the kind that gets waved through when it finally catches something real.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "index.js");
const LINES = fs.readFileSync(SRC, "utf8").split("\n");

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function codeLinesMatching(re) {
  const out = [];
  LINES.forEach((line, i) => {
    if (isComment(line)) return;
    if (re.test(line)) out.push((i + 1) + ": " + line.trim());
  });
  return out;
}

test("Qobuz connectivity is asked in exactly one place", () => {
  // The legacy idiom, in code. Exactly one may survive: qobuzReady()'s own body,
  // which is where the legacy credentials are legitimately still honoured for
  // installs that had a password login before v1.8.20.
  const hits = codeLinesMatching(/qobuzUsername\s*&&\s*qobuzPasswordMd5/);
  const gates = hits.filter(h => /qobuzToken\s*\|\|/.test(h));
  assert.equal(gates.length, 1,
    "the \"is Qobuz connected\" test is spelled out " + gates.length + " times in code; " +
    "every site but qobuzReady()'s own body must CALL qobuzReady(), or the next " +
    "credential change silently switches features off one gate at a time:\n  " +
    gates.join("\n  "));
  assert.match(gates[0], /qobuzWaveToken/,
    "the one surviving spelling is not qobuzReady()'s — it does not mention the " +
    "browser sign-in token, so it is another drifted gate: " + gates[0]);
});

test("the three sites the drift switched off call qobuzReady()", () => {
  // Named individually rather than counted, because a future refactor that
  // deletes one of these and leaves the count right would pass a bare count.
  const src = LINES.join("\n");

  // 1. The favourites read. This one is the waveform: no favourites means no
  //    album ids, and wfQobuzAlbumId has nothing to answer with.
  assert.match(src, /if \(qobuzReady\(\)\) \{\n      try \{\n        \/\/ Page until the service runs out/,
    "refreshStreamAlbumKeys no longer gates the Qobuz favourites read on qobuzReady()");

  // 2. The badge authority. A service that is connected but not counted as
  //    claiming makes its albums look local.
  assert.match(src, /if \(qobuzReady\(\) && qobuzAlbumKeys\.size\) out\.push\("qobuz"\)/,
    "claimingServices() no longer gates Qobuz on qobuzReady()");

  // 3. The artist bio.
  // The searchCatalog CALL is not distinctive — Smart Picks makes the same one
  // three thousand lines up, and it already called qobuzReady(), so an anchor
  // that stopped at the call name would pass with this site still drifted.
  // The album-title argument belongs to this site alone.
  assert.match(src, /if \(qobuzReady\(\)\) \{\n    try \{\n      const r = await qobuzWithToken\(t => qobuz\.searchCatalog\(t, name \+ " " \+ albumTitle/,
    "fetchServiceArtistBio no longer gates its Qobuz branch on qobuzReady()");
});

test("TIDAL connectivity is asked in exactly one place too", () => {
  // The same defect one service over, found while fixing this one:
  // claimingServices() tested `tidalRefreshToken && tidalAlbumKeys.size` — no
  // user id — while tidalReady() requires both, so the two disagreed about a
  // half-connected account. Nothing had gone wrong with it yet, which is
  // exactly the state the Qobuz gates were in for thirty versions.
  const hits = codeLinesMatching(/tidalRefreshToken\s*&&\s*tidalUserId/);
  assert.equal(hits.length, 1,
    "the \"is TIDAL connected\" test is spelled out " + hits.length + " times in " +
    "code; every site but tidalReady()'s own body must CALL tidalReady():\n  " +
    hits.join("\n  "));
  assert.match(hits[0], /function tidalReady/,
    "the one surviving spelling is not tidalReady()'s own body: " + hits[0]);
});

test("qobuzReady accepts the browser sign-in on its own", () => {
  // The whole point: since v1.8.20 this is the ONLY credential a new install
  // can have, so a definition that required one of the other two would make
  // every call site above false again.
  const body = LINES.join("\n").match(/function qobuzReady\(\) \{[^}]*\}/);
  assert.ok(body, "qobuzReady() is gone");
  assert.match(body[0], /qobuzWaveToken/,
    "qobuzReady() does not accept the browser sign-in token — the only credential " +
    "the app still offers a way to obtain");
});
