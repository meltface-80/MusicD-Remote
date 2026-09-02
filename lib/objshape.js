"use strict";
/*
 * objshape.js — list every field an object actually carries, as dotted paths.
 *
 * WHY THIS EXISTS: Roon's extension API is thinly documented, and /api/zone-state
 * only projects the fields this app already knows about — so anything the Core
 * sends beyond that set is invisible from inside the app. Before building the
 * streaming waveform on an INFERENCE about where the audio comes from (the
 * favourites proxy in albumSource), it is worth knowing whether Roon states it
 * outright in a field nobody here has looked at.
 *
 * Raw JSON is the wrong shape for that question: a zone object is hundreds of
 * lines and the answer, if it is there at all, is one key. A sorted list of
 * every path with its type and a short sample is how you spot `source`,
 * `provider`, `service` or `stream_type` at a glance.
 *
 * Pure, so it is testable without a Core. Nothing here does I/O.
 */

// Deep enough for Roon's nesting (zone → now_playing → three_line → line1) with
// room to spare, shallow enough that a pathological object cannot spin.
const MAX_DEPTH = 8;
// A sample is a hint about the value, not the value. Longer than this and the
// listing stops being scannable, which is its whole purpose.
const SAMPLE_CHARS = 60;

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A short, single-line, quote-free rendering of a leaf value. */
function sample(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") {
    const flat = v.replace(/\s+/g, " ").trim();
    return flat.length > SAMPLE_CHARS ? flat.slice(0, SAMPLE_CHARS) + "…" : flat;
  }
  if (typeof v === "object") return "";   // containers are described, not sampled
  return String(v);
}

/** Plain objects only. A Date, a Buffer or a class instance is a leaf. */
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {*} root
 * @param {object} [opts]
 * @param {number} [opts.maxDepth]
 * @returns {Array<{path:string,type:string,sample:string}>} sorted by path
 *
 * Arrays are reported as one entry for the array itself (carrying its length)
 * plus the shape of the FIRST element only. A 200-item queue described 200 times
 * over is the wall of JSON this exists to replace, and every item has the same
 * shape anyway.
 *
 * Cycles are marked rather than followed — Roon's payloads are JSON and cannot
 * contain one, but this is a diagnostic and a diagnostic that hangs the server
 * is worse than no diagnostic.
 */
function keyPaths(root, opts) {
  const maxDepth = (opts && opts.maxDepth) || MAX_DEPTH;
  const out = [];
  const seen = new Set();

  function walk(v, path, depth) {
    const t = typeOf(v);

    if (t === "object" || t === "array") {
      if (seen.has(v)) { out.push({ path, type: "cycle", sample: "" }); return; }
      if (depth >= maxDepth) { out.push({ path, type: t, sample: "(too deep)" }); return; }
      seen.add(v);
    }

    if (t === "array") {
      out.push({ path, type: "array", sample: "length " + v.length });
      if (v.length) walk(v[0], path + "[0]", depth + 1);
      seen.delete(v);
      return;
    }

    if (isPlainObject(v)) {
      const keys = Object.keys(v);
      out.push({ path, type: "object", sample: keys.length + " keys" });
      for (const k of keys) walk(v[k], path ? path + "." + k : k, depth + 1);
      seen.delete(v);
      return;
    }

    // Everything else is a leaf. A non-plain object — a Date, a Buffer, a class
    // instance — is reported by its CONSTRUCTOR and stringified: walking it
    // would find no enumerable keys and report "object, 0 keys", losing the
    // value completely, which is the one thing this listing must never do.
    if (t === "object") {
      const name = (v.constructor && v.constructor.name) || "object";
      out.push({ path, type: name, sample: sample(String(v)) });
      seen.delete(v);
      return;
    }
    out.push({ path, type: t, sample: sample(v) });
  }

  walk(root, "", 0);
  // The root's own entry has an empty path and says nothing useful.
  const rows = out.filter(r => r.path !== "");
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

/**
 * The same listing as one string, ready to paste into a message.
 * Padded so the types line up, because the eye scans the type column.
 */
function formatPaths(rows) {
  if (!rows.length) return "(nothing)";
  const w = rows.reduce((m, r) => Math.max(m, r.path.length), 0);
  const t = rows.reduce((m, r) => Math.max(m, r.type.length), 0);
  return rows
    .map(r => {
      // `seen` only exists on a union, and it is the column that matters there:
      // a field carried by some payloads and not others is the whole signal.
      // The first version of this computed it and never printed it, which made
      // the union look like a plain listing.
      const n = r.seen === undefined ? "" : "x" + r.seen + "  ";
      return r.path.padEnd(w) + "  " + r.type.padEnd(t) + "  " + n + (r.sample || "");
    })
    .map(l => l.replace(/\s+$/, ""))
    .join("\n");
}

/**
 * The union of the field paths across several objects of the same kind.
 *
 * One sample answers "what did this payload carry"; the union answers "what can
 * this KIND of payload ever carry", which is the actual question when hunting
 * for a field that may only appear under some conditions — a source marker that
 * shows up for a streamed track and not a local one, say. `seen` counts how many
 * of the samples carried each path, so a field present in only one of them
 * stands out as exactly the interesting case.
 *
 * @param {Array} objects
 * @returns {Array<{path,type,sample,seen}>} sorted by path
 */
function unionPaths(objects, opts) {
  const byPath = new Map();
  const list = Array.isArray(objects) ? objects : [];
  for (const o of list) {
    for (const r of keyPaths(o, opts)) {
      const prev = byPath.get(r.path);
      if (prev) {
        prev.seen++;
        // Keep the first non-empty sample: a field that is empty in one payload
        // and populated in another is most usefully shown populated.
        if (!prev.sample && r.sample) prev.sample = r.sample;
        if (prev.type !== r.type && prev.type.indexOf(r.type) === -1) {
          prev.type += "|" + r.type;   // it is not always the same type
        }
      } else {
        byPath.set(r.path, { path: r.path, type: r.type, sample: r.sample, seen: 1 });
      }
    }
  }
  const rows = [...byPath.values()];
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

module.exports = { keyPaths, unionPaths, formatPaths, MAX_DEPTH, SAMPLE_CHARS };
