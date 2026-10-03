"use strict";
// ---------------------------------------------------------------------------
// HQPlayer control, as MusicD Remote serves it: the settings, the Demo
// HQPlayer, a status poller that runs only while somebody is looking, and the
// /api/hqp/* routes. The HQPlayer-facing parts (client, change engine, rules,
// presets, the fake) are ported from hqpweb by statelycurmudgeon (MIT — see
// ./LICENSE); this file is the glue, written for this app.
//
// WHAT RUNS WHEN. Nothing at all while the feature is off: no connection, no
// timer, no fake. While it is on, HQPlayer is asked for its status every
// 1.5 s only while the HQPlayer screen is open somewhere — each GET
// /api/hqp/now renews a lease, and the poller stops LEASE_MS after the last
// one. (hqpweb holds a server-sent-event stream open for the same purpose.
// This app polls, like every other live thing in it, which keeps the screen
// testable with a stubbed fetch and survives an iOS app being put away.)
//
// WRITES ARE JSON-ONLY. HQPlayer has no login, and neither has this app, so
// a page on some other site must not be able to change the volume through a
// user's browser. A cross-site page can send a "simple" request with no
// preflight — but only with a form or text content type. Requiring
// application/json on every write means any cross-site attempt needs a CORS
// preflight, which this server never grants. (hqpweb guards the same door
// with an Origin check; that refuses writes through any reverse proxy that
// rewrites Host, and the content-type rule does not.)
// ---------------------------------------------------------------------------

const path = require("node:path");
const { HqpClient, DEFAULT_PORT } = require("./client");
const { Instance, HttpError, parseChange } = require("./instance");
const { LearnedStore, PresetStore } = require("./store");
const { pickerHints, hintsKey, slotInUse } = require("./hints");
const { FakeHqp, loadProfile } = require("./fake");

const POLL_MS = 1500;
const LEASE_MS = 15000;
const FIRST_EVENT_WAIT_MS = 2500;
const PROBE_TIMEOUT_MS = 3000;
const HOST_RE = /^[A-Za-z0-9.\-:[\]]{1,253}$/;
const DEMO_PROFILE = "desktop5-mac-sdm";
const DEMO_NAME = "Demo HQPlayer";

function bad(message) { return new HttpError(400, message); }

// Where the Demo HQPlayer starts: DSD512 with the ASDM7EC modulator, a setting
// plenty of real systems run at, rather than the captured Mac's DSD1024. At
// DSD512 the AHM modulators cannot play — they need DSD1024, and hqpweb
// measured AHM7EC8B stopping at DSD512 on a real HQPlayer — so the demo has
// something true to show: the picker marks them before they are tapped, and
// picking one anyway shows the stop and the automatic undo. Set directly,
// before anything has connected, so no stall is involved in getting there.
function demoStartingPoint(f) {
  const shaper = f.lists.shapers.find((x) => x.name === "ASDM7EC");
  const rate = f.lists.rates.indexOf(22579200);
  if (shaper) f.rem.shaper = shaper.index;
  if (rate > 0) f.rateIndex = rate;
}

/** Validate a settings patch. Strict: unknown fields and wrong types are refused, nothing is coerced. */
function parseSettingsPatch(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("body must be a JSON object");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "enabled" || k === "demo") {
      if (typeof v !== "boolean") throw bad(k + " must be true or false");
      out[k] = v;
    } else if (k === "host") {
      if (typeof v !== "string") throw bad("host must be a string");
      const h = v.trim();
      if (h && !HOST_RE.test(h)) throw bad("the address must be a host name or an IP address");
      out.host = h;
    } else if (k === "port") {
      if (!Number.isInteger(v) || v < 1 || v > 65535) throw bad("the port must be a whole number from 1 to 65535");
      out.port = v;
    } else {
      throw bad('unknown field "' + k + '"');
    }
  }
  return out;
}

/** A preset body: { name?, settings? } or { name?, fromCurrent: true, includeVolume? }. */
function parsePresetBody(body, patch) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("body must be a JSON object");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "name") {
      if (typeof v !== "string") throw bad("name must be a string");
      out.name = v;
    } else if (k === "settings") {
      out.settings = parseChange(v);
    } else if (k === "fromCurrent" || k === "includeVolume") {
      if (typeof v !== "boolean") throw bad(k + " must be true or false");
      out[k] = v;
    } else {
      throw bad('unknown field "' + k + '"');
    }
  }
  if (!patch && out.name === undefined) throw bad("name is required");
  return out;
}

