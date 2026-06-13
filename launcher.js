#!/usr/bin/env node
// launcher.js — supervises index.js and applies in-app updates across restarts.
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.
//
// Run the extension with `npm start` (which runs this) to get one-tap updates
// that actually restart cleanly. When index.js exits with code 75 it is asking
// to be updated/restarted: this launcher applies the staged build (overlaying
// files while the app is NOT running, so nothing replaces itself in place) and
// relaunches. Any other exit code stops the launcher too.

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const updater = require("./lib/updater");

const DIR = __dirname;
const UPDATE_EXIT = 75;
let stopping = false;

function applyStagedIfReady() {
  const readyFile = path.join(DIR, ".update", "READY");
  if (!fs.existsSync(readyFile)) return;
  try {
    const info = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    if (info && info.staged && fs.existsSync(info.staged)) {
      console.log("[launcher] applying staged update -> v" + (info.version || "?"));
      updater.applyStaged(info.staged, DIR, { log: (...a) => console.log("[launcher]", ...a) });
      console.log("[launcher] update applied.");
    }
  } catch (e) {
    console.error("[launcher] failed to apply staged update:", e.message);
  } finally {
    try { fs.rmSync(path.join(DIR, ".update"), { recursive: true, force: true }); } catch (e) {}
  }
}

function start() {
  const child = spawn(process.execPath, [path.join(DIR, "index.js")], {
    cwd: DIR,
    stdio: "inherit",
    env: Object.assign({}, process.env, { RRA_VIA_LAUNCHER: "1" })
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (code === UPDATE_EXIT) {
      console.log("[launcher] update requested; applying and restarting...");
      applyStagedIfReady();
      setTimeout(start, 500); // brief gap so the HTTP port is fully released
    } else {
      console.log("[launcher] index.js exited (code=" + code + ", signal=" + signal + "); stopping.");
      process.exit(code == null ? 0 : code);
    }
  });

  const forward = (sig) => { stopping = true; try { child.kill(sig); } catch (e) {} };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
}

console.log("[launcher] starting Roon Random Albums (auto-update enabled)");
start();
