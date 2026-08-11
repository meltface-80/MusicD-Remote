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
    version/examples, and this file's current-stable note + version-history table, as a
    docs-only commit on the freshly-restarted branch.
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
repo documentation (`README.md`, `CHANGELOG.md`, `CLAUDE.md`) is NOT a build. It skips the
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
- Current stable version in the README: **v1.7.60** (until the user says otherwise).
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
| v1.7.60 | superseded (caused the iOS regression; README still points here until promoted) | PWA icon set from the MusicD duck — and three legacy Apple metas that stopped the app filling the display |
| v1.7.61–v1.7.64 | superseded | Four attempts at the iOS band, three from a false premise; v1.7.62's `height:100%` on full-bleed panels and v1.7.63's toast insets are the parts worth keeping |
| v1.7.65 | stable | Head reduced to v1.6.50's plus four inert icon lines; head allowlist test |
| v1.7.66 | **Latest (stable)** | The iOS full-screen contract pinned: pre-flight step 6, head allowlist, shell rules checked against v1.6.50; 758 unit / 317 DOM / 69 static |
