"use strict";
// ---------------------------------------------------------------------------
// HQPlayer compatibility rules. Ported from hqpweb
// (packages/protocol/src/compat.ts), MIT, (c) 2026 statelycurmudgeon — see
// ./LICENSE. hqpweb restated these in its own words from the HQPlayer Desktop
// user manual (v5.13, sections cited per rule; the manual itself is not
// reproduced) plus what it measured.
//
// "hard" = predicted not to play; "soft" = works but outside the recommended
// range. The app WARNS; it never blocks. Unknown names get no prediction:
// newer engines have filters the 5.13 manual does not list, and a guess would
// be worse than silence.
// ---------------------------------------------------------------------------

/** §4.6 "Ratio" column: which conversion ratios a filter can do. */
const RATIO = {
  none: "1:1",
  IIR: "integer",
  IIR2: "integer",
  FIR: "integer",
  asymFIR: "integer",
  minphaseFIR: "integer",
  FFT: "pow2-up",
  "poly-sinc-lp": "any",
  "poly-sinc-mp": "any",
  "poly-sinc-short-lp": "any",
  "poly-sinc-short-mp": "any",
  "poly-sinc-long-lp": "any",
  "poly-sinc-long-ip": "any",
  "poly-sinc-long-mp": "any",
  "poly-sinc-hb": "any",
  "poly-sinc-hb-xs": "any",
  "poly-sinc-hb-s": "any",
  "poly-sinc-hb-m": "any",
  "poly-sinc-hb-l": "any",
  "poly-sinc-ext": "integer",
  "poly-sinc-ext2": "any",
  "poly-sinc-ext3": "any",
  // PCM: integer up; SDM: any (§4.6).
  "poly-sinc-mqa/mp3-lp": "integer-up",
  "poly-sinc-mqa/mp3-mp": "integer-up",
  "poly-sinc-xtr-lp": "any",
  "poly-sinc-xtr-mp": "any",
  "poly-sinc-xtr-short-lp": "any",
  "poly-sinc-xtr-short-mp": "any",
  "poly-sinc-gauss-short": "integer-up",
  "poly-sinc-gauss": "any",
  "poly-sinc-gauss-long": "any",
  "poly-sinc-gauss-xl": "any",
  "poly-sinc-gauss-xla": "any",
  "poly-sinc-gauss-hires-lp": "any",
  "poly-sinc-gauss-hires-ip": "any",
  "poly-sinc-gauss-hires-mp": "any",
  "poly-sinc-gauss-halfband": "any",
  "poly-sinc-gauss-halfband-s": "any",
  ASRC: "any",
  "polynomial-1": "integer-up",
  "polynomial-2": "integer-up",
  "minringFIR-lp": "integer-up",
  "minringFIR-mp": "integer-up",
  "closed-form": "pow2-up",
  "closed-form-fast": "pow2-up",
  "closed-form-M": "pow2-up",
  "closed-form-16M": "pow2-up",
  "sinc-S": "integer",
  "sinc-M": "integer",
  "sinc-Mx": "integer",
  "sinc-MG": "integer",
  "sinc-MGa": "integer",
  "sinc-L": "integer",
  "sinc-Ls": "integer",
  "sinc-Lm": "integer",
  "sinc-Ll": "integer",
  "sinc-Lh": "integer",
  "sinc-short": "any",
  "sinc-medium": "any",
  "sinc-long": "any",
  "sinc-long-h": "any",
};

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Ratio class for a filter name; "-2s" variants share their base filter's (§4.6). */
function ratioClass(filter) {
  if (own(RATIO, filter)) return RATIO[filter];
  if (filter.endsWith("-2s") && own(RATIO, filter.slice(0, -3))) return RATIO[filter.slice(0, -3)];
  return undefined;
}

/** §4.6: the 1x filter covers source rates below 50 kHz; Nx everything above. */
const filterSlot = (sourceRate) => (sourceRate < 50000 ? "1x" : "Nx");

const khz = (hz) => (hz >= 1000000 ? +(hz / 1000000).toFixed(4) + " MHz" : +(hz / 1000).toFixed(1) + "k");
const isPow2 = (n) => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;

