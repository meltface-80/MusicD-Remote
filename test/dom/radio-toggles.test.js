"use strict";
// ---------------------------------------------------------------------------
// v1.7.75: how the two radio switches REACT.
//
// v1.7.74 made the exclusivity rule visible — turning one radio on moves both
// switches. It got the state right and the reaction wrong, in the three ways a
// control that waits on a remote Core can be wrong:
//
//   1. The other switch only moved when the Core answered. Between the tap and
//      that answer both switches read ON — the exact state the rule exists to
//      prevent, on display, for as long as the Core takes.
//   2. The two switches POST to DIFFERENT endpoints and nothing held them
//      apart, so two quick taps put two writes in flight and the older answer
//      painted last. The switches settled on the tap before last.
//   3. Neither route answers until Roon's callback fires. A Core that drops
//      mid-call never settles the promise, and the serialisation that fixes (2)
//      turns that into switches wedged for the life of the page.
//
// Each test below drives one of those, with the server's timing arranged so a
// missing fix fails deterministically rather than by luck.
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

// A server that holds both halves of the rule and can be made slow, or made to
// hang. `__ownDelay` / `__roonDelay` are per-endpoint so a test can make the
// FIRST tap answer slower than the second — without that inversion an
// unserialised client still lands in the right order by accident.
const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
window.__posts = [];
window.__ownRadioOn = false;
window.__ownDelay = 0;
window.__roonDelay = 0;
window.__hang = false;
window.__zoneReads = 0;
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}

function __hangOrDelay(opts, ms, build) {
  // Never settles on its own, but honours the abort signal — what a real fetch
  // does, and the only reason a bounded caller can recover.
  if (window.__hang) return new Promise(function (res, rej) {
    if (opts && opts.signal) {
      opts.signal.addEventListener("abort", function () {
        rej(new DOMException("Aborted", "AbortError"));
      });
    }
  });
  return new Promise(function (res) {
    setTimeout(function () {
      res(new Response(JSON.stringify(build()),
          { status: 200, headers: { "Content-Type": "application/json" } }));
    }, ms);
  });
}

window.__installFetch(function (url, opts) {
  var post = opts && opts.method === "POST";

  if (url.indexOf("/api/zone-settings") > -1 && post) {
    var body = JSON.parse(opts.body || "{}");
    window.__posts.push(body);
    return __hangOrDelay(opts, window.__roonDelay, function () {
      var s = window.__zone.settings;
      if (body.shuffle !== undefined)    s.shuffle = body.shuffle;
      if (body.loop !== undefined)       s.loop = body.loop;
      if (body.auto_radio !== undefined) s.auto_radio = body.auto_radio;
      // The server's rule, applied when the Core answers — not when asked.
      if (window.__ownRadioOn && body.auto_radio === true) window.__ownRadioOn = false;
      return { ok: true, radios: { own: window.__ownRadioOn, roon: !!s.auto_radio } };
    });
  }
  if (url.indexOf("/api/radio") > -1) {
    if (post) {
      var rb = JSON.parse(opts.body || "{}");
      window.__posts.push(rb);
      return __hangOrDelay(opts, window.__ownDelay, function () {
        window.__ownRadioOn = !!rb.enabled;
        if (window.__ownRadioOn) window.__zone.settings.auto_radio = false;
        return { ok: true, enabled: window.__ownRadioOn,
                 radios: { own: window.__ownRadioOn,
                           roon: !!window.__zone.settings.auto_radio } };
      });
    }
    return window.__json({ enabled: window.__ownRadioOn, zones: [] });
  }
  if (url.indexOf("/api/zone-state") > -1) {
    window.__zoneReads++;
    return window.__json({ zone: window.__zone });
  }
  if (url.indexOf("/api/zones") > -1)   return window.__json({ zones: [window.__zone] });
  if (url.indexOf("/api/queue") > -1)   return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1) return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)   return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)  return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;

// Opens Settings -> Playback, where both switches live.
const OPEN_PLAYBACK = `
  // Both switches describe the SELECTED zone, and the read is skipped while the
  // select is still empty — so wait for the zone list to land first. Without
  // this the switches sit at their markup default and every test below is
  // asserting against the wrong thing.
  var zsel = document.getElementById("zone-select");
  for (var __i = 0; __i < 60 && !(zsel && zsel.value); __i++) {
    await window.__sleep(50);
    zsel = document.getElementById("zone-select");
  }
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="playback"]').click();
  await window.__sleep(250);
  var ra = document.getElementById("radio-toggle");
  var rr = document.getElementById("roon-radio-toggle");
  function state() { return { ra: !!ra.checked, rr: !!rr.checked }; }
`;

