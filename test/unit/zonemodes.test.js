"use strict";
// ---------------------------------------------------------------------------
// v1.7.1: the two projections that carry Roon's zone/output capabilities to the
// client — zoneSettings() and outputInfo().
//
// Both exist because the raw Roon objects are optional in places the UI is not.
// A zone that has never been played has no `settings` block at all, and
// `can_group_with_output_ids` is absent on Cores that don't send it. The whole
// point of these two functions is that the client never has to guess, so the
// tests here are about the ABSENT and the UNEXPECTED cases, not the happy path.
//
// One asymmetry is deliberate and worth stating: an unknown `loop` value
// collapses to "disabled" (a mode we can't render is worse than off), while an
// absent can-group list becomes null, which the client reads as "unknown, offer
// everything" — offering nothing would make grouping look broken rather than
// limited. Getting those two backwards is the bug this file is here to catch.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const { zoneSettings, outputInfo } = loadIndexFunctions(["zoneSettings", "outputInfo"]);

test("zoneSettings normalises Roon's optional settings block", async (t) => {
  await t.test("a zone with no settings at all reads as everything off", () => {
    assert.deepEqual(zoneSettings({ zone_id: "z1" }), {
      shuffle: false, loop: "disabled", auto_radio: false,
    });
  });

  await t.test("a null/undefined zone does not throw", () => {
    assert.deepEqual(zoneSettings(null), { shuffle: false, loop: "disabled", auto_radio: false });
    assert.deepEqual(zoneSettings(undefined), { shuffle: false, loop: "disabled", auto_radio: false });
  });

  await t.test("real values pass through", () => {
    assert.deepEqual(
      zoneSettings({ settings: { shuffle: true, loop: "loop", auto_radio: true } }),
      { shuffle: true, loop: "loop", auto_radio: true }
    );
    assert.equal(zoneSettings({ settings: { loop: "loop_one" } }).loop, "loop_one");
  });

  await t.test("booleans are coerced, not passed through", () => {
    // Roon sends booleans, but the UI toggles a class on this value — a
    // truthy string would light the button and then fail to invert on click.
    const s = zoneSettings({ settings: { shuffle: 1, auto_radio: "yes" } });
    assert.equal(s.shuffle, true);
    assert.equal(s.auto_radio, true);
    assert.equal(typeof s.shuffle, "boolean");
    assert.equal(typeof s.auto_radio, "boolean");
  });

  await t.test("a loop mode we cannot render collapses to off", () => {
    for (const bad of ["next", "LOOP", "on", "", null, 3, {}]) {
      assert.equal(zoneSettings({ settings: { loop: bad } }).loop, "disabled",
        `loop ${JSON.stringify(bad)} should read as disabled`);
    }
  });

  await t.test('"next" specifically never reaches the client', () => {
    // Roon accepts loop:"next" as a server-side cycle, but the button labels
    // the mode it is IN. If "next" leaked through as a state the label would
    // read "Repeat off" while the zone repeated.
    assert.equal(zoneSettings({ settings: { loop: "next" } }).loop, "disabled");
  });
});

test("outputInfo carries Roon's grouping capability", async (t) => {
  await t.test("the fields the grouping sheet needs are present", () => {
    assert.deepEqual(
      outputInfo({
        output_id: "o1", zone_id: "z1", display_name: "Kitchen",
        can_group_with_output_ids: ["o2", "o3"],
      }),
      { output_id: "o1", zone_id: "z1", display_name: "Kitchen", can_group_with_output_ids: ["o2", "o3"] }
    );
  });

  await t.test("an absent can-group list becomes null, not an empty array", () => {
    // null means "unknown — offer everything". [] would mean "nothing is
    // groupable", which is how this feature would silently stop working on a
    // Core that doesn't send the field.
    assert.equal(outputInfo({ output_id: "o1", display_name: "A" }).can_group_with_output_ids, null);
    assert.equal(outputInfo({ output_id: "o1", can_group_with_output_ids: "o2" })
      .can_group_with_output_ids, null);
    assert.equal(outputInfo({ output_id: "o1", can_group_with_output_ids: {} })
      .can_group_with_output_ids, null);
  });

  await t.test("an empty list is preserved — it is a real answer", () => {
    // "This output can be grouped with nothing" is different from "I don't
    // know", and only the first should hide the other outputs.
    assert.deepEqual(outputInfo({ output_id: "o1", can_group_with_output_ids: [] })
      .can_group_with_output_ids, []);
  });

  await t.test("the list is copied, so a client cannot mutate the live cache", () => {
    const raw = { output_id: "o1", can_group_with_output_ids: ["o2"] };
    const out = outputInfo(raw);
    out.can_group_with_output_ids.push("o9");
    assert.deepEqual(raw.can_group_with_output_ids, ["o2"]);
  });

  await t.test("a zoneless output projects a null zone, not undefined", () => {
    // JSON.stringify drops undefined, so the client would see the key missing
    // rather than explicitly empty.
    assert.equal(outputInfo({ output_id: "o1" }).zone_id, null);
    assert.equal(outputInfo({ output_id: "o1", display_name: undefined }).display_name, "");
  });
});
