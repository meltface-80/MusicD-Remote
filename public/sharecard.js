/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Layout (1200 × 600, fixed):
 *
 *   +---------------------+-----------------------------+
 *   |                     |                             |
 *   |                     |   RELEASED 2009             |
 *   |  album art 600×600  |   Album Title               |
 *   |   (full bleed left) |   by Artist                 |
 *   |                     |                  [MusicD]   |
 *   +---------------------+-----------------------------+
 *
 *  Art fills the entire left half edge-to-edge.
 *  Year, title, and artist are vertically centred in the right half.
 *  Wordmark is pinned to the bottom-right corner.
 */

const ShareCard = (() => {
  const CARD_W    = 1200;
  const CARD_H    = 600;
  const ART_W     = 600;   // fills left half exactly
  const ART_H     = 600;
  const DIVIDER   = 40;    // gap between art edge and text start
  const TEXT_X    = ART_W + DIVIDER;
  const TEXT_PAD_R = 48;
  const TEXT_W    = CARD_W - TEXT_X - TEXT_PAD_R;
  const WORDMARK_W = 110;
  const WORDMARK_PAD = 36;

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

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    const canvas = document.createElement('canvas');
    canvas.width  = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    // --- Background (right half; art covers the left) ---
    ctx.fillStyle = '#0e1012';
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // --- Cover art — full-bleed left half ---
    if (cover) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, ART_W, ART_H);
      ctx.clip();
      drawCover(ctx, cover, 0, 0, ART_W, ART_H);
      ctx.restore();
    } else {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, ART_W, ART_H);
    }

    // Subtle vertical gradient on the right edge of the art to
    // ease the hard split (optional — remove if too heavy).
    const fade = ctx.createLinearGradient(ART_W - 40, 0, ART_W, 0);
    fade.addColorStop(0, 'rgba(14,16,18,0)');
    fade.addColorStop(1, 'rgba(14,16,18,0.55)');
    ctx.fillStyle = fade;
    ctx.fillRect(ART_W - 40, 0, 40, CARD_H);

    // --- Measure text blocks ---
    const releaseStr = formatReleaseDate(data.releaseRaw);
    const metaText   = releaseStr ? 'Released ' + releaseStr : null;
    const META_SIZE  = 20;
    const META_H     = META_SIZE + 4;
    const META_GAP   = 22;   // gap below the year line

    const TITLE_SIZE = 48;
    const TITLE_LH   = 58;
    ctx.font = `700 ${TITLE_SIZE}px "Manrope", sans-serif`;
    const titleLines = wrapText(ctx, data.title || '', TEXT_W, 3);
    const titleH = titleLines.length * TITLE_LH;

    const ARTIST_SIZE = 30;
    const ARTIST_LH   = 40;
    ctx.font = `400 ${ARTIST_SIZE}px "Manrope", sans-serif`;
    const artistLines = wrapText(ctx, 'by ' + (data.artist || ''), TEXT_W, 2);
    const artistH = artistLines.length * ARTIST_LH;

    const BLOCK_GAP  = 18;   // gap between title and artist

    // Total height of the text block
    const blockH = (metaText ? META_H + META_GAP : 0) + titleH + BLOCK_GAP + artistH;

    // Vertically centre the block in the right pane, with a slight upward nudge
    // (optical centre sits a little above mathematical centre).
    const startY = Math.round((CARD_H - blockH) / 2) - 10;
    let ry = Math.max(40, startY);

    // --- Year / release date ---
    if (metaText) {
      ctx.fillStyle = '#7f868d';
      ctx.font = `600 ${META_SIZE}px "Manrope", sans-serif`;
      ctx.fillText(metaText.toUpperCase(), TEXT_X, ry);
      ry += META_H + META_GAP;
    }

    // --- Album title ---
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${TITLE_SIZE}px "Manrope", sans-serif`;
    titleLines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * TITLE_LH));
    ry += titleH + BLOCK_GAP;

    // --- Artist ---
    ctx.fillStyle = '#c0c6cc';
    ctx.font = `400 ${ARTIST_SIZE}px "Manrope", sans-serif`;
    artistLines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * ARTIST_LH));

    // --- Wordmark pinned bottom-right ---
    if (wm) {
      const wmH = Math.round(WORDMARK_W * (wm.height / wm.width));
      ctx.globalAlpha = 0.88;
      ctx.drawImage(
        wm,
        CARD_W - WORDMARK_PAD - WORDMARK_W,
        CARD_H - WORDMARK_PAD - wmH,
        WORDMARK_W, wmH
      );
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.75;
      ctx.font = 'bold 20px system-ui,-apple-system,sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('MusicD', CARD_W - WORDMARK_PAD, CARD_H - WORDMARK_PAD + 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/png'
      );
    });
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
