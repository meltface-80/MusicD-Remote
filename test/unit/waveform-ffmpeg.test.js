"use strict";
// ---------------------------------------------------------------------------
// v1.8.30: finding ffmpeg, and saying so when it is not there.
//
// Reported as "waveforms enabled, local files, nothing produced". Nothing in
// the pipeline said why, because every way it can fail resolves to the same
// silent null — and one of those ways was self-inflicted:
//
//   ffmpeg-static EXPORTS A PATH WHETHER OR NOT THE BINARY EXISTS. It
//   downloads a platform build in a postinstall script and `require` returns
//   where that build was SUPPOSED to land. A download that never happened (an
//   offline or rate-limited `docker build`, an unsupported platform) leaves a
//   perfectly good-looking absolute path pointing at nothing, and the old code
//   took it on trust — so every decode spawned a file that does not exist and
//   got ENOENT, for the life of the container, with no log line.
//
// The image ships no ffmpeg of its own, so there was nothing to fall back to
// either. These tests pin the two halves: the path must be CHECKED, and the
// probe must report a failure rather than swallowing it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// A stand-in for child_process.spawn. `behaviour` decides what the fake
// process does: run normally, fail with ENOENT the way a missing binary does
// (asynchronously, on the error event — NOT by throwing), or hang.
function fakeSpawn(behaviour, seen) {
  return function (cmd, args) {
    if (seen) { seen.cmd = cmd; seen.args = args; }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (behaviour === "enoent") {
      // This is the shape that matters: spawn() of a non-existent binary does
      // not throw on Linux, it emits 'error' on the next tick. A try/catch
      // around spawn() therefore catches nothing at all.
      setImmediate(() => child.emit("error", Object.assign(
        new Error("spawn " + cmd + " ENOENT"), { code: "ENOENT" })));
    } else if (behaviour === "ok") {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("ffmpeg version 6.1.1-static\nbuilt with gcc\n"));
        child.emit("close", 0);
      });
    } else if (behaviour === "badexit") {
      setImmediate(() => child.emit("close", 1));
    }
    return child;
  };
}

// The module caches its resolution, so each case needs a fresh copy.
function freshDecoder() {
  delete require.cache[require.resolve("../../lib/waveform-decode")];
  delete require.cache[require.resolve("../../lib/waveform")];
  return require("../../lib/waveform-decode");
}

test("a real ffmpeg reports its version", async () => {
  const WFD = freshDecoder();
  const seen = {};
  const p = await WFD.ffmpegProbe({ spawn: fakeSpawn("ok", seen) });
  assert.equal(p.ok, true, "a working ffmpeg was reported as broken: " + JSON.stringify(p));
  assert.equal(seen.args[0], "-version", "the probe should ask for the version, cheaply");
  assert.match(p.version, /ffmpeg version/, "the version line was not captured: " + p.version);
  assert.equal(p.error, "");
  assert.ok(p.path, "the probe did not say which binary it tried");
  assert.ok(p.source, "the probe did not say where that binary came from");
});

test("a missing binary is REPORTED, not swallowed", async () => {
  // The whole point. ENOENT arrives on the error event, so this also pins that
  // the probe listens for it — without that listener the event is unhandled
  // and takes the process with it.
  const WFD = freshDecoder();
  const p = await WFD.ffmpegProbe({ spawn: fakeSpawn("enoent") });
  assert.equal(p.ok, false, "a missing ffmpeg was reported as working");
  assert.match(p.error, /ENOENT/, "the error did not survive to the caller: " + JSON.stringify(p));
});

test("a binary that runs but fails is not counted as working", async () => {
  const WFD = freshDecoder();
  const p = await WFD.ffmpegProbe({ spawn: fakeSpawn("badexit") });
  assert.equal(p.ok, false, "a non-zero exit was treated as success");
  assert.match(p.error, /exited 1/);
});

test("the probe never hangs on a wedged binary", async () => {
  const WFD = freshDecoder();
  const started = Date.now();
  const p = await WFD.ffmpegProbe({ spawn: fakeSpawn("hang") });
  assert.equal(p.ok, false);
  assert.match(p.error, /timed out/);
  assert.ok(Date.now() - started < 20000, "the probe took " + (Date.now() - started) + "ms");
});

