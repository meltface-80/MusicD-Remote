/*
 * tapdebug.js — what the screen thinks is happening when taps stop working.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * WHY THIS EXISTS. "Rotate to landscape, rotate back, and no button works;
 * force-quitting is the only way out" has now survived two fixes, each shipped
 * on a mechanism that could not be observed from here. The harness is headless
 * Chromium: it has no rotation, no visual viewport of its own and no iOS, so
 * no assertion in the suite can watch this happen. Reading the code has
 * produced two plausible stories and two wrong ones.
 *
 * So this stops guessing and measures, on the device where it actually
 * happens. It is the same move as the waveform probe in v1.8.30 and the Deezer
 * probe in v1.8.40: five ways to fail with one symptom between them is a
 * question for an instrument, not for another build.
 *
 * WHAT IT HAS TO SURVIVE. When the bug is present the app cannot be tapped —
 * so nothing here may depend on tapping anything. It is switched on BEFORE the
 * rotation, draws a readout that needs no interaction, and reports to the
 * server so the answer can be read from another machine. The panel itself is
 * `pointer-events: none` and is the only fixed element in the app that is
 * allowed to be: an instrument that could eat a tap would be indistinguishable
 * from the fault it is looking for.
 *
 * WHAT IT ANSWERS, and each reading names a different culprit:
 *
 *   events stop arriving at all        the touches are not reaching the page
 *   pointerdown arrives, click never   something is cancelling the click
 *   elementFromPoint names a layer     that layer is on top; it is the fault
 *   target != elementFromPoint         hit-testing is offset from the paint
 *   scale != 1, or offsets != 0        the page came back at the wrong scale
 *   win != doc != vv                   the viewports disagree after rotating
 *
 * Entirely inert unless switched on. No listeners, no panel, no requests.
 */
