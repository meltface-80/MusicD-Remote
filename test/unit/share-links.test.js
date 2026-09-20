"use strict";
// ---------------------------------------------------------------------------
// v1.8.28: the links under the share card, ported from MusicD Share Card.
//
// Every rule in lib/share-links.js looks arbitrary and is not — each one was
// a link that 404'd or searched for the wrong thing. This file is where they
// stop being comments. Pure functions, no network, no Core.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../lib/share-links");

test("rule 1 — a space is %20, never +", () => {
  // Four of these take the query as a PATH segment, where "+" is not a space
  // and gets searched for literally.
  const q = L.searchQuery("Talking Heads", "Remain in Light");
  assert.equal(q, "Talking%20Heads%20Remain%20in%20Light");
  assert.ok(!q.includes("+"), "the query contains a + : " + q);

  for (const link of L.serviceLinks("Talking Heads", "Remain in Light", { enabled: L.knownServiceIds() })) {
    assert.ok(!/\+/.test(link.url), link.id + " encoded a space as + : " + link.url);
  }
});

test("rule 1 — a real plus survives, and so do & # and quotes", () => {
  assert.equal(L.searchQuery("Sunn O)))", "White1").includes("+"), false);
  const q = L.searchQuery("Godspeed You! Black Emperor", "F# A# ∞");
  assert.ok(q.includes("%23"), "the # was not encoded: " + q);
  // "Hall & Oates" is ONE act (see primaryArtist), so the ampersand survives
  // into the query — and must reach the URL encoded, or it ends the parameter.
  const amp = L.searchQuery("Hall & Oates", "Abandoned Luncheonette");
  assert.ok(amp.includes("%26"), "the & was not encoded: " + amp);
  assert.ok(!amp.includes("&"), "a raw & reached the URL: " + amp);
});

test("rule 2 — a slash is spent as a space, not encoded (AC/DC)", () => {
  const q = L.searchQuery("AC/DC", "Back in Black");
  assert.equal(q, "AC%20DC%20Back%20in%20Black");
  assert.ok(!q.includes("%2F"), "the slash was encoded rather than spent: " + q);
  for (const link of L.serviceLinks("AC/DC", "Back in Black", { enabled: L.knownServiceIds() })) {
    assert.ok(!/%2f/i.test(link.url), link.id + " carries an encoded slash: " + link.url);
  }
  // A backslash the same way — it reaches a path segment just as happily.
  assert.equal(L.searchQuery("AC\\DC", "Back in Black"), "AC%20DC%20Back%20in%20Black");
});

test("rule 3 — only the first credited act goes in the search box", () => {
  // The credit that started it: AllMusic answered "no such act exists".
  const credit = "Stan Getz / Cal Tjader / Alan Jay Lerner / Frederick Loewe";
  assert.equal(L.primaryArtist(credit), "Stan Getz");
  const q = L.searchQuery(credit, "Sextet");
  assert.equal(q, "Stan%20Getz%20Sextet");
  assert.ok(!q.includes("Tjader"), "a second act reached the query: " + q);

  assert.equal(L.primaryArtist("Drake feat. Rihanna"), "Drake");
  assert.equal(L.primaryArtist("Drake ft. Rihanna"), "Drake");
  assert.equal(L.primaryArtist("Drake featuring Rihanna"), "Drake");
  assert.equal(L.primaryArtist("Bowie; Eno"), "Bowie");
  assert.equal(L.primaryArtist("Getz/ Tjader"), "Getz", "a slash spaced on one side still separates");

  // The other half of the rule, and the more important half: a comma and an
  // ampersand are NOT separators, because these are all one act. Mangling a
  // band name finds nothing; leaving a genuine two-artist credit whole usually
  // still finds the record.
  assert.equal(L.primaryArtist("AC/DC"), "AC/DC");
  assert.equal(L.primaryArtist("Hall & Oates"), "Hall & Oates");
  assert.equal(L.primaryArtist("Simon & Garfunkel"), "Simon & Garfunkel");
  assert.equal(L.primaryArtist("Emerson, Lake & Palmer"), "Emerson, Lake & Palmer");
  assert.equal(L.primaryArtist("Crosby, Stills, Nash & Young"), "Crosby, Stills, Nash & Young");

  // A credit that BEGINS with a separator must not leave an empty search box.
  assert.equal(L.primaryArtist("/ Leading"), "/ Leading");
  assert.equal(L.primaryArtist("; "), ";", "the fallback returns the TRIMMED whole credit");
});

