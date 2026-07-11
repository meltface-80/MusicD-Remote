# Changelog

All notable changes to MusicD Remote (formerly Roon Random Albums) are documented here.

## [1.6.31] — 2026-07-11

### Changed
- **The extension is now called MusicD Remote.** Display name in Roon ("MusicD Remote v1.6 (Build 31)"), the web app menu, and the Settings version line all renamed. The Roon `extension_id` is deliberately unchanged — no re-authorization needed; the zone/pairing carries over untouched.
- **Update checks now survive a repository rename.** GitHub answers a renamed repo's old API URLs with a redirect, which the updater previously treated as "no update available" — silently stranding every installed copy. The update check now follows redirects (with the auth token withheld from any non-GitHub host). Install this version BEFORE the repository is renamed and the transition is seamless.

## [1.6.30] — 2026-07-11

### Fixed
- **FanArt.tv label logos now self-heal when the API key is added or changed.** Previously, every label checked while the key was missing or broken got a permanent "no logo" verdict that survived restarts and even Force rescan — so a key added after the first scans could never produce logos (the exact cache-poisoning found on a live install: 1,040 blocked labels, 468 real FanArt logos underneath). Saving the key now purges those cached misses (real logos are kept), refetches immediately, and reports how many verdicts it cleared. The FanArt pass also writes its progress to the labels scan log like the Discogs pass ("fetching logos for N labels" / "done: X/N…"), so it is diagnosable without `RRA_DEBUG`.
- **Wall-display artist bios no longer show the wrong artist.** The bio card is now sourced and validated in strict order:
  1. **Qobuz, then Tidal** — when the playing album is found in the connected service's catalogue (album title AND artist must both match), the bio comes straight from that service's own artist page, pinning identity exactly. Tidal's `[wimpLink]` markup is stripped.
  2. **Wikipedia, hardened** — the article title must *be* the artist (a single "(band)"/"(musician)" qualifier allowed), disambiguation pages are rejected outright, and the article must additionally be connected to the playing album (full-text cross-check covering discography sections). No confident match → no bio card, rather than a guess: previously any music-flavoured search result could win, so a generic name like "Camel" could surface a different musician's biography.
  - Every credited artist on a multi-artist album goes through the same validated chain, attribution names the real source (Qobuz/Tidal/Wikipedia), and lookups are cached per artist+album.
- Code-review findings fixed pre-commit: bare slashes in artist names (AC/DC) are no longer treated as multi-artist separators; Qobuz search items that carry `performer` instead of `artist` now match; a redundant entity-decode was removed.

## [1.6.29] — 2026-07-10

### Changed
- **Playing a genre-, label-, tag- or decade-filtered album is much faster after the first time.** To play a filtered album the extension first has to locate that genre/label/tag in Roon's browse tree by title, which meant paging through the list 100 entries at a time — up to ~30 sequential Roon round-trips for a genre and ~200 for a label, every single time, adding seconds to each filtered play. It now remembers each filter's *position* in its (alphabetically stable) list and jumps straight there in one round-trip, verifying the title on arrival. A stale position (after a library edit shifts the list) simply falls back to the old scan and re-learns it, so it can never open the wrong album — only ever be as slow as before. Positions are relearned automatically when the library changes. Item keys, which are session-scoped, are still never cached — only the stable list position is.

## [1.6.28] — 2026-07-10

### Changed
- **Home screen opens instantly — it no longer reloads and re-randomises everything each time you open the PWA.** The in-memory freshness state was destroyed whenever the app was backgrounded, so every cold open rebuilt all four Home rows (Not played / Random / Label of the week / Browse by genre) from scratch behind "Loading…" placeholders. The last rendered rows are now persisted to `localStorage` and repainted the instant the app opens — before it has even reconnected to Roon — then revalidated quietly in the background with no "Loading…" flash. A reopen within 5 minutes does no refetching at all. Covers come straight from the browser's week-long HTTP cache, so it's a flash-free repaint, not a reload.
- Root cause of the sluggish feel was confirmed (via a performance + code review) to be **client-side**, not the backend language: the server work is ~90–95% waiting on sequential Roon Core round-trips, which no rewrite (Rust/C++/.NET) would speed up. This change removes the most visible repeated cost — the full Home rebuild on every open.

### Fixed
- Instant-open review fixes: an empty `200` response while the index is still building right after a restart no longer blanks the hydrated Label-of-the-week / genre rows (the cached rows are kept until real data arrives); the unplayed and random rows now carry independent freshness timestamps so a stale row can't ride a fresh sibling's freshness; and a genuinely empty unplayed result is no longer persisted as cache.

## [1.6.27] — 2026-07-09

### Changed
- **Wall display: bounded the artist-bio cache (`displayArtistBioCache`) at 500 entries**, matching the eviction its sibling `displayContentCache` already had. Found during a performance + code review of the display feature: it was the only cache that grew without a cap, so a streaming-heavy box that never restarts could accumulate one small entry per distinct artist/member name ever played. The review found no correctness bugs in the v1.6.22–v1.6.26 display changes; the O(n) per-request label scan is confirmed off the hot path (served from the 6 h content cache, keyed per track).

## [1.6.26] — 2026-07-09

### Fixed
- **Wall display: the "More on <label>" grid covers are finally selectable — this was the real root cause.** The two crossfade layers (`slide-a`, `slide-b`) both cover the whole screen; the hidden layer only had `opacity: 0`, which does **not** stop it from receiving taps. Because `slide-b` sits on top, whenever a library grid rendered into the lower `slide-a` layer, the empty top layer silently swallowed every tap — so the artist grid (which happened to land on top) worked while the label grid (which landed underneath) did not, regardless of the album offsets being correct. The non-visible layer now has `pointer-events: none`, so taps always reach the grid actually on screen. Verified with a headless render test that taps a cell in both grids and confirms the Play now / Queue panel opens with the tapped album; the same test reproduces the failure when the fix is removed.

## [1.6.25] — 2026-07-09

### Fixed
- **Wall display: covers on the "More on <label>" grid are now selectable (Play now / Queue) — for real this time.** The v1.6.23 attempt started from the labels-index snapshot and tried to match each album *back* to the live album index by title+artist; when the snapshot's stored subtitle came from a different seed source (Qobuz / disk cache) than the live Roon browse rows, the match silently failed and the tiles arrived with no usable offset, so tapping did nothing. The label grid is now built the **same way the working "More from <artist>" grid is** — by iterating the live album index directly and keeping albums whose resolved label matches the now-playing album's label. Every tile is therefore a live album-index entry carrying a current, valid offset. As a side effect this also fixes label grouping for **manually merged labels** (the entry is now looked up by the merge-redirected group key).

## [1.6.24] — 2026-07-09

### Fixed
- **Wall display: artist photos are no longer cropped top and bottom.** Portrait/full-frame band photos were shown with `object-fit: cover`, which fills the screen by clipping whatever doesn't fit — so heads and feet got cut off on tablet/desktop. The photo slide now uses `object-fit: contain`: the whole photo is always shown, letterboxed with black bars on the sides when it's a different shape from the screen, and the slide reserves the bottom strip's height so the full image stays clear of the progress bar.

## [1.6.23] — 2026-07-09

### Fixed
- **Wall display: covers on the "More on <label>" grid are now tappable (Play now / Queue), like the artist grid.** The label grid took its album offsets from the labels index, which is a snapshot that isn't rebuilt when the album index is — so after any library change/reorder those offsets went stale and the covers pointed at the wrong album or an empty slot, making them unresponsive. The label grid now re-resolves every album against the live album index (by title + artist) at request time, so its offsets and artwork are always current; albums no longer in the library are dropped.
- **Same staleness fixed for the labels browser generally** — the labels index is now re-seeded from the fresh album index whenever a library change triggers an album-index rebuild, so browsing a label and playing from it can't land on the wrong album after a reorder.

## [1.6.22] — 2026-07-09

### Changed
- **Wall display: the artist bio card now covers every credited artist.** For multi-artist credits (e.g. "Jeff Beck / Tony Hymas") a Wikipedia bio is fetched for each member (up to 4), and the bio card alternates to the next one on each rotation pass — pinning **Bio** cycles through the members too. Single-artist tracks behave as before.

## [1.6.21] — 2026-07-09

### Fixed
- **Wall display: skipping a track no longer keeps the previous track's video playing.** Content was reloaded per album; the video is per track, so a skip within the same album left the old clip running (the bug that needed a force-close). Content now reloads per track — the album-level parts (photos, review, bio, library grids) are served from cache so the refresh is instant.
- **Wall display: the video starts at the track's live position** (best-effort sync — video edits rarely match track length exactly), instead of always starting from 0 while the song is mid-way.
- A "no video found" verdict now expires after 30 minutes instead of sticking for the whole server session, so transient YouTube API failures don't blank a track's video for good.

### Changed
- **When a track has a video, the display opens straight to it and stays on it** — synced and playing through — unless a mode chip is tapped. Tracks without a video rotate as before. A manual pin still always wins.

### Added
- **Library grid albums are now tappable: Play now / Queue.** Tap a cover on the "More from <artist>" / "More on <label>" screens → a panel offers **▶ Play now** and **+ Queue** to the display's zone (same playback path as the album view). The panel auto-dismisses, and confirms with "Playing ✓ / Queued ✓".

## [1.6.20] — 2026-07-08

