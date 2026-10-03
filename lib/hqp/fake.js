"use strict";
// ---------------------------------------------------------------------------
// A FAKE HQPlayer: a TCP server that answers HQPlayer's control protocol the
// way the real one was measured to (on 2026-10-02, HQPlayer Desktop 5.32.5 on
// macOS and 5.35.10 on Linux). The test suite drives the controller against
// it, and Settings → HQPlayer → Demo HQPlayer runs one inside the extension so
// the screen can be tried with no HQPlayer at all. It makes no sound.
//
// Ported from hqpweb (packages/fake-hqp/src/{fake,profile}.ts and its two
// profiles), MIT, (c) 2026 statelycurmudgeon — see ./LICENSE. Where nothing
// was measured, hqpweb picked the LEAST convenient plausible behaviour and
// said so in an "Inferred:" comment, so client code that copes with the fake
// should cope with the real thing; those comments are kept. Not ported:
// HQPlayer's own library and playlist (hqpweb parks them too) and the
// discovery responder (discovery is not part of this release).
//
// It never listens on 4321, the real HQPlayer port: a fake there could be
// mistaken for the real thing, or the real thing for the fake.
// ---------------------------------------------------------------------------

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { element, parseDocument } = require("./xml");
const { filterSlot, predictedStop } = require("./compat");

const PROFILE_IDS = ["desktop5-mac-sdm", "desktop5-linux-pcm"];
const REAL_HQPLAYER_PORT = 4321;

function loadProfile(id) {
  if (!PROFILE_IDS.includes(id)) throw new Error("unknown fake HQPlayer profile " + id);
  return JSON.parse(fs.readFileSync(path.join(__dirname, "profiles", id + ".json"), "utf8"));
}

/**
 * Default: what the manual's rules predict (integer-ratio filters, the AHM
 * modulator floor; see compat.js). The AHM floor is also measured.
 */
const defaultIncompatible = (c) =>
  predictedStop({ mode: c.modeName, filter: c.filterName, shaper: c.shaperName, sourceRate: c.sourceRate, outputRate: c.rateHz }) !== undefined;

const DELAY = {
  filterPrepare: 5000,   // the first SetFilter for a filter: ~5 s (measured)
  filterQuick: 300,      // later SetFilters: ~0.3 s (measured)
  mode: 2900,            // SetMode: ~2.9 s (measured)
  stopRequested: 500,    // state 3 is "seen briefly" before 0 after a bad rate (measured; the duration inferred)
  resume: 1000,          // Inferred: the resume delay once a valid rate is set again
  firstRequest: 265,     // the first request on a new connection: 265 ms locally, 606 ms across VLANs (measured)
};

class FakeHqp {
  /**
   * @param {object} profile  from loadProfile()
   * @param {{timeScale?: number, idleTimeoutMs?: number, incompatible?: Function,
   *          speed?: Function, matrixProfiles?: string[], convolutionConfigured?: boolean,
   *          log?: Function, record?: boolean}} [opts]
   *   timeScale multiplies every measured delay: 1 is realistic, 0 instant (tests).
   *   speed(c) is the simulated load — playback speed for the settings in use,
   *   1 = real time. Inferred model: an overloaded HQPlayer keeps state 2 but
   *   its position falls behind real time. Not yet measured.
   */
  constructor(profile, opts) {
    const o = opts || {};
    this.profile = profile;
    this.opts = {
      timeScale: o.timeScale !== undefined ? o.timeScale : 1,
      idleTimeoutMs: o.idleTimeoutMs || 156000,
      incompatible: o.incompatible || defaultIncompatible,
      speed: o.speed || (() => 1),
      // Measured on both instances: none of either.
      matrixProfiles: o.matrixProfiles || [],
      convolutionConfigured: !!o.convolutionConfigured,
      log: o.log,
      // Keep every request in `received`. Tests read it; the Demo HQPlayer
      // switches it off, because it runs for as long as the extension does
      // and a list of every status poll would grow for as long as that.
      record: o.record !== false,
    };
    const i = profile.initial;
    this.modeIndex = Number(i.mode);
    this.remembered = new Map();
    for (const [mv, r] of Object.entries(profile.remembered)) this.remembered.set(Number(mv), Object.assign({}, r));
    this.rateIndex = Number(i.rate);        // index into the current mode's rate list; 0 is auto
    this.volume = Number(i.volume);
    this.invert = i.invert === "1";
    this.filter20k = i.filter_20k === "1";
    this.adaptive = i.adaptive === "1";
    this.playback = Number(i.state);        // 0 stopped, 1 paused, 2 playing, 3 stop requested
    this.stalled = false;                   // stopped by an incompatible combination; resumes once valid
    this.position = 0;
    this.convolution = false;
    this.matrixProfile = "";
    this.sourceRate = 44100;                // the track's own rate; see setSource()
    this.prepared = new Set();
    this.lastTick = Date.now();
    this.timers = new Set();
    // Fault injection: commands named here reply OK and change nothing, which
    // is how a no-op looks on the real thing. For testing the read-back.
    this.ignore = new Set();
    // Fault injection: the next N requests are answered by closing the
    // connection instead — how HQPlayer's own idle close looks when it crosses
    // a request already on its way. For testing the client's one retry.
    this.dropNext = 0;
    this.received = [];                     // every request, for tests (opts.record)
    this.server = null;
    this.sockets = new Set();
    this.connections = 0;
  }

