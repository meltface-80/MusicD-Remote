"use strict";
// ---------------------------------------------------------------------------
// v1.8.74: the HQPlayer screen and Settings → HQPlayer, in the real page.
//
// The answers the page is fed are not hand-written: they are produced, before
// the browser starts, by the real /api/hqp handlers driving the fake HQPlayer
// (lib/hqp/fake.js, a Mac in SDM playing at DSD1024). So the shapes these
// tests stub are the shapes the server sends, and a change to one is a change
// to the other.
//
// What is pinned is what the person looking at the screen relies on:
//   * it says what HQPlayer is doing — the output rate, the mode, the source,
//     whether it is keeping up — and what each control is set to, with a tick
//     where HQPlayer reports that choice is the one running;
//   * a pick sends a change BY NAME, as JSON (the server refuses anything
//     else from a page), and what came back is said in words — including a
//     change that was undone because playback stopped;
//   * a choice HQPlayer's rules say will not play is marked before it is
//     tapped, and still allowed: the screen warns, it never blocks;
//   * leaving the screen stops the polling, which is what lets the server stop
//     asking HQPlayer;
//   * switched off, or not set up, the screen says so and offers the way in.
// ---------------------------------------------------------------------------

require("../lib/no-real-hqplayer");
const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");
const { FakeHqp, loadProfile } = require("../../lib/hqp/fake");
const { createHqpService } = require("../../lib/hqp/service");

const FAST = { graceMs: 50, healthyMs: 150, maxMs: 600, sampleMs: 20, minSpeed: 0.85, stoppedMs: 150 };

// Real answers, from the real handlers against the fake.
async function fixtures() {
  const fake = new FakeHqp(loadProfile("desktop5-mac-sdm"), { timeScale: 0 });
  await fake.listen();
  let saved = { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port };
  const zones = { z1: { zone_id: "z1", display_name: "Lounge", state: "playing",
    outputs: [{ output_id: "o1", source_controls: [{ display_name: "HQPlayer" }] }],
    now_playing: { image_key: "k1", three_line: { line1: "So What", line2: "Miles Davis", line3: "Kind of Blue" } } } };
  const svc = createHqpService({
    dataDir: null, getSettings: () => saved,
    saveSettings: (p) => { saved = Object.assign({}, saved, p); return true; },
    zones: () => zones, pollMs: 30, speedWindowMs: 300,
    timing: { quick: FAST, major: Object.assign({}, FAST, { maxMs: 800 }) },
  });
  const call = async (m, p, b) => (await svc.dispatch({ method: m, path: p, headers: { "content-type": "application/json" }, body: b })).body;
  // Closed whatever happens: a fake left listening would keep the run from exiting.
  try {
    return await record(call);
  } finally {
    await svc.close();
    await fake.close();
  }
}

async function record(call) {
  const fx = {};
  await call("POST", "/presets", { name: "DSD1024 xla", fromCurrent: true });
  await call("POST", "/presets", { name: "PCM 384k", settings: { mode: "PCM", rate: 384000, shaper: "NS5" } });
  await call("GET", "/now");
  await new Promise((r) => setTimeout(r, 450));       // fill the speed window
  fx.now = await call("GET", "/now");
  fx.caps = await call("GET", "/capabilities");
  fx.presets = await call("GET", "/presets");
  fx.change = await call("POST", "/change", { shaper: "ASDM7EC" });
  fx.nowAfter = await call("GET", "/now");
  // A fixed DSD512: AHM7EC8B is now predicted not to play, and saying so is the picker's job.
  await call("POST", "/change", { rate: 22579200 });
  fx.capsDsd512 = await call("GET", "/capabilities");
  await new Promise((r) => setTimeout(r, 120));      // let the poller see it
  fx.nowDsd512 = await call("GET", "/now");
  // The measured stall, applied anyway: it is undone, and the answer says so.
  fx.rollback = await call("POST", "/change", { shaper: "AHM7EC8B" });
  return fx;
}

let FX = null;
async function fx() {
  if (!FX) FX = await fixtures();
  return FX;
}