/** Roon zones that play through HQPlayer: an output carries a source control named for it (measured by hqpweb). */
function hqpZones(zones) {
  const out = [];
  for (const z of Object.values(zones || {})) {
    const feeds = (z.outputs || []).some((o) => (o.source_controls || []).some((s) => /hqplayer/i.test(String(s.display_name || ""))));
    if (!feeds) continue;
    const np = z.now_playing || null;
    const lines = np && np.three_line ? np.three_line : null;
    out.push({
      zone_id: z.zone_id,
      display_name: z.display_name || "",
      state: z.state || "",
      track: lines ? lines.line1 || "" : "",
      artist: lines ? lines.line2 || "" : "",
      album: lines ? lines.line3 || "" : "",
      image_key: np && np.image_key ? np.image_key : null,
    });
  }
  return out;
}

/**
 * @param {{
 *   dataDir: string|null,          where hqp-presets.json and hqp-learned.json live; null = memory only
 *   getSettings: () => object,     the persisted settings object (reads hqp* keys)
 *   saveSettings: (patch) => boolean,
 *   zones?: () => object,          Roon zones by id, for the now-playing line
 *   timing?: object, speedWindowMs?: number, pollMs?: number, leaseMs?: number,
 *   demoTimeScale?: number         tests run the demo instantly
 * }} opts
 */
