# Changelog

All notable changes to Roon Random Albums are documented here.

## [1.5.78] — 2026-06-23

### Added
- **Read-only Roon browse probe (`/api/debug/browse-probe`)** — a diagnostic endpoint to confirm, against a live Roon Core, exactly what's reachable for a future Qobuz integration: whether Qobuz "New Releases" can be browsed (and how many albums it holds), and whether an "Add to Library"/"Add to Favorites" action exists on a Qobuz album. Walks the browse tree from the root through a slash-separated `path` of node titles and dumps the resulting level; with `album=<index>` it drills into one album to list its actions. **It never passes a zone, so nothing is ever played, queued, or added** — purely a read of the tree. No user-facing behaviour changes; no Qobuz/favourites/decades features are implemented yet (pending what this probe reveals).

## [1.5.77] — 2026-06-23

### Fixed
- **Back from a deep-linked label now lands on that label in the Labels grid** — when you open a label by tapping its link in an album view (or a search chip) rather than by scrolling the Labels grid to it, pressing back used to reset the Labels grid to the top. `showLabelAlbums` previously saved the *current* screen's scroll offset, which was meaningless for a deep-link. It now records the label name for deep-links and scrolls that label's tile into view (centered) when you return, while tile taps from the grid keep restoring the exact scroll position as before.

## [1.5.76] — 2026-06-22

### Changed
- **Manual logo picker thumbnails doubled in size** — the Discogs logo candidates shown when manually choosing a label logo were 52×52px and hard to make out. They are now 104×104px (container `min-height` bumped to match) so the logos are legible before selecting.

## [1.5.75] — 2026-06-22

### Changed
- **Faster label scan for streaming-only (Qobuz/Tidal) libraries** — when no `/music` directory is mounted, the scan now inserts a Qobuz pass between iTunes and TheAudioDB. Qobuz is the user's actual streaming source, so it resolves most iTunes-misses in a single pass and keeps them out of the slow serial TheAudioDB → MusicBrainz → Discogs cascade (each of which is rate-limited to ~1 req/sec). The pass reuses the existing `fetchQobuz` scraper, filters results through `isLikelyNotALabel`, routes hits through `saveLabelEntry` (so label-logo MBID resolution still runs), and uses the same 10-consecutive-error circuit breaker as the other network passes. Progress weighting gains a dedicated Qobuz band when the pass is active.

## [1.5.74] — 2026-06-21

### Changed
- **"Self-Released" and "Independent" now appear as label tiles** — previously filtered out entirely; now treated as valid labels so self-released albums are browsable in the Labels view.

## [1.5.73] — 2026-06-21

### Added
- **Search now shows Artists, Labels, and Albums** — results are split into three sections. Artists and Labels appear as tappable chips above the album grid; tapping an artist chip opens that artist's albums; tapping a label chip navigates to that label in the Labels browser. Albums section renders as before.
- **Multi-artist name splitting in album modal** — artist fields containing multiple names separated by ` / `, ` feat.`, ` featuring`, or ` ft.` are split into individual tappable links. Each name navigates to that artist's albums independently. ` & ` is intentionally not split as it is often part of a band name (e.g. "Simon & Garfunkel").

### Fixed
- **Album modal label now matches the Labels browser** — the label shown in the album subtitle line previously came from Qobuz and could disagree with the label the album is listed under in the Labels browser (which uses the scan pipeline: file tags → iTunes → MusicBrainz). The modal now uses the canonical label from the scan pipeline, so tapping the label always navigates to the correct tile.
- **Labels browser scroll position lost on back-navigation** — returning from a label's album list always reset the labels grid to the top. The grid now restores its scroll position when you navigate back.

## [1.5.72] — 2026-06-21