(() => {
  "use strict";

  const KEY = "musicd-tapdebug";

  // Switched on by the Settings toggle (localStorage) or by a URL, because a
  // browser address bar still works when the app's own buttons do not. The URL
  // form persists, so it survives the reload that a PWA has no other way to
  // trigger.
  let on = false;
  try {
    const q = String(location.search || "") + String(location.hash || "");
    if (/tapdebug=1/.test(q)) { localStorage.setItem(KEY, "1"); }
    else if (/tapdebug=0/.test(q)) { localStorage.removeItem(KEY); }
    on = localStorage.getItem(KEY) === "1";
  } catch (e) {
    // Private browsing: the URL still decides for this page view.
    on = /tapdebug=1/.test(String(location.search || ""));
  }
  if (!on) return;

  const MAX = 40;              // events kept in the ring buffer
  const events = [];
  let rotations = 0;
  let lastDown = null;         // the most recent pointer/touch start
  let sinceDownClicks = 0;

  // ---- the panel ---------------------------------------------------------
  const panel = document.createElement("div");
  panel.id = "tapdebug";
  panel.setAttribute("aria-hidden", "true");
  panel.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0",
    "z-index:2147483647",
    // THE ONE RULE THIS FILE MUST NOT BREAK.
    "pointer-events:none",
    "background:rgba(0,0,0,.82)", "color:#8f8",
    "font:10px/1.35 ui-monospace,Menlo,Consolas,monospace",
    "white-space:pre", "padding:4px 6px",
    "max-height:46vh", "overflow:hidden",
  ].join(";");
  const attach = () => {
    if (document.body && !panel.isConnected) document.body.appendChild(panel);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  // ---- describing an element --------------------------------------------
  function describe(el) {
    if (!el) return "null";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    const id = el.id ? "#" + el.id : "";
    const cls = String(el.className || "");
    const c = cls && typeof cls === "string"
      ? "." + cls.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return (el.tagName || "?").toLowerCase() + id + c;
  }

  // ---- the numbers -------------------------------------------------------
  function metrics() {
    const vv = window.visualViewport;
    return {
      win: [window.innerWidth, window.innerHeight],
      doc: [document.documentElement.clientWidth,
            document.documentElement.clientHeight],
      vv: vv ? [Math.round(vv.width), Math.round(vv.height),
                Number(vv.scale.toFixed(3)),
                Math.round(vv.offsetLeft), Math.round(vv.offsetTop),
                Math.round(vv.pageLeft), Math.round(vv.pageTop)] : null,
      dpr: window.devicePixelRatio,
      scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
      rot: rotations,
    };
  }

  function render() {
    const m = metrics();
    const lines = [];
    lines.push("TAPDEBUG  rot=" + m.rot + "  dpr=" + m.dpr);
    lines.push("win " + m.win.join("x") + "   doc " + m.doc.join("x") +
               (m.win[0] !== m.doc[0] || m.win[1] !== m.doc[1] ? "  <-- DIFFER" : ""));
    if (m.vv) {
      lines.push("vv  " + m.vv[0] + "x" + m.vv[1] + " scale=" + m.vv[2] +
                 " off=" + m.vv[3] + "," + m.vv[4] + " page=" + m.vv[5] + "," + m.vv[6] +
                 (m.vv[2] !== 1 ? "  <-- SCALED" : ""));
    }
    lines.push("scrollXY " + m.scroll.join(","));
    lines.push("--- last taps (newest first) ---");
    for (let i = events.length - 1; i >= 0 && lines.length < 22; i--) {
      const e = events[i];
      lines.push(e.type.padEnd(11) + " @" + e.x + "," + e.y +
                 (e.clicked === false ? "  NO-CLICK" : "") +
                 "\n  top=" + e.top +
                 (e.tgt !== e.top ? "\n  tgt=" + e.tgt + "  <-- MISMATCH" : ""));
    }
    panel.textContent = lines.join("\n");
  }

  // ---- recording ---------------------------------------------------------
  function record(type, x, y, target) {
    const top = document.elementFromPoint(x, y);
    const row = {
      t: Date.now(), type,
      x: Math.round(x), y: Math.round(y),
      top: describe(top), tgt: describe(target),
      m: metrics(),
      clicked: null,
    };
    events.push(row);
    while (events.length > MAX) events.shift();
    return row;
  }

  // Capture phase, passive, and nothing is ever prevented: an instrument that
  // changed the outcome would be measuring itself.
  const opts = { capture: true, passive: true };

  document.addEventListener("pointerdown", (e) => {
    lastDown = record("pointerdown", e.clientX, e.clientY, e.target);
    sinceDownClicks = 0;
    render();
  }, opts);

  document.addEventListener("touchstart", (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    record("touchstart", t.clientX, t.clientY, e.target);
    render();
  }, opts);

  document.addEventListener("click", (e) => {
    sinceDownClicks++;
    if (lastDown) lastDown.clicked = true;
    record("click", e.clientX, e.clientY, e.target);
    render();
  }, opts);

  /*
   * A pointerdown with no click after it is the single most useful reading
   * here, so it is marked explicitly rather than left to be inferred from two
   * rows. 400ms is well past the synthesised click on every platform.
   */
  setInterval(() => {
    if (lastDown && lastDown.clicked === null && Date.now() - lastDown.t > 400) {
      lastDown.clicked = false;
      lastDown = null;
      render();
    }
  }, 250);

  const onViewportChange = (what) => () => {
    if (what === "rot") rotations++;
    render();
    post();
  };
  window.addEventListener("orientationchange", onViewportChange("rot"), { passive: true });
  window.addEventListener("resize", onViewportChange("resize"), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange("vv"), { passive: true });
    window.visualViewport.addEventListener("scroll", onViewportChange("vv"), { passive: true });
  }
  setInterval(render, 1000);
  render();

  // ---- reporting ---------------------------------------------------------
  // Best effort and never awaited. The readout on screen is the primary
  // answer — it needs no network and no second device — and this is so the
  // same information can be read from a desktop without photographing a phone.
  let posting = false;
  async function post() {
    if (posting || !events.length) return;
    posting = true;
    try {
      await fetch("/api/debug/taps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ua: navigator.userAgent, at: Date.now(),
                               rotations, events }),
      });
    } catch (e) {
      // A failed report is not worth a message: the panel already has it all.
    } finally {
      posting = false;
    }
  }
  setInterval(post, 5000);
  window.addEventListener("pagehide", post, { passive: true });
})();
