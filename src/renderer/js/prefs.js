// Настройки окна (M0.6): один объект из settings.json (Rust — settings.rs, команды settings_get / settings_set).
// Загружается один раз при запуске (settings.js initSettings → loadPrefs), дальше читается синхронно:
//   getPref('ui.rightTab', 'props')  — путь через точку внутри объекта настроек;
//   setPref('ui.rightTab', 'text')   — сразу в памяти, в файл — с задержкой (несколько изменений — одна запись);
//   setPrefs({ keymap })             — сразу в файл (Promise со всеми настройками).
// Ключи: lang, keymap, restoreSession, plugins, cache{limitGb}, export{…},
//        ui{rightTab, tlHeight, mode, magnet, monitorVol, monitorMute, speedRipple}.
// Старые значения из localStorage (ffm.*) переносятся при первом запуске (settings_migrate_local) и удаляются.
// sessionStorage (ffm.reloadState, ffm.lang, ffm.setupCfg) — не настройки, а состояние перезагрузки окна: остаётся там.
import { invoke } from './tauri.js';

let data = {};
const pending = new Set(); // ключи верхнего уровня, ждущие записи
let timer = null;
let flushing = null;
const DELAY = 400;

// localStorage → путь в настройках
const LOCAL = [
  ['ffm.rightTab', 'ui.rightTab', (v) => v],
  ['ffm.tlHeight', 'ui.tlHeight', (v) => Number(v) || undefined],
  ['ffm.mode', 'ui.mode', (v) => v],
  ['ffm.magnet', 'ui.magnet', (v) => v !== '0'],
  ['ffm.monitorVol', 'ui.monitorVol', (v) => (v !== '' && isFinite(Number(v)) ? Number(v) : undefined)],
  ['ffm.monitorMute', 'ui.monitorMute', (v) => v === '1'],
  ['ffm.speedRipple', 'ui.speedRipple', (v) => v === '1'],
  ['ffm.export', 'export', (v) => { const o = JSON.parse(v); return o && typeof o === 'object' ? o : undefined; }],
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const split = (path) => String(path).split('.').filter(Boolean);

function getPath(obj, path) {
  let cur = obj;
  for (const k of split(path)) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// Новый объект с изменённым полем (вложенные объекты копируются, исходный не меняется)
function withPath(obj, keys, value) {
  const out = isObj(obj) ? { ...obj } : {};
  const [k, ...rest] = keys;
  if (!rest.length) {
    if (value === undefined || value === null) delete out[k]; else out[k] = value;
  } else {
    out[k] = withPath(out[k], rest, value);
  }
  return out;
}

/** Загрузить настройки (один раз при запуске окна) и перенести старый localStorage */
export async function loadPrefs() {
  try { data = (await invoke('settings_get')).settings || {}; } catch (e) { console.warn('prefs', e); data = {}; }
  await migrateLocal();
  return data;
}

async function migrateLocal() {
  let ls = null;
  try { ls = window.localStorage; } catch { return; }
  if (!ls) return;
  let values = {};
  const found = [];
  for (const [key, path, conv] of LOCAL) {
    const raw = ls.getItem(key);
    if (raw === null) continue;
    found.push(key);
    let v;
    try { v = conv(raw); } catch { v = undefined; }
    if (v !== undefined) values = withPath(values, split(path), v);
  }
  if (!found.length) return;
  try {
    data = (await invoke('settings_migrate_local', { values })) || data;
    for (const key of found) ls.removeItem(key);
  } catch (e) { console.warn('prefs migrate', e); }
}

/** Значение настройки (синхронно) */
export function getPref(path, def) {
  const v = getPath(data, path);
  return v === undefined ? def : v;
}

/** Все настройки (копия верхнего уровня) */
export const allPrefs = () => ({ ...data });

/** Изменить настройку: null/undefined — удалить. Запись в файл — через DELAY мс после последнего изменения. */
export function setPref(path, value) {
  const keys = split(path);
  if (!keys.length || keys[0].startsWith('_')) return;
  data = withPath(data, keys, value);
  pending.add(keys[0]);
  clearTimeout(timer);
  timer = setTimeout(() => { flushPrefs().catch((e) => console.warn('prefs save', e)); }, DELAY);
}

/** Записать отложенные изменения сейчас */
export async function flushPrefs() {
  clearTimeout(timer);
  timer = null;
  if (flushing) await flushing.catch(() => {});
  if (!pending.size) return data;
  const patch = {};
  for (const k of pending) patch[k] = k in data ? data[k] : null;
  pending.clear();
  flushing = invoke('settings_set', { patch });
  try {
    const all = await flushing;
    // То, что поменяли, пока шла запись, — поверх ответа (оно уйдёт следующей записью)
    const local = data;
    data = { ...(all || {}) };
    for (const k of pending) { if (k in local) data[k] = local[k]; else delete data[k]; }
    return data;
  } catch (e) {
    for (const k of Object.keys(patch)) pending.add(k);
    throw e;
  } finally { flushing = null; }
}

/** Изменить ключи верхнего уровня сразу (null — удалить); Promise со всеми настройками */
export async function setPrefs(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (k.startsWith('_')) continue;
    data = withPath(data, [k], v);
    pending.add(k);
  }
  return flushPrefs();
}

// Окно закрывается или перезагружается — не потерять отложенную запись
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (pending.size) flushPrefs().catch(() => {}); });
}
