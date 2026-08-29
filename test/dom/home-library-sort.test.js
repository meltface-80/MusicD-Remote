"use strict";
// ---------------------------------------------------------------------------
// v1.7.76: the Home "Library" row is the head of the wall its header opens.
//
// The row and the wall read the same endpoint, but the row asked for it with no
// sort at all — so it always showed the server's default (album name, A→Z)
// while the wall showed whatever the user had chosen. Two lists, one label,
// disagreeing.
//
// Two things had to change together, and testing only one of them passes while
// the bug is fully intact:
//
//   1. The row has to ASK for the chosen order.
//   2. The row has to know its order can go stale. Its freshness flag was a
//      boolean — "it has tiles, never load it again" — so even once it asked
//      correctly, a sort chosen afterwards never reached Home for the rest of
//      the session.
//
// The stub below returns a genuinely different list per sort, so "did the order
// reach Home" is answered by what is ON SCREEN, not only by the query string.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// Two orders with no titles in common, so neither can be mistaken for the other.
const BY_ALBUM = [
  { offset: 0, title: "Aardvark", subtitle: "Artist One", image_key: "k0" },
  { offset: 1, title: "Beluga",   subtitle: "Artist Two", image_key: "k1" },
];
const BY_ADDED = [
  { offset: 7, title: "Newest Thing", subtitle: "Artist Nine", image_key: "k7" },
  { offset: 8, title: "Older Thing",  subtitle: "Artist Ten",  image_key: "k8" },
];

const STUB = `
var BY_ALBUM = ${JSON.stringify(BY_ALBUM)};
var BY_ADDED = ${JSON.stringify(BY_ADDED)};
window.__libCalls = [];
window.__installFetch(function (url) {
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 4, dated: 4, decades: [], sources: [], hasPlays: true });
  if (url.indexOf("/api/library/albums") > -1) {
    var p = new URLSearchParams(url.split("?")[1] || "");
    window.__libCalls.push({ sort: p.get("sort"), dir: p.get("dir"), count: p.get("count") });
    // The server really does order by the sort it is given. A stub that
    // returned one fixed list would let a row that never asks for the order
    // pass every on-screen assertion below.
    var list = p.get("sort") === "added" ? BY_ADDED : BY_ALBUM;
    var body = { albums: list, offset: 0, total: list.length };
    // The cache test slows this down. Without a real gap between the cached
    // repaint and the network answer, "the stale order never appeared" is true
    // of a row that was simply still empty when it was looked at — it passes
    // just as well with the bug present.
    if (!window.__libDelay) return window.__json(body);
    return new Promise(function (res) {
      setTimeout(function () {
        res(new Response(JSON.stringify(body),
            { status: 200, headers: { "Content-Type": "application/json" } }));
      }, window.__libDelay);
    });
  }
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: BY_ALBUM, total: BY_ALBUM.length, filtered: false });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  return undefined;
});
// A clean slate: a persisted view or Home cache from another run would decide
// the starting order and make these assertions depend on test order.
try { localStorage.removeItem("rra-library-view"); } catch (e) {}
try { localStorage.removeItem("rra-home-cache-v1"); } catch (e) {}
`;

// Reads the Home row, opens the wall, changes Sort, comes back.
const HELPERS = `
  function homeTitles() {
    var row = document.getElementById("home-library");
    return Array.prototype.map.call(row.querySelectorAll(".album"), function (t) {
      var el = t.querySelector(".album-title");
      return el ? el.textContent : "";
    });
  }
  // What the Library ROW asked for — the count=30 request. The wall pages with
  // a different count, so this cannot be confused with the wall's own fetches.
  function rowCalls() {
    return window.__libCalls.filter(function (c) { return c.count === "30"; });
  }
  async function pickSort(label) {
    document.getElementById("home-library-title").click();
    await window.__sleep(400);
    document.querySelector("#library-controls .lib-ctl-sort").click();
    await window.__sleep(250);
    var rows = Array.prototype.slice.call(document.querySelectorAll(".lib-sort-row"));
    var row = rows.filter(function (r) {
      var el = r.querySelector(".lib-sort-label");
      return el && el.textContent === label;
    })[0];
    row.click();
    await window.__sleep(400);
  }
  async function backToHome() {
    document.getElementById("topbar-back").click();
    await window.__sleep(600);
  }
`;

