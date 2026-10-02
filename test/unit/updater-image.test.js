"use strict";
// ---------------------------------------------------------------------------
// The published image keeps the ONE-TAP update (v1.8.71).
//
// v1.8.70 made an image install update only by `docker pull`, because what the
// app unpacks inside a container lasts only until that container is recreated.
// The user wants every install to keep its one-tap update, so the image updates
// in place exactly like a container built from a tarball — and the install
// commands carry `--pull always`, so a recreate fetches the current release
// instead of restarting a stale local image.
//
// The pull command survives as an ALTERNATIVE: shown beside the button, never
// instead of it, and only for a release that exists as an image. Nothing before
// FIRST_IMAGE was ever pushed to ghcr.io, and `latest` follows releases marked
// Latest, never a bare tag.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createUpdater, FIRST_IMAGE } = require("../../lib/updater");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

const IMAGE = "ghcr.io/meltface-80/musicd-remote";
const PULL = "docker pull " + IMAGE + ":latest";
const LATEST = "/repos/meltface-80/MusicD-Remote/releases/latest";
const TAGS = "/repos/meltface-80/MusicD-Remote/tags";
const TARBALL = "https://github.com/meltface-80/MusicD-Remote/releases/download/v1.8.71/MusicD-Remote-v1.8.71.tar.gz";

const release = (tag) => ({ [LATEST]: { tag_name: tag, html_url: "x", body: "notes",
  assets: [{ name: "MusicD-Remote-" + tag + ".tar.gz", browser_download_url: TARBALL }] } });
const bareTag = { [TAGS]: [{ name: "v1.8.80" }] };

// A GitHub that answers every API path from a table, and every download with
// a 404 — no network. `downloads` records each download that was attempted.
async function withGitHub(answers, fn) {
  const saved = { request: https.request, get: https.get };
  const downloads = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const hit = Object.keys(answers).find(p => opts.path.startsWith(p));
      const res = new EventEmitter();
      res.statusCode = hit ? 200 : 404;
      res.headers = {};
      res.resume = () => {};
      cb(res);
      res.emit("data", hit ? JSON.stringify(answers[hit]) : "{}");
      res.emit("end");
    });
    return req;
  };
  https.get = (opts, cb) => {
    downloads.push("https://" + opts.hostname + opts.path);
    const req = new EventEmitter();
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 404;
      res.headers = {};
      res.resume = () => {};
      cb(res);
    });
    return req;
  };
  try { return { result: await fn(), downloads }; }
  finally { https.request = saved.request; https.get = saved.get; }
}

const updaterFor = (current, image, dir) => createUpdater({ owner: "meltface-80", repo: "MusicD-Remote",
  currentVersion: current, dir: dir || "/nonexistent", image });

