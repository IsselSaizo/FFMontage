// Переходы между клипами. Экспорт делает фильтр FFmpeg xfade (id перехода = имя в xfade,
// кроме «жалюзи» — там своё выражение), а здесь — приближённая картинка для предпросмотра на CSS.
//
// style(p) получает долю перехода p = 0…1 и возвращает стили для двух слоёв:
//   a — уходящий клип, b — следующий клип, top — какой слой сверху,
//   overlay — заливка поверх обоих (для «через белый»).

const pct = (x) => `${(x * 100).toFixed(3)}%`;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const DEFAULT_TRANSITION = 'fade';
export const DEFAULT_DURATION = 0.5;
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 3;

export const TRANSITIONS = [
  { id: 'fade', name: 'Растворение', style: (p) => ({ b: { opacity: p } }) },
  { id: 'fadeblack', name: 'Через чёрный', style: (p) => ({ a: { opacity: clamp01(1 - 2 * p) }, b: { opacity: clamp01(2 * p - 1) } }) },
  {
    id: 'fadewhite', name: 'Через белый',
    style: (p) => ({ a: { opacity: p < 0.5 ? 1 : 0 }, b: { opacity: p < 0.5 ? 0 : 1 }, overlay: { color: '#fff', opacity: 1 - Math.abs(2 * p - 1) } }),
  },
  { id: 'wipeleft', name: 'Жёсткая шторка справа налево', style: (p) => ({ b: { clipPath: `inset(0 0 0 ${pct(1 - p)})` } }) },
  { id: 'wiperight', name: 'Жёсткая шторка слева направо', style: (p) => ({ b: { clipPath: `inset(0 ${pct(1 - p)} 0 0)` } }) },
  { id: 'wipeup', name: 'Жёсткая шторка снизу вверх', style: (p) => ({ b: { clipPath: `inset(${pct(1 - p)} 0 0 0)` } }) },
  { id: 'wipedown', name: 'Жёсткая шторка сверху вниз', style: (p) => ({ b: { clipPath: `inset(0 0 ${pct(1 - p)} 0)` } }) },
  { id: 'smoothleft', name: 'Мягкая шторка справа налево', style: (p) => ({ b: { mask: `linear-gradient(to right, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
  { id: 'smoothright', name: 'Мягкая шторка слева направо', style: (p) => ({ b: { mask: `linear-gradient(to left, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
  { id: 'smoothup', name: 'Мягкая шторка снизу вверх', style: (p) => ({ b: { mask: `linear-gradient(to bottom, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
  { id: 'smoothdown', name: 'Мягкая шторка сверху вниз', style: (p) => ({ b: { mask: `linear-gradient(to top, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
  { id: 'slideleft', name: 'Сдвиг влево', style: (p) => ({ a: { transform: `translateX(${pct(-p)})` }, b: { transform: `translateX(${pct(1 - p)})` } }) },
  { id: 'slideright', name: 'Сдвиг вправо', style: (p) => ({ a: { transform: `translateX(${pct(p)})` }, b: { transform: `translateX(${pct(p - 1)})` } }) },
  { id: 'slideup', name: 'Сдвиг вверх', style: (p) => ({ a: { transform: `translateY(${pct(-p)})` }, b: { transform: `translateY(${pct(1 - p)})` } }) },
  { id: 'slidedown', name: 'Сдвиг вниз', style: (p) => ({ a: { transform: `translateY(${pct(p)})` }, b: { transform: `translateY(${pct(p - 1)})` } }) },
  {
    id: 'circleopen', name: 'Круг из центра',
    style: (p) => { const r = (p - 0.5) * 3; return { b: { mask: `radial-gradient(circle farthest-corner at 50% 50%, black ${pct(r)}, transparent ${pct(r + 1)})` } }; },
  },
  {
    id: 'circleclose', name: 'Круг к центру',
    style: (p) => { const r = (0.5 - p) * 3; return { top: 'a', a: { mask: `radial-gradient(circle farthest-corner at 50% 50%, black ${pct(r)}, transparent ${pct(r + 1)})` } }; },
  },
  {
    id: 'zoomin', name: 'Приближение',
    style: (p) => ({ a: { transform: `scale(${1 + 1.2 * clamp01(p * 2)})` }, b: { opacity: clamp01(2 * p - 1) } }),
  },
  {
    id: 'hblur', name: 'Размытие',
    style: (p) => { const b = 14 * (1 - Math.abs(2 * p - 1)); return { a: { filter: `blur(${b.toFixed(1)}px)` }, b: { opacity: p, filter: `blur(${b.toFixed(1)}px)` } }; },
  },
  {
    id: 'blinds', name: 'Жалюзи',
    style: (p) => ({ b: { mask: `repeating-linear-gradient(to right, black 0, black ${(p * 10).toFixed(3)}%, transparent ${(p * 10).toFixed(3)}%, transparent 10%)` } }),
  },
];

export const transitionById = (id) => TRANSITIONS.find((t) => t.id === id) || TRANSITIONS[0];

const RESET = { opacity: '', transform: '', clipPath: '', maskImage: '', filter: '', zIndex: '' };

// Применить кадр перехода к двум элементам (и заливке поверх). extraA/extraB — множители прозрачности (затухания).
export function applyTransition(type, p, elA, elB, overlay, extraA = 1, extraB = 1) {
  const st = transitionById(type).style(clamp01(p));
  const put = (el, s, extra, z) => {
    if (!el) return;
    const o = (s && s.opacity !== undefined ? s.opacity : 1) * extra;
    Object.assign(el.style, RESET, {
      opacity: String(o),
      transform: (s && s.transform) || '',
      clipPath: (s && s.clipPath) || '',
      maskImage: (s && s.mask) || '',
      filter: (s && s.filter) || '',
      zIndex: String(z),
    });
  };
  const aTop = st.top === 'a';
  put(elA, st.a, extraA, aTop ? 2 : 1);
  put(elB, st.b, extraB, aTop ? 1 : 2);
  if (overlay) {
    if (st.overlay) { overlay.style.background = st.overlay.color; overlay.style.opacity = String(st.overlay.opacity); } else overlay.style.opacity = '0';
  }
}

export function resetLayer(el, opacity = 1) {
  if (!el) return;
  Object.assign(el.style, RESET, { opacity: String(opacity) });
}