  /** Simulate the app feeding HQPlayer (Roon) switching to a track at this rate. */
  setSource(rateHz) {
    this.sourceRate = rateHz;
  }

  // ---- derived state ---------------------------------------------------------
  get mode() {
    const m = this.profile.modes.find((x) => x.index === this.modeIndex);
    if (!m) throw new Error("bad mode index " + this.modeIndex);
    return m;
  }
  get modeValue() { return this.mode.value; }
  /** Inferred: [source] mode (-1) uses the PCM lists. Not measured. */
  get lists() {
    const l = this.profile.lists[String(this.modeValue)] || this.profile.lists["0"];
    if (!l) throw new Error("profile " + this.profile.id + " has no lists for mode " + this.modeValue);
    return l;
  }
  get rem() {
    let r = this.remembered.get(this.modeValue);
    if (!r) {
      // Inferred: an unvisited mode starts on the first entry of each list.
      const first = this.lists.filters[0] ? this.lists.filters[0].index : 0;
      r = { filterNx: first, filter1x: first, shaper: 0 };
      this.remembered.set(this.modeValue, r);
    }
    return r;
  }
  get activeRateHz() {
    // Inferred: [source] mode plays at the source's own rate — that is what
    // the mode is (and why SetRate is ignored in it). Not measured.
    if (this.modeValue === -1) return this.sourceRate;
    const set = this.lists.rates[this.rateIndex] || 0;
    if (set !== 0) return set;
    const auto = this.profile.activeRateWhenAuto[String(this.modeValue)];
    return auto !== undefined ? auto : Math.max.apply(null, this.lists.rates);
  }
  get shaperName() {
    const s = this.lists.shapers.find((x) => x.index === this.rem.shaper);
    return s ? s.name : "";
  }
  /**
   * 1x below a 50 kHz source, Nx above (manual §4.6; measured at 44.1k and
   * 96k). Inferred: an idle HQPlayer reports 1x (matches the idle Linux capture).
   */
  get filterInUse() {
    const active = this.playback !== 0 || this.stalled;
    return active && filterSlot(this.sourceRate) === "Nx" ? this.rem.filterNx : this.rem.filter1x;
  }
  filterName(i) {
    const f = this.lists.filters.find((x) => x.index === i);
    return f ? f.name : "";
  }
  get comboBad() {
    return this.opts.incompatible({
      modeName: this.mode.name,
      rateHz: this.activeRateHz,
      shaperName: this.shaperName,
      filterName: this.filterName(this.filterInUse),
      sourceRate: this.sourceRate,
    });
  }

  fmtVolume(v) {
    // Measured: macOS prints "-22", Linux "-28.00000000000000000".
    return this.profile.volumeFormat === "long" ? v.toFixed(17) : String(v);
  }

