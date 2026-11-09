// Отрисовка текстового клипа на холсте (M5.1, решение D2): одна функция и для плеера, и для экспорта —
// что видно в плеере, то и в файле. Экспорт: холст → PNG (кадр W×H, у титров «roll» — полоса W×h) → overlay в FFmpeg.
// Геометрия — как у transform.js: центр блока = центр кадра + (x·W, y·H), масштаб и поворот вокруг центра.
import { cleanText } from './textModel.js';
import { tfOf } from './transform.js';
import { tlLen } from './clipTime.js';
import { registerGraphic } from './graphics.js';

let measure = null;
const mctx = () => {
  if (!measure) measure = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas')).getContext('2d');
  return measure;
};

// Список шрифтов для CSS font: выбранный → встроенный Inter → системный
export const fontFamilies = (font) => `"${font}", "Inter", sans-serif`;
export const fontCss = (tx, px) => `${tx.italic ? 'italic ' : ''}${tx.weight} ${Math.max(1, px).toFixed(2)}px ${fontFamilies(tx.font)}`;

const rgba = (hex, a) => {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};

function setFont(ctx, tx, px) {
  ctx.font = fontCss(tx, px);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(tx.letterSpacing * px).toFixed(2)}px`;
  ctx.fontKerning = 'normal';
}

// Перенос по словам: строки не шире maxW (одно длинное слово не режется)
function wrapLines(ctx, content, maxW) {
  const out = [];
  for (const para of content.split('\n')) {
    if (!maxW || !para.trim()) { out.push(para); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && ctx.measureText(next.trimEnd()).width > maxW) { out.push(line.trimEnd()); line = w.trimStart(); } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Раскладка текста в пикселях кадра W×H (без масштаба и поворота клипа):
 * { tx, px, lines: [{ text, w }], adv, asc, desc, blockW, blockH, sw, pad, boxW, boxH }
 */
export function layoutText(clip, W, H) {
  const tx = cleanText(clip && clip.text);
  const ctx = mctx();
  const px = tx.size * H;
  setFont(ctx, tx, px);
  const texts = wrapLines(ctx, tx.content || ' ', tx.wrap > 0 ? tx.wrap * W : 0);
  const lines = texts.map((s) => ({ text: s, w: s ? ctx.measureText(s).width : 0 }));
  const m = ctx.measureText('HgЙ'); // i18n-ignore
  const asc = m.fontBoundingBoxAscent || px * 0.9;
  const desc = m.fontBoundingBoxDescent || px * 0.25;
  const adv = tx.lineHeight * px;
  const blockW = Math.max(1, ...lines.map((l) => l.w));
  const blockH = Math.max(1, lines.length) * adv;
  const sw = tx.strokeWidth * px;
  const pad = tx.box ? tx.boxPad * px : 0;
  return { tx, px, lines, adv, asc, desc, blockW, blockH, sw, pad, boxW: blockW + 2 * pad + 2 * sw, boxH: blockH + 2 * pad + 2 * sw };
}

// Титры «roll»: верх блока едет от низа кадра (local = 0) до положения «весь блок выше кадра» (local = длина клипа)
export function rollTop(clip, H, stripH, local) {
  const len = Math.max(0.05, tlLen(clip));
  return H - (Math.max(0, Math.min(len, local)) / len) * (H + stripH);
}
// Высота полосы титров в пикселях кадра (блок с масштабом клипа)
export function rollStripH(clip, W, H) {
  const L = layoutText(clip, W, H);
  // чётная высота — для yuva420p в экспорте
  return Math.min(4 * H, Math.ceil((L.boxH * tfOf(clip).scale + 4) / 2) * 2);
}

/**
 * Где текст в кадре W×H: { cx, cy, w, h, rot, opacity } (как contentRect в transform.js; w×h — с масштабом).
 * local — время от начала клипа (нужно для титров «roll»).
 */
export function textRect(clip, W, H, local = 0) {
  const L = layoutText(clip, W, H);
  const tf = tfOf(clip);
  let cy = H / 2 + tf.y * H;
  let rot = tf.rotate;
  if (L.tx.motion === 'roll') {
    const sh = rollStripH(clip, W, H);
    cy = rollTop(clip, H, sh, local) + sh / 2;
    rot = 0;
  }
  return { cx: W / 2 + tf.x * W, cy, w: L.boxW * tf.scale, h: L.boxH * tf.scale, rot, opacity: tf.opacity };
}

/**
 * Нарисовать текст клипа на ctx (холст W×H пикселей; ctx без трансформа).
 * opts.local — время от начала клипа; opts.strip — рисовать для полосы титров (центр по высоте полосы).
 */
export function drawText(ctx, clip, W, H, { local = 0, strip = false } = {}) {
  const L = layoutText(clip, W, H);
  const { tx, px } = L;
  const tf = tfOf(clip);
  const s = tf.scale;
  const roll = tx.motion === 'roll';
  const cx = W / 2 + tf.x * W;
  let cy = H / 2 + tf.y * H;
  if (roll) {
    const sh = rollStripH(clip, W, H);
    cy = strip ? ctx.canvas.height / 2 : rollTop(clip, H, sh, local) + sh / 2;
  }
  ctx.save();
  ctx.translate(cx, cy);
  if (!roll && tf.rotate) ctx.rotate((tf.rotate * Math.PI) / 180);
  ctx.scale(s, s);
  ctx.globalAlpha = tf.opacity;
  // Подложка
  if (tx.box && tx.boxOpacity > 0) {
    ctx.fillStyle = rgba(tx.boxColor, tx.boxOpacity);
    const r = Math.min(tx.boxRadius * px, L.boxW / 2, L.boxH / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-L.boxW / 2, -L.boxH / 2, L.boxW, L.boxH, r);
    else ctx.rect(-L.boxW / 2, -L.boxH / 2, L.boxW, L.boxH);
    ctx.fill();
  }
  setFont(ctx, tx, px);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const top = -L.blockH / 2;
  const pos = L.lines.map((l, i) => {
    const x = tx.align === 'left' ? -L.blockW / 2 : tx.align === 'right' ? L.blockW / 2 - l.w : -l.w / 2;
    const y = top + i * L.adv + (L.adv - (L.asc + L.desc)) / 2 + L.asc;
    return [l.text, x, y];
  });
  // Тень — в пикселях холста (на неё трансформ не действует), поэтому умножаем на масштаб сами
  const shadow = (on) => {
    if (on && tx.shadowOpacity > 0) {
      ctx.shadowColor = rgba(tx.shadowColor, tx.shadowOpacity * tf.opacity);
      ctx.shadowBlur = tx.shadowBlur * px * s;
      ctx.shadowOffsetX = tx.shadowX * px * s;
      ctx.shadowOffsetY = tx.shadowY * px * s;
    } else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
  };
  if (L.sw > 0) {
    shadow(true);
    ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    ctx.lineWidth = 2 * L.sw;
    ctx.strokeStyle = tx.strokeColor;
    for (const [s2, x, y] of pos) if (s2) ctx.strokeText(s2, x, y);
    shadow(false);
  } else shadow(true);
  ctx.fillStyle = tx.color;
  for (const [s2, x, y] of pos) if (s2) ctx.fillText(s2, x, y);
  ctx.restore();
}

/**
 * Картинка для экспорта: { canvas, w, h, roll } — кадр W×H с текстом на своём месте,
 * а у титров «roll» — полоса W×h (по вертикали её двигает overlay).
 */
export function renderTextImage(clip, W, H) {
  const roll = cleanText(clip && clip.text).motion === 'roll';
  const h = roll ? rollStripH(clip, W, H) : H;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, h) : Object.assign(document.createElement('canvas'), { width: W, height: h });
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, h);
  drawText(ctx, clip, W, H, { strip: roll });
  return { canvas: cv, w: W, h, roll };
}

/** Дождаться загрузки шрифтов, которыми нарисован текст (иначе первый кадр — запасным шрифтом) */
export async function ensureFonts(clips) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const want = new Set();
  for (const c of clips) {
    const tx = cleanText(c.text);
    want.add(fontCss(tx, 40));
  }
  await Promise.all([...want].map((f) => document.fonts.load(f, 'AaЯя').catch(() => null))); // i18n-ignore
}

// Вид 'text' (graphics.js): рисунок, рамка гизмо и картинка для экспорта
registerGraphic('text', {
  rect: (clip, W, H, local = 0) => textRect(clip, W, H, local),
  draw: (ctx, clip, W, H, local = 0) => drawText(ctx, clip, W, H, { local }),
  animated: (clip) => cleanText(clip && clip.text).motion === 'roll',
  async exportAsset(clip, env) {
    await ensureFonts([clip]);
    const img = renderTextImage(clip, env.W, env.H);
    return { path: await env.save('png', await env.pngBase64(img.canvas)), w: img.w, h: img.h, roll: img.roll };
  },
});