// The page's API, from the fixtures. `over` replaces any of them.
function stub(f, over) {
  return `
window.__fx = ${JSON.stringify(Object.assign({}, f, over || {}))};
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u, opts) {
  var m = (opts && opts.method) || "GET";
  if (m !== "GET") {
    var h = (opts && opts.headers) || {};
    window.__posts.push({ url: u, method: m, type: h["Content-Type"] || h["content-type"] || "", body: opts && opts.body ? JSON.parse(opts.body) : null });
  }
  if (u.indexOf("/api/hqp/now") > -1) {
    // nowDelay: the status is the one the server held when it was ASKED,
    // delivered that much later.
    var snap = window.__fx.now;
    if (!window.__fx.nowDelay) return window.__json(snap);
    return new Promise(function (res) { setTimeout(function () { res(window.__json(snap)); }, window.__fx.nowDelay); });
  }
  if (u.indexOf("/api/hqp/capabilities") > -1) {
    if (window.__fx.capsAnswer) return window.__json(window.__fx.capsAnswer.body, window.__fx.capsAnswer.status);
    return window.__json(window.__fx.caps);
  }
  if (u.indexOf("/api/hqp/presets") > -1 && m === "GET") return window.__json(window.__fx.presets);
  if (u.indexOf("/api/hqp/settings") > -1 && m === "GET") return window.__json(window.__fx.settings || { enabled: true, host: "192.0.2.10", port: 4321, demo: false, learned_count: 0 });
  if (u.indexOf("/api/hqp/change") > -1) {
    // What the server reports from then on, as it would after this change.
    window.__fx.now = window.__fx.nowAfter || window.__fx.now;
    if (window.__fx.changeAnswer) return window.__json(window.__fx.changeAnswer.body, window.__fx.changeAnswer.status);
    return window.__json(window.__fx.change);
  }
  if (u.indexOf("/api/update/status") > -1) return window.__json({ is_docker: true, available: false });
  if (u.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1) return window.__json({});
  return undefined;
});`;
}

const OPEN = `
  await window.__sleep(700);
  document.getElementById("menu-toggle").click();
  await window.__sleep(300);
  var item = document.getElementById("menu-item-hqplayer");
  T("menu_shown", !item.classList.contains("hidden"));
  item.click();
  await window.__sleep(2000);
  window.__text = function (sel) { var e = document.querySelector(sel); return e ? e.textContent : null; };
  window.__shown = function (sel) {
    var e = document.querySelector(sel);
    return !!e && !e.closest(".hidden") && getComputedStyle(e).display !== "none";
  };
  window.__nowCalls = function () { return window.__callsMatching("/api/hqp/now"); };
`;

const render = (name, stubSrc, driver, size) =>
  harness.renderPage({ name, stub: stubSrc, driver: OPEN + driver, windowSize: size || "390x844", budgetMs: 30000 });

// A volume change's answer, and the status that follows it.
const volAnswer = (f, v) => Object.assign({}, f.change, {
  results: [{ field: "volume", requested: v, actual: v, applied: true, reply: { kind: "ok" } }],
  playback: { kind: "not-checked", detail: "this change can't stop playback" },
  state: Object.assign({}, f.now.snapshot.state, { volume: v }),
});
const nowAtVolume = (f, v) => Object.assign({}, f.now, {
  snapshot: { status: f.now.snapshot.status, state: Object.assign({}, f.now.snapshot.state, { volume: v }) },
});

