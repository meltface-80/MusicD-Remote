"use strict";
// ---------------------------------------------------------------------------
// The HQPlayer change engine, through the routes the screen calls (v1.8.74).
//
// Every request goes through the service's dispatch() — the same handlers
// /api/hqp/* runs in the extension — against a fake HQPlayer with the Mac SDM
// profile (playing, AHM7EC8B at auto rate = DSD1024). Ported from hqpweb's
// change and preset tests (MIT, (c) 2026 statelycurmudgeon —
// lib/hqp/LICENSE), which drove its own HTTP server the same way.
//
// What is being protected is somebody's music system: a change is verified by
// reading State back (an OK proves nothing), rolled back when playback stops
// or cannot keep up, and the volume is never raised by more than 6 dB at once.
// ---------------------------------------------------------------------------

require("../lib/no-real-hqplayer");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FakeHqp, loadProfile } = require("../../lib/hqp/fake");
const { createHqpService } = require("../../lib/hqp/service");

// The watch, shortened. stoppedMs is the one threshold that is not a window.
const FAST = { graceMs: 50, healthyMs: 150, maxMs: 600, sampleMs: 20, minSpeed: 0.85, stoppedMs: 150 };
const TIMING = { quick: FAST, major: Object.assign({}, FAST, { maxMs: 800 }) };

// `tt` is the test the HQPlayer belongs to: it is closed when that test ends,
// pass or FAIL. A cleanup written as the test's last line never runs after a
// failed assertion, and the fake left listening keeps the whole run from
// ever exiting — a failure would hang the suite instead of being reported.
async function setup(tt, fakeOpts, extra) {
  const x = extra || {};
  const fake = new FakeHqp(loadProfile(x.profile || "desktop5-mac-sdm"), Object.assign({ timeScale: 0 }, fakeOpts || {}));
  await fake.listen();
  let saved = { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port };
  const svc = createHqpService({
    dataDir: x.dataDir || null,
    getSettings: () => saved,
    saveSettings: (patch) => { saved = Object.assign({}, saved, patch); return true; },
    timing: TIMING,
    pollMs: 50,
  });
  const call = async (method, p, body) => {
    const r = await svc.dispatch({ method, path: p, headers: { "content-type": "application/json" }, body });
    return { status: r.status, json: r.body };
  };
  const close = async () => { await svc.close(); await fake.close(); };
  tt.after(close);
  return { fake, svc, call, close };
}
const change = (s, body) => s.call("POST", "/change", body);
// Wait for something the fake will do, rather than for a guessed number of ms.
async function until(cond, what) {
  for (let n = 0; n < 500; n++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("timed out waiting for " + what);
}
const caps = async (s) => (await s.call("GET", "/capabilities")).json;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "musicd-hqp-"));

