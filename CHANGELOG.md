# Changelog

All notable changes to Roon Random Albums are documented here.

## [1.5.20] — 2026-06-18

### Fixed
- **Heart / love button** — relocated from the top-right corner of the modal
  to sit inline next to the artist name, so it's always visible alongside the
  album info rather than floating over the cover art.
- **Heart button persistence** — button stays visible when Roon's browse API
  hasn't returned a love state yet; it appears greyed/disabled rather than
  disappearing, making the loading state obvious.
- **Heart browse reliability** — the server now searches inside every nested
  action_list returned by Roon's album browse level (not just the top-level
  items), so the love action is found even when Roon places it inside a
  sub-group. All browse items are now logged unconditionally (docker logs will
  show the full structure for diagnosis if needed).
- **Debug endpoint** — added `GET /api/debug/album-items?offset=N` which dumps
  the raw browse items Roon returns when entering an album, making it easy to
  diagnose browse API structure issues without code changes.

## [1.5.19] — 2026-06-18

### Added
- **Listening statistics** — tap the bar-chart icon in the topbar to open your
  stats. Plays are captured server-side via the Roon zone subscription, so
  every track played from any zone (extension UI or Roon app) is recorded
  automatically, even with the browser closed.
  - **At a glance**: total plays, unique albums/artists, replay %, busiest
    day, peak listening hour
  - **Top 10 albums** — with cover art and play count
  - **Top 10 tracks** — by play count  
  - **Top artists** — percentage bar chart of listening share
  - **By decade** — breakdown of what era you listen to most
  - **By genre** — populated as the label scan enriches albums (iTunes returns
    genre alongside label data, stored in `album_meta` table)
  - **Time of day** — 24-hour sparkline showing listening patterns
  - **Day of week** — bar chart
  - Stats accumulate from this version onwards; no historical Roon data is
    imported. Genre/decade data fills in gradually as albums are label-scanned.

## [1.5.18] — 2026-06-18

### Added
- **Love / heart button** — a ♥ button appears in the album modal. Tapping it
  loves or unloves the album via Roon's browse API, reflected immediately in
  Roon's own UI and usable in Focus. The button is pink/filled when loved and
  hidden for albums that don't support it (e.g. not in your library).

## [1.5.17] — 2026-06-18

### Fixed
- **Transport bar persistence** — the mini bar was being hidden by two
  defensive `bar.classList.add("hidden")` calls: one when the zone selector
  was momentarily empty on page load (race with zone population), another on
  any API error. Both now return early without touching bar visibility. The
  bar is only hidden when Roon definitively reports nothing is playing for the
  selected zone, so it stays visible through network hiccups and page loads.

## [1.5.16] — 2026-06-17

### Fixed
- **Artist name link** — artist name in the album modal is now always a
  clickable link. Previously it flashed blue on open then reverted to plain
  text because the detail-fetch response was overwriting the button with a raw
  text node. A dedicated `setModalArtist()` helper is now used consistently
  everywhere the subtitle is set.
- **Wrong album opened for offset-shifted entries** — if the album index has a
  stale offset (e.g. after adding albums to the library), the detail fetch
  could return a completely different album and overwrite the modal title and
  artist with wrong data. The returned title is now compared to the expected
  title and ignored if it doesn't match, keeping the correct header while
  the user can trigger a re-index to restore full consistency.

## [1.5.15] — 2026-06-17

### Fixed
- **Roon extension settings** — removed duplicate version label (version is
  already shown in the Roon panel header). Changed the "Check for updates"
  dropdown placeholder from "—" to "No action" for clarity.

## [1.5.14] — 2026-06-17

### Added
- **Artist album links** — artist names in the album detail modal are now
  clickable. Tapping opens a filtered grid showing all albums by that artist:
  primary releases at the top, albums they appear on below.
- **Roon extension settings: per-zone radio toggle** — the random-album-radio
  switch for each zone is now also available inside Roon's own extension
  settings panel, so you can toggle it without opening the web UI.
- **Roon extension settings: Check for updates** — a *Check for updates* action
  in Roon's extension settings triggers an immediate update check.

### Changed
- **Label scan speed** — iTunes Search API is now the primary label source
  (free, no API key, returns `recordLabel` directly). MusicBrainz is used as
  a fallback. Scans now run 6 albums concurrently, reducing scan time from
  ~17 minutes to ~2–3 minutes for a 1 000-album library.

