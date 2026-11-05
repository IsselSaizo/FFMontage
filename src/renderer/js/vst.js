// Аудиоплагины VST3 / CLAP в окне (контракт .agent/vst3-contract.md):
//   • список найденных плагинов (vst_list при старте, vst_scan, папки, установка) и событие изменения;
//   • рендер цепочек (vst_render): одно задание — один запуск (ключ — само задание), событие готовности;
//     для плеера — clipRender / trackRender (сначала рендеры клипов дорожки, потом граф дорожки);
//   • окна плагинов (vst_editor_open / vst_editor_cmd): живое прослушивание, транспорт плеера → хост,
//     vst:state → fx.vst.state/ctrl в проекте (первое изменение сессии — запись undo, дальше — без новых записей).
import { store } from './store.js';
import { t } from './i18n.js';
import { toast, errText, uid as newId } from './util.js';
import { setVstPlugins, needsRender, isVst, normUid, vstName, vstKnown, cleanVstParams } from './audioFx.js';
import { clipJob, trackJob, trackVstClips, jobKey, videoSoundOn } from './vstJobs.js';
import { clipEnd } from './clipTime.js';

export { clipJob, trackJob, jobKey };
const api = () => window.api;

// ---------------------------------------------------------------------------
// Список плагинов
// ---------------------------------------------------------------------------
const st = { supported: null, loaded: false, plugins: [], failed: [], folders: [], defaults: [], error: '', scanning: null };
const listeners = new Set();
/** fn(kind): 'list' | 'scan' | 'render' | 'session' | 'info' */
export const onVstChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind) => { for (const fn of [...listeners]) { try { fn(kind); } catch (e) { console.warn('vst listener', e); } } };
let renderTimer = null;
const renderChanged = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; emit('render'); }, 120); };

export const vstStatus = () => st;
export const vstPlugins = () => st.plugins;
export const pluginByUid = (u) => { const n = normUid(u); return st.plugins.find((p) => normUid(p.uid) === n) || null; };
export const pluginFormat = (p) => (p && (p.format === 'clap' || /^clap:/i.test(String(p.uid))) ? 'clap' : 'vst3');
export const formatLabel = (f) => (f === 'clap' ? 'CLAP' : 'VST3');

function applyList(r) {
  st.plugins = Array.isArray(r && r.plugins) ? r.plugins : [];
  st.failed = Array.isArray(r && r.failed) ? r.failed : [];
  st.folders = Array.isArray(r && r.folders) ? r.folders : [];
  st.defaults = Array.isArray(r && r.defaults) ? r.defaults : [];
  st.userDir = (r && r.userDir) || '';
  if (r && typeof r.supported === 'boolean') st.supported = r.supported;
  st.loaded = true; st.error = '';
  setVstPlugins(st.plugins);
  memo.clear();
  emit('list');
  return r;
}
export async function refreshVst() {
  try { return applyList(await api().vstList()); } catch (e) { st.error = errText(e); emit('list'); throw e; }
}
export async function scanVst(force = false) {
  st.scanning = { done: 0, total: 0, path: '' }; emit('scan');
  try { return applyList(await api().vstScan(force)); } finally { st.scanning = null; emit('scan'); }
}
export const setVstFolders = async (folders) => applyList(await api().vstFoldersSet(folders));
export const pickVstFolder = () => api().vstPickFolder();
export const installVst = async (path = null) => applyList(await api().vstInstall(path));
/** Путь — аудиоплагин (.vst3 — файл или пакет-папка, .clap) */
export const isPluginPath = (p) => /\.(vst3|clap)[\\/]?$/i.test(String(p || ''));
/**
 * Файлы, брошенные на окно: аудиоплагины установить (как «Добавить плагин…»), остальные пути вернуть.
 * → { rest, installed, errors }
 */
export async function installDropped(paths) {
  const plugs = paths.filter(isPluginPath);
  const res = { rest: paths.filter((p) => !isPluginPath(p)), installed: 0, errors: [] };
  if (!plugs.length) return res;
  if (st.supported === false) {
    toast(t('Аудиоплагины VST3 / CLAP работают только в Windows (x64).'), 'error', 5000);
    res.errors.push('unsupported');
    return res;
  }
  for (const p of plugs) {
    try { await installVst(p.replace(/[\\/]$/, '')); res.installed++; } catch (e) {
      res.errors.push(errText(e));
      toast(t('Аудиоплагин: {e}', { e: errText(e) }), 'error', 7000);
    }
  }
  if (res.installed) toast(t('Аудиоплагинов добавлено: {n}. Они в стойке эффектов (вкладка «Аудио»).', { n: res.installed }), 'success', 4000);
  return res;
}

