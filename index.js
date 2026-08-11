// roon-random-albums  —  random-album wall extension for Roon
// Runs alongside Roon Server, exposes a web UI on http://<host>:3399
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.

const path = require("path");
const fs   = require("fs");
const zlib = require("zlib");
const express = require("express");
const compression = require("compression");

const RoonApi          = require("node-roon-api");
const RoonApiStatus    = require("node-roon-api-status");
const RoonApiBrowse    = require("node-roon-api-browse");
const RoonApiImage     = require("node-roon-api-image");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiSettings  = require("node-roon-api-settings");

const { createUpdater } = require("./lib/updater");
const { radioDecision, radioResumeDecision, radioQueueFloor } = require("./lib/radio");
const pkg = require("./package.json");
// Parse "1.6.31" → display "MusicD Remote v1.6 (Build 31)"
const [_vmaj, _vmin, _vpatch] = (pkg.version || "0.0.0").split(".");
const DISPLAY_SHORTVER = _vmaj + "." + _vmin;   // "1.5"
const DISPLAY_BUILD    = _vpatch || "0";          // "54"

const PORT       = parseInt(process.env.PORT || "3399", 10);
const ALBUM_COUNT_DEFAULT = 24;
// Debug logging defaults ON inside Docker (the image sets DOCKER=1) — docker
// logs is the only diagnostic surface users have, and every DEBUG gate in
// this codebase is logging-only (verified), so this changes no behavior.
// RRA_DEBUG=0 quiets a container; RRA_DEBUG=1 forces it on outside Docker.
const DEBUG      = process.env.RRA_DEBUG === "1" ||
                   (process.env.DOCKER === "1" && process.env.RRA_DEBUG !== "0");

// ---------------------------------------------------------------------------
// Timestamped logs + Roon-style log files. Every line gets an ISO-8601 UTC
// prefix (correlates with Roon Server's own logs) and is ALSO appended to
// data/logs/MusicD-Remote_log.txt on the data volume — so logs survive
// container rebuilds and can be zipped up for a bug report, exactly like
// Roon's own RoonServer_log.txt. At ~8 MB the current file rotates to
// MusicD-Remote_log.01.txt (newest) … up to .10.txt (oldest, then dropped):
// Roon's scheme, capped at 10 files (~88 MB worst case) instead of Roon's 20.
// stdout is untouched — docker logs shows the same lines. If the data volume
// is unavailable the file side disables itself; stdout always works.
// Patched once, before anything logs — the launcher runs index.js with
// inherited stdio (it stamps its own few lines but doesn't write the file:
// two writers on one file would interleave).
// ---------------------------------------------------------------------------
const util = require("util");
const LOG_DIR       = path.join(__dirname, "data", "logs");
const LOG_FILE      = path.join(LOG_DIR, "MusicD-Remote_log.txt");
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const LOG_MAX_FILES = 10;
let _logStream = null;
let _logBytes  = 0;
let _logDead   = false;   // volume unavailable — stdout-only from then on
function _numberedLog(i) {
  return path.join(LOG_DIR, "MusicD-Remote_log." + String(i).padStart(2, "0") + ".txt");
}
function _openLogStream() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  _logBytes  = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  _logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  _logStream.on("error", () => { _logDead = true; _logStream = null; });
}
function _rotateLogs() {
  if (_logStream) { _logStream.end(); _logStream = null; }
  if (fs.existsSync(_numberedLog(LOG_MAX_FILES))) fs.unlinkSync(_numberedLog(LOG_MAX_FILES));
  for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
    if (fs.existsSync(_numberedLog(i))) fs.renameSync(_numberedLog(i), _numberedLog(i + 1));
  }
  if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, _numberedLog(1));
  _openLogStream();
}
function _logToFile(line) {
  if (_logDead) return;
  try {
    if (!_logStream) _openLogStream();
    if (_logBytes >= LOG_MAX_BYTES) _rotateLogs();
    if (!_logStream) return;
    _logBytes += Buffer.byteLength(line);
    _logStream.write(line);
  } catch (e) { _logDead = true; _logStream = null; }   // volume gone — stdout keeps working
}
for (const _level of ["log", "warn", "error"]) {
  const _orig = console[_level].bind(console);
  console[_level] = (...args) => {
    const ts = new Date().toISOString();
    _orig(ts, ...args);
    _logToFile(ts + " " + util.format(...args) + "\n");
  };
}
// Docker Desktop on macOS has no host networking, so Roon's SOOD multicast
// discovery can never reach the LAN. ROON_CORE_IP (already shown in the
// README's macOS install commands) switches to a direct websocket connection
// to the Core instead. 9330 is the Roon Core's API port — the http_port that
// discovery would have advertised. Users paste all sorts of shapes here
// ("http://192.168.1.5", "192.168.1.5:9330", a trailing slash), so normalise
// to a bare host and honour an embedded port; a valid ROON_CORE_PORT wins
// over an embedded one. IPv6 literals pass through untouched — the host:port
// match requires exactly one colon.
const _coreHostRaw  = (process.env.ROON_CORE_IP || "").trim()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")   // strip a pasted scheme ("http://…")
  .replace(/\/.*$/, "");                     // strip a trailing path or slash
const _coreHostPort = /^([^:]+):(\d{1,5})$/.exec(_coreHostRaw);
const ROON_CORE_IP  = _coreHostPort ? _coreHostPort[1] : _coreHostRaw;
const _corePortEnv  = parseInt(process.env.ROON_CORE_PORT || "", 10);
const _corePortOk   = Number.isFinite(_corePortEnv) && _corePortEnv > 0 && _corePortEnv < 65536;
if (process.env.ROON_CORE_PORT && !_corePortOk) {
  console.warn("[roon] ROON_CORE_PORT=" + JSON.stringify(process.env.ROON_CORE_PORT) +
               " is not a valid port — ignoring it");
}
// The embedded port needs the same range check as the env one: \d{1,5}
// admits 65536–99999, and an out-of-range port makes `new URL()` throw
// synchronously inside ws_connect — a boot crash-loop, not a retry.
const _corePortEmb   = _coreHostPort ? parseInt(_coreHostPort[2], 10) : NaN;
const _corePortEmbOk = Number.isFinite(_corePortEmb) && _corePortEmb > 0 && _corePortEmb < 65536;
const ROON_CORE_PORT = _corePortOk ? _corePortEnv : (_corePortEmbOk ? _corePortEmb : 9330);

// ---------------------------------------------------------------------------
// Self-updater (checks GitHub; install offered in the web UI and Roon settings)
// ---------------------------------------------------------------------------
const REPO = (() => {
  const src = (pkg.repository && pkg.repository.url) || pkg.homepage || "";
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(src);
  return m ? { owner: m[1], repo: m[2] }
           : { owner: "meltface-80", repo: "MusicD-Remote" };
})();
const UPDATE_CHECK_MS = 168 * 60 * 60 * 1000; // re-check GitHub every 7 days
const updater = createUpdater({
  owner: REPO.owner, repo: REPO.repo,
  currentVersion: pkg.version,
  dir: __dirname,
  viaLauncher: process.env.RRA_VIA_LAUNCHER === "1",
  token: process.env.RRA_GITHUB_TOKEN || null,
  debug: DEBUG
});

// ---------------------------------------------------------------------------
// Roon extension setup
// ---------------------------------------------------------------------------
let core      = null;
let zones     = {};
// output_id -> raw Roon output object. Fed by BOTH subscriptions: the zone
// deltas (an output always arrives inside its zone) and subscribe_outputs.
// They describe the same objects from the same Core, so merging is consistent
// and last-writer-wins is safe. The outputs feed exists because grouping needs
// `can_group_with_output_ids`, which Roon can revise without a zone delta.
let outputs   = {};
// True once subscribe_outputs has delivered its snapshot. While it is live the
// outputs feed owns the map's lifecycle (full replace on Subscribed, removals
// on outputs_removed) and the zone feed only ever ADDS to it.
//
// That split matters for grouping: grouping output A into zone B *removes* zone
// A, and the zone feed's removal path would delete A's output from this map —
// even though the output still exists and has merely changed zone. The outputs
// feed reports it as outputs_changed, so letting it own removals keeps the
// output visible throughout. Without the feed (older Core, failed subscribe)
// the zone feed keeps its original full ownership, so nothing regresses.
let outputsFeedLive = false;
const scrobbleState = new Map();

// Roon pairing state must survive container rebuilds. node-roon-api's default
// persistence writes ./config.json relative to CWD (= /app, wiped by every
// docker update), so each update registered as a brand-new extension: Roon
// issued a fresh authorization every time and the old entries lingered as
// ghosts in Settings → Extensions → View extension authorizations. Keep the
// state on the mounted data volume instead, migrating any legacy token once
// so a running install keeps its existing pairing.
const ROON_STATE_FILE = path.join(__dirname, "data", "roonstate.json");
try {
  const legacyFile = path.join(__dirname, "config.json");
  if (!fs.existsSync(ROON_STATE_FILE) && fs.existsSync(legacyFile)) {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (legacy && legacy.roonstate) {
      fs.mkdirSync(path.dirname(ROON_STATE_FILE), { recursive: true });
      fs.writeFileSync(ROON_STATE_FILE, JSON.stringify(legacy.roonstate, null, 2));
    }
  }
} catch (e) { /* unreadable legacy config — start unpaired; user authorises once */ }

const roon = new RoonApi({
  extension_id:        "com.musicd.roon.random-albums",
  // The rename to "MusicD Remote" is display-only: extension_id stays
  // unchanged on purpose — changing it would make Roon treat this as a brand
  // new extension and force every user to re-authorize it.
  display_name:        "MusicD Remote v" + DISPLAY_SHORTVER,
  display_version:     "Build " + DISPLAY_BUILD,
  publisher:           "MusicD",
  email:               "hello@musicd.app",
  log_level:           "none",

  // Pairing token persistence on the data volume (see ROON_STATE_FILE above).
  get_persisted_state: () => {
    try { return JSON.parse(fs.readFileSync(ROON_STATE_FILE, "utf8")) || {}; }
    catch (e) { return {}; }   // missing/corrupt state file — register fresh
  },
  set_persisted_state: (state) => {
    try {
      fs.mkdirSync(path.dirname(ROON_STATE_FILE), { recursive: true });
      fs.writeFileSync(ROON_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) { /* data volume unavailable — pairing lasts this run only */ }
  },

  core_paired: function (c) {
    core = c;
    // Always-on: pairing transitions are the spine of every support log.
    console.log("[roon] paired with core", c.core_id,
                "(" + (c.display_name || "unnamed") + " " + (c.display_version || "") + ")");
    _statusPair = "Paired with " + c.core_id; _statusPairErr = false; pushStatus();
    c.services.RoonApiTransport.subscribe_zones((cmd, data) => {
      if (cmd === "Subscribed") {
        console.log("[roon] zone subscription established —",
                    (data.zones || []).length, "zone(s)");
        zones = {};
        if (!outputsFeedLive) outputs = {};
        // Reset transition tracking — treat every zone as newly seen.
        Object.keys(zonePrevState).forEach(k => delete zonePrevState[k]);
        (data.zones || []).forEach(z => {
          zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; });
          handleRadioZone(z, true); // isInitial=true: never auto-start on reconnect snapshot
          scrobbleUpdate(z);
        });
      } else if (cmd === "Changed") {
        (data.zones_added   || []).forEach(z => { zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; }); handleRadioZone(z, true); scrobbleUpdate(z); });
        (data.zones_changed || []).forEach(z => { zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; });
          // Before the radio decision, so the log shows the state that drove it.
          logZoneTransition(z);
          handleRadioZone(z); scrobbleUpdate(z); });
        (data.zones_removed || []).forEach(zid => {
          const z = zones[zid];
          // Only when the outputs feed isn't live — see outputsFeedLive above:
          // a grouped-away zone's output is still a real output.
          if (z && !outputsFeedLive) (z.outputs || []).forEach(o => delete outputs[o.output_id]);
          delete zones[zid];
          delete zonePrevState[zid]; // zone offline — reset so it won't auto-start if it returns
          delete zoneLogPrev[zid];   // and so its return reads as a first sighting, not a transition
          // A zone_id can come back (regrouping, a Core reboot). It must not
          // inherit an episode from before, or a stranding latched then would
          // resume a queue nobody is listening to now.
          forgetRadioZone(zid);
        });
      }
    });
    // A second, long-lived subscription for outputs. The zone feed above only
    // ever mentions an output as a member of a zone, so it cannot report a
    // change that is purely about the output itself — and grouping depends on
    // exactly that: `can_group_with_output_ids` tells us which outputs the Core
    // will let us group together, and it moves as devices come and go.
    //
    // One subscription for the life of the pairing (cleared in core_unpaired),
    // the same shape as the zone feed — NOT the subscribe-then-unsubscribe
    // pattern /api/queue uses, because this is a cache, not a one-shot read.
    // Unlike subscribe_zones, the SDK's subscribe_outputs keeps no internal
    // cache of its own, so the merge below is the only copy.
    c.services.RoonApiTransport.subscribe_outputs((cmd, data) => {
      if (cmd === "Subscribed") {
        console.log("[roon] output subscription established —",
                    ((data && data.outputs) || []).length, "output(s)");
        outputsFeedLive = true;
        outputs = {};
        ((data && data.outputs) || []).forEach(o => { outputs[o.output_id] = o; });
      } else if (cmd === "Changed") {
        ((data && data.outputs_added)   || []).forEach(o => { outputs[o.output_id] = o; });
        ((data && data.outputs_changed) || []).forEach(o => { outputs[o.output_id] = o; });
        ((data && data.outputs_removed) || []).forEach(oid => { delete outputs[oid]; });
      }
    });
    // Build the local search index in the background and keep it fresh.
    startIndexMaintenance();
    // Smart Picks rebuild once a day, on their own timer. Nothing user-facing
    // ever waits on that build — see kickSmartPicks.
    startSmartPicksMaintenance();
  },
  core_unpaired: function () {
    core = null; zones = {}; outputs = {}; outputsFeedLive = false;
    Object.keys(zonePrevState).forEach(k => delete zonePrevState[k]);
    // Radio working state goes with it. A stranding latched before the drop
    // would otherwise survive the reconnect and press play on a queue Roon
    // has persisted but nobody is sitting in front of any more.
    Object.keys(radioBusy).forEach(forgetRadioZone);
    Object.keys(zoneLogPrev).forEach(k => delete zoneLogPrev[k]);
    stopIndexMaintenance();
    // The album index is deliberately KEPT across an unpair: it's plain
    // offset/title data (no session-scoped item_keys), so it stays usable for
    // search while disconnected, and startIndexMaintenance() schedules one
    // recheck on re-pair instead of a full library re-walk — a flapping
    // connection no longer multiplies full rescans onto the Core.
    console.log("[roon] unpaired from core — index kept, awaiting re-pair");
    _statusSync = "";   // clear any "library updating…" note — sync state is reset on re-pair
    _statusPair = "Not paired with any Roon Core"; _statusPairErr = true; pushStatus();
  }
});

// ---- Roon status line (pairing state + any update notice) ----
let _statusPair = "Starting\u2026";
let _statusSync = "";   // "  \u2022  Roon library updating\u2026" while a sync is deferring background work
let _statusPairErr = false;
function pushStatus() {
  const st = updater.getStatus();
  let extra = "";
  if (st.apply.phase === "downloading" || st.apply.phase === "extracting") extra = "  \u2022  Updating\u2026";
  else if (st.apply.phase === "restarting") extra = "  \u2022  Restarting to update\u2026";
  else if (st.available) extra = `  \u2022  Update available: v${st.latest} \u2014 install from the web app or this Settings page`;
  try { svc_status.set_status(_statusPair + _statusSync + extra, _statusPairErr); } catch (e) {} // svc_status may be null before Roon pairs
}
async function updateCheckTick() {
  try { await updater.checkNow(); } catch (e) {} // network failure — no status to update, skip silently
  pushStatus();
}

// ---- Roon Settings: show version + offer to install an update ----
function makeSettingsLayout() {
  const st = updater.getStatus();
  const layout = [];
  const values  = { do_update: "no", do_check: "no" };

  // --- Random Album Radio per zone ---
  layout.push({ type: "label", title: "\u2500\u2500\u2500 Random Album Radio \u2500\u2500\u2500" });
  const knownZones = Object.values(zones || {}).sort((a, b) =>
    (a.display_name || "").localeCompare(b.display_name || ""));
  if (knownZones.length === 0) {
    layout.push({ type: "label", title: "No zones visible yet \u2014 open the Roon app first." });
  } else {
    for (const z of knownZones) {
      const settingKey = "radio_" + z.zone_id;
      values[settingKey] = radioZones.has(z.zone_id) ? "yes" : "no";
      layout.push({
        type: "dropdown", title: z.display_name,
        setting: settingKey,
        values: [
          { title: "Off", value: "no" },
          { title: "On \u2014 random album radio", value: "yes" }
        ]
      });
    }
  }

  // --- Updates ---
  layout.push({ type: "label", title: "\u2500\u2500\u2500 Updates \u2500\u2500\u2500" });
  if (st.apply.phase === "downloading" || st.apply.phase === "extracting" || st.apply.phase === "restarting") {
    layout.push({ type: "label", title: "Installing update\u2026 the extension will restart shortly." });
  } else if (st.checking) {
    layout.push({ type: "label", title: "Checking GitHub for updates\u2026" });
  } else if (st.error) {
    layout.push({ type: "label", title: "Update check problem: " + st.error });
  } else if (st.available) {
    layout.push({ type: "label", title: "An update is available: v" + st.latest + "." });
    if (st.notes) layout.push({ type: "label", title: "Notes: " + st.notes.slice(0, 280) });
    layout.push({
      type: "dropdown", title: "Install update", setting: "do_update",
      values: [
        { title: "Keep Build " + DISPLAY_BUILD, value: "no" },
        { title: "Install v" + st.latest + " now (restarts the extension)", value: "yes" }
      ]
    });
  } else {
    layout.push({ type: "label", title: "You're on the latest version." });
    layout.push({
      type: "dropdown", title: "Check for updates", setting: "do_check",
      values: [
        { title: "No action", value: "no" },
        { title: "Check now", value: "yes" }
      ]
    });
  }

  return { values, layout, has_error: false };
}

const svc_status = new RoonApiStatus(roon);
const svc_settings = new RoonApiSettings(roon, {
  get_settings: function (cb) { cb(makeSettingsLayout()); },
  save_settings: function (req, isdryrun, settings) {
    const vals = settings.values || {};
    const l = makeSettingsLayout();

    // Apply radio zone toggles immediately (even on dry run for live preview).
    for (const [k, v] of Object.entries(vals)) {
      if (!k.startsWith("radio_")) continue;
      const zoneId = k.slice(6);
      if (v === "yes") radioZones.add(zoneId);
      else radioZones.delete(zoneId);
    }
    if (!isdryrun) persistRadio();

    l.values.do_update = vals.do_update || "no";
    l.values.do_check  = vals.do_check  || "no";
    req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

    if (!isdryrun) {
      if (l.values.do_update === "yes") {
        svc_settings.update_settings(makeSettingsLayout());
        updater.apply().then(() => { pushStatus(); refreshSettings(); }).catch(() => { /* apply errors are surfaced via pushStatus; nothing else to do */ });
      }
      if (l.values.do_check === "yes") {
        svc_settings.update_settings(makeSettingsLayout());
        updater.checkNow().then(() => { pushStatus(); refreshSettings(); }).catch(() => { /* check errors surface via pushStatus next tick */ });
      }
    }
  }
});
function refreshSettings() { try { svc_settings.update_settings(makeSettingsLayout()); } catch (e) { /* Roon not yet paired — no settings service to update */ } }

roon.init_services({
  required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
  provided_services: [svc_status, svc_settings]
});
_statusPair = "Starting\u2026"; pushStatus();
if (ROON_CORE_IP) {
  // Direct connection for setups where multicast discovery can't work
  // (macOS / Docker Desktop). Unlike start_discovery(), ws_connect() never
  // retries on its own: it opens exactly one websocket, and a failed FIRST
  // connect fires only onerror (the transport suppresses onclose until a
  // connection has opened). Re-arm on both callbacks, matching discovery's
  // 10s rescan cadence, or a Core restart \u2014 or the Core simply booting after
  // this container \u2014 would strand the extension until a container restart.
  let _coreRetryTimer = null;
  let _coreConnGen    = 0;   // ws_connect never one-shots onerror, so a superseded socket's late callback must not re-arm the loop
  let _coreAttempts   = 0;
  const connectToCore = () => {
    _coreRetryTimer = null;
    const gen = ++_coreConnGen;
    _coreAttempts++;
    const retry = () => {
      if (gen !== _coreConnGen) return;  // stale callback from an older connection generation
      if (_coreRetryTimer) return;       // onerror + onclose can both fire for one drop \u2014 arm one timer
      // Misconfiguration must be diagnosable without RRA_DEBUG (a wrong IP is
      // this path's dominant failure mode, and docker logs is the only
      // pre-pairing surface): log the first failure, then one every ~5 min.
      if (_coreAttempts === 1 || _coreAttempts % 30 === 0) {
        console.log("[roon] cannot reach Roon Core at " + ROON_CORE_IP + ":" + ROON_CORE_PORT +
                    " \u2014 retrying every 10s (attempt " + _coreAttempts + ")." +
                    " Check ROON_CORE_IP / ROON_CORE_PORT if this persists.");
      }
      _statusPair = "Cannot reach Roon Core at " + ROON_CORE_IP + ":" + ROON_CORE_PORT + " \u2014 retrying";
      _statusPairErr = true; pushStatus();
      _coreRetryTimer = setTimeout(connectToCore, 10 * 1000);
      if (_coreRetryTimer.unref) _coreRetryTimer.unref();
    };
    if (DEBUG) console.log("[roon] connecting to core at " + ROON_CORE_IP + ":" + ROON_CORE_PORT);
    _statusPair = "Connecting to Roon Core at " + ROON_CORE_IP + ":" + ROON_CORE_PORT + "\u2026";
    _statusPairErr = false; pushStatus();
    try {
      roon.ws_connect({ host: ROON_CORE_IP, port: ROON_CORE_PORT, onclose: retry, onerror: retry });
    } catch (e) {
      // A host that can't form a valid ws:// URL (e.g. a bare IPv6 literal)
      // makes `new WebSocket()` throw synchronously \u2014 route it into the same
      // logged retry path instead of crash-looping the container.
      if (_coreAttempts === 1) console.warn("[roon] ws_connect failed: " + e.message);
      retry();
    }
  };
  connectToCore();
} else {
  roon.start_discovery();
}

// Begin background update checks (independent of Roon pairing).
updateCheckTick();
const _updTimer = setInterval(() => { updateCheckTick(); refreshSettings(); }, UPDATE_CHECK_MS);
if (_updTimer.unref) _updTimer.unref();

// ---------------------------------------------------------------------------
// Promisified Roon calls
// ---------------------------------------------------------------------------
// Every Roon browse/load/image call is traced with its round-trip duration:
// the request at DEBUG, the outcome with ms at DEBUG, failures ALWAYS (with
// the offending opts — a failed Roon call should never be invisible).
// The browse path was the only I/O in this file with no deadline at all —
// /api/queue has one, every HTTP fetch goes through fetchWithTimeout, the
// source probe races a deadline. A Core that accepts a call and never answers
// left the caller's promise pending FOREVER: its pooled browse session was
// never released, and on the radio path its "already working" guard was never
// cleared. Generous on purpose — this is a stuck-call backstop, not a
// performance budget, and a slow-but-working Core must not be broken by it.
function roonCallTimeoutMs() { return 90000; }

// Wrap a settle-once callback with a deadline. `who` names the call in the log.
function withRoonDeadline(kind, who, reject) {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    console.error("[" + kind + "] no answer after " + roonCallTimeoutMs() + "ms: " + who);
    reject(new Error("Roon did not answer in time"));
  }, roonCallTimeoutMs());
  if (timer.unref) timer.unref();   // never hold the process open
  return {
    settle(fn) {
      if (done) return;             // the deadline already rejected this call
      done = true;
      clearTimeout(timer);
      fn();
    },
  };
}

function browse(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    const t0 = Date.now();
    if (DEBUG) console.log("[browse]", JSON.stringify(opts));
    const guard = withRoonDeadline("browse",
      (opts.multi_session_key || "-") + " " + (opts.hierarchy || "-"), reject);
    // The SDK call itself can throw synchronously when the Core is torn down
    // mid-flight (core = null races with in-flight callers). Without this the
    // promise rejects but the deadline timer stays armed, and 90s later the
    // log claims a hung Core that never existed.
    try {
    core.services.RoonApiBrowse.browse(opts, (err, body) => guard.settle(() => {
      const ms = Date.now() - t0;
      // Concurrent operations interleave in the log, so the :res line carries
      // the session key + request shape — a slow call is attributable without
      // hunting for its matching request line.
      const who = (opts.multi_session_key || "-") + " " + (opts.hierarchy || "-") +
                  (opts.pop_all ? " pop_all" : (opts.item_key ? " item" : ""));
      if (err) {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("[browse] failed after " + ms + "ms:", who, msg, "opts:", JSON.stringify(opts));
        return reject(new Error(msg));
      }
      if (DEBUG) console.log("[browse:res]", ms + "ms", who, body && body.action,
                             body && body.list && body.list.title,
                             "count:", body && body.list ? body.list.count : "-");
      resolve(body);
    }));
    } catch (e) { guard.settle(() => reject(e)); }
  });
}
function load(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    const t0 = Date.now();
    if (DEBUG) console.log("[load]", JSON.stringify(opts));
    const guard = withRoonDeadline("load",
      (opts.multi_session_key || "-") + " " + (opts.hierarchy || "-"), reject);
    try {
    core.services.RoonApiBrowse.load(opts, (err, body) => guard.settle(() => {
      const ms = Date.now() - t0;
      // Same attribution as [browse:res]: key + hierarchy + offset/count.
      const who = (opts.multi_session_key || "-") + " " + (opts.hierarchy || "-") +
                  " @" + (opts.offset != null ? opts.offset : 0) + "x" + (opts.count != null ? opts.count : "-");
      if (err) {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("[load] failed after " + ms + "ms:", who, msg, "opts:", JSON.stringify(opts));
        return reject(new Error(msg));
      }
      if (DEBUG) console.log("[load:res]", ms + "ms", who, body && body.list && body.list.title,
                            "items:", (body && body.items || []).length,
                            "total:", body && body.list ? body.list.count : "-");
      resolve(body);
    }));
    } catch (e) { guard.settle(() => reject(e)); }
  });
}
function getImage(image_key, opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    const t0 = Date.now();
    core.services.RoonApiImage.get_image(image_key, opts, (err, content_type, body) => {
      const ms = Date.now() - t0;
      if (err) {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("[image] failed after " + ms + "ms:", msg, "key:", image_key);
        return reject(new Error(msg));
      }
      // Only cache MISSES reach Roon (see /api/image's LRU), so this stays
      // readable even though art is the highest-volume asset.
      if (DEBUG) console.log("[image]", ms + "ms", image_key, "->",
                             content_type, (body ? body.length : 0) + "b");
      resolve({ content_type, body });
    });
  });
}

// ---------------------------------------------------------------------------
// Browse session keys — pooled, not minted per operation.
//
// Roon's browse service keeps server-side state for every multi_session_key
// for as long as the extension stays connected. The old scheme created a
// fresh random key for every single operation (including the 5-minute index
// probe — ~288/day at idle) and never told the Core about them again, so a
// long-lived Core accumulated thousands of orphaned browse sessions. Keys are
// now checked out of a small free-list and returned when the operation
// finishes: the number of sessions the Core ever holds equals the PEAK number
// of simultaneous operations (single digits), not the number of operations
// ever run. Reuse is safe because every operation begins by re-navigating its
// hierarchy (pop_all / fresh navigation), which discards any leftover state
// on that key — and item_keys are never held across operations (see
// pickRandomAlbums / loadAlbumSession).
// ---------------------------------------------------------------------------
const browseSessionFree = [];
let browseSessionSeq = 0;
function acquireBrowseSession() {
  return browseSessionFree.pop() || ("rra_s" + (++browseSessionSeq));
}
function releaseBrowseSession(key) {
  // Only withBrowseSession's finally calls this — exactly once per acquire —
  // so a key can never enter the pool twice. Keep it that way: releasing a
  // key twice would let two concurrent operations share a session and corrupt
  // each other's browse state.
  if (key) browseSessionFree.push(key);
}
// All Roon browse work runs through here. Per-operation attribution in the
// DEBUG logs comes from the [browse]/[load] lines (they print the full opts,
// including the pooled key), so the key itself doesn't need to carry it.
async function withBrowseSession(fn) {
  const sessionKey = acquireBrowseSession();
  try {
    return await fn(sessionKey);
  } finally {
    releaseBrowseSession(sessionKey);
  }
}


// ---------------------------------------------------------------------------
// Filtered album lists (genre / tag).
//
// The Browse API has no native Focus, so filtering works by navigating to a
// list that already contains only the wanted albums:
//   - genre: hierarchy "genres" → [genre] → its "Albums" child list
//   - tag:   hierarchy "browse" → Library → Tags → [tag] (→ "Albums" child
//            if the tag mixes item types)
// Roon's exact tree labels aren't formally documented, so the walkers below
// discover children by title at runtime and fail with a descriptive error
// (see /api/debug/filter to dump what a level actually contains).
// ---------------------------------------------------------------------------

// Cache of an item's OFFSET within a browse list, keyed by a navigation context
// (e.g. "genres:root", "labels:root"). item_keys themselves are session-scoped
// and MUST NOT be cached across requests (see pickRandomAlbums), but an item's
// POSITION in its alphabetically-stable list is reusable until the library
// changes. This is what makes a genre/label/tag play fast: instead of paging
// 100-at-a-time through up to thousands of entries to find the filter by title
// (30-200 sequential Roon round-trips for a label), we load directly at the
// cached offset in ONE round-trip and VERIFY the title. A stale entry (the item
// moved after a library edit) can therefore only cost a slower miss + fallback
// scan, never yield the wrong item. Cleared whenever the album index rebuilds.
const browseOffsetCache = new Map();   // context -> Map(lowerTitle -> offset)
function browseOffsetCtx(context) {
  let m = browseOffsetCache.get(context);
  if (!m) { m = new Map(); browseOffsetCache.set(context, m); }
  return m;
}
function clearBrowseOffsetCache() { browseOffsetCache.clear(); }

// Page through the current list level of `hierarchy` looking for an item
// whose title matches (case-insensitive). Returns the item or null. When a
// `context` is given, an offset cache short-circuits the scan (see above).
async function findItemByTitle(sessionKey, hierarchy, title, maxScan, context) {
  const want = String(title).trim().toLowerCase();
  const limit = maxScan || 3000;
  const page = 100;
  const cache = context ? browseOffsetCtx(context) : null;
  // Fast path: jump straight to the remembered position and confirm the title.
  if (cache && cache.has(want)) {
    const off = cache.get(want);
    try {
      const r = await load({ hierarchy, offset: off, count: 1, multi_session_key: sessionKey });
      const it = (r.items || [])[0];
      if (it && (it.title || "").trim().toLowerCase() === want) return it;
    } catch (e) { /* offset out of range / load blip — fall back to the scan */ }
    cache.delete(want);   // the item moved — drop the stale hint and rescan
  }
  for (let off = 0; off < limit; off += page) {
    const r = await load({ hierarchy, offset: off, count: page, multi_session_key: sessionKey });
    const items = r.items || [];
    for (let i = 0; i < items.length; i++) {
      const t = (items[i].title || "").trim().toLowerCase();
      if (cache && t) cache.set(t, off + i);   // remember every position we pass
      if (t === want) return items[i];
    }
    const total = r.list && r.list.count ? r.list.count : 0;
    if (off + page >= total || items.length === 0) break;
  }
  return null;
}

// Load every item at the current level (small lists: genres, tags, children).
async function loadLevel(sessionKey, hierarchy, max) {
  const out = [];
  const page = 100;
  const limit = max || 2000;
  let total = 0;
  for (let off = 0; off < limit; off += page) {
    const r = await load({ hierarchy, offset: off, count: page, multi_session_key: sessionKey });
    total = r.list && r.list.count ? r.list.count : 0;
    out.push(...(r.items || []));
    if (off + page >= total || (r.items || []).length === 0) break;
  }
  return { items: out, total };
}

// Locate the "Labels" node in the browse tree. Roon doesn't formally document
// where labels live, so discover at runtime: try Library → Labels first, then
// the browse root. Throws descriptively if no such list exists (see
// /api/debug/labels to dump what the tree actually contains).
async function findLabelsNode(sessionKey) {
  const hierarchy = "browse";
  await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
  const lib = await findItemByTitle(sessionKey, hierarchy, "Library", 50);
  if (lib) {
    await browse({ hierarchy, item_key: lib.item_key, multi_session_key: sessionKey });
    const node = await findItemByTitle(sessionKey, hierarchy, "Labels", 200);
    if (node) return node;
  }
  // Fall back to a top-level "Labels" entry.
  await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
  const atRoot = await findItemByTitle(sessionKey, hierarchy, "Labels", 200);
  if (atRoot) return atRoot;
  throw new Error('Couldn\'t find a "Labels" list in the Roon browse tree');
}

// Navigate the session to the level that lists albums for the given filter.
// filter: null | { type: "genre"|"tag"|"label", value: "<title>" }
// Returns { hierarchy, total } with the session positioned on the album list.
async function navigateToAlbumList(sessionKey, filter) {
  if (!filter) {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
    return { hierarchy: "albums", total: (head.list && head.list.count) || 0 };
  }

  if (filter.type === "genre") {
    const hierarchy = "genres";
    await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
    // Optional parent: drill into the parent genre first, then find the
    // sub-genre by title inside it (e.g. Pop/Rock → Heavy Metal).
    if (filter.parent) {
      const parent = await findItemByTitle(sessionKey, hierarchy, filter.parent, 3000, "genres:root");
      if (!parent) throw new Error(`Parent genre "${filter.parent}" not found`);
      await browse({ hierarchy, item_key: parent.item_key, multi_session_key: sessionKey });
    }
    // Top-level genres share the "genres:root" list; a sub-genre lives in its
    // parent's child list, so its offset cache is namespaced by that parent.
    const genreCtx = filter.parent ? "genres:parent:" + normalize(filter.parent) : "genres:root";
    const genre = await findItemByTitle(sessionKey, hierarchy, filter.value, 3000, genreCtx);
    if (!genre) throw new Error(`Genre "${filter.value}" not found`);
    await browse({ hierarchy, item_key: genre.item_key, multi_session_key: sessionKey });
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (!albumsChild) {
      throw new Error(`Couldn't find an "Albums" list inside genre "${filter.value}". ` +
        `Level contains: ` + lvl.items.map(i => i.title).slice(0, 12).join(", "));
    }
    const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
    let total = (into.list && into.list.count) || 0;
    if (!total) {
      const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
      total = (head.list && head.list.count) || 0;
    }
    return { hierarchy, total };
  }

  if (filter.type === "tag") {
    const hierarchy = "browse";
    await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
    const lib = await findItemByTitle(sessionKey, hierarchy, "Library", 50);
    if (!lib) throw new Error('Couldn\'t find "Library" in the browse tree');
    await browse({ hierarchy, item_key: lib.item_key, multi_session_key: sessionKey });
    const tagsNode = await findItemByTitle(sessionKey, hierarchy, "Tags", 100);
    if (!tagsNode) throw new Error('Couldn\'t find "Tags" under Library');
    await browse({ hierarchy, item_key: tagsNode.item_key, multi_session_key: sessionKey });
    const tag = await findItemByTitle(sessionKey, hierarchy, filter.value, 3000, "tags:root");
    if (!tag) throw new Error(`Tag "${filter.value}" not found`);
    const intoTag = await browse({ hierarchy, item_key: tag.item_key, multi_session_key: sessionKey });
    // Mixed-content tags expose an "Albums" child; album-only tags list albums
    // directly at this level.
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (albumsChild) {
      const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
      let total = (into.list && into.list.count) || 0;
      if (!total) {
        const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
        total = (head.list && head.list.count) || 0;
      }
      return { hierarchy, total };
    }
    // Flat tag: we've already consumed the level via loadLevel; the session is
    // still positioned on it, and load() by offset re-reads it fine.
    const total = lvl.total || (intoTag.list && intoTag.list.count) || lvl.items.length;
    return { hierarchy, total };
  }

  if (filter.type === "label") {
    const hierarchy = "browse";
    const labelsNode = await findLabelsNode(sessionKey);
    await browse({ hierarchy, item_key: labelsNode.item_key, multi_session_key: sessionKey });
    const label = await findItemByTitle(sessionKey, hierarchy, filter.value, 20000, "labels:root");
    if (!label) throw new Error(`Label "${filter.value}" not found`);
    const intoLabel = await browse({ hierarchy, item_key: label.item_key, multi_session_key: sessionKey });
    // A label may list its albums directly, or nest them under an "Albums"
    // child when it mixes item types.
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (albumsChild) {
      const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
      let total = (into.list && into.list.count) || 0;
      if (!total) {
        const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
        total = (head.list && head.list.count) || 0;
      }
      return { hierarchy, total };
    }
    const total = lvl.total || (intoLabel.list && intoLabel.list.count) || lvl.items.length;
    return { hierarchy, total };
  }

  throw new Error("Unknown filter type: " + filter.type);
}

// ---------------------------------------------------------------------------
// Pick N random albums.  Each session is dedicated to one operation so
// item_keys never leak across requests — instead we always re-resolve from
// the album offset, which is stable as long as the library isn't changing.
// Optionally constrained to a genre or tag (see navigateToAlbumList).
// ---------------------------------------------------------------------------
async function pickRandomAlbums(count, filter) {
  // Decade filter has no Roon list to navigate — pick from the in-memory album
  // index filtered by the release year collected during scanning. Each record's
  // `offset` is its full-library position (resolved on open via filter=null).
  if (filter && filter.type === "decade") {
    const decade = parseInt(filter.value, 10); // "1990s" → 1990
    if (!Number.isFinite(decade)) return { albums: [], total: 0 };
    const matches = [];
    for (const al of albumIndex.albums) {
      // albumYearOf, not a fourth hand-written copy of the key expression —
      // these must agree with the Decade counts and the Library focus filter,
      // and a future change to nTitle/nArtist would desynchronise a copy
      // silently (the counts would say one thing, the results another).
      const y = albumYearOf(al);
      if (y !== null && y >= decade && y < decade + 10) matches.push(al);
    }
    if (!matches.length) return { albums: [], total: 0 };
    const want = Math.min(count, matches.length);
    const picked = new Set();
    while (picked.size < want) picked.add(Math.floor(Math.random() * matches.length));
    const albums = [...picked].map(i => {
      const al = matches[i];
      return withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }, al);
    });
    return { albums, total: matches.length };
  }

  // Unfiltered requests are served straight from the in-memory album index —
  // the same {offset,title,subtitle,image_key} shape the browse path returns,
  // with full-library offsets so open/play work unchanged (the Home unplayed
  // row already serves from the index this way). This removes ~6 Roon browse
  // round-trips + 30 single-item loads from every Home visit / wall refresh.
  // Falls through to live browse only while the index is still empty (the
  // first moments after pairing).
  if (!filter && albumIndex.albums.length > 0) {
    const pool = albumIndex.albums;
    const want = Math.min(count, pool.length);
    const picked = new Set();
    while (picked.size < want) picked.add(Math.floor(Math.random() * pool.length));
    const albums = [...picked].map(i => {
      const al = pool[i];
      return withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }, al);
    });
    return { albums, total: pool.length };
  }

  // Live browse path (filtered, or index still empty) — needs a Roon session.
  return withBrowseSession(async (sessionKey) => {
    const nav = await navigateToAlbumList(sessionKey, filter || null);
    const total = nav.total;
    if (total === 0) return { albums: [], total: 0 };

    const want = Math.min(count, total);
    const picked = new Set();
    while (picked.size < want) picked.add(Math.floor(Math.random() * total));
    const offsets = [...picked];

    // Loaded in small concurrent batches (not fully sequential, not unbounded) —
    // this endpoint is re-fetched on every Home visit, so a fully sequential loop
    // here meant ~30 serialized Roon round-trips on every single visit.
    const RANDOM_LOAD_BATCH = 8;
    const albums = [];
    for (let i = 0; i < offsets.length; i += RANDOM_LOAD_BATCH) {
      const batch = offsets.slice(i, i + RANDOM_LOAD_BATCH);
      const results = await Promise.allSettled(batch.map(off => load({
        hierarchy: nav.hierarchy, offset: off, count: 1, multi_session_key: sessionKey
      })));
      results.forEach((res, idx) => {
        const off = batch[idx];
        if (res.status !== "fulfilled") {
          if (DEBUG) console.error("load offset", off, "failed:", res.reason && res.reason.message);
          return;
        }
        const item = res.value.items && res.value.items[0];
        if (item && item.hint !== "header") {
          albums.push(withSource({
            offset:    off,
            title:     item.title || "",
            subtitle:  item.subtitle || "",
            image_key: item.image_key || null
          }));
        }
      });
    }
    return { albums, total };
  });
}

// ---------------------------------------------------------------------------
// Set of album titles (lowercased, trimmed) played since cutoffMs. Empty Set
// if the plays DB is unavailable or the query fails — callers degrade to
// treating everything as unplayed / picking pure-random.
function getPlayedTitlesSince(cutoffMs) {
  if (!labelsDb) return new Set();
  try {
    return new Set(
      labelsDb.prepare("SELECT DISTINCT lower(trim(album)) as a FROM plays WHERE ts > ? AND album != ''")
              .all(cutoffMs).map(r => r.a)
    );
  } catch (e) {
    return new Set(); // DB unavailable — degrade gracefully
  }
}

// Smart-radio pick: prefer albums not played in the last 30 days.
// Falls back to pure random if the plays table is empty or unavailable.
// ---------------------------------------------------------------------------
async function pickSmartAlbum() {
  if (!labelsDb) return (await pickRandomAlbums(1)).albums[0] || null;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = getPlayedTitlesSince(cutoff);
  if (recent.size === 0) return (await pickRandomAlbums(1)).albums[0] || null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidates = (await pickRandomAlbums(5)).albums;
    const fresh = candidates.filter(a => !recent.has((a.title || "").toLowerCase().trim()));
    if (fresh.length) return fresh[0];
  }
  return (await pickRandomAlbums(1)).albums[0] || null;
}

// ---------------------------------------------------------------------------
// Resolve an album by offset, drill in, and return action menu + tracks.
// Optionally invokes one of the actions (kind) against a zone.
// ---------------------------------------------------------------------------
// Shared drill-in for album-level AND per-track actions: navigate to the
// album list this offset belongs to, re-resolve the album's session item_key,
// open it, and load its contents. item_keys are session-scoped, so every
// request must rebuild this state from scratch. The caller owns the pooled
// sessionKey (acquired via withBrowseSession) and releases it when done.
// Resolve an album LIVE by name via Roon's own browse "search" hierarchy —
// offset-free and always current. Used as the fallback when a tile's stored
// offset is stale (the snapshot hasn't caught up to a Roon library change), so
// playback never fails just because the index is old. Returns { item, hierarchy }
// — the matching album item plus the hierarchy it was found in ("search" or
// "browse"; drill item_key there for tracks + the Play action) — or null when
// the album genuinely isn't in the library.
async function findAlbumViaSearch(sessionKey, title, artist, zoneId) {
  const t = (title || "").trim();
  if (!t) return null;
  // Roon's search is ZONE-scoped and the zone is required for the later play
  // action — use the play zone, or any live zone as context when opening
  // detail without one.
  const zone  = zoneId || Object.keys(zones)[0] || undefined;
  const query = (t + " " + (artist || "")).trim();
  const tN = normalize(t);

  // This resolves which album to PLAY, so a loose match starts the wrong music.
  // The artist (when we know one) must be a credited artist by whole-name
  // equality — a substring test would happily pick Bonnie "Prince" Billy's
  // "1999" for Prince's. With no artist to check against we never guess from
  // an arbitrary result: the caller's stale-offset error is far better than
  // playing an unrelated album.
  const artistOk = (i) => !artist || creditHasArtist(i.subtitle, artist);
  // Exact title always outranks a loose one — otherwise "Live" could beat an
  // exact "Live at Leeds" just because the loose row's credit matched first.
  const pickFrom = (list) =>
       list.find(i => normalize(i.title) === tN && artistOk(i))
    || (!artist ? list.find(i => normalize(i.title) === tN) : null)
    || list.find(i => { const n = normalize(i.title); return (n.includes(tN) || tN.includes(n)) && artistOk(i); })
    || null;

  // Load the current search-result level, drill its Albums section, match by
  // name. Shared by both lookup paths; every stage logs unconditionally so a
  // miss pinpoints the failing step in the log.
  const albumFromResults = async (hier) => {
    const results = await load({ hierarchy: hier, offset: 0, count: 100, multi_session_key: sessionKey });
    const sections = results.items || [];
    const albumsSection = sections.find(sec => /album/i.test(sec.title || "") && sec.item_key);
    if (!albumsSection) {
      console.log("[album:search] no Albums section in " + hier + " results for " + JSON.stringify(query) +
                  "; sections=" + JSON.stringify(sections.slice(0, 8).map(sec => sec.title)));
      return null;
    }
    await browse({ hierarchy: hier, multi_session_key: sessionKey, item_key: albumsSection.item_key });
    const albs = await load({ hierarchy: hier, offset: 0, count: 50, multi_session_key: sessionKey });
    const hit = pickFrom(albs.items || []);
    if (!hit || !hit.item_key) {
      console.log("[album:search] no album match for " + JSON.stringify(t) + " among " +
                  JSON.stringify((albs.items || []).slice(0, 6).map(i => i.title)));
      return null;
    }
    console.log("[album:search] resolved " + JSON.stringify(t) + " -> " + JSON.stringify(hit.title) +
                " / " + JSON.stringify(hit.subtitle) + " via " + hier);
    return hit;
  };

  // Primary: the dedicated "search" hierarchy — a documented top-level
  // hierarchy that takes the query as `input` directly at the root, no root
  // crawl needed. (The v1.6.48 attempt crawled the "browse" root for a Search
  // entry and missed 12/12 in production: that root exposes no Search entry
  // on this session. Kept below as the secondary path.)
  try {
    await browse({ hierarchy: "search", input: query, pop_all: true,
                   multi_session_key: sessionKey, zone_or_output_id: zone });
    const hit = await albumFromResults("search");
    if (hit) return { item: hit, hierarchy: "search" };
  } catch (e) {
    console.log("[album:search] search-hierarchy lookup failed: " + e.message);
  }

  // Secondary: general "browse" root -> Search entry (the now-playing
  // resolver's pattern).
  try {
    await browse({ hierarchy: "browse", pop_all: true, multi_session_key: sessionKey, zone_or_output_id: zone });
    const root = await load({ hierarchy: "browse", offset: 0, count: 100, multi_session_key: sessionKey });
    const items0 = root.items || [];
    const searchItem = items0.find(i => i.input_prompt) || items0.find(i => /search/i.test(i.title || ""));
    if (!searchItem) {
      console.log("[album:search] no Search entry at browse root; root items=" +
                  JSON.stringify(items0.slice(0, 8).map(i => i.title)));
      return null;
    }
    await browse({ hierarchy: "browse", multi_session_key: sessionKey,
                   item_key: searchItem.item_key, input: query, zone_or_output_id: zone });
    const hit = await albumFromResults("browse");
    if (hit) return { item: hit, hierarchy: "browse" };
  } catch (e) {
    console.log("[album:search] browse-root lookup failed: " + e.message);
  }
  return null;
}

async function loadAlbumSession(sessionKey, offset, filter, expect, zoneId) {
  // 1) Navigate to the album list this offset belongs to (full library, or a
  //    genre/tag list when a filter is active — offsets are per-list). Decade
  //    offsets are full-library positions, so resolve them against the full
  //    library (no Roon list exists for a decade).
  const navFilter = (filter && filter.type === "decade") ? null : (filter || null);
  const nav = await navigateToAlbumList(sessionKey, navFilter);
  let hierarchy = nav.hierarchy;
  // Roon's LIVE album count, already fetched by the navigation above and until
  // now thrown away. Against the snapshot's count it is proof — free, and
  // available at the exact moment a user hits a failure — that the library has
  // changed since this list was built.
  //
  // Past tense on purpose. A count mismatch shows the library CHANGED; it does
  // not show an import is running now, and this must not claim otherwise.
  // Only for full-library offsets: a genre or tag list has its own count.
  const libraryMoved = !navFilter && Number.isFinite(nav.total) &&
                       albumIndex.count > 0 &&
                       nav.total !== (albumIndex.declared || albumIndex.count);
  if (libraryMoved) scheduleLibraryRecheck("album open saw " + nav.total +
                                           " albums, snapshot has " + albumIndex.count);

  // 2) Re-resolve THIS session's item_key for the album at `offset`
  const albumLoad = await load({
    hierarchy, offset, count: 1, multi_session_key: sessionKey
  });
  let albumItem = albumLoad.items && albumLoad.items[0];
  if (!albumItem) throw new Error("Album not found at offset " + offset);

  // 2b) Verify the item at the offset is the album the caller opened (see the
  //     stale-offset defense block below). On drift, re-locate by identity in
  //     the album index and retry ONCE at the fresh offset; if that also
  //     misses (index itself mid-drift during a bulk import), fail loudly
  //     rather than silently opening/playing whatever sits there now.
  //     Relocation only applies to full-library offsets — a genre/tag/label
  //     list has its own positions the album index can't provide.
  if (!albumIdentityMatches(albumItem, expect)) {
    // The tile's stored offset no longer points at the album the user opened
    // (a library change reshuffled positions). Try the fast path first: locate
    // it by identity in the in-memory index and retry that offset.
    let relocated = null, relocatedOffset = -1;
    if (!navFilter) {
      relocatedOffset = relocateAlbumOffset(expect);
      if (relocatedOffset >= 0 && relocatedOffset !== offset) {
        const retry = await load({ hierarchy, offset: relocatedOffset, count: 1, multi_session_key: sessionKey });
        const retryItem = retry.items && retry.items[0];
        if (albumIdentityMatches(retryItem, expect)) relocated = retryItem;
      }
    }
    if (relocated) {
      if (DEBUG) console.log("[album] stale offset " + offset + " relocated to " + relocatedOffset +
                             " for " + JSON.stringify(expect.title));
      offset = relocatedOffset;
      albumItem = relocated;
    } else {
      // Index relocation failed (the snapshot itself is stale — expected when
      // it hasn't refreshed since a Roon import). Resolve the album LIVE by
      // name via Roon's own search — offset-free and always current, and a
      // single-album lookup (not a library scan), so it's safe even mid-import.
      // Only a genuinely-removed album falls through to the stale error.
      const live = (expect && expect.title)
        ? await findAlbumViaSearch(sessionKey, expect.title, expect.subtitle, zoneId)
        : null;
      if (live) {
        if (DEBUG) console.log("[album] stale offset " + offset + " resolved live via search for " +
                               JSON.stringify(expect.title));
        hierarchy = live.hierarchy;
        albumItem = live.item;
      } else {
        const err = new Error("The library just changed and this album moved — close and reopen it.");
        err.stale = true;
        throw err;
      }
    }
  }

  // 3) Drill into the album
  const drill = await browse({
    hierarchy,
    item_key:  albumItem.item_key,
    multi_session_key: sessionKey
  });
  if (drill.action !== "list") {
    throw roonBrowseError(drill, "this album");
  }

  // 4) Load contents (tracks + action_list).  Explicit count for big albums.
  const inside = await load({
    hierarchy,
    offset: 0,
    count: 500,
    multi_session_key: sessionKey
  });

  const items = inside.items || [];
  // What Roon said the level HOLDS, versus what it actually handed over. The
  // two differ while the Core is re-indexing: rows arrive as placeholders with
  // no item_key, or simply do not arrive. Free — the count is already in the
  // response — and it is the only thing that tells a three-track album apart
  // from three tracks of a twelve-track one.
  const declared = (inside.list && Number.isFinite(inside.list.count))
    ? inside.list.count : null;
  const shortRead = declared !== null && items.length < declared;
  if (shortRead) {
    console.warn("[album] short read for " + JSON.stringify(albumItem.title || "") +
                 ": Roon declared " + declared + " rows, sent " + items.length);
  }
  if (DEBUG) {
    console.log("[album items]");
    for (const it of items) {
      console.log("  - hint=" + (it.hint || "<none>") + "  title=" + JSON.stringify(it.title));
    }
  }

  // 5) Find the Play submenu.  In Roon's "albums" hierarchy, BOTH the Play
  //    Album action AND each track come back with hint "action_list" (tapping
  //    a track opens its own submenu).  We tell them apart by the subtitle:
  //    tracks have an artist/composer credit; submenu actions do not.
  const playMenu = items.find(i =>
       i.hint === "action_list" && !i.subtitle && /^play/i.test(i.title || "")
  ) || items.find(i =>
       i.hint === "action_list" && !i.subtitle
  );

  // Roon's own contents for this album, recorded under the album's identity.
  //
  // Hooked HERE rather than in the callers because all four paths that ever
  // hold a track list come through this function — the album view, per-track
  // actions, dynamic-playlist materialisation and add-albums — so the index
  // fills itself from ordinary use, at no extra Roon cost, from every one of
  // them. Nothing in this extension otherwise learns which tracks Roon puts on
  // a record, and playlist import reads it back to answer the question no name
  // comparison can.
  //
  // Deferred: this is a synchronous SQLite write, and the caller may be on its
  // way to invoking Play. A cache fill must never sit in front of the music.
  //
  // NEVER on a short read. rememberAlbumTracks replaces an album's rows
  // wholesale — deliberately, so a re-rip cannot leave phantom tracks behind —
  // which means recording three tracks of a twelve-track album while Roon is
  // re-indexing would permanently destroy the correct record and hand playlist
  // import a nine-track hole. A partial answer is not evidence about an
  // album's contents.
  if (!shortRead) setImmediate(() => {
    try {
      rememberAlbumTracks(albumItem.title || "", albumItem.subtitle || "",
        items.filter(t => isTrackItem(t, playMenu))
             .map(t => ({ title: stripTrackNumber(t.title) })));
    } catch (e) {
      // Best-effort cache fill on a detached tick — there is no caller left to
      // return an error to, and a failure costs a slower import, nothing else.
      if (DEBUG) console.warn("[tracks] deferred remember failed: " + e.message);
    }
  });

  // `offset` may have been corrected by the stale-offset relocation above —
  // callers pass it back to the client so follow-up plays use the fresh one.
  return { hierarchy, albumItem, items, playMenu, offset, libraryMoved, shortRead, declared };
}

// A track = an item that isn't the play menu, a no-subtitle submenu
// (e.g. "Add to Library"), or a section header. Shared by the detail
// listing and per-track actions so their indexes always align.
// What Roon said, when Roon said something.
//
// A browse response can come back with action "message" instead of "list",
// carrying `message` (the Core's own words) and `is_error`. Every site that
// hit this threw "Unexpected browse action: message" and DISCARDED the
// explanation — which is how a user asking "why can't I play this album?" got
// a sentence about a protocol instead of the reason. Roon telling us why is
// the best evidence available anywhere in this file, and it needed no
// inference at all.
// The "Roon will not do this" message, in one place.
//
// Four sites built their own, all with the same dangling "Available: " and an
// empty list when Roon had offered no menu at all — an internal diagnostic
// shown to a human in a toast. Two different facts deserve two sentences:
// Roon offered nothing, or Roon offered something else.
function noActionError(kind, actions, what) {
  const titles = (actions || []).map(a => a.title).filter(Boolean);
  return new Error(titles.length
    ? "Roon offers no '" + kind + "' for " + what + ". It offers: " + titles.join(", ")
    : "Roon offered no playback options for " + what + ".");
}

function roonBrowseError(body, what) {
  const said = body && typeof body.message === "string" ? body.message.trim() : "";
  const err = new Error(said
    ? "Roon says: " + said
    : "Roon returned an unexpected " + (body && body.action) + " for " + what);
  // Roon's own advisories are transient by nature (a library mid-update, a
  // service reconnecting), so they are flagged the same way a stale offset is:
  // the route answers 409 and the client can say "try again" honestly.
  if (said) err.stale = true;
  err.roonMessage = said || "";
  err.roonIsError = !!(body && body.is_error);
  return err;
}

function isTrackItem(t, playMenu) {
  if (t === playMenu)                          return false;
  if (t.hint === "action_list" && !t.subtitle) return false;
  if (t.hint === "header")                     return false;
  // No item_key means nothing can be invoked on it, so it cannot be a track —
  // rendering one produces a row that silently does nothing when tapped.
  if (!t.item_key)                             return false;
  return true;
}

// Roon prefixes track titles with "N. "; the UI renders its own counter.
function stripTrackNumber(title) {
  return (title || "").replace(/^\d+\.\s+/, "");
}

// The number stripTrackNumber throws away. Roon's browse API exposes no track
// number field of its own — this prefix is the only place it exists, so it is
// the one piece of hard identity a shared playlist can carry for free. Returns
// null when there is no prefix, which is normal (playlists renumber nothing).
function trackNumberOf(title) {
  const m = /^(\d+)\.\s+/.exec(title || "");
  if (!m) return null;
  const n = parseInt(m[1], 10);
  // A "track 0" or an absurd number means we misread a title that merely
  // begins with digits ("1999. The Party" would parse as track 1999).
  return Number.isFinite(n) && n > 0 && n <= 999 ? n : null;
}

// ---- Stale-offset defense ---------------------------------------------------
// Tiles carry an offset captured when the album index was built. A Roon
// library edit (import, rescan) shifts those positions, so the album now
// sitting at a tile's offset can be a different record entirely — and the
// album view still LOOKS right because its header renders from the cached
// tile, so "Play now" used to silently play the wrong album. The per-track
// path has verified identity since v1.6.10; these give the album-level path
// the same protection.
function albumIdentityMatches(item, expect) {
  if (!expect || !expect.title) return true;   // caller supplied no identity — legacy behavior
  if (!item) return false;
  if (normalize(item.title || "") !== normalize(expect.title)) return false;
  // Subtitle is enforced only when supplied — some callers only know the title.
  if (expect.subtitle && normalize(item.subtitle || "") !== normalize(expect.subtitle)) return false;
  return true;
}
function relocateAlbumOffset(expect) {
  const nT = normalize(expect.title || "");
  if (!nT) return -1;
  const nA = normalize(expect.subtitle || "");
  const hit = albumIndex.albums.find(a => a.nTitle === nT && (!nA || a.nArtist === nA));
  return hit ? hit.offset : -1;
}
async function openAlbumByOffset(offset, zoneOrOutputId, invokeKind, filter, expect) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, albumItem, items, playMenu, offset: effectiveOffset,
            libraryMoved, shortRead, declared } =
      await loadAlbumSession(sessionKey, offset, filter, expect, zoneOrOutputId);

    const albumInfo = {
      title:     albumItem.title || "",
      subtitle:  albumItem.subtitle || "",
      image_key: albumItem.image_key || null
    };

    const tracks = items
      .filter(t => isTrackItem(t, playMenu))
      .map(t => ({
        title:    stripTrackNumber(t.title),
        subtitle: t.subtitle || ""
      }));

    let actions = [];
    if (playMenu) {
      actions = await drillActionMenu(hierarchy, sessionKey, playMenu.item_key);
    }

    // 7) Optionally invoke one
    let invoked = null;
    if (invokeKind) {
      const action = matchAction(actions, invokeKind);
      if (!action) {
        // Two different facts, and they used to share one string — with an
        // empty "Available:" list left dangling when Roon offered no menu at
        // all. Say which it is, and say what we can prove about why.
        const err = (actions.length || !libraryMoved)
          ? noActionError(invokeKind, actions, "this album")
          // The one case where more can honestly be said: Roon offered nothing
          // AND its live album count no longer matches the snapshot, so the
          // list this offset came from is out of date. Past tense — a mismatch
          // proves the library CHANGED, not that an import is running now.
          : new Error("Roon offered no playback options for this album — your library has " +
                      "changed since this list was built, so it is being re-checked. " +
                      "Try again shortly.");
        // A library that has moved is a transient condition with a recheck
        // already scheduled, so it gets the same 409 "try again" contract a
        // stale offset does rather than a 500.
        if (libraryMoved) err.stale = true;
        throw err;
      }
      if (!zoneOrOutputId) throw new Error("zone_or_output_id required to invoke an action");
      await browse({
        hierarchy,
        item_key:  action.item_key,
        zone_or_output_id: zoneOrOutputId,
        multi_session_key: sessionKey
      });
      invoked = action.title;
    }

    return { album: albumInfo, tracks, actions, invoked, offset: effectiveOffset,
             // Told to the client so the album view can explain a thin answer
             // instead of silently hiding the track list.
             library_moved: !!libraryMoved,
             partial: !!shortRead,
             declared_tracks: Number.isFinite(declared) ? declared : null };
  });
}

function classifyAction(title) {
  const t = (title || "").toLowerCase();
  if (/play\s*now/.test(t))            return "play_now";
  if (/add\s*next|play\s*next/.test(t))return "play_next";
  if (/queue/.test(t))                 return "queue";
  if (/shuffle/.test(t))               return "shuffle";
  if (/radio/.test(t))                 return "radio";
  return "other";
}
function matchAction(actions, kind) {
  return actions.find(a => a.kind === kind)
      || (kind === "play_now" ? actions.find(a => /^play/i.test(a.title)) : null);
}

// Drill into an action_list item (the album's Play menu, or a single track)
// and return its classified actions. The action check guards against a
// non-list response — without it, the follow-up load would re-read the
// CURRENT level and the caller could "invoke" a misclassified item and
// report false success.
async function drillActionMenu(hierarchy, sessionKey, itemKey) {
  const d = await browse({ hierarchy, item_key: itemKey, multi_session_key: sessionKey });
  if (d.action !== "list") {
    throw roonBrowseError(d, "this menu");
  }
  const acts = await load({ hierarchy, multi_session_key: sessionKey });
  return (acts.items || []).map(a => ({
    item_key: a.item_key,
    title:    a.title || "",
    hint:     a.hint  || "",
    kind:     classifyAction(a.title)
  }));
}

// Play or queue ONE track of an album. `trackIndex` is a position in the
// same filtered track list /api/album returns (isTrackItem keeps the two
// aligned), and the tap's title is verified against the re-resolved list —
// if the library changed since the modal opened, the track is re-matched by
// title rather than firing whatever now sits at that index; if the title is
// gone entirely the caller gets a stale error (route maps it to 409).
// `expect` is the ALBUM's identity ({title, subtitle}). It used to be omitted,
// which meant albumIdentityMatches() short-circuited to true and the entire
// stale-offset ladder below loadAlbumSession — relocate in-memory, then live
// search — was unreachable for a per-track play. That was survivable while the
// only caller was an album modal opened seconds earlier; it stops being
// survivable the moment a track reference is stored and replayed later.
async function invokeTrackAction(offset, trackIndex, trackTitle, zoneOrOutputId, kind, filter, expect) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, items, playMenu } =
      await loadAlbumSession(sessionKey, offset, filter, expect, zoneOrOutputId);
    const trackItems = items.filter(t => isTrackItem(t, playMenu));

    const wanted = normalize(trackTitle || "");
    let item = trackItems[trackIndex];
    if (!item || (wanted && normalize(stripTrackNumber(item.title)) !== wanted)) {
      item = wanted
        ? trackItems.find(t => normalize(stripTrackNumber(t.title)) === wanted)
        : null;
    }
    if (!item) {
      const err = new Error("Track list changed — close and reopen the album");
      err.stale = true;
      throw err;
    }

    // Tapping a track opens its own action submenu (Play Now / Add Next /
    // Queue / Start Radio…) — same drill as the album's Play menu.
    const actions = await drillActionMenu(hierarchy, sessionKey, item.item_key);

    const action = matchAction(actions, kind);
    if (!action) {
      throw noActionError(kind, actions, "this track");
    }
    await browse({
      hierarchy,
      item_key:  action.item_key,
      zone_or_output_id: zoneOrOutputId,
      multi_session_key: sessionKey
    });
    return { invoked: action.title, track: stripTrackNumber(item.title) };
  });
}

// ---------------------------------------------------------------------------
// Roon playlists — official API, read and play only.
//
// "playlists" is a first-class browse hierarchy, the same shape as "albums", so
// every helper above works unchanged: the pooled sessions, the offset cache, the
// action-menu drill. There is NO playlist write anywhere in the extension API —
// no create, add, remove or reorder — so this is read-only by necessity, not
// by choice.
//
// A playlist's cross-request identity is (offset, title), NEVER item_key.
// item_keys are session-scoped and must not outlive the operation that read
// them (see the browse session pool). The offset is a hint and the title is the
// check, so a stale offset costs a re-scan and never opens the wrong playlist —
// the same defense the album path grew over v1.6.38–.49.
// ---------------------------------------------------------------------------
const PLAYLIST_CTX  = "playlists:root";
const PLAYLIST_MAX  = 5000;   // how far we'll scan for a playlist by title
const PLAYLIST_ITEMS = 1000;  // tracks read per playlist (see /api/playlist)

function playlistKeyOf(title) {
  return String(title || "").trim().toLowerCase();
}

// Every playlist, with the offset each one sits at. Also refreshes the offset
// cache so a later open can jump straight to its position.
async function listPlaylists() {
  return withBrowseSession(async (sessionKey) => {
    await browse({ hierarchy: "playlists", pop_all: true, multi_session_key: sessionKey });
    const { items, total } = await loadLevel(sessionKey, "playlists", PLAYLIST_MAX);
    const ctx = browseOffsetCtx(PLAYLIST_CTX);
    ctx.clear();
    const out = [];
    // The raw index IS the offset (loadLevel pages from 0), so headers are
    // skipped for display without shifting anyone else's position.
    items.forEach((it, i) => {
      if (it.hint === "header") return;
      const key = playlistKeyOf(it.title);
      if (key) ctx.set(key, i);
      out.push({
        offset:    i,
        title:     it.title || "",
        subtitle:  it.subtitle || "",
        image_key: it.image_key || null
      });
    });
    console.log(`[playlists] listed ${out.length} playlist(s)`);
    return { playlists: out, total };
  });
}

// Navigate a session into one playlist and return its contents. `expectTitle`
// is verified against the item actually found at `offset`; on drift we re-locate
// by title rather than opening whatever moved into that slot.
// `zoneId` is passed on every browse in this walk: the Browse API documents it
// as required for playback-related functionality, and it costs nothing to carry.
async function loadPlaylistSession(sessionKey, offset, expectTitle, zoneId) {
  const hierarchy = "playlists";
  const zone = zoneId || undefined;
  await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey,
                 zone_or_output_id: zone });

  let item = null;
  if (Number.isFinite(offset) && offset >= 0) {
    const at = await load({ hierarchy, offset, count: 1, multi_session_key: sessionKey });
    item = (at.items && at.items[0]) || null;
  }
  const want = playlistKeyOf(expectTitle);
  if (want && (!item || playlistKeyOf(item.title) !== want)) {
    // The offset drifted (a playlist was added/renamed/removed above it).
    console.log(`[playlists] offset ${offset} drifted, re-locating "${expectTitle}"`);
    await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey,
                   zone_or_output_id: zone });
    item = await findItemByTitle(sessionKey, hierarchy, expectTitle, PLAYLIST_MAX, PLAYLIST_CTX);
  }
  if (!item) {
    const err = new Error("Playlist not found — reopen the playlist list");
    err.stale = true;
    throw err;
  }

  const d = await browse({ hierarchy, item_key: item.item_key, multi_session_key: sessionKey,
                           zone_or_output_id: zone });
  // Same guard as drillActionMenu: without it a non-list response would leave
  // the follow-up load reading the CURRENT level, and we'd report the playlist
  // list itself as the playlist's tracks.
  if (d.action !== "list") throw roonBrowseError(d, "this playlist");

  const inside = await load({
    hierarchy, offset: 0, count: PLAYLIST_ITEMS, multi_session_key: sessionKey
  });
  const items = inside.items || [];
  // Identical shape to an album's contents: the playlist's own Play menu comes
  // back as a subtitle-less action_list alongside the tracks.
  const playMenu = items.find(i =>
       i.hint === "action_list" && !i.subtitle && /^play/i.test(i.title || "")
  ) || items.find(i =>
       i.hint === "action_list" && !i.subtitle
  );
  const total = (inside.list && inside.list.count) || items.length;

  const realTracks = items.filter(t => isTrackItem(t, playMenu));
  if (!realTracks.length) {
    console.warn(`[playlist] "${item.title || ""}" resolved ${realTracks.length} track(s)` +
                 ` (zone=${zone || "none"}, raw items=${items.length}, list count=${total})`);
    for (const it of items.slice(0, 10)) {
      console.warn(`  - hint=${it.hint || "<none>"} title=${JSON.stringify(it.title)}` +
                   ` subtitle=${JSON.stringify(it.subtitle || "")}` +
                   ` item_key=${it.item_key ? "yes" : "no"}`);
    }
  }
  return { hierarchy, item, items, playMenu, total };
}

// Play or queue a WHOLE playlist through its own Play menu.
async function invokePlaylistAction(offset, title, zoneOrOutputId, kind) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, item, playMenu } =
      await loadPlaylistSession(sessionKey, offset, title, zoneOrOutputId);
    if (!playMenu) throw new Error("This playlist offers no play action");
    const actions = await drillActionMenu(hierarchy, sessionKey, playMenu.item_key);
    const action = matchAction(actions, kind);
    if (!action) {
      throw noActionError(kind, actions, "this playlist");
    }
    await browse({
      hierarchy,
      item_key: action.item_key,
      zone_or_output_id: zoneOrOutputId,
      multi_session_key: sessionKey
    });
    return { invoked: action.title, playlist: item.title || "" };
  });
}

// Play or queue ONE track of a playlist. Mirrors invokeTrackAction: the tapped
// title is verified against the re-resolved list, so a playlist edited since the
// screen opened re-matches by title instead of firing whatever now sits at that
// index.
async function invokePlaylistTrackAction(offset, title, trackIndex, trackTitle, zoneOrOutputId, kind) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, items, playMenu } =
      await loadPlaylistSession(sessionKey, offset, title, zoneOrOutputId);
    const trackItems = items.filter(t => isTrackItem(t, playMenu));

    const wanted = normalize(trackTitle || "");
    let item = trackItems[trackIndex];
    if (!item || (wanted && normalize(stripTrackNumber(item.title)) !== wanted)) {
      item = wanted
        ? trackItems.find(t => normalize(stripTrackNumber(t.title)) === wanted)
        : null;
    }
    if (!item) {
      const err = new Error("Playlist changed — reopen it");
      err.stale = true;
      throw err;
    }

    const actions = await drillActionMenu(hierarchy, sessionKey, item.item_key);
    const action = matchAction(actions, kind);
    if (!action) {
      throw noActionError(kind, actions, "this track");
    }
    await browse({
      hierarchy,
      item_key: action.item_key,
      zone_or_output_id: zoneOrOutputId,
      multi_session_key: sessionKey
    });
    return { invoked: action.title, track: stripTrackNumber(item.title) };
  });
}

// ---------------------------------------------------------------------------
// External metadata: MusicBrainz (release year), Qobuz + Wikipedia (bios).
// Qobuz is preferred (rich editorial reviews) with Wikipedia as fallback.
// Both candidates are verified against the album+artist name before display.
// No API keys required.
// ---------------------------------------------------------------------------
const MB_USER_AGENT = process.env.MB_USER_AGENT ||
  "RoonRandomAlbums/1.1.0 (Roon extension)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const mbCache       = new Map();
const qobuzCache    = new Map();
const pitchforkCache = new Map();
const wikiCache     = new Map();
let mbLastReq    = 0;
let qobuzLastReq = 0;

// ---------------------------------------------------------------------------
// Labels database — SQLite via better-sqlite3.
// Single file: data/cache/labels.db
// Three tables: label_names, label_mbids, label_logos.
// In-memory Maps mirror the DB for O(1) lookups; every write updates both.
// ---------------------------------------------------------------------------
let Database;
try { Database = require("better-sqlite3"); } catch (e) { Database = null; }

const LABELS_DB_DIR  = path.join(__dirname, "data", "cache");
const LABELS_DB_FILE = path.join(LABELS_DB_DIR, "labels.db");
const SETTINGS_FILE  = path.join(LABELS_DB_DIR, "settings.json");
const LABELS_LOG_FILE  = path.join(__dirname, "data", "labels-scan.log");
const LAST_SCAN_FILE   = path.join(LABELS_DB_DIR, "last-labels-scan.txt");
const LABELS_LOG_MAX = 100 * 1024; // rotate at ~100KB

function appendLabelsLog(message) {
  try {
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    const line = new Date().toISOString() + " " + message + "\n";
    // Rotate if oversized
    try {
      const stat = fs.statSync(LABELS_LOG_FILE);
      if (stat.size >= LABELS_LOG_MAX) {
        fs.writeFileSync(LABELS_LOG_FILE, line);
        return;
      }
    } catch (e) { /* file doesn't exist yet */ }
    fs.appendFileSync(LABELS_LOG_FILE, line);
  } catch (e) { /* never throw from log helper */ }
}

let _settingsCache = null; // in-memory mirror — eliminates read-before-write on every save
function loadPersistedSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {};
  } catch (e) {
    _settingsCache = {};
  }
  return _settingsCache;
}
function savePersistedSettings(patch) {
  try {
    const cur = loadPersistedSettings(); // hits cache after first call — no disk read
    Object.assign(cur, patch);           // mutate in place so cache stays coherent
    fs.mkdirSync(LABELS_DB_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 2));
    return true;
  } catch (e) {
    console.error("[settings] save failed:", e.message);
    return false;
  }
}

// Load persisted API keys (set via web UI settings).
const _persisted = loadPersistedSettings();
let discogsToken = _persisted.discogsToken || "";
let fanartKey    = _persisted.fanartKey    || "";
// When > 0, the file scan takes the album's label from the folder at this depth
// under the music root instead of the per-file label tag — for libraries
// organised in label folders (e.g. /music/Jazz/Blue Note Records/Album → depth 2).
// 0 = off (use the file's label tag, the default). Immune to disc subfolders
// because it's measured from the music root, not the audio folder.
let labelFolderDepth = parseInt(_persisted.labelFolderDepth, 10) || 0;
// Wall display (/display): off by default — when off the page fetches nothing
// and the content endpoint refuses, so no discovery work happens at all.
let displayEnabled = _persisted.displayEnabled === true;
let displaySeconds = (() => {
  const s = parseInt(_persisted.displaySeconds, 10);
  return Number.isFinite(s) && s >= 5 && s <= 60 ? s : 10;
})();
// Optional YouTube Data API key — enables the display's muted video-clip
// slides. Without it, video is simply omitted from the rotation.
let youtubeKey = _persisted.youtubeKey || "";

// Short-lived cache of a streaming service's favourited album ids, shared by
// all of that service's browse routes so each page render doesn't re-fetch the
// full favourites list (429 risk). Concurrent callers on a cold cache share
// one in-flight fetch. Best-effort: on fetch failure, serves the previous ids
// if they aren't older than `staleMaxMs`, otherwise an empty Set — the list
// still renders, just without favourite marks. `fetchIds` must resolve to a
// Set of album-id strings.
function makeFavIdsCache({ name, fetchIds, cacheMs = 60 * 1000, staleMaxMs = 10 * 60 * 1000 }) {
  let ids = null;      // Set of album ids, or null when stale/never fetched
  let at = 0;          // epoch ms of last successful fetch
  let pending = null;  // in-flight fetch promise — concurrent callers share it
  return {
    async get() {
      if (ids && (Date.now() - at) < cacheMs) return ids;
      if (pending) return pending;
      pending = (async () => {
        try {
          const fresh = await fetchIds();
          ids = fresh;
          at = Date.now();
          return fresh;
        } catch (e) {
          if (DEBUG) console.error("[" + name + "] favourite-ids lookup failed:", e.message);
          if (ids && (Date.now() - at) < staleMaxMs) return ids; // stale-on-error ceiling
          return new Set();
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    add(id)    { if (ids) ids.add(String(id)); },
    remove(id) { if (ids) ids.delete(String(id)); },
    clear()    { ids = null; at = 0; }
  };
}

// TTL memo keyed by string. Featured/browse lists change slowly (~daily) but
// each tab tap would otherwise hit the rate-limit-sensitive unofficial APIs.
// Values are cached RAW; favourite flags are applied per request from the
// (fresher) fav-ids caches. Errors are not cached — a failed fetch just throws.
// FNV-1a string hash, used as a stable seed for deterministic daily/weekly
// picks (e.g. album-of-the-day, label-of-the-week). Returns an unsigned 32-bit
// int — callers do `hash % n` (via `>>> 0`) to pick an index.
function fnv1aHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Parse Roon's "N Albums" (or "N albums") subtitle count, e.g. on a genre or
// label browse item. Returns the parsed integer, or null if no count parses.
function parseAlbumCount(subtitle) {
  const m = /(\d[\d,]*)\s*albums?/i.exec(subtitle || "");
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

function makeTtlCache(ttlMs) {
  const map     = new Map(); // key → { value, at }
  const inFlight = new Map(); // key → Promise, only while a fetch is running
  return {
    async get(key, fetchFn) {
      const hit = map.get(key);
      if (hit && (Date.now() - hit.at) < ttlMs) return hit.value;
      // Two callers arriving on a cold key both used to run the fetch, because
      // the map was only written after the await. On the Home screen several
      // clients can wake at once, and each miss is a Roon walk — so the second
      // caller waits on the first instead of duplicating it.
      const running = inFlight.get(key);
      if (running) return running;
      // The PROMISE is shared, never the failure. A rejected fetch is deleted
      // here rather than stored, so a transient Core blip cannot be cached for
      // the whole TTL and turn a one-second glitch into a half-hour outage.
      const p = (async () => {
        const value = await fetchFn();
        map.set(key, { value, at: Date.now() });
        return value;
      })().finally(() => { inFlight.delete(key); });
      inFlight.set(key, p);
      return p;
    },
    clear() { map.clear(); }   // in-flight fetches finish and repopulate
  };
}

// Smart Picks scheduling. The build talks to MusicBrainz, ListenBrainz and a
// streaming service, and the albums it favourites then land in Roon's import
// queue — so it wants to run when nothing else does. Default 04:00 local.
let smartPicksHour    = Number.isFinite(_persisted.smartPicksHour)
  ? Math.min(23, Math.max(0, Math.trunc(_persisted.smartPicksHour))) : 4;
// Whether the picks are favourited automatically at build time, so Roon has
// all night to import them and they are playable by morning.
let smartPicksAutoAdd = _persisted.smartPicksAutoAdd !== false;

// ---------------------------------------------------------------------------
// Opt-in features. Both reach the network on their own schedule — Smart Picks
// queries MusicBrainz/ListenBrainz and writes streaming favourites; the label
// pipeline walks five metadata APIs and fetches logos — so neither should be
// running for somebody who has never asked for it. OFF is the default, and off
// means the timers do not start at all, not merely that the rows are hidden.
//
// Existing users are not switched off underneath themselves. An absent setting
// with evidence of use on the data volume — a label cache, or picks already
// built — reads as consent, because that state can only exist if the feature
// was running and nobody complained. A brand new install has neither and
// starts off. `featureDefaultOn` is called AFTER the database opens, so these
// are assigned rather than initialised here.
let labelsEnabled     = _persisted.labelsEnabled === true;
let smartPicksEnabled = _persisted.smartPicksEnabled === true;
const _labelsEnabledSet     = _persisted.labelsEnabled !== undefined;
const _smartPicksEnabledSet = _persisted.smartPicksEnabled !== undefined;

// Qobuz (UNOFFICIAL API — see lib/qobuz.js). Credentials/token set via Settings.
// We persist the username, the md5 of the password (for silent re-login), the
// user_auth_token, and the display name. Never the plaintext password.
const qobuz = require("./lib/qobuz");
let qobuzUsername    = _persisted.qobuzUsername    || "";
let qobuzPasswordMd5 = _persisted.qobuzPasswordMd5 || "";
let qobuzToken       = _persisted.qobuzToken       || "";
let qobuzDisplayName = _persisted.qobuzDisplayName || "";
// qobuzWithToken is a hoisted function declaration (Qobuz section below), and
// fetchIds only runs once a route calls .get() — long after startup.
const qobuzFavIds = makeFavIdsCache({
  name: "qobuz",
  fetchIds: () => qobuzWithToken(t => qobuz.getFavoriteAlbumIds(t))
});
const qobuzFeaturedCache = makeTtlCache(10 * 60 * 1000); // type → raw items[]

// Tidal (UNOFFICIAL API — see lib/tidal.js). Connected via Tidal's OAuth
// device flow in Settings; we persist the refresh token, user id, country
// code, and display name — never a password (login happens on tidal.com).
const tidal = require("./lib/tidal");
let tidalRefreshToken = _persisted.tidalRefreshToken || "";
let tidalUserId       = _persisted.tidalUserId       || "";
let tidalCountryCode  = _persisted.tidalCountryCode  || "US";
let tidalDisplayName  = _persisted.tidalDisplayName  || "";
// In-memory only: short-lived access token minted from the refresh token.
let tidalAccessToken = "";
let tidalAccessTokenExpiry = 0; // epoch ms; refresh 5 min early
// Device-flow login in progress, or null. `timer` drives the server-side poll
// loop; `error` holds the terminal failure for GET /api/settings/tidal/status.
let tidalPendingAuth = null; // { deviceCode, interval, expiresAt, netFails, timer, error }
let tidalAuthGen = 0; // /start generation counter — a newer login attempt supersedes an older one racing it
// tidalWithToken is a hoisted function declaration (Tidal section below).
const tidalFavIds = makeFavIdsCache({
  name: "tidal",
  fetchIds: () => tidalWithToken(async (t, cc, userId) => {
    const entries = await tidal.getFavoriteAlbums(t, cc, userId);
    const ids = new Set();
    for (const en of entries) {
      const item = en && en.item; // favourites come wrapped as { created, item }
      if (item && item.id != null) ids.add(String(item.id));
    }
    return ids;
  })
});
const tidalFeaturedCache = makeTtlCache(10 * 60 * 1000); // "groups" | "albums:<type>"

// In-memory Maps — primary lookup path.
const labelDiskCache = new Map();  // album key → label name
const labelMbidCache = new Map();  // group key → MusicBrainz MBID
const labelLogoCache = new Map();  // group key → logo URL | null (null = tried, not found)
const labelMerges    = new Map();  // source groupKey → { targetKey, targetDisplay, sourceDisplay }
const albumYearCache = new Map();  // album key → release year (4-digit string) — powers the Decade filter
// album key → { ts, src } — powers the "Recently added" sort. Roon's extension
// API exposes no date-added of any kind, so every value here is this
// extension's own evidence, ranked: a local file's mtime is a real date; an
// album simply appearing in a rebuild is weaker but still true.
const albumSeenCache = new Map();
let stmtInsertSeen = null;

// album key → [genre, ...] — powers the Genre focus facet.
//
// Roon's browse response carries no genre, so these are harvested by walking
// the `genres` hierarchy once per library sync (see harvestAlbumGenres). That
// walk is the one place in this file where a facet costs Roon calls, and it is
// worth it because the join back is Roon-to-Roon: both sides are Roon's OWN
// title/subtitle strings, so unlike years — which come from foreign sources and
// are stuck at partial coverage — this lands on essentially every album.
const albumGenreCache = new Map();
let stmtInsertGenres = null;
// genre name → { subtitle, image_key, total, ts } as of its last successful
// walk. Bumping GENRE_FP_VERSION makes every stored row incomparable, which
// forces one full walk and is how a change to what a fingerprint MEANS heals
// itself instead of silently comparing two different things.
const genreScanCache = new Map();
let stmtInsertGenreScan = null;
function genreFpVersion() { return 1; }
// How long a genre may go unwalked. No free fingerprint can see an equal-count
// membership swap, or an album Roon re-identified (which changes the key
// without moving any genre's count) — so the skip is bounded by time rather
// than trusted indefinitely.
function genreSweepMs() { return 7 * 24 * 60 * 60 * 1000; }
// Genre names contain commas ("Rap, Hip-Hop" is one Roon genre) and slashes
// ("Pop/Rock"), but never a newline — so that is the one separator that can
// round-trip the list without an escaping scheme.
const GENRE_SEP = String.fromCharCode(10);
// Remember what a genre looked like when we last walked it. Written per genre
// rather than in one batch at the end: the walk is wrapped in a single catch,
// so a run that dies partway must still leave the genres it finished
// fingerprinted instead of starting from nothing next time.
function setGenreScan(name, subtitle, imageKey, total) {
  if (!name) return;
  const rec = { subtitle: subtitle || "", image_key: imageKey || "",
                total: Number.isFinite(total) ? total : null, ts: Date.now() };
  genreScanCache.set(name, rec);
  if (stmtInsertGenreScan) {
    try { stmtInsertGenreScan.run(name, rec.subtitle, rec.image_key, rec.total,
                                  rec.ts, genreFpVersion()); }
    catch (e) { if (DEBUG) console.error("[genres] fingerprint write failed:", e.message); }
  }
}

// An album that is in no genre at all has no row, rather than an empty one.
// setAlbumGenres refuses an empty list (a genre-less album is the normal state
// for most of a library and storing millions of empty rows would be silly), so
// removal needs its own path — without it, an album that left its ONLY genre
// would keep that genre forever.
function deleteAlbumGenres(key) {
  if (!albumGenreCache.has(key)) return false;
  albumGenreCache.delete(key);
  if (labelsDb) {
    try { labelsDb.prepare("DELETE FROM album_genres WHERE key = ?").run(key); }
    catch (e) { if (DEBUG) console.error("[genres] delete failed:", e.message); }
  }
  return true;
}

function setAlbumGenres(key, genres) {
  if (!key || !Array.isArray(genres) || !genres.length) return false;
  const list = [...new Set(genres.filter(Boolean))].sort();
  const prev = albumGenreCache.get(key);
  if (prev && prev.length === list.length && prev.every((g, i) => g === list[i])) return false;
  albumGenreCache.set(key, list);
  if (stmtInsertGenres) {
    try { stmtInsertGenres.run(key, list.join(GENRE_SEP)); }
    catch (e) { if (DEBUG) console.error("[genres] write failed:", e.message); }
  }
  return true;
}

// album key → { container, bits, rate, chan, lossless } — powers the Format,
// Sample rate, Bit depth and Channels focus facets, and comes free: the local
// scan ALREADY calls music-metadata's parseFile for labels and years, and every
// one of these fields is on the `format` block of the object it hands back.
// Nothing extra is read from disk.
//
// Local files only, by definition — a streamed album has no file to inspect —
// which is why the sheet prints the coverage rather than implying the whole
// library was measured. It is also one SAMPLED track per directory, which is
// safe for these four (albums are ripped uniformly) in a way it would not be
// for anything per-track like rating or BPM.
const albumFileCache = new Map();
let stmtInsertFileFacts = null;
// Where a format came from, ranked. A local file is the thing that actually
// plays, so it outranks a streaming service's description of the same album —
// which may be the hi-res master when what is on disk is the CD rip.
//
// Same shape as seenSourceRank and yearSourceRank; a row written before this
// column existed reads back as 0 and any identified source beats it.
function formatSourceRank(src) {
  if (src === "file")  return 3;   // measured from the file we would actually play
  if (src === "qobuz") return 2;   // the service states an exact bit depth and rate
  if (src === "tidal") return 1;   // a quality TIER, not an exact rate
  return 0;
}
function setAlbumFileFacts(key, f, src) {
  if (!key || !f) return false;
  const prev = albumFileCache.get(key);
  // Better evidence replaces worse. A tie keeps the first writer, which matters
  // for the file walk: it recurses into disc subdirectories (MAX_DEPTH exists
  // for exactly that), so a 2-disc album is parsed twice under one key and the
  // second pass must not overwrite the first.
  if (prev && formatSourceRank(src) <= formatSourceRank(prev.src)) return false;
  const rec = Object.assign({}, f, { src: src || "" });
  albumFileCache.set(key, rec);
  if (stmtInsertFileFacts) {
    try {
      stmtInsertFileFacts.run(key, rec.container || null, rec.bits || null,
                              rec.rate || null, rec.chan || null,
                              rec.lossless ? 1 : 0, rec.src);
    } catch (e) { if (DEBUG) console.error("[format] write failed:", e.message); }
  }
  return true;
}
function seenSourceRank(src) {
  if (src === "file")       return 2;   // the file landed on disk on this date
  if (src === "first-seen") return 1;   // it appeared between two rebuilds
  return 0;
}
// Records when an album was first seen, keeping the best-ranked evidence.
// Returns true when something changed, so callers can bump the view cache.
function setAlbumSeen(key, ts, src) {
  if (!key || !Number.isFinite(ts) || ts <= 0) return false;
  const prev = albumSeenCache.get(key);
  if (prev) {
    const better = seenSourceRank(src) > seenSourceRank(prev.src);
    // Same source, earlier date wins: "first seen" means the earliest evidence,
    // not the most recent scan that happened to notice it again.
    const earlier = seenSourceRank(src) === seenSourceRank(prev.src) && ts < prev.ts;
    if (!better && !earlier) return false;
  }
  albumSeenCache.set(key, { ts, src: src || "" });
  if (stmtInsertSeen) {
    try { stmtInsertSeen.run(key, Math.round(ts), src || ""); }
    catch (e) { if (DEBUG) console.error("[seen] write failed:", e.message); }
  }
  return true;
}
// Ordered/filtered library views are memoised (see libraryView). Declared here,
// ABOVE setAlbumYear, because that function invalidates the cache and would hit
// the temporal dead zone if these lived with the rest of the view code.
let libraryMetaVersion = 0;
const libraryViewCache = new Map();      // sig -> ordered album array
const LIBRARY_VIEW_CACHE_MAX = 8;
// The two genre lists that are cached against the Core. Declared HERE, above
// bumpLibraryMeta, because that is their first use — a `const` referenced
// before its declaration is a ReferenceError, and `typeof` does not rescue it:
// unlike an undeclared name, a const in its temporal dead zone throws from
// `typeof` too. bumpLibraryMeta runs during startup, so a guard written that
// way would have crashed the extension on boot.
//
// Both had no cache path and no invalidation path respectively; see the routes.
const genreListCache   = makeTtlCache(30 * 60 * 1000);
const genreGroupsCache = makeTtlCache(30 * 60 * 1000);

function bumpLibraryMeta() {
  libraryMetaVersion++;
  libraryViewCache.clear();
  // The genre lists too. Both are TTL-cached against the Core, and neither was
  // on any invalidation path — so a genre added to the library stayed invisible
  // on Home and in the filter sheet until the clock ran out, with no way to
  // hurry it. Declared later in the file, so guarded: bumpLibraryMeta is called
  // during startup before they exist.
  genreListCache.clear();
  genreGroupsCache.clear();
}
// Coalesced bump for the label scan, which discovers years one HTTP response at
// a time. Bumping per year would clear the memoised orderings several times a
// second for the hours a first scan takes — the cache would never survive long
// enough to be used, and every Library page would re-sort the whole library.
// This caps the staleness at LIBRARY_META_BUMP_MS instead.
const LIBRARY_META_BUMP_MS = 20000;
let _metaBumpTimer = null;
function scheduleLibraryMetaBump() {
  if (_metaBumpTimer) return;
  _metaBumpTimer = setTimeout(() => { _metaBumpTimer = null; bumpLibraryMeta(); },
                              LIBRARY_META_BUMP_MS);
  // Never hold the process open for a cache invalidation.
  if (_metaBumpTimer.unref) _metaBumpTimer.unref();
}

let labelsDb = null;
let stmtInsertName, stmtInsertMbid, stmtInsertLogo, stmtInsertMerge, stmtDeleteMerge, stmtInsertYear;
let stmtInsertPlay, stmtCompletePlay;
// Smart Picks. Declared here with the rest so they exist (as undefined) before
// openLabelsDb runs — a bare assignment below a later `let` is the startup
// ReferenceError this file has been bitten by before.
let stmtInsertSmartPick = null, stmtInsertSmartSeen = null;
let stmtInsertSmartBlock = null, stmtInsertSmartCache = null;

// Non-label filter — must be defined before openLabelsDb() is called.
const NON_LABEL_RE = /\b(management|agency|agencies|booking|touring|representation|ministry|foundation|fund)\b/i;
function isLikelyNotALabel(name) {
  return !name || NON_LABEL_RE.test(name);
}

function openLabelsDb() {
  if (!Database) {
    console.warn("[labels] better-sqlite3 not available — cache in memory only (data won't persist)");
    return;
  }
  try {
    fs.mkdirSync(LABELS_DB_DIR, { recursive: true });
    labelsDb = new Database(LABELS_DB_FILE);
    labelsDb.pragma("journal_mode = WAL");
    labelsDb.exec(`
      CREATE TABLE IF NOT EXISTS label_names (
        key   TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS label_mbids (
        group_key TEXT PRIMARY KEY,
        mbid      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS label_logos (
        group_key TEXT PRIMARY KEY,
        logo_url  TEXT
      );
      CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        zone TEXT,
        track TEXT,
        artist TEXT,
        album TEXT,
        image_key TEXT,
        duration INTEGER,
        completed INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS label_merges (
        source_key     TEXT PRIMARY KEY,
        source_display TEXT NOT NULL,
        target_key     TEXT NOT NULL,
        target_display TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS album_years (
        key  TEXT PRIMARY KEY,
        year TEXT NOT NULL
      );
      -- When this extension first became aware of an album. NOT Roon's import
      -- date: Roon publishes none, so there is nothing to read. The src column
      -- ranks the evidence: a file mtime beats "it appeared in a rebuild".
      CREATE TABLE IF NOT EXISTS album_seen (
        key TEXT PRIMARY KEY,
        ts  INTEGER NOT NULL,
        src TEXT
      );
      -- Genres per album, harvested from Roon's own genres hierarchy because
      -- the browse response for an album carries none. Stored newline-joined:
      -- genre names contain commas ("Rap, Hip-Hop") but never newlines.
      CREATE TABLE IF NOT EXISTS album_genres (
        key    TEXT PRIMARY KEY,
        genres TEXT NOT NULL
      );
      -- What the local file for an album actually is. Read from tags the label
      -- scan already parses, so it costs no extra disk work; absent for every
      -- album that has no local file.
      CREATE TABLE IF NOT EXISTS album_files (
        key       TEXT PRIMARY KEY,
        container TEXT,
        bits      INTEGER,
        rate      INTEGER,
        chan      INTEGER,
        lossless  INTEGER
      );
      -- What each genre looked like the last time it was walked, so an
      -- unchanged one can be skipped. The subtitle is stored RAW ("204 Albums")
      -- rather than as a parsed integer: strictly more information for the same
      -- zero cost, and it cannot collapse two different states into null.
      -- The total column is the album count the walk itself observed, which is
      -- what catches a subtitle that does not describe the set we harvest.
      CREATE TABLE IF NOT EXISTS genre_scan (
        name      TEXT PRIMARY KEY,
        subtitle  TEXT,
        image_key TEXT,
        total     INTEGER,
        ts        INTEGER NOT NULL,
        v         INTEGER NOT NULL
      );
      -- Smart Picks: the six albums surfaced on a given day. Stored rather than
      -- recomputed so the set is stable for everyone looking at it, and so a
      -- restart does not hand somebody a different day's picks.
      CREATE TABLE IF NOT EXISTS smart_picks (
        day      TEXT NOT NULL,
        kind     TEXT NOT NULL,
        rank     INTEGER NOT NULL,
        mbid     TEXT,
        artist   TEXT NOT NULL,
        canon    TEXT NOT NULL,
        album    TEXT,
        album_id TEXT,
        service  TEXT,
        image    TEXT,
        reason   TEXT,
        genre    TEXT,
        ts       INTEGER NOT NULL,
        PRIMARY KEY (day, kind, rank)
      );
      -- Artists already shown, so the set turns over instead of repeating.
      CREATE TABLE IF NOT EXISTS smart_pick_seen (
        canon TEXT PRIMARY KEY,
        ts    INTEGER NOT NULL
      );
      -- "Not for me" — an EXPLICIT tap only, and permanent. Silence is never
      -- recorded here: the premise of the feature is albums the user would not
      -- otherwise reach for, so treating no-response as rejection would empty
      -- the pool within a week.
      CREATE TABLE IF NOT EXISTS smart_pick_blocks (
        canon TEXT PRIMARY KEY,
        name  TEXT,
        ts    INTEGER NOT NULL
      );
      -- Cached third-party reads (the sitewide hub chart, per-seed similarity,
      -- per-genre rosters). Persisted so a rebuild on an unchanged library
      -- costs no network calls at all.
      CREATE TABLE IF NOT EXISTS smart_cache (
        key  TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        ts   INTEGER NOT NULL
      );
      -- Which tracks sit on which album, in ROON's grouping.
      --
      -- Nothing else in this extension knows this. The snapshot is album-level,
      -- the /music scan samples one file per directory and never reads a track
      -- title, and no service client makes a track-level call. So when a shared
      -- playlist names a record this library files under a different name, the
      -- question "which album holds this track, then?" had no answer at all.
      --
      -- Keyed by album IDENTITY, never by offset: offsets are positions in a
      -- list that reshuffles on every library change, and this table outlives
      -- many of those. The tkey column is the canonical track title, so a
      -- remaster suffix on one side does not hide a match.
      CREATE TABLE IF NOT EXISTS album_tracks (
        akey  TEXT NOT NULL,
        tkey  TEXT NOT NULL,
        title TEXT NOT NULL,
        n     INTEGER NOT NULL,
        ts    INTEGER NOT NULL,
        PRIMARY KEY (akey, tkey)
      );
      -- The reverse lookup is the whole point of the table, and it is the one
      -- query here that would otherwise scan. (These are the first indexes in
      -- this database — every other table is read by primary key.)
      CREATE INDEX IF NOT EXISTS album_tracks_tkey ON album_tracks(tkey);
      -- The plays table is read by track title on the import path, and it is
      -- the only table here that grows without bound. Expression index because
      -- the query compares lower(trim(track)) — an index on the bare column
      -- cannot serve it.
      CREATE INDEX IF NOT EXISTS plays_track ON plays(lower(trim(track)));
      -- The History row reads a 30-day window out of the one table here that
      -- grows without bound, on every Home visit, on the synchronous SQLite
      -- driver. Without this it is a full scan in front of the screen.
      CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
    `);
    // `src` records WHERE a year came from, so a better source can correct a
    // worse one (see yearSourceRank). Added after the table shipped without
    // it, so it goes on as a migration; existing rows read back as rank 0 and
    // any identified source outranks them.
    try { labelsDb.exec("ALTER TABLE album_years ADD COLUMN src TEXT"); }
    catch (e) { /* already present — SQLite has no ADD COLUMN IF NOT EXISTS */ }
    // v1.7.37: formats can now come from a streaming service as well as from a
    // local file, and a local file must win. Rows written by v1.7.35-36 have no
    // src and read back as rank 0, so the first identified source corrects them.
    try { labelsDb.exec("ALTER TABLE album_files ADD COLUMN src TEXT"); }
    catch (e) { /* already present — SQLite has no ADD COLUMN IF NOT EXISTS */ }
    stmtInsertName  = labelsDb.prepare("INSERT OR REPLACE INTO label_names (key, label) VALUES (?, ?)");
    stmtInsertMbid  = labelsDb.prepare("INSERT OR REPLACE INTO label_mbids (group_key, mbid) VALUES (?, ?)");
    stmtInsertLogo  = labelsDb.prepare("INSERT OR REPLACE INTO label_logos (group_key, logo_url) VALUES (?, ?)");
    stmtInsertMerge = labelsDb.prepare("INSERT OR REPLACE INTO label_merges (source_key, source_display, target_key, target_display) VALUES (?, ?, ?, ?)");
    stmtDeleteMerge = labelsDb.prepare("DELETE FROM label_merges WHERE source_key = ?");
    stmtInsertPlay  = labelsDb.prepare("INSERT INTO plays (ts, zone, track, artist, album, image_key, duration) VALUES (?,?,?,?,?,?,?)");
    stmtCompletePlay = labelsDb.prepare("UPDATE plays SET completed=1 WHERE id=?");
    stmtInsertYear  = labelsDb.prepare("INSERT OR REPLACE INTO album_years (key, year, src) VALUES (?, ?, ?)");
    stmtInsertSeen  = labelsDb.prepare("INSERT OR REPLACE INTO album_seen (key, ts, src) VALUES (?, ?, ?)");
    stmtInsertGenres = labelsDb.prepare("INSERT OR REPLACE INTO album_genres (key, genres) VALUES (?, ?)");
    stmtInsertGenreScan = labelsDb.prepare(
      "INSERT OR REPLACE INTO genre_scan (name, subtitle, image_key, total, ts, v) VALUES (?,?,?,?,?,?)");
    stmtInsertFileFacts = labelsDb.prepare(
      "INSERT OR REPLACE INTO album_files (key, container, bits, rate, chan, lossless, src) VALUES (?,?,?,?,?,?,?)");
    stmtInsertSmartPick = labelsDb.prepare(
      "INSERT OR REPLACE INTO smart_picks " +
      "(day, kind, rank, mbid, artist, canon, album, album_id, service, image, reason, genre, ts) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    stmtInsertSmartSeen  = labelsDb.prepare(
      "INSERT OR REPLACE INTO smart_pick_seen (canon, ts) VALUES (?, ?)");
    stmtInsertSmartBlock = labelsDb.prepare(
      "INSERT OR REPLACE INTO smart_pick_blocks (canon, name, ts) VALUES (?, ?, ?)");
    stmtInsertSmartCache = labelsDb.prepare(
      "INSERT OR REPLACE INTO smart_cache (key, body, ts) VALUES (?, ?, ?)");
    const stmtDeleteName = labelsDb.prepare("DELETE FROM label_names WHERE key = ?");
    for (const r of labelsDb.prepare("SELECT key, label FROM label_names").all()) {
      if (!r.label) continue;
      if (isLikelyNotALabel(r.label)) {
        stmtDeleteName.run(r.key);
        if (DEBUG) console.log("[labels] evicted bad cache entry:", r.label);
        continue;
      }
      labelDiskCache.set(r.key, r.label);
    }
    for (const r of labelsDb.prepare("SELECT group_key, mbid FROM label_mbids").all()) {
      labelMbidCache.set(r.group_key, r.mbid);
    }
    for (const r of labelsDb.prepare("SELECT group_key, logo_url FROM label_logos").all()) {
      labelLogoCache.set(r.group_key, r.logo_url);
    }
    for (const r of labelsDb.prepare("SELECT source_key, source_display, target_key, target_display FROM label_merges").all()) {
      labelMerges.set(r.source_key, { targetKey: r.target_key, targetDisplay: r.target_display, sourceDisplay: r.source_display });
    }
    for (const r of labelsDb.prepare("SELECT key, year, src FROM album_years").all()) {
      if (r.year) {
        albumYearCache.set(r.key, r.year);
        if (r.src) albumYearSource.set(r.key, r.src);
      }
    }
    for (const r of labelsDb.prepare("SELECT key, ts, src FROM album_seen").all()) {
      if (r.ts) albumSeenCache.set(r.key, { ts: r.ts, src: r.src || "" });
    }
    for (const r of labelsDb.prepare(
        "SELECT name, subtitle, image_key, total, ts, v FROM genre_scan").all()) {
      // A row at another fingerprint version is not comparable — drop it and
      // the genre gets a full walk.
      if (r.v !== genreFpVersion()) continue;
      genreScanCache.set(r.name, {
        subtitle: r.subtitle || "", image_key: r.image_key || "",
        total: r.total, ts: r.ts
      });
    }
    for (const r of labelsDb.prepare("SELECT key, genres FROM album_genres").all()) {
      const list = String(r.genres || "").split(GENRE_SEP).filter(Boolean);
      if (list.length) albumGenreCache.set(r.key, list);
    }
    for (const r of labelsDb.prepare(
        "SELECT key, container, bits, rate, chan, lossless, src FROM album_files").all()) {
      albumFileCache.set(r.key, {
        container: r.container || null, bits: r.bits || null,
        rate: r.rate || null, chan: r.chan || null, lossless: !!r.lossless,
        src: r.src || ""
      });
    }
    migrateOldJsonCaches();
    if (DEBUG) console.log(
      "[labels] db ready:", labelDiskCache.size, "names,",
      labelMbidCache.size, "mbids,", labelLogoCache.size, "logos,", labelMerges.size, "merges"
    );
  } catch (e) {
    console.error("[labels] db open failed:", e.message, "— in-memory only");
    labelsDb = null;
  }
}

function migrateOldJsonCaches() {
  const files = [
    { file: path.join(LABELS_DB_DIR, "labels-cache.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (e.key && e.label && !labelDiskCache.has(e.key)) {
              stmtInsertName.run(e.key, e.label);
              labelDiskCache.set(e.key, e.label);
            }
          }
        });
        ins();
      }
    },
    { file: path.join(LABELS_DB_DIR, "labels-mbid.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (e.groupKey && e.mbid && !labelMbidCache.has(e.groupKey)) {
              stmtInsertMbid.run(e.groupKey, e.mbid);
              labelMbidCache.set(e.groupKey, e.mbid);
            }
          }
        });
        ins();
      }
    },
    { file: path.join(LABELS_DB_DIR, "labels-logo.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (typeof e.groupKey === "string" && !labelLogoCache.has(e.groupKey)) {
              stmtInsertLogo.run(e.groupKey, e.logoUrl || null);
              labelLogoCache.set(e.groupKey, e.logoUrl || null);
            }
          }
        });
        ins();
      }
    }
  ];
  for (const { file, load } of files) {
    try {
      if (!fs.existsSync(file)) continue;
      load(JSON.parse(fs.readFileSync(file, "utf8")));
      fs.unlinkSync(file);
      if (DEBUG) console.log("[labels] migrated", path.basename(file), "→ labels.db");
    } catch (e) { /* ignore corrupt old files */ }
  }
}

// Write helpers — update Map and DB together.
function setLabelName(key, label) {
  labelDiskCache.set(key, label);
  if (labelsDb) stmtInsertName.run(key, label);
}
function setLabelMbid(groupKey, mbid) {
  labelMbidCache.set(groupKey, mbid);
  if (labelsDb) stmtInsertMbid.run(groupKey, mbid);
}
function setLabelLogo(groupKey, logoUrl) {
  labelLogoCache.set(groupKey, logoUrl);
  if (labelsDb) stmtInsertLogo.run(groupKey, logoUrl);
}
// Remove every cached "no logo found" verdict (NULL rows) so FanArt can be
// retried — used when the FanArt key is (re)saved, because misses recorded
// while the key was absent/broken were kept forever, permanently blocking
// FanArt for those labels. Real logos are untouched.
function purgeFanartLogoMisses() {
  let cleared = 0;
  for (const [k, v] of labelLogoCache) {
    if (v === null || v === undefined) { labelLogoCache.delete(k); cleared++; }
  }
  if (labelsDb) {
    try { labelsDb.prepare("DELETE FROM label_logos WHERE logo_url IS NULL").run(); }
    catch (e) { if (DEBUG) console.error("[labels:fanart] purge:", e.message); }
  }
  return cleared;
}
// Where a stored year came from. Higher wins: a better source may CORRECT a
// worse one, a worse one may never overwrite a better one.
//
// This exists because "first writer wins" is not safe when the writers race.
// The local file scan walks the disk for minutes while the Qobuz/TIDAL
// favourites come back in seconds, so on a rescan the services would land
// first and their edition dates would stick permanently — a TIDAL 2011
// remaster of a 1973 album filed under the 2010s, with the user's own
// ORIGINALDATE tag arriving too late to correct it.
//
// The ranking is about how close the source is to the release the user owns:
//   file    — their own tags, describing their own copy. Nothing beats this.
//   release — a date the source explicitly calls the ORIGINAL release
//             (MusicBrainz, Qobuz release_date_original).
//   edition — a date that may be this edition's rather than the original's
//             (TIDAL releaseDate, Qobuz stream/download dates).
//   catalog — a matched catalogue entry (iTunes, TheAudioDB, Discogs).
// Anything already stored without a source (rows written before this existed)
// ranks 0, so the first identified source corrects it.
// A function, not a lookup table, so tests can exercise the shipping ranking
// rather than a copy of it injected alongside.
function yearSourceRank(src) {
  switch (src) {
    case "file":    return 4;
    case "release": return 3;
    case "edition": return 2;
    case "catalog": return 1;
    default:        return 0;   // written before provenance was recorded
  }
}
const albumYearSource = new Map();   // album key → source name, mirrors album_years.src

// Persist a release year for an album key (4-digit). Powers the Decade filter.
// Returns whether anything actually changed, so bulk callers can bump the
// library-view cache ONCE instead of once per album.
//
// The bump used to happen unconditionally at the top, before the value was even
// validated — so a rejected year still threw away every memoised ordering, and
// the bulk harvest below would have done that thousands of times per sync.
function setAlbumYear(key, year, opts) {
  const y = String(year || "").slice(0, 4);
  if (!/^\d{4}$/.test(y)) return false;   // only store a plausible 4-digit year
  const src     = (opts && opts.src) || null;
  const newRank = yearSourceRank(src);
  const oldRank = yearSourceRank(albumYearSource.get(key));
  const known   = albumYearCache.has(key);
  // Same value, and no better provenance to record — nothing to do.
  if (known && albumYearCache.get(key) === y && newRank <= oldRank) return false;
  // A source no better than the one already on file may not overwrite it.
  if (known && newRank <= oldRank) return false;
  albumYearCache.set(key, y);
  if (src) albumYearSource.set(key, src); else albumYearSource.delete(key);
  if (labelsDb && stmtInsertYear) stmtInsertYear.run(key, y, src);
  // ordered library views join on years — drop stale orderings
  if (!(opts && opts.deferBump)) bumpLibraryMeta();
  return true;
}

// A release year noticed while the label scan was doing something else.
// The scan iterates the library snapshot, so callers pass ROON's own title and
// artist — which means this can write straight into the year-cache key space
// with no join needed.
//
// Deferred bump on purpose: this fires for essentially every album of the
// iTunes pass, and an immediate bump would clear the memoised library
// orderings several times a second for the hours a first scan runs, so every
// Library page would re-sort the whole library from scratch. bumpLibraryMeta
// is throttled instead.
function rememberScanYear(title, artist, date, src) {
  const y = yearOfDate(date);
  if (!y || !title) return;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (setAlbumYear(key, y, { src: src || "catalog", deferBump: true })) scheduleLibraryMetaBump();
}

openLabelsDb();

// Decide the opt-in defaults now that the data volume is readable.
//
// The rule is "off unless asked", with one exception: somebody already running
// these features must not have them switched off underneath them by an update.
// A populated label cache, or picks already built, is evidence the feature was
// running — that state cannot exist otherwise — so it is read as consent and
// written down once, after which the setting is explicit and this never runs
// again. A fresh install has neither and starts off, which is the point.
function featureHasHistory(table, column) {
  if (!labelsDb) return false;
  try {
    const row = labelsDb.prepare("SELECT " + column + " AS n FROM " + table + " LIMIT 1").get();
    return !!row;
  } catch (e) {
    return false;   // table absent on a pre-migration DB — no history to honour
  }
}
function applyFeatureDefaults() {
  // No database means the evidence cannot be READ, which is not the same as
  // there being none. Writing an inference down here would switch an existing
  // user's features off permanently on one bad boot — a corrupt file, a locked
  // DB, a native module that failed to load — and repairing the database would
  // not bring them back, because the setting is explicit by then.
  if (!labelsDb) {
    console.warn("[settings] feature defaults deferred — no database to read use from");
    return;
  }
  const patch = {};
  if (!_labelsEnabledSet) {
    labelsEnabled = featureHasHistory("label_names", "key");
    patch.labelsEnabled = labelsEnabled;
  }
  if (!_smartPicksEnabledSet) {
    smartPicksEnabled = featureHasHistory("smart_picks", "day");
    patch.smartPicksEnabled = smartPicksEnabled;
  }
  if (Object.keys(patch).length) {
    // The write is what makes the inference permanent, so an unwritten
    // inference must not be reported as applied — it will be re-derived on the
    // next boot, which is the correct outcome.
    const saved = savePersistedSettings(patch);
    console.log("[settings] feature defaults " + (saved ? "applied" : "inferred but NOT saved") +
                ": " + Object.entries(patch).map(([k, v]) => k + "=" + v).join(" "));
  }
}
applyFeatureDefaults();

// ---------------------------------------------------------------------------
// Fan Art TV — label logo images. Free API key — set via web UI settings.

const labelsIndex = {
  map:      new Map(),   // groupKey → { display, image_key, albums: [{offset,title,subtitle,image_key}] }
  count:    0,
  declared: 0,     // Roon's own album count when this snapshot was taken
  builtAt:  0,
  progress: 0,           // 0..1 while scanning
  building: false
};

function loadLastScanTime() {
  try {
    const raw = fs.readFileSync(LAST_SCAN_FILE, "utf8").trim();
    const ts = parseInt(raw, 10);
    if (Number.isFinite(ts) && ts > 0) {
      labelsIndex.builtAt = ts;
      if (DEBUG) console.log("[labels] last scan:", new Date(ts).toISOString());
    }
  } catch (e) { /* file not present yet */ }
}

function saveLastScanTime() {
  try {
    fs.mkdirSync(LABELS_DB_DIR, { recursive: true });
    fs.writeFileSync(LAST_SCAN_FILE, String(Date.now()));
  } catch (e) {
    if (DEBUG) console.error("[labels] saveLastScanTime:", e.message);
  }
}

loadLastScanTime();

// Strip common corporate suffixes so "ACT Music" and "ACT", "Blue Note Records" and
// "Blue Note" all map to the same group key. Applied twice to catch "XYZ Music Records".
const LABEL_SUFFIX_RE = /\s+(Records?|Recordings?|Music|Label|Labels|Group|Entertainment|Productions?|Publishing|Inc\.?|Ltd\.?|LLC|GmbH|S\.A\.?|s\.r\.l\.?|Verlag|Editions?|Edition)\.?\s*$/i;

// Strip country / regional qualifiers so "[PIAS] America" and "[PIAS] Belgium" both
// group under "[PIAS]", and "Universal Music Canada" groups with "Universal Music France".
// Multi-word countries come first so "United States" is stripped before "States".
const COUNTRY_REGION_SUFFIX_RE = /\s+(United\s+States|United\s+Kingdom|New\s+Zealand|South\s+Africa|Latin\s+America|North\s+America|Group\s+International|US|USA|UK|America|Canada|France|Germany|Belgium|Russia|Australia|Japan|Italy|Spain|Netherlands|Holland|Ireland|Sweden|Norway|Denmark|Finland|Poland|Brazil|Mexico|Argentina|Chile|China|Korea|India|Portugal|Switzerland|Austria|Romania|Greece|Hungary|Turkey|International|Classics?|Cooperative|Global|Worldwide|Latino|Nordic|Iberian|Benelux|Scandinavia|Asia|Europe|Africa|Pacific|APAC)\b\s*$/i;

function labelGroupKey(name) {
  if (!name) return "";
  let s = name.trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(COUNTRY_REGION_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(LABEL_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(LABEL_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(COUNTRY_REGION_SUFFIX_RE, "").trim();
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalLabelName(name) {
  if (!name) return name;
  return name.trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(COUNTRY_REGION_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(LABEL_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(LABEL_SUFFIX_RE, "").trim()
    .replace(/[,;:]+$/, "").trim()
    .replace(COUNTRY_REGION_SUFFIX_RE, "").trim();
}

function labelsIndexAddAlbum(labelName, album) {
  if (!labelName || !album) return;
  let groupKey = labelGroupKey(labelName);
  if (!groupKey) return;
  // Redirect manually merged source labels to their canonical target.
  const merge = labelMerges.get(groupKey);
  let displayName = canonicalLabelName(labelName);
  if (merge) { groupKey = merge.targetKey; displayName = merge.targetDisplay; }
  let entry = labelsIndex.map.get(groupKey);
  if (!entry) {
    entry = {
      display:   displayName,
      image_key: album.image_key || null,
      mbid:      labelMbidCache.get(groupKey) || null,
      logo_url:  labelLogoCache.has(groupKey) ? (labelLogoCache.get(groupKey) || null) : null,
      albums:    []
    };
    labelsIndex.map.set(groupKey, entry);
    labelsIndex.count = labelsIndex.map.size;
  }
  if (!entry.mbid && labelMbidCache.has(groupKey)) entry.mbid = labelMbidCache.get(groupKey);
  if (!entry.logo_url && labelLogoCache.has(groupKey)) entry.logo_url = labelLogoCache.get(groupKey) || null;
  if (!entry.image_key && album.image_key) entry.image_key = album.image_key;
  if (!entry.albums.some(a => a.offset === album.offset)) {
    entry.albums.push({
      offset:    album.offset,
      title:     album.title,
      subtitle:  album.subtitle,
      image_key: album.image_key
    });
  }
}

// Seed from disk cache + in-memory qobuzCache — no network calls.
// Overrides file (data/labels-override.json) takes highest priority.
const labelsOverrideFile = path.join(__dirname, "data", "labels-override.json");
const labelsOverride = new Map(); // key → label (loaded once at startup)

(function loadLabelsOverride() {
  try {
    const raw  = fs.readFileSync(labelsOverrideFile, "utf8");
    const data = JSON.parse(raw);
    const albums = Array.isArray(data) ? data : (data && data.albums ? data.albums : []);
    for (const e of albums) {
      if (e.label) {
        const key = normalize(e.title || "") + "||" + normalize(e.artist || "");
        labelsOverride.set(key, e.label);
      }
    }
    if (DEBUG) console.log("[labels] override file loaded:", labelsOverride.size, "entries");
  } catch (e) { /* file optional */ }
})();

function seedLabelsFromCache() {
  for (const al of albumIndex.albums) {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    // Priority: override file → disk cache → qobuzCache
    const override = labelsOverride.get(key);
    if (override) { labelsIndexAddAlbum(override, al); continue; }
    const diskLabel = labelDiskCache.get(key);
    if (diskLabel) { labelsIndexAddAlbum(diskLabel, al); continue; }
    const q = qobuzCache.get(key);
    if (q && q.label && !isLikelyNotALabel(q.label)) {
      labelsIndexAddAlbum(q.label, al);
      setLabelName(key, q.label);
    }
  }
  labelsIndex.count = labelsIndex.map.size;
  if (DEBUG) console.log("[labels] seeded:", labelsIndex.count, "labels");
  // Kick off logo fetches for any labels already in the mbid cache.
  kickFanArtFetches()
    .then(() => kickDiscogsLogoFetches())
    .catch(e => { if (DEBUG) console.error("[labels] logo fetch error:", e.message); });
}

// Lightweight map rebuild used after manual merges/unmerges — re-applies all
// labelMerges redirects without kicking another round of logo fetches.
function rebuildLabelsMap() {
  labelsIndex.map.clear();
  labelsIndex.count = 0;
  for (const al of albumIndex.albums) {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    const override = labelsOverride.get(key);
    if (override) { labelsIndexAddAlbum(override, al); continue; }
    const diskLabel = labelDiskCache.get(key);
    if (diskLabel) { labelsIndexAddAlbum(diskLabel, al); continue; }
    const q = qobuzCache.get(key);
    if (q && q.label && !isLikelyNotALabel(q.label)) labelsIndexAddAlbum(q.label, al);
  }
  labelsIndex.count = labelsIndex.map.size;
}

// Read-only per-album label lookup using the SAME priority the labels index is
// seeded with (override file → disk cache → qobuzCache). Returns the raw label
// name, or null. Used by the wall display to project the live album index onto
// a label without depending on the labels-index snapshot's stored offsets.
function resolveAlbumLabelName(al) {
  const key = normalize(al.title) + "||" + normalize(al.subtitle);
  const override = labelsOverride.get(key);
  if (override) return override;
  const diskLabel = labelDiskCache.get(key);
  if (diskLabel) return diskLabel;
  const q = qobuzCache.get(key);
  if (q && q.label && !isLikelyNotALabel(q.label)) return q.label;
  return null;
}

// Canonical group key for a label name, applying any manual merge redirect the
// labels index would apply — so two albums under merged source labels compare
// equal, exactly as they group together in the labels browser.
function canonicalLabelGroupKey(labelName) {
  let gk = labelGroupKey(labelName);
  if (!gk) return null;
  const merge = labelMerges.get(gk);
  return merge ? merge.targetKey : gk;
}

// ---------------------------------------------------------------------------
// iTunes Search API — primary label source. Free, no key, returns recordLabel
// directly. Rate-limited to 3 concurrent with 500ms between batches.
// Returns the symbol ITUNES_BLOCKED on 429/403 so the caller can abort the
// entire iTunes pass rather than continuing to hammer a blocked endpoint.
// ---------------------------------------------------------------------------
const ITUNES_BLOCKED = Symbol("itunes_blocked");
let itunesLastBatch = 0;
async function itunesBatchWait() {
  const elapsed = Date.now() - itunesLastBatch;
  if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));
  itunesLastBatch = Date.now();
}

async function fetchLabelFromiTunes(title, artist) {
  if (!title) return null;
  const term = [title, artist].filter(Boolean).join(" ");
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&media=music&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT }, 10000);
    const results = json && json.results;
    if (!Array.isArray(results) || !results.length) return null;
    const normTitle = normalize(title);
    let match = results.find(r => normalize(r.collectionName || "") === normTitle);
    if (!match && artist) {
      // No exact title match — try artist match as a weaker fallback before results[0].
      const normArtist = normalize(artist);
      match = results.find(r => normalize(r.artistName || "") === normArtist);
    }
    // A year is recorded only from a match verified on BOTH title and artist.
    // The fallbacks below are fine for a label — a wrong label is cosmetic and
    // gets overwritten on the next scan — but a year is written to album_years
    // and read by the Decade filter, so a loose match files an album under the
    // wrong decade permanently. The title-only branch matches any artist's
    // "Greatest Hits"; the artist-only branch matches any album by that artist;
    // and results[0] is whatever iTunes ranked first for a free-text query, so
    // an album with no artist credit (common on classical and box sets) would
    // take a stranger's release date.
    const strict = artist
      ? results.find(r => normalize(r.collectionName || "") === normTitle &&
                          normalize(r.artistName || "") === normalize(artist))
      : null;
    if (strict) rememberScanYear(title, artist, strict.releaseDate, "catalog");
    if (!match) match = results[0];
    const label = match && match.recordLabel;
    if (!label || isLikelyNotALabel(label)) return null;
    return label;
  } catch (e) {
    if (e.message && /429|403/.test(e.message)) {
      if (DEBUG) console.error("[labels:itunes] rate limited — aborting iTunes pass");
      return ITUNES_BLOCKED;
    }
    if (DEBUG) console.error("[labels:itunes]", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// MusicBrainz label lookup — fallback for albums iTunes misses.
// Returns { label, mbid } for a release, or null if not found.
// Rate limited via the shared mbWait() (1.1 s between requests).
// ---------------------------------------------------------------------------
async function fetchLabelFromMusicBrainz(title, artist) {
  if (!title) return null;
  await mbWait();
  let q = `release:"${mbQuote(title)}"`;
  if (artist) q += ` AND artist:"${mbQuote(artist)}"`;
  const url =
    `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT }, 20000);
    for (const r of json.releases || []) {
      const li = (r["label-info"] || [])[0];
      const labelObj = li && li.label;
      if (labelObj && labelObj.name) {
        // Year comes free from the same release object — no extra request.
        const year = (r.date && /^\d{4}/.test(r.date)) ? r.date.slice(0, 4) : null;
        return { label: labelObj.name, mbid: labelObj.id || null, year };
      }
    }
  } catch (e) {
    if (DEBUG) console.error("[labels:mb]", e.message);
  }
  return null;
}

// Resolve a label name to a MusicBrainz label MBID — called once per unique
// label group key, not once per album. Far more efficient than release lookup.
async function fetchLabelMbidFromMusicBrainz(labelName) {
  if (!labelName) return null;
  await mbWait();
  const q = `label:"${mbQuote(labelName)}"`;
  const url = `https://musicbrainz.org/ws/2/label/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const labels = json && json.labels;
    if (Array.isArray(labels) && labels.length) return labels[0].id || null;
  } catch (e) {
    if (DEBUG) console.error("[labels:mb:label]", e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discogs — personal access token auth (60 req/min vs 25 for key/secret).
// Stored in settings.json, configurable via the web UI settings panel.
// ---------------------------------------------------------------------------
// Strip leading AND trailing non-alphanumeric chars before Discogs queries.
// Discogs Elasticsearch treats ~ as a fuzzy operator and unbalanced brackets
// like "[PIAS]" → "PIAS]" trip range-query parsing.
function sanitizeDiscogsSearchTerm(name) {
  return name.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").trim() || name;
}

let discogsLastReq = 0;
const discogsLogoTried = new Set(); // per-session dedup — resets on container restart
let bandcampLastReq  = 0;
let pitchforkLastReq = 0;

async function discogsWait() {
  const elapsed = Date.now() - discogsLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  discogsLastReq = Date.now();
}

async function fetchLabelFromDiscogs(title, artist) {
  if (!title || !discogsToken) return null;
  await discogsWait();
  const params = new URLSearchParams({ type: "release", release_title: title });
  if (artist) params.set("artist", artist);
  const url = `https://api.discogs.com/database/search?${params}`;
  try {
    const json = await httpJson(url, {
      "Authorization": `Discogs token=${discogsToken}`,
      "User-Agent": MB_USER_AGENT
    });
    const results = json && json.results;
    if (!Array.isArray(results) || !results.length) return null;
    const normTitle = normalize(title);
    let match = results.find(r => normalize(r.title || "").includes(normTitle));
    if (!match) match = results[0];
    const label = match && Array.isArray(match.label) && match.label[0];
    if (!label || isLikelyNotALabel(label)) return null;
    return label;
  } catch (e) {
    if (DEBUG) console.error("[labels:discogs]", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TheAudioDB — free public API (no key required). Returns strLabel field.
// Rate limited to 1 req/sec — the public API is restrictive.
// ---------------------------------------------------------------------------
let tadbLastReq = 0;
async function tadbWait() {
  const elapsed = Date.now() - tadbLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  tadbLastReq = Date.now();
}

async function fetchLabelFromTheAudioDB(title, artist) {
  if (!title || !artist) return null;
  await tadbWait();
  const url = `https://www.theaudiodb.com/api/v1/json/2/searchalbum.php?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(title)}`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT }, 6000);
    const albums = json && json.album;
    if (!Array.isArray(albums) || !albums.length) return null;
    const normTitle = normalize(title);
    const exact = albums.find(a => normalize(a.strAlbum || "") === normTitle);
    // Year only from the EXACT title match — see the iTunes note. The query
    // constrains the artist, so albums[0] is at least by the right artist, but
    // it is a different album: "Live at Leeds" not found under that exact
    // spelling would take the year of "My Generation" and land in the 1960s.
    if (exact) rememberScanYear(title, artist, exact.intYearReleased, "catalog");
    const match = exact || albums[0];
    const label = match && match.strLabel;
    if (!label || isLikelyNotALabel(label)) return null;
    return label;
  } catch (e) {
    if (DEBUG) console.error("[labels:theaudiodb]", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// File metadata — read LABEL/ORGANIZATION tags from mounted music directory.
// Container should be started with -v /path/to/music:/music:ro
// ---------------------------------------------------------------------------
const MUSIC_DIR = process.env.MUSIC_DIR || "/music";

function musicDirMounted() {
  try { return fs.statSync(MUSIC_DIR).isDirectory(); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// "Local files" evidence — which albums exist as files under the /music mount.
// Roon's API gives no storage/source field on album items, so the read-only
// mount the label scanner already walks is the one authoritative signal we
// have. Persisted on the data volume so badges survive a restart without
// waiting for the next scan; empty (no badges anywhere) when /music isn't
// mounted, which is the honest answer rather than a guess.
// ---------------------------------------------------------------------------
// Write-then-rename so a crash mid-write can't leave truncated JSON that the
// loader silently discards (which would drop every badge until the next scan).
function writeJsonAtomic(file, data, tag) {
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(tag + " could not persist " + path.basename(file) + ":", e.message);
    try { fs.unlinkSync(tmp); } catch (e2) { /* temp file already gone — nothing to clean up */ }
  }
}

// Bumped whenever the key FORMAT changes. Persisted sets written by an older
// format are discarded rather than silently failing to match (which would look
// like every badge vanishing for no reason).
const SOURCE_KEY_VERSION = 2;
const LOCAL_ALBUMS_FILE = path.join(__dirname, "data", "local-albums.json");
let localAlbumKeys = new Set();
function loadLocalAlbumKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_ALBUMS_FILE, "utf8"));
    if (raw && raw.v === SOURCE_KEY_VERSION && Array.isArray(raw.keys)) {
      localAlbumKeys = new Set(raw.keys);
      if (DEBUG) console.log("[local] loaded", localAlbumKeys.size, "local album keys");
    } else {
      // Old format: the /music walk rebuilds it. Kicked shortly so local badges
      // come back in minutes rather than at the next 12h cycle. The WALK, not
      // the label scan — the badge is not a label feature, and routing this
      // through the label scan meant it never ran with Labels switched off.
      console.log("[local] stored keys are an older format — rescanning /music to rebuild badges");
      const t = setTimeout(() => {
        if (!core || labelsIndex.building) return;
        runFileMetadataScan("local keys missing").catch(e => {
          if (DEBUG) console.error("[local] rebuild scan:", e.message);
        });
      }, 60000);
      if (t.unref) t.unref();
    }
  } catch (e) {
    // Absent on first run, or unreadable. Either way there is nothing to load
    // AND nothing scheduled to rebuild it — only the wrong-version branch above
    // kicked a scan, so a lost file left the local badges empty until something
    // else happened to trigger the walk.
    const t = setTimeout(() => {
      if (!core || labelsIndex.building) return;
      runFileMetadataScan("local keys absent").catch(err => {
        if (DEBUG) console.error("[local] first-run scan:", err.message);
      });
    }, 60000);
    if (t.unref) t.unref();
  }
}
function setLocalAlbumKeys(keys) {
  localAlbumKeys = keys;
  writeJsonAtomic(LOCAL_ALBUMS_FILE, { v: SOURCE_KEY_VERSION, keys: [...keys] }, "[local]");
  console.log("[local] " + keys.size + " album keys recorded from " + MUSIC_DIR);
}
loadLocalAlbumKeys();

// ---------------------------------------------------------------------------
// Streaming provenance — which library albums came from Qobuz / Tidal.
//
// Roon exposes no source field, but adding a streaming album to your Roon
// library favourites it in the service, so the user's own favourites (read
// with the logins this extension already holds for reviews and identification)
// are a good proxy. Matched on normalized title + artist, same conservative
// rule as the local badge: a confident match or no badge at all.
//
// Refreshed alongside the library snapshot and persisted, so badges are
// available immediately on restart and cost nothing per request.
// ---------------------------------------------------------------------------
const STREAM_ALBUMS_FILE = path.join(__dirname, "data", "stream-albums.json");
let qobuzAlbumKeys = new Set();
let tidalAlbumKeys = new Set();
// Release years harvested from those same payloads — see harvestAlbumYears
// below for what they are and why they are keyed this way. Declared HERE, beside
// the key sets they are filled alongside, rather than next to the harvest code:
// refreshStreamAlbumKeys assigns them, and a `let` sitting hundreds of lines
// BELOW its assignment is a ReferenceError waiting for the day that call stops
// being deferred by a setTimeout. (The v1.5.66 startup crash, exactly.)
let fileAlbumYears  = new Map();   // albumKey → "YYYY", from /music file tags
let qobuzAlbumYears = new Map();   // albumKey → "YYYY", from Qobuz favourites
let tidalAlbumYears = new Map();   // albumKey → "YYYY", from TIDAL favourites
function loadStreamAlbumKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(STREAM_ALBUMS_FILE, "utf8"));
    // Older key format: ignore it. The startup refresh below rebuilds from the
    // services within seconds, so nothing is lost.
    if (!raw || raw.v !== SOURCE_KEY_VERSION) return;
    if (Array.isArray(raw.qobuz)) qobuzAlbumKeys = new Set(raw.qobuz);
    if (Array.isArray(raw.tidal)) tidalAlbumKeys = new Set(raw.tidal);
    if (DEBUG) console.log("[stream] loaded", qobuzAlbumKeys.size, "Qobuz +",
                           tidalAlbumKeys.size, "Tidal album keys");
  } catch (e) { /* absent on first run — rebuilt by the next favourites refresh */ }
}
function saveStreamAlbumKeys() {
  writeJsonAtomic(STREAM_ALBUMS_FILE,
    { v: SOURCE_KEY_VERSION, qobuz: [...qobuzAlbumKeys], tidal: [...tidalAlbumKeys] }, "[stream]");
}
loadStreamAlbumKeys();
// First run (or a version upgrade) has no persisted keys: fetch them shortly
// after boot so badges appear without waiting for the next library sync.
// Delayed so it never competes with pairing, and unref'd so it can't hold the
// process open.
if (!qobuzAlbumKeys.size && !tidalAlbumKeys.size) {
  const t = setTimeout(() => {
    refreshStreamAlbumKeys("startup").catch(e => {
      if (DEBUG) console.error("[stream] startup refresh:", e.message);
    });
  }, 20000);
  if (t.unref) t.unref();
}

// An album's identity for cross-source matching: title + artist, canonicalised.
// ONE definition, used by the local scan and both streaming sets — they share a
// key space, so they must share the key builder.
//
// On top of normalize() (case, accents, punctuation) this drops "and" tokens,
// because normalize() turns "&" into a separator but leaves "and" as a word —
// so "Songs of Love & Hate" and "Songs of Love and Hate" could never match.
function canonText(s) {
  const n = normalize(s || "");
  return n ? n.split(" ").filter(t => t && t !== "and").join(" ") : "";
}
// Artists additionally lose a leading "the" ("The Beatles" / "Beatles").
function canonArtist(s) {
  const c = canonText(s);
  return c.startsWith("the ") ? c.slice(4) : c;
}
// A blank canonical TITLE returns null and is never stored or looked up:
// normalize() strips everything that isn't ASCII alphanumeric, so "+", "÷",
// "!!!" and any all-CJK/Cyrillic title collapse to "". Keying those would make
// unrelated albums collide — one Japanese-titled local album would otherwise
// badge every Japanese-titled streaming album as local.
function albumKey(title, artist) {
  const t = canonText(title);
  if (!t) return null;
  return t + "||" + canonArtist(artist);
}

// Every identity an album could be known by. Roon credits multi-artist albums
// with all performers ("T-Bone Walker/Big Joe Turner/Otis Spann") while Qobuz
// and TIDAL report only the primary one, so the whole-credit key alone misses
// every collaboration. Each individual artist is offered as an alternative.
// The TITLE always has to match, so a wrong badge would need the same album
// title AND a shared artist on genuinely different releases.
// Every spelling of an album TITLE worth matching under. The plain title, plus
// the same title with an edition marker removed.
//
// This exists because Roon replaces file tags with its own metadata for albums
// it identifies. A rip tagged "Rumours" sits in a library where Roon calls it
// "Rumours (Deluxe Edition)", and with one title string on each side those two
// can never meet — silently, in a way that shows up only as a source count
// that is hundreds short. The streaming path has had this since v1.6.55
// (addFavouriteKeys indexes both "Album" and "Album (Deluxe)"); the local path
// never got it.
//
// The stripped form is an EXTRA key, never a replacement: the full titles still
// match each other, and two albums that collapse to the same stripped title
// simply share an identity, which ambiguousAlbumKeys already suppresses for
// badging.
function albumTitleVariants(title) {
  const raw = String(title || "").trim();
  const out = [];
  // The original title goes in whatever its length — albums really are called
  // "X" and "÷", and rejecting those would strip them of every identity they
  // have. The floor applies only to STRIPPED forms, where a short result means
  // the marker was most of the title and what's left would match everything.
  const first = canonText(raw);
  if (first) out.push(first);
  const add = (v) => {
    const c = canonText(v);
    if (c && c.length >= 3 && !out.includes(c)) out.push(c);
  };
  // A trailing bracketed chunk: "(Deluxe Edition)", "[2016 Remaster]".
  add(raw.replace(/\s*[([][^()[\]]*[)\]]\s*$/, ""));
  // A trailing dash suffix, but ONLY when it reads as an edition — "Album -
  // Part Two" is a different record, "Album - Remastered" is not.
  add(raw.replace(
    /\s+-\s+[^-]*\b(remaster(ed)?|deluxe|edition|expanded|anniversary|bonus|reissue|mono|stereo|version|remix(ed)?)\b[^-]*$/i,
    ""));
  return out;
}

function albumKeys(title, subtitle) {
  const titles = albumTitleVariants(title);
  if (!titles.length) return [];
  const out = [], seen = new Set();
  const push = (artist) => {
    const a = canonArtist(artist);
    for (const t of titles) {
      const k = t + "||" + a;
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  };
  push(subtitle || "");
  // Same separators the artist links use, plus the unspaced slash.
  for (const frag of String(subtitle || "").split(/ \/ |\/| feat\.? | featuring | ft\.? |, | & | \+ /i)) {
    const f = frag.trim();
    if (f.length >= 2) push(f);
  }
  return out;
}

// Index one favourite under every identity Roon might show it as: each credited
// artist, and — because the services return the edition separately from the
// title while Roon often bakes it in — both "Album" and "Album (Deluxe)".
function addFavouriteKeys(keys, title, version, artists) {
  const titles = [title];
  if (version) titles.push(title + " " + version);
  for (const t of titles) {
    for (const artist of artists) {
      if (!artist) continue;
      const key = albumKey(t, artist);
      if (key) keys.add(key);
    }
  }
}

// Pull the user's favourites from whichever services are connected. Never
// throws: a service that isn't connected (or is having a bad day) just leaves
// its previous key set untouched.
let _streamRefreshInFlight = false;
let _streamRefreshQueued   = false;
async function refreshStreamAlbumKeys(reason) {
  if (_streamRefreshInFlight) {
    // Rescan fires this AND the library sync fires it again — dropping the
    // second would leave the badges stale exactly when the user asked for a
    // refresh. Queue one re-run instead.
    _streamRefreshQueued = true;
    return;
  }
  _streamRefreshInFlight = true;
  try {
    if (qobuzToken || (qobuzUsername && qobuzPasswordMd5)) {
      try {
        // Page until the service runs out: a one-page read silently badged only
        // the first 500 favourites and left the rest looking unmatched.
        const PAGE = 500, MAX_PAGES = 20;
        const keys = new Set();
        // Harvested alongside the keys from the SAME response — Qobuz's album
        // objects carry their release date, so the Decade filter gets it for
        // free rather than needing a lookup pass of its own.
        const years = new Map();
        let fetched = 0, skipped = 0, qualities = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const items = await qobuzWithToken((t) => qobuz.getFavoriteAlbums(t, PAGE, page * PAGE));
          if (!items.length) break;
          fetched += items.length;
          for (const a of items) {
            const before = keys.size;
            const artists = [(a.artist && a.artist.name), (a.performer && a.performer.name)];
            addFavouriteKeys(keys, a.title, a.version, artists);
            addHarvestedYear(years, a.title, a.version, artists,
              a.release_date_original || a.release_date_stream || a.release_date_download);
            // ...and the bit depth and sample rate, from the same object. An
            // album in the Roon library with no local file is one of these, so
            // this is what gives it a quality badge at all.
            const q = qobuzQualityOf(a);
            if (q) qualities += addHarvestedQuality(a.title, a.version, artists, q, "qobuz");
            if (keys.size === before) skipped++;
          }
          if (items.length < PAGE) break;
        }
        if (qualities) {
          // The Format/Sample rate/Bit depth facets just gained values, and the
          // memoised orderings were built without them.
          bumpLibraryMeta();
          console.log("[format] " + qualities + " album identities given a format by Qobuz");
        }
        // Assigned even when EMPTY — the user may have un-favourited everything,
        // and keeping the old set would badge albums that are no longer theirs.
        qobuzAlbumKeys = keys;
        qobuzAlbumYears = years;
        console.log("[stream] Qobuz favourites: " + keys.size + " albums from " + fetched +
                    " favourites (" + reason + ")" + (skipped ? ", " + skipped + " unkeyable" : "") +
                    ", " + years.size + " dated");
      } catch (e) {
        // Left untouched on failure: a network blip must not wipe working badges.
        console.error("[stream] Qobuz favourites failed (keys kept):", e.message);
      }
    }
    if (tidalRefreshToken && tidalUserId) {
      try {
        // Through tidalWithToken so a revoked/expired access token is refreshed
        // and retried, like every other Tidal call.
        const rows = await tidalWithToken((token, cc) =>
          tidal.getFavoriteAlbums(token, cc, tidalUserId));
        const keys = new Set();
        const years = new Map();   // free release dates — see the Qobuz note above
        let skipped = 0, qualities = 0;
        for (const row of rows) {
          const a = (row && row.item) ? row.item : row;
          if (!a || !a.title) continue;
          const before = keys.size;
          const artists = [(a.artist && a.artist.name)]
            .concat((a.artists || []).map(x => x && x.name));
          addFavouriteKeys(keys, a.title, a.version, artists);
          addHarvestedYear(years, a.title, a.version, artists, a.releaseDate);
          const q = tidalQualityOf(a);
          if (q) qualities += addHarvestedQuality(a.title, a.version, artists, q, "tidal");
          if (keys.size === before) skipped++;
        }
        if (qualities) {
          bumpLibraryMeta();
          console.log("[format] " + qualities + " album identities given a format by TIDAL");
        }
        tidalAlbumKeys = keys;   // empty is a valid answer — see the Qobuz note
        tidalAlbumYears = years;
        console.log("[stream] Tidal favourites: " + keys.size + " albums from " + rows.length +
                    " favourites (" + reason + ")" + (skipped ? ", " + skipped + " unkeyable" : "") +
                    ", " + years.size + " dated");
      } catch (e) {
        console.error("[stream] Tidal favourites failed (keys kept):", e.message);
      }
    }
    saveStreamAlbumKeys();
    // Join the freshly harvested dates onto the snapshot. No-ops when the index
    // isn't built yet (startup, "service connected") — the library sync calls
    // this again once it is.
    harvestAlbumYears("stream favourites: " + reason);
  } finally {
    _streamRefreshInFlight = false;
    if (_streamRefreshQueued) {
      _streamRefreshQueued = false;
      refreshStreamAlbumKeys("queued").catch(e => {
        if (DEBUG) console.error("[stream] queued refresh:", e.message);
      });
    }
  }
}

// Disconnecting a service must take its badges with it — otherwise every album
// keeps the logo of an account the user has removed, and the persisted file
// reinstates it on the next restart.
function clearStreamAlbumKeys(which) {
  if (which === "qobuz") qobuzAlbumKeys = new Set();
  if (which === "tidal") tidalAlbumKeys = new Set();
  saveStreamAlbumKeys();
  // The formats that service told us go with it. Leaving them behind would show
  // a bit depth sourced from an account the user has removed — and, because the
  // rows are on the data volume, reinstate it on the next restart.
  let dropped = 0;
  for (const [key, f] of albumFileCache) {
    if (f && f.src === which) { albumFileCache.delete(key); dropped++; }
  }
  if (dropped && labelsDb) {
    try { labelsDb.prepare("DELETE FROM album_files WHERE src = ?").run(which); }
    catch (e) { if (DEBUG) console.error("[format] clear failed:", e.message); }
  }
  if (dropped) bumpLibraryMeta();
  console.log("[stream] cleared " + which + " album keys (disconnected)" +
              (dropped ? ", " + dropped + " formats" : ""));
}

// Which streaming services could be claiming albums in this library right now.
// A service counts only when it is connected AND its favourites actually
// loaded — a connected account whose fetch failed knows nothing, and treating
// its silence as "claims nothing" would call its albums local.
function claimingServices() {
  const out = [];
  if ((qobuzToken || (qobuzUsername && qobuzPasswordMd5)) && qobuzAlbumKeys.size) out.push("qobuz");
  if (tidalRefreshToken && tidalAlbumKeys.size) out.push("tidal");
  return out;
}

// True when an album no service claims must be local.
//
// Roon's library is local files plus streaming albums you have added, and
// adding a streaming album favourites it in the service (that is what makes the
// qobuz/tidal key sets meaningful in the first place). So with NO service
// connected there is nothing else an album can be, and locality does not have
// to be proved album-by-album at all.
//
// That matters because proving it is a lossy join: file tags versus Roon's own
// metadata, which Roon rewrites for every album it identifies. That join left
// 281 of 2,234 albums uncounted on a library that was entirely local, and no
// amount of matching work closes a gap whose cause is that the two sides
// legitimately disagree about the album's name.
//
// With a service connected the elimination does not hold — an unclaimed album
// could be local, or from a service that is NOT connected here — so positive
// evidence is all we have and the old behaviour stands.
function unclaimedIsLocal() {
  return claimingServices().length === 0;
}

// Where an album came from, as far as the evidence goes: "local" | "qobuz" |
// "tidal" | null. This is the TRUTH function — Focus counting and Focus
// filtering both call it, and they must agree exactly.
//
// `rec` is the albumIndex record the payload came from, when there is one: it
// already carries the precomputed identity keys, so the hot list paths (walls,
// Library paging, artist screens) do no string work at all here.
//
// Local wins over a streaming match — the files are what actually plays. But
// an album favourited in BOTH services is genuinely ambiguous: Roon pulled it
// from one of them and we can't tell which, so it gets nothing rather than a
// coin-flip answer.
function albumSource(title, subtitle, rec) {
  const keys = (rec && rec.srcKeys) ? rec.srcKeys : albumKeys(title, subtitle);
  for (const key of keys) {
    // Two library albums share this identity — we can't tell which is which,
    // so neither gets a badge.
    if (ambiguousAlbumKeys.has(key)) continue;
    if (localAlbumKeys.has(key)) return "local";
    const inQobuz = qobuzAlbumKeys.has(key);
    const inTidal = tidalAlbumKeys.has(key);
    if (inQobuz && inTidal) break;              // favourited in both — unknowable
    if (inQobuz) return "qobuz";
    if (inTidal) return "tidal";
  }
  return unclaimedIsLocal() ? "local" : null;
}

// Does a source badge tell the user anything? Only when the library could hold
// more than one source. With no streaming service connected, elimination makes
// EVERY album local (see unclaimedIsLocal), so the badge stops being a fact
// about an album and becomes decoration on every tile in the library — which is
// exactly what shipping v1.7.34 did.
//
// The Focus sheet is unaffected on purpose: there the count is the whole point,
// and "Local albums (2,234)" answers a question the user actually asked.
function sourceBadgesDistinguish() { return !unclaimedIsLocal(); }

// A sample rate as people say it: 44.1, 48, 96, 192. Trailing ".0" is noise on
// a badge two characters wide.
function rateShort(hz) {
  if (!hz) return null;
  const k = hz / 1000;
  return String(Number.isInteger(k) ? k : Math.round(k * 10) / 10);
}

// What an album IS, in Roon's own shorthand: "24/96", "16/44.1", or just the
// container for a lossy file where bit depth means nothing.
//
// Returns null when there is no local file to inspect — a streamed album has
// no format this extension can read, and inventing one would be worse than an
// empty badge.
function albumQualityLabel(f) {
  if (!f) return null;
  // Lossy first: MP3 and AAC report a bitsPerSample that describes the decoder,
  // not the recording, so "16/44.1" on an MP3 would claim CD quality.
  if (!f.lossless) return f.container || null;
  if (f.bits && f.rate) return f.bits + "/" + rateShort(f.rate);
  if (f.rate) return rateShort(f.rate) + " kHz";
  return f.container || null;
}
// Better than CD. Roon calls this hi-res and marks it; the badge tints rather
// than saying so in words, which would not fit.
//
// TIDAL states a TIER rather than numbers, so its hi-res albums arrive with no
// bit depth to compare — the tier's own label is the evidence.
function albumIsHiRes(f) {
  if (!f || !f.lossless) return false;
  if (f.container === "Hi-Res") return true;
  return !!((f.bits && f.bits > 16) || (f.rate && f.rate > 48000));
}

// Attach the derived per-album fields to a payload. One helper so every
// endpoint that returns albums reports them identically — and so a badge is
// omitted in one place rather than suppressed on each screen that draws one.
function withSource(a, rec) {
  a.source = sourceBadgesDistinguish() ? albumSource(a.title, a.subtitle, rec) : null;
  // Sample rate / bit depth, for the optional quality badge. Always sent: it is
  // a dozen bytes, it comes from a Map already in memory, and sending it
  // unconditionally means the Appearance toggle takes effect immediately
  // instead of after a reload. Absent when there is no local file.
  //
  // Keys resolved the same way albumSource does, because several callers
  // (the single-album lookup, the label browser, the Home rows) have only a
  // payload and no index record — and a badge that appears on the Library wall
  // but not on Home reads as a bug in the data, not in the plumbing.
  const f = albumFileFacts(a.title, a.subtitle, rec);
  const q = albumQualityLabel(f);
  if (q) { a.quality = q; if (albumIsHiRes(f)) a.hires = true; }
  return a;
}

// ---------------------------------------------------------------------------
// Release years harvested from data we already fetch.
//
// Roon's browse API exposes no release year at all (title, subtitle, image_key,
// item_key and nothing else), so every year here comes from somewhere else. The
// API passes that used to supply them are gated on an album LACKING A LABEL —
// so once an album's label was cached it could never acquire a year, and on an
// established install the year passes stopped running altogether. That, not any
// API limitation, is why the Decade focus only ever saw a fraction of a library.
//
// These three maps close that hole at zero API cost, because all three payloads
// are already being fetched for something else:
//   * the local file scan already reads tags for labels and the "local" badge;
//   * the Qobuz and TIDAL favourites pages already stream in for source badges,
//     and every album object in them carries its own release date.
//
// They are keyed in the SOURCE-BADGE key space (albumKey → canonText/canonArtist),
// NOT the year-cache key space, so the join below can use each album's existing
// srcKeys — the same tolerant identity matcher the badges use. Writing the
// service's own spelling straight into the year cache would only land when Roon
// and the service normalise identically, which is exactly the mismatch that
// already loses most of the file-tag years.
// First 4 digits of anything date-shaped ("1975", "1975-03-21", 1975).
function yearOfDate(v) {
  const y = String(v == null ? "" : v).trim().slice(0, 4);
  return /^\d{4}$/.test(y) ? y : null;
}

// Which of a file's date tags is the album's ORIGINAL release year, given
// music-metadata's `common` block.
//
// ORIGINALDATE first. music-metadata derives `common.year` from DATE, and on a
// remaster DATE is the REISSUE year — so preferring `year` (as this did) filed
// every remaster under the decade it was reissued in and only consulted
// ORIGINALDATE when there was no DATE at all, which is backwards. A tagger that
// sets ORIGINALDATE is telling us exactly what the Decade filter wants to know.
function fileTagYear(common) {
  if (!common) return null;
  return yearOfDate(common.originaldate) ||
         yearOfDate(common.year) ||
         yearOfDate(common.date);
}
// Record a harvested year under every identity the source can offer, mirroring
// addFavouriteKeys so the join keys line up with the badge keys exactly.
// The same join, for the format of an album this extension has no file for.
//
// Roon's library is local files plus streaming albums you added, and adding one
// favourites it in the service — which is why the favourites pages are already
// being fetched for the source badges. Those album objects state the bit depth
// and sample rate the service will stream, so cross-referencing them costs no
// extra request at all: it is the same response, read for one more field.
//
// Written straight through to the ranked store, so a local file still wins if
// the album turns out to exist on disk too.
function addHarvestedQuality(title, version, artists, facts, src) {
  if (!title || !facts) return 0;
  const titles = version ? [title, title + " " + version] : [title];
  let n = 0;
  for (const t of titles) {
    for (const artist of artists) {
      if (!artist) continue;
      const key = albumKey(t, artist);
      if (key && setAlbumFileFacts(key, facts, src)) n++;
    }
  }
  return n;
}

// What Qobuz says it will stream for this album. Exact numbers, not a tier —
// which is why Qobuz outranks TIDAL in formatSourceRank.
//
// No container: Qobuz serves FLAC for lossless and MP3 for its lowest tier, and
// the favourites payload doesn't say which you'd get. bits+rate is what the
// badge shows anyway, and claiming a container we weren't told would be a
// guess dressed as a fact.
function qobuzQualityOf(a) {
  const bits = parseInt(a.maximum_bit_depth, 10);
  // Qobuz reports kHz as a number (44.1, 96, 192); everything downstream works
  // in Hz.
  const khz  = parseFloat(a.maximum_sampling_rate);
  if (!Number.isFinite(bits) || !Number.isFinite(khz) || bits <= 0 || khz <= 0) return null;
  return { container: null, bits, rate: Math.round(khz * 1000), chan: null, lossless: true };
}

// What TIDAL says about an album — a quality TIER, not a rate.
//
// TIDAL publishes "LOSSLESS" / "HI_RES_LOSSLESS" / "HIGH" / "LOW" rather than a
// bit depth and sample rate, and its hi-res spans 24/44.1 to 24/192. Turning a
// tier into "24/96" would be inventing two numbers, so the badge carries the
// tier's own name instead. That is why formatSourceRank puts TIDAL below Qobuz:
// if both know an album, the one with real numbers wins.
function tidalQualityOf(a) {
  const tags = (a.mediaMetadata && Array.isArray(a.mediaMetadata.tags))
    ? a.mediaMetadata.tags.map(String) : [];
  const tier = String(a.audioQuality || "").toUpperCase();
  const hi = tier === "HI_RES_LOSSLESS" || tier === "HI_RES" ||
             tags.includes("HIRES_LOSSLESS");
  if (hi) return { container: "Hi-Res", bits: null, rate: null, chan: null, lossless: true };
  if (tier === "LOSSLESS" || tags.includes("LOSSLESS")) {
    return { container: "Lossless", bits: null, rate: null, chan: null, lossless: true };
  }
  // HIGH and LOW are TIDAL's lossy tiers. Reported as AAC, which is what they
  // are, rather than as a bit depth the format does not have.
  if (tier === "HIGH" || tier === "LOW") {
    return { container: "AAC", bits: null, rate: null, chan: null, lossless: false };
  }
  return null;
}

function addHarvestedYear(map, title, version, artists, year) {
  const y = yearOfDate(year);
  if (!y || !title) return;
  const titles = version ? [title, title + " " + version] : [title];
  for (const t of titles) {
    for (const artist of artists) {
      if (!artist) continue;
      const key = albumKey(t, artist);
      // First writer wins: the earliest page of favourites is as good a source
      // as any, and this keeps the map stable across re-runs.
      if (key && !map.has(key)) map.set(key, y);
    }
  }
}

// Join the harvested years onto the library snapshot. Runs after the index is
// built and after every favourites refresh; cheap enough to be unconditional
// (one Map lookup per album per identity, no I/O beyond the SQLite writes for
// years that are genuinely new).
//
// Only fills GAPS — an album that already has a year keeps it, so a service's
// reissue date can never overwrite a year read from the user's own file tags.
function harvestAlbumYears(reason) {
  if (!albumIndex.albums.length) return 0;      // nothing to join onto yet
  // Each map carries its provenance, so setAlbumYear can let a better source
  // correct a worse one. Best first: a user's own tags describe the copy they
  // actually own, Qobuz names an explicit ORIGINAL release date, and TIDAL only
  // offers this edition's date (a remaster's date on a remaster).
  const sources = [
    { map: fileAlbumYears,  src: "file" },
    { map: qobuzAlbumYears, src: "release" },
    { map: tidalAlbumYears, src: "edition" },
  ];
  if (!sources.some(s => s.map.size)) return 0;
  let added = 0;
  const run = () => {
    for (const al of albumIndex.albums) {
      const ykey = al.nTitle + "||" + al.nArtist;   // the key albumYearOf reads
      let found = null, foundSrc = null;
      for (const key of (al.srcKeys || [])) {
        // Same suppression withSource applies: an identity shared by two library
        // albums can't be resolved to one of them, so don't guess a year either.
        if (ambiguousAlbumKeys.has(key)) continue;
        for (const s of sources) {
          const y = s.map.get(key);
          if (y) { found = y; foundSrc = s.src; break; }
        }
        if (found) break;
      }
      // deferBump: one cache invalidation at the end, not one per album.
      // setAlbumYear decides whether this source is allowed to write — it fills
      // a gap, or corrects a year from a source that ranks lower.
      if (found && setAlbumYear(ykey, found, { src: foundSrc, deferBump: true })) added++;
    }
  };
  // One transaction for the whole join, matching how the other bulk loads here
  // write. The first run on a large library fills thousands of rows, and
  // unwrapped that is one implicit transaction — and one fsync — per album.
  try {
    if (labelsDb) labelsDb.transaction(run)(); else run();
  } catch (e) {
    // A SQLite failure rolls the rows back but leaves albumYearCache holding
    // whatever was written, so the bump below still has to happen. Swallowed
    // rather than rethrown because every caller is mid-sync: an exception here
    // used to abort buildAlbumIndex's post-processing and silently stop the
    // Qobuz/TIDAL badge refresh for that sync.
    console.error("[years] harvest failed (" + reason + "):", e.message);
  }
  if (added) {
    bumpLibraryMeta();
    console.log("[years] harvested " + added + " release years (" + reason + "); " +
                albumYearCache.size + " known");
  }
  return added;
}

// Identities held by more than one library album (duplicate rips, a local copy
// alongside a streaming copy Roon didn't group). Any badge on those would be a
// coin flip, so they're suppressed. Rebuilt with the snapshot.
let ambiguousAlbumKeys = new Set();
// "First seen" dates for albums that appeared between two rebuilds.
//
// The hard part is the FIRST run: an established library would otherwise be
// stamped with one identical timestamp for every album, which is not a date —
// it is the moment this feature was installed, wearing a date's clothes. So the
// first run records nothing at all and leaves those albums undated, and only
// albums that turn up in a LATER rebuild get a real first-seen. Accuracy
// accrues going forward; it cannot be back-filled, and pretending otherwise
// would make the sort confidently wrong rather than honestly incomplete.
function recordFirstSeenAlbums() {
  const baseline = albumSeenCache.size === 0;
  let n = 0;
  for (const al of albumIndex.albums) {
    const keys = al.srcKeys || [];
    if (!keys.length) continue;
    if (keys.some(k => albumSeenCache.has(k))) continue;
    if (baseline) continue;   // nothing to compare against — see above
    if (setAlbumSeen(keys[0], Date.now(), "first-seen")) n++;
  }
  if (n) {
    bumpLibraryMeta();
    console.log("[seen] " + n + " albums newly seen in this rebuild");
  } else if (baseline) {
    console.log("[seen] first run — existing albums left undated, " +
                "new ones will be dated from here");
  }
}

function rebuildAmbiguousAlbumKeys() {
  const seen = new Map();
  const dupes = new Set();
  for (const al of albumIndex.albums) {
    for (const key of (al.srcKeys || [])) {
      const owner = seen.get(key);
      if (owner === undefined) seen.set(key, al.offset);
      else if (owner !== al.offset) dupes.add(key);
    }
  }
  ambiguousAlbumKeys = dupes;
  if (dupes.size) console.log("[source] " + dupes.size + " ambiguous album identities — badges suppressed for those");
}

// Build a map of albumKey → label from audio file tags.
// Expects Artist/Album/track.flac layout — reads one file per album directory.
async function buildFileLabelMap(onProgress) {
  const map = new Map();
  const bandcampMap = new Map(); // albumKey → Bandcamp album page URL (from COMMENT tag)
  // Every album seen on disk, keyed the same way as the maps above — this is
  // the evidence behind the "local files" badge. Collected for EVERY album
  // directory (not just ones that yielded a label), since presence on disk is
  // the whole question.
  const localKeys = new Set();
  // Built LOCALLY and published at the end, never cleared in place. This walk
  // takes minutes, while the Qobuz/TIDAL favourites come back in seconds — and
  // harvestAlbumYears fills gaps only, so whichever source lands first used to
  // win permanently. Blanking the shared map at the start of the walk handed
  // the services an open goal on every rescan: they would fill in the years the
  // last file scan had found, and the freshly-read tags would arrive to find
  // every album already dated. (Source precedence in setAlbumYear is the real
  // guard; this keeps the map itself from ever being observed half-built.)
  const fileYears = new Map();
  let yearsWritten = 0;
  let formatWrites = 0;
  if (!musicDirMounted()) return { labelMap: map, bandcampMap, localKeys };
  let mm;
  try { mm = await import("music-metadata"); } catch (e) {
    if (DEBUG) console.error("[labels:files] music-metadata not available:", e.message);
    return { labelMap: map, bandcampMap, localKeys };
  }
  const parseFile = mm.parseFile || (mm.default && mm.default.parseFile);
  if (!parseFile) {
    if (DEBUG) console.error("[labels:files] music-metadata loaded but parseFile not found");
    return { labelMap: map, bandcampMap, localKeys };
  }

  const AUDIO_RE = /\.(flac|mp3|m4a|aac|ogg|opus|wv|ape|wav|aiff?)$/i;

  // Recursively scan directories up to MAX_DEPTH levels deep.
  // When audio files are found in a directory, read tags from the first one.
  // Match is keyed on tag values (common.album + common.albumartist) so
  // directory naming convention (Artist/Album vs flat Artist - Album) doesn't matter.
  // 5, not 3: /music/Artist/Album/CD1 fits in 3, but /music/Genre/Artist/Album/Disc 1
  // does not, and a subtree past the limit is skipped WHOLE and silently — the
  // albums in it simply never count as local.
  const MAX_DEPTH = 5;
  let _fsProcessed = 0;
  // Diagnostics for the one question the old summary could not answer: when the
  // local count is short, is it because the walk never SAW those albums, or
  // because it saw them and the keys didn't match? Counting is free and the
  // difference decides which half of the code to look at.
  const walk = { dirs: 0, tooDeep: 0, unreadable: 0, withAudio: 0, parsed: 0,
                 parseFailed: 0, keyed: 0, noAlbumTag: 0 };
  // album key → earliest file mtime seen for it. Published after the walk, the
  // same way the label and year maps are, so a partial walk never lands.
  const fileSeen = new Map();
  async function scanDir(dirPath, depth) {
    if (depth > MAX_DEPTH) { walk.tooDeep++; return; }
    walk.dirs++;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { walk.unreadable++; return; /* permission denied or dir vanished mid-scan */ }

    const audioFile = entries.find(e => e.isFile() && AUDIO_RE.test(e.name));
    if (audioFile) {
      walk.withAudio++;
      _fsProcessed++;
      if (onProgress && _fsProcessed % 50 === 0) onProgress(_fsProcessed);
      try {
        const meta = await parseFile(path.join(dirPath, audioFile.name), { duration: false, skipCovers: true });
        let label = (meta.common.label && meta.common.label[0]) || meta.common.organization || null;
        // Label-folder organisation: take the label from the folder at the
        // configured depth under the music root, overriding the per-file tag
        // (which is often the granular pressing/reissue label, not the parent
        // label the user files under). Opt-in; 0 = use the tag (default).
        if (labelFolderDepth > 0) {
          const rel = path.relative(MUSIC_DIR, dirPath).split(path.sep).filter(Boolean);
          const folderLabel = rel[labelFolderDepth - 1];
          if (folderLabel) label = folderLabel;
        }
        walk.parsed++;
        // The file's own timestamp — the closest thing to "when did this album
        // arrive" that exists anywhere. It is when the FILE landed on this
        // disk, not when Roon imported it, which is why it is ranked evidence
        // rather than treated as fact.
        let fileMtime = 0;
        try { fileMtime = fs.statSync(path.join(dirPath, audioFile.name)).mtimeMs || 0; }
        catch (e) { /* stat can fail where the read succeeded; simply no date */ }
        const album = meta.common.album;
        if (!album) walk.noAlbumTag++;
        const albumartist = meta.common.albumartist
          || (meta.common.artists && meta.common.artists[0])
          || meta.common.artist || null;
        // Record every on-disk album under both credit spellings — Roon's
        // album-artist can match either the ALBUMARTIST or the ARTIST tag, and
        // a miss here just means a missing badge, never a wrong one.
        if (album) {
          // albumKeys, not albumKey: the library index stores albumKeys() for
          // every album, which enumerates the whole credit AND each name in it.
          // Keying the file side on the whole credit only made the match
          // one-directional — a tag reading "Robert Plant & Alison Krauss"
          // could never meet a Roon credit of "Robert Plant", while the reverse
          // matched fine. That asymmetry is invisible except as a local count
          // that is quietly too low.
          for (const k of albumKeys(album, albumartist || "")) localKeys.add(k);
          // Also key by the track artist — Roon's album credit sometimes matches
          // that instead. NOT for compilations: one sampled track would claim a
          // various-artists disc for whichever performer happened to be first,
          // and could then badge an unrelated streaming album as local.
          const isCompilation = /various|soundtrack|ost\b/i.test(albumartist || "") ||
                                meta.common.compilation === true;
          if (meta.common.artist && !isCompilation) {
            for (const k of albumKeys(album, meta.common.artist)) localKeys.add(k);
          }
          // A compilation whose ALBUMARTIST tag is missing gets the first
          // track's performer instead, which never matches Roon's "Various
          // Artists". The title still has to match, so this cannot badge an
          // unrelated album.
          if (isCompilation || meta.common.compilation === true) {
            const kv = albumKey(album, "Various Artists");
            if (kv) localKeys.add(kv);
          }
          walk.keyed++;
          if (fileMtime > 0) {
            for (const k of albumKeys(album, albumartist || "")) {
              fileSeen.set(k, Math.min(fileSeen.get(k) || Infinity, fileMtime));
            }
          }
          // What this album actually IS on disk. music-metadata has already
          // parsed all of it as part of the read above, so these four facets
          // cost nothing beyond the assignment — the `format` block was simply
          // never looked at before.
          const fmt = meta.format || {};
          if (fmt.container || fmt.sampleRate) {
            const facts = {
              container: fmt.container ? String(fmt.container).toUpperCase() : null,
              bits: Number.isFinite(fmt.bitsPerSample) ? fmt.bitsPerSample : null,
              rate: Number.isFinite(fmt.sampleRate) ? fmt.sampleRate : null,
              chan: Number.isFinite(fmt.numberOfChannels) ? fmt.numberOfChannels : null,
              lossless: !!fmt.lossless
            };
            // Written under the same key space the badges match on, so the
            // facet reaches the album through its srcKeys even when Roon's
            // title and the file's tags disagree about the album's name.
            for (const k of albumKeys(album, albumartist || "")) {
              if (setAlbumFileFacts(k, facts, "file")) formatWrites++;
            }
          }
        }
        if (label && !isLikelyNotALabel(label) && album) {
          const key = normalize(album) + "||" + normalize(albumartist || "");
          if (!map.has(key)) map.set(key, label);
        }
        // Capture the release year from file tags too (powers the Decade filter).
        const fyear = fileTagYear(meta.common);
        if (album && fyear) {
          // Direct write under the TAG-derived key. Kept because it costs
          // nothing and lands immediately whenever the tags and Roon agree.
          const ykey = normalize(album) + "||" + normalize(albumartist || "");
          if (setAlbumYear(ykey, fyear, { src: "file", deferBump: true })) yearsWritten++;
          // ...and again in the badge key space, so harvestAlbumYears can reach
          // it through the album's srcKeys when they DON'T agree. Roon renames
          // albums ("(Deluxe Edition)"), reads a different album artist, and
          // credits collaborations its own way — every one of those used to
          // strand a perfectly good file-tag year under a key nothing looks up.
          // These mirror the keys the "local files" badge matches on, with one
          // exception: the badge also keys an album with NO artist tag at all,
          // which is too weak an identity to hang a year on.
          addHarvestedYear(fileYears, album, null, [albumartist || ""], fyear);
          const isComp = /various|soundtrack|ost\b/i.test(albumartist || "") ||
                         meta.common.compilation === true;
          if (meta.common.artist && !isComp) {
            addHarvestedYear(fileYears, album, null, [meta.common.artist], fyear);
          }
        }
        // Extract Bandcamp album page URL from COMMENT tags (embedded by Bandcamp downloader).
        // Scan all comment entries — the URL may not be in slot 0 if other tags share the field.
        if (album) {
          const comments = meta.common.comment || [];
          for (const c of comments) {
            const text = typeof c === "string" ? c : (c && c.text ? c.text : "");
            // Require /album/ path to avoid artist pages or bare domain mentions.
            const bcMatch = text.match(/https?:\/\/[a-z0-9-]+\.bandcamp\.com\/album\/[a-z0-9_%-]+/i);
            if (bcMatch) {
              const bcKey = normalize(album) + "||" + normalize(albumartist || "");
              if (!bandcampMap.has(bcKey)) bandcampMap.set(bcKey, bcMatch[0]);
              break;
            }
          }
        }
      } catch (e) {
        // Unreadable or untagged. Counted, because a directory whose FIRST
        // audio file won't parse is dropped whole — no second file is tried —
        // and that is invisible unless someone counts it.
        walk.parseFailed++;
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) await scanDir(path.join(dirPath, entry.name), depth + 1);
    }
  }

  try {
    await scanDir(MUSIC_DIR, 0);
  } catch (e) {
    if (DEBUG) console.error("[labels:files] scan error:", e.message);
  }
  if (DEBUG) console.log("[labels:files] file scan found", map.size, "labels,", bandcampMap.size,
                         "Bandcamp URLs,", fileYears.size, "dated identities");
  // Unconditional: this is the line that says whether a short local count is a
  // walk problem or a match problem, and it is useless if it only appears when
  // someone happened to have debug on.
  console.log("[local:walk] " + walk.dirs + " dirs visited, " + walk.withAudio +
              " with audio, " + walk.parsed + " tags read, " + walk.keyed + " albums keyed" +
              (walk.tooDeep     ? ", " + walk.tooDeep + " SKIPPED past depth " + MAX_DEPTH : "") +
              (walk.unreadable  ? ", " + walk.unreadable + " unreadable" : "") +
              (walk.parseFailed ? ", " + walk.parseFailed + " tag reads failed" : "") +
              (walk.noAlbumTag  ? ", " + walk.noAlbumTag + " had no album tag" : ""));
  // Publish in one assignment, so the join never sees a partial walk.
  fileAlbumYears = fileYears;
  let seenWrites = 0;
  for (const [k, ts] of fileSeen) if (setAlbumSeen(k, ts, "file")) seenWrites++;
  if (seenWrites) {
    bumpLibraryMeta();   // the Recently added ordering just changed
    console.log("[seen] " + seenWrites + " albums dated from file timestamps");
  }
  if (formatWrites) {
    bumpLibraryMeta();   // the Format/Sample rate/Bit depth facets just gained values
    console.log("[format] " + albumFileCache.size + " album identities carry file format");
  }
  // The direct tag-key writes above all deferred their bump, and the only other
  // flush is harvestAlbumYears' `if (added)` — which counts ONLY the albums the
  // srcKeys join filled. A well-tagged library whose tags agree with Roon lands
  // every year through the direct write, leaving added === 0 and no
  // invalidation at all: the Library would keep serving a memoised ordering in
  // which thousands of albums are still undated, while the Focus sheet
  // simultaneously reported them as dated.
  if (yearsWritten) bumpLibraryMeta();
  return { labelMap: map, bandcampMap, localKeys };
}

// ---------------------------------------------------------------------------
// Background scan — multi-pass label lookup pipeline.
// Pass 0: File metadata (if /music mounted) — most authoritative.
// Pass 1: iTunes (3 concurrent, 500ms between batches, abort on 429/403).
// Pass Q: Qobuz (streaming-only libraries, i.e. no /music mount) — the user's
//         actual source, so it resolves most iTunes-misses in one pass and
//         keeps them out of the slow TADB→MB→Discogs cascade.
// Pass 2: TheAudioDB (serial, 1 req/sec).
// Pass 3: MusicBrainz (serial, rate-limited) — broad coverage.
// Pass 4: Discogs (serial, rate-limited) — last resort.
// Results saved to SQLite — scan only needs to run once per album.
// Errors are logged to data/labels-scan.log. On excessive errors in a pass
// the scan finishes early; the next 12-hour auto-rescan will retry.
// ---------------------------------------------------------------------------
// The /music tag walk, on its own.
//
// This is NOT label work, and keeping it inside runLabelsIndexScan was the
// reason "Labels off" still looked like label scanning: it entered a function
// named for labels, flipped labelsIndex.building, seeded the label map and
// wrote "[labels] …" into the labels scan log.
//
// What this pass actually produces, and what breaks if it stops:
//   release years          -> the Decade filter
//   local album keys       -> the "local files" badge
//   container/bits/rate/
//     channels/lossless    -> the Format, Sample rate, Bit depth and Channels
//                             filters
//   label names from tags  -> handed to the label scan, but only when it runs
//
// So it runs whether or not Labels is switched on. Its label output is simply
// kept for whoever wants it, and nothing consumes it while Labels is off.
// What the last walk produced, kept for the label scan to consume when it
// runs. Both were locals of the combined function before the split, and the
// Bandcamp pass still reads the second — leaving it behind was a ReferenceError
// that the scan's own catch would have swallowed into "scan aborted by
// unexpected error", killing every pass after it on a /music library.
let _lastFileLabelMap = null;
let _lastFileBandcampMap = null;
let _fileScanRunning = false;

async function runFileMetadataScan(reason) {
  if (_fileScanRunning) return;
  if (!musicDirMounted()) return;    // nothing to walk
  if (albumIndex.count === 0) return;
  _fileScanRunning = true;
  try {
    const estimate = albumIndex.albums.length || 1000;
    const { labelMap, bandcampMap, localKeys } = await buildFileLabelMap((n) => {
      labelsIndex.progress = Math.min(0.15, n / estimate);
    });
    _lastFileLabelMap = labelMap || new Map();
    _lastFileBandcampMap = bandcampMap || new Map();
    // Only replace the known-local set when the scan actually saw the mount —
    // an unmounted /music must not wipe badges earned by a previous scan.
    if (localKeys && localKeys.size) setLocalAlbumKeys(localKeys);
    // The walk just re-read every album's tags, so join its years on now.
    harvestAlbumYears("file tags");
    console.log("[files] tag scan complete (" + (reason || "scheduled") + ")");
  } catch (e) {
    console.error("[files] tag scan failed: " + e.message);
  } finally {
    _fileScanRunning = false;
  }
}

async function runLabelsIndexScan(force) {
  // At the very top, before any label state is touched, any label log line is
  // written, and any cache is seeded. Off means this function does nothing at
  // all — not "does the harmless half".
  if (!labelsEnabled) return;
  if (labelsIndex.building) return;
  // Never scan while Roon is importing — offsets are still moving and it piles
  // external fetches onto the churn. `force` (an explicit user "Rescan") skips
  // the check; automatic triggers (12h timer, lazy ensure, post-save) defer and
  // resume on the next natural trigger once Roon settles.
  if (!force && await libraryIsImporting()) {
    appendLabelsLog("[labels] scan deferred — Roon library is importing");
    return;
  }
  if (albumIndex.count === 0) {
    if (albumIndex.building) { try { await albumIndex.building; } catch (e) { /* albumIndex build failed — safe to continue; the count===0 check below will abort */ } }
    if (albumIndex.count === 0) return;
  }
  labelsIndex.building = true;
  labelsIndex.progress = 0;

  try {

  seedLabelsFromCache();

  // The tag walk has already run (runFileMetadataScan, above this call). Its
  // label names are handed over here so the cascade below only has to chase
  // what the files could not answer.
  const fileLabelMap = _lastFileLabelMap || new Map();
  const bandcampMap  = _lastFileBandcampMap || new Map();

  if (fileLabelMap.size) {
    let overrideCount = 0;
    for (const [key, fileLabel] of fileLabelMap) {
      const cached = labelDiskCache.get(key);
      if (cached && labelGroupKey(cached) !== labelGroupKey(fileLabel)) {
        setLabelName(key, fileLabel);
        overrideCount++;
      }
    }
    if (overrideCount) {
      rebuildLabelsMap();
      appendLabelsLog("[labels:files] corrected " + overrideCount + " stale cache entries from file tags");
      if (DEBUG) console.log("[labels:files] corrected", overrideCount, "stale cache entries from file tags");
    }
  }

  const toScan = albumIndex.albums.filter(al => {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    return !labelsOverride.has(key) && !labelDiskCache.has(key);
  });

  if (!toScan.length) {
    labelsIndex.building = false;
    labelsIndex.builtAt = Date.now();
    saveLastScanTime();
    const msg = "[labels] scan: all albums already cached (" + labelsIndex.count + " labels)";
    if (DEBUG) console.log(msg);
    appendLabelsLog(msg);
    return;
  }

  const alreadyDone = albumIndex.albums.length - toScan.length;
  const total = albumIndex.albums.length;
  const scanCount = toScan.length;
  // Progress helper — weights each pass so bar moves throughout the full scan.
  // Passes 0+1 (files+iTunes) share 20%; TADB 30%; MB 30%; Discogs 20%.
  // basePct = fraction of library already cached.
  // Within each pass: interpolate between the pass start and end percentages.
  const basePct = total > 0 ? alreadyDone / total : 0;
  const scanPct = 1 - basePct; // fraction of bar dedicated to this scan
  // Streaming-only libraries (no /music mount) get an extra Qobuz pass between
  // iTunes and TheAudioDB. Qobuz is the user's actual source, so it resolves
  // most iTunes-misses in one pass instead of walking the slow serial
  // TADB→MB→Discogs cascade. The pass-index map and band weights shift to give
  // the Qobuz pass its own slice of the progress bar.
  const streamingOnly = !musicDirMounted();
  const PASS = streamingOnly
    ? { files: 0, itunes: 1, qobuz: 2, tadb: 3, mb: 4, discogs: 5 }
    : { files: 0, itunes: 1, bandcamp: 2, tadb: 3, mb: 4, discogs: 5 };
  // cumulative pass weights (fraction of the scan portion of the bar).
  const PASS_ENDS = streamingOnly
    ? [0.05, 0.15, 0.45, 0.60, 0.85, 1.00] // files, iTunes, Qobuz, TADB, MB, Discogs
    : [0.10, 0.20, 0.30, 0.55, 0.80, 1.00]; // files, iTunes, Bandcamp, TADB, MB, Discogs
  function passProgress(passIdx, pos, passTotal) {
    const start = passIdx > 0 ? PASS_ENDS[passIdx - 1] : 0;
    const end = PASS_ENDS[passIdx];
    const frac = passTotal > 0 ? pos / passTotal : 1;
    return Math.min(1, basePct + scanPct * (start + (end - start) * frac));
  }
  let done = 0;

  const startMsg = "[labels] scan started: " + toScan.length + " albums to look up (" + alreadyDone + " already cached)";
  console.log(startMsg);
  appendLabelsLog(startMsg);

  const saveLabelEntry = async (key, label, knownMbid, al) => {
    if (isLikelyNotALabel(label)) return;
    setLabelName(key, label);
    labelsIndexAddAlbum(label, al);
    const gk = labelGroupKey(label);
    if (gk && !labelMbidCache.has(gk)) {
      const resolvedMbid = knownMbid || await fetchLabelMbidFromMusicBrainz(label);
      if (resolvedMbid) {
        setLabelMbid(gk, resolvedMbid);
        const entry = labelsIndex.map.get(gk);
        if (entry && !entry.mbid) entry.mbid = resolvedMbid;
      } else {
        // Cache null so we don't re-query MusicBrainz for this label every scan.
        // Not persisted to DB — retried on container restart.
        labelMbidCache.set(gk, null);
      }
    }
  };

  // Fill in file labels for uncached albums using the map already built above.
  const needsApiScan = [];
  for (const al of toScan) {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    const fileLabel = fileLabelMap.get(key);
    if (fileLabel) {
      await saveLabelEntry(key, fileLabel, null, al);
      done++;
      labelsIndex.progress = passProgress(PASS.files, done, scanCount);
    } else {
      needsApiScan.push(al);
    }
  }
  if (fileLabelMap.size) {
    const fileMsg = "[labels] pass 0 (files): " + fileLabelMap.size + " found in tags, " + needsApiScan.length + " still need API";
    if (DEBUG) console.log(fileMsg);
    appendLabelsLog(fileMsg);
  }

  // Pass 0B: Bandcamp — local library only (requires /music mount for COMMENT tag extraction).
  // Fetches album pages for purchases where the downloader embedded a bandcamp.com URL in tags.
  // Serial with 1.5 s between requests; circuit breaker at 5 consecutive errors or any 429/403.
  const needsItunes = [];
  if (!streamingOnly && bandcampMap.size) {
    const bcQueue = [], bcSkip = [];
    for (const al of needsApiScan) {
      (bandcampMap.has(normalize(al.title) + "||" + normalize(al.subtitle)) ? bcQueue : bcSkip).push(al);
    }
    needsItunes.push(...bcSkip);
    if (bcQueue.length) {
      const bcStartMsg = "[labels] pass 0B (Bandcamp): " + bcQueue.length + " albums with embedded URLs";
      if (DEBUG) console.log(bcStartMsg);
      appendLabelsLog(bcStartMsg);
      let bcErrors = 0, bcConsec = 0, bcAborted = false;
      let bcResolved = 0;
      const bcDeadline = Date.now() + 5 * 60 * 1000;
      for (let bi = 0; bi < bcQueue.length; bi++) {
        if (bcAborted) { needsItunes.push(...bcQueue.slice(bi)); break; }
        const al = bcQueue[bi];
        const key = normalize(al.title) + "||" + normalize(al.subtitle);
        const url = bandcampMap.get(key);
        try {
          await bandcampWait();
          const result = await fetchLabelFromBandcamp(url, al.subtitle);
          if (result && result.label && !isLikelyNotALabel(result.label)) {
            await saveLabelEntry(key, result.label, null, al);
            if (result.year) setAlbumYear(key, result.year, { src: "release" });
            bcResolved++;
            bcConsec = 0;
          } else {
            if (result && result.year) setAlbumYear(key, result.year, { src: "release" });
            needsItunes.push(al);
            bcConsec = 0;
          }
        } catch (e) {
          bcErrors++;
          bcConsec++;
          needsItunes.push(al);
          appendLabelsLog("[labels:bandcamp] error for \"" + al.title + "\": " + e.message);
          if (e.message && (e.message.includes("429") || e.message.includes("403"))) {
            bcAborted = true;
            appendLabelsLog("[labels:bandcamp] rate limited — aborting Bandcamp pass");
          } else if (bcConsec >= 5) {
            bcAborted = true;
            appendLabelsLog("[labels:bandcamp] 5 consecutive errors — aborting Bandcamp pass");
          }
        }
        labelsIndex.progress = passProgress(PASS.bandcamp, bi + 1, bcQueue.length);
        if (!bcAborted && Date.now() > bcDeadline) {
          bcAborted = true;
          needsItunes.push(...bcQueue.slice(bi + 1));
          appendLabelsLog("[labels:bandcamp] 5-minute time limit reached — remainder forwarded to iTunes");
          break;
        }
      }
      const bcMsg = "[labels] pass 0B (Bandcamp): complete, " + bcResolved + " resolved, " +
        needsItunes.length + " forwarded to iTunes" +
        (bcAborted ? " (aborted)" : "") + (bcErrors ? ", " + bcErrors + " errors total" : "");
      if (DEBUG) console.log(bcMsg);
      appendLabelsLog(bcMsg);
    }
  } else {
    needsItunes.push(...needsApiScan);
  }

  // Pass 1: iTunes — 3 concurrent, 500ms between batches.
  // Aborts the entire pass on first 429/403 to avoid getting IP-blocked.
  const needsAudioDB = [];
  const ITUNES_BATCH = 3;
  let itunesAborted = false;
  let itunesErrors = 0;
  const itunesCheck = async (al) => {
    if (itunesAborted) { needsAudioDB.push(al); return; }
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    try {
      const label = await fetchLabelFromiTunes(al.title, al.subtitle);
      if (label === ITUNES_BLOCKED) {
        itunesAborted = true;
        const msg = "[labels] pass 1 (iTunes): rate-limited (429/403) — aborting iTunes pass, will retry next scan window";
        console.log(msg);
        appendLabelsLog(msg);
        needsAudioDB.push(al);
      } else if (label && !isLikelyNotALabel(label)) { await saveLabelEntry(key, label, null, al); }
      else { needsAudioDB.push(al); }
    } catch (e) {
      itunesErrors++;
      appendLabelsLog("[labels:itunes] error for \"" + al.title + "\": " + e.message);
      needsAudioDB.push(al);
    }
    done++;
    labelsIndex.progress = passProgress(PASS.itunes, done, scanCount);
  };
  for (let i = 0; i < needsItunes.length; i += ITUNES_BATCH) {
    if (itunesAborted) { needsAudioDB.push(...needsItunes.slice(i)); break; }
    await itunesBatchWait();
    await Promise.allSettled(needsItunes.slice(i, i + ITUNES_BATCH).map(itunesCheck));
  }
  if (needsItunes.length) {
    const itunesMsg = "[labels] pass 1 (iTunes): done, " + needsAudioDB.length + " forwarded to next pass" +
      (itunesAborted ? " (aborted — rate limited)" : "") +
      (itunesErrors ? ", " + itunesErrors + " errors" : "");
    if (DEBUG) console.log(itunesMsg);
    appendLabelsLog(itunesMsg);
  }

  // Pass Q (Qobuz) — streaming-only libraries only (no /music mount).
  // Qobuz is the user's actual streaming source, so it resolves most albums
  // iTunes missed in a single pass; every hit here skips the slow serial
  // TADB→MB→Discogs cascade. Serial (700ms/req, two requests per album) with
  // the same 10-consecutive-error circuit breaker as the other network passes.
  // fetchQobuz already persists labels to labelDiskCache/labelsIndex; routing
  // hits through saveLabelEntry additionally resolves the label MBID for logos.
  let needsTadb = needsAudioDB;
  if (streamingOnly && needsAudioDB.length) {
    needsTadb = [];
    const qStartMsg = "[labels] pass Q (Qobuz, streaming-only): " + needsAudioDB.length + " albums";
    if (DEBUG) console.log(qStartMsg);
    appendLabelsLog(qStartMsg);
    let qobuzErrors = 0;
    let qobuzConsec = 0;
    let qobuzAborted = false;
    for (let qi = 0; qi < needsAudioDB.length; qi++) {
      if (qobuzAborted) {
        needsTadb.push(...needsAudioDB.slice(qi));
        labelsIndex.progress = passProgress(PASS.qobuz, needsAudioDB.length, needsAudioDB.length);
        break;
      }
      const al = needsAudioDB[qi];
      const key = normalize(al.title) + "||" + normalize(al.subtitle);
      try {
        const q = await fetchQobuz(al.title, al.subtitle);
        if (q && q.year) setAlbumYear(key, q.year, { src: "release" });
        if (q && q.label && !isLikelyNotALabel(q.label)) { await saveLabelEntry(key, q.label, null, al); qobuzConsec = 0; }
        else { needsTadb.push(al); qobuzConsec = 0; }
      } catch (e) {
        qobuzErrors++;
        qobuzConsec++;
        needsTadb.push(al);
        appendLabelsLog("[labels:qobuz] error for \"" + al.title + "\": " + e.message);
        if (qobuzConsec >= 10) {
          qobuzAborted = true;
          const msg = "[labels] pass Q (Qobuz): " + qobuzConsec + " consecutive errors — aborting, will retry next scan window";
          console.log(msg);
          appendLabelsLog(msg);
        }
      }
      labelsIndex.progress = passProgress(PASS.qobuz, qi + 1, needsAudioDB.length);
      if ((qi + 1) % 100 === 0) {
        appendLabelsLog("[labels] pass Q (Qobuz): " + (qi + 1) + "/" + needsAudioDB.length + " done so far");
      }
    }
    const qMsg = "[labels] pass Q (Qobuz): complete, " + needsTadb.length + " forwarded to TheAudioDB" +
      (qobuzAborted ? " (aborted — consecutive errors)" : "") +
      (qobuzErrors ? ", " + qobuzErrors + " errors total" : "");
    if (DEBUG) console.log(qMsg);
    appendLabelsLog(qMsg);
  }

  // Pass 2: TheAudioDB — serial (1 req/sec rate limit on the free API).
  // Circuit breaker: 10 consecutive errors → abort pass, wait for next scan window.
  if (needsTadb.length) {
    const tadbStartMsg = "[labels] pass 2 (TheAudioDB): " + needsTadb.length + " albums";
    if (DEBUG) console.log(tadbStartMsg);
    appendLabelsLog(tadbStartMsg);
  }
  const needsMB = [];
  let tadbErrors = 0;
  let tadbConsec = 0;
  let tadbAborted = false;
  for (let ti = 0; ti < needsTadb.length; ti++) {
    if (tadbAborted) {
      needsMB.push(...needsTadb.slice(ti));
      labelsIndex.progress = passProgress(PASS.tadb, needsTadb.length, needsTadb.length);
      break;
    }
    const al = needsTadb[ti];
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    try {
      const label = await fetchLabelFromTheAudioDB(al.title, al.subtitle);
      if (label) { await saveLabelEntry(key, label, null, al); tadbConsec = 0; }
      else { needsMB.push(al); tadbConsec = 0; }
    } catch (e) {
      tadbErrors++;
      tadbConsec++;
      needsMB.push(al);
      if (tadbConsec >= 10) {
        tadbAborted = true;
        const msg = "[labels] pass 2 (TheAudioDB): " + tadbConsec + " consecutive errors — aborting, will retry next scan window";
        console.log(msg);
        appendLabelsLog(msg);
      }
    }
    labelsIndex.progress = passProgress(PASS.tadb, ti + 1, needsTadb.length);
    if ((ti + 1) % 100 === 0) {
      appendLabelsLog("[labels] pass 2 (TheAudioDB): " + (ti + 1) + "/" + needsTadb.length + " done so far");
    }
  }
  if (needsTadb.length) {
    const tadbMsg = "[labels] pass 2 (TheAudioDB): complete, " + needsMB.length + " forwarded to MB" +
      (tadbAborted ? " (aborted — consecutive errors)" : "") +
      (tadbErrors ? ", " + tadbErrors + " errors total" : "");
    if (DEBUG) console.log(tadbMsg);
    appendLabelsLog(tadbMsg);
  }

  // Pass 3: MusicBrainz for remaining misses — serial to respect rate limit.
  // Circuit breaker: 10 consecutive errors → abort pass.
  if (needsMB.length) {
    const mbStartMsg = "[labels] pass 3 (MusicBrainz): " + needsMB.length + " albums";
    if (DEBUG) console.log(mbStartMsg);
    appendLabelsLog(mbStartMsg);
  }
  const needsDiscogs = [];
  let mbErrors = 0;
  let mbConsec = 0;
  let mbAborted = false;
  for (let mi = 0; mi < needsMB.length; mi++) {
    if (mbAborted) {
      needsDiscogs.push(...needsMB.slice(mi));
      labelsIndex.progress = passProgress(PASS.mb, needsMB.length, needsMB.length);
      break;
    }
    const al = needsMB[mi];
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    try {
      const mbResult = await fetchLabelFromMusicBrainz(al.title, al.subtitle);
      if (mbResult) {
        await saveLabelEntry(key, mbResult.label, mbResult.mbid, al);
        if (mbResult.year) setAlbumYear(key, mbResult.year, { src: "release" });
        mbConsec = 0;
      }
      else { needsDiscogs.push(al); mbConsec = 0; }
    } catch (e) {
      mbErrors++;
      mbConsec++;
      needsDiscogs.push(al);
      if (mbConsec >= 10) {
        mbAborted = true;
        const msg = "[labels] pass 3 (MusicBrainz): " + mbConsec + " consecutive errors — aborting, will retry next scan window";
        console.log(msg);
        appendLabelsLog(msg);
      }
    }
    labelsIndex.progress = passProgress(PASS.mb, mi + 1, needsMB.length);
    if ((mi + 1) % 100 === 0) {
      appendLabelsLog("[labels] pass 3 (MusicBrainz): " + (mi + 1) + "/" + needsMB.length + " done so far");
    }
  }
  if (needsMB.length) {
    const mbMsg = "[labels] pass 3 (MusicBrainz): complete, " + needsDiscogs.length + " forwarded to Discogs" +
      (mbAborted ? " (aborted — consecutive errors)" : "") +
      (mbErrors ? ", " + mbErrors + " errors total" : "");
    if (DEBUG) console.log(mbMsg);
    appendLabelsLog(mbMsg);
  }

  // Pass 4: Discogs — serial, rate-limited, last resort.
  // Circuit breaker: 10 consecutive errors → abort pass.
  if (needsDiscogs.length) {
    const discogsStartMsg = "[labels] pass 4 (Discogs): " + needsDiscogs.length + " albums";
    if (DEBUG) console.log(discogsStartMsg);
    appendLabelsLog(discogsStartMsg);
  }
  let discogsErrors = 0;
  let discogsConsec = 0;
  let discogsAborted = false;
  const discogsPassDeadline = Date.now() + 5 * 60 * 1000; // 5-minute cap
  for (let di = 0; di < needsDiscogs.length; di++) {
    if (discogsAborted) {
      labelsIndex.progress = passProgress(PASS.discogs, needsDiscogs.length, needsDiscogs.length);
      break;
    }
    const al = needsDiscogs[di];
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    try {
      const label = await fetchLabelFromDiscogs(al.title, al.subtitle);
      if (label) { await saveLabelEntry(key, label, null, al); discogsConsec = 0; }
      else { discogsConsec = 0; }
    } catch (e) {
      discogsErrors++;
      discogsConsec++;
      if (discogsConsec >= 10) {
        discogsAborted = true;
        const msg = "[labels] pass 4 (Discogs): " + discogsConsec + " consecutive errors — aborting, will retry next scan window";
        console.log(msg);
        appendLabelsLog(msg);
      }
    }
    labelsIndex.progress = passProgress(PASS.discogs, di + 1, needsDiscogs.length);
    if (!discogsAborted && Date.now() > discogsPassDeadline) {
      discogsAborted = true;
      const tMsg = "[labels] pass 4 (Discogs): 5-minute time limit reached — aborting, remainder at next scheduled scan";
      console.log(tMsg);
      appendLabelsLog(tMsg);
    }
    if ((di + 1) % 100 === 0) {
      appendLabelsLog("[labels] pass 4 (Discogs): " + (di + 1) + "/" + needsDiscogs.length + " done so far");
    }
  }
  if (needsDiscogs.length) {
    const discogsMsg = "[labels] pass 4 (Discogs): complete" +
      (discogsAborted ? " (aborted)" : "") +
      (discogsErrors ? ", " + discogsErrors + " errors total" : "");
    if (DEBUG) console.log(discogsMsg);
    appendLabelsLog(discogsMsg);
  }

  labelsIndex.building = false;
  labelsIndex.builtAt  = Date.now();
  saveLastScanTime();
  labelsIndex.count    = labelsIndex.map.size;
  const doneMsg = "[labels] scan complete: " + labelsIndex.count + " labels found";
  console.log(doneMsg);
  appendLabelsLog(doneMsg);
  kickFanArtFetches()
    .then(() => kickDiscogsLogoFetches())
    .catch(e => { if (DEBUG) console.error("[labels] logo fetch error:", e.message); });

  } catch (e) {
    // Any unexpected exception — always reset so future scans aren't permanently blocked.
    labelsIndex.building = false;
    labelsIndex.builtAt = Date.now();
    saveLastScanTime();
    const errMsg = "[labels] scan aborted by unexpected error: " + e.message;
    console.error(errMsg);
    appendLabelsLog(errMsg);
  }
}

// ---------------------------------------------------------------------------
// Periodic auto-rescan — every 12 hours while paired with a Roon Core.
// ---------------------------------------------------------------------------
const LABELS_RESCAN_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
  if (!core) return;
  // The tag walk keeps its schedule whatever Labels is set to — the Decade,
  // Format, Sample rate, Bit depth and Channels filters and the local-files
  // badge are all downstream of it, and none of them is a label feature.
  runFileMetadataScan("12-hour auto-rescan").then(() => {
    if (!labelsEnabled) return;   // nothing further, and nothing logged
    if (labelsIndex.building) return;
    appendLabelsLog("[labels] 12-hour auto-rescan triggered");
    return runLabelsIndexScan().catch(e => {
      const msg = "[labels] auto-rescan error: " + e.message;
      console.error(msg);
      appendLabelsLog(msg);
    });
  });
}, LABELS_RESCAN_MS);

// Fetch label logo from Fan Art TV for a single label group key.
// Results (including "no logo found" = null) are persisted so we don't re-query.
async function fetchFanArtLogo(groupKey, mbid) {
  if (!mbid || !fanartKey) return "skip";
  if (labelLogoCache.has(groupKey)) return "skip"; // already tried
  const url = `https://webservice.fanart.tv/v3/music/labels/${encodeURIComponent(mbid)}?api_key=${fanartKey}`;
  try {
    const json = await httpJson(url);
    const logos = json && json.musiclabel;
    const logoUrl = Array.isArray(logos) && logos.length ? logos[0].url : null;
    // Follow any merge that happened before/during the fetch so logo persists under canonical key.
    const mergeTarget = labelMerges.get(groupKey);
    const canonKey = mergeTarget ? mergeTarget.targetKey : groupKey;
    setLabelLogo(canonKey, logoUrl);
    const entry = labelsIndex.map.get(canonKey);
    if (entry) entry.logo_url = logoUrl;
    if (DEBUG) console.log("[labels:fanart]", groupKey, "→", logoUrl || "(no logo)");
    return logoUrl ? "found" : "none";
  } catch (e) {
    // Don't cache on network error — retry next restart. 404 = no logo, cache null.
    // 404 is the expected "no artwork for this label" case and is already counted
    // in the pass summary — logging each one just floods the log.
    if (DEBUG && !(e.message && e.message.includes("404"))) {
      console.error("[labels:fanart]", groupKey, e.message);
    }
    if (e.message && e.message.includes("404")) {
      const mergeTarget = labelMerges.get(groupKey);
      const canonKey = mergeTarget ? mergeTarget.targetKey : groupKey;
      setLabelLogo(canonKey, null);
      return "none";
    }
    return "error";
  }
}

// Kick off Fan Art TV logo fetches for all labels that have an MBID but no cached logo result.
// Runs in batches of 5 concurrent requests — Fan Art TV has no strict rate limit.
async function kickFanArtFetches() {
  // Labels off means no label network traffic. This is reachable from
  // seedLabelsFromCache(), which runs before runLabelsIndexScan's own gate (it
  // seeds the in-memory map from cache, which is free) — so the gate has to be
  // here as well, or a box with a FanArt key kept fetching logos every 12 hours
  // for a feature its owner had switched off.
  if (!labelsEnabled) return;
  if (!fanartKey) return;
  const pending = [];
  for (const [groupKey, entry] of labelsIndex.map) {
    if (!entry.mbid) continue;
    if (labelLogoCache.has(groupKey)) continue;
    pending.push({ groupKey, mbid: entry.mbid });
  }
  if (!pending.length) return;
  if (DEBUG) console.log("[labels:fanart] fetching logos for", pending.length, "labels");
  appendLabelsLog("[labels:fanart] fetching logos for " + pending.length + " labels");
  let found = 0, none = 0, errors = 0;
  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    const results = await Promise.allSettled(
      pending.slice(i, i + BATCH).map(({ groupKey, mbid }) => fetchFanArtLogo(groupKey, mbid))
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || r.value === "error") errors++;
      else if (r.value === "found") found++;
      else if (r.value === "none")  none++;
    }
  }
  const msg = "[labels:fanart] done: " + found + "/" + pending.length + " logos found" +
    (none   ? ", " + none   + " without fanart artwork" : "") +
    (errors ? ", " + errors + " errors (will retry)"    : "");
  if (DEBUG) console.log(msg);
  appendLabelsLog(msg);
}

// ---------------------------------------------------------------------------
// Discogs label logo fetches — runs after Fan Art TV, covers labels that have
// no MBID (Fan Art TV requires one). Searches Discogs by label name and grabs
// cover_image. Per-session Set prevents re-fetching within one uptime cycle.
// ---------------------------------------------------------------------------
async function fetchLogoFromDiscogs(labelName) {
  if (!discogsToken) return { logo: null, reason: "no-token" };
  await discogsWait();
  const searchTerm = sanitizeDiscogsSearchTerm(labelName);
  const url = `https://api.discogs.com/database/search?type=label&q=${encodeURIComponent(searchTerm)}&per_page=5`;
  try {
    const json = await httpJson(url, {
      "Authorization": `Discogs token=${discogsToken}`,
      "User-Agent": MB_USER_AGENT
    }, 10000);
    const results = json && json.results;
    if (!Array.isArray(results) || !results.length) return { logo: null, reason: "empty" };
    const normTarget = labelGroupKey(labelName);
    let match = results.find(r => labelGroupKey(r.title || "") === normTarget);
    if (!match) match = results.find(r => labelGroupKey(r.title || "").startsWith(normTarget));
    if (!match) match = results[0];
    const img = match.cover_image || match.thumb || null;
    if (!img || img.endsWith(".gif") || /no[-_]image|no[-_]label|spacer|avatar|default[-_]label/i.test(img)) {
      return { logo: null, reason: "filtered" };
    }
    return { logo: img, reason: "ok" };
  } catch (e) {
    // 429 = rate limited — handled with a cooldown by the caller, don't log per-attempt.
    if (/HTTP 429/.test(e.message || "")) return { logo: null, reason: "rate" };
    if (DEBUG) console.error("[labels:discogs:logo]", e.message);
    return { logo: null, reason: "error" };
  }
}

async function kickDiscogsLogoFetches() {
  if (!labelsEnabled) return;   // see kickFanArtFetches
  if (!discogsToken) return;
  const pending = [];
  for (const [groupKey, entry] of labelsIndex.map) {
    if (discogsLogoTried.has(groupKey)) continue;
    if (labelLogoCache.has(groupKey)) continue; // .has() correctly skips null ("tried, not found") entries too
    if (!entry.display) continue;
    pending.push({ groupKey, display: entry.display });
  }
  if (!pending.length) return;
  if (DEBUG) console.log("[labels:discogs:logos] fetching logos for", pending.length, "labels");
  appendLabelsLog("[labels:discogs:logos] fetching logos for " + pending.length + " labels");
  let found = 0, emptyCount = 0, filteredCount = 0, errorCount = 0, rateAborted = false;
  const DISCOGS_429_COOLDOWN_MS = 65 * 1000; // Discogs limit window is per-minute
  for (let pi = 0; pi < pending.length; pi++) {
    const { groupKey, display } = pending[pi];
    let { logo, reason } = await fetchLogoFromDiscogs(display);
    if (reason === "rate") {
      // One cooldown per pass: wait out the rate window, then retry this label.
      // A second 429 straight after the cooldown means we're throttled for the
      // long haul — abort the pass; untried labels retry next scan cycle.
      appendLabelsLog("[labels:discogs:logos] rate limited (429) at " + (pi + 1) + "/" +
        pending.length + " — cooling down " + Math.round(DISCOGS_429_COOLDOWN_MS / 1000) + "s");
      await new Promise(r => setTimeout(r, DISCOGS_429_COOLDOWN_MS));
      ({ logo, reason } = await fetchLogoFromDiscogs(display));
      if (reason === "rate") {
        rateAborted = true;
        const abortMsg = "[labels:discogs:logos] still rate limited after cooldown — aborting pass at " +
          (pi + 1) + "/" + pending.length + " (remaining labels retry next scan)";
        console.error(abortMsg);
        appendLabelsLog(abortMsg);
        break;
      }
    }
    // Only mark tried on definitive results — errors/rate limits can retry next scan cycle.
    if (reason !== "error" && reason !== "rate") discogsLogoTried.add(groupKey);
    if (logo) {
      // Follow any merge that happened mid-flight so logo persists under the canonical key.
      const mergeTarget = labelMerges.get(groupKey);
      const canonKey = mergeTarget ? mergeTarget.targetKey : groupKey;
      setLabelLogo(canonKey, logo);
      const entry = labelsIndex.map.get(canonKey);
      if (entry) entry.logo_url = logo;
      found++;
      if (DEBUG) console.log("[labels:discogs:logo]", display, "→", logo);
    } else if (reason === "empty")    emptyCount++;
    else if (reason === "filtered") filteredCount++;
    else                             errorCount++;
  }
  const msg = "[labels:discogs:logos] " + (rateAborted ? "aborted (rate limited)" : "done") +
    ": " + found + "/" + pending.length + " logos found" +
    (emptyCount    ? ", " + emptyCount    + " no results"     : "") +
    (filteredCount ? ", " + filteredCount + " placeholder img" : "") +
    (errorCount    ? ", " + errorCount    + " errors"          : "");
  if (DEBUG) console.log(msg);
  appendLabelsLog(msg);
}

async function mbWait() {
  const elapsed = Date.now() - mbLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  mbLastReq = Date.now();
}
async function bandcampWait() {
  const elapsed = Date.now() - bandcampLastReq;
  if (elapsed < 1500) await new Promise(r => setTimeout(r, 1500 - elapsed));
  bandcampLastReq = Date.now();
}
async function pitchforkWait() {
  const elapsed = Date.now() - pitchforkLastReq;
  if (elapsed < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed));
  pitchforkLastReq = Date.now();
}
function slugifyForPitchfork(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['']/g, "")           // drop apostrophes before stripping
    .replace(/[^a-z0-9\s-]/g, " ")  // non-alphanumeric → space
    .replace(/\s+/g, "-")           // spaces → hyphens
    .replace(/-+/g, "-")            // collapse multiple hyphens
    .replace(/^-+|-+$/g, "");       // trim hyphens
}

// Fetch label and release year from a Bandcamp album page URL.
// Parses all JSON-LD blocks embedded in the page and picks the MusicAlbum entry.
// Returns { label, year } or null on any failure.
async function fetchLabelFromBandcamp(url, albumArtist) {
  const html = await httpText(url, { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }, 10000);
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m, albumData = null;
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj["@type"] === "MusicAlbum") { albumData = obj; break; }
    } catch (e) { /* JSON.parse failure on one block is safe — the while loop continues to the next block */ }
  }
  if (!albumData) return null;
  const publisher = albumData.publisher && albumData.publisher.name ? albumData.publisher.name.trim() : null;
  // Discard self-released: publisher matches the album artist
  const label = publisher && normalize(publisher) !== normalize(albumArtist || "") ? publisher : null;
  const yearMatch = String(albumData.datePublished || "").match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;
  return { label, year };
}
async function qobuzWait() {
  const elapsed = Date.now() - qobuzLastReq;
  if (elapsed < 700) await new Promise(r => setTimeout(r, 700 - elapsed));
  qobuzLastReq = Date.now();
}

async function httpJson(url, headers, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function httpText(url, headers, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(s) {
  return String(s || "").toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Decode HTML entities — named (incl. &copy; &reg; &trade;) and numeric
// (&#169; / &#xA9;), with or without the trailing semicolon. Unknown entities
// are left untouched. NOTE: "&copy" reached a share card before because the old
// stripHtml decoded a handful of entities by hand but not this one.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  nbsp: " ", hellip: "...", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  deg: "\u00B0"
};
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}
function decodeEntities(input) {
  if (!input) return "";
  return String(input)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g,        (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);?/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

// --- artist guard ----------------------------------------------------------
// Why this exists: a review/page was matched to the WRONG act because the only
// check was "the slug contains the artist's first token" — and the first token
// of "The Who" is "the", which matches almost any slug (e.g.
// "greatest-hits-the-guess-who"). These helpers verify that the text we got
// back actually belongs to the requested artist. Failing safe = drop the bio.

function escapeReg(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// First significant token, skipping a leading article ("the who" -> "who").
function firstSignificantToken(s) {
  const toks = normalize(s).split(" ").filter(Boolean);
  if (toks.length > 1 && /^(the|a|an)$/.test(toks[0])) return toks[1];
  return toks[0] || "";
}

// Whole-phrase overlap in either direction, tolerant of a leading "the".
// "the who" vs "the guess who" -> false (correctly rejects the mismatch);
// "jay z" vs "jay z feat alicia keys" -> true (keeps a correct match).
function namesOverlap(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return false;
  const pad = s => " " + s + " ";
  if (pad(a).includes(pad(b)) || pad(b).includes(pad(a))) return true;
  const strip = s => s.replace(/^the /, "");
  return strip(a) === strip(b);
}

// Pull the artist out of a leading "Artist - Album …" dateline, if present.
function leadArtistOf(text) {
  const m = String(text || "").trim().match(/^(.{2,60}?)\s[-\u2013\u2014]\s/);
  return m ? m[1].trim() : null;
}

function stripHtml(html) {
  const s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)            // named + numeric, semicolon optional
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// MusicBrainz: release year
function mbQuote(s) {
  return String(s).replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, "\\$&");
}
async function fetchAlbumYear(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (mbCache.has(key)) return mbCache.get(key);
  await mbWait();
  let q = `release:"${mbQuote(title)}"`;
  if (artist) q += ` AND artist:"${mbQuote(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const rgs = json["release-groups"] || [];
    rgs.sort((a, b) =>
      (a["first-release-date"] || "9999").localeCompare(b["first-release-date"] || "9999"));
    const date = rgs[0] && rgs[0]["first-release-date"] || null;
    const year = date ? date.slice(0, 4) : null;
    mbCache.set(key, year);
    return year;
  } catch (e) {
    if (DEBUG) console.error("[mb]", e.message);
    mbCache.set(key, null);
    return null;
  }
}

// Qobuz: search the public site, scrape the editorial review off the album page.
async function fetchQobuz(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (qobuzCache.has(key)) return qobuzCache.get(key);

  let out = null;
  try {
    // 1) Search
    const q = `${title} ${artist || ""}`.trim();
    await qobuzWait();
    const searchHtml = await httpText(
      `https://www.qobuz.com/us-en/search?q=${encodeURIComponent(q)}`,
      { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
    );

    // 2) Find first album link whose URL slug contains both the album title
    //    word AND the artist word. Slug shape: /us-en/album/{slug}/{id}
    const linkRe = /\/(?:us-en\/)?album\/([^"'\/\s]+)\/([a-z0-9]+)/g;
    const seen = new Map();
    let m;
    while ((m = linkRe.exec(searchHtml)) !== null) {
      if (!seen.has(m[2])) seen.set(m[2], m[1]);
    }
    if (seen.size === 0) { qobuzCache.set(key, null); return null; }

    const artistFirst = firstSignificantToken(artist || "");
    // Score each candidate by how many title words (> 3 chars) appear in its slug.
    // Taking only the first token was too loose: "songs" matched both
    // "songs-about-new-york-…" and "songs-of-peace-praise-…" for Various Artists.
    // Scoring all tokens picks the best match; short-title fallback uses firstSignificantToken.
    const titleTokens = normalize(title).split(" ").filter(w => w.length > 3);
    const titleCheck  = titleTokens.length > 0 ? titleTokens : [firstSignificantToken(title)].filter(Boolean);
    let bestScore = -1, chosenSlug = null, chosenId = null;
    for (const [id, slug] of seen) {
      const sn = slug.toLowerCase();
      if (artistFirst && !sn.includes(artistFirst)) continue;
      const score = titleCheck.filter(tok => sn.includes(tok)).length;
      if (score > bestScore) { bestScore = score; chosenSlug = slug; chosenId = id; }
    }
    // Require all tokens to match for short titles (1-2 tokens); at least 2 for longer titles.
    // Math.max(1,...) ensures the floor is 1 even when titleCheck is empty (all words ≤3 chars),
    // so a zero-score slug is never accepted regardless of title length.
    const minScore = Math.max(1, Math.min(titleCheck.length, 2));
    if (!chosenSlug || bestScore < minScore) { qobuzCache.set(key, null); return null; }

    // 3) Fetch the album page
    await qobuzWait();
    const albumUrl = `https://www.qobuz.com/us-en/album/${chosenSlug}/${chosenId}`;
    const albumHtml = await httpText(albumUrl, {
      "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"
    });

    // 4) Editorial review.  Page has "Album Review: ..." heading, then the
    //    body, ending around "About the album" or "Improve album information".
    let review = null;
    const startMatch = /Album Review[:\s]/i.exec(albumHtml);
    if (startMatch) {
      const start = startMatch.index;
      const ends = [
        albumHtml.indexOf("About the album",          start),
        albumHtml.indexOf("Improve album information", start),
        albumHtml.indexOf("Why buy on Qobuz",          start),
        start + 8000
      ].filter(n => n > start);
      const end = Math.min(...ends);
      let text = stripHtml(albumHtml.substring(start, end));

      // Qobuz's heading reads "Album Review: <Artist> - <Album>". Capture it
      // for an artist sanity-check before stripping it off.
      const headingMatch = text.match(/^Album Review[:\s]+([^\n]+)/i);
      const headingLine  = headingMatch ? headingMatch[1].trim() : "";
      text = text.replace(/^Album Review[^\n]*\n?/i, "").trim();

      // Drop a trailing attribution line: "© Author /TiVo", "… /AllMusic",
      // "… /Qobuz", or "Review by Author". Entities are already decoded, so a
      // raw "&copy" is now "©". The old code only matched "/Qobuz", which is
      // why "&copy … /TiVo" survived onto the card.
      text = text.replace(/\s*©\s*[^\n]*\/(?:tivo|rovi|allmusic|qobuz)\s*$/i, "").trim();
      text = text.replace(/\s*Review by\s+[^\n]+$/i, "").trim();

      // VERIFY THE ARTIST. The search/scrape can land on the wrong act — e.g.
      // "Greatest Hits / The Who" matching The Guess Who. Trust Qobuz's own
      // heading artist, falling back to the "Artist - Album" dateline the
      // review body opens with. On a mismatch, discard the whole Qobuz result
      // so the caller cleanly falls back to Wikipedia (or to no bio).
      const leadArtist = leadArtistOf(headingLine) || leadArtistOf(text);
      if (artist && leadArtist && !namesOverlap(leadArtist, artist)) {
        if (DEBUG) console.error(`[qobuz] artist mismatch: wanted "${artist}", got "${leadArtist}" — discarding`);
        qobuzCache.set(key, null);
        return null;
      }

      // Tidy: AllMusic reviews open with an "<Artist> - <Album>" dateline. Now
      // that the artist is confirmed, strip that exact prefix so the card opens
      // with the prose rather than a repeated title line.
      if (leadArtist) {
        const dateline = new RegExp(
          "^\\s*" + escapeReg(leadArtist) + "\\s*[-\\u2013\\u2014]\\s*" + escapeReg(title) + "\\s*",
          "i"
        );
        text = text.replace(dateline, "").trim();
      }

      if (text.length > 60) review = text;
    }

    // 5) Year + label
    let year = null, label = null;
    const rel = albumHtml.match(/Released\s+on\s+([\d\/]+)\s*by\s*<[^>]*>([^<]+)</i);
    if (rel) {
      const parts = rel[1].split("/");
      const yp = parts[parts.length - 1];
      if (yp.length === 2) {
        // Qobuz sometimes renders a 2-digit year. Pivot on the current year so
        // "80" -> 1980 (not 2080) while recent reissues like "08" -> 2008.
        const n = parseInt(yp, 10);
        const cur2 = new Date().getFullYear() % 100;
        year = String(n <= cur2 ? 2000 + n : 1900 + n);
      } else {
        year = yp;
      }
      label = rel[2].trim();
    }

    if (review || year || label) {
      out = {
        description: review,
        year, label,
        url: albumUrl,
        source: "Qobuz"
      };
    }
  } catch (e) {
    if (DEBUG) console.error("[qobuz]", e.message);
  }

  qobuzCache.set(key, out);

  // Keep the disk label cache in sync — persists across restarts so the
  // background scan can skip this album next time.
  if (out && out.label && !labelDiskCache.has(key) && !isLikelyNotALabel(out.label)) {
    setLabelName(key, out.label);
    // Also enrich the live labelsIndex (in case the scan hasn't reached this album yet).
    const al = albumIndex.albums.find(
      a => normalize(a.title) + "||" + normalize(a.subtitle) === key
    );
    if (al) labelsIndexAddAlbum(out.label, al);
  }

  return out;
}

// Wikipedia: search + first-paragraph extract via the MediaWiki API.
async function wikiSearch(query, limit = 5) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  return (data && data.query && data.query.search) || [];
}
async function wikiExtract(pageTitle) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info` +
    `&exintro=true&explaintext=true&redirects=1&inprop=url` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  const pages = (data && data.query && data.query.pages) || {};
  const page = pages[Object.keys(pages)[0]];
  if (!page || !page.extract) return null;
  return {
    title:       page.title,
    description: page.extract,
    url:         page.fullurl ||
                 `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`
  };
}

async function fetchWikiAlbum(title, artist) {
  if (!title) return null;
  const titleN      = normalize(title);
  const artistFirst = normalize(artist || "").split(" ")[0];
  const candidates  = await wikiSearch(`${title} ${artist || ""} album`);

  for (const c of candidates) {
    const ext = await wikiExtract(c.title);
    if (!ext) continue;

    const lead     = ext.description.slice(0, 400);
    const headNorm = normalize(ext.description.slice(0, 800));
    const titleNorm = normalize(c.title);

    // (1) The article must actually be about THIS album: its Wikipedia title
    //     should contain the album name as whole words (e.g. "Pang (album)",
    //     "Everything Forever (Victories at Sea album)").  Padding with spaces
    //     makes this a whole-word check so a short title like "Up" doesn't
    //     match "Group" / "Setup".
    const pad = s => " " + s + " ";
    if (!pad(titleNorm).includes(pad(titleN))) continue;

    // (2) Reject person biographies.  These slipped through before because a
    //     musician's bio mentions "albums" ("recorded five studio albums").
    //     Tell-tale signs: a birth/death date in parentheses, or "is/was a …
    //     singer/musician/band" in the lead.
    const personBirthDeath = /\(\s*(born\s+)?\d{1,2}\s+\w+\s+\d{4}\b/i.test(lead)
                          || /\b\d{4}\s*[–—-]\s*\d{4}\b/.test(lead);
    const personDescriptor = /\b(is|was)\s+(an?\s+)?(scottish|american|english|british|irish|welsh|canadian|australian|[a-z]+)?\s*(singer|songwriter|musician|guitarist|drummer|rapper|composer|producer|vocalist|bassist|pianist|dj|band|duo)\b/i.test(lead);
    if (personBirthDeath || personDescriptor) continue;

    // (3) Confirm it reads like a release: "… is/was the … album/EP/record …"
    if (!/\b(is|was)\b[^.]{0,80}\b(album|ep|record|mixtape|soundtrack|single)\b/i.test(lead)) continue;

    // (4) If we know the artist, prefer an article that mentions them.
    if (artistFirst && artistFirst.length > 2 && !headNorm.includes(artistFirst)) continue;

    return { ...ext, source: "Wikipedia" };
  }
  return null;
}
// Strip ONE trailing parenthetical qualifier from a Wikipedia title:
// "Camel (band)" → "Camel". Lets the title-identity check below accept
// music qualifiers while still demanding the article IS the artist.
function wikiTitleBase(t) {
  return String(t || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
}
// Loose-but-safe name identity: normalized equality, tolerating a
// leading "the" on either side ("Verve" ↔ "The Verve").
function namesEqualLoose(a, b) {
  const strip = (x) => normalize(x || "").replace(/^the\s+/, "");
  const na = strip(a), nb = strip(b);
  return !!na && na === nb;
}
// Full-text confirmation that the candidate artist article is connected to
// the album being played: Wikipedia's search index covers whole articles
// (including discography sections), so searching `"artist" "album"` and
// requiring the candidate among the hits confirms THIS article's subject
// made THAT album. Errors count as NOT confirmed — for bios, wrong is
// worse than missing.
async function wikiArticleMentionsAlbum(pageTitle, artist, albumTitle) {
  try {
    const hits = await wikiSearch(`"${artist}" "${albumTitle}"`, 10);
    const want = normalize(pageTitle);
    return hits.some(h => normalize(h.title) === want);
  } catch (e) {
    if (DEBUG) console.error("[wiki:artist] album cross-check:", e.message);
    return false;
  }
}

async function fetchWikiArtist(name, albumTitle) {
  if (!name) return null;
  // Split multi-artist credits on Roon's spaced " / " separator (and commas).
  // The slash must be spaced: bare slashes are part of names (AC/DC).
  const primary = name.split(/\s+\/\s+|,/)[0].trim();
  const candidates = await wikiSearch(`${primary} band musician singer`);
  for (const c of candidates) {
    if (/\b(album|song|tour|discography)\b/i.test(c.title)) continue;
    // The article title must BE the artist (one parenthetical qualifier like
    // "(band)"/"(musician)" allowed) — near-name matches and disambiguation
    // pages are rejected outright rather than risking someone else's bio.
    if (/\(disambiguation\)/i.test(c.title)) continue;
    if (!namesEqualLoose(wikiTitleBase(c.title), primary)) continue;
    const ext = await wikiExtract(c.title);
    if (!ext) continue;
    if (/\bmay (also )?refer to\b/i.test(ext.description.slice(0, 200))) continue; // disambiguation body
    const head = ext.description.slice(0, 800);
    if (!/\b(band|musician|singer|songwriter|group|musical|guitarist|drummer|pianist|composer|rapper|vocalist|recording artist|duo|trio|quartet|ensemble|orchestra)\b/i.test(head)) continue;
    // When the caller knows which album is playing, the article must also be
    // connected to that album — the strongest identity signal available.
    if (albumTitle && !(await wikiArticleMentionsAlbum(c.title, primary, albumTitle))) continue;
    return { ...ext, name: ext.title, source: "Wikipedia" };
  }
  return null;
}

async function fetchWikipedia(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (wikiCache.has(key)) return wikiCache.get(key);
  let result = null;
  try {
    const [album, artistInfo] = await Promise.all([
      fetchWikiAlbum(title, artist).catch(() => null),
      artist ? fetchWikiArtist(artist, title).catch(() => null) : Promise.resolve(null)
    ]);
    if (album || artistInfo) result = { album, artist: artistInfo };
  } catch (e) {
    if (DEBUG) console.error("[wiki]", e.message);
  }
  wikiCache.set(key, result);
  return result;
}

// Extractor for a Pitchfork review PAGE: the review body from the JSON-LD
// Review block, plus the score / Best-New-Music flag from the inline preloaded
// state. Sole consumer is fetchPitchfork (album extras). The parsed body NEVER
// reaches a client (UK-law compliance — only score/BNM/link are emitted); it
// is read internally by fetchPitchfork's artist-verification guard. The body
// is stripped of HTML but NOT entity-decoded here; the consumer decodes.
function parsePitchforkReviewHtml(html) {
  let description = null;
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj["@type"] === "Review" && obj.reviewBody) {
        description = stripHtml(obj.reviewBody).trim() || null;
        break;
      }
    } catch (e) { /* malformed JSON-LD block — try the next one; loop continues */ }
  }
  let score = null, isBestNewMusic = false;
  const scoreM = html.match(/"musicRating"\s*:\s*\{[^}]*?"score"\s*:\s*(\d+(?:\.\d+)?)/);
  if (scoreM) score = parseFloat(scoreM[1]);
  const bnmM = html.match(/"isBestNewMusic"\s*:\s*(true|false)/);
  if (bnmM) isBestNewMusic = bnmM[1] === "true";
  return { description, score: Number.isFinite(score) ? score : null, isBestNewMusic };
}

async function fetchPitchfork(title, artist) {
  const key = normalize(title) + "||" + normalize(artist || "");
  if (pitchforkCache.has(key)) return pitchforkCache.get(key);

  // Use primary artist only (before collaborators)
  const primaryArtist = String(artist || "").split(/\s*[/,&]\s*|\s+feat\.\s+/i)[0].trim();
  const artistSlug = slugifyForPitchfork(primaryArtist);
  const albumSlug  = slugifyForPitchfork(title);
  if (!artistSlug || !albumSlug) { pitchforkCache.set(key, null); return null; }

  const url = `https://pitchfork.com/reviews/albums/${artistSlug}-${albumSlug}/`;
  try {
    await pitchforkWait();
    const html = await httpText(url, { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }, 15000);

    const { description, score, isBestNewMusic } = parsePitchforkReviewHtml(html);

    if (!description && score === null) { pitchforkCache.set(key, null); return null; }

    // Verify the review is for the right artist
    if (description) {
      const artistFirst = firstSignificantToken(primaryArtist);
      if (artistFirst && !normalize(description).includes(artistFirst)) {
        pitchforkCache.set(key, null);
        return null;
      }
    }

    const out = { description, score, isBestNewMusic, url, source: "Pitchfork" };
    pitchforkCache.set(key, out);
    return out;
  } catch (e) {
    if (DEBUG) console.error("[pitchfork]", e.message);
    pitchforkCache.set(key, null);
    return null;
  }
}

// Combine: Pitchfork preferred, then Qobuz, then Wikipedia for the album review;
// Wikipedia also used for the artist bio.
async function fetchAlbumBios(title, artist) {
  if (!title) return null;
  const [pitchfork, qobuz, wiki] = await Promise.all([
    fetchPitchfork(title, artist).catch(() => null),
    fetchQobuz(title, artist).catch(() => null),
    fetchWikipedia(title, artist).catch(() => null)
  ]);

  let album = null;
  if (pitchfork && pitchfork.description) {
    // COMPLIANCE (UK law): Pitchfork's written review must not be displayed —
    // only the score, the Best New Music flag, and a LINK to read the review
    // on pitchfork.com are emitted. The fetched text stays internal (this
    // branch's gate and fetchPitchfork's artist-verification guard read it);
    // the description leaves this function as null.
    album = {
      description:    null,
      year:           (qobuz && qobuz.year) || null,
      label:          (qobuz && qobuz.label) || null,
      url:            pitchfork.url,
      source:         "Pitchfork",
      score:          pitchfork.score,
      isBestNewMusic: pitchfork.isBestNewMusic
    };
  } else if (qobuz && qobuz.description) {
    album = {
      description:    qobuz.description,
      year:           qobuz.year  || (wiki && wiki.album && /(\d{4})/.exec(wiki.album.description || "") || [])[1] || null,
      label:          qobuz.label || null,
      url:            qobuz.url,
      source:         "Qobuz",
      score:          null,
      isBestNewMusic: false
    };
  } else if (wiki && wiki.album) {
    album = {
      description:    wiki.album.description,
      year:           null,
      label:          (qobuz && qobuz.label) ? qobuz.label : null,
      url:            wiki.album.url,
      source:         "Wikipedia",
      score:          null,
      isBestNewMusic: false
    };
  } else if (qobuz) {
    album = {
      description:    null,
      year:           qobuz.year,
      label:          qobuz.label,
      url:            qobuz.url,
      source:         "Qobuz",
      score:          null,
      isBestNewMusic: false
    };
  }

  const artistObj = (wiki && wiki.artist) ? {
    name:        wiki.artist.name || artist || null,
    description: wiki.artist.description,
    url:         wiki.artist.url,
    source:      "Wikipedia"
  } : null;

  if (album && album.description) {
    album.description = decodeEntities(album.description).trim();
    const lead = leadArtistOf(album.description);
    if (artist && lead && !namesOverlap(lead, artist)) {
      if (DEBUG) console.error(`[bios] description artist mismatch: wanted "${artist}", got "${lead}" — dropping`);
      album.description = null;
    }
    if (!album.description) album.description = null;
  }

  return { album, artist: artistObj };
}

// ---------------------------------------------------------------------------
// In-memory library search index
//
// Roon's own browse "search" is server-driven, relevance-tuned, and unhappy
// with very short or common-word queries (e.g. typing "the t" for the band
// "The The").  To give instant, prefix-aware, typo-tolerant search across the
// WHOLE library, we walk the "albums" hierarchy once, cache a lightweight
// record per album in memory, and match locally on every keystroke.
//
// The album's position (offset) in the albums hierarchy is the stable handle —
// exactly what pickRandomAlbums()/openAlbumByOffset() already rely on — so a
// search hit plugs straight into the existing open/play machinery with no new
// playback code.
// ---------------------------------------------------------------------------
const SEARCH_PAGE      = 500;              // albums per Roon load() page
// Staleness rebuild is a safety net (1h), NOT the freshness mechanism: the
// 5-min maintenance probe below detects library edits (count change, or a
// count-neutral reorder via the first album's identity) and rebuilds
// immediately. The old 10-min max-age made nearly every Home visit kick off
// a full library re-walk over the same single websocket that was serving the
// render's browse + image traffic — a major sluggishness source after the
// Home redesign.
// The album index is a stable snapshot. Roon owns the library; the extension
// scans it once on first pair, then asks every ten minutes whether anything
// moved (a 2-3 call probe; see libraryCheckMs) — and NEVER rebuilds while Roon
// is actively importing (a still-moving album count). The CHECK is frequent
// because it is cheap; the REBUILD is rare because it is not. This keeps the
// extension off a busy Core entirely. Playback stays correct against a snapshot
// that's stale because a stale offset is resolved LIVE by name at play time
// (see the search fallback in loadAlbumSession), so an out-of-date snapshot
// never blocks a play.
const IMPORT_SETTLE_MS = 5000;                  // album count must hold steady this long to count as "not importing"

const albumIndex = {
  albums:   [],     // [{ offset, title, subtitle, image_key, nTitle, nArtist, tTitle[], tArtist[], jTitle, jArtist, artistNames[] }]
  count:    0,
  builtAt:  0,      // last FULL walk of the library
  progress: 0,      // 0..1 while building
  building: null    // Promise while a build is in flight
};
let indexMaintTimer = null;

function indexRecord(item, offset) {
  const title    = item.title    || "";
  const subtitle = item.subtitle || "";
  const nTitle   = normalize(title);
  const nArtist  = normalize(subtitle);
  return {
    offset,
    title, subtitle,
    image_key: item.image_key || null,
    nTitle, nArtist,
    // Every identity this album could match a file/favourite under, computed
    // once here so list responses do no string work per album (see withSource).
    srcKeys: albumKeys(title, subtitle),
    // Sort keys, precomputed: Roon (and every record shop) files "The Wall"
    // under W, not T. Leading articles are dropped for ordering only — the
    // displayed title is untouched.
    sortTitle: nTitle.replace(/^(the|a|an) /, ""),
    tTitle:  nTitle  ? nTitle.split(" ")  : [],
    tArtist: nArtist ? nArtist.split(" ") : [],
    jTitle:  nTitle.replace(/ /g, ""),
    jArtist: nArtist.replace(/ /g, ""),
    // Precomputed per-artist names for searchArtists: splitting on the
    // multi-artist separators and normalizing each name is done once here at
    // index-build time rather than on every keystroke. Each entry is
    // { name, n } where `name` is the display form and `n` is normalized.
    artistNames: splitArtistNames(subtitle)
  };
}

// Split a Roon subtitle into its individual artist names on the common
// multi-artist separators. Shared by indexRecord (precompute) so the same
// separator set is used everywhere. Returns [{ name, n }].
function splitArtistNames(subtitle) {
  if (!subtitle) return [];
  return subtitle
    .split(/ \/ | feat\.? | featuring | ft\.? /i)
    .map(s => s.trim())
    .filter(Boolean)
    .map(name => ({ name, n: normalize(name) }));
}

// ---- Credit splitting for the album view's artist links --------------------
// Roon's subtitle is flat text: "Earth, Wind & Fire" (one band) and
// "Panda Bear, Sonic Boom & Adrian Sherwood" (three artists) are structurally
// identical, so splitting on , & + and is irreducibly heuristic. The split is
// accepted only when at least one fragment is a KNOWN library artist (the
// exact credit of some album in the index): genuine collaborators usually
// have their own albums, while band-name fragments ("Wind", "Stills", "the
// Machine") never appear as a whole album credit. splitArtistNames above
// deliberately keeps , & + unsplit for the search chips — this is the looser,
// library-validated splitter, used only where a wrong link is recoverable
// (a wrong split now costs a missing link and a missing entry on that
// artist's screen — the screen matches credited names exactly, v1.6.56).
let _knownArtistCache = { builtAt: -1, set: new Set() };
function knownArtistSet() {
  if (_knownArtistCache.builtAt !== albumIndex.builtAt) {
    const set = new Set();
    for (const al of albumIndex.albums) { if (al.nArtist) set.add(al.nArtist); }
    _knownArtistCache = { builtAt: albumIndex.builtAt, set };
  }
  return _knownArtistCache.set;
}
function splitCreditIntoArtists(subtitle) {
  const whole = (subtitle || "").trim();
  if (!whole) return [];
  // Stage 1 — Roon's own separators, never part of a band name (a bare slash
  // like AC/DC is unspaced): split unconditionally, exactly like the client's
  // conservative splitter always has.
  const safeParts = whole.split(/ \/ | feat\.? | featuring | ft\.? /i)
    .map(s => s.trim()).filter(Boolean);
  // Stage 2 — the risky separators expand a part only when the library
  // validates at least one fragment as a known artist.
  const known = knownArtistSet();
  const out = [];
  for (const part of safeParts) {
    // Stage 1b — UNSPACED slash. Roon writes most multi-artist credits this
    // way ("T-Bone Walker/Big Joe Turner/Otis Spann", "François Couturier/
    // Dominique Pifarély"), so refusing to split it left the whole credit as
    // one dead-end link. Band names also contain bare slashes (AC/DC), so it
    // splits only on evidence: every fragment looks like a full name (contains
    // a space — "AC"/"DC" don't), or the library recognises one as an artist.
    const slashFrags = part.split("/").map(s => s.trim()).filter(Boolean);
    let pieces = [part];
    if (slashFrags.length >= 2) {
      const allMultiWord = slashFrags.every(f => /\s/.test(f));
      const anyKnown = slashFrags.some(f => f.length >= 3 && known.has(normalize(f)));
      if (allMultiWord || anyKnown) pieces = slashFrags;
    }
    // Each slash piece still goes through the ", & + and" stage below —
    // "Miles Davis/John Coltrane & Bill Evans" must not stop half-split.
    for (const piece of pieces) {
      const frags = piece.split(/\s*,\s*| & | \+ | and /i)
        .map(s => s.trim())
        .filter(f => f.length >= 2);   // "," splits of initials/junk never link
      if (frags.length >= 2 && frags.some(f => known.has(normalize(f)))) out.push(...frags);
      else if (piece.length >= 2 || pieces.length === 1) out.push(piece);
    }
  }
  // Badly-tagged credits repeat a name ("Artist/Artist") — one link each.
  const deduped = [...new Set(out)];
  return deduped.length ? deduped : [whole];
}

// ---- Credited-artist identity of an album ---------------------------------
// The ONE definition of "which artists is this album credited to", shared by
// the album view's artist links (splitCreditIntoArtists) and the artist screen
// (/api/artist-albums). If a link is rendered for X on album A, X's screen
// shows A — and nothing else does.
//
// Matching is EQUALITY in canonArtist() space, never substring. A substring
// test is what put "Jordan Prince" and 'Bonnie "Prince" Billy' under Prince,
// and would equally put Kate Bush under Bush or Air Supply under Air.
//
// Deliberately NOT albumKeys(): that splits every separator ungated, which is
// safe there only because the album TITLE must match too. Here the artist name
// is the only factor, so the split has to stay evidence-gated.
// Every artist identity the library can actually SHOW a screen for — the union
// of every album's credited names, in canonArtist() space.
//
// This is the exact predicate /api/artist-albums applies (`names.includes(q)`,
// else `al.cArtist === q`), lifted into a set so a caller can ask "would a link
// for this name lead anywhere?" without scanning the library per name.
//
// It matters most on the now-playing screen, where the credit is the TRACK
// artist. On a compilation almost every track artist is someone the library has
// no album for, and linking them all would be a screenful of dead ends. Album
// credits rarely have that problem, which is why the album view never needed it.
//
// Cached against albumIndex.builtAt like knownArtistSet, and for the same
// reason: cCredits is only populated by rebuildCreditIdentities AFTER builtAt
// moves, so caching on anything else hands back the previous library's set.
let _linkableArtistCache = { builtAt: -1, set: new Set() };
function linkableArtistSet() {
  if (_linkableArtistCache.builtAt !== albumIndex.builtAt) {
    const set = new Set();
    for (const al of albumIndex.albums) {
      if (al.cArtist === undefined) applyCreditIdentities(al);   // built outside the pass
      if (al.cCredits) for (const n of al.cCredits) set.add(n);
      else if (al.cArtist) set.add(al.cArtist);
    }
    _linkableArtistCache = { builtAt: albumIndex.builtAt, set };
  }
  return _linkableArtistCache.set;
}

// Split a credit into individually linkable artists, flagging which of them the
// library can actually open a screen for.
//
// Memoised because the caller is /api/zone-state, which every open client polls
// every 1.5s. The work is small but it is not free, and the same handful of
// credits repeat for the length of an album.
const _creditLinkCache = new Map();     // builtAt|credit -> [{ name, linkable }]
const CREDIT_LINK_CACHE_MAX = 300;
function creditLinks(credit) {
  const whole = String(credit || "").trim();
  if (!whole) return [];
  if (!albumIndex.count) return [{ name: whole, linkable: false }];  // no library yet
  const sig = albumIndex.builtAt + "|" + whole;
  const hit = _creditLinkCache.get(sig);
  if (hit) return hit;
  const linkable = linkableArtistSet();
  const out = splitCreditIntoArtists(whole)
    .map(name => ({ name, linkable: linkable.has(canonArtist(name)) }));
  if (_creditLinkCache.size >= CREDIT_LINK_CACHE_MAX) {
    _creditLinkCache.delete(_creditLinkCache.keys().next().value);
  }
  _creditLinkCache.set(sig, out);
  return out;
}

function creditIdentities(subtitle) {
  const whole = String(subtitle || "").trim();
  const c = canonArtist(whole);
  if (!c) return { c: "", first: "", names: null };   // punctuation/CJK-only credit
  const names = splitCreditIntoArtists(whole);
  const set = new Set([c]);
  const add = (s) => { const x = canonArtist(s); if (x) set.add(x); };
  // The client renders links for the stage-1 parts before /api/album answers,
  // so every name it can show must resolve here too.
  for (const p of whole.split(/ \/ | feat\.? | featuring | ft\.? /i)) add(p);
  for (const n of names) add(n);
  const all = [...set];
  return {
    c,
    first: canonArtist(names[0] || whole),
    names: all.length > 1 ? all : null   // null = plain single-artist credit
  };
}
function applyCreditIdentities(al) {
  const id = creditIdentities(al.subtitle);
  al.cArtist = id.c; al.cFirst = id.first; al.cCredits = id.names;
}
// Second pass over the snapshot: splitCreditIntoArtists needs knownArtistSet(),
// which only exists once every record does. MUST run AFTER albumIndex.builtAt
// is updated — knownArtistSet() caches against builtAt, so calling it earlier
// would hand back the PREVIOUS library's artist set on every rebuild.
function rebuildCreditIdentities() {
  knownArtistSet();
  for (const al of albumIndex.albums) applyCreditIdentities(al);
}
// Is `artist` one of the credited artists of `credit`? Whole-name equality —
// the single test every "is this album by this artist?" decision should use.
// Never `.includes()`: that is what matched Jordan Prince for Prince.
// Both sides may be full credits rendered differently ("Miles Davis/John
// Coltrane" here, "Miles Davis" there), so compare the two identity SETS
// rather than treating the query as one name — otherwise the stale-offset
// resolver fails on exactly the multi-artist albums it exists to rescue.
function creditHasArtist(credit, artist) {
  const qId = creditIdentities(artist || "");
  const cId = creditIdentities(credit);
  if (!qId.c || !cId.c) return false;
  const qNames = qId.names || [qId.c];
  const cNames = cId.names || [cId.c];
  return qNames.some(q => cNames.includes(q));
}

// Walk the whole albums hierarchy once and cache a record per album.
// Concurrent callers share the same in-flight build promise.
async function buildAlbumIndex() {
  if (albumIndex.building) return albumIndex.building;

  albumIndex.progress = 0;
  albumIndex.building = withBrowseSession(async (sessionKey) => {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
    const total = head.list && head.list.count ? head.list.count : 0;

    const albums = new Array(total);
    let loaded = 0;
    for (let off = 0; off < total; off += SEARCH_PAGE) {
      const page = await load({
        hierarchy: "albums", offset: off, count: SEARCH_PAGE, multi_session_key: sessionKey
      });
      const items = page.items || [];
      if (items.length === 0) break;             // safety: stop on a short read
      for (let i = 0; i < items.length; i++) {
        albums[off + i] = indexRecord(items[i], off + i);
      }
      loaded += items.length;
      albumIndex.progress = total ? Math.min(1, loaded / total) : 1;
    }

    albumIndex.albums   = albums.filter(Boolean);  // drop any holes
    albumIndex.count    = albumIndex.albums.length;
    // What Roon SAID the library held when this snapshot was taken, which is
    // not always what arrived: a short page leaves holes, and the filter above
    // drops them. Comparing a live count against the filtered one would then
    // report "the library moved" forever on a library that never changed —
    // and every album open would arm another full re-walk.
    albumIndex.declared = total || albumIndex.count;
    rebuildAmbiguousAlbumKeys();   // identities shared by >1 album get no badge
    recordFirstSeenAlbums();       // anything new since the last rebuild
    albumIndex.builtAt  = Date.now();
    rebuildCreditIdentities();     // AFTER builtAt — see the function's comment
    albumIndex.progress = 1;
    if (DEBUG) console.log("[index] built", albumIndex.count, "albums");
    return albumIndex;
  });

  try {
    const idx = await albumIndex.building;
    // Join whatever release years are already in hand onto the new snapshot,
    // BEFORE anything that goes to the network — the file-tag years from the
    // last scan survive a rebuild and should apply immediately, without waiting
    // on a round trip that may never come back. Synchronous, no I/O.
    harvestAlbumYears("library sync");
    // The rest is background work, and it runs ONE AT A TIME rather than as
    // three simultaneous kicks. The art prewarm and the genre walk both go over
    // the single multiplexed Core websocket that browse and transport share, so
    // issuing them together is a burst the Core feels even though the total
    // number of calls is unchanged. Nothing here is awaited by the caller.
    syncChain().catch(e => { if (DEBUG) console.error("[sync] chain:", e.message); });
    return idx;
  } finally {
    albumIndex.building = null;
  }
}

// ---------------------------------------------------------------------------
// ONE background queue for every heavy job.
//
// Serialising each chain internally is not enough, and the first attempt at
// this got it wrong: a manual Rescan starts its own chain AND triggers a
// rebuild whose chain starts too, so the two ran side by side — putting the
// genre walk and the art prewarm, the two most expensive things here, on the
// Core simultaneously. Exactly the burst the serialising was meant to remove.
//
// Everything now goes through one promise tail, so at most one job is talking
// to the Core at a time no matter how many chains are in flight. The total
// number of calls is unchanged; what changes is that they arrive in a queue
// rather than a spike, which is the part the Core actually feels while somebody
// is trying to listen to something.
//
// Each job is caught individually — one failing must never cancel the queue —
// and the tail is reset to a resolved promise on failure so a rejection can
// never poison every job behind it.
let _bgTail = Promise.resolve();
function bgRun(what, fn) {
  // .catch BEFORE .then, not a rejection handler alongside it. A two-argument
  // .then would treat a rejected tail as "handled" and skip THIS job's callback
  // entirely — so the first job queued after any rejection would be silently
  // dropped while everything after it ran normally. Neutralise first, then run.
  _bgTail = _bgTail.catch(() => {}).then(async () => {
    try { await fn(); }
    catch (e) { console.error("[bg] " + what + " failed: " + e.message); }
  });
  return _bgTail;
}

// Post-rebuild background work. Order is deliberate: the streaming favourites
// cost the Core nothing (they are Qobuz/TIDAL HTTP) and decide the source
// badges, so they go first and finish fast; then genres; then the art prewarm,
// which is the longest-running and the most patient — nothing is waiting on it,
// the store serves from disk the moment each file lands, and an album with no
// thumbnail yet simply falls back to the Core path it used before the store
// existed.
async function syncChain() {
  await bgRun("stream favourites", () => refreshStreamAlbumKeys("library sync"));
  await bgRun("genres",            () => harvestAlbumGenres("library sync"));
  await bgRun("art prewarm",       () => prewarmAlbumArt());
  // Last, and only if today has none: the picks need the genre harvest above to
  // have run at least once, and a fresh
  // pair should not have to wait up to an hour for the timer's first tick.
  kickSmartPicks("after sync");
}

// ---------------------------------------------------------------------------
// Genre harvest.
//
// Roon's album browse response carries no genre, which is why Genre lived in
// the old "main filter" — a mode that navigated Roon into a genre's own list
// and therefore could not be combined with anything else, because that list has
// its own offset space with no relation to the full-library offsets every other
// facet returns.
//
// Decade had exactly this shape until its years entered the snapshot, at which
// point it became an ordinary combinable chip. This does the same for genre:
// walk the genres hierarchy ONCE per library sync and write album → genres into
// a side table, after which the filter is a Set lookup on data already in
// memory and composes with Source, Decade, Label and the rest.
//
// Cost: about six browse calls per top-level genre — resolve it by title (item
// keys are session-scoped, so this cannot be cached), drill in, find its
// "Albums" child, drill in again, then page the titles. For a typical 25-40
// genre library that is a few hundred calls every twelve hours, against a sync
// that already fetches one cover per album. It is deliberately NOT on any user
// action.
// ---------------------------------------------------------------------------
// Does the skip have anything to work with?
//
// The whole optimisation rests on one unverified assumption: that Roon's genre
// list states an album count in each item's subtitle. If it does not,
// parseAlbumCount returns null, the "any doubt walks" guard fires for every
// genre, and the skip never engages — while the harvest goes on logging
// plausible-looking totals. That is a failure that hides itself, so it is
// stated in words rather than left to be inferred.
//
// A function rather than an inline block so the classification is testable:
// the wording is cosmetic, but "this library can never skip" being reported as
// "all good" is the failure this exists to prevent.
function genreFingerprintReport(genres) {
  const total    = genres.length;
  const parsable = genres.filter(g => parseAlbumCount(g.subtitle) !== null).length;
  const withSub  = genres.filter(g => g.subtitle).length;
  if (total && parsable === total) {
    return "[genres] fingerprint OK — all " + total + " genres state an album " +
           "count, so unchanged ones can be skipped";
  }
  const sample = genres.slice(0, 3)
    .map(g => JSON.stringify(g.name + " => " + (g.subtitle || "")))
    .join(", ");
  return "[genres] fingerprint UNUSABLE — only " + parsable + " of " + total +
         " genres state an album count (" + withSub + " have any subtitle at " +
         "all), so every genre must be walked every time. Sample: " + sample;
}

let genreHarvestRunning = false;

async function harvestAlbumGenres(reason, force) {
  if (genreHarvestRunning) return;
  if (!core || !isIndexBuilt()) return;
  // Never walk while Roon is importing. Every other heavy path consults this —
  // the label scan and the snapshot rebuild both do — and this one only got it
  // transitively, via the rebuild that happened to call it. The manual Rescan
  // path called it directly and bypassed the check entirely, which is exactly
  // when a user is most likely to press it: right after adding albums.
  //
  // `force` is for the explicit Rescan button, matching runLabelsIndexScan's
  // contract, so a user who insists can still make it run.
  if (!force && await libraryIsImporting()) {
    console.log("[genres] " + reason + ": deferred — Roon is importing");
    return;
  }
  genreHarvestRunning = true;
  const started = Date.now();
  let walked = 0, skipped = 0, unreachable = 0, pairs = 0, written = 0, unmatched = 0;
  // A full sweep ignores fingerprints. Bounded by time because no free
  // fingerprint can see a same-count membership swap, or an album Roon
  // re-identified — that changes the mapping's key without moving any genre's
  // album count, so a subtitle-based skip would never re-walk it.
  const oldest = genreScanCache.size
    ? Math.min(...[...genreScanCache.values()].map(v => v.ts || 0)) : 0;
  const sweeping = force || !genreScanCache.size || !albumGenreCache.size ||
                   (Date.now() - oldest) > genreSweepMs();
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "genres", pop_all: true, multi_session_key: sessionKey });
      const root = await loadLevel(sessionKey, "genres", 1000);
      // Keep the SUBTITLE and IMAGE KEY, not just the title. Roon states each
      // genre's album count in the subtitle of this very response, so the
      // fingerprint that decides whether a genre needs walking is already in
      // hand — it used to be thrown away one line later.
      const genres = root.items
        .filter(i => i.hint !== "header" && i.title)
        .map(i => ({
          name: String(i.title).trim(),
          subtitle: String(i.subtitle || ""),
          image_key: String(i.image_key || "")
        }))
        .filter(g => g.name);

      // Unconditional, not behind DEBUG: the answer matters on a quiet install
      // too, and it prints once per harvest rather than once per genre.
      console.log(genreFingerprintReport(genres));

      // Genres this run actually walked, mapped fresh. NOT merged into the old
      // value: the previous code did `(prev || []).concat(name)`, which made
      // the mapping a monotonic union — a genre could only ever be ADDED to an
      // album, never removed, so an album leaving a genre kept it forever and
      // no full walk could correct it. Rebuilding a walked genre's membership
      // from scratch is also what gives a SKIP a precise meaning: "keep the
      // previous answer for this genre" rather than "add to an answer that only
      // grows".
      const fresh = new Map();   // album key → Set(genre name)
      const addFresh = (key, name) => {
        let set = fresh.get(key);
        if (!set) { set = new Set(); fresh.set(key, set); }
        set.add(name);
      };
      const walkedNames = new Set();

      for (const g of genres) {
        // Skip only when every signal says nothing moved. A missing parse is
        // NOT a match: a genre with no subtitle, or a Roon format change, would
        // otherwise compare null to null and skip forever with no data at all.
        const seen = genreScanCache.get(g.name);
        const count = parseAlbumCount(g.subtitle);
        if (!sweeping && seen && count !== null &&
            seen.subtitle === g.subtitle && seen.image_key === g.image_key &&
            // Self-calibration: if this genre's stated count and the count its
            // album list actually reported ever disagreed, the subtitle is not
            // describing the set we harvest — never trust it for this genre.
            seen.total === count) {
          skipped++;
          continue;   // NOT in walkedNames — its stored mapping stays authoritative
        }

        // Re-resolve from the top every time. item_key values are scoped to the
        // session AND to the level the session is currently on, so the keys
        // captured in the loadLevel above are stale the moment we drill into
        // the first genre.
        await browse({ hierarchy: "genres", pop_all: true, multi_session_key: sessionKey });
        const found = await findItemByTitle(sessionKey, "genres", g.name, 3000, "genres:root");
        // Counted, not silent. Once skipping is normal, "didn't walk it" and
        // "Roon wouldn't expand it" look identical from the outside, and a user
        // staring at a low coverage number needs to be able to tell them apart.
        if (!found) { unreachable++; continue; }
        await browse({ hierarchy: "genres", item_key: found.item_key, multi_session_key: sessionKey });
        const lvl = await loadLevel(sessionKey, "genres", 300);
        const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
        if (!albumsChild) { unreachable++; continue; }
        await browse({ hierarchy: "genres", item_key: albumsChild.item_key, multi_session_key: sessionKey });

        let observed = 0;
        for (let off = 0; ; off += SEARCH_PAGE) {
          const page = await load({
            hierarchy: "genres", offset: off, count: SEARCH_PAGE, multi_session_key: sessionKey
          });
          const items = page.items || [];
          if (!items.length) break;
          for (const it of items) {
            if (!it.title) continue;
            // Roon-to-Roon join: both sides are Roon's own strings, so this is
            // exact rather than the lossy cross-source matching the year and
            // local-file joins have to do.
            addFresh(normalize(it.title) + "||" + normalize(it.subtitle || ""), g.name);
            pairs++;
          }
          observed = page.list && page.list.count ? page.list.count : observed;
          if (off + SEARCH_PAGE >= observed) break;
        }

        walked++;
        walkedNames.add(g.name);
        // Written per genre, immediately, INSIDE the session: the whole walk is
        // wrapped in one catch, so a run that dies at genre 12 must still leave
        // the first eleven fingerprinted rather than starting over next time.
        setGenreScan(g.name, g.subtitle, g.image_key,
                     count !== null ? count : observed);
      }

      // Carry forward every genre this run did NOT walk — the skipped ones and
      // any Roon wouldn't expand. A walked genre is deliberately not carried
      // forward: `fresh` is its complete, current membership, so an album that
      // is absent from it has genuinely left that genre and must lose it. That
      // is the removal the old union could never express.
      for (const [key, list] of albumGenreCache) {
        for (const name of list) {
          if (walkedNames.has(name)) continue;
          addFresh(key, name);
        }
      }
      // An album absent from `fresh` entirely had every one of its genres
      // walked and appeared in none of them — it has left them all. Collected
      // first, because deleting while iterating the map being read is how a
      // cleanup quietly drops half of what it meant to.
      const gone = [];
      for (const key of albumGenreCache.keys()) if (!fresh.has(key)) gone.push(key);
      for (const key of gone) if (deleteAlbumGenres(key)) written++;

      for (const [key, set] of fresh) {
        if (setAlbumGenres(key, [...set])) written++;
      }
    });

    // How many albums the harvest actually reached. Reported rather than
    // assumed: a genre list Roon declines to expand is invisible otherwise.
    for (const al of albumIndex.albums) if (!albumGenresOf(al).length) unmatched++;
    if (written) bumpLibraryMeta();
    console.log("[genres] " + reason + ": " + (walked + skipped + unreachable) +
                " genres — " + walked + " walked, " + skipped + " unchanged" +
                (unreachable ? ", " + unreachable + " unreachable" : "") +
                (sweeping ? " (full sweep)" : "") +
                "; " + pairs + " pairs, " + written + " written, " +
                // IDENTITIES, not albums. The cache is keyed on
                // normalize(title)||normalize(subtitle), and albums that share
                // an identity share a row — so this number is legitimately
                // lower than the count of albums that have a genre. Labelling
                // both "albums" made a real 156-album gap look like data loss.
                albumGenreCache.size + " identities genred, " +
                (albumIndex.albums.length - unmatched) + " of " +
                albumIndex.albums.length + " albums have one" +
                " in " + Math.round((Date.now() - started) / 1000) + "s");
  } catch (e) {
    // Non-fatal by design: the Genre facet simply offers nothing this cycle.
    // Everything else in the Focus sheet is unaffected, so failing loudly here
    // would take down a working screen over an optional column.
    console.error("[genres] harvest failed:", e.message);
  } finally {
    genreHarvestRunning = false;
  }
}

// Does a usable snapshot exist? (Freshness is not time-based: the index is a
// deliberate snapshot, refreshed only when a check OBSERVES that the library
// moved, or on a manual Rescan.)
function isIndexBuilt() {
  return albumIndex.count > 0 && albumIndex.builtAt > 0;
}

// Ensure a usable index EXISTS — build it only if empty (first pair). Never
// rebuilds on staleness: that would scan Roon on a user action, which the
// snapshot model deliberately avoids. Awaits the first build so the first
// search returns results.
async function ensureAlbumIndex() {
  if (albumIndex.count === 0 && !albumIndex.building) {
    buildAlbumIndex().catch(e => { if (DEBUG) console.error("[index] build failed:", e.message); });
  }
  if (albumIndex.count === 0 && albumIndex.building) {
    await albumIndex.building.catch(() => { /* build error already logged by buildAlbumIndex */ });
  }
}

// All an Item gives us to recognise an album by. Shared so the change probe and
// the import probe can never drift into recognising albums differently — one
// asks "is this the library we indexed", the other "is this the library it was
// five seconds ago", and a mismatch between the two answers is unexplainable.
function browseItemIdentity(it) {
  return it ? (it.title || "") + "||" + (it.subtitle || "") : "";
}

// One cheap library-change probe (2-3 count:1 round-trips): is the album count,
// the first album or the last album different from our built snapshot? Returns
// true when something changed. No side effects — the caller decides whether to
// rebuild.
//
// This is the question the ten-minute watch repeats, and its cheapness is what
// makes that interval affordable.
async function libraryChangedSince() {
  return await withBrowseSession(async (sessionKey) => {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
    const total = head.list && head.list.count ? head.list.count : 0;
    const identity = browseItemIdentity;
    const firstNow = identity(head.items && head.items[0]);
    const firstIdx = identity(albumIndex.albums[0]);
    let lastChanged = false;
    if (total > 1 && albumIndex.count > 1 && total === albumIndex.count) {
      const tail = await load({ hierarchy: "albums", offset: total - 1, count: 1, multi_session_key: sessionKey });
      lastChanged = identity(tail.items && tail.items[0]) !== identity(albumIndex.albums[albumIndex.count - 1]);
    }
    return total !== albumIndex.count || (albumIndex.count > 0 && firstNow !== firstIdx) || lastChanged;
  });
}

// How often the extension asks Roon, entirely on its own, whether the library
// moved.
//
// This is the ONLY detector that needs nobody. The other one is opportunistic —
// it rides along on `nav.total` when a user opens an album — so on a box that
// is sitting idle, or one being used only from Home and Now playing, it never
// fires at all. This interval was TWELVE HOURS, which is why "I added albums to
// Roon and the extension did nothing" was the normal experience rather than an
// edge case: with nobody opening albums, twelve hours was the detection time.
//
// Ten minutes is affordable because the QUESTION is cheap and the answer is
// almost always no: `libraryChangedSince()` is 2-3 browse round-trips (~430 a
// day), and the expensive part — the settle probe and the full re-walk — still
// only happens when something actually changed.
function libraryCheckMs() { return 10 * 60 * 1000; }

// How many samples the import probe takes, IMPORT_SETTLE_MS apart. Two is one
// window and is not enough: Roon imports in bursts, and any burst gap longer
// than the window reads as finished. Three costs another five seconds on a code
// path that already refuses to run while somebody is waiting.
function importSettleReads() { return 3; }

// Best-effort "is Roon importing right now?" — read the album count, wait a few
// seconds, read it again; a changed count means the library is actively growing.
// Only called when we're about to start heavy work, never in a loop — the
// ten-minute watch runs the CHEAP probe (libraryChangedSince) and reaches this
// one only once that says something moved. This is how the extension honors
// "never scan while Roon is adding albums": the manual Rescan, the watch and
// the recheck chain all consult it.
async function libraryIsImporting() {
  if (!core) return false;
  try {
    return await withBrowseSession(async (sessionKey) => {
      const identity = browseItemIdentity;
      // One sample = the album count PLUS the identity of the first and last
      // rows. The count on its own only answers "is Roon still ADDING albums".
      // The identities are what carry the other half of the question: Roon
      // identifies an album AFTER importing it, and identification rewrites its
      // title and artist, which reorders an alphabetical list around it. Roon
      // publishes no import-finished event of any kind, so this is inference
      // from the little the browse API will tell us — good evidence that work
      // is still happening, never a proof that it has stopped.
      const sample = async () => {
        await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
        const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
        const total = head.list && head.list.count ? head.list.count : 0;
        let tail = "";
        if (total > 1) {
          const t = await load({ hierarchy: "albums", offset: total - 1, count: 1, multi_session_key: sessionKey });
          tail = identity(t.items && t.items[0]);
        }
        return total + "|" + identity(head.items && head.items[0]) + "|" + tail;
      };
      let prev = await sample();
      // Sampled more than twice on purpose. A single 5-second window calls a
      // BATCHED import settled during any pause between batches, and Roon
      // imports in bursts — that is precisely the case that got the snapshot
      // rebuilt halfway through and left the user with missing albums.
      for (let i = 1; i < importSettleReads(); i++) {
        await new Promise(r => setTimeout(r, IMPORT_SETTLE_MS));
        const now = await sample();
        if (now !== prev) return true;
        prev = now;
      }
      return false;
    });
  } catch (e) { return false; }   // probe blip — don't block work on a transient error
}

// The library-refresh decision, shared by the 12h auto-check and the manual
// Rescan button. Rebuilds the snapshot ONLY when the library changed AND Roon
// is not mid-import. `force` (manual Rescan) rebuilds even if nothing changed,
// but STILL refuses while Roon is importing — a deliberate press must not fight
// an active import. Returns a status the UI can toast.
let _rebuildInFlight = false;
async function checkAndMaybeRebuild(reason, force) {
  if (!core) return { status: "unpaired" };
  if (albumIndex.building || _rebuildInFlight) return { status: "busy" };
  _rebuildInFlight = true;
  try {
    let changed = force;
    try {
      if (!changed) changed = await libraryChangedSince();
    } catch (e) { return { status: "error" }; }

    if (!changed) {
      if (_statusSync) { _statusSync = ""; pushStatus(); }
      return { status: "fresh" };
    }
    if (await libraryIsImporting()) {
      console.log("[index] " + reason + " check: library changed but Roon is still importing — refresh paused");
      _statusSync = "  •  Roon importing — library refresh paused"; pushStatus();
      // THE gap this version closes. Declining to rebuild during an import is
      // right; leaving it at that was not. The timer here is a plain 12-hour
      // interval, so an import caught by one tick left the snapshot stale until
      // the NEXT tick — up to twelve hours after Roon finished, with every
      // album open in between hitting stale offsets and empty action lists.
      // That is why the symptom persisted instead of clearing itself.
      scheduleLibraryRecheck("Roon was importing at the " + reason + " check");
      return { status: "importing" };
    }
    console.log("[index] " + reason + " check: library changed and settled — rebuilding snapshot once");
    clearBrowseOffsetCache();
    // The flag tracks the SNAPSHOT build and nothing else. Chaining the labels
    // map into the same .then/.catch made a throw from rebuildLabelsMap report
    // the whole rebuild as failed — so a perfectly rebuilt snapshot returned
    // "error", kickPostRebuildChain never fired, and every dependant stayed
    // stale. That is the exact failure this version exists to fix, re-created
    // one line away from the fix.
    let built = true;
    await buildAlbumIndex().catch(() => { built = false; });   // error logged in buildAlbumIndex
    if (built && labelsEnabled) {
      try { rebuildLabelsMap(); }
      catch (e) { console.error("[index] labels map rebuild after " + reason + ": " + e.message); }
    }
    // A rebuild that threw leaves the OLD snapshot in place — buildAlbumIndex
    // only assigns albums/count/declared once a full walk succeeds. Reporting
    // "rebuilt" anyway told the recheck chain the episode was over and cleared
    // the "Roon importing" banner, so a library that failed to refresh went
    // quiet and stayed stale until the next 12-hour tick. "error" is the truth
    // and is one of the two statuses that re-arm the chain.
    if (!built) return { status: "error" };
    if (_statusSync) { _statusSync = ""; pushStatus(); }
    return { status: "rebuilt", count: albumIndex.count };
  } finally {
    _rebuildInFlight = false;
  }
}

// Background maintenance: build the snapshot once on pair (if empty), then
// watch for new albums every ten minutes. No rebuild ever fires from a user
// action or a play — only this timer, the recheck chain it hands off to, or the
// manual Rescan button, and never while Roon is importing.
function startIndexMaintenance() {
  stopIndexMaintenance();
  _statusSync = "";
  // The index survives an unpair (it's plain offset/title data), so it stays
  // usable for search while disconnected. Build only when there's no snapshot
  // yet (first pair).
  if (!isIndexBuilt()) {
    buildAlbumIndex()
      .then(() => runFileMetadataScan("first pair"))
      .then(() => { if (labelsEnabled) seedLabelsFromCache(); })
      .catch(e => { if (DEBUG) console.error("[index] initial build:", e.message); });
  } else {
    // A re-pair with an existing snapshot asks again in five minutes. The
    // comment that used to sit here claimed startIndexMaintenance already
    // "re-verifies it on re-pair with a cheap 2-call probe"; it never did.
    // That mattered because an unpair CLEARS any pending recheck, and a
    // websocket flap is most likely during exactly the heavy import the
    // recheck was waiting on — so the refresh silently dropped from five
    // minutes back to the next 12-hour tick.
    scheduleLibraryRecheck("re-paired with an existing snapshot");
  }
  indexMaintTimer = setInterval(() => {
    // Skip entirely while somebody else owns the library. A pending recheck is
    // already asking this exact question on a schedule of its own, and a
    // rebuild in flight would answer "busy" — probing underneath either only
    // adds calls to a Core that is already working. The guard is read
    // synchronously and checkAndMaybeRebuild sets _rebuildInFlight before its
    // first await, so two ticks cannot both get past it.
    if (_libraryRecheckTimer || _rebuildInFlight || albumIndex.building) return;
    checkAndMaybeRebuild("watch", false)
      .then(r => {
        kickPostRebuildChain(r);
        // Neither is an answer. Handing off to the recheck chain is what stops
        // the observation being lost until the next tick — the same reason the
        // importing branch hands off.
        if (r && (r.status === "busy" || r.status === "error")) {
          scheduleLibraryRecheck("watch check returned " + r.status);
        }
      })
      .catch(e => console.error("[index] watch check failed: " + e.message));
  }, libraryCheckMs());
  if (indexMaintTimer.unref) indexMaintTimer.unref();
}

// How long to wait before looking again after seeing the library move. Long
// enough that a long import is not probed to death (each recheck costs a
// 2-3 call probe plus, if it proceeds, a 5-second settle read), short enough
// that a finished import is picked up in minutes rather than half a day.
function libraryRecheckMs() { return 5 * 60 * 1000; }
// The ceiling on chained rechecks. An import that runs for hours re-arms this
// each time it is still moving; without a cap a permanently-churning library
// would probe every five minutes forever.
function libraryRecheckMax() { return 24; }
// How long the chain must be completely idle before the next recheck counts as
// a NEW episode with a full budget. Comfortably longer than the 5-minute chain,
// so a running episode can never refill itself mid-flight and walk around the
// cap the way resetting on "rebuilt" did.
function libraryRecheckIdleMs() { return 30 * 60 * 1000; }

let _libraryRecheckTimer = null;
let _libraryRecheckCount = 0;
let _libraryRecheckLast = 0;

// The automatic rebuild stops at the album snapshot. Everything BUILT ON that
// snapshot — the Qobuz/TIDAL source badges, the Genre facet, the decade and
// quality data harvested from file tags, the label map — is refreshed only by
// the chain the manual Rescan button runs. Without this the automatic path
// brought back the right albums wearing last week's metadata, which reads as
// the auto-rescan not having run at all.
function kickPostRebuildChain(r) {
  if (!r || r.status !== "rebuilt") return;
  rescanChain(r, "auto rescan", false).catch(e =>
    console.error("[index] auto rescan chain: " + e.message));
}
// Ask again in a few minutes, once. Called when something OBSERVED that the
// library has moved: the 12-hour check finding an import in progress, or an
// ordinary album open noticing Roon's live count no longer matches the
// snapshot. Both are evidence; neither is a reason to rebuild inline, because
// a rebuild is a full re-walk and these fire while somebody is waiting.
function scheduleLibraryRecheck(why) {
  if (_libraryRecheckTimer) return;                       // one pending, ever
  const now = Date.now();
  // The budget is per EPISODE, and an idle gap is what ends one. Refilling it
  // ONLY on "fresh" made exhaustion permanent: at the cap nothing can be
  // scheduled, so no recheck can fire, so no "fresh" can ever arrive to refill
  // it. The fast path died for the lifetime of the container — silently, with
  // the 12-hour tick still running so nothing looked broken — and every later
  // import was back to waiting up to twelve hours. The counter is global and
  // is not refunded on "rebuilt" either, so roughly two dozen ordinary
  // automatic rescans were enough to reach it on a long-lived install.
  if (_libraryRecheckLast && now - _libraryRecheckLast >= libraryRecheckIdleMs()) {
    _libraryRecheckCount = 0;
  }
  if (_libraryRecheckCount >= libraryRecheckMax()) return;
  _libraryRecheckCount++;
  _libraryRecheckLast = now;
  console.log("[index] recheck scheduled in " + Math.round(libraryRecheckMs() / 60000) +
              " min (" + why + ")");
  _libraryRecheckTimer = setTimeout(() => {
    _libraryRecheckTimer = null;
    checkAndMaybeRebuild("auto", false)
      .then(r => {
        const st = r && r.status;
        // A snapshot rebuilt in the background has to drag its dependants with
        // it, exactly as the manual Rescan button does.
        if (st === "rebuilt") kickPostRebuildChain(r);
        // Only "fresh" — the library genuinely matches — ends the episode and
        // returns a full budget. Resetting on "rebuilt" too meant the cap
        // could never engage: any rebuild refilled it, so a library whose
        // count never settles could re-walk itself every five minutes forever.
        if (st === "fresh") { _libraryRecheckCount = 0; return; }
        // Dropped because something else was already working, or the probe
        // failed. Neither is an answer, so the question has to be asked again
        // rather than silently abandoned until the 12-hour tick.
        if (st === "busy" || st === "error") scheduleLibraryRecheck("previous check returned " + st);
      })
      .catch(e => console.error("[index] auto recheck failed: " + e.message));
  }, libraryRecheckMs());
  if (_libraryRecheckTimer.unref) _libraryRecheckTimer.unref();
}
function stopIndexMaintenance() {
  if (_libraryRecheckTimer) { clearTimeout(_libraryRecheckTimer); _libraryRecheckTimer = null; }
  _libraryRecheckCount = 0;
  _libraryRecheckLast = 0;
  if (indexMaintTimer) { clearInterval(indexMaintTimer); indexMaintTimer = null; }
}


// ---- Matching -------------------------------------------------------------
// Earliest index i where qTokens[k] is a prefix of tokens[i+k] for every k
// (a consecutive run). Returns that start index, or -1.
//   tokens=["the","the"], qTokens=["the","t"]  -> 0   (this is the "The The" case)
function consecutivePrefixStart(tokens, qTokens) {
  const last = tokens.length - qTokens.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let k = 0; k < qTokens.length; k++) {
      if (!tokens[i + k].startsWith(qTokens[k])) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}
// Every query token is a prefix of some distinct title token (order-independent),
// so "dark moon" still finds "Dark Side of the Moon".
function allTokensPrefixSomewhere(tokens, qTokens) {
  const used = new Array(tokens.length).fill(false);
  for (const qt of qTokens) {
    let found = false;
    for (let i = 0; i < tokens.length; i++) {
      if (!used[i] && tokens[i].startsWith(qt)) { used[i] = true; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}
// Loose typo tolerance: all chars of q appear in order within s.
function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

// Higher score = better match. Title hits outrank artist hits of similar
// quality; exact/prefix outrank substring; fuzzy is a last resort.
function scoreAlbum(al, q, qTokens, qJoined, singleChar) {
  let s = 0;

  // ---- Title (primary) ----
  if (al.nTitle === q) return 1000;
  if (al.nTitle.startsWith(q)) {
    s = Math.max(s, 920 - Math.min(al.nTitle.length - q.length, 60));
  }
  {
    const start = consecutivePrefixStart(al.tTitle, qTokens);
    if (start === 0)                   s = Math.max(s, 900 - Math.min(al.tTitle.length, 40));
    else if (start > 0 && !singleChar) s = Math.max(s, 820 - start * 4);
  }
  if (al.jTitle.startsWith(qJoined)) {
    s = Math.max(s, 870 - Math.min(al.jTitle.length - qJoined.length, 60));
  }
  if (!singleChar) {
    if (s < 760 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tTitle, qTokens)) {
      s = Math.max(s, 760);
    }
    if (s < 650 && al.nTitle.includes(q)) {
      s = Math.max(s, 650 - Math.min(al.nTitle.indexOf(q), 40));
    }
  }

  // ---- Artist (secondary) ----
  if (al.nArtist) {
    if (al.nArtist === q)         s = Math.max(s, 770);
    if (al.nArtist.startsWith(q)) s = Math.max(s, 740 - Math.min(al.nArtist.length - q.length, 60));
    {
      const start = consecutivePrefixStart(al.tArtist, qTokens);
      if (start === 0)                   s = Math.max(s, 720 - Math.min(al.tArtist.length, 40));
      else if (start > 0 && !singleChar) s = Math.max(s, 660 - start * 4);
    }
    if (al.jArtist.startsWith(qJoined)) s = Math.max(s, 700 - Math.min(al.jArtist.length - qJoined.length, 60));
    if (!singleChar) {
      if (s < 600 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tArtist, qTokens)) s = Math.max(s, 600);
      if (s < 520 && al.nArtist.includes(q)) s = Math.max(s, 520 - Math.min(al.nArtist.indexOf(q), 40));
    }
  }

  // ---- Fuzzy fallback (typos), only for longer queries with no real hit ----
  if (s === 0 && !singleChar && qJoined.length >= 4) {
    if (isSubsequence(qJoined, al.jTitle))       s = 300;
    else if (isSubsequence(qJoined, al.jArtist)) s = 260;
  }

  return s;
}

function searchLabels(q) {
  if (!q || !labelsIndex.map.size) return [];
  const out = [];
  for (const [, entry] of labelsIndex.map) {
    if (!entry.display) continue;
    const norm = normalize(entry.display);
    if (!norm.includes(q)) continue;
    out.push({
      display:    entry.display,
      albumCount: entry.albums ? entry.albums.length : 0,
      logo_url:   entry.logo_url || null
    });
  }
  out.sort((a, b) => {
    const aq = normalize(a.display).startsWith(q) ? 0 : 1;
    const bq = normalize(b.display).startsWith(q) ? 0 : 1;
    return aq - bq || b.albumCount - a.albumCount;
  });
  return out.slice(0, 10);
}

function searchArtists(q) {
  if (!q || !albumIndex.albums.length) return [];
  const seen = new Map(); // normalised name → { name, n, count }
  for (const al of albumIndex.albums) {
    // artistNames is precomputed at index-build time (split + normalized once).
    const names = al.artistNames;
    if (!names || !names.length) continue;
    for (const { name, n } of names) {
      if (!n.includes(q)) continue;
      if (seen.has(n)) seen.get(n).count++;
      else seen.set(n, { name, n, count: 1 });
    }
  }
  return [...seen.values()]
    .sort((a, b) => {
      const aq = a.n.startsWith(q) ? 0 : 1;
      const bq = b.n.startsWith(q) ? 0 : 1;
      return aq - bq || b.count - a.count;
    })
    .slice(0, 8);
}

function searchAlbums(query, limit) {
  const q = normalize(query);
  if (!q) return [];
  const qTokens    = q.split(" ").filter(Boolean);
  const qJoined    = q.replace(/ /g, "");
  const singleChar = qJoined.length <= 1;

  const out = [];
  for (const al of albumIndex.albums) {
    const score = scoreAlbum(al, q, qTokens, qJoined, singleChar);
    if (score > 0) out.push({ al, score });
  }
  out.sort((a, b) =>
    b.score - a.score ||
    a.al.nTitle.localeCompare(b.al.nTitle) ||
    a.al.nArtist.localeCompare(b.al.nArtist)
  );
  return out.slice(0, limit).map(({ al, score }) => withSource({
    offset:    al.offset,
    title:     al.title,
    subtitle:  al.subtitle,
    image_key: al.image_key,
    score
  }, al));
}

// ---------------------------------------------------------------------------
// Pitchfork magazine — browsable listings of recent album reviews and Best New
// Music (the side-menu "Pitchfork" page).
//
// PRIMARY source (both tabs): the listing pages' server-rendered
// window.__PRELOADED_STATE__ (/reviews/albums/, /reviews/best/albums/), whose
// review items carry everything a card needs — title (dangerousHed), artist
// (subHed.name), numeric score + Best-New-Music flag (ratingValue), square
// cover art (image.sources) and pubDate. The parse matches items on shape
// (contentType "review" + ratingValue + url), not a fixed JSON path, so a
// container reshuffle degrades to an empty list rather than crashing; results
// are sorted newest-first by pubDate (the walk's traversal order is not the
// page's display order).
//
// FALLBACK (Latest tab only): the RSS album-reviews feed — title/cover/date
// but no score or artist (artist is derived from the URL slug). Used when the
// listing yields nothing (blocked or reshaped page). Best New Music has no
// equivalent feed. If every source fails, the route errors so the UI shows an
// honest "couldn't load" instead of an empty page.
//
// Cached 6h per tab, non-empty results only — Pitchfork publishes only a few
// reviews a day. Reuses the same spoofed browser UA + 1 req/s throttle as the
// single-review scraper (fetchPitchfork).
// ---------------------------------------------------------------------------
const PITCHFORK_LIST_TTL   = 6 * 60 * 60 * 1000;
// Per-tab listing cache. Deliberately NOT makeTtlCache: we must NOT cache an
// EMPTY result (a parse miss or a served-but-unparseable page), or a recovery
// would be blocked for the whole TTL. Only non-empty results are stored.
const pitchforkLists       = new Map();  // type → { at, items }

const PF_HEADERS = { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" };

function unCdata(s) {
  return s == null ? s : String(s).replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

// Best-effort artist name from a review URL when the listing parse didn't give
// a clean one: the slug is "<artist>-<album>", so strip the known album-slug
// suffix and title-case what's left. Fallback only — casing is approximate.
function artistFromReviewUrl(url, albumTitle) {
  const m = /\/reviews\/albums\/([^\/?#]+)/.exec(url || "");
  if (!m) return null;
  let artistSlug = m[1];
  const albumSlug = slugifyForPitchfork(albumTitle || "");
  if (albumSlug && artistSlug.endsWith("-" + albumSlug)) {
    artistSlug = artistSlug.slice(0, artistSlug.length - albumSlug.length - 1);
  }
  const words = artistSlug.split("-").filter(Boolean);
  if (!words.length) return null;
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Parse the RSS album-reviews feed → [{ url, album, cover, date }].
async function fetchPitchforkRss() {
  await pitchforkWait();
  const xml = await httpText("https://pitchfork.com/feed/feed-album-reviews/rss", PF_HEADERS, 15000);
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let im;
  while ((im = itemRe.exec(xml)) !== null) {
    const block = im[0];
    const pick = (re) => { const x = re.exec(block); return x ? unCdata(x[1]) : null; };
    const link = pick(/<link>([\s\S]*?)<\/link>/i);
    if (!link || !/\/reviews\/albums\//.test(link)) continue;
    // stripHtml entity-decodes internally; decoding FIRST would let an escaped
    // "&lt;em&gt;" in a title turn into a strippable tag and lose literal text.
    const album = stripHtml(pick(/<title>([\s\S]*?)<\/title>/i) || "").trim();
    const cover = (/<media:thumbnail[^>]*\burl=["']([^"']+)["']/i.exec(block) || [])[1] || null;
    const date  = pick(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (album) items.push({ url: link.split(/[?#]/)[0], album, cover, date });
  }
  return items;
}

// Extract window.__PRELOADED_STATE__ = {...} via brace-matching (a greedy regex
// can't balance braces reliably on a ~2 MB page).
function extractPreloadedState(html) {
  const marker = html.indexOf("__PRELOADED_STATE__");
  if (marker === -1) return null;
  const start = html.indexOf("{", marker);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

// Square cover URL from a listing item's image.sources. lg (~1280px) first —
// plenty for the biggest mosaic tile without pulling the oversized xxl; then
// xxl, md, sm as availability fallbacks.
function pfListingCover(node) {
  const s = node.image && node.image.sources;
  if (!s || typeof s !== "object") return null;
  return (s.lg && s.lg.url) || (s.xxl && s.xxl.url) || (s.md && s.md.url) || (s.sm && s.sm.url) || null;
}

// Walk the preloaded state and collect review-listing items. Verified shape
// (2026): each item has contentType "review", a ratingValue object, a url, the
// title in dangerousHed (HTML) — bare `hed` only exists nested under `source` —
// the artist in subHed.name, and square covers under image.sources.{lg,md,sm}.
// Matching on contentType + ratingValue + url (not a fixed path) keeps it
// resilient to container reshuffles.
function collectReviewItems(state) {
  const out = [];
  const seen = new Set();
  const stack = [state];
  let guard = 0;
  while (stack.length && guard++ < 500000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { for (const x of node) if (x && typeof x === "object") stack.push(x); continue; }
    if (node.contentType === "review" && node.ratingValue && typeof node.url === "string") {
      const full = (node.url.startsWith("http") ? node.url : "https://pitchfork.com" + node.url).split(/[?#]/)[0];
      if (!seen.has(full)) {
        seen.add(full);
        // Title: dangerousHed (HTML), falling back to source.hed (markdown-ish
        // asterisks) — tested AFTER stripping, so an empty/HTML-only
        // dangerousHed still consults the fallback. Non-strings are ignored
        // rather than stringified ("[object Object]" must never render).
        // stripHtml already entity-decodes, so no extra decode pass.
        let album = "";
        if (typeof node.dangerousHed === "string") album = stripHtml(node.dangerousHed).trim();
        if (!album && node.source && typeof node.source.hed === "string") {
          album = node.source.hed.replace(/\*/g, "").trim();
        }
        const artist = (node.subHed && typeof node.subHed.name === "string") ? node.subHed.name.trim() : null;
        const rv = node.ratingValue;
        const score = (rv.score != null && rv.score !== "") ? parseFloat(rv.score) : null;
        out.push({
          url:            full,
          album,
          artist,
          score:          Number.isFinite(score) ? score : null,
          isBestNewMusic: !!(rv.isBestNewMusic || rv.isBestNewReissue),
          cover:          pfListingCover(node),
          date:           node.pubDate || null
        });
      }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === "object") stack.push(v); }
  }
  return out;
}

async function fetchPitchforkListing(path) {
  await pitchforkWait();
  const html = await httpText("https://pitchfork.com" + path, PF_HEADERS, 15000);
  const raw = extractPreloadedState(html);
  if (!raw) { if (DEBUG) console.error("[pitchfork] no preloaded state in", path); return []; }
  let state;
  try { state = JSON.parse(raw); }
  catch (e) { if (DEBUG) console.error("[pitchfork] state parse failed:", e.message); return []; }
  return collectReviewItems(state);
}

function pfItemOut(x) {
  return {
    url:            x.url,
    album:          x.album || "",
    artist:         x.artist || null,
    cover:          x.cover || null,
    score:          x.score != null ? x.score : null,
    isBestNewMusic: !!x.isBestNewMusic,
    date:           x.date || null
  };
}

// The listing page carries everything we need (title, artist, score, BNM,
// square cover), so it's the primary source for both tabs, sorted newest-first
// by pubDate (the state walk's traversal order is oldest-first — verified
// against the live pages). For the Latest tab only, if the listing FAILS —
// network error/403 (the realistic scraper-block case) or a parse that yields
// nothing — fall back to the RSS feed: covers + title, artist derived from the
// slug, no score. Best New Music has no equivalent feed. Only when every
// available source has failed does this throw, so the route 500s and the UI
// shows an honest "couldn't load" instead of an empty page.
async function buildPitchforkList(type) {
  if (type === "best") {
    return sortPfNewestFirst(
      (await fetchPitchforkListing("/reviews/best/albums/")).map(pfItemOut).filter(it => it.album));
  }
  let listErr = null;
  let items = [];
  try {
    items = (await fetchPitchforkListing("/reviews/albums/")).map(pfItemOut).filter(it => it.album);
  } catch (e) { listErr = e; /* fall through to the RSS fallback below */ }
  if (items.length) return sortPfNewestFirst(items);
  const rss = await fetchPitchforkRss().catch(e => {
    if (DEBUG) console.error("[pitchfork] rss fallback failed:", e.message);
    return [];
  });
  const out = rss
    .map(r => pfItemOut({ url: r.url, album: r.album, artist: artistFromReviewUrl(r.url, r.album),
                          cover: r.cover, date: r.date }))
    .filter(it => it.album);
  if (!out.length && listErr) throw listErr;   // both sources down — surface the error
  return out;   // RSS document order is already newest-first
}

// Stable newest-first sort on ISO pubDate (lexicographic compare is correct
// for ISO-8601); undated items keep their relative order at the end.
function sortPfNewestFirst(items) {
  return items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

const pitchforkListPending = new Map();   // type → in-flight build Promise
async function getPitchforkReviews(type) {
  const hit = pitchforkLists.get(type);
  if (hit && (Date.now() - hit.at) < PITCHFORK_LIST_TTL) return hit.items;
  // In-flight dedup: concurrent cache misses (a tab open racing a global
  // search, or two searches) share one scrape instead of each hitting Pitchfork.
  if (pitchforkListPending.has(type)) return pitchforkListPending.get(type);
  const pending = (async () => {
    try {
      const items = await buildPitchforkList(type);
      // Cache only a non-empty result — an empty list means a parse miss or a
      // served-but-unparseable page, which we want to retry (not lock in for 6h).
      if (items.length) pitchforkLists.set(type, { at: Date.now(), items });
      return items;
    } finally {
      pitchforkListPending.delete(type);
    }
  })();
  pitchforkListPending.set(type, pending);
  return pending;
}

// Match the query against the cached review lists (both tabs, deduped by URL).
// Cold cache triggers ONE shared scrape via the dedup above; a blocked/failed
// source just yields no Pitchfork section rather than failing the search.
async function searchPitchforkReviews(q, limit) {
  const nq = normalize(q);
  if (!nq) return [];
  const [latest, best] = await Promise.all([
    getPitchforkReviews("latest").catch(() => []),
    getPitchforkReviews("best").catch(() => [])
  ]);
  const seen = new Set();
  const out = [];
  for (const it of [...latest, ...best]) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    if (normalize(it.album).includes(nq) || normalize(it.artist || "").includes(nq)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Confident library match for a review's album/artist, or null. Uses the same
// in-memory search as the search box, but only accepts the top hit when the
// album title matches closely (normalized equality or a prefix) so a "Play"
// button never points at the wrong album.
function matchLibraryAlbum(album, artist) {
  if (!album || !albumIndex.albums.length) return null;
  const hits = searchAlbums((artist ? artist + " " : "") + album, 3);
  const want = normalize(album);
  if (!want) return null;   // a punctuation-only title normalizes to "" — never match
  for (const h of hits) {
    const got = normalize(h.title);
    if (!got) continue;     // guard: "".startsWith("") etc. would false-match
    if (got === want || got.startsWith(want) || want.startsWith(got)) {
      return { offset: h.offset, title: h.title, subtitle: h.subtitle, image_key: h.image_key };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Express HTTP API
// ---------------------------------------------------------------------------
const app = express();
// 1 MB, not express's 100 kb default: /api/play-multi now accepts up to 400
// albums, each carrying {offset,title,subtitle}. A classical library with long
// work titles and long performer credits runs ~250 bytes an item, which clears
// 100 kb — and express answers that with an HTML 413 the client can only
// render as a generic "Roon refused that".
app.use(express.json({ limit: "1mb" }));
// API request tracing (DEBUG): method, path, status, duration — one line per
// user action. The steady pollers are excluded: they'd bury everything else
// under a line every 1.5s (zone-state) and per art tile (image).
const TRACE_SKIP = /^\/api\/(zone-state|zones$|image\/|update\/status|settings\/tidal\/status|settings\/display|labels-scan-status|search-status)/;
app.use((req, res, next) => {
  if (!DEBUG || !req.path.startsWith("/api/") || TRACE_SKIP.test(req.path)) return next();
  const t0 = Date.now();
  res.on("finish", () => {
    console.log("[http]", req.method, req.originalUrl, "->", res.statusCode, (Date.now() - t0) + "ms");
  });
  next();
});
// Gzip responses (app.js is ~230KB, style.css ~120KB — ~70% smaller on the
// wire). Images are already binary (jpeg) so compression skips them.
app.use(compression());
// Static assets: html/js/css stay no-cache so every load revalidates (ETag
// 304s make that one cheap request each) — this app is upgraded constantly,
// and a time-based cache can serve NEW index.html with OLD app.js after an
// upgrade (the exact element-ID mismatch class the pre-flight guards against).
// Anything else (icons, fonts) may cache for an hour.
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

app.get("/api/status", (req, res) => {
  res.json({
    paired:    !!core,
    core_id:   core ? core.core_id      : null,
    core_name: core ? core.display_name : null,
    zone_count: Object.keys(zones).length,
    // The extension has always known when it last saw Roon importing — it just
    // had nowhere to say it. `_statusSync` went only to Roon's own Settings →
    // Extensions line, so the app itself could not tell a user why albums were
    // misbehaving. It is a LAGGING indicator (set at the last check, cleared on
    // the next clean one), so it is reported as an observation with a time
    // rather than as a claim about right now.
    library_importing: !!_statusSync,
    library_recheck_pending: !!_libraryRecheckTimer,
    index_built_at: albumIndex.builtAt || null,
    index_count: albumIndex.count || 0
  });
});

// Roon's per-zone playback modes, normalised so no client has to cope with a
// missing `settings` block (a zone that has never been played doesn't get one).
// `loop` keeps Roon's own vocabulary: "disabled" | "loop" (whole queue) |
// "loop_one" (repeat this track). Anything unrecognised reads as off rather
// than being passed through — a value we can't render is worse than off.
function zoneSettings(zone) {
  const s = (zone && zone.settings) || {};
  const loop = (s.loop === "loop" || s.loop === "loop_one") ? s.loop : "disabled";
  return { shuffle: !!s.shuffle, loop, auto_radio: !!s.auto_radio };
}

// One output as the client sees it. `can_group_with_output_ids` is Roon's own
// answer to "what may this be grouped with" — it isn't in the vendored SDK's
// JSDoc but it is part of the Output object on the wire. When the Core doesn't
// send it we return null, which the client reads as "unknown, offer everything"
// rather than "nothing is groupable".
function outputInfo(o) {
  return {
    output_id:    o.output_id,
    zone_id:      o.zone_id || null,
    display_name: o.display_name || "",
    can_group_with_output_ids: Array.isArray(o.can_group_with_output_ids)
      ? o.can_group_with_output_ids.slice()
      : null,
    source_controls: sourceControls(o)
  };
}

// An output's source controls — Roon's handle on the physical device behind it:
// the amp or DAC that can be put into standby, or switched to its Roon input.
//
// Only controls we can actually DO something with are returned. A control with
// no `control_key` can't be addressed individually, and Roon's toggle_standby
// is defined per control, so a keyless control would render a power button that
// silently does nothing. `supports_standby` is Roon's own answer for the power
// half; the convenience-switch half needs no capability flag.
function sourceControls(o) {
  const list = Array.isArray(o && o.source_controls) ? o.source_controls : [];
  return list
    .filter(sc => sc && sc.control_key)
    .map(sc => ({
      control_key:      sc.control_key,
      display_name:     sc.display_name || o.display_name || "",
      // 'selected' | 'deselected' | 'standby' | 'indeterminate'. Anything we
      // don't recognise reads as indeterminate: the UI then offers the action
      // without claiming to know the current state.
      status:           ["selected", "deselected", "standby"].includes(sc.status)
        ? sc.status : "indeterminate",
      supports_standby: !!sc.supports_standby
    }));
}

app.get("/api/zones", (req, res) => {
  const list = Object.values(zones).map(z => ({
    zone_id:      z.zone_id,
    display_name: z.display_name,
    state:        z.state,
    settings:     zoneSettings(z),
    outputs: (z.outputs || []).map(outputInfo)
  })).sort((a, b) => a.display_name.localeCompare(b.display_name));
  res.json({ zones: list });
});

// Every output the Core knows about, for the zone-grouping sheet. Served from
// the outputs cache (subscribe_outputs), falling back to the outputs carried by
// the zone feed so this still answers on a Core that never subscribed us.
app.get("/api/outputs", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const src = Object.keys(outputs).length
    ? Object.values(outputs)
    : Object.values(zones).reduce((acc, z) => acc.concat(z.outputs || []), []);
  const zoneName = (zid) => (zones[zid] && zones[zid].display_name) || "";
  const list = src.map(o => Object.assign(outputInfo(o), { zone_name: zoneName(o.zone_id) }))
                  .sort((a, b) => a.display_name.localeCompare(b.display_name));
  res.json({ outputs: list });
});

// Read an optional genre/tag filter from query params (or POST body).
// `filter_parent` (genre only) selects a SUB-genre nested under a parent genre
// — e.g. parent "Pop/Rock", value "Heavy Metal".
function parseFilter(src) {
  const type   = (src.filter_type   || "").trim();
  const value  = (src.filter_value  || "").trim();
  const parent = (src.filter_parent || "").trim();
  if (!type || !value) return null;
  if (type !== "genre" && type !== "tag" && type !== "label" && type !== "decade") return null;
  const f = { type, value };
  if (type === "genre" && parent) f.parent = parent;
  return f;
}

// Decades that actually have albums, from the per-album years collected during
// scanning / browsing. Purely in-memory (no Roon call); populates gradually.
//
// Counted over the LIBRARY, not over the year cache. The cache is keyed by
// album identity and is never pruned, so it also holds years for albums the
// user has removed and — via /api/album/extras — for Qobuz releases they merely
// looked at and don't own. Counting its values advertised totals this filter
// could not deliver, since the filter itself (like the Focus sheet) resolves
// years per album through albumYearOf.
app.get("/api/filters/decades", async (req, res) => {
  // Counting over the library means the library has to exist. Answer 503 while
  // it doesn't, exactly as /api/library/facets does — an empty decade list and
  // "not ready yet" are very different answers, and returning [] for both told
  // the user their library has no dated albums during every restart window.
  if (!core && !isIndexBuilt()) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  // ensureAlbumIndex only builds when the snapshot is EMPTY (first pair), so
  // this can't trigger a Roon scan on an ordinary user action.
  await ensureAlbumIndex();
  if (!isIndexBuilt()) return res.status(503).json({ error: "Library index is still building" });
  const counts = new Map();
  for (const al of albumIndex.albums) {
    const y = albumYearOf(al);
    if (y === null) continue;
    const d = Math.floor(y / 10) * 10;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const decades = [...counts.entries()]
    .sort((a, b) => b[0] - a[0]) // newest first
    .map(([d, n]) => ({ title: d + "s", subtitle: n.toLocaleString() + (n === 1 ? " album" : " albums") }));
  res.json({ decades });
});

app.get("/api/artist-albums", (req, res) => {
  const artist = (req.query.artist || "").trim();
  if (!artist) return res.status(400).json({ error: "artist required" });
  if (!albumIndex.count) return res.json({ artist, primary: [], featured: [] });
  // EQUALITY on whole credited names, never substring: "jordan prince" and
  // 'bonnie "prince" billy' both CONTAIN "prince" and used to be listed as
  // Prince appearances. An empty query is refused for the same reason
  // albumKey() refuses blank titles — a punctuation-only name normalises to ""
  // and would otherwise match the entire library.
  const q = canonArtist(artist);
  if (!q) return res.json({ artist, primary: [], featured: [] });
  const primary = [], featured = [];
  for (const al of albumIndex.albums) {
    if (al.cArtist === undefined) applyCreditIdentities(al);   // record built outside the pass
    const names = al.cCredits;
    if (names ? !names.includes(q) : al.cArtist !== q) continue;
    // Credited as the whole credit or the lead artist → their own album;
    // credited further along → an appearance.
    if (q === al.cArtist || q === al.cFirst) primary.push(al);
    else featured.push(al);
  }
  primary.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  featured.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  const slim = (al) => withSource({
    offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null
  }, al);
  res.json({ artist, primary: primary.map(slim), featured: featured.map(slim) });
});

// Artist header bio for the artist-albums view. Wraps the wall display's
// validated lookup (Qobuz/Tidal album-matched first, then album-cross-checked
// Wikipedia) and shares its bounded cache. `album` is one of the artist's own
// album titles — it pins the artist's identity, exactly as on the display.
app.get("/api/artist-bio", async (req, res) => {
  const artist = (req.query.artist || "").trim();
  const album  = (req.query.album  || "").trim();
  if (!artist) return res.status(400).json({ error: "artist required" });
  try {
    const bio = await fetchDisplayArtistBio(artist, album || null);
    if (!bio || !bio.description) return res.json({ bio: null });
    res.json({ bio: {
      name:   bio.name || artist,
      text:   bio.description,
      source: bio.source || "",
      image:  bio.image || null
    }});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/random-albums", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const count = Math.max(1, Math.min(96, parseInt(req.query.count || ALBUM_COUNT_DEFAULT, 10)));
  const filter = parseFilter(req.query);
  try {
    const r = await pickRandomAlbums(count, filter);
    res.json({ albums: r.albums, total: r.total, filtered: !!filter });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Whole library, in Roon's own album order, paged straight out of the snapshot
// index — zero Roon round-trips per page. Feeds the Home "Library" carousel
// and its full scrolling wall.
// ---------------------------------------------------------------------------
// Library wall: sorting + focus.
//
// Roon's own Sort/Focus run on a private API — the extension API exposes four
// strings per album and NO ordering control, so this is built entirely from the
// snapshot and its side tables (years from the label scan, source flags, play
// history). That means no Roon calls on a user action, and it composes facets
// (decade AND source AND unplayed), which the browse tree cannot do at all.
//
// Ordered results are memoised: the whole library is sorted once per
// option-combination, not per page. The key includes a metadata version because
// years and labels keep arriving DURING a label scan — a snapshot-timestamp key
// alone would serve a stale ordering for hours.
// ---------------------------------------------------------------------------

// The library view vocabulary, as FUNCTIONS so the sanitiser below can be
// tested against the shipping list instead of a copy injected beside it. A
// duplicated vocabulary is how a mutation adding a bogus sort would slip past
// the suite (the v1.6.59 year-source-ranking hole, in a new place).
function libSortIds()   { return ["album", "artist", "year", "added", "plays", "lastplayed", "random"]; }
function libPlayedIds() { return ["any", "never", "played", "6", "12"]; }
function smartNameMax() { return 60; }
const LIB_SORTS = new Set(libSortIds());

// ---------------------------------------------------------------------------
// Focus facets.
//
// ONE table, read by both the filter (libraryView) and the counter
// (/api/library/facets). They used to be two hand-written loops that happened
// to agree; a facet that counts one way and selects another is worse than
// either being wrong on its own, because the number promises something the
// list then fails to deliver.
//
// Each entry answers one question — "which values does this album have?" —
// returning an array. An empty array means the album has no value for this
// facet, and such an album matches only when the facet is unselected.
//
// What is NOT here, because Roon's extension API does not publish it (browse
// returns title, subtitle, image_key, item_key, hint and nothing else): star
// ratings, Roon favourites, Roon's own play counts, Roon's date-added, album
// type (Main/EP/Single), and the Inspector states. Those need private API
// access Roon has never shipped. Everything below is either navigated out of
// the browse tree or worked out by this extension from its own evidence.
// ---------------------------------------------------------------------------

// Album → its genre names, from the harvested side table.
function albumGenresOf(al) {
  return albumGenreCache.get(al.nTitle + "||" + al.nArtist) || [];
}
// Album → what its local file is, or null when there is no local file.
//
// Same shape as albumSource: a snapshot record carries its identity keys
// precomputed, and anything else has them worked out from its title and credit.
function albumFileFacts(title, subtitle, rec) {
  const keys = (rec && rec.srcKeys) ? rec.srcKeys : albumKeys(title, subtitle);
  for (const key of keys) {
    const f = albumFileCache.get(key);
    if (f) return f;
  }
  return null;
}
function albumFileFactsOf(al) { return albumFileFacts(al.title, al.subtitle, al); }
// Sample rates land on the tidy audio values; anything else is reported as it
// is rather than forced into a bucket that would misdescribe it.
function rateLabel(hz) {
  if (!hz) return null;
  const k = hz / 1000;
  return (Number.isInteger(k) ? k : k.toFixed(1)) + " kHz";
}
function channelLabel(n) {
  if (!n) return null;
  if (n === 1) return "Mono";
  if (n === 2) return "Stereo";
  return n + " channels";
}
// "Added in the last" windows, in days. Roon has this bucket too; its values
// come from Roon's own import date, and ours from the dates this extension
// could work out, so the numbers will not agree — which is why the sheet says
// where they came from.
function libAddedWindows() {
  return [
    { value: "7",   label: "7 days",   days: 7 },
    { value: "30",  label: "30 days",  days: 30 },
    { value: "90",  label: "3 months", days: 90 },
    { value: "365", label: "A year",   days: 365 }
  ];
}

function libFacetDefs() {
  return [
    { id: "genre",  label: "Genre",
      values: (al) => albumGenresOf(al) },
    { id: "source", label: "Source",
      // Fixed order and friendly names; the chip list is built from whichever
      // of these actually occur.
      order: ["local", "qobuz", "tidal"],
      labels: { local: "Local albums", qobuz: "Qobuz", tidal: "TIDAL" },
      values: (al) => { const s = albumSource(al.title, al.subtitle, al); return s ? [s] : []; } },
    { id: "decade", label: "Decade",
      sort: "numeric-desc",
      labels: (v) => v + "s",
      values: (al) => { const y = albumYearOf(al); return y === null ? [] : [String(Math.floor(y / 10) * 10)]; } },
    // Only when the feature is on. Dropping it from the vocabulary is enough
    // to disable it everywhere: the Focus sheet renders from this list, and
    // libraryView applies only the facets this list still publishes — so a
    // selection stored from before the switch was flipped stops filtering
    // rather than silently narrowing a wall with no visible reason why.
    ...(labelsEnabled ? [{ id: "label",  label: "Record label",
      values: (al) => { const n = resolveAlbumLabelName(al); return n ? [n] : []; } }] : []),
    { id: "format", label: "Format",
      values: (al) => { const f = albumFileFactsOf(al); return f && f.container ? [f.container] : []; } },
    { id: "rate",   label: "Sample rate",
      sort: "numeric-asc",
      labels: (v) => rateLabel(parseInt(v, 10)) || v,
      values: (al) => { const f = albumFileFactsOf(al); return f && f.rate ? [String(f.rate)] : []; } },
    { id: "bits",   label: "Bit depth",
      sort: "numeric-asc",
      labels: (v) => v + "-bit",
      values: (al) => { const f = albumFileFactsOf(al); return f && f.bits ? [String(f.bits)] : []; } },
    { id: "chan",   label: "Channels",
      sort: "numeric-asc",
      labels: (v) => channelLabel(parseInt(v, 10)) || v,
      values: (al) => { const f = albumFileFactsOf(al); return f && f.chan ? [String(f.chan)] : []; } },
    { id: "letter", label: "Starts with",
      // Sorted-title first character, so "The Wall" files under W exactly as it
      // does in the A-Z wall. Everything non-alphabetic shares one bucket.
      values: (al) => {
        const c = (al.sortTitle || "").charAt(0).toUpperCase();
        return c ? [/[A-Z]/.test(c) ? c : "#"] : [];
      } },
    { id: "added",  label: "Added in the last",
      // Windows nest, so an album added yesterday appears under every window
      // that contains it — picking "3 months" must not exclude this week's.
      sort: "none",
      labels: (v) => (libAddedWindows().find(w => w.value === v) || { label: v }).label,
      values: (al) => {
        const ts = albumAddedOf(al);
        if (ts === null) return [];
        const age = Date.now() - ts;
        return libAddedWindows().filter(w => age <= w.days * 86400000).map(w => w.value);
      } }
  ];
}

// Does an album pass one facet's selection?
//
// A value prefixed with "!" is EXCLUDED rather than included — Roon's
// tap-again-to-invert, which is the signature Focus interaction. Encoding it in
// the value keeps every selection a plain string array, so saved dynamic
// playlists, the URL query and the share format all round-trip it with no
// schema change.
//
// Excludes always win: asking for FLAC but not 24-bit means both must hold.
function facetMatch(selected, values) {
  if (!selected || !selected.length) return true;
  const has = (v) => values.includes(v);
  let wanted = false, sawInclude = false;
  for (const sel of selected) {
    if (sel.charAt(0) === "!") {
      if (has(sel.slice(1))) return false;
    } else {
      sawInclude = true;
      if (has(sel)) wanted = true;
    }
  }
  // Excludes alone ("everything except Pop") must not require an include too.
  return sawInclude ? wanted : true;
}

// ---------------------------------------------------------------------------
// Smart playlists — named, saved library views.
//
// A smart playlist is nothing but a saved `libraryView` query. It is
// re-evaluated every time it is opened, so it follows the library as it grows,
// and it costs ZERO Roon calls: libraryView filters the in-memory album index,
// exactly as the Library Sort + Focus screen has since v1.6.57. Storing one adds
// no Core traffic and no Core memory at all.
// ---------------------------------------------------------------------------

// Sanitise a saved view against the SAME vocabulary libraryView accepts, so a
// hand-edited or half-written settings.json can't produce a query that silently
// returns the whole library (or nothing). Anything unrecognised falls back to
// the default rather than being passed through.
function sanitizeLibView(v) {
  v = (v && typeof v === "object") ? v : {};
  const asList = (x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));
  const seed = parseInt(v.seed, 10);
  const out = {
    sort:   libSortIds().includes(String(v.sort)) ? String(v.sort) : "album",
    dir:    String(v.dir) === "desc" ? "desc" : "asc",
    seed:   Number.isFinite(seed) && seed > 0 ? seed : 1,
    played: libPlayedIds().includes(String(v.played)) ? String(v.played) : "any",
  };
  // Facet selections are free text — they are genre and label NAMES, which no
  // fixed vocabulary can enumerate — so they are bounded and de-duplicated
  // rather than checked against a list. A value that matches nothing yields an
  // empty view, which is honest; the danger being guarded against is an
  // unbounded array from a hand-edited settings.json, not a wrong name.
  for (const def of libFacetDefs()) {
    out[def.id] = [...new Set(
      asList(v[def.id])
        // null and undefined are dropped BEFORE stringifying. String(null) is
        // "null" — a perfectly valid-looking genre name that matches nothing,
        // and a JSON round-trip of a sparse array produces them for free.
        .filter(x => x !== null && x !== undefined && typeof x !== "object")
        .map(String).map(s => s.trim()).filter(Boolean)
        .map(s => s.slice(0, 120))
    )].slice(0, libFacetChipMax());
  }
  return out;
}

const SMART_NAME_MAX = smartNameMax();
const SMART_MAX      = 50;   // a picker, not a database

// Normalise one stored record. Returns null when it can't be salvaged, so a
// corrupt entry is dropped rather than crashing the list for the good ones.
// How many albums a dynamic playlist actually delivers. The query can match
// the whole library — "Never played" on a fresh install matches everything —
// but a playlist of 1,179 albums is ~13,000 tracks, ~300 hours, and 8 Roon
// calls per album to queue. Nobody listens to that; they queue it once,
// wait minutes, and replace it. The limit makes the number the user is SHOWN
// equal the number they GET, which is the part that was misleading.
//
// Vocabulary as functions so the tests read the shipping values.
function smartLimitDefault() { return 100; }
function smartLimitMax()     { return 400; }   // the play-time ceiling; see /api/play-multi
function smartLimitOptions() { return [25, 50, 100, 200, 400]; }

// What a dynamic playlist is made OF.
//
// This is a presentation mode, not a second kind of query, and the distinction
// is worth being precise about because it is the honest limit of what an
// extension can do. The snapshot indexes ALBUMS — Roon's browse API publishes
// no track list without opening each album, at roughly five calls a time — so a
// playlist whose FILTER ran on track attributes would mean indexing every track
// in the library: ~10,000 Roon calls for a 2,000-album library, rebuilt on every
// change. That is exactly the traffic the snapshot model exists to avoid.
//
// So the query always selects albums, and the mode decides what comes out:
//   "albums" — queue whole albums, in order, the way the record was made.
//   "tracks" — expand those albums and present their tracks individually.
// Both already existed as separate endpoints; naming the choice is what lets a
// playlist remember which one it is.
function smartModes()       { return ["albums", "tracks"]; }
function smartModeDefault() { return "albums"; }

// What order the playlist comes out in.
//
//   "album"  — the view's own sort, and each album's tracks in disc order. A
//              record played the way it was sequenced.
//   "random" — albums shuffled, and the tracks within each expanded page
//              shuffled too, so a Tracks playlist doesn't march through one
//              album at a time.
//
// The shuffle is SEEDED, not Math.random(): tracks are paged by album, so a
// fresh shuffle per request would repeat some tracks and skip others as the
// user scrolls. It is a pure function of (playlist seed, album, track), which
// means page 2 continues page 1 instead of reshuffling underneath it.
function smartOrders()       { return ["album", "random"]; }
function smartOrderDefault() { return "album"; }

// Every album a saved playlist matches, in the order it asks for. One function
// so the screen that LISTS a playlist and the button that PLAYS it can never
// disagree about what order it is in.
//
// UNSLICED on purpose. The caller applies the playlist's limit, because the
// count of what matched is what makes "100 of 1,179" honest — slicing here
// would make those two numbers the same and the message meaningless. Shuffling
// before the slice is also the right way round: a random playlist of 100 should
// be 100 drawn from the whole match, not the first 100 by title then jumbled.
function smartPlaylistAlbums(sp) {
  const view = libraryView(sp.view);
  if ((sp.order || smartOrderDefault()) !== "random") return view;
  const seed = (sp.view && sp.view.seed) || 1;
  return view.slice().sort((a, b) =>
    seededRank(a.nTitle + a.nArtist, seed) - seededRank(b.nTitle + b.nArtist, seed));
}

function smartPlaylistRecord(p) {
  if (!p || typeof p !== "object") return null;
  const name = String(p.name || "").trim().slice(0, smartNameMax());
  const id   = String(p.id || "").trim();
  if (!name || !id) return null;
  // Absent on every playlist saved before this shipped, which is exactly the
  // safe direction: they take the default rather than staying uncapped.
  const lim = parseInt(p.limit, 10);
  const limit = Number.isFinite(lim) && lim > 0
    ? Math.min(lim, smartLimitMax())
    : smartLimitDefault();
  const mode  = smartModes().includes(String(p.mode))   ? String(p.mode)  : smartModeDefault();
  const order = smartOrders().includes(String(p.order)) ? String(p.order) : smartOrderDefault();
  return { id, name, view: sanitizeLibView(p.view), limit, mode, order };
}

function loadSmartPlaylists() {
  const raw = loadPersistedSettings().smartPlaylists;
  return (Array.isArray(raw) ? raw : []).map(smartPlaylistRecord).filter(Boolean);
}

function saveSmartPlaylists(list) {
  return savePersistedSettings({ smartPlaylists: list.slice(0, SMART_MAX) });
}


function albumYearOf(al) {
  const y = parseInt(albumYearCache.get(al.nTitle + "||" + al.nArtist) || "", 10);
  return Number.isFinite(y) ? y : null;
}
// When this extension first became aware of the album, or null. Checked across
// every identity the album is keyed under, because the file scan and the index
// may have recorded it under different ones.
function albumAddedOf(al) {
  let best = null;
  for (const k of (al.srcKeys || [])) {
    const hit = albumSeenCache.get(k);
    if (hit && hit.ts > 0 && (best === null || hit.ts < best)) best = hit.ts;
  }
  return best;
}
// How many albums we can actually date. Reported to the user rather than left
// to be inferred from a list that looks half-sorted.
function albumsWithAddedDate() {
  let n = 0;
  for (const al of albumIndex.albums) if (albumAddedOf(al) !== null) n++;
  return n;
}
// Deterministic shuffle: paging must not reshuffle between requests, so the
// order is a pure function of (album, seed) rather than Math.random().
function seededRank(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h;
}
// Album titles played since a cutoff — the plays table records titles only, so
// this is title-keyed (two artists' "Greatest Hits" collide). Same limitation
// the Home "not played" row already carries.
function playedTitleSet(months) {
  return getPlayedTitlesSince(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
}
function playStats() {
  const out = { count: new Map(), last: new Map() };
  if (!labelsDb) return out;
  try {
    for (const r of labelsDb.prepare(
      "SELECT lower(trim(album)) a, COUNT(*) n, MAX(ts) t FROM plays WHERE album != '' GROUP BY a").all()) {
      out.count.set(r.a, r.n); out.last.set(r.a, r.t);
    }
  } catch (e) { /* DB unavailable — every album simply scores zero */ }
  return out;
}

// The funnel's text, normalised the one way this file normalises anything.
// Bounded because it arrives on a query string: a megabyte of "a" would
// otherwise be compared against every album.
function libraryPrefixMax() { return 40; }
function libraryPrefix(raw) {
  return normalize(String(raw || "")).slice(0, libraryPrefixMax());
}

// Does this album start with the typed text, by TITLE or by ARTIST?
//
// Title uses `sortTitle` — the article-stripped key the A-Z wall, the "Starts
// with" facet and every sort tiebreak already use — so typing W finds "The
// Wall" exactly where the wall files it, rather than under T.
//
// Artist matches each credited name separately via `artistNames`, so F finds
// "Fela Kuti" inside "Tony Allen / Fela Kuti". A whole-credit test would miss
// every collaboration where the searched-for artist is not billed first.
//
// startsWith throughout, never includes(): v1.6.56 was spent eradicating
// substring artist matching from thirteen call sites, and re-introducing it
// here would put "Prince" back in front of Bonnie "Prince" Billy.
function albumMatchesPrefix(al, prefix) {
  if (!prefix) return true;
  if (String(al.sortTitle || "").startsWith(prefix)) return true;
  if (String(al.nTitle || "").startsWith(prefix)) return true;
  const names = al.artistNames;
  if (names && names.length) {
    for (const a of names) if (String(a.n || "").startsWith(prefix)) return true;
  }
  return String(al.nArtist || "").startsWith(prefix);
}

function libraryView(q) {
  const sort   = LIB_SORTS.has(String(q.sort || "")) ? String(q.sort) : "album";
  const desc   = String(q.dir || "asc") === "desc";
  const seed   = parseInt(q.seed, 10) || 1;
  const asList = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v])).map(String).filter(Boolean);
  const played  = String(q.played || "any");
  // Every facet in the one table, so adding a facet to libFacetDefs() makes it
  // filterable AND countable without touching this function again.
  const defs = libFacetDefs();
  const picked = defs.map(d => ({ def: d, sel: asList(q[d.id]) }))
                     .filter(x => x.sel.length);
  // Free-text "starts with", from the funnel on the Library wall.
  //
  // Deliberately part of the FILTER chain rather than a sort mode: it runs
  // before the comparator, so it narrows identically under Album name, Artist,
  // Release year, Recently added, Most played, Last played and Random. That is
  // the whole reason it replaced the A-Z scroll rail — a letter index is
  // meaningless the moment the wall is ordered by anything but the alphabet.
  const prefix = libraryPrefix(q.prefix);
  const sig = [albumIndex.builtAt, libraryMetaVersion, sort, desc, seed, played, "p=" + prefix]
    .concat(picked.map(x => x.def.id + "=" + x.sel.slice().sort().join(","))).join("|");
  // A free-text param is unbounded, so it must not be allowed to fill a
  // fixed-size cache with one-hit entries — every keystroke is a new key.
  // Cached only when empty, which is the common case the cache exists for.
  const hit = prefix ? null : libraryViewCache.get(sig);
  if (hit) return hit;

  let list = albumIndex.albums;

  for (const { def, sel } of picked) {
    list = list.filter(al => facetMatch(sel, def.values(al)));
  }
  if (prefix) list = list.filter(al => albumMatchesPrefix(al, prefix));
  if (played !== "any") {
    // "never" uses the whole history; "played" is its complement; "6"/"12"
    // mean "not in the last N months".
    const months = parseInt(played, 10);
    const seen = (played === "never" || played === "played")
      ? getPlayedTitlesSince(0)
      : playedTitleSet(Number.isFinite(months) && months > 0 ? months : 6);
    const want = played === "played";
    list = list.filter(al => seen.has(String(al.title || "").toLowerCase().trim()) === want);
  }

  const stats = (sort === "plays" || sort === "lastplayed") ? playStats() : null;
  const playKey = albumPlayKey;   // one definition of the plays-table key
  const cmp = {
    album:  (a, b) => a.sortTitle.localeCompare(b.sortTitle) || a.nArtist.localeCompare(b.nArtist),
    artist: (a, b) => (a.cFirst || a.nArtist).localeCompare(b.cFirst || b.nArtist) ||
                      a.sortTitle.localeCompare(b.sortTitle),
    // Unknown years sort last in BOTH directions — an album with no year yet is
    // "unknown", not "year zero", and must never head the list.
    year:   (a, b) => {
      const ya = albumYearOf(a), yb = albumYearOf(b);
      if (ya === null && yb === null) return a.sortTitle.localeCompare(b.sortTitle);
      if (ya === null) return 1;
      if (yb === null) return -1;
      return ya - yb || a.sortTitle.localeCompare(b.sortTitle);
    },
    plays:  (a, b) => (stats.count.get(playKey(a)) || 0) - (stats.count.get(playKey(b)) || 0) ||
                      a.sortTitle.localeCompare(b.sortTitle),
    lastplayed: (a, b) => (stats.last.get(playKey(a)) || 0) - (stats.last.get(playKey(b)) || 0) ||
                      a.sortTitle.localeCompare(b.sortTitle),
    added: (a, b) => (albumAddedOf(a) || 0) - (albumAddedOf(b) || 0) ||
                      a.sortTitle.localeCompare(b.sortTitle),
    random: (a, b) => seededRank(a.nTitle + a.nArtist, seed) - seededRank(b.nTitle + b.nArtist, seed)
  }[sort];

  let out;
  if (sort === "year" || sort === "added") {
    // Albums we have no date for are UNKNOWN, not date zero: they're held out
    // of the ordering entirely and appended, so reversing to newest-first can't
    // float them to the top. "Recently added" needs this even more than "year"
    // does — Roon publishes no import date at all, so on an established library
    // the undated set starts out large and only shrinks going forward.
    const dateOf = sort === "year" ? albumYearOf : albumAddedOf;
    const known = [], unknown = [];
    for (const al of list) (dateOf(al) === null ? unknown : known).push(al);
    known.sort(cmp);
    if (desc) known.reverse();
    unknown.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    out = known.concat(unknown);
  } else {
    out = list.slice().sort(cmp);
    // `dir` means the same thing for every sort: asc = the comparator's own
    // order, desc = reversed. "Most played"/"Last played" used to be inverted
    // here so that asc produced highest-first, which made one arrow control
    // point two different ways depending on the sort. The CLIENT now picks the
    // sensible default direction per sort (desc for the quantitative ones), so
    // the server no longer has to special-case anything.
    if (desc) out.reverse();
  }

  if (libraryViewCache.size >= LIBRARY_VIEW_CACHE_MAX) {
    libraryViewCache.delete(libraryViewCache.keys().next().value);
  }
  libraryViewCache.set(sig, out);
  return out;
}

// How many chips one facet may offer. Genre and Label are open-ended — a big
// library has hundreds of labels — and a sheet that lists all of them is a
// scroll with no end. The commonest are the useful ones, and the count beside
// each says what is being left out.
function libFacetChipMax() { return 40; }

// Which focus values actually exist, with counts — so the sheet never offers a
// facet that would return nothing.
//
// Counted through libFacetDefs(), the SAME table the filter selects through. A
// facet that counts one way and selects another is worse than either being
// wrong on its own: the number promises something the list then fails to
// deliver, and the user has no way to tell which half lied.
app.get("/api/library/facets", async (req, res) => {
  if (!core && !isIndexBuilt()) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await ensureAlbumIndex();
    const defs = libFacetDefs();
    const counts = defs.map(() => new Map());
    for (const al of albumIndex.albums) {
      for (let i = 0; i < defs.length; i++) {
        for (const v of defs[i].values(al)) counts[i].set(v, (counts[i].get(v) || 0) + 1);
      }
    }

    const facets = defs.map((def, i) => {
      const m = counts[i];
      let values = [...m.keys()];
      if (def.order) {
        values = def.order.filter(v => m.has(v));
      } else if (def.sort === "numeric-desc") {
        values.sort((a, b) => parseFloat(b) - parseFloat(a));
      } else if (def.sort === "numeric-asc") {
        values.sort((a, b) => parseFloat(a) - parseFloat(b));
      } else if (def.sort === "none") {
        // Author-defined order — the "Added in the last" windows must read
        // shortest-first, which neither alphabetical nor by-count gives.
        values = (def.id === "added" ? libAddedWindows().map(w => w.value) : values)
                   .filter(v => m.has(v));
      } else {
        // Commonest first, then alphabetically — a 300-label list is only
        // usable if the labels you actually own are at the top.
        values.sort((a, b) => (m.get(b) - m.get(a)) || a.localeCompare(b));
      }
      const shown = values.slice(0, libFacetChipMax());
      const labelOf = (v) => {
        if (typeof def.labels === "function") return def.labels(v);
        if (def.labels && def.labels[v]) return def.labels[v];
        return v;
      };
      return {
        id: def.id,
        label: def.label,
        // How many values exist versus how many are offered, so a truncated
        // list says it is truncated instead of looking complete.
        total_values: values.length,
        values: shown.map(v => ({ value: v, label: labelOf(v), count: m.get(v) }))
      };
    }).filter(f => f.values.length);

    res.json({
      total: albumIndex.albums.length,
      facets,
      // Per-facet coverage. Every one of these comes from somewhere other than
      // Roon — the browse API publishes none of it — so the sheet prints the
      // ratio rather than showing chips that quietly don't add up to the
      // library and leaving the user to work out why.
      coverage: {
        // Release years: file tags and Qobuz/TIDAL, never Roon.
        decade: countWithAny(defs, "decade"),
        // Genres: harvested from Roon's own genres hierarchy, so this one
        // SHOULD approach the whole library; a low number means the harvest
        // hasn't run yet or a genre list wouldn't expand.
        genre:  countWithAny(defs, "genre"),
        label:  countWithAny(defs, "label"),
        // Format and friends exist only for albums with a local file.
        format: countWithAny(defs, "format"),
        // Roon publishes no import date at all, so this is what the extension
        // could work out for itself.
        added:  albumsWithAddedDate()
      },
      // Whether the Local count was PROVED album-by-album from file tags, or
      // DERIVED from "no streaming service is connected, so there is nothing
      // else it could be". The sheet says which, because they mean different
      // things and one of them is exact.
      sources_derived: unclaimedIsLocal(),
      played: libPlayedIds(),
      hasPlays: !!(labelsDb && getPlayedTitlesSince(0).size)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// How many albums have at least one value for a facet. Recomputed from the
// per-value counts would be wrong — an album with two genres is counted twice
// there — so this re-walks the index for the facets whose coverage is quoted.
function countWithAny(defs, id) {
  const def = defs.find(d => d.id === id);
  if (!def) return 0;
  let n = 0;
  for (const al of albumIndex.albums) if (def.values(al).length) n++;
  return n;
}

app.get("/api/library/albums", async (req, res) => {
  if (!core && !isIndexBuilt()) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await ensureAlbumIndex();
    if (!isIndexBuilt()) return res.status(503).json({ error: "Library index is still building" });
    const view   = libraryView(req.query);
    const total  = view.length;
    const offset = Math.max(0, Math.min(total, parseInt(req.query.offset || "0", 10) || 0));
    const count  = Math.max(1, Math.min(200, parseInt(req.query.count || "60", 10) || 60));
    const albums = view.slice(offset, offset + count).map(a => withSource({
      offset: a.offset, title: a.title, subtitle: a.subtitle, image_key: a.image_key
    }, a));
    res.json({ albums, offset, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Home section: random albums NOT played in the last N months (default 6).
// Uses the in-memory album index (no Roon browse) filtered against the plays
// table, so it's fast. Returns the same album shape as /api/random-albums, so
// the tiles open via the existing modal/play path. Matching is by album title
// (the plays table only records the title — same imprecision as play-unheard).
app.get("/api/home/unplayed", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  let months = parseInt(req.query.months, 10);
  if (!Number.isFinite(months) || months <= 0 || months > 60) months = 6;
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count <= 0 || count > 96) count = 12;
  try {
    await ensureAlbumIndex();   // build the album index if it isn't ready yet
    const cutoff = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
    const heard = getPlayedTitlesSince(cutoff);
    const pool = [];
    for (const al of albumIndex.albums) {
      const t = (al.title || "").toLowerCase().trim();
      if (t && heard.has(t)) continue;   // played within the window — skip
      pool.push(al);
    }
    if (!pool.length) return res.json({ albums: [], total: 0, months });
    const want = Math.min(count, pool.length);
    const picked = new Set();
    while (picked.size < want) picked.add(Math.floor(Math.random() * pool.length));
    const albums = [...picked].map(i => {
      const al = pool[i];
      return withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }, al);
    });
    res.json({ albums, total: pool.length, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Home section: "album of the day" — one completely random album, chosen
// deterministically from today's date so it's stable all day and changes each
// day. Once it has been played today (a play row with that title since local
// midnight) it's withheld ({ album: null, played: true }) until tomorrow.
// How far back the History ROW looks, and how many tiles it can hold.
function historyDays()     { return 30; }
function historyMaxTiles() { return 60; }

// How far back the plays TABLE is kept — which is a completely different
// question, and conflating the two in v1.7.48 destroyed real listening history.
//
// The History row shows 30 days. Four other features read further back:
//   "Play something unheard"        12 months (UNHEARD_MONTHS)
//   the "Not played in 6 months" row 6 months — it is in the row's title
//   Library sort by plays / last played   all time
//   Focus -> Listening -> "Never played"  all time
//
// Pruning to the row's display window silently turned "not played in 6 months"
// into "not played in 30 days" and reset the play leaderboard, irreversibly:
// Roon exposes no last-played date, so nothing can rebuild it. The retention
// horizon has to be the WIDEST consumer's window, and the row simply queries a
// narrower slice of it.
function playsRetentionDays() { return 400; }

// Delete plays older than the window. Called from the History route rather
// than on a timer: the window only matters when somebody looks, and a box that
// nobody opens for a month should not be doing database writes about it.
let _historyPrunedAt = 0;
function pruneOldPlays() {
  if (!labelsDb) return;
  // At most once an hour. The route is hit on every Home visit and the delete
  // is a write on the synchronous driver.
  if (Date.now() - _historyPrunedAt < 60 * 60 * 1000) return;
  _historyPrunedAt = Date.now();
  try {
    const cutoff = Date.now() - playsRetentionDays() * 24 * 60 * 60 * 1000;
    const r = labelsDb.prepare("DELETE FROM plays WHERE ts < ?").run(cutoff);
    if (r.changes) console.log("[history] pruned " + r.changes + " plays older than " +
                               playsRetentionDays() + " days");
  } catch (e) {
    // Best effort. A failed prune costs disk, not correctness.
    if (DEBUG) console.warn("[history] prune failed: " + e.message);
  }
}

// Albums played in the last 30 days, most recent first, one tile per album.
//
// Grouped by lower(trim(album)) — the same key the "not played" row and the
// Library play sorts use. Two artists' "Greatest Hits" collide under it; that
// is a known and consistent limitation of recording Roon's now-playing line
// rather than an album identity.
//
// The bare `image_key` column is safe ONLY because there is exactly one
// aggregate in the SELECT: SQLite's documented min/max rule makes bare columns
// come from the MAX(ts) row. Add a second aggregate and they become arbitrary
// — the v1.7.46 changelog records that exact bug on the plays table.
//
// The artist is deliberately NOT taken from the history: `plays.artist` is the
// TRACK artist, so a compilation would name a performer rather than the record.
// It comes from the snapshot, like every other Home row.
app.get("/api/home/history", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await ensureAlbumIndex();
    if (!labelsDb) return res.json({ albums: [] });
    pruneOldPlays();
    const count = Math.min(historyMaxTiles(),
      Math.max(1, parseInt(req.query.count, 10) || historyMaxTiles()));
    const cutoff = Date.now() - historyDays() * 24 * 60 * 60 * 1000;
    let rows = [];
    try {
      rows = labelsDb.prepare(
        "SELECT album, image_key, MAX(ts) AS ts FROM plays " +
        "WHERE ts >= ? AND album != '' " +
        "GROUP BY lower(trim(album)) ORDER BY ts DESC LIMIT ?").all(cutoff, count);
    } catch (e) {
      return res.json({ albums: [] });   // DB unavailable — an empty row, not an error
    }
    const lut = libraryLookup();
    const albums = [];
    for (const r of rows) {
      // Resolve to the snapshot so the tile can be opened and played. A title
      // owned by more than one album is ambiguous and is skipped rather than
      // guessed at — the same rule the import resolver follows.
      let hit = null;
      for (const t of albumTitleVariants(r.album)) {
        const arr = lut.byTitle.get(t);
        if (arr && arr.length === 1) { hit = arr[0]; break; }
      }
      if (!hit) continue;
      albums.push(withSource({
        offset:    hit.offset,
        title:     hit.title || "",
        subtitle:  hit.subtitle || "",
        image_key: hit.image_key || r.image_key || null,
      }, hit));
    }
    res.json({ albums, days: historyDays() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/home/album-of-the-day", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await ensureAlbumIndex();
    const albums = albumIndex.albums;
    if (!albums.length) return res.json({ album: null });
    // Deterministic index from the local date (YYYY-MM-DD).
    const now = new Date();
    const dstr = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    const al = albums[fnv1aHash(dstr) % albums.length];
    // Played today? (plays table records the album title.)
    let played = false;
    if (labelsDb) {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      try {
        const row = labelsDb.prepare(
          "SELECT 1 FROM plays WHERE lower(trim(album)) = ? AND ts >= ? LIMIT 1"
        ).get((al.title || "").toLowerCase().trim(), midnight.getTime());
        played = !!row;
      } catch (e) { played = false; /* DB unavailable — show it */ }
    }
    if (played) return res.json({ album: null, played: true });
    res.json({ album: withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Home section: "label of the week" — one record label featured for the whole
// ISO week (Mon–Sun), chosen deterministically from the week key so it's stable
// all week and rotates weekly. Label albums already carry full-hierarchy offsets
// (see /api/label-albums), so tiles open/play via filter:null like the other
// Home rows. Cached ~1h; recomputed when the week changes or the index grew.
function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // ISO week: Thursday determines the week-year; week 1 holds Jan 4th.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + wk;
}
let lotwCache = { weekKey: "", at: 0, count: -1, data: null };
app.get("/api/home/label-of-the-week", (req, res) => {
  // Labels off means the row has nothing to build from and must not try:
  // reaching into labelsIndex here would be the one path still doing label
  // work, and the Home row is switched off alongside the side-menu entry.
  if (!labelsEnabled) return res.json({ label: null, albums: [] });
  try {
    const wk = isoWeekKey();
    // Reuse the cached pick within the same week/hour unless the index grew
    // (a fresh scan can add labels and would otherwise shift the deterministic
    // pick mid-week — recompute so the whole week stays consistent afterward).
    if (lotwCache.data && lotwCache.weekKey === wk &&
        lotwCache.count === labelsIndex.map.size &&
        (Date.now() - lotwCache.at) < 60 * 60 * 1000) {
      return res.json(lotwCache.data);
    }
    // Only feature labels with a fuller catalogue (>= 6 albums) so the
    // single-row carousel has enough to fill out. Sort the keys so the pick is
    // stable regardless of Map insertion order.
    const keys = [...labelsIndex.map.entries()]
      .filter(([, e]) => e.albums && e.albums.length >= 6)
      .map(([k]) => k)
      .sort();
    if (!keys.length) {
      const empty = { label: null, albums: [] };
      lotwCache = { weekKey: wk, at: Date.now(), count: labelsIndex.map.size, data: empty };
      return res.json(empty);
    }
    const entry = labelsIndex.map.get(keys[fnv1aHash(wk) % keys.length]);
    const albums = entry.albums.slice(0, 24).map(a => withSource({
      offset: a.offset, title: a.title || "", subtitle: a.subtitle || "", image_key: a.image_key || null
    }));
    const data = { label: entry.display, albums };
    lotwCache = { weekKey: wk, at: Date.now(), count: labelsIndex.map.size, data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Home "Browse by genre": split the "Pop/Rock" parent genre into two buttons.
// Sub-genres whose name contains "pop" → the Pop group; everything else under
// Pop/Rock → the Rock/Metal group. The frontend picks a random sub-genre from
// the chosen group and applies it as a nested genre filter. Cached 30 min
// (sub-genre lists change only on library edits).
app.get("/api/home/genre-groups", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const data = await genreGroupsCache.get("groups", () => withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "genres", pop_all: true, multi_session_key: sessionKey });
      // Find the Pop/Rock parent (tolerant of spacing/naming).
      const top = await loadLevel(sessionKey, "genres", 1000);
      const parentItem = top.items.find(i => /pop\s*\/\s*rock/i.test((i.title || "").trim()));
      if (!parentItem) return { parent: null, pop: [], rockmetal: [] };
      const parentTitle = parentItem.title.trim();
      await browse({ hierarchy: "genres", item_key: parentItem.item_key, multi_session_key: sessionKey });
      const lvl = await loadLevel(sessionKey, "genres", 1000);
      // Curated classification of Roon's (AllMusic/Rovi) "Pop/Rock" sub-genre
      // names. The trap that caused Carole King, Madonna, James Taylor and Duran
      // Duran to show under Rock/Metal: the word "rock" appears in many SOFT/POP
      // styles ("Soft Rock", "Contemporary Pop/Rock", "Adult Alternative
      // Pop/Rock", "Folk-Rock"), so a bare /rock/ test mis-routed them. The rules,
      // in priority order:
      //   1. Generic catch-alls ("Pop/Rock", "Rock") every album carries → skip.
      //   2. Anything with the literal word "pop" → Pop (Contemporary Pop/Rock,
      //      Indie Pop, Dance-Pop, AM Pop, Power Pop, Pop-Punk, …).
      //   3. Soft styles with no "pop" (Soft Rock, Folk-Rock, Adult Contemporary,
      //      Singer/Songwriter, Easy Listening, New Age) → excluded (too soft to
      //      feature, and never Rock/Metal).
      //   4. Genuinely hard, guitar-driven styles → Rock/Metal (strict list).
      //   5. Remaining pop-family styles (Dance, Disco, Synth, New Wave, Soul,
      //      R&B, Funk, Motown) → Pop.
      //   6. Anything else → excluded.
      const CATCHALL_RE = /^(pop\s*\/\s*rock|rock)$/i;
      const SOFT_RE = /\b(soft\s*rock|folk[\s-]?rock|country[\s-]?rock|adult\s*contemporary|adult\s*alternative|easy\s*listening|singer[\s\/-]*songwriter|new\s*age|lounge|mood\s*music|smooth\s*jazz|yacht\s*rock)\b/i;
      const HARD_RE = /\b(metal|metalcore|deathcore|grindcore|djent|thrash|sludge|doom|nu[\s-]?metal|power\s*metal|black\s*metal|death\s*metal|speed\s*metal|hair\s*metal|hard\s*rock|album\s*rock|arena\s*rock|classic\s*rock|heartland\s*rock|roots\s*rock|blues[\s-]?rock|southern\s*rock|stoner|space\s*rock|noise\s*rock|math\s*rock|post[\s-]?rock|prog|art\s*rock|krautrock|psychedelic|psychedelia|britpop|grunge|post[\s-]?grunge|punk|hardcore|emo|shoegaze|indie\s*rock|\bindie\b|alternative\s*rock|alternative\/indie|college\s*rock|garage|rockabilly|surf|glam|goth|industrial|ska|rap[\s-]?rock|rap[\s-]?metal|jam\s*band|rock\s*&\s*roll|rock\s*and\s*roll)\b/i;
      const POPFAM_RE = /\b(pop|dance|disco|synth|new\s*wave|new\s*romantic|electropop|r&b|rhythm\s*&\s*blues|soul|motown|funk|boy\s*band|teen|bubblegum|quiet\s*storm|urban)\b/i;
      const pop = [], rockmetal = [];
      for (const it of lvl.items) {
        const title = (it.title || "").trim();
        if (!title || it.hint === "header") continue;
        if (/^albums$/i.test(title)) continue;          // the "Albums" child, not a sub-genre
        if (CATCHALL_RE.test(title)) continue;          // generic catch-all, not a real style
        const entry = { title, count: parseAlbumCount(it.subtitle) || 0 };
        if (/\bpop\b/i.test(title)) pop.push(entry);    // anything "…Pop…" is pop
        else if (SOFT_RE.test(title)) { /* soft, no "pop" → excluded (never Rock/Metal) */ }
        else if (HARD_RE.test(title)) rockmetal.push(entry);
        else if (POPFAM_RE.test(title)) pop.push(entry);
        // else: excluded (unclassifiable)
      }
      const byCount = (a, b) => (b.count || 0) - (a.count || 0);
      pop.sort(byCount); rockmetal.sort(byCount);
      return { parent: parentTitle, pop, rockmetal };
    }));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Available genres (top level of the "genres" hierarchy).
//
// Cached for thirty minutes, because it had no cache at all: every Home load
// fetched it AND /api/home/genre-groups, which walk the same genres root, and
// the client fires both together — two identical Roon walks, 2 ms apart, on
// every page load, plus two more whenever the filter sheet is opened.
//
// The HTTP 304s these requests return are a red herring: Express computes the
// ETag from the finished response body, so the handler has already made every
// Roon call by then. The 304 saves bandwidth and nothing else.
//
// Cleared by bumpLibraryMeta, so a newly added genre appears as soon as the
// library changes rather than waiting out the TTL. The 503 guard stays OUTSIDE
// the cache — an unpaired answer must never be stored.
app.get("/api/filters/genres", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const genres = await genreListCache.get("genres", () => withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "genres", pop_all: true, multi_session_key: sessionKey });
      const lvl = await loadLevel(sessionKey, "genres", 1000);
      // Keep only genres that actually contain albums, biggest first — Roon
      // reports the count in the subtitle (e.g. "12 Albums"). If no subtitle
      // parses (format differs from expected), fall back to the raw list so
      // the feature degrades instead of going empty.
      const parsed = lvl.items
        .filter(i => i.hint !== "header" && i.title)
        .map(i => ({
          title: i.title,
          subtitle: i.subtitle || "",
          count: parseAlbumCount(i.subtitle)
        }));
      const anyParsed = parsed.some(g => g.count !== null);
      return (anyParsed
        ? parsed.filter(g => g.count !== null && g.count > 0)
                .sort((a, b) => b.count - a.count)
        : parsed
      ).map(g => ({ title: g.title, subtitle: g.subtitle }));
    }));
    res.json({ genres });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Available tags (browse tree: Library → Tags).
app.get("/api/filters/tags", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const tags = await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "browse", pop_all: true, multi_session_key: sessionKey });
      const lib = await findItemByTitle(sessionKey, "browse", "Library", 50);
      if (!lib) return [];
      await browse({ hierarchy: "browse", item_key: lib.item_key, multi_session_key: sessionKey });
      const tagsNode = await findItemByTitle(sessionKey, "browse", "Tags", 100);
      if (!tagsNode) return [];
      await browse({ hierarchy: "browse", item_key: tagsNode.item_key, multi_session_key: sessionKey });
      const lvl = await loadLevel(sessionKey, "browse", 1000);
      return lvl.items
        .filter(i => i.hint !== "header" && i.title)
        .map(i => ({ title: i.title, subtitle: i.subtitle || "" }));
    });
    res.json({ tags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record labels — built via iTunes + MusicBrainz scan (no Roon "Labels" node needed).
// Triggers a background scan on first call so the list grows over time.
app.get("/api/filters/labels", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  // An empty list rather than an error: the screen behind this is unreachable
  // while the feature is off, and a stale client asking should get "nothing
  // here", not a failure it will render as a broken screen.
  if (!labelsEnabled) return res.json({ labels: [], scanning: false, progress: 0 });
  // Seed from cache so the first response includes labels even on a fresh restart.
  if (labelsEnabled && labelsIndex.map.size === 0 && albumIndex.count > 0) {
    seedLabelsFromCache();
  }
  // Kick off a scan if never done, or if the last scan is older than the rescan
  // interval. Not while Labels is off: this route is the lazy trigger, and a
  // feature nobody switched on must not start a scan because a screen happened
  // to ask.
  if (labelsEnabled && !labelsIndex.building &&
      (labelsIndex.builtAt === 0 || Date.now() - labelsIndex.builtAt > LABELS_RESCAN_MS)) {
    runLabelsIndexScan().catch(e => {
      if (DEBUG) console.error("[labels] scan error:", e.message);
    });
  }
  // Build reverse merge map so each tile knows what's merged into it.
  const mergesByTarget = new Map();
  for (const [sk, m] of labelMerges) {
    if (!mergesByTarget.has(m.targetKey)) mergesByTarget.set(m.targetKey, []);
    mergesByTarget.get(m.targetKey).push({ key: sk, display: m.sourceDisplay });
  }
  const labels = [];
  for (const [groupKey, entry] of labelsIndex.map) {
    labels.push({
      key:        groupKey,
      title:      entry.display,
      subtitle:   entry.albums.length + " album" + (entry.albums.length === 1 ? "" : "s"),
      albumCount: entry.albums.length,
      image_key:  entry.image_key || null,
      logo_url:   entry.logo_url  || null,
      mergedFrom: mergesByTarget.get(groupKey) || []
    });
  }
  labels.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  // Report scanning=true whenever we have no data yet: covers both the case
  // where the album index is actively building AND the brief window before
  // buildAlbumIndex() is called (albumIndex.building is still null).
  const noDataYet = labels.length === 0 && albumIndex.count === 0;
  res.json({
    labels,
    scanning:  labelsIndex.building || noDataYet,
    progress:  noDataYet ? (albumIndex.progress || 0) : labelsIndex.progress,
    count:     labelsIndex.count
  });
});

// All albums for one label, ordered. ?label=NAME&order=alpha|random
// Albums are served from the Qobuz-derived labelsIndex; offsets are positions
// in the full "albums" hierarchy so open/play work without any filter.
app.get("/api/label-albums", (req, res) => {
  if (!labelsEnabled) return res.json({ label: null, albums: [] });
  const name  = String(req.query.label || "").trim();
  const order = req.query.order === "random" ? "random" : "alpha";
  if (!name) return res.status(400).json({ error: "label query parameter required" });
  const entry = labelsIndex.map.get(labelGroupKey(name));
  if (!entry) {
    return res.json({ albums: [], total: 0, label: name, order,
      scanning: labelsIndex.building });
  }
  let albums = entry.albums.slice();
  if (order === "random") {
    for (let i = albums.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [albums[i], albums[j]] = [albums[j], albums[i]];
    }
  } else {
    albums.sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  }
  const gk = labelGroupKey(name);
  // Shallow-copied so the badge isn't written onto the stored label index.
  res.json({ albums: albums.map(a => withSource(Object.assign({}, a))),
             total: albums.length, label: name, order,
             groupKey: gk, logo_url: labelLogoCache.get(gk) || null });
});

// Labels scan status — lets the UI poll while the background scan runs.
app.get("/api/labels-scan-status", (req, res) => {
  res.json({
    scanning:  labelsIndex.building,
    progress:  labelsIndex.progress,
    count:     labelsIndex.count,
    builtAt:   labelsIndex.builtAt
  });
});

// Force a fresh labels scan — resets builtAt so the next /api/filters/labels
// call triggers a full re-scan (useful if the initial scan found 0 labels).
// Manual "Rescan library" (side menu). Checks Roon and rebuilds the album
// snapshot — but refuses if Roon is still importing, so a deliberate press
// never fights an active import. Returns a status the UI toasts.
app.post("/api/library/rescan", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    // Always re-read the streaming favourites on an explicit Rescan, even when
    // the snapshot itself turns out to be unchanged — this is the user's way to
    // refresh the Qobuz/Tidal badges after adding albums in those services.
    // The snapshot check runs FIRST and is awaited, because it is the only part
    // the user is waiting on — the response tells them whether the library
    // changed. Everything else is background work kicked afterwards.
    const r = await checkAndMaybeRebuild("manual", true);

    // ...and the background jobs run ONE AT A TIME.
    //
    // They used to be three fire-and-forget kicks issued together, so a Rescan
    // put the art prewarm, the genre walk and the label scan's import probe on
    // the Core simultaneously — all sharing the single multiplexed websocket
    // that browse and transport also use. The total number of calls was never
    // the problem; the burst was. Chaining them costs the user nothing (the
    // response has already gone) and turns a spike into a queue.
    //
    // Deliberately after checkAndMaybeRebuild: if it rebuilt, it has already
    // kicked its own prewarm and genre harvest, and the guards inside those
    // make the calls below no-ops rather than a second pass.
    rescanChain(r, "manual rescan", true).catch(e => {
      if (DEBUG) console.error("[rescan] background chain:", e.message);
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The Rescan button's background work, in order, one at a time.
//
// Order is by cost to the Core, cheapest first, so the things that can finish
// quickly do:
//   1. streaming favourites — no Roon calls at all (Qobuz/TIDAL HTTP), and it
//      is what refreshes the source badges the user probably pressed this for;
//   2. genres — a few hundred browse calls;
//   3. the label scan — a slow file walk plus external lookups, no Roon calls
//      beyond its own import probe, so it goes last where it can take its time.
//
// Each step is caught individually: one failing must not cancel the rest, and
// a Rescan that silently did two of its three jobs is worse than one that says
// which part failed.
// `reason` travels into the first three steps' log lines so an automatic
// post-import run is distinguishable from a button press in the rotating log —
// they do the same work but arrive for very different reasons. The labels step
// is the exception: runLabelsIndexScan takes no reason and writes its own
// wording to the labels log, so that one is told apart by its timing only.
async function rescanChain(rebuildResult, reason, force) {
  reason = reason || "manual rescan";
  await bgRun("stream favourites", () => refreshStreamAlbumKeys(reason));
  // `force` is NOT a synonym for "run it now" — in both of these it means "a
  // human insisted", and it buys past the `libraryIsImporting()` gate and, in
  // the genre walk, turns a fingerprint-skipping pass into a full sweep of a
  // few hundred browse calls. Right for the button; wrong for the automatic
  // run, which would then skip the very import check this version strengthened
  // at the one moment Roon is most likely to still be identifying — and sweep
  // the whole library every time. Newly-arrived albums have no fingerprint
  // yet, so the incremental walk picks them up regardless.
  await bgRun("genres", () => harvestAlbumGenres(reason, !!force));
  // The walk is part of a Rescan regardless — it is what refreshes the Decade
  // and quality filters — and the label pass follows only when Labels is on.
  await bgRun("file tags", () => runFileMetadataScan(reason));
  if (labelsEnabled) await bgRun("labels", () => runLabelsIndexScan(!!force));
  if (DEBUG) console.log("[rescan] background chain done (" + (rebuildResult && rebuildResult.status) + ")");
}

app.post("/api/labels/rescan", (req, res) => {
  if (!labelsEnabled) return res.status(409).json({ error: "Labels is off in Settings" });
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  if (labelsIndex.building) return res.json({ ok: false, reason: "scan already running" });
  labelsIndex.builtAt = 0;
  appendLabelsLog("[labels] manual rescan requested via web UI");
  runLabelsIndexScan(true).catch(e => {   // force: explicit user action bypasses the sync gate
    const msg = "[labels] rescan error: " + e.message;
    if (DEBUG) console.error(msg);
    appendLabelsLog(msg);
  });
  res.json({ ok: true });
});

// Force a FULL rescan — wipes label name cache so ALL albums are re-queried
// from sources. Logo, MBID and merge data are preserved.
app.post("/api/labels/rescan-force", (req, res) => {
  if (!labelsEnabled) return res.status(409).json({ error: "Labels is off in Settings" });
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  if (labelsIndex.building) return res.json({ ok: false, reason: "scan already running" });
  // Clear label name cache only (logos and MBIDs are expensive to re-fetch).
  // Also clear the per-session logo dedup Set so Discogs logo fetches are retried.
  if (labelsDb) labelsDb.prepare("DELETE FROM label_names").run();
  labelDiskCache.clear();
  labelsIndex.map.clear();
  labelsIndex.count = 0;
  labelsIndex.builtAt = 0;
  discogsLogoTried.clear();
  appendLabelsLog("[labels] FORCE rescan requested — cleared name cache + logo dedup, starting full scan");
  runLabelsIndexScan(true).catch(e => {   // force: explicit user action bypasses the sync gate
    const msg = "[labels] force-rescan error: " + e.message;
    console.error(msg); appendLabelsLog(msg);
  });
  res.json({ ok: true });
});

// Serve locally cached label logo images (downloaded at save time).
app.get("/api/labels/logo-image/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(__dirname, "data", "cache", "logos", filename);
  if (!fs.existsSync(filepath)) return res.status(404).end();
  res.sendFile(filepath);
});

// Return Discogs logo candidates for the logo picker UI.
// First searches by name (per_page=25). If none of those have usable images,
// falls back to fetching full label data from the Discogs Labels API for the
// best name match, which has a proper images[] array even when search results don't.
app.get("/api/labels/logo-candidates", async (req, res) => {
  const name = (req.query.label || "").trim();
  if (!name) return res.status(400).json({ error: "label required" });
  if (!discogsToken) return res.status(400).json({ error: "Discogs token not configured — add it in Settings" });
  const headers = {
    "Authorization": `Discogs token=${discogsToken}`,
    "User-Agent": MB_USER_AGENT
  };
  const BAD = /no[-_]image|no[-_]label|spacer|avatar|default[-_]label/i;
  const normTarget = labelGroupKey(name);
  try {
    await discogsWait();
    const searchTerm = sanitizeDiscogsSearchTerm(name);
    const json = await httpJson(
      `https://api.discogs.com/database/search?type=label&q=${encodeURIComponent(searchTerm)}&per_page=25`,
      headers, 10000
    );
    const results = (json && json.results) || [];

    // First pass — use whatever images search results include
    const withImages = results
      .map(r => ({ id: r.id, title: r.title || "", img: r.cover_image || r.thumb || null }))
      .filter(c => c.img && !c.img.endsWith(".gif") && !BAD.test(c.img));
    if (withImages.length) return res.json({ candidates: withImages.slice(0, 6) });

    // No usable images in search results — fetch full label data for best name match.
    // The Labels API images[] array has URIs even when search cover_image is absent.
    const bestMatch = results.find(r => labelGroupKey(r.title || "") === normTarget)
      || results.find(r => labelGroupKey(r.title || "").includes(normTarget))
      || results[0];
    if (bestMatch && bestMatch.id) {
      await discogsWait();
      const labelData = await httpJson(
        `https://api.discogs.com/labels/${bestMatch.id}`,
        headers, 10000
      );
      const images = Array.isArray(labelData && labelData.images) ? labelData.images : [];
      const candidates = images
        .filter(i => i.uri && !i.uri.endsWith(".gif") && !BAD.test(i.uri))
        .slice(0, 6)
        .map(i => ({ title: bestMatch.title, img: i.uri }));
      return res.json({ candidates });
    }

    res.json({ candidates: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually set (or override) the logo URL for a label tile.
// Downloads and caches the image locally so any URL (including Discogs page
// URLs that aren't direct image links) works reliably on mobile.
// Body: { label: displayName, url: imageUrl }
app.post("/api/labels/logo", async (req, res) => {
  const { label, url } = req.body || {};
  if (!label) return res.status(400).json({ error: "label required" });
  if (!url)   return res.status(400).json({ error: "url required" });
  const groupKey = labelGroupKey(label);
  if (!groupKey) return res.status(400).json({ error: "invalid label name" });

  let imageUrl = url;

  // If the URL is a Discogs label page (or image viewer), extract the label ID
  // and use the Discogs API to get a real i.discogs.com CDN image URL.
  // Handles: discogs.com/label/1495-~scape  and  discogs.com/label/1495-~scape/image/…
  const discogsIdMatch = url.match(/discogs\.com\/label\/(\d+)/i);
  if (discogsIdMatch) {
    try {
      await discogsWait();
      const BAD = /no[-_]image|no[-_]label|spacer|avatar|default[-_]label/i;
      const labelData = await httpJson(
        `https://api.discogs.com/labels/${discogsIdMatch[1]}`,
        { "Authorization": `Discogs token=${discogsToken}`, "User-Agent": MB_USER_AGENT },
        10000
      );
      const images = Array.isArray(labelData && labelData.images) ? labelData.images : [];
      const img = images.find(i => i.uri && !i.uri.endsWith(".gif") && !BAD.test(i.uri));
      if (img && img.uri) imageUrl = img.uri;
    } catch (_) { /* Discogs API unavailable — fall through to download the CDN URL directly */ }
  }

  let storedUrl = imageUrl;
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 15000);
    const resp = await fetch(imageUrl, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": MB_USER_AGENT, "Accept": "image/*,*/*;q=0.8" }
    });
    clearTimeout(tid);
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.startsWith("image/")) {
      const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp" : "jpg";
      const logosDir = path.join(__dirname, "data", "cache", "logos");
      fs.mkdirSync(logosDir, { recursive: true });
      fs.writeFileSync(path.join(logosDir, groupKey + "." + ext), Buffer.from(await resp.arrayBuffer()));
      storedUrl = `/api/labels/logo-image/${groupKey}.${ext}`;
    } else {
      // Non-image response — could be a Discogs auth redirect (login page HTML).
      // Do NOT store resp.url: it may be a Discogs login page URL which would render as broken.
      // Keep storedUrl as the original imageUrl and let the tile fail gracefully.
      if (DEBUG) console.warn("[labels:logo] unexpected content-type:", ct.slice(0, 40), "for", imageUrl.slice(0, 80));
    }
  } catch (_) { /* timeout or network error — storedUrl stays as imageUrl, tile fails gracefully */ }

  try {
    setLabelLogo(groupKey, storedUrl);
    const entry = labelsIndex.map.get(groupKey);
    if (entry) entry.logo_url = storedUrl;
    discogsLogoTried.delete(groupKey);
    res.json({ ok: true, storedUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Merge two or more label tiles into one.
// Body: { items: [{key, display}, ...] } — first item is the merge target (canonical name).
// All subsequent items become sources whose albums are redirected to the target.
app.post("/api/labels/merge", (req, res) => {
  if (!labelsEnabled) return res.status(409).json({ error: "Labels is off in Settings" });
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length < 2) {
    return res.status(400).json({ error: "Need at least 2 labels" });
  }
  const [target, ...sources] = items;
  if (!target.key || !target.display) return res.status(400).json({ error: "Invalid target" });
  for (const src of sources) {
    if (!src.key || src.key === target.key) continue;
    if (labelsDb) stmtInsertMerge.run(src.key, src.display || src.key, target.key, target.display);
    labelMerges.set(src.key, { targetKey: target.key, targetDisplay: target.display, sourceDisplay: src.display || src.key });
  }
  rebuildLabelsMap();
  appendLabelsLog("[labels] merged " + sources.length + " label(s) into '" + target.display + "'");
  res.json({ ok: true });
});

// Remove a single source label from a merge group.
app.delete("/api/labels/merge/:sourceKey", (req, res) => {
  if (!labelsEnabled) return res.status(409).json({ error: "Labels is off in Settings" });
  const { sourceKey } = req.params;
  if (labelsDb) stmtDeleteMerge.run(sourceKey);
  labelMerges.delete(sourceKey);
  rebuildLabelsMap();
  appendLabelsLog("[labels] unmerged key '" + sourceKey + "'");
  res.json({ ok: true });
});

// Serve the scan log file for download / copy.
app.get("/api/labels-scan-log", (req, res) => {
  try {
    const log = fs.readFileSync(LABELS_LOG_FILE, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"labels-scan.log\"");
    res.send(log);
  } catch (e) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("No scan log yet — run a scan first.\n");
  }
});

// Debug: dump the browse root + Library contents so we can see whether (and
// where) a "Labels" list exists on a live Core.
app.get("/api/debug/labels", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "browse", pop_all: true, multi_session_key: sessionKey });
      const root = await loadLevel(sessionKey, "browse", 100);
      let library = null;
      const lib = root.items.find(i => /^library$/i.test((i.title || "").trim()));
      if (lib) {
        await browse({ hierarchy: "browse", item_key: lib.item_key, multi_session_key: sessionKey });
        library = (await loadLevel(sessionKey, "browse", 100)).items.map(i => i.title);
      }
      res.json({ root: root.items.map(i => i.title), library });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: dump what a filter navigation actually finds, level by level —
// for fixing tree-walking assumptions against a live Core.
app.get("/api/debug/filter", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const filter = parseFilter(req.query);
  try {
    await withBrowseSession(async (sessionKey) => {
      const nav = await navigateToAlbumList(sessionKey, filter);
      const sample = await load({
        hierarchy: nav.hierarchy, offset: 0, count: 10, multi_session_key: sessionKey
      });
      res.json({
        filter, hierarchy: nav.hierarchy, total: nav.total,
        sample: (sample.items || []).map(i => ({
          title: i.title, subtitle: i.subtitle, hint: i.hint || null
        }))
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: read-only probe of the Roon browse tree. Walks from the browse root
// through a slash-separated `path` of node titles (case-insensitive) and dumps
// what the resulting level contains. Optionally drills into one album at that
// level (`album=<index>`) to dump its contents/action_list. Used to confirm
// (a) whether Qobuz "New Releases" is reachable and how many albums it holds,
// and (b) whether an "Add to Library"/"Add to Favorites" action exists on a
// Qobuz album — WITHOUT invoking anything. No zone_or_output_id is ever passed,
// so nothing is played, queued, or added; this only reads the tree. Examples:
//   /api/debug/browse-probe                                   → list browse root
//   /api/debug/browse-probe?path=Qobuz                        → list the Qobuz section
//   /api/debug/browse-probe?path=Qobuz/New%20Releases         → list those albums (count)
//   ...&album=0&zone=<zone_id>                                → drill an album, zone-scoped
//   ...&album=0&action=3&zone=<zone_id>                       → list item 3's ACTION MENU
//
// The action drill answers "does Roon offer an extension any playlist action?"
// — "Add to Library" is known to appear in these menus, so their absence of an
// "Add to Playlist" is worth confirming on a real Core rather than assuming.
//   /api/debug/browse-probe?path=Qobuz/New%20Releases&album=0 → dump album 0's actions
app.get("/api/debug/browse-probe", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const hierarchy = "browse";
  const segments = (req.query.path || "").toString().split("/").map(s => s.trim()).filter(Boolean);
  const zone = String(req.query.zone || "") || undefined;
  const albumRaw = req.query.album;
  const albumIdx = albumRaw === undefined ? -1 : parseInt(albumRaw, 10);
  if (albumRaw !== undefined && (!Number.isFinite(albumIdx) || albumIdx < 0)) {
    return res.status(400).json({ error: "album must be a non-negative integer index" });
  }
  const mapItem = it => ({
    title: it.title,
    subtitle: it.subtitle || null,
    hint: it.hint || null,
    has_image: !!it.image_key,
    has_item_key: !!it.item_key
  });
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
      const resolved = [];
      for (const seg of segments) {
        const node = await findItemByTitle(sessionKey, hierarchy, seg, 1000);
        if (!node) {
          const here = await loadLevel(sessionKey, hierarchy, 200);
          return res.status(404).json({
            error: 'Could not find "' + seg + '" at this level',
            resolved,
            available_here: here.items.map(i => i.title)
          });
        }
        resolved.push({ segment: seg, matchedTitle: node.title || null, hint: node.hint || null });
        await browse({ hierarchy, item_key: node.item_key, multi_session_key: sessionKey });
      }
      const level = await loadLevel(sessionKey, hierarchy, 300);
      const out = {
        path: segments,
        resolved,
        count: level.total,
        items: level.items.map((it, idx) => Object.assign({ idx }, mapItem(it)))
      };
      if (albumIdx >= 0) {
        const target = level.items[albumIdx];
        if (!target) {
          out.album = { error: "No item at index " + albumIdx + " (level has " + level.items.length + " items)" };
        } else if (!target.item_key) {
          out.album = { error: 'Item "' + (target.title || "") + '" has no item_key to drill into' };
        } else {
          // Read-only drill: browse the album item, then list its contents
          // (top-level action_list items + tracks). Nothing is invoked.
          //
          // `zone` matters here: Roon gates some browse items on a zone, so a
          // probe without one cannot prove an action is absent — only that it is
          // absent WITHOUT a zone. Pass ?zone=<id> to rule that out.
          await browse({ hierarchy, item_key: target.item_key, multi_session_key: sessionKey,
                         zone_or_output_id: zone });
          const inside = await load({ hierarchy, offset: 0, count: 500, multi_session_key: sessionKey });
          out.album = {
            title: target.title || null,
            subtitle: target.subtitle || null,
            list_title: (inside.list && inside.list.title) || null,
            zone_scoped: !!zone,
            items: (inside.items || []).map((it, idx) => Object.assign({ idx }, mapItem(it)))
          };

          // ?action=<idx> drills ONE level further, into that item's own action
          // menu — where a per-track "Add to Playlist" would live if Roon
          // offered one to extensions. Still read-only: the menu is listed, and
          // nothing in it is invoked.
          const actionRaw = req.query.action;
          if (actionRaw !== undefined) {
            const ai = parseInt(actionRaw, 10);
            const sub = (inside.items || [])[ai];
            if (!sub || !sub.item_key) {
              out.album.action = { error: "No item with an item_key at index " + actionRaw };
            } else {
              const d = await browse({ hierarchy, item_key: sub.item_key,
                                       multi_session_key: sessionKey,
                                       zone_or_output_id: zone });
              if (d.action !== "list") {
                out.album.action = { of: sub.title || null, browse_action: d.action,
                                     note: "not a list — nothing to enumerate" };
              } else {
                const acts = await load({ hierarchy, multi_session_key: sessionKey });
                out.album.action = {
                  of: sub.title || null,
                  zone_scoped: !!zone,
                  items: (acts.items || []).map(mapItem)
                };
              }
            }
          }
        }
      }
      res.json(out);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In-memory LRU for scaled cover art. Every art fetch used to be a live Roon
// Core round-trip over the SINGLE multiplexed websocket (images, browse and
// transport all head-of-line block each other), and the Core rescales the
// image each time — with ~85 tiles per Home render that was the main source
// of UI sluggishness. image_key changes when the art changes, so cached bytes
// never go stale (hence immutable). Map preserves insertion order → delete +
// re-set on hit gives LRU eviction.
const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;   // ~64 MB ≈ 1500+ thumbnails
const imageCache = new Map();                     // "key@size" → { body, type, bytes }

// Disk-backed thumbnail store on the data volume — survives restarts, unlike
// the in-memory LRU above. Holds ONE "tile master" per album (500px JPEG, the
// largest size the wall tiles ever request) written by the prewarm pass that
// runs after every library sync. /api/image serves it for any tile-sized
// request (≤500px); bigger art (album view 800px, share card 1000px) still
// goes to the Core on a memory miss. image_key changes when the art changes,
// so disk entries never go stale — a rebuild prunes keys that left the index.
const ART_DIR = path.join(__dirname, "data", "art-cache");
const PREWARM_ART_SIZE = 500;
try { fs.mkdirSync(ART_DIR, { recursive: true }); } catch (e) {
  console.error("[art] cannot create art-cache dir:", e.message);
}
// image_key is an opaque Roon string — base64url is filesystem-safe AND
// injective (an escape-based mapping like encodeURIComponent + '%'→'_' can
// collide two distinct keys onto one file, serving the wrong album's art).
function artFileName(imageKey) {
  return Buffer.from(String(imageKey)).toString("base64url") + ".jpg";
}
function artFilePath(imageKey) { return path.join(ART_DIR, artFileName(imageKey)); }

// Atomic write: readers race the prewarm on exactly the files it's writing
// (the wall is first opened while the post-build prewarm runs). A plain
// writeFile is truncate-then-append, so a concurrent read returns a torn JPEG
// that would then be cached immutable for a week. Write-to-temp + rename makes
// the file appear fully-formed or not at all.
let _artTmpSeq = 0;
async function writeArtFile(imageKey, body) {
  const dest = artFilePath(imageKey);
  // Unique tmp per write — two concurrent write-throughs for the same key must
  // not interleave into one tmp file (each rename lands a complete image).
  const tmp  = dest + "." + (++_artTmpSeq) + ".tmp";
  await fs.promises.writeFile(tmp, body);
  await fs.promises.rename(tmp, dest);
}

// Prewarm: fetch the tile master for every indexed album that doesn't have one
// on disk yet. Kicked after each snapshot build (first pair, 12h refresh,
// manual Rescan) — "grab the thumbnails during sync" — so wall scrolling never
// waits on the Core. Sequential with a small gap: art shares the single
// multiplexed Core websocket with browse + transport, and a burst here would
// head-of-line block the UI.
let _artPrewarmInFlight = false;
let _artPrewarmQueued   = false;
async function prewarmAlbumArt() {
  if (!core || !isIndexBuilt()) return;
  if (_artPrewarmInFlight) {
    // A rebuild landed mid-prewarm: the running pass will abort on the builtAt
    // check below, but its kick has already fired — queue one re-run so the
    // NEW snapshot still gets warmed (otherwise it waits for the next rebuild).
    _artPrewarmQueued = true;
    return;
  }
  _artPrewarmInFlight = true;
  const snapshotAt = albumIndex.builtAt;
  try {
    // One directory listing serves both passes: prune tile masters whose
    // image_key left the index (art replaced / album removed), and remember
    // what's on disk so the fetch pass below doesn't stat once per album.
    const keep = new Set();
    for (const al of albumIndex.albums) { if (al.image_key) keep.add(artFileName(al.image_key)); }
    const onDisk = new Set();
    let pruned = 0;
    try {
      for (const f of await fs.promises.readdir(ART_DIR)) {
        if (keep.has(f)) { onDisk.add(f); continue; }
        // Failed unlink (permissions/locked): not counted as pruned, and safe
        // to ignore — a leftover file only costs disk and is retried next pass.
        try { await fs.promises.unlink(path.join(ART_DIR, f)); pruned++; } catch (e) {}
      }
    } catch (e) { /* readdir failed (dir missing) — nothing to prune */ }

    const todo = [];
    for (const al of albumIndex.albums) {
      if (!al.image_key) continue;
      if (onDisk.has(artFileName(al.image_key))) continue;
      todo.push(al.image_key);
    }
    if (!todo.length) {
      if (pruned) console.log("[art] prewarm: store current, pruned " + pruned + " stale thumbnails");
      return;
    }
    console.log("[art] prewarm: fetching " + todo.length + " album thumbnails" +
                (pruned ? " (pruned " + pruned + " stale)" : ""));
    let done = 0, failed = 0;
    for (const key of todo) {
      // A new snapshot or an unpair mid-run: stop — the queued re-kick (or the
      // next build) covers the new snapshot.
      if (!core || albumIndex.builtAt !== snapshotAt) break;
      try {
        // The on-demand write-through may have stored this key since the listing.
        if (fs.existsSync(artFilePath(key))) {
          done++;
        } else {
          const { content_type, body } = await getImage(key, {
            scale: "fit", width: PREWARM_ART_SIZE, height: PREWARM_ART_SIZE, format: "image/jpeg"
          });
          // The disk store serves everything as image/jpeg — if the Core hands
          // back another format despite the hint, skip the file; that album
          // just keeps using the Core path like before the store existed.
          if (!content_type || content_type === "image/jpeg") {
            await writeArtFile(key, body);
            done++;
          }
        }
      } catch (e) { failed++; }   // missing art / Core blip — the next prewarm retries
      await new Promise(r => setTimeout(r, 100));
      if (done && done % 500 === 0) console.log("[art] prewarm: " + done + "/" + todo.length);
    }
    console.log("[art] prewarm complete: " + done + "/" + todo.length + " fetched" +
                (failed ? ", " + failed + " failed" : ""));
  } finally {
    _artPrewarmInFlight = false;
    if (_artPrewarmQueued) {
      _artPrewarmQueued = false;
      prewarmAlbumArt().catch(e => { if (DEBUG) console.error("[art] prewarm re-run:", e.message); });
    }
  }
}
let imageCacheBytes = 0;
function imageCacheGet(k) {
  const hit = imageCache.get(k);
  if (!hit) return null;
  imageCache.delete(k); imageCache.set(k, hit);   // refresh LRU position
  return hit;
}
function imageCachePut(k, entry) {
  if (entry.bytes > IMAGE_CACHE_MAX_BYTES / 4) return;   // never let one image dominate
  // Two concurrent misses for the same key both land here; set() replaces the
  // entry, so subtract the old bytes first or the accounting drifts upward
  // forever and eventually evicts the whole cache on every put.
  const prev = imageCache.get(k);
  if (prev) imageCacheBytes -= prev.bytes;
  imageCacheBytes += entry.bytes;
  imageCache.set(k, entry);
  while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size) {
    const oldest = imageCache.keys().next().value;
    imageCacheBytes -= imageCache.get(oldest).bytes;
    imageCache.delete(oldest);
  }
}

// Wall/Home tiles ask for 300-500px depending on device DPR (see TILE_IMG_SIZE
// in app.js). The whole band is served from ONE 500px "tile master" per album
// — one LRU entry and one disk file instead of a near-identical copy per size.
// Smaller asks (96px display backdrop, 120px queue rows) stay on the exact-size
// Core path: shipping them 500px bytes would be ~10x the transfer for art that
// renders at thumbnail size.
const TILE_BAND_MIN = 300;

app.get("/api/image/:image_key", async (req, res) => {
  let size = parseInt(req.query.size || "400", 10);
  if (!Number.isFinite(size)) size = 400;   // ?size=abc must not poison keys / Core calls with NaN
  size = Math.max(64, Math.min(1200, size));
  const key = req.params.image_key;
  const tileBand = size >= TILE_BAND_MIN && size <= PREWARM_ART_SIZE;
  // Tile-band requests all canonicalize to the 500px master's cache entry.
  const cacheKey = key + "@" + (tileBand ? PREWARM_ART_SIZE : size);
  const serve = (entry) => {
    res.set("Content-Type", entry.type);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(entry.body);
  };
  const cached = imageCacheGet(cacheKey);
  if (cached) return serve(cached);
  // Tile band: try the prewarmed disk store next. Works even while unpaired,
  // so wall art survives a Core outage/restart.
  if (tileBand) {
    try {
      const body = await fs.promises.readFile(artFilePath(key));
      const entry = { body, type: "image/jpeg", bytes: body.length };
      imageCachePut(cacheKey, entry);
      return serve(entry);
    } catch (e) { /* not prewarmed (yet) — fall through to the Core */ }
  }
  if (!core) return res.status(503).end();
  try {
    // Tile-band Core fetches are made AT the master size and written through to
    // the disk store — real browsing traffic warms the store during the (long)
    // first prewarm instead of the prewarm re-fetching the same art later.
    const fetchSize = tileBand ? PREWARM_ART_SIZE : size;
    const { content_type, body } = await getImage(key, {
      scale: "fit", width: fetchSize, height: fetchSize, format: "image/jpeg"
    });
    const type = content_type || "image/jpeg";
    imageCachePut(cacheKey, { body, type, bytes: body.length });
    if (tileBand && type === "image/jpeg") {
      writeArtFile(key, body).catch(e => { if (DEBUG) console.error("[art] write-through:", e.message); });
    }
    serve({ body, type });
  } catch (e) {
    res.status(404).end();
  }
});

// Album detail: requires ?offset=N
// Smart playlists — saved library views. No Roon involvement at all, so these
// answer even while unpaired.
// One smart playlist, expanded to TRACKS.
//   ?id=<sp id>&offset=<album offset into the view>&count=<albums to expand>
//
// The saved view yields ALBUMS (that is what the snapshot indexes), so tracks
// only exist by opening each album on the Core. That is the expensive part —
// roughly half a dozen Roon calls per album — so it is paged by ALBUM and the
// client asks for more as it scrolls. Nothing is expanded until the playlist is
// opened, and the album list itself still costs zero Roon calls.
//
// Each track carries its own album's `image_key`, so a track row can show the
// artwork it came from without a second lookup.
const SMART_ALBUM_PAGE = 8;
app.get("/api/smart-playlist", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const id = String(req.query.id || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  const sp = loadSmartPlaylists().find(p => p.id === id);
  if (!sp) return res.status(404).json({ error: "No such dynamic playlist" });

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const count  = Math.max(1, Math.min(SMART_ALBUM_PAGE,
                                      parseInt(req.query.count, 10) || SMART_ALBUM_PAGE));
  const zone   = String(req.query.zone || "") || null;

  try {
    await ensureAlbumIndex();
    if (!isIndexBuilt()) return res.status(503).json({ error: "Library index is still building" });

    // The saved view, re-evaluated now — that is what makes it "smart".
    // Sliced to the playlist's own limit BEFORE paging, so "N albums left"
    // counts down to what will actually play rather than to the query's match
    // count. Applied here and not inside libraryView(), whose cache signature
    // has no limit in it — two playlists sharing a query would otherwise share
    // one cache entry and one limit.
    const view = smartPlaylistAlbums(sp).slice(0, sp.limit);
    const slice = view.slice(offset, offset + count);
    const shuffling = (sp.order || smartOrderDefault()) === "random";
    const seed = (sp.view && sp.view.seed) || 1;

    const tracks = [];
    for (const al of slice) {
      // One album at a time, deliberately: an uncapped Promise.all here would
      // open half a dozen browse sessions per album against the Core at once.
      // Same reasoning as /api/play-multi's batching.
      try {
        const got = await withBrowseSession(sk => loadAlbumSession(
          sk, al.offset, null, { title: al.title, subtitle: al.subtitle }, zone));
        const items = (got.items || []).filter(t => isTrackItem(t, got.playMenu));
        items.forEach((t, i) => {
          tracks.push({
            album_offset: got.offset,
            album_title:  al.title,
            album_artist: al.subtitle,
            image_key:    al.image_key || null,   // the album's art, for the row
            track_index:  i,
            title:        stripTrackNumber(t.title),
            subtitle:     t.subtitle || al.subtitle || "",
            // Roon's own numbering, recovered from the "N. " title prefix. The
            // row index above is a position within this page, not a track
            // number — only this survives being shared.
            track_no:     trackNumberOf(t.title)
          });
        });
      } catch (e) {
        // One unreadable album must not empty the whole playlist — skip it and
        // say so in the log. A stale offset is the usual cause.
        console.warn(`[smart] "${sp.name}": skipped album "${al.title}" — ${e.message}`);
      }
    }

    // Interleave this page's tracks. The album ORDER is already shuffled above;
    // without this, a random Tracks playlist still marches through one album at
    // a time, just in a different album order — which is what the user sees and
    // what they reported.
    //
    // Keyed on the track's own identity, so the same page always comes back in
    // the same order: paging by album means page 2 is a separate request, and a
    // per-request shuffle would repeat some tracks and drop others.
    if (shuffling) {
      tracks.sort((a, b) =>
        seededRank(a.album_title + "|" + a.title + "|" + a.track_index, seed) -
        seededRank(b.album_title + "|" + b.title + "|" + b.track_index, seed));
    }

    res.json({
      id: sp.id, name: sp.name, view: sp.view,
      tracks,
      album_offset: offset,
      albums_expanded: slice.length,
      album_total: view.length,
      done: offset + slice.length >= view.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The ALBUMS a smart playlist resolves to, for play-all / queue-all. Zero Roon
// calls — the client hands these straight to /api/play-multi, which already
// batches and carries the stale-offset defense.
app.get("/api/smart-playlist/albums", async (req, res) => {
  const id = String(req.query.id || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  const sp = loadSmartPlaylists().find(p => p.id === id);
  if (!sp) return res.status(404).json({ error: "No such dynamic playlist" });
  try {
    await ensureAlbumIndex();
    if (!isIndexBuilt()) return res.status(503).json({ error: "Library index is still building" });
    // The SAME ordering the detail screen lists. Playing a random playlist in
    // album order would contradict the screen the user is looking at.
    const view = smartPlaylistAlbums(sp);
    // Ceiling, not a suggestion: each album costs ~7 Roon browse calls inside
    // /api/play-multi, and Roon's own queue gives out somewhere around 5,000
    // tracks (community-reported). 400 albums is ~4,400 tracks and ~2,800 calls
    // — past that the single HTTP request stops being reasonable. The response
    // always reports `total`, so a caller can tell the user what it left out.
    // The caller's ask, the play-time ceiling, and the playlist's own limit —
    // whichever is smallest wins.
    const asked = Math.max(1, Math.min(smartLimitMax(), parseInt(req.query.max, 10) || smartLimitDefault()));
    const max = Math.min(asked, sp.limit);
    res.json({
      id: sp.id, name: sp.name,
      albums: view.slice(0, max).map(a => ({
        offset: a.offset, title: a.title, subtitle: a.subtitle, image_key: a.image_key
      })),
      // `total` is what this playlist delivers; `matched` is what the query
      // found. Reporting only the second made every capped play read as a
      // failure to play the whole playlist.
      total: Math.min(view.length, sp.limit),
      matched: view.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Playlist sharing — export
//
// A shared playlist is a DESCRIPTION, never audio: enough identity for the
// other end to find the same music in their own library or on their own
// streaming service. See docs/design/playlist-sharing.md for why.
//
// The format is JSPF — the JSON serialisation of XSPF, the only formally
// specified open playlist interchange format — in the dialect ListenBrainz
// uses, so the MusicBrainz extension namespaces give us real slots for
// identifiers instead of a bespoke schema. M3U is deliberately not an option:
// it has nowhere to put an identifier at all, which makes it useless to a
// streaming-only library.
//
// Today we hold no exact identifiers (no MBID, ISRC, UPC or service id — see
// the design doc's capture order), so the fields below are mostly text. The
// slots exist anyway and are populated when present: a share file is forever,
// and a reader written now must keep working when exports start carrying IDs.
// ---------------------------------------------------------------------------
// The share vocabulary is functions, not constants, so the tests read the
// SHIPPING values instead of being handed copies. An injected limit shadows the
// real one and asserts nothing — the hole that let the v1.6.59 year-source
// ranking ship untested.
function shareMagic()      { return "MDRP1"; }
function shareTrackMax()   { return 2000; }
// Entries the route will walk. Higher than the output cap so a caller whose
// list contains untitled rows still gets everything it CAN share encoded,
// rather than being refused for entries that were never going to count.
function shareInputMax()   { return 5000; }
function shareTextMax()    { return 500; }
function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}
function shareInt(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
// URIs are the one field a future exporter will fill with service links and
// MBIDs, so they are validated by shape now rather than when they arrive.
function shareUriList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    // A scheme is what makes it a URI rather than free text that would be
    // silently mistaken for one by a reader.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) continue;
    if (s.length > shareTextMax()) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= shareUriMax()) break;
  }
  return out;
}
// Drop keys with nothing in them. JSPF treats absent and empty differently:
// an empty string is a claim that the value IS empty, which would make a
// reader stop looking for it.
function sharePrune(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

// One JSPF track. Returns null for an entry with no title — a track we cannot
// even name is not resolvable by anyone, and shipping it would inflate the
// count the user is shown with entries that can never match.
function shareTrackEntry(t) {
  if (!t || typeof t !== "object") return null;
  const title = shareText(t.title, shareTextMax());
  if (!title) return null;

  // Identifiers a future exporter fills in; harmless and absent until then.
  const extra = sharePrune({
    isrc:           shareText(t.isrc, 32),
    upc:            shareText(t.upc, 32),
    qobuz_album_id: shareText(t.qobuz_album_id, 64),
    tidal_album_id: shareText(t.tidal_album_id, 64),
    year:           shareInt(t.year, 1000, 2999),
    disc:           shareInt(t.disc, 1, 99),
  });

  const ext = Object.keys(extra).length
    ? { [shareNsTrack()]: { additional_metadata: extra } }
    : null;

  return sharePrune({
    title,
    creator:    shareText(t.artist, shareTextMax()),
    album:      shareText(t.album, shareTextMax()),
    trackNum:   shareInt(t.track_no, 1, 999),
    // JSPF durations are milliseconds. We have none today — Roon's browse API
    // exposes no track length — but the slot is what a duration-gated match
    // will read, and that gate is the cheapest defence against resolving a
    // live version in place of the studio take.
    duration:   shareInt(t.duration_ms, 1, 24 * 60 * 60 * 1000),
    identifier: shareUriList(t.identifier),
    location:   shareUriList(t.location),
    extension:  ext,
  });
}

// The whole document. `truncated` is reported rather than silently applied —
// v1.7.17's lesson was that a cap nobody is told about reads as success.
function buildShareDoc(meta, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const track = [];
  let skipped = 0;
  // Set only when the cap actually STOPPED us. Deriving it from the input
  // length instead was wrong in both directions of honesty: 2,100 entries of
  // which 300 were untitled encodes 1,800 tracks with nothing dropped for the
  // cap, yet reported "stopped at the sharing limit" — a false claim of
  // truncation in the one feature whose whole premise is honest accounting.
  let truncated = false;
  for (const e of list) {
    if (track.length >= shareTrackMax()) { truncated = true; break; }
    const one = shareTrackEntry(e);
    if (one) track.push(one);
    else skipped++;
  }
  const playlist = sharePrune({
    title:      shareText(meta && meta.name, shareNameMax()) || "Shared playlist",
    annotation: shareText(meta && meta.annotation, shareTextMax()),
    date:       new Date().toISOString(),
    extension: {
      [shareNsPlaylist()]: {
        additional_metadata: {
          generator: "MusicD Remote",
          generator_version: pkg.version,
        },
      },
    },
  });
  // Assigned AFTER pruning, because pruning drops empty arrays and JSPF's
  // trackList is the one key that must always be present: an absent trackList
  // means "malformed", an empty one means "a playlist with no tracks". Those
  // are different facts and a reader has to be able to tell them apart.
  playlist.track = track;
  return {
    doc: { playlist },
    track_count: track.length,
    skipped,
    truncated,
  };
}

// "MDRP1:<base64url(gzip(json))>". The magic is a version stamp so a reader
// can reject a blob it does not understand instead of guessing, and so the
// schema can change without every old file becoming ambiguous.
function encodeSharePayload(doc) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(doc), "utf8"), { level: 9 });
  return shareMagic() + ":" + gz.toString("base64url");
}

// ---------------------------------------------------------------------------
// User playlists — an ordered list of specific tracks, stored by this
// extension.
//
// Roon's API cannot create or modify a playlist (verified against a live Core
// in v1.7.15), so an imported playlist has nowhere else to live. Smart
// playlists can't hold one either: a smart playlist stores a QUERY, which is
// what makes it smart, and an imported playlist is a fixed list.
//
// This deliberately does NOT go in settings.json. That file is written
// non-atomically, has no key whitelist, and holds the Qobuz password hash and
// the TIDAL refresh token. Third-party content — which is exactly what an
// import is — has no business in the same file.
// ---------------------------------------------------------------------------
const USER_PL_FILE = path.join(LABELS_DB_DIR, "playlists.json");
function userPlVersion()   { return 1; }
function userPlMax()       { return 50; }    // same ceiling as smart playlists
function userPlTracksMax() { return 500; }
function userPlAddMax()    { return 200; }
// Albums per add. Each costs ~5 Roon browse calls to read its tracklist, so
// this is a time budget: 30 albums is ~150 calls, a few seconds.
function userPlAlbumAddMax() { return 30; }
function userPlNameMax()   { return 60; }

// A stored track. Offsets are HINTS; the titles are the CHECK — the identity
// contract the whole album path uses. `track_index` is likewise a hint:
// invokeTrackAction re-matches by title when the index no longer holds, which
// is what lets these survive a library that has shifted underneath them.
function userTrackRecord(t) {
  if (!t || typeof t !== "object") return null;
  const title = shareText(t.title, shareTextMax());
  const albumTitle = shareText(t.album_title, shareTextMax());
  // Without an album we cannot open anything on the Core, so the entry could
  // never be played. Storing it would inflate the count with dead rows.
  if (!title || !albumTitle) return null;
  const off = shareInt(t.album_offset, 0, 5000000);
  if (off === null) return null;
  return {
    album_offset:   off,
    album_title:    albumTitle,
    album_subtitle: shareText(t.album_subtitle, shareTextMax()),
    track_index:    shareInt(t.track_index, 0, 999) || 0,
    title,
    subtitle:       shareText(t.subtitle, shareTextMax()),
    image_key:      shareText(t.image_key, 200) || null,
    track_no:       shareInt(t.track_no, 1, 999),
  };
}

function userPlaylistRecord(p) {
  if (!p || typeof p !== "object") return null;
  const name = shareText(p.name, userPlNameMax());
  const id = shareText(p.id, 64);
  if (!name || !id) return null;
  const tracks = [];
  for (const t of (Array.isArray(p.tracks) ? p.tracks : [])) {
    if (tracks.length >= userPlTracksMax()) break;
    const one = userTrackRecord(t);
    if (one) tracks.push(one);
  }
  return {
    id, name, tracks,
    created_at: shareInt(p.created_at, 0, 4102444800000) || Date.now(),
    updated_at: shareInt(p.updated_at, 0, 4102444800000) || Date.now(),
  };
}

let userPlaylists = [];
function loadUserPlaylists() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(USER_PL_FILE, "utf8")); }
  catch (e) { return []; }   // absent or unreadable — a first run looks like this
  if (!raw || raw.v !== userPlVersion()) {
    // The other versioned files on this volume DISCARD on mismatch, because
    // they are derived caches and the cost is a rescan. This one is the only
    // copy of something the user made, so it is moved aside instead. Same
    // stamp, opposite failure mode.
    const bak = USER_PL_FILE.replace(/\.json$/, `.v${raw && raw.v}.json.bak`);
    try { fs.renameSync(USER_PL_FILE, bak); console.warn("[uplaylist] version mismatch — kept a copy at " + bak); }
    catch (e) { console.warn("[uplaylist] version mismatch and could not back up:", e.message); }
    return [];
  }
  const out = [];
  for (const p of (Array.isArray(raw.playlists) ? raw.playlists : [])) {
    const one = userPlaylistRecord(p);
    if (one) out.push(one);
    if (out.length >= userPlMax()) break;
  }
  return out;
}
function saveUserPlaylists() {
  writeJsonAtomic(USER_PL_FILE,
    { v: userPlVersion(), playlists: userPlaylists.slice(0, userPlMax()) }, "[uplaylist]");
}
function newUserPlaylistId() {
  return "up_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
userPlaylists = loadUserPlaylists();

// Summary rows for the wall: never the tracks themselves, which can be 500 per
// playlist across 50 playlists.
function userPlaylistSummary(p) {
  const keys = [];
  for (const t of p.tracks) {
    if (t.image_key && !keys.includes(t.image_key)) keys.push(t.image_key);
    if (keys.length === 4) break;
  }
  return { id: p.id, name: p.name, track_total: p.tracks.length,
           art_keys: keys, updated_at: p.updated_at };
}

// ---- Import ---------------------------------------------------------------
// The counterpart to encodeSharePayload. Deliberately strict: a blob we cannot
// positively identify is refused rather than guessed at.
function decodeSharePayload(blob) {
  // Deliberately forgiving about everything EXCEPT the payload itself.
  //
  // A blob makes its way here through clipboards, chat apps, mail clients and
  // hand-selection on a phone. All of those wrap lines, and mail in particular
  // inserts newlines mid-string and quote markers at the start of each one. The
  // first version demanded the magic at character zero of a trimmed string, so
  // a paste carrying so much as a leading newline — or the words the sender
  // typed around it — was rejected as "not a MusicD Remote playlist" while
  // holding a perfectly good playlist.
  //
  // So: collapse ALL whitespace, find the magic wherever it sits, and keep only
  // base64url characters after it. None of that can turn a bad blob into a
  // good one — the gzip and JSON steps below are still the real check.
  const compact = String(blob || "").replace(/\s+/g, "");
  // The marker is matched case-INSENSITIVELY because iOS autocorrect lowercases
  // it on paste, and a blob that arrives as "mdrp1:…" is otherwise perfectly
  // good. The payload's own case is left untouched — it is base64url, where
  // case carries meaning, so nothing after the marker may be normalised.
  const at = compact.toUpperCase().indexOf(shareMagic().toUpperCase() + ":");
  if (at < 0) {
    throw new Error(
      `That doesn't look like a MusicD Remote playlist — it should contain "${shareMagic()}:"`);
  }
  const payload = compact.slice(at + shareMagic().length + 1).replace(/[^A-Za-z0-9_-]/g, "");
  if (!payload) throw new Error("That playlist is empty — nothing followed the marker");

  // Trailing prose cannot be separated by inspection: "Enjoy" is as valid a
  // base64url string as the payload is, so stripping non-base64url characters
  // leaves the sender's own words glued to the end. What CAN separate them is
  // gzip's checksum — only the exact right byte sequence passes it. So on
  // failure, shave characters off the end and retry, bounded. A wrong length
  // fails the CRC rather than yielding plausible garbage, which is what makes
  // this safe rather than a guess.
  let json = null;
  for (let cut = 0; cut <= 40 && cut < payload.length; cut++) {
    try {
      json = zlib.gunzipSync(Buffer.from(payload.slice(0, payload.length - cut), "base64url"))
                 .toString("utf8");
      break;
    } catch (e) { /* not this length — try one shorter */ }
  }
  if (json === null) {
    throw new Error("That playlist is damaged — it may have been cut short in transit");
  }
  let doc;
  try { doc = JSON.parse(json); }
  catch (e) { throw new Error("That playlist is damaged — the contents didn't parse"); }
  if (!doc || !doc.playlist || !Array.isArray(doc.playlist.track)) {
    throw new Error("That playlist has no tracks in it");
  }
  return doc;
}

// The play history as a track -> album lookup. ZERO Roon calls.
//
// The single most useful thing about this table is WHOSE album name it holds:
// `line3` is Roon's own, recorded from the now-playing feed. So when a shared
// playlist names a compilation this library groups differently, the history
// already knows what Roon calls the record that track actually sits on — which
// is the one fact the share cannot carry and the snapshot cannot infer.
//
// Coverage is only what this household has played, so it is a rung, not a
// solution. Returns [{ album, artist }] most-played first.
function playsForTrack(trackTitle) {
  if (!labelsDb) return [];
  const t = String(trackTitle || "").toLowerCase().trim();
  if (!t) return [];
  try {
    // GROUP BY album AND artist. Grouping by album alone made `artist` a bare
    // column over a group — SQLite returns an arbitrary row's value — and the
    // caller uses it as a gate. One differently-rendered credit among a
    // hundred plays could therefore veto the whole album.
    const exact = labelsDb.prepare(
      "SELECT track, album, artist, COUNT(*) n FROM plays " +
      "WHERE lower(trim(track)) = ? AND album != '' " +
      "GROUP BY lower(trim(album)), lower(trim(artist)) ORDER BY n DESC LIMIT 8").all(t);
    if (exact.length) return exact;

    // Byte-exact is how this shipped, and it misses everything an edition
    // suffix touches: Roon's "Dreams (Remastered 2020)" never equals a share's
    // "Dreams". Retry canonically, using the same variant stripper the album
    // side has always used. Bounded, and only reached when the cheap query
    // found nothing.
    const want = trackTitleKeys(trackTitle);
    if (!want.length) return [];
    const rows = playsDigest();
    const out = [];
    for (const r of rows) {
      if (trackTitleKeys(r.track).some(k => want.includes(k))) out.push(r);
      if (out.length === 8) break;
    }
    return out;
  } catch (e) {
    return [];   // DB unavailable — this rung simply does not fire
  }
}

// The whole play history, grouped, for the canonical retry above.
//
// The query takes NO parameters, so its result is identical on every call —
// but it was being re-prepared and re-run for every entry an import could not
// place, which is by construction every entry that reaches that rung. On a
// 120,000-row history that measured ~175ms each: about 87 seconds of FULLY
// BLOCKED event loop for a 500-track import, since better-sqlite3 is
// synchronous. No zone updates, no transport control, nothing, for a minute
// and a half.
//
// Memoised for a minute, which covers a whole import (both passes) while
// staying fresh enough that a play recorded during one is picked up by the
// next.
function playsDigestTtlMs() { return 60000; }
let _playsDigest = { at: 0, rows: null };
function playsDigest() {
  if (_playsDigest.rows && (Date.now() - _playsDigest.at) < playsDigestTtlMs()) {
    return _playsDigest.rows;
  }
  const rows = labelsDb.prepare(
    "SELECT track, album, artist, COUNT(*) n FROM plays WHERE album != '' " +
    "GROUP BY lower(trim(track)), lower(trim(album)), lower(trim(artist)) " +
    "ORDER BY n DESC LIMIT 5000").all();
  _playsDigest = { at: Date.now(), rows };
  return rows;
}

// Every canonical form a track title could be known by. Track titles carry the
// same edition noise album titles do ("(Remastered)", "- 2011 Remaster"), and
// `albumTitleVariants` already strips exactly that, so this is deliberately the
// same function rather than a second nearly-identical one.
function trackTitleKeys(title) {
  return albumTitleVariants(title);
}

// Which albums, in Roon's own grouping, contain a track with this title.
//
// This is the answer the rest of the resolver cannot reach: it comes from
// Roon's album contents, recorded by rememberAlbumTracks whenever this
// extension has had an album open for any reason. Returns album identity keys,
// most specific first; the caller maps them back to the snapshot.
// The window has to be big enough to PROVE uniqueness, not merely to find a
// candidate. An earlier version took 24 rows ordered by the track's position
// on its album, which for a title like "Intro" or "Untitled" could truncate
// the real album out of the result — and the caller, seeing one survivor,
// would then resolve confidently to the wrong record. Now: distinct albums
// only, and a full window means "this title is too common to be evidence",
// which declines.
function shareTrackAlbumMax() { return 25; }

function albumKeysForTrack(trackTitle) {
  if (!labelsDb) return [];
  const keys = trackTitleKeys(trackTitle);
  if (!keys.length) return [];
  try {
    const qs = keys.map(() => "?").join(",");
    const rows = labelsDb.prepare(
      "SELECT DISTINCT akey FROM album_tracks WHERE tkey IN (" + qs + ") " +
      "LIMIT " + shareTrackAlbumMax()).all(...keys);
    // Hit the ceiling: we cannot see the whole set, so we cannot show it is
    // unique. Declining is the honest answer.
    return rows.length >= shareTrackAlbumMax() ? [] : rows;
  } catch (e) {
    return [];   // table missing (pre-migration DB) — this rung does not fire
  }
}

// Record an album's track list under the album's identity. The single caller
// is loadAlbumSession, which every path holding a track list goes through, so
// the index fills itself from ordinary use and costs not one extra Roon call.
function rememberAlbumTracks(albumTitle, albumSubtitle, tracks) {
  if (!labelsDb || !Array.isArray(tracks) || !tracks.length) return 0;
  const akey = albumKey(albumTitle, albumSubtitle);
  if (!akey) return 0;   // punctuation-only title — see albumKey's comment
  try {
    const ins = labelsDb.prepare(
      "INSERT OR REPLACE INTO album_tracks (akey, tkey, title, n, ts) VALUES (?,?,?,?,?)");
    const now = Date.now();
    let n = 0;
    const write = labelsDb.transaction(() => {
      // Replaced wholesale rather than merged: an album whose track list
      // changed (a re-rip, a different edition taking the same identity)
      // must not keep the old titles as phantom members.
      labelsDb.prepare("DELETE FROM album_tracks WHERE akey = ?").run(akey);
      for (let i = 0; i < tracks.length; i++) {
        const title = String((tracks[i] && tracks[i].title) || "").trim();
        if (!title) continue;
        // A row per VARIANT, not per track: Roon renders "Dreams (2004
        // Remaster)" and a share carries "Dreams". The reader strips suffixes
        // from the query, so the writer has to file both forms or the two
        // sides never meet. Two tracks reducing to the same key just means the
        // album is reachable by that key, which is all the reader asks.
        let stored = false;
        for (const tkey of trackTitleKeys(title)) {
          ins.run(akey, tkey, title, i, now);
          stored = true;
        }
        if (stored) n++;
      }
    });
    write();
    return n;
  } catch (e) {
    // Best-effort cache write. A failure here costs a slower import later, and
    // must never break the album the user actually asked to open.
    if (DEBUG) console.warn("[tracks] remember failed: " + e.message);
    return 0;
  }
}

// Two lookup tables over the snapshot, both rebuilt only when the library is.
//
// The import resolver used to compare `normalize(albumTitle)` for exact
// equality against `a.nTitle`, and `normalize(artist)` against `a.nArtist`.
// That is stricter than anything else in this file: the badges, the file join
// and the streaming favourites all match through `albumKeys`, which strips
// edition suffixes, folds "&"/"and", drops a leading "The" and splits a credit
// into individual artists. A playlist shared from another server — where the
// same files are grouped and titled differently — fails the strict comparison
// and passes the tolerant one.
//
// `byKey` is the tolerant identity; `byTitle` exists because a compilation is
// the case where the artist CANNOT agree: the share names the track's artist
// ("The Cranberries") and Roon credits the album to "Various Artists", so no
// title+artist key can ever intersect. Matching on the title alone is safe
// only when exactly one album has it, which is why the arrays are kept rather
// than a first-wins map.
let _libLookup = { builtAt: -1, byKey: null, byTitle: null, byAkey: null, canon: null };
function libraryLookup() {
  if (_libLookup.builtAt === albumIndex.builtAt && _libLookup.byKey) return _libLookup;
  const byKey = new Map(), byTitle = new Map(), byAkey = new Map();
  const canon = [];
  const push = (map, k, al) => {
    if (!k) return;
    let arr = map.get(k);
    if (!arr) { arr = []; map.set(k, arr); }
    if (arr.indexOf(al) === -1) arr.push(al);
  };
  for (const al of albumIndex.albums) {
    for (const k of (al.srcKeys || [])) push(byKey, k, al);
    for (const t of albumTitleVariants(al.title || "")) push(byTitle, t, al);
    // `byAkey` is the single identity album_tracks rows are filed under —
    // albumKey(), not the tolerant albumKeys() set, because the writer has one
    // album in hand and must pick one name for it.
    push(byAkey, albumKey(al.title || "", al.subtitle || ""), al);
    // Precomputed once per library build so the containment rung is a string
    // scan rather than 5,000 regexes per unmatched entry.
    const c = canonText(al.title || "");
    if (c) canon.push({ al, c, words: c.split(" ").length });
  }
  _libLookup = { builtAt: albumIndex.builtAt, byKey, byTitle, byAkey, canon };
  return _libLookup;
}

// A credit that names no artist in particular — Roon's compilation credit.
// This is the ONE shape where an album may legitimately fail to mention the
// artist a share names for a track on it.
function isCompilationCredit(credit) {
  const c = canonText(credit || "");
  return !c || c === "various artists" || c === "various" || c === "va";
}

// Does this library album's credit agree with the artist the share named?
//
// Rung 2 used to skip this check entirely, which was not a near-miss: with a
// library holding Queen's "Greatest Hits" and no Foo Fighters one, the entry
// "All My Life · Foo Fighters · Greatest Hits" resolved to QUEEN — reported as
// a clean match, not even flagged as a substitution. A title-only rung has to
// exist (a compilation cannot name the track's artist) but it must decline an
// album that names a DIFFERENT one.
function sharedCreditAgrees(al, artist) {
  if (!artist) return true;
  if (creditHasArtist(al.subtitle || "", artist)) return true;
  return isCompilationCredit(al.subtitle);
}

// Whole-word containment: is `needle` a run of complete words inside `hay`?
// Substring containment would match "Live" inside "Living", which is how this
// project got the artist-matching bugs eradicated in v1.6.56.
function titleContainsPhrase(hay, needle) {
  if (!hay || !needle) return false;
  return hay === needle ||
         hay.startsWith(needle + " ") ||
         hay.endsWith(" " + needle) ||
         hay.includes(" " + needle + " ");
}

// Find the one album in the library that a shared entry names, or null.
//
// Never guesses. Every rung either identifies exactly one album or declines —
// two albums sharing a title is a coin flip, and a coin flip that silently puts
// the wrong record in someone's playlist is worse than a miss they can see.
function findSharedAlbum(albumTitle, artist) {
  const lut = libraryLookup();
  const titles = albumTitleVariants(albumTitle);
  if (!titles.length) return null;
  const exactT = titles[0];   // the full title, nothing stripped

  // 1. Full identity, the tolerant one. Ambiguous identities are skipped
  //    outright: those are owned by more than one album by construction.
  for (const k of albumKeys(albumTitle, artist)) {
    if (ambiguousAlbumKeys.has(k)) continue;
    const arr = lut.byKey.get(k);
    if (arr && arr.length === 1) return arr[0];
  }

  // 2. Title alone, edition suffixes stripped. The compilation case: the album
  //    is credited to "Various Artists" here and to the track's own artist in
  //    the share, so no identity key can match — but if precisely one album in
  //    the library carries that title, there is nothing to be ambiguous about.
  //    The credit still has to AGREE (see sharedCreditAgrees): one album with
  //    the right title and a flatly different artist is a different record.
  for (const t of titles) {
    const arr = lut.byTitle.get(t);
    if (arr && arr.length === 1 && sharedCreditAgrees(arr[0], artist)) return arr[0];
  }

  // 3. Several albums share the title — let the credit choose, using the same
  //    whole-name comparison the artist links use (never a substring).
  if (artist) {
    for (const t of titles) {
      const arr = lut.byTitle.get(t);
      if (!arr || arr.length < 2) continue;
      const named = arr.filter(a => creditHasArtist(a.subtitle || "", artist));
      if (named.length === 1) return named[0];
      // Still several, ALL BY THIS ARTIST: the EDITION-TWIN shape. v1.7.44
      // began stripping edition suffixes to build identities, so "Greatest
      // Hits" and "Greatest Hits (Deluxe Edition)" both claim the same key and
      // are ambiguous by construction — which made rung 1 skip them and every
      // later rung decline, so owning both editions resolved worse than owning
      // neither. When exactly one of them is titled precisely what the share
      // named, there was never anything ambiguous about it.
      //
      // `named`, never `arr`. An earlier version fell back to the full set
      // when NO album was credited to the artist, which walked straight around
      // rung 2's credit check and re-created the wrong-album match this whole
      // version exists to kill: with Queen's and ABBA's "Greatest Hits" in the
      // library and no Foo Fighters one, a Foo Fighters track resolved to
      // Queen — and, because it returns here, was not even flagged as a
      // substitution.
      if (named.length >= 2) {
        const exact = named.filter(a => canonText(a.title || "") === exactT);
        if (exact.length === 1) return exact[0];
      }
    }
  }
  return null;
}

// Roon's name for a record is routinely a SUPERSET of the one on disk: "20th
// Century Masters - The Millennium Collection: The Best of The Cranberries"
// for a share's "The Best Of The Cranberries (20th Century Masters)". No
// amount of suffix-stripping bridges that, because the extra words are on the
// front.
//
// Guarded hard, because containment is the loosest comparison in this file:
// whole words only, at least three of them, the credit must NAME the artist
// (the compilation escape used by the title rung is deliberately not allowed
// here), and exactly one album may qualify.
//
// ONE-DIRECTIONAL, and that is the whole point. Only the LIBRARY title may be
// the longer one. Accepting the reverse — the share's title being the superset
// — resolves "20 Golden Greats Volume 2" onto "20 Golden Greats", and "The
// Dark Side of the Moon Live" onto the studio album. Those are different
// records, not longer names for the same one.
function sharedContainmentMinWords() { return 3; }

function findSharedAlbumByContainment(titles, artist, lut) {
  if (!artist) return null;   // nothing to confirm a loose title against
  const probes = titles.filter(t => t.split(" ").length >= sharedContainmentMinWords());
  if (!probes.length) return null;
  let hit = null;
  for (const entry of lut.canon) {
    if (entry.words < sharedContainmentMinWords()) continue;
    let touches = false;
    for (const t of probes) {
      if (titleContainsPhrase(entry.c, t)) { touches = true; break; }
    }
    if (!touches) continue;
    if (!creditHasArtist(entry.al.subtitle || "", artist)) continue;
    if (hit && hit !== entry.al) return null;   // two candidates — decline
    hit = entry.al;
  }
  return hit;
}

// The whole resolution, in rungs. Returns { album, via } or null.
//
// `via` is not decoration: a track found under an album the share did not name
// is a SUBSTITUTION, and this project's rule is that substitutions are shown,
// never made quietly. The import report uses it to say so.
function resolveSharedAlbum(albumTitle, artist, trackTitle) {
  if (albumTitle && canonText(albumTitle)) {
    const direct = findSharedAlbum(albumTitle, artist);
    if (direct) return { album: direct, via: "album" };

    // A longer library name for what looks like the same record. Reported as
    // "contains", NOT as "album": the name the user ends up with differs from
    // the one the share carried, and this file's rule is that a substitution
    // is shown, never made quietly.
    const near = findSharedAlbumByContainment(
      albumTitleVariants(albumTitle), artist, libraryLookup());
    if (near) return { album: near, via: "contains" };
  }

  // The share's album is not in this library under any reading of its NAME.
  // Every rung above compares names, and no name comparison can discover that
  // Roon files a track on a different record than the sharing server does —
  // which is the whole failure this feature keeps hitting.
  //
  // So stop asking about the album and ask about the TRACK. album_tracks holds
  // Roon's own contents for every album this extension has had open, so when
  // it has seen the album, this is exact rather than tolerant.
  const byTrack = resolveSharedByTrackIndex(trackTitle, artist);
  if (byTrack) return { album: byTrack, via: "tracks" };

  // Last: the play history. Weaker than the track index — it knows only what
  // this household has played, and it identifies the album by the line3 text
  // Roon rendered at the time — so it runs after it, not before.
  for (const row of playsForTrack(trackTitle)) {
    // The history's artist column is the TRACK artist, which is exactly what a
    // share carries, so it is the right thing to compare against here.
    if (artist && row.artist && !namesEqualLoose(row.artist, artist)) continue;
    const hit = findSharedAlbum(row.album, row.artist || artist);
    if (hit) return { album: hit, via: "history" };
  }
  return null;
}

// Track title -> the one library album that holds it. Zero Roon calls.
//
// Refuses on ambiguity exactly like the album rungs do: a track title on two
// different albums by the same artist (the original and the compilation) is a
// coin flip, and the artist gate is what keeps a cover version by somebody
// else out of it entirely.
function resolveSharedByTrackIndex(trackTitle, artist) {
  const rows = albumKeysForTrack(trackTitle);
  if (!rows.length) return null;
  const lut = libraryLookup();
  let hit = null;
  for (const row of rows) {
    const arr = lut.byAkey.get(row.akey);
    // A row whose album has left the library resolves to nothing — the table
    // outlives individual snapshots by design.
    if (!arr || arr.length !== 1) continue;
    const al = arr[0];
    if (artist && !sharedCreditAgrees(al, artist)) continue;
    if (hit && hit !== al) return null;   // two albums hold it — decline
    hit = al;
  }
  return hit;
}

// Build the storable record from an album this entry has ALREADY resolved to.
// Split out because resolveSharedEntry used to resolve twice — once for the
// record and once for the `via` — which doubled the SQL on the history rung
// and would have doubled it again on the track rung.
function shareTrackRecord(entry, hit) {
  const title = shareText(entry && entry.title, shareTextMax());
  if (!title || !hit) return null;
  const artist = shareText(entry && entry.creator, shareTextMax());

  return userTrackRecord({
    album_offset: hit.offset,
    album_title: hit.title,
    album_subtitle: hit.subtitle,
    // A hint only. The share carries no index, and invokeTrackAction re-matches
    // by title anyway, so 0 costs nothing and the title does the work.
    track_index: 0,
    title,
    subtitle: artist,
    image_key: hit.image_key,
    track_no: shareInt(entry && entry.trackNum, 1, 999),
  });
}

// How many albums one import may open on the Core to fill the track index, in
// total and for any single entry. This is the only part of import that is not
// free, so it is bounded twice: an import of 500 unmatched entries must not
// turn into 2,500 browse calls.
function shareDeepAlbumMax()    { return 25; }
function shareDeepPerEntryMax() { return 8; }
// A count is not a time limit. Each album open is up to 7 Roon calls, and each
// of those may now take up to 90s against a wedged Core — so a budget of 25
// albums alone could hold an HTTP request open for a very long time. This is
// the same clamp-server-side rule the encode route applies two hundred lines
// up, on the sibling of this route.
function shareDeepBudgetMs()    { return 45000; }

// Album identities whose contents are already recorded. Read once per deep
// pass so the candidate loop never re-opens an album this extension has
// already seen — that is the whole economy of the cache.
function indexedAlbumKeys() {
  if (!labelsDb) return new Set();
  try {
    return new Set(labelsDb.prepare("SELECT DISTINCT akey FROM album_tracks").all().map(r => r.akey));
  } catch (e) {
    return new Set();   // table missing on a pre-migration DB — nothing indexed
  }
}

// Fill the track index on demand for entries no name could resolve.
//
// The candidates are not a search: they are the albums in THIS library credited
// to the artist the share names, which is a handful even for a prolific one.
// Opening each records its contents (openAlbumByOffset writes through), so the
// ordinary track rung answers immediately afterwards — and the work is done
// once, for good, for every future import and every other entry by that artist
// in this one.
async function deepResolveSharedEntries(pending) {
  if (!core || !pending.length) return;
  const indexed = indexedAlbumKeys();
  const tried = new Set();
  const deadline = Date.now() + shareDeepBudgetMs();
  let budget = shareDeepAlbumMax();

  for (const p of pending) {
    if (budget <= 0 || Date.now() > deadline) break;
    if (!p.artist) continue;   // no artist, no candidate list

    // An earlier entry may already have opened the album this one needs —
    // Dreams and Linger come off the same record — so ask before spending.
    let hit = resolveSharedByTrackIndex(p.title, p.artist);
    if (hit) { p.found = { album: hit, via: "tracks" }; continue; }

    // The candidate scan uses the credit identities ALREADY on each record —
    // the same way /api/artist-albums asks this question. Calling
    // creditHasArtist here instead re-derived both sides for every album:
    // the entries that reach this pass are precisely the ones whose artist is
    // absent from the library, so the loop never breaks early and runs the
    // full snapshot, per entry, synchronously, before a single Roon call.
    const q = canonArtist(p.artist);
    const cands = [];
    if (q) {
      for (const al of albumIndex.albums) {
        if (cands.length >= shareDeepPerEntryMax()) break;
        if (al.cArtist === undefined) applyCreditIdentities(al);
        const names = al.cCredits;
        if (names ? !names.includes(q) : al.cArtist !== q) continue;
        const k = albumKey(al.title || "", al.subtitle || "");
        if (!k || indexed.has(k) || tried.has(k)) continue;
        cands.push({ al, k });
      }
    }

    for (const c of cands) {
      if (budget <= 0 || Date.now() > deadline) break;
      tried.add(c.k);
      budget--;
      try {
        await openAlbumByOffset(c.al.offset, null, null, null,
                                { title: c.al.title, subtitle: c.al.subtitle });
        indexed.add(c.k);
      } catch (e) {
        // A single unreadable album (moved offset mid-import, Core blip) must
        // not abandon the rest of the pass. Logged, not swallowed.
        console.log("[share] deep scan skipped " + JSON.stringify(c.al.title || "") +
                    ": " + e.message);
        continue;
      }
      hit = resolveSharedByTrackIndex(p.title, p.artist);
      if (hit) { p.found = { album: hit, via: "tracks" }; break; }
    }
  }
}

// The same resolution, plus how it got there. Kept separate so the storable
// record stays exactly the named-field literal it has always been — nothing
// from a shared file may reach storage by any other route.
function resolveSharedEntry(entry) {
  const title = shareText(entry && entry.title, shareTextMax());
  if (!title) return null;
  const albumTitle = shareText(entry && entry.album, shareTextMax());
  const artist = shareText(entry && entry.creator, shareTextMax());
  const found = resolveSharedAlbum(albumTitle, artist, title);
  if (!found) return null;
  const track = shareTrackRecord(entry, found.album);
  if (!track) return null;
  return { track, via: found.via, album: found.album };
}

// Turn a playlist's tracks into a shareable blob.
// body: { name, annotation?, tracks: [{title, artist, album, track_no, ...}] }
app.post("/api/share/encode", (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.tracks) || !body.tracks.length) {
    return res.status(400).json({ error: "tracks required" });
  }
  // The OUTPUT cap bounds what gets encoded; this bounds what gets WALKED.
  // Without it a 1 MB body of untitled entries is ~65,000 iterations of
  // synchronous work on an unauthenticated route — the design doc's S2, which
  // says to clamp server-side rather than trust the client's own ceiling.
  if (body.tracks.length > shareInputMax()) {
    return res.status(400).json({
      error: `Too many entries — ${shareInputMax()} at most`,
    });
  }
  try {
    const built = buildShareDoc({ name: body.name, annotation: body.annotation }, body.tracks);
    if (!built.track_count) {
      return res.status(400).json({ error: "None of those tracks had a title to share" });
    }
    const blob = encodeSharePayload(built.doc);
    res.json({
      blob,
      bytes: Buffer.byteLength(blob, "utf8"),
      track_count: built.track_count,
      skipped: built.skipped,
      truncated: built.truncated,
    });
  } catch (e) {
    console.warn("[share] encode failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- User playlist routes -------------------------------------------------
// Every one of these costs ZERO Roon calls: a user playlist stores its tracks
// rather than deriving them, unlike a smart playlist which has to open each
// album on the Core to find out what is on it.

app.get("/api/user-playlists", (req, res) => {
  res.json({ playlists: userPlaylists.map(userPlaylistSummary) });
});

app.get("/api/user-playlist", (req, res) => {
  const id = String(req.query.id || "").trim();
  const p = userPlaylists.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: "No such playlist" });
  res.json({ id: p.id, name: p.name, tracks: p.tracks, track_total: p.tracks.length });
});

// Create, or rename an existing one. body: { id?, name }
app.post("/api/user-playlists", (req, res) => {
  const body = req.body || {};
  const name = shareText(body.name, userPlNameMax());
  if (!name) return res.status(400).json({ error: "name required" });
  const id = shareText(body.id, 64);
  if (id) {
    const p = userPlaylists.find(x => x.id === id);
    if (!p) return res.status(404).json({ error: "No such playlist" });
    p.name = name;
    p.updated_at = Date.now();
  } else {
    if (userPlaylists.length >= userPlMax()) {
      return res.status(400).json({ error: `That's ${userPlMax()} playlists — delete one first` });
    }
    userPlaylists.push({ id: newUserPlaylistId(), name, tracks: [],
                         created_at: Date.now(), updated_at: Date.now() });
  }
  saveUserPlaylists();
  res.json({ ok: true, playlists: userPlaylists.map(userPlaylistSummary) });
});

app.post("/api/user-playlists/delete", (req, res) => {
  const id = shareText((req.body || {}).id, 64);
  const at = userPlaylists.findIndex(x => x.id === id);
  if (at === -1) return res.status(404).json({ error: "No such playlist" });
  userPlaylists.splice(at, 1);
  saveUserPlaylists();
  res.json({ ok: true, playlists: userPlaylists.map(userPlaylistSummary) });
});

// Find or create the playlist an add is aimed at. Shared so the track route and
// the album route cannot disagree about what "a name with no id" means.
function resolveUserPlaylistTarget(body) {
  const id = shareText(body.id, 64);
  if (id) {
    const p = userPlaylists.find(x => x.id === id);
    if (!p) return { error: "No such playlist", status: 404 };
    return { playlist: p };
  }
  const name = shareText(body.name, userPlNameMax());
  if (!name) return { error: "id or name required", status: 400 };
  if (userPlaylists.length >= userPlMax()) {
    return { error: `That's ${userPlMax()} playlists — delete one first`, status: 400 };
  }
  const p = { id: newUserPlaylistId(), name, tracks: [],
              created_at: Date.now(), updated_at: Date.now() };
  userPlaylists.push(p);
  return { playlist: p };
}

// Append, clamped, and say what didn't fit. `full` travels so a caller can
// report a playlist that filled up rather than a clean success for a partial
// add — v1.7.17's lesson, applied to storage instead of to the queue.
function appendUserTracks(p, incoming) {
  let added = 0, skipped = 0, full = false;
  for (const t of incoming) {
    if (p.tracks.length >= userPlTracksMax()) { full = true; break; }
    const one = userTrackRecord(t);
    if (one) { p.tracks.push(one); added++; }
    else skipped++;
  }
  p.updated_at = Date.now();
  saveUserPlaylists();
  return { added, skipped, full };
}

// Append tracks. body: { id? | name?, tracks: [...] }
app.post("/api/user-playlists/add", (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.tracks) ? body.tracks : [];
  if (!incoming.length) return res.status(400).json({ error: "tracks required" });
  if (incoming.length > userPlAddMax()) {
    return res.status(400).json({ error: `Too many at once — ${userPlAddMax()} maximum` });
  }
  // Same resolver as the album route — two copies of this logic is how the two
  // routes end up disagreeing about what a name with no id should do.
  const target = resolveUserPlaylistTarget(body);
  if (target.error) return res.status(target.status).json({ error: target.error });
  const p = target.playlist;
  const r = appendUserTracks(p, incoming);
  res.json(Object.assign({ ok: true, id: p.id, name: p.name,
                           track_total: p.tracks.length }, r));
});

// Add whole ALBUMS. Unlike the track route this costs Roon calls — a stored
// entry names specific tracks, and an album's tracklist only exists on the
// Core, so each album has to be opened to find out what is on it (~5 browse
// calls each). Bounded accordingly, and reported per album.
// body: { id? | name?, albums: [{offset, title, subtitle, image_key}] }
app.post("/api/user-playlists/add-albums", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const body = req.body || {};
  const albums = Array.isArray(body.albums) ? body.albums : [];
  if (!albums.length) return res.status(400).json({ error: "albums required" });
  if (albums.length > userPlAlbumAddMax()) {
    return res.status(400).json({
      error: `Too many albums at once — ${userPlAlbumAddMax()} maximum`,
    });
  }
  const target = resolveUserPlaylistTarget(body);
  if (target.error) return res.status(target.status).json({ error: target.error });
  const p = target.playlist;

  const tracks = [];
  const failed = [];
  for (const al of albums) {
    const offset = shareInt(al && al.offset, 0, 5000000);
    const title = shareText(al && al.title, shareTextMax());
    if (offset === null || !title) { failed.push(String((al && al.title) || "?")); continue; }
    const subtitle = shareText(al && al.subtitle, shareTextMax());
    try {
      // One album at a time, deliberately — the same reasoning as
      // /api/smart-playlist: a Promise.all here would open a browse session per
      // album against the Core simultaneously.
      const got = await withBrowseSession(sk => loadAlbumSession(
        sk, offset, null, { title, subtitle }, null));
      const items = (got.items || []).filter(t => isTrackItem(t, got.playMenu));
      items.forEach((t, i) => {
        tracks.push({
          album_offset: got.offset,
          album_title: title,
          album_subtitle: subtitle,
          track_index: i,
          title: stripTrackNumber(t.title),
          subtitle: t.subtitle || subtitle,
          image_key: shareText(al.image_key, 200) || null,
          track_no: trackNumberOf(t.title),
        });
      });
    } catch (e) {
      // One unreadable album must not lose the rest of the selection. Named in
      // the response so the user knows which one didn't make it.
      console.warn(`[uplaylist] couldn't read album "${title}" — ${e.message}`);
      failed.push(title);
    }
  }

  const r = appendUserTracks(p, tracks);
  res.json(Object.assign({ ok: true, id: p.id, name: p.name,
                           albums_read: albums.length - failed.length,
                           albums_failed: failed,
                           track_total: p.tracks.length }, r));
});

// Import a shared blob. Pass 1 is entirely in memory — no Roon calls — and
// answers in milliseconds however long the playlist is. Pass 2 runs only when
// the caller asks (`deep`), and only for what pass 1 could not place: it opens
// candidate albums on the Core, bounded by shareDeepAlbumMax and a wall-clock
// budget.
app.post("/api/share/import", async (req, res) => {
  const blob = (req.body || {}).blob;
  if (typeof blob !== "string" || !blob.trim()) {
    return res.status(400).json({ error: "blob required" });
  }
  let doc;
  try { doc = decodeSharePayload(blob); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    await ensureAlbumIndex();
    if (!isIndexBuilt()) {
      return res.status(503).json({ error: "Library index is still building — try again shortly" });
    }
    const entries = doc.playlist.track.slice(0, userPlTracksMax());
    const resolved = [];
    const missing = [];
    const substituted = [];

    // Pass 1 — names only, zero Roon calls, exactly as before.
    const state = entries.map(e => ({
      entry: e,
      title:  shareText(e && e.title, shareTextMax()),
      artist: shareText(e && e.creator, shareTextMax()),
      found:  resolveSharedEntry(e),
    }));

    // Pass 2 — ask the Core what is actually ON its albums, but only for what
    // pass 1 could not place, and only when the caller asked for it. The client
    // renders pass 1 first and then requests this, so the report is never
    // waiting on browse calls it may not need.
    if (req.body && req.body.deep) {
      try {
        await deepResolveSharedEntries(state.filter(s => !s.found));
      } catch (e) {
        // The fast result is already computed and worth returning; a failed
        // deep pass costs coverage, not the import.
        console.warn("[share] deep pass failed: " + e.message);
      }
      for (const s of state) {
        if (s.found && !s.found.track) s.found.track = shareTrackRecord(s.entry, s.found.album);
        if (s.found && !s.found.track) s.found = null;
      }
    }

    for (const s of state) {
      const e = s.entry;
      const found = s.found;
      if (found) {
        resolved.push(found.track);
        // Matched, but not on the album the share named — the track index or
        // the play history knew what Roon calls the record this track actually
        // sits on. Listed so the user sees the substitution instead of
        // wondering later why a track's album reads differently from the
        // playlist they were sent.
        if (found.via !== "album") {
          substituted.push({
            title: shareText(e && e.title, 200),
            artist: shareText(e && e.creator, 200),
            shared_album: shareText(e && e.album, 200),
            found_album: found.album.title || "",
          });
        }
      } else {
        // Reported, never silently dropped: "38 of 45" is the honest outcome
        // and the missing 7 are the interesting part.
        missing.push({
          title: shareText(e && e.title, 200),
          artist: shareText(e && e.creator, 200),
          album: shareText(e && e.album, 200),
        });
      }
    }
    res.json({
      ok: true,
      name: shareText(doc.playlist.title, userPlNameMax()) || "Shared playlist",
      total: doc.playlist.track.length,
      truncated: doc.playlist.track.length > userPlTracksMax(),
      resolved,
      missing,
      substituted,
      // Whether a second, Core-reading pass could still find some of the
      // misses. The client uses it to decide whether to run one — never
      // guessing from missing.length, because a deep pass that has already run
      // must not be run again.
      deep_available: !!core && !!missing.length && !(req.body && req.body.deep),
    });
  } catch (e) {
    console.warn("[share] import failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/smart-playlists", (req, res) => {
  // Each row carries its album count so the tile can read like a playlist tile
  // ("48 Albums"). Costs nothing — libraryView is in-memory and cached.
  const list = loadSmartPlaylists();
  let counted = list;
  if (isIndexBuilt()) {
    counted = list.map(p => {
      try {
        const view = libraryView(p.view);
        // Up to four DISTINCT covers for the tile mosaic, straight from the
        // snapshot — no Roon calls. Distinct because a playlist that resolves to
        // one artist would otherwise show the same sleeve four times.
        const keys = [];
        for (const al of view) {
          if (al.image_key && !keys.includes(al.image_key)) keys.push(al.image_key);
          if (keys.length === 4) break;
        }
        // `album_total` is what this playlist DELIVERS; `album_matched` is what
        // the query found. The tile showed the second and played the first,
        // which is precisely the mismatch that made the cap misleading.
        return Object.assign({}, p, {
          album_total: Math.min(view.length, p.limit),
          album_matched: view.length,
          art_keys: keys,
        });
      }
      catch (e) { return p; }   // a bad view must not take the whole list down
    });
  }
  res.json({ playlists: counted });
});

// Create or rename/update one.  body: { id?, name, view, limit? }
// An omitted id creates; a known id replaces in place (so "save over" works).
app.post("/api/smart-playlists", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim().slice(0, SMART_NAME_MAX);
  if (!name) return res.status(400).json({ error: "name required" });

  const list = loadSmartPlaylists();
  const id = String(body.id || "").trim();
  // Built through smartPlaylistRecord so the limit is normalised by the same
  // function that reads it back off disk — a second, hand-rolled shape here is
  // how the two drift.
  const record = smartPlaylistRecord({
    id: id || ("sp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    name, view: body.view, limit: body.limit, mode: body.mode, order: body.order,
  });
  if (!record) return res.status(400).json({ error: "name required" });

  const at = id ? list.findIndex(p => p.id === id) : -1;
  if (at >= 0) {
    list[at] = record;
  } else {
    // Same name twice is a rename-in-place, not a duplicate — the picker is a
    // flat list and two identical rows would be indistinguishable.
    const byName = list.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (byName >= 0) { record.id = list[byName].id; list[byName] = record; }
    else {
      if (list.length >= SMART_MAX) {
        return res.status(400).json({ error: `That's the limit of ${SMART_MAX} smart playlists` });
      }
      list.push(record);
    }
  }
  if (!saveSmartPlaylists(list)) return res.status(500).json({ error: "Couldn't save" });
  console.log(`[smart] saved "${name}"`);
  // album_matched travels back so the client can say "plays 100 of the 1,179
  // that match" at the moment of saving, rather than leaving the user to
  // discover the limit when a play falls short of the count on the tile.
  let matched = null;
  try { if (isIndexBuilt()) matched = libraryView(record.view).length; }
  catch (e) { /* a bad view must not fail the save that just succeeded */ }
  res.json({ ok: true, playlist: Object.assign({}, record, { album_matched: matched }),
             playlists: list });
});

app.post("/api/smart-playlists/delete", (req, res) => {
  const id = String((req.body && req.body.id) || "").trim();
  if (!id) return res.status(400).json({ error: "id required" });
  const list = loadSmartPlaylists();
  const next = list.filter(p => p.id !== id);
  if (next.length === list.length) return res.status(404).json({ error: "No such dynamic playlist" });
  if (!saveSmartPlaylists(next)) return res.status(500).json({ error: "Couldn't save" });
  console.log(`[smart] deleted ${id}`);
  res.json({ ok: true, playlists: next });
});

// Every Roon playlist. One browse walk, so the client should open this on
// demand (the side menu) rather than on every Home load.
app.get("/api/playlists", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const out = await listPlaylists();
    const cache = loadPlaylistArtCache();
    out.playlists = out.playlists.map(p => {
      const k = cache[playlistKeyOf(p.title)];
      return Array.isArray(k) ? Object.assign({}, p, { art_keys: k }) : p;
    });
    res.json(out);
  } catch (e) {
    console.warn("[playlists] list failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Cover mosaics for Roon playlists.
//
// Roon hands us no artwork for a playlist at the LIST level (every tile came
// back with a null image_key), so a mosaic has to be built from the artwork of
// the tracks inside — which means opening the playlist. That is a browse walk
// per playlist, far too expensive to do for a whole grid on every visit, so the
// result is cached on the data volume and keyed by playlist title. Artwork for a
// given playlist barely changes, and a wrong-but-stale mosaic is a cosmetic miss
// on a tile whose name is still correct.
const PLAYLIST_ART_MAX = 300;   // a cache, not a database
// Installs the map into the settings object on first use rather than handing
// back a fresh {}. Mosaics are fetched by two workers at once, and with a
// throwaway object each of the first two writers would build its own copy and
// the second save would drop the first's entry. Sharing one reference — the
// same one savePersistedSettings mutates in place — makes that impossible.
function loadPlaylistArtCache() {
  const s = loadPersistedSettings();
  if (!s.playlistArt || typeof s.playlistArt !== "object" || Array.isArray(s.playlistArt)) {
    s.playlistArt = {};
  }
  return s.playlistArt;
}
function savePlaylistArt(title, keys) {
  const cache = loadPlaylistArtCache();
  const key = playlistKeyOf(title);
  if (!key) return;
  cache[key] = keys;
  // Bounded: drop the oldest insertions once over the cap. Object key order is
  // insertion order for string keys, so this is stable.
  const names = Object.keys(cache);
  if (names.length > PLAYLIST_ART_MAX) {
    for (const n of names.slice(0, names.length - PLAYLIST_ART_MAX)) delete cache[n];
  }
  savePersistedSettings({ playlistArt: cache });
}

app.get("/api/playlist/art", async (req, res) => {
  const title = String(req.query.title || "");
  const key = playlistKeyOf(title);
  if (!key) return res.status(400).json({ error: "title required" });

  const cached = loadPlaylistArtCache()[key];
  if (Array.isArray(cached)) return res.json({ title, art_keys: cached, cached: true });

  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  try {
    const { items, playMenu } =
      await withBrowseSession(sk => loadPlaylistSession(sk, offset, title, null));
    const keys = [];
    for (const t of items) {
      if (!isTrackItem(t, playMenu)) continue;
      // Distinct covers only — a playlist of one album would otherwise show the
      // same sleeve four times, which reads as a rendering bug.
      if (t.image_key && !keys.includes(t.image_key)) keys.push(t.image_key);
      if (keys.length === 4) break;
    }
    // Cached even when empty, so a playlist with no artwork isn't re-walked on
    // every visit to the grid.
    savePlaylistArt(title, keys);
    res.json({ title, art_keys: keys, cached: false });
  } catch (e) {
    if (e.stale) return res.status(409).json({ error: e.message, stale: true });
    res.status(500).json({ error: e.message });
  }
});

// One playlist's tracks.  ?offset=<n>&title=<name>
// `title` is what makes the read safe — see loadPlaylistSession.
app.get("/api/playlist", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  const title  = String(req.query.title || "");
  // Optional, but the client always sends it (see loadPlaylistSession).
  const zone   = String(req.query.zone || "") || null;
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  try {
    const { items, playMenu, item, total } =
      await withBrowseSession(sk => loadPlaylistSession(sk, offset, title, zone));
    const tracks = items.filter(t => isTrackItem(t, playMenu)).map((t, i) => ({
      index:    i,
      title:    stripTrackNumber(t.title),
      subtitle: t.subtitle || "",
      image_key: t.image_key || null,
      // Usually null here — a playlist is not an album, so Roon rarely numbers
      // its rows. Carried anyway because export reads this shape.
      track_no: trackNumberOf(t.title)
    }));
    res.json({
      title: item.title || "", subtitle: item.subtitle || "",
      image_key: item.image_key || null,
      tracks,
      // Roon reports the real length; we only read PLAYLIST_ITEMS of it, so say
      // so rather than letting a long playlist look truncated for no reason.
      total,
      // Only truncated if we actually hit the read ceiling. `total` is the
      // browse LEVEL's row count, which includes the play-menu row that
      // isTrackItem excludes — comparing the two made every playlist with a
      // Play action report "showing the first N of N+1".
      truncated: tracks.length >= PLAYLIST_ITEMS,
      can_play: !!playMenu
    });
  } catch (e) {
    if (e.stale) return res.status(409).json({ error: e.message, stale: true });
    console.warn("[playlist] load failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Play or queue a whole playlist.
// body: { offset, title, zone_or_output_id, kind }
app.post("/api/playlist/play", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { title, zone_or_output_id, kind } = req.body || {};
  const offset = parseInt(req.body && req.body.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: "offset required" });
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  if (!kind)              return res.status(400).json({ error: "kind required" });
  try {
    res.json(await invokePlaylistAction(offset, title, zone_or_output_id, kind));
  } catch (e) {
    if (e.stale) return res.status(409).json({ error: e.message, stale: true });
    console.warn("[playlist] play failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Play or queue one track of a playlist.
// body: { offset, title, track_index, track_title, zone_or_output_id, kind }
app.post("/api/playlist/play-track", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { title, track_title, zone_or_output_id, kind } = req.body || {};
  const offset = parseInt(req.body && req.body.offset, 10);
  const idx    = parseInt(req.body && req.body.track_index, 10);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: "offset required" });
  if (!Number.isFinite(idx) || idx < 0)       return res.status(400).json({ error: "track_index required" });
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  if (!kind)              return res.status(400).json({ error: "kind required" });
  try {
    res.json(await invokePlaylistTrackAction(offset, title, idx, track_title, zone_or_output_id, kind));
  } catch (e) {
    if (e.stale) return res.status(409).json({ error: e.message, stale: true });
    console.warn("[playlist] play-track failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/album", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  // Album identity travels with the request so a stale offset (library
  // changed since the tile rendered) is detected and relocated server-side.
  const expect = req.query.title
    ? { title: String(req.query.title), subtitle: String(req.query.subtitle || "") }
    : null;
  try {
    const r = await openAlbumByOffset(offset, null, null, parseFilter(req.query), expect);
    res.json({
      album:  withSource(r.album),
      tracks: r.tracks,
      actions: r.actions.map(a => ({ kind: a.kind, title: a.title })),
      offset: r.offset,  // corrected when the stale-offset defense relocated
      // Library-validated split of the credit into individually linkable
      // artist names (single-element array when the credit stays whole).
      artists: splitCreditIntoArtists(r.album.subtitle)
    });
  } catch (e) {
    res.status(e.stale ? 409 : 500).json({ error: e.message });
  }
});

// Library stats — served directly from albumIndex (already built in memory).
app.get("/api/library-stats", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const count = albumIndex.count;
  res.json({ albums: count, building: count === 0 && !!albumIndex.building });
});

// Music directory mount status — tells the UI whether file metadata scanning is available.
app.get("/api/music-mount", (req, res) => {
  res.json({ mounted: musicDirMounted(), path: MUSIC_DIR });
});

// Discogs personal access token — get status (masked) or save.
app.get("/api/settings/discogs-token", (req, res) => {
  res.json({
    set: !!discogsToken,
    masked: discogsToken ? "••••••••" + discogsToken.slice(-4) : ""
  });
});
app.post("/api/settings/discogs-token", (req, res) => {
  const token = ((req.body && req.body.token) || "").trim();
  if (!token) return res.status(400).json({ ok: false, error: "token is empty" });
  discogsToken = token;
  const saved = savePersistedSettings({ discogsToken: token });
  console.log("[settings] discogs token set (" + token.length + " chars), persisted=" + saved);
  res.json({ ok: true, saved });
});

// FanArt.tv API key — get status (masked) or save.
app.get("/api/settings/fanart-key", (req, res) => {
  res.json({
    set: !!fanartKey,
    masked: fanartKey ? "••••••••" + fanartKey.slice(-4) : ""
  });
});
app.post("/api/settings/fanart-key", (req, res) => {
  const key = ((req.body && req.body.key) || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "key is empty" });
  fanartKey = key;
  const saved = savePersistedSettings({ fanartKey: key });
  // A key saved AFTER the first scans used to be dead on arrival: every label
  // already carried a cached "no logo" verdict (recorded while the key was
  // absent or broken) that was kept forever — even across Force rescan.
  // Purge those misses and retry immediately; real logos are kept.
  const purged = purgeFanartLogoMisses();
  console.log("[settings] fanart key set (" + key.length + " chars), persisted=" + saved +
              ", cleared " + purged + " cached no-logo verdicts");
  if (labelsEnabled) appendLabelsLog("[labels:fanart] key saved — cleared " + purged + " cached misses, refetching");
  kickFanArtFetches().then(() => kickDiscogsLogoFetches()).catch(e => {
    if (DEBUG) console.error("[labels:fanart] post-save kick:", e.message);
  });
  res.json({ ok: true, saved, cleared: purged });
});

// Label-folder depth — for libraries organised in label folders. 0 = off (use
// the file's label tag). Saving a new value triggers a rescan so the change
// takes effect (the file pass overrides cached labels that differ).
app.get("/api/settings/label-folder-depth", (req, res) => {
  res.json({ depth: labelFolderDepth });
});
app.post("/api/settings/label-folder-depth", (req, res) => {
  const depth = parseInt((req.body && req.body.depth), 10);
  if (!Number.isFinite(depth) || depth < 0 || depth > 6) {
    return res.status(400).json({ ok: false, error: "depth must be 0–6" });
  }
  const changed = depth !== labelFolderDepth;
  labelFolderDepth = depth;
  const saved = savePersistedSettings({ labelFolderDepth: depth });
  console.log("[settings] label folder depth set to " + depth + ", persisted=" + saved);
  // Re-derive file labels from folders (or tags). This setting only means
  // anything to the label pipeline, so with Labels off there is nothing to
  // re-run — and nothing to write into the labels log about it.
  const rescanning = changed && !!core && labelsEnabled;
  if (rescanning && !labelsIndex.building) {
    labelsIndex.builtAt = 0;
    appendLabelsLog("[labels] rescan triggered by label-folder-depth change → " + depth);
    runLabelsIndexScan().catch(e => { if (DEBUG) console.error("[labels] rescan error:", e.message); });
  }
  res.json({ ok: true, saved, rescanning });
});

// ---------------------------------------------------------------------------
// Qobuz (UNOFFICIAL API) — new releases, featured lists, catalog search,
// artist discographies + favourites. See lib/qobuz.js.
// Uses the LMS/Lyrion Qobuz plugin's app_id; against Qobuz ToS; user's own
// account; no streaming/downloading (Roon streams). Use at your own risk.
// ---------------------------------------------------------------------------

// Re-login with the stored username + md5 password, refreshing the token.
// In-flight dedup + failure backoff: the global search made this path implicit
// (typed queries, possibly overlapping) — with STALE stored credentials it
// would otherwise fire a doomed login POST per search. Concurrent callers
// share one attempt; after a failure, attempts are refused for 60s with a
// "not connected" error (mapped to 400 by serviceErrorStatus) instead of
// hammering Qobuz's login endpoint. The Settings "save credentials" flow
// calls qobuz.login directly, so an explicit user retry is never blocked.
let qobuzLoginPending  = null;
let qobuzLoginFailedAt = 0;
function qobuzRelogin() {
  if (Date.now() - qobuzLoginFailedAt < 60 * 1000) {
    return Promise.reject(new Error("Qobuz not connected — recent login attempt failed, retrying shortly"));
  }
  if (!qobuzLoginPending) {
    qobuzLoginPending = (async () => {
      try {
        const r = await qobuz.login(qobuzUsername, qobuzPasswordMd5, true);
        qobuzToken = r.token;
        qobuzDisplayName = r.displayName;
        qobuzLoginFailedAt = 0;
        savePersistedSettings({ qobuzToken, qobuzDisplayName });
      } catch (e) {
        qobuzLoginFailedAt = Date.now();
        throw e;
      } finally {
        qobuzLoginPending = null;
      }
    })();
  }
  return qobuzLoginPending;
}

// Run an authenticated Qobuz call; on a 401 (expired token), re-login once and
// retry. Throws a "not connected" error if no credentials are stored.
async function qobuzWithToken(fn) {
  if (!qobuzToken && qobuzUsername && qobuzPasswordMd5) await qobuzRelogin();
  if (!qobuzToken) throw new Error("Qobuz not connected — add your Qobuz login in Settings");
  try {
    return await fn(qobuzToken);
  } catch (e) {
    if (e && e.code === 401 && qobuzUsername && qobuzPasswordMd5) {
      await qobuzRelogin();
      return await fn(qobuzToken);
    }
    throw e;
  }
}

// Best-effort release timestamp (ms) from a Qobuz album object.
function qobuzReleaseTs(a) {
  if (a.released_at && Number.isFinite(a.released_at)) return a.released_at * 1000;
  const d = a.release_date_original || a.release_date_stream || a.release_date_download;
  if (d) {
    const t = Date.parse(d);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Shared album→JSON normalizer for every album-returning Qobuz route.
// `favIds` is a Set of the user's favourited album ids (strings).
function normalizeQobuzAlbum(a, favIds) {
  return {
    id:           String(a.id),
    title:        a.title || "",
    version:      a.version || null,
    artist:       (a.artist && a.artist.name) || (a.performer && a.performer.name) || "",
    artist_id:    (a.artist && a.artist.id != null) ? String(a.artist.id) : null,
    image:        qobuz.pickImage(a),
    released_at:  qobuzReleaseTs(a),
    release_date: a.release_date_original || null,
    favourited:   favIds.has(String(a.id))
  };
}

// Normalize a raw Qobuz items array, skipping malformed entries without an id.
function normalizeQobuzAlbums(items, favIds) {
  const albums = [];
  for (const a of items || []) {
    if (!a || !a.id) continue;
    albums.push(normalizeQobuzAlbum(a, favIds));
  }
  return albums;
}

// Shared HTTP status mapping for streaming-service (Qobuz/Tidal) route
// failures: 429 passes through, "not connected" is the caller's fault (400),
// everything else is upstream (502).
function serviceErrorStatus(e) {
  return e && e.code === 429 ? 429 : (/not connected/i.test(e.message) ? 400 : 502);
}

// Non-negative integer `offset` query param, defaulting to 0.
function parseOffsetParam(req) {
  const offset = parseInt(req.query.offset, 10);
  return (Number.isFinite(offset) && offset > 0) ? offset : 0;
}

// Raw featured items per type (10-min TTL, see makeTtlCache) — tab flapping
// in the UI must not translate into repeated upstream calls.
function getFeaturedItemsCached(type) {
  return qobuzFeaturedCache.get(type, () => qobuzWithToken(t => qobuz.getFeaturedAlbums(t, type, 150)));
}

// Connection status (never returns credentials).
app.get("/api/settings/qobuz", (req, res) => {
  res.json({ connected: !!qobuzToken, username: qobuzUsername || "", displayName: qobuzDisplayName || "" });
});
// Connect: log in with email/password, persist token (+ md5 for re-login).
app.post("/api/settings/qobuz", async (req, res) => {
  const username = ((req.body && req.body.username) || "").trim();
  const password = ((req.body && req.body.password) || "");
  if (!username || !password) return res.status(400).json({ ok: false, error: "username and password required" });
  try {
    const r = await qobuz.login(username, password);
    qobuzUsername    = username;
    qobuzPasswordMd5 = r.passwordMd5;
    qobuzToken       = r.token;
    qobuzDisplayName = r.displayName;
    savePersistedSettings({ qobuzUsername, qobuzPasswordMd5, qobuzToken, qobuzDisplayName });
    qobuzFavIds.clear(); // account may have changed — drop cached favourite ids
    qobuzFeaturedCache.clear();
    // Newly connected account — read its favourites now so Qobuz badges appear
    // without waiting for the next library sync.
    refreshStreamAlbumKeys("qobuz connected").catch(e => {
      if (DEBUG) console.error("[stream] refresh:", e.message);
    });
    console.log("[settings] qobuz connected as " + qobuzDisplayName);
    res.json({ ok: true, displayName: qobuzDisplayName });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});
// Disconnect: clear all stored Qobuz credentials/token.
app.post("/api/settings/qobuz/disconnect", (req, res) => {
  qobuzUsername = qobuzPasswordMd5 = qobuzToken = qobuzDisplayName = "";
  qobuzFavIds.clear();
  qobuzFeaturedCache.clear();
  clearStreamAlbumKeys("qobuz");   // badges go with the account
  savePersistedSettings({ qobuzUsername: "", qobuzPasswordMd5: "", qobuzToken: "", qobuzDisplayName: "" });
  res.json({ ok: true });
});

// New releases from the last N days (default 30), newest first.
app.get("/api/qobuz/new-releases", async (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days <= 0 || days > 365) days = 30;
  try {
    // Which of these are already in the user's Qobuz favourites (any device).
    // Best-effort (cached): on failure the list still renders without marks.
    const [items, favIds] = await Promise.all([
      getFeaturedItemsCached("new-releases-full"),
      qobuzFavIds.get()
    ]);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const future = Date.now() + 2 * 24 * 60 * 60 * 1000; // tolerate a couple days' skew
    const albums = [];
    for (const a of items) {
      if (!a || !a.id) continue;
      const ts = qobuzReleaseTs(a);
      if (ts !== null && (ts < cutoff || ts > future)) continue; // outside the window
      albums.push(normalizeQobuzAlbum(a, favIds));
    }
    albums.sort((x, y) => (y.released_at || 0) - (x.released_at || 0));
    res.json({ albums, days });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// Add an album to the user's Qobuz favourites (idempotent).
app.post("/api/qobuz/favorite", async (req, res) => {
  const albumId = ((req.body && req.body.album_id) || "").toString().trim();
  if (!albumId) return res.status(400).json({ ok: false, error: "album_id required" });
  try {
    await qobuzWithToken(t => qobuz.favoriteAlbum(t, albumId));
    qobuzFavIds.add(albumId); // keep cache coherent (no-op while the cache is cold)
    res.json({ ok: true });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ ok: false, error: e.message });
  }
});

// Remove an album from the user's Qobuz favourites (idempotent).
app.post("/api/qobuz/unfavorite", async (req, res) => {
  const albumId = ((req.body && req.body.album_id) || "").toString().trim();
  if (!albumId) return res.status(400).json({ ok: false, error: "album_id required" });
  try {
    await qobuzWithToken(t => qobuz.unfavoriteAlbum(t, albumId));
    qobuzFavIds.remove(albumId); // keep cache coherent (no-op while the cache is cold)
    res.json({ ok: true });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ ok: false, error: e.message });
  }
});

// Full Qobuz catalog search (albums + artists), paged by offset. Results keep
// Qobuz's relevance order. Artist matches are only included on the first page.
app.get("/api/qobuz/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });
  const offset = parseOffsetParam(req);
  try {
    const [r, favIds] = await Promise.all([
      qobuzWithToken(t => qobuz.searchCatalog(t, q, 50, offset)),
      qobuzFavIds.get()
    ]);
    const albums = normalizeQobuzAlbums(r.albums.items, favIds);
    const artists = [];
    if (offset === 0) {
      for (const x of r.artists.items.slice(0, 8)) {
        if (!x || !x.id) continue;
        artists.push({
          id:           String(x.id),
          name:         x.name || "",
          image:        qobuz.pickImage(x),
          albums_count: x.albums_count || 0
        });
      }
    }
    // has_more is computed from the RAW page length: normalization can drop
    // malformed items, so comparing filtered counts against Qobuz's total
    // would leave a dead "Load more" on the last page.
    const hasMore = offset + r.albums.items.length < r.albums.total;
    res.json({ query: q, offset, limit: 50, total: r.albums.total, has_more: hasMore, albums, artists });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// A Qobuz artist's discography, paged by offset. Albums stay in Qobuz's own
// order — sorting each 50-album page independently would make dates jump
// around at every "Load more" seam, so no per-page re-sort here.
app.get("/api/qobuz/artist-albums", async (req, res) => {
  const artistId = String(req.query.artist_id || "").trim();
  if (!artistId) return res.status(400).json({ error: "artist_id required" });
  const offset = parseOffsetParam(req);
  try {
    const [r, favIds] = await Promise.all([
      qobuzWithToken(t => qobuz.getArtist(t, artistId, 50, offset)),
      qobuzFavIds.get()
    ]);
    const albums = normalizeQobuzAlbums(r.albums.items, favIds);
    const hasMore = offset + r.albums.items.length < r.albums.total; // raw length — see /api/qobuz/search
    res.json({
      artist: r.artist, offset, limit: 50, total: r.albums.total, has_more: hasMore, albums,
      // Qobuz's editorial bio was fetched all along and discarded — surface it
      // so the artist screen can show it (first page only; it never changes).
      biography: (offset === 0 && r.biography) ? stripHtml(String(r.biography)).trim() : ""
    });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// Qobuz featured/browse categories. Albums are returned in Qobuz's own order
// (meaningful for e.g. best-sellers), so no re-sorting here.
const QOBUZ_FEATURED_TYPES = new Set([
  "new-releases-full", "best-sellers", "most-streamed", "press-awards",
  "editor-picks", "qobuzissims", "ideal-discography", "recent-releases"
]);
app.get("/api/qobuz/featured", async (req, res) => {
  const type = String(req.query.type || "").trim();
  if (!QOBUZ_FEATURED_TYPES.has(type)) return res.status(400).json({ error: "invalid type" });
  try {
    const [items, favIds] = await Promise.all([
      getFeaturedItemsCached(type),
      qobuzFavIds.get()
    ]);
    res.json({ type, albums: normalizeQobuzAlbums(items, favIds) });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Tidal (UNOFFICIAL API) — new releases, featured lists, catalog search,
// artist discographies + favourites. See lib/tidal.js.
// Uses the LMS/Lyrion Tidal plugin's client credentials; against Tidal ToS;
// user's own account; no streaming/downloading (Roon streams). Login is via
// Tidal's OAuth device flow — we never see the user's password. Use at your
// own risk.
// ---------------------------------------------------------------------------

// Mint (or reuse) a short-lived access token from the stored refresh token.
// Refreshes 5 minutes before expiry. Throws a "not connected" error when no
// refresh token is stored (message matched by the frontend + serviceErrorStatus).
// Single-flight: concurrent callers (routes fire 2-3 Tidal calls in parallel
// via Promise.all) share one refresh exchange — Tidal may rotate refresh
// tokens, and parallel exchanges with the same token could invalidate it.
let tidalRefreshPending = null;
async function tidalEnsureAccessToken() {
  if (!tidalRefreshToken) throw new Error("Tidal not connected — connect your Tidal account in Settings");
  if (tidalAccessToken && Date.now() < tidalAccessTokenExpiry) return tidalAccessToken;
  if (tidalRefreshPending) return tidalRefreshPending;
  tidalRefreshPending = (async () => {
    try {
      const r = await tidal.refreshAccessToken(tidalRefreshToken);
      // The user may have disconnected while the exchange was in flight —
      // installing the fresh tokens would silently "re-connect" the account.
      if (!tidalRefreshToken) throw new Error("Tidal not connected — connect your Tidal account in Settings");
      tidalAccessToken = r.accessToken;
      tidalAccessTokenExpiry = Date.now() + Math.max(r.expiresIn - 300, 60) * 1000;
      if (r.refreshToken && r.refreshToken !== tidalRefreshToken) {
        tidalRefreshToken = r.refreshToken; // Tidal rotated it — persist the new one
        savePersistedSettings({ tidalRefreshToken });
      }
      return tidalAccessToken;
    } catch (e) {
      // A definitive rejection (revoked/expired refresh token) means the
      // stored connection is dead: degrade to "not connected" so the UI
      // shows the reconnect prompt instead of an endless 502.
      if (e && e.code === 401 && tidalRefreshToken) {
        console.error("[tidal] refresh token rejected — clearing stored connection");
        tidalRefreshToken = tidalUserId = tidalDisplayName = "";
        tidalAccessToken = "";
        tidalAccessTokenExpiry = 0;
        tidalFavIds.clear();
        tidalFeaturedCache.clear();
        savePersistedSettings({ tidalRefreshToken: "", tidalUserId: "", tidalDisplayName: "" });
        throw new Error("Tidal not connected — connect your Tidal account in Settings");
      }
      throw e;
    } finally {
      tidalRefreshPending = null;
    }
  })();
  return tidalRefreshPending;
}

// Run an authenticated Tidal call as fn(accessToken, countryCode, userId); on
// a 401 (expired/revoked access token) refresh once and retry. Throws a
// "not connected" error if no refresh token is stored.
async function tidalWithToken(fn) {
  const token = await tidalEnsureAccessToken();
  try {
    return await fn(token, tidalCountryCode, tidalUserId);
  } catch (e) {
    if (e && e.code === 401 && tidalRefreshToken) {
      tidalAccessToken = "";      // discard the rejected token …
      tidalAccessTokenExpiry = 0; // … and force a fresh refresh
      const fresh = await tidalEnsureAccessToken();
      return await fn(fresh, tidalCountryCode, tidalUserId);
    }
    throw e;
  }
}

// Best-effort release timestamp (ms) from a Tidal album object ("YYYY-MM-DD").
function tidalReleaseTs(a) {
  if (a.releaseDate) {
    const t = Date.parse(a.releaseDate);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Shared album→JSON normalizer for every album-returning Tidal route — the
// same shape normalizeQobuzAlbum emits, so the frontend stays service-generic.
// `favIds` is a Set of the user's favourited album ids (strings).
function normalizeTidalAlbum(a, favIds) {
  const lead = (a.artist && a.artist.name) ? a.artist : (a.artists && a.artists[0]) || null;
  return {
    id:           String(a.id),
    title:        a.title || "",
    version:      a.version || null,
    artist:       (lead && lead.name) || "",
    artist_id:    (lead && lead.id != null) ? String(lead.id) : null,
    image:        a.cover ? tidal.coverUrl(a.cover, "640x640") : null,
    released_at:  tidalReleaseTs(a),
    release_date: a.releaseDate || null,
    favourited:   favIds.has(String(a.id))
  };
}

// Normalize a raw Tidal items array, skipping malformed entries without an id.
function normalizeTidalAlbums(items, favIds) {
  const albums = [];
  for (const a of items || []) {
    if (!a || a.id == null) continue;
    albums.push(normalizeTidalAlbum(a, favIds));
  }
  return albums;
}

// Resolve a featured group ("new", "top", …) against Tidal's live /featured
// list — group ids aren't guaranteed stable, so match id OR name
// case-insensitively. Returns the group object, or null when Tidal doesn't
// currently offer it. The groups list shares the 10-min featured TTL cache.
async function resolveTidalFeaturedGroup(wanted) {
  const groups = await tidalFeaturedCache.get("groups", () =>
    tidalWithToken((t, cc) => tidal.getFeaturedGroups(t, cc)));
  const w = String(wanted).toLowerCase();
  // Exact id/name/path match first; fall back to a prefix match so a group
  // Tidal renames from "new" to e.g. "New albums" keeps resolving.
  for (const g of groups) {
    if (String(g.id).toLowerCase() === w || String(g.name).toLowerCase() === w ||
        String(g.path || "").toLowerCase() === w) return g;
  }
  for (const g of groups) {
    if (String(g.id).toLowerCase().startsWith(w) ||
        String(g.name).toLowerCase().startsWith(w) ||
        String(g.path || "").toLowerCase().startsWith(w)) return g;
  }
  return null;
}

// Raw featured items per group type (10-min TTL, see makeTtlCache) — the
// Tidal counterpart of getFeaturedItemsCached. A group missing upstream
// yields [] WITHOUT caching it: an unmatched/renamed group is re-probed on
// the next tap instead of pinning an empty tab for 10 minutes (the groups
// list itself is still TTL-cached, so re-probing is cheap).
async function getTidalFeaturedItemsCached(type) {
  const group = await resolveTidalFeaturedGroup(type);
  if (!group) return [];
  return tidalFeaturedCache.get("albums:" + type, () =>
    tidalWithToken((t, cc) => tidal.getFeaturedAlbums(t, cc, group.id, 150)));
}

// Connection status (never returns tokens).
app.get("/api/settings/tidal", (req, res) => {
  res.json({ connected: !!tidalRefreshToken, displayName: tidalDisplayName || "" });
});

// Start the OAuth device flow: respond immediately with the code/URL the user
// must approve on tidal.com, then poll the token endpoint server-side until
// approval, a terminal error, or code expiry. GET /api/settings/tidal/status
// reports the outcome. Starting a new flow supersedes a previous pending one.
app.post("/api/settings/tidal/start", async (req, res) => {
  try {
    if (tidalPendingAuth && tidalPendingAuth.timer) clearTimeout(tidalPendingAuth.timer);
    tidalPendingAuth = null;
    // Guard the gap across the await: a second /start racing this one must
    // win outright — without this, the server could poll flow A's deviceCode
    // while the UI displays flow B's user code (approval would never land).
    const gen = ++tidalAuthGen;
    const d = await tidal.startDeviceAuth();
    if (gen !== tidalAuthGen) {
      return res.status(409).json({ ok: false, error: "superseded by a newer Tidal login attempt" });
    }
    const pending = {
      deviceCode: d.deviceCode,
      interval:   Math.max(d.interval, 2) * 1000,
      expiresAt:  Date.now() + d.expiresIn * 1000,
      netFails:   0,    // consecutive network failures — a blip must not kill the login
      timer:      null,
      error:      null
    };
    tidalPendingAuth = pending;
    const poll = async () => {
      if (tidalPendingAuth !== pending) return; // superseded or cancelled
      pending.timer = null;
      try {
        if (Date.now() >= pending.expiresAt) {
          pending.error = "Login timed out — the Tidal code expired before it was approved";
          console.error("[tidal] device login expired before approval");
          return;
        }
        const r = await tidal.pollDeviceToken(pending.deviceCode);
        if (tidalPendingAuth !== pending) return; // superseded while awaiting
        if (r.pending) {
          pending.netFails = 0;
          // RFC 8628 slow_down: stretch the polling interval by 5s and keep going.
          if (r.slowDown) pending.interval += 5000;
          pending.timer = setTimeout(poll, pending.interval);
          return;
        }
        // Approved — persist the connection and prime the access token.
        tidalRefreshToken = r.refreshToken;
        tidalUserId       = r.userId;
        tidalCountryCode  = r.countryCode;
        tidalDisplayName  = r.displayName;
        tidalAccessToken  = r.accessToken;
        tidalAccessTokenExpiry = Date.now() + Math.max(r.expiresIn - 300, 60) * 1000;
        savePersistedSettings({ tidalRefreshToken, tidalUserId, tidalCountryCode, tidalDisplayName });
        tidalFavIds.clear();       // account may have changed — drop cached favourite ids
        tidalFeaturedCache.clear();
        tidalPendingAuth = null;
        // Newly connected account — read its favourites now so Tidal badges
        // appear without waiting for the next library sync.
        refreshStreamAlbumKeys("tidal connected").catch(e => {
          if (DEBUG) console.error("[stream] refresh:", e.message);
        });
        console.log("[settings] tidal connected as " + tidalDisplayName);
      } catch (e) {
        if (tidalPendingAuth !== pending) return;
        // A structured OAuth error (access_denied, expired_token, …) is a
        // definitive outcome; a network blip mid-approval is not — retry up
        // to 3 consecutive times before declaring the login dead.
        if (!e.oauthError && pending.netFails < 3) {
          pending.netFails++;
          console.error("[tidal] device login poll failed (retry " + pending.netFails + "/3):", e.message);
          pending.timer = setTimeout(poll, pending.interval);
          return;
        }
        pending.error = e.message; // terminal (denied/expired code) — surfaced via /status
        console.error("[tidal] device login failed:", e.message);
      }
    };
    pending.timer = setTimeout(poll, pending.interval);
    res.json({
      user_code:                 d.userCode,
      verification_uri:          d.verificationUri,
      verification_uri_complete: d.verificationUriComplete,
      expires_in:                d.expiresIn
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Device-flow progress for the settings UI to poll.
app.get("/api/settings/tidal/status", (req, res) => {
  if (tidalRefreshToken) return res.json({ state: "connected", displayName: tidalDisplayName || "" });
  if (tidalPendingAuth) {
    if (tidalPendingAuth.error) return res.json({ state: "error", error: tidalPendingAuth.error });
    return res.json({ state: "pending" });
  }
  res.json({ state: "idle" });
});

// Disconnect: clear all stored Tidal tokens/identity and any pending login.
app.post("/api/settings/tidal/disconnect", (req, res) => {
  if (tidalPendingAuth && tidalPendingAuth.timer) clearTimeout(tidalPendingAuth.timer);
  tidalPendingAuth = null;
  tidalRefreshToken = tidalUserId = tidalDisplayName = "";
  tidalCountryCode = "US";
  tidalAccessToken = "";
  tidalAccessTokenExpiry = 0;
  tidalFavIds.clear();
  tidalFeaturedCache.clear();
  clearStreamAlbumKeys("tidal");   // badges go with the account
  savePersistedSettings({ tidalRefreshToken: "", tidalUserId: "", tidalCountryCode: "US", tidalDisplayName: "" });
  res.json({ ok: true });
});

// New releases from the last N days (default 30), newest first — same shape
// and windowing as /api/qobuz/new-releases.
app.get("/api/tidal/new-releases", async (req, res) => {
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days <= 0 || days > 365) days = 30;
  try {
    // Which of these are already in the user's Tidal favourites (any device).
    // Best-effort (cached): on failure the list still renders without marks.
    const [items, favIds] = await Promise.all([
      getTidalFeaturedItemsCached("new"),
      tidalFavIds.get()
    ]);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const future = Date.now() + 2 * 24 * 60 * 60 * 1000; // tolerate a couple days' skew
    const albums = [];
    for (const a of items) {
      if (!a || a.id == null) continue;
      const ts = tidalReleaseTs(a);
      if (ts !== null && (ts < cutoff || ts > future)) continue; // outside the window
      albums.push(normalizeTidalAlbum(a, favIds));
    }
    albums.sort((x, y) => (y.released_at || 0) - (x.released_at || 0));
    res.json({ albums, days });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// Add an album to the user's Tidal favourites (idempotent).
app.post("/api/tidal/favorite", async (req, res) => {
  const albumId = ((req.body && req.body.album_id) || "").toString().trim();
  if (!albumId) return res.status(400).json({ ok: false, error: "album_id required" });
  try {
    await tidalWithToken((t, cc, userId) => tidal.favoriteAlbum(t, cc, userId, albumId));
    tidalFavIds.add(albumId); // keep cache coherent (no-op while the cache is cold)
    res.json({ ok: true });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ ok: false, error: e.message });
  }
});

// Remove an album from the user's Tidal favourites (idempotent).
app.post("/api/tidal/unfavorite", async (req, res) => {
  const albumId = ((req.body && req.body.album_id) || "").toString().trim();
  if (!albumId) return res.status(400).json({ ok: false, error: "album_id required" });
  try {
    await tidalWithToken((t, cc, userId) => tidal.unfavoriteAlbum(t, cc, userId, albumId));
    tidalFavIds.remove(albumId); // keep cache coherent (no-op while the cache is cold)
    res.json({ ok: true });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ ok: false, error: e.message });
  }
});

// Full Tidal catalog search (albums + artists), paged by offset. Results keep
// Tidal's relevance order. Artist matches are only included on the first page.
app.get("/api/tidal/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });
  const offset = parseOffsetParam(req);
  try {
    const [albumsPage, artistsPage, favIds] = await Promise.all([
      tidalWithToken((t, cc) => tidal.searchAlbums(t, cc, q, 50, offset)),
      offset === 0
        ? tidalWithToken((t, cc) => tidal.searchArtists(t, cc, q, 8))
        : Promise.resolve({ items: [], total: 0 }),
      tidalFavIds.get()
    ]);
    const albums = normalizeTidalAlbums(albumsPage.items, favIds);
    const artists = [];
    for (const x of artistsPage.items) {
      if (!x || x.id == null) continue;
      artists.push({
        id:           String(x.id),
        name:         x.name || "",
        image:        x.picture ? tidal.coverUrl(x.picture, "750x750") : null,
        albums_count: 0 // Tidal search doesn't report a per-artist album count
      });
    }
    const hasMore = offset + albumsPage.items.length < albumsPage.total; // raw length — see /api/qobuz/search
    res.json({ query: q, offset, limit: 50, total: albumsPage.total, has_more: hasMore, albums, artists });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// A Tidal artist's discography, paged by offset. Albums stay in Tidal's own
// order — matching /api/qobuz/artist-albums, which keeps upstream order so
// dates don't jump around at every "Load more" seam.
app.get("/api/tidal/artist-albums", async (req, res) => {
  const artistId = String(req.query.artist_id || "").trim();
  if (!artistId) return res.status(400).json({ error: "artist_id required" });
  const offset = parseOffsetParam(req);
  try {
    const [artist, page, favIds] = await Promise.all([
      tidalWithToken((t, cc) => tidal.getArtist(t, cc, artistId)),
      tidalWithToken((t, cc) => tidal.getArtistAlbums(t, cc, artistId, 50, offset)),
      tidalFavIds.get()
    ]);
    const albums = normalizeTidalAlbums(page.items, favIds);
    const hasMore = offset + page.items.length < page.total; // raw length — see /api/qobuz/search
    res.json({
      artist: {
        id:    artist.id,
        name:  artist.name,
        image: artist.picture ? tidal.coverUrl(artist.picture, "750x750") : null
      },
      offset, limit: 50, total: page.total, has_more: hasMore, albums
    });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// Tidal featured/browse categories ("new" is served by /api/tidal/new-releases).
// Albums are returned in Tidal's own order (meaningful for e.g. top), so no
// re-sorting here.
const TIDAL_FEATURED_TYPES = new Set(["top", "rising", "recommended"]);
app.get("/api/tidal/featured", async (req, res) => {
  const type = String(req.query.type || "").trim();
  if (!TIDAL_FEATURED_TYPES.has(type)) return res.status(400).json({ error: "invalid type" });
  try {
    const [items, favIds] = await Promise.all([
      getTidalFeaturedItemsCached(type),
      tidalFavIds.get()
    ]);
    res.json({ type, albums: normalizeTidalAlbums(items, favIds) });
  } catch (e) {
    res.status(serviceErrorStatus(e)).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Smart Picks — six albums a day by artists NOT in the library.
//
// Five picks drawn from the genres the library already lives in, changing daily.
//
// v1.7.48 dropped a sixth "stretch" pick — one album from a genre the library
// barely touched. It read well on paper and did not work in practice: an
// artist reached through a genre tag rather than through the user's own taste
// is a stranger, and the answer was almost always no. Removed rather than
// hidden, along with the MusicBrainz tag traffic behind it.
//
// WHY THIS IS SHAPED THE WAY IT IS
//
// 1. NOTHING HERE TOUCHES THE ROON CORE. Library analysis reads the snapshot
//    that already exists; similarity comes from ListenBrainz and MusicBrainz
//    over plain HTTP; albums are resolved against Qobuz/TIDAL. The only Core
//    cost is the sync that already runs, noticing a newly favourited album.
//
// 2. A PICK MUST BE ACTIONABLE. Roon plays only what is in the library — every
//    play route needs an offset into the albums hierarchy — so an artist name
//    on its own is useless. Each pick is resolved to a real streaming album the
//    user can favourite; Roon imports it and it becomes playable on the next
//    sync. This is exactly the flow the Qobuz/TIDAL browser already uses.
//
// 3. SEEDS COME FROM THE OBSCURE END. Similarity quality inverts with seed
//    popularity: Radiohead returns Nirvana, RHCP and Coldplay, while Bark
//    Psychosis returns Mogwai, Talk Talk, Tortoise, Slint and Labradford. The
//    sitewide hub chart (one request for the world's 1000 most-listened
//    artists) is what makes "never seed from the popular end" computable.
//
// 4. RANKING IS BY DISTANCE, NOT SIMILARITY. Every recommender sorts by
//    similarity descending, which is why they all surface the obvious. Here a
//    candidate reachable from ONE seed outranks one reachable from twelve: the
//    latter is somebody the user has had every opportunity to buy and hasn't.
// ---------------------------------------------------------------------------

const discovery = require("./lib/discovery");

// Vocabulary as functions so the tests read the shipping values rather than
// asserting against a constant they were handed.
function smartPickKinds()        { return ["adjacent"]; }
function smartAdjacentCount()    { return 5; }
function smartSeedCount()        { return 24; }
function smartPoolCount()        { return 150; }
// How long a shown artist stays out of the pool. Long enough that the set
// genuinely turns over, short enough that a big library isn't exhausted.
function smartSeenDays()         { return 120; }
function smartHubTtlMs()         { return 14 * 24 * 60 * 60 * 1000; }
function smartSimilarTtlMs()     { return 30 * 24 * 60 * 60 * 1000; }

// An album's key in the plays table. Title-only, because that is all Roon's
// now-playing feed gives us to record — two artists' "Greatest Hits" collide,
// the same limitation the Home "not played" row and the Library play sort
// already carry.
function albumPlayKey(al) { return String(al.title || "").toLowerCase().trim(); }

// The library as artists: canonArtist -> { canon, name, albums, plays }.
//
// Derived from album CREDITS, not from the plays table's artist column: that
// column holds the TRACK artist (Roon's three_line.line2), so on any compilation
// or classical record it names a performer rather than the act whose library
// entry this is. Credits are the same source linkableArtistSet uses, so
// membership tests here and artist links elsewhere can never disagree.
// Deliberately NOT cached. The obvious key is albumIndex.builtAt, and it is
// wrong: builtAt only moves on a full walk, so on a library that has stopped
// growing it never advances — while `plays` changes every time something is
// listened to. A profile cached that way freezes the play counts at whatever
// they were on the first build, and plays-per-album-owned is the seed policy.
// One pass over the albums costs a few hundred ms, once a day, in a background
// job. It has exactly one caller.
function libraryArtistProfile() {
  const stats = playStats();
  const map = new Map();
  for (const al of albumIndex.albums) {
    const plays = stats.count.get(albumPlayKey(al)) || 0;
    for (const name of splitCreditIntoArtists(al.subtitle || "")) {
      const c = canonArtist(name);
      // canonArtist returns "" for a punctuation- or CJK-only credit ("!!!").
      // An empty key would merge every such act into one bogus artist.
      if (!c) continue;
      let rec = map.get(c);
      if (!rec) { rec = { canon: c, name, albums: 0, plays: 0 }; map.set(c, rec); }
      rec.albums++;
      rec.plays += plays;
    }
  }
  return map;
}

// Which library artists to walk out from.
//
// Two filters and one sort. Hubs are excluded because seeding from them is what
// makes a recommender boring. What remains is sorted by plays PER ALBUM OWNED:
// an act with four plays across one album is a stronger statement of taste than
// one with six plays spread over twelve, and it is the small, deliberate
// corners of a library that lead somewhere new.
//
// A library with no play history yet still has to work, so the list is topped up
// with the most-owned non-hub artists — owning a lot by an artist the world
// isn't listening to is itself a taste signal.
function smartPickSeeds(profile, hubCanons, limit) {
  const cap = limit || smartSeedCount();
  const eligible = [];
  for (const rec of profile.values()) {
    if (hubCanons.has(rec.canon)) continue;
    eligible.push(rec);
  }
  const byCanon = (a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0);
  const played = eligible.filter(r => r.plays > 0).sort((a, b) =>
    (b.plays / b.albums) - (a.plays / a.albums) || a.albums - b.albums || byCanon(a, b));
  const out = played.slice(0, cap);
  if (out.length < cap) {
    const have = new Set(out.map(r => r.canon));
    const rest = eligible.filter(r => !have.has(r.canon))
      .sort((a, b) => b.albums - a.albums || byCanon(a, b));
    for (const r of rest) {
      if (out.length >= cap) break;
      out.push(r);
    }
  }
  return out;
}

// Fold similar-artist rows into one entry per candidate, remembering EVERY seed
// each was reached from — that count is the distance signal, so a candidate
// arriving twice must not overwrite itself.
function collectSmartCandidates(rows, seedNameByMbid) {
  const byMbid = new Map();
  for (const r of rows || []) {
    if (!r || !r.mbid || !r.name) continue;
    const canon = canonArtist(r.name);
    if (!canon) continue;
    let rec = byMbid.get(r.mbid);
    if (!rec) {
      rec = { mbid: r.mbid, name: r.name, canon, comment: r.comment || "",
              score: 0, seeds: [], seedNames: [] };
      byMbid.set(r.mbid, rec);
    }
    if (r.score > rec.score) rec.score = r.score;
    if (r.seed && rec.seeds.indexOf(r.seed) === -1) {
      rec.seeds.push(r.seed);
      const sn = seedNameByMbid && seedNameByMbid.get(r.seed);
      if (sn) rec.seedNames.push(sn);
    }
  }
  return Array.from(byMbid.values());
}

// Rank by distance from the library rather than by similarity to it.
//
// Fewest connections back first. With a couple of dozen seeds most candidates
// sit in the one-seed bucket, so score decides within it — which is why hub
// candidates have to be filtered out before this runs, or the strongest score
// in that bucket is simply the most famous name in it.
function rankSmartCandidates(cands) {
  return (cands || []).slice().sort((a, b) =>
    a.seeds.length - b.seeds.length ||
    b.score - a.score ||
    (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
}

// Spread the day's picks across DIFFERENT corners of the library.
//
// Ranking alone produces a monoculture, and measurably so: on a test library
// seeded from Bark Psychosis, Slint, Stars of the Lid, Labradford and Tortoise,
// the top five candidates were all neighbours of Stars of the Lid — five
// ambient records that between them said one thing. The distance sort cannot
// prevent that, because once most candidates sit in the one-seed bucket it
// decides on score alone, and the loudest seed owns every slot.
//
// So the ranked list is dealt round-robin: the best candidate from each seed,
// then each seed's second, and so on. Rank order is preserved WITHIN a seed,
// and the seed queues are already in rank order, so the strongest candidate
// overall still comes first — it just no longer brings four relatives with it.
function diversifySmartCandidates(ranked) {
  const bySeed = new Map();
  for (const c of ranked || []) {
    // A candidate's first seed is its strongest connection: `seeds` is filled
    // in arrival order from a list the endpoint returns strongest-first.
    const key = (c.seeds && c.seeds[0]) || "";
    if (!bySeed.has(key)) bySeed.set(key, []);
    bySeed.get(key).push(c);
  }
  const queues = Array.from(bySeed.values());
  const out = [];
  for (let round = 0; ; round++) {
    let moved = false;
    for (const q of queues) {
      if (round < q.length) { out.push(q[round]); moved = true; }
    }
    if (!moved) break;   // every queue exhausted
  }
  return out;
}

// Everything a candidate must not be. Kept as one function so the adjacent and
// every path agrees on what counts as "already known".
function smartPickExcluded(canon, sets) {
  if (!canon) return true;
  if (sets.library.has(canon)) return true;   // already owned
  if (sets.hubs.has(canon)) return true;      // famous is not a discovery
  if (sets.blocked.has(canon)) return true;   // user said "not for me"
  if (sets.seen.has(canon)) return true;      // shown recently
  return false;
}

// The sentence under a pick. Built from the chain that produced it, so it is
// always true — an LLM would write a nicer one and would sometimes be wrong,
// and a recommendation nobody can check is a recommendation nobody trusts.
function smartPickReason(rec) {
  const names = (rec.seedNames || []).filter(Boolean);
  if (!names.length) return "Close to what you already listen to";
  if (names.length === 1) return "Because you play " + names[0];
  return "Because you play " + names[0] + " and " + names[1];
}

// ---------------------------------------------------------------------------
// Smart Picks: cached API reads. Every one of these is persisted, so a rebuild
// on an unchanged library costs zero network calls as well as zero Roon calls.
// ---------------------------------------------------------------------------

function smartCacheGet(key, ttlMs) {
  if (!labelsDb) return null;
  try {
    const row = labelsDb.prepare("SELECT body, ts FROM smart_cache WHERE key = ?").get(key);
    if (!row) return null;
    if (Date.now() - row.ts > ttlMs) return null;
    return JSON.parse(row.body);
  } catch (e) {
    // A corrupt row must not take the build down — treat it as a miss and let
    // the next write replace it.
    if (DEBUG) console.error("[picks] cache read " + key + ": " + e.message);
    return null;
  }
}
function smartCacheSet(key, value) {
  if (!labelsDb || !stmtInsertSmartCache) return;
  try { stmtInsertSmartCache.run(key, JSON.stringify(value), Date.now()); }
  catch (e) { if (DEBUG) console.error("[picks] cache write " + key + ": " + e.message); }
}
// Expired rows are never read again but are never removed either — a row past
// its TTL is dead weight on the data volume forever. Swept once per build,
// using the longest TTL any key uses so nothing still-valid is dropped.
function smartCachePrune() {
  if (!labelsDb) return;
  try {
    const longest = Math.max(smartHubTtlMs(), smartSimilarTtlMs(), smartAlbumTtlMs());
    const r = labelsDb.prepare("DELETE FROM smart_cache WHERE ts < ?")
      .run(Date.now() - longest);
    if (DEBUG && r.changes) console.log("[picks] pruned " + r.changes + " cache rows");
  } catch (e) { if (DEBUG) console.error("[picks] cache prune: " + e.message); }
}

// The world's most-listened artists, as a Set of canonArtist keys.
async function smartHubSet() {
  let rows = smartCacheGet("hubs", smartHubTtlMs());
  if (!rows) {
    rows = await discovery.topArtists({ count: discovery.LB_TOP_MAX });
    if (rows.length) smartCacheSet("hubs", rows);
  }
  const set = new Set();
  for (const r of rows || []) {
    const c = canonArtist(r.name);
    if (c) set.add(c);
  }
  return set;
}

// Similar-artist rows for a set of seed MBIDs, per-seed cached.
async function smartSimilarRows(seedMbids) {
  const fresh = [];
  const out = [];
  for (const mbid of seedMbids) {
    const hit = smartCacheGet("sim:" + mbid, smartSimilarTtlMs());
    if (hit) { for (const r of hit) out.push(r); }
    else fresh.push(mbid);
  }
  if (fresh.length) {
    const rows = await discovery.similarArtistsBatched(fresh, {
      onError: (e, batch) =>
        console.error("[picks] similar-artists failed for " + batch.length +
                      " seed(s): " + e.message)
    });
    const bySeed = new Map();
    for (const m of fresh) bySeed.set(m, []);
    for (const r of rows) {
      if (bySeed.has(r.seed)) bySeed.get(r.seed).push(r);
      out.push(r);
    }
    // Cache per seed, including seeds that came back empty: ListenBrainz
    // genuinely knows nothing about some artists, and without a negative entry
    // every build would ask again forever.
    //
    // BUT only when the emptiness is real. Rows arrive tagged with the seed
    // that produced them, and a row the endpoint fails to attribute carries
    // seed "" — it still reaches `out`, so the CURRENT build looks fine, while
    // every seed gets an empty array written to its cache. Tomorrow all 24
    // seeds hit that cache (an empty array is a truthy hit), the build sees
    // zero rows, and the feature is dead for the full 30-day TTL with nothing
    // in the log, because the request itself succeeded. So: if the batch
    // returned rows but none of them could be attributed, write nothing and
    // let the next build ask again.
    const attributed = rows.some(r => bySeed.has(r.seed));
    if (!rows.length || attributed) {
      for (const [mbid, rs] of bySeed) smartCacheSet("sim:" + mbid, rs);
    } else {
      console.error("[picks] similar-artists returned " + rows.length +
                    " rows that match no seed we asked for — not caching, so " +
                    "this retries rather than sticking for the TTL");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smart Picks: turning a chosen artist into an album the user can actually add.
// ---------------------------------------------------------------------------

// Is each service usable? One definition each, so the three places that ask
// cannot drift apart the way the pre-existing gates already have.
function qobuzReady() { return !!(qobuzToken || (qobuzUsername && qobuzPasswordMd5)); }
function tidalReady() { return !!(tidalRefreshToken && tidalUserId); }

// Favourite a resolved pick's album on the service it came from.
//
// Used for the five adjacent picks at build time so Roon has the whole night to
// import them: by morning they are in the library and simply play, which is the
// point of running this at 4am. Idempotent on both services — favouriting an
// album already favourited is a no-op — so a rebuild cannot double anything.
//
// Returns true when the service accepted it. A failure is logged and the pick
// still ships; the user can add it by hand.
async function autoAddSmartAlbum(album) {
  if (!album || !album.id || !album.service) return false;
  try {
    if (album.service === "qobuz") {
      await qobuzWithToken(t => qobuz.favoriteAlbum(t, String(album.id)));
      qobuzFavIds.add(String(album.id));
    } else if (album.service === "tidal") {
      await tidalWithToken((t, cc, uid) => tidal.favoriteAlbum(t, cc, uid, String(album.id)));
      tidalFavIds.add(String(album.id));
    } else {
      return false;
    }
    return true;
  } catch (e) {
    if (smartRateLimited(e)) throw e;   // let the build stop rather than hammer
    console.error("[picks] could not auto-add " + JSON.stringify(album.title) +
                  " to " + album.service + ": " + e.message);
    return false;
  }
}

// Is a streaming service connected at all? Without one a pick can be shown but
// never added, so the UI needs to say so rather than presenting a dead button —
// and the build must not run at all, since every resolve would return null.
function smartPicksServiceReady() { return qobuzReady() || tidalReady(); }

// Thrown to abort a whole build when a service rate-limits us. These are the
// UNOFFICIAL Qobuz/TIDAL APIs, and the accounts behind them also power the
// service browser and the source badges — features the user actually uses. The
// same abort-on-429 shape the Discogs and iTunes passes already use.
function smartRateLimited(e) { return !!(e && e.code === 429); }

// How long a resolved (or unresolvable) artist->album answer is trusted.
function smartAlbumTtlMs() { return 7 * 24 * 60 * 60 * 1000; }

// Find a favouritable album by `artistName` on whichever service is connected.
// Returns a normalized album (plus which service it came from) or null.
//
// PERSISTED, INCLUDING MISSES. This is the one call that dominates a build —
// every candidate TRIED costs a search, not every candidate kept — so caching
// only the hits would leave the expensive half uncached. A miss is stored as
// { album: null }, which is truthy, so a cached negative is distinguishable
// from a cache miss.
async function resolveSmartAlbum(artistName) {
  const wantCanon = canonArtist(artistName);
  if (!wantCanon) return null;
  const key = "alb:" + wantCanon;
  const hit = smartCacheGet(key, smartAlbumTtlMs());
  if (hit) return hit.album;

  let album = null;
  // Whether a service actually ANSWERED. A negative may only be cached when one
  // did: caching "no album" after consulting nothing would write up to 150 dead
  // entries on a machine with no service connected, and the user who then
  // connects Qobuz would get an empty feature for the next seven days with no
  // way to tell why. A thrown lookup is the same case — the codebase already
  // states this discipline for the TTL cache ("the PROMISE is shared, never the
  // failure"), and a one-minute token blip must not become a week-long hole.
  let answered = false, errored = false;
  if (qobuzReady()) {
    try {
      const r = await qobuzWithToken(t => qobuz.searchCatalog(t, artistName, 20, 0));
      answered = true;
      // favIds is deliberately not fetched: it fills only the `favourited`
      // field, which persistSmartPicks does not store and the client never
      // reads. Fetching it cost an extra Qobuz call (and a large paged TIDAL
      // one) per minute of a build, for a value thrown away.
      const albums = normalizeQobuzAlbums(r.albums.items, new Set());
      // Qobuz search matches on title as well as artist, so an unfiltered top
      // hit is regularly a different act covering the name. Require the credit
      // to be the artist we asked for. canonArtist rather than namesEqualLoose
      // (which the artist-bio path uses) because this must agree with the
      // library/hub/blocked sets, which are all keyed in canonArtist space.
      const found = albums.find(a => canonArtist(a.artist) === wantCanon);
      if (found) album = Object.assign({ service: "qobuz" }, found);
    } catch (e) {
      if (smartRateLimited(e)) throw e;      // abort the build, do not hammer
      errored = true;
      console.error("[picks] Qobuz album lookup for " +
                    JSON.stringify(artistName) + " failed: " + e.message);
    }
  }
  if (!album && tidalReady()) {
    try {
      // searchArtists returns pagedSection(r) — { items, total } — NOT an array.
      // `(found || []).find` reads as defensive and is not: an object is truthy,
      // so the fallback never fires and .find is undefined. That threw on every
      // lookup, and the catch turned it into "no pick resolved" — which on a
      // TIDAL-only setup meant zero picks, forever. The sibling call at
      // /api/tidal/search reads .items correctly.
      const page = await tidalWithToken((t, cc) => tidal.searchArtists(t, cc, artistName, 5));
      answered = true;
      const found = ((page && page.items) || []).find(
        a => a && canonArtist(a.name) === wantCanon);
      if (found && found.id) {
        const page2 = await tidalWithToken(
          (t, cc) => tidal.getArtistAlbums(t, cc, found.id, 20, 0));
        const albums = normalizeTidalAlbums((page2 && page2.items) || [], new Set());
        if (albums.length) album = Object.assign({ service: "tidal" }, albums[0]);
      }
    } catch (e) {
      if (smartRateLimited(e)) throw e;
      errored = true;
      console.error("[picks] TIDAL album lookup for " +
                    JSON.stringify(artistName) + " failed: " + e.message);
    }
  }
  if (album || (answered && !errored)) smartCacheSet(key, { album });
  return album;
}

// ---------------------------------------------------------------------------
// Smart Picks: the daily build.
// ---------------------------------------------------------------------------

// Has Roon imported this album yet? Returns its snapshot record, or null.
//
// This is what turns a pick from "Add" into "Play". The user favourites an
// album on Qobuz, Roon imports it on its own schedule, and it appears in the
// next snapshot — at which point it has an offset and every ordinary play route
// works on it. Matching goes through albumKeys, the same tolerant identity the
// source badges use, because Roon's title for an album routinely differs from
// Qobuz's by an edition suffix.
let _smartLibIndex = { builtAt: -1, map: null };
function smartLibraryRecord(title, artist) {
  if (!title) return null;
  if (_smartLibIndex.builtAt !== albumIndex.builtAt || !_smartLibIndex.map) {
    const map = new Map();
    for (const al of albumIndex.albums) {
      for (const k of (al.srcKeys || [])) if (!map.has(k)) map.set(k, al);
    }
    _smartLibIndex = { builtAt: albumIndex.builtAt, map };
  }
  for (const k of albumKeys(title, artist || "")) {
    const hit = _smartLibIndex.map.get(k);
    if (hit) return hit;
  }
  return null;
}

function smartDayKey(d) {
  const t = d || new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}

function smartSeenSet() {
  const set = new Set();
  if (!labelsDb) return set;
  try {
    const cutoff = Date.now() - smartSeenDays() * 24 * 60 * 60 * 1000;
    for (const r of labelsDb.prepare(
      "SELECT canon FROM smart_pick_seen WHERE ts > ?").all(cutoff)) set.add(r.canon);
  } catch (e) { if (DEBUG) console.error("[picks] seen set: " + e.message); }
  return set;
}
function smartBlockedSet() {
  const set = new Set();
  if (!labelsDb) return set;
  try {
    for (const r of labelsDb.prepare("SELECT canon FROM smart_pick_blocks").all()) {
      set.add(r.canon);
    }
  } catch (e) { if (DEBUG) console.error("[picks] blocked set: " + e.message); }
  return set;
}
function readSmartPicks(day) {
  if (!labelsDb) return [];
  try {
    return labelsDb.prepare(
      // Rank IS the display order — persistSmartPicks writes the five adjacent
      // picks at 0-4. Sorting on kind as well once put a second kind first
      // (it sorted later, so DESC lifted it), which
      // led the row with the one pick chosen for being unlike the library.
      "SELECT * FROM smart_picks WHERE day = ? ORDER BY rank ASC").all(day);
  } catch (e) {
    if (DEBUG) console.error("[picks] read " + day + ": " + e.message);
    return [];
  }
}

// How many candidates a build may TRY to resolve before giving up, and how far
// Every candidate tried costs a streaming search whether or not it becomes a
// pick, so the pool size is not the bound that matters — this is. Without it a
// build whose service credentials have expired walks all 150 candidates,
// hundreds of live calls against APIs that are not officially ours to use.
function smartMaxResolves()      { return 40; }

// Marks a day as attempted, so a build that legitimately produces nothing is
// not retried on the next request. Without this, "did we build today?" is
// answered by "are there rows?", and a zero-pick day re-runs the whole pipeline
// every time anybody opens Home.
function smartAttemptKey(day) { return "built:" + day; }
function smartAttemptedToday(day) {
  return !!smartCacheGet(smartAttemptKey(day), 24 * 60 * 60 * 1000);
}

// Build today's picks. Called from the maintenance timer and after a sync —
// never from a request handler, so nothing a user does waits on it.
async function buildSmartPicks(day) {
  const t0 = Date.now();
  smartCachePrune();
  // Nothing here can produce an addable pick without a service to add it to,
  // and an unaddable pick is not worth the calls it costs to find.
  if (!smartPicksServiceReady()) {
    console.log("[picks] no streaming service connected — skipping today's build");
    smartCacheSet(smartAttemptKey(day), { at: Date.now(), reason: "no service" });
    return;
  }
  const profile = libraryArtistProfile();
  if (!profile.size) {
    console.log("[picks] no library artists yet — nothing to build from");
    return;   // deliberately NOT marked attempted: the library is still arriving
  }
  const hubs = await smartHubSet();
  // An empty hub chart is not a harmless degradation. It is what the entire
  // seed policy is built on: with no hubs, smartPickSeeds stops filtering and
  // seeds from the user's most-played artists — Radiohead, Pink Floyd — which
  // is the exact inversion this feature exists to avoid, and smartPickExcluded
  // stops rejecting famous candidates too. Better no picks today than a day of
  // picks that quietly discredit the feature.
  if (!hubs.size) {
    console.error("[picks] the sitewide artist chart came back empty — " +
                  "skipping today's build rather than seeding from the " +
                  "library's most famous artists");
    return;
  }
  const sets = {
    library: linkableArtistSet(),
    hubs,
    blocked: smartBlockedSet(),
    seen:    smartSeenSet()
  };

  // Seeds, and their MBIDs. fetchArtistMbid rate-limits itself against
  // MusicBrainz and refuses a fuzzy name match, so a seed it cannot identify is
  // dropped rather than walked from the wrong artist.
  const seeds = smartPickSeeds(profile, hubs, smartSeedCount());
  const seedNameByMbid = new Map();
  const seedMbids = [];
  for (const s of seeds) {
    const mbid = await fetchArtistMbid(s.name);
    if (!mbid) continue;
    seedMbids.push(mbid);
    seedNameByMbid.set(mbid, s.name);
  }
  if (!seedMbids.length) {
    console.log("[picks] no seed artist could be identified on MusicBrainz");
    return;
  }

  const rows  = await smartSimilarRows(seedMbids);
  const cands = collectSmartCandidates(rows, seedNameByMbid)
    .filter(c => !smartPickExcluded(c.canon, sets));
  const ranked = diversifySmartCandidates(rankSmartCandidates(cands))
    .slice(0, smartPoolCount());
  console.log("[picks] " + seedMbids.length + " seeds -> " + rows.length +
              " rows -> " + cands.length + " candidates (" + ranked.length + " pooled)");

  const picks = [];
  const used  = new Set();
  let tried = 0;
  try {
    for (const c of ranked) {
      if (picks.length >= smartAdjacentCount()) break;
      if (tried >= smartMaxResolves()) break;
      // collectSmartCandidates dedupes by MBID, not by canon, so two distinct
      // MusicBrainz artists can still collide here.
      if (used.has(c.canon)) continue;
      tried++;
      const album = await resolveSmartAlbum(c.name);
      if (!album) continue;      // nothing addable — a pick nobody can act on
      used.add(c.canon);
      // The picks go into the streaming library now, so Roon can import them
      // before anybody looks at the screen — that is what makes them playable
      // by morning rather than a button somebody has to press.
      const added = smartPicksAutoAdd ? await autoAddSmartAlbum(album) : false;
      picks.push({
        kind: "adjacent", mbid: c.mbid, artist: c.name, canon: c.canon,
        seedNames: c.seedNames, album, genre: "", autoAdded: added
      });
    }

  } catch (e) {
    if (!smartRateLimited(e)) throw e;
    // Rate-limited by Qobuz/TIDAL. Keep whatever resolved before the limit and
    // stop: continuing would push an unofficial API further into a cooldown
    // that also breaks the service browser and the source badges.
    console.error("[picks] rate limited by the streaming service — keeping the " +
                  picks.length + " pick(s) resolved so far and stopping");
  }

  persistSmartPicks(day, picks);
  smartCacheSet(smartAttemptKey(day), { at: Date.now(), picks: picks.length });
  console.log("[picks] built " + picks.length + " picks for " + day +
              " (" + tried + " candidates tried) in " + (Date.now() - t0) + "ms");
}

function persistSmartPicks(day, picks) {
  if (!labelsDb || !stmtInsertSmartPick) return;
  try {
    const wipe = labelsDb.prepare("DELETE FROM smart_picks WHERE day = ?");
    const tx = labelsDb.transaction(() => {
      wipe.run(day);
      let rank = 0;
      const kinds = smartPickKinds();
      for (const p of picks) {
        // The kind is persisted and drives the client's badge and styling. A
        // third kind added upstream without UI would render as an unlabelled
        // card, so it is rejected here rather than stored and puzzled over.
        if (kinds.indexOf(p.kind) === -1) {
          console.error("[picks] refusing to store unknown pick kind " +
                        JSON.stringify(p.kind) + " for " + p.artist);
          continue;
        }
        stmtInsertSmartPick.run(
          day, p.kind, rank++, p.mbid || "", p.artist, p.canon,
          p.album.title, String(p.album.id), p.album.service, p.album.image || "",
          smartPickReason(p), p.genre || "", Date.now());
        stmtInsertSmartSeen.run(p.canon, Date.now());
      }
    });
    tx();
  } catch (e) {
    console.error("[picks] persist failed: " + e.message);
  }
}

// Kick today's build if it hasn't happened, WITHOUT waiting for it.
//
// The build must never be awaited from a request handler. bgRun returns the
// queue tail AFTER appending, so awaiting it waits for everything already
// queued — on a fresh pair that is the streaming refresh, the genre harvest and
// an art prewarm of every album in the library. A user opening Home would have
// held an open request behind all of it. Nothing here waits: the client already
// renders an empty set as "building", and the next visit picks the rows up.
//
// _smartBuilding still matters even though bgRun serialises: bgRun orders jobs,
// it does not collapse duplicates, so three devices opening Home would enqueue
// three identical builds and triple every upstream call.
let _smartBuilding = null;
function kickSmartPicks(why, force) {
  // The single gate. Every caller — the timer, the post-sync kick, the request
  // path and the manual rebuild button — comes through here, so one check
  // covers all of them and none can drift. Off means no MusicBrainz, no
  // ListenBrainz, no streaming favourites written: nothing at all.
  if (!smartPicksEnabled) return;
  const day = smartDayKey();
  if (_smartBuilding) return;
  if (!force) {
    if (readSmartPicks(day).length) return;
    if (smartAttemptedToday(day)) return; // already tried today; do not retry per request
    // ONE place decides whether the schedule has been reached, so the timer,
    // the post-sync kick and an ordinary page view cannot disagree — the whole
    // point of the setting is that the build never runs at an unexpected time.
    if (!smartPicksDue()) return;
  }
  _smartBuilding = bgRun("smart picks (" + why + ")", () => buildSmartPicks(day))
    .finally(() => { _smartBuilding = null; });
}

// Hourly check, matching the existing index-maintenance and updater timers.
// A timer rather than the first request of the day, so the cost never lands on
// somebody's page load and the retry cadence isn't a function of how often
// anyone taps Back.
// Should the scheduled build run right now?
//
// Only at or after the configured hour, and only on a day that has not been
// built — so a box that was switched off at 4am still gets its picks when it
// comes back, rather than skipping the day entirely. That is why this is
// "hour reached" and not "hour equals".
function smartPicksDue(now) {
  return (now || new Date()).getHours() >= smartPicksHour;
}

let smartPicksTimer = null;
function stopSmartPicksMaintenance() {
  if (!smartPicksTimer) return;
  clearInterval(smartPicksTimer);
  smartPicksTimer = null;
}
function startSmartPicksMaintenance() {
  if (smartPicksTimer) return;
  // Not even a timer while the feature is off. Restarted by the settings route
  // the moment it is switched on, so enabling does not need a container
  // restart.
  if (!smartPicksEnabled) return;
  // Checked every 10 minutes so the configured hour is honoured closely without
  // the timer itself being the expensive thing — the work behind it is gated on
  // "today has no picks", which is a single indexed read.
  smartPicksTimer = setInterval(() => {
    if (!core || !albumIndex.count) return;
    if (!smartPicksDue()) return;
    kickSmartPicks("scheduled " + smartPicksHour + ":00");
  }, 10 * 60 * 1000);
  if (smartPicksTimer.unref) smartPicksTimer.unref();
}

// One pick as the client sees it.
//
// `added` and `offset` are both DERIVED at read time rather than stored, and
// that is the whole point. The first version latched "Added" on the button and
// nowhere else, so reopening the app showed "+ Add" for albums that were
// already sitting in the user's Qobuz library — the state lived in a DOM node
// that does not survive a reload. Reading it back from the service's own
// favourites makes it true on every device and after every restart.
//
// `offset` is present once Roon has actually imported the album, and it is what
// lets the card offer Play instead of Add.
function smartPickJson(row, favs) {
  const id  = row.album_id || "";
  const set = row.service === "qobuz" ? favs.qobuz
            : row.service === "tidal" ? favs.tidal : null;
  const rec = smartLibraryRecord(row.album, row.artist);
  return {
    kind:    row.kind,
    artist:  row.artist,
    mbid:    row.mbid || null,
    album:   row.album || "",
    album_id: id,
    service: row.service || "",
    image:   row.image || "",
    reason:  row.reason || "",
    genre:   row.genre || "",
    // null (not false) when the service could not be asked, so the client can
    // leave the button alone rather than claiming it is not added.
    added:   set ? set.has(id) : null,
    // In the Roon library right now — playable.
    offset:      rec ? rec.offset : null,
    library_title:    rec ? rec.title : "",
    library_subtitle: rec ? rec.subtitle : "",
    image_key:        rec ? (rec.image_key || null) : null
  };
}

// The user's current favourite ids on each connected service. Either side
// failing is reported as null — "not asked" — rather than as an empty set,
// which would tell the client that nothing is added.
async function smartPickFavourites() {
  const out = { qobuz: null, tidal: null };
  const jobs = [];
  if (qobuzReady()) {
    jobs.push(qobuzFavIds.get().then(s => { out.qobuz = s; })
      .catch(e => { console.error("[picks] Qobuz favourites unavailable: " + e.message); }));
  }
  if (tidalReady()) {
    jobs.push(tidalFavIds.get().then(s => { out.tidal = s; })
      .catch(e => { console.error("[picks] TIDAL favourites unavailable: " + e.message); }));
  }
  await Promise.all(jobs);
  return out;
}

// GET /api/smart-picks — today's six. A pure read: it answers from the table
// and, if today has not been built yet, kicks the build and returns what it has
// (nothing, first time). It never waits — see kickSmartPicks.
app.get("/api/smart-picks", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const day  = smartDayKey();
    const rows = readSmartPicks(day);
    if (!rows.length) kickSmartPicks("requested");
    // The favourites read is a 60s-cached lookup, not a per-request round trip.
    const favs = rows.length ? await smartPickFavourites() : { qobuz: null, tidal: null };
    res.json({
      day,
      service_ready: smartPicksServiceReady(),
      auto_add: smartPicksAutoAdd,
      hour: smartPicksHour,
      building: !rows.length && !!_smartBuilding,
      picks: rows.map(r => smartPickJson(r, favs))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Smart Picks settings: when the daily build runs, and whether the five
// adjacent picks are added automatically.
app.get("/api/settings/smart-picks", (req, res) => {
  res.json({ enabled: smartPicksEnabled, hour: smartPicksHour,
             auto_add: smartPicksAutoAdd,
             service_ready: smartPicksServiceReady() });
});
app.post("/api/settings/smart-picks", (req, res) => {
  const body = req.body || {};
  if (body.hour !== undefined) {
    const h = Number(body.hour);
    if (!Number.isFinite(h) || h < 0 || h > 23) {
      return res.status(400).json({ error: "hour must be 0-23" });
    }
    smartPicksHour = Math.trunc(h);
  }
  if (body.auto_add !== undefined) smartPicksAutoAdd = !!body.auto_add;
  if (body.enabled !== undefined) {
    smartPicksEnabled = !!body.enabled;
    // Start or stop the timer here, so switching the feature on takes effect
    // now rather than after a container restart — and switching it off really
    // does stop the clock rather than leaving it ticking against a gate.
    if (smartPicksEnabled) startSmartPicksMaintenance();
    else stopSmartPicksMaintenance();
  }
  savePersistedSettings({ smartPicksEnabled, smartPicksHour, smartPicksAutoAdd });
  res.json({ ok: true, enabled: smartPicksEnabled, hour: smartPicksHour,
             auto_add: smartPicksAutoAdd });
});

// ---------------------------------------------------------------------------
// Home screen rows — which appear, and in what order.
//
// The vocabulary lives HERE and the client renders both the Home screen and
// the settings list from it, so the two can never drift. Same reasoning as the
// theme table: a list built from the thing it describes cannot disagree with
// it.
//
// Stored as an array of { id, on } rather than a set of booleans plus a
// separate order, because order and membership are one fact and splitting them
// is how they end up contradicting each other.
// ---------------------------------------------------------------------------
function homeRowIds() {
  return ["unplayed", "history", "picks", "random", "library", "lotw", "genres"];
}
// The order and enablement a fresh install gets. History is on — it is the row
// people expect to exist — and sits second, right after the discovery row.
function homeRowsDefault() {
  return homeRowIds().map(id => ({ id, on: true }));
}
// Read the stored layout, repaired against the current vocabulary: unknown ids
// dropped (a row removed by an update), missing ids appended in default order
// and switched on (a row ADDED by an update must appear, not silently stay
// hidden because an old layout predates it).
function homeRowsLayout() {
  const stored = loadPersistedSettings().homeRows;
  const valid = new Set(homeRowIds());
  const out = [];
  const seen = new Set();
  if (Array.isArray(stored)) {
    for (const r of stored) {
      const id = r && typeof r.id === "string" ? r.id : null;
      if (!id || !valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, on: r.on !== false });
    }
  }
  for (const { id, on } of homeRowsDefault()) {
    if (!seen.has(id)) out.push({ id, on });
  }
  return out;
}

app.get("/api/settings/home-rows", (req, res) => {
  res.json({ rows: homeRowsLayout() });
});
app.post("/api/settings/home-rows", (req, res) => {
  const rows = (req.body || {}).rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows array required" });
  const valid = new Set(homeRowIds());
  const clean = [];
  const seen = new Set();
  for (const r of rows) {
    const id = r && typeof r.id === "string" ? r.id : null;
    if (!id || !valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    clean.push({ id, on: r.on !== false });
  }
  if (!clean.length) return res.status(400).json({ error: "no recognisable rows" });
  savePersistedSettings({ homeRows: clean });
  // Answered from the same repair path the GET uses, so the client is told
  // what was actually stored rather than what it sent.
  res.json({ ok: true, rows: homeRowsLayout() });
});

// Labels on/off. The scan's own gate lives inside runLabelsIndexScan, at the
// boundary between the /music tag read (which other features are built on) and
// the label lookups (which are the network traffic this switch is about).
app.get("/api/settings/labels", (req, res) => {
  res.json({ enabled: labelsEnabled, count: labelsIndex.count,
             scanning: !!labelsIndex.building });
});
app.post("/api/settings/labels", (req, res) => {
  const body = req.body || {};
  if (body.enabled === undefined) return res.status(400).json({ error: "enabled required" });
  const was = labelsEnabled;
  labelsEnabled = !!body.enabled;
  savePersistedSettings({ labelsEnabled });
  // Switched on: the cache may be empty or stale, so build it now instead of
  // leaving an empty Labels screen until the 12-hour timer comes round.
  if (labelsEnabled && !was) {
    bgRun("labels (enabled)", () => runLabelsIndexScan(true))
      .catch(e => console.error("[labels] scan after enable failed: " + e.message));
  }
  res.json({ ok: true, enabled: labelsEnabled });
});

// Rebuild today's picks now, ignoring the schedule and the attempt marker.
// The button somebody presses when they want to see it work.
app.post("/api/smart-picks/rebuild", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const day = smartDayKey();
  try {
    if (labelsDb) {
      labelsDb.prepare("DELETE FROM smart_picks WHERE day = ?").run(day);
      labelsDb.prepare("DELETE FROM smart_cache WHERE key = ?").run(smartAttemptKey(day));
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  kickSmartPicks("manual", true);   // the button means now, schedule or not
  res.json({ ok: true, building: !!_smartBuilding });
});

// POST /api/smart-picks/block { artist } — "not for me", permanently.
//
// Only an explicit tap blocks an artist. Ignoring a pick must NOT count as a
// rejection: the whole premise is albums the user would never reach for, so a
// model that read silence as "no" would suppress the entire feature within a
// week.
app.post("/api/smart-picks/block", (req, res) => {
  const artist = String((req.body && req.body.artist) || "").trim();
  if (!artist) return res.status(400).json({ error: "artist required" });
  const canon = canonArtist(artist);
  if (!canon) return res.status(400).json({ error: "unrecognisable artist name" });
  if (!labelsDb || !stmtInsertSmartBlock) {
    return res.status(503).json({ error: "History database unavailable" });
  }
  try {
    stmtInsertSmartBlock.run(canon, artist, Date.now());
    // Drop it from today's set too, so it disappears on refresh instead of
    // sitting there until tomorrow's build.
    labelsDb.prepare("DELETE FROM smart_picks WHERE canon = ?").run(canon);
    res.json({ ok: true, artist });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Library search (instant, prefix-aware, typo-tolerant — see albumIndex above)
// ---------------------------------------------------------------------------

// Lightweight status so the UI can show "Building search index… NN%".
app.get("/api/search-status", (req, res) => {
  res.json({
    indexed:  albumIndex.count,
    building: !!albumIndex.building,
    progress: albumIndex.progress,
    builtAt:  albumIndex.builtAt
  });
});

// GET /api/search?q=...&limit=60
app.get("/api/search", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const q     = String(req.query.q || "");
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "60", 10)));
  if (!q.trim()) return res.json({ query: q, results: [], indexed: albumIndex.count });
  try {
    await ensureAlbumIndex();
    // If the very first build is still running, ask the client to wait & retry.
    if (albumIndex.count === 0 && albumIndex.building) {
      return res.json({ query: q, results: [], building: true, progress: albumIndex.progress });
    }
    const nq      = normalize(q);
    const results = searchAlbums(q, limit);
    // A disabled feature does not appear in results. The label index is still
    // populated from before it was switched off, so this has to be asked
    // rather than inferred from emptiness.
    const labels  = labelsEnabled ? searchLabels(nq) : [];
    const artists = searchArtists(nq);
    res.json({ query: q, count: results.length, indexed: albumIndex.count, results, labels, artists });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Global search, external sources — Qobuz + Tidal catalogues (when connected)
// and Pitchfork's cached review lists. Fired by the Home search box AFTER the
// instant library results, on its own longer debounce (streaming searches are
// rate-limit-sensitive; the library one is a local index scan). Each source is
// independently tolerated: not-connected / blocked / failed → null (qobuz,
// tidal) or [] (pitchfork), never an error for the whole route. Deliberately
// NO `core` gate — none of these sources need Roon.
// Per-source deadline for the aggregator below: each source's HTTP calls carry
// their own timeouts, but chained steps (login + search + retry; multi-page
// scrape at 1 req/s) can stack — one slow source must not hold the whole
// search response. The underlying work keeps running and lands in its cache.
function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("source deadline")), ms))
  ]);
}

app.get("/api/search/external", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const LIM = 6;
  const DEADLINE_MS = 10000;
  if (!q) return res.json({ query: q, qobuz: null, tidal: null, pitchfork: [] });
  const [qb, td, pf] = await Promise.all([
    (async () => {
      try {
        const r = await withDeadline(qobuzWithToken(t => qobuz.searchCatalog(t, q, LIM, 0)), DEADLINE_MS);
        return normalizeQobuzAlbums(r.albums.items.slice(0, LIM), new Set());
      } catch (e) { return null; /* not connected / blocked / slow — section simply absent */ }
    })(),
    (async () => {
      try {
        const page = await withDeadline(tidalWithToken((t, cc) => tidal.searchAlbums(t, cc, q, LIM, 0)), DEADLINE_MS);
        return normalizeTidalAlbums(page.items.slice(0, LIM), new Set());
      } catch (e) { return null; /* not connected / blocked / slow — section simply absent */ }
    })(),
    withDeadline(searchPitchforkReviews(q, LIM), DEADLINE_MS)
      .catch(() => [] /* blocked / slow — section simply absent; retries next search */)
  ]);
  res.json({ query: q, qobuz: qb, tidal: td, pitchfork: pf });
});

// Force a rebuild (e.g. after importing music). Returns when done.
app.post("/api/reindex", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    // Route through the shared gate so even this force-rebuild honors
    // "never scan while Roon is importing".
    const r = await checkAndMaybeRebuild("reindex", true);
    res.json(r.status === "rebuilt" ? { ok: true, indexed: albumIndex.count } : { ok: false, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Self-update endpoints (does not require a paired Core)
// ---------------------------------------------------------------------------
app.get("/api/update/status", (req, res) => {
  res.json({ ...updater.getStatus(), is_docker: process.env.DOCKER === "1" });
});

app.post("/api/update/check", async (req, res) => {
  const s = await updater.checkNow();
  pushStatus(); refreshSettings();
  res.json(s);
});

app.post("/api/update/apply", async (req, res) => {
  let st = updater.getStatus();
  if (!st.available) {
    st = await updater.checkNow();
    if (!st.available) return res.status(409).json({ error: "No update available", status: st });
  }
  // Respond first; apply() downloads + stages, then exits with code 75 so the
  // launcher (or a process supervisor) restarts into the new version.
  res.json({ ok: true, status: updater.getStatus() });
  updater.apply().then(() => { pushStatus(); refreshSettings(); }).catch(() => { /* apply errors surface via pushStatus */ });
});

// ---------------------------------------------------------------------------
// Random Album Radio
// Keeps a zone playing whole random albums when its queue runs dry — but only
// while Roon Radio (auto_radio) is OFF for that zone, so the two never fight.
// While a zone is playing we top up gaplessly as it reaches its last track;
// if it ever stops with an empty queue (or you enable radio while idle) we
// start a fresh random album. Enabled per zone and persisted across restarts.
// ---------------------------------------------------------------------------
const radioZones = new Set();
// Prefer the volume-backed settings.json (survives container recreation).
// Fall back to roon.load_config for backward compatibility.
try {
  const s = loadPersistedSettings();
  if (Array.isArray(s.radioZones)) s.radioZones.forEach(z => radioZones.add(z));
} catch (e) {} // corrupt/missing settings.json — start with empty radioZones
if (!radioZones.size) {
  try {
    const saved = (roon.load_config && roon.load_config("rra_settings")) || {};
    if (Array.isArray(saved.radioZones)) saved.radioZones.forEach(z => radioZones.add(z));
  } catch (e) {} // legacy Roon config may not exist — safe to ignore
}
function persistRadio() {
  const zones = [...radioZones];
  try { roon.save_config && roon.save_config("rra_settings", { radioZones: zones }); } catch (e) {} // optional Roon config API — savePersistedSettings below is the primary store
  savePersistedSettings({ radioZones: zones });
}
// Per-zone radio working state.
//
//   inFlight       a top-up is executing RIGHT NOW. Absolute re-entry guard —
//                  no time bound needed, because every browse/load underneath
//                  it now carries a deadline, so it always terminates.
//   appendedAt     when an append last landed. Suppresses a second one until
//                  the queue visibly grows or the hold lapses.
//   strandedAt     this zone stopped WHILE our own append was in flight.
//   resumed        a resume has been issued and accepted for this episode.
//   resumeTries    attempts so far, so a zone that cannot start is not asked
//                  forever.
//   playAuthorized we witnessed this zone run out naturally, so starting
//                  something fresh is authorised. A LATCH, not a reading of
//                  zonePrevState: the transition is a single event, and the
//                  action it authorises may not be able to run until several
//                  events later.
const radioBusy = {};
// Per-zone previous state — used to detect genuine playing→stopped
// transitions, which is what sets playAuthorized above.
const zonePrevState = {};

function radioState(zoneId) {
  return radioBusy[zoneId] || (radioBusy[zoneId] = {
    inFlight: false, appendedAt: 0, strandedAt: 0,
    resumed: false, resumeTries: 0, playAuthorized: false,
  });
}
// Everything a zone remembers, dropped. Called when the zone goes away and
// when the Core unpairs: a zone_id can come back (regrouping, a Core reboot)
// and must not inherit an episode from before, or it would resume a queue
// nobody is listening to.
function forgetRadioZone(zoneId) {
  delete radioBusy[zoneId];
  cancelRadioRecheck(zoneId);
}

// Log every genuine zone state change, ALWAYS — not behind DEBUG.
//
// Added because a report of "playback stops at the end of an album even when
// another track is queued" could not be investigated at all: the one fact that
// settles it — did the queue still have items at the instant Roon stopped? —
// was read in exactly one place (radioDecision) and recorded nowhere. It is not
// in the zone poll, not in /api/zones, not in any log line.
//
// One line per transition per zone is a handful of lines an hour on a busy
// system, which is why it can afford to be unconditional. `radio` and
// `auto_radio` are included because the first question about any unexpected
// stop is which of the two radios, if either, was in play.
const zoneLogPrev = {};
function logZoneTransition(z) {
  if (!z || !z.zone_id) return;
  const prev = zoneLogPrev[z.zone_id];
  const state = z.state || "unknown";
  if (prev === state) return;
  zoneLogPrev[z.zone_id] = state;
  if (prev === undefined) return;   // first sighting is not a transition
  const np = z.now_playing && z.now_playing.two_line;
  // Absent is not zero. Saying so in the log is the point: this is the field
  // Roon may simply omit, and a reader must not mistake it for an empty queue.
  // Number.isFinite and String(), not typeof and "absent", so that a value the
  // decisions themselves reject — NaN passes typeof "number" — is printed as
  // what it is rather than quietly relabelled.
  const remaining = Number.isFinite(z.queue_items_remaining)
    ? z.queue_items_remaining
    : (z.queue_items_remaining === undefined ? "absent" : String(z.queue_items_remaining));
  console.log("[zone] " + JSON.stringify(z.display_name || z.zone_id) + " " +
              prev + "\u2192" + state +
              " remaining=" + remaining +
              " radio=" + (radioZones.has(z.zone_id) ? "on" : "off") +
              " auto_radio=" + !!(z.settings && z.settings.auto_radio) +
              (np ? " np=" + JSON.stringify((np.line1 || "") + " / " + (np.line2 || "")) : ""));
}

// How long an append suppresses the next one, when the queue has not visibly
// grown to confirm it landed.
function radioAppendHoldMs() { return 30000; }

// Is a top-up already in flight, or too soon after the last one?
//
// The two are deliberately separate. The old single "active + 30s" flag
// conflated them, and once browse/load gained a 90s deadline a genuinely slow
// top-up could exceed 30s — at which point the guard let a SECOND one start
// concurrently. Given the recovery path issues a queue-REPLACING Play Now,
// two overlapping top-ups is the one combination that can destroy a queue.
function radioTopUpBlocked(zoneId) {
  const st = radioBusy[zoneId];
  if (!st) return false;
  if (st.inFlight) return true;
  return !!(st.appendedAt && (Date.now() - st.appendedAt) < radioAppendHoldMs());
}

async function radioTopUp(zoneId, mode) {
  const st = radioState(zoneId);
  if (radioTopUpBlocked(zoneId)) return; // already working, or just worked
  st.inFlight = true;
  st.strandedAt = 0; st.resumed = false; st.resumeTries = 0;   // a fresh episode
  try {
    const pick = await pickSmartAlbum();
    if (!pick) {
      // No pick means no index yet, or an empty library. A stopped zone emits
      // no further events, so without a re-check this zone is never
      // reconsidered — the exact shape of the bug this version is fixing.
      console.error("[radio] " + mode + " -> " + zoneId + ": nothing to pick");
      scheduleRadioRecheck(zoneId);
      return;
    }
    // Logged BEFORE the invoke as well as after, and unconditionally: a top-up
    // that hangs inside the Core call is otherwise completely silent, and
    // "play" REPLACES the queue, so it is the one automatic action in this
    // extension that can destroy something the user set up.
    console.log("[radio] " + mode + " -> " + zoneId + " : " + JSON.stringify(pick.title || ""));
    await openAlbumByOffset(pick.offset, zoneId, mode === "play" ? "play_now" : "queue", null,
                            { title: pick.title || "", subtitle: pick.subtitle || "" });
    console.log("[radio] " + mode + " done -> " + zoneId);
    st.appendedAt = Date.now();
    // The start we were authorised to make has happened; the authorisation is
    // spent. (An append is not a start, so "queue" leaves it alone.)
    if (mode === "play") st.playAuthorized = false;
  } catch (e) {
    console.error("[radio] top-up failed: " + e.message);
    if (e && e.stale) {
      // The pick's offset drifted mid-library-change (import/rescan). Zone
      // events fire ~1/sec while a queue drains, so retrying immediately would
      // hammer the Core with a failing browse session per event for the whole
      // import. Hold as if an append had landed; the re-check below re-picks
      // against the (by then likely rebuilt) index.
      st.appendedAt = Date.now();
    }
    // Either way this zone still needs something, and nothing else will ask.
    scheduleRadioRecheck(zoneId);
  } finally {
    st.inFlight = false;
  }
}

function handleRadioZone(z, isInitial, allowPlay) {
  if (!z || !radioZones.has(z.zone_id)) return;
  const zid = z.zone_id;
  const st  = radioState(zid);
  const playing = z.state === "playing" || z.state === "loading";

  // The append is visibly in the queue — a later one may legitimately be
  // needed, so stop suppressing it.
  if (playing && Number.isFinite(z.queue_items_remaining) &&
      z.queue_items_remaining > radioQueueFloor()) {
    st.appendedAt = 0;
  }

  // ANY state but stopped ends an episode. A playing zone was never stranded,
  // and a paused one is under the user's hand. This must not be narrowed to
  // "playing with a healthy queue": an episode that outlives the moment it
  // describes is one that fires against something the user did later.
  if (z.state !== "stopped") {
    st.strandedAt = 0; st.resumed = false; st.resumeTries = 0;
    if (playing) st.playAuthorized = false;
  }

  // Latch the stranding HERE, at the moment it happens, and ONLY while our own
  // append is genuinely executing. It cannot be re-derived later: by the time
  // the append lands the zone has been stopped for a while and every trace of
  // the transition is gone. `inFlight` and not a timestamp comparison, because
  // "a top-up ran recently" also describes a zone the user stopped by hand
  // moments after one finished.
  if (z.state === "stopped" && st.inFlight && !st.strandedAt) st.strandedAt = Date.now();

  // Witnessing a zone run out naturally authorises starting something fresh.
  // Latched rather than read back from zonePrevState at the point of use: the
  // transition is one event, and the action may not be able to run for several
  // more. Reading it late is what left zones permanently silent.
  if (z.state === "stopped" && !isInitial &&
      (zonePrevState[zid] === "playing" || zonePrevState[zid] === "loading")) {
    st.playAuthorized = true;
  }

  // Did our append land in a queue Roon had already stopped? Then finish what
  // we started — resume the queue, never replace it. Never on a reconnect
  // snapshot: `isInitial` means these are zones as they already were, and
  // starting music on the strength of a state we did not witness happen is
  // exactly what that flag exists to prevent.
  if (!isInitial && radioResumeDecision(z, true, st)) {
    st.resumed = true;
    st.resumeTries++;
    console.log("[radio] resume -> " + zid + " (our append landed on a stopped zone, remaining=" +
                z.queue_items_remaining + ", try " + st.resumeTries + ")");
    const failed = (why) => {
      console.error("[radio] resume failed -> " + zid + ": " + why);
      // A transient refusal must not be terminal — that would leave exactly
      // the silent-zone-with-a-full-queue this verb exists to clear.
      // radioResumeMaxTries bounds the retries.
      st.resumed = false;
      scheduleRadioRecheck(zid);
    };
    try {
      core.services.RoonApiTransport.control(zid, "play", (err) => {
        if (err) failed(typeof err === "string" ? err : JSON.stringify(err));
      });
    } catch (e) {
      failed(e.message);
    }
  }

  const decision = radioDecision(z, true);
  if (decision === "queue") {
    if (radioTopUpBlocked(zid)) scheduleRadioRecheck(zid);
    else radioTopUp(zid, "queue");
  } else if (decision === "play" && !isInitial && (st.playAuthorized || allowPlay)) {
    if (radioTopUpBlocked(zid)) scheduleRadioRecheck(zid);
    else radioTopUp(zid, "play");
  }

  // Record state AFTER the decision so the next event sees a real transition.
  // Unconditional again: nothing downstream depends on this surviving now that
  // the authorisation above is a latch of its own.
  zonePrevState[zid] = z.state;
}

// One pending re-examination per zone, at most. Cleared when it fires, when
// radio is switched off for the zone, and when the zone goes away.
const radioRecheckTimers = {};
function scheduleRadioRecheck(zid) {
  if (radioRecheckTimers[zid]) return;
  const t = setTimeout(() => {
    delete radioRecheckTimers[zid];
    const z = zones[zid];
    if (!z || !radioZones.has(zid)) return;
    // Still working? Re-arm rather than acting: a top-up can legitimately run
    // longer than this interval now that each Roon call may take up to 90s,
    // and re-entering here while one is in flight is how two albums end up
    // racing into one queue.
    if (radioBusy[zid] && radioBusy[zid].inFlight) { scheduleRadioRecheck(zid); return; }
    handleRadioZone(z);
  }, radioAppendHoldMs() + 2000);
  if (t.unref) t.unref();   // a pending recheck must never hold the process open
  radioRecheckTimers[zid] = t;
}
function cancelRadioRecheck(zid) {
  if (!radioRecheckTimers[zid]) return;
  clearTimeout(radioRecheckTimers[zid]);
  delete radioRecheckTimers[zid];
}

// ---------------------------------------------------------------------------
// Scrobble / play tracking — records plays into SQLite for stats.
// ---------------------------------------------------------------------------
function scrobbleUpdate(z) {
  if (!labelsDb || !stmtInsertPlay) return;
  const np    = z && z.now_playing;
  const state = z && z.state;
  const zid   = z && z.zone_id;
  if (!zid) return;

  // Roon nests now_playing text in three_line / one_line sub-objects.
  const tl    = (np && np.three_line) || {};
  const ol    = (np && np.one_line)   || {};
  const track  = tl.line1 || ol.line1 || "";
  const artist = tl.line2 || "";
  const album  = tl.line3 || "";

  const prev = scrobbleState.get(zid);

  if (state === "playing" && np && track) {
    if (!prev || prev.track !== track || prev.album !== album) {
      // New track — complete previous if it qualifies
      if (prev && prev.playId && prev.elapsed >= 30 &&
          (prev.elapsed >= (prev.duration || 0) * 0.5 || prev.elapsed >= 240)) {
        try { stmtCompletePlay.run(prev.playId); } catch (e) {} // scrobble DB optional — playback continues regardless
      }
      // Insert new play record
      let playId = null;
      try {
        const info = stmtInsertPlay.run(
          Date.now(), z.display_name || zid,
          track, artist, album,
          np.image_key || "", np.length || 0
        );
        playId = info.lastInsertRowid;
      } catch (e) {} // scrobble DB optional — null playId is handled below
      scrobbleState.set(zid, {
        track, artist, album,
        image_key: np.image_key || "", duration: np.length || 0,
        playId, elapsed: 0, lastSeekPos: np.seek_position || 0
      });
    } else if (prev) {
      // Same track — accumulate elapsed via seek_position delta
      const seekDelta = (np.seek_position || 0) - prev.lastSeekPos;
      if (seekDelta > 0 && seekDelta < 30) prev.elapsed += seekDelta;
      prev.lastSeekPos = np.seek_position || 0;
    }
  } else if (prev && prev.playId) {
    // Not playing (paused/stopped) — finalise if eligible
    if (prev.elapsed >= 30 &&
        (prev.elapsed >= (prev.duration || 0) * 0.5 || prev.elapsed >= 240)) {
      try { stmtCompletePlay.run(prev.playId); } catch (e) {} // scrobble DB optional — playback continues regardless
    }
    scrobbleState.delete(zid);
  }
}

app.get("/api/radio", (req, res) => {
  const zoneId = req.query.zone;
  res.json({ enabled: zoneId ? radioZones.has(zoneId) : false, zones: [...radioZones] });
});
app.post("/api/radio", (req, res) => {
  const zoneId  = (req.body && req.body.zone) || null;
  const enabled = !!(req.body && req.body.enabled);
  if (!zoneId) return res.status(400).json({ error: "zone required" });
  if (enabled) {
    radioZones.add(zoneId);
  } else {
    radioZones.delete(zoneId);
    forgetRadioZone(zoneId);   // radio off means no episode to finish
  }
  persistRadio();
  res.json({ ok: true, enabled });
  // React immediately: start if idle, or top up if already on the last track.
  // allowPlay=true because the user explicitly just enabled radio.
  if (enabled && core && zones[zoneId]) {
    try { handleRadioZone(zones[zoneId], false, true); } catch (e) {} // best-effort kickstart — radio will retry on next zone-state event
  }
});

// Album metadata extras: release year (MusicBrainz) + bios (Discogs).
// Frontend passes title and artist so we don't hit Roon twice per modal open.
app.get("/api/album/extras", async (req, res) => {
  const title  = String(req.query.title  || "");
  const artist = String(req.query.artist || "");
  if (!title) return res.status(400).json({ error: "title query parameter required" });
  try {
    let [year, bios] = await Promise.all([
      fetchAlbumYear(title, artist),
      fetchAlbumBios(title, artist)
    ]);
    // Opportunistically record the year so it feeds the Decade filter too.
    if (year) {
      const exKey = normalize(title) + "||" + normalize(artist);
      setAlbumYear(exKey, year, { src: "release" });
    }
    // Prefer MusicBrainz's first-release year (the album's original release)
    // over Qobuz's edition date, which can be a later reissue.
    if (bios && bios.album && year) bios.album.year = year;
    // Use the canonical label from the scan pipeline so the album modal and the
    // labels browser always agree on which label this album is under.
    const key = normalize(title) + "||" + normalize(artist);
    const canonLabel = labelDiskCache.get(key);
    if (canonLabel) {
      if (!bios) bios = { album: null, artist: null };
      if (!bios.album) bios.album = {};
      bios.album.label = canonLabel;
    }
    res.json({
      year,
      album:  bios ? bios.album  : null,
      artist: bios ? bios.artist : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Wall display (/display) — a Roon-style always-on screen that rotates
// between album art, artist photos (fanart.tv), a review card (the same
// legally-safe Qobuz/Wikipedia text the album modal shows — Pitchfork text
// stays suppressed) and a muted video clip (YouTube, only when the user has
// configured an API key). Everything is gated on the Settings toggle: when
// off, the content endpoint refuses and no discovery work runs.
// ---------------------------------------------------------------------------

// Artist name → MusicBrainz artist MBID (cached per session).
const artistMbidCache = new Map();
async function fetchArtistMbid(artistName) {
  if (!artistName) return null;
  const key = normalize(artistName);
  if (artistMbidCache.has(key)) return artistMbidCache.get(key);
  await mbWait();
  const q = `artist:"${mbQuote(artistName)}"`;
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  let mbid = null;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const artists = json && json.artists;
    // MusicBrainz search is fuzzy and ALWAYS returns something — taking hit #1
    // blind gave the wall display photos of a different act entirely for
    // short names like Low, Air, Ash or Yes. Require the name to actually match.
    if (Array.isArray(artists) && artists.length) {
      // normalize() strips non-Latin scripts to "", which would reject every
      // candidate for e.g. 坂本龍一 and lose their photos entirely — fall back
      // to a raw comparison, and to the top hit when the name can't be
      // canonicalised at all (the pre-check behaviour, only for those names).
      const raw = (x) => String(x || "").trim().toLowerCase();
      const hit = artists.find(a => namesEqualLoose(a.name, artistName)) ||
                  artists.find(a => raw(a.name) === raw(artistName)) ||
                  (!normalize(artistName) ? artists[0] : null);
      mbid = hit ? (hit.id || null) : null;
      if (!hit && DEBUG) {
        console.log("[display:mb:artist] no name match for " + JSON.stringify(artistName) +
                    " (top hit: " + JSON.stringify(artists[0] && artists[0].name) + ")");
      }
    }
  } catch (e) {
    if (DEBUG) console.error("[display:mb:artist]", e.message);
  }
  artistMbidCache.set(key, mbid);
  return mbid;
}

// Artist photos via fanart.tv (same key the labels pipeline uses). Prefers the
// widescreen artistbackground images; falls back to artistthumb. Cached per
// artist; failures cache an empty list so we don't hammer the API.
const artistPhotoCache = new Map();
async function fetchArtistPhotos(artistName) {
  if (!artistName || !fanartKey) return [];
  const key = normalize(artistName);
  if (artistPhotoCache.has(key)) return artistPhotoCache.get(key);
  let photos = [];
  try {
    const mbid = await fetchArtistMbid(artistName);
    if (mbid) {
      const url = `https://webservice.fanart.tv/v3/music/${encodeURIComponent(mbid)}?api_key=${fanartKey}`;
      const json = await httpJson(url);
      const bgs    = Array.isArray(json.artistbackground) ? json.artistbackground : [];
      const thumbs = Array.isArray(json.artistthumb)      ? json.artistthumb      : [];
      photos = bgs.concat(thumbs).map(x => x && x.url).filter(Boolean).slice(0, 4);
    }
  } catch (e) {
    if (DEBUG) console.error("[display:fanart]", e.message);
  }
  artistPhotoCache.set(key, photos);
  return photos;
}

// Muted video clip via the YouTube Data API — only when the user supplied a
// key in Settings. PRECISION-FIRST: the display shows the artist's official
// music video or an official live performance, or NOTHING — never chat-show
// clips, fan uploads, or " - Topic" auto-uploads (those are static album art
// with audio: worthless on a muted screen). Candidates are scored on channel
// ownership + title keywords and must clear a threshold; the survivors are
// verified via videos.list (embeddable, public, not age-restricted — age
// restriction never plays embedded). Cached per artist+track incl. negatives
// (search.list costs 100 quota units of the 10k/day default).
const displayVideoCache = new Map();
function scoreDisplayVideo(item, artistN, trackTokens) {
  const title    = (item.snippet && item.snippet.title        || "");
  const channel  = (item.snippet && item.snippet.channelTitle || "");
  const titleN   = normalize(title);
  const channelN = normalize(channel);
  // Hard rejects: auto-generated audio uploads and non-video content.
  if (/ - topic$/i.test(channel)) return -1;
  if (/\b(audio|lyric|lyrics|visuali[sz]er|cover|reaction|remix|sped|slowed|8d|karaoke|instrumental|full album|teaser|trailer|interview|behind the scenes|epk|shorts?)\b/i.test(title)) return -1;
  // Every significant token of the track name must appear in the video title.
  for (const t of trackTokens) if (titleN.indexOf(t) === -1) return -1;
  let score = 0;
  // The artist's OWN channel (or their VEVO) is trusted outright: real artist
  // channels (e.g. Stereophonics) title their uploads plainly — "Artist -
  // Track" with no "official" suffix — and those ARE the official videos.
  // The v1.6.19 scorer demanded the keyword on top and rejected them.
  const channelIsArtist = channelN === artistN || channelN === artistN + " vevo" ||
                          channelN === artistN + " music" || channelN === artistN + " official" ||
                          channelN.replace(/\s+/g, "") === artistN.replace(/\s+/g, "") + "vevo";
  if (channelIsArtist) score += 70;
  // Whole-name only: a raw substring let the "Kate Bush" channel score as
  // artist-adjacent for the band Bush, and 40 + the "official video" keyword
  // is exactly the threshold, so the wrong artist's video would play.
  else if (namesEqualLoose(channelN, artistN) ||
           namesEqualLoose(channelN.replace(/\s+(topic|official|music|band|tv|channel)$/, ""), artistN))
    score += 40;                                          // artist-adjacent channel: needs the keyword too
  else return -1;                                         // chat shows / fan uploads — reject outright
  if (/\bofficial (music )?video\b/i.test(title)) score += 30;
  else if (/\(official\b/i.test(title)) score += 20;
  if (/\blive\b/i.test(title)) {
    if (score >= 70) score += 20;                         // live on the artist's own channel — welcome
    else return -1;                                       // random live bootleg — reject
  }
  return score;
}
async function fetchDisplayVideo(artistName, trackName) {
  if (!youtubeKey || !artistName || !trackName) return null;
  const key = normalize(artistName) + "||" + normalize(trackName);
  const hit = displayVideoCache.get(key);
  if (hit) {
    // Positive verdicts hold for the session; a "no video" verdict expires
    // after 30 min so transient API failures don't blank a track for good.
    if (hit.video || (Date.now() - hit.at) < 30 * 60 * 1000) return hit.video;
    displayVideoCache.delete(key);
  }
  let video = null;
  try {
    // Plain artist+track query, no category filter: recall is the search's
    // job (artist channels titling uploads without "official" must surface);
    // precision is the scorer's.
    const q = `${artistName} ${trackName}`;
    const searchUrl = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video" +
      "&videoEmbeddable=true&videoSyndicated=true&maxResults=10" +
      "&q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(youtubeKey);
    const json = await httpJson(searchUrl);
    const artistN = normalize(artistName);
    const trackTokens = normalize(trackName).split(" ").filter(t => t.length > 2);
    const scored = ((json && json.items) || [])
      .filter(it => it && it.id && it.id.videoId && it.snippet)
      .map(it => ({ id: it.id.videoId, score: scoreDisplayVideo(it, artistN, trackTokens) }))
      .filter(c => c.score >= 70)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      const statusUrl = "https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails,statistics" +
        "&id=" + encodeURIComponent(scored.map(c => c.id).join(",")) +
        "&key=" + encodeURIComponent(youtubeKey);
      const st = await httpJson(statusUrl);
      const playable = new Map(((st && st.items) || [])
        .filter(v => v && v.status && v.status.embeddable && v.status.privacyStatus === "public" &&
                     !(v.contentDetails && v.contentDetails.contentRating &&
                       v.contentDetails.contentRating.ytRating === "ytAgeRestricted"))
        .map(v => [v.id, parseInt((v.statistics && v.statistics.viewCount) || "0", 10)]));
      // Highest score wins; view count breaks ties between equal scores.
      const best = scored
        .filter(c => playable.has(c.id))
        .sort((a, b) => (b.score - a.score) || (playable.get(b.id) - playable.get(a.id)))[0];
      if (best) {
        video = {
          videoId: best.id,
          embedUrl: "https://www.youtube-nocookie.com/embed/" + best.id +
            "?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0" +
            "&loop=1&playlist=" + best.id + "&enablejsapi=1"
        };
      }
    }
  } catch (e) {
    if (DEBUG) console.error("[display:youtube]", e.message);
  }
  displayVideoCache.set(key, { at: Date.now(), video });
  return video;
}

// Display artist bios (Qobuz/Tidal album-matched first, then Wikipedia),
// cached per artist NAME + ALBUM — the album participates in matching, so
// the same artist under a different album is a distinct lookup. Nulls
// cached too (a confident "no bio" is a result).
const displayArtistBioCache = new Map();
const DISPLAY_BIO_CACHE_MAX = 500;
// Album titles vary by edition suffix across services ("X" vs "X (Remaster)")
// — accept exact normalized equality or one being a word-prefix of the other.
function albumTitleMatches(candidate, wanted) {
  const c = normalize(candidate || ""), w = normalize(wanted || "");
  if (!c || !w) return false;
  return c === w || c.startsWith(w + " ") || w.startsWith(c + " ");
}

// Artist bio straight from the streaming service that carries the playing
// album. When the album exists on Qobuz/Tidal their catalogues already hold
// an editorial artist bio, and matching BY THE ALBUM pins the artist
// identity exactly — no name disambiguation involved. Qobuz first, Tidal
// second; each step is best-effort and falls through on any failure.
async function fetchServiceArtistBio(name, albumTitle) {
  const nameN = normalize(name || "");
  if (!nameN || !albumTitle) return null;
  if (qobuzToken || (qobuzUsername && qobuzPasswordMd5)) {
    try {
      const r = await qobuzWithToken(t => qobuz.searchCatalog(t, name + " " + albumTitle, 8, 0));
      const items = (r && r.albums && r.albums.items) || [];
      // Same artist-field fallback as normalizeQobuzAlbum: search items may
      // carry `performer` instead of `artist`.
      const qArtistOf = al => (al && al.artist) || (al && al.performer) || null;
      const hit = items.find(al => {
        const ar = qArtistOf(al);
        return ar && namesEqualLoose(ar.name, name) && albumTitleMatches(al && al.title, albumTitle);
      });
      const hitArtist = qArtistOf(hit);
      if (hitArtist && hitArtist.id != null) {
        const a = await qobuzWithToken(t => qobuz.getArtist(t, String(hitArtist.id), 1, 0));
        const text = a && a.biography ? stripHtml(String(a.biography)).trim() : "";
        if (text) return {
          name: (a.artist && a.artist.name) || hitArtist.name || name,
          description: text,
          source: "Qobuz",
          // The artist portrait rides along for the phone UI's artist header;
          // the wall display ignores it (it has its own FanArt photo cards).
          image: (a.artist && a.artist.image) || null
        };
      }
    } catch (e) { if (DEBUG) console.error("[display:bio:qobuz]", e.message); }
  }
  if (tidalRefreshToken) {
    try {
      const r = await tidalWithToken((t, cc) => tidal.searchAlbums(t, cc, name + " " + albumTitle, 8, 0));
      const items = (r && r.items) || [];
      const artistOf = al => (al && al.artist) || (al && Array.isArray(al.artists) && al.artists[0]) || null;
      const hit = items.find(al => {
        const ar = artistOf(al);
        return ar && namesEqualLoose(ar.name, name) && albumTitleMatches(al && al.title, albumTitle);
      });
      const ar = artistOf(hit);
      if (ar && ar.id != null) {
        const raw = await tidalWithToken((t, cc) => tidal.getArtistBio(t, cc, String(ar.id)));
        const text = raw ? stripHtml(String(raw)).trim() : "";
        if (text) return { name: ar.name || name, description: text, source: "Tidal" };
      }
    } catch (e) { if (DEBUG) console.error("[display:bio:tidal]", e.message); }
  }
  return null;
}

async function fetchDisplayArtistBio(name, albumTitle) {
  if (!normalize(name || "")) return null;
  // Keyed by name + album: the album participates in matching (service album
  // match, Wikipedia cross-check), so the same artist under a different
  // album is a different lookup.
  const key = normalize(name) + "||" + normalize(albumTitle || "");
  if (displayArtistBioCache.has(key)) return displayArtistBioCache.get(key);
  let bio = null;
  try {
    bio = await fetchServiceArtistBio(name, albumTitle);
    if (!bio) bio = await fetchWikiArtist(name, albumTitle);
  } catch (e) { /* best-effort — card is skipped */ }
  displayArtistBioCache.set(key, bio);
  // Bounded like displayContentCache: on a streaming-heavy, never-restarted box
  // the set of distinct artist/member names played would otherwise grow without
  // limit. Evict the oldest once over the cap (Map preserves insertion order).
  if (displayArtistBioCache.size > DISPLAY_BIO_CACHE_MAX) {
    displayArtistBioCache.delete(displayArtistBioCache.keys().next().value);
  }
  return bio;
}

// Assembled rotation content per album (photos + review + video), cached 6h.
const displayContentCache = new Map();
const DISPLAY_CONTENT_TTL_MS = 6 * 60 * 60 * 1000;
app.get("/api/display/content", async (req, res) => {
  if (!displayEnabled) return res.status(403).json({ error: "Wall display is turned off in Settings" });
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const zone = zones[String(req.query.zone || "")];
  const np = zone && zone.now_playing;
  if (!np) return res.json({ artistPhotos: [], review: null, video: null });
  const lines  = np.three_line || np.one_line || {};
  const track  = lines.line1 || "";
  const artist = lines.line2 || "";
  const album  = lines.line3 || "";
  // Multi-artist credits ("A / B / C") → the primary artist fronts the photos.
  const primaryArtist = artist.split(" / ")[0].trim();

  const cacheKey = normalize(artist) + "||" + normalize(album) + "||" + normalize(track);
  const hit = displayContentCache.get(cacheKey);
  if (hit && (Date.now() - hit.at) < DISPLAY_CONTENT_TTL_MS) return res.json(hit.data);

  try {
    const [photos, bios, video] = await Promise.all([
      fetchArtistPhotos(primaryArtist).catch(() => []),
      album ? fetchAlbumBios(album, artist).catch(() => null) : Promise.resolve(null),
      fetchDisplayVideo(primaryArtist, track).catch(() => null)
    ]);
    // Review card: the album description when a displayable one exists
    // (Qobuz/Wikipedia — fetchAlbumBios nulls Pitchfork text for UK-law
    // compliance). The artist's Wikipedia bio is its own separate slide.
    let review = null;
    if (bios && bios.album && bios.album.description) {
      review = { text: bios.album.description,
                 attribution: "About this album — " + (bios.album.source || "") };
    }
    // One bio per credited artist ("A / B / C" → up to 4), so the display's
    // bio card can alternate members on successive rotations. Each lookup is
    // cached by name+album (fetchDisplayArtistBio).
    const artistParts = artist.split(" / ").map(s => s.trim()).filter(Boolean).slice(0, 4);
    // Every credit goes through the validated chain (Qobuz/Tidal album-matched
    // bio first, then album-cross-checked Wikipedia) — the old shortcut that
    // reused fetchAlbumBios' Wikipedia artist result bypassed the streaming
    // sources. A credit with no confident match shows no bio card at all.
    const bioList = (await Promise.all(artistParts.map(async (name) => {
      const w = await fetchDisplayArtistBio(name, album);
      return w ? { name: w.name || name, text: w.description,
                   attribution: "About " + (w.name || name) + " — " + (w.source || "Wikipedia") } : null;
    }))).filter(Boolean);
    const bio = bioList[0] || null;   // kept for any not-yet-refreshed display page
    // Library recommendations — instant, no API keys: other albums by this
    // artist from the in-memory album index, and label-mates from the labels
    // index. Both use the same tile shape the display renders as cover grids.
    const npTitleN = normalize(album);
    const artistN  = normalize(primaryArtist);
    const artistQ  = canonArtist(primaryArtist);
    const moreArtist = [];
    if (artistN) {
      for (const al of albumIndex.albums) {
        if (moreArtist.length >= 12) break;
        if (normalize(al.title) === npTitleN) continue;
        // Whole credited name only — the old `" / " + artistN` test matched a
        // PREFIX of a credit segment, so "Madonna / Prince Paul" was tiled
        // under "More from Prince". Reads the identities precomputed with the
        // snapshot rather than re-splitting every credit on every track change.
        if (al.cArtist === undefined) applyCreditIdentities(al);
        if (al.cCredits ? al.cCredits.includes(artistQ) : al.cArtist === artistQ) {
          moreArtist.push(withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }, al));
        }
      }
    }
    let moreLabel = null;
    // Build the label grid the SAME reliable way as the artist grid above:
    // iterate the LIVE album index directly and keep albums whose resolved
    // label matches the now-playing album's label. Every tile is therefore a
    // live album-index entry carrying a current, valid offset. The previous
    // approach started from the labels-index snapshot and matched back to live
    // by title+artist; when the snapshot's subtitle came from a different seed
    // source (Qobuz/disk) than the live Roon browse rows, the match silently
    // failed and the tiles arrived with no usable offset — which is why they
    // could not be selected. Projecting the live index removes that dependency.
    const labelName = labelsEnabled
      ? resolveAlbumLabelName({ title: album, subtitle: artist }) : null;
    const targetKey = labelName ? canonicalLabelGroupKey(labelName) : null;
    if (targetKey) {
      const picks = [];
      const seenOffsets = new Set();
      for (const al of albumIndex.albums) {
        if (picks.length >= 12) break;
        if (al.offset == null || seenOffsets.has(al.offset)) continue;
        if (normalize(al.title) === npTitleN) continue;
        const alLabel = resolveAlbumLabelName(al);
        if (!alLabel || canonicalLabelGroupKey(alLabel) !== targetKey) continue;
        seenOffsets.add(al.offset);
        picks.push(withSource({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null }, al));
      }
      if (picks.length >= 3) {
        const entry = labelsIndex.map.get(targetKey);
        moreLabel = { name: (entry && entry.display) || canonicalLabelName(labelName), albums: picks };
      }
    }
    const data = {
      artistPhotos: photos, review, bio, bios: bioList, video,
      moreAlbums: {
        artist: moreArtist.length >= 3 ? { name: primaryArtist, albums: moreArtist } : null,
        label:  moreLabel
      }
    };
    displayContentCache.delete(cacheKey);   // re-set moves the key to newest position
    displayContentCache.set(cacheKey, { at: Date.now(), data });
    if (displayContentCache.size > 200) {
      const oldest = displayContentCache.keys().next().value;
      displayContentCache.delete(oldest);
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Display settings — the /display page polls this to honour the toggle live.
app.get("/api/settings/display", (req, res) => {
  res.json({ enabled: displayEnabled, seconds: displaySeconds });
});
app.post("/api/settings/display", (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === "boolean") displayEnabled = b.enabled;
  if (b.seconds != null) {
    const s = parseInt(b.seconds, 10);
    if (Number.isFinite(s) && s >= 5 && s <= 60) displaySeconds = s;
  }
  const ok = savePersistedSettings({ displayEnabled, displaySeconds });
  res.json({ ok, enabled: displayEnabled, seconds: displaySeconds });
});

// Optional YouTube Data API key (masked on read, like the fanart key).
app.get("/api/settings/youtube-key", (req, res) => {
  res.json({ set: !!youtubeKey, masked: youtubeKey ? youtubeKey.slice(0, 4) + "…" : "" });
});
app.post("/api/settings/youtube-key", (req, res) => {
  youtubeKey = String((req.body && req.body.key) || "").trim();
  displayVideoCache.clear();   // a new key may find videos the old one couldn't
  const ok = savePersistedSettings({ youtubeKey });
  res.json({ ok, set: !!youtubeKey });
});

// The wall page itself. Served regardless of the toggle — the page shows a
// "turned off" note (and fetches nothing) when disabled, so flipping the
// Settings toggle brings a mounted wall tablet to life without a reload.
app.get("/display", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "display.html"));
});

// Pitchfork magazine — a browsable listing of recent album reviews or Best New
// Music (?type=latest|best). See getPitchforkReviews for the data sources.
app.get("/api/pitchfork/reviews", async (req, res) => {
  const type = req.query.type === "best" ? "best" : "latest";
  try {
    const items = await getPitchforkReviews(type);
    res.json({ type, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Library match for one listing card (so the card's detail view can offer to
// play the album if it's in the library).
// COMPLIANCE (UK law): the written review is never served — the client links
// to pitchfork.com instead. The review page is no longer fetched here AT ALL
// (score/BNM already ship with the listing items), which also spares
// pitchfork.com a throttled full-page scrape per detail open. `review` is
// kept as null so any stale client reading the old shape sees no text.
app.get("/api/pitchfork/review", (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || "")); } catch (e) { return res.status(400).json({ error: "Invalid url" }); }
  if (u.hostname !== "pitchfork.com" || !u.pathname.startsWith("/reviews/albums/")) {
    return res.status(400).json({ error: "Not a Pitchfork album-review URL" });
  }
  const match = matchLibraryAlbum(String(req.query.album || ""), String(req.query.artist || ""));
  res.json({ review: null, match });
});

// Debug endpoint: dumps the raw items returned by Roon when drilling into an
// album.  Visit http://<host>:3399/api/debug/album?offset=N in your browser.
app.get("/api/debug/album", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
      const albumLoad = await load({
        hierarchy: "albums", offset, count: 1, multi_session_key: sessionKey
      });
      const albumItem = albumLoad.items && albumLoad.items[0];
      if (!albumItem) return res.status(404).json({ error: "Album not found at offset" });

      await browse({
        hierarchy: "albums",
        item_key:  albumItem.item_key,
        multi_session_key: sessionKey
      });
      const inside = await load({
        hierarchy: "albums",
        offset: 0,
        count: 500,
        multi_session_key: sessionKey
      });
      res.json({
        album: { title: albumItem.title, subtitle: albumItem.subtitle },
        list:  inside.list,
        item_count_returned: (inside.items || []).length,
        items: (inside.items || []).map(it => ({
          title: it.title,
          subtitle: it.subtitle,
          hint: it.hint || null,
          has_image: !!it.image_key,
          item_key_present: !!it.item_key
        }))
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: test Roon-native label detection on a single album by offset.
// Visit /api/debug/label-scan?offset=N to see every item Roon returns and
// which one (if any) is detected as the label.
app.get("/api/debug/label-scan", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
      const albumLoad = await load({ hierarchy: "albums", offset, count: 1, multi_session_key: sessionKey });
      const albumItem = albumLoad.items && albumLoad.items[0];
      if (!albumItem) return res.status(404).json({ error: "Album not found at offset" });
      await browse({ hierarchy: "albums", item_key: albumItem.item_key, multi_session_key: sessionKey });
      const inside = await load({ hierarchy: "albums", offset: 0, count: 300, multi_session_key: sessionKey });
      const items = inside.items || [];
      res.json({
        album:    { title: albumItem.title, subtitle: albumItem.subtitle, offset },
        detected_label: null,
        all_items: items.map(i => ({
          title:   i.title,
          hint:    i.hint || null,
          has_key: !!i.item_key
        }))
      });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Play an album: body { offset, zone_or_output_id, kind }
app.post("/api/play", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { offset, zone_or_output_id, kind, title, subtitle } = req.body || {};
  const filter = parseFilter(req.body || {});
  if (!Number.isFinite(offset)) return res.status(400).json({ error: "offset required" });
  if (!zone_or_output_id)       return res.status(400).json({ error: "zone_or_output_id required" });
  if (!kind)                    return res.status(400).json({ error: "kind required" });
  // Identity check: never play whatever happens to sit at a stale offset.
  const expect = title ? { title: String(title), subtitle: String(subtitle || "") } : null;
  try {
    const r = await openAlbumByOffset(offset, zone_or_output_id, kind, filter, expect);
    res.json({ ok: true, action: r.invoked, offset: r.offset });
  } catch (e) {
    res.status(e.stale ? 409 : 500).json({ error: e.message });
  }
});

// Play or queue a single track of an album.
// body { offset, track (index into /api/album's tracks), title, zone_or_output_id, kind }
// album_title / album_subtitle are OPTIONAL and carry the album's own identity,
// which lets a drifted offset be relocated instead of playing whatever record
// now sits at that position. Callers that have it should send it.
app.post("/api/play-track", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { offset, track, title, zone_or_output_id, kind,
          album_title, album_subtitle } = req.body || {};
  const filter = parseFilter(req.body || {});
  if (!Number.isFinite(offset)) return res.status(400).json({ error: "offset required" });
  if (!Number.isInteger(track) || track < 0) return res.status(400).json({ error: "track index required" });
  if (!zone_or_output_id)       return res.status(400).json({ error: "zone_or_output_id required" });
  if (kind !== "play_now" && kind !== "queue" && kind !== "play_next") {
    return res.status(400).json({ error: "kind must be play_now, queue or play_next" });
  }
  try {
    const expect = album_title
      ? { title: String(album_title), subtitle: String(album_subtitle || "") }
      : null;
    const r = await invokeTrackAction(offset, track, title || "", zone_or_output_id,
                                      kind, filter, expect);
    res.json({ ok: true, action: r.invoked, track: r.track });
  } catch (e) {
    // stale = the modal's track list no longer matches the library
    res.status(e.stale ? 409 : 500).json({ error: e.message });
  }
});

// Play multiple albums: first uses `kind`, subsequent albums are always queued.
// body { offsets: [N, ...], zone_or_output_id, kind }
// One play-multi at a time per zone. A 400-album run takes minutes, and the
// client's fetch has no way to cancel the server side of it — backgrounding
// the PWA drops the fetch, the button re-enables, and a second tap starts a
// run whose FIRST album is play_now, wiping the queue the first run is still
// filling. The two then interleave and the queue order is garbage.
const playMultiZones = new Set();

app.post("/api/play-multi", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { offsets, items, zone_or_output_id, kind } = req.body || {};
  const filter = parseFilter(req.body || {});
  // Prefer `items` ({offset,title,subtitle} each) so the stale-offset defense
  // covers multi-select too; bare `offsets` kept for backward compatibility.
  const list = Array.isArray(items) && items.length
    ? items.map(it => ({
        offset: it.offset,
        expect: it.title ? { title: String(it.title), subtitle: String(it.subtitle || "") } : null
      }))
    : (Array.isArray(offsets) ? offsets.map(off => ({ offset: off, expect: null })) : []);
  if (!list.length)       return res.status(400).json({ error: "offsets required" });
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  if (!kind)              return res.status(400).json({ error: "kind required" });
  if (playMultiZones.has(zone_or_output_id)) {
    return res.status(409).json({
      error: "Still filling this zone's queue — let that finish before starting another"
    });
  }
  playMultiZones.add(zone_or_output_id);
  try {
    // First album uses the requested kind (play_now / queue / next).
    // Remaining albums are always "queue", in batches of 4 — each open is
    // ~7 browse round-trips on its own session, and an uncapped Promise.all
    // over a large selection burst dozens of parallel navigations onto the
    // single multiplexed Roon websocket (and that many simultaneous sessions
    // onto the Core). allSettled so one failed album doesn't abandon the
    // rest of the selection — every album is attempted, then failures are
    // reported together.
    await openAlbumByOffset(list[0].offset, zone_or_output_id, kind, filter, list[0].expect);
    const MULTI_QUEUE_BATCH = 4;
    const rest = list.slice(1);
    let failed = 0, firstError = null;
    for (let i = 0; i < rest.length; i += MULTI_QUEUE_BATCH) {
      const results = await Promise.allSettled(
        rest.slice(i, i + MULTI_QUEUE_BATCH)
            .map(it => openAlbumByOffset(it.offset, zone_or_output_id, "queue", filter, it.expect))
      );
      for (const r of results) {
        if (r.status === "rejected") {
          failed++;
          if (!firstError) firstError = (r.reason && r.reason.message) || String(r.reason);
        }
      }
    }
    // A partial result is a SUCCESS, not a failure: the first album is already
    // playing and every album that queued is in the queue. Answering 500 threw
    // all of that away — the caller returned early on !ok and could no longer
    // tell the user how much of the playlist made it, or that the request had
    // been truncated at the album cap in the first place. Counts travel instead.
    res.json({
      ok: true,
      queued: list.length - failed,
      failed,
      total: list.length,
      first_error: firstError,
    });
  } catch (e) {
    // stale = the FIRST album's offset drifted and couldn't be relocated —
    // same 409 contract as /api/album and /api/play.
    res.status(e.stale ? 409 : 500).json({ error: e.message });
  } finally {
    // Must release on every path, or one failed run locks the zone out of
    // multi-album playback until the extension restarts.
    playMultiZones.delete(zone_or_output_id);
  }
});

// ---------------------------------------------------------------------------
// Mini-transport: live now-playing for a zone + playback / volume control
// ---------------------------------------------------------------------------

// Resolve the currently playing album for a zone, via Roon's browse hierarchy
// (search → Albums → matching item). Returns tracks + the bio shape used by
// the album modal.  If anything fails, returns the basic info we already have
// from now_playing so the modal still works (no tracks but no error either).
async function findNowPlayingAlbum(zoneId) {
  if (!core) throw new Error("Not paired with Roon Core");
  const zone = zones[zoneId];
  if (!zone || !zone.now_playing) throw new Error("Nothing playing in this zone");

  const tl    = zone.now_playing.three_line || {};
  const title = tl.line3 || (zone.now_playing.one_line && zone.now_playing.one_line.line1) || "";
  const artist= tl.line2 || "";
  const image = zone.now_playing.image_key || null;

  const fallback = {
    album:  { title, subtitle: artist, image_key: image },
    tracks: []
  };
  if (!title) return fallback;

  const hier = "browse";

  try {
    return await withBrowseSession(async (sessionKey) => {
      // Root with EXPLICIT count: 100 — without this the search entry can be on
      // a later page and we never see it.
      await browse({ hierarchy: hier, pop_all: true, multi_session_key: sessionKey, zone_or_output_id: zoneId });
      const root = await load({ hierarchy: hier, offset: 0, count: 100, multi_session_key: sessionKey });
      const items0 = root.items || [];

      const searchItem = items0.find(i => i.input_prompt)
                      || items0.find(i => /search/i.test(i.title || ""));
      if (!searchItem) {
        if (DEBUG) console.log("[np] no search at root, items were:",
          items0.map(i => ({ title: i.title, hint: i.hint })));
        return fallback;
      }

      const query = `${title} ${artist}`.trim();
      await browse({
        hierarchy: hier, multi_session_key: sessionKey,
        item_key: searchItem.item_key, input: query, zone_or_output_id: zoneId
      });
      const results = await load({ hierarchy: hier, offset: 0, count: 100, multi_session_key: sessionKey });
      const sections = results.items || [];

      const albumsSection = sections.find(s => /album/i.test(s.title || "") && s.item_key);
      if (!albumsSection) return fallback;

      await browse({ hierarchy: hier, multi_session_key: sessionKey, item_key: albumsSection.item_key });
      const albs = await load({ hierarchy: hier, offset: 0, count: 50, multi_session_key: sessionKey });

      // Whole-name artist agreement, and no blind first-result guess: this
      // decides which album's tracklist and art are shown as "now playing", so
      // a Kate Bush album must never answer for the band Bush.
      const titleN  = normalize(title);
      const artistOk = (i) => !artist || creditHasArtist(i.subtitle, artist);
      const albItems = albs.items || [];
      // `artist` here is the TRACK artist, which legitimately differs from the
      // album credit on compilations, soundtracks and classical ("Aretha
      // Franklin" on a "Various Artists" album), so an exact title on its own
      // is still accepted — this only chooses which tracklist to DISPLAY, it
      // never starts playback, so a miss (no tracklist at all) is worse than a
      // rare mismatch. The play resolver above stays strict for that reason.
      const albumItem =
           albItems.find(i => normalize(i.title) === titleN && artistOk(i))
        || albItems.find(i => normalize(i.title) === titleN)
        || albItems.find(i => normalize(i.title).includes(titleN) && artistOk(i))
        || null;
      if (!albumItem || !albumItem.item_key) return fallback;

      await browse({ hierarchy: hier, multi_session_key: sessionKey, item_key: albumItem.item_key });
      const inside = await load({ hierarchy: hier, multi_session_key: sessionKey, offset: 0, count: 500 });
      const items = inside.items || [];

      const playMenu = items.find(i => i.hint === "action_list" && !i.subtitle && /^play/i.test(i.title || ""))
                    || items.find(i => i.hint === "action_list" && !i.subtitle);
      const tracks = items
        .filter(t => {
          if (t === playMenu) return false;
          if (t.hint === "action_list" && !t.subtitle) return false;
          if (t.hint === "header") return false;
          return true;
        })
        .map(t => ({
          title:    (t.title || "").replace(/^\d+\.\s+/, ""),
          subtitle: t.subtitle || ""
        }));

      return {
        album: {
          title:     albumItem.title    || title,
          subtitle:  albumItem.subtitle || artist,
          image_key: albumItem.image_key || image
        },
        tracks
      };
    });
  } catch (e) {
    if (DEBUG) console.error("[np lookup]", e.message);
    return fallback;
  }
}

app.get("/api/album/now-playing", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  if (!zoneId) return res.status(400).json({ error: "zone required" });
  try {
    const r = await findNowPlayingAlbum(zoneId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Queue for a zone
// RoonApiTransport doesn't expose a one-shot get_queue — only subscribe_queue.
// We subscribe, respond on the first "Subscribed" payload, then immediately
// unsubscribe via the handle node-roon-api returns. The old version skipped
// the unsubscribe, so every queue-modal open left one live subscription the
// Core kept pushing deltas to for the life of the process — an unbounded,
// extension-induced load on the Core.
app.get("/api/queue", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  if (!zoneId) return res.status(400).json({ error: "zone required" });

  let responded = false;
  let sub = null;
  // Respond exactly once, then drop the subscription. Also runs on timeout,
  // so a slow "Subscribed" that arrives after 504 still gets unsubscribed.
  const finish = (send) => {
    if (responded) return;
    responded = true;
    clearTimeout(timeout);
    send();
    if (sub) {
      try { sub.unsubscribe(() => {}); }
      catch (e) { /* socket already gone — the subscription died with it */ }
    }
  };
  const timeout = setTimeout(() => {
    finish(() => res.status(504).json({ error: "queue subscription timed out" }));
  }, 5000);

  try {
    sub = core.services.RoonApiTransport.subscribe_queue(zoneId, 100, (response, msg) => {
      if (response === "Subscribed") {
        finish(() => {
          const items = ((msg && msg.items) || []).map(it => ({
            queue_item_id: it.queue_item_id,
            title:    (it.one_line && it.one_line.line1) || (it.three_line && it.three_line.line1) || "",
            subtitle: (it.three_line && it.three_line.line2) || "",
            image_key: it.image_key || null,
            length:    it.length || null
          }));
          res.json({ items });
        });
      } else if (response && response !== "Changed" && response !== "Unsubscribed") {
        // An error name (e.g. "NetworkError") instead of a payload — fail fast
        // rather than waiting out the 5 s timeout.
        finish(() => res.status(502).json({ error: "queue subscription failed: " + response }));
      }
    });
    // If the first response was delivered synchronously (inside the
    // subscribe_queue call itself), finish() ran while `sub` was still null
    // and couldn't unsubscribe — catch up now that the handle exists.
    if (responded && sub) {
      try { sub.unsubscribe(() => {}); }
      catch (e) { /* socket already gone — the subscription died with it */ }
    }
  } catch (e) {
    finish(() => res.status(500).json({ error: e.message || String(e) }));
  }
});

app.get("/api/zone-state", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  const zone   = zoneId && zones[zoneId];
  if (!zone) return res.json({ zone: null });

  const np = zone.now_playing || null;
  const tl = (np && np.three_line) || {};
  const ol = (np && np.one_line)   || {};

  res.json({
    zone: {
      zone_id:             zone.zone_id,
      display_name:        zone.display_name,
      state:               zone.state,  // "playing" | "paused" | "loading" | "stopped"
      is_play_allowed:     !!zone.is_play_allowed,
      is_pause_allowed:    !!zone.is_pause_allowed,
      is_next_allowed:     !!zone.is_next_allowed,
      is_previous_allowed: !!zone.is_previous_allowed,
      is_seek_allowed:     !!zone.is_seek_allowed,
      // Shuffle / repeat / Roon Radio, so the now-playing screen can show the
      // zone's real state instead of guessing from its own last write.
      settings:            zoneSettings(zone),
      outputs: (zone.outputs || []).map(o => ({
        output_id:    o.output_id,
        display_name: o.display_name,
        is_muted:     !!o.is_muted,
        volume:       o.volume ? {
          value:      o.volume.value,
          min:        o.volume.min,
          max:        o.volume.max,
          step:       o.volume.step,
          soft_limit: o.volume.soft_limit,
          type:       o.volume.type
        } : null
      })),
      now_playing: np ? {
        line1:     tl.line1 || ol.line1 || "",   // track
        line2:     tl.line2 || "",               // artist
        line3:     tl.line3 || "",               // album
        // line2 split into individually linkable artists, the same
        // library-validated way /api/album splits an album credit — so the
        // now-playing screen can offer the artist links the album view has.
        // Memoised (creditLinks), because this endpoint is polled every 1.5s by
        // every open client and the same credit repeats for a whole album.
        //
        // `linkable` says whether the library can actually open a screen for
        // that name. It matters here and not on the album view because line2 is
        // the TRACK artist: on a compilation most track artists have no album
        // of their own, and linking them all would be a row of dead ends.
        artists:   creditLinks(tl.line2),
        image_key: np.image_key || null,
        length:    np.length || null,
        seek_position: np.seek_position || null
      } : null
    }
  });
});

// Playback control.  body: { zone_or_output_id, command }
// command ∈ play | pause | playpause | stop | previous | next
app.post("/api/control", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id, command } = req.body || {};
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  const allowed = ["play", "pause", "playpause", "stop", "previous", "next"];
  if (!allowed.includes(command)) {
    return res.status(400).json({ error: "invalid command, allowed: " + allowed.join(", ") });
  }
  core.services.RoonApiTransport.control(zone_or_output_id, command, (err) => {
    if (err) return res.status(500).json({ error: typeof err === "string" ? err : JSON.stringify(err) });
    res.json({ ok: true });
  });
});

// Shuffle / repeat / Roon Radio for a zone.
// body: { zone_or_output_id, shuffle?, loop?, auto_radio? }
//   shuffle:    boolean
//   loop:       "disabled" | "loop" (whole queue) | "loop_one" (this track)
//   auto_radio: boolean — Roon Radio, Roon's own keep-playing feature
//
// Roon's change_settings also accepts loop:"next" to cycle server-side; we
// deliberately don't expose it. The client already knows the current mode from
// the zone poll, so it sends the concrete state it wants — which means the
// request says what it does, and a failed call can't leave the UI out of step
// with the zone.
const ZONE_LOOP_MODES = ["disabled", "loop", "loop_one"];
app.post("/api/zone-settings", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id } = req.body || {};
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });

  const patch = {};
  if (req.body.shuffle !== undefined) {
    if (typeof req.body.shuffle !== "boolean") return res.status(400).json({ error: "shuffle must be a boolean" });
    patch.shuffle = req.body.shuffle;
  }
  if (req.body.auto_radio !== undefined) {
    if (typeof req.body.auto_radio !== "boolean") return res.status(400).json({ error: "auto_radio must be a boolean" });
    patch.auto_radio = req.body.auto_radio;
  }
  if (req.body.loop !== undefined) {
    if (!ZONE_LOOP_MODES.includes(req.body.loop)) {
      return res.status(400).json({ error: "invalid loop, allowed: " + ZONE_LOOP_MODES.join(", ") });
    }
    patch.loop = req.body.loop;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "one of shuffle, loop, auto_radio required" });
  }

  // Turning Roon Radio on makes the Random Album Radio stand down for this zone
  // (lib/radio.js returns null while auto_radio is set), so the two never fight
  // over the same queue. We don't silently switch the user's own setting off —
  // we report it so the UI can say what just happened.
  const zone = zones[zone_or_output_id]
    || (outputs[zone_or_output_id] && zones[outputs[zone_or_output_id].zone_id])
    || null;
  const ownRadioStandsDown = !!(patch.auto_radio === true && zone && radioZones.has(zone.zone_id));

  core.services.RoonApiTransport.change_settings(zone_or_output_id, patch, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[zone-settings] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true, random_album_radio_stands_down: ownRadioStandsDown });
  });
});

// Group outputs into one synchronised zone.  body: { output_ids: [...] }
// Roon preserves the FIRST output's zone's queue, so the client sends the zone
// it wants to keep playing first.
app.post("/api/group-outputs", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const ids = req.body && req.body.output_ids;
  if (!Array.isArray(ids) || ids.length < 2) {
    return res.status(400).json({ error: "output_ids must be an array of at least 2 output ids" });
  }
  if (!ids.every(id => typeof id === "string" && id)) {
    return res.status(400).json({ error: "output_ids must be non-empty strings" });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "output_ids must not repeat" });
  }
  const names = ids.map(id => (outputs[id] && outputs[id].display_name) || id);
  console.log(`[group-outputs] ${names.join(" + ")}`);
  core.services.RoonApiTransport.group_outputs(ids, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[group-outputs] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    console.log(`[group-outputs] ok`);
    res.json({ ok: true });
  });
});

// Roon's transport errors arrive as bare names ("SourceControlNotFound"). Those
// are useful in a log and useless in a toast, so the ones a user can actually
// hit get a sentence that says what it means for them. Anything unmapped falls
// through unchanged rather than being hidden behind a generic apology.
// A function rather than a lookup table so the tests exercise THIS mapping
// instead of a copy injected beside it — the hole that let a v1.6.59 mutation
// reorder the year-source ranking without a single test noticing.
function roonErrorText(name) {
  switch (name) {
    case "SourceControlNotFound":
      return "This device didn't accept that from Roon — its source control doesn't offer it.";
    case "ZoneNotFound":   return "That zone is no longer available.";
    case "OutputNotFound": return "That output is no longer available.";
    case "NotAllowed":     return "Roon wouldn't allow that right now.";
    case "InvalidRequest": return "Roon rejected the request.";
    case "NetworkError":   return "Lost contact with the Roon Core.";
    default:               return null;   // unmapped — pass the raw name through
  }
}
// Whether a failed keyed convenience_switch should be retried as the keyless
// (all-controls) form. Extracted so the rule is testable: only
// SourceControlNotFound qualifies, and only when we actually addressed a key.
// Any other error means Roon FOUND the control and refused on its own terms, and
// retrying as a broadcast would act on outputs the user never tapped.
function shouldRetryKeyless(roonErrorName, hadControlKey) {
  return !!hadControlKey && roonErrorName === "SourceControlNotFound";
}

// The live status of one source control, read from the raw cached Output. Pure
// so it can be tested; the route passes outputs[output_id] in.
function controlStatusOf(output, control_key) {
  const list = (output && Array.isArray(output.source_controls)) ? output.source_controls : [];
  const sc = list.find(s => s && s.control_key === control_key);
  return (sc && sc.status) || null;
}

// `toggle_standby` is the only one of the three transport power calls with NO
// documented keyless form, so when a keyed toggle is refused with
// SourceControlNotFound there is no like-for-like retry — we have to pick the
// keyless call that matches what the user meant by pressing Power:
//
//   in standby        -> they meant wake  -> convenience_switch (documented to
//                                            take a device out of standby)
//   selected/deselected -> they meant off -> standby
//
// Anything else returns null and the error is reported instead. Guessing on an
// unknown status is how a Power button turns a device the wrong way.
function keylessStandbyFallback(status) {
  if (status === "standby") return "wake";
  if (status === "selected" || status === "deselected") return "standby";
  return null;
}

function roonErrorPayload(err) {
  const name = typeof err === "string" ? err : JSON.stringify(err);
  const text = roonErrorText(name);
  // `error` is what the UI shows; `roon_error` keeps the raw name for support.
  return { error: text || name, roon_error: name };
}

// Device power for one output's source control.
// body: { output_id, control_key?, mode? }
//   mode "toggle"  (default) — flip this control's standby state. Roon defines
//                   toggle_standby per control, so a control_key is required.
//   mode "standby" — put every standby-capable control on the output into
//                    standby. This is the documented behaviour of standby()
//                    with control_key omitted, and is how "all off" works.
const STANDBY_MODES = ["toggle", "standby"];
app.post("/api/output/standby", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { output_id, control_key } = req.body || {};
  const mode = (req.body && req.body.mode) || "toggle";
  if (!output_id) return res.status(400).json({ error: "output_id required" });
  if (!STANDBY_MODES.includes(mode)) {
    return res.status(400).json({ error: "invalid mode, allowed: " + STANDBY_MODES.join(", ") });
  }
  if (mode === "toggle" && !control_key) {
    return res.status(400).json({ error: "control_key required for mode=toggle" });
  }
  if (control_key !== undefined && typeof control_key !== "string") {
    return res.status(400).json({ error: "control_key must be a string" });
  }

  const t = core.services.RoonApiTransport;
  const name = (outputs[output_id] && outputs[output_id].display_name) || output_id;
  const opts = control_key ? { control_key } : {};
  console.log(`[standby] ${mode} ${name}${control_key ? " (" + control_key + ")" : ""}`);
  // On a not-found, dump what the Core actually told us about this output's
  // controls — the only way to see the real key shape, and exactly the moment it
  // matters. `alreadyDumped` keeps a failure that was dumped before a retry
  // decision from printing the same block twice.
  const dumpControls = () => {
    console.warn("[standby] core reported source_controls:",
                 JSON.stringify((outputs[output_id] || {}).source_controls || null));
  };
  const fail = (err, alreadyDumped) => {
    const raw = typeof err === "string" ? err : JSON.stringify(err);
    console.warn(`[standby] failed: ${raw}`);
    if (!alreadyDumped && raw === "SourceControlNotFound") dumpControls();
    res.status(500).json(roonErrorPayload(err));
  };

  if (mode !== "toggle") {
    return t.standby(output_id, opts, (err) => err ? fail(err) : res.json({ ok: true }));
  }

  // Keyed toggle first. In production this is the path that works — a WiiM's
  // device-provided control accepts keyed toggle_standby with the very key it
  // refuses for convenience_switch, so the two calls resolve differently inside
  // the Core. The fallback below is cover for devices where it doesn't, not a
  // workaround for an observed failure on this one.
  t.toggle_standby(output_id, opts, (err) => {
    if (!err) return res.json({ ok: true, form: "toggle-keyed" });
    const raw = typeof err === "string" ? err : JSON.stringify(err);
    const notFound = raw === "SourceControlNotFound";
    if (notFound) dumpControls();
    if (!shouldRetryKeyless(raw, true)) return fail(err, notFound);

    const status = controlStatusOf(outputs[output_id], control_key);
    const want = keylessStandbyFallback(status);
    console.warn(`[standby] keyed toggle refused; status=${status || "unknown"} fallback=${want || "none"}`);
    if (!want) return fail(err, notFound);

    const after = (e2) => e2 ? fail(e2) : res.json({ ok: true, form: "keyless-" + want });
    if (want === "wake") t.convenience_switch(output_id, {}, after);
    else                 t.standby(output_id, {}, after);
  });
});

// Switch a device's input to Roon, waking it from standby if needed.
// body: { output_id, control_key? } — control_key omitted switches every
// control on the output, which is what Roon's own API does.
app.post("/api/output/convenience-switch", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { output_id, control_key } = req.body || {};
  if (!output_id) return res.status(400).json({ error: "output_id required" });
  if (control_key !== undefined && typeof control_key !== "string") {
    return res.status(400).json({ error: "control_key must be a string" });
  }
  const name = (outputs[output_id] && outputs[output_id].display_name) || output_id;
  const t = core.services.RoonApiTransport;

  // Roon defines TWO forms of this call: addressed at one source control by
  // control_key, or — with the key omitted — at every control on the output.
  // A real WiiM/Linkplay endpoint answered the keyed form with
  // SourceControlNotFound while happily reporting that very control_key to us,
  // so the keyed form is not universally honoured by device-provided source
  // controls. Rather than pick one and hope, try the keyed form and fall back to
  // the keyless one, which is the broader request and can only do more.
  //
  // The retry rule itself lives in shouldRetryKeyless() so it can be tested.
  const attempt = (opts, label, onFail) => {
    console.log(`[convenience-switch] ${name} ${label}`);
    t.convenience_switch(output_id, opts, (err) => {
      if (!err) return res.json({ ok: true, form: label });
      const raw = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[convenience-switch] ${label} failed: ${raw}`);
      // Dump BEFORE deciding to retry. Behind the retry it never fired at all:
      // the keyed attempt always retries on a not-found, so the one diagnostic
      // that explains the failure was unreachable in the only case it existed
      // for. A recovered failure is still the failure worth recording.
      if (raw === "SourceControlNotFound") {
        console.warn("[convenience-switch] core reported source_controls:",
                     JSON.stringify((outputs[output_id] || {}).source_controls || null));
      }
      if (onFail && shouldRetryKeyless(raw, true)) return onFail();
      res.status(500).json(roonErrorPayload(err));
    });
  };

  if (control_key) {
    attempt({ control_key }, "keyed(" + control_key + ")",
            () => attempt({}, "keyless-fallback", null));
  } else {
    attempt({}, "keyless", null);
  }
});

// Pause every zone. No body — Roon's pause_all takes no target.
app.post("/api/pause-all", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  console.log("[pause-all]");
  core.services.RoonApiTransport.pause_all((err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[pause-all] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true });
  });
});

// Mute or unmute every zone that can be muted.  body: { how: "mute"|"unmute" }
const MUTE_ALL_MODES = ["mute", "unmute"];
app.post("/api/mute-all", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const how = req.body && req.body.how;
  if (!MUTE_ALL_MODES.includes(how)) {
    return res.status(400).json({ error: "invalid how, allowed: " + MUTE_ALL_MODES.join(", ") });
  }
  console.log(`[mute-all] ${how}`);
  core.services.RoonApiTransport.mute_all(how, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[mute-all] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true });
  });
});

// Split outputs back out of their group.  body: { output_ids: [...] }
app.post("/api/ungroup-outputs", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const ids = req.body && req.body.output_ids;
  if (!Array.isArray(ids) || ids.length < 1) {
    return res.status(400).json({ error: "output_ids must be a non-empty array of output ids" });
  }
  if (!ids.every(id => typeof id === "string" && id)) {
    return res.status(400).json({ error: "output_ids must be non-empty strings" });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "output_ids must not repeat" });
  }
  const names = ids.map(id => (outputs[id] && outputs[id].display_name) || id);
  console.log(`[ungroup-outputs] ${names.join(", ")}`);
  core.services.RoonApiTransport.ungroup_outputs(ids, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[ungroup-outputs] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    console.log(`[ungroup-outputs] ok`);
    res.json({ ok: true });
  });
});

// Seek within the current track.  body: { zone_or_output_id, seconds }
// Absolute seek to a position in seconds from the start of the track.
app.post("/api/seek", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id } = req.body || {};
  const seconds = Number(req.body && req.body.seconds);
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  if (!Number.isFinite(seconds) || seconds < 0) return res.status(400).json({ error: "seconds must be a non-negative number" });
  core.services.RoonApiTransport.seek(zone_or_output_id, "absolute", Math.round(seconds), (err) => {
    if (err) return res.status(500).json({ error: typeof err === "string" ? err : JSON.stringify(err) });
    res.json({ ok: true });
  });
});

// Transfer zone: move the currently playing queue from one zone to another.
// body: { from_zone, to_zone }
app.post("/api/transfer-zone", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { from_zone, to_zone } = req.body || {};
  if (!from_zone || !to_zone) return res.status(400).json({ error: "from_zone and to_zone required" });
  if (from_zone === to_zone) return res.json({ ok: true, noop: true });

  const fromName = (zones[from_zone] && zones[from_zone].display_name) || from_zone;
  const toName   = (zones[to_zone]   && zones[to_zone].display_name)   || to_zone;
  console.log(`[transfer-zone] ${fromName} → ${toName}`);

  core.services.RoonApiTransport.transfer_zone(from_zone, to_zone, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[transfer-zone] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    console.log(`[transfer-zone] ok`);
    res.json({ ok: true });
  });
});

// Play from a specific queue item onwards.
// body: { zone_or_output_id, queue_item_id }
app.post("/api/play-from-here", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id, queue_item_id } = req.body || {};
  if (!zone_or_output_id || queue_item_id === undefined || queue_item_id === null) {
    return res.status(400).json({ error: "zone_or_output_id and queue_item_id required" });
  }
  core.services.RoonApiTransport.play_from_here(zone_or_output_id, queue_item_id, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[play-from-here] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true });
  });
});

// Volume.  body: { zone_or_output_id, value?, mute?, relative? }
//   value:    absolute volume to set (uses output's native scale)
//   relative: signed delta to add (e.g. +5, -5)
//   mute:     true/false
// For a zone, applies to every output in the zone.
app.post("/api/volume", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id } = req.body || {};
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });

  // Figure out which outputs to target
  const zone = zones[zone_or_output_id];
  const targetOutputs = zone
    ? (zone.outputs || []).map(o => o)
    : (outputs[zone_or_output_id] ? [outputs[zone_or_output_id]] : []);
  if (targetOutputs.length === 0) return res.status(404).json({ error: "no outputs found" });

  const t = core.services.RoonApiTransport;
  const tasks = [];

  if (req.body.mute !== undefined) {
    const how = req.body.mute ? "mute" : "unmute";
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.mute(o.output_id, how, err => err ? reject(err) : resolve())));
    }
  } else if (req.body.value !== undefined) {
    const v = parseFloat(req.body.value);
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.change_volume(o.output_id, "absolute", v, err => err ? reject(err) : resolve())));
    }
  } else if (req.body.relative !== undefined) {
    const v = parseFloat(req.body.relative);
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.change_volume(o.output_id, "relative", v, err => err ? reject(err) : resolve())));
    }
  } else {
    return res.status(400).json({ error: "value, relative, or mute required" });
  }

  Promise.all(tasks)
    .then(() => res.json({ ok: true }))
    .catch(err => res.status(500).json({
      error: typeof err === "string" ? err : JSON.stringify(err)
    }));
});

// ---------------------------------------------------------------------------
// "Play something unheard" — picks a random album not played in the last
// UNHEARD_MONTHS months (which trivially includes albums never played at
// all). Falls back to pure random once the whole library qualifies as
// recently heard. "Heard" is entirely self-tracked (see scrobbleUpdate) —
// Roon's extension API has no endpoint that reports a library-wide last-
// played date, so this only knows about plays observed while this extension
// was running and connected; listening from before that, or during any
// downtime, isn't reflected here.
const UNHEARD_MONTHS = 12;
async function pickUnheardAlbum() {
  let pick = null;
  if (labelsDb) {
    const cutoff = Date.now() - UNHEARD_MONTHS * 30 * 24 * 60 * 60 * 1000;
    const heard = getPlayedTitlesSince(cutoff);
    for (let attempt = 0; attempt < 10 && !pick; attempt++) {
      const candidates = (await pickRandomAlbums(10)).albums;
      const fresh = candidates.filter(a => !heard.has((a.title || "").toLowerCase().trim()));
      if (fresh.length) pick = fresh[0];
    }
  }
  if (!pick) {
    const picks = (await pickRandomAlbums(1)).albums;
    pick = picks[0] || null;
  }
  return pick;
}

// POST /api/play-unheard — play a random unheard album (see pickUnheardAlbum).
// Body: { zone: "<zone_id or display_name>" }
// ---------------------------------------------------------------------------
app.post("/api/play-unheard", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Roon not connected" });
  const zoneId = (req.body && req.body.zone) || null;
  if (!zoneId) return res.status(400).json({ error: "zone required" });
  try {
    const pick = await pickUnheardAlbum();
    if (!pick) return res.status(503).json({ error: "No albums available" });
    await openAlbumByOffset(pick.offset, zoneId, "play_now", null,
                            { title: pick.title || "", subtitle: pick.subtitle || "" });
    res.json({ ok: true, album: pick.title, artist: pick.subtitle });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Apple Shortcuts — simple GET endpoints for voice / automation triggers.
// ---------------------------------------------------------------------------

// List zones: GET /api/shortcut/zones
app.get("/api/shortcut/zones", (req, res) => {
  const list = Object.values(zones).map(z => ({
    id:    z.zone_id,
    name:  z.display_name,
    state: z.state
  }));
  res.json({ zones: list });
});

// Play random album: GET /api/shortcut/play-random?zone=ZONENAME
app.get("/api/shortcut/play-random", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Roon not connected" });
  const zoneName = req.query.zone || "";
  const zone = Object.values(zones).find(z => z.display_name === zoneName || z.zone_id === zoneName);
  if (!zone) {
    return res.status(404).json({
      error: "Zone not found",
      available: Object.values(zones).map(z => z.display_name)
    });
  }
  try {
    const picks = (await pickRandomAlbums(1)).albums;
    if (!picks.length) return res.status(503).json({ error: "No albums available" });
    await openAlbumByOffset(picks[0].offset, zone.zone_id, "play_now", null,
                            { title: picks[0].title || "", subtitle: picks[0].subtitle || "" });
    res.json({ ok: true, album: picks[0].title, artist: picks[0].subtitle, zone: zone.display_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Play unheard album: GET /api/shortcut/play-unheard?zone=ZONENAME
app.get("/api/shortcut/play-unheard", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Roon not connected" });
  const zoneName = req.query.zone || "";
  const zone = Object.values(zones).find(z => z.display_name === zoneName || z.zone_id === zoneName);
  if (!zone) {
    return res.status(404).json({
      error: "Zone not found",
      available: Object.values(zones).map(z => z.display_name)
    });
  }
  try {
    const pick = await pickUnheardAlbum();
    if (!pick) return res.status(503).json({ error: "No albums available" });
    await openAlbumByOffset(pick.offset, zone.zone_id, "play_now", null,
                            { title: pick.title || "", subtitle: pick.subtitle || "" });
    res.json({ ok: true, album: pick.title, artist: pick.subtitle, zone: zone.display_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Roon Random Albums UI listening on http://0.0.0.0:" + PORT);
  console.log("MusicD Remote v" + pkg.version +
              " — debug logging " + (DEBUG ? "ON" : "off") +
              (process.env.DOCKER === "1" ? " (Docker default; RRA_DEBUG=0 to quiet)" : ""));
  console.log("Log files: " + LOG_FILE + " (rotates at 8 MB, keeps " + LOG_MAX_FILES + " numbered files)" +
              (_logDead ? " — UNAVAILABLE, stdout only" : ""));
  console.log("Make sure to authorise the extension in Roon → Settings → Extensions.");
  if (DEBUG) console.log("Debug logging enabled (RRA_DEBUG=1).");
});
