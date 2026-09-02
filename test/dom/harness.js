"use strict";
// ---------------------------------------------------------------------------
// Reusable headless-browser harness for the REAL browser UI.
//
// There is no Playwright/Puppeteer npm package here and no Roon Core, so this
// drives public/index.html + public/app.js directly:
//
//   1. take the shipping index.html verbatim;
//   2. inject a <base href> so its relative assets resolve from public/, and a
//      prelude that stubs window.fetch with canned API responses so app.js
//      boots without a server;
//   3. append a driver script that exercises the UI and reports results;
//   4. run `chromium --headless=new --virtual-time-budget=N --dump-dom` and
//      read the results back out of the dumped DOM.
//
// --virtual-time-budget fast-forwards timers, so a driver that waits 250ms for
// a render finishes in milliseconds of wall clock.
//
// Results travel as base64 in a single <div id="TESTRESULTS">, so no value can
// be mangled by HTML escaping or contain a "<" that breaks extraction.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT } = require("../lib/extract");

// MUSICD_PUBLIC_DIR points the harness at a COPY of public/ instead of the
// real one. Its purpose is mutation-checking: reintroduce a fixed bug in a
// throwaway copy and confirm the test goes red. Unset in normal runs, so tests
// always exercise the shipping files.
const PUBLIC_DIR = process.env.MUSICD_PUBLIC_DIR
  ? path.resolve(process.env.MUSICD_PUBLIC_DIR)
  : path.join(REPO_ROOT, "public");
const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");
// The wall display is a second, entirely separate page (its own HTML, CSS and
// JS). Everything below works on it unchanged — same fetch stub, same driver,
// same result channel — so it is a parameter rather than a second harness.
const DISPLAY_HTML = path.join(PUBLIC_DIR, "display.html");

