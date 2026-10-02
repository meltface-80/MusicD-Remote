"use strict";
// ---------------------------------------------------------------------------
// v1.7.49: saying the true cause when Roon's library is changing, and not
// waiting twelve hours to notice.
//
// The reported symptom: adding albums to Roon (locally or through a streaming
// service) makes the extension show "no playback options available" and album
// track lists come back short or empty.
//
// THE REASON IT PERSISTED rather than clearing itself is the interesting part.
// The maintenance loop is a plain twelve-hour interval. When a tick found Roon
// mid-import it correctly declined to rebuild — and then returned, with nothing
// scheduled. The snapshot stayed stale until the NEXT tick, up to twelve hours
// after Roon had finished, and every album opened in between hit stale offsets.
// The manual Rescan button worked precisely because it forces past that gate,
// which is why it looked like the only cure.
//
// The messages are the other half. Three facts were being thrown away:
//   - Roon answers `action: "message"` with its own text and an `is_error`
//     flag when it wants to explain itself. Four sites threw that away and
//     raised "Unexpected browse action: message" instead.
//   - `nav.total`, Roon's live album count, is already fetched on every album
//     open and was discarded. Against the snapshot's count it PROVES the
//     library changed — for free, at the moment of failure.
//   - a browse level declares how many rows it holds, so a short read is
//     detectable rather than indistinguishable from a short album.
//
// What none of that proves is that an import is running RIGHT NOW. A count
// mismatch is past tense, and these tests pin that the wording stays past
// tense: claiming a live import we cannot observe would be a confident lie
// replacing a vague truth.
// ---------------------------------------------------------------------------

//
// v1.8.68 replaced the ten-minute watch and the five-minute recheck chain with
// the LIBRARY WATCH: looks every 30 s while someone has the app open, every 3
// minutes otherwise, every 20 s while a change settles, a diff-aware re-read
// once two looks agree, and the dependants coalesced. The tests for the chain
// it replaced went with it; the invariants they pinned that still apply —
// nothing stacks, nothing is abandoned, nothing is hammered, the wording
// quotes the clock it is really waiting on — are re-pinned against the watch.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource, extractNestedFunction } = require("../lib/extract");

// The functions libraryChangingAdvice reads its clocks from.
const ADVICE_CLOCKS = ["librarySettleMs", "libraryWatchActiveMs"];

test("Roon's own words are surfaced, not discarded", async (t) => {
  const F = loadIndexFunctions(["roonBrowseError", "libraryChangingAdvice", ...ADVICE_CLOCKS], {});

  await t.test("THE one: a message response carries Roon's text to the user", () => {
    const e = F.roonBrowseError(
      { action: "message", message: "Library is being updated", is_error: true }, "this album");
    assert.match(e.message, /Library is being updated/,
      "Roon explained itself and the explanation was thrown away");
    assert.equal(e.roonMessage, "Library is being updated");
    assert.equal(e.roonIsError, true);
  });

  await t.test("a Roon advisory is treated as transient, not as a server fault", () => {
    // `stale` is this codebase's "try again" contract — the route answers 409
    // rather than 500, and the client can say so honestly.
    const e = F.roonBrowseError({ action: "message", message: "Still loading" }, "x");
    assert.equal(e.stale, true);
  });

  await t.test("no message means no invented one, and no 409", () => {
    // A genuinely unexpected action is a bug, not a transient condition.
    // Flagging it stale would tell the user to retry something that will never
    // succeed.
    const e = F.roonBrowseError({ action: "action_list" }, "this album");
    assert.match(e.message, /unexpected/i);
    assert.match(e.message, /action_list/);
    assert.ok(!e.stale, "an unexplained response was presented as retryable");
    assert.equal(e.roonMessage, "");
  });

  await t.test("whitespace-only and absent messages are the same as none", () => {
    for (const body of [{ action: "message", message: "   " },
                        { action: "message" },
                        { action: "message", message: 42 },
                        null]) {
      const e = F.roonBrowseError(body, "x");
      assert.equal(e.roonMessage, "", JSON.stringify(body));
      assert.ok(!e.stale, JSON.stringify(body) + " was presented as retryable");
    }
  });
});

test("the watch follows Roon closely without hammering it (v1.8.68)", async (t) => {
  const F = loadIndexFunctions([
    "libraryWatchActiveMs", "libraryWatchIdleMs", "librarySettleMs", "librarySettleSlowMs",
    "librarySettleBackoffMs", "libraryClientWindowMs", "libraryVerifyMs", "libraryEvidenceGapMs",
    "libraryDependantsQuietMs", "libraryDependantsMaxWaitMs"], {});
  const CALLS_PER_LOOK = 3;   // browse + head + tail, count:1 each (libraryLook)

  await t.test("THE one: with the app open, a change is noticed in seconds, not minutes", () => {
    assert.ok(F.libraryWatchActiveMs() <= 60 * 1000,
      "the watch looks every " + F.libraryWatchActiveMs() / 1000 + " s while someone is using the " +
      "app — albums added in Roon stay at the wrong offsets that long, and every one of them " +
      "is an album that opens with 'your library changed' under it");
  });

  await t.test("…and the Core is not hammered for it", () => {
    // Watched: a few count:1 calls a minute, against the hundreds a Roon remote
    // makes scrolling one screen of albums.
    const perMin = CALLS_PER_LOOK * 60000 / F.libraryWatchActiveMs();
    assert.ok(F.libraryWatchActiveMs() >= 15 * 1000 && perMin <= 12,
      "a watched minute costs " + perMin + " Core calls — that is a probe storm");
    // Following an import: tighter, but still bounded, and it slows down.
    const settlePerMin = CALLS_PER_LOOK * 60000 / F.librarySettleMs();
    assert.ok(F.librarySettleMs() >= 10 * 1000 && settlePerMin <= 18,
      "following an import costs " + settlePerMin + " calls a minute against a Core that is " +
      "already busy importing");
    assert.ok(F.librarySettleMs() <= F.libraryWatchActiveMs(),
      "a change being followed is looked at LESS often than an unchanged library");
    assert.ok(F.librarySettleSlowMs() >= 60 * 1000 && F.librarySettleBackoffMs() <= 30 * 60 * 1000,
      "an import that runs for hours is probed at the settling pace for ever");
  });

  await t.test("nobody looking: slower, but still minutes rather than hours", () => {
    assert.ok(F.libraryWatchIdleMs() >= 60 * 1000 && F.libraryWatchIdleMs() <= 10 * 60 * 1000,
      "the unwatched look runs every " + F.libraryWatchIdleMs() / 60000 + " min");
  });

  await t.test("'someone is looking' outlasts the polls that say so", () => {
    // The app asks /api/live every 3 s; the wall display polls its zone every 2.
    assert.ok(F.libraryClientWindowMs() >= 10 * 1000 && F.libraryClientWindowMs() <= 5 * 60 * 1000);
  });

  await t.test("the dependants wait for quiet, and not for ever", () => {
    assert.ok(F.libraryDependantsQuietMs() >= F.librarySettleMs(),
      "the badge/genre/tag pass runs before a settling import can have settled");
    assert.ok(F.libraryDependantsMaxWaitMs() > F.libraryDependantsQuietMs() &&
              F.libraryDependantsMaxWaitMs() <= 60 * 60 * 1000,
      "an import that never stops never gets its badges");
  });

  await t.test("the whole-list re-read is occasional", () => {
    assert.ok(F.libraryVerifyMs() >= 10 * 60 * 1000 && F.libraryVerifyMs() <= 2 * 60 * 60 * 1000);
    assert.ok(F.libraryEvidenceGapMs() >= 30 * 1000,
      "a burst of album opens on a stale snapshot would re-walk the library back to back");
  });
});

