"use strict";
// ---------------------------------------------------------------------------
// v1.7.48: the Home screen's rows became configurable, and two features became
// opt-in.
//
// The layout is stored as an ORDERED ARRAY of { id, on } rather than a set of
// booleans plus a separate order, because order and membership are one fact and
// splitting them across two settings is how they end up contradicting each
// other.
//
// The interesting behaviour is not storing it — it is repairing it. A stored
// layout outlives the version that wrote it: an update can remove a row (the
// stored id is now meaningless) or ADD one (an old layout has never heard of
// it). The second case is the dangerous one. A new row missing from the stored
// array must appear, switched on; if it defaulted to hidden, shipping a row
// would mean nobody with an existing install ever saw it, and the bug would
// look like "the feature didn't ship".
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

function load(stored) {
  return loadIndexFunctions(
    ["homeRowIds", "homeRowsDefault", "homeRowsLayout"],
    { loadPersistedSettings: () => (stored === undefined ? {} : { homeRows: stored }) });
}

test("the row vocabulary is one list", async (t) => {
  const F = load();

  await t.test("every default row is a known id, and every id has a default", () => {
    const ids = F.homeRowIds();
    const def = F.homeRowsDefault();
    assert.deepEqual(def.map(r => r.id), ids,
      "the default layout and the id list disagree — the settings page renders " +
      "from one and the server validates against the other");
    assert.ok(def.every(r => r.on === true), "a row shipped switched off by default");
  });

  await t.test("ids are unique", () => {
    const ids = F.homeRowIds();
    assert.equal(new Set(ids).size, ids.length);
  });

  await t.test("the rows the Home screen actually has are all present", () => {
    // Named explicitly rather than derived, so adding a row to the app without
    // adding it here is a failing test rather than a silent omission.
    for (const id of ["unplayed", "history", "picks", "random", "library", "lotw", "genres"]) {
      assert.ok(F.homeRowIds().includes(id), id + " is not in the row vocabulary");
    }
  });
});

test("a stored layout is repaired, never trusted", async (t) => {
  await t.test("with nothing stored, the default order stands", () => {
    assert.deepEqual(load().homeRowsLayout(), load().homeRowsDefault());
  });

  await t.test("a stored order is honoured", () => {
    const F = load([{ id: "random", on: true }, { id: "unplayed", on: false }]);
    const rows = F.homeRowsLayout();
    assert.equal(rows[0].id, "random");
    assert.equal(rows[1].id, "unplayed");
    assert.equal(rows[1].on, false);
  });

  await t.test("THE one: a row ADDED by an update appears, switched on", () => {
    // A layout written before the History row existed. If missing ids defaulted
    // to hidden, every existing install would ship the new row invisible and
    // the feature would look like it never landed.
    const F = load([{ id: "unplayed", on: true }, { id: "random", on: true }]);
    const rows = F.homeRowsLayout();
    const history = rows.find(r => r.id === "history");
    assert.ok(history, "a row absent from the stored layout vanished entirely");
    assert.equal(history.on, true, "a newly shipped row defaulted to hidden");
  });

  await t.test("stored rows keep their order; new ones are appended", () => {
    const F = load([{ id: "genres", on: true }, { id: "random", on: true }]);
    const rows = F.homeRowsLayout();
    assert.equal(rows[0].id, "genres");
    assert.equal(rows[1].id, "random");
    assert.equal(rows.length, F.homeRowIds().length, "the layout lost or gained a row");
  });

  await t.test("a row REMOVED by an update is dropped", () => {
    const F = load([{ id: "nosuchrow", on: true }, { id: "random", on: true }]);
    const rows = F.homeRowsLayout();
    assert.ok(!rows.some(r => r.id === "nosuchrow"));
    assert.equal(rows.length, F.homeRowIds().length);
  });

  await t.test("a duplicated id is kept once", () => {
    const F = load([{ id: "random", on: false }, { id: "random", on: true }]);
    const rows = F.homeRowsLayout();
    assert.equal(rows.filter(r => r.id === "random").length, 1);
    assert.equal(rows.find(r => r.id === "random").on, false, "the later duplicate won");
  });

  await t.test("junk is survived rather than thrown on", () => {
    // The file is on a data volume a user can edit, and a settings file that
    // crashes the Home screen is worse than one that is ignored.
    for (const junk of [null, "rows", 42, {}, [null], [{}], [{ id: 7 }], [{ id: "" }]]) {
      const rows = load(junk).homeRowsLayout();
      assert.equal(rows.length, load().homeRowIds().length, JSON.stringify(junk));
    }
  });

  await t.test("`on` is only false when it says so", () => {
    // Absent must read as ON: a row whose flag was never written is a row
    // nobody switched off.
    const F = load([{ id: "random" }, { id: "library", on: 0 }, { id: "lotw", on: false }]);
    const rows = F.homeRowsLayout();
    assert.equal(rows.find(r => r.id === "random").on, true);
    assert.equal(rows.find(r => r.id === "library").on, true, "a falsy-but-not-false value hid a row");
    assert.equal(rows.find(r => r.id === "lotw").on, false);
  });
});

