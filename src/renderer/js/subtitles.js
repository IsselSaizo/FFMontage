// Субтитры: разбор SRT / WebVTT / ASS(SSA), запись SRT / VTT / ASS, стиль дорожки субтитров.
// Чистый модуль без DOM: импортируется и в WebView, и в Node (тест tests/subtitles-test.js).
//
// Модель:
//   реплика (cue) — { start, end, text }: секунды, текст без разметки, строки через «\n»;
//   стиль дорожки — см. SUB_STYLE_DEFAULT (размеры — доли высоты кадра, цвета — #rrggbb).
//
// Экранирование текста для ASS (libass, фильтр ass в FFmpeg) проверено тестом на настоящем FFmpeg:
//   «\n» → «\N»; «{» → «\{», «}» → «\}» (libass рисует их буквально, без них «{…}» — блок тегов);
//   после буквального «\» ставится U+2060 WORD JOINER (невидим): иначе «\N», «\n», «\h», «\{» стали бы командами.
//   Если за «{» идёт «\», после «\{» тоже ставится U+2060 — так и разборщик FFmpeg (ass_split, конвертация
//   ASS → SRT) не примет «{\» за начало блока тегов.

/** Стиль дорожки субтитров по умолчанию */
export const SUB_STYLE_DEFAULT = Object.freeze({
  font: 'Inter',
  size: 0.055, // Fontsize ASS как доля высоты кадра
  bold: false,
  italic: false,
  color: '#ffffff',
  outline: 0.0025, // толщина обводки, доля высоты кадра
  outlineColor: '#000000',
  shadow: 0, // смещение тени, доля высоты кадра
  shadowColor: '#000000',
  box: false, // непрозрачная плашка под текстом вместо обводки (ASS BorderStyle 3)
  boxColor: '#000000',
  boxOpacity: 0.6,
  position: 'bottom', // 'bottom' | 'middle' | 'top'
  align: 'center', // 'center' | 'left' | 'right'
  margin: 0.05, // вертикальный отступ, доля высоты кадра
});

const POSITIONS = ['bottom', 'middle', 'top'];
const ALIGNS = ['left', 'center', 'right'];
const WJ = '\u2060';
const MAX_ERRORS = 50;

// ---------- общие помощники ----------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const roundMs = (t) => Math.round(t * 1000) / 1000;
const roundTo = (v, k) => Math.round(v * k) / k;
const num = (v, def) => { const x = Number(v); return Number.isFinite(x) ? x : def; };
const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/** Полный стиль с умолчаниями, значения приведены к допустимым */
export function cleanSubStyle(style) {
  const s = style && typeof style === 'object' ? style : {};
  const D = SUB_STYLE_DEFAULT;
  const bool = (v, def) => (v == null ? def : !!v);
  const color = (v, def) => (isHex(v) ? v.toLowerCase() : def);
  const font = typeof s.font === 'string' && s.font.trim() ? s.font.trim().slice(0, 200) : D.font;
  return {
    font,
    size: clamp(num(s.size, D.size), 0.01, 0.3),
    bold: bool(s.bold, D.bold),
    italic: bool(s.italic, D.italic),
    color: color(s.color, D.color),
    outline: clamp(num(s.outline, D.outline), 0, 0.05),
    outlineColor: color(s.outlineColor, D.outlineColor),
    shadow: clamp(num(s.shadow, D.shadow), 0, 0.05),
    shadowColor: color(s.shadowColor, D.shadowColor),
    box: bool(s.box, D.box),
    boxColor: color(s.boxColor, D.boxColor),
    boxOpacity: clamp(num(s.boxOpacity, D.boxOpacity), 0, 1),
    position: POSITIONS.includes(s.position) ? s.position : D.position,
    align: ALIGNS.includes(s.align) ? s.align : D.align,
    margin: clamp(num(s.margin, D.margin), 0, 0.45),
  };
}

