"use strict";
// ---------------------------------------------------------------------------
// The fake HQPlayer, and the client's one kept-open connection (v1.8.74).
//
// The fake is what the rest of the HQPlayer suite — and the Demo HQPlayer in
// Settings — stands on, so it is pinned to the behaviour hqpweb measured on
// two real HQPlayers: the lists of each mode, the two volume formats, the
// replies that say OK and change nothing, and the stall that follows an
// impossible rate/modulator combination. Ported from hqpweb's fake tests
// (MIT, (c) 2026 statelycurmudgeon — lib/hqp/LICENSE).
// ---------------------------------------------------------------------------

require("../lib/no-real-hqplayer");
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { FakeHqp, loadProfile } = require("../../lib/hqp/fake");
const { HqpClient } = require("../../lib/hqp/client");
const { cmd } = require("../../lib/hqp/commands");

// The fake and its client belong to the test `tt` and are closed when that
// test ends, pass or FAIL — a cleanup on a test's last line never runs after a
// failed assertion, and a fake left listening keeps the run from exiting.
async function start(tt, profile, opts) {
  const fake = new FakeHqp(loadProfile(profile || "desktop5-mac-sdm"), Object.assign({ timeScale: 0 }, opts || {}));
  const { port } = await fake.listen();
  const client = new HqpClient("127.0.0.1", { port, timeoutMs: 2000 });
  const s = { fake, client, port };
  tt.after(() => stop(s));
  return s;
}
async function stop(s) {
  s.client.close();
  await s.fake.close();
}
const byName = (list, name) => {
  const hit = list.find((x) => x.name === name);
  if (!hit) throw new Error(name + " not in list");
  return hit.index;
};
// One raw request on its own connection.
function raw(port, body) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) { s.destroy(); resolve(buf.slice(0, nl)); }
    });
    s.write('<?xml version="1.0" encoding="UTF-8"?>' + body + "\n");
  });
}

test("the guard: nothing in this suite can reach a real HQPlayer", async (t) => {
  assert.throws(() => net.connect(4321, "127.0.0.1"), /never connect to port 4321/);
  const c = new HqpClient("127.0.0.1", { port: 4321, timeoutMs: 500 });
  await assert.rejects(c.info(), /never connect to port 4321/);
  c.close();
  const f = new FakeHqp(loadProfile("desktop5-mac-sdm"), { timeScale: 0 });
  // Closed even if it DID start listening, or the run could never exit.
  t.after(() => f.close());
  await assert.rejects(f.listen(4321), /real HQPlayer port/, "the fake agreed to listen on the real HQPlayer's port");
});

test("reads (the Mac SDM profile)", async (t) => {
  const s = await start(t);

  await t.test("serves the captured lists and state", async (tt) => {
    assert.equal((await s.client.filters()).length, 77);
    assert.equal((await s.client.shapers()).length, 36);
    assert.deepEqual((await s.client.rates()).map((r) => r.rate), [0, 2822400, 5644800, 11289600, 22579200, 45158400]);
    const st = await s.client.state();
    assert.equal(st.mode, 2); assert.equal(st.activeMode, 1); assert.equal(st.filterNx, 51);
    assert.equal(st.filter1x, 49); assert.equal(st.shaper, 35); assert.equal(st.volume, -22); assert.equal(st.state, 2);
    const status = await s.client.status();
    assert.equal(status.activeMode, "SDM (DSD)");
    assert.equal(status.activeRate, 45158400);
    assert.equal(status.activeShaper, "AHM7EC8B");
  });

  await t.test("the 1x filter for a 44.1 kHz source, the Nx filter for 96 kHz (measured)", async (tt) => {
    assert.equal((await s.client.status()).activeFilter, "poly-sinc-gauss-xla");
    assert.equal((await s.client.state()).filterInUse, 49);
    s.fake.setSource(96000);
    assert.equal((await s.client.status()).source.sampleRate, 96000);
    assert.equal((await s.client.status()).activeFilter, "poly-sinc-gauss-hires-lp");
    assert.equal((await s.client.state()).filterInUse, 51);
    s.fake.setSource(44100);
  });

  await t.test("several requests on one connection are answered in order", async (tt) => {
    const replies = await new Promise((resolve, reject) => {
      const sock = net.connect(s.port, "127.0.0.1");
      let buf = "";
      sock.on("error", reject);
      sock.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n").filter(Boolean);
        if (lines.length === 2) { sock.destroy(); resolve(lines); }
      });
      sock.write('<?xml version="1.0" encoding="UTF-8"?><GetInfo/>\n<?xml version="1.0" encoding="UTF-8"?><VolumeRange/>\n');
    });
    assert.match(replies[0], /<GetInfo/);
    assert.match(replies[1], /max="-3"/);
  });
});

