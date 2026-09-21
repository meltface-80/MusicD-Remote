"use strict";
// ---------------------------------------------------------------------------
// v1.8.28: the links under the share card, and the two Settings pages that
// decide which of them appear.
//
// lib/share-links.js is unit-tested on its own (test/unit/share-links.test.js)
// — every URL rule lives there. This file is about the wiring either side of
// it, which is where a ported feature actually breaks:
//
//   * the chips come off the extras response the card ALREADY waits for, so
//     there must be no second request;
//   * a chip's label is a constant, never anything off the record — the row is
//     a grid with one shared height, and one six-line chip turns the rest into
//     circles (the bug this port inherited the fix for);
//   * the Settings lists are built from the server's table rather than from
//     markup, so they cannot offer a service the links builder does not know;
//   * a switch turned off SAVES as an empty array rather than as nothing,
//     which is the difference between "all off" and "unset".
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const ALBUM = { offset: 0, title: "Low", subtitle: "David Bowie", image_key: "k0" };

// The server's own shape, as /api/album/extras now answers it.
const EXTRAS = {
  year: 1977,
  album: { description: "Low is the eleventh studio album by David Bowie.", year: 1977,
           label: "RCA", url: "https://pitchfork.com/reviews/albums/bowie-low/",
           source: "Pitchfork", score: 9.6, isBestNewMusic: false },
  artist: null,
  links: {
    services: [
      { id: "qobuz",   name: "Qobuz",   url: "https://www.qobuz.com/gb-en/search/?q=David%20Bowie%20Low" },
      { id: "tidal",   name: "TIDAL",   url: "https://tidal.com/search?q=David%20Bowie%20Low" },
      { id: "spotify", name: "Spotify", url: "https://open.spotify.com/search/David%20Bowie%20Low" },
    ],
    reviews: [
      { id: "wikipedia", name: "Wikipedia", chip: "Wikipedia", kind: "album",
        url: "https://en.wikipedia.org/wiki/Low_(David_Bowie_album)" },
      { id: "allmusic-artist", name: "AllMusic", chip: "AllMusic artist", kind: "artist",
        url: "https://www.allmusic.com/search/artists/David%20Bowie" },
    ],
  },
};

const SHARE_SETTINGS = {
  services: {
    all: [{ id: "qobuz", name: "Qobuz" }, { id: "tidal", name: "TIDAL" },
          { id: "spotify", name: "Spotify" }, { id: "bandcamp", name: "Bandcamp" }],
    enabled: ["qobuz", "tidal", "spotify"],
  },
  reviews: {
    all: [{ id: "wikipedia", name: "Wikipedia", chip: "Wikipedia" },
          { id: "pitchfork", name: "Pitchfork", chip: "Pitchfork" },
          { id: "allmusic-artist", name: "AllMusic", chip: "AllMusic artist" }],
    enabled: ["wikipedia"],
  },
};

