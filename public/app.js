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
  let albumCount = computeAlbumCount();
  let labelsActive = false;        // viewing the record-label browser?
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
           "&filter_value=" + encodeURIComponent(f.value);
  }
  function filterQS() { return filterQSOf(activeFilter); }
  function filterCacheKey() {
    return activeFilter ? activeFilter.type + ":" + activeFilter.value : "all";
  }

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
  //   Phone portrait   → 3×3  = 9   (landscape is blocked via CSS overlay)
  //   Tablet portrait  → 5×4  = 20
  //   Tablet landscape → 7×3  = 21
  //   Desktop          → 9×5  = 45
  function computeAlbumCount() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isLandscape = w > h;
    const minDim = Math.min(w, h);  // smallest dimension identifies phones vs tablets

    // Phone (narrowest side < 768 px)
    if (minDim < 768) return 9;     // 3×3, landscape is blocked via CSS overlay

    // Desktop (width ≥ 1200 px)
    if (w >= 1200) return 45;       // 9×5

    // Tablet (768–1199 px)
    return isLandscape ? 21 : 20;   // 7×3 or 5×4
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
      img.src = `/api/image/${encodeURIComponent(a.image_key)}?size=500`;
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
  // ----- Library album count (header readout) -----
  let libraryAlbumTotal = null;
  async function loadAlbumCount() {
    const el = document.getElementById("album-count");
    if (!el) return;
    try {
      const r = await fetch("/api/library-stats");
      if (!r.ok) return;
      const j = await r.json();
      if (typeof j.albums === "number" && j.albums > 0) {
        libraryAlbumTotal = j.albums;
        updateCountReadout(null);
      }
    } catch (e) { /* non-fatal — album count header stays blank until next refresh */ }
  }
  // Set the header readout text directly (used by the labels browser).
  function setCountText(text) {
    const el = document.getElementById("album-count");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }
  // filteredTotal: pool size when a filter is active, else null.
  function updateCountReadout(filteredTotal) {
    const el = document.getElementById("album-count");
    if (!el) return;
    if (labelsActive) return;   // labels browser manages its own header text
    if (activeFilter && typeof filteredTotal === "number") {
      el.textContent = filteredTotal.toLocaleString() + " albums \u00b7 " + activeFilter.value;
      el.classList.remove("hidden");
    } else if (activeFilter) {
      el.textContent = activeFilter.value;
      el.classList.remove("hidden");
    } else if (libraryAlbumTotal != null) {
      el.textContent = libraryAlbumTotal.toLocaleString() + " albums";
      el.classList.remove("hidden");
    }
  }

  async function loadRandom() {
    refreshBtn.disabled = true;
    albumCount = computeAlbumCount();
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
      try {
        sessionStorage.setItem("rra-albums",
          JSON.stringify({ filter: filterCacheKey(), list: j.albums || [] }));
      } catch (e) {} // sessionStorage may be unavailable (private browsing quota) — cache is optional
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
    currentDetailFilter = opts.filter || activeFilter;

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
    } else {
      modalImg.removeAttribute("src");
      modalImg.style.display = "none";
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

    // Tracks
    const trackWrap = document.querySelector(".track-list-wrap");
    modalTracks.innerHTML = "";
    const trackList = j.tracks || [];
    if (trackList.length === 0) {
      trackWrap.classList.add("hidden");
    } else {
      trackWrap.classList.remove("hidden");
      for (const t of trackList) {
        const li = document.createElement("li");
        const ti = document.createElement("span"); ti.className = "t-title";
        ti.textContent = t.title || "";
        const su = document.createElement("span"); su.className = "t-sub";
        su.textContent = t.subtitle || "";
        li.appendChild(ti); li.appendChild(su);
        modalTracks.appendChild(li);
      }
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
        srcLink.textContent = "View on " + extras.album.source;
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
          filter_type:  currentDetailFilter ? currentDetailFilter.type  : "",
          filter_value: currentDetailFilter ? currentDetailFilter.value : ""
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`${j.action || orig} → ${zoneName(selectedZoneId)}`);
      if (kind === "play_now" || kind === "shuffle" || kind === "radio") {
        setTimeout(closeModal, 600);
      }
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
    const toggle   = document.getElementById("search-toggle");
    const row      = document.getElementById("search-row");
    if (!input || !row) return;

    let seq           = 0;     // guards against out-of-order responses
    let abort         = null;  // in-flight fetch controller
    let debounceTimer = null;
    let retryTimer    = null;
    let active        = false; // currently showing search results?

    function setStatus(msg) { statusEl.textContent = msg || ""; }

    // Stop searching and restore the random wall, WITHOUT touching whether the
    // bar itself is open. Used when the field is emptied (incl. the 1st X tap).
    function stopSearch() {
      active = false;
      seq++;                                   // invalidate any pending response
      if (abort) { try { abort.abort(); } catch (e) {} abort = null; }
      clearTimeout(retryTimer);
      setStatus("");
      // Restore the wall the user had (cached by loadRandom on each load), or
      // fetch a fresh one if nothing's cached yet.
      let restored = false;
      try {
        const cached = sessionStorage.getItem("rra-albums");
        if (cached) {
          const parsed = JSON.parse(cached);
          const list = Array.isArray(parsed) ? parsed : (parsed && parsed.list);
          const key  = Array.isArray(parsed) ? "all"  : (parsed && parsed.filter);
          if (Array.isArray(list) && list.length && key === filterCacheKey()) {
            setBanner(null);
            renderAlbumGrid(list);
            restored = true;
          }
        }
      } catch (e) {} // corrupt sessionStorage cache — fallback to loadRandom() below
      if (!restored) loadRandom();
    }

    function openSearch() {
      row.classList.add("open");
      toggle.classList.add("is-active");
      toggle.setAttribute("aria-expanded", "true");
      // Focus synchronously inside the tap handler — iOS only raises the
      // keyboard for a .focus() call made directly within the user gesture.
      input.focus();
    }

    // Fully close the bar (and clear any query / results behind it).
    function closeSearch() {
      const hadQuery = !!input.value.trim();
      input.value = "";
      if (hadQuery) stopSearch();              // repaint wall only if we were searching
      row.classList.remove("open");
      toggle.classList.remove("is-active");
      toggle.setAttribute("aria-expanded", "false");
      input.blur();
    }

    async function run(q) {
      const mySeq = ++seq;
      if (abort) { try { abort.abort(); } catch (e) {} }
      abort = new AbortController();
      clearTimeout(retryTimer);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=60`,
                              { signal: abort.signal, cache: "no-store" });
        if (mySeq !== seq) return;                       // superseded by a newer keystroke
        if (r.status === 503) { setBanner("Waiting for Roon Core…", true); return; }
        if (!r.ok) { setStatus("search error"); return; }
        const j = await r.json();
        if (mySeq !== seq) return;

        if (j.building) {
          // First-time index build still running — show progress and retry.
          const pct = Math.round((j.progress || 0) * 100);
          setStatus(`Building index… ${pct}%`);
          grid.innerHTML = "";
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
          setBanner(`No matches for \u201C${q}\u201D.`, false);
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
      } catch (e) {
        if (e && e.name === "AbortError") return;        // expected when typing fast
        if (mySeq === seq) setStatus("search error");
      }
    }

    function onInput() {
      const q = input.value.trim();
      clearTimeout(debounceTimer);
      if (!q) { stopSearch(); return; }                  // emptied: restore wall, keep bar open
      if (window.__exitLabels) window.__exitLabels();    // leave the label browser
      exitAlbumSelectMode();
      active = true;
      // Small debounce: long enough to coalesce a fast burst, short enough to
      // still feel instant.
      debounceTimer = setTimeout(() => run(q), 120);
    }

    // Magnifier toggles the bar open/closed.
    toggle.addEventListener("click", () => {
      if (row.classList.contains("open")) closeSearch();
      else openSearch();
    });

    input.addEventListener("input",  onInput);
    input.addEventListener("search", onInput);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearch();
    });

    // The X has two stages: 1st tap clears the text (bar stays open), 2nd tap
    // (now empty) closes the bar.
    clear.addEventListener("click", () => {
      if (input.value.trim()) {
        input.value = "";
        stopSearch();
        input.focus();
      } else {
        closeSearch();
      }
    });

    // Refresh means "new random wall", so it also drops out of search mode.
    // (loadRandom — wired in Boot below — repaints the grid; we just reset UI.)
    if (refreshBtn) refreshBtn.addEventListener("click", () => {
      input.value = ""; active = false; seq++;
      clearTimeout(debounceTimer); clearTimeout(retryTimer);
      if (abort) { try { abort.abort(); } catch (e) {} abort = null; }
      setStatus("");
      row.classList.remove("open");
      toggle.classList.remove("is-active");
      toggle.setAttribute("aria-expanded", "false");
    });

    window.__runSearch = (q) => { openSearch(); input.value = q; onInput(); };
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
      try { sessionStorage.removeItem("rra-albums"); } catch (e) {} // sessionStorage optional
      if (window.__exitLabels) window.__exitLabels();
      markActive();
      close();
      updateCountReadout(null);
      loadRandom();
    }

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
      if (!isRepoll) { exitAlbumSelectMode(); closeLabelLogoSheet(); currentLabelName = null; currentLabelLogoUrl = null; }
      const restoreScroll = !isRepoll && _labelsScrollSaved > 0;
      mode = "list";
      labelsActive = true;
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
        setCountText(labels.length.toLocaleString() + " labels");
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
        setCountText(albums.length.toLocaleString() + " albums · " + name);
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
          filter_type:  activeFilter ? activeFilter.type  : "",
          filter_value: activeFilter ? activeFilter.value : ""
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
    setBanner("Connecting to Roon…");
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch("/api/status");
        const j = await r.json();
        if (j.paired) {
          setBanner(null);
          await loadZones();

          // Restore album wall from sessionStorage if present so navigating
          // away (e.g. external link) and back doesn't shuffle the view.
          let restored = false;
          try {
            const cached = sessionStorage.getItem("rra-albums");
            if (cached) {
              const parsed = JSON.parse(cached);
              const list = Array.isArray(parsed) ? parsed : (parsed && parsed.list);
              const key  = Array.isArray(parsed) ? "all"  : (parsed && parsed.filter);
              if (Array.isArray(list) && list.length && key === filterCacheKey()) {
                renderAlbums(list);
                restored = true;
              }
            }
          } catch (e) {} // corrupt sessionStorage — fallback to loadRandom() below
          if (!restored) await loadRandom();
          loadAlbumCount();

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

  function saveTransportState(zone) {
    if (!zone || !zone.now_playing) return;
    const np = zone.now_playing;
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

    // Title = track, subtitle = artist · album
    titleEl.textContent  = np.line1 || "—";
    const sub = [np.line2, np.line3].filter(Boolean).join(" · ");
    artistEl.textContent = sub || "—";

    // Play/pause state
    const playing = zone.state === "playing" || zone.state === "loading";
    iconPlay .classList.toggle("hidden",  playing);
    iconPause.classList.toggle("hidden", !playing);
    btnPP.setAttribute("aria-label", playing ? "Pause" : "Play");

    // Volume: use the first output that has a volume control
    const volOutput = (zone.outputs || []).find(o => o.volume);
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

    const muted = (zone.outputs || []).some(o => o.is_muted);
    iconVol .classList.toggle("hidden",  muted);
    iconMute.classList.toggle("hidden", !muted);

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

  // Populate the Roon-style now-playing screen from the live zone state.
  function updateNpScreen() {
    if (!npTrack || !onNowPlayingScreen()) return;
    const np = currentZone && currentZone.now_playing;
    if (!np) { npTrack.textContent = "—"; npArtist.textContent = ""; npAlbum.textContent = ""; return; }

    npTrack.textContent  = np.line1 || "—";
    npArtist.textContent = np.line2 || "";
    npAlbum.textContent  = np.line3 || "";
    if (npAlbum) npAlbum.setAttribute("aria-label", "Open album: " + (np.line3 || ""));

    if (bigArt && np.image_key && np.image_key !== lastNpImgKey) {
      bigArt.src = "/api/image/" + encodeURIComponent(np.image_key) + "?size=800";
      lastNpImgKey = np.image_key;
    }

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

  const open = () => { loadRadio(); loadVersion(); loadDiscogsToken(); loadFanartKey(); loadLabelFolderDepth(); loadQobuzStatus(); overlay.classList.remove("hidden"); };
  const close = () => overlay.classList.add("hidden");

  openBtn.addEventListener("click", open);
  overlay.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-settings-close")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
})();

/* ------------------------------------------------------------------ */
/*  Qobuz New Releases — self-contained overlay (browse + favourite)   */
/*  Isolated from the album grid / labels / filters; uses only the     */
/*  Qobuz API endpoints and window.__showToast.                        */
/* ------------------------------------------------------------------ */
(function initQobuzNewReleases() {
  const btn      = document.getElementById("qobuz-toggle");
  const overlay  = document.getElementById("qobuz-overlay");
  const listEl   = document.getElementById("qobuz-nr-list");
  const statusEl = document.getElementById("qobuz-nr-status");
  const detailEl = document.getElementById("qobuz-nr-detail");
  if (!btn || !overlay) return;

  const toast = (msg, kind) => { if (window.__showToast) window.__showToast(msg, kind); };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const overlayVisible = () => !overlay.classList.contains("hidden");
  const detailVisible  = () => !!detailEl && !detailEl.classList.contains("hidden");

  // Fully hide the overlay (and any open detail).
  function hideOverlay() {
    overlay.classList.add("hidden");
    if (detailEl) { detailEl.classList.add("hidden"); detailEl.innerHTML = ""; detailEl.dataset.albumId = ""; }
  }

  // All back/close affordances (× button, backdrop, ‹ Back, Esc) step back one
  // history level via history.back(), which the popstate handler turns into
  // detail → list → closed. This also makes the Android/browser back button
  // behave naturally instead of leaving the page.
  const goBack = () => history.back();

  overlay.querySelectorAll("[data-qobuz-close]").forEach(el => el.addEventListener("click", goBack));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayVisible()) goBack();
  });

  // Browser / Android back: while the overlay is open, unwind detail→list→closed
  // rather than navigating away. No-op when the overlay isn't open, so the rest
  // of the app (which uses no history state) is unaffected.
  window.addEventListener("popstate", () => {
    if (!overlayVisible()) return;
    if (detailVisible()) showList();
    else hideOverlay();
  });

  // Reflect favourite state on a button (added = in the user's Qobuz library).
  function setFavState(button, added) {
    button.dataset.fav = added ? "1" : "0";
    button.textContent = added ? "✓ Added" : "♥ Favourite";
    button.classList.toggle("is-done", added);
  }

  // Toggle favourite/un-favourite against Qobuz, updating every button that
  // represents this album (the list row and, if open, the detail view) so they
  // stay in sync. `buttons` may be a single button or an array.
  async function toggleFavourite(albumId, buttons) {
    const btns = (Array.isArray(buttons) ? buttons : [buttons]).filter(Boolean);
    if (!btns.length) return;
    const wasAdded = btns[0].dataset.fav === "1";
    const prev = btns.map(b => b.textContent);
    btns.forEach(b => { b.disabled = true; b.textContent = "…"; });
    try {
      const r = await fetch(wasAdded ? "/api/qobuz/unfavorite" : "/api/qobuz/favorite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ album_id: albumId })
      });
      const j = await r.json();
      if (j.ok) {
        btns.forEach(b => setFavState(b, !wasAdded));
        toast(wasAdded ? "Removed from Qobuz favourites" : "Added to Qobuz favourites", "ok");
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

  // Return from the album detail view to the releases list.
  function showList() {
    if (detailEl) { detailEl.classList.add("hidden"); detailEl.innerHTML = ""; detailEl.dataset.albumId = ""; }
    if (listEl) listEl.classList.remove("hidden");
    if (statusEl) statusEl.classList.remove("hidden");
  }

  // Open an isolated detail view for a Qobuz album: artwork, editorial review
  // (fetched by title+artist via /api/album/extras — no Roon needed), and a
  // favourite toggle kept in sync with the originating list row's button.
  async function openDetail(album, rowFavBtn) {
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
        '<div class="qobuz-nr-detail-title">'  + esc(album.title)  + '</div>' +
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

    if (listEl) listEl.classList.add("hidden");
    if (statusEl) statusEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
    history.pushState({ qz: "detail" }, ""); // so back returns to the list, not the wall

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
        const p = document.createElement("div");
        p.className = "qobuz-nr-review-text";
        p.textContent = desc;
        review.appendChild(p);
        if (alb.url && alb.source) {
          const link = document.createElement("a");
          link.className = "qobuz-nr-review-src";
          link.href = alb.url; link.target = "_blank"; link.rel = "noopener";
          link.textContent = "View on " + alb.source;
          review.appendChild(link);
        }
      } else {
        review.textContent = "No review available for this release.";
      }
    } catch (e) {
      if (detailEl.dataset.albumId === String(album.id)) review.textContent = "Couldn't load review.";
    }
  }

  async function load() {
    showList(); // reset to the list (in case a detail view was open)
    if (statusEl) statusEl.textContent = "Loading new releases…";
    if (listEl) listEl.innerHTML = "";
    try {
      const r = await fetch("/api/qobuz/new-releases?days=30");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      const albums = j.albums || [];
      if (statusEl) statusEl.textContent = albums.length
        ? (albums.length + " releases in the last " + (j.days || 30) + " days")
        : ("No new releases found in the last " + (j.days || 30) + " days.");
      const frag = document.createDocumentFragment();
      for (const a of albums) {
        const row = document.createElement("div");
        row.className = "qobuz-nr-row";
        const art = a.image
          ? '<img class="qobuz-nr-art" loading="lazy" alt="" src="' + esc(a.image) + '">'
          : '<div class="qobuz-nr-art"></div>';
        const date = a.release_date ? '<div class="qobuz-nr-date">' + esc(a.release_date) + '</div>' : '';
        row.innerHTML = art +
          '<div class="qobuz-nr-meta">' +
            '<div class="qobuz-nr-title">'  + esc(a.title)  + '</div>' +
            '<div class="qobuz-nr-artist">' + esc(a.artist) + '</div>' +
            date +
          '</div>';
        const fav = document.createElement("button");
        fav.type = "button";
        fav.className = "qobuz-nr-fav";
        // Tappable toggle: "✓ Added" (in library) ⇄ "♥ Favourite". Initial state
        // reflects the user's current Qobuz favourites (added here or elsewhere).
        setFavState(fav, !!a.favourited);
        fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFavourite(a.id, fav); });
        row.appendChild(fav);
        // Tapping the row (anywhere but the favourite button) opens the detail view.
        row.addEventListener("click", () => openDetail(a, fav));
        frag.appendChild(row);
      }
      if (listEl) listEl.appendChild(frag);
    } catch (e) {
      const notConnected = /not connected/i.test(e.message);
      if (statusEl) statusEl.textContent = notConnected
        ? "Connect your Qobuz account in Settings to see new releases."
        : ("Couldn't load: " + e.message);
    }
  }

  btn.addEventListener("click", () => {
    if (overlayVisible()) return;
    history.pushState({ qz: "list" }, ""); // a back press from the list closes the overlay
    overlay.classList.remove("hidden");
    load();
  });
})();

/* ------------------------------------------------------------------ */
/*  Check for updates button in settings                               */
/* ------------------------------------------------------------------ */
(function initCheckUpdate() {
  const btn      = document.getElementById("check-update-btn");
  const notesDiv = document.getElementById("settings-release-notes");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Checking…";
    if (notesDiv) notesDiv.classList.add("hidden");
    try {
      await fetch("/api/update/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const r = await fetch("/api/update/status", { cache: "no-store" });
      const s = await r.json();
      if (s && s.available && s.latest) {
        const label = s.isDowngrade
          ? "Rollback to v" + s.latest + " available"
          : "v" + s.latest + " available";
        btn.textContent = label + " — tap Update below";
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
  const grid       = document.getElementById("album-grid");
  const countBar   = document.getElementById("content-count");

  let artistViewActive = false;
  let savedGridHtml    = "";
  let savedCountHtml   = "";

  function exitArtistView() {
    if (!artistViewActive) return;
    artistViewActive = false;
    grid.innerHTML    = savedGridHtml;
    if (countBar) { countBar.innerHTML = savedCountHtml; countBar.classList.add("hidden"); }
    // Re-trigger a fresh random load
    if (window.__loadRandom) window.__loadRandom();
  }

  async function showArtistAlbums(artistName) {
    if (!artistName) return;
    if (artistViewActive) exitArtistView();
    artistViewActive = true;
    savedGridHtml    = grid.innerHTML;
    savedCountHtml   = countBar ? countBar.innerHTML : "";

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