function createHqpService(opts) {
  const dataDir = opts.dataDir || null;
  const learned = new LearnedStore(dataDir ? path.join(dataDir, "hqp-learned.json") : null);
  const presets = new PresetStore(dataDir ? path.join(dataDir, "hqp-presets.json") : null, parseChange);
  const pollMs = opts.pollMs || POLL_MS;
  const leaseMs = opts.leaseMs || LEASE_MS;

  const readSettings = () => {
    const p = opts.getSettings() || {};
    const port = Number.isInteger(p.hqpPort) && p.hqpPort >= 1 && p.hqpPort <= 65535 ? p.hqpPort : DEFAULT_PORT;
    return {
      enabled: p.hqpEnabled === true,
      host: typeof p.hqpHost === "string" ? p.hqpHost : "",
      port,
      demo: p.hqpDemo === true,
    };
  };
  let settings = readSettings();
  // Learned failures are this app's own record, kept per HQPlayer (the Demo
  // HQPlayer's apart): they can be read and forgotten with control switched
  // off, and Settings offers to forget them whenever there are some.
  const learnedId = () => (settings.demo ? "demo" : "hqp");

  let inst = null;            // the Instance for the current settings
  let instKey = "";
  let info = null;            // GetInfo for `inst`, read once per instance
  let fake = null;            // the Demo HQPlayer, while the demo is on
  let fakeStarting = null;
  let fakeToken = null;       // which start is still wanted; a stop clears it
  let watch = null;           // { inst, off, latest, waiters, timer }
  let generation = 0;         // bumped by every reconfiguration
  let epoch = 0;              // bumped whenever HQPlayer answers again after going quiet

  function stopWatch() {
    if (!watch) return;
    clearTimeout(watch.timer);
    watch.off();
    for (const w of watch.waiters) w();
    watch = null;
  }

  // Drop the current Instance. `drain`: let a change it is in the middle of
  // finish first — its watch and its rollback — and close after (see
  // Instance.retire()); every route but the extension shutting down drains.
  function closeInstance(drain) {
    stopWatch();
    if (inst) {
      if (drain) inst.retire();
      else inst.close();
    }
    inst = null;
    instKey = "";
    info = null;
  }

  async function stopFake() {
    fakeToken = null;
    fakeStarting = null;
    const f = fake;
    fake = null;
    if (f) await f.close();
  }

  // One fake, however many requests ask for it at once. A start that finishes
  // after the demo was switched off closes what it started rather than leaving
  // a server listening that nothing will ever stop.
  function startFake() {
    if (fake) return Promise.resolve(fake);
    if (!fakeStarting) {
      const token = {};
      fakeToken = token;
      const starting = (async () => {
        const f = new FakeHqp(loadProfile(DEMO_PROFILE), {
          timeScale: opts.demoTimeScale !== undefined ? opts.demoTimeScale : 1,
          record: false,
        });
        demoStartingPoint(f);
        await f.listen(0, "127.0.0.1");
        if (fakeToken !== token) {
          await f.close();
          throw new HttpError(409, "the Demo HQPlayer was switched off");
        }
        fake = f;
        return f;
      })();
      fakeStarting = starting;
      starting.catch(() => { if (fakeStarting === starting) fakeStarting = null; });
    }
    return fakeStarting;
  }

  // Which HQPlayer an Instance talks to. Two settings that name the same one
  // share an Instance, and anything it is in the middle of.
  const demoCfg = (f) => ({ id: "demo", name: DEMO_NAME, host: "127.0.0.1", port: f.port });
  const realCfg = (s) => ({ id: "hqp", name: s.host, host: s.host, port: s.port });
  const keyOf = (cfg) => cfg.id + "@" + cfg.host + ":" + cfg.port;

  /** The Instance the current settings describe, created on first use; null when off or not set up. */
  async function current() {
    for (;;) {
      const gen = generation;
      const s = settings;
      if (!s.enabled) return null;
      let cfg;
      if (s.demo) {
        let f;
        try {
          f = await startFake();
        } catch (e) {
          if (gen !== generation) continue;   // the settings moved under it: decide again
          throw e;
        }
        if (gen !== generation) continue;
        cfg = demoCfg(f);
      } else {
        if (!s.host) return null;
        cfg = realCfg(s);
      }
      const key = keyOf(cfg);
      if (inst && instKey === key) return inst;
      closeInstance(true);
      inst = new Instance(cfg, Object.assign({ learned },
        opts.timing ? { timing: opts.timing } : {},
        opts.speedWindowMs ? { speedWindowMs: opts.speedWindowMs } : {}));
      instKey = key;
      return inst;
    }
  }

  async function required() {
    if (!settings.enabled) throw new HttpError(409, "HQPlayer control is switched off");
    const i = await current();
    if (!i) throw new HttpError(409, "No HQPlayer address is set. Add one in Settings → HQPlayer.");
    return i;
  }

  // HQPlayer's name and version (GetInfo), read once per HQPlayer — and again
  // whenever it comes back after going quiet, since it may be another version.
  function readInfo(i) {
    const mine = { inst: i, value: null };
    info = mine;
    i.client.info().then((v) => { mine.value = v; }, () => {
      // Not answering: the poller reports that, and this is asked again as
      // soon as it answers.
      if (info === mine) info = null;
    });
  }

  // The key the page holds HQPlayer's lists under. Besides what hintsKey
  // covers (the mode, the track, the settings in effect), it names WHICH
  // HQPlayer, and how often it has come back after going quiet: switching to
  // another HQPlayer, or one restarting — perhaps a new version, or another
  // output device with other rates — changes the lists without moving
  // anything hintsKey can see. Both routes build it here, so they agree.
  const listsKey = (snap) => instKey + "#" + epoch + "|" + hintsKey(snap);

  // Keep the poller running for another lease; start it if it is not.
  function lease(i) {
    if (!watch || watch.inst !== i) {
      stopWatch();
      // latest: the last event — { snapshot, health } or { error } — stamped
      // with the Instance's writeGen when it was read.
      const w = { inst: i, latest: null, waiters: [], timer: null, off: null };
      w.off = i.subscribe((e) => {
        if (e.snapshot && w.latest && w.latest.error) {
          // Back after going quiet: read its lists and its name afresh.
          epoch++;
          i.forgetCapabilities();
          readInfo(i);
        } else if (e.snapshot && (!info || info.inst !== i)) {
          readInfo(i);
        }
        w.latest = e;
        const ws = w.waiters;
        w.waiters = [];
        for (const f of ws) f();
      }, pollMs);
      watch = w;
      if (!info || info.inst !== i) readInfo(i);
    }
    clearTimeout(watch.timer);
    watch.timer = setTimeout(stopWatch, leaseMs);
    if (watch.timer.unref) watch.timer.unref();
    return watch;
  }

  // The next event, or ms, whichever comes first. `any`: one already held
  // will do.
  function nextEvent(w, ms, any) {
    if (any && w.latest) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      w.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  async function reconfigure(patch) {
    const next = Object.assign({}, settings, patch);
    const save = {
      hqpEnabled: next.enabled, hqpHost: next.host, hqpPort: next.port, hqpDemo: next.demo,
    };
    if (!opts.saveSettings(save)) throw new HttpError(500, "Couldn't save the HQPlayer settings");
    generation++;
    settings = readSettings();
    // Still the same HQPlayer: keep its Instance, and whatever it is in the
    // middle of. Closing it on every save cut off a change being watched —
    // Save pressed with nothing altered, or on another device — so a setting
    // that had stopped playback was never rolled back. Anything else drains
    // and goes; current() makes the next one on first use.
    const s = settings;
    const wanted = !s.enabled ? null
      : s.demo ? (fake ? keyOf(demoCfg(fake)) : null)
      : s.host ? keyOf(realCfg(s)) : null;
    if (inst && instKey !== wanted) closeInstance(true);
    if (!s.enabled || !s.demo) await stopFake();
  }

  function settingsView() {
    return {
      enabled: settings.enabled,
      host: settings.host,
      port: settings.port,
      demo: settings.demo,
      learned_count: learned.all(learnedId()).length,
    };
  }

  async function nowView() {
    const s = settings;
    const base = { enabled: s.enabled, demo: s.demo, configured: s.demo || !!s.host };
    if (!s.enabled) return base;
    const i = await current();
    if (!i) return base;
    const w = lease(i);
    await nextEvent(w, FIRST_EVENT_WAIT_MS, true);
    // A change, an undo or a preset has finished since that status was read,
    // so it describes HQPlayer BEFORE it: the screen, which has just shown
    // what the change did, would flip back to the old settings for a poll.
    // The Instance reads again the moment a write finishes; wait for that.
    if (watch === w && w.latest && w.latest.writeGen !== i.writeGen) await nextEvent(w, FIRST_EVENT_WAIT_MS, false);
    if (watch !== w) return Object.assign(base, { reachable: null, error: null, snapshot: null });
    const e = w.latest;
    const snap = e && e.snapshot ? e.snapshot : null;
    const inf = info && info.inst === i ? info.value : null;
    return Object.assign(base, {
      name: s.demo ? DEMO_NAME : (inf && inf.name) || s.host,
      product: inf ? inf.product : "",
      engine: inf ? inf.engine : "",
      address: s.demo ? "" : s.host + (s.port !== DEFAULT_PORT ? ":" + s.port : ""),
      reachable: e ? !!snap : null,
      error: e && e.error ? e.error : null,
      snapshot: snap,
      health: e && e.health ? e.health : null,
      inUse: slotInUse(snap),
      hintsKey: listsKey(snap),
      undoAvailable: i.undoChange !== null,
      // A Roon zone playing through HQPlayer, for the line saying what is on.
      // Not in the demo: the fake is fed by nothing, and naming a real zone's
      // track over it would claim a connection that is not there.
      roon: s.demo || !opts.zones ? [] : hqpZones(opts.zones()),
    });
  }

  async function captureFrom(i, includeVolume) {
    const cur = Object.assign({}, await i.currentSettings());
    if (!includeVolume) delete cur.volume;
    // "" means no matrix profile is active: nothing to restore, so it is left out.
    if (!cur.matrixProfile) delete cur.matrixProfile;
    return cur;
  }

  // Routes ----------------------------------------------------------------------
  // A plain table, matched by dispatch(), with Express only as the adapter in
  // mount(). The test suite runs with no dependencies installed, so it calls
  // dispatch() itself — the same handlers the server runs, not a copy.
  const ROUTES = [];
  const on = (method, pattern, fn) => ROUTES.push({ method, pattern, fn });

  on("GET", /^\/settings$/, () => settingsView());
  on("POST", /^\/settings$/, async (req) => {
    await reconfigure(parseSettingsPatch(req.body));
    return settingsView();
  });

  // Does anything answer as HQPlayer at this address? For the Settings page,
  // before (or after) it is saved. A fresh connection, closed straight after.
  on("POST", /^\/test$/, async (req) => {
    const p = parseSettingsPatch(req.body);
    const host = p.host !== undefined ? p.host : settings.host;
    const port = p.port !== undefined ? p.port : settings.port;
    if (!host) throw bad("enter HQPlayer's address first");
    const probe = new HqpClient(host, { port, timeoutMs: PROBE_TIMEOUT_MS });
    try {
      const v = await probe.info();
      return { ok: true, name: v.name, product: v.product, engine: v.engine, version: v.version };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      probe.close();
    }
  });

  on("GET", /^\/now$/, () => nowView());

  on("GET", /^\/capabilities$/, async () => {
    const i = await required();
    const caps = await i.capabilities(false);
    const [status, state] = await Promise.all([i.client.status(), i.client.state()]);
    const snap = { status, state };
    return Object.assign({}, caps, { hints: pickerHints(caps, snap), hintsKey: listsKey(snap) });
  });

  on("POST", /^\/change$/, async (req) => (await required()).applyChange(parseChange(req.body)));
  on("POST", /^\/undo$/, async () => (await required()).undo());

  on("GET", /^\/presets$/, async () => {
    const i = await required();
    const list = presets.list();
    const previews = await i.previewPresets(list.map((p) => p.settings));
    return list.map((p, n) => Object.assign({}, p, { preview: previews[n] }));
  });
  on("POST", /^\/presets$/, async (req) => {
    const body = parsePresetBody(req.body, false);
    let s = body.settings;
    if (body.fromCurrent) s = await captureFrom(await required(), body.includeVolume === true);
    if (!s || Object.keys(s).length === 0) throw bad("a preset needs settings, or fromCurrent");
    return presets.create(body.name, s);
  });
  on("PATCH", /^\/presets\/([^/]+)$/, async (req, id) => {
    const body = parsePresetBody(req.body, true);
    let s = body.settings;
    if (body.fromCurrent) {
      // "Update from current" keeps the preset's own choice about volume
      // unless the request says otherwise.
      const had = presets.get(id).settings.volume !== undefined;
      s = await captureFrom(await required(), body.includeVolume !== undefined ? body.includeVolume : had);
    }
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (s) patch.settings = s;
    return presets.update(id, patch);
  });
  on("DELETE", /^\/presets\/([^/]+)$/, (req, id) => {
    presets.remove(id);
    return { ok: true };
  });
  on("POST", /^\/presets\/([^/]+)\/apply$/, async (req, id) => {
    const p = presets.get(id);
    return (await required()).applyPreset(p.settings);
  });

  on("GET", /^\/learned$/, () => learned.all(learnedId()));
  on("DELETE", /^\/learned$/, () => {
    const id = learnedId();
    const n = learned.all(id).length;
    learned.forget(id);
    return { forgotten: n };
  });

  /**
   * One request, by path below /api/hqp: { method, path, headers, body } →
   * { status, body }. Never rejects.
   */
  async function dispatch(req) {
    const method = String(req.method || "GET").toUpperCase();
    const headers = req.headers || {};
    // Writes must be JSON (see the header): this is what keeps other sites out.
    if (method !== "GET" && method !== "HEAD" &&
        !/^application\/json\b/i.test(String(headers["content-type"] || ""))) {
      return { status: 415, body: { error: "expected application/json" } };
    }
    const p = String(req.path || "/");
    let found = null;
    let pathMatched = false;
    for (const r of ROUTES) {
      const m = r.pattern.exec(p);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) { found = { r, m }; break; }
    }
    if (!found) return pathMatched ? { status: 405, body: { error: "method not allowed" } } : { status: 404, body: { error: "not found" } };
    let id;
    if (found.m[1] !== undefined) {
      try { id = decodeURIComponent(found.m[1]); }
      catch (e) { return { status: 400, body: { error: "bad id" } }; }
    }
    try {
      const out = await found.r.fn({ body: req.body === undefined ? {} : req.body }, id);
      return { status: 200, body: out === undefined ? { ok: true } : out };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      // Anything else is a failure talking to HQPlayer.
      return { status: 502, body: { error: "HQPlayer didn't answer: " + (err && err.message ? err.message : String(err)) } };
    }
  }

  // Express: everything under /api/hqp goes through dispatch(). express.json()
  // (mounted for the whole app) has already parsed the body.
  function mount(app) {
    app.use("/api/hqp", (req, res) => {
      dispatch({ method: req.method, path: req.path, headers: req.headers, body: req.body })
        .then((r) => { if (!res.headersSent) res.status(r.status).json(r.body); });
    });
  }

  async function close() {
    generation++;
    closeInstance(false);
    await stopFake();
  }

  return {
    mount,
    dispatch,
    close,
    // For tests and diagnostics.
    get polling() { return !!watch; },
    get demoPort() { return fake ? fake.port : null; },
    get demoFake() { return fake; },
  };
}

module.exports = { createHqpService, parseSettingsPatch, hqpZones };
