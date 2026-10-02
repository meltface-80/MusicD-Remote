"use strict";
// ---------------------------------------------------------------------------
// v1.8.66: tile text ran into the next tile on an older iPad.
//
// Reported from Kiosker (a kiosk browser built on Safari) on an older iPad: in
// "Recently played", "Send in the Clowns (Pablo)" ran on one line into the next
// tile's title, and "Sarah Vaughan & the Count Basie Orchestra" ran across the
// next tile's artist; in "Random albums", "Muhal Richard Abrams/Eddie Allen" did
// the same. The same albums on an iPhone looked right.
//
// A tile is a <button>, laid out as a flex column (cover, then text). Older
// WebKit's own stylesheet gives every button `align-items: flex-start`, so the
// text block under the cover was not stretched to the tile — it was sized to
// its content, and its content includes a line that never wraps (the artist,
// one line with an ellipsis by design). A long artist line therefore made the
// whole block wider than the tile; the title, given that width, no longer
// needed to wrap; and the ellipsis never came, because nothing was cut off.
// Current WebKit and Chrome no longer carry the rule — which is why a phone,
// and this harness, show the tiles correctly by default.
//
// So the test puts the rule back, exactly as old WebKit had it: an author rule
// on `button`, placed BEFORE the app's stylesheet, stands in for the user-agent
// one — it loses to any rule of the app's that says otherwise, just as the UA
// rule does — and every assertion is about where the text actually ends up.
//
// Two lines of defence, each measured on its own:
//   * style.css says `button { align-items: normal }`, which undoes the old
//     rule for every button in the app, not only the tiles;
//   * a tile's text block is capped at the tile's width, which holds even on an
//     engine too old to know `normal` (it drops the declaration as invalid and
//     the old rule stands). That engine is stood in for by making the old rule
//     `!important`, which nothing in the app's stylesheet can beat.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUMS = [
  { offset: 1, title: "Winobranie", subtitle: "Zbigniew Namyslowski", image_key: "k1" },
  { offset: 2, title: "Send in the Clowns (Pablo)", subtitle: "Sarah Vaughan & the Count Basie Orchestra", image_key: "k2" },
  { offset: 3, title: "Stan Getz and the Oscar Peterson Trio", subtitle: "Stan Getz / Oscar Peterson Trio", image_key: "k3" },
  { offset: 4, title: "Focus One Think All", subtitle: "Muhal Richard Abrams/Eddie Allen", image_key: "k4" },
];

const STUB = `
// Older WebKit's user-agent rule, put back. This runs while <head> is still
// being parsed, so the rule lands ahead of style.css, as a UA rule would sit.
document.head.insertAdjacentHTML("beforeend",
  '<style id="old-webkit-ua">button { align-items: flex-start; }</style>');
window.__installFetch(function (url) {
  if (url.indexOf("/api/home/history") > -1) return window.__json({ albums: ${JSON.stringify(ALBUMS)} });
  if (url.indexOf("/api/random-albums") > -1) return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 4 });
  if (url.indexOf("/api/library/facets") > -1)
    return window.__json({ total: 4, dated: 0, decades: [], sources: [], hasPlays: false });
  if (url.indexOf("/api/library/albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, offset: 0, total: 4 });
  if (url.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (url.indexOf("/api/zones") > -1) return window.__json({ zones: [] });
  return undefined;
});
try { localStorage.removeItem("rra-home-cache-v1"); localStorage.removeItem("rra-library-view"); }
catch (e) { /* storage is always available in this harness; a start from defaults is all this asks */ }
`;

// For every tile in a container: how far its text reaches past the tile, and
// how many lines the title took.
const MEASURE = `
  function measure(container) {
    return Array.prototype.map.call(container.querySelectorAll(".album"), function (t) {
      var tile = t.getBoundingClientRect();
      var title = t.querySelector(".album-title"), artist = t.querySelector(".album-artist");
      var tr = title.getBoundingClientRect(), ar = artist.getBoundingClientRect();
      var lh = parseFloat(getComputedStyle(title).lineHeight) || 16;
      return {
        title: title.textContent,
        titleOver: Math.round(tr.right - tile.right),
        artistOver: Math.round(ar.right - tile.right),
        titleLines: Math.round(tr.height / lh),
      };
    });
  }
`;

function check(assert, tiles, where) {
  assert.equal(tiles.length, ALBUMS.length, where + ": not every tile rendered");
  for (const t of tiles) {
    assert.ok(t.titleOver <= 0,
      where + ": \"" + t.title + "\" — the title reaches " + t.titleOver + "px into the next tile");
    assert.ok(t.artistOver <= 0,
      where + ": \"" + t.title + "\" — the artist line reaches " + t.artistOver + "px into the next tile");
  }
  const clowns = tiles.find(t => t.title === "Send in the Clowns (Pablo)");
  assert.equal(clowns.titleLines, 2,
    where + ": the title that ran on one line in the report still does not wrap");
}

test("tile text stays inside its tile under older WebKit's button rule (v1.8.66)", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  const r = harness.renderPage({
    name: "tile-text-webkit", windowSize: "834x1112", stub: STUB,
    driver: `
      ${MEASURE}
      await window.__sleep(900);
      var probe = document.createElement("button");
      document.body.appendChild(probe);
      var appSheet = Array.prototype.find.call(document.styleSheets, function (sh) {
        return sh.href && /style\\.css$/.test(sh.href);
      });
      appSheet.disabled = true;
      T("ua_rule_applies", getComputedStyle(probe).alignItems);
      appSheet.disabled = false;
      T("app_resets_it", getComputedStyle(probe).alignItems);
      probe.remove();
      T("home", measure(document.getElementById("home-random")));
      T("history", measure(document.getElementById("home-history")));

      // An engine that does not know \`normal\`: the old rule wins outright.
      document.getElementById("old-webkit-ua").textContent = "button { align-items: flex-start !important; }";
      await window.__sleep(100);
      var tile = document.querySelector("#home-random .album");
      T("old_rule_wins", getComputedStyle(tile).alignItems);
      T("home_old", measure(document.getElementById("home-random")));
      document.getElementById("old-webkit-ua").textContent = "button { align-items: flex-start; }";

      document.getElementById("home-library-title").click();
      await window.__sleep(900);
      T("wall", measure(document.getElementById("album-grid")));
    `,
  });
  harness.assertNoPageError(assert, r);

  await t.test("the old user-agent rule is really in force here", () => {
    // Without this the test would pass on any engine for the wrong reason:
    // with the app's own stylesheet switched off, a button aligns as old WebKit
    // made it.
    assert.equal(r.ua_rule_applies, "flex-start");
  });
  await t.test("the app's stylesheet undoes it for every button", () => {
    assert.equal(r.app_resets_it, "normal",
      "style.css no longer resets button alignment — every flex button is back on old WebKit's rule");
  });
  await t.test("Home carousels", () => {
    check(assert, r.home, "Random albums");
    check(assert, r.history, "Recently played");
  });
  await t.test("the album walls", () => {
    check(assert, r.wall, "Library wall");
  });
  await t.test("and where the reset cannot take, the tile still holds its text", () => {
    assert.equal(r.old_rule_wins, "flex-start", "the stand-in for an engine without `normal` did not apply");
    check(assert, r.home_old, "Random albums, old rule winning");
  });
});
