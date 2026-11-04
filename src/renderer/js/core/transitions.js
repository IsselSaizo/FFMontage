// Встроенные переходы (плагин core) в декларативном виде.
// Экспорт — фильтр FFmpeg xfade (встроенный переход или своё выражение, как у «жалюзи»),
// предпросмотр — стили двух слоёв от доли перехода p = 0…1:
//   a — уходящий клип, b — следующий клип, top — какой слой сверху, overlay — заливка поверх обоих (для «через белый»).
// Проценты — с тремя знаками ({…:3}%), прозрачность — число без округления.
import { t } from '../i18n.js';
import { registerTransition, CORE } from '../registry.js';

// Мягкая шторка: маска-градиент в нужную сторону
const smooth = (dir) => ({ b: { mask: `linear-gradient(to ${dir}, transparent {(1-2*p)*100:3}%, black {(2-2*p)*100:3}%)` } });
// Круг: r = (p − 0,5)·3 для открытия и (0,5 − p)·3 для закрытия
const circle = (r) => `radial-gradient(circle farthest-corner at 50% 50%, black {${r}*100:3}%, transparent {(${r}+1)*100:3}%)`;

export const CORE_TRANSITIONS = [
  { id: 'fade', name: t('Растворение'), xfade: 'fade', preview: { b: { opacity: '{p}' } } },
  { id: 'fadeblack', name: t('Через чёрный'), xfade: 'fadeblack', preview: { a: { opacity: '{clamp(1-2*p, 0, 1)}' }, b: { opacity: '{clamp(2*p-1, 0, 1)}' } } },
  {
    id: 'fadewhite', name: t('Через белый'), xfade: 'fadewhite',
    preview: { a: { opacity: '{p < 0.5}' }, b: { opacity: '{p >= 0.5}' }, overlay: { color: '#fff', opacity: '{1-abs(2*p-1)}' } },
  },
  { id: 'wipeleft', name: t('Жёсткая шторка справа налево'), xfade: 'wipeleft', preview: { b: { clipPath: 'inset(0 0 0 {(1-p)*100:3}%)' } } },
  { id: 'wiperight', name: t('Жёсткая шторка слева направо'), xfade: 'wiperight', preview: { b: { clipPath: 'inset(0 {(1-p)*100:3}% 0 0)' } } },
  { id: 'wipeup', name: t('Жёсткая шторка снизу вверх'), xfade: 'wipeup', preview: { b: { clipPath: 'inset({(1-p)*100:3}% 0 0 0)' } } },
  { id: 'wipedown', name: t('Жёсткая шторка сверху вниз'), xfade: 'wipedown', preview: { b: { clipPath: 'inset(0 0 {(1-p)*100:3}% 0)' } } },
  { id: 'smoothleft', name: t('Мягкая шторка справа налево'), xfade: 'smoothleft', preview: smooth('right') },
  { id: 'smoothright', name: t('Мягкая шторка слева направо'), xfade: 'smoothright', preview: smooth('left') },
  { id: 'smoothup', name: t('Мягкая шторка снизу вверх'), xfade: 'smoothup', preview: smooth('bottom') },
  { id: 'smoothdown', name: t('Мягкая шторка сверху вниз'), xfade: 'smoothdown', preview: smooth('top') },
  { id: 'slideleft', name: t('Сдвиг влево'), xfade: 'slideleft', preview: { a: { transform: 'translateX({-p*100:3}%)' }, b: { transform: 'translateX({(1-p)*100:3}%)' } } },
  { id: 'slideright', name: t('Сдвиг вправо'), xfade: 'slideright', preview: { a: { transform: 'translateX({p*100:3}%)' }, b: { transform: 'translateX({(p-1)*100:3}%)' } } },
  { id: 'slideup', name: t('Сдвиг вверх'), xfade: 'slideup', preview: { a: { transform: 'translateY({-p*100:3}%)' }, b: { transform: 'translateY({(1-p)*100:3}%)' } } },
  { id: 'slidedown', name: t('Сдвиг вниз'), xfade: 'slidedown', preview: { a: { transform: 'translateY({p*100:3}%)' }, b: { transform: 'translateY({(p-1)*100:3}%)' } } },
  { id: 'circleopen', name: t('Круг из центра'), xfade: 'circleopen', preview: { b: { mask: circle('(p-0.5)*3') } } },
  { id: 'circleclose', name: t('Круг к центру'), xfade: 'circleclose', preview: { top: 'a', a: { mask: circle('(0.5-p)*3') } } },
  {
    id: 'zoomin', name: t('Приближение'), xfade: 'zoomin',
    preview: { a: { transform: 'scale({1+1.2*clamp(p*2, 0, 1)})' }, b: { opacity: '{clamp(2*p-1, 0, 1)}' } },
  },
  {
    id: 'hblur', name: t('Размытие'), xfade: 'hblur',
    preview: { a: { filter: 'blur({14*(1-abs(2*p-1)):1}px)' }, b: { opacity: '{p}', filter: 'blur({14*(1-abs(2*p-1)):1}px)' } },
  },
  // Жалюзи: 10 вертикальных полос, в каждой новый клип открывается слева направо (P в xfade идёт от 1 к 0)
  {
    id: 'blinds', name: t('Жалюзи'), xfade: { expr: 'if(lt(mod(X,W/10),(1-P)*W/10),B,A)' },
    preview: { b: { mask: 'repeating-linear-gradient(to right, black 0, black {p*10:3}%, transparent {p*10:3}%, transparent 10%)' } },
  },
];

for (const d of CORE_TRANSITIONS) registerTransition(d, CORE);
