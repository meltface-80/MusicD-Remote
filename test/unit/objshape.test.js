"use strict";
// ---------------------------------------------------------------------------
// v1.8.1: the field-path listing behind /api/debug/zone-dump.
//
// The point of this helper is to make ONE key findable in a large payload —
// whether Roon states the playback source outright somewhere nobody here has
// looked. So the properties worth pinning are: nothing is silently dropped, a
// deep path is reported in full, and no shape of input can hang the server.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { keyPaths, unionPaths, formatPaths } = require("../../lib/objshape");

const pathsOf = (o) => keyPaths(o).map(r => r.path);
const row = (o, p) => keyPaths(o).find(r => r.path === p);

test("every leaf is listed, at its full path", () => {
  const zone = {
    zone_id: "z1",
    now_playing: { three_line: { line1: "Sunday" }, length: 285, seek_position: 40 },
  };
  const paths = pathsOf(zone);
  assert.deepEqual(paths, [
    "now_playing",
    "now_playing.length",
    "now_playing.seek_position",
    "now_playing.three_line",
    "now_playing.three_line.line1",
    "zone_id",
  ]);
});

test("THE one: a field nobody projects still shows up", () => {
  // The whole reason this exists. /api/zone-state hand-picks its fields, so a
  // key like this is invisible from inside the app — the listing must surface
  // it without being told to look for it.
  const zone = { zone_id: "z1", now_playing: { source: "qobuz", line1: "Sunday" } };
  assert.ok(pathsOf(zone).includes("now_playing.source"),
    "an unknown field was not listed — this helper would not answer the question it exists for");
  assert.equal(row(zone, "now_playing.source").sample, "qobuz");
});

test("types are reported, so an empty string is not mistaken for a missing key", () => {
  const o = { a: "", b: null, c: 0, d: false, e: {}, f: [] };
  assert.equal(row(o, "a").type, "string");
  assert.equal(row(o, "b").type, "null");
  assert.equal(row(o, "c").type, "number");
  assert.equal(row(o, "d").type, "boolean");
  assert.equal(row(o, "e").type, "object");
  assert.equal(row(o, "f").type, "array");
  // A key present but empty is exactly the case where the sample alone lies.
  assert.equal(row(o, "a").sample, "");
});

test("an array is described once, with its length and its first element's shape", () => {
  // A 200-item queue described 200 times over is the wall of JSON this replaces.
  const o = { items: [{ id: 1, title: "a" }, { id: 2, title: "b" }, { id: 3, title: "c" }] };
  const paths = pathsOf(o);
  assert.deepEqual(paths, ["items", "items[0]", "items[0].id", "items[0].title"]);
  assert.match(row(o, "items").sample, /length 3/,
    "the array's length is the one thing lost by only describing element 0");
});

test("an empty array is still listed", () => {
  const o = { outputs: [] };
  assert.deepEqual(pathsOf(o), ["outputs"]);
  assert.match(row(o, "outputs").sample, /length 0/);
});

test("long strings are truncated but marked", () => {
  const long = "x".repeat(400);
  const r = row({ bio: long }, "bio");
  assert.ok(r.sample.length < 100, `sample is ${r.sample.length} chars — the listing stops being scannable`);
  assert.ok(r.sample.endsWith("…"), "a truncated sample must say it was truncated");
});

test("whitespace in a sample is flattened to one line", () => {
  // A multi-line value would otherwise break the one-row-per-field layout that
  // makes the listing scannable.
  const r = row({ note: "one\ntwo\t three" }, "note");
  assert.equal(r.sample, "one two three");
});

test("a cycle is marked, not followed", () => {
  const a = { name: "a" };
  a.self = a;
  const paths = pathsOf(a);
  assert.ok(paths.includes("self"), "the cycling key was dropped entirely");
  assert.equal(row(a, "self").type, "cycle");
});

test("a repeated (but not circular) object is still described at each path", () => {
  // Sharing one object under two keys is not a cycle, and reporting the second
  // as "cycle" would hide real fields. This is why the walk un-marks on the way
  // back out rather than keeping a global seen-set.
  const shared = { k: 1 };
  const paths = pathsOf({ a: shared, b: shared });
  assert.ok(paths.includes("a.k"), "the first use lost its fields");
  assert.ok(paths.includes("b.k"), "the second use of a shared object was reported as a cycle");
});

test("depth is capped, and the cap is visible rather than silent", () => {
  let deep = { end: "here" };
  for (let i = 0; i < 20; i++) deep = { down: deep };
  const rows = keyPaths(deep, { maxDepth: 4 });
  assert.ok(rows.some(r => r.sample === "(too deep)"),
    "the walk was truncated with no sign that anything was left out");
  assert.ok(rows.every(r => r.path.split(".").length <= 5));
});

