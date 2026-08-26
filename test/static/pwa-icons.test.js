"use strict";
// ---------------------------------------------------------------------------
// v1.7.60: the PWA icon set.
//
// Before this there was no manifest and no icons at all, so "Add to Home
// Screen" saved a screenshot of the page and the tab carried the default blank
// mark. The failure mode for icons is specific and silent: a manifest entry
// pointing at a file that isn't there, or whose real pixel size doesn't match
// the `sizes` it claims, doesn't error anywhere. The browser just quietly
// falls back, and you find out when somebody installs it.
//
// So every declared icon is opened and MEASURED rather than trusted, and the
// two purposes are checked separately, because they are not interchangeable:
// `any` is edge-to-edge for iOS and the tab, `maskable` is inset because
// Android crops to the launcher's shape and guarantees only the centre 80%.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("../lib/extract");

// MUSICD_PUBLIC_DIR points at a COPY of public/, exactly as the DOM harness
// does, so a mutation run can reintroduce a bug in a throwaway copy and prove
// these assertions bite. Reading REPO_ROOT/public unconditionally is how a
// static test ends up permanently green: every mutant passed until this line
// existed.
const PUBLIC = process.env.MUSICD_PUBLIC_DIR
  ? path.resolve(process.env.MUSICD_PUBLIC_DIR)
  : path.join(REPO_ROOT, "public");
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, "manifest.json"), "utf8"));
const indexHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

// Minimal PNG header reader — width/height are big-endian at a fixed offset in
// the IHDR chunk. Avoids a dependency for what is 8 bytes of the file.
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("hex", 0, 8), "89504e470d0a1a0a", file + " is not a PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test("every icon the manifest promises actually exists at the size it claims", async (t) => {
  await t.test("the manifest lists icons at all", () => {
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4,
      "an install with too few icon sizes falls back to a generated one");
  });

  await t.test("each file is present, is a PNG, and measures what it declares", () => {
    for (const icon of manifest.icons) {
      const file = path.join(PUBLIC, icon.src.replace(/^\//, ""));
      assert.ok(fs.existsSync(file), "manifest points at a missing file: " + icon.src);
      const [w, h] = icon.sizes.split("x").map(Number);
      const real = pngSize(file);
      assert.equal(real.w, w, icon.src + " is " + real.w + "px wide, declared " + w);
      assert.equal(real.h, h, icon.src + " is " + real.h + "px tall, declared " + h);
      assert.equal(real.w, real.h, icon.src + " is not square");
    }
  });

  await t.test("both purposes are covered, at the two sizes that matter", () => {
    // 192 and 512 are the pair Chrome requires for an installable PWA; a
    // maskable-only set loses the tab icon, an any-only set gets cropped on
    // Android.
    for (const purpose of ["any", "maskable"]) {
      const sizes = manifest.icons
        .filter(i => (i.purpose || "any").split(" ").includes(purpose))
        .map(i => i.sizes);
      for (const need of ["192x192", "512x512"]) {
        assert.ok(sizes.includes(need),
          "no " + need + " icon with purpose=" + purpose);
      }
    }
  });

  await t.test("the maskable icons are actually inset", () => {
    // The whole reason they exist. If someone regenerates them from the source
    // without the safe-zone scale, they become byte-identical to the `any`
    // icons and Android silently crops the headphones off.
    for (const size of [192, 512]) {
      const any  = fs.readFileSync(path.join(PUBLIC, "icons", "icon-" + size + ".png"));
      const mask = fs.readFileSync(path.join(PUBLIC, "icons", "maskable-" + size + ".png"));
      assert.ok(!any.equals(mask),
        "maskable-" + size + ".png is identical to icon-" + size + ".png — it has " +
        "no safe zone, so Android will crop into the artwork");
    }
  });
});

