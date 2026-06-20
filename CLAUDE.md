# Claude Code — Project Rules for Roon Random Albums Extension

Read this file at the start of every session. These rules are permanent and override any
default behaviours. Do not deviate from them unless the user explicitly says so in that session.

---

## Repository

- Work directly on the **main branch** of `meltface-80/Roon-Random-Albums-Extension`.
- **Never use a feature branch.** Never create a pull request.

---

## Every build — required steps (in order)

1. Make code changes
2. Bump `package.json` version
3. Add a CHANGELOG.md entry (see format below)
4. Build the tarball: `tar -czf roon-random-albums-vX.Y.Z-docker.tar.gz --exclude='./.git' --exclude='./node_modules' --exclude='./*.tar.gz' --exclude='./data' .`
5. Commit **all four** in a single commit: code + `package.json` + `CHANGELOG.md` + tarball
6. Push to main

**Never push code without the tarball in the same commit.**

---

## GitHub releases — ALWAYS pre-release

The GitHub Actions workflow (`.github/workflows/release.yml`) creates a release on every
push. It is configured with `--prerelease`. **Do not remove that flag.**

- Every build goes out as a **pre-release**. GitHub will NOT mark it as latest.
- The user manually promotes a release to "latest" when satisfied with testing.
- **Never manually create a release or change the latest/pre-release status yourself.**

---

## README.md — frozen until told otherwise

- The README contains version references (install commands, tarball URLs, `docker build` tags).
- **Do not change any version number in README.md** unless the user explicitly says
  "promote to latest" or "update the README".
- Current stable version in the README: **v1.5.37** (until the user says otherwise).

---

## CHANGELOG.md format

Add a new section at the top, above the previous version:

```
## [X.Y.Z] — YYYY-MM-DD

### Added / Fixed / Changed
- Description of change
```

---

## After each build — give the user the full docker command

Always provide the full rebuild command with the new version, ready to copy-paste:

```bash
sudo docker stop roon-random-albums
sudo docker rm roon-random-albums
sudo rm -f /opt/roon-random-albums/roon-random-albums-vPREVIOUS-docker.tar.gz
cd /opt/roon-random-albums
wget https://raw.githubusercontent.com/meltface-80/Roon-Random-Albums-Extension/main/roon-random-albums-vNEW-docker.tar.gz
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
| v1.5.37 | **Latest (stable)** | README points here     |
| v1.5.38 | pre-release | File scanner layout fix          |
| v1.5.39 | pre-release | Rate limiting, MB timeout, misc  |
| v1.5.40 | pre-release | iTunes rate limiting, file cache |
| v1.5.41 | pre-release | Scan logging, 12h auto-rescan    |
| v1.5.42 | pre-release | Progress tracking, circuit breaker |
| v1.5.43 | pre-release | Progress bar >100% fix             |
| v1.5.44 | pre-release | Label name text tiles              |
| v1.5.45 | pre-release | Remove album-art fallback from label tiles |
| v1.5.46 | pre-release | Label text size by longest word not word count |
| v1.5.47 | pre-release | Consistent label text size via container query (8cqw) |
| v1.5.48 | pre-release | Label text size increased to 9cqw |