// Описание плагина (vst_info): есть ли окно, параметры для общих ползунков. Кэш по uid.
const infos = new Map(); // normUid -> { info, promise, error }
export function pluginInfo(uid, state = null, ctrl = null) {
  const k = normUid(uid);
  let rec = infos.get(k);
  if (!rec || rec.error) {
    rec = { info: null, error: null, promise: null };
    rec.promise = api().vstInfo(uid, state || null, ctrl || null)
      .then((i) => { rec.info = i; emit('info'); return i; }, (e) => { rec.error = errText(e); emit('info'); throw e; });
    rec.promise.catch(() => {});
    infos.set(k, rec);
  }
  return rec.promise;
}
/** Описание из кэша (null — ещё грузится; загрузка запускается сама) */
export function infoCached(uid, state, ctrl) {
  const rec = infos.get(normUid(uid));
  if (rec && rec.info) return rec.info;
  if (!rec && st.supported) pluginInfo(uid, state, ctrl);
  return null;
}
export const infoError = (uid) => { const rec = infos.get(normUid(uid)); return rec ? rec.error : null; };

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------
let ready = false;   // список плагинов и версия FFmpeg известны
let ffMajor = 99;
const WAIT = Object.freeze({ status: 'wait', fraction: 0 });
const LIVE = Object.freeze({ status: 'live' });
const renders = new Map();  // jobKey -> rec { key, job, tag, status: 'wait'|'run'|'ready'|'error', fraction, path, url, error, promise }
const waiting = new Map();  // владелец ('c:<clipId>' | 't:<trackId>') -> rec в ожидании запуска (правки подряд — один рендер)
const memo = new Map();     // владелец -> rec | null (сбрасывается при любом изменении проекта и готовности рендера)
const MAX_RECS = 300;
const DEBOUNCE = 350;

function startRec(rec) {
  clearTimeout(rec.timer);
  rec.status = 'run'; rec.fraction = 0; rec.error = null;
  rec.promise = api().vstRender(rec.job, rec.tag).then((r) => {
    Object.assign(rec, { status: 'ready', path: r.path, url: r.url, cached: !!r.cached, rustKey: r.key, fraction: 1 });
    return { path: r.path, url: r.url, key: r.key, cached: !!r.cached };
  }, (e) => {
    rec.status = 'error'; rec.error = errText(e);
    // Отчёт об ошибке (logs/reports): задание целиком — по нему рендер можно повторить
    try { if (api().crashReport) api().crashReport('render-failed', `audio render: ${rec.error}`, JSON.stringify(rec.job, null, 1)); } catch { /* ignore */ }
    throw e;
  }).finally(() => { memo.clear(); renderChanged(); });
  rec.promise.catch(() => {});
  renderChanged();
  return rec.promise;
}
function getRec(job) {
  const key = jobKey(job);
  let rec = renders.get(key);
  if (rec) { renders.delete(key); renders.set(key, rec); return rec; } // LRU: в конец
  rec = { key, job, tag: newId('vr'), status: 'wait', fraction: 0, path: null, url: null, error: null, promise: null };
  renders.set(key, rec);
  if (renders.size > MAX_RECS) {
    for (const [k, r] of renders) { if (renders.size <= MAX_RECS) break; if (r.status !== 'run' && r !== rec) renders.delete(k); }
  }
  return rec;
}
/** Рендер задания сейчас (экспорт, прослушивание): Promise<{ path, url, key, cached }> */
export function render(job) {
  const rec = getRec(job);
  if (rec.status === 'ready') return Promise.resolve({ path: rec.path, url: rec.url, key: rec.rustKey, cached: true });
  if (rec.status === 'run') return rec.promise;
  return startRec(rec);
}
// Для плеера: запуск с задержкой — пока тянут ползунок или край клипа, новые задания вытесняют прежние
function ensure(job, owner) {
  const key = jobKey(job);
  const had = renders.get(key);
  if (had) return getRec(job);
  const rec = getRec(job);
  const prev = waiting.get(owner);
  if (prev && prev !== rec && prev.status === 'wait') { clearTimeout(prev.timer); renders.delete(prev.key); }
  waiting.set(owner, rec);
  rec.timer = setTimeout(() => { if (rec.status === 'wait') startRec(rec); }, DEBOUNCE);
  return rec;
}
/** Повторить рендер с ошибкой */
export function retry(rec) { if (rec && rec.key && rec.status === 'error') startRec(rec); }

