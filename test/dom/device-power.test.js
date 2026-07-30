"use strict";
// ---------------------------------------------------------------------------
// v1.7.2: the device-power sheet (Roon standby / convenience_switch) and the
// all-zone menu actions (pause_all / mute_all).
//
// What makes this worth a test rather than an eyeball:
//
//   1. Most outputs expose NO source control, and Roon can only power a device
//      through one. The honest result is an explanation, not an empty sheet —
//      and a sheet that lists rows for un-actionable controls is worse still,
//      because every button on them silently does nothing.
//   2. A row here is not a button; the actions inside it are. Nesting a button
//      inside a button is invalid HTML and the inner clicks stop working in
//      some browsers, so the row's element type is asserted directly.
//   3. Power is a toggle on ONE control (Roon defines toggle_standby per
//      control), while "whole device" is the keyless bulk form. Sending the
//      wrong one either powers the wrong thing or fails validation, so the
//      request bodies are asserted, not just the fact that a call happened.
//   4. The side menu closes BEFORE its action runs, so a toast is the only
//      feedback that exists. Mute and unmute are separate rows for the same
//      reason — a single toggling label cannot be refreshed while shut.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./harness");

// o1: an amp with two standby-capable inputs → per-control toggles AND the
//     keyless "whole device" action.
// o2: one control, powerless (supports_standby false) → switch only, no Power.
// o3: in standby → its Power button must not read as on.
// o4: no source controls at all → not listed.
const OUTPUTS = [
  { output_id: "o1", zone_id: "z1", display_name: "Amp", zone_name: "Amp",
    can_group_with_output_ids: [], source_controls: [
      { control_key: "1", display_name: "Amp — Roon", status: "selected",   supports_standby: true },
      { control_key: "2", display_name: "Amp — CD",   status: "deselected", supports_standby: true },
    ] },
  { output_id: "o2", zone_id: "z2", display_name: "Streamer", zone_name: "Streamer",
    can_group_with_output_ids: [], source_controls: [
      { control_key: "9", display_name: "Streamer", status: "selected", supports_standby: false },
    ] },
  { output_id: "o3", zone_id: "z3", display_name: "AVR", zone_name: "AVR",
    can_group_with_output_ids: [], source_controls: [
      { control_key: "7", display_name: "AVR", status: "standby", supports_standby: true },
    ] },
  { output_id: "o4", zone_id: "z4", display_name: "Plain endpoint", zone_name: "Plain endpoint",
    can_group_with_output_ids: [], source_controls: [] },
];

const ZONE_STATE = {
  zone_id: "z1", display_name: "Amp", state: "playing",
  is_previous_allowed: true, is_next_allowed: true, is_seek_allowed: true,
  settings: { shuffle: false, loop: "disabled", auto_radio: false },
  outputs: [{ output_id: "o1", display_name: "Amp", is_muted: false, volume: null }],
  now_playing: {
    line1: "So What", line2: "Miles Davis", line3: "Kind of Blue",
    artists: [{ name: "Miles Davis", linkable: false }], length: 545, seek_position: 30,
  },
};