test("the head declares what each platform actually reads", async (t) => {
  await t.test("THE one: the head carries nothing that can relayout the window", () => {
    // An allowlist, not a blocklist. v1.6.50 is the last build KNOWN to fill an
    // iPhone screen correctly. Its head plus the four inert icon lines is the
    // whole permitted set; anything else must be added deliberately, by editing
    // this list, having thought about whether iOS reads it.
    //
    // This is the check that would have stopped v1.7.60. Three metas went in
    // alongside the icons, none of them needed for an icon, and the app stopped
    // reaching the edges of the display on every screen.
    const ALLOWED = new Set([
      'meta:charset', 'meta:viewport', 'meta:theme-color',          // v1.6.50
      'meta:apple-mobile-web-app-title',                            // inert: names the shortcut
      'link:stylesheet', 'link:icon', 'link:apple-touch-icon',      // inert: assets
    ]);
    const head = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>"));
    const found = [];
    for (const tag of head.match(/<(meta|link)\b[^>]*>/g) || []) {
      const name = (tag.match(/\bname="([^"]+)"/) || [])[1];
      const rel  = (tag.match(/\brel="([^"]+)"/) || [])[1];
      if (/^<meta\s+charset/.test(tag)) { found.push("meta:charset"); continue; }
      if (name) found.push("meta:" + name);
      else if (rel) found.push("link:" + rel);
    }
    for (const item of found) {
      assert.ok(ALLOWED.has(item),
        'the head gained "' + item + '". v1.6.50 fills the screen correctly and its ' +
        'head does not contain it. If iOS reads it, it can stop viewport-fit=cover ' +
        'filling the display — which is exactly what apple-mobile-web-app-capable did ' +
        'in v1.7.60. Add it here only after deciding that is safe.');
    }
  });

  await t.test("iOS gets its own icon, because it ignores the manifest", () => {
    const m = indexHtml.match(/<link rel="apple-touch-icon" href="([^"]+)">/);
    assert.ok(m, "iOS reads only apple-touch-icon and will fall back to a screenshot");
    assert.ok(fs.existsSync(path.join(PUBLIC, m[1].replace(/^\//, ""))), m[1] + " is missing");
  });

  await t.test("the apple-touch-icon has no alpha channel", () => {
    // iOS composites transparency onto WHITE, which would put a halo around a
    // logo drawn on black. Colour type 2 = truecolour without alpha.
    const buf = fs.readFileSync(path.join(PUBLIC, "icons", "apple-touch-icon.png"));
    assert.notEqual(buf.readUInt8(25), 6,
      "apple-touch-icon.png carries an alpha channel — iOS will composite it " +
      "onto white and halo the artwork");
  });

  await t.test("there is a tab favicon", () => {
    assert.match(indexHtml, /<link rel="icon" href="\/icons\/favicon\.ico"/);
    assert.ok(fs.existsSync(path.join(PUBLIC, "icons", "favicon.ico")));
  });

  await t.test("standalone install is declared, and the theme matches the app", () => {
    assert.equal(manifest.display, "standalone",
      "the installed app would open in a browser tab with visible chrome");
    assert.equal(manifest.theme_color, "#0e1012");
    // The splash/background must match the app's own dark ground, or the
    // launch screen flashes white before the first paint.
    assert.equal(manifest.background_color, "#0e1012");
    const themeMeta = indexHtml.match(/<meta name="theme-color" content="([^"]+)">/);
    assert.equal(themeMeta[1], manifest.theme_color,
      "the page's theme-color and the manifest's disagree");
  });
});

// ---------------------------------------------------------------------------
// v1.7.64: the iOS safe area.
//
// CORRECTION to what v1.7.61 asserted here. That version claimed the app had
// never run standalone on iOS before v1.7.60, and that the safe-area CSS had
// therefore never executed. That was wrong, and the repo's own history says so:
// v1.7.42 (5 Aug) fixed "Now playing sat under the status bar", a symptom that
// is only possible when the insets are LIVE and the page is already full-bleed,
// and its note says plainly "only visible in the installed PWA".
//
// Modern iOS opens a home-screen shortcut as a standalone web app on its own.
// viewport-fit=cover was already filling the display. What broke it was
// v1.7.60 adding the LEGACY apple-mobile-web-app-capable meta, which opts back
// into the old web-app path where the status-bar style governs how the web view
// is inset — so the app stopped reaching the edges.
//
// What has to stay true: viewport-fit=cover present, the legacy metas absent,
// and every bottom-anchored surface padding its own background into the inset.
// ---------------------------------------------------------------------------
const css = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");

test("the iOS safe area is claimed and painted", async (t) => {
  await t.test("viewport-fit=cover — without it the insets are all zero", () => {
    const vp = indexHtml.match(/<meta name="viewport" content="([^"]+)">/);
    assert.ok(vp, "no viewport meta at all");
    assert.match(vp[1], /viewport-fit=cover/,
      "env(safe-area-inset-*) resolves to 0 without viewport-fit=cover, so " +
      "every safe-area rule in the stylesheet becomes a no-op");
  });

  await t.test("THE one: the legacy apple web-app metas stay OUT", () => {
    // These three, added in v1.7.60 alongside the icons, are what put a black
    // band in the safe areas on every screen. Modern iOS already opens a
    // home-screen shortcut standalone and viewport-fit=cover already filled the
    // display — proven by v1.7.42, which fixed Now playing sitting UNDER the
    // status bar, impossible unless the insets were live and the page was
    // full-bleed. apple-mobile-web-app-capable opts back into the OLD web-app
    // path, where the status-bar style governs how the web view is inset.
    for (const meta of ["apple-mobile-web-app-capable",
                        "mobile-web-app-capable",
                        "apple-mobile-web-app-status-bar-style"]) {
      assert.ok(!new RegExp('name="' + meta + '"').test(indexHtml),
        meta + " is back in the head. It is not needed for the icon (iOS reads " +
        "apple-touch-icon) and it stops the app filling the screen.");
    }
    // The manifest still declares standalone for Android and desktop, where it
    // is read and where it causes no such trouble.
    assert.equal(manifest.display, "standalone");
  });

  await t.test("the pre-v1.7.60 head is preserved exactly", () => {
    // Everything the icons needed is additive. If a future change edits the
    // viewport or theme-color line, that is the line that was working.
    assert.match(indexHtml,
      /<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">/,
      "the viewport meta was altered — this exact string is the known-good one");
    assert.match(indexHtml, /<meta name="theme-color" content="#0e1012">/);
  });

  await t.test("THE one: the canvas is painted, so an uncovered inset is never black", () => {
    // The real guarantee, and the one v1.7.61 missed. `html` carries a
    // background, which propagates to the canvas — so any area no element
    // covers is already the page ground. A black band can therefore only come
    // from a PAINTED layer (a backdrop scrim), never from bare page.
    const htmlRule = css.slice(css.indexOf("html, body {"));
    assert.match(htmlRule.slice(0, htmlRule.indexOf("}")), /background:\s*var\(--bg\)/,
      "html has no background, so the safe areas fall through to the browser's " +
      "own canvas colour and really would show black");
  });

  await t.test("nothing paints a strip OVER the modal", () => {
    // v1.7.61 added body::after at z-index 69 to cover the home indicator.
    // .modal is 50 and .share-overlay is 60, and the transport bar is hidden on
    // the Now Playing screen — so the strip painted --bg straight over the
    // panel's lighter --bg-elev and made that screen visibly worse. If a strip
    // is ever reintroduced it must sit BELOW the overlays, not above them.
    const at = css.indexOf("body::after");
    if (at === -1) return;                     // no strip at all: correct
    const rule = css.slice(css.indexOf("{", at), css.indexOf("}", at));
    const z = Number((rule.match(/z-index:\s*(-?\d+)/) || [])[1]);
    assert.ok(!Number.isFinite(z) || z < 50,
      "a body::after strip at z-index " + z + " sits above .modal (50), so it " +
      "paints over the Now Playing panel instead of behind it");
  });

  await t.test("the bars pad their own backgrounds into the inset", () => {
    // With no strip, this is the ONLY thing keeping the transport's background
    // and its controls clear of the home indicator.
    // Bounded to the rule body. A [\s\S]*? between the selector and the
    // declaration walks straight past the closing brace and happily matches
    // some OTHER selector's padding, which is exactly what it did — the
    // mutation that stripped the transport's inset sailed through.
    const bare2 = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const at = bare2.indexOf(".mini-transport {");
    assert.ok(at > -1, ".mini-transport rule not found");
    const rule = bare2.slice(at, bare2.indexOf("}", at));
    assert.match(rule, /padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/,
      "the transport bar no longer insets its own controls above the home indicator");
  });
});

// ---------------------------------------------------------------------------
// v1.7.62: viewport units on a full-screen panel.
//
// This is the one that actually caused the reported band, and it is invisible
// everywhere except an installed iOS app — which is why v1.7.61's strip did not
// fix it and the Now Playing screen looked WORSE than the rest.
//
// `.modal-panel` sits inside `.modal { position: fixed; inset: 0 }` and set
// `height: 100dvh`. Those two do not measure the same box on iOS: a fixed
// inset:0 parent covers the whole screen INCLUDING the safe areas, while the
// dynamic viewport excludes them. So the panel came up short, and what showed
// through the gap was `.modal-backdrop` — rgba(0,0,0,.55) over a blur — i.e. a
// band darker than the page and taller than the 34px inset.
//
// Headless Chromium has no browser chrome and no safe areas, so dvh, vh and
// 100% are all identical there and the bug CANNOT be reproduced in the DOM
// harness. The invariant is therefore asserted structurally: a panel that fills
// a fixed inset:0 parent measures itself against that parent, not the viewport.
// ---------------------------------------------------------------------------
test("full-screen panels size against their fixed parent, not the viewport", async (t) => {
  // Each entry: the panel, and the fixed inset:0 parent it fills.
  const PANELS = [
    [".modal-panel", ".modal"],
    ["#qobuz-overlay .qobuz-sheet", ".settings-overlay"],
  ];

  // The selector may head a GROUP (`a, b, c { ... }`), so the body is whatever
  // sits between the next "{" after the selector and its closing brace — not
  // the text following "<selector> {", which does not exist for a grouped rule.
  // Comments are stripped FIRST. A raw indexOf finds the selector inside any
  // comment that happens to mention it — which it immediately did, since the
  // note explaining this very fix names `.modal-panel`.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  function ruleBody(selector) {
    const at = bare.indexOf(selector);
    if (at < 0) return null;
    const open = bare.indexOf("{", at);
    return open < 0 ? null : bare.slice(open + 1, bare.indexOf("}", open));
  }

  await t.test("THE one: no viewport-unit HEIGHT on a full-bleed panel", () => {
    for (const [panel] of PANELS) {
      const rule = ruleBody(panel);
      assert.ok(rule, "rule for " + panel + " not found");
      const bad = rule.match(/(?<!max-)height:\s*[^;]*\b100(d|s|l)?vh\b/);
      assert.equal(bad, null,
        panel + " sizes itself with a viewport unit (" + (bad && bad[0]) + "). Inside a " +
        "fixed inset:0 parent that is short by the safe-area insets on iOS, and the " +
        "backdrop shows through underneath as a dark band.");
      assert.match(rule, /height:\s*100%/,
        panel + " does not fill its parent");
    }
  });

  await t.test("the parents really are fixed and inset to zero", () => {
    // The whole argument for height:100% rests on this. If a parent stops being
    // full-screen, 100% silently becomes the wrong answer too.
    for (const [, parent] of PANELS) {
      const rule = ruleBody(parent + " {");
      assert.ok(rule, parent + " rule not found");
      assert.match(rule, /position:\s*fixed/, parent + " is no longer fixed");
      assert.match(rule, /bottom:\s*0/, parent + " no longer reaches the bottom of the screen");
    }
  });

  await t.test("max-height constraints on INSET panels may still use vh", () => {
    // Not everything with a vh is wrong. The desktop modal and the popovers
    // deliberately sit inside a margin, and there a viewport unit is exactly
    // right — this test must not push someone into "fixing" those.
    assert.match(css, /max-height:\s*calc\(100vh - 48px\)/,
      "the desktop modal's inset max-height was changed; it is not the same case");
  });
});

