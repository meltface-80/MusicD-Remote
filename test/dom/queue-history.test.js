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
      if (li.classList.contains("q-history-bar"))  return "[bar]";
      if (li.classList.contains("q-hist-actions"))  return "[actions]";
      if (li.classList.contains("q-divider"))       return "[now playing]";
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
      "[bar]", "[actions]", "hist:First", "hist:Second", "hist:Third",
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

// ---------------------------------------------------------------------------
// v1.7.78: picking several played tracks, in any order.
//
// The order the user taps is not the order the rows are shown in, and it is the
// order the tracks will be queued in. Two things follow, and both are asserted
// below: the screen has to SHOW the pick order, and the request has to carry it
// — a selection that quietly sorted itself back into display order would look
// completely normal and be wrong.
// ---------------------------------------------------------------------------

const MULTI_STUB = STUB.replace(
  'if (url.indexOf("/api/queue/play-history-next") > -1) {',
  `if (url.indexOf("/api/queue/history-multi") > -1) {
    window.__multi.push(JSON.parse((opts && opts.body) || "{}"));
    if (window.__multiUnresolved) {
      return window.__json({ ok: true, kind: "play_next", queued: 1, failed: [],
                             unresolved: window.__multiUnresolved });
    }
    return window.__json({ ok: true, kind: "play_next", queued: 2, failed: [], unresolved: [] });
  }
  if (url.indexOf("/api/queue/play-history-next") > -1) {`
).replace("window.__posts = [];", "window.__posts = [];\nwindow.__multi = [];");

const SEL_HELPERS = HELPERS + `
  function selBtn() { return document.querySelector("#queue-list .q-history-select"); }
  function actionBar() { return document.querySelector("#queue-list .q-hist-actions"); }
  function actBtn(label) {
    return Array.prototype.slice.call(document.querySelectorAll("#queue-list .q-hist-act"))
      .filter(function (b) { return b.textContent === label; })[0];
  }
  function rowByTitle(t) {
    return histRows().filter(function (r) {
      return r.querySelector(".q-title").textContent === t;
    })[0];
  }
  // What the badges say, row by row, top to bottom. "" where a row is unpicked.
  function badges() {
    return histRows().map(function (r) {
      var n = r.querySelector(".q-hist-num");
      return n && !n.classList.contains("hidden") ? n.textContent : "";
    });
  }
`;

