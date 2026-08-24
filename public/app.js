/*
 * Random Albums — frontend
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 */

(() => {
  // Disable pinch-zoom on iOS Safari (which ignores user-scalable=no since iOS 10)
  ["gesturestart", "gesturechange", "gestureend"].forEach((evt) => {
    document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
  });
  // Belt-and-braces: cancel any quick second tap (the iOS double-tap-to-zoom heuristic)
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd < 320) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  const grid       = document.getElementById("album-grid");
  const refreshBtn = document.getElementById("refresh-btn");
  const zoneSel    = document.getElementById("zone-select");
  const banner     = document.getElementById("status-banner");
  const toast      = document.getElementById("toast");

  const modal       = document.getElementById("album-modal");
  const modalImg    = document.getElementById("modal-img");
  const modalSource = document.getElementById("modal-source");
  // Same rule as the tiles: badge only on confirmed local files, and clear it
  // on every open so a previous album's badge can't linger.
  function setModalSource(album) {
    if (!modalSource) return;
    const kind = album && (album.source || (album.local ? "local" : null));
    const label = { local: "Local albums", qobuz: "Qobuz", tidal: "TIDAL" }[kind];
    modalSource.className = "album-source" + (label ? " " + kind : " hidden");
    if (label) { modalSource.title = label; modalSource.setAttribute("aria-label", label); }
    // Same badge as the tiles, on the album's own artwork. Cleared on every
    // open for the same reason: a previous album's rate lingering on a new
    // cover would be a confident, wrong statement about the file.
    const mq = document.getElementById("modal-quality");
    if (!mq) return;
    const q = album && album.quality;
    mq.className = "album-quality" + (q ? (album.hires ? " is-hires" : "") : " hidden");
    mq.textContent = q || "";
    if (q) {
      const words = /\//.test(q) ? q.split("/")[0] + "-bit, " + q.split("/")[1] + " kHz" : q;
      mq.title = words;
      mq.setAttribute("aria-label", words);
    }
  }
  const modalTitle  = document.getElementById("modal-title");
  const modalSub    = document.getElementById("modal-subtitle");
  const modalActs   = document.getElementById("modal-actions");
  const modalTracks = document.getElementById("modal-tracks");

  const selMenuWrap          = document.getElementById("select-menu-wrap");
  const selMenuBtn           = document.getElementById("select-menu-btn");
  const selMenu              = document.getElementById("select-menu");
  const selMenuTitle         = document.getElementById("select-menu-title");
  const selCount             = document.getElementById("select-count");
  const albumActionBar       = document.getElementById("album-action-bar");
  const albumActionInfo      = document.getElementById("album-action-info");
  const albumActionCancelBtn = document.getElementById("album-action-cancel-btn");

  let currentAlbum = null;         // {offset,title,subtitle,image_key}
  let zones = [];
  let selectedZoneId = null;

  // Phone wall geometry (used by measurePhoneWall/computeAlbumCount below).
  // Declared BEFORE the computeAlbumCount() call on the next line — it's a
  // const, so referencing it from that call while it is still in its temporal
  // dead zone would throw and abort the whole app (blank screen). TEXT_BLOCK/
  // gaps mirror the .album-grid.phone-fit and phone .album-meta CSS.
  const PHONE_WALL = {
    COLS: 3,
    ROW_GAP: 10,     // .album-grid.phone-fit row-gap
    COL_GAP: 8,      // .album-grid.phone-fit column-gap
    TEXT_BLOCK: 51,  // worst case: 5px meta margin + 2 title lines (12×1.25=30) + 1px gap + artist (~15) = 51
                     // sized for the 2-line-title max so 4 rows never overflow into a scroll
    MIN_ART: 96,     // don't shrink art below this — drop a row instead
    TARGET_ROWS: 4
  };
  let albumCount = computeAlbumCount();
  let labelsActive = false;        // viewing the record-label browser?
  let unplayedWallActive = false;  // viewing the full "Not played in 6 months" grid?
  let libraryWallActive = false;   // viewing the full A-Z library grid?
  // Declared up here with the other view flags, NOT beside showPlaylists():
  // showHome() and enterFullWall() read them and both can run during boot,
  // which with a `let` further down the file is a ReferenceError, not a
  // harmless undefined (CLAUDE.md: declaration before use).
  let smartWallActive = false;      // viewing the smart-playlist wall?
  let smartDetailActive = false;    // viewing one smart playlist's tracks?
  let smartSeq = 0;                 // orphans in-flight smart-playlist fetches
  let userPlDetailActive = false;   // viewing one stored playlist?
  let userPlSeq = 0;                // orphans in-flight stored-playlist fetches
  let playlistsActive = false;      // viewing the Roon playlist list?
  let playlistDetailActive = false; // viewing one playlist's tracks?
  let playlistSeq = 0;              // orphans in-flight playlist fetches
  let smartPicksActive = false;     // viewing the Smart Picks screen?
  let smartPicksSeq = 0;            // orphans in-flight Smart Picks fetches
  // How long a report about a long-running queue fill stays up (vs showToast's
  // 2.4s default). Declared here rather than beside showToast() for the same
  // reason as the flags above — a `const` further down the file is a TDZ
  // ReferenceError to anything that reads it first.
  const TOAST_REPORT_MS = 9000;
  // Most albums one Play now / Queue / Send to Roon can take. Matches the
  // server's ceiling in /api/smart-playlist/albums — asked for explicitly so
  // the server's 100 default can't silently apply, which is exactly what made
  // a 1,179-album playlist queue 100 and report success (v1.7.17).
  const SMART_SEND_MAX = 400;
  // Most albums a Share will expand before it stops. Each one costs ~5 Roon
  // browse calls to read its tracks, so this is a time budget, not a taste
  // judgement: 100 albums is roughly 500 calls. The sheet always reports what
  // it left out (v1.7.17's lesson — a silent cap reads as success).
  const SHARE_ALBUM_MAX = 100;
  // Set by addLongPress and consumed by the very next click, so a long press
  // doesn't also fire the element's ordinary tap handler.
  let longPressAte = false;
  // Track multi-select inside the album view. Declared with the other view
  // flags rather than beside the album-modal code: closeModal() reads them
  // during boot-time teardown, and a `let` further down the file is a
  // ReferenceError there, not a harmless undefined.
  let trackSelectMode = false;
  let trackSelected = [];          // [{index,title}] within the open album
  let albumSelectMode = false;
  let albumSelected = [];          // [{offset,title,subtitle}] albums chosen in select mode
  // The filter that the currently-open album modal belongs to. Usually the
  // active genre/tag filter, but a per-open override is used for label albums
  // so detail + play resolve offsets against the right list.
  let currentDetailFilter = null;

  // ----- Album filter (genre / tag) -----
  // null, or { type: "genre"|"tag", value: "<title>" }. Offsets in album
  // picks are positions *within the filtered list*, so the same filter must
  // accompany every /api/album and /api/play call.
  let activeFilter = null;
  try {
    const f = JSON.parse(localStorage.getItem("rra-filter") || "null");
    if (f && f.type && f.value) activeFilter = f;
  } catch (e) {} // corrupt localStorage entry — start with no filter
  function filterQSOf(f) {
    if (!f) return "";
    return "&filter_type=" + encodeURIComponent(f.type) +
           "&filter_value=" + encodeURIComponent(f.value) +
           (f.parent ? "&filter_parent=" + encodeURIComponent(f.parent) : "");
  }
  function filterQS() { return filterQSOf(activeFilter); }

  // ----- Themes -----
  // Four themes, expressed as TWO attributes rather than four values of one:
  //
  //   data-theme   = dark | light   — the FAMILY
  //   data-palette = classic | copper — the COLOURS
  //
  // The split exists because thirteen rules in style.css are keyed on
  // `[data-theme="light"] .something` — white text on an accent fill, the
  // light-side hover washes, the translucent top bar. Those describe the
  // family, not the palette, and a new light theme under a third data-theme
  // value would silently miss every one of them: white-on-accent labels would
  // fall back to near-black, and the queue would use dark-theme washes on a
  // light background. Keying palettes on their own attribute means the
  // existing themes are untouched and the new ones inherit all thirteen.
  const THEMES = [
    { id: "dark",         label: "Dark",         note: "The original — cool grey and cyan",
      theme: "dark",  palette: "classic" },
    { id: "light",        label: "Light",        note: "The original — bright and neutral",
      theme: "light", palette: "classic" },
    { id: "copper-dark",  label: "Copper dark",  note: "Charcoal and copper, from the MusicD site",
      theme: "dark",  palette: "copper" },
    { id: "brass-light",  label: "Brass light",  note: "Warm parchment with a brass accent",
      theme: "light", palette: "copper" },
  ];
  const THEME_KEY = "rra-theme-v2";
  const DEFAULT_THEME = "dark";
  const themeById = (id) => THEMES.find(t => t.id === id) || null;

  function applyTheme(id) {
    const t = themeById(id) || themeById(DEFAULT_THEME);
    document.documentElement.dataset.theme   = t.theme;
    document.documentElement.dataset.palette = t.palette;
    // The browser chrome colour was hard-coded to the dark background and
    // never updated, so it was already wrong in light theme. Read it back off
    // the applied palette instead of maintaining a second list of hexes.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      if (bg) meta.setAttribute("content", bg);
    }
    return t.id;
  }

  function savedThemeId() {
    let id = null;
    try { id = localStorage.getItem(THEME_KEY); } catch (e) { /* private browsing */ }
    if (themeById(id)) return id;
    // Migrate the v1 key, which only ever held "light" or "dark" — those are
    // still valid theme ids, so the user's choice carries over untouched.
    try {
      const old = localStorage.getItem("rra-theme");
      if (old === "light" || old === "dark") {
        localStorage.setItem(THEME_KEY, old);
        return old;
      }
    } catch (e) { /* private browsing */ }
    // No stored choice: follow the OS, as before. Read once at boot, with no
    // change listener — same behaviour the single toggle had.
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return DEFAULT_THEME;
  }

  let currentThemeId = applyTheme(savedThemeId());
  function setTheme(id) {
    currentThemeId = applyTheme(id);
    try { localStorage.setItem(THEME_KEY, currentThemeId); }
    catch (e) { /* localStorage optional — the theme still applies for this session */ }
  }
  // The Appearance pane builds its picker from this.
  window.__themes = THEMES;
  window.__currentThemeId = () => currentThemeId;
  window.__setTheme = setTheme;

  // ----- Sizing -----
  // Returns a fixed album count that exactly fills the responsive grid:
  //   Phone portrait   → 3 cols × measured rows (min 3×3 = 9, capped at 96)
  //   Tablet portrait  → 5×4  = 20
  //   Tablet landscape → 7×3  = 21
  //   Desktop          → 9×5  = 45

  // Measure the phone wall: return { rows, art } — the largest square art size
  // that lets `rows` rows fit the visible content box without scrolling. When
  // the wall is width-limited, art is the natural third-of-width (no shrink);
  // when height-limited, art shrinks so the target rows still fit. Falls back
  // to 3 rows if 4 can't fit at a reasonable size.
  function measurePhoneWall() {
    const P = PHONE_WALL;
    const mainEl = document.querySelector("main");
    let innerW, innerH;
    if (mainEl && mainEl.clientHeight > 0) {
      const cs = window.getComputedStyle(mainEl);
      // Subtract <main>'s padding — the bottom padding reserves the transport,
      // so innerH is the true height the grid can occupy.
      innerW = mainEl.clientWidth
        - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      innerH = mainEl.clientHeight
        - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    } else {
      // Pre-layout fallback: ~110px top bar, ~94px <main> vertical padding.
      innerW = window.innerWidth - 28;
      innerH = window.innerHeight - 110 - 94;
    }
    const artW = (innerW - (P.COLS - 1) * P.COL_GAP) / P.COLS;
    const artForRows = (r) => (innerH - (r - 1) * P.ROW_GAP - r * P.TEXT_BLOCK) / r;
    let rows = P.TARGET_ROWS;
    let art = Math.min(artW, artForRows(P.TARGET_ROWS));
    if (art < P.MIN_ART) {
      rows = 3;
      art = Math.min(artW, artForRows(3));
      if (art < P.MIN_ART) art = artW;   // very short screen: natural size, may scroll
    }
    return { rows, art: Math.max(1, Math.floor(art)) };
  }

  // Remove the phone-fit wall sizing (used when the labels browser takes over
  // the shared grid, so label tiles use their own default layout).
  function clearWallGridSizing() {
    grid.classList.remove("phone-fit");
    grid.style.removeProperty("--phone-art");
  }

  // Apply (or clear) the phone-fit sizing on the album wall grid. Called for
  // the album wall only — the labels browser removes it so it keeps its own
  // layout. Returns the album count for the wall, or null off-phone.
  function applyWallGridSizing() {
    if (Math.min(window.innerWidth, window.innerHeight) >= 768) {
      grid.classList.remove("phone-fit");
      grid.style.removeProperty("--phone-art");
      return null;
    }
    const m = measurePhoneWall();
    grid.style.setProperty("--phone-art", m.art + "px");
    grid.classList.add("phone-fit");
    return PHONE_WALL.COLS * m.rows;
  }

  function computeAlbumCount() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isLandscape = w > h;
    const minDim = Math.min(w, h);  // smallest dimension identifies phones vs tablets

    // Phone (narrowest side < 768 px): 3 columns, rows measured to fill the
    // screen (target 4) — see measurePhoneWall. Landscape is blocked via CSS.
    if (minDim < 768) {
      return Math.min(96, PHONE_WALL.COLS * measurePhoneWall().rows);  // 96 = server max
    }

    // Desktop (width ≥ 1200 px)
    if (w >= 1200) return 45;       // 9×5

    // Tablet (768–1199 px)
    return isLandscape ? 21 : 20;   // 7×3 or 5×4
  }

  // Re-fit the phone wall when the viewport resizes (Safari chrome collapsing,
  // iPad split view). Debounced; only applies to the actual phone-fit random
  // wall — it must not fire while Home, an active search, the labels browser,
  // or the "Not played" full grid are showing, since none of those are the
  // phone-fit wall and loadRandom() would silently replace their content.
  let _wallResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(_wallResizeTimer);
    _wallResizeTimer = setTimeout(() => {
      if (labelsActive || unplayedWallActive || libraryWallActive) return;
      // The artist view owns the grid too — without this, a phone rotation (or
      // Safari collapsing its toolbar mid-scroll) replaced the discography with
      // a random wall while the header still said the artist's name.
      if (window.__artistViewActive && window.__artistViewActive()) return;
      if (homeView && !homeView.classList.contains("hidden")) return;
      if (window.__searchActive && window.__searchActive()) return;
      if (Math.min(window.innerWidth, window.innerHeight) >= 768) return;
      const next = computeAlbumCount();
      if (next !== albumCount) loadRandom();   // rows changed → refetch to fill exactly
      else applyWallGridSizing();              // same rows → rescale art in place
    }, 250);
  });

  // ----- Home landing view -----
  const homeView     = document.getElementById("home-view");
  const homeSections = document.getElementById("home-sections");
  const homeUnplayed = document.getElementById("home-unplayed");
  const homeRandom   = document.getElementById("home-random");
  const homeLibrary  = document.getElementById("home-library");
  const homeLotw     = document.getElementById("home-lotw");
  const homePicks    = document.getElementById("home-picks");
  const homeHistory  = document.getElementById("home-history");
  const homeGenres   = document.getElementById("home-genres");
  const topbarBack   = document.getElementById("topbar-back");
  const topbarRefresh = document.getElementById("topbar-refresh");
  const topbarSearch  = document.getElementById("topbar-search");
  let homeSectionsLoaded = false;
  let homeLotwLoaded = false;   // set once the label-of-the-week row populates
  let homeLibraryLoaded = false; // set once the Library row populates
  // Smart Picks are built once a day on the server. The row is retried on each
  // Home visit until it populates (the first build runs in the background and
  // can take a minute), then left alone — the set does not change again today.
  let homePicksDay = "";
  let homeHistoryLoaded = false;  // set once the recently-played row populates

  // ---------------------------------------------------------------------------
  // The Home rows, as one table.
  //
  // Every row's identity, its title, the node it lives in, how to load it and
  // when it is stale, in one place. The Home screen loops it, the Home Screen
  // settings page renders from it, and the server validates against the same
  // id list — so a row cannot exist in one of those and not the others. Same
  // reasoning as the theme table.
  //
  // `load` is called when the row is enabled and `isFresh()` says otherwise.
  // A DISABLED row is never loaded, which is the whole point: hiding a row has
  // to stop the work behind it, not just the paint.
  // ---------------------------------------------------------------------------
  const HOME_ROWS = [
    { id: "unplayed", title: "Not played in 6 months",
      load: () => { loadHomeUnplayed(); }, isFresh: () => rowsTtlFresh() },
    { id: "history",  title: "Recently played",
      load: () => { loadHomeHistory(); }, isFresh: () => homeHistoryLoaded },
    { id: "picks",    title: "Smart Picks",
      load: () => { loadHomeSmartPicks(); }, isFresh: () => homePicksDay === localDayKey() },
    { id: "random",   title: "Random albums",
      load: () => { loadHomeRandom(); }, isFresh: () => rowsTtlFresh() },
    { id: "library",  title: "Library",
      load: () => { loadHomeLibrary(); }, isFresh: () => homeLibraryLoaded },
    { id: "lotw",     title: "Label of the week",
      load: () => { loadHomeLabelOfWeek(); }, isFresh: () => homeLotwLoaded },
    { id: "genres",   title: "Browse by genre",
      load: () => { loadHomeGenres(); }, isFresh: () => homeSectionsLoaded },
  ];
  function homeRowEl(id) {
    return homeSections ? homeSections.querySelector('[data-row="' + id + '"]') : null;
  }
  // The stored layout, defaulting to the table's own order with everything on.
  let homeLayout = HOME_ROWS.map(r => ({ id: r.id, on: true }));

  // Put the sections in the stored order and hide the ones switched off.
  //
  // appendChild on an element already in the DOM MOVES it — listeners, closures
  // and all. Rebuilding this from an HTML string would silently drop every
  // handler on every tile, which is the v1.6.52 "albums untappable after Back"
  // bug (CLAUDE.md pre-flight step 4).
  // Rows that legitimately hide themselves when they have nothing to show. A
  // fresh install has no history and no picks, and an empty labelled shelf
  // reads as a fault rather than an absence.
  function rowHidesWhenEmpty(id) {
    return id === "history" || id === "picks" || id === "lotw";
  }
  function rowHasAnyContent(sectionEl) {
    return !!(sectionEl && sectionEl.querySelector(".album, .pick-card, .home-genre-tile"));
  }

  function applyHomeLayout() {
    if (!homeSections) return;
    for (const row of homeLayout) {
      const el = homeRowEl(row.id);
      if (!el) continue;
      homeSections.appendChild(el);
      // toggle, not add. Only ever adding meant a row switched off stayed off
      // for the rest of the session: nothing removed the class, and the
      // renderers write into the carousel div rather than the section wrapper.
      //
      // Rows that hide themselves when empty (History, Smart Picks, Label of
      // the week) get their emptiness respected: re-showing a row the layout
      // enables must not un-hide one that simply has nothing in it.
      // `unavailable` beats the stored preference: the feature behind the row
      // is switched off, so there is nothing for it to show. Kept separate from
      // `on` so the user's own choice survives untouched until they turn the
      // feature back on.
      //
      // Belt and braces, honestly labelled: the two rows that can currently be
      // unavailable (picks, lotw) are also the two that hide themselves when
      // empty, and with their feature off they ARE empty — so today this term
      // changes nothing on its own. The gate that does the work is homeRowOn(),
      // which stops the row's loader running at all. This one states the intent
      // so a future unavailable row that does not hide-when-empty is covered.
      const showable = row.on && !row.unavailable;
      el.classList.toggle("hidden",
        !showable || (showable && rowHidesWhenEmpty(row.id) && !rowHasAnyContent(el)));
    }
  }
  async function loadHomeLayout() {
    try {
      const r = await fetch("/api/settings/home-rows");
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.rows) && j.rows.length) homeLayout = j.rows;
    } catch (e) {
      // Offline or pre-upgrade server: keep the default order. A Home screen
      // in the wrong order is recoverable; one that never renders is not.
    }
    applyHomeLayout();
  }
  function homeRowOn(id) {
    const r = homeLayout.find(x => x.id === id);
    // Gates the row's LOADER as well as its visibility — a row whose feature is
    // off must not fetch either, or Smart Picks keeps polling a route that is
    // now returning nothing.
    return !r || (r.on && !r.unavailable);
  }

  // Topbar chrome per view: Back button (off Home), Refresh button (random /
  // genre grids), and the Search box (Home only, beside the hamburger).
  function setTopbarNav(back, refresh, search) {
    if (topbarBack)    topbarBack.classList.toggle("hidden", !back);
    if (topbarRefresh) topbarRefresh.classList.toggle("hidden", !refresh);
    if (topbarSearch)  topbarSearch.classList.toggle("hidden", !search);
  }

  // Show the Home landing (hide the wall). The wall loads lazily when entered.
  function showHome() {
    { const c = document.getElementById("library-controls"); if (c) c.classList.add("hidden"); }
    unplayedWallActive = false;
    libraryWallActive = false;
    leavePlaylistScreens();
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
    if (window.__exitLabels) window.__exitLabels();   // leave the labels browser if active
    // Discard, don't restore: this function is establishing its own screen and
    // has already reset the view flags above.
    if (window.__exitArtistView) window.__exitArtistView({ restore: false });
    // Home is unfiltered — clear any active genre/tag filter so the breadcrumb
    // title goes away AND Home's full-library tiles resolve correctly.
    if (activeFilter) {
      activeFilter = null;
      try { localStorage.removeItem("rra-filter"); } catch (e) {} // localStorage optional (private browsing)
    }
    updateCountReadout(null);   // hide the genre/label breadcrumb
    setBanner(null);            // drop any error/empty banner left by a wall view
    if (homeView) homeView.classList.remove("hidden");
    if (homeSections) homeSections.classList.remove("hidden");  // in case a search hid them
    grid.classList.add("hidden");
    setTopbarNav(false, false, true);   // Home: search box, no Back/Refresh
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
    // The unplayed + random rows keep their tiles for 5 minutes: every Back tap
    // lands here, and rebuilding ~60 fresh-random tiles each time re-fetched
    // ~60 cover images through the Roon Core — the single biggest repeated cost
    // in the app. Within the TTL the existing DOM (and the browser's image
    // cache) is reused; after it, or if a load failed, both rows reload fresh.
    // The unplayed and random rows share one TTL, so mark it before the loop
    // rather than once per row.
    if (!rowsTtlFresh()) homeRowsLoadedAt = Date.now();
    for (const row of HOME_ROWS) {
      if (!homeRowOn(row.id)) continue;   // off means the work does not run
      if (row.isFresh()) continue;
      row.load();
    }
  }
  // Shared freshness for the two rows that turn over on a clock rather than a
  // flag: recheck every 5 minutes, but only when they actually hold tiles.
  function rowsTtlFresh() {
    return !!(homeRowsLoadedAt &&
      (Date.now() - homeRowsLoadedAt) < HOME_ROWS_TTL_MS &&
      homeUnplayed && homeUnplayed.querySelector(".album") &&
      homeRandom && homeRandom.querySelector(".album"));
  }
  // Reveal the album wall. opts.loadIfEmpty loads a fresh wall only when it has
  // no content yet (so passive reveals — opening an overlay from the menu —
  // don't leave an empty grid behind, without racing actions that render their
  // own content, e.g. labels/search).
  function showWall(opts) {
    leavePlaylistScreens();   // this screen owns the grid now
    { const c = document.getElementById("library-controls"); if (c) c.classList.add("hidden"); }
    unplayedWallActive = false;
    libraryWallActive = false;
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
    // Discard, don't restore: this function is establishing its own screen and
    // has already reset the view flags above.
    if (window.__exitArtistView) window.__exitArtistView({ restore: false });
    if (homeView) homeView.classList.add("hidden");
    grid.classList.remove("hidden");
    setTopbarNav(true, true, false);   // random / genre grid: Back + Refresh, no search
    // Home and the grid share <main>'s scroll container — without this, a
    // wall entered while Home was scrolled down (e.g. tapping a genre card
    // below the fold) opens mid-page/at-the-bottom instead of at the top.
    const mainEl = document.querySelector("main");
    if (mainEl) mainEl.scrollTop = 0;
    if (opts && opts.loadIfEmpty && !labelsActive && !grid.children.length) loadRandom();
  }
  window.__showHome = showHome;
  window.__showWall = showWall;
  // Labels/search reuse the shared grid but aren't the random-album wall, so
  // they show Back but not Refresh.
  window.__setTopbarNav = setTopbarNav;

  if (topbarBack)    topbarBack.addEventListener("click", showHome);
  if (topbarRefresh) topbarRefresh.addEventListener("click", () => loadRandom());

  // Home unplayed/random rows are reused within this TTL instead of being
  // rebuilt (and re-randomised) on every visit — see showHome.
  const HOME_ROWS_TTL_MS = 5 * 60 * 1000;
  let homeRowsLoadedAt = 0;

  // --- Home content persistence (instant open) --------------------------
  // The in-memory rows above live only as long as the page's JS context, so a
  // cold PWA open (the process is torn down when the app is backgrounded) reset
  // homeRowsLoadedAt to 0 and reloaded — and re-randomised — the entire Home
  // screen every single time. Persist the last rendered rows to localStorage
  // and repaint them instantly on open, then revalidate in the background
  // (stale-while-revalidate). Covers come straight from the browser's HTTP
  // cache (the server sends them immutable for a week), so it's a flash-free
  // repaint, not a reload. Bumped the key suffix if the cached shape changes.
  const HOME_CACHE_KEY = "rra-home-cache-v1";
  function saveHomeCache(patch) {
    try {
      const cur = JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || "{}") || {};
      localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(Object.assign(cur, patch)));
    } catch (e) {} // localStorage optional / over quota — persistence is best-effort
  }
  function readHomeCache() {
    try { return JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || "null"); }
    catch (e) { return null; } // corrupt cache — ignore and load fresh
  }
  // A row already carries real content (tiles or genre cards), so a background
  // revalidation can swap fresh data in without first flashing "Loading…" over
  // the cached content the user is already looking at.
  // Smart Picks tiles are .pick-card, not .album — they carry no offset and are
  // never ordinary album tiles — so that class has to be named here or a
  // hydrated picks row reads as empty and gets blanked.
  const rowHasContent = (el) => !!(el && el.querySelector(".album, .home-genre-card, .pick-card"));

  // Build a Home tile that always opens full-library (filter: null) so its
  // offset resolves even when a genre filter was last active.
  function homeTile(a, extraClass) {
    const tile = buildAlbumTile(a, () => openAlbum(a, { source: "home", filter: null }));
    if (extraClass) tile.classList.add(extraClass);
    return tile;
  }

  // The action that used to live in the side menu, as the first tile of the
  // "Not played" row. It reuses .album so the grid/carousel sizing, the hover
  // state and the art aspect ratio all come for free — only the inside of the
  // art square differs.
  function buildUnheardTile() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "album home-unheard-tile";
    btn.id = "home-unheard-tile";
    btn.setAttribute("aria-label", "Play something you haven't heard");

    const art = document.createElement("div");
    art.className = "album-art-wrap unheard-art";
    const glyph = document.createElement("span");
    glyph.className = "unheard-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "✧";
    art.appendChild(glyph);
    btn.appendChild(art);

    const meta = document.createElement("div");
    meta.className = "album-meta";
    const t = document.createElement("div");
    t.className = "album-title";
    t.textContent = "Play something unheard";
    const s = document.createElement("div");
    s.className = "album-artist";
    s.textContent = "Surprise me";
    meta.appendChild(t); meta.appendChild(s);
    btn.appendChild(meta);

    // One implementation, two triggers: the request, the zone check and the
    // spin all live in playUnheard, which spins whichever control was pressed.
    btn.addEventListener("click", () => {
      if (window.__playUnheard) window.__playUnheard(btn);
    });
    return btn;
  }

  // Render helper shared by the live loader and the instant-open cache repaint.
  function renderHomeUnplayed(aotd, albums) {
    albums = albums || [];
    homeUnplayed.innerHTML = "";
    if (!albums.length && !aotd) {
      homeUnplayed.innerHTML = '<div class="home-carousel-empty">Nothing here yet — play some music and check back.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    // "Play something unheard" leads the row it belongs to: this carousel IS
    // the unheard albums, so the action and the row mean the same thing, and
    // it sits at the top of Home without needing a place of its own. Built as
    // a tile so it inherits the carousel's sizing on every screen rather than
    // carrying breakpoints of its own.
    frag.appendChild(buildUnheardTile());
    if (aotd) {
      const tile = homeTile(aotd, "home-aotd");
      const wrap = tile.querySelector(".album-art-wrap");
      if (wrap) {
        const badge = document.createElement("span");
        badge.className = "aotd-badge";
        badge.textContent = "★ Today";
        wrap.appendChild(badge);
      }
      frag.appendChild(tile);
    }
    for (const a of albums) frag.appendChild(homeTile(a));
    homeUnplayed.appendChild(frag);
  }

  async function loadHomeUnplayed() {
    if (!homeUnplayed) return;
    // Don't flash "Loading…" over cached tiles the user is already looking at —
    // only when the row is genuinely empty (first ever load).
    if (!rowHasContent(homeUnplayed)) homeUnplayed.innerHTML = '<div class="home-carousel-empty">Loading…</div>';
    // Album of the day (completely random; hidden once played today) sits
    // first. Fetched in PARALLEL with the unplayed list — they're independent,
    // and awaiting them in sequence added a full round-trip to every reload.
    const aotdPromise = fetch("/api/home/album-of-the-day")
      .then(ar => ar.json()).catch(() => null);
    const unplayedPromise = fetch("/api/home/unplayed?months=6&count=30");
    unplayedPromise.catch(() => {});   // handled at the await below — this just silences the pre-await rejection warning
    const aj = await aotdPromise;
    const aotd = (aj && aj.album) ? aj.album : null;   // non-fatal — just no album-of-the-day
    try {
      const r = await unplayedPromise;
      if (r.status === 503) {
        if (!rowHasContent(homeUnplayed)) homeUnplayed.innerHTML = '<div class="home-carousel-empty">Waiting for Roon Core…</div>';
        homeRowsLoadedAt = 0;   // retry on the next Home visit
        return;   // keep any cached tiles + cache untouched while the index builds
      }
      const j = await r.json();
      const albums = (j && j.albums) || [];
      renderHomeUnplayed(aotd, albums);
      // Persist only a non-empty row (mirrors random/genres) so a legitimately
      // empty response can't be cached and shown as "Nothing here yet" next
      // open. Timestamp is per-row so a stale sibling can't ride a fresh one's
      // freshness (see hydrateHomeFromCache).
      if (albums.length || aotd) saveHomeCache({ unplayed: { aotd, albums }, unplayedAt: Date.now() });
    } catch (e) {
      if (!rowHasContent(homeUnplayed)) homeUnplayed.innerHTML = '<div class="home-carousel-empty">Couldn’t load.</div>';
      homeRowsLoadedAt = 0;   // retry on the next Home visit
    }
  }

  // Random-albums row (reuses /api/random-albums, no filter → full library).
  // Reloaded when the Home rows go stale (see showHome's TTL); tapping the
  // header opens the full random wall (same as the hamburger "Random albums").
  // One renderer for the plain album carousels (Random, Library) — same tiles,
  // same empty state, so the rows can't drift apart.
  function renderAlbumRow(rowEl, albums) {
    albums = albums || [];
    if (!rowEl) return;
    rowEl.innerHTML = "";
    if (!albums.length) {
      rowEl.innerHTML = '<div class="home-carousel-empty">No albums.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const a of albums) frag.appendChild(homeTile(a));   // filter:null → offsets resolve
    rowEl.appendChild(frag);
  }
  function renderHomeRandom(albums) { renderAlbumRow(homeRandom, albums); }

  async function loadHomeRandom() {
    if (!homeRandom) return;
    if (!rowHasContent(homeRandom)) homeRandom.innerHTML = '<div class="home-carousel-empty">Loading…</div>';
    try {
      const r = await fetch("/api/random-albums?count=30");
      if (r.status === 503) {
        if (!rowHasContent(homeRandom)) homeRandom.innerHTML = '<div class="home-carousel-empty">Waiting for Roon Core…</div>';
        homeRowsLoadedAt = 0;   // retry on the next Home visit
        return;   // keep any cached tiles while the index builds
      }
      const j = await r.json();
      const albums = (j && j.albums) || [];
      renderHomeRandom(albums);
      if (albums.length) saveHomeCache({ random: albums, randomAt: Date.now() });
    } catch (e) {
      if (!rowHasContent(homeRandom)) homeRandom.innerHTML = '<div class="home-carousel-empty">Couldn’t load.</div>';
      homeRowsLoadedAt = 0;   // retry on the next Home visit
    }
  }

  // Library row — the first albums of the whole library in Roon's own order.
  // Stable content (changes only when the library does), so it loads once per
  // session and is retried each Home visit until it populates, like the label
  // of the week. Tapping the header opens the full scrolling library wall.
  function renderHomeLibrary(albums) { renderAlbumRow(homeLibrary, albums); }

  async function loadHomeLibrary() {
    if (!homeLibrary) return;
    if (!rowHasContent(homeLibrary)) homeLibrary.innerHTML = '<div class="home-carousel-empty">Loading…</div>';
    try {
      const r = await fetch("/api/library/albums?offset=0&count=30");
      // Any non-OK response (503 while the index builds, 500 on a transient
      // server error) keeps the cached tiles — a built index never legitimately
      // returns zero albums, so blanking the row to "No albums." would only
      // ever be showing an error as an empty state.
      if (!r.ok) {
        if (!rowHasContent(homeLibrary)) homeLibrary.innerHTML = '<div class="home-carousel-empty">Waiting for Roon Core…</div>';
        return;   // retried on the next Home visit (homeLibraryLoaded stays false)
      }
      const j = await r.json();
      const albums = (j && j.albums) || [];
      if (albums.length) {
        renderHomeLibrary(albums);
        homeLibraryLoaded = true;   // populated — stop retrying on future visits
        saveHomeCache({ library: albums });
      } else if (!rowHasContent(homeLibrary)) {
        renderHomeLibrary([]);   // genuinely empty and nothing cached — show the empty state
      }
    } catch (e) {
      if (!rowHasContent(homeLibrary)) homeLibrary.innerHTML = '<div class="home-carousel-empty">Couldn’t load.</div>';
    }
  }

  // Recently played — one tile per album, newest first, 30 days.
  //
  // The section stays hidden until there is something in it: a fresh install
  // has no history, and an empty shelf labelled "Recently played" reads like a
  // fault rather than an absence.
  function renderHomeHistory(albums) {
    if (!homeHistory) return;
    renderAlbumRow(homeHistory, albums);
    const sec = homeHistory.closest(".home-section");
    if (sec) sec.classList.toggle("hidden", !albums.length || !homeRowOn("history"));
  }
  async function loadHomeHistory() {
    if (!homeHistory) return;
    try {
      const r = await fetch("/api/home/history?count=30");
      if (!r.ok) return;   // retried next visit — homeHistoryLoaded stays false
      const j = await r.json();
      const albums = (j && j.albums) || [];
      renderHomeHistory(albums);
      // Marked loaded even when empty: an empty history is a real answer, and
      // retrying it on every Home visit would query the plays table forever on
      // a box nobody has played anything from.
      homeHistoryLoaded = true;
      if (albums.length) saveHomeCache({ history: albums });
    } catch (e) {
      // Offline or the server went away. The row keeps whatever it had; the
      // next visit tries again.
    }
  }

  // -------------------------------------------------------------------------
  // Smart Picks — five albums a day by artists NOT in the library.
  //
  // These albums are NOT in Roon, so they have no offset and cannot be played
  // or queued. The only action is Add, which favourites the album on the
  // connected streaming service; Roon imports it and it becomes playable on the
  // next sync. That is why this uses its own card rather than homeTile(), whose
  // tap handlers all assume an offset into the albums hierarchy.
  // -------------------------------------------------------------------------

  // Today, in the viewer's own timezone.
  //
  // This is deliberately NOT compared against the server's `day`. The container
  // sets no TZ and runs UTC, so for anyone east or west of Greenwich the two
  // strings differ for part of every day — and the guard below would then be
  // permanently true, refetching and re-rendering the row on every Back tap.
  // "Has the day rolled over" is a question about the VIEWER's midnight, so the
  // client answers it with its own clock and stores its own key.
  function localDayKey() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" + n : String(n));
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function smartPickAddLabel(added) { return added ? "✓ Added" : "＋ Add"; }

  // Favourite a pick's album on whichever service it came from. On success the
  // button latches to Added rather than toggling back off: this is a one-way
  // "put it in my library" action, and an accidental second tap that silently
  // un-favourited it would be much worse than a no-op.
  async function addSmartPick(pick, button) {
    if (!pick.album_id || !pick.service) {
      showToast("No streaming album to add", "error");
      return;
    }
    const before = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      const r = await fetch("/api/" + pick.service + "/favorite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ album_id: pick.album_id })
      });
      const j = await r.json();
      if (j && j.ok) {
        // Deliberately not just "Added": the album is in the streaming library
        // now, but Roon imports on its own schedule, and the first version's
        // bare "Added" left people wondering why they still could not play it.
        button.textContent = "✓ Added — waiting for Roon";
        button.classList.add("is-done");
        button.disabled = true;
        button.dataset.added = "1";
        showToast("Added to " + (pick.service === "tidal" ? "TIDAL" : "Qobuz") +
                  " — Roon will import it on its next sync", "ok");
      } else {
        button.textContent = before;
        button.disabled = false;
        showToast((j && j.error) || "Couldn't add that album", "error");
      }
    } catch (e) {
      button.textContent = before;
      button.disabled = false;
      showToast("Failed: " + e.message, "error");
    }
  }

  // "Not for me" — permanent, and only ever from an explicit tap. Silence is
  // never treated as rejection: the whole premise is albums the user would not
  // otherwise reach for, so a pick they simply ignored has to be allowed back.
  async function blockSmartPick(pick, card) {
    try {
      const r = await fetch("/api/smart-picks/block", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artist: pick.artist })
      });
      const j = await r.json();
      if (j && j.ok) {
        if (card && card.parentNode) card.parentNode.removeChild(card);
        showToast("Won't suggest " + pick.artist + " again", "ok");
      } else {
        showToast((j && j.error) || "Couldn't save that", "error");
      }
    } catch (e) {
      showToast("Failed: " + e.message, "error");
    }
  }

  // One pick. `full` adds the reason line and the action buttons — the Home
  // carousel stays a plain tile so it reads like the rows around it.
  function smartPickCard(pick, full) {
    const card = document.createElement("div");
    card.className = "pick-card" + (full ? " pick-card-full" : "");
    const art = document.createElement("div");
    art.className = "pick-art";
    if (pick.image) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = pick.image;
      art.appendChild(img);
    }
    card.appendChild(art);

    const meta = document.createElement("div");
    meta.className = "pick-meta";
    const artist = document.createElement("div");
    artist.className = "pick-artist";
    artist.textContent = pick.artist;
    meta.appendChild(artist);
    const album = document.createElement("div");
    album.className = "pick-album";
    album.textContent = pick.album || "";
    meta.appendChild(album);
    if (full && pick.reason) {
      const why = document.createElement("div");
      why.className = "pick-reason";
      why.textContent = pick.reason;
      meta.appendChild(why);
    }
    card.appendChild(meta);

    if (full) {
      const actions = document.createElement("div");
      actions.className = "pick-actions";

      // Three states, and which one a pick is in is entirely about whether Roon
      // has it yet:
      //
      //   PLAY     — Roon has imported it, so it has an offset and every
      //              ordinary play route works. This is where the picks should
      //              be by morning when adding automatically is on.
      //   WAITING  — favourited on the service but not imported yet. Roon
      //              decides when, so there is nothing to press.
      //   ADD      — not in the streaming library. Where every pick sits when
      //              automatic adding is off.
      if (pick.offset !== null && pick.offset !== undefined) {
        const play = document.createElement("button");
        play.type = "button";
        play.className = "pick-add pick-play";
        play.textContent = "▶ Play";
        play.addEventListener("click", () => openAlbum({
          offset:    pick.offset,
          // Roon's OWN strings for the album, not Qobuz's — the play routes
          // check identity against the snapshot, and an edition suffix that
          // differs would be refused as a stale offset.
          title:     pick.library_title || pick.album || "",
          subtitle:  pick.library_subtitle || pick.artist || "",
          image_key: pick.image_key || null
        }, { filter: null }));
        actions.appendChild(play);
      } else if (pick.added) {
        const wait = document.createElement("button");
        wait.type = "button";
        wait.className = "pick-add is-done";
        wait.disabled = true;
        wait.textContent = "✓ Added — waiting for Roon";
        actions.appendChild(wait);
      } else {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "pick-add";
        add.textContent = smartPickAddLabel(false);
        add.addEventListener("click", () => addSmartPick(pick, add));
        actions.appendChild(add);
      }

      const nope = document.createElement("button");
      nope.type = "button";
      nope.className = "pick-block";
      nope.textContent = "Not for me";
      nope.addEventListener("click", () => blockSmartPick(pick, card));
      actions.appendChild(nope);
      card.appendChild(actions);
    } else {
      // On Home the whole tile opens the full screen, where the reason and the
      // actions live. A tile that did nothing on tap would read as broken.
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      // A pick Roon already has behaves like any other album tile; one it does
      // not opens the Smart Picks screen, where Add and the reason live.
      const open = () => {
        if (pick.offset !== null && pick.offset !== undefined) {
          openAlbum({
            offset:    pick.offset,
            title:     pick.library_title || pick.album || "",
            subtitle:  pick.library_subtitle || pick.artist || "",
            image_key: pick.image_key || null
          }, { filter: null });
        } else {
          showSmartPicks();
        }
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    }
    return card;
  }

  function renderHomePicks(picks) {
    if (!homePicks) return false;
    const sec = homePicks.closest(".home-section");
    if (!picks || !picks.length) {
      // Nothing built yet. Hide the section rather than show an empty row —
      // the first build runs in the background and may take a minute.
      if (sec) sec.classList.add("hidden");
      return false;
    }
    if (sec) sec.classList.toggle("hidden", !homeRowOn("picks"));   // never un-hide a row the layout switched off
    homePicks.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const p of picks) frag.appendChild(smartPickCard(p, false));
    homePicks.appendChild(frag);
    return true;
  }

  async function loadHomeSmartPicks() {
    if (!homePicks) return;
    try {
      const r = await fetch("/api/smart-picks");
      if (!r.ok) return;   // 503 while pairing / 500 — retried on the next visit
      const j = await r.json();
      const picks = (j && j.picks) || [];
      if (picks.length) {
        renderHomePicks(picks);
        homePicksDay = localDayKey();   // our own key — see localDayKey
      } else if (!rowHasContent(homePicks)) {
        // Genuinely nothing yet (the build runs in the background) and no
        // cached row to keep — hide the section rather than leave an empty one.
        renderHomePicks([]);
      }
    } catch (e) {
      // Transient — the row simply stays hidden and is retried next visit.
      // Silence is safe here because nothing was replaced or lost.
    }
  }

  // The full Smart Picks screen: every pick with its reason and its actions.
  // (smartPicksActive / smartPicksSeq are declared with the other view flags at
  // the top of the file — leavePlaylistScreens writes them, and that can run
  // during boot.)
  async function showSmartPicks() {
    enterFullWall("Smart Picks");
    smartPicksActive = true;
    const mySeq = ++smartPicksSeq;
    let j = null;
    try {
      const r = await fetch("/api/smart-picks");
      j = await r.json();
      // A 503 while pairing carries a real explanation ("Not paired with Roon
      // Core yet"). Dropping it for the generic message throws away the one
      // thing that tells the user what to do.
      if (!r.ok && !(j && j.error)) j = { error: "HTTP " + r.status };
    } catch (e) {
      j = null;
    }
    if (!smartPicksActive || mySeq !== smartPicksSeq) return;   // user moved on
    grid.innerHTML = "";
    if (!j || j.error) {
      setBanner(j && j.error
        ? ("Couldn't load Smart Picks — " + j.error)
        : "Couldn't load Smart Picks — the extension didn't answer. Try again.", true);
      return;
    }
    const picks = j.picks || [];
    if (!picks.length) {
      setBanner(j.service_ready
        ? "Building today's picks — this takes a minute the first time. Come back shortly."
        : "Connect Qobuz or TIDAL in Settings and Smart Picks can suggest albums " +
          "you can add straight to your library.", false);
      return;
    }
    setBanner(j.service_ready ? null
      : "Connect Qobuz or TIDAL in Settings to add any of these to your library.", false);
    const wrap = document.createElement("div");
    wrap.className = "pick-list";
    for (const p of picks) wrap.appendChild(smartPickCard(p, true));
    grid.appendChild(wrap);
  }

  // Label of the week — one label featured for the whole ISO week (backend
  // picks deterministically). Retried each Home visit until it populates (the
  // labels scan runs in the background), then left alone. Tapping the header
  // opens the full label view.
  // Returns true when it painted a real row (a qualifying label with albums).
  function renderHomeLotw(label, albums) {
    const titleEl = document.getElementById("home-lotw-title");
    albums = albums || [];
    const sec = homeLotw.closest(".home-section");
    if (!label || !albums.length) {
      // No qualifying label yet (labels still scanning / library too small):
      // hide the whole section rather than show an empty row.
      if (sec) sec.classList.add("hidden");
      return false;
    }
    if (titleEl) titleEl.textContent = "Label of the week: " + label;
    homeLotw.dataset.label = label;
    if (sec) sec.classList.toggle("hidden", !homeRowOn("lotw"));   // never un-hide a row the layout switched off   // un-hide if a prior attempt hid it
    homeLotw.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const a of albums) frag.appendChild(homeTile(a));   // full-hierarchy offsets → filter:null
    homeLotw.appendChild(frag);
    return true;
  }

  async function loadHomeLabelOfWeek() {
    if (!homeLotw) return;
    if (!rowHasContent(homeLotw)) homeLotw.innerHTML = '<div class="home-carousel-empty">Loading…</div>';
    try {
      const r = await fetch("/api/home/label-of-the-week");
      const j = await r.json();
      const albums = (j && j.albums) || [];
      if (j && j.label && albums.length) {
        renderHomeLotw(j.label, albums);
        homeLotwLoaded = true;   // populated — stop retrying on future visits
        saveHomeCache({ lotw: { label: j.label, albums } });
      } else if (!rowHasContent(homeLotw)) {
        // Empty 200 (labels index still building after a restart returns
        // {label:null} — not a 503). Only hide the section when nothing is
        // cached; otherwise keep the hydrated row rather than blanking it.
        renderHomeLotw(null, []);
      }
    } catch (e) {
      // Transient failure: keep any cached row rather than blanking it. Only
      // hide the section when there's nothing cached to fall back on.
      if (!rowHasContent(homeLotw)) {
        const sec = homeLotw.closest(".home-section");
        if (sec) sec.classList.add("hidden");
      }
    }
  }
  // ---------------------------------------------------------------------
  // Overflow menu — Roon's three-dots-in-a-circle.
  //
  // ONE definition, used by every screen that has more secondary actions than
  // fit on a row. Before this, the playlist screens laid six pill buttons side
  // by side: .action-btn is `flex: 1 1 0`, so they all shrank together instead
  // of wrapping and "Send to Roon" rendered as "end to Roo".
  //
  // The dropdown reuses .sel-menu / .sel-menu-item — the album view's selection
  // menu — so there is one dropdown look in the app rather than a second one
  // that almost matches.
  // ---------------------------------------------------------------------
  // Mirrors libraryChangingAdvice() on the server, for the notes the client
  // composes itself. Same three things every message on this path carries: why
  // it happened, what the extension is doing, and the manual way out.
  //
  // `moved` is the server's library_moved flag, and it picks the TIMING as well
  // as the wording — the two cases wait on different clocks. When the change is
  // proven the server has already armed the recheck chain (5 minutes); when it
  // is only the likeliest explanation, the next look is the background watch
  // (10 minutes). One number for both would be wrong exactly when it is read.
  function libraryChangingAdvice(moved) {
    return (moved
      ? " Your Roon library changed after this list was built"
      : " This usually means your Roon library changed after this list was built") +
      " — normally because albums are being added or identified. " +
      (moved ? "A re-check is already scheduled — about 5 minutes"
             : "The extension re-checks every 10 minutes") +
      " — and it refreshes itself once Roon settles, so this usually clears on " +
      "its own. If it hasn't, open the side menu and tap Rescan library.";
  }

  const OVERFLOW_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<circle cx="7.6" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="16.4" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
    "</svg>";

  // Bumped every time iOS backgrounds the app.
  //
  // A suspended PWA has its in-flight fetches torn down, and the rejection is
  // only delivered when the app is reopened. So a request that spanned a
  // hide/show did not fail in any sense the user should hear about — it was
  // interrupted by them switching apps, and the server almost certainly carried
  // it out. Comparing this counter before and after tells the two apart.
  let hiddenEpoch = 0;
  document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenEpoch++; });

  // Close whichever overflow menu is open. Module-level rather than per-menu so
  // opening one closes any other, and so a screen teardown can shut it.
  let _openOverflow = null;
  function closeOverflowMenu() {
    if (!_openOverflow) return;
    _openOverflow.menu.classList.add("hidden");
    _openOverflow.btn.setAttribute("aria-expanded", "false");
    _openOverflow = null;
  }
  document.addEventListener("click", (e) => {
    if (_openOverflow && !e.target.closest(".overflow-wrap")) closeOverflowMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeOverflowMenu();
  });

  // items: [{ label, onClick, danger, title }]. Returns the wrapper to append.
  function buildOverflowMenu(items, opts) {
    opts = opts || {};
    const wrap = document.createElement("div");
    wrap.className = "overflow-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "overflow-btn";
    btn.setAttribute("aria-label", opts.label || "More actions");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = OVERFLOW_SVG;

    const menu = document.createElement("div");
    menu.className = "sel-menu overflow-menu hidden";
    menu.setAttribute("role", "menu");
    if (opts.title) {
      const t = document.createElement("div");
      t.className = "sel-menu-title";
      t.textContent = opts.title;
      menu.appendChild(t);
    }
    for (const it of items) {
      if (!it) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sel-menu-item" + (it.danger ? " is-danger" : "");
      b.setAttribute("role", "menuitem");
      b.textContent = it.label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeOverflowMenu();
        // The button is passed on so an action can disable it / show progress,
        // exactly as the pill buttons it replaced did.
        it.onClick(b);
      });
      menu.appendChild(b);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = _openOverflow && _openOverflow.menu === menu;
      closeOverflowMenu();
      if (wasOpen) return;
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
      _openOverflow = { btn, menu };
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }


  // Shared entry ritual for the full-screen Home walls (Not played / Library):
  // leave other views, clear the filter, take over the shared grid, set the
  // topbar chrome + title, scroll to the top, paint skeletons. Both walls'
  // active flags are reset here; the caller sets its own to true afterwards.
  function enterFullWall(title) {
    unplayedWallActive = false;
    libraryWallActive = false;
    // Cleared here as well as by the caller: every other wall's entry point must
    // orphan an in-flight playlist fetch, or its response paints into this one.
    leavePlaylistScreens();
    // The library wall's sort/focus row belongs to that wall only.
    { const c = document.getElementById("library-controls"); if (c) c.classList.add("hidden"); }
    exitAlbumSelectMode();   // a stale multi-select bar must not survive into a new wall
    if (window.__exitLabels) window.__exitLabels();
    if (activeFilter) {
      activeFilter = null;
      try { localStorage.removeItem("rra-filter"); } catch (e) {} // localStorage optional (private browsing)
    }
    if (homeView) homeView.classList.add("hidden");
    if (homeSections) homeSections.classList.remove("hidden");
    grid.classList.remove("hidden");
    clearWallGridSizing();  // standard scrolling grid, not phone-fit wall
    setTopbarNav(true, false, false);   // Back (to Home), no Refresh, no search
    setCountText(title);
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
    renderSkeletons(computeAlbumCount());
    return m;
  }

  // Full-screen "Not played in 6 months" grid — reached by tapping the section
  // header. Fills the main grid with a larger unplayed list (tiles open
  // unfiltered, like the Home row) and shows a Back button to Home.
  async function showUnplayedWall() {
    enterFullWall("Not played in 6 months");
    unplayedWallActive = true;
    try {
      const r = await fetch("/api/home/unplayed?months=6&count=96");
      // The user may have navigated away while the fetch ran — a late response
      // must not clobber whatever view owns the shared grid now.
      if (!unplayedWallActive) return;
      if (r.status === 503) {
        const j = await r.json().catch(() => ({}));
        if (!unplayedWallActive) return;
        setBanner(j.error || "Waiting for Roon Core. Enable this extension in Roon → Settings → Extensions.", true);
        grid.innerHTML = ""; return;
      }
      const j = await r.json();
      if (!unplayedWallActive) return;
      const albums = (j && j.albums) || [];
      grid.innerHTML = "";
      if (!albums.length) {
        setBanner("Nothing here yet — play some music and check back.", false);
        return;
      }
      setBanner(null);
      const frag = document.createDocumentFragment();
      for (const a of albums) frag.appendChild(homeTile(a));   // filter:null → offsets resolve
      grid.appendChild(frag);
    } catch (e) {
      if (!unplayedWallActive) return;
      grid.innerHTML = "";
      setBanner("Couldn’t load: " + e.message, true);
    }
  }

  // Full-screen Library wall — the WHOLE library in Roon's own album order,
  // loaded in pages from the snapshot index (no Roon calls) and appended as
  // the user scrolls. Reached by tapping the "Library" section header.
  const LIB_PAGE = 60;
  // sort/dir/focus persist so the wall reopens exactly as the user left it.
  // Roon's own Sort/Focus run on a private API — these are built from the
  // extension's own snapshot, so changing them costs no Roon calls at all.
  // ---- Library wall: sort + focus options ---------------------------------
  // Roon's Sort/Focus live on a private API, so these are built from this
  // extension's own snapshot.
  //
  // Declared HERE, above libView, because the persisted-state migration below
  // calls libSortDefaultDir(). A `const` referenced before its declaration is a
  // ReferenceError, not undefined — with these left further down the file the
  // app would fail to boot the moment a v1 blob was in localStorage.
  //
  // `asc`/`desc` are the human meanings of the two arrow directions for that
  // sort, and `dir` is which one you get when you first pick it: alphabetical
  // sorts open A→Z, everything quantitative opens with the biggest/newest
  // first, which is what people mean by "sort by year" or "most played".
  const LIB_SORT_OPTIONS = [
    { id: "album",      label: "Album name",   dir: "asc",
      asc: "A → Z", desc: "Z → A" },
    { id: "artist",     label: "Artist",       dir: "asc",
      asc: "A → Z", desc: "Z → A" },
    { id: "year",       label: "Release year", dir: "desc",
      asc: "Oldest first", desc: "Newest first",
      note: "from years collected during scanning" },
    { id: "added",      label: "Recently added", dir: "desc",
      asc: "Oldest first", desc: "Newest first",
      // Deliberately not "when you added it": Roon publishes no import date,
      // so this is the extension's own evidence — file timestamps, and albums
      // turning up between library scans.
      note: "from dates MusicD Remote could work out" },
    { id: "plays",      label: "Most played",  dir: "desc",
      asc: "Least played first", desc: "Most played first",
      note: "from plays MusicD Remote has seen" },
    { id: "lastplayed", label: "Last played",  dir: "desc",
      asc: "Longest ago first", desc: "Most recent first",
      note: "from plays MusicD Remote has seen" },
    { id: "random",     label: "Random",       dir: "asc" }   // no direction
  ];
  const LIB_PLAYED_OPTIONS = [
    { id: "any",   label: "Any" },
    { id: "never", label: "Never played" },
    { id: "6",     label: "Not in 6 months" },
    { id: "12",    label: "Not in 12 months" }
  ];
  // Random has no meaningful direction, so the arrow control hides for it.
  const libSortHasDir = (id) => id !== "random";
  // A seed the server hasn't just served, so a reshuffle visibly reorders
  // instead of repainting the same shuffle. 1..100000: the server does
  // `parseInt(seed) || 1`, so 0 would silently mean "the default seed".
  function libNextSeed(current) {
    let next = current;
    while (next === current) next = Math.floor(Math.random() * 100000) + 1;
    return next;
  }
  function libSortDefaultDir(id) {
    const o = LIB_SORT_OPTIONS.find(x => x.id === id);
    return o ? o.dir : "asc";
  }

  const LIB_VIEW_KEY = "rra-library-view";
  // v2 changed what `dir` MEANS for Most played / Last played, and ONLY those
  // two: the server used to invert them, so "asc" produced most-played-first.
  // Now "desc" means descending for every sort. Album/Artist/Release year meant
  // the same thing in v1, so a v1 blob keeps its direction for those — dropping
  // it wholesale would silently reset someone's Z→A wall to A→Z and, because
  // the migrated blob is written straight back, lose the preference for good.
  const LIB_VIEW_VERSION = 2;
  const LIB_V1_INVERTED_SORTS = ["plays", "lastplayed"];
  const libWall = { offset: 0, loading: false, done: false, seq: 0, total: 0 };
  // Every multi-select Focus facet, in the order the sheet lays them out. This
  // list is the client's half of libFacetDefs() on the server; the SERVER is
  // what decides which of them actually have values, and the sheet renders
  // whatever /api/library/facets returns rather than assuming. Keeping the ids
  // in one array is what stops the query builder, the saved-view snapshot, the
  // reset and the active-count from drifting apart as facets are added.
  const LIB_FACET_IDS = ["genre", "source", "decade", "label", "format",
                         "rate", "bits", "chan", "letter", "added"];
  const libEmptyFacets = () => {
    const o = {};
    for (const id of LIB_FACET_IDS) o[id] = [];
    return o;
  };
  // `prefix` is deliberately NOT persisted with the rest of the view: it is a
  // momentary narrowing, and restoring one on next launch would look like a
  // library that had lost most of its albums. It is stripped after the restore
  // below for the same reason.
  let libView = Object.assign(
    { v: LIB_VIEW_VERSION, sort: "album", dir: "asc", seed: 1, played: "any", prefix: "" },
    libEmptyFacets());
  try {
    const saved = JSON.parse(localStorage.getItem(LIB_VIEW_KEY) || "null");
    if (saved && typeof saved === "object") {
      const stale = saved.v !== LIB_VIEW_VERSION;
      const dirChangedMeaning = stale && LIB_V1_INVERTED_SORTS.indexOf(saved.sort) > -1;
      if (dirChangedMeaning) delete saved.dir;
      libView = Object.assign(libView, saved, { v: LIB_VIEW_VERSION, prefix: "" });
      if (dirChangedMeaning) libView.dir = libSortDefaultDir(libView.sort);
      // A blob is JSON, so it can be well-formed and still the wrong SHAPE —
      // a partial write or a synced/hand-edited value. Object.assign copies it
      // verbatim, and the try/catch here only covers the parse, so an
      // unvalidated `decade: null` throws later, at render time, inside an
      // un-awaited async handler: the wall opens empty with no error and no way
      // out of it short of clearing site data. Coerce instead.
      for (const id of LIB_FACET_IDS) {
        libView[id] = Array.isArray(libView[id]) ? libView[id].map(String) : [];
      }
      if (!LIB_PLAYED_OPTIONS.some(p => p.id === libView.played)) libView.played = "any";
      if (libView.dir !== "asc" && libView.dir !== "desc") libView.dir = libSortDefaultDir(libView.sort);
      if (!Number.isFinite(libView.seed)) libView.seed = 1;
      if (stale) {
        // Write the migrated blob back NOW rather than waiting for the user to
        // change something. Without this the stored blob stays at v1, so the
        // migration re-runs on every load and keeps resetting the direction
        // they just chose.
        saveLibView();
      }
    }
  } catch (e) { /* corrupt or unavailable — the defaults above stand */ }
  function saveLibView() {
    try { localStorage.setItem(LIB_VIEW_KEY, JSON.stringify(libView)); }
    catch (e) { /* localStorage optional (private browsing) */ }
  }
  function libViewQuery() {
    const p = new URLSearchParams();
    p.set("sort", libView.sort);
    p.set("dir", libView.dir);
    if (libView.sort === "random") p.set("seed", String(libView.seed));
    for (const id of LIB_FACET_IDS) {
      for (const v of (libView[id] || [])) p.append(id, v);
    }
    if (libView.played !== "any") p.set("played", libView.played);
    if (libView.prefix) p.set("prefix", libView.prefix);
    return p.toString();
  }
  // How many filters are ON. Every selected chip counts — including the
  // excluded ones, which are as much a filter as the included ones.
  // Only the facets the SERVER is currently publishing. With Labels off the
  // "Record label" facet is gone from the sheet, and counting a selection
  // stored before the switch was flipped would show a filter the user can
  // neither see nor clear.
  // Seeded at boot from the Labels switch, not only when the Focus sheet is
  // first opened. `/api/library/facets` is fetched on sheet open, so relying on
  // it alone left the wall's "N matching albums" and the Focus badge counting a
  // stored Record-label selection on every fresh load until the sheet had been
  // opened once — which is exactly the invisible, unclearable filter this is
  // meant to prevent.
  let libAvailableFacets = LIB_FACET_IDS.slice();
  window.__setLabelsFacetAvailable = (on) => {
    libAvailableFacets = on ? LIB_FACET_IDS.slice()
                            : LIB_FACET_IDS.filter(id => id !== "label");
  };
  const libFocusCount = () =>
    libAvailableFacets.reduce((n, id) => n + (libView[id] || []).length, 0) +
    (libView.played !== "any" ? 1 : 0);
  // Chip state, encoding Roon's tap-again-to-invert: a value prefixed with "!"
  // is EXCLUDED. Kept inside the value so the whole selection stays a plain
  // string array that saved playlists and the query string round-trip unchanged.
  const facetState = (sel, value) =>
    sel.indexOf(value) > -1 ? "on" : (sel.indexOf("!" + value) > -1 ? "not" : "off");
  // off → on → not → off, which is Roon's cycle (green, then red, then clear).
  function facetCycle(sel, value) {
    const i = sel.indexOf(value), j = sel.indexOf("!" + value);
    if (i > -1)      { sel.splice(i, 1, "!" + value); }
    else if (j > -1) { sel.splice(j, 1); }
    else             { sel.push(value); }
    return sel;
  }
  // Any view that takes over the shared grid without going through showHome/
  // showWall (labels browser, label deep-link, artist view) must call this so
  // the wall's infinite scroll can't append library tiles into that view.
  // Returns whether the wall WAS active, so a view that only borrows the grid
  // (the artist view, which restores it on Back) can re-arm paging afterwards.
  // ----- Roon playlists (read + play) --------------------------------------
  //
  // Reached from the side menu, not a Home row: listing playlists is a Roon
  // browse walk, and a Home row would pay for it on every Home load.
  //
  // A playlist is identified across requests by (offset, title) — never an
  // item_key, which is session-scoped server-side. The title is what makes a
  // drifted offset safe, so every call carries it.
  // ONE playlist screen. From the user's side a playlist is a playlist; that
  // some come from Roon and some are stored here is our problem, not something
  // to make them navigate around. Stored ones lead, because they are the ones
  // this app can actually change — imports, and anything added from a
  // selection — and finding a fresh import buried under the Roon list would
  // read as the import having failed.
  //
  // The two sources are fetched together but tolerated separately: Roon being
  // unreachable must not hide playlists that live on this disk, and vice versa.
  async function showPlaylists() {
    enterFullWall("Playlists");
    playlistsActive = true;
    const mySeq = ++playlistSeq;
    grid.innerHTML = "";

    // `null` means "this source did not answer", which is distinct from a
    // source that answered with an empty list — one is a warning, the other is
    // just an empty shelf.
    const read = async (url) => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return null;
        return await r.json();
      } catch (e) { return null; }
    };
    const [roon, mine] = await Promise.all([
      read("/api/playlists"), read("/api/user-playlists"),
    ]);
    // Re-check after the await: a late response must not paint into a screen
    // the user has since navigated away from.
    if (!playlistsActive || mySeq !== playlistSeq) return;

    const roonList = (roon && roon.playlists) || [];
    const myList   = (mine && mine.playlists) || [];
    grid.innerHTML = "";

    if (!roonList.length && !myList.length) {
      setBanner(roon === null
        ? "Couldn't read playlists from Roon."
        : "No playlists yet — import one, or select tracks and use Add to playlist.",
        roon === null);
      return;
    }
    setBanner(roon === null
      ? "Couldn't reach Roon — showing only the playlists stored here." : null, roon === null);

    const frag = document.createDocumentFragment();
    for (const p of myList) {
      const n = p.track_total;
      frag.appendChild(buildAlbumTile({
        title: p.name,
        subtitle: `${n} track${n === 1 ? "" : "s"}`,
        image_key: null,
        // Stored tracks carry their album's art, so the mosaic costs nothing.
        art_keys: p.art_keys || []
      }, () => openUserPlaylist(p), { selectable: false }));
    }

    const tiles = new Map();
    for (const p of roonList) {
      const tile = buildAlbumTile(p, () => openPlaylist(p), { selectable: false });
      tiles.set(p.title, tile);
      frag.appendChild(tile);
    }
    grid.appendChild(frag);
    // Only Roon's need a mosaic walk; the stored ones already have their keys.
    if (roonList.length) fillPlaylistMosaics(roonList, tiles, mySeq);
  }
  window.__showPlaylists = showPlaylists;

  // Roon gives a playlist no cover of its own, so a mosaic has to come from the
  // tracks inside — one browse walk per playlist. Far too slow to block the grid
  // on, so the tiles appear immediately and fill in behind, TWO AT A TIME: an
  // unthrottled sweep would fire a browse walk per playlist at the Core all at
  // once. The server caches each result, so this only really runs the first time.
  async function fillPlaylistMosaics(list, tiles, mySeq) {
    const pending = list.filter(p => !(Array.isArray(p.art_keys) && p.art_keys.length));
    let i = 0;
    const worker = async () => {
      while (i < pending.length) {
        const p = pending[i++];
        if (!playlistsActive || mySeq !== playlistSeq) return;   // left the screen
        try {
          const r = await fetch(`/api/playlist/art?offset=${encodeURIComponent(p.offset)}` +
                                `&title=${encodeURIComponent(p.title || "")}`, { cache: "no-store" });
          if (!r.ok) continue;
          const j = await r.json();
          if (!playlistsActive || mySeq !== playlistSeq) return;
          const keys = (j && j.art_keys) || [];
          if (!keys.length) continue;
          const tile = tiles.get(p.title);
          if (!tile || !tile.isConnected) continue;
          repaintTileArt(tile, keys);
        } catch (e) { /* one missing mosaic is cosmetic — keep going */ }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  // Swap a placeholder tile's artwork for a mosaic in place, without rebuilding
  // the tile — it carries the click handler that opens the playlist.
  function repaintTileArt(tile, keys) {
    const wrap = tile.querySelector(".album-art-wrap");
    if (!wrap) return;
    for (const img of Array.from(wrap.querySelectorAll("img"))) img.remove();
    wrap.classList.remove("no-image");
    const use = keys.filter(Boolean).slice(0, 4);
    if (use.length >= 2) {
      wrap.classList.add("album-art-mosaic");
      wrap.dataset.mosaic = String(use.length);
    }
    wrap.dataset.artKeys = use.join(",");
    for (const k of use) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = "";
      img.src = `/api/image/${encodeURIComponent(k)}?size=${TILE_IMG_SIZE}`;
      img.onerror = () => img.remove();
      wrap.appendChild(img);
    }
    if (!use.length) wrap.classList.add("no-image");
  }

  async function openPlaylist(p) {
    enterFullWall("");   // the Roon playlist prints its own full-width heading
    playlistDetailActive = true;
    const mySeq = ++playlistSeq;
    let j = null;
    try {
      // The zone travels with the read: Roon needs one to resolve a SMART
      // playlist's contents, and without it the list comes back empty.
      const zsel = document.getElementById("zone-select");
      const zid = (zsel && zsel.value) || selectedZoneId || "";
      const r = await fetch(`/api/playlist?offset=${encodeURIComponent(p.offset)}` +
                            `&title=${encodeURIComponent(p.title || "")}` +
                            (zid ? `&zone=${encodeURIComponent(zid)}` : ""),
                            { cache: "no-store" });
      if (!playlistDetailActive || mySeq !== playlistSeq) return;
      j = await r.json().catch(() => ({}));
      if (!playlistDetailActive || mySeq !== playlistSeq) return;
      if (!r.ok) {
        grid.innerHTML = "";
        setBanner(j.error || "Couldn't open that playlist.", true);
        return;
      }
    } catch (e) {
      if (!playlistDetailActive || mySeq !== playlistSeq) return;
      grid.innerHTML = "";
      setBanner("Couldn't open that playlist.", true);
      return;
    }

    setBanner(null);
    grid.innerHTML = "";
    clearWallGridSizing();

    const wrap = document.createElement("div");
    wrap.className = "playlist-detail";

    // Its own Back, because the topbar's Back goes to Home and drilling two
    // levels deep should not throw the user all the way out.
    const back = document.createElement("button");
    back.type = "button"; back.className = "action-btn playlist-back";
    back.textContent = "← Playlists";
    back.addEventListener("click", () => { playlistDetailActive = false; showPlaylists(); });
    wrap.appendChild(back);

    const head = document.createElement("div");
    head.className = "playlist-head";
    const h = document.createElement("h2");
    h.className = "playlist-title";
    h.textContent = j.title || p.title || "Playlist";
    head.appendChild(h);
    if (j.subtitle) {
      const sub = document.createElement("div");
      sub.className = "playlist-sub";
      sub.textContent = j.subtitle;
      head.appendChild(sub);
    }
    wrap.appendChild(head);

    const zoneOf = () => {
      const sel = document.getElementById("zone-select");
      return (sel && sel.value) || selectedZoneId || null;
    };
    const act = async (url, body, btn) => {
      const zone = zoneOf();
      if (!zone) { showToast("Choose a zone first", "error"); return; }
      btn.disabled = true;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ zone_or_output_id: zone }, body))
        });
        const jr = await r.json().catch(() => ({}));
        if (!r.ok) showToast(jr.error || "Roon refused that", "error");
        else showToast(jr.invoked ? jr.invoked : "Sent to Roon");
      } catch (e) {
        showToast("Couldn't reach the extension", "error");
      } finally {
        btn.disabled = false;
      }
    };

    const tracks = (j && j.tracks) || [];

    if (j.can_play || tracks.length) {
      const actions = document.createElement("div");
      actions.className = "playlist-actions";
      if (j.can_play) {
        for (const [label, kind, cls] of [
          ["Play now", "play_now", "action-btn primary"],
          ["Queue",    "queue",    "action-btn"],
        ]) {
          const b = document.createElement("button");
          b.type = "button"; b.className = cls;
          b.textContent = label;
          b.addEventListener("click", () => act("/api/playlist/play",
            { offset: p.offset, title: p.title || "", kind }, b));
          actions.appendChild(b);
        }
      }
      if (tracks.length) {
        actions.appendChild(buildOverflowMenu([
          { label: "Share", onClick: (b) => shareTracks(p.title || "Playlist",
            // A Roon playlist row carries the track and its artist, but no
            // album — Roon does not put one on the row. The `album` slot is
            // left empty rather than guessed at, so an importer knows it was
            // never told.
            tracks.map(t => ({
              title: t.title, artist: t.subtitle, track_no: t.track_no
            })), b,
            // /api/playlist reads at most PLAYLIST_ITEMS rows, so a longer
            // playlist arrives already cut short. The screen says so; the share
            // sheet has to as well, or the file claims to be the whole thing.
            { sourceTruncated: !!j.truncated }) },
        ], { title: p.title || "Playlist" }));
      }
      wrap.appendChild(actions);
    }

    if (!tracks.length) {
      const note = document.createElement("div");
      note.className = "playlist-empty";
      note.textContent = "Roon returned no tracks for this playlist.";
      wrap.appendChild(note);
    } else {
      const ol = document.createElement("ol");
      ol.className = "track-list playlist-tracks";
      for (const t of tracks) {
        const li = document.createElement("li");
        li.className = "track-row track-row-art";
        li.dataset.index = String(t.index);
        // Roon gives each playlist track its own image_key; fall back to the
        // playlist's own art so a row is never a bare gap.
        const art = document.createElement("span");
        art.className = "track-art";
        const key = t.image_key || j.image_key;
        if (key) art.dataset.artKey = key;
        if (key) {
          const img = document.createElement("img");
          img.loading = "lazy"; img.alt = "";
          img.src = `/api/image/${encodeURIComponent(key)}?size=80`;
          img.onerror = () => { art.classList.add("no-image"); img.remove(); };
          art.appendChild(img);
        } else {
          art.classList.add("no-image");
        }
        li.appendChild(art);
        const text = document.createElement("div");
        text.className = "track-text";
        const tt = document.createElement("div");
        tt.className = "track-title";
        tt.textContent = t.title || "";
        text.appendChild(tt);
        if (t.subtitle) {
          const ts = document.createElement("div");
          ts.className = "track-artist";
          ts.textContent = t.subtitle;
          text.appendChild(ts);
        }
        li.appendChild(text);
        li.addEventListener("click", () => act("/api/playlist/play-track", {
          offset: p.offset, title: p.title || "",
          track_index: t.index, track_title: t.title || "", kind: "play_now"
        }, li));
        ol.appendChild(li);
      }
      wrap.appendChild(ol);
      if (j.truncated) {
        const note = document.createElement("div");
        note.className = "playlist-empty";
        note.textContent = `Showing the first ${tracks.length} of ${j.total} tracks.`;
        wrap.appendChild(note);
      }
    }
    grid.appendChild(wrap);
  }

  // Any screen that takes over the shared grid must orphan in-flight playlist and
  // smart-playlist work. Two things go wrong otherwise: a late response paints
  // its tiles over whatever screen is now showing, and fillPlaylistMosaics keeps
  // firing a browse walk per playlist at the Core long after the user has left.
  // Centralised so a future screen can call one thing instead of remembering
  // four flags.
  function leavePlaylistScreens() {
    playlistsActive = false;
    playlistDetailActive = false;
    smartWallActive = false;
    smartDetailActive = false;
    userPlDetailActive = false;
    // Smart Picks joins the same ritual: every screen entry point must orphan
    // an in-flight picks fetch, or its response paints into whatever opened
    // next. enterFullWall and showHome both call this, so adding it here covers
    // every route out of the screen at once.
    smartPicksActive = false;
    playlistSeq++;
    smartSeq++;
    userPlSeq++;
    smartPicksSeq++;
  }
  window.__leavePlaylistScreens = leavePlaylistScreens;

  function leaveLibraryWall() { const was = libraryWallActive; libraryWallActive = false; return was; }
  window.__leaveLibraryWall = leaveLibraryWall;
  window.__restoreLibraryWall = (was) => { libraryWallActive = !!was; };
  window.__libraryWallSeq = () => libWall.seq;

  async function fetchLibraryPage(mySeq, firstPage) {
    if (libWall.loading) return;   // a page is already in flight for this view
    libWall.loading = true;
    try {
      const r = await fetch(`/api/library/albums?offset=${libWall.offset}&count=${LIB_PAGE}&${libViewQuery()}`);
      // Left the wall (or re-entered, bumping seq) while the fetch was in
      // flight — this response belongs to a dead view; drop it silently.
      if (!libraryWallActive || mySeq !== libWall.seq) return;
      if (r.status === 503) {
        const j = await r.json().catch(() => ({}));
        if (!libraryWallActive || mySeq !== libWall.seq) return;
        if (firstPage) { grid.innerHTML = ""; setBanner(j.error || "Waiting for Roon Core…", true); }
        libWall.done = true;   // don't hammer while the index builds; re-enter to retry
        return;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      // Re-check after EVERY await: the body read is a second suspension point,
      // and a view change during it would otherwise get tiles appended into it.
      if (!libraryWallActive || mySeq !== libWall.seq) return;
      const albums = (j && j.albums) || [];
      if (firstPage) { grid.innerHTML = ""; setBanner(null); }
      const frag = document.createDocumentFragment();
      for (const a of albums) frag.appendChild(homeTile(a));   // filter:null → offsets resolve
      grid.appendChild(frag);
      libWall.offset += albums.length;
      // End of library = a short (or empty) page; no separate total bookkeeping.
      libWall.done = albums.length < LIB_PAGE;
      libWall.total = (j && typeof j.total === "number") ? j.total : libWall.offset;
      if (firstPage) {
        setCountText("Library · " + libWall.total.toLocaleString() +
                     (libFocusCount() ? " matching" : "") + (libWall.total === 1 ? " album" : " albums"));
        if (!albums.length) setBanner("Nothing matches this focus — try clearing a filter.", false);
      }
    } catch (e) {
      if (!libraryWallActive || mySeq !== libWall.seq) return;
      if (firstPage) { grid.innerHTML = ""; setBanner("Couldn’t load: " + e.message, true); }
      // Mid-scroll page failure: leave what's loaded; the scroll handler will
      // retry the same offset on the next nudge.
    } finally {
      if (mySeq === libWall.seq) libWall.loading = false;
    }
  }

  let libFacets = null;   // cached /api/library/facets payload

  function libSortOption(id) {
    return LIB_SORT_OPTIONS.find(x => x.id === (id || libView.sort)) || LIB_SORT_OPTIONS[0];
  }
  function libSortLabel() { return libSortOption().label; }
  // What the arrow currently means, in words — used for the button's tooltip
  // and screen-reader name only. The visible control is the arrow alone.
  function libDirLabel() {
    const o = libSortOption();
    return libView.dir === "desc" ? o.desc : o.asc;
  }

  // Re-run the wall from page 1 with the current view options.
  function applyLibView() {
    saveLibView();
    renderLibraryControls();
    libWall.seq++;
    const mySeq = libWall.seq;
    libWall.offset = 0; libWall.loading = false; libWall.done = false;
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
    renderSkeletons(computeAlbumCount());
    fetchLibraryPage(mySeq, true);
  }

  // Roon's own phone layout for this row: Focus on the left behind a chevron,
  // the current Sort on the right behind a caret, and NOTHING between them.
  //
  // The separate direction arrow is gone. It was a third boxed control sitting
  // between two others, and Roon has no equivalent — direction is a property of
  // the sort, so it belongs in the sort menu, which has flipped it on a re-tap
  // since v1.6.59. The row still SHOWS the direction (and the reshuffle glyph
  // for Random) as part of the sort's own label, so nothing is hidden; it just
  // isn't its own button any more.
  // Whether the funnel's field is showing. Declared before renderLibraryControls
  // reads it: a `let` used above its declaration is a ReferenceError, which is
  // the v1.5.66 startup-crash class this project pre-flights for.
  let libFilterOpen = false;

  function renderLibraryControls() {
    let bar = document.getElementById("library-controls");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "library-controls";
      bar.className = "library-controls";
      grid.parentNode.insertBefore(bar, grid);
    }
    // Both controls open a sheet rather than mutating the view in place, so a
    // rebuild can no longer land under the user's finger mid-interaction — but
    // applyLibView() still rebuilds this row while the sort sheet is open and
    // focus is inside it, and dropping focus to <body> then would strand a
    // keyboard user. Restoring by class is enough: there are two controls and
    // they are rebuilt in a fixed order.
    // Restored by the control's OWN class, not its first one. Every control
    // here starts with `lib-ctl`, so splitting on the first token matched
    // whichever came first in the DOM — focus on Sort came back on Focus.
    const act = document.activeElement;
    const refocus = act && bar.contains(act) && act.className
      ? (String(act.className).split(" ").find(c => c !== "lib-ctl" && c) || "lib-ctl")
      : null;
    // Typing survives the rebuild applyLibView() does after every keystroke.
    // `libFilterOpen` is the truth; the live node is only consulted for where
    // the caret was.
    const typing = bar.querySelector(".lib-filter-input");
    const caret = typing ? typing.selectionStart : 0;

    bar.innerHTML = "";
    // Roon's own order on this screen: Focus left, Sort right, then the
    // magnifier that narrows the list. Matching it means the row reads the
    // same way in both apps rather than being a third arrangement to learn.
    bar.appendChild(buildLibFocusButton());
    bar.appendChild(buildLibSortButton());
    bar.appendChild(buildLibFilterControl(libFilterOpen));
    bar.classList.toggle("hidden", !libraryWallActive);
    // Drives the layout: Sort's auto margin is released while the field is
    // open so the input, not the margin, gets the row's free space.
    bar.classList.toggle("is-filtering", libFilterOpen);

    if (libFilterOpen) {
      const again = bar.querySelector(".lib-filter-input");
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); }
        catch (e) { /* type="search" refuses setSelectionRange on some engines */ }
      }
    } else if (refocus) {
      const again = bar.querySelector("." + refocus);
      if (again) again.focus();
    }
  }

  // The funnel: a text filter that narrows the wall by the first letters of an
  // album title OR an artist name.
  //
  // A user asked for an A-Z rail down the edge of the screen. That works only
  // while the wall is sorted alphabetically, which is why it broke under the
  // other sorts — a letter index means nothing when the order is by year or
  // play count. Filtering is orthogonal to sorting, so this works under all of
  // them, and it reaches artists as well as titles, which a rail cannot.
  function buildLibFilterControl(open) {
    const wrap = document.createElement("div");
    wrap.className = "lib-filter-wrap";

    if (!open) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lib-filter-btn lib-ctl" + (libView.prefix ? " is-active" : "");
      btn.setAttribute("aria-label", "Filter by name");
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
        '<line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        libFilterOpen = true;
        renderLibraryControls();
      });
      wrap.appendChild(btn);
      return wrap;
    }

    const input = document.createElement("input");
    input.type = "search";
    input.className = "lib-filter-input";
    input.value = libView.prefix || "";
    input.placeholder = "Starts with…";
    input.setAttribute("aria-label", "Filter albums and artists by first letters");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      libView.prefix = input.value.trim();
      applyLibView();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLibFilter();
    });
    wrap.appendChild(input);
    return wrap;
  }

  // Tap away closes AND clears, the same contract the topbar search follows.
  // A filter left applied behind a closed funnel is a wall that looks broken.
  function closeLibFilter() {
    if (!libFilterOpen) return;
    libFilterOpen = false;
    const had = !!libView.prefix;
    libView.prefix = "";
    if (had) applyLibView();
    else renderLibraryControls();
  }
  document.addEventListener("click", (e) => {
    if (!libFilterOpen) return;
    if (e.target.closest && e.target.closest(".lib-filter-wrap")) return;
    closeLibFilter();
  });

  // `› Focus`, with the number of active facets when there are any. The count
  // is the only state this control carries — what those facets ARE is the
  // sheet's job, and spelling them out here would wrap onto three lines on a
  // phone the moment more than one is on.
  function buildLibFocusButton() {
    const n = libFocusCount();
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lib-ctl lib-ctl-focus" + (n ? " is-active" : "");

    const chev = document.createElement("span");
    chev.className = "lib-ctl-chevron";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "›";
    b.appendChild(chev);

    const text = document.createElement("span");
    text.className = "lib-ctl-text";
    text.textContent = "Focus";
    b.appendChild(text);

    if (n) {
      const badge = document.createElement("span");
      badge.className = "lib-ctl-badge";
      badge.textContent = String(n);
      b.appendChild(badge);
    }
    b.setAttribute("aria-label", n
      ? "Focus — " + n + (n === 1 ? " filter active" : " filters active")
      : "Focus");
    // Wrapped, not passed by reference: the listener hands its callback an
    // event, which would arrive as editTarget and be treated as a playlist to
    // save over.
    b.addEventListener("click", () => openLibFocusSheet(null));
    return b;
  }

  // `Album name ↑ ⌄`. The arrow is a LABEL here, not a control — it says which
  // way the current sort runs, and tapping anywhere on the button opens the
  // sheet where it can be changed.
  function buildLibSortButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lib-ctl lib-ctl-sort";

    const text = document.createElement("span");
    text.className = "lib-ctl-text";
    text.textContent = libSortLabel();
    b.appendChild(text);

    const arrow = document.createElement("span");
    arrow.className = "lib-ctl-arrow";
    arrow.setAttribute("aria-hidden", "true");
    // Random has no direction to show, so the slot carries the reshuffle glyph
    // instead — the same symbol the sort sheet's Random row re-taps to.
    arrow.textContent = libSortHasDir(libView.sort)
      ? (libView.dir === "desc" ? "↓" : "↑") : "⟳";
    b.appendChild(arrow);

    const caret = document.createElement("span");
    caret.className = "lib-ctl-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "⌄";
    b.appendChild(caret);

    b.setAttribute("aria-label", libSortHasDir(libView.sort)
      ? "Sort — " + libSortLabel() + ", " + libDirLabel()
      : "Sort — " + libSortLabel());
    b.addEventListener("click", openLibSortSheet);
    return b;
  }

  // One sheet builder for both — same bottom-sheet language as the filter and
  // settings sheets, built as live nodes (never restored from an HTML string).
  // `onClose` fires on EVERY dismissal path — X, backdrop, and the footer
  // buttons — so a caller that mutated shared state on open can undo it.
  function openLibSheet(title, buildBody, footer, onClose) {
    const back = document.createElement("div");
    back.className = "lib-sheet-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "lib-sheet";
    const head = document.createElement("div");
    head.className = "lib-sheet-head";
    const h = document.createElement("h3"); h.textContent = title;
    const x = document.createElement("button");
    x.type = "button"; x.className = "icon-btn"; x.setAttribute("aria-label", "Close");
    x.textContent = "✕";
    head.appendChild(h); head.appendChild(x);
    const body = document.createElement("div");
    body.className = "lib-sheet-body";
    sheet.appendChild(head); sheet.appendChild(body);
    const close = () => { back.remove(); if (onClose) onClose(); };
    buildBody(body, close);
    if (footer) {
      const f = document.createElement("div");
      f.className = "lib-sheet-foot";
      footer(f, close);
      sheet.appendChild(f);
    }
    x.addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    back.appendChild(sheet);
    document.body.appendChild(back);
  }

  // ----- Add a selection to a playlist --------------------------------------
  // Tracks go in as themselves. ALBUMS cannot: a stored entry names a specific
  // track, and the album's tracklist only exists on the Core. Rather than
  // opening every selected album — seconds of Roon calls behind a menu tap —
  // this says so plainly and leaves the album selection intact.
  async function addSelectionToPlaylist() {
    if (selMenuKind === "albums") {
      if (!albumSelected.length) return;
      // Every track of every selected album. The album's tracklist only exists
      // on the Core, so this is the one add that costs Roon calls — bounded
      // server-side and reported per album.
      openAddToPlaylistSheet(null, albumSelected.map(a => ({
        offset: a.offset, title: a.title || "", subtitle: a.subtitle || "",
        image_key: a.image_key || null,
      })));
      return;
    }
    if (!currentAlbum) { showToast("No album open", "error"); return; }
    const picks = trackSelected.slice().sort((a, b) => a.index - b.index);
    if (!picks.length) return;
    const entries = picks.map(p => ({
      album_offset:   currentAlbum.offset,
      album_title:    currentAlbum.title || "",
      album_subtitle: currentAlbum.subtitle || "",
      track_index:    p.index,
      title:          p.title,
      subtitle:       currentAlbum.subtitle || "",
      image_key:      currentAlbum.image_key || null,
    }));
    openAddToPlaylistSheet(entries, null);
  }

  // Exactly one of `entries` (tracks) and `albums` is supplied. They land on
  // different routes because only the album one has to talk to Roon.
  async function openAddToPlaylistSheet(entries, albums) {
    const n = entries ? entries.length : (albums || []).length;
    if (!n) { showToast("Nothing to add", "error"); return; }
    let list = [];
    try {
      const r = await fetch("/api/user-playlists", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast("Couldn't read your playlists", "error"); return; }
      list = j.playlists || [];
    } catch (e) {
      showToast("Couldn't reach the extension", "error");
      return;
    }

    const what = entries
      ? `${n} track${n === 1 ? "" : "s"}`
      : `${n} album${n === 1 ? "" : "s"}`;
    openLibSheet(`Add ${what} to…`,
      (body, close) => {
        const row = (label, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "action-btn sheet-row";
          // textContent, never a template: a playlist name is user text and
          // this sheet has no business interpreting it as markup.
          b.textContent = label;
          b.addEventListener("click", () => { close(); fn(); });
          body.appendChild(b);
        };
        row("＋ New playlist…", () => {
          const name = window.prompt("Name this playlist", "My playlist");
          if (name === null) return;
          const trimmed = String(name).trim();
          if (!trimmed) { showToast("Give it a name", "error"); return; }
          addToUserPlaylist({ name: trimmed }, entries, albums).then(ok => {
            if (ok) clearAfterAdd();
          });
        });
        for (const p of list) {
          row(`${p.name} · ${p.track_total} track${p.track_total === 1 ? "" : "s"}`, () => {
            addToUserPlaylist({ id: p.id }, entries, albums).then(ok => {
              if (ok) clearAfterAdd();
            });
          });
        }
      });
  }

  // ----- Playlists stored by this extension ---------------------------------
  // These share the Playlists wall with Roon's own (see showPlaylists) — there
  // is no separate screen, so there is no separate list renderer either.

  async function openUserPlaylist(p) {
    enterFullWall("");   // the stored playlist prints its own full-width heading
    userPlDetailActive = true;
    const mySeq = ++userPlSeq;
    setBanner(null);
    grid.innerHTML = "";
    clearWallGridSizing();

    let j = null;
    try {
      const r = await fetch(`/api/user-playlist?id=${encodeURIComponent(p.id)}`, { cache: "no-store" });
      j = await r.json().catch(() => ({}));
      if (!userPlDetailActive || mySeq !== userPlSeq) return;
      if (!r.ok) { setBanner(j.error || "Couldn't open that playlist.", true); return; }
    } catch (e) {
      if (!userPlDetailActive || mySeq !== userPlSeq) return;
      setBanner("Couldn't reach the extension.", true);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "playlist-detail";

    const back = document.createElement("button");
    back.type = "button"; back.className = "action-btn playlist-back";
    back.textContent = "← Playlists";
    back.addEventListener("click", () => { userPlDetailActive = false; showPlaylists(); });
    wrap.appendChild(back);

    const head = document.createElement("div");
    head.className = "playlist-head";
    const h = document.createElement("h2");
    h.className = "playlist-title";
    h.textContent = j.name || "Playlist";
    head.appendChild(h);
    const sub = document.createElement("div");
    sub.className = "playlist-sub";
    sub.textContent = `${j.track_total} track${j.track_total === 1 ? "" : "s"}`;
    head.appendChild(sub);
    wrap.appendChild(head);

    const tracks = j.tracks || [];
    const actions = document.createElement("div");
    actions.className = "playlist-actions";
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = cls; b.textContent = label;
      b.addEventListener("click", () => fn(b));
      actions.appendChild(b);
      return b;
    };
    mkBtn("Play now", "action-btn primary", (b) => playUserPlaylist(tracks, "play_now", b));
    mkBtn("Queue",    "action-btn",         (b) => playUserPlaylist(tracks, "queue", b));
    const shareThisPlaylist = (b) => shareTracks(j.name || "Playlist",
      tracks.map(t => ({
        title: t.title, artist: t.subtitle,
        album: t.album_title, track_no: t.track_no
      })), b, {});
    const deleteThisPlaylist = async () => {
      const ok = await confirmDialog(`Delete "${j.name}"? This can't be undone.`);
      if (!ok) return;
      try {
        const r = await fetch("/api/user-playlists/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: p.id })
        });
        if (!r.ok) { showToast("Couldn't delete that", "error"); return; }
        showToast("Playlist deleted");
        userPlDetailActive = false;
        showPlaylists();
      } catch (e) { showToast("Couldn't reach the extension", "error"); }
    };
    actions.appendChild(buildOverflowMenu([
      { label: "Share",  onClick: (b) => shareThisPlaylist(b) },
      { label: "Delete", onClick: () => deleteThisPlaylist(), danger: true },
    ], { title: j.name || "Playlist" }));
    wrap.appendChild(actions);

    const ol = document.createElement("ol");
    ol.className = "track-list playlist-tracks";
    for (const t of tracks) ol.appendChild(userTrackRow(t));
    wrap.appendChild(ol);

    if (!tracks.length) {
      const empty = document.createElement("div");
      empty.className = "playlist-empty";
      empty.textContent = "Nothing in this playlist yet.";
      wrap.appendChild(empty);
    }
    grid.appendChild(wrap);
  }

  // Same row shape as the smart-playlist screen — artwork, two lines, tap to
  // play from its album.
  function userTrackRow(t) {
    const li = document.createElement("li");
    li.className = "track-row track-row-art";
    li.dataset.albumOffset = String(t.album_offset);

    const art = document.createElement("span");
    art.className = "track-art";
    if (t.image_key) {
      art.dataset.artKey = t.image_key;
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = "";
      img.src = `/api/image/${encodeURIComponent(t.image_key)}?size=80`;
      img.onerror = () => { art.classList.add("no-image"); img.remove(); };
      art.appendChild(img);
    } else {
      art.classList.add("no-image");
    }
    li.appendChild(art);

    const text = document.createElement("div");
    text.className = "track-text";
    const tt = document.createElement("div");
    tt.className = "track-title";
    tt.textContent = t.title || "";
    text.appendChild(tt);
    const ta = document.createElement("div");
    ta.className = "track-artist";
    ta.textContent = [t.subtitle, t.album_title].filter(Boolean).join(" · ");
    text.appendChild(ta);
    li.appendChild(text);

    li.addEventListener("click", async () => {
      const zsel = document.getElementById("zone-select");
      const zone = (zsel && zsel.value) || selectedZoneId;
      if (!zone) { showToast("Choose a zone first", "error"); return; }
      try {
        const r = await fetch("/api/play-track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset: t.album_offset, track: t.track_index, title: t.title,
            zone_or_output_id: zone, kind: "play_now",
            // A stored entry can be months old, so the album identity matters
            // far more here than it does from a modal opened seconds ago.
            album_title: t.album_title, album_subtitle: t.album_subtitle
          })
        });
        const j2 = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j2.error || "Couldn't play that track", "error"); return; }
        showToast(`Playing ${t.title}`);
      } catch (e) { showToast("Couldn't reach the extension", "error"); }
    });
    return li;
  }

  // Sequential by necessity: /api/play-track has no batch form, and firing
  // these in parallel would interleave into an arbitrary queue order.
  async function playUserPlaylist(tracks, kind, btn) {
    const zsel = document.getElementById("zone-select");
    const zone = (zsel && zsel.value) || selectedZoneId;
    if (!zone) { showToast("Choose a zone first", "error"); return; }
    if (!tracks.length) { showToast("Nothing in this playlist", "error"); return; }
    btn.disabled = true;
    let queued = 0, failed = 0, firstError = "";
    try {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (tracks.length > 3) showToast(`Adding track ${i + 1} of ${tracks.length}…`);
        try {
          const r = await fetch("/api/play-track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              offset: t.album_offset, track: t.track_index, title: t.title,
              zone_or_output_id: zone,
              // Only the first honours the kind; the rest queue behind it.
              kind: (i === 0 ? kind : "queue"),
              album_title: t.album_title, album_subtitle: t.album_subtitle
            })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { failed++; if (!firstError) firstError = j.error || `HTTP ${r.status}`; }
          else queued++;
        } catch (e) {
          failed++;
          if (!firstError) firstError = "Couldn't reach the extension";
        }
      }
    } finally {
      btn.disabled = false;
    }
    if (!queued) { showToast(firstError || "Roon refused those tracks", "error", TOAST_REPORT_MS); return; }
    const verb = kind === "queue" ? "Queued" : "Playing";
    let msg = `${verb} ${queued} track${queued === 1 ? "" : "s"}`;
    if (failed) msg += ` (${failed} couldn't be found: ${firstError})`;
    showToast(msg, failed ? "error" : null, TOAST_REPORT_MS);
  }

  // ----- Importing a shared playlist ----------------------------------------
  // The other half of Share. Paste the blob, and every entry is matched against
  // THIS library — the shared file names music, it does not carry it, so what
  // you end up with is whatever your own library can answer for.
  function openImportSheet() {
    openLibSheet("Import a playlist", (body) => {
      const note = document.createElement("div");
      note.className = "share-note";
      note.textContent =
        "Paste a playlist someone shared with you. It describes the music, so " +
        "you'll get the tracks your own library can match — the rest are listed " +
        "so you know what's missing.";
      body.appendChild(note);

      const ta = document.createElement("textarea");
      ta.className = "share-blob";
      ta.id = "import-blob";
      ta.rows = 4;
      ta.placeholder = "MDRP1:…";
      // iOS autocorrect treats MDRP1 as a word it doesn't know and lowercases
      // it on paste, which broke the marker while leaving the payload intact.
      // The payload itself is base64url and case-SENSITIVE, so this must be
      // off — a "correction" anywhere in it would be unrecoverable.
      ta.setAttribute("autocapitalize", "none");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocomplete", "off");
      ta.spellcheck = false;
      body.appendChild(ta);

      // A downloaded .musicd file is the other half of Share's Download, and
      // on a phone it is far more reliable than a clipboard: the blob is long
      // enough that a hand-selection can silently come back short.
      const pick = document.createElement("label");
      pick.className = "action-btn import-file";
      pick.textContent = "Choose a file…";
      const file = document.createElement("input");
      file.type = "file";
      // .musicd is what Share writes; text/plain covers a file renamed or
      // re-saved by a mail client, and iOS is inconsistent about extensions it
      // does not recognise.
      file.accept = ".musicd,text/plain";
      file.className = "visually-hidden";
      file.id = "import-file";
      file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          ta.value = String(reader.result || "");
          const out = document.getElementById("import-result");
          if (out) out.textContent = `Loaded ${f.name} — press Import.`;
        };
        reader.onerror = () => {
          const out = document.getElementById("import-result");
          if (out) out.textContent = "Couldn't read that file.";
        };
        reader.readAsText(f);
      });
      pick.appendChild(file);
      body.appendChild(pick);

      const out = document.createElement("div");
      out.className = "import-result";
      out.id = "import-result";
      body.appendChild(out);
    }, (foot, close) => {
      const go = document.createElement("button");
      go.type = "button"; go.className = "action-btn primary";
      go.textContent = "Import";
      go.addEventListener("click", () => runImport(go));
      foot.appendChild(go);

      const done = document.createElement("button");
      done.type = "button"; done.className = "action-btn";
      done.textContent = "Close";
      done.addEventListener("click", close);
      foot.appendChild(done);
    });
  }

  async function runImport(btn) {
    const ta = document.getElementById("import-blob");
    const out = document.getElementById("import-result");
    const blob = ta ? ta.value.trim() : "";
    if (!blob) { showToast("Paste the playlist first", "error"); return; }
    btn.disabled = true;
    if (out) out.textContent = "Matching against your library…";
    try {
      const j = await postImport(blob, false);
      if (!j.ok) {
        if (out) out.textContent = j.error || "Couldn't read that playlist";
        return;
      }
      renderImportResult(out, j, btn);

      // Anything names alone couldn't place gets a second pass that reads what
      // is actually ON the library's albums. It runs automatically because the
      // alternative is asking the user to do a manual search, which is the
      // thing this is meant to replace — but it runs SECOND, so the fast
      // answer is on screen while it works.
      if (j.deep_available) {
        // Saving DURING the second pass would create a playlist from the
        // smaller set, and the second render then replaces the "Saved" state
        // on a detached node — so a second tap makes a second playlist with
        // the same name (the server creates by name, it never finds one).
        // Nothing to save until the count is final.
        const save = out.querySelector(".import-save");
        if (save) { save.disabled = true; save.textContent = "Searching your library…"; }
        const note = document.createElement("div");
        note.className = "share-sum share-sub-note";
        note.textContent = `Looking inside your albums for the other ${j.missing.length}…`;
        out.appendChild(note);
        const deep = await postImport(blob, true);
        if (deep.ok) {
          renderImportResult(out, deep, btn);
        } else {
          note.textContent = "Couldn't finish the deeper search — the matches above still stand.";
          if (save) { save.disabled = false; save.textContent = `Save ${(j.resolved || []).length} tracks as a playlist`; }
        }
      }
    } catch (e) {
      if (out) out.textContent = "Couldn't reach the extension";
    } finally {
      btn.disabled = false;
    }
  }

  // Returns the parsed body with `ok` reflecting the HTTP status, so callers
  // never have to hold both.
  async function postImport(blob, deep) {
    const r = await fetch("/api/share/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob, deep: !!deep })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error };
    return j;
  }

  // The resolution report. Showing what did NOT match is the point: every tool
  // in this space quietly substitutes the wrong version, and a count that only
  // celebrates the hits is how you stop trusting it.
  function renderImportResult(out, j, btn) {
    if (!out) return;
    out.textContent = "";
    const n = (j.resolved || []).length;
    const miss = j.missing || [];

    const head = document.createElement("div");
    head.className = "share-sum";
    head.textContent = `${n} of ${j.total} track${j.total === 1 ? "" : "s"} found in your library`;
    out.appendChild(head);

    if (j.truncated) {
      const w = document.createElement("div");
      w.className = "share-warn";
      w.textContent = "That playlist is longer than one import can take — the end of it was left out.";
      out.appendChild(w);
    }

    if (miss.length) {
      const w = document.createElement("div");
      w.className = "share-warn";
      w.textContent = `${miss.length} couldn't be matched:`;
      out.appendChild(w);
      const ul = document.createElement("ul");
      ul.className = "import-missing";
      // Bounded: a 500-track import that matched nothing would otherwise
      // render 500 rows into a bottom sheet.
      for (const m of miss.slice(0, 25)) {
        const li = document.createElement("li");
        li.textContent = [m.title, m.artist, m.album].filter(Boolean).join(" · ");
        ul.appendChild(li);
      }
      if (miss.length > 25) {
        const li = document.createElement("li");
        li.textContent = `…and ${miss.length - 25} more`;
        ul.appendChild(li);
      }
      out.appendChild(ul);
    }

    // Tracks found under an album the share did not name. Shown, not hidden:
    // this is a SUBSTITUTION, and the whole reason the import report exists is
    // that quietly swapping one record for another is what makes these tools
    // untrustworthy. Two servers indexing the same files group compilations
    // differently, so this is the normal case rather than an odd one.
    const sub = j.substituted || [];
    if (sub.length) {
      const w = document.createElement("div");
      w.className = "share-sum share-sub-note";
      w.textContent = `${sub.length} found on a different album than the playlist named:`;
      out.appendChild(w);
      const ul = document.createElement("ul");
      ul.className = "import-missing import-substituted";
      for (const m of sub.slice(0, 25)) {
        const li = document.createElement("li");
        li.textContent = [m.title, m.artist].filter(Boolean).join(" · ") +
                         " — " + (m.found_album || "your library");
        ul.appendChild(li);
      }
      if (sub.length > 25) {
        const li = document.createElement("li");
        li.textContent = `…and ${sub.length - 25} more`;
        ul.appendChild(li);
      }
      out.appendChild(ul);
    }

    if (!n) {
      const w = document.createElement("div");
      w.className = "share-warn";
      w.textContent = "Nothing here matched, so there's nothing to save.";
      out.appendChild(w);
      return;
    }

    const save = document.createElement("button");
    save.type = "button"; save.className = "action-btn primary import-save";
    save.textContent = `Save ${n} track${n === 1 ? "" : "s"} as a playlist`;
    save.addEventListener("click", async () => {
      const name = window.prompt("Name this playlist", j.name || "Shared playlist");
      if (name === null) return;
      const trimmed = String(name).trim();
      if (!trimmed) { showToast("Give it a name", "error"); return; }
      save.disabled = true;
      const okAdd = await addToUserPlaylist({ name: trimmed }, j.resolved);
      save.disabled = false;
      if (okAdd) {
        save.textContent = "Saved";
        save.disabled = true;
      }
    });
    out.appendChild(save);
  }

  // Whichever selection is live, cleared once it has been filed somewhere.
  function clearAfterAdd() {
    if (trackSelectMode) exitTrackSelectMode();
    if (albumSelectMode) exitAlbumSelectMode();
  }

  // Shared by import and by "Add to playlist". `target` is {id} for an existing
  // playlist or {name} to create one. Exactly one of `tracks`/`albums` is set —
  // albums go to the route that reads their tracklists off the Core.
  async function addToUserPlaylist(target, tracks, albums) {
    const url = albums ? "/api/user-playlists/add-albums" : "/api/user-playlists/add";
    const payload = albums
      ? { id: target.id, name: target.name, albums }
      : { id: target.id, name: target.name, tracks };
    if (albums) showToast(`Reading ${albums.length} album${albums.length === 1 ? "" : "s"}…`);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(j.error || "Couldn't save that", "error"); return false; }
      let msg = `Added ${j.added} track${j.added === 1 ? "" : "s"}`;
      if (Number.isFinite(j.albums_read)) {
        msg += ` from ${j.albums_read} album${j.albums_read === 1 ? "" : "s"}`;
      }
      msg += ` to "${j.name}"`;
      if (j.full)    msg += " — the playlist is now full";
      if (j.skipped) msg += `; ${j.skipped} couldn't be stored`;
      // Named, not counted: knowing WHICH album Roon wouldn't open is the only
      // way to do anything about it.
      if (j.albums_failed && j.albums_failed.length) {
        msg += `; couldn't read ${j.albums_failed.join(", ")}`;
      }
      showToast(msg, (j.albums_failed && j.albums_failed.length) ? "error" : null,
                TOAST_REPORT_MS);
      return true;
    } catch (e) {
      showToast("Couldn't reach the extension", "error");
      return false;
    }
  }

  window.__openImportSheet = openImportSheet;

  // ----- Sharing a playlist -------------------------------------------------
  // What leaves the app is a DESCRIPTION of the music, never audio and never
  // anything else: the entries below are built field-by-field from the rows on
  // screen. Nothing is forwarded wholesale from a server response, so an export
  // cannot pick up a field it was never meant to carry.
  //
  // See docs/design/playlist-sharing.md.

  // Ask the server to turn entries into a share blob, then show it.
  //
  // `caveats` is what the CLIENT knows and the server cannot: that collection
  // stopped at the album cap, that a page failed part-way, or that the source
  // playlist was already truncated before we saw it. The server's own
  // `truncated` only ever describes the list it was handed, so relying on it
  // alone meant every client-side limit went unreported — the exact shape of
  // the v1.7.17 bug this feature was written to avoid repeating.
  async function shareTracks(name, entries, btn, caveats) {
    if (!entries.length) { showToast("Nothing to share yet", "error"); return; }
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/api/share/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, tracks: entries })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(j.error || "Couldn't build the share file", "error"); return; }
      openShareSheet(name, j, caveats || {});
    } catch (e) {
      showToast("Couldn't reach the extension", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // The blob, plus the two ways to get it off this device. Everything the user
  // is told here is a fact from the response — how many tracks went in, and
  // what was left out — because a share file that quietly dropped half a
  // playlist is worse than one that refused to build.
  function openShareSheet(name, j, caveats) {
    const c = caveats || {};
    openLibSheet("Share " + name, (body) => {
      const n = j.track_count || 0;
      const sum = document.createElement("div");
      sum.className = "share-sum";
      sum.textContent = `${n} track${n === 1 ? "" : "s"}`;
      body.appendChild(sum);

      // Every reason this file might be less than the whole playlist, each on
      // its own line. One run-on sentence buried the important half.
      const warnings = [];
      if (c.incomplete) {
        warnings.push("Reading stopped early because Roon returned an error — " +
                      "this file is INCOMPLETE. Try again before sharing it.");
      }
      if (c.albumsCapped) {
        warnings.push(`Only the first ${SHARE_ALBUM_MAX} albums were read — ` +
                      "that's the limit for one go.");
      }
      if (c.sourceTruncated) {
        warnings.push("The playlist is longer than this app can read from Roon, " +
                      "so the end of it isn't here.");
      }
      if (j.truncated) warnings.push("Stopped at the sharing limit of tracks.");
      if (j.skipped) {
        warnings.push(`${j.skipped} entr${j.skipped === 1 ? "y" : "ies"} had no title ` +
                      `and ${j.skipped === 1 ? "was" : "were"} left out.`);
      }
      // Above 40 KB a paste starts getting silently truncated by messaging
      // apps, which turns into a blob that decodes to nothing on the far end.
      if (j.bytes > 40000) {
        warnings.push(`This is ${Math.round(j.bytes / 1024)} KB — too big to paste ` +
                      "reliably. Use Download and send the file.");
      }
      for (const w of warnings) {
        const el = document.createElement("div");
        el.className = "share-warn";
        el.textContent = w;
        body.appendChild(el);
      }

      const note = document.createElement("div");
      note.className = "share-note";
      note.textContent =
        "This describes the music, not the music itself. Whoever imports it " +
        "gets whatever their own library or streaming service can match.";
      body.appendChild(note);

      // readOnly rather than disabled: the text must stay selectable so a
      // long-press copy works where the Clipboard API doesn't.
      const ta = document.createElement("textarea");
      ta.className = "share-blob";
      ta.id = "share-blob";
      ta.readOnly = true;
      ta.setAttribute("autocapitalize", "none");
      ta.setAttribute("autocorrect", "off");
      ta.spellcheck = false;
      ta.rows = 4;
      ta.value = j.blob || "";
      body.appendChild(ta);
    }, (foot, close) => {
      const copy = document.createElement("button");
      copy.type = "button"; copy.className = "action-btn primary";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        // navigator.clipboard is a SECURE-CONTEXT api and this extension is
        // served over plain http on the LAN, so on most devices it simply does
        // not exist — the "modern" path was never once taken in practice, and
        // every user was silently pushed to hand-selecting the blob. That is
        // how a copy comes back short. execCommand still works on http, so it
        // is tried FIRST and the async API is the fallback, not the other way
        // round.
        const ta = document.getElementById("share-blob");
        if (ta) {
          ta.focus();
          ta.setSelectionRange(0, (j.blob || "").length);
          try {
            if (document.execCommand && document.execCommand("copy")) {
              showToast("Copied — paste it to whoever you're sharing with");
              return;
            }
          } catch (e) { /* falls through to the async API below */ }
        }
        try {
          await navigator.clipboard.writeText(j.blob || "");
          showToast("Copied — paste it to whoever you're sharing with");
        } catch (e) {
          // Both refused. The text is selected, so a manual copy still works —
          // say so rather than failing silently.
          showToast("Couldn't copy automatically — the text is selected, copy it by hand",
                    "error", TOAST_REPORT_MS);
        }
      });
      foot.appendChild(copy);

      const dl = document.createElement("button");
      dl.type = "button"; dl.className = "action-btn";
      dl.textContent = "Download";
      dl.addEventListener("click", () => {
        const safe = (name || "playlist").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
        const blob = new Blob([j.blob || ""], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = safe + ".musicd";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoking immediately can race the download on some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
      foot.appendChild(dl);

      const done = document.createElement("button");
      done.type = "button"; done.className = "action-btn";
      done.textContent = "Done";
      done.addEventListener("click", close);
      foot.appendChild(done);
    });
  }

  // Roon ARC's sort popover, in this app's bottom-sheet language: a plain list
  // of fields, and the SELECTED one carries an arrow. Tapping the selected row
  // flips that arrow instead of re-selecting; tapping any other row switches to
  // it at its own default direction. There is no separate direction row and no
  // sentence to read — the arrow is the whole affordance.
  function openLibSortSheet() {
    openLibSheet("Sort by", (body, close) => {
      const paint = () => {
        // Reversing in place replaces the row that was just activated — keep
        // focus on its replacement so the row can be pressed again without
        // tabbing back to it. Rows are rebuilt in a fixed order, so position
        // identifies the replacement.
        const rows = body.querySelectorAll(".lib-sort-row");
        const focused = Array.prototype.indexOf.call(rows, document.activeElement);
        body.innerHTML = "";
        for (const opt of LIB_SORT_OPTIONS) {
          const on = libView.sort === opt.id;
          const row = document.createElement("button");
          row.type = "button";
          row.className = "lib-sort-row" + (on ? " is-on" : "");

          // The arrow occupies a fixed column on every row, filled only on the
          // selected one, so the labels stay on a single left edge.
          const arrow = document.createElement("span");
          arrow.className = "lib-sort-arrow";
          arrow.setAttribute("aria-hidden", "true");
          arrow.textContent = (on && libSortHasDir(opt.id))
            ? (libView.dir === "desc" ? "↓" : "↑") : "";
          row.appendChild(arrow);

          const text = document.createElement("span");
          text.className = "lib-sort-text";
          const main = document.createElement("span");
          main.className = "lib-sort-label";
          main.textContent = opt.label;
          text.appendChild(main);
          if (opt.note) {
            const sub = document.createElement("span");
            sub.className = "lib-sort-note";
            sub.textContent = opt.note;
            text.appendChild(sub);
          }
          row.appendChild(text);

          if (on && libSortHasDir(opt.id)) {
            row.setAttribute("aria-label", opt.label + " — " + libDirLabel() + ", tap to reverse");
          }
          row.addEventListener("click", () => {
            if (on) {
              // Already selected: this tap means "reverse", exactly as in ARC.
              // Random is the one row with nothing to reverse — re-tapping it
              // reshuffles instead, which is the only useful thing it can do.
              if (libSortHasDir(opt.id)) {
                libView.dir = libView.dir === "desc" ? "asc" : "desc";
              } else {
                libView.seed = libNextSeed(libView.seed);
                close();
              }
            } else {
              libView.sort = opt.id;
              libView.dir = libSortDefaultDir(opt.id);
              // Switching TO Random re-rolls: without this the first shuffle on
              // a fresh install always runs on the default seed, so "random"
              // gives every device the identical order until ⟳ is tapped.
              if (!libSortHasDir(opt.id)) libView.seed = libNextSeed(libView.seed);
              close();
            }
            // Repaint before applying so a reverse-in-place shows its new arrow
            // immediately; the wall reloads behind the open sheet.
            if (document.body.contains(body)) paint();
            applyLibView();
          });
          body.appendChild(row);
        }
      };
      paint();
    });
  }

  // `editTarget` (a smart playlist) makes this sheet's "Save as…" an
  // update-in-place. Passed in rather than held in a module variable: an
  // abandoned edit — closing the sheet with X, the backdrop, or Show albums —
  // would otherwise leave that variable set, and the NEXT save from the Focus
  // bar would silently overwrite the playlist edited earlier.
  // Album counts a dynamic playlist can be limited to. The ceiling is the
  // play-time one: 400 albums is ~3,200 Roon calls and minutes of queueing.
  const SMART_LIMITS = [25, 50, 100, 200, 400];
  const SMART_LIMIT_DEFAULT = 100;   // matches smartLimitDefault() on the server

  // What a new playlist is made OF, asked first because it changes what the
  // playlist DOES rather than which albums it matches — and because it is the
  // one choice that can't be inferred from the focus.
  //
  // Both modes run the same album query. "Albums" queues whole records in
  // order; "Tracks" expands them and lists the tracks individually. The filter
  // itself is always album-level: Roon's API publishes no track list without
  // opening each album one at a time, so a genuinely track-level FILTER would
  // mean indexing every track in the library — thousands of Roon calls, redone
  // on every change — which is the traffic the snapshot exists to avoid. This
  // is stated in the sheet rather than hidden, so the choice is understood.
  const SMART_MODES = [
    { id: "albums", label: "Albums",
      note: "Queues whole albums, in their own running order." },
    { id: "tracks", label: "Tracks",
      note: "Lists the tracks from those albums, so you can play or queue them one at a time." }
  ];
  const SMART_MODE_DEFAULT = "albums";   // matches smartModeDefault() on the server
  // What order it comes out in — a separate axis from what it is made of.
  const SMART_ORDERS = [
    { id: "album",  label: "Album order" },
    { id: "random", label: "Random" }
  ];
  const SMART_ORDER_DEFAULT = "album";   // matches smartOrderDefault() on the server

  async function openLibFocusSheet(editTarget) {
    // Snapshot BEFORE the edited view is applied, so abandoning the sheet can
    // put the user's own Library view back exactly as it was.
    const viewBefore = editTarget ? currentLibViewSnapshot() : null;
    // Lives outside the view: two playlists can share a query and differ here,
    // which is also why the server applies it by slicing rather than inside
    // libraryView(), whose cache is keyed on the query alone.
    let editLimit = (editTarget && editTarget.limit) || 100;
    // Same reasoning as the limit: two playlists can share a query and differ
    // in what order it comes out in, so this lives beside the view rather than
    // inside it.
    let editOrder = (editTarget && editTarget.order) || SMART_ORDER_DEFAULT;
    if (editTarget) applyViewToLibView(editTarget.view);
    let committed = false;
    // Re-read every time the sheet opens. Caching these for the life of the
    // page meant a rescan changed the library and the Focus sheet went on
    // reporting the old counts until a full reload — which reads as the rescan
    // having done nothing.
    try {
      const r = await fetch("/api/library/facets", { cache: "no-store" });
      if (r.ok) libFacets = await r.json();
    } catch (e) { /* offline — keep whatever we last had rather than blanking */ }
    // The server decides the vocabulary — it drops "Record label" when Labels
    // is switched off — so the count badge follows what it publishes rather
    // than a list hardcoded here.
    if (libFacets && Array.isArray(libFacets.facets)) {
      const ids = libFacets.facets.map(x => x && x.id).filter(Boolean);
      if (ids.length) libAvailableFacets = ids;
    }
    const f = libFacets || { facets: [], coverage: {} };
    // Which sections are expanded. Held across repaints (a chip tap rebuilds
    // the body) but NOT across openings: a sheet that reopens half-collapsed
    // hides filters that are still on.
    const openSections = {};
    openLibSheet("Focus", (body) => {
      // One collapsible category. Roon's own Focus is a row of scrolling
      // columns; on a phone that becomes a vertical stack, and with ten
      // categories — some of them hundreds of labels long — every one expanded
      // is a sheet nobody can find the bottom of. Collapsed by default unless
      // something in it is selected, so what's ON is always visible.
      // `openByDefault` is for sections that aren't filters at all — the
      // playlist's own Order and size. They have no "active count" to open
      // them, and collapsing the two controls this screen exists to set would
      // hide them behind a tap for no gain.
      const section = (id, label, activeCount, openByDefault) => {
        // Default open when something in here is ON, and REMEMBER that, because
        // a chip tap repaints the whole body: clearing the last filter in a
        // category would otherwise drop its active count to zero and collapse
        // the section under the user's finger, taking the other chips with it.
        // Once open, a section stays open until the header is tapped or the
        // sheet is closed.
        if (openSections[id] === undefined && (activeCount > 0 || openByDefault)) {
          openSections[id] = true;
        }
        const expanded = openSections[id] === undefined ? false : openSections[id];
        const s = document.createElement("div");
        s.className = "lib-sheet-section" + (expanded ? " is-open" : "");

        const head = document.createElement("button");
        head.type = "button";
        head.className = "lib-sheet-section-head";
        head.setAttribute("aria-expanded", expanded ? "true" : "false");
        const t = document.createElement("span");
        t.className = "lib-sheet-section-label";
        t.textContent = label;
        head.appendChild(t);
        if (activeCount) {
          const n = document.createElement("span");
          n.className = "lib-sheet-section-count";
          n.textContent = String(activeCount);
          head.appendChild(n);
        }
        const car = document.createElement("span");
        car.className = "lib-sheet-section-caret";
        car.setAttribute("aria-hidden", "true");
        car.textContent = expanded ? "⌃" : "⌄";
        head.appendChild(car);
        head.addEventListener("click", () => {
          openSections[id] = !expanded;
          renderFocusBody();
        });
        s.appendChild(head);
        body.appendChild(s);
        if (!expanded) return null;   // collapsed: no body to fill
        const wrap = document.createElement("div");
        wrap.className = "lib-chips";
        s.appendChild(wrap);
        return { section: s, chips: wrap };
      };
      // state: "on" (included) | "not" (excluded) | "off".
      const chip = (host, label, state, onTap) => {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "lib-chip" + (state === "on" ? " is-on" : state === "not" ? " is-not" : "");
        c.textContent = label;
        if (state === "not") c.setAttribute("aria-label", "Excluding " + label);
        c.addEventListener("click", () => { onTap(); renderFocusBody(); });
        host.appendChild(c);
      };
      const note = (host, text) => {
        const n = document.createElement("div");
        n.className = "lib-facet-note";
        n.textContent = text;
        host.appendChild(n);
      };
      // Why a facet's chips don't add up to the library. Every one of these
      // comes from somewhere other than Roon — the browse API publishes none of
      // it — so the number is stated rather than left to be noticed.
      const COVERAGE_NOTE = {
        decade: "Roon doesn't publish release years, so these come from your file tags " +
                "and from Qobuz/TIDAL. Undated albums aren't in any decade.",
        genre:  "Genres are read from Roon's own genre lists during a library sync. " +
                "Anything Roon files under no genre won't appear here.",
        label:  "Labels are collected during the label scan, which runs in the background " +
                "and fills in over time.",
        format: "Read from your own files, and — for albums you have no file for — from " +
                "the Qobuz or TIDAL account you've connected. Anything from neither has none.",
        added:  "Roon publishes no date-added, so this is what MusicD Remote could work " +
                "out for itself — file timestamps, and albums appearing between scans."
      };
      // Format, Sample rate, Bit depth and Channels all come from the same file
      // scan and all carry the same caveat; saying it four times is noise.
      const COVERAGE_OF = { rate: "format", bits: "format", chan: "format" };

      const renderFocusBody = () => {
        body.innerHTML = "";

        // The playlist's OWN properties lead, ahead of every filter. Order and
        // size are decisions about the playlist rather than about which albums
        // match, and burying them under ten collapsed facets meant scrolling
        // past the whole sheet to reach the two controls this screen exists to
        // set. Open by default for the same reason.
        if (editTarget) {
          const ord = section("order", "Order", 0, true);
          if (ord) {
            for (const o of SMART_ORDERS) {
              chip(ord.chips, o.label, editOrder === o.id ? "on" : "off",
                   () => { editOrder = o.id; });
            }
            note(ord.section,
              (editTarget.mode === "tracks"
                ? "Album order plays each record straight through, in the sort you " +
                  "chose. Random shuffles the albums AND the tracks inside them."
                : "Album order queues the albums in the sort you chose. Random " +
                  "shuffles which albums, and what order they play in.") +
              " The shuffle is fixed per playlist, so it stays put while you scroll " +
              "rather than reshuffling under you.");
          }

          const lim = section("limit", "Playlist size", 0, true);
          if (lim) {
            for (const n of SMART_LIMITS) {
              chip(lim.chips, String(n), editLimit === n ? "on" : "off", () => { editLimit = n; });
            }
            note(lim.section,
              "How many albums this playlist actually plays. A query can match your " +
              "whole library, but every album costs Roon work to queue — 400 albums " +
              "is thousands of tracks and takes minutes.");
          }
        }

        // Listening first — it is the one facet that is always available,
        // because it runs on this extension's own play history rather than on
        // anything harvested.
        const played = libView.played !== "any" ? 1 : 0;
        const ls = section("played", "Listening", played);
        if (ls) {
          for (const p of LIB_PLAYED_OPTIONS) {
            chip(ls.chips, p.label, libView.played === p.id ? "on" : "off",
                 () => { libView.played = p.id; });
          }
          if (!f.hasPlays) {
            note(ls.section, "MusicD Remote hasn't seen anything play yet, so these use an " +
                             "empty history — everything counts as never played.");
          }
        }

        for (const facet of (f.facets || [])) {
          const sel = libView[facet.id];
          if (!Array.isArray(sel)) continue;   // a facet this client doesn't know
          const s = section(facet.id, facet.label, sel.length);
          if (!s) continue;
          for (const v of facet.values) {
            chip(s.chips, v.label + " (" + v.count + ")",
                 facetState(sel, v.value), () => facetCycle(sel, v.value));
          }
          // Anything SELECTED that the server didn't send back gets a chip of
          // its own. Genre and Label are truncated to the commonest values, so a
          // saved playlist — or a filter set before the library changed — can
          // easily name one that isn't in the list. Without this the filter is
          // active, invisible, and clearable only by Clear all, which would
          // take every other filter with it.
          const listed = facet.values.map(v => v.value);
          for (const raw of sel) {
            const value = raw.charAt(0) === "!" ? raw.slice(1) : raw;
            if (listed.includes(value)) continue;
            chip(s.chips, value, facetState(sel, value), () => facetCycle(sel, value));
          }
          if (facet.total_values > facet.values.length) {
            note(s.section, "Showing the " + facet.values.length + " most common of " +
                            facet.total_values.toLocaleString() + ".");
          }
          const covId = COVERAGE_OF[facet.id] || facet.id;
          const have = f.coverage && f.coverage[covId];
          if (COVERAGE_NOTE[covId] && Number.isFinite(have) && f.total && have < f.total) {
            note(s.section, have.toLocaleString() + " of " + f.total.toLocaleString() +
                            " albums. " + COVERAGE_NOTE[covId]);
          }
          if (facet.id === "source" && f.sources_derived) {
            // Say WHERE the number came from. Matching file tags against Roon's
            // own metadata is lossy — Roon rewrites titles for albums it
            // identifies — so when nothing else can claim an album, counting by
            // elimination is both exact and honest, and the user should know
            // that's the reasoning rather than assume every file was matched.
            note(s.section, "No streaming service is connected, so every album in your " +
                            "Roon library came from your own files.");
          }
        }

        const foot = document.createElement("div");
        foot.className = "lib-sheet-note";
        foot.textContent =
          "Tap a filter once to include it, again to exclude it, once more to clear it. " +
          "Roon can also focus on star ratings, its own favourites and album types — " +
          "those aren't in the API extensions can read.";
        body.appendChild(foot);
      };
      renderFocusBody();
    }, (foot, close) => {
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "action-btn";
      clear.textContent = "Clear all";
      clear.addEventListener("click", () => {
        committed = true;
        Object.assign(libView, libEmptyFacets());
        libView.played = "any";
        close(); applyLibView();
      });
      const save = document.createElement("button");
      save.type = "button"; save.className = "action-btn";
      save.textContent = "Save as…";
      save.addEventListener("click", () => {
        committed = true;
        close();
        // Carry the chosen size into the save — the sheet is the only place it
        // can be set, so it has to travel with the thing being saved. `mode`
        // rides along on editTarget from the create sheet (or from the record
        // being edited); Save-as from the Library bar has no editTarget and
        // takes the server default.
        saveSmartPlaylistPrompt(editTarget
          ? Object.assign({}, editTarget, { limit: editLimit, order: editOrder })
          : null);
      });
      const show = document.createElement("button");
      show.type = "button"; show.className = "action-btn primary";
      show.textContent = "Show albums";
      show.addEventListener("click", () => { committed = true; close(); applyLibView(); });
      foot.appendChild(clear); foot.appendChild(save); foot.appendChild(show);
    }, () => {
      // Abandoned (X or backdrop) while editing a saved playlist — put the
      // user's own Library view back. Never persisted in the first place, so
      // there is nothing on disk to undo.
      if (editTarget && !committed && viewBefore) applyViewToLibView(viewBefore);
    });
  }

  // ----- Smart playlists ---------------------------------------------------
  //
  // A smart playlist is just a saved library view (sort + focus), re-evaluated
  // every time it's opened. It runs entirely on the extension's own album
  // snapshot — the same engine as the Library screen — so it makes NO Roon calls
  // and adds nothing to the Core's memory. Opening one applies its view and
  // shows the library wall; there is no separate screen to maintain.
  // Derived from LIB_FACET_IDS rather than listed again: a facet added to that
  // array is savable immediately, instead of working on the Library screen and
  // silently vanishing the moment somebody saves the view as a playlist.
  const SMART_VIEW_KEYS = ["sort", "dir", "seed", "played"].concat(LIB_FACET_IDS);

  function currentLibViewSnapshot() {
    const out = {};
    for (const k of SMART_VIEW_KEYS) {
      out[k] = Array.isArray(libView[k]) ? libView[k].slice() : libView[k];
    }
    return out;
  }

  // A one-line human description, so the picker says what a saved view DOES
  // rather than only what it was named.
  function describeLibView(v) {
    const bits = [];
    const sortOpt = LIB_SORT_OPTIONS.find(o => o.id === v.sort);
    if (sortOpt) bits.push(sortOpt.label + (v.dir === "desc" ? " ↓" : " ↑"));
    // Decades read as "1980s"; everything else is already a display name, and
    // an excluded value says so rather than reading as if it were included.
    const shown = (id, val) => (val.charAt(0) === "!" ? "not " : "") +
      (id === "decade" ? val.replace("!", "") + "s" : val.replace(/^!/, ""));
    for (const id of LIB_FACET_IDS) {
      const sel = v[id];
      if (Array.isArray(sel) && sel.length) bits.push(sel.map(x => shown(id, x)).join(", "));
    }
    if (v.played && v.played !== "any") {
      const opt = LIB_PLAYED_OPTIONS.find(p => p.id === v.played);
      bits.push(opt ? opt.label.toLowerCase() : "not played in " + v.played + " months");
    }
    return bits.join(" · ");
  }

  // Returns null on failure, [] for a genuinely empty list. The caller must tell
  // them apart: rendering "No Dynamic Playlists yet" after a network blip reads as
  // "your saved playlists are gone".
  async function fetchSmartPlaylists() {
    try {
      const r = await fetch("/api/smart-playlists", { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.playlists) ? j.playlists : null;
    } catch (e) {
      return null;
    }
  }

  function saveSmartPlaylistPrompt(existing) {
    // NOT describeLibView(): using the description as the default name printed
    // the same string as both the row's title and its subtitle.
    const suggested = (existing && existing.name) || "My Dynamic Playlist";
    const name = window.prompt("Name this Dynamic Playlist", suggested);
    if (name === null) return;                 // cancelled
    const trimmed = String(name).trim();
    if (!trimmed) { showToast("Give it a name", "error"); return; }
    (async () => {
      try {
        const r = await fetch("/api/smart-playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: existing && existing.id, name: trimmed,
                                 view: currentLibViewSnapshot(),
                                 // Editing keeps whatever the playlist already
                                 // had; a new one takes the server's default.
                                 limit: existing && existing.limit,
                                 // Set by the create sheet before the focus
                                 // screen opens, and preserved through an edit.
                                 mode:  existing && existing.mode,
                                 // Set in the focus sheet's Order section.
                                 order: existing && existing.order })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(j.error || "Couldn't save that", "error"); return; }
        const lim = j.playlist && j.playlist.limit;
        const matched = j.playlist && j.playlist.album_matched;
        showToast(Number.isFinite(matched) && Number.isFinite(lim) && matched > lim
          ? `Saved "${trimmed}" — it plays ${lim} of the ${matched} albums that match. ` +
            "Change that with Edit."
          : `Saved "${trimmed}"`, null, TOAST_REPORT_MS);
        // Editing an existing one lands back on it so the change is visible
        // immediately; a brand new one goes to the list.
        if (j.playlist && existing) openSmartPlaylist(j.playlist);
        else showSmartPlaylists();
      } catch (e) {
        showToast("Couldn't save that", "error");
      }
    })();
  }

  // Smart playlists get the same shape as Roon playlists: a wall of tiles, and a
  // detail screen listing TRACKS with each track's album artwork. They used to
  // open the library wall with the view applied, which was the query working
  // correctly but reading as "it just took me to the library".
  // "New Dynamic Playlist", as the first tile of the wall. Built on .album so it
  // sizes with the grid at every width — the same approach as Home's unheard
  // tile, and for the same reason: no breakpoints of its own to get wrong.
  function buildNewSmartTile() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "album home-unheard-tile";
    btn.id = "new-smart-tile";
    btn.setAttribute("aria-label", "Create a Dynamic Playlist");

    const art = document.createElement("div");
    art.className = "album-art-wrap unheard-art";
    const glyph = document.createElement("span");
    glyph.className = "unheard-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "＋";
    art.appendChild(glyph);
    btn.appendChild(art);

    const meta = document.createElement("div");
    meta.className = "album-meta";
    const t = document.createElement("div");
    t.className = "album-title";
    t.textContent = "New Dynamic Playlist";
    const sub = document.createElement("div");
    sub.className = "album-artist";
    sub.textContent = "Albums or tracks, then a focus";
    meta.appendChild(t); meta.appendChild(sub);
    btn.appendChild(meta);

    btn.addEventListener("click", createSmartPlaylist);
    return btn;
  }


  // Creating is editing a playlist that doesn't exist yet: same sheet, same
  // sections, same Playlist size control. Passing a target with no id is what
  // makes the save create rather than overwrite, so there is one editor rather
  // than two that have to be kept in step.
  function createSmartPlaylist() {
    openLibSheet("New Dynamic Playlist", (body, close) => {
      const intro = document.createElement("div");
      intro.className = "lib-facet-note";
      intro.textContent = "What should this playlist be made of?";
      body.appendChild(intro);

      for (const m of SMART_MODES) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "lib-sort-row";
        row.dataset.mode = m.id;

        const text = document.createElement("span");
        text.className = "lib-sort-text";
        const main = document.createElement("span");
        main.className = "lib-sort-label";
        main.textContent = m.label;
        const sub = document.createElement("span");
        sub.className = "lib-sort-note";
        sub.textContent = m.note;
        text.appendChild(main); text.appendChild(sub);
        row.appendChild(text);

        row.addEventListener("click", () => {
          close();
          // Straight into the focus screen, whose options are what fuel the
          // playlist. A target with no id makes the save create rather than
          // overwrite.
          openLibFocusSheet({ id: null, name: "", view: currentLibViewSnapshot(),
                              limit: SMART_LIMIT_DEFAULT, mode: m.id,
                              order: SMART_ORDER_DEFAULT });
        });
        body.appendChild(row);
      }

      const note = document.createElement("div");
      note.className = "lib-sheet-note";
      note.textContent =
        "Either way the playlist follows the same focus, and re-runs it every time " +
        "you open it — it isn't a fixed list. Roon's API only lets an extension " +
        "filter at album level, so Tracks means the tracks OF the albums that match.";
      body.appendChild(note);
    });
  }

  async function showSmartPlaylists() {
    enterFullWall("Dynamic Playlists");
    smartWallActive = true;
    const mySeq = ++smartSeq;
    const list = await fetchSmartPlaylists();
    if (!smartWallActive || mySeq !== smartSeq) return;
    grid.innerHTML = "";
    if (list === null) {
      setBanner("Couldn't read your Dynamic Playlists — the extension didn't answer. " +
                "They're still saved; try again.", true);
      return;
    }
    setBanner(list.length ? null
      : "No Dynamic Playlists yet — start one with New, or set a sort and focus on the " +
        "Library screen and use Focus → Save as…", false);
    const frag = document.createDocumentFragment();
    // Leads the wall so an empty one still has something to do. Creating opens
    // the SAME editor Edit does, rather than sending the user off to the
    // Library screen to discover Focus → Save as… for themselves.
    frag.appendChild(buildNewSmartTile());
    for (const p of list) {
      const n = p.album_total;
      const matched = p.album_matched;
      const tile = buildAlbumTile({
        title: p.name,
        subtitle: (n === undefined || n === null)
          ? describeLibView(p.view)
          // Says what it PLAYS, and — when the query found more — what it left
          // out. Showing only the match count while playing a capped subset is
          // what made the number misleading.
          : (Number.isFinite(matched) && matched > n
              ? `${n} of ${matched} Albums`
              : `${n} Album${n === 1 ? "" : "s"}`),
        image_key: null,
        // A smart playlist has no cover either — the mosaic comes from the first
        // few albums it resolves to, which the server reads straight out of the
        // snapshot at no cost.
        art_keys: p.art_keys || []
      }, () => openSmartPlaylist(p), { selectable: false });
      frag.appendChild(tile);
    }
    grid.appendChild(frag);
  }
  window.__showSmartPlaylists = showSmartPlaylists;
  window.__showSmartPicks = showSmartPicks;

  async function openSmartPlaylist(sp) {
    enterFullWall("");   // the dynamic playlist prints its own full-width heading
    smartDetailActive = true;
    const mySeq = ++smartSeq;

    setBanner(null);
    grid.innerHTML = "";
    clearWallGridSizing();

    const wrap = document.createElement("div");
    wrap.className = "playlist-detail";

    const back = document.createElement("button");
    back.type = "button"; back.className = "action-btn playlist-back";
    back.textContent = "← Dynamic Playlists";
    back.addEventListener("click", () => { smartDetailActive = false; showSmartPlaylists(); });
    wrap.appendChild(back);

    const head = document.createElement("div");
    head.className = "playlist-head";
    const h = document.createElement("h2");
    h.className = "playlist-title";
    h.textContent = sp.name || "Dynamic Playlist";
    head.appendChild(h);
    const sub = document.createElement("div");
    sub.className = "playlist-sub";
    // What it is made of and what order it is in, alongside the query — both
    // are properties of the playlist that the query description can't carry,
    // and "why are these shuffled?" is otherwise only answerable from Edit.
    sub.textContent = [
      (sp.mode || SMART_MODE_DEFAULT) === "tracks" ? "Tracks" : "Albums",
      (sp.order || SMART_ORDER_DEFAULT) === "random" ? "random" : "album order",
      describeLibView(sp.view)
    ].filter(Boolean).join(" · ");
    head.appendChild(sub);
    wrap.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "playlist-actions";
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = cls; b.textContent = label;
      b.addEventListener("click", () => fn(b));
      actions.appendChild(b);
      return b;
    };
    // Two actions on the row; the rest behind the overflow menu. Six pills
    // shrank together (.action-btn is flex: 1 1 0) rather than wrapping, which
    // is how "Send to Roon" came out as "end to Roo".
    mkBtn("Play now", "action-btn primary", (b) => playSmartPlaylist(sp, "play_now", b));
    mkBtn("Queue",    "action-btn",         (b) => playSmartPlaylist(sp, "queue", b));
    actions.appendChild(buildOverflowMenu([
      { label: "Send to Roon", onClick: (b) => sendSmartPlaylistToRoon(sp, b) },
      { label: "Share",        onClick: (b) => shareThis(b) },
      { label: "Edit",         onClick: () => editSmartPlaylist(sp) },
      { label: "Delete",       onClick: () => deleteSmartPlaylist(sp), danger: true },
    ], { title: sp.name || "Dynamic Playlist" }));
    wrap.appendChild(actions);

    const ol = document.createElement("ol");
    ol.className = "track-list playlist-tracks";
    wrap.appendChild(ol);

    const status = document.createElement("div");
    status.className = "playlist-empty";
    status.textContent = "Reading tracks from Roon…";
    wrap.appendChild(status);

    const more = document.createElement("button");
    more.type = "button"; more.className = "action-btn playlist-more hidden";
    more.textContent = "Load more";
    wrap.appendChild(more);
    grid.appendChild(wrap);

    // Does the track list own this screen? In "tracks" mode it IS the screen and
    // reports its own progress. In "albums" mode the screen shows albums, and
    // the track paging still exists — Share has to expand albums into tracks
    // whichever mode we are in — but it must not narrate over the album count
    // that is already there.
    const trackMode = (sp.mode || SMART_MODE_DEFAULT) === "tracks";
    if (!trackMode) { ol.remove(); more.remove(); status.textContent = "Reading albums…"; }

    // Tracks are paged by ALBUM: each one has to be opened on the Core, so the
    // screen fills a batch at a time rather than stalling on a long playlist.
    let albumOffset = 0, loading = false, done = false, shown = 0;
    // `done` means "stop paging" — it is set both when the playlist ENDS and
    // when a page fails. Share has to tell those apart, so failure is recorded
    // separately rather than inferred from a flag that means two things.
    let failed = false;
    // The tracks as data, alongside the rows on screen. Share needs the values,
    // not the rendered text, and re-reading them out of the DOM would mean
    // parsing back a string this code already had.
    const loaded = [];
    const loadPageOnce = async () => {
      if (loading || done) return;
      loading = true;
      more.disabled = true;
      try {
        const zsel = document.getElementById("zone-select");
        const zid = (zsel && zsel.value) || selectedZoneId || "";
        const r = await fetch(`/api/smart-playlist?id=${encodeURIComponent(sp.id)}` +
                              `&offset=${albumOffset}` + (zid ? `&zone=${encodeURIComponent(zid)}` : ""),
                              { cache: "no-store" });
        if (!smartDetailActive || mySeq !== smartSeq) return;
        const j = await r.json().catch(() => ({}));
        if (!smartDetailActive || mySeq !== smartSeq) return;
        if (!r.ok) {
          status.textContent = j.error || "Couldn't read this playlist.";
          done = true;
          failed = true;
          more.classList.add("hidden");   // it would no-op; don't offer it
          return;
        }
        // A playlist whose query needs a feature that is switched off. The
        // server refuses to half-apply it: with Labels off, libraryView simply
        // skips a saved Record-label filter, so the playlist would open, play,
        // and return a completely different set of albums with nothing saying
        // why. Named here instead.
        if (j.unavailable) {
          status.className = "playlist-empty is-unavailable";
          status.textContent = j.unavailable;
          done = true;
          failed = true;
          more.classList.add("hidden");
          return;
        }

        for (const t of (j.tracks || [])) { if (trackMode) ol.appendChild(smartTrackRow(t)); loaded.push(t); }
        shown += (j.tracks || []).length;
        albumOffset += (j.albums_expanded || 0);
        done = !!j.done || !(j.albums_expanded > 0);
        if (trackMode) {
          status.textContent = done
            ? (shown ? `${shown} track${shown === 1 ? "" : "s"} from ${j.album_total} album${j.album_total === 1 ? "" : "s"}`
                     : "Nothing in your library matches this Dynamic Playlist right now.")
            : `${shown} tracks so far — ${j.album_total - albumOffset} album(s) left`;
          more.classList.toggle("hidden", done);
        }
      } catch (e) {
        if (!smartDetailActive || mySeq !== smartSeq) return;
        status.textContent = "Couldn't read this playlist.";
        done = true;
        failed = true;
      } finally {
        loading = false;
        more.disabled = false;
      }
    };

    // Awaiting a load that is ALREADY running has to mean "wait for it", not
    // "do nothing" — otherwise Share, tapped while the first page is still in
    // flight, sees `loading`, returns instantly and finds an empty list.
    let inflight = null;
    const loadPage = () => {
      if (loading) return inflight || Promise.resolve();
      inflight = loadPageOnce();
      return inflight;
    };
    // Share has to expand the albums it hasn't read yet — a smart playlist is a
    // query, and until an album is opened on the Core we don't know its tracks.
    // That is the same paging the "Load more" button drives, run to completion
    // with the progress visible, because a share that silently covered the
    // first 40 albums of 300 would be indistinguishable from a complete one.
    async function shareThis(btn) {
      btn.disabled = true;
      try {
        let stalled = false;
        while (!done && albumOffset < SHARE_ALBUM_MAX) {
          const before = albumOffset;
          // A PROGRESS message, so it must not linger: TOAST_REPORT_MS exists
          // for reports that land at the END of a long job, and using it here
          // pinned "Reading album 1…" over the finished share sheet for 9s.
          showToast(`Reading album ${albumOffset + 1}…`);
          await loadPage();
          // Leaving the screen orphans the page; stop rather than keep hammering
          // the Core for a view the user is no longer looking at.
          if (!smartDetailActive || mySeq !== smartSeq) return;
          // No forward progress: looping again would never terminate. It also
          // means we do NOT know we reached the end.
          if (albumOffset === before) { stalled = true; break; }
        }
        if (!loaded.length) { showToast("Nothing in this playlist to share", "error"); return; }
        // `failed` is set by loadPageOnce on an error. Without it a timeout on
        // page 4 of 40 was indistinguishable from finishing: `done` went true
        // either way, the loop exited, and the sheet announced a complete
        // share of 10% of the playlist.
        await shareTracks(sp.name || "Dynamic Playlist", loaded.map(t => ({
          title: t.title, artist: t.subtitle,
          album: t.album_title, track_no: t.track_no
        })), null, {
          incomplete:   failed || stalled,
          albumsCapped: !done && albumOffset >= SHARE_ALBUM_MAX,
        });
      } finally {
        btn.disabled = false;
      }
    }

    if (trackMode) {
      more.addEventListener("click", loadPage);
      loadPage();
      return;
    }

    // Albums mode: one request, straight out of the snapshot. No Roon calls at
    // all to LOOK at the playlist — expanding tracks is what costs, and that
    // only happens now if the user shares it.
    const albumGrid = document.createElement("div");
    // album-grid, not "grid": that is the class that actually carries the
    // responsive column layout, and it is the same one the Library wall uses,
    // so a playlist's albums size exactly like every other wall of tiles.
    albumGrid.className = "album-grid playlist-albums";
    wrap.insertBefore(albumGrid, status);
    try {
      const r = await fetch("/api/smart-playlist/albums?id=" + encodeURIComponent(sp.id),
                            { cache: "no-store" });
      if (!smartDetailActive || mySeq !== smartSeq) return;
      const j = await r.json().catch(() => ({}));
      if (!smartDetailActive || mySeq !== smartSeq) return;
      if (!r.ok) { status.textContent = j.error || "Couldn't read this playlist."; return; }
      const albums = j.albums || [];
      const frag = document.createDocumentFragment();
      for (const a of albums) frag.appendChild(buildAlbumTile(a));
      albumGrid.appendChild(frag);
      // Says what it PLAYS and, when the query matched more, what it left out —
      // the same honesty the tile subtitle carries.
      status.textContent = albums.length
        ? (Number.isFinite(j.matched) && j.matched > albums.length
            ? `${albums.length} of ${j.matched} albums that match`
            : `${albums.length} album${albums.length === 1 ? "" : "s"}`)
        : "Nothing in your library matches this Dynamic Playlist right now.";
    } catch (e) {
      if (!smartDetailActive || mySeq !== smartSeq) return;
      status.textContent = "Couldn't read this playlist.";
    }
  }
  window.__openSmartPlaylist = openSmartPlaylist;

  // A track row carrying the artwork of the album it came from. Tapping it plays
  // that track via the album path already used by the album view.
  function smartTrackRow(t) {
    const li = document.createElement("li");
    li.className = "track-row track-row-art";
    li.dataset.albumOffset = String(t.album_offset);
    li.dataset.trackIndex  = String(t.track_index);

    const art = document.createElement("span");
    art.className = "track-art";
    // The key stays on the element even if the <img> is removed by onerror, so
    // "which artwork was this row given" is answerable after the fact.
    if (t.image_key) art.dataset.artKey = t.image_key;
    if (t.image_key) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = "";
      img.src = `/api/image/${encodeURIComponent(t.image_key)}?size=80`;
      img.onerror = () => { art.classList.add("no-image"); img.remove(); };
      art.appendChild(img);
    } else {
      art.classList.add("no-image");
    }
    li.appendChild(art);

    const text = document.createElement("div");
    text.className = "track-text";
    const tt = document.createElement("div");
    tt.className = "track-title";
    tt.textContent = t.title || "";
    text.appendChild(tt);
    const ta = document.createElement("div");
    ta.className = "track-artist";
    ta.textContent = [t.subtitle, t.album_title].filter(Boolean).join(" · ");
    text.appendChild(ta);
    li.appendChild(text);

    li.addEventListener("click", async () => {
      const zsel = document.getElementById("zone-select");
      const zone = (zsel && zsel.value) || selectedZoneId;
      if (!zone) { showToast("Choose a zone first", "error"); return; }
      try {
        const r = await fetch("/api/play-track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // These are /api/play-track's names — `track`/`title`, NOT the
          // playlist route's `track_index`/`track_title`. Sending the wrong
          // pair 400s on every tap.
          body: JSON.stringify({
            offset: t.album_offset, track: t.track_index, title: t.title,
            zone_or_output_id: zone, kind: "play_now"
          })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) showToast(j.error || "Couldn't play that track", "error");
        else showToast(j.action || "Playing");
      } catch (e) {
        showToast("Couldn't reach the extension", "error");
      }
    });
    return li;
  }

  // Play or queue the whole thing. The albums come from the snapshot (no Roon
  // calls), then /api/play-multi does the work with its existing batching and
  // stale-offset defense.
  async function playSmartPlaylist(sp, kind, btn) {
    const zsel = document.getElementById("zone-select");
    const zone = (zsel && zsel.value) || selectedZoneId;
    if (!zone) { showToast("Choose a zone first", "error"); return; }
    btn.disabled = true;
    try {
      const r = await fetch(`/api/smart-playlist/albums?id=${encodeURIComponent(sp.id)}&max=${SMART_SEND_MAX}`,
                            { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(j.error || "Couldn't read this playlist", "error"); return; }
      const albums = (j.albums || []);
      if (!albums.length) { showToast("Nothing matches this Dynamic Playlist", "error"); return; }
      const pr = await fetch("/api/play-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: albums.map(a => ({ offset: a.offset, title: a.title, subtitle: a.subtitle })),
          zone_or_output_id: zone, kind
        })
      });
      const pj = await pr.json().catch(() => ({}));
      if (!pr.ok) { showToast(pj.error || "Roon refused that", "error"); return; }
      // Say how many of how many. The cap used to be silent, so a 1,179-album
      // playlist queued 100 and looked like it had queued everything.
      //
      // MATCHED, not total: the endpoint returns exactly `total` albums, so
      // comparing against it makes "capped" permanently false and this whole
      // message dead code. `matched` is what the query found, which is the
      // number the playlist was capped AGAINST.
      showToast(multiOutcome(kind === "queue" ? "Queued" : "Playing",
                             pj, albums.length, smartMatched(j)), null, TOAST_REPORT_MS);
    } catch (e) {
      // The fetch died, but the server keeps going — it has no way to hear
      // that we left. Saying "couldn't reach" would invite a retry that
      // restarts the queue from scratch on top of the run still in progress.
      showToast("Lost contact while filling the queue — check Roon before trying again",
                "error", TOAST_REPORT_MS);
    } finally {
      btn.disabled = false;
    }
  }

  // Turn a smart playlist into a real Roon playlist.
  //
  // Roon's extension API has NO playlist write of any kind — no create, add,
  // remove or reorder, and no "Add to Playlist" action anywhere in the browse
  // tree. Roon has left that request unanswered since 2017. What Roon DOES
  // offer is saving the current queue as a playlist from its own remote, so the
  // extension does the half it can (assembling the queue in the right order)
  // and then says exactly which two taps finish the job.
  async function sendSmartPlaylistToRoon(sp, btn) {
    const zsel = document.getElementById("zone-select");
    const zone = (zsel && zsel.value) || selectedZoneId;
    if (!zone) { showToast("Choose a zone first", "error"); return; }

    // Disclose the cap BEFORE asking, not after: the confirm destroys the
    // existing queue, and a user agreeing to "send 1,179 albums" would not
    // necessarily agree to "destroy the queue to send 400 of them".
    const capNote = (typeof sp.album_total === "number" && sp.album_total > SMART_SEND_MAX)
      ? `\n\nOnly the first ${SMART_SEND_MAX} of ${sp.album_total} albums fit in one go.`
      : "";
    const ok = await confirmDialog(
      `Queue "${sp.name}" to ${(zsel && zsel.selectedOptions[0] && zsel.selectedOptions[0].textContent) || "this zone"}?\n\n` +
      "Roon's API can't create playlists, so this fills the queue instead. " +
      "Then in Roon: open the queue, tap the 3 dots above it, and choose " +
      "\"Add the queue to a Playlist\".\n\nThis replaces what's in the queue now." +
      capNote);
    if (!ok) return;

    btn.disabled = true;
    try {
      const r = await fetch(`/api/smart-playlist/albums?id=${encodeURIComponent(sp.id)}&max=${SMART_SEND_MAX}`,
                            { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(j.error || "Couldn't read this playlist", "error"); return; }
      const albums = j.albums || [];
      if (!albums.length) { showToast("Nothing matches this Dynamic Playlist", "error"); return; }

      const pr = await fetch("/api/play-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: albums.map(a => ({ offset: a.offset, title: a.title, subtitle: a.subtitle })),
          zone_or_output_id: zone,
          // play_now on the first album, queue for the rest — that is what
          // play-multi does, and it is what builds an ordered queue.
          kind: "play_now"
        })
      });
      const pj = await pr.json().catch(() => ({}));
      if (!pr.ok) { showToast(pj.error || "Roon refused that", "error"); return; }
      showToast(multiOutcome("Queued", pj, albums.length, smartMatched(j)) +
                " — now save the queue as a playlist in Roon", null, TOAST_REPORT_MS);
    } catch (e) {
      // Same reasoning as playSmartPlaylist: the server run outlives our fetch.
      showToast("Lost contact while filling the queue — check Roon before trying again",
                "error", TOAST_REPORT_MS);
    } finally {
      btn.disabled = false;
    }
  }

  // Edit reuses the Focus sheet: load the saved view into the live one, then
  // open the editor with this playlist as the save target, so "Save as…" writes
  // back to the same record instead of creating a duplicate.
  // Copy a saved view into the live one. Decades are normalised to STRINGS: the
  // server stores them as numbers, while the whole client compares against
  // String(decade) — the Focus chips would render off for a decade that IS
  // active, and tapping one would push a duplicate rather than toggle it.
  function applyViewToLibView(view) {
    // A facet the saved view doesn't mention is OFF, not "leave whatever the
    // Library screen happens to have". Skipping it would let a playlist saved
    // before a facet existed quietly inherit the user's current filters and
    // then show a different set of albums than the one that was saved.
    Object.assign(libView, libEmptyFacets());
    for (const k of SMART_VIEW_KEYS) {
      if (view[k] === undefined) continue;
      libView[k] = Array.isArray(view[k]) ? view[k].map(String) : view[k];
    }
  }

  // NOT saved here. editSmartPlaylist used to commit the playlist's view to
  // localStorage immediately, so opening Edit and closing it again silently and
  // permanently re-sorted the user's Library screen. openLibFocusSheet restores
  // the previous view if the sheet is abandoned.
  function editSmartPlaylist(sp) {
    openLibFocusSheet(sp);
  }

  async function deleteSmartPlaylist(sp) {
    const ok = await confirmDialog(`Delete the Dynamic Playlist "${sp.name}"?`);
    if (!ok) return;
    try {
      const r = await fetch("/api/smart-playlists/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sp.id })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(j.error || "Couldn't delete that", "error"); return; }
      showToast(`Deleted "${sp.name}"`);
      smartDetailActive = false;
      showSmartPlaylists();
    } catch (e) {
      showToast("Couldn't delete that", "error");
    }
  }

  // A zone row's label. Grouped zones get a second line naming their outputs,
  // as Roon's own remote does — without it a zone called "Kitchen + Study" and
  // a real Kitchen+Study group look identical.
  function fillZoneRow(item, z) {
    const outs = z.outputs || [];
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = z.display_name;
    item.appendChild(name);
    if (outs.length > 1) {
      const sub = document.createElement("span");
      sub.className = "np-device-sub";
      sub.textContent = outs.map(o => o.display_name).filter(Boolean).join(" + ");
      item.appendChild(sub);
    }
  }
  window.__fillZoneRow = fillZoneRow;

  // ----- Zone grouping (Roon group_outputs / ungroup_outputs) ---------------
  //
  // Roon groups OUTPUTS, not zones: a zone IS whichever outputs currently play
  // in sync. So this is a checklist of outputs anchored on the zone the app is
  // driving. Roon preserves the first output's queue, so the anchor's own
  // output is always sent first and always stays ticked — grouping can never
  // throw away what you're listening to.
  async function openGroupSheet() {
    const anchorZoneId = selectedZoneId;
    let list = [];
    try {
      const r = await fetch("/api/outputs", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.outputs)) list = j.outputs; }
    } catch (e) { /* leaves `list` empty — the empty state below explains it */ }

    const anchorOutputs = anchorZoneId ? list.filter(o => o.zone_id === anchorZoneId) : [];
    const anchorIds     = anchorOutputs.map(o => o.output_id);
    const primary       = anchorOutputs[0] || null;

    // Roon says which outputs an output may join. A Core that doesn't send the
    // list gives us null, which we read as "unknown" and offer everything —
    // offering nothing would make the feature look broken rather than limited.
    const allowed = primary && Array.isArray(primary.can_group_with_output_ids)
      ? new Set(primary.can_group_with_output_ids)
      : null;
    const offerable = list.filter(o =>
      anchorIds.includes(o.output_id) || !allowed || allowed.has(o.output_id));

    const picked = new Set(anchorIds);

    openLibSheet("Group zones", (body, close) => {
      const paint = () => {
        body.innerHTML = "";
        if (!primary) {
          const note = document.createElement("div");
          note.className = "lib-sheet-note";
          note.textContent = list.length
            ? "Choose a zone first — grouping needs a zone to build the group around."
            : "No outputs available. Check that the extension is paired with your Roon Core.";
          body.appendChild(note);
          return;
        }
        for (const o of offerable) {
          const isPrimary = o.output_id === primary.output_id;
          const on = picked.has(o.output_id);
          const row = document.createElement("button");
          row.type = "button";
          row.className = "group-row" + (on ? " is-on" : "") + (isPrimary ? " is-anchor" : "");
          row.dataset.output = o.output_id;
          const box = document.createElement("span");
          box.className = "group-box";
          box.textContent = "✓";
          const text = document.createElement("span");
          text.className = "group-text";
          const nm = document.createElement("span");
          nm.className = "group-name";
          nm.textContent = o.display_name || o.output_id;
          text.appendChild(nm);
          // Say why a row can't be unticked, and warn when taking an output
          // would break up a group it is already in. Outputs already in THIS
          // zone get nothing — they're ticked, which says it, and naming the
          // group we're editing back at the user is just noise.
          const noteText = isPrimary
            ? "Keeps playing — this group's queue"
            : (!anchorIds.includes(o.output_id) && o.zone_name && o.zone_name !== o.display_name
                ? "In " + o.zone_name : "");
          if (noteText) {
            const nt = document.createElement("span");
            nt.className = "group-note";
            nt.textContent = noteText;
            text.appendChild(nt);
          }
          row.appendChild(box); row.appendChild(text);
          if (isPrimary) {
            row.disabled = true;
            row.setAttribute("aria-pressed", "true");
          } else {
            row.setAttribute("aria-pressed", String(on));
            row.addEventListener("click", () => {
              if (picked.has(o.output_id)) picked.delete(o.output_id);
              else picked.add(o.output_id);
              paint();
              const again = body.querySelector('[data-output="' + o.output_id + '"]');
              if (again) again.focus();
            });
          }
          body.appendChild(row);
        }
        if (offerable.length < list.length) {
          const note = document.createElement("div");
          note.className = "lib-sheet-note";
          note.textContent = "Outputs your Core can't sync with " + primary.display_name +
                             " aren't listed — Roon decides which devices can play together.";
          body.appendChild(note);
        }
      };
      paint();
    }, (foot, close) => {
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "action-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const apply = document.createElement("button");
      apply.type = "button"; apply.className = "action-btn primary";
      apply.textContent = "Apply";
      apply.addEventListener("click", async () => {
        if (!primary) { close(); return; }
        const toRemove = anchorIds.filter(id => !picked.has(id));
        const toAdd    = [...picked].filter(id => !anchorIds.includes(id));
        if (!toRemove.length && !toAdd.length) { close(); return; }
        apply.disabled = true; cancel.disabled = true;
        const ok = await applyGrouping(anchorIds, toRemove, toAdd, primary);
        apply.disabled = false; cancel.disabled = false;
        if (ok) close();
      });
      foot.appendChild(cancel); foot.appendChild(apply);
    });
  }

  // Split first, then group: ungrouping an output that is also being regrouped
  // elsewhere would otherwise race, and Roon takes the whole desired set for a
  // group in one call anyway.
  async function applyGrouping(anchorIds, toRemove, toAdd, primary) {
    const post = async (url, output_ids) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output_ids })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ("HTTP " + r.status));
      }
    };
    try {
      if (toRemove.length) await post("/api/ungroup-outputs", toRemove);
      if (toAdd.length) {
        // primary first — Roon preserves the first output's zone's queue.
        const kept = anchorIds.filter(id => id !== primary.output_id && !toRemove.includes(id));
        await post("/api/group-outputs", [primary.output_id, ...kept, ...toAdd]);
      }
      showToast("Zones updated");
    } catch (e) {
      showToast(e.message || "Could not change grouping", "error");
      return false;
    }
    // Roon has accepted the change, so the sheet's work is done — settling the
    // app onto the new zone happens in the background rather than holding the
    // sheet open for it. Detached deliberately: an unresolved settle must not
    // leave the user staring at a sheet Roon has already acted on.
    const want = new Set([
      primary.output_id,
      ...anchorIds.filter(id => !toRemove.includes(id)),
      ...toAdd,
    ]);
    settleZoneAfterGrouping(primary.output_id, want);
    return true;
  }

  // Grouping retires zone ids — Roon mints a zone per set of outputs — so the
  // app has to be re-pointed at whichever zone now holds the output we anchored
  // on. Left alone, loadZones() would find the old id gone and fall back to
  // whichever zone sorts first, quietly moving the user elsewhere.
  //
  // The Core's zone update is asynchronous, so a single fixed wait is a guess.
  // Poll instead: take the best answer available on each attempt and stop as
  // soon as the topology matches what was asked for. Bounded at ~2s, after which
  // loadZones() and the 1.5s transport poll resync regardless.
  async function settleZoneAfterGrouping(anchorOutputId, want) {
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(r => setTimeout(r, 250));
      let zs = null;
      try {
        const r = await fetch("/api/zones", { cache: "no-store" });
        if (r.ok) { const j = await r.json(); if (Array.isArray(j.zones)) zs = j.zones; }
      } catch (e) { /* transient — retry; the loop is bounded and resyncs after */ }
      if (!zs) continue;
      const z = zs.find(zz => (zz.outputs || []).some(o => o.output_id === anchorOutputId));
      if (!z) continue;
      try { localStorage.setItem("rra-zone", z.zone_id); }
      catch (e) { /* private mode — loadZones() still selects a zone, just not this one */ }
      const have = new Set((z.outputs || []).map(o => o.output_id));
      if (have.size === want.size && [...want].every(id => have.has(id))) break;
    }
    await loadZones();
    if (typeof window.__refreshTransport === "function") window.__refreshTransport();
  }
  window.__openGroupSheet = openGroupSheet;

  // ----- Device power (Roon standby / convenience switch) -------------------
  //
  // Roon can power the amp or DAC behind an output, but only through a SOURCE
  // CONTROL the device itself exposes — most outputs have none, and for those
  // there is nothing to show. So this sheet is a list of source controls, not of
  // zones, and it is honest about an empty result rather than pretending the
  // feature is missing.
  //
  // Unlike the grouping sheet these actions fire immediately: a power button
  // that waits for an Apply is a power button people press twice.
  const SOURCE_STATUS_LABEL = {
    selected:      "On — Roon input selected",
    deselected:    "On — another input selected",
    standby:       "In standby",
    indeterminate: "",
  };

  async function openDevicePowerSheet() {
    let list = [];
    try {
      const r = await fetch("/api/outputs", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.outputs)) list = j.outputs; }
    } catch (e) { /* leaves `list` empty — the empty state below explains it */ }

    openLibSheet("Device power", (body) => {
      // Re-read after every action so the status lines reflect the device, not
      // what we asked for — the same rule the mode buttons follow.
      const refresh = async () => {
        try {
          const r = await fetch("/api/outputs", { cache: "no-store" });
          if (r.ok) { const j = await r.json(); if (Array.isArray(j.outputs)) list = j.outputs; }
        } catch (e) { /* keep the previous list; paint() still renders something */ }
        paint();
      };

      const act = async (url, payload, btn) => {
        btn.disabled = true;
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            showToast(j.error || "Roon refused that", "error");
          }
        } catch (e) {
          showToast("Could not reach the extension", "error");
        } finally {
          btn.disabled = false;
        }
        // Roon reports the new status asynchronously; give it a moment.
        setTimeout(refresh, 400);
      };

      const paint = () => {
        body.innerHTML = "";
        const withControls = list.filter(o => (o.source_controls || []).length);
        if (!withControls.length) {
          const note = document.createElement("div");
          note.className = "lib-sheet-note";
          note.textContent = list.length
            ? "None of your outputs expose a source control, so Roon can't switch them " +
              "on or off. This works with devices that report power state to Roon — many " +
              "network streamers and AVRs do, plain audio endpoints don't."
            : "No outputs available. Check that the extension is paired with your Roon Core.";
          body.appendChild(note);
          return;
        }
        for (const o of withControls) {
          const controls = o.source_controls || [];
          const sec = document.createElement("div");
          sec.className = "lib-sheet-section";
          const label = document.createElement("div");
          label.className = "lib-sheet-section-label";
          label.textContent = o.display_name;
          sec.appendChild(label);

          for (const sc of controls) {
            const row = document.createElement("div");
            row.className = "dev-row";
            row.dataset.control = sc.control_key;

            const text = document.createElement("div");
            text.className = "dev-text";
            const nm = document.createElement("span");
            nm.className = "dev-name";
            nm.textContent = sc.display_name;
            text.appendChild(nm);
            const st = SOURCE_STATUS_LABEL[sc.status] || "";
            if (st) {
              const stEl = document.createElement("span");
              stEl.className = "dev-status";
              stEl.textContent = st;
              text.appendChild(stEl);
            }
            row.appendChild(text);

            const actions = document.createElement("div");
            actions.className = "dev-actions";
            if (sc.supports_standby) {
              const pwr = document.createElement("button");
              pwr.type = "button";
              pwr.className = "dev-btn" + (sc.status === "standby" ? "" : " is-on");
              pwr.dataset.action = "standby";
              pwr.textContent = "Power";
              pwr.setAttribute("aria-label",
                sc.status === "standby" ? "Wake " + sc.display_name
                                        : "Put " + sc.display_name + " into standby");
              pwr.addEventListener("click", () => act("/api/output/standby",
                { output_id: o.output_id, control_key: sc.control_key, mode: "toggle" }, pwr));
              actions.appendChild(pwr);
            }
            const sw = document.createElement("button");
            sw.type = "button";
            sw.className = "dev-btn";
            sw.dataset.action = "switch";
            sw.textContent = "Roon input";
            sw.setAttribute("aria-label", "Switch " + sc.display_name + " to its Roon input");
            sw.addEventListener("click", () => act("/api/output/convenience-switch",
              { output_id: o.output_id, control_key: sc.control_key }, sw));
            actions.appendChild(sw);
            row.appendChild(actions);
            sec.appendChild(row);
          }

          // Roon's standby() with no control_key covers every standby-capable
          // control at once. That is only a distinct action on a device with
          // more than one, so it appears only there.
          if (controls.filter(sc => sc.supports_standby).length > 1) {
            const all = document.createElement("button");
            all.type = "button";
            all.className = "dev-btn dev-all-off";
            all.dataset.action = "all-off";
            all.textContent = "Put whole device into standby";
            all.addEventListener("click", () => act("/api/output/standby",
              { output_id: o.output_id, mode: "standby" }, all));
            sec.appendChild(all);
          }
          body.appendChild(sec);
        }
      };
      paint();
    }, (foot, close) => {
      const done = document.createElement("button");
      done.type = "button"; done.className = "action-btn primary";
      done.textContent = "Done";
      done.addEventListener("click", close);
      foot.appendChild(done);
    });
  }
  window.__openDevicePowerSheet = openDevicePowerSheet;

  async function showLibraryWall() {
    const m = enterFullWall("Library");
    libraryWallActive = true;
    renderLibraryControls();
    libWall.seq++;
    const mySeq = libWall.seq;
    libWall.offset = 0; libWall.loading = false; libWall.done = false;
    await fetchLibraryPage(mySeq, true);
    // Wide screens (9 columns) can swallow the first page without producing a
    // scrollbar — no scrollbar means no scroll events, so keep filling until
    // the viewport overflows (or the library runs out). fetchLibraryPage's
    // loading guard makes a concurrent scroll-handler fetch harmless (this
    // iteration then no-ops and the offset check below ends the loop).
    while (libraryWallActive && mySeq === libWall.seq && !libWall.done && !libWall.loading &&
           m && m.scrollHeight <= m.clientHeight + 200) {
      const before = libWall.offset;
      await fetchLibraryPage(mySeq, false);
      if (libWall.offset === before) break;   // page failed or empty — stop; scroll retries
    }
  }

  // Infinite scroll: <main> is the shared scroll container for every grid view;
  // only act while the library wall owns it (labelsActive double-checks — the
  // labels browser paints the same grid without touching the wall flags).
  {
    const mainEl = document.querySelector("main");
    if (mainEl) {
      mainEl.addEventListener("scroll", () => {
        if (!libraryWallActive || labelsActive || libWall.loading || libWall.done) return;
        if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 600) {
          fetchLibraryPage(libWall.seq, false);
        }
      }, { passive: true });
    }
  }

  // Section-header activation (click + Enter/Space) — one wiring for all four
  // Home headers so keyboard behaviour can't drift between them.
  function wireSectionHeader(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); }
    });
  }

  // Header taps: Not played → full unplayed grid; Random albums → full random
  // wall; Library → full A-Z wall; Label of the week → label view.
  {
    wireSectionHeader("home-unplayed-title", showUnplayedWall);
    wireSectionHeader("home-random-title", () => { if (window.__applyFilter) window.__applyFilter(null); });
    wireSectionHeader("home-library-title", showLibraryWall);
    wireSectionHeader("home-lotw-title", () => {
      const name = homeLotw && homeLotw.dataset.label;
      if (name && window.__showLabelAlbums) window.__showLabelAlbums(name);
    });
    wireSectionHeader("home-picks-title", showSmartPicks);
  }

  // Weighted-random pick from a list of { title, count }.
  function pickWeightedSub(items) {
    let total = 0;
    for (const it of items) total += Math.max(1, it.count || 1);
    let r = Math.random() * total;
    for (const it of items) { r -= Math.max(1, it.count || 1); if (r <= 0) return it; }
    return items[items.length - 1];
  }

  // Render the genre buttons from card descriptors ({label, genre} or
  // {label, group, parent}). Shared by the live loader and the cache repaint;
  // the descriptors are plain data, so they persist and rebuild identically.
  function renderHomeGenres(cards) {
    cards = cards || [];
    homeGenres.innerHTML = "";
    if (!cards.length) {
      homeGenres.innerHTML = '<div class="home-carousel-empty">No genres found.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of cards) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "home-genre-card";
      card.textContent = c.label;
      card.addEventListener("click", () => {
        if (!window.__applyFilter) return;
        if (c.group) {
          // Pick a random sub-genre from the group; the breadcrumb keeps the
          // group label (e.g. "Rock/Metal"). Refreshing the grid reshuffles
          // that sub-genre; re-tapping the button picks a new one.
          const sub = pickWeightedSub(c.group);
          window.__applyFilter({ type: "genre", value: sub.title, parent: c.parent, label: c.label });
        } else {
          window.__applyFilter({ type: "genre", value: c.genre });
        }
      });
      frag.appendChild(card);
    }
    homeGenres.appendChild(frag);
  }

  async function loadHomeGenres() {
    if (!homeGenres) return;
    if (!rowHasContent(homeGenres)) homeGenres.innerHTML = '<div class="home-carousel-empty">Loading…</div>';
    try {
      const [genresRes, groupsRes] = await Promise.all([
        fetch("/api/filters/genres").catch(() => null),
        fetch("/api/home/genre-groups").catch(() => null)
      ]);
      if ((genresRes && genresRes.status === 503) || (groupsRes && groupsRes.status === 503)) {
        if (!rowHasContent(homeGenres)) homeGenres.innerHTML = '<div class="home-carousel-empty">Waiting for Roon Core…</div>';
        return;   // keep any cached cards while the index builds
      }
      const genresJ = genresRes ? await genresRes.json().catch(() => ({})) : {};
      const groupsJ = groupsRes ? await groupsRes.json().catch(() => ({})) : {};
      // Pull extra genres up front — splitting Pop/Rock adds a card, and we trim
      // down to an even count afterwards so the 2-column grid has full rows.
      const top = ((genresJ && genresJ.genres) || []).slice(0, 16); // biggest first
      const groups = groupsJ || {};
      const parent = groups.parent;

      // Build card descriptors. The "Pop/Rock" parent is split into two buttons:
      // "Rock/Metal" (curated rock/metal sub-genres) and "Pop" (pop sub-genres).
      // Rock/Metal and Pop are pushed FIRST so they always survive the trim.
      const cards = [];
      const haveRockMetal = groups.rockmetal && groups.rockmetal.length;
      const havePop = groups.pop && groups.pop.length;
      if (parent && (haveRockMetal || havePop)) {
        if (haveRockMetal) cards.push({ label: "Rock/Metal", group: groups.rockmetal, parent });
        if (havePop) cards.push({ label: "Pop", group: groups.pop, parent });
      }
      for (const g of top) {
        // Drop the raw Pop/Rock parent — it's represented by the split buttons.
        if (parent && /pop\s*\/\s*rock/i.test(g.title)) continue;
        cards.push({ label: g.title, genre: g.title });
      }

      // Target an even 12 buttons so the grid rows are balanced on every screen.
      // If we have more, keep the first 12 (biggest, Rock/Metal + Pop first); if
      // fewer, drop the last one when the count is odd.
      const MAX_CARDS = 12;
      if (cards.length > MAX_CARDS) cards.length = MAX_CARDS;
      if (cards.length % 2 === 1) cards.length -= 1;

      if (cards.length) {
        renderHomeGenres(cards);
        homeSectionsLoaded = true;   // populated — stop retrying on future visits
        saveHomeCache({ genres: cards });
      } else if (!rowHasContent(homeGenres)) {
        // Empty 200 (index still building after a restart) — keep the hydrated
        // cards if we have them; only show "No genres found." when nothing is
        // cached, rather than blanking a good cached row.
        renderHomeGenres([]);
      }
    } catch (e) {
      if (!rowHasContent(homeGenres)) homeGenres.innerHTML = '<div class="home-carousel-empty">Couldn’t load genres.</div>';
    }
  }

  // Instant open: repaint the last persisted Home rows immediately, before we've
  // even reconnected to Roon. Returns true if it painted the main content, so
  // the boot path can reveal Home right away instead of a blank "Connecting…".
  // The live loaders (called by showHome once paired) then revalidate silently,
  // swapping fresh data in without a "Loading…" flash. Seeding homeRowsLoadedAt
  // lets the existing 5-minute TTL skip the unplayed/random refetch entirely on
  // a quick reopen — but only when BOTH rows are recent: it's seeded from the
  // OLDER of the two per-row timestamps, so a stale sibling (e.g. unplayed kept
  // an old cache while random refreshed) forces a silent revalidation instead
  // of riding the fresh row's freshness.
  function hydrateHomeFromCache() {
    const c = readHomeCache();
    if (!c) return false;
    // Order and enablement first: painting into the default order and then
    // reordering is a visible flash on every cold open.
    applyHomeLayout();
    let painted = false;
    if (c.unplayed && homeUnplayed) { renderHomeUnplayed(c.unplayed.aotd, c.unplayed.albums); painted = rowHasContent(homeUnplayed) || painted; }
    if (c.random   && homeRandom)   { renderHomeRandom(c.random);                              painted = rowHasContent(homeRandom)   || painted; }
    if (c.library  && homeLibrary)  { renderHomeLibrary(c.library); }
    if (c.lotw     && homeLotw)     { renderHomeLotw(c.lotw.label, c.lotw.albums); }
    if (c.history  && homeHistory)  { renderHomeHistory(c.history); }
    if (c.genres   && homeGenres)   { renderHomeGenres(c.genres); }
    if (!painted) return false;
    if (typeof c.unplayedAt === "number" && typeof c.randomAt === "number") {
      homeRowsLoadedAt = Math.min(c.unplayedAt, c.randomAt);   // honour the TTL across reopens
    }
    // Reveal Home so the cached content is actually on screen while we reconnect.
    if (homeView)     homeView.classList.remove("hidden");
    if (homeSections) homeSections.classList.remove("hidden");
    grid.classList.add("hidden");
    setTopbarNav(false, false, true);   // Home chrome: search box, no Back/Refresh
    return true;
  }

  // ----- Toast / banner -----
  let toastTimer = null;
  // `ms` overrides the 2.4s default. Anything that lands at the END of a
  // multi-minute operation needs longer: the user has usually looked away, and
  // 2.4s of "queued 400 of 1179" is the same as never having said it.
  function showToast(msg, kind, ms) {
    toast.textContent = msg;
    toast.classList.remove("hidden", "error");
    if (kind === "error") toast.classList.add("error");
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(toastTimer);
    // 2.4s is right for "Queued 12 albums" and nowhere near enough for the
    // library-changed messages, which explain the cause, what happens next and
    // the manual way out — roughly 330 characters, gone before they could be
    // read. Scaled by length so short toasts are unchanged.
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.classList.add("hidden"), 250);
    }, ms || (String(msg).length > 120 ? 11000 : 2400));
  }
  // One sentence describing what actually reached the queue: how many albums,
  // how many the cap left behind, and how many Roon refused. `pj` is
  // /api/play-multi's body, `asked` the albums we sent, `total` the size of the
  // whole playlist. Shared so Play now, Queue and Send to Roon cannot drift.
  // How many albums the playlist's query MATCHED, as opposed to how many it
  // delivers. Older responses carried only the delivered count; falling back to
  // it makes the comparison a no-op rather than a wrong number.
  function smartMatched(j) {
    return Number.isFinite(j.matched) ? j.matched : j.total;
  }
  function multiOutcome(verb, pj, asked, total) {
    const queued = Number.isFinite(pj.queued) ? pj.queued : asked;
    const failed = Number.isFinite(pj.failed) ? pj.failed : 0;
    const capped = Number.isFinite(total) && asked < total;
    let msg = `${verb} ${queued}`;
    if (capped) msg += ` of ${total}`;
    // Pluralise off whichever number the noun follows.
    msg += ` album${(capped ? total : queued) === 1 ? "" : "s"}`;
    if (failed > 0) msg += ` (Roon refused ${failed})`;
    if (capped) msg += " — that's the limit per go";
    return msg;
  }
  function setBanner(msg, isError) {
    if (!msg) { banner.classList.add("hidden"); banner.textContent = ""; return; }
    banner.textContent = msg;
    banner.classList.toggle("error", !!isError);
    banner.classList.remove("hidden");
  }

  // ----- Scan progress bar -----
  function updateScanBar(progress) {
    const bar  = document.getElementById("scan-progress-bar");
    const fill = document.getElementById("scan-progress-fill");
    if (!bar || !fill) return;
    if (progress === null || progress === undefined) {
      bar.classList.add("hidden");
      fill.style.width = "0%";
    } else {
      bar.classList.remove("hidden");
      fill.style.width = Math.round((progress || 0) * 100) + "%";
    }
  }

  // ----- Skeletons -----
  function renderSkeletons(n) {
    grid.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      el.className = "album skeleton";
      el.innerHTML = `
        <div class="album-art-wrap"></div>
        <div class="album-meta">
          <div class="album-title">&nbsp;</div>
          <div class="album-artist">&nbsp;</div>
        </div>`;
      grid.appendChild(el);
    }
  }

  // ----- Long-press utility -----
  //
  // The callback fires at 500ms while the finger is STILL DOWN, so the browser
  // goes on to dispatch a click on release. Without suppression that click ran
  // the element's normal handler straight after the long-press handler — on an
  // album tile it selected the album and then immediately deselected it, so a
  // long press opened select mode with nothing in it. `longPressAte` is set by
  // the callback and consumed by the very next click, in the capture phase so
  // it lands before any listener the element itself carries.
  function addLongPress(el, callback) {
    let timer = null;
    let moved = false;
    const onStart = () => {
      moved = false;
      timer = setTimeout(() => {
        if (moved) return;
        if (navigator.vibrate) navigator.vibrate(25);
        longPressAte = true;
        callback();
      }, 500);
    };
    const onMove  = () => { moved = true; clearTimeout(timer); timer = null; };
    const onEnd   = () => { clearTimeout(timer); timer = null; };
    el.addEventListener("touchstart",  onStart,  { passive: true });
    el.addEventListener("touchmove",   onMove,   { passive: true });
    el.addEventListener("touchend",    onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("mousedown",   onStart);
    el.addEventListener("mousemove",   onMove);
    el.addEventListener("mouseup",     onEnd);
    el.addEventListener("contextmenu", e => e.preventDefault());
    el.addEventListener("click", (e) => {
      if (!longPressAte) return;
      longPressAte = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  // ----- Render -----
  // Tile art size matched to the display: tiles render at ~150-220px CSS, so
  // 500px covers were ~2.8× oversized on DPR-2 iPads — each one an on-demand
  // rescale by the Roon Core. Rounded to coarse steps so the whole session
  // shares a handful of cache keys (server LRU + browser cache); the 300px
  // floor keeps DPR-1 desktops sharp on wide walls where tiles exceed 200px.
  const TILE_IMG_SIZE = Math.min(500, Math.max(300, Math.ceil((190 * (window.devicePixelRatio || 1)) / 100) * 100));

  // Source badge for an album payload: "local" | "qobuz" | "tidal", or null
  // when the server couldn't determine it. `a.local` is still honoured so a
  // tile built from an older cached payload keeps its badge.
  // ----- Quality badge -----------------------------------------------------
  //
  // "24/96" on the artwork, off by default and switched on in Appearance. It is
  // read from your own files, so a streamed album simply has none — the server
  // sends the field only when it knows, and no badge is drawn otherwise. A
  // question mark or a guess would be worse than silence.
  //
  // A device preference like the theme, so it lives in localStorage rather than
  // settings.json: one person wanting rates on their phone shouldn't put them
  // on the wall display too.
  const QUALITY_KEY = "rra-show-quality";
  let showQuality = false;
  try { showQuality = localStorage.getItem(QUALITY_KEY) === "1"; }
  catch (e) { /* private browsing — the default (off) stands */ }
  function setShowQuality(on) {
    showQuality = !!on;
    try { localStorage.setItem(QUALITY_KEY, showQuality ? "1" : "0"); }
    catch (e) { /* still applies for this session */ }
    // Every tile already on screen, without a refetch: the payload always
    // carries the value, so this is a class flip rather than a reload.
    document.body.classList.toggle("show-quality", showQuality);
  }
  // Applied at boot, not only on change — the stored preference has to survive
  // a reload, and the class is the only thing that makes the badges visible.
  document.body.classList.toggle("show-quality", showQuality);
  window.__showQuality    = () => showQuality;
  window.__setShowQuality = setShowQuality;
  function qualityBadge(a) {
    if (!a.quality) return null;
    const el = document.createElement("span");
    el.className = "album-quality" + (a.hires ? " is-hires" : "");
    el.textContent = a.quality;
    // The badge is two characters of shorthand; the accessible name says what
    // they mean, and the tooltip does the same for a mouse.
    const words = /\//.test(a.quality)
      ? a.quality.split("/")[0] + "-bit, " + a.quality.split("/")[1] + " kHz"
      : a.quality;
    el.title = words;
    el.setAttribute("aria-label", words);
    return el;
  }

  const SOURCE_LABEL = { local: "Local albums", qobuz: "Qobuz", tidal: "TIDAL" };
  function sourceBadge(a) {
    const kind = a.source || (a.local ? "local" : null);
    if (!kind || !SOURCE_LABEL[kind]) return null;
    const el = document.createElement("span");
    el.className = "album-source " + kind;
    el.title = SOURCE_LABEL[kind];
    el.setAttribute("aria-label", SOURCE_LABEL[kind]);
    return el;
  }

  // Build a single album tile. onClick defaults to opening the album modal,
  // but callers (e.g. the label browser) can override it to carry a filter.
  function buildAlbumTile(a, onClick, opts) {
    const btn = document.createElement("button");
    btn.className = "album";
    btn.type = "button";
    btn.setAttribute("aria-label",
      `${a.title || "Untitled"}${a.subtitle ? " by " + a.subtitle : ""}`);
    btn.dataset.albumKey = (a.title || "").toLowerCase().trim();

    const artWrap = document.createElement("div");
    artWrap.className = "album-art-wrap";
    // Source badge — only shown when the server is confident: local files, or
    // an album matched in your Qobuz/Tidal favourites. No badge means the
    // source couldn't be determined, not that it's missing.
    const srcBadge = sourceBadge(a);
    if (srcBadge) artWrap.appendChild(srcBadge);
    // Always built, shown or hidden by one class on <body>. Rendering it
    // conditionally would mean every tile already on screen kept its old state
    // until something rebuilt it, so the toggle would look like it had done
    // nothing until you navigated away and back.
    const qBadge = qualityBadge(a);
    if (qBadge) artWrap.appendChild(qBadge);
    // A playlist has no cover of its own, so it gets a mosaic of the artwork
    // from the first few tracks — the way Roon draws them. Two or more distinct
    // covers make a 2x2; a single one just fills the tile, because a lone
    // quarter-sized sleeve in an empty square looks broken.
    const mosaic = Array.isArray(a.art_keys) ? a.art_keys.filter(Boolean) : [];
    if (mosaic.length >= 2) {
      artWrap.classList.add("album-art-mosaic");
      artWrap.dataset.mosaic = String(Math.min(mosaic.length, 4));
      // Keys recorded on the element so "what artwork was this tile given" is
      // answerable even after a failed <img> removes itself.
      artWrap.dataset.artKeys = mosaic.slice(0, 4).join(",");
      for (const k of mosaic.slice(0, 4)) {
        const img = document.createElement("img");
        img.loading = "lazy"; img.alt = "";
        img.src = `/api/image/${encodeURIComponent(k)}?size=${TILE_IMG_SIZE}`;
        img.onerror = () => img.remove();
        artWrap.appendChild(img);
      }
    } else if (mosaic.length === 1 || a.image_key) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = "";
      img.src = `/api/image/${encodeURIComponent(mosaic[0] || a.image_key)}?size=${TILE_IMG_SIZE}`;
      img.onerror = () => { artWrap.classList.add("no-image"); img.remove(); };
      artWrap.appendChild(img);
    } else {
      artWrap.classList.add("no-image");
    }

    const meta = document.createElement("div");
    meta.className = "album-meta";
    meta.innerHTML = `<div class="album-title"></div><div class="album-artist"></div>`;
    meta.querySelector(".album-title").textContent  = a.title    || "Untitled";
    meta.querySelector(".album-artist").textContent = a.subtitle || "";

    btn.appendChild(artWrap);
    btn.appendChild(meta);

    // Whether long-press can multi-select this tile. It used to be inferred
    // from "was a custom opener passed", which quietly disabled selection on
    // seven of the eleven tile screens — the Library A-Z wall, Not-played,
    // label albums and the Home carousels all pass an opener for the sole
    // purpose of forcing `filter: null`, and paid for it with no select mode.
    // Stating it outright separates "how do I open" from "can I select".
    // Playlist tiles pass false: a playlist is not an album and cannot be
    // queued as one.
    const selectable = opts && "selectable" in opts ? !!opts.selectable : true;
    if (selectable) btn.dataset.offset = String(a.offset);

    btn.addEventListener("click", () => {
      if (selectable && albumSelectMode) { handleAlbumTileSelect(btn, a); return; }
      (onClick || (() => openAlbum(a)))();
    });
    if (selectable) {
      // Long press ARMS selection without selecting the tile under the finger.
      // Pressing something and having it become selected is how you end up
      // with a selection you didn't ask for when you only wanted the mode.
      addLongPress(btn, () => {
        if (!albumSelectMode) enterAlbumSelectMode();
      });
    }
    return btn;
  }

  // ----- The multi-select actions menu -------------------------------------
  // One menu serves both selections: albums on a grid screen, and tracks inside
  // the album view. They can never both be live — opening the album view exits
  // album select mode — so `selMenuKind` says which one the menu is acting on
  // rather than two menus racing for the same corner of the screen.
  let selMenuKind = null;   // "albums" | "tracks" | null

  function closeSelectMenu() {
    if (!selMenu) return;
    selMenu.classList.add("hidden");
    if (selMenuBtn) selMenuBtn.setAttribute("aria-expanded", "false");
  }

  // The album view is a full-viewport modal painted OVER the top bar, so a menu
  // that lives in the top bar is invisible and untappable while an album is
  // open — selecting tracks produced ticks and no way to act on them.
  //
  // The live node is MOVED rather than duplicated. A second copy in the modal
  // would need its own listeners and its own count, and the two would drift.
  let selMenuHome = null;
  function parkSelectMenu(intoModal) {
    if (!selMenuWrap) return;
    if (intoModal) {
      const panel = modal && modal.querySelector(".modal-panel");
      if (!panel || selMenuWrap.parentNode === panel) return;
      // Remember exactly where it came from, so it goes back to the same slot
      // rather than to the end of the row.
      selMenuHome = { parent: selMenuWrap.parentNode, next: selMenuWrap.nextSibling };
      selMenuWrap.classList.add("in-modal");
      panel.appendChild(selMenuWrap);
    } else {
      if (!selMenuHome) return;
      selMenuWrap.classList.remove("in-modal");
      selMenuHome.parent.insertBefore(selMenuWrap, selMenuHome.next);
      selMenuHome = null;
    }
  }

  // Show/hide the whole control and keep its count honest. Called after every
  // change to either selection.
  function refreshSelectMenu(kind, n) {
    selMenuKind = n > 0 ? kind : null;
    if (!selMenuWrap) return;
    selMenuWrap.classList.toggle("hidden", n === 0);
    if (n === 0) { closeSelectMenu(); return; }
    if (selCount) selCount.textContent = String(n);
    const noun = kind === "tracks" ? "track" : "album";
    if (selMenuTitle) selMenuTitle.textContent = `${n} ${noun}${n === 1 ? "" : "s"} selected`;
    const addItem = selMenu && selMenu.querySelector('[data-sel-act="add"]');
    // Albums are allowed. Adding one stores its tracks, which means reading the
    // album on the Core first — see /api/user-playlists/add-albums.
    if (addItem) addItem.classList.remove("hidden");
    if (selMenuBtn) {
      selMenuBtn.setAttribute("aria-label",
        `Actions for ${n} selected ${noun}${n === 1 ? "" : "s"}`);
    }
  }

  function enterAlbumSelectMode() {
    albumSelectMode = true;
    updateAlbumActionBar();
  }

  function exitAlbumSelectMode() {
    albumSelectMode = false;
    albumSelected = [];
    if (albumActionBar) albumActionBar.classList.add("hidden");
    // Hides the whole control, not just the open dropdown — closeSelectMenu()
    // alone left a "0" badge sitting in the top bar with nothing behind it.
    refreshSelectMenu("albums", 0);
    // Document-wide, not just #album-grid: Home's carousels live outside the
    // grid and are selectable now, so a grid-scoped clear would leave ticks
    // behind on rows the user had already scrolled past.
    document.querySelectorAll(".album.is-selected")
            .forEach(b => b.classList.remove("is-selected"));
  }
  window.__exitAlbumSelectMode = exitAlbumSelectMode;

  // The bottom bar is kept as the "you are in select mode, nothing chosen yet"
  // hint — without it, long-pressing produces no visible change at all until
  // the first tap. Once something IS selected the top-bar menu carries the
  // actions, so the bar's own buttons are gone.
  function updateAlbumActionBar() {
    const n = albumSelected.length;
    if (albumActionBar) albumActionBar.classList.toggle("hidden", !albumSelectMode || n > 0);
    if (albumActionInfo) albumActionInfo.textContent = "Tap albums to select";
    refreshSelectMenu("albums", n);
  }

  function handleAlbumTileSelect(btn, a) {
    const idx = albumSelected.findIndex(x => x.offset === a.offset);
    if (idx === -1) { albumSelected.push(a); btn.classList.add("is-selected"); }
    else            { albumSelected.splice(idx, 1); btn.classList.remove("is-selected"); }
    updateAlbumActionBar();
  }

  // Builds the album tiles into the grid. Shared by the random wall and search.
  function renderAlbumGrid(albums) {
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const a of albums) frag.appendChild(buildAlbumTile(a));
    grid.appendChild(frag);
  }

  function renderAlbums(albums) {
    if (!albums.length) {
      grid.innerHTML = "";
      setBanner("No albums were returned. Is your library indexed?", true);
      return;
    }
    setBanner(null);
    renderAlbumGrid(albums);
  }

  // ----- Random albums fetch -----
  // ----- Library album count -----
  // The topbar no longer shows a persistent "N albums" readout — it crowded
  // the controls on phones. The library total now lives in Settings; the
  // topbar element is reused only for transient CONTEXT (the active filter
  // value and the labels-browser breadcrumb) and is hidden on the plain wall.
  // Set the topbar context text directly (used by the labels browser).
  function setCountText(text) {
    const el = document.getElementById("album-count");
    if (!el) return;
    el.textContent = text || "";
    // An empty label HIDES the readout rather than showing a blank one. The
    // playlist detail screens pass "" because they already print the full name
    // as a heading; the topbar copy only repeated it, truncated to fit
    // ("My Dynamic Playlist - Electroni…" above "My Dynamic Playlist -
    // Electronic 100").
    el.classList.toggle("hidden", !text);
  }
  // Topbar context label: the active filter's value (genre/tag name) with NO
  // count; hidden on the plain wall. Counts were removed from all screens.
  function updateCountReadout(filteredTotal) {
    const el = document.getElementById("album-count");
    if (!el) return;
    if (labelsActive) return;   // labels browser manages its own header text
    if (activeFilter) {
      el.textContent = activeFilter.label || activeFilter.value;   // group label (e.g. "Rock/Metal") if set
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  async function loadRandom() {
    refreshBtn.disabled = true;
    // Size the wall grid (phone-fit) and take its count in one measurement;
    // off-phone applyWallGridSizing returns null and we use computeAlbumCount.
    const wallCount = applyWallGridSizing();
    albumCount = wallCount != null ? Math.min(96, wallCount) : computeAlbumCount();
    renderSkeletons(albumCount);
    try {
      const r = await fetch(`/api/random-albums?count=${albumCount}${filterQS()}`);
      if (r.status === 503) {
        const j = await r.json().catch(() => ({}));
        setBanner(j.error || "Waiting for Roon Core. Enable this extension in Roon \u2192 Settings \u2192 Extensions.", true);
        grid.innerHTML = ""; return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      renderAlbums(j.albums || []);
      updateCountReadout(j.filtered ? j.total : null);
    } catch (e) {
      setBanner(`Couldn't load albums: ${e.message}`, true);
      grid.innerHTML = "";
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // ----- Zones -----
  async function loadZones() {
    try {
      const r = await fetch("/api/zones");
      const j = await r.json();
      zones = j.zones || [];
      const prev = localStorage.getItem("rra-zone");
      zoneSel.innerHTML = "";
      if (!zones.length) {
        const opt = document.createElement("option");
        opt.textContent = "No zones available"; opt.value = "";
        zoneSel.appendChild(opt);
        selectedZoneId = null;
        return;
      }
      for (const z of zones) {
        const opt = document.createElement("option");
        opt.value = z.zone_id; opt.textContent = z.display_name;
        zoneSel.appendChild(opt);
      }
      selectedZoneId = (prev && zones.some(z => z.zone_id === prev)) ? prev : zones[0].zone_id;
      zoneSel.value = selectedZoneId;
    } catch (e) { /* status banner handles */ }
  }
  // Styled yes/no confirm. Resolves true/false. Falls back to native confirm.
  function confirmDialog(message) {
    return new Promise((resolve) => {
      const ov  = document.getElementById("confirm-overlay");
      const msg = document.getElementById("confirm-msg");
      const yes = document.getElementById("confirm-yes");
      const no  = document.getElementById("confirm-no");
      if (!ov || !msg || !yes || !no) { resolve(window.confirm(message)); return; }
      msg.textContent = message;
      let done = false;
      const close = (val) => {
        if (done) return; done = true;
        ov.classList.add("hidden");
        yes.removeEventListener("click", onYes);
        no.removeEventListener("click", onNo);
        ov.removeEventListener("click", onBackdrop);
        resolve(val);
      };
      const onYes = () => close(true);
      const onNo  = () => close(false);
      const onBackdrop = (e) => { if (e.target.classList.contains("confirm-backdrop")) close(false); };
      yes.addEventListener("click", onYes);
      no.addEventListener("click", onNo);
      ov.addEventListener("click", onBackdrop);
      ov.classList.remove("hidden");
    });
  }

  zoneSel.addEventListener("change", async () => {
    const newZoneId  = zoneSel.value;
    const prevZoneId = selectedZoneId;

    // Switch the active zone right away — this is what play actions and the
    // mini-transport target. Changing zones no longer moves the queue on its
    // own; we ask first (and only when the old zone is actually playing).
    selectedZoneId = newZoneId;
    localStorage.setItem("rra-zone", selectedZoneId);

    if (!prevZoneId || !newZoneId || prevZoneId === newZoneId) return;

    let playing = false;
    try {
      const r = await fetch(`/api/album/now-playing?zone=${encodeURIComponent(prevZoneId)}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        playing = !!(j && j.album && j.album.title);
      }
    } catch (e) { /* treat as nothing playing */ }
    if (!playing) return;

    const nameOf = (id, fb) => (zones.find(z => z.zone_id === id) || {}).display_name || fb;
    const move = await confirmDialog(
      `Move what's playing in ${nameOf(prevZoneId, "the other zone")} to ${nameOf(newZoneId, "this zone")}?`
    );
    if (!move) return;

    try {
      const r = await fetch("/api/transfer-zone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_zone: prevZoneId, to_zone: newZoneId })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = (j.error || "").toString();
        if (msg && !/no.*(queue|playing|track)/i.test(msg)) console.warn("[zone transfer]", msg);
      }
      loadZones();
    } catch (e) {
      console.warn("[zone transfer] network error", e);
    }
  });

  // ----- Device picker (now-playing screen) -----
  // Replaces the old share button. Lists available zones and switches the
  // active zone by driving the existing topbar selector, so playback, the
  // mini-transport, and the now-playing screen all stay in sync.
  const npDeviceBtn     = document.getElementById("np-device");
  const npDevicePopover = document.getElementById("np-device-popover");
  const npDeviceList    = document.getElementById("np-device-list");

  async function renderDeviceList() {
    if (!npDeviceList) return;
    let list = zones;
    try {
      const r = await fetch("/api/zones", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.zones)) { zones = j.zones; list = j.zones; } }
    } catch (e) { /* fall back to cached zones */ }

    npDeviceList.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "np-device-empty";
      empty.textContent = "No zones available";
      npDeviceList.appendChild(empty);
      return;
    }
    for (const z of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "np-device-item" + (z.zone_id === selectedZoneId ? " is-current" : "");
      item.dataset.zone = z.zone_id;
      fillZoneRow(item, z);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        npDevicePopover.classList.add("hidden");
        npDeviceBtn.setAttribute("aria-expanded", "false");
        if (z.zone_id === selectedZoneId) return;
        zoneSel.value = z.zone_id;
        zoneSel.dispatchEvent(new Event("change"));   // reuse the existing switch flow
        if (typeof window.__refreshTransport === "function") window.__refreshTransport();
      });
      npDeviceList.appendChild(item);
    }
  }

  if (npDeviceBtn && npDevicePopover) {
    npDeviceBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const vp = document.getElementById("np-vol-popover");
      const vb = document.getElementById("np-volbtn");
      if (vp) vp.classList.add("hidden");
      if (vb) vb.setAttribute("aria-expanded", "false");
      const willShow = npDevicePopover.classList.contains("hidden");
      if (willShow) await renderDeviceList();
      npDevicePopover.classList.toggle("hidden", !willShow);
      npDeviceBtn.setAttribute("aria-expanded", String(willShow));
    });
  }

  const npGroupOpen = document.getElementById("np-group-open");
  if (npGroupOpen) {
    npGroupOpen.addEventListener("click", (e) => {
      e.stopPropagation();
      if (npDevicePopover) npDevicePopover.classList.add("hidden");
      if (npDeviceBtn) npDeviceBtn.setAttribute("aria-expanded", "false");
      openGroupSheet();
    });
  }

  const npPowerOpen = document.getElementById("np-power-open");
  if (npPowerOpen) {
    npPowerOpen.addEventListener("click", (e) => {
      e.stopPropagation();
      if (npDevicePopover) npDevicePopover.classList.add("hidden");
      if (npDeviceBtn) npDeviceBtn.setAttribute("aria-expanded", "false");
      openDevicePowerSheet();
    });
  }

  // Roon's all-zone actions, in the sheet that is already about which zones.
  // Looked up at click time rather than at wiring time: the side menu's
  // closure defines __allZoneActions, and the two run in either order.
  for (const act of ["pause-all", "mute-all", "unmute-all"]) {
    const btn = document.getElementById("np-" + act);
    if (!btn) continue;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (npDevicePopover) npDevicePopover.classList.add("hidden");
      if (npDeviceBtn) npDeviceBtn.setAttribute("aria-expanded", "false");
      const fn = window.__allZoneActions && window.__allZoneActions[act];
      if (fn) fn();
    });
  }

  // ----- Modal -----
  let currentSource = "random";
  let currentSourceZoneId = null;

  // Ambient glow layer behind the modal header — mirrors the cover image so
  // the blur always matches the art shown. Same URL as #modal-img, so the
  // browser serves it from cache (no second fetch). Pass null to hide.
  const modalAmbient = document.getElementById("modal-ambient");
  function setModalAmbient(url) {
    if (!modalAmbient) return;
    if (url) {
      // The glow is blurred anyway, so feed it a TINY cover (96px) instead of
      // the 800px big art: Safari otherwise keeps a full-size blurred layer
      // composited behind the scrolling modal body. Upscaling the small image
      // does most of the smoothing (the CSS blur radius is tuned to match).
      // Only /api/image URLs carry a size param; anything else passes through.
      modalAmbient.src = url.includes("/api/image/")
        ? url.replace(/([?&])size=\d+/, "$1size=96")
        : url;
      modalAmbient.classList.remove("hidden");
    } else {
      modalAmbient.removeAttribute("src");
      modalAmbient.classList.add("hidden");
    }
  }
  // The transport poll (separate closure) re-points the big art when the
  // playing track changes album; it uses this bridge to keep the Queue tab's
  // ambient glow on the same album.
  window.__setModalAmbient = setModalAmbient;

  function setModalArtist(subtitle, names) {
    // `names` is the server's library-validated split (/api/album `artists`):
    // it also breaks on comma/&/+/and, but only when a fragment is a known
    // library artist — so "Panda Bear, Sonic Boom & Adrian Sherwood" becomes
    // three links while "Earth, Wind & Fire" stays one. Until the detail
    // response lands (or for legacy callers) the conservative client split
    // applies: " / " is Roon's standard separator; feat/featuring/ft handle
    // featured artists; " & " and comma are NOT split here because they are
    // often part of a band name ("Simon & Garfunkel").
    //
    // The links live in their own container as modalSub's first child so the
    // late validated re-render can't wipe the year/label/score spans that
    // renderExtras appends after them. A call WITHOUT `names` is an album
    // (re)open: full reset, and the previous album's extras go with it.
    const validated = Array.isArray(names) && names.length > 0;
    let box = document.getElementById("modal-artist-names");
    if (!validated || !box) {
      modalSub.innerHTML = "";
      box = document.createElement("span");
      box.id = "modal-artist-names";
      modalSub.appendChild(box);
    }
    box.innerHTML = "";
    if (!subtitle) return;
    const parts = validated
      ? names
      : subtitle.split(/ \/ | feat\.? | featuring | ft\.? /i).map(s => s.trim()).filter(Boolean);
    // Album credits are always linkable: the credit came from a library album,
    // so at minimum that album is on the artist's screen.
    renderArtistLinks(box, parts.map(name => ({ name, linkable: true })), {
      separator: validated ? " · " : " / ",
      linkClass: "modal-artist-link",
      sepClass:  "modal-subtitle-year",
    });
  }

  // The per-artist link row, shared by the album view and the now-playing
  // screen so both behave identically — one implementation, one set of
  // listeners, one navigation rule.
  //
  // `parts` is [{ name, linkable }]. A non-linkable name renders as plain text
  // rather than a button: the library has no screen for it, and a link that
  // opens an empty page is worse than no link. The album view marks everything
  // linkable (see above); the now-playing screen doesn't, because its credit is
  // the track artist.
  function renderArtistLinks(box, parts, opts) {
    opts = opts || {};
    const sep        = opts.separator || " · ";
    const linkClass  = opts.linkClass || "modal-artist-link";
    const sepClass   = opts.sepClass  || "modal-subtitle-year";
    // Non-linkable names default to the separator's muted tone, but the
    // now-playing screen overrides it: on a compilation EVERY track artist can
    // be unlinkable, and dimming the whole line reads as a rendering fault
    // rather than as information.
    const plainClass = opts.plainClass || sepClass;
    box.innerHTML = "";
    parts.forEach((part, i) => {
      if (i > 0) {
        const s = document.createElement("span");
        s.className = sepClass;
        s.textContent = sep;
        box.appendChild(s);
      }
      if (!part.linkable) {
        const span = document.createElement("span");
        span.className = plainClass;
        span.textContent = part.name;
        box.appendChild(span);
        return;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = linkClass;
      btn.textContent = part.name;
      btn.addEventListener("click", () => {
        // Close FIRST. showArtistAlbums parks the grid/topbar/labels but knows
        // nothing about the album modal, so with the modal still open the
        // artist grid renders behind it and body scroll stays locked.
        closeModal();
        // The artist view PARKS the labels browser itself (see showArtistAlbums)
        // so its Back can restore it — tearing it down here would lose the open
        // label and leave the restored grid without its labels bar.
        window.__showArtistAlbums && window.__showArtistAlbums(part.name);
      });
      box.appendChild(btn);
    });
  }
  // The now-playing screen lives inside this modal but is rendered by the
  // transport IIFE, which has no access to closeModal or this renderer.
  window.__renderArtistLinks = renderArtistLinks;

  function openAlbum(album, opts) {
    opts = opts || {};
    // Album select mode and track select mode both drive the one top-bar menu,
    // so they must never be live together. Opening an album ends the grid
    // selection rather than leaving a count behind that the menu would then
    // act on with the wrong list.
    if (albumSelectMode) exitAlbumSelectMode();
    exitTrackSelectMode();
    currentAlbum = album;
    window.__currentAlbum = album;
    currentSource = opts.source || "random";
    currentSourceZoneId = opts.zoneId || null;
    // An explicit opts.filter (incl. null) wins over the active filter — Home
    // tiles carry full-library offsets and must resolve unfiltered even if a
    // genre filter is still active.
    currentDetailFilter = ("filter" in opts) ? opts.filter : activeFilter;

    // Persist so the modal survives a Safari reload after tapping an external link
    try {
      sessionStorage.setItem("rra-modal",
        JSON.stringify({ album, source: currentSource, zoneId: currentSourceZoneId,
                         filter: currentDetailFilter }));
    } catch (e) { /* ignore */ }

    const isNP = currentSource === "now-playing";
    resetModalScroll();   // a reopened modal must never start mid-scroll

    // Tabs visible only in now-playing mode
    const tabsEl = document.getElementById("modal-tabs");
    tabsEl.classList.toggle("hidden", !isNP);
    modal.classList.toggle("np-mode", isNP);
    showTab("album");

    modalTitle.textContent = album.title || "Untitled";
    setModalArtist(album.subtitle);
    modalActs.innerHTML    = isNP ? "" : `<div class="modal-loading">Loading…</div>`;
    modalTracks.innerHTML  = "";

    // Reset bio sections
    document.getElementById("album-bio-section").classList.add("hidden");
    document.getElementById("album-bio-toggle").classList.add("hidden");
    document.getElementById("album-bio-source").classList.add("hidden");
    document.getElementById("album-bio-text").dataset.clipped = "true";
    setModalSource(album);   // tile data may already carry it; refreshed below from the detail response
    if (album.image_key) {
      modalImg.src = `/api/image/${encodeURIComponent(album.image_key)}?size=800`;
      modalImg.style.display = "";
      setModalAmbient(modalImg.src);
    } else {
      modalImg.removeAttribute("src");
      modalImg.style.display = "none";
      setModalAmbient(null);
    }
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    if (isNP) {
      // The now-playing screen is driven live by the transport poll loop;
      // refresh it immediately from the latest zone state.
      if (typeof window.__refreshTransport === "function") window.__refreshTransport();
    } else {
      fetchAlbumDetail(album).catch(err => {
        modalActs.innerHTML = `<div class="modal-error">${escapeHtml(err.message)}</div>`;
      });
      fetchAlbumExtras(album).catch(() => { /* extras are non-critical — modal still opens */ });
    }
  }

  // Put the modal's scroller back to the top.
  //
  // .modal-body is a LONG-LIVED node — the modal is hidden and shown, never
  // rebuilt — so its scrollTop outlives everything drawn inside it. An album
  // opened after another one was scrolled halfway down therefore started
  // halfway down, and switching back from the Queue tab kept the queue's
  // offset. No caller ever wants to open a screen already scrolled.
  //
  // NOT the fix for "now playing is stretched too high above the top of the
  // screen" — that was the missing status-bar inset (style.css, np-mode
  // padding-top), and the Now playing tab is `overflow: hidden` anyway, so its
  // scrollTop cannot be anything but 0 on a phone-sized viewport.
  function resetModalScroll() {
    const body = modal ? modal.querySelector(".modal-body") : null;
    if (body) body.scrollTop = 0;
  }

  function showTab(name) {
    document.querySelectorAll(".modal-tab").forEach(b => {
      b.classList.toggle("is-active", b.dataset.tab === name);
    });
    document.getElementById("tab-album").classList.toggle("hidden", name !== "album");
    document.getElementById("tab-queue").classList.toggle("hidden", name !== "queue");

    // Track the active tab on the modal so the transport bar / now-playing
    // screen can react: bar hidden on the Now playing tab, shown on Queue.
    modal.classList.toggle("tab-album", name === "album");
    modal.classList.toggle("tab-queue", name === "queue");

    // The Roon-style now-playing block only shows on the Now playing tab while
    // in now-playing mode.
    const npScreen = document.getElementById("np-screen");
    if (npScreen) {
      npScreen.classList.toggle("hidden",
        !(name === "album" && modal.classList.contains("np-mode")));
    }
    resetModalScroll();

    if (name === "queue") loadQueue();
    if (typeof window.__refreshTransport === "function") window.__refreshTransport();
  }
  // Switching zones with the Queue tab already open has to repaint it — the
  // fix above makes the FETCH follow the live zone, but nothing was asking it
  // to fetch again, so the stale list stayed on screen until you left the tab
  // and came back.
  {
    const zs = document.getElementById("zone-select");
    if (zs) zs.addEventListener("change", () => {
      if (modal && !modal.classList.contains("hidden") && modal.classList.contains("tab-queue")) {
        loadQueue();
      }
    });
  }

  document.querySelectorAll(".modal-tab").forEach(b => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
  });

  async function fetchNowPlayingDetail(zoneId) {
    const r = await fetch(`/api/album/now-playing?zone=${encodeURIComponent(zoneId)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (j.album) {
      setModalSource(j.album);   // authoritative: the server resolved this album
      if (j.album.title)    modalTitle.textContent = j.album.title;
      if (j.album.subtitle) setModalArtist(j.album.subtitle);
      if (j.album.image_key) {
        modalImg.src = `/api/image/${encodeURIComponent(j.album.image_key)}?size=800`;
        setModalAmbient(modalImg.src);
      }
    }
    const wrap = document.querySelector(".track-list-wrap");
    if ((j.tracks || []).length) {
      wrap.classList.remove("hidden");
      modalTracks.innerHTML = "";
      for (const t of j.tracks) {
        const li = document.createElement("li");
        // Two-line rows (queue-tab style): title over the FULL artist credit,
        // stacked in a .t-text column so multi-artist tracks aren't clipped.
        const tx = document.createElement("div"); tx.className = "t-text";
        const ti = document.createElement("span"); ti.className = "t-title";
        ti.textContent = t.title || "";
        const su = document.createElement("span"); su.className = "t-sub";
        su.textContent = t.subtitle || "";
        tx.appendChild(ti); tx.appendChild(su);
        li.appendChild(tx);
        modalTracks.appendChild(li);
      }
    } else {
      wrap.classList.add("hidden");
    }
  }

  // A queue belongs to a ZONE, and the zone the user is pointed at can change
  // while this screen stays open. currentSourceZoneId is a snapshot taken in
  // openAlbum(), so reading it here showed the queue of whichever zone happened
  // to be selected when the screen was opened — switch from Sonos to WPP
  // without moving playback and you kept looking at the Sonos queue, and
  // "Play from here" acted on it too.
  //
  // The live zone selector is the single source of truth every other control
  // already follows (the transport bar and now-playing screen both read it), so
  // the queue follows it as well. The snapshot stays as a last-resort fallback
  // for the case where the selector isn't populated yet.
  function queueZoneId() {
    const sel = document.getElementById("zone-select");
    return (sel && sel.value) || selectedZoneId || currentSourceZoneId || null;
  }

  async function loadQueue() {
    const zoneId = queueZoneId();
    if (!zoneId) return;
    const summary = document.getElementById("queue-summary");
    const list    = document.getElementById("queue-list");
    const empty   = document.getElementById("queue-empty");
    summary.textContent = "Loading queue…";
    list.innerHTML = "";
    empty.classList.add("hidden");
    try {
      const r = await fetch(`/api/queue?zone=${encodeURIComponent(zoneId)}`);
      const j = await r.json();
      const items = j.items || [];
      if (!items.length) {
        summary.textContent = "";
        empty.classList.remove("hidden");
        return;
      }
      let totalSec = 0;
      for (const it of items) if (it.length) totalSec += it.length;
      summary.textContent = `${items.length} track${items.length === 1 ? "" : "s"} · ${fmtDuration(totalSec)} remaining`;

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (i === 0) {
          // Roon-style "Now playing" divider above the current track
          const div = document.createElement("li");
          div.className = "q-divider";
          div.setAttribute("aria-hidden", "true");
          div.innerHTML =
            '<span class="q-divider-line"></span>' +
            '<span class="q-divider-label">Now playing</span>' +
            '<span class="q-divider-line"></span>';
          list.appendChild(div);
        }
        const li = document.createElement("li");
        if (i === 0) li.classList.add("is-now");
        else li.classList.add("is-tappable");

        const art = document.createElement("img"); art.className = "q-art";
        if (it.image_key) art.src = `/api/image/${encodeURIComponent(it.image_key)}?size=120`;
        else art.style.visibility = "hidden";
        const tx = document.createElement("div"); tx.className = "q-text";
        const tt = document.createElement("div"); tt.className = "q-title";  tt.textContent = it.title || "";
        const ts = document.createElement("div"); ts.className = "q-sub";    ts.textContent = it.subtitle || "";
        tx.appendChild(tt); tx.appendChild(ts);
        const len = document.createElement("span"); len.className = "q-len";
        if (it.length) len.textContent = fmtDuration(it.length);
        li.appendChild(art); li.appendChild(tx); li.appendChild(len);

        if (i !== 0) {
          li.addEventListener("click", async () => {
            const trackName = it.title || "this track";
            // confirmDialog, not window.confirm: a native confirm can be left
            // open when the app is backgrounded and then resolves on reopen,
            // firing the request into a network stack that is still coming
            // back up. An in-page sheet cannot be resolved by backgrounding.
            if (!await confirmDialog(`Play from "${trackName}"?`)) return;
            const epochAtSend = hiddenEpoch;
            try {
              const r = await fetch("/api/play-from-here", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  // Re-read at click time: the rows on screen belong to
                  // queueZoneId()'s queue, so the action must target that same
                  // zone, not the one captured when the screen opened.
                  zone_or_output_id: queueZoneId(),
                  queue_item_id: it.queue_item_id
                })
              });
              if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                showToast("Couldn't play from here: " + (j.error || `HTTP ${r.status}`), "error");
                return;
              }
              // Give Roon a moment, then re-pull the queue so the "now playing"
              // marker moves and earlier-played tracks fall away.
              setTimeout(loadQueue, 600);
            } catch (e) {
              // Backgrounded mid-flight. iOS killed the connection and handed
              // us the rejection on reopen, so this is not a failure the user
              // caused or can act on — and Roon has almost certainly already
              // played the track. Re-pull the queue (the success path's own
              // follow-up never ran) and say nothing, rather than alerting
              // about a tap made minutes ago.
              if (hiddenEpoch !== epochAtSend) { loadQueue(); return; }
              showToast("Couldn't play from here: " + e.message, "error");
            }
          });
        }

        list.appendChild(li);
      }
    } catch (e) {
      summary.textContent = "Couldn't load queue: " + e.message;
    }
  }
  function fmtDuration(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    return `${m}:${String(s).padStart(2,"0")}`;
  }

  function closeModal() {
    // Track selection belongs to the album that is closing. Leaving it set
    // would arm the next album's rows with someone else's picks.
    exitTrackSelectMode();
    modal.classList.add("hidden");
    modal.classList.remove("np-mode", "tab-album", "tab-queue");
    document.body.style.overflow = "";
    currentAlbum = null;
    window.__currentAlbum = null;
    try { sessionStorage.removeItem("rra-modal"); } catch (e) {} // sessionStorage optional
    if (typeof window.__refreshTransport === "function") window.__refreshTransport();
  }
  modal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-close]")) closeModal();
  });
  // np-mode's top-left Home button (the × is hidden there): close the modal
  // and land on the Home screen, leaving any labels/artist view behind.
  const modalHomeBtn = document.getElementById("modal-home-btn");
  if (modalHomeBtn) modalHomeBtn.addEventListener("click", () => {
    closeModal();
    showHome();   // showHome resets labels/artist/search state itself
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  async function fetchAlbumDetail(album) {
    // Send the album's identity so the server can detect a stale offset
    // (library changed since the tile rendered) and relocate — or 409 —
    // instead of returning whatever album now sits at that position.
    const idQS = `&title=${encodeURIComponent(album.title || "")}` +
                 `&subtitle=${encodeURIComponent(album.subtitle || "")}`;
    const r = await fetch(`/api/album?offset=${album.offset}${idQS}${filterQSOf(currentDetailFilter)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();

    // Modal may have been closed/reopened on a different album while we
    // waited — bail rather than render album A's rows (whose tap handlers
    // would fire against album B's offset). Same guard as fetchAlbumExtras.
    if (album !== currentAlbum) return;

    // The server corrects the offset when the stale-offset defense relocated
    // the album — adopt it so Play/Queue and per-track actions use the fresh
    // position instead of re-tripping the same relocation on every call.
    if (typeof j.offset === "number" && j.offset >= 0) album.offset = j.offset;

    // Only accept server title if it matches what we expected — guards against
    // stale index offsets returning a completely different album after a library change.
    if (j.album && j.album.title) {
      const expectedNorm = currentAlbum ? (currentAlbum.title || "").toLowerCase().trim() : "";
      const returnedNorm = (j.album.title || "").toLowerCase().trim();
      if (!expectedNorm || returnedNorm === expectedNorm) {
        modalTitle.textContent = j.album.title;
      }
    }
    // Re-render the artist line with the server's library-validated split so
    // each collaborator becomes their own link (openAlbum rendered the
    // conservative client split as a placeholder).
    if (Array.isArray(j.artists) && j.artists.length) {
      setModalArtist((j.album && j.album.subtitle) || album.subtitle || "", j.artists);
    }

    // Build action buttons in preferred order
    const order  = ["play_now", "queue", "play_next", "shuffle", "radio"];
    const labels = {
      play_now:  "Play Now",
      queue:     "Queue",
      play_next: "Next",
      shuffle:   "Shuffle",
      radio:     "Radio"
    };
    const map = new Map();
    for (const a of (j.actions || [])) {
      if (!map.has(a.kind)) map.set(a.kind, a);
    }

    // Play Now and Queue stay on the row; Next / Shuffle / Radio go behind the
    // overflow menu. Five pills hit the same wall the playlist screens did —
    // .action-btn is `flex: 1 1 0`, so they shrink together instead of
    // wrapping, and on a phone the labels start clipping.
    const ROW_ACTIONS = 2;
    modalActs.innerHTML = "";
    const available = order.filter(k => map.has(k));
    let first = true;
    for (const k of available.slice(0, ROW_ACTIONS)) {
      const btn = document.createElement("button");
      btn.className = "action-btn" + (first ? " primary" : "");
      btn.type = "button";
      btn.textContent = labels[k];
      btn.addEventListener("click", () => invoke(k, btn));
      modalActs.appendChild(btn);
      first = false;
    }
    const overflow = available.slice(ROW_ACTIONS);
    if (overflow.length) {
      modalActs.appendChild(buildOverflowMenu(
        overflow.map(k => ({ label: labels[k], onClick: (b) => invoke(k, b) })),
        { label: "More playback actions" }));
    }
    if (!available.length) {
      // "No playback actions available" was true and useless — it described
      // our own empty array rather than anything the user could act on. When
      // Roon's live album count no longer matches the snapshot we can say why,
      // and that a re-check is already running.
      modalActs.innerHTML = "";
      const err = document.createElement("div");
      err.className = "modal-error";
      // BOTH branches explain themselves now. The second one — the plain
      // sentence with no explanation at all — is the red line users actually
      // reported, and it was composed here in the client, so the server-side
      // builder never touched it.
      err.textContent = "Roon offered no playback options for this album." +
                        libraryChangingAdvice(!!j.library_moved);
      modalActs.appendChild(err);
    }

    // Tracks — each row is tappable and reveals Play now / Queue for that
    // track (one open row at a time; tapping again collapses it).
    const trackWrap = document.querySelector(".track-list-wrap");
    modalTracks.innerHTML = "";
    const trackList = j.tracks || [];
    // A thin or empty answer is now distinguishable from an album that really
    // has no tracks: Roon declares how many rows the level holds, so we know
    // when it sent fewer. Previously the whole section was hidden and an album
    // mid-reindex looked identical to one with nothing on it.
    if (j.partial) {
      const note = document.createElement("div");
      note.className = "modal-error";
      note.textContent = (j.declared_tracks
        ? "Roon sent " + trackList.length + " of " + j.declared_tracks + " tracks."
        : "Roon sent an incomplete track list.") +
        libraryChangingAdvice(!!j.library_moved);
      modalActs.appendChild(note);
    }
    if (trackList.length === 0) {
      if (!j.partial && j.library_moved) {
        const note = document.createElement("div");
        note.className = "modal-error";
        note.textContent = "Roon returned no tracks for this album." +
                           libraryChangingAdvice(!!j.library_moved);
        modalActs.appendChild(note);
      }
      trackWrap.classList.add("hidden");
    } else {
      trackWrap.classList.remove("hidden");
      trackList.forEach((t, idx) => {
        const li = document.createElement("li");
        li.className = "t-row";
        // Same two-line .t-text structure as the cached render above — the
        // .t-actions row stays a SIBLING of .t-text so the is-open flex-wrap
        // still drops it onto its own full-width line.
        const tx = document.createElement("div"); tx.className = "t-text";
        const ti = document.createElement("span"); ti.className = "t-title";
        ti.textContent = t.title || "";
        const su = document.createElement("span"); su.className = "t-sub";
        su.textContent = t.subtitle || "";
        tx.appendChild(ti); tx.appendChild(su);
        li.appendChild(tx);

        // The select target, on the right. Present from the start but hidden
        // until select mode is armed, so arming it doesn't reflow every row.
        // A real element rather than a ::after: .album-art-wrap's ♪ placeholder
        // already taught us what happens when two states share one pseudo.
        // It stays a sibling BEFORE .t-actions so is-open's flex-wrap still
        // drops the action row onto its own full-width line beneath it.
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = "t-mark";
        mark.setAttribute("aria-label", "Select this track");
        mark.setAttribute("aria-pressed", "false");
        mark.addEventListener("click", (e) => {
          // Selecting must never also expand or collapse the row's actions.
          e.stopPropagation();
          toggleTrackSelected(li, t, idx);
        });
        li.appendChild(mark);

        li.addEventListener("click", (e) => {
          if (e.target.closest(".t-actions")) return;   // taps on the buttons themselves
          if (e.target.closest(".t-mark")) return;      // handled above
          // Once the mode is armed the whole row selects. Making the user hunt
          // for a small circle is the wrong ergonomics for a list you are
          // deliberately working through.
          if (trackSelectMode) { toggleTrackSelected(li, t, idx); return; }
          toggleTrackActions(li, t, idx);
        });

        // Long press ARMS selection without selecting this track — same rule
        // as the album grid.
        addLongPress(li, () => { if (!trackSelectMode) enterTrackSelectMode(); });
        modalTracks.appendChild(li);
      });
    }
  }

  // ----- Track multi-select (album view) ------------------------------------
  // Scoped to one album: every selected track shares `currentAlbum`, so the
  // album identity travels once rather than per track.
  function enterTrackSelectMode() {
    trackSelectMode = true;
    parkSelectMenu(true);
    modalTracks.classList.add("is-selecting");
    // An open action row and a selection are two different intents; leaving
    // the row expanded under a set of circles reads as both at once.
    modalTracks.querySelectorAll(".t-row.is-open").forEach(closeTrackRow);
    updateTrackSelection();
  }

  function exitTrackSelectMode() {
    trackSelectMode = false;
    trackSelected = [];
    parkSelectMenu(false);
    if (modalTracks) {
      modalTracks.classList.remove("is-selecting");
      modalTracks.querySelectorAll(".t-row.is-picked").forEach(li => {
        li.classList.remove("is-picked");
        const m = li.querySelector(".t-mark");
        if (m) m.setAttribute("aria-pressed", "false");
      });
    }
    refreshSelectMenu("tracks", 0);
  }

  function toggleTrackSelected(li, track, index) {
    const at = trackSelected.findIndex(x => x.index === index);
    if (at === -1) trackSelected.push({ index, title: track.title || "" });
    else           trackSelected.splice(at, 1);
    const on = at === -1;
    li.classList.toggle("is-picked", on);
    const m = li.querySelector(".t-mark");
    if (m) m.setAttribute("aria-pressed", String(on));
    updateTrackSelection();
  }

  function updateTrackSelection() {
    refreshSelectMenu("tracks", trackSelected.length);
  }

  // Play or queue the selected tracks, in the order they appear on the ALBUM —
  // not the order they were tapped. Someone ticking four tracks expects the
  // record's running order, not a record of their own clicking.
  //
  // These go one at a time on purpose: /api/play-track has no batch form, and
  // firing them in parallel would interleave into an arbitrary queue order.
  async function invokeTrackMulti(kind) {
    const zone = selectedZoneId;
    if (!zone) { showToast("Pick a zone first", "error"); return; }
    if (!currentAlbum) { showToast("No album open", "error"); return; }
    const picks = trackSelected.slice().sort((a, b) => a.index - b.index);
    if (!picks.length) return;

    let queued = 0, failed = 0, firstError = "";
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      if (picks.length > 3) showToast(`Adding track ${i + 1} of ${picks.length}…`);
      try {
        const r = await fetch("/api/play-track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offset: currentAlbum.offset,
            track: p.index,
            title: p.title,
            zone_or_output_id: zone,
            // Only the FIRST track honours the requested kind; the rest queue
            // behind it. Sending play_now for each would leave the last track
            // playing alone, having wiped the ones before it.
            kind: (i === 0 ? kind : "queue"),
            album_title: currentAlbum.title || "",
            album_subtitle: currentAlbum.subtitle || "",
            filter_type:   currentDetailFilter ? currentDetailFilter.type   : "",
            filter_value:  currentDetailFilter ? currentDetailFilter.value  : "",
            filter_parent: currentDetailFilter && currentDetailFilter.parent ? currentDetailFilter.parent : ""
          })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { failed++; if (!firstError) firstError = j.error || `HTTP ${r.status}`; }
        else queued++;
      } catch (e) {
        failed++;
        if (!firstError) firstError = "Couldn't reach the extension";
      }
    }

    if (!queued) {
      showToast(firstError || "Roon refused those tracks", "error", TOAST_REPORT_MS);
      return;
    }
    const verb = kind === "queue" ? "Queued" : "Playing";
    let msg = `${verb} ${queued} track${queued === 1 ? "" : "s"}`;
    if (failed) msg += ` (${failed} failed: ${firstError})`;
    showToast(msg, failed ? "error" : null, TOAST_REPORT_MS);
    exitTrackSelectMode();
  }

  // Expand/collapse the per-track action row. Only one row is open at a time.
  function closeTrackRow(li) {
    li.classList.remove("is-open");
    const row = li.querySelector(".t-actions");
    if (row) row.remove();
  }
  function toggleTrackActions(li, track, index) {
    const wasOpen = li.classList.contains("is-open");
    const open = modalTracks.querySelector("li.is-open");
    if (open) closeTrackRow(open);
    if (wasOpen) return;

    li.classList.add("is-open");
    const row = document.createElement("div");
    row.className = "t-actions";
    const mk = (label, kind, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "action-btn t-act" + (primary ? " primary" : "");
      b.textContent = label;
      b.addEventListener("click", () => invokeTrack(kind, b, track, index, li));
      return b;
    };
    row.appendChild(mk("Play now", "play_now", true));
    row.appendChild(mk("Queue", "queue", false));
    li.appendChild(row);
  }

  // Mirrors invoke() for a single track (same zone + filter handling).
  async function invokeTrack(kind, btn, track, index, li) {
    if (!currentAlbum) return;
    if (!selectedZoneId) { showToast("Pick a zone first", "error"); return; }
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      const r = await fetch("/api/play-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: currentAlbum.offset,
          track:  index,
          title:  track.title || "",
          zone_or_output_id: selectedZoneId,
          kind,
          // The album's own identity, so a drifted offset is relocated rather
          // than playing whatever record now sits at that position.
          album_title:    currentAlbum.title || "",
          album_subtitle: currentAlbum.subtitle || "",
          filter_type:   currentDetailFilter ? currentDetailFilter.type   : "",
          filter_value:  currentDetailFilter ? currentDetailFilter.value  : "",
          filter_parent: currentDetailFilter && currentDetailFilter.parent ? currentDetailFilter.parent : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`${j.action || orig}: ${track.title} → ${zoneName(selectedZoneId)}`);
      // Success — collapse the action row; the user stays on the album.
      closeTrackRow(li);
    } catch (e) {
      showToast(e.message, "error");
      btn.disabled = false; btn.textContent = orig;
    }
  }

  async function fetchAlbumExtras(album) {
    if (!album) return;
    const params = new URLSearchParams({
      title:  album.title    || "",
      artist: album.subtitle || ""
    });
    const r = await fetch(`/api/album/extras?${params}`);
    if (!r.ok) return;
    const j = await r.json();
    // Modal may have been closed/reopened while we waited; bail if so.
    if (album !== currentAlbum) return;
    renderExtras(j, album);
  }

  function renderExtras(extras, album) {
    // 1. Append year + label to subtitle line (artist button already present)
    const yearToShow = extras.year || (extras.album && extras.album.year ? String(extras.album.year) : "");
    if (yearToShow) {
      const yearSpan = document.createElement("span");
      yearSpan.className = "modal-subtitle-year";
      yearSpan.textContent = " · " + yearToShow;
      modalSub.appendChild(yearSpan);
    }
    if (extras.album && extras.album.label) {
      const sep = document.createElement("span");
      sep.className = "modal-subtitle-year";
      sep.textContent = " · ";
      modalSub.appendChild(sep);
      const labelBtn = document.createElement("button");
      labelBtn.className = "modal-artist-link";
      labelBtn.textContent = extras.album.label;
      labelBtn.addEventListener("click", () => {
        closeModal();
        if (window.__showLabelAlbums) window.__showLabelAlbums(extras.album.label);
      });
      modalSub.appendChild(labelBtn);
    }
    if (extras.album && typeof extras.album.score === "number" && !isNaN(extras.album.score)) {
      const sep = document.createElement("span");
      sep.className = "modal-subtitle-year";
      sep.textContent = " · ";
      modalSub.appendChild(sep);
      const chip = document.createElement("span");
      chip.className = "pitchfork-score";
      chip.textContent = extras.album.score % 1 === 0
        ? extras.album.score + ".0"
        : String(extras.album.score);
      modalSub.appendChild(chip);
      if (extras.album.isBestNewMusic) {
        const bnm = document.createElement("span");
        bnm.className = "bnm-badge";
        bnm.textContent = "BNM";
        modalSub.appendChild(bnm);
      }
    }

    // 2. Album bio section (description + source link; year/label now in subtitle)
    if (extras.album && (extras.album.description || (extras.album.url && extras.album.source))) {
      const section = document.getElementById("album-bio-section");
      const meta    = document.getElementById("album-meta");
      const text    = document.getElementById("album-bio-text");
      const toggle  = document.getElementById("album-bio-toggle");
      const srcLink = document.getElementById("album-bio-source");

      meta.style.display = "none";

      text.textContent = extras.album.description || "";
      text.style.display = extras.album.description ? "" : "none";

      if (extras.album.url && extras.album.source) {
        srcLink.href = extras.album.url;
        // Pitchfork review text is never shown (UK-law compliance) — the
        // link is the way to read it, so say so explicitly.
        srcLink.textContent = extras.album.source === "Pitchfork"
          ? "Read the full review on Pitchfork"
          : "View on " + extras.album.source;
        srcLink.classList.remove("hidden");
      } else {
        srcLink.classList.add("hidden");
      }

      section.classList.remove("hidden");
      if (extras.album.description) setupBioToggle(text, toggle);
      else toggle.classList.add("hidden");
    }

    // (Artist bio section removed — the album bio is enough, and the
    // artist Wikipedia lookup was prone to returning wrong articles for
    // less-famous artists.)
  }

  function setupBioToggle(textEl, toggleEl) {
    requestAnimationFrame(() => {
      textEl.dataset.clipped = "true";
      if (textEl.scrollHeight > textEl.clientHeight + 4) {
        toggleEl.classList.remove("hidden");
        toggleEl.textContent = "Show more";
        toggleEl.onclick = () => {
          const isClipped = textEl.dataset.clipped === "true";
          textEl.dataset.clipped = isClipped ? "false" : "true";
          toggleEl.textContent  = isClipped ? "Show less" : "Show more";
        };
      } else {
        toggleEl.classList.add("hidden");
      }
    });
  }
  // Shared with the artist-albums view and the Qobuz artist screen (separate
  // IIFEs) — same clamp/expand behavior everywhere a bio renders.
  window.__setupBioToggle = setupBioToggle;

  async function invoke(kind, btn) {
    if (!currentAlbum) return;
    if (!selectedZoneId) { showToast("Pick a zone first", "error"); return; }
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      const r = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: currentAlbum.offset,
          // Identity travels with the play so a stale offset is relocated
          // (or refused with a 409) server-side — never played blind.
          title:    currentAlbum.title    || "",
          subtitle: currentAlbum.subtitle || "",
          zone_or_output_id: selectedZoneId,
          kind,
          filter_type:   currentDetailFilter ? currentDetailFilter.type   : "",
          filter_value:  currentDetailFilter ? currentDetailFilter.value  : "",
          filter_parent: currentDetailFilter && currentDetailFilter.parent ? currentDetailFilter.parent : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (typeof j.offset === "number" && j.offset >= 0) currentAlbum.offset = j.offset;
      showToast(`${j.action || orig} → ${zoneName(selectedZoneId)}`);
      // Keep the album view open after playing so the user stays on the album.
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  function zoneName(id) {
    const z = zones.find(z => z.zone_id === id);
    return z ? z.display_name : "zone";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    })[c]);
  }

  // ----- Library search (instant, prefix-aware; collapsible) -----
  (function initSearch() {
    const input    = document.getElementById("search-input");
    const clear    = document.getElementById("search-clear");
    const statusEl = document.getElementById("search-status");
    const row      = document.getElementById("search-row");
    if (!input || !row) return;

    let seq           = 0;     // guards against out-of-order responses
    let abort         = null;  // in-flight fetch controller
    let debounceTimer = null;
    let retryTimer    = null;
    let extTimer      = null;  // delayed external (Qobuz/Tidal/Pitchfork) search
    let active        = false; // currently showing search results?

    function setStatus(msg) { statusEl.textContent = msg || ""; }

    // Stop searching and restore the random wall, WITHOUT touching whether the
    // bar itself is open. Used when the field is emptied (incl. the 1st X tap).
    // Search lives on the Home screen. Clearing it drops the results grid and
    // restores the Home sections (unplayed / genres) below the search box.
    function stopSearch() {
      active = false;
      seq++;                                   // invalidate any pending response
      if (abort) { try { abort.abort(); } catch (e) {} abort = null; }
      clearTimeout(retryTimer);
      clearTimeout(extTimer);
      extWrap = null; extWrapSeq = -1;         // release the rendered external sections
      setStatus("");
      setBanner(null);
      grid.innerHTML = "";
      grid.classList.add("hidden");
      const hs = document.getElementById("home-sections");
      if (hs) hs.classList.remove("hidden");
    }

    async function run(q) {
      const mySeq = ++seq;
      if (abort) { try { abort.abort(); } catch (e) {} }
      abort = new AbortController();
      clearTimeout(retryTimer);
      // Global search: the external sources (Qobuz/Tidal catalogues, Pitchfork
      // reviews) ride a LONGER debounce than the instant local-index search —
      // they're network calls against rate-limit-sensitive APIs. Scheduled
      // before the library fetch so external results appear even when the
      // library search errors or has zero matches.
      clearTimeout(extTimer);
      extTimer = setTimeout(() => runExternal(q, mySeq), 600);
      extAllowBannerClear = false;
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=60`,
                              { signal: abort.signal, cache: "no-store" });
        if (mySeq !== seq) return;                       // superseded by a newer keystroke
        // Library-search failures clear the grid: leaving the PREVIOUS query's
        // results would let this query's external sections append beneath them
        // (a mixed-query page). The banner/status explains what's missing, and
        // extAllowBannerClear stays false so arriving externals can't wipe it.
        if (r.status === 503) { grid.innerHTML = ""; extReappend(mySeq); setBanner("Waiting for Roon Core…", true); return; }
        if (!r.ok) { grid.innerHTML = ""; extReappend(mySeq); setStatus("search error"); return; }
        const j = await r.json();
        if (mySeq !== seq) return;

        if (j.building) {
          // First-time index build still running — show progress and retry.
          const pct = Math.round((j.progress || 0) * 100);
          setStatus(`Building index… ${pct}%`);
          grid.innerHTML = "";
          extReappend(mySeq);
          retryTimer = setTimeout(() => {
            if (active && input.value.trim() === q) run(q);
          }, 350);
          return;
        }

        const results = j.results || [];
        const labels  = j.labels  || [];
        const artists = j.artists || [];
        if (!results.length && !labels.length && !artists.length) {
          grid.innerHTML = "";
          setStatus("");
          // Externals can still match \u2014 if some already landed, keep them and
          // skip the banner; otherwise show it and let a later external
          // arrival clear it (extAllowBannerClear).
          extAllowBannerClear = true;
          if (!extReappend(mySeq)) setBanner(`No matches for \u201C${q}\u201D.`, false);
          return;
        }
        setBanner(null);
        const more = results.length >= 60 ? "+" : "";
        const parts = [];
        if (artists.length) parts.push(`${artists.length} artist${artists.length === 1 ? "" : "s"}`);
        if (labels.length)  parts.push(`${labels.length} label${labels.length === 1 ? "" : "s"}`);
        if (results.length) parts.push(`${results.length}${more} album${results.length === 1 ? "" : "s"}`);
        setStatus(parts.join(", "));

        grid.innerHTML = "";
        const frag = document.createDocumentFragment();

        // Artists section
        if (artists.length) {
          const hdr = document.createElement("div"); hdr.className = "search-section-header"; hdr.textContent = "Artists";
          frag.appendChild(hdr);
          const row = document.createElement("div"); row.className = "search-chip-row";
          for (const ar of artists) {
            const btn = document.createElement("button"); btn.className = "search-chip";
            btn.textContent = ar.name;
            btn.addEventListener("click", () => {
              stopSearch();
              window.__showArtistAlbums && window.__showArtistAlbums(ar.name);
            });
            row.appendChild(btn);
          }
          frag.appendChild(row);
        }

        // Labels section
        if (labels.length) {
          const hdr = document.createElement("div"); hdr.className = "search-section-header"; hdr.textContent = "Labels";
          frag.appendChild(hdr);
          const row = document.createElement("div"); row.className = "search-chip-row";
          for (const lb of labels) {
            const btn = document.createElement("button"); btn.className = "search-chip";
            btn.textContent = lb.display;
            btn.addEventListener("click", () => {
              stopSearch();
              if (window.__exitLabels) window.__exitLabels();
              if (window.__showLabelAlbums) window.__showLabelAlbums(lb.display);
            });
            row.appendChild(btn);
          }
          frag.appendChild(row);
        }

        // Albums section
        if (results.length) {
          if (artists.length || labels.length) {
            const hdr = document.createElement("div"); hdr.className = "search-section-header"; hdr.textContent = "Albums";
            frag.appendChild(hdr);
          }
          for (const a of results) frag.appendChild(buildAlbumTile(a));
        }

        grid.appendChild(frag);
        // A slow library response can land AFTER this query's external sections
        // rendered — the innerHTML reset above destroyed them, so re-attach.
        extReappend(mySeq);
      } catch (e) {
        if (e && e.name === "AbortError") return;        // expected when typing fast
        if (mySeq === seq) setStatus("search error");
      }
    }

    // ---- Global search: external sources (Qobuz / Tidal / Pitchfork) ----
    // Best-effort and additive: sections are appended below the library results
    // when they arrive; any failure just means that section doesn't appear.
    // All sections live in ONE wrapper (display:contents, so the grid lays out
    // its children directly) — run(q)'s innerHTML resets would otherwise
    // destroy already-rendered externals; extReappend re-attaches the wrapper.
    let extWrap = null;              // rendered external sections for extWrapSeq
    let extWrapSeq = -1;
    let extAllowBannerClear = false; // only the "No matches" banner may be cleared

    function extReappend(mySeq) {
      if (extWrapSeq !== mySeq || !extWrap || !extWrap.childNodes.length) return false;
      grid.appendChild(extWrap);     // appendChild MOVES it if already attached
      return true;
    }

    async function runExternal(q, mySeq) {
      try {
        const r = await fetch(`/api/search/external?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        if (mySeq !== seq || !r.ok) return;
        const j = await r.json();
        if (mySeq !== seq) return;
        const wrap = document.createElement("div");
        wrap.className = "ext-search-wrap";
        let added = 0;
        added += extServiceSection(wrap, "Qobuz", j.qobuz, "qobuz-toggle", "qobuz-search-input");
        added += extServiceSection(wrap, "Tidal", j.tidal, "tidal-toggle", "tidal-search-input");
        added += extPitchforkSection(wrap, j.pitchfork);
        if (!added) return;
        extWrap = wrap;
        extWrapSeq = mySeq;
        // Externals may arrive while a "No matches for X" banner shows —
        // clear THAT banner (there are matches after all), but never the
        // Roon-disconnect/error banners, which explain the missing library rows.
        if (extAllowBannerClear) setBanner(null);
        grid.appendChild(wrap);
      } catch (e) { /* best-effort — external sections just don't appear */ }
    }

    function extHeader(frag, label) {
      const hdr = document.createElement("div");
      hdr.className = "search-section-header";
      hdr.textContent = label;
      frag.appendChild(hdr);
    }

    function extRow(cover, title, sub, onClick) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ext-search-row";
      const img = document.createElement("img");
      img.className = "ext-search-art"; img.loading = "lazy"; img.alt = "";
      if (cover) {
        img.src = cover;
        // Dead cover URL → blank placeholder box, not the broken-image glyph.
        img.addEventListener("error", () => { img.removeAttribute("src"); img.style.visibility = "hidden"; });
      } else {
        img.style.visibility = "hidden";
      }
      const tx = document.createElement("div"); tx.className = "ext-search-meta";
      const t  = document.createElement("div"); t.className = "ext-search-title"; t.textContent = title;
      const s  = document.createElement("div"); s.className = "ext-search-sub";   s.textContent = sub || "";
      tx.appendChild(t); tx.appendChild(s);
      btn.appendChild(img); btn.appendChild(tx);
      btn.addEventListener("click", onClick);
      return btn;
    }

    // Qobuz/Tidal section: tapping a result opens that service's browser seeded
    // with a search for the album (same hand-off the Pitchfork detail uses) —
    // favourite it there to make it appear in Roon.
    function extServiceSection(frag, label, albums, toggleId, inputId) {
      if (!albums || !albums.length) return 0;
      extHeader(frag, label);
      for (const a of albums) {
        frag.appendChild(extRow(a.image, a.title, a.artist, () => {
          stopSearch();
          const t = document.getElementById(toggleId);
          if (!t) return;
          t.click();
          const si = document.getElementById(inputId);
          const seedQ = ((a.artist || "") + " " + (a.title || "")).trim();
          if (si && seedQ) { si.value = seedQ; si.dispatchEvent(new Event("input", { bubbles: true })); }
        }));
      }
      return albums.length;
    }

    // Pitchfork section: tapping a review deep-links to its detail view.
    function extPitchforkSection(frag, items) {
      if (!items || !items.length) return 0;
      extHeader(frag, "Pitchfork reviews");
      for (const it of items) {
        const row = extRow(it.cover, it.album, it.artist, () => {
          stopSearch();
          if (window.__openPitchforkReview) window.__openPitchforkReview(it);
        });
        if (it.score != null) {
          const sc = document.createElement("span");
          sc.className = "ext-search-score" + (it.isBestNewMusic ? " is-bnm" : "");
          sc.textContent = Number(it.score).toFixed(1);
          row.appendChild(sc);
        }
        frag.appendChild(row);
      }
      return items.length;
    }

    function onInput() {
      const q = input.value.trim();
      clearTimeout(debounceTimer);
      if (!q) { stopSearch(); return; }                  // emptied: back to Home sections
      if (window.__exitLabels) window.__exitLabels();    // leave the label browser
      exitAlbumSelectMode();
      active = true;
      // Show the results grid in place of the Home sections (the search box
      // above it stays put).
      const hs = document.getElementById("home-sections");
      if (hs) hs.classList.add("hidden");
      grid.classList.remove("hidden");
      // Small debounce: long enough to coalesce a fast burst, short enough to
      // still feel instant.
      debounceTimer = setTimeout(() => run(q), 120);
    }

    input.addEventListener("input",  onInput);
    input.addEventListener("search", onInput);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearch();
    });

    // The X clears the text and keeps the field open, so a retype needs no
    // second tap on the glass. Closing is the tap-away gesture.
    clear.addEventListener("click", () => {
      input.value = "";
      stopSearch();
      input.focus();
    });

    // ---- Open / close --------------------------------------------------
    //
    // The field is no longer permanently in the top bar: the glass is the
    // resting state and the field opens from it. This follows the overflow
    // menu's pattern exactly (module-level "what is open", stopPropagation on
    // the trigger, a `closest()` containment test on the document) rather than
    // inventing a second idiom for the same gesture.
    //
    // Closing always CLEARS. A field that reopens holding last week's query,
    // with the results gone, is a worse state than an empty one.
    const openBtn = document.getElementById("search-open");

    const searchWrap = document.getElementById("topbar-search");
    function openSearch() {
      row.classList.add("open");
      if (searchWrap) searchWrap.classList.add("is-open");
      if (openBtn) {
        openBtn.classList.add("hidden");
        openBtn.setAttribute("aria-expanded", "true");
      }
      input.focus();
    }
    function closeSearch() {
      if (!row.classList.contains("open")) return;
      input.value = "";
      stopSearch();
      input.blur();
      row.classList.remove("open");
      if (searchWrap) searchWrap.classList.remove("is-open");
      if (openBtn) {
        openBtn.classList.remove("hidden");
        openBtn.setAttribute("aria-expanded", "false");
      }
    }

    if (openBtn) {
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();   // must not reach the document listener below
        openSearch();
      });
    }
    // Tap anywhere outside the search container closes it. `closest()` on the
    // container, not `contains()` on the input, so a tap on the X or the
    // status text is inside rather than a dismissal.
    document.addEventListener("click", (e) => {
      if (!row.classList.contains("open")) return;
      if (e.target.closest && e.target.closest("#topbar-search")) return;
      closeSearch();
    });

    // Seed and open in one step. Used by anything that wants to hand the user
    // a started search rather than an empty box.
    window.__runSearch = (q) => { openSearch(); input.value = q; onInput(); };
    // Called when leaving Home for the wall/labels so stale search results
    // don't linger in the shared grid. Closes the field too: the glass is the
    // resting state, and every one of these call sites is a navigation away
    // from Home.
    window.__clearSearchIfActive = () => {
      if (active) { input.value = ""; stopSearch(); }
      closeSearch();
    };
    window.__searchActive = () => active;
  })();

  // ----- Boot -----
  refreshBtn.addEventListener("click", loadRandom);

  // ----- Filter sheet (All / Genre / Tag) -----
  (() => {
    const overlay      = document.getElementById("filter-overlay");
    const toggleBtn    = document.getElementById("filter-toggle");
    const allBtn       = document.getElementById("filter-all");
    const allCheck     = overlay && overlay.querySelector('.filter-check[data-for="all"]');
    const genresToggle = document.getElementById("filter-genres-toggle");
    const genresList   = document.getElementById("filter-genres-list");
    const tagsToggle   = document.getElementById("filter-tags-toggle");
    const tagsList     = document.getElementById("filter-tags-list");
    const decadesToggle = document.getElementById("filter-decades-toggle");
    const decadesList   = document.getElementById("filter-decades-list");
    if (!overlay || !toggleBtn) return;

    function markActive() {
      toggleBtn.classList.toggle("is-active", !!activeFilter);
      if (allCheck) allCheck.classList.toggle("hidden", !!activeFilter);
      for (const el of overlay.querySelectorAll(".filter-item")) {
        const t = el.dataset.ftype, v = el.dataset.fvalue;
        el.classList.toggle("is-current",
          !!activeFilter && activeFilter.type === t && activeFilter.value === v);
      }
    }

    function applyFilter(f) {
      activeFilter = f;
      try {
        if (f) localStorage.setItem("rra-filter", JSON.stringify(f));
        else   localStorage.removeItem("rra-filter");
      } catch (e) {} // localStorage optional (private browsing)
      if (window.__exitLabels) window.__exitLabels();
      markActive();
      close();
      if (window.__showWall) window.__showWall();   // reveal the album grid (leave Home)
      updateCountReadout(null);
      loadRandom();
    }
    window.__applyFilter = applyFilter;   // used by the Home "Browse by genre" cards

    function renderList(container, type, rows) {
      container.innerHTML = "";
      if (!rows.length) {
        const d = document.createElement("div");
        d.className = "filter-empty";
        d.textContent = type === "genre" ? "No genres found"
                      : (type === "tag" ? "No tags found"
                      : "No decades yet — release years fill in as the label scan runs.");
        container.appendChild(d);
        return;
      }
      for (const row of rows) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "filter-item";
        b.dataset.ftype = type;
        b.dataset.fvalue = row.title;
        const t = document.createElement("span");
        t.className = "filter-item-title";
        t.textContent = row.title;
        b.appendChild(t);
        if (row.subtitle) {
          const sub = document.createElement("span");
          sub.className = "filter-item-sub";
          sub.textContent = row.subtitle;
          b.appendChild(sub);
        }
        b.addEventListener("click", () => applyFilter({ type, value: row.title }));
        container.appendChild(b);
      }
      markActive();
    }

    const loaded = { genre: false, tag: false, decade: false };
    async function ensureList(type) {
      if (loaded[type]) return;
      const container = type === "genre" ? genresList : (type === "tag" ? tagsList : decadesList);
      container.innerHTML = '<div class="filter-empty">Loading\u2026</div>';
      try {
        const url = type === "genre" ? "/api/filters/genres"
                  : (type === "tag" ? "/api/filters/tags" : "/api/filters/decades");
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        const rows = type === "genre" ? j.genres : (type === "tag" ? j.tags : j.decades);
        renderList(container, type, rows || []);
        loaded[type] = true;
      } catch (e) {
        container.innerHTML = "";
        const d = document.createElement("div");
        d.className = "filter-empty";
        d.textContent = "Couldn't load: " + e.message;
        container.appendChild(d);
      }
    }

    function wireSection(toggle, list, type) {
      toggle.addEventListener("click", async () => {
        const willOpen = list.classList.contains("hidden");
        list.classList.toggle("hidden", !willOpen);
        toggle.setAttribute("aria-expanded", String(willOpen));
        toggle.classList.toggle("is-open", willOpen);
        if (willOpen) await ensureList(type);
      });
    }
    wireSection(genresToggle, genresList, "genre");
    wireSection(tagsToggle,   tagsList,   "tag");
    wireSection(decadesToggle, decadesList, "decade");

    function open()  { overlay.classList.remove("hidden"); markActive(); }
    function close() { overlay.classList.add("hidden"); }

    toggleBtn.addEventListener("click", open);
    allBtn.addEventListener("click", () => applyFilter(null));
    overlay.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("[data-filter-close]")) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
    });

    markActive();
  })();

  // ----- Labels browser (record labels → their albums) -----
  // Tapping the tag button shows every record label as a grid tile
  // (alphabetical). Tapping a label shows its albums — alphabetical by
  // default, or shuffled per the "Label album order" setting. Each album
  // opens carrying a { type:"label" } filter so detail + play resolve the
  // offset against that label's album list (reusing all existing machinery).
  (() => {
    const labelsBtn          = document.getElementById("labels-toggle");
    const labelsBar          = document.getElementById("labels-bar");
    const labelsBack         = document.getElementById("labels-back");
    const labelsTitle        = document.getElementById("labels-title");
    const labelMergeBar      = document.getElementById("label-merge-bar");
    const labelMergeInfo     = document.getElementById("label-merge-info");
    const labelMergeBtn      = document.getElementById("label-merge-btn");
    const labelMergeCancelBtn = document.getElementById("label-merge-cancel-btn");
    const labelUnmergeSheet  = document.getElementById("label-unmerge-sheet");
    const labelUnmergeName   = document.getElementById("label-unmerge-name");
    const labelUnmergeList   = document.getElementById("label-unmerge-list");
    const labelUnmergeClose  = document.getElementById("label-unmerge-close");
    const labelsLogoBtn      = document.getElementById("labels-logo-btn");
    const logoUrlSheet       = document.getElementById("logo-url-sheet");
    const logoCandidatesEl   = document.getElementById("logo-candidates");
    const logoUrlInput       = document.getElementById("logo-url-input");
    const logoUrlSave        = document.getElementById("logo-url-save");
    const logoUrlCancel      = document.getElementById("logo-url-cancel");
    if (!labelsBtn) return;

    let currentLabelName = null;
    let currentLabelLogoUrl = null; // set when showLabelAlbums loads — used by logo picker
    let _labelsScrollSaved = 0;    // restores position when returning from a label's album view
    let _labelsScrollTarget = null; // label name to scroll into view when arriving via a deep-link (album/search)
    const mainEl = document.querySelector("main");

    const TAG_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>' +
      '<line x1="7" y1="7" x2="7.01" y2="7"/></svg>';

    let mode = null;           // null | "list" | "albums"
    let _lastLabelCount = -1;  // track last rendered count to avoid flicker on re-poll
    let labelsSelectMode = false;
    let labelsSelected   = [];  // [{key, display, mergedFrom}] — first item is merge target

    function labelOrder() {
      return localStorage.getItem("rra-label-order") === "random" ? "random" : "alpha";
    }
    function labelMin() {
      const v = parseInt(localStorage.getItem("rra-label-min") || "1", 10);
      return Number.isFinite(v) && v > 0 ? v : 1;
    }

    function enterLabelSelectMode() {
      labelsSelectMode = true;
      if (labelMergeBar) { labelMergeBar.classList.remove("hidden"); updateMergeBar(); }
    }

    function exitLabelSelectMode() {
      labelsSelectMode = false;
      labelsSelected = [];
      if (labelMergeBar) labelMergeBar.classList.add("hidden");
      grid.querySelectorAll(".album.label-tile.is-selected,.album.label-tile.is-first-selected")
        .forEach(b => b.classList.remove("is-selected", "is-first-selected"));
    }

    function updateMergeBar() {
      if (!labelMergeInfo || !labelMergeBtn) return;
      const n = labelsSelected.length;
      while (labelMergeInfo.firstChild) labelMergeInfo.removeChild(labelMergeInfo.firstChild);
      if (n === 0) {
        labelMergeInfo.textContent = "Tap labels to select";
        labelMergeBtn.textContent = "Merge";
        labelMergeBtn.disabled = true;
      } else if (n === 1) {
        const s = document.createElement("strong"); s.textContent = labelsSelected[0].display;
        labelMergeInfo.appendChild(s);
        labelMergeInfo.appendChild(document.createTextNode(" — select more to merge"));
        labelMergeBtn.textContent = "Merge";
        labelMergeBtn.disabled = true;
      } else {
        labelMergeInfo.appendChild(document.createTextNode("Merge " + n + " into "));
        const s = document.createElement("strong"); s.textContent = labelsSelected[0].display;
        labelMergeInfo.appendChild(s);
        labelMergeBtn.textContent = "Merge";
        labelMergeBtn.disabled = false;
      }
    }

    function handleLabelTileSelect(btn, lb) {
      const idx = labelsSelected.findIndex(s => s.key === lb.key);
      if (idx >= 0) {
        labelsSelected.splice(idx, 1);
        btn.classList.remove("is-selected", "is-first-selected");
      } else {
        labelsSelected.push({ key: lb.key, display: lb.title, mergedFrom: lb.mergedFrom || [] });
        btn.classList.add("is-selected");
      }
      // Re-apply first-selected only to the first item in the array.
      grid.querySelectorAll(".album.label-tile").forEach(b => b.classList.remove("is-first-selected"));
      if (labelsSelected.length > 0) {
        const fk = labelsSelected[0].key;
        const fb = grid.querySelector(`.album.label-tile[data-label-key="${CSS.escape(fk)}"]`);
        if (fb) fb.classList.add("is-first-selected");
      }
      updateMergeBar();
    }

    function showUnmergeSheet(targetDisplay, sources) {
      if (!labelUnmergeSheet || !labelUnmergeName || !labelUnmergeList) return;
      labelUnmergeName.textContent = targetDisplay;
      labelUnmergeList.innerHTML = "";
      for (const src of sources) {
        const row = document.createElement("div");
        row.className = "label-unmerge-row";
        const nameEl = document.createElement("span");
        nameEl.className = "label-unmerge-source";
        nameEl.textContent = src.display;
        const xBtn = document.createElement("button");
        xBtn.type = "button";
        xBtn.className = "icon-btn label-unmerge-remove";
        xBtn.setAttribute("aria-label", "Remove " + src.display);
        xBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        xBtn.addEventListener("click", async () => {
          xBtn.disabled = true;
          try {
            const r = await fetch("/api/labels/merge/" + encodeURIComponent(src.key), { method: "DELETE" });
            if (!r.ok) throw new Error((await r.json()).error || "Failed");
            row.remove();
            if (!labelUnmergeList.children.length) labelUnmergeSheet.classList.add("hidden");
            _lastLabelCount = -1;
            showLabelsList(false);
          } catch(e) {
            xBtn.disabled = false;
            if (window.__showToast) window.__showToast("Unmerge failed: " + e.message, "error");
          }
        });
        row.appendChild(nameEl);
        row.appendChild(xBtn);
        labelUnmergeList.appendChild(row);
      }
      labelUnmergeSheet.classList.remove("hidden");
    }

    function exitLabels() {
      mode = null;
      labelsActive = false;
      _lastLabelCount = -1;
      labelsBtn.classList.remove("is-active");
      if (labelsBar) labelsBar.classList.add("hidden");
      closeLabelLogoSheet();
      exitLabelSelectMode();
      exitAlbumSelectMode();
      updateScanBar(null);
      if (labelUnmergeSheet) labelUnmergeSheet.classList.add("hidden");
    }
    window.__exitLabels       = exitLabels;
    window.__showLabelAlbums  = showLabelAlbums;

    // Park / unpark for views that BORROW the shared grid and hand it back
    // (the artist view). exitLabels() is a real teardown — it forgets which
    // label was open, so Back would land on a label grid the browser no longer
    // believes it owns (no labels bar, no way back to the list). Parking hides
    // the chrome and closes the sheets but remembers the mode/label, so the
    // artist view's Back restores the labels browser whole.
    function parkLabels() {
      if (!labelsActive) return null;
      const state = {
        mode,
        currentLabelName,
        currentLabelLogoUrl,
        barHidden: labelsBar ? labelsBar.classList.contains("hidden") : true
      };
      closeLabelLogoSheet();
      exitLabelSelectMode();
      exitAlbumSelectMode();
      if (labelUnmergeSheet) labelUnmergeSheet.classList.add("hidden");
      if (labelsBar) labelsBar.classList.add("hidden");
      labelsBtn.classList.remove("is-active");
      // Stops the list re-poll (guarded on mode === "list") from repainting
      // label tiles over the borrowing view.
      mode = null;
      labelsActive = false;
      return state;
    }
    function unparkLabels(state) {
      if (!state) return;
      mode                = state.mode;
      currentLabelName    = state.currentLabelName;
      currentLabelLogoUrl = state.currentLabelLogoUrl;
      labelsActive        = true;
      labelsBtn.classList.add("is-active");
      if (labelsBar) labelsBar.classList.toggle("hidden", state.barHidden);
    }
    window.__parkLabels   = parkLabels;
    window.__unparkLabels = unparkLabels;

    // ----- Logo picker sheet -----

    async function saveLogo(url) {
      if (!currentLabelName) return;
      try {
        const r = await fetch("/api/labels/logo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: currentLabelName, url })
        });
        const j = await r.json();
        if (j.ok) {
          currentLabelLogoUrl = j.storedUrl || url; // keep current URL in sync with what the server persisted
          closeLabelLogoSheet();
          showToast("Logo saved", "ok");
        } else {
          showToast(j.error || "Failed to save logo", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      }
    }

    async function loadLogoCandidates(labelName) {
      if (!logoCandidatesEl) return;
      logoCandidatesEl.innerHTML = '<span class="logo-candidates-hint">Searching Discogs…</span>';
      try {
        const r = await fetch("/api/labels/logo-candidates?label=" + encodeURIComponent(labelName));
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        const candidates = (j && j.candidates) || [];
        logoCandidatesEl.innerHTML = "";
        if (!candidates.length) {
          logoCandidatesEl.innerHTML = '<span class="logo-candidates-hint">No logos found on Discogs</span>';
          return;
        }
        for (const c of candidates) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "logo-candidate-btn";
          btn.title = c.title || "";
          const img = document.createElement("img");
          img.src = c.img;
          img.alt = c.title || "";
          img.loading = "lazy";
          img.onerror = () => btn.remove();
          btn.appendChild(img);
          btn.addEventListener("click", () => saveLogo(c.img));
          logoCandidatesEl.appendChild(btn);
        }
      } catch (e) {
        logoCandidatesEl.innerHTML = '<span class="logo-candidates-hint">' + (e.message || "Discogs search failed") + '</span>';
      }
    }

    if (labelsLogoBtn) {
      labelsLogoBtn.addEventListener("click", () => {
        if (!logoUrlSheet) return;
        const opening = logoUrlSheet.classList.contains("hidden");
        logoUrlSheet.classList.toggle("hidden");
        if (opening) {
          loadLogoCandidates(currentLabelName || "");
          if (logoUrlInput) {
            if (currentLabelLogoUrl) logoUrlInput.value = currentLabelLogoUrl; // pre-fill existing logo URL
            logoUrlInput.focus();
          }
        }
      });
    }
    if (logoUrlCancel) {
      logoUrlCancel.addEventListener("click", closeLabelLogoSheet);
    }
    if (logoUrlSave) {
      logoUrlSave.addEventListener("click", async () => {
        const url = logoUrlInput ? logoUrlInput.value.trim() : "";
        if (!url || !currentLabelName) return;
        logoUrlSave.disabled = true;
        try {
          await saveLogo(url);
        } finally {
          logoUrlSave.disabled = false;
        }
      });
    }

    function makeScanLogLink() {
      const wrap = document.createElement("div");
      wrap.className = "scan-log-link";
      wrap.style.cssText = "text-align:center;margin:8px 0 4px;font-size:0.8em;opacity:0.7;";
      const a = document.createElement("a");
      a.href = "/api/labels-scan-log";
      a.download = "labels-scan.log";
      a.textContent = "Download scan log";
      a.style.cssText = "color:inherit;text-decoration:underline;cursor:pointer;margin-right:12px;";
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy log";
      copyBtn.style.cssText = "background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;padding:0;";
      copyBtn.addEventListener("click", async () => {
        try {
          const r = await fetch("/api/labels-scan-log");
          const text = await r.text();
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy log"; }, 2000);
        } catch (e) { copyBtn.textContent = "Failed"; setTimeout(() => { copyBtn.textContent = "Copy log"; }, 2000); }
      });
      wrap.appendChild(a);
      wrap.appendChild(copyBtn);
      return wrap;
    }

    async function showLabelsList(isRepoll = false) {
      if (window.__leavePlaylistScreens) window.__leavePlaylistScreens();
      if (!isRepoll) {
        if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
        exitAlbumSelectMode(); closeLabelLogoSheet(); currentLabelName = null; currentLabelLogoUrl = null;
      }
      const restoreScroll = !isRepoll && _labelsScrollSaved > 0;
      mode = "list";
      labelsActive = true;
      leaveLibraryWall();   // labels own the shared grid now — stop the wall's infinite scroll
      clearWallGridSizing();   // labels grid uses its own layout, not the wall's phone-fit
      { const _hv = document.getElementById("home-view"); if (_hv) _hv.classList.add("hidden"); }
      grid.classList.remove("hidden");
      if (window.__setTopbarNav) window.__setTopbarNav(true, false, false);   // Back (to Home), no Refresh, no search
      labelsBtn.classList.add("is-active");
      if (labelsBar) labelsBar.classList.add("hidden");
      setBanner(null);
      setCountText("Labels");
      if (!isRepoll) { renderSkeletons(computeAlbumCount()); _lastLabelCount = -1; }
      try {
        const r = await fetch("/api/filters/labels");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        const minAlbums = labelMin();
        const labels = (j.labels || []).filter(lb => (lb.albumCount || 1) >= minAlbums);
        const pct = Math.round((j.progress || 0) * 100);
        if (!labels.length) {
          if (!isRepoll) grid.innerHTML = "";
          if (j.scanning) {
            const msg = pct > 0
              ? "Scanning for record labels… " + pct + "% complete."
              : "Building library index…";
            setBanner(msg, false);
            updateScanBar(j.scanning ? (j.progress || 0) : null);
            // Re-poll every 4 s while the scan is running
            setTimeout(() => { if (mode === "list") showLabelsList(true); }, 4000);
          } else {
            setBanner("No labels found yet — the background scan looks up labels via iTunes and MusicBrainz. This can take a few minutes for large libraries.", false);
            // Show a rescan button so the user can retry without restarting the server.
            const rescanBtn = document.createElement("button");
            rescanBtn.className = "action-btn primary";
            rescanBtn.style.cssText = "margin:16px auto;";
            rescanBtn.textContent = "Rescan now";
            rescanBtn.addEventListener("click", async () => {
              rescanBtn.disabled = true;
              rescanBtn.textContent = "Starting…";
              try {
                await fetch("/api/labels/rescan", { method: "POST",
                  headers: { "Content-Type": "application/json" }, body: "{}" });
                _lastLabelCount = -1;
                setTimeout(() => { if (mode === "list") showLabelsList(false); }, 1000);
              } catch (e) { rescanBtn.disabled = false; rescanBtn.textContent = "Rescan now"; }
            });
            grid.appendChild(rescanBtn);
            grid.appendChild(makeScanLogLink());
          }
          return;
        }
        setCountText("Labels");
        updateScanBar(j.scanning ? (j.progress || 0) : null);
        // Only re-render tiles on first load or when the scan finishes.
        // During an active scan, just update the count text so the grid stays
        // stable — no flash every 5 s as new labels trickle in.
        if (_lastLabelCount <= 0 || !j.scanning) {
          renderLabelTiles(labels);
          const oldLink = grid.querySelector(".scan-log-link");
          if (oldLink) oldLink.remove();
          if (!j.scanning) grid.appendChild(makeScanLogLink());
          if (_labelsScrollTarget && mainEl) {
            // Arrived via a deep-link (album view / search chip). Scroll the grid
            // to that label's tile so "back" lands on it instead of the top.
            const want = _labelsScrollTarget.trim().toLowerCase();
            _labelsScrollTarget = null;
            requestAnimationFrame(() => {
              let found = null;
              grid.querySelectorAll(".label-tile").forEach(t => {
                if (found) return;
                const tt = t.querySelector(".album-title");
                if (tt && tt.textContent.trim().toLowerCase() === want) found = t;
              });
              if (found) found.scrollIntoView({ block: "center" });
            });
          } else if (restoreScroll && mainEl) {
            requestAnimationFrame(() => { mainEl.scrollTop = _labelsScrollSaved; _labelsScrollSaved = 0; });
          }
        }
        // Keep polling while the scan is running
        if (j.scanning) {
          setTimeout(() => { if (mode === "list") showLabelsList(true); }, 5000);
        }
      } catch (e) {
        if (!isRepoll) grid.innerHTML = "";
        setBanner("Couldn't load labels: " + e.message, true);
        // Retry after 10 s so a transient network error doesn't stop updates permanently.
        setTimeout(() => { if (mode === "list") showLabelsList(true); }, 10000);
      }
    }

    function setLabelTextArt(artEl, title) {
      artEl.className = "album-art-wrap is-label-text";
      artEl.innerHTML = "";
      artEl.style.fontSize = "";
      const words = (title || "").trim().split(/\s+/).filter(Boolean);
      (words.length ? words : ["?"]).forEach(word => {
        const span = document.createElement("span");
        span.textContent = word;
        artEl.appendChild(span);
      });
    }

    function renderLabelTiles(labels) {
      if (labels.length === _lastLabelCount && !labelsSelectMode) return; // no change — skip re-render
      if (labelsSelectMode) exitLabelSelectMode(); // re-render clears tile selection state
      _lastLabelCount = labels.length;
      grid.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const lb of labels) {
        const btn = document.createElement("button");
        btn.className = "album label-tile";
        btn.type = "button";
        btn.setAttribute("aria-label", lb.title || "Label");
        btn.dataset.labelKey = lb.key || "";
        const art = document.createElement("div");
        if (lb.logo_url) {
          art.className = "album-art-wrap is-label-logo";
          const img = document.createElement("img");
          img.loading = "lazy"; img.alt = "";
          img.src = lb.logo_url;
          img.onerror = () => { img.remove(); setLabelTextArt(art, lb.title); };
          art.appendChild(img);
        } else {
          setLabelTextArt(art, lb.title);
        }
        const meta = document.createElement("div");
        meta.className = "album-meta";
        const titleEl  = document.createElement("div"); titleEl.className  = "album-title";  titleEl.textContent  = lb.title || "";
        const artistEl = document.createElement("div"); artistEl.className = "album-artist"; artistEl.textContent = lb.subtitle || "";
        meta.appendChild(titleEl);
        meta.appendChild(artistEl);
        if (lb.mergedFrom && lb.mergedFrom.length > 0) {
          const mergedEl = document.createElement("div");
          mergedEl.className = "album-merged-info";
          mergedEl.textContent = lb.mergedFrom.length + " merged";
          mergedEl.title = "Tap to manage merged labels";
          mergedEl.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!labelsSelectMode) showUnmergeSheet(lb.title, lb.mergedFrom);
          });
          meta.appendChild(mergedEl);
        }
        btn.appendChild(art);
        btn.appendChild(meta);
        btn.addEventListener("click", () => {
          if (labelsSelectMode) handleLabelTileSelect(btn, lb);
          else showLabelAlbums(lb.title, true);
        });
        addLongPress(btn, () => {
          if (!labelsSelectMode) enterLabelSelectMode();
          handleLabelTileSelect(btn, lb);
        });
        frag.appendChild(btn);
      }
      grid.appendChild(frag);
    }

    function closeLabelLogoSheet() {
      if (logoUrlSheet) logoUrlSheet.classList.add("hidden");
      if (logoUrlInput) logoUrlInput.value = "";
      if (logoCandidatesEl) logoCandidatesEl.innerHTML = "";
    }

    async function showLabelAlbums(name, fromLabelsList = false) {
      if (window.__leavePlaylistScreens) window.__leavePlaylistScreens();
      if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
      if (fromLabelsList) {
        // Came from a tap on the Labels grid — remember the grid scroll position.
        _labelsScrollSaved = mainEl ? mainEl.scrollTop : 0;
        _labelsScrollTarget = null;
      } else {
        // Deep-linked from an album view or search chip — there's no Labels-grid
        // scroll position to restore, so remember which label to scroll to on back.
        _labelsScrollSaved = 0;
        _labelsScrollTarget = name;
      }
      exitAlbumSelectMode();
      closeLabelLogoSheet();
      currentLabelName = name;
      mode = "albums";
      labelsActive = true;
      leaveLibraryWall();   // label albums own the shared grid now — stop the wall's infinite scroll
      clearWallGridSizing();   // label-album grid uses its own layout, not the wall's phone-fit
      { const _hv = document.getElementById("home-view"); if (_hv) _hv.classList.add("hidden"); }
      grid.classList.remove("hidden");
      if (window.__setTopbarNav) window.__setTopbarNav(true, false, false);   // Back (to Home), no Refresh, no search
      labelsBtn.classList.add("is-active");
      if (labelsBar)   labelsBar.classList.remove("hidden");
      if (labelsTitle) labelsTitle.textContent = name;
      setBanner(null);
      setCountText(name);
      renderSkeletons(computeAlbumCount());
      try {
        const r = await fetch("/api/label-albums?label=" + encodeURIComponent(name) +
                              "&order=" + encodeURIComponent(labelOrder()));
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        currentLabelLogoUrl = j.logo_url || null; // expose to logo picker
        const albums = j.albums || [];
        if (!albums.length) {
          grid.innerHTML = "";
          setBanner("No albums found for this label.", false);
          return;
        }
        setCountText(name);
        grid.innerHTML = "";
        const frag = document.createDocumentFragment();
        for (const a of albums) {
          // Label albums carry FULL-LIBRARY offsets; without the explicit
          // filter:null override a lingering genre/tag filter would resolve
          // them against the wrong (filtered) list — the offset misses, and
          // the stale-offset defense correctly refuses with "library changed"
          // even though nothing did. (Same override Home rows use.)
          frag.appendChild(buildAlbumTile(a, () => openAlbum(a, { filter: null })));
        }
        grid.appendChild(frag);
      } catch (e) {
        grid.innerHTML = "";
        setBanner("Couldn't load albums: " + e.message, true);
      }
    }

    if (labelsBack) labelsBack.addEventListener("click", () => showLabelsList());

    window.__exitLabelSelectMode = exitLabelSelectMode;

    if (labelMergeBtn) {
      labelMergeBtn.addEventListener("click", async () => {
        if (labelsSelected.length < 2) return;
        labelMergeBtn.disabled = true;
        try {
          const r = await fetch("/api/labels/merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: labelsSelected.map(s => ({ key: s.key, display: s.display })) })
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || "Merge failed");
          exitLabelSelectMode();
          _lastLabelCount = -1;
          showLabelsList(false);
        } catch(e) {
          labelMergeBtn.disabled = false;
          if (window.__showToast) window.__showToast("Merge failed: " + e.message, "error");
        }
      });
    }

    if (labelMergeCancelBtn) labelMergeCancelBtn.addEventListener("click", exitLabelSelectMode);

    if (labelUnmergeClose) {
      labelUnmergeClose.addEventListener("click", () => {
        if (labelUnmergeSheet) labelUnmergeSheet.classList.add("hidden");
      });
    }

    labelsBtn.addEventListener("click", () => {
      if (mode) { exitLabels(); loadRandom(); }
      else      { showLabelsList(); }
    });

    // Refresh always returns to the random wall.
    if (refreshBtn) refreshBtn.addEventListener("click", exitLabels);
  })();



  async function invokeAlbumMulti(kind) {
    if (!albumSelected.length) return;
    if (!selectedZoneId) { showToast("Pick a zone first", "error"); return; }
    try {
      const r = await fetch("/api/play-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offsets: albumSelected.map(a => a.offset),
          // Identity per album so a mid-scan stale offset is relocated or
          // refused server-side instead of queueing the wrong records.
          items: albumSelected.map(a => ({ offset: a.offset, title: a.title || "", subtitle: a.subtitle || "" })),
          zone_or_output_id: selectedZoneId,
          kind,
          filter_type:   activeFilter ? activeFilter.type   : "",
          filter_value:  activeFilter ? activeFilter.value  : "",
          filter_parent: activeFilter && activeFilter.parent ? activeFilter.parent : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // play-multi now answers 200 with counts when some albums failed, so the
      // count reported has to come from the response, not from what was asked.
      // `total` is omitted — a hand-picked selection is never capped.
      showToast(multiOutcome(kind === "play_now" ? "Playing" : "Queued",
                             j, albumSelected.length, null) +
                " → " + zoneName(selectedZoneId));
      exitAlbumSelectMode();
    } catch (e) {
      showToast(e.message, "error");
      updateAlbumActionBar();
    }
  }

  if (albumActionCancelBtn) albumActionCancelBtn.addEventListener("click", exitAlbumSelectMode);

  // ----- Select-menu wiring -------------------------------------------------
  if (selMenuBtn) {
    selMenuBtn.addEventListener("click", (e) => {
      // The document-level dismisser below would otherwise see this very click
      // and shut the menu in the same tick it opened.
      e.stopPropagation();
      const willShow = selMenu.classList.contains("hidden");
      selMenu.classList.toggle("hidden", !willShow);
      selMenuBtn.setAttribute("aria-expanded", String(willShow));
    });
  }
  if (selMenu) {
    selMenu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-sel-act]");
      if (!item) return;
      e.stopPropagation();
      closeSelectMenu();
      const act = item.dataset.selAct;
      if (act === "clear") {
        if (selMenuKind === "tracks") exitTrackSelectMode();
        else exitAlbumSelectMode();
        return;
      }
      if (act === "add") { addSelectionToPlaylist(); return; }
      if (selMenuKind === "tracks") invokeTrackMulti(act);
      else invokeAlbumMulti(act);
    });
    // Contains-checks rather than a scoped closest(): there are already four
    // document-level click listeners in this file and every popover trigger
    // stops propagation on its own button, so a shared container selector
    // would fight them.
    document.addEventListener("click", (e) => {
      if (selMenu.classList.contains("hidden")) return;
      if (selMenu.contains(e.target)) return;
      if (selMenuBtn && selMenuBtn.contains(e.target)) return;
      closeSelectMenu();
    });
  }

  window.__openAlbum = openAlbum;
  // The Home Screen settings page renders its list from these, so the row
  // vocabulary has exactly one definition (HOME_ROWS) and the settings list
  // cannot describe a row that does not exist.
  window.__homeRowTitles = () => {
    const out = {};
    for (const r of HOME_ROWS) out[r.id] = r.title;
    return out;
  };
  window.__applyHomeLayout = (rows) => {
    if (Array.isArray(rows) && rows.length) homeLayout = rows;
    applyHomeLayout();
    // A row switched back on has never been loaded this session, so give it a
    // chance to fill before the user goes looking for it.
    for (const row of HOME_ROWS) {
      if (!homeRowOn(row.id)) continue;
      if (row.isFresh()) continue;
      row.load();
    }
  };

  // Reflect the opt-in features into the side menu.
  //
  // A menu entry for a feature that is switched off leads to a screen that can
  // only ever be empty — the Labels browser with no scan behind it, Smart Picks
  // with no build. Hiding the entry is part of "off", not decoration.
  //
  // Exported because the settings pane flips these switches and the menu lives
  // elsewhere; both call this rather than reaching into each other's DOM.
  // A key absent from `state` leaves that entry alone, so one failed lookup
  // cannot hide the other feature's entry.
  window.__applyFeatureMenu = (state) => {
    const labelsItem = document.getElementById("menu-item-labels");
    const picksItem  = document.getElementById("menu-item-picks");
    if (labelsItem && typeof state.labels === "boolean") {
      labelsItem.classList.toggle("hidden", !state.labels);
      // The same switch decides whether the Library Focus vocabulary still
      // contains "Record label", and the count badge has to agree with the
      // sheet from the first paint, not from the first time it is opened.
      if (window.__setLabelsFacetAvailable) window.__setLabelsFacetAvailable(state.labels);
    }
    if (picksItem && typeof state.picks === "boolean") {
      picksItem.classList.toggle("hidden", !state.picks);
    }
  };

  // Ask at boot. Two independent calls, so an older server or a transient
  // error on one endpoint does not decide the other entry's visibility.
  async function applyFeatureMenuFromServer() {
    const state = {};
    try {
      const r = await fetch("/api/settings/labels");
      if (r.ok) state.labels = !!(await r.json()).enabled;
    } catch (e) { /* leave the Labels entry as the markup has it */ }
    try {
      const r = await fetch("/api/settings/smart-picks");
      if (r.ok) state.picks = !!(await r.json()).enabled;
    } catch (e) { /* leave the Smart Picks entry as the markup has it */ }
    window.__applyFeatureMenu(state);
  }

  window.__buildAlbumTile = (a) => buildAlbumTile(a);
  window.__loadRandom = loadRandom;
  window.__showToast = (msg, kind) => showToast(msg, kind);

  async function bootstrap() {
    // Instant open: paint the last Home from cache before we've reconnected, so
    // reopening the PWA shows content immediately instead of reloading the whole
    // screen. Skipped when a filtered wall is being restored (activeFilter), and
    // when there's nothing cached (first-ever launch) we fall back to the banner.
    // The layout is server-persisted, so it is the same on every device. Read
    // it before the first paint; on failure the table's own default order
    // stands, which is a working Home rather than a blank one.
    await loadHomeLayout();
    applyFeatureMenuFromServer();
    const painted = !activeFilter && hydrateHomeFromCache();
    if (!painted) setBanner("Connecting to Roon…");
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch("/api/status");
        const j = await r.json();
        if (j.paired) {
          setBanner(null);
          await loadZones();

          // Home is the landing view; the album wall loads lazily when the
          // user enters it (menu → Random albums / a genre / filter / labels).
          // Exception: a genre/tag filter that survived a reload (restored from
          // localStorage above) means the user was mid-browse a filtered wall —
          // land back on it instead of silently discarding the filter, which is
          // what showHome() would otherwise do on its way to an unfiltered Home.
          if (activeFilter) showWall({ loadIfEmpty: true });
          else showHome();

          // Restore the album modal if it was open
          try {
            const m = sessionStorage.getItem("rra-modal");
            if (m) {
              const parsed = JSON.parse(m);
              if (parsed && parsed.album) {
                openAlbum(parsed.album, { source: parsed.source, zoneId: parsed.zoneId,
                                         filter: parsed.filter });
              }
            }
          } catch (e) {} // corrupt sessionStorage modal state — skip restore, open normally

          setInterval(loadZones, 15000);
          return;
        }
      } catch (e) {} // /api/status fetch failed — server not ready yet, fall through to "Waiting" banner
      setBanner("Waiting for Roon Core. Open Roon → Settings → Extensions and click Enable on “Random Albums”.");
      await new Promise(r => setTimeout(r, 2000));
    }
    setBanner("Still not paired with Roon. Check that this extension is enabled in Roon → Settings → Extensions.", true);
  }
  bootstrap();
})();

/* ------------------------------------------------------------------ */
/*  Mini transport (now-playing bar at the bottom)                     */
/* ------------------------------------------------------------------ */
(() => {
  const bar       = document.getElementById("mini-transport");
  const titleEl   = document.getElementById("mt-title");
  const artistEl  = document.getElementById("mt-artist");
  const btnPP     = document.getElementById("mt-playpause");
  const btnZone   = document.getElementById("mt-zone");
  const zonePop   = document.getElementById("mt-zone-popover");
  const zoneList  = document.getElementById("mt-zone-list");
  const progFill  = document.getElementById("mt-progress-fill");
  const btnVol    = document.getElementById("mt-vol-btn");
  const iconPlay  = document.getElementById("mt-icon-play");
  const iconPause = document.getElementById("mt-icon-pause");
  const iconVol   = document.getElementById("mt-icon-vol");
  const iconMute  = document.getElementById("mt-icon-mute");
  const volPop    = document.getElementById("mt-vol-popover");
  const volSlider = document.getElementById("mt-vol-slider");
  const volVal    = document.getElementById("mt-vol-value");
  const volMinL   = document.getElementById("mt-vol-min");
  const volMaxL   = document.getElementById("mt-vol-max");
  const volWrap   = document.getElementById("mt-vol-sliderwrap");

  // The selected zone's controllable output, looked up at READ time — never a
  // mirrored global (same principle as window.__getCurrentNp below: mirrors
  // strand stale state across zone switches and early-return render paths).
  // type "incremental" means relative-only (no absolute scale): the sheets
  // hide the slider/scale and the −/+ send relative nudges.
  function currentVolOutput() {
    return (currentZone && (currentZone.outputs || []).find(o => o.volume)) || null;
  }

  // WebKit has no ::range-progress, so the accent fill left of the thumb is a
  // gradient driven by --vol-fill; keep it in sync whenever value/min/max move.
  function paintVolFill(slider) {
    if (!slider) return;
    const val = parseFloat(slider.value);
    if (!Number.isFinite(val)) return;   // empty/cleared attrs — leave the fill untouched
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max);
    const hi  = Number.isFinite(max) && max > min ? max : min + 100;
    const pct = ((val - min) / (hi - min)) * 100;
    slider.style.setProperty("--vol-fill", Math.max(0, Math.min(100, pct)) + "%");
  }

  // One writer for "both sliders + both readouts + both fills" — the mini bar
  // and the NP sheet must always show the same number for the same output.
  function syncVolumeUI(v) {
    volSlider.value = v;
    volVal.textContent = Math.round(v);
    if (npVolSlider) npVolSlider.value = v;
    if (npVolValue)  npVolValue.textContent = Math.round(v);
    paintVolFill(volSlider); paintVolFill(npVolSlider);
  }
  // The highest value this output will actually accept. soft_limit is Roon's
  // own ceiling: it has always been sent (index.js) and nothing read it, so a
  // request above it was clamped by Roon and the next poll dragged the thumb
  // back down — indistinguishable from the jitter. Applied to the slider's own
  // max as well as the −/+ buttons, or dragging could still ask for a value the
  // zone will never report back, leaving the hold waiting on an echo that can
  // never match.
  function volCeiling(v) {
    const max = v.max != null ? v.max : 100;
    return v.soft_limit != null ? Math.min(max, v.soft_limit) : max;
  }
  // Scale labels show the output's real range (0/100 for number volumes,
  // e.g. -80/0 for dB volumes) — matches what the slider actually spans.
  function paintVolScale(minEl, maxEl, v) {
    if (minEl) minEl.textContent = Math.round(v.min != null ? v.min : 0);
    if (maxEl) maxEl.textContent = Math.round(volCeiling(v));
  }

  // Now-playing screen (Roon-style) elements — shared modal, driven by the
  // same poll loop so there's a single source of truth.
  const modalEl     = document.getElementById("album-modal");
  const bigArt      = document.getElementById("modal-img");
  const npTrack     = document.getElementById("np-track");
  const npArtist    = document.getElementById("np-artist");
  const npAlbum     = document.getElementById("np-album");
  const npSeek      = document.getElementById("np-seek");
  const npCur       = document.getElementById("np-cur");
  const npTot       = document.getElementById("np-tot");
  const npPrev      = document.getElementById("np-prev");
  const npPlayPause = document.getElementById("np-playpause");
  const npNext      = document.getElementById("np-next");
  const npIconPlay  = document.getElementById("np-icon-play");
  const npIconPause = document.getElementById("np-icon-pause");
  const npVolBtn    = document.getElementById("np-volbtn");
  const npVolPopover= document.getElementById("np-vol-popover");
  const npVolFixed  = document.getElementById("np-vol-fixed");
  const npVolControls = document.getElementById("np-vol-controls");
  const npVolValue  = document.getElementById("np-vol-value");
  const npVolMinL   = document.getElementById("np-vol-min");
  const npVolMaxL   = document.getElementById("np-vol-max");
  const npVolWrap   = document.getElementById("np-vol-sliderwrap");
  const npIconVol   = document.getElementById("np-icon-vol");
  const npIconMute  = document.getElementById("np-icon-mute");
  const npVolSlider = document.getElementById("np-vol-slider");
  const npShuffle   = document.getElementById("np-shuffle");
  const npLoop      = document.getElementById("np-loop");
  const npLoopBadge = document.getElementById("np-loop-badge");
  const npRadio     = document.getElementById("np-radio");

  let currentZone = null;       // server-side zone state
  let pollTimer   = null;
  let lastNpImgKey = null;
  let userIsDraggingVolume = false;

  // The volume the user last ASKED for, held until the server echoes it back.
  //
  // The only guard used to be userIsDraggingVolume, set on the slider's `input`
  // event and cleared on `change`. The −/+ buttons never touched it, so from the
  // moment a tap painted 51 until Roon echoed 51 (a round trip, plus Roon's own
  // ~1Hz event cadence), any poll tick wrote the PRE-tap 50 straight back over
  // it: the thumb retreating after +, advancing after −. That is the reported
  // "increase it and it jumps back, vice versa".
  //
  // Held, not locked: the hold ends the moment the echo matches, and lapses on
  // its own after volEchoMs() so a change made in the Roon app or on a hardware
  // knob still reaches the slider.
  const VOL_ECHO_MS   = 2000;
  let volPending      = null;   // value written locally, not yet echoed
  let volPendingUntil = 0;      // Date.now() after which we stop believing it
  let volPendingZone  = null;   // the zone it was written to — see settleVolumeHold
  function holdVolume(v) {
    volPending = v;
    volPendingUntil = Date.now() + VOL_ECHO_MS;
    volPendingZone = currentZone && currentZone.zone_id;
  }
  function clearVolumeHold() { volPending = null; volPendingZone = null; }

  // Retire the hold when it is spent. Called ONCE per poll, from renderZone.
  //
  // Kept separate from the predicate below because two render paths ask whether
  // the volume is held (the mini bar, and the now-playing sheet), and a
  // predicate that also retires the hold means whichever happens to ask first
  // consumes it — a property neither call site can see.
  function settleVolumeHold(serverValue, stepSz) {
    if (volPending === null) return;
    // A hold belongs to the zone it was taken for. Without this, tapping + on
    // one zone and switching to another inside the window left the new zone's
    // slider showing the OLD zone's number, and the next tap stepped from it —
    // sending a wildly wrong absolute value to a zone never touched.
    if (volPendingZone !== (currentZone && currentZone.zone_id)) { clearVolumeHold(); return; }
    if (Date.now() > volPendingUntil) { clearVolumeHold(); return; }
    // Match within half a step rather than exactly: Roon quantises to the
    // output's own grid, so an exact compare never matches on a dB output and
    // the hold runs its full 2s before snapping — the very symptom it exists
    // to remove.
    const tol = Math.max(0.001, (stepSz || 0) / 2);
    if (serverValue != null && Math.abs(serverValue - volPending) < tol) clearVolumeHold();
  }
  // Pure — safe to call from any render path, in any order, any number of times.
  function volumeHeld() {
    if (userIsDraggingVolume) return true;
    if (volPending === null) return false;
    return Date.now() <= volPendingUntil;
  }

  let userIsDraggingSeek   = false;
  let npLen = 0;                // current track length (s)
  // The position is a BASE plus elapsed wall-clock, not a counter. It used to be
  // `npPos += 1` on a 1000ms interval while the 1500ms poll assigned the server's
  // value unconditionally: two unsynchronised timers writing one variable,
  // realigning every 3s, so the bar hopped forward a second, snapped back a
  // second, then caught up two. That beat IS the jerkiness. Wall-clock also
  // survives a late or throttled timer, which a counter cannot.
  // Same shape display.js has always used (seekBase / seekBaseAt).
  let npBase   = 0;             // last known position (s)
  let npBaseAt = 0;             // Date.now() when npBase was set
  let npWasPlaying = false;     // play state over the interval just elapsed
  let npSeekHold = 0;           // ignore server re-baselining until this time
  function npPlaying() {
    return !!currentZone && (currentZone.state === "playing" || currentZone.state === "loading");
  }
  // Current position: the base, plus real time since it was taken.
  function npNow() {
    const pos = npBase + (npPlaying() ? (Date.now() - npBaseAt) / 1000 : 0);
    return npLen > 0 ? Math.max(0, Math.min(npLen, pos)) : Math.max(0, pos);
  }
  function npSetBase(seconds) {
    npBase = Math.max(0, seconds || 0);
    npBaseAt = Date.now();
  }

  // Tap the album name on the now-playing screen to open that album's detail.
  // We must search the index first to find the album's offset — the now-playing
  // data alone doesn't carry it, and /api/album requires a valid numeric offset.
  if (npAlbum) {
    npAlbum.addEventListener("click", async () => {
      const np = currentZone && currentZone.now_playing;
      if (!np || typeof window.__openAlbum !== "function") return;
      const albumTitle = np.line3 || "";
      const artist     = np.line2 || "";
      if (!albumTitle) return;
      const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      try {
        const r = await fetch("/api/search?q=" + encodeURIComponent(albumTitle) + "&limit=20");
        if (r.ok) {
          const j  = await r.json();
          const rs = j.results || [];
          // Whole credited NAME agreement, not "contains the artist's first
          // word" (which opened Bonnie "Prince" Billy's album for Prince) and
          // not whole-string equality either — the now-playing line is the
          // track artist, so "Prince" must still match "Prince & The
          // Revolution". Split both sides on the credit separators and look
          // for a shared name.
          const names = (s) => (s || "")
            .split(/ \/ |\/| feat\.? | featuring | ft\.? |,| & | \+ | and /i)
            .map(x => norm(x)).filter(Boolean);
          const wanted = names(artist);
          const shares = (sub) => {
            const got = names(sub);
            return wanted.some(w => got.includes(w));
          };
          const match =
            rs.find(a => norm(a.title) === norm(albumTitle) &&
                         (!wanted.length || shares(a.subtitle))) ||
            (!wanted.length ? rs.find(a => norm(a.title) === norm(albumTitle)) : null);
          if (match && typeof match.offset === "number") {
            window.__openAlbum(match, { source: "search" }); return;
          }
        }
      } catch (e) {} // sessionStorage/JSON parse error — fall through to "not indexed" toast
      if (window.__showToast) window.__showToast("Album not yet indexed — try again in a moment");
    });
  }

  // Is the Roon-style now-playing screen currently on view?
  function onNowPlayingScreen() {
    return modalEl
      && !modalEl.classList.contains("hidden")
      && modalEl.classList.contains("np-mode")
      && modalEl.classList.contains("tab-album");
  }

  function fmtTime(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function selectedZoneId() {
    // Read from the existing zone selector in the topbar
    const sel = document.getElementById("zone-select");
    return sel && sel.value || null;
  }

  let lastTransportSig = "";
  function saveTransportState(zone) {
    if (!zone || !zone.now_playing) return;
    const np = zone.now_playing;
    // The 1.5s poll calls this every tick — synchronous localStorage writes
    // are only worth paying when the persisted fields actually changed.
    const sig = [np.line1, np.line2, np.line3, np.image_key, zone.state].join("|");
    if (sig === lastTransportSig) return;
    lastTransportSig = sig;
    try {
      localStorage.setItem("rra-transport", JSON.stringify({
        line1: np.line1 || "", line2: np.line2 || "", line3: np.line3 || "",
        image_key: np.image_key || "", state: zone.state || "stopped"
      }));
    } catch (e) {} // localStorage optional — transport bar persistence is best-effort
  }

  function restoreTransportState() {
    try {
      const saved = JSON.parse(localStorage.getItem("rra-transport") || "null");
      if (!saved || !saved.line1) return;
      titleEl.textContent  = saved.line1;
      const sub = [saved.line2, saved.line3].filter(Boolean).join(" · ");
      artistEl.textContent = sub || "—";
      bar.classList.remove("hidden");
    } catch (e) {} // corrupt localStorage — transport bar stays hidden, no action needed
  }

  async function fetchState() {
    const zid = selectedZoneId();
    if (!zid) return;  // zone not selected yet — leave bar as-is
    try {
      const r = await fetch("/api/zone-state?zone=" + encodeURIComponent(zid), { cache: "no-store" });
      if (!r.ok) return;  // server/network error — keep current state
      const j = await r.json();
      renderZone(j.zone);
      saveTransportState(j.zone);
    } catch (e) {
      // network blip — keep what we have
    }
  }

  function renderZone(zone) {
    currentZone = zone;
    const np = zone && zone.now_playing;
    if (!np) {
      npLen = 0; npSetBase(0);
      paintBarProgress();
      refreshVisibility();
      updateNpScreen();
      return;
    }

    // The static mini-bar bits (text, icons, volume) are skipped when nothing
    // changed — this runs every 1.5s, and unconditional text-node replacement
    // invalidated the fixed bar's paint on every tick even mid-scroll. The
    // seek baseline below always resyncs (it moves every tick by design).
    const volOutput = (zone.outputs || []).find(o => o.volume);
    const muted = (zone.outputs || []).some(o => o.is_muted);
    const playing = zone.state === "playing" || zone.state === "loading";
    const barSig = [np.line1, np.line2, np.line3, zone.state, muted].join("|");
    if (barSig !== lastBarSig) {
      lastBarSig = barSig;

      // Title = track, subtitle = artist · album
      titleEl.textContent  = np.line1 || "—";
      const sub = [np.line2, np.line3].filter(Boolean).join(" · ");
      artistEl.textContent = sub || "—";

      // Play/pause state
      iconPlay .classList.toggle("hidden",  playing);
      iconPause.classList.toggle("hidden", !playing);
      btnPP.setAttribute("aria-label", playing ? "Pause" : "Play");

      iconVol .classList.toggle("hidden",  muted);
      iconMute.classList.toggle("hidden", !muted);
    }

    // Volume UI — every tick, NOT barSig-gated: a zone switch can leave the
    // signature unchanged, and the sheet must never keep serving the previous
    // zone's range/type. volumeHeld() still guards the value writes.
    if (volOutput) {
      const v = volOutput.volume;
      volSlider.min   = v.min   != null ? v.min  : 0;
      volSlider.max   = volCeiling(v);
      volSlider.step  = v.step  != null ? v.step : 1;
      settleVolumeHold(v.value, v.step);   // once per poll, before either read
      if (!volumeHeld()) {
        volSlider.value = v.value != null ? v.value : 0;
        volVal.textContent = v.value != null ? Math.round(v.value) : "—";
        paintVolFill(volSlider);
      }
      paintVolScale(volMinL, volMaxL, v);
      // Relative-only (incremental) outputs have no absolute scale — the
      // sheet collapses to the −/+ nudge buttons, matching Roon.
      if (volWrap) volWrap.classList.toggle("hidden", (v.type || null) === "incremental");
      btnVol.disabled = false;
    } else {
      btnVol.disabled = true;
    }

    // Reconcile the local clock with the server — do NOT snap to it.
    //
    // What arrives here is always a little stale, by two independent amounts:
    // Roon reports whole seconds (up to 1s of quantisation) on its own ~1Hz
    // event cadence (up to another 1s of age). So the honest expectation is
    // that `srv` sits up to ~2s behind the position already painted, with the
    // two clocks advancing at the same rate thereafter. Assigning it
    // unconditionally is what produced the visible backwards jerk.
    //
    // Re-baseline only when it disagrees by more than that expected lag, which
    // means a real event: a track change, a seek from another remote, a stall.
    // The threshold is deliberately WIDER than the lag it tolerates — too tight
    // and normal staleness re-triggers the jerk this is here to remove. The
    // cost is that an external seek of under ~3s is not followed until the next
    // track change; nobody seeks by two seconds, and our own seeks are exact
    // (npSeekHold below).
    const prevLen = npLen;
    npLen = np.length || 0;
    const srv = np.seek_position != null ? np.seek_position : 0;

    const playingNow   = npPlaying();
    const stateChanged = playingNow !== npWasPlaying;

    // Carry the base forward by the interval just elapsed, using the play state
    // that was in effect FOR that interval, then restart the clock from now.
    //
    // Without this, npBaseAt kept its pre-pause timestamp across a pause and the
    // paused seconds were counted as playback on resume. A 2.5s pause left the
    // bar permanently 2.5s ahead — under the 3s threshold, so never corrected —
    // and a few short pauses accumulated past it, at which point the reconcile
    // fired and yanked the bar back by MORE than three seconds. A rarer, bigger
    // version of the jerk this whole change exists to remove.
    npSetBase(npBase + (npWasPlaying ? (Date.now() - npBaseAt) / 1000 : 0));
    npWasPlaying = playingNow;

    // A track change or a play/pause transition is unambiguous new information,
    // so both take the server's position outright — it is exact at that moment
    // and stale only by the usual fixed lag, whereas the local clock has just
    // counted up to a poll interval of the wrong state. Both bypass the seek
    // hold: gating the track change behind it meant scrubbing to the end of a
    // track — a normal way to skip on — opened the next one pinned at 100%.
    if (npLen !== prevLen || stateChanged) npSetBase(srv);
    else if (Date.now() >= npSeekHold && Math.abs(srv - npNow()) > 3) npSetBase(srv);
    paintBarProgress();

    refreshVisibility();
    updateNpScreen();
  }

  // Mini bar shows whenever something is playing, EXCEPT on the now-playing
  // screen (which has its own transport). It returns on the Queue tab.
  function refreshVisibility() {
    const hasNP = !!(currentZone && currentZone.now_playing);
    bar.classList.toggle("hidden", !hasNP || onNowPlayingScreen());
  }

  // Last-rendered signature of the mini transport bar's static content —
  // renderZone skips its DOM writes while this is unchanged.
  let lastBarSig = "";

  // Track title with any trailing "(…)" detail broken onto its own line
  // (e.g. "Hangover Sex (with Viktoria Tolstoy)" → main line + sub-line).
  let lastNpTitle = null;
  function setNpTrack(title) {
    title = title || "—";
    if (title === lastNpTitle) return;   // poll runs every 1.5s — skip rebuilds
    lastNpTitle = title;
    npTrack.textContent = "";
    const m = /^(.*\S)\s*(\([^()]*\))$/.exec(title);
    if (m) {
      npTrack.append(m[1]);
      const sub = document.createElement("div");
      sub.className = "np-track-sub";
      sub.textContent = m[2];
      npTrack.appendChild(sub);
    } else {
      npTrack.textContent = title;
    }
  }

  // The artist line, as individual links — the same control the album view
  // offers, driven by the same library-validated split (the server sends it on
  // now_playing.artists, see creditLinks).
  //
  // Signature-gated like setNpTrack: this runs on the 1.5s poll, and rebuilding
  // a row of buttons every tick would drop keyboard focus mid-press and thrash
  // the DOM behind the artwork.
  let lastNpArtistSig = null;
  function setNpArtists(np) {
    const parts = (np && Array.isArray(np.artists) && np.artists.length)
      ? np.artists
      // Older server, or a credit the server couldn't split (no library yet):
      // show the raw line as plain text rather than nothing.
      : ((np && np.line2) ? [{ name: np.line2, linkable: false }] : []);
    const sig = JSON.stringify(parts);
    if (sig === lastNpArtistSig) return;
    lastNpArtistSig = sig;
    if (!parts.length) { npArtist.textContent = ""; return; }
    if (window.__renderArtistLinks) {
      window.__renderArtistLinks(npArtist, parts, {
        separator: " · ",
        linkClass:  "np-artist-link",
        sepClass:   "np-artist-sep",
        plainClass: "np-artist-plain",
      });
    } else {
      // The modal IIFE didn't export the renderer — never expected, but the
      // artist line must still say who is playing.
      npArtist.textContent = parts.map(p => p.name).join(" · ");
    }
  }

  // Populate the Roon-style now-playing screen from the live zone state.
  function updateNpScreen() {
    // Big art + ambient glow track the playing album on BOTH np-mode tabs —
    // the Queue tab hides the art but shows the glow — so update them BEFORE
    // the tab-album gate below (onNowPlayingScreen() is false on tab-queue,
    // which would otherwise leave the glow stale across album changes).
    const np = currentZone && currentZone.now_playing;
    const npModeVisible = modalEl
      && !modalEl.classList.contains("hidden")
      && modalEl.classList.contains("np-mode");
    if (npModeVisible && bigArt && np && np.image_key && np.image_key !== lastNpImgKey) {
      bigArt.src = "/api/image/" + encodeURIComponent(np.image_key) + "?size=800";
      lastNpImgKey = np.image_key;
      // Same URL as the big art, so the browser serves it from cache.
      if (window.__setModalAmbient) window.__setModalAmbient(bigArt.src);
    }

    if (!npTrack || !onNowPlayingScreen()) return;
    // Playback modes belong to the ZONE, not to the track — a stopped zone can
    // still have shuffle on, and Roon lets you set it before pressing play.
    paintModeButtons();
    if (!np) { setNpTrack(null); setNpArtists(null); npAlbum.textContent = ""; return; }

    setNpTrack(np.line1);
    setNpArtists(np);
    npAlbum.textContent  = np.line3 || "";
    if (npAlbum) npAlbum.setAttribute("aria-label", "Open album: " + (np.line3 || ""));

    const playing = currentZone.state === "playing" || currentZone.state === "loading";
    npIconPlay .classList.toggle("hidden",  playing);
    npIconPause.classList.toggle("hidden", !playing);
    npPlayPause.setAttribute("aria-label", playing ? "Pause" : "Play");
    npPrev.disabled = !currentZone.is_previous_allowed;
    npNext.disabled = !currentZone.is_next_allowed;

    // Progress / seek (blue fill before the thumb, like Roon)
    const seekable = !!currentZone.is_seek_allowed && npLen > 0;
    npSeek.disabled = !seekable;
    // The position the fill is painted from must be the one the thumb is at.
    // A stream with no length pins the input to 0/max 100, and npNow() keeps
    // counting regardless — passing it here would paint a fill under a thumb
    // parked at zero.
    let seekPos = 0;
    if (npLen > 0) {
      npSeek.max = npLen;
      seekPos = userIsDraggingSeek ? (parseFloat(npSeek.value) || 0)
                                   : Math.min(npNow(), npLen);
      if (!userIsDraggingSeek) {
        npSeek.value = seekPos;
        npCur.textContent = fmtTime(seekPos);
      }
      npTot.textContent = fmtTime(npLen);
    } else {
      npSeek.max = 100; npSeek.value = 0;
      npCur.textContent = "0:00"; npTot.textContent = "0:00";
    }
    paintSeek(seekPos);

    // Volume — show the controls only when the endpoint has a controllable
    // volume; otherwise show "Volume control is fixed" (matches Roon).
    const volOutput = (currentZone.outputs || []).find(o => o.volume);
    if (volOutput) {
      const v = volOutput.volume;
      npVolSlider.min  = v.min  != null ? v.min  : 0;
      npVolSlider.max  = volCeiling(v);
      npVolSlider.step = v.step != null ? v.step : 1;
      if (!volumeHeld()) {
        npVolSlider.value = v.value != null ? v.value : 0;
        if (npVolValue) npVolValue.textContent = v.value != null ? Math.round(v.value) : "—";
        paintVolFill(npVolSlider);
      }
      paintVolScale(npVolMinL, npVolMaxL, v);
      if (npVolWrap) npVolWrap.classList.toggle("hidden", (v.type || null) === "incremental");
      if (npVolControls) npVolControls.classList.remove("hidden");
      if (npVolFixed) npVolFixed.classList.add("hidden");
    } else {
      if (npVolControls) npVolControls.classList.add("hidden");
      if (npVolFixed) npVolFixed.classList.remove("hidden");
    }
    const muted = (currentZone.outputs || []).some(o => o.is_muted);
    npIconVol .classList.toggle("hidden",  muted);
    npIconMute.classList.toggle("hidden", !muted);
  }

  // Thin progress line along the top of the mini bar (Roon-style).
  // `pos` is optional and follows paintSeek's convention: pass the position
  // being painted so both the line and the thumb are drawn from one number.
  function paintBarProgress(pos) {
    if (!progFill) return;
    const at = Number.isFinite(pos) ? pos
             : (userIsDraggingSeek ? (parseFloat(npSeek.value) || 0) : npNow());
    const pct = npLen > 0 ? Math.max(0, Math.min(100, (at / npLen) * 100)) : 0;
    progFill.style.width = pct.toFixed(2) + "%";
  }

  // Paint the elapsed portion of the scrubber blue (before the thumb).
  // `pos` is passed in rather than read back out of the input: the input is
  // step-quantised, so round-tripping through it threw away the sub-second part
  // and the fill could only ever move in whole-second jumps.
  function paintSeek(pos) {
    if (!npSeek) return;
    const max = parseFloat(npSeek.max) || 0;
    // Number.isFinite, not `!= null`: NaN passes a null check and would reach
    // the gradient string as "NaN%", which is invalid and drops the fill
    // entirely rather than reading zero.
    const val = Number.isFinite(pos) ? pos : (parseFloat(npSeek.value) || 0);
    const pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
    npSeek.style.setProperty("--seek-fill",
      "linear-gradient(to right, var(--accent) 0%, var(--accent) " + pct + "%, " +
      "var(--border) " + pct + "%, var(--border) 100%)");
  }

  async function seek(seconds) {
    if (!currentZone) return;
    // Believe our own seek, BEFORE the await so the caller can paint straight
    // after this returns into its first suspension. The refresh scheduled below
    // almost always arrives before Roon has applied the seek, so the pre-seek
    // position came back and yanked the bar to where it had just been — then a
    // later poll yanked it forward again. Two visible jumps for one drag.
    // Base and hold are set together, here, so a future second caller cannot
    // get one without the other and freeze the bar at a stale position.
    npSetBase(seconds);
    npSeekHold = Date.now() + 1500;   // longer than the refresh it guards
    try {
      await fetch("/api/seek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_or_output_id: currentZone.zone_id, seconds })
      });
      setTimeout(fetchState, 200);
    } catch (e) { /* seek is best-effort; fetchState() already scheduled above */ }
  }

  async function control(command) {
    if (!currentZone) return;
    try {
      const r = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_or_output_id: currentZone.zone_id, command })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        console.warn("control failed:", j.error || r.status);
      }
      // Refresh quickly so the icon updates
      setTimeout(fetchState, 200);
    } catch (e) { /* transport control is best-effort; fetchState() already scheduled above */ }
  }

  // Roon's per-zone playback modes. The server always sends `settings`, but a
  // page kept alive across an extension update can briefly be talking to the
  // old one — an absent block reads as everything off rather than throwing.
  function zoneModes() {
    const s = (currentZone && currentZone.settings) || {};
    return {
      shuffle:    !!s.shuffle,
      loop:       (s.loop === "loop" || s.loop === "loop_one") ? s.loop : "disabled",
      auto_radio: !!s.auto_radio
    };
  }

  const LOOP_LABEL = { disabled: "Repeat off", loop: "Repeat queue", loop_one: "Repeat track" };
  // Tapping repeat cycles off → whole queue → this track, as Roon's remote does.
  const LOOP_NEXT  = { disabled: "loop", loop: "loop_one", loop_one: "disabled" };

  let lastModeSig = "";
  function paintModeButtons() {
    const live = !!currentZone;
    const m = zoneModes();
    // updateNpScreen() runs on the 1.5s poll, and setAttribute() marks an
    // attribute dirty even when the value is unchanged — the same reason the
    // mini bar's repaint is gated by lastBarSig. Nothing below changes unless
    // the zone's modes do, so skip the whole thing when they haven't.
    const sig = [live, m.shuffle, m.loop, m.auto_radio].join("|");
    if (sig === lastModeSig) return;
    lastModeSig = sig;
    if (npShuffle) {
      npShuffle.disabled = !live;
      npShuffle.classList.toggle("is-on", live && m.shuffle);
      npShuffle.setAttribute("aria-pressed", String(live && m.shuffle));
      npShuffle.setAttribute("aria-label", live && m.shuffle ? "Shuffle on" : "Shuffle");
    }
    if (npLoop) {
      const loop = live ? m.loop : "disabled";
      npLoop.disabled = !live;
      npLoop.classList.toggle("is-on", loop !== "disabled");
      npLoop.setAttribute("aria-label", LOOP_LABEL[loop]);
      if (npLoopBadge) npLoopBadge.classList.toggle("hidden", loop !== "loop_one");
    }
    if (npRadio) {
      npRadio.disabled = !live;
      npRadio.classList.toggle("is-on", live && m.auto_radio);
      npRadio.setAttribute("aria-pressed", String(live && m.auto_radio));
      npRadio.setAttribute("aria-label", live && m.auto_radio ? "Roon Radio on" : "Roon Radio");
    }
  }

  // Shuffle / repeat / Roon Radio. Mirrors control(): fire, then re-poll, so the
  // buttons show what the ZONE reports rather than what we asked for — a change
  // the Core rejects must not leave a button lit.
  async function changeZoneSettings(patch) {
    if (!currentZone) return;
    try {
      const r = await fetch("/api/zone-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ zone_or_output_id: currentZone.zone_id }, patch))
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.warn("zone-settings failed:", j.error || r.status);
        if (window.__showToast) window.__showToast(j.error || "Could not change that", "error");
      } else if (j.random_album_radio_stands_down && window.__showToast) {
        // Roon Radio and the app's own Random Album Radio would fight over the
        // same queue, so ours stands down. Say so instead of looking broken.
        window.__showToast("Roon Radio on — Random Album Radio stands down for this zone");
      }
    } catch (e) {
      // Network blip. The finally below still re-polls, so the buttons resync.
    } finally {
      setTimeout(fetchState, 200);
    }
  }

  // The single choke point for every ABSOLUTE volume write — drag, release and
  // the −/+ buttons — so the hold cannot be forgotten at one of them the way it
  // was for the buttons. (The incremental branch of stepVolume sends a RELATIVE
  // nudge and deliberately does not come through here; there is no absolute
  // value to hold.)
  //
  // Serialised and latest-wins. These are absolute writes issued fire-and-forget
  // over separate connections, so a drag from 40 to 60 could emit 45, 52, 60 and
  // have 52 arrive last — leaving the zone at 52 and the poll then faithfully
  // dragging the thumb backwards. One in flight at a time, with only the newest
  // value queued behind it, makes that impossible.
  let volInFlight = false, volQueued = null;

  // The zone id travels WITH the value. It used to be read off currentZone
  // inside the loop, which is after an await on every iteration but the first —
  // so switching zones mid-drag posted the queued value to the zone just
  // switched TO, and a switch to nothing threw a TypeError the catch swallowed
  // as a network blip.
  async function postVolume(zoneId, value) {
    // Bounded, because neither this fetch nor /api/volume had any timeout: the
    // server only answers once Roon's change_volume callback fires, and if the
    // Core drops mid-call that promise never settles. volInFlight would then
    // stay true for the lifetime of the page and every later write would queue
    // behind it forever — volume dead until reload.
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), 5000) : null;
    try {
      await fetch("/api/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_or_output_id: zoneId, value }),
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async function setVolume(value) {
    if (!currentZone) return;
    const zoneId = currentZone.zone_id;
    holdVolume(value);                         // covers the drag AND the buttons
    if (volInFlight) { volQueued = { zoneId, value }; return; }
    volInFlight = true;
    let job = { zoneId, value };
    while (job) {
      // Inside the loop, so one failed write does not abandon a value already
      // queued and already painted — the user would be looking at a number
      // nothing had been told about.
      try { await postVolume(job.zoneId, job.value); }
      catch (e) { /* blip or 5s timeout — the poll resyncs once the hold expires */ }
      job = volQueued; volQueued = null;
    }
    volInFlight = false;
    // Pull the echo rather than waiting up to 1.5s for it — the same pattern
    // control() and toggleMute() use (they wait 200ms and 150ms). Coalesced:
    // stepVolume has no debounce, so four fast taps would otherwise schedule
    // four refreshes all landing within a few hundred ms of each other.
    scheduleEchoFetch();
  }
  let volEchoTimer = null;
  function scheduleEchoFetch() {
    clearTimeout(volEchoTimer);
    volEchoTimer = setTimeout(fetchState, 200);
  }
  async function toggleMute() {
    if (!currentZone) return;
    const muted = (currentZone.outputs || []).some(o => o.is_muted);
    try {
      await fetch("/api/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_or_output_id: currentZone.zone_id, mute: !muted })
      });
      setTimeout(fetchState, 150);
    } catch (e) { /* mute is best-effort; fetchState() already scheduled above */ }
  }

  // Wire controls
  btnPP  .addEventListener("click", () => control("playpause"));

  // Now-playing screen transport (mirrors the mini bar's controls)
  if (npPlayPause) npPlayPause.addEventListener("click", () => control("playpause"));
  if (npPrev)      npPrev.addEventListener("click", () => control("previous"));
  if (npNext)      npNext.addEventListener("click", () => control("next"));

  // Playback modes. Each reads the zone's CURRENT value at click time (not a
  // mirrored local flag) and sends the concrete state it wants.
  if (npShuffle) npShuffle.addEventListener("click", () => changeZoneSettings({ shuffle: !zoneModes().shuffle }));
  if (npLoop)    npLoop.addEventListener("click", () => changeZoneSettings({ loop: LOOP_NEXT[zoneModes().loop] }));
  if (npRadio)   npRadio.addEventListener("click", (e) => {
    // Radio lives in .np-secondary, whose popovers the document handler leaves
    // alone — close them here so they don't sit over the row.
    e.stopPropagation();
    closeNpPopovers();
    changeZoneSettings({ auto_radio: !zoneModes().auto_radio });
  });

  // Volume popover: tap the speaker to reveal the slider (or the "fixed" note).
  if (npVolBtn && npVolPopover) {
    npVolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dp = document.getElementById("np-device-popover");
      if (dp) dp.classList.add("hidden");
      const willShow = npVolPopover.classList.contains("hidden");
      npVolPopover.classList.toggle("hidden", !willShow);
      npVolBtn.setAttribute("aria-expanded", String(willShow));
    });
  }

  // Shut both now-playing popovers (volume, device) and reset their buttons.
  function closeNpPopovers() {
    if (npVolPopover) npVolPopover.classList.add("hidden");
    if (npVolBtn) npVolBtn.setAttribute("aria-expanded", "false");
    const dp = document.getElementById("np-device-popover");
    const db = document.getElementById("np-device");
    if (dp) dp.classList.add("hidden");
    if (db) db.setAttribute("aria-expanded", "false");
  }

  // Close the now-playing popovers when tapping outside the controls row.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".np-secondary")) return;
    closeNpPopovers();
  });

  // Now-playing scrubber: show the dragged time live, seek on release.
  if (npSeek) {
    npSeek.addEventListener("input", () => {
      userIsDraggingSeek = true;
      npCur.textContent = fmtTime(parseFloat(npSeek.value));
      paintSeek(parseFloat(npSeek.value));
      paintBarProgress();
    });
    npSeek.addEventListener("change", () => {
      const target = parseFloat(npSeek.value);
      userIsDraggingSeek = false;
      seek(target);         // sets the base + hold synchronously, then posts
      paintSeek(target);
      paintBarProgress();   // the thumb and the mini bar's line must land together
    });
  }

  // Now-playing volume slider (kept in sync with the mini bar)
  let npVolDebounce = null;
  if (npVolSlider) {
    npVolSlider.addEventListener("input", () => {
      userIsDraggingVolume = true;
      const v = parseFloat(npVolSlider.value);
      syncVolumeUI(v);
      clearTimeout(npVolDebounce);
      npVolDebounce = setTimeout(() => setVolume(v), 90);
    });
    npVolSlider.addEventListener("change", () => {
      userIsDraggingVolume = false;
      // Drop the queued mid-drag write: it holds an older value and would land
      // AFTER this final one, re-sending a position the user has moved past.
      clearTimeout(npVolDebounce);
      setVolume(parseFloat(npVolSlider.value));
    });
  }

  // Paint the progress bar from the clock, four times a second.
  //
  // It PAINTS, it does not advance — npNow() derives the position from the base
  // and elapsed time, so a late or throttled tick cannot make the bar drift, and
  // missing ticks entirely just means it repaints correctly when it resumes.
  // 250ms matches display.js; rAF would be waste, since the fill moves about a
  // pixel and a half per second.
  setInterval(() => {
    // npPlaying() already null-checks currentZone, and no now_playing implies
    // npLen === 0, so those two clauses are covered by what remains.
    if (userIsDraggingSeek || !npPlaying() || npLen <= 0) return;
    const pos = npNow();                 // already clamped to [0, npLen]
    paintBarProgress(pos);
    if (onNowPlayingScreen()) {
      npSeek.value = pos;
      paintSeek(pos);
      npCur.textContent = fmtTime(pos);
    }
  }, 250);

  // Let the modal code refresh bar visibility + the now-playing screen on open,
  // tab switch, and close.
  window.__refreshTransport = () => { refreshVisibility(); updateNpScreen(); };

  // Live getter for the share button: reads currentZone directly at call time
  // instead of relying on a mirrored global kept in sync by convention. This
  // is the third fix for "share card shows a stale album" (v1.5.89, v1.5.90,
  // and the Queue-tab case fixed alongside this getter) — a read-time getter
  // makes the whole class of "forgot to update the mirror" bug impossible.
  window.__getCurrentNp = () => currentZone && currentZone.now_playing;

  btnVol.addEventListener("click", (e) => {
    e.stopPropagation();
    volPop.classList.toggle("hidden");
    btnVol.setAttribute("aria-expanded", !volPop.classList.contains("hidden"));
  });
  // Long-press the speaker icon to mute (kept simple: shift-click also mutes on desktop)
  btnVol.addEventListener("dblclick", (e) => {
    e.preventDefault();
    toggleMute();
  });

  let volDebounce = null;
  volSlider.addEventListener("input", () => {
    userIsDraggingVolume = true;
    const v = parseFloat(volSlider.value);
    syncVolumeUI(v);
    clearTimeout(volDebounce);
    volDebounce = setTimeout(() => setVolume(v), 90);
  });
  volSlider.addEventListener("change", () => {
    userIsDraggingVolume = false;
    clearTimeout(volDebounce);   // see the NP slider's change handler
    setVolume(parseFloat(volSlider.value));
  });

  // Close volume popover when clicking outside it
  document.addEventListener("click", (e) => {
    if (volPop.classList.contains("hidden")) return;
    if (volPop.contains(e.target) || btnVol.contains(e.target)) return;
    volPop.classList.add("hidden");
    btnVol.setAttribute("aria-expanded", "false");
  });

  // Zone picker on the bar (Roon-style speaker button)
  async function renderBarZoneList() {
    if (!zoneList) return;
    let list = [];
    try {
      const r = await fetch("/api/zones", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.zones)) list = j.zones; }
    } catch (e) { /* zone list is non-critical; picker shows "No zones available" */ }
    zoneList.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "np-device-empty";
      empty.textContent = "No zones available";
      zoneList.appendChild(empty);
      return;
    }
    const sel = document.getElementById("zone-select");
    const cur = sel && sel.value;
    for (const z of list) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "np-device-item" + (z.zone_id === cur ? " is-current" : "");
      if (window.__fillZoneRow) window.__fillZoneRow(item, z);
      else item.textContent = z.display_name;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        zonePop.classList.add("hidden");
        btnZone.setAttribute("aria-expanded", "false");
        if (!sel || z.zone_id === cur) return;
        sel.value = z.zone_id;
        sel.dispatchEvent(new Event("change"));   // reuse the existing switch flow
      });
      zoneList.appendChild(item);
    }
  }
  if (btnZone && zonePop) {
    btnZone.addEventListener("click", async (e) => {
      e.stopPropagation();
      volPop.classList.add("hidden");
      btnVol.setAttribute("aria-expanded", "false");
      const willShow = zonePop.classList.contains("hidden");
      if (willShow) await renderBarZoneList();
      zonePop.classList.toggle("hidden", !willShow);
      btnZone.setAttribute("aria-expanded", String(willShow));
    });
    document.addEventListener("click", (e) => {
      if (zonePop.classList.contains("hidden")) return;
      if (zonePop.contains(e.target) || btnZone.contains(e.target)) return;
      zonePop.classList.add("hidden");
      btnZone.setAttribute("aria-expanded", "false");
    });
    const popoverAction = (id, open) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        zonePop.classList.add("hidden");
        btnZone.setAttribute("aria-expanded", "false");
        const fn = window[open];
        if (fn) fn();
      });
    };
    popoverAction("mt-group-open", "__openGroupSheet");
    popoverAction("mt-power-open", "__openDevicePowerSheet");
    // Same three all-zone actions as the now-playing picker, same source.
    for (const act of ["pause-all", "mute-all", "unmute-all"]) {
      const b = document.getElementById("mt-" + act);
      if (!b) continue;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        zonePop.classList.add("hidden");
        btnZone.setAttribute("aria-expanded", "false");
        const fn = window.__allZoneActions && window.__allZoneActions[act];
        if (fn) fn();
      });
    }
  }

  // Tap the info area (art + text) to open the now-playing album in the modal
  const infoArea = bar.querySelector(".mt-info");
  infoArea.addEventListener("click", () => {
    if (!currentZone || !currentZone.now_playing) return;
    if (typeof window.__openAlbum !== "function") return;
    const np = currentZone.now_playing;
    window.__openAlbum({
      title:     np.line3 || np.line1 || "",
      subtitle:  np.line2 || "",
      image_key: np.image_key
    }, { source: "now-playing", zoneId: currentZone.zone_id });
  });

  // Volume +/- buttons (shared by the mini-bar sheet and the NP sheet)
  const stepMinus   = document.getElementById("mt-vol-minus");
  const stepPlus    = document.getElementById("mt-vol-plus");
  const npStepMinus = document.getElementById("np-vol-minus");
  const npStepPlus  = document.getElementById("np-vol-plus");
  async function stepVolume(delta) {
    const vo = currentVolOutput();   // read-time — never a stale mirror
    if (!vo) return;
    if ((vo.volume.type || null) === "incremental") {
      // Relative-only output: no absolute scale exists — send a nudge.
      try {
        await fetch("/api/volume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zone_or_output_id: currentZone.zone_id, relative: delta > 0 ? 1 : -1 })
        });
      } catch (e) { /* best-effort, like setVolume */ }
      return;
    }
    // Safe to step from the painted value: volumeHeld() keeps a stale poll from
    // reverting it, so what is on screen IS what we last sent. Without that hold
    // this read is what silently lost taps — the display having gone back to 50,
    // a second + recomputed 51 and re-sent a value already sent.
    const cur = parseFloat(volSlider.value);
    // Range and step come from the output itself, not from the slider's
    // attributes. Those attributes are only a mirror written by renderZone, and
    // reading state back out of a mirror is the exact thing currentVolOutput()
    // exists to avoid.
    const vol = vo.volume;
    const min = vol.min != null ? vol.min : 0;
    // The zone's own step, not a hardcoded 2: Roon `number` volumes step by 1,
    // dB outputs commonly by 0.5, so a fixed 2 moved two or four positions.
    // `delta * stepSz` rather than sign(delta), so a caller can still ask for a
    // multi-step nudge later without rewriting this.
    const stepSz = vol.step != null ? vol.step : 1;
    const next = Math.max(min, Math.min(volCeiling(vol), cur + delta * stepSz));
    syncVolumeUI(next);
    setVolume(next);
  }
  if (stepMinus)   stepMinus  .addEventListener("click", (e) => { e.stopPropagation(); stepVolume(-1); });
  if (stepPlus)    stepPlus   .addEventListener("click", (e) => { e.stopPropagation(); stepVolume(+1); });
  if (npStepMinus) npStepMinus.addEventListener("click", (e) => { e.stopPropagation(); stepVolume(-1); });
  if (npStepPlus)  npStepPlus .addEventListener("click", (e) => { e.stopPropagation(); stepVolume(+1); });

  // Polling: 1.5s when visible/playing, slower when not
  function startPolling() {
    if (pollTimer) return;
    fetchState();
    pollTimer = setInterval(fetchState, 1500);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopPolling(); return; }
    // Discard the elapsed time accumulated while hidden before anything paints.
    // The poll stops when the page is hidden but the clock does not, so after a
    // long background the first tick would compute a position minutes ahead,
    // clamp it to the track length, and flash the bar at 100% with the full
    // duration in the readout until the refresh landed. Holding the last known
    // position instead is stale by the same amount but never absurd, and
    // startPolling() corrects it within one round trip.
    npSetBase(npBase);
    npWasPlaying = npPlaying();
    startPolling();
  });

  // Refresh when zone selector changes
  const zoneSel = document.getElementById("zone-select");
  if (zoneSel) zoneSel.addEventListener("change", fetchState);

  // Boot — restore last known state instantly, then let the poll loop refresh it.
  restoreTransportState();
  startPolling();
})();

/* ------------------------------------------------------------------ */
/*  Settings info-icon toasts                                         */
/* ------------------------------------------------------------------ */
(() => {
  let toast = null;
  let dismissTimer = null;

  function getToast() {
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "settings-info-toast";
      toast.setAttribute("role", "tooltip");
      document.body.appendChild(toast);
    }
    return toast;
  }

  function hideToast() {
    if (!toast) return;
    toast.classList.remove("visible");
    clearTimeout(dismissTimer);
  }

  function showToast(text) {
    const t = getToast();
    t.textContent = text;
    t.classList.add("visible");
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(hideToast, 5000);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".settings-info-btn");
    if (btn) {
      e.stopPropagation();
      showToast(btn.dataset.info || "");
      return;
    }
    hideToast();
  }, true);
})();

/* ------------------------------------------------------------------ */
/*  Share card overlay                                                 */
/* ------------------------------------------------------------------ */
(() => {
  const overlay   = document.getElementById("share-overlay");
  const frame     = document.getElementById("share-frame");
  const actions   = document.getElementById("share-actions");
  const hintEl    = document.getElementById("share-hint");
  const errEl     = document.getElementById("share-err");
  const modalBtn  = document.getElementById("modal-share-btn");

  async function ensureFont() {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load('700 42px Manrope'),
        document.fonts.load('400 28px Manrope'),
        document.fonts.load('700 16px Manrope'),
        document.fonts.load('400 22px Manrope')
      ]);
      await document.fonts.ready;
    } catch { /* fall back */ }
  }

  function close() {
    overlay.classList.add("hidden");
    frame.innerHTML =
      `<div class="share-placeholder"><div class="share-spinner"></div><div>Generating card…</div></div>`;
    actions.innerHTML = "";
    hintEl.textContent = "";
    errEl.textContent  = "";
  }
  overlay.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-share-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });

  // Public entry point — called from album modal share button + mini transport
  async function open(input) {
    const title  = input.title  || "";
    const artist = input.artist || "";
    if (!title) return;

    actions.innerHTML = "";
    hintEl.textContent = "";
    errEl.textContent  = "";
    frame.innerHTML =
      `<div class="share-placeholder"><div class="share-spinner"></div><div>Generating card…</div></div>`;
    overlay.classList.remove("hidden");

    try {
      await ensureFont();

      // Best-effort release year + label + review via extras endpoint
      let releaseRaw = "";
      let labelText  = "";
      let reviewText = "";
      try {
        const params = new URLSearchParams({ title, artist });
        const r = await fetch("/api/album/extras?" + params, { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          if (j.year) releaseRaw = j.year;
          if (j.album && j.album.year && !releaseRaw) releaseRaw = String(j.album.year);
          if (j.album && j.album.label) labelText = String(j.album.label);
          const desc = j.album && j.album.description;
          if (desc) {
            // Card height grows to fit, so show most of the review.
            // Cap generously (~10 sentences / 1400 chars) to avoid an
            // absurdly tall card from a very long Wikipedia article.
            let t = String(desc).trim();
            const sentences = t.match(/[^.!?]+[.!?]+/g);
            if (sentences && sentences.length > 10) {
              t = sentences.slice(0, 10).join(" ").trim();
            }
            if (t.length > 1400) t = t.slice(0, 1398).replace(/\s+\S*$/, "") + "…";
            reviewText = t;
          }
        }
      } catch { /* keep blank */ }

      const coverUrl = input.image_key
        ? `/api/image/${encodeURIComponent(input.image_key)}?size=1000&t=${Date.now()}`
        : "";

      const blob = await ShareCard.render({
        coverUrl,
        wordmarkUrl: null,
        title,
        artist,
        releaseRaw,
        label: labelText,
        review: reviewText
      });

      const dataUrl = await blobToDataUrl(blob);
      frame.innerHTML = `<img src="${dataUrl}" alt="Share card">`;
      buildActions(blob, title, artist);
    } catch (e) {
      frame.innerHTML = `<div class="share-placeholder">Could not generate the card.</div>`;
      errEl.textContent = (e && e.message) ? e.message : String(e);
    }
  }
  window.__openShareCard = open;

  function buildActions(blob, title, artist) {
    actions.innerHTML = "";
    const fileName =
      `${(artist || "artist").replace(/[^a-z0-9]+/gi, "_")}-` +
      `${(title  || "card"  ).replace(/[^a-z0-9]+/gi, "_")}.png`;

    const canShare = (() => {
      try {
        if (!navigator.share || !navigator.canShare) return false;
        const probe = new File([new Uint8Array([0])], "p.png", { type: "image/png" });
        return navigator.canShare({ files: [probe] });
      } catch { return false; }
    })();
    const canCopy = typeof window.ClipboardItem !== "undefined"
      && navigator.clipboard && typeof navigator.clipboard.write === "function";

    if (canCopy) {
      const b = mkBtn("ghost", icon("copy"), "Copy image");
      b.onclick = async () => {
        try {
          await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
          setLabel(b, "Copied!"); setTimeout(() => setLabel(b, "Copy image"), 2000);
        } catch (e) { errEl.textContent = e.message || String(e); }
      };
      actions.appendChild(b);
    }
    if (canShare) {
      const b = mkBtn("primary", icon("share"), "Share…");
      b.onclick = async () => {
        try {
          const file = new File([blob], fileName, { type: "image/png" });
          await navigator.share({ files: [file] });
        } catch (e) { if (e && e.name !== "AbortError") errEl.textContent = e.message || String(e); }
      };
      actions.appendChild(b);
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.appendChild(document.createTextNode(""));
    a.innerHTML = `${icon("download")}<span>Download</span>`;
    actions.appendChild(a);

    hintEl.textContent = (canCopy || canShare)
      ? "Tap a button above, or long-press the card to save."
      : "Long-press the card to save, or tap Download.";
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(new Error("read failed"));
      r.readAsDataURL(blob);
    });
  }
  function mkBtn(cls, iconSvg, label) {
    const b = document.createElement("button");
    b.className = cls;
    b.type = "button";
    b.innerHTML = `${iconSvg}<span>${label}</span>`;
    return b;
  }
  function setLabel(btn, text) {
    const s = btn.querySelector("span");
    if (s) s.textContent = text;
  }
  function icon(name) {
    const I = {
      share:    '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
      copy:     '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ""}</svg>`;
  }

  // Wire the share button inside the album modal
  if (modalBtn) {
    modalBtn.addEventListener("click", () => {
      // On the now-playing screen read the live zone state directly via
      // window.__getCurrentNp() (not a mirrored global) so the card always
      // reflects the current track, not the album that was playing when the
      // modal first opened, regardless of which modal tab is active.
      const npModal = document.getElementById("album-modal");
      const isNp = npModal && npModal.classList.contains("np-mode");
      const np = isNp && window.__getCurrentNp && window.__getCurrentNp();
      if (np) {
        open({ title: np.line3 || "", artist: np.line2 || "", image_key: np.image_key });
        return;
      }
      const a = window.__currentAlbum;
      if (!a) return;
      open({ title: a.title || "", artist: a.subtitle || "", image_key: a.image_key });
    });
  }
})();

/* ------------------------------------------------------------------ */
/*  Self-update: poll status, show a toast, install on tap            */
/* ------------------------------------------------------------------ */
(function initUpdater() {
  const toast    = document.getElementById("update-toast");
  const textEl   = document.getElementById("update-text");
  const actions  = document.getElementById("update-actions");
  const btnNow   = document.getElementById("update-now");
  const btnLater = document.getElementById("update-later");
  const notesEl  = document.getElementById("update-notes");
  if (!toast || !btnNow) return;

  const PHASE = {
    checking:   "Preparing\u2026",
    downloading:"Downloading\u2026",
    extracting: "Unpacking\u2026",
    restarting: "Restarting\u2026"
  };
  const DISMISS_KEY = "rra-update-dismissed";
  let applying = false;
  let pollTimer = null;

  const dismissedVer = () => { try { return sessionStorage.getItem(DISMISS_KEY) || ""; } catch (e) { return ""; } };
  const setDismissed = (v) => { try { sessionStorage.setItem(DISMISS_KEY, v); } catch (e) {} };
  const show = (msg) => { textEl.textContent = msg; toast.classList.add("open"); };
  const hide = () => { toast.classList.remove("open"); if (notesEl) notesEl.classList.add("hidden"); };

  function showNotes(notes) {
    if (!notesEl || !notes) { if (notesEl) notesEl.classList.add("hidden"); return; }
    notesEl.textContent = notes;
    notesEl.classList.remove("hidden");
  }

  function showProgress(phase) {
    applying = true;
    actions.classList.add("busy");
    toast.classList.remove("is-error");
    if (notesEl) notesEl.classList.add("hidden");
    show(PHASE[phase] || "Updating\u2026");
  }

  async function check() {
    if (applying) return;
    try {
      const r = await fetch("/api/update/status", { cache: "no-store" });
      if (!r.ok) return;
      const s = await r.json();
      const ph = s.apply && s.apply.phase;
      if (ph === "downloading" || ph === "extracting" || ph === "restarting") {
        showProgress(ph); startPoll(s.latest); return;
      }
      if (s.available && s.latest && s.latest !== dismissedVer()) {
        actions.classList.remove("busy"); btnNow.disabled = false;
        toast.classList.remove("is-error");
        const label = s.isDowngrade ? "Rollback to v" : "v";
        show((label) + s.latest + " available (you have v" + s.current + ")");
        showNotes(s.notes);
        btnNow.querySelector("span").textContent = s.isDowngrade ? "Roll back" : "Update";
      } else if (!applying) {
        hide();
      }
    } catch (e) { /* offline; try again next tick */ }
  }

  function startPoll(targetVer) {
    if (pollTimer) clearInterval(pollTimer);
    let wasDown = false;
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch("/api/update/status", { cache: "no-store" });
        if (!r.ok) throw new Error("bad");
        const s = await r.json();
        if (wasDown && ((targetVer && s.current === targetVer) || !s.available)) {
          clearInterval(pollTimer); location.reload(); return;
        }
        const ph = s.apply && s.apply.phase;
        if (ph === "error") {
          clearInterval(pollTimer); applying = false;
          actions.classList.remove("busy"); btnNow.disabled = false;
          toast.classList.add("is-error");
          show("Update failed: " + ((s.apply && s.apply.error) || "unknown") + ". Tap Update to retry.");
          return;
        }
        if (PHASE[ph]) show(PHASE[ph]);
      } catch (e) {
        wasDown = true;                 // server is restarting
        show(PHASE.restarting);
      }
    }, 1500);
    setTimeout(() => {
      if (pollTimer && applying) {
        clearInterval(pollTimer);
        show("Update is taking a while \u2014 if the app doesn't come back on its own, restart the extension to finish.");
      }
    }, 180000);
  }

  btnNow.addEventListener("click", async () => {
    if (applying) return;
    btnNow.disabled = true;
    showProgress("checking");
    try {
      const r = await fetch("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const s = await r.json().catch(() => null);
      if (!r.ok) {
        applying = false; actions.classList.remove("busy"); btnNow.disabled = false;
        toast.classList.add("is-error");
        show("Couldn't start update: " + ((s && s.error) || ("HTTP " + r.status)));
        return;
      }
      startPoll(s && s.status && s.status.latest);
    } catch (e) {
      startPoll(null);                  // request cut off by restart — keep polling
    }
  });

  btnLater.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/update/status", { cache: "no-store" });
      const s = await r.json();
      if (s && s.latest) setDismissed(s.latest);
    } catch (e) {} // network error dismissing update — banner stays hidden, safe to ignore
    hide();
  });

  // Settings' "Check for updates" flow hands off here after its own check:
  // applying through the banner keeps a single implementation of the
  // download/unpack/restart progress UI (the banner sits behind the Settings
  // sheet, so the caller closes Settings first). Clearing the "Later"
  // dismissal lets the banner's error/retry states show normally afterwards.
  window.__applyUpdateNow = () => { setDismissed(""); btnNow.click(); };

  check();
  setInterval(check, 15 * 60 * 1000);
})();

/* ------------------------------------------------------------------ */
/*  Settings sheet: theme toggle (lives here now), version, repo link  */
/* ------------------------------------------------------------------ */
(function initSettings() {
  // showToast lives in the album/grid IIFE above and is NOT in scope here —
  // this is a different top-level IIFE. Every one of the 28 bare showToast()
  // calls in this function was therefore throwing ReferenceError instead of
  // showing a message: token saves, display settings, and the Qobuz/TIDAL
  // connect flows all failed silently, and the catch blocks that tried to
  // report the failure threw again. window.__showToast is the existing bridge
  // (declared where showToast is), so aliasing it here fixes all of them at
  // once and keeps the call sites readable.
  const showToast = (msg, kind) => {
    if (window.__showToast) window.__showToast(msg, kind);
  };
  const openBtn    = document.getElementById("settings-toggle");
  const overlay    = document.getElementById("settings-overlay");
  const versionEl  = document.getElementById("settings-version");
  const radioToggle = document.getElementById("radio-toggle");
  const zoneSelect  = document.getElementById("zone-select");
  const labelOrderSelect = document.getElementById("label-order-select");
  const labelMinSelect   = document.getElementById("label-min-select");
  if (!openBtn || !overlay) return;

  // Label album order (alphabetical default). Persisted in localStorage and
  // read by the labels browser when it loads a label's albums.
  if (labelOrderSelect) {
    labelOrderSelect.value =
      localStorage.getItem("rra-label-order") === "random" ? "random" : "alpha";
    labelOrderSelect.addEventListener("change", () => {
      const v = labelOrderSelect.value === "random" ? "random" : "alpha";
      localStorage.setItem("rra-label-order", v);
    });
  }

  // Minimum albums per label — hides one-off outliers from the labels grid.
  if (labelMinSelect) {
    const stored = localStorage.getItem("rra-label-min");
    labelMinSelect.value = (stored === "1" || stored === "5" || stored === "10") ? stored : "2";
    labelMinSelect.addEventListener("change", () => {
      localStorage.setItem("rra-label-min", labelMinSelect.value);
    });
  }

  async function loadRadio() {
    if (!radioToggle || !zoneSelect || !zoneSelect.value) return;
    try {
      const r = await fetch("/api/radio?zone=" + encodeURIComponent(zoneSelect.value), { cache: "no-store" });
      if (r.ok) { const j = await r.json(); radioToggle.checked = !!j.enabled; }
    } catch (e) {} // network error loading radio state — toggle stays at default, non-critical
  }
  if (radioToggle) {
    radioToggle.addEventListener("change", async () => {
      if (!zoneSelect || !zoneSelect.value) return;
      try {
        await fetch("/api/radio", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zone: zoneSelect.value, enabled: radioToggle.checked })
        });
      } catch (e) {} // network error toggling radio — toggle UI already updated, best-effort
    });
  }

  let versionLoaded = false;
  async function loadVersion() {
    if (versionLoaded || !versionEl) return;
    try {
      const r = await fetch("/api/update/status", { cache: "no-store" });
      if (r.ok) {
        const s = await r.json();
        if (s && s.current) {
          const parts = (s.current || "").split(".");
          versionEl.textContent = parts.length >= 3
            ? "MusicD Remote v" + parts[0] + "." + parts[1] + " (Build " + parts[2] + ")"
            : "MusicD Remote v" + s.current;
          versionLoaded = true;
        }
      }
    } catch (e) {} // network error loading version — settings panel shows without version, non-critical
  }

  const forceRescanBtn    = document.getElementById("force-rescan-btn");
  const forceRescanStatus = document.getElementById("force-rescan-status");
  if (forceRescanBtn) {
    forceRescanBtn.addEventListener("click", async () => {
      if (forceRescanBtn.disabled) return;
      forceRescanBtn.disabled = true;
      forceRescanBtn.textContent = "Starting…";
      if (forceRescanStatus) forceRescanStatus.classList.add("hidden");
      try {
        const r = await fetch("/api/labels/rescan-force", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        forceRescanBtn.textContent = "Rescan started";
        if (forceRescanStatus) { forceRescanStatus.textContent = "Full rescan started — this may take several minutes. Label data will update as results come in."; forceRescanStatus.classList.remove("hidden"); }
        setTimeout(() => {
          forceRescanBtn.disabled = false;
          forceRescanBtn.textContent = "Force rescan";
        }, 5000);
      } catch (e) {
        forceRescanBtn.disabled = false;
        forceRescanBtn.textContent = "Force rescan";
        if (forceRescanStatus) { forceRescanStatus.textContent = "Error: " + e.message; forceRescanStatus.classList.remove("hidden"); }
      }
    });
  }

  const discogsTokenInput  = document.getElementById("discogs-token-input");
  const discogsTokenSave   = document.getElementById("discogs-token-save");
  const discogsTokenStatus = document.getElementById("discogs-token-status");

  async function loadDiscogsToken() {
    try {
      const r = await fetch("/api/settings/discogs-token");
      const j = await r.json();
      if (discogsTokenStatus) {
        discogsTokenStatus.textContent = j.set ? ("Current: " + j.masked) : "Not set";
      }
    } catch (_) { /* display-only status — if the fetch fails, silence is fine; status just stays stale */ }
  }

  if (discogsTokenSave) {
    discogsTokenSave.addEventListener("click", async () => {
      const token = discogsTokenInput ? discogsTokenInput.value.trim() : "";
      if (!token) return;
      discogsTokenSave.disabled = true;
      try {
        const r = await fetch("/api/settings/discogs-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const j = await r.json();
        if (j.ok) {
          if (discogsTokenInput) discogsTokenInput.value = "";
          showToast(j.saved === false ? "Token set but file write failed — won't persist after restart" : "Discogs token saved", j.saved === false ? "error" : "ok");
          loadDiscogsToken();
        } else {
          showToast(j.error || "Failed to save token", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        discogsTokenSave.disabled = false;
      }
    });
  }

  const fanartKeyInput  = document.getElementById("fanart-key-input");
  const fanartKeySave   = document.getElementById("fanart-key-save");
  const fanartKeyStatus = document.getElementById("fanart-key-status");

  async function loadFanartKey() {
    try {
      const r = await fetch("/api/settings/fanart-key");
      const j = await r.json();
      if (fanartKeyStatus) {
        fanartKeyStatus.textContent = j.set ? ("Current: " + j.masked) : "Not set";
      }
    } catch (_) { /* display-only status — if the fetch fails, silence is fine; status just stays stale */ }
  }

  if (fanartKeySave) {
    fanartKeySave.addEventListener("click", async () => {
      const key = fanartKeyInput ? fanartKeyInput.value.trim() : "";
      if (!key) return;
      fanartKeySave.disabled = true;
      try {
        const r = await fetch("/api/settings/fanart-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key })
        });
        const j = await r.json();
        if (j.ok) {
          if (fanartKeyInput) fanartKeyInput.value = "";
          showToast(j.saved === false ? "Key set but file write failed — won't persist after restart" : "FanArt.tv key saved", j.saved === false ? "error" : "ok");
          loadFanartKey();
        } else {
          showToast(j.error || "Failed to save key", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        fanartKeySave.disabled = false;
      }
    });
  }

  // ----- Wall display (/display): toggle + rotation interval -----
  const displayToggle    = document.getElementById("display-toggle");
  const displaySeconds   = document.getElementById("display-seconds");
  const displaySecsValue = document.getElementById("display-seconds-value");

  async function loadDisplaySettings() {
    try {
      const r = await fetch("/api/settings/display");
      const j = await r.json();
      if (displayToggle) displayToggle.checked = !!j.enabled;
      if (displaySeconds && Number.isFinite(parseInt(j.seconds, 10))) {
        displaySeconds.value = j.seconds;
        if (displaySecsValue) displaySecsValue.textContent = j.seconds + "s";
      }
    } catch (_) { /* display-only status — if the fetch fails, the sheet just shows defaults */ }
  }

  async function saveDisplaySettings() {
    try {
      const r = await fetch("/api/settings/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: displayToggle ? displayToggle.checked : false,
          seconds: displaySeconds ? parseInt(displaySeconds.value, 10) : 10
        })
      });
      const j = await r.json();
      if (!j.ok) showToast("Display settings didn't persist — check the data volume", "error");
    } catch (e) {
      showToast("Failed: " + e.message, "error");
    }
  }

  if (displayToggle) displayToggle.addEventListener("change", saveDisplaySettings);
  if (displaySeconds) {
    // Live value while dragging; persist on release.
    displaySeconds.addEventListener("input", () => {
      if (displaySecsValue) displaySecsValue.textContent = displaySeconds.value + "s";
    });
    displaySeconds.addEventListener("change", saveDisplaySettings);
  }
  const lfdInput  = document.getElementById("label-folder-depth-input");
  const lfdSave   = document.getElementById("label-folder-depth-save");
  const lfdStatus = document.getElementById("label-folder-depth-status");

  async function loadLabelFolderDepth() {
    try {
      const r = await fetch("/api/settings/label-folder-depth");
      const j = await r.json();
      if (lfdInput && document.activeElement !== lfdInput) lfdInput.value = j.depth || 0;
      if (lfdStatus) lfdStatus.textContent = j.depth ? ("Using folder depth " + j.depth) : "Off — using file label tags";
    } catch (_) { /* display-only status — stale on failure is fine */ }
  }

  if (lfdSave) {
    lfdSave.addEventListener("click", async () => {
      const depth = parseInt(lfdInput ? lfdInput.value : "0", 10) || 0;
      lfdSave.disabled = true;
      try {
        const r = await fetch("/api/settings/label-folder-depth", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depth })
        });
        const j = await r.json();
        if (j.ok) {
          showToast(j.rescanning ? "Saved — re-scanning labels…" : "Saved", "ok");
          loadLabelFolderDepth();
        } else {
          showToast(j.error || "Failed to save", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        lfdSave.disabled = false;
      }
    });
  }

  const qobuzUserInput  = document.getElementById("qobuz-username-input");
  const qobuzPassInput  = document.getElementById("qobuz-password-input");
  const qobuzConnect    = document.getElementById("qobuz-connect");
  const qobuzDisconnect = document.getElementById("qobuz-disconnect");
  const qobuzStatus     = document.getElementById("qobuz-status");
  const qobuzTopbarBtn  = document.getElementById("qobuz-toggle");
  const qobuzMenuItem   = document.getElementById("menu-item-qobuz");

  // Gates the Qobuz controls on the connection, exactly as loadTidalStatus
  // does. This used to toggle the Disconnect button ALONE, so the top-bar
  // button and the side-menu entry stayed visible after logging out — the
  // Qobuz browser remained one tap away from an account that no longer
  // existed, and every catalogue call behind it threw "not connected".
  async function loadQobuzStatus() {
    try {
      const r = await fetch("/api/settings/qobuz");
      const j = await r.json();
      if (qobuzStatus) qobuzStatus.textContent = j.connected
        ? ("Connected" + (j.displayName ? " as " + j.displayName : ""))
        : "Not connected";
      if (qobuzDisconnect) qobuzDisconnect.classList.toggle("hidden", !j.connected);
      if (qobuzTopbarBtn) qobuzTopbarBtn.classList.toggle("hidden", !j.connected);
      if (qobuzMenuItem)  qobuzMenuItem.classList.toggle("hidden", !j.connected);
      // Deliberately NOT force-closing an open Qobuz browser: hideOverlay() is
      // reachable only from the popstate handler so viewStack and the history
      // stack cannot drift, and the overlay already renders its own
      // not-connected state on the next request.
    } catch (_) { /* display-only status — stale on failure is fine */ }
  }

  if (qobuzConnect) {
    qobuzConnect.addEventListener("click", async () => {
      const username = qobuzUserInput ? qobuzUserInput.value.trim() : "";
      const password = qobuzPassInput ? qobuzPassInput.value : "";
      if (!username || !password) { showToast("Enter your Qobuz email and password", "error"); return; }
      qobuzConnect.disabled = true;
      try {
        const r = await fetch("/api/settings/qobuz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const j = await r.json();
        if (j.ok) {
          if (qobuzPassInput) qobuzPassInput.value = "";
          showToast("Qobuz connected" + (j.displayName ? " as " + j.displayName : ""), "ok");
          loadQobuzStatus();
        } else {
          showToast(j.error || "Qobuz connect failed", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        qobuzConnect.disabled = false;
      }
    });
  }

  if (qobuzDisconnect) {
    qobuzDisconnect.addEventListener("click", async () => {
      qobuzDisconnect.disabled = true;
      try {
        await fetch("/api/settings/qobuz/disconnect", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
        showToast("Qobuz disconnected", "ok");
        loadQobuzStatus();
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        qobuzDisconnect.disabled = false;
      }
    });
  }

  /* ---- Tidal account (OAuth device flow — no password entered here) ---- */
  const tidalConnect     = document.getElementById("tidal-connect");
  const tidalDisconnect  = document.getElementById("tidal-disconnect");
  const tidalStatus      = document.getElementById("tidal-status");
  const tidalAuthPending = document.getElementById("tidal-auth-pending");
  const tidalTopbarBtn   = document.getElementById("tidal-toggle");
  const tidalMenuItem    = document.getElementById("menu-item-tidal");

  // Loads connection state, and gates the Tidal controls on it — the Tidal
  // browser is only reachable while an account is connected.
  async function loadTidalStatus() {
    try {
      const r = await fetch("/api/settings/tidal");
      const j = await r.json();
      if (tidalDisconnect) tidalDisconnect.classList.toggle("hidden", !j.connected);
      if (tidalTopbarBtn) tidalTopbarBtn.classList.toggle("hidden", !j.connected);
      if (tidalMenuItem) tidalMenuItem.classList.toggle("hidden", !j.connected);
      if (!tidalStatus) return;
      if (j.connected) {
        tidalStatus.textContent = "Connected" + (j.displayName ? " as " + j.displayName : "");
        return;
      }
      // Not connected — surface the outcome of a device-flow attempt the
      // server finished (or is still driving) while Settings was closed, so
      // a failure isn't silently swallowed into a bare "Not connected".
      let extra = "";
      try {
        const s = await (await fetch("/api/settings/tidal/status", { cache: "no-store" })).json();
        if (s.state === "error" && s.error) extra = " — last login attempt failed: " + s.error;
        else if (s.state === "pending") extra = " — a login is awaiting authorization on tidal.com";
      } catch (_) { /* best-effort detail — a plain "Not connected" is fine */ }
      tidalStatus.textContent = "Not connected" + extra;
    } catch (_) { /* display-only status — stale on failure is fine; the topbar button keeps its last known state */ }
  }

  // Device-flow poll timer: one active poll at most. A new Connect supersedes
  // any previous pending authorization; closing Settings also stops the poll
  // (the SERVER keeps polling Tidal — reopening Settings shows the outcome).
  let tidalPollTimer = null;
  function stopTidalPoll() {
    if (tidalPollTimer) { clearInterval(tidalPollTimer); tidalPollTimer = null; }
  }

  function hideTidalPending() {
    if (tidalAuthPending) { tidalAuthPending.classList.add("hidden"); tidalAuthPending.innerHTML = ""; }
  }

  // Ends the client side of the device flow: stop polling, clear the pending
  // block, re-enable Connect and refresh the status line + topbar gating.
  function finishTidalAuth() {
    stopTidalPoll();
    hideTidalPending();
    if (tidalConnect) tidalConnect.disabled = false;
    loadTidalStatus();
  }

  // Shows the device-authorization instructions: a link to Tidal's own page,
  // the user code in large monospace, and a waiting line. Built with
  // createElement/textContent so nothing from the server is injected as HTML.
  function showTidalPending(j) {
    if (!tidalAuthPending) return;
    tidalAuthPending.innerHTML = "";
    const link = document.createElement("a");
    link.className = "tidal-auth-link";
    link.href = j.verification_uri_complete || j.verification_uri;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open the Tidal authorization page";
    tidalAuthPending.appendChild(link);
    if (j.user_code) {
      const code = document.createElement("div");
      code.className = "tidal-auth-code";
      code.textContent = j.user_code;
      tidalAuthPending.appendChild(code);
    }
    const wait = document.createElement("div");
    wait.className = "tidal-auth-wait";
    wait.textContent = "Waiting for you to authorize in the Tidal page…";
    tidalAuthPending.appendChild(wait);
    tidalAuthPending.classList.remove("hidden");
  }

  // Poll the server every 3 s while an authorization is pending. The server
  // does the actual Tidal polling; this only watches for the outcome.
  function startTidalPoll() {
    stopTidalPoll();
    let pollFailures = 0;
    tidalPollTimer = setInterval(async () => {
      try {
        const r = await fetch("/api/settings/tidal/status", { cache: "no-store" });
        const j = await r.json();
        pollFailures = 0;
        if (j.state === "connected") {
          showToast("Tidal connected" + (j.displayName ? " as " + j.displayName : ""), "ok");
          finishTidalAuth();
        } else if (j.state === "error") {
          // finishTidalAuth → loadTidalStatus renders the persistent error
          // line ("Not connected — last login attempt failed: …").
          showToast(j.error || "Tidal authorization failed", "error");
          finishTidalAuth();
        } else if (j.state === "idle") {
          // The server no longer has a pending authorization (expired/reset).
          showToast("Tidal authorization expired — tap Connect to try again", "error");
          finishTidalAuth();
        }
        // state "pending" — keep polling
      } catch (e) {
        // Transient network failures shouldn't abort a flow the server is
        // still driving — but three misses in a row means we can no longer
        // observe the outcome, so surface it and stop.
        pollFailures++;
        if (pollFailures >= 3) {
          showToast("Lost contact while waiting for Tidal: " + e.message, "error");
          finishTidalAuth();
        }
      }
    }, 3000);
  }

  if (tidalConnect) {
    tidalConnect.addEventListener("click", async () => {
      if (tidalConnect.disabled) return;
      tidalConnect.disabled = true;
      stopTidalPoll(); // a new start supersedes any previous pending authorization
      hideTidalPending();
      try {
        const r = await fetch("/api/settings/tidal/start", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || ("HTTP " + r.status));
        if (!j.verification_uri_complete && !j.verification_uri) {
          throw new Error("Tidal did not return an authorization link");
        }
        showTidalPending(j);
        startTidalPoll();
        // Connect stays disabled while the poll runs; finishTidalAuth re-enables it.
      } catch (e) {
        showToast("Tidal connect failed: " + e.message, "error");
        tidalConnect.disabled = false;
      }
    });
  }

  if (tidalDisconnect) {
    tidalDisconnect.addEventListener("click", async () => {
      tidalDisconnect.disabled = true;
      try {
        await fetch("/api/settings/tidal/disconnect", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
        showToast("Tidal disconnected", "ok");
        loadTidalStatus(); // also hides the topbar Tidal button
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        tidalDisconnect.disabled = false;
      }
    });
  }

  // Boot-time gate: the topbar Qobuz and Tidal buttons — and their side-menu
  // entries — must reflect the connection without the user ever opening
  // Settings. Qobuz was missing from this and so was never gated at all.
  loadQobuzStatus();
  loadTidalStatus();

  // Settings is a two-level view: a category home list and one pane per
  // category. Only one .settings-view is visible at a time. The controls and
  // their IDs are unchanged — they just live inside panes now — so all the
  // load*/save* wiring above still resolves against the same elements.
  const sheet = overlay.querySelector(".settings-sheet");
  const views = sheet ? sheet.querySelectorAll(".settings-view") : [];
  const showView = (name) => {
    let matched = false;
    views.forEach(v => {
      const isHome = v.getAttribute("data-view") === "home";
      const key    = isHome ? "home" : v.getAttribute("data-pane");
      const on     = key === name;
      v.classList.toggle("hidden", !on);
      if (on) matched = true;
    });
    // Fall back to home if an unknown pane was requested.
    if (!matched) views.forEach(v => v.classList.toggle("hidden", v.getAttribute("data-view") !== "home"));
    // Each level starts scrolled to the top, like a pushed page.
    if (sheet) sheet.scrollTop = 0;
  };
  const atHome = () => {
    const home = sheet && sheet.querySelector('.settings-view[data-view="home"]');
    return !home || !home.classList.contains("hidden");
  };

  if (sheet) {
    sheet.addEventListener("click", (e) => {
      const nav = e.target.closest(".settings-nav-item");
      if (nav) { showView(nav.getAttribute("data-pane")); return; }
      if (e.target.closest("[data-settings-back]")) { showView("home"); return; }
    });
  }

  // ----- Theme picker -----
  // A single-select list plus Apply, rather than the old instant toggle. The
  // rows are built from app.js's THEMES table so the list can never offer a
  // theme the palettes don't define, or miss one they do.
  //
  // "Pending" is the row the user has tapped; "current" is what is actually
  // applied. Apply is disabled while they match, so the button always means
  // something. Reopening Settings discards a pending choice — the sheet should
  // never reopen mid-decision.
  const themeList  = document.getElementById("theme-list");
  const themeApply = document.getElementById("theme-apply");
  const themeHint  = document.getElementById("theme-apply-hint");
  let pendingThemeId = null;

  function renderThemeList() {
    if (!themeList || !window.__themes) return;
    const current = window.__currentThemeId();
    const chosen  = pendingThemeId || current;
    themeList.innerHTML = "";
    for (const t of window.__themes) {
      const on = t.id === chosen;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "theme-row" + (on ? " is-on" : "");
      row.setAttribute("role", "radio");
      row.setAttribute("aria-checked", on ? "true" : "false");

      // A swatch pair — the theme's own background and accent — so the choice
      // can be made by eye rather than by reading four colour names.
      const sw = document.createElement("span");
      sw.className = "theme-swatch";
      sw.dataset.theme = t.theme;
      sw.dataset.palette = t.palette;
      sw.setAttribute("aria-hidden", "true");
      row.appendChild(sw);

      const txt = document.createElement("span");
      txt.className = "theme-row-text";
      const lab = document.createElement("span");
      lab.className = "theme-row-label";
      lab.textContent = t.label + (t.id === current ? " · in use" : "");
      const note = document.createElement("span");
      note.className = "theme-row-note";
      note.textContent = t.note;
      txt.appendChild(lab); txt.appendChild(note);
      row.appendChild(txt);

      const tick = document.createElement("span");
      tick.className = "theme-row-check";
      tick.setAttribute("aria-hidden", "true");
      tick.textContent = on ? "✓" : "";
      row.appendChild(tick);

      row.addEventListener("click", () => {
        pendingThemeId = t.id;
        renderThemeList();
      });
      themeList.appendChild(row);
    }
    const dirty = !!pendingThemeId && pendingThemeId !== current;
    if (themeApply) themeApply.disabled = !dirty;
    if (themeHint) themeHint.textContent = dirty ? "Not applied yet" : "";
  }

  if (themeApply) {
    themeApply.addEventListener("click", () => {
      if (!pendingThemeId || !window.__setTheme) return;
      window.__setTheme(pendingThemeId);
      pendingThemeId = null;
      renderThemeList();
      showToast("Theme applied");
    });
  }

  // Sample rate on the artwork. No Apply button and no reload: the value is
  // already on every tile, so the switch is a class on <body> and takes effect
  // on the screen behind the settings sheet.
  const qualityToggle = document.getElementById("quality-toggle");
  if (qualityToggle) {
    qualityToggle.checked = window.__showQuality ? window.__showQuality() : false;
    qualityToggle.addEventListener("change", () => {
      if (window.__setShowQuality) window.__setShowQuality(qualityToggle.checked);
    });
  }


  // ----- Smart Picks -----------------------------------------------------
  // The build reaches three external services and then hands Roon a batch of
  // albums to import, so WHEN it runs is a real setting rather than a nicety:
  // 4am costs nothing, the same work at 8pm competes with whatever Roon is
  // doing while somebody is listening.
  const picksHour    = document.getElementById("picks-hour");
  const picksAutoAdd = document.getElementById("picks-autoadd");
  const picksRebuild = document.getElementById("picks-rebuild");
  const picksNote    = document.getElementById("picks-service-note");

  if (picksHour && !picksHour.options.length) {
    for (let h = 0; h < 24; h++) {
      const o = document.createElement("option");
      o.value = String(h);
      o.textContent = (h < 10 ? "0" + h : String(h)) + ":00";
      picksHour.appendChild(o);
    }
  }

  async function saveSmartPicksSettings(patch) {
    try {
      const r = await fetch("/api/settings/smart-picks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const j = await r.json();
      if (!r.ok || j.error) { showToast(j.error || "Couldn't save", "error"); return false; }
      return true;
    } catch (e) {
      showToast("Couldn't save: " + e.message, "error");
      return false;
    }
  }

  const picksEnabled = document.getElementById("picks-enabled");

  async function loadSmartPicksSettings() {
    if (!picksHour && !picksAutoAdd && !picksEnabled) return;
    try {
      const r = await fetch("/api/settings/smart-picks");
      if (!r.ok) return;
      const j = await r.json();
      if (picksEnabled) picksEnabled.checked = !!j.enabled;
      // A device that was not the one that flipped the switch catches up here.
      if (window.__applyFeatureMenu) window.__applyFeatureMenu({ picks: !!j.enabled });
      if (picksHour && Number.isFinite(j.hour)) picksHour.value = String(j.hour);
      if (picksAutoAdd) picksAutoAdd.checked = !!j.auto_add;
      if (picksNote) {
        picksNote.textContent = j.service_ready
          ? "Picks you were not offered automatically are always yours to accept or reject."
          : "Connect Qobuz or TIDAL under Streaming accounts first — without one, picks can be shown but not added.";
      }
    } catch (e) {
      // Settings simply show their last values; the pane is not the place to
      // report a transient fetch failure.
    }
  }

  if (picksEnabled) {
    picksEnabled.addEventListener("change", async () => {
      const on = picksEnabled.checked;
      if (await saveSmartPicksSettings({ enabled: on })) {
        showToast(on ? "Smart Picks on — the first set builds at the scheduled hour"
                     : "Smart Picks off — nothing runs in the background");
        if (window.__applyFeatureMenu) window.__applyFeatureMenu({ picks: on });
      } else {
        picksEnabled.checked = !on;   // the server refused — do not lie about it
      }
    });
  }

  if (picksHour) {
    picksHour.addEventListener("change", async () => {
      const h = parseInt(picksHour.value, 10);
      if (await saveSmartPicksSettings({ hour: h })) {
        showToast("Smart Picks will build at " + (h < 10 ? "0" + h : h) + ":00");
      }
    });
  }
  if (picksAutoAdd) {
    picksAutoAdd.addEventListener("change", async () => {
      const on = picksAutoAdd.checked;
      if (await saveSmartPicksSettings({ auto_add: on })) {
        showToast(on ? "Picks will be added automatically"
                     : "Every pick will ask before adding");
      } else {
        picksAutoAdd.checked = !on;   // the server refused — do not lie about it
      }
    });
  }
  if (picksRebuild) {
    picksRebuild.addEventListener("click", async () => {
      picksRebuild.disabled = true;
      const orig = picksRebuild.textContent;
      picksRebuild.textContent = "…";
      try {
        const r = await fetch("/api/smart-picks/rebuild", { method: "POST" });
        const j = await r.json().catch(() => ({}));
        showToast(r.ok ? "Rebuilding today's picks — check back in a minute"
                       : (j.error || "Couldn't rebuild"), r.ok ? "ok" : "error");
      } catch (e) {
        showToast("Couldn't rebuild: " + e.message, "error");
      } finally {
        picksRebuild.disabled = false;
        picksRebuild.textContent = orig;
      }
    });
  }

  // ----- Labels on/off -----
  const labelsEnabledEl = document.getElementById("labels-enabled");
  const labelsEnabledNote = document.getElementById("labels-enabled-note");
  async function loadLabelsEnabled() {
    if (!labelsEnabledEl) return;
    try {
      const r = await fetch("/api/settings/labels");
      if (!r.ok) return;
      const j = await r.json();
      labelsEnabledEl.checked = !!j.enabled;
      if (window.__applyFeatureMenu) window.__applyFeatureMenu({ labels: !!j.enabled });
      if (labelsEnabledNote) {
        labelsEnabledNote.textContent = j.enabled
          ? (j.scanning ? "Scanning now…"
             : (j.count ? j.count + " label" + (j.count === 1 ? "" : "s") + " found."
                        : "No labels yet — the first scan runs in the background."))
          : "Off. Your /music tags are still read, so the Decade, Format and quality filters keep working.";
      }
    } catch (e) { /* keep the last shown value */ }
  }
  if (labelsEnabledEl) {
    labelsEnabledEl.addEventListener("change", async () => {
      const on = labelsEnabledEl.checked;
      try {
        const r = await fetch("/api/settings/labels", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: on })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(j.error || "Couldn't save");
        showToast(on ? "Labels on — the first scan is running now"
                     : "Labels off — no label lookups will run");
        if (window.__applyFeatureMenu) window.__applyFeatureMenu({ labels: on });
        loadLabelsEnabled();
      } catch (e) {
        labelsEnabledEl.checked = !on;   // the server refused — do not lie about it
        showToast(e.message, "error");
      }
    });
  }

  // ----- Home Screen: which rows show, and in what order -----
  //
  // Rendered from the same HOME_ROWS table the Home screen itself loops, via
  // the globals below, so a row can never appear in one and not the other.
  const homeRowsList = document.getElementById("home-rows-list");
  let homeRowsDraft = [];

  function renderHomeRowsList() {
    if (!homeRowsList) return;
    homeRowsList.innerHTML = "";
    const titles = window.__homeRowTitles ? window.__homeRowTitles() : {};
    for (const row of homeRowsDraft) {
      const li = document.createElement("li");
      li.className = "home-row-item";
      li.dataset.row = row.id;

      const grip = document.createElement("span");
      grip.className = "home-row-grip";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⠿";

      // A row whose FEATURE is off is not a layout choice. It reads as off and
      // cannot be switched on here, because switching it on would do nothing —
      // the row has no data to show. `row.on` is deliberately left ALONE, so
      // turning Smart Picks or Labels back on restores the Home screen the user
      // had rather than one this screen quietly rewrote.
      const off = row.unavailable || null;
      if (off) li.classList.add("is-unavailable");

      const name = document.createElement("span");
      name.className = "home-row-name";
      name.textContent = titles[row.id] || row.id;
      if (off) {
        const why = document.createElement("span");
        why.className = "home-row-why";
        why.textContent = off;
        name.appendChild(why);
      }

      const sw = document.createElement("label");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !off && row.on !== false;
      cb.disabled = !!off;
      cb.setAttribute("aria-label", (titles[row.id] || row.id) + " row");
      cb.addEventListener("change", () => {
        row.on = cb.checked;
        saveHomeRows();
      });
      const track = document.createElement("span");
      track.className = "switch-track";
      const thumb = document.createElement("span");
      thumb.className = "switch-thumb";
      track.appendChild(thumb);
      sw.appendChild(cb); sw.appendChild(track);

      li.appendChild(grip); li.appendChild(name); li.appendChild(sw);
      attachRowDrag(li, grip);
      homeRowsList.appendChild(li);
    }
  }

  // Hold the grip, then drag. Pointer events so one code path covers touch and
  // mouse; the list reorders live under the finger and the draft array is
  // rewritten from the DOM on drop, so the two can never disagree.
  function attachRowDrag(li, grip) {
    let dragging = false;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      li.classList.add("is-dragging");
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging || !homeRowsList) return;
      // Which sibling is under the pointer? Compare against each row's middle
      // so the swap happens when the dragged row has genuinely passed it,
      // rather than flickering on every pixel.
      const items = [...homeRowsList.querySelectorAll(".home-row-item")];
      for (const other of items) {
        if (other === li) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if (e.clientY < mid && other.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING) {
          homeRowsList.insertBefore(li, other);
          break;
        }
        if (e.clientY > mid && other.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_PRECEDING) {
          homeRowsList.insertBefore(li, other.nextSibling);
          break;
        }
      }
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      li.classList.remove("is-dragging");
      // The DOM is the truth now — read the order back out of it rather than
      // trying to mirror every move into the array as it happened.
      if (homeRowsList) {
        const order = [...homeRowsList.querySelectorAll(".home-row-item")].map(x => x.dataset.row);
        homeRowsDraft.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      }
      saveHomeRows();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  async function saveHomeRows() {
    try {
      const r = await fetch("/api/settings/home-rows", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: homeRowsDraft })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || "Couldn't save");
      if (Array.isArray(j.rows)) {
        homeRowsDraft = j.rows;
        // REDRAW. The server answers with freshly built {id,on} objects, so
        // replacing the array orphaned every checkbox handler still closing
        // over the previous one — after one save, every further toggle
        // mutated a discarded object and was silently dropped, and after a
        // drag the whole list went dead. The list is cheap; rebuild it.
        renderHomeRowsList();
      }
      // Apply immediately — the Home screen is behind this sheet, and a layout
      // that only takes effect on the next launch reads as a broken control.
      if (window.__applyHomeLayout) window.__applyHomeLayout(homeRowsDraft);
    } catch (e) {
      showToast(e.message, "error");
      loadHomeRowsSettings();   // resync from the server rather than keep a lie
    }
  }

  async function loadHomeRowsSettings() {
    if (!homeRowsList) return;
    try {
      const r = await fetch("/api/settings/home-rows");
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.rows)) homeRowsDraft = j.rows;
    } catch (e) { /* keep whatever is drawn */ }
    renderHomeRowsList();
  }

  const open = () => { showView("home"); pendingThemeId = null; renderThemeList(); loadRadio(); loadVersion(); loadDiscogsToken(); loadFanartKey(); loadDisplaySettings(); loadLabelFolderDepth(); loadQobuzStatus(); loadTidalStatus(); loadSmartPicksSettings(); loadLabelsEnabled(); loadHomeRowsSettings(); overlay.classList.remove("hidden"); };
  const close = () => {
    overlay.classList.add("hidden");
    // Closing Settings ends the client side of any pending Tidal device flow
    // (the server keeps polling Tidal; reopening Settings shows the outcome).
    if (tidalPollTimer) finishTidalAuth();
  };

  openBtn.addEventListener("click", open);
  overlay.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-settings-close")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || overlay.classList.contains("hidden")) return;
    // Escape steps back one level: pane → home, home → closed.
    if (atHome()) close();
    else showView("home");
  });
})();

/* ------------------------------------------------------------------ */
/*  Streaming-service browser factory — self-contained overlay (tabs,  */
/*  search, artists, album detail + favourite). Instantiated once per  */
/*  service (Qobuz, Tidal) below; each instance owns its closure state */
/*  (viewStack, reqSeq, timers) so the two overlays never interact.    */
/*  Isolated from the album grid / labels / filters; uses only the     */
/*  service's API endpoints and window.__showToast.                    */
/*                                                                     */
/*  cfg: {                                                             */
/*    service          "qobuz" | "tidal" (internal identifier)         */
/*    serviceName      display name for toasts ("Qobuz" / "Tidal")     */
/*    idPrefix         element-id prefix ("qobuz-…" / "tidal-…")       */
/*    apiBase          "/api/qobuz" | "/api/tidal"                     */
/*    historyKey       key used in history.pushState state objects —   */
/*                     "qz" (pre-factory value, kept so Qobuz behaves  */
/*                     byte-identically) | "td"                        */
/*    closeAttr        data attribute on the overlay's close targets   */
/*    notConnectedMsg  status text when the API says "not connected"   */
/*    tabs             [{ id, label, kind }] — kind "new-releases"     */
/*                     hits /new-releases?days=30, kind "featured"     */
/*                     hits /featured?type=<id>. tabs[0] is the        */
/*                     default tab shown when the overlay opens.       */
/*  }                                                                  */
/* ------------------------------------------------------------------ */
function initServiceBrowser(cfg) {
  const byId = (suffix) => document.getElementById(cfg.idPrefix + suffix);
  const btn          = byId("-toggle");
  const overlay      = byId("-overlay");
  const listEl       = byId("-nr-list");
  const statusEl     = byId("-nr-status");
  const detailEl     = byId("-nr-detail");
  const searchInput  = byId("-search-input");
  const searchClear  = byId("-search-clear");
  const tabsEl       = byId("-tabs");
  const artistHeadEl = byId("-artist-head");
  const artistsEl    = byId("-artists");
  const loadMoreEl   = byId("-load-more");
  // Both overlays share the .qobuz-* CSS classes (only ids differ), so the
  // class-based lookups below work for every instance.
  const searchRowEl  = overlay ? overlay.querySelector(".qobuz-search-row") : null;
  if (!btn || !overlay) return;

  const defaultTab = cfg.tabs[0].id;

  const PAGE_SIZE = 50;

  const toast = (msg, kind) => { if (window.__showToast) window.__showToast(msg, kind); };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const overlayVisible = () => !overlay.classList.contains("hidden");

  // View stack — one entry per history level pushed while the overlay is open.
  // Each entry: { kind: 'tab', tab } | { kind: 'search', query }
  //           | { kind: 'artist', artistId, artistName } | { kind: 'detail', album, rowFavBtn }
  // plus bookkeeping set while shown: loaded (fetch completed), offset/hasMore/
  // limit (paged views), snapshot (rendered list DOM saved when an artist view
  // covers this one — see snapshotListInto/restoreSnapshot).
  // Invariant: entry N was created by the history.pushState carrying
  // {[cfg.historyKey]: N+1…}, so history.state[historyKey] always equals the
  // stack depth for the current entry.
  // The popstate handler RECONCILES against that depth rather than blindly
  // popping once, which keeps the stack correct across Forward presses and
  // multi-step history jumps. Tab switches and new searches REPLACE the top
  // entry (no push) — they are siblings, not depth.
  let viewStack = [];
  const currentView = () => viewStack[viewStack.length - 1] || null;

  // Last tab the user explicitly selected — where clearing the search returns to.
  let activeTab = defaultTab;

  // Monotonic request counter: every render/loadMore bumps it and any response
  // arriving after a newer request started is dropped (out-of-order guard).
  let reqSeq = 0;

  let searchTimer = null;

  function clearSearchTimer() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  }

  function clearDetail() {
    if (detailEl) { detailEl.classList.add("hidden"); detailEl.innerHTML = ""; detailEl.dataset.albumId = ""; }
  }

  // Empty the shared list containers (rows, artist strip/header, load-more).
  // During a view change this runs only once the fetch outcome (results, empty,
  // or error) is ready — never before the fetch — so the previous rows stay on
  // screen under the "Searching…"/"Loading…" status instead of the content area
  // blanking while a request is in flight.
  function resetListContainers() {
    if (listEl) listEl.innerHTML = "";
    if (artistHeadEl) { artistHeadEl.classList.add("hidden"); artistHeadEl.innerHTML = ""; }
    if (artistsEl) { artistsEl.classList.add("hidden"); artistsEl.innerHTML = ""; }
    if (loadMoreEl) loadMoreEl.classList.add("hidden");
  }

  // Reset the search box UI (text, × visibility, pending debounce) WITHOUT
  // navigating — for callers about to render a view of their own (tab click,
  // overlay open). clearSearch() adds the return-to-tab navigation on top.
  function resetSearchBox() {
    if (searchInput) searchInput.value = "";
    if (searchClear) searchClear.classList.add("hidden");
    clearSearchTimer();
  }

  // Cancel the search: empty the box, drop any pending debounce, and return to
  // the last active tab. Shared by the × clear button and the Escape key.
  function clearSearch() {
    resetSearchBox();
    applySearch("");
  }

  // Fully hide the overlay (and any open detail). Called only from the popstate
  // handler when the view stack empties — never directly from a close affordance,
  // so viewStack and the history stack can never get out of step.
  function hideOverlay() {
    overlay.classList.add("hidden");
    viewStack = [];
    reqSeq++; // orphan any in-flight fetch — a late response must not repopulate the hidden overlay
    clearSearchTimer();
    clearDetail();
    // Drop this session's rows/status now — the deferred-clear render path
    // would otherwise show them again on the next open while its first
    // request is still in flight.
    resetListContainers();
    if (statusEl) statusEl.textContent = "";
  }

  // All back/close affordances (× button, backdrop, ‹ Back, Esc) step back one
  // history level via history.back(), which the popstate handler turns into
  // detail → list → … → closed. This also makes the Android/browser back button
  // behave naturally instead of leaving the page.
  const goBack = () => history.back();

  overlay.querySelectorAll("[" + cfg.closeAttr + "]").forEach(el => el.addEventListener("click", goBack));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !overlayVisible()) return;
    // Escape while typing must never navigate the overlay away. Staged:
    // 1st press (text present) clears the box — same action as the × button —
    // keeping focus so the user can retype; 2nd press (box empty) just blurs;
    // only with the input unfocused does Escape step back / close.
    if (searchInput && document.activeElement === searchInput) {
      if (searchInput.value) clearSearch();
      else searchInput.blur();
      return;
    }
    goBack();
  });

  // Browser / Android back (and Forward): while the overlay is open, reconcile
  // the view stack against the depth stored in history.state instead of blindly
  // popping once — Forward presses and multi-step jumps then self-heal rather
  // than corrupting the stack. No-op when the overlay isn't open, so the rest
  // of the app (which uses no history state) — including the OTHER service's
  // browser — is unaffected. Each instance reads only its own historyKey: a
  // state carrying just the other service's key (or no state at all) counts as
  // depth 0 for this instance, and depth 0 while this overlay is visible means
  // "backed out past this overlay's root" — close it. That is exactly the
  // pre-factory close-on-back behaviour, and it is safe cross-service because
  // every history entry pushed while this overlay is open carries this
  // instance's key (pushState truncates any forward entries the other overlay
  // left behind, so a foreign-key state can only ever sit BELOW this overlay's
  // root — where closing is the correct response).
  window.addEventListener("popstate", (e) => {
    if (!overlayVisible()) return;
    const depth = (e.state && Number.isFinite(e.state[cfg.historyKey])) ? e.state[cfg.historyKey] : 0;
    if (depth >= viewStack.length) {
      // Forward into a history entry whose view we already discarded — bounce
      // back to the deepest view we still have. The resulting popstate lands
      // exactly on depth === viewStack.length and no-ops.
      if (depth > viewStack.length) history.go(viewStack.length - depth);
      return;
    }
    const popped = currentView();
    viewStack.length = depth;
    if (!viewStack.length) { hideOverlay(); return; }
    const top = currentView();
    // A view covered by an artist push had its rendered list saved — restore
    // it without refetching (keeps loaded pages + scroll position).
    if (top.snapshot) { restoreSnapshot(top); return; }
    // Leaving a detail view: the list underneath is still intact in the DOM
    // (detail only hides it), so just restore visibility — no refetch.
    if (popped && popped.kind === "detail") { restoreListAfterDetail(top); return; }
    render(top);
  });

  // Push a deeper view (detail or artist): one viewStack entry + one history entry.
  function pushView(view) {
    const covered = currentView();
    // An artist view re-renders the shared list DOM, so save the covered list
    // view's rendered state first for an instant, fetch-free back. (Detail
    // views only hide the list — no snapshot needed. Views that never finished
    // loading have nothing worth saving; back will refetch them instead.)
    if (view.kind === "artist" && covered && covered.kind !== "detail" && covered.loaded) {
      snapshotListInto(covered);
    }
    viewStack.push(view);
    history.pushState({ [cfg.historyKey]: viewStack.length }, "");
    render(view);
  }

  // Replace the top view (tab switch, new search): no history entry, so the
  // 1:1 viewStack ↔ history invariant is preserved.
  function replaceTop(view) {
    if (!viewStack.length) return;
    viewStack[viewStack.length - 1] = view;
    render(view);
  }

  // Reflect favourite state on a button (added = in the user's service library).
  function setFavState(button, added) {
    button.dataset.fav = added ? "1" : "0";
    button.textContent = added ? "✓ Added" : "♥ Favourite";
    button.classList.toggle("is-done", added);
  }

  // Toggle favourite/un-favourite against the service, updating every button
  // that represents this album (the list row and, if open, the detail view) so
  // they stay in sync. `buttons` may be a single button or an array.
  async function toggleFavourite(albumId, buttons) {
    const btns = (Array.isArray(buttons) ? buttons : [buttons]).filter(Boolean);
    if (!btns.length) return;
    const wasAdded = btns[0].dataset.fav === "1";
    const prev = btns.map(b => b.textContent);
    btns.forEach(b => { b.disabled = true; b.textContent = "…"; });
    try {
      const r = await fetch(cfg.apiBase + (wasAdded ? "/unfavorite" : "/favorite"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ album_id: albumId })
      });
      const j = await r.json();
      if (j.ok) {
        btns.forEach(b => setFavState(b, !wasAdded));
        toast(wasAdded
          ? ("Removed from " + cfg.serviceName + " favourites")
          : ("Added to " + cfg.serviceName + " favourites"), "ok");
      } else {
        btns.forEach((b, i) => { b.textContent = prev[i]; });
        toast(j.error || "Couldn't update favourite", "error");
      }
    } catch (e) {
      btns.forEach((b, i) => { b.textContent = prev[i]; });
      toast("Failed: " + e.message, "error");
    } finally {
      btns.forEach(b => { b.disabled = false; });
    }
  }

  // Highlight the active tab chip. While a search / artist / detail view is on
  // top, no chip is highlighted.
  function updateTabActive() {
    if (!tabsEl) return;
    const top = currentView();
    const active = top && top.kind === "tab" ? top.tab : null;
    tabsEl.querySelectorAll(".qobuz-tab").forEach(t =>
      t.classList.toggle("is-active", t.dataset.qtab === active));
  }

  // Muted edition/version suffix ("Deluxe Edition" …) shown after a title.
  const versionHtml = (a) =>
    a.version ? ' <span class="qobuz-nr-version">' + esc(a.version) + '</span>' : '';

  // Build one album row (art, title [+ version], artist, date, favourite button;
  // row tap → detail). Shared by every list-type view.
  function buildAlbumRow(a) {
    const row = document.createElement("div");
    row.className = "qobuz-nr-row";
    const art = a.image
      ? '<img class="qobuz-nr-art" loading="lazy" alt="" src="' + esc(a.image) + '">'
      : '<div class="qobuz-nr-art"></div>';
    const date = a.release_date ? '<div class="qobuz-nr-date">' + esc(a.release_date) + '</div>' : '';
    row.innerHTML = art +
      '<div class="qobuz-nr-meta">' +
        '<div class="qobuz-nr-title">'  + esc(a.title) + versionHtml(a) + '</div>' +
        '<div class="qobuz-nr-artist">' + esc(a.artist) + '</div>' +
        date +
      '</div>';
    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "qobuz-nr-fav";
    // Tappable toggle: "✓ Added" (in library) ⇄ "♥ Favourite". Initial state
    // reflects the user's current service favourites (added here or elsewhere).
    setFavState(fav, !!a.favourited);
    fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFavourite(a.id, fav); });
    row.appendChild(fav);
    // Tapping the row (anywhere but the favourite button) opens the detail view.
    row.addEventListener("click", () => pushView({ kind: "detail", album: a, rowFavBtn: fav }));
    return row;
  }

  function appendAlbumRows(albums) {
    if (!listEl) return;
    const frag = document.createDocumentFragment();
    for (const a of albums) frag.appendChild(buildAlbumRow(a));
    listEl.appendChild(frag);
  }

  // Artist matches strip shown above search results (offset 0 only).
  function renderArtistStrip(artists) {
    if (!artistsEl) return;
    artistsEl.innerHTML = "";
    if (!artists.length) { artistsEl.classList.add("hidden"); return; }
    for (const ar of artists) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "qobuz-artist-chip";
      chip.innerHTML =
        (ar.image
          ? '<img class="qobuz-artist-thumb" loading="lazy" alt="" src="' + esc(ar.image) + '">'
          : '<div class="qobuz-artist-thumb"></div>') +
        '<span class="qobuz-artist-name">' + esc(ar.name) + '</span>';
      chip.addEventListener("click", () =>
        pushView({ kind: "artist", artistId: ar.id, artistName: ar.name }));
      artistsEl.appendChild(chip);
    }
    artistsEl.classList.remove("hidden");
  }

  // Artist discography header: ‹ Back affordance (same as detail) + round thumb + name.
  function renderArtistHead(image, name) {
    if (!artistHeadEl) return;
    artistHeadEl.innerHTML = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "qobuz-nr-back";
    back.textContent = "‹ Back";
    back.addEventListener("click", goBack);
    const head = document.createElement("div");
    head.className = "qobuz-artist-head-row";
    head.innerHTML =
      (image
        ? '<img class="qobuz-artist-head-art" alt="" src="' + esc(image) + '">'
        : '<div class="qobuz-artist-head-art"></div>') +
      '<div class="qobuz-artist-head-name">' + esc(name) + '</div>';
    artistHeadEl.appendChild(back);
    artistHeadEl.appendChild(head);
    artistHeadEl.classList.remove("hidden");
  }

  // Restore the list chrome after popping a detail view. The underlying list
  // DOM (rows, artist strip/header, load-more state) was only hidden, never
  // cleared, so this is pure visibility work — no refetch.
  function restoreListAfterDetail(top) {
    // Exception: with deferred clearing, stale rows stay clickable while a
    // request is in flight, so a detail can be opened from a view whose fetch
    // was then orphaned (reqSeq bumped) before it ever loaded. Restoring
    // visibility would present the PREVIOUS view's rows under a stuck
    // "Searching…"/"Loading…" status — refetch the view instead.
    if (!top.loaded) { render(top); return; }
    clearDetail();
    if (searchRowEl) searchRowEl.classList.remove("hidden");
    if (tabsEl) tabsEl.classList.remove("hidden");
    if (statusEl) statusEl.classList.remove("hidden");
    if (listEl) listEl.classList.remove("hidden");
    if (artistHeadEl) artistHeadEl.classList.toggle("hidden", top.kind !== "artist");
    if (artistsEl) artistsEl.classList.toggle("hidden",
      !(top.kind === "search" && artistsEl.childElementCount > 0));
    if (loadMoreEl) loadMoreEl.classList.toggle("hidden", !top.hasMore);
    syncChrome(top);
  }

  // Save a rendered list view's DOM (rows, artist strip/header, status,
  // load-more state) onto its stack entry before an artist view takes over the
  // shared containers. Moving nodes into fragments keeps their listeners alive.
  function snapshotListInto(view) {
    const snap = {
      list:          document.createDocumentFragment(),
      artists:       document.createDocumentFragment(),
      head:          document.createDocumentFragment(),
      artistsHidden: artistsEl ? artistsEl.classList.contains("hidden") : true,
      headHidden:    artistHeadEl ? artistHeadEl.classList.contains("hidden") : true,
      status:        statusEl ? statusEl.textContent : "",
      loadMoreHidden: loadMoreEl ? loadMoreEl.classList.contains("hidden") : true
    };
    if (listEl) while (listEl.firstChild) snap.list.appendChild(listEl.firstChild);
    if (artistsEl) while (artistsEl.firstChild) snap.artists.appendChild(artistsEl.firstChild);
    if (artistHeadEl) while (artistHeadEl.firstChild) snap.head.appendChild(artistHeadEl.firstChild);
    view.snapshot = snap;
  }

  // Put a snapshotted list view back on screen — no refetch, loaded pages and
  // favourite-button state (live nodes) survive intact.
  function restoreSnapshot(view) {
    const snap = view.snapshot;
    view.snapshot = null;
    reqSeq++; // orphan any in-flight fetch owned by the view being discarded
    clearDetail();
    if (searchRowEl) searchRowEl.classList.remove("hidden");
    if (tabsEl) tabsEl.classList.remove("hidden");
    if (statusEl) { statusEl.classList.remove("hidden"); statusEl.textContent = snap.status; }
    if (listEl) { listEl.innerHTML = ""; listEl.appendChild(snap.list); listEl.classList.remove("hidden"); }
    if (artistHeadEl) {
      artistHeadEl.innerHTML = "";
      artistHeadEl.appendChild(snap.head);
      artistHeadEl.classList.toggle("hidden", snap.headHidden);
    }
    if (artistsEl) {
      artistsEl.innerHTML = "";
      artistsEl.appendChild(snap.artists);
      artistsEl.classList.toggle("hidden", snap.artistsHidden);
    }
    if (loadMoreEl) loadMoreEl.classList.toggle("hidden", snap.loadMoreHidden);
    syncChrome(view);
  }

  // Keep the search box, its clear button, and the tab chips consistent with
  // the view being shown — a popstate can resurface a search whose text a tab
  // switch cleared, and vice versa. Never fight live typing: the input is left
  // alone while focused.
  function syncChrome(view) {
    updateTabActive();
    if (!searchInput) return;
    if (document.activeElement !== searchInput) {
      if (view.kind === "search") searchInput.value = view.query;
      else if (view.kind === "tab") searchInput.value = "";
    }
    if (searchClear) searchClear.classList.toggle("hidden", !searchInput.value);
  }

  // fetch + JSON with a clean error path: non-JSON bodies (proxy or maintenance
  // HTML pages) surface as "HTTP nnn" instead of a JSON SyntaxError message.
  async function qFetch(url) {
    const r = await fetch(url);
    let j = null;
    try { j = await r.json(); } catch (e) { /* non-JSON body — handled below via r.ok/status */ }
    if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
    return j || {};
  }

  // Isolated detail view for a service album: artwork, editorial review
  // (fetched by title+artist via the service-independent /api/album/extras —
  // no Roon needed, works for any catalogue), and a favourite toggle kept in
  // sync with the originating list row's button.
  async function renderDetail(album, rowFavBtn) {
    if (!detailEl) return;
    detailEl.innerHTML = "";
    detailEl.dataset.albumId = album.id;

    const back = document.createElement("button");
    back.type = "button";
    back.className = "qobuz-nr-back";
    back.textContent = "‹ Back";
    back.addEventListener("click", goBack);

    const head = document.createElement("div");
    head.className = "qobuz-nr-detail-head";
    head.innerHTML =
      (album.image
        ? '<img class="qobuz-nr-detail-art" alt="" src="' + esc(album.image) + '">'
        : '<div class="qobuz-nr-detail-art"></div>') +
      '<div class="qobuz-nr-detail-meta">' +
        '<div class="qobuz-nr-detail-title">' + esc(album.title) + versionHtml(album) + '</div>' +
        '<div class="qobuz-nr-detail-artist">' + esc(album.artist) + '</div>' +
        (album.release_date ? '<div class="qobuz-nr-date">' + esc(album.release_date) + '</div>' : '') +
      '</div>';

    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "qobuz-nr-fav";
    setFavState(favBtn, rowFavBtn && rowFavBtn.dataset.fav === "1");
    favBtn.addEventListener("click", () => toggleFavourite(album.id, [favBtn, rowFavBtn]));

    const review = document.createElement("div");
    review.className = "qobuz-nr-review";
    review.textContent = "Loading review…";

    detailEl.appendChild(back);
    detailEl.appendChild(head);
    detailEl.appendChild(favBtn);
    detailEl.appendChild(review);
    detailEl.classList.remove("hidden");

    try {
      const params = new URLSearchParams({ title: album.title || "", artist: album.artist || "" });
      const r = await fetch("/api/album/extras?" + params.toString());
      const j = await r.json().catch(() => ({}));
      // Guard against a fast back→open switching the detail to another album.
      if (detailEl.dataset.albumId !== String(album.id)) return;
      const alb = j && j.album;
      const desc = alb && alb.description;
      review.innerHTML = "";
      if (desc) {
        // desc is only ever Qobuz/Wikipedia editorial now — Pitchfork review
        // text is stripped server-side (UK-law compliance).
        const p = document.createElement("div");
        p.className = "qobuz-nr-review-text";
        p.textContent = desc;
        review.appendChild(p);
      } else if (alb && alb.source === "Pitchfork" && alb.url) {
        review.textContent = "Pitchfork reviewed this release — read it on pitchfork.com.";
      } else {
        review.textContent = "No review available for this release.";
      }
      // The source link renders with OR without text — with Pitchfork the
      // link IS the review access, so it must not hide behind if(desc).
      if (alb && alb.url && alb.source) {
        const link = document.createElement("a");
        link.className = "qobuz-nr-review-src";
        link.href = alb.url; link.target = "_blank"; link.rel = "noopener";
        link.textContent = alb.source === "Pitchfork"
          ? "Read the review on Pitchfork"
          : "View on " + alb.source;
        review.appendChild(link);
      }
    } catch (e) {
      if (detailEl.dataset.albumId === String(album.id)) review.textContent = "Couldn't load review.";
    }
  }

  // Single dispatcher: renders whatever view is on top of the stack.
  async function render(view) {
    const seq = ++reqSeq;
    // Any view change invalidates a pending debounced search — without this, a
    // timer set while typing could fire after the user navigated (e.g. into a
    // detail view) and replace what they're looking at with search results.
    clearSearchTimer();
    syncChrome(view);

    if (view.kind === "detail") {
      // Detail takes over the sheet: hide the list chrome but leave its DOM
      // intact so back is instant (see restoreListAfterDetail).
      [searchRowEl, tabsEl, statusEl, artistHeadEl, artistsEl, listEl, loadMoreEl]
        .forEach(el => { if (el) el.classList.add("hidden"); });
      renderDetail(view.album, view.rowFavBtn);
      return;
    }

    // Common chrome for list-type views (tab / search / artist). The list
    // containers are deliberately NOT cleared here: the previous rows stay
    // visible under the "Searching…"/"Loading…" status while the request is in
    // flight, and resetListContainers() swaps them out only once the outcome
    // (results, empty, or error) is known. The full-screen sheet plus this
    // deferred clear is what stops the overlay collapsing/jumping during a
    // search. The reqSeq guard already drops stale responses, so an old view's
    // rows can never be appended into the new view.
    clearDetail();
    if (searchRowEl) searchRowEl.classList.remove("hidden");
    if (tabsEl) tabsEl.classList.remove("hidden");
    if (statusEl) statusEl.classList.remove("hidden");
    if (listEl) listEl.classList.remove("hidden");
    // Chrome that ACTS on the outgoing view must not stay live while the
    // replacement view's request is in flight: the artist header's ‹ Back
    // would pop a level below the view just selected, and Load more would
    // page a list that's about to be replaced. Rows and artist chips stay —
    // taps on them push views that self-heal (see restoreListAfterDetail).
    if (artistHeadEl) artistHeadEl.classList.add("hidden");
    if (loadMoreEl) loadMoreEl.classList.add("hidden");

    try {
      // Tab endpoints come from cfg.tabs: the "new-releases" kind has its own
      // endpoint + status wording; every other tab is a /featured?type=<id>.
      const tabDef = view.kind === "tab" ? cfg.tabs.find(t => t.id === view.tab) : null;
      if (view.kind === "tab" && tabDef && tabDef.kind === "new-releases") {
        if (statusEl) statusEl.textContent = "Loading new releases…";
        const j = await qFetch(cfg.apiBase + "/new-releases?days=30");
        if (seq !== reqSeq) return; // a newer view/request superseded this one
        resetListContainers();
        const albums = j.albums || [];
        view.loaded = true;
        if (statusEl) statusEl.textContent = albums.length
          ? (albums.length + " releases in the last " + (j.days || 30) + " days")
          : ("No new releases found in the last " + (j.days || 30) + " days.");
        appendAlbumRows(albums);
      } else if (view.kind === "tab") {
        if (statusEl) statusEl.textContent = "Loading…";
        const j = await qFetch(cfg.apiBase + "/featured?type=" + encodeURIComponent(view.tab));
        if (seq !== reqSeq) return; // superseded
        resetListContainers();
        const albums = j.albums || [];
        view.loaded = true;
        if (statusEl) statusEl.textContent = albums.length
          ? (albums.length + " albums")
          : "No albums found.";
        appendAlbumRows(albums);
      } else if (view.kind === "search") {
        if (statusEl) statusEl.textContent = "Searching…";
        const j = await qFetch(cfg.apiBase + "/search?q=" + encodeURIComponent(view.query) + "&offset=0");
        if (seq !== reqSeq) return; // superseded (e.g. user kept typing)
        resetListContainers();
        const albums = j.albums || [];
        const artists = j.artists || [];
        view.offset = 0;
        view.hasMore = !!j.has_more;
        view.limit = j.limit || PAGE_SIZE;
        view.loaded = true;
        renderArtistStrip(artists);
        if (statusEl) statusEl.textContent = albums.length
          ? ((j.total || albums.length) + " albums for “" + view.query + "”")
          : (artists.length
              ? ("No album matches for “" + view.query + "” — artists below")
              : ("No results for “" + view.query + "”"));
        appendAlbumRows(albums);
        if (loadMoreEl) loadMoreEl.classList.toggle("hidden", !view.hasMore);
      } else if (view.kind === "artist") {
        if (statusEl) statusEl.textContent = "Loading…";
        const j = await qFetch(cfg.apiBase + "/artist-albums?artist_id=" +
          encodeURIComponent(view.artistId) + "&offset=0");
        if (seq !== reqSeq) return; // superseded
        resetListContainers();
        const albums = j.albums || [];
        view.offset = 0;
        view.hasMore = !!j.has_more;
        view.limit = j.limit || PAGE_SIZE;
        view.loaded = true;
        const artist = j.artist || {};
        renderArtistHead(artist.image || null, artist.name || view.artistName || "");
        // Qobuz's editorial bio (same clamp/expand as the library artist view).
        if (j.biography && artistHeadEl) {
          const bio = document.createElement("div");
          bio.className = "artist-bio-body qobuz-artist-bio";
          const text = document.createElement("div");
          text.className = "bio-text";
          text.dataset.clipped = "true";
          text.textContent = j.biography;
          const foot = document.createElement("div");
          foot.className = "artist-bio-foot";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "bio-toggle hidden";
          toggle.textContent = "Show more";
          const src = document.createElement("span");
          src.className = "artist-bio-src";
          src.textContent = "Bio: Qobuz";
          foot.appendChild(toggle); foot.appendChild(src);
          bio.appendChild(text); bio.appendChild(foot);
          artistHeadEl.appendChild(bio);
          if (window.__setupBioToggle) window.__setupBioToggle(text, toggle);
        }
        if (statusEl) statusEl.textContent = albums.length
          ? ((j.total || albums.length) + " albums")
          : "No albums found.";
        appendAlbumRows(albums);
        if (loadMoreEl) loadMoreEl.classList.toggle("hidden", !view.hasMore);
      }
    } catch (e) {
      if (seq !== reqSeq) return; // superseded — a newer render owns the status line
      // The failed view owns the content area now — stale rows from the
      // previous view would be misleading under an error message, so clear.
      resetListContainers();
      const notConnected = /not connected/i.test(e.message);
      if (statusEl) statusEl.textContent = notConnected
        ? cfg.notConnectedMsg
        : ("Couldn't load: " + e.message);
    }
  }

  // Append the next page of a paged view (search / artist). offset advances by
  // the server's page limit; the server says whether more pages exist
  // (has_more) — it knows the raw page length, which the client cannot infer
  // once malformed items have been filtered out.
  async function loadMore() {
    const view = currentView();
    if (!view || (view.kind !== "search" && view.kind !== "artist") || !view.hasMore) return;
    if (!loadMoreEl || loadMoreEl.disabled) return;
    const seq = ++reqSeq;
    const nextOffset = (view.offset || 0) + (view.limit || PAGE_SIZE);
    loadMoreEl.disabled = true;
    loadMoreEl.textContent = "Loading…";
    try {
      const url = view.kind === "search"
        ? cfg.apiBase + "/search?q=" + encodeURIComponent(view.query) + "&offset=" + nextOffset
        : cfg.apiBase + "/artist-albums?artist_id=" + encodeURIComponent(view.artistId) + "&offset=" + nextOffset;
      const j = await qFetch(url);
      if (seq !== reqSeq) return; // superseded — the view was replaced meanwhile
      view.offset = nextOffset;
      view.hasMore = !!j.has_more;
      view.limit = j.limit || view.limit || PAGE_SIZE;
      appendAlbumRows(j.albums || []);
      loadMoreEl.classList.toggle("hidden", !view.hasMore);
    } catch (e) {
      if (seq === reqSeq) toast("Couldn't load more: " + e.message, "error");
    } finally {
      loadMoreEl.disabled = false;
      loadMoreEl.textContent = "Load more";
    }
  }
  if (loadMoreEl) loadMoreEl.addEventListener("click", loadMore);

  // Apply the current search box value: ≥2 chars starts/updates a search view;
  // an empty box returns from search to the last active tab. Always REPLACES
  // the top view (search is a sibling of the tabs, not a deeper level).
  function applySearch(q, explicit) {
    if (!overlayVisible() || !viewStack.length) return;
    const top = currentView();
    if (!q) {
      if (top.kind === "search") replaceTop({ kind: "tab", tab: activeTab });
      return;
    }
    if (q.length < 2) {
      // Too short for a useful catalog query. The debounce path just waits for
      // more input, but an explicit Enter deserves feedback, not silence.
      if (explicit && statusEl) statusEl.textContent = "Type at least 2 characters to search.";
      return;
    }
    if (top.kind === "search" && top.query === q) return; // unchanged
    replaceTop({ kind: "search", query: q });
  }

  if (searchInput) {
    // Debounced live search: 450 ms after the last keystroke.
    searchInput.addEventListener("input", () => {
      if (searchClear) searchClear.classList.toggle("hidden", !searchInput.value);
      clearSearchTimer();
      const q = searchInput.value.trim();
      if (!q) { applySearch(""); return; } // clearing reverts immediately
      searchTimer = setTimeout(() => { searchTimer = null; applySearch(q); }, 450);
    });
    // Enter searches immediately (and dismisses the mobile keyboard).
    searchInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearSearchTimer();
      applySearch(searchInput.value.trim(), true);
      searchInput.blur();
    });
  }

  if (searchClear) {
    searchClear.addEventListener("click", clearSearch);
  }

  if (tabsEl) {
    tabsEl.querySelectorAll(".qobuz-tab").forEach(t => t.addEventListener("click", () => {
      const tab = t.dataset.qtab;
      if (!tab || !viewStack.length) return;
      activeTab = tab;
      resetSearchBox();
      const top = currentView();
      if (top.kind === "tab" && top.tab === tab) { updateTabActive(); return; }
      replaceTop({ kind: "tab", tab });
    }));
  }

  btn.addEventListener("click", () => {
    if (overlayVisible()) return;
    activeTab = defaultTab;
    resetSearchBox();
    viewStack = [{ kind: "tab", tab: defaultTab }];
    history.pushState({ [cfg.historyKey]: 1 }, ""); // a back press from the root view closes the overlay
    overlay.classList.remove("hidden");
    render(currentView());
  });
}

initServiceBrowser({
  service:     "qobuz",
  serviceName: "Qobuz",
  idPrefix:    "qobuz",
  apiBase:     "/api/qobuz",
  historyKey:  "qz", // pre-factory key — kept so existing Qobuz history entries behave identically
  closeAttr:   "data-qobuz-close",
  notConnectedMsg: "Connect your Qobuz account in Settings to browse Qobuz.",
  tabs: [
    { id: "new-releases",  label: "New Releases",  kind: "new-releases" },
    { id: "best-sellers",  label: "Best Sellers",  kind: "featured" },
    { id: "most-streamed", label: "Most Streamed", kind: "featured" },
    { id: "press-awards",  label: "Press Awards",  kind: "featured" },
    { id: "editor-picks",  label: "Editor's Picks", kind: "featured" }
  ]
});

initServiceBrowser({
  service:     "tidal",
  serviceName: "Tidal",
  idPrefix:    "tidal",
  apiBase:     "/api/tidal",
  historyKey:  "td",
  closeAttr:   "data-tidal-close",
  notConnectedMsg: "Connect your Tidal account in Settings to browse Tidal.",
  tabs: [
    { id: "new-releases", label: "New Releases", kind: "new-releases" },
    { id: "top",          label: "Top Albums",   kind: "featured" },
    { id: "rising",       label: "Rising",       kind: "featured" },
    { id: "recommended",  label: "Recommended",  kind: "featured" }
  ]
});

/* ------------------------------------------------------------------ */
/*  Pitchfork magazine — full-page overlay (side menu → Pitchfork)     */
/*                                                                     */
/*  A self-contained module (does NOT reuse initServiceBrowser, so it  */
/*  can't regress Qobuz/Tidal). It mirrors that factory's proven       */
/*  history-aware back mechanics — every close/back goes through       */
/*  history.back(), and a popstate handler reconciles the view stack   */
/*  against history.state[HKEY] — so the Android/browser back button   */
/*  behaves naturally. Two views deep: a magazine list (tab) → a       */
/*  review detail. Handler no-ops while the overlay is closed, so the  */
/*  rest of the app is unaffected.                                     */
/* ------------------------------------------------------------------ */
(function initPitchfork() {
  const overlay  = document.getElementById("pitchfork-overlay");
  const trigger  = document.getElementById("pitchfork-toggle");
  const tabsEl   = document.getElementById("pitchfork-tabs");
  const statusEl = document.getElementById("pitchfork-status");
  const listEl   = document.getElementById("pitchfork-list");
  const detailEl = document.getElementById("pitchfork-detail");
  if (!overlay || !trigger || !listEl || !detailEl) return;

  const HKEY = "pf";
  let viewStack = [];          // [{kind:'tab',tab}] then optionally {kind:'detail',item}
  let reqSeq = 0;              // monotonic guard so a late fetch can't repaint a newer view
  let activeTab = "latest";
  const listCache = { latest: null, best: null };  // per-tab items, cached for the session

  const visible     = () => !overlay.classList.contains("hidden");
  const currentView = () => viewStack[viewStack.length - 1];
  const setStatus   = (m) => { if (statusEl) statusEl.textContent = m || ""; };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtScore(n) { return Number(n).toFixed(1); }   // toFixed already rounds to 1 dp

  function hideOverlay() {
    overlay.classList.add("hidden");
    viewStack = [];
    reqSeq++;                 // orphan any in-flight fetch
    listEl.innerHTML = "";
    detailEl.classList.add("hidden");
    detailEl.innerHTML = "";
    if (tabsEl) tabsEl.classList.remove("hidden");
    setStatus("");
  }

  const goBack = () => history.back();
  overlay.querySelectorAll("[data-pitchfork-close]").forEach(el => el.addEventListener("click", goBack));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && visible()) goBack();
  });

  window.addEventListener("popstate", (e) => {
    if (!visible()) return;
    const depth = (e.state && Number.isFinite(e.state[HKEY])) ? e.state[HKEY] : 0;
    if (depth >= viewStack.length) {
      if (depth > viewStack.length) history.go(viewStack.length - depth);
      return;
    }
    const popped = currentView();
    viewStack.length = depth;
    if (!viewStack.length) { hideOverlay(); return; }
    // Leaving the detail: the list underneath is still in the DOM (detail only
    // hid it), so just restore it — no refetch. Exception: a detail opened as a
    // DEEP LINK (global search result) never rendered its list, so the grid is
    // empty — render it now instead of unhiding a blank page.
    if (popped && popped.kind === "detail") {
      reqSeq++;                          // orphan the detail's in-flight fetch, if any
      detailEl.classList.add("hidden");
      detailEl.innerHTML = "";
      if (!listEl.children.length) { render(currentView()); return; }
      listEl.classList.remove("hidden");
      if (tabsEl) tabsEl.classList.remove("hidden");   // tabs return with the list
      updateTabActive();
      return;
    }
    render(currentView());
  });

  function pushView(view) {
    viewStack.push(view);
    history.pushState({ [HKEY]: viewStack.length }, "");
    render(view);
  }

  // Leave the overlay entirely (unwinding its history entries) and then run a
  // follow-up — used by the detail's "open in library" / "find on <service>"
  // actions. history.go(-n) fires a single popstate that the handler above
  // turns into hideOverlay(). The follow-up must run only AFTER that close has
  // actually happened, otherwise a follow-up that opens ANOTHER history-managed
  // overlay (Qobuz/Tidal) would race the pending unwind and get torn down by
  // the stray popstate. A bare setTimeout doesn't guarantee that ordering
  // (flaky on iOS Safari), so we run fn from a one-shot popstate listener once
  // the overlay is confirmed hidden.
  function closeAndThen(fn) {
    const n = viewStack.length;
    if (!visible() || n <= 0) { hideOverlay(); fn(); return; }
    const once = () => {
      if (visible()) return;                       // not fully closed yet — wait for the next
      window.removeEventListener("popstate", once);
      fn();
    };
    window.addEventListener("popstate", once);
    history.go(-n);
  }

  function updateTabActive() {
    if (!tabsEl) return;
    const top = currentView();
    const tab = top && top.kind === "tab" ? top.tab : activeTab;
    tabsEl.querySelectorAll(".qobuz-tab").forEach(t =>
      t.classList.toggle("is-active", t.dataset.pftab === tab));
  }

  if (tabsEl) {
    tabsEl.querySelectorAll(".qobuz-tab").forEach(t => t.addEventListener("click", () => {
      const tab = t.dataset.pftab;
      if (!tab || !viewStack.length) return;
      activeTab = tab;
      const top = currentView();
      if (top.kind === "tab" && top.tab === tab) { updateTabActive(); return; }
      // Replace the top view (tab siblings never push history, keeping the
      // viewStack ↔ history 1:1 invariant).
      viewStack[viewStack.length - 1] = { kind: "tab", tab };
      render(currentView());
    }));
  }

  trigger.addEventListener("click", () => {
    if (visible()) return;
    activeTab = "latest";
    viewStack = [{ kind: "tab", tab: "latest" }];
    history.pushState({ [HKEY]: 1 }, "");   // a back press from the root closes the overlay
    overlay.classList.remove("hidden");
    render(currentView());
  });

  // Deep link from the global search: open the overlay straight to one review's
  // detail. Seeds the root list frame WITHOUT rendering it (rendering would be
  // orphaned by the detail's reqSeq bump anyway); the popstate leaving-detail
  // branch self-heals the empty list by rendering it on Back.
  window.__openPitchforkReview = (item) => {
    if (!item || !item.url) return;
    if (!visible()) {
      activeTab = "latest";
      viewStack = [{ kind: "tab", tab: "latest" }];
      history.pushState({ [HKEY]: 1 }, "");
      overlay.classList.remove("hidden");
    }
    pushView({ kind: "detail", item });
  };

  function render(view) {
    if (!view) return;
    if (view.kind === "detail") renderDetail(view.item);
    else renderList(view.tab);
  }

  async function renderList(tab) {
    const mySeq = ++reqSeq;
    detailEl.classList.add("hidden");
    detailEl.innerHTML = "";
    listEl.classList.remove("hidden");
    if (tabsEl) tabsEl.classList.remove("hidden");
    updateTabActive();
    if (listCache[tab]) { paintList(listCache[tab]); return; }
    listEl.innerHTML = "";
    setStatus("Loading…");
    let data;
    try {
      const r = await fetch("/api/pitchfork/reviews?type=" + encodeURIComponent(tab));
      if (mySeq !== reqSeq) return;
      data = await r.json();
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    } catch (e) {
      if (mySeq !== reqSeq) return;
      setStatus("");
      listEl.innerHTML = '<div class="pf-empty">Couldn’t load Pitchfork right now. Try again in a little while.</div>';
      return;
    }
    if (mySeq !== reqSeq) return;
    const items = data.items || [];
    // Session-cache only a NON-EMPTY success (mirrors the backend's rule):
    // an empty response is a parse miss upstream — retry it next visit rather
    // than pinning "No reviews" for the whole session.
    if (items.length) listCache[tab] = items;
    paintList(items);
  }

  function paintList(items) {
    setStatus("");
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = '<div class="pf-empty">No reviews to show right now.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(buildCard(it));
    listEl.appendChild(frag);
  }

  function buildCard(it) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pf-card";

    const art = document.createElement("div");
    art.className = "pf-card-art";
    if (it.cover) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = ""; img.src = it.cover;
      img.addEventListener("error", () => { art.classList.add("pf-art-fallback"); img.remove(); });
      art.appendChild(img);
    } else {
      art.classList.add("pf-art-fallback");
    }
    if (it.score != null) {
      const s = document.createElement("span");
      s.className = "pf-score" + (it.isBestNewMusic ? " pf-score-bnm" : "");
      s.textContent = fmtScore(it.score);
      art.appendChild(s);
    }
    if (it.isBestNewMusic) {
      const b = document.createElement("span");
      b.className = "pf-bnm";
      b.textContent = "BNM";
      art.appendChild(b);
    }
    // Album/artist overlaid on the bottom of the cover so tiles stay square and
    // pack cleanly in the woven mosaic (no below-tile text breaking the grid).
    const meta = document.createElement("div");
    meta.className = "pf-card-meta";
    const al = document.createElement("div"); al.className = "pf-card-album";  al.textContent = it.album || "";
    const ar = document.createElement("div"); ar.className = "pf-card-artist"; ar.textContent = it.artist || "";
    meta.appendChild(al);
    meta.appendChild(ar);
    art.appendChild(meta);
    card.appendChild(art);

    card.addEventListener("click", () => pushView({ kind: "detail", item: it }));
    return card;
  }

  async function renderDetail(it) {
    const mySeq = ++reqSeq;
    listEl.classList.add("hidden");
    // Hide the tab chips while reading a review — switching tabs from within a
    // detail would leave a phantom stack entry (back would land on the wrong
    // list). You return to the list (tabs reappear) via Back first.
    if (tabsEl) tabsEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
    detailEl.scrollTop = 0;
    detailEl.innerHTML =
      '<button class="pf-back" type="button">‹ Back</button>' +
      '<div class="pf-detail-head">' +
        (it.cover ? '<img class="pf-detail-art" src="' + esc(it.cover) + '" alt="">'
                  : '<div class="pf-detail-art pf-art-fallback"></div>') +
        '<div class="pf-detail-headmeta">' +
          '<div class="pf-detail-album">' + esc(it.album) + '</div>' +
          '<div class="pf-detail-artist">' + esc(it.artist) + '</div>' +
          '<div class="pf-detail-scorerow">' +
            (it.score != null ? '<span class="pf-score' + (it.isBestNewMusic ? ' pf-score-bnm' : '') + '">' + fmtScore(it.score) + '</span>' : '') +
            (it.isBestNewMusic ? '<span class="pf-bnm">Best New Music</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pf-detail-body"><div class="pf-loading">Loading review…</div></div>' +
      '<div class="pf-detail-actions"></div>';
    detailEl.querySelector(".pf-back").addEventListener("click", goBack);
    // Match the card behaviour: a dead cover URL falls back to the ♪ tile
    // instead of the browser's broken-image glyph. (::after doesn't render on a
    // replaced <img>, so swap in a div that does.)
    const headImg = detailEl.querySelector("img.pf-detail-art");
    if (headImg) headImg.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "pf-detail-art pf-art-fallback";
      headImg.replaceWith(ph);
    });
    const bodyEl = detailEl.querySelector(".pf-detail-body");
    const actEl  = detailEl.querySelector(".pf-detail-actions");

    // COMPLIANCE (UK law): the written review is never displayed in-app.
    // Paint the note and the actions (led by "Read on Pitchfork") IMMEDIATELY
    // — nothing they need is remote. The only async piece is the library
    // match, fetched after, which just upgrades the actions with an
    // "Open in your library" button when it lands.
    bodyEl.innerHTML =
      '<p class="pf-detail-note">The written review can’t be shown here — ' +
      'tap <strong>Read on Pitchfork</strong> to read it on pitchfork.com.</p>';
    buildActions(actEl, it, null);

    try {
      const qs = "?url=" + encodeURIComponent(it.url) +
                 "&album="  + encodeURIComponent(it.album  || "") +
                 "&artist=" + encodeURIComponent(it.artist || "");
      const r = await fetch("/api/pitchfork/review" + qs);
      if (mySeq !== reqSeq) return;
      const data = await r.json();
      if (r.ok && data.match) buildActions(actEl, it, data.match);
    } catch (e) { /* library match is optional — the actions already shown work */ }
  }

  function buildActions(container, it, match) {
    container.innerHTML = "";

    // Reading happens on pitchfork.com now — make that the first action.
    const link = document.createElement("a");
    link.className = "pf-action pf-action-link";
    link.href = it.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Read on Pitchfork ↗";
    container.appendChild(link);

    // Owned? → open the existing album modal (play/queue live there).
    if (match) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "pf-action pf-action-primary";
      play.textContent = "▶ Open in your library";
      play.addEventListener("click", () => {
        closeAndThen(() => {
          if (window.__openAlbum) window.__openAlbum(match, { source: "pitchfork", filter: null });
        });
      });
      container.appendChild(play);
    }

    // Not-owned path: hop to the streaming browsers, pre-seeding their search.
    const query = ((it.artist || "") + " " + (it.album || "")).trim();
    const qBtn = document.getElementById("qobuz-toggle");
    if (qBtn) container.appendChild(makeFindBtn("Find on Qobuz", qBtn, "qobuz-search-input", query));
    const tBtn = document.getElementById("tidal-toggle");
    if (tBtn && !tBtn.classList.contains("hidden")) {
      container.appendChild(makeFindBtn("Find on Tidal", tBtn, "tidal-search-input", query));
    }
  }

  function makeFindBtn(label, toggleBtn, searchInputId, query) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pf-action";
    b.textContent = label;
    b.addEventListener("click", () => {
      closeAndThen(() => {
        toggleBtn.click();                       // open that service's overlay
        const input = document.getElementById(searchInputId);
        if (input && query) {
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));   // its debounced search listens on 'input'
        }
      });
    });
    return b;
  }
})();

/* ------------------------------------------------------------------ */
/*  Check for updates button in settings                               */
/* ------------------------------------------------------------------ */
(function initCheckUpdate() {
  const btn      = document.getElementById("check-update-btn");
  const notesDiv = document.getElementById("settings-release-notes");
  if (!btn) return;
  // After a check finds an update, the button itself becomes the install
  // action (the old copy said "tap Update below", but the update banner sits
  // BEHIND the Settings sheet — there was no visible button to tap).
  let pendingUpdate = false;

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;

    if (pendingUpdate) {
      // Second tap: install. Close Settings so the update banner (which owns
      // the download/unpack/restart progress UI) is visible, then hand off.
      pendingUpdate = false;
      btn.classList.remove("is-update-ready");
      const closer = document.querySelector("#settings-overlay [data-settings-close]");
      if (closer) closer.click();
      if (window.__applyUpdateNow) window.__applyUpdateNow();
      // The banner owns all progress/error/retry state from here — reset this
      // button so a reopened Settings offers a fresh check (on success the
      // page reloads anyway; on failure the banner shows the retry, and a
      // disabled "Updating…" here would strand with no reset path).
      btn.textContent = "Check for updates";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Checking…";
    if (notesDiv) notesDiv.classList.add("hidden");
    try {
      await fetch("/api/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const r = await fetch("/api/update/status", { cache: "no-store" });
      const s = await r.json();
      if (s && s.available && s.latest) {
        pendingUpdate = true;
        btn.disabled = false;
        btn.classList.add("is-update-ready");
        btn.textContent = s.isDowngrade
          ? "Roll back to v" + s.latest
          : "Update to v" + s.latest;
        if (notesDiv && s.notes) {
          notesDiv.textContent = s.notes;
          notesDiv.classList.remove("hidden");
        }
      } else {
        btn.textContent = "Up to date (v" + (s && s.current || "?") + ")";
        setTimeout(() => { btn.disabled = false; btn.textContent = "Check for updates"; }, 4000);
      }
    } catch (e) {
      btn.textContent = "Check failed";
      setTimeout(() => { btn.disabled = false; btn.textContent = "Check for updates"; }, 3000);
    }
  });
})();

/* ------------------------------------------------------------------ */
/*  Play Unheard — topbar compass button with 2-second spin           */
/* ------------------------------------------------------------------ */
(function initPlayUnheard() {
  const btn        = document.getElementById("play-unheard-topbar");
  const zoneSelect = document.getElementById("zone-select");
  if (!btn) return;

  // `spinEl` is whichever control the user actually pressed — the top-bar
  // compass or the Home tile. Forwarding a click from one to the other would
  // have left the pressed control inert for the two seconds it takes.
  async function playUnheard(spinEl) {
    const el = spinEl || btn;
    const zone = zoneSelect && zoneSelect.value;
    if (!zone) { if (window.__showToast) window.__showToast("Select a zone first"); return; }
    if (el.classList.contains("spinning")) return;

    // Spin the compass for 2 seconds, then fetch
    el.classList.add("spinning");
    await new Promise(r => setTimeout(r, 2000));

    try {
      const r = await fetch("/api/play-unheard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone })
      });
      const j = await r.json();
      if (!r.ok) {
        if (window.__showToast) window.__showToast(j.error || "Could not start playback", "error");
      } else {
        if (window.__showToast) window.__showToast("Playing: " + (j.album || "random album"));
      }
    } catch (e) {
      if (window.__showToast) window.__showToast("Request failed", "error");
    } finally {
      el.classList.remove("spinning");
    }
  }
  btn.addEventListener("click", () => playUnheard(btn));
  window.__playUnheard = playUnheard;
})();

/* ------------------------------------------------------------------ */
/*  Artist albums view                                                 */
/* ------------------------------------------------------------------ */
(() => {
  const grid         = document.getElementById("album-grid");
  const countBar     = document.getElementById("content-count");
  const homeView     = document.getElementById("home-view");
  const homeSections = document.getElementById("home-sections");
  const topbarBack    = document.getElementById("topbar-back");
  const topbarRefresh = document.getElementById("topbar-refresh");
  const topbarSearch  = document.getElementById("topbar-search");

  let artistViewActive = false;
  let saved            = null;   // snapshot of the screen we came from

  // opts.restore === false: the caller is building its OWN screen (Home, a
  // fresh wall) and has already reset the view flags — putting the captured
  // screen and its flags back would fight that, e.g. re-arming the library
  // wall's paging over a Home screen. Drop the snapshot instead.
  function exitArtistView(opts) {
    if (!artistViewActive) return;
    artistViewActive = false;
    bioSeq++;   // any in-flight bio must not prepend into the restored screen
    if (saved && opts && opts.restore === false) {
      saved = null;
      grid.innerHTML = "";
      // The artist view owns this bar; without clearing it, its "← Back"
      // button survives onto the screen the caller is about to show.
      if (countBar) { countBar.innerHTML = ""; countBar.classList.add("hidden"); }
      return;
    }
    // Restore exactly the screen the artist view was opened from (the Home
    // landing, or an album wall) so Back doesn't dump the user somewhere else.
    if (saved) {
      // Put the ORIGINAL NODES back — never re-parse an HTML string. Album
      // tiles carry their behaviour on the node itself (click + long-press
      // listeners, and a closure holding the album's offset/title used to open
      // and play it); serializing to markup and re-parsing drops all of that,
      // so the wall came back looking perfect with every tile dead. Moving live
      // nodes through a DocumentFragment keeps them intact — the same technique
      // the Qobuz/Tidal browser uses (see snapshotListInto/restoreSnapshot).
      grid.innerHTML = "";
      grid.appendChild(saved.gridNodes);
      grid.classList.toggle("hidden", saved.gridHidden);
      if (homeView)     homeView.classList.toggle("hidden", saved.homeViewHidden);
      if (homeSections) homeSections.classList.toggle("hidden", saved.homeSectionsHidden);
      if (countBar) {
        countBar.innerHTML = "";
        countBar.appendChild(saved.countNodes);
        countBar.classList.toggle("hidden", saved.countHidden);
      }
      if (topbarBack)    topbarBack.classList.toggle("hidden", saved.topbarBackHidden);
      if (topbarRefresh) topbarRefresh.classList.toggle("hidden", saved.topbarRefreshHidden);
      if (topbarSearch)  topbarSearch.classList.toggle("hidden", saved.topbarSearchHidden);
      // Re-arm the screens whose behaviour lives OUTSIDE the restored nodes:
      // the library wall's infinite scroll (parked on the way in, else it never
      // pages again) and the labels browser's chrome/mode.
      // Only re-arm the wall if nothing else entered it meanwhile (a fresh
      // entry bumps the sequence and owns the paging state now).
      const libSeqNow = window.__libraryWallSeq ? window.__libraryWallSeq() : 0;
      if (window.__restoreLibraryWall && saved.libraryWallSeq === libSeqNow) {
        window.__restoreLibraryWall(saved.libraryWallWasActive);
      }
      if (window.__unparkLabels) window.__unparkLabels(saved.labels);
      // Land back where the user was, not at the top of the wall.
      const mainEl = document.querySelector("main");
      if (mainEl && typeof saved.scrollTop === "number") mainEl.scrollTop = saved.scrollTop;
    }
    saved = null;
  }

  async function showArtistAlbums(artistName) {
    if (window.__leavePlaylistScreens) window.__leavePlaylistScreens();
    if (!artistName) return;
    // Drop any active/pending search (incl. the delayed external-sources fetch)
    // — reachable from the album-modal artist link with a search still live,
    // which would otherwise append external rows under this view's grid. The
    // search artist-chip stops the search itself; this covers every other path.
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();
    // Artist → album → artist chaining: put the FIRST screen back before
    // capturing, so what we snapshot below is the real originating screen (and
    // its live view flags), not a half-torn-down artist view.
    if (artistViewActive) exitArtistView();
    // The artist view takes over the shared grid (and snapshot-restores it on
    // Back) — park the library wall's infinite scroll so it can't append into
    // this view, remembering whether it was live so Back can re-arm it.
    const libraryWallWasActive = window.__leaveLibraryWall ? !!window.__leaveLibraryWall() : false;
    const libraryWallSeq = window.__libraryWallSeq ? window.__libraryWallSeq() : 0;
    // Same for the labels browser: park its chrome (bar, sheets, select modes)
    // but keep the mode/label it was showing so Back restores it whole.
    const labels = window.__parkLabels ? window.__parkLabels() : null;
    // A multi-select started on the previous wall must not leak in here — its
    // action bar would stay on screen and this view's tiles would select
    // instead of open. Runs BEFORE the capture so the restored screen comes
    // back with its selection cleared in both the DOM and the state.
    if (window.__exitAlbumSelectMode) window.__exitAlbumSelectMode();
    // Invalidate any in-flight bio fetch NOW — bumping only inside
    // renderArtistBioHead left a window where artist A's late bio could
    // prepend into artist B's freshly-rendered grid.
    bioSeq++;
    // Snapshot the screen we're leaving (Home landing or an album wall) so the
    // "← Back" button restores it exactly.
    // Move the live nodes out into fragments rather than copying markup — see
    // exitArtistView for why (tile listeners + album identity live on the nodes).
    const gridNodes = document.createDocumentFragment();
    while (grid.firstChild) gridNodes.appendChild(grid.firstChild);
    const countNodes = document.createDocumentFragment();
    if (countBar) while (countBar.firstChild) countNodes.appendChild(countBar.firstChild);
    const mainEl = document.querySelector("main");
    saved = {
      gridNodes,
      countNodes,
      libraryWallWasActive,
      libraryWallSeq,
      labels,
      scrollTop:          mainEl ? mainEl.scrollTop : 0,
      gridHidden:         grid.classList.contains("hidden"),
      homeViewHidden:     homeView     ? homeView.classList.contains("hidden")     : true,
      homeSectionsHidden: homeSections ? homeSections.classList.contains("hidden") : true,
      countHidden:        countBar ? countBar.classList.contains("hidden") : true,
      topbarBackHidden:    topbarBack    ? topbarBack.classList.contains("hidden")    : true,
      topbarRefreshHidden: topbarRefresh ? topbarRefresh.classList.contains("hidden") : true,
      topbarSearchHidden:  topbarSearch  ? topbarSearch.classList.contains("hidden")  : true,
    };
    artistViewActive = true;
    // Reveal the shared album grid and leave the Home landing / search results.
    // The search artist-chip calls stopSearch() first, which hides the grid and
    // re-shows the Home sections; without this the artist albums would render
    // into a hidden grid behind the Home rows (the reported bug).
    if (homeView)     homeView.classList.add("hidden");
    if (homeSections) homeSections.classList.add("hidden");
    grid.classList.remove("hidden");
    // Hide the shared topbar nav — this view has its own "← Back" button in
    // countBar, so leaving the shared Back/Refresh/Search visible (whatever the
    // previous screen set them to) would show a second, redundant back control.
    if (topbarBack)    topbarBack.classList.add("hidden");
    if (topbarRefresh) topbarRefresh.classList.add("hidden");
    if (topbarSearch)  topbarSearch.classList.add("hidden");

    // Show loading state
    if (countBar) {
      countBar.classList.remove("hidden");
      countBar.innerHTML = `
        <button class="artist-view-back" id="artist-back-btn">← Back</button>
        <span class="count-text">Loading…</span>`;
      document.getElementById("artist-back-btn").addEventListener("click", exitArtistView);
    }
    grid.innerHTML = "";

    try {
      const r = await fetch("/api/artist-albums?artist=" + encodeURIComponent(artistName));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const total = j.primary.length + j.featured.length;

      if (countBar) {
        countBar.innerHTML = `
          <button class="artist-view-back" id="artist-back-btn">← Back</button>
          <span class="count-text">${total} album${total !== 1 ? "s" : ""} · ${artistName}</span>`;
        document.getElementById("artist-back-btn").addEventListener("click", exitArtistView);
      }

      if (!total) {
        grid.innerHTML = `<div class="artist-view-empty">No albums found for "${artistName}"</div>`;
        return;
      }

      const frag = document.createDocumentFragment();

      if (j.primary.length) {
        if (j.featured.length) {
          const hdr = document.createElement("div");
          hdr.className = "artist-section-header";
          hdr.textContent = "Albums";
          frag.appendChild(hdr);
        }
        for (const a of j.primary) {
          frag.appendChild(window.__buildAlbumTile(a));
        }
      }

      if (j.featured.length) {
        const hdr = document.createElement("div");
        hdr.className = "artist-section-header";
        hdr.textContent = "Also appears on";
        frag.appendChild(hdr);
        for (const a of j.featured) {
          frag.appendChild(window.__buildAlbumTile(a));
        }
      }

      grid.appendChild(frag);

      // Artist header (avatar + validated bio) loads after the albums so the
      // grid is never blocked on external services. One of the artist's own
      // album titles pins their identity for the lookup (see /api/artist-bio).
      const bioAlbum = (j.primary[0] && j.primary[0].title) ||
                       (j.featured[0] && j.featured[0].title) || "";
      renderArtistBioHead(artistName, bioAlbum);
    } catch (e) {
      if (countBar) {
        countBar.innerHTML = `
          <button class="artist-view-back" id="artist-back-btn">← Back</button>
          <span class="count-text" style="color:var(--danger)">Error: ${e.message}</span>`;
        document.getElementById("artist-back-btn").addEventListener("click", exitArtistView);
      }
    }
  }

  // Build the LMS-style artist header: round avatar, bio with Show more,
  // "Bio: <source>" attribution. Decorative — any failure leaves the plain
  // album grid, and a view/artist switch mid-fetch renders nothing stale.
  let bioSeq = 0;
  async function renderArtistBioHead(artistName, albumTitle) {
    const seq = bioSeq;   // generation is bumped by showArtistAlbums/exitArtistView, not here
    try {
      const r = await fetch("/api/artist-bio?artist=" + encodeURIComponent(artistName) +
                            "&album=" + encodeURIComponent(albumTitle || ""));
      if (!r.ok) return;
      const j = await r.json();
      const b = j.bio;
      if (!b || !b.text) return;
      if (seq !== bioSeq || !artistViewActive) return;   // superseded / view closed

      // LMS-remote layout: large centred round portrait on top, bio beneath
      // it full-width, then a centred Show more and a centred "Bio: <source>"
      // caption — not a thumbnail beside the text.
      const head = document.createElement("div");
      head.className = "artist-bio-head";
      if (b.image) {
        const img = document.createElement("img");
        img.className = "artist-bio-avatar";
        img.alt = "";
        img.onerror = () => img.remove();   // dead portrait URL — no broken-image circle
        img.src = b.image;
        head.appendChild(img);
      }
      const body = document.createElement("div");
      body.className = "artist-bio-body";
      const text = document.createElement("div");
      text.className = "bio-text";
      text.dataset.clipped = "true";
      text.textContent = b.text;
      const foot = document.createElement("div");
      foot.className = "artist-bio-foot";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "bio-toggle hidden";
      toggle.textContent = "Show more";
      const src = document.createElement("span");
      src.className = "artist-bio-src";
      src.textContent = b.source ? "Bio: " + b.source : "";
      foot.appendChild(toggle); foot.appendChild(src);
      body.appendChild(text); body.appendChild(foot);
      head.appendChild(body);
      grid.prepend(head);
      if (window.__setupBioToggle) window.__setupBioToggle(text, toggle);
    } catch (e) { /* bio is decorative — the album grid stands alone */ }
  }

  window.__showArtistAlbums = showArtistAlbums;
  window.__exitArtistView   = exitArtistView;
  window.__artistViewActive = () => artistViewActive;
})();

/* ------------------------------------------------------------------ */
/*  Docker migration banner (shown to native installs only)           */
/* ------------------------------------------------------------------ */
(function initDockerMigration() {
  const banner  = document.getElementById("docker-migration-banner");
  const dismiss = document.getElementById("docker-migration-dismiss");
  if (!banner) return;
  const DISMISS_KEY = "rra-docker-migrated";
  if (localStorage.getItem(DISMISS_KEY)) return;
  fetch("/api/update/status", { cache: "no-store" })
    .then((r) => r.json())
    .then((s) => { if (!s.is_docker) banner.classList.remove("hidden"); })
    .catch(() => { /* migration banner is non-critical; stays hidden on error */ });
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      localStorage.setItem(DISMISS_KEY, "1");
      banner.classList.add("hidden");
    });
  }
})();

/* ------------------------------------------------------------------ */
/*  Side menu (hamburger drawer)                                        */
/*  Items with data-target trigger the hidden top-bar button of that   */
/*  id; data-action items switch the main view (home / random wall).   */
/* ------------------------------------------------------------------ */
(function initMenuDrawer() {
  const overlay = document.getElementById("menu-overlay");
  const toggle  = document.getElementById("menu-toggle");
  if (!overlay || !toggle) return;

  // Manual library rescan: rebuilds the album snapshot, but the server refuses
  // (status "importing") while Roon is still adding albums, so a deliberate
  // press never fights an active import.
  async function rescanLibrary() {
    const toast = window.__showToast || (() => {});
    toast("Checking Roon…");
    try {
      const r = await fetch("/api/library/rescan", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      const msg =
        j.status === "rebuilt"   ? "Library rescanned — " + (j.count || 0) + " albums" :
        j.status === "importing" ? "Roon is still adding albums — try again shortly" :
        j.status === "fresh"     ? "Library already up to date" :
        j.status === "busy"      ? "A scan is already running" :
        j.status === "unpaired"  ? "Not connected to Roon" :
                                   "Rescan failed";
      toast(msg, j.status === "rebuilt" || j.status === "fresh" ? undefined : "error");
      refreshRescanSub();   // the row's sub-line is now stale whatever happened
    } catch (e) {
      toast("Rescan failed", "error");
    }
  }

  // Roon's all-zone actions. They live in the zone picker — the sheet that is
  // already about "which zones", which is what these act on — and the popover
  // is closed by the time they run, so a toast is the only feedback channel.
  // Mute and unmute are separate rows rather than one toggle: the popover is
  // shut when the state changes, so a single "Mute all" would be wrong half
  // the time.
  async function allZones(url, body, pending, okMsg, failMsg) {
    const toast = window.__showToast || (() => {});
    toast(pending);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return toast(j.error || failMsg, "error");
      toast(okMsg);
    } catch (e) {
      toast(failMsg, "error");
    }
  }

  // Exposed for the two zone pickers (now-playing and mini-transport), which
  // are built in different closures. One implementation, three named actions,
  // so the two pickers cannot drift apart on wording or endpoint.
  window.__allZoneActions = {
    "pause-all":  () => allZones("/api/pause-all", null, "Pausing every zone…",
                                 "All zones paused", "Could not pause all zones"),
    "mute-all":   () => allZones("/api/mute-all", { how: "mute" }, "Muting every zone…",
                                 "All zones muted", "Could not mute all zones"),
    "unmute-all": () => allZones("/api/mute-all", { how: "unmute" }, "Unmuting every zone…",
                                 "All zones unmuted", "Could not unmute all zones"),
  };

  // What the snapshot is right now, under the Rescan row. Every phrase here is
  // deliberately PAST tense or explicitly a schedule, because none of it can be
  // a claim about this instant: `library_importing` is set at the last check
  // and cleared at the next clean one, and Roon publishes no import-finished
  // event to make it live. Saying "Roon is importing" would be a confident lie
  // dressed up as a status line.
  function libraryAgeText(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 2)    return "just now";
    if (mins < 60)   return mins + " min ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 48)    return hrs + (hrs === 1 ? " hour ago" : " hours ago");
    return Math.round(hrs / 24) + " days ago";
  }
  async function refreshRescanSub() {
    const el = document.getElementById("rescan-sub");
    if (!el) return;
    try {
      const r = await fetch("/api/status");
      const j = await r.json();
      if (!j.paired) { el.textContent = "Not connected to Roon"; return; }
      const albums = (j.index_count || 0).toLocaleString() + " albums";
      if (j.library_importing) {
        el.textContent = albums + " · Roon was importing at the last check — refresh paused";
      } else if (j.library_recheck_pending) {
        el.textContent = albums + " · the library moved, checking again shortly";
      } else if (j.index_built_at) {
        el.textContent = albums + " · checked " + libraryAgeText(j.index_built_at);
      } else {
        el.textContent = "No snapshot yet";
      }
    } catch (e) {
      // The drawer must open regardless. An empty sub-line reads as "no
      // information", which is exactly what a failed status call means.
      el.textContent = "";
    }
  }

  const openMenu  = () => { overlay.classList.remove("hidden"); refreshRescanSub(); };
  const closeMenu = () => overlay.classList.add("hidden");

  toggle.addEventListener("click", openMenu);
  overlay.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("[data-menu-close]")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeMenu();
  });

  overlay.querySelectorAll(".menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      const target = item.dataset.target;
      closeMenu();

      if (action === "home") {
        if (window.__showHome) window.__showHome();
        return;
      }
      if (action === "shuffle") {
        // Clear any active filter/labels so "Random albums" is a fresh wall.
        // applyFilter(null) reveals the wall and loads it.
        if (window.__applyFilter) window.__applyFilter(null);
        else if (window.__loadRandom) window.__loadRandom();
        return;
      }
      if (action === "rescan-library") {
        rescanLibrary();
        return;
      }
      if (action === "smart-picks") {
        if (window.__showSmartPicks) window.__showSmartPicks();
        return;
      }
      if (action === "smart-playlists") {
        if (window.__showSmartPlaylists) window.__showSmartPlaylists();
        return;
      }
      if (action === "playlists") {
        if (window.__showPlaylists) window.__showPlaylists();
        return;
      }
      if (action === "import-playlist") {
        if (window.__openImportSheet) window.__openImportSheet();
        return;
      }

      // Everything else just triggers the original control; each one manages
      // its own view — Filter/Labels reveal the wall when they render, Qobuz/
      // Tidal/Settings open an overlay over Home, Play-unheard just plays.
      if (target) {
        const btn = document.getElementById(target);
        if (btn) btn.click();
      }
    });
  });
})();