// Loads a fresh copy of the decoder with `require("ffmpeg-static")` answering
// with `value`. Module._load is what a bare require goes through, so this is
// the same path the real package takes — not a stub the code has to know about.
function decoderWithStatic(value) {
  const resolved = require.resolve("../../lib/waveform-decode");
  delete require.cache[resolved];
  delete require.cache[require.resolve("../../lib/waveform")];
  const Module = require("node:module");
  const realLoad = Module._load;
  Module._load = function (request) {
    if (request === "ffmpeg-static") {
      if (value instanceof Error) throw value;
      return value;
    }
    return realLoad.apply(this, arguments);
  };
  try {
    const WFD = require("../../lib/waveform-decode");
    // Resolution is LAZY and cached, so it has to happen while the patch is
    // still in place. Restoring Module._load first means the real (absent)
    // package answers instead, and the test passes for the wrong reason —
    // which is exactly what it did before this line.
    WFD.ffmpegPath();
    return WFD;
  } finally {
    Module._load = realLoad;
    delete require.cache[resolved];
  }
}

test("THE BUG: an ffmpeg-static path pointing at nothing falls back to PATH", () => {
  // ffmpeg-static's postinstall downloads the binary; require() only reports
  // where it was SUPPOSED to land. This is what a failed download looks like
  // from inside the app: a perfectly good-looking absolute path, and nothing
  // there. Trusting it spawns a file that does not exist on every single
  // decode, for the life of the container, and logs nothing.
  const ghost = path.join(os.tmpdir(), "ffmpeg-static-that-never-downloaded", "ffmpeg");
  assert.ok(!fs.existsSync(ghost), "the fixture path must not exist for this to mean anything");

  const WFD = decoderWithStatic(ghost);
  assert.equal(WFD.ffmpegPath(), "ffmpeg",
    "ffmpegPath() returned " + WFD.ffmpegPath() + ", which does not exist on disk. " +
    "ffmpeg-static exports that path whether or not its postinstall actually " +
    "delivered the binary, so it has to be checked before it is trusted — " +
    "otherwise every decode gets ENOENT and the feature fails silently for ever.");
});

test("and the fallback says WHY, so the log is not a mystery", () => {
  const ghost = path.join(os.tmpdir(), "ffmpeg-static-that-never-downloaded", "ffmpeg");
  const WFD = decoderWithStatic(ghost);
  return WFD.ffmpegProbe({ spawn: fakeSpawn("enoent") }).then((p) => {
    assert.match(p.source, /PATH/, "the probe should say it fell back to PATH: " + p.source);
    assert.match(p.source, /does not exist/,
      "the reason for the fallback is the useful half — without it the log says " +
      "'PATH' and leaves you guessing: " + p.source);
  });
});

test("ffmpeg-static not installed at all still resolves to PATH", () => {
  const WFD = decoderWithStatic(new Error("Cannot find module 'ffmpeg-static'"));
  assert.equal(WFD.ffmpegPath(), "ffmpeg");
});

test("a path that exists is preferred over PATH", (t) => {
  // The other direction: the check must not be so strict that a perfectly good
  // ffmpeg-static install gets ignored in favour of whatever the host ships.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ffmpeg-"));
  const fake = path.join(dir, "ffmpeg");
  fs.writeFileSync(fake, "#!/bin/sh\necho ffmpeg version 9.9-fake\n");
  fs.chmodSync(fake, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = require.resolve("../../lib/waveform-decode");
  delete require.cache[resolved];
  delete require.cache[require.resolve("../../lib/waveform")];
  // Stand in for the package: Module._load is what `require("ffmpeg-static")`
  // goes through, so this is the same path the real one takes.
  const Module = require("node:module");
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "ffmpeg-static") return fake;
    return realLoad.apply(this, arguments);
  };
  try {
    const WFD = require("../../lib/waveform-decode");
    assert.equal(WFD.ffmpegPath(), fake,
      "an ffmpeg-static binary that really is on disk should win — the app pins it " +
      "with the release, so it must not defer to whatever the host image ships");
  } finally {
    Module._load = realLoad;
    delete require.cache[resolved];
  }
});