/** Выравнивание ASS «по цифровой клавиатуре» (1–3 низ, 4–6 середина, 7–9 верх) */
export function subAlignment(style) {
  const s = style || {};
  const row = { bottom: 1, middle: 4, top: 7 }[s.position] ?? 1;
  const col = { left: 0, center: 1, right: 2 }[s.align] ?? 1;
  return row + col;
}

/** Обратное: номер ASS (numpad или старый SSA) → { position, align } */
function fromAlignment(n, legacy) {
  n = Math.trunc(num(n, 2));
  if (legacy) {
    // SSA: 1,2,3 — низ; 5,6,7 — верх; 9,10,11 — середина (биты 4 и 8)
    const col = n & 3;
    const position = n & 8 ? 'middle' : n & 4 ? 'top' : 'bottom';
    return { position, align: ALIGNS[clamp(col || 2, 1, 3) - 1] };
  }
  if (n < 1 || n > 9) n = 2;
  return { position: POSITIONS[Math.floor((n - 1) / 3)], align: ALIGNS[(n - 1) % 3] };
}

/** Текст реплики: строки обрезаны, пустые строки убраны */
function cleanText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Финал разбора: текст, округление до мс, отбрасывание пустых и нулевых, сортировка по началу */
function finishCues(raw) {
  const out = [];
  for (const c of raw) {
    const text = cleanText(c.text);
    const start = roundMs(c.start); const end = roundMs(c.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end, text });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

const clock = (h, m, s, frac) => (Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0));

/** Подготовка входа: BOM, CRLF/CR → LF */
const prep = (text) => String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

// ---------- определение формата ----------

/** 'srt' | 'vtt' | 'ass' | null */
export function detectFormat(text) {
  const s = prep(text).replace(/^\s+/, '');
  if (/^WEBVTT(?=$|[ \t\n])/.test(s)) return 'vtt';
  if (/^\[script info\]/im.test(s) || (/^\[events\]/im.test(s) && /^dialogue\s*:/im.test(s))) return 'ass';
  if (SRT_TIME.test(s.split('\n').find((l) => l.includes('->')) || '')) return 'srt';
  return null;
}

// ---------- SRT ----------

// Часы необязательны и могут быть одной цифрой, миллисекунды — через «,» или «.» (или вовсе без них)
const T_SRT = '(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})(?:[,.](\\d{1,3}))?';
const SRT_TIME = new RegExp(`^\\s*${T_SRT}\\s*-{1,2}>\\s*${T_SRT}`);

function stripSrtMarkup(line) {
  return line
    .replace(/\{\\[^}]*\}/g, '') // {\an8} и прочие теги ASS
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, ''); // <i>, </b>, <font color="…">
}

function parseSrt(s, errors) {
  const lines = s.split('\n');
  const raw = []; let cur = null;
  const flush = () => { if (cur) raw.push({ start: cur.start, end: cur.end, text: cur.lines.join('\n') }); cur = null; };
  lines.forEach((line, i) => {
    const m = SRT_TIME.exec(line);
    if (m) {
      // номер следующей реплики без пустой строки перед ним — не текст
      if (cur && cur.lines.length && /^\s*\d+\s*$/.test(cur.lines[cur.lines.length - 1])) cur.lines.pop();
      flush();
      cur = { start: clock(m[1], m[2], m[3], m[4]), end: clock(m[5], m[6], m[7], m[8]), lines: [] };
      return;
    }
    if (!line.trim()) { flush(); return; }
    if (cur) { cur.lines.push(stripSrtMarkup(line)); return; }
    if (line.includes('-->')) pushErr(errors, `line ${i + 1}: bad timing`);
    // прочее вне реплики (номер, мусор) пропускается
  });
  flush();
  return finishCues(raw);
}

// ---------- WebVTT ----------

