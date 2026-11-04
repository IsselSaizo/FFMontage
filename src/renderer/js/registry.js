// Реестр видеоэффектов, переходов, аудиоэффектов и пресетов экспорта.
// Встроенные (js/core/*.js, «плагин» core) и плагины описывают их одинаково — декларативно (см. .agent/plugins-contract.md, раздел 7),
// а реестр превращает описание в объект прежней формы и кладёт его в живые массивы EFFECTS / TRANSITIONS / AUDIO_FX,
// которые дальше экспортируют effects.js, transitions.js и audioFx.js (тот же объект массива — остальной код не меняется):
//   эффект      { id, name, plugin, params, ff(w, values) → 'фильтр=…,фильтр', css(w, values) → 'CSS filter' }
//   переход     { id, name, plugin, xfadeArg: 'transition=…', style(p) → { a?, b?, top?, overlay? } }
//   аудиоэффект { id, name, hint, plugin, params, previewOnlyExport, ff(values) → ['фильтр=…'], webaudio(values) → [{ node, … }] }
//   пресет      { id, name, plugin, width, height, fps, codec?, quality? }
// Всё, что попадает в граф FFmpeg, проверяется здесь (и ещё раз в Rust при экспорте): фильтры только из SAFE_FILTERS
// и объявленные плагином, ключи без файлов, значения без символов, ломающих граф.
// Модуль без DOM — грузится и в Node (тесты экспорта).
import { t, getLang } from './i18n.js';
import { SAFE_FILTERS, FORBIDDEN_OPTION } from './core/safeFilters.js';
import { compileExpr, compileTemplate } from './expr.js';

export const API_VERSION = 1;
/** Владелец встроенных описаний; filters: null — любой фильтр из SAFE_FILTERS */
export const CORE = Object.freeze({ id: 'core', filters: null });

// Живые массивы (порядок: сначала встроенные, потом плагины в порядке регистрации)
export const EFFECTS = [];
export const TRANSITIONS = [];
export const AUDIO_FX = [];
export const EXPORT_PRESETS = [];

const LISTS = { effect: EFFECTS, transition: TRANSITIONS, audioEffect: AUDIO_FX, exportPreset: EXPORT_PRESETS };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_RE = /^[a-z0-9_]+$/;
// Встроенные переходы фильтра xfade (FFmpeg 7+)
const XFADE_NAMES = new Set(['fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite', 'radial', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'circleopen', 'circleclose', 'vertopen', 'vertclose', 'horzopen', 'horzclose', 'dissolve', 'pixelize', 'diagtl', 'diagtr', 'diagbl',
  'diagbr', 'hlslice', 'hrslice', 'vuslice', 'vdslice', 'hblur', 'fadegrays', 'wipetl', 'wipetr', 'wipebl', 'wipebr', 'squeezeh',
  'squeezev', 'zoomin', 'fadefast', 'fadeslow', 'hlwind', 'hrwind', 'vuwind', 'vdwind', 'coverleft', 'coverright', 'coverup',
  'coverdown', 'revealleft', 'revealright', 'revealup', 'revealdown']);