## [1.5.13] — 2026-06-17

### Changed
- **Share card** — redesigned to 1200×600. Album art now fills the entire left
  half (600×600, full bleed, no padding). Year, title and artist are vertically
  centred in the right half with even breathing room. A subtle dark gradient
  feathers the art-to-text boundary. Wordmark pinned to the bottom-right corner.

## [1.5.12] — 2026-06-17

### Added
- **Settings info icons** — help text replaced with a small ⓘ button on each
  settings row. Tapping it shows a toast that auto-closes after 5 seconds or
  on any tap, freeing up space in the settings panel.
- **Transport bar persistence** — the mini transport bar now restores its last
  known track title and artist from `localStorage` immediately on page load,
  so it appears before the first poll completes after a restart or update.

### Fixed
- **Radio zone persistence across container recreation** — the random-album-radio
  toggle state is now also saved to `data/cache/settings.json` inside the Docker
  volume, so it survives `docker stop`/`docker rm`/`docker run` cycles. Roon's
  own config is still updated as a secondary copy for backward compatibility.
- **In-app updater** — a `v1.5.12` git tag is now pushed to GitHub so the
  built-in updater can detect and install future releases without manual Docker
  intervention.

## [1.5.11] — 2026-06-17

### Changed
- **SQLite label database** — the three JSON cache files (`labels-cache.json`,
  `labels-mbid.json`, `labels-logo.json`) are replaced by a single
  `data/cache/labels.db` SQLite database. Writes are immediate and ACID;
  no more debounce timers or risk of partial writes on crash. Existing JSON
  caches are migrated automatically on first startup and deleted.
- **docker-compose.yml** now declares a named `roon-data` volume mounted at
  `/app/data`. Running `docker-compose up -d` is the recommended install/upgrade
  path and guarantees label data is never lost across rebuilds.
- **Dockerfile** installs `python3 make g++` so `better-sqlite3` compiles
  correctly during `docker build`.

### Fixed
- Label database (`data/cache/`) is now correctly preserved by the in-app
  updater's skip list. Upgrading via the settings cog no longer risks losing
  scan results.

## [1.5.10] — 2026-06-17

### Added
- **Label cache persistence** — label name, MusicBrainz MBID, and Fan Art TV
  logo caches are now written to `data/cache/` and excluded from the update
  overlay. Once built, the label database survives in-app updates without
  rescanning.
- **Docker volume for `data/`** — the Dockerfile now declares `VOLUME /app/data`
  and the docker run command mounts a named volume (`roon-random-albums-data`),
  so the cache and Roon pairing persist even when the container is removed and
  rebuilt.

### Changed
- **Fan Art TV logo fetches run 5 at a time** instead of sequentially with a
  500 ms delay. A library with 200 unique labels that all have MBIDs now
  finishes logo fetching in ~8 seconds instead of ~100 seconds.

## [1.5.9] — 2026-06-17

### Added
- **Check for updates** button in the settings cog — tap it to trigger an
  immediate update check without restarting the container.
- **Docker migration banner** — native (non-Docker) installs now see an
  amber banner with copy-ready commands to switch to the Docker version.
  Dismissed permanently once you tap *Got it*.
- `is_docker` field on the `/api/update/status` API response so the UI can
  distinguish Docker from native installs.

### Changed
- **Share card** — fixed height (1200 × 592); release date, album title, and
  artist are now spaced evenly within the cover area. Title and artist both
  wrap up to 3 lines. No review section, no label in the meta line.
- README rewritten as Docker-only. Includes fresh-install steps for v1.5.9,
  upgrade steps from v1.5.8, and native-to-Docker migration instructions.

### Fixed
- In-app updater (`tar` extraction) now works correctly inside Docker/Alpine
  containers — `shell: true` ensures `tar` is found on PATH when the update
  is applied.
- Dockerfile installs `tar` explicitly and sets `ENV DOCKER=1` so the
  migration banner is correctly suppressed for Docker users.

## [1.5.8] — 2026-06-16

Initial Docker release. Packaged as a self-contained `*-docker.tar.gz`
with Dockerfile, all source files, and in-app self-update support via
GitHub Releases.