test("the screen says what HQPlayer is doing (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-screen", stub(f), `
    T("rate", __text(".hqp-rate"));
    T("state", __text(".hqp-state"));
    T("sub", __text(".hqp-sub"));
    T("health", __text(".hqp-health"));
    T("name", __text(".hqp-name"));
    T("track", __shown(".hqp-track") ? __text(".hqp-track-title") + " / " + __text(".hqp-track-sub") : null);
    T("vol", __text(".hqp-vol-out"));
    T("slider", { min: document.querySelector(".hqp-vol-slider").min, max: document.querySelector(".hqp-vol-slider").max,
                  value: document.querySelector(".hqp-vol-slider").value });
    var rows = {};
    document.querySelectorAll(".hqp-row").forEach(function (b) {
      var v = b.querySelector(".hqp-row-value");
      rows[b.dataset.field] = { label: b.querySelector(".hqp-row-label").firstChild.textContent, value: v.textContent,
                                taken: v.dataset.taken || "", inUse: !b.querySelector(".hqp-row-hint").classList.contains("hidden") };
    });
    T("rows", rows);
    T("title", __text("#count-text"));
    T("notice", __shown(".hqp-notice"));
    T("foot", __text(".hqp-foot"));
  `);
  harness.assertNoPageError(assert, r);

  await t.test("THE one: the output rate, the mode, the source and the state", () => {
    assert.equal(r.menu_shown, true, "the side menu has no HQPlayer entry though it is switched on");
    assert.equal(r.notice, false, "a notice is covering the screen");
    assert.equal(r.rate, "DSD1024");
    assert.equal(r.state, "Playing");
    assert.equal(r.sub, "SDM (DSD) · from 44.1 kHz / 24-bit · fed by Roon");
    assert.equal(r.health, "Keeping up with real time ✓");
    assert.equal(r.name, "fake-mac");
  });
  await t.test("the Roon zone playing through it, by name", () => {
    assert.equal(r.track, "So What / Miles Davis · Kind of Blue");
  });
  await t.test("the volume, as a float in dB, inside HQPlayer's own range", () => {
    assert.equal(r.vol, "-22.0 dB");
    assert.deepEqual(r.slider, { min: "-60", max: "-3", value: "-22" });
  });
  await t.test("each control shows its setting, and which one HQPlayer reports running", () => {
    assert.deepEqual(r.rows.filter1x, { label: "1x filter", value: "poly-sinc-gauss-xla", taken: "yes", inUse: true });
    assert.deepEqual(r.rows.filterNx, { label: "Nx filter", value: "poly-sinc-gauss-hires-lp", taken: "", inUse: false });
    assert.deepEqual(r.rows.shaper, { label: "Modulator", value: "AHM7EC8B", taken: "yes", inUse: false });
    assert.equal(r.rows.presets.value, "✓ DSD1024 xla", "the preset in effect is not named");
  });
  await t.test("the non-affiliation notice and the credit are on the screen", () => {
    assert.match(r.foot, /hqpweb by statelycurmudgeon \(MIT\)/);
    assert.match(r.foot, /Not affiliated with, endorsed by, or supported by Signalyst/);
  });
});

test("a pick sends a change by name, as JSON, and says what happened (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-pick", stub(f), `
    document.querySelector('.hqp-row[data-field="shaper"]').click();
    await window.__sleep(400);
    var items = Array.prototype.slice.call(document.querySelectorAll(".lib-sheet .hqp-pick-item"));
    T("sheet_title", __text(".lib-sheet-head h3"));
    T("items", items.length);
    T("current", items.filter(function (b) { return b.classList.contains("is-current"); }).map(function (b) { return b.dataset.name; }));
    var search = document.querySelector(".hqp-pick-search");
    search.value = "asdm7ec-fast";
    search.dispatchEvent(new Event("input"));
    T("filtered", items.filter(function (b) { return !b.classList.contains("hidden"); }).map(function (b) { return b.dataset.name; }));
    search.value = "";
    search.dispatchEvent(new Event("input"));
    items.find(function (b) { return b.dataset.name === "ASDM7EC"; }).click();
    await window.__sleep(1200);
    T("sheet_after", !!document.querySelector(".lib-sheet"));
    T("posts", window.__posts);
    T("msg", __text(".hqp-msg"));
    T("msg_kind", document.querySelector(".hqp-msg").dataset.kind);
    T("undo", __shown(".hqp-undo"));
    T("shaper", __text('.hqp-row[data-field="shaper"] .hqp-row-value'));
    document.querySelector(".hqp-undo").click();
    await window.__sleep(600);
    T("undo_post", window.__posts[window.__posts.length - 1]);
  `);
  harness.assertNoPageError(assert, r);

  await t.test("the picker lists every modulator, ticks the current one, and searches", () => {
    assert.equal(r.sheet_title, "Modulator");
    assert.equal(r.items, 36);
    assert.deepEqual(r.current, ["AHM7EC8B"]);
    assert.deepEqual(r.filtered, ["ASDM7EC-fast", "ASDM7EC-fast 512+fs"]);
  });
  await t.test("THE one: the change is a JSON POST carrying the NAME, never an index", () => {
    assert.equal(r.sheet_after, false, "the sheet stayed open after a pick");
    const change = r.posts.filter((p) => /\/api\/hqp\/change$/.test(p.url));
    assert.equal(change.length, 1, JSON.stringify(r.posts));
    assert.deepEqual(change[0].body, { shaper: "ASDM7EC" });
    assert.equal(change[0].type, "application/json", "the server refuses a write that is not JSON");
  });
  await t.test("what came back is said in words, with undo on offer", () => {
    assert.equal(r.msg_kind, "ok");
    assert.equal(r.msg, "✓ Modulator → ASDM7EC · playback OK");
    assert.equal(r.undo, true);
    assert.equal(r.shaper, "ASDM7EC", "the row still shows the old modulator");
  });
  await t.test("Undo is a JSON POST too", () => {
    assert.equal(r.undo_post.url, "/api/hqp/undo");
    assert.equal(r.undo_post.type, "application/json");
  });
});