const T_VTT = '(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})[.,](\\d{1,3})';
const VTT_TIME = new RegExp(`^\\s*${T_VTT}\\s*-->\\s*${T_VTT}`);
const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseVtt(s, errors) {
  const lines = s.split('\n');
  // блоки — группы непустых строк
  const blocks = []; let b = null;
  lines.forEach((line, i) => {
    if (!line.trim()) { b = null; return; }
    if (!b) { b = { at: i + 1, lines: [] }; blocks.push(b); }
    b.lines.push(line);
  });
  const raw = [];
  blocks.forEach((blk, bi) => {
    const first = blk.lines[0];
    if (bi === 0 && /^WEBVTT/.test(first)) return; // заголовок
    if (/^(NOTE|STYLE|REGION)(?=$|[ \t])/.test(first)) return;
    const ti = blk.lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || ti > 1) { pushErr(errors, `line ${blk.at}: block without timing`); return; }
    const m = VTT_TIME.exec(blk.lines[ti]);
    if (!m) { pushErr(errors, `line ${blk.at + ti}: bad timing`); return; }
    const text = blk.lines.slice(ti + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]*>/g, ''))) // <c.x>, <v Имя>, <00:00:01.000>, <i>
      .join('\n');
    raw.push({ start: clock(m[1], m[2], m[3], m[4]), end: clock(m[5], m[6], m[7], m[8]), text });
  });
  return finishCues(raw);
}

// ---------- ASS / SSA ----------

const ASS_STYLE_FORMAT = ['name', 'fontname', 'fontsize', 'primarycolour', 'secondarycolour', 'outlinecolour', 'backcolour',
  'bold', 'italic', 'underline', 'strikeout', 'scalex', 'scaley', 'spacing', 'angle', 'borderstyle', 'outline', 'shadow',
  'alignment', 'marginl', 'marginr', 'marginv', 'encoding'];
const SSA_STYLE_FORMAT = ['name', 'fontname', 'fontsize', 'primarycolour', 'secondarycolour', 'tertiarycolour', 'backcolour',
  'bold', 'italic', 'borderstyle', 'outline', 'shadow', 'alignment', 'marginl', 'marginr', 'marginv', 'alphalevel', 'encoding'];
const ASS_EVENT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/** Делит строку на n полей по запятым; последнее поле забирает остаток (в тексте могут быть запятые) */
function splitFields(s, n) {
  const out = []; let pos = 0;
  for (let k = 0; k < n - 1; k++) {
    const j = s.indexOf(',', pos);
    if (j < 0) break;
    out.push(s.slice(pos, j).trim()); pos = j + 1;
  }
  out.push(s.slice(pos));
  return out;
}

/** Цвет ASS (&HAABBGGRR, &HBBGGRR или десятичное число SSA) → { hex: '#rrggbb', alpha: 0..255 } */
function parseAssColor(v) {
  const s = String(v ?? '').trim();
  let n;
  const m = /^&?[hH]([0-9a-fA-F]+)&?$/.exec(s);
  if (m) n = parseInt(m[1].slice(-8), 16);
  else if (/^-?\d+$/.test(s)) n = Number(s) >>> 0;
  else return null;
  const r = n & 0xff; const g = (n >>> 8) & 0xff; const b = (n >>> 16) & 0xff; const a = (n >>> 24) & 0xff;
  const h2 = (x) => x.toString(16).padStart(2, '0');
  return { hex: `#${h2(r)}${h2(g)}${h2(b)}`, alpha: a };
}

function parseAssTime(v) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.:,](\d+))?\s*$/.exec(String(v ?? ''));
  return m ? clock(m[1], m[2], m[3], m[4]) : NaN;
}