test("several played tracks, picked in any order", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "queue-history-multi", windowSize: "390x844", stub: MULTI_STUB,
    driver: `
      ${SEL_HELPERS}
      await window.__sleep(400);
      await openQueue();
      bar().click();
      await window.__sleep(200);

      T("select_offered", !!selBtn());
      T("bar_hidden_before", actionBar().classList.contains("hidden"));

      selBtn().click();
      await window.__sleep(150);
      T("bar_shown", !actionBar().classList.contains("hidden"));
      T("empty_prompt", document.querySelector(".q-hist-count").textContent);
      T("next_disabled_empty", actBtn("Play next").disabled);

      // Displayed order is First, Second, Third. Pick them out of order.
      rowByTitle("Third").click();  await window.__sleep(60);
      rowByTitle("First").click();  await window.__sleep(60);
      T("badges_after_two", badges());
      T("count_after_two", document.querySelector(".q-hist-count").textContent);

      // Deselect the first pick — everything after it must renumber.
      rowByTitle("Third").click();  await window.__sleep(60);
      T("badges_after_deselect", badges());

      // Re-pick so the order is First(1), Second(2), Third(3)... in tap order
      // First, Third, Second.
      rowByTitle("Third").click();  await window.__sleep(60);
      rowByTitle("Second").click(); await window.__sleep(60);
      T("badges_final", badges());

      // Measured, not inferred. A control that renders with no box is one
      // nobody can tap, and class-name assertions cannot see that — the same
      // reason this project has hit-test coverage on the Sort sheet.
      (function () {
        var ab = actionBar().getBoundingClientRect();
        T("actions_box", { w: Math.round(ab.width), h: Math.round(ab.height) });
        var nb = rowByTitle("First").querySelector(".q-hist-num").getBoundingClientRect();
        T("badge_box", { w: Math.round(nb.width), h: Math.round(nb.height) });
        var pb = actBtn("Play next").getBoundingClientRect();
        T("play_next_box", { w: Math.round(pb.width), h: Math.round(pb.height) });
        var lb = document.getElementById("queue-list").getBoundingClientRect();
        var rb = rowByTitle("First").getBoundingClientRect();
        T("row_within_list", rb.left >= lb.left - 0.5 && rb.right <= lb.right + 0.5);
      })();

      actBtn("Play next").click();
      await confirmYes();
      T("multi", window.__multi.slice());
      T("singles", window.__posts.slice());
      T("mode_after", selBtn() ? selBtn().getAttribute("aria-pressed") : "gone");
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("select mode is offered and starts empty", () => {
    assert.equal(r.select_offered, true, "no Select control on the fold-out");
    assert.equal(r.bar_hidden_before, true, "the action bar is visible before selecting");
    assert.equal(r.bar_shown, true);
    assert.match(String(r.empty_prompt), /play order/i,
      "the empty state should say that tap order is what decides the queue order");
    assert.equal(r.next_disabled_empty, true, "acting on an empty selection was possible");
  });

  await t.test("the badges show pick order, not row order", () => {
    // Rows read First, Second, Third down the screen. Tapping Third then First
    // must number Third 1 and First 2 — the reverse of how they sit.
    assert.deepEqual(r.badges_after_two, ["2", "", "1"],
      "the badges follow the rows' position instead of the order they were tapped");
    assert.match(String(r.count_after_two), /2 selected/);
  });

  await t.test("removing a pick renumbers the rest", () => {
    assert.deepEqual(r.badges_after_deselect, ["1", "", ""],
      "First was picked second; with Third removed it has to become 1");
  });

  await t.test("the request carries the tap order", () => {
    assert.deepEqual(r.badges_final, ["1", "3", "2"]);
    assert.equal(r.multi.length, 1, "expected exactly one batch request");
    assert.equal(r.multi[0].kind, "play_next");
    assert.equal(r.multi[0].zone_or_output_id, "z1");
    assert.deepEqual(r.multi[0].tracks.map(t => t.track), ["First", "Third", "Second"],
      "the batch was sent in the rows' display order — the pick order is the " +
      "whole feature, and sorting it away looks identical on screen");
    // The ALBUM is what the server resolves on first — the track index only
    // knows albums opened in this app, so dropping this field quietly sends
    // resolution back to failing for anything played from Roon itself.
    assert.deepEqual(r.multi[0].tracks[0], { track: "First", artist: "Artist A", album: "Album A" });
  });

  await t.test("it batches rather than firing one request per track", () => {
    // Separate requests would race and interleave into an arbitrary queue
    // order, which is exactly what this is supposed to prevent.
    assert.deepEqual(r.singles, [], "single-track requests were sent for a selection");
  });

  await t.test("the controls are actually on screen and tappable", () => {
    assert.ok(r.actions_box.h > 0 && r.actions_box.w > 0,
      `the action bar has no box (${JSON.stringify(r.actions_box)}) — it renders but cannot be used`);
    assert.ok(r.badge_box.w >= 16 && r.badge_box.h >= 16,
      `the pick number is ${JSON.stringify(r.badge_box)} — too small to read the order off`);
    assert.ok(r.play_next_box.w >= 40 && r.play_next_box.h >= 24,
      `Play next is ${JSON.stringify(r.play_next_box)} — below a usable tap target`);
    assert.equal(r.row_within_list, true, "a history row overflows the queue list");
  });

  await t.test("and select mode ends once it has been sent", () => {
    assert.notEqual(r.mode_after, "true");
  });
});

test("tapping a row still plays it when not selecting", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Select mode must be a mode. A row that queued a track the moment it was
  // tapped would make picking impossible, and a row that only ever selected
  // would lose the single-tap action shipped in v1.7.77.
  const r = harness.renderPage({
    name: "queue-history-modes", windowSize: "390x844", stub: MULTI_STUB,
    driver: `
      ${SEL_HELPERS}
      await window.__sleep(400);
      await openQueue();
      bar().click(); await window.__sleep(200);

      rowByTitle("Second").click();
      await confirmYes();
      T("single_when_not_selecting", window.__posts.length);
      T("multi_when_not_selecting", window.__multi.length);

      // That play schedules a queue reload, and the reload clears select mode
      // on purpose. Wait it out rather than racing it.
      await window.__sleep(1100);
      bar().click(); await window.__sleep(150);          // reopen the fold-out
      selBtn().click(); await window.__sleep(150);
      window.__posts.length = 0;
      rowByTitle("Second").click(); await window.__sleep(120);
      T("no_confirm_in_select", document.getElementById("confirm-overlay").classList.contains("hidden"));
      T("single_in_select", window.__posts.length);
      T("badge_in_select", badges());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("outside select mode a tap plays the track", () => {
    assert.equal(r.single_when_not_selecting, 1);
    assert.equal(r.multi_when_not_selecting, 0);
  });

  await t.test("inside select mode a tap only picks it", () => {
    assert.equal(r.no_confirm_in_select, true, "a tap in select mode asked to play the track");
    assert.equal(r.single_in_select, 0, "a tap in select mode queued a track");
    assert.deepEqual(r.badge_in_select, ["", "1", ""]);
  });
});

test("a partial result says which tracks it could not use", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // "1 not in your library" leaves the user to work out which of their picks it
  // meant — and that answer is the difference between an ordinary absence and
  // something worth reporting.
  const r = harness.renderPage({
    name: "queue-history-partial", windowSize: "390x844",
    stub: MULTI_STUB + `\nwindow.__multiUnresolved = ["Second"];\n`,
    driver: `
      ${SEL_HELPERS}
      await window.__sleep(400);
      await openQueue();
      bar().click(); await window.__sleep(200);
      selBtn().click(); await window.__sleep(150);
      rowByTitle("First").click();  await window.__sleep(60);
      rowByTitle("Second").click(); await window.__sleep(60);
      actBtn("Play next").click();
      await confirmYes();
      var toast = document.querySelector(".toast");
      T("toast", toast ? toast.textContent : "");
      T("toast_is_error", toast ? toast.classList.contains("error") : false);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it names the track rather than just counting it", () => {
    assert.match(String(r.toast), /Second/,
      "the toast counted the failure without naming it, so there is no way to " +
      "tell which pick was dropped");
    assert.match(String(r.toast), /not in your library/);
    assert.match(String(r.toast), /1 track/, "it should still report what DID go");
  });

  await t.test("and flags it as something that went wrong", () => {
    assert.equal(r.toast_is_error, true);
  });
});