test("capabilities", async (t) => {
  await t.test("the current mode's lists and the volume range", async (tt) => {
    const s = await setup(tt);
    const c = await caps(s);
    assert.equal(c.mode.name, "SDM (DSD)");
    assert.equal(c.filters.length, 77);
    assert.equal(c.shapers.length, 36);
    assert.deepEqual([c.volumeRange.min, c.volumeRange.max], [-60, -3]);
    assert.ok(c.rates.every((r) => r.allowed));
    await s.close();
  });
  await t.test("they follow a mode change made somewhere else", async (tt) => {
    const s = await setup(tt);
    await caps(s);
    s.fake.modeIndex = 1; // PCM, as if changed in HQPlayer's own window
    assert.equal((await caps(s)).shapers.length, 10);
    await s.close();
  });
  await t.test("they carry the pickers' warnings, worked out for the track playing now", async (tt) => {
    const s = await setup(tt);
    await change(s, { shaper: "ASDM7EC" });
    await change(s, { rate: 22579200 });        // DSD512, fixed
    const c = await caps(s);
    assert.match(c.hints.shaper.AHM7EC8B.warn, /^won't play: AHM7EC8B needs ≥ 40\.96 MHz/,
      "the modulator that stops at DSD512 is offered with no warning");
    assert.equal(c.hints.shaper.ASDM7EC, undefined, "a modulator that plays here was warned about");
    assert.match(c.hintsKey, /^hqp@127\.0\.0\.1:\d+#\d+\|/, "the lists' key does not name the HQPlayer");
    await s.close();
  });
});

test("quick changes", async (t) => {
  await t.test("THE one: names resolved, applied, read back, and playback confirmed", async (tt) => {
    const s = await setup(tt);
    const r = await change(s, { filterNx: "poly-sinc-gauss-long", shaper: "ASDM7EC" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.class, "quick");
    assert.deepEqual(r.json.results.map((x) => [x.field, x.actual, x.applied]),
      [["filterNx", "poly-sinc-gauss-long", true], ["shaper", "ASDM7EC", true]]);
    assert.deepEqual(r.json.playback, { kind: "playing" });
    assert.equal(r.json.state.filter1x, 49, "the filter not being changed was not carried over");
    await s.close();
  });
  await t.test("volume and switches are not watched: they cannot stop playback", async (tt) => {
    const s = await setup(tt);
    assert.equal((await change(s, { volume: -30, invert: true })).json.playback.kind, "not-checked");
    await s.close();
  });
  await t.test("it says so when nothing was playing", async (tt) => {
    const s = await setup(tt);
    s.fake.playback = 0;
    const r = await change(s, { filterNx: "poly-sinc-gauss-long" });
    assert.equal(r.json.playback.kind, "not-checked");
    assert.match(r.json.playback.detail, /nothing was playing/);
    await s.close();
  });
  await t.test("an OK that changed nothing is reported as NOT applied", async (tt) => {
    const s = await setup(tt);
    s.fake.ignore.add("SetShaping");
    const r = await change(s, { shaper: "ASDM7EC" });
    assert.equal(r.json.results[0].applied, false);
    assert.equal(r.json.results[0].actual, "AHM7EC8B");
    assert.deepEqual(r.json.results[0].reply, { kind: "ok" }, "precondition: HQPlayer said OK");
    await s.close();
  });
  await t.test("a name that does not exist in this mode is refused, and nothing is applied", async (tt) => {
    const s = await setup(tt);
    const r = await change(s, { shaper: "NS5", filterNx: "poly-sinc-gauss-long" });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /NS5.*SDM/);
    assert.equal(s.fake.rem.filterNx, 51, "the other field was applied anyway");
    await s.close();
  });
  await t.test("the engine itself refuses an empty change, not only the route in front of it", async (tt) => {
    const s = await setup(tt);
    const { Instance } = require("../../lib/hqp/instance");
    const inst = new Instance({ id: "direct", host: "127.0.0.1", port: s.fake.port });
    tt.after(() => inst.close());
    await assert.rejects(inst.applyChange({}), /empty change/);
    await assert.rejects(inst.applyPreset({ volume: undefined }), /empty change/);
  });
  await t.test("unknown fields, wrong types and empty changes are refused before HQPlayer is asked", async (tt) => {
    const s = await setup(tt);
    for (const body of [{}, { bogus: 1 }, { volume: "-20" }, { rate: 44100.5 }, { shaper: "" }, { invert: "yes" }, [], null]) {
      assert.equal((await change(s, body)).status, 400, "accepted " + JSON.stringify(body));
    }
    assert.equal(s.fake.received.filter((x) => /Set|Volume/.test(x)).length, 0);
    await s.close();
  });
});

test("rollback when playback fails", async (t) => {
  await t.test("THE one: the measured stall (AHM7EC8B at DSD512) is rolled back, explained, and not learned", async (tt) => {
    const dir = tmpDir();
    const s = await setup(tt, {}, { dataDir: dir });
    const r = (await change(s, { rate: 22579200 })).json;
    assert.equal(r.class, "major");
    assert.deepEqual([r.results[0].field, r.results[0].actual, r.results[0].applied], ["rate", 22579200, true]);
    assert.equal(r.playback.kind, "stopped");
    assert.deepEqual([r.rolledBack.results[0].field, r.rolledBack.results[0].actual, r.rolledBack.results[0].applied], ["rate", 0, true]);
    assert.deepEqual(r.rolledBack.playback, { kind: "playing" });
    assert.equal(r.undoAvailable, false);
    assert.equal(s.fake.playback, 2, "HQPlayer was left stopped");
    assert.equal(r.incompatible.level, "hard");
    assert.match(r.incompatible.text, /AHM7EC8B needs/);
    assert.deepEqual((await caps(s)).knownBad, [], "a stop HQPlayer's own rules explain was learned as this machine's limit");
    assert.equal(fs.existsSync(path.join(dir, "hqp-learned.json")), false);
    await s.close();
  });
  await t.test("a rule-explained stop in PCM (sinc-M, 44.1k → 192k) is rolled back and not learned", async (tt) => {
    const s = await setup(tt);
    await change(s, { mode: "PCM" });                          // a 44.1k source: the 1x filter is in use
    await change(s, { filter1x: "sinc-M", rate: 176400 });     // 4×: fine
    const r = (await change(s, { rate: 192000 })).json;        // 4.35×: cannot
    assert.equal(r.playback.kind, "stopped");
    assert.match(r.incompatible.text, /whole-number/);
    assert.equal(r.rolledBack.results[0].actual, 176400);
    assert.deepEqual((await s.call("GET", "/learned")).json, []);
    await s.close();
  });
  await t.test("a filter the machine cannot keep up with is rolled back AND learned, on disk", async (tt) => {
    const dir = tmpDir();
    const s = await setup(tt, { speed: (c) => (c.filterName === "poly-sinc-gauss-long" ? 0.5 : 1) }, { dataDir: dir });
    const r = (await change(s, { filter1x: "poly-sinc-gauss-long" })).json;
    assert.equal(r.playback.kind, "struggling");
    assert.equal(r.rolledBack.results[0].actual, "poly-sinc-gauss-xla");
    assert.deepEqual(r.rolledBack.playback, { kind: "playing" });
    assert.equal(r.incompatible, undefined);
    const bad = (await caps(s)).knownBad;
    assert.equal(bad.length, 1);
    assert.equal(bad[0].filter1x, "poly-sinc-gauss-long");
    assert.equal(bad[0].rateHz, 45158400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "hqp-learned.json"), "utf8")).failures.length, 1);
    // ...and the picker now says so beside that filter.
    assert.match((await caps(s)).hints.filter1x["poly-sinc-gauss-long"].warn, /failed here before/);
    await s.close();
  });
  await t.test("learned failures are listed and forgotten", async (tt) => {
    const s = await setup(tt, { speed: (c) => (c.filterName === "poly-sinc-gauss-long" ? 0.5 : 1) });
    await change(s, { filter1x: "poly-sinc-gauss-long" });
    assert.equal((await s.call("GET", "/learned")).json.length, 1);
    assert.deepEqual((await s.call("DELETE", "/learned")).json, { forgotten: 1 });
    assert.deepEqual((await caps(s)).knownBad, []);
    await s.close();
  });
  await t.test("the rollback still happens when the data volume cannot be written", async (tt) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "blocker"), "");
    // A data dir whose "directory" is a file: every write fails.
    const s = await setup(tt, { speed: (c) => (c.filterName === "poly-sinc-gauss-long" ? 0.5 : 1) },
                          { dataDir: path.join(dir, "blocker") });
    const logged = [];
    const saved = console.error;
    console.error = (m) => logged.push(String(m));
    let r;
    try {
      r = (await change(s, { filter1x: "poly-sinc-gauss-long" })).json;
    } finally {
      console.error = saved;
    }
    assert.ok(logged.some((m) => /could not record a failed combination/.test(m)), "the failed write was not reported");
    assert.equal(r.playback.kind, "struggling");
    assert.equal(r.rolledBack.results[0].actual, "poly-sinc-gauss-xla");
    assert.equal(s.fake.filterName(s.fake.rem.filter1x), "poly-sinc-gauss-xla");
    await s.close();
  });
  await t.test("a rollback puts back what it can, and says what it could not", async (tt) => {
    // The matrix profile that was in use is deleted in HQPlayer, and then a
    // change stops playback. Rolled back strictly, as hqpweb does, the
    // rollback refused ALL of itself over that one setting — and playback
    // stayed stopped with nothing put back.
    const s = await setup(tt, { matrixProfiles: ["Headphones", "Room EQ"] });
    await change(s, { matrixProfile: "Headphones" });
    s.fake.opts.matrixProfiles = ["Room EQ"];
    const r = await change(s, { rate: 22579200, matrixProfile: "Room EQ" }); // stops: AHM7EC8B at DSD512
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.playback.kind, "stopped");
    assert.deepEqual(r.json.rolledBack.results.map((x) => [x.field, x.actual, x.applied]), [["rate", 0, true]]);
    assert.deepEqual(r.json.rolledBack.skipped.map((x) => x.field), ["matrixProfile"]);
    assert.equal(s.fake.playback, 2, "HQPlayer was left stopped");
    await s.close();
  });
  await t.test("a combination that plays is kept (ASDM7EC at DSD512)", async (tt) => {
    const s = await setup(tt);
    await change(s, { shaper: "ASDM7EC" });
    const r = (await change(s, { rate: 22579200 })).json;
    assert.deepEqual(r.playback, { kind: "playing" });
    assert.equal(r.rolledBack, null);
    await s.close();
  });
});

