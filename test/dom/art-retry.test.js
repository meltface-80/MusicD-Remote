"use strict";
// ---------------------------------------------------------------------------
// v1.7.89: album covers that lose one race must not stay lost.
//
// `/api/image` answers 503 whenever the extension is still connecting to the
// Roon Core and the art is not already in the on-disk store:
//
//     if (!core) return res.status(503).end();
//
// A cold app open lands squarely in that window. Home deliberately repaints
// from its saved copy the instant the page loads — that is the whole point of
// the localStorage cache — while pairing takes a second or two. Every <img>
// that lost the race fired onerror, and onerror did this:
//
//     img.onerror = () => { wrap.classList.add("no-image"); img.remove(); };
//
// One failure, a music note for the life of the page, even though the art
// became available moments later and nothing ever asked again. Which rows were
// affected came down to which requests happened to be in flight, which is why
// the same screen showed covers on some carousels and notes on others.
//
// Reproduced here by failing the first N image requests and then serving them,
// which is what a Core connecting mid-load looks like from the browser.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// A 1x1 gif, so a "served" image genuinely decodes and fires load.
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

const ALBUMS = [];
for (let i = 0; i < 6; i++) {
  ALBUMS.push({ offset: i, title: "Album " + i, subtitle: "Artist " + i, image_key: "k" + i });
}

// Image loads fail for the first `failMs`, then succeed. TIME, not a count of
// requests: the wall is built more than once during startup, and a count-based
// stub had its failures consumed by a render that was then discarded — so the
// tiles the test measured had never failed at all, and the mutant restoring the
// old give-up-immediately behaviour passed. Time is also what the real thing
// is: the Core connects a second or two in, and every request before that
// answers 503 no matter who made it.
//
// The swap is done on HTMLImageElement.src, because an <img> does not go
// through fetch and the harness has no server to return a 503 from.
const stub = (failMs) => `
window.__imgTries = 0;
window.__t0 = Date.now();
(function () {
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) {
      if (typeof v === "string" && v.indexOf("/api/image/") > -1) {
        window.__imgTries++;
        if (Date.now() - window.__t0 < ${failMs}) {
          // A URL that cannot resolve — the browser fires error, exactly as a
          // 503 would.
          d.set.call(this, "data:image/gif;base64,BROKEN");
          return;
        }
        d.set.call(this, ${JSON.stringify(PIXEL)});
        return;
      }
      d.set.call(this, v);
    },
  });
})();
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 6, filtered: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [] });
  if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/settings") > -1)   return window.__json({});
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  return undefined;
});
`;

const DRIVER = `
  var grid = document.getElementById("album-grid");
  await window.__sleep(600);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);
  for (var i = 0; i < 40 && grid.querySelectorAll(".album").length < 3; i++)
    await window.__sleep(100);

  function shot() {
    var wraps = grid.querySelectorAll(".album .album-art-wrap");
    var withImg = 0, gaveUp = 0;
    for (var j = 0; j < wraps.length; j++) {
      if (wraps[j].querySelector("img")) withImg++;
      if (wraps[j].classList.contains("no-image")) gaveUp++;
    }
    return { tiles: wraps.length, withImg: withImg, gaveUp: gaveUp };
  }
  T("immediately", shot());
  T("keys_recorded", grid.querySelectorAll(".album .album-art-wrap[data-art-key]").length);

  // Past the first retry gap (1200ms), inside the second.
  await window.__sleep(2200);
  T("after_first_retry", shot());

  // Past all three (1200 + 3500 + 8000, plus margin).
  await window.__sleep(12000);
  T("after_all_retries", shot());
  T("total_requests", window.__imgTries);
  // Boundedness, measured as "it stopped" rather than counted against an
  // assumed number of renders: the wall is built more than once during startup,
  // so a per-tile multiplier is not a number this test can know.
  await window.__sleep(6000);
  T("requests_later", window.__imgTries);
`;

test("a cover that fails while the Core is connecting comes back", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Every first attempt fails; the retry succeeds. This is the reported case.
  const r = harness.renderPage({
    name: "art-retry", windowSize: "390x844", budgetMs: 40000,
    stub: stub(2500), driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the wall rendered and every tile was given a key", () => {
    assert.ok(r.immediately.tiles >= 3, `only ${r.immediately.tiles} tiles`);
    assert.equal(r.keys_recorded, r.immediately.tiles,
      "not every tile recorded its data-art-key — a failed <img> removes itself, " +
      "so without the key on the wrapper there is no way to tell a tile that was " +
      "given no artwork from one whose artwork failed to load");
  });

  await t.test("the first failure does NOT settle into a placeholder", () => {
    assert.equal(r.after_first_retry.gaveUp, 0,
      `${r.after_first_retry.gaveUp} of ${r.after_first_retry.tiles} tiles fell ` +
      `back to the music note after one failed request — that is the reported bug: ` +
      `the art is available a moment later and nothing asks again`);
  });

  await t.test("and the retry actually puts the artwork back", () => {
    assert.equal(r.after_all_retries.withImg, r.after_all_retries.tiles,
      `${r.after_all_retries.tiles - r.after_all_retries.withImg} tiles are still ` +
      `without an <img> after the retries`);
    assert.equal(r.after_all_retries.gaveUp, 0);
    assert.ok(r.total_requests > r.immediately.tiles,
      `${r.total_requests} image requests for ${r.immediately.tiles} tiles — nothing ` +
      `was retried at all`);
  });
});

test("artwork that never comes back still gives up", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The other half: retrying must be bounded. An album whose art is genuinely
  // gone has to end up showing the placeholder, not retrying forever.
  const r = harness.renderPage({
    name: "art-retry-exhausted", windowSize: "390x844", budgetMs: 40000,
    stub: stub(10 * 60 * 1000), driver: DRIVER,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it settles on the placeholder once the retries run out", () => {
    assert.equal(r.after_all_retries.gaveUp, r.after_all_retries.tiles,
      `${r.after_all_retries.tiles - r.after_all_retries.gaveUp} tiles never gave ` +
      `up — a permanently missing cover would retry for the life of the page`);
    assert.equal(r.after_all_retries.withImg, 0,
      "the failed <img> elements were left in the DOM, which draws a broken-image glyph");
  });

  await t.test("and the retries stop", () => {
    assert.equal(r.requests_later, r.total_requests,
      `image requests went from ${r.total_requests} to ${r.requests_later} six ` +
      `seconds after the last retry gap closed — a cover that is genuinely gone ` +
      `would keep asking for the life of the page`);
  });
});