// Значение опции фильтра: без символов, которые закрывают опцию/фильтр/граф или открывают кавычки
const BAD_VALUE = /['"\\;[\],:\n\r]/;
// CSS (фильтр эффекта, стили перехода): только простые функции и числа, никаких url()/image()/var() и т.п.
const CSS_CHARS = /^[A-Za-z0-9 .,%()#+\-/]*$/;
const CSS_BAD = /\b(?:url|image|image-set|cross-fade|element|src|attr|var|env|paint|expression)\s*\(/i;
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\))$/;
const STYLE_KEYS = ['opacity', 'transform', 'clipPath', 'mask', 'filter'];
const BIQUAD_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']);
const WEBAUDIO_FIELDS = {
  biquad: ['frequency', 'gain', 'Q', 'detune'],
  compressor: ['threshold', 'ratio', 'knee', 'attack', 'release'],
  gain: ['gain'],
};
const CODECS = new Set(['av1', 'hevc', 'h264']);
const QUALITIES = new Set(['high', 'medium', 'compact']);
const MAX_FILTERS = 16;
const MAX_PARAMS = 16;
const MAX_NODES = 16;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (reason) => { throw new Error(reason); };

// --- владелец ---
function normOwner(owner) {
  if (owner === CORE) return { id: 'core', filters: null, core: true };
  if (!isObj(owner) || typeof owner.id !== 'string' || !PLUGIN_ID_RE.test(owner.id) || owner.id === 'core') {
    fail(t('Неверный владелец описания (id плагина)'));
  }
  const f = owner.filters;
  const list = f instanceof Set ? [...f] : Array.isArray(f) ? f : [];
  return { id: owner.id, filters: new Set(list.filter((x) => typeof x === 'string')), core: false };
}

// --- названия: строка или { ru, en } ---
function localName(n, required = true) {
  let s = n;
  if (isObj(n)) s = n[getLang()] ?? n.ru ?? n.en ?? Object.values(n).find((x) => typeof x === 'string');
  if (s === undefined || s === null || s === '') { if (required) fail(t('нет названия')); return ''; }
  if (typeof s !== 'string' || /[\u0000-\u001f\u007f]/.test(s)) fail(t('неверное название'));
  s = s.trim();
  if (!s && required) fail(t('нет названия'));
  return s.slice(0, 120);
}

// --- параметры: [{ k, name, min, max, step, def, unit? }] ---
const RESERVED_PARAMS = new Set(['w', 'p']);
function compileParams(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_PARAMS) fail(t('неверный список параметров'));
  const seen = new Set();
  return list.map((x) => {
    if (!isObj(x) || typeof x.k !== 'string' || !KEY_RE.test(x.k) || x.k.length > 40 || RESERVED_PARAMS.has(x.k) || seen.has(x.k)) {
      fail(t('неверный параметр «{k}»', { k: isObj(x) ? String(x.k) : '?' }));
    }
    seen.add(x.k);
    const [min, max, step, def] = [x.min, x.max, x.step ?? 1, x.def ?? x.min].map(Number);
    if (![min, max, step, def].every(Number.isFinite) || !(min < max) || !(step > 0) || def < min || def > max) {
      fail(t('неверный параметр «{k}»', { k: x.k }));
    }
    const pd = { k: x.k, name: localName(x.name ?? x.k), min, max, step, def };
    if (x.unit !== undefined) pd.unit = localName(x.unit, false);
    return pd;
  });
}

/** Значения параметров: из сохранённых (с проверкой границ), иначе по умолчанию. Тот же порядок, что и раньше в fxParam */
export function paramValues(params, raw) {
  const v = Object.create(null);
  for (const pd of params || []) {
    const x = raw && typeof raw === 'object' ? Number(raw[pd.k]) : NaN;
    v[pd.k] = Number.isFinite(x) ? Math.min(pd.max, Math.max(pd.min, x)) : pd.def;
  }
  return v;
}

function checkVars(compiled, allowed) {
  for (const v of compiled.vars) if (!allowed.has(v)) fail(t('неизвестная переменная «{name}»', { name: v }));
  return compiled;
}
const expr = (src, allowed) => checkVars(compileExpr(String(src)), allowed);
const tpl = (src, allowed) => checkVars(compileTemplate(src), allowed);