test("everything that sees the library move hands it to the watch", async (t) => {
  // Not reachable from a unit test — these sites are async I/O against a live
  // Core — so they are asserted on the source.
  const src = indexSource();

  await t.test("declining to rebuild during an import asks the watch to follow it", () => {
    const branch = src.indexOf('return { status: "importing" };');
    assert.ok(branch > 0, "the importing branch moved");
    const window = src.slice(Math.max(0, branch - 900), branch);
    assert.ok(/requestLibraryLook\([^;]*librarySettleMs\(\)\)/.test(window),
      "the importing branch returns without handing the import to the watch — the snapshot " +
      "then stays stale until the next routine look, which is the v1.7.49 bug");
  });

  await t.test("an album open that sees the count move asks for a look now", () => {
    assert.ok(/if \(libraryMoved\) requestLibraryLook\([^;]*, 0\);/.test(src),
      "the free live-count signal at album-open time is not being acted on at once");
  });

  await t.test("the open app and the wall display both count as someone looking", () => {
    for (const route of ['app.get("/api/live"', 'app.get("/api/zone-state"']) {
      const at = src.indexOf(route);
      assert.ok(at > 0, route + " moved");
      assert.ok(src.slice(at, at + 600).includes("noteLibraryClient()"),
        route + " does not tell the watch a client is there");
    }
  });
});

test("the wording claims only what can be proved", async (t) => {
  const src = indexSource();

  await t.test("the user-facing sentence is past tense about the library", () => {
    // A count mismatch shows the library CHANGED. It does not show an import
    // is running now — that costs four Core calls and a five-second sleep to
    // establish, which is not available on a play path. Saying "Roon is
    // importing" here would be a confident guess replacing an honest one.
    const F = loadIndexFunctions(["libraryChangingAdvice", ...ADVICE_CLOCKS], {});
    for (const sure of [true, false]) {
      const say = F.libraryChangingAdvice(sure);
      assert.match(say, /library changed after this list was built/,
        "the advice no longer states the provable fact (sure=" + sure + ")");
      // Elsewhere the codebase DOES say "Roon importing" — on the Roon Settings
      // status line — and that one is entitled to, because libraryIsImporting()
      // observed a moving count before it was set. This path has no such
      // evidence: a count mismatch and nothing more.
      assert.ok(!/\bis importing\b|\bis being imported\b/i.test(say),
        "the advice asserts a live import that nothing at this site observed");
    }
    // And the two confidence levels stay distinguishable: a proven change must
    // not be hedged, an unproven one must not be stated as fact.
    assert.ok(!/usually means/.test(F.libraryChangingAdvice(true)),
      "a PROVEN library change is hedged as if it were a guess");
    assert.match(F.libraryChangingAdvice(false), /usually means/,
      "an unproven cause is stated as established fact");
  });

  // v1.7.57: the symptom was all the user ever got.
  await t.test("every message on this path says why, what next, and the way out", () => {
    const F = loadIndexFunctions(
      ["libraryChangingAdvice", "roonBrowseError", "noActionError", ...ADVICE_CLOCKS], {});

    const shouldAdvise = [
      ["no playback options at all", F.noActionError("play", [], "this album").message],
      ["Roon's own advisory",
       F.roonBrowseError({ action: "message", message: "Library is being updated" }, "x").message],
    ];
    for (const [label, msg] of shouldAdvise) {
      assert.match(msg, /added or identified/,   label + ": does not say WHY");
      assert.match(msg, /every \d+ seconds/,     label + ": does not say what happens NEXT");
      assert.match(msg, /Rescan library/,
        label + ": leaves the user with no way out if the automatic check does not clear it");
    }

    // Two cases must NOT carry it — both would send the user to a Rescan that
    // cannot help, which is worse than saying nothing.
    const otherMenu = F.noActionError("play", [{ title: "Add to library" }], "this album").message;
    assert.ok(!/Rescan library/.test(otherMenu),
      "Roon offering a DIFFERENT menu is a real answer, not a library-change symptom");
    const bug = F.roonBrowseError({ action: "action_list" }, "x").message;
    assert.ok(!/Rescan library/.test(bug),
      "an unexpected browse action is a bug in this extension; a rescan cannot fix it");
  });

  await t.test("the two empty-action cases are told apart", () => {
    // "Roon gave us no menu" and "Roon gave us a menu without this verb" used
    // to share one string, with a dangling empty "Available:" list.
    assert.ok(src.includes("Roon offers no '"),
      "the has-a-menu-but-not-this-verb case lost its own wording");
    // The old string built an empty "Available: " list whenever Roon had
    // offered no menu at all. Four sites did it; one shared builder replaced
    // them, so the phrase should survive only in the comment explaining why.
    const uses = src.split("'. Available: ").length - 1;
    assert.equal(uses, 0, "the old dangling Available: list is still being built");
  });
});

// ---------------------------------------------------------------------------
// v1.8.68: the WATCH, driven rather than grepped.
//
// The loop that replaced the recheck chain is executed here with a fake clock
// and fake timers, so every branch of every step runs for real. The chain's own
// lessons are kept as assertions: one look pending ever (an album open during
// an import must not stack probes), an unanswered look asked again (not
// abandoned until the next routine look), and the import followed but not
// probed to death.
// ---------------------------------------------------------------------------
const settleMicrotasks = () => new Promise(r => setImmediate(r));

function watchHarness(opts) {
  opts = opts || {};
  const state = {
    clock: 10_000_000, timers: [], looks: [], walks: [],
    look: { changed: false, sig: "10|A|Z", total: 10 },
    walkStatus: "fresh", lookThrows: false,
    hold: null,          // a promise: the look stays in flight until it resolves
  };
  const F = loadIndexFunctions(
    ["libraryWatchTick", "libraryWatchStep", "armLibraryWatch", "requestLibraryLook",
     "libraryClientActive", "noteLibraryClient", "libraryWatchCadence",
     "libraryWatchActiveMs", "libraryWatchIdleMs", "librarySettleMs", "librarySettleSlowMs",
     "librarySettleBackoffMs", "libraryClientWindowMs", "libraryVerifyMs", "libraryEvidenceGapMs",
     "walkedWholeList"],
    {
      core: opts.unpaired ? null : {},
      albumIndex: { building: !!opts.building, count: 10, declared: 10 },
      _rebuildInFlight: !!opts.rebuilding,
      _watchTimer: null, _watchDueAt: 0, _watchPending: null, _watchLastLookAt: 0,
      _watchStepping: false, _watchAgainMs: -1, _watchEpisodeAt: 0, _watchLastChangeAt: 0,
      // A walk happened just now unless the test says otherwise, so the routine
      // re-read stays out of tests that are not about it.
      _watchLastWalkAt: opts.lastWalkAt !== undefined ? opts.lastWalkAt : 10_000_000,
      _watchWalkWanted: "",
      _libraryClientAt: opts.watched ? 10_000_000 : 0,
      _statusSync: "", pushStatus: () => {},
      DEBUG: false, console: { log() {}, error() {} },
      Date: { now: () => state.clock },
      setTimeout: (fn, ms) => {
        const t = { fn, ms, at: state.clock + ms, unref() {} };
        state.timers.push(t);
        return t;
      },
      clearTimeout: (t) => { const i = state.timers.indexOf(t); if (i >= 0) state.timers.splice(i, 1); },
      libraryLook: async (o) => {
        state.looks.push(o);
        if (state.hold) await state.hold;
        if (state.lookThrows) throw new Error("probe blip");
        return state.look;
      },
      libraryWalk: async (why) => { state.walks.push(why); return { status: state.walkStatus }; },
    });
  const h = {
    F, state,
    pending: () => state.timers.length,
    nextMs: () => (state.timers.length ? state.timers[0].ms : null),
    // Run the pending look at its due time, and let everything it awaits settle.
    step: async () => {
      assert.equal(state.timers.length, 1, "expected exactly one pending look");
      const t = state.timers.shift();
      state.clock = Math.max(state.clock, t.at);
      t.fn();
      for (let i = 0; i < 5; i++) await settleMicrotasks();
    },
    advance: (ms) => { state.clock += ms; },
    // Keep the client "there", the way the app's 3-second /api/live poll does.
    watched: () => F.noteLibraryClient(),
  };
  F.armLibraryWatch(1000);   // as startIndexMaintenance does
  return h;
}