/** Пути готовых рендеров (keep для очистки кэша: категория 'audiofx') */
export const renderPaths = () => [...renders.values()].filter((r) => r.status === 'ready' && r.path).map((r) => r.path);

function onRenderProgress(p) {
  if (!p) return;
  let rec = null;
  if (p.tag) for (const r of renders.values()) if (r.tag === p.tag) { rec = r; break; }
  if (!rec && p.key) for (const r of renders.values()) if (r.rustKey === p.key) { rec = r; break; }
  if (rec && rec.status === 'run' && Number.isFinite(p.fraction)) { rec.fraction = Math.max(0, Math.min(1, p.fraction)); renderChanged(); }
}

/**
 * Рендер цепочки клипа для плеера: null — в цепочке нет найденных плагинов; иначе { status, fraction, url, error }:
 * 'wait' | 'run' — ещё нет (плеер играет сухой звук), 'ready' — url WAV, 'error', 'live' — открыто окно плагина.
 * audio — клип аудиодорожки (false — звук видеоклипа).
 */
export function clipRender(clip, audio = true) {
  const k = `c:${clip.id}`;
  if (memo.has(k)) return memo.get(k);
  let r = null;
  // Плагины VST3/CLAP или эффект без Web Audio (шумоподавление, 0.5.0) — звук клипа идёт через офлайн-рендер
  if (needsRender(clip.afx) && (audio || videoSoundOn(store.project, clip))) {
    if (!ready) return WAIT;
    if (liveOwner(k)) r = LIVE;
    else { const job = clipJob(store.project, clip, { audio }); r = job ? ensure(job, k) : null; }
  }
  memo.set(k, r);
  return r;
}
// Пути готовых рендеров клипов дорожки; не готово — { pending: rec }
function trackClipWavs(track, render1) {
  const wavs = {};
  for (const c of trackVstClips(store.project, track)) {
    const r = render1(c);
    if (!r) continue;
    if (r.status !== 'ready') return { pending: r };
    wavs[c.id] = r.path;
  }
  return { wavs };
}
/** Рендер всей дорожки (VST3/CLAP в эффектах дорожки) для плеера — как clipRender */
export function trackRender(track) {
  const k = `t:${track.id}`;
  if (memo.has(k)) return memo.get(k);
  let r = null;
  if (needsRender(track.afx)) {
    if (!ready) return WAIT;
    if (liveOwner(k)) r = LIVE;
    else {
      const cw = trackClipWavs(track, (c) => clipRender(c, true));
      if (cw.pending) {
        const p = cw.pending;
        r = p.status === 'error' ? { status: 'error', error: p.error } : { status: 'wait', fraction: 0 };
      } else {
        const job = trackJob(store.project, track.id, { clipWavs: cw.wavs, ffMajor });
        r = job ? ensure(job, k) : null;
      }
    }
  }
  memo.set(k, r);
  return r;
}
/** Состояние рендера для стойки: target = { kind: 'clip' | 'track', id } */
export function ownerRender(target) {
  if (!target) return null;
  if (target.kind === 'track') {
    const tr = store.project.audioTracks.find((x) => x.id === target.id);
    return tr ? trackRender(tr) : null;
  }
  const f = store.findClip(target.id);
  return f ? clipRender(f.clip, f.kind === 'audio') : null;
}

// Задания для экспорта: все цепочки с плагинами, рендер ждём (без задержки)
async function renderTrackClips(project, track) {
  const wavs = {};
  for (const c of trackVstClips(project, track)) {
    const job = clipJob(project, c, { audio: true });
    if (job) wavs[c.id] = (await render(job)).path;
  }
  return wavs;
}

// ---------------------------------------------------------------------------
// Окна плагинов (живые сессии)
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> { id, owner, target, index, uid, open, edited, playing, lastPos }
const ownerKey = (target) => `${target.kind === 'track' ? 't' : 'c'}:${target.id}`;
export const liveOwner = (owner) => { for (const s of sessions.values()) if (s.owner === owner) return true; return false; };
export const isLive = (target) => !!target && liveOwner(ownerKey(target));
export const sessionOf = (target, index) => { for (const s of sessions.values()) if (s.owner === ownerKey(target) && s.index === index) return s; return null; };
const cmd = (s, c) => api().vstEditorCmd(s.id, c).catch((e) => console.warn('vst_editor_cmd', c.op, e));

