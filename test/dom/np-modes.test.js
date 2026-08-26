"use strict";
// ---------------------------------------------------------------------------
// v1.7.1: shuffle / repeat / Roon Radio on the now-playing screen.
//
// These are the first controls in the app whose state lives entirely on the
// Roon side, which makes three failure modes possible that no earlier control
// had:
//
//   1. The buttons must show what the ZONE reports, not what we last asked for.
//      A change the Core rejects has to leave the button dark. So every button
//      is painted from the poll, and a click sends a concrete state rather than
//      "toggle" — this file asserts the request body, not just that a request
//      happened.
//   2. Repeat has three states, not two, and the badge is what distinguishes
//      "repeat queue" from "repeat this track". A two-state toggle would look
//      right until you cycled past the second press.
//   3. The transport row went from three buttons to five. On a 360px phone
//      that row has to fit without the circles being squashed or the row
//      scrolling, which is a layout property no functional test would notice.
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
    line1: "So What", line2: "Miles Davis", line3: "Kind of Blue",
    artists: [{ name: "Miles Davis", linkable: false }],
    length: 545, seek_position: 30,
  },
};

// The stub behaves like the server: it applies the patch it is sent, so the
// next poll reports the new state and the buttons repaint from the zone.
const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
window.__posts = [];
window.__standDown = false;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/zone-settings") > -1) {
    var body = JSON.parse((opts && opts.body) || "{}");
    window.__posts.push(body);
    var s = window.__zone.settings;
    if (body.shuffle !== undefined)    s.shuffle = body.shuffle;
    if (body.loop !== undefined)       s.loop = body.loop;
    if (body.auto_radio !== undefined) s.auto_radio = body.auto_radio;
    return window.__json({ ok: true,
      random_album_radio_stands_down: !!(window.__standDown && body.auto_radio === true) });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;

// Opens the now-playing screen the way a user does, then reports the state of
// the three mode buttons after each interaction.
const DRIVER = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.querySelector(".mt-info").click();
  await window.__sleep(500);
  T("np_open", document.getElementById("album-modal").classList.contains("np-mode"));

  var shuffle = document.getElementById("np-shuffle");
  var loop    = document.getElementById("np-loop");
  var badge   = document.getElementById("np-loop-badge");
  // Roon Radio is NOT here any more — it moved to Settings -> Playback in
  // v1.7.71, next to Random album radio. Asserting its absence is what stops
  // it drifting back onto the transport row.
  T("np_radio_absent", !document.getElementById("np-radio"));
  T("buttons_exist", !!shuffle && !!loop && !!badge);

  function snap() {
    return {
      shuffle_on: shuffle.classList.contains("is-on"),
      shuffle_pressed: shuffle.getAttribute("aria-pressed"),
      loop_on: loop.classList.contains("is-on"),
      loop_label: loop.getAttribute("aria-label"),
      badge_hidden: badge.classList.contains("hidden"),
    };
  }
  // A click posts, then the code re-polls 200ms later; give both room.
  async function tap(el) { el.click(); await window.__sleep(600); }

  T("initial", snap());

  await tap(shuffle);
  T("after_shuffle", snap());
  await tap(shuffle);
  T("after_shuffle_off", snap());

  // Repeat cycles off -> queue -> track -> off.
  await tap(loop); T("loop1", snap());
  await tap(loop); T("loop2", snap());
  await tap(loop); T("loop3", snap());

  // Layout: measured while the now-playing screen is still open, BEFORE the
  // settings navigation below — off that screen the row is hidden and every
  // element measures 0, which reads as a pass for "fits on a phone".
  var row = document.querySelector(".np-transport");
  T("row_overflow", row.scrollWidth - row.clientWidth);
  T("row_sizes", Array.prototype.map.call(row.children, function (c) {
    var b = c.getBoundingClientRect();
    return { id: c.id, w: Math.round(b.width), h: Math.round(b.height) };
  }));
  var rowBox = row.getBoundingClientRect();
  T("row_inside_viewport", rowBox.left >= 0 && rowBox.right <= window.innerWidth + 0.5);

  T("posts_np", window.__posts.slice());

  // ---- Roon Radio now lives in Settings -> Playback ----------------------
  window.__standDown = true;
  document.getElementById("modal-home-btn").click();     // leave the NP screen
  await window.__sleep(300);
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="playback"]').click();
  await window.__sleep(250);

  var rr = document.getElementById("roon-radio-toggle");
  T("rr_found", !!rr);
  T("rr_in_playback", !!rr && !!rr.closest('[data-pane="playback"]'));
  // It sits in the same block as Random album radio — the whole point of the
  // move is that the two mutually exclusive switches are read together.
  var ra = document.getElementById("radio-toggle");
  T("rr_beside_random", !!rr && !!ra && rr.closest(".settings-block") === ra.closest(".settings-block"));
  T("rr_checked_before", !!rr.checked);

  rr.click();
  await window.__sleep(600);
  T("rr_checked_after", !!rr.checked);
  var toast = document.querySelector(".toast");
  T("radio_toast", toast ? toast.textContent : null);

  T("posts", window.__posts);

