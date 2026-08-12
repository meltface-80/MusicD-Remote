"use strict";
// ---------------------------------------------------------------------------
// v1.7.67: the volume popover's row alignment.
//
// Reported from a screenshot: "the layout isn't aligned". It was, by 8px, and
// the cause is the kind that reads as correct in the source.
//
// `.vol-controls` is a flex row of three things: the readout (icon + number),
// the slider wrapper, and the two step buttons. The wrapper was a COLUMN
// holding the slider with the 0/100 scale beneath it, which made it ~20px
// taller than the slider alone. `align-items: center` then did exactly what it
// says — centred every sibling against the wrapper's FULL height — so the
// readout and both buttons sat centred on slider-plus-scale while the slider
// sat centred on itself. Everything was 8px low relative to the track it
// belongs to, and nothing in the CSS looks wrong.
//
// The scale is positioned now, so the wrapper is exactly the slider's height.
// This is measured rather than asserted from the stylesheet, because the
// stylesheet is precisely what looked fine.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const VOL = { type: "number", min: 0, max: 100, value: 13, step: 1, is_muted: false };
const OUT = { output_id: "o1", display_name: "Zone", volume: VOL };

const STUB = `
window.__installFetch(function (u) {
  if (u.indexOf("/api/zones") > -1)
    return window.__json({ zones: [{ zone_id: "z1", display_name: "Zone", state: "playing",
      outputs: [${JSON.stringify(OUT)}] }] });
  if (u.indexOf("/api/zone-state") > -1)
    return window.__json({ zone: { zone_id: "z1", state: "playing",
      now_playing: { three_line: { line1: "How to Be Dead", line2: "Snow Patrol", line3: "Final Straw" },
                     length: 200, seek_position: 5, image_key: "k" },
      outputs: [${JSON.stringify(OUT)}] } });
  if (u.indexOf("/api/queue") > -1)  return window.__json({ items: [] });
  if (u.indexOf("/api/status") > -1) return window.__json({ paired: true });
  if (u.indexOf("/api/") > -1)       return window.__json({});
  return undefined;
});
`;

// The popover is revealed directly rather than by tapping the button: the point
// here is geometry, and driving the open animation only adds a timing variable.
const DRIVER = `
  await window.__sleep(700);
  document.getElementById("mini-transport").classList.remove("hidden");
  var pop = document.getElementById("mt-vol-popover");
  pop.classList.remove("hidden");
  var ctl = document.getElementById("mt-vol-controls");
  if (ctl) ctl.classList.remove("hidden");
  await window.__sleep(250);

  function midOf(sel) {
    var e = document.querySelector(sel);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return r.height ? Math.round(r.top + r.height / 2) : null;
  }
  T("slider_mid",  midOf("#mt-vol-popover .vol-range"));
  T("readout_mid", midOf("#mt-vol-popover .vol-readout"));
  T("minus_mid",   midOf("#mt-vol-minus"));
  T("plus_mid",    midOf("#mt-vol-plus"));

  var sc  = document.querySelector("#mt-vol-popover .vol-scale");
  var sl  = document.querySelector("#mt-vol-popover .vol-range");
  T("scale_gap",     sc && sl ? Math.round(sc.getBoundingClientRect().top - sl.getBoundingClientRect().bottom) : null);
  T("scale_clear",   sc ? Math.round(pop.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom) : null);
  T("scale_visible", sc ? getComputedStyle(sc).display !== "none" : null);
  T("min_label", sc ? sc.firstElementChild.textContent : null);
  T("max_label", sc ? sc.lastElementChild.textContent : null);
`;

function measure(name, size) {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER, name, windowSize: size });
  harness.assertNoPageError(assert, r);
  assert.ok(r.slider_mid, "the volume popover did not render at " + size);
  return r;
}

test("the volume row lines up on the slider track", { concurrency: 1 }, async (t) => {
  for (const size of ["360x780", "390x844", "768x1024"]) {
    await t.test(size + ": readout, slider and both step buttons share a centre line", () => {
      const r = measure("vol-align-" + size.split("x")[0], size);
      // 1px of tolerance for sub-pixel rounding, no more. The bug was 8px.
      for (const [label, v] of [["readout", r.readout_mid], ["minus", r.minus_mid], ["plus", r.plus_mid]]) {
        assert.ok(Math.abs(v - r.slider_mid) <= 1,
          label + " is centred at " + v + " but the slider track is at " + r.slider_mid +
          " (" + Math.abs(v - r.slider_mid) + "px out) at " + size + ". The 0/100 scale is " +
          "back in the flow, making the slider wrapper taller than the slider and " +
          "dragging every sibling down with align-items: center.");
      }
    });
  }

  await t.test("the scale still sits under the slider, inside the popover", () => {
    // Positioning it must not push it out of the sheet, or off the bottom of
    // the screen — which is the obvious way to "fix" the alignment wrongly.
    const r = measure("vol-align-scale", "390x844");
    assert.equal(r.scale_visible, true, "the 0/100 scale was hidden rather than repositioned");
    assert.equal(r.min_label, "0");
    assert.equal(r.max_label, "100");
    assert.ok(r.scale_gap >= 0 && r.scale_gap <= 8,
      "the scale sits " + r.scale_gap + "px from the slider — it should read as its label");
    assert.ok(r.scale_clear >= 4,
      "the scale is only " + r.scale_clear + "px above the popover's bottom edge, so the " +
      "sheet has no padding left for it and it will look clipped");
  });
});