// --- фильтры FFmpeg: [{ filter, args?: { key: шаблон } | [шаблон, …], when?: выражение }] ---
function compileFilters(list, owner, allowed) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_FILTERS) fail(t('нужен список фильтров FFmpeg (от 1 до 16)'));
  return list.map((f) => {
    if (!isObj(f) || typeof f.filter !== 'string' || !FILTER_RE.test(f.filter)) fail(t('неверное имя фильтра'));
    const name = f.filter;
    if (!SAFE_FILTERS.includes(name)) fail(t('фильтр «{f}» запрещён', { f: name }));
    if (!owner.core && !owner.filters.has(name)) fail(t('фильтр «{f}» не объявлен в манифесте (ffmpeg.filters)', { f: name }));
    const out = { name, when: null, named: null, pos: null };
    if (f.when !== undefined && f.when !== null && f.when !== '') out.when = expr(f.when, allowed);
    if (Array.isArray(f.args)) {
      if (f.args.length > 32) fail(t('слишком много параметров у фильтра «{f}»', { f: name }));
      out.pos = f.args.map((a) => tpl(a, allowed));
    } else if (isObj(f.args)) {
      const keys = Object.keys(f.args);
      if (keys.length > 32) fail(t('слишком много параметров у фильтра «{f}»', { f: name }));
      out.named = keys.map((k) => {
        if (!KEY_RE.test(k) || FORBIDDEN_OPTION.test(k)) fail(t('недопустимый параметр фильтра «{k}»', { k }));
        return [k, tpl(f.args[k], allowed)];
      });
    } else if (f.args !== undefined && f.args !== null) fail(t('неверные параметры фильтра «{f}»', { f: name }));
    return out;
  });
}

function checkValue(v, filter) {
  if (!v || v.length > 200 || BAD_VALUE.test(v)) fail(t('недопустимое значение «{v}» у фильтра «{f}»', { v: String(v).slice(0, 60), f: filter }));
  // позиционное значение вида «ключ=…» FFmpeg поймёт как именованное — ключ проверяем так же
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(v);
  if (m && FORBIDDEN_OPTION.test(m[1])) fail(t('недопустимый параметр фильтра «{k}»', { k: m[1] }));
  return v;
}

// Описание фильтров + значения → ['имя=к=в:к=в', …] (фильтры с ложным when пропускаются)
function renderFilters(cf, vars) {
  const out = [];
  for (const f of cf) {
    if (f.when && !f.when.run(vars)) continue;
    const args = f.named
      ? f.named.map(([k, tp]) => `${k}=${checkValue(tp.fill(vars), f.name)}`)
      : (f.pos || []).map((tp) => checkValue(tp.fill(vars), f.name));
    out.push(args.length ? `${f.name}=${args.join(':')}` : f.name);
  }
  return out;
}

function checkCss(s) {
  if (s.length > 1000 || !CSS_CHARS.test(s) || CSS_BAD.test(s)) fail(t('недопустимое значение CSS «{v}»', { v: s.slice(0, 60) }));
  return s;
}

// Проверить описание сразу: подставить значения по умолчанию и крайние
function probeValues(params, extra) {
  const sets = [Object.assign(paramValues(params, null), extra)];
  for (const edge of ['min', 'max']) {
    const v = Object.create(null);
    for (const pd of params) v[pd.k] = pd[edge];
    sets.push(Object.assign(v, extra));
  }
  return sets;
}

// ---------------- эффекты ----------------
function compileEffect(desc, owner, id) {
  const params = compileParams(desc.params);
  const allowed = new Set([...params.map((x) => x.k), 'w']);
  const cf = compileFilters(desc.ffmpeg, owner, allowed);
  const cssT = desc.css === undefined || desc.css === null || desc.css === '' ? null : tpl(desc.css, allowed);
  const vars = (w, raw, defW) => Object.assign(paramValues(params, raw), { w: Number(w) || defW });
  const e = {
    id, name: localName(desc.name), plugin: owner.id, params,
    // w — ширина исходного кадра (по ней blur и т.п. выглядят одинаково при любом размере); values — clip.fxp[id]
    ff: (w, values) => renderFilters(cf, vars(w, values, 1920)).join(','),
    // w — ширина показанного кадра в CSS-пикселях
    css: (w, values) => (cssT ? checkCss(cssT.fill(vars(w, values, 640))) : ''),
  };
  for (const v of probeValues(params, { w: 1920 })) { renderFilters(cf, v); if (cssT) checkCss(cssT.fill(v)); }
  return e;
}

