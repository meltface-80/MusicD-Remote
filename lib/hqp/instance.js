"use strict";
// ---------------------------------------------------------------------------
// One HQPlayer: what it can do right now, the change engine, undo, and a
// shared status poller. Ported from hqpweb (apps/server/src/instance.ts and
// the change parser in app.ts), MIT, (c) 2026 statelycurmudgeon — see
// ./LICENSE. hqpweb's own HQPlayer-library browsing and its transport are not
// ported: MusicD Remote plays through Roon, which already has both.
//
// THE CHANGE ENGINE: resolve names to indices → apply in a fixed order → read
// State back → if the change could disturb playback and something was
// playing, watch it → if playback stopped or cannot keep up, record the
// combination as failed and roll back to what was there before.
//
// Three rules from hqpweb's measured fact base run through all of it:
//   * An OK reply proves nothing. HQPlayer answers OK to settings it then
//     ignores, so State, read back afterwards, is the verdict.
//   * Setters take LIST INDICES, and the lists change with the mode and the
//     engine version, so names are resolved at the moment of use, every time.
//   * Volume is a float in dB, it is clamped to what HQPlayer reports, and it
//     is never raised by more than 6 dB in one step.
// ---------------------------------------------------------------------------

const { HqpClient } = require("./client");
const { cmd } = require("./commands");
const { filterSlot, predictedStop } = require("./compat");
const { HttpError, LearnedStore } = require("./store");
const { DEFAULT_TIMING, MAJOR_TIMING, watchPlayback } = require("./watch");

/** Largest single volume RAISE accepted, in dB. Lowering is never limited. */
const MAX_RAISE_DB = 6;
/** Volume read-back tolerance, dB. */
const VOLUME_EPS = 0.01;

// What a change may carry, by NAME — never by index.
const FIELDS = {
  mode: "name",
  rate: "rate",          // output rate in Hz; 0 is auto
  filterNx: "name",
  filter1x: "name",
  shaper: "name",        // the modulator in SDM, the dither in PCM
  volume: "number",
  invert: "boolean",
  filter20k: "boolean",
  adaptive: "boolean",
  convolution: "boolean", // on/off only: impulse responses cannot be configured over the control API
  matrixProfile: "name", // a matrix profile already set up in HQPlayer
};

/** Settings whose meaning depends on the mode they were chosen in. */
const MODE_BOUND = ["rate", "filterNx", "filter1x", "shaper"];
/** Fields whose change can stop playback or overload the machine. */
const RISKY = ["mode", "rate", "filterNx", "filter1x", "shaper", "convolution", "matrixProfile"];

/** Strict: no unknown fields, no coercion ("-20" is not a volume). */
function parseChange(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const entries = Object.entries(body);
  if (entries.length === 0) throw new HttpError(400, "empty change");
  const out = {};
  for (const [k, v] of entries) {
    const kind = Object.prototype.hasOwnProperty.call(FIELDS, k) ? FIELDS[k] : undefined;
    if (!kind) throw new HttpError(400, 'unknown field "' + k + '"');
    const ok =
      kind === "name" ? typeof v === "string" && v.length > 0
      : kind === "number" ? typeof v === "number" && Number.isFinite(v)
      : kind === "rate" ? Number.isInteger(v) && v >= 0
      : typeof v === "boolean";
    const want = { name: "a non-empty string", number: "a number", rate: "a whole number of Hz (0 = auto)", boolean: "a boolean" }[kind];
    if (!ok) throw new HttpError(400, '"' + k + '" must be ' + want);
    out[k] = v;
  }
  return out;
}

const fieldsOf = (change) => Object.keys(change).filter((k) => change[k] !== undefined);
const nameOf = (list, i) => {
  const hit = list.find((x) => x.index === i);
  return hit ? hit.name : "#" + i;
};

/**
 * Every setting the engine manages, by name. In [source] mode there is no
 * output rate to name — HQPlayer ignores SetRate there — so the rate is left
 * out rather than recorded as 0: a 0 written down in [source] mode came back
 * as a SetRate that mode refuses, which failed the Undo of a change out of
 * [source] mode and, worse, the automatic rollback of one that stopped
 * playback, leaving it stopped.
 */
