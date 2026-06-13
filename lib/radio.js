// lib/radio.js — pure decision for the Random Album Radio.
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.
//
// Given a Roon zone object and whether radio is enabled for it, decide what to
// do: "queue" (append the next random album, gaplessly, while the last track
// plays), "play" (start a fresh random album because the zone is idle/empty),
// or null (do nothing). Kept pure so it can be unit-tested without Roon.

function radioDecision(zone, enabled) {
  if (!zone || !enabled) return null;
  if (zone.settings && zone.settings.auto_radio) return null; // Roon Radio is handling it

  const remaining = zone.queue_items_remaining;
  const state = zone.state;

  if (state === "playing" || state === "loading") {
    if (typeof remaining === "number" && remaining <= 1) return "queue";
    return null;
  }
  if (state === "stopped") {
    if (typeof remaining !== "number" || remaining <= 0) return "play";
    return null;
  }
  return null; // paused, or unknown state — leave it alone
}

module.exports = { radioDecision };