test("rule 4 — Qobuz always has a storefront, Apple never does", () => {
  const links = L.serviceLinks("Bowie", "Low", { locale: "en-GB", enabled: L.knownServiceIds() });
  const by = Object.fromEntries(links.map(l => [l.id, l.url]));

  assert.ok(by.qobuz.startsWith("https://www.qobuz.com/gb-en/search/?q="),
    "Qobuz got the wrong storefront: " + by.qobuz);
  assert.ok(!/^https:\/\/www\.qobuz\.com\/search/.test(by.qobuz),
    "a storefront-less Qobuz URL is a 404: " + by.qobuz);
  assert.ok(by.qobuz.includes("/search/?q="), "Qobuz's trailing slash is theirs — without it they 301");

  assert.equal(by.apple, "https://music.apple.com/search?term=Bowie%20Low",
    "Apple must NOT be given a storefront — they redirect to the visitor's own");
});

test("the Qobuz storefront table is consulted, not constructed", () => {
  assert.equal(L.qobuzStorefront("en-GB"), "gb-en");
  assert.equal(L.qobuzStorefront("fr-FR"), "fr-fr");
  assert.equal(L.qobuzStorefront("ja-JP"), "jp-ja");
  // English in Belgium: no be-en exists, so any Belgian storefront beats none.
  assert.ok(["be-fr", "be-nl"].includes(L.qobuzStorefront("en-BE")),
    "en-BE fell through to the default instead of a Belgian storefront");
  // A country Qobuz does not sell in 404s, so it must land on the default.
  assert.equal(L.qobuzStorefront("en-IN"), "us-en");
  assert.equal(L.qobuzStorefront(""), "us-en");
  assert.equal(L.qobuzStorefront(undefined), "us-en");
  assert.equal(L.qobuzStorefront("fr"), "fr-fr", "a bare language should still find its store");
});

test("Accept-Language is read for the locale, highest q wins", () => {
  assert.equal(L.localeFromAcceptLanguage("en-GB,en;q=0.9,fr;q=0.8"), "en-GB");
  assert.equal(L.localeFromAcceptLanguage("fr;q=0.5,de-DE;q=0.9"), "de-DE");
  assert.equal(L.localeFromAcceptLanguage("*"), "");
  assert.equal(L.localeFromAcceptLanguage(""), "");
  assert.equal(L.localeFromAcceptLanguage(undefined), "");
  // End to end: a British browser gets the British Qobuz store.
  assert.equal(L.qobuzStorefront(L.localeFromAcceptLanguage("en-GB,en;q=0.9")), "gb-en");
});

test("nothing worth searching for yields no links at all", () => {
  assert.equal(L.searchQuery("", ""), null);
  assert.equal(L.searchQuery(null, null), null);
  assert.equal(L.searchQuery("   ", "  "), null);
  assert.deepEqual(L.serviceLinks("", ""), []);
  assert.deepEqual(L.reviewLinks("", ""), []);
  // An album with no artist is still worth searching for.
  assert.equal(L.searchQuery("", "Kind of Blue"), "Kind%20of%20Blue");
  assert.ok(L.serviceLinks("", "Kind of Blue").length > 0);
});

test("the Settings list and the chips agree on ids", () => {
  // The names live in one table. The Settings screen lists what CAN be shown
  // when there is no album to link to, so it reads that table too — a service
  // added to one and not the other must fail here rather than appear in
  // Settings with no chip behind it.
  const fromLinks = L.serviceLinks("Bowie", "Low", { enabled: L.knownServiceIds() }).map(l => l.id);
  assert.deepEqual(fromLinks, L.knownServiceIds());
  for (const s of L.SERVICES) {
    assert.ok(s.id && s.name, "a service has no id or name: " + JSON.stringify(s));
  }
  const reviewIds = L.reviewLinks("Bowie", "Low", { enabled: L.knownReviewIds() }).map(l => l.id);
  assert.deepEqual(reviewIds, L.knownReviewIds());
});

test("chip labels are constants, never built from the record", () => {
  // A four-act credit made a chip six lines deep; the row is a grid with one
  // shared height, so that chip turned the ones beside it into circles.
  const credit = "Stan Getz / Cal Tjader / Alan Jay Lerner / Frederick Loewe";
  for (const l of L.reviewLinks(credit, "Sextet", { enabled: L.knownReviewIds() })) {
    assert.ok(l.chip.length <= 16, "chip label is " + l.chip.length + " chars: " + l.chip);
    assert.ok(!l.chip.includes("Getz"), "the chip label carries the artist's name: " + l.chip);
  }
  // Both AllMusic chips can be on at once, so they must not read the same.
  const both = L.reviewLinks("Bowie", "Low", { enabled: ["allmusic", "allmusic-artist"] });
  assert.equal(both.length, 2);
  assert.notEqual(both[0].chip, both[1].chip, "two AllMusic chips read identically");
});