test("a choice HQPlayer's rules say will not play is marked, and still allowed (v1.8.74)", async (t) => {
  const f = await fx();
  // After a rollback the server has nothing of the user's to undo, and says so.
  const after = Object.assign({}, f.nowDsd512, { undoAvailable: false });
  const r = render("hqp-warn", stub(f, { now: f.nowDsd512, nowAfter: after, caps: f.capsDsd512,
                                         changeAnswer: { status: 200, body: f.rollback } }), `
    document.querySelector('.hqp-row[data-field="shaper"]').click();
    await window.__sleep(400);
    T("current", (document.querySelector(".hqp-pick-item.is-current") || {}).dataset ? document.querySelector(".hqp-pick-item.is-current").dataset.name : null);
    var ahm = document.querySelector('.hqp-pick-item[data-name="AHM7EC8B"]');
    T("ahm_warn", ahm.classList.contains("is-warn"));
    T("ahm_why", ahm.querySelector(".hqp-pick-why") ? ahm.querySelector(".hqp-pick-why").textContent : null);
    var asdm = document.querySelector('.hqp-pick-item[data-name="ASDM7EC"]');
    T("asdm_why", asdm.querySelector(".hqp-pick-why") ? asdm.querySelector(".hqp-pick-why").textContent : null);
    T("ahm_disabled", ahm.disabled);
    var capsBefore = window.__callsMatching("/api/hqp/capabilities");
    ahm.click();
    await window.__sleep(1200);
    T("msg", __text(".hqp-msg"));
    T("msg_kind", document.querySelector(".hqp-msg").dataset.kind);
    T("undo", __shown(".hqp-undo"));
    T("caps_reread", window.__callsMatching("/api/hqp/capabilities") > capsBefore);
  `);
  harness.assertNoPageError(assert, r);

  await t.test("THE one: the warning is there before the tap", () => {
    assert.equal(r.current, "ASDM7EC", "precondition: the page is not in the DSD512 context the warning belongs to");
    assert.equal(r.ahm_warn, true);
    assert.match(r.ahm_why, /^⚠ won't play: AHM7EC8B needs ≥ 40\.96 MHz \(DSD1024\); 22\.5792 MHz stops playback$/);
    assert.equal(r.asdm_why, null, "a modulator that plays at DSD512 carries a warning");
  });
  await t.test("it warns, it never blocks", () => {
    assert.equal(r.ahm_disabled, false);
  });
  await t.test("the undone change is reported as undone, and why", () => {
    assert.equal(r.msg_kind, "warn");
    assert.match(r.msg, /^Undone: AHM7EC8B needs/);
    assert.match(r.msg, /Modulator back to ASDM7EC/);
    assert.match(r.msg, /Playback resumed\./);
    assert.match(r.msg, /one of HQPlayer's own rules, not a limit of this machine/);
    assert.equal(r.undo, false, "undo offered after a rollback — there is nothing of the user's to undo");
    assert.equal(r.caps_reread, true, "the warnings were not read again after a rollback");
  });
});

test("the volume buttons and slider (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-volume", stub(f, { changeAnswer: { status: 200, body: volAnswer(f, -21) } }), `
    document.querySelector(".hqp-vol-btn[aria-label^='Volume up']").click();
    await window.__sleep(500);
    T("up", window.__posts.filter(function (p) { return /change$/.test(p.url); }).map(function (p) { return p.body; }));
    T("after_up", __text(".hqp-vol-out"));
    window.__fx.changeAnswer = { status: 422, body: { error: "refusing to raise the volume by 17.0 dB in one step (max 6 dB)" } };
    var s = document.querySelector(".hqp-vol-slider");
    s.value = "-4";
    s.dispatchEvent(new Event("input"));
    T("draft", __text(".hqp-vol-out"));
    s.dispatchEvent(new Event("change"));
    await window.__sleep(500);
    T("slider_post", window.__posts[window.__posts.length - 1].body);
    T("refused", __text(".hqp-msg"));
    T("refused_kind", document.querySelector(".hqp-msg").dataset.kind);
    await window.__sleep(1800);
    T("slider_back", s.value);
  `);
  harness.assertNoPageError(assert, r);

  await t.test("+ asks for one dB more, by value", () => {
    assert.deepEqual(r.up, [{ volume: -21 }]);
    assert.equal(r.after_up, "-21.0 dB");
  });
  await t.test("the slider shows where it is being dragged, then asks", () => {
    assert.equal(r.draft, "-4.0 dB");
    assert.deepEqual(r.slider_post, { volume: -4 });
  });
  await t.test("THE one: a raise the server refuses is said, and the slider goes back to HQPlayer's real level", () => {
    assert.equal(r.refused_kind, "error");
    assert.match(r.refused, /refusing to raise the volume by 17\.0 dB/);
    assert.equal(r.slider_back, "-22", "the slider stayed where it was dragged, at a level HQPlayer never took");
  });
});

