"use strict";
// ---------------------------------------------------------------------------
// v1.7.41: how Smart Picks are stored and read back.
//
// The pure selection logic is covered in smartpicks.test.js. This file covers
// the part that logic cannot see: the SQL. It builds the REAL schema — read out
// of index.js rather than retyped — into an in-memory database and exercises
// the actual statements.
//
// It exists because of a bug no other kind of test could catch. The build
// assigns the five adjacent picks ranks 0-4 and the stretch pick rank 5, then
// the read sorted "ORDER BY kind DESC, rank ASC". SQLite compares kind as text,
// "stretch" sorts after "adjacent", and DESC therefore lifted the stretch pick
// above every adjacent one — so the single pick chosen for being UNLIKE the
// library led the Home row and the screen, every day, inverting the rank the
// writer had just assigned. The DOM test could not see it (its stub supplies
// its own order) and the unit tests could not see it (no SQL involved).
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
// indexSource() rather than a direct read, so MUSICD_INDEX_JS still points this
// file at a mutated copy — a test that reads index.js itself silently opts out
// of mutation checking and can never be shown to bite.
const { indexSource } = require("../lib/extract");
const SRC = indexSource();

let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  // Optional in environments without the native build; the suite skips below
  // rather than failing for a reason unrelated to the code under test.
}

// Pull a CREATE TABLE statement out of index.js so the test cannot drift from
// the shipping schema. A retyped copy would keep passing after a column change.
function ddl(table) {
  const re = new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\s*\\([\\s\\S]*?\\n\\s*\\);", "m");
  const m = re.exec(SRC);
  if (!m) throw new Error("no CREATE TABLE for " + table + " found in index.js");
  return m[0];
}

// The read query, also taken from the shipping source rather than retyped.
function readQuery() {
  const m = /"(SELECT \* FROM smart_picks WHERE day = \?[^"]*)"/.exec(SRC);
  if (!m) throw new Error("the smart_picks read query was not found in index.js");
  return m[1];
}

function freshDb() {
  const db = new Database(":memory:");
  db.exec(ddl("smart_picks"));
  db.exec(ddl("smart_pick_seen"));
  db.exec(ddl("smart_pick_blocks"));
  db.exec(ddl("smart_cache"));
  return db;
}

// Insert in the order the build produces them: adjacent first, stretch last.
function seed(db) {
  const ins = db.prepare(
    "INSERT OR REPLACE INTO smart_picks " +
    "(day, kind, rank, mbid, artist, canon, album, album_id, service, image, reason, genre, ts) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const rows = [
    ["adjacent", 0, "Labradford"], ["adjacent", 1, "Bowery Electric"],
    ["adjacent", 2, "Seefeel"],    ["adjacent", 3, "Windy & Carl"],
    ["adjacent", 4, "Loscil"],     ["stretch",  5, "Camaron de la Isla"],
  ];
  for (const [kind, rank, artist] of rows) {
    ins.run("2026-08-05", kind, rank, "mb-" + rank, artist, artist.toLowerCase(),
            "Album " + rank, "id" + rank, "qobuz", "", "reason", "", Date.now());
  }
  return db;
}