### Fixed
- **Wall display: videos from real artist channels now qualify.** The v1.6.19 scorer demanded "official video" in the title on top of the channel match — but genuine artist channels (e.g. Stereophonics) title their uploads plainly ("Artist – Track"), so nothing passed. The artist's own channel (including "Artist Music" / "Artist Official" / VEVO variants) is now trusted outright; the search query and category filter were also loosened so those uploads surface at all (the scorer still rejects Topic audio, teasers, interviews, chat shows, lyric videos, covers and bootlegs).

### Added
- **Wall display: on-screen mode controls.** Tap the screen (or move the mouse) to reveal a chip bar — **Auto** rotates everything; **Art / Photos / Bio / Review / Library / Video** pin that screen. Photos cycle within themselves when pinned; a pinned **Video plays through in full** (and loops) instead of rotating away after N seconds. Chips only appear for content that exists for the current album; a pinned choice survives album changes and re-applies whenever the new album has that content. Controls fade out after 5 seconds.

## [1.6.19] — 2026-07-08

### Changed
- **Wall display videos: official music video or official live performance — or nothing.** Candidates are now scored precision-first: the channel must be the artist's own (or their VEVO); "official (music) video" titles score highest; live versions are accepted only from the artist's own channel. Hard-rejected outright: " - Topic" auto-uploads (static album art with audio — pointless muted), lyric videos, visualizers, covers, reactions, remixes, karaoke, chat-show/fan uploads, and any title missing the track name. Survivors are verified playable (embeddable, public, not age-restricted — age-restricted never plays embedded) with view count as tiebreak. A wrong video no longer beats no video.

### Added
- **Wall display: artist bio card** — the artist's Wikipedia biography is now its own rotation slide (the review card keeps the album text).
- **Wall display: "More from <artist>" and "More on <label>" slides** — cover grids drawn instantly from your own library (album index + labels index, no API keys): other albums by the playing artist, and label-mates of the playing album. Only shown when there are at least 3 to show.

## [1.6.18] — 2026-07-08

### Fixed
- **Wall display: video clips now actually play.** Videos were found but rendered as YouTube's "Video unavailable — Watch on YouTube" card: the search API's embeddable filter is unreliable, and many music videos block third-party embedding. The server now verifies the top 5 results against YouTube's `status.embeddable` flag and picks the first video that genuinely allows embedding; the page also switched to the YouTube IFrame Player API so any failure that still slips through (region blocks, takedowns) is detected and the video is dropped from the rotation — album art returns instead of an error card sitting on screen.
- **Wall display never scrolls and the progress strip always stays on screen** — the page body is pinned to the visual viewport with touch panning disabled (iOS Safari ignores plain `overflow:hidden` for touch drags), so nothing can rubber-band the bar out of view on phones.

## [1.6.17] — 2026-07-08

### Added
- **Wall display** — a Roon-style always-on screen at `http://<server-ip>:3399/display`. Point any tablet or TV browser at it: it follows the playing zone (pin one with `?zone=<name>`) and rotates between **album art**, **artist photos** (fanart.tv, using your existing key), an **album review card** (the same legally-safe Qobuz/Wikipedia text as the album view — Pitchfork text stays link-only), and a **muted video clip** of the playing song (optional — needs a free YouTube Data API key, new field in Settings; without one the rotation simply skips video). A Nest-Hub-style progress strip along the bottom shows track, artist · album, elapsed/total and a thin progress bar.
- **Settings → Wall display**: an on/off toggle and a "rotate every N seconds" slider (5–60s, default 10s). When off, the page shows a notice and **nothing is fetched** — no lookups, no polling work; flipping the toggle brings a mounted display to life within 30 seconds, no reload needed.

## [1.6.16] — 2026-07-08

### Fixed
- **Updates no longer pile up duplicate entries in Roon's "Extension authorizations" list.** The Roon pairing token was stored in `config.json` in the container's working directory — wiped by every docker update — so each new build registered as a brand-new extension and Roon issued a fresh authorization, leaving the old ones behind as ghosts. The pairing state now lives on the persistent data volume (`data/roonstate.json`), with a one-time migration for a running install's existing token, so future updates reconnect with the same authorization. The stale duplicate entries need removing once by hand (Roon → Settings → Extensions → View extension authorizations → Remove the old builds).

## [1.6.15] — 2026-07-08

### Changed — performance pass (the UI had grown sluggish since the Home redesign)

Server:
- **Cover art is now cached in memory on the server** (64 MB LRU) and served with long immutable browser-cache headers. Previously every art request — ~85 per Home render — was a live round-trip through the single Roon websocket, with the Core rescaling each image on demand; that connection also carries all browse/transport traffic, so everything queued behind everything else.
- **The album index no longer rebuilds on nearly every Home visit.** Its staleness window was 10 minutes, so most visits kicked off a full library re-walk that competed with the very render it was serving. It's now a 6-hour safety net — the existing 5-minute count probe still rebuilds promptly when the library is actually edited.
- **Random albums are picked from the in-memory index** (unfiltered requests): removes ~6 Roon browse round-trips + 30 single-item loads from every Home visit and wall refresh. Genre/tag/label-filtered picks still use live browse.
- **Responses are gzip-compressed** (app.js ~75% smaller on the wire). The app's html/js/css deliberately stay revalidate-on-load (cheap ETag 304s) so a new build shows up immediately after an upgrade — no stale-app hard-refresh dance.