// ---------------------------------------------------------------------------
// v1.7.66: pinning the iOS full-screen contract.
//
// This cost six versions (v1.7.60 → v1.7.65) and five wrong diagnoses. The
// mechanism, finally: `apple-mobile-web-app-status-bar-style: black-translucent`
// shifts the document UP under the status bar without growing the layout
// viewport, so the gap it leaves at the BOTTOM equals the TOP inset — 44-62px,
// not the 34px of a home indicator. That is why the band looked too tall and
// appeared on every screen.
//
// The reason it took so long is worth writing down, because no assertion can
// fix it: `apple-mobile-web-app-capable` and `-status-bar-style` are read by
// iOS at ADD-TO-HOME-SCREEN time, NOT on each launch, while viewport-fit=cover
// IS re-read every launch. So a shortcut created against a bad build keeps the
// bad window configuration forever, and no server-side change can be observed
// through it. Every "not fixed" report was true AND every fix may have been
// live — the two are not contradictory, and that is the trap.
//
// What CAN be pinned is the known-good state, which is what these do. v1.6.50
// is the reference: installed, confirmed filling an iPhone screen, and its
// shell is byte-identical to today's.
// ---------------------------------------------------------------------------
test("the iOS full-screen contract cannot be broken silently", async (t) => {
  await t.test("there is EXACTLY ONE viewport meta", () => {
    // Two of them is a documented cause of viewport-fit being ignored, and the
    // second one is invisible in review because both look correct alone.
    const all = indexHtml.match(/<meta\s+name="viewport"[^>]*>/g) || [];
    assert.equal(all.length, 1,
      "found " + all.length + " viewport metas. A second one silently overrides " +
      "the first and viewport-fit=cover stops applying, which zeroes every " +
      "env(safe-area-inset-*) in the stylesheet.");
  });

  // dial.html is the second installable page. Everything the contract above
  // protects for index.html applies to it identically, because iOS treats a
  // second home-screen shortcut as its own web app with its own baked-in
  // window configuration — so it gets its own pinning, not a shared assertion
  // that happens to pass because index.html is correct.
  await t.test("the dial page carries the same viewport contract", () => {
    const dialHtml = fs.readFileSync(path.join(PUBLIC, "dial.html"), "utf8");
    const all = dialHtml.match(/<meta\s+name="viewport"[^>]*>/g) || [];
    assert.equal(all.length, 1,
      "dial.html has " + all.length + " viewport metas; a second silently " +
      "overrides the first and viewport-fit=cover stops applying");
    assert.match(all[0], /viewport-fit=cover/,
      "dial.html's viewport lacks viewport-fit=cover, so every " +
      "env(safe-area-inset-*) on that page resolves to 0");
    // The dial is a full-screen control surface with a gesture on it; a
    // shortcut that letterboxes it is the failure v1.7.60 shipped.
    assert.ok(/<link rel="apple-touch-icon" href="\/icons\/dial-touch-icon\.png">/.test(dialHtml),
      "dial.html must point at its OWN apple-touch-icon — iOS ignores the " +
      "manifest for this, and without a distinct icon the two installed apps " +
      "are indistinguishable on the home screen");
    assert.ok(fs.existsSync(path.join(PUBLIC, "icons", "dial-touch-icon.png")),
      "icons/dial-touch-icon.png is missing; iOS falls back to a screenshot " +
      "of the page when the icon 404s");
    assert.ok(!/rel="manifest"/.test(dialHtml),
      "dial.html links a manifest. iOS 17+ reads it, and display:standalone " +
      "with a background_color letterboxes the web app instead of letting " +
      "viewport-fit=cover fill the display — the same reason index.html has none");
  });

  await t.test("no legacy Apple web-app meta, in any file served to a browser", () => {
    // Scoped wider than index.html on purpose: display.html never had these,
    // and dial.html is a SECOND INSTALLABLE PAGE — the only other file whose
    // head iOS reads at add-to-home-screen time and bakes into a shortcut.
    // Neither must ever gain them.
    for (const file of ["index.html", "display.html", "dial.html"]) {
      // Comments stripped first. index.html carries a comment NAMING these three
      // and explaining why they are absent, so a raw includes() matches the
      // explanation rather than a live tag. Third time this trap has appeared in
      // this suite: it also hit the CSS rule lookup and the head allowlist.
      const html = fs.readFileSync(path.join(PUBLIC, file), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "");
      for (const meta of ["apple-mobile-web-app-capable",
                          "mobile-web-app-capable",
                          "apple-mobile-web-app-status-bar-style"]) {
        assert.ok(!html.includes(meta),
          file + " contains " + meta + ". black-translucent shifts the document up " +
          "under the status bar without growing the viewport, leaving a gap at the " +
          "BOTTOM the size of the TOP inset; apple-mobile-web-app-capable opts into " +
          "the legacy web-app path where that style governs the window. Both are " +
          "baked in at Add-to-Home-Screen time, so the damage outlives any later fix " +
          "until the user deletes and re-adds the shortcut.");
      }
    }
  });

  await t.test("the shell rules still match v1.6.50, the last confirmed-good build", () => {
    // These four have never changed in the repo's entire history and the app
    // filled the screen throughout. If one of them ever needs to change, this
    // failing is the prompt to test on a real device first — not to update the
    // expectation and move on.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (sel) => {
      const at = bare.indexOf(sel);
      assert.ok(at > -1, sel + " rule not found");
      return bare.slice(at, bare.indexOf("}", at)).replace(/\s+/g, " ").trim();
    };
    assert.match(rule("html, body {"), /height: 100%/,
      "html/body height changed. Generic PWA advice says use 100vh here; v1.6.50 " +
      "uses 100% and fills the screen correctly, so that advice does not apply to " +
      "this app and this line is load-bearing evidence.");
    assert.match(rule("html, body {"), /background: var\(--bg\)/,
      "html lost its background — the safe areas are painted from it, so they " +
      "would fall through to the browser canvas and really would be black");
    for (const sel of [".app {", ".modal {"]) {
      assert.match(rule(sel), /position: fixed/, sel + " is no longer fixed");
      assert.match(rule(sel), /bottom: 0/, sel + " no longer reaches the bottom");
    }
  });

  await t.test("viewport-fit=cover survives, spelled exactly as the working build spells it", () => {
    assert.match(indexHtml,
      /content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/,
      "the viewport string differs from v1.6.50's. That exact string is the one " +
      "confirmed to fill an iPhone screen.");
  });
});