### Fixed
- **Qobuz-sourced labels bypassed `isLikelyNotALabel` filter** — both `seedLabelsFromCache` and `rebuildLabelsMap` injected Qobuz labels directly into `labelsIndex` without calling `isLikelyNotALabel`, allowing "Self-Released", "Independent", and similar non-label strings to appear as real label tiles. `fetchQobuz` had the same gap when writing back to `labelDiskCache` and `labelsIndex`. All three paths now call `isLikelyNotALabel` before injecting.
- **iTunes fetch used a subset filter instead of the authoritative `isLikelyNotALabel`** — `fetchLabelFromiTunes` had an inline `/self.released|independent|self-released/i` guard that missed many values covered by `NON_LABEL_RE` (e.g. "Promo Only", "Not On Label", "White Label"). Replaced with `isLikelyNotALabel(label)` so all iTunes results go through the same shared gate as every other fetch path.
- **Redundant inline filter in `fetchLabelFromDiscogs`** — after calling `isLikelyNotALabel(label)`, the function also tested `/self.released|independent/i` — a strict subset that could never add a new rejection. Removed the duplicate check.
- **FanArt TV logo stored under source key after merge** — `fetchFanArtLogo` wrote the logo URL (and the `null` 404 sentinel) directly under `groupKey` without consulting `labelMerges`, so if a merge happened before or during the fetch the logo landed under the merged-away key. After a restart, the canonical target key had no logo entry. Now follows `labelMerges` in both the success and 404 error paths, mirroring the fix already applied to Discogs in v1.5.71.
- **`discogsLogoTried.add()` fired before the fetch completed** — if the network request threw an error, the groupKey was permanently marked as tried for the session, preventing any retry. Moved `.add()` to after the result arrives; errors (`reason === "error"`) are excluded so they can be retried on the next scan cycle.
- **`labelMbidCache` did not store null for failed MusicBrainz lookups** — `saveLabelEntry` only called `labelMbidCache.set(gk, mbid)` on success, so every scan cycle re-queried MusicBrainz for labels that returned no MBID. Now caches `null` as a session sentinel on failure; the sentinel is not persisted to DB so failed lookups are retried on restart.
- **`sanitizeDiscogsSearchTerm` logic duplicated in two places** — the leading/trailing non-alphanumeric strip was inlined in both `fetchLogoFromDiscogs` and the `/api/labels/logo-candidates` endpoint. Extracted into a shared `sanitizeDiscogsSearchTerm()` helper; both call sites now use it.
- **Logo picker did not pre-fill existing URL when opened** — `currentLabelLogoUrl` was populated correctly (since v1.5.70) but never written to `logoUrlInput.value` when the sheet opened. The URL field was always blank even for labels with a stored logo. Now pre-fills `logoUrlInput.value` with `currentLabelLogoUrl` on open.
- **CLAUDE.md violation: 9 more silent catches without explanatory comments** — `updater.apply()`, `updater.checkNow()`, `refreshSettings()`, `pickSmartAlbum`, `ensureAlbumIndex`, `startIndexMaintenance`, two `/api/play-unheard` routes (index.js), and `fetchAlbumExtras`, `seek`, `control`, `toggleMute`, `renderBarZoneList`, `initDockerMigration` (app.js) all lacked required explanatory comments. Added comments to all.

## [1.5.71] — 2026-06-21

### Fixed
- **`kickDiscogsLogoFetches` re-fetched labels already confirmed as having no logo** — used `labelLogoCache.get(key)` (truthy check) which is falsy for `null` sentinel entries (stored when FanArt TV found no logo). Changed to `labelLogoCache.has(key)` so labels previously confirmed as logo-less are correctly skipped, consistent with `kickFanArtFetches`.
- **iTunes label match returned wrong-artist album** — fallback `results.find()` had a permanently-dead title operand in an `||` condition (line 1036 already exhausted all title matches). Effective behaviour was artist-only matching, which could attribute any album from the same artist regardless of title. Cleaned up to clearly express the intent: artist-alone as a tiebreaker before `results[0]`.
- **Progress bar froze at 20% for entire iTunes pass** — `PASS_ENDS = [0.20, 0.20, ...]` gave the iTunes pass zero width (`end === start`). Fixed to `[0.10, 0.20, ...]` so files cover 0–10% and iTunes covers 10–20%.
- **Discogs searches failed for labels with leading or trailing brackets** — `[PIAS]` was stripped to `PIAS]`; `(4AD)` to `4AD)`. The trailing bracket was passed to Elasticsearch and could trip range-query parsing, returning zero or wrong results. Changed to strip both leading AND trailing non-alphanumeric characters in both `fetchLogoFromDiscogs` and the `/api/labels/logo-candidates` endpoint.
- **`"Self-Released"` persisted as a real record label** — the MusicBrainz and TheAudioDB fetch paths only checked `isLikelyNotALabel` which did not test for "Self-Released"/"self released". iTunes and Discogs had private inline guards that the shared gate was missing. Added `self.?released` to `NON_LABEL_RE` so all four fetch paths reject it consistently.
- **Logo URL not updated in `currentLabelLogoUrl` after saving** — `saveLogo()` in app.js ignored the `storedUrl` field returned by `POST /api/labels/logo`. The server downloads and locally caches the image (returning `/api/labels/logo-image/xyz.jpg`), but `currentLabelLogoUrl` was left pointing to the original Discogs CDN URL. Now assigns `j.storedUrl` on success.
- **Discogs logo stored under source key after mid-flight merge** — if `POST /api/labels/merge` ran while `kickDiscogsLogoFetches` was in progress, the logo was persisted under the source (merged-away) groupKey in SQLite. After a restart, `labelLogoCache` held the logo under the source key but not the target key, so the merged label tile showed no logo. Now follows `labelMerges` at store time to write under the canonical target key.
- **CLAUDE.md violation: two silent catches without explanatory comments** — `catch (e) {}` in `runLabelsIndexScan` (awaiting album index build) and `catch (e) { return; }` in `buildFileLabelMap`'s `scanDir` (directory read failure) both lacked required comments. Added comments explaining why silence is safe in each case.
- **Duplicate TheAudioDB section header comment** — removed copy-paste duplicate 3-line comment block above `fetchLabelFromTheAudioDB`.