test("mode and rate", async (t) => {
  await t.test("a mode switch, and undo restores the mode, the rate and that mode's filters", async (tt) => {
    const s = await setup(tt);
    await change(s, { shaper: "ASDM7EC" });
    await change(s, { rate: 22579200 });
    const toPcm = (await change(s, { mode: "PCM" })).json;
    assert.equal(toPcm.class, "major");
    assert.deepEqual([toPcm.results[0].actual, toPcm.results[0].applied], ["PCM", true]);
    const back = (await s.call("POST", "/undo", {})).json;
    assert.deepEqual([back.state.mode, back.state.rate], [2, 4]);   // SDM, DSD512
    assert.equal(s.fake.shaperName, "ASDM7EC");
    await s.close();
  });
  await t.test("the mode first, then the other names against the NEW mode's lists", async (tt) => {
    const s = await setup(tt);
    const r = (await change(s, { mode: "PCM", shaper: "NS5", rate: 384000 })).json;
    assert.deepEqual(r.results.map((x) => x.applied), [true, true, true]);
    await s.close();
  });
  await t.test("the mode is put back if a later field cannot be resolved", async (tt) => {
    const s = await setup(tt);
    const r = await change(s, { mode: "PCM", shaper: "AHM7EC8B" }); // a modulator, not a PCM dither
    assert.equal(r.status, 422);
    assert.equal(s.fake.mode.name, "SDM (DSD)");
    await s.close();
  });
  await t.test("no rate in [source] mode", async (tt) => {
    const s = await setup(tt);
    assert.equal((await change(s, { mode: "[source]", rate: 44100 })).status, 422);
    await s.close();
  });
  // [source] mode has no output rate (HQPlayer ignores SetRate there). It was
  // written down as 0 all the same, and coming back that 0 was a SetRate the
  // mode refuses — so the way back out of a change from [source] mode failed.
  await t.test("undo of a change out of [source] mode puts [source] back", async (tt) => {
    const s = await setup(tt);
    s.fake.modeIndex = 0;                                          // [source], playing
    const r = (await change(s, { mode: "SDM (DSD)", shaper: "ASDM7EC" })).json;
    assert.deepEqual(r.results.map((x) => x.applied), [true, true]);
    const u = await s.call("POST", "/undo", {});
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.equal(s.fake.mode.name, "[source]");
    await s.close();
  });
  await t.test("THE one for [source]: a change out of it that stops playback is rolled back INTO it", async (tt) => {
    const s = await setup(tt);
    s.fake.modeIndex = 0;                                          // [source], playing
    const r = await change(s, { mode: "SDM (DSD)", rate: 22579200, shaper: "AHM7EC8B" }); // stops: needs DSD1024
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.playback.kind, "stopped");
    assert.ok(r.json.rolledBack, "not rolled back");
    assert.equal(r.json.rolledBack.skipped, undefined, JSON.stringify(r.json.rolledBack.skipped));
    assert.equal(s.fake.mode.name, "[source]");
    assert.deepEqual(r.json.rolledBack.playback, { kind: "playing" });
    assert.equal(s.fake.playback, 2, "HQPlayer was left stopped");
    await s.close();
  });
  await t.test("a preset saved in [source] mode has no rate, and applies with nothing skipped", async (tt) => {
    const s = await setup(tt);
    s.fake.modeIndex = 0;
    const p = (await s.call("POST", "/presets", { name: "Source", fromCurrent: true })).json;
    assert.equal(p.settings.mode, "[source]");
    assert.equal(Object.prototype.hasOwnProperty.call(p.settings, "rate"), false, "a rate was saved for a mode that has none");
    assert.equal((await change(s, { mode: "SDM (DSD)" })).status, 200);
    const r = (await s.call("POST", "/presets/" + p.id + "/apply", {})).json;
    assert.equal(r.skipped, undefined, JSON.stringify(r.skipped));
    assert.equal(s.fake.mode.name, "[source]");
    await s.close();
  });
});