function settingsOf(caps, s) {
  const out = { mode: caps.mode.name };
  if (caps.rateSettable) {
    const rate = caps.rates.find((r) => r.index === s.rate);
    out.rate = rate ? rate.rate : 0;
  }
  return Object.assign(out, {
    filterNx: nameOf(caps.filters, s.filterNx),
    filter1x: nameOf(caps.filters, s.filter1x),
    shaper: nameOf(caps.shapers, s.shaper),
    volume: s.volume,
    invert: s.invert,
    filter20k: s.filter20k,
    adaptive: s.adaptive,
    convolution: s.convolution,
    matrixProfile: s.matrixProfile,
  });
}

/** How one preset relates to this HQPlayer now: active, quick or major, and what it cannot take. */
function previewOne(p, caps, cur, status) {
  const fields = fieldsOf(p);
  const differs = fields.filter((f) => (f === "volume" ? Math.abs(cur.volume - p.volume) > VOLUME_EPS : cur[f] !== p[f]));
  const switchesMode = p.mode !== undefined && p.mode !== cur.mode;
  const kind = differs.length === 0 ? "active"
    : switchesMode || (p.rate !== undefined && p.rate !== cur.rate) ? "major" : "quick";
  const missing = [];
  if (p.matrixProfile !== undefined && !caps.matrixProfiles.includes(p.matrixProfile))
    missing.push({ field: "matrixProfile", reason: 'matrix profile "' + p.matrixProfile + "\" isn't set up here" });
  if (switchesMode) {
    // Names can only be checked against the lists of the mode HQPlayer is IN;
    // a preset for another mode is checked when it is applied.
    if (caps.modes.some((m) => m.name === p.mode)) return { kind, differs, missing, unchecked: true };
    missing.unshift({ field: "mode", reason: 'mode "' + p.mode + '" is not available here' });
    for (const f of MODE_BOUND) if (p[f] !== undefined) missing.push({ field: f, reason: 'belongs to mode "' + p.mode + '"' });
    return { kind, differs, missing, unchecked: false };
  }
  const has = (list, n) => n === undefined || list.some((x) => x.name === n);
  if (!has(caps.filters, p.filterNx)) missing.push({ field: "filterNx", reason: '"' + p.filterNx + "\" isn't available here" });
  if (!has(caps.filters, p.filter1x)) missing.push({ field: "filter1x", reason: '"' + p.filter1x + "\" isn't available here" });
  if (!has(caps.shapers, p.shaper)) missing.push({ field: "shaper", reason: '"' + p.shaper + "\" isn't available here" });
  if (p.rate !== undefined) {
    const opt = caps.rates.find((r) => r.rate === p.rate);
    if (!opt) missing.push({ field: "rate", reason: p.rate + " Hz isn't offered here" });
    else if (!opt.allowed) missing.push({ field: "rate", reason: opt.note || "above this HQPlayer's limit" });
  }
  // Would the result play? Only knowable with a source and a fixed rate.
  const source = status.source ? status.source.sampleRate : 0;
  const rate = p.rate !== undefined ? p.rate : cur.rate;
  const out = { kind, differs, missing, unchecked: false };
  if (source && rate) {
    const filter = filterSlot(source) === "1x"
      ? (p.filter1x !== undefined ? p.filter1x : cur.filter1x)
      : (p.filterNx !== undefined ? p.filterNx : cur.filterNx);
    const predicted = predictedStop({ mode: cur.mode, filter, shaper: p.shaper !== undefined ? p.shaper : cur.shaper,
                                      sourceRate: source, outputRate: rate });
    if (predicted) out.predicted = predicted;
  }
  return out;
}

class Instance {
  /**
   * @param {{id: string, name?: string, host: string, port: number,
   *          limits?: {maxPcmRate?: number, maxDsdRate?: number}}} cfg
   * @param {{client?: HqpClient, learned?: LearnedStore,
   *          timing?: {quick: object, major: object}, speedWindowMs?: number}} [opts]
   */
  constructor(cfg, opts) {
    const o = opts || {};
    this.cfg = cfg;
    this.client = o.client || new HqpClient(cfg.host, { port: cfg.port });
    this.learned = o.learned || new LearnedStore(null);
    this.timing = o.timing || { quick: DEFAULT_TIMING, major: MAJOR_TIMING };
    this.speedWindowMs = o.speedWindowMs || 30000;
    this.caps = null;               // { key, value }: the lists, per (engine, mode)
    this.queue = Promise.resolve(); // writes to one HQPlayer run one at a time
    this.undoChange = null;         // the previous values of the fields the last change touched, by name
    this.undoMode = null;
    this.lastSetVolume = null;      // the volume the last change set: has anyone moved it since?
    this.listeners = new Set();
    this.every = 1500;              // the poll interval, set by subscribe()
    this.timer = null;
    this.ticking = 0;              // the pollGen of the status read in flight; 0 = none
    this.trail = [];
    this.pollGen = 0;               // bumped whenever polling starts or stops
    this.writeGen = 0;              // bumped as each write finishes
    this.closed = false;
  }