const STUB_FOR = (theme) => `
window.__posts = [];
try {
  localStorage.setItem("rra-zone", "z1");
  localStorage.setItem("rra-theme-v2", ${JSON.stringify(theme)});
} catch (e) {}  // storage optional
window.__installFetch(function (u, opts) {
  if (u.indexOf("/api/settings/share-links") > -1) {
    if (opts && opts.method === "POST") {
      window.__posts.push(JSON.parse(opts.body || "{}"));
      return window.__json({ ok: true });
    }
    return window.__json(${JSON.stringify(SHARE_SETTINGS)});
  }
  if (u.indexOf("/api/album/extras") > -1) return window.__json(${JSON.stringify(EXTRAS)});
  if (u.indexOf("/api/album?") > -1)
    return window.__json({ album: ${JSON.stringify(ALBUM)}, tracks: [], actions: [], offset: 0, artists: ["David Bowie"] });
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [${JSON.stringify(ALBUM)}], total: 1, filtered: false });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "stopped", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

const DRIVER = `
  await window.__sleep(700);

  // ---- the chips under the card ----
  var extrasBefore = window.__callsMatching("/api/album/extras");
  window.__openShareCard({ title: "Low", artist: "David Bowie", image_key: "k0" });
  for (var w = 0; w < 60; w++) {
    if (document.querySelectorAll("#share-links .share-link").length) break;
    await window.__sleep(100);
  }
  var chips = Array.prototype.slice.call(document.querySelectorAll("#share-links .share-link"));
  T("chip_count", chips.length);
  T("chips", chips.map(function (a) {
    var r = a.getBoundingClientRect();
    return { text: a.textContent, href: a.getAttribute("href"),
             rel: a.getAttribute("rel"), target: a.getAttribute("target"),
             review: a.classList.contains("is-review"),
             w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) };
  }));
  T("links_visible", !document.getElementById("share-links").classList.contains("hidden"));
  // The computed FILL of each chip, and the surface behind the row. A variant
  // defined by removing its background has no floor: how visible it stays
  // depends on how far apart two theme tokens are, which is a different answer
  // per palette.
  T("fills", chips.map(function (a) {
    return { text: a.textContent, review: a.classList.contains("is-review"),
             bg: getComputedStyle(a).backgroundColor,
             border: getComputedStyle(a).borderTopColor };
  }));
  T("panel_bg", getComputedStyle(document.querySelector("#share-overlay .share-panel")).backgroundColor);
  // One round trip, not two: the chips ride on the request the card makes.
  T("extras_calls", window.__callsMatching("/api/album/extras") - extrasBefore);

  // ---- closing the card clears them ----
  var x = document.querySelector("#share-overlay [data-share-close]");
  if (x) x.click();
  await window.__sleep(250);
  T("chips_after_close", document.querySelectorAll("#share-links .share-link").length);
  T("hidden_after_close", document.getElementById("share-links").classList.contains("hidden"));

  // ---- the two Settings pages ----
  document.getElementById("settings-overlay").classList.remove("hidden");
  await window.__sleep(250);
  function rows(sel) {
    return Array.prototype.map.call(document.querySelectorAll(sel + " .settings-row"), function (r) {
      var c = r.querySelector('input[type="checkbox"]');
      return { label: r.querySelector(".settings-label").textContent,
               id: c ? c.dataset.id : null, on: c ? c.checked : null };
    });
  }
  T("service_rows", rows("#share-services-list"));
  T("review_rows",  rows("#share-reviews-list"));
  // Room between the switches. Each row is exactly its switch's height, so
  // without a gap five that are all ON merge into one unbroken column of
  // colour and stop reading as five controls.
  //
  // The PANE has to be open for this: the rows are populated at startup
  // whether or not it is showing, so reading their text works while hidden —
  // but getBoundingClientRect on a hidden subtree is all zeros, and zeros look
  // exactly like rows that are touching.
  document.querySelector('.settings-nav-item[data-pane="sharecard"]').click();
  await window.__sleep(250);
  T("pane_open", !document.querySelector('.settings-pane[data-pane="sharecard"]').classList.contains("hidden"));
  function gapsIn(sel) {
    var rs = document.querySelectorAll(sel + " .settings-row");
    var out = [];
    for (var i = 1; i < rs.length; i++) {
      out.push(Math.round(rs[i].getBoundingClientRect().top - rs[i - 1].getBoundingClientRect().bottom));
    }
    return out;
  }
  T("service_gaps", gapsIn("#share-services-list"));
  T("review_gaps",  gapsIn("#share-reviews-list"));

  // Turning one off posts the WHOLE list, not a delta.
  var tidal = document.querySelector('#share-services-list input[data-id="tidal"]');
  tidal.checked = false;
  tidal.dispatchEvent(new Event("change", { bubbles: true }));
  await window.__sleep(250);
  T("post_after_off", window.__posts[window.__posts.length - 1] || null);

  // Turning them ALL off must post [], not nothing.
  Array.prototype.forEach.call(document.querySelectorAll('#share-reviews-list input[type="checkbox"]'),
    function (c) { if (c.checked) { c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); } });
  await window.__sleep(300);
  T("post_all_off", window.__posts[window.__posts.length - 1] || null);
