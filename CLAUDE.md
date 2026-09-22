# Claude Code — Project Rules for Roon Random Albums Extension

Read this file at the start of every session. These rules are permanent and override any
default behaviours. Do not deviate from them unless the user explicitly says so in that session.

---

## ZERO-TOLERANCE QUALITY MANDATE

**Regressions are not acceptable. Bugs introduced by a change are a failure, not a follow-up task.**

### Agent workflow — run for every non-trivial change

Every change must pass through all four agents before committing:

1. **Architect Agent** — scan files, map side effects, verify the change won't break adjacent behaviour or mobile rendering.
2. **Reviewer Agent** — ensure the change handles edge cases, empty states, and errors safely.
3. **Developer Agent** — apply complete, production-grade code. No inline placeholders (`// ...` or `// rest stays the same`).
4. **QA Agent** — execute the pre-flight checks below, verify pass status, and report results clearly.

Keep output compact — no wall-of-text explanations. Tag results clearly: `[PASS]` or `[FAIL] reason`.

### Mandatory pre-flight before every commit

Run these in order. Do not commit if any step fails.

```bash
# 1. Syntax check — catches crashes before they happen
node --check index.js

# 2. Variable name consistency — grep for UPPER_SNAKE leftovers
#    (catches the DISCOGS_TOKEN vs discogsToken class of bug)
grep -n 'DISCOGS_TOKEN\|FANART_TV_KEY' index.js && echo "ERROR: stale constant name" || echo "OK"

# 3. Temporal dead zone audit — every `let`/`const` must appear BEFORE
#    any bare assignment to the same name at module level
#    (catches the v1.5.66 startup crash class of bug)
node -e "require('./index.js')" 2>&1 | head -5
```

```bash
# 4. Live-UI round-trip audit — a view must never save/restore another
#    screen by READING .innerHTML. Re-parsing that markup builds fresh
#    elements, silently dropping every listener and closure attached to
#    the originals (the v1.6.52 "albums untappable after Back" bug).
#    Move the live nodes into a DocumentFragment instead.
grep -n '\.innerHTML' public/*.js | grep -vE '\.innerHTML\s*(=\s*$|=[^=]|\+=)' \
  && echo "ERROR: innerHTML read — snapshot live nodes, don't serialise" || echo "OK"
```

```bash
# 5. Workflow expression audit — every interpolation token in a workflow must
#    be a REAL expression. Actions evaluates them even inside shell comments,
#    and an invalid one kills the run at startup with no jobs and no error
#    (the v1.6.52-55 "no releases were ever created" outage).
grep -n '\${{' .github/workflows/*.yml \
  | grep -vE '\$\{\{ *(steps|github|secrets|env|matrix|runner|inputs)\.' \
  && echo "ERROR: invalid workflow expression" || echo "OK"
```

```bash
# 6. iOS full-screen contract — the app must keep filling the display.
#    `apple-mobile-web-app-status-bar-style: black-translucent` shifts the
#    document UP under the status bar without growing the layout viewport, so
#    it leaves a gap at the BOTTOM the size of the TOP inset (44-62px, not the
#    34px of a home indicator). `apple-mobile-web-app-capable` opts into the
#    legacy web-app path where that style governs the window.
#    THE PART THAT MAKES IT EXPENSIVE: iOS reads both at ADD-TO-HOME-SCREEN
#    time, not per launch, so a shortcut created against a bad build keeps the
#    bad window forever and no later server-side fix is observable through it.
#    (v1.7.60-65: six versions, five wrong diagnoses.)
#    Matches the TAG, not the word: index.html carries a comment naming these
#    three and explaining why they are absent, and a bare word-grep flags it.
#    A pre-flight step that cries wolf gets ignored, which is how a real one
#    gets waved through.
grep -nE '<meta[^>]*name="(apple-mobile-web-app-capable|mobile-web-app-capable|apple-mobile-web-app-status-bar-style)"' \
  public/index.html public/display.html \
  && echo "ERROR: legacy Apple web-app meta — this stops the app filling the screen" || echo "OK"

#    Exactly one viewport meta. A second silently overrides the first and
#    viewport-fit=cover stops applying, zeroing every env(safe-area-inset-*).
test "$(grep -c 'name="viewport"' public/index.html)" = "1" \
  && echo "OK" || echo "ERROR: not exactly one viewport meta"
```

If step 3 cannot run (Roon not available), run steps 1 and 2 and explicitly note why 3 was skipped.

### Pre-flight checklist (tick each before every push)

- [ ] `node --check index.js` exits 0
- [ ] No `let x` declared after a bare `x = ...` assignment at module scope
- [ ] Every variable referenced matches its exact declaration name (no UPPER_SNAKE drift)
- [ ] Every new `catch (e) {}` is intentional — not swallowing a symptom
- [ ] Auth headers reference the live variable, not a deleted constant
- [ ] Any new HTML element ID matches the `getElementById` call in app.js exactly
- [ ] No screen is saved/restored via an `.innerHTML` string — move live nodes (step 4 above)
- [ ] Nothing new in `<head>` that iOS reads — see step 6; the head allowlist in
      `test/static/pwa-icons.test.js` is the reference for what is permitted
- [ ] `package.json` version bumped
- [ ] CHANGELOG.md entry added

### Development rules

- **No incomplete implementations.** Write the full code. Never leave `// rest stays the same`.
- **No silent catch.** `catch (e) {}` must have a comment explaining why silence is safe.
- **Variable name freeze.** Once a variable is named, all references — declaration, assignment, template literals, log messages — use the identical name. Never mix camelCase and UPPER_SNAKE for the same value.
- **Declaration before use.** With `let`/`const` in Node.js, a bare assignment `x = val` on line N while `let x` is on line N+500 is a ReferenceError. Always declare at the first-use site.
- **Nothing goes in `<head>` without knowing whether iOS reads it.** The four lines
  charset / viewport / theme-color / title are the confirmed-good set (v1.6.50, installed and
  verified filling an iPhone screen); icon `<link>`s are inert and safe. Anything else — a
  manifest link, any `apple-*` meta — changes how iOS sizes the window, is baked in when the user
  adds the shortcut, and cannot be undone by shipping a new build. **A "still broken" report after
  such a change is not evidence the fix failed**: the old window config is still in the shortcut
  until it is deleted and re-added. Ask the user to reinstall the shortcut BEFORE diagnosing.
- **A stale installed PWA looks exactly like a regression. Rule it out FIRST.** The rule above says
  this for `<head>` changes; it is not limited to them. iOS keeps a home-screen shortcut's app state
  across updates, and a shortcut that has gone bad reproduces as "you broke X in version N" with
  perfect consistency — the user is not wrong about what they see, and no amount of reading the diff
  will find it. **v1.7.88–89**: "album covers aren't populating, v1.7.87 was fine". Two versions were
  spent on it; a third of a session went into a root cause that did not exist, and a fix shipped under
  a claim that turned out to be false. Deleting the shortcut and re-adding it fixed it with no code
  change. What SHOULD have happened, in this order:
    1. Ask for a delete-and-re-add of the shortcut before diagnosing anything.
    2. Diff the suspect versions for code that could plausibly cause the symptom. If `index.js` and
       the data path are untouched, a data-shaped symptom (missing artwork, empty rows, wrong counts)
       is almost certainly not in the diff.
    3. Reproduce it side by side. `git worktree add /tmp/vNN <tag>` plus
       `MUSICD_PUBLIC_DIR=/tmp/vNN/public node --test <probe>` runs the harness against BOTH versions
       from one script. Identical output is a real answer: the regression is not in the code.
  A hypothesis that survives none of those three is not a root cause, and shipping a fix for it
  attaches a false explanation to a real change.