test("the screen says when there is nothing it can show (v1.8.74)", async (t) => {
  const f = await fx();
  const states = {
    off: { enabled: false, demo: false, configured: false },
    unset: { enabled: true, demo: false, configured: false },
    down: { enabled: true, demo: false, configured: true, address: "192.0.2.10", reachable: false,
            error: "connect ECONNREFUSED 192.0.2.10:4321", snapshot: null, roon: [] },
  };
  for (const [name, now] of Object.entries(states)) {
    await t.test(name, () => {
      const r = render("hqp-" + name, stub(f, { now }), `
        T("notice", __shown(".hqp-notice") ? __text(".hqp-notice-text") : null);
        T("error", document.querySelector(".hqp-notice").classList.contains("is-error"));
        T("panel", __shown(".hqp-panel"));
        T("button", __shown(".hqp-notice-btn"));
        document.querySelector(".hqp-notice-btn").click();
        await window.__sleep(400);
        var pane = document.querySelector('.settings-pane[data-pane="hqplayer"]');
        T("pane_open", !document.getElementById("settings-overlay").classList.contains("hidden") && !pane.classList.contains("hidden"));
      `);
      harness.assertNoPageError(assert, r);
      assert.equal(r.panel, false, "the controls are on screen with nothing behind them");
      assert.equal(r.button, true);
      assert.equal(r.pane_open, true, "the button did not open Settings → HQPlayer");
      if (name === "off") assert.match(r.notice, /switched off/);
      if (name === "unset") assert.match(r.notice, /Add your HQPlayer's address.*Demo HQPlayer/);
      if (name === "down") {
        assert.match(r.notice, /HQPlayer at 192\.0\.2\.10 isn't answering \(connect ECONNREFUSED/);
        assert.equal(r.error, true);
      } else {
        assert.equal(r.error, false);
      }
    });
  }
});

test("leaving the screen stops the polling (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-leave", stub(f), `
    var during = __nowCalls();
    await window.__sleep(3200);
    var later = __nowCalls();
    T("polled", later - during);
    document.getElementById("topbar-back").click();
    await window.__sleep(300);
    var left = __nowCalls();
    await window.__sleep(5000);
    T("after_leaving", __nowCalls() - left);
    T("screen_gone", !document.querySelector(".hqp-screen") || !document.body.contains(document.querySelector(".hqp-screen")) ||
                     document.getElementById("album-grid").classList.contains("hidden"));
  `);
  harness.assertNoPageError(assert, r);
  await t.test("it polls every 1.5 s while open", () => {
    assert.ok(r.polled >= 2, "only " + r.polled + " polls in 3.2 s");
  });
  await t.test("THE one: and not at all once it is left — which is what lets the server stop asking HQPlayer", () => {
    assert.equal(r.after_leaving, 0, "the HQPlayer screen kept polling after Back");
    assert.equal(r.screen_gone, true);
  });
});

test("a status asked for before a change, and answered after it, is not shown (v1.8.74)", async (t) => {
  // The screen shows what a change did the moment it is answered. A status
  // already on its way carries HQPlayer from BEFORE the change, and painted
  // over it, it put the old volume back on screen until the next poll.
  const f = await fx();
  const r = render("hqp-crossed", stub(f, { nowAfter: nowAtVolume(f, -21), changeAnswer: { status: 200, body: volAnswer(f, -21) } }), `
    window.__fx.nowDelay = 1000;
    await window.__sleep(1700);
    var c = __nowCalls();
    for (var i = 0; i < 150 && __nowCalls() === c; i++) await window.__sleep(20);
    T("poll_out", __nowCalls() > c);
    document.querySelector(".hqp-vol-btn[aria-label^='Volume up']").click();
    var seen = [];
    for (var k = 0; k < 40; k++) { await window.__sleep(100); seen.push(__text(".hqp-vol-out")); }
    T("seen", seen);
  `);
  harness.assertNoPageError(assert, r);
  await t.test("THE one: once the change is on screen, the status from before it never is", () => {
    assert.equal(r.poll_out, true, "precondition: no status was on its way when the change was made");
    const first = r.seen.indexOf("-21.0 dB");
    assert.ok(first > -1, "the change never showed: " + JSON.stringify(r.seen));
    assert.deepEqual(r.seen.slice(first).filter((v) => v !== "-21.0 dB"), [], "the old volume came back: " + JSON.stringify(r.seen));
  });
});