test("the watch keeps asking at the right pace, and acts only on a settled change",
  async (t) => {
    const W = loadIndexFunctions(["libraryWatchActiveMs", "libraryWatchIdleMs",
      "librarySettleMs", "librarySettleSlowMs", "librarySettleBackoffMs"], {});

    await t.test("unchanged: the watched pace with someone there, the idle pace without", async () => {
      const on = watchHarness({ watched: true });
      await on.step();
      assert.equal(on.state.looks.length, 1);
      assert.deepEqual(on.state.looks[0], { full: true, quiet: true },
        "the watch's look is not the full, quiet one — no settle signature, or a trace line every 30 s");
      assert.equal(on.nextMs(), W.libraryWatchActiveMs());
      const off = watchHarness();
      await off.step();
      assert.equal(off.nextMs(), W.libraryWatchIdleMs());
      assert.equal(off.state.walks.length + on.state.walks.length, 0, "an unchanged library was re-read");
    });

    await t.test("THE one: a change is re-read once two looks agree — not on first sight", async () => {
      const h = watchHarness({ watched: true });
      h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
      await h.step();
      assert.equal(h.state.walks.length, 0,
        "the library was re-walked the moment it moved — mid-import, that walk is stale before it finishes");
      assert.equal(h.nextMs(), W.librarySettleMs(), "a seen change is not followed closely");
      await h.step();
      assert.deepEqual(h.state.walks, ["Roon's library settled"],
        "two agreeing looks did not lead to a re-read — the snapshot stays stale after Roon settles");
      assert.equal(h.nextMs(), W.libraryWatchActiveMs(), "after the re-read the watch did not return to its pace");
    });

    await t.test("THE other one: a look brought forward cannot settle a change by itself", async () => {
      // Two looks a second apart agree about everything, mid-import included.
      const h = watchHarness({ watched: true });
      h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
      await h.step();
      h.F.armLibraryWatch(1000);                      // something pulled the next look in
      await h.step();
      assert.equal(h.state.walks.length, 0,
        "a change was called settled on two looks one second apart — the list was walked mid-import");
      assert.equal(h.nextMs(), W.librarySettleMs() - 1000, "the wait was not finished, or was restarted");
      await h.step();
      assert.deepEqual(h.state.walks, ["Roon's library settled"],
        "a picture held for the whole settle time was never acted on");
    });

    await t.test("the hold counts from the last CHANGE, not from the first", async () => {
      const h = watchHarness({ watched: true });
      h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
      await h.step();
      h.state.look = { changed: true, sig: "12|A|Z", total: 12 };
      await h.step();                                 // still moving
      h.F.armLibraryWatch(1000);
      await h.step();                                 // the same picture as one second ago
      assert.equal(h.state.walks.length, 0,
        "a picture one second old was called settled because the change BEGAN long enough ago");
    });

    await t.test("album opens during a settling change add no looks", async () => {
      const h = watchHarness({ watched: true });
      h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
      await h.step();
      for (let i = 0; i < 3; i++) h.F.requestLibraryLook("album open saw 11 albums", 0);
      assert.equal(h.pending(), 1);
      assert.equal(h.nextMs(), W.librarySettleMs(),
        "each album opened during an import pulled a look forward — a Core round trip per open, " +
        "telling the watch nothing it was not about to learn");
    });

    await t.test("a library still moving is followed, never re-read", async () => {
      const h = watchHarness({ watched: true });
      for (const n of [11, 12, 13, 14]) {
        h.state.look = { changed: true, sig: n + "|A|Z", total: n };
        await h.step();
        assert.equal(h.nextMs(), W.librarySettleMs());
      }
      assert.equal(h.state.walks.length, 0, "a still-moving library was re-walked");
    });

    await t.test("an import that runs on is followed less often, but never dropped", async () => {
      const h = watchHarness({ watched: true });
      let n = 11;
      const start = h.state.clock;
      while (h.state.clock - start <= W.librarySettleBackoffMs()) {
        h.state.look = { changed: true, sig: (n++) + "|A|Z", total: n };
        await h.step();
        h.watched();
      }
      assert.equal(h.nextMs(), W.librarySettleSlowMs(),
        "after " + W.librarySettleBackoffMs() / 60000 + " min of change the watch still probes every " +
        W.librarySettleMs() / 1000 + " s");
      assert.equal(h.pending(), 1, "a long import stopped being followed");
      assert.equal(h.state.walks.length, 0, "a library that never held still was walked");
    });

    await t.test("THE backoff outlives the walks an import is followed with", async () => {
      // An import in batches: each one settles, is walked, and the next one
      // arrives. Each walk used to start the next batch over at the fast pace,
      // so the backoff never engaged: a full walk — and every open screen
      // re-reading — about once a minute for as long as the import ran.
      const h = watchHarness({ watched: true });
      let n = 11;
      const start = h.state.clock;
      while (h.state.clock - start < W.librarySettleBackoffMs()) {
        h.state.look = { changed: true, sig: (n++) + "|A|Z", total: n };
        await h.step();                    // a new batch: followed
        await h.step();                    // it held: settled, walked
        h.watched();
      }
      assert.ok(h.state.walks.length >= 5, "precondition: the import was walked as it went");
      h.state.look = { changed: true, sig: (n++) + "|A|Z", total: n };
      await h.step();
      assert.equal(h.nextMs(), W.librarySettleSlowMs(),
        "ten minutes into an import, a new batch is still followed at the fast pace — the walks reset it");
      h.F.armLibraryWatch(W.librarySettleMs());
      await h.step();
      const walks = h.state.walks.length;
      assert.equal(h.nextMs(), W.librarySettleSlowMs() - W.librarySettleMs(),
        "the slow pace sets how often the watch LOOKS but not how long a picture must hold — a long " +
        "import is walked as often as ever");
      await h.step();
      assert.equal(h.state.walks.length, walks + 1);
    });

    await t.test("an import that has been quiet for the backoff starts over at the fast pace", async () => {
      const h = watchHarness({ watched: true });
      let n = 11;
      const start = h.state.clock;
      while (h.state.clock - start <= W.librarySettleBackoffMs()) {
        h.state.look = { changed: true, sig: (n++) + "|A|Z", total: n };
        await h.step();
        h.watched();
      }
      assert.equal(h.nextMs(), W.librarySettleSlowMs(), "precondition: the backoff engaged");
      await h.step();                      // the same picture: held, walked
      h.state.look = { changed: false, sig: (n - 1) + "|A|Z", total: n - 1 };
      h.advance(W.librarySettleBackoffMs());
      h.watched();
      await h.step();                      // quiet for the whole backoff
      h.state.look = { changed: true, sig: (n++) + "|A|Z", total: n };
      h.watched();
      await h.step();
      assert.equal(h.nextMs(), W.librarySettleMs(),
        "an album added hours after an import is followed at the slow pace the import earned");
    });

    await t.test("a look that fails is asked again soon, not abandoned", async () => {
      const h = watchHarness({ watched: true });
      h.state.lookThrows = true;
      await h.step();
      assert.equal(h.pending(), 1, "a failed look ended the watch");
      assert.equal(h.nextMs(), W.librarySettleMs());
    });

    await t.test("a failed re-read is retried by the next looks", async () => {
      // libraryWalk reports "error" and leaves the old snapshot — so the next
      // look still sees the change, waits for agreement, and walks again.
      const h = watchHarness({ watched: true });
      h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
      h.state.walkStatus = "error";
      await h.step(); await h.step();
      assert.equal(h.state.walks.length, 1);
      await h.step(); await h.step();
      assert.equal(h.state.walks.length, 2, "a re-read that failed was never tried again");
    });

    await t.test("it stands down while somebody else owns the library", async () => {
      for (const [label, opts] of [["a rebuild is in flight", { rebuilding: true }],
                                   ["the first build is running", { building: true }]]) {
        const h = watchHarness(Object.assign({ watched: true }, opts));
        await h.step();
        assert.equal(h.state.looks.length, 0, "the watch probed while " + label);
        assert.equal(h.nextMs(), W.librarySettleMs(), "the watch gave up while " + label);
      }
    });

    await t.test("unpaired, nothing runs and nothing re-arms", async () => {
      const h = watchHarness({ unpaired: true });
      await h.step();
      assert.equal(h.state.looks.length, 0);
      assert.equal(h.pending(), 0, "the watch re-armed itself without a Core");
    });
  });

