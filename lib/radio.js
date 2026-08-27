// lib/radio.js — pure decision for the Random Album Radio.
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.
//
// Given a Roon zone object and whether radio is enabled for it, decide what to
// do: "queue" (append the next random album, gaplessly, while the last track
// plays), "play" (start a fresh random album because the zone is idle/empty),
// or null (do nothing). Kept pure so it can be unit-tested without Roon.

// How full the queue has to get before the next album is appended. Two, not
// one: the append is not instant — it is eight sequential Roon browse calls
// (navigate, locate, drill, load, drill the play menu, load it, invoke) with
// no parallelism — and if it lands after the audio runs out, the album arrives
// in a queue that has already stopped. One track of headroom was the whole
// budget; two costs nothing, because "queue" only ever APPENDS.
function radioQueueFloor() { return 2; }

function radioDecision(zone, enabled) {
  if (!zone || !enabled) return null;
  if (zone.settings && zone.settings.auto_radio) return null; // Roon Radio is handling it

  const remaining = zone.queue_items_remaining;
  const state = zone.state;

  if (state === "playing" || state === "loading") {
    if (Number.isFinite(remaining) && remaining <= radioQueueFloor()) return "queue";
    return null;
  }
  if (state === "stopped") {
    // "play" REPLACES the queue (Roon's Play Now action), so it may only be
    // returned on positive evidence that there is nothing to replace.
    //
    // `queue_items_remaining` is optional in Roon's transport payload, and an
    // absent field means "the Core didn't say", not "the queue is empty".
    // Treating the two as the same is the error class this project has already
    // been bitten by twice — v1.7.1 documented it as «"Unknown" read as
    // "none"» after an absent can_group_with_output_ids was read as "cannot
    // group". Here the cost would be somebody's queue wiped and a random album
    // started over it.
    // Number.isFinite, not typeof: NaN is a number and every comparison
    // against it is false, so a bare `remaining <= 0` reads NaN as "not
    // empty" while `remaining > 0` reads the same NaN as "not full". A value
    // that answers no to both questions is not a count.
    if (!Number.isFinite(remaining)) return null;
    if (remaining <= 0) return "play";
    return null;
  }
  return null; // paused, or unknown state — leave it alone
}

// Should the radio press PLAY on a queue that already has music in it?
//
// This is a third verb, and it is not "play". Roon's browse Play Now REPLACES
// a queue; the transport's play command RESUMES the one that is there. The
// difference is the whole reason this exists.
//
// The case it answers: the radio appended the next album during the last
// track, the append landed a moment after Roon had already run out of audio,
// and the zone is now stopped with our album sitting in it. Roon does not
// start playing again by itself, and radioDecision above will not touch a
// stopped zone that still has items — correctly, since its only start verb
// destroys queues. So the zone stays silent with a full queue, which is
// exactly what a user reported.
//
// `ep` is the episode: per-zone state the caller latches AT THE MOMENT the
// stop is observed, never re-derived afterwards. By the time the append lands
// the zone has been "stopped" for a while and the transition that authorises
// this is long gone, so asking later always answers false.
//
//   ep.strandedAt  — when this zone stopped WHILE our own append was in
//                    flight. Nothing else opens an episode, which is what
//                    keeps this to finishing what the extension started
//                    rather than overriding somebody's Stop.
//   ep.resumed     — a resume is issued or accepted. One at a time: an album
//                    that cannot play bounces straight back to stopped, and
//                    zone events arrive about once a second.
//   ep.resumeTries — attempts so far. A refusal is allowed to be transient
//                    (an output momentarily unavailable, a zone mid-regroup),
//                    but a zone that will not start must not be asked forever.
function radioResumeMaxTries() { return 3; }

function radioResumeDecision(zone, enabled, ep) {
  if (!zone || !enabled) return false;
  // The same stand-down radioDecision makes. Roon Radio filling the queue
  // while this presses play is the two radios fighting over one zone, which
  // /api/zone-settings tells the user cannot happen.
  if (zone.settings && zone.settings.auto_radio) return false;
  if (!ep || !ep.strandedAt || ep.resumed) return false;
  if ((ep.resumeTries || 0) >= radioResumeMaxTries()) return false;
  if (zone.state !== "stopped") return false;
  // Roon says so itself when a zone cannot be started (no audio device, an
  // output in standby); pressing play anyway just logs an error.
  if (zone.is_play_allowed === false) return false;
  const remaining = zone.queue_items_remaining;
  // Absent is not "has items", the same rule the stopped branch above follows:
  // with nothing there this is not a resume, and radioDecision's "play" is the
  // right answer instead.
  if (!Number.isFinite(remaining) || remaining <= 0) return false;
  return true;
}

// Which radio has to be switched off when the other is turned on.
//
// Roon Radio and this app's Random Album Radio both answer one question — what
// plays when this zone's queue runs out — so only one can run. Two switches
// both reading ON, with one of them silently doing nothing, is the state this
// exists to prevent.
//
// A named decision rather than a line inside each route, because the rule is
// two-directional and implementing one direction while believing you have done
// both is the obvious way to get it wrong.
//
// `turningOn` is "own" (Random Album Radio) or "roon" (Roon Radio). Returns the
// radio to switch off, or null when nothing needs to change.
function radioToTurnOff(turningOn, roonRadioOn, ownRadioOn) {
  if (turningOn === "own")  return roonRadioOn ? "roon" : null;
  if (turningOn === "roon") return ownRadioOn  ? "own"  : null;
  // Turning either one OFF leaves the other alone: switching a radio off is
  // not a request to start the other one.
  return null;
}

module.exports = { radioDecision, radioResumeDecision, radioQueueFloor, radioResumeMaxTries,
                   radioToTurnOff };
