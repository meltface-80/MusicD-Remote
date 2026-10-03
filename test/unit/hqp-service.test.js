"use strict";
// ---------------------------------------------------------------------------
// HQPlayer control as the extension serves it (v1.8.74): the settings, the
// Demo HQPlayer, the poller that runs only while the screen is open, the rule
// that every write is JSON, and the line saying what Roon is playing through
// HQPlayer. Everything goes through the service's dispatch() — the same
// handlers /api/hqp/* runs — so no Express is needed to run it.
// ---------------------------------------------------------------------------

require("../lib/no-real-hqplayer");
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeHqp, loadProfile } = require("../../lib/hqp/fake");
const { createHqpService, parseSettingsPatch, hqpZones } = require("../../lib/hqp/service");
const { indexSource } = require("../lib/extract");
const { Instance } = require("../../lib/hqp/instance");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const JSON_HDR = { "content-type": "application/json" };

// Every service and fake belongs to the test `tt` and is closed when that test
// ends, pass or FAIL: a cleanup on a test's last line never runs after a failed
// assertion, and a fake left listening keeps the run from ever exiting.
async function fakeFor(tt, profile) {
  const fake = new FakeHqp(loadProfile(profile), { timeScale: 0 });
  await fake.listen();
  tt.after(() => fake.close());
  return fake;
}

function service(tt, initial, extra) {
  let saved = Object.assign({}, initial || {});
  const writes = [];
  const svc = createHqpService(Object.assign({
    dataDir: null,
    getSettings: () => saved,
    saveSettings: (patch) => { writes.push(patch); saved = Object.assign({}, saved, patch); return true; },
    pollMs: 30,
    leaseMs: 300,
    demoTimeScale: 0,
  }, extra || {}));
  const call = async (method, p, body, headers) => {
    const r = await svc.dispatch({ method, path: p, headers: headers || JSON_HDR, body });
    return { status: r.status, json: r.body };
  };
  tt.after(() => svc.close());
  return { svc, call, writes, saved: () => saved };
}

test("off means off", async (t) => {
  await t.test("THE one: switched off, nothing is started and every HQPlayer route refuses", async (tt) => {
    const s = service(tt, {});
    const now = await s.call("GET", "/now");
    assert.equal(now.status, 200);
    assert.deepEqual(now.json, { enabled: false, demo: false, configured: false });
    for (const [m, p, b] of [["GET", "/capabilities"], ["POST", "/change", { volume: -30 }], ["POST", "/undo", {}],
                             ["GET", "/presets"]]) {
      const r = await s.call(m, p, b);
      assert.equal(r.status, 409, m + " " + p + " answered " + r.status);
      assert.match(r.json.error, /switched off/);
    }
    assert.equal(s.svc.polling, false, "a poller is running for a feature that is switched off");
    assert.equal(s.svc.demoPort, null);
    await s.svc.close();
  });
  await t.test("on, but with no address: it says what to do", async (tt) => {
    const s = service(tt, { hqpEnabled: true });
    assert.deepEqual((await s.call("GET", "/now")).json, { enabled: true, demo: false, configured: false });
    const r = await s.call("POST", "/change", { volume: -30 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Settings → HQPlayer/);
    await s.svc.close();
  });
});

test("learned failures are this app's own record", async (t) => {
  await t.test("read and forgotten with control switched off — the Demo HQPlayer's kept apart", async (tt) => {
    // Settings shows the count and offers to forget them whatever the switch
    // says; the button answered "switched off" while it was.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-hqp-"));
    const failure = (instance) => ({ instance, engine: "5.32.5", mode: "SDM (DSD)", rateHz: 22579200,
                                     filterNx: "poly-sinc-gauss-long", filter1x: "poly-sinc-gauss-xla",
                                     shaper: "AHM7EC8B", reason: "playback stopped", at: "2026-10-03T00:00:00.000Z" });
    fs.writeFileSync(path.join(dir, "hqp-learned.json"), JSON.stringify({ failures: [failure("hqp"), failure("demo")] }));
    const s = service(tt, {}, { dataDir: dir });
    assert.equal((await s.call("GET", "/settings")).json.learned_count, 1);
    assert.equal((await s.call("GET", "/learned")).json.length, 1);
    assert.deepEqual((await s.call("DELETE", "/learned", {})).json, { forgotten: 1 });
    assert.equal((await s.call("GET", "/settings")).json.learned_count, 0);
    assert.equal(s.svc.polling, false, "forgetting them asked HQPlayer something");
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "hqp-learned.json"), "utf8")).failures;
    assert.deepEqual(kept.map((f) => f.instance), ["demo"]);
    await s.svc.close();
  });
});

