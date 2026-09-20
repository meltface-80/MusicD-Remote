"use strict";
/*
 * share-links.js — the links under the share card: where to hear this record,
 * and where to read about it.
 *
 * Ported from MusicD Share Card (StreamingLinks.kt / Reviews.kt). Everything
 * here is a pure function of a title, an artist and a locale: no network, no
 * cache, no Core. That is deliberate — the rules below are the kind that look
 * arbitrary and are not, and each one is a test rather than a comment alone.
 *
 * THE FOUR RULES THAT COST SOMETHING TO LEARN, all of them in searchQuery():
 *
 *   1. PERCENT-ENCODED, NOT FORM-ENCODED. A space is "%20". "+" is correct in
 *      a form body and merely conventional in a query string — and four of
 *      these services take the query as a PATH SEGMENT (Spotify, Amazon,
 *      Deezer, AllMusic), where "+" is not a space at all and gets searched
 *      for literally.
 *   2. A SLASH IS SPENT AS A SPACE, not encoded. Qobuz redirects "?q=…" into a
 *      path segment and decodes the %2F on the way, so "AC/DC" arrives as two
 *      segments and 404s; for the path-segment services an encoded slash is a
 *      traversal waiting for somebody's proxy to normalise it. A slash means
 *      nothing to a search box, so it becomes a space and "AC DC Back in
 *      Black" finds the record.
 *   3. ONLY THE FIRST CREDITED ACT. A Roon card credited "Stan Getz / Cal
 *      Tjader / Alan Jay Lerner / Frederick Loewe" searched for all four names
 *      at once, and AllMusic answered in as many words: no such act exists, so
 *      nothing matched — on that chip and every chip beside it. The split runs
 *      BEFORE the slash is spent, because a spaced slash is the separator it
 *      reads.
 *   4. QOBUZ NEEDS A STOREFRONT and has exactly thirty. There is no
 *      storefront-less form — https://www.qobuz.com/search/?q=… is a 404, and
 *      so is any country code they do not sell in, so this cannot be built by
 *      joining language to country and hoping. Apple is the opposite and must
 *      not be given one: they redirect a storefront-less URL to the visitor's
 *      own, which is worth more than a table of ~175 codes that 404 when wrong.
 *
 * CHIP LABELS ARE CONSTANTS, NEVER BUILT FROM THE RECORD. The label says
 * "AllMusic artist", not the artist's name: that same four-act credit made a
 * chip six lines deep, and because the row is a grid with one shared height,
 * the one tall chip turned the rest into circles.
 */

// --- services --------------------------------------------------------------
// The names live HERE and nowhere else. The Settings screen lists what CAN be
// shown when there is no album to link to, so it reads this table too — and
// the test asserts the two agree, so a service added to one and not the other
// fails a test rather than appearing in Settings with no chip behind it.
const SERVICES = [
  { id: "qobuz",    name: "Qobuz" },
  { id: "tidal",    name: "TIDAL" },
  { id: "spotify",  name: "Spotify" },
  { id: "apple",    name: "Apple Music" },
  { id: "amazon",   name: "Amazon Music" },
  { id: "deezer",   name: "Deezer" },
  { id: "bandcamp", name: "Bandcamp" },
];

// --- review sources --------------------------------------------------------
// `kind` picks which half of the record the link is about; `chip` says which,
// because both AllMusic entries can be on at once and "AllMusic" twice would
// be a coin toss. The artist pair is off by default: it is a second row of
// chips about somebody rather than about this record.
const REVIEWS = [
  { id: "wikipedia",        name: "Wikipedia", kind: "album",  chip: "Wikipedia",        onByDefault: true  },
  { id: "pitchfork",        name: "Pitchfork", kind: "album",  chip: "Pitchfork",        onByDefault: true  },
  { id: "allmusic",         name: "AllMusic",  kind: "album",  chip: "AllMusic",         onByDefault: true  },
  { id: "wikipedia-artist", name: "Wikipedia", kind: "artist", chip: "Wikipedia artist", onByDefault: false },
  { id: "allmusic-artist",  name: "AllMusic",  kind: "artist", chip: "AllMusic artist",  onByDefault: false },
];

const SERVICE_IDS = SERVICES.map(s => s.id);
const REVIEW_IDS  = REVIEWS.map(r => r.id);

// Qobuz's own country switcher, in its order. Rule 4.
const QOBUZ_STOREFRONTS = [
  "ar-es", "at-de", "au-en", "be-fr", "be-nl", "br-pt", "ca-en", "ca-fr",
  "ch-de", "ch-fr", "cl-es", "co-es", "de-de", "dk-en", "es-es", "fi-en",
  "fr-fr", "gb-en", "ie-en", "it-it", "jp-ja", "lu-de", "lu-fr", "mx-es",
  "nl-nl", "no-en", "nz-en", "pt-pt", "se-en", "us-en",
];
const QOBUZ_DEFAULT_STORE = "us-en";

