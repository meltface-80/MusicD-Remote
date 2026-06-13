"use strict";

// ---------------------------------------------------------------------------
// ZoneRelay — makes a Roon zone appear as a Spotify Connect speaker.
//
// Architecture per zone:
//   1. Spawn librespot with --backend pipe → librespot registers as a
//      Spotify Connect device on the LAN and outputs raw PCM to stdout.
//   2. Internal HTTP server receives PCM from librespot stdout and streams
//      it as audio/wav (with a streaming WAV header) to any HTTP clients.
//   3. Roon AudioInput session: begin_session() binds us to the zone;
//      play() hands Roon the media_url so it pulls from our HTTP server.
//      play() is called immediately on session begin so Roon starts pulling
//      the stream right away — not just when the first onevent fires.
//   4. librespot --onevent fires a script that POSTs track metadata to
//      our internal endpoint so we can update Roon's now-playing display.
// ---------------------------------------------------------------------------

const { spawn, execFileSync } = require("child_process");
const http   = require("http");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { EventEmitter } = require("events");

// WAV header for a streaming raw-PCM feed.
// librespot --backend pipe outputs S16LE, 44100 Hz, stereo.
function makeWavHeader() {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 4);    // streaming: size unknown
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);            // subchunk size (PCM = 16)
  h.writeUInt16LE(1, 20);             // audio format: PCM
  h.writeUInt16LE(2, 22);             // stereo
  h.writeUInt32LE(44100, 24);         // sample rate
  h.writeUInt32LE(176400, 28);        // byte rate (44100 × 2ch × 2B)
  h.writeUInt16LE(4, 32);             // block align (2ch × 2B)
  h.writeUInt16LE(16, 34);            // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(0xFFFFFFFF, 40);   // streaming: data size unknown
  return h;
}