// ---------------- переходы ----------------
function compileStyle(st, allowed) {
  if (st === undefined || st === null) return null;
  if (!isObj(st)) fail(t('неверный стиль предпросмотра'));
  const out = [];
  for (const k of Object.keys(st)) {
    if (!STYLE_KEYS.includes(k)) fail(t('недопустимое значение стиля «{k}»', { k }));
  }
  for (const k of STYLE_KEYS) if (st[k] !== undefined) out.push([k, tpl(st[k], allowed)]);
  return out;
}
function compileTransition(desc, owner, id) {
  const allowed = new Set(['p']);
  let xfadeArg;
  const x = desc.xfade;
  if (typeof x === 'string') {
    if (!XFADE_NAMES.has(x)) fail(t('неверный переход xfade «{x}»', { x: x.slice(0, 40) }));
    xfadeArg = `transition=${x}`;
  } else if (isObj(x) && typeof x.expr === 'string') {
    // Выражение FFmpeg (переменные A, B, X, Y, W, H, P): единственное значение с запятыми — в одинарных кавычках
    const ex = x.expr.trim();
    if (!ex || ex.length > 1000 || !/^[A-Za-z0-9_.,()+\-*/^<>=!&|% ]+$/.test(ex)) fail(t('недопустимое выражение xfade'));
    xfadeArg = `transition=custom:expr='${ex}'`;
  } else fail(t('неверный переход xfade «{x}»', { x: String(x).slice(0, 40) }));

  const pv = isObj(desc.preview) ? desc.preview : { b: { opacity: '{p}' } };
  for (const k of Object.keys(pv)) if (!['a', 'b', 'top', 'overlay'].includes(k)) fail(t('недопустимое значение стиля «{k}»', { k }));
  const A = compileStyle(pv.a, allowed);
  const B = compileStyle(pv.b, allowed);
  if (pv.top !== undefined && pv.top !== 'a' && pv.top !== 'b') fail(t('недопустимое значение стиля «{k}»', { k: 'top' }));
  let ov = null;
  if (pv.overlay !== undefined) {
    if (!isObj(pv.overlay) || typeof pv.overlay.color !== 'string' || !COLOR_RE.test(pv.overlay.color)) fail(t('недопустимое значение стиля «{k}»', { k: 'overlay' }));
    ov = { color: pv.overlay.color, opacity: tpl(pv.overlay.opacity ?? 1, allowed) };
  }
  const layer = (list, vars) => {
    const o = {};
    for (const [k, tp] of list) o[k] = k === 'opacity' ? tp.num(vars) : checkCss(tp.fill(vars));
    return o;
  };
  const style = (p) => {
    const vars = { p };
    const r = {};
    if (pv.top) r.top = pv.top;
    if (A) r.a = layer(A, vars);
    if (B) r.b = layer(B, vars);
    if (ov) r.overlay = { color: ov.color, opacity: ov.opacity.num(vars) };
    return r;
  };
  for (const p of [0, 0.37, 1]) style(p);
  return {
    id, name: localName(desc.name), plugin: owner.id, xfadeArg,
    // Ошибка в выражении плагина не должна ломать плеер — тогда простое растворение
    style: (p) => { try { return style(p); } catch { return { b: { opacity: p } }; } },
  };
}

