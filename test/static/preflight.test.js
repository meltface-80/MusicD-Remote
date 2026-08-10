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
// The CLAUDE.md grep classifies a whole LINE as a write if any `.innerHTML =`
// appears on it. That has a real blind spot, confirmed by mutation-testing the
// DOM suite: `grid.innerHTML = tmp.innerHTML;` is a serialise-and-re-parse
// round trip — the exact v1.6.52 bug — and the line-based grep passes it,
// because the write masks the read beside it.
//
// So this classifies each OCCURRENCE: a `.innerHTML` is a write only when it
// is immediately followed by `= value`, `= <eol>` or `+=`. Anything else —
// including `===`, a bare read, or a read on the right of an assignment — is a
// read and fails. Current code passes this stricter rule.
const WRITE_AFTER = /^\s*(=\s*$|=[^=]|\+=)/;
const TOKEN = ".innerHTML";

function innerHtmlReads(rel) {
  const found = [];
  lines(rel).forEach((line, i) => {
    let idx = -1;
    while ((idx = line.indexOf(TOKEN, idx + 1)) > -1) {
      if (!WRITE_AFTER.test(line.slice(idx + TOKEN.length))) {
        found.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  });
  return found;
}

test("pre-flight 4 — no .innerHTML READS in browser code", () => {
  const violations = [];
  for (const rel of listFiles("public", (f) => f.endsWith(".js"))) {
    violations.push(...innerHtmlReads(rel));
  }
  assert.deepEqual(violations, [],
    "an .innerHTML read serialises live nodes and drops every listener and " +
    "closure attached to them — snapshot the live nodes into a " +
    "DocumentFragment instead:\n" + violations.join("\n"));
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

// --- CSS integrity --------------------------------------------------------
// An unterminated /* comment is the quietest possible CSS bug: the parser
// swallows everything up to the next "*/" — potentially dozens of rules — and
// reports nothing. No syntax error, no console warning, just a screen that
// silently lost its layout.
//
// This is here because it happened: flattening the Home screen deleted a
// watermark rule together with its comment's CLOSING "*/" while leaving the
// opening "/*" behind, which commented out the entire .home-carousel
// definition. Caught by a screenshot, not by any check — hence this one.
const SHIPPED_CSS = listFiles("public", (f) => f.endsWith(".css"));

test("CSS integrity", async (t) => {
  await t.test("at least one stylesheet was found to check", () => {
    assert.ok(SHIPPED_CSS.length > 0, "no .css files found under public/");
  });

  for (const rel of SHIPPED_CSS) {
    await t.test(`${rel} — comments are balanced and terminated`, () => {
      const src = read(rel);
      let i = 0, opened = 0;
      let unterminatedAt = -1;
      while (true) {
        const open = src.indexOf("/*", i);
        if (open === -1) break;
        const close = src.indexOf("*/", open + 2);
        if (close === -1) { unterminatedAt = open; break; }
        opened++;
        i = close + 2;
      }
      if (unterminatedAt !== -1) {
        const line = src.slice(0, unterminatedAt).split("\n").length;
        assert.fail(
          `${rel}:${line} opens a comment that is never closed. Everything after ` +
          "it is swallowed by the CSS parser with no error reported."
        );
      }
      // A stray "*/" outside a comment is equally silent.
      assert.equal(src.split("/*").length - 1, src.split("*/").length - 1,
        `${rel}: unbalanced comment markers`);
    });

    await t.test(`${rel} — braces are balanced`, () => {
      const src = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")     // strip comments
        .replace(/"(?:\\.|[^"\\])*"/g, '""')  // and string literals (data: URIs)
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
      let depth = 0, minDepth = 0;
      for (const ch of src) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth < minDepth) minDepth = depth; }
      }
      assert.equal(minDepth, 0, `${rel}: a "}" appears with no matching "{"`);
      assert.equal(depth, 0, `${rel}: ${depth} unclosed "{" block(s)`);
    });
  }
});

