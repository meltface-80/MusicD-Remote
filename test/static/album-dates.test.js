"use strict";
/*
 * album-dates.test.js — the release date survives a restart.
 *
 * v1.8.60 made the Library's date sort order by DAY: setAlbumYear keeps the
 * finer date beside the year (albumDateCache) and which source stated it
 * (albumDateSource), and album_years gained `date` and `date_src` columns to
 * hold them. The day's source matters as much as the day: without it, the day
 * is judged by the YEAR's source after a restart, and a better source for the
 * day is refused again — the defect the v1.8.60 review found in memory.
 *
 * The unit suite runs setAlbumYear against a fake statement — there is no
 * SQLite in it — so it proves the date is HANDED to the insert,
 * and nothing about whether the schema, the insert and the startup read agree
 * with each other.
 *
 * Each half failing alone is silent. A migration without the read-back loses
 * every date on restart, and the sort quietly degrades to years until the next
 * favourites read refills what it can (file-tag and MusicBrainz dates do not
 * come back until the next /music walk or the album is reopened). An insert
 * that names a column the migration never added throws inside openLabelsDb and
 * takes the whole labels database down with it.
 *
 * WHY A GREP: all three live inside openLabelsDb in a module that opens a
 * database and pairs with Roon on require. Comment lines are skipped, so the
 * comments explaining the column do not satisfy the checks by themselves.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "index.js");
const LINES = fs.readFileSync(SRC, "utf8").split("\n");
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const CODE = LINES.filter((l) => !isComment(l)).join("\n");

test("album_years carries the release date: migrated, written, and read back", () => {
  assert.match(CODE, /ALTER TABLE album_years ADD COLUMN date TEXT/,
    "no migration adds album_years.date — an existing install has nowhere to keep a date");
  assert.match(CODE, /ALTER TABLE album_years ADD COLUMN date_src TEXT/,
    "no migration adds album_years.date_src — the day's source is lost on restart");

  const insert = /INSERT OR REPLACE INTO album_years \(([^)]*)\) VALUES \(([^)]*)\)/.exec(CODE);
  assert.ok(insert, "the album_years insert statement was not found");
  const cols = insert[1].split(",").map((s) => s.trim());
  const marks = insert[2].split(",").map((s) => s.trim());
  assert.deepEqual(cols, ["key", "year", "src", "date", "date_src"]);
  assert.equal(marks.length, cols.length, "the insert's placeholders do not match its columns");

  // Every call writes all five, in that order — setAlbumYear is the only one.
  const runs = CODE.match(/stmtInsertYear\.run\(([^)]*)\)/g) || [];
  assert.ok(runs.length >= 1, "nothing writes album_years");
  for (const r of runs) {
    const args = r.slice(r.indexOf("(") + 1, -1).split(",").map((s) => s.trim());
    assert.equal(args.length, 5, "an album_years write does not pass the date and its source: " + r);
  }

  assert.match(CODE, /SELECT key, year, src, date, date_src FROM album_years/,
    "startup does not read album_years.date and date_src — every date is lost on restart");
  assert.match(CODE, /albumDateCache\.set\(r\.key, r\.date\)/,
    "startup reads the date column but never puts it in albumDateCache");
  assert.match(CODE, /albumDateSource\.set\(r\.key, r\.date_src\)/,
    "startup reads date_src but never puts it in albumDateSource");
});