test("volume safety", async (t) => {
  await t.test("lowering is free, and stays a float", async (tt) => {
    const s = await setup(tt);
    const r = (await change(s, { volume: -40.5 })).json.results[0];
    assert.deepEqual([r.applied, r.actual], [true, -40.5]);
    await s.close();
  });
  await t.test("THE one: a raise of more than 6 dB in one step is refused, and nothing moves", async (tt) => {
    const s = await setup(tt);
    const r = await change(s, { volume: -10 });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /refusing to raise the volume by 12\.0 dB/);
    assert.equal(s.fake.volume, -22);
    await s.close();
  });
  await t.test("a raise of exactly 6 dB is allowed", async (tt) => {
    const s = await setup(tt);
    assert.equal((await change(s, { volume: -16 })).json.results[0].applied, true);
    await s.close();
  });
  await t.test("clamped to VolumeRange.max, and it says so", async (tt) => {
    const s = await setup(tt);
    s.fake.volume = -5;
    const r = (await change(s, { volume: 0 })).json.results[0];
    assert.deepEqual([r.actual, r.applied], [-3, true]);
    assert.match(r.note, /clamped to -3/);
    await s.close();
  });
});

test("undo", async (t) => {
  await t.test("restores exactly the fields the last change touched", async (tt) => {
    const s = await setup(tt);
    await change(s, { filter1x: "poly-sinc-gauss-long", volume: -30 });
    const r = (await s.call("POST", "/undo", {})).json;
    assert.deepEqual([r.state.filter1x, r.state.filterNx, r.state.volume], [49, 51, -22]);
    assert.equal(r.undoAvailable, false);
    await s.close();
  });
  await t.test("never raises the volume back past the guard once someone else moved it", async (tt) => {
    const s = await setup(tt);
    await change(s, { volume: -40 });
    s.fake.volume = -45; // lowered from Roon, say
    const r = (await s.call("POST", "/undo", {})).json;
    assert.equal(r.results[0].field, "volume");
    assert.equal(r.results[0].applied, false);
    assert.match(r.results[0].note, /not restored/);
    assert.equal(s.fake.volume, -45);
    await s.close();
  });
  await t.test("refuses after a mode change made somewhere else", async (tt) => {
    const s = await setup(tt);
    await change(s, { shaper: "ASDM7EC" });
    s.fake.modeIndex = 1;
    assert.equal((await s.call("POST", "/undo", {})).status, 409);
    await s.close();
  });
  await t.test("nothing to undo at first", async (tt) => {
    const s = await setup(tt);
    assert.equal((await s.call("POST", "/undo", {})).status, 409);
    await s.close();
  });
  await t.test("the screen learns undo is available even after it was reloaded", async (tt) => {
    const s = await setup(tt);
    assert.equal((await s.call("GET", "/now")).json.undoAvailable, false);
    await change(s, { shaper: "ASDM7EC" });
    assert.equal((await s.call("GET", "/now")).json.undoAvailable, true);
    await s.close();
  });
});

