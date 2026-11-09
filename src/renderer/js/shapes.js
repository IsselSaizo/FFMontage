// Фигуры (0.5.0): clip.kind === 'shape' на любой видеодорожке — как текстовый клип: без файла, звука и скорости,
// длина на таймлайне — out − in (in = 0). Положение, масштаб, поворот и прозрачность — обычный clip.transform.
//   clip.shape = { type, w, h, fill, fillOpacity, stroke, strokeWidth, corner }
//     type        — 'rect' (прямоугольник), 'chamfer' (со скошенными углами), 'triangle', 'ellipse' (овал)
//     w, h        — ширина в долях ширины кадра, высота — в долях высоты кадра (до масштаба клипа)
//     fill        — цвет заливки, fillOpacity — её непрозрачность (0 — только контур)
//     stroke      — цвет контура, strokeWidth — толщина в долях высоты кадра (контур — внутри фигуры)
//     corner      — скругление (rect) или срез углов (chamfer) в долях меньшей стороны (0…0.5)
// Рисует фигуру одна функция и для плеера (холст слоя), и для экспорта (PNG кадра + overlay, как у текста).
// Без DOM при импорте: модуль используется окном, экспортом и автотестами.
import { tfOf } from './transform.js';
import { t } from './i18n.js';

export const SHAPE_TYPES = Object.freeze(['rect', 'chamfer', 'triangle', 'ellipse']);
export const SHAPE_MAX = 24 * 3600;
export const SHAPE_DEFAULT_DUR = 5;

export const SHAPE_DEFAULT = Object.freeze({
  type: 'rect',
  w: 0.4,
  h: 0.3,
  fill: '#3b82f6',
  fillOpacity: 1,
  stroke: '#ffffff',
  strokeWidth: 0,
  corner: 0,
});
// [min, max, знаков после запятой]
export const SHAPE_LIMITS = Object.freeze({
  w: [0.005, 2, 4],
  h: [0.005, 2, 4],
  fillOpacity: [0, 1, 2],
  strokeWidth: [0, 0.2, 4],
  corner: [0, 0.5, 3],
});
export const SHAPE_KEYS = Object.freeze(Object.keys(SHAPE_DEFAULT));
// Срез углов по умолчанию у новой фигуры «со скошенными углами» (иначе она — обычный прямоугольник)
export const CHAMFER_DEFAULT = 0.18;

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export const isShape = (c) => !!c && c.kind === 'shape';

/** Название типа фигуры (на таймлайне и в панели) */
export function shapeName(type) {
  switch (type) {
    case 'rect': return t('Прямоугольник');
    case 'chamfer': return t('Скошенные углы');
    case 'triangle': return t('Треугольник');
    case 'ellipse': return t('Овал');
    default: return t('Фигура');
  }
}

