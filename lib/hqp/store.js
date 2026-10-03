"use strict";
// ---------------------------------------------------------------------------
// The two files the HQPlayer control writes: combinations that failed
// (learned from rollbacks) and presets. Ported from hqpweb
// (apps/server/src/{jsonstore,learned,presets}.ts), MIT, (c) 2026
// statelycurmudgeon — see ./LICENSE.
//
// A missing file is normal. An unreadable one is MOVED ASIDE, never silently
// overwritten by the next save, so a bad write cannot cost anybody their
// presets without leaving them a copy.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function loadList(file, key, log) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = data && data[key];
    if (!Array.isArray(list)) throw new Error('no "' + key + '" array');
    return list;
  } catch (e) {
    const aside = file + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.renameSync(file, aside); }
    catch (e2) { /* the warning below still names the file; a failed move leaves it in place, which is no worse */ }
    (log || console.error)("[hqp] could not read " + file + " (" + e.message + "); moved it to " + aside + " and started empty");
    return [];
  }
}

// Atomic: a crash mid-write leaves the old file, never half a new one.
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
  fs.renameSync(tmp, file);
}

// ---- learned failures ------------------------------------------------------
// Kept per HQPlayer and per ENGINE VERSION, because both change what works.

const sameCombo = (a, b) =>
  a.mode === b.mode && a.rateHz === b.rateHz && a.filterNx === b.filterNx && a.filter1x === b.filter1x && a.shaper === b.shaper;

class LearnedStore {
  /** file null = memory only (tests). */
  constructor(file) {
    this.file = file || null;
    this.failures = this.file ? loadList(this.file, "failures") : [];
  }
  record(f) {
    this.failures = this.failures.filter((x) => !(x.instance === f.instance && x.engine === f.engine && sameCombo(x, f)));
    this.failures.push(f);
    this.save();
  }
  forInstance(instance, engine, mode) {
    return this.failures.filter((f) => f.instance === instance && f.engine === engine && f.mode === mode);
  }
  all(instance) {
    return this.failures.filter((f) => f.instance === instance);
  }
  forget(instance) {
    this.failures = this.failures.filter((f) => f.instance !== instance);
    this.save();
  }
  save() {
    if (this.file) saveJson(this.file, { failures: this.failures });
  }
}

// ---- presets -----------------------------------------------------------------
// Named bundles of settings, stored by NAME (never by list index) so they work
// across HQPlayers and modes, and resolved against the HQPlayer at apply time.

class PresetStore {
  /**
   * file null = memory only (tests). `validate` checks each stored entry's
   * settings with the same rules as a change; an invalid entry is dropped and
   * logged, and the rest load.
   */
  constructor(file, validate) {
    this.file = file || null;
    this.presets = [];
    if (!this.file) return;
    for (const p of loadList(this.file, "presets")) {
      try {
        if (!p || typeof p.id !== "string" || typeof p.name !== "string") throw new Error("missing id or name");
        this.presets.push(validate ? Object.assign({}, p, { settings: validate(p.settings) }) : p);
      } catch (e) {
        console.error("[hqp] ignoring invalid preset " + JSON.stringify(p && p.name !== undefined ? p.name : p) +
                      " in " + this.file + ": " + e.message);
      }
    }
  }
  list() {
    return this.presets;
  }
  get(id) {
    const p = this.presets.find((x) => x.id === id);
    if (!p) throw new HttpError(404, "unknown preset");
    return p;
  }
  create(name, settings) {
    const now = new Date().toISOString();
    const p = { id: crypto.randomUUID().slice(0, 8), name: this.checkName(name), settings, createdAt: now, updatedAt: now };
    this.presets.push(p);
    this.save();
    return p;
  }
  update(id, patch) {
    const p = this.get(id);
    if (patch.name !== undefined) p.name = this.checkName(patch.name, id);
    if (patch.settings !== undefined) p.settings = patch.settings;
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }
  remove(id) {
    this.get(id);
    this.presets = this.presets.filter((x) => x.id !== id);
    this.save();
  }
  checkName(name, exceptId) {
    const n = String(name || "").trim();
    if (!n || n.length > 64) throw new HttpError(400, "name must be 1–64 characters");
    if (this.presets.some((x) => x.id !== exceptId && x.name.toLowerCase() === n.toLowerCase()))
      throw new HttpError(409, 'a preset named "' + n + '" already exists');
    return n;
  }
  save() {
    if (this.file) saveJson(this.file, { presets: this.presets });
  }
}

module.exports = { HttpError, loadList, LearnedStore, PresetStore };
