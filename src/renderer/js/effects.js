// Эффекты клипа: экспорт — фильтр FFmpeg (до масштабирования, на исходных пикселях),
// предпросмотр — CSS filter на элементе видео. Клип хранит список id: clip.effects = ['bw', 'blur', 'vignette.soft'],
// значения параметров — clip.fxp = { [effectId]: { k: v } } (нет значения — def из описания).
// Сами эффекты — в реестре (registry.js): встроенные описаны в core/effects.js, остальные приходят из плагинов.
// Неизвестные id (плагин пропал) в проекте остаются, экспорт и предпросмотр их пропускают.
import { EFFECTS, paramValues } from './registry.js';
// clip.fxp[id].showPreview — чекбокс «Показывать превью» у эффектов preview: 'proxy' (не параметр: в граф не идёт)
import './core/effects.js';
import { speedOf, srcAt } from './clipTime.js';

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

// Цепочка фильтров FFmpeg ('' — эффектов нет). srcW — ширина исходного кадра.
// Эффекты stage: 'source' (стабилизация) сюда не входят: они идут первыми, до скорости — sourceChain / exportPlan.js
export function ffEffects(c, srcW) {
  const list = [];
  for (const id of clipEffects(c)) {
    const e = effectById(id);
    if (e.stage === 'source') continue;
    // Ошибка в описании плагина (например, выражение дало не число) — эффект пропускается
    try { const s = e.ff(srcW, raw(c, id)); if (s) list.push(s); } catch (err) { console.warn(`effect ${id}:`, err.message); }
  }
  return list.length ? `${list.join(',')},` : '';
}

// --- Эффекты на кадрах файла (stage: 'source', стабилизация — plugins-bundled/stabilize) ---
// Возможности сборки FFmpeg, нужные таким эффектам (js/stab.js ставит по app_info): { vidstab: false } — эффекты
// с prepare.kind 'vidstab' недоступны. Не задано — считаем, что есть (тесты движка проверяют сборку сами).
const hostCaps = { vidstab: null };
export function setHostCaps(caps) { if (caps && 'vidstab' in caps) hostCaps.vidstab = caps.vidstab === null ? null : !!caps.vidstab; }
export const hostCap = (k) => hostCaps[k];
/** Эффект доступен в этой сборке FFmpeg (нет vidstab — Баланс/Максимум стабилизации недоступны) */
export const effectAvailable = (e) => !(e && e.prepare && e.prepare.kind === 'vidstab' && hostCaps.vidstab === false);
/**
 * Первый эффект клипа со stage 'source' → { id, effect, values, preview (чекбокс «Показывать превью»), prepare }
 * или null. Остальные такие эффекты клипа не действуют (store.toggleEffect оставляет один).
 */
export function sourceEffect(c) {
  const id = clipEffects(c).find((x) => effectById(x).stage === 'source');
  if (!id) return null;
  const effect = effectById(id);
  const r = raw(c, id) || {};
  const values = paramValues(effect.params, r);
  return { id, effect, values, preview: r.showPreview === true, prepare: effect.prepare ? { kind: effect.prepare.kind, args: effect.prepare.args(r) } : null };
}
/** Включено ли «Показывать превью» у эффекта клипа (clip.fxp[id].showPreview) */
export const showPreviewOf = (c, id) => !!(raw(c, id) && raw(c, id).showPreview === true);
/**
 * Цепочка эффекта на кадрах файла ('' — нет). file — путь файла подготовки (.trf), уже для графа (ffPath).
 * Нужен файл, а его нет — ошибка (экспорт пропускает эффект с предупреждением).
 */
export function sourceChain(c, srcW, file = null) {
  const s = sourceEffect(c);
  if (!s) return '';
  return s.effect.ff(srcW, raw(c, s.id), file);
}

/** У клипа есть эффект, который плеер не может честно показать CSS (описание с preview: 'frame') */
export const needsFramePreview = (c) => clipEffects(c).some((id) => effectById(id).preview === 'frame');

/**
 * Запрос кадров шторки «ДО / ПОСЛЕ» (Rust compare.rs, команда compare_frames) для момента t таймлайна:
 * момент файла и цепочка — как в экспорте (exportPlan.js: ffEffects(c, m.width) до кадрирования, потом crop).
 * m — сведения о файле клипа (store.media), width — ширина кадра на выходе. null — у клипа нет картинки
 * или t вне клипа.
 */
export function compareRequest(c, m, t, width) {
  if (!c || !m || !m.path || m.hasVideo === false) return null;
  const still = !!(m.isImage && !m.isAnimation);
  const len = (c.out - c.in) / speedOf(c);
  if (!(t >= c.start - 0.004 && t < c.start + len)) return null;
  const src = still ? 0 : Math.max(c.in, Math.min(c.out - 0.001, srcAt(c, t)));
  const cr = c.crop || {};
  return {
    file: m.path, t: src, start: still ? 0 : Math.max(0, c.in),
    fx: ffEffects(c, m.width).replace(/,$/, ''),
    crop: { l: cr.l || 0, t: cr.t || 0, r: cr.r || 0, b: cr.b || 0 },
    width: Math.round(width), image: still, fps: m.fps || 30,
  };
}

// CSS filter для предпросмотра. shownW — ширина показанного кадра в CSS-пикселях
export function cssEffects(c, shownW, extra = []) {
  const list = [];
  for (const id of clipEffects(c)) {
    try { const s = effectById(id).css(shownW, raw(c, id)); if (s) list.push(s); } catch { /* пропускаем */ }
  }
  return list.concat(extra).join(' ');
}