test("settings", async (t) => {
  await t.test("defaults: off, no address, port 4321, no demo", async (tt) => {
    const s = service(tt, {});
    assert.deepEqual((await s.call("GET", "/settings")).json, { enabled: false, host: "", port: 4321, demo: false, learned_count: 0 });
    await s.svc.close();
  });
  await t.test("saved under their own keys, and read back", async (tt) => {
    const s = service(tt, {});
    const r = await s.call("POST", "/settings", { enabled: true, host: " 192.0.2.10 ", port: 4322 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { enabled: true, host: "192.0.2.10", port: 4322, demo: false, learned_count: 0 });
    assert.deepEqual(s.writes[0], { hqpEnabled: true, hqpHost: "192.0.2.10", hqpPort: 4322, hqpDemo: false });
    await s.svc.close();
  });
  await t.test("strict: wrong types, bad addresses and unknown fields are refused, and nothing is saved", async (tt) => {
    const s = service(tt, {});
    for (const body of [{ enabled: "yes" }, { port: "4321" }, { port: 0 }, { port: 70000 }, { port: 43.5 },
                        { host: "a b" }, { host: "http://x/" }, { host: 5 }, { demo: 1 }, { colour: "red" }, [], null]) {
      assert.equal((await s.call("POST", "/settings", body)).status, 400, "accepted " + JSON.stringify(body));
    }
    assert.equal(s.writes.length, 0);
    assert.doesNotThrow(() => parseSettingsPatch({ host: "hqplayer.local" }));
    assert.doesNotThrow(() => parseSettingsPatch({ host: "[2001:db8::1]" }));
    assert.doesNotThrow(() => parseSettingsPatch({ host: "" }), "clearing the address was refused");
    await s.svc.close();
  });
  await t.test("a failed save is reported, not pretended", async (tt) => {
    const s = service(tt, {}, { saveSettings: () => false });
    const r = await s.call("POST", "/settings", { enabled: true });
    assert.equal(r.status, 500);
    await s.svc.close();
  });
});

test("writes must be JSON — the door other sites cannot open", async (t) => {
  await t.test("THE one: a form or text POST is refused before anything runs", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      for (const [m, p] of [["POST", "/change"], ["POST", "/undo"], ["POST", "/settings"], ["DELETE", "/learned"],
                            ["POST", "/presets/abc/apply"], ["PATCH", "/presets/abc"]]) {
        const r = await s.call(m, p, { volume: -1 }, { "content-type": type });
        assert.equal(r.status, 415, m + " " + p + " with " + JSON.stringify(type) + " answered " + r.status);
      }
    }
    assert.equal(s.writes.length, 0);
    assert.equal(s.svc.demoPort, null, "a refused request still started the demo");
    await s.svc.close();
  });
  await t.test("reads need no content type; unknown paths and wrong methods say so", async (tt) => {
    const s = service(tt, {});
    assert.equal((await s.call("GET", "/settings", undefined, {})).status, 200);
    assert.equal((await s.call("GET", "/nope", undefined, {})).status, 404);
    assert.equal((await s.call("PUT", "/settings", {}, JSON_HDR)).status, 405);
    await s.svc.close();
  });
});