/*
 * The first credited act. Rule 3.
 *
 * The separator set is the Share Card app's, adopted verbatim rather than
 * re-derived, because which characters separate a list from a name is decided
 * by real credits and not by reasoning:
 *
 *   A SLASH ONLY WHEN IT IS SPACED on at least one side. "Getz / Tjader" is
 *   two people; "AC/DC" is one band, and no rule that splits it can be right.
 *
 *   A SEMICOLON always — nothing is named with one.
 *
 *   feat. / ft. / featuring, which is what they are for.
 *
 *   NOT A COMMA AND NOT AN AMPERSAND, however tempting. "Emerson, Lake &
 *   Palmer", "Hall & Oates", "Crosby, Stills, Nash & Young" and "Simon &
 *   Garfunkel" are all one act, and mangling a band name finds nothing at
 *   all — whereas leaving a genuine two-artist credit whole usually still
 *   finds the record. The asymmetry is the whole argument.
 *
 * (index.js carries two older inline versions of this idea with different
 * rules — one splits on "/,&" and feat., the other on " / " alone. Both are
 * load-bearing where they are and are left alone here.)
 */
const CREDIT_SEPARATOR = /\s+\/\s*|\s*\/\s+|\s*;\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i;

function primaryArtist(artist) {
  const whole = String(artist == null ? "" : artist).trim();
  if (!whole) return "";
  const first = String(whole.split(CREDIT_SEPARATOR)[0] || "").trim();
  // A credit that BEGINS with a separator would leave nothing at all, and no
  // name is better answered by an empty search box than by the whole string.
  return first || whole;
}

/*
 * "act album", percent-encoded — or null when there is nothing worth
 * searching for, which is the same condition under which the card is not
 * drawn. Rules 1, 2 and 3 all land here.
 */
function searchQuery(artist, album) {
  const act = primaryArtist(artist);
  const words = `${act} ${album == null ? "" : album}`
    .replace(/[/\\]/g, " ")        // rule 2 — spent, not encoded
    .trim()
    .replace(/\s+/g, " ");
  if (!words) return null;
  // encodeURIComponent already writes %20 for a space (rule 1) and leaves
  // !'()* alone, which every search box here accepts.
  return encodeURIComponent(words);
}

/*
 * The Qobuz storefront for a locale tag such as "en-GB" or "fr". An exact
 * country-language match wins; failing that any storefront in the same country
 * (which settles a device set to English in Belgium); failing that us-en,
 * where qobuz.com sends a visitor it cannot place.
 */
function qobuzStorefront(locale) {
  const tag = String(locale == null ? "" : locale).trim().toLowerCase();
  if (!tag) return QOBUZ_DEFAULT_STORE;
  const parts = tag.split(/[-_]/);
  const language = parts[0] || "";
  // "en-GB" → country "gb"; a bare "fr" has no country, so the language
  // doubles as one, which is right for fr/de/it/es and harmless otherwise.
  const country = (parts.length > 1 ? parts[parts.length - 1] : language).replace(/[^a-z]/g, "");
  if (!country) return QOBUZ_DEFAULT_STORE;
  const exact = `${country}-${language}`;
  if (QOBUZ_STOREFRONTS.includes(exact)) return exact;
  return QOBUZ_STOREFRONTS.find(s => s.startsWith(`${country}-`)) || QOBUZ_DEFAULT_STORE;
}

/**
 * Parse an Accept-Language header into the best locale tag, or "" for none.
 * The server has no device locale of its own, and this is the closest thing
 * the request carries.
 */
