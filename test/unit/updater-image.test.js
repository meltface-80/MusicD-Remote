"use strict";
// ---------------------------------------------------------------------------
// v1.8.70: the published image updates by being PULLED, never by unpacking a
// release over itself.
//
// A container started from ghcr.io/meltface-80/musicd-remote is a copy of that
// image, and the next `docker run` / `docker compose up` starts a fresh copy of
// whatever image it names. The in-place updater — download the release, unpack
// it over the install, restart — would last only until that recreate, and in
// the meantime the app would report one version while its image tag named
// another. So an image install still CHECKS and still says an update is there,
// but the update it offers is the pull command, everywhere it is offered: the
// web app, Roon's own Settings page, Roon's status line, and the API.
//
// Everything else — a native install, a container built locally from a tarball
// — keeps the in-place updater exactly as it was; nothing already installed
// changes behaviour until it is switched to the image.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { createUpdater, FIRST_IMAGE } = require("../../lib/updater");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

const IMAGE = "ghcr.io/meltface-80/musicd-remote";

// Any network call during apply() is a failure of the rule, not a slow test.
async function withNoNetwork(fn) {
  const calls = [];
  const saved = { get: https.get, request: https.request };
  https.get = https.request = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].hostname || a[0]))); throw new Error("network used"); };
  try { await fn(); } finally { https.get = saved.get; https.request = saved.request; }
  return calls;
}

test("the updater on the published image (v1.8.70)", async (t) => {
  await t.test("reports itself as pull-only, with the exact command", () => {
    const u = createUpdater({ owner: "meltface-80", repo: "MusicD-Remote", currentVersion: "1.8.70",
                              dir: "/nonexistent", image: IMAGE });
    const s = u.getStatus();
    assert.equal(s.canApply, false);
    assert.equal(s.image, IMAGE);
    assert.equal(s.pull, "docker pull " + IMAGE + ":latest");
  });

  await t.test("THE one: apply() refuses, before downloading or unpacking anything", async () => {
    const u = createUpdater({ owner: "meltface-80", repo: "MusicD-Remote", currentVersion: "1.8.70",
                              dir: "/nonexistent", image: IMAGE });
    let s;
    const calls = await withNoNetwork(async () => { s = await u.apply(); });
    assert.deepEqual(calls, [], "apply() went to the network on an image install: " + calls.join(", "));
    assert.equal(s.apply.phase, "error", "apply() on an image install did not refuse");
    assert.match(s.apply.error, /docker pull ghcr\.io\/meltface-80\/musicd-remote:latest/,
      "the refusal does not say how to update");
  });

  await t.test("a native or locally built install keeps the in-place updater", () => {
    for (const image of [undefined, "", "   "]) {
      const u = createUpdater({ owner: "meltface-80", repo: "MusicD-Remote", currentVersion: "1.8.70",
                                dir: "/nonexistent", image });
      const s = u.getStatus();
      assert.equal(s.canApply, true, "an install with image=" + JSON.stringify(image) + " lost its updater");
      assert.equal(s.pull, null);
    }
  });
});

// A GitHub that answers every API path from a table — no network.
async function withGitHub(answers, fn) {
  const { EventEmitter } = require("node:events");
  const saved = https.request;
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
  try { return await fn(); } finally { https.request = saved; }
}

