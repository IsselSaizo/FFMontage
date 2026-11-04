// Пресет анимации «Дождь»: картинка (например, купюра) падает сверху вниз.
// Одна и та же математика частиц — для холста-предпросмотра и для запекания в FFmpeg,
// поэтому сохранённое видео совпадает с тем, что было видно в плеере.
// Модуль без DOM.
import { t } from './i18n.js';

export const RAIN_PARAMS = [
  { k: 'count', name: t('Количество'), min: 1, max: 150, step: 1, def: 30, unit: '' },
  { k: 'speed', name: t('Скорость падения'), min: 0.1, max: 2, step: 0.05, def: 0.35, unit: t('экр/с') },
  { k: 'size', name: t('Размер'), min: 0.03, max: 0.4, step: 0.01, def: 0.1, unit: t('кадра'), pct: true },
  { k: 'spread', name: t('Разброс размера'), min: 0, max: 0.8, step: 0.05, def: 0.3, unit: '', pct: true },
  { k: 'rotation', name: t('Вращение'), min: 0, max: 360, step: 5, def: 90, unit: t('°/с') },
  { k: 'wind', name: t('Ветер'), min: -0.5, max: 0.5, step: 0.01, def: 0.05, unit: t('экр/с') },
  { k: 'duration', name: t('Длительность'), min: 1, max: 30, step: 0.5, def: 5, unit: t('с') },
];

export function rainDefaults() {
  return { ...Object.fromEntries(RAIN_PARAMS.map((p) => [p.k, p.def])), loop: true, seed: 1, image: null };
}

export function rainClean(p) {
  const out = rainDefaults();
  for (const d of RAIN_PARAMS) {
    const v = Number(p && p[d.k]);
    out[d.k] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.def;
  }
  out.count = Math.round(out.count);
  out.loop = !p || p.loop !== false;
  out.seed = Math.max(0, Math.round(Number(p && p.seed) || 0)) % 1000000;
  out.image = (p && p.image) || null;
  return out;
}

// Детерминированный генератор (одинаковый seed — одинаковый «дождь»)
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (x) => Math.round(x * 10000) / 10000;

// Частицы для кадра W×H; aspect — ширина/высота картинки.
//   sw, sh — размер картинки; hb — сторона квадрата после поворота (диагональ)
//   x0, ph — начальные доли по горизонтали/вертикали; v, wx — циклов в секунду по вертикали/горизонтали
//   r0, rs — начальный угол и скорость вращения, градусы
// С «зацикливанием» скорости округляются так, чтобы за длительность каждая частица прошла целое число кругов.
export function rainParticles(params, W, H, aspect = 1) {
  const p = rainClean(params);
  const rnd = mulberry32(p.seed * 7919 + 17);
  const D = p.duration;
  const list = [];
  for (let i = 0; i < p.count; i++) {
    const x0 = rnd(); const ph = rnd(); const sk = rnd(); const vk = rnd(); const r0 = rnd(); const rk = rnd(); const wk = rnd();
    const sh = Math.max(4, Math.round(H * p.size * Math.max(0.2, 1 + p.spread * (sk * 2 - 1))));
    const sw = Math.max(4, Math.round(sh * aspect));
    const hb = Math.ceil(Math.hypot(sw, sh));
    // скорость в «экранах в секунду» → циклов в секунду (путь — экран плюс размер частицы)
    let v = (p.speed * (0.75 + vk * 0.5) * H) / (H + hb);
    let wx = (p.wind * (0.8 + wk * 0.4) * W) / (W + hb);
    let rs = p.rotation * (rk * 2 - 1);
    if (p.loop) {
      v = Math.max(1, Math.round(v * D)) / D;
      wx = Math.round(wx * D) / D;
      rs = (Math.round((rs * D) / 360) * 360) / D;
    }
    list.push({ x0: r4(x0), ph: r4(ph), v: r4(v * 1e2) / 1e2, wx: r4(wx * 1e2) / 1e2, r0: Math.round(r0 * 360), rs: r4(rs), sw, sh, hb });
  }
  return list;
}

const frac = (x) => x - Math.floor(x);

// Центр частицы и угол в момент t (те же формулы, что в FFmpeg ниже)
export function rainAt(pt, t, W, H) {
  return {
    cx: -pt.hb + (W + pt.hb) * frac(pt.x0 + pt.wx * t) + pt.hb / 2,
    cy: -pt.hb + (H + pt.hb) * frac(pt.ph + pt.v * t) + pt.hb / 2,
    angle: ((pt.r0 + pt.rs * t) * Math.PI) / 180,
  };
}

const n6 = (x) => Number(x).toFixed(6);

// План для export_start: картинка → видео WebM VP9 с прозрачностью
export function rainBakePlan(params, image, { width, height, fps }, output, ffMajor = 99) {
  const p = rainClean(params);
  const W = Math.max(2, Math.round(width / 2) * 2); const H = Math.max(2, Math.round(height / 2) * 2);
  const F = fps || 30;
  const D = p.duration;
  const aspect = image.width && image.height ? image.width / image.height : 1;
  const pts = rainParticles(p, W, H, aspect);
  const f = [];
  f.push(`color=c=black@0.0:s=${W}x${H}:r=${F}:d=${n6(D)},format=rgba[bg]`);
  f.push(`[0:v]format=rgba,split=${pts.length}${pts.map((_, i) => `[s${i}]`).join('')}`);
  let cur = '[bg]';
  pts.forEach((pt, i) => {
    f.push(`[s${i}]scale=${pt.sw}:${pt.sh}:flags=lanczos,rotate=a='(${pt.r0}+${n6(pt.rs)}*t)*PI/180':c=none:ow=${pt.hb}:oh=${pt.hb}[p${i}]`);
    const X = `${n6(pt.x0)}+${n6(pt.wx)}*t`; const Y = `${n6(pt.ph)}+${n6(pt.v)}*t`;
    const out = i === pts.length - 1 ? '[ov]' : `[o${i}]`;
    f.push(`${cur}[p${i}]overlay=x='-w+(W+w)*((${X})-floor(${X}))':y='-h+(H+h)*((${Y})-floor(${Y}))':format=auto:eof_action=pass${out}`);
    cur = out;
  });
  f.push('[ov]format=yuva420p[vout]');
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  const args = ['-hide_banner', '-y', '-nostdin', '-loop', '1', '-framerate', String(F), '-t', n6(D + 0.5), '-i', image.path,
    ...filterArgs, '-map', '[vout]',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
    '-auto-alt-ref', '0', '-t', n6(D), '-an', '-f', 'webm', '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
  return { args, filter: f.join(';\n'), duration: D, output, W, H, F, particles: pts };
}

// Подпись файла запекания: одинаковые параметры — тот же файл
export function rainKey(params, image, fmt) {
  const s = JSON.stringify([rainClean(params), image.path, fmt.width, fmt.height, fmt.fps]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
