"use strict";
// ---------------------------------------------------------------------------
// v1.8.66: flipping between the remote and the wall display, and the timer
// that goes back to the display when the remote is left alone.
//
// Asked for on the Roon forum by someone with both pages on one iPad in a
// kiosk browser: "I'd love to have a gesture and/or control so I could flip
// back and forth between them … and if there were a way to set a timer within
// the application so that after a certain time it went back to the display".
//
// Leaving the page is the whole feature, and a page that leaves cannot report
// anything — so every test catches the navigation instead (the Navigation
// API's `navigate` event, cancelled), records where it was going and when, and
// carries on. Nothing in the app is there for the tests' sake.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  settings: { shuffle: false, loop: "disabled", auto_radio: false }, queue_items_remaining: 1,
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: {
    three_line: { line1: "So What", line2: "Miles Davis", line3: "Kind of Blue" },
    line1: "So What", line2: "Miles Davis", line3: "Kind of Blue",
    image_key: "k", artists: [], length: 300, seek_position: 3,
  },
};

// Catches every navigation the page starts: where to, how, and when.
const CATCH = `
window.__went = [];
window.__t0 = Date.now();
navigation.addEventListener("navigate", function (e) {
  window.__went.push({ url: e.destination.url, type: e.navigationType,
                       at: Math.round((Date.now() - window.__t0) / 1000) });
  if (e.cancelable) e.preventDefault();
});
`;

// The remote. `display` is the server's wall-display switch; `idle` the
// per-device timer in minutes (null: never set).
const remoteStub = (opts) => `
${CATCH}
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.removeItem("rra-home-cache-v1");
  ${opts.idle == null ? 'localStorage.removeItem("rra-display-idle");'
                      : 'localStorage.setItem("rra-display-idle", "' + opts.idle + '");'}
  // As the display leaves it when it hands back to a remote that loads afresh.
  sessionStorage.setItem("rra-display-from-remote", "1");
} catch (e) { /* storage is always there in this harness */ }
window.__displayOn = ${!!opts.display};
window.__rev = { snapshot: "1", library: "1", dates: "1", plays: "1", settings: "1",
                 labels: "1", picks: "1", discover: "1", day: "1" };
window.__installFetch(function (url) {
  if (url.indexOf("/api/live") > -1) return window.__json({ rev: JSON.parse(JSON.stringify(window.__rev)) });
  if (url.indexOf("/api/settings/display") > -1)
    return window.__json({ enabled: window.__displayOn, seconds: 10 });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  return undefined;
});
`;

const HELPERS = `
  function itemShown() {
    var el = document.getElementById("menu-item-display");
    return !!el && !el.classList.contains("hidden");
  }
  // A person touching the screen: down and up, so nothing is left "held".
  function touch() {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }
`;

test("the side menu opens the wall display in this tab, on this remote's zone", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "display-switch-menu", windowSize: "390x844", stub: remoteStub({ display: true }),
    driver: `
      ${HELPERS}
      await window.__sleep(1500);
      T("mark_on_load", sessionStorage.getItem("rra-display-from-remote"));
      T("item_shown", itemShown());
      document.getElementById("menu-toggle").click();
      await window.__sleep(200);
      document.getElementById("menu-item-display").click();
      await window.__sleep(200);
      T("went", window.__went);
      T("mark", sessionStorage.getItem("rra-display-from-remote"));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("a remote that has loaded clears the tab's mark", () => {
    // The mark says "the page behind the display is the remote". Left set, a
    // display opened later in this tab some other way would go back to
    // whatever happens to be behind it.
    assert.equal(r.mark_on_load, null);
  });
  await t.test("the entry is offered while the wall display is on", () => {
    assert.equal(r.item_shown, true);
  });
  await t.test("it opens /display for this remote's zone, as a new history entry", () => {
    assert.equal(r.went.length, 1, "the menu entry did not leave for the display");
    assert.match(r.went[0].url, /\/display\?zone=z1$/);
    assert.equal(r.went[0].type, "push",
      "a replace would leave the display with no remote behind it to go back to");
  });
  await t.test("the tab is marked, so the display's Remote goes BACK rather than forward", () => {
    assert.equal(r.mark, "1");
  });
});

test("the menu entry follows the wall display switch, live", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "display-switch-live", windowSize: "390x844", stub: remoteStub({ display: false }),
    budgetMs: 30000,
    driver: `
      ${HELPERS}
      await window.__sleep(1500);
      T("off", itemShown());
      // Switched on from another device: the settings revision moves.
      window.__displayOn = true;
      window.__rev.settings = "2";
      await window.__sleep(4000);
      T("on", itemShown());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("hidden while the wall display is off — it would open a page that says only that", () => {
    assert.equal(r.off, false);
  });
  await t.test("shown once it is switched on anywhere, without leaving the screen", () => {
    assert.equal(r.on, true);
  });
});