test("Back from an artist view brings the screen back live (v1.8.74)", async (t) => {
  // Now playing's artist link opens the artist view over whatever screen is
  // up; Back puts that screen's nodes back. The HQPlayer screen came back
  // frozen — leaving it had stopped its poll and nothing started it again.
  const f = await fx();
  const r = render("hqp-artist-back", stub(f), `
    T("rate_before", __text(".hqp-rate"));
    window.__showArtistAlbums("Miles Davis");
    await window.__sleep(800);
    var away = __nowCalls();
    await window.__sleep(3200);
    T("polls_away", __nowCalls() - away);
    document.getElementById("artist-back-btn").click();
    await window.__sleep(300);
    T("back", !!document.querySelector("#album-grid .hqp-screen"));
    window.__fx.now = window.__fx.nowDsd512;          // HQPlayer moved on meanwhile
    var back = __nowCalls();
    await window.__sleep(3200);
    T("polls_back", __nowCalls() - back);
    T("rate_after", __text(".hqp-rate"));
    // One artist view opened from another puts this screen back for a moment
    // and takes it away again: its poll must not run on behind the second.
    window.__showArtistAlbums("Miles Davis");
    await window.__sleep(500);
    window.__showArtistAlbums("John Coltrane");
    await window.__sleep(800);
    var chained = __nowCalls();
    await window.__sleep(3200);
    T("polls_chained", __nowCalls() - chained);
  `);
  harness.assertNoPageError(assert, r);
  await t.test("not polled while it is away", () => {
    assert.equal(r.rate_before, "DSD1024");
    assert.equal(r.polls_away, 0);
  });
  await t.test("THE one: polled again once it is back, and showing what HQPlayer does NOW", () => {
    assert.equal(r.back, true, "precondition: Back did not put the HQPlayer screen back");
    assert.ok(r.polls_back >= 2, "only " + r.polls_back + " polls in 3.2 s after Back");
    assert.equal(r.rate_after, "DSD512");
  });
  await t.test("and not behind a second artist view opened from the first", () => {
    assert.equal(r.polls_chained, 0);
  });
});

test("a screen where nothing moves is not rewritten by every poll (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-quiet", stub(f), `
    await window.__sleep(1600);
    var root = document.querySelector(".hqp-screen");
    var recs = [];
    var mo = new MutationObserver(function (l) { l.forEach(function (m) {
      recs.push(m.type + ":" + (m.attributeName || "") + ":" + (m.target.className || (m.target.parentNode && m.target.parentNode.className) || ""));
    }); });
    mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    var n0 = __nowCalls();
    await window.__sleep(4600);
    mo.disconnect();
    T("polls", __nowCalls() - n0);
    T("mutations", recs.slice(0, 12));
  `);
  harness.assertNoPageError(assert, r);
  await t.test("THE one: no node is written — the result line is role=status, re-announced on every write", () => {
    assert.ok(r.polls >= 3, "precondition: only " + r.polls + " polls");
    assert.deepEqual(r.mutations, []);
  });
});

test("lists that cannot be read are asked for again, but not on every poll (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-caps-fail", stub(f, { capsAnswer: { status: 502, body: { error: "HQPlayer didn't answer: <VolumeRange> has no min" } } }), `
    var c0 = window.__callsMatching("/api/hqp/capabilities");
    var n0 = __nowCalls();
    await window.__sleep(12000);
    T("polls", __nowCalls() - n0);
    T("caps_calls", window.__callsMatching("/api/hqp/capabilities") - c0);
    T("presets_calls", window.__callsMatching("/api/hqp/presets"));
    T("alert", __shown(".hqp-alert") ? __text(".hqp-alert") : null);
    T("rows_disabled", document.querySelector('.hqp-row[data-field="filter1x"]').disabled);
  `);
  harness.assertNoPageError(assert, r);
  await t.test("THE one: a few times in twelve seconds, not once per poll", () => {
    assert.ok(r.polls >= 6, "precondition: only " + r.polls + " polls");
    assert.ok(r.caps_calls >= 1 && r.caps_calls <= 3, r.caps_calls + " reads of the lists in " + r.polls + " polls");
    assert.equal(r.presets_calls, 0, "the presets were asked for though their previews need the lists");
  });
  await t.test("and the screen says why its controls are not there", () => {
    assert.match(r.alert, /Couldn't read HQPlayer's lists of filters and modulators \(HQPlayer didn't answer: <VolumeRange> has no min\); trying again\./);
    assert.equal(r.rows_disabled, true);
  });
});