- **Two numbers from two different moments are not a measurement.** The harness has two clocks:
  the driver runs inside the virtual time budget, and `--screenshot` fires when that budget
  EXPIRES — seconds of page-time later. A `getBoundingClientRect` reported by the driver and a
  pixel read out of the screenshot describe different frames, and in a Now-playing fixture the page
  moves 8.5px between them. **v1.7.90**: an assertion built that way reported the seek thumb riding
  8.5px off the waveform. It did not. A fix was written and nearly shipped — the native thumb hidden,
  the playhead redrawn into the canvas — before measuring BOTH values out of the same screenshot
  showed the thumb had been exactly on the midline all along. The whole change was reverted.
  When a test compares two positions, take both from the same source: two driver-time rects, or two
  screenshot-time pixel scans. Never one of each. (The real 2px defect in the same area was found
  the correct way, and the pixel test that pins it now scans for the waveform's bars AND the thumb
  in the one image.)
- **Ask what a statistic SATURATES at, and reduce with the same one at every scale.** The
  waveform drew a brick for five versions because each bar was the loudest SAMPLE in its slice,
  and a limiter puts something on the ceiling inside nearly any window you can name — so the
  measurement had no range left to show and every bar came out the same height. **v1.8.24**: a
  bar is an RMS level now, and the reduction is RMS too, because the RMS of RMS values IS the
  RMS of the whole span — a bar folded twice equals one computed once, so the picture does not
  depend on how many bars fit the screen. The rule the first version broke was never "prefer
  peaks", it was DO NOT AVERAGE PEAKS; measuring a level and then keeping the LOUDEST one is
  the same mistake one layer down and draws the same brick. Two corollaries learned the same
  day: **a downmix is an ADDITION** (`-ac 1` averages the channels rather than taking the
  louder, so an out-of-phase passage decodes to silence — RMS 0 against the pair's 2896), and
  **a short decode is not a short track** (a waveform is a map from time to a picture, so
  two thirds of a file drawn across the whole bar puts the playhead over the wrong music, by a
  margin that grows as it plays, and nothing about it looks wrong).
- **Two mappings from time to x will disagree, and the disagreement is zero in the middle.** A
  range input cannot let its thumb hang off either end, so its thumb travels `thumbW/2` to
  `w - thumbW/2` while anything drawn under it is laid from 0 to `w`. The error is
  `thumbW * (0.5 - frac)`: half a thumb ahead of the music at the start, level halfway,
  half a thumb behind at the end. **A test written at the midpoint passes against both
  mappings and says nothing** — which is exactly why v1.8.0's shipped for four versions.
  Anything drawn to line up with a native control is inset to that control's travel, and the
  width it travels in is ONE number both of them read (`--seek-thumb`).
- **A canvas is transparent between what it draws.** A fixture whose waveform is quiet where the
  assertion looks will pass with the drawing wrong, because the page shows through the gaps. Pixel
  tests over a canvas need a full-scale fixture at the point being checked, and a paused zone, or
  the playhead walks away from the coordinates being sampled.
- **Device-only behaviour cannot be tested here.** The DOM harness is headless Chromium: no browser
  chrome, no safe areas, `dvh` == `vh` == `100%`. No assertion in this suite can observe iOS window
  behaviour, so writing more of them buys confidence and no coverage. What the suite CAN do is pin a
  known-good state so it is not changed silently — that is what the head allowlist does.
- **No partial migrations.** When renaming a constant or moving it to settings, search the entire file with grep before committing to ensure zero stale references remain.

### When a bug is found

1. Identify the root cause (not the symptom).
2. Confirm the root cause explains ALL reported failures.
3. Fix the root cause, not the symptom.
4. Add the relevant pre-flight check above if one would have caught it.
5. Document what class of error it was in the CHANGELOG.

---

## Code review workflow (multi-agent)

For any non-trivial change, run a full code review using parallel agents before committing. The `/code-review --effort high` skill automates this. It must be run on any change that touches:
- The label scan pipeline (`runLabelsIndexScan`, `buildFileLabelMap`, pass logic)
- Discogs or FanArt.tv API integration
- Settings persistence (`savePersistedSettings`, `loadPersistedSettings`)
- New UI components in `public/app.js` or `public/index.html`

### Review angles (run in parallel via Agent tool)

Spawn all 8 angles simultaneously, then verify surviving candidates:

| Angle | What it hunts |
|-------|---------------|
| A — line-by-line diff scan | Inverted conditions, null deref, missing await, wrong variable |
| B — removed-behavior auditor | Dropped guards, deleted error paths, narrowed validation |
| C — cross-file tracer | Broken call sites, mismatched request/response shapes |
| D — reuse | Code that re-implements an existing helper |
| E — simplification | Redundant state, dead code, unnecessary nesting |
| F — efficiency | Sync I/O on hot paths, redundant computation |
| G — altitude | Bandaids layered on shared infrastructure |
| H — CLAUDE.md conventions | Quote the exact rule and exact violating line |

### Verify findings

For each surviving candidate, spawn one verifier agent and get: **CONFIRMED / PLAUSIBLE / REFUTED**.
- PLAUSIBLE by default — do not refute without quoting code that proves it impossible.
- REFUTED only when the code provably makes it unreachable.
- Keep CONFIRMED and PLAUSIBLE. Drop REFUTED.

### Fix all confirmed findings before committing

Do not commit with known CONFIRMED or PLAUSIBLE bugs. Fix them all in the same version bump.

---

## Repository — branch + PR workflow

- Develop on a **feature branch** of `meltface-80/MusicD-Remote` (e.g. `claude/<topic>`). Never commit directly to `main`.
- For each change: commit to the branch, build and **commit the tarball to the branch** (see below), push, and give the user the docker install command for the branch build. The user tests the branch build, then opens and merges the PR themselves.
- **Never open or merge a pull request yourself** unless the user explicitly asks. The user merges.
- **Two-phase release handshake (revised 2026-07-28 — supersedes the earlier rule).**
  - **"merged"** = the user tested the branch build and merged it. This is the nod to
    **cut the release**: confirm the tag `vX.Y.Z` and a **pre-release** exist for it, and
    create them if the workflow didn't. Do NOT touch README / docs-site versions yet.
  - **"marked/moved to latest"** = the user is happy and has promoted the release. NOW run
    the full promotion pass: every README version reference, the docs-site fallback
    version/examples, **`docker-compose.yml`'s pinned tag and image**, and this file's
    current-stable note + version-history table, as a docs-only commit on the freshly-restarted
    branch. `docker-compose.yml` is on that list because it was NOT, and sat at v1.7.73 through
    twenty releases: nothing generates it (the docs-site builder writes its own, per user), so
    it only ever changes when someone remembers. It is a version reference like the README's.
  - After every merge, VERIFY the release actually appeared (`list_releases` / `git
    ls-remote --tags`). The workflow failing silently is how v1.6.52-v1.6.55 shipped with
    no tag and no release at all.
- **Never write a literal `${{ ... }}`-style expression token in a workflow file**, not even
  inside a shell comment: Actions evaluates them anywhere in the file, and an invalid one
  fails the run at startup with zero jobs — which looks like "nothing happened", not an
  error. (Caused the v1.6.52-55 release outage.)
- The `old/` folder contains two permanent historical tarballs (v1.5.37 and v1.5.49). **Do not add to or remove from this folder.**

---

## Every build — required steps (in order)

**Docs-only exception:** a change that touches only `docs/` (the GitHub Pages site) and/or
repo documentation (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docker-compose.yml`) is NOT a
build. `docker-compose.yml` counts because it can only ever pin an ALREADY-PUBLISHED tag —
bumping it inside the release it names is impossible, so it is a post-release edit by nature,
exactly like the README's install commands. It skips the
version bump, the CHANGELOG entry, the tarball rebuild, and the docker install command —
`docs/` is excluded from the tarball and is never part of the running extension. Pre-flight
steps 1–2 still run (they are cheap and index.js must stay untouched), and the change still
gets a normal review before commit. The v1.6.36 bump for the original docs page was reverted
for exactly this reason — do not repeat it.

1. Make code changes
2. Bump `package.json` version
3. Add a CHANGELOG.md entry (see format below)
4. Run pre-flight checks (see above)
5. Build the tarball and place it at the repo root, replacing the previous version's tarball (`git rm` the old one, `git add` the new one)
6. Commit in a single commit: code + `package.json` + `CHANGELOG.md` + the new tarball
7. Push to the feature branch
8. Give the user the docker install command for the branch build (see template below)

**Commit the tarball to the branch.** Downloading it from GitHub (raw) is byte-exact; routing it through Dropbox/cloud storage corrupted the archive. Keep only the current version's tarball in the repo — replace it each build.

---

## Building and delivering the tarball

Build the tarball to `/tmp` first (so `tar` doesn't include the output file mid-write), then copy
it to the repo root and commit it to the branch. **Do not send it through Dropbox/cloud storage —
that corrupted the archive.** The user downloads it byte-exact from GitHub raw.

```bash
VERSION=$(node -p "require('./package.json').version")
TARBALL="MusicD-Remote-v${VERSION}.tar.gz"
tar -czf "/tmp/${TARBALL}" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./old' \
  --exclude='./data' \
  --exclude='./docs' \
  --exclude='./*.tar.gz' \
  .
cp "/tmp/${TARBALL}" "./${TARBALL}"
git rm -q MusicD-Remote-v<PREVIOUS>.tar.gz   # drop the old branch tarball
git add "${TARBALL}"
```

Commit the tarball with the rest of the change, push the branch, then give the user the docker
install command (see template below) using the GitHub **raw** URL for the tarball on the branch.

---

## GitHub releases — user-controlled

The user manually publishes releases on GitHub when they are satisfied with testing.

- **Never create a GitHub release yourself.**
- **Never change the latest/pre-release status yourself.**
- The GitHub Actions workflow (`.github/workflows/release.yml`) still exists but is not
  relied upon for the build/test cycle.

---

## README.md — frozen until told otherwise

- The README contains version references (install commands, tarball URLs, `docker build` tags).
- **Do not change any version number in README.md** unless the user explicitly says
  "promote to latest" or "update the README".
- Current stable version in the README: **v1.8.56** (until the user says otherwise).
- The extension is being renamed **MusicD Remote** ("for Roon" is descriptive, not part of the name). The Roon `extension_id` must NEVER change — it would force every user to re-authorize.

---

## CHANGELOG.md format

Add a new section at the top, above the previous version:

```
## [X.Y.Z] — YYYY-MM-DD

### Added / Fixed / Changed
- Description of change
```

---

## After each build — docker install command template

After pushing the branch, give this command with the version and branch filled in. It downloads
the tarball byte-exact from GitHub raw (no Dropbox). Drop the `/music` mount line when the user
is testing a Qobuz/Tidal streaming-only scenario.

```bash
sudo docker stop musicd-remote
sudo docker rm musicd-remote
sudo rm -f /opt/musicd-remote/MusicD-Remote-vPREVIOUS.tar.gz
cd /opt/musicd-remote
wget -O MusicD-Remote-vNEW.tar.gz \
  "https://raw.githubusercontent.com/meltface-80/MusicD-Remote/refs/heads/<BRANCH>/MusicD-Remote-vNEW.tar.gz"
file MusicD-Remote-vNEW.tar.gz   # expect: gzip compressed data
tar -xzf MusicD-Remote-vNEW.tar.gz
docker build -t musicd-remote:NEW .
docker run -d \
  --name musicd-remote \
  --restart unless-stopped \
  --network host \
  -v musicd-remote-data:/app/data \
  -v /mnt/dietpi_userdata/4tb/Music:/music:ro \
  musicd-remote:NEW
# NOTE: the volume holds the Roon pairing + history. New installs (and the
# user's box, after the one-time v1.6.32 copy migration) use
# musicd-remote-data; pre-v1.6.32 installs must copy roon-random-albums-data
# into it once (see README Updating) — a wrong/renamed volume silently
# starts empty (re-pairing, lost history).
```

---

## Current version history (for reference)

| Version | Status    | Notes                              |
|---------|-----------|------------------------------------|
| v1.5.37 | stable (superseded) | Previous README stable          |
| v1.5.38 | stable (superseded) | File scanner layout fix          |
| v1.5.39 | stable (superseded) | Rate limiting, MB timeout, misc  |
| v1.5.40 | stable (superseded) | iTunes rate limiting, file cache |
| v1.5.41 | stable (superseded) | Scan logging, 12h auto-rescan    |
| v1.5.42 | stable (superseded) | Progress tracking, circuit breaker |
| v1.5.43 | stable (superseded) | Progress bar >100% fix             |
| v1.5.44 | stable (superseded) | Label name text tiles              |
| v1.5.45 | stable (superseded) | Remove album-art fallback from label tiles |
| v1.5.46 | stable (superseded) | Label text size by longest word not word count |
| v1.5.47 | stable (superseded) | Consistent label text size via container query (8cqw) |
| v1.5.48 | stable (superseded) | Label text size increased to 9cqw |
| v1.5.49 | stable (superseded) | Discogs label logo fetches |
| v1.5.74 | stable (superseded) | Search sections, label-in-modal, Self-Released/Independent tiles |
| v1.5.75 | stable (superseded) | Qobuz label pass for streaming-only (Qobuz/Tidal) libraries |
| v1.5.76 | stable (superseded) | Manual logo picker thumbnails doubled |
| v1.5.77 | stable (superseded) | Back from a deep-linked label lands on that label in the grid |
| v1.5.78 | superseded | Read-only Roon browse probe (Qobuz feasibility) |
| v1.5.79 | superseded | Qobuz New Releases + add-to-favourites (unofficial API) |
| v1.5.80 | superseded | Qobuz: reflect existing favourites as Added |
| v1.5.81 | superseded | Qobuz: un-favourite (two-way toggle) |
| v1.5.82 | superseded | Qobuz: tap a release → review detail view |
| v1.5.83 | superseded | Qobuz overlay history-aware back (detail→list→closed) |
| v1.5.84 | stable (superseded) | Decade filter (per-album years collected during scan) |
| v1.5.70 | superseded | Code review fixes: scan lockout, CDN redirect, auth guards |
| v1.5.71 | superseded | Label scan/logo pipeline fixes (8-angle code review) |
| v1.5.72 | superseded | Label pipeline correctness, FanArt merge-redirect, Discogs retry fix |
| v1.5.94–v1.5.116 | superseded | Home landing redesign (Not played / Random / Label of the week / Browse by genre rows, watermarks) |
| v1.6.0  | stable (superseded) | Home redesign stability pass — 8-angle review fixes; "Play something unheard" 12-month window |
| v1.6.1–v1.6.3 | superseded | Pitchfork magazine page (listing scraper, woven mosaic, review fixes) |
| v1.6.4  | stable (superseded) | Global search (library + Qobuz + Tidal + Pitchfork), Pitchfork × on title row |
| v1.6.5  | stable (superseded) | Clean docker build — music-metadata 11 (0 audit vulns), node-uuid→uuid override, quiet npm install |
| v1.6.6–v1.6.9 | superseded | Album view + Queue tab Home-language refresh (ambient cover glow, tinted watermarked panels); Settings update button fix; v1.6.9's Now-playing panel later reverted |
| v1.6.10 | superseded | Selectable tracks — per-track Play now / Queue in the album view |
| v1.6.11 | superseded | Pitchfork reviews link to pitchfork.com (score + BNM kept in-app) |
| v1.6.12 | stable (superseded) | Now playing screen back to Roon-style |
| v1.6.13 | stable (superseded) | Now playing layout: Roon-parity spacing, no scroll, Home button, bracket sub-line |
| v1.6.14 | stable (superseded) | Landscape Now playing fix (tablet/desktop); adaptive share-card text (4 lines + auto-resize) |
| v1.6.15 | stable (superseded) | Performance pass: server art cache, index-served randoms, gzip, no scroll-jank blur, Home row reuse |
| v1.6.16 | stable (superseded) | Roon pairing persisted on the data volume — no more duplicate extension authorizations per update |
| v1.6.17–v1.6.20 | superseded | Wall display built out: /display page (rotating art/photos/review/bio/library grids/video), settings toggle + interval slider, precision YouTube matching, on-screen mode chips |
| v1.6.21 | stable (superseded) | Wall display: per-track video reload, live-position sync, video-first behaviour, tappable Play/Queue library grids |
| v1.6.22–v1.6.27 | superseded | Wall display refinements: per-credit artist bios, photo letterboxing, label-grid selectability (root-caused in .26), bio-cache bound |
| v1.6.28–v1.6.29 | superseded | Instant Home reopen (PWA state kept); faster filtered-album playback |
| v1.6.30 | superseded | FanArt key self-heal (purge cached misses on save); validated wall-display artist bios (Qobuz/Tidal-first, album cross-checked Wikipedia) |
| v1.6.31 | stable (superseded) | Renamed to MusicD Remote in-app; updater follows GitHub repo-rename redirects |
| v1.6.32 | stable (superseded) | Repo renamed to MusicD-Remote: new install paths/names, tarball renamed (docker suffix dropped), updater derives new repo |
| v1.6.33 | superseded | Release automation naming fixed for MusicD-Remote; migration banner URL |
| v1.6.34 | stable (superseded) | Settings category redesign; faster artist search |
| v1.6.35 | stable (superseded) | Roon API hygiene: queue-subscription leak fixed, pooled browse sessions, re-pair probe instead of full rescan, play-multi throttled, roon API deps pinned |
| v1.6.36 | stable (superseded) | macOS/Docker Desktop direct Core connection via ROON_CORE_IP (ws_connect + retry; discovery unchanged without it) |
| v1.6.37 | stable (superseded) | Probe-verified index freshness (hourly full re-walks → at most daily); docker-compose builds from GitHub tag with correct names/volume |
| v1.6.38 | stable (superseded) | Stale-offset play defense (identity travels with every offset play; relocate-or-409); Roon-style volume sheets on mini bar + now-playing |
| v1.6.39 | stable (superseded) | Album view track rows: two-line queue-style layout, full artist credits (no more 35%-column clipping) |
| v1.6.40 | stable (superseded) | Per-artist links on multi-artist albums (library-validated split); artist bios via the validated Qobuz/Tidal/Wikipedia pipeline; Qobuz browser bio surfaced |
| v1.6.41 | stable (superseded) | Artist bio header restyled to the LMS reference (large centred portrait, centred Show more/source) |
| v1.6.42 | stable (superseded) | Observability: debug default in Docker (RRA_DEBUG=0 quiets), ISO-timestamped logs, Roon browse/load/image traces with durations, always-on failure + pairing logs, [http] request traces |
| v1.6.43 | stable (superseded) | Roon-style rotating log files on the data volume (8 MB current → .01–.10, size-based retention, ~88 MB cap) |
| v1.6.44 | stable (superseded) | Self-attributing Roon call traces (session key + request shape + ms on :res/failure lines); EA 1674 investigation: pooling verified healthy, slow calls were Core import congestion |
| v1.6.45 | stable (superseded) | Genre/wall screens open at the top (community fix, @markmcclusky PR #67) wrapped in a versioned build |
| v1.6.46 | superseded | Automatic library-sync awareness (deferred rebuilds while Roon imports) — replaced by v1.6.47's snapshot model |
| v1.6.47 | stable (superseded) | Snapshot library model: scan once, re-check every 12h or on manual Rescan, never during import; live-name playback fallback; side-menu Rescan button |
| v1.6.48 | stable (superseded) | Fixed the live-name play fallback (zone-scoped search + fuller matching) so stale-offset albums open/play reliably |
| v1.6.49 | stable (superseded) | Play fallback rebuilt on Roon's dedicated search hierarchy (v1.6.48's resolved 0/12 in production); Discogs logo 429 cooldown+abort; FanArt 404 log demotion; wall-display idle wake-check 60s + trace-silenced |
| v1.6.50 | stable (superseded) | Home Library carousel + full A-Z scrolling wall (paged from the snapshot index, zero Core calls); persistent thumbnail store on the data volume prewarmed during every sync (atomic writes, write-through, prune); 8-angle review fixes |
| v1.6.51 | stable (superseded) | Library panel styling: warm library-brown tint + books watermark, joining the Home tinted-panel system in both themes |
| v1.6.52 | stable (superseded) | Fixed albums going untappable after Back from an artist view — screens are restored by moving live nodes, never via an innerHTML string (pre-flight step 4 added) |
| v1.6.53 | stable (superseded) | Per-artist links on unspaced-slash credits (evidence-gated, AC/DC safe); "local files" badge from the /music scan |
| v1.6.54 | stable (superseded) | Qobuz + TIDAL source badges from the services' own favourites |
| v1.6.55 | stable (superseded) | Badge review pass: closed three wrong-badge paths (empty-normalising titles, dual-service albums, duplicate library identities), badges cleared on disconnect, Qobuz favourites paged, per-artist identity matching + "&"/"and"/edition tolerance, badges on every screen |
| v1.6.56 | stable (superseded) | Eradicated substring artist matching across 13 call sites ("Also appears on" listing the wrong artists); 5 self-inflicted regressions caught by review and fixed in the same version |
| v1.6.57 | stable (superseded) | Library Sort + Focus (album/artist/year/plays/last played/random; decade, source, listening facets) computed from the snapshot — zero Core calls; first test suite (111 tests, zero new dependencies) |
| v1.6.58 | stable (superseded) | Sort/Focus sheets no longer opened underneath the now-playing bar — a stacking-order bug (backdrop z-index 60 vs the transport's 70), not a layout one; first hit-test-based DOM regression test |
| v1.6.59 | superseded (stayed pre-release) | Decade focus finally has data: release years harvested from the Qobuz/TIDAL favourites and file tags already being fetched, joined via srcKeys, with source precedence so file tags beat service reissue dates; Library sorting reduced to one ARC-style arrow; `dir` means the same thing for every sort; 188 tests — README points here |
| v1.6.60 | stable (superseded) | Per-artist artist links on the Now playing screen, sharing the album view's renderer and library-validated split; names the library can't open render as plain text because line2 is the TRACK artist; 215 tests — README points here |
| v1.6.61 | superseded | Home screen flattened to Roon's layout — tinted panels + watermarks out, bold title over a hairline, carousels bleeding to the edge; CSS integrity pre-flight added after an unterminated comment silently ate a rule |
| v1.6.62 | superseded | Album view + Queue flattened to match; queue rows edge-to-edge with a full-bleed now-playing block; the tinted-panel system and every watermark now gone from the app |
| v1.6.63 | superseded | Two new themes from the docs-site palette (Copper dark, Brass light) as `data-palette` alongside the untouched originals; Settings theme picker with Apply; `--on-accent`/`--accent-text` tokens; fixed 28 dead showToast() calls in Settings |
| v1.7.0  | stable (superseded) | Version jump for the UI overhaul (v1.6.61–63): flat interface throughout, four themes, contrast machine-checked in the suite; 291 tests |
| v1.7.1–v1.7.44 | superseded | Zone grouping + device power, Roon playlists (read-only), smart playlists, genre/decade/source Focus facets, Smart Picks, playlist import/export, UI passes |
| v1.7.45 | superseded | Playback no longer stops at the end of an album |
| v1.7.46–v1.7.47 | superseded | Playlist import resolves against a new track-level index (edition twins, compilations); a partial answer from Roon could destroy an album's track record |
| v1.7.48–v1.7.50 | superseded | Labels and Smart Picks opt-in; Settings → Home Screen (per-carousel toggle + drag reorder); Recently played row; search behind a magnifier; Library text filter |
| v1.7.51–v1.7.53 | superseded | Labels off genuinely stops label scanning; Library control row matches Roon's |
| v1.7.54–v1.7.56 | superseded | Automatic rescan repaired end to end: recheck budget could never refill, failed rebuilds reported success, "finished" meant only "not still adding"; periodic check 12h → 10 min; change probe compared against the filtered count |
| v1.7.57–v1.7.58 | superseded | Library-change messages say why, what next, and the manual Rescan; each quotes the clock it actually waits on |
| v1.7.59 | stable (superseded) | A switched-off feature no longer leaves its Home row or its playlists behind |
| v1.7.60 | superseded (caused the iOS regression) | PWA icon set from the MusicD duck — and three legacy Apple metas that stopped the app filling the display |
| v1.7.61–v1.7.64 | superseded | Four attempts at the iOS band, three from a false premise; v1.7.62's `height:100%` on full-bleed panels and v1.7.63's toast insets are the parts worth keeping |
| v1.7.65 | stable | Head reduced to v1.6.50's plus four inert icon lines; head allowlist test |
| v1.7.66 | stable (superseded) | The iOS full-screen contract pinned: pre-flight step 6, head allowlist, shell rules checked against v1.6.50 |
| v1.7.67 | superseded | Volume popover row alignment — the 0/100 scale made the wrapper taller than the slider, so `align-items: center` sat every sibling 8px low |
| v1.7.68 | superseded (three defects of its own) | Volume jump-back and progress-bar jerk: writes held until the server echoes, position moved to base + elapsed wall-clock painted at 250ms, poll reconciles instead of snapping |
| v1.7.69 | stable (superseded) | The nine defects an 8-angle review found in v1.7.68: a `transition: width .4s` fighting the 250ms painter, paused time counted as playback, track changes suppressed by the seek hold, the volume hold following you between zones, a hung request wedging volume for the session |
| v1.7.70 | stable (superseded) | Wall-display YouTube clips removed outright — matching a track to the right video was too unreliable to keep, so strict matching meant no video and loose matching meant the wrong one. Server lookup, scorer, cache, IFrame player, Video chip, video-first mode and the API key setting all gone (275 lines out); README and docs-site copy stripped to match; 701 unit / 352 DOM / 70 static — README points here |
| v1.7.71–v1.7.72 | withdrawn | Releases and tags deleted. The album-header and Roon Radio UI work first written for v1.7.71 shipped in v1.7.73 instead; the dial v1.7.72 added was removed from the tree entirely, along with the `relative_step` volume mode that existed only to serve it |
| v1.7.73 | stable (superseded) | Both radios moved into Settings → Playback and made genuinely exclusive server-side — but the switches never showed it (see v1.7.74); album view header reworked |
| v1.7.74 | superseded (release removed) | The exclusivity rule made visible: v1.7.73 read the switches back from a zone cache that only refreshes on a Roon push, so a read issued straight after a write reported the state from before it. Both write routes now report BOTH radios after the Core acks, and the client paints both switches from that one answer. Same root cause fixed three more defects — the kickstart that never started, Roon Radio switched on from Roon's own apps, and the Roon settings panel bypassing the rule; the toast removed. Its release and tag were deleted once v1.7.75 replaced it days later — the CODE is in the tree and v1.7.75 builds straight on it, unlike the withdrawn v1.7.71–72 |
| v1.7.75 | superseded (release removed) | The same two switches, made to REACT: v1.7.74 was written as though the Core answered instantly. The untouched switch now moves on the tap instead of a Core round trip later (both read ON in between — the state the rule prevents, on display); writes are serialised latest-wins with a generation stamp, so two quick taps no longer settle on the tap before last; writes are bounded at 5s, or the new serialisation would let a dropped Core wedge both switches for the life of the page; and the switches follow the zone selector, which they never did. Class of error: a correct state machine with no model of time. Its release and tag were deleted once v1.7.76 replaced it — like v1.7.74, the CODE is in the tree and v1.7.76 builds straight on it, unlike the withdrawn v1.7.71–72 |
| v1.7.76 | superseded (release removed) | The Home "Library" row made the head of the wall its own header opens: it read the same endpoint with NO sort at all, so it always showed the server's default while the wall showed what the user chose. Fixing the request was half of it — the row's freshness flag was a boolean ("it has tiles, never load it again"), so a sort chosen later would still never have reached Home for the rest of the session; it now records WHICH order the row holds. The saved Home copy is likewise only reused when it was written in the order that is current, or a cold open flashed the previous sort. Focus is deliberately NOT mirrored — it could empty a shelf labelled "Library" from a setting made on another screen. Its release and tag were deleted once v1.7.80 replaced it — the CODE is in the tree, as with v1.7.74 and v1.7.75 |
| v1.7.77–v1.7.79 | superseded (folded into the v1.7.80 release) | The queue's "played earlier" fold-out. Roon's queue subscription reports only the current track and what is coming, and there is no queue-history call and no queue-write verb at all — so the record is built from the zone push already being handled, at no extra Core cost, and tapping a row adds it AFTER the current track rather than rewinding (a rebuild is ~8 Core round trips per track behind a play_now that destroys the live queue first). Then multi-select in pick order, and a resolution fix: played tracks were looked up in the track index, which only knows albums opened in this app, so anything played from Roon's own apps reported "not in your library" — the album name is tried first now. Never separately tagged; these three shipped together in v1.7.80 |
| v1.7.80 | stable (superseded) | The selection controls pinned to the top of the queue while the played list scrolls under them — below the panel's floating Home/Share buttons, not at top:0, which parks the bar underneath them permanently; the disclosure and action rows became one element so two sticky rows never have to know each other's height. Class of error: a control that leaves the screen exactly when it is being used. 793 unit / 408 DOM / 71 static — README points here |
| v1.7.81 | superseded | The UI pass: one grid size on every album wall (the random wall stopped shrinking its art to fit a screenful), a grid/list view toggle, the album cover in the mini transport, and the transport floated as a glass pill |
| v1.7.82 | superseded | The five things v1.7.81 got wrong on a real screen. The list view was never a row — `.album` is `flex-direction: column` and the list rule set `display: flex` without saying `row`, so the axis never changed. My test asserted a PROXY ("a row is wider than it is tall"), which a stacked full-width block also satisfies; it measures the cover ending before the text begins now. Also: the view control to the top-right corner, the wall's last row out from under the pill, and the home-indicator inset that was being applied twice — once as a `bottom` lift and again as `padding-bottom` in a later `.mini-transport` block 800 lines down |
| v1.7.83 | superseded | The pill a fifth taller (62→74px) with the extra height going to ARTWORK, not padding — the bar is sized by its cover so "taller" means "bigger cover". And the progress line made to follow the pill's curve: it was a 2px strip carrying `border-radius: 18px 18px 0 0`, a radius that never existed, because CSS scales every corner down until the two on a side fit that side's length. Drawn as the top border of a pill-shaped box now. Class of error: a declaration quietly rewritten by layout |
| v1.7.84 | superseded | Both detail screens lead with the artwork — full-bleed cover dissolving into the page ground, title underneath. The fade is a MASK, not an overlaid gradient, so it fades to whatever `--bg-elev` is for the palette. Text is never laid over the art: the design this copies can do that because its ground is always dark, and two of the four palettes here are near-white ground with near-black text |
| v1.7.85 | stable (superseded) | The transport given ONE appearance, permanently. Two builds tried to make a conditional backdrop-filter invisible; both were reported. The reason: `saturate()` does not only soften the backdrop, it BRIGHTENS it — whatever fraction of the page shows through is vivid with the filter on and muted with it off, so the bar changed face on every scroll no matter how opaque its background was. No conditional filter is invisible and an unconditional one is the v1.6.15 jank, so the pill has NO backdrop-filter: translucent and nothing else. 793 unit / 450 DOM / 73 static — README points here |
| v1.7.86 | superseded | One material for every piece of app chrome: both volume sheets and the top bar joined the transport pill's surface. The top bar's blur turned out to be doing nothing — `.topbar` is a flex SIBLING of `<main>`, so only the flat page was ever behind it and `saturate+blur` of a flat colour returns the colour it started with; `--bg-translucent` went with it. The iOS status bar can't be made translucent (that meta is the banned one), so it was given the bar's exact colour instead, which removes the seam |
| v1.7.87 | superseded | One ground on every screen: page, top bar and the full-screen panels were three tones. The DARK palettes came UP to the bar (#1d2125, #2d3134) and the whole elevation ladder moved with them — the old `--bg-elev` is darker than the new ground, so lifting the page alone would have turned every card into a recess. The light palettes went the other way on headroom: their bar was already #fffffe. Raising a background without raising what sits on it is what the contrast floors are for, and they caught it — five failures across the two dark palettes |
| v1.7.88 | superseded | The top bar made genuinely see-through: it overlays the scroller now, so album art passes under it. The bar is the GROUND WITH ALPHA, not a lighter translucent surface — over an unscrolled page that composites to exactly `--bg` (no seam) while still tinting with whatever scrolls behind. Its height is measured into `--topbar-h` rather than guessed; the banner and update toast moved inside `<main>` so the shell has one in-flow child |
| v1.7.89 | stable (superseded) | The pill and volume sheets joined the bar's `--bg-veil` (`--glass-bg` had no users left and is gone); a transient 503 while pairing no longer leaves a music note forever; the share card rebuilt as a pane over the softened cover, its release line solved against a white sleeve. **Also the version where a stale PWA was mistaken for a regression** — see the diagnosis rule above, added because of it. 793 unit / 472 DOM / 78 static — README points here |
| v1.7.90 | superseded | The waveform, off by default: the shape of the track under the Now-playing seek bar and on the wall display's strip. Local files only and that cannot be engineered away — a Roon extension is given metadata and control, never audio, so Qobuz and TIDAL keep the plain bar. Peaks resampled BY MAXIMUM (averaging is what flattens the one thing a waveform is for), stored per track on the data volume, and the next queue item decoded while the current one plays. Also the version that taught the harness to read pixels (`lib/png.js`, zlib only) — and the one where an assertion comparing a driver-time rect against a screenshot pixel reported an 8.5px misalignment that did not exist, and a fix for it was written and reverted |
| v1.7.91 | superseded | The seek bar's own 4px track was drawn straight through the waveform, reported from a phone on the day. The stylesheet had said `--seek-fill: transparent` since v1.7.90 and it never applied: `paintSeek()` writes that property INLINE four times a second, and an inline custom property beats a stylesheet rule however specific — the comment beside the CSS had the precedence exactly backwards. Both halves are needed and a mutation test pins each. Tested by continuity, not position: over a silent stretch the canvas can only draw 2px dashes, so an unbroken run is the line and nothing else |
| v1.8.0  | stable (superseded) | Version jump for the waveform. Same code as v1.7.91, renumbered, with README and the docs site moved to v1.8.0 in the SAME commit — Waveform first in both feature lists, marked New on the site. 820 unit / 513 DOM / 81 static |
| v1.8.1–v1.8.9 | superseded | Streaming waveforms begun. Proved Roon states no playback source (a purpose-built dump; six or seven keys, none naming a service), so an album's presence in a favourites list is the only signal there is. Title-only album matching, the Qobuz signature, and the two calls that went to a URL with a doubled slash |
| v1.8.10–v1.8.18 | superseded | **Six versions spent on one wrong question.** A Qobuz signature needs an app_id, THAT app's secret, and a token minted BY that app; this extension's username/password login mints under an app whose secret it does not have, so no arrangement of what it already held could ever sign. Each version rearranged the same insufficient set. Also the two diagnostics that finally ended it — the response BODY, which is the only thing separating a rejected signature from a rejected token, and a probe endpoint that tests combinations without a release |
| v1.8.19 | superseded | The way out: sign in on Qobuz's own page. The redirect flow mints a token under the app whose secret ships, so the three parts agree by construction. Redirect address taken from the request, so it works unchanged in Docker and from a phone |
| v1.8.20 | superseded | One Qobuz sign-in for everything — the browser token reads the catalogue AND signs, so the password login went. Plus TIDAL waveforms, which needed no new credentials at all: the device sign-in already present carries a Bearer token, refreshes itself, and TIDAL signs nothing |
| v1.8.21 | superseded | The track ahead drawn in the text colour rather than a hairline, and 195 bars where 130 were drawn from 1000 stored values |
| v1.8.22 | stable (superseded) | The decode moved 8 kHz → 16 kHz. 8 kHz made ffmpeg lowpass at 4 kHz first, so cymbals and snare cracks were filtered away before they could register — a systematic under-read of 16/255 mean, up to 52/255, measured against the bars actually drawn. Close to free: 44.1 kHz (5× the PCM) measured the same wall clock. A rate change now clears every stored waveform, because a library holding both would draw two kinds of picture with nothing to say which is which. 975 unit / 513 DOM / 87 static — README points here |
| v1.8.23 | stable (superseded) | The install builder carries the Discogs and FanArt.tv keys (`RRA_DISCOGS_KEY` / `RRA_FANART_KEY`, emitted into a `.env` rather than inline with `-e`); multiple music folders and a time zone in the same builder. Never promoted — the README went straight from v1.8.22 to v1.8.24 |
| v1.8.24 | stable (superseded) | The waveform made true. A bar was the loudest SAMPLE in its slice, and a limiter puts something on the ceiling in nearly any window — so every bar was the same height and the control said almost nothing. A bar is an RMS level now, folded by RMS (which IS the RMS of the whole span, so a bar built from twenty stored values equals one analysed straight into that many; measuring a level and keeping the loudest is the same brick one layer down). `-ac 1` was AVERAGING the channels, not taking the louder, so an out-of-phase passage came back RMS 0 against the pair's 2896 — both channels now, at 44.1 kHz rather than 16, which is free because nearly every file already is 44.1. A truncated decode is refused rather than stretched across the whole bar with the playhead over the wrong music. And the shape is inset to the thumb's TRAVEL: a range input cannot let its thumb hang off either end, so bars laid across the whole canvas ran up to 7px out — ahead at the start, behind at the end, **zero in the middle**, which is why it survived being looked at. 4000 stored values, one bar per device pixel, heights unrounded, canvases 34→64 and 40→72. The whole analysis (statistic:rate:channels) is stamped beside the table, so two generations can never mix. 996 unit / 526 DOM / 87 static — README points here |
| v1.8.25 | superseded | The volume − and + drawn rather than typed. Flex centres the LINE BOX and a line box is not the glyph — both marks are drawn on the maths axis with descender space hanging below, so the box was centred perfectly while the ink was not, and no `align-items` could have moved it. Two `<line>`s in a symmetric viewBox now, so “bolder” is a number this app chooses rather than a hint the font may ignore (the minus drew a 1.3px stem at any weight). Both measurements taken out of ONE screenshot |
| v1.8.26 | superseded | Back from an artist view lands where you were. `showArtistAlbums()` read `main.scrollTop` into the snapshot AFTER draining the grid, by which point `<main>` had collapsed from ~3800px to a few hundred and the scroller had clamped its own scrollTop to 0 — so the snapshot stored 0 every time and the restore honoured it faithfully. The comment under the restore had promised this since v1.6.52 and never could. Class of error: an ordering bug twenty lines from the code that looks wrong |
| v1.8.27 | superseded | Settings became a two-column grid of icon-over-title cards, groundwork for the Share Card pages. `minmax(0, 1fr)` and not `1fr`, because a grid track's default minimum is its CONTENT and today's titles all fit — so a plain `1fr` passes every measurement you would think to take, and the test sets an unbreakable title to catch the 32px overflow. The assertion that earns its keep: every tile's `data-pane` matches a panel and every panel has a tile |
| v1.8.28 | superseded | First half of the MusicD Share Card port — service and review chips under the card, both lists built from the server's own table. `lib/share-links.js` is pure and every rule in it is an assertion: a space is `%20` and never `+` (four of these take the query as a PATH segment), a slash is spent as a space (Qobuz decodes `%2F` back into a segment and 404s), only the first credited act (a four-name credit searched for all four, and AllMusic said so), and the separator set is the Share Card app's verbatim — NOT a comma or an ampersand, because my first attempt turned Hall & Oates into Hall |
| v1.8.29 | superseded | The progress-bar sawtooth against a stuck zone feed: the position is base + elapsed wall clock, the poll re-baselines when the two disagree by >3s, so a `seek_position` that stops advancing yanks a running clock back every ~4s forever. Reproduced as `1 2 3 4 0 1 2 3 4 0` before anything changed. The reconcile now needs a value that has MOVED. **A robustness fix and not the root cause** — nothing in v1.8.24–28 touches the position path, and why that Core stalled is still unexplained. Three fixtures, because distrusting the server passes the stuck case and breaks an external seek from Roon's own app |
| v1.8.30 | superseded | Two real holes in the waveform pipeline — and **the report that prompted it was explained by neither**, which the entry says outright rather than claiming a win. `ffmpeg-static` exports a path whether or not its postinstall ever downloaded the binary, so every decode spawned a file that does not exist and resolved null for the life of the container, silently; and index files written before v1.7.90's `dirs` map load cleanly with no directories and never scheduled the rebuild the comment beside them promised. Plus `GET /api/debug/waveform`, which reports every step of the chain — five distinct failures had one answer between them |
| v1.8.31 | superseded | The share card draws what it was already fetching. `open()` had been calling `/api/album/extras`, trimming the description to ten sentences and handing it all to `ShareCard.render()`, which read five fields and dropped the rest; the score and the Best New Music flag were never read at all. Nobody noticed because a card with no description looks exactly like a card for a record that has none. The score sits on its OWN OPAQUE GROUND because it is the one element drawn over album art — everything else on the card is solved against a worst-case white sleeve, and a badge over artwork has no known surface under it |
| v1.8.32 | superseded | A Pitchfork-reviewed album showed no words at all: `fetchAlbumBios` picks one winner and the Pitchfork branch set `description: null` to honour the UK-law rule about THEIR prose — while the Wikipedia article fetched in the same `Promise.all` sat unused two lines away. The rule is about their writing, not about the album having none. Which made attribution real: `source` says where the LINK goes, so a second field `description_source` says whose words are on screen, or Wikipedia's writing under “Read the full review on Pitchfork” would be the same misattribution pointing the other way. Also Settings → Share Card, one tile instead of two |
| v1.8.33 | superseded | The review chips were invisible on the light palettes. The variant was `background: transparent`, and the lesson is not that transparent was too subtle — **a variant defined by REMOVING the thing that gives an element its edges has no floor**: how visible it stays depends entirely on how far apart two theme tokens happen to be, which is a different answer per palette. The chip test runs all four now. Also space between the Share Card toggle rows, which were five switches merged into one column of colour |
| v1.8.34 | superseded | A self-titled album matched every other record by the same act — Airbourne's 2026 album carried the article for *Runnin' Wild*. The title rule was applied to the WHOLE Wikipedia page title, disambiguator included, and for a self-titled record the album name IS the act's name, so the parenthetical that exists to tell their albums apart matched all of them. `lib/wiki-match.js` reads only the part before it. Also “If you like this”, ported from `Similar.kt` — Deezer only, because the original's ListenBrainz path has its own note reading “this has never once answered in the field” and porting it would be porting the appearance of a feature. And a generation-stamp bug of my own, found by a test: stamped where the fetch was ISSUED, so two opens finishing out of order gave the later stamp to the earlier record |
| v1.8.35 | superseded | A suggestion is somewhere to go: in the Roon library it queues, and otherwise it opens the default service — and which one is **visible before it is tapped**, because “this adds to your queue” and “this leaves the app” must not look the same. The queue sends the LIBRARY's title and artist, never Deezer's, because `/api/play` relocates a drifted offset rather than playing whatever now sits at it and that guarantee is worth nothing without an identity to check against. A default service is settable by holding a chip (the Share Card app's gesture) or in Settings, per device, falling back to the first service switched ON rather than a hardcoded name. Plus: `normalize()` reduces every run of non-alphanumerics to one space, so **every apostrophe in the library was a missed match** — and a missed match sends a record you already own out to a streaming service |
| v1.8.36 | stable (superseded) | The Qobuz link opens the Qobuz APP. Not a badly chosen search URL — no search URL anywhere can do better: `open.qobuz.com` is claimed on both platforms by Qobuz's own `assetlinks.json` / `apple-app-site-association`, and its router understands exactly five shapes, every one of them an ID. There is no search route on that host or in the app behind it, and `play.qobuz.com` is the same app. So the id is the whole feature, read off Qobuz's own public search page the way this app already reads pitchfork.com. **A wrong album is worse than a search page** — Qobuz answers a query it cannot place with its nearest guess rather than with nothing — so an exact album-then-artist slug wins wherever it appears (a search for *Mezzanine* returns the remixes album, which often sorts above the record), a slug starting with the album and mentioning the artist is the fallback, and anything else is declined. Upgraded AFTER the row is drawn and never awaited, so a failure leaves the search link that was already there. 1004 unit / 571 DOM / 93 static — README points here |
| v1.8.37 | superseded | **Discover** — new records by the acts you play, the one question the app could not answer (Smart Picks is lateral, the Pitchfork and service screens are editorial). Seeded from the PLAYS table rather than the library: what you own includes the box set bought for one disc, what you replay is the claim the row makes. Ranked by distinct DAYS played, because forty plays in one night is an evening and eight plays on eight days is a habit. Deezer's listing carries the date of the EDITION and no original-release field, so most of the work is refusing a remaster: a re-release needs TWO signals (the title names an edition AND the act has an older record reducing to the same base title), and either alone is wrong in a way that shows — on the first, the deluxe pressing of last week's record is thrown away for its name; on the second, Sault's two 2020 albums are called editions of each other. An 8-angle review found six defects in the new code before it shipped, four invisible from the screen |
| v1.8.38 | superseded | The cover sat ON the track list at desktop widths, covering the numbers of every row inside its own height and the start of the TRACKS heading ("ACKS"). **A media query adds no specificity**: v1.7.84's hero is `.modal:not(.np-mode) .modal-art` (three classes) and the two-column block was plain `.modal-art` (one), so being later in the file bought it nothing and `margin: 0 -18px` won at every width. Art right edge 551, track column left 533 — eighteen pixels, at every desktop width, and only the rows level with the art lost their numbers, which is the asymmetry that identifies the cover as the cause |
| v1.8.39 | superseded | Discover's rows carry album art. An omission rather than a regression — the share card's row builder carries none by an older decision about a compact list in a sheet, and a full screen of records is the opposite case. Roon's own art wins wherever there is any (the same picture the album wears everywhere else); the tile is always drawn and the IMAGE is what is optional, because an `<img>` with a dead src draws the browser's broken-image glyph, which reads as "this app is broken" rather than "this record has no cover" |
| v1.8.40 | superseded | Phone landscape unblocked — a full-viewport `position: fixed` layer said "please rotate your device". It was hiding a layout that works: measured at 844x390, the shell, bar, wall and transport all lay out and Now playing is the two-column layout v1.6.14 built for that shape. Removing it was stated at the time as removing the only CANDIDATE for the rotation freeze rather than a proven cause — and the freeze survived it, which is what made the real cause findable. Also: Discover albums-only got a track-count floor, and `GET /api/debug/discover` was added because two rounds of the feature had turned on a Deezer field nobody had looked at |
| v1.8.41 | superseded | **A day's list is stamped with the rules that built it.** Found from a user's own pasted `/api/discover` response. A day is persisted and "have we built today" was the only question asked before reusing it, so shipping a change to WHAT COUNTS as a release had no effect until tomorrow — and nobody could tell from outside whether the screen in front of them came from the new rules or the old. Same answer as the waveform's analysis stamp in v1.8.24: record the rules next to the data, and a day built under different ones counts as not built. Also corrected the Deezer CDN host against that same real data — the guessed path shape was right and the host was wrong, which cost nothing because the guess sat last, behind four named fields |
| v1.8.42 | superseded (wrong cause) | The second theory about the rotation freeze, and also wrong: `maximum-scale=1`, `user-scalable=no`, and preventDefault on the pinch gestures. The reasoning was not worthless — blocking pinch really does remove the only way a person recovers a mis-scaled page — but the instrument later proved `scale=1` throughout, so the page was never mis-scaled. The removals stand on their own merits (double-tap zoom was already off the correct way, `touch-action: manipulation`), and the head guardrail caught the viewport change and was updated deliberately rather than around |
| v1.8.43–v1.8.44 | superseded | **The instrument**, after two fixes built on mechanisms no assertion here can observe. `public/tapdebug.js`, off by default: a readout needing no interaction (when the bug is present there is none to be had) showing the viewport numbers, a per-rotation sample at 0/300/1000ms, and for every tap where it landed, what `elementFromPoint` says was on top, and whether a click ever followed. Each reading named a different culprit. It was `pointer-events: none` with a test that failed if that changed — a fixed full-width element at the top of the screen is the exact shape of the thing being hunted, and one that could eat a press would be indistinguishable from it |
| v1.8.45 | stable (superseded) | **The freeze: the window was scrolled, not the buttons dead.** `scrollXY 0,62` — hit-testing ran 62px below the paint, so a press on Back at (35,31) was tested at (35,93) and landed on the album artwork. Every control on every screen misses by the same amount at the same moment, which is why it read as "nothing works". It also explains the two things no theory covered: force-quitting being the only cure (a relaunch resets the scroll) and Safari/Chrome being fine (62px is the top safe-area inset, and only a standalone app has live insets). The fix enforces an invariant the app already declares — html/body are `overflow: hidden` and only `<main>` scrolls — with one exception, a focused text field, because iOS scrolls there on purpose to lift an input clear of the keyboard |
| v1.8.46 | superseded | The instrument made to measure the FIX and not just the fault: which build is running, whether the pin fired and whether the number MOVED when it did, and whether anything overflows. v1.8.45 had shipped a reset whose effect nothing could report, and "tried and failed" and "never tried" need opposite next steps |
| v1.8.47 | stable (superseded) | Home opened one safe-area inset too far down after rotating. A one-word bug: `--topbar-h` is published from `getBoundingClientRect().height`, which INCLUDES padding, and the inset lives in the bar's padding — while the `ResizeObserver` used default options, which watch the CONTENT box. The inset is not in it, so the bar's real height could move without the observer firing. Behind it, a second gap: the `resize`/`orientationchange` listeners existed only in the `else` branch for browsers without ResizeObserver, so on every modern browser a rotation notified nothing at all. Introduced by the landscape work — before v1.8.40 nothing ever changed an inset while the app was open |
| v1.8.48–v1.8.49 | superseded | The instrument removed once the question was settled, and then the last of its scaffolding (`version` on `/api/status`) at the user's call. The fixes it found stay |
| v1.8.50 | stable (superseded) | The album view's last content sat under the now-playing pill in landscape. **A shorthand ate the reserve**: `.modal-body` reserves `106px + inset` at the bottom so content can scroll clear of the floating pill, and the two-column rule for ≥720px writes `padding: 28px` — a shorthand, so it resets the bottom too — with nothing putting it back. Measured at 844x390: the panel runs to y=374 and the pill's top is at y=308, so its last 66px were underneath while the body reserved 28. Not only landscape either: the mutation strands 37px at 1400x900, because a centred dialog reaches its max-height on any album with enough tracks. 1096 unit / 605 DOM / 101 static — README points here |
| v1.8.51 | superseded | Qobuz waveforms: the favourites read was gated on `qobuzToken \|\| (qobuzUsername && qobuzPasswordMd5)` — the PASSWORD login, which v1.8.20 removed. On any install connected the only way the app still offers (the browser sign-in, `qobuzWaveToken`) that gate was false for ever: no favourites, no album ids, and every Qobuz track declining with "no Qobuz album id". Reconnecting could not clear it — the sign-in handler's own refresh hit the same gate. The same predicate was spelled out in `claimingServices()` (so Qobuz never counted as claiming an album, and a Qobuz-only install called every fileless album local) and `fetchServiceArtistBio()`. All three call `qobuzReady()` now. Class of error: a partial migration, NAMED AND THEN LEFT — `qobuzReady()` carried a comment saying the pre-existing gates had drifted, and they stayed drifted because nothing failed. `test/static/qobuz-gates.test.js` is what fails now. Same drift found one service over (`claimingServices()` asked TIDAL for a refresh token but not the user id). 1110 unit / 605 DOM / 106 static |
| v1.8.52 | superseded | `album/get` named no track limit, so the list came back at Qobuz's default page size and the matcher reported the tail as `no track called "X"` — a title mismatch, which it is not. Box sets and multi-disc reissues drew their first tracks and lost the rest. Paged on `tracks.total` now. Streaming decode failures gained `WFD.lastDecodeError()`, which the local path has carried since v1.8.30. `GET /api/debug/waveform?deep=1` added: it resolves the id, reads the album, runs the match and requests the file url, then stops before any audio — and runs the REAL code, because `wfQobuzResolveAudio()` was split out of `wfQobuzCompute()` so probe and player share one body |
| v1.8.53 | superseded | An exact identity lookup fails identically whether a record is absent or spelled differently, and every caller reported the confident one. `lib/keymatch.js` reports what the index holds NEAR a miss, so "genuinely absent" is only said when nothing resembles it. Same correction for the local dead end, which had asserted "it is a streamed track" with no evidence. Also: the two sides of the key space ran different title rules — `albumKeys()` strips edition markers, `addFavouriteKeys` never did, so a service title with the edition baked in was unreachable from Roon's clean one. Both call `favouriteTitleForms()` now, and the invariant `addQobuzAlbumId` has always claimed (keyed exactly as `addFavouriteKeys`) is finally asserted |
| v1.8.54 | superseded | **An apostrophe.** Roon reports `Don't Panic` (U+0027); the tag carries `Don’t Panic` (U+2019), which is what nearly every tagger writes. `wfCanon` lowercased and collapsed whitespace and nothing else, so the two were unequal AND neither contained the other — the containment fallback missed too. Every track whose tag carries a typographic apostrophe, in any library, had no local waveform; accents failed the same way. The streaming path never had this, because `TM.canon` reduces punctuation. `wfCanon` IS `TM.canon` now. Also: same-titled files were a coin flip taken by `files.find()`, and now decline |
| v1.8.55 | superseded | Favourites were the only source of a streaming album id, so an album played from search could never have a waveform. The catalogue is searchable with the same token: `lib/albumsearch.js` takes an exact identity match and DECLINES on ambiguity, because Qobuz answers a query it cannot place with its nearest guess rather than with nothing. Being wrong is survivable anyway — the duration gate refuses a different pressing. Its premise (that the album had never been favourited) turned out to be an inference from a truncated list; see v1.8.56 |
| v1.8.56 | **Latest (stable)** | **The Qobuz favourites read stopped at ten thousand albums.** `PAGE = 500, MAX_PAGES = 20`. Past it the loop ended: no error, no log line, and a message that looked like a complete read. Everything sorting after the ten-thousandth favourite was invisible to the whole extension — no badge, no album id, no waveform — deterministically and for ever. Found by the USER'S ARGUMENT, not by any number: "as this is a Roon extension then the only way the album would show via browse is if it is a favourite within my Qobuz account". Roon was playing it, so it WAS a favourite, so the read was at fault. Their library is 12,963. TIDAL had the same defect and worse — one call, `limit: 5000`, no paging — with `totalNumberOfItems` sitting unread. Both page to exhaustion on the stated total now. The probe's own `favourite_albums_known` was the KEY count, always larger than the library, so no number on screen could have shown it; it reports albums read / albums stated / complete, and an incomplete read is the FIRST thing the verdict says, ahead of everything. 1177 unit / 605 DOM / 108 static — README points here |

