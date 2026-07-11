// lib/updater.js — in-app self-update from GitHub Releases (with a tags fallback).
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.
//
// Strategy: ask GitHub for the latest release (or, if none, the highest semver
// tag), compare its version to the running one, and — on request — download the
// build tarball, extract it, overlay it onto the install dir, run `npm install`
// if dependencies changed, and restart. Restart is coordinated by launcher.js
// (which sets RRA_VIA_LAUNCHER=1): the running app stages the update and exits
// with code 75; the launcher applies the staged files and relaunches. When run
// without the launcher, the app applies the files itself and exits 75 so a
// process supervisor (systemd/Docker/pm2) restarts it.

const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ---- version helpers (semver-ish: major.minor.patch, prerelease < release) ----
function parseVer(tag) {
  if (tag == null) return null;
  const m = String(tag).trim().replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return 0;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (pa.pre && !pb.pre) return -1;   // 1.2.0-beta < 1.2.0
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre > pb.pre ? 1 : (pa.pre < pb.pre ? -1 : 0);
  return 0;
}
function verGt(a, b) { return cmpVer(a, b) > 0; }

// A GitHub source tarball wraps everything in one top-level dir
// (owner-repo-sha/); an uploaded asset built by this project wraps it in
// roon-random-albums/. Either way, find that single top dir.
function topLevelDir(root) {
  const entries = fs.readdirSync(root);
  if (entries.length === 1 && fs.statSync(path.join(root, entries[0])).isDirectory()) {
    return entries[0];
  }
  return null;
}

// Recursively copy src over dest, skipping names in `skip` (so we never clobber
// the user's Roon pairing in config.json, node_modules, the staging dir, .git).
function copyOverlay(src, dest, skip) {
  skip = skip || [];
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue;
    const s = path.join(src, name), d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyOverlay(s, d, skip);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ---- GitHub HTTP ----
// Follows redirects: when a repository is RENAMED, GitHub answers the old
// /repos/<owner>/<repo>/… URLs with a 301 to the new location. Without
// following it, every installed copy's update check silently reports
// "up to date" forever after a rename — the exact trap this closes ahead of
// the MusicD Remote repo rename. `apiPath` may be a path on
// api.github.com or (after a redirect) an absolute URL.
function ghGetJson(apiPath, token, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 6;
  return new Promise((resolve, reject) => {
    const u = /^https?:\/\//i.test(apiPath)
      ? new URL(apiPath)
      : new URL("https://api.github.com" + apiPath);
    const headers = {
      "User-Agent": "musicd-remote-updater",
      "Accept": "application/vnd.github+json"
    };
    // Never leak the token to a non-GitHub-API host a redirect may point at.
    if (token && u.hostname === "api.github.com") headers.Authorization = "Bearer " + token;
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
          // Location may be relative — resolve against the current origin.
          const next = new URL(res.headers.location, u.origin).toString();
          return resolve(ghGetJson(next, token, redirectsLeft - 1));
        }
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
            catch (e) { reject(e); }
          } else {
            resolve({ status: res.statusCode, json: null, raw: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("GitHub API timeout")));
    req.end();
  });
}

function downloadFile(url, dest, token, redirectsLeft) {
  if (redirectsLeft == null) redirectsLeft = 6;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      "User-Agent": "musicd-remote-updater",
      "Accept": "application/octet-stream"
    };
    // Only send the token to GitHub's own API host; never leak it to the
    // redirected storage host (codeload / object store).
    if (token && u.hostname === "api.github.com") headers.Authorization = "Bearer " + token;
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
        return resolve(downloadFile(res.headers.location, dest, token, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("download HTTP " + res.statusCode)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve()));
      f.on("error", reject);
    }).on("error", reject);
  });
}

// Overlay a staged build onto the install dir and `npm install` if deps changed.
// Shared by the in-app updater (no-launcher path) and by launcher.js.
function applyStaged(stagedDir, targetDir, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const readPkg = (p) => {
    try { return JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")); }
    catch (e) { return {}; }
  };
  const oldDeps = JSON.stringify(readPkg(targetDir).dependencies || {});
  copyOverlay(stagedDir, targetDir, [".git", "node_modules", ".update", "config.json", "cache"]);
  const newDeps = JSON.stringify(readPkg(targetDir).dependencies || {});
  if (oldDeps !== newDeps) {
    log("dependencies changed — running npm install");
    const r = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"],
      { cwd: targetDir, stdio: "inherit", shell: true, timeout: 5 * 60 * 1000 });
    if (r.status !== 0) log("npm install exited with status " + r.status + " (continuing)");
  }
}