/** Текст события ASS → простой текст: блоки {…} убраны, \N \n → перевод строки, \h → пробел, \{ \} → скобки */
export function assToPlain(text) {
  const s = String(text ?? '');
  let out = ''; let drawing = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const j = s.indexOf('}', i + 1);
      if (j >= 0) {
        const block = s.slice(i + 1, j);
        const p = block.match(/\\p(\d+)/g); // режим рисования: текст — это контуры, а не буквы
        if (p) drawing = Number(p[p.length - 1].slice(2)) > 0;
        i = j; continue;
      }
      if (!drawing) out += c;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const d = s[i + 1];
      if (d === 'N' || d === 'n') { if (!drawing) out += '\n'; i++; continue; }
      if (d === 'h') { if (!drawing) out += ' '; i++; continue; }
      if (d === '{' || d === '}') {
        if (!drawing) out += d;
        i++; if (s[i + 1] === WJ) i++;
        continue;
      }
      if (d === WJ) { if (!drawing) out += '\\'; i++; continue; }
    }
    if (!drawing) out += c;
  }
  return out;
}

function parseAss(s, errors) {
  const lines = s.split('\n');
  let section = ''; let legacy = false;
  const info = {};
  let styleFmt = null; let eventFmt = null;
  const styles = new Map(); let firstStyle = null;
  const raw = []; let firstDialogueStyle = null;
  lines.forEach((line0, i) => {
    const line = line0.trim();
    if (!line || line.startsWith(';') || line.startsWith('!:')) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === 'v4 styles') legacy = true;
      return;
    }
    const k = line.indexOf(':');
    if (k < 0) return;
    const key = line.slice(0, k).trim().toLowerCase();
    const val = line.slice(k + 1).replace(/^ /, '');
    if (section === 'script info') {
      info[key] = val.trim();
      if (key === 'scripttype' && /^v4\.00$/i.test(val.trim())) legacy = true;
    } else if (section === 'v4+ styles' || section === 'v4 styles') {
      if (key === 'format') styleFmt = val.split(',').map((f) => f.trim().toLowerCase());
      else if (key === 'style') {
        const fmt = styleFmt || (section === 'v4 styles' ? SSA_STYLE_FORMAT : ASS_STYLE_FORMAT);
        const f = splitFields(val, fmt.length);
        const o = {}; fmt.forEach((name, j) => { o[name] = (f[j] ?? '').trim(); });
        const name = (o.name || '').replace(/^\*/, '');
        styles.set(name.toLowerCase(), o);
        if (!firstStyle) firstStyle = o;
      }
    } else if (section === 'events') {
      if (key === 'format') eventFmt = val.split(',').map((f) => f.trim().toLowerCase());
      else if (key === 'dialogue') {
        const fmt = eventFmt || ASS_EVENT_FORMAT;
        const f = splitFields(val, fmt.length);
        if (f.length < fmt.length) { pushErr(errors, `line ${i + 1}: bad Dialogue`); return; }
        const get = (name) => f[fmt.indexOf(name)];
        const start = parseAssTime(get('start')); const end = parseAssTime(get('end'));
        if (!Number.isFinite(start) || !Number.isFinite(end)) { pushErr(errors, `line ${i + 1}: bad time`); return; }
        if (firstDialogueStyle == null) firstDialogueStyle = String(get('style') ?? '').trim().replace(/^\*/, '');
        const ti = fmt.indexOf('text');
        raw.push({ start, end, text: assToPlain(ti >= 0 ? f[ti] : '') });
      }
    }
  });
  // Разрешение сценария: как в libass — без PlayResY он выводится из PlayResX, без обоих 384×288
  let playY = num(info.playresy, 0);
  const playX = num(info.playresx, 0);
  if (!(playY > 0)) playY = playX > 0 ? (playX === 1280 ? 1024 : Math.round((playX * 3) / 4)) : 288;
  const st = styles.get(String(firstDialogueStyle ?? 'default').toLowerCase()) || styles.get('default') || firstStyle;
  const res = { cues: finishCues(raw) };
  if (st) res.style = styleFromAss(st, playY, legacy);
  return res;
}

