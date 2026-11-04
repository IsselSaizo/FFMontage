// Эффекты клипа: экспорт — фильтр FFmpeg (до масштабирования, на исходных пикселях),
// предпросмотр — CSS filter на элементе видео. Клип хранит список id: clip.effects = ['bw', 'blur', 'vignette.soft'],
// значения параметров — clip.fxp = { [effectId]: { k: v } } (нет значения — def из описания).
// Сами эффекты — в реестре (registry.js): встроенные описаны в core/effects.js, остальные приходят из плагинов.
// Неизвестные id (плагин пропал) в проекте остаются, экспорт и предпросмотр их пропускают.
import { EFFECTS, paramValues } from './registry.js';
import './core/effects.js';

export { EFFECTS };

export const effectById = (id) => EFFECTS.find((e) => e.id === id);
/** Эффекты клипа, которые сейчас есть в реестре (по порядку клипа) */
export const clipEffects = (c) => (Array.isArray(c && c.effects) ? c.effects.filter((id) => effectById(id)) : []);
/** id эффектов клипа, которых нет в реестре (данные пропавших плагинов) */
export const unknownEffects = (c) => (Array.isArray(c && c.effects) ? c.effects.filter((id) => typeof id === 'string' && !effectById(id)) : []);
/** Значения параметров эффекта у клипа (с проверкой границ) */
export function effectValues(c, id) {
  const e = effectById(id);
  return e ? paramValues(e.params, c && c.fxp && c.fxp[id]) : {};
}
const raw = (c, id) => (c && c.fxp && c.fxp[id]) || null;

// Цепочка фильтров FFmpeg ('' — эффектов нет). srcW — ширина исходного кадра
export function ffEffects(c, srcW) {
  const list = [];
  for (const id of clipEffects(c)) {
    // Ошибка в описании плагина (например, выражение дало не число) — эффект пропускается
    try { const s = effectById(id).ff(srcW, raw(c, id)); if (s) list.push(s); } catch (e) { console.warn(`effect ${id}:`, e.message); }
  }
  return list.length ? `${list.join(',')},` : '';
}

// CSS filter для предпросмотра. shownW — ширина показанного кадра в CSS-пикселях
export function cssEffects(c, shownW, extra = []) {
  const list = [];
  for (const id of clipEffects(c)) {
    try { const s = effectById(id).css(shownW, raw(c, id)); if (s) list.push(s); } catch { /* пропускаем */ }
  }
  return list.concat(extra).join(' ');
}