test("a rollback that could not put everything back says what it left (v1.8.74)", async (t) => {
  const f = await fx();
  const rb = JSON.parse(JSON.stringify(f.rollback));
  rb.rolledBack.skipped = [{ field: "matrixProfile", reason: "\"Headphones\" is not one of this HQPlayer's matrix profiles" }];
  const after = Object.assign({}, f.nowDsd512, { undoAvailable: false });
  const r = render("hqp-rollback-skipped", stub(f, { now: f.nowDsd512, nowAfter: after, caps: f.capsDsd512,
                                                    changeAnswer: { status: 200, body: rb } }), `
    document.querySelector('.hqp-row[data-field="shaper"]').click();
    await window.__sleep(400);
    document.querySelector('.hqp-pick-item[data-name="AHM7EC8B"]').click();
    await window.__sleep(1200);
    T("msg", __text(".hqp-msg"));
  `);
  harness.assertNoPageError(assert, r);
  await t.test("what went back, then what did not", () => {
    assert.match(r.msg, /^Undone: AHM7EC8B needs .*Modulator back to ASDM7EC\. Couldn't put back: Matrix profile \("Headphones" is not one of this HQPlayer's matrix profiles\)\. Playback resumed\./);
  });
});

test("the presets sheet (v1.8.74)", async (t) => {
  const f = await fx();
  const r = render("hqp-presets", stub(f), `
    document.querySelector('.hqp-row[data-field="presets"]').click();
    await window.__sleep(500);
    var rows = Array.prototype.slice.call(document.querySelectorAll(".hqp-preset"));
    T("rows", rows.map(function (row) {
      var m = row.querySelector(".hqp-preset-main");
      return { name: m.querySelector(".hqp-preset-name").firstChild.textContent, badge: m.querySelector(".hqp-badge").textContent,
               disabled: m.disabled };
    }));
    var name = document.querySelector(".hqp-preset-input");
    name.value = "Late night";
    document.querySelector(".hqp-preset-vol input").checked = true;
    Array.prototype.find.call(document.querySelectorAll(".hqp-preset-foot button"), function (b) { return b.textContent === "Save"; }).click();
    await window.__sleep(400);
    T("save", window.__posts.filter(function (p) { return /\\/api\\/hqp\\/presets$/.test(p.url); }));
    // The major one asks first.
    rows[1].querySelector(".hqp-preset-main").click();
    await window.__sleep(300);
    T("confirm", !document.getElementById("confirm-overlay").classList.contains("hidden") ? document.getElementById("confirm-msg").textContent : null);
    document.getElementById("confirm-no").click();
    await window.__sleep(300);
    T("applied_after_no", window.__posts.filter(function (p) { return /apply$/.test(p.url); }).length);
  `);
  harness.assertNoPageError(assert, r);
  await t.test("each preset with what applying it would mean here", () => {
    assert.deepEqual(r.rows, [
      { name: "DSD1024 xla", badge: "✓ in effect", disabled: true },
      { name: "PCM 384k", badge: "major", disabled: false },
    ]);
  });
  await t.test("saving the current settings, with the volume only when asked", () => {
    assert.equal(r.save.length, 1);
    assert.deepEqual(r.save[0].body, { name: "Late night", fromCurrent: true, includeVolume: true });
    assert.equal(r.save[0].type, "application/json");
  });
  await t.test("a preset that changes the mode or the rate asks first, and No means no", () => {
    assert.match(r.confirm, /changes the mode or the output rate/);
    assert.equal(r.applied_after_no, 0);
  });
});

