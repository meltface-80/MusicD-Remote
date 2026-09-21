"use strict";
// ---------------------------------------------------------------------------
// v1.8.37: Discover — new records by the acts you play.
//
// The screen answers the one question this app could not: has anyone I
// actually listen to put something out. Its rows are the share card's
// suggestion rows — same builder, same rules about where a tap goes — so what
// is worth pinning here is what is DIFFERENT:
//
//   the RECORD is the headline and the act is the quiet line (you already know
//   the act — that is the premise of the screen);
//   the quiet line carries a DISTANCE IN TIME, not a year, because a screen
//   about what is new has to tell last week from ten months ago;
//   an empty screen says WHICH kind of empty it is: still looking, found
//   nothing, or switched off. Those need three different responses from the
//   person reading it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const SERVICES = [
  { id: "qobuz",   name: "Qobuz",   url: "https://www.qobuz.com/gb-en/search/albums/New%20One" },
  { id: "tidal",   name: "TIDAL",   url: "https://tidal.com/search?q=New%20One" },
];

// Dates are written relative to the browser's own clock, so the test says what
// it means ("three days ago") rather than pinning a calendar date that goes
// stale. The page is asked for them at render time.
const DATES = `
  function ago(days) {
    var d = new Date(Date.now() - days * 86400000);
    var p = function (n) { return n < 10 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
`;

