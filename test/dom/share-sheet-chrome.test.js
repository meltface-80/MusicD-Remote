"use strict";
// ---------------------------------------------------------------------------
// The share sheet's own chrome: what can be reached, and what should not be
// offered.
//
// TWO THINGS, both reported from an installed iOS app.
//
// 1. The sheet's last rows sat under the now-playing pill with no way to get
//    them out. The pill floats over this overlay (z-index 70 against the
//    overlay's 60) and the panel is its own scroller, so once the panel has
//    scrolled to its end, anything inside that last ~106px is simply
//    unreachable. Same class as v1.8.50's album view, and the same fix: the
//    scroller reserves the room.
//
// 2. The Download button does nothing useful there. `<a download>` is not
//    implemented in WebKit on iOS — the attribute is ignored, so the control
//    either navigates to a blob: URL or does nothing, and a standalone app has
//    no browser chrome to come back from. Long-pressing the image is the real
//    Save Image, and the hint already says so.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const EXTRAS = {
  year: 2019,
  album: {
    description: "Western Stars is the nineteenth studio album by Bruce Springsteen.",
    description_source: "Wikipedia",
    year: 2019, label: "Columbia",
    url: "https://pitchfork.com/reviews/albums/x/",
    source: "Pitchfork", score: 7.8, isBestNewMusic: false,
  },
  artist: null,
  // A REALISTIC sheet, because an empty one does not scroll and a panel that
  // does not scroll cannot demonstrate anything about reaching its last row.
  // This is the chip set the screenshots show.
  links: {
    services: [
      { id: "qobuz",  chip: "Qobuz",  url: "https://open.qobuz.com/" },
      { id: "spotify", chip: "Spotify", url: "https://open.spotify.com/" },
      { id: "tidal",  chip: "TIDAL",  url: "https://tidal.com/" },
      { id: "apple",  chip: "Apple Music", url: "https://music.apple.com/" },
      { id: "amazon", chip: "Amazon Music", url: "https://music.amazon.com/" },
      { id: "deezer", chip: "Deezer", url: "https://deezer.com/" },
      { id: "bandcamp", chip: "Bandcamp", url: "https://bandcamp.com/" },
    ],
    reviews: [
      { id: "wikipedia", chip: "Wikipedia", url: "https://en.wikipedia.org/" },
      { id: "pitchfork", chip: "Pitchfork", url: "https://pitchfork.com/" },
      { id: "allmusic",  chip: "AllMusic",  url: "https://allmusic.com/" },
      { id: "wikiartist", chip: "Wikipedia artist", url: "https://en.wikipedia.org/" },
      { id: "amartist",   chip: "AllMusic artist",  url: "https://allmusic.com/" },
    ],
  },
};

