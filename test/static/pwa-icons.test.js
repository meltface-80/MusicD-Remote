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

const PUBLIC = path.join(REPO_ROOT, "public");
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
