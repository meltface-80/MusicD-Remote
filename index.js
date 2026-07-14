// roon-random-albums  —  random-album wall extension for Roon
// Runs alongside Roon Server, exposes a web UI on http://<host>:3399
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.

const path = require("path");
const fs   = require("fs");
const express = require("express");
const compression = require("compression");

const RoonApi          = require("node-roon-api");
const RoonApiStatus    = require("node-roon-api-status");
const RoonApiBrowse    = require("node-roon-api-browse");
const RoonApiImage     = require("node-roon-api-image");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiSettings  = require("node-roon-api-settings");

const { createUpdater } = require("./lib/updater");
const { radioDecision } = require("./lib/radio");
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
let outputs   = {};
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
        zones = {}; outputs = {};
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
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; }); handleRadioZone(z); scrobbleUpdate(z); });
        (data.zones_removed || []).forEach(zid => {
          const z = zones[zid];
          if (z) (z.outputs || []).forEach(o => delete outputs[o.output_id]);
          delete zones[zid];
          delete zonePrevState[zid]; // zone offline — reset so it won't auto-start if it returns
        });
      }
    });
    // Build the local search index in the background and keep it fresh.
    startIndexMaintenance();
  },
  core_unpaired: function () {
    core = null; zones = {}; outputs = {};
    Object.keys(zonePrevState).forEach(k => delete zonePrevState[k]);
    stopIndexMaintenance();
    // The album index is deliberately KEPT across an unpair: it's plain
    // offset/title data (no session-scoped item_keys), so it stays usable for
    // search while disconnected, and startIndexMaintenance() re-verifies it on
    // re-pair with a cheap 2-call probe instead of a full library re-walk —
    // a flapping connection no longer multiplies full rescans onto the Core.
    console.log("[roon] unpaired from core — index kept, awaiting re-pair");
    _statusPair = "Not paired with any Roon Core"; _statusPairErr = true; pushStatus();
  }
});

