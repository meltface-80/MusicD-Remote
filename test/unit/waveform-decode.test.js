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
  // A real Writable, because the piped form calls input.pipe(child.stdin) and
  // an EventEmitter is not something a stream will pipe into.
  c.stdin = new (require("node:stream").Writable)({ write(_c, _e, cb) { cb(); } });
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

// --- decoding from a stream (v1.8.6) ---------------------------------------
// A streaming track has no file and must not get one: the bytes go from the
// HTTPS response through ffmpeg and out as a thousand numbers. "Deleted
// afterwards" is a promise a crash can break; piping is a fact about how the
// data moved.

const { Readable } = require("node:stream");
const pipeArgs = d.pipeArgs;

test("the piped form reads stdin and does not pass -nostdin", () => {
  const a = pipeArgs();
  assert.ok(a.includes("pipe:0"), "ffmpeg was not pointed at stdin");
  assert.ok(!a.includes("-nostdin"), "-nostdin would close the input this form depends on");
  // Everything else must match the file form, or a streamed waveform would be
  // drawn from different numbers than a local one. The rate comes from the
  // constant rather than a literal: hard-coding it here meant a rate change had
  // to be made in two places, and this test failed for the wrong reason when
  // the decode moved from 8 kHz to 16 kHz.
  for (const flag of ["-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", String(d.DECODE_RATE)]) {
    assert.ok(a.includes(flag), `the piped decode dropped ${flag}`);
  }
});

test("THE one: no filename reaches ffmpeg when a stream is given", async () => {
  let sawArgs = null, sawStdio = null;
  const child = fakeChild();
  await d.decodeWaveform("/should/not/be/used.flac", {
    input: Readable.from([Buffer.alloc(4)]),
    spawn: (bin, a, o) => { sawArgs = a; sawStdio = o.stdio; return child; },
  }).then(() => {});
  assert.ok(!sawArgs.includes("/should/not/be/used.flac"),
    "the file path was passed anyway — a streaming decode must not touch disk");
  assert.equal(sawStdio[0], "pipe", "stdin was not opened, so nothing could be piped in");
});

test("audio piped in comes back out as peaks", async () => {
  const child = fakeChild();
  const p = d.decodeWaveform(null, {
    input: Readable.from([Buffer.alloc(2)]),
    buckets: 4,
    spawn: () => child,
  });
  // ffmpeg's answer: loud, then quiet.
  const pcm = Buffer.alloc(1600);
  for (let i = 0; i < 400; i++) pcm.writeInt16LE(30000, i * 2);
  child.stdout.emit("data", pcm);
  child.emit("close", 0);
  const peaks = await p;
  assert.equal(peaks.length, 4);
  assert.ok(peaks[0] > peaks[3], "the shape of the piped audio was lost");
});

test("EPIPE on the input is the normal end, not a crash", async () => {
  // ffmpeg closes stdin as soon as it has enough audio, while the response is
  // still arriving. Unhandled, that error takes the server down for a decode
  // that actually worked.
  const child = fakeChild();
  const src = Readable.from([Buffer.alloc(8)]);
  const p = d.decodeWaveform(null, { input: src, buckets: 2, spawn: () => child });
  child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
  const pcm = Buffer.alloc(400);
  for (let i = 0; i < 100; i++) pcm.writeInt16LE(1000, i * 2);
  child.stdout.emit("data", pcm);
  child.emit("close", 0);
  assert.ok(await p, "a normal EPIPE lost the waveform");
});

test("a failing download resolves to no waveform rather than rejecting", async () => {
  const child = fakeChild();
  const src = new Readable({ read() {} });
  const p = d.decodeWaveform(null, { input: src, spawn: () => child });
  src.emit("error", new Error("socket hang up"));
  assert.equal(await p, null);
});

test("THE other one: giving up stops the download too", async () => {
  // A cancelled prefetch that keeps pulling megabytes is the bandwidth version
  // of the orphaned process the timeout exists to prevent.
  const child = fakeChild();
  let destroyed = false;
  const src = new Readable({ read() {} });
  src.destroy = () => { destroyed = true; };
  const signal = { aborted: false };
  const p = d.decodeWaveform(null, { input: src, signal, spawn: () => child });
  signal.aborted = true;
  child.stdout.emit("data", Buffer.alloc(2));   // cancellation is checked here
  await p;
  assert.equal(destroyed, true, "the response was left open after the decode was abandoned");
});

// ---------------------------------------------------------------------------
// v1.8.22 — the decode rate.
//
// 8 kHz made ffmpeg lowpass at 4 kHz before peaks were taken, so cymbals,
// snare cracks and sibilance — most of whose energy is above that — were
// filtered away before they could register. Measured over a track of
// transients, 8 kHz under-read the drawn bars by a mean of 16/255 and by up to
// 52/255, and under-read on the majority of them: a systematic flattening.
//
// It is close to free: the decode of the compressed source dominates, and
// 44.1 kHz (five times the PCM) measured the same wall clock as 8 kHz.
// ---------------------------------------------------------------------------

test("both decode forms ask for the same rate, and it is 16 kHz", () => {
  const D = require("../../lib/waveform-decode");
  assert.equal(D.DECODE_RATE, 16000);
  for (const argv of [D.args("/music/x.flac"), D.pipeArgs()]) {
    const i = argv.indexOf("-ar");
    assert.ok(i >= 0, "-ar missing from " + JSON.stringify(argv));
    assert.equal(argv[i + 1], "16000",
      "a file decode and a stream decode must use the SAME rate — different " +
      "rates would give a local and a streamed copy of one track different shapes");
  }
});

test("nothing in the argv names a file to write", () => {
  // The waveform never touches disk. Input is a pipe or the source path;
  // output is stdout. A stray filename here would be an audio file on disk.
  const D = require("../../lib/waveform-decode");
  const argv = D.pipeArgs();
  assert.equal(argv[argv.length - 1], "-", "output must be stdout");
  assert.ok(argv.includes("pipe:0"), "input must be stdin");
  const looksLikePath = argv.filter((a) => /[/\\]/.test(a) && a !== "pipe:0" && a !== "0:a:0");
  assert.deepEqual(looksLikePath, [], "argv carries a path: " + JSON.stringify(argv));
});

test("the stride still leaves ample headroom above the stored buckets", () => {
  // At 16 kHz with stride 256 each intermediate peak covers ~16ms, so a
  // three-minute track holds ~11,250 of them before the reduction to 1,000.
  // If this ever drops below BUCKETS the stored waveform is being upsampled,
  // which is padding rather than detail.
  const WF = require("../../lib/waveform");
  const D = require("../../lib/waveform-decode");
  const perSecond = D.DECODE_RATE / WF.STRIDE;
  const shortestRealTrack = 60;
  assert.ok(perSecond * shortestRealTrack > WF.BUCKETS,
    "a one-minute track yields " + Math.round(perSecond * shortestRealTrack) +
    " peaks for " + WF.BUCKETS + " buckets — the store would be stretching");
});