test("Settings → HQPlayer (v1.8.74)", async (t) => {
  const f = await fx();
  const SETTINGS = `
    var st = document.createElement("style"); st.textContent = ".settings-sheet { animation: none !important; }";
    document.head.appendChild(st);
    document.getElementById("settings-toggle").click();
    await window.__sleep(300);
    document.querySelector('.settings-nav-item[data-pane="hqplayer"]').click();
    await window.__sleep(400);
  `;
  const r = harness.renderPage({
    name: "hqp-settings", windowSize: "390x844", budgetMs: 30000,
    stub: stub(f, { settings: { enabled: false, host: "", port: 4321, demo: false, learned_count: 0 } }).replace(
      'window.__installFetch(function (u, opts) {',
      `window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/hqp/settings") > -1 && opts && opts.method === "POST") {
    var b = JSON.parse(opts.body);
    window.__fx.settings = Object.assign({}, window.__fx.settings, b);
    window.__posts.push({ url: u, method: "POST", type: (opts.headers || {})["Content-Type"], body: b });
    return window.__json(Object.assign({ learned_count: 0 }, window.__fx.settings));
  }
  if (u.indexOf("/api/hqp/test") > -1) {
    window.__posts.push({ url: u, method: "POST", body: JSON.parse(opts.body) });
    return window.__json({ ok: true, name: "music-pc", product: "Signalyst HQPlayer Desktop", engine: "5.35.10", version: "5" });
  }`),
    driver: `
      await window.__sleep(700);
      T("menu_before", !document.getElementById("menu-item-hqplayer").classList.contains("hidden"));
      ${SETTINGS}
      T("pane_title", document.querySelector('.settings-pane[data-pane="hqplayer"] h2').textContent);
      T("enabled_before", document.getElementById("hqp-enabled").checked);
      var en = document.getElementById("hqp-enabled");
      en.checked = true; en.dispatchEvent(new Event("change"));
      await window.__sleep(300);
      T("menu_after", !document.getElementById("menu-item-hqplayer").classList.contains("hidden"));
      document.getElementById("hqp-host").value = "music-pc.local";
      document.getElementById("hqp-port").value = "99999";
      document.getElementById("hqp-save").click();
      await window.__sleep(200);
      T("bad_port", document.getElementById("hqp-conn-note").textContent);
      document.getElementById("hqp-port").value = "4321";
      document.getElementById("hqp-test").click();
      await window.__sleep(300);
      T("tested", document.getElementById("hqp-conn-note").textContent);
      document.getElementById("hqp-save").click();
      await window.__sleep(300);
      var demo = document.getElementById("hqp-demo");
      demo.checked = true; demo.dispatchEvent(new Event("change"));
      await window.__sleep(300);
      T("posts", window.__posts);
      T("notice", document.querySelector('.settings-pane[data-pane="hqplayer"]').textContent.replace(/\\s+/g, " "));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("off by default, and the menu entry with it", () => {
    assert.equal(r.pane_title, "HQPlayer");
    assert.equal(r.enabled_before, false);
    assert.equal(r.menu_before, false, "the side menu offers HQPlayer while it is switched off");
  });
  await t.test("THE one: switching it on saves it as JSON and puts HQPlayer in the side menu", () => {
    assert.deepEqual(r.posts[0], { url: "/api/hqp/settings", method: "POST", type: "application/json", body: { enabled: true } });
    assert.equal(r.menu_after, true);
  });
  await t.test("a port out of range is caught before anything is sent", () => {
    assert.match(r.bad_port, /whole number from 1 to 65535/);
    assert.equal(r.posts.filter((p) => p.body && p.body.port === 99999).length, 0);
  });
  await t.test("Test asks the address as typed and says what answered", () => {
    const test = r.posts.find((p) => /\/api\/hqp\/test$/.test(p.url));
    assert.deepEqual(test.body, { host: "music-pc.local", port: 4321 });
    assert.match(r.tested, /Found “music-pc” — Signalyst HQPlayer Desktop 5\.35\.10/);
  });
  await t.test("Save sends the address; the demo switch also switches the feature on", () => {
    assert.ok(r.posts.some((p) => /settings$/.test(p.url) && p.body.host === "music-pc.local" && p.body.port === 4321));
    assert.deepEqual(r.posts[r.posts.length - 1].body, { demo: true, enabled: true });
  });
  await t.test("the page carries the credit and the non-affiliation notice", () => {
    assert.match(r.notice, /ported from hqpweb by statelycurmudgeon \(MIT licence\)/);
    assert.match(r.notice, /Not affiliated with, endorsed by, or supported by Signalyst\. HQPlayer is a trademark of its owner/);
  });
});