  exclusive(fn) {
    // Whatever the write did, succeeded or not, the poller's next status must
    // be read after it (see wrote()). Run before anyone awaiting the write
    // hears it has finished.
    const run = this.queue.then(fn, fn).finally(() => this.wrote());
    this.queue = run.catch(() => undefined);
    return run;
  }

  async now() {
    const [info, state, status] = await Promise.all([this.client.info(), this.client.state(), this.client.status()]);
    return { info, state, status };
  }

  /**
   * The lists for the current mode, cached per (engine, mode) and read again
   * when either changes. fresh=true bypasses the cache — writes always pass
   * it, because indices must be resolved at the moment of use.
   */
  async capabilities(fresh) {
    const [info, state] = await Promise.all([this.client.info(), this.client.state()]);
    const key = info.engine + "|" + state.mode;
    if (!fresh && this.caps && this.caps.key === key) {
      // Learned failures can change without the mode changing.
      return Object.assign({}, this.caps.value,
        { knownBad: this.learned.forInstance(this.cfg.id, info.engine, this.caps.value.mode.name) });
    }
    const [modes, filters, shapers, rates, volumeRange, matrixProfiles] = await Promise.all([
      this.client.modes(),
      this.client.filters(),
      this.client.shapers(),
      this.client.rates(),
      this.client.volumeRange(),
      // Older engines may not know the command; no profiles is the honest answer.
      this.client.matrixProfiles().catch(() => []),
    ]);
    // The lists only mean anything for the mode they were read in.
    const after = await this.client.state();
    if (after.mode !== state.mode) throw new HttpError(409, "the mode changed while the lists were being read; try again");
    const mode = modes.find((m) => m.index === state.mode);
    if (!mode) throw new HttpError(502, "State.mode " + state.mode + " is not in GetModes");

    const sdm = mode.name.startsWith("SDM");
    const limits = this.cfg.limits || {};
    const cap = sdm ? limits.maxDsdRate : limits.maxPcmRate;
    const rateOptions = rates.map((r) => {
      if (cap === undefined) return Object.assign({}, r, { allowed: true });
      if (r.rate === 0) return Object.assign({}, r, { allowed: true, note: "auto may pick a rate above this HQPlayer's limit" });
      return r.rate <= cap ? Object.assign({}, r, { allowed: true })
        : Object.assign({}, r, { allowed: false, note: "above this HQPlayer's limit (" + cap + " Hz)" });
    });
    const value = {
      engine: info.engine,
      mode,
      modes,
      filters,
      shapers,
      rates: rateOptions,
      // SetRate is ignored in [source] mode (reported by HQPTuner).
      rateSettable: mode.value !== -1,
      volumeRange,
      matrixProfiles,
      knownBad: this.learned.forInstance(this.cfg.id, info.engine, mode.name),
    };
    this.caps = { key, value };
    return value;
  }

  applyChange(change) {
    return this.exclusive(() => this.applyChangeNow(change, false, false));
  }

  /**
   * A preset: like a change, but settings this HQPlayer cannot take (a name
   * missing in this mode or engine, a rate it does not offer, a volume raise
   * past the guard) are SKIPPED and reported instead of failing the whole thing.
   */
  applyPreset(settings) {
    return this.exclusive(() => this.applyChangeNow(settings, false, true));
  }

  undo() {
    return this.exclusive(async () => {
      if (!this.undoChange) throw new HttpError(409, "nothing to undo");
      const state = await this.client.state();
      if (state.mode !== this.undoMode) throw new HttpError(409, "the mode changed since the last change, so undo is not safe");
      return this.applyChangeNow(this.undoChange, true, false);
    });
  }

