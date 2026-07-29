"use strict";
// ---------------------------------------------------------------------------
// v1.7.1: the zone-grouping sheet (Roon group_outputs / ungroup_outputs).
//
// Grouping is the most destructive thing this app can ask Roon to do — it can
// retire a zone and take its queue with it — so the sheet is built around three
// invariants, and this file exists to hold them:
//
//   1. Roon preserves the FIRST output's queue. The zone you are listening to is
//      therefore always sent first and can never be unticked, so applying a
//      group cannot stop or move what is playing.
//   2. Roon decides which outputs can play in sync (can_group_with_output_ids).
//      Offering an output the Core will refuse produces an error the user can do
//      nothing about, so those rows are not listed at all — but an ABSENT list
//      means "unknown", and must offer everything rather than nothing.
//   3. Apply sends a diff, not the whole selection: unticking an output has to
//      become an ungroup call, and only genuinely new outputs a group call.
//      Sending only the group call would silently ignore every removal.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// Anchor zone z1 holds two outputs already grouped. o3 may join them; o4 may
// not (it is missing from o1's can-group list), so o4 must not be offered.
const OUTPUTS = [
  { output_id: "o1", zone_id: "z1", display_name: "Living Room", zone_name: "Living Room + Kitchen",
    can_group_with_output_ids: ["o2", "o3"] },
  { output_id: "o2", zone_id: "z1", display_name: "Kitchen", zone_name: "Living Room + Kitchen",
    can_group_with_output_ids: ["o1", "o3"] },
  // o3 is itself in a group, so its row can usefully name that group. o5 is its
  // partner but is not offerable, which is what keeps the two facts separate.
  { output_id: "o3", zone_id: "z2", display_name: "Study", zone_name: "Study + Porch",
    can_group_with_output_ids: ["o1", "o2"] },
  { output_id: "o4", zone_id: "z3", display_name: "Headphones", zone_name: "Headphones",
    can_group_with_output_ids: [] },
  { output_id: "o5", zone_id: "z2", display_name: "Porch", zone_name: "Study + Porch",
    can_group_with_output_ids: ["o3"] },
];

const ZONES = [
  { zone_id: "z1", display_name: "Living Room + Kitchen", state: "playing",
    settings: { shuffle: false, loop: "disabled", auto_radio: false },
    outputs: [OUTPUTS[0], OUTPUTS[1]] },
  { zone_id: "z2", display_name: "Study + Porch", state: "stopped",
    settings: { shuffle: false, loop: "disabled", auto_radio: false },
    outputs: [OUTPUTS[2], OUTPUTS[4]] },
  { zone_id: "z3", display_name: "Headphones", state: "stopped",
    settings: { shuffle: false, loop: "disabled", auto_radio: false }, outputs: [OUTPUTS[3]] },
];

const ZONE_STATE = Object.assign({}, ZONES[0], {
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  now_playing: {
    line1: "So What", line2: "Miles Davis", line3: "Kind of Blue",
    artists: [{ name: "Miles Davis", linkable: false }], length: 545, seek_position: 30,
  },
});

function stubFor({ canGroup }) {
  const outs = JSON.parse(JSON.stringify(OUTPUTS));
  if (canGroup === null) outs.forEach(o => { delete o.can_group_with_output_ids; });
  return `
window.__outputs = ${JSON.stringify(outs)};
window.__zones = ${JSON.stringify(ZONES)};
window.__zoneState = ${JSON.stringify(ZONE_STATE)};
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/outputs") > -1) return window.__json({ outputs: window.__outputs });
  if (url.indexOf("/api/group-outputs") > -1 || url.indexOf("/api/ungroup-outputs") > -1) {
    window.__posts.push({ url: url.replace(/^.*\\/api\\//, "/api/"),
                          body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: window.__zoneState });
  if (url.indexOf("/api/zones") > -1)      return window.__json({ zones: window.__zones });
  if (url.indexOf("/api/queue") > -1)      return window.__json({ items: [] });
  if (url.indexOf("/api/filters") > -1)    return window.__json({ genres: [] });
  if (url.indexOf("/api/home/") > -1)      return window.__json({ albums: [], label: null });
  if (url.indexOf("/api/status") > -1)     return window.__json({ paired: true });
  if (url.indexOf("/api/settings") > -1)   return window.__json({});
  if (url.indexOf("/api/random-albums") > -1)
    return window.__json({ albums: [], total: 0, filtered: false });
  return undefined;
});
`;
}

