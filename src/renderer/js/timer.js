// Таймер (0.5.0): clip.kind === 'timer' на любой видеодорожке — секундомер на прозрачном фоне: сектор и стрелка
// показывают прошедшее время, цифры — обратный или прямой отсчёт; когда время вышло — анимация звонка (без звука).
//   clip.timer = { duration, mode, style, ring, progress, digits, size, colors }
//     duration — время отсчёта, с
//     mode     — 'down' (обратный отсчёт) | 'up' (прямой)
//     style    — рисунок (timerStyles.js): 'classic' | 'digital' | 'retro'
//     ring     — звонок, когда время вышло: 'once' (один раз, клип = отсчёт + RING_DUR), 'loop' (повторяется до конца
//                клипа), 'none' (нет, клип = отсчёт); после звонка — последний кадр отсчёта
//     progress — сектор: 'elapsed' (закрашено прошедшее) | 'remaining' (закрашен остаток)
//     digits   — показывать цифры
//     size     — высота рисунка в долях высоты кадра (до масштаба клипа)
//     colors   — { case, face, fill, ink, accent, digits }; при смене стиля — цвета нового стиля
// Положение, масштаб, поворот, прозрачность — обычный clip.transform.
//
// Рисует таймер одна функция для плеера и экспорта — по слоям (timerStyles.js): картинки слоёв из SVG (кэш, грузятся
// асинхронно — пока не готовы, drawTimer возвращает false и после загрузки зовёт bumpGraphics → плеер перерисует),
// сектор — из двух повёрнутых половинок с обрезкой, стрелка — поворот, цифры — Inter в ячейках постоянной ширины,
// звонок — кадры SVG с частотой RING_FPS. Экспорт собирает те же слои (exportAssets.js / exportPlan.js).
import { tfOf } from './transform.js';
import { t } from './i18n.js';
import { registerGraphic, bumpGraphics } from './graphics.js';
import {
  RING_DUR, TIMER_STYLES, fmtFor, fmtTime, cells, styleOf, stylePalette, layerSvgs, ringSvgs,
} from './timerStyles.js';

export { RING_DUR, TIMER_STYLES, fmtFor, fmtTime, cells };
export const RING_FPS = 30;
export const TIMER_MAX = 3 * 3600;
export const TIMER_MODES = Object.freeze(['down', 'up']);
export const TIMER_RINGS = Object.freeze(['once', 'loop', 'none']);
export const TIMER_PROGRESS = Object.freeze(['elapsed', 'remaining']);
export const COLOR_KEYS = Object.freeze(['case', 'face', 'fill', 'ink', 'accent', 'digits']);
export const TIMER_DEFAULT = Object.freeze({
  duration: 10,
  mode: 'down',
  style: 'classic',
  ring: 'once',
  progress: 'elapsed',
  digits: true,
  size: 0.42,
  colors: Object.freeze(stylePalette('classic')),
});
const LIMITS = { duration: [1, TIMER_MAX, 2], size: [0.05, 1.5, 3] };
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const pick = (list, v, b, def) => (list.includes(v) ? v : list.includes(b) ? b : def);

export const isTimer = (c) => !!c && c.kind === 'timer';

