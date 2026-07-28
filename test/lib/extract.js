"use strict";
// ---------------------------------------------------------------------------
// Load pure functions out of index.js WITHOUT executing the module.
//
// index.js is a 7300-line monolith that, on require(), starts an Express
// server and begins pairing with a Roon Core. Neither exists in CI, so the
// module can never simply be require()d by a test. This harness reads index.js
// as TEXT, slices out the source of individual named function declarations,
// and re-compiles just those inside a wrapper whose parameters supply the
// module-level state each function reads (knownArtistSet, the album-key Sets).
//
// Why this and not a refactor: see test/README.md — the short version is that
// this exercises the SHIPPING source byte-for-byte and requires a zero-line
// diff to index.js, which is the only approach compatible with the
// zero-regression mandate while the safety net is still being built.
//
// The slicing is deliberately strict: if a function can't be found, or the
// extracted text doesn't compile, this throws loudly rather than silently
// testing the wrong bytes.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// MUSICD_INDEX_JS points the extractor at a COPY of index.js. Its only purpose
// is mutation-checking: reintroduce a fixed bug in a throwaway copy and confirm
// the suite goes red, proving the assertions actually bite. Unset in normal
// runs, so tests always read the shipping file.
const INDEX_PATH = process.env.MUSICD_INDEX_JS
  ? path.resolve(process.env.MUSICD_INDEX_JS)
  : path.join(REPO_ROOT, "index.js");

let _src = null;
function indexSource() {
  if (_src === null) _src = fs.readFileSync(INDEX_PATH, "utf8");
  return _src;
}

// --- a small scanner that skips over strings, comments and regex literals ---
// Brace counting alone is not safe: a `}` inside a comment or a regex would
// end the slice early and the test would silently cover the wrong code.

// Returns the index of the closing quote, or -1 if unterminated.
function skipString(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === quote) return j;
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      const end = scanBalanced(src, j + 1, "{", "}");   // ${ ... } substitution
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (quote !== "`" && c === "\n") return -1;         // unterminated literal
  }
  return -1;
}

// Returns the index of the closing "/" of a regex literal, or -1.
function skipRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n") return -1;
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "/") return j;
  }
  return -1;
}

// Decide whether the "/" at index i begins a regex literal rather than a
// division operator, by looking at the previous significant character.
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_KEYWORDS = [
  "return", "typeof", "case", "in", "of", "new", "delete",
  "void", "instanceof", "do", "else", "yield", "await",
];
function regexAllowedAt(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return REGEX_KEYWORDS.includes(src.slice(k + 1, j + 1));
  }
  return false;
}

// Index of the delimiter matching the `open` at openIdx, or -1.
function scanBalanced(src, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i, c);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === "/" && regexAllowedAt(src, i)) {
      const end = skipRegex(src, i);
      if (end >= 0) { i = end; continue; }
      // not actually a regex — fall through and treat as division
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Slice the full source text of a top-level `function NAME(...) { ... }`
 * declaration out of index.js.
 *
 * Anchored to column 0 (`^function`) so a mention of the name inside a comment,
 * or a same-named nested helper, can never be picked up instead.
 */
function extractFunction(name) {
  const src = indexSource();
  const re = new RegExp("^function\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      `extract: no top-level "function ${name}(" found in index.js. ` +
      `It was renamed, moved, or turned into a const/arrow — update the test, ` +
      `do not delete it.`
    );
  }
  const start = m.index;
  const parenOpen = src.indexOf("(", start);
  const parenClose = scanBalanced(src, parenOpen, "(", ")");
  if (parenClose < 0) throw new Error(`extract: unbalanced parameter list for ${name}`);
  const braceOpen = src.indexOf("{", parenClose);
  if (braceOpen < 0) throw new Error(`extract: no body found for ${name}`);
  const braceClose = scanBalanced(src, braceOpen, "{", "}");
  if (braceClose < 0) throw new Error(`extract: unbalanced body for ${name}`);

  const text = src.slice(start, braceClose + 1);
  // Gate: the slice must be a syntactically complete function on its own.
  try {
    new Function("return (" + text + ");");
  } catch (e) {
    throw new Error(
      `extract: the slice taken for ${name} does not compile (${e.message}). ` +
      `The scanner mis-detected a string/comment/regex boundary — fix ` +
      `test/lib/extract.js, do not weaken the test.`
    );
  }
  return text;
}

/**
 * Compile the named index.js functions into one shared scope and return them.
 *
 * `injections` supplies the module-level bindings those functions close over
 * in the real module (e.g. `knownArtistSet`, `localAlbumKeys`). They become
 * parameters of the wrapper, so the extracted code sees them by name exactly
 * as it does in index.js. Function declarations hoist inside the wrapper, so
 * `names` order does not matter.
 *
 * Sloppy mode on purpose: index.js is not a strict-mode module, and the tests
 * must run the code under the same semantics production does.
 */
function loadIndexFunctions(names, injections) {
  injections = injections || {};
  const injNames = Object.keys(injections);
  for (const n of injNames) {
    if (names.includes(n)) {
      throw new Error(`loadIndexFunctions: "${n}" is both extracted and injected — pick one.`);
    }
  }
  const body =
    names.map(extractFunction).join("\n\n") +
    "\nreturn { " + names.join(", ") + " };";
  const factory = new Function(...injNames, body);
  return factory(...injNames.map((n) => injections[n]));
}

module.exports = {
  REPO_ROOT,
  INDEX_PATH,
  indexSource,
  extractFunction,
  loadIndexFunctions,
};
