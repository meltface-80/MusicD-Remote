# MusicD Remote — test suite

Regression tests for the logic that has already produced user-visible bugs.

Everything here runs on **Node's built-in `node:test` + `node:assert`**. Nothing was
added to `package.json` — no new dependency, no new devDependency, no framework.
`index.js`, `public/*`, `package.json` and `CLAUDE.md` are untouched by this suite.

---

## Running

```bash
./test/run.sh            # everything — static + unit + dom   (~1.7s)
./test/run.sh --fast     # skip the headless-browser suite    (~1s)
./test/run.sh unit       # one suite (static | unit | dom)
```

`run.sh` exits non-zero if any suite fails, so it works unchanged as a pre-commit
gate and as a CI step. Requires Node 22+ (checked at startup).

To run a single file:

```bash
node --test test/unit/credits.test.js
```

> `node --test <directory>` is **not** supported on every Node 22 build — it tries to
> `require()` the directory. `run.sh` expands each suite to explicit files instead.

Current state: **111 tests, all passing** (static 16, unit 88, dom 7).

---

## Layout

| Path | What it is |
|------|------------|
| `test/run.sh` | Runner. Non-zero exit on any failure. |
| `test/lib/extract.js` | Loads pure functions out of `index.js` without executing it. |
| `test/unit/` | `node:test` suites for pure logic. |
| `test/dom/harness.js` | Reusable headless-Chromium harness for the real UI. |
| `test/dom/*.test.js` | Browser regression tests. |
| `test/static/` | The CLAUDE.md pre-flight greps, as tests. |

---

## How `index.js` is tested — and why this way

`index.js` starts an Express server and begins pairing with a Roon Core **on
`require()`**. There is no Core in CI or in the dev container, so the module can
never simply be required by a test. Three options were considered:

**(a) Read `index.js` as text and compile individual function sources — CHOSEN.**
`test/lib/extract.js` slices out a named `function NAME(...) {...}` declaration and
re-compiles just that function inside a wrapper whose parameters supply the
module-level state it reads (`knownArtistSet`, `localAlbumKeys`, …).

- Requires a **zero-line diff to `index.js`**. Under the zero-regression mandate,
  the safety net must not itself be able to cause the thing it is preventing.
- Tests the **shipping bytes**, not a copy that can drift.
- Extraction is anchored to column 0 (`^function NAME(`) so a mention in a comment
  or a nested same-named helper can never be picked up instead, and every slice is
  **compile-gated** — a mis-sliced function throws loudly rather than silently
  testing the wrong code.
- Cost: only top-level `function` declarations are reachable (not `const fn = () =>`),
  and each function's module-level dependencies must be listed explicitly by the test.
  Both failures are loud, never silent.

**(b) Extract pure helpers into `lib/` — the right destination, not the right first
step.** It is a real refactor of a 7300-line monolith with no existing test coverage,
which is precisely the change the mandate says not to make blind.

The migration path is the reason (a) is worth building first: these tests pin the
current behaviour of each helper **before** it moves. Move one family at a time
(`normalize`/`canonText`/`canonArtist`/`albumKey`/`albumKeys` is the natural first
cut — it has no dependencies), re-point that suite's `loadIndexFunctions([...])` call
at `require("../../lib/keys")`, and the same assertions now prove the move was
behaviour-preserving. Ratchet, don't leap.

**(c) An exported-for-test hook — rejected.** Adding `module.exports` at the bottom of
`index.js` does not help: `require()` still starts the server and the Roon pairing.
Making it importable means guarding startup behind `if (require.main === module)`,
which is itself a refactor of the module's entry path — the riskiest possible edit,
for less benefit than (b).

---

## What is covered

### `test/unit/` — pure logic that has already caused bugs

**`keys.test.js`** — `normalize`, `canonText`, `canonArtist`, `albumKey`, `albumKeys`,
`addFavouriteKeys`. The key space every source badge is decided in. Pins the
empty-key hazard (`÷`, `!!!`, all-CJK titles canonicalise to `""` and must produce
**no key at all**, never `"||artist"`), the `&`/`and` and leading-`The` convergences,
and the per-artist identities that make multi-artist albums matchable.

