// Звуковые эффекты клипа и дорожки: описание, параметры по умолчанию и фильтры FFmpeg.
// В проекте: clip.afx / track.afx = [{ type: 'eq' | 'comp' | 'denoise' | '<плагин>.<id>', on: true, p: { ...параметры } }]
// Модуль без DOM — его используют окно (стойка эффектов, Web Audio в плеере) и сборка экспорта.
// Сами эффекты — в реестре (registry.js): встроенные описаны в core/audioFx.js, остальные приходят из плагинов.
// Неизвестный type (плагин пропал) в проекте остаётся, экспорт и плеер его пропускают.
//
// Аудиоплагины VST3 / CLAP (контракт .agent/vst3-contract.md) — не в реестре, их понимает этот модуль:
//   { type: 'vst3' | 'clap', on, p: {}, vst: { uid, name, vendor, state, ctrl, params: { '<id>': 0..1 } } }
// Цепочка, где есть включённый найденный плагин, целиком обрабатывается офлайн-рендером (vst_render):
// splitStages() режет её на стадии — подряд идущие встроенные эффекты → { af }, плагин → { vst }.
// ffAudioFx / webAudioChain такие записи пропускают.
import { AUDIO_FX, paramValues } from './registry.js';
import './core/audioFx.js';

export { AUDIO_FX };

/** Типы записей стойки — аудиоплагины (обслуживает хост ff-montage --vst-host) */
export const NATIVE_FX = ['vst3', 'clap'];
const NATIVE_DEF = Object.freeze({
  vst3: Object.freeze({ id: 'vst3', name: 'VST3', params: Object.freeze([]), native: true }),
  clap: Object.freeze({ id: 'clap', name: 'CLAP', params: Object.freeze([]), native: true }),
});
export const isNativeFx = (type) => type === 'vst3' || type === 'clap';
/** Запись стойки — аудиоплагин VST3 / CLAP */
export const isVst = (fx) => !!fx && isNativeFx(fx.type);

export const fxDef = (type) => (isNativeFx(type) ? NATIVE_DEF[type] : AUDIO_FX.find((x) => x.id === type) || null);

