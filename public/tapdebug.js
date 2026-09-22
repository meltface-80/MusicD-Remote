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
  const turns = [];            // what each rotation did to the viewport
  let verdict = "";            // the headline, when something is measurably wrong

  /*
   * IS THE APP RUNNING AS A HOME-SCREEN APP? The bug is reported only there —
   * Safari and Chrome on the same phone are fine — so this is the first thing
   * any reading has to state, or two runs are not comparable.
   */
  function standalone() {
    const legacy = navigator.standalone === true;
    let dm = false;
    try { dm = window.matchMedia("(display-mode: standalone)").matches; } catch (e) {}
    return legacy || dm;
  }

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
  // Fetched once. Which build this is, because a screenshot of this panel
  // could not previously say whether it came from one with the fix in it.
  let appVersion = "?";
  fetch("/api/status").then(r => r.json()).then(j => {
    if (j && j.version) { appVersion = String(j.version); render(); }
  }).catch(() => { /* the rest of the panel is still worth reading */ });

  function metrics() {
    const vv = window.visualViewport;
    const de = document.documentElement;
    const bd = document.body;
    return {
      /*
       * IS THERE ANYTHING TO SCROLL? The offset is 62px, which is this
       * device's top safe-area inset — so the question is whether the
       * document is 62px taller than the box showing it (something overflows,
       * and the fix is to stop it) or exactly as tall as it (nothing
       * overflows, the offset is not a document scroll at all, and no amount
       * of scrollTo will ever move it).
       */
      over: [de ? de.scrollHeight - de.clientHeight : -1,
             bd ? bd.scrollHeight - bd.clientHeight : -1],
      sTop: [de ? de.scrollTop : -1, bd ? bd.scrollTop : -1,
             document.scrollingElement ? document.scrollingElement.scrollTop : -1],
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

  /*
   * WHAT IS MEASURABLY WRONG, in one line.
   *
   * The panel exists to be read by somebody holding a phone that will not
   * respond, and six numbers that need interpreting are no use in that
   * position. Each test below is a different fault with a different fix, and
   * every one of them is a plain comparison rather than a judgement:
   *
   *   win != doc            the layout viewport is not the window: the page is
   *                         laid out for a size the screen no longer is
   *   orientation vs size   the device says portrait and the page is landscape
   *   scale != 1            the page came back zoomed
   *   vv offsets            the visual viewport is shifted inside the layout one
   *   scrolled              the window scrolled despite overflow: hidden
   *
   * An empty verdict with dead buttons is itself a finding: it says the
   * viewport is intact and the fault is somewhere else entirely, which rules
   * out every mechanism this file was built to catch.
   */
  function computeVerdict(m) {
    const bad = [];
    if (m.win[0] !== m.doc[0] || m.win[1] !== m.doc[1]) {
      bad.push("LAYOUT VIEWPORT STALE (win " + m.win.join("x") +
               " vs doc " + m.doc.join("x") + ")");
    }
    const portrait = Math.abs(Number(window.orientation) || 0) !== 90;
    const wide = m.win[0] > m.win[1];
    if (typeof window.orientation === "number" && portrait === wide) {
      bad.push("ORIENTATION AND SIZE DISAGREE (orientation=" +
               window.orientation + ", win " + m.win.join("x") + ")");
    }
    if (m.vv) {
      if (m.vv[2] !== 1) bad.push("PAGE IS SCALED (" + m.vv[2] + ")");
      if (m.vv[3] || m.vv[4]) bad.push("VISUAL VIEWPORT OFFSET (" + m.vv[3] + "," + m.vv[4] + ")");
      if (m.vv[0] !== m.win[0]) {
        bad.push("VISUAL != WINDOW WIDTH (" + m.vv[0] + " vs " + m.win[0] + ")");
      }
    }
    if (m.scroll[0] || m.scroll[1]) bad.push("WINDOW SCROLLED (" + m.scroll.join(",") + ")");
    return bad.join(" | ");
  }

  function render() {
    const m = metrics();
    verdict = computeVerdict(m);
    panel.style.background = verdict ? "rgba(90,0,0,.92)" : "rgba(0,0,0,.82)";
    panel.style.color = verdict ? "#ffb4b4" : "#8f8";
    const lines = [];
    if (verdict) {
      lines.push("*** " + verdict + " ***");
    } else if (rotations) {
      lines.push("viewport looks consistent after " + rotations + " rotation(s)");
    }
    lines.push("TAPDEBUG v" + appVersion + "  rot=" + m.rot + "  dpr=" + m.dpr +
               "  standalone=" + (standalone() ? "YES" : "no"));
    /*
     * WHAT THE FIX ITSELF DID. The app pins the window scroll to zero; this
     * reports whether that code is present, how often it has run, and — the
     * reading that decides everything — whether the number MOVED when it did.
     */
    const ps = window.__pinStats;
    if (!ps) {
      lines.push("pin  NOT IN THIS BUILD");
    } else {
      lines.push("pin  fired=" + ps.fired +
                 (ps.fired ? "  " + ps.before + "->" + ps.after +
                             (ps.moved ? "  (moved)" : "  <-- DID NOT MOVE") : ""));
    }
    lines.push("overflow de=" + m.over[0] + " body=" + m.over[1] +
               "   scrollTop de/body/se " + m.sTop.join("/"));
    lines.push("win " + m.win.join("x") + "   doc " + m.doc.join("x") +
               (m.win[0] !== m.doc[0] || m.win[1] !== m.doc[1] ? "  <-- DIFFER" : ""));
    if (m.vv) {
      lines.push("vv  " + m.vv[0] + "x" + m.vv[1] + " scale=" + m.vv[2] +
                 " off=" + m.vv[3] + "," + m.vv[4] + " page=" + m.vv[5] + "," + m.vv[6] +
                 (m.vv[2] !== 1 ? "  <-- SCALED" : ""));
    }
    lines.push("scrollXY " + m.scroll.join(","));
    if (turns.length) {
      lines.push("--- rotations (newest first) ---");
      for (let i = turns.length - 1; i >= 0 && i > turns.length - 4; i--) {
        const t = turns[i];
        lines.push("#" + t.n + " +" + t.after + "ms  win " + t.m.win.join("x") +
                   "  doc " + t.m.doc.join("x") +
                   (t.m.vv ? "  vv " + t.m.vv[0] + "x" + t.m.vv[1] + " s=" + t.m.vv[2] : "") +
                   (t.verdict ? "\n   " + t.verdict : ""));
      }
    }
    lines.push("--- last taps (newest first) ---");
    if (!events.length) {
      // THE READING THAT MATTERS MOST when the screen is dead: no rows here
      // after tapping means the presses never reached the page at all, which
      // is a different fault from any of the viewport ones above.
      lines.push("(nothing recorded yet — if you have tapped, the taps are");
      lines.push(" not reaching the page)");
    }
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
    armNoClickCheck(lastDown);
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
   *
   * Scheduled FROM the press rather than swept by a permanent timer: a poll
   * that runs for the life of the page costs something on a phone and nothing
   * on a page nobody is pressing, and under the test harness's virtual clock a
   * quarter-second interval is fast-forwarded into thousands of callbacks that
   * starve the driver. One timeout per press has neither problem.
   */
  function armNoClickCheck(row) {
    setTimeout(() => {
      if (row.clicked === null) { row.clicked = false; render(); }
    }, 400);
  }

  /*
   * A ROTATION IS NOT AN INSTANT, so it is sampled three times.
   *
   * iOS fires orientationchange before the web view has finished resizing, and
   * a standalone app settles later than a tabbed one. A single reading taken
   * on the event catches the middle of the transition and calls a viewport
   * stale when it is merely mid-flight. The last sample, a second later, is
   * the one that says whether it ever settled.
   */
  function sampleTurn(n, after) {
    const m = metrics();
    turns.push({ n, after, m, verdict: computeVerdict(m) });
    while (turns.length > 12) turns.shift();
    render();
  }

  const onViewportChange = (what) => () => {
    if (what === "rot") {
      const n = ++rotations;
      sampleTurn(n, 0);
      setTimeout(() => sampleTurn(n, 300), 300);
      setTimeout(() => { sampleTurn(n, 1000); post(); }, 1000);
      return;
    }
    render();
    post();
  };
  window.addEventListener("orientationchange", onViewportChange("rot"), { passive: true });
  window.addEventListener("resize", onViewportChange("resize"), { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange("vv"), { passive: true });
    window.visualViewport.addEventListener("scroll", onViewportChange("vv"), { passive: true });
  }
  setInterval(render, 2000);
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
                               version: appVersion, pin: window.__pinStats || null,
                               standalone: standalone(), verdict,
                               rotations, turns, events }),
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
