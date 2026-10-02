"use strict";
// ---------------------------------------------------------------------------
// v1.8.71: the published image keeps the one-tap update. The Update button is
// there on every install; on the image the pull command is offered BESIDE it,
// in Settings → System, and only for a release that exists as an image.
// (The updater itself, Roon's Settings page and the API are in
// test/unit/updater-image.test.js.)
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const PULL = "docker pull ghcr.io/meltface-80/musicd-remote:latest";
const IMAGE = "ghcr.io/meltface-80/musicd-remote";

function stub(status) {
  return `
window.__applyCalls = 0; window.__checkCalls = 0;
window.__installFetch(function (u, init) {
  if (u.indexOf("/api/update/apply") > -1) { window.__applyCalls++; return window.__json({ ok: true, status: ${JSON.stringify(status)} }); }
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
               button: now.querySelector("span").textContent,
               button_shown: !now.classList.contains("hidden") && getComputedStyle(now).display !== "none",
               notes: document.getElementById("update-notes").textContent });
  var banner = document.getElementById("docker-migration-banner");
  T("banner", { shown: !banner.classList.contains("hidden"), text: banner.textContent });

  // Settings → System → Check for updates, then the second tap that installs.
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
  T("after_second", { applies: window.__applyCalls, checks: window.__checkCalls });
`;

const BASE = { current: "1.8.70", latest: "1.8.71", latestTag: "v1.8.71", available: true,
               isDowngrade: false, notes: "Fixes and polish.", checking: false, error: null,
               apply: { phase: "idle", error: null, version: null } };

const render = (name, status) => harness.renderPage({ name, windowSize: "390x844", budgetMs: 20000,
  driver: DRIVER, stub: stub(Object.assign({}, BASE, status)) });

test("an image install keeps its one-tap update, with the pull beside it (v1.8.71)", async (t) => {
  const r = render("update-image", { image: IMAGE, pull: PULL, is_docker: true });
  harness.assertNoPageError(assert, r);

  await t.test("THE one: the toast offers Update on the image", () => {
    assert.equal(r.toast.open, true, "no update toast at all");
    assert.match(r.toast.text, /v1\.8\.71 available \(you have v1\.8\.70\)/);
    assert.equal(r.toast.button_shown, true, "the image install lost its one-tap update");
    assert.equal(r.toast.button, "Update");
    assert.equal(r.toast.notes, "Fixes and polish.", "the toast carries more than the release notes");
  });

  await t.test("Settings → System installs on the second tap, and offers the pull as well", () => {
    assert.equal(r.settings.label, "Update to v1.8.71");
    assert.ok(r.settings.notes.startsWith("Fixes and polish."), "the release notes went missing: " + r.settings.notes);
    assert.ok(r.settings.notes.includes("Or pull the image itself:\n" + PULL),
      "the pull alternative is missing on the image: " + r.settings.notes);
    assert.equal(r.after_second.applies, 1, "the second tap did not start the one-tap update");
    assert.equal(r.after_second.checks, 1);
  });

  await t.test("a Docker install is not shown the native-install banner", () => {
    assert.equal(r.banner.shown, false);
  });
});

test("no pull is suggested for a release that was never an image (v1.8.71)", async (t) => {
  // v1.8.67 was Latest when v1.8.70 was cut, and was never pushed to ghcr.io.
  const r = render("update-image-preimage", { latest: "1.8.67", latestTag: "v1.8.67", isDowngrade: true,
                                              image: IMAGE, pull: null, is_docker: true });
  harness.assertNoPageError(assert, r);
  await t.test("the rollback is still one tap", () => {
    assert.match(r.toast.text, /Rollback to v1\.8\.67 available \(you have v1\.8\.70\)/);
    assert.equal(r.toast.button_shown, true);
    assert.equal(r.toast.button, "Roll back");
    assert.equal(r.settings.label, "Roll back to v1.8.67");
    assert.equal(r.after_second.applies, 1);
  });
  await t.test("…and nothing tells it to pull", () => {
    // Not /docker pull/ alone: an unguarded line reads "…pulling the image:
    // null …docker compose pull…", which that pattern never sees.
    for (const notes of [r.settings.notes, r.toast.notes]) {
      assert.doesNotMatch(notes, /docker pull|Or pull|pulling the image|null/, "told to pull: " + notes);
    }
  });
});

test("an image install ahead of an image release is offered the way back both ways (v1.8.71)", async (t) => {
  const r = render("update-image-back", { current: "1.8.72", isDowngrade: true, image: IMAGE, pull: PULL,
                                          is_docker: true });
  harness.assertNoPageError(assert, r);
  await t.test("Roll back by tap, or go back by pulling", () => {
    assert.equal(r.settings.label, "Roll back to v1.8.71");
    assert.ok(r.settings.notes.includes("Or go back by pulling the image:\n" + PULL), r.settings.notes);
    assert.doesNotMatch(r.settings.notes, /Or pull the image itself/);
  });
});

test("a locally built container is exactly as it was (v1.8.71)", async (t) => {
  const r = render("update-local-docker", { image: null, pull: null, is_docker: true });
  harness.assertNoPageError(assert, r);
  await t.test("one-tap update, no pull anywhere", () => {
    assert.equal(r.toast.button_shown, true);
    assert.equal(r.settings.label, "Update to v1.8.71");
    assert.equal(r.settings.notes, "Fixes and polish.");
    assert.equal(r.after_second.applies, 1);
  });
});

test("a native install's banner runs the image, and keeps it current on recreate (v1.8.71)", async (t) => {
  const r = render("update-native", { available: false, image: null, pull: null, is_docker: false });
  harness.assertNoPageError(assert, r);
  await t.test("the Switch to Docker banner runs the published image", () => {
    assert.equal(r.banner.shown, true, "precondition: the banner did not show for a native install");
    assert.ok(r.banner.text.includes("ghcr.io/meltface-80/musicd-remote:latest"),
      "the banner does not run the published image");
    assert.ok(!/docker build|\.tar\.gz/.test(r.banner.text), "the banner still downloads and builds a tarball");
    // The one-tap update lives in the container; without --pull always, the
    // next recreate restarts whatever stale :latest is on the machine.
    assert.match(r.banner.text, /docker run -d --pull always /, "the banner's docker run does not pull on recreate");
    // A native install is the systemd unit INSTALL.md created, which kept its
    // name through the rename: there never was a musicd-remote.service.
    assert.ok(r.banner.text.includes("systemctl stop roon-random-albums"),
      "the banner does not stop the native service by its real name: " + r.banner.text);
    assert.ok(!r.banner.text.includes("systemctl stop musicd-remote"), "the banner stops a unit that never existed");
    assert.ok(r.banner.text.indexOf("systemctl stop") < r.banner.text.indexOf("docker run"),
      "the banner starts the container before stopping the native install — two copies of the extension at once");
    // Pulled FIRST: a pull that fails leaves the native install running,
    // instead of stopped with nothing to replace it.
    const pullAt = r.banner.text.indexOf("docker pull ghcr.io/meltface-80/musicd-remote:latest");
    assert.ok(pullAt > -1 && pullAt < r.banner.text.indexOf("systemctl stop"),
      "the banner stops the native install before it knows the image can be fetched");
    assert.match(r.banner.text, /Docker 20\.10 or later/, "--pull needs Docker 20.10+, and the banner does not say so");
  });
});
