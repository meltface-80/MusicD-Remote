"use strict";
// ---------------------------------------------------------------------------
// v1.8.50: the album view's last content sat under the now-playing pill.
//
// Reported from a phone in landscape: About this album and the service link
// were behind the transport bar with no way to scroll them out.
//
// THE SHORTHAND ATE THE RESERVE. `.modal-body` sets
// `padding-bottom: calc(106px + env(safe-area-inset-bottom))` so the end of
// the content can scroll clear of the floating pill. The two-column rule for
// 720px and up then writes `padding: 28px` — a shorthand, so it resets the
// bottom too — and nothing put it back.
//
// It took landscape on a phone to show it because that is where the panel is
// both centred (a 24px margin, so it ends within a few pixels of the screen)
// and short. Measured at 844x390 before the fix: the panel runs to y=374 and
// the pill's top edge is at y=308, so its last 66px were underneath while the
// body reserved 28.
//
// The assertions below are about the RESULT — the last track clears the pill
// after scrolling to the end — rather than about the declaration, because any
// future rule that resets the bottom padding brings the same bug back under a
// different name. Run at a phone-landscape size and at a desktop one, since a
// long album reaches the bottom of the dialog at both.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: { line1: "Angel Fire Rise", line2: "Rhiannon Giddens",
                 line3: "Hope Is the Thing with Feathers", image_key: "k",
                 length: 285, seek_position: 34 },
};
const ALBUMS = [{ offset: 0, title: "Abel Ganz", subtitle: "Abel Ganz", image_key: "k" }];
// Long enough that the body really scrolls at both sizes — a fixture that
// fits on screen cannot show a scrolling bug.
const DETAIL = {
  title: "Abel Ganz", subtitle: "Abel Ganz", image_key: "k", year: 2014,
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: Array.from({ length: 16 }, (_, i) => ({ title: "Track " + (i + 1), subtitle: "Abel Ganz" })),
};

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/album/extras") > -1)
    return window.__json({ year: 2014, album: null, artist: null,
                           description: "About this album. ".repeat(14),
                           source: "Qobuz", links: { services: [], reviews: [] } });
  if (u.indexOf("/api/album") > -1)  return window.__json(${JSON.stringify(DETAIL)});
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 1, filtered: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  function boxOf(el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
  }
  await window.__sleep(800);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(1400);

  var body  = document.querySelector("#album-modal .modal-body");
  var panel = document.querySelector("#album-modal .modal-panel");
  var bar   = document.querySelector(".mini-transport");
  T("bar_showing", !!bar && !bar.classList.contains("hidden"));
  T("panel", boxOf(panel));
  T("bar", boxOf(bar));
  T("scrolls", body.scrollHeight > body.clientHeight + 1);

  // All the way to the end — the position the report is about.
  body.scrollTop = body.scrollHeight;
  await window.__sleep(400);
  var rows = document.querySelectorAll("#modal-tracks li");
  var lastRow = rows[rows.length - 1];
  T("row_count", rows.length);
  T("last_row", boxOf(lastRow));
`;

function render(size) {
  const r = harness.renderPage({ name: "modal-clearance-" + size, windowSize: size,
                                 stub: STUB, driver: DRIVER, budgetMs: 45000 });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the album view's content clears the now-playing pill", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  // Phone landscape is where it was reported; the desktop size is here because
  // a long album reaches the bottom of the centred dialog there too, so the
  // same reserve is doing the same job at both.
  for (const size of ["844x390", "1400x900"]) {
    await t.test("at " + size, () => {
      const r = render(size);
      assert.equal(r.bar_showing, true, "the fixture is not showing a transport bar");
      assert.equal(r.scrolls, true, "the fixture is not tall enough to scroll, so it tests nothing");
      assert.ok(r.row_count >= 10, "only " + r.row_count + " rows — the fixture shrank");

      // THE assertion. Scrolled to the very end, the last row must be fully
      // above the pill: that is what "there is no way to scroll it out from
      // under there" means.
      assert.ok(r.last_row.bottom <= r.bar.top,
        "scrolled to the end, the last track runs to y=" + r.last_row.bottom +
        " and the transport pill starts at y=" + r.bar.top +
        " — the last " + (r.last_row.bottom - r.bar.top) + "px are behind it");

      // And the panel really does reach into the pill's band, or the test
      // would pass for a layout that never had the problem.
      assert.ok(r.panel.bottom > r.bar.top,
        "at " + size + " the panel ends at " + r.panel.bottom + " and the pill " +
        "starts at " + r.bar.top + ", so they do not overlap and this size is " +
        "not exercising the reserve at all");
    });
  }
});
