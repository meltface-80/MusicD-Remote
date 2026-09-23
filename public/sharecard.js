/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License. See the LICENSE file for details.
 *
 * Layout (1200 wide, height grows to fit):
 *
 *   +--------------------------------------------------------+
 *   |  the cover again, blown up and softened, as the ground  |
 *   |    +------------------------------------------------+  |
 *   |    | +--------+   RELEASED 2009                     |  |
 *   |    | | cover  |   Album Title                       |  |
 *   |    | | 424px  |   by Artist                         |  |
 *   |    | +--------+                                     |  |
 *   |    | ---------------------------------------------- |  |
 *   |    | The description, across the WHOLE pane rather  |  |
 *   |    | than squeezed into the column beside the art…  |  |
 *   |    |                                                |  |
 *   |    | Wikipedia                                      |  |
 *   |    +------------------------------------------------+  |
 *   +--------------------------------------------------------+
 *
 *  THE DESCRIPTION SITS BELOW THE ART, NOT BESIDE IT. In the column beside a
 *  424px cover it had ~600px to wrap in and whatever vertical room the title
 *  and artist had not taken, which on a four-line title was none — so the text
 *  the server had gone and fetched was routinely dropped. Underneath it has the
 *  full pane width, and the CARD GROWS to hold it, so the constraint is the
 *  prose rather than the frame.
 *
 *  The height is therefore computed, not fixed: everything is measured first,
 *  then the canvas is sized, then it is drawn. A card with no description comes
 *  out at the 600px it always was.
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
  // The floor, not the height. A card with nothing but art, title and artist
  // comes out at exactly this — what the card was before the description moved
  // below the cover — and anything with prose grows past it.
  const MIN_CARD_H = 600;
  // And the ceiling. app.js already trims the source text to ~10 sentences, so
  // this is the backstop for a description that is long even after that: past
  // here the text is fitted into the room left rather than the card growing to
  // a picture nothing will display at a sensible size.
  const MAX_CARD_H = 1500;
  const INSET     = 48;    // gap from the card edge to the glass pane
  const PANE_X    = INSET;
  const PANE_Y    = INSET;
  const PANE_W    = CARD_W - INSET * 2;
  const PANE_R    = 28;    // pane corner radius
  const PANE_PAD  = 40;    // gap from the pane edge to its contents
  const ART_W     = 424;   // the sharp cover, inside the pane
  const ART_H     = 424;
  const ART_R     = 18;
  const ART_X     = PANE_X + PANE_PAD;
  const DIVIDER   = 44;    // gap between the cover and the text column
  const TEXT_X    = ART_X + ART_W + DIVIDER;
  const TEXT_PAD_R = 44;
  const TEXT_W    = PANE_X + PANE_W - TEXT_PAD_R - TEXT_X;
  // The description's column: the pane's FULL content width, which is roughly
  // double what it had beside the cover.
  const CONTENT_W = PANE_W - PANE_PAD * 2;
  const WORDMARK_W = 110;
  const WORDMARK_PAD = 34;

  // The dark the card is built on, and the pane drawn over the softened cover.
  // The score badge sits INSIDE the cover's top-right corner, so the surface
  // under it is the album art itself — unknown, and possibly white. It carries
  // its own opaque ground for exactly that reason: everything else on this card
  // is solved against a worst-case sleeve, and a badge over the art cannot be.
  const SCORE_PAD   = 14;   // inset from the cover's edges
  const SCORE_H     = 54;
  const SCORE_R     = 12;
  const SCORE_SIZE  = 30;
  const BNM_H       = 26;
  const BNM_SIZE    = 15;
  // Bigger than it was, because it is no longer sharing a narrow column with a
  // 56px title — at full pane width 22px read as small print.
  const DESC_SIZE   = 26;
  const DESC_LH     = 38;
  const DESC_MAX    = 14;   // lines, when there is room for them
  const RULE_GAP    = 30;   // above and below the hairline
  const RULE_COLOUR = 'rgba(255,255,255,.16)';
  // Whose words these are. `source` says where the LINK goes and this says who
  // WROTE what is on screen — they are different facts, and index.js keeps them
  // in different fields for that reason (description_source).
  const SRC_SIZE    = 20;
  const SRC_H       = SRC_SIZE + 4;
  const SRC_GAP     = 26;

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

  const META_SIZE  = 26;
  const META_H     = META_SIZE + 4;
  const META_GAP   = 24;   // gap below the year line
  const BLOCK_GAP  = 18;   // gap between title and artist

  /*
   * Everything the card needs to know before it can be sized.
   *
   * Separate from render() because the height is a RESULT of it: the canvas
   * cannot be sized until the description has been wrapped, and the wrapping
   * needs a context with fonts loaded. Pure apart from reading `ctx` font
   * metrics — it draws nothing.
   */
  function measure(ctx, data) {
    const releaseStr = formatReleaseDate(data.releaseRaw);
    // The label rides on the release line rather than earning a line of its
    // own: it was already being fetched for the card and then dropped on the
    // floor, and a second 30px row costs more than the fact is worth.
    const metaParts = [];
    if (releaseStr) metaParts.push('Released ' + releaseStr);
    if (data.label) metaParts.push(String(data.label));
    const metaText = metaParts.length ? metaParts.join('  \u00b7  ') : null;

    // Title and artist are adaptive: up to 4 lines each, stepping the font size
    // down until the text fits (56→27px title, 37→21px artist); only when even
    // the smallest size overflows is the last line ellipsized.
    const title  = fitText(ctx, data.title || '', TEXT_W, 4, 700, [56, 48, 42, 36, 31, 27], 68 / 56);
    const artist = fitText(ctx, 'by ' + (data.artist || ''), TEXT_W, 4, 400, [37, 32, 28, 24, 21], 48 / 37);

    const headerTextH = (metaText ? META_H + META_GAP : 0)
                      + title.lines.length * title.lh
                      + BLOCK_GAP
                      + artist.lines.length * artist.lh;
    // The header is as tall as the taller of its two columns. A four-line title
    // beside a 424px cover now makes the CARD taller instead of evicting the
    // description, which is the whole point of moving it below.
    const headerH = Math.max(ART_H, headerTextH);

    const srcText = data.reviewSource ? String(data.reviewSource).trim() : '';
    const srcH    = srcText ? SRC_GAP + SRC_H : 0;

    /*
     * The description, into the room MAX_CARD_H allows.
     *
     * Two lines is the floor: a single orphaned line that stops mid-sentence
     * reads as a rendering fault rather than as a summary, so below that the
     * block is dropped and the card goes back to being art, title and artist.
     *
     * NOTE ON WHAT CAN APPEAR HERE: index.js emits no Pitchfork prose (only
     * their score, the Best New Music flag and a link — see fetchAlbumBios),
     * so this text is Qobuz's or Wikipedia's, and score and description are in
     * practice mutually exclusive.
     */
    const roomForDesc = MAX_CARD_H - INSET * 2 - PANE_PAD * 2
                      - headerH - (RULE_GAP * 2 + 1) - srcH;
    const maxDesc = Math.min(DESC_MAX, Math.floor(roomForDesc / DESC_LH));
    const desc = (data.review && maxDesc >= 2)
      ? fitText(ctx, String(data.review), CONTENT_W, maxDesc, 400, [DESC_SIZE], DESC_LH / DESC_SIZE)
      : null;

    const descBlockH = desc
      ? RULE_GAP + 1 + RULE_GAP + desc.lines.length * desc.lh + (srcText ? srcH : 0)
      : 0;
    const contentH = headerH + descBlockH;
    const cardH = Math.max(MIN_CARD_H,
                           Math.min(MAX_CARD_H, contentH + PANE_PAD * 2 + INSET * 2));

    return { metaText, title, artist, desc,
             // The source is only drawn with the text it attributes.
             srcText: desc ? srcText : '',
             headerTextH, headerH, contentH, cardH };
  }

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);
    const wm    = await loadImage(data.wordmarkUrl).catch(() => null);

    // MEASURE FIRST, THEN SIZE, THEN DRAW. The height depends on how much
    // description there is, and measuring needs a context with fonts — so the
    // canvas starts at the minimum, every block is measured, and only then is
    // its height set. Assigning canvas.height RESETS the context (it is a
    // fresh bitmap), which is why textBaseline is set again afterwards and why
    // nothing may be drawn before this point.
    const canvas = document.createElement('canvas');
    canvas.width  = CARD_W;
    canvas.height = MIN_CARD_H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    const layout = measure(ctx, data);
    const CARD_H = layout.cardH;
    const PANE_H = CARD_H - INSET * 2;
    canvas.height = CARD_H;
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';

    // Where the block sits in the pane. With slack (a short card held up to the
    // minimum) it is centred; once the content fills the pane it is padded from
    // the top and the card has already grown to hold it.
    const contentY = PANE_Y + Math.max(PANE_PAD, Math.round((PANE_H - layout.contentH) / 2));
    // The cover and the title column are each centred against the taller of the
    // two, so a one-line title does not float at the top of a 424px cover.
    const ART_Y   = contentY + Math.round((layout.headerH - ART_H) / 2);
    const textY0  = contentY + Math.round((layout.headerH - layout.headerTextH) / 2);

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

    // --- The text, from the measurements taken before the canvas was sized ---
    const { metaText, title, artist, desc, srcText } = layout;
    let ry = textY0;

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
    ry += title.lines.length * title.lh + BLOCK_GAP;

    // --- Artist ---
    ctx.fillStyle = '#cdd3d9';
    ctx.font = `400 ${artist.size}px "Manrope", sans-serif`;
    artist.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, ry + i * artist.lh));

    // --- The hairline, and the description under it ---
    //
    // Full pane width, starting under the cover rather than beside it. The rule
    // is what makes the two halves read as one card instead of as a caption
    // that happens to be below a picture.
    if (desc) {
      const ruleY = contentY + layout.headerH + RULE_GAP;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ART_X, ruleY + 0.5);
      ctx.lineTo(ART_X + CONTENT_W, ruleY + 0.5);
      ctx.lineWidth = 1;
      ctx.strokeStyle = RULE_COLOUR;
      ctx.stroke();
      ctx.restore();

      // --- Description ---
      let dy = ruleY + 1 + RULE_GAP;
      ctx.fillStyle = '#c2cad3';
      ctx.font = `400 ${desc.size}px "Manrope", sans-serif`;
      desc.lines.forEach((line, i) => ctx.fillText(line, ART_X, dy + i * desc.lh));
      dy += desc.lines.length * desc.lh;

      // --- Source ---
      //
      // Whose prose this is, which is not the same question as where the link
      // goes. Bottom left, under the text it attributes.
      if (srcText) {
        // SIZE carries the hierarchy here, not opacity. #c2cad3 measures 4.52:1
        // on the worst pane this card can present (a white sleeve, softened,
        // scrimmed, under the glass) — twenty hundredths over the floor, so
        // there is no headroom to fade it: at 0.72 alpha it drops to 3.16 and
        // the caption becomes unreadable on exactly the covers nobody checks.
        // A treatment defined by REMOVING contrast has no floor; 20px against
        // the description's 26px is a difference that costs nothing.
        ctx.fillStyle = '#c2cad3';
        ctx.font = `400 ${SRC_SIZE}px "Manrope", sans-serif`;
        ctx.fillText(srcText, ART_X, dy + SRC_GAP);
      }
    }

    // --- Pitchfork score, over the cover's top-right corner ---
    //
    // Only the number and the Best New Music flag, never a word of the review:
    // fetchAlbumBios nulls Pitchfork's prose before it leaves the server, and
    // the chip under the card is the link to read it at theirs.
    if (data.score != null && isFinite(data.score)) {
      const scoreStr = String(data.score);
      ctx.font = `700 ${SCORE_SIZE}px "Manrope", sans-serif`;
      const sw = Math.ceil(ctx.measureText(scoreStr).width) + 30;
      const sx = ART_X + ART_W - SCORE_PAD - sw;
      const sy = ART_Y + SCORE_PAD;

      ctx.save();
      roundRectPath(ctx, sx, sy, sw, SCORE_H, SCORE_R);
      // Opaque, not translucent: this one sits on the album art rather than on
      // the solved pane, so its own ground is the only thing keeping it legible
      // over a white sleeve.
      ctx.fillStyle = '#0c0e12';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${SCORE_SIZE}px "Manrope", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(scoreStr, sx + sw / 2, sy + Math.round((SCORE_H - SCORE_SIZE) / 2) - 2);
      ctx.textAlign = 'left';

      if (data.bestNewMusic) {
        ctx.font = `700 ${BNM_SIZE}px "Manrope", sans-serif`;
        const bw = Math.ceil(ctx.measureText('BEST NEW MUSIC').width) + 22;
        const bx = ART_X + ART_W - SCORE_PAD - bw;
        const by = sy + SCORE_H + 8;
        ctx.save();
        roundRectPath(ctx, bx, by, bw, BNM_H, 8);
        ctx.fillStyle = '#e8482b';   // Pitchfork's own flag colour, opaque
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${BNM_SIZE}px "Manrope", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('BEST NEW MUSIC', bx + bw / 2, by + Math.round((BNM_H - BNM_SIZE) / 2) - 1);
        ctx.textAlign = 'left';
      }
    }

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

  // `measure` is exported for the suite: it owns the height arithmetic and the
  // rule about when a description is worth drawing, and both are decisions
  // rather than pixels. It needs only ctx.font and ctx.measureText, so a stub
  // tests it without a canvas.
  return { render, measure, MIN_CARD_H, MAX_CARD_H, CONTENT_W, TEXT_W };
})();

// Node (the test suite) rather than the browser. The file is loaded with a
// <script> tag in the app and there is no module system there, so this is
// guarded rather than unconditional.
if (typeof module !== 'undefined' && module.exports) module.exports = ShareCard;
