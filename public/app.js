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

  let currentAlbum = null;         // {offset,title,subtitle,image_key}
  let zones = [];
  let selectedZoneId = null;
  let albumCount = computeAlbumCount();
  let labelsActive = false;        // viewing the record-label browser?
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
  } catch (e) {}
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
  //   Phone portrait  → 3×3 = 9
  //   Tablet portrait → 5×5 = 25
  //   Tablet landscape → 7×3 = 21
  //   Desktop          → 9×4 = 36
  function computeAlbumCount() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const isLandscape = w > h;
    const minDim = Math.min(w, h);  // smallest dimension identifies phones vs tablets

    // Phone (narrowest side < 768 px)
    if (minDim < 768) return 9;     // 3×3 — landscape is blocked via CSS overlay

    // Desktop (width ≥ 1200 px)
    if (w >= 1200) return 36;       // 9×4

    // Tablet (768–1199 px)
    return isLandscape ? 21 : 25;   // 7×3 or 5×5
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

  // ----- Render -----
  // Build a single album tile. onClick defaults to opening the album modal,
  // but callers (e.g. the label browser) can override it to carry a filter.
  function buildAlbumTile(a, onClick) {
    const btn = document.createElement("button");
    btn.className = "album";
    btn.type = "button";
    btn.setAttribute("aria-label",
      `${a.title || "Untitled"}${a.subtitle ? " by " + a.subtitle : ""}`);

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
    btn.addEventListener("click", onClick || (() => openAlbum(a)));
    return btn;
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
    } catch (e) { /* non-fatal */ }
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
      } catch (e) {}
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
    modalSub.textContent   = album.subtitle || "";
    modalActs.innerHTML    = isNP ? "" : `<div class="modal-loading">Loading…</div>`;
    modalTracks.innerHTML  = "";

    // Reset bio and listen-on sections
    document.getElementById("album-bio-section").classList.add("hidden");
    document.getElementById("album-bio-toggle").classList.add("hidden");
    document.getElementById("album-bio-source").classList.add("hidden");
    document.getElementById("album-bio-text").dataset.clipped = "true";
    document.getElementById("listen-on-section").classList.add("hidden");
    document.getElementById("listen-apple-music").classList.add("hidden");
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
      fetchAlbumExtras(album).catch(() => {});
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
      if (j.album.subtitle) modalSub.textContent   = j.album.subtitle;
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
    try { sessionStorage.removeItem("rra-modal"); } catch (e) {}
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

    // Update title/subtitle from server in case of any mismatch
    if (j.album) {
      if (j.album.title)    modalTitle.textContent = j.album.title;
      if (j.album.subtitle) modalSub.textContent   = j.album.subtitle;
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
    // 1. Append year to subtitle
    if (extras.year) {
      const parts = [];
      if (album.subtitle) parts.push(album.subtitle);
      parts.push(extras.year);
      modalSub.textContent = parts.join(" · ");
    }

    // 2. Album bio section (label, year, description, source link)
    if (extras.album && (extras.album.description || extras.album.label || extras.album.year)) {
      const section = document.getElementById("album-bio-section");
      const meta    = document.getElementById("album-meta");
      const text    = document.getElementById("album-bio-text");
      const toggle  = document.getElementById("album-bio-toggle");
      const srcLink = document.getElementById("album-bio-source");

      const metaBits = [];
      if (extras.album.year)  metaBits.push(extras.album.year);
      if (extras.album.label) metaBits.push(extras.album.label);
      meta.textContent = metaBits.join(" · ");
      meta.style.display = metaBits.length ? "" : "none";

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

    // 3. Streaming service links
    if (extras.links) {
      const l = extras.links;
      if (l.spotify || l.lastfm || l.apple_music) {
        const section = document.getElementById("listen-on-section");
        if (l.spotify)     document.getElementById("listen-spotify").href  = l.spotify;
        if (l.lastfm)      document.getElementById("listen-lastfm").href   = l.lastfm;
        if (l.apple_music) {
          const appleBtn = document.getElementById("listen-apple-music");
          appleBtn.href = l.apple_music;
          appleBtn.classList.remove("hidden");
        }
        section.classList.remove("hidden");
      }
    }
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
      } catch (e) {}
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
        if (!results.length) {
          grid.innerHTML = "";
          setStatus("");
          setBanner(`No matches for \u201C${q}\u201D.`, false);
          return;
        }
        setBanner(null);
        const more = results.length >= 60 ? "+" : "";
        setStatus(`${results.length}${more} result${results.length === 1 ? "" : "s"}`);
        renderAlbumGrid(results);
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
      } catch (e) {}
      try { sessionStorage.removeItem("rra-albums"); } catch (e) {}
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
        d.textContent = type === "genre" ? "No genres found" : "No tags found";
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

    const loaded = { genre: false, tag: false };
    async function ensureList(type) {
      if (loaded[type]) return;
      const container = type === "genre" ? genresList : tagsList;
      container.innerHTML = '<div class="filter-empty">Loading\u2026</div>';
      try {
        const url = type === "genre" ? "/api/filters/genres" : "/api/filters/tags";
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        renderList(container, type, (type === "genre" ? j.genres : j.tags) || []);
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
    const labelsBtn   = document.getElementById("labels-toggle");
    const labelsBar   = document.getElementById("labels-bar");
    const labelsBack  = document.getElementById("labels-back");
    const labelsTitle = document.getElementById("labels-title");
    if (!labelsBtn) return;

    const TAG_SVG =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>' +
      '<line x1="7" y1="7" x2="7.01" y2="7"/></svg>';

    let mode = null;   // null | "list" | "albums"

    function labelOrder() {
      return localStorage.getItem("rra-label-order") === "random" ? "random" : "alpha";
    }
    function labelMin() {
      const v = parseInt(localStorage.getItem("rra-label-min") || "2", 10);
      return Number.isFinite(v) && v > 0 ? v : 2;
    }

    function exitLabels() {
      mode = null;
      labelsActive = false;
      labelsBtn.classList.remove("is-active");
      if (labelsBar) labelsBar.classList.add("hidden");
    }
    window.__exitLabels = exitLabels;

    async function showLabelsList() {
      mode = "list";
      labelsActive = true;
      labelsBtn.classList.add("is-active");
      if (labelsBar) labelsBar.classList.add("hidden");
      setBanner(null);
      setCountText("Labels");
      renderSkeletons(computeAlbumCount());
      try {
        const r = await fetch("/api/filters/labels");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        const minAlbums = labelMin();
        const labels = (j.labels || []).filter(lb => (lb.albumCount || 1) >= minAlbums);
        const pct = Math.round((j.progress || 0) * 100);
        if (!labels.length) {
          grid.innerHTML = "";
          if (j.scanning) {
            setBanner("Scanning your library for record labels… " + pct + "% complete. Check back in a moment.", false);
            // Re-poll every 4 s while the scan is running
            setTimeout(() => { if (mode === "list") showLabelsList(); }, 4000);
          } else {
            setBanner("No record labels found in your library yet. Open some album cards to populate the list.", false);
          }
          return;
        }
        const scanNote = j.scanning ? " (scanning… " + pct + "%)" : "";
        setCountText(labels.length.toLocaleString() + " labels" + scanNote);
        renderLabelTiles(labels);
        // Keep refreshing while the scan adds more labels
        if (j.scanning) {
          setTimeout(() => { if (mode === "list") showLabelsList(); }, 5000);
        }
      } catch (e) {
        grid.innerHTML = "";
        setBanner("Couldn't load labels: " + e.message, true);
      }
    }

    function renderLabelTiles(labels) {
      grid.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const lb of labels) {
        const btn = document.createElement("button");
        btn.className = "album label-tile";
        btn.type = "button";
        btn.setAttribute("aria-label", lb.title || "Label");
        const art = document.createElement("div");
        if (lb.logo_url) {
          art.className = "album-art-wrap is-label-logo";
          const img = document.createElement("img");
          img.loading = "lazy"; img.alt = "";
          img.src = lb.logo_url;
          img.onerror = () => {
            // Logo failed — fall back to album art or tag SVG
            art.className = lb.image_key ? "album-art-wrap" : "album-art-wrap is-label";
            img.remove();
            if (lb.image_key) {
              const fallback = document.createElement("img");
              fallback.loading = "lazy"; fallback.alt = "";
              fallback.src = `/api/image/${encodeURIComponent(lb.image_key)}?size=500`;
              fallback.onerror = () => { art.className = "album-art-wrap is-label"; fallback.remove(); art.innerHTML = TAG_SVG; };
              art.appendChild(fallback);
            } else {
              art.innerHTML = TAG_SVG;
            }
          };
          art.appendChild(img);
        } else if (lb.image_key) {
          art.className = "album-art-wrap";
          const img = document.createElement("img");
          img.loading = "lazy"; img.alt = "";
          img.src = `/api/image/${encodeURIComponent(lb.image_key)}?size=500`;
          img.onerror = () => {
            art.className = "album-art-wrap is-label";
            img.remove();
            art.innerHTML = TAG_SVG;
          };
          art.appendChild(img);
        } else {
          art.className = "album-art-wrap is-label";
          art.innerHTML = TAG_SVG;
        }
        const meta = document.createElement("div");
        meta.className = "album-meta";
        meta.innerHTML = `<div class="album-title"></div><div class="album-artist"></div>`;
        meta.querySelector(".album-title").textContent  = lb.title || "";
        meta.querySelector(".album-artist").textContent = lb.subtitle || "";
        btn.appendChild(art);
        btn.appendChild(meta);
        btn.addEventListener("click", () => showLabelAlbums(lb.title));
        frag.appendChild(btn);
      }
      grid.appendChild(frag);
    }

    async function showLabelAlbums(name) {
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

    labelsBtn.addEventListener("click", () => {
      if (mode) { exitLabels(); loadRandom(); }
      else      { showLabelsList(); }
    });

    // Refresh always returns to the random wall.
    if (refreshBtn) refreshBtn.addEventListener("click", exitLabels);
  })();

  window.__openAlbum = openAlbum;

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
          } catch (e) {}
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
          } catch (e) {}

          setInterval(loadZones, 15000);
          return;
        }
      } catch (e) {}
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
  let lastNpImgKey  = null;
  let lastNpTrackKey = null;    // "line1||line2" — changes trigger stream-link fetch
  let userIsDraggingVolume = false;
  let userIsDraggingSeek   = false;
  let npLen = 0;                // current track length (s)
  let npPos = 0;                // local seek position (s), advanced between polls

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

  async function fetchState() {
    const zid = selectedZoneId();
    if (!zid) { bar.classList.add("hidden"); currentZone = null; return; }
    try {
      const r = await fetch("/api/zone-state?zone=" + encodeURIComponent(zid), { cache: "no-store" });
      if (!r.ok) { bar.classList.add("hidden"); return; }
      const j = await r.json();
      renderZone(j.zone);
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

    // Live-stream badge: visible when the zone is an audio-input (entrypoint) source
    // such as Spotify via roon-entrypoints, AirPlay, etc.
    const liveBadge = document.getElementById("mt-live-badge");
    if (liveBadge) liveBadge.classList.toggle("hidden", !zone.is_audio_input);

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

    // Source badge: pulsing dot when the zone is an audio-input (entrypoint) source
    const srcBadge = document.getElementById("np-source-badge");
    if (srcBadge) srcBadge.classList.toggle("hidden", !currentZone.is_audio_input);

    // Streaming service links: fetch when the track changes so all sources
    // (local library AND entrypoint zones like Spotify via roon-entrypoints)
    // get deep-links to Spotify, Apple Music, and Last.fm.
    const trackKey = (np.line1 || "") + "||" + (np.line2 || "");
    if (trackKey !== lastNpTrackKey) {
      lastNpTrackKey = trackKey;
      fetchNpStreamLinks(np.line1 || "", np.line2 || "", np.line3 || "");
    }
  }

  async function fetchNpStreamLinks(track, artist, album) {
    const capturedKey = track + "||" + artist;
    const linksEl    = document.getElementById("np-stream-links");
    const appleBtn   = document.getElementById("np-listen-apple");
    const tagsEl     = document.getElementById("np-lastfm-tags");
    const statsEl    = document.getElementById("np-lastfm-stats");
    if (!linksEl) return;
    // Hide everything while we fetch
    linksEl.classList.add("hidden");
    if (appleBtn) appleBtn.classList.add("hidden");
    if (tagsEl)   tagsEl.classList.add("hidden");
    if (statsEl)  statsEl.classList.add("hidden");
    if (!track) return;

    const params = new URLSearchParams({ track, artist, album });
    try {
      const r = await fetch("/api/track/external-links?" + params, { cache: "no-store" });
      if (!r.ok) return;
      const links = await r.json();
      // Bail if the track changed while we were waiting
      if (lastNpTrackKey !== capturedKey) return;

      // Spotify — exact track URL from MusicBrainz, or search fallback
      const spotifyBtn   = document.getElementById("np-listen-spotify");
      const spotifyLabel = document.getElementById("np-spotify-label");
      if (spotifyBtn && links.spotify) {
        spotifyBtn.href = links.spotify;
        if (spotifyLabel) spotifyLabel.textContent = links.spotify_exact ? "Open in Spotify" : "Search Spotify";
      }

      // Apple Music — exact track URL from iTunes Search API
      if (appleBtn && links.apple_music) {
        appleBtn.href = links.apple_music;
        appleBtn.classList.remove("hidden");
      }

      // Last.fm
      const lastfmBtn = document.getElementById("np-listen-lastfm");
      if (lastfmBtn && links.lastfm) lastfmBtn.href = links.lastfm;

      linksEl.classList.remove("hidden");

      // Last.fm tags + listener count (only when LASTFM_API_KEY is configured on server)
      const tagsEl  = document.getElementById("np-lastfm-tags");
      const statsEl = document.getElementById("np-lastfm-stats");
      if (tagsEl)  tagsEl.classList.add("hidden");
      if (statsEl) statsEl.classList.add("hidden");
      if (links.lastfm_data) {
        const d = links.lastfm_data;
        if (tagsEl && d.tags && d.tags.length) {
          tagsEl.innerHTML = d.tags.map(t =>
            `<span class="np-tag">${t.replace(/</g, "&lt;")}</span>`
          ).join("");
          tagsEl.classList.remove("hidden");
        }
        if (statsEl && d.listeners) {
          statsEl.textContent = d.listeners.toLocaleString() + " listeners on Last.fm";
          statsEl.classList.remove("hidden");
        }
      }
    } catch (e) { /* network blip — links stay hidden */ }
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
    } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
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

  // Boot
  startPolling();
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
        wordmarkUrl: "/logo.png",
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
      const a = window.__currentAlbum;
      if (!a) return;
      open({
        title:     a.title    || "",
        artist:    a.subtitle || "",
        image_key: a.image_key
      });
    });
  }
})();

