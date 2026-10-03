"use strict";
// ---------------------------------------------------------------------------
// v1.8.75: the album view's corner button, Now playing's way back, and the
// reduced Now playing card.
//
//   * From 720px up the album view is a card over the page, and it closes with
//     an × (it was the back chevron of the full-screen phone layout). Its
//     artwork starts below the corner buttons — the × sat on the cover's corner
//     — and the prev/next chevrons stay on the cover's centre line.
//   * Now playing is the SAME modal as the album view, so tapping the mini
//     player over an open album replaced it, and the only way out was Home.
//     Its top-left button is a Back now, which puts back the album it replaced.
//   * On a large screen Now playing can be reduced to the album view's card
//     size and back.
//   * The share card's × is a brass disc like every other corner button.
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
  now_playing: { line1: "Sunday", line2: "David Bowie", line3: "Heathen",
                 image_key: "k", length: 285, seek_position: 34 },
};
const ALBUMS = [
  { offset: 0, title: "Low", subtitle: "David Bowie", image_key: "k0" },
  { offset: 1, title: "Station to Station", subtitle: "David Bowie", image_key: "k1" },
  { offset: 2, title: "Heroes", subtitle: "David Bowie", image_key: "k2" },
];
const DETAIL = {
  title: "Station to Station", subtitle: "David Bowie", image_key: "k1",
  actions: [{ kind: "play_now", title: "Play Now" }, { kind: "queue", title: "Queue" }],
  tracks: [{ title: "Golden Years", subtitle: "David Bowie" }],
};
const NP_DETAIL = {
  album: { title: "Heathen", subtitle: "David Bowie", image_key: "k" },
  tracks: [{ title: "Sunday", subtitle: "David Bowie" }],
};

const STUB = `
window.__zone = ${JSON.stringify(ZONE)};
try { localStorage.setItem("rra-zone", "z1"); localStorage.removeItem("rra-np-reduced"); }
catch (e) { /* storage optional: the zone falls back to the first */ }
window.__installFetch(function (u) {
  if (u.indexOf("/api/user-playlists") > -1) return window.__json({ playlists: [] });
  if (u.indexOf("/api/album/now-playing") > -1) return window.__json(${JSON.stringify(NP_DETAIL)});
  if (u.indexOf("/api/album/extras") > -1)   return window.__json({});
  if (u.indexOf("/api/album") > -1)          return window.__json(${JSON.stringify(DETAIL)});
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: ${JSON.stringify(ALBUMS)}, total: 3, filtered: false });
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

const DRIVER = `
  function box(sel) {
    var e = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!e) return null;
    var b = e.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height,
             mid: b.top + b.height / 2, shown: getComputedStyle(e).display !== "none" && b.width > 0 };
  }
  function colourOf(v) {
    var p = document.createElement("span"); p.style.color = v;
    document.body.appendChild(p); var c = getComputedStyle(p).color; p.remove(); return c;
  }
  await window.__sleep(700);
  document.getElementById("menu-toggle").click();
  await window.__sleep(250);
  document.querySelector('.menu-item[data-action="shuffle"]').click();
  await window.__sleep(900);

  // The middle tile, so there is a neighbour both ways and both chevrons show.
  document.querySelectorAll("#album-grid .album")[1].click();
  await window.__sleep(1100);
  var modal = document.getElementById("album-modal");
  var close = document.getElementById("modal-close-btn");
  T("album_open", !modal.classList.contains("hidden") && !modal.classList.contains("np-mode"));
  T("close", box(close));
  T("x_shown", box(close.querySelector(".ico-close")).shown);
  T("back_shown", box(close.querySelector(".ico-back")).shown);
  T("close_label", close.getAttribute("aria-label"));
  T("art", box(".modal:not(.np-mode) .modal-art"));
  T("prev", box("#modal-prev"));
  T("next", box("#modal-next"));
  T("title_before", document.getElementById("modal-title").textContent);

  // The mini player, over the open album.
  document.querySelector("#mini-transport .mt-info").click();
  await window.__sleep(1100);
  T("np_open", modal.classList.contains("np-mode"));
  var home = document.getElementById("modal-home-btn");
  T("np_back_label", home.getAttribute("aria-label"));
  var size = document.getElementById("modal-np-size-btn");
  T("size_shown", box(size).shown);
  T("np_panel_full", box(".modal-panel"));

  size.click();
  await window.__sleep(300);
  T("reduced", modal.classList.contains("np-reduced"));
  T("size_label_reduced", size.getAttribute("aria-label"));
  T("np_panel_reduced", box(".modal-panel"));
  T("stored", (function () { try { return localStorage.getItem("rra-np-reduced"); } catch (e) { return null; } })());
  size.click();
  await window.__sleep(300);
  T("full_again", !modal.classList.contains("np-reduced"));

  // The backdrop round the reduced card is a way back too, not "close all".
  size.click();
  await window.__sleep(300);
  modal.querySelector(".modal-backdrop").click();
  await window.__sleep(1100);
  T("after_backdrop", { hidden: modal.classList.contains("hidden"), np: modal.classList.contains("np-mode"),
                        title: document.getElementById("modal-title").textContent });
  try { localStorage.setItem("rra-np-reduced", "0"); } catch (e) {}
  document.querySelector("#mini-transport .mt-info").click();
  await window.__sleep(1100);
  if (modal.classList.contains("np-reduced")) size.click();

  home.click();
  await window.__sleep(1100);
  T("steps_after_back", { prev: box("#modal-prev").shown, next: box("#modal-next").shown });
  T("after_back", { hidden: modal.classList.contains("hidden"), np: modal.classList.contains("np-mode"),
                    title: document.getElementById("modal-title").textContent,
                    reduced: modal.classList.contains("np-reduced") });

  // Now playing opened with NOTHING open: Back just closes it.
  close.click();
  await window.__sleep(400);
  document.querySelector("#mini-transport .mt-info").click();
  await window.__sleep(1100);
  home.click();
  await window.__sleep(600);
  T("after_back_plain", { hidden: modal.classList.contains("hidden") });

  // The share card's ×.
  window.__openShareCard && window.__openShareCard({ title: "Low", artist: "David Bowie", image_key: "k0" });
  await window.__sleep(500);
  var sc = document.querySelector(".share-close");
  T("share_close", sc ? { bg: getComputedStyle(sc).backgroundColor, radius: getComputedStyle(sc).borderTopLeftRadius } : null);
  T("accent", colourOf("var(--accent)"));
