"use strict";
// ---------------------------------------------------------------------------
// v1.6.63 — four themes, and the picker that chooses between them.
//
// Two independent things are checked here.
//
// 1. THE PALETTES ARE ACCESSIBLE. Every theme's contrast ratios are computed
//    from the REAL applied tokens and asserted against WCAG AA. This is worth
//    automating because contrast is invisible to review: a palette that fails
//    looks fine to whoever picked the colours, and the failure only surfaces
//    for the people who could least afford it. The two existing themes ship a
//    known --text-faint failure, so they are asserted at the level they
//    actually meet, with the gap named — a test that pretends they pass would
//    be worse than no test.
//
// 2. THE PICKER IS A PICKER. Selecting a row must NOT apply it; only Apply
//    does. That is the whole point of the control, and it is exactly the kind
//    of thing that silently regresses into an instant-toggle.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const THEMES = ["dark", "light", "copper-dark", "brass-light"];

const STUB = `
window.__installFetch(function (url) {
  if (url.indexOf("/api/home/") > -1)   return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/filters") > -1) return window.__json({ genres: [] });
  if (url.indexOf("/api/random-albums") > -1) return window.__json({ albums: [], total: 0, filtered: false });
  if (url.indexOf("/api/zones") > -1)   return window.__json({ zones: [] });
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: null });
  if (url.indexOf("/api/queue") > -1)   return window.__json({ items: [] });
  if (url.indexOf("/api/status") > -1)  return window.__json({ paired: true });
  if (url.indexOf("/api/version") > -1) return window.__json({ version: "test" });
  if (url.indexOf("/api/settings") > -1) return window.__json({});
  return undefined;
});
`;

// Read the applied tokens straight off the document, so the numbers come from
// whatever CSS actually shipped rather than from a copy in the test.
const READ_TOKENS = `
  function tok(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function tokens() {
    var out = {};
    ["--bg","--bg-elev","--bg-elev-2","--border","--text","--text-dim","--text-faint",
     "--accent","--accent-text","--on-accent","--danger",
     // v1.7.86: --bg-translucent is gone. It existed only for the top bar's
     // backdrop-filter, and that filter was blurring a flat colour — .topbar is
     // a flex SIBLING of <main>, so nothing ever scrolled behind it. The bar
     // uses the transport pill's surface now, which every palette must define.
     "--glass-edge","--bg-veil"].forEach(function (n) {
      out[n] = tok(n);
    });
    return out;
  }
`;

// Flatten a translucent token over an opaque backdrop, so a surface that is
// only defined as "the ground with alpha" can be measured against the thing it
// will actually be seen over.
function composite(fg, bg) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/
    .exec(String(fg || "").trim());
  const h = /^#([0-9a-f]{6})$/i.exec(String(bg || "").trim());
  if (!m || !h) return String(fg);
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  const back = [0, 2, 4].map(i => parseInt(h[1].slice(i, i + 2), 16));
  return "#" + [1, 2, 3]
    .map((k, i) => Math.round(parseFloat(m[k]) * a + back[i] * (1 - a))
      .toString(16).padStart(2, "0"))
    .join("");
}

// rgb(...) as reported by getComputedStyle -> #rrggbb, so a measured colour can
// be compared with the hex a meta tag carries.
function rgbToHex(v) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(v || "").trim());
  if (!m) return String(v || "");
  return "#" + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, "0")).join("");
}