// --- API field-name drift between client and server ------------------------
// v1.7.16: every smart-playlist track tap returned HTTP 400 because the client
// posted the PLAYLIST route's field names (`track_index`/`track_title`) to the
// ALBUM route, which destructures `track`/`title`. The DOM test was green
// throughout — its stub accepts any body, so only the real names bite.
//
// A route's required fields are the ones it 400s on, so that is what this
// checks: for each guarded route, the client's POST body must contain every
// field the handler refuses to run without.
function requiredFieldsOf(indexSrc, route) {
  const at = indexSrc.indexOf(`app.post("${route}"`);
  if (at < 0) return null;
  const end = indexSrc.indexOf('\napp.', at + 10);
  const body = indexSrc.slice(at, end < 0 ? indexSrc.length : end);
  // Only names the route actually takes OUT of req.body count — a 400 guard can
  // just as easily test a local derived from them (play-multi guards on `list`,
  // which it builds from `items`/`offsets`).
  const fromBody = new Set();
  for (const m of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split("=")[0].trim();
      if (n) fromBody.add(n);
    }
  }
  // Scanned line by line, NOT with a paren-matching regex: an earlier version
  // used /if\s*\(([^)]*?)\)\s*return\s+res\.status\(400\)/ and silently matched
  // nothing, because a guard like `if (!Number.isFinite(offset))` contains a
  // nested ")". The test passed while asserting absolutely nothing.
  const need = new Set();
  for (const line of body.split("\n")) {
    if (!/res\.status\(400\)/.test(line)) continue;
    const cond = line.slice(0, line.indexOf("res.status(400)"));
    for (const id of cond.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)) {
      if (fromBody.has(id[1])) need.add(id[1]);
    }
  }
  return need;
}

function clientBodiesFor(appSrc, route) {
  const out = [];
  let i = 0;
  while ((i = appSrc.indexOf(`"${route}"`, i)) > -1) {
    const open = appSrc.indexOf("JSON.stringify({", i);
    if (open < 0) break;
    // Balanced scan from the object's brace — bodies here contain nested calls.
    let depth = 0, j = appSrc.indexOf("{", open);
    for (; j < appSrc.length; j++) {
      if (appSrc[j] === "{") depth++;
      else if (appSrc[j] === "}") { depth--; if (!depth) break; }
    }
    out.push(appSrc.slice(open, j + 1));
    i = j;
  }
  return out;
}

test("checklist — POST bodies carry the fields their route requires", async (t) => {
  const index = read("index.js");
  const app   = read("public/app.js");

  // Routes whose 400 guards name concrete body fields.
  for (const route of ["/api/play-track", "/api/play-multi", "/api/control"]) {
    await t.test(route, () => {
      const need = requiredFieldsOf(index, route);
      assert.ok(need, `${route} not found in index.js`);
      const bodies = clientBodiesFor(app, route);
      assert.ok(bodies.length, `no client call to ${route} found — update this test`);
      for (const body of bodies) {
        for (const field of need) {
          // `kind:` or ES6 shorthand `kind,` / `kind}` — both are the field.
          assert.ok(new RegExp("\\b" + field + "\\s*[:,}]").test(body),
            `${route}: a client body omits "${field}", which the route 400s without.\n` +
            `body was:\n${body}`);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// v1.7.48: Labels became opt-in, and the gate's POSITION is the whole design.
//
// The label scan does two unrelated jobs in one function. Pass 0 reads /music
// tags — and that is where release years (the Decade facet), the "local files"
// badge, and the Format / Sample rate / Bit depth / Channels facets come from.
// Everything after it is label names, the five-API metadata cascade and the
// logo fetches: the network traffic the switch is actually about.
//
// Gate too early and four Library facets plus two badge systems go dark with
// the labels. Gate too late and "off" still walks MusicBrainz and Discogs.
// Neither failure is visible in an ordinary read of the diff, and neither is
// reachable from a unit test — runLabelsIndexScan is 400 lines of async I/O.
// So the ordering is asserted here, on the source text.
// ---------------------------------------------------------------------------
test("the Labels opt-in gate sits between the file walk and the label lookups", async (t) => {
  // Via the extractor's indexSource(), NOT a direct read: it honours
  // MUSICD_INDEX_JS, which is what lets a mutation run point this at a
  // modified copy. Reading index.js directly here would make these assertions
  // untestable — they would pass against every mutant.
  const src = require("../lib/extract").indexSource();

  await t.test("the gate exists", () => {
    assert.ok(src.includes("if (!labelsEnabled) {"),
      "runLabelsIndexScan has no opt-in gate — Labels off would still scan");
  });

  await t.test("it is AFTER the file-tag harvest", () => {
    const harvest = src.indexOf('harvestAlbumYears("file tags")');
    const gate = src.indexOf("if (!labelsEnabled) {");
    assert.ok(harvest > 0 && gate > 0, "one of the two anchors moved");
    assert.ok(gate > harvest,
      "the gate returns before the /music tags are read — that takes the " +
      "Decade, Format, Sample rate, Bit depth and Channels facets and the " +
      "local-files badge down with the labels");
  });

  await t.test("it is BEFORE the metadata cascade and the logo fetches", () => {
    const gate = src.indexOf("if (!labelsEnabled) {");
    for (const marker of ['pass 2 (TheAudioDB)', 'pass 3 (MusicBrainz)',
                          'pass 4 (Discogs)', 'kickFanArtFetches()']) {
      const at = src.indexOf(marker, gate);
      assert.ok(at > gate,
        "'" + marker + "' is not after the gate — Labels off would still run it");
    }
  });
});