test("review links prefer a resolved url and fall back to a search", () => {
  const resolved = L.reviewLinks("Bowie", "Low", {
    enabled: ["wikipedia", "pitchfork", "allmusic"],
    wikipediaUrl: "https://en.wikipedia.org/wiki/Low_(David_Bowie_album)",
    pitchforkUrl: "https://pitchfork.com/reviews/albums/bowie-low/",
  });
  const by = Object.fromEntries(resolved.map(l => [l.id, l.url]));
  assert.equal(by.wikipedia, "https://en.wikipedia.org/wiki/Low_(David_Bowie_album)");
  assert.equal(by.pitchfork, "https://pitchfork.com/reviews/albums/bowie-low/");
  // AllMusic has no resolver — it is always their search.
  assert.equal(by.allmusic, "https://www.allmusic.com/search/albums/Bowie%20Low");

  const bare = L.reviewLinks("Bowie", "Low", { enabled: ["wikipedia", "pitchfork"] });
  const byBare = Object.fromEntries(bare.map(l => [l.id, l.url]));
  assert.ok(byBare.wikipedia.includes("search="), "no resolved article, so it should be a search");
  assert.ok(byBare.pitchfork.includes("/search/"), "no resolved review, so it should be a search");
});

test("the artist links search for the ARTIST, not the album", () => {
  // Passed as the album it would skip primaryArtist, which is the failure this
  // exists to avoid — AllMusic's own "No search results were found".
  const links = L.reviewLinks("Stan Getz / Cal Tjader", "Sextet",
    { enabled: ["allmusic-artist", "wikipedia-artist"] });
  const by = Object.fromEntries(links.map(l => [l.id, l.url]));
  assert.equal(by["allmusic-artist"], "https://www.allmusic.com/search/artists/Stan%20Getz");
  assert.ok(!by["allmusic-artist"].includes("Sextet"), "the album reached the artist search");
  assert.ok(!by["wikipedia-artist"].includes("Sextet"), "the album reached the artist search");
});

test("with no artist, the artist links are absent rather than empty", () => {
  const links = L.reviewLinks("", "Kind of Blue", { enabled: L.knownReviewIds() });
  const ids = links.map(l => l.id);
  assert.ok(!ids.includes("allmusic-artist"), "an artist chip with no artist behind it");
  assert.ok(!ids.includes("wikipedia-artist"), "an artist chip with no artist behind it");
  assert.ok(ids.includes("allmusic"), "the album chips should still be there");
});

test("defaults: every service on, the artist review pair off", () => {
  assert.deepEqual(L.defaultServiceIds(), L.knownServiceIds());
  assert.deepEqual(L.defaultReviewIds(), ["wikipedia", "pitchfork", "allmusic"]);
  // The default set is what reviewLinks uses when nothing is stored.
  assert.deepEqual(L.reviewLinks("Bowie", "Low").map(l => l.id), L.defaultReviewIds());
});

test("a stored set outliving a service it names is ordinary, not an error", () => {
  assert.deepEqual(L.sanitiseIds(["qobuz", "napster", "tidal"], L.knownServiceIds()),
                   ["qobuz", "tidal"]);
  // The table's order, not the stored order — the row is laid out by the table.
  assert.deepEqual(L.sanitiseIds(["bandcamp", "qobuz"], L.knownServiceIds()),
                   ["qobuz", "bandcamp"]);
  assert.deepEqual(L.sanitiseIds(null, L.knownServiceIds()), []);
  assert.deepEqual(L.sanitiseIds("qobuz", L.knownServiceIds()), []);
});

test("an empty enabled set shows nothing, and is not mistaken for 'unset'", () => {
  // The difference matters: [] is "the user turned them all off", and must not
  // quietly fall back to the defaults.
  assert.deepEqual(L.serviceLinks("Bowie", "Low", { enabled: [] }), []);
  assert.deepEqual(L.reviewLinks("Bowie", "Low", { enabled: [] }), []);
});

test("every generated url parses, over a spread of awkward titles", () => {
  const cases = [
    ["AC/DC", "Back in Black"],
    ["Sigur Rós", "( )"],
    ["Godspeed You! Black Emperor", "F# A# ∞"],
    ["Panic! at the Disco", "A Fever You Can't Sweat Out"],
    ["Mötley Crüe", "Dr. Feelgood"],
    ["", "Kind of Blue"],
    ["Stan Getz / Cal Tjader", "Sextet"],
    ["Beyoncé", "4"],
    ["中島みゆき", "夜会"],
  ];
  for (const [artist, album] of cases) {
    const links = [
      ...L.serviceLinks(artist, album, { enabled: L.knownServiceIds() }),
      ...L.reviewLinks(artist, album, { enabled: L.knownReviewIds() }),
    ];
    assert.ok(links.length > 0, "no links for " + JSON.stringify([artist, album]));
    for (const l of links) {
      let u;
      assert.doesNotThrow(() => { u = new URL(l.url); },
        l.id + " built an unparseable URL for " + JSON.stringify([artist, album]) + ": " + l.url);
      assert.equal(u.protocol, "https:", l.id + " is not https: " + l.url);
      assert.ok(!/\s/.test(l.url), l.id + " left a raw space in " + l.url);
    }
  }
});