test("the Home Library row follows the wall's sort", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "home-library-sort", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      T("first_titles", homeTitles());
      T("first_calls", rowCalls());

      await pickSort("Recently added");
      await backToHome();
      T("after_titles", homeTitles());
      T("after_calls", rowCalls());

      // ...and back again, because a row that reloads once could be doing it
      // for any reason. Changing the order a SECOND time must move it too.
      await pickSort("Album name");
      await backToHome();
      T("back_titles", homeTitles());
      T("back_calls", rowCalls());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("it opens in the default order, and says so in the request", () => {
    assert.deepEqual(r.first_titles, ["Aardvark", "Beluga"]);
    assert.deepEqual(r.first_calls, [{ sort: "album", dir: "asc", count: "30" }],
      "the row asked for no sort at all, so it can only ever show the " +
      "server's default while the wall shows what the user chose");
  });

  await t.test("choosing Recently added reaches Home", () => {
    assert.deepEqual(r.after_titles, ["Newest Thing", "Older Thing"],
      "the Home row still shows the album-name order after the wall was " +
      "sorted by Recently added");
    assert.deepEqual(r.after_calls[r.after_calls.length - 1],
      { sort: "added", dir: "desc", count: "30" });
    assert.equal(r.after_calls.length, 2,
      "the row did not re-fetch — its freshness flag does not know the order " +
      "can change, so the new sort never reached Home");
  });

  await t.test("and so does changing it back", () => {
    assert.deepEqual(r.back_titles, ["Aardvark", "Beluga"]);
    assert.deepEqual(r.back_calls[r.back_calls.length - 1],
      { sort: "album", dir: "asc", count: "30" });
    assert.equal(r.back_calls.length, 3);
  });
});

test("a Home visit in an unchanged order does not re-fetch the row", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // The freshness flag still has to do its original job. Keying it on the order
  // must not turn every Back tap into a fresh page of library covers — that
  // cost is why the row loads once in the first place.
  const r = harness.renderPage({
    name: "home-library-refetch", windowSize: "390x844", stub: STUB,
    driver: `
      ${HELPERS}
      await window.__sleep(600);
      T("first_calls", rowCalls().length);
      // Into the wall and straight back out, twice, touching nothing.
      document.getElementById("home-library-title").click();
      await window.__sleep(400);
      await backToHome();
      document.getElementById("home-library-title").click();
      await window.__sleep(400);
      await backToHome();
      T("after_calls", rowCalls().length);
      T("titles", homeTitles());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the row is loaded once and left alone", () => {
    assert.equal(r.first_calls, 1);
    assert.equal(r.after_calls, 1,
      "two Back taps re-fetched the row even though the order never changed");
    assert.deepEqual(r.titles, ["Aardvark", "Beluga"]);
  });
});

test("a cached row in a stale order is not painted", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Home repaints from localStorage before the network answers. For every other
  // row "stale" means slightly old content; for this one it means the WRONG
  // ORDER, so hydrating it unconditionally flashes the previous sort on every
  // cold open — the exact thing the row is meant to be reflecting.
  const r = harness.renderPage({
    name: "home-library-stale-cache", windowSize: "390x844",
    stub: STUB + `
      // Held long enough that anything the cache painted stays on screen for a
      // window the driver can actually sample.
      window.__libDelay = 900;
      // A cache written while the wall was sorted by album name, restored into
      // a session whose saved view is Recently added.
      try {
        localStorage.setItem("rra-home-cache-v1", JSON.stringify({
          library: BY_ALBUM, librarySort: "sort=album&dir=asc",
          random: BY_ALBUM, randomAt: Date.now(),
          unplayed: { aotd: null, albums: BY_ALBUM }, unplayedAt: Date.now(),
        }));
        localStorage.setItem("rra-library-view", JSON.stringify({
          v: 2, sort: "added", dir: "desc", seed: 1, played: "any" }));
      } catch (e) {}
    `,
    driver: `
      ${HELPERS}
      // Poll from the first moment rather than sampling once: the cached
      // repaint happens during boot, and a single well-timed look can miss it
      // and call an empty row a pass.
      var seen = [];
      for (var i = 0; i < 48; i++) {
        var titles = homeTitles();
        if (titles.length) seen.push(titles.join("|"));
        await window.__sleep(25);
      }
      T("seen", seen);
      T("saw_anything", seen.length > 0);
      await window.__sleep(900);
      T("settled", homeTitles());
      T("calls", rowCalls());
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the stale order never appears", () => {
    // Guards the assertion below against passing because the row was empty for
    // the whole sampling window and nothing was ever observed at all.
    assert.equal(r.saw_anything, true,
      "the row was empty for the entire sampling window, so this test proves " +
      "nothing — the delay or the poll needs adjusting");
    const stale = r.seen.filter(s => s.indexOf("Aardvark") > -1);
    assert.deepEqual(stale, [],
      "the cached album-name order was painted into a session sorted by " +
      "Recently added — a visible flash of the order the row is meant to follow");
  });

  await t.test("and the row loads in the order that is actually set", () => {
    assert.deepEqual(r.settled, ["Newest Thing", "Older Thing"]);
    assert.deepEqual(r.calls[r.calls.length - 1],
      { sort: "added", dir: "desc", count: "30" });
  });
});
