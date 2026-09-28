"use strict";
// ---------------------------------------------------------------------------
// v1.8.65: live state — every screen shows what the server holds NOW.
//
// Reported with two screenshots: the Home "Library" row read Ride Lonesome,
// Hope Is the Thing with Feathers, You May Offend — with Q badges — while the
// Library wall it heads, sorted the same way (Release date, newest first),
// read Los Ojos Del Cóndor, The Meaning of Flowers, Cursum Perficio, Pylon,
// Ride Lonesome, with none. "The home page must be a live screen. I should not
// have to leave a screen and then go back to see it updated. This live state
// applies to the whole extension."
//
// The row counted itself fresh whenever the SORT matched. A copy saved under
// the current sort was painted on every cold open and never asked again, so it
// showed that day's order and that day's badges for as long as the sort was
// left alone — through upgrades, through release days arriving, through
// everything.
//
// These drive the real app against a stub server whose data and revisions the
// driver changes mid-test, and every assertion is about what is ON SCREEN
// after a change the user did nothing to cause.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const tile = (offset, title, subtitle) => ({ offset, title, subtitle, image_key: "k" + offset });
// The report's two lists. Ride Lonesome is in both, at the same offset, so it
// is the SAME tile before and after — which is what reuse is checked on.
const BEFORE = [
  tile(10, "Ride Lonesome", "Beck"),
  tile(11, "Hope Is the Thing with Feathers", "Rhiannon Giddens"),
  tile(12, "You May Offend", "The Proclaimers"),
];
const AFTER = [
  tile(20, "Los Ojos Del Cóndor", "Hermanos Gutiérrez"),
  tile(21, "The Meaning of Flowers", "Agnes Obel"),
  tile(22, "Cursum Perficio", "Anthrax"),
  tile(23, "Pylon", "Beabadoobee"),
  tile(10, "Ride Lonesome", "Beck"),
];
const RANDOM = [tile(30, "Smash", "Patricia Barber"), tile(31, "Time Stand Still", "Rush")];
const UNPLAYED = [tile(40, "Strictly Personal", "Captain Beefheart"), tile(41, "Green", "R.E.M.")];

const ZONE = (np, remaining) => ({
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  queue_items_remaining: remaining,
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false, volume: null }],
  now_playing: { line1: np, line2: "R.E.M.", line3: "Green", artists: [], length: 200, seek_position: 5 },
});

