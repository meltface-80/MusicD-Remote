"use strict";
// ---------------------------------------------------------------------------
// v1.8.36: the Qobuz links, upgraded after the row is drawn.
//
// lib/qobuz-deeplink.js decides WHICH id (unit-tested). This is about the two
// properties that only exist in the browser:
//
//   1. the upgrade happens AFTER the rows are on screen and never before —
//      it costs a page read on the server, and a suggestion must not wait on
//      it;
//   2. a failure leaves the search link that was already there, which is not
//      nothing.
//
// Plus the rule that stops it being wasted work: only when Qobuz is the
// default, because that is the only link the rows actually point at.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const QOBUZ_SEARCH = "https://www.qobuz.com/gb-en/search/?q=Iggy%20Pop%20The%20Idiot";
const TIDAL_SEARCH = "https://tidal.com/search?q=Iggy%20Pop%20The%20Idiot";
const DEEP = "https://open.qobuz.com/album/abc123";

const ACTS = [
  { name: "Iggy Pop", album: "The Idiot", year: 1977, in_library: false, offset: null,
    services: [{ id: "qobuz", name: "Qobuz", url: QOBUZ_SEARCH },
               { id: "tidal", name: "TIDAL", url: TIDAL_SEARCH }] },
];

const EXTRAS = { year: 1977, album: null, artist: null,
                 links: { services: [{ id: "qobuz", name: "Qobuz", url: "https://www.qobuz.com/gb-en/search/?q=card" },
                                     { id: "tidal", name: "TIDAL", url: "https://tidal.com/search?q=card" }],
                          reviews: [] } };

// answer: "deep" resolves, "none" returns null, "slow" holds the answer back.
function stubFor(answer, pref) {
  return `
window.__linkCalls = [];
try {
  localStorage.setItem("rra-zone", "z1");
  ${pref ? `localStorage.setItem("musicd-share-service", ${JSON.stringify(pref)});` : ""}
} catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/qobuz-link") > -1) {
    window.__linkCalls.push(u);
    var answer = ${JSON.stringify(answer)};
    if (answer === "none") return window.__json({ url: null });
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(window.__json({ url: ${JSON.stringify(DEEP)} })); },
                 answer === "slow" ? 900 : 0);
    });
  }
  if (u.indexOf("/api/similar") > -1)      return window.__json({ acts: ${JSON.stringify(ACTS)} });
  if (u.indexOf("/api/album/extras") > -1) return window.__json(${JSON.stringify(EXTRAS)});
  if (u.indexOf("/api/zones") > -1)        return window.__json({ zones: [{ zone_id: "z1", display_name: "Room", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1)   return window.__json({ zone: null });
  if (u.indexOf("/api/home/") > -1)        return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)       return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)             return window.__json({});
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
  var rowSel = "#share-similar-list a.share-similar-act";
  var rowHref = function () {
    var a = document.querySelector(rowSel);
    return a ? a.getAttribute("href") : null;
  };

  window.__openShareCard({ title: "Low", artist: "David Bowie", image_key: "k0" });
  await until("the suggestion row", function () { return !!document.querySelector(rowSel); });

  // The row is ON SCREEN — this is the moment the upgrade must not have been
  // waited for. Its href is whatever the server first sent.
  T("href_when_drawn", rowHref());
  T("calls_when_drawn", window.__linkCalls.length);

  await window.__sleep(1500);   // room for the upgrade, slow answer included
  T("href_after", rowHref());
  T("calls_after", window.__linkCalls.slice());
  var chip = document.querySelector('#share-links a[data-service="qobuz"]');
  T("chip_after", chip ? chip.getAttribute("href") : null);
`;

function render(answer, pref) {
  const r = harness.renderPage({ stub: stubFor(answer, pref), driver: DRIVER,
                                 name: "qobuz-deeplink-" + answer, windowSize: "390x900",
                                 budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.TIMED_OUT_WAITING_FOR, undefined,
    "the driver gave up waiting for " + r.TIMED_OUT_WAITING_FOR);
  return r;
}

test("the Qobuz link is upgraded to one that opens the app", { concurrency: 1 }, async (t) => {
  await t.test("the search link is replaced by an album link", () => {
    const r = render("deep");
    // href_when_drawn is NOT asserted here: this stub answers immediately, so
    // the upgrade can legitimately have landed before the row is first read.
    // The ordering is the "slow" case's job, below — a test that can pass for
    // two different reasons says nothing about either.
    assert.equal(r.href_after, DEEP,
      "the row still points at " + r.href_after + " — a Qobuz search URL lands on " +
      "their download store and can never open the app");
    // And the card's own chip, which has exactly the same problem.
    assert.equal(r.chip_after, DEEP, "the card's Qobuz chip was left on the store");
  });

  await t.test("the row does not wait for it", () => {
    // 900ms is far longer than the row takes to appear. If the href is already
    // the deep link when the row is first seen, the row queued behind a page
    // read on the server.
    const r = render("slow");
    assert.equal(r.href_when_drawn, QOBUZ_SEARCH,
      "the suggestion was already upgraded when it first appeared, which means it " +
      "waited for a lookup that costs a page read");
    assert.equal(r.href_after, DEEP, "the upgrade never arrived");
  });

  await t.test("a failure leaves the search link, which is not nothing", () => {
    const r = render("none");
    assert.equal(r.href_after, QOBUZ_SEARCH,
      "Qobuz had nothing recognisable and the row lost its link entirely — the " +
      "search page at least shows the right words");
    assert.ok(r.calls_after.length >= 1, "it should still have asked");
  });

  await t.test("no SUGGESTION is looked up when Qobuz is not the default", () => {
    const r = render("deep", "tidal");
    // The card's own chip is still upgraded: it is on screen and it always
    // points at Qobuz whatever the default is, so it has the same problem.
    // The ROWS point elsewhere, so looking them up would be a page read spent
    // on a link nobody can tap.
    const forRows = r.calls_after.filter(u => u.indexOf("The+Idiot") > -1 ||
                                              u.indexOf("The%20Idiot") > -1);
    assert.deepEqual(forRows, [],
      "a page read was spent on a link the rows do not point at: " + forRows.join(", "));
    assert.match(r.href_after, /tidal\.com/, "the row should point at the default service");
  });

  await t.test("it asks for the act's record, not the card's", () => {
    const r = render("deep");
    // URLSearchParams writes a space as "+", which decodeURIComponent does not
    // turn back into one — matching on the decoded string finds nothing.
    const forRow = r.calls_after.filter(u => u.indexOf("The+Idiot") > -1 ||
                                             u.indexOf("The%20Idiot") > -1);
    assert.ok(forRow.length >= 1,
      "no lookup carried the suggestion's own album: " + r.calls_after.join(", "));
    assert.ok(forRow[0].indexOf("Iggy+Pop") > -1 || forRow[0].indexOf("Iggy%20Pop") > -1,
      "the lookup did not carry the suggestion's artist: " + forRow[0]);
  });
});
