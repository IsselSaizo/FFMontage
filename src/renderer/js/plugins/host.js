// Хост плагинов (M3.2–M3.7): список из Rust (plugins_list), включение/выключение (settings.plugins.disabled),
// регистрация contributes.* из манифеста, песочные iframe (логика — скрытый, панели — вкладки справа),
// связь через MessagePort, проверка прав и API v1 для js/plugins/sdk.js.
// Ошибка одного плагина не должна ломать окно: всё обёрнуто в try/catch, журнал — console.warn → renderer.log.
//
// Протокол (окно ↔ SDK во фрейме):
//   после load фрейма: frame.postMessage({ type: 'ffm-init', pluginId, apiVersion: 1, lang, kind, panelId, permissions }, '*', [port2])
//   SDK → окно: { t: 'req', id, method, args } | { t: 'ready' }
//   окно → SDK: { t: 'res', id, ok: true, result } | { t: 'res', id, ok: false, error } | { t: 'event', name, data }
//   события: 'project' (снимок проекта, не чаще ~10 раз/с, только подписанным), 'action' ({ id } — id без префикса плагина)
import * as registry from '../registry.js';
import { store } from '../store.js';
import { t, getLang } from '../i18n.js';
import { h, toast, errText } from '../util.js';
import {
  ACTIONS, actionById, keysOf, runAction, registerAction, unregisterActions, registerPreset, unregisterPresets,
} from '../keymap.js';
import { getSetting, setSettings } from '../settings.js';
import { permissionSet, need, checkNetUrl, describePermissions } from './permissions.js';

export { describePermissions };

const api = window.api;
export const API_VERSION = 1;
const READY_WAIT = 3000;        // сколько ждём ffm.ready() от логики плагинов при запуске
const MAX_INFLIGHT = 64;        // одновременных запросов от одного фрейма
const PROJECT_EVERY = 100;      // мс между рассылками изменений проекта

// Инструменты MCP (mcpBridge.js callTool), доступные плагинам, и нужное право.
// Всё остальное запрещено: работа с файлами и экспортом (import_media, open_project, save_project, new_project,
// export_video, export_status, cancel_export, get_frame, detect_silence) и любые будущие инструменты.
const TOOL_PERMS = {
  get_project: 'project:read',
  add_clip: 'project:write',
  update_clip: 'project:write',
  split_clip: 'project:write',
  delete_clip: 'project:write',
  reverse_clip: 'project:write',
  freeze_frame: 'project:write',
  set_transition: 'project:write',
  close_gaps: 'project:write',
  // M4: видеодорожки и трансформ (шаблоны PiP/сеток — examples/plugins/layouts)
  add_video_track: 'project:write',
  update_video_track: 'project:write',
  set_transform: 'project:write',
  undo: 'project:write',
  redo: 'project:write',
  set_playhead: 'project:write',
};
export const BLOCKED_TOOLS = ['import_media', 'open_project', 'save_project', 'new_project', 'export_video', 'export_status', 'cancel_export', 'get_frame', 'detect_silence'];

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SUB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
const S = {
  info: null,                 // ответ plugins_list (без plugins)
  recs: new Map(),            // id → запись плагина
  ui: null,                   // { addTab, removeTab, show } из browser.js
  loaded: false,
  listError: '',
};
const changeListeners = new Set();
export const onPluginsChange = (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); };
const changed = () => { for (const fn of changeListeners) { try { fn(); } catch (e) { console.warn('plugins listener', e); } } };

const warn = (rec, ...a) => console.warn(`plugin ${rec && rec.id ? rec.id : '?'}:`, ...a);

/** Строка или { ru, en } → строка на языке интерфейса */
export function localized(v, fallback = '') {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const l = getLang();
    for (const k of [l, 'ru', 'en']) if (typeof v[k] === 'string' && v[k]) return v[k];
    const any = Object.values(v).find((x) => typeof x === 'string' && x);
    if (any) return any;
  }
  return fallback;
}
export const pluginName = (rec) => localized(rec && rec.manifest && rec.manifest.name, rec ? rec.id : '');