**`credits.test.js`** — `splitCreditIntoArtists`, `creditIdentities`, `creditHasArtist`.
The "Also appears on" bugs. `AC/DC` must never split (in any library);
`T-Bone Walker/Big Joe Turner/Otis Spann` must split into 3; the mixed
`Miles Davis/John Coltrane & Bill Evans` must split all the way down when the library
supplies the evidence, and must **stop half-way when it does not** — the `&` stage is
evidence-gated on purpose. Matching is whole-name equality: `Prince` must not match
`Jordan Prince` or `Bonnie "Prince" Billy`, and the same guard is asserted for
Bush/Kate Bush, Air/Air Supply, Sting/Stinger, Yes/Yesterday.
Each test states the library it assumes, because the splitter reads `knownArtistSet()`.

**`source.test.js`** — `withSource`. Badge precedence (local beats streaming),
ambiguity suppression (an identity held by two library albums gets no badge, and that
outranks even a local match), dual-service unknowability, the precomputed `rec.srcKeys`
path, and that the album object is mutated in place with `.source` always set
explicitly — never left `undefined`, never left stale.

### `test/dom/` — the real browser UI

`harness.js` drives the **shipping** `public/index.html` + `public/app.js` in headless
Chromium. It injects a `<base href>` plus a `window.fetch` stub with canned API
responses, appends a driver script, runs
`chromium --headless=new --virtual-time-budget=N --dump-dom`, and reads results back
as base64 from a single `<div id="TESTRESULTS">` (so no value can be mangled by HTML
escaping). `--virtual-time-budget` fast-forwards timers, so a driver that waits 300ms
for a render costs milliseconds of wall clock.

The browser is auto-detected (`CHROMIUM_BIN`, then `/opt/pw-browsers/*`, then the usual
system paths). If none is found the DOM tests **skip** rather than fail.

**`artist-back.test.js`** — the v1.6.52 "albums untappable after Back" regression.
Enters the artist view from a wall of real tiles, presses Back, and checks the wall
with two independent detectors:

1. a JS expando stamped on each tile — survives a node **move**, cannot survive an
   `innerHTML` serialise/re-parse;
2. a real dispatched click that must reach `openAlbum` and fire `/api/album?`.

A **control click before** the round trip proves the detector works at all, so a
failure can never be dismissed as "the harness can't detect clicks". Artist → artist →
Back chaining is covered too.

### `test/static/` — the CLAUDE.md pre-flight, automated

- **step 1** — `node --check` on every shipped `.js` (`index.js`, `launcher.js`,
  `lib/*.js`, `public/*.js`), not just `index.js`.
- **step 2** — no stale `DISCOGS_TOKEN` / `FANART_TV_KEY` constant names.
- **step 4** — no `.innerHTML` **reads** in browser code.
- **step 5** — every workflow `${{ }}` token is a real expression, checked
  **per token** rather than per line, plus an unbalanced-token check.
- **checklist** — every `getElementById("x")` target exists in the markup or is
  created by the script itself (covers `app.js`/`index.html` and
  `display.js`/`display.html`).

Two of these are deliberately **stricter** than the CLAUDE.md grep:

> **The line-based `innerHTML` grep has a blind spot.** It classifies a whole line as a
> write if any `.innerHTML =` appears on it. So `grid.innerHTML = tmp.innerHTML;` — a
> serialise-and-re-parse round trip, i.e. exactly the v1.6.52 bug — **passes** the
> grep, because the write masks the read beside it. This was confirmed by
> mutation-testing (below), not theorised. `preflight.test.js` classifies each
> *occurrence* instead. Current code passes the stricter rule.

> **The workflow grep is line-based too**, so a line holding one valid and one invalid
> token passes while still killing the run at startup. The test checks each token.

The workflow context allowlist (`steps`, `github`, `secrets`, `env`, `matrix`,
`runner`, `inputs`) is CLAUDE.md's verbatim. Adding a genuinely valid context
(`needs.`, `vars.`, …) means extending `ALLOWED_WORKFLOW_CONTEXTS` deliberately —
that is the intended fix, not deleting the check.

---

## What is NOT covered, and why