Web UI:
- **Home keeps its rows for 5 minutes.** Every Back tap used to rebuild the unplayed + random rows with a fresh random set — ~60 new cover fetches each time. Within the window the existing tiles (and the browser's image cache) are reused; after it they refresh as before.
- **Backdrop blur removed from the bars that float over the scrolling page** (mini transport, filter bar, label-merge bar) — iOS Safari re-blurs everything beneath them on every scroll frame; they're now solid. This was the main scroll-jank source while music was playing.
- **The album view's ambient glow uses a tiny 96px cover** instead of the 800px art (upscaling does the smoothing) — a fraction of the blurred-layer cost during modal scrolling.
- **Tile art is sized to the screen** (devicePixelRatio-aware) instead of always 500px — iPads/desktops were fetching ~2.8× more pixels than they display.
- **The 1.5s transport poll only touches the DOM and localStorage when something actually changed** (track/state/volume signature) instead of rewriting the bar every tick.
- **Below-the-fold Home sections (label of the week, genres) skip rendering until scrolled near** (`content-visibility: auto`).
- Album-of-the-day and the unplayed list now load in parallel instead of one after the other.

### Not changed
- **No rewrite needed:** profiling showed Node CPU is essentially idle — the time went to Roon Core round-trips, image bytes, and browser paint. A Rust port would wait on the same websocket at the same speed; the wins above are architectural and language-independent.

## [1.6.14] — 2026-07-07

### Fixed
- **Landscape Now playing on tablets and desktops** — broken by the v1.6.13 layout change: at ≥720px the modal panel is a centred auto-height dialog, so the height-driven artwork had nothing to size against and collapsed to zero — the screen shrank to a small floating box with no album art. Now playing is now a full-screen view at every size (Roon parity), and landscape tablets/desktops get a proper two-pane layout: tabs centred on top, big album art on the left, track/seek/transport on the right. Verified headlessly at 1400×900, 1080×810 (tablet landscape), 810×1080 (tablet portrait), 390×844 (phone), and short desktop windows (1100×640, 1100×460 — art shrinks, nothing scrolls or clips).

### Changed
- **The share card adapts to long album titles and long artist lists.** Title and artist each wrap onto up to 4 lines (was 3 and 2), and the text automatically steps down in size (title 56→27px, artist 37→21px) until it fits — an ellipsis only appears when even the smallest size can't hold it. King Gizzard's full 127-character "PetroDragonic Apocalypse…" title and five-artist credit lists now render complete on the card.

## [1.6.13] — 2026-07-07

### Changed
- **Now playing screen laid out to mirror Roon's spacing, and it no longer scrolls.** The tabs sit up top beside the corner buttons, the album art moves up directly beneath them and now sizes itself to the space available (bigger on tall phones, smaller on short ones — the whole screen always fits the viewport), and the track/artist/album block moves up under the art. A safeguard restores scrolling on very short desktop windows so the transport can never be clipped out of reach.
- **Bracketed details in the track title get their own line** — e.g. "Hangover Sex (with Viktoria Tolstoy)" renders as the title with "(with Viktoria Tolstoy)" beneath it, smaller and dimmer.
- **Corner buttons reworked on the Now playing screen:** the × is gone; **Share** now sits in its top-right spot, and a new **Home button** in the top-left closes the screen and lands on the Home screen. (Escape and the desktop backdrop still close it too. The album detail view keeps its × and Share unchanged.)

### Fixed
- Code-review findings fixed pre-commit: a no-scroll fallback for sub-480px-tall windows, the artwork's shadow no longer letterboxes off the art on narrow phones, an inert flex rule removed, a redundant state reset removed, and the track-title renderer skips DOM rebuilds on unchanged poll ticks.

## [1.6.12] — 2026-07-07

### Changed
- **Now playing screen reverted to the Roon-style look** (undoes v1.6.9's redesign of that screen only): the amber panel, its equaliser watermark, and the ambient glow on the Now playing tab are gone; the screen is again the clean full-bleed layout with the track title directly under the art. Everything else from recent builds is retained — the album view's blurred-cover backdrop, the Queue tab's tinted panel and glow, and the selectable track rows are all untouched (verified by the full headless regression suite).

## [1.6.11] — 2026-07-07

### Changed
- **Pitchfork written reviews are no longer displayed anywhere in the app (UK-law compliance).** Scores and Best New Music badges stay everywhere they appeared; in place of the review text the app now links to the review on pitchfork.com:
  - **Pitchfork magazine page** — a review's detail view keeps the cover, artist/title, score and BNM badge, shows a short notice, and leads its actions with **"Read on Pitchfork ↗"** (followed by Open in your library / Find on Qobuz / Find on Tidal as before).
  - **Album view "About this album"** — when the review source is Pitchfork, the panel shows no text but keeps the score/BNM in the title line and a **"Read the full review on Pitchfork"** link. Qobuz and Wikipedia editorial descriptions are unaffected and still display in full.
  - **Qobuz/Tidal browser review section** — same treatment; the source link now renders even when there is no displayable text (previously it hid with the text).
  - Enforced **server-side at every response boundary**: `/api/album/extras` emits no description for Pitchfork-sourced entries, and `/api/pitchfork/review` no longer serves (or even fetches) the review page at all — it returns only the local library match, since scores/BNM already ship with the listing items. An exhaustive audit traced every producer and consumer of review text to confirm no path remains; the search results, mosaic cards, Home rows, and share card never carried review text to begin with.
- Side benefits from the review of this change: opening a review's detail no longer performs a throttled full-page scrape of pitchfork.com (the "Read on Pitchfork" link and streaming actions now paint instantly, with the library-match button arriving right after), and the now-dead by-URL scraper and its cache were removed.

## [1.6.10] — 2026-07-07

### Added
- **Selectable tracks in the album view.** Tapping any track row expands it in place with two actions — **Play now** and **Queue** — for that single track (one row open at a time; tap again to collapse). Actions target the selected zone, work with genre/decade/tag/label filters active, and show the usual confirmation toast. Under the hood a new `/api/play-track` endpoint re-resolves the album by offset, finds the tapped track with the same filter the track listing uses (so indexes always align), verifies the track title before firing — if the library changed since the modal opened the tap is re-matched by title, and if the track is gone the app says so instead of playing the wrong thing — then drills into Roon's per-track action menu.
- The shared album drill-in was extracted into one helper used by both album-level and per-track actions (`loadAlbumSession` + `drillActionMenu`), byte-equivalent to the previous behaviour for every existing play path (verified against the old code in review).

### Fixed
- Code-review findings, all fixed pre-commit: the per-track action buttons reuse the standard `.action-btn` recipe at a proper 38px tap target (the first draft's pills were ~31px, below the app's own touch norm); the track-drill response is now sanity-checked so a non-list reply errors instead of reporting false success; the track index is validated as an integer; and `fetchAlbumDetail` now bails if the modal moved to a different album while the response was in flight — previously a cosmetic race, but with live tap handlers on the rows it could have fired a track action against the wrong album.

## [1.6.9] — 2026-07-07

### Changed
- **Album view — the cover now visibly glows under the art.** The ambient backdrop introduced in v1.6.6 was a heavy 48px blur that read as a colour wash; it is now a lighter 30px blur at slightly higher opacity and taller reach, so a faint but recognisable image of the album cover sits beneath the artwork, fading out down the panel. Tuned separately for dark and light themes.
- **Now playing screen — separated from Roon's look, now in the extension's own visual language.** The track title, artist, album link, progress bar and transport controls sit in a Home-style tinted rounded panel (the amber tint — completing all four Home tints inside the modal) with a new cut-off equaliser-bars watermark. The ambient cover glow now shows on the Now playing tab too (previously it was deliberately suppressed there to preserve the Roon-style look). The device and volume controls stay outside the panel so their pop-up menus are never clipped by the panel's watermark cropping. No JS changes — the live transport wiring is untouched.

### Fixed
- **Code-review finding (hover regression)** — the new panel-scoped translucent hover fill out-ranked the play/pause button's solid hover fill, which would have left its icon nearly invisible on desktop hover. The rule now excludes the play/pause button (`:not(.np-playpause)`), and the retired base hover rule that all three transport buttons no longer reach was removed rather than shadowed. Error class: a broad descendant rule silently out-ranking a sibling component's state style — caught by the simplification/removed-behaviour review angles before commit.

## [1.6.8] — 2026-07-07

### Fixed
- **Settings "Check for updates" said "tap Update below" — but there was no button.** The real Update button lives in the in-page update banner, which (a) sits *behind* the full-screen Settings sheet, (b) isn't re-checked when you tap the Settings button (it refreshes on a 15-minute timer), and (c) stays hidden for the session if you ever dismissed it with "Later" — so the promised button was invisible or absent. Now the Settings button itself becomes the action: after a check finds an update it turns into an accent-highlighted **"Update to vX"** (or "Roll back to vX") button with the release notes shown beneath; tapping it closes Settings and installs through the existing banner, whose download/unpack/restart progress is then visible. Error class: UI copy referencing a control in a different component without verifying it is reachable — the fix reuses the banner's single apply/progress implementation rather than duplicating it.
- **Code-review finding (stranded button)** — the first draft left the Settings button disabled at "Updating…" with no reset path, so if the install failed the button was dead for the session. It now resets to "Check for updates" at hand-off; the banner owns all progress, error, and retry state.

## [1.6.7] — 2026-07-06

### Changed
- **Queue tab refresh — the Now-playing Queue screen now speaks the same Home visual language as the album view.**
  - The whole Queue pane (track count summary + list) sits in a Home-style tinted rounded panel — the Not-played blue-grey — with a new cut-off "play queue" watermark motif (stacked list bars + play triangle), sharing the exact panel/watermark CSS recipe with the Home sections and the v1.6.6 album-view panels.
  - The ambient blurred-cover glow is enabled on the Queue tab (it stays off on the Now playing tab, which keeps its clean Roon-style look): the playing album softly tints the area behind the tab chips. The transport poll keeps the glow (and the big art) in sync when playback crosses an album boundary — via a small bridge between the modal and transport code, since they live in separate closures.
  - Queue rows use the same translucent hairline separators as the album view's Tracks panel (now a shared `--panel-hairline` variable so the two lists can't drift apart), with the now-playing row highlight, divider, and tap-to-play behaviour unchanged.

### Fixed
- **Code-review finding (unreachable sync)** — the first draft put the glow-sync call inside the now-playing screen updater, which early-returns unless the *Now playing* tab is active; the glow would have gone stale on the exact tab where it is visible. The art/ambient update now runs before that gate whenever the np-mode modal is open, and the fix is verified end-to-end headlessly (album change while sitting on the Queue tab updates both). Error class: new code placed behind a pre-existing guard that excludes the state it serves — caught by two independent review angles before commit.
- **Code-review finding (:active flash lost)** — the Queue tab's new id-scoped `:hover` background out-ranked the base `:active` accent flash on tappable rows during a press; the accent flash is restated at higher specificity so tap feedback is preserved in both themes.

## [1.6.6] — 2026-07-06

### Changed
- **Album detail refresh — the album view now speaks the Home screen's visual language.**
  - **Ambient cover glow** — the album's own artwork, heavily blurred and faded, washes the top of the detail panel so every album subtly tints its own view (dark and light theme tuned separately; decorative only — never intercepts taps, hidden when the album has no art, and reuses the exact same image URL as the cover so no extra download happens).
  - **Home-style panels** — the Tracks list and "About this album" sections now sit in the same softly-tinted rounded panels as the Home rows, complete with the cut-off corner watermark treatment: the vinyl-record motif (shared with Home's Random albums row) on Tracks, and a new oversized quotation-marks motif on the review panel. Watermarks run fainter than Home's because these panels carry dense text.
  - **Softer track rows** — translucent hairline separators replace the solid border colour, which fought the tinted background; the list's framing top border is gone since the panel itself now frames it.
  - The Now playing screen (transport-bar view) and Queue tab are deliberately untouched.
- **Shared panel infrastructure** — the modal panels reuse the Home sections' CSS rules (shell, watermark placement, theme flip, vinyl mask) rather than duplicating them, so future tweaks to the Home panel recipe automatically stay in sync with the album view. (Code-review finding: an earlier draft duplicated the ~500-char SVG mask data-URI and the placement block verbatim.)

### Fixed
- **Code-review finding (stacking context)** — an early draft gave the modal's scrolling body `z-index: 1`, which would have trapped the now-playing device/volume popovers *below* the pinned close/share buttons on short viewports. The body is now positioned without a z-index (paints above the glow by DOM order, creates no stacking context), preserving the popovers' original paint order. Error class: CSS stacking-context introduced on a shared container — caught by the cross-file tracer angle before commit.

## [1.6.5] — 2026-07-06

### Fixed
- **Clean `docker build` — the npm install warnings and both audit vulnerabilities are gone.**
  - **`2 vulnerabilities (1 moderate, 1 high)`** — both were ASF-parser infinite-loop advisories in `music-metadata@7` and its bundled `file-type` (GHSA-v6c2-xwv6-8xf7, GHSA-5v7r-6r5c-r473), used by the file-tag label scan. Upgraded to `music-metadata@11.13.0`; the scan already loaded it via dynamic `import()` with a shape-tolerant shim (and already handled v11's object-style comment tags), so the parsing code needed no changes — verified against every tag field the scan reads (label, organization, album, albumartist, year/dates, Bandcamp comment URLs). `npm audit`: **0 vulnerabilities**.
  - **`npm warn deprecated node-uuid@1.4.8`** — pulled in by Roon's own `node-roon-api`, which uses it only for `uuid.v4()`. An npm override now substitutes the maintained `uuid@11` (a drop-in for that call), so the deprecated package isn't installed at all; verified the Roon discovery layer (sood.js) boots and generates ids through the alias.
  - **`npm warn deprecated prebuild-install`** — comes from `better-sqlite3`, and even its newest release still depends on it, so it can't be fixed by upgrading. The Dockerfile's install now runs `--loglevel=error` (with `--omit=dev --no-audit --no-fund` and the update-notifier off), so the unavoidable warning — plus the audit/funding/new-npm-version chatter — no longer clutters the build output, while real errors still print.

## [1.6.4] — 2026-07-06

### Added
- **Global search** — the Home search box now searches everything, not just the Roon library. Below the instant library results (Artists / Labels / Albums), three new sections appear as they load: **Qobuz** and **Tidal** catalogue matches (only when that service is connected; tapping a result opens that service's browser pre-seeded with a search for the album, ready to favourite), and **Pitchfork reviews** (matches from the review lists, with score/BNM chip; tapping one jumps straight to the full review). External sources ride a longer debounce than the local search (600ms — they're rate-limit-sensitive network calls), are each failure-tolerant (a blocked or disconnected source simply contributes no section), share one 10s deadline so a slow source can't stall the response, and can surface matches even when the library has none.
- New endpoint `GET /api/search/external` (no Roon required); Pitchfork review-list builds now dedupe concurrent callers (a search racing the Pitchfork page opening no longer scrapes twice), and repeated failed Qobuz re-logins from stale saved credentials are deduped + backed off for 60s instead of retrying on every search (an explicit Settings save is never blocked).

### Fixed
- **Pitchfork page × now sits top-right on the title row**, matching the Qobuz/Tidal browsers — it previously wrapped below the title (the v1.5.100 title-row rule was scoped to only those two overlays).
- From the pre-commit review of this feature: opening an artist from an album modal mid-search no longer lets late-arriving external results append under the artist view; a library search failure can no longer mix the previous query's results with the new query's external sections, and external arrivals no longer wipe the Roon-disconnect/error banner (only the "No matches" one); external sections now survive a slower-than-external library response; external cover art gets a clean placeholder on a dead URL; and an empty Pitchfork tab response is no longer pinned for the session (retries next visit, matching the backend rule).

## [1.6.3] — 2026-07-05

### Fixed (found by a 3-agent, 8-angle review of the v1.6.2 parser/mosaic changes)
- **Both Pitchfork tabs were rendering oldest-first.** The state-walk's traversal order is the reverse of the page's display order (verified against the live pages: 95/95 and 29/29 pairs ascending), so month-old reviews appeared at the top. Listings are now sorted newest-first by pubDate; verified end-to-end through the real route against the captured live pages (Latest topped by its newest review, Best New Music topped by Pitchfork's current Best New Album).
- **The Latest tab's RSS fallback never ran on the most likely failure** — a network error/403 from the listing page threw before the fallback was reached (only an *unparseable* page fell back). A blocked listing now falls back to RSS, and only when both sources are down does the page show "couldn't load" (all three paths covered by tests).
- **Old-Safari (≤14) covers rendered as blank tiles** — the cover image used the `inset` shorthand, which that Safari doesn't support, exactly the `aspect-ratio`/`inset` fallback class documented in v1.5.99. Converted to longhand `top/left` (also on the ♪ fallback glyph).
- **Card-title legibility**: the gradient scrim under the overlaid album/artist text was near-transparent where the first title line sits on small tiles; strengthened plus a subtle text shadow, so titles stay readable on light covers.
- Hardened the title extraction (an empty-after-stripping `dangerousHed` now consults the `source.hed` fallback; non-string fields can no longer render as "[object Object]"), removed a redundant entity-decode pass (and a decode-before-strip order bug in the RSS parser), dropped the unused `blurb` payload field, and rewrote the stale "two data paths, merged" architecture comment to describe the current single-source-plus-fallback design.

## [1.6.2] — 2026-07-05

### Fixed
- **Best New Music tab now populates, and Latest reviews now show their scores.** The listing-page parser was matching against a guessed JSON shape and finding nothing (so Best New Music was empty and Latest had no score badges). Rewritten against the real Pitchfork page structure — each review item is read from `contentType:"review"` objects (`dangerousHed` title, `subHed.name` artist, `ratingValue.score`/`isBestNewMusic`, square `image.sources` covers) — verified against the live pages (96 latest / 30 best, every item with score, cover and artist).
- Because the listing now reliably carries square cover art + all fields, it's the primary source for both tabs; the RSS feed is kept only as a Latest-tab fallback if the listing shape ever changes again. This removes the earlier RSS↔listing URL-join entirely.

### Changed
- **Deliberate "woven" mosaic layout** — the tiles now alternate one large square with two small squares stacked beside it, the large one switching sides row to row, for a magazine feel. Album/artist sit in a gradient overlay on each cover, and every tile is force-squared (an absolutely-positioned cover) so an off-square source image can no longer make tiles uneven — the accidental little/large sizing in the first build.

## [1.6.1] — 2026-07-05

### Added
- **Pitchfork page** — a new full-page, magazine-style browser reached from the side menu (**≡ → Pitchfork**). Two tabs: **Latest Reviews** and **Best New Music**, shown as a responsive grid of cover-art cards with the Pitchfork score overlaid and a Best New Music badge. Tap a card to open a detail view with the full review, then act on it:
  - **▶ Open in your library** — appears when the album is matched in your Roon library; opens the existing album modal (play/queue from there).
  - **Find on Qobuz / Find on Tidal** — jumps to that streaming browser pre-seeded with a search for the album (Tidal shown only when connected), so you can favourite it (which is what makes it appear in Roon).
  - **View on Pitchfork** — opens the original review.
  - Data comes from Pitchfork's public RSS album-reviews feed (reliable cover art) enriched by the review-listing pages for the score, Best-New-Music flag and artist name; cached ~6h (Pitchfork publishes only a few reviews a day). No API key. The single-review scraper that already powered the album modal's editorial review is reused, and the review-body extraction is now a shared helper so the two paths can't drift apart. The magazine is theme-aware and the page's back button (and Android/browser Back) behaves naturally.

### Fixed (found by the 8-angle pre-commit review of this feature)
- Switching tabs while reading a review could leave a phantom navigation entry (Back landed on the wrong list); the tab chips are now hidden inside a review, so you return to the list first.
- The "Find on Qobuz/Tidal" hand-off now waits for the Pitchfork overlay to actually close before opening the streaming browser, instead of relying on a timer — fixes a potential race (notably on iOS Safari) that could make the streaming overlay immediately close itself.
- A transient Pitchfork block/timeout is no longer cached: a failed review body, and an unparseable listing page, both retry on the next visit instead of being stuck for the 6h cache window.
- The RSS↔listing merge now joins on a trailing-slash-normalized URL so scores/Best-New-Music/artist reliably attach to the Latest cards.
- Guarded a punctuation-only album title from false-matching a library album; added the missing cover-art fallback to the review detail head; and made the review listing survive a Roon-disconnect / block with an honest "couldn't load" state rather than an empty page.

## [1.6.0] — 2026-07-04

### Fixed (found by an 8-angle multi-agent review of the v1.5.101–116 Home redesign)
- **A genre/tag filter no longer gets silently wiped on reload.** `bootstrap()` always landed on unfiltered Home after pairing, and `showHome()` unconditionally cleared any filter restored from `localStorage` — so reopening the app after filtering to a genre always dropped back to unfiltered Home and deleted the saved filter. A restored filter now re-opens the filtered wall instead.
- **"Browse by genre" could get stuck empty for the rest of the session** after a single transient load failure — the "loaded once" flag was set before the fetch resolved, unlike the sibling "Label of the week" row, which already retried correctly. It now only marks itself loaded once genres actually render, so a cold-cache or network blip on the first Home visit no longer permanently disables the section.
- **Roon Core disconnecting mid-session showed misleading empty states on Home** ("Nothing here yet", "No albums.", "Couldn't load genres.") instead of a "Waiting for Roon Core" message — four of the five Home data loaders never checked for the 503 "not paired" response the way the older wall loader always has. All four now show the same Roon-disconnected message.
- **Opening a second artist view after an improper exit could restore corrupted content.** `artistViewActive` and its DOM snapshot were never cleared by `showHome()`/`showWall()` (unlike the equivalent `labelsActive` flag), so leaving an artist view via the shared Back button left it stuck active; a second artist view opened afterward would restore the first view's stale snapshot on exit instead of Home. `showHome()`/`showWall()` now exit the artist view the same way they already exit the Labels browser.
- **The artist view never synced the shared top bar**, so depending on where you opened it from, either a second empty back affordance or none at all sat next to its own "← Back" button. It now hides the shared Back/Refresh/Search on entry and restores whatever the previous screen had on exit.
- **A resize (iOS Safari's URL bar collapsing, iPad split-view) could silently replace an active search or the "Not played" full grid with the random wall** — the resize handler only excluded the Labels browser. It now also skips Home, an active search, and the unplayed-wall view.
- **A search query left visible when the user detoured through Labels** — leaving Home for the Labels browser and returning didn't clear the search box, so a stale query reappeared even though its results had already been discarded. `showHome()`, `showLabelsList()`, and `showLabelAlbums()` now clear search state the same way the wall view already does.
- **Search result-count/progress text ("3 albums, 1 label", "Building index… NN%") was permanently invisible** on Home's relocated search box — a leftover `search-status-hidden` class unconditionally hid it regardless of content.
- **The "Random albums" row re-fetched ~30 albums with fully sequential Roon round-trips on every single Home visit** (menu → Home, or the Back button), not just once on first load as before the Home redesign — a visible delay on every revisit. The album loads are now batched (8 at a time) instead of one-by-one.
- Tapping an artist name on an album opened from inside the Labels browser could leave the Labels-browser flag stuck active while viewing the artist; it's now cleared the same way the equivalent search result chip already does.

### Changed (reuse / simplification, same review)
- Deduplicated a hand-rolled cache, a SQL "played since" query, an FNV-1a hash loop, and an album-count regex that each existed in two places — now shared helpers (`makeTtlCache`, `getPlayedTitlesSince`, `fnv1aHash`, `parseAlbumCount`).
- Removed dead code left over from the Home redesign: an unused `sessionStorage` cache, the fully-unused `openSearch`/`closeSearch` functions and their inert `#search-toggle` button, a no-op `loadAlbumCount()`, and an unnecessary `typeof` guard.
- The four Home watermarks (clock/vinyl/tag/note) now each ship one SVG used as a CSS mask (with a `-webkit-mask-image` fallback) instead of two near-identical SVGs per motif for light/dark — the theme swap is now a color change, not a second image.
- Two silent `catch (e) {}` blocks now carry the explanatory comment this project's conventions require.

### Changed ("Play something unheard")
- **"Play something unheard" now considers an album unheard if it hasn't been played in the last 12 months** (previously: only albums with *zero* plays ever, all-time — a much stricter bar than the "6 months" it was assumed to use, and stricter than the README's description of a 30-day fallback, which was never actually implemented). A 12-month window naturally includes never-played albums too, and gives a much larger eligible pool on libraries with real listening history, so the plain-random fallback (used once the whole library has been heard recently) should trigger far less often. Applies to both the topbar button and its Apple Shortcuts twin (`/api/shortcut/play-unheard`); the two near-identical implementations were also merged into one shared `pickUnheardAlbum()`.
- **Reminder: "heard" is entirely self-tracked**, not sourced from Roon. This extension has no Roon API available to it that reports a library-wide last-played date — it only knows about a play if it was running and connected to Roon Core while that play happened (via `scrobbleUpdate`, which watches live zone transport state). Plays from before this extension was first installed, or during any downtime (container stopped, update in progress, etc.), are invisible to it. If Roon ever exposes real per-album/track last-played data through the extension API, that would let this feature (and "Not played in 6 months" on Home) work off Roon's own history instead.

## [1.5.116] — 2026-07-04

### Added
- **"Browse by genre" panel now has a music-note watermark** — solid-filled beamed eighth notes, matching the clock, vinyl and tag watermarks in size, rotation, opacity and top-left cut-off crop. All four Home sections now carry a themed watermark.

## [1.5.115] — 2026-07-04

### Added
- **"Label of the week" panel now has a tag watermark** — a solid price/luggage-tag silhouette (with its string hole), matching the clock and vinyl in size, rotation and top-left cut-off crop.

### Changed
- **All Home watermarks are now solid-filled silhouettes instead of thin outlines**, so they stand out more — the clock (Not played), vinyl record (Random albums) and tag (Label of the week). Slightly higher opacity too. Still clipped inside each coloured panel, theme-aware, behind the tiles, non-interactive.

## [1.5.114] — 2026-07-04

### Added
- **"Random albums" panel now has a vinyl-record watermark** — a line-art record (grooves, centre label, spindle hole, a shine glint) cropped at the panel's top-left corner, matching the clock's size, rotation, thickness and cut-off effect. Contained within the coloured section, theme-aware, behind the tiles, non-interactive. The two panels' watermarks now share one set of placement rules (only the artwork differs), ready for the remaining sections.

## [1.5.113] — 2026-07-04

### Changed
- **"Not played in 6 months" clock watermark is now contained within the coloured panel** — it no longer spills onto the page outside the section. The cut-off crop at the panel's top-left corner is kept (that's the effect you liked), but the art is clipped to the panel. The clock is also **bigger** and drawn with **slightly thicker lines**.

## [1.5.112] — 2026-07-04

### Changed
- **The "Not played in 6 months" clock watermark now has real artistic flair.** It's larger, tilted, and moved to the **start (top-left) of the bar**, where it deliberately spills **outside** the coloured panel onto the page — and it's a proper clock face with tick marks, hands, and sweeping motion arcs (time flying by). The spill is up-and-left only, so it never adds a horizontal scrollbar on any screen; the title stays fully legible above it; theme-aware and non-interactive as before.

## [1.5.111] — 2026-07-04

### Added
- **Faint themed artwork on the "Not played in 6 months" panel** — a subtle line-art clock watermark (time gone by) now sits behind that section's coloured panel, reflecting its theme. It's a self-contained inline SVG (no external requests), theme-aware (light art on the dark panel, dark art on the light panel), clipped to the rounded panel, and sits behind the tiles at very low opacity so it never obscures album art or intercepts taps. First of the coloured sections to get themed art.

## [1.5.110] — 2026-07-04

### Fixed
- **Tapping an artist in Search now shows that artist's albums again** (their own albums plus "Also appears on"), instead of falling back to the Home sections. Regression from the Home-landing redesign: the search artist-chip clears and hides the results grid before opening the artist view, but the artist view rendered its albums into that still-hidden grid while the Home rows showed through. The artist view now reveals the grid and hides the Home view, and its "← Back" button restores exactly the screen you came from (the Home landing, or the album wall you were browsing).

## [1.5.109] — 2026-07-03

### Fixed
- **"Label of the week" now shows as a single-row carousel on every screen** (phone, landscape tablet, desktop). On desktop it was wrongly wrapping to 3 rows and leaving a large empty area; it's now one horizontal row that scrolls, like the other rows.
- **"Not played in 6 months" and "Random albums" rows are centred** in their panels when the albums don't fill the full width, instead of hugging the left edge (`justify-content: safe center` — still left-aligns and scrolls when the row overflows, so nothing is clipped).

## [1.5.108] — 2026-07-03

### Fixed
- **Rock/Metal no longer pulls in soft-rock, singer-songwriter and pop albums** (Carole King – Tapestry, James Taylor, Madonna, Duran Duran, Bryan Ferry, Ultravox). The old rule keyed on the word "rock", which appears in soft/pop styles ("Soft Rock", "Contemporary Pop/Rock", "Adult Alternative Pop/Rock", "Folk-Rock"), so those leaked in. The classifier now: (1) skips the generic "Pop/Rock" catch-all; (2) routes anything with the literal word "pop" to Pop; (3) excludes soft styles with no "pop" (Soft Rock, Folk-Rock, Adult Contemporary, Singer/Songwriter, Easy Listening, New Age); (4) sends only genuinely hard, guitar-driven styles (metal, hard/album/arena/classic/garage rock, punk, grunge, prog, psychedelic, shoegaze, indie rock, britpop, goth, industrial, ska, rap-rock…) to Rock/Metal; (5) sends remaining pop-family styles (Dance, Disco, Synth, New Wave, Soul, R&B, Funk, Motown) to Pop.

### Added
- **"Not played in 6 months" title is now a button** — tap the section header to open a full-screen grid of albums you haven't played in 6 months (up to 96), with a Back button to Home.

### Changed
- **Desktop: "Not played in 6 months" and "Random albums" now fill the width** — 2 rows on desktop (was 3 short, half-empty rows) so wide screens show more albums per row. Phones/tablets unchanged. The Home "Random albums" row now fetches 30 albums (was 24).
- **"Label of the week" carousel is taller** — 1 row on phones, 2 on tablets, 3 on desktops — and now features labels with at least 6 albums (was 3) so the row fills out.
- **Each Home section has its own tinted panel** — grey (not played), teal (random), violet (label of the week), amber (browse by genre) — muted in dark mode, pastel in light mode, so the sections read as distinct blocks.

## [1.5.107] — 2026-07-03

### Added
- **"Random albums" on the Home screen** — the random-albums shuffle (previously only in the side menu) now also appears as a Home carousel of 24 random albums, refreshed on every Home visit so it's always freshly random. Tapping the **Random albums ›** header opens the full random wall. Reuses the existing `/api/random-albums` endpoint (no new backend).
- **"Label of the week" on the Home screen** — one record label is featured for the whole ISO week (Mon–Sun), chosen deterministically so it's stable all week and rotates every Monday. Shows a carousel of that label's albums; tapping the **Label of the week: … ›** header opens the full label view. New endpoint `GET /api/home/label-of-the-week` (labels with ≥ 3 albums, deterministic per-week pick, cached ~1h). The section stays hidden until the background labels scan has produced a qualifying label, then retries each visit until it populates.
- Both new sections reuse the responsive `.home-carousel` layout: single row on phones, 2 rows on landscape tablets, 3 rows on desktops.

### Changed
- **Better separation of Rock/Metal from Pop in "Browse by genre"** — the old rule ("any Pop/Rock sub-genre without 'pop' in its name → Rock/Metal") swept in indie-pop, singer/songwriter and adult-contemporary styles. The classifier now uses curated allow-lists: rock/metal sub-genres (metal, punk, grunge, prog, shoegaze, indie rock, …) go to **Rock/Metal**, pop sub-genres go to **Pop**, and unrelated styles (Singer/Songwriter, Adult Contemporary, Easy Listening, …) are excluded rather than dumped into Rock/Metal.
- **"Browse by genre" now shows an even 12 buttons** so the grid rows are balanced on every screen. Rock/Metal and Pop are guaranteed slots; the rest are the library's biggest genres. Column counts adjusted (2 / 3 / 4 / 6) so 12 buttons always fill full rows with no lone trailing card.

## [1.5.106] — 2026-07-03

### Changed
- **"Browse by genre": the Pop/Rock parent is split into "Rock/Metal" and "Pop" buttons.** Roon files rock, metal, punk, indie, etc. as sub-genres under a single "Pop/Rock" parent. The Home genre buttons now split it: sub-genres whose name contains "pop" form the **Pop** button, everything else forms the **Rock/Metal** button. Tapping a button picks a random sub-genre from that group (weighted by album count) and shows its albums; the top-bar breadcrumb shows the group name. This replaces the earlier R&B→Metal swap (Metal is a Pop/Rock sub-genre, now reachable via Rock/Metal).
- **Nested genre filter** — the genre filter now supports a parent (`filter_parent`), so a sub-genre nested under a parent genre resolves correctly across browse, album detail, and play. New endpoint `GET /api/home/genre-groups` enumerates and classifies the Pop/Rock sub-genres (cached 30 min).

## [1.5.105] — 2026-07-03 — Home redesign (phase 2 fixes)

### Fixed
- **"Album not found at offset …" when opening a Home tile after viewing a genre** — and the related **genre name lingering in the top bar back on Home**. Both had the same cause: the active genre filter wasn't cleared when returning to Home, so Home's full-library album offsets were resolved against the (smaller) genre-filtered list and fell out of range. Returning to Home now clears the filter (and its breadcrumb), and Home tiles always open unfiltered regardless of any active filter.

### Changed
- **Search box moved into the top bar**, beside the hamburger (both visible), on the Home screen — instead of sitting in the Home content.
- **"Browse by genre": R&B replaced with Metal** — the R&B card is swapped for the library's Metal genre (or dropped if there's no Metal genre).

### Added
- **Album of the day** — one completely random album shown first in the "Not played in 6 months" row, chosen fresh each day (stable through the day). On iPad/desktop it appears once, top-left. Once you've played it, it disappears until tomorrow's pick. New endpoint `GET /api/home/album-of-the-day`.

## [1.5.104] — 2026-07-03 — Home redesign (phase 2)

### Changed
- **Album counts removed from every screen** — the topbar breadcrumb now shows just the genre/label name (no "N albums"), the labels list header shows "Labels" (no count), and the library-total line was removed from Settings.
- **Search moved to the top of the Home screen** — a permanent search box sits above the Home sections instead of living in the side menu. Typing shows results in place of the sections (the box stays put); clearing returns to the sections. The Search item was removed from the side menu.
- **Play Now no longer closes the album view** — playing (Play Now / Shuffle / Radio) from an album's detail page keeps the page open so you stay on the album.
- **"Not played in 6 months" fills more of the screen on bigger displays** — single row on phones, **2 rows on landscape tablets**, **3 rows on desktops** (horizontally scrollable), and the section now fetches enough albums to fill them.
- **"Not played in 6 months" stands out with a coloured panel** — a pale grey panel in dark mode, a soft blue panel in light mode.

### Added
- **Back-to-Home button** in the top bar, shown on every screen you navigate to from Home (random wall, genre grid, labels).
- **Refresh (shuffle) button** in the top bar, shown on the random-album and genre grid screens — reshuffles the current grid (keeps the active genre).

### Dev
- Added `scratchpad/smoke.js` runs to pre-flight — a DOM-stub harness that executes the app's top-level IIFEs and fails on any startup throw (the v1.5.103 crash class).

## [1.5.103] — 2026-07-03

### Fixed
- **Blank screen on load (startup crash).** `let albumCount = computeAlbumCount()` runs during the app's initialisation, but `computeAlbumCount` references the `const PHONE_WALL` that was declared *after* it — a temporal dead zone. On phones this threw `ReferenceError: Cannot access 'PHONE_WALL' before initialization`, which aborted the whole app IIFE, so nothing rendered (blank page, not even the "Waiting for Roon" banner). Moved the `PHONE_WALL` declaration above its first use. (Latent since v1.5.101; exposed once the Home view depended on the same init path completing.)
- **Error class:** the v1.5.66 "declaration-after-use temporal-dead-zone" startup-crash class. `node --check` can't catch it (it's valid syntax), and there's no browser in the build environment to run the load-time check. Added a DOM-stub smoke harness (`scratchpad/smoke.js`) that executes the app's top-level IIFEs under a stubbed `window`/`document` and fails on any synchronous startup throw — it reproduces this exact error on the broken build and passes on the fix.

## [1.5.102] — 2026-07-03

### Added — Home redesign (phase 1)
- **Home landing page with sections.** The app now opens on a Home view instead of the raw album wall:
  - **"Not played in 6 months"** — a horizontal carousel of albums with no play in the last 6 months (backed by the play history), reusing the standard album tile → detail modal (all metadata retained). New endpoint `GET /api/home/unplayed?months=6&count=N`.
  - **"Browse by genre"** — the top 10 library genres (biggest first) as cards; tapping one opens that genre in the album wall at the device-appropriate grid size. Reuses the existing genre filter and `/api/filters/genres`.
- **Pop-out side menu (hamburger).** A drawer slides in from the left. **All former top-bar buttons now live in the menu as icon + label** — Filter, Labels, Qobuz, Tidal (shown only when connected), Play something unheard, Search, Settings — plus **Home** and **Random albums**. The top bar now shows just the hamburger, decluttering it. Menu items trigger the original controls (unchanged behavior); backdrop tap and Escape close the drawer.
- The album wall is reached from the menu ("Random albums") or by tapping a genre/filter; it loads lazily on first entry and keeps the v1.5.101 phone-fit sizing.

### Notes
- This is phase 1 of the redesign. Still to come: separate Qobuz/Tidal "new releases in the last 30 days" carousels (excluding albums already in your library), and a Pitchfork magazine area.

## [1.5.101] — 2026-07-02

### Changed
- **Phone portrait wall now shows 4 rows, fitted to the screen without scrolling** — the wall targets 4 rows of 3 albums (12 total) and sizes the artwork to exactly fit the visible area. When the layout is width-limited the tiles stay at their natural full size; only when the viewport is short does the art shrink a little so all 4 rows still fit rather than overflowing into a scroll. Falls back to 3 rows on very short phones (art would otherwise get too small). Re-fits on viewport resize.
- **Slightly shorter mini transport bar** — trimmed vertical padding (13→10px) and phone button sizes, and reduced the reserved clearance below the wall (96→80px), giving the grid more room for the 4th row.

### Fixed
- **Wall row count under-filled on tall phones** — the previous measurement divided by `main.clientHeight` (which includes the padding reserved for the transport) and, on the very first call, ran before layout and fell back to a guess — so tall phones under-filled to 3 rows with dead space below. The new sizing measures the true content box (subtracting `main`'s padding) and derives the tile size that makes the target rows fit, so the outcome no longer depends on call timing.
- **Error class:** measurement-vs-layout mismatch (dividing by a height that included reserved padding, plus a pre-layout first call). Resolved by measuring the real content box and solving for tile size instead of counting rows against an approximate height.

## [1.5.100] — 2026-07-02

### Changed
- **Bigger top-bar buttons on phones** — the persistent "N albums" count has been removed from the top bar (it crowded the controls and forced tiny 34px buttons). The buttons now grow to 40px on typical phones, sized down in tiers (37px / 33px) only on narrower widths so all controls still fit one row without overflow down to 320px. The library album total moved to the Settings sheet ("N albums in the library"). The top-bar readout is kept only for transient context — the active filter value and the labels-browser breadcrumb — and is hidden on the plain wall.
- **Qobuz/Tidal overlay close button on the title row** — the × now sits top-right on the same line as the "Qobuz"/"Tidal" heading instead of wrapping onto its own line below it. Scoped to those two overlays; the Settings and Filter sheets are unchanged.

## [1.5.99] — 2026-07-02

### Fixed
- **Old iPad (Safari < 15) rendered a broken wall grid** — ragged, unequal columns with tile text colliding between neighbours. Root cause: `aspect-ratio: 1/1` (the rule keeping covers square) is ignored by Safari before 15, so each cover's intrinsic image size inflated/deflated its grid track. Fixed with the classic padding-top square fallback + absolutely positioned artwork inside `@supports not (aspect-ratio: 1/1)` — old Safari gets uniform square tiles back (wall, label tiles, and album-modal art); modern browsers are untouched. Also converted all `inset: 0` shorthands (unsupported < Safari 14.1) to longhands — this was silently breaking the album modal and other overlay backdrops on the same devices.
- **Phone wall always rendered exactly 9 albums, leaving a dead bottom third on tall phones** — `computeAlbumCount()` hardcoded `return 9` for any phone. It now measures the real grid area and fills as many 3-column rows as fit (e.g. 12 albums on a Pro-class iPhone), min 9, capped at the server's 96.
- **Phone title/artist sizing rules were dead CSS** — the phone typography block sat *before* the base rules with equal specificity, so source order made phones silently render the desktop 14px sizes. Moved after the base rules (and the 2-line title clamp now also applies below 360px viewport width).
- **Error class:** the iPad bug was *modern-CSS-without-fallback* (aspect-ratio, inset) — fixed with `@supports`-gated fallbacks and longhands; the dead phone CSS was an *equal-specificity source-order* trap — documented in place so the block isn't moved again.

### Changed
- **Compact top bar on narrow phones (≤ 479px)** — the nine controls shrink to 34px with tighter gaps so the album count no longer truncates to "8,07…".
- **Denser phone wall** — tighter grid gutters (12×8px) and a slimmer tile text block (12px 2-line titles, 10.5px artist) so more music fits each screenful.

## [1.5.98] — 2026-07-02

### Changed
- **Qobuz top-bar button now shows the Qobuz "Q" logomark** (open ring, centre dot, diagonal tail — line-style mark from Arcticons, CC BY 4.0) instead of the generic music-note icon, matching the Tidal button's branded diamond mark. Rendered at the same stroke weight as the neighbouring icons (48-unit viewBox with a proportionally scaled 3.6 stroke).

## [1.5.97] — 2026-07-02

### Added
- **Tidal browser with full Qobuz feature parity** — a second streaming-service browser alongside Qobuz:
  - Catalog search (debounced live search, paged 50 at a time, artist matches strip), artist discographies, and browse tabs (New Releases, Top Albums, Rising, Recommended).
  - Favourite toggle (♥ ⇄ ✓ Added) on every album — adding to your Tidal favourites is what makes an album appear in Roon — plus the tap-for-detail review view.
  - **Separate top-bar button** with the Tidal diamond mark, shown **only while a Tidal account is connected**; the Qobuz button is unchanged.
  - **Login via Tidal's OAuth device flow** (Settings → Tidal account → Connect): the extension shows a code and a link to Tidal's own authorization page — your password is never entered into the extension; only tokens are stored. Access tokens are refreshed silently server-side.
  - Uses the unofficial Tidal API with the Lyrion/LMS Tidal plugin's client credentials — browse/search/favourites only, **no streaming and no downloading** (Roon streams); against Tidal's ToS and may break at any time, same caveats as the Qobuz integration.
  - New: `lib/tidal.js`; routes `/api/tidal/{new-releases,featured,search,artist-albums,favorite,unfavorite}` and `/api/settings/tidal{,/start,/status,/disconnect}` — browse responses share the exact shape of their Qobuz counterparts.
- **Service-generic frontend browser** — the Qobuz overlay code was refactored into a single `initServiceBrowser(config)` factory that now drives both the Qobuz and Tidal overlays (one implementation, two instances; Qobuz behaviour byte-identical, verified by a dedicated regression review). The backend favourite-ids cache (60 s, in-flight dedup, stale ceiling) and featured-list cache (10 min) were likewise generalized into shared factories used by both services.

### Fixed (found by the multi-agent pre-commit review of this feature)
- **Device-flow robustness** — Tidal's schemeless authorization links are now prefixed with `https://` (a raw `link.tidal.com/XXXXX` href resolved relative to the extension and 404'd); RFC 8628 `slow_down` stretches the poll interval instead of killing the login; transient network blips during the server-side poll retry 3× instead of failing the login one-strike; concurrent Connect taps are generation-guarded so the shown code always matches the polled device code.
- **Token lifecycle** — access-token refreshes are single-flight (parallel route calls no longer race refresh-token rotation); a revoked/expired refresh token (`invalid_grant`) now degrades cleanly to "Not connected" (clearing the stored connection and hiding the top-bar button) instead of returning 502 forever; a disconnect racing an in-flight refresh can no longer silently re-connect the account.
- **Featured tabs resilience** — Tidal's `/featured` groups are matched by id, name, or path (exact, then prefix) and an unmatched group is no longer cached as empty for 10 minutes; the group-list response tolerates `items`/`rows`/bare-array shapes.
- **Settings truthfulness** — a login failure that happens while Settings is closed is now surfaced on reopen ("Not connected — last login attempt failed: …") instead of being silently swallowed; the transient error toast no longer gets clobbered by the status refresh.
- **Error class:** most fixes are *optimistic single-shot handling of a multi-step external protocol* — treating recoverable OAuth poll states (slow_down, network blips, races) as terminal. Resolved by classifying outcomes (structured OAuth error = terminal, everything else = retryable) and guarding every await-gap against supersession.

## [1.5.96] — 2026-07-02

### Fixed
- **"Play on" zone list rows overlapped with many zones (user report, 18 zones)** — `.np-device-list` is a flex column capped at 240px with `overflow-y: auto`, but the zone rows kept their default `flex-shrink: 1`, so instead of overflowing into the scrollbar they were compressed below their text height (18 rows ≈ 718px squeezed into 240px → ~11px boxes under 18px text). Rows now have `flex-shrink: 0`, restoring natural height and scrolling; the list cap was also raised to `min(48vh, 320px)` so tall screens show more zones at once. Applies to both the mini-transport and now-playing zone pickers (shared class); verified no ancestor clips the taller popover on small phones.
- **Error class:** flex children inside a max-height scroll container shrink before the container scrolls — the scrollbar never appears because the compressed content technically "fits". Other capped lists were audited: none share the pattern (block layouts or uncapped sheets).

## [1.5.95] — 2026-07-02

### Fixed
- **Qobuz sheet "ducked" out of view while typing a search** — the overlay reused the settings bottom-sheet styles, whose height is content-driven (`max-height: 86vh`, bottom-anchored). Every search render cleared the list before fetching, so the sheet collapsed to a sliver while the request was in flight, then re-expanded when results arrived. The Qobuz overlay is now full screen with a fixed, viewport-driven height (`100dvh`, `100vh` fallback, safe-area aware) so the frame never moves, and list content is cleared only when a fetch outcome (results, empty, or error) is ready — previous rows stay visible under the "Searching…" status.
- **Error class:** content-driven container height + clear-before-fetch — two independently reasonable pieces (a collapsible bottom sheet, an eager list reset) composing into a layout jump. Fixed at both altitudes: fixed-height frame and deferred clearing.

### Changed
- **Qobuz overlay is persistent until closed manually** — grip, title/close, search box, and tab chips are pinned to the top of the sheet while the list scrolls beneath. Escape while typing now clears the search text (like the × button) instead of navigating; a second Escape blurs the input; only with the input unfocused does Escape step back/close. Typing can never dismiss the overlay.
- Stale chrome from an outgoing view (artist "‹ Back" header, "Load more") is hidden the moment a new view's request starts, so it can't act on the view being replaced; opening a detail from a still-loading list self-heals by refetching on back; closing the overlay orphans any in-flight request so late responses can't repopulate it.

## [1.5.94] — 2026-07-02

### Added
- **Full Qobuz catalog access** — the Qobuz overlay is now a complete browser, not just New Releases:
  - **Catalog search** — search the entire Qobuz catalogue (debounced live search, Enter for immediate), with album results paged 50 at a time via a Load more button and a strip of matching artists above the results.
  - **Artist discographies** — tap an artist match to browse every album Qobuz has for them, paged.
  - **Browse tabs** — New Releases, Best Sellers, Most Streamed, Press Awards, and Editor's Picks category chips.
  - Every album everywhere keeps the favourite toggle (♥ Favourite ⇄ ✓ Added) and the tap-for-detail review view, so anything found can be added to (or removed from) your Qobuz library — which is what makes it appear in Roon.
  - New endpoints: `GET /api/qobuz/search`, `GET /api/qobuz/artist-albums`, `GET /api/qobuz/featured`; new lib functions `searchCatalog`, `getArtist` (`catalog/search` / `artist/get` — unsigned endpoints, still no streaming and no app_secret). `/api/qobuz/new-releases` is unchanged.
- **Rate-limit protection** — the user's favourite ids are cached for 60 s and shared across all browse routes (with in-flight dedup and a 10-minute stale ceiling); featured lists are cached raw for 10 minutes per category, so tab-flapping doesn't hammer the unofficial API; upstream data + favourite ids are fetched in parallel per request.

### Fixed (found by the 8-angle pre-commit review of this feature)
- **History/back robustness** — the overlay's back navigation now reconciles its view stack against the depth stored in `history.state` instead of blindly popping once, so browser Forward presses and multi-step history jumps self-heal instead of corrupting navigation.
- **Search results survive artist detours** — opening an artist from search results snapshots the rendered list; pressing back restores it instantly (loaded pages, favourite-button state and all) with no refetch.
- **Load more correctness** — "more pages exist" is now computed server-side from the raw page length (`has_more`); the old client-side `filtered-count < total` math could leave a dead Load more button when Qobuz returned malformed items.
- **Artist discography paging order** — removed the server's per-page re-sort, which made release dates jump around at every Load more seam.
- **Pending search debounce cancelled on navigation** — a 450 ms search timer could previously fire after the user had opened an album detail and replace it with search results.
- **Escape while typing** — Escape in the search box now clears/dismisses the field instead of closing the whole overlay mid-edit.
- **Non-JSON error bodies** — gateway/maintenance HTML error pages now surface as "HTTP nnn" instead of a JSON parse error message (JSON is parsed defensively before the ok-check).
- **Misc UI states** — tab switches and back presses keep the search box, clear button, and tab chips in sync with the visible view; a too-short Enter press gives feedback; "no albums but artist matches" search results no longer show a contradictory "No results" line; generic not-connected copy for non-New-Releases views.
- **Error class:** the paging and status bugs were *contract mismatches between filtered and raw counts* across the client/server seam — resolved by moving the pagination decision to the side that sees the raw data. The history bug was *convention-maintained parallel state* (view stack vs history stack) — resolved by reconciling against the authoritative copy (`history.state`) instead of mirroring by discipline, the same class as the v1.5.93 share-card fix.

## [1.5.93] — 2026-07-01

### Fixed
- **Share card still showed a stale album on the now-playing screen's Queue tab** — this is the third fix for this bug class (see v1.5.89, v1.5.90). Root cause: `window.__currentNpData` was only reassigned inside `updateNpScreen()`, which bails out via `onNowPlayingScreen()` unless the modal's "Now playing" tab (not "Queue") is the active tab. So switching to the Queue tab while a track advanced left the share button reading the last track that was showing before the tab switch. Instead of adding a fourth sync point, removed the mirrored global entirely: the share button now calls `window.__getCurrentNp()`, a getter that reads `currentZone.now_playing` live at click time, so there is no cached value to go stale regardless of which modal tab is active.
- **Error class:** repeated "stale mirrored global" bug — a value copied into `window.*` by convention at one call site, read from a different call site, going out of sync whenever a new UI state (Queue tab) bypassed the sync point. Replaced the mirror with a read-time getter to make the whole class structurally impossible going forward.

## [1.5.92] — 2026-06-26

### Fixed
- **TypeError crash on `/api/album/extras`** — `bios` was declared `const` in a destructured `await Promise.all()` but then conditionally reassigned when `labelDiskCache` held a canonical label for the album. In Node.js strict mode this throws `TypeError: Assignment to constant variable`, returning a 500 for any album whose label had been scanned. Changed to `let`.
- **NaN score chip** — Pitchfork score guard used `!= null` which passes NaN through; `parseFloat` on a malformed JSON value can return NaN. Changed guard to `typeof score === "number" && !isNaN(score)`.
- **Silent catch comment** — malformed JSON-LD block catch in `fetchPitchfork` now explicitly notes why silence is safe (loop continues to the next script tag).

## [1.5.91] — 2026-06-25

### Added
- **Pitchfork reviews** — album detail modal now shows the Pitchfork editorial review and score when available. The score (e.g. 8.4) and a **BNM** badge for Best New Music are displayed alongside year and label. Pitchfork is preferred over Qobuz as the review source; Qobuz still provides label/year when Pitchfork has the review. Falls back silently for albums with no Pitchfork review (older albums or those not reviewed). Review body extracted from JSON-LD `reviewBody` field; score from `__PRELOADED_STATE__`.

## [1.5.90] — 2026-06-25

### Fixed
- **Share card shows previous album on now-playing screen (correct fix)** — the v1.5.89 attempt wrote to `currentAlbum`, a variable not declared in the mini-transport IIFE, causing a sloppy-mode scope leak with unreliable results. Root cause: `window.__currentAlbum` is only written by `openAlbum()` when the modal opens, so it never updates as tracks advance. Fix: `updateNpScreen()` now writes the live `now_playing` object to `window.__currentNpData` on every poll; the share button reads this when the modal is in NP mode, bypassing `window.__currentAlbum` entirely.

## [1.5.89] — 2026-06-25

### Fixed
- **Share card stale album on now-playing screen** — when the next album started playing, the share card still showed the previous album. `updateNpScreen()` was updating the display but not `window.__currentAlbum`, so the share button read the album that was playing when the modal first opened. Fixed by syncing `currentAlbum` / `window.__currentAlbum` whenever the album art key changes (the same point where the artwork is refreshed).

## [1.5.88] — 2026-06-25

### Fixed
- **Code review fixes (multi-angle review):**
  - Qobuz slug scorer: `minScore` now uses `Math.max(1, Math.min(titleCheck.length, 2))` — the previous `Math.min` alone produced `minScore = 0` for titles where all words are ≤3 chars (e.g. "Hi", "S/T"), allowing a zero-score slug through with no title verification. The `Math.max(1,...)` floor ensures at least one title token must match.
  - `fetchLabelFromBandcamp`: removed a redundant outer `try { ... } catch (e) { throw e; }` wrapper that caught and immediately rethrew without any transformation — dead code that contradicted the JSDoc contract and added misleading structure.
  - Silent catch comment in `fetchLabelFromBandcamp` now explains why silence is safe (`JSON.parse` failure on one JSON-LD block is safe because the while-loop continues to the next block).
  - Bandcamp pass partition: replaced two sequential `.filter()` traversals of `needsApiScan` with a single one-pass partition, halving `normalize()` calls during queue building.

## [1.5.87] — 2026-06-25

### Fixed
- **Qobuz link and label opens wrong album for compilations** — the Qobuz search result slug matcher used only the first significant title word (e.g. `"songs"`) to pick the best match, which was too loose for compilation albums by Various Artists: `"songs-of-peace-praise-various-artists"` matched just as well as `"songs-about-new-york-various-artists"`. The matcher now scores every candidate by how many title words (> 3 characters) appear in its slug and picks the highest scorer, so the correct album is selected. Short single-word titles fall back to the previous first-token check. This also fixes the wrong label appearing in the album modal when the Qobuz pass resolved the label from the incorrect album page.

## [1.5.86] — 2026-06-25

### Added
- **Bandcamp label lookup (Pass 0B)** — local libraries now get a dedicated Bandcamp metadata pass during the label scan. Bandcamp downloads embed the album page URL in the `COMMENT` tag of every file; the extension now extracts that URL during the file scan and fetches the album's JSON-LD to retrieve the label name and release year — no API key required. Self-released albums (where Bandcamp lists the artist as the label) are detected and forwarded to the standard API chain rather than creating spurious artist-named label tiles. The pass runs after file-tag resolution and before iTunes, so it resolves Bandcamp purchases before hitting external APIs. Serial with 1.5 s between requests; circuit breaker at 5 consecutive errors or any 429/403; 5-minute wall-clock cap per scan. Results are cached in SQLite so subsequent scans skip already-resolved albums. Inert for streaming-only (Qobuz/Tidal) setups that have no `/music` mount.

## [1.5.85] — 2026-06-23

### Added
- **"Label from folder depth" setting — fixes reissues fragmenting under their pressing label** — for local libraries filed in label folders, an album physically in (say) your Blue Note folder could be listed under the granular pressing label from its file tag (e.g. "EMI Finland", "ECM New Series"), because the file scan read each file's `label`/`organization` tag. A new opt-in setting takes the label from the folder at a chosen depth under your music root instead (e.g. `/music/Jazz/Blue Note Records/Album` → depth **2**), so reissues group under the parent label like they do in Roon. `0` = off (use the file tag, the default and prior behaviour). The depth is measured from the music root, so it's unaffected by disc subfolders. Saving a new value re-runs the label scan, and the file pass overrides any cached labels that differ. Only affects local libraries (requires the `/music` mount); inert for streaming-only setups.

## [1.5.84] — 2026-06-23

### Added
- **Decade focus in the filter button** — the filter sheet now has a "Decade" section alongside Genre and Tag. Pick a decade (e.g. 1990s) to narrow the random wall to albums released in that decade. Because Roon's browse API exposes no release year, the decade is matched against a per-album year the extension now collects — for free — during the existing label scan: from file tags (local libraries), the Qobuz pass (streaming), and MusicBrainz label hits (same response, no extra request), plus whenever an album modal is opened. Years are stored in a new `album_years` SQLite table.
  - **The Decade list populates gradually** and may be sparse at first: it only lists decades that already have albums with a resolved year, so it fills in as the label scan runs and as you browse. For streaming-only libraries especially, expect it to grow over the first scan rather than appear complete immediately.

## [1.5.83] — 2026-06-23

### Fixed
- **Back from a Qobuz album review returns to the new-releases list, not the random wall** — the Qobuz overlay is now history-aware. Opening the overlay and opening an album's review each push a history entry, and a `popstate` handler unwinds **detail → list → closed**, so the Android/browser back button (and the ‹ Back / × / Esc controls) all behave naturally. The handler is a no-op when the overlay is closed, so the rest of the app (which uses no history state) is unaffected.

## [1.5.82] — 2026-06-23

### Added
- **Tap a Qobuz new release to see its review** — tapping a row in the Qobuz New Releases overlay now opens an isolated detail view with the album artwork, the editorial review (fetched by title + artist via the existing `/api/album/extras`, so no Roon library entry is needed), and a favourite toggle. A Back button returns to the list. The favourite button in the detail and the one on the list row stay in sync, so adding/removing in either place is reflected in both. Tapping the favourite button on a row no longer also opens the detail (event isolated).

## [1.5.81] — 2026-06-23

### Added
- **Un-favourite from the Qobuz new-releases overlay** — the favourite button is now a two-way toggle. Tapping "✓ Added" removes the album from your Qobuz favourites (via `favorite/delete`) and flips back to "♥ Favourite"; tapping "♥ Favourite" adds it as before. The add behaviour is unchanged; the button is disabled only while a request is in flight, and reverts cleanly on error.

## [1.5.80] — 2026-06-23

### Fixed
- **Qobuz new releases now show your existing favourites as "✓ Added"** — previously the new-releases overlay only marked an album Added if you favourited it in that same browser session, so albums already in your Qobuz library (or favourited on another device) still showed "♥ Favourite", and the state differed between devices. The list now fetches your current Qobuz favourite album IDs (`favorite/getUserFavoriteIds`) on load and marks any already-favourited release as a disabled "✓ Added" — consistent across all devices. The lookup is best-effort: if it fails, the list still renders with everything clickable.

## [1.5.79] — 2026-06-23

### Added
- **Qobuz New Releases + add-to-favourites (pre-release, unofficial API)** — a new `lib/qobuz.js` lite client talks to the Qobuz API (using the LMS/Lyrion Qobuz plugin's `app_id`) to list new releases and add an album to your **own Qobuz favourites/library**. A Qobuz button in the top bar opens a self-contained overlay listing releases from the last 30 days (artwork, title, artist), each with a **♥ Favourite** button that writes straight to Qobuz (and syncs back through Roon). Connect your Qobuz account in Settings (email + password; only the resulting token and an MD5 of the password are stored — never the plaintext). **No streaming or downloading — Roon still does all playback.**
  - This uses an **unofficial, reverse-engineered Qobuz API** (the same one the LMS plugin uses). It is **against Qobuz's Terms of Service, may break at any time, and is used at your own risk** — clearly noted in Settings.
  - The new-releases overlay is fully isolated from the album grid / labels / filters, so existing navigation is unaffected. Favouriting is by Qobuz album id straight from the new-releases feed (no fuzzy title/artist search), so there's no edition-mismatch risk.

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