`;

test("shuffle, repeat and Roon Radio reflect and drive the zone (v1.7.1)", async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  // 360x780: the narrowest phone the app targets, where the widened transport
  // row is most likely to overflow.
  const r = harness.renderPage({
    stub: STUB, driver: DRIVER, name: "np-modes", windowSize: "360x780",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the now-playing screen opens with its transport controls", () => {
    assert.equal(r.np_open, true);
    assert.equal(r.buttons_exist, true);
  });

  await t.test("Roon Radio is not on the transport row", () => {
    assert.equal(r.np_radio_absent, true,
      "#np-radio is back on the now-playing screen. It moved to Settings → " +
      "Playback in v1.7.71 to sit beside Random album radio, because the two " +
      "answer the same question and are mutually exclusive.");
  });

  await t.test("they start off, matching the zone", () => {
    assert.equal(r.initial.shuffle_on, false);
    assert.equal(r.initial.shuffle_pressed, "false");
    assert.equal(r.initial.loop_on, false);
    assert.equal(r.initial.loop_label, "Repeat off");
    assert.equal(r.initial.badge_hidden, true);
  });

  await t.test("shuffle lights up and turns back off", () => {
    assert.equal(r.after_shuffle.shuffle_on, true);
    assert.equal(r.after_shuffle.shuffle_pressed, "true");
    assert.equal(r.after_shuffle_off.shuffle_on, false);
  });

  await t.test("repeat cycles off → queue → track → off", () => {
    assert.equal(r.loop1.loop_on, true);
    assert.equal(r.loop1.loop_label, "Repeat queue");
    assert.equal(r.loop1.badge_hidden, true, "the queue mode must NOT show the 1 badge");

    assert.equal(r.loop2.loop_on, true);
    assert.equal(r.loop2.loop_label, "Repeat track");
    assert.equal(r.loop2.badge_hidden, false, "repeat-one is only distinguishable by the badge");

    assert.equal(r.loop3.loop_on, false);
    assert.equal(r.loop3.loop_label, "Repeat off");
    assert.equal(r.loop3.badge_hidden, true);
  });

  await t.test("Roon Radio drives the zone from Settings → Playback", () => {
    assert.equal(r.rr_found, true, "#roon-radio-toggle is missing from Settings");
    assert.equal(r.rr_in_playback, true, "the switch is not inside the Playback pane");
    assert.equal(r.rr_beside_random, true,
      "Roon Radio is not in the same block as Random album radio — the point " +
      "of the move is that the two mutually exclusive switches are read together");
    assert.equal(r.rr_checked_before, false);
    assert.equal(r.rr_checked_after, true);
  });

  await t.test("and still says the app's own radio stands down", () => {
    // The transport button raised this notice; the switch must too, or the
    // other radio silently flips itself off with no explanation.
    assert.match(String(r.radio_toast), /Roon Radio on/);
    assert.match(String(r.radio_toast), /Random Album Radio/);
  });

  await t.test("every click sends the concrete state it wants, never a toggle", () => {
    // This is the assertion that keeps the UI honest about a rejected change:
    // the client must not be tracking its own idea of the mode.
    assert.deepEqual(r.posts_np, [
      { zone_or_output_id: "z1", shuffle: true },
      { zone_or_output_id: "z1", shuffle: false },
      { zone_or_output_id: "z1", loop: "loop" },
      { zone_or_output_id: "z1", loop: "loop_one" },
      { zone_or_output_id: "z1", loop: "disabled" },
    ]);
    // The switch sends the same concrete body the button did, from its own
    // call site — it does not go through changeZoneSettings().
    assert.deepEqual(r.posts[r.posts.length - 1],
      { zone_or_output_id: "z1", auto_radio: true });
  });

  await t.test("the transport row fits a 360px phone", () => {
    assert.equal(r.row_overflow, 0,
      `.np-transport overflows by ${r.row_overflow}px — the row scrolls or clips`);
    assert.equal(r.row_inside_viewport, true, ".np-transport extends past the viewport");
    // Squashed circles are the other failure: flex must not shrink them.
    for (const s of r.row_sizes) {
      assert.equal(s.w, s.h, `${s.id} is ${s.w}x${s.h} — not round, so flex squashed it`);
      assert.ok(s.w >= 38, `${s.id} is only ${s.w}px wide — below a usable tap target`);
    }
    assert.equal(r.row_sizes.length, 5, "expected shuffle · prev · play · next · repeat");
  });
});
