"use strict";
// ---------------------------------------------------------------------------
// v1.7.38: the background work after a sync runs ONE AT A TIME.
//
// The art prewarm, the genre walk and the streaming refresh used to be three
// fire-and-forget kicks issued together. The total number of Roon calls was
// never the problem — the BURST was. All of it shares one multiplexed Core
// websocket with browse and transport, so three jobs starting at once is a
// spike the Core feels while somebody is trying to play something.
//
// The properties worth pinning are the ones that are invisible when they break:
//
//   1. ORDER AND EXCLUSIVITY. "Serialised" means step 2 does not begin until
//      step 1 has RESOLVED. An `await` accidentally dropped from one line still
//      runs all three and still finishes — it just goes back to bursting, and
//      nothing about the result would look different.
//   2. ONE FAILURE MUST NOT CANCEL THE REST. These are independent jobs. A
//      Rescan that silently did one of its three because the first threw is
//      worse than one that says which part failed.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

// A job that records when it starts and finishes, so overlap is detectable.
// Real concurrency, not a counter: each job yields to the event loop, which is
// exactly what a parallel kick would do.
function tracker() {
  const log = [];
  let live = 0, maxLive = 0;
  const job = (name, opts) => async () => {
    opts = opts || {};
    live++; maxLive = Math.max(maxLive, live);
    log.push("start:" + name);
    // Two turns of the event loop. One is enough for a dropped await to
    // interleave; two makes it certain.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    live--;
    log.push("end:" + name);
    if (opts.throws) throw new Error(name + " exploded");
  };
  return { log, job, maxLive: () => maxLive };
}

// bgRun is EXTRACTED, never stubbed. It is the thing under test: a stub that
// simply awaited its callback would pass every assertion below while the
// shipping queue was broken, because "serialised" is exactly what bgRun
// provides and nothing else here does.
function build(t) {
  return loadIndexFunctions(["syncChain", "bgRun"], {
    DEBUG: false,
    console: { error: () => {}, log: () => {} },
    _bgTail: Promise.resolve(),
    kickSmartPicks: () => {},
    refreshStreamAlbumKeys: t.job("stream"),
    harvestAlbumGenres:     t.job("genres"),
    prewarmAlbumArt:        t.job("art"),
  });
}

test("syncChain runs the post-rebuild jobs one at a time", async (t) => {
  await t.test("nothing overlaps", async () => {
    const tr = tracker();
    await build(tr).syncChain();
    assert.equal(tr.maxLive(), 1,
      "two jobs were in flight at once — that is the burst this exists to stop");
  });

  await t.test("each job finishes before the next begins", async () => {
    // maxLive alone would pass if a job were awaited but started early, so the
    // start/end interleaving is asserted directly.
    const tr = tracker();
    await build(tr).syncChain();
    assert.deepEqual(tr.log, [
      "start:stream", "end:stream",
      "start:genres", "end:genres",
      "start:art",    "end:art",
    ]);
  });

  await t.test("the Smart Picks build is kicked LAST, and is not awaited", async () => {
    // v1.7.41. Two properties, both easy to lose.
    //
    // Last, because the stretch pick reads the genre weights the harvest above
    // produces — kicked first, a fresh pair would build its picks against an
    // empty genre table and have no outside band to draw from.
    //
    // Not awaited, because kickSmartPicks enqueues onto this same queue. An
    // `await` here would make syncChain wait for a job queued behind itself,
    // which never resolves.
    const tr = tracker();
    const kicks = [];
    const F = loadIndexFunctions(["syncChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      _bgTail: Promise.resolve(),
      kickSmartPicks: (why) => { kicks.push({ why, after: tr.log.slice() }); },
      refreshStreamAlbumKeys: tr.job("stream"),
      harvestAlbumGenres:     tr.job("genres"),
      prewarmAlbumArt:        tr.job("art"),
    });
    await F.syncChain();
    assert.equal(kicks.length, 1, "the picks build was never kicked after a sync");
    assert.ok(kicks[0].after.includes("end:genres"),
      "picks were kicked before the genre harvest finished — the stretch pick " +
      "would have no genre weights to choose an outside band from");
  });

  await t.test("the order is cheapest-to-the-Core first", async () => {
    // Streaming favourites cost the Core nothing at all (Qobuz/TIDAL HTTP) and
    // decide the source badges, so they finish first. The art prewarm is the
    // longest and the most patient — nothing is waiting on it — so it goes last.
    const tr = tracker();
    await build(tr).syncChain();
    const starts = tr.log.filter(x => x.startsWith("start:")).map(x => x.slice(6));
    assert.deepEqual(starts, ["stream", "genres", "art"]);
  });
});