// The settings can be saved — on this device or another — while a change is
// being watched. Closing the HQPlayer connection under it cut the change off
// before its rollback: a setting that had stopped playback stayed, and Undo
// had nothing to undo.
test("a settings save while a change is being watched", async (t) => {
  await t.test("THE one: Save with nothing altered keeps the connection, and the change still rolls back", async (tt) => {
    const s = await setup(tt);
    assert.equal((await s.call("GET", "/now")).json.reachable, true);
    const conns = s.fake.connections;
    const pending = change(s, { rate: 22579200 });               // stops playback: AHM7EC8B at DSD512
    await until(() => s.fake.rateIndex !== 0, "the rate to be applied");
    assert.equal((await s.call("POST", "/settings", { host: "127.0.0.1", port: s.fake.port })).status, 200);
    const r = await pending;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.rolledBack, "the change was cut off before its rollback");
    assert.equal(s.fake.playback, 2, "HQPlayer was left stopped");
    assert.equal((await s.call("GET", "/now")).json.reachable, true);
    assert.equal(s.fake.connections, conns, "a save that changed nothing replaced the connection to HQPlayer");
    await s.close();
  });
  await t.test("switched to another HQPlayer mid-change: the first is still rolled back, then let go", async (tt) => {
    const s = await setup(tt);
    const other = new FakeHqp(loadProfile("desktop5-linux-pcm"), { timeScale: 0 });
    await other.listen();
    tt.after(() => other.close());
    const pending = change(s, { rate: 22579200 });
    await until(() => s.fake.rateIndex !== 0, "the rate to be applied");
    assert.equal((await s.call("POST", "/settings", { port: other.port })).status, 200);
    const r = await pending;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.rolledBack, "the change was cut off before its rollback");
    assert.equal(s.fake.playback, 2, "the first HQPlayer was left stopped");
    assert.equal((await s.call("GET", "/now")).json.snapshot.status.activeMode, "PCM", "the new HQPlayer did not take over");
    const seen = s.fake.received.length;
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(s.fake.received.length, seen, "the first HQPlayer is still being asked");
    await s.close();
  });
  await t.test("switched off mid-change: rolled back first, then nothing more is asked", async (tt) => {
    const s = await setup(tt);
    const pending = change(s, { rate: 22579200 });
    await until(() => s.fake.rateIndex !== 0, "the rate to be applied");
    assert.equal((await s.call("POST", "/settings", { enabled: false })).status, 200);
    const r = await pending;
    assert.ok(r.json.rolledBack, "the change was cut off before its rollback");
    assert.equal(s.fake.playback, 2, "HQPlayer was left stopped");
    const seen = s.fake.received.length;
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(s.fake.received.length, seen, "a switched-off HQPlayer is still being asked");
    await s.close();
  });
});