`;

test("album card ×, Now playing's Back and the reduced card (v1.8.75) — desktop", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({ name: "np-back-desktop", windowSize: "1440x900", stub: STUB, driver: DRIVER,
                                 budgetMs: 30000 });
  harness.assertNoPageError(assert, r);

  await t.test("the album card closes with an ×", () => {
    assert.equal(r.album_open, true);
    assert.equal(r.x_shown, true, "the × glyph is not shown on the card");
    assert.equal(r.back_shown, false, "the back chevron is still shown on the card");
    assert.equal(r.close_label, "Close");
  });

  await t.test("the artwork starts below the corner button", () => {
    assert.ok(r.art.top >= r.close.bottom + 8,
      `the cover starts at y=${r.art.top}, under the × (which ends at ${r.close.bottom})`);
  });

  await t.test("the prev/next chevrons stay on the cover's centre line", () => {
    for (const k of ["prev", "next"]) {
      assert.equal(r[k].shown, true, k + " is not shown");
      assert.ok(Math.abs(r[k].mid - r.art.mid) <= 1, `${k} is centred at ${r[k].mid}, the cover at ${r.art.mid}`);
    }
  });

  await t.test("Now playing has a Back, and a size button on a large screen", () => {
    assert.equal(r.np_open, true);
    assert.equal(r.np_back_label, "Back");
    assert.equal(r.size_shown, true);
  });

  await t.test("Reduce size makes it the album card's size, and it comes back", () => {
    assert.equal(r.reduced, true);
    assert.equal(r.size_label_reduced, "Full size");
    assert.ok(r.np_panel_reduced.w <= 960.5, "the reduced card is " + r.np_panel_reduced.w + "px wide");
    assert.ok(r.np_panel_reduced.w < r.np_panel_full.w, "the card did not get smaller");
    assert.ok(r.np_panel_reduced.h > 300, "the reduced card collapsed to " + r.np_panel_reduced.h + "px");
    assert.equal(r.stored, "1", "the choice is not remembered on this device");
    assert.equal(r.full_again, true);
  });

  await t.test("THE REPORTED ONE: Back returns to the album the mini player replaced", () => {
    assert.equal(r.after_back.hidden, false, "Back closed everything instead of returning to the album");
    assert.equal(r.after_back.np, false);
    assert.equal(r.after_back.title, r.title_before);
    assert.equal(r.after_back.reduced, false);
  });

  await t.test("a click outside the reduced card also returns to the album", () => {
    assert.equal(r.after_backdrop.hidden, false, "the backdrop closed everything");
    assert.equal(r.after_backdrop.np, false);
    assert.equal(r.after_backdrop.title, r.title_before);
  });

  await t.test("the album it returns to still steps to its neighbours", () => {
    assert.deepEqual(r.steps_after_back, { prev: true, next: true });
  });

  await t.test("with nothing open underneath, Back just closes Now playing", () => {
    assert.equal(r.after_back_plain.hidden, true);
  });

  await t.test("the share card's × is a brass disc", () => {
    assert.ok(r.share_close, "no share card ×");
    assert.equal(r.share_close.bg, r.accent);
    assert.equal(r.share_close.radius, "50%");
  });
});

test("on a phone held upright the album view keeps its back chevron, and no size button", { concurrency: 1 }, async (t) => {
  if (!harness.available) { t.skip("no chromium binary available"); return; }
  const r = harness.renderPage({ name: "np-back-phone", windowSize: "390x844", stub: STUB, driver: DRIVER,
                                 budgetMs: 30000 });
  harness.assertNoPageError(assert, r);
  assert.equal(r.back_shown, true);
  assert.equal(r.x_shown, false);
  assert.equal(r.close_label, "Back");
  assert.equal(r.size_shown, false, "the size button showed on a phone");
  assert.equal(r.after_back.title, r.title_before, "Back on a phone did not return to the album either");
});
