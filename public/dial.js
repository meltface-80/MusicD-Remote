/*
 * dial.js — the /dial page.
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * A port of the Android build's DialView (com.musicd.lite.android.dial), which
 * is the version both remotes track. Geometry, proportions, colours, the
 * gesture model and every magic number are taken from it deliberately: the
 * point is that the two remotes look and feel like the same control, so
 * "roughly the same" would defeat the exercise. Where this file departs from
 * the Kotlin it says so and why.
 *
 * What it talks to is entirely the app's existing surface — /api/zone-state,
 * /api/control, /api/volume, /api/image, /api/zones. The dial keeps no state
 * of its own on the server and needs no settings.
 */
(() => {
  "use strict";

  // ---- constants, from DialView.kt --------------------------------------
  const DEGREES_FOR_FULL_RANGE = 320.0;  // min -> max, whatever the units
  const DEGREES_PER_INCREMENT  = 14.0;   // rotation per +/-1 with no range
  const SEND_INTERVAL_MS       = 60;     // volume sends are coalesced
  const OPTIMISTIC_WINDOW_MS   = 900;    // local value wins over the echo
  const LONG_PRESS_MS          = 550;
  const TOUCH_SLOP             = 10;     // ~ViewConfiguration scaledTouchSlop
  const POLL_MS                = 1500;   // same cadence as the app
  const PAINT_MS               = 250;    // same painter as app.js/display.js

  const BG              = "#07080A";
  const RING_TRACK      = "#1C222A";
  const RING_FILL       = "#7AC8FF";
  const RING_MUTED      = "#5A6675";
  const THUMB           = "#EAF4FF";
  const TEXT_PRIMARY    = "#F2F5F8";
  const TEXT_SECONDARY  = "#98A3AF";
  const ART_PLACEHOLDER = "#141A21";
  const PROGRESS        = "#3C77A8";

  const canvas = document.getElementById("dial");
  const ctx    = canvas.getContext("2d");

  // ---- state ------------------------------------------------------------
  let zone = null;                 // the /api/zone-state payload's `zone`
  let statusText = "Starting…";
  let artwork = null;              // HTMLImageElement, decoded
  let artKey  = null;              // image_key it was loaded for

  let zoneId = null;
  try { zoneId = localStorage.getItem("rra-zone"); } catch (e) {} // storage optional

  // Geometry, recomputed on resize.
  let cx = 0, cy = 0, radius = 0, ringWidth = 0, innerRadius = 0;
  let transportY = 0;

  // Gesture state.
  const MODE_NONE = 0, MODE_RING = 1, MODE_INNER = 2;
  let mode = MODE_NONE;
  let lastAngle = 0, downX = 0, downY = 0, moved = false, longPressFired = false;
  let longPressTimer = null;

  let residual = 0;                // fractional volume between quantised steps
  let residualDegrees = 0;
  let optimisticValue = null;      // applied locally until the Core echoes
  let lastGestureAt = 0;
  let pendingSteps = 0, lastSendAt = 0, sendTimer = null;

  // Position clock — base + elapsed, NOT a counter. Same model app.js and
  // display.js use, and for the same reason: a counter fighting a poll is what
  // made the progress bar jerk (v1.7.68).
  let seekBase = 0, seekBaseAt = 0, trackLen = 0, wasPlaying = false;

  // ---- the volume model, from Zones.kt ----------------------------------
  // NOTE a real difference from the Kotlin: in this app's /api/zone-state
  // payload `is_muted` sits on the OUTPUT, not inside `volume` (index.js).
  // Reading it off the volume object would silently never mute anything.
  function volumeOutputs() {
    return ((zone && zone.outputs) || []).filter(o => o.volume);
  }
  function primaryOutput() { return volumeOutputs()[0] || null; }
  function primaryVolume() { const o = primaryOutput(); return o ? o.volume : null; }
  function hasVolumeControl() { return volumeOutputs().length > 0; }
  function isMuted() { return ((zone && zone.outputs) || []).some(o => o.is_muted); }
  function isIncremental(v) { return v && (v.type || null) === "incremental"; }

  // Roon's soft limit is a ceiling the owner set on the device precisely so a
  // remote cannot go past it, so a ring sweeping to `max` would drive the
  // volume somewhere they had already said it must not go.
  function effectiveMax(v) {
    const max = v.max != null ? v.max : 100;
    return v.soft_limit != null ? Math.min(max, v.soft_limit) : max;
  }
  function volMin(v) { return v.min != null ? v.min : 0; }
  function volStep(v) { return v.step != null ? v.step : 1; }

  function displayedVolume() {
    const v = primaryVolume();
    if (!v || isIncremental(v)) return null;
    return optimisticValue != null ? optimisticValue : v.value;
  }
  function displayedFraction() {
    const v = primaryVolume();
    if (!v || isIncremental(v)) return 0;
    const value = optimisticValue != null ? optimisticValue : v.value;
    const span = effectiveMax(v) - volMin(v);
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (value - volMin(v)) / span));
  }
  function formatVolume(v) {
    if (isMuted()) return "muted";
    if (isIncremental(v)) return "+/-";
    const value = v.value;
    if ((v.type || null) === "db") return value.toFixed(1) + " dB";
    return value === Math.floor(value) ? String(value | 0) : value.toFixed(1);
  }

  function isPlaying() {
    return !!zone && (zone.state === "playing" || zone.state === "loading");
  }
  function nowPos() {
    const pos = seekBase + (isPlaying() ? (Date.now() - seekBaseAt) / 1000 : 0);
    return trackLen > 0 ? Math.max(0, Math.min(trackLen, pos)) : Math.max(0, pos);
  }

  // ---- geometry, from onSizeChanged -------------------------------------
  function resize() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cx = w / 2;
    cy = h / 2;
    radius = Math.min(w, h) / 2 - 8;
    ringWidth = radius * 0.115;
    innerRadius = radius - ringWidth - 10;
    paint();
  }

  function transportRadius() { return innerRadius * 0.16; }
  // Previous, play/pause, next, microphone — evenly spaced across the dial.
  function controlCentres() {
    transportY = cy + innerRadius * 0.58;
    const spacing = innerRadius * 0.38;
    return [cx - spacing * 1.5, cx - spacing * 0.5, cx + spacing * 0.5, cx + spacing * 1.5];
  }

  // ---- drawing ----------------------------------------------------------
  function paint() {
    if (!canvas.clientWidth) return;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawRing();
    drawProgress();
    drawArtwork();
    drawText();
    drawTransport();
  }

  function arc(r, from, sweep, colour, width) {
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.arc(cx, cy, r, from * Math.PI / 180, (from + sweep) * Math.PI / 180);
    ctx.stroke();
  }
  function dot(x, y, r, colour) {
    ctx.beginPath();
    ctx.fillStyle = colour;
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRing() {
    const r = radius - ringWidth / 2;
    ctx.beginPath();
    ctx.strokeStyle = RING_TRACK;
    ctx.lineWidth = ringWidth;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    const v = primaryVolume();
    if (!v) return;   // fixed-volume output: no level to show

    if (isIncremental(v)) {
      // No range is reported, so there is nothing to fill. Detents signal that
      // the ring still works as a +/- control.
      for (let deg = -90; deg < 270; deg += 12) {
        const rad = deg * Math.PI / 180;
        dot(cx + r * Math.cos(rad), cy + r * Math.sin(rad),
            ringWidth * 0.12, isMuted() ? RING_MUTED : RING_FILL);
      }
      return;
    }

    const fraction = displayedFraction();
    if (fraction > 0) arc(r, -90, 360 * fraction, isMuted() ? RING_MUTED : RING_FILL, ringWidth);

    const angle = (-90 + 360 * fraction) * Math.PI / 180;
    dot(cx + r * Math.cos(angle), cy + r * Math.sin(angle),
        ringWidth * 0.30, isMuted() ? RING_MUTED : THUMB);
  }

  function drawProgress() {
    if (!(trackLen > 0)) return;
    const pos = nowPos();
    arc(innerRadius + 5, -90, 360 * (pos / trackLen), PROGRESS, 2.5);
  }

  function drawArtwork() {
    if (!artwork) { dot(cx, cy, innerRadius, ART_PLACEHOLDER); return; }
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
    ctx.clip();
    // Cover-fit, centred — the Kotlin's BitmapShader matrix.
    const size = 2 * innerRadius;
    const scale = Math.max(size / artwork.width, size / artwork.height);
    const w = artwork.width * scale, h = artwork.height * scale;
    ctx.drawImage(artwork, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
    // Scrim, so overlaid text stays legible on bright covers.
    ctx.save();
    ctx.globalAlpha = 150 / 255;
    dot(cx, cy, innerRadius, "#040609");
    ctx.restore();
  }

  function setFont(size, bold) {
    ctx.font = (bold ? "700 " : "400 ") + Math.max(1, size) + "px " +
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
  }
  function ellipsise(text, maxWidth) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    let end = text.length;
    while (end > 1 && ctx.measureText(text.slice(0, end) + "…").width > maxWidth) end--;
    return text.slice(0, end) + "…";
  }
  function wrap(text, perLine) {
    const words = String(text || "").split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
      if (!current) current = word;
      else if (current.length + 1 + word.length <= perLine) current += " " + word;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return lines;
  }
  function line(text, y, colour, size, bold, maxWidth) {
    setFont(size, bold);
    ctx.fillStyle = colour;
    ctx.fillText(maxWidth ? ellipsise(text, maxWidth) : text, cx, y);
  }

  function drawText() {
    const adjusting = Date.now() - lastGestureAt < OPTIMISTIC_WINDOW_MS;

    // Zone name, top of the inner circle.
    line(zone && zone.display_name ? zone.display_name : "No zone",
         cy - innerRadius * 0.60, TEXT_SECONDARY, innerRadius * 0.11, false, innerRadius * 1.5);

    if (adjusting) {
      // While the ring is moving, the number is the point.
      const v = primaryVolume();
      let label, units;
      if (!v)                    { label = "—";     units = "no volume control"; }
      else if (isMuted())        { label = "muted"; units = "volume"; }
      else if (isIncremental(v)) { label = "+/-";   units = "volume"; }
      else if ((v.type || null) === "db") { label = (displayedVolume() || 0).toFixed(1); units = "dB"; }
      else { label = String(Math.round(displayedVolume() || 0)); units = "volume"; }
      line(label, cy + innerRadius * 0.10, TEXT_PRIMARY, innerRadius * 0.42, true);
      line(units, cy + innerRadius * 0.28, TEXT_SECONDARY, innerRadius * 0.12, false);
      return;
    }

    const np = zone && zone.now_playing;
    if (!np) {
      let y = cy - innerRadius * 0.05;
      for (const l of wrap(statusText, 26)) {
        line(l, y, TEXT_SECONDARY, innerRadius * 0.11, false);
        y += innerRadius * 0.15;
      }
      return;
    }

    line(np.line1 || "", cy - innerRadius * 0.10, TEXT_PRIMARY,   innerRadius * 0.155, true,  innerRadius * 1.6);
    line(np.line2 || "", cy + innerRadius * 0.09, TEXT_SECONDARY, innerRadius * 0.125, false, innerRadius * 1.6);
    line(np.line3 || "", cy + innerRadius * 0.25, TEXT_SECONDARY, innerRadius * 0.105, false, innerRadius * 1.6);

    // Small persistent volume readout under the zone name.
    const v = primaryVolume();
    if (v) {
      line(isMuted() ? "muted" : formatVolume(v), cy - innerRadius * 0.44,
           isMuted() ? RING_MUTED : TEXT_SECONDARY, innerRadius * 0.10, false);
    }
  }

  function drawTransport() {
    const centres = controlCentres();
    const y = transportY;
    const r = transportRadius();

    dot(centres[1], y, r, "rgba(255,255,255,0.275)");
    dot(centres[3], y, r, "rgba(255,255,255,0.275)");

    const fg = zone ? TEXT_PRIMARY : TEXT_SECONDARY;
    drawSkip(centres[0], y, r * 0.62, true, fg);
    if (isPlaying()) drawPause(centres[1], y, r * 0.52, fg);
    else drawPlay(centres[1], y, r * 0.58, fg);
    drawSkip(centres[2], y, r * 0.62, false, fg);
    // The fourth control is "open the full app". The Android build puts voice
    // here; that is deliberately not ported — see the header of openApp().
    drawHome(centres[3], y, r * 0.60, fg);
  }

  function drawPlay(x, y, s, colour) {
    ctx.beginPath();
    ctx.fillStyle = colour;
    ctx.moveTo(x - s * 0.55, y - s);
    ctx.lineTo(x + s * 0.85, y);
    ctx.lineTo(x - s * 0.55, y + s);
    ctx.closePath();
    ctx.fill();
  }
  function drawPause(x, y, s, colour) {
    ctx.fillStyle = colour;
    const w = s * 0.42;
    ctx.fillRect(x - s * 0.75, y - s, w, s * 2);
    ctx.fillRect(x + s * 0.33, y - s, w, s * 2);
  }
  function drawSkip(x, y, s, back, colour) {
    const d = back ? -1 : 1;
    ctx.beginPath();
    ctx.fillStyle = colour;
    ctx.moveTo(x - s * 0.85 * d, y - s);
    ctx.lineTo(x + s * 0.35 * d, y);
    ctx.lineTo(x - s * 0.85 * d, y + s);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x + s * 0.45 * d - (d > 0 ? 0 : s * 0.22), y - s, s * 0.22, s * 2);
  }
  function drawHome(x, y, s, colour) {
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1.5, s * 0.22);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.moveTo(x - s, y);
    ctx.lineTo(x, y - s * 0.9);
    ctx.lineTo(x + s, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - s * 0.72, y - s * 0.1);
    ctx.lineTo(x - s * 0.72, y + s * 0.9);
    ctx.lineTo(x + s * 0.72, y + s * 0.9);
    ctx.lineTo(x + s * 0.72, y - s * 0.1);
    ctx.stroke();
  }

  // ---- talking to the server --------------------------------------------
  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast(j.error || "That didn't work");
      }
      return r.ok;
    } catch (e) {
      toast("Can't reach MusicD");   // the dial has no other error surface
      return false;
    }
  }

  function control(command) {
    if (!zoneId) return;
    post("/api/control", { zone_or_output_id: zoneId, command });
    setTimeout(fetchState, 200);
  }

  // Volume travels as STEPS, not as a value. relative_step asks Roon to move N
  // of the output's own detents, so the arithmetic happens against the device's
  // real scale — a dB output's step is not 1, and computing an absolute value
  // here would need the client to be right about a scale it only samples.
  // An incremental control has no scale at all, so Roon's guidance is a
  // relative +/-1 nudge, which is what the Android build sends too.
  function sendVolumeSteps(steps) {
    if (!steps || !zoneId) return;
    const v = primaryVolume();
    const body = { zone_or_output_id: zoneId };
    if (isIncremental(v)) body.relative = steps;
    else body.relative_step = steps;
    post("/api/volume", body);
    setTimeout(fetchState, 250);
  }

  function toggleMute() {
    if (!zoneId || !hasVolumeControl()) { toast("This zone has no volume control"); return; }
    post("/api/volume", { zone_or_output_id: zoneId, mute: !isMuted() });
    setTimeout(fetchState, 200);
  }

  // The fourth transport slot.
  //
  // The Android build puts VOICE here. That is deliberately not ported: iOS
  // supports speech recognition in a Safari tab but NOT in an installed web
  // app — the API object is present, so feature detection reports success, and
  // then nothing happens. This page's whole purpose is to be installed on an
  // iOS home screen, so a mic here would be a button that looks live and
  // silently does nothing on the one platform it is for.
  //
  // The slot is kept (the geometry is shared with the Android dial, and four
  // controls is the layout) and given the other action the Android dial
  // offers, from its long-press menu: open the full app.
  function openApp() { window.location.href = "/"; }

  // ---- gestures, from onTouchEvent --------------------------------------
  function angleOf(x, y) { return Math.atan2(y - cy, x - cx) * 180 / Math.PI; }

  function applyRotation(degrees) {
    const v = primaryVolume();
    if (!v) return;

    let steps;
    if (isIncremental(v)) {
      residualDegrees += degrees;
      steps = Math.trunc(residualDegrees / DEGREES_PER_INCREMENT);
      if (steps === 0) return;
      residualDegrees -= steps * DEGREES_PER_INCREMENT;
    } else {
      const span = effectiveMax(v) - volMin(v);
      if (span <= 0) return;
      // Everything below one step is kept in `residual`, so a slow sweep still
      // accumulates instead of being rounded away.
      residual += degrees * (span / DEGREES_FOR_FULL_RANGE);
      const step = volStep(v);
      steps = Math.trunc(residual / step);
      if (steps === 0) return;
      residual -= steps * step;

      const base = optimisticValue != null ? optimisticValue : v.value;
      optimisticValue = Math.max(volMin(v), Math.min(effectiveMax(v), base + steps * step));
    }

    tick();
    pendingSteps += steps;
    const now = Date.now();
    if (now - lastSendAt >= SEND_INTERVAL_MS) {
      flushSteps();
    } else {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(flushSteps, SEND_INTERVAL_MS - (now - lastSendAt));
    }
  }

  function flushSteps() {
    clearTimeout(sendTimer);
    if (pendingSteps === 0) return;
    const steps = pendingSteps;
    pendingSteps = 0;
    lastSendAt = Date.now();
    sendVolumeSteps(steps);
  }

  // One haptic tick per detent, as the Android dial does. navigator.vibrate is
  // unsupported on iOS Safari, so on an iPhone this is simply a no-op and the
  // ring is visual-only — the one part of the feel that does not port.
  function tick() { if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} } }

  function handleTap(x, y) {
    const centres = controlCentres();
    const r = transportRadius() * 1.30;
    for (let i = 0; i < centres.length; i++) {
      if (Math.hypot(x - centres[i], y - transportY) > r) continue;
      if (i === 0) control("previous");
      else if (i === 1) control("playpause");
      else if (i === 2) control("next");
      else openApp();
      return;
    }
    // Upper third of the inner circle: zone name and volume readout.
    if (y < cy - innerRadius * 0.50) { openZonePicker(); return; }
    if (y < cy - innerRadius * 0.30) { toggleMute(); return; }
  }

  function onDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const dist = Math.hypot(x - cx, y - cy);
    downX = x; downY = y;
    moved = false; longPressFired = false;
    residual = 0; residualDegrees = 0;

    if (dist >= radius - ringWidth * 1.7 && dist <= radius + ringWidth) {
      lastAngle = angleOf(x, y);
      lastGestureAt = Date.now();
      mode = MODE_RING;
    } else {
      mode = MODE_INNER;
      longPressTimer = setTimeout(() => {
        if (mode === MODE_INNER && !moved) { longPressFired = true; tick(); openMenu(); }
      }, LONG_PRESS_MS);
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {} // capture is best-effort
    paint();
  }

  function onMove(e) {
    if (mode === MODE_NONE) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (!moved && Math.hypot(x - downX, y - downY) > TOUCH_SLOP) {
      moved = true;
      clearTimeout(longPressTimer);
    }
    if (mode === MODE_RING) {
      const angle = angleOf(x, y);
      let delta = angle - lastAngle;
      // Keep the sweep continuous across the 12 o'clock seam.
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      lastAngle = angle;
      if (Math.abs(delta) < 90) applyRotation(delta);
      lastGestureAt = Date.now();
      paint();
    }
  }

  function onUp(e) {
    clearTimeout(longPressTimer);
    if (mode === MODE_RING) {
      flushSteps();
      // Drop back to the now-playing view once the Core has had time to echo.
      setTimeout(() => {
        if (Date.now() - lastGestureAt >= OPTIMISTIC_WINDOW_MS) {
          optimisticValue = null;
          paint();
        }
      }, OPTIMISTIC_WINDOW_MS + 50);
    } else if (!moved && !longPressFired) {
      const rect = canvas.getBoundingClientRect();
      handleTap(e.clientX - rect.left, e.clientY - rect.top);
    }
    mode = MODE_NONE;
    paint();
  }

  function onCancel() {
    clearTimeout(longPressTimer);
    mode = MODE_NONE;
    flushSteps();
    paint();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);

  // ---- sheets and toast --------------------------------------------------
  const sheet      = document.getElementById("sheet");
  const sheetTitle = document.getElementById("sheet-title");
  const sheetItems = document.getElementById("sheet-items");
  const toastEl    = document.getElementById("toast");
  let toastTimer = null;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2600);
  }

  function closeSheet() { sheet.classList.add("hidden"); sheetItems.innerHTML = ""; }
  sheet.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-sheet-close")) closeSheet();
  });

  function showSheet(title, items) {
    sheetTitle.textContent = title;
    sheetItems.innerHTML = "";
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sheet-item" + (item.current ? " is-current" : "");
      b.textContent = item.label;
      b.addEventListener("click", () => { closeSheet(); item.action(); });
      sheetItems.appendChild(b);
    }
    sheet.classList.remove("hidden");
  }

  async function openZonePicker() {
    let list = [];
    try {
      const r = await fetch("/api/zones", { cache: "no-store" });
      if (r.ok) list = (await r.json()).zones || [];
    } catch (e) { /* fall through to the empty-list message below */ }
    if (!list.length) { toast("No zones yet"); return; }
    showSheet("Play in", list.map(z => ({
      label: z.display_name,
      current: z.zone_id === zoneId,
      action: () => selectZone(z.zone_id)
    })));
  }

  // Saving it is what makes the choice stick everywhere: the dial and the app
  // read the same key, so picking a zone on one face picks it on the other.
  function selectZone(id) {
    zoneId = id;
    try { localStorage.setItem("rra-zone", id); } catch (e) {} // storage optional
    artwork = null; artKey = null;
    fetchState();
  }

  function openMenu() {
    showSheet("Dial", [
      { label: "Open the full app", action: openApp },
      { label: "Pick a zone",       action: openZonePicker }
    ]);
  }

  // ---- polling -----------------------------------------------------------
  async function pickZoneIfNeeded() {
    if (zoneId) return;
    try {
      const r = await fetch("/api/zones", { cache: "no-store" });
      if (!r.ok) return;
      const list = (await r.json()).zones || [];
      if (!list.length) { statusText = "No zones yet"; return; }
      const active = list.find(z => z.state === "playing" || z.state === "loading");
      selectZone((active || list[0]).zone_id);
    } catch (e) { /* poll blip — the next tick retries */ }
  }

  async function loadArtwork(key) {
    if (key === artKey) return;
    artKey = key;
    if (!key) { artwork = null; paint(); return; }
    const img = new Image();
    img.onload = () => { if (artKey === key) { artwork = img; paint(); } };
    img.onerror = () => { if (artKey === key) { artwork = null; paint(); } };
    // 640 matches the Android build's ART_PX: the middle of the ring is large
    // on a tablet, and the server caches per size anyway.
    img.src = "/api/image/" + encodeURIComponent(key) + "?size=640";
  }

  async function fetchState() {
    await pickZoneIfNeeded();
    if (!zoneId) { paint(); return; }
    try {
      const r = await fetch("/api/zone-state?zone=" + encodeURIComponent(zoneId), { cache: "no-store" });
      if (!r.ok) return;   // server blip — keep what we have
      const j = await r.json();
      zone = j.zone || null;
      if (!zone) { statusText = "Zone has gone"; paint(); return; }

      // The Core has spoken, so a local value older than the window is stale.
      if (Date.now() - lastGestureAt > OPTIMISTIC_WINDOW_MS) optimisticValue = null;

      const np = zone.now_playing;
      statusText = np ? "" : "Nothing playing";

      // Position: reconcile, never snap. Identical to app.js and display.js —
      // Roon quantises to whole seconds on its own ~1Hz cadence, so assigning
      // the value every poll drags the arc backwards on each tick.
      const playingNow = isPlaying();
      const srvPos  = (np && np.seek_position) || 0;
      const prevLen = trackLen;
      trackLen = (np && np.length) || 0;
      const localPos = seekBase + (wasPlaying ? (Date.now() - seekBaseAt) / 1000 : 0);
      if (trackLen !== prevLen || playingNow !== wasPlaying || Math.abs(srvPos - localPos) > 3) {
        seekBase = srvPos;
      } else {
        seekBase = localPos;      // carry forward, so paused time is not counted
      }
      seekBaseAt = Date.now();
      wasPlaying = playingNow;

      loadArtwork(np && np.image_key);
      paint();
    } catch (e) { /* poll blip — the next tick retries */ }
  }

  // ---- keyboard / screen-reader controls ---------------------------------
  const a11y = {
    "a11y-prev":      () => control("previous"),
    "a11y-playpause": () => control("playpause"),
    "a11y-next":      () => control("next"),
    "a11y-voldown":   () => sendVolumeSteps(-1),
    "a11y-volup":     () => sendVolumeSteps(1),
    "a11y-mute":      toggleMute,
    "a11y-zone":      openZonePicker,
    "a11y-open":      openApp
  };
  for (const id of Object.keys(a11y)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", a11y[id]);
  }

  // ---- start -------------------------------------------------------------
  window.addEventListener("resize", resize);
  resize();
  fetchState();
  setInterval(fetchState, POLL_MS);
  // The painter paints; it does not advance. nowPos() derives the position
  // from the base and elapsed time, so a late tick cannot make the arc drift.
  setInterval(() => { if (isPlaying() && trackLen > 0) paint(); }, PAINT_MS);
})();