test("left alone, the remote goes to the wall display after the chosen time", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "display-switch-idle", windowSize: "390x844", stub: remoteStub({ display: true, idle: 1 }),
    budgetMs: 240000,
    driver: `
      ${HELPERS}
      // A mouse resting on the page: browsers send moves of their own when the
      // page changes under it (the progress bar does, four times a second), at
      // the same point every time. Those are not a person.
      var ticker = setInterval(function () {
        document.body.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, clientY: 300, bubbles: true }));
      }, 5000);
      await window.__sleep(40000);
      touch();                                   // at 40s: the count starts again
      await window.__sleep(30000);
      T("by_70s", window.__went.length);         // 30s since the touch — not yet
      await window.__sleep(35000);
      T("by_105s", window.__went.slice());       // 65s since the touch — gone at 100s
      // Back from the display: a page the browser kept is shown again with the
      // clock it left with. The count must start from the return.
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      T("mark_after_return", sessionStorage.getItem("rra-display-from-remote"));
      await window.__sleep(30000);
      T("by_135s", window.__went.length);
      await window.__sleep(40000);
      T("by_175s", window.__went.slice());
      clearInterval(ticker);
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("not before the time has passed since the LAST touch", () => {
    assert.equal(r.by_70s, 0, "it counted from the page load, not from the last touch");
  });
  await t.test("then it goes, to this remote's zone — a resting mouse is not a person", () => {
    assert.equal(r.by_105s.length, 1,
      "it never went to the display (moves at one point, which a resting mouse makes, kept it awake?)");
    assert.match(r.by_105s[0].url, /\/display\?zone=z1$/);
    assert.ok(r.by_105s[0].at >= 99 && r.by_105s[0].at <= 101,
      "it went at " + r.by_105s[0].at + "s; a minute after the touch at 40s is 100s");
  });
  await t.test("coming back counts as a touch, and spends the tab's mark", () => {
    assert.equal(r.mark_after_return, null);
    assert.equal(r.by_135s, 1,
      "it went straight back to the display: the clock still said it had been idle since 40s");
    assert.equal(r.by_175s.length, 2);
    assert.ok(r.by_175s[1].at >= 164 && r.by_175s[1].at <= 167,
      "the second trip went at " + r.by_175s[1].at + "s; a minute after the return at 105s is 165s");
  });
});

test("the timer never throws work away, and does nothing while the display is off", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const held = harness.renderPage({
    name: "display-switch-held", windowSize: "390x844", stub: remoteStub({ display: true, idle: 1 }),
    budgetMs: 200000,
    driver: `
      ${HELPERS}
      await window.__sleep(1500);
      document.getElementById("settings-toggle").click();
      await window.__sleep(300);
      T("settings_open", !document.getElementById("settings-overlay").classList.contains("hidden"));
      await window.__sleep(100000);
      T("while_open", window.__went.length);
      // Closed without a touch (as if by the server, or a script): the page has
      // been left alone all along, so it may go almost at once.
      document.getElementById("settings-overlay").classList.add("hidden");
      var closedAt = Math.round((Date.now() - window.__t0) / 1000);
      await window.__sleep(20000);
      T("after_close", window.__went.slice());
      T("closed_at", closedAt);
    `,
  });
  harness.assertNoPageError(assert, held);

  const sheet = harness.renderPage({
    name: "display-switch-sheet", windowSize: "390x844", stub: remoteStub({ display: true, idle: 1 }),
    budgetMs: 200000,
    driver: `
      await window.__sleep(1500);
      window.__openImportSheet();                // a pasted playlist and its result live here
      await window.__sleep(300);
      T("sheet_open", !!document.querySelector(".lib-sheet-backdrop"));
      await window.__sleep(100000);
      T("while_open", window.__went.length);
      document.querySelector(".lib-sheet-backdrop").remove();
      await window.__sleep(20000);
      T("after_close", window.__went.length);
    `,
  });
  harness.assertNoPageError(assert, sheet);

  const off = harness.renderPage({
    name: "display-switch-off", windowSize: "390x844", stub: remoteStub({ display: false, idle: 1 }),
    budgetMs: 200000,
    driver: `
      await window.__sleep(150000);
      T("went", window.__went.length);
    `,
  });
  harness.assertNoPageError(assert, off);

  const never = harness.renderPage({
    name: "display-switch-never", windowSize: "390x844", stub: remoteStub({ display: true }),
    budgetMs: 200000,
    driver: `
      await window.__sleep(150000);
      T("went", window.__went.length);
      T("select", document.getElementById("display-idle-select").value);
    `,
  });
  harness.assertNoPageError(assert, never);

  await t.test("it waits while Settings is open", () => {
    assert.equal(held.settings_open, true);
    assert.equal(held.while_open, 0, "it left with Settings open");
  });
  await t.test("and goes soon after it closes, without starting the count over", () => {
    assert.equal(held.after_close.length, 1, "it never went once Settings was closed");
    assert.ok(held.after_close[0].at - held.closed_at <= 16,
      "it took " + (held.after_close[0].at - held.closed_at) + "s after Settings closed");
  });
  await t.test("and while a sheet is open — an import's result is not thrown away", () => {
    assert.equal(sheet.sheet_open, true);
    assert.equal(sheet.while_open, 0, "it left with the import sheet open");
    assert.equal(sheet.after_close, 1);
  });
  await t.test("with the wall display off it never goes", () => {
    assert.equal(off.went, 0);
  });
  await t.test("never set means never — the default on every device", () => {
    assert.equal(never.went, 0);
    assert.equal(never.select, "0");
  });
});

// ---- The display's way back ------------------------------------------------

const DISPLAY_STUB = `
${CATCH}
window.__installFetch(function (u) {
  if (u.indexOf("/api/settings/display") > -1) return window.__json({ enabled: true, seconds: 20 });
  if (u.indexOf("/api/settings/waveform") > -1) return window.__json({ enabled: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE)} });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [${JSON.stringify(ZONE)}] });
  // Everything the display can find, so all six mode chips are drawn — the
  // widest the bar it shares the top of the screen with can be.
  if (u.indexOf("/api/display/content") > -1)
    return window.__json({
      artistPhotos: ["p1.jpg"],
      review: { text: "A record.", attribution: "Somebody" },
      bios: [{ name: "Miles Davis", text: "A trumpeter.", attribution: "Wikipedia" }],
      moreAlbums: { artist: { name: "Miles Davis", albums: [{ offset: 1, title: "Milestones", image_key: "m" }] } },
    });
  return undefined;
});
`;

const DISPLAY_DRIVER = `
  var bar = document.getElementById("bottombar");
  for (var i = 0; i < 60 && bar.classList.contains("hidden"); i++) await window.__sleep(100);
  await window.__sleep(1500);
  var btn = document.getElementById("to-remote");
  function hitsButton() {
    var b = btn.getBoundingClientRect();
    var el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!el && (el === btn || btn.contains(el));
  }
  T("hidden_hit", hitsButton());
  // A tap anywhere reveals the controls (pointerdown, as display.js listens).
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await window.__sleep(100);
  T("shown_hit", hitsButton());
  var b = btn.getBoundingClientRect();
  var chips = document.getElementById("controls").getBoundingClientRect();
  T("chips", document.querySelectorAll("#controls .ctl-btn").length);
  T("rects", { btn: { l: b.left, r: b.right, t: b.top, b: b.bottom },
               bar: { l: chips.left, r: chips.right, t: chips.top, b: chips.bottom } });
