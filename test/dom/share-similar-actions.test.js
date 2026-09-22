"use strict";
// ---------------------------------------------------------------------------
// v1.8.35: a suggestion is somewhere to GO.
//
// They were plain text. Reported, fairly: a suggestion you cannot act on is
// half a feature. Each row now does one of two things, and which one is
// visible before it is tapped:
//
//   in the Roon library -> queues it;
//   not in the library  -> opens the DEFAULT streaming service's search.
//
// The default is a per-device preference (localStorage), set by holding a
// service chip — the Share Card app's gesture — or from Settings.
//
// What matters here and nowhere else: the queue must send the LIBRARY's title
// and artist, not Deezer's. /api/play relocates a drifted offset rather than
// playing whatever now sits at it, and that guarantee is worth nothing if the
// caller does not send the identity to check against.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const SERVICES = [
  { id: "qobuz",   name: "Qobuz",   url: "https://www.qobuz.com/gb-en/search/?q=Brian%20Eno" },
  { id: "tidal",   name: "TIDAL",   url: "https://tidal.com/search?q=Brian%20Eno" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/search/Brian%20Eno" },
];

const ACTS = [
  // In the library: the LIBRARY's spelling differs from Deezer's on purpose.
  { name: "Brian Eno", album: "Here Come the Warm Jets", year: 1974,
    in_library: true, offset: 42,
    library_title: "Here Come The Warm Jets", library_subtitle: "Brian Eno", services: [] },
  // Not in the library.
  { name: "Iggy Pop", album: "The Idiot", year: 1977,
    in_library: false, offset: null, library_title: null, library_subtitle: null,
    services: SERVICES },
  // No record could be named — still worth showing, nothing to link to.
  { name: "Kraftwerk", album: null, year: null,
    in_library: false, offset: null, services: [] },
];

const EXTRAS = { year: 1977, album: null, artist: null,
                 links: { services: SERVICES, reviews: [] } };

