"use strict";
// ---------------------------------------------------------------------------
// v1.8.25: the − and + inside the volume sheet's round step buttons.
//
// Reported from a phone: the marks sit high in their circles and read as
// faint. Both came from the same decision — they were TEXT ("−" and "+")
// centred by `align-items: center` on a 44px flex circle.
//
// Flex centres the LINE BOX, and a line box is not the glyph. "+" and "−"
// are drawn on the maths axis with the font's descender space hanging below
// them, so the box is centred while the ink inside it is not, and nothing in
// the CSS looks wrong. Weight had the same ceiling: a font's stem width is
// whatever the font says (~1.8px at 22px), and `font-weight` on a system
// symbol may do nothing at all.
//
// They are two <line>s in a symmetric 24-unit box now. This file measures the
// two things that has to buy, because the first is the one that looked right:
//
//   1. the icon's BOX is centred in the button, and
//   2. the INK is centred in that box.
//
// Both measurements are taken in the same frame, from the same driver, in the
// element's own coordinate system — getBBox() reports the drawn geometry in
// user units, so "centred" is checked against the viewBox rather than against
// a screenshot taken at some other moment.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

const VOL = { type: "number", min: 0, max: 100, value: 45, step: 1, is_muted: false };
const ZONE = {
  zone_id: "z1", display_name: "Zone", state: "playing", is_seek_allowed: true,
  outputs: [{ output_id: "o1", display_name: "Zone", is_muted: false, volume: VOL }],
  now_playing: { line1: "Steam Train", line2: "Baby Bird", line3: "Bad Shave",
                 length: 156, seek_position: 43, image_key: "k" },
};

const STUB = `
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}  // storage optional
window.__installFetch(function (u) {
  var z = ${JSON.stringify(ZONE)};
  if (u.indexOf("/api/zone-state") > -1) return window.__json({ zone: z });
  if (u.indexOf("/api/zones") > -1)      return window.__json({ zones: [z] });
  if (u.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (u.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (u.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (u.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  if (u.indexOf("/api/") > -1)           return window.__json({});
  return undefined;
});
`;

// Both sheets are measured. They are separate markup in index.html — one pair
// of buttons living in the mini bar, one on the now-playing screen — so a fix
// applied to one only is exactly the failure this has to catch.
const DRIVER = `
  await window.__sleep(500);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);

  // Measures one button: the icon box against the circle, and the ink against
  // the icon's own viewBox. Every number below comes from this one call.
  function probe(id) {
    var btn = document.getElementById(id);
    if (!btn) return null;
    var svg = btn.querySelector("svg");
    if (!svg) return { has_svg: false };
    var b = btn.getBoundingClientRect();
    var s = svg.getBoundingClientRect();
    if (!b.width || !s.width) return { has_svg: true, rendered: false };

    // getBBox() is the union of the drawn geometry in user units, ignoring
    // stroke. The strokes here are symmetric about their own paths, so the
    // geometry's centre IS the ink's centre whatever the cap style.
    var bb = svg.getBBox();
    var vb = svg.viewBox.baseVal;
    var uw = parseFloat(getComputedStyle(svg).strokeWidth);   // user units

    // Which element actually receives a tap at the centre of the circle. The
    // listeners are all on the button; an <svg> that swallows the hit would
    // still look right and do nothing.
    var hit = document.elementFromPoint(Math.round(b.left + b.width / 2),
                                        Math.round(b.top + b.height / 2));
    return {
      has_svg: true, rendered: true,
      dx: +(s.left + s.width / 2 - (b.left + b.width / 2)).toFixed(2),
      dy: +(s.top + s.height / 2 - (b.top + b.height / 2)).toFixed(2),
      ink_dx: +(bb.x + bb.width / 2 - (vb.x + vb.width / 2)).toFixed(4),
      ink_dy: +(bb.y + bb.height / 2 - (vb.y + vb.height / 2)).toFixed(4),
      // Stroke in DEVICE px: user units scaled by how the box maps the viewBox.
      stroke_px: +(uw * (s.width / vb.width)).toFixed(2),
      icon_px: Math.round(s.width),
      hit_is_button: !!hit && (hit === btn || btn.contains(hit)),
      hit_id: hit ? (hit.id || hit.tagName) : null,
    };
  }

  var pop = document.getElementById("mt-vol-popover");
  pop.classList.remove("hidden");
  await window.__sleep(250);
  T("mt_minus", probe("mt-vol-minus"));
  T("mt_plus",  probe("mt-vol-plus"));
  pop.classList.add("hidden");

  // The now-playing sheet, opened the way a user opens it.
  document.querySelector(".mt-info").click();
  await window.__sleep(500);
  T("np_open", document.getElementById("album-modal").classList.contains("np-mode"));
  var npPop = document.getElementById("np-vol-popover");
  npPop.classList.remove("hidden");
  await window.__sleep(250);
  T("np_minus", probe("np-vol-minus"));
  T("np_plus",  probe("np-vol-plus"));
`;

function render(size) {
  const r = harness.renderPage({ stub: STUB, driver: DRIVER,
                                 name: "vol-step-" + size.split("x")[0], windowSize: size });
  harness.assertNoPageError(assert, r);
  return r;
}

test("the − and + are centred in their circles and drawn bold", { concurrency: 1 }, async (t) => {
  for (const size of ["360x780", "390x844"]) {
    await t.test(size, () => {
      const r = render(size);
      assert.equal(r.np_open, true, "the now-playing screen did not open");

      for (const key of ["mt_minus", "mt_plus", "np_minus", "np_plus"]) {
        const g = r[key];
        assert.ok(g, key + " is missing from the page");
        assert.equal(g.has_svg, true,
          key + " has no <svg>: the mark is text again, and a text glyph is " +
          "centred by its line box, not by where the ink sits in it");
        assert.equal(g.rendered, true, key + " measured zero — the sheet was not open");

        // 1. The box, centred in the circle.
        assert.ok(Math.abs(g.dx) <= 1,
          key + ": the icon box is " + g.dx + "px off the circle's centre horizontally");
        assert.ok(Math.abs(g.dy) <= 1,
          key + ": the icon box is " + g.dy + "px off the circle's centre vertically");

        // 2. The ink, centred in the box. This is the half that a text glyph
        //    fails and a box measurement cannot see.
        assert.ok(Math.abs(g.ink_dx) <= 0.01,
          key + ": the drawing sits " + g.ink_dx + " user units off the viewBox centre in x");
        assert.ok(Math.abs(g.ink_dy) <= 0.01,
          key + ": the drawing sits " + g.ink_dy + " user units off the viewBox centre in y");

        // 3. Bold, in the units the eye reads: device pixels, not font-weight.
        assert.ok(g.stroke_px >= 2.5,
          key + ": the stroke renders " + g.stroke_px + "px — thinner than the ~1.8px " +
          "stem the text glyph drew plus the margin that makes it read as bolder");
        assert.ok(g.icon_px >= 20,
          key + ": the mark is only " + g.icon_px + "px across inside a 44px circle");

        // 4. Still a button. The glyph must not take the tap.
        assert.equal(g.hit_is_button, true,
          key + ": a tap at the centre of the circle lands on " + g.hit_id +
          ", not the button that carries the listener");
      }
    });
  }
});
