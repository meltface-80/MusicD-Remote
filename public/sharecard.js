/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Layout (1200 × 600, fixed) — v1.7.89, the app's own material:
 *
 *   +--------------------------------------------------------+
 *   |  the cover again, blown up and softened, as the ground  |
 *   |    +------------------------------------------------+  |
 *   |    | +--------+   RELEASED 2009                     |  |
 *   |    | | cover  |   Album Title                       |  |
 *   |    | | 424px  |   by Artist                         |  |
 *   |    | +--------+                          [MusicD]   |  |
 *   |    +------------------------------------------------+  |
 *   +--------------------------------------------------------+
 *
 *  The card used to be a hard vertical split: art on the left half, a flat
 *  #0e1012 slab on the right. It now reads the way the app does — the artwork
 *  IS the background, and a translucent pane sits on it holding the sharp
 *  cover and the text.
 *
 *  THE SOFTENING IS A DOWNSCALE, NOT A BLUR. `ctx.filter = 'blur()'` is not
 *  dependable across the browsers this runs in, so the ground is the cover
 *  drawn into a 24px offscreen canvas and scaled back up — bilinear
 *  interpolation does the work. That is the same trick the app's own ambient
 *  layer uses (see #modal-ambient in style.css), and it costs one tiny draw.
 *
 *  The card stays dark in every theme. It is a standalone image that will be
 *  seen outside the app, on backgrounds nobody here controls, and the wordmark
 *  and the text colours are built for a dark ground.
 */

const ShareCard = (() => {
  const CARD_W    = 1200;
  const CARD_H    = 600;
  const INSET     = 48;    // gap from the card edge to the glass pane
  const PANE_X    = INSET;
  const PANE_Y    = INSET;
  const PANE_W    = CARD_W - INSET * 2;
  const PANE_H    = CARD_H - INSET * 2;
  const PANE_R    = 28;    // pane corner radius
  const PANE_PAD  = 40;    // gap from the pane edge to its contents
  const ART_W     = 424;   // the sharp cover, inside the pane
  const ART_H     = 424;
  const ART_R     = 18;
  const ART_X     = PANE_X + PANE_PAD;
  const ART_Y     = PANE_Y + Math.round((PANE_H - ART_H) / 2);
  const DIVIDER   = 44;    // gap between the cover and the text column
  const TEXT_X    = ART_X + ART_W + DIVIDER;
  const TEXT_PAD_R = 44;
  const TEXT_W    = PANE_X + PANE_W - TEXT_PAD_R - TEXT_X;
  const WORDMARK_W = 110;
  const WORDMARK_PAD = 34;

  // The dark the card is built on, and the pane drawn over the softened cover.
  const GROUND    = '#12151a';
  const PANE_FILL = 'rgba(18,21,26,.5)';
  const PANE_EDGE = 'rgba(255,255,255,.14)';

  // A rounded rectangle path. roundRect() is still missing in enough shipping
  // browsers to be worth not depending on.
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y,     x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x,     y + h, rr);
    ctx.arcTo(x,     y + h, x,     y,     rr);
    ctx.arcTo(x,     y,     x + w, y,     rr);
    ctx.closePath();
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function formatReleaseDate(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${d} ${MONTHS[mo-1]} ${y}`;
    }
    m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (m) { const mo = +m[2]; if (mo>=1&&mo<=12) return `${MONTHS[mo-1]} ${m[1]}`; }
    m = s.match(/^(\d{4})$/);
    if (m) return m[1];
    return s;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
    });
  }

  // Word-wrap text to maxWidth. Returns { lines, overflow } — overflow is true
  // when the text didn't fully fit in maxLines (or a single word is wider than
  // the column). Ellipsis is NOT applied here: fitText() first tries smaller
  // font sizes and only ellipsizes as the final fallback.
  function wrapText(ctx, text, maxWidth, maxLines) {
    if (!text) return { lines: [], overflow: false };
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    let overflow = false;
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (ctx.measureText(candidate).width <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        if (lines.length >= maxLines) { cur = ''; overflow = true; break; }
        cur = w;
        if (ctx.measureText(w).width > maxWidth) overflow = true;  // single over-wide word
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    else if (cur) overflow = true;
    return { lines, overflow };
  }

  // Fit text into maxLines within maxWidth by stepping the font size down until
  // it fits; only when even the smallest size overflows is the last line
  // ellipsized. Returns { lines, size, lh } for the chosen size.
  function fitText(ctx, text, maxWidth, maxLines, weight, sizes, lhRatio) {
    let r = null, size = sizes[0];
    for (const s of sizes) {
      size = s;
      ctx.font = `${weight} ${s}px "Manrope", sans-serif`;
      r = wrapText(ctx, text, maxWidth, maxLines);
      if (!r.overflow) break;
    }
    if (r.overflow && r.lines.length) {
      // Final fallback at the smallest size: trim the last line to an ellipsis.
      let last = r.lines[r.lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      r.lines[r.lines.length - 1] = last.replace(/\s+$/, '') + '…';
    }
    return { lines: r.lines, size, lh: Math.round(size * lhRatio) };
  }

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    const canvas = document.createElement('canvas');
    canvas.width  = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    // --- Ground: the cover again, softened, filling the card ---
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    if (cover) {
      drawSoftened(ctx, cover, CARD_W, CARD_H);
      // Two scrims over it, doing different jobs. The flat one sets the floor
      // for how light the ground can get behind the pane — a white sleeve would
      // otherwise leave the pane sitting on near-white. The gradient darkens the
      // bottom, where the wordmark sits.
      ctx.fillStyle = 'rgba(12,14,18,.44)';
      ctx.fillRect(0, 0, CARD_W, CARD_H);
      const vign = ctx.createLinearGradient(0, CARD_H * 0.45, 0, CARD_H);
      vign.addColorStop(0, 'rgba(8,10,13,0)');
      vign.addColorStop(1, 'rgba(8,10,13,.55)');
      ctx.fillStyle = vign;
      ctx.fillRect(0, 0, CARD_W, CARD_H);
    }

    // --- The pane ---
    ctx.save();
    roundRectPath(ctx, PANE_X, PANE_Y, PANE_W, PANE_H, PANE_R);
    ctx.fillStyle = PANE_FILL;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = PANE_EDGE;
    ctx.stroke();
    ctx.restore();

    // --- The sharp cover, inside the pane ---
    ctx.save();
    roundRectPath(ctx, ART_X, ART_Y, ART_W, ART_H, ART_R);
    ctx.clip();
    if (cover) {
      drawCover(ctx, cover, ART_X, ART_Y, ART_W, ART_H);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(ART_X, ART_Y, ART_W, ART_H);
    }
    ctx.restore();
    // A hairline round the cover so a sleeve that is white to its edge does not
    // bleed into the pane.
    ctx.save();
    roundRectPath(ctx, ART_X + 0.5, ART_Y + 0.5, ART_W - 1, ART_H - 1, ART_R);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.stroke();
    ctx.restore();

    // --- Measure text blocks ---
    const releaseStr = formatReleaseDate(data.releaseRaw);
    const metaText   = releaseStr ? 'Released ' + releaseStr : null;
    const META_SIZE  = 26;
    const META_H     = META_SIZE + 4;
    const META_GAP   = 24;   // gap below the year line

    // Title and artist are adaptive: up to 4 lines each, stepping the font size
    // down until the text fits (56→36px title, 37→24px artist); only when even
    // the smallest size overflows is the last line ellipsized. Worst case
    // (meta + 4 title lines @36 + 4 artist lines @24 ≈ 426px) fits the 600px card.
    const title  = fitText(ctx, data.title || '', TEXT_W, 4, 700, [56, 48, 42, 36, 31, 27], 68 / 56);
    const titleH = title.lines.length * title.lh;

    const artist  = fitText(ctx, 'by ' + (data.artist || ''), TEXT_W, 4, 400, [37, 32, 28, 24, 21], 48 / 37);
    const artistH = artist.lines.length * artist.lh;

    const BLOCK_GAP  = 18;   // gap between title and artist

    // Total height of the text block
    const blockH = (metaText ? META_H + META_GAP : 0) + titleH + BLOCK_GAP + artistH;

    // Vertically centre the block in the pane, with a slight upward nudge
    // (optical centre sits a little above mathematical centre).
    const startY = PANE_Y + Math.round((PANE_H - blockH) / 2) - 10;
    let ry = Math.max(PANE_Y + PANE_PAD, startY);

    // --- Year / release date ---
    if (metaText) {
      // Solved against the WORST case the pane can present: a white sleeve
      // under the scrim and the pane, which flattens to rgb(83,85,88). The old
      // #7f868d measured 2.31:1 there and #9aa2ab 2.89 — both under even the
      // large-text floor. test/static/sharecard.test.js recomputes this from
      // the literals rather than trusting the number written here.
      ctx.fillStyle = '#c2cad3';
      ctx.font = `600 ${META_SIZE}px "Manrope", sans-serif`;
      ctx.fillText(metaText.toUpperCase(), TEXT_X, ry);
      ry += META_H + META_GAP;
    }

    // --- Album title ---
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${title.size}px "Manrope", sans-serif`;
    title.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * title.lh));
    ry += titleH + BLOCK_GAP;

    // --- Artist ---
    ctx.fillStyle = '#cdd3d9';
    ctx.font = `400 ${artist.size}px "Manrope", sans-serif`;
    artist.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * artist.lh));

    // --- Wordmark pinned bottom-right (only if a wordmark image was supplied) ---
    if (wm) {
      const wmH = Math.round(WORDMARK_W * (wm.height / wm.width));
      ctx.globalAlpha = 0.88;
      ctx.drawImage(
        wm,
        PANE_X + PANE_W - WORDMARK_PAD - WORDMARK_W,
        PANE_Y + PANE_H - WORDMARK_PAD - wmH,
        WORDMARK_W, wmH
      );
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/png'
      );
    });
  }

  // The ground. Draw the cover into a tiny offscreen canvas and scale it back
  // up: the interpolation is the softening, so this needs no filter support and
  // costs one 24px draw. `cover` fills the card, cropping rather than
  // letterboxing, the same as the sharp copy inside the pane.
  function drawSoftened(ctx, img, w, h) {
    const SMALL = 24;
    const off = document.createElement('canvas');
    off.width = SMALL;
    off.height = Math.max(1, Math.round(SMALL * (h / w)));
    const octx = off.getContext('2d');
    drawCover(octx, img, 0, 0, off.width, off.height);
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    // Bleed a little past every edge: the outermost pixels of an upscale are
    // the least smoothed, and they are the ones that would sit on the border.
    const over = Math.round(w * 0.06);
    ctx.drawImage(off, -over, -over, w + over * 2, h + over * 2);
    ctx.imageSmoothingEnabled = prev;
  }

  function drawCover(ctx, img, dx, dy, dw, dh) {
    const ir = img.width / img.height;
    const dr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else         { sw = img.width;  sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  return { render };
})();
