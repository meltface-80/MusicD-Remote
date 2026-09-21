"use strict";
/*
 * qobuz-deeplink.js — the Qobuz link that opens the Qobuz APP.
 *
 * Ported from MusicD Share Card (QobuzAlbum.kt), including the reason it has
 * to exist at all.
 *
 * WHY A SEARCH LINK CAN NEVER WORK. A Qobuz search URL lands on the DOWNLOAD
 * STORE's results page in a browser — "Results for U2 Rattle And Hum, 1-60 of
 * 1000 albums", the first of them by somebody else entirely — and it never
 * opens the app. That is not a matter of picking a better search URL:
 *
 *   open.qobuz.com is Qobuz's own "open this in the app" host, and both
 *   platforms hand it every path because Qobuz publishes an assetlinks.json
 *   and an apple-app-site-association claiming all of them. Its router
 *   understands exactly five shapes, and every one of them is an ID:
 *
 *       /album/:id   /artist/:id   /track/:id   /playlist/:id   /:type/:id
 *
 *   There is no search route, on that host or in the app behind it. An
 *   open.qobuz.com/search?q= link opens the app on Discover with the query
 *   thrown away. Pointing at the web player does not help either: play.qobuz
 *   .com is claimed by the same app and lands in the same place.
 *
 * So the ID is the whole feature, and the id comes off Qobuz's own public
 * search page — the same way index.js reads pitchfork.com. No API, no key, no
 * account: only the markup a browser is served.
 *
 * A WRONG ALBUM IS WORSE THAN A SEARCH PAGE. Qobuz answers a query it cannot
 * place with its nearest guess rather than with nothing, so the first hit is
 * never taken on trust — the slug it is filed under has to be recognisably the
 * record that was asked for, or this returns null and the caller keeps the
 * search link it already had.
 *
 * Pure: HTML in, an id out. The fetching and the rate gate live in index.js.
 */

const OPEN_HOST = "https://open.qobuz.com/album/";

// Qobuz files an album under /<store>/album/<album-slug>-<artist-slug>/<id>.
const HREF = /href="\/([a-z]{2}-[a-z]{2})\/album\/([a-z0-9-]+)\/([A-Za-z0-9]+)"/g;

/*
 * Letters and digits only, accents folded.
 *
 * QOBUZ'S SLUGGING IS NOT A RULE THAT CAN BE REPRODUCED, so both sides are
 * reduced until they agree. An apostrophe and a full stop simply vanish
 * ("Ol' Dirty Bastard" is ol-dirty-bastard, "good kid, m.A.A.d city" is
 * good-kid-maad-city) while a slash becomes a separator ("AC/DC" is ac-dc).
 * Dropping every separator from both sides makes all three agree.
 */
function canon(s) {
  return String(s == null ? "" : s).toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The id of the result that is recognisably the record asked for, or null.
 *
 * An exact "album then artist" is taken WHEREVER it appears in the results,
 * not merely first: searching "Mezzanine" returns the remixes album too, and
 * that often sorts above the record itself. Failing that, a result that STARTS
 * with the album and mentions the artist will do — which catches a remaster or
 * a deluxe edition, whose slug carries a suffix the title does not.
 *
 * Anything else is a guess, and a guess here opens the wrong record.
 *
 * @param {string} html  the search page
 * @param {string} store the storefront whose results count ("gb-en")
 * @param {string} artist
 * @param {string} album
 * @returns {string|null}
 */
function pickAlbumId(html, store, artist, album) {
  const wantAlbum = canon(album);
  if (!wantAlbum) return null;
  const wantArtist = canon(artist || "");
  const exact = wantAlbum + wantArtist;

  let loose = null;
  HREF.lastIndex = 0;                 // the regex is shared and stateful
  let m;
  while ((m = HREF.exec(String(html || ""))) !== null) {
    // Results for another storefront are on the page (language switchers,
    // related links) and are not this search's answers.
    if (m[1] !== store) continue;
    const slug = canon(m[2]);
    const id = m[3];
    if (slug === exact) return id;
    if (loose === null && wantArtist && slug.startsWith(wantAlbum) && slug.includes(wantArtist)) {
      loose = id;
    }
  }
  return loose;
}

/** Where the search page for this record lives on a given storefront. */
function searchUrl(store, query) {
  return "https://www.qobuz.com/" + store + "/search/albums/" + query;
}

/** The link that opens the app. */
function deepLink(id) {
  return id ? OPEN_HOST + id : null;
}

/** Whether a url is already one of these (so it is not upgraded twice). */
function isDeepLink(url) {
  return typeof url === "string" && url.indexOf(OPEN_HOST) === 0;
}

module.exports = { OPEN_HOST, canon, pickAlbumId, searchUrl, deepLink, isDeepLink };
