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
  const F = loadIndexFunctions(["roonBrowseError"], {});

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
    assert.ok(/your library has\s*"?\s*\+?\s*"?\s*changed since this list was built/.test(src),
      "the no-playback-options message no longer states the provable fact");
    // Scoped to the album-open message itself. Elsewhere the codebase DOES
    // say "Roon importing" — on the Roon Settings status line — and that one
    // is entitled to, because libraryIsImporting() actually observed a moving
    // count before it was set. The album-open path has no such evidence: it
    // has a count mismatch and nothing more.
    const at = src.indexOf("Roon offered no playback options for this album — your library has");
    assert.ok(at > 0, "the album-open message moved");
    const sentence = src.slice(at, at + 400);
    assert.ok(!/importing/i.test(sentence),
      "the album-open message asserts an import that nothing at that site observed");
    assert.match(sentence, /has\s*"?\s*\+?\s*"?\s*changed/,
      "the message stopped stating the change in the past tense");
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