## [1.5.70] — 2026-06-20

### Fixed
- **Label scan permanently locked after exception** — if `buildFileLabelMap` or any scan pass threw an unhandled exception, `labelsIndex.building` was never reset to `false`, blocking all future auto-rescans and manual rescans for the lifetime of the container. Wrapped the scan body in try/catch with guaranteed reset.
- **Discogs CDN image fetch storing login-page URL as logo** — when a candidate image URL redirected to a Discogs login page (HTML, not an image), the code fell through to `storedUrl = resp.url` and stored the login page URL as the logo, producing a permanently broken image tile. Now any non-`image/*` response is discarded and the original URL is kept (tile fails gracefully rather than storing a bad URL).
- **Discogs API calls fired unauthenticated when no token set** — `fetchLabelFromDiscogs`, `fetchLogoFromDiscogs`, and `kickDiscogsLogoFetches` all sent `Authorization: Discogs token=` (empty) when no token was configured. Added early-return guards: calls are skipped entirely when `discogsToken` is empty, saving rate-limit headroom. `/api/labels/logo-candidates` now returns a clear error message "Discogs token not configured — add it in Settings" so the picker UI shows an actionable message instead of "Discogs search failed".
- **Logo picker showed generic error on auth/server failure** — `loadLogoCandidates` swallowed the error message and always showed "Discogs search failed". Now propagates the server's error text (e.g. "Discogs token not configured").

### Changed
- **`savePersistedSettings` now uses in-memory cache** — previously every save called `loadPersistedSettings()` (a synchronous `readFileSync`) to merge before writing. Added `_settingsCache` so the file is read once at startup and all subsequent saves update in-place with no disk read. Eliminates the read-before-write pattern on every radio toggle and token save.
- **All silent `catch` blocks now have comments** — every `catch (e) {}` and `catch (_) {}` in `index.js` and `app.js` has a comment explaining why silence is safe. Required by CLAUDE.md zero-tolerance rules.
- **`currentLabelLogoUrl` captured from label-albums response** — the `logo_url` field returned by `/api/label-albums` is now stored in a frontend variable, making the current label's stored logo available for future use in the picker UI.

## [1.5.69] — 2026-06-20

### Fixed
- **API token/key Save buttons not working** — both settings inputs were `type="password"`, which triggers iOS's keychain manager and can silently clear the field value before the click event fires, causing the empty-field guard to bail out. Changed to `type="text"` (API keys are not authentication passwords; the masked display in the status row provides sufficient visual protection). Also: the server-side POST handlers now reject empty values with a 400 response (instead of silently setting an empty token), log the received key length to Docker logs for diagnostics, and report whether the file write succeeded so the client can warn if persistence fails.

## [1.5.68] — 2026-06-20

### Fixed
- **Extension not appearing in Roon (properly fixed)** — the v1.5.67 commit did not actually include the temporal dead zone fix due to a staging sequencing error; the crash was still present. This build correctly declares `let discogsToken` and `let fanartKey` at the load site and removes the duplicate `let` declarations that appeared later in the file.

## [1.5.67] — 2026-06-20

### Fixed
- **Extension not appearing in Roon** — v1.5.66 introduced a JavaScript temporal dead zone crash: `discogsToken` and `fanartKey` were assigned at startup (line ~672) but their `let` declarations appeared hundreds of lines later. Node.js throws a `ReferenceError` before the process can register with Roon. Fixed by declaring both variables at the point they are first assigned.
- **Discogs API calls broken** — all Discogs auth headers referenced `DISCOGS_TOKEN` (an undefined constant) instead of the `discogsToken` variable loaded from settings. Every API call was sending `Authorization: Discogs token=undefined`, causing silent auth failures. Fixed to use the correct variable name throughout.

### Changed
- **FanArt.tv key in Settings UI** — removed the hardcoded FanArt.tv API key. It is now entered via the Settings panel (gear icon → FanArt.tv key field) and stored in `data/cache/settings.json`. Enter your own free key from fanart.tv/get-an-api-key. No credentials remain hardcoded in source code.

## [1.5.66] — 2026-06-20

