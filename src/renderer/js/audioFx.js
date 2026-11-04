// Звуковые эффекты клипа и дорожки: описание, параметры по умолчанию и фильтры FFmpeg.
// В проекте: clip.afx / track.afx = [{ type: 'eq' | 'comp' | 'denoise' | '<плагин>.<id>', on: true, p: { ...параметры } }]
// Модуль без DOM — его используют окно (стойка эффектов, Web Audio в плеере) и сборка экспорта.
// Сами эффекты — в реестре (registry.js): встроенные описаны в core/audioFx.js, остальные приходят из плагинов.
// Неизвестный type (плагин пропал) в проекте остаётся, экспорт и плеер его пропускают.
import { AUDIO_FX, paramValues } from './registry.js';
import './core/audioFx.js';

export { AUDIO_FX };

export const fxDef = (type) => AUDIO_FX.find((x) => x.id === type) || null;

export function newAudioFx(type) {
  const d = fxDef(type);
  if (!d) return null;
  return { type, on: true, p: Object.fromEntries(d.params.map((x) => [x.k, x.def])) };
}

// Значение параметра с проверкой границ (старые/чужие проекты)
export function fxParam(fx, k) {
  const d = fxDef(fx.type);
  const pd = d && d.params.find((x) => x.k === k);
  if (!pd) return 0;
  return paramValues([pd], fx.p)[k];
}

export const activeFx = (list) => (Array.isArray(list) ? list.filter((x) => x && x.on !== false && fxDef(x.type)) : []);
/** Включённые эффекты списка, которых нет в реестре (данные пропавших плагинов) */
export const unknownFx = (list) => (Array.isArray(list) ? list.filter((x) => x && x.on !== false && typeof x.type === 'string' && !fxDef(x.type)).map((x) => x.type) : []);

// Цепочка фильтров FFmpeg: '' или ',фильтр1,фильтр2'
export function ffAudioFx(list) {
  const out = [];
  for (const fx of activeFx(list)) {
    try { out.push(...fxDef(fx.type).ff(fx.p)); } catch (e) { console.warn(`audio effect ${fx.type}:`, e.message); }
  }
  return out.length ? `,${out.join(',')}` : '';
}

// Узлы Web Audio для плеера (по полю webaudio описаний): [{ node: 'biquad', type, frequency, gain, Q } |
// { node: 'compressor', threshold, ratio, knee, attack, release } | { node: 'gain', gain }] — числа, без DOM
export function webAudioChain(list) {
  const out = [];
  for (const fx of activeFx(list)) {
    try { out.push(...fxDef(fx.type).webaudio(fx.p)); } catch (e) { console.warn(`audio effect ${fx.type}:`, e.message); }
  }
  return out;
}

// Подпись для списка: «Эквалайзер, Компрессор»
export const fxSummary = (list) => activeFx(list).map((x) => fxDef(x.type).name).join(', ');
