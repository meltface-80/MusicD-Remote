"use strict";
/*
 * release-days-wiring.test.js — the v1.8.61 pieces are actually CALLED.
 *
 * test/unit/releasedays.test.js proves each rule, extracted and run on its
 * own: the MusicBrainz day lookups, the browse-root read, the tag reader.
 * What an extracted function cannot show is whether the server ever calls it —
 * and every one of these fails silently when it is not called: the sort just
 * stays wrong, and the badges stay Q, exactly as reported.
 *
 * WHY A GREP: the call sites are inside the Roon pairing callback, the Rescan
 * chain, an Express route and openLabelsDb, none of which runs without a Core
 * or a database on disk. Comment lines are skipped so the explanations cannot
 * satisfy the checks by themselves.
 */
const test = require("node:test");
const assert = require("node:assert");
// indexSource() rather than a direct read, so MUSICD_INDEX_JS still points this
// file at a mutated copy — a test that reads index.js itself silently opts out
// of mutation checking and can never be shown to bite.
const { indexSource } = require("../lib/extract");

const SRC = indexSource();
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const CODE = SRC.split("\n").filter((l) => !isComment(l)).join("\n");

// The body of a function or callback, from its opening line to the first line
// that closes it at the same indentation.
function bodyOf(startRe) {
  const lines = CODE.split("\n");
  const i = lines.findIndex((l) => startRe.test(l));
  assert.ok(i >= 0, "not found: " + startRe);
  const indent = lines[i].match(/^\s*/)[0].length;
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (/^\s*}/.test(l) && l.match(/^\s*/)[0].length === indent) break;
    out.push(l);
  }
  return out.join("\n");
}

test("pairing reads Roon's services", () => {
  const paired = bodyOf(/^\s*core_paired: function/);
  assert.match(paired, /probeRoonServices\(/,
    "pairing never reads which services Roon has — every Q badge stays as it was");
});

test("a Rescan re-reads Roon's services", () => {
  const chain = bodyOf(/^async function rescanChain\(/);
  assert.match(chain, /probeRoonServices\(/);
});

test("a Release date view starts the MusicBrainz day lookups", () => {
  const route = bodyOf(/^app\.get\("\/api\/library\/albums"/);
  assert.match(route, /req\.query\.sort === "year"\) kickReleaseDayFill\(/,
    "nothing starts the day lookups — year-only albums stay below every dated album");
});

test("the day lookups are remembered across restarts", () => {
  assert.match(CODE, /CREATE TABLE IF NOT EXISTS date_fill \(/);
  assert.match(CODE, /INSERT OR REPLACE INTO date_fill \(key, ts, day\) VALUES \(\?, \?, \?\)/);
  assert.match(CODE, /SELECT key, ts, day FROM date_fill/,
    "the lookups are written and never read back — every restart would ask MusicBrainz again");
});

test("v1.8.60's album-page days are cleared once, before anything reads them", () => {
  // The order is the whole mechanism. Asked AFTER the schema runs, date_fill
  // always exists and the clean-up never happens; run BEFORE the date_src
  // migration, a database from v1.8.59 has no such column and the UPDATE
  // throws; run AFTER the read-back, the caches keep every day it cleared
  // until the next restart — which then finds date_fill and never clears again.
  const open = bodyOf(/^function openLabelsDb\(/);
  const at = (re) => {
    const m = re.exec(open);
    assert.ok(m, "not found in openLabelsDb: " + re);
    return m.index;
  };
  const asked   = at(/const firstStartWithDateFill = !hasDateFillTable\(labelsDb\)/);
  const created = at(/CREATE TABLE IF NOT EXISTS date_fill \(/);
  const column  = at(/ALTER TABLE album_years ADD COLUMN date_src TEXT/);
  const cleared = at(/if \(firstStartWithDateFill\) \{[\s\S]*?dropReleaseDays\(labelsDb\)/);
  const readBack = at(/SELECT key, year, src, date, date_src FROM album_years/);
  assert.ok(asked < created, "date_fill is looked for after the schema has created it");
  assert.ok(column < cleared, "the clean-up runs before the column it clears exists");
  assert.ok(cleared < readBack, "the clean-up runs after the caches were loaded");
});

test("the lookups start by themselves when albums can have become year-only (v1.8.62)", () => {
  const walk = bodyOf(/^async function runFileMetadataScan\(/);
  assert.match(walk, /harvestAlbumYears\("file tags"\);\s*kickReleaseDayFill\("after the \/music walk", true\)/,
    "the /music walk does not start the day lookups — they wait for someone to sort by date");
  const favs = bodyOf(/^async function refreshStreamAlbumKeys\(/);
  assert.match(favs, /harvestAlbumYears\("stream favourites: " \+ reason\);\s*kickReleaseDayFill\("after the favourites read", true\)/,
    "the favourites read does not start the day lookups");
});

test("the album page is sent the sort's date, its day looked up first (v1.8.62)", () => {
  const route = bodyOf(/^app\.get\("\/api\/album\/extras"/);
  const ask  = route.indexOf('const dayLookup = req.query.day === "1" ? lookUpAlbumDay(exKey, title, artist) : null');
  const both = route.indexOf("await Promise.all(");
  assert.ok(ask >= 0, "the day lookup is not limited to the album view (day=1)");
  assert.ok(both > ask, "the day is not asked for alongside the rest of the page");
  assert.match(route, /notePageYear\(exKey, year\)/,
    "the page's loose MusicBrainz year is not written as a gap-filling guess");
  assert.doesNotMatch(route, /setAlbumYear\(exKey, year, \{ src: "release" \}\)/,
    "the page's loose year still replaces catalogue and TIDAL years, and the day found with them");
  assert.match(route, /Promise\.race\(\[dayLookup,/,
    "the page waits for MusicBrainz without a limit");
  assert.equal((route.match(/lookUpAlbumDay\(/g) || []).length, 1,
    "a second lookup would run the strict matcher against the page's loose year");
  assert.match(route, /release_date: storedReleaseDate\(exKey\)/,
    "the album page is not sent the date the sort uses");
});
