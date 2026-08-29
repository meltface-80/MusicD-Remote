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

module.exports = { HISTORY_MAX, playCounted, historyEntry, pushHistory, recentHistory };