function stub(extra) {
  return `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
${extra || ""}
window.__installFetch(function (u) {
  if (u.indexOf("/api/album/extras") > -1) return window.__json(${JSON.stringify(EXTRAS)});
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "playing", outputs: [] }] });
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;
}

const DRIVER = `
  await window.__sleep(600);
  ShareCard.render = function () {
    return Promise.resolve(new Blob([new Uint8Array([1,2,3])], { type: "image/png" }));
  };
  window.__openShareCard({ title: "Western Stars", artist: "Bruce Springsteen", image_key: "k0" });
  const actions = document.getElementById("share-actions");
  const hintEl  = document.getElementById("share-hint");
  // WAIT ON THE HINT, not on the action count. buildActions() sets the hint
  // last and unconditionally, whereas the number of buttons is exactly what
  // varies here — in headless Chromium there is no Web Share and no clipboard
  // write, so on the standalone-iOS path the actions row ends up EMPTY and a
  // loop waiting for a child never finishes. It then burned six seconds of the
  // virtual time budget and the test passed or failed depending on how loaded
  // the machine was, which is worse than either answer.
  for (var w = 0; w < 80 && !hintEl.textContent; w++) await window.__sleep(50);

  // The stubbed renderer hands back three bytes, which decode to no image and
  // therefore no height — so the frame is given the height a real 1200x1471
  // card would occupy at this width. Without it the panel is short for a
  // reason that has nothing to do with the layout being tested.
  const frame = document.getElementById("share-frame");
  frame.style.minHeight = "480px";
  await window.__sleep(50);

  const panel = document.querySelector(".share-panel");
  const cs = getComputedStyle(panel);

  // Scroll the panel to its very end — the state in which anything inside the
  // reserve is unreachable if the reserve is not there.
  panel.scrollTop = panel.scrollHeight;
  await window.__sleep(50);

  T('reserve', Math.round(parseFloat(cs.paddingBottom) || 0));
  T('scrollable', panel.scrollHeight > panel.clientHeight + 2);
  // Reported so a failure says WHY rather than just that it happened. A panel
  // that did not overflow and a panel whose last row is buried look identical
  // from the assertion alone.
  T('sh', Math.round(panel.scrollHeight));
  T('ch', Math.round(panel.clientHeight));
  T('frame_h', Math.round(frame.getBoundingClientRect().height));
  T('chips', document.querySelectorAll('#share-links .share-link').length);
  T('last_tag', last_tagOf(panel));

  // The LAST thing in the sheet, and where its bottom sits once scrolled to
  // the end. This is the measurement that matters: it is what the reserve is
  // for.
  function last_tagOf(p) {
    const e = p.lastElementChild;
    return e ? (e.tagName + '.' + (e.className || '')).slice(0, 40) : 'none';
  }
  const last = panel.lastElementChild;
  const lastBottom = last ? last.getBoundingClientRect().bottom : 0;
  const panelBottom = panel.getBoundingClientRect().bottom;
  T('last_bottom', Math.round(lastBottom));
  T('panel_bottom', Math.round(panelBottom));
  T('clear_by', Math.round(panelBottom - lastBottom));

  T('has_download', !!Array.from(actions.querySelectorAll('a')).some(a => a.hasAttribute('download')));
  T('hint', hintEl.textContent || '');
  // Proof the sheet actually finished, so an assertion about what is absent
  // cannot pass because nothing was ever built.
  T('built', !!hintEl.textContent);
`;

function run(name, extra) {
  const r = harness.renderPage({ stub: stub(extra), driver: DRIVER, name,
                                 // 60s, matching the other share tests. This
                                 // ran at 25s and passed alone while failing
                                 // under the full suite: the DOM files run in
                                 // parallel, so a tight budget measures how
                                 // loaded the machine is rather than the page.
                                 windowSize: "390x844", budgetMs: 60000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.built, true,
    "the share sheet never finished building, so nothing below this measures " +
    "what it claims to");
  return r;
}

test("the share sheet reserves room for the transport pill", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = run("share-sheet-reserve");

  await t.test("the scroller reserves the pill's height", () => {
    // 106px is the pill plus its float gap, the same number .modal-body uses.
    // Headless Chromium has no safe-area inset, so this is the bare figure.
    assert.ok(r.reserve >= 100,
      `the panel reserves ${r.reserve}px at the bottom — the now-playing pill is ` +
      `about 106px tall and floats over this overlay, so its last content is ` +
      `unreachable once the panel has scrolled to its end`);
  });

  await t.test("scrolled to the end, the last row clears the pill", () => {
    assert.equal(r.scrollable, true,
      `the fixture did not produce a scrolling panel, so this measures nothing ` +
      `(scrollHeight ${r.sh} vs clientHeight ${r.ch}, frame ${r.frame_h}px, ` +
      `${r.chips} chips)`);
    assert.ok(r.clear_by >= 100,
      `with the panel scrolled fully down, its last element ends ${r.clear_by}px ` +
      `above the panel's own bottom edge — the pill covers ~106px of that, so the ` +
      `last rows cannot be brought into view (bottom ${r.last_bottom} vs panel ` +
      `${r.panel_bottom}; scrollHeight ${r.sh}/clientHeight ${r.ch}, last is ` +
      `${r.last_tag}, ${r.chips} chips)`);
  });
});

test("the Download button is offered off iOS and withheld in an installed iOS app", async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }

  await t.test("a normal browser gets it", () => {
    const r = run("share-sheet-dl-desktop");
    assert.equal(r.has_download, true,
      "the Download button is missing where <a download> works perfectly well");
  });

  await t.test("an installed iOS app does not", () => {
    // Both halves of the detection, because either alone is wrong: the platform
    // test without standalone would strip the button from Safari tabs, where it
    // still has a tab to come back to.
    const r = run("share-sheet-dl-ios", `
      Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
      Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    `);
    assert.equal(r.has_download, false,
      "the Download button is still offered in a standalone iOS app, where " +
      "<a download> is ignored by WebKit and the control navigates away from " +
      "an app that has no chrome to come back from");
    assert.doesNotMatch(r.hint, /tap Download/i,
      `the hint still reads "${r.hint}" and points at a button that is not there`);
    assert.match(r.hint, /long-press/i,
      "the hint no longer tells the user how to actually save the card");
  });

  await t.test("iOS in a browser tab keeps it", () => {
    const r = run("share-sheet-dl-ios-tab", `
      Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
    `);
    assert.equal(r.has_download, true,
      "the button was removed from a normal iOS Safari tab — there the page can " +
      "be navigated back from, so only the standalone case is the problem");
  });
});
