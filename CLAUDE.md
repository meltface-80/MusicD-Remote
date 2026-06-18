# CLAUDE.md — Development & Release Instructions

## Release Checklist (ALWAYS follow this order, every release)

### Step 1 — Make the changes
- Edit source files: `index.js`, `public/app.js`, `public/index.html`, `public/style.css`, `lib/`, etc.
- Bump the version in `package.json`
- Add a new section to `CHANGELOG.md` with the version, date (YYYY-MM-DD), and bullet-point changes

### Step 2 — Sanity check
- `git diff` — review every changed file; confirm nothing unexpected crept in
- Check `package.json` version matches the new CHANGELOG section header
- Ensure no stray `console.log` debug lines left in production paths (intentional diagnostic logs are OK)
- Verify all new API endpoints have error handling and correct HTTP status codes

### Step 3 — Build the tarball (MANDATORY — do not skip)
Run from the repo root:
```bash
tar -czf roon-random-albums-v{VERSION}-docker.tar.gz \
  --transform 's|^|roon-random-albums/|' \
  launcher.js \
  public/app.js public/style.css public/index.html public/sharecard.js \
  README.md LICENSE \
  docker-compose.yml Dockerfile \
  data/labels-override.json \
  index.js package.json \
  lib/radio.js lib/updater.js \
  CHANGELOG.md
```
Verify with `tar -tzf roon-random-albums-v{VERSION}-docker.tar.gz`.

### Step 4 — Update README.md (MANDATORY — do not skip)
- Replace ALL occurrences of the previous version number (grep first)
- If new features were added, update the feature description section

### Step 5 — Commit everything in one commit
Stage and commit: source files, CHANGELOG.md, README.md, package.json, AND the tarball — all together.
```bash
git add CHANGELOG.md README.md package.json index.js public/app.js public/index.html public/style.css roon-random-albums-v{VERSION}-docker.tar.gz
git commit -m "Release v{VERSION} — brief description"
git push origin main
```
If push is rejected (fetch first): `git fetch origin main && git rebase origin/main && git push origin main`

### Step 6 — Verify GitHub Release
The GitHub Actions workflow (`.github/workflows/*.yml`) auto-creates a GitHub Release from the tarball and CHANGELOG section. Confirm it appears after the push.

---

## Lessons Learned

### v1.5.22 (2026-06-18)
- **Undefined CSS variable = transparent background**: `var(--bg-page)` was used in `.stats-panel` but never defined in `:root` or `[data-theme]` blocks. CSS silently treats undefined variables as `transparent`. Always check that any CSS variable you write is actually defined — grep the file for the variable name before using it.

### v1.5.20 (2026-06-18)
- **Heart/love button removed in v1.5.21**: The Roon browse API didn't return a love/heart action item when navigating into albums via the `albums` hierarchy. The `getOrToggleAlbumLove()` function searched top-level items and nested `action_list` items but found nothing matching. Feature removed pending discovery of the correct browse path (check docker logs with the `/api/debug/album-items?offset=N` endpoint if re-implementing).
- **415 errors on bare POSTs**: `fetch(url, { method: "POST" })` with no body causes Express's `express.json()` middleware to return 415 Unsupported Media Type on some clients (notably iOS Safari). Fix: always include `headers: { "Content-Type": "application/json" }, body: "{}"` on action POSTs.
- **Tarball missing from release**: The release tarball must be built and committed to the repo IN THE SAME COMMIT as the code changes. The GitHub Actions workflow looks for `roon-random-albums-v{VERSION}-docker.tar.gz` in the repo root.
- **README not updated**: README version references (install command, docker tag, etc.) must be updated every release. Use `sed` or replace-all to catch all occurrences.

### v1.5.19 (2026-06-18)
- Stats are captured server-side via Roon zone subscription — no browser needed.
- SQLite `plays` and `album_meta` tables used for all stats storage.

### General Rules
- NEVER push code to main without the tarball in the same commit.
- NEVER push without updating the README version references.
- NEVER push without a CHANGELOG entry.
- Always test the golden path after changes: open album modal, play, search, settings.