test("only one look is ever pending, and asking can only bring it forward", async (t) => {
  await t.test("THE one: a look asked for while one is RUNNING waits for it", async () => {
    // The tick clears its timer before it awaits the look, so for the length of
    // the look nothing was pending — and a request then armed a second step
    // that ran alongside the first, both setting the same state.
    const h = watchHarness({ watched: true });
    let release;
    h.state.hold = new Promise(r => { release = r; });
    const first = h.state.timers.shift();
    h.state.clock = first.at;
    first.fn();
    await settleMicrotasks();
    h.F.requestLibraryLook("album open saw 11 albums", 0);
    h.F.requestLibraryLook("evidence", 0, true);
    assert.equal(h.pending(), 0, "a second look was armed while the first was still running");
    release();
    for (let i = 0; i < 5; i++) await settleMicrotasks();
    assert.equal(h.state.looks.length, 1, "two looks ran at once");
    assert.equal(h.pending(), 1);
    assert.equal(h.nextMs(), 0, "the look asked for meanwhile was dropped instead of taken next");
  });

  await t.test("…but not ahead of a change that look found settling", async () => {
    const W = loadIndexFunctions(["librarySettleMs"], {});
    const h = watchHarness({ watched: true });
    h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
    let release;
    h.state.hold = new Promise(r => { release = r; });
    const first = h.state.timers.shift();
    h.state.clock = first.at;
    first.fn();
    await settleMicrotasks();
    h.F.requestLibraryLook("album open saw 11 albums", 0);
    release();
    for (let i = 0; i < 5; i++) await settleMicrotasks();
    assert.equal(h.nextMs(), W.librarySettleMs());
  });

  await t.test("requests never stack", async () => {
    const h = watchHarness({ watched: true });
    h.F.requestLibraryLook("album open", 0);
    h.F.requestLibraryLook("album open", 0);
    h.F.requestLibraryLook("album open", 2000);
    assert.equal(h.pending(), 1, "every album open during an import armed another probe");
    assert.equal(h.nextMs(), 0);
  });

  await t.test("a later request never pushes an earlier look back", async () => {
    const h = watchHarness();          // pending at 1000 ms
    h.F.requestLibraryLook("re-pair", 5000);
    assert.equal(h.nextMs(), 1000, "a request delayed the look that was already due");
  });

  await t.test("a client arriving after a quiet spell is looked at at once — once", async () => {
    const h = watchHarness();
    h.F.armLibraryWatch(180000);
    h.F.noteLibraryClient();
    assert.ok(h.nextMs() <= 1000, "opening the app after a quiet spell waits for the idle look");
    h.F.armLibraryWatch(30000);
    h.F.noteLibraryClient();          // the next poll, 3 s later: not quiet any more
    assert.equal(h.nextMs(), 30000, "every poll from an open app pulled the look forward");
  });
});

test("what a look cannot see is re-read on evidence, and routinely", async (t) => {
  const W = loadIndexFunctions(["libraryVerifyMs", "libraryEvidenceGapMs", "libraryWatchActiveMs"], {});

  await t.test("THE one: a drifted offset gets a whole-list re-read even when the look says unchanged", async () => {
    const h = watchHarness({ watched: true, lastWalkAt: 0 });
    h.F.requestLibraryLook("album open found another record at offset 7", 0, true);
    await h.step();
    assert.equal(h.state.walks.length, 1,
      "a mid-list re-identification was reported and the list was not re-read — the head/tail " +
      "look can never see it");
    assert.equal(h.state.looks.length, 0);
  });

  await t.test("evidence cannot re-walk the library back to back", async () => {
    const h = watchHarness({ watched: true });        // walked just now
    h.F.requestLibraryLook("drift", 0, true);
    await h.step();
    assert.equal(h.state.walks.length, 0, "a second walk ran inside the evidence gap");
    h.advance(W.libraryEvidenceGapMs());
    h.watched();
    await h.step();
    assert.equal(h.state.walks.length, 1, "the evidence was dropped instead of waiting its turn");
  });

  await t.test("an evidence re-read that fails is kept and tried again, not dropped", async () => {
    // The settle path retries by itself — the next look still sees the count.
    // This one cannot: a mid-list change is invisible to a look, so a failed
    // walk that forgot its evidence would leave the change in the list until
    // somebody happened to open that album again.
    const h = watchHarness({ watched: true, lastWalkAt: 0 });
    h.state.walkStatus = "error";
    h.F.requestLibraryLook("album open found another record at offset 7", 0, true);
    await h.step();
    assert.equal(h.state.walks.length, 1);
    h.state.walkStatus = "fresh";
    await h.step();
    assert.deepEqual(h.state.walks, ["album open found another record at offset 7",
                                     "album open found another record at offset 7"],
      "the re-read failed and its evidence was forgotten — nothing else will ever ask again");
  });

  await t.test("evidence waits for a change that is already settling — that walk covers it", async () => {
    // lastWalkAt 0: the evidence gap is long past, so only the settling can
    // be what holds the evidence back.
    const h = watchHarness({ watched: true, lastWalkAt: 0 });
    h.state.look = { changed: true, sig: "11|A|Z", total: 11 };
    await h.step();                                   // a change seen: settling
    h.F.requestLibraryLook("album open found another record at offset 7", 0, true);
    await h.step();                                   // agrees: the settle walk
    assert.deepEqual(h.state.walks, ["Roon's library settled"],
      "evidence walked the list while Roon's count was still settling — a walk mid-import");
    h.state.look = { changed: false, sig: "11|A|Z", total: 11 };
    // A minute on, nobody watching (so no routine re-read): only evidence
    // that outlived the walk could walk again.
    h.advance(W.libraryEvidenceGapMs());
    await h.step();
    assert.equal(h.state.walks.length, 1,
      "the settle walk read the whole list and the evidence asked for it again anyway");
  });

  await t.test("while someone is looking, the list is re-read every libraryVerifyMs()", async () => {
    const h = watchHarness({ watched: true, lastWalkAt: 10_000_000 - W.libraryVerifyMs() });
    await h.step();
    assert.deepEqual(h.state.walks, ["routine check of the whole list"]);
    const idle = watchHarness({ lastWalkAt: 10_000_000 - W.libraryVerifyMs() });
    await idle.step();
    assert.equal(idle.state.walks.length, 0, "nobody is looking, and the library was walked anyway");
  });
});

