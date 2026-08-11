"use strict";
// ---------------------------------------------------------------------------
// v1.7.54: the automatic rescan is observable.
//
// The whole point of the automatic rescan is that nobody has to do anything,
// which is also why five separate defects in it shipped unnoticed: it runs in
// the background with no toast, so a library refreshing itself and a library
// that had quietly stopped refreshing looked identical from the app. The
// server has published `library_importing`, `library_recheck_pending`,
// `index_built_at` and `index_count` on /api/status since v1.7.49 and no
// client read any of them.
//
// The wording is the part worth pinning. Every one of these facts is LAGGING —
// `library_importing` is set at the last check and cleared at the next clean
// one, and Roon publishes no import-finished event that could make it live. A
// status line reading "Roon is importing" would be a confident lie, so the
// tests assert the tense as well as the presence.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

function stubFor(status) {
  return `
window.__status = ${JSON.stringify(status)};
window.__installFetch(function (url) {
  if (url.indexOf("/api/status") > -1)     return window.__json(window.__status);
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(300);
  var el = document.getElementById("rescan-sub");
  T("exists", !!el);
  T("text", el ? el.textContent : null);
`;

function sub(status, name) {
  const r = harness.renderPage({
    stub: stubFor(status), driver: DRIVER, name, windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);
  assert.equal(r.exists, true, "the Rescan row has no sub-line element");
  return r.text;
}

test("the Rescan row says what the snapshot currently is", { concurrency: 1 }, async (t) => {
  await t.test("a settled library reports its size and when it was checked", () => {
    const txt = sub({
      paired: true, index_count: 12431, index_built_at: Date.now() - 90 * 60 * 1000,
      library_importing: false, library_recheck_pending: false,
    }, "rescan-sub-fresh");
    assert.match(txt, /12,431 albums/, "the album count is not shown: " + JSON.stringify(txt));
    assert.match(txt, /checked/, "nothing says when the snapshot was last verified");
    assert.match(txt, /2 hours ago/, "the age is wrong or missing: " + JSON.stringify(txt));
  });

  await t.test("THE one: a pending recheck is visible, so the automatic path is", () => {
    // Without this the user cannot tell a working automatic rescan from a dead
    // one — which is exactly how the budget-exhaustion bug survived.
    const txt = sub({
      paired: true, index_count: 900, index_built_at: Date.now() - 60000,
      library_importing: false, library_recheck_pending: true,
    }, "rescan-sub-pending");
    assert.match(txt, /checking again/,
      "a scheduled automatic recheck is invisible in the UI: " + JSON.stringify(txt));
  });

  await t.test("a paused refresh explains itself in the PAST tense", () => {
    const txt = sub({
      paired: true, index_count: 900, index_built_at: Date.now() - 60000,
      library_importing: true, library_recheck_pending: true,
    }, "rescan-sub-importing");
    assert.match(txt, /was importing at the last check/,
      "the paused-refresh state is not explained: " + JSON.stringify(txt));
    assert.ok(!/Roon is importing/.test(txt),
      "the line claims a live import. This flag is set at the LAST check and " +
      "cleared at the next clean one; Roon publishes no import-finished event, " +
      "so present tense here is a confident lie replacing a vague truth");
  });

  await t.test("importing outranks pending — the reason beats the schedule", () => {
    // Both flags are set during a paused refresh. "Checking again shortly" is
    // true but says nothing about why the library is stale.
    const txt = sub({
      paired: true, index_count: 900, index_built_at: Date.now() - 60000,
      library_importing: true, library_recheck_pending: true,
    }, "rescan-sub-order");
    assert.ok(!/checking again/.test(txt), "the schedule hid the reason: " + JSON.stringify(txt));
  });

  await t.test("no snapshot and no connection each say so, rather than lying about zero", () => {
    // "0 albums · checked just now" would read as an empty library.
    const none = sub({
      paired: true, index_count: 0, index_built_at: null,
      library_importing: false, library_recheck_pending: false,
    }, "rescan-sub-none");
    assert.match(none, /No snapshot yet/, "an unbuilt index reported as a library: " + JSON.stringify(none));

    const off = sub({ paired: false }, "rescan-sub-unpaired");
    assert.match(off, /Not connected/, JSON.stringify(off));
  });
});
