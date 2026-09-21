"use strict";
// ---------------------------------------------------------------------------
// v1.8.34: the "If you like this" row under the share card.
//
// lib/similar.js decides WHICH acts (unit-tested). This is about the two
// properties of the row that only exist in the browser:
//
//   1. it must not make the card wait. The answer costs up to five Deezer
//      calls, and a card that appears five round trips late is a worse card;
//   2. a late answer must not land under a DIFFERENT record. The sheet can be
//      reopened on another album while the first request is still out, and
//      three acts for the previous album under the new one's card is worse
//      than no row at all — it looks authoritative and it is simply wrong.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ACTS = [
  { name: "Rose Tattoo", id: "1", album: "Rose Tattoo",   year: 1978 },
  { name: "The Angels",  id: "2", album: "The Angels",    year: 1977 },
  { name: "Buffalo",     id: "3", album: null, year: null },   // no nameable record
];

const EXTRAS = { year: 1977, album: null, artist: null, links: { services: [], reviews: [] } };

// `similarDelayMs` holds the /api/similar answer back, so the card's own
// timing can be observed independently of it.
function stubFor(similarDelayMs) {
  return `
window.__similarCalls = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u) {
  if (u.indexOf("/api/similar") > -1) {
    window.__similarCalls.push(u);
    // Whether the CARD was already painted at the moment this was asked for.
    // An ORDER fact: it does not depend on how long anything took, which is
    // the only kind of fact this harness can report reliably (virtual time
    // fast-forwards timers, and the font load and FileReader behind the card
    // do not fast-forward with them).
    window.__cardUpWhenAsked = !!document.querySelector("#share-frame img");
    // The acts NAME the artist they were asked about. Identical answers would
    // make a stale one indistinguishable from the live one — the row is
    // rebuilt rather than appended to, so a count cannot tell them apart.
    var who = decodeURIComponent((/artist=([^&]*)/.exec(u) || [])[1] || "?");
    var acts = ${JSON.stringify(ACTS)}.map(function (a, i) {
      return { name: who + " like " + (i + 1), id: String(i), album: a.album, year: a.year };
    });
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Recorded so a test can wait for an answer to have ARRIVED, rather
        // than waiting a while and hoping. "Nothing rendered" is only
        // meaningful once the thing that might have rendered is back.
        window.__resolved = (window.__resolved || []).concat(who);
        resolve(window.__json({ acts: acts }));
      }, ${similarDelayMs});
    });
  }
  if (u.indexOf("/api/album/extras") > -1) {
    // Slow for one record and instant for another, so two opens can be made to
    // finish OUT OF ORDER on purpose. Racing for that by opening twice quickly
    // is what made an earlier version of this file flaky; choosing it is
    // deterministic.
    var slow = u.indexOf("Slowcoach") > -1;
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(window.__json(${JSON.stringify(EXTRAS)})); }, slow ? 800 : 0);
    });
  }
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
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
  // The two pieces of REAL asynchronous work on this path, neutralised.
  //
  // --virtual-time-budget fast-forwards TIMERS. It does not fast-forward a
  // font load or a FileReader, and both sit between the Share tap and the card
  // appearing. Under the load of the whole DOM suite those took long enough
  // that the driver's waits ran out — the file passed alone and failed about
  // one run in eight in the suite, which is worse than not having it. Neither
  // is what any assertion here is about: the card's CONTENT is covered by
  // test/dom/share-card-data.test.js and its colours by the static test.
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

  // Wait on a CONDITION, never on the clock. --virtual-time-budget
  // fast-forwards timers, so a sleep can burn 1500 page-milliseconds while a
  // real FileReader callback has not fired — which is exactly how the first
  // version of this file passed four runs and failed the fifth.
  async function until(what, fn) {
    for (var i = 0; i < 600; i++) { if (fn()) return true; await window.__sleep(25); }
    T("TIMED_OUT_WAITING_FOR", what);
    return false;
  }
  var rowSel = "#share-similar-list .share-similar-act";
  var rowCount = function () { return document.querySelectorAll(rowSel).length; };
  var calls = function () { return window.__similarCalls.length; };

  window.__openShareCard({ title: "Runnin' Wild", artist: "Airbourne", image_key: "k0" });
  await until("the card", function () { return !!document.querySelector("#share-frame img"); });
  T("card_up", !!document.querySelector("#share-frame img"));
  T("similar_when_card_up", rowCount());
  T("similar_hidden_when_card_up", document.getElementById("share-similar").classList.contains("hidden"));

  await until("the suggestions", rowCount);
  T("card_up_when_asked", !!window.__cardUpWhenAsked);
  var rows = Array.prototype.slice.call(document.querySelectorAll(rowSel));
  T("acts", rows.map(function (r) {
    return { name: (r.querySelector(".share-similar-name") || {}).textContent || "",
             rec:  (r.querySelector(".share-similar-rec")  || {}).textContent || null };
  }));
  T("similar_visible", !document.getElementById("share-similar").classList.contains("hidden"));
  T("asked_for", window.__similarCalls.slice());

  // The close/reopen steps that used to be here went with the subtest that
  // read them: they raced two opens and the second one's request sometimes
  // never went out under the load of the whole suite. DRIVER_INFLIGHT and
  // DRIVER_OUT_OF_ORDER cover the same guards by CHOOSING the interleaving
  // instead of racing for it.

`;

// The first driver never leaves a request in flight: a superseded open returns
// before it asks, so there is nothing late to arrive. This one closes the
// sheet while the answer is genuinely out, which is the only way to exercise
// the guard inside loadSimilar and the bump in close().
const DRIVER_INFLIGHT = `
  await window.__sleep(700);
  // The two pieces of REAL asynchronous work on this path, neutralised.
  //
  // --virtual-time-budget fast-forwards TIMERS. It does not fast-forward a
  // font load or a FileReader, and both sit between the Share tap and the card
  // appearing. Under the load of the whole DOM suite those took long enough
  // that the driver's waits ran out — the file passed alone and failed about
  // one run in eight in the suite, which is worse than not having it. Neither
  // is what any assertion here is about: the card's CONTENT is covered by
  // test/dom/share-card-data.test.js and its colours by the static test.
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
  var rowCount = function () { return document.querySelectorAll("#share-similar-list .share-similar-act").length; };

  window.__openShareCard({ title: "Runnin' Wild", artist: "Airbourne", image_key: "k0" });
  // The request is OUT but has not come back yet.
  await until("the request to be issued", function () { return window.__similarCalls.length > 0; });
  T("in_flight_rows", rowCount());

  document.querySelector("#share-overlay [data-share-close]").click();
  // Wait for the answer to actually ARRIVE, then look. Waiting a fixed while
  // and hoping would make this a timing test, and timing is the one thing
  // this harness cannot report (virtual time fast-forwards timers; the font
  // load and FileReader behind the card do not go with them).
  await until("the answer to arrive", function () {
    return (window.__resolved || []).indexOf("Airbourne") > -1;
  });
  await window.__sleep(50);   // a rendering would have happened by now
  T("rows_after_close", rowCount());
  T("overlay_hidden", document.getElementById("share-overlay").classList.contains("hidden"));
  T("similar_hidden", document.getElementById("share-similar").classList.contains("hidden"));
`;

// Two opens that finish in the OPPOSITE order to the one they started in.
// The first record's extras take 800ms and the second's none, so the second
// open paints first and the first open arrives late — which is the case that
// decides whether "which open is this" is stamped when the open BEGINS or
// when its suggestion fetch is issued.
const DRIVER_OUT_OF_ORDER = `
  await window.__sleep(700);
  // The two pieces of REAL asynchronous work on this path, neutralised.
  //
  // --virtual-time-budget fast-forwards TIMERS. It does not fast-forward a
  // font load or a FileReader, and both sit between the Share tap and the card
  // appearing. Under the load of the whole DOM suite those took long enough
  // that the driver's waits ran out — the file passed alone and failed about
  // one run in eight in the suite, which is worse than not having it. Neither
  // is what any assertion here is about: the card's CONTENT is covered by
  // test/dom/share-card-data.test.js and its colours by the static test.
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
  var names = function () {
    return Array.prototype.map.call(
      document.querySelectorAll("#share-similar-list .share-similar-name"),
      function (n) { return n.textContent; });
  };

  window.__openShareCard({ title: "Old One", artist: "Slowcoach", image_key: "k0" });
  window.__openShareCard({ title: "New One", artist: "Quick",     image_key: "k1" });
  // Both opens have settled and both answers, if any, have come back.
  await until("the slow open to finish", function () {
    return (window.__resolved || []).length > 0 || window.__similarCalls.length > 0;
  });
  await until("a rendered row", function () { return names().length > 0; });
  await window.__sleep(1500);   // room for a late one to land on top, if it can

  T("asked", window.__similarCalls.map(function (u) {
    return decodeURIComponent(u).replace(/^.*artist=/, "");
  }));
  T("names", names());
`;

function renderOutOfOrder() {
  const r = harness.renderPage({ stub: stubFor(0), driver: DRIVER_OUT_OF_ORDER,
                                 name: "share-similar-order", windowSize: "390x844",
                                 budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

function renderInflight(delay) {
  const r = harness.renderPage({ stub: stubFor(delay), driver: DRIVER_INFLIGHT,
                                 name: "share-similar-inflight", windowSize: "390x844",
                                 budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

function render(delay) {
  // 60s, not the 20s default: this driver waits on five separate conditions,
  // and a condition wait is 5s of virtual time in the worst case. Under the
  // load of the whole DOM suite those waits take more iterations, the budget
  // runs out mid-driver, and the results come back truncated — which reads as
  // "the row rendered nothing" rather than as "the page was cut off". That is
  // what made this file pass alone and fail about half the time in the suite.
  const r = harness.renderPage({ stub: stubFor(delay), driver: DRIVER,
                                 name: "share-similar-" + delay, windowSize: "390x844",
                                 budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

test("the suggestions row under the share card", { concurrency: 1 }, async (t) => {
  await t.test("the card is on screen before the suggestions are even asked for", () => {
    const r = render(900);
    assert.equal(r.card_up, true, "the card never rendered");
    // An ORDER assertion, recorded inside the fetch stub. A timing one ("the
    // card appeared within N ms") cannot be trusted here: the harness
    // fast-forwards timers but the font load and the FileReader behind the
    // card run in real time, so a clock-based version of this passed four runs
    // and failed the fifth.
    assert.equal(r.card_up_when_asked, true,
      "the suggestions were requested before the card was painted — they cost up to " +
      "five Deezer calls and the card must never queue behind them");
    assert.equal(r.similar_when_card_up, 0,
      "the suggestions were already on screen when the card appeared");
    assert.equal(r.similar_hidden_when_card_up, true,
      "an empty suggestions row is a gap under the card, not a row");
  });

  await t.test("three acts, and one that has no nameable record", () => {
    const r = render(0);
    assert.equal(r.similar_visible, true, "the row never appeared");
    assert.deepEqual(r.acts.map(a => a.name),
      ["Airbourne like 1", "Airbourne like 2", "Airbourne like 3"]);
    assert.equal(r.acts[0].rec, "Rose Tattoo · 1978");
    // An act whose records could not be named is still worth showing.
    assert.equal(r.acts[2].rec, null,
      "an act with no album should render as a name, not be dropped");
  });

  await t.test("it asks for the artist, once", () => {
    const r = render(0);
    assert.equal(r.asked_for.length, 1, "asked " + r.asked_for.length + " times for one card");
    assert.match(r.asked_for[0], /artist=Airbourne/);
  });

  await t.test("the open that finishes LAST is not the one that wins", () => {
    // Which open this is has to be stamped when the open BEGINS. Stamping it
    // where the suggestion fetch is issued gives the newest number to whichever
    // open got there first — and the first open is not always the first to get
    // there. ensureFont() alone reorders them: it really loads the font once
    // and resolves instantly afterwards. Here the reordering is forced rather
    // than raced: the first record's extras take 800ms and the second's none.
    const r = renderOutOfOrder();
    assert.ok(!r.asked.includes("Slowcoach"),
      "the superseded record still asked for suggestions (" + r.asked.join(", ") +
      ") — five Deezer calls for a card nobody is looking at");
    assert.deepEqual(r.asked, ["Quick"]);
    for (const n of r.names) {
      assert.match(n, /^Quick like /,
        "the row ended up showing " + JSON.stringify(r.names) + " — the open that " +
        "finished last won, so the record on screen and the acts under it are " +
        "different records");
    }
  });

  await t.test("an answer that arrives after the sheet is shut is dropped", () => {
    // Both halves of the guard live here: close() bumps the generation, and
    // loadSimilar checks it. Either one missing and three acts paint into a
    // sheet the user has already shut — which then greet them, stale, the next
    // time it opens.
    const r = renderInflight(600);
    assert.equal(r.in_flight_rows, 0, "the row was populated before the answer came back");
    assert.equal(r.overlay_hidden, true, "the sheet did not actually close");
    assert.equal(r.rows_after_close, 0,
      "the answer arrived after the sheet was shut and was rendered anyway (" +
      r.rows_after_close + " rows) — close() must retire the generation, and the " +
      "render must check it");
    assert.equal(r.similar_hidden, true, "the suggestions row was left showing");
  });

  // A back-to-back open/open case lived here and was REMOVED rather than
  // repaired. It drove two opens with no gap, and under the load of the whole
  // DOM suite the second one's request sometimes never went out at all, so the
  // driver timed out waiting for it — the file passed eight runs alone and
  // failed about half the time in the suite. The in-flight case above closes
  // the sheet while an answer is genuinely out, which is the only way to reach
  // the guard inside loadSimilar and the bump in close(), and it catches all
  // three mutations the removed one did. A flaky test that duplicates a stable
  // one is a liability with no coverage behind it.

});