### Changed
- **Discogs token in Settings UI** — the Discogs personal access token is now entered via the Settings panel in the web UI (gear icon → Discogs token field). It is stored in `data/cache/settings.json` and never appears in source code or environment variables. Existing installs can paste their token after upgrading.

## [1.5.65] — 2026-06-20

### Fixed
- **Albums appearing under wrong labels** — two bugs in the scan pipeline caused stale API-derived label assignments to persist even when file tags had correct data. (1) The file-tag override pass only ran when ≥10 albums were uncached, so 12-hour auto-rescans where everything was already cached never re-read file tags. (2) Even when the override pass did run, it updated the SQLite cache but not the in-memory index, so the labels page still showed the old wrong attribution. File tags (populated by beets/MusicBrainz) now always take priority: the file scan runs unconditionally at the top of every scan, and a `rebuildLabelsMap()` call follows any corrections so the in-memory index matches immediately.
- **Discogs logo fetch using wrong auth** — all Discogs API calls used consumer key+secret authentication, which behaves like an unauthenticated request (25 req/min) and may be rejected by certain endpoints. Switched to personal access token auth (`Discogs token=…`) which is the method recommended by Discogs and used in working reference implementations.

## [1.5.64] — 2026-06-20

### Fixed
- **Logo picker shows "No logos found" for labels like `~scape`** — Discogs search results often omit `cover_image` for niche labels even when the label page has images. The candidates endpoint now falls back to the Discogs Labels API (`/labels/{id}`) for the best name-matched result, which always includes the full `images[]` array.
- **Pasting a Discogs label URL in the logo sheet didn't work** — the Discogs image viewer URL (`discogs.com/label/1495-~scape/image/…`) requires a browser session to serve image bytes; the server-side fetch got HTML instead. The save endpoint now detects any Discogs label URL, extracts the label ID, calls the Discogs API to get a real `i.discogs.com` CDN image URL, and downloads that instead.

## [1.5.63] — 2026-06-20

### Changed
- **Label logo picker** — the photo icon now opens a Discogs logo picker alongside the URL paste field. When the sheet opens, the server queries Discogs and shows up to 6 logo candidates as tappable thumbnails; tap one to save immediately with no URL copying needed. Works fully on iPhone with no clipboard gymnastics.
- **Logo URL caching** — when a logo URL is saved (whether from the picker or pasted manually), the server downloads the image and stores it locally under `data/cache/logos/`. This means any URL works — including Discogs image viewer pages that aren't direct image links — because the server fetches and caches the bytes itself.

## [1.5.62] — 2026-06-20

### Fixed
- **Label scan stalls at ~95%** — the Discogs data pass (finding label names for albums not identified by iTunes/TheAudioDB/MusicBrainz) runs at 1 req/sec and was taking many minutes for large libraries after a Force Rescan. Added a 5-minute time cap: the pass aborts cleanly at the limit and any remaining albums are picked up at the next 12-hour auto-rescan.

