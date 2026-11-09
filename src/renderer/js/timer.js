// Таймер (0.5.0): clip.kind === 'timer' на любой видеодорожке — секундомер на прозрачном фоне: сектор и стрелка
// показывают прошедшее время, цифры — обратный или прямой отсчёт; когда время вышло — анимация звонка
// (секундомер трясётся и подпрыгивает, от кнопки расходятся «звуковые» штрихи; звука нет).
//   clip.timer = { duration, mode, digits, size, caseColor, faceColor, fillColor, inkColor }
//     duration — время отсчёта, с; клип на таймлайне = duration + RING_DUR (звонок); короче — звонка не будет
//     mode     — 'down' (обратный отсчёт) | 'up' (прямой)
//     digits   — показывать цифры под секундомером
//     size     — высота всего рисунка в долях высоты кадра (до масштаба клипа)
// Положение, масштаб, поворот, прозрачность — обычный clip.transform; рисует одна функция для плеера и экспорта.
// Экспорт: окно рисует кадры в рамке вокруг таймера и собирает анимированный PNG (makeApng) → overlay в FFmpeg.
// Без DOM при импорте: модуль используется окном, экспортом и автотестами.
import { tfOf } from './transform.js';

export const RING_DUR = 1.6;
export const TIMER_MAX = 3 * 3600;
export const TIMER_DEFAULT = Object.freeze({
  duration: 10,
  mode: 'down',
  digits: true,
  size: 0.42,
  caseColor: '#f06b93',
  faceColor: '#d9f1fb',
  fillColor: '#ffc2c2',
  inkColor: '#1d3557',
});
export const TIMER_MODES = Object.freeze(['down', 'up']);
const LIMITS = { duration: [1, TIMER_MAX, 2], size: [0.05, 1.5, 3] };
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export const isTimer = (c) => !!c && c.kind === 'timer';

