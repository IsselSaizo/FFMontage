// Переходы между клипами. Экспорт делает фильтр FFmpeg xfade (transition.xfadeArg — встроенный переход
// или своё выражение, как у «жалюзи»), а здесь — приближённая картинка для предпросмотра на CSS.
// Сами переходы — в реестре (registry.js): встроенные описаны в core/transitions.js, остальные приходят из плагинов.
//
// style(p) получает долю перехода p = 0…1 и возвращает стили для двух слоёв:
//   a — уходящий клип, b — следующий клип, top — какой слой сверху,
//   overlay — заливка поверх обоих (для «через белый»).
// Неизвестный тип (плагин пропал) в проекте остаётся; показывается и экспортируется как растворение.
import { TRANSITIONS } from './registry.js';
import './core/transitions.js';

export { TRANSITIONS };

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const DEFAULT_TRANSITION = 'fade';
export const DEFAULT_DURATION = 0.5;
export const MIN_DURATION = 0.1;
export const MAX_DURATION = 3;

// Неизвестный тип — первый (растворение), как и в экспорте
export const transitionById = (id) => TRANSITIONS.find((t) => t.id === id) || TRANSITIONS[0];
export const isKnownTransition = (id) => TRANSITIONS.some((x) => x.id === id);

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