test("the reply quirks hqpweb measured", async (t) => {
  const s = await start(t);

  await t.test("Set20kFilter and SetAdaptiveVolume reply with no result, yet apply", async (tt) => {
    assert.deepEqual(await s.client.send(cmd.set20kFilter(true)), { kind: "none" });
    assert.deepEqual(await s.client.send(cmd.setAdaptiveVolume(true)), { kind: "none" });
    const st = await s.client.state();
    assert.equal(st.filter20k, true);
    assert.equal(st.adaptive, true);
  });
  await t.test("convolution says OK and nothing changes", async (tt) => {
    assert.deepEqual(await s.client.send(cmd.setConvolution(true)), { kind: "ok" });
    assert.equal((await s.client.state()).convolution, false);
  });
  await t.test("unknown commands and ConfigurationLoad are errors", async (tt) => {
    assert.deepEqual(await s.client.send('<SetFilter20k value="1"/>'), { kind: "error", message: "Unknown command" });
    assert.deepEqual(await s.client.send('<ConfigurationLoad value="Example configuration 1"/>'),
      { kind: "error", message: "missing data or not authorized" });
  });
  await t.test("an out-of-range index says OK and changes nothing (inferred, and hostile on purpose)", async (tt) => {
    assert.deepEqual(await s.client.send(cmd.setShaping(999)), { kind: "ok" });
    assert.equal((await s.client.state()).shaper, 35);
  });
});

test("volume", async (t) => {
  await t.test("fractional dB is kept", async (tt) => {
    const s = await start(tt);
    await s.client.send(cmd.volume(-30.5));
    assert.equal((await s.client.state()).volume, -30.5);
    await stop(s);
  });
  await t.test("the Linux profile prints the long float form", async (tt) => {
    const s = await start(tt, "desktop5-linux-pcm");
    assert.match(await raw(s.port, cmd.state()), /volume="-28\.00000000000000000"/);
    assert.equal((await s.client.state()).volume, -28);
    await stop(s);
  });
});

test("a mode change swaps every list and restores each mode's settings", async (t) => {
  const s = await start(t);
  await t.test("PCM lists, the same filter name at another index, and back", async (tt) => {
    const modes = await s.client.modes();
    await s.client.send(cmd.setMode(byName(modes, "PCM")));
    assert.equal((await s.client.state()).activeMode, 0);
    assert.equal((await s.client.filters()).length, 67);
    assert.equal((await s.client.shapers()).length, 10);
    assert.equal((await s.client.rates()).length, 13);
    // Same name, different index per mode (measured): resolve by name.
    assert.equal(byName(await s.client.filters(), "poly-sinc-gauss-hires-lp"), 40);
    await s.client.send(cmd.setMode(byName(modes, "SDM (DSD)")));
    const st = await s.client.state();
    assert.deepEqual([st.filterNx, st.filter1x, st.shaper, st.state], [51, 49, 35, 2]);
  });
  await t.test("and the rate goes back to auto (reported for Embedded)", async (tt) => {
    await s.client.send(cmd.setShaping(byName(await s.client.shapers(), "ASDM7EC")));
    await s.client.send(cmd.setRate((await s.client.rates()).find((r) => r.rate === 22579200).index));
    const modes = await s.client.modes();
    await s.client.send(cmd.setMode(byName(modes, "PCM")));
    await s.client.send(cmd.setMode(byName(modes, "SDM (DSD)")));
    assert.equal((await s.client.state()).rate, 0);
  });
});