function stub(extra) {
  return `
window.__rev = { snapshot: "1", library: "1.0", dates: "0", plays: "0", settings: "0",
                 labels: "0.0.0", picks: "0", discover: "0", day: "2026-09-27" };
window.__libList = ${JSON.stringify(BEFORE)};
window.__asks = { lib: [], random: [], unplayed: [], queue: 0, live: 0, date: 0 };
window.__zone = ${JSON.stringify(ZONE("Pop Song 89", 2))};
window.__queue = { items: [
  { queue_item_id: 1, title: "Pop Song 89", subtitle: "R.E.M.", length: 200 },
  { queue_item_id: 2, title: "Get Up", subtitle: "R.E.M.", length: 160 },
  { queue_item_id: 3, title: "You Are the Everything", subtitle: "R.E.M.", length: 220 }
], history: [] };
window.__releaseDate = "2026";
// Per-endpoint delays, for the tests that need the network's ORDER to be the
// real one rather than the stub's (everything answers at once otherwise).
window.__delays = {};
function __route(url) {
  var q = new URLSearchParams(url.split("?")[1] || "");
  if (url.indexOf("/api/live") > -1) {
    window.__asks.live++;
    return window.__json({ rev: JSON.parse(JSON.stringify(window.__rev)) });
  }
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 5, dated: 5, decades: [], sources: [], hasPlays: true });
  if (url.indexOf("/api/library/albums") > -1) {
    var off = +q.get("offset") || 0, cnt = +q.get("count") || 60;
    window.__asks.lib.push({ sort: q.get("sort"), count: cnt, offset: off });
    var list = window.__libList;
    return window.__json({ albums: list.slice(off, off + cnt), offset: off, total: list.length });
  }
  // Recorded as "count:seed" — the Home rows ask for 30, the walls for more,
  // so one list tells the row and the wall apart.
  if (url.indexOf("/api/random-albums") > -1) {
    window.__asks.random.push(q.get("count") + ":" + q.get("seed"));
    return window.__json({ albums: ${JSON.stringify(RANDOM)}, total: 2,
                           filtered: !!q.get("filter_type") });
  }
  if (url.indexOf("/api/home/unplayed") > -1) {
    window.__asks.unplayed.push(q.get("count") + ":" + q.get("seed"));
    return window.__json({ albums: ${JSON.stringify(UNPLAYED)}, total: 2, months: 6 });
  }
  if (url.indexOf("/api/album/release-date") > -1) {
    window.__asks.date++;
    return window.__json({ release_date: window.__releaseDate });
  }
  if (url.indexOf("/api/album/extras") > -1)
    return window.__json({ year: 2026, release_date: window.__releaseDate });
  if (url.indexOf("/api/album") > -1)
    return window.__json({ title: "Ride Lonesome", subtitle: "Beck", image_key: "k10",
      actions: [{ kind: "play_now", title: "Play Now" }], tracks: [{ title: "One", subtitle: "Beck" }] });
  if (url.indexOf("/api/queue") > -1) {
    window.__asks.queue++;
    var body = JSON.parse(JSON.stringify(window.__queue));
    // A real queue read is a Core round trip. Held open when asked, so a
    // re-read that blanks the list or says "Loading…" first stays that way
    // long enough to be seen.
    if (!window.__queueDelay) return window.__json(body);
    return new Promise(function (res) {
      setTimeout(function () { res(new Response(JSON.stringify(body),
        { status: 200, headers: { "Content-Type": "application/json" } })); }, window.__queueDelay);
    });
  }
  if (url.indexOf("/api/zone-state") > -1) {
    // A playing zone's position moves on every read, the way Roon's does —
    // so a queue check that keyed on it would fire on every poll.
    if (window.__zone && window.__zone.now_playing) window.__zone.now_playing.seek_position++;
    return window.__json({ zone: JSON.parse(JSON.stringify(window.__zone)) });
  }
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null, album: null });
  if (url.indexOf("/api/smart-picks") > -1) return window.__json({ picks: [] });
  if (url.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
}
window.__installFetch(function (url) {
  var res = __route(url);
  for (var k in window.__delays) {
    if (res && url.indexOf(k) > -1) {
      var ms = window.__delays[k];
      return res.then(function (r) { return new Promise(function (ok) { setTimeout(function () { ok(r); }, ms); }); });
    }
  }
  return res;
});
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.setItem("rra-library-view", JSON.stringify({ v: 2, sort: "year", dir: "desc", seed: 1, played: "any" }));
  localStorage.removeItem("rra-home-cache-v1");
} catch (e) { /* storage optional here: every test below sets what it needs */ }
${extra || ""}
`;
}

const HELPERS = `
  function titlesIn(el) {
    return Array.prototype.map.call(el.querySelectorAll(".album"), function (t) {
      var x = t.querySelector(".album-title");
      return x ? x.textContent : "";
    });
  }
  function homeTitles() { return titlesIn(document.getElementById("home-library")); }
  function homeTile(title) {
    var tiles = document.getElementById("home-library").querySelectorAll(".album");
    for (var i = 0; i < tiles.length; i++) {
      var x = tiles[i].querySelector(".album-title");
      if (x && x.textContent === title) return tiles[i];
    }
    return null;
  }
  function rowAsks() { return window.__asks.lib.filter(function (c) { return c.count === 30; }).length; }
  function homeShown() { return !document.getElementById("home-view").classList.contains("hidden"); }
  // One poll (3 s) plus the idle window (1.2 s) plus slack.
  var LIVE_WAIT = 4700;
`;

const titles = (list) => list.map(a => a.title);

