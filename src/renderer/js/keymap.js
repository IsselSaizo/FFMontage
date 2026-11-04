// Реестр действий и горячих клавиш (основа M1.1).
// Сочетание — строка «Ctrl+Alt+Shift+<KeyboardEvent.code>», например 'Ctrl+KeyS', 'Shift+ArrowLeft':
// по коду клавиши, поэтому работает в любой раскладке.
// Слои: клавиши по умолчанию → пресет (DaVinci Resolve / Premiere Pro / CapCut) → свои клавиши пользователя.
// Где взять подпись клавиши для подсказки: keyHint('clip.split') → 'S'; h('button', { tip: [t('Разрезать'), 'clip.split'] }).
// Плагины добавляют свои действия (registerAction, категория «Плагины») и пресеты (registerPreset).
import { t } from './i18n.js';
import { PRESETS, registerPreset, unregisterPresets, onPresetsChange } from './keymapPresets.js';

export { PRESETS, registerPreset, unregisterPresets };

export const CATEGORIES = [
  { id: 'file', title: t('Файл') },
  { id: 'edit', title: t('Правка') },
  { id: 'tools', title: t('Инструменты') },
  { id: 'play', title: t('Воспроизведение') },
  { id: 'view', title: t('Вид') },
  { id: 'plugins', title: t('Плагины') },
];

// global — работает и при вводе текста (Ctrl+S и т.п.)
const A = (id, cat, title, keys, opts = {}) => ({ id, cat, title, keys, ...opts });
export const ACTIONS = [
  A('project.new', 'file', t('Новый проект'), ['Ctrl+KeyN'], { global: true }),
  A('project.open', 'file', t('Открыть проект…'), ['Ctrl+KeyO'], { global: true }),
  A('project.save', 'file', t('Сохранить'), ['Ctrl+KeyS'], { global: true }),
  A('project.saveAs', 'file', t('Сохранить как…'), ['Ctrl+Shift+KeyS'], { global: true }),
  A('media.import', 'file', t('Импорт медиа…'), ['Ctrl+KeyI'], { global: true }),
  A('export.open', 'file', t('Экспорт'), ['Ctrl+KeyE'], { global: true }),
  A('app.settings', 'file', t('Настройки'), ['Ctrl+Comma'], { global: true }),

  A('edit.undo', 'edit', t('Отменить'), ['Ctrl+KeyZ']),
  A('edit.redo', 'edit', t('Повторить'), ['Ctrl+KeyY', 'Ctrl+Shift+KeyZ']),
  A('clip.copy', 'edit', t('Копировать клип'), ['Ctrl+KeyC']),
  A('clip.paste', 'edit', t('Вставить клип'), ['Ctrl+KeyV']),
  A('clip.duplicate', 'edit', t('Дублировать клип'), ['Ctrl+KeyD']),
  A('clip.delete', 'edit', t('Удалить'), ['Delete', 'Backspace']),
  A('clip.rippleDelete', 'edit', t('Удалить и сдвинуть'), ['Shift+Delete', 'Shift+Backspace']),
  A('clip.split', 'edit', t('Разрезать по курсору'), ['KeyS']),
  A('clip.splitAll', 'edit', t('Разрезать всё под курсором (видео и звук)'), ['Alt+KeyS']),
  A('clip.freeze', 'edit', t('Стоп-кадр'), ['KeyF']),
  A('clip.reverse', 'edit', t('Отзеркалить (задом наперёд)'), ['KeyR']),

  A('tool.select', 'tools', t('Выделение'), ['KeyA']),
  A('tool.blade', 'tools', t('Лезвие'), ['KeyB']),
  A('timeline.magnet', 'tools', t('Магнит (привязка)'), []),

  A('play.toggle', 'play', t('Пуск / пауза'), ['Space', 'KeyK']),
  A('play.frameBack', 'play', t('На кадр назад'), ['ArrowLeft']),
  A('play.frameFwd', 'play', t('На кадр вперёд'), ['ArrowRight']),
  A('play.secBack', 'play', t('На 1 с назад'), ['Shift+ArrowLeft']),
  A('play.secFwd', 'play', t('На 1 с вперёд'), ['Shift+ArrowRight']),
  A('play.back5', 'play', t('На 5 с назад'), ['KeyJ']),
  A('play.fwd5', 'play', t('На 5 с вперёд'), ['KeyL']),
  A('play.start', 'play', t('В начало'), ['Home']),
  A('play.end', 'play', t('В конец'), ['End']),

  A('view.fullscreen', 'view', t('Плеер во весь экран'), ['Shift+KeyF']),
  A('view.zoomIn', 'view', t('Приблизить таймлайн'), ['Ctrl+Equal', 'Ctrl+NumpadAdd']),
  A('view.zoomOut', 'view', t('Отдалить таймлайн'), ['Ctrl+Minus', 'Ctrl+NumpadSubtract']),
  A('view.zoomFit', 'view', t('Весь проект на таймлайне'), ['Ctrl+Digit0', 'Ctrl+Numpad0']),
];
export const actionById = (id) => ACTIONS.find((a) => a.id === id);