function styleFromAss(o, playY, legacy) {
  const D = SUB_STYLE_DEFAULT;
  const box = num(o.borderstyle, 1) === 3;
  const primary = parseAssColor(o.primarycolour);
  const outl = parseAssColor(o.outlinecolour ?? o.tertiarycolour);
  const back = parseAssColor(o.backcolour);
  const flag = (v) => num(v, 0) !== 0;
  const { position, align } = fromAlignment(o.alignment, legacy);
  const style = {
    font: o.fontname || D.font,
    size: roundTo(num(o.fontsize, D.size * playY) / playY, 1e4),
    bold: flag(o.bold),
    italic: flag(o.italic),
    color: primary ? primary.hex : D.color,
    // у плашки (BorderStyle 3) Outline — это поля плашки, а не обводка
    outline: box ? D.outline : roundTo(num(o.outline, 0) / playY, 1e5),
    outlineColor: !box && outl ? outl.hex : D.outlineColor,
    shadow: roundTo(num(o.shadow, 0) / playY, 1e5),
    shadowColor: back ? back.hex : D.shadowColor,
    box,
    boxColor: box && outl ? outl.hex : D.boxColor,
    boxOpacity: box && outl ? roundTo(1 - outl.alpha / 255, 100) : D.boxOpacity,
    position,
    align,
    margin: roundTo(num(o.marginv, 0) / playY, 1e4),
  };
  return cleanSubStyle(style);
}

function pushErr(errors, msg) {
  if (errors.length < MAX_ERRORS) errors.push(msg);
}

// ---------- разбор: точка входа ----------

/**
 * Разбор субтитров. text — уже декодированная строка.
 * → { format, cues, style?, errors } (style — только для ASS: стиль первой реплики или «Default»)
 */
export function parseSubtitles(text, format = null) {
  const s = prep(text);
  let fmt = format ? String(format).toLowerCase() : detectFormat(s);
  if (fmt === 'ssa') fmt = 'ass';
  if (fmt === 'webvtt') fmt = 'vtt';
  const errors = [];
  if (fmt === 'srt') return { format: fmt, cues: parseSrt(s, errors), errors };
  if (fmt === 'vtt') return { format: fmt, cues: parseVtt(s, errors), errors };
  if (fmt === 'ass') {
    const r = parseAss(s, errors);
    const out = { format: fmt, cues: r.cues, errors };
    if (r.style) out.style = r.style;
    return out;
  }
  return { format: null, cues: [], errors: ['unknown subtitle format'] };
}