test("convolution and matrix profiles", async (t) => {
  await t.test("convolution reported as NOT applied, with the reason, when HQPlayer has none set up", async (tt) => {
    const s = await setup(tt);
    const r = (await change(s, { convolution: true })).json.results[0];
    assert.deepEqual([r.field, r.applied, r.actual], ["convolution", false, false]);
    assert.match(r.note, /no impulse responses are set up/);
    await s.close();
  });
  await t.test("a listed matrix profile is switched and verified; an unknown one is never sent", async (tt) => {
    const s = await setup(tt, { matrixProfiles: ["Headphones", "Room EQ"] });
    assert.deepEqual((await caps(s)).matrixProfiles, ["Headphones", "Room EQ"]);
    const r = (await change(s, { matrixProfile: "Room EQ" })).json.results[0];
    assert.deepEqual([r.applied, r.actual], [true, "Room EQ"]);
    assert.equal((await change(s, { matrixProfile: "Nope" })).status, 422);
    assert.equal(s.fake.received.filter((x) => x.includes("Nope")).length, 0, "an unknown profile name reached HQPlayer");
    // Undo puts back "no profile" (an empty name).
    const u = (await s.call("POST", "/undo", {})).json.results[0];
    assert.deepEqual([u.field, u.applied, u.actual], ["matrixProfile", true, ""]);
    await s.close();
  });
});

