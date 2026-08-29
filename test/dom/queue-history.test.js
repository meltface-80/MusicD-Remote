"use strict";
// ---------------------------------------------------------------------------
// v1.7.77: "played earlier" in the Queue tab.
//
// Roon's queue subscription reports the current track and what is coming.
// Anything played — or skipped past by picking a track further down — is gone
// from it, so the Queue tab simply lost it. There is no queue-history call in
// the extension API to ask for it back.
//
// So the rows come from what the extension watched leave, and they are a
// RECORD, not a rewindable queue. That distinction is the thing this file
// guards: tapping one adds it after the current track. Restoring the queue
// around it would mean rebuilding every following track through the browse
// hierarchy at roughly eight Core round trips each, behind a play_now that
// destroys the live queue first — so a test that let the tap become
// "play from here" would be waving through minutes of Core traffic.
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
    line1: "Current Track", line2: "Current Artist", line3: "Current Album",
    artists: [{ name: "Current Artist", linkable: false }], length: 300, seek_position: 10,
  },
};

// Newest first, the order the server sends. One of them is a skip.
const HISTORY = [
  { track: "Third",  artist: "Artist C", album: "Album C", image_key: null,
    duration: 200, elapsed: 12,  played: false, ts: 3000 },
  { track: "Second", artist: "Artist B", album: "Album B", image_key: null,
    duration: 240, elapsed: 240, played: true,  ts: 2000 },
  { track: "First",  artist: "Artist A", album: "Album A", image_key: null,
    duration: 180, elapsed: 180, played: true,  ts: 1000 },
];

const STUB = `
window.__posts = [];
window.__resolve = true;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/queue/play-history-next") > -1) {
    window.__posts.push(JSON.parse((opts && opts.body) || "{}"));
    if (!window.__resolve) {
      return window.__json({ error: "Couldn't find that track in your library to play it again",
                             unresolved: true }, 404);
    }
    return window.__json({ ok: true, action: "Add Next", track: "Third", album: "Album C" });
  }
  if (url.indexOf("/api/queue") > -1) {
    return window.__json({
      items: [
        { queue_item_id: 1, title: "Current Track", subtitle: "Current Artist", length: 300 },
        { queue_item_id: 2, title: "Up Next",       subtitle: "Next Artist",    length: 280 }
      ],
      history: ${JSON.stringify(HISTORY)}
    });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;

const HELPERS = `
  function bar()  { return document.querySelector("#queue-list .q-history-toggle"); }
  function histRows() {
    return Array.prototype.slice.call(document.querySelectorAll("#queue-list li.q-hist-row"));
  }
  function visibleHist() {
    return histRows().filter(function (r) { return !r.classList.contains("hidden"); })
      .map(function (r) { return r.querySelector(".q-title").textContent; });
  }
  // Every row in the list, in DOM order, so the position of the fold-out
  // relative to the Now playing divider is observable.
  function listOrder() {
    return Array.prototype.map.call(document.querySelectorAll("#queue-list > li"), function (li) {
      if (li.classList.contains("q-history-bar")) return "[bar]";
      if (li.classList.contains("q-divider"))     return "[now playing]";
      var t = li.querySelector(".q-title");
      return (li.classList.contains("q-hist-row") ? "hist:" : "live:") + (t ? t.textContent : "?");
    });
  }
  async function openQueue() {
    var mt = document.getElementById("mini-transport");
    for (var w = 0; w < 40 && mt.classList.contains("hidden"); w++) await window.__sleep(100);
    document.querySelector(".mt-info").click();
    await window.__sleep(500);
    document.querySelector('.modal-tab[data-tab="queue"]').click();
    await window.__sleep(500);
  }
  async function confirmYes() {
    for (var i = 0; i < 20; i++) {
      var ov = document.getElementById("confirm-overlay");
      if (ov && !ov.classList.contains("hidden")) break;
      await window.__sleep(50);
    }
    document.getElementById("confirm-yes").click();
    await window.__sleep(500);
  }