// ---------------------------------------------------------------------------
// Слои клавиш
// ---------------------------------------------------------------------------
let presetId = 'native';
// Выбранный пользователем пресет: если он из плагина, который ещё не загружен (или выключен),
// пока действуют родные клавиши, а при появлении пресета он включается сам
let wantedPreset = 'native';
let custom = {}; // id → [сочетания] (пустой массив — клавиша снята)
const listeners = new Set();
const notify = () => { refreshTips(); for (const fn of listeners) { try { fn(); } catch (e) { console.warn('keymap listener', e); } } };

export function configureKeymap({ preset, keys } = {}) {
  wantedPreset = typeof preset === 'string' && preset ? preset : 'native';
  presetId = PRESETS[wantedPreset] ? wantedPreset : 'native';
  custom = keys && typeof keys === 'object' ? { ...keys } : {};
  notify();
}
export const keymapState = () => ({ preset: presetId, keys: { ...custom } });
export const onKeymapChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Пресеты плагинов появились/пропали
onPresetsChange(() => {
  presetId = PRESETS[wantedPreset] ? wantedPreset : 'native';
  notify();
});

/** Клавиши действия без учёта своих: по умолчанию или из пресета */
export function baseKeysOf(id, preset = presetId) {
  const p = PRESETS[preset]?.keys?.[id];
  return p ? [...p] : [...(actionById(id)?.keys || [])];
}
export function keysOf(id) {
  return Array.isArray(custom[id]) ? [...custom[id]] : baseKeysOf(id);
}
export const isCustom = (id) => Array.isArray(custom[id]);

/** Все сочетания → действия, где их больше одного */
export function conflicts() {
  const by = new Map();
  for (const a of ACTIONS) for (const k of keysOf(a.id)) { if (!by.has(k)) by.set(k, []); by.get(k).push(a.id); }
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

// ---------------------------------------------------------------------------
// Сочетания: из события, подписи
// ---------------------------------------------------------------------------
const MOD_CODES = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
export function comboFromEvent(e) {
  if (MOD_CODES.includes(e.code) || !e.code) return null;
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code}`;
}

const CODE_LABEL = {
  Space: () => t('Пробел'), ArrowLeft: () => '←', ArrowRight: () => '→', ArrowUp: () => '↑', ArrowDown: () => '↓',
  Delete: () => 'Del', Backspace: () => 'Backspace', Escape: () => 'Esc', Enter: () => 'Enter', Tab: () => 'Tab',
  Equal: () => '=', Minus: () => '-', Comma: () => ',', Period: () => '.', Slash: () => '/', Backslash: () => '\\',
  BracketLeft: () => '[', BracketRight: () => ']', Semicolon: () => ';', Quote: () => '\'', Backquote: () => '`',
  NumpadAdd: () => 'Num +', NumpadSubtract: () => 'Num −', NumpadMultiply: () => 'Num *', NumpadDivide: () => 'Num /',
  PageUp: () => 'PgUp', PageDown: () => 'PgDn',
};
export function keyLabel(combo) {
  if (!combo) return '';
  const parts = combo.split('+');
  const code = parts.pop();
  let k;
  if (CODE_LABEL[code]) k = CODE_LABEL[code]();
  else if (/^Key[A-Z]$/.test(code)) k = code.slice(3);
  else if (/^Digit\d$/.test(code)) k = code.slice(5);
  else if (/^Numpad\d$/.test(code)) k = `Num ${code.slice(6)}`;
  else k = code;
  return [...parts, k].join('+');
}
/** Подпись первой клавиши действия ('' — клавиши нет) */
export const keyHint = (id) => keyLabel(keysOf(id)[0]);
/** Текст подсказки с клавишей: «Разрезать (S)» */
export const withKey = (text, id) => { const k = keyHint(id); return k ? `${text} (${k})` : text; };

