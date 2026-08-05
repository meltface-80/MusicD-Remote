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

const { zoneSettings, outputInfo, sourceControls, shouldRetryKeyless,
        roonErrorText, roonErrorPayload, controlStatusOf, keylessStandbyFallback } =
  loadIndexFunctions([
    "zoneSettings", "outputInfo", "sourceControls", "shouldRetryKeyless",
    "roonErrorText", "roonErrorPayload", "controlStatusOf", "keylessStandbyFallback",
  ]);

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
      { output_id: "o1", zone_id: "z1", display_name: "Kitchen",
        can_group_with_output_ids: ["o2", "o3"], source_controls: [] }
    );
  });

  await t.test("source controls ride along for the device-power sheet", () => {
    const out = outputInfo({
      output_id: "o1", display_name: "Amp",
      source_controls: [{ control_key: "1", display_name: "Roon", status: "selected", supports_standby: true }],
    });
    assert.deepEqual(out.source_controls, [
      { control_key: "1", display_name: "Roon", status: "selected", supports_standby: true },
    ]);
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

// A real WiiM/Linkplay endpoint answered a KEYED convenience_switch with
// SourceControlNotFound while reporting that very control_key to us in its own
// source_controls array — so the keyed form is not universally honoured by
// device-provided source controls. The fix retries as the keyless
// (all-controls) form, and these tests fence in when that is allowed.
test("shouldRetryKeyless only broadens the request when Roon lost the control", async (t) => {
  await t.test("SourceControlNotFound on a keyed call retries", () => {
    assert.equal(shouldRetryKeyless("SourceControlNotFound", true), true);
  });

  await t.test("a call that had no key never retries", () => {
    // It was already the keyless form — retrying would just repeat it.
    assert.equal(shouldRetryKeyless("SourceControlNotFound", false), false);
    assert.equal(shouldRetryKeyless("SourceControlNotFound", undefined), false);
    assert.equal(shouldRetryKeyless("SourceControlNotFound", ""), false);
  });

  await t.test("any other error does NOT retry", () => {
    // These mean Roon FOUND the control and refused on its own terms. Retrying
    // as a broadcast would then act on outputs the user never tapped — the one
    // genuinely harmful outcome available here.
    for (const name of ["NotAllowed", "OutputNotFound", "ZoneNotFound",
                        "InvalidRequest", "NetworkError", "", null, undefined]) {
      assert.equal(shouldRetryKeyless(name, true), false,
        `${JSON.stringify(name)} must not broaden the request`);
    }
  });

  await t.test("the return value is a real boolean", () => {
    assert.equal(typeof shouldRetryKeyless("SourceControlNotFound", "yes"), "boolean");
  });
});

// toggle_standby is the one power call with no documented keyless form, so a
// refused keyed toggle has no like-for-like retry — the fallback has to infer
// what the press MEANT. Getting this wrong powers a device the wrong way, which
// is the worst thing in this whole feature, so the unknown cases must refuse.
test("the keyless power fallback follows the intent, or refuses to guess", async (t) => {
  await t.test("a device in standby was asked to wake", () => {
    assert.equal(keylessStandbyFallback("standby"), "wake");
  });

  await t.test("a device that is on was asked to switch off", () => {
    assert.equal(keylessStandbyFallback("selected"), "standby");
    assert.equal(keylessStandbyFallback("deselected"), "standby");
  });

  await t.test("an unknown state refuses rather than picking a direction", () => {
    for (const s of ["indeterminate", null, undefined, "", "on", 1, {}]) {
      assert.equal(keylessStandbyFallback(s), null,
        `status ${JSON.stringify(s)} must not be guessed at`);
    }
  });

  await t.test("the two directions are never the same value", () => {
    // A mutation collapsing these would silently power everything one way.
    assert.notEqual(keylessStandbyFallback("standby"), keylessStandbyFallback("selected"));
  });
});

test("controlStatusOf reads the live status out of the raw cached output", async (t) => {
  const output = { source_controls: [
    { control_key: "1", status: "selected" },
    { control_key: "2", status: "standby" },
  ] };

  await t.test("it finds the right control, not just the first", () => {
    assert.equal(controlStatusOf(output, "1"), "selected");
    assert.equal(controlStatusOf(output, "2"), "standby");
  });

  await t.test("an unknown key yields null, so the caller refuses to guess", () => {
    assert.equal(controlStatusOf(output, "9"), null);
    assert.equal(controlStatusOf(output, undefined), null);
  });

  await t.test("a missing or malformed output does not throw", () => {
    // This runs on a failure path, where the cache may be anything at all.
    assert.equal(controlStatusOf(null, "1"), null);
    assert.equal(controlStatusOf({}, "1"), null);
    assert.equal(controlStatusOf({ source_controls: null }, "1"), null);
    assert.equal(controlStatusOf({ source_controls: "nope" }, "1"), null);
    assert.equal(controlStatusOf({ source_controls: [null, undefined] }, "1"), null);
  });

  await t.test("a control with no status reads as null, not undefined", () => {
    assert.equal(controlStatusOf({ source_controls: [{ control_key: "1" }] }, "1"), null);
  });
});

test("Roon's bare error names are turned into something a person can read", async (t) => {
  await t.test("SourceControlNotFound explains itself", () => {
    const p = roonErrorPayload("SourceControlNotFound");
    assert.notEqual(p.error, "SourceControlNotFound", "the raw name is not an explanation");
    assert.match(p.error, /device/i);
    // The raw name still travels, so a support log can identify the failure.
    assert.equal(p.roon_error, "SourceControlNotFound");
  });

  await t.test("every mapped name yields a sentence, not a symbol", () => {
    for (const name of ["SourceControlNotFound", "ZoneNotFound", "OutputNotFound",
                        "NotAllowed", "InvalidRequest", "NetworkError"]) {
      const text = roonErrorText(name);
      assert.ok(text, `${name} should map to a sentence`);
      assert.notEqual(text, name);
      assert.match(text, /[a-z] [a-z]/, `${name} maps to "${text}", which is not a sentence`);
    }
  });

  await t.test("an unmapped name passes through unchanged rather than being swallowed", () => {
    // Hiding an unknown failure behind a generic apology is how a new Roon
    // error becomes unreportable.
    assert.equal(roonErrorText("SomeFutureRoonError"), null);
    assert.deepEqual(roonErrorPayload("SomeFutureRoonError"),
      { error: "SomeFutureRoonError", roon_error: "SomeFutureRoonError" });
  });

  await t.test("a non-string error is still reported", () => {
    const p = roonErrorPayload({ weird: true });
    assert.equal(p.error, '{"weird":true}');
    assert.equal(p.roon_error, '{"weird":true}');
  });
});

test("sourceControls only returns controls we can actually act on", async (t) => {
  await t.test("an output with no source controls yields an empty list", () => {
    // Empty, never undefined: the sheet filters on .length and would throw.
    assert.deepEqual(sourceControls({ output_id: "o1" }), []);
    assert.deepEqual(sourceControls({ output_id: "o1", source_controls: null }), []);
    assert.deepEqual(sourceControls(null), []);
    assert.deepEqual(sourceControls({ source_controls: "nope" }), []);
  });

  await t.test("a control with no control_key is dropped", () => {
    // Roon's toggle_standby is defined per control. A keyless control would
    // render a Power button that silently does nothing at all.
    assert.deepEqual(
      sourceControls({ source_controls: [
        { display_name: "Anonymous", supports_standby: true },
        { control_key: "1", display_name: "Amp", supports_standby: true, status: "selected" },
      ] }),
      [{ control_key: "1", display_name: "Amp", status: "selected", supports_standby: true }]
    );
  });

  await t.test("an unrecognised status becomes indeterminate, not passed through", () => {
    // The sheet maps status to a sentence. An unknown value would render a
    // blank line that reads as "nothing here" rather than "state unknown".
    for (const bad of ["on", "OFF", "", null, 7, undefined]) {
      assert.equal(
        sourceControls({ source_controls: [{ control_key: "1", status: bad }] })[0].status,
        "indeterminate", `status ${JSON.stringify(bad)} should be indeterminate`);
    }
    for (const good of ["selected", "deselected", "standby"]) {
      assert.equal(
        sourceControls({ source_controls: [{ control_key: "1", status: good }] })[0].status, good);
    }
  });

  await t.test("supports_standby is coerced to a real boolean", () => {
    // The client decides whether to render a Power button from this; a truthy
    // string would render one on a device that cannot be powered.
    const cs = sourceControls({ source_controls: [
      { control_key: "1", supports_standby: 1 },
      { control_key: "2" },
    ] });
    assert.equal(cs[0].supports_standby, true);
    assert.equal(cs[1].supports_standby, false);
    assert.equal(typeof cs[1].supports_standby, "boolean");
  });

  await t.test("a control with no name of its own falls back to the output's", () => {
    assert.equal(
      sourceControls({ display_name: "Living Room", source_controls: [{ control_key: "1" }] })[0]
        .display_name, "Living Room");
    assert.equal(sourceControls({ source_controls: [{ control_key: "1" }] })[0].display_name, "");
  });
});