test("one failing job does not cancel the others", async (t) => {
  await t.test("a throw in the first step still runs the rest", async () => {
    const tr = tracker();
    const F = loadIndexFunctions(["syncChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      // The queue tail. Injected as a parameter so each test gets its OWN
      // queue — bgRun assigns to this binding, and a shared one would let a
      // previous test's jobs order the next one's.
      _bgTail: Promise.resolve(),
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream", { throws: true }),
      harvestAlbumGenres:     tr.job("genres"),
      prewarmAlbumArt:        tr.job("art"),
    });
    await F.syncChain();
    assert.ok(tr.log.includes("end:genres"), "the genre walk was skipped by an unrelated failure");
    assert.ok(tr.log.includes("end:art"),    "the art prewarm was skipped by an unrelated failure");
  });

  await t.test("a throw in the middle step still runs the last", async () => {
    const tr = tracker();
    const F = loadIndexFunctions(["syncChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      // The queue tail. Injected as a parameter so each test gets its OWN
      // queue — bgRun assigns to this binding, and a shared one would let a
      // previous test's jobs order the next one's.
      _bgTail: Promise.resolve(),
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream"),
      harvestAlbumGenres:     tr.job("genres", { throws: true }),
      prewarmAlbumArt:        tr.job("art"),
    });
    await F.syncChain();
    assert.ok(tr.log.includes("end:art"));
  });

  await t.test("syncChain itself never rejects", async () => {
    // It is called fire-and-forget from buildAlbumIndex. A rejection escaping
    // here would be an unhandled promise rejection, which in Node ends the
    // process — taking the extension down over a failed thumbnail fetch.
    const tr = tracker();
    const F = loadIndexFunctions(["syncChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      // The queue tail. Injected as a parameter so each test gets its OWN
      // queue — bgRun assigns to this binding, and a shared one would let a
      // previous test's jobs order the next one's.
      _bgTail: Promise.resolve(),
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream", { throws: true }),
      harvestAlbumGenres:     tr.job("genres", { throws: true }),
      prewarmAlbumArt:        tr.job("art",    { throws: true }),
    });
    await assert.doesNotReject(() => F.syncChain());
  });
});

// ---------------------------------------------------------------------------
// The Rescan button's chain — same shape, different order and one forced flag.
// ---------------------------------------------------------------------------
test("rescanChain serialises the Rescan button's background work", async (t) => {
  function buildRescan(tr, capture) {
    return loadIndexFunctions(["rescanChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      // The queue tail. Injected as a parameter so each test gets its OWN
      // queue — bgRun assigns to this binding, and a shared one would let a
      // previous test's jobs order the next one's.
      _bgTail: Promise.resolve(),
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream"),
      harvestAlbumGenres: async (reason, force) => {
        if (capture) capture.push({ reason, force });
        return tr.job("genres")();
      },
      runLabelsIndexScan: async (force) => {
        if (capture) capture.push({ labelsForce: force });
        return tr.job("labels")();
      },
    });
  }

  await t.test("nothing overlaps, and the label scan goes last", async () => {
    const tr = tracker();
    await buildRescan(tr).rescanChain({ status: "fresh" });
    assert.equal(tr.maxLive(), 1);
    assert.deepEqual(tr.log, [
      "start:stream", "end:stream",
      "start:genres", "end:genres",
      "start:labels", "end:labels",
    ]);
  });

  await t.test("the genre harvest is FORCED from the button", async () => {
    // Rescan is the button somebody presses precisely when the Genre facet
    // looks wrong. Letting the importing-check defer it would make the button
    // appear to do nothing at exactly the moment it is needed.
    const capture = [];
    await buildRescan(tracker(), capture).rescanChain({ status: "fresh" });
    const g = capture.find(c => c.reason);
    assert.ok(g, "the genre harvest was never called");
    assert.equal(g.force, true);
    const l = capture.find(c => "labelsForce" in c);
    assert.equal(l.labelsForce, true, "the label scan is forced for the same reason");
  });

  await t.test("a failing step does not cancel the rest, and it never rejects", async () => {
    const tr = tracker();
    const F = loadIndexFunctions(["rescanChain", "bgRun"], {
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      // The queue tail. Injected as a parameter so each test gets its OWN
      // queue — bgRun assigns to this binding, and a shared one would let a
      // previous test's jobs order the next one's.
      _bgTail: Promise.resolve(),
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream", { throws: true }),
      harvestAlbumGenres:     tr.job("genres"),
      runLabelsIndexScan:     tr.job("labels"),
    });
    await assert.doesNotReject(() => F.rescanChain({ status: "fresh" }));
    assert.ok(tr.log.includes("end:labels"));
  });
});