`;

test("played tracks are kept, folded away above the queue", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "queue-history", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(400);
      await openQueue();

      T("bar_text", bar() ? bar().textContent : null);
      T("collapsed", visibleHist());
      T("expanded_attr_before", bar().getAttribute("aria-expanded"));

      bar().click();
      await window.__sleep(200);
      T("expanded", visibleHist());
      T("expanded_attr_after", bar().getAttribute("aria-expanded"));
      T("order", listOrder());
      T("skipped_len", histRows().filter(function (r) {
        return r.querySelector(".q-title").textContent === "Third";
      })[0].querySelector(".q-len").textContent);
      T("played_len", histRows().filter(function (r) {
        return r.querySelector(".q-title").textContent === "Second";
      })[0].querySelector(".q-len").textContent);

      bar().click();
      await window.__sleep(200);
      T("collapsed_again", visibleHist());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the fold-out is there, closed, and counts what it holds", () => {
    assert.match(String(r.bar_text), /3 played earlier/);
    assert.deepEqual(r.collapsed, [],
      "the history rows are open by default — this sits above every queue and " +
      "must not push the live queue down the screen unasked");
    assert.equal(r.expanded_attr_before, "false");
  });

  await t.test("opening it shows them oldest first, against the divider", () => {
    assert.deepEqual(r.expanded, ["First", "Second", "Third"],
      "the server sends newest first; on screen the most recent must sit " +
      "nearest Now playing, the way a queue is read");
    assert.equal(r.expanded_attr_after, "true");
    assert.deepEqual(r.order, [
      "[bar]", "hist:First", "hist:Second", "hist:Third",
      "[now playing]", "live:Current Track", "live:Up Next",
    ], "the fold-out must sit ABOVE the Now playing divider — that is where " +
       "those tracks happened");
  });

  await t.test("a skip shows how much of it played", () => {
    // "0:12" alone reads as a very short track; against the length it reads
    // as a skip, which is the thing the user asked to be able to see.
    assert.equal(r.skipped_len, "0:12 / 3:20");
    assert.equal(r.played_len, "4:00", "a track that played shows its length, like any other row");
  });

  await t.test("it closes again", () => {
    assert.deepEqual(r.collapsed_again, []);
  });
});

test("tapping a played track adds it next, and never rebuilds the queue", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "queue-history-play", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(400);
      await openQueue();
      bar().click();
      await window.__sleep(200);

      histRows().filter(function (r) {
        return r.querySelector(".q-title").textContent === "Third";
      })[0].click();
      await confirmYes();
      T("posts", window.__posts.slice());
      T("all_calls", window.__calls.filter(function (u) {
        return u.indexOf("/api/play-from-here") > -1 || u.indexOf("/api/play-multi") > -1;
      }));
      var toast = document.querySelector(".toast");
      T("toast", toast ? toast.textContent : "");

      // A track the library cannot resolve — a stream, or an album since
      // removed. It has to say so, not read as a fault.
      window.__resolve = false;
      window.__posts.length = 0;
      bar().click(); await window.__sleep(150);   // reopen (the reload collapsed nothing, but be explicit)
      if (!visibleHist().length) { bar().click(); await window.__sleep(150); }
      histRows().filter(function (r) {
        return r.querySelector(".q-title").textContent === "First";
      })[0].click();
      await confirmYes();
      var t2 = document.querySelector(".toast");
      T("unresolved_toast", t2 ? t2.textContent : "");
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it sends the track by name to the play-next route", () => {
    assert.equal(r.posts.length, 1, "expected exactly one write for one tap");
    assert.deepEqual(r.posts[0], {
      zone_or_output_id: "z1",
      track: "Third", artist: "Artist C", album: "Album C",
    });
  });

  await t.test("nothing tries to rebuild the queue", () => {
    // The whole design rests on this. play_from_here cannot reach a departed
    // track, and play-multi over a queue is the hundreds-of-calls path.
    assert.deepEqual(r.all_calls, [],
      "a queue-rebuilding call was made for a single history tap");
  });

  await t.test("and it says what it did", () => {
    assert.match(String(r.toast), /next/i);
  });

  await t.test("a track that is not in the library says so", () => {
    assert.match(String(r.unresolved_toast), /isn.t in your library/i,
      "an unresolvable track reads as a generic failure — it is an ordinary " +
      "outcome for a stream or a removed album and should say so");
  });
});

test("a queue that has run out still shows what it played", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The most interesting moment to look at the history is right after the
  // music stops, and that is exactly when the old code showed "nothing here".
  const r = harness.renderPage({
    name: "queue-history-empty", windowSize: "390x844",
    stub: STUB.replace(
      /items: \[[\s\S]*?\],\n      history:/,
      "items: [],\n      history:"),
    driver: `
      ${HELPERS}
      await window.__sleep(400);
      await openQueue();
      T("bar_text", bar() ? bar().textContent : null);
      T("empty_shown", !document.getElementById("queue-empty").classList.contains("hidden"));
      T("summary", document.getElementById("queue-summary").textContent);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the fold-out is still offered", () => {
    assert.match(String(r.bar_text), /3 played earlier/);
    assert.equal(r.empty_shown, false,
      "the screen reported itself empty while holding three played tracks");
    assert.match(String(r.summary), /Nothing more queued/);
  });
});