// Reaches the sheet the way a user does: the mini bar's zone popover.
const OPEN_SHEET = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  T("bar_shown", !bar.classList.contains("hidden"));
  document.getElementById("mt-zone").click();
  await window.__sleep(300);
  var pop = document.getElementById("mt-zone-popover");
  T("popover_open", !pop.classList.contains("hidden"));
  var entry = document.getElementById("mt-group-open");
  T("entry_exists", !!entry);
  entry.click();
  await window.__sleep(500);
  T("popover_closed_after", pop.classList.contains("hidden"));
  var sheet = document.querySelector(".lib-sheet-backdrop");
  T("sheet_open", !!sheet);
  function rows() {
    return Array.prototype.map.call(sheet.querySelectorAll(".group-row"), function (r) {
      return {
        output: r.dataset.output,
        name: (r.querySelector(".group-name") || {}).textContent || "",
        note: (r.querySelector(".group-note") || {}).textContent || "",
        on: r.classList.contains("is-on"),
        anchor: r.classList.contains("is-anchor"),
        disabled: r.disabled,
      };
    });
  }
  function row(id) { return sheet.querySelector('[data-output="' + id + '"]'); }
  function footBtn(label) {
    return Array.prototype.filter.call(sheet.querySelectorAll(".lib-sheet-foot button"),
      function (b) { return b.textContent === label; })[0];
  }
`;

const DRIVER_MAIN = OPEN_SHEET + `
  T("rows", rows());
  T("note", (sheet.querySelector(".lib-sheet-note") || {}).textContent || null);

  // Untick a grouped output and tick a new one, then apply.
  row("o2").click();
  await window.__sleep(120);
  row("o3").click();
  await window.__sleep(120);
  T("rows_after_toggle", rows());

  // The anchor must refuse to be unticked even if something clicks it.
  row("o1").click();
  await window.__sleep(120);
  T("anchor_still_on", row("o1").classList.contains("is-on"));

  footBtn("Apply").click();
  // The sheet must close as soon as Roon accepts, not after the background
  // re-point settles — check that separately, further down.
  await window.__sleep(400);
  T("posts", window.__posts);
  T("sheet_closed_promptly", !document.querySelector(".lib-sheet-backdrop"));
  await window.__sleep(2600);
  T("zone_repointed", localStorage.getItem("rra-zone"));
`;

const DRIVER_NOOP = OPEN_SHEET + `
  footBtn("Apply").click();
  await window.__sleep(1000);
  T("posts", window.__posts);
  T("sheet_closed", !document.querySelector(".lib-sheet-backdrop"));
`;

const DRIVER_CANCEL = OPEN_SHEET + `
  row("o3").click();
  await window.__sleep(120);
  footBtn("Cancel").click();
  await window.__sleep(400);
  T("posts", window.__posts);
  T("sheet_closed", !document.querySelector(".lib-sheet-backdrop"));
`;

const DRIVER_UNKNOWN = OPEN_SHEET + `
  T("rows", rows());