/** Полные настройки таймера: patch поверх base, значения в пределах. Сменился стиль и цвета не заданы — цвета стиля. */
export function cleanTimer(patch, base = null) {
  const b = { ...TIMER_DEFAULT, ...(base && typeof base === 'object' ? base : {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const v = (k) => (p[k] !== undefined ? p[k] : b[k]);
  const out = {};
  for (const k of ['duration', 'size']) {
    let n = Number(v(k));
    if (!Number.isFinite(n)) n = Number.isFinite(Number(b[k])) ? Number(b[k]) : TIMER_DEFAULT[k];
    const [lo, hi, d] = LIMITS[k];
    out[k] = round(Math.min(hi, Math.max(lo, n)), d);
  }
  out.mode = pick(TIMER_MODES, v('mode'), b.mode, TIMER_DEFAULT.mode);
  out.style = pick(TIMER_STYLES, v('style'), b.style, TIMER_DEFAULT.style);
  out.ring = pick(TIMER_RINGS, v('ring'), b.ring, TIMER_DEFAULT.ring);
  out.progress = pick(TIMER_PROGRESS, v('progress'), b.progress, TIMER_DEFAULT.progress);
  const dg = v('digits');
  out.digits = dg === true || dg === 1 || dg === 'true';
  const pal = stylePalette(out.style);
  const styleChanged = p.style !== undefined && TIMER_STYLES.includes(b.style) && out.style !== b.style;
  const baseColors = styleChanged ? pal : { ...pal, ...(b.colors && typeof b.colors === 'object' ? b.colors : {}) };
  const pc = p.colors && typeof p.colors === 'object' ? p.colors : {};
  out.colors = {};
  for (const k of COLOR_KEYS) {
    const c = pc[k] !== undefined ? pc[k] : baseColors[k];
    out.colors[k] = typeof c === 'string' && COLOR_RE.test(c) ? c.toLowerCase() : pal[k];
  }
  return out;
}

/**
 * Длина клипа, которую задают настройки (clipLen — текущая длина клипа или undefined у нового):
 * 'once' — отсчёт + звонок; 'none' — отсчёт; 'loop' — не короче отсчёта + полутора звонков (новый — + три звонка).
 */
export function timerClipLen(tm, clipLen = undefined) {
  const x = cleanTimer(tm);
  if (x.ring === 'none') return x.duration;
  if (x.ring === 'once') return x.duration + RING_DUR;
  const min = x.duration + RING_DUR * 1.5;
  return Number.isFinite(clipLen) && clipLen >= min ? clipLen : x.duration + RING_DUR * 3;
}

/** «1:05», «0:07», «1:02:03» — для названий */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

/**
 * Что показывать в момент local (с от начала клипа): { p (0…1 прошло), text, ringing, u (с от начала звонка) }.
 * Обратный отсчёт: 10 → … → 1 → 0 (целая секунда вверх, как у кухонного таймера); прямой: 0 → … → 10.
 */
export function timerState(tm, local) {
  const d = tm.duration;
  const l = Math.max(0, local);
  const fmt = fmtFor(d);
  if (l < d) {
    const shown = tm.mode === 'down' ? Math.ceil(d - l - 1e-6) : Math.min(d, Math.floor(l + 1e-6));
    return { p: l / d, text: fmtTime(shown, fmt), ringing: false, u: 0 };
  }
  const text = fmtTime(tm.mode === 'down' ? 0 : d, fmt);
  const after = l - d;
  const u = tm.ring === 'loop' ? after % RING_DUR : tm.ring === 'once' && after < RING_DUR ? after : null;
  return { p: 1, text, ringing: u !== null, u: u ?? 0 };
}

/** Кадр звонка (номер) в момент u */
export const ringFrame = (u) => Math.max(0, Math.min(Math.round(RING_DUR * RING_FPS) - 1, Math.floor(u * RING_FPS + 1e-6)));

// ---------------------------------------------------------------------------
// Геометрия
// ---------------------------------------------------------------------------
/**
 * Таймер клипа в кадре W×H: { tm, k (пикселей на единицу viewBox), cx, cy (центр рисунка), rot, opacity,
 * viewBox, pivot, spin, fmt, w, h (рамка без поворота) }
 */
export function timerGeom(clip, W, H) {
  const tm = cleanTimer(clip && clip.timer);
  const tf = tfOf(clip);
  const s = styleOf(tm.style);
  const [, , vw, vh] = s.viewBox;
  const k = (tm.size * H * tf.scale) / vh;
  return {
    tm, k, cx: W / 2 + tf.x * W, cy: H / 2 + tf.y * H, rot: tf.rotate, opacity: tf.opacity,
    viewBox: s.viewBox, pivot: s.pivot, spin: s.spin, fmt: fmtFor(tm.duration), w: vw * k, h: vh * k,
  };
}

/** Где таймер в кадре W×H: { cx, cy, w, h, rot, opacity } — как contentRect / textRect */
export function timerRect(clip, W, H) {
  const g = timerGeom(clip, W, H);
  return { cx: g.cx, cy: g.cy, w: g.w, h: g.h, rot: g.rot, opacity: g.opacity };
}

/** Рамка кадров для экспорта: квадрат, в который таймер помещается при любом повороте (чётные размеры) */
export function timerBox(clip, W, H) {
  const r = timerRect(clip, W, H);
  const side = Math.min(4 * Math.max(W, H), Math.ceil((Math.hypot(r.w, r.h) * 1.04 + 8) / 2) * 2);
  return { x: Math.round(r.cx - side / 2), y: Math.round(r.cy - side / 2), w: side, h: side };
}

/** ctx → единицы viewBox таймера (центр рисунка — в центре клипа, поворот, прозрачность, масштаб) */
export function toTimerUnits(ctx, g) {
  const [vx, vy, vw, vh] = g.viewBox;
  ctx.translate(g.cx, g.cy);
  if (g.rot) ctx.rotate((g.rot * Math.PI) / 180);
  ctx.globalAlpha *= g.opacity;
  ctx.scale(g.k, g.k);
  ctx.translate(-(vx + vw / 2), -(vy + vh / 2));
}

// ---------------------------------------------------------------------------
// Картинки слоёв (SVG → Image, кэш по стилю, цветам, формату цифр и виду сектора)
// ---------------------------------------------------------------------------
const CACHE = new Map();   // ключ → { layers: { имя: Image|null }, digits, ring: Map(кадр → { under, over, pose, digits }) }
const CACHE_MAX = 24;
const hasImage = () => typeof Image !== 'undefined';

function svgImage(svg) {
  if (!svg || !hasImage()) return null;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => bumpGraphics();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img;
}
const ok = (img) => !img || (img.complete && img.naturalWidth > 0);

const P_OF = (tm) => ({ fmt: fmtFor(tm.duration), progress: tm.progress, digits: tm.digits });
const keyOf = (tm) => `${tm.style}|${COLOR_KEYS.map((k) => tm.colors[k]).join(',')}|${fmtFor(tm.duration)}|${tm.progress}|${tm.digits ? 1 : 0}`;

/** Набор картинок таймера tm (создаётся при первом обращении) */
export function timerAssets(tm) {
  const key = keyOf(tm);
  let a = CACHE.get(key);
  if (a) { CACHE.delete(key); CACHE.set(key, a); return a; }   // свежий — в конец (LRU)
  const svgs = layerSvgs(tm.style, tm.colors, P_OF(tm));
  const layers = {};
  for (const n of ['back', 'front', 'cap', 'hand', 'halfL', 'halfR', 'rightOv', 'base']) layers[n] = svgImage(svgs[n]);
  a = { key, tm, layers, svgs, digits: svgs.digits, ring: new Map() };
  CACHE.set(key, a);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return a;
}
/** Картинки кадра звонка n (создаются при первом обращении) */
export function ringAssets(a, n) {
  let r = a.ring.get(n);
  if (!r) {
    const x = ringSvgs(a.tm.style, a.tm.colors, P_OF(a.tm), n / RING_FPS);
    r = { under: svgImage(x.under), over: svgImage(x.over), pose: x.pose, digits: x.digits, svgs: x };
    a.ring.set(n, r);
  }
  return r;
}
export const layersReady = (a) => Object.values(a.layers).every(ok);
export const ringReady = (r) => ok(r.under) && ok(r.over);

/** Дождаться картинок слоёв (и кадров звонка, если ring) и шрифта цифр — перед экспортом и в автотестах */
export async function timerReady(tm, { ring = false } = {}) {
  const a = timerAssets(cleanTimer(tm));
  const imgs = Object.values(a.layers).filter(Boolean);
  if (ring) for (let n = 0; n < Math.round(RING_DUR * RING_FPS); n++) { const r = ringAssets(a, n); imgs.push(...[r.under, r.over].filter(Boolean)); }
  await Promise.all(imgs.map((img) => (ok(img) ? null : img.decode().catch(() => null))));
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.load('700 40px "Inter"', '0123456789:').catch(() => null);
  return a;
}

// ---------------------------------------------------------------------------
// Рисование (ctx — в единицах viewBox, см. toTimerUnits)
// ---------------------------------------------------------------------------
/** Нарисовать картинку слоя во весь viewBox (статичные) или в квадрате spin вокруг pivot (вращающиеся) */
export function drawLayer(ctx, a, name) {
  const img = a.layers[name];
  if (!img) return;
  const s = styleOf(a.tm.style);
  if (name === 'back' || name === 'front' || name === 'cap') {
    const [vx, vy, vw, vh] = s.viewBox;
    ctx.drawImage(img, vx, vy, vw, vh);
  } else {
    const S = s.spin;
    ctx.drawImage(img, s.pivot[0] - S, s.pivot[1] - S, 2 * S, 2 * S);
  }
}

/** Сектор из половинок (как в экспорте): θ = 360°·p */
export function drawProgress(ctx, a, p) {
  const s = styleOf(a.tm.style);
  const [px, py] = s.pivot; const S = s.spin;
  const th = 360 * Math.max(0, Math.min(1, p));
  const rotImg = (img, deg, clipX) => {
    if (!img) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(clipX, py - S, S, 2 * S); ctx.clip();
    ctx.translate(px, py); ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -S, -S, 2 * S, 2 * S);
    ctx.restore();
  };
  drawLayer(ctx, a, 'base');
  if (th >= 180) drawLayer(ctx, a, 'rightOv');
  else if (th > 0.01) rotImg(a.layers.halfL, th, px);
  if (th > 180.01) rotImg(a.layers.halfR, th - 180, px - S);
}

/** Стрелка, повёрнутая на θ = 360°·p вокруг pivot */
export function drawHand(ctx, a, p) {
  const s = styleOf(a.tm.style);
  const img = a.layers.hand;
  if (!img) return;
  const S = s.spin;
  ctx.save();
  ctx.translate(s.pivot[0], s.pivot[1]);
  ctx.rotate((360 * p * Math.PI) / 180);
  ctx.drawImage(img, -S, -S, 2 * S, 2 * S);
  ctx.restore();
}

/** Цифры text в ячейках формата fmt: d = { cx, cy, fs, color } (единицы viewBox) */
export function drawDigits(ctx, d, text, fmt, color = d.color) {
  const c = cells(fmt, d.fs);
  const x0 = d.cx - c.width / 2;
  ctx.save();
  ctx.font = `700 ${d.fs}px "Inter", "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  c.list.forEach((cell, i) => { if (text[i]) ctx.fillText(text[i], x0 + cell.x, d.cy); });
  ctx.restore();
}

function applyPose(ctx, ops) {
  for (const o of ops) {
    if (o[0] === 't') ctx.translate(o[1], o[2]);
    else if (o[0] === 's') ctx.scale(o[1], o[2]);
    else { ctx.translate(o[2], o[3]); ctx.rotate((o[1] * Math.PI) / 180); ctx.translate(-o[2], -o[3]); }
  }
}

/** Кадр звонка n (ctx — в единицах viewBox); false — картинки ещё грузятся */
export function drawRing(ctx, a, n, text) {
  const r = ringAssets(a, n);
  if (!ringReady(r)) return false;
  const [vx, vy, vw, vh] = styleOf(a.tm.style).viewBox;
  ctx.drawImage(r.under, vx, vy, vw, vh);
  if (r.digits.show) {
    ctx.save();
    applyPose(ctx, r.pose);
    drawDigits(ctx, r.digits, text, fmtFor(a.tm.duration));
    ctx.restore();
  }
  if (r.over) ctx.drawImage(r.over, vx, vy, vw, vh);
  return true;
}

/** Таймер в состоянии st (ctx — в единицах viewBox); false — картинки ещё грузятся (ничего не нарисовано) */
export function drawTimerUnits(ctx, a, st) {
  if (st.ringing) {
    const n = ringFrame(st.u);
    if (drawRing(ctx, a, n, st.text)) return true;
    // Кадр звонка ещё не готов — пока последний кадр отсчёта
    for (let i = 0; i < Math.round(RING_DUR * RING_FPS); i++) ringAssets(a, i);   // подготовить весь звонок
  }
  if (!layersReady(a)) return false;
  drawLayer(ctx, a, 'back');
  drawProgress(ctx, a, st.p);
  drawLayer(ctx, a, 'front');
  drawHand(ctx, a, st.p);
  drawLayer(ctx, a, 'cap');
  if (a.digits.show) drawDigits(ctx, a.digits, st.text, fmtFor(a.tm.duration));
  return true;
}

/** Нарисовать таймер клипа на ctx (холст кадра W×H пикселей; ctx без трансформа). local — с от начала клипа. */
export function drawTimer(ctx, clip, W, H, local = 0) {
  const g = timerGeom(clip, W, H);
  if (!hasImage()) return false;
  const a = timerAssets(g.tm);
  ctx.save();
  toTimerUnits(ctx, g);
  const done = drawTimerUnits(ctx, a, timerState(g.tm, local));
  ctx.restore();
  return done;
}

/** Название стиля */
export function timerStyleName(id) {
  switch (id) {
    case 'digital': return t('Цифровой');
    case 'retro': return t('Ретро');
    default: return t('Классический');
  }
}

// ---------------------------------------------------------------------------
// Анимированный PNG из кадров-PNG одинакового размера (для экспорта; FFmpeg читает его демультиплексором apng)
// ---------------------------------------------------------------------------
let CRC = null;
function crc32(bytes, start, end) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunks(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let p = 8; p + 8 <= png.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    out.push({ type, data: png.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}
function chunk(type, data) {
  const b = new Uint8Array(12 + data.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.set(data, 8);
  dv.setUint32(8 + data.length, crc32(b, 4, 8 + data.length));
  return b;
}

/**
 * frames — массив PNG (Uint8Array) одного размера; delays — длительность каждого кадра, с (или одно число — частота
 * кадров для всех). → Uint8Array APNG (проигрывается один раз). Каждый кадр целиком заменяет предыдущий.
 */
export function makeApng(frames, delays) {
  if (!frames.length) throw new Error('no frames');
  const first = chunks(frames[0]);
  const ihdr = first.find((c) => c.type === 'IHDR');
  const W = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(0);
  const H = new DataView(ihdr.data.buffer, ihdr.data.byteOffset).getUint32(4);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr.data)];
  const actl = new Uint8Array(8); const ad = new DataView(actl.buffer);
  ad.setUint32(0, frames.length); ad.setUint32(4, 1);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  frames.forEach((png, i) => {
    const sec = Array.isArray(delays) ? delays[i] : 1 / delays;
    const fc = new Uint8Array(26); const fd = new DataView(fc.buffer);
    fd.setUint32(0, seq++); fd.setUint32(4, W); fd.setUint32(8, H); fd.setUint32(12, 0); fd.setUint32(16, 0);
    // задержка = num / den секунды (миллисекунды; длинные — в сотых)
    const ms = Math.max(1, Math.round(sec * 1000));
    if (ms <= 65535) { fd.setUint16(20, ms); fd.setUint16(22, 1000); } else { fd.setUint16(20, Math.min(65535, Math.round(sec * 100))); fd.setUint16(22, 100); }
    fc[24] = 0; fc[25] = 0;                           // dispose NONE, blend SOURCE
    parts.push(chunk('fcTL', fc));
    for (const c of chunks(png)) {
      if (c.type !== 'IDAT') continue;
      if (i === 0) parts.push(chunk('IDAT', c.data));
      else {
        const d = new Uint8Array(4 + c.data.length);
        new DataView(d.buffer).setUint32(0, seq++);
        d.set(c.data, 4);
        parts.push(chunk('fdAT', d));
      }
    }
  });
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Моменты кадров анимации для экспорта клипа длиной len (с): [{ t, d }] — время кадра от начала клипа и его длительность.
 * Отсчёт — около 900 кадров (не чаще частоты проекта и 30 в секунду; у длинных таймеров — реже, но не реже 1 в секунду:
 * цифры меняются каждую секунду), после отсчёта — с частотой проекта (до 30). Совпадающие кадры склеивает вызывающий.
 */
export function timerFrameTimes(tm, len, fps) {
  const full = Math.max(1, Math.min(30, Math.round(fps) || 30));
  const cnt = Math.min(len, tm.duration);
  const cf = Math.max(1, Math.min(full, Math.floor(900 / Math.max(1, cnt))));
  const out = [];
  const n1 = Math.max(1, Math.ceil(cnt * cf - 1e-6));
  for (let i = 0; i < n1; i++) out.push({ t: i / cf, d: Math.min(1 / cf, cnt - i / cf) });
  if (len > cnt + 1e-6) {
    const n2 = Math.ceil((len - cnt) * full - 1e-6);
    for (let i = 0; i < n2; i++) out.push({ t: cnt + i / full, d: Math.min(1 / full, len - cnt - i / full) });
  }
  return out.filter((x) => x.d > 1e-6);
}

// Вид 'timer' (graphics.js); плитки «Библиотеки» — по два отсчёта на стиль и прямой отсчёт
const LIBRARY = [
  ['classic', 10, 'down'], ['classic', 60, 'down'],
  ['digital', 10, 'down'], ['digital', 60, 'down'], ['digital', 30, 'up'],
  ['retro', 10, 'down'], ['retro', 60, 'down'],
];
registerGraphic('timer', {
  field: 'timer',
  title: () => t('Таймер'),
  libraryTitle: () => t('Таймеры'),
  clean: cleanTimer,
  defaultDur: TIMER_DEFAULT.duration + RING_DUR,
  length: (tm, clip) => timerClipLen(tm, clip && Number.isFinite(clip.out) ? clip.out - (clip.in || 0) : undefined),
  name: (c) => t('Таймер {time}', { time: fmtClock(cleanTimer(c && c.timer).duration) }),
  rect: timerRect,
  draw: (ctx, clip, W, H, local = 0) => drawTimer(ctx, clip, W, H, local),
  animated: () => true,
  // Кадры в рамке вокруг таймера → анимированный PNG (одинаковые подряд кадры склеиваются)
  async exportAsset(clip, env) {
    await timerReady(clip.timer, { ring: true });
    const box = timerBox(clip, env.W, env.H);
    const cv = env.canvas(box.w, box.h);
    const ctx = cv.getContext('2d');
    const len = Math.max(0.05, clip.out - clip.in);
    const frames = []; const delays = []; let prev = '';
    for (const f of timerFrameTimes(cleanTimer(clip.timer), len, env.fps)) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, box.w, box.h);
      ctx.translate(-box.x, -box.y);
      drawTimer(ctx, clip, env.W, env.H, f.t);
      const png = await env.pngBytes(cv);
      const key = await env.digest(png);
      if (key === prev) { delays[delays.length - 1] += f.d; continue; }
      prev = key; frames.push(png); delays.push(f.d);
    }
    const path = await env.save('apng', env.bytesBase64(makeApng(frames, delays)));
    return { path, w: box.w, h: box.h, x: box.x, y: box.y, roll: false, anim: true };
  },
  library: LIBRARY.map(([style, s, mode]) => ({
    id: `timer.${style}.${mode}${s}`,
    group: () => timerStyleName(style),
    title: () => (mode === 'down' ? t('Обратный {time}', { time: fmtClock(s) }) : t('Прямой {time}', { time: fmtClock(s) })),
    data: () => cleanTimer({ duration: s, mode, style }),
    thumbAt: (tm) => tm.duration * 0.4,
    // Миниатюра: рисунок почти во всю высоту плитки (у рисунков поля под звонок)
    thumbTransform: { scale: 2.6 },
  })),
});