test("the Home Library row follows the server, with no navigation", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-home-library", windowSize: "390x844", stub: stub(),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      T("before", homeTitles());
      T("asks_before", rowAsks());
      var kept = homeTile("Ride Lonesome");
      // Release days arrive on the server — the report's exact situation. The
      // Release date order reads them, so the row must follow.
      window.__libList = ${JSON.stringify(AFTER)};
      window.__rev.dates = "1";
      await window.__sleep(LIVE_WAIT);
      T("after", homeTitles());
      T("asks_after", rowAsks());
      T("still_home", homeShown());
      T("same_node", homeTile("Ride Lonesome") === kept);
      // A revision this order does NOT read: plays. Nothing about a Release
      // date order depends on it, so the row is not asked again.
      window.__rev.plays = "1";
      await window.__sleep(LIVE_WAIT);
      T("asks_after_plays", rowAsks());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it opens on the server's order", () => {
    assert.deepEqual(r.before, titles(BEFORE));
    assert.equal(r.asks_before, 1, "the row was asked for more than once on the way in");
  });
  await t.test("THE one: a change on the server reaches the row while Home is on screen", () => {
    assert.deepEqual(r.after, titles(AFTER),
      "the row still shows the old order after the server's changed — it is not live");
    assert.equal(r.still_home, true, "the row only changed because the test navigated");
    assert.equal(r.asks_after, 2, "exactly one re-read for one change");
  });
  await t.test("an album that stayed is the same tile, moved — not rebuilt", () => {
    assert.equal(r.same_node, true,
      "the unchanged Ride Lonesome tile was re-created: every live re-read would blink the row");
  });
  await t.test("a revision the order does not read costs nothing", () => {
    assert.equal(r.asks_after_plays, 2, "a plays change re-read a Release date row");
  });
});