export function newAudioFx(type) {
  const d = fxDef(type);
  if (!d) return null;
  if (d.native) return null; // плагину нужны uid и состояние — newPluginFx()
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
/** Включённые встроенные эффекты и эффекты плагинов программы (без VST3 / CLAP) */
const builtinFx = (list) => activeFx(list).filter((x) => !isVst(x));
/** Включённые эффекты списка, которых нет в реестре (данные пропавших плагинов) */
export const unknownFx = (list) => (Array.isArray(list) ? list.filter((x) => x && x.on !== false && typeof x.type === 'string' && !fxDef(x.type)).map((x) => x.type) : []);

// Цепочка фильтров FFmpeg: '' или ',фильтр1,фильтр2'
export function ffAudioFx(list) {
  const out = [];
  for (const fx of builtinFx(list)) {
    try { out.push(...fxDef(fx.type).ff(fx.p)); } catch (e) { console.warn(`audio effect ${fx.type}:`, e.message); }
  }
  return out.length ? `,${out.join(',')}` : '';
}

// Узлы Web Audio для плеера (по полю webaudio описаний): [{ node: 'biquad', type, frequency, gain, Q } |
// { node: 'compressor', threshold, ratio, knee, attack, release } | { node: 'gain', gain }] — числа, без DOM
export function webAudioChain(list) {
  const out = [];
  for (const fx of builtinFx(list)) {
    try { out.push(...fxDef(fx.type).webaudio(fx.p)); } catch (e) { console.warn(`audio effect ${fx.type}:`, e.message); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// VST3 / CLAP
// ---------------------------------------------------------------------------
// uid: VST3 — 32 hex (class id, сравнение без учёта регистра), CLAP — 'clap:<id плагина>' (как есть)
export const normUid = (u) => {
  const s = String(u || '').trim();
  return /^clap:/i.test(s) ? `clap:${s.slice(5)}` : s.replace(/[^0-9a-f]/gi, '').toUpperCase();
};
let knownUids = null; // Set нормализованных uid из vst_list; null — список ещё не загружен (считаем все найденными)
/** Список найденных плагинов (vst_list().plugins) — для проверки «плагин есть» */
export function setVstPlugins(list) {
  knownUids = Array.isArray(list) ? new Set(list.filter((p) => p && p.uid).map((p) => normUid(p.uid))) : null;
}
export const vstPluginsKnown = () => knownUids !== null;
export const vstName = (fx) => String((fx && fx.vst && fx.vst.name) || (fx && fxDef(fx.type) ? fxDef(fx.type).name : 'VST3'));
const uidOk = (fx) => {
  const u = fx && fx.vst ? normUid(fx.vst.uid) : '';
  return /^clap:./.test(u) || /^[0-9A-F]{32}$/.test(u);
};
/** Плагин записи найден на компьютере (или список ещё не загружен) */
export const vstKnown = (fx) => isVst(fx) && uidOk(fx) && (!knownUids || knownUids.has(normUid(fx.vst.uid)));
/** Включённые записи VST3 / CLAP списка (найденные и нет) */
export const vstEntries = (list) => activeFx(list).filter(isVst);
/** Имена включённых плагинов, которых нет на компьютере */
export const missingVst = (list) => vstEntries(list).filter((x) => !vstKnown(x)).map(vstName);
/** В цепочке есть включённый найденный плагин — её звук идёт через офлайн-рендер */
export const hasVst = (list) => vstEntries(list).some(vstKnown);
/** В цепочке есть включённый эффект без Web Audio (previewOnlyExport — шумоподавление) */
export const hasOfflineFx = (list) => builtinFx(list).some((x) => fxDef(x.type).previewOnlyExport);
/**
 * Плееру нужен офлайн-рендер цепочки (vst_render): плагин VST3/CLAP или эффект без Web Audio (0.5.0 —
 * шумоподавление теперь слышно в плеере после короткой обработки; рендер без плагинов работает на любой ОС)
 */
export const needsRender = (list) => hasVst(list) || hasOfflineFx(list);

/** params: { id: 0..1 } — только числа в границах, ключи по порядку (ключ рендера не зависит от порядка правок) */
export function cleanVstParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const k of Object.keys(params).sort()) {
    const v = Number(params[k]);
    if (Number.isFinite(v)) out[k] = Math.round(Math.max(0, Math.min(1, v)) * 1e6) / 1e6;
  }
  return out;
}

/**
 * Стадии vst_render: [{ af: 'фильтр,фильтр' } | { vst: { uid, state, ctrl, params } }].
 * Подряд идущие встроенные эффекты — одна стадия af; выключенные записи пропускаются;
 * ненайденный плагин — пропуск и warn(имя).
 */
export function splitStages(list, warn = null) {
  const stages = [];
  let af = [];
  const flush = () => { if (af.length) { stages.push({ af: af.join(',') }); af = []; } };
  for (const fx of activeFx(list)) {
    if (isVst(fx)) {
      if (!vstKnown(fx)) { if (warn) warn(vstName(fx)); continue; }
      flush();
      stages.push({ vst: { uid: String(fx.vst.uid), state: String(fx.vst.state || ''), ctrl: String(fx.vst.ctrl || ''), params: cleanVstParams(fx.vst.params) } });
      continue;
    }
    try { af.push(...fxDef(fx.type).ff(fx.p)); } catch (e) { console.warn(`audio effect ${fx.type}:`, e.message); }
  }
  flush();
  return stages;
}

/** Новая запись стойки для плагина (Plugin из vst_list) и его состояния по умолчанию (vst_info) */
export function newPluginFx(plugin, info = {}) {
  const type = plugin.format === 'clap' || /^clap:/i.test(String(plugin.uid)) ? 'clap' : 'vst3';
  return {
    type, on: true, p: {},
    vst: {
      uid: String(plugin.uid), name: String(plugin.name || ''), vendor: String(plugin.vendor || ''),
      state: String(info.state || ''), ctrl: type === 'clap' ? '' : String(info.ctrl || ''), params: {},
    },
  };
}

// Подпись для списка: «Эквалайзер, Компрессор, Scyllascope»
export const fxSummary = (list) => activeFx(list).map((x) => (isVst(x) ? vstName(x) : fxDef(x.type).name)).join(', ');
