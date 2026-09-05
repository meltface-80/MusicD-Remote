"use strict";
// ---------------------------------------------------------------------------
// v1.8.23: the Discogs token and FanArt.tv key can be seeded from the install
// command (RRA_DISCOGS_KEY / RRA_FANART_KEY) so a fresh container has label
// logos and artwork from its first scan, before anyone opens Settings.
//
// The rule this pins is the PRECEDENCE, because getting it wrong is silent
// either way round:
//
//   * If the environment won, a key pasted in Settings would appear to save —
//     the toast fires, the file is written — and then do nothing, forever,
//     with no way to tell from the UI why.
//   * If a persisted EMPTY string counted as a choice, a settings.json that
//     happens to carry `"discogsToken": ""` would suppress a perfectly good
//     env seed.
//
// So: a non-empty saved value wins; otherwise the environment seeds; and the
// source travels with the value, because a key the user cannot account for is
// a support question. Whitespace is trimmed on both paths — a token pasted
// with a trailing newline is the ordinary case, not the exotic one.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

function seed(env) {
  return loadIndexFunctions(["seedApiKey"], { process: { env: env || {} } }).seedApiKey;
}

test("a saved key wins over the environment", () => {
  const s = seed({ RRA_DISCOGS_KEY: "from-env" });
  assert.deepEqual(s("from-settings", "RRA_DISCOGS_KEY"),
    { value: "from-settings", source: "settings" });
});

test("the environment seeds when nothing is saved", () => {
  const s = seed({ RRA_DISCOGS_KEY: "from-env" });
  for (const saved of ["", null, undefined, "   "]) {
    assert.deepEqual(s(saved, "RRA_DISCOGS_KEY"),
      { value: "from-env", source: "env" }, "saved=" + JSON.stringify(saved));
  }
});

test("neither set reports no source at all", () => {
  const s = seed({});
  assert.deepEqual(s("", "RRA_DISCOGS_KEY"), { value: "", source: "" });
  // An env var present but blank is not a key.
  assert.deepEqual(seed({ RRA_FANART_KEY: "  " })("", "RRA_FANART_KEY"),
    { value: "", source: "" });
});

test("both paths trim — a pasted key usually carries a newline", () => {
  assert.equal(seed({})("  tok  ", "X").value, "tok");
  assert.equal(seed({ X: "\ttok\n" })("", "X").value, "tok");
});

test("each key reads its own variable, not the other's", () => {
  const s = seed({ RRA_DISCOGS_KEY: "d", RRA_FANART_KEY: "f" });
  assert.equal(s("", "RRA_DISCOGS_KEY").value, "d");
  assert.equal(s("", "RRA_FANART_KEY").value, "f");
});

// --- the wiring, checked as source text -------------------------------------
// seedApiKey is only correct if it is actually what assigns the two live
// variables, and if saving through Settings then claims the source. Neither is
// reachable from an extracted function, so both are pinned as text.

test("both live keys are assigned through seedApiKey", () => {
  const src = indexSource();
  for (const [v, envName] of [["discogsToken", "RRA_DISCOGS_KEY"],
                              ["fanartKey", "RRA_FANART_KEY"]]) {
    assert.match(src, new RegExp("seedApiKey\\([^)]*\"" + envName + "\"\\)"),
      envName + " is not read through seedApiKey");
    assert.match(src, new RegExp("let " + v + "\\s*=\\s*_\\w+Seed\\.value"),
      v + " is not assigned from a seed");
  }
});

test("saving in Settings claims the source, or the status line lies", () => {
  const src = indexSource();
  assert.match(src, /discogsSource = "settings"/);
  assert.match(src, /fanartSource = "settings"/);
});

test("the env names avoid the strings pre-flight step 2 greps for", () => {
  // Step 2 fails the build on either bare upper-snake name ANYWHERE in
  // index.js, and it matches substrings — so an env var containing one would
  // trip it. This asserts the check stays honest as names change.
  const src = indexSource();
  assert.ok(!/DISCOGS_TOKEN|FANART_TV_KEY/.test(src),
    "index.js carries a name that fails pre-flight step 2");
});