test("the other switch moves on the tap, not on the Core's answer", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Our radio is on; the Core will take 800ms to accept Roon Radio. The switch
  // the user did NOT touch must already have moved well before that.
  const r = harness.renderPage({
    name: "radio-optimistic", windowSize: "390x844", stub: STUB,
    driver: `
      window.__ownRadioOn = true;
      window.__roonDelay = 800;
      ${OPEN_PLAYBACK}
      T("before", state());
      rr.click();
      await window.__sleep(60);       // far inside the 800ms Core round trip
      T("during", state());
      await window.__sleep(1200);     // and after it
      T("after", state());
      T("posts", window.__posts);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the pane opens showing the zone's real state", () => {
    assert.deepEqual(r.before, { ra: true, rr: false });
  });

  await t.test("Random album radio is already off mid-flight", () => {
    assert.deepEqual(r.during, { ra: false, rr: true },
      "the switch the user did not touch waited for the Core. For that whole " +
      "round trip both switches read ON — the state the rule exists to prevent");
  });

  await t.test("and the server's answer agrees, so nothing springs back", () => {
    assert.deepEqual(r.after, { ra: false, rr: true });
  });

  await t.test("one write per tap — the client never writes the other radio", () => {
    // Switching the other radio off is the server's job. A client that did it
    // too would hide a server that had stopped doing it.
    assert.deepEqual(r.posts, [{ zone_or_output_id: "z1", auto_radio: true }]);
  });
});

test("fast alternating taps settle on the last one", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The FIRST tap's endpoint is the slow one. Unserialised, both writes are in
  // flight together, the slow first answer lands last and paints the state the
  // user has already moved on from — so this fails deterministically without
  // the queue, rather than depending on which way the race happened to fall.
  const r = harness.renderPage({
    name: "radio-race", windowSize: "390x844", stub: STUB,
    driver: `
      window.__ownDelay  = 900;   // tap 1: Random album radio on
      window.__roonDelay = 50;    // tap 2: Roon Radio on
      ${OPEN_PLAYBACK}
      T("before", state());
      ra.click();
      await window.__sleep(40);
      rr.click();
      await window.__sleep(2500);  // both answers long since in
      T("after", state());
      T("posts", window.__posts);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("both switches end on the tap the user made last", () => {
    assert.deepEqual(r.after, { ra: false, rr: true },
      "the switches settled on the tap BEFORE last — the slower first answer " +
      "painted after the second, so the writes were not serialised or the " +
      "stale answer was not discarded");
  });

  await t.test("and both taps still reached the server, in order", () => {
    assert.deepEqual(r.posts, [
      { zone: "z1", enabled: true },
      { zone_or_output_id: "z1", auto_radio: true },
    ], "a tap was dropped, or they were sent out of order");
  });
});

test("a hung request does not wedge the switches", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Neither route answers until Roon's callback fires, so a dropped Core hangs
  // the request forever. Serialising the writes is what makes that fatal: every
  // later tap queues behind one that will never return.
  const r = harness.renderPage({
    name: "radio-hang", windowSize: "390x844", budgetMs: 30000, stub: STUB,
    driver: `
      ${OPEN_PLAYBACK}
      window.__hang = true;
      ra.click();                    // hangs; the 5s timeout must abort it
      await window.__sleep(6000);
      window.__hang = false;
      rr.click();                    // must still reach the server
      await window.__sleep(1200);
      T("posts", window.__posts);
      T("after", state());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("a later tap still reaches the server", () => {
    assert.equal(r.posts.length, 2,
      "the second tap never went out — the first request is still holding the " +
      "queue, so the switches are dead for the life of the page");
    assert.deepEqual(r.posts[1], { zone_or_output_id: "z1", auto_radio: true });
  });

  await t.test("and it paints", () => {
    assert.deepEqual(r.after, { ra: false, rr: true });
  });
});

test("the switches follow the zone selector", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The switches describe the SELECTED zone. Nothing re-read them when it
  // changed, so they kept showing the previous zone's radios — and the next tap
  // wrote that stale reading to the new zone.
  const r = harness.renderPage({
    name: "radio-zone-change", windowSize: "390x844", stub: STUB,
    driver: `
      ${OPEN_PLAYBACK}
      T("before", state());
      // The other zone has the opposite pair on.
      window.__ownRadioOn = true;
      window.__zone.settings.auto_radio = false;
      var reads = window.__zoneReads;
      zsel.dispatchEvent(new Event("change", { bubbles: true }));
      await window.__sleep(700);
      T("after", state());
      T("reread", window.__zoneReads > reads);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("changing zone re-reads both switches", () => {
    assert.equal(r.reread, true, "no read was issued for the newly selected zone");
    assert.deepEqual(r.after, { ra: true, rr: false },
      "the switches still show the previous zone's radios");
  });
});