test("the History window is bounded, and the bound is enforced by deletion", async (t) => {
  const F = loadIndexFunctions(["historyDays", "historyMaxTiles"], {});

  await t.test("thirty days, and a tile cap that cannot run away", () => {
    assert.equal(F.historyDays(), 30);
    assert.ok(F.historyMaxTiles() >= 10 && F.historyMaxTiles() <= 200,
      "a carousel builds one DOM node per tile — an unbounded count is a " +
      "phone rendering thousands of them");
  });
});

test("opt-in means the work does not run, not that the row is hidden",
  { concurrency: 1 }, async (t) => {
    // kickSmartPicks is the ONE funnel: the 10-minute timer, the post-sync
    // kick, the request path and the manual rebuild all come through it. One
    // check there covers every entry point, and none of them can drift.
    function picks(enabled, opts) {
      const o = opts || {};
      const ran = [];
      const F = loadIndexFunctions(["kickSmartPicks"], {
        smartPicksEnabled: enabled,
        smartDayKey: () => "2026-08-10",
        readSmartPicks: () => o.built || [],
        smartAttemptedToday: () => !!o.attempted,
        smartPicksDue: () => o.due !== false,
        buildSmartPicks: () => Promise.resolve(),
        bgRun: (name, fn) => { ran.push(name); return Promise.resolve().then(fn); },
        _smartBuilding: null,
      });
      return { F, ran };
    }

    await t.test("THE one: off means nothing is queued at all", () => {
      // Not "queued and then discarded" — a build that starts reaches
      // MusicBrainz, ListenBrainz and a streaming service, and can write
      // favourites into somebody's library. Off has to stop it before that.
      const p = picks(false);
      p.F.kickSmartPicks("scheduled");
      assert.deepEqual(p.ran, [], "a build was queued for a feature that is switched off");
    });

    await t.test("off beats even a forced rebuild", () => {
      // The rebuild button is reachable while the feature is off if any client
      // is showing a stale settings pane. `force` skips the schedule checks,
      // so it must not also skip the feature check.
      const p = picks(false);
      p.F.kickSmartPicks("manual", true);
      assert.deepEqual(p.ran, [], "force bypassed the on/off switch");
    });

    await t.test("on, and due, does queue a build", () => {
      // Mutation guard: a gate that always returned would pass every test above.
      const p = picks(true);
      p.F.kickSmartPicks("scheduled");
      assert.equal(p.ran.length, 1, "the feature is on and due but nothing ran");
    });

    await t.test("on but already built today stays quiet", () => {
      const p = picks(true, { built: [{ id: 1 }] });
      p.F.kickSmartPicks("requested");
      assert.deepEqual(p.ran, []);
    });

    await t.test("on but before the scheduled hour stays quiet", () => {
      const p = picks(true, { due: false });
      p.F.kickSmartPicks("requested");
      assert.deepEqual(p.ran, []);
    });
  });

// ---------------------------------------------------------------------------
// v1.7.59: a row whose FEATURE is off is not a layout choice.
//
// Switching Smart Picks off stopped the daily build but left the carousel on
// the Home screen, still showing the last day it produced — recommendations
// from a feature the user had switched off, frozen at the moment it stopped.
// Label of the week had the same shape: the route returns nothing with Labels
// off, so the row was simply an empty heading.
//
// The distinction that matters is between "unavailable" and "off". The stored
// `on` is the user's own choice and must survive untouched, so that switching
// the feature back on restores the Home screen they had rather than one this
// screen quietly rewrote for them.
// ---------------------------------------------------------------------------
test("a row whose feature is switched off reports itself unavailable", async (t) => {
  const build = (opts) => loadIndexFunctions(["homeRowUnavailable"], {
    smartPicksEnabled: opts.picks,
    labelsEnabled: opts.labels,
  });

  await t.test("Smart Picks off makes its row unavailable, and says why", () => {
    const F = build({ picks: false, labels: true });
    assert.match(F.homeRowUnavailable("picks"), /Smart Picks is off/,
      "the Smart Picks row stays on the Home screen after the feature is " +
      "switched off, showing the last day it built");
  });

  await t.test("Labels off does the same for Label of the week", () => {
    const F = build({ picks: true, labels: false });
    assert.match(F.homeRowUnavailable("lotw"), /Labels is off/);
  });

  await t.test("each switch governs only its own row", () => {
    const F = build({ picks: false, labels: true });
    assert.equal(F.homeRowUnavailable("lotw"), null,
      "switching Smart Picks off took Label of the week down with it");
    const G = build({ picks: true, labels: false });
    assert.equal(G.homeRowUnavailable("picks"), null,
      "switching Labels off took Smart Picks down with it");
  });

  await t.test("with both features on, nothing is unavailable", () => {
    const F = build({ picks: true, labels: true });
    for (const id of ["unplayed", "history", "picks", "random", "library", "lotw", "genres"]) {
      assert.equal(F.homeRowUnavailable(id), null, id + " reported unavailable");
    }
  });

  await t.test("the ordinary rows never depend on a feature switch", () => {
    // Whatever is switched off, these four have no feature behind them and
    // must always be the user's own choice.
    const F = build({ picks: false, labels: false });
    for (const id of ["unplayed", "history", "random", "library", "genres"]) {
      assert.equal(F.homeRowUnavailable(id), null,
        id + " became unavailable because an unrelated feature was switched off");
    }
  });
});