// ---------------------------------------------------------------------------
// v1.8.68: an album open is the only thing that can see a mid-list change —
// the look compares the count and both ends, and an album re-identified in the
// middle moves neither. But a drifted offset is evidence about the SNAPSHOT
// only when the snapshot cannot place the album either; a tile left over from
// before the last re-read drifts too, and is not. Driven through the real
// loadAlbumSession up to the point it has decided, then stopped.
// ---------------------------------------------------------------------------
function openHarness(o) {
  const asked = [];
  const STOP = new Error("stop: past the drift handling");
  const X = { title: "Blue Lines", subtitle: "Massive Attack" };
  const OTHER = { title: "Bossanova", subtitle: "Pixies" };
  const F = loadIndexFunctions(["loadAlbumSession", "albumIdentityMatches", "normalize"], {
    navigateToAlbumList: async () => ({ hierarchy: "albums", total: o.total !== undefined ? o.total : 100 }),
    albumIndex: { count: 100, declared: 100 },
    // Roon has X at o.roonHas, and something else at every other offset.
    load: async (q) => ({ items: [q.offset === o.roonHas ? X : OTHER] }),
    // Where the SNAPSHOT puts X (-1: nowhere).
    relocateAlbumOffset: () => o.snapshotHas,
    findAlbumViaSearch: async () => (o.searchFinds ? { item: X, hierarchy: "browse" } : null),
    requestLibraryLook: (why, ms, walk) => asked.push({ why, ms, walk: !!walk }),
    browse: async () => { throw STOP; },
    roonBrowseError: () => STOP,
    DEBUG: false, console: { log() {}, warn() {}, error() {} },
  });
  return {
    asked,
    walks: () => asked.filter(a => a.walk),
    open: async (offset) => {
      try { await F.loadAlbumSession("sk", offset, null, X, "z1"); }
      catch (e) { if (e !== STOP && !e.stale) throw e; }
    },
  };
}

test("only an album the SNAPSHOT cannot place asks for the list to be re-read", async (t) => {
  await t.test("THE one: a mid-list change — the snapshot and Roon disagree, count unmoved", async () => {
    // The tile and the snapshot both say offset 40; Roon has moved X to 41.
    const h = openHarness({ roonHas: 41, snapshotHas: 40, searchFinds: true });
    await h.open(40);
    assert.equal(h.walks().length, 1,
      "a change only an album open can see was not reported — no look will ever find it");
  });

  await t.test("a stale TILE is not evidence: the snapshot already knows where the album went", async () => {
    // The tile is from before the last re-read (offset 40); the snapshot has
    // X at 41, and so does Roon. The snapshot is right — nothing to re-read.
    const h = openHarness({ roonHas: 41, snapshotHas: 41, searchFinds: true });
    await h.open(40);
    assert.deepEqual(h.walks(), [],
      "every stale tile after a library change asked for a full re-read of a snapshot that was " +
      "already current");
  });

  await t.test("not while the count is moving: the look follows that, and walks once it settles", async () => {
    const h = openHarness({ roonHas: 41, snapshotHas: 40, searchFinds: true, total: 103 });
    await h.open(40);
    assert.deepEqual(h.walks(), [], "an album open walked the list in the middle of an import");
    assert.equal(h.asked.length, 1, "the moved count was not handed to the watch at all");
    assert.equal(h.asked[0].ms, 0);
  });

  await t.test("an album the snapshot has but Roon no longer finds is evidence too", async () => {
    const h = openHarness({ roonHas: -1, snapshotHas: 40, searchFinds: false });
    await h.open(40);
    assert.equal(h.walks().length, 1, "the snapshot holds a removed album and nothing asked to re-read it");
  });

  await t.test("an album gone from Roon AND from the snapshot is not — they agree", async () => {
    const h = openHarness({ roonHas: -1, snapshotHas: -1, searchFinds: false });
    await h.open(40);
    assert.deepEqual(h.walks(), []);
  });

  await t.test("an album open where nothing moved asks for nothing", async () => {
    const h = openHarness({ roonHas: 40, snapshotHas: 40, searchFinds: true });
    await h.open(40);
    assert.deepEqual(h.asked, []);
  });
});

// ---------------------------------------------------------------------------
// v1.8.68: the re-read is diff-aware. Every walk the watch makes would
// otherwise move builtAt — and with it every live revision, so every open
// screen re-reads itself, and every per-snapshot cache is thrown away — for a
// library nobody touched.
// ---------------------------------------------------------------------------
function buildHarness(live, current, chainOpts) {
  const calls = { chain: 0, years: 0, ambiguous: 0, firstSeen: 0, credits: 0 };
  const reads = [];
  const albumIndex = Object.assign(
    { albums: [], count: 0, declared: 0, builtAt: 1000, progress: 0, building: null }, current);
  const F = loadIndexFunctions(["buildAlbumIndex", "sameAlbumList"], {
    albumIndex, SEARCH_PAGE: 2, DEBUG: false, console: { log() {}, error() {} },
    noteLibraryRead: (whole) => reads.push(whole),
    withBrowseSession: async (fn) => fn("k"),
    browse: async () => ({}),
    // `live.declared` lets a test have Roon declare more albums than it sends.
    load: async (o) => ({ list: { count: live.declared || live.length },
                          items: live.slice(o.offset, o.offset + o.count) }),
    indexRecord: (it, off) => ({ offset: off, title: it.title, subtitle: it.subtitle,
                                 image_key: it.image_key || null }),
    rebuildAmbiguousAlbumKeys: () => { calls.ambiguous++; },
    recordFirstSeenAlbums: () => { calls.firstSeen++; },
    rebuildCreditIdentities: () => { calls.credits++; },
    harvestAlbumYears: () => { calls.years++; },
    syncChain: async () => { calls.chain++; },
    Date: { now: () => 5000 },
  });
  return { F, albumIndex, calls, reads };
}
const rec = (i, t, a, k) => ({ offset: i, title: t, subtitle: a, image_key: k || null });

test("a re-read that finds nothing new publishes nothing", async (t) => {
  const LIVE = [{ title: "A", subtitle: "x" }, { title: "B", subtitle: "y" }, { title: "C", subtitle: "z" }];
  const SNAP = { albums: [rec(0, "A", "x"), rec(1, "B", "y"), rec(2, "C", "z")], count: 3, declared: 3 };

  await t.test("THE one: the same list leaves builtAt, and everything downstream, alone", async () => {
    const h = buildHarness(LIVE, SNAP);
    await h.F.buildAlbumIndex({ diff: true, chain: false });
    assert.equal(h.albumIndex.builtAt, 1000,
      "an unchanged library was republished — every open screen re-reads itself for nothing");
    assert.deepEqual(h.calls, { chain: 0, years: 0, ambiguous: 0, firstSeen: 0, credits: 0 });
  });

  await t.test("a new album, a renamed one, a moved row, a new cover: all published", async () => {
    const variants = {
      added:   LIVE.concat([{ title: "D", subtitle: "w" }]),
      renamed: [LIVE[0], { title: "B (Deluxe)", subtitle: "y" }, LIVE[2]],
      moved:   [LIVE[1], LIVE[0], LIVE[2]],
      cover:   [LIVE[0], Object.assign({ image_key: "new" }, LIVE[1]), LIVE[2]],
    };
    for (const [what, live] of Object.entries(variants)) {
      const h = buildHarness(live, SNAP);
      await h.F.buildAlbumIndex({ diff: true, chain: false });
      assert.equal(h.albumIndex.builtAt, 5000, "a " + what + " album was not published");
      assert.equal(h.calls.chain, 0, "chain:false still kicked the sync chain (" + what + ")");
      assert.equal(h.calls.years, 1, "the release years were not joined onto the new snapshot");
    }
  });

  await t.test("without diff — the manual Rescan — it always publishes and chains", async () => {
    const h = buildHarness(LIVE, SNAP);
    await h.F.buildAlbumIndex();
    assert.equal(h.albumIndex.builtAt, 5000);
    assert.equal(h.calls.chain, 1, "the manual path lost its sync chain");
  });

  await t.test("THE one: a short walk never replaces a complete snapshot on the watch's say-so", async () => {
    // Roon declares four albums and sends two pages' worth less: a holed
    // snapshot cannot see a same-count change, so publishing it would leave
    // the library blind until somebody pressed Rescan.
    const short = LIVE.slice(0, 2);
    short.declared = 4;
    const h = buildHarness(short, SNAP);
    await assert.rejects(h.F.buildAlbumIndex({ diff: true, chain: false }), /short read/);
    assert.equal(h.albumIndex.builtAt, 1000, "the short walk was published");
    assert.equal(h.albumIndex.count, 3, "the complete snapshot was replaced by a holed one");
    assert.deepEqual(h.reads, [], "a walk that failed was counted as a read of the library");
  });

  await t.test("a short walk still beats a snapshot that was holed already, and the Rescan's", async () => {
    const short = LIVE.slice(0, 2);
    short.declared = 4;
    const holed = buildHarness(short, { albums: [rec(0, "A", "x")], count: 1, declared: 3 });
    await holed.F.buildAlbumIndex({ diff: true, chain: false });
    assert.equal(holed.albumIndex.count, 2);
    const manual = buildHarness(short, SNAP);
    await manual.F.buildAlbumIndex();
    assert.equal(manual.albumIndex.count, 2, "a person pressed Rescan and got nothing");
  });

  await t.test("every walk that worked counts as one — the first build included", async () => {
    // The routine re-read runs libraryVerifyMs() after the last whole-list
    // walk. The first build is one; not counting it walked the library twice
    // on every restart.
    const same = buildHarness(LIVE, SNAP);
    await same.F.buildAlbumIndex({ diff: true, chain: false });
    const first = buildHarness(LIVE, { albums: [], count: 0, declared: 0 });
    await first.F.buildAlbumIndex();
    assert.deepEqual([same.reads, first.reads], [[true], [true]]);
  });
});

