// Экранирование для FFmpeg (M1.7). Одно место на всё приложение: экспорт, плагины (M3.4), текст (M5).
//
// В графе фильтров два уровня разбора (libavfilter/graphparser.c и ff_filter_opt_parse, оба — av_get_token):
//   1) граф: «[», «]», «,», «;» разделяют фильтры и метки → экранируются вместе с «\» и «'»;
//   2) опции фильтра: «:» разделяет опции → экранируется вместе с «\» и «'».
// Значение сначала экранируется для опции, потом — для графа (ffValue). Rust-проверка графа
// (src-tauri/src/plancheck.rs get_token) снимает те же два уровня, так что значение доходит до фильтра как было.
//
// Аргументы командной строки (-i путь) не экранируются: процесс получает их отдельными строками.

const OPT_SPECIAL = /[\\':]/g;
const GRAPH_SPECIAL = /[\\'[\],;]/g;

/** Уровень опции: «\», «'», «:» */
export const escOpt = (v) => String(v).replace(OPT_SPECIAL, (c) => `\\${c}`);
/** Уровень графа: «\», «'», «[», «]», «,», «;» */
export const escGraph = (v) => String(v).replace(GRAPH_SPECIAL, (c) => `\\${c}`);
/** Значение опции фильтра внутри строки графа: оба уровня */
export const ffValue = (v) => escGraph(escOpt(v));

/**
 * Путь к файлу как значение опции в графе (movie=…, lut3d=file=…, шрифт drawtext):
 * «\» → «/» (FFmpeg на Windows их понимает), без префикса \\?\, затем ffValue.
 * Только абсолютные пути: относительный зависел бы от рабочей папки FFmpeg.
 */
export function ffPath(p) {
  let s = String(p ?? '');
  if (!s) throw new Error('ffPath: empty path');
  if (/[\0\r\n]/.test(s)) throw new Error('ffPath: control characters in path');
  s = s.replace(/^\\\\\?\\(UNC\\)?/, (m, unc) => (unc ? '\\\\' : ''));
  s = s.replace(/\\/g, '/');
  if (!/^([a-zA-Z]:\/|\/)/.test(s)) throw new Error(`ffPath: path must be absolute: ${p}`);
  return ffValue(s);
}

/**
 * Текст для drawtext (text=…): у drawtext свой уровень — «\» и «%» (подстановки %{…}),
 * поверх него — ffValue.
 */
export const ffText = (s) => ffValue(String(s ?? '').replace(/[\\%]/g, (c) => `\\${c}`));

/**
 * Обратное преобразование одного уровня (как av_get_token до символа-разделителя) — для тестов
 * и для проверки, что строка доходит до фильтра без изменений.
 */
export function unescapeToken(s, term = '') {
  let out = ''; let i = 0;
  while (i < s.length && !term.includes(s[i])) {
    const c = s[i++];
    if (c === '\\' && i < s.length) out += s[i++];
    else if (c === "'") { while (i < s.length && s[i] !== "'") out += s[i++]; if (i < s.length) i++; }
    else out += c;
  }
  return { value: out, rest: s.slice(i) };
}