const disabledList = () => {
  const p = getSetting('plugins', null);
  return p && Array.isArray(p.disabled) ? p.disabled.filter((x) => typeof x === 'string') : [];
};
export const isEnabled = (id) => !disabledList().includes(id);

function baseUrl() {
  const b = (S.info && S.info.baseUrl) || 'http://plugin.localhost/';
  return b.endsWith('/') ? b : `${b}/`;
}
// Путь внутри папки плагина → URL протокола plugin:// (Rust ещё раз проверяет путь)
function pluginUrl(id, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '')) throw new Error(`bad path: ${rel}`);
  return `${baseUrl()}${encodeURIComponent(id)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

function newRec(p) {
  const manifest = p.manifest && typeof p.manifest === 'object' ? p.manifest : null;
  const filters = manifest && manifest.ffmpeg && Array.isArray(manifest.ffmpeg.filters) ? manifest.ffmpeg.filters.filter((x) => typeof x === 'string') : [];
  return {
    id: p.id,
    dir: p.dir || '',
    manifest,
    error: p.error ? String(p.error) : (manifest ? '' : t('Нет манифеста plugin.json')),
    builtin: !!p.builtin,
    perms: permissionSet(manifest),
    owner: { id: p.id, filters: new Set(filters) },
    active: false,
    problems: [],              // ошибки регистрации и запуска (для настроек)
    frames: new Set(),
    tabs: [],                  // id вкладок справа
    noticeTimes: [],           // для ограничения частоты уведомлений
  };
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
/** browser — результат initBrowser() (addTab/removeTab для панелей плагинов) */
export function initPluginHost({ browser } = {}) {
  S.ui = browser || null;
  store.on('project', scheduleProject);
}

/** Загрузить список и включить плагины. Ждёт готовности логики не дольше ~3 с. */
export async function loadPlugins() {
  await refreshList();
  const ready = [];
  for (const rec of S.recs.values()) {
    if (rec.builtin || rec.error || !isEnabled(rec.id)) continue;
    const r = activate(rec);
    if (r) ready.push(r);
  }
  S.loaded = true;
  changed();
  if (ready.length) await Promise.race([Promise.allSettled(ready), new Promise((r) => setTimeout(r, READY_WAIT))]);
}

/** Перечитать список с диска (после установки/удаления); новые включённые плагины запускаются */
export async function refreshList() {
  let list;
  try {
    list = await api.pluginsList();
    S.listError = '';
  } catch (e) {
    console.warn('plugins_list', e);
    S.listError = errText(e);
    list = { plugins: [] };
  }
  const { plugins, ...info } = list || {};
  S.info = info;
  const seen = new Set(['core']);
  // Встроенный core — только для показа в списке (регистрирует себя сам, js/core/*.js)
  if (!S.recs.has('core')) {
    let core = (plugins || []).find((p) => p && p.id === 'core');
    if (!core) {
      try {
        const r = await fetch('plugins/core/plugin.json');
        if (r.ok) core = { id: 'core', manifest: await r.json() };
      } catch (e) { console.warn('core plugin.json', e); }
    }
    if (core) {
      const rec = newRec({ ...core, error: '', builtin: true });
      rec.active = true;
      S.recs.set('core', rec);
    }
  }
  for (const p of plugins || []) {
    if (!p || typeof p.id !== 'string' || p.id === 'core') continue;
    seen.add(p.id);
    const old = S.recs.get(p.id);
    const sig = JSON.stringify([p.manifest || null, p.error || '']);
    if (old && old.sig === sig) { old.dir = p.dir || old.dir; continue; }
    if (old) deactivate(p.id, { silent: true });
    const rec = newRec(p);
    rec.sig = sig;
    if (!ID_RE.test(rec.id)) rec.error = rec.error || t('Недопустимый id плагина');
    S.recs.set(p.id, rec);
    if (S.loaded && !rec.error && isEnabled(rec.id)) activate(rec);
  }
  for (const id of [...S.recs.keys()]) {
    if (!seen.has(id)) { deactivate(id, { silent: true }); S.recs.delete(id); }
  }
  changed();
}

/** Для раздела настроек: записи в порядке «core, остальные по имени» */
export function pluginList() {
  const all = [...S.recs.values()];
  all.sort((a, b) => (a.builtin ? -1 : b.builtin ? 1 : pluginName(a).localeCompare(pluginName(b))));
  return all.map((r) => ({
    id: r.id, dir: r.dir, manifest: r.manifest, error: r.error, builtin: r.builtin, active: r.active,
    enabled: r.builtin || isEnabled(r.id), problems: r.problems.slice(), name: pluginName(r),
    description: localized(r.manifest && r.manifest.description, ''),
    permissions: describePermissions(r.manifest || {}),
  }));
}
export const pluginsDir = () => (S.info && S.info.dir) || '';
export const listError = () => S.listError;

// ---------------------------------------------------------------------------
// Включение / выключение
// ---------------------------------------------------------------------------
function activate(rec) {
  if (rec.active || rec.builtin || rec.error) return null;
  rec.active = true;
  rec.problems = [];
  const m = rec.manifest;
  const c = (m && m.contributes) || {};
  const problem = (what, e) => { const msg = `${what}: ${errText(e)}`; rec.problems.push(msg); warn(rec, msg); };
  const list = (x) => (Array.isArray(x) ? x : []);
  // Сначала всё декларативное — эффект может работать без единой строки JS
  const reg = (fn, arr, what) => {
    for (const d of list(arr)) {
      try {
        if (typeof registry[fn] !== 'function') throw new Error(`registry.${fn} is not available`);
        registry[fn](d, rec.owner);
      } catch (e) { problem(`${what} ${d && d.id}`, e); }
    }
  };
  reg('registerEffect', c.effects, 'effect');
  reg('registerTransition', c.transitions, 'transition');
  reg('registerAudioEffect', c.audioEffects, 'audioEffect');
  reg('registerExportPreset', c.exportPresets, 'exportPreset');
  for (const a of list(c.actions)) {
    try { addAction(rec, a, null); } catch (e) { problem(`action ${a && a.id}`, e); }
  }
  for (const k of list(c.keymaps)) {
    try { addKeymap(rec, k); } catch (e) { problem(`keymap ${k && k.id}`, e); }
  }
  let ready = null;
  if (m && typeof m.entry === 'string' && m.entry) {
    try {
      const fr = createFrame(rec, { kind: 'main', src: pluginUrl(rec.id, '__main.html'), parent: framesBox() });
      ready = fr.readyP;
    } catch (e) { problem('entry', e); }
  }
  for (const p of list(c.panels)) {
    try { addPanel(rec, p); } catch (e) { problem(`panel ${p && p.id}`, e); }
  }
  changed();
  return ready;
}

function deactivate(id, { silent = false } = {}) {
  const rec = S.recs.get(id);
  if (!rec || rec.builtin || !rec.active) return;
  rec.active = false;
  try { if (typeof registry.unregisterPlugin === 'function') registry.unregisterPlugin(id); } catch (e) { warn(rec, 'unregister', e); }
  try { unregisterActions(id); } catch (e) { warn(rec, 'actions', e); }
  try { unregisterPresets(id); } catch (e) { warn(rec, 'presets', e); }
  for (const fr of [...rec.frames]) destroyFrame(fr);
  for (const tab of rec.tabs) {
    try { if (S.ui && S.ui.removeTab) S.ui.removeTab(tab.id); } catch (e) { warn(rec, 'tab', e); }
    tab.el.remove();
  }
  rec.tabs = [];
  if (!silent) changed();
}

/** Включить/выключить плагин (запоминается в settings.plugins.disabled) */
export async function setEnabled(id, on) {
  const rec = S.recs.get(id);
  if (!rec || rec.builtin) return;
  const cur = new Set(disabledList());
  if (on) cur.delete(id); else cur.add(id);
  const prev = getSetting('plugins', null);
  await setSettings({ plugins: { ...(prev && typeof prev === 'object' ? prev : {}), disabled: [...cur] } });
  if (on) activate(rec); else deactivate(id);
  changed();
}

// ---------------------------------------------------------------------------
// Установка и удаление (окна подтверждения — в settings.js)
// ---------------------------------------------------------------------------
// Новая или обновлённая версия без согласия пользователя не запускается: сначала выключаем,
// настройки показывают права и спрашивают, включить ли.
async function afterInstall(r) {
  if (!r || typeof r.id !== 'string') throw new Error(t('Установка не вернула id плагина'));
  deactivate(r.id, { silent: true });
  const cur = new Set(disabledList());
  cur.add(r.id);
  const prev = getSetting('plugins', null);
  await setSettings({ plugins: { ...(prev && typeof prev === 'object' ? prev : {}), disabled: [...cur] } });
  await refreshList();
  return r;
}
export async function installFrom(source) { return afterInstall(await api.pluginsInstall(source)); }
export async function installGithub(repo) { return afterInstall(await api.pluginsInstallGithub(repo)); }

export async function removePlugin(id) {
  const rec = S.recs.get(id);
  if (!rec || rec.builtin) return false;
  deactivate(id);
  await api.pluginsRemove(id);
  const cur = disabledList().filter((x) => x !== id);
  const prev = getSetting('plugins', null);
  await setSettings({ plugins: { ...(prev && typeof prev === 'object' ? prev : {}), disabled: cur } }).catch((e) => console.warn('plugins settings', e));
  await refreshList();
  return true;
}

// ---------------------------------------------------------------------------
// Пропавшие плагины: проект ссылается на неизвестные эффекты/переходы/аудиоэффекты
// ---------------------------------------------------------------------------
export function warnMissing(project = store.project) {
  try {
    if (typeof registry.missingIds !== 'function') return null;
    const m = registry.missingIds(project) || {};
    const ids = [...new Set([...(m.effects || []), ...(m.transitions || []), ...(m.audioEffects || [])])];
    if (!ids.length) return null;
    const owners = [...new Set(ids.map((x) => (String(x).includes('.') ? String(x).split('.')[0] : x)))];
    toast(t('В проекте есть эффекты плагинов, которых нет или они выключены: {list}. Они не применяются, но остаются в проекте — установите или включите плагин.', { list: owners.join(', ') }), 'warning', 10000);
    return m;
  } catch (e) { console.warn('missingIds', e); return null; }
}

// ---------------------------------------------------------------------------
// Действия, пресеты клавиш, панели
// ---------------------------------------------------------------------------
function addAction(rec, a, frame) {
  if (!a || typeof a.id !== 'string' || !SUB_ID.test(a.id)) throw new Error('action id must match [A-Za-z0-9_-]');
  const short = a.id;
  const full = `${rec.id}.${short}`;
  const title = localized(a.title, short);
  registerAction({
    id: full, plugin: rec.id, cat: typeof a.category === 'string' ? a.category : 'plugins',
    title: `${pluginName(rec)}: ${title}`, keys: Array.isArray(a.keys) ? a.keys : [],
  }, () => sendAction(rec, short, frame));
  return full;
}

// Нажатие клавиши → событие 'action' в плагин: во фрейм, который зарегистрировал действие,
// иначе в логику (entry), а если её нет — во все панели плагина
function sendAction(rec, id, frame) {
  let targets = frame && rec.frames.has(frame) ? [frame] : [...rec.frames].filter((f) => f.kind === 'main');
  if (!targets.length) targets = [...rec.frames];
  if (!targets.length) { toast(t('Плагин «{name}» не отвечает', { name: pluginName(rec) }), 'error', 3000); return; }
  for (const f of targets) post(f, { t: 'event', name: 'action', data: { id } });
}

function addKeymap(rec, k) {
  if (!k || typeof k.id !== 'string' || !SUB_ID.test(k.id)) throw new Error('keymap id must match [A-Za-z0-9_-]');
  const own = new Set(((rec.manifest && rec.manifest.contributes && rec.manifest.contributes.actions) || []).map((a) => a && a.id));
  const keys = {};
  for (const [action, list] of Object.entries(k.keys || {})) {
    // своё действие можно указать коротким id
    const id = own.has(action) || actionById(`${rec.id}.${action}`) ? `${rec.id}.${action}` : action;
    keys[id] = list;
  }
  return registerPreset(`${rec.id}.${k.id}`, { name: localized(k.name, k.id), keys }, rec.id);
}

function addPanel(rec, p) {
  need(rec.perms, 'ui:panel');
  if (!p || typeof p.id !== 'string' || !SUB_ID.test(p.id)) throw new Error('panel id must match [A-Za-z0-9_-]');
  if (typeof p.entry !== 'string' || !p.entry) throw new Error('panel entry is required');
  const tabId = `plugin:${rec.id}:${p.id}`;
  const el = h('div', { class: 'panel plugin-panel', hidden: true, dataset: { plugin: rec.id, panel: p.id } });
  const side = document.getElementById('right-side');
  if (!side) throw new Error('#right-side not found');
  side.append(el);
  rec.tabs.push({ id: tabId, el });
  createFrame(rec, { kind: 'panel', panelId: p.id, src: pluginUrl(rec.id, p.entry), parent: el });
  const title = localized(p.title, pluginName(rec));
  if (S.ui && S.ui.addTab) S.ui.addTab({ id: tabId, name: title, el, title: `${pluginName(rec)} — ${title}`, plugin: rec.id });
}

// ---------------------------------------------------------------------------
// Фреймы и порты
// ---------------------------------------------------------------------------
function framesBox() {
  let box = document.getElementById('plugin-frames');
  if (!box) {
    box = h('div', { id: 'plugin-frames', 'aria-hidden': 'true' });
    document.body.append(box);
  }
  return box;
}

function createFrame(rec, { kind, panelId = null, src, parent }) {
  const iframe = document.createElement('iframe');
  // Только allow-scripts: без allow-same-origin фрейм — непрозрачный источник без доступа к окну и IPC
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', '');
  iframe.className = kind === 'main' ? 'plugin-main-frame' : 'plugin-frame';
  iframe.title = pluginName(rec);
  // Предварительные сведения для SDK (ffm.lang и т.п. доступны синхронно, до ffm-init)
  iframe.name = JSON.stringify({ ffm: 1, pluginId: rec.id, lang: getLang(), kind, panelId, apiVersion: API_VERSION, permissions: [...rec.perms] });
  const fr = { rec, iframe, kind, panelId, port: null, ready: false, sub: false, inflight: 0, resolveReady: null };
  fr.readyP = new Promise((r) => { fr.resolveReady = r; });
  iframe.addEventListener('load', () => { try { connect(fr); } catch (e) { warn(rec, 'connect', e); } });
  iframe.src = src;
  rec.frames.add(fr);
  parent.append(iframe);
  return fr;
}

function connect(fr) {
  if (!fr.rec.frames.has(fr)) return;
  if (fr.port) { try { fr.port.close(); } catch { /* ignore */ } }
  const ch = new MessageChannel();
  fr.port = ch.port1;
  fr.sub = false;
  fr.inflight = 0;
  const port = ch.port1;
  port.onmessage = (e) => onFrameMessage(fr, port, e.data);
  port.onmessageerror = () => warn(fr.rec, 'message could not be deserialized');
  const win = fr.iframe.contentWindow;
  if (!win) return;
  win.postMessage({
    type: 'ffm-init', pluginId: fr.rec.id, apiVersion: API_VERSION, lang: getLang(),
    kind: fr.kind, panelId: fr.panelId, permissions: [...fr.rec.perms],
  }, '*', [ch.port2]);
}

function destroyFrame(fr) {
  fr.rec.frames.delete(fr);
  if (fr.port) { try { fr.port.close(); } catch { /* ignore */ } }
  fr.port = null;
  try { fr.iframe.src = 'about:blank'; } catch { /* ignore */ }
  fr.iframe.remove();
  if (fr.resolveReady) fr.resolveReady();
}

function post(fr, msg) {
  if (!fr.port) return false;
  try { fr.port.postMessage(msg); return true; } catch (e) { warn(fr.rec, 'post', e); return false; }
}

async function onFrameMessage(fr, port, d) {
  if (!d || typeof d !== 'object' || port !== fr.port) return;
  if (d.t === 'ready') { fr.ready = true; if (fr.resolveReady) fr.resolveReady(); return; }
  if (d.t !== 'req' || !Number.isSafeInteger(d.id)) return;
  if (fr.inflight >= MAX_INFLIGHT) {
    try { port.postMessage({ t: 'res', id: d.id, ok: false, error: 'Too many requests at once' }); } catch { /* ignore */ }
    return;
  }
  fr.inflight++;
  let res;
  try {
    const result = await handle(fr, String(d.method || ''), d.args);
    res = { t: 'res', id: d.id, ok: true, result: result === undefined ? null : result };
  } catch (e) {
    res = { t: 'res', id: d.id, ok: false, error: errText(e).slice(0, 2000) };
  } finally {
    fr.inflight--;
  }
  if (port !== fr.port) return;
  try { port.postMessage(res); } catch (e) {
    try { port.postMessage({ t: 'res', id: d.id, ok: false, error: `Result could not be sent: ${errText(e)}` }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// API v1
// ---------------------------------------------------------------------------
const snapshot = () => JSON.parse(JSON.stringify(store.project));
const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Действия, которые плагину выполнять нельзя: файлы, экспорт, настройки (категория «Файл»), чужие плагины
function actionAllowed(rec, a) {
  if (!a || a.cat === 'file') return false;
  if (a.plugin && a.plugin !== rec.id) return false;
  return true;
}

let mcp = null;
async function callTool(name, args) {
  if (!mcp) mcp = await import('../mcpBridge.js');
  if (typeof mcp.callTool !== 'function') throw new Error('MCP tools are not available');
  const r = await mcp.callTool(name, args);
  return r === undefined ? null : JSON.parse(JSON.stringify(r));
}

async function handle(fr, method, args) {
  const rec = fr.rec;
  if (!rec.active) throw new Error('Plugin is disabled');
  const perms = rec.perms;
  switch (method) {
    case 'project.get':
      need(perms, 'project:read');
      return snapshot();
    case 'project.subscribe':
      need(perms, 'project:read');
      fr.sub = !!(args && args.on);
      return true;

    case 'commands.list':
      return ACTIONS.filter((a) => actionAllowed(rec, a)).map((a) => ({ id: a.id, title: a.title, category: a.cat, keys: keysOf(a.id) }));
    case 'commands.execute': {
      need(perms, 'project:write');
      const id = String((args && args.id) || '');
      const a = actionById(id) || actionById(`${rec.id}.${id}`);
      if (!a) throw new Error(`Unknown action: ${id}`);
      if (!actionAllowed(rec, a)) throw new Error(`Action is not available to plugins: ${a.id}`);
      if (document.querySelector('.modal-overlay')) throw new Error('A dialog is open, try again later');
      if (!runAction(a.id)) throw new Error(`Action has no handler: ${a.id}`);
      return true;
    }

    case 'tools.call': {
      const name = String((args && args.name) || '');
      const perm = Object.prototype.hasOwnProperty.call(TOOL_PERMS, name) ? TOOL_PERMS[name] : null;
      if (!perm) throw new Error(`Tool is not available to plugins: ${name}`);
      need(perms, perm);
      return callTool(name, isPlain(args && args.args) ? args.args : {});
    }

    case 'register.effect':
    case 'register.transition':
    case 'register.audioEffect':
    case 'register.exportPreset': {
      const fn = { 'register.effect': 'registerEffect', 'register.transition': 'registerTransition', 'register.audioEffect': 'registerAudioEffect', 'register.exportPreset': 'registerExportPreset' }[method];
      if (typeof registry[fn] !== 'function') throw new Error(`registry.${fn} is not available`);
      if (!isPlain(args)) throw new Error('Descriptor must be an object');
      return registry[fn](JSON.parse(JSON.stringify(args)), rec.owner);
    }
    case 'register.keymap':
      if (!isPlain(args)) throw new Error('Descriptor must be an object');
      return addKeymap(rec, args);
    case 'register.action':
      if (!isPlain(args)) throw new Error('Descriptor must be an object');
      return addAction(rec, args, fr);

    case 'ui.notify':
      // уведомления разрешены всем плагинам, но не чаще 5 за 10 с
      return notify(rec, args);

    case 'storage.get':
      need(perms, 'storage');
      return (await api.pluginStorageGet(rec.id)) || {};
    case 'storage.set': {
      need(perms, 'storage');
      if (!isPlain(args)) throw new Error('storage.set expects a plain object');
      const text = JSON.stringify(args);
      if (text.length > 1024 * 1024) throw new Error('Storage limit is 1 MB');
      await api.pluginStorageSet(rec.id, JSON.parse(text));
      return true;
    }

    case 'net.fetch': {
      const a = isPlain(args) ? args : {};
      const url = checkNetUrl(perms, a.url);
      const request = { url };
      if (a.method !== undefined && a.method !== null) {
        const m = String(a.method).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) throw new Error(`Method not allowed: ${m}`);
        request.method = m;
      }
      if (isPlain(a.headers)) {
        request.headers = {};
        for (const [k, v] of Object.entries(a.headers)) {
          if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`Bad header: ${k}`);
          request.headers[k] = String(v);
        }
      }
      if (a.body !== undefined && a.body !== null) request.body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
      return api.pluginNetFetch(rec.id, request);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function notify(rec, args) {
  const text = String((args && args.text) || '').trim().slice(0, 400);
  if (!text) return false;
  const now = Date.now();
  rec.noticeTimes = rec.noticeTimes.filter((x) => now - x < 10000);
  if (rec.noticeTimes.length >= 5) throw new Error('Too many notifications');
  rec.noticeTimes.push(now);
  const kind = ['info', 'success', 'error', 'warning'].includes(args && args.kind) ? args.kind : 'info';
  toast(h('span', { class: 'plugin-toast' }, h('b', {}, `${pluginName(rec)}: `), text), kind, kind === 'error' ? 6000 : 3500);
  return true;
}

// Изменения проекта → подписанным фреймам (с правом project:read), не чаще PROJECT_EVERY
let projTimer = null;
let projLast = 0;
function scheduleProject() {
  if (projTimer) return;
  const wait = Math.max(0, PROJECT_EVERY - (Date.now() - projLast));
  projTimer = setTimeout(() => {
    projTimer = null;
    projLast = Date.now();
    let snap = null;
    for (const rec of S.recs.values()) {
      if (!rec.active || !rec.perms.has('project:read')) continue;
      for (const fr of rec.frames) {
        if (!fr.sub || !fr.port) continue;
        if (!snap) snap = snapshot();
        post(fr, { t: 'event', name: 'project', data: snap });
      }
    }
  }, wait);
}