`;

test("the zone-grouping sheet groups and ungroups outputs (v1.7.1)", async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor({ canGroup: true }), driver: DRIVER_MAIN,
    name: "group-sheet", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the zone popover offers a way in, and closes behind it", () => {
    assert.equal(r.bar_shown, true);
    assert.equal(r.popover_open, true);
    assert.equal(r.entry_exists, true, "no Group zones… entry in the mini bar's zone popover");
    assert.equal(r.popover_closed_after, true, "the popover stayed open over the sheet");
    assert.equal(r.sheet_open, true);
  });

  await t.test("only outputs the Core can sync with the anchor are listed", () => {
    const ids = r.rows.map(x => x.output);
    assert.deepEqual(ids, ["o1", "o2", "o3"],
      "o4 is missing from the anchor's can-group list and must not be offered");
    assert.match(String(r.note), /can't sync/,
      "the sheet must say why some outputs are absent, or they look lost");
  });

  await t.test("the anchor is ticked, locked, and explains itself", () => {
    const anchor = r.rows.find(x => x.output === "o1");
    assert.equal(anchor.anchor, true);
    assert.equal(anchor.on, true);
    assert.equal(anchor.disabled, true, "the anchor must not be untickable — its queue is the group's");
    assert.match(anchor.note, /Keeps playing/);
    assert.equal(r.anchor_still_on, true);
  });

  await t.test("the zone's other output starts ticked, an outside one does not", () => {
    assert.equal(r.rows.find(x => x.output === "o2").on, true);
    assert.equal(r.rows.find(x => x.output === "o3").on, false);
    // o3 is currently in the "Study + Porch" group, so taking it will break that
    // group up — the row has to say so before you tick it.
    assert.match(r.rows.find(x => x.output === "o3").note, /In Study \+ Porch/,
      "an output already in a group should name it before you take it");
  });

  await t.test("a solo output's row does not repeat its own name back", () => {
    // "In Kitchen" under a row labelled "Kitchen" is noise; the note is only
    // worth the line when the output sits in a group with a different name.
    assert.equal(r.rows.find(x => x.output === "o2").note, "");
  });

  await t.test("ticking repaints without losing the other rows' state", () => {
    const a = r.rows_after_toggle;
    assert.equal(a.length, 3);
    assert.equal(a.find(x => x.output === "o1").on, true);
    assert.equal(a.find(x => x.output === "o2").on, false);
    assert.equal(a.find(x => x.output === "o3").on, true);
  });

  await t.test("Apply sends a diff: ungroup the removals, group the anchor first", () => {
    assert.equal(r.posts.length, 2, "expected one ungroup and one group call");
    assert.deepEqual(r.posts[0], { url: "/api/ungroup-outputs", body: { output_ids: ["o2"] } });
    // o1 first — Roon preserves the first output's queue.
    assert.deepEqual(r.posts[1], { url: "/api/group-outputs", body: { output_ids: ["o1", "o3"] } });
    assert.equal(r.posts[1].body.output_ids[0], "o1",
      "the anchor must be first or Roon keeps the wrong queue");
    assert.ok(!r.posts[1].body.output_ids.includes("o2"),
      "an output being ungrouped must not also be sent to group");
  });

  await t.test("the sheet closes as soon as Roon accepts, and the app follows the anchor's new zone", () => {
    // Holding the sheet open for the background re-point would leave the user
    // waiting on a change Roon has already made.
    assert.equal(r.sheet_closed_promptly, true);
    // z1 still contains o1 in the stub's zone list, so that is where the app
    // must land — never a silent fallback to whatever zone sorts first.
    assert.equal(r.zone_repointed, "z1");
  });

  const noop = harness.renderPage({
    stub: stubFor({ canGroup: true }), driver: DRIVER_NOOP,
    name: "group-noop", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, noop);
  await t.test("Apply with nothing changed asks Roon for nothing", () => {
    assert.deepEqual(noop.posts, []);
    assert.equal(noop.sheet_closed, true);
  });

  const cancel = harness.renderPage({
    stub: stubFor({ canGroup: true }), driver: DRIVER_CANCEL,
    name: "group-cancel", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, cancel);
  await t.test("Cancel discards the selection instead of applying it", () => {
    assert.deepEqual(cancel.posts, []);
    assert.equal(cancel.sheet_closed, true);
  });

  const unknown = harness.renderPage({
    stub: stubFor({ canGroup: null }), driver: DRIVER_UNKNOWN,
    name: "group-unknown", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, unknown);
  await t.test("a Core that sends no can-group list offers every output", () => {
    // The dangerous inversion: reading "unknown" as "nothing is groupable"
    // would leave the sheet listing only the zone you are already on.
    assert.deepEqual(unknown.rows.map(x => x.output), ["o1", "o2", "o3", "o4", "o5"]);
  });
});