// Запись стойки сессии: по индексу, а если стойку поменяли — единственная запись того же плагина
function sessionFx(s, p = store.project) {
  const o = store.fxOwner(s.target, p);
  const list = o && Array.isArray(o.afx) ? o.afx : [];
  const same = (x) => isVst(x) && x.vst && normUid(x.vst.uid) === normUid(s.uid);
  if (same(list[s.index])) return list[s.index];
  const c = list.filter(same);
  if (c.length === 1) { s.index = list.indexOf(c[0]); return c[0]; }
  return null;
}

// Звук до этого плагина: рендер предыдущих стадий цепочки (пустой список стадий — сухой звук)
async function auditionJob(target, index) {
  const p = store.project;
  if (target.kind === 'track') {
    const tr = p.audioTracks.find((x) => x.id === target.id);
    if (!tr) return null;
    return trackJob(p, tr.id, { clipWavs: await renderTrackClips(p, tr), ffMajor, upto: index });
  }
  const f = store.findClip(target.id);
  return f ? clipJob(p, f.clip, { audio: f.kind === 'audio', upto: index }) : null;
}
const posOf = (s, time) => {
  if (s.target.kind === 'track') return { pos: Math.max(0, time), inside: true };
  const f = store.findClip(s.target.id);
  if (!f) return { pos: 0, inside: false };
  return { pos: Math.max(0, time - f.clip.start), inside: time >= f.clip.start - 0.004 && time < clipEnd(f.clip) - 0.02 };
};

/**
 * Открыть окно плагина записи index стойки target. → { hasEditor }.
 * У плагина без своего окна сессия тоже живёт (прослушивание), общие ползунки стойки → sendParams();
 * без открытой сессии ползунки меняют fx.vst.params → новый рендер.
 */
export async function openEditor(target, index, title = '') {
  await initVst();
  const o = store.fxOwner(target);
  const fx = o && Array.isArray(o.afx) ? o.afx[index] : null;
  if (!isVst(fx) || !vstKnown(fx)) throw new Error(t('Плагин не найден на этом компьютере'));
  const ex = sessionOf(target, index);
  if (ex) { if (ex.hasEditor !== false) cmd(ex, { op: 'focus' }); return { hasEditor: ex.hasEditor !== false }; }
  // На одной цепочке — одно окно: иначе звук играли бы два хоста
  for (const s of [...sessions.values()]) if (s.owner === ownerKey(target)) await closeEditor(s.id);
  let audition = null;
  try {
    const job = await auditionJob(target, index);
    if (job) {
      const r = await render(job);
      const s0 = { target };
      audition = { wav: r.path, pos: posOf(s0, store.time).pos };
    }
  } catch (e) { toast(t('Не удалось подготовить звук для прослушивания: {e}', { e: errText(e) }), 'error', 6000); }
  const id = newId('vsts');
  const s = { id, owner: ownerKey(target), target: { kind: target.kind, id: target.id }, index, uid: fx.vst.uid, open: false, edited: false, playing: false, lastPos: null };
  sessions.set(id, s);
  memo.clear(); emit('session');
  let r;
  try {
    r = await api().vstEditorOpen({
      session: id, uid: fx.vst.uid, state: fx.vst.state || '', ctrl: fx.vst.ctrl || '',
      params: cleanVstParams(fx.vst.params), title: title || vstName(fx), audition,
    });
    if (!r || r.ok === false) throw new Error((r && r.error) || t('Окно плагина не открылось'));
  } catch (e) {
    sessions.delete(id); memo.clear(); emit('session');
    throw e;
  }
  // Без своего окна сессия тоже живёт: хост играет звук через плагин, общие ползунки стойки шлют op:'params'
  s.hasEditor = r.hasEditor !== false;
  if (!s.hasEditor) {
    const rec = infos.get(normUid(fx.vst.uid));
    if (rec && rec.info) rec.info = { ...rec.info, hasEditor: false };
    emit('info');
  }
  s.open = true;
  emit('session');
  syncLive(store.time, store.playing, true);
  return { hasEditor: s.hasEditor };
}
/** Общие ползунки плагина без окна во время сессии: values = { '<id>': 0..1 } */
export function sendParams(target, index, values) {
  const s = sessionOf(target, index);
  if (s && s.open) cmd(s, { op: 'params', values: cleanVstParams(values) });
}
export async function closeEditor(id) {
  const s = sessions.get(id);
  if (!s) return;
  // Окончательно сессия уходит по vst:closed; хост уже не отвечает — убрать сразу, иначе клип так и молчал бы
  try { await api().vstEditorCmd(s.id, { op: 'close' }); } catch (e) {
    console.warn('vst_editor_cmd close', e);
    sessions.delete(s.id); memo.clear(); emit('session');
  }
}