// Locate the librespot binary.  Checks LIBRESPOT_PATH env var, then $PATH
// and common install locations (cargo, homebrew, system packages, raspotify).
function findLibrespot() {
  const candidates = [
    process.env.LIBRESPOT_PATH,
    path.join(os.homedir(), ".cargo", "bin", "librespot"),
    "/opt/homebrew/bin/librespot",
    "/usr/local/bin/librespot",
    "/usr/bin/librespot",
    // raspotify installs here on DietPi / Debian
    "/usr/bin/raspotify-librespot",
    "/var/lib/raspotify/librespot",
    path.join(__dirname, "..", "bin", "librespot"),
  ].filter(Boolean);

  for (const p of candidates) {
    try { execFileSync(p, ["--version"], { stdio: "ignore", timeout: 3000 }); return p; } catch {}
  }
  // Last resort: rely on PATH
  try { execFileSync("librespot", ["--version"], { stdio: "ignore", timeout: 3000 }); return "librespot"; } catch {}
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

    this.state        = "stopped";   // stopped | starting | active | error
    this.error        = null;
    this.currentTrack = null;

    this._proc        = null;
    this._srv         = null;
    this._port        = null;
    this._clients     = new Set();
    this._sessionId   = null;
    this._audioinput  = null;
    this._eventScript = null;
  }

  get mediaUrl() {
    return `http://127.0.0.1:${this._port}/audio`;
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async start(librespotPath, audioinput) {
    if (this.state !== "stopped") return;
    this.state = "starting";
    this.error = null;
    try {
      await this._startAudioServer();
      this._writeEventScript();
      await this._spawnLibrespot(librespotPath);
      await this._beginSession(audioinput);
      this.state = "active";
      this.emit("started");
    } catch (e) {
      this.state = "error";
      this.error = e.message;
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

  // Called by the extension when librespot fires an --onevent callback.
  // librespot 0.8.0 event names: playing, paused, stopped, changed, end_of_track
  handleEvent(evt) {
    this.currentTrack = evt;
    this.emit("event", evt);

    if (!this._audioinput || !this._sessionId) return;
    const { event, name, artists, album, track_id, cover_url, position_ms } = evt;

    // "playing" = track started/resumed; "changed" = new track queued
    // Also accept legacy names: "start", "change" (older librespot)
    const isPlay = event === "playing" || event === "start" ||
                   event === "changed" || event === "change";
    if (!isPlay) return;

    this._callPlay({
      track_id,
      name:        name      || "Spotify",
      artists:     artists   || "",
      album:       album     || "",
      cover_url:   cover_url || null,
      position_ms: parseInt(position_ms, 10) || 0
    });
  }

  toJSON() {
    return {
      zone_id:       this.zoneId,
      zone_name:     this.zoneName,
      state:         this.state,
      error:         this.error,
      current_track: this.currentTrack,
      media_url:     this._port ? this.mediaUrl : null
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  // Central play() call — called both on session begin and on every track event.
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

  _startAudioServer() {
    return new Promise((resolve, reject) => {
      this._srv = http.createServer((req, res) => {
        if (!req.url.startsWith("/audio")) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {
          "Content-Type":      "audio/wav",
          "Transfer-Encoding": "chunked",
          "Cache-Control":     "no-cache, no-store",
          "Connection":        "keep-alive"
        });
        res.write(makeWavHeader());
        this._clients.add(res);
        req.on("close",   () => this._clients.delete(res));
        req.on("aborted", () => this._clients.delete(res));
      });
      this._srv.listen(0, "127.0.0.1", () => {
        this._port = this._srv.address().port;
        resolve();
      });
      this._srv.once("error", reject);
    });
  }

  _writeEventScript() {
    const tmp = path.join(os.tmpdir(),
      `rra-relay-${this.zoneId.slice(0, 8)}.sh`);
    const zid = this.zoneId.replace(/"/g, "");
    // Use curl if available, fall back to wget.
    // The script is called by librespot with event env-vars set.
    fs.writeFileSync(tmp,
      `#!/bin/sh\n` +
      `PAYLOAD="{\\"zone_id\\":\\"${zid}\\",\\"event\\":\\"$PLAYER_EVENT\\",` +
      `\\"track_id\\":\\"$TRACK_ID\\",\\"name\\":\\"$NAME\\",` +
      `\\"artists\\":\\"$ARTISTS\\",\\"album\\":\\"$ALBUM\\",` +
      `\\"cover_url\\":\\"$COVER_URL\\",\\"duration_ms\\":\\"$DURATION_MS\\",` +
      `\\"position_ms\\":\\"$POSITION_MS\\"}"\n` +
      `URL="http://127.0.0.1:${this.appPort}/internal/relay-event"\n` +
      `if command -v curl >/dev/null 2>&1; then\n` +
      `  curl -s -X POST "$URL" -H "Content-Type: application/json" -d "$PAYLOAD" &\n` +
      `elif command -v wget >/dev/null 2>&1; then\n` +
      `  wget -q -O /dev/null --post-data="$PAYLOAD" --header="Content-Type: application/json" "$URL" &\n` +
      `fi\n`,
      { mode: 0o755 }
    );
    this._eventScript = tmp;
  }

  _spawnLibrespot(librespotPath) {
    return new Promise((resolve, reject) => {
      const args = [
        "--name",     `Roon: ${this.zoneName}`,
        "--bitrate",  "320",
        "--backend",  "pipe",
        "--initial-volume", "100",
        "--enable-volume-normalisation",
        "--onevent",  this._eventScript,
      ];

      this._proc = spawn(librespotPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      // Raw PCM → broadcast to all Roon HTTP clients
      this._proc.stdout.on("data", (chunk) => {
        for (const c of this._clients) {
          try { c.write(chunk); } catch { this._clients.delete(c); }
        }
      });

      // Parse stderr for startup confirmation
      let ready = false;
      this._proc.stderr.on("data", (buf) => {
        const txt = buf.toString();
        if (this.debug) process.stderr.write(`[relay:${this.zoneName}] ${txt}`);
        if (!ready && (
          txt.includes("Registered device")         ||
          txt.includes("registered device")         ||
          txt.includes("Using Zeroconf")             ||
          txt.includes("discovery")                  ||
          txt.includes("Listening on")               ||
          txt.includes("librespot")                  ||
          txt.includes("Session connected")          ||
          txt.includes("Session::connect")
        )) {
          ready = true;
          resolve();
        }
      });

      this._proc.on("error", (e) => {
        if (!ready) { ready = true; reject(e); }
        else { this.state = "error"; this.error = e.message; this.emit("error", e); }
      });

      this._proc.on("exit", (code) => {
        if (!ready) { ready = true; resolve(); }
        for (const c of this._clients) { try { c.end(); } catch {} }
        this._clients.clear();
        if (this.state === "active") {
          this.state = "stopped";
          this.emit("stopped");
        }
      });

      // Fallback: resolve after 8 s even if we miss the log message
      setTimeout(() => { if (!ready) { ready = true; resolve(); } }, 8000);
    });
  }

  _beginSession(audioinput) {
    this._audioinput = audioinput;
    return new Promise((resolve, reject) => {
      audioinput.begin_session({
        zone_id:      this.zoneId,
        display_name: "Spotify",
        icon_url:     "https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png"
      }, (msg, body) => {
        if (msg === "SessionBegan") {
          this._sessionId = body.session_id;
          audioinput.update_transport_controls({
            session_id: body.session_id,
            controls:   { is_previous_allowed: false, is_next_allowed: false }
          }, () => {});

          // Call play() immediately so Roon starts pulling the audio stream
          // before any track-change events arrive from librespot --onevent.
          this._callPlay({
            track_id:    `relay-init-${Date.now()}`,
            name:        "Spotify Connect",
            artists:     this.zoneName,
            album:       "",
            cover_url:   null,
            position_ms: 0
          });

          resolve();
        } else if (msg === "ZoneNotFound") {
          reject(new Error(`Zone not found: ${this.zoneId}`));
        } else if (msg === "SessionEnded" || msg === "ZoneLost") {
          this._sessionId = null;
          this.state = "stopped";
          this.emit("stopped");
        }
      });
    });
  }

  async _cleanup() {
    if (this._proc) {
      try { this._proc.kill("SIGTERM"); } catch {}
      this._proc = null;
    }
    if (this._srv) {
      this._srv.close();
      this._srv = null;
    }
    if (this._eventScript) {
      try { fs.unlinkSync(this._eventScript); } catch {}
      this._eventScript = null;
    }
    for (const c of this._clients) { try { c.end(); } catch {} }
    this._clients.clear();
    this._sessionId  = null;
    this._audioinput = null;
    this._port       = null;
  }
}

module.exports = { ZoneRelay, findLibrespot };