// ---------------- аудиоэффекты ----------------
function compileWebAudio(list, allowed) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_NODES) fail(t('неверный узел Web Audio «{n}»', { n: '?' }));
  return list.map((nd) => {
    if (!isObj(nd) || !hasOwn(WEBAUDIO_FIELDS, nd.node)) fail(t('неверный узел Web Audio «{n}»', { n: isObj(nd) ? String(nd.node) : '?' }));
    const fields = WEBAUDIO_FIELDS[nd.node];
    const out = { node: nd.node, type: null, when: null, fields: [] };
    for (const k of Object.keys(nd)) {
      if (k === 'node') continue;
      if (k === 'when') { out.when = expr(nd.when, allowed); continue; }
      if (k === 'type' && nd.node === 'biquad') {
        if (!BIQUAD_TYPES.has(nd.type)) fail(t('неверный узел Web Audio «{n}»', { n: String(nd.type) }));
        out.type = nd.type; continue;
      }
      if (!fields.includes(k)) fail(t('неверный узел Web Audio «{n}»', { n: `${nd.node}.${k}` }));
      out.fields.push([k, tpl(nd[k], allowed)]);
    }
    if (nd.node === 'biquad' && !out.type) out.type = 'peaking';
    return out;
  });
}
function renderWebAudio(nodes, vars) {
  const out = [];
  for (const nd of nodes) {
    if (nd.when && !nd.when.run(vars)) continue;
    const o = { node: nd.node };
    if (nd.type) o.type = nd.type;
    for (const [k, tp] of nd.fields) o[k] = tp.num(vars);
    out.push(o);
  }
  return out;
}
function compileAudioEffect(desc, owner, id) {
  const params = compileParams(desc.params);
  const allowed = new Set(params.map((x) => x.k));
  const cf = compileFilters(desc.ffmpeg, owner, allowed);
  const wa = compileWebAudio(desc.webaudio, allowed);
  for (const v of probeValues(params, {})) { renderFilters(cf, v); renderWebAudio(wa, v); }
  const a = {
    id, name: localName(desc.name), plugin: owner.id, params,
    // values — fx.p (проверка границ внутри)
    ff: (values) => renderFilters(cf, paramValues(params, values)),
    webaudio: (values) => renderWebAudio(wa, paramValues(params, values)),
  };
  const hint = localName(desc.hint, false);
  if (hint) a.hint = hint;
  if (desc.previewOnlyExport) a.previewOnlyExport = true;
  return a;
}

// ---------------- пресеты экспорта ----------------
function compileExportPreset(desc, owner, id) {
  const width = Number(desc.width); const height = Number(desc.height); const fps = Number(desc.fps);
  const okSize = (x) => Number.isInteger(x) && x >= 16 && x <= 8192 && x % 2 === 0;
  if (!okSize(width) || !okSize(height) || !(fps >= 1 && fps <= 240)) fail(t('неверные размеры или частота кадров'));
  const p = { id, name: localName(desc.name), plugin: owner.id, width, height, fps };
  if (desc.codec !== undefined) { if (!CODECS.has(desc.codec)) fail(t('неверный кодек или качество')); p.codec = desc.codec; }
  if (desc.quality !== undefined) { if (!QUALITIES.has(desc.quality)) fail(t('неверный кодек или качество')); p.quality = desc.quality; }
  return p;
}

// ---------------- регистрация ----------------
const listeners = new Set();
function emit(ev) {
  for (const fn of [...listeners]) { try { fn(ev); } catch (e) { console.error('registry listener', e); } }
}
/** Подписка на изменения реестра: fn({ kind, id, plugin, action: 'register' | 'unregister' }) → отписка */
export function onRegistryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LABEL = {
  effect: (id, reason) => t('Эффект «{id}»: {reason}', { id, reason }),
  transition: (id, reason) => t('Переход «{id}»: {reason}', { id, reason }),
  audioEffect: (id, reason) => t('Аудиоэффект «{id}»: {reason}', { id, reason }),
  exportPreset: (id, reason) => t('Пресет экспорта «{id}»: {reason}', { id, reason }),
};
const COMPILE = { effect: compileEffect, transition: compileTransition, audioEffect: compileAudioEffect, exportPreset: compileExportPreset };