// ---------------------------------------------------------------------------
// THE ONE THAT MATTERS.
//
// Serialising each chain internally is not enough, and the first attempt at
// this shipped exactly that mistake. A manual Rescan starts rescanChain AND
// forces a rebuild, whose buildAlbumIndex starts syncChain — so both chains ran
// side by side, putting the genre walk and the art prewarm, the two most
// expensive jobs here, on the Core simultaneously. Every per-chain assertion
// above passed while that was true.
// ---------------------------------------------------------------------------
test("two chains at once still means one job at a time", async (t) => {
  await t.test("a Rescan overlapping a rebuild never runs two jobs together", async () => {
    const tr = tracker();
    // ONE shared tail, exactly as the module has — this is what makes the two
    // chains queue behind each other instead of racing.
    const shared = { _bgTail: Promise.resolve() };
    const F = loadIndexFunctions(["syncChain", "rescanChain", "bgRun"], Object.assign({
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream"),
      harvestAlbumGenres:     tr.job("genres"),
      prewarmAlbumArt:        tr.job("art"),
      runLabelsIndexScan:     tr.job("labels"),
    }, shared));

    // Both kicked without awaiting the first, which is what the rescan route
    // and buildAlbumIndex actually do.
    await Promise.all([F.syncChain(), F.rescanChain({ status: "rebuilt" })]);

    assert.equal(tr.maxLive(), 1,
      "two jobs overlapped across the two chains — per-chain serialising is " +
      "not enough, which is the bug this test exists for");
    // All six jobs ran; none was lost to the interleaving.
    assert.equal(tr.log.filter(x => x.startsWith("start:")).length, 6);
    // …and every start is immediately followed by its own end.
    for (let i = 0; i < tr.log.length; i += 2) {
      assert.equal(tr.log[i].replace("start:", ""), tr.log[i + 1].replace("end:", ""),
        "a job was interrupted by another: " + JSON.stringify(tr.log));
    }
  });

  await t.test("a job that rejects does not poison the queue behind it", async () => {
    // bgRun assigns the caught promise back to the tail. If a rejection ever
    // reached the tail, every job queued afterwards would be skipped — the
    // whole background pipeline dead until restart, silently.
    const tr = tracker();
    const shared = { _bgTail: Promise.reject(new Error("poisoned")) };
    // Swallow the pre-rejected tail so Node doesn't flag it before we use it.
    shared._bgTail.catch(() => {});
    const F = loadIndexFunctions(["syncChain", "bgRun"], Object.assign({
      DEBUG: false,
      console: { error: () => {}, log: () => {} },
      kickSmartPicks: () => {},
      refreshStreamAlbumKeys: tr.job("stream"),
      harvestAlbumGenres:     tr.job("genres"),
      prewarmAlbumArt:        tr.job("art"),
    }, shared));
    await assert.doesNotReject(() => F.syncChain());
    assert.equal(tr.log.filter(x => x.startsWith("start:")).length, 3,
      "jobs queued behind a rejected tail were never run");
  });
});