`;

function render(size, theme) {
  const t = theme || "dark";
  const r = harness.renderPage({ stub: STUB_FOR(t), driver: DRIVER,
                                 name: "share-links-" + t + "-" + size.split("x")[0], windowSize: size });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the share card links to services and reviews", { concurrency: 1 }, async (t) => {
  await t.test("the chips render, from the card's own round trip", () => {
    const r = render("390x844");
    assert.equal(r.chip_count, 5, "expected 3 services + 2 reviews, got " + r.chip_count);
    assert.equal(r.links_visible, true, "the links row stayed hidden");
    assert.equal(r.extras_calls, 1,
      "the share card made " + r.extras_calls + " calls to /api/album/extras — the chips are " +
      "supposed to ride on the one the card already makes");

    const by = Object.fromEntries(r.chips.map(c => [c.text, c]));
    assert.ok(by["Qobuz"], "no Qobuz chip: " + r.chips.map(c => c.text).join(", "));
    assert.equal(by["Qobuz"].href, "https://www.qobuz.com/gb-en/search/?q=David%20Bowie%20Low");
    assert.equal(by["Wikipedia"].href, "https://en.wikipedia.org/wiki/Low_(David_Bowie_album)");
    // Both AllMusic chips can be on at once, so the label says which this is.
    assert.ok(by["AllMusic artist"], "the artist chip lost its qualifier");

    // Services first, then the quieter review chips.
    assert.equal(by["Qobuz"].review, false);
    assert.equal(by["Wikipedia"].review, true);
  });

  await t.test("every chip opens safely, in a new tab", () => {
    const r = render("390x844");
    for (const c of r.chips) {
      assert.equal(c.target, "_blank", c.text + " does not open in a new tab");
      // noreferrer as well as noopener: these are other people's search pages.
      assert.ok(/noopener/.test(c.rel) && /noreferrer/.test(c.rel),
        c.text + ' has rel="' + c.rel + '"');
      assert.ok(/^https:/.test(c.href), c.text + " is not https: " + c.href);
    }
  });

  await t.test("the row is a grid: one height, columns that match", () => {
    // The inherited bug: a chip labelled from the record ran six lines deep and
    // every chip beside it became a circle. Constant labels are what prevent
    // it, and a shared height is what makes it visible when they stop being
    // constant.
    const r = render("390x844");
    const byRow = new Map();
    for (const c of r.chips) byRow.set(c.y, [...(byRow.get(c.y) || []), c]);
    for (const [y, row] of byRow) {
      const hs = row.map(c => c.h);
      assert.ok(Math.max(...hs) - Math.min(...hs) <= 1,
        "the chips at y=" + y + " are " + hs.join(", ") + "px tall — the row has lost its shared height");
      const ws = row.map(c => c.w);
      assert.ok(Math.max(...ws) - Math.min(...ws) <= 1,
        "the chips at y=" + y + " are " + ws.join(", ") + "px wide — the columns are uneven");
    }
    for (const c of r.chips) {
      assert.ok(c.h <= 72, c.text + " is " + c.h + "px tall — a chip that deep sets the row's height");
      assert.ok(c.h >= 36, c.text + " is only " + c.h + "px tall");
    }
  });

  await t.test("every chip looks the same, on the light palettes too", () => {
    // THE REPORTED BUG, and it only existed on light. The review chips were
    // hollow — background: transparent — which on the dark palettes read as a
    // quieter variant and on the light ones left five labels floating with no
    // button under them, because --bg-elev-2 is barely off the panel there.
    for (const theme of ["light", "brass-light", "dark", "copper-dark"]) {
      const r = render("390x844", theme);
      const services = r.fills.filter(f => !f.review);
      const reviews  = r.fills.filter(f => f.review);
      assert.ok(services.length && reviews.length,
        "need both kinds of chip to compare on " + theme);

      const want = services[0].bg;
      for (const f of reviews) {
        assert.equal(f.bg, want,
          f.text + " is filled " + f.bg + " on the " + theme + " palette while the " +
          "service chips are " + want + ". Every chip is meant to look the same: a " +
          "variant defined by REMOVING the fill has no floor, because how visible it " +
          "stays depends entirely on how far apart two theme tokens happen to be.");
      }
      // And independently of parity: no chip may be transparent, or it has no
      // button under it whatever the services happen to look like.
      for (const f of r.fills) {
        assert.ok(!/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(f.bg),
          f.text + " has no fill at all on the " + theme + " palette");
      }
    }
  });

  await t.test("the toggle rows are not touching", () => {
    for (const theme of ["light", "dark"]) {
      const r = render("390x844", theme);
      assert.equal(r.pane_open, true,
        "the Share Card pane never opened, so every rect below is zero");
      for (const [what, gaps] of [["Services", r.service_gaps], ["Reviews", r.review_gaps]]) {
        assert.ok(gaps.length, "no " + what + " rows to measure on " + theme);
        for (const g of gaps) {
          assert.ok(g >= 8,
            what + " rows are " + g + "px apart on " + theme + " — each row is exactly " +
            "its switch's height, so without a gap five switches that are all ON merge " +
            "into a single column of colour");
        }
      }
    }
  });

  await t.test("closing the card clears the row", () => {
    const r = render("390x844");
    assert.equal(r.chips_after_close, 0, "the previous album's links survived the close");
    assert.equal(r.hidden_after_close, true, "an empty links row is a gap under the card");
  });

  await t.test("the Settings lists are built from the server's table", () => {
    const r = render("390x844");
    assert.deepEqual(r.service_rows.map(x => x.id), ["qobuz", "tidal", "spotify", "bandcamp"],
      "the Services list does not match the table the server sent");
    assert.deepEqual(r.service_rows.map(x => x.on), [true, true, true, false],
      "the switches do not reflect the enabled set");
    // The chip label, so this screen reads the same as the row it controls.
    assert.deepEqual(r.review_rows.map(x => x.label),
      ["Wikipedia", "Pitchfork", "AllMusic artist"]);
    assert.deepEqual(r.review_rows.map(x => x.on), [true, false, false]);
  });

  await t.test("a switch saves the whole list, and 'all off' is not 'unset'", () => {
    const r = render("390x844");
    assert.deepEqual(r.post_after_off, { services: ["qobuz", "spotify"] },
      "turning TIDAL off should post the remaining list, not a delta");
    assert.deepEqual(r.post_all_off, { reviews: [] },
      "turning them all off must post an empty array — posting nothing is how an " +
      "off switch quietly turns itself back on");
  });
});
