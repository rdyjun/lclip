'use strict';

/**
 * Server-side subtitle renderer using node-canvas.
 * Mirrors player.js drawSubtitle() exactly so exports match the editor preview.
 */

const path = require('path');
const fs   = require('fs');

const PROJECT_FONT_DIR = path.join(__dirname, '../../fonts');

// Font file candidates, in priority order.
// System NotoSansKR-VF.ttf is preferred — same file Chrome falls back to on Windows.
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/NotoSansKR-VF.ttf',
  path.join(PROJECT_FONT_DIR, 'NotoSansKR-Regular.ttf'),
];

let fontsRegistered = false;

function ensureFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  try {
    const { registerFont } = require('canvas');
    const fontFile = FONT_CANDIDATES.find(f => fs.existsSync(f));
    if (fontFile) {
      // Register for both weights using the same file.
      // Bold rendering is handled manually via strokeText, not by Cairo font lookup.
      registerFont(fontFile, { family: 'Noto Sans KR', weight: 'normal' });
      registerFont(fontFile, { family: 'Noto Sans KR', weight: 'bold' });
      console.log('[subtitleRenderer] font:', fontFile);
    }
  } catch (e) {
    console.warn('[subtitleRenderer] font registration failed:', e.message);
  }
}

/**
 * Renders a subtitle clip as a transparent PNG buffer at outputWidth × outputHeight.
 * Coordinates are in output-space pixels (same as clip.x / clip.y).
 * @returns {Buffer|null}
 */
function renderSubtitlePng(clip, outputWidth = 1080, outputHeight = 1920) {
  ensureFonts();

  const text = clip.text || '';
  if (!text) return null;

  const { createCanvas } = require('canvas');
  const canvas = createCanvas(outputWidth, outputHeight);
  const ctx    = canvas.getContext('2d');

  // Canvas default is fully transparent — no clearRect needed.

  const fontSize = clip.fontSize || 48;
  const cx       = clip.x != null ? clip.x : outputWidth / 2;
  const cy       = clip.y != null ? clip.y : 200;
  const padding  = clip.backgroundPadding || 16;
  const lineH    = fontSize * 1.3;
  const lines    = text.split('\n');
  const align    = clip.align || 'center';

  // Strip CSS font-family fallbacks; canvas needs an exact family name.
  const rawFamily  = (clip.fontFamily || 'Noto Sans KR').split(',')[0].trim().replace(/['"]/g, '');
  const fontWeight = clip.bold ? 'bold ' : '';
  ctx.font         = `${fontWeight}${fontSize}px "${rawFamily}"`;
  ctx.textAlign    = align;
  ctx.textBaseline = 'top';

  const totalH = lines.length * lineH;
  const maxW   = Math.max(...lines.map(l => ctx.measureText(l).width), 1);

  // ── Background box with border radius ──────────────────────────────────────
  const bgColor = clip.backgroundColor;
  if (bgColor && bgColor !== 'none') {
    const r  = clip.borderRadius || 8;
    const bx = cx - maxW / 2 - padding;
    const by = cy - padding;
    const bw = maxW + padding * 2;
    const bh = totalH + padding * 2;

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
  }

  // ── Drop shadow ────────────────────────────────────────────────────────────
  if (clip.shadow && clip.shadow !== 'none') {
    const p = clip.shadow.split(' ');
    if (p.length >= 4) {
      ctx.shadowOffsetX = parseFloat(p[0]);
      ctx.shadowOffsetY = parseFloat(p[1]);
      ctx.shadowBlur    = parseFloat(p[2]);
      ctx.shadowColor   = p.slice(3).join(' ');
    }
  }

  // ── Text ───────────────────────────────────────────────────────────────────
  const textColor = clip.color || '#ffffff';
  ctx.fillStyle = textColor;

  // Bold: use strokeText + fillText to synthesize weight (Cairo doesn't support variable font axes).
  // Stroke width ≈ 4% of font size mimics the thickness difference between Regular and Bold.
  if (clip.bold) {
    ctx.save();
    ctx.strokeStyle  = textColor;
    ctx.lineWidth    = Math.max(1, fontSize * 0.04);
    ctx.lineJoin     = 'round';
    ctx.shadowColor  = 'transparent'; // avoid shadow doubling on the stroke pass
    lines.forEach((l, i) => ctx.strokeText(l, cx, cy + i * lineH));
    ctx.restore();
  }

  lines.forEach((l, i) => ctx.fillText(l, cx, cy + i * lineH));

  return canvas.toBuffer('image/png');
}

module.exports = { renderSubtitlePng };