test("the reported case: a saved row in the current order is checked, not trusted", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  // The saved Home copy holds the old order UNDER THE CURRENT SORT, the way
  // the user's did. v1.7.76 painted it and marked the row fresh for good.
  const r = harness.renderPage({
    name: "live-home-cold-open", windowSize: "390x844",
    stub: stub(`
      window.__libList = ${JSON.stringify(AFTER)};
      try {
        localStorage.setItem("rra-home-cache-v1", JSON.stringify({
          library: ${JSON.stringify(BEFORE)}, librarySort: "sort=year&dir=desc",
          random: ${JSON.stringify(RANDOM)}, randomAt: Date.now(),
          unplayed: { aotd: null, albums: ${JSON.stringify(UNPLAYED)} }, unplayedAt: Date.now() }));
      } catch (e) { /* storage optional */ }
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(1500);
      T("settled", homeTitles());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the row ends up showing what the server holds", () => {
    assert.deepEqual(r.settled, titles(AFTER),
      "the saved copy was trusted: the row shows the order it was saved in, not the server's");
  });
});

test("nothing is swapped under a finger", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-home-held", windowSize: "390x844", stub: stub(),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      var target = homeTile("Hope Is the Thing with Feathers");
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      window.__libList = ${JSON.stringify(AFTER)};
      window.__rev.dates = "1";
      await window.__sleep(LIVE_WAIT);
      T("held", homeTitles());
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      await window.__sleep(2500);
      T("released", homeTitles());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("while a press is held the row stays as it is", () => {
    assert.deepEqual(r.held, titles(BEFORE),
      "the row changed under a held press — the tile under the finger could become another album");
  });
  await t.test("and catches up once it is let go", () => {
    assert.deepEqual(r.released, titles(AFTER));
  });
});

test("the Library wall re-reads where it stands", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  // Enough albums to scroll, so "where it stands" means something.
  const many = [];
  for (let i = 0; i < 60; i++) many.push(tile(100 + i, "Album " + String(i).padStart(2, "0"), "Artist " + i));
  const moved = many.slice(30).concat(many.slice(0, 30));
  const r = harness.renderPage({
    name: "live-library-wall", windowSize: "390x844",
    stub: stub(`window.__libList = ${JSON.stringify(many)};`),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      document.getElementById("home-library-title").click();
      await window.__sleep(900);
      var grid = document.getElementById("album-grid");
      var main = document.querySelector("main");
      main.scrollTop = 400;
      await window.__sleep(100);
      T("top_before", main.scrollTop);
      T("first_before", titlesIn(grid).slice(0, 2));
      var wallAsks = window.__asks.lib.length;
      window.__libList = ${JSON.stringify(moved)};
      window.__rev.dates = "1";
      await window.__sleep(LIVE_WAIT);
      T("first_after", titlesIn(grid).slice(0, 2));
      T("count_after", titlesIn(grid).length);
      T("top_after", main.scrollTop);
      T("on_wall", !document.getElementById("library-controls").classList.contains("hidden") &&
                   !homeShown());
      T("reread", window.__asks.lib.slice(wallAsks));
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the wall shows the server's new order without being left", () => {
    assert.deepEqual(r.first_before, ["Album 00", "Album 01"]);
    assert.deepEqual(r.first_after, ["Album 30", "Album 31"],
      "the wall kept the order it was entered with");
    assert.equal(r.count_after, 60, "the re-read lost or duplicated albums");
    assert.equal(r.on_wall, true);
  });
  await t.test("from the top, the whole loaded range, and the scroll position kept", () => {
    assert.ok(r.reread.length >= 1 && r.reread[0].offset === 0 && r.reread[0].count >= 60,
      "the re-read did not start from the top of the loaded range: " + JSON.stringify(r.reread));
    assert.ok(r.top_before > 0, "the test never scrolled, so it cannot check the position");
    assert.equal(r.top_after, r.top_before, "the re-read threw the user back to the top");
  });
});

test("the Queue tab follows the queue", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-queue", windowSize: "390x844", stub: stub(),
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      var bar = document.getElementById("mini-transport");
      for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
      document.querySelector(".mt-info").click();
      await window.__sleep(500);
      document.querySelector('.modal-tab[data-tab="queue"]').click();
      await window.__sleep(700);
      function nowRow() {
        var el = document.querySelector("#queue-list li.is-now .q-title");
        return el ? el.textContent : null;
      }
      T("now_before", nowRow());
      var asks = window.__asks.queue;
      // The track ends: Roon moves on, and the queue with it. Nothing is tapped.
      window.__zone = ${JSON.stringify(ZONE("Get Up", 1))};
      window.__queue = { items: [
        { queue_item_id: 2, title: "Get Up", subtitle: "R.E.M.", length: 160 },
        { queue_item_id: 3, title: "You Are the Everything", subtitle: "R.E.M.", length: 220 }
      ], history: [{ track: "Pop Song 89", artist: "R.E.M.", album: "Green", played: true, duration: 200 }] };
      window.__queueDelay = 400;
      var sawLoading = false, sawEmpty = false;
      for (var i = 0; i < 80; i++) {
        if (/Loading queue/.test(document.getElementById("queue-summary").textContent)) sawLoading = true;
        if (!document.querySelector("#queue-list li")) sawEmpty = true;
        await window.__sleep(50);
      }
      T("now_after", nowRow());
      T("asks", window.__asks.queue - asks);
      T("saw_loading", sawLoading);
      T("saw_empty", sawEmpty);
      // And a queue that is standing still is not asked for again.
      var still = window.__asks.queue;
      await window.__sleep(4000);
      T("asks_still", window.__asks.queue - still);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the next track becomes Now playing without reopening the tab", () => {
    assert.equal(r.now_before, "Pop Song 89");
    assert.equal(r.now_after, "Get Up", "the Queue tab kept showing the queue it was opened with");
    assert.equal(r.asks, 1, "one move, one read");
  });
  await t.test("quietly: no \"Loading queue…\" over the list the user is reading", () => {
    assert.equal(r.saw_loading, false);
    assert.equal(r.saw_empty, false, "the list was emptied while the new one was fetched");
  });
  await t.test("and a still queue costs nothing — the 1.5 s poll does not become a queue poll", () => {
    assert.equal(r.asks_still, 0);
  });
});

test("the random rows re-read their own draw, and draw again after five minutes", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-random-seed", windowSize: "390x844", stub: stub(), budgetMs: 420000,
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      T("first", window.__asks.random.slice());
      T("first_unplayed", window.__asks.unplayed.slice());
      // The library moves (a badge, say): the rows are re-read — same draw.
      window.__rev.library = "1.1";
      await window.__sleep(LIVE_WAIT);
      T("reread", window.__asks.random.slice());
      T("reread_unplayed", window.__asks.unplayed.slice());
      // Into the wall and back inside the five minutes: nothing is drawn.
      document.getElementById("home-library-title").click();
      await window.__sleep(600);
      document.getElementById("topbar-back").click();
      await window.__sleep(900);
      T("quick_visit", window.__asks.random.slice());
      // Out again, and back after the TTL: a new draw.
      document.getElementById("home-library-title").click();
      await window.__sleep(301000);
      document.getElementById("topbar-back").click();
      await window.__sleep(1500);
      T("late_visit", window.__asks.random.slice());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("a live re-read asks for the same seed", () => {
    assert.equal(r.first.length, 1);
    assert.match(r.first[0], /^30:\d+$/, "the row asked for no seed, so it cannot be re-read without a new draw");
    assert.deepEqual(r.reread, [r.first[0], r.first[0]],
      "the re-read after a library change asked for a different draw");
    assert.match(r.first_unplayed[0], /^30:\d+$/);
    assert.deepEqual(r.reread_unplayed, [r.first_unplayed[0], r.first_unplayed[0]]);
  });
  await t.test("a visit inside five minutes draws nothing", () => {
    assert.equal(r.quick_visit.length, 2);
  });
  await t.test("THE old TTL bug: a visit after five minutes draws afresh", () => {
    // It never did before v1.8.65: the stamp was renewed before the rows were
    // asked, and a row holding tiles then read the renewed stamp as fresh.
    assert.equal(r.late_visit.length, 3, "the rows were not drawn again after the TTL");
    assert.notEqual(r.late_visit[2], r.first[0], "the new draw reused the old seed");
  });
});

test("an open album page picks up a release day found after it opened", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-album-date", windowSize: "390x844", stub: stub(),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      homeTile("Ride Lonesome").click();
      await window.__sleep(1200);
      var modal = document.getElementById("album-modal");
      T("open", !modal.classList.contains("hidden"));
      function dateText() {
        var el = modal.querySelector(".modal-release-date");
        return el ? el.textContent : null;
      }
      T("date_before", dateText());
      window.__releaseDate = "2026-09-25";
      window.__rev.dates = "1";
      await window.__sleep(LIVE_WAIT);
      T("date_after", dateText());
      T("september", new Date(Date.UTC(2026, 8, 25)).toLocaleDateString(undefined,
        { month: "long", timeZone: "UTC" }));
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the year the page opened with becomes the day, in place", () => {
    assert.equal(r.open, true);
    assert.equal(r.date_before, " · 2026");
    assert.ok(r.date_after && r.date_after.includes(r.september) && /\b25\b/.test(r.date_after),
      "the page kept the year after the day arrived: " + r.date_after);
  });
});

test("the walls re-read their own draw — and a wall Roon draws is left alone", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-walls", windowSize: "390x844", stub: stub(),
    driver: `
      ${HELPERS}
      const wall = (list) => list.filter(function (a) { return a.split(":")[0] !== "30"; });
      await window.__sleep(900);
      // Not played in 6 months, full screen.
      document.getElementById("home-unplayed-title").click();
      await window.__sleep(800);
      T("unplayed_first", wall(window.__asks.unplayed));
      window.__rev.plays = "1";        // an album is played somewhere
      await window.__sleep(LIVE_WAIT);
      T("unplayed_after", wall(window.__asks.unplayed));
      T("unplayed_tiles", titlesIn(document.getElementById("album-grid")));

      // The random wall, from the menu.
      document.getElementById("menu-toggle").click();
      await window.__sleep(300);
      document.querySelector('.menu-item[data-action="shuffle"]').click();
      await window.__sleep(900);
      T("random_first", wall(window.__asks.random));
      window.__rev.library = "1.1";
      await window.__sleep(LIVE_WAIT);
      T("random_after", wall(window.__asks.random));

      // A genre wall: Roon draws it, per request. A library change must not
      // re-draw it (a new pick nobody asked for, and a round of Core calls).
      window.__applyFilter({ type: "genre", value: "Jazz" });
      await window.__sleep(900);
      var genreAsks = wall(window.__asks.random).length;
      T("genre_ask", wall(window.__asks.random)[genreAsks - 1]);
      window.__rev.library = "1.2";
      await window.__sleep(LIVE_WAIT);
      T("genre_after", wall(window.__asks.random).length - genreAsks);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("Not played: a play re-reads the same draw where it stands", () => {
    assert.equal(r.unplayed_first.length, 1);
    assert.match(r.unplayed_first[0], /^96:\d+$/, "the wall asked for no seed");
    assert.deepEqual(r.unplayed_after, [r.unplayed_first[0], r.unplayed_first[0]],
      "a play re-drew the wall (or did not re-read it at all)");
    assert.deepEqual(r.unplayed_tiles, ["Strictly Personal", "Green"]);
  });
  await t.test("the random wall: a library change re-reads the same draw", () => {
    assert.equal(r.random_first.length, 1);
    assert.match(r.random_first[0], /^\d+:\d+$/);
    assert.deepEqual(r.random_after, [r.random_first[0], r.random_first[0]]);
  });
  await t.test("a genre wall asks for no seed and is not re-read", () => {
    assert.match(r.genre_ask, /:null$/, "a genre wall sent a seed the server cannot honour");
    assert.equal(r.genre_after, 0, "a library change re-drew a genre wall through Roon");
  });
});

test("a settings change from another device reaches this Home", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-settings", windowSize: "390x844",
    stub: stub(`
      window.__rowsAsks = 0;
      window.__rows = [{ id: "unplayed", on: true }, { id: "history", on: true }, { id: "picks", on: true },
                       { id: "random", on: true }, { id: "library", on: true }, { id: "lotw", on: true },
                       { id: "genres", on: true }];
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf("/api/settings/home-rows") > -1) {
          window.__rowsAsks++;
          return window.__json({ rows: window.__rows });
        }
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      T("asks_boot", window.__rowsAsks);
      function hidden(id) {
        var el = document.querySelector('#home-sections [data-row="' + id + '"]');
        return !el || el.classList.contains("hidden");
      }
      T("random_hidden_before", hidden("random"));
      // Switched off on another phone: the server's settings revision moves.
      window.__rows = window.__rows.map(function (r) { return r.id === "random" ? { id: "random", on: false } : r; });
      window.__rev.settings = "1";
      await window.__sleep(LIVE_WAIT);
      T("asks_after", window.__rowsAsks);
      T("random_hidden_after", hidden("random"));
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("read once at boot, not again for the first answer", () => {
    assert.equal(r.asks_boot, 1, "the layout was read twice on the way in");
  });
  await t.test("the row switched off elsewhere goes, with nothing tapped here", () => {
    assert.equal(r.random_hidden_before, false);
    assert.equal(r.asks_after, 2);
    assert.equal(r.random_hidden_after, true);
  });
});

test("Smart Picks and Discover fill themselves in when the build lands", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const PICK = { kind: "adjacent", artist: "Seefeel", album: "Quique", album_id: "q4", service: "qobuz",
                 image: "", reason: "Because you play Labradford", genre: "" };
  const REL = { artist: "Low", album: "New Record", cover: "", release_date: "2026-09-20", year: null,
                in_library: false, offset: null, image_key: null, library_title: null,
                library_subtitle: null, services: [] };
  const r = harness.renderPage({
    name: "live-builds", windowSize: "390x844",
    stub: stub(`
      window.__picks = [];
      window.__releases = [];
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf("/api/smart-picks") > -1)
          return window.__json({ day: "2026-09-27", service_ready: true, auto_add: false, hour: 4,
                                 building: !window.__picks.length, picks: window.__picks });
        if (u.indexOf("/api/discover") > -1 && u.indexOf("/api/discover/") === -1)
          return window.__json({ enabled: true, day: "2026-09-27", window_days: 60,
                                 building: !window.__releases.length, releases: window.__releases });
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      function banner() { var b = document.getElementById("status-banner"); return b && !b.classList.contains("hidden") ? b.textContent : ""; }
      await window.__sleep(900);
      document.getElementById("menu-toggle").click();
      await window.__sleep(300);
      document.querySelector('.menu-item[data-action="smart-picks"]').click();
      await window.__sleep(700);
      T("picks_banner", banner());
      window.__picks = [${JSON.stringify(PICK)}];
      window.__rev.picks = "1";          // the build finished on the server
      await window.__sleep(LIVE_WAIT);
      T("picks_cards", document.querySelectorAll("#album-grid .pick-card").length);
      T("picks_banner_after", banner());

      window.__showDiscover();
      await window.__sleep(700);
      T("discover_banner", banner());
      window.__releases = [${JSON.stringify(REL)}];
      window.__rev.discover = "1";
      await window.__sleep(LIVE_WAIT);
      T("discover_rows", document.querySelectorAll("#album-grid .discover-list > *").length);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("Smart Picks: building, then the picks — without being left", () => {
    assert.match(r.picks_banner, /appear here the moment/i, r.picks_banner);
    assert.doesNotMatch(r.picks_banner, /come back/i);
    assert.equal(r.picks_cards, 1, "the day's picks landed and the screen still says it is building");
    assert.equal(r.picks_banner_after, "");
  });
  await t.test("Discover: the same", () => {
    assert.match(r.discover_banner, /appear here the moment/i, r.discover_banner);
    assert.equal(r.discover_rows, 1, "the build landed and the screen still says it is looking");
  });
});

test("an open artist page follows the library", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const OWN = [tile(50, "Odelay", "Beck"), tile(51, "Sea Change", "Beck")];
  const MORE = OWN.concat([tile(52, "Morning Phase", "Beck")]);
  const r = harness.renderPage({
    name: "live-artist", windowSize: "390x844",
    stub: stub(`
      window.__artistAlbums = ${JSON.stringify(OWN)};
      window.__artistAsks = 0;
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf("/api/artist-albums") > -1) {
          window.__artistAsks++;
          return window.__json({ primary: window.__artistAlbums, featured: [] });
        }
        if (u.indexOf("/api/artist-bio") > -1)
          return window.__json({ bio: { text: "An artist from Los Angeles.", source: "Wikipedia" } });
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      window.__showArtistAlbums("Beck");
      await window.__sleep(900);
      var grid = document.getElementById("album-grid");
      T("before", titlesIn(grid));
      var bio = grid.querySelector(".artist-bio-head");
      T("has_bio", !!bio);
      var kept = grid.querySelector(".album");
      window.__artistAlbums = ${JSON.stringify(MORE)};
      window.__rev.library = "1.1";
      await window.__sleep(LIVE_WAIT);
      T("after", titlesIn(grid));
      T("bio_kept", grid.querySelector(".artist-bio-head") === bio && grid.firstElementChild === bio);
      T("tile_kept", grid.querySelector(".album") === kept);
      T("count", (document.querySelector(".count-text") || {}).textContent);
      T("asks", window.__artistAsks);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("an album added to Roon appears on the page while it is open", () => {
    assert.deepEqual(r.before, ["Odelay", "Sea Change"]);
    assert.deepEqual(r.after, ["Odelay", "Sea Change", "Morning Phase"]);
    assert.equal(r.count, "3 albums · Beck");
    assert.equal(r.asks, 2);
  });
  await t.test("and the page is updated, not rebuilt: bio and unchanged tiles stay put", () => {
    assert.equal(r.has_bio, true, "the test never had a bio block to keep");
    assert.equal(r.bio_kept, true, "the re-read dropped or moved the bio");
    assert.equal(r.tile_kept, true, "an unchanged tile was rebuilt");
  });
});

test("an open label page follows the label scan", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const FIRST = [tile(60, "Selected Ambient Works 85-92", "Aphex Twin"), tile(61, "Geogaddi", "Boards of Canada")];
  const MORE = FIRST.concat([tile(62, "Tri Repetae", "Autechre")]);
  const r = harness.renderPage({
    name: "live-label", windowSize: "390x844",
    stub: stub(`
      window.__labelAlbums = ${JSON.stringify(FIRST)};
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf("/api/label-albums") > -1)
          return window.__json({ albums: window.__labelAlbums, logo_url: null });
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      window.__showLabelAlbums("Warp");
      await window.__sleep(900);
      var grid = document.getElementById("album-grid");
      T("before", titlesIn(grid));
      var kept = grid.querySelector(".album");
      // The label scan reaches another Warp record.
      window.__labelAlbums = ${JSON.stringify(MORE)};
      window.__rev.labels = "1.0.1";
      await window.__sleep(LIVE_WAIT);
      T("after", titlesIn(grid));
      T("tile_kept", grid.querySelector(".album") === kept);
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the new record appears, and the rest are the same tiles", () => {
    assert.deepEqual(r.before, titles(FIRST));
    assert.deepEqual(r.after, titles(MORE), "the label page kept the albums it was opened with");
    assert.equal(r.tile_kept, true);
  });
});

