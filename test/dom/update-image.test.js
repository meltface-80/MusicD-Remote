"use strict";
// ---------------------------------------------------------------------------
// v1.8.70: on the published image, the app says how to update — it never
// offers a button that would unpack a release over the running container.
// (The rule itself, and Roon's own Settings page, are in
// test/unit/updater-image.test.js.)
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const PULL = "docker pull ghcr.io/meltface-80/musicd-remote:latest";

function stub(status) {
  return `
window.__applyCalls = 0; window.__checkCalls = 0;
window.__installFetch(function (u, init) {
  if (u.indexOf("/api/update/apply") > -1) { window.__applyCalls++; return window.__json({ error: "refused" }, 409); }
  if (u.indexOf("/api/update/check") > -1) { window.__checkCalls++; return window.__json({}); }
  if (u.indexOf("/api/update/status") > -1) return window.__json(${JSON.stringify(status)});
  if (u.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1) return window.__json({});
  return undefined;
});`;
}

const DRIVER = `
  await window.__sleep(900);
  var toast = document.getElementById("update-toast");
  var now = document.getElementById("update-now");
  T("toast", { open: toast.classList.contains("open"),
               text: document.getElementById("update-text").textContent,
               button_shown: !now.classList.contains("hidden") && getComputedStyle(now).display !== "none",
               notes: document.getElementById("update-notes").textContent });
  var banner = document.getElementById("docker-migration-banner");
  T("banner", { shown: !banner.classList.contains("hidden"), text: banner.textContent });

  // Settings → System → Check for updates, twice.
  var st = document.createElement("style"); st.textContent = ".settings-sheet { animation: none !important; }";
  document.head.appendChild(st);
  document.getElementById("settings-toggle").click();
  await window.__sleep(300);
  document.querySelector('.settings-nav-item[data-pane="system"]').click();
  await window.__sleep(300);
  var btn = document.getElementById("check-update-btn");
  btn.click();
  await window.__sleep(600);
  var notes = document.getElementById("settings-release-notes");
  T("settings", { label: btn.textContent, notes: notes.classList.contains("hidden") ? "" : notes.textContent });
  btn.click();
  await window.__sleep(600);
  T("after_second", { label: btn.textContent, applies: window.__applyCalls, checks: window.__checkCalls });
`;

const BASE = { current: "1.8.70", latest: "1.8.71", latestTag: "v1.8.71", available: true,
               isDowngrade: false, notes: "Fixes and polish.", checking: false, error: null,
               apply: { phase: "idle", error: null, version: null } };

test("an image install is told to pull, never offered an in-place update (v1.8.70)", async (t) => {
  const r = harness.renderPage({ name: "update-image", windowSize: "390x844", budgetMs: 20000, driver: DRIVER,
    stub: stub(Object.assign({}, BASE, { canApply: false, pull: PULL, image: "ghcr.io/meltface-80/musicd-remote",
                                         is_docker: true })) });
  harness.assertNoPageError(assert, r);

  await t.test("THE one: the toast says how, and has no Update button", () => {
    assert.equal(r.toast.open, true, "no update toast at all");
    assert.match(r.toast.text, /v1\.8\.71 available \(you have v1\.8\.70\)/);
    assert.equal(r.toast.button_shown, false,
      "the toast offers Update on the image — it would unpack a release the next recreate undoes");
    assert.ok(r.toast.notes.includes(PULL), "the toast does not give the pull command: " + r.toast.notes);
    assert.ok(r.toast.notes.includes("recreate the container from that image"),
      "the toast sends a test or pinned install back to its usual command, which names another tag");
    assert.ok(r.toast.notes.includes("Fixes and polish."), "the release notes went missing");
  });

  await t.test("Settings → System says the same, and its button stays a check", () => {
    assert.equal(r.settings.label, "v1.8.71 available");
    assert.ok(r.settings.notes.includes(PULL), "Settings does not give the pull command: " + r.settings.notes);
    assert.equal(r.after_second.applies, 0, "an update was started on the image");
    assert.equal(r.after_second.checks, 2, "the second tap did not check again");
  });

  await t.test("a Docker install is not shown the native-install banner", () => {
    assert.equal(r.banner.shown, false);
  });
});