test("smart_picks reads back in the order the build wrote", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("the adjacent picks come first and the stretch pick last", () => {
    // THE one. Against the previous query this returned the stretch pick first.
    const db = seed(freshDb());
    const got = db.prepare(readQuery()).all("2026-08-05");
    assert.deepEqual(got.map(r => r.kind),
      ["adjacent", "adjacent", "adjacent", "adjacent", "adjacent", "stretch"],
      "the stretch pick was not last — it is written at the highest rank, so a " +
      "read that reorders it is contradicting the writer");
    assert.equal(got[0].artist, "Labradford");
    db.close();
  });

  await t.test("rank decides the order, not insertion order", () => {
    // Guards the opposite mistake: dropping ORDER BY entirely would pass the
    // test above purely because SQLite happened to return insertion order.
    const db = freshDb();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO smart_picks " +
      "(day, kind, rank, mbid, artist, canon, album, album_id, service, image, reason, genre, ts) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("2026-08-05", "adjacent", 2, "", "Third",  "third",  "", "", "", "", "", "", 1);
    ins.run("2026-08-05", "adjacent", 0, "", "First",  "first",  "", "", "", "", "", "", 1);
    ins.run("2026-08-05", "adjacent", 1, "", "Second", "second", "", "", "", "", "", "", 1);
    const got = db.prepare(readQuery()).all("2026-08-05");
    assert.deepEqual(got.map(r => r.artist), ["First", "Second", "Third"]);
    db.close();
  });

  await t.test("another day's picks are not returned", () => {
    const db = seed(freshDb());
    assert.equal(db.prepare(readQuery()).all("2026-08-04").length, 0);
    db.close();
  });

  await t.test("the day key sorts correctly as text", () => {
    // The column is TEXT, so a zero-padded key is what makes date order and
    // string order the same thing. "2026-8-4" would sort after "2026-12-01".
    const db = freshDb();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO smart_picks " +
      "(day, kind, rank, mbid, artist, canon, album, album_id, service, image, reason, genre, ts) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const d of ["2026-12-01", "2026-08-05", "2026-01-31"]) {
      ins.run(d, "adjacent", 0, "", "A", "a", "", "", "", "", "", "", 1);
    }
    const days = db.prepare("SELECT day FROM smart_picks ORDER BY day ASC").all().map(r => r.day);
    assert.deepEqual(days, ["2026-01-31", "2026-08-05", "2026-12-01"]);
    db.close();
  });
});

test("the schema enforces one row per day/kind/rank", { concurrency: 1 }, async (t) => {
  if (!Database) { t.skip("better-sqlite3 unavailable"); return; }

  await t.test("re-running a build replaces rather than duplicates", () => {
    // persistSmartPicks deletes the day first, but the primary key is the
    // backstop: without it a retried build would double the row and the Home
    // carousel would show each pick twice.
    const db = seed(freshDb());
    const ins = db.prepare(
      "INSERT OR REPLACE INTO smart_picks " +
      "(day, kind, rank, mbid, artist, canon, album, album_id, service, image, reason, genre, ts) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("2026-08-05", "adjacent", 0, "", "Replaced", "replaced", "", "", "", "", "", "", 2);
    const got = db.prepare(readQuery()).all("2026-08-05");
    assert.equal(got.length, 6, "the row was duplicated instead of replaced");
    assert.equal(got[0].artist, "Replaced");
    db.close();
  });

  await t.test("blocking an artist removes every pick of theirs", () => {
    // The block route deletes by canon across all days, so a blocked artist
    // disappears at once rather than sitting there until tomorrow's build.
    const db = seed(freshDb());
    db.prepare("DELETE FROM smart_picks WHERE canon = ?").run("labradford");
    const got = db.prepare(readQuery()).all("2026-08-05");
    assert.equal(got.length, 5);
    assert.ok(!got.some(r => r.canon === "labradford"));
    db.close();
  });

  await t.test("a blocked artist is stored once, however often it is tapped", () => {
    const db = freshDb();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO smart_pick_blocks (canon, name, ts) VALUES (?, ?, ?)");
    ins.run("labradford", "Labradford", 1);
    ins.run("labradford", "Labradford", 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM smart_pick_blocks").get().n, 1);
    db.close();
  });

  await t.test("the seen list keeps the most recent timestamp per artist", () => {
    // smartSeenSet filters on ts, so an artist shown again must push their
    // window forward rather than keeping the first date.
    const db = freshDb();
    const ins = db.prepare(
      "INSERT OR REPLACE INTO smart_pick_seen (canon, ts) VALUES (?, ?)");
    ins.run("loscil", 1000);
    ins.run("loscil", 5000);
    assert.equal(db.prepare("SELECT ts FROM smart_pick_seen WHERE canon = ?").get("loscil").ts, 5000);
    db.close();
  });
});
