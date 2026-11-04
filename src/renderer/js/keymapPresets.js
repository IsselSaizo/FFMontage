// Пресеты горячих клавиш других монтажных программ (решение D6: в ядре, обычный JSON).
// В пресете только отличия от родных клавиш: id действия → [сочетания]; [] — в этой программе у действия клавиши нет.
// In/Out, Q/W, Lift/Extract, JKL и инструмент обрезки появились в 0.4.3: у родных клавиш — раскладка Premiere.
// «сверить» — по памяти, не по официальной таблице; перед выпуском 0.4.0 проверить в самих программах.
import { t } from './i18n.js';

export const PRESETS = {
  native: { name: t('Родные (FF Montage)'), keys: {} },

  resolve: {
    name: 'DaVinci Resolve',
    keys: {
      'edit.redo': ['Ctrl+Shift+KeyZ'],
      'clip.split': ['Ctrl+KeyB', 'Ctrl+Backslash'],
      'clip.splitAll': ['Ctrl+Shift+KeyB'], // сверить
      'clip.delete': ['Backspace'],
      'clip.rippleDelete': ['Delete', 'Shift+Backspace'],
      'clip.duplicate': [],
      'clip.freeze': ['Shift+KeyR'],
      'clip.reverse': [],
      'timeline.magnet': ['KeyN'],
      'play.toggle': ['Space'],
      'view.fullscreen': ['Ctrl+KeyF'],
      'view.zoomFit': ['Shift+KeyZ'],
      // Resolve: Shift+[ / Shift+] — обрезать до курсора, Ctrl+Shift+[ / ] — со сдвигом (сверить)
      'clip.trimStart': ['Shift+BracketLeft'],
      'clip.trimEnd': ['Shift+BracketRight'],
      'clip.trimStartRipple': ['Ctrl+Shift+BracketLeft'],
      'clip.trimEndRipple': ['Ctrl+Shift+BracketRight'],
      'edit.lift': [],
      'edit.extract': [],
    },
  },

  premiere: {
    name: 'Adobe Premiere Pro',
    keys: {
      'project.new': ['Ctrl+Alt+KeyN'],
      'export.open': ['Ctrl+KeyM'],
      'edit.redo': ['Ctrl+Shift+KeyZ'],
      'clip.split': ['Ctrl+KeyK'],
      'clip.splitAll': ['Ctrl+Shift+KeyK'],
      'clip.delete': ['Delete', 'Backspace'],
      'clip.rippleDelete': ['Shift+Delete', 'Shift+Backspace'],
      'clip.duplicate': [],
      'clip.freeze': [],
      'clip.reverse': [],
      'tool.select': ['KeyV'],
      'tool.blade': ['KeyC'],
      'timeline.magnet': ['KeyS'],
      'play.toggle': ['Space'],
      'view.fullscreen': ['Ctrl+Backquote'],
      'view.zoomIn': ['Equal'],
      'view.zoomOut': ['Minus'],
      'view.zoomFit': ['Backslash'],
      // Premiere: B — Ripple Edit (у нас один инструмент обрезки), Ctrl+Shift+X — убрать In/Out
      'tool.trim': ['KeyB'],
      'mark.clear': ['Ctrl+Shift+KeyX'],
    },
  },

  capcut: {
    name: 'CapCut',
    keys: {
      'edit.redo': ['Ctrl+Shift+KeyZ'],
      'clip.split': ['Ctrl+KeyB'],
      'clip.splitAll': [],
      'clip.delete': ['Delete', 'Backspace'],
      'clip.rippleDelete': [],
      'clip.freeze': [], // сверить
      'clip.reverse': [], // сверить
      'timeline.magnet': ['KeyN'], // сверить
      'play.toggle': ['Space'],
      'play.back5': [],
      'play.fwd5': [],
      'view.fullscreen': ['Ctrl+Shift+KeyF'], // сверить
      'view.zoomFit': ['Shift+KeyZ'],
    },
  },
};

// ---------------------------------------------------------------------------
// Пресеты из плагинов (contributes.keymaps / ffm.register.keymap): тот же объект PRESETS пополняется,
// у такого пресета есть поле plugin. Встроенные пресеты плагин заменить не может.
// ---------------------------------------------------------------------------
const presetListeners = new Set();
export const onPresetsChange = (fn) => { presetListeners.add(fn); return () => presetListeners.delete(fn); };
const changed = () => { for (const fn of presetListeners) { try { fn(); } catch (e) { console.warn('keymap presets', e); } } };

const COMBO = /^(?:(?:Ctrl|Alt|Shift)\+){0,3}[A-Za-z][A-Za-z0-9]{0,24}$/;

/** id — полный id пресета, preset — { name, keys: { actionId: [сочетания] } }, pluginId — владелец */
export function registerPreset(id, preset, pluginId) {
  if (typeof id !== 'string' || !id || !pluginId) throw new Error('keymap preset: id and plugin are required');
  if (PRESETS[id] && PRESETS[id].plugin !== pluginId) throw new Error(`keymap preset id is taken: ${id}`);
  const keys = {};
  for (const [action, list] of Object.entries((preset && preset.keys) || {})) {
    if (typeof action !== 'string' || !Array.isArray(list)) continue;
    keys[action] = list.filter((k) => typeof k === 'string' && COMBO.test(k)).slice(0, 8);
  }
  PRESETS[id] = { name: String((preset && preset.name) || id).slice(0, 80), keys, plugin: pluginId };
  changed();
  return id;
}

/** Убрать все пресеты плагина */
export function unregisterPresets(pluginId) {
  let n = 0;
  for (const [id, p] of Object.entries(PRESETS)) if (p.plugin && p.plugin === pluginId) { delete PRESETS[id]; n++; }
  if (n) changed();
  return n;
}
