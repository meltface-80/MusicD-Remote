"use strict";
// ---------------------------------------------------------------------------
// v1.7.43: "Couldn't play from here: Load failed" on opening the PWA.
//
// Reported as a native dialog appearing over the Now playing screen when the
// installed app was reopened — while music was playing perfectly well.
//
// "Load failed" is WebKit's message for a fetch that never completed. The chain:
// the user taps a queue row and confirms; /api/play-from-here goes out; Roon
// answers from inside a Core callback, which can take seconds; iOS backgrounds
// the app before the response arrives and tears the connection down. The
// rejection is delivered when the app is REOPENED, and the catch alerted about
// a tap made minutes earlier. The server had already carried the command out —
// which is why the music was playing.
//
// So the rule: a request interrupted by the app being suspended is not a
// failure the user should be told about. A request that fails while the app
// stayed in the foreground still is.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: {
    line1: "Why Not Nothing?", line2: "Richard Ashcroft", line3: "Keys To The World",
    length: 249, seek_position: 18,
  },
};

const QUEUE = [
  { queue_item_id: 1, length: 200, line1: "Why Not Nothing?", line2: "Richard Ashcroft" },
  { queue_item_id: 2, length: 210, line1: "Music Is Power",   line2: "Richard Ashcroft" },
  { queue_item_id: 3, length: 220, line1: "Break The Night",  line2: "Richard Ashcroft" },
];

// `mode` decides how /api/play-from-here behaves:
//   "suspend" — the app is backgrounded while the request is in flight, then
//               the fetch rejects exactly as iOS delivers it on resume;
//   "fail"    — an ordinary network failure with the app in the foreground.
function stub(mode) {
  return `
var ZONE = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__queueLoads = 0;
window.__playPosts = [];
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/play-from-here") > -1) {
    window.__playPosts.push(JSON.parse((opts && opts.body) || "{}"));
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        ${mode === "suspend" ? `
        // Exactly what iOS does: the page is hidden, the socket is torn down,
        // and the rejection lands only once the app is visible again.
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        setTimeout(function () {
          Object.defineProperty(document, "hidden", { value: false, configurable: true });
          Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
          reject(new TypeError("Load failed"));
        }, 60);
        ` : `
        reject(new TypeError("Load failed"));
        `}
      }, 40);
    });
  }
  if (url.indexOf("/api/queue") > -1) {
    window.__queueLoads++;
    return window.__json({ items: ${JSON.stringify(QUEUE)} });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ZONE });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [ZONE] });
  if (url.indexOf("/api/album") > -1)      return window.__json({ tracks: [], acts: [] });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: [], offset: 0, total: 0 });
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 0, facets: [], coverage: {}, hasPlays: false });
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  if (url.indexOf("/api/smart-picks") > -1)
    return window.__json({ day: "2026-08-05", service_ready: false, picks: [] });
  if (url.indexOf("/api/filters") > -1)  return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)    return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)   return window.__json({ paired: true });
  if (url.indexOf("/api/version") > -1)  return window.__json({ version: "test" });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  return undefined;
});
// If any native dialog is reached, record it — the app should never use one.
window.__natives = [];
window.alert   = function (m) { window.__natives.push("alert:" + m); };
window.confirm = function (m) { window.__natives.push("confirm:" + m); return true; };
`;
}

const DRIVER = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(500);
  document.querySelector('.modal-tab[data-tab="queue"]').click();
  await window.__sleep(500);

  // Only the rows AFTER the one playing are tappable — "play from here" has no
  // meaning for the track already playing.
  var tappable = document.querySelectorAll("#queue-list li.is-tappable");
  T("queue_rows", document.querySelectorAll("#queue-list li").length);
  T("tappable_rows", tappable.length);
  tappable[0].click();
  await window.__sleep(250);

  // The app's own confirm sheet, not a native one.
  var ov = document.getElementById("confirm-overlay");
  T("confirm_shown", !!ov && !ov.classList.contains("hidden"));
  T("confirm_text", (document.getElementById("confirm-msg") || {}).textContent || "");
  var loadsBefore = window.__queueLoads;
  document.getElementById("confirm-yes").click();

  // Long enough for the request, the hide/show, and the rejection.
  await window.__sleep(900);

  T("posts", window.__playPosts.length);
  T("natives", window.__natives);
  T("toast", (document.querySelector(".toast") || {}).textContent || "");
  T("queue_reloaded", window.__queueLoads > loadsBefore);
`;

test("a play-from-here interrupted by iOS suspending the app stays quiet (v1.7.43)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: stub("suspend"), driver: DRIVER, name: "play-from-here-suspend",
      windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the tap reached the server", () => {
      assert.ok(r.tappable_rows > 0, "no queue row was tappable, so nothing was tested");
      assert.equal(r.confirm_shown, true);
      assert.match(r.confirm_text, /Play from/);
      assert.equal(r.posts, 1, "the request was never sent, so this proves nothing");
    });

    await t.test("no native dialog is used at all", () => {
      // THE symptom: a native alert painted over Now playing on reopen. The app
      // uses its own sheet and its own toast everywhere else, and these two
      // calls were the last window.alert/window.confirm in the file.
      assert.deepEqual(r.natives, [],
        "a native dialog was used: " + JSON.stringify(r.natives));
    });

    await t.test("nothing is reported to the user", () => {
      // The server already ran the command — the music kept playing in the
      // report — so there is nothing for the user to act on.
      assert.equal(r.toast, "",
        "an error was shown for a request the user interrupted by switching " +
        "apps: " + JSON.stringify(r.toast));
    });

    await t.test("the queue is re-pulled instead", () => {
      // The success path's own follow-up (setTimeout(loadQueue, 600)) never
      // ran, so without this the now-playing marker would stay stale.
      assert.equal(r.queue_reloaded, true);
    });
  });

test("a genuine failure with the app in the foreground is still reported (v1.7.43)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }

    const r = harness.renderPage({
      stub: stub("fail"), driver: DRIVER, name: "play-from-here-fail",
      windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);

    await t.test("the user is told", () => {
      // The other half of the fix. Silencing every rejection would have hidden
      // real failures — the guard is specifically "was the app suspended", not
      // "did it fail".
      assert.equal(r.posts, 1);
      assert.match(r.toast, /Couldn't play from here/,
        "a real network failure was swallowed");
      assert.match(r.toast, /Load failed/);
    });

    await t.test("still no native dialog", () => {
      assert.deepEqual(r.natives, []);
    });
  });