test("presets", async (t) => {
  await t.test("saved from the current settings, BY NAME, without the volume unless asked", async (tt) => {
    const s = await setup(tt);
    const p = (await s.call("POST", "/presets", { name: "Night", fromCurrent: true })).json;
    assert.deepEqual(p.settings, {
      mode: "SDM (DSD)", rate: 0, filterNx: "poly-sinc-gauss-hires-lp", filter1x: "poly-sinc-gauss-xla",
      shaper: "AHM7EC8B", invert: false, filter20k: false, adaptive: false, convolution: false,
    });
    const v = (await s.call("POST", "/presets", { name: "With volume", fromCurrent: true, includeVolume: true })).json;
    assert.equal(v.settings.volume, -22);
    await s.close();
  });
  await t.test("explicit settings are validated like a change; names are required and unique", async (tt) => {
    const s = await setup(tt);
    assert.equal((await s.call("POST", "/presets", { name: "Just a filter", settings: { filter1x: "poly-sinc-gauss-long" } })).status, 200);
    assert.equal((await s.call("POST", "/presets", { name: "Bad", settings: { volume: "-20" } })).status, 400);
    assert.equal((await s.call("POST", "/presets", { name: "Empty", settings: {} })).status, 400);
    assert.equal((await s.call("POST", "/presets", { settings: { invert: true } })).status, 400);
    assert.equal((await s.call("POST", "/presets", { name: "just a FILTER", settings: { invert: true } })).status, 409);
    assert.equal((await s.call("POST", "/presets", { name: "x", bogus: 1 })).status, 400);
    await s.close();
  });
  await t.test("previews: active, quick and major", async (tt) => {
    const s = await setup(tt);
    await s.call("POST", "/presets", { name: "Current", fromCurrent: true });
    await s.call("POST", "/presets", { name: "Other filter", settings: { filter1x: "poly-sinc-gauss-long" } });
    await s.call("POST", "/presets", { name: "PCM", settings: { mode: "PCM" } });
    const kinds = (await s.call("GET", "/presets")).json.map((p) => [p.name, p.preview.kind]);
    assert.deepEqual(kinds, [["Current", "active"], ["Other filter", "quick"], ["PCM", "major"]]);
    await s.close();
  });
  await t.test("a quick preset applies with read-back and a playback check", async (tt) => {
    const s = await setup(tt);
    const p = (await s.call("POST", "/presets", { name: "Gauss long", settings: { filter1x: "poly-sinc-gauss-long", invert: true } })).json;
    const r = (await s.call("POST", "/presets/" + p.id + "/apply", {})).json;
    assert.equal(r.class, "quick");
    assert.ok(r.results.every((x) => x.applied));
    assert.deepEqual(r.playback, { kind: "playing" });
    assert.equal(r.skipped, undefined);
    await s.close();
  });
  await t.test("THE one: a preset never raises the volume past the guard — that setting is skipped", async (tt) => {
    const s = await setup(tt);
    const p = (await s.call("POST", "/presets", { name: "Loud", settings: { volume: -5, invert: true } })).json; // from -22
    const r = (await s.call("POST", "/presets/" + p.id + "/apply", {})).json;
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].field, "volume");
    assert.match(r.skipped[0].reason, /refusing to raise the volume by 17\.0 dB/);
    assert.equal(s.fake.volume, -22);
    assert.equal(s.fake.invert, true, "the rest of the preset was not applied");
    await s.close();
  });
  await t.test("renamed, updated from current (keeping its volume choice), deleted — and kept on disk", async (tt) => {
    const dir = tmpDir();
    const s = await setup(tt, {}, { dataDir: dir });
    const file = path.join(dir, "hqp-presets.json");
    const p = (await s.call("POST", "/presets", { name: "Mine", fromCurrent: true })).json;
    assert.equal((await s.call("PATCH", "/presets/" + p.id, { name: "Ours" })).json.name, "Ours");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).presets[0].name, "Ours");
    await change(s, { filter1x: "poly-sinc-gauss-long" });
    const u = (await s.call("PATCH", "/presets/" + p.id, { fromCurrent: true })).json;
    assert.equal(u.settings.filter1x, "poly-sinc-gauss-long");
    assert.equal(u.settings.volume, undefined, "update-from-current added a volume the preset never had");
    assert.equal((await s.call("GET", "/presets")).json[0].preview.kind, "active");
    assert.equal((await s.call("DELETE", "/presets/" + p.id, {})).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).presets, []);
    assert.equal((await s.call("DELETE", "/presets/" + p.id, {})).status, 404);
    await s.close();
  });
  await t.test("another HQPlayer's preset: what this one cannot take is listed, then skipped", async (tt) => {
    const s = await setup(tt, {}, { profile: "desktop5-linux-pcm" });
    s.fake.playback = 2;
    const p = (await s.call("POST", "/presets", { name: "Mixed", settings: { mode: "SDM (DSD)", rate: 22579200, filter1x: "poly-sinc-gauss-xla", shaper: "ASDM7EC", invert: true } })).json;
    const pv = (await s.call("GET", "/presets")).json[0].preview;
    assert.deepEqual(pv.missing.map((m) => m.field), ["mode", "rate", "filter1x", "shaper"]);
    const r = (await s.call("POST", "/presets/" + p.id + "/apply", {})).json;
    assert.deepEqual(r.results.map((x) => x.field), ["invert"]);
    assert.deepEqual(r.skipped.map((x) => x.field), ["mode", "rate", "filter1x", "shaper"]);
    assert.equal(s.fake.rateIndex, 0);
    await s.close();
  });
  await t.test("a preset a rule says cannot play is predicted, then rolled back if applied anyway", async (tt) => {
    const s = await setup(tt, {}, { profile: "desktop5-linux-pcm" });
    s.fake.playback = 2;
    const p = (await s.call("POST", "/presets", { name: "sinc-M 192k", settings: { filter1x: "sinc-M", rate: 192000 } })).json;
    const pv = (await s.call("GET", "/presets")).json[0].preview;
    assert.equal(pv.predicted.level, "hard");
    assert.match(pv.predicted.text, /whole-number/);
    const r = (await s.call("POST", "/presets/" + p.id + "/apply", {})).json;
    assert.equal(r.playback.kind, "stopped");
    assert.ok(r.rolledBack.results.every((x) => x.applied));
    assert.deepEqual((await s.call("GET", "/learned")).json, []);
    await s.close();
  });
  await t.test("unknown presets 404", async (tt) => {
    const s = await setup(tt);
    assert.equal((await s.call("POST", "/presets/nope/apply", {})).status, 404);
    assert.equal((await s.call("PATCH", "/presets/nope", { name: "x" })).status, 404);
    await s.close();
  });
});

