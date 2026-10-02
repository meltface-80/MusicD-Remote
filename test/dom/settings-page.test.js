"use strict";
// ---------------------------------------------------------------------------
// v1.8.69: Settings as Mandarin draws it — full screen, and a list.
//
// Asked for: "I want the settings page to be like Mandarin's. Not large
// buttons. I also want all settings pages to open full screen. Currently they
// open depending on content on the page."
//
// Two changes, measured from the real page:
//
//   1. FULL SCREEN, on every page. The sheet used to rise only as far as its
//      content (to a cap of 86vh), so each pane opened at its own height. The
//      list and EVERY pane are measured against the window here — including
//      the short ones, which are exactly the pages the old sheet left half
//      empty, and which a test of one long pane would not notice.
//   2. A LIST, not cards. One column of flat rows — icon, then title — the way
//      the side menu draws its rows. v1.8.27's two-column grid of 104px cards
//      is what "large buttons" refers to.
//
// What v1.8.27 got right about the CONTENT is kept and still pinned: every row
// reaches a panel and every panel has a row (a misspelt data-pane is a dead
// button, a panel with no row is unreachable, and neither shows in a
// screenshot), and each panel's description lives in the panel, not the row.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const STUB = `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) { /* storage optional: the zone falls back to the first */ }
window.__installFetch(function (u) {
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
  await window.__sleep(600);
  var overlay = document.getElementById("settings-overlay");
  var sheet = overlay.querySelector(".settings-sheet");
  // This harness never advances a CSS animation, so the sheet would measure at
  // the first frame of its slide-up — a whole screen below where it settles
  // (the same trap as the side menu's drawer, v1.8.59). Measure where it rests.
  var still = document.createElement("style");
  still.textContent = ".settings-sheet { animation: none !important; }";
  document.head.appendChild(still);
  // The real way in: the side menu's Settings row clicks this button.
  document.getElementById("settings-toggle").click();
  await window.__sleep(400);
  function box(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             r: Math.round(r.right), b: Math.round(r.bottom) };
  }
  T("win", { w: window.innerWidth, h: window.innerHeight });
  T("open", !overlay.classList.contains("hidden"));
  T("sheet_home", box(sheet));
  T("sheet_scrolls_sideways", sheet.scrollWidth - sheet.clientWidth);

  var nav = document.querySelector(".settings-nav");
  var items = Array.prototype.slice.call(document.querySelectorAll(".settings-nav-item"));
  T("count", items.length);
  T("rows", items.map(function (b) {
    var ico = box(b.querySelector(".settings-nav-ico"));
    var title = box(b.querySelector(".settings-nav-title"));
    var rb = box(b);
    return { pane: b.getAttribute("data-pane"), x: rb.x, y: rb.y, w: rb.w, h: rb.h,
             ico: ico, title: title,
             bg: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderTopWidth };
  }));
  T("nav", box(nav));
  var foot = document.querySelector('.settings-view[data-view="home"] .settings-foot');
  T("foot", box(foot));
  T("sheet_scroll", { sh: sheet.scrollHeight, ch: sheet.clientHeight });
  var cs = getComputedStyle(sheet);
  T("pad", { b: parseFloat(cs.paddingBottom), t: parseFloat(cs.paddingTop) });
  // One ground: a full-screen panel is the page colour, the colour iOS fills
  // the status bar with.
  T("ground", { sheet: cs.backgroundColor, body: getComputedStyle(document.body).backgroundColor,
                head: getComputedStyle(document.querySelector('.settings-view[data-view="home"] .settings-head')).backgroundColor });
  // A button is still THE thing under its own centre — on screen, on top.
  function reachable(btn) {
    var b = btn.getBoundingClientRect();
    var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    var hit = (cy >= 0 && cy <= window.innerHeight) ? document.elementFromPoint(cx, cy) : null;
    return !!(hit && (hit === btn || btn.contains(hit)));
  }

  // A title that cannot wrap must not widen anything: it ellipsizes.
  var victim = items[0].querySelector(".settings-nav-title");
  var realTitle = victim.textContent;
  victim.textContent = "Supercalifragilisticexpialidociousandthensomemoreofthesame";
  await window.__sleep(120);
  T("long", { over: sheet.scrollWidth - sheet.clientWidth, row_w: box(items[0]).w,
              cut: victim.scrollWidth > victim.clientWidth,
              title_r: box(victim).r, row_r: box(items[0]).r });
  // And one that COULD wrap: a row is one line, like the side menu's, so a
  // long title with spaces is cut too rather than doubling its row's height.
  victim.textContent = "A category title long enough to need two lines on any phone held upright";
  await window.__sleep(120);
  T("long_words", { h: box(items[0]).h, over: sheet.scrollWidth - sheet.clientWidth });
  victim.textContent = realTitle;
  await window.__sleep(120);

  // The close button sits in the list's head; a tap lands on its icon.
  var x = document.querySelector('.settings-view[data-view="home"] .settings-head .settings-app-close');
  T("close_btn", x ? box(x) : null);
  // Scrolled as far as the list goes, the way out is still on screen.
  sheet.scrollTop = sheet.scrollHeight;
  await window.__sleep(120);
  T("x_scrolled", { scrolled: sheet.scrollTop, reachable: x ? reachable(x) : false });
  sheet.scrollTop = 0;
  await window.__sleep(120);

  // Every pane, opened the real way, measured against the window.
  var panes = [];
  for (var i = 0; i < items.length; i++) {
    var pane = items[i].getAttribute("data-pane");
    items[i].click();
    await window.__sleep(250);
    var view = document.querySelector('.settings-pane[data-pane="' + pane + '"]');
    var content = 0;
    Array.prototype.forEach.call(view.children, function (c) { content += c.getBoundingClientRect().height; });
    var entry = { pane: pane, open: !view.classList.contains("hidden"), sheet: box(sheet),
                  content: Math.round(content),
                  desc: (view.querySelector(".settings-pane-desc") || {}).textContent || null };
    // Scrolled to its foot, the pane's Back is still on screen and on top.
    var back = view.querySelector("[data-settings-back]");
    sheet.scrollTop = sheet.scrollHeight;
    await window.__sleep(120);
    entry.scrolled = sheet.scrollTop;
    entry.back_reachable = reachable(back);
    panes.push(entry);
    back.click();
    await window.__sleep(200);
  }
  T("panes", panes);
  T("back_to_list", !nav.closest(".settings-view").classList.contains("hidden"));

  // Wiring: rows vs panels; the description moved, not copied.
  T("panel_panes", Array.prototype.map.call(document.querySelectorAll('.settings-pane[data-pane]'),
                                            function (p) { return p.getAttribute("data-pane"); }));
  T("rows_with_desc",  document.querySelectorAll(".settings-nav-item .settings-nav-desc").length);
  T("rows_with_caret", document.querySelectorAll(".settings-nav-item .settings-nav-caret").length);
  T("panels_with_desc", document.querySelectorAll(".settings-pane .settings-pane-desc").length);

  // Escape steps back a level: a pane to the list, the list to closed.
  items[1].click();
  await window.__sleep(200);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await window.__sleep(200);
  T("esc_pane_to_list", !nav.closest(".settings-view").classList.contains("hidden") &&
                        !overlay.classList.contains("hidden"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await window.__sleep(200);
  T("esc_list_closes", overlay.classList.contains("hidden"));
  // Open again, and close with the button — tapped on the icon's path rather
  // than the button, which is where a finger lands.
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  var path = x && x.querySelector("path");
  if (path) path.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await window.__sleep(200);
  T("closed_by_x", overlay.classList.contains("hidden"));
`;

function render(size) {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER, budgetMs: 30000,
                                 name: "settings-page-" + size.replace("x", "-"), windowSize: size });
  harness.assertNoPageError(assert, r);
  return r;
}

const SIZES = ["390x844", "768x1024", "1280x900"];
const R = {};
for (const size of SIZES) R[size] = render(size);
const LANDSCAPE = render("844x390");

function fills(sheet, win, what) {
  assert.ok(Math.abs(sheet.x) <= 1 && Math.abs(sheet.y) <= 1,
    what + " starts at (" + sheet.x + "," + sheet.y + "), not the corner of the screen");
  assert.ok(Math.abs(sheet.w - win.w) <= 1 && Math.abs(sheet.h - win.h) <= 1,
    what + " is " + sheet.w + "x" + sheet.h + " on a " + win.w + "x" + win.h + " screen — not full screen");
}

test("every Settings page opens full screen (v1.8.69)", async (t) => {
  for (const size of SIZES) {
    await t.test("the list fills the screen at " + size, () => {
      const r = R[size];
      assert.equal(r.open, true, "Settings did not open from its button");
      fills(r.sheet_home, r.win, "the Settings list");
    });

    await t.test("THE one: every pane fills the screen too, the short ones included, at " + size, () => {
      const r = R[size];
      assert.equal(r.panes.length, r.count);
      const short = r.panes.filter(p => p.content < r.win.h * 0.6);
      // Precondition: a pane whose content is well short of the screen. Those
      // are the pages the old sheet opened half-height, so without one this
      // would measure nothing the old CSS got wrong.
      if (size === "1280x900" || size === "768x1024") {
        assert.ok(short.length > 0, "precondition: no pane is shorter than the screen at " + size);
      }
      for (const p of r.panes) {
        assert.equal(p.open, true, "the " + p.pane + " pane did not open");
        fills(p.sheet, r.win, "the " + p.pane + " pane (content " + p.content + "px)");
      }
    });
  }

  await t.test("the footer sits at the foot of the page", () => {
    const r = R["390x844"];
    // The list fills the page, so the footer is pinned to the bottom of the
    // screen (above the bottom padding), not left under the last row.
    assert.ok(Math.abs(r.foot.b - (r.win.h - r.pad.b)) <= 2,
      "the footer ends at y=" + r.foot.b + "; the page's content box ends at " + (r.win.h - r.pad.b));
  });

  await t.test("one ground: Settings is the page colour, heads included (v1.7.87)", () => {
    // iOS fills the status bar with theme-color, which is --bg. A full-screen
    // page in any other tone is a seam directly under the clock.
    for (const size of SIZES) {
      const g = R[size].ground;
      assert.equal(g.sheet, g.body, "Settings is " + g.sheet + " on a page of " + g.body + " at " + size);
      assert.equal(g.head, g.body, "the pinned head is " + g.head + ", not the ground " + g.body);
    }
  });

  await t.test("THE other one: the way out never scrolls away (landscape phone)", () => {
    // No Escape key on a phone, and at full screen no backdrop to tap: the
    // list's close and a pane's Back are the only ways out, so they are pinned.
    const r = LANDSCAPE;
    assert.ok(r.x_scrolled.scrolled > 0, "precondition: the list did not scroll at 844x390");
    assert.equal(r.x_scrolled.reachable, true,
      "scrolled down the list, the close button is off screen or covered — there is no way out " +
      "without scrolling back to the top");
    const scrolled = r.panes.filter(p => p.scrolled > 0);
    assert.ok(scrolled.length > 0, "precondition: no pane scrolled at 844x390");
    for (const p of scrolled) {
      assert.equal(p.back_reachable, true, "scrolled down the " + p.pane + " pane, Back is off screen or covered");
    }
  });

  await t.test("a short landscape screen scrolls the list rather than squeezing it", () => {
    const r = LANDSCAPE;
    fills(r.sheet_home, r.win, "the Settings list in landscape");
    assert.ok(r.sheet_scroll.sh > r.sheet_scroll.ch,
      "precondition: the list fits a 390px-tall screen, so this measures nothing");
    const last = r.rows[r.rows.length - 1];
    assert.ok(r.foot.y >= last.y + last.h - 1, "the footer overlaps the last row on a short screen");
    for (const row of r.rows) assert.ok(row.h >= 44, row.pane + " was squeezed to " + row.h + "px");
  });

  await t.test("the list closes from its own button — tapped on the icon — and by Escape", () => {
    for (const size of SIZES) {
      const r = R[size];
      assert.ok(r.close_btn, "the list has no close button at " + size + " — a full-screen page with " +
        "no backdrop has no other way out on a phone");
      assert.ok(r.close_btn.w >= 40 && r.close_btn.h >= 40, "the close button is " + r.close_btn.w + "x" + r.close_btn.h);
      assert.ok(r.close_btn.r >= r.win.w - 40, "the close button is not at the right of the head");
      assert.equal(r.esc_pane_to_list, true, "Escape on a pane did not return to the list");
      assert.equal(r.esc_list_closes, true, "Escape on the list did not close Settings");
      assert.equal(r.closed_by_x, true, "a tap on the close button's icon did not close Settings");
      for (const p of r.panes) {
        assert.equal(p.back_reachable, true, p.pane + ": Back is not on top at " + size);
      }
    }
  });
});

test("the Settings list is one column of rows, like Mandarin's — not large buttons (v1.8.69)", async (t) => {
  for (const size of SIZES) {
    await t.test("THE one: one row per category, full width, at " + size, () => {
      const r = R[size];
      assert.ok(r.count >= 9, "only " + r.count + " categories rendered");
      const xs = new Set(r.rows.map(row => row.x));
      assert.equal(xs.size, 1, "the rows start at " + [...xs].join(", ") + " — more than one column");
      for (let i = 1; i < r.rows.length; i++) {
        assert.ok(r.rows[i].y >= r.rows[i - 1].y + r.rows[i - 1].h - 1,
          r.rows[i].pane + " is beside " + r.rows[i - 1].pane + " rather than under it");
      }
      for (const row of r.rows) {
        assert.ok(Math.abs(row.w - r.rows[0].w) <= 1, row.pane + " is " + row.w + "px wide, not " + r.rows[0].w);
        assert.ok(row.w >= r.nav.w - 10, row.pane + " does not span the list (" + row.w + " of " + r.nav.w + ")");
      }
      assert.ok(r.sheet_scrolls_sideways <= 1, "Settings scrolls sideways by " + r.sheet_scrolls_sideways + "px");
    });

    await t.test("rows are compact, flat, and still a full tap target, at " + size, () => {
      const r = R[size];
      for (const row of r.rows) {
        assert.ok(row.h >= 44, row.pane + " is " + row.h + "px tall — under the 44px tap target");
        assert.ok(row.h <= 60, row.pane + " is " + row.h + "px tall — that is a card, not a row");
        assert.ok(Math.abs(row.h - r.rows[0].h) <= 1, row.pane + " is " + row.h + "px, its neighbours " + r.rows[0].h);
        assert.equal(row.border, "0px", row.pane + " still has a card's border");
        assert.match(row.bg, /rgba\(0, 0, 0, 0\)|transparent/, row.pane + " still has a card's background: " + row.bg);
        // Icon, then title, on one line: the side menu's row.
        assert.ok(row.ico.r <= row.title.x, row.pane + ": the icon is not before the title");
        assert.ok(Math.abs((row.ico.y + row.ico.h / 2) - (row.title.y + row.title.h / 2)) <= 2,
          row.pane + ": the icon and title are not on one line");
        assert.ok(row.ico.w <= 24 && row.ico.h <= 24, row.pane + ": the icon is " + row.ico.w + "px — a card's");
      }
    });
  }

  await t.test("a title that cannot wrap ellipsizes instead of widening the page", () => {
    const r = R["390x844"];
    assert.ok(r.long.over <= 1, "a long title made Settings scroll sideways by " + r.long.over + "px");
    assert.equal(r.long.row_w, r.rows[0].w, "a long title widened its row");
    assert.equal(r.long.cut, true, "the long title was not cut — so something else gave way");
    assert.ok(r.long.title_r <= r.long.row_r, "the long title runs past its row");
    assert.equal(r.long_words.h, r.rows[0].h,
      "a long title with spaces wrapped and made its row " + r.long_words.h + "px against " +
      r.rows[0].h + " — a row is one line");
    assert.ok(r.long_words.over <= 1, "a long title with spaces made Settings scroll sideways");
  });

  await t.test("every row reaches a panel, and every panel has a row", () => {
    const r = R["390x844"];
    const rows = r.rows.map(row => row.pane).sort();
    const panels = [...r.panel_panes].sort();
    assert.deepEqual(rows, panels,
      "the Settings list and its panels have drifted apart.\n" +
      "  rows:   " + rows.join(", ") + "\n  panels: " + panels.join(", ") + "\n" +
      "A row with no panel is a dead button; a panel with no row cannot be opened.");
    assert.equal(r.back_to_list, true, "Back from a panel did not return to the list");
  });

  await t.test("each panel's description lives in the panel, not the row (v1.8.27)", () => {
    const r = R["390x844"];
    assert.equal(r.rows_with_desc, 0, r.rows_with_desc + " rows carry a description — the two copies will drift");
    assert.equal(r.rows_with_caret, 0, "a row carries a caret");
    assert.equal(r.panels_with_desc, r.count, "only " + r.panels_with_desc + " of " + r.count + " panels have one");
    const playback = r.panes.find(p => p.pane === "playback");
    assert.equal(playback.desc, "Output zone & random album radio");
  });
});