test("an impossible rate/modulator combination (measured)", async (t) => {
  await t.test("replies OK, stops, ignores Play, and resumes by itself once the rate is valid", async (tt) => {
    const s = await start(tt);
    const rates = await s.client.rates();
    assert.deepEqual(await s.client.send(cmd.setRate(rates.find((r) => r.rate === 22579200).index)), { kind: "ok" });
    assert.equal((await s.client.status()).state, 0);
    await s.client.send("<Play/>");
    assert.equal((await s.client.status()).state, 0);
    await s.client.send(cmd.setRate(rates.find((r) => r.rate === 0).index));
    assert.equal((await s.client.status()).state, 2);
    await stop(s);
  });
  await t.test("a valid combination at DSD512 keeps playing", async (tt) => {
    const s = await start(tt);
    await s.client.send(cmd.setShaping(byName(await s.client.shapers(), "ASDM7EC")));
    await s.client.send(cmd.setRate((await s.client.rates()).find((r) => r.rate === 22579200).index));
    const st = await s.client.status();
    assert.deepEqual([st.state, st.activeRate, st.activeShaper], [2, 22579200, "ASDM7EC"]);
    await stop(s);
  });
});

test("the client keeps one connection", async (t) => {
  await t.test("many requests, one connection", async (tt) => {
    const s = await start(tt);
    await s.client.state();
    await Promise.all([s.client.status(), s.client.filters(), s.client.shapers(), s.client.volumeRange()]);
    await s.client.send(cmd.volume(-30));
    assert.equal(s.client.connections, 1);
    assert.equal(s.fake.connections, 1);
    await stop(s);
  });
  await t.test("reconnects without a fuss when HQPlayer closed an idle connection", async (tt) => {
    const s = await start(tt, "desktop5-mac-sdm", { idleTimeoutMs: 50 });
    await s.client.state();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await s.client.state()).volume, -22);
    assert.equal(s.client.connections, 2);
    await stop(s);
  });
  await t.test("a request that meets the connection closing under it is sent again, once, on a new one", async (tt) => {
    const s = await start(tt);
    await s.client.state();
    s.fake.dropNext = 1;   // HQPlayer's idle close, crossing the next request
    assert.equal((await s.client.state()).volume, -22, "the request was lost with the connection");
    assert.equal(s.client.connections, 2);
    s.fake.dropNext = 2;   // ...but only once: a second close is a real failure
    await assert.rejects(s.client.state(), /closed/);
  });
  await t.test("fails cleanly when nothing is listening — and the process survives it", async (tt) => {
    const c = new HqpClient("127.0.0.1", { port: 1, timeoutMs: 1000 });
    await assert.rejects(c.state());
    await assert.rejects(c.state(), undefined, "a second request after a refused connection hung or crashed");
    c.close();
  });
  await t.test("a closed client opens nothing new", async (tt) => {
    const s = await start(tt);
    await s.client.state();
    s.client.close();
    await assert.rejects(s.client.state(), /closed/);
    assert.equal(s.client.connections, 1);
    await s.fake.close();
  });
  await t.test("a request that times out does not take the NEXT request down with it", async (tt) => {
    // A SetFilter that HQPlayer takes ~5 s to prepare, against a 300 ms timeout.
    const s = await start(tt, "desktop5-mac-sdm", { timeScale: 0.2 });
    const slow = new HqpClient("127.0.0.1", { port: s.port, timeoutMs: 300 });
    await slow.state(); // pay the first-request cost
    const nx = byName(await slow.filters(), "poly-sinc-gauss-long");
    await assert.rejects(slow.send(cmd.setFilter(nx, 49)), /timeout/);
    // The timed-out connection closes asynchronously; this request is already
    // waiting on a NEW one by then and must not be failed by that close.
    assert.equal((await slow.state()).volume, -22);
    slow.close();
    await stop(s);
  });
});