  async applyChangeNow(change, isUndo, lenient) {
    if (fieldsOf(change).length === 0) throw new HttpError(400, "empty change");
    const playingBefore = (await this.client.status()).state === 2;
    const applied = await this.applyFields(change, isUndo, lenient);
    const skipped = applied.skipped.length ? { skipped: applied.skipped } : {};
    const risky = applied.results.some((r) => RISKY.includes(r.field));
    const timing = applied.major ? this.timing.major : this.timing.quick;

    let playback;
    if (!risky) playback = { kind: "not-checked", detail: "this change can't stop playback" };
    else if (!playingBefore) playback = { kind: "not-checked", detail: "nothing was playing, so playback couldn't be checked" };
    else playback = await this.watch(timing);

    if (playback.kind === "stopped" || playback.kind === "struggling") {
      // A stop HQPlayer's own rules explain is its design, not this machine's
      // limit: it is not learned.
      const incompatible = await this.explain().catch(() => undefined);
      // Bookkeeping (an unwritable data volume, say) must never block the rollback.
      if (!incompatible) {
        try { this.recordFailure(playback.detail, await this.comboNow()); }
        catch (e) { console.error("[hqp] could not record a failed combination: " + e.message); }
      }
      // Roll back. Volume follows the undo rule: restored only if nobody moved it.
      // Leniently, unlike hqpweb: a strict rollback refuses ALL of itself over
      // one setting it cannot put back, and a rollback that refuses leaves
      // playback stopped with nothing restored. Whatever cannot go back is
      // skipped and said, and everything else still goes back.
      this.lastSetVolume = applied.volumeSet;
      const back = await this.applyFields(applied.prev, true, true);
      const recovered = await this.watch(this.timing.major);
      this.undoChange = null;
      this.lastSetVolume = null;
      const rolledBack = { results: back.results, playback: recovered };
      if (back.skipped.length) rolledBack.skipped = back.skipped;
      return Object.assign({
        class: applied.major ? "major" : "quick",
        results: applied.results,
        playback,
        rolledBack,
        state: back.state,
        undoAvailable: false,
      }, incompatible ? { incompatible } : {}, skipped);
    }

    if (applied.results.length === 0) {
      // Nothing could be applied: undo stays as it was.
    } else if (!isUndo) {
      this.undoChange = applied.prev;
      this.undoMode = applied.state.mode;
      this.lastSetVolume = applied.volumeSet;
    } else {
      this.undoChange = null;
      this.lastSetVolume = null;
    }
    return Object.assign({
      class: applied.major ? "major" : "quick",
      results: applied.results,
      playback,
      rolledBack: null,
      state: applied.state,
      undoAvailable: this.undoChange !== null,
    }, skipped);
  }