/** Can `filter` convert `sourceRate` to `outputRate`? undefined when unknown. */
function ratioHint(filter, sourceRate, outputRate, sdm) {
  const cls = ratioClass(filter);
  if (!cls || !sourceRate || !outputRate) return undefined;
  const r = outputRate / sourceRate;
  const ratio = Number.isInteger(r) ? r + "×" : r.toFixed(2) + "×";
  const why = (need) => ({ level: "hard", text: filter + " needs " + need + "; " + khz(sourceRate) + " → " + khz(outputRate) + " is " + ratio });
  switch (cls) {
    case "any":
      return undefined;
    case "1:1":
      return r === 1 ? undefined : why("the output rate to equal the source rate");
    case "integer":
      return Number.isInteger(r) || Number.isInteger(1 / r) ? undefined : why("a whole-number ratio");
    case "integer-up":
      if (sdm && filter.startsWith("poly-sinc-mqa")) return undefined; // any ratio for SDM (§4.6)
      return Number.isInteger(r) && r >= 1 ? undefined : why("a whole-number upsampling ratio");
    case "pow2-up":
      return isPow2(r) ? undefined : why("a power-of-two upsampling ratio");
  }
  return undefined;
}

/**
 * Modulator rate floors (§4.5). AHM* 5L/8B are "optimized for ≥ 40.96 MHz";
 * hqpweb measured AHM7EC8B stopping at DSD256 and DSD512, so the AHM family is
 * hard (measured for one member, inferred for the rest). The others are soft.
 */
function modulatorHint(shaper, outputRate) {
  if (!outputRate) return undefined;
  if (/^AHM/.test(shaper) && outputRate < 40960000)
    return { level: "hard", text: shaper + " needs ≥ 40.96 MHz (DSD1024); " + khz(outputRate) + " stops playback" };
  if (/^AMSDM/.test(shaper) && outputRate < 20480000)
    return { level: "soft", text: shaper + " is designed for ≥ 20.48 MHz (DSD512)" };
  if (/512\+fs$/.test(shaper) && outputRate < 22579200)
    return { level: "soft", text: shaper + " is optimised for DSD512 and up" };
  if (/256\+fs$/.test(shaper) && outputRate < 10240000)
    return { level: "soft", text: shaper + " is optimised for ≥ 10.24 MHz (DSD256)" };
  return undefined;
}

/** PCM dither / noise-shaping recommendations by output rate (§4.4). All soft. */
function ditherHint(dither, outputRate) {
  if (!outputRate) return undefined;
  const soft = (text) => ({ level: "soft", text });
  switch (dither) {
    case "none":
      return soft("rounding only; not recommended except for bit-perfect tests");
    case "NS1":
      return outputRate < 176400 || outputRate > 192000 ? soft("NS1 is intended mostly for 176.4/192k") : undefined;
    case "NS4":
    case "shaped":
      return outputRate < 88200 ? soft(dither + " is for 88.2k and up") : undefined;
    case "NS5":
      return outputRate < 192000 ? soft("NS5 isn't recommended below 192k") : undefined;
    case "NS9":
      return outputRate < 176400 || outputRate > 192000 ? soft("NS9 is designed for 176.4/192k") : undefined;
    case "LNS15":
      return outputRate < 352800 ? soft("LNS15 isn't recommended below 352.8k") : undefined;
    case "Gauss1":
      return outputRate > 96000 ? soft("Gauss1 is recommended at 96k and below") : undefined;
    default:
      return undefined;
  }
}

/** §2.15: keep volume at or below −3 dBFS when resampling or in SDM. */
const RECOMMENDED_MAX_VOLUME_DB = -3;

/** Would this combination be expected to stop? Used to avoid "learning" rule-explained failures. */
function predictedStop(c) {
  const sdm = c.mode.startsWith("SDM");
  const r = ratioHint(c.filter, c.sourceRate, c.outputRate, sdm);
  if (r && r.level === "hard") return r;
  const m = sdm ? modulatorHint(c.shaper, c.outputRate) : undefined;
  return m && m.level === "hard" ? m : undefined;
}

module.exports = {
  ratioClass, filterSlot, ratioHint, modulatorHint, ditherHint, predictedStop, RECOMMENDED_MAX_VOLUME_DB,
};