### Added
- **Manual logo for label tiles** — a photo icon button appears in the label album header (when viewing a specific label's albums). Tapping it reveals a URL input; paste any direct image URL (e.g. from the Discogs label page) and tap Save. The logo is stored in the database and survives restarts.

## [1.5.61] — 2026-06-20

### Fixed
- **Discogs logo search fails for labels with leading symbols** — labels like `~scape`, `(((Belle Sound)))`, or `[PIAS]` were not found because Discogs uses Elasticsearch where `~` is a fuzzy operator. The search query now strips leading non-alphanumeric characters before sending to Discogs; the original name is still used for result matching, so `~scape` searches for `scape` but matches the `~scape` result correctly.
- **Force rescan skips Discogs logo re-fetch** — the per-session dedup Set (`discogsLogoTried`) was never cleared by Force Rescan, so labels that previously got no logo result would be silently skipped even after the search bug was fixed. Force Rescan now clears the Set so all logo lookups are retried.

## [1.5.60] — 2026-06-20

### Added
- **Label link in album modal** — the record label now appears on the subtitle line alongside the artist and year (`Kraftwerk · 1974 · Parlophone UK`). Tapping the label name navigates directly to that label's albums in the Labels browser.

### Fixed
- **Year shown from album data when MusicBrainz year is missing** — the subtitle year now falls back to the year returned by the album extras (Qobuz/Wikipedia source) if the MusicBrainz lookup returned nothing.

### Changed
- **Multi-select queue speed** — when queuing multiple albums, albums 2–N are now sent to Roon in parallel rather than sequentially. For a typical 3-album queue this roughly halves the wait time.

## [1.5.59] — 2026-06-20

### Fixed
- **Duplicate exit control in select mode** — removed the "Done" topbar button; the "×" in the action bar already exits select mode, making "Done" redundant.

## [1.5.58] — 2026-06-20

### Fixed
- **Merge bar / action bar invisible on mobile** — `#label-merge-bar`, `#album-action-bar`, and `#label-unmerge-sheet` were inside `.app` which has `z-index: 0`, placing them behind the mini-transport (`z-index: 70`) and modal (`z-index: 50`). Moved all three elements outside `.app` so they sit in the root stacking context at their own `z-index: 75/80`.
- **Two Select buttons (iPad) / cluttered topbar** — removed the separate `#album-select-toggle` and `#label-select-toggle` buttons. Selection mode is now entered by long-pressing any album or label tile (500ms, with haptic feedback). A single "Done" button (`#select-done-btn`) appears in the topbar when any select mode is active.
- **Scanning progress message overflows topbar** — removed the `(scanning… X%)` suffix from the count text. Added a slim 2px progress bar at the very bottom of the topbar that animates as the scan advances.
- **File scan stalls with large libraries** — `buildFileLabelMap()` now only runs when `toScan.length > 10` (skips file scan for small incremental additions). Progress is reported during the file scan via an `onProgress` callback so the bar begins moving immediately.

### Added
- **Force rescan button in Settings** — a "Force rescan" button clears the label name cache (logos and MBIDs are kept) and triggers a complete fresh scan from all sources. Useful after importing new music or if label data looks wrong.

## [1.5.57] — 2026-06-20

### Fixed
- **Topbar buttons shift left on first load** — `justify-content: space-between` placed the controls div at flex-start when the album count badge was hidden (display:none). Added `margin-left: auto` to `.topbar-controls` so buttons always hug the right side regardless of the count badge visibility.
- **Album multi-select: filter context missing** — when a genre or tag filter was active, multi-select play/queue requests omitted `filter_type`/`filter_value`, causing offsets to resolve against the full library instead of the filtered list and playing the wrong albums.
- **Album select tiles: no visual feedback** — selected album tiles on the random wall had no highlight or checkmark. Generalised the existing label-tile selected-state CSS (outline + checkmark badge) to apply to all `.album.is-selected` tiles.
- **Labels page: "No labels found yet" on fresh restart** — when the album index had not built yet (count=0) but `albumIndex.building` was still null (brief window before `buildAlbumIndex()` is called), the API reported `scanning:false`. The client showed the permanent "No labels found yet" message instead of polling. Now any response with empty labels AND zero albums returns `scanning:true`.
- **`exitLabels()` not clearing album select mode** — navigating away from labels while album select mode was active left the action bar open.
- **"Rescan now" button wrong class** — used `primary-btn` (square icon button style) instead of `action-btn primary` (text button style).

## [1.5.56] — 2026-06-20

### Fixed
- **Labels merge button invisible on mobile** — the Merge button used the `primary-btn` class whose CSS hides `<span>` text on small screens, making it appear as an empty blue square. Replaced with a new `action-btn primary` style that always shows the button label.

### Added
- **Album multi-select on the random wall** — a Select button appears in the topbar when on the album wall. Tap to enter select mode, tap tiles to choose albums, then use the action bar (Play Now / Queue) to play them all. Play Now starts the first album and queues the rest; Queue adds all to the queue. Cancel clears the selection.

## [1.5.55] — 2026-06-20

### Changed
- **Version display** — both the Roon Extensions list and the web UI Settings panel now show `MusicD Random Albums v1.5 (Build 55)` instead of the raw semver string. The Roon registration `display_name` is `MusicD Random Albums v1.5` and `display_version` is `Build 55`.

### Fixed
- **Long-press on artwork** — images inside album and label tiles no longer trigger the iOS save/copy context menu or browser drag-to-save on desktop (`pointer-events: none` + `-webkit-touch-callout: none`).

## [1.5.54] — 2026-06-20

### Fixed
- **Labels grid unstable during scan** — the tile grid was fully re-rendered on every 5-second poll whenever new labels appeared, causing a visible flash. The grid now only renders on first load and once more when the scan completes; the count text updates each poll so progress is still visible without the grid flickering.

## [1.5.53] — 2026-06-20

### Added
- **Label merge UI** — a "Select" button appears in the topbar when the Labels page is open. Tap it to enter select mode, then tap two or more label tiles to choose them (the first tapped is the merge target — shown with an accent checkmark). The merge bar at the bottom shows the target name and a Merge button. Merges are saved to the SQLite database and survive container restarts and rescans.
- **Label unmerge** — tiles that have labels merged into them show a small "N merged" indicator below the album count. Tapping it opens a bottom sheet listing each merged label with an × button to remove it one at a time.

## [1.5.52] — 2026-06-20

### Fixed
- **Labels blank during scan** — `/api/filters/labels` now calls `seedLabelsFromCache()` eagerly when the in-memory map is empty but the album index is ready, so the first response on a fresh restart always includes cached labels rather than returning an empty list while the scan runs in the background.
- **Labels rescan on every restart** — `labelsIndex.builtAt` was in-memory only and reset to 0 on each container restart, triggering a full rescan every time the Labels page was opened. The scan timestamp is now written to `data/cache/last-labels-scan.txt` on completion and reloaded at startup; rescans only trigger when the file is absent or the last scan is older than 12 hours.
- **Labels polling stops on error** — a single network error in the `showLabelsList` fetch permanently stopped label updates (no retry was scheduled in the catch block). The catch block now retries after 10 seconds so transient errors recover automatically.

## [1.5.51] — 2026-06-20

### Fixed
- **Label fragmentation (Inc. / LLC variants)** — stripping a corporate suffix (e.g. `Inc.`) from `"A&M Records, Inc."` left a trailing comma that blocked the next pass from stripping `"Records"`, producing group key `"amrecords"` instead of `"am"`. Trailing punctuation is now stripped after *each* suffix pass, so `"A&M Records, Inc."` correctly merges with `"A&M Records"` and `"A&M"`.

## [1.5.50] — 2026-06-20

### Fixed
- **Label fragmentation** — trailing commas (and semicolons/colons) in file-tag label names (e.g. "A&M Records,") now stripped before suffix normalisation, so "A&M Records," and "A&M" correctly merge into one tile.
- **Discogs logo auth** — logo search was using key/secret as query params rather than the `Authorization: Discogs key=…, secret=…` header used by the working label-data fetch; switched to the header, which Discogs requires for authenticated API calls.
- **Discogs placeholder filter** — added `no-label` pattern to the image filter regex to catch Discogs' own "no image" CDN URL.
- **Discogs logo diagnostics** — completion log now breaks down result counts: logos found / no results / placeholder filtered / errors, so problems are visible in the scan log without enabling debug mode.

## [1.5.49] — 2026-06-20

### Added
- **Discogs label logos** — after Fan Art TV finishes (which requires a MusicBrainz MBID), a second logo pass now searches Discogs by label name and fetches `cover_image` URLs. This covers the large number of labels that have no MBID and therefore no Fan Art TV logo. Results are cached in SQLite alongside Fan Art TV logos. Placeholder/spacer images are filtered out. Runs in the background after every scan and on startup.

## [1.5.48] — 2026-06-20

### Changed
- **Label text size increased** — bumped from 8cqw to 9cqw.

## [1.5.47] — 2026-06-20

### Changed
- **Label text tiles: consistent font size across all tiles using container query width** — removed per-label JS font-size calculation entirely. Font is now `8cqw` (8% of the tile's own width), so "Rockproduktionen" (16 letters) fits with thin margins and every other label uses that same size. Scales automatically with tile width on any screen size.

## [1.5.46] — 2026-06-20

### Fixed
- **Label text tiles: font size now scales by longest word, not word count** — the previous approach made 4 short words ("3 Beads of Sweat") smaller than 2 long words. Font is now sized to fit the longest word in the label name, so the tile width is always the constraining factor. Short words at any count display larger; only genuinely long words (e.g. "Rockproduktionen") force a smaller size.

## [1.5.45] — 2026-06-20

### Fixed
- **Label tiles still showing album covers** — labels without a Fan Art TV logo were falling back to the first album's cover art, making the tile indistinguishable from an album. Removed the album-art fallback from label tiles entirely. The display hierarchy is now: Fan Art TV logo → label name text. Nothing else.

## [1.5.44] — 2026-06-20

### Changed
- **Label tiles without a logo now show the label name** — previously showed a generic tag icon. The label name is displayed centred in the tile, with each word on its own line (e.g. "Blue Note" = two lines, "Warner Music Group" = three lines). Font size scales down slightly for longer names. The tag icon is retired entirely from label tiles.

## [1.5.43] — 2026-06-19

### Fixed
- **Progress bar shows >100%** — albums that fail one API pass and cascade to the next (e.g., fail iTunes → TheAudioDB → MusicBrainz) were counted once per pass, so `done` grew to 3× the album count and the percentage climbed to 112%+. Replaced the single `done` counter with a pass-weighted progress function: files+iTunes share 0–20%, TheAudioDB 20–50%, MusicBrainz 50–80%, Discogs 80–100%. The bar now moves linearly through each pass and always stays between 0% and 100%.

## [1.5.42] — 2026-06-19

### Fixed
- **Progress bar frozen during passes 2–4** — `done` was only incrementing inside the iTunes pass. TheAudioDB, MusicBrainz, and Discogs passes now update progress correctly so the UI percentage moves throughout the full scan.
- **No visibility into long-running passes** — the log only wrote at pass boundaries, making it impossible to tell if TheAudioDB (potentially 37+ minutes) was stuck or just slow. Now logs every 100 albums processed within each pass.
- **TheAudioDB could block for hours on timeout storms** — added a circuit breaker: 10 consecutive request errors in any pass abort that pass immediately and log the reason. The next 12-hour auto-rescan retries. Reduced TheAudioDB timeout from 10s to 6s so stalled requests fail faster.

## [1.5.41] — 2026-06-19

### Added
- **Scan error logging** — all scan events (start, per-pass summaries, errors, completion) are now written to `data/labels-scan.log` with timestamps. The log rotates automatically at ~100KB.
- **Scan log download** — a "Download scan log" and "Copy log" link appears in the Labels view after a scan, for easy sharing when debugging.
- **12-hour auto-rescan** — the labels scan now re-runs automatically every 12 hours while paired with a Roon Core, so new albums are picked up without a manual rescan.
- **`GET /api/labels-scan-log`** — serves the scan log as a plain-text download.

### Changed
- **Rate-limit errors now abort silently** — when iTunes returns 429/403, the error is recorded in the log and the pass aborts; the next scheduled 12-hour window will retry rather than erroring again in the same run.

## [1.5.40] — 2026-06-19

### Fixed
- **iTunes rate limiting** — reduced concurrency from 20 to 3 parallel requests and added a 500ms delay between batches. On the first 429 or 403 response the entire iTunes pass is aborted immediately rather than continuing to hammer a blocked endpoint; remaining albums fall through to TheAudioDB and MusicBrainz.
- **File labels now override stale cache** — when file metadata scanning is enabled, the file label is now compared against every existing cache entry. Where the file tag disagrees with the cached API result, the file wins and the cache is updated. Previously file labels only applied to albums with no cache entry at all.

## [1.5.39] — 2026-06-19

### Fixed
- **TheAudioDB rate limiting** — the free API has a strict rate limit; added 1.1s delay between requests and changed from 5 concurrent to serial to stop HTTP 429 errors.
- **MusicBrainz timeouts** — increased request timeout from 8s to 20s to handle slow MB responses without aborting.
- **File scan silent failure** — added a debug log when `parseFile` can't be resolved from music-metadata, replacing a silent early return that made it impossible to diagnose.
- **"Independent" treated as a label** — added `independent` to the non-label filter so it's rejected at all sources and never shown in the labels view or looked up in Fan Art TV.

### Changed
- **Update check interval** — reduced from every 6 hours to every 7 days. Updates are still checked on startup; the Settings page manual check is unaffected.

## [1.5.38] — 2026-06-19

### Fixed
- **File metadata scanner: wrong directory structure assumed** — the previous scanner expected strict `Artist/Album/tracks` nesting. Real libraries use mixed layouts (flat `Artist - Album/`, year-prefixed folders at root, proper nested `Artist/Album/` alongside each other). The scanner now recursively walks the music directory and matches on audio file tags (`common.album` + `common.albumartist`) rather than directory names, so naming convention is irrelevant.

## [1.5.37] — 2026-06-19

### Added
- **File metadata scanning** — the extension can now read LABEL/ORGANIZATION tags directly from your audio files when the music directory is mounted read-only in Docker (`-v /path/to/music:/music:ro`). File tags are the most authoritative source and are checked first, before any network API. Add `-v /mnt/dietpi_userdata/4tb/Music:/music:ro` to your `docker run` command to enable.
- **Discogs label source** — restored as a final-pass fallback for albums no other source could identify. Runs serially at 1 req/sec to respect the rate limit.
- **TheAudioDB label source** — added as a third-pass source between iTunes and MusicBrainz. Free, no key required, runs 5 concurrent requests.
- **`/api/music-mount` endpoint** — reports whether the `/music` directory is mounted and what path is configured.

### Fixed
- **Label fragmentation by country/region** — labels like "[PIAS] America", "[PIAS] Belgium", "Universal Music Canada", "Universal Music France" now all group correctly under "[PIAS]" and "Universal Music" respectively. A new regex strips country and regional qualifiers (US, UK, America, Canada, France, Germany, Belgium, and 30+ others, plus International, Global, Nordic, etc.) before computing the group key.
- **Management company false positives** — album entries where iTunes (or another source) returned a management or booking company instead of the actual label (e.g. "Velvet Hammer Music and Management" for Korn) are now detected and skipped. Existing bad entries are evicted from the SQLite cache on startup.

### Changed
- **Label scan pipeline** — now a 4-pass pipeline: file metadata → iTunes (20 concurrent) → TheAudioDB (5 concurrent) → MusicBrainz (serial) → Discogs (serial). Each album is only sent to subsequent passes if the previous pass found nothing.

## [1.5.36] — 2026-06-19

### Fixed
- **Missing `.dockerignore`** — without it, `COPY . .` in the Dockerfile was baking the native install's `node_modules` into the Docker image, overwriting the clean ones built by `npm install`. Also excluded `config.json`, `data/`, tarballs, and `.git` from the image.
- **Migration instructions** — updated to use a fresh separate directory for the Docker build, making cleanup unambiguous: the old native directory can be safely `rm -rf`'d without any risk of deleting Docker build files.

## [1.5.35] — 2026-06-19

### Added
- **Downgrade / rollback via web UI** — the in-app updater now follows whatever version is marked as "latest" on GitHub, regardless of direction. If the latest release is rolled back to an older version number, the app will offer to install it. The toast and Settings button both indicate "Roll back" vs "Update" so there's no ambiguity.
- **Release notes in update UI** — when an update or rollback is available, the GitHub release notes are shown directly in the update toast and under the "Check for updates" button in Settings, so you can read what changed before tapping.

### Fixed
- **Incorrect "Listening statistics" feature in README** — removed from the features list; the stats UI was removed in a previous build (play history still exists in the backend and is used by Play Unheard and Random Album Radio).

## [1.5.34] — 2026-06-19

### Changed
- **Labels scan: two-pass strategy** — iTunes lookups now run first in batches of 20 (fast, no rate limit). Only albums iTunes misses are passed to MusicBrainz, which runs serially to respect the 1.1-second rate limit. Reduces total scan time for large libraries.
- **Library stats: served from in-memory index** — `/api/library-stats` now reads directly from `albumIndex.count` instead of walking the Roon browse hierarchy on each request. Eliminates the 60-second cache and the background Roon API call entirely.
- **Artist view re-entry guard** — calling `showArtistAlbums()` while already in artist view now exits cleanly before rebuilding, preventing stale grid/count state.

### Removed
- **Dead code cleanup** — removed `fetchLabelFromDiscogs()`, `discogsWait()`, the unused `_albumCountCache` variable, the `buildSimpleTile()` fallback function, and the stale Qobuz-data comment block. Removed dead CSS rules: `.brand`, `.brand-mark`, `.brand-logo`, `.brand-name`, `.filter-grid`, `.filter-grid .filter-row`, `.filter-loading`, `.filter-backdrop`.

### Fixed
- **`.count-text` missing from CSS** — the class used in the artist view count bar was referenced in JS but absent from the stylesheet; added the rule.

## [1.5.33] — 2026-06-19

### Fixed
- **Random Album Radio auto-starts on restart** — eliminated the bug where radio would begin playing automatically whenever Roon or the extension restarted. Root cause: any `zones_changed` event for a zone in "stopped" state (with empty queue) after the 15-second grace window would trigger playback. Replaced the unreliable grace timer with proper state-transition detection: a "play" command is now only issued when the extension observes an actual `playing → stopped` transition for a zone (i.e. the queue genuinely ran out). A zone that is already stopped when first seen after a reconnect will never auto-start. Enabling radio explicitly via the UI still starts playback immediately as expected.

## [1.5.32] — 2026-06-18

### Fixed
- **Phone portrait grid** — restored 3×3 (9 albums) layout. The CSS override that forced 2 columns has been removed; the base 3-column grid now applies correctly to all phone portrait views.

## [1.5.31] — 2026-06-18

### Fixed
- **Roon extension publisher** — changed `extension_id` from `com.local.*` to `com.musicd.*` so Roon's Extensions list now shows "MusicD" instead of "Self".
- **Now-playing album link** — tapping the album name on the Now Playing screen no longer triggers "Valid offset query parameter required". The handler now only opens the album detail when a valid index match with an offset is found; otherwise shows a brief toast.
- **Labels screen flickering** — eliminated the blank-then-reload flash that occurred every 4–5 seconds while the label scan was running. Skeletons are only shown on the first open; subsequent polls only re-render when the label count actually changes.
- **Share card text size** — increased release-date label (20 → 26 px), album title (48 → 56 px), and artist (30 → 37 px) for better readability.
- **Share card MusicD wordmark** — removed the "MusicD" text fallback from the share card.
- **Play unheard tooltip** — removed `title` attribute from the compass button; the text tooltip no longer appears on tap.
- **Grid album counts** — corrected `computeAlbumCount()`: desktop now returns 45 (9 × 5), tablet portrait returns 20 (5 × 4); tablet landscape (7 × 3 = 21) and phone portrait (2 × 3 = 6) unchanged.

### Added
- **Album count in topbar** — the total number of albums in your library (or the active filter) is now shown as a bold label on the left side of the topbar, white on dark and black on light.

### Changed
- **Labels scan speed** — increased concurrent iTunes lookup batch from 6 to 20 albums, significantly reducing scan time for large libraries.

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