test("the preset file is never lost to a bad write", async (t) => {
  const { PresetStore } = require("../../lib/hqp/store");
  const { parseChange } = require("../../lib/hqp/instance");
  await t.test("a corrupt file is moved aside, not overwritten", () => {
    const dir = tmpDir();
    const file = path.join(dir, "hqp-presets.json");
    fs.writeFileSync(file, '{"presets": [ {"id":"a","name":"x",} ]}'); // trailing comma
    const errors = [];
    const saved = console.error;
    console.error = (m) => errors.push(m);
    try {
      const store = new PresetStore(file, parseChange);
      assert.deepEqual(store.list(), []);
      store.create("New", { invert: true });
    } finally {
      console.error = saved;
    }
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("hqp-presets.json.corrupt-")), "the unreadable file was overwritten");
    assert.ok(errors.some((m) => /moved it to/.test(m)));
  });
  await t.test("one invalid entry is dropped, the rest load", () => {
    const dir = tmpDir();
    const file = path.join(dir, "hqp-presets.json");
    fs.writeFileSync(file, JSON.stringify({ presets: [
      { id: "a", name: "Good", settings: { invert: true } },
      { id: "b", name: "Bad", settings: { volume: "loud" } },
    ] }));
    const saved = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(new PresetStore(file, parseChange).list().map((p) => p.name), ["Good"]);
    } finally {
      console.error = saved;
    }
  });
});
