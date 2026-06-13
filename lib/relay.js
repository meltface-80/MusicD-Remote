"use strict";

// ---------------------------------------------------------------------------
// ZoneRelay — makes a Roon zone appear as a Spotify Connect speaker.
//
// Two audio capture modes (auto-detected at startup):
//
//  A) pipe   — librespot --backend pipe writes raw PCM to stdout.
//              Fastest, zero extra dependencies.  Only available if librespot
//              was compiled with the pipe feature (cargo feature "pipe").
//              raspotify's pre-built binary may omit this; see mode B.
//
//  B) alsa   — librespot plays to an ALSA loopback device (snd-aloop kernel
//              module).  arecord captures from the loopback and pipes the PCM
//              to us.  Works even when the pipe feature is absent.
//              Requires: alsa-utils (apt-get install alsa-utils)
//
// The captured PCM is served over the MAIN Express app (port 3399) via
// GET /relay/audio/:zoneId — no separate HTTP server, no random ports,
// no firewall issues.  A 6-second rolling buffer lets Roon catch up.
// ---------------------------------------------------------------------------

const { spawn, spawnSync, execFileSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const BYTES_PER_SEC    = 176400;           // S16LE 44100 Hz stereo
const MAX_BUFFER_BYTES = BYTES_PER_SEC * 6;

function getLocalIP() {
  if (process.env.RELAY_MEDIA_HOST) return process.env.RELAY_MEDIA_HOST;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function makeWavHeader() {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(2, 22);             // stereo
  h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

function findLibrespot() {
  const candidates = [
    process.env.LIBRESPOT_PATH,
    path.join(os.homedir(), ".cargo", "bin", "librespot"),
    "/opt/homebrew/bin/librespot",
    "/usr/local/bin/librespot",
    "/usr/bin/librespot",
    "/var/lib/raspotify/librespot",
    "/usr/bin/raspotify-librespot",
    path.join(__dirname, "..", "bin", "librespot"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { execFileSync(p, ["--version"], { stdio: "ignore", timeout: 3000 }); return p; } catch {}
  }
  try { execFileSync("librespot", ["--version"], { stdio: "ignore", timeout: 3000 }); return "librespot"; } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

// Check if librespot was compiled with pipe backend support.
function librespotHasPipe(librespotPath) {
  for (const flag of ["--list-backends", "--help"]) {
    try {
      const r = spawnSync(librespotPath, [flag], { timeout: 5000, encoding: "utf8" });
      const out = (r.stdout || "") + (r.stderr || "");
      if (/\bpipe\b/i.test(out)) return true;
    } catch {}
  }
  return false;
}

// Kill librespot conflicts and clear stale Avahi service registrations.
// When librespot crashes (exit code 1) it does NOT deregister from Avahi.
// The daemon keeps the {_spotify-connect._tcp, "Roon: WPP"} entry alive, so
// the NEXT librespot startup sees a "Local name collision" and crashes too.
// Restarting avahi-daemon wipes all stale entries.
function killConflictingLibrespot() {
  // 1. Stop raspotify service if running
  try {
    execFileSync("systemctl", ["stop", "raspotify"], { timeout: 5000, stdio: "ignore" });
    console.log("[relay] stopped raspotify service");
  } catch {}

  // 2. Kill any other librespot processes by name
  try {
    const r = spawnSync("pgrep", ["-x", "librespot"], { timeout: 3000, encoding: "utf8" });
    const pids = (r.stdout || "").trim().split("\n").filter(Boolean).map(Number).filter(Boolean);
    if (pids.length) {
      console.log(`[relay] killing librespot PIDs: ${pids.join(", ")}`);
      for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
      spawnSync("sleep", ["1"], { timeout: 2000 }); // wait for them to die
    }
  } catch {}

  // 3. Restart avahi-daemon to clear stale Spotify Connect registrations.
  // This is the critical step — without it, crashed librespot processes leave
  // their mDNS entry in Avahi causing permanent "Local name collision".
  try {
    console.log("[relay] restarting avahi-daemon to clear stale registrations...");
    execFileSync("systemctl", ["restart", "avahi-daemon"], { timeout: 12000, stdio: "ignore" });
    spawnSync("sleep", ["2"], { timeout: 3000 }); // let avahi come back up
    console.log("[relay] avahi-daemon restarted — Avahi slate is clean");
  } catch (e) {
    console.warn("[relay] could not restart avahi-daemon:", e.message);
  }
}

// Load the snd-aloop kernel module and confirm the loopback card is present.
// Returns the card identifier string (e.g. "Loopback" or "0") or null.
function setupAlsaLoopback() {
  // Load module — no-op if already loaded; might require root
  try {
    execFileSync("modprobe", ["snd-aloop", "pcm_substreams=1"],
      { timeout: 8000, stdio: "ignore" });
    console.log("[relay] snd-aloop module loaded");
  } catch (e) {
    console.warn("[relay] modprobe snd-aloop:", e.message);
  }

  // Find the loopback card in aplay -l output
  try {
    const r = spawnSync("aplay", ["-l"], { timeout: 5000, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const m = /card\s+(\d+)[^\n]*Loopback/i.exec(out);
    if (m) {
      console.log(`[relay] ALSA loopback found at card ${m[1]}`);
      return m[1]; // card number as string
    }
    if (/Loopback/i.test(out)) return "Loopback"; // try by name
  } catch (e) {
    console.warn("[relay] aplay -l:", e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------

class ZoneRelay extends EventEmitter {
  constructor(zoneId, zoneName, appPort, debug) {
    super();
    this.zoneId   = zoneId;
    this.zoneName = zoneName;
    this.appPort  = appPort;
    this.debug    = !!debug;

    this.state        = "stopped";
    this.error        = null;
    this.currentTrack = null;

    this._proc          = null;  // librespot process
    this._capture       = null;  // arecord process (alsa mode only)
    this._localIP       = null;
    this._clients       = new Set();
    this._pcmChunks     = [];
    this._pcmBufferSize = 0;
    this._sessionId     = null;
    this._audioinput    = null;
    this._eventScript   = null;
    this._audioStarted  = false;
    this._pendingTrack  = null;
    this._backendMode   = null;  // "pipe" | "alsa"

    // Diagnostics
    this.bytesReceived = 0;
    this.clientsEver   = 0;
  }

  get mediaUrl() {
    return `http://${this._localIP}:${this.appPort}/relay/audio/${this.zoneId}`;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async start(librespotPath, audioinput) {
    if (this.state !== "stopped") return;
    this.state = "starting";
    this.error = null;
    this._localIP = getLocalIP();
    try {
      this._writeEventScript();
      await this._spawnLibrespot(librespotPath);
      await this._beginSession(audioinput);
      this.state = "active";
      console.log(`[relay:${this.zoneName}] active — backend=${this._backendMode} url=${this.mediaUrl}`);
      this.emit("started");
    } catch (e) {
      this.state = "error";
      this.error = e.message;
      console.error(`[relay:${this.zoneName}] start failed: ${e.message}`);
      await this._cleanup();
      this.emit("error", e);
    }
  }

  async stop() {
    this.state = "stopped";
    this.error = null;
    await this._cleanup();
    this.emit("stopped");
  }

  // Called by Express GET /relay/audio/:zoneId
  streamToClient(req, res) {
    this.clientsEver++;
    console.log(`[relay:${this.zoneName}] Roon audio client #${this.clientsEver} connected from ${req.socket.remoteAddress}`);
    res.writeHead(200, {
      "Content-Type":      "audio/wav",
      "Transfer-Encoding": "chunked",
      "Cache-Control":     "no-cache, no-store",
      "Connection":        "keep-alive",
      "X-Relay-Zone":      this.zoneName
    });
    res.write(makeWavHeader());
    for (const c of this._pcmChunks) { try { res.write(c); } catch {} }
    console.log(`[relay:${this.zoneName}] sent ${Math.round(this._pcmBufferSize / BYTES_PER_SEC * 1000)}ms buffered PCM to client`);
    this._clients.add(res);
    const done = () => this._clients.delete(res);
    req.on("close", done); req.on("aborted", done); res.on("error", done);
  }

  // Called when librespot fires --onevent
  handleEvent(evt) {
    this.currentTrack = evt;
    this.emit("event", evt);
    const { event, name, artists, album, track_id, cover_url, position_ms } = evt;
    console.log(`[relay:${this.zoneName}] librespot event: ${event} — "${name || "?"}"`);
    const isPlay = event === "playing" || event === "start" ||
                   event === "changed" || event === "change";
    if (!isPlay) return;
    const info = { track_id, name: name || "Spotify", artists: artists || "",
                   album: album || "", cover_url: cover_url || null,
                   position_ms: parseInt(position_ms, 10) || 0 };
    if (this._audioStarted) this._callPlay(info);
    else this._pendingTrack = info;
  }

  toJSON() {
    return {
      zone_id:        this.zoneId,
      zone_name:      this.zoneName,
      state:          this.state,
      error:          this.error,
      backend:        this._backendMode,
      current_track:  this.currentTrack,
      media_url:      this._localIP ? this.mediaUrl : null,
      bytes_received: this.bytesReceived,
      clients_ever:   this.clientsEver,
      active_clients: this._clients.size
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _callPlay({ track_id, name, artists, album, cover_url, position_ms }) {
    if (!this._audioinput || !this._sessionId) return;
    this._audioinput.play({
      session_id:       this._sessionId,
      track_id:         track_id || `relay-${Date.now()}`,
      type:             "track",
      slot:             "play",
      media_url:        this.mediaUrl,
      seek_position_ms: position_ms || 0,
      info: {
        one_line:   { line1: [name, artists].filter(Boolean).join(" — ") || "Spotify" },
        two_line:   { line1: name || "Spotify", line2: artists || "" },
        three_line: { line1: name || "Spotify", line2: artists || "", line3: album || "" },
        image_url:        cover_url || null,
        is_seek_allowed:  false,
        is_pause_allowed: true
      }
    }, () => {});
  }

  _onFirstAudio() {
    if (this._audioStarted) return;
    this._audioStarted = true;
    const info = this._pendingTrack || {
      track_id: `relay-${Date.now()}`, name: "Spotify",
      artists: this.zoneName, album: "", cover_url: null, position_ms: 0
    };
    this._pendingTrack = null;
    this._callPlay(info);
    console.log(`[relay:${this.zoneName}] first PCM — play() sent to Roon (${this.mediaUrl})`);
  }

  _onPcmChunk(chunk) {
    this.bytesReceived += chunk.length;
    this._pcmChunks.push(chunk);
    this._pcmBufferSize += chunk.length;
    while (this._pcmBufferSize > MAX_BUFFER_BYTES) {
      const d = this._pcmChunks.shift();
      this._pcmBufferSize -= d.length;
    }
    this._onFirstAudio();
    for (const c of this._clients) {
      try { c.write(chunk); } catch { this._clients.delete(c); }
    }
  }

  _writeEventScript() {
    const tmp = path.join(os.tmpdir(), `rra-relay-${this.zoneId.slice(0, 8)}.sh`);
    const zid = this.zoneId.replace(/"/g, "");
    fs.writeFileSync(tmp,
      `#!/bin/sh\n` +
      `P='{"zone_id":"${zid}","event":"'$PLAYER_EVENT'","track_id":"'$TRACK_ID'",` +
      `"name":"'$NAME'","artists":"'$ARTISTS'","album":"'$ALBUM'",` +
      `"cover_url":"'$COVER_URL'","duration_ms":"'$DURATION_MS'","position_ms":"'$POSITION_MS'"}'\n` +
      `U="http://127.0.0.1:${this.appPort}/internal/relay-event"\n` +
      `if command -v curl >/dev/null 2>&1; then\n` +
      `  curl -s -X POST "$U" -H "Content-Type: application/json" -d "$P" &\n` +
      `elif command -v wget >/dev/null 2>&1; then\n` +
      `  wget -q -O /dev/null --post-data="$P" --header="Content-Type: application/json" "$U" &\n` +
      `fi\n`,
      { mode: 0o755 }
    );
    this._eventScript = tmp;
  }

  _librespotArgs(extraArgs) {
    return [
      "--name",     `Roon: ${this.zoneName}`,
      "--bitrate",  "320",
      "--initial-volume", "100",
      "--enable-volume-normalisation",
      "--onevent",  this._eventScript,
      ...extraArgs
    ];
  }

  _spawnLibrespot(librespotPath) {
    // Detect which backend to use
    const hasPipe = librespotHasPipe(librespotPath);
    console.log(`[relay:${this.zoneName}] librespot pipe backend: ${hasPipe ? "YES" : "NO"}`);

    if (hasPipe) {
      this._backendMode = "pipe";
      return this._spawnPipe(librespotPath);
    }

    // Pipe not available — set up ALSA loopback
    const card = setupAlsaLoopback();
    if (card === null) {
      return Promise.reject(new Error(
        "librespot pipe backend unavailable and ALSA loopback setup failed. " +
        "Install alsa-utils: apt-get install alsa-utils"
      ));
    }
    this._backendMode = "alsa";
    return this._spawnAlsa(librespotPath, card);
  }

  // ── Pipe backend ──────────────────────────────────────────────────────────

  _spawnPipe(librespotPath) {
    return new Promise((resolve, reject) => {
      killConflictingLibrespot();
      const args = this._librespotArgs(["--backend", "pipe"]);
      console.log(`[relay:${this.zoneName}] spawn (pipe): ${librespotPath} ${args.join(" ")}`);
      this._proc = spawn(librespotPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      this._proc.stdout.on("data", (chunk) => this._onPcmChunk(chunk));

      let ready = false;
      this._proc.stderr.on("data", (buf) => {
        const txt = buf.toString().trim();
        if (txt) console.log(`[librespot:${this.zoneName}] ${txt}`);
        if (!ready && /Registered|Zeroconf|discovery|Listening|Session|librespot v/i.test(txt)) {
          ready = true; resolve();
        }
      });
      this._proc.on("error", (e) => { if (!ready) { ready = true; reject(e); } });
      this._proc.on("exit",  (c, s) => {
        console.log(`[librespot:${this.zoneName}] exit code=${c} signal=${s}`);
        if (!ready) { ready = true; resolve(); }
        this._endAllClients();
        if (this.state === "active") { this.state = "stopped"; this.emit("stopped"); }
      });
      setTimeout(() => { if (!ready) { ready = true; resolve(); } }, 8000);
    });
  }

  // ── ALSA loopback backend ─────────────────────────────────────────────────

  _spawnAlsa(librespotPath, card) {
    return new Promise((resolve, reject) => {
      killConflictingLibrespot();
      // Device names for snd-aloop:
      //   hw:{card},0  = playback (librespot writes here)
      //   hw:{card},1  = capture  (we read from here)
      const playDev    = `hw:${card},0`;
      const captureDev = `hw:${card},1`;

      const args = this._librespotArgs(["--backend", "alsa", "--device", playDev]);
      console.log(`[relay:${this.zoneName}] spawn (alsa loopback): ${librespotPath} ${args.join(" ")}`);
      this._proc = spawn(librespotPath, args, { stdio: ["ignore", "ignore", "pipe"] });

      let ready = false;
      this._proc.stderr.on("data", (buf) => {
        const txt = buf.toString().trim();
        if (txt) console.log(`[librespot:${this.zoneName}] ${txt}`);
        if (!ready && /Registered|Zeroconf|discovery|Listening|Session|librespot v/i.test(txt)) {
          // librespot ready — now start the capture process
          ready = true;
          this._startAlsaCapture(captureDev, resolve, reject);
        }
      });
      this._proc.on("error", (e) => { if (!ready) { ready = true; reject(e); } });
      this._proc.on("exit",  (c, s) => {
        console.log(`[librespot:${this.zoneName}] exit code=${c} signal=${s}`);
        if (!ready) { ready = true; resolve(); }
        // Kill arecord when librespot dies — no point capturing silence
        if (this._capture) { try { this._capture.kill("SIGTERM"); } catch {} this._capture = null; }
        this._endAllClients();
        if (this.state === "active") { this.state = "stopped"; this.emit("stopped"); }
      });
      setTimeout(() => {
        if (!ready) {
          ready = true;
          this._startAlsaCapture(captureDev, resolve, reject);
        }
      }, 8000);
    });
  }

  _startAlsaCapture(captureDev, resolve, reject) {
    console.log(`[relay:${this.zoneName}] starting arecord on ${captureDev}`);
    this._capture = spawn("arecord", [
      "-D", captureDev,
      "-f", "S16_LE",
      "-r", "44100",
      "-c", "2",
      "-t", "raw",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    this._capture.stdout.on("data", (chunk) => this._onPcmChunk(chunk));

    this._capture.stderr.on("data", (buf) => {
      const txt = buf.toString().trim();
      if (txt) console.log(`[arecord:${this.zoneName}] ${txt}`);
    });

    this._capture.on("error", (e) => {
      const msg = `arecord failed: ${e.message} — install alsa-utils: apt-get install alsa-utils`;
      if (reject) { reject(new Error(msg)); reject = null; resolve = null; }
      else { this.state = "error"; this.error = msg; this.emit("error", new Error(msg)); }
    });

    this._capture.on("exit", (c, s) => {
      console.log(`[arecord:${this.zoneName}] exit code=${c} signal=${s}`);
      this._endAllClients();
      if (this.state === "active") { this.state = "stopped"; this.emit("stopped"); }
    });

    if (resolve) { resolve(); resolve = null; }
  }

  // ── Session ───────────────────────────────────────────────────────────────

  _beginSession(audioinput) {
    this._audioinput = audioinput;
    return new Promise((resolve, reject) => {
      console.log(`[relay:${this.zoneName}] begin_session for zone ${this.zoneId}`);
      audioinput.begin_session({
        zone_id:      this.zoneId,
        display_name: "Spotify",
        icon_url:     "https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png"
      }, (msg, body) => {
        console.log(`[relay:${this.zoneName}] AudioInput: ${msg}`, body ? JSON.stringify(body) : "");
        if (msg === "SessionBegan") {
          this._sessionId = body.session_id;
          audioinput.update_transport_controls({
            session_id: body.session_id,
            controls:   { is_previous_allowed: false, is_next_allowed: false }
          }, () => {});
          resolve();
        } else if (msg === "ZoneNotFound") {
          reject(new Error(`Zone not found: ${this.zoneId}`));
        } else if (msg === "SessionEnded" || msg === "ZoneLost") {
          this._sessionId    = null;
          this._audioStarted = false;
          this.state = "stopped";
          this.emit("stopped");
        }
      });
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  _endAllClients() {
    for (const c of this._clients) { try { c.end(); } catch {} }
    this._clients.clear();
  }

  async _cleanup() {
    if (this._capture) { try { this._capture.kill("SIGTERM"); } catch {} this._capture = null; }
    if (this._proc)    { try { this._proc.kill("SIGTERM"); }    catch {} this._proc    = null; }
    if (this._eventScript) { try { fs.unlinkSync(this._eventScript); } catch {} this._eventScript = null; }
    this._endAllClients();
    this._pcmChunks     = [];
    this._pcmBufferSize = 0;
    this._audioStarted  = false;
    this._pendingTrack  = null;
    this._sessionId     = null;
    this._audioinput    = null;
    this.bytesReceived  = 0;
    this.clientsEver    = 0;
  }
}

module.exports = { ZoneRelay, findLibrespot };