// ---------------------------------------------------------------------------
// v1.8.68: the dependants run ONCE per burst of change.
// ---------------------------------------------------------------------------
function dependantsHarness(opts) {
  opts = opts || {};
  // Not 0: the code reads a zero timestamp as "never", so a clock starting
  // there gives every first change a deadline of "unset" and hides whatever
  // depends on it having passed.
  const state = { clock: 1_000_000, timers: [], runs: [] };
  const F = loadIndexFunctions(
    ["scheduleLibraryDependants", "armLibraryDependants", "cancelLibraryDependants",
     "libraryDependantsQuietMs", "libraryDependantsMaxWaitMs"], {
      _dependantsTimer: null, _dependantsFirstAt: 0, core: opts.unpaired ? null : {},
      Date: { now: () => state.clock },
      setTimeout: (fn, ms) => { const t = { fn, ms, at: state.clock + ms, unref() {} }; state.timers.push(t); return t; },
      clearTimeout: (t) => { const i = state.timers.indexOf(t); if (i >= 0) state.timers.splice(i, 1); },
      runLibraryDependants: async (why) => { state.runs.push(why); },
      console: { error() {} },
    });
  return {
    F, state,
    fireDue: () => {
      const due = state.timers.filter(t => t.at <= state.clock);
      for (const t of due) { state.timers.splice(state.timers.indexOf(t), 1); t.fn(); }
    },
  };
}

test("the jobs built on the snapshot follow a change once, after it goes quiet", async (t) => {
  const D = loadIndexFunctions(["libraryDependantsQuietMs", "libraryDependantsMaxWaitMs"], {});

  await t.test("THE one: a burst of re-reads costs one pass", () => {
    const h = dependantsHarness();
    for (let i = 0; i < 5; i++) { h.F.scheduleLibraryDependants("settled"); h.state.clock += 30000; h.fireDue(); }
    assert.equal(h.state.runs.length, 0, "the badges/genres/file-tags pass ran in the middle of a burst");
    assert.equal(h.state.timers.length, 1, "the pass was armed more than once");
    h.state.clock += D.libraryDependantsQuietMs();
    h.fireDue();
    assert.deepEqual(h.state.runs, ["auto rescan"],
      "five re-reads cost " + h.state.runs.length + " passes — a /music walk each");
  });

  await t.test("a library that never goes quiet still gets its pass", () => {
    const h = dependantsHarness();
    const stepMs = Math.floor(D.libraryDependantsQuietMs() / 2);
    for (let t0 = 0; t0 <= D.libraryDependantsMaxWaitMs(); t0 += stepMs) {
      h.F.scheduleLibraryDependants("settled");
      h.state.clock += stepMs;
      h.fireDue();
    }
    assert.ok(h.state.runs.length >= 1,
      "an import that keeps re-settling postponed the pass for ever — new albums never get badges");
  });

  await t.test("with no Core it waits for one rather than running", () => {
    const h = dependantsHarness({ unpaired: true });
    h.F.scheduleLibraryDependants("settled");
    h.state.clock += D.libraryDependantsQuietMs();
    h.fireDue();
    assert.equal(h.state.runs.length, 0);
    assert.equal(h.state.timers.length, 1, "owed work was dropped on an unpair");
  });

  await t.test("THE one: a Core gone past the deadline is waited for, not spun on", async () => {
    // The deadline is fixed at the first change. Re-arming on it once it had
    // passed was a 0 ms timer, firing about every millisecond until a re-pair.
    const h = dependantsHarness({ unpaired: true });
    h.F.scheduleLibraryDependants("settled");
    h.state.clock += D.libraryDependantsMaxWaitMs() + 60000;
    for (let i = 0; i < 5; i++) h.fireDue();
    assert.equal(h.state.timers.length, 1);
    assert.ok(h.state.timers[0].ms >= D.libraryDependantsQuietMs(),
      "with the Core gone past the deadline the pass re-armed every " + h.state.timers[0].ms + " ms");
  });

  await t.test("a manual Rescan that rebuilt takes the owed pass with it", () => {
    const h = dependantsHarness();
    h.F.scheduleLibraryDependants("settled");
    h.F.cancelLibraryDependants();
    h.state.clock += D.libraryDependantsMaxWaitMs();
    h.fireDue();
    assert.deepEqual(h.state.runs, []);
    h.F.scheduleLibraryDependants("settled");         // a fresh burst gets a fresh deadline
    h.state.clock += D.libraryDependantsQuietMs();
    h.fireDue();
    assert.deepEqual(h.state.runs, ["auto rescan"]);
    const src = indexSource();
    const route = src.slice(src.indexOf('app.post("/api/library/rescan"'));
    assert.ok(/if \(r\.status === "rebuilt"\) cancelLibraryDependants\(\);/.test(route.slice(0, 1500)),
      "the Rescan button no longer stands the watch's pass down — the /music walk runs twice");
  });
});