test("a cold open keeps a recent draw, and redraws a stale one exactly once", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  // The order that exposes it: the saved copy is painted, THEN the first live
  // answer arrives (and refreshes the rows it can see), and only then does the
  // pairing check let bootstrap reach showHome().
  const cached = (ageMs) => stub(`
    window.__delays = { "/api/live": 150, "/api/status": 700 };
    try {
      var at = Date.now() - ${ageMs};
      localStorage.setItem("rra-home-cache-v1", JSON.stringify({
        random: ${JSON.stringify(RANDOM)}, randomAt: at, randomSeed: 777,
        unplayed: { aotd: null, albums: ${JSON.stringify(UNPLAYED)} }, unplayedAt: at, unplayedSeed: 888 }));
    } catch (e) { /* storage optional */ }
  `);
  const DRIVER = `
    ${HELPERS}
    await window.__sleep(2500);
    T("random", window.__asks.random.slice());
    T("unplayed", window.__asks.unplayed.slice());
  `;
  const fresh = harness.renderPage({ name: "live-cold-fresh", windowSize: "390x844", stub: cached(60 * 1000), driver: DRIVER });
  const stale = harness.renderPage({ name: "live-cold-stale", windowSize: "390x844", stub: cached(6 * 60 * 1000), driver: DRIVER });
  harness.assertNoPageError(assert, fresh);
  harness.assertNoPageError(assert, stale);
  await t.test("inside five minutes: the saved draw is re-read, not redrawn", () => {
    assert.deepEqual(fresh.random, ["30:777"]);
    assert.deepEqual(fresh.unplayed, ["30:888"]);
  });
  await t.test("after five minutes: one new draw, not the old one and then a new one", () => {
    assert.equal(stale.random.length, 1, "the rows were drawn more than once: " + JSON.stringify(stale.random));
    assert.notEqual(stale.random[0], "30:777");
    assert.equal(stale.unplayed.length, 1, JSON.stringify(stale.unplayed));
  });
});

