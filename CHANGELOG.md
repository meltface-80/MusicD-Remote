# Changelog

All notable changes to Roon Random Albums are documented here.

## [1.5.30] — 2026-06-18

### Added
- **"Play unheard" in topbar** — the compass icon button (⊙) is now in the main
  header alongside Filter, Labels, and Search, so it's always one tap away without
  opening Settings. Removed from the Settings sheet.

### Changed
- **Now-playing album title is tappable** — the album name shown on the Now Playing
  screen is now a button. Tapping it opens the full album detail view (tracks and
  actions) for the currently playing album.

### Fixed
- **Tap-to-select disabled globally** — iOS and Android no longer show the text
  selection handles when tapping album tiles, labels, or any non-interactive text.
  Text selection is still active in the search input and any other text fields.

## [1.5.29] — 2026-06-18

### Added
- **Smart random radio** — the random-album radio now prefers albums not played
  in the last 30 days. It picks candidates in small batches and skips recently
  heard titles, falling back to pure random only when nothing fresh is found.
- **Play something unheard** — new button in Settings (and `POST /api/play-unheard`)
  that picks an album with zero plays in the plays table and starts it immediately
  in the selected zone. Falls back to pure random if your entire library has been
  heard at least once.
- **Play count badges** — album tiles now show a small "N×" badge in the
  bottom-right corner for any album that appears in the plays table, so you can
  see at a glance which albums you've listened to before.
- **Recently played in stats** — the stats panel now shows a "Recently played"
  section (last 25 tracks, regardless of whether the play was marked completed).
  This section is visible immediately, even before any completed-play statistics
  have accumulated, so the stats page is never blank after the first track starts.
- **Zone breakdown in stats** — plays-per-zone bar chart shown when more than
  one zone has play history.
- **Apple Shortcuts / HTTP automation endpoints**:
  - `GET /api/shortcut/zones` — returns all Roon zones with name, ID, and state.
  - `GET /api/shortcut/play-random?zone=ZONENAME` — plays a random album in
    the named zone. Accepts both display name and zone ID.
  - `GET /api/shortcut/play-unheard?zone=ZONENAME` — plays an unheard album in
    the named zone.

### Fixed
- **Stats page no longer crashes when `labelsDb` queries fail** — the `/api/stats`
  endpoint is now wrapped in `try/catch` and returns a proper JSON error instead of
  an unhandled exception.
- **Stats page shown even before any completed plays** — previously the page
  returned a plain text message and rendered nothing. Now the recently-played
  section populates as soon as any track starts playing.

## [1.5.28] — 2026-06-18

### Fixed
- **Random album radio auto-start after Roon restart** — after the initial
  `Subscribed` snapshot (which correctly passes `isInitial=true`), Roon fires
  additional `zones_changed` events as it settles its state. These arrived
  without `isInitial`, causing stopped zones with radio enabled to auto-start.
  Added a 15-second grace window (`RECONNECT_GRACE_MS`) stamped on every
  `Subscribed` event; "play" decisions are suppressed within this window.
- **MusicD logo missing in header** — `logo.jpg` was never committed to the
  repository. Replaced the broken `<img>` with an inline SVG text wordmark.
- **MusicD wordmark missing on share cards** — `logo.png` was similarly absent.
  The share card now renders "MusicD" as text in the bottom-right corner when
  no image is available.

## [1.5.27] — 2026-06-18

### Fixed
- **Listening statistics never recorded** — `scrobbleUpdate` read
  `now_playing.line1 / line2 / line3` directly, but Roon nests those strings
  inside `now_playing.three_line.line1` etc. The guard `np && np.line1` was
  always falsy, so zero plays were ever written to SQLite and the stats page
  showed nothing. Fixed to use the same `three_line` / `one_line` property
  paths already used elsewhere (e.g. the transport API endpoint).

## [1.5.23] — 2026-06-18

### Fixed
- **Random album radio auto-start on restart** — when the extension reconnected
  to Roon, the initial zone-state snapshot was treated the same as a live zone
  change. Any zone with radio enabled that was stopped/idle would immediately
  start playing. The `"Subscribed"` event (startup snapshot) now passes
  `isInitial=true` to `handleRadioZone`, which suppresses the `"play"` decision
  so a stopped zone is left alone on reconnect. Queue top-up for zones that are
  already playing is unaffected — seamless continuation still works.

## [1.5.22] — 2026-06-18

### Fixed
- **Stats panel transparent background** — `var(--bg-page)` was used but never
  defined, causing the stats screen to show the album grid through it.
  Corrected to `var(--bg)`, the app's standard page background colour.

## [1.5.21] — 2026-06-18

### Changed
- **Statistics** — moved from the topbar bar-chart icon into the Settings panel.
  Tap *View stats* in Settings to open the full-screen stats view. The ✕ button
  in the top-right corner of the stats screen returns you to the album grid.

### Removed
- **Heart / love button** — removed. The Roon browse API did not expose a love
  action at the album browse level (button was always greyed-out and untappable).
  Use `/api/debug/album-items?offset=N` if you want to investigate the browse
  structure for a future re-implementation.

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
- **Updater 415 error** — POST requests to `/api/update/apply`,
  `/api/update/check`, and `/api/album/love` now send `Content-Type: application/json`.
  iOS Safari was supplying an implicit content type on body-less POSTs that
  Express's json() middleware rejected with 415 Unsupported Media Type.

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