test("the published image keeps the one-tap update (v1.8.71)", async (t) => {
  await t.test("THE one: apply() on the image goes ahead, exactly as on any other install", async () => {
    const seen = {};
    for (const image of [IMAGE, ""]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-upd-"));
      try {
        const { result, downloads } = await withGitHub(release("v1.8.71"),
          () => updaterFor("1.8.70", image, dir).apply());
        seen[image ? "image" : "native"] = { downloads, error: result.apply.error };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    assert.deepEqual(seen.image.downloads, [TARBALL],
      "the image install never downloaded the release — its one-tap update was refused");
    assert.equal(seen.image.error, "download HTTP 404",
      "the image install stopped somewhere other than the (stubbed) download: " + seen.image.error);
    assert.deepEqual(seen.image, seen.native, "the image install's update went differently from a native one");
  });

  await t.test("the status names no refusal, and no pull until a check finds an image release", async () => {
    const u = updaterFor("1.8.70", IMAGE);
    const before = u.getStatus();
    assert.equal(before.image, IMAGE);
    assert.equal(before.pull, null, "a pull command before any release is known");
    assert.ok(!("canApply" in before), "the status still carries v1.8.70's canApply");
    const { result } = await withGitHub(release("v1.8.71"), () => u.checkNow());
    assert.equal(result.available, true);
    assert.equal(result.pull, PULL);
  });
});

test("the pull command is only offered for a release that exists as an image (v1.8.71)", async (t) => {
  const check = async (current, answers, image) =>
    (await withGitHub(answers, () => updaterFor(current, image).checkNow())).result;

  await t.test("a Latest release from before the images is offered by tap, with no pull", async () => {
    // Today's situation when v1.8.70 was cut: v1.8.67 Latest, never on ghcr.io.
    const s = await check("1.8.70", release("v1.8.67"), IMAGE);
    assert.equal(s.available, true, "the image install lost its rollback — every release has a tarball");
    assert.equal(s.isDowngrade, true);
    assert.equal(s.pull, null, "told to pull an image that was never published");
  });

  await t.test("the floor is the first published image, inclusive", async () => {
    assert.equal((await check("1.8.71", release("v" + FIRST_IMAGE), IMAGE)).pull, PULL);
    assert.equal(FIRST_IMAGE, "1.8.70", "FIRST_IMAGE moved — no version below 1.8.70 was ever published");
  });

  await t.test("a bare tag is offered by tap as before, never as a pull — latest follows releases only", async () => {
    const s = await check("1.8.70", bareTag, IMAGE);
    assert.equal(s.latest, "1.8.80", "precondition: the tags fallback did not run");
    assert.equal(s.available, true);
    assert.equal(s.pull, null);
  });

  await t.test("a native or locally built install is never given a pull command", async () => {
    for (const image of [undefined, "", "   "]) {
      const s = await check("1.8.70", release("v1.8.71"), image);
      assert.equal(s.available, true);
      assert.equal(s.pull, null, "an install with image=" + JSON.stringify(image) + " was told to pull");
      assert.equal(s.image, null);
    }
  });
});

// Roon's own Settings page and status line read the same status.
function stubUpdater(st) {
  return { getStatus: () => Object.assign({
    current: "1.8.70", latest: "1.8.71", available: true, isDowngrade: false, notes: "Fixes.",
    checking: false, error: null, image: null, pull: null,
    apply: { phase: "idle", error: null, version: null } }, st) };
}

test("Roon's Settings page keeps its install switch on the image (v1.8.71)", async (t) => {
  const layoutFor = (st) => loadIndexFunctions(["makeSettingsLayout"], {
    updater: stubUpdater(st), zones: {}, radioZones: new Set(), DISPLAY_BUILD: "1.8.71",
  }).makeSettingsLayout();
  const text = (l) => l.layout.map(x => x.title).join("\n");

  await t.test("THE one: the image install gets the switch, and the pull command beside it", () => {
    const l = layoutFor({ image: IMAGE, pull: PULL });
    assert.ok(l.layout.some(x => x.setting === "do_update"),
      "Roon's Settings page took the one-tap install away from the image");
    assert.match(text(l), /Or pull the image itself: docker pull ghcr\.io\/meltface-80\/musicd-remote:latest/);
  });

  await t.test("no pull line where there is no image to pull", () => {
    // Not /docker pull/: without the guard the line reads "Or pull the image
    // itself: null, … docker compose pull …", which that pattern never sees.
    for (const st of [{ image: IMAGE, pull: null }, { image: null, pull: null }]) {
      const l = layoutFor(st);
      assert.ok(l.layout.some(x => x.setting === "do_update"));
      const stray = l.layout.filter(x => /Or pull|null/.test(x.title || "")).map(x => x.title);
      assert.deepEqual(stray, [], "a pull line with nothing to pull: " + stray.join(" | "));
    }
  });
});

test("Roon's status line points at the one-tap install on the image (v1.8.71)", () => {
  let line = "";
  const F = loadIndexFunctions(["pushStatus"], {
    updater: stubUpdater({ image: IMAGE, pull: PULL }),
    svc_status: { set_status: (txt) => { line = txt; } },
    _statusPair: "Paired", _statusSync: "", _statusPairErr: false,
  });
  F.pushStatus();
  assert.match(line, /Update available: v1\.8\.71 — install from the web app or this Settings page/);
});

test("the API never refuses an update because of the image (v1.8.71)", () => {
  const src = indexSource();
  const at = src.indexOf('app.post("/api/update/apply"');
  assert.ok(at > 0, "the apply route moved");
  const route = src.slice(at, src.indexOf("\n});", at));
  assert.ok(route.includes("updater.apply()"), "precondition: the route no longer applies");
  // The route has no legitimate use for the word at all, so any spelling of an
  // image check — st.image, PUBLISHED_IMAGE, process.env.MUSICD_IMAGE — fails.
  assert.doesNotMatch(route, /image|canApply|st\.pull/i, "/api/update/apply treats the image differently again");
  assert.equal(route.split("status(409)").length - 1, 1,
    "/api/update/apply refuses for a reason other than \"no update available\"");
  assert.match(src, /createUpdater\(\{[\s\S]{0,400}image: PUBLISHED_IMAGE/,
    "index.js no longer tells the updater which image it runs — the pull alternative would vanish");
  // The name the Dockerfile bakes in (ENV MUSICD_IMAGE, pinned in
  // test/static/images.test.js) and the name read here must be the same one.
  assert.match(src, /const PUBLISHED_IMAGE = \(process\.env\.MUSICD_IMAGE \|\| ""\)\.trim\(\);/,
    "index.js reads a different variable from the one the image sets");
});
