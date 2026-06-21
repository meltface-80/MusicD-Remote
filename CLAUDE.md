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

If step 3 cannot run (Roon not available), run steps 1 and 2 and explicitly note why 3 was skipped.

### Pre-flight checklist (tick each before every push)

- [ ] `node --check index.js` exits 0
- [ ] No `let x` declared after a bare `x = ...` assignment at module scope
- [ ] Every variable referenced matches its exact declaration name (no UPPER_SNAKE drift)
- [ ] Every new `catch (e) {}` is intentional — not swallowing a symptom
- [ ] Auth headers reference the live variable, not a deleted constant
- [ ] Any new HTML element ID matches the `getElementById` call in app.js exactly
- [ ] `package.json` version bumped
- [ ] CHANGELOG.md entry added

### Development rules

- **No incomplete implementations.** Write the full code. Never leave `// rest stays the same`.
- **No silent catch.** `catch (e) {}` must have a comment explaining why silence is safe.
- **Variable name freeze.** Once a variable is named, all references — declaration, assignment, template literals, log messages — use the identical name. Never mix camelCase and UPPER_SNAKE for the same value.
- **Declaration before use.** With `let`/`const` in Node.js, a bare assignment `x = val` on line N while `let x` is on line N+500 is a ReferenceError. Always declare at the first-use site.
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

## Repository

- Work directly on the **main branch** of `meltface-80/Roon-Random-Albums-Extension`.
- **Never use a feature branch.** Never create a pull request.
- The `old/` folder contains two permanent historical tarballs (v1.5.37 and v1.5.49). **Do not add to or remove from this folder.**

---

## Every build — required steps (in order)

1. Make code changes
2. Bump `package.json` version
3. Add a CHANGELOG.md entry (see format below)
4. Run pre-flight checks (see above)
5. Commit the changed files in a single commit: code + `package.json` + `CHANGELOG.md`
6. Push to main
7. Build the tarball and send it to the user (see below)

**Do not commit the tarball.** It is built locally and handed to the user directly.

---

## Building and delivering the tarball

After pushing, build the tarball locally and send it to the user with `SendUserFile`:

```bash
VERSION=$(node -p "require('./package.json').version")
TARBALL="/tmp/roon-random-albums-v${VERSION}-docker.tar.gz"
tar -czf "$TARBALL" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./old' \
  --exclude='./data' \
  .
```

Then call `SendUserFile` with the tarball path. The user will upload it to their cloud storage
and provide a share link. Once they provide the link, give the full docker install command
using that link (see template below).

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
- Current stable version in the README: **v1.5.49** (until the user says otherwise).

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

Once the user provides a share link for the tarball, give this command with the link and
version filled in:

```bash
sudo docker stop roon-random-albums
sudo docker rm roon-random-albums
sudo rm -f /opt/roon-random-albums/roon-random-albums-vPREVIOUS-docker.tar.gz
cd /opt/roon-random-albums
wget -O roon-random-albums-vNEW-docker.tar.gz "SHARE_LINK"
tar -xzf roon-random-albums-vNEW-docker.tar.gz
docker build -t roon-random-albums:NEW .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /mnt/dietpi_userdata/4tb/Music:/music:ro \
  roon-random-albums:NEW
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
| v1.5.49 | **Latest (stable)** | Discogs label logo fetches — README points here |
| v1.5.70 | superseded | Code review fixes: scan lockout, CDN redirect, auth guards |
| v1.5.71 | superseded | Label scan/logo pipeline fixes (8-angle code review) |
| v1.5.72 | current    | Label pipeline correctness, FanArt merge-redirect, Discogs retry fix |
