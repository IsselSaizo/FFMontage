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
  // Оформление фрагментов (0.5.x): [{ a, b, color?, bold?, italic? }] — символы content[a…b) (UTF-16), без наложений,
  // по возрастанию; поля фрагмента перекрывают общие (bold — жирнее/тоньше общего weight, italic — вкл/выкл)
  runs: Object.freeze([]),
});
export const MAX_RUNS = 500;

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
    else if (k === 'runs') v = cleanRuns(v, out.content);
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
  for (const k of TEXT_KEYS) {
    if (k === 'runs') { if (full.runs.length) out.runs = full.runs; continue; }
    if (full[k] !== TEXT_DEFAULT[k]) out[k] = full[k];
  }
  return out;
}

// ---------------- Фрагменты (цвет, жирный, курсив выделенного) ----------------
const RUN_KEYS = ['color', 'bold', 'italic'];
const runAttrs = (r) => {
  const o = {};
  if (r && typeof r.color === 'string' && COLOR_RE.test(r.color)) o.color = r.color.toLowerCase();
  if (r && typeof r.bold === 'boolean') o.bold = r.bold;
  if (r && typeof r.italic === 'boolean') o.italic = r.italic;
  return o;
};
const sameAttrs = (x, y) => RUN_KEYS.every((k) => x[k] === y[k]);

/**
 * Фрагменты в каноническом виде: в пределах content, без пустых и без наложений (позже в списке — главнее),
 * соседние одинаковые слиты, по возрастанию a.
 */
export function cleanRuns(runs, content = '') {
  if (!Array.isArray(runs) || !runs.length) return [];
  const len = String(content ?? '').length;
  const list = [];
  for (const r of runs.slice(0, MAX_RUNS)) {
    if (!r || typeof r !== 'object') continue;
    const a = Math.max(0, Math.min(len, Math.floor(Number(r.a))));
    const b = Math.max(0, Math.min(len, Math.floor(Number(r.b))));
    const at = runAttrs(r);
    if (!(b > a) || !Object.keys(at).length) continue;
    list.push({ a, b, at });
  }
  if (!list.length) return [];
  // Разбить на отрезки по всем границам и сложить поля (позже — главнее)
  const cuts = [...new Set(list.flatMap((r) => [r.a, r.b]))].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]; const b = cuts[i + 1];
    const mix = {};
    for (const r of list) if (r.a <= a && r.b >= b) Object.assign(mix, r.at);
    const at = {};
    for (const k of RUN_KEYS) if (k in mix) at[k] = mix[k];   // порядок полей всегда один (для сравнения снимков)
    if (!Object.keys(at).length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.b === a && sameAttrs(prev, at)) prev.b = b;
    else out.push({ a, b, ...at });
  }
  return out;
}

/**
 * Применить оформление к content[a…b): patch { color?, bold?, italic? } (null — снять это поле);
 * clear: true — снять всё оформление фрагмента. → новые runs
 */
export function applyRun(runs, content, a, b, patch = {}, { clear = false } = {}) {
  const len = String(content ?? '').length;
  a = Math.max(0, Math.min(len, a | 0)); b = Math.max(0, Math.min(len, b | 0));
  if (b <= a) return cleanRuns(runs, content);
  const out = [];
  for (const r of cleanRuns(runs, content)) {
    if (r.b <= a || r.a >= b) { out.push(r); continue; }
    // Части снаружи выделения — как были; внутри — поля r + patch
    if (r.a < a) out.push({ ...r, b: a });
    if (r.b > b) out.push({ ...r, a: b });
    if (!clear) {
      const inner = { ...r, a: Math.max(a, r.a), b: Math.min(b, r.b) };
      for (const k of RUN_KEYS) if (k in patch) { if (patch[k] === null) delete inner[k]; else inner[k] = patch[k]; }
      out.push(inner);
    }
  }
  if (!clear) {
    const add = {};
    for (const k of RUN_KEYS) if (k in patch && patch[k] !== null) add[k] = patch[k];
    // Не покрытые фрагментами места выделения тоже получают patch: «подложка» под остальными (они уже учли patch)
    if (Object.keys(add).length) out.unshift({ a, b, ...add });
  }
  return cleanRuns(out, content);
}

