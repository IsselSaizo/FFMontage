// Перевод интерфейса (ru — исходный язык, en — словарь).
// Как gettext: русская строка в коде и есть ключ — t('Новый проект') → 'New project'.
// Подстановки: t('Импортировано файлов: {n}', { n }) — в переводе те же {n}.
// Нет перевода — показываем русскую строку (tests/i18n-check.js ловит такие места заранее).
//
// Язык известен синхронно ещё до загрузки модулей: программа кладёт его в window.__FFM_BOOT
// (src-tauri/src/windows.rs). После переключения в настройках окно перезагружается, а новый язык
// до перезапуска программы берётся из sessionStorage.
import { EN } from './i18n/en.js';

export const LANGS = [
  { id: 'ru', name: 'Русский' }, // i18n-ignore — название языка всегда на нём самом
  { id: 'en', name: 'English' },
];

// Модули экспорта грузятся и в Node (tests/engine-test.js) — там окна нет, язык русский
const boot = (typeof window !== 'undefined' && window.__FFM_BOOT) || {};
const fromSession = (() => { try { return sessionStorage.getItem('ffm.lang'); } catch { return null; } })();
let lang = fromSession || boot.lang || 'ru';
if (!LANGS.some((l) => l.id === lang)) lang = 'ru';
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export const getLang = () => lang;
/** Выбирал ли пользователь язык (иначе при запуске предлагаем выбрать) */
export const langChosen = () => !!(fromSession || boot.langChosen);
export const systemLang = () => boot.systemLang || 'ru';

const fill = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s);

export function t(s, params) {
  const r = lang === 'en' ? (EN[s] ?? s) : s;
  return fill(r, params);
}

/** Строка на конкретном языке (для выбора языка — подписи сразу на обоих языках) */
export function tIn(l, s, params) {
  return fill(l === 'en' ? (EN[s] ?? s) : s, params);
}

/** Число с десятичным разделителем языка: 2,5 / 2.5 */
export function num(x, digits = 1) {
  const s = Number(x).toFixed(digits);
  return lang === 'ru' ? s.replace('.', ',') : s;
}

/** Запомнить язык на время работы окна (перезагрузка окна его подхватит) */
export function rememberLang(l) {
  try { sessionStorage.setItem('ffm.lang', l); } catch { /* ignore */ }
}