test("the Demo HQPlayer", async (t) => {
  await t.test("THE one: switched on, a fake starts on loopback — never on 4321 — and the screen can drive it", async (tt) => {
    // A real Roon zone playing through a real HQPlayer, beside the demo: the
    // demo must not claim it — the fake is fed by nothing.
    const zones = { a: { zone_id: "a", display_name: "Lounge", state: "playing",
      outputs: [{ source_controls: [{ display_name: "HQPlayer" }] }],
      now_playing: { three_line: { line1: "Real", line2: "Track", line3: "Here" } } } };
    const s = service(tt, {}, { zones: () => zones });
    await s.call("POST", "/settings", { enabled: true, demo: true });
    const now = (await s.call("GET", "/now")).json;
    assert.equal(now.demo, true);
    assert.equal(now.name, "Demo HQPlayer");
    assert.equal(now.reachable, true, "the demo did not answer: " + now.error);
    assert.equal(now.snapshot.status.activeMode, "SDM (DSD)");
    assert.ok(s.svc.demoPort > 0 && s.svc.demoPort !== 4321);
    assert.deepEqual(now.roon, [], "the demo claimed a Roon zone feeds it");
    const r = await s.call("POST", "/change", { volume: -30 });
    assert.equal(r.json.results[0].applied, true);
    assert.equal(s.svc.demoFake.volume, -30);
    await s.svc.close();
    assert.equal(s.svc.demoPort, null);
  });
  await t.test("switched off again, the fake is closed and nothing listens", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    await s.call("GET", "/now");
    const fake = s.svc.demoFake;
    assert.ok(fake, "precondition: the demo is running");
    await s.call("POST", "/settings", { demo: false });
    assert.equal(s.svc.demoPort, null);
    assert.equal(fake.server, null, "the demo's server is still open");
    await s.svc.close();
  });
  await t.test("it starts at DSD512 with ASDM7EC, where the AHM modulators are marked as unable to play", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    const now = (await s.call("GET", "/now")).json;
    assert.equal(now.snapshot.status.activeRate, 22579200);
    assert.equal(now.snapshot.status.activeShaper, "ASDM7EC");
    assert.equal(now.snapshot.status.state, 2, "the demo does not start playing");
    const caps = (await s.call("GET", "/capabilities")).json;
    assert.match(caps.hints.shaper.AHM7EC8B.warn, /^won't play: AHM7EC8B needs/);
  });
  await t.test("THE demo's point: picking one anyway shows the stop and the automatic undo", async (tt) => {
    const FAST = { graceMs: 50, healthyMs: 150, maxMs: 600, sampleMs: 20, minSpeed: 0.85, stoppedMs: 150 };
    const s = service(tt, { hqpEnabled: true, hqpDemo: true }, { timing: { quick: FAST, major: FAST } });
    const r = (await s.call("POST", "/change", { shaper: "AHM7EC8B" })).json;
    assert.equal(r.playback.kind, "stopped");
    assert.equal(r.rolledBack.results[0].actual, "ASDM7EC");
    assert.deepEqual(r.rolledBack.playback, { kind: "playing" });
    assert.match(r.incompatible.text, /AHM7EC8B needs/);
    assert.equal(s.svc.demoFake.playback, 2, "the demo was left stopped");
  });
  await t.test("its learned failures are its own, never the real HQPlayer's", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    assert.equal((await s.call("GET", "/settings")).json.learned_count, 0);
    await s.svc.close();
  });
  await t.test("it keeps no log of the requests it answers — it runs as long as the extension does", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    assert.equal((await s.call("GET", "/now")).json.reachable, true);
    await s.call("GET", "/capabilities");
    assert.equal(s.svc.demoFake.received.length, 0, "every status poll would be kept for as long as the demo runs");
    await s.svc.close();
  });
  await t.test("many requests at once start ONE fake", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpDemo: true });
    await Promise.all([s.call("GET", "/now"), s.call("GET", "/capabilities"), s.call("GET", "/presets")]);
    const port = s.svc.demoPort;
    await Promise.all([s.call("GET", "/now"), s.call("GET", "/capabilities")]);
    assert.equal(s.svc.demoPort, port);
    await s.svc.close();
  });
});