/* ------------------------------------------------------------------ */
/*  Self-update: poll status, show a toast, install on tap            */
/* ------------------------------------------------------------------ */
(function initUpdater() {
  const toast   = document.getElementById("update-toast");
  const textEl  = document.getElementById("update-text");
  const actions = document.getElementById("update-actions");
  const btnNow  = document.getElementById("update-now");
  const btnLater = document.getElementById("update-later");
  if (!toast || !btnNow) return;

  const PHASE = {
    checking:   "Preparing update\u2026",
    downloading:"Downloading update\u2026",
    extracting: "Unpacking update\u2026",
    restarting: "Restarting to finish update\u2026"
  };
  const DISMISS_KEY = "rra-update-dismissed";
  let applying = false;
  let pollTimer = null;

  const dismissedVer = () => { try { return sessionStorage.getItem(DISMISS_KEY) || ""; } catch (e) { return ""; } };
  const setDismissed = (v) => { try { sessionStorage.setItem(DISMISS_KEY, v); } catch (e) {} };
  const show = (msg) => { textEl.textContent = msg; toast.classList.add("open"); };
  const hide = () => { toast.classList.remove("open"); };

  function showProgress(phase) {
    applying = true;
    actions.classList.add("busy");
    toast.classList.remove("is-error");
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
        showProgress(ph); startPoll(s.latest); return;   // started from Roon settings
      }
      if (s.available && s.latest && s.latest !== dismissedVer()) {
        actions.classList.remove("busy"); btnNow.disabled = false;
        toast.classList.remove("is-error");
        show("Version " + s.latest + " is available (you have " + s.current + ").");
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
      const r = await fetch("/api/update/apply", { method: "POST" });
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
    } catch (e) {}
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
    } catch (e) {}
  }
  if (radioToggle) {
    radioToggle.addEventListener("change", async () => {
      if (!zoneSelect || !zoneSelect.value) return;
      try {
        await fetch("/api/radio", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zone: zoneSelect.value, enabled: radioToggle.checked })
        });
      } catch (e) {}
    });
  }

  let versionLoaded = false;
  async function loadVersion() {
    if (versionLoaded || !versionEl) return;
    try {
      const r = await fetch("/api/update/status", { cache: "no-store" });
      if (r.ok) {
        const s = await r.json();
        if (s && s.current) { versionEl.textContent = "Roon Random Albums v" + s.current; versionLoaded = true; }
      }
    } catch (e) {}
  }

  const open = () => { loadRadio(); loadVersion(); overlay.classList.remove("hidden"); };
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
/*  Spotify Connect relay panel                                         */
/* ------------------------------------------------------------------ */
(() => {
  const modal     = document.getElementById("relay-modal");
  const closeBtn  = document.getElementById("relay-modal-close");
  const lbStatus  = document.getElementById("relay-librespot-status");
  const zoneList  = document.getElementById("relay-zone-list");
  const openBtn   = document.getElementById("relay-toggle");

  let pollTimer = null;

  openBtn.addEventListener("click", () => {
    modal.classList.remove("hidden");
    loadStatus();
    // poll every 3 s while open
    pollTimer = setInterval(loadStatus, 3000);
  });

  function close() {
    modal.classList.add("hidden");
    clearInterval(pollTimer);
    pollTimer = null;
  }
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });

  async function loadStatus() {
    try {
      const r = await fetch("/api/relay/status", { cache: "no-store" });
      if (!r.ok) return;
      render(await r.json());
    } catch {}
  }

  function render(status) {
    // librespot status
    const found = status.librespot_found;
    lbStatus.innerHTML =
      `<span class="relay-lb-dot ${found ? "found" : "missing"}"></span>` +
      `<span>${found ? "librespot ready" : "librespot not installed"}</span>` +
      (found && status.librespot_path
        ? `<span class="relay-lb-path">${status.librespot_path}</span>`
        : "");

    // Zone rows
    const zones = status.all_zones || [];
    if (!zones.length) {
      zoneList.innerHTML = '<p class="relay-loading">No Roon zones found. Make sure the extension is paired.</p>';
      return;
    }

    zoneList.innerHTML = "";
    for (const z of zones) {
      const relay  = status.relays[z.zone_id] || null;
      const state  = relay ? relay.state : "stopped";
      const track  = relay && relay.current_track;
      const trackLine = track && track.name
        ? [track.name, track.artists].filter(Boolean).join(" — ")
        : null;

      const row = document.createElement("div");
      row.className = "relay-zone-row";
      row.innerHTML =
        `<div style="min-width:0;flex:1">` +
          `<div class="relay-zone-name">${esc(z.zone_name)}</div>` +
          (state === "active"
            ? `<div class="relay-zone-meta">Roon: ${esc(z.zone_name)} visible in Spotify app</div>`
              + (trackLine ? `<div class="relay-zone-track">${esc(trackLine)}</div>` : "")
            : (relay && relay.error
              ? `<div class="relay-zone-meta" style="color:#ef4444">${esc(relay.error)}</div>`
              : "")) +
        `</div>` +
        `<span class="relay-zone-state ${state}">${stateLabel(state)}</span>` +
        `<button class="relay-toggle-btn ${state === "stopped" || state === "error" ? "enable" : "disable"}"` +
          ` data-zone="${esc(z.zone_id)}"` +
          ` data-action="${state === "stopped" || state === "error" ? "start" : "stop"}"` +
          (state === "starting" || !found ? " disabled" : "") +
          `>${state === "stopped" || state === "error" ? "Enable" : "Disable"}</button>`;

      row.querySelector(".relay-toggle-btn").addEventListener("click", onToggle);
      zoneList.appendChild(row);
    }
  }

  function stateLabel(s) {
    return { stopped: "Off", starting: "Starting…", active: "Active", error: "Error" }[s] || s;
  }

  function esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  async function onToggle(e) {
    const btn    = e.currentTarget;
    const zoneId = btn.dataset.zone;
    const action = btn.dataset.action;
    btn.disabled = true;
    try {
      await fetch(`/api/relay/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zone_id: zoneId })
      });
      await loadStatus();
    } catch {}
    btn.disabled = false;
  }
})();
