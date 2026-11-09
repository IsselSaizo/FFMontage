// Текстовый клип (M5.1): clip.kind === 'text' на любой видеодорожке.
//   clip.text — оформление (все поля, см. TEXT_DEFAULT); длина на таймлайне — out − in (in = 0), скорости и звука нет.
//   Положение, масштаб, поворот и прозрачность — обычный clip.transform (transform.js), как у видео.
// Размеры — в долях кадра, поэтому текст выглядит одинаково при любом разрешении:
//   size — высота шрифта (em) в долях высоты кадра; wrap — ширина строки в долях ширины кадра (0 — без переноса);
//   strokeWidth, shadow*, box* — в долях размера шрифта (em).
// Рисует текст js/textRender.js (холст) — и в плеере, и для экспорта (решение D2: PNG + overlay).
// Без DOM: модуль используется окном, экспортом, реестром стилей и автотестами.
// Вид графического клипа 'text' (graphics.js): модель — здесь, рисунок и экспорт — textRender.js, интерфейс — graphicsUi.js.
import { registerGraphic, GRAPHIC_MAX } from './graphics.js';
import { t } from './i18n.js';

export const TEXT_MAX = GRAPHIC_MAX;   // наибольшая длина текстового (и любого графического) клипа, с
export const TEXT_DEFAULT_DUR = 5;
export const BUILTIN_FONTS = Object.freeze(['Inter', 'Open Sans']);

export const TEXT_DEFAULT = Object.freeze({
  content: '',
  font: 'Inter',
  size: 0.08,
  weight: 700,
  italic: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  wrap: 0.9,
  strokeWidth: 0,
  strokeColor: '#000000',
  shadowOpacity: 0,
  shadowColor: '#000000',
  shadowBlur: 0.15,
  shadowX: 0.04,
  shadowY: 0.06,
  box: false,
  boxColor: '#000000',
  boxOpacity: 0.55,
  boxPad: 0.35,
  boxRadius: 0.2,
  motion: 'none',
  style: '',
});

// [min, max, знаков после запятой]
export const TEXT_LIMITS = Object.freeze({
  size: [0.01, 0.5, 4],
  weight: [100, 900, 0],
  lineHeight: [0.6, 3, 2],
  letterSpacing: [-0.2, 1, 3],
  wrap: [0, 1, 3],
  strokeWidth: [0, 0.3, 3],
  shadowOpacity: [0, 1, 2],
  shadowBlur: [0, 1, 3],
  shadowX: [-0.5, 0.5, 3],
  shadowY: [-0.5, 0.5, 3],
  boxOpacity: [0, 1, 2],
  boxPad: [0, 2, 2],
  boxRadius: [0, 1, 2],
});
export const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);
// none — стоит на месте; roll — титры: блок проезжает снизу вверх за время клипа
export const TEXT_MOTIONS = Object.freeze(['none', 'roll']);
export const TEXT_KEYS = Object.freeze(Object.keys(TEXT_DEFAULT));

const COLOR_RE = /^#[0-9a-f]{6}$/i;
// Имя шрифта: буквы, цифры, пробел, «-», «_», «.» — без кавычек и прочего, что сломало бы CSS font / ASS
const FONT_RE = /^[\p{L}\p{N} _.\-]{1,64}$/u;
const STYLE_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
export const MAX_TEXT_LEN = 5000;

export const isText = (c) => !!c && c.kind === 'text';
// Клипы без файла (текст, фигура, таймер…) — реестр graphics.js: isGraphic / graphicOf из graphicKinds.js
export const isFontName = (s) => typeof s === 'string' && FONT_RE.test(s.trim());

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Содержимое: строка без управляющих символов (кроме перевода строки и табуляции), \r\n → \n, не длиннее MAX_TEXT_LEN */
export function cleanContent(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_TEXT_LEN);
}

/**
 * Полное оформление текста: patch поверх base (или умолчаний), значения в пределах.
 * Неизвестные поля отбрасываются; неверные значения — как в base/умолчаниях.
 */
export function cleanText(patch, base = null) {
  const b = { ...TEXT_DEFAULT, ...(base && typeof base === 'object' ? base : {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  for (const k of TEXT_KEYS) {
    const def = TEXT_DEFAULT[k];
    let v = p[k] !== undefined ? p[k] : b[k];
    if (k === 'content') v = cleanContent(v);
    else if (k === 'font') v = isFontName(v) ? String(v).trim() : (isFontName(b[k]) ? String(b[k]).trim() : def);
    else if (k === 'style') v = typeof v === 'string' && (v === '' || STYLE_RE.test(v)) ? v : '';
    else if (k === 'align') v = TEXT_ALIGNS.includes(v) ? v : (TEXT_ALIGNS.includes(b[k]) ? b[k] : def);
    else if (k === 'motion') v = TEXT_MOTIONS.includes(v) ? v : (TEXT_MOTIONS.includes(b[k]) ? b[k] : def);
    else if (typeof def === 'boolean') v = v === true || v === 1 || v === 'true';
    else if (typeof def === 'string') v = typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : (COLOR_RE.test(String(b[k])) ? String(b[k]).toLowerCase() : def);
    else {
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number.isFinite(Number(b[k])) ? Number(b[k]) : def;
      const [lo, hi, d] = TEXT_LIMITS[k];
      n = round(Math.min(hi, Math.max(lo, n)), d);
      if (k === 'weight') n = Math.round(n / 100) * 100 || 100;
      v = n;
    }
    out[k] = v;
  }
  return out;
}

/** Только поля, которые отличаются от умолчаний (для MCP и пресетов) */
export function textDiff(tx) {
  const full = cleanText(tx);
  const out = {};
  for (const k of TEXT_KEYS) if (full[k] !== TEXT_DEFAULT[k]) out[k] = full[k];
  return out;
}

/** Первая строка текста — название клипа на таймлайне */
export function textTitle(c) {
  const s = (c && c.text && typeof c.text.content === 'string' ? c.text.content : '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

registerGraphic('text', {
  field: 'text',
  title: () => t('Текст'),
  clean: cleanText,
  defaultDur: TEXT_DEFAULT_DUR,
  name: (c) => textTitle(c) || t('Текст'),
  describe: textDiff,
});

/** Шрифты, которые использует проект (тексты всех эпизодов и стили субтитров) */
export function usedFonts(project) {
  const set = new Set();
  const scan = (s) => {
    if (!s) return;
    const lanes = [s.videoClips, ...(Array.isArray(s.videoTracks) ? s.videoTracks.map((x) => x && x.clips) : [])];
    for (const list of lanes) for (const c of Array.isArray(list) ? list : []) if (isText(c) && c.text && isFontName(c.text.font)) set.add(c.text.font.trim());
    for (const tr of Array.isArray(s.subtitleTracks) ? s.subtitleTracks : []) if (tr && tr.style && isFontName(tr.style.font)) set.add(tr.style.font.trim());
  };
  scan(project);
  if (project && Array.isArray(project.episodes)) project.episodes.forEach(scan);
  return [...set];
}
