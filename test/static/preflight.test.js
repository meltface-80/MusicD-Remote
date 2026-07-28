"use strict";
// ---------------------------------------------------------------------------
// The CLAUDE.md pre-flight checks, as tests instead of greps run by hand.
//
// Each of these guards a class of bug that actually shipped. Running them from
// `node --test` means they cannot be forgotten, they fail loudly with the
// offending file and line, and CI enforces them.
//
// Pre-flight step 3 ("node -e require('./index.js')") is NOT here: requiring
// index.js starts an Express server and begins Roon pairing, neither of which
// exists in CI. See test/README.md for what that leaves uncovered.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { REPO_ROOT } = require("../lib/extract");

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const lines = (rel) => read(rel).split("\n");

function listFiles(dir, filter) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(filter).map((f) => path.join(dir, f)).sort();
}

const SHIPPED_JS = [
  "index.js",
  "launcher.js",
  ...listFiles("lib", (f) => f.endsWith(".js")),
  ...listFiles("public", (f) => f.endsWith(".js")),
];

// --- pre-flight 1 — syntax ------------------------------------------------
test("pre-flight 1 — every shipped .js parses", async (t) => {
  for (const rel of SHIPPED_JS) {
    await t.test(rel, () => {
      try {
        execFileSync(process.execPath, ["--check", path.join(REPO_ROOT, rel)],
          { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        assert.fail(`${rel} has a syntax error:\n${e.stderr ? e.stderr.toString() : e.message}`);
      }
    });
  }
});

// --- pre-flight 2 — stale constant names ----------------------------------
// The DISCOGS_TOKEN vs discogsToken class of bug: a constant moved into
// settings, but a reference to the old UPPER_SNAKE name survived and threw at
// runtime on the auth path only.
const STALE_CONSTANTS = ["DISCOGS_TOKEN", "FANART_TV_KEY"];

test("pre-flight 2 — no stale UPPER_SNAKE constant names in index.js", () => {
  const hits = [];
  lines("index.js").forEach((line, i) => {
    for (const name of STALE_CONSTANTS) {
      if (line.includes(name)) hits.push(`index.js:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(hits, [],
    "stale constant name(s) found — these were migrated to settings and every " +
    "reference must use the live camelCase variable:\n" + hits.join("\n"));
});

// --- pre-flight 4 — live-UI round-trip audit ------------------------------
// The v1.6.52 "albums untappable after Back" bug. Reading .innerHTML to save a
// screen serialises it to markup; re-parsing that markup builds fresh elements
// and silently drops every listener and closure attached to the originals.
// Screens must be saved by MOVING the live nodes into a DocumentFragment.
//
// Mirrors the CLAUDE.md grep: a line mentioning .innerHTML is a violation
// unless it is an assignment (`= value`, `= <eol>`) or an append (`+=`).
const INNERHTML_WRITE = /\.innerHTML\s*(=\s*$|=[^=]|\+=)/;

test("pre-flight 4 — no .innerHTML READS in browser code", () => {
  const violations = [];
  for (const rel of listFiles("public", (f) => f.endsWith(".js"))) {
    lines(rel).forEach((line, i) => {
      if (line.includes(".innerHTML") && !INNERHTML_WRITE.test(line)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    "an .innerHTML read serialises live nodes and drops their listeners — " +
    "snapshot the nodes into a DocumentFragment instead:\n" + violations.join("\n"));
});

// --- pre-flight 5 — workflow expression audit -----------------------------
// GitHub Actions evaluates ${{ }} tokens ANYWHERE in a workflow, including
// inside shell comments. An invalid one fails the run at startup with zero
// jobs and no error message — which is why v1.6.52-v1.6.55 shipped with no
// tag and no release at all.
//
// The allowlist is CLAUDE.md's verbatim. Adding a genuinely valid context
// (needs., vars., ...) means extending this list deliberately — that is the
// intended fix, not deleting the check.
const ALLOWED_WORKFLOW_CONTEXTS =
  ["steps", "github", "secrets", "env", "matrix", "runner", "inputs"];
const ALLOWED_TOKEN = new RegExp(
  "^\\$\\{\\{\\s*(" + ALLOWED_WORKFLOW_CONTEXTS.join("|") + ")\\."
);

test("pre-flight 5 — every workflow ${{ }} token is a real expression", () => {
  const workflows = [
    ...listFiles(".github/workflows", (f) => f.endsWith(".yml") || f.endsWith(".yaml")),
  ];
  assert.ok(workflows.length > 0, "no workflow files found — check the path");

  const violations = [];
  for (const rel of workflows) {
    lines(rel).forEach((line, i) => {
      // Per TOKEN, not per line: a line holding one valid and one invalid
      // token would pass a line-based grep and still kill the run.
      for (const m of line.matchAll(/\$\{\{[^}]*\}\}/g)) {
        if (!ALLOWED_TOKEN.test(m[0])) {
          violations.push(`${rel}:${i + 1}: ${m[0]}`);
        }
      }
      // An unterminated token is just as fatal and matches nothing above.
      const opens = (line.match(/\$\{\{/g) || []).length;
      const closes = (line.match(/\}\}/g) || []).length;
      if (opens !== closes) violations.push(`${rel}:${i + 1}: unbalanced \${{ }} — ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, [],
    "invalid workflow expression(s) — Actions evaluates these even in shell " +
    "comments and the run dies at startup with no jobs and no error:\n" +
    violations.join("\n"));
});

// --- checklist — element IDs match between markup and script --------------
// "Any new HTML element ID matches the getElementById call in app.js exactly."
// A typo here yields a silent null and a dead control, with no console error
// until something dereferences it.
function idAudit(scriptRel, markupRel) {
  const script = read(scriptRel);
  const markup = read(markupRel);
  const declared = new Set();
  for (const m of markup.matchAll(/\bid="([^"]+)"/g)) declared.add(m[1]);
  // IDs the script itself creates (template literals, or el.id = "...").
  for (const m of script.matchAll(/\bid="([^"]+)"/g)) declared.add(m[1]);
  for (const m of script.matchAll(/\.id\s*=\s*"([^"]+)"/g)) declared.add(m[1]);

  const missing = [];
  for (const m of script.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
    if (!declared.has(m[1])) missing.push(m[1]);
  }
  return [...new Set(missing)];
}

test("checklist — every getElementById target actually exists", async (t) => {
  await t.test("app.js against index.html", () => {
    const missing = idAudit("public/app.js", "public/index.html");
    assert.deepEqual(missing, [],
      "getElementById targets that are neither in index.html nor created by " +
      "app.js — these silently return null:\n" + missing.join("\n"));
  });

  await t.test("display.js against display.html", () => {
    const missing = idAudit("public/display.js", "public/display.html");
    assert.deepEqual(missing, [],
      "getElementById targets that are neither in display.html nor created by " +
      "display.js:\n" + missing.join("\n"));
  });
});