// --- WCAG maths, in Node so the arithmetic is reviewable ---------------------
function srgbToLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  assert.ok(m, `not a 6-digit hex colour: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * srgbToLin((n >> 16) & 255)
       + 0.7152 * srgbToLin((n >> 8) & 255)
       + 0.0722 * srgbToLin(n & 255);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
const r2 = (x) => Math.round(x * 100) / 100;

function tokensFor(themeId) {
  const driver = `
    ${READ_TOKENS}
    await window.__sleep(500);
    T("theme_attr", document.documentElement.getAttribute("data-theme"));
    T("palette_attr", document.documentElement.getAttribute("data-palette"));
    T("tokens", tokens());
    T("meta_theme_color", (document.querySelector('meta[name="theme-color"]') || {})
      .getAttribute ? document.querySelector('meta[name="theme-color"]').getAttribute("content") : null);
    T("topbar_bg", getComputedStyle(document.querySelector(".topbar")).backgroundColor);
  `;
  const stub = STUB + `try { localStorage.setItem("rra-theme-v2", ${JSON.stringify(themeId)}); } catch (e) {}\n`;
  return harness.renderPage({ stub, driver, name: "tokens-" + themeId, windowSize: "390x844" });
}

// The two original themes ship a --text-faint that fails AA. They are asserted
// at the level they actually meet so the suite stays honest; the NEW palettes
// are held to the real bar. If someone ever fixes the originals, these floors
// are what tells them the fix worked.
const FLOORS = {
  "dark":        { text: 4.5, dim: 4.5, faint: 2.6, accentText: 4.5, onAccent: 4.5, danger: 4.5 },
  "light":       { text: 4.5, dim: 4.5, faint: 2.8, accentText: 3.0, onAccent: 3.0, danger: 4.5 },
  "copper-dark": { text: 4.5, dim: 4.5, faint: 4.5, accentText: 4.5, onAccent: 4.5, danger: 4.5 },
  "brass-light": { text: 4.5, dim: 4.5, faint: 4.5, accentText: 4.5, onAccent: 4.5, danger: 4.5 },
};

for (const id of THEMES) {
  test(`theme "${id}" applies and meets its contrast floor`, { concurrency: 1 }, async (t) => {
    if (!harness.available) {
      t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
      return;
    }
    const r = tokensFor(id);
    harness.assertNoPageError(assert, r);
    const k = r.tokens;
    const floor = FLOORS[id];

    await t.test("the stored id resolves to a family and a palette", () => {
      assert.ok(["dark", "light"].includes(r.theme_attr), `data-theme=${r.theme_attr}`);
      assert.ok(["classic", "copper"].includes(r.palette_attr), `data-palette=${r.palette_attr}`);
    });

    await t.test("every token this theme needs is defined", () => {
      for (const [name, value] of Object.entries(k)) {
        assert.notEqual(value, "", `${name} is empty — the palette is missing a token`);
      }
    });

    await t.test("the top bar's text survives whatever scrolls under it", () => {
      // v1.7.88 made the bar translucent so album art passes beneath it. The
      // bar's title and count are drawn on --text, and what backs them is now
      // the veil over an ARBITRARY IMAGE. There is no blur to soften it, so the
      // two extremes an album cover can present — a white sleeve and a black
      // one — are the cases that decide whether the header stays readable.
      for (const [what, backdrop] of [["a white sleeve", "#ffffff"],
                                      ["a black sleeve", "#000000"]]) {
        const bar = composite(k["--bg-veil"], backdrop);
        const c = contrast(k["--text"], bar);
        assert.ok(c >= floor.text,
          `with ${what} under the header the bar renders ${bar} and --text ` +
          `(${k["--text"]}) measures ${c.toFixed(2)}:1 on it, need ${floor.text}`);
      }
    });

    await t.test("elevated surfaces still sit ABOVE the ground", () => {
      // v1.7.87 raised the dark grounds to meet the top bar, and had to raise
      // --bg-elev / --bg-elev-2 by the same delta: in the classic dark palette
      // the old --bg-elev (#16191c) is DARKER than the new ground (#1d2125), so
      // lifting the page alone would have made every card, sheet and popover
      // recede into a hole instead of floating. That is a whole-theme visual
      // failure with no single screenshot that shows it, and nothing else in
      // this suite would notice — the contrast floors get BETTER as a surface
      // moves away from the text on it.
      // Both families elevate the same way — by getting lighter. The brass
      // palette says so explicitly in its own comment ("light theme (elev
      // lighter than bg), so existing depth cues still work").
      const ground = luminance(k["--bg"]);
      for (const surf of ["--bg-elev", "--bg-elev-2"]) {
        assert.ok(luminance(k[surf]) > ground,
          `${surf} (${k[surf]}) is not lighter than --bg (${k["--bg"]}) — elevated ` +
          `surfaces would read as recesses in this theme`);
      }
    });

    await t.test("body text clears AA on all three surfaces", () => {
      for (const surf of ["--bg", "--bg-elev", "--bg-elev-2"]) {
        const c = contrast(k["--text"], k[surf]);
        assert.ok(c >= floor.text, `--text on ${surf} is ${r2(c)}:1, need ${floor.text}`);
      }
    });

    await t.test("secondary text clears AA on all three surfaces", () => {
      for (const surf of ["--bg", "--bg-elev", "--bg-elev-2"]) {
        const c = contrast(k["--text-dim"], k[surf]);
        assert.ok(c >= floor.dim, `--text-dim on ${surf} is ${r2(c)}:1, need ${floor.dim}`);
      }
    });

    await t.test("faint text meets this theme's floor", () => {
      for (const surf of ["--bg", "--bg-elev", "--bg-elev-2"]) {
        const c = contrast(k["--text-faint"], k[surf]);
        assert.ok(c >= floor.faint,
          `--text-faint on ${surf} is ${r2(c)}:1, need ${floor.faint}` +
          (floor.faint < 4.5 ? " (this theme is grandfathered below AA — see FLOORS)" : ""));
      }
    });

    await t.test("the accent works as TEXT on every surface", () => {
      for (const surf of ["--bg", "--bg-elev", "--bg-elev-2"]) {
        const c = contrast(k["--accent-text"], k[surf]);
        assert.ok(c >= floor.accentText,
          `--accent-text on ${surf} is ${r2(c)}:1, need ${floor.accentText}. ` +
          "This is why --accent and --accent-text are separate tokens: the copper " +
          "fill colour measures 4.27:1 as text on the deepest surface.");
      }
    });

    await t.test("text on an accent FILL is readable", () => {
      const c = contrast(k["--on-accent"], k["--accent"]);
      assert.ok(c >= floor.onAccent,
        `--on-accent on --accent is ${r2(c)}:1, need ${floor.onAccent}`);
    });

    await t.test("the danger colour is readable", () => {
      const c = contrast(k["--danger"], k["--bg"]);
      assert.ok(c >= floor.danger, `--danger on --bg is ${r2(c)}:1`);
    });

    await t.test("the browser chrome colour follows the theme", () => {
      // iOS paints the status bar itself and fills it with theme-color; the app
      // cannot render there and cannot make it translucent (the meta that would
      // is the one banned by pre-flight step 6). What it can do is match the bar
      // directly beneath it.
      //
      // Asserted against the bar's MEASURED colour, not against a token name:
      // v1.7.86 had this compare to a composite of --glass-bg over --bg, and
      // v1.7.87 made the bar plain --bg — a test naming either one has to be
      // rewritten every time the bar is recoloured, and says nothing about the
      // seam. What matters is that the two are the same colour.
      assert.equal(rgbToHex(r.topbar_bg), r.meta_theme_color.toLowerCase(),
        `the top bar renders ${r.topbar_bg} (${rgbToHex(r.topbar_bg)}) but ` +
        `theme-color is ${r.meta_theme_color} — there will be a visible seam ` +
        `between the iOS status bar and the app bar`);
    });
  });
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------
const PICKER_DRIVER = `
  await window.__sleep(500);
  var b = document.getElementById("docker-migration-banner"); if (b) b.remove();
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="appearance"]').click();
  await window.__sleep(300);

  var rows = function () { return document.querySelectorAll("#theme-list .theme-row"); };
  var apply = document.getElementById("theme-apply");
  T("row_count", rows().length);
  T("applied_at_open", document.documentElement.getAttribute("data-palette"));
  T("apply_disabled_at_open", apply.disabled);
  T("selected_at_open", document.querySelector("#theme-list .theme-row.is-on .theme-row-label").textContent);

  // Each swatch must preview its OWN palette, not the applied one.
  T("swatch_bgs", Array.prototype.map.call(document.querySelectorAll(".theme-swatch"),
    function (s) { return getComputedStyle(s).backgroundColor; }));

  // Select the copper row — this must NOT apply anything.
  var copper = Array.prototype.filter.call(rows(), function (r) {
    return /Copper dark/.test(r.textContent); })[0];
  copper.click();
  await window.__sleep(200);
  T("palette_after_select", document.documentElement.getAttribute("data-palette"));
  T("apply_enabled_after_select", !apply.disabled);
  T("hint_after_select", document.getElementById("theme-apply-hint").textContent);
  T("selected_after_select", document.querySelector("#theme-list .theme-row.is-on .theme-row-label").textContent);

  // Now Apply.
  apply.click();
  await window.__sleep(300);
  T("theme_after_apply", document.documentElement.getAttribute("data-theme"));
  T("palette_after_apply", document.documentElement.getAttribute("data-palette"));
  T("apply_disabled_after_apply", apply.disabled);
  T("stored", (function () { try { return localStorage.getItem("rra-theme-v2"); } catch (e) { return null; } })());
