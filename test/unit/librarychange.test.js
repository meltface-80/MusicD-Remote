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

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions, indexSource } = require("../lib/extract");

test("Roon's own words are surfaced, not discarded", async (t) => {
  const F = loadIndexFunctions(["roonBrowseError", "libraryChangingAdvice"], {});

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

test("the recheck closes the twelve-hour gap without hammering the Core", async (t) => {
  const F = loadIndexFunctions(["libraryRecheckMs", "libraryRecheckMax"], {});

  await t.test("minutes, not hours — and not seconds", () => {
    // Each recheck costs a 2-3 call probe, and if it proceeds a further read
    // with a five-second settle. Tight polling would put that on the Core for
    // the whole duration of an import.
    assert.ok(F.libraryRecheckMs() >= 60 * 1000,
      "the recheck polls faster than once a minute — that is a probe storm " +
      "against a Core that is already busy importing");
    assert.ok(F.libraryRecheckMs() <= 15 * 60 * 1000,
      "the recheck is slower than a quarter hour — the whole point is that a " +
      "finished import is noticed in minutes rather than half a day");
  });

  await t.test("chained rechecks are capped", () => {
    // A library that never settles would otherwise re-arm this forever.
    assert.ok(F.libraryRecheckMax() >= 2 && F.libraryRecheckMax() <= 200);
  });

  await t.test("the cap still covers a long import", () => {
    // The two numbers are a budget, and a budget that expires during an
    // ordinary large import would strand the snapshot exactly as before.
    const coverMs = F.libraryRecheckMs() * F.libraryRecheckMax();
    assert.ok(coverMs >= 60 * 60 * 1000,
      "the recheck budget runs out after " + Math.round(coverMs / 60000) +
      " minutes — a big streaming import outlasts that and the snapshot is " +
      "stranded again");
  });
});

test("the import branch actually schedules the recheck", async (t) => {
  // Not reachable from a unit test — checkAndMaybeRebuild is async I/O against
  // a live Core — so this is asserted on the source, like the Labels gate.
  const src = indexSource();

  await t.test("declining to rebuild during an import arms a recheck", () => {
    const branch = src.indexOf('return { status: "importing" };');
    assert.ok(branch > 0, "the importing branch moved");
    const window = src.slice(Math.max(0, branch - 900), branch);
    assert.ok(window.includes("scheduleLibraryRecheck("),
      "the importing branch returns without scheduling anything — the snapshot " +
      "then stays stale until the next twelve-hour tick, which is the whole bug");
  });

  await t.test("an album open that sees the library move arms one too", () => {
    assert.ok(src.includes("if (libraryMoved) scheduleLibraryRecheck("),
      "the free live-count signal at album-open time is not being acted on");
  });

  await t.test("only one recheck is ever pending", () => {
    const fn = src.slice(src.indexOf("function scheduleLibraryRecheck("));
    assert.ok(/if \(_libraryRecheckTimer\) return;/.test(fn.slice(0, 400)),
      "scheduleLibraryRecheck can stack timers — every album open during an " +
      "import would arm another");
  });
});

test("the wording claims only what can be proved", async (t) => {
  const src = indexSource();

  await t.test("the user-facing sentence is past tense about the library", () => {
    // A count mismatch shows the library CHANGED. It does not show an import
    // is running now — that costs four Core calls and a five-second sleep to
    // establish, which is not available on a play path. Saying "Roon is
    // importing" here would be a confident guess replacing an honest one.
    const F = loadIndexFunctions(["libraryChangingAdvice"], {});
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
      ["libraryChangingAdvice", "roonBrowseError", "noActionError"], {});

    const shouldAdvise = [
      ["no playback options at all", F.noActionError("play", [], "this album").message],
      ["Roon's own advisory",
       F.roonBrowseError({ action: "message", message: "Library is being updated" }, "x").message],
    ];
    for (const [label, msg] of shouldAdvise) {
      assert.match(msg, /added or identified/,   label + ": does not say WHY");
      assert.match(msg, /re-checks every 10 minutes/, label + ": does not say what happens NEXT");
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
// v1.7.54: the recheck EPISODE, driven rather than grepped.
//
// Everything above this line about scheduling is a substring search against
// index.js. That was enough to prove the v1.7.49 call site exists; it proved
// nothing about the loop it starts, which is the part that decides whether the
// feature still works on day thirty.
//
// It did not. `_libraryRecheckCount` was refilled ONLY by a recheck returning
// "fresh" — and once the count reached the cap, `scheduleLibraryRecheck`
// returned before arming anything, so no recheck could fire, so no "fresh"
// could ever arrive to refill it. The budget was global and was not refunded
// on "rebuilt" either, so roughly two dozen ordinary imports were enough to
// spend it. After that the fast path was dead for the lifetime of the
// container, silently: the twelve-hour tick kept running, so the only visible
// symptom was the original v1.7.49 complaint coming back.
//
// The fix is that an idle gap ends an episode. These tests drive the real
// function with a fake clock and a fake setTimeout, so every branch of the
// status dispatch is executed rather than matched as text.
// ---------------------------------------------------------------------------
function recheckHarness(opts) {
  opts = opts || {};
  const fired = [];          // pending timer callbacks, in order
  const chained = [];        // results handed to kickPostRebuildChain
  const state = { clock: opts.now || 1_000_000, next: "busy" };
  const F = loadIndexFunctions(
    ["scheduleLibraryRecheck", "libraryRecheckIdleMs"],
    {
      _libraryRecheckTimer: null,
      _libraryRecheckCount: 0,
      _libraryRecheckLast: 0,
      libraryRecheckMs: () => 1,
      // Small on purpose: the real 24 is range-checked above, and three makes
      // exhaustion legible here.
      libraryRecheckMax: () => 3,
      Date: { now: () => state.clock },
      setTimeout: (fn) => { fired.push(fn); return { unref() {} }; },
      console: { log() {}, error() {} },
      checkAndMaybeRebuild: async () => ({ status: state.next }),
      kickPostRebuildChain: (r) => chained.push(r && r.status),
    });
  return {
    fired, chained, state, idleMs: F.libraryRecheckIdleMs(),
    arm: (why) => F.scheduleLibraryRecheck(why || "test"),
    advance: (ms) => { state.clock += ms; },
    // Run the oldest pending callback and let its .then settle.
    fire: async (status) => {
      state.next = status;
      const fn = fired.shift();
      assert.ok(fn, "expected a pending recheck to fire, there was none");
      fn();
      await new Promise(r => setImmediate(r));
    },
  };
}

test("the recheck episode keeps asking, and stops asking, and starts again",
  async (t) => {
    await t.test("only one recheck is pending no matter how many arm it", async () => {
      // Every album open during an import calls this.
      const h = recheckHarness();
      h.arm(); h.arm(); h.arm();
      assert.equal(h.fired.length, 1);
    });

    await t.test("a check that could not answer is asked again", async () => {
      // "busy" means something else was already rebuilding; "error" means the
      // probe failed. Neither is an answer, and abandoning the question is the
      // v1.7.49 bug wearing a different hat.
      const h = recheckHarness();
      h.arm();
      await h.fire("busy");
      assert.equal(h.fired.length, 1, "a busy result ended the episode");
      await h.fire("error");
      assert.equal(h.fired.length, 1, "an error result ended the episode");
    });

    await t.test("the cap actually engages", async () => {
      const h = recheckHarness();
      h.arm();
      await h.fire("busy");    // 2nd armed
      await h.fire("busy");    // 3rd armed — budget of 3 now spent
      await h.fire("busy");
      assert.equal(h.fired.length, 0,
        "a library that never settles re-armed past the cap — that is a probe " +
        "every five minutes forever against a Core that is already struggling");
    });

    await t.test("a rebuild does NOT refill the budget", async () => {
      // Refilling on "rebuilt" is how the cap was made unreachable once before.
      const h = recheckHarness();
      h.arm();                 // 1 of 3
      await h.fire("rebuilt"); // episode ends here, but the unit stays spent
      h.arm();                 // 2 of 3
      await h.fire("busy");    // 3 of 3 — the budget is now gone
      await h.fire("busy");
      assert.equal(h.fired.length, 0,
        "a rebuild refunded a budget unit — with that refund the cap can never " +
        "engage, because any library whose count keeps moving rebuilds each " +
        "time and re-walks itself every five minutes forever");
    });

    await t.test("a settled library refills it", async () => {
      const h = recheckHarness();
      h.arm();
      await h.fire("fresh");
      // A full budget again: three more arm.
      h.arm();
      await h.fire("busy");
      await h.fire("busy");
      assert.equal(h.fired.length, 1, "'fresh' did not end the episode cleanly");
    });

    await t.test("THE one: an exhausted budget recovers on its own", async () => {
      // The permanent-death bug. Spend the budget, then come back after an
      // idle gap the way a real second import does, hours later.
      const h = recheckHarness();
      h.arm();
      await h.fire("busy");
      await h.fire("busy");
      await h.fire("busy");
      assert.equal(h.fired.length, 0, "precondition: the budget should be spent");

      h.advance(h.idleMs - 1);
      h.arm("still inside the episode");
      assert.equal(h.fired.length, 0,
        "the budget refilled while the episode was still running — the cap can " +
        "never engage if a gap shorter than the chain itself resets it");

      h.advance(2);
      h.arm("a new import, hours later");
      assert.equal(h.fired.length, 1,
        "the recheck budget never refilled. Once spent, scheduleLibraryRecheck " +
        "returns before arming anything, so no recheck can fire, so no 'fresh' " +
        "can arrive to refill it — the automatic rescan is dead for the life of " +
        "the container and every later import waits for the twelve-hour tick");
    });

    await t.test("the idle gap is longer than the chain it must not interrupt", () => {
      const F = loadIndexFunctions(["libraryRecheckMs", "libraryRecheckIdleMs"], {});
      assert.ok(F.libraryRecheckIdleMs() > F.libraryRecheckMs() * 2,
        "an episode re-arms every " + Math.round(F.libraryRecheckMs() / 60000) +
        " min but is considered over after " + Math.round(F.libraryRecheckIdleMs() / 60000) +
        " min of idle — a running episode would refill its own budget");
    });

    await t.test("a background rebuild drags its dependants with it", async () => {
      // Source badges, the Genre facet and the decade/quality data all sit on
      // top of the snapshot. Rebuilding the snapshot alone gives the user the
      // new albums wearing the old metadata, which reads as nothing happening.
      const h = recheckHarness();
      h.arm();
      await h.fire("rebuilt");
      assert.deepEqual(h.chained, ["rebuilt"],
        "the automatic rebuild stopped at the album snapshot — the streaming " +
        "favourites, genres and file tags were left stale until somebody " +
        "pressed Rescan by hand");
    });

    await t.test("and it kicks it WITHOUT force", async () => {
      // `force` means "a human insisted" in both scans the chain runs: it buys
      // past the libraryIsImporting() gate and turns the genre walk into a full
      // sweep. Carried onto the automatic path it would skip the import check
      // at the one moment Roon is most likely to still be identifying.
      const calls = [];
      const F = loadIndexFunctions(["kickPostRebuildChain"], {
        rescanChain: async (r, reason, force) => { calls.push({ reason, force }); },
        console: { error() {} },
      });
      F.kickPostRebuildChain({ status: "rebuilt" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].force, false,
        "the automatic post-import chain forces the genre sweep and the label " +
        "scan — both then skip the importing check and the genre walk re-walks " +
        "the whole library every time an import settles");
      assert.equal(calls[0].reason, "auto rescan",
        "the automatic run is indistinguishable from a button press in the log");

      calls.length = 0;
      for (const st of ["fresh", "busy", "error", "importing", undefined]) {
        F.kickPostRebuildChain(st ? { status: st } : null);
      }
      assert.equal(calls.length, 0, "a non-rebuild kicked a full rescan chain");
    });

    await t.test("nothing but a rebuild kicks that chain", async () => {
      for (const st of ["fresh", "busy", "error", "importing"]) {
        const h = recheckHarness();
        h.arm();
        await h.fire(st);
        assert.deepEqual(h.chained, [], st + " kicked a full rescan chain");
      }
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
    const changed = src.slice(src.indexOf("async function libraryChangedSince("));
    assert.ok(/browseItemIdentity/.test(changed.slice(0, changed.indexOf("\n}\n"))),
      "libraryChangedSince spells identity its own way again");
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
    // stops kickPostRebuildChain firing and leaves every dependant stale, the
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

  await t.test("'error' is one of the statuses that re-arms the chain", async () => {
    // Otherwise reporting the failure honestly would just end the episode
    // quietly instead of loudly, which is no better.
    const h = recheckHarness();
    h.arm();
    await h.fire("error");
    assert.equal(h.fired.length, 1);
  });
});

// ---------------------------------------------------------------------------
// v1.7.54: an unpair clears the pending recheck. A re-pair has to put one back.
// ---------------------------------------------------------------------------
test("re-pairing with an existing snapshot asks again", async (t) => {
  const src = indexSource();
  const fn = src.slice(src.indexOf("function startIndexMaintenance("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  await t.test("the else branch arms a recheck", () => {
    assert.ok(/\} else \{[\s\S]*scheduleLibraryRecheck\(/.test(body),
      "a re-pair with a snapshot already in memory schedules nothing. " +
      "stopIndexMaintenance() clears any pending recheck on unpair, and a " +
      "websocket flap is most likely during the very import that recheck was " +
      "waiting on — so the refresh silently drops back to the 12-hour tick");
  });

  await t.test("the comment no longer claims a probe that does not exist", () => {
    assert.ok(!/re-verifies it on\s*\n?\s*\/\/\s*re-pair with a cheap 2-call probe/.test(src),
      "the unpair comment still describes a re-pair probe that was never written");
  });
});

// ---------------------------------------------------------------------------
// v1.7.55: something has to NOTICE.
//
// v1.7.54 repaired the recheck chain — the loop that keeps asking once the
// library is known to have moved. It did not fix the thing in front of it. The
// only detector that fires within minutes is opportunistic: it rides along on
// `nav.total` when a user opens an album. On a box sitting idle, or one used
// only from Home and Now playing, it never fires at all, and the sole remaining
// detector was a TWELVE-HOUR interval.
//
// So "I added albums to Roon and the extension did nothing" was not an edge
// case, it was the normal experience, and every fix in v1.7.54 was downstream
// of a question nobody was asking. The periodic check is now ten minutes.
//
// The tick body lives inside a setInterval in startIndexMaintenance, so the
// test injects setInterval and captures the callback rather than asserting on
// the source text.
// ---------------------------------------------------------------------------
function watchHarness(opts) {
  opts = opts || {};
  const checks = [];        // {reason, force} handed to checkAndMaybeRebuild
  const armed = [];         // reasons handed to scheduleLibraryRecheck
  const chained = [];       // statuses handed to kickPostRebuildChain
  const timers = [];        // {fn, ms} handed to setInterval
  const state = { next: opts.status || "fresh" };
  const F = loadIndexFunctions(
    ["startIndexMaintenance", "libraryCheckMs"],
    {
      stopIndexMaintenance: () => {},
      _statusSync: "",
      isIndexBuilt: () => opts.built !== false,
      buildAlbumIndex: async () => {},
      runFileMetadataScan: async () => {},
      seedLabelsFromCache: () => {},
      labelsEnabled: false,
      DEBUG: false,
      console: { log() {}, error() {} },
      indexMaintTimer: null,
      // The three guards, each settable per harness so the skip can be tested.
      _libraryRecheckTimer: opts.recheckPending ? {} : null,
      _rebuildInFlight: !!opts.rebuilding,
      albumIndex: { building: !!opts.building, count: 10, builtAt: 1 },
      scheduleLibraryRecheck: (why) => armed.push(why),
      kickPostRebuildChain: (r) => chained.push(r && r.status),
      checkAndMaybeRebuild: async (reason, force) => {
        checks.push({ reason, force });
        return { status: state.next };
      },
      setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    });
  F.startIndexMaintenance();
  return {
    checks, armed, chained, timers, everyMs: F.libraryCheckMs(),
    tick: async () => {
      assert.equal(timers.length, 1, "expected exactly one maintenance timer");
      timers[0].fn();
      await new Promise(r => setImmediate(r));
    },
  };
}

test("something asks Roon on its own, often enough to matter", async (t) => {
  await t.test("THE one: the periodic check is minutes, not hours", () => {
    const F = loadIndexFunctions(["libraryCheckMs"], {});
    assert.ok(F.libraryCheckMs() <= 15 * 60 * 1000,
      "the only detector that needs no user interaction runs every " +
      Math.round(F.libraryCheckMs() / 60000) + " minutes. Adding albums to Roon " +
      "and having the extension notice cannot depend on somebody happening to " +
      "open an album — on an idle box that never happens, and this interval is " +
      "the whole detection time");
    assert.ok(F.libraryCheckMs() >= 2 * 60 * 1000,
      "polling the Core faster than every couple of minutes is a probe storm");
  });

  await t.test("the timer is armed at that interval", () => {
    const h = watchHarness();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, h.everyMs,
      "the maintenance timer does not run at libraryCheckMs — the constant and " +
      "the timer have drifted apart");
  });

  await t.test("a tick asks the real question", async () => {
    const h = watchHarness({ status: "fresh" });
    await h.tick();
    assert.equal(h.checks.length, 1, "the tick never checked anything");
    assert.equal(h.checks[0].force, false,
      "the periodic check FORCES a rebuild — it would re-walk the whole library " +
      "every ten minutes whether or not anything changed");
  });

  await t.test("a rebuild it causes drags its dependants with it", async () => {
    const h = watchHarness({ status: "rebuilt" });
    await h.tick();
    assert.deepEqual(h.chained, ["rebuilt"]);
  });

  await t.test("arming on start is the re-pair recheck, not the tick", () => {
    // Measured here so the hand-off test below can count the DELTA. With a
    // snapshot already in memory, startIndexMaintenance arms one recheck
    // because an unpair cleared any that was pending.
    const h = watchHarness();
    assert.deepEqual(h.armed, ["re-paired with an existing snapshot"]);
    const first = watchHarness({ built: false });
    assert.deepEqual(first.armed, [],
      "a FIRST pair armed a recheck — there is no snapshot to re-verify, the " +
      "initial build is already running");
  });

  await t.test("an unanswered check hands off instead of waiting a full tick", async () => {
    for (const st of ["busy", "error"]) {
      const h = watchHarness({ status: st });
      const before = h.armed.length;
      await h.tick();
      assert.equal(h.armed.length - before, 1,
        "a '" + st + "' tick lost the observation until the next tick");
    }
    const ok = watchHarness({ status: "fresh" });
    const before = ok.armed.length;
    await ok.tick();
    assert.equal(ok.armed.length - before, 0, "a settled check armed a pointless recheck");
  });

  await t.test("it stands down while somebody else owns the library", async () => {
    // Each of these means the question is already being asked, or answered.
    // Probing underneath only adds Roon calls to a Core that is working.
    for (const [label, opts] of [
      ["a recheck is pending", { recheckPending: true }],
      ["a rebuild is in flight", { rebuilding: true }],
      ["the index is building",  { building: true }],
    ]) {
      const h = watchHarness(opts);
      await h.tick();
      assert.equal(h.checks.length, 0, "the tick probed while " + label);
    }
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
  const F = loadIndexFunctions(["libraryChangedSince", "browseItemIdentity"], {
    withBrowseSession: async (fn) => fn("k"),
    browse: async () => ({}),
    load: async (opts) => {
      loads.push(opts.offset);
      const it = live.albums[opts.offset];
      return { list: { count: live.total }, items: it ? [it] : [] };
    },
    albumIndex: snapshot,
  });
  return { F, loads };
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
