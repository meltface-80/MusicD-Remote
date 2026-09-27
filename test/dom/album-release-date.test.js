"use strict";
// ---------------------------------------------------------------------------
// v1.8.62: the album view shows the album's full release date.
//
// Asked for directly: "I want to see the full release dates per album on the
// album view screens." The header line read "Artist · 2026" — the year alone,
// and MusicBrainz's loosest guess at it — while the Release date sort was
// ordering the same album by a day the page never showed. The page now shows
// the sort's own date (`release_date` from /api/album/extras): the day where
// one is known, the month where only that is, the year otherwise.
//
// The date is written the way the DEVICE writes dates (toLocaleDateString), so
// the assertions look for its parts rather than one spelling of it.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ZONE = {
  zone_id: "z1", display_name: "Living Room", state: "stopped",
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Living Room", is_muted: false,
              volume: { type: "number", min: 0, max: 100, value: 40, step: 1 } }],
  now_playing: null,
};
const ALBUMS = [{ offset: 0, title: "Floating", subtitle: "Emile Parisien", image_key: "k" }];
const DETAIL = {
  title: "Floating", subtitle: "Emile Parisien", image_key: "k",
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [{ title: "Floating", subtitle: "Emile Parisien" }],
};

function stub(extras) {
  return `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); } catch (e) { /* storage optional: the zone falls back to the first */ }
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/album/extras") > -1)   return window.__json(${JSON.stringify(extras)});
  if (u.indexOf("/api/album") > -1)          return window.__json(${JSON.stringify(DETAIL)});
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 1, filtered: false });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zone });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [window.__zone] });
  if (u.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/settings") > -1)   return window.__json({});
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [], history: [] });
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(700);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);
  document.querySelectorAll("#album-grid .album")[0].click();
  await window.__sleep(1200);
  var modal = document.getElementById("album-modal");
  T("open", !!modal && !modal.classList.contains("hidden") && !modal.classList.contains("np-mode"));
  var dates = modal.querySelectorAll(".modal-subtitle-year");
  T("date_text", dates.length ? dates[0].textContent : null);
  // The same date, as this browser writes it — so the check is on the spelling
  // the device would use, not on one locale's.
  T("september", new Date(Date.UTC(2026, 8, 25)).toLocaleDateString(undefined,
    { month: "long", timeZone: "UTC" }));
`;

function render(name, extras) {
  const r = harness.renderPage({ name, windowSize: "390x844", stub: stub(extras), driver: DRIVER });
  harness.assertNoPageError(assert, r);
  assert.equal(r.open, true, "the album view did not open");
  return r;
}

test("album view: the full release date, as the Release date sort has it (v1.8.62)",
  { concurrency: 1 }, async (t) => {
    if (!harness.available) { t.skip("no chromium binary available"); return; }

    await t.test("to the day: day, month and year", () => {
      const r = render("album-date-day", { year: 2026, release_date: "2026-09-25" });
      assert.ok(r.date_text && r.date_text.startsWith(" · "), "no date on the header line: " + r.date_text);
      assert.match(r.date_text, /\b25\b/, "the day is missing: " + r.date_text);
      assert.ok(r.date_text.includes(r.september), "the month is missing: " + r.date_text);
      assert.match(r.date_text, /\b2026\b/, "the year is missing: " + r.date_text);
    });

    await t.test("a date for which only the month is known shows the month, and no invented day", () => {
      const r = render("album-date-month", { year: 2026, release_date: "2026-09" });
      assert.ok(r.date_text.includes(r.september), r.date_text);
      assert.match(r.date_text, /\b2026\b/, r.date_text);
      assert.doesNotMatch(r.date_text, /\b(1|01)\b/, "a month-only date was shown as the 1st: " + r.date_text);
    });

    await t.test("the year alone when that is all there is — and the old year field still works", () => {
      assert.equal(render("album-date-year", { year: 2026, release_date: "2026" }).date_text, " · 2026");
      assert.equal(render("album-date-legacy", { year: 2019 }).date_text, " · 2019",
        "a server that sends no release_date lost the year the page always showed");
    });
  });
