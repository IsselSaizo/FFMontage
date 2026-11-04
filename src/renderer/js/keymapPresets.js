// Пресеты горячих клавиш других монтажных программ (решение D6: в ядре, обычный JSON).
// В пресете только отличия от родных клавиш: id действия → [сочетания]; [] — в этой программе у действия клавиши нет.
// Действия, которых у нас пока нет (In/Out, Q/W, Ripple/Roll), появятся вместе с функциями (0.4.4) — тогда и дополним.
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