test("everything else keeps the in-place updater (v1.8.70)", async (t) => {
  const r = harness.renderPage({ name: "update-local-docker", windowSize: "390x844", budgetMs: 20000, driver: DRIVER,
    stub: stub(Object.assign({}, BASE, { canApply: true, pull: null, image: null, is_docker: true })) });
  harness.assertNoPageError(assert, r);
  await t.test("a locally built container still gets its Update button", () => {
    assert.equal(r.toast.open, true);
    assert.equal(r.toast.button_shown, true, "the in-place updater went missing from a locally built install");
    assert.ok(!r.toast.notes.includes("docker pull"), "a locally built install was told to pull");
  });
  await t.test("…and Settings turns its button into the install action as before", () => {
    assert.equal(r.settings.label, "Update to v1.8.71");
  });
});

test("a native install's banner points at the image, not a tarball (v1.8.70)", async (t) => {
  const r = harness.renderPage({ name: "update-native", windowSize: "390x844", budgetMs: 20000, driver: DRIVER,
    stub: stub(Object.assign({}, BASE, { available: false, canApply: true, pull: null, is_docker: false })) });
  harness.assertNoPageError(assert, r);
  await t.test("the Switch to Docker banner runs the published image", () => {
    assert.equal(r.banner.shown, true, "precondition: the banner did not show for a native install");
    assert.ok(r.banner.text.includes("ghcr.io/meltface-80/musicd-remote:latest"),
      "the banner does not run the published image");
    assert.ok(!/docker build|\.tar\.gz/.test(r.banner.text), "the banner still downloads and builds a tarball");
    // A native install is the systemd unit INSTALL.md created, which kept its
    // name through the rename: there never was a musicd-remote.service.
    assert.ok(r.banner.text.includes("systemctl stop roon-random-albums"),
      "the banner does not stop the native service by its real name: " + r.banner.text);
    assert.ok(!r.banner.text.includes("systemctl stop musicd-remote"), "the banner stops a unit that never existed");
    assert.ok(r.banner.text.indexOf("systemctl stop") < r.banner.text.indexOf("docker run"),
      "the banner starts the container before stopping the native install — two copies of the extension at once");
  });
});

test("an image install AHEAD of the Latest release is told how to go back (v1.8.70)", async (t) => {
  // A test image, or a version image pulled before it is promoted: the server
  // only offers this when the Latest release exists as an image (FIRST_IMAGE).
  const r = harness.renderPage({ name: "update-image-back", windowSize: "390x844", budgetMs: 20000, driver: DRIVER,
    stub: stub(Object.assign({}, BASE, { current: "1.8.72", latest: "1.8.71", isDowngrade: true, canApply: false,
                                         pull: PULL, image: "ghcr.io/meltface-80/musicd-remote", is_docker: true })) });
  harness.assertNoPageError(assert, r);
  await t.test("the toast says go back, not update — and still has no button", () => {
    assert.match(r.toast.text, /Rollback to v1\.8\.71 available \(you have v1\.8\.72\)/);
    assert.equal(r.toast.button_shown, false);
    assert.ok(r.toast.notes.includes("To go back to v1.8.71, pull it:"), "the toast calls a rollback an update: " + r.toast.notes);
    assert.ok(!r.toast.notes.includes("Update it with"), "the toast calls a rollback an update");
    assert.ok(r.toast.notes.includes("recreate the container from that image"));
  });
  await t.test("Settings names the Latest release and installs nothing", () => {
    assert.equal(r.settings.label, "Latest release: v1.8.71");
    assert.ok(r.settings.notes.includes("To go back to v1.8.71, pull it:"));
    assert.equal(r.after_second.applies, 0);
  });
});
