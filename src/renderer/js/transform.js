// Трансформ клипа на видеодорожке (M4): положение, масштаб, поворот и прозрачность поверх подгонки кадра.
//   transform { x, y, scale, rotate, opacity }
//     x, y    — сдвиг центра клипа в долях кадра проекта (0, 0 — по центру; 0.5 — на полкадра вправо/вниз)
//     scale   — множитель к подгонке (1 — как «вписать/заполнить/растянуть» сделали; 0.5 — вдвое меньше)
//     rotate  — поворот вокруг центра, градусы по часовой стрелке
//     opacity — прозрачность 0…1
// Порядок (и в плеере, и в экспорте): кадрирование crop → подгонка в рамку W·scale × H·scale → поворот → сдвиг центра.
// Без DOM: модуль используется окном, экспортом и автотестами.

export const TF_DEFAULT = Object.freeze({ x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 });
export const TF_LIMITS = Object.freeze({ x: [-2, 2], y: [-2, 2], scale: [0.05, 8], rotate: [-360, 360], opacity: [0, 1] });
export const TF_KEYS = Object.keys(TF_DEFAULT);

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const DIGITS = { x: 5, y: 5, scale: 4, rotate: 2, opacity: 3 };

// Полный трансформ клипа (недостающие поля — по умолчанию)
export const tfOf = (c) => ({ ...TF_DEFAULT, ...((c && c.transform) || {}) });

export const isIdentity = (tf) => !tf || TF_KEYS.every((k) => Math.abs((tf[k] ?? TF_DEFAULT[k]) - TF_DEFAULT[k]) < 1e-6);

// Приводит трансформ к допустимому виду: числа в пределах, округление; только отличные от умолчания поля.
// null — трансформа нет (всё по умолчанию). patch накладывается на base.
export function cleanTransform(patch, base = null) {
  const src = { ...TF_DEFAULT, ...(base || {}), ...(patch || {}) };
  const out = {};
  for (const k of TF_KEYS) {
    let v = Number(src[k]);
    if (!Number.isFinite(v)) v = TF_DEFAULT[k];
    const [lo, hi] = TF_LIMITS[k];
    v = round(Math.min(hi, Math.max(lo, v)), DIGITS[k]);
    if (Math.abs(v - TF_DEFAULT[k]) > 1e-9) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Пропорции картинки клипа после кадрирования (ширина / высота); media — сведения ffprobe
export function contentAspect(clip, media) {
  const w = media && media.width > 0 ? media.width : 16;
  const hh = media && media.height > 0 ? media.height : 9;
  const cr = (clip && clip.crop) || {};
  const fw = Math.max(0.05, 1 - (cr.l || 0) - (cr.r || 0));
  const fh = Math.max(0.05, 1 - (cr.t || 0) - (cr.b || 0));
  return (w * fw) / (hh * fh);
}

// Где клип нарисован в кадре W×H: центр (cx, cy), размеры (w, h) до поворота, rot — градусы.
// box — рамка подгонки (W·scale × H·scale); w×h — сама картинка в ней («вписать» — меньше рамки).
export function contentRect(clip, media, W, H) {
  const tf = tfOf(clip);
  const bw = W * tf.scale; const bh = H * tf.scale;
  let w = bw; let hh = bh;
  if (!clip || !clip.fit || clip.fit === 'contain') {
    const ar = contentAspect(clip, media);
    if (bw / bh > ar) { hh = bh; w = bh * ar; } else { w = bw; hh = bw / ar; }
  }
  return { cx: W / 2 + tf.x * W, cy: H / 2 + tf.y * H, w, h: hh, bw, bh, rot: tf.rotate, opacity: tf.opacity };
}

// Точка (px, py) кадра попадает в картинку клипа (с учётом поворота)
export function hitContent(rect, px, py) {
  const a = (-rect.rot * Math.PI) / 180;
  const dx = px - rect.cx; const dy = py - rect.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2;
}

// CSS для слоя клипа в плеере (слой занимает весь «экран», transform-origin — центр)
export function cssTransform(clip) {
  const tf = tfOf(clip);
  if (isIdentity(tf)) return { transform: '', opacity: '' };
  const parts = [];
  if (tf.x || tf.y) parts.push(`translate(${round(tf.x * 100, 4)}%, ${round(tf.y * 100, 4)}%)`);
  if (tf.rotate) parts.push(`rotate(${tf.rotate}deg)`);
  if (tf.scale !== 1) parts.push(`scale(${tf.scale})`);
  return { transform: parts.join(' '), opacity: tf.opacity === 1 ? '' : String(tf.opacity) };
}