  /** Apply without watching. Returns read-back results and how to undo, by name. */
  async applyFields(change, isUndo, lenient) {
    const requestedFields = fieldsOf(change);
    const problems = [];
    const caps0 = await this.capabilities(true);
    const before = await this.client.state();
    if (before.mode !== caps0.mode.index) throw new HttpError(409, "the mode changed; try again");
    const was = settingsOf(caps0, before);
    const replies = new Map();

    // ---- 1. mode first: every list changes with it -------------------------
    let caps = caps0;
    let modeSwitched = false;
    if (change.mode !== undefined && change.mode !== was.mode) {
      const m = caps0.modes.find((x) => x.name === change.mode);
      if (!m) {
        if (!lenient) throw new HttpError(422, 'mode "' + change.mode + '" is not available on this HQPlayer');
        problems.push({ field: "mode", reason: 'mode "' + change.mode + '" is not available on this HQPlayer' });
        // The rate, filters and modulator/dither were chosen for that mode:
        // they are not applied to this one.
        for (const f of MODE_BOUND) if (change[f] !== undefined) problems.push({ field: f, reason: 'belongs to mode "' + change.mode + '"' });
      } else {
        replies.set("mode", await this.client.send(cmd.setMode(m.index)));
        caps = await this.capabilities(true);
        modeSwitched = caps.mode.name !== was.mode;
      }
    }
    const undoModeSwitch = async () => {
      if (!modeSwitched) return;
      const m = caps.modes.find((x) => x.name === was.mode);
      if (m) await this.client.send(cmd.setMode(m.index));
    };

    // ---- 2. resolve everything else against the lists of the mode we are in --
    const alreadySkipped = (f) => problems.some((p) => p.field === f);
    const resolve = (list, field, name) => {
      if (name === undefined || alreadySkipped(field)) return undefined;
      const hit = list.find((x) => x.name === name);
      if (!hit) problems.push({ field, reason: '"' + name + '" is not available in ' + caps.mode.name + " on engine " + caps.engine });
      return hit ? hit.index : undefined;
    };
    let rateIdx;
    if (change.rate !== undefined && !alreadySkipped("rate")) {
      const opt = caps.rates.find((r) => r.rate === change.rate);
      const p = (reason) => problems.push({ field: "rate", reason });
      if (!caps.rateSettable) p("the rate can't be set in " + caps.mode.name + " mode");
      else if (!opt) p(change.rate + " Hz is not offered in " + caps.mode.name);
      else if (!opt.allowed) p(change.rate + " Hz: " + opt.note);
      else rateIdx = opt.index;
    }
    const nx = resolve(caps.filters, "filterNx", change.filterNx);
    const x1 = resolve(caps.filters, "filter1x", change.filter1x);
    const shaper = resolve(caps.shapers, "shaper", change.shaper);
    // HQPlayer answers OK to an unknown profile name (reported), so only listed
    // ones are ever sent. Undo/rollback may restore "" (no profile); the
    // read-back verifies it took.
    const restoringNone = isUndo && change.matrixProfile === "";
    if (change.matrixProfile !== undefined && !restoringNone && !caps.matrixProfiles.includes(change.matrixProfile))
      problems.push({
        field: "matrixProfile",
        reason: caps.matrixProfiles.length
          ? '"' + change.matrixProfile + "\" is not one of this HQPlayer's matrix profiles"
          : "no matrix profiles are set up in HQPlayer",
      });

    // ---- 3. the volume guards -------------------------------------------------
    let volume;
    let volumeNote;
    if (change.volume !== undefined) {
      const vr = caps.volumeRange;
      if (!vr.enabled) problems.push({ field: "volume", reason: "volume control is switched off in HQPlayer" });
      else {
        volume = Math.max(vr.min, Math.min(vr.max, change.volume));
        if (volume !== change.volume) volumeNote = "clamped to " + volume + " dB (range " + vr.min + "…" + vr.max + ")";
        const raise = volume - before.volume;
        if (raise > MAX_RAISE_DB + VOLUME_EPS) {
          // Undo and rollback may return to the level that was just playing,
          // but only if nobody has moved the volume since this app changed it.
          const untouched = this.lastSetVolume !== null && Math.abs(before.volume - this.lastSetVolume) <= VOLUME_EPS;
          if (!isUndo) {
            volume = undefined;
            problems.push({ field: "volume", reason: "refusing to raise the volume by " + raise.toFixed(1) + " dB in one step (max " + MAX_RAISE_DB + " dB)" });
          } else if (!untouched) {
            volume = undefined;
            volumeNote = "not restored: the volume was changed elsewhere, and restoring it would raise it by " + raise.toFixed(1) + " dB";
          }
        }
      }
    }

    if (problems.length && !lenient) {
      await undoModeSwitch();
      throw new HttpError(422, problems.map((p) => (p.field === "volume" ? p.reason : p.field + ": " + p.reason)).join("; "));
    }
    const skippedFields = new Set(problems.map((p) => p.field));
    const fields = requestedFields.filter((f) => !skippedFields.has(f));

    // ---- 4. apply, in a fixed order ------------------------------------------------
    if (rateIdx !== undefined) replies.set("rate", await this.client.send(cmd.setRate(rateIdx)));
    if (nx !== undefined || x1 !== undefined) {
      // SetFilter always carries both indices; the one not being changed is kept.
      const cur = modeSwitched ? await this.client.state() : before;
      const r = await this.client.send(cmd.setFilter(nx !== undefined ? nx : cur.filterNx, x1 !== undefined ? x1 : cur.filter1x));
      if (nx !== undefined) replies.set("filterNx", r);
      if (x1 !== undefined) replies.set("filter1x", r);
    }
    if (shaper !== undefined) replies.set("shaper", await this.client.send(cmd.setShaping(shaper)));
    if (change.invert !== undefined) replies.set("invert", await this.client.send(cmd.setInvert(change.invert)));
    if (change.filter20k !== undefined) replies.set("filter20k", await this.client.send(cmd.set20kFilter(change.filter20k)));
    if (change.adaptive !== undefined) replies.set("adaptive", await this.client.send(cmd.setAdaptiveVolume(change.adaptive)));
    if (change.convolution !== undefined && fields.includes("convolution"))
      replies.set("convolution", await this.client.send(cmd.setConvolution(change.convolution)));
    if (change.matrixProfile !== undefined && fields.includes("matrixProfile"))
      replies.set("matrixProfile", await this.client.send(cmd.matrixSetProfile(change.matrixProfile)));
    if (volume !== undefined) replies.set("volume", await this.client.send(cmd.volume(volume)));

    // ---- 5. read back: State is the verdict, not the reply ------------------------
    const after = await this.client.state();
    const now = settingsOf(caps, after);
    const results = fields.map((field) => {
      const reply = replies.get(field) || { kind: "none" };
      const requested = change[field];
      if (field === "volume") {
        const r = { field, requested, actual: now.volume,
                    applied: volume !== undefined && Math.abs(now.volume - volume) <= VOLUME_EPS, reply };
        if (volumeNote) r.note = volumeNote;
        return r;
      }
      const applied = now[field] === requested;
      const r = { field, requested, actual: now[field], applied, reply };
      // Measured: with no impulse responses set up, SetConvolution says OK and nothing changes.
      if (field === "convolution" && requested === true && !applied)
        r.note = "HQPlayer didn't switch convolution on: no impulse responses are set up there " +
                 "(Convolution → Engine setup in HQPlayer; this can't be done remotely)";
      return r;
    });

    // ---- 6. how to undo it, by name ------------------------------------------------
    const prev = {};
    for (const f of fields) if (f !== "volume" && was[f] !== undefined) prev[f] = was[f];
    // A mode switch resets the rate (reported) and swaps the remembered
    // filters. Coming from [source] mode there is no rate to go back to.
    if (modeSwitched && was.rate !== undefined) prev.rate = was.rate;
    if (volume !== undefined) prev.volume = was.volume;

    const major = modeSwitched || (rateIdx !== undefined && rateIdx !== before.rate);
    return { results, prev, state: after, volumeSet: volume !== undefined ? volume : null, major, skipped: problems };
  }