function onState(p) {
  const s = p && sessions.get(p.session);
  if (!s) return;
  const state = String(p.state || ''); const ctrl = String(p.ctrl || '');
  const cur = sessionFx(s);
  if (!cur || (String(cur.vst.state || '') === state && String(cur.vst.ctrl || '') === ctrl)) return;
  const fn = (proj) => { const fx = sessionFx(s, proj); if (fx) fx.vst = { ...fx.vst, state, ctrl }; };
  // Одна запись отмены на сессию: первое изменение — с историей, дальше — без новых записей
  if (!s.edited) { s.edited = true; store.mutate(fn); } else { store.live(fn); store.dirty = true; }
}
function onClosed(p) {
  const s = p && sessions.get(p.session);
  if (!s) return;
  sessions.delete(s.id);
  if (p.error) toast(t('Окно плагина закрылось с ошибкой: {e}', { e: String(p.error) }), 'error', 7000);
  memo.clear(); emit('session');
}
function onEditor(p) {
  const s = p && sessions.get(p.session);
  if (!s || typeof p.hasEditor !== 'boolean' || s.hasEditor === p.hasEditor) return;
  s.hasEditor = p.hasEditor;
  emit('session');
}
function onError(p) {
  if (!p || !p.message) return;
  toast(t('Аудиоплагин: {e}', { e: String(p.message) }), 'error', 7000);
}
function onProject() {
  memo.clear();
  // Клип/дорожку с открытым окном удалили (или открыли другой проект) — окно закрыть
  for (const s of [...sessions.values()]) if (!sessionFx(s)) closeEditor(s.id);
}

/**
 * Транспорт плеера → хост живой сессии (pos — секунды WAV прослушивания). Плеер зовёт на каждом шаге;
 * команды уходят только при смене состояния или (force) при перемотке.
 */
export function syncLive(time, playing, force = false) {
  for (const s of sessions.values()) {
    if (!s.open) continue;
    const { pos, inside } = posOf(s, time);
    const want = playing && inside;
    if (want && !s.playing) { s.playing = true; s.lastPos = pos; cmd(s, { op: 'play', pos }); } else if (!want && s.playing) {
      s.playing = false; cmd(s, { op: 'pause' });
      if (force) { s.lastPos = pos; cmd(s, { op: 'seek', pos }); }
    } else if (force && (s.lastPos === null || Math.abs(s.lastPos - pos) > 0.01 || playing)) {
      s.lastPos = pos; cmd(s, { op: 'seek', pos });
    }
  }
}
export const liveCount = () => sessions.size;

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
let inited = null;
export function initVst() {
  if (inited) return inited;
  inited = (async () => {
    const a = api();
    if (!a || typeof a.vstSupported !== 'function') { st.supported = false; setVstPlugins([]); ready = true; return; }
    a.onVstScan((p) => { st.scanning = p || null; emit('scan'); });
    a.onVstRender(onRenderProgress);
    a.onVstState(onState);
    a.onVstClosed(onClosed);
    if (typeof a.onVstEditor === 'function') a.onVstEditor(onEditor);
    if (typeof a.onVstError === 'function') a.onVstError(onError);
    store.on('project', onProject);
    try { st.supported = !!(await a.vstSupported()); } catch { st.supported = false; }
    try { const i = await a.info(); if (i && Number(i.ffMajor) > 0) ffMajor = Number(i.ffMajor); } catch { /* 99 */ }
    if (st.supported) await refreshVst().catch((e) => console.warn('vst_list', e));
    if (!st.loaded) setVstPlugins([]);
    ready = true;
    memo.clear();
    emit('list');
  })();
  return inited;
}

/** Есть ли в проекте записи VST3/CLAP (для подготовки экспорта) */
export const projectUsesVst = (p) => [
  ...(p.videoClips || []), ...(p.overlayClips || []), ...(p.videoTracks || []).flatMap((x) => x.clips || []),
  ...(p.audioTracks || []).flatMap((x) => [x, ...(x.clips || [])]),
].some((x) => Array.isArray(x.afx) && x.afx.some(isVst));
