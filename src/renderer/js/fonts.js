// Шрифты текста и субтитров (M5.2). Встроенные — Inter и Open Sans (assets/fonts, @font-face в styles.css),
// свои — файлы .ttf/.otf/.ttc в папке программы user-fonts (команды fonts_* в src-tauri/src/fonts.rs).
// В проекте шрифт хранится по имени семейства. У встроенных имя в интерфейсе короче настоящего
// («Inter» ↔ «Inter Variable» в файле) — для libass (субтитры) нужно настоящее: fontFile(name).family.
import { BUILTIN_FONTS } from './textModel.js';

const api = typeof window !== 'undefined' ? window.api : null;
// Имя в интерфейсе → файл встроенного шрифта и настоящее имя семейства
const BUILTIN = { Inter: { file: 'Inter.ttf', family: 'Inter Variable' }, 'Open Sans': { file: 'OpenSans.ttf', family: 'Open Sans' } };
let list = BUILTIN_FONTS.map((name) => ({ name, family: BUILTIN[name].family, builtin: true }));
let version = 0;
const listeners = new Set();
const loaded = new Map();   // путь → FontFace

export const fontsVersion = () => version;
export const onFontsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Все шрифты: [{ name (как в проекте и в CSS), family (для libass), builtin, file?, path? }] */
export const fontList = () => list.slice();
/** Настоящее имя семейства для шрифта проекта (неизвестный — как есть) */
export function fontFile(name) {
  const b = BUILTIN[name];
  if (b) return { family: b.family, builtin: true };
  const f = list.find((x) => x.name === name);
  return f ? { family: f.family, builtin: f.builtin, path: f.path } : { family: name, builtin: false };
}
/** Имя шрифта проекта по настоящему имени (из чужого ASS: «Inter Variable» → «Inter») */
export function fontByFamily(family) {
  const s = String(family || '').trim();
  for (const [name, b] of Object.entries(BUILTIN)) if (b.family.toLowerCase() === s.toLowerCase() || name.toLowerCase() === s.toLowerCase()) return name;
  const f = list.find((x) => x.family.toLowerCase() === s.toLowerCase() || x.name.toLowerCase() === s.toLowerCase());
  return f ? f.name : s;
}

const changed = () => { version++; for (const fn of listeners) { try { fn(); } catch (e) { console.warn('fonts', e); } } };

// Свой шрифт регистрируется в окне через FontFace (URL — media://, его разрешает программа)
async function register(entry) {
  if (!entry.url || loaded.has(entry.path) || typeof FontFace === 'undefined') return;
  try {
    const face = new FontFace(entry.family, `url("${entry.url}")`, { weight: '100 900' });
    await face.load();
    document.fonts.add(face);
    loaded.set(entry.path, face);
  } catch (e) { console.warn('font', entry.file, e); }
}

/** Перечитать список шрифтов из программы */
export async function refreshFonts() {
  if (!api || !api.fontsList) return list;
  let got = [];
  try { got = await api.fontsList(); } catch (e) { console.warn('fonts_list', e); return list; }
  const user = got.filter((x) => !x.builtin && x.family);
  await Promise.all(user.map(register));
  const seen = new Set(BUILTIN_FONTS.map((x) => x.toLowerCase()));
  const out = BUILTIN_FONTS.map((name) => ({ name, family: BUILTIN[name].family, builtin: true }));
  for (const u of user) {
    if (seen.has(u.family.toLowerCase())) continue;
    seen.add(u.family.toLowerCase());
    // family — для CSS (FontFace), ass — имя, по которому libass найдёт файл (nameID 1; у статических начертаний — «Roboto Medium»)
    out.push({ name: u.family, family: u.assFamily || u.family, builtin: false, file: u.file, path: u.path });
  }
  list = out;
  changed();
  return list;
}

/** Добавить свои шрифты (окно выбора файлов); возвращает добавленные имена */
export async function addFonts(paths = null) {
  const added = await api.fontsAdd(paths);
  await refreshFonts();
  return (added || []).map((x) => x.family);
}
export async function removeFont(file) {
  await api.fontsRemove(file);
  await refreshFonts();
}

// Встроенные шрифты объявлены в styles.css; дождаться их, чтобы первый кадр текста не был запасным шрифтом
export async function initFonts() {
  if (typeof document !== 'undefined' && document.fonts) {
    await Promise.all(['700 40px "Inter"', '400 40px "Inter"', '400 40px "Open Sans"', 'italic 400 40px "Inter"'].map((f) => document.fonts.load(f).catch(() => null)));
  }
  await refreshFonts();
}