  /** The current settings, by name: what "save current as a preset" captures. */
  async currentSettings() {
    const caps = await this.capabilities(true);
    const state = await this.client.state();
    return settingsOf(caps, state);
  }

  /** How each preset relates to this HQPlayer right now, from one set of reads. */
  async previewPresets(list) {
    const [caps, state, status] = await Promise.all([this.capabilities(false), this.client.state(), this.client.status()]);
    const cur = settingsOf(caps, state);
    return list.map((p) => previewOne(p, caps, cur, status));
  }

  /** Read the lists again next time: HQPlayer came back and may not be the same. */
  forgetCapabilities() {
    this.caps = null;
  }

  watch(timing) {
    return watchPlayback(async () => {
      const s = await this.client.status();
      return { state: s.state, position: s.position };
    }, timing);
  }

  /** Does a known HQPlayer rule explain why the current settings cannot play? */
  async explain() {
    const [caps, state, status] = await Promise.all([this.capabilities(true), this.client.state(), this.client.status()]);
    const source = status.source ? status.source.sampleRate : 0;
    if (!source) return undefined;
    const s = settingsOf(caps, state);
    const filter = filterSlot(source) === "1x" ? s.filter1x : s.filterNx;
    return predictedStop({ mode: s.mode, filter, shaper: s.shaper, sourceRate: source, outputRate: status.activeRate });
  }

  /** The combination in effect now, by name, as a learned failure would key it. */
  async comboNow() {
    const [caps, state, status] = await Promise.all([this.capabilities(true), this.client.state(), this.client.status()]);
    const s = settingsOf(caps, state);
    return { engine: caps.engine, combo: { mode: s.mode, rateHz: status.activeRate, filterNx: s.filterNx, filter1x: s.filter1x, shaper: s.shaper } };
  }

  recordFailure(reason, now) {
    this.learned.record(Object.assign({}, now.combo,
      { instance: this.cfg.id, engine: now.engine, reason, at: new Date().toISOString() }));
  }

  // ---- the shared status poller --------------------------------------------------
  // It polls only while someone is watching. Besides the status it reports
  // health: how long Status took to answer, and how fast playback advances
  // against the wall clock. Overload builds over minutes (measured), so this
  // runs all the while the screen is open, not only after a change. When the
  // answers slow down, polling backs off so the app does not add to the load.