// ---------------------------------------------------------------------------
// Updater instance
// ---------------------------------------------------------------------------
function createUpdater(o) {
  const { owner, repo, currentVersion, dir } = o;
  const viaLauncher = !!o.viaLauncher;
  const token = o.token || null;
  const debug = !!o.debug;
  const log = (...a) => { if (debug) console.log("[updater]", ...a); };

  const state = {
    current: currentVersion, latest: null, latestTag: null, available: false,
    isDowngrade: false,
    html_url: null, notes: null, source: null,
    checkedAt: 0, checking: false, error: null,
    _downloadUrl: null,
    apply: { phase: "idle", error: null, version: null }
  };
  let timer = null;

  function getStatus() {
    return {
      current: state.current, latest: state.latest, latestTag: state.latestTag,
      available: state.available, isDowngrade: state.isDowngrade,
      html_url: state.html_url, notes: state.notes,
      source: state.source, checkedAt: state.checkedAt, checking: state.checking,
      error: state.error, viaLauncher,
      apply: { phase: state.apply.phase, error: state.apply.error, version: state.apply.version }
    };
  }

  async function checkNow() {
    if (state.checking) return getStatus();
    state.checking = true; state.error = null;
    try {
      let rel = null, src = null;
      const r = await ghGetJson(`/repos/${owner}/${repo}/releases/latest`, token);
      if (r.status === 200 && r.json && r.json.tag_name) {
        rel = r.json; src = "release";
      } else if (r.status === 404) {
        // No published release — fall back to the highest semver tag.
        const t = await ghGetJson(`/repos/${owner}/${repo}/tags?per_page=30`, token);
        if (t.status === 200 && Array.isArray(t.json) && t.json.length) {
          let best = null;
          for (const tag of t.json) {
            if (parseVer(tag.name) && (!best || verGt(tag.name, best.name))) best = tag;
          }
          if (best) {
            src = "tags";
            rel = {
              tag_name: best.name,
              html_url: `https://github.com/${owner}/${repo}/releases/tag/${best.name}`,
              body: null, assets: [],
              _tarball: `https://api.github.com/repos/${owner}/${repo}/tarball/${best.name}`
            };
          }
        }
      } else if (r.status === 403) {
        throw new Error("GitHub rate-limited or forbidden (set RRA_GITHUB_TOKEN to raise the limit)");
      } else if (r.status >= 400) {
        throw new Error("GitHub API HTTP " + r.status);
      }

      if (rel) {
        const ver = parseVer(rel.tag_name) ? rel.tag_name.replace(/^v/i, "") : rel.tag_name;
        const assets = rel.assets || [];
        const tarAsset = assets.find((a) => /\.(tgz|tar\.gz)$/i.test(a.name || ""));
        state.latest = ver;
        state.latestTag = rel.tag_name;
        state.html_url = rel.html_url || null;
        state.notes = (rel.body || "").trim().slice(0, 3000) || null;
        state.source = src;
        state._downloadUrl = tarAsset ? tarAsset.browser_download_url
                            : (rel.tarball_url || rel._tarball || null);
        const diff = parseVer(ver) && parseVer(currentVersion) ? cmpVer(ver, currentVersion) : 0;
        state.available = diff !== 0;
        state.isDowngrade = diff < 0;
      } else {
        state.latest = null; state.latestTag = null; state.available = false;
        state.source = null; state._downloadUrl = null;
      }
      state.checkedAt = Date.now();
      log("checked:", state.latest, "available=" + state.available, "src=" + state.source);
    } catch (e) {
      state.error = e.message; log("check failed:", e.message);
    } finally {
      state.checking = false;
    }
    return getStatus();
  }

  async function apply() {
    const busy = ["downloading", "extracting", "restarting"];
    if (busy.includes(state.apply.phase)) return getStatus();

    state.apply = { phase: "checking", error: null, version: null };
    if (!state.available || !state._downloadUrl) {
      await checkNow();
      if (!state.available || !state._downloadUrl) {
        state.apply = { phase: "error", error: state.error || "No update available", version: null };
        return getStatus();
      }
    }
    const target = state.latest;
    const upd = path.join(dir, ".update");
    const dlFile = path.join(upd, "download.tgz");
    const exRoot = path.join(upd, "extract");
    try {
      fs.mkdirSync(upd, { recursive: true });
      try { fs.rmSync(exRoot, { recursive: true, force: true }); } catch (e) {}
      fs.mkdirSync(exRoot, { recursive: true });

      state.apply = { phase: "downloading", error: null, version: target };
      log("downloading", state._downloadUrl);
      await downloadFile(state._downloadUrl, dlFile, token);

      state.apply = { phase: "extracting", error: null, version: target };
      const ex = spawnSync("tar", ["-xzf", dlFile, "-C", exRoot], { stdio: "ignore", shell: true });
      if (ex.status !== 0) throw new Error("extraction failed (is `tar` installed and on PATH?)");
      const top = topLevelDir(exRoot);
      const staged = top ? path.join(exRoot, top) : exRoot;
      if (!fs.existsSync(path.join(staged, "index.js")) ||
          !fs.existsSync(path.join(staged, "package.json"))) {
        throw new Error("downloaded build is missing index.js/package.json");
      }

      if (viaLauncher) {
        fs.writeFileSync(path.join(upd, "READY"), JSON.stringify({ staged, version: target }));
        state.apply = { phase: "restarting", error: null, version: target };
        log("staged; exiting 75 for launcher to apply + restart");
        setTimeout(() => process.exit(75), 400);
      } else {
        applyStaged(staged, dir, { log });
        try { fs.rmSync(upd, { recursive: true, force: true }); } catch (e) {}
        state.apply = { phase: "restarting", error: null, version: target };
        log("applied in place; exiting 75 for supervisor to restart");
        setTimeout(() => process.exit(75), 400);
      }
    } catch (e) {
      state.apply = { phase: "error", error: e.message, version: target };
      log("apply failed:", e.message);
    }
    return getStatus();
  }

  function startAuto(intervalMs) {
    stopAuto();
    checkNow().catch(() => {});
    timer = setInterval(() => checkNow().catch(() => {}), intervalMs);
    if (timer.unref) timer.unref();
  }
  function stopAuto() { if (timer) { clearInterval(timer); timer = null; } }

  return { getStatus, checkNow, apply, startAuto, stopAuto };
}

module.exports = {
  createUpdater, applyStaged,
  parseVer, cmpVer, verGt, topLevelDir, copyOverlay
};