  tick() {
    const now = Date.now();
    if (this.playback === 2) {
      const speed = this.opts.speed({ modeName: this.mode.name, rateHz: this.activeRateHz,
                                      filterName: this.filterName(this.filterInUse), shaperName: this.shaperName });
      this.position += ((now - this.lastTick) / 1000) * speed;
    }
    this.lastTick = now;
  }

  // ---- timing ------------------------------------------------------------------
  sleep(ms) {
    const d = ms * this.opts.timeScale;
    return d <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, d));
  }
  later(ms, fn) {
    const d = ms * this.opts.timeScale;
    if (d <= 0) { fn(); return; }
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, d);
    this.timers.add(t);
  }

  /** The measured stall/resume rule, after anything that changes mode, rate, filter or shaper. */
  checkCombo() {
    if (this.comboBad && this.playback === 2) {
      this.stalled = true;
      this.playback = 3;
      this.later(DELAY.stopRequested, () => { if (this.playback === 3) this.playback = 0; });
    } else if (!this.comboBad && this.stalled) {
      this.stalled = false;
      this.later(DELAY.resume, () => { if (this.playback === 0 || this.playback === 3) this.playback = 2; });
    }
  }

  // ---- protocol ----------------------------------------------------------------
  /** Handle one request document; returns the reply without its trailing newline. */
  async handle(requestXml) {
    if (this.opts.record) this.received.push(requestXml);
    this.tick();
    let req;
    try {
      req = parseDocument(requestXml);
    } catch (e) {
      // Inferred: malformed XML is not measured. A generic error.
      return this.doc("Error", { result: "Error" }, "parse error");
    }
    if (this.ignore.has(req.name)) return this.ok(req.name);
    const h = Object.prototype.hasOwnProperty.call(this.handlers, req.name) ? this.handlers[req.name] : null;
    const out = h ? await h.call(this, req) : this.doc(req.name, { result: "Error" }, "Unknown command");
    if (this.opts.log) {
      const strip = (x) => x.replace(/^<\?xml[^>]*\?>/, "");
      this.opts.log(strip(requestXml) + " -> " + (out.length > 160 ? out.slice(0, 160) + "…" : strip(out)));
    }
    return out;
  }

  doc(name, attrs, text, children) {
    const head = '<?xml version="1.0" encoding="utf-8"?>';
    if (children) return head + element(name, attrs || {}).replace(/\/>$/, ">") + children + "</" + name + ">";
    return head + element(name, attrs || {}, text);
  }
  ok(name, extra) {
    return this.doc(name, Object.assign({ result: "OK" }, extra || {}));
  }
  intArg(req, key) {
    const v = req.attrs[key || "value"];
    if (v === undefined || !/^\d+$/.test(v)) return null;
    return Number(v);
  }

  // ---- network -------------------------------------------------------------------
  /** The bound TCP port, once listening. */
  get port() {
    const a = this.server && this.server.address();
    if (!a || typeof a !== "object") throw new Error("not listening");
    return a.port;
  }

  /** Listen for control connections: loopback, on a port of the system's choosing, by default. */
  listen(port, host) {
    const p = port || 0;
    const h = host || "127.0.0.1";
    if (p === REAL_HQPLAYER_PORT) return Promise.reject(new Error("refusing to listen on 4321: that is the real HQPlayer port"));
    const server = net.createServer((sock) => this.serve(sock));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, h, () => {
        const a = server.address();
        resolve({ host: h, port: typeof a === "object" && a ? a.port : p });
      });
    });
  }

  serve(sock) {
    this.connections++;
    this.sockets.add(sock);
    let first = true;
    sock.setEncoding("utf8");
    sock.setTimeout(this.opts.idleTimeoutMs, () => sock.destroy());
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = "";
    let chain = Promise.resolve();
    sock.on("data", (d) => {
      buf += d;
      let nl;
      // Inferred: requests are framed by newline, as clients send them;
      // several per connection are allowed and answered in order.
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (this.dropNext > 0) {
          this.dropNext--;
          sock.destroy();
          return;
        }
        chain = chain.then(async () => {
          if (first) {
            first = false;
            await this.sleep(DELAY.firstRequest);
          }
          const reply = await this.handle(line);
          if (!sock.destroyed) sock.write(reply + "\n");
        }).catch((e) => {
          // A handler that throws is a bug in the fake; the connection is dropped
          // as the real thing would drop one it could not answer.
          if (this.opts.log) this.opts.log("fake HQPlayer handler failed: " + e.message);
          sock.destroy();
        });
      }
    });
  }

  async close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sockets) s.destroy();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((r) => server.close(() => r()));
    }
  }
}