function register(kind, desc, owner) {
  const o = normOwner(owner);
  const rawId = isObj(desc) && typeof desc.id === 'string' ? desc.id : '';
  try {
    if (!isObj(desc)) fail(t('описание должно быть объектом'));
    if (!ID_RE.test(rawId)) fail(t('нет id или неверный id (латиница, цифры, «-», «_»)'));
    const id = o.core ? rawId : `${o.id}.${rawId}`;
    const list = LISTS[kind];
    const at = list.findIndex((x) => x.id === id);
    if (at >= 0 && list[at].plugin !== o.id) fail(t('id уже занят другим плагином'));
    const item = COMPILE[kind](desc, o, id);
    if (at >= 0) list[at] = item; else list.push(item);
    emit({ kind, id, plugin: o.id, action: 'register' });
    return id;
  } catch (e) {
    const err = new Error(LABEL[kind](o.core ? rawId || '?' : `${o.id}.${rawId || '?'}`, e.message));
    err.kind = kind; err.pluginId = o.id; err.descId = rawId;
    throw err;
  }
}

/** Видеоэффект → полный id ('bw' у core, '<pluginId>.<id>' у плагина). Ошибка — throw Error (message — для человека) */
export const registerEffect = (desc, owner = CORE) => register('effect', desc, owner);
/** Переход → полный id */
export const registerTransition = (desc, owner = CORE) => register('transition', desc, owner);
/** Аудиоэффект → полный id */
export const registerAudioEffect = (desc, owner = CORE) => register('audioEffect', desc, owner);
/** Пресет экспорта → полный id */
export const registerExportPreset = (desc, owner = CORE) => register('exportPreset', desc, owner);

/** Убрать всё, что регистрировал плагин; возвращает, сколько описаний убрано. Встроенные (core) не убираются */
export function unregisterPlugin(pluginId) {
  if (!pluginId || pluginId === 'core') return 0;
  let n = 0;
  for (const [kind, list] of Object.entries(LISTS)) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].plugin !== pluginId) continue;
      const [x] = list.splice(i, 1);
      n++;
      emit({ kind, id: x.id, plugin: pluginId, action: 'unregister' });
    }
  }
  return n;
}

export const listEffects = () => [...EFFECTS];
export const listTransitions = () => [...TRANSITIONS];
export const listAudioEffects = () => [...AUDIO_FX];
export const listExportPresets = () => [...EXPORT_PRESETS];

/**
 * Какие id эффектов / переходов / аудиоэффектов проекта не зарегистрированы (пропал плагин).
 * Смотрит основную дорожку, наложения, аудиодорожки и все эпизоды. Данные проекта не меняет.
 */
export function missingIds(project) {
  const known = (list) => new Set(list.map((x) => x.id));
  const fx = known(EFFECTS); const tr = known(TRANSITIONS); const afx = known(AUDIO_FX);
  const out = { effects: new Set(), transitions: new Set(), audioEffects: new Set() };
  const audio = (list) => { if (Array.isArray(list)) for (const x of list) if (x && typeof x.type === 'string' && !afx.has(x.type)) out.audioEffects.add(x.type); };
  const video = (clips) => {
    for (const c of Array.isArray(clips) ? clips : []) {
      if (!c) continue;
      if (Array.isArray(c.effects)) for (const id of c.effects) if (typeof id === 'string' && !fx.has(id)) out.effects.add(id);
      if (c.transition && typeof c.transition.type === 'string' && !tr.has(c.transition.type)) out.transitions.add(c.transition.type);
      audio(c.afx);
    }
  };
  const tracks = (list) => {
    for (const tk of Array.isArray(list) ? list : []) {
      if (!tk) continue;
      audio(tk.afx);
      for (const c of Array.isArray(tk.clips) ? tk.clips : []) if (c) audio(c.afx);
    }
  };
  const scan = (p) => { if (!p) return; video(p.videoClips); video(p.overlayClips); tracks(p.audioTracks); };
  scan(project);
  if (project && Array.isArray(project.episodes)) project.episodes.forEach(scan);
  return { effects: [...out.effects], transitions: [...out.transitions], audioEffects: [...out.audioEffects] };
}