/** Полные настройки таймера: patch поверх base, значения в пределах */
export function cleanTimer(patch, base = null) {
  const b = { ...TIMER_DEFAULT, ...(base && typeof base === 'object' ? base : {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  for (const [k, def] of Object.entries(TIMER_DEFAULT)) {
    const v = p[k] !== undefined ? p[k] : b[k];
    if (k === 'mode') out[k] = TIMER_MODES.includes(v) ? v : (TIMER_MODES.includes(b[k]) ? b[k] : def);
    else if (typeof def === 'boolean') out[k] = v === true || v === 1 || v === 'true';
    else if (typeof def === 'string') out[k] = typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : (COLOR_RE.test(String(b[k])) ? String(b[k]).toLowerCase() : def);
    else {
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number.isFinite(Number(b[k])) ? Number(b[k]) : def;
      const [lo, hi, d] = LIMITS[k];
      out[k] = round(Math.min(hi, Math.max(lo, n)), d);
    }
  }
  return out;
}

/** Длина клипа на таймлайне для таймера tm: отсчёт + звонок */
export const timerClipLen = (tm) => cleanTimer(tm).duration + RING_DUR;

/** «1:05», «0:07», «1:02:03» */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

/** Что показывать в момент local (секунды от начала клипа): { p (0…1 прошло), text, ringing, u (с от начала звонка) } */
export function timerState(tm, local) {
  const d = tm.duration;
  const l = Math.max(0, local);
  const ringing = l >= d;
  const p = Math.min(1, l / d);
  // Обратный отсчёт: 10 → … → 1 → 0 (целая секунда вверх, как у кухонного таймера); прямой: 0 → … → 10
  const shown = tm.mode === 'down' ? (ringing ? 0 : Math.ceil(d - l - 1e-6)) : Math.min(d, Math.floor(l + 1e-6));
  return { p, text: fmtClock(shown), ringing, u: ringing ? l - d : 0 };
}

// Рисунок в единицах: радиус корпуса = 1; по высоте от верха кнопки (−1.62) до низа корпуса (1.05) и цифр (+0.62)
const TOP = -1.62;
const BOTTOM = 1.06;
const DIGITS_H = 0.62;
const unitH = (tm) => BOTTOM - TOP + (tm.digits ? DIGITS_H : 0);

/** Где таймер в кадре W×H (без тряски): { cx, cy, w, h, rot, opacity } — как contentRect / textRect */
export function timerRect(clip, W, H) {
  const tm = cleanTimer(clip && clip.timer);
  const tf = tfOf(clip);
  const k = (tm.size * H * tf.scale) / unitH(tm);   // пикселей на единицу
  const w = 2.2 * k; const h = unitH(tm) * k;
  return { cx: W / 2 + tf.x * W, cy: H / 2 + tf.y * H, w, h, rot: tf.rotate, opacity: tf.opacity };
}

/** Рамка кадров для экспорта: квадрат, в который таймер помещается при любом повороте и тряске (чётные размеры) */
export function timerBox(clip, W, H) {
  const r = timerRect(clip, W, H);
  const side = Math.min(4 * Math.max(W, H), Math.ceil((Math.hypot(r.w, r.h) * 1.18 + 8) / 2) * 2);
  return { x: Math.round(r.cx - side / 2), y: Math.round(r.cy - side / 2), w: side, h: side };
}

/** Нарисовать таймер клипа на ctx (холст кадра W×H пикселей; ctx без трансформа). local — с от начала клипа. */
export function drawTimer(ctx, clip, W, H, local = 0) {
  const tm = cleanTimer(clip && clip.timer);
  const tf = tfOf(clip);
  const st = timerState(tm, local);
  const k = (tm.size * H * tf.scale) / unitH(tm);
  const midY = (TOP + BOTTOM + (tm.digits ? DIGITS_H : 0)) / 2;   // центр рисунка (в единицах)
  // Звонок: циклы по 1.2 с — быстрая тряска с затуханием и подпрыгивание
  let shake = 0; let jump = 0; let env = 0;
  if (st.ringing) {
    const cyc = st.u % 1.2;
    env = Math.max(0, 1 - cyc / 0.9);
    shake = Math.sin(st.u * Math.PI * 2 * 9) * 13 * env;
    jump = -Math.abs(Math.sin(st.u * Math.PI * 2 * 4.5)) * 0.1 * env;
  }
  ctx.save();
  ctx.translate(W / 2 + tf.x * W, H / 2 + tf.y * H);
  if (tf.rotate) ctx.rotate((tf.rotate * Math.PI) / 180);
  ctx.globalAlpha = tf.opacity;
  ctx.scale(k, k);
  ctx.translate(0, -midY);
  ctx.translate(0, jump);
  ctx.save();
  if (shake) ctx.rotate((shake * Math.PI) / 180);
  const lw = 0.085;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = tm.inkColor;
  const circle = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath(); };

  // Кнопка: кольцо и ножка
  circle(0, -1.38, 0.2);
  ctx.lineWidth = 0.15; ctx.strokeStyle = tm.inkColor; ctx.stroke();
  ctx.lineWidth = 0.07; ctx.strokeStyle = '#34b6e8'; ctx.stroke();
  ctx.strokeStyle = tm.inkColor;
  ctx.beginPath(); ctx.rect(-0.13, -1.2, 0.26, 0.24); ctx.fillStyle = '#34b6e8'; ctx.fill(); ctx.lineWidth = lw * 0.8; ctx.stroke();

  // Корпус
  circle(0, 0, 1);
  ctx.fillStyle = tm.caseColor; ctx.fill();
  ctx.lineWidth = lw; ctx.stroke();
  // Блик на корпусе
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.9, -Math.PI * 0.42, -Math.PI * 0.08);
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.07; ctx.stroke();
  ctx.restore();
  // Циферблат
  const R = 0.76;
  circle(0, 0, R);
  ctx.fillStyle = tm.faceColor; ctx.fill();
  // Сектор прошедшего времени (по часовой от 12)
  if (st.p > 0.0005) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * st.p);
    ctx.closePath();
    ctx.fillStyle = tm.fillColor;
    if (st.ringing) ctx.globalAlpha *= 0.75 + 0.25 * Math.round((st.u * 4) % 1);
    ctx.fill();
    ctx.globalAlpha = tf.opacity;
  }
  circle(0, 0, R);
  ctx.lineWidth = lw; ctx.strokeStyle = tm.inkColor; ctx.stroke();
  // Деления
  ctx.lineWidth = 0.075;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const s = Math.sin(a); const c = -Math.cos(a);
    ctx.beginPath(); ctx.moveTo(s * 0.52, c * 0.52); ctx.lineTo(s * 0.62, c * 0.62); ctx.stroke();
  }
  // Стрелка — к краю сектора, короткая — к 12 (как у секундомера)
  const ang = -Math.PI / 2 + Math.PI * 2 * st.p;
  ctx.lineWidth = 0.09;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * 0.55, Math.sin(ang) * 0.55); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-0.16, -0.12); ctx.stroke();
  circle(0, 0, 0.12);
  ctx.fillStyle = '#34b6e8'; ctx.fill(); ctx.lineWidth = 0.06; ctx.stroke();
  ctx.restore();

  // Звонок: штрихи по бокам от кнопки (не трясутся вместе с корпусом)
  if (st.ringing && env > 0.02) {
    ctx.save();
    ctx.globalAlpha = tf.opacity * Math.min(1, env * 1.4);
    ctx.strokeStyle = tm.inkColor; ctx.lineWidth = 0.08; ctx.lineCap = 'round';
    const grow = 0.12 * (1 - env);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = (-Math.PI / 2) + side * (0.55 + i * 0.32);
        const r0 = 1.18 + grow; const r1 = 1.42 + grow;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 - 0.15); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 - 0.15); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Цифры под секундомером (во время звонка — мигают)
  if (tm.digits) {
    const blink = st.ringing && Math.floor(st.u * 4) % 2 === 1;
    if (!blink) {
      // Шрифт — в пикселях (доли пикселя в ctx.font браузер может округлить): масштаб единиц снимается
      ctx.save();
      const y = (BOTTOM + DIGITS_H / 2 + 0.04) * k;
      ctx.scale(1 / k, 1 / k);
      ctx.font = `700 ${(0.5 * k).toFixed(2)}px "Inter", "Inter Variable", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 0.12 * k; ctx.strokeStyle = tm.inkColor; ctx.lineJoin = 'round';
      ctx.strokeText(st.text, 0, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(st.text, 0, y);
      ctx.restore();
    }
  }
  ctx.restore();
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
 * цифры меняются каждую секунду), 
 * звонок — с частотой проекта (до 30). Кадры, которые совпадают на экране, склеивает вызывающий (по содержимому).
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