/** Оформление символа i: { color, bold, italic } из фрагментов (undefined — как у всего текста) */
export function runAt(runs, i) {
  for (const r of runs || []) if (r.a <= i && i < r.b) return r;
  return null;
}

/** Жирный ли общий текст (weight от 600 — «жирный» для кнопки B) */
export const baseBold = (tx) => (Number(tx && tx.weight) || 400) >= 600;
/** Как рисовать фрагмент (run может быть null): { color, weight, italic } */
export function runStyle(tx, run) {
  const w = Number(tx.weight) || 400;
  const weight = run && run.bold === true ? (w >= 700 ? 900 : 700) : run && run.bold === false ? (w >= 600 ? 400 : w) : w;
  return { color: (run && run.color) || tx.color, weight, italic: run && typeof run.italic === 'boolean' ? run.italic : !!tx.italic };
}
/** Оформление выделения content[a…b) для кнопок: { color, bold, italic } — bold/italic true, если у всех символов */
export function selectionStyle(tx, a, b) {
  const runs = tx.runs || [];
  if (b <= a) { const r = runAt(runs, Math.max(0, a - 1)); return { color: (r && r.color) || tx.color, bold: r && typeof r.bold === 'boolean' ? r.bold : baseBold(tx), italic: r && typeof r.italic === 'boolean' ? r.italic : !!tx.italic }; }
  let bold = true; let italic = true;
  for (let i = a; i < b; i++) {
    const r = runAt(runs, i);
    if (!(r && typeof r.bold === 'boolean' ? r.bold : baseBold(tx))) bold = false;
    if (!(r && typeof r.italic === 'boolean' ? r.italic : !!tx.italic)) italic = false;
    if (!bold && !italic) break;
  }
  const r0 = runAt(runs, a);
  return { color: (r0 && r0.color) || tx.color, bold, italic };
}

/** Общее значение поля key на content[a…b) (undefined — где-то нет или разное) */
export function runValue(runs, a, b, key) {
  if (b <= a) return undefined;
  let v; let pos = a;
  for (const r of runs || []) {
    if (r.b <= pos) continue;
    if (r.a > pos || !(key in r)) return undefined;
    if (v === undefined) v = r[key]; else if (v !== r[key]) return undefined;
    pos = r.b;
    if (pos >= b) return v;
  }
  return undefined;
}

/**
 * Сдвинуть фрагменты после правки текста oldS → newS (одна сплошная замена: общее начало и общий конец).
 * Набранное сразу после фрагмента продолжает его оформление (как в текстовых редакторах).
 */
export function remapRuns(runs, oldS, newS) {
  oldS = String(oldS ?? ''); newS = String(newS ?? '');
  if (!runs || !runs.length || oldS === newS) return cleanRuns(runs, newS);
  let p = 0;
  const max = Math.min(oldS.length, newS.length);
  while (p < max && oldS.charCodeAt(p) === newS.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && oldS.charCodeAt(oldS.length - 1 - s) === newS.charCodeAt(newS.length - 1 - s)) s++;
  const oldEnd = oldS.length - s;           // заменено old[p…oldEnd)
  const ins = newS.length - s - p;          // на new[p…p+ins)
  const delta = newS.length - oldS.length;
  const pure = oldEnd === p;                // только вставка
  // Начало фрагмента: вставка прямо перед ним — не его (продолжает предыдущий текст)
  const mapA = (x) => (x < p ? x : x === p ? (pure ? p + ins : p) : x >= oldEnd ? x + delta : p + ins);
  // Конец: вставка прямо после — его; конец внутри заменённого — замена его
  const mapB = (x) => (x < p ? x : x === p && !pure ? x : x >= oldEnd ? x + delta : p + ins);
  return cleanRuns(runs.map((r) => ({ ...r, a: mapA(r.a), b: mapB(r.b) })), newS);
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