`;

function overlaps(a, b) {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

test("the display's Remote button goes back to the remote", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "display-switch-back", windowSize: "390x844", page: "display", stub: DISPLAY_STUB,
    budgetMs: 30000,
    driver: `
      ${DISPLAY_DRIVER}
      // Opened directly — a kiosk's start page: there is no remote behind it.
      btn.click();
      await window.__sleep(100);
      T("direct", window.__went.slice());

      // Opened by the remote: the tab is marked and the remote is one entry back.
      sessionStorage.setItem("rra-display-from-remote", "1");
      if (history.length < 2) history.pushState({}, "");
      window.__backs = 0;
      history.back = function () { window.__backs++; };   // a back that goes nowhere
      btn.click();
      await window.__sleep(100);
      T("backs", window.__backs);
      T("after_back", window.__went.length);
      await window.__sleep(3200);
      T("fallback", window.__went.slice());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("hidden, it takes no taps — the tap that reveals it cannot also leave", () => {
    assert.equal(r.hidden_hit, false);
    assert.equal(r.shown_hit, true);
  });
  await t.test("opened directly, it loads the remote", () => {
    assert.equal(r.direct.length, 1);
    assert.match(r.direct[0].url, /^file:\/\/\/$/);
  });
  await t.test("opened by the remote, it goes BACK to it — and loads one if back goes nowhere", () => {
    assert.equal(r.backs, 1, "it loaded a new remote instead of returning to the one that opened it");
    assert.equal(r.after_back, 1, "it went back AND forward at once");
    assert.equal(r.fallback.length, 2, "a back that went nowhere left the display stranded");
    assert.match(r.fallback[1].url, /^file:\/\/\/$/);
  });
  await t.test("on a phone the mode chips drop below it rather than over it", () => {
    assert.equal(r.chips, 6);
    assert.ok(!overlaps(r.rects.btn, r.rects.bar),
      "the Remote button and the mode chips overlap: " + JSON.stringify(r.rects));
  });
});

test("on an iPad the chips stay at the top, clear of the Remote button", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "display-switch-ipad", windowSize: "834x1112", page: "display", stub: DISPLAY_STUB,
    budgetMs: 30000,
    driver: DISPLAY_DRIVER,
  });
  harness.assertNoPageError(assert, r);
  await t.test("one row across the top, neither covering the other", () => {
    assert.equal(r.chips, 6);
    assert.ok(Math.abs(r.rects.bar.t - r.rects.btn.t) < 12,
      "the chips moved down on a screen wide enough for both: " + JSON.stringify(r.rects));
    assert.ok(!overlaps(r.rects.btn, r.rects.bar),
      "the Remote button and the mode chips overlap: " + JSON.stringify(r.rects));
  });
});
