"use strict";
// ---------------------------------------------------------------------------
// HQPlayer request builders. Ported from hqpweb
// (packages/protocol/src/commands.ts), MIT, (c) 2026 statelycurmudgeon — see
// ./LICENSE. The shapes are the ones hqpweb sent live on 2026-10-02.
//
// Setters take LIST INDICES, and the lists depend on the mode and the engine
// version: resolve a name to its index immediately before use, and never keep
// an index across a mode change.
// ---------------------------------------------------------------------------

const { element } = require("./xml");

function index(i) {
  if (!Number.isInteger(i) || i < 0) throw new Error("list index must be a non-negative integer, got " + i);
  return i;
}

const cmd = {
  getInfo: () => element("GetInfo"),
  state: () => element("State"),
  status: () => element("Status", { subscribe: 0 }),
  getModes: () => element("GetModes"),
  getFilters: () => element("GetFilters"),
  getShapers: () => element("GetShapers"),
  getRates: () => element("GetRates"),
  volumeRange: () => element("VolumeRange"),
  // Matrix profiles. Reported (HQPTuner): an unknown name still gets OK and
  // State echoes it, so only ever send names from matrixListProfiles.
  matrixListProfiles: () => element("MatrixListProfiles"),
  matrixSetProfile: (name) => element("MatrixSetProfile", { value: name }),

  setMode: (i) => element("SetMode", { value: index(i) }),
  setRate: (i) => element("SetRate", { value: index(i) }),
  // Always both: hqpweb's live harness did, and what omitting value1x does
  // was never verified.
  setFilter: (nx, x1) => element("SetFilter", { value: index(nx), value1x: index(x1) }),
  setShaping: (i) => element("SetShaping", { value: index(i) }),
  setInvert: (on) => element("SetInvert", { value: !!on }),
  set20kFilter: (on) => element("Set20kFilter", { value: !!on }),
  setAdaptiveVolume: (on) => element("SetAdaptiveVolume", { value: !!on }),
  setConvolution: (on) => element("SetConvolution", { value: !!on }),
  // Absolute volume in dB. This only checks the number is finite; the "never
  // raise implicitly, clamp to VolumeRange" policy belongs to the caller.
  volume: (db) => {
    if (!Number.isFinite(db)) throw new Error("volume must be a finite dB value, got " + db);
    return element("Volume", { value: db });
  },
};

module.exports = { cmd };