/** Копия реплик: сортировка, время ≥ 0, длительность ≥ 0,1 с, округление до мс, текст обрезан, пустые убраны */
export function normalizeCues(cues) {
  const out = [];
  for (const c of Array.isArray(cues) ? cues : []) {
    if (!c || typeof c !== 'object') continue;
    const text = cleanText(c.text);
    if (!text) continue;
    const start = roundMs(Math.max(0, num(c.start, 0)));
    const end = roundMs(Math.max(num(c.end, 0), start + 0.1));
    out.push({ start, end, text });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Активные реплики в момент t (могут перекрываться) — для предпросмотра */
export function cueAt(cues, t) {
  const out = [];
  if (!Array.isArray(cues) || !Number.isFinite(t)) return out;
  for (const c of cues) if (c && c.start <= t && t < c.end) out.push(c);
  return out;
}

// ---------- запись ----------

/** Время → [ч, м, с, мс] без ошибок округления на границе секунды */
function hmsMs(t) {
  const ms = Math.max(0, Math.round(num(t, 0) * 1000));
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60, ms % 1000];
}
const p2 = (x) => String(x).padStart(2, '0');
const p3 = (x) => String(x).padStart(3, '0');
const srtTime = (t) => { const [h, m, s, ms] = hmsMs(t); return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`; };
const vttTime = (t) => { const [h, m, s, ms] = hmsMs(t); return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(ms)}`; };

/** Реплики для записи: отсортированы, текст без пустых строк (пустая строка завершает реплику в SRT/VTT) */
function writable(cues) {
  return normalizeCues(cues);
}

/** SRT (переводы строк — «\n», FFmpeg так читает) */
export function toSrt(cues) {
  return writable(cues).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

/** WebVTT: «&», «<», «>» экранируются */
export function toVtt(cues) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `WEBVTT\n\n${writable(cues).map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${esc(c.text)}\n`).join('\n')}`;
}

/** Простой текст → текст события ASS (см. шапку файла про экранирование) */
export function assText(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') out += '\\N';
    else if (c === '\\') out += `\\${WJ}`;
    else if (c === '{') out += s[i + 1] === '\\' ? `\\{${WJ}` : '\\{';
    else if (c === '}') out += '\\}';
    else out += c;
  }
  return out;
}

/** Цвет #rrggbb + прозрачность (0 — непрозрачный … 255) → &HAABBGGRR */
function assColor(hex, alpha = 0) {
  const h = isHex(hex) ? hex.slice(1) : '000000';
  const a = clamp(Math.round(alpha), 0, 255).toString(16).padStart(2, '0');
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Время ASS H:MM:SS.cc из целых сотых */
function assTime(cs) {
  const h = Math.floor(cs / 360000); const m = Math.floor(cs / 6000) % 60; const s = Math.floor(cs / 100) % 60;
  return `${h}:${p2(m)}:${p2(s)}.${p2(cs % 100)}`;
}

const fmtNum = (v) => String(roundTo(v, 100));

/**
 * ASS для прожига (фильтр ass/libass). tracks — [{ name?, style, cues }], у каждой дорожки свой стиль T1, T2, …
 * W, H — размер кадра (PlayRes); fontName(family) → настоящее имя семейства шрифта (из таблицы name).
 */
export function toAss(tracks, { W = 1920, H = 1080, fontName = (family) => family } = {}) {
  W = Math.max(1, Math.round(num(W, 1920))); H = Math.max(1, Math.round(num(H, 1080)));
  const list = (Array.isArray(tracks) ? tracks : []).filter((tr) => tr && typeof tr === 'object');
  const styleLines = []; const events = [];
  list.forEach((tr, k) => {
    const name = `T${k + 1}`;
    const st = cleanSubStyle(tr.style);
    const fname = String(fontName(st.font) || st.font).replace(/[,\r\n]/g, ' ').trim() || 'Arial';
    const fs = Math.max(1, Math.round(st.size * H));
    let outlineColour; let backColour; let outline;
    if (st.box) {
      const a = (1 - st.boxOpacity) * 255;
      outlineColour = assColor(st.boxColor, a); backColour = assColor(st.boxColor, a);
      outline = fs * 0.25; // поля плашки
    } else {
      outlineColour = assColor(st.outlineColor); backColour = assColor(st.shadowColor);
      outline = st.outline * H;
    }
    const primary = assColor(st.color);
    styleLines.push(`Style: ${name},${fname},${fs},${primary},${primary},${outlineColour},${backColour},`
      + `${st.bold ? -1 : 0},${st.italic ? -1 : 0},0,0,100,100,0,0,${st.box ? 3 : 1},${fmtNum(outline)},${fmtNum(st.shadow * H)},`
      + `${subAlignment(st)},${Math.round(0.04 * W)},${Math.round(0.04 * W)},${Math.round(st.margin * H)},1`);
    for (const c of normalizeCues(tr.cues)) {
      // Сотые из целых мс (без ошибки float: 1.005 → 101). Округление монотонно: если реплики стыкуются
      // (end ≤ следующий start), то и после округления не перекрываются
      const s = Math.round(Math.round(c.start * 1000) / 10); let e = Math.round(Math.round(c.end * 1000) / 10);
      if (e <= s) e = s + 1;
      events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},${name},,0,0,0,,${assText(c.text)}`);
    }
  });
  return [
    '[Script Info]',
    '; FF Montage',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