FakeHqp.prototype.handlers = {
  GetInfo() { return this.doc("GetInfo", Object.assign({}, this.profile.info)); },

  State() {
    return this.doc("State", {
      active_mode: this.modeValue,
      active_rate: this.activeRateHz,
      adaptive: this.adaptive,
      convolution: this.convolution,
      filter: this.filterInUse,
      filter1x: this.rem.filter1x,
      filterNx: this.rem.filterNx,
      filter_20k: this.filter20k,
      invert: this.invert,
      matrix_profile: this.matrixProfile,
      mode: this.modeIndex,
      random: 0,
      rate: this.rateIndex,
      repeat: 0,
      shaper: this.rem.shaper,
      state: this.playback,
      volume: this.fmtVolume(this.volume),
    });
  },

  Status() {
    const pos = this.profile.volumeFormat === "long" ? this.position.toFixed(17) : String(this.position);
    const playing = this.playback !== 0 || this.stalled;
    // Real replies carry a <metadata> child while playing (measured); its stream
    // URI is left out. song is "Roon" because Roon is what feeds it here.
    const meta = playing ? element("metadata", { bits: 24, channels: 2, samplerate: this.sourceRate, sdm: 0, song: "Roon" }) : "";
    return this.doc("Status", {
      active_bits: this.modeValue === 1 ? 1 : 32,
      active_channels: 2,
      active_filter: this.filterName(this.filterInUse),
      active_mode: this.mode.name,
      active_rate: this.activeRateHz,
      active_shaper: this.shaperName,
      clips: 0,
      filter_20k: this.filter20k,
      // Real replies: the track length for files, 0 for a Roon stream (measured).
      length: 0,
      position: pos,
      state: this.playback,
      track: playing ? 1 : 0,
      tracks_total: playing ? 1 : 0,
      volume: this.fmtVolume(this.volume),
    }, undefined, meta);
  },

  GetModes() {
    return this.doc("GetModes", {}, undefined, this.profile.modes.map((m) => element("ModesItem", Object.assign({}, m))).join(""));
  },
  GetFilters() {
    return this.doc("GetFilters", {}, undefined,
      this.lists.filters.map((f) => element("FiltersItem", { arg: f.arg, index: f.index, name: f.name, value: f.value })).join(""));
  },
  GetShapers() {
    return this.doc("GetShapers", {}, undefined, this.lists.shapers.map((s) => element("ShapersItem", Object.assign({}, s))).join(""));
  },
  GetRates() {
    return this.doc("GetRates", {}, undefined, this.lists.rates.map((rate, index) => element("RatesItem", { index, rate })).join(""));
  },
  VolumeRange() {
    const r = this.profile.volumeRange;
    return this.doc("VolumeRange", { adaptive: r.adaptive, enabled: r.enabled, max: this.fmtVolume(r.max), min: this.fmtVolume(r.min) });
  },

  // Measured: blocked by SessionAuthentication. Never emulate success.
  ConfigurationLoad() { return this.doc("ConfigurationLoad", { result: "Error" }, "missing data or not authorized"); },
  MatrixListProfiles() {
    return this.doc("MatrixListProfiles", { result: "OK" }, undefined,
      this.opts.matrixProfiles.map((name) => element("MatrixProfile", { name })).join(""));
  },
  MatrixGetProfile() { return this.ok("MatrixGetProfile", { value: this.matrixProfile }); },
  // Reported (HQPTuner): any name gets OK and State echoes it, even unknown ones.
  MatrixSetProfile(req) {
    this.matrixProfile = req.attrs.value || "";
    return this.ok("MatrixSetProfile");
  },

  async SetMode(req) {
    const i = this.intArg(req);
    // Inferred: an out-of-range index replies OK and changes nothing. Not
    // measured; chosen because it punishes clients that trust OK.
    if (i === null || !this.profile.modes.some((m) => m.index === i)) return this.ok("SetMode");
    await this.sleep(DELAY.mode);
    this.tick();
    this.modeIndex = i;
    // Reported by HQPTuner (Embedded 6.0.4): a mode switch clears the rate pin.
    // Unmeasured on Desktop. Modelled as a reset to auto.
    this.rateIndex = 0;
    this.checkCombo();
    return this.ok("SetMode");
  },

  SetRate(req) {
    const i = this.intArg(req);
    if (i !== null && i < this.lists.rates.length) {
      this.rateIndex = i;
      this.checkCombo();
    }
    // Measured: OK even when the combination then stops playback.
    return this.ok("SetRate");
  },

  async SetFilter(req) {
    const nx = this.intArg(req);
    const x1 = this.intArg(req, "value1x");
    const valid = (i) => i !== null && this.lists.filters.some((f) => f.index === i);
    if (!valid(nx)) return this.ok("SetFilter");
    const key = this.modeValue + ":" + nx;
    await this.sleep(this.prepared.has(key) ? DELAY.filterQuick : DELAY.filterPrepare);
    this.prepared.add(key);
    this.rem.filterNx = nx;
    if (valid(x1)) this.rem.filter1x = x1;
    // Filters have ratio rules too (manual §4.6), so a filter change can stall.
    this.checkCombo();
    return this.ok("SetFilter");
  },

  SetShaping(req) {
    const i = this.intArg(req);
    if (i !== null && this.lists.shapers.some((s) => s.index === i)) {
      this.rem.shaper = i;
      // Inferred: a bad shaper for the current rate stalls just like a bad rate.
      this.checkCombo();
    }
    return this.ok("SetShaping");
  },

  SetInvert(req) {
    this.invert = req.attrs.value === "1";
    return this.ok("SetInvert");
  },
  // Measured: these two reply with no result attribute at all.
  Set20kFilter(req) {
    this.filter20k = req.attrs.value === "1";
    return this.doc("Set20kFilter");
  },
  SetAdaptiveVolume(req) {
    this.adaptive = req.attrs.value === "1";
    return this.doc("SetAdaptiveVolume");
  },
  // Measured: with no convolution set up, OK + value="0" and nothing changes.
  // Inferred: when it is set up, it toggles and echoes the new value.
  SetConvolution(req) {
    if (this.opts.convolutionConfigured) this.convolution = req.attrs.value === "1";
    return this.ok("SetConvolution", { value: this.convolution });
  },

  Volume(req) {
    const v = Number(req.attrs.value);
    if (Number.isFinite(v)) {
      // Inferred: clamped to VolumeRange. Not measured.
      const r = this.profile.volumeRange;
      this.volume = Math.min(r.max, Math.max(r.min, v));
    }
    return this.ok("Volume");
  },

  // Measured: nothing restarts a stalled HQPlayer except fixing the rate.
  Play() {
    if (!this.stalled && !this.comboBad) this.playback = 2;
    return this.ok("Play");
  },
  Pause() {
    if (this.playback === 2) this.playback = 1;
    return this.ok("Pause");
  },
  // Inferred: Previous/Next move one track and restart the position.
  Previous() { this.position = 0; return this.ok("Previous"); },
  Next() { this.position = 0; return this.ok("Next"); },
  Stop() {
    // Inferred: an explicit Stop clears the auto-resume.
    this.stalled = false;
    this.playback = 0;
    this.position = 0;
    return this.ok("Stop");
  },
};

module.exports = { FakeHqp, loadProfile, PROFILE_IDS, defaultIncompatible };