// ---------------------------------------------------------------------------
// v1.7.54: "Roon has finished" is inferred, and the inference got two things
// wrong.
// ---------------------------------------------------------------------------
test("the import probe watches for identification, not just for growth", async (t) => {
  const src = indexSource();
  const fn = src.slice(src.indexOf("async function libraryIsImporting("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  await t.test("more than one settle window", () => {
    const F = loadIndexFunctions(["importSettleReads"], {});
    assert.ok(F.importSettleReads() >= 3,
      "the probe takes " + F.importSettleReads() + " samples, so it spans one " +
      "window. Roon imports in bursts, and any pause between bursts longer " +
      "than that window reads as finished — which is how a rebuild lands " +
      "halfway through an import");
  });

  await t.test("the sample carries identity, not only the count", () => {
    // Identification does not change the album count; it rewrites titles and
    // artists, which moves rows in an alphabetical list. The count alone can
    // only answer the "still adding" half of the user's question.
    assert.ok(/browseItemIdentity/.test(body),
      "libraryIsImporting compares nothing but the album count, so an import " +
      "that has finished ADDING but is still IDENTIFYING reads as settled");
    assert.ok(/offset: total - 1/.test(body),
      "only the head of the list is sampled — identification deep in the " +
      "library would never move it");
  });

  await t.test("that identity is the one the change probe uses", () => {
    // Shared, because the two probes ask questions whose answers must be
    // comparable: "is this the library we indexed" and "is this the library it
    // was five seconds ago". Two spellings of identity would make a
    // disagreement between them impossible to explain.
    const F = loadIndexFunctions(["browseItemIdentity"], {});
    assert.equal(F.browseItemIdentity({ title: "Rumours", subtitle: "Fleetwood Mac" }),
                 "Rumours||Fleetwood Mac");
    assert.equal(F.browseItemIdentity({ title: "Rumours" }), "Rumours||",
      "a missing artist must still produce a comparable value, not undefined");
    assert.equal(F.browseItemIdentity(null), "");
    // libraryChangedSince is a yes/no over libraryLook since v1.8.68, so the
    // identity it compares is libraryLook's.
    const look = src.slice(src.indexOf("async function libraryLook("));
    assert.ok(/browseItemIdentity/.test(look.slice(0, look.indexOf("\n}\n"))),
      "the change probe spells identity its own way again");
    const changed = src.slice(src.indexOf("async function libraryChangedSince("));
    assert.ok(/libraryLook\(/.test(changed.slice(0, changed.indexOf("\n}\n"))),
      "libraryChangedSince no longer goes through libraryLook — two probes, two ideas of identity");
  });
});

// ---------------------------------------------------------------------------
// v1.7.54: a rebuild that threw used to report success.
// ---------------------------------------------------------------------------
test("a failed rebuild is reported as a failure", async (t) => {
  const src = indexSource();

  await t.test("the catch records the failure instead of swallowing it", () => {
    const fn = src.slice(src.indexOf("async function checkAndMaybeRebuild("));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    assert.ok(/\.catch\(\(\) => \{ built = false; \}\)/.test(body),
      "buildAlbumIndex's rejection is discarded, so the old snapshot survives " +
      "and the caller is told 'rebuilt'");
    // The flag must track the SNAPSHOT and nothing else. Chaining the labels
    // map into the same promise as buildAlbumIndex makes a throw from
    // rebuildLabelsMap report a perfectly rebuilt snapshot as "error" — which
    // stops the dependants running and leaves every one of them stale, the
    // exact failure this version exists to fix.
    const build = body.indexOf("await buildAlbumIndex()");
    const labels = body.indexOf("rebuildLabelsMap()", build);
    assert.ok(build > 0 && labels > build, "the rebuild block moved");
    assert.ok(!body.slice(build, labels).includes(".then("),
      "rebuildLabelsMap is chained onto buildAlbumIndex's promise, so a failure " +
      "in the LABEL map is reported as a failed snapshot rebuild");
    assert.ok(/catch \(e\) \{ console\.error\("\[index\] labels map rebuild/.test(body),
      "a labels-map failure is now swallowed with no log at all");
    const failReturn = body.indexOf('if (!built) return { status: "error" };');
    const okReturn   = body.indexOf('return { status: "rebuilt"');
    assert.ok(failReturn > 0, "nothing acts on the failure");
    assert.ok(failReturn < okReturn,
      "the success return comes first, so a failed build still reports rebuilt");
  });

  // "error" re-arming the old chain is now "a failed re-read is retried by
  // the next looks", driven against the watch above.
});

// ---------------------------------------------------------------------------
// v1.7.54: an unpair clears whatever was pending. A re-pair has to look again.
// (v1.8.68: driven against startIndexMaintenance, with the watch it starts.)
// ---------------------------------------------------------------------------
function startHarness(built) {
  const seen = { looks: [], arms: [], builds: 0 };
  const F = loadIndexFunctions(["startIndexMaintenance"], {
    stopIndexMaintenance: () => {},
    _statusSync: "",
    isIndexBuilt: () => built,
    buildAlbumIndex: async () => { seen.builds++; },
    runFileMetadataScan: async () => {},
    seedLabelsFromCache: () => {},
    labelsEnabled: false, DEBUG: false, console: { log() {}, error() {} },
    _watchTimer: null,
    requestLibraryLook: (why, ms) => seen.looks.push({ why, ms }),
    armLibraryWatch: (ms) => seen.arms.push(ms),
    libraryWatchCadence: () => 30000,
  });
  F.startIndexMaintenance();
  return seen;
}

test("re-pairing with an existing snapshot looks again at once", async (t) => {
  await t.test("THE one: a re-pair asks within seconds", () => {
    const seen = startHarness(true);
    assert.equal(seen.looks.length, 1,
      "a re-pair with a snapshot already in memory asks nothing — an unpair dropped whatever the " +
      "watch was following, and a websocket flap is most likely during exactly that import");
    assert.ok(seen.looks[0].ms <= 10000, "the re-pair look waits " + seen.looks[0].ms + " ms");
    assert.equal(seen.builds, 0, "a re-pair re-walked the library instead of looking");
  });

  await t.test("a first pair builds, and the watch is started either way", () => {
    const first = startHarness(false);
    assert.equal(first.builds, 1);
    assert.equal(first.looks.length, 0, "a first pair asked for a look at a snapshot that does not exist yet");
    assert.ok(first.arms.length === 1 && startHarness(true).arms.length === 1,
      "startIndexMaintenance did not start the watch");
  });

  await t.test("the comment no longer claims a probe that does not exist", () => {
    assert.ok(!/re-verifies it on\s*\n?\s*\/\/\s*re-pair with a cheap 2-call probe/.test(indexSource()),
      "the unpair comment still describes a re-pair probe that was never written");
  });
});

// ---------------------------------------------------------------------------
// v1.7.55: the probe the ten-minute watch repeats had no test at all, and it
// carried the one bug that makes a frequent poll dangerous.
//
// buildAlbumIndex keeps TWO numbers: `count`, the albums that actually arrived
// after holes were filtered out, and `declared`, what Roon said the library
// held when the snapshot was taken. Its own comment says why:
//
//   "Comparing a live count against the filtered one would then report 'the
//    library moved' forever on a library that never changed — and every album
//    open would arm another full re-walk."
//
// loadAlbumSession was fixed for exactly that. This probe was not: it compared
// against `count`. At the old twelve-hour interval it cost two needless
// re-walks a day and went unnoticed for versions. At ten minutes it is a full
// library walk, a genre harvest and an art prewarm every ten minutes, forever,
// on a library nobody has touched — the watch would have been a self-inflicted
// denial of service on the Core.
// ---------------------------------------------------------------------------
function probeHarness(live, snapshot) {
  const loads = [];
  const reads = [];
  const F = loadIndexFunctions(["libraryChangedSince", "libraryLook", "browseItemIdentity"], {
    noteLibraryRead: (whole) => reads.push(whole),
    withBrowseSession: async (fn) => fn("k"),
    browse: async () => ({}),
    load: async (opts) => {
      loads.push(opts.offset);
      const it = live.albums[opts.offset];
      return { list: { count: live.total }, items: it ? [it] : [] };
    },
    albumIndex: snapshot,
  });
  return { F, loads, reads };
}
const al = (t, a) => ({ title: t, subtitle: a });

test("the change probe does not cry wolf at ten-minute intervals", async (t) => {
  await t.test("an unchanged library reports unchanged", async () => {
    const live = { total: 3, albums: [al("A", "x"), al("B", "y"), al("C", "z")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: live.albums.slice() });
    assert.equal(await h.F.libraryChangedSince(), false);
    assert.deepEqual(h.loads, [0, 2], "head and tail, three round-trips total");
  });

  await t.test("a changed count reports changed, and skips the tail read", async () => {
    const live = { total: 4, albums: [al("A", "x"), al("B", "y"), al("C", "z"), al("D", "w")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: live.albums.slice(0, 3) });
    assert.equal(await h.F.libraryChangedSince(), true);
    assert.deepEqual(h.loads, [0], "the tail was read even though the count already answered");
  });

  await t.test("THE one: a HOLED snapshot does not report changed forever", async () => {
    // Roon said 4, only 3 arrived, and the build filtered the hole out. The
    // library has not changed since. Comparing the live 4 against the filtered
    // 3 says "moved" — and says it again ten minutes later, and forever.
    const live = { total: 4, albums: [al("A", "x"), al("B", "y"), al("C", "z"), al("D", "w")] };
    const h = probeHarness(live, {
      count: 3, declared: 4, albums: [al("A", "x"), al("B", "y"), al("C", "z")],
    });
    assert.equal(await h.F.libraryChangedSince(), false,
      "a snapshot with holes reports the library moved on EVERY probe. At ten " +
      "minutes that is a full re-walk, a genre harvest and an art prewarm 144 " +
      "times a day against a library nobody touched");
  });

  await t.test("a holed snapshot still notices the count moving", async () => {
    // Bounded, not blind: it stops comparing identities, not counts.
    const live = { total: 9, albums: [al("A", "x")] };
    const h = probeHarness(live, { count: 3, declared: 4, albums: [al("A", "x")] });
    assert.equal(await h.F.libraryChangedSince(), true);
  });

  await t.test("a same-count swap at either end is still caught", async () => {
    // The identity reads are the only thing that can see a library whose album
    // count did not change — a replaced album, or one Roon re-identified.
    const first = { total: 3, albums: [al("NEW", "x"), al("B", "y"), al("C", "z")] };
    const hf = probeHarness(first, {
      count: 3, declared: 3, albums: [al("A", "x"), al("B", "y"), al("C", "z")] });
    assert.equal(await hf.F.libraryChangedSince(), true, "a changed FIRST album was missed");

    const last = { total: 3, albums: [al("A", "x"), al("B", "y"), al("NEW", "z")] };
    const hl = probeHarness(last, {
      count: 3, declared: 3, albums: [al("A", "x"), al("B", "y"), al("C", "z")] });
    assert.equal(await hl.F.libraryChangedSince(), true, "a changed LAST album was missed");
  });

  await t.test("an empty snapshot does not read a tail that isn't there", async () => {
    const h = probeHarness({ total: 0, albums: [] }, { count: 0, declared: 0, albums: [] });
    assert.equal(await h.F.libraryChangedSince(), false);
    assert.deepEqual(h.loads, [0]);
  });

  await t.test("a one-album library reads no tail", async () => {
    const live = { total: 1, albums: [al("A", "x")] };
    const h = probeHarness(live, { count: 1, declared: 1, albums: live.albums.slice() });
    assert.equal(await h.F.libraryChangedSince(), false);
    assert.deepEqual(h.loads, [0], "offset 0 was read twice as head and tail");
  });

  await t.test("a snapshot from before `declared` existed still works", async () => {
    // Records written by an older version have no `declared` field at all.
    const live = { total: 2, albums: [al("A", "x"), al("B", "y")] };
    const h = probeHarness(live, { count: 2, albums: live.albums.slice() });
    assert.equal(await h.F.libraryChangedSince(), false,
      "an upgraded install reports its library changed on every probe");
  });
});

// ---------------------------------------------------------------------------
// v1.7.58: the message quoted ONE interval, and there are two.
//
// They are different clocks and the difference is not cosmetic. A proven
// library change means the site that proved it has just asked the watch to
// look, and the watch then follows Roon every librarySettleMs() until it
// settles (v1.8.68; it was the five-minute recheck chain). An unproven one
// asked nothing, so the next look is the watch's own turn —
// libraryWatchActiveMs(), since someone reading the message has the app open.
// ---------------------------------------------------------------------------
test("the message quotes the clock it is actually waiting on", async (t) => {
  const F = loadIndexFunctions(["libraryChangingAdvice", ...ADVICE_CLOCKS], {});

  await t.test("a proven change says the re-read is under way, at the settling pace", () => {
    const secs = Math.round(F.librarySettleMs() / 1000);
    assert.match(F.libraryChangingAdvice(true), new RegExp("every " + secs + " seconds until it settles"),
      "a proven library change sets the watch following Roon every " + secs + " s, and the " +
      "message names a different number");
    assert.match(F.libraryChangingAdvice(true), /already re-reading/,
      "the message does not say the re-read is already on its way");
  });

  await t.test("an unproven one quotes the watch's own pace", () => {
    const secs = Math.round(F.libraryWatchActiveMs() / 1000);
    assert.match(F.libraryChangingAdvice(false), new RegExp("every " + secs + " seconds while the app is open"));
  });

  await t.test("THE one: they are not the same number", () => {
    assert.notEqual(F.librarySettleMs(), F.libraryWatchActiveMs(),
      "the two intervals are equal, so this distinction can be collapsed");
    assert.notEqual(F.libraryChangingAdvice(true), F.libraryChangingAdvice(false),
      "both cases quote the same wait — one of them is wrong");
  });

  await t.test("neither is hardcoded", () => {
    // A literal would drift the moment either constant is retuned, and nothing
    // would notice.
    const src = indexSource();
    const fn = src.slice(src.indexOf("function libraryChangingAdvice("));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    assert.ok(/librarySettleMs\(\)/.test(body) && /libraryWatchActiveMs\(\)/.test(body),
      "the intervals are written into the sentence as literals, so retuning " +
      "either constant silently makes the message lie");
  });

  await t.test("the client's copy says exactly what the server says", () => {
    // The album view composes three of these notes itself, from a copy of this
    // function that cannot read the server's constants — so it carries the
    // numbers as literals, and this is what keeps them true.
    const client = extractNestedFunction("public/app.js", "libraryChangingAdvice");
    for (const sure of [true, false]) {
      assert.equal(client(sure), F.libraryChangingAdvice(sure),
        "public/app.js and index.js no longer agree (sure=" + sure + ") — the album view " +
        "quotes a clock the server is not running");
    }
  });
});

test("the watch's look reads the whole signature", async (t) => {
  await t.test("THE one: full reads the last album even when the count has moved", async () => {
    // Without the tail, two looks agreeing on count and first album would call
    // the library settled while Roon is still re-identifying its end.
    const live = { total: 4, albums: [al("A", "x"), al("B", "y"), al("C", "z"), al("D", "w")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: live.albums.slice(0, 3) });
    const look = await h.F.libraryLook({ full: true });
    assert.equal(look.changed, true);
    assert.deepEqual(h.loads, [0, 3], "the watch's look skipped the last album");
    assert.equal(look.sig, "4|A||x|D||w");
  });

  await t.test("the yes/no form still stops at what answers it", async () => {
    const live = { total: 4, albums: [al("A", "x"), al("B", "y"), al("C", "z"), al("D", "w")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: live.albums.slice(0, 3) });
    assert.equal(await h.F.libraryChangedSince(), true);
    assert.deepEqual(h.loads, [0]);
  });

  await t.test("every answered look counts as a check — the manual one too", async () => {
    // "checked … ago" in the side menu reads the last answered look. The
    // Rescan button's check is a look like any other, and confirms as much.
    const live = { total: 3, albums: [al("A", "x"), al("B", "y"), al("C", "z")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: live.albums });
    await h.F.libraryChangedSince();
    await h.F.libraryLook({ full: true });
    assert.deepEqual(h.reads, [false, false], "a look at Roon's list did not note that it looked");
  });

  await t.test("a changed FIRST album answers without the last", async () => {
    const live = { total: 3, albums: [al("NEW", "x"), al("B", "y"), al("C", "z")] };
    const h = probeHarness(live, { count: 3, declared: 3, albums: [al("A", "x"), al("B", "y"), al("C", "z")] });
    assert.equal(await h.F.libraryChangedSince(), true);
    assert.deepEqual(h.loads, [0], "the last album was read after the first had already answered");
  });
});
