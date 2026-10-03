"use strict";
// ---------------------------------------------------------------------------
// What the HQPlayer screen's pickers say beside each choice: "won't play"
// where HQPlayer's own rules predict a stop, "failed here before" where this
// machine learned one, and a softer note where a choice works but is outside
// what the manual recommends.
//
// Ported from hqpweb's web app (apps/web/src/App.svelte, the filterItems /
// shaperItems / decorate / warnFor logic), MIT, (c) 2026 statelycurmudgeon —
// see ./LICENSE. hqpweb works this out in the browser; here it is worked out
// on the server, beside the rules it reads, so the page carries no copy of
// them to drift.
// ---------------------------------------------------------------------------

const { filterSlot, ratioHint, modulatorHint, ditherHint } = require("./compat");

const nameAt = (list, i) => {
  const hit = (list || []).find((x) => x.index === i);
  return hit ? hit.name : "";
};

/**
 * The context the hints were worked out in. The page compares it with each
 * status it receives and asks again when it moves — a new track at another
 * rate, a different filter in effect, another mode.
 */
function hintsKey(snap) {
  if (!snap) return "";
  const st = snap.state;
  const source = snap.status.source ? snap.status.source.sampleRate : 0;
  return [st.mode, source, snap.status.activeRate, st.rate, st.filter1x, st.filterNx, st.shaper].join("|");
}

/** The filter slot in use: "1x" below a 50 kHz source, "Nx" above; null when stopped. */
function slotInUse(snap) {
  if (!snap || snap.status.state === 0) return null;
  const sr = snap.status.source ? snap.status.source.sampleRate : 0;
  if (sr) return filterSlot(sr);
  return snap.state.filterInUse === snap.state.filter1x ? "1x" : "Nx";
}

/**
 * { filter1x: {name: {warn?, note?}}, filterNx: {...}, shaper: {...} } —
 * sparse: a name with nothing to say is left out.
 */
function pickerHints(caps, snap) {
  const out = { filter1x: {}, filterNx: {}, shaper: {} };
  if (!caps || !snap) return out;
  const status = snap.status;
  const state = snap.state;
  const sdm = caps.mode.name.startsWith("SDM");
  const source = status.source ? status.source.sampleRate : 0;
  const outRate = status.activeRate || 0;
  // Only with a FIXED output rate can a filter choice make the ratio
  // impossible; on auto, HQPlayer picks a rate the filter can do.
  const fixedRate = (state.rate || 0) !== 0;
  const combo = {
    mode: caps.mode.name,
    rateHz: outRate,
    filterNx: nameAt(caps.filters, state.filterNx),
    filter1x: nameAt(caps.filters, state.filter1x),
    shaper: nameAt(caps.shapers, state.shaper),
  };
  const learned = (field, value) => {
    const c = Object.assign({}, combo, { [field]: value });
    const f = (caps.knownBad || []).find((x) => x.mode === c.mode && x.rateHz === c.rateHz &&
      x.filterNx === c.filterNx && x.filter1x === c.filter1x && x.shaper === c.shaper);
    return f ? "failed here before at these settings (" + f.reason + ")" : undefined;
  };
  const put = (bucket, name, rule, warnLearned) => {
    const warn = rule && rule.level === "hard" ? "won't play: " + rule.text : warnLearned;
    const note = rule && rule.level === "soft" ? rule.text : undefined;
    if (!warn && !note) return;
    const h = {};
    if (warn) h.warn = warn;
    if (note) h.note = note;
    bucket[name] = h;
  };
  for (const slot of ["1x", "Nx"]) {
    const field = slot === "1x" ? "filter1x" : "filterNx";
    for (const f of caps.filters) {
      const rule = source && fixedRate && filterSlot(source) === slot ? ratioHint(f.name, source, outRate, sdm) : undefined;
      put(out[field], f.name, rule, learned(field, f.name));
    }
  }
  for (const s of caps.shapers) {
    put(out.shaper, s.name, sdm ? modulatorHint(s.name, outRate) : ditherHint(s.name, outRate), learned("shaper", s.name));
  }
  return out;
}

module.exports = { pickerHints, hintsKey, slotInUse };