// Подсказки кнопок обновляются при смене клавиш: util.h(…, { tip: [текст, id] }) ставит data-tip/data-tip-action
export function refreshTips(root) {
  if (typeof document === 'undefined') return;
  for (const el of (root || document).querySelectorAll('[data-tip-action]')) el.title = withKey(el.dataset.tip, el.dataset.tipAction);
}

// ---------------------------------------------------------------------------
// Выполнение
// ---------------------------------------------------------------------------
const handlers = new Map();
export function bindAction(id, fn) { handlers.set(id, fn); }
export function runAction(id, e) {
  const fn = handlers.get(id);
  if (!fn) return false;
  fn(e);
  return true;
}

// ---------------------------------------------------------------------------
// Действия плагинов
// ---------------------------------------------------------------------------
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,40}\.[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const COMBO = /^(?:(?:Ctrl|Alt|Shift)\+){0,3}[A-Za-z][A-Za-z0-9]{0,24}$/;

/**
 * Добавить действие плагина: def = { id: '<pluginId>.<id>', title, plugin, cat?, keys? }, run(e) — выполнение.
 * Категория — одна из CATEGORIES (по умолчанию «Плагины»). Сочетания по умолчанию — keys.
 */
export function registerAction(def, run) {
  if (!def || typeof def.id !== 'string' || !ACTION_ID.test(def.id)) throw new Error(`bad action id: ${def && def.id}`);
  if (!def.plugin || !def.id.startsWith(`${def.plugin}.`)) throw new Error(`action id must start with the plugin id: ${def.id}`);
  if (typeof run !== 'function') throw new Error('action handler is required');
  const old = actionById(def.id);
  if (old && old.plugin !== def.plugin) throw new Error(`action id is taken: ${def.id}`);
  if (old) ACTIONS.splice(ACTIONS.indexOf(old), 1);
  const cat = CATEGORIES.some((c) => c.id === def.cat) && def.cat !== 'file' ? def.cat : 'plugins';
  const keys = (Array.isArray(def.keys) ? def.keys : []).filter((k) => typeof k === 'string' && COMBO.test(k)).slice(0, 4);
  ACTIONS.push(A(def.id, cat, String(def.title || def.id).slice(0, 120), keys, { plugin: def.plugin }));
  handlers.set(def.id, run);
  notify();
  return def.id;
}

/** Убрать все действия плагина (его клавиши в настройках пользователя остаются — вернутся вместе с плагином) */
export function unregisterActions(pluginId) {
  let n = 0;
  for (let i = ACTIONS.length - 1; i >= 0; i--) {
    if (ACTIONS[i].plugin && ACTIONS[i].plugin === pluginId) { handlers.delete(ACTIONS[i].id); ACTIONS.splice(i, 1); n++; }
  }
  if (n) notify();
  return n;
}

/** Нажатие → действие. typing — фокус в поле ввода (работают только global-действия). true — обработано. */
export function dispatchKey(e, typing) {
  const combo = comboFromEvent(e);
  if (!combo) return false;
  for (const a of ACTIONS) {
    if (typing && !a.global) continue;
    if (!keysOf(a.id).includes(combo)) continue;
    if (!handlers.has(a.id)) continue;
    e.preventDefault();
    runAction(a.id, e);
    return true;
  }
  return false;
}