function stubFor(pref) {
  return `
window.__plays = [];
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.setItem("zone", "z1");
  ${pref ? `localStorage.setItem("musicd-share-service", ${JSON.stringify(pref)});` : ""}
} catch (e) {}
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/play") > -1 && opts && opts.method === "POST") {
    window.__plays.push(JSON.parse(opts.body || "{}"));
    return window.__json({ ok: true, action: "Queue", offset: 42 });
  }
  if (u.indexOf("/api/similar") > -1)    return window.__json({ acts: ${JSON.stringify(ACTS)} });
  if (u.indexOf("/api/album/extras") > -1) return window.__json(${JSON.stringify(EXTRAS)});
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Room", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(700);
  if (document.fonts) document.fonts.load = function () { return Promise.resolve([]); };
  window.FileReader = function () {
    this.readAsDataURL = function () {
      this.result = "data:image/png;base64,AA==";
      var self = this;
      setTimeout(function () { if (self.onload) self.onload(); }, 0);
    };
  };
  ShareCard.render = function () {
    return Promise.resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
  };
  async function until(what, fn) {
    for (var i = 0; i < 600; i++) { if (fn()) return true; await window.__sleep(25); }
    T("TIMED_OUT_WAITING_FOR", what);
    return false;
  }
  var rowsSel = "#share-similar-list .share-similar-act";

  window.__openShareCard({ title: "Low", artist: "David Bowie", image_key: "k0" });
  await until("the suggestions", function () { return document.querySelectorAll(rowsSel).length; });

  var rows = Array.prototype.slice.call(document.querySelectorAll(rowsSel));
  // These rows share their builder with the Discover screen, which DOES carry
  // artwork. Carrying none here is an older and separate decision about a
  // compact list inside a sheet.
  T("any_art", !!document.querySelector("#share-similar-list .row-art"));
  T("rows", rows.map(function (r) {
    return { tag: r.tagName, cls: r.className,
             href: r.getAttribute("href"), target: r.getAttribute("target"),
             label: (r.querySelector(".share-similar-name") || {}).textContent || "",
             badge: (r.querySelector(".share-similar-tag") || {}).textContent || null };
  }));

  // ---- tapping the one that IS in the library queues it ----
  rows[0].click();
  await until("the queue call", function () { return window.__plays.length > 0; });
  T("play_body", window.__plays[0]);
  await window.__sleep(120);
  T("badge_after", (rows[0].querySelector(".share-similar-tag") || {}).textContent || null);

  // ---- the default service decides where the other row goes ----
  T("default_href", rows[1].getAttribute("href"));
  var chips = Array.prototype.slice.call(document.querySelectorAll("#share-links a[data-service]"));
  T("chip_ids", chips.map(function (c) { return c.dataset.service; }));
  T("ticked", chips.filter(function (c) { return c.classList.contains("is-default"); })
                   .map(function (c) { return c.dataset.service; }));

  // Holding a chip changes it — the Share Card app's gesture.
  var tidal = chips.filter(function (c) { return c.dataset.service === "tidal"; })[0];
  tidal.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
  await window.__sleep(250);
  T("stored_after_hold", (function () { try { return localStorage.getItem("musicd-share-service"); } catch (e) { return null; } })());
  var rows2 = Array.prototype.slice.call(document.querySelectorAll(rowsSel));
  T("href_after_hold", rows2[1].getAttribute("href"));
  T("ticked_after_hold", Array.prototype.slice.call(document.querySelectorAll("#share-links a[data-service]"))
      .filter(function (c) { return c.classList.contains("is-default"); })
      .map(function (c) { return c.dataset.service; }));
`;

function render(pref) {
  const r = harness.renderPage({ stub: stubFor(pref), driver: DRIVER,
                                 name: "share-similar-actions", windowSize: "390x900",
                                 budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

test("a suggestion is somewhere to go", { concurrency: 1 }, async (t) => {
  await t.test("each row says what a tap will do, before it is tapped", () => {
    const r = render(null);
    assert.equal(r.rows.length, 3);

    // In the library: a button, badged Queue.
    assert.equal(r.rows[0].tag, "BUTTON", "a library row should be a button, not a link");
    assert.match(r.rows[0].cls, /is-library/);
    assert.equal(r.rows[0].badge, "Queue");
    assert.equal(r.rows[0].href, null, "a library row must not navigate anywhere");

    // Not in the library: a link to a service, badged with its name.
    assert.equal(r.rows[1].tag, "A");
    assert.match(r.rows[1].cls, /is-service/);
    assert.equal(r.rows[1].target, "_blank");
    assert.equal(r.rows[1].badge, "Qobuz");

    // Nothing to link to: not a control at all.
    assert.equal(r.rows[2].tag, "DIV", "a row with nowhere to go must not look tappable");
    assert.equal(r.rows[2].badge, null);
  });

  await t.test("the suggestions carry no artwork", () => {
    // v1.8.39 gave the shared row builder an optional cover for the Discover
    // screen. These rows must not have picked one up with it: they are a
    // compact list inside a sheet, which is why they never had one.
    const r = render(null);
    assert.equal(r.any_art, false,
      "a suggestion row grew an album cover");
  });

  await t.test("the library row queues, with the LIBRARY's identity", () => {
    const r = render(null);
    assert.ok(r.play_body, "tapping the library row did not call /api/play");
    assert.equal(r.play_body.kind, "queue");
    assert.equal(r.play_body.offset, 42);
    assert.equal(r.play_body.zone_or_output_id, "z1");
    // THE POINT: Deezer says "Here Come the Warm Jets", the library says "The".
    // /api/play checks the identity against what sits at the offset, so it has
    // to be sent the library's spelling or the check rejects a correct play.
    assert.equal(r.play_body.title, "Here Come The Warm Jets",
      "the queue sent Deezer's title instead of the library's — /api/play compares " +
      "it against what is at the offset, so this relocates or refuses a play that " +
      "is actually correct");
    assert.equal(r.play_body.subtitle, "Brian Eno");
    assert.equal(r.badge_after, "Queued", "the row did not confirm what it did");
  });

  await t.test("the default service decides where a non-library row goes", () => {
    const r = render(null);
    // Nothing stored: the first ENABLED service, not a hardcoded name.
    assert.match(r.default_href, /qobuz\.com/);
    assert.deepEqual(r.ticked, ["qobuz"], "exactly one chip carries the tick");

    const chosen = render("spotify");
    assert.match(chosen.default_href, /open\.spotify\.com/,
      "a stored default was ignored — the row still points at " + chosen.default_href);
    assert.deepEqual(chosen.ticked, ["spotify"]);
  });

  await t.test("holding a chip changes the default, and the row follows", () => {
    const r = render(null);
    assert.equal(r.stored_after_hold, "tidal", "the hold did not record a choice");
    assert.match(r.href_after_hold, /tidal\.com/,
      "the suggestion still points at the old service after the default changed");
    assert.deepEqual(r.ticked_after_hold, ["tidal"], "the tick did not move");
  });
});