`;

test("the theme picker selects, then applies (v1.6.63)", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
    return;
  }
  const r = harness.renderPage({
    stub: STUB, driver: PICKER_DRIVER, name: "theme-picker", windowSize: "390x844", budgetMs: 25000,
  });
  harness.assertNoPageError(assert, r);

  await t.test("all four themes are offered, with the current one marked", () => {
    assert.equal(r.row_count, 4);
    assert.match(r.selected_at_open, /in use/);
    assert.equal(r.apply_disabled_at_open, true,
      "Apply is live before anything has been chosen — it should mean something");
  });

  await t.test("each swatch previews its own palette", () => {
    // Four themes, four different backgrounds. If the swatches inherited the
    // applied theme they would all be identical, and the picker would give the
    // user nothing to choose by.
    assert.equal(new Set(r.swatch_bgs).size, 4,
      `swatches rendered ${new Set(r.swatch_bgs).size} distinct backgrounds, expected 4 — ` +
      "they are inheriting the applied theme instead of declaring their own");
  });

  await t.test("selecting a row does NOT apply it", () => {
    assert.equal(r.palette_after_select, r.applied_at_open,
      "THE POINT OF THE CONTROL: tapping a theme changed the app immediately, " +
      "so Apply is decoration and there is no way to back out of a choice");
    assert.equal(r.apply_enabled_after_select, true, "Apply stayed disabled after a change");
    assert.match(r.hint_after_select, /not applied/i);
    assert.match(r.selected_after_select, /Copper dark/);
  });

  await t.test("Apply commits the choice and persists it", () => {
    assert.equal(r.theme_after_apply, "dark");
    assert.equal(r.palette_after_apply, "copper");
    assert.equal(r.stored, "copper-dark");
    assert.equal(r.apply_disabled_after_apply, true,
      "Apply stayed enabled after applying — there is nothing left to apply");
  });
});

// A user upgrading has "dark" or "light" under the OLD key and no new key.
// Those are still valid theme ids, so the choice must carry over silently.
test("a v1 saved theme migrates to the new key", { concurrency: 1 }, async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary found — set CHROMIUM_BIN to run DOM tests");
    return;
  }
  for (const old of ["light", "dark"]) {
    const stub = STUB +
      `try { localStorage.removeItem("rra-theme-v2"); localStorage.setItem("rra-theme", ${JSON.stringify(old)}); } catch (e) {}\n`;
    const r = harness.renderPage({
      stub,
      driver: `await window.__sleep(500);
        T("theme", document.documentElement.getAttribute("data-theme"));
        T("palette", document.documentElement.getAttribute("data-palette"));
        T("migrated", (function(){ try { return localStorage.getItem("rra-theme-v2"); } catch(e){ return null; } })());`,
      name: "theme-migrate-" + old, windowSize: "390x844",
    });
    harness.assertNoPageError(assert, r);
    await t.test(`"${old}" carries over`, () => {
      assert.equal(r.theme, old, "the upgraded user's theme changed under them");
      assert.equal(r.palette, "classic",
        "an upgrading user was moved onto a palette they never chose");
      assert.equal(r.migrated, old, "the migrated value was not written to the new key");
    });
  }
});