// --- locating a browser ----------------------------------------------------
function findChromium() {
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) {
    return process.env.CHROMIUM_BIN;
  }
  const pw = "/opt/pw-browsers";
  if (fs.existsSync(pw)) {
    const dirs = fs.readdirSync(pw).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const p = path.join(pw, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CHROMIUM = findChromium();
const available = Boolean(CHROMIUM);

// --- page assembly ---------------------------------------------------------

// Runs before app.js. Provides the fetch stub plumbing and the reporting API.
const PRELUDE = `
window.__calls = [];
window.__pageErrors = [];
window.addEventListener("error", (e) => {
  window.__pageErrors.push(String((e && e.message) || e));
});
window.addEventListener("unhandledrejection", (e) => {
  window.__pageErrors.push("unhandledrejection: " + String((e && e.reason) || e));
});
window.__json = function (obj, status) {
  return Promise.resolve(new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  }));
};
// Count a call, then let the test's routes decide. Any route returning
// undefined falls through to an empty object, so an unstubbed endpoint can
// never hang the page.
window.__installFetch = function (routes) {
  window.fetch = function (url, opts) {
    url = String(url);
    window.__calls.push(url);
    try {
      const r = routes(url, opts);
      if (r !== undefined) return r;
    } catch (e) {
      window.__pageErrors.push("route error for " + url + ": " + e.message);
    }
    return window.__json({});
  };
};
// How many times an endpoint has been requested — the signal used to prove a
// click actually reached its handler.
window.__callsMatching = function (needle) {
  return window.__calls.filter(function (u) { return u.indexOf(needle) > -1; }).length;
};
window.__sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
`;

function driverWrapper(driverSource) {
  return `
(function () {
  var __results = {};
  window.T = function (key, value) { __results[key] = value; };
  function __emit() {
    if (window.__pageErrors && window.__pageErrors.length) {
      __results.__pageErrors = window.__pageErrors.slice(0, 10);
    }
    var payload = JSON.stringify(__results);
    var b64 = btoa(unescape(encodeURIComponent(payload)));
    var d = document.createElement("div");
    d.id = "TESTRESULTS";
    d.textContent = b64;
    document.body.appendChild(d);
  }
  window.addEventListener("load", function () {
    (async function () {
      ${driverSource}
    })().then(__emit, function (e) {
      __results.__error = String((e && e.stack) || e);
      __emit();
    });
  });
})();
`;
}

function buildHtml({ stub, driver, page }) {
  let html = fs.readFileSync(page === "display" ? DISPLAY_HTML : INDEX_HTML, "utf8");

  // Drop external resources — no network in CI, and a pending font request
  // only slows the run down.
  html = html.replace(/<link\b[^>]*href="https?:\/\/[^"]*"[^>]*>/gi, "");

  // index.html references its assets from the server root ("/style.css").
  // Under file:// that resolves outside the repo, so make them relative and
  // let <base> point at public/.
  html = html.replace(/<(link|script)\b[^>]*>/gi, (tag) =>
    tag.replace(/(href|src)="\/(?!\/)/g, '$1="')
  );

  const headInject =
    `<base href="file://${PUBLIC_DIR}/">\n<script>\n${PRELUDE}\n${stub || ""}\n</script>`;
  html = html.replace("<head>", "<head>\n" + headInject);

  const bodyInject = `<script>\n${driverWrapper(driver)}\n</script>`;
  html = html.replace("</body>", bodyInject + "\n</body>");

  return html;
}

/**
 * Render the real UI headlessly and return whatever the driver reported.
 *
 * @param {object}  opts
 * @param {string}  opts.stub     JS run before app.js — call window.__installFetch here.
 * @param {string}  opts.driver   async JS body run on load; report with T(key, value).
 * @param {number} [opts.budgetMs] virtual time budget (default 20000).
 * @param {string} [opts.name]     used for the temp file name.
 * @param {string} [opts.page]     "display" for the wall display page; the app otherwise.
 * @param {boolean} [opts.screenshot] also capture the composited page and return
 *                                   it as `__png` (a Buffer). This is the only
 *                                   way the suite can see PAINT ORDER — layout
 *                                   reports two overlapping elements at the same
 *                                   place and elementFromPoint skips anything
 *                                   with pointer-events:none, so "which one is
 *                                   on top" is otherwise unobservable. Decode it
 *                                   with lib/png.
 * @param {string} [opts.windowSize] "WxH" viewport, e.g. "390x844" for a phone.
 *                                   Layout tests need this — Chromium's default
 *                                   800x600 is neither phone nor desktop, and
 *                                   vh/dvh-sized panels behave differently.
 * @returns {object} the reported results; `__error` / `__pageErrors` if the page failed.
 */
function renderPage({ stub, driver, budgetMs = 20000, name = "page", windowSize, page, screenshot }) {
  if (!available) throw new Error("no chromium binary found — set CHROMIUM_BIN");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-dom-"));
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, buildHtml({ stub, driver, page }));

  const shotFile = path.join(dir, `${name}.png`);

  let dom;
  try {
    dom = execFileSync(CHROMIUM, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--allow-file-access-from-files",
      ...(windowSize ? [`--window-size=${windowSize.replace("x", ",")}`] : []),
      `--virtual-time-budget=${budgetMs}`,
      // --screenshot and --dump-dom coexist: the shot is taken when the virtual
      // time budget expires, i.e. after the driver has finished.
      ...(screenshot ? [`--screenshot=${shotFile}`] : []),
      "--dump-dom",
      file,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.max(60000, budgetMs * 3),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(
      `chromium failed for ${file}: ${e.message}\n` +
      (e.stderr ? e.stderr.toString().slice(0, 2000) : "")
    );
  }

  const m = /<div id="TESTRESULTS">([A-Za-z0-9+/=]*)<\/div>/.exec(dom);
  if (!m) {
    // Keep the page around — it is the only way to debug a harness failure.
    throw new Error(
      `no #TESTRESULTS in the dumped DOM — the driver never finished.\n` +
      `page kept at: ${file}\n` +
      `dom tail: ${dom.slice(-1500)}`
    );
  }
  // Read the shot BEFORE the temp dir goes, and carry the bytes rather than a
  // path, so nothing is left behind for a later run to trip over.
  let png = null;
  if (screenshot) {
    try { png = fs.readFileSync(shotFile); } catch (e) { png = null; }
  }
  fs.rmSync(dir, { recursive: true, force: true });

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } catch (e) {
    throw new Error(`could not decode #TESTRESULTS payload: ${e.message}`);
  }
  if (screenshot) {
    if (!png) throw new Error("--screenshot produced no file");
    parsed.__png = png;
  }
  return parsed;
}

/**
 * Assert the driver itself did not blow up. Call this before reading results,
 * so a page-level exception is never mistaken for a failing assertion.
 */
function assertNoPageError(assert, results) {
  if (results.__error) {
    assert.fail("the page driver threw:\n" + results.__error);
  }
  if (results.__pageErrors) {
    assert.fail("uncaught errors on the page:\n" + results.__pageErrors.join("\n"));
  }
}

module.exports = { available, CHROMIUM, renderPage, assertNoPageError, PUBLIC_DIR };
