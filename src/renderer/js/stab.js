// Стабилизация в окне (встроенный плагин plugins-bundled/stabilize, план .agent/design/fx-restore/PLAN.md, этапы 4–5):
// фоновые задания программы (src-tauri/src/stab.rs) для клипов с эффектом stage 'source':
//   • анализ движения vidstab (эффект с prepare.kind 'vidstab') — сразу, как эффект добавлен, параметры анализа
//     изменились или клип обрезан за пределы запаса (stab.rs сам находит готовый анализ, покрывающий клип);
//   • прокси превью — если включён чекбокс «Показывать превью» (clip.fxp[id].showPreview): после готового анализа
//     (для vidstab) делается H.264 ~720p отрезка клипа с эффектом; плеер (preview.js) играет его вместо исходника
//     (stabPreview: адрес и сдвиг времени — начало отрезка в файле). Смена уровня/параметров/обрезка → новое задание,
//     прежнее отменяется. Выключили чекбокс — задание отменяется, плеер возвращается к исходнику.
// Состояние заданий — только в памяти окна; событие store 'stab' (clipId) — статус изменился (инспектор),
// 'stab-src' — у клипа сменился источник плеера.
import { store } from './store.js';
import { sourceEffect, setHostCaps, effectAvailable } from './effects.js';
import { analyzeReq, proxyReq } from './stabPlan.js';
import { onRegistryChange } from './registry.js';
import { errText } from './util.js';

const api = typeof window !== 'undefined' ? window.api : null;
// clipId -> { effect, a: задание анализа | { state: 'unavailable' } | null, p: задание прокси | null }
// задание: { key, id, state: running|ready|error, progress, error?, start, end, trf?, url? }
const jobs = new Map();
let timer = null; let busy = false; let again = false;
const POLL_MS = 500;