function stub(payload, extra) {
  return `
${DATES}
window.__plays = [];
window.__qobuzAsks = [];
try { localStorage.setItem("rra-zone", "z1"); localStorage.setItem("zone", "z1"); } catch (e) {}
${extra || ""}
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/play") > -1 && opts && opts.method === "POST") {
    window.__plays.push(JSON.parse(opts.body || "{}"));
    return window.__json({ ok: true, action: "Queue", offset: 7 });
  }
  if (u.indexOf("/api/qobuz-link") > -1) {
    window.__qobuzAsks.push(u);
    // Held back on purpose in the upgrade test. "The row is drawn first" is
    // not observable against an answer that arrives instantly — the poll that
    // waits for the row also gives the upgrade time to land, and the
    // assertion then passes whichever order they happened in.
    if (window.__slowLink) {
      return new Promise(function (r) {
        setTimeout(function () { r(window.__json({ url: "https://open.qobuz.com/album/abc123" })); }, 900);
      });
    }
    return window.__json({ url: "https://open.qobuz.com/album/abc123" });
  }
  if (u.indexOf("/api/discover") > -1)   return window.__json(${payload});
  if (u.indexOf("/api/settings/discover") > -1) return window.__json({ enabled: true, hour: 5 });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Room", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

const ROWS_SEL = ".discover-list .share-similar-act";

const DRIVER = `
  await window.__sleep(500);
  async function until(what, fn) {
    for (var i = 0; i < 600; i++) { if (fn()) return true; await window.__sleep(25); }
    T("TIMED_OUT_WAITING_FOR", what);
    return false;
  }
  window.__showDiscover();
  await until("the screen to settle", function () {
    return document.querySelectorAll("${ROWS_SEL}").length ||
           (document.getElementById("status-banner") &&
            !document.getElementById("status-banner").classList.contains("hidden"));
  });
  var rows = Array.prototype.slice.call(document.querySelectorAll("${ROWS_SEL}"));
  T("rows", rows.map(function (r) {
    return { tag: r.tagName, cls: r.className, href: r.getAttribute("href"),
             head: (r.querySelector(".share-similar-name") || {}).textContent || "",
             sub:  (r.querySelector(".share-similar-rec")  || {}).textContent || "",
             badge:(r.querySelector(".share-similar-tag")  || {}).textContent || null };
  }));
  var b = document.getElementById("status-banner");
  T("banner", b && !b.classList.contains("hidden") ? b.textContent : null);
  T("title", (document.getElementById("album-count") || {}).textContent || "");
`;

const QUEUE_DRIVER = DRIVER + `
  var libRow = rows.filter(function (r) { return /is-library/.test(r.className); })[0];
  if (libRow) {
    libRow.click();
    await until("the queue call", function () { return window.__plays.length > 0; });
    T("play_body", window.__plays[0]);
  }
`;

// The upgrade is NOT polled for with a loop of short sleeps. Virtual time
// fast-forwards timers, so a poll can burn its whole budget while the real
// round trip it is waiting for has not happened — the v1.8.34 flake, exactly.
// One long sleep gives the page real room, which is what the qobuz-deeplink
// driver does for the same reason. Reading the href at BOTH moments also pins
// the property that matters: the row is on screen first, upgraded second.
const QOBUZ_DRIVER = DRIVER + `
  var svcSel = "${ROWS_SEL}.is-service";
  var svcHref = function () {
    var a = document.querySelector(svcSel);
    return a ? a.getAttribute("href") : null;
  };
  T("href_when_drawn", svcHref());
  T("asked_when_drawn", window.__qobuzAsks.length);
  await window.__sleep(1500);
  T("href_after", svcHref());
  T("asked", window.__qobuzAsks.length);
`;

function render(payload, opts) {
  opts = opts || {};
  const r = harness.renderPage({
    stub: stub(payload, opts.extra), driver: opts.driver || DRIVER,
    name: "discover", windowSize: "390x900", budgetMs: 45000,
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

// A payload built in the page so the dates are relative to its clock.
function payload(body) { return body; }

const THREE_ROWS = payload(`{
  enabled: true, day: "today", window_days: 60, building: false,
  releases: [
    { artist: "Boards of Canada", album: "New One", cover: null,
      release_date: ago(3), year: null, in_library: false, offset: null,
      library_title: null, library_subtitle: null,
      services: ${JSON.stringify(SERVICES)} },
    { artist: "Low", album: "Owned Record", cover: null,
      release_date: ago(20), year: null, in_library: true, offset: 7,
      library_title: "Owned Record (Deluxe)", library_subtitle: "Low", services: [] },
    { artist: "Autechre", album: "Nowhere To Go", cover: null,
      release_date: ago(0), year: null, in_library: false, offset: null,
      library_title: null, library_subtitle: null, services: [] }
  ]
}`);

test("Discover", { concurrency: 1 }, async (t) => {

  await t.test("the RECORD is the headline and the act is the quiet line", () => {
    const r = render(THREE_ROWS);
    assert.equal(r.rows.length, 3);
    // The whole premise of the screen is that you already know the act, so the
    // album has to be the thing you read first. The suggestions row under the
    // share card is the other way round on purpose, and they share a builder —
    // so this is exactly the property a shared builder could silently lose.
    assert.equal(r.rows[0].head, "New One");
    assert.match(r.rows[0].sub, /^Boards of Canada · /,
      "the artist should lead the quiet line: " + r.rows[0].sub);
  });

  await t.test("the quiet line dates a release in DAYS, not in years", () => {
    const r = render(THREE_ROWS);
    // "2026" reads identically for everything released in the first eleven
    // months of a year, on a screen whose entire subject is what is new.
    assert.match(r.rows[0].sub, /3 days ago$/, r.rows[0].sub);
    assert.match(r.rows[1].sub, /2 weeks ago$/, r.rows[1].sub);
    assert.match(r.rows[2].sub, /today$/, r.rows[2].sub);
  });

  await t.test("each row still says what a tap will do", () => {
    const r = render(THREE_ROWS);
    assert.equal(r.rows[0].tag, "A", "a row with a service should be a link");
    assert.match(r.rows[0].cls, /is-service/);
    assert.equal(r.rows[0].badge, "Qobuz");

    assert.equal(r.rows[1].tag, "BUTTON", "a row in the library should queue, not navigate");
    assert.match(r.rows[1].cls, /is-library/);
    assert.equal(r.rows[1].badge, "Queue");
    assert.equal(r.rows[1].href, null);

    // Every service switched off: shown, because the record is still the news,
    // but not dressed as a control that does nothing.
    assert.equal(r.rows[2].tag, "DIV");
    assert.equal(r.rows[2].badge, null);
  });

  await t.test("queueing sends the LIBRARY's identity, not Deezer's", () => {
    const r = render(THREE_ROWS, { driver: QUEUE_DRIVER });
    assert.ok(r.play_body, "tapping the library row did not call /api/play");
    assert.equal(r.play_body.kind, "queue");
    assert.equal(r.play_body.offset, 7);
    // /api/play compares the identity against what sits at the offset and
    // relocates or refuses when they disagree. Deezer calls this record
    // "Owned Record"; Roon files it with an edition suffix.
    assert.equal(r.play_body.title, "Owned Record (Deluxe)",
      "sent Deezer's title, so a correct play would be refused as a stale offset");
    assert.equal(r.play_body.subtitle, "Low");
  });

  await t.test("the Qobuz link is upgraded to one that opens the app", () => {
    const r = render(THREE_ROWS, { driver: QOBUZ_DRIVER, extra: "window.__slowLink = true;" });
    // A Qobuz SEARCH url opens their download store and never the app — only
    // an album id does. See lib/qobuz-deeplink.js.
    assert.match(r.href_when_drawn, /^https:\/\/www\.qobuz\.com\//,
      "the row waited on the lookup before being drawn: " + r.href_when_drawn);
    assert.equal(r.href_after, "https://open.qobuz.com/album/abc123");
    // Only the row that HAS a Qobuz link and is not in the library is asked
    // about — one call, not three.
    assert.equal(r.asked, 1, "asked about " + r.asked + " rows");
  });

  await t.test("still looking and found nothing are different answers", () => {
    const building = render(payload(
      `{ enabled: true, day: "today", window_days: 60, building: true, releases: [] }`));
    assert.equal(building.rows.length, 0);
    assert.match(building.banner || "", /come back shortly/i,
      "a build in progress should invite a second look: " + building.banner);

    const empty = render(payload(
      `{ enabled: true, day: "today", window_days: 60, building: false, releases: [] }`));
    assert.match(empty.banner || "", /Nothing new/i, empty.banner);
    // The window is quoted from the server rather than written into the copy,
    // so the sentence cannot outlive the number it describes.
    assert.match(empty.banner || "", /60 days/, empty.banner);
    assert.doesNotMatch(empty.banner || "", /come back shortly/i,
      "'nothing found' must not read as 'still working'");
  });

  await t.test("switched off says so, and says where to switch it on", () => {
    const r = render(payload(
      `{ enabled: false, day: null, window_days: 60, building: false, releases: [] }`));
    assert.match(r.banner || "", /switched off/i, r.banner);
    assert.match(r.banner || "", /Settings/, "a dead end without the way out: " + r.banner);
  });

  await t.test("a 503 while pairing keeps its own explanation", () => {
    // The generic message would throw away the one thing that says what to do.
    const r = render(payload(`{ error: "Not paired with Roon Core yet" }`));
    assert.match(r.banner || "", /Not paired with Roon Core yet/, r.banner);
  });

  await t.test("the screen is titled, so Back has something to go back from", () => {
    const r = render(THREE_ROWS);
    assert.match(r.title, /Discover/);
  });
});