| Not covered | Why |
|---|---|
| **Pre-flight step 3** (`node -e "require('./index.js')"`) — the temporal-dead-zone / startup-crash audit | Requires a Roon Core and a free port. This is the one manual step left: run it on a paired machine before release. `node --check` catches syntax but **not** TDZ (`x = 1` above `let x`) — that class of bug (v1.5.66) is still only caught at real startup. |
| Anything calling the live Roon API — `buildAlbumIndex`, `browse`/`load`, playback, zones, the stale-offset resolver | No Core in CI. The *pure* decision logic those paths use (`creditHasArtist`, `albumKeys`) is covered; the transport is not. |
| Discogs / FanArt.tv / Qobuz / TIDAL / Pitchfork network calls | External services. Would need an HTTP-layer fixture. |
| `better-sqlite3` persistence, settings load/save, the thumbnail store | Touches the data volume. |
| CSS and visual layout, mobile rendering | `index.html` loads its stylesheet from `/style.css`; the DOM harness asserts on structure, classes and behaviour, not computed styles or pixels. |
| The release workflow actually producing a tag and release | Static checks confirm the workflow *parses and its expressions are valid* — the v1.6.52-55 failure mode. They cannot confirm GitHub ran it. Still verify the release exists after every merge. |

---

## Proving a test actually bites

A test that cannot fail is worse than no test. Both harnesses accept an env override
pointing at a **copy** of the source, so a fixed bug can be reintroduced in a throwaway
file and the suite confirmed red. Never point these at the real files.

```bash
# unit — reintroduce substring artist matching
cp index.js /tmp/mutant.js
#   in /tmp/mutant.js, change creditHasArtist's last line to:
#   return qNames.some(q => cNames.some(c => c.includes(q) || q.includes(c)));
MUSICD_INDEX_JS=/tmp/mutant.js node --test test/unit/*.test.js

# dom — reintroduce the innerHTML round trip
cp -r public /tmp/mutant-public
#   in /tmp/mutant-public/app.js, replace  grid.appendChild(saved.gridNodes);  with:
#   { const t = document.createElement("div"); t.appendChild(saved.gridNodes); grid.innerHTML = t.innerHTML; }
MUSICD_PUBLIC_DIR=/tmp/mutant-public node --test test/dom/artist-back.test.js
```

All three mutations were run against this suite and produced failures:
substring matching → 4 failures; removing the blank-title guards in
`albumKey`/`albumKeys` → 5 failures; the `innerHTML` round trip → 3 failures.

The `innerHTML` mutation is the instructive one: the *"Back restores the wall's tiles"*
assertion still **passed** — the markup came back looking perfect — while the identity
and clickability assertions failed. That is the bug's exact signature, and the reason
the DOM test asserts behaviour rather than appearance.

---

## Adding tests

**Pure logic in `index.js`** — add the function name to `loadIndexFunctions([...])` and
inject whatever module-level state it reads:

```js
const { loadIndexFunctions } = require("../lib/extract");
const F = loadIndexFunctions(
  ["normalize", "canonArtist", "myFunction"],
  { someModuleLevelSet: new Set() }
);
```

Only top-level `function NAME(...)` declarations can be extracted. If a helper is a
`const` arrow, either convert it (a real change to `index.js`, so review it properly)
or move it to `lib/` and require it directly.

**A UI behaviour** — copy `test/dom/artist-back.test.js`. Keep the shape:
a control assertion first (proving the detector works), then the regression assertion.
Prefer detectors that cannot be faked by correct-looking markup — expandos on live
nodes, and real dispatched events that must reach a stubbed endpoint.

**A new pre-flight rule** — add it to `test/static/preflight.test.js` rather than to
the CLAUDE.md shell block, so it runs in CI and reports the offending file and line.

---

## Observations found while writing these tests

Neither is fixed here — this suite changes no production code. Both are pinned by a
test that documents current behaviour, so any change is deliberate and visible.

1. **`withSource` — "local wins" is not absolute.** The "favourited in both services"
   branch `break`s out of the key loop, so a local match on a *later* (per-artist) key
   is never reached. An album favourited in both Qobuz and TIDAL under its whole-credit
   identity, and present locally under a per-artist identity, gets **no badge** rather
   than the `local` badge. The outcome is a missing badge, not a wrong one — the
   conservative direction — so this is low severity.
   Pinned in `source.test.js` → *"dual-service short-circuit (pinned behaviour)"*.

2. **`canonArtist("The The")` collapses to `"the"`.** The leading-`The` strip is
   unconditional, so that band's canonical identity is the single token `the`. Any
   other artist canonicalising to `the` would share its key space.
   Pinned in `keys.test.js` → *"'The The' collapses to 'the'"*.