test("the poller runs only while somebody is looking", async (t) => {
  await t.test("THE one: started by /now, stopped once nobody has asked for a lease's length", async (tt) => {
    const fake = await fakeFor(tt, "desktop5-mac-sdm");
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port });
    assert.equal(s.svc.polling, false);
    const now = (await s.call("GET", "/now")).json;
    assert.equal(now.reachable, true);
    assert.equal(now.inUse, "1x", "a 44.1k source plays through the 1x filter");
    assert.match(now.hintsKey, /^hqp@127\.0\.0\.1:\d+#0\|2\|44100\|/, now.hintsKey);
    assert.equal(s.svc.polling, true);
    const asked = fake.received.length;
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(s.svc.polling, false, "the poller outlived its lease");
    const after = fake.received.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.received.length, after, "HQPlayer is still being asked with nobody looking");
    assert.ok(after > asked, "precondition: it polled while leased");
    await s.svc.close();
    await fake.close();
  });
  await t.test("switching it off stops asking HQPlayer at once, not when the lease runs out", async (tt) => {
    const fake = await fakeFor(tt, "desktop5-mac-sdm");
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port }, { leaseMs: 60000 });
    assert.equal((await s.call("GET", "/now")).json.reachable, true);
    assert.equal(s.svc.polling, true, "precondition: polling");
    await s.call("POST", "/settings", { enabled: false });
    assert.equal(s.svc.polling, false, "still polling a switched-off HQPlayer");
    const seen = fake.received.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.received.length, seen, "HQPlayer is still being asked after the switch went off");
  });
  await t.test("THE key the page holds HQPlayer's lists under: both routes agree on it, and it moves when HQPlayer comes back", async (tt) => {
    // The page re-reads the lists whenever the key in a status differs from
    // the one its lists came with. If the two routes ever built it
    // differently, the page would re-read them on EVERY poll; if it did not
    // move when HQPlayer restarted (a new version, another output device),
    // the page would go on naming filters from lists that no longer apply.
    const fake = await fakeFor(tt, "desktop5-mac-sdm");
    const port = fake.port;
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: port });
    const first = (await s.call("GET", "/now")).json.hintsKey;
    assert.equal((await s.call("GET", "/capabilities")).json.hintsKey, first, "the two routes disagree about the key");
    // HQPlayer goes away...
    await fake.close();
    let quiet = null;
    for (let n = 0; n < 50 && !(quiet && quiet.reachable === false); n++) {
      await new Promise((r) => setTimeout(r, 30));
      quiet = (await s.call("GET", "/now")).json;
    }
    assert.equal(quiet.reachable, false, "precondition: HQPlayer was never seen to go quiet");
    // ...and comes back, on the same address.
    await fake.listen(port);
    let back = null;
    for (let n = 0; n < 50 && !(back && back.reachable); n++) {
      await new Promise((r) => setTimeout(r, 30));
      back = (await s.call("GET", "/now")).json;
    }
    assert.equal(back.reachable, true, "precondition: HQPlayer was never seen to come back");
    assert.notEqual(back.hintsKey, first, "the key did not move when HQPlayer came back — the page would keep its old lists");
    assert.equal((await s.call("GET", "/capabilities")).json.hintsKey, back.hintsKey);
  });
  await t.test("another HQPlayer has another key, even in the same state", async (tt) => {
    const a = await fakeFor(tt, "desktop5-mac-sdm");
    const b = await fakeFor(tt, "desktop5-mac-sdm");
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: a.port });
    const ka = (await s.call("GET", "/now")).json.hintsKey;
    await s.call("POST", "/settings", { port: b.port });
    const kb = (await s.call("GET", "/now")).json.hintsKey;
    assert.notEqual(ka, kb, "two HQPlayers in the same state share a key — the page would keep the first one's lists");
  });
  await t.test("THE one for a change: the status after it is the status AFTER it", async (tt) => {
    // Polling once a minute, so the only way /now can know about the change
    // is the read the Instance makes when a write finishes. Without it the
    // screen, having just shown -26 dB, was handed -22 again by the next
    // look and showed that until the next poll.
    const fake = await fakeFor(tt, "desktop5-mac-sdm");
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port }, { pollMs: 60000, leaseMs: 60000 });
    assert.equal((await s.call("GET", "/now")).json.snapshot.state.volume, -22);
    assert.equal((await s.call("POST", "/change", { volume: -26 })).status, 200);
    assert.equal((await s.call("GET", "/now")).json.snapshot.state.volume, -26);
    await s.svc.close();
  });
  await t.test("a status read that a write finished in the middle of is not published; it is read again at once", async (tt) => {
    const STATE = { mode: 2, rate: 0, filter1x: 49, filterNx: 51, shaper: 35, volume: -22, state: 2 };
    const before = { state: 2, position: 1 };
    const after = { state: 2, position: 2 };
    let release = null;
    let reads = 0;
    const client = {
      status: () => {
        reads++;
        return reads === 1 ? new Promise((r) => { release = () => r(before); }) : Promise.resolve(after);
      },
      state: () => Promise.resolve(STATE),
      close() {},
    };
    const inst = new Instance({ id: "t", host: "127.0.0.1", port: 1 }, { client });
    tt.after(() => inst.close());
    const events = [];
    const off = inst.subscribe((e) => events.push(e), 60000);
    for (let n = 0; n < 100 && !release; n++) await new Promise((r) => setTimeout(r, 2));
    assert.ok(release, "precondition: the first read never started");
    inst.wrote();                       // a change finishes while that read is out
    release();                          // ...and then its answer, from before the change, arrives
    for (let n = 0; n < 100 && !events.length; n++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(events.length, 1, "nothing was published");
    assert.equal(events[0].snapshot.status, after, "a status read across the write was published");
    assert.equal(reads, 2);
    off();
  });
  await t.test("an unreachable HQPlayer is reported as such, with the reason", async (tt) => {
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: 1 });
    const now = (await s.call("GET", "/now")).json;
    assert.equal(now.reachable, false);
    assert.ok(now.error, "no reason given");
    assert.equal(now.snapshot, null);
    await s.svc.close();
  });
  await t.test("changing the address drops the old HQPlayer at once", async (tt) => {
    const a = await fakeFor(tt, "desktop5-mac-sdm");
    const b = await fakeFor(tt, "desktop5-linux-pcm");
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: a.port });
    assert.equal((await s.call("GET", "/now")).json.snapshot.status.activeMode, "SDM (DSD)");
    await s.call("POST", "/settings", { port: b.port });
    assert.equal((await s.call("GET", "/now")).json.snapshot.status.activeMode, "PCM");
    const seenByA = a.received.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(a.received.length, seenByA, "the old HQPlayer is still being polled");
    await s.svc.close();
    await a.close(); await b.close();
  });
});

