"use strict";
// ---------------------------------------------------------------------------
// What has already played, per zone.
//
// Roon's queue subscription reports the current track and what is coming; a
// track that has finished — or that you skipped past by picking something
// further down — is simply gone from it. `subscribe_queue` and `play_from_here`
// are the whole of the queue API, and neither can look backwards, so the queue
// screen had nothing to show for anything already played.
//
// The one place a departure can be observed is the zone push the extension is
// already handling: at a track change, the OUTGOING track and how much of it
// played are both known, and are known nowhere else afterwards. This module is
// the record built from those moments.
//
// It is deliberately NOT called a queue. It cannot be replayed as one (that
// would mean rebuilding the queue track by track through the browse hierarchy,
// which is hundreds of Core round trips), and it does not survive a restart.
// It is "what this zone played", in order, and the UI says so.
// ---------------------------------------------------------------------------

// Per zone. Long enough to cover any listening session anyone scrolls back
// through, short enough that a zone left playing for a week cannot grow it
// without bound — this is in memory, and there is one of them per zone.
const HISTORY_MAX = 200;

// Did enough of this track play to count as having been listened to?
//
// The scrobbler's own rule, named once. The badge in the queue screen and the
// `completed` column in the plays table are the same judgement, and two copies
// of "30 seconds and half the track" would eventually disagree about what a
// skip is — with the screen saying one thing and the history another.
//
// 240s is the ceiling a long track needs: half of a 20-minute side is ten
// minutes, and nobody who listened for four is skipping it.
function playCounted(entry) {
  if (!entry) return false;
  const elapsed = Number(entry.elapsed) || 0;
  const duration = Number(entry.duration) || 0;
  return elapsed >= 30 && (elapsed >= duration * 0.5 || elapsed >= 240);
}

// One departed track, as the queue screen needs it.
//
// Returns null for anything with no title: a zone can report a now_playing with
// empty text (a stream mid-handshake, a zone waking), and a blank row in the
// fold-out is worse than a missing one.
function historyEntry(prev, now) {
  const track = String((prev && prev.track) || "").trim();
  if (!track) return null;
  return {
    track,
    artist:    String((prev && prev.artist) || ""),
    album:     String((prev && prev.album)  || ""),
    image_key: (prev && prev.image_key) || null,
    duration:  Number(prev && prev.duration) || 0,
    // Kept as well as `played` because it is what makes a skip legible — "0:12
    // of 4:03" says more than a badge, and the caller cannot recompute it.
    elapsed:   Math.max(0, Math.round(Number(prev && prev.elapsed) || 0)),
    played:    playCounted(prev),
    ts:        Number.isFinite(now) ? now : Date.now(),
  };
}

// Append a departure, oldest first, bounded.
//
// Returns the list so the caller can store it back without caring whether one
// already existed. Mutates in place when it can, because the caller holds the
// same array in a Map.
function pushHistory(list, entry, max) {
  const cap = Number.isFinite(max) && max > 0 ? max : HISTORY_MAX;
  const out = Array.isArray(list) ? list : [];
  if (!entry) return out;
  // Consecutive duplicates are not two plays. A zone can re-announce the same
  // now_playing with different text (line3 arriving late, a stream's metadata
  // settling), and the caller's own change test compares that text — so the
  // same track can present as a change twice in a row.
  const last = out[out.length - 1];
  if (last && last.track === entry.track && last.album === entry.album &&
      entry.ts - last.ts < 2000) {
    return out;
  }
  out.push(entry);
  // Oldest go first: the fold-out reads from the most recent backwards, so the
  // end of the list is the part anyone actually looks at.
  if (out.length > cap) out.splice(0, out.length - cap);
  return out;
}

// The newest `count` entries, newest FIRST — the order the fold-out shows them,
// reading up and away from the now-playing row.
function recentHistory(list, count) {
  if (!Array.isArray(list) || !list.length) return [];
  const n = Number.isFinite(count) && count > 0 ? count : list.length;
  return list.slice(Math.max(0, list.length - n)).reverse();
}

// How many tracks one selection may act on.
//
// Every track is a full browse navigation — roughly eight Core round trips — so
// twenty is already about a hundred and sixty. The cap is here to stop a tap
// from becoming minutes of Core traffic, not because anything breaks above it.
const MULTI_MAX = 20;

// PLAY NEXT STACKS, so the sends go out backwards.
//
// Roon's "Add Next" puts an item immediately after the CURRENT track. Issue it
// repeatedly and each new item lands in front of the last one, so sending
// A, B, C leaves the queue playing C, B, A. Sending them reversed is what makes
// them arrive in the order the user picked.
//
// THIS IS THE ONE THING IN THE FEATURE THAT COULD NOT BE VERIFIED WITHOUT A
// LIVE CORE. Last-in-first-out is how every player this behaves like treats
// "play next", but Roon could instead append to a "next" region and keep its
// own order — in which case the result comes out backwards and the fix is to
// return `list.slice()` here, with nothing else to change.
//
// It cannot be settled by probing, either: finding out costs a real insert, and
// the API has no verb to remove one again. So it is an assumption, in one
// place, named — rather than a reversal buried in a loop somewhere.
function playNextSendOrder(list) {
  return Array.isArray(list) ? list.slice().reverse() : [];
}

// "Add to end of queue" needs no such trick: appending preserves order by
// definition. Here anyway so both actions read from the same place and neither
// call site has to remember which one reverses.
function queueSendOrder(list) {
  return Array.isArray(list) ? list.slice() : [];
}

// The order to send `list` for `kind`, and nothing else decides it.
function sendOrderFor(kind, list) {
  return kind === "play_next" ? playNextSendOrder(list) : queueSendOrder(list);
}

module.exports = { HISTORY_MAX, MULTI_MAX, playCounted, historyEntry, pushHistory,
                   recentHistory, playNextSendOrder, queueSendOrder, sendOrderFor };
