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
  const themeBtn   = document.getElementById("theme-toggle");
  const zoneSel    = document.getElementById("zone-select");
  const banner     = document.getElementById("status-banner");
  const toast      = document.getElementById("toast");

  const modal       = document.getElementById("album-modal");
  const modalImg    = document.getElementById("modal-img");
  const modalTitle  = document.getElementById("modal-title");
  const modalSub    = document.getElementById("modal-subtitle");
  const modalActs   = document.getElementById("modal-actions");
  const modalTracks = document.getElementById("modal-tracks");

  const albumActionBar       = document.getElementById("album-action-bar");
  const albumActionInfo      = document.getElementById("album-action-info");
  const albumPlayNowBtn      = document.getElementById("album-play-now-btn");
  const albumQueueBtn        = document.getElementById("album-queue-btn");
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

  // ----- Theme -----
  const savedTheme = localStorage.getItem("rra-theme");
  if (savedTheme === "light" || savedTheme === "dark") {
    document.documentElement.dataset.theme = savedTheme;
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.dataset.theme = "light";
  }
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("rra-theme", next);
  });

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
      if (labelsActive || unplayedWallActive) return;
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
  const homeLotw     = document.getElementById("home-lotw");
  const homeGenres   = document.getElementById("home-genres");
  const topbarBack   = document.getElementById("topbar-back");
  const topbarRefresh = document.getElementById("topbar-refresh");
  const topbarSearch  = document.getElementById("topbar-search");
  let homeSectionsLoaded = false;
  let homeLotwLoaded = false;   // set once the label-of-the-week row populates

  // Topbar chrome per view: Back button (off Home), Refresh button (random /
  // genre grids), and the Search box (Home only, beside the hamburger).
  function setTopbarNav(back, refresh, search) {
    if (topbarBack)    topbarBack.classList.toggle("hidden", !back);
    if (topbarRefresh) topbarRefresh.classList.toggle("hidden", !refresh);
    if (topbarSearch)  topbarSearch.classList.toggle("hidden", !search);
  }

  // Show the Home landing (hide the wall). The wall loads lazily when entered.
  function showHome() {
    unplayedWallActive = false;
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
    if (window.__exitLabels) window.__exitLabels();   // leave the labels browser if active
    if (window.__exitArtistView) window.__exitArtistView();   // leave the artist view if active
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
    const rowsFresh = homeRowsLoadedAt &&
      (Date.now() - homeRowsLoadedAt) < HOME_ROWS_TTL_MS &&
      homeUnplayed && homeUnplayed.querySelector(".album") &&
      homeRandom && homeRandom.querySelector(".album");
    if (!rowsFresh) {
      homeRowsLoadedAt = Date.now();
      loadHomeUnplayed();
      loadHomeRandom();
    }
    // Label of the week depends on the background labels scan, which may not be
    // ready on the first visit — retry each visit until it populates, then stop.
    if (!homeLotwLoaded) loadHomeLabelOfWeek();
    if (!homeSectionsLoaded) loadHomeGenres();
  }
  // Reveal the album wall. opts.loadIfEmpty loads a fresh wall only when it has
  // no content yet (so passive reveals — opening an overlay from the menu —
  // don't leave an empty grid behind, without racing actions that render their
  // own content, e.g. labels/search).
  function showWall(opts) {
    unplayedWallActive = false;
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
    if (window.__exitArtistView) window.__exitArtistView();   // leave the artist view if active
    if (homeView) homeView.classList.add("hidden");
    grid.classList.remove("hidden");
    setTopbarNav(true, true, false);   // random / genre grid: Back + Refresh, no search
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
  const rowHasContent = (el) => !!(el && el.querySelector(".album, .home-genre-card"));

  // Build a Home tile that always opens full-library (filter: null) so its
  // offset resolves even when a genre filter was last active.
  function homeTile(a, extraClass) {
    const tile = buildAlbumTile(a, () => openAlbum(a, { source: "home", filter: null }));
    if (extraClass) tile.classList.add(extraClass);
    return tile;
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
  function renderHomeRandom(albums) {
    albums = albums || [];
    homeRandom.innerHTML = "";
    if (!albums.length) {
      homeRandom.innerHTML = '<div class="home-carousel-empty">No albums.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const a of albums) frag.appendChild(homeTile(a));   // filter:null → offsets resolve
    homeRandom.appendChild(frag);
  }

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
    if (sec) sec.classList.remove("hidden");   // un-hide if a prior attempt hid it
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

  // Full-screen "Not played in 6 months" grid — reached by tapping the section
  // header. Fills the main grid with a larger unplayed list (tiles open
  // unfiltered, like the Home row) and shows a Back button to Home.
  async function showUnplayedWall() {
    unplayedWallActive = true;
    if (window.__exitLabels) window.__exitLabels();
    if (activeFilter) { activeFilter = null; try { localStorage.removeItem("rra-filter"); } catch (e) {} }
    if (homeView) homeView.classList.add("hidden");
    if (homeSections) homeSections.classList.remove("hidden");
    grid.classList.remove("hidden");
    clearWallGridSizing();  // standard grid, not phone-fit wall
    setTopbarNav(true, false, false);   // Back (to Home), no Refresh, no search
    setCountText("Not played in 6 months");
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
    renderSkeletons(computeAlbumCount());
    try {
      const r = await fetch("/api/home/unplayed?months=6&count=96");
      if (r.status === 503) {
        const j = await r.json().catch(() => ({}));
        setBanner(j.error || "Waiting for Roon Core. Enable this extension in Roon → Settings → Extensions.", true);
        grid.innerHTML = ""; return;
      }
      const j = await r.json();
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
      grid.innerHTML = "";
      setBanner("Couldn’t load: " + e.message, true);
    }
  }

  // Header taps: Not played → full unplayed grid; Random albums → full random
  // wall; Label of the week → label view.
  {
    const unplayedTitle = document.getElementById("home-unplayed-title");
    if (unplayedTitle) {
      unplayedTitle.addEventListener("click", showUnplayedWall);
      unplayedTitle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showUnplayedWall(); }
      });
    }
    const randTitle = document.getElementById("home-random-title");
    if (randTitle) {
      const goRandom = () => { if (window.__applyFilter) window.__applyFilter(null); };
      randTitle.addEventListener("click", goRandom);
      randTitle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goRandom(); }
      });
    }
    const lotwTitle = document.getElementById("home-lotw-title");
    if (lotwTitle) {
      const goLabel = () => {
        const name = homeLotw && homeLotw.dataset.label;
        if (name && window.__showLabelAlbums) window.__showLabelAlbums(name);
      };
      lotwTitle.addEventListener("click", goLabel);
      lotwTitle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goLabel(); }
      });
    }
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
    let painted = false;
    if (c.unplayed && homeUnplayed) { renderHomeUnplayed(c.unplayed.aotd, c.unplayed.albums); painted = rowHasContent(homeUnplayed) || painted; }
    if (c.random   && homeRandom)   { renderHomeRandom(c.random);                              painted = rowHasContent(homeRandom)   || painted; }
    if (c.lotw     && homeLotw)     { renderHomeLotw(c.lotw.label, c.lotw.albums); }
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
  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.classList.remove("hidden", "error");
    if (kind === "error") toast.classList.add("error");
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.classList.add("hidden"), 250);
    }, 2400);
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
  function addLongPress(el, callback) {
    let timer = null;
    let moved = false;
    const onStart = () => { moved = false; timer = setTimeout(() => { if (!moved) { if (navigator.vibrate) navigator.vibrate(25); callback(); } }, 500); };
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
  }

  // ----- Render -----
  // Tile art size matched to the display: tiles render at ~150-220px CSS, so
  // 500px covers were ~2.8× oversized on DPR-2 iPads — each one an on-demand
  // rescale by the Roon Core. Rounded to coarse steps so the whole session
  // shares a handful of cache keys (server LRU + browser cache); the 300px
  // floor keeps DPR-1 desktops sharp on wide walls where tiles exceed 200px.
  const TILE_IMG_SIZE = Math.min(500, Math.max(300, Math.ceil((190 * (window.devicePixelRatio || 1)) / 100) * 100));

  // Build a single album tile. onClick defaults to opening the album modal,
  // but callers (e.g. the label browser) can override it to carry a filter.
  function buildAlbumTile(a, onClick) {
    const btn = document.createElement("button");
    btn.className = "album";
    btn.type = "button";
    btn.setAttribute("aria-label",
      `${a.title || "Untitled"}${a.subtitle ? " by " + a.subtitle : ""}`);
    btn.dataset.albumKey = (a.title || "").toLowerCase().trim();

    const artWrap = document.createElement("div");
    artWrap.className = "album-art-wrap";
    if (a.image_key) {
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = "";
      img.src = `/api/image/${encodeURIComponent(a.image_key)}?size=${TILE_IMG_SIZE}`;
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
    btn.addEventListener("click", () => {
      if (!onClick && albumSelectMode) { handleAlbumTileSelect(btn, a); return; }
      (onClick || (() => openAlbum(a)))();
    });
    if (!onClick) {
      addLongPress(btn, () => {
        if (!albumSelectMode) enterAlbumSelectMode();
        handleAlbumTileSelect(btn, a);
      });
    }
    return btn;
  }

  function enterAlbumSelectMode() {
    albumSelectMode = true;
    if (albumActionBar) { albumActionBar.classList.remove("hidden"); updateAlbumActionBar(); }
  }

  function exitAlbumSelectMode() {
    albumSelectMode = false;
    albumSelected = [];
    if (albumActionBar) albumActionBar.classList.add("hidden");
    grid.querySelectorAll(".album.is-selected").forEach(b => b.classList.remove("is-selected"));
  }

  function updateAlbumActionBar() {
    const n = albumSelected.length;
    if (albumActionInfo) albumActionInfo.textContent = n === 0 ? "Tap albums to select" : n + " album" + (n === 1 ? "" : "s") + " selected";
    if (albumPlayNowBtn) albumPlayNowBtn.disabled = n === 0;
    if (albumQueueBtn)   albumQueueBtn.disabled   = n === 0;
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
    el.textContent = text;
    el.classList.remove("hidden");
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
      item.textContent = z.display_name;
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

  function setModalArtist(subtitle) {
    modalSub.innerHTML = "";
    if (!subtitle) return;
    // Split on common multi-artist separators so each name becomes its own link.
    // " / " is Roon's standard separator; feat/featuring/ft handle featured artists.
    // " & " is intentionally NOT split — it is often part of a band name (e.g. "Simon & Garfunkel").
    const parts = subtitle.split(/ \/ | feat\.? | featuring | ft\.? /i).map(s => s.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "modal-subtitle-year";
        sep.textContent = " / ";
        modalSub.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.className = "modal-artist-link";
      btn.textContent = part;
      btn.addEventListener("click", () => {
        closeModal();
        if (window.__exitLabels) window.__exitLabels();   // leave the labels browser if active
        window.__showArtistAlbums && window.__showArtistAlbums(part);
      });
      modalSub.appendChild(btn);
    });
  }

  function openAlbum(album, opts) {
    opts = opts || {};
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

    if (name === "queue") loadQueue();
    if (typeof window.__refreshTransport === "function") window.__refreshTransport();
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
        const ti = document.createElement("span"); ti.className = "t-title";
        ti.textContent = t.title || "";
        const su = document.createElement("span"); su.className = "t-sub";
        su.textContent = t.subtitle || "";
        li.appendChild(ti); li.appendChild(su);
        modalTracks.appendChild(li);
      }
    } else {
      wrap.classList.add("hidden");
    }
  }

  async function loadQueue() {
    if (!currentSourceZoneId) return;
    const summary = document.getElementById("queue-summary");
    const list    = document.getElementById("queue-list");
    const empty   = document.getElementById("queue-empty");
    summary.textContent = "Loading queue…";
    list.innerHTML = "";
    empty.classList.add("hidden");
    try {
      const r = await fetch(`/api/queue?zone=${encodeURIComponent(currentSourceZoneId)}`);
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
            if (!window.confirm(`Play from "${trackName}"?`)) return;
            try {
              const r = await fetch("/api/play-from-here", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  zone_or_output_id: currentSourceZoneId,
                  queue_item_id: it.queue_item_id
                })
              });
              if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                window.alert("Couldn't play from here: " + (j.error || `HTTP ${r.status}`));
                return;
              }
              // Give Roon a moment, then re-pull the queue so the "now playing"
              // marker moves and earlier-played tracks fall away.
              setTimeout(loadQueue, 600);
            } catch (e) {
              window.alert("Couldn't play from here: " + e.message);
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
    const r = await fetch(`/api/album?offset=${album.offset}${filterQSOf(currentDetailFilter)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();

    // Modal may have been closed/reopened on a different album while we
    // waited — bail rather than render album A's rows (whose tap handlers
    // would fire against album B's offset). Same guard as fetchAlbumExtras.
    if (album !== currentAlbum) return;

    // Only accept server title if it matches what we expected — guards against
    // stale index offsets returning a completely different album after a library change.
    if (j.album && j.album.title) {
      const expectedNorm = currentAlbum ? (currentAlbum.title || "").toLowerCase().trim() : "";
      const returnedNorm = (j.album.title || "").toLowerCase().trim();
      if (!expectedNorm || returnedNorm === expectedNorm) {
        modalTitle.textContent = j.album.title;
        // Subtitle already set as a clickable button by openAlbum(); don't overwrite.
      }
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

    modalActs.innerHTML = "";
    let first = true;
    for (const k of order) {
      if (!map.has(k)) continue;
      const btn = document.createElement("button");
      btn.className = "action-btn" + (first ? " primary" : "");
      btn.type = "button";
      btn.textContent = labels[k];
      btn.addEventListener("click", () => invoke(k, btn));
      modalActs.appendChild(btn);
      first = false;
    }
    if (!modalActs.children.length) {
      modalActs.innerHTML =
        `<div class="modal-error">No playback actions available for this album.</div>`;
    }

    // Tracks — each row is tappable and reveals Play now / Queue for that
    // track (one open row at a time; tapping again collapses it).
    const trackWrap = document.querySelector(".track-list-wrap");
    modalTracks.innerHTML = "";
    const trackList = j.tracks || [];
    if (trackList.length === 0) {
      trackWrap.classList.add("hidden");
    } else {
      trackWrap.classList.remove("hidden");
      trackList.forEach((t, idx) => {
        const li = document.createElement("li");
        li.className = "t-row";
        const ti = document.createElement("span"); ti.className = "t-title";
        ti.textContent = t.title || "";
        const su = document.createElement("span"); su.className = "t-sub";
        su.textContent = t.subtitle || "";
        li.appendChild(ti); li.appendChild(su);
        li.addEventListener("click", (e) => {
          if (e.target.closest(".t-actions")) return;   // taps on the buttons themselves
          toggleTrackActions(li, t, idx);
        });
        modalTracks.appendChild(li);
      });
    }
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
          zone_or_output_id: selectedZoneId,
          kind,
          filter_type:   currentDetailFilter ? currentDetailFilter.type   : "",
          filter_value:  currentDetailFilter ? currentDetailFilter.value  : "",
          filter_parent: currentDetailFilter && currentDetailFilter.parent ? currentDetailFilter.parent : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
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
      // The search box is always present on Home; Escape just clears it.
      if (e.key === "Escape") { input.value = ""; stopSearch(); input.blur(); }
    });

    // The X has two stages: 1st tap clears the text (bar stays open), 2nd tap
    // (now empty) closes the bar.
    clear.addEventListener("click", () => {
      // The box stays present on Home; clearing empties it and restores the
      // Home sections, keeping focus so the user can retype.
      input.value = "";
      stopSearch();
      input.focus();
    });

    window.__runSearch = (q) => { input.value = q; onInput(); };
    // Called when leaving Home for the wall/labels so stale search results
    // don't linger in the shared grid. No-op unless a search is active.
    window.__clearSearchIfActive = () => { if (active) { input.value = ""; stopSearch(); } };
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
      if (!isRepoll) {
        if (window.__clearSearchIfActive) window.__clearSearchIfActive();  // drop stale search results
        exitAlbumSelectMode(); closeLabelLogoSheet(); currentLabelName = null; currentLabelLogoUrl = null;
      }
      const restoreScroll = !isRepoll && _labelsScrollSaved > 0;
      mode = "list";
      labelsActive = true;
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
          frag.appendChild(buildAlbumTile(a, () => openAlbum(a)));
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
    if (albumPlayNowBtn) albumPlayNowBtn.disabled = true;
    if (albumQueueBtn)   albumQueueBtn.disabled   = true;
    try {
      const r = await fetch("/api/play-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offsets: albumSelected.map(a => a.offset),
          zone_or_output_id: selectedZoneId,
          kind,
          filter_type:   activeFilter ? activeFilter.type   : "",
          filter_value:  activeFilter ? activeFilter.value  : "",
          filter_parent: activeFilter && activeFilter.parent ? activeFilter.parent : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const n = albumSelected.length;
      const verb = kind === "play_now" ? "Playing" : "Queued";
      showToast(verb + " " + n + " album" + (n === 1 ? "" : "s") + " → " + zoneName(selectedZoneId));
      exitAlbumSelectMode();
    } catch (e) {
      showToast(e.message, "error");
      updateAlbumActionBar();
    }
  }

  if (albumPlayNowBtn)      albumPlayNowBtn.addEventListener("click",      () => invokeAlbumMulti("play_now"));
  if (albumQueueBtn)        albumQueueBtn.addEventListener("click",        () => invokeAlbumMulti("queue"));
  if (albumActionCancelBtn) albumActionCancelBtn.addEventListener("click", exitAlbumSelectMode);

  window.__openAlbum = openAlbum;
  window.__buildAlbumTile = (a) => buildAlbumTile(a);
  window.__loadRandom = loadRandom;
  window.__showToast = (msg, kind) => showToast(msg, kind);

  async function bootstrap() {
    // Instant open: paint the last Home from cache before we've reconnected, so
    // reopening the PWA shows content immediately instead of reloading the whole
    // screen. Skipped when a filtered wall is being restored (activeFilter), and
    // when there's nothing cached (first-ever launch) we fall back to the banner.
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
  const npIconVol   = document.getElementById("np-icon-vol");
  const npIconMute  = document.getElementById("np-icon-mute");
  const npVolSlider = document.getElementById("np-vol-slider");

  let currentZone = null;       // server-side zone state
  let pollTimer   = null;
  let lastNpImgKey = null;
  let userIsDraggingVolume = false;
  let userIsDraggingSeek   = false;
  let npLen = 0;                // current track length (s)
  let npPos = 0;                // local seek position (s), advanced between polls

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
          const match =
            rs.find(a => norm(a.title) === norm(albumTitle) &&
                         artist && norm(a.subtitle).includes(norm(artist.split(" ")[0]))) ||
            rs.find(a => norm(a.title) === norm(albumTitle)) ||
            rs[0];
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
      npLen = 0; npPos = 0;
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
    const barSig = [np.line1, np.line2, np.line3, zone.state, muted,
                    volOutput ? volOutput.volume.value : "novol"].join("|");
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

      // Volume: use the first output that has a volume control
      if (volOutput) {
        const v = volOutput.volume;
        volSlider.min   = v.min   != null ? v.min  : 0;
        volSlider.max   = v.max   != null ? v.max  : 100;
        volSlider.step  = v.step  != null ? v.step : 1;
        if (!userIsDraggingVolume) {
          volSlider.value = v.value;
          volVal.textContent = Math.round(v.value);
        }
        btnVol.disabled = false;
      } else {
        btnVol.disabled = true;
      }

      iconVol .classList.toggle("hidden",  muted);
      iconMute.classList.toggle("hidden", !muted);
    }

    // Resync the local seek baseline used by the now-playing screen's ticker.
    npLen = np.length || 0;
    npPos = np.seek_position != null ? np.seek_position : 0;
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
    if (!np) { setNpTrack(null); npArtist.textContent = ""; npAlbum.textContent = ""; return; }

    setNpTrack(np.line1);
    npArtist.textContent = np.line2 || "";
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
    if (npLen > 0) {
      npSeek.max = npLen;
      if (!userIsDraggingSeek) {
        npSeek.value = Math.min(npPos, npLen);
        npCur.textContent = fmtTime(npPos);
      }
      npTot.textContent = fmtTime(npLen);
    } else {
      npSeek.max = 100; npSeek.value = 0;
      npCur.textContent = "0:00"; npTot.textContent = "0:00";
    }
    paintSeek();

    // Volume — show the slider only when the endpoint has a controllable
    // volume; otherwise show "Volume control is fixed" (matches Roon).
    const volOutput = (currentZone.outputs || []).find(o => o.volume);
    if (volOutput) {
      const v = volOutput.volume;
      npVolSlider.min  = v.min  != null ? v.min  : 0;
      npVolSlider.max  = v.max  != null ? v.max  : 100;
      npVolSlider.step = v.step != null ? v.step : 1;
      if (!userIsDraggingVolume) npVolSlider.value = v.value;
      npVolSlider.classList.remove("hidden");
      if (npVolFixed) npVolFixed.classList.add("hidden");
    } else {
      npVolSlider.classList.add("hidden");
      if (npVolFixed) npVolFixed.classList.remove("hidden");
    }
    const muted = (currentZone.outputs || []).some(o => o.is_muted);
    npIconVol .classList.toggle("hidden",  muted);
    npIconMute.classList.toggle("hidden", !muted);
  }

  // Thin progress line along the top of the mini bar (Roon-style).
  function paintBarProgress() {
    if (!progFill) return;
    const pct = npLen > 0 ? Math.max(0, Math.min(100, (npPos / npLen) * 100)) : 0;
    progFill.style.width = pct + "%";
  }

  // Paint the elapsed portion of the scrubber blue (before the thumb).
  function paintSeek() {
    if (!npSeek) return;
    const max = parseFloat(npSeek.max) || 0;
    const val = parseFloat(npSeek.value) || 0;
    const pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
    npSeek.style.setProperty("--seek-fill",
      "linear-gradient(to right, var(--accent) 0%, var(--accent) " + pct + "%, " +
      "var(--border) " + pct + "%, var(--border) 100%)");
  }

  async function seek(seconds) {
    if (!currentZone) return;
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

  async function setVolume(value) {
    if (!currentZone) return;
    try {
      await fetch("/api/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_or_output_id: currentZone.zone_id, value })
      });
    } catch (e) { /* ignore */ }
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

  // Close the now-playing popovers when tapping outside the controls row.
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".np-secondary")) return;
    if (npVolPopover) npVolPopover.classList.add("hidden");
    if (npVolBtn) npVolBtn.setAttribute("aria-expanded", "false");
    const dp = document.getElementById("np-device-popover");
    const db = document.getElementById("np-device");
    if (dp) dp.classList.add("hidden");
    if (db) db.setAttribute("aria-expanded", "false");
  });

  // Now-playing scrubber: show the dragged time live, seek on release.
  if (npSeek) {
    npSeek.addEventListener("input", () => {
      userIsDraggingSeek = true;
      npCur.textContent = fmtTime(parseFloat(npSeek.value));
      paintSeek();
    });
    npSeek.addEventListener("change", () => {
      const target = parseFloat(npSeek.value);
      userIsDraggingSeek = false;
      npPos = target;
      paintSeek();
      seek(target);
    });
  }

  // Now-playing volume slider (kept in sync with the mini bar)
  let npVolDebounce = null;
  if (npVolSlider) {
    npVolSlider.addEventListener("input", () => {
      userIsDraggingVolume = true;
      const v = parseFloat(npVolSlider.value);
      volSlider.value = v; volVal.textContent = Math.round(v);
      clearTimeout(npVolDebounce);
      npVolDebounce = setTimeout(() => setVolume(v), 90);
    });
    npVolSlider.addEventListener("change", () => {
      userIsDraggingVolume = false;
      setVolume(parseFloat(npVolSlider.value));
    });
  }

  // Advance the now-playing progress bar smoothly between 1.5s polls.
  setInterval(() => {
    if (!currentZone || !currentZone.now_playing || userIsDraggingSeek) return;
    const playing = currentZone.state === "playing" || currentZone.state === "loading";
    if (!playing || npLen <= 0 || npPos >= npLen) return;
    npPos += 1;
    paintBarProgress();
    if (onNowPlayingScreen()) {
      npSeek.value = Math.min(npPos, npLen);
      npCur.textContent = fmtTime(npPos);
      paintSeek();
    }
  }, 1000);

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
    volVal.textContent = Math.round(parseFloat(volSlider.value));
    clearTimeout(volDebounce);
    volDebounce = setTimeout(() => setVolume(parseFloat(volSlider.value)), 90);
  });
  volSlider.addEventListener("change", () => {
    userIsDraggingVolume = false;
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
      item.textContent = z.display_name;
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

  // Volume +/- buttons
  const stepMinus = document.getElementById("mt-vol-minus");
  const stepPlus  = document.getElementById("mt-vol-plus");
  function stepVolume(delta) {
    if (!currentZone) return;
    const cur = parseFloat(volSlider.value);
    const min = parseFloat(volSlider.min);
    const max = parseFloat(volSlider.max);
    const next = Math.max(min, Math.min(max, cur + delta));
    volSlider.value = next;
    volVal.textContent = Math.round(next);
    setVolume(next);
  }
  if (stepMinus) stepMinus.addEventListener("click", (e) => { e.stopPropagation(); stepVolume(-2); });
  if (stepPlus)  stepPlus .addEventListener("click", (e) => { e.stopPropagation(); stepVolume(+2); });

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
    if (document.hidden) stopPolling();
    else startPolling();
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
            ? "MusicD Random Albums v" + parts[0] + "." + parts[1] + " (Build " + parts[2] + ")"
            : "MusicD Random Albums v" + s.current;
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

  // ----- Wall display (/display): toggle + rotation interval + YouTube key -----
  const displayToggle    = document.getElementById("display-toggle");
  const displaySeconds   = document.getElementById("display-seconds");
  const displaySecsValue = document.getElementById("display-seconds-value");
  const youtubeKeyInput  = document.getElementById("youtube-key-input");
  const youtubeKeySave   = document.getElementById("youtube-key-save");
  const youtubeKeyStatus = document.getElementById("youtube-key-status");

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
    try {
      const r = await fetch("/api/settings/youtube-key");
      const j = await r.json();
      if (youtubeKeyStatus) youtubeKeyStatus.textContent = j.set ? ("Current: " + j.masked) : "Not set (video slides off)";
    } catch (_) { /* same — status stays stale */ }
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
  if (youtubeKeySave) {
    youtubeKeySave.addEventListener("click", async () => {
      const key = youtubeKeyInput ? youtubeKeyInput.value.trim() : "";
      if (!key) return;
      youtubeKeySave.disabled = true;
      try {
        const r = await fetch("/api/settings/youtube-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key })
        });
        const j = await r.json();
        if (j.ok) {
          if (youtubeKeyInput) youtubeKeyInput.value = "";
          showToast("YouTube key saved", "ok");
          loadDisplaySettings();
        } else {
          showToast(j.error || "Failed to save key", "error");
        }
      } catch (e) {
        showToast("Failed: " + e.message, "error");
      } finally {
        youtubeKeySave.disabled = false;
      }
    });
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

  async function loadQobuzStatus() {
    try {
      const r = await fetch("/api/settings/qobuz");
      const j = await r.json();
      if (qobuzStatus) qobuzStatus.textContent = j.connected
        ? ("Connected" + (j.displayName ? " as " + j.displayName : ""))
        : "Not connected";
      if (qobuzDisconnect) qobuzDisconnect.classList.toggle("hidden", !j.connected);
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

  // Boot-time gate: the topbar Tidal button must appear (when connected)
  // without the user ever opening Settings.
  loadTidalStatus();

  const open = () => { loadRadio(); loadVersion(); loadDiscogsToken(); loadFanartKey(); loadDisplaySettings(); loadLabelFolderDepth(); loadQobuzStatus(); loadTidalStatus(); overlay.classList.remove("hidden"); };
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
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
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
  btn.addEventListener("click", async () => {
    const zone = zoneSelect && zoneSelect.value;
    if (!zone) { if (window.__showToast) window.__showToast("Select a zone first"); return; }
    if (btn.classList.contains("spinning")) return;

    // Spin the compass for 2 seconds, then fetch
    btn.classList.add("spinning");
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
      btn.classList.remove("spinning");
    }
  });
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

  function exitArtistView() {
    if (!artistViewActive) return;
    artistViewActive = false;
    // Restore exactly the screen the artist view was opened from (the Home
    // landing, or an album wall) so Back doesn't dump the user somewhere else.
    if (saved) {
      grid.innerHTML = saved.gridHtml;
      grid.classList.toggle("hidden", saved.gridHidden);
      if (homeView)     homeView.classList.toggle("hidden", saved.homeViewHidden);
      if (homeSections) homeSections.classList.toggle("hidden", saved.homeSectionsHidden);
      if (countBar) { countBar.innerHTML = saved.countHtml; countBar.classList.toggle("hidden", saved.countHidden); }
      if (topbarBack)    topbarBack.classList.toggle("hidden", saved.topbarBackHidden);
      if (topbarRefresh) topbarRefresh.classList.toggle("hidden", saved.topbarRefreshHidden);
      if (topbarSearch)  topbarSearch.classList.toggle("hidden", saved.topbarSearchHidden);
    }
    saved = null;
  }

  async function showArtistAlbums(artistName) {
    if (!artistName) return;
    // Drop any active/pending search (incl. the delayed external-sources fetch)
    // — reachable from the album-modal artist link with a search still live,
    // which would otherwise append external rows under this view's grid. The
    // search artist-chip stops the search itself; this covers every other path.
    if (window.__clearSearchIfActive) window.__clearSearchIfActive();
    if (artistViewActive) exitArtistView();
    // Snapshot the screen we're leaving (Home landing or an album wall) so the
    // "← Back" button restores it exactly.
    saved = {
      gridHtml:           grid.innerHTML,
      gridHidden:         grid.classList.contains("hidden"),
      homeViewHidden:     homeView     ? homeView.classList.contains("hidden")     : true,
      homeSectionsHidden: homeSections ? homeSections.classList.contains("hidden") : true,
      countHtml:          countBar ? countBar.innerHTML : "",
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
    } catch (e) {
      if (countBar) {
        countBar.innerHTML = `
          <button class="artist-view-back" id="artist-back-btn">← Back</button>
          <span class="count-text" style="color:var(--danger)">Error: ${e.message}</span>`;
        document.getElementById("artist-back-btn").addEventListener("click", exitArtistView);
      }
    }
  }

  window.__showArtistAlbums = showArtistAlbums;
  window.__exitArtistView   = exitArtistView;
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

  const openMenu  = () => overlay.classList.remove("hidden");
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
