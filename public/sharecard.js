/*
 * sharecard.js — render a "now playing / album" share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * This is a client-side reimplementation of the original server-side card
 * (which used Node + sharp + SVG). We can't run sharp in a browser PWA, so we
 * draw the identical layout onto an HTML5 <canvas> and export a PNG blob.
 *
 * Layout (1200 x 600), matching the original:
 *
 *   +--------------------+-----------------------------+
 *   |                    |  [MusicD wordmark, top-right]|
 *   |                    |  Released DD Mon YYYY        |
 *   |    cover 600x600   |  <Album Title> (wraps x3)    |
 *   |                    |  by <Artist>                 |
 *   |                    |  [GENRE] [GENRE] [GENRE]     |
 *   +--------------------+-----------------------------+
 *
 * Note vs the original: the grey "review" paragraph is omitted, because that
 * text came from the old project's enrichment database and isn't available
 * over the LMS JSON-RPC API.
 */

const ShareCard = (() => {
  const CARD_W      = 1200;
  const PAD         = 56;
  const COVER       = 480;
  const COVER_X     = PAD;
  const COVER_Y     = PAD;
  const RIGHT_X     = PAD + COVER + 44;          // info column start
  const RIGHT_W     = CARD_W - RIGHT_X - PAD;    // info column width
  const REVIEW_W    = CARD_W - PAD * 2;          // full-width review
  const WORDMARK_W  = 168;
  const MAX_REVIEW_LINES = 20;

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
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + src));
      img.src = src;
    });
  }

  function wrapText(ctx, text, maxWidth, maxLines) {
    if (!text) return [];
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const candidate = cur ? cur + ' ' + w : w;
      if (ctx.measureText(candidate).width <= maxWidth) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        if (lines.length >= maxLines) { cur = ''; break; }
        cur = w;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1];
      const joined = lines.join(' ');
      if (joined.length < String(text).length) {
        while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last.replace(/\s+$/, '') + '…';
      }
    }
    return lines;
  }

  /*
   * Render the card. `data` shape:
   *   { coverUrl, title, artist, releaseRaw, label, review, wordmarkUrl }
   * Returns a Promise<Blob> (PNG).
   *
   * Layout (1200 wide, height grows to fit the review):
   *   +----------------------------------------------------+
   *   | [cover 480]   RELEASED date · label                |
   *   | [        ]    Album Title (bold, wraps)            |
   *   | [        ]    by Artist                             |
   *   |----------------------------------------------------|
   *   | Full-width review text, as many lines as needed …   |
   *   |                                       [MusicD logo] |
   *   +----------------------------------------------------+
   */
  async function render(data) {
    // Pre-load images so we know the wordmark ratio before sizing the canvas.
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    // Measuring pass — a throwaway context just for text metrics.
    const canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = 10;
    let ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    ctx.font = '700 46px "Manrope", sans-serif';
    const titleLines = wrapText(ctx, data.title || '', RIGHT_W, 3);

    ctx.font = '400 30px "Manrope", sans-serif';
    const artistLines = wrapText(ctx, 'by ' + (data.artist || ''), RIGHT_W, 2);

    ctx.font = '400 28px "Manrope", sans-serif';
    const reviewLines = wrapText(ctx, data.review || '', REVIEW_W, MAX_REVIEW_LINES);

    // --- Layout maths (textBaseline 'top', so y is the top of each line) ---
    const releaseStr = formatReleaseDate(data.releaseRaw);
    const label = (data.label || '').trim();
    const metaLine = [releaseStr ? 'Released ' + releaseStr : null, label]
      .filter(Boolean).join('   ·   ');

    const TITLE_LH = 56, ARTIST_LH = 40, REVIEW_LH = 40;
    let ry = COVER_Y + 6;                       // info column cursor
    const metaH    = metaLine ? 40 : 0;
    const titleH   = titleLines.length * TITLE_LH;
    const artistH  = artistLines.length * ARTIST_LH;
    const infoBottom = ry + metaH + titleH + 14 + artistH;

    const topBottom  = Math.max(COVER_Y + COVER, infoBottom);
    const reviewTop  = topBottom + 50;
    const reviewH    = reviewLines.length * REVIEW_LH;
    const wmH        = wm ? Math.round(WORDMARK_W * (wm.height / wm.width)) : 0;

    const CARD_H = Math.round(reviewTop + reviewH + 36 + wmH + PAD);

    // --- Real drawing pass ---
    canvas.height = CARD_H;        // resizing resets the context
    ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
    bg.addColorStop(0, '#121417');
    bg.addColorStop(1, '#0a0a0b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Cover (rounded + shadow)
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 14;
    roundRect(ctx, COVER_X, COVER_Y, COVER, COVER, 18);
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, COVER_X, COVER_Y, COVER, COVER, 18);
    ctx.clip();
    if (cover) drawCover(ctx, cover, COVER_X, COVER_Y, COVER, COVER);
    else { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(COVER_X, COVER_Y, COVER, COVER); }
    ctx.restore();

    // Info column
    ry = COVER_Y + 6;
    if (metaLine) {
      ctx.fillStyle = '#7f868d';
      ctx.font = '600 22px "Manrope", sans-serif';
      ctx.fillText(metaLine.toUpperCase(), RIGHT_X, ry);
      ry += metaH;
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 46px "Manrope", sans-serif';
    titleLines.forEach((line, i) => ctx.fillText(line, RIGHT_X, ry + i * TITLE_LH));
    ry += titleH + 14;
    ctx.fillStyle = '#cdd2d8';
    ctx.font = '400 30px "Manrope", sans-serif';
    artistLines.forEach((line, i) => ctx.fillText(line, RIGHT_X, ry + i * ARTIST_LH));

    // Divider above the review
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, topBottom + 24);
    ctx.lineTo(CARD_W - PAD, topBottom + 24);
    ctx.stroke();

    // Review (full width)
    ctx.fillStyle = '#aeb4bb';
    ctx.font = '400 28px "Manrope", sans-serif';
    reviewLines.forEach((line, i) => ctx.fillText(line, PAD, reviewTop + i * REVIEW_LH));

    // Wordmark, bottom-right
    if (wm) {
      const wwidth = WORDMARK_W;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(wm, CARD_W - PAD - wwidth, CARD_H - PAD - wmH + 8, wwidth, wmH);
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/png');
    });
  }

  // object-fit: cover — scale image to fill the box, cropping centre.
  function drawCover(ctx, img, dx, dy, dw, dh) {
    const ir = img.width / img.height;
    const dr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else         { sw = img.width;  sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { render };
})();