test("POST /test: does anything answer as HQPlayer there?", async (t) => {
  await t.test("yes, with its name and version — and the connection is closed straight after", async (tt) => {
    const fake = await fakeFor(tt, "desktop5-linux-pcm");
    const s = service(tt, {});
    const r = (await s.call("POST", "/test", { host: "127.0.0.1", port: fake.port })).json;
    assert.deepEqual(r, { ok: true, name: "fake-linux", product: "Signalyst HQPlayer Desktop", engine: "5.35.10", version: "5" });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(fake.sockets.size, 0, "the probe left its connection open");
    await s.svc.close();
    await fake.close();
  });
  await t.test("no, with the reason; and an address is required", async (tt) => {
    const s = service(tt, {});
    const r = (await s.call("POST", "/test", { host: "127.0.0.1", port: 1 })).json;
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal((await s.call("POST", "/test", {})).status, 400);
    await s.svc.close();
  });
});

test("the Roon zone playing through HQPlayer", async (t) => {
  const zone = (id, controls, np) => ({
    zone_id: id, display_name: "Zone " + id, state: "playing",
    outputs: [{ output_id: "o" + id, source_controls: controls }],
    now_playing: np || null,
  });
  await t.test("found by its source control, as hqpweb measured — and only that zone", () => {
    const zones = {
      a: zone("a", [{ display_name: "HQPlayer" }], { image_key: "img", three_line: { line1: "Track", line2: "Artist", line3: "Album" } }),
      b: zone("b", [{ display_name: "Amp" }]),
      c: zone("c", undefined),
    };
    assert.deepEqual(hqpZones(zones), [{ zone_id: "a", display_name: "Zone a", state: "playing",
      track: "Track", artist: "Artist", album: "Album", image_key: "img" }]);
    assert.deepEqual(hqpZones({}), []);
    assert.deepEqual(hqpZones(null), []);
  });
  await t.test("reported beside a real HQPlayer's status", async (tt) => {
    const fake = await fakeFor(tt, "desktop5-mac-sdm");
    const zones = { a: zone("a", [{ display_name: "HQPlayer" }], { three_line: { line1: "T", line2: "A", line3: "L" } }) };
    const s = service(tt, { hqpEnabled: true, hqpHost: "127.0.0.1", hqpPort: fake.port }, { zones: () => zones });
    const now = (await s.call("GET", "/now")).json;
    assert.equal(now.roon.length, 1);
    assert.equal(now.roon[0].track, "T");
    await s.svc.close();
    await fake.close();
  });
});

test("index.js mounts the service, and the poll is kept out of the request trace", () => {
  const src = indexSource();
  assert.match(src, /const \{ createHqpService \} = require\("\.\/lib\/hqp\/service"\);/);
  assert.match(src, /const hqp = createHqpService\(\{[\s\S]{0,300}getSettings: \(\) => loadPersistedSettings\(\),[\s\S]{0,200}saveSettings: \(patch\) => savePersistedSettings\(patch\),[\s\S]{0,100}zones: \(\) => zones,/);
  assert.match(src, /\nhqp\.mount\(app\);\n/);
  // Its data stays on the data volume, beside everything else that survives an update.
  assert.match(src, /dataDir: path\.join\(__dirname, "data"\)/);
  const skip = src.match(/^const TRACE_SKIP = (\/.*\/);$/m);
  assert.ok(skip, "TRACE_SKIP moved");
  const re = new RegExp(skip[1].slice(1, skip[1].lastIndexOf("/")));
  assert.ok(re.test("/api/hqp/now"), "the 1.5 s poll would fill the debug log");
  assert.ok(!re.test("/api/hqp/change"), "changes would be missing from the debug log");
});
