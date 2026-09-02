"use strict";
// ---------------------------------------------------------------------------
// lib/waveform-decode.js — the ffmpeg path, with a fake ffmpeg.
//
// The spawn is injected so every branch here is reachable without the binary
// being present: a decoder that is not installed, a file that will not decode,
// a process that hangs, a file that decodes most of the way and then errors,
// and a prefetch the user overtakes by skipping.
//
// The contract this pins is the one the callers depend on: decodeWaveform
// NEVER rejects. Every failure is null, because every failure means the same
// thing to the UI — draw the plain bar.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const d = require("../../lib/waveform-decode");

// A stand-in for a spawned ffmpeg. Drive it from the test.
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = 0;
  c.kill = () => { c.killed++; };
  return c;
}
const pcm = (n, fn) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(fn(i), i * 2);
  return b;
};

test("the flags ask for exactly one mono stream", () => {
  const a = d.args("/music/x.flac");
  // -map 0:a:0 is the one that is easy to drop and hard to notice: without it
  // a rip carrying a commentary track can have its SECOND stream chosen, and
  // the waveform is of the wrong audio while looking perfectly plausible.
  assert.ok(a.includes("-map") && a[a.indexOf("-map") + 1] === "0:a:0",
    "the first audio stream is not pinned: " + a.join(" "));
  assert.equal(a[a.indexOf("-ac") + 1], "1", "not downmixed to mono");
  assert.equal(a[a.indexOf("-f") + 1], "s16le");
  assert.ok(a.includes("-nostdin"), "ffmpeg could block waiting on stdin");
  assert.equal(a[a.length - 1], "-", "output does not go to the pipe");
});

test("a decode that works returns the waveform", async () => {
  const child = fakeChild();
  const p = d.decodeWaveform("/music/a.flac", { spawn: () => child, buckets: 8 });
  // 8192 samples at the default 256 stride is 32 intermediate peaks, so 8
  // buckets are 4 peaks each and the halfway boundary falls exactly on a
  // bucket edge. A ragged count puts the transition INSIDE a bucket, which
  // then reads loud — correctly, but it makes the assertion about arithmetic
  // rather than about the waveform.
  child.stdout.emit("data", pcm(8192, i => (i < 4096 ? 0 : 12000)));
  child.emit("close", 0);
  const wf = await p;
  assert.ok(wf instanceof Uint8Array);
  assert.equal(wf.length, 8);
  assert.equal(Math.max(...wf.slice(0, 4)), 0, "the silent half is not silent");
  assert.equal(Math.max(...wf.slice(4)), 255);
});

test("every failure is null, never a rejection", async (t) => {
  await t.test("no ffmpeg at all (spawn throws)", async () => {
    const wf = await d.decodeWaveform("/music/a.flac", {
      spawn: () => { throw new Error("ENOENT"); },
    });
    assert.equal(wf, null);
  });

  await t.test("no ffmpeg on PATH (error event)", async () => {
    const child = fakeChild();
    const p = d.decodeWaveform("/music/a.flac", { spawn: () => child });
    child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    assert.equal(await p, null);
  });

  await t.test("a file that yields no audio", async () => {
    const child = fakeChild();
    const p = d.decodeWaveform("/music/broken.flac", { spawn: () => child });
    child.stderr.emit("data", Buffer.from("Invalid data found when processing input\n"));
    child.emit("close", 1);
    assert.equal(await p, null);
    assert.match(d.lastDecodeError(), /Invalid data/);
  });

  await t.test("a process that never finishes is killed", async () => {
    const child = fakeChild();
    const p = d.decodeWaveform("/music/hang.flac", { spawn: () => child, timeoutMs: 30 });
    assert.equal(await p, null);
    assert.ok(child.killed > 0, "the timed-out ffmpeg was left running");
  });
});

test("a damaged file still gives the shape it managed to decode", async () => {
  // A truncated rip decodes most of the way and then exits non-zero. Most of
  // the way is a perfectly good picture of the track, and throwing it away
  // would mean the files most worth SEEING are the ones that show nothing.
  const child = fakeChild();
  const p = d.decodeWaveform("/music/truncated.flac", { spawn: () => child, buckets: 4 });
  child.stdout.emit("data", pcm(2000, () => 9000));
  child.stderr.emit("data", Buffer.from("Truncated file\n"));
  child.emit("close", 1);
  const wf = await p;
  assert.ok(wf && wf.length === 4, "a partial decode was discarded");
  assert.equal(Math.max(...wf), 255);
});

test("a prefetch the user overtakes stops decoding", async () => {
  // The next-track prefetch is routinely overtaken by a skip. Checking the
  // signal only before spawning would let a 20-minute decode nobody wants run
  // to completion on a core the playing track needs.
  const child = fakeChild();
  const signal = { aborted: false };
  const p = d.decodeWaveform("/music/long.flac", { spawn: () => child, signal });
  child.stdout.emit("data", pcm(1000, () => 5000));
  signal.aborted = true;
  child.stdout.emit("data", pcm(1000, () => 5000));
  assert.equal(await p, null);
  assert.ok(child.killed > 0, "the abandoned ffmpeg was left running");
});

test("stderr from a pathological file cannot grow without bound", async () => {
  // ffmpeg can emit a line per frame on a damaged file. Holding all of it to
  // print one line is how one bad rip takes the server's memory with it.
  const child = fakeChild();
  const p = d.decodeWaveform("/music/noisy.flac", { spawn: () => child });
  for (let i = 0; i < 500; i++) child.stderr.emit("data", Buffer.alloc(1000, 0x41));
  child.emit("close", 1);
  assert.equal(await p, null);
  assert.ok(d.lastDecodeError().length <= 4096,
    "stderr grew to " + d.lastDecodeError().length + " bytes");
});