function localeFromAcceptLanguage(header) {
  const s = String(header == null ? "" : header).trim();
  if (!s) return "";
  let best = null;
  for (const part of s.split(",")) {
    const [tagRaw, ...params] = part.trim().split(";");
    const tag = tagRaw.trim();
    if (!tag || tag === "*") continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = parseFloat(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (!best || q > best.q) best = { tag, q };
  }
  return best ? best.tag : "";
}

function serviceUrl(id, query, storefront) {
  switch (id) {
    // The trailing slash on "/search/" is Qobuz's: without it they 301 to it.
    case "qobuz":    return `https://www.qobuz.com/${storefront}/search/?q=${query}`;
    case "tidal":    return `https://tidal.com/search?q=${query}`;
    case "spotify":  return `https://open.spotify.com/search/${query}`;
    case "apple":    return `https://music.apple.com/search?term=${query}`;   // no storefront — rule 4
    case "amazon":   return `https://music.amazon.com/search/${query}`;
    case "deezer":   return `https://www.deezer.com/search/${query}`;
    // item_type=a keeps the results to albums rather than mixing in tracks
    // and artists. An unknown parameter there is ignored rather than fatal.
    case "bandcamp": return `https://bandcamp.com/search?q=${query}&item_type=a`;
    default:         return null;
  }
}

/**
 * Where to hear this record, in the order the row shows them.
 *
 * @param {string} artist   the credit as it came off the record
 * @param {string} album    the album title
 * @param {object} [opts]
 * @param {string} [opts.locale]   a locale tag; picks the Qobuz storefront
 * @param {string[]} [opts.enabled] service ids to include (default: all)
 * @returns {{id:string,name:string,url:string}[]} empty when there is nothing
 *          worth searching for
 */
function serviceLinks(artist, album, opts) {
  const o = opts || {};
  const query = searchQuery(artist, album);
  if (!query) return [];
  const storefront = qobuzStorefront(o.locale);
  const allow = o.enabled ? new Set(o.enabled) : null;
  const out = [];
  for (const s of SERVICES) {
    if (allow && !allow.has(s.id)) continue;
    const url = serviceUrl(s.id, query, storefront);
    if (url) out.push({ id: s.id, name: s.name, url });
  }
  return out;
}

/**
 * Where to read about it.
 *
 * Wikipedia and Pitchfork take a RESOLVED url when one is known — the extras
 * pipeline has usually already found the actual article and the actual review,
 * and a link to the thing beats a link to a search for it. Without one they
 * fall back to a search, because a chip that is present and lands on a search
 * page is better than a chip that comes and goes depending on what a scraper
 * managed.
 *
 * @param {string} artist
 * @param {string} album
 * @param {object} [opts]
 * @param {string[]} [opts.enabled]        review ids to include (default: the
 *                                         three album sources)
 * @param {string} [opts.wikipediaUrl]     resolved article for the album
 * @param {string} [opts.pitchforkUrl]     resolved review
 * @param {string} [opts.wikipediaArtistUrl] resolved article for the artist
 * @returns {{id:string,name:string,chip:string,kind:string,url:string}[]}
 */
function reviewLinks(artist, album, opts) {
  const o = opts || {};
  const query = searchQuery(artist, album);
  if (!query) return [];
  // The artist goes in the ARTIST slot, not the album one: that is the
  // argument primaryArtist() runs over. Passed as the album it skips the rule,
  // and a four-act credit searches for all four names at once.
  const artistQuery = searchQuery(artist, "");
  const allow = new Set(o.enabled || REVIEWS.filter(r => r.onByDefault).map(r => r.id));

  const urlFor = (id) => {
    switch (id) {
      case "wikipedia":
        return o.wikipediaUrl ||
          `https://en.wikipedia.org/w/index.php?search=${query}`;
      case "pitchfork":
        return o.pitchforkUrl ||
          `https://pitchfork.com/search/?q=${query}`;
      case "allmusic":
        return `https://www.allmusic.com/search/albums/${query}`;
      case "wikipedia-artist":
        return artistQuery
          ? (o.wikipediaArtistUrl || `https://en.wikipedia.org/w/index.php?search=${artistQuery}`)
          : null;
      case "allmusic-artist":
        return artistQuery ? `https://www.allmusic.com/search/artists/${artistQuery}` : null;
      default:
        return null;
    }
  };

  const out = [];
  for (const r of REVIEWS) {
    if (!allow.has(r.id)) continue;
    const url = urlFor(r.id);
    if (url) out.push({ id: r.id, name: r.name, chip: r.chip, kind: r.kind, url });
  }
  return out;
}

/** The ids this app knows, for a stored set to be checked against. */
function knownServiceIds() { return SERVICE_IDS.slice(); }
function knownReviewIds()  { return REVIEW_IDS.slice(); }

/**
 * Keep only ids this build knows, preserving the table's order rather than the
 * stored order. A stored set outliving the service it names is the ordinary
 * case after an update, not an error.
 */
function sanitiseIds(ids, known) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  return known.filter(id => want.has(id));
}

/** The default sets, for a fresh install and for a settings reset. */
function defaultServiceIds() { return SERVICE_IDS.slice(); }
function defaultReviewIds()  { return REVIEWS.filter(r => r.onByDefault).map(r => r.id); }

module.exports = {
  SERVICES, REVIEWS,
  primaryArtist, searchQuery, qobuzStorefront, localeFromAcceptLanguage,
  serviceLinks, reviewLinks,
  knownServiceIds, knownReviewIds, sanitiseIds,
  defaultServiceIds, defaultReviewIds,
};