let inited = false;
export function initStab() {
  if (inited || !api) return;
  inited = true;
  api.info().then((i) => {
    if (i && 'vidstab' in i) setHostCaps({ vidstab: !!i.vidstab });
    store.emit('stab', null);
    schedule(0);
  }).catch(() => schedule(0));
  store.on('project', () => schedule(250));
  store.on('media', () => schedule(250));
  onRegistryChange(() => schedule(250));
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

async function run() {
  if (busy) { again = true; return; }
  busy = true;
  let pending = false;
  try { pending = await sync(); } catch (e) { console.warn('stab sync', e); }
  busy = false;
  if (again) { again = false; schedule(0); } else if (pending) schedule(POLL_MS);
}

const keyOf = (req) => JSON.stringify(req);
const cancelJob = (j) => { if (j && j.id && j.state === 'running') api.stabCancel(j.id); };

// Один шаг задания: то же и уже закончено — как есть; иначе спросить программу (запустит или скажет прогресс)
async function step(kind, req, prev, clipId, retry = false) {
  const key = keyOf(req);
  if (!retry && prev && prev.key === key && (prev.state === 'ready' || prev.state === 'error')) return prev;
  let r;
  try {
    const q = retry ? { ...req, retry: true } : req;
    r = await (kind === 'analyze' ? api.stabAnalyze(q) : api.stabProxy(q));
  } catch (e) { r = { state: 'error', error: errText(e) }; }
  if (prev && prev.id && prev.state === 'running' && prev.id !== r.id) cancelJob(prev);
  const next = { ...r, key };
  if (!prev || prev.state !== next.state || prev.progress !== next.progress || prev.url !== next.url || prev.error !== next.error) {
    // после того, как вызывающий запишет новое состояние (s.a / s.p = await step(…))
    setTimeout(() => store.emit('stab', clipId), 0);
  }
  return next;
}

/** Проход по клипам проекта: запустить нужное, отменить лишнее. → есть идущие задания (опросить ещё раз) */
async function sync(retryId = null) {
  let pending = false;
  const seen = new Set();
  for (const c of store.allVideo()) {
    const se = sourceEffect(c);
    const m = se ? store.media(c.mediaId) : null;
    if (!se || !m || !m.path || m.hasVideo === false || m.isImage) continue;
    seen.add(c.id);
    const s = jobs.get(c.id) || { effect: null, a: null, p: null };
    jobs.set(c.id, s);
    const srcBefore = stabPreview(c);
    s.effect = se.id;
    const retry = retryId === c.id;
    let analysis = null;
    if (se.prepare && !effectAvailable(se.effect)) {
      // нет vidstab в сборке FFmpeg: ни анализа, ни превью
      if (!s.a || s.a.state !== 'unavailable') { cancelJob(s.a); cancelJob(s.p); s.a = { state: 'unavailable' }; s.p = null; store.emit('stab', c.id); store.emit('stab-src', c.id); }
      continue;
    }
    if (se.prepare) {
      const req = analyzeReq(c, m);
      if (!req) continue;
      s.a = await step('analyze', req, s.a && s.a.key ? s.a : null, c.id, retry && s.a && s.a.state === 'error');
      if (s.a.state === 'running') pending = true;
      if (s.a.state === 'ready') analysis = s.a;
    } else if (s.a) { cancelJob(s.a); s.a = null; store.emit('stab', c.id); }
    const preq = proxyReq(c, m, analysis);
    if (!preq) {
      if (s.p) { cancelJob(s.p); s.p = null; store.emit('stab', c.id); }
    } else {
      s.p = await step('proxy', preq, s.p, c.id, retry && s.p && s.p.state === 'error');
      if (s.p.state === 'running') pending = true;
    }
    const srcAfter = stabPreview(c);
    if ((srcBefore && srcBefore.url) !== (srcAfter && srcAfter.url)) store.emit('stab-src', c.id);
  }
  for (const [id, s] of jobs) {
    if (seen.has(id)) continue;
    cancelJob(s.a); cancelJob(s.p);
    jobs.delete(id);
    store.emit('stab', id);
    store.emit('stab-src', id);
  }
  return pending;
}

/** Повторить задание клипа после ошибки (кнопка в инспекторе) */
export function retryStab(clipId) {
  if (busy) { again = true; return; }
  busy = true;
  sync(clipId).catch((e) => console.warn('stab retry', e)).finally(() => { busy = false; schedule(POLL_MS); });
}

/**
 * Состояние стабилизации клипа для инспектора и MCP: null — у клипа нет эффекта stage 'source'.
 * { effect, analysis: null | { state: running|ready|error|unavailable, progress, error }, preview: bool,
 *   proxy: null | { state, progress, error } }
 */
export function stabStatus(clip) {
  const se = sourceEffect(clip);
  if (!se) return null;
  const s = jobs.get(clip.id);
  const pick = (j) => (j ? { state: j.state, progress: Number(j.progress) || 0, error: j.error || '' } : null);
  if (se.prepare && !effectAvailable(se.effect)) return { effect: se.id, analysis: { state: 'unavailable', progress: 0, error: '' }, preview: se.preview, proxy: null };
  return { effect: se.id, analysis: se.prepare ? pick(s && s.a) || { state: 'running', progress: 0, error: '' } : null, preview: se.preview, proxy: se.preview ? pick(s && s.p) || { state: 'running', progress: 0, error: '' } : null };
}

/**
 * Источник плеера для клипа: прокси со стабилизацией (готов и совпадает с текущими параметрами клипа) →
 * { url, off, len }: время прокси = время файла − off, длина len. null — играть исходник.
 */
export function stabPreview(clip) {
  const s = jobs.get(clip.id);
  if (!s || !s.p || s.p.state !== 'ready' || !s.p.url) return null;
  const se = sourceEffect(clip);
  if (!se || !se.preview || se.id !== s.effect) return null;
  const m = store.media(clip.mediaId);
  const req = proxyReq(clip, m, s.a && s.a.state === 'ready' ? s.a : null);
  if (!req || keyOf(req) !== s.p.key) return null;
  return { url: s.p.url, off: Number(s.p.start) || 0, len: Math.max(0.04, (Number(s.p.end) || 0) - (Number(s.p.start) || 0)) };
}