function stubFor(outs) {
  return `
window.__outputs = ${JSON.stringify(outs)};
window.__posts = [];
try { localStorage.setItem("rra-zone", "z1"); } catch (e) {}
window.__installFetch(function (url, opts) {
  if (url.indexOf("/api/outputs") > -1) return window.__json({ outputs: window.__outputs });
  if (url.indexOf("/api/output/standby") > -1 ||
      url.indexOf("/api/output/convenience-switch") > -1 ||
      url.indexOf("/api/pause-all") > -1 ||
      url.indexOf("/api/mute-all") > -1) {
    window.__posts.push({ url: url.replace(/^.*\\/api\\//, "/api/"),
                          body: JSON.parse((opts && opts.body) || "{}") });
    return window.__json({ ok: true });
  }
  if (url.indexOf("/api/zone-state") > -1) return window.__json({ zone: ${JSON.stringify(ZONE_STATE)} });
  if (url.indexOf("/api/zones") > -1)
    return window.__json({ zones: [${JSON.stringify(ZONE_STATE)}] });
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

const OPEN_SHEET = `
  await window.__sleep(400);
  var bar = document.getElementById("mini-transport");
  for (var w = 0; w < 40 && bar.classList.contains("hidden"); w++) await window.__sleep(100);
  document.getElementById("mt-zone").click();
  await window.__sleep(300);
  var entry = document.getElementById("mt-power-open");
  T("entry_exists", !!entry);
  entry.click();
  await window.__sleep(500);
  var sheet = document.querySelector(".lib-sheet-backdrop");
  T("sheet_open", !!sheet);
  T("popover_closed", document.getElementById("mt-zone-popover").classList.contains("hidden"));
  function rows() {
    return Array.prototype.map.call(sheet.querySelectorAll(".dev-row"), function (r) {
      return {
        control: r.dataset.control,
        tag: r.tagName,
        name: (r.querySelector(".dev-name") || {}).textContent || "",
        status: (r.querySelector(".dev-status") || {}).textContent || "",
        buttons: Array.prototype.map.call(r.querySelectorAll(".dev-btn"), function (b) {
          return { action: b.dataset.action, text: b.textContent,
                   on: b.classList.contains("is-on"), label: b.getAttribute("aria-label") };
        }),
      };
    });
  }
  function btn(control, action) {
    var r = sheet.querySelector('[data-control="' + control + '"]');
    return r && r.querySelector('[data-action="' + action + '"]');
  }
`;

const DRIVER_MAIN = OPEN_SHEET + `
  T("rows", rows());
  T("sections", Array.prototype.map.call(sheet.querySelectorAll(".lib-sheet-section-label"),
    function (s) { return s.textContent; }));
  T("all_off_count", sheet.querySelectorAll('[data-action="all-off"]').length);

  btn("1", "standby").click();
  await window.__sleep(700);
  btn("2", "switch").click();
  await window.__sleep(700);
  sheet.querySelector('[data-action="all-off"]').click();
  await window.__sleep(700);
  T("posts", window.__posts);
`;

const DRIVER_EMPTY = OPEN_SHEET + `
  T("rows", rows());
  T("note", (sheet.querySelector(".lib-sheet-note") || {}).textContent || null);
`;

const DRIVER_MENU = `
  await window.__sleep(400);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  var overlay = document.getElementById("menu-overlay");
  T("menu_open", !overlay.classList.contains("hidden"));
  function item(action) { return overlay.querySelector('[data-action="' + action + '"]'); }
  T("labels", ["pause-all", "mute-all", "unmute-all"].map(function (a) {
    var el = item(a);
    return el ? el.querySelector("span").textContent : null;
  }));

  item("pause-all").click();
  await window.__sleep(500);
  T("menu_closed_after", overlay.classList.contains("hidden"));
  T("toast_after_pause", (document.querySelector(".toast") || {}).textContent || null);

  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  item("mute-all").click();
  await window.__sleep(500);
  document.getElementById("menu-toggle").click();
  await window.__sleep(200);
  item("unmute-all").click();
  await window.__sleep(500);
  T("posts", window.__posts);
`;

test("the device-power sheet drives Roon standby and convenience switch (v1.7.2)", async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor(OUTPUTS), driver: DRIVER_MAIN,
    name: "device-power", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("the zone popover offers a way in, and closes behind it", () => {
    assert.equal(r.entry_exists, true, "no Device power… entry in the zone popover");
    assert.equal(r.sheet_open, true);
    assert.equal(r.popover_closed, true);
  });

  await t.test("only outputs with source controls are listed", () => {
    assert.deepEqual(r.sections, ["Amp", "Streamer", "AVR"],
      "an output with no source controls has nothing to power and must not appear");
    assert.deepEqual(r.rows.map(x => x.control), ["1", "2", "9", "7"]);
  });

  await t.test("a row is not a button, so its action buttons stay valid", () => {
    for (const row of r.rows) {
      assert.notEqual(row.tag, "BUTTON",
        "a <button> row containing buttons is invalid HTML and breaks the inner clicks");
    }
  });

  await t.test("each control's state is spelled out, not left blank", () => {
    assert.match(r.rows.find(x => x.control === "1").status, /Roon input selected/);
    assert.match(r.rows.find(x => x.control === "2").status, /another input/);
    assert.match(r.rows.find(x => x.control === "7").status, /standby/i);
  });

  await t.test("Power appears only where Roon says standby is supported", () => {
    const actions = (c) => r.rows.find(x => x.control === c).buttons.map(b => b.action);
    assert.deepEqual(actions("1"), ["standby", "switch"]);
    assert.deepEqual(actions("9"), ["switch"],
      "a control that cannot be put into standby must not offer a Power button");
  });

  await t.test("the Power button shows live state, and its label says what a tap does", () => {
    const p1 = r.rows.find(x => x.control === "1").buttons.find(b => b.action === "standby");
    const p7 = r.rows.find(x => x.control === "7").buttons.find(b => b.action === "standby");
    assert.equal(p1.on, true, "a powered control's button should read as on");
    assert.equal(p7.on, false, "a control in standby must NOT read as on");
    assert.match(p1.label, /into standby/);
    assert.match(p7.label, /Wake/);
  });

  await t.test("the whole-device action appears only where it differs from a toggle", () => {
    // Only the Amp has two standby-capable controls; on a single-control device
    // "whole device" and the one Power button would be the same action twice.
    assert.equal(r.all_off_count, 1);
  });

  await t.test("each action sends the request Roon's API actually defines", () => {
    assert.deepEqual(r.posts, [
      // Power = toggle_standby, which Roon defines per control → key required.
      { url: "/api/output/standby",
        body: { output_id: "o1", control_key: "1", mode: "toggle" } },
      { url: "/api/output/convenience-switch",
        body: { output_id: "o1", control_key: "2" } },
      // Whole device = standby() with no control_key, the documented bulk form.
      { url: "/api/output/standby", body: { output_id: "o1", mode: "standby" } },
    ]);
  });

  const empty = harness.renderPage({
    stub: stubFor([OUTPUTS[3]]), driver: DRIVER_EMPTY,
    name: "device-power-empty", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, empty);
  await t.test("with nothing powerable, the sheet explains instead of sitting empty", () => {
    assert.deepEqual(empty.rows, []);
    assert.match(String(empty.note), /source control/,
      "an empty sheet must say why, or it reads as a broken feature");
  });
});

test("the side menu drives Roon's all-zone actions (v1.7.2)", async (t) => {
  if (!harness.available) {
    t.skip("no chromium binary available");
    return;
  }

  const r = harness.renderPage({
    stub: stubFor(OUTPUTS), driver: DRIVER_MENU,
    name: "all-zones", windowSize: "390x844",
  });
  harness.assertNoPageError(assert, r);

  await t.test("all three rows exist, mute and unmute separately", () => {
    assert.equal(r.menu_open, true);
    assert.deepEqual(r.labels, ["Pause all zones", "Mute all zones", "Unmute all zones"]);
  });

  await t.test("the menu closes and a toast reports the action", () => {
    assert.equal(r.menu_closed_after, true);
    // The drawer is gone before the fetch resolves, so the toast is the only
    // feedback that can exist — its absence would leave the tap silent.
    assert.ok(r.toast_after_pause, "no toast after Pause all zones");
  });

  await t.test("each row hits its own endpoint with the right body", () => {
    assert.deepEqual(r.posts, [
      { url: "/api/pause-all", body: {} },
      { url: "/api/mute-all", body: { how: "mute" } },
      { url: "/api/mute-all", body: { how: "unmute" } },
    ]);
  });
});
