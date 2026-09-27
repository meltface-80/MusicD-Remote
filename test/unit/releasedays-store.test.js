"use strict";
// ---------------------------------------------------------------------------
// v1.8.61: the days v1.8.60's album page stored are cleared once, in SQLite.
//
// v1.8.60's album page took the EARLIEST of five loose MusicBrainz hits for a
// title and stored its day — as often the lead single's as the album's — under
// the source name "release", the same name the Qobuz favourites' days carry.
// Once an album has a day nothing of the same rank corrects it and the day
// lookups pass it by, so the wrong day would stand for good. dropReleaseDays
// clears every "release" day, once, keeping every year; the favourites restate
// theirs at every start and the lookups ask about the rest, strictly.
//
// Against a real SQLite database because the UPDATE is the whole mechanism,
// and a retyped schema would keep passing after a column changed: the DDL and
// the migrations are read out of index.js.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource } = require("../lib/extract");
const SRC = indexSource();

let Database = null;
try { Database = require("better-sqlite3"); } catch (e) {
  // Optional in environments without the native build; the suite skips below
  // rather than failing for a reason unrelated to the code under test.
}

function ddl(table) {
  const re = new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\s*\\([\\s\\S]*?\\n\\s*\\);", "m");
  const m = re.exec(SRC);
  if (!m) throw new Error("no CREATE TABLE for " + table + " found in index.js");
  return m[0];
}

// album_years as a v1.8.60 database has it: the original table plus the three
// columns added since, by the shipping migrations.
function v1860Db() {
  const db = new Database(":memory:");
  db.exec(ddl("album_years"));
  const alters = SRC.match(/ALTER TABLE album_years ADD COLUMN \w+ TEXT/g) || [];
  assert.deepEqual(alters, [
    "ALTER TABLE album_years ADD COLUMN src TEXT",
    "ALTER TABLE album_years ADD COLUMN date TEXT",
    "ALTER TABLE album_years ADD COLUMN date_src TEXT",
  ], "the album_years migrations changed — this fixture no longer builds what installs have");
  for (const a of alters) db.exec(a);
  return db;
}

const S = loadIndexFunctions(["hasDateFillTable", "dropReleaseDays"], {});

test("the first start of v1.8.61 clears v1.8.60's release days", async (t) => {
  if (!Database) {
    t.skip("better-sqlite3 is not installed here");
    return;
  }
  const db = v1860Db();
  const put = db.prepare("INSERT INTO album_years (key, year, src, date, date_src) VALUES (?, ?, ?, ?, ?)");
  put.run("loose||page", "2026", "file", "2026-07-04", "release");   // v1.8.60's album page
  put.run("tag||day", "2026", "file", "2026-09-25", "file");         // a tag's own day
  put.run("tidal||day", "2025", "release", "2025-03-01", "edition"); // TIDAL's
  put.run("year||only", "2024", "release", null, null);
  put.run("fav||day", "1999", "release", "1999-05-01", "release");   // a favourite's: restated at start

  await t.test("a database v1.8.61 has never opened has no date_fill", () => {
    assert.equal(S.hasDateFillTable(db), false);
  });

  await t.test("every release day goes, and nothing else", () => {
    assert.equal(S.dropReleaseDays(db), 2);
    const rows = Object.fromEntries(db.prepare("SELECT key, year, src, date, date_src FROM album_years")
      .all().map(r => [r.key, [r.year, r.src, r.date, r.date_src]]));
    assert.deepEqual(rows, {
      "loose||page": ["2026", "file", null, null],
      "tag||day":    ["2026", "file", "2026-09-25", "file"],
      "tidal||day":  ["2025", "release", "2025-03-01", "edition"],
      "year||only":  ["2024", "release", null, null],
      "fav||day":    ["1999", "release", null, null],
    }, "a year was touched, or a day from a source other than 'release' was cleared");
  });

  await t.test("once the schema has run, it is never asked again", () => {
    db.exec(ddl("date_fill"));
    assert.equal(S.hasDateFillTable(db), true);
  });
});

test("a database from before v1.8.60 has no days to clear", async (t) => {
  if (!Database) {
    t.skip("better-sqlite3 is not installed here");
    return;
  }
  const db = v1860Db();
  db.prepare("INSERT INTO album_years (key, year, src) VALUES (?, ?, ?)").run("a||b", "1994", "file");
  assert.equal(S.dropReleaseDays(db), 0);
  assert.deepEqual(db.prepare("SELECT year, src, date, date_src FROM album_years").get(),
    { year: "1994", src: "file", date: null, date_src: null });
});
