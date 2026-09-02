"use strict";
/*
 * png.js — the smallest PNG reader that can answer "what colour is that pixel".
 *
 * WHY THIS EXISTS: the DOM harness reads layout, and layout cannot see paint
 * order. When two elements occupy the same box, getBoundingClientRect reports
 * both at the same place and elementFromPoint skips anything with
 * pointer-events:none — so "the canvas is painted OVER the slider's thumb" is
 * invisible to every assertion the suite could otherwise make. It is also a
 * real defect: an absolutely-positioned element paints above in-flow inline
 * content regardless of DOM order, so the one line holding the thumb on top is
 * load-bearing and was untested.
 *
 * Chromium's --screenshot writes 8-bit RGBA (or RGB), non-interlaced, and that
 * is the ONLY shape handled here. Anything else throws rather than guessing:
 * this is a test helper, and a reader that silently mis-decodes would turn a
 * red test green.
 *
 * Zero dependencies — zlib is in node.
 */

const zlib = require("node:zlib");

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * @param {Buffer} buf a PNG file
 * @returns {{width:number,height:number,data:Uint8Array}} data is RGBA, 4 bytes
 *          per pixel, row-major — the same shape as canvas getImageData().data.
 */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error("not a PNG");
  }
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;   // length + type + data + crc
  }
  if (bitDepth !== 8) throw new Error("unsupported bit depth " + bitDepth);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  // 2 = truecolour (RGB), 6 = truecolour with alpha (RGBA). Chromium writes
  // one of these; indexed and greyscale are not worth carrying here.
  if (colorType !== 2 && colorType !== 6) {
    throw new Error("unsupported colour type " + colorType);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;   // left
      const b = prev[i];                                   // up
      const c = i >= channels ? prev[i - channels] : 0;    // up-left
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 255; break;
        case 2: line[i] = (line[i] + b) & 255; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break;
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 255; break;
        default: throw new Error("unknown PNG filter " + filter);
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** @returns {[number,number,number,number]} RGBA at (x, y); zeros when out of bounds. */
function pixel(img, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0, 0];
  const d = (y * img.width + x) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2], img.data[d + 3]];
}

module.exports = { decodePng, pixel };