  subscribe(fn, intervalMs) {
    this.every = intervalMs || 1500;
    this.listeners.add(fn);
    if (!this.timer && !this.closed) {
      const gen = ++this.pollGen;
      this.timer = setTimeout(() => this.tick(gen), 0);
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.trail = [];
        this.pollGen++;
      }
    };
  }

  // One status read. `this.timer` keeps the (fired) timeout while a read is in
  // flight, so subscribe() and the unsubscriber above see the loop as running.
  async tick(gen) {
    this.ticking = gen;
    const wg = this.writeGen;
    let event;
    let next = this.every;
    const t0 = Date.now();
    try {
      const [status, state] = await Promise.all([this.client.status(), this.client.state()]);
      const latencyMs = Date.now() - t0;
      // writeGen: which writes this read came after (see wrote()).
      event = { snapshot: { status, state }, health: { latencyMs, speed: this.trackSpeed(status) }, writeGen: wg };
      // Normal replies take ~1 ms on a kept-open connection (measured).
      if (latencyMs > 1000) next = Math.min(10000, latencyMs * 3);
    } catch (e) {
      event = { error: e.message, writeGen: wg };
      this.trail = [];
      next = Math.min(10000, this.every * 4);
    }
    if (this.ticking === gen) this.ticking = 0;
    if (gen !== this.pollGen) return; // stopped (or restarted) while this tick was in flight
    if (wg !== this.writeGen) {
      // A write finished while these were being read, so they may describe
      // HQPlayer BEFORE it: published, they would put the old settings back
      // on the screen for a poll. Read again straight away instead.
      event = null;
      next = 0;
    }
    if (event) for (const l of this.listeners) l(event);
    if (this.listeners.size) this.timer = setTimeout(() => this.tick(gen), next);
  }

  /**
   * A write has finished. The status the poller holds was read before it, so
   * the next one is read now rather than a whole interval later — a read
   * already in flight sees writeGen move and goes again by itself.
   */
  wrote() {
    this.writeGen++;
    if (this.timer && this.ticking !== this.pollGen && !this.closed) {
      clearTimeout(this.timer);
      const gen = this.pollGen;
      this.timer = setTimeout(() => this.tick(gen), 0);
    }
  }

  /**
   * Playback speed against real time: the least-squares slope of the position
   * over the last window (30 s). The position moves in ~1 s steps (measured),
   * so a two-point difference over a short window swung 0.94–1.04 while
   * playback was fine; a fitted slope over 30 s does not. null while not
   * playing, and while the window is still filling.
   */
  trackSpeed(status) {
    const now = Date.now();
    if (status.state !== 2) {
      this.trail = [];
      return null;
    }
    const last = this.trail[this.trail.length - 1];
    // A jump either way is a track change or a seek: start over.
    if (last && (status.position < last.pos - 0.5 || status.position - last.pos > (now - last.t) / 1000 + 3)) this.trail = [];
    this.trail.push({ t: now, pos: status.position });
    this.trail = this.trail.filter((p) => now - p.t <= this.speedWindowMs);
    const first = this.trail[0];
    if (now - first.t < this.speedWindowMs * 0.9 || this.trail.length < 3) return null;
    const n = this.trail.length;
    const mt = this.trail.reduce((a, p) => a + (p.t - first.t) / 1000, 0) / n;
    const mp = this.trail.reduce((a, p) => a + p.pos, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of this.trail) {
      const dt = (p.t - first.t) / 1000 - mt;
      num += dt * (p.pos - mp);
      den += dt * dt;
    }
    return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
  }

  close() {
    this.closed = true;
    this.client.close();
    this.stopPolling();
  }

  /**
   * Close once the change in flight, if there is one, has finished — its
   * watch and its rollback included. Closing under it would cut the rollback
   * off and leave HQPlayer on a setting that had just stopped playback, with
   * nothing left to put it back. Polling stops now.
   */
  retire() {
    this.stopPolling();
    return this.queue.then(() => this.close());
  }

  stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.trail = [];
    this.pollGen++;
    this.listeners.clear();
  }
}

module.exports = { Instance, HttpError, parseChange, settingsOf, MAX_RAISE_DB, FIELDS };
