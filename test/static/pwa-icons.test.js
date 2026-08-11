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
  await t.test("the manifest is linked", () => {
    assert.match(indexHtml, /<link rel="manifest" href="\/manifest\.json">/,
      "without this the app is not installable at all");
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
// v1.7.61: the iOS safe area, which v1.7.60 exposed.
//
// Adding apple-mobile-web-app-capable made the app run STANDALONE on iOS for
// the first time. Until then "Add to Home Screen" opened in Safari, and
// Safari's own toolbar sat over the home-indicator strip, so the page never
// saw it — every env(safe-area-inset-*) rule in the stylesheet, dating from
// v1.5.104, had never once executed on an iPhone. The first standalone launch
// left a black band along the bottom.
//
// These pin the three things that have to be true together. Any one of them
// alone is silently useless: viewport-fit without the standalone flag is a
// Safari tab, the standalone flag without viewport-fit letterboxes the app,
// and both without a painted strip leaves the band that was reported.
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

  await t.test("standalone is declared for both iOS and the manifest", () => {
    // iOS reads the meta; everything else reads the manifest. Neither one
    // covers both.
    assert.match(indexHtml, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.equal(manifest.display, "standalone");
  });

  await t.test("THE one: something paints the bottom inset", () => {
    // The reported symptom. The bars pad themselves, but when no bar is on
    // screen nothing reached the strip and iOS showed its own black.
    assert.match(css, /body::after\s*\{[^}]*height:\s*env\(safe-area-inset-bottom\)/,
      "nothing paints the home-indicator strip, so it shows through as a black " +
      "band whenever the transport bar is hidden");
    const rule = css.slice(css.indexOf("body::after"));
    const body = rule.slice(0, rule.indexOf("}") + 1);
    assert.match(body, /position:\s*fixed/, "the strip scrolls away with the page");
    assert.match(body, /background:\s*var\(--bg\)/,
      "the strip is not painted with the app's own ground, so it will not match");
    assert.match(body, /pointer-events:\s*none/,
      "the strip would swallow taps aimed at the bottom of the screen");
  });

  await t.test("the strip sits under the transport bar, not over it", () => {
    // At or above 70 it would cover the transport's own padded area and, worse,
    // its controls.
    const rule = css.slice(css.indexOf("body::after"));
    const z = Number((rule.slice(0, rule.indexOf("}")).match(/z-index:\s*(\d+)/) || [])[1]);
    assert.ok(z < 70, "the safe-area strip (z-index " + z + ") is not below .mini-transport (70)");
  });

  await t.test("the bars still pad themselves — the strip is a backstop", () => {
    // If someone deletes the bars' own insets and leans on the strip, the
    // CONTROLS move into the home-indicator area even though the background
    // looks right.
    assert.match(css, /\.mini-transport\s*\{[\s\S]*?padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/,
      "the transport bar no longer insets its own controls above the home indicator");
  });
});