test("an image install is only offered a release that exists as an image (v1.8.70)", async (t) => {
  const LATEST = "/repos/meltface-80/MusicD-Remote/releases/latest";
  const release = (tag) => ({ [LATEST]: { tag_name: tag, html_url: "x", body: "notes", assets: [] } });
  const check = (current, answers, image) => withGitHub(answers, () =>
    createUpdater({ owner: "meltface-80", repo: "MusicD-Remote", currentVersion: current,
                    dir: "/nonexistent", image }).checkNow());

  await t.test("THE one: a Latest release from before the images is not offered", async () => {
    // Today: v1.8.67 is Latest and was never pushed to ghcr.io — `latest`
    // does not exist there, so a test image told to pull it would fail.
    const s = await check("1.8.70", release("v1.8.67"), IMAGE);
    assert.equal(s.latest, "1.8.67", "precondition: the check did not read the release");
    assert.equal(s.available, false, "an image install was offered a release that has no image");
  });

  await t.test("a newer Latest release is offered as a pull", async () => {
    const s = await check("1.8.70", release("v1.8.71"), IMAGE);
    assert.equal(s.available, true);
    assert.equal(s.isDowngrade, false);
    assert.equal(s.canApply, false);
  });

  await t.test("an older Latest release that IS an image is offered as the way back", async () => {
    const s = await check("1.8.72", release("v1.8.71"), IMAGE);
    assert.equal(s.available, true);
    assert.equal(s.isDowngrade, true);
  });

  await t.test("the floor is the first published image, inclusive", async () => {
    assert.equal((await check("1.8.71", release("v" + FIRST_IMAGE), IMAGE)).available, true);
    assert.equal(FIRST_IMAGE, "1.8.70", "FIRST_IMAGE moved — no version below 1.8.70 was ever published");
  });

  await t.test("a bare tag is never offered to an image install — latest follows releases only", async () => {
    const tags = { "/repos/meltface-80/MusicD-Remote/tags": [{ name: "v1.8.80" }] };
    const s = await check("1.8.70", tags, IMAGE);
    assert.equal(s.latest, "1.8.80", "precondition: the tags fallback did not run");
    assert.equal(s.available, false);
  });

  await t.test("every other install keeps its offers exactly as before", async () => {
    assert.equal((await check("1.8.70", release("v1.8.67"), "")).available, true,
      "a native install lost its rollback to the Latest release");
    const tags = { "/repos/meltface-80/MusicD-Remote/tags": [{ name: "v1.8.80" }] };
    assert.equal((await check("1.8.70", tags, undefined)).available, true, "a native install lost the tags fallback");
  });
});

// Roon's own Settings page and status line read the same status.
function stubUpdater(st) {
  return { getStatus: () => Object.assign({
    current: "1.8.70", latest: "1.8.71", available: true, isDowngrade: false, notes: "Fixes.",
    checking: false, error: null, canApply: true, pull: null,
    apply: { phase: "idle", error: null, version: null } }, st) };
}

test("Roon's Settings page offers no install switch on the image (v1.8.70)", async (t) => {
  const layoutFor = (st) => loadIndexFunctions(["makeSettingsLayout"], {
    updater: stubUpdater(st), zones: {}, radioZones: new Set(), DISPLAY_BUILD: "1.8.70",
  }).makeSettingsLayout();

  await t.test("THE one: an image install says how to pull, and has no do_update switch", () => {
    const l = layoutFor({ canApply: false, pull: "docker pull " + IMAGE + ":latest" });
    const settings = l.layout.filter(x => x.setting).map(x => x.setting);
    assert.ok(!settings.includes("do_update"),
      "Roon's Settings page offers to install an update the image cannot apply");
    const text = l.layout.map(x => x.title).join("\n");
    assert.match(text, /docker pull ghcr\.io\/meltface-80\/musicd-remote:latest/);
    assert.match(text, /An update is available: v1\.8\.71/);
  });

  await t.test("every other install still gets the switch", () => {
    const l = layoutFor({ canApply: true });
    assert.ok(l.layout.some(x => x.setting === "do_update"), "the in-place install switch is gone");
  });
});

test("Roon's status line says how to update the image (v1.8.70)", () => {
  let line = "";
  const F = loadIndexFunctions(["pushStatus"], {
    updater: stubUpdater({ canApply: false, pull: "docker pull " + IMAGE + ":latest" }),
    svc_status: { set_status: (txt) => { line = txt; } },
    _statusPair: "Paired", _statusSync: "", _statusPairErr: false,
  });
  F.pushStatus();
  assert.match(line, /Update available: v1\.8\.71 — docker pull ghcr\.io\/meltface-80\/musicd-remote:latest, then recreate the container from it/);
  assert.doesNotMatch(line, /install from the web app/, "the status line points at an install the image cannot do");
});

test("the API refuses an in-place update of the image, with the command (v1.8.70)", () => {
  const src = indexSource();
  const at = src.indexOf('app.post("/api/update/apply"');
  assert.ok(at > 0, "the apply route moved");
  const route = src.slice(at, src.indexOf("\n});", at));
  const guard = route.indexOf("if (!st.canApply)");
  assert.ok(guard > 0, "/api/update/apply no longer refuses on the image");
  assert.ok(guard < route.indexOf("updater.apply()"), "the refusal comes after the update has started");
  assert.match(route.slice(guard, guard + 300), /status\(409\)/);
  assert.match(src, /createUpdater\(\{[\s\S]{0,400}image: PUBLISHED_IMAGE/,
    "index.js no longer tells the updater which image it runs");
  assert.match(src, /const PUBLISHED_IMAGE = \(process\.env\.MUSICD_IMAGE \|\| ""\)\.trim\(\);/);
});