// ---- Roon status line (pairing state + any update notice) ----
let _statusPair = "Starting\u2026";
let _statusPairErr = false;
function pushStatus() {
  const st = updater.getStatus();
  let extra = "";
  if (st.apply.phase === "downloading" || st.apply.phase === "extracting") extra = "  \u2022  Updating\u2026";
  else if (st.apply.phase === "restarting") extra = "  \u2022  Restarting to update\u2026";
  else if (st.available) extra = `  \u2022  Update available: v${st.latest} \u2014 install from the web app or this Settings page`;
  try { svc_status.set_status(_statusPair + extra, _statusPairErr); } catch (e) {} // svc_status may be null before Roon pairs
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
function browse(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    const t0 = Date.now();
    if (DEBUG) console.log("[browse]", JSON.stringify(opts));
    core.services.RoonApiBrowse.browse(opts, (err, body) => {
      const ms = Date.now() - t0;
      if (err) {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("[browse] failed after " + ms + "ms:", msg, "opts:", JSON.stringify(opts));
        return reject(new Error(msg));
      }
      if (DEBUG) console.log("[browse:res]", ms + "ms", body && body.action,
                             body && body.list && body.list.title,
                             "count:", body && body.list ? body.list.count : "-");
      resolve(body);
    });
  });
}
function load(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    const t0 = Date.now();
    if (DEBUG) console.log("[load]", JSON.stringify(opts));
    core.services.RoonApiBrowse.load(opts, (err, body) => {
      const ms = Date.now() - t0;
      if (err) {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("[load] failed after " + ms + "ms:", msg, "opts:", JSON.stringify(opts));
        return reject(new Error(msg));
      }
      if (DEBUG) console.log("[load:res]", ms + "ms", body && body.list && body.list.title,
                            "items:", (body && body.items || []).length,
                            "total:", body && body.list ? body.list.count : "-");
      resolve(body);
    });
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
      const y = parseInt(albumYearCache.get(normalize(al.title) + "||" + normalize(al.subtitle)) || "", 10);
      if (Number.isFinite(y) && y >= decade && y < decade + 10) matches.push(al);
    }
    if (!matches.length) return { albums: [], total: 0 };
    const want = Math.min(count, matches.length);
    const picked = new Set();
    while (picked.size < want) picked.add(Math.floor(Math.random() * matches.length));
    const albums = [...picked].map(i => {
      const al = matches[i];
      return { offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null };
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
      return { offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null };
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
          albums.push({
            offset:    off,
            title:     item.title || "",
            subtitle:  item.subtitle || "",
            image_key: item.image_key || null
          });
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
async function loadAlbumSession(sessionKey, offset, filter, expect) {
  // 1) Navigate to the album list this offset belongs to (full library, or a
  //    genre/tag list when a filter is active — offsets are per-list). Decade
  //    offsets are full-library positions, so resolve them against the full
  //    library (no Roon list exists for a decade).
  const navFilter = (filter && filter.type === "decade") ? null : (filter || null);
  const nav = await navigateToAlbumList(sessionKey, navFilter);
  const hierarchy = nav.hierarchy;

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
    scheduleStaleRecheck();
    let relocated = null;
    let relocatedOffset = -1;
    if (!navFilter) {
      relocatedOffset = relocateAlbumOffset(expect);
      if (relocatedOffset >= 0 && relocatedOffset !== offset) {
        const retry = await load({
          hierarchy, offset: relocatedOffset, count: 1, multi_session_key: sessionKey
        });
        const retryItem = retry.items && retry.items[0];
        if (albumIdentityMatches(retryItem, expect)) relocated = retryItem;
      }
    }
    if (!relocated) {
      const err = new Error("The library just changed and this album moved — close and reopen it.");
      err.stale = true;
      throw err;
    }
    if (DEBUG) console.log("[album] stale offset " + offset + " relocated to " + relocatedOffset +
                           " for " + JSON.stringify(expect.title));
    offset = relocatedOffset;
    albumItem = relocated;
  }

  // 3) Drill into the album
  const drill = await browse({
    hierarchy,
    item_key:  albumItem.item_key,
    multi_session_key: sessionKey
  });
  if (drill.action !== "list") {
    throw new Error("Unexpected browse action: " + drill.action);
  }

  // 4) Load contents (tracks + action_list).  Explicit count for big albums.
  const inside = await load({
    hierarchy,
    offset: 0,
    count: 500,
    multi_session_key: sessionKey
  });

  const items = inside.items || [];
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

  // `offset` may have been corrected by the stale-offset relocation above —
  // callers pass it back to the client so follow-up plays use the fresh one.
  return { hierarchy, albumItem, items, playMenu, offset };
}

// A track = an item that isn't the play menu, a no-subtitle submenu
// (e.g. "Add to Library"), or a section header. Shared by the detail
// listing and per-track actions so their indexes always align.
function isTrackItem(t, playMenu) {
  if (t === playMenu)                          return false;
  if (t.hint === "action_list" && !t.subtitle) return false;
  if (t.hint === "header")                     return false;
  return true;
}

// Roon prefixes track titles with "N. "; the UI renders its own counter.
function stripTrackNumber(title) {
  return (title || "").replace(/^\d+\.\s+/, "");
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
// A verify-mismatch at open/play time is hard evidence the library shifted —
// kick the change probe now instead of waiting up to 5 minutes for the next
// scheduled one. checkIndexChanged no-ops while a build is in flight, so
// chain behind the running build in that case. Two guards keep a bulk import
// from amplifying: the pending flag clears only AFTER the probe completes
// (never two concurrent play-driven probes), and a 30s floor stops mismatch
// bursts from chaining probe→rebuild→probe continuously — worst case the
// regular 5-minute tick still catches anything this floor skips.
let _staleRecheckPending = false;
let _staleRecheckLast = 0;
function scheduleStaleRecheck() {
  if (_staleRecheckPending) return;
  if (Date.now() - _staleRecheckLast < 30 * 1000) return;
  _staleRecheckPending = true;
  const clear = () => { _staleRecheckPending = false; };
  const run = () => {
    _staleRecheckLast = Date.now();
    Promise.resolve(checkIndexChanged()).then(clear, clear);
  };
  if (albumIndex.building) albumIndex.building.then(run, run);
  else setTimeout(run, 0);
}

async function openAlbumByOffset(offset, zoneOrOutputId, invokeKind, filter, expect) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, albumItem, items, playMenu, offset: effectiveOffset } =
      await loadAlbumSession(sessionKey, offset, filter, expect);

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
        throw new Error("No matching action for '" + invokeKind +
                        "'. Available: " + actions.map(a => a.title).join(", "));
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

    return { album: albumInfo, tracks, actions, invoked, offset: effectiveOffset };
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
    throw new Error("Unexpected browse action: " + d.action);
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
async function invokeTrackAction(offset, trackIndex, trackTitle, zoneOrOutputId, kind, filter) {
  return withBrowseSession(async (sessionKey) => {
    const { hierarchy, items, playMenu } = await loadAlbumSession(sessionKey, offset, filter);
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
      throw new Error("No matching action for '" + kind +
                      "'. Available: " + actions.map(a => a.title).join(", "));
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
  const map = new Map(); // key → { value, at }
  return {
    async get(key, fetchFn) {
      const hit = map.get(key);
      if (hit && (Date.now() - hit.at) < ttlMs) return hit.value;
      const value = await fetchFn();
      map.set(key, { value, at: Date.now() });
      return value;
    },
    clear() { map.clear(); }
  };
}

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

let labelsDb = null;
let stmtInsertName, stmtInsertMbid, stmtInsertLogo, stmtInsertMerge, stmtDeleteMerge, stmtInsertYear;
let stmtInsertPlay, stmtCompletePlay;

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
    `);
    stmtInsertName  = labelsDb.prepare("INSERT OR REPLACE INTO label_names (key, label) VALUES (?, ?)");
    stmtInsertMbid  = labelsDb.prepare("INSERT OR REPLACE INTO label_mbids (group_key, mbid) VALUES (?, ?)");
    stmtInsertLogo  = labelsDb.prepare("INSERT OR REPLACE INTO label_logos (group_key, logo_url) VALUES (?, ?)");
    stmtInsertMerge = labelsDb.prepare("INSERT OR REPLACE INTO label_merges (source_key, source_display, target_key, target_display) VALUES (?, ?, ?, ?)");
    stmtDeleteMerge = labelsDb.prepare("DELETE FROM label_merges WHERE source_key = ?");
    stmtInsertPlay  = labelsDb.prepare("INSERT INTO plays (ts, zone, track, artist, album, image_key, duration) VALUES (?,?,?,?,?,?,?)");
    stmtCompletePlay = labelsDb.prepare("UPDATE plays SET completed=1 WHERE id=?");
    stmtInsertYear  = labelsDb.prepare("INSERT OR REPLACE INTO album_years (key, year) VALUES (?, ?)");
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
    for (const r of labelsDb.prepare("SELECT key, year FROM album_years").all()) {
      if (r.year) albumYearCache.set(r.key, r.year);
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
// Persist a release year for an album key (4-digit). Powers the Decade filter.
function setAlbumYear(key, year) {
  const y = String(year || "").slice(0, 4);
  if (!/^\d{4}$/.test(y)) return; // only store a plausible 4-digit year
  albumYearCache.set(key, y);
  if (labelsDb && stmtInsertYear) stmtInsertYear.run(key, y);
}

openLabelsDb();

// ---------------------------------------------------------------------------
// Fan Art TV — label logo images. Free API key — set via web UI settings.

const labelsIndex = {
  map:      new Map(),   // groupKey → { display, image_key, albums: [{offset,title,subtitle,image_key}] }
  count:    0,
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
    const match = albums.find(a => normalize(a.strAlbum || "") === normTitle) || albums[0];
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

// Build a map of albumKey → label from audio file tags.
// Expects Artist/Album/track.flac layout — reads one file per album directory.
async function buildFileLabelMap(onProgress) {
  const map = new Map();
  const bandcampMap = new Map(); // albumKey → Bandcamp album page URL (from COMMENT tag)
  if (!musicDirMounted()) return { labelMap: map, bandcampMap };
  let mm;
  try { mm = await import("music-metadata"); } catch (e) {
    if (DEBUG) console.error("[labels:files] music-metadata not available:", e.message);
    return { labelMap: map, bandcampMap };
  }
  const parseFile = mm.parseFile || (mm.default && mm.default.parseFile);
  if (!parseFile) {
    if (DEBUG) console.error("[labels:files] music-metadata loaded but parseFile not found");
    return { labelMap: map, bandcampMap };
  }

  const AUDIO_RE = /\.(flac|mp3|m4a|aac|ogg|opus|wv|ape|wav|aiff?)$/i;

  // Recursively scan directories up to MAX_DEPTH levels deep.
  // When audio files are found in a directory, read tags from the first one.
  // Match is keyed on tag values (common.album + common.albumartist) so
  // directory naming convention (Artist/Album vs flat Artist - Album) doesn't matter.
  const MAX_DEPTH = 3;
  let _fsProcessed = 0;
  async function scanDir(dirPath, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (e) { return; /* permission denied or dir vanished mid-scan — skip silently */ }

    const audioFile = entries.find(e => e.isFile() && AUDIO_RE.test(e.name));
    if (audioFile) {
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
        const album = meta.common.album;
        const albumartist = meta.common.albumartist
          || (meta.common.artists && meta.common.artists[0])
          || meta.common.artist || null;
        if (label && !isLikelyNotALabel(label) && album) {
          const key = normalize(album) + "||" + normalize(albumartist || "");
          if (!map.has(key)) map.set(key, label);
        }
        // Capture the release year from file tags too (powers the Decade filter).
        const fyear = meta.common.year
          || String(meta.common.originaldate || meta.common.date || "").slice(0, 4);
        if (album && fyear) {
          const ykey = normalize(album) + "||" + normalize(albumartist || "");
          if (!albumYearCache.has(ykey)) setAlbumYear(ykey, fyear);
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
      } catch (e) { /* unreadable — skip */ }
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
  if (DEBUG) console.log("[labels:files] file scan found", map.size, "labels,", bandcampMap.size, "Bandcamp URLs");
  return { labelMap: map, bandcampMap };
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
async function runLabelsIndexScan() {
  if (labelsIndex.building) return;
  if (albumIndex.count === 0) {
    if (albumIndex.building) { try { await albumIndex.building; } catch (e) { /* albumIndex build failed — safe to continue; the count===0 check below will abort */ } }
    if (albumIndex.count === 0) return;
  }
  labelsIndex.building = true;
  labelsIndex.progress = 0;

  try {

  seedLabelsFromCache();

  // Pass 0: File metadata — runs unconditionally (before the early-return check)
  // so corrected file tags override stale API-derived cache entries on every scan,
  // including 12-hour auto-rescans where all albums are already cached.
  const estimate = albumIndex.albums.length || 1000;
  const { labelMap: fileLabelMap, bandcampMap } = musicDirMounted()
    ? await buildFileLabelMap((n) => {
        labelsIndex.progress = Math.min(0.15, n / estimate);
      })
    : { labelMap: new Map(), bandcampMap: new Map() };
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
            if (result.year && !albumYearCache.has(key)) setAlbumYear(key, result.year);
            bcResolved++;
            bcConsec = 0;
          } else {
            if (result && result.year && !albumYearCache.has(key)) setAlbumYear(key, result.year);
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
        if (q && q.year && !albumYearCache.has(key)) setAlbumYear(key, q.year);
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
        if (mbResult.year && !albumYearCache.has(key)) setAlbumYear(key, mbResult.year);
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
  if (labelsIndex.building) return;
  appendLabelsLog("[labels] 12-hour auto-rescan triggered");
  runLabelsIndexScan().catch(e => {
    const msg = "[labels] auto-rescan error: " + e.message;
    console.error(msg);
    appendLabelsLog(msg);
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
    if (DEBUG) console.error("[labels:fanart]", groupKey, e.message);
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
    if (DEBUG) console.error("[labels:discogs:logo]", e.message);
    return { logo: null, reason: "error" };
  }
}

async function kickDiscogsLogoFetches() {
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
  let found = 0, emptyCount = 0, filteredCount = 0, errorCount = 0;
  for (const { groupKey, display } of pending) {
    const { logo, reason } = await fetchLogoFromDiscogs(display);
    // Only mark tried on definitive results — network errors can retry next scan cycle.
    if (reason !== "error") discogsLogoTried.add(groupKey);
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
  const msg = "[labels:discogs:logos] done: " + found + "/" + pending.length + " logos found" +
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
const INDEX_MAX_AGE_MS = 60 * 60 * 1000;   // rebuild if older than this (safety net)
const INDEX_CHECK_MS   = 5 * 60 * 1000;    // how often to check for library edits
// A clean 5-min probe (count + first/last identity unchanged) now REFRESHES
// freshness (verifiedAt below) instead of letting the 1h window lapse — the
// lapse made every hour of active use kick off a full count:500 re-walk of a
// provably unchanged library (the Roon-side JSON-serialization churn reported
// against Build 1670). The probe can't see a mid-list count-neutral edit,
// so a full walk still runs at most daily:
const INDEX_HARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const albumIndex = {
  albums:   [],     // [{ offset, title, subtitle, image_key, nTitle, nArtist, tTitle[], tArtist[], jTitle, jArtist, artistNames[] }]
  count:    0,
  builtAt:  0,      // last FULL walk of the library
  verifiedAt: 0,    // last clean probe that confirmed the index still matches
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
// (the artist screen still substring-matches whatever name it's given).
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
    const frags = part.split(/\s*,\s*| & | \+ | and /i)
      .map(s => s.trim())
      .filter(f => f.length >= 2);   // "," splits of initials/junk never link
    if (frags.length >= 2 && frags.some(f => known.has(normalize(f)))) out.push(...frags);
    else out.push(part);
  }
  return out.length ? out : [whole];
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
    albumIndex.builtAt  = Date.now();
    albumIndex.verifiedAt = albumIndex.builtAt;
    albumIndex.progress = 1;
    if (DEBUG) console.log("[index] built", albumIndex.count, "albums");
    return albumIndex;
  });

  try {
    return await albumIndex.building;
  } finally {
    albumIndex.building = null;
  }
}

// Single definition of index freshness, shared by ensureAlbumIndex (rebuild
// trigger) and startIndexMaintenance (re-pair probe-vs-rebuild choice) so the
// two paths can never disagree about when a rebuild is due.
function isIndexFresh() {
  // Fresh = full walk OR clean probe within the 1h window, AND the last full
  // walk is within the 24h hard cap (probes can't see mid-list count-neutral
  // edits, so verification alone must not extend freshness forever).
  const freshRef = Math.max(albumIndex.builtAt, albumIndex.verifiedAt);
  return albumIndex.count > 0 && albumIndex.builtAt > 0 &&
         (Date.now() - freshRef) <= INDEX_MAX_AGE_MS &&
         (Date.now() - albumIndex.builtAt) <= INDEX_HARD_MAX_AGE_MS;
}

// Ensure a usable index exists; (re)build if empty or stale. Awaits only the
// very first build (so the first search returns results); a stale rebuild
// happens in the background while the current index keeps serving.
async function ensureAlbumIndex() {
  if (!isIndexFresh() && !albumIndex.building) {
    buildAlbumIndex().catch(e => { if (DEBUG) console.error("[index] build failed:", e.message); });
  }
  if (albumIndex.count === 0 && albumIndex.building) {
    await albumIndex.building.catch(() => { /* build error already logged by buildAlbumIndex */ });
  }
}

// One cheap library-change probe: 2-3 Roon round-trips (count + the first
// and last albums' identities), triggering a full rebuild only when something
// actually changed. Runs on the 5-minute maintenance interval AND once on
// re-pair (instead of the unconditional full re-walk re-pairing used to cost).
async function checkIndexChanged() {
  if (!core || albumIndex.building) return;
  try {
    await withBrowseSession(async (sessionKey) => {
      await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
      const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
      const total = head.list && head.list.count ? head.list.count : 0;
      // A count-neutral edit (retag that reorders the list) shifts offsets
      // without changing the total — compare the FIRST and LAST albums'
      // identities too. First alone missed count-neutral edits deeper in the
      // list (an add+remove pair, a mid-list re-sort); checking both ends
      // costs one extra load per probe and catches almost all of them. This
      // matters doubly since re-pairing now relies on this probe instead of
      // an unconditional full rebuild.
      const identity = it => it ? (it.title || "") + "||" + (it.subtitle || "") : "";
      const first = head.items && head.items[0];
      const firstNow = identity(first);
      const firstIdx = identity(albumIndex.albums[0]);
      let lastChanged = false;
      if (total > 1 && albumIndex.count > 1 && total === albumIndex.count) {
        const tail = await load({ hierarchy: "albums", offset: total - 1, count: 1, multi_session_key: sessionKey });
        const last = tail.items && tail.items[0];
        lastChanged = identity(last) !== identity(albumIndex.albums[albumIndex.count - 1]);
      }
      const changed = total !== albumIndex.count ||
                      (albumIndex.count > 0 && firstNow !== firstIdx) || lastChanged;
      // Even when the probe is clean, honour the daily hard cap here too —
      // on an idle box nothing else calls ensureAlbumIndex, so without this
      // the offsets could drift past 24h with only probe-level verification.
      const capExpired = albumIndex.builtAt > 0 &&
                         (Date.now() - albumIndex.builtAt) > INDEX_HARD_MAX_AGE_MS;
      if (!changed && !capExpired) {
        albumIndex.verifiedAt = Date.now();
        return;
      }
      if (DEBUG) console.log("[index] library", changed ? "changed (count " + albumIndex.count + " -> " + total + ")" : "past the 24h full-walk cap", "- rebuilding");
      // A library edit (add/remove/reorder) shifts the genre/label/tag list
      // positions too, so drop the browse offset cache — stale entries would
      // still be caught by the title verify, but clearing avoids the wasted
      // verify round-trip on the first play of each filter after a change.
      clearBrowseOffsetCache();
      // Re-seed labelsIndex from the fresh album index too: its album offsets
      // are a snapshot, and a rebuild (reorder/add/remove) leaves them
      // pointing at the wrong albums for the labels browser + display grids.
      buildAlbumIndex()
        .then(() => rebuildLabelsMap())
        .catch(() => { /* build error already logged by buildAlbumIndex */ });
    });
  } catch (e) { /* browse/load probe failed — next maintenance tick will retry */ }
}

// Background maintenance: build (or verify) now, then probe for library edits
// periodically. Started on pairing, stopped on unpairing.
function startIndexMaintenance() {
  stopIndexMaintenance();
  // The index survives an unpair (see core_unpaired), so a re-pair with a
  // recent index only needs the cheap probe to confirm it, not a full
  // library re-walk. This matters when the Core itself is struggling: its
  // GC pauses drop the connection, and the old unconditional rescan then
  // hit the recovering Core with a full library walk on every re-pair.
  if (isIndexFresh()) {
    checkIndexChanged();
  } else {
    buildAlbumIndex()
      .then(() => seedLabelsFromCache())
      .catch(e => { if (DEBUG) console.error("[index] initial build:", e.message); });
  }
  indexMaintTimer = setInterval(checkIndexChanged, INDEX_CHECK_MS);
}
function stopIndexMaintenance() {
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
  return out.slice(0, limit).map(({ al, score }) => ({
    offset:    al.offset,
    title:     al.title,
    subtitle:  al.subtitle,
    image_key: al.image_key,
    score
  }));
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
app.use(express.json());
// API request tracing (DEBUG): method, path, status, duration — one line per
// user action. The steady pollers are excluded: they'd bury everything else
// under a line every 1.5s (zone-state) and per art tile (image).
const TRACE_SKIP = /^\/api\/(zone-state|zones$|image\/|update\/status|settings\/tidal\/status|labels-scan-status|search-status)/;
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
    zone_count: Object.keys(zones).length
  });
});

app.get("/api/zones", (req, res) => {
  const list = Object.values(zones).map(z => ({
    zone_id:      z.zone_id,
    display_name: z.display_name,
    state:        z.state,
    outputs: (z.outputs || []).map(o => ({
      output_id: o.output_id, display_name: o.display_name
    }))
  })).sort((a, b) => a.display_name.localeCompare(b.display_name));
  res.json({ zones: list });
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
app.get("/api/filters/decades", (req, res) => {
  const counts = new Map();
  for (const year of albumYearCache.values()) {
    const y = parseInt(year, 10);
    if (!Number.isFinite(y)) continue;
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
  const norm = normalize(artist);
  const primary = [], featured = [];
  for (const al of albumIndex.albums) {
    const sub = normalize(al.subtitle || "");
    if (!sub) continue;
    if (sub === norm) primary.push(al);
    else if (sub.includes(norm)) featured.push(al);
  }
  primary.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  featured.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  res.json({ artist, primary, featured });
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
      return { offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null };
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
    res.json({ album: { offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null } });
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
    const albums = entry.albums.slice(0, 24).map(a => ({
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
const genreGroupsCache = makeTtlCache(30 * 60 * 1000);
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
app.get("/api/filters/genres", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    const genres = await withBrowseSession(async (sessionKey) => {
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
    });
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
  // Seed from cache so the first response includes labels even on a fresh restart.
  if (labelsIndex.map.size === 0 && albumIndex.count > 0) {
    seedLabelsFromCache();
  }
  // Kick off a scan if never done, or if the last scan is older than the rescan interval.
  if (!labelsIndex.building && (labelsIndex.builtAt === 0 || Date.now() - labelsIndex.builtAt > LABELS_RESCAN_MS)) {
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
  res.json({ albums, total: albums.length, label: name, order,
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
app.post("/api/labels/rescan", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  if (labelsIndex.building) return res.json({ ok: false, reason: "scan already running" });
  labelsIndex.builtAt = 0;
  appendLabelsLog("[labels] manual rescan requested via web UI");
  runLabelsIndexScan().catch(e => {
    const msg = "[labels] rescan error: " + e.message;
    if (DEBUG) console.error(msg);
    appendLabelsLog(msg);
  });
  res.json({ ok: true });
});

// Force a FULL rescan — wipes label name cache so ALL albums are re-queried
// from sources. Logo, MBID and merge data are preserved.
app.post("/api/labels/rescan-force", (req, res) => {
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
  runLabelsIndexScan().catch(e => {
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
//   /api/debug/browse-probe?path=Qobuz/New%20Releases&album=0 → dump album 0's actions
app.get("/api/debug/browse-probe", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const hierarchy = "browse";
  const segments = (req.query.path || "").toString().split("/").map(s => s.trim()).filter(Boolean);
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
          // Read-only drill: browse the album item with NO zone, then list its
          // contents (top-level action_list items + tracks). Nothing is invoked.
          await browse({ hierarchy, item_key: target.item_key, multi_session_key: sessionKey });
          const inside = await load({ hierarchy, offset: 0, count: 500, multi_session_key: sessionKey });
          out.album = {
            title: target.title || null,
            subtitle: target.subtitle || null,
            list_title: (inside.list && inside.list.title) || null,
            items: (inside.items || []).map(mapItem)
          };
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

app.get("/api/image/:image_key", async (req, res) => {
  const size = Math.max(64, Math.min(1200, parseInt(req.query.size || "400", 10)));
  const cacheKey = req.params.image_key + "@" + size;
  const cached = imageCacheGet(cacheKey);
  if (cached) {
    res.set("Content-Type", cached.type);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    return res.send(cached.body);
  }
  if (!core) return res.status(503).end();
  try {
    const { content_type, body } = await getImage(req.params.image_key, {
      scale: "fit", width: size, height: size, format: "image/jpeg"
    });
    const type = content_type || "image/jpeg";
    imageCachePut(cacheKey, { body, type, bytes: body.length });
    res.set("Content-Type", type);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(body);
  } catch (e) {
    res.status(404).end();
  }
});

// Album detail: requires ?offset=N
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
      album:  r.album,
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
  appendLabelsLog("[labels:fanart] key saved — cleared " + purged + " cached misses, refetching");
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
  // Re-run the label scan so file labels are re-derived from folders (or tags).
  if (changed && core && !labelsIndex.building) {
    labelsIndex.builtAt = 0;
    appendLabelsLog("[labels] rescan triggered by label-folder-depth change → " + depth);
    runLabelsIndexScan().catch(e => { if (DEBUG) console.error("[labels] rescan error:", e.message); });
  }
  res.json({ ok: true, saved, rescanning: changed && !!core });
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
    const labels  = searchLabels(nq);
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
    await buildAlbumIndex();
    res.json({ ok: true, indexed: albumIndex.count });
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
const radioBusy = {}; // zone_id -> { active: bool, ts: number }
// Per-zone previous state — used to detect genuine playing→stopped transitions.
// "play" is only triggered when we observed a zone go from playing/loading
// to stopped (queue ran out naturally). A zone that is already stopped when
// we first see it (restart / reconnect) never gets a "play" command.
const zonePrevState = {};

async function radioTopUp(zoneId, mode) {
  const st = radioBusy[zoneId] || (radioBusy[zoneId] = { active: false, ts: 0 });
  if (st.active && (Date.now() - st.ts) < 30000) return; // already working; 30s safety
  st.active = true; st.ts = Date.now();
  try {
    const pick = await pickSmartAlbum();
    if (!pick) { st.active = false; return; }
    await openAlbumByOffset(pick.offset, zoneId, mode === "play" ? "play_now" : "queue", null,
                            { title: pick.title || "", subtitle: pick.subtitle || "" });
    if (DEBUG) console.log("[radio] " + mode + " '" + pick.title + "' -> " + zoneId);
    // st.active clears when the queue grows (handleRadioZone sees remaining > 1)
    // or via the 30s timeout above if the queue never reflects the add.
  } catch (e) {
    if (DEBUG) console.error("[radio] top-up failed:", e.message);
    if (e && e.stale) {
      // The pick's offset drifted mid-library-change (import/rescan). Zone
      // events fire ~1/sec while a queue drains, so releasing the guard here
      // would hammer the Core with a failing browse session per event for the
      // whole import. Keep the 30s throttle armed; the retry after it lapses
      // re-picks against the (by then likely rebuilt) index.
      st.ts = Date.now();   // st.active stays true
    } else {
      st.active = false; // allow a retry on the next zone update
    }
  }
}

function handleRadioZone(z, isInitial, allowPlay) {
  if (!z || !radioZones.has(z.zone_id)) return;
  const zid = z.zone_id;
  const st  = radioBusy[zid] || (radioBusy[zid] = { active: false, ts: 0 });

  // Clear the "working" guard once the queue is healthy again.
  if ((z.state === "playing" || z.state === "loading") &&
      typeof z.queue_items_remaining === "number" && z.queue_items_remaining > 1) {
    st.active = false;
  }

  const decision = radioDecision(z, true);
  if (decision === "queue") {
    radioTopUp(zid, "queue");
  } else if (decision === "play" && !isInitial) {
    // Only start playback when we witnessed this zone transition from
    // playing/loading → stopped (queue ran out naturally), OR when the caller
    // explicitly requested it (user just enabled radio on an idle zone).
    const wasPlaying = zonePrevState[zid] === "playing" || zonePrevState[zid] === "loading";
    if (wasPlaying || allowPlay) radioTopUp(zid, "play");
  }

  // Record state AFTER the decision so the next event sees a real transition.
  zonePrevState[zid] = z.state;
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
    if (radioBusy[zoneId]) radioBusy[zoneId].active = false;
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
      if (!albumYearCache.has(exKey)) setAlbumYear(exKey, year);
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
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
  let mbid = null;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const artists = json && json.artists;
    if (Array.isArray(artists) && artists.length) mbid = artists[0].id || null;
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
  else if (channelN.indexOf(artistN) !== -1) score += 40; // artist-adjacent channel: needs the keyword too
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
    const moreArtist = [];
    if (artistN) {
      for (const al of albumIndex.albums) {
        if (moreArtist.length >= 12) break;
        if (normalize(al.title) === npTitleN) continue;
        const subN = normalize(al.subtitle || "");
        if (subN === artistN || subN.split(" / ").indexOf(artistN) !== -1 ||
            subN.startsWith(artistN + " /") || subN.indexOf(" / " + artistN) !== -1) {
          moreArtist.push({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null });
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
    const labelName = resolveAlbumLabelName({ title: album, subtitle: artist });
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
        picks.push({ offset: al.offset, title: al.title || "", subtitle: al.subtitle || "", image_key: al.image_key || null });
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
app.post("/api/play-track", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { offset, track, title, zone_or_output_id, kind } = req.body || {};
  const filter = parseFilter(req.body || {});
  if (!Number.isFinite(offset)) return res.status(400).json({ error: "offset required" });
  if (!Number.isInteger(track) || track < 0) return res.status(400).json({ error: "track index required" });
  if (!zone_or_output_id)       return res.status(400).json({ error: "zone_or_output_id required" });
  if (kind !== "play_now" && kind !== "queue" && kind !== "play_next") {
    return res.status(400).json({ error: "kind must be play_now, queue or play_next" });
  }
  try {
    const r = await invokeTrackAction(offset, track, title || "", zone_or_output_id, kind, filter);
    res.json({ ok: true, action: r.invoked, track: r.track });
  } catch (e) {
    // stale = the modal's track list no longer matches the library
    res.status(e.stale ? 409 : 500).json({ error: e.message });
  }
});

// Play multiple albums: first uses `kind`, subsequent albums are always queued.
// body { offsets: [N, ...], zone_or_output_id, kind }
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
    if (failed > 0) {
      return res.status(500).json({
        error: `Queued ${rest.length - failed} of ${rest.length} albums; ${failed} failed: ${firstError}`
      });
    }
    res.json({ ok: true });
  } catch (e) {
    // stale = the FIRST album's offset drifted and couldn't be relocated —
    // same 409 contract as /api/album and /api/play.
    res.status(e.stale ? 409 : 500).json({ error: e.message });
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

      const titleN  = title.toLowerCase().trim();
      const artistN = artist.toLowerCase().trim();
      const albumItem =
           (albs.items || []).find(i => (i.title || "").toLowerCase() === titleN
                                      && (i.subtitle || "").toLowerCase().includes(artistN))
        || (albs.items || []).find(i => (i.title || "").toLowerCase() === titleN)
        || (albs.items || []).find(i => (i.title || "").toLowerCase().includes(titleN))
        || (albs.items || [])[0];
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