test("a screen whose re-read failed catches up once the server is back", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  // The case a change-driven design misses: the change IS heard, the re-read of
  // the row fails, then the server drops out and comes back with nothing new to
  // say. Nothing will move the revisions again for hours.
  const r = harness.renderPage({
    name: "live-outage", windowSize: "390x844",
    stub: stub(`
      window.__libDown = false;
      window.__liveDown = false;
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (window.__libDown && u.indexOf("/api/library/albums") > -1) return window.__json({ error: "busy" }, 500);
        if (window.__liveDown && u.indexOf("/api/live") > -1) return window.__json({ error: "down" }, 503);
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(900);
      T("before", homeTitles());
      window.__libDown = true;
      window.__libList = ${JSON.stringify(AFTER)};
      window.__rev.dates = "1";            // heard — but the re-read fails
      await window.__sleep(LIVE_WAIT);
      T("during", homeTitles());
      window.__liveDown = true;            // and the server goes away
      await window.__sleep(LIVE_WAIT);
      window.__libDown = false;            // back, with nothing new to report
      window.__liveDown = false;
      await window.__sleep(LIVE_WAIT);
      T("after", homeTitles());
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the row keeps what it had while it cannot read", () => {
    assert.deepEqual(r.before, titles(BEFORE));
    assert.deepEqual(r.during, titles(BEFORE));
  });
  await t.test("THE one: and catches up on the first answer after the outage", () => {
    assert.deepEqual(r.after, titles(AFTER),
      "the row stayed stale after the server came back — nothing told it to look again");
  });
});

test("the genre buttons survive one of their two reads failing", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({
    name: "live-genres-partial", windowSize: "390x844",
    stub: stub(`
      var inner = window.fetch;
      window.fetch = function (url, opts) {
        var u = String(url);
        if (u.indexOf("/api/home/genre-groups") > -1) return window.__json({ error: "Core busy" }, 500);
        if (u.indexOf("/api/filters/genres") > -1)
          return window.__json({ genres: [{ title: "Jazz", subtitle: "40 Albums" }, { title: "Folk", subtitle: "12 Albums" }] });
        return inner(url, opts);
      };
    `),
    driver: `
      ${HELPERS}
      await window.__sleep(1200);
      T("cards", Array.prototype.map.call(document.querySelectorAll("#home-genres .home-genre-card"),
        function (c) { return c.textContent; }));
    `,
  });
  harness.assertNoPageError(assert, r);
  await t.test("the genres that did load are drawn", () => {
    assert.deepEqual(r.cards, ["Jazz", "Folk"],
      "a failed Rock/Metal-Pop split blanked the whole row, which it never used to");
  });
});
