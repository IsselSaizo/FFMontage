// Обводка и скругление углов видео / картинки (0.5.0): clip.border = { width, color, radius }.
//   width  — толщина цветной обводки в долях высоты кадра проекта (0 — без обводки); обводка — внутри картинки,
//            по её краю, размер картинки не меняется
//   color  — цвет обводки
//   radius — скругление углов в долях высоты кадра (0 — прямые углы); углы картинки за скруглением прозрачны
// Толщина и скругление не зависят от масштаба клипа (как обводка в титрах): уменьшенное видео «картинка в картинке»
// остаётся с той же рамкой. Геометрия — по картинке клипа после кадрирования и подгонки (transform.contentRect).
// Плеер: обводка — рамка-div поверх слоя, скругление — clip-path слоя (preview.js).
// Экспорт: окно рисует PNG обводки и маски точно размера слоя (exportAssets.js) → exportPlan.js: blend (альфа × маска)
// и overlay обводки до прозрачности и поворота слоя.
// Без DOM при импорте.
import { roundRectPath } from './shapes.js';

export const BORDER_DEFAULT = Object.freeze({ width: 0.004, color: '#e2a64b', radius: 0 });
export const BORDER_LIMITS = Object.freeze({ width: [0, 0.05, 4], radius: [0, 0.5, 4] });
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Обводка: patch поверх base; null — ни обводки, ни скругления */
export function cleanBorder(patch, base = null) {
  if (patch === null) return null;
  const b = { ...BORDER_DEFAULT, ...(base && typeof base === 'object' ? base : {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  for (const k of ['width', 'radius']) {
    let n = Number(p[k] !== undefined ? p[k] : b[k]);
    if (!Number.isFinite(n)) n = BORDER_DEFAULT[k];
    const [lo, hi, d] = BORDER_LIMITS[k];
    out[k] = round(Math.min(hi, Math.max(lo, n)), d);
  }
  const c = p.color !== undefined ? p.color : b.color;
  out.color = typeof c === 'string' && COLOR_RE.test(c) ? c.toLowerCase() : BORDER_DEFAULT.color;
  return out.width > 0 || out.radius > 0 ? out : null;
}

/** Обводка клипа (или null): только у клипов с файлом — у текста и фигур своё оформление */
export function borderOf(c) {
  if (!c || c.kind === 'text' || c.kind === 'shape' || c.kind === 'timer' || !c.border) return null;
  return cleanBorder(c.border);
}

/**
 * Толщина и радиус в пикселях для картинки w×h пикселей в кадре высотой H:
 * { bw, r } (радиус не больше половины меньшей стороны, толщина — не больше половины меньшей стороны)
 */
export function borderPx(b, w, h, H) {
  const m = Math.max(0, Math.min(w, h) / 2);
  return { bw: Math.min(m, b.width * H), r: Math.min(m, b.radius * H) };
}

/** Нарисовать обводку картинки w×h (холст w×h, начало — левый верхний угол) */
export function drawBorderRing(ctx, b, w, h, H) {
  const { bw, r } = borderPx(b, w, h, H);
  if (bw <= 0) return;
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, r);
  ctx.clip();
  ctx.lineWidth = 2 * bw;
  ctx.strokeStyle = b.color;
  roundRectPath(ctx, 0, 0, w, h, r);
  ctx.stroke();
  ctx.restore();
}

/** Маска скругления: белый скруглённый прямоугольник w×h на прозрачном */
export function drawBorderMask(ctx, b, w, h, H) {
  const { r } = borderPx(b, w, h, H);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  roundRectPath(ctx, 0, 0, w, h, r);
  ctx.fill();
  ctx.restore();
}

const canvasOf = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** Картинки для экспорта слоя w×h: { ring: canvas|null, mask: canvas|null } */
export function renderBorderImages(b, w, h, H) {
  const { bw, r } = borderPx(b, w, h, H);
  let ring = null; let mask = null;
  if (bw > 0) { ring = canvasOf(w, h); drawBorderRing(ring.getContext('2d'), b, w, h, H); }
  if (r > 0.01) { mask = canvasOf(w, h); drawBorderMask(mask.getContext('2d'), b, w, h, H); }
  return { ring, mask };
}
