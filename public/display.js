/*
 * display.js — the /display wall screen.
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Read-only kiosk page:
 *  - follows the playing zone (?zone=<id or name> pins one; otherwise the
 *    first zone that is actually playing, re-scanned when it stops),
 *  - rotates between album art / artist photos / review card / muted video
 *    (whatever /api/display/content found for the current album),
 *  - Nest-Hub-style progress strip along the bottom,
 *  - honours the Settings toggle: when off it fetches nothing and shows a
 *    "turned off" note (re-checked every 30s so flipping the toggle works
 *    without touching the wall device).
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const backdrop = $("backdrop");
  const slideA   = $("slide-a");
  const slideB   = $("slide-b");
  const idleEl   = $("idle");
  const offEl    = $("off");
  const barEl    = $("bottombar");
  const bbTitle  = $("bb-title");
  const bbArtist = $("bb-artist");
  const bbCur    = $("bb-cur");
  const bbTot    = $("bb-tot");
  const bbFill   = $("bb-fill");

  const ZONE_PARAM = new URLSearchParams(location.search).get("zone");

  let enabled       = false;
  let rotateSecs    = 10;
  let zoneId        = null;
  let zoneStoppedAt = 0;        // when the pinned-less zone stopped playing
  let np            = null;     // current now_playing
  let albumKey      = "";       // artist||album of the loaded content
  let slides        = [];       // [{kind, ...}]
  let slideIdx      = -1;       // index into effectiveSlides()
  let mode          = "auto";   // "auto" rotates everything; a slide kind pins that screen
  let userMode      = "auto";   // the user's chosen mode — survives album changes
  let bioCycle      = 0;        // which credited artist's bio shows next (see buildSlide)
  let frontIsA      = false;    // which layer is currently visible
  let rotateTimer   = null;
  let seekBase      = 0;        // last polled seek position (s)
  let seekBaseAt    = 0;        // Date.now() at that poll
  let playing       = false;

  const fmt = (s) => {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  async function jget(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ---- Settings gate ----------------------------------------------------
  async function checkSettings() {
    try {
      const j = await jget("/api/settings/display");
      enabled = !!j.enabled;
      const s = parseInt(j.seconds, 10);
      if (Number.isFinite(s) && s >= 5 && s <= 60 && s !== rotateSecs) {
        rotateSecs = s;
        if (rotateTimer) startRotation();   // apply the new interval live
      }
    } catch (e) {
      // Server unreachable (restart, wifi blip) — keep the current state
      // rather than flashing "turned off" at the wall; only an explicit
      // enabled:false from the server disables the display.
      return;
    }
    offEl.classList.toggle("hidden", enabled);
    if (!enabled) {
      stopRotation();
      idleEl.classList.add("hidden");
      barEl.classList.add("hidden");
      backdrop.classList.remove("visible");
      slideA.classList.remove("visible");
      slideB.classList.remove("visible");
      // Forget the loaded album so re-enabling reloads content mid-album —
      // without this, toggling off→on left the stage black until the album
      // changed (tick's key check saw "nothing changed").
      slides = []; albumKey = "";
    }
  }

  // ---- Zone selection ---------------------------------------------------
  async function pickZone() {
    const j = await jget("/api/zones").catch(() => ({ zones: [] }));
    const zones = j.zones || [];
    if (!zones.length) return null;
    if (ZONE_PARAM) {
      const hit = zones.find(z => z.zone_id === ZONE_PARAM ||
        (z.display_name || "").toLowerCase() === ZONE_PARAM.toLowerCase());
      return hit ? hit.zone_id : null;
    }
    const active = zones.find(z => z.state === "playing" || z.state === "loading");
    return (active || zones[0]).zone_id;
  }

  // ---- Poll loop ----------------------------------------------------------
  async function tick() {
    if (!enabled) return;
    try {
      if (!zoneId) zoneId = await pickZone();
      if (!zoneId) { showIdle(); return; }
      const j = await jget("/api/zone-state?zone=" + encodeURIComponent(zoneId));
      const zone = j && j.zone;
      if (!zone) { zoneId = null; showIdle(); return; }
      playing = zone.state === "playing" || zone.state === "loading";
      np = zone.now_playing || null;

      // Unpinned displays follow the music: if this zone has been quiet for
      // 30s, look for another zone that IS playing.
      if (!ZONE_PARAM) {
        if (playing) zoneStoppedAt = 0;
        else if (!zoneStoppedAt) zoneStoppedAt = Date.now();
        else if (Date.now() - zoneStoppedAt > 30000) {
          const next = await pickZone();
          if (next && next !== zoneId) { zoneId = next; zoneStoppedAt = 0; return; }
        }
      }

      if (!np) { showIdle(); return; }
      idleEl.classList.add("hidden");
      barEl.classList.remove("hidden");

      bbTitle.textContent  = np.line1 || "—";
      bbArtist.textContent = [np.line2, np.line3].filter(Boolean).join(" · ");
      bbTot.textContent    = fmt(np.length);
      seekBase   = np.seek_position || 0;
      seekBaseAt = Date.now();

      // Keyed per TRACK (line1), not just per album: the video is track-
      // specific, so a skip within the same album must reload content —
      // without this the previous track's video kept playing after a skip.
      // Album-level parts (photos/review/bio/library grids) are cached
      // server-side, so per-track refetches are cheap.
      const key = (np.line1 || "") + "||" + (np.line2 || "") + "||" + (np.line3 || "") + "||" + (np.image_key || "");
      if (key !== albumKey) {
        albumKey = key;
        await loadContent();
      }
    } catch (e) { /* poll blip — next tick retries */ }
  }

  // Smooth progress between polls.
  function paintProgress() {
    if (!np || !np.length) { bbFill.style.width = "0%"; bbCur.textContent = "0:00"; return; }
    const pos = Math.min(np.length,
      seekBase + (playing ? (Date.now() - seekBaseAt) / 1000 : 0));
    bbFill.style.width = ((pos / np.length) * 100).toFixed(2) + "%";
    bbCur.textContent = fmt(pos);
  }

  function showIdle() {
    idleEl.classList.remove("hidden");
    barEl.classList.add("hidden");
    backdrop.classList.remove("visible");
    slideA.classList.remove("visible");
    slideB.classList.remove("visible");
    stopRotation();
    slides = []; albumKey = ""; np = null;
  }

  // ---- Content + rotation -------------------------------------------------
  async function loadContent() {
    // Supersede token: a cold content fetch can take seconds (MusicBrainz is
    // rate-limited server-side), and tick() fires every 2s — if the album
    // changes again mid-fetch, the stale result must be discarded or the
    // previous album's photos/review would be woven into the new rotation.
    const myKey = albumKey;
    stopRotation();
    closePlayPanel();   // a track change invalidates any pending pick
    const base = [];
    if (np && np.image_key) {
      base.push({ kind: "art", url: "/api/image/" + encodeURIComponent(np.image_key) + "?size=800" });
      backdrop.src = "/api/image/" + encodeURIComponent(np.image_key) + "?size=96";
      backdrop.classList.add("visible");
    } else {
      backdrop.classList.remove("visible");
    }
    slides = base;
    slideIdx = -1;
    // While the content fetch runs the pinned kind may not exist yet — show
    // the art regardless so the new album is on screen immediately. userMode
    // remembers the user's pick and is restored below once extras arrive.
    mode = "auto";
    if (base.length) {
      nextSlide();   // show the art immediately — extras join when they arrive
    } else {
      // Art-less album: clear the previous album's slide rather than leave it
      // up under the new track's title.
      slideA.classList.remove("visible");
      slideB.classList.remove("visible");
    }
    buildControls();
    // Ask the server what else it can find (photos / review / video).
    try {
      const j = await jget("/api/display/content?zone=" + encodeURIComponent(zoneId));
      if (albumKey !== myKey) return;   // album changed while fetching — result is stale
      const extras = [];
      for (const u of (j.artistPhotos || []).slice(0, 4)) extras.push({ kind: "photo", url: u });
      if (j.review && j.review.text) extras.push({ kind: "review", review: j.review });
      // One bio slide for however many credited artists have a bio; the card
      // advances to the next member each time the slide comes around.
      const bios = (j.bios && j.bios.length) ? j.bios : (j.bio && j.bio.text ? [j.bio] : []);
      if (bios.length) { bioCycle = 0; extras.push({ kind: "bio", bios }); }
      const more = j.moreAlbums || {};
      if (more.artist && more.artist.albums && more.artist.albums.length) {
        extras.push({ kind: "more", heading: "More from " + more.artist.name,
                      sub: "From your library", albums: more.artist.albums });
      }
      if (more.label && more.label.albums && more.label.albums.length) {
        extras.push({ kind: "more", heading: "More on " + more.label.name,
                      sub: "From your library", albums: more.label.albums });
      }
      if (j.video && j.video.videoId && !deadVideos.has(j.video.videoId)) {
        extras.push({ kind: "video", videoId: j.video.videoId, embedUrl: j.video.embedUrl });
      }
      slides = base.concat(extras);
      if (!base.length && extras.length) { slideIdx = -1; nextSlide(); }   // no art: first visual is an extra
    } catch (e) { /* content is best-effort — art-only rotation is fine */ }
    if (albumKey !== myKey) return;
    // Restore the user's pinned mode if the new track can honour it. With no
    // manual pin, a track that HAS a video opens straight to it and stays
    // there (it plays through, synced to the music) — tapping a chip is the
    // only way off it; everything else rotates as usual.
    if (userMode !== "auto" && slides.some(s => s.kind === userMode)) {
      setMode(userMode);
    } else if (userMode === "auto" && slides.some(s => s.kind === "video")) {
      mode = "video";        // auto-preference, not a user pin — userMode stays "auto"
      slideIdx = -1;
      nextSlide();
      stopRotation();
      buildControls();
    } else {
      mode = "auto";
      buildControls();
      startRotation();
    }
  }

  function buildSlide(s) {
    const el = document.createElement("div");
    if (s.kind === "art") {
      const img = document.createElement("img");
      img.className = "art"; img.alt = "";
      img.src = s.url;
      el.appendChild(img);
      return { node: el, full: false };
    }
    if (s.kind === "photo") {
      const img = document.createElement("img");
      img.className = "photo"; img.alt = "";
      img.src = s.url;
      return { node: img, full: true };
    }
    if (s.kind === "review" || s.kind === "bio") {
      // Bio cards alternate between the credited artists on successive
      // rotations (band of two → member A this pass, member B the next).
      const src = s.kind === "bio" ? s.bios[bioCycle++ % s.bios.length] : s.review;
      const card = document.createElement("div");
      card.className = "review-card";
      const h = document.createElement("h2");
      h.textContent = s.kind === "bio"
        ? (src.name || (np && np.line2) || "")
        : (np ? (np.line3 || np.line1 || "") : "");
      const p = document.createElement("div");
      p.className = "review-text";
      p.textContent = src.text;
      const a = document.createElement("div");
      a.className = "review-attrib";
      a.textContent = src.attribution || "";
      card.append(h, p, a);
      return { node: card, full: false };
    }
    if (s.kind === "more") {
      const card = document.createElement("div");
      card.className = "more-card";
      const h = document.createElement("h2");
      h.textContent = s.heading;
      const sub = document.createElement("div");
      sub.className = "more-sub";
      sub.textContent = s.sub || "";
      const grid = document.createElement("div");
      grid.className = "more-grid";
      for (const al of s.albums.slice(0, 8)) {
        const cell = document.createElement("div");
        cell.className = "more-cell";
        if (al.image_key) {
          const img = document.createElement("img");
          img.alt = ""; img.loading = "lazy";
          img.src = "/api/image/" + encodeURIComponent(al.image_key) + "?size=300";
          cell.appendChild(img);
        }
        const t = document.createElement("div");
        t.className = "more-title";
        t.textContent = al.title;
        cell.appendChild(t);
        cell.addEventListener("click", (e) => { e.stopPropagation(); openPlayPanel(al); });
        grid.appendChild(cell);
      }
      card.append(h, sub, grid);
      return { node: card, full: false };
    }
    if (s.kind === "video") {
      const wrap = document.createElement("div");
      wrap.className = "video-wrap";
      // The IFrame Player API (not a bare iframe) so embed failures are
      // DETECTED: the server verifies status.embeddable, but region blocks
      // and takedowns still slip through and would sit on screen as a
      // "Video unavailable" card. onError drops the video from rotation.
      const holder = document.createElement("div");
      wrap.appendChild(holder);
      ensureYT().then((YT) => {
        if (!wrap.isConnected) return;   // slide already rotated away
        // Start the clip at the track's live position so video and music line
        // up (best-effort — video edits rarely match track length exactly).
        const trackPos = Math.max(0, Math.round(
          seekBase + (playing ? (Date.now() - seekBaseAt) / 1000 : 0)));
        const player = new YT.Player(holder, {
          videoId: s.videoId,
          host: "https://www.youtube-nocookie.com",
          playerVars: { autoplay: 1, mute: 1, controls: 0, modestbranding: 1,
                        playsinline: 1, rel: 0, loop: 1, playlist: s.videoId,
                        start: trackPos },
          events: {
            onReady: (e) => { try { e.target.mute(); e.target.playVideo(); } catch (_) {} },
            onError: () => dropVideo(s.videoId)
          }
        });
        wrap._ytPlayer = player;
      }).catch(() => dropVideo(s.videoId));
      return { node: wrap, full: false };
    }
    return { node: el, full: false };
  }

  // Load the YouTube IFrame API once, on first use.
  let ytPromise = null;
  function ensureYT() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytPromise) return ytPromise;
    ytPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === "function") { try { prev(); } catch (_) {} }
        resolve(window.YT);
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = () => reject(new Error("YT API load failed"));
      document.head.appendChild(tag);
      setTimeout(() => reject(new Error("YT API timeout")), 10000);
    });
    return ytPromise;
  }

  // A video that can't actually play (region block, takedown) leaves the
  // rotation for good; if it's on screen right now, advance immediately.
  const deadVideos = new Set();
  function dropVideo(videoId) {
    deadVideos.add(videoId);
    const eff = effectiveSlides();
    const wasVisible = eff[slideIdx] && eff[slideIdx].kind === "video";
    slides = slides.filter(s => !(s.kind === "video" && s.videoId === videoId));
    if (mode === "video" && !slides.some(s => s.kind === "video")) mode = "auto";
    buildControls();
    slideIdx = Math.min(slideIdx, effectiveSlides().length - 1);
    if (wasVisible) { slideIdx -= 1; nextSlide(); }
    startRotation();
  }

  // The slides the current mode rotates through: everything on "auto",
  // only the pinned kind otherwise (photos cycle within themselves).
  function effectiveSlides() {
    return mode === "auto" ? slides : slides.filter(s => s.kind === mode);
  }

  function nextSlide() {
    const eff = effectiveSlides();
    if (!eff.length) return;
    slideIdx = (slideIdx + 1) % eff.length;
    const { node, full } = buildSlide(eff[slideIdx]);
    const front = frontIsA ? slideA : slideB;
    const back  = frontIsA ? slideB : slideA;
    back.innerHTML = "";
    back.classList.toggle("full", full);
    back.classList.toggle("photo-slide", eff[slideIdx].kind === "photo");
    back.appendChild(node);
    // Crossfade, then empty the hidden layer so a finished video/iframe
    // doesn't keep loading behind the visible slide.
    back.classList.add("visible");
    front.classList.remove("visible");
    frontIsA = !frontIsA;
    setTimeout(() => {
      if (front.classList.contains("visible")) return;
      // Tear down any YT player cleanly before dropping its DOM.
      front.querySelectorAll(".video-wrap").forEach(w => {
        if (w._ytPlayer) { try { w._ytPlayer.destroy(); } catch (_) {} }
      });
      front.innerHTML = "";
    }, 1200);
  }

  function startRotation() {
    stopRotation();
    // A pinned video plays through in full (it loops); everything else
    // rotates whenever there's more than one slide to rotate — or a single
    // bio card with several credited artists, which advances to the next
    // member each tick (rebuilding it steps bioCycle).
    if (mode === "video") return;
    const eff = effectiveSlides();
    const multi = eff.length > 1 ||
      (eff.length === 1 && eff[0].kind === "bio" && eff[0].bios.length > 1);
    if (multi) rotateTimer = setInterval(nextSlide, rotateSecs * 1000);
  }
  function stopRotation() {
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  }

  // ---- Mode controls (tap to reveal, auto-hide) ---------------------------
  const controlsEl = $("controls");
  const MODE_LABELS = [
    ["auto",   "Auto"],
    ["art",    "Art"],
    ["photo",  "Photos"],
    ["bio",    "Bio"],
    ["review", "Review"],
    ["more",   "Library"],
    ["video",  "Video"]
  ];
  function setMode(m) {
    userMode = m;
    mode = m;
    slideIdx = -1;
    nextSlide();
    startRotation();
    buildControls();
  }
  function buildControls() {
    if (!controlsEl) return;
    controlsEl.innerHTML = "";
    const kinds = new Set(slides.map(s => s.kind));
    for (const [m, label] of MODE_LABELS) {
      if (m !== "auto" && !kinds.has(m)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctl-btn" + (mode === m ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", (e) => { e.stopPropagation(); setMode(m); showUI(); });
      controlsEl.appendChild(b);
    }
  }
  let uiTimer = null;
  function showUI() {
    document.body.classList.add("show-ui");
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => document.body.classList.remove("show-ui"), 5000);
  }
  document.addEventListener("pointerdown", showUI);
  document.addEventListener("pointermove", showUI);

  // ---- Tap-to-play panel (library grids) ----------------------------------
  const playPanel = $("playpanel");
  const ppTitle   = $("pp-title");
  const ppPlay    = $("pp-play");
  const ppQueue   = $("pp-queue");
  const ppClose   = $("pp-close");
  let ppAlbum     = null;
  let ppTimer     = null;
  function openPlayPanel(al) {
    if (!playPanel || al.offset == null) return;
    ppAlbum = al;
    ppTitle.textContent = al.title + (al.subtitle ? " — " + al.subtitle : "");
    ppPlay.textContent  = "▶ Play now";
    ppQueue.textContent = "+ Queue";
    ppPlay.disabled = ppQueue.disabled = false;
    playPanel.classList.remove("hidden");
    clearTimeout(ppTimer);
    ppTimer = setTimeout(closePlayPanel, 8000);   // auto-dismiss if untouched
  }
  function closePlayPanel() {
    if (playPanel) playPanel.classList.add("hidden");
    ppAlbum = null;
    clearTimeout(ppTimer);
  }
  async function ppAction(kind, btn) {
    if (!ppAlbum || !zoneId) return;
    ppPlay.disabled = ppQueue.disabled = true;
    btn.textContent = kind === "queue" ? "Queueing…" : "Starting…";
    try {
      // Same request the album modal sends; grid offsets are full-library,
      // so the filter fields stay empty (see /api/play).
      const r = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: ppAlbum.offset,
          // Identity travels with the play (stale-offset defense; see /api/play).
          title:    ppAlbum.title    || "",
          subtitle: ppAlbum.subtitle || "",
          zone_or_output_id: zoneId,
          kind,
          filter_type: "", filter_value: "", filter_parent: ""
        })
      });
      btn.textContent = r.ok ? (kind === "queue" ? "Queued ✓" : "Playing ✓") : "Failed";
    } catch (e) {
      btn.textContent = "Failed";
    }
    ppTimer = setTimeout(closePlayPanel, 1200);
  }
  if (ppPlay)  ppPlay.addEventListener("click",  () => ppAction("play_now", ppPlay));
  if (ppQueue) ppQueue.addEventListener("click", () => ppAction("queue", ppQueue));
  if (ppClose) ppClose.addEventListener("click", closePlayPanel);

  // ---- Boot ---------------------------------------------------------------
  // The settings check is the wake mechanism while the display is toggled off —
  // it's the ONLY request made in that state (tick() bails when !enabled, so no
  // zone/content polling happens). Self-scheduling: 30s while on, 60s while off.
  function scheduleSettingsCheck() {
    setTimeout(() => {
      checkSettings().finally(scheduleSettingsCheck);
    }, enabled ? 30000 : 60000);
  }
  checkSettings().then(() => { if (enabled) tick(); }).finally(scheduleSettingsCheck);
  setInterval(() => { if (enabled) tick(); }, 2000);
  setInterval(paintProgress, 250);
})();