test("a non-plain object is a leaf, and keeps its value", () => {
  // A Date has no enumerable own keys, so walking it would report "object,
  // 0 keys" and lose the value entirely — the one thing this listing must
  // never do.
  const rows = keyPaths({ when: new Date("2026-01-01T00:00:00Z") });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "when");
  assert.equal(rows[0].type, "Date", "the constructor is what identifies it");
  assert.match(rows[0].sample, /2026/, "the value was dropped");
});

test("a primitive or null root does not throw", () => {
  // The endpoint hands this whatever Roon gave it, including nothing at all.
  assert.deepEqual(keyPaths(null), []);
  assert.deepEqual(keyPaths(undefined), []);
  assert.deepEqual(keyPaths("hello"), []);
  assert.deepEqual(keyPaths(7), []);
});

test("paths come back sorted, so two dumps can be diffed", () => {
  const rows = keyPaths({ zulu: 1, alpha: 2, mike: 3 });
  assert.deepEqual(rows.map(r => r.path), ["alpha", "mike", "zulu"]);
});

test("formatPaths lines the types up and survives an empty listing", () => {
  const rows = keyPaths({ a: 1, longer_key: "x" });
  const lines = formatPaths(rows).split("\n");
  assert.equal(lines.length, 2);
  // The type column starts at the same offset on every row. Located by where
  // each row's own type actually begins — an earlier version of this looked for
  // the first double space, which lands INSIDE the padding on a short path and
  // so reported a misalignment that was not there.
  const at = lines.map((l, i) => l.indexOf(rows[i].type));
  assert.equal(at[0], at[1],
    `types start at columns ${at[0]} and ${at[1]} — the column is ragged`);
  assert.equal(formatPaths([]), "(nothing)");
});

// --- unionPaths ------------------------------------------------------------
// One sample says what a payload carried; the union says what this KIND of
// payload can ever carry — which is the actual question when hunting a field
// that only appears under some conditions.

test("THE one: a field present in only some samples is kept, and counted", () => {
  // Exactly the shape a source marker would have: there for a streamed track,
  // absent for a local one. Intersecting would throw away the answer.
  const local  = { line1: "Sunday", length: 285 };
  const stream = { line1: "Slip Away", length: 366, source: "qobuz" };
  const rows = unionPaths([local, stream]);
  const src = rows.find(r => r.path === "source");
  assert.ok(src, "the field that appeared in only one sample was dropped");
  assert.equal(src.seen, 1, "seen must say how many samples carried it");
  assert.equal(src.sample, "qobuz");
  assert.equal(rows.find(r => r.path === "line1").seen, 2);
});

test("a populated sample beats an empty one", () => {
  // A field empty in the first payload and set in the second is most usefully
  // shown set — otherwise the listing says a field exists but never says what
  // goes in it.
  const rows = unionPaths([{ tag: "" }, { tag: "hi-res" }]);
  assert.equal(rows.find(r => r.path === "tag").sample, "hi-res");
});

test("a field that changes type says so rather than picking one", () => {
  const rows = unionPaths([{ v: 1 }, { v: "one" }]);
  assert.match(rows.find(r => r.path === "v").type, /number/);
  assert.match(rows.find(r => r.path === "v").type, /string/);
});

test("the same type twice does not stutter", () => {
  const rows = unionPaths([{ v: 1 }, { v: 2 }, { v: 3 }]);
  assert.equal(rows.find(r => r.path === "v").type, "number");
  assert.equal(rows.find(r => r.path === "v").seen, 3);
});

test("nulls, an empty list and a non-list are all survivable", () => {
  // The endpoint hands this whatever the ring holds, which early on is nothing.
  assert.deepEqual(unionPaths([]), []);
  assert.deepEqual(unionPaths(null), []);
  assert.deepEqual(unionPaths([null, undefined]), []);
  assert.deepEqual(unionPaths([null, { a: 1 }]).map(r => r.path), ["a"]);
});

test("the union is sorted, so two runs can be diffed", () => {
  const rows = unionPaths([{ zulu: 1 }, { alpha: 2 }, { mike: 3 }]);
  assert.deepEqual(rows.map(r => r.path), ["alpha", "mike", "zulu"]);
});

test("formatPaths renders a union without losing the counts to alignment", () => {
  const text = formatPaths(unionPaths([{ a: 1 }, { a: 1, b: 2 }]));
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /^a\s+number/m);
});
