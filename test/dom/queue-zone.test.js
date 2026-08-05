"use strict";
// ---------------------------------------------------------------------------
// v1.7.6: the Queue tab showed the wrong zone's queue.
//
// Reported exactly like this: playing to a Sonos zone, switch the extension's
// zone selector to WPP but DON'T move what's playing — the Queue tab kept
// showing the Sonos queue, and "Play from here" acted on it.
//
// Root cause: currentSourceZoneId is a snapshot taken in openAlbum(), so the
// queue was pinned to whichever zone was selected when the screen was OPENED.
// A queue belongs to a zone, and the zone the user is pointed at changes
// underneath an open screen.
//
// Two halves, and both need holding:
//   1. the FETCH must use the live zone selector (what every other control
//      already follows), not the open-time snapshot;
//   2. something must make it fetch again on a zone change, or the stale list
//      just sits there until you leave the tab and come back.
// A test that only covered (1) would pass against the half-fixed code.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const SONOS = {
  zone_id: "z-sonos", display_name: "Sonos", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o-sonos", display_name: "Sonos", is_muted: false, volume: null }],
  now_playing: {
    line1: "Tomorrow", line2: "Built to Spill", line3: "There Is No Enemy",
    artists: [{ name: "Built to Spill", linkable: false }], length: 300, seek_position: 10,
  },
};
const WPP = {
  zone_id: "z-wpp", display_name: "WPP", state: "stopped",
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o-wpp", display_name: "WPP", is_muted: false, volume: null }],
  now_playing: null,
};

// Each zone has a queue with unmistakably different contents, and the stub
// records which zone every /api/queue call asked for.
const STUB = `
window.__queueAsks = [];
window.__posts = [];
try { localStorage.setItem("rra-zone", "z-sonos"); } catch (e) {}
var QUEUES = {
  "z-sonos": [
    { queue_item_id: 1, title: "Tomorrow",  subtitle: "Built to Spill", length: 300 },
    { queue_item_id: 2, title: "Hindsight", subtitle: "Built to Spill", length: 280 }
  ],
  "z-wpp": [
    { queue_item_id: 9, title: "Teen Age Riot", subtitle: "Sonic Youth", length: 400 }
  ]
};
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/queue") > -1) {
    var m = /zone=([^&]*)/.exec(url);
    var z = m ? decodeURIComponent(m[1]) : "";
    window.__queueAsks.push(z);
    return window.__json({ items: QUEUES[z] || [] });
  }
  if (url.indexOf("/api/play-from-here") > -1) {
    window.__posts.push(JSON.parse((opts && opts.body) || "{}"));
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/zone-state") > -1) {
    var m2 = /zone=([^&]*)/.exec(url);
    var zid = m2 ? decodeURIComponent(m2[1]) : "";
    return window.__json({ zone: zid === "z-wpp" ? ${JSON.stringify(WPP)} : ${JSON.stringify(SONOS)} });
  }
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [${JSON.stringify(SONOS)}, ${JSON.stringify(WPP)}] });
  if (url.indexOf("/api/filters") > -1)  return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)    return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)   return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
// window.confirm gates "Play from here"; auto-accept it.
window.confirm = function () { return true; };
`;

const DRIVER = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);

  // Open the now-playing screen while SONOS is the selected zone.
  document.querySelector(".mt-info").click();
  await window.__sleep(500);

  // Switch to the Queue tab.
  var qTab = document.querySelector('.modal-tab[data-tab="queue"]');
  qTab.click();
  await window.__sleep(500);

  function rows() {
    return Array.prototype.map.call(
      document.querySelectorAll("#queue-list .q-title, #queue-list li .q-title"),
      function (e) { return e.textContent; });
  }
  function anyText() {
    var el = document.getElementById("queue-list");
    return el ? el.textContent : "";
  }
  T("sonos_asked", window.__queueAsks.slice());
  T("sonos_shows_sonos", anyText().indexOf("Tomorrow") > -1);
  T("sonos_shows_wpp", anyText().indexOf("Teen Age Riot") > -1);

  // Now switch the zone selector to WPP WITHOUT moving playback — the exact
  // reported scenario. The queue must follow, with no tab change.
  var sel = document.getElementById("zone-select");
  sel.value = "z-wpp";
  sel.dispatchEvent(new Event("change"));
  await window.__sleep(900);

  T("asks_after_switch", window.__queueAsks.slice());
  T("after_shows_wpp", anyText().indexOf("Teen Age Riot") > -1);
  T("after_shows_sonos", anyText().indexOf("Tomorrow") > -1);
  T("still_on_queue_tab", document.getElementById("album-modal").classList.contains("tab-queue"));
`;

test("the Queue tab follows the selected zone (v1.7.6)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "queue-zone", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("it opens on the selected zone's queue", () => {
    assert.deepEqual(r.sonos_asked, ["z-sonos"],
      "the first queue fetch should ask for the selected zone");
    assert.equal(r.sonos_shows_sonos, true);
    assert.equal(r.sonos_shows_wpp, false);
  });

  await t.test("switching zones refetches without leaving the tab", () => {
    // This is the half a fetch-only fix would miss: the request has to actually
    // be reissued, not just be correct the next time something asks.
    assert.deepEqual(r.asks_after_switch, ["z-sonos", "z-wpp"],
      "a zone change with the Queue tab open must refetch for the new zone");
    assert.equal(r.still_on_queue_tab, true,
      "the fix must not work by bouncing the user off the Queue tab");
  });

  await t.test("the new zone's queue replaces the old one on screen", () => {
    assert.equal(r.after_shows_wpp, true, "WPP's queue should now be displayed");
    assert.equal(r.after_shows_sonos, false,
      "the previous zone's tracks must be gone — this is the reported bug");
  });
});