/** Полное описание фигуры: patch поверх base (или умолчаний), значения в пределах; неизвестные поля отбрасываются */
export function cleanShape(patch, base = null) {
  const b = { ...SHAPE_DEFAULT, ...(base && typeof base === 'object' ? base : {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  for (const k of SHAPE_KEYS) {
    const def = SHAPE_DEFAULT[k];
    const v = p[k] !== undefined ? p[k] : b[k];
    if (k === 'type') out[k] = SHAPE_TYPES.includes(v) ? v : (SHAPE_TYPES.includes(b[k]) ? b[k] : def);
    else if (typeof def === 'string') out[k] = typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : (COLOR_RE.test(String(b[k])) ? String(b[k]).toLowerCase() : def);
    else {
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number.isFinite(Number(b[k])) ? Number(b[k]) : def;
      const [lo, hi, d] = SHAPE_LIMITS[k];
      out[k] = round(Math.min(hi, Math.max(lo, n)), d);
    }
  }
  return out;
}

/** Только поля, которые отличаются от умолчаний (для MCP) */
export function shapeDiff(sh) {
  const full = cleanShape(sh);
  const out = {};
  for (const k of SHAPE_KEYS) if (full[k] !== SHAPE_DEFAULT[k]) out[k] = full[k];
  return out;
}

/** Описание новой фигуры типа type (срез углов у «скошенной» — сразу виден) */
export function newShape(type, patch = {}) {
  const base = { type: SHAPE_TYPES.includes(type) ? type : 'rect' };
  if (base.type === 'chamfer') base.corner = CHAMFER_DEFAULT;
  if (base.type === 'ellipse' || base.type === 'triangle') { base.w = 0.3; base.h = 0.3 * (16 / 9); }
  return cleanShape(patch, { ...SHAPE_DEFAULT, ...base });
}

const rgba = (hex, a) => {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};

/** Скруглённый прямоугольник w×h с центром в (0, 0) — без roundRect (его нет в старых WebKit) */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rr <= 0.01) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Контур фигуры sh размером w×h пикселей с центром в (0, 0) (текущий путь ctx) */
export function shapePath(ctx, sh, w, h) {
  const m = Math.min(w, h);
  const c = sh.corner * m;
  if (sh.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
  } else if (sh.type === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(0, -h / 2);
    ctx.lineTo(w / 2, h / 2);
    ctx.lineTo(-w / 2, h / 2);
    ctx.closePath();
  } else if (sh.type === 'chamfer' && c > 0.01) {
    const x = w / 2; const y = h / 2;
    ctx.beginPath();
    ctx.moveTo(-x + c, -y); ctx.lineTo(x - c, -y); ctx.lineTo(x, -y + c); ctx.lineTo(x, y - c);
    ctx.lineTo(x - c, y); ctx.lineTo(-x + c, y); ctx.lineTo(-x, y - c); ctx.lineTo(-x, -y + c);
    ctx.closePath();
  } else {
    roundRectPath(ctx, -w / 2, -h / 2, w, h, sh.type === 'rect' ? c : 0);
  }
}

/** Где фигура в кадре W×H: { cx, cy, w, h, rot, opacity } (как contentRect в transform.js; w×h — с масштабом) */
export function shapeRect(clip, W, H) {
  const sh = cleanShape(clip && clip.shape);
  const tf = tfOf(clip);
  return { cx: W / 2 + tf.x * W, cy: H / 2 + tf.y * H, w: sh.w * W * tf.scale, h: sh.h * H * tf.scale, rot: tf.rotate, opacity: tf.opacity };
}

/** Нарисовать фигуру клипа на ctx (холст W×H пикселей; ctx без трансформа) */
export function drawShape(ctx, clip, W, H) {
  const sh = cleanShape(clip && clip.shape);
  const tf = tfOf(clip);
  const w = sh.w * W; const h = sh.h * H;
  ctx.save();
  ctx.translate(W / 2 + tf.x * W, H / 2 + tf.y * H);
  if (tf.rotate) ctx.rotate((tf.rotate * Math.PI) / 180);
  ctx.scale(tf.scale, tf.scale);
  ctx.globalAlpha = tf.opacity;
  shapePath(ctx, sh, w, h);
  if (sh.fillOpacity > 0) {
    ctx.fillStyle = rgba(sh.fill, sh.fillOpacity);
    ctx.fill();
  }
  const sw = sh.strokeWidth * H;
  if (sw > 0) {
    // Контур внутри фигуры: линия двойной толщины, обрезанная по самой фигуре (размер фигуры не растёт)
    ctx.save();
    ctx.clip();
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 10;
    ctx.lineWidth = 2 * sw;
    ctx.strokeStyle = sh.stroke;
    shapePath(ctx, sh, w, h);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Картинка для экспорта: { canvas, w, h, roll: false } — кадр W×H с фигурой на своём месте */
export function renderShapeImage(clip, W, H) {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  drawShape(ctx, clip, W, H);
  return { canvas: cv, w: W, h: H, roll: false };
}
