"use strict";
// ---------------------------------------------------------------------------
// v1.8.36: the Qobuz link that opens the Qobuz app.
//
// Reported: a suggestion with Qobuz as the default landed on the download
// store's search results. That is not a badly chosen search URL — no search
// URL anywhere can do better. open.qobuz.com is Qobuz's "open in the app"
// host, both platforms hand it every path, and its router understands exactly
// five shapes, all of them IDs. There is no search route on that host or in
// the app behind it, so an id is the whole feature.
//
// Which makes the matching rule the thing that matters: Qobuz answers a query
// it cannot place with its nearest guess rather than nothing, and A WRONG
// ALBUM IS WORSE THAN A SEARCH PAGE — the search page at least shows the right
// words.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../../lib/qobuz-deeplink");

const href = (store, slug, id) => '<a href="/' + store + '/album/' + slug + '/' + id + '">x</a>';

test("an exact album-then-artist slug wins", () => {
  const html = href("gb-en", "low-david-bowie", "abc123");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "abc123");
  assert.equal(Q.deepLink("abc123"), "https://open.qobuz.com/album/abc123");
});

test("the exact match is taken WHEREVER it appears, not merely first", () => {
  // Searching "Mezzanine" returns the remixes album too, and it often sorts
  // above the record itself.
  const html = href("gb-en", "mezzanine-remixes-massive-attack", "remix1") +
               href("gb-en", "mezzanine-massive-attack",         "real99");
  assert.equal(Q.pickAlbumId(html, "gb-en", "Massive Attack", "Mezzanine"), "real99",
    "the remixes album sorted first and was taken on trust");
});

test("a slug that STARTS with the album and mentions the artist is the fallback", () => {
  // A remaster or a deluxe edition carries a suffix the title does not.
  const html = href("gb-en", "low-2017-remaster-david-bowie", "rem77");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "rem77");
});

test("anything else is a guess, and a guess opens the wrong record", () => {
  // Qobuz's nearest guess for a record it does not carry.
  const html = href("gb-en", "something-else-entirely-another-act", "nope1");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), null,
    "an unrelated result was accepted — the search page would have been better");
  // The artist has to appear: the album title alone is not enough.
  assert.equal(Q.pickAlbumId(href("gb-en", "low-somebody-else", "x1"),
                             "gb-en", "David Bowie", "Low"), null);
});

test("Qobuz's slugging is not reproducible, so both sides are reduced", () => {
  // An apostrophe and a full stop vanish; a slash becomes a separator.
  assert.equal(Q.pickAlbumId(href("us-en", "ol-dirty-bastard-return-to-the-36-chambers", "d1"),
    "us-en", "Ol' Dirty Bastard", "Return to the 36 Chambers"), null,
    "that slug is artist-then-album, which is not the shape Qobuz files under");
  assert.equal(Q.pickAlbumId(href("us-en", "good-kid-maad-city-kendrick-lamar", "d2"),
    "us-en", "Kendrick Lamar", "good kid, m.A.A.d city"), "d2");
  assert.equal(Q.pickAlbumId(href("us-en", "back-in-black-ac-dc", "d3"),
    "us-en", "AC/DC", "Back in Black"), "d3");
  assert.equal(Q.canon("Ol' Dirty Bastard"), "oldirtybastard");
  assert.equal(Q.canon("good kid, m.A.A.d city"), "goodkidmaadcity");
  assert.equal(Q.canon("AC/DC"), "acdc");
  assert.equal(Q.canon("Sigur Rós"), "sigurros");
});

test("results for another storefront are not this search's answers", () => {
  // Language switchers and related links put other stores on the page.
  const html = href("fr-fr", "low-david-bowie", "wrong1") +
               href("gb-en", "low-david-bowie", "right1");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "right1");
  assert.equal(Q.pickAlbumId(html, "fr-fr", "David Bowie", "Low"), "wrong1");
});

test("nothing to go on yields nothing", () => {
  assert.equal(Q.pickAlbumId("", "gb-en", "David Bowie", "Low"), null);
  assert.equal(Q.pickAlbumId(null, "gb-en", "David Bowie", "Low"), null);
  assert.equal(Q.pickAlbumId("<html>no links here</html>", "gb-en", "Bowie", "Low"), null);
  assert.equal(Q.pickAlbumId(href("gb-en", "low-david-bowie", "a1"), "gb-en", "Bowie", ""), null,
    "no album title means no query worth answering");
  assert.equal(Q.deepLink(null), null);
  assert.equal(Q.deepLink(""), null);
});

test("the regex is shared, so a second call must not resume mid-page", () => {
  // A stateful /g regex that is not reset skips the start of the next page,
  // which shows up as "it worked once".
  const html = href("gb-en", "low-david-bowie", "abc123");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "abc123");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "abc123",
    "the second call found nothing — lastIndex was left where the first stopped");
  assert.equal(Q.pickAlbumId(html, "gb-en", "David Bowie", "Low"), "abc123");
});

test("the search page and the deep link are the shapes Qobuz serves", () => {
  assert.equal(Q.searchUrl("gb-en", "Bowie%20Low"),
    "https://www.qobuz.com/gb-en/search/albums/Bowie%20Low");
  assert.ok(Q.isDeepLink("https://open.qobuz.com/album/abc"));
  assert.ok(!Q.isDeepLink("https://www.qobuz.com/gb-en/search/?q=x"));
  assert.ok(!Q.isDeepLink(null));
});
