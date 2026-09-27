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

const S = loadIndexFunctions(["hasDateFillTable", "dropReleaseDays", "dateFillHasYear",
                              "forgetLookedUpDays"], {});

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

// ---------------------------------------------------------------------------
// v1.8.63: v1.8.61-62 recorded each lookup without the year it asked about, so
// a retagged album stayed "asked" for a month; and before v1.8.62's fix their
// matcher could take a single's day. Once, every day those lookups found is
// asked for again, and the record of lookups starts over with years.
// ---------------------------------------------------------------------------
test("the first start of v1.8.63 asks v1.8.61-62's lookups again", async (t) => {
  if (!Database) {
    t.skip("better-sqlite3 is not installed here");
    return;
  }
  const db = v1860Db();
  // date_fill as v1.8.61-62 created it — historical, so written out here.
  db.exec("CREATE TABLE date_fill (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT)");
  const put = db.prepare("INSERT INTO album_years (key, year, src, date, date_src) VALUES (?, ?, ?, ?, ?)");
  put.run("mb||day",     "2026", "file", "2026-09-25", "release");  // MusicBrainz found exactly this
  put.run("qobuz||day",  "2026", "file", "2026-09-18", "release");  // a favourite's day, never looked up
  put.run("other||day",  "2026", "file", "2026-01-16", "release");  // looked up, but the day is another's
  put.run("tag||day",    "2026", "file", "2026-03-06", "file");
  put.run("miss||none",  "2025", "file", null, null);
  const fill = db.prepare("INSERT INTO date_fill (key, ts, day) VALUES (?, ?, ?)");
  fill.run("mb||day", 1, "2026-09-25");
  fill.run("other||day", 1, "2026-01-17");
  fill.run("miss||none", 1, null);

  await t.test("a database from v1.8.61-62 has no year column", () => {
    assert.equal(S.dateFillHasYear(db), false);
  });

  await t.test("the days the lookups found go; every other day and every year stays", () => {
    assert.equal(S.forgetLookedUpDays(db), 1);
    const rows = Object.fromEntries(db.prepare("SELECT key, year, date, date_src FROM album_years")
      .all().map(r => [r.key, [r.year, r.date, r.date_src]]));
    assert.deepEqual(rows, {
      "mb||day":    ["2026", null, null],
      "qobuz||day": ["2026", "2026-09-18", "release"],
      "other||day": ["2026", "2026-01-16", "release"],
      "tag||day":   ["2026", "2026-03-06", "file"],
      "miss||none": ["2025", null, null],
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM date_fill").get().n, 0,
      "the old record of lookups was kept, so a retagged album still waits out its month");
  });

  await t.test("once the column is added, it never runs again", () => {
    db.exec("ALTER TABLE date_fill ADD COLUMN year TEXT");
    assert.equal(S.dateFillHasYear(db), true);
  });
});
