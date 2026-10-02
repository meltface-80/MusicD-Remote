"use strict";
// ---------------------------------------------------------------------------
// v1.8.70: the published images, pinned.
//
// Nothing in this suite can run GitHub Actions, so the workflows are pinned as
// text: the parts that would quietly break the promise if they drifted.
//
//   * `latest` moves ONLY in latest.yml, and only for the release marked
//     Latest. A merge — still a pre-release — must never reach anyone pulling
//     latest, and nobody would notice until an untested build did.
//   * Every image is built for both x86 and 64-bit ARM, and carries
//     MUSICD_IMAGE, which is what tells the app to update by pulling rather
//     than by unpacking a release over the running container.
//   * The image keeps the paths, port and user of the containers people already
//     run, so an existing data volume works when they switch.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_ROOT } = require("../lib/extract");

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const IMAGE_STEP = /docker\/build-push-action@v\d+[\s\S]*?(?=\n {6}- |\n*$)/g;

test("the image workflows (v1.8.70)", async (t) => {
  const release = read(".github/workflows/release.yml");
  const latest  = read(".github/workflows/latest.yml");
  const testImg = read(".github/workflows/test-image.yml");

  await t.test("THE one: only latest.yml ever tags latest", () => {
    for (const [name, src] of [["release.yml", release], ["test-image.yml", testImg]]) {
      assert.doesNotMatch(src, /:latest\b/, name + " tags `latest` — a merge or a test build would reach " +
        "everyone pulling latest before it was promoted");
    }
    assert.match(latest, /imagetools create[\s\S]*?:latest/, "latest.yml no longer points latest at a version");
  });

  await t.test("latest follows the release marked Latest, not any release", () => {
    assert.match(latest, /types:\s*\[released, edited\]/, "latest.yml no longer runs when a release is promoted");
    assert.match(latest, /releases\/latest/, "latest.yml no longer checks the release is GitHub's Latest — editing " +
      "an old release's notes would drag latest backwards");
    assert.doesNotMatch(latest, /^\s+push:\s*$/m, "latest.yml runs on a push");
    // Promoting fires `released` AND `edited`: two runs moving latest at once
    // could finish in either order, so they queue instead, and none is dropped.
    assert.match(latest, /concurrency:\s*\n\s+group: latest-image\s*\n\s+cancel-in-progress: false/,
      "latest.yml runs can overlap, or a newer one cancels an older one mid-move");
  });

  await t.test("every build is two-architecture and knows it is the published image", () => {
    const steps = [...release.matchAll(IMAGE_STEP), ...latest.matchAll(IMAGE_STEP), ...testImg.matchAll(IMAGE_STEP)];
    assert.equal(steps.length, 3, "expected one image build in each of the three workflows, found " + steps.length);
    for (const [step] of steps) {
      assert.match(step, /platforms:\s*linux\/amd64,linux\/arm64/, "an image build lost a platform:\n" + step);
      assert.match(step, /MUSICD_IMAGE=/, "an image build does not set MUSICD_IMAGE — the app would unpack " +
        "releases over the running container:\n" + step);
      assert.match(step, /push:\s*true/);
    }
  });

  await t.test("version images are built once; test images never come from main or the docs", () => {
    assert.match(release, /imagetools inspect[\s\S]*?exists=/, "release.yml no longer skips a version already published");
    assert.match(release, /needs:\s*release/, "the image is built before its release exists");
    assert.match(testImg, /branches-ignore:\s*\[main\]/);
    assert.match(testImg, /"docs\/\*\*"/);
    assert.match(testImg, /"\*\*\/\*\.md"/);
    assert.match(testImg, /"docker-compose\.yml"/, "a docs-only promotion (which edits docker-compose.yml) builds a test image");
    assert.match(testImg, /:\$\{\{ steps\.v\.outputs\.version \}\}-test/, "the pinned <version>-test tag is gone");
  });

  await t.test("the workflows that push can push, and nothing else asks for more", () => {
    for (const [name, src] of [["release.yml", release], ["latest.yml", latest], ["test-image.yml", testImg]]) {
      assert.match(src, /packages:\s*write/, name + " cannot push to ghcr.io");
      assert.doesNotMatch(src, /permissions:\s*write-all/, name + " asks for every permission");
    }
  });
});

test("the image keeps what existing containers rely on (v1.8.70)", async (t) => {
  const dockerfile = read("Dockerfile");
  await t.test("same app dir, data volume, port — and no change of user", () => {
    assert.match(dockerfile, /^WORKDIR \/app$/m);
    assert.match(dockerfile, /^VOLUME \/app\/data$/m);
    assert.match(dockerfile, /^EXPOSE 3399$/m);
    assert.doesNotMatch(dockerfile, /^USER /m, "the image changed user — every existing volume's files are " +
      "root's, and a new user may not be able to write them");
  });
  await t.test("MUSICD_IMAGE is set from a build arg, after the npm install layer", () => {
    const arg = dockerfile.indexOf("ARG MUSICD_IMAGE");
    assert.ok(arg > 0, "no MUSICD_IMAGE build arg");
    assert.match(dockerfile, /ENV MUSICD_IMAGE=\$MUSICD_IMAGE/);
    assert.ok(arg > dockerfile.indexOf("RUN npm install"),
      "the build arg sits above npm install, so every image name change reinstalls every dependency");
  });
  await t.test("the image leaves out what the tarball leaves out", () => {
    const ignore = read(".dockerignore").split("\n").map(l => l.trim());
    for (const entry of ["node_modules", ".git", "data", "docs"]) {
      assert.ok(ignore.includes(entry), ".dockerignore does not exclude " + entry);
    }
  });
});
