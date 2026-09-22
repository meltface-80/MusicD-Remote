"use strict";
// ---------------------------------------------------------------------------
// v1.8.51: why a STREAMED track has no waveform.
//
// GET /api/debug/waveform was built in v1.8.30 because "it is on and there are
// no waveforms" was one silence covering five local causes. It stopped at the
// local chain: for a Qobuz or TIDAL track it said "it is a streamed track" and
// nothing else — leaving the streaming path with exactly the problem the
// endpoint existed to cure, one path along.
//
// WHAT IS PINNED HERE IS THE ORDER, not the wording. wfQobuzTrack and
// wfTidalTrack check in a fixed sequence and each stop has a different fix: a
// missing credential is a sign-in, an album that is not a favourite is a
// different problem, and anything past those two can only be seen by making
// the attempt. Naming the second cause while the first is also true sends
// somebody to the wrong screen — worse than saying nothing, because it reads
// as an answer.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { streamingVerdict } = require("../../lib/waveform-verdict");

const qobuzFav = { album_id: "123", favourite_albums_known: 40 };
const noIds    = { album_id: null, favourite_albums_known: 0 };

test("a reachable album with no credential names the sign-in, and only that", () => {
  // The default state — nothing is signed in until somebody signs it in — so
  // it comes first or it never gets said.
  const v = streamingVerdict(
    Object.assign({}, qobuzFav, { signed_in_for_waveforms: false, has_pasted_secret: false }),
    noIds);
  assert.match(v, /not signed in to Qobuz for waveforms/);
  assert.match(v, /Settings -> Playback/);
});

test("either credential is enough to move past the sign-in", () => {
  // The browser token signs; a pasted secret is the older route that still
  // works. Demanding both would send somebody to a screen they do not need.
  for (const cred of [{ signed_in_for_waveforms: true,  has_pasted_secret: false },
                      { signed_in_for_waveforms: false, has_pasted_secret: true }]) {
    const v = streamingVerdict(Object.assign({}, qobuzFav, cred), noIds);
    assert.doesNotMatch(v, /not signed in/, JSON.stringify(cred) + " -> " + v);
    assert.match(v, /later in the chain/);
  }
});

test("identified and credentialled points at the log, because nothing else can see it", () => {
  const v = streamingVerdict(
    Object.assign({}, qobuzFav, { signed_in_for_waveforms: true }), noIds);
  assert.match(v, /\[waveform\]/, v);
});

test("a TIDAL album is named as TIDAL, not as Qobuz", () => {
  const v = streamingVerdict(
    { album_id: null, favourite_albums_known: 0, signed_in_for_waveforms: true },
    { album_id: "t9", favourite_albums_known: 12 });
  assert.match(v, /known to TIDAL/, v);
});

test("no favourites read at all is a DIFFERENT answer from 'not a favourite'", () => {
  // They have different fixes: one is connect-or-rescan, the other is that
  // this particular record is not in the list. Collapsing them was the bug.
  // Deliberately with NO credential on either side: with one connected this is
  // branch 3 ("connected and knows nothing"), which is a third distinct answer.
  const none = streamingVerdict(noIds, noIds);
  assert.match(none, /no favourites have been read/, none);

  const some = streamingVerdict(
    { album_id: null, favourite_albums_known: 40 },
    { album_id: null, favourite_albums_known: 12 });
  assert.doesNotMatch(some, /no favourites have been read/, some);
  assert.match(some, /neither service's FAVOURITES/, some);
  // The counts are quoted, because "40 known and yours is not one" and
  // "0 known" look identical without them.
  assert.match(some, /40 Qobuz/, some);
  assert.match(some, /12 TIDAL/, some);
});

test("connected-and-knows-nothing is not the same answer as not-connected", () => {
  // THE v1.8.51 case. The favourites gate had been testing a login the app
  // stopped offering, so a signed-in account read zero favourites forever —
  // and the verdict for that state told the user to connect the account they
  // were already connected to. Every install looked like this, which is why
  // the sentence had to be able to exist before the fix could be trusted.
  const v = streamingVerdict(
    { album_id: null, favourite_albums_known: 0, signed_in_for_waveforms: true },
    { album_id: null, favourite_albums_known: 0 });
  assert.match(v, /Qobuz is CONNECTED/, v);
  assert.doesNotMatch(v, /connect Qobuz or TIDAL/, v);
  // It names the log line, because that is what separates "never ran" from
  // "ran and got nothing" — opposite next steps.
  assert.match(v, /\[stream\] Qobuz favourites/, v);
});

test("a connected TIDAL with nothing read is named as TIDAL", () => {
  const v = streamingVerdict(
    { album_id: null, favourite_albums_known: 0 },
    { album_id: null, favourite_albums_known: 0, account_connected: true });
  assert.match(v, /TIDAL is CONNECTED/, v);
  assert.doesNotMatch(v, /Qobuz is CONNECTED/, v);
  assert.match(v, /\[stream\] TIDAL favourites/, v);
});

test("account_connected alone counts for Qobuz, not just the waveform sign-in", () => {
  // qobuzReady() is the server's own answer and includes a legacy password
  // login. Requiring the waveform sign-in here would report a connected
  // account as disconnected.
  const v = streamingVerdict(
    { album_id: null, favourite_albums_known: 0, account_connected: true },
    { album_id: null, favourite_albums_known: 0 });
  assert.match(v, /Qobuz is CONNECTED/, v);
});

test("a connected service that DID read its favourites falls through", () => {
  // The branch must not swallow the ordinary case: favourites read, this
  // record simply is not one of them.
  const v = streamingVerdict(
    { album_id: null, favourite_albums_known: 40, signed_in_for_waveforms: true },
    { album_id: null, favourite_albums_known: 12, account_connected: true });
  assert.doesNotMatch(v, /is CONNECTED but none/, v);
  assert.match(v, /neither service's FAVOURITES/, v);
});

test("the sign-in verdict outranks the not-a-favourite one", () => {
  // THE ordering assertion. With an album id present, the credential is the
  // thing in the way; mentioning favourites here would be the wrong screen.
  const v = streamingVerdict(
    { album_id: "123", favourite_albums_known: 40,
      signed_in_for_waveforms: false, has_pasted_secret: false },
    { album_id: null, favourite_albums_known: 0 });
  assert.match(v, /not signed in/, v);
  assert.doesNotMatch(v, /neither service/, v);
});

test("it survives being handed nothing", () => {
  // The route builds these objects from live state; a missing service should
  // not throw inside a diagnostic.
  assert.equal(typeof streamingVerdict(), "string");
  assert.equal(typeof streamingVerdict(null, null), "string");
});
