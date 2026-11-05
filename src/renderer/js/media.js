// Импорт файлов, подготовка миниатюр/волны/прокси и панель «Ваши медиа».
import { store } from './store.js';
import { h, $, fmtTime, toast, iconEl, confirmDialog, fmtBytes, errText } from './util.js';
import { rebuildDerived } from './fx.js';
import { t } from './i18n.js';

const api = window.api;

export function playUrl(mediaId) {
  const m = store.media(mediaId);
  const rt = store.runtime[mediaId] || {};
  if (!m || rt.missing) return null;
  if (rt.proxyUrl) return rt.proxyUrl;
  return m.needsProxy || rt.forceProxy ? null : m.url;
}

// Играет ли окно этот файл без прокси. Список кодеков в программе — только догадка: HEVC и AV1 в WebView2
// зависят от расширений Windows и видеокарты, на Linux/macOS — от GStreamer/WKWebView.
// Поэтому спрашиваем сам WebView (MediaCapabilities / canPlayType) — это мгновенно и не занимает декодер.
const VIDEO_CT = {
  h264: () => 'avc1.640033',
  hevc: (ten) => (ten ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0'),
  av1: (ten) => (ten ? 'av01.0.13M.10' : 'av01.0.13M.08'),
  vp9: (ten) => (ten ? 'vp09.02.51.10' : 'vp09.00.51.08'),
  vp8: () => 'vp8',
};
function contentType(m) {
  const codec = VIDEO_CT[m.vcodec];
  if (!codec) return null;
  const ten = /10|12/.test(m.pixFmt || '');
  const mime = ['vp8', 'vp9'].includes(m.vcodec) ? 'video/webm' : 'video/mp4';
  return `${mime}; codecs="${codec(ten)}"`;
}

async function codecSupported(m) {
  const ct = contentType(m);
  if (!ct) return true;
  try {
    if (navigator.mediaCapabilities) {
      const r = await navigator.mediaCapabilities.decodingInfo({
        type: 'file',
        video: { contentType: ct, width: m.width || 1920, height: m.height || 1080, bitrate: Math.round(m.vbitrate || 8e6), framerate: m.fps || 30 },
      });
      return !!r.supported;
    }
  } catch (e) { console.warn('mediaCapabilities', ct, e); }
  return document.createElement('video').canPlayType(ct) !== '';
}

async function checkPlayable(mediaId) {
  const m = store.media(mediaId);
  if (!m || !m.hasVideo || m.isImage || m.needsProxy || !m.url) return true;
  const ok = await codecSupported(m);
  if (!ok) console.warn('media: окно не умеет', m.vcodec, m.pixFmt, '— нужен прокси');
  return ok;
}

// Первый кадр в отдельном скрытом <video>: true — играет, false — ошибка, null — не дождались
function probePlayable(url, ms = 8000) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true; clearTimeout(timer);
      v.removeAttribute('src'); v.load();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(null), ms);
    v.addEventListener('error', () => finish(false));
    // Без декодера видео WebView иногда играет только звук: ширина кадра 0
    v.addEventListener('loadeddata', () => finish(v.videoWidth > 0));
    v.src = url;
  });
}

// Плеер не смог открыть файл, который считался «играбельным» (например, HEVC 10 бит, который видеокарта
// не декодирует) — переходим на прокси. Сначала переспрашиваем отдельным <video>: ошибка бывает и временной.
const reprobing = new Set();
export async function playbackFailed(mediaId) {
  const m = store.media(mediaId);
  const rt = store.runtime[mediaId] || {};
  if (!m || reprobing.has(mediaId)) return;
  // Переложенный без перекодирования файл не заиграл — перекодировать
  if (rt.remuxed && rt.proxyUrl) {
    reprobing.add(mediaId);
    try {
      if ((await probePlayable(rt.proxyUrl)) !== false) return;
      console.warn('media: ремукс не играет', m.name, '— перекодирование');
      startProxy(mediaId, { noRemux: true });
    } finally { reprobing.delete(mediaId); }
    return;
  }
  if (!m.url || m.needsProxy || rt.forceProxy || rt.proxyUrl || m.isImage) return;
  reprobing.add(mediaId);
  try {
    if ((await probePlayable(m.url)) !== false) return;
    console.warn('media: плеер не смог открыть', m.name, '— переход на прокси');
    startProxy(mediaId);
  } finally { reprobing.delete(mediaId); }
}
// remux (0.4.1, H3): кодек окно декодирует, мешает только контейнер (MKV, TS, AVI…) — Rust перекладывает поток в MP4
// без перекодирования (секунды, качество исходника). Если и такой файл не заиграет — обычный прокси (noRemux).
async function startProxy(mediaId, { noRemux = false } = {}) {
  const m = store.media(mediaId);
  // Уже MP4/MOV/WebM — значит не играет кодек (декодер), ремукс не поможет (то же проверяет ff.rs remux_ok)
  const mp4like = /\.(mp4|m4v|mov|webm)$/i.test(m.path || '');
  const remux = !noRemux && !mp4like && !!m.hasVideo && !m.isAnimation && !!contentType(m) && await codecSupported(m);
  store.setRuntime(mediaId, { forceProxy: !m.needsProxy, status: 'proxy', progress: 0, remuxed: false, proxyUrl: null });
  return api.proxy({ ...m, remux }).then((url) => store.setRuntime(mediaId, { proxyUrl: url, status: 'ready', remuxed: /proxy\.remux\.mp4$/i.test(decodeURIComponent(url || '')) }))
    .catch((e) => { store.setRuntime(mediaId, { status: 'error', error: errText(e) }); toast(t('Не удалось подготовить {name}', { name: m.name }), 'error'); });
}

// Сколько звуковых потоков в файле (записи NVIDIA/OBS: игра, микрофон…)
export const streamCount = (m) => (m && m.hasAudio ? Math.max(1, (m.audioStreams || []).length) : 0);

// Адрес для проигрывания звукового потока N: первый поток играет из самого файла, остальные — из извлечённого
export function audioUrl(mediaId, stream = 0) {
  if (!stream) return playUrl(mediaId);
  const rt = store.runtime[mediaId] || {};
  return rt.missing ? null : (rt.streamUrl || {})[stream] || null;
}

// Один канал потока (клип «разложен по каналам», 0.5.1): моно-файл в кэше делается по первому запросу.
// null — ещё готовится (плеер пока молчит у этого клипа), по готовности — событие media (runtime).
// Задания: job -> { status: 'run' | 'error', at }. Готовое задание удаляется (адрес — в runtime): после сброса runtime
// (открыт другой проект, восстановление автосохранения) файл канала запрашивается снова (из кэша — мгновенно).
const chanJobs = new Map();
const CHAN_RETRY_MS = 30000;
export function channelUrl(mediaId, stream = 0, ch = 0) {
  const rt = store.runtime[mediaId] || {};
  if (rt.missing) return null;
  const k = `${stream}:${ch}`;
  const have = (rt.channelUrl || {})[k];
  if (have) return have;
  const m = store.media(mediaId);
  const job = `${mediaId}|${k}`;
  const j = chanJobs.get(job);
  if (m && (!j || (j.status === 'error' && Date.now() - j.at > CHAN_RETRY_MS))) {
    const rec = { status: 'run', at: Date.now() };
    chanJobs.set(job, rec);
    api.audioStream(m, stream, ch).then((url) => {
      chanJobs.delete(job);
      const r = store.runtime[mediaId] || {};
      store.setRuntime(mediaId, { channelUrl: { ...(r.channelUrl || {}), [k]: url } });
    }).catch((e) => {
      if (!j) console.warn('audio channel', k, errText(e));   // в журнал — один раз, повторы молча
      Object.assign(rec, { status: 'error', at: Date.now() });
    });
  }
  return null;
}
/** Состояние файла канала для значка плеера: 'pending' | 'error' | null (готов или не нужен) */
export function channelState(mediaId, stream = 0, ch = 0) {
  const j = chanJobs.get(`${mediaId}|${stream}:${ch}`);
  return j ? (j.status === 'error' ? 'error' : 'pending') : null;
}

// Волна потока N: { rate, data, channels? }
export function peaksOf(mediaId, stream = 0) {
  const rt = store.runtime[mediaId] || {};
  return stream ? (rt.streamPeaks || {})[stream] || null : rt.peaks || null;
}

// Фоновая подготовка: миниатюры, волна, прокси
export function prepareMedia(mediaId) { return prepare(mediaId); }
async function prepare(mediaId) {
  const m = store.media(mediaId);
  if (!m) return;
  const jobs = [];
  if (m.hasVideo) {
    jobs.push(api.thumbs(m).then((t) => store.setRuntime(mediaId, { thumbs: t }))
      .catch((e) => console.warn('thumbs', e)));
  }
  if (m.hasAudio) {
    jobs.push(api.peaks(m).then((p) => store.setRuntime(mediaId, { peaks: p }))
      .catch((e) => console.warn('peaks', e)));
    for (let s = 1; s < streamCount(m); s++) {
      jobs.push(api.peaks(m, s).then((p) => {
        const rt = store.runtime[mediaId] || {};
        store.setRuntime(mediaId, { streamPeaks: { ...(rt.streamPeaks || {}), [s]: p } });
      }).catch((e) => console.warn('peaks', s, e)));
      jobs.push(api.audioStream(m, s).then((url) => {
        const rt = store.runtime[mediaId] || {};
        store.setRuntime(mediaId, { streamUrl: { ...(rt.streamUrl || {}), [s]: url } });
      }).catch((e) => console.warn('audio stream', s, e)));
    }
  }
  if (m.needsProxy || !(await checkPlayable(mediaId))) {
    jobs.push(startProxy(mediaId));
  } else {
    store.setRuntime(mediaId, { status: 'ready' });
  }
  await Promise.all(jobs);
}

api.onProxyProgress(({ key, fraction }) => {
  const m = Object.values(store.project.media).find((x) => x.key === key);
  if (m) store.setRuntime(m.id, { progress: fraction });
});

// Картинка (JPG/PNG/WebP…): один кадр, клип можно растянуть на сколько угодно (до часа), по умолчанию 5 с.
export const IMAGE_MAX = 3600;
export const IMAGE_DEFAULT = 5;
function normalizeInfo(info) {
  if (info.isImage && !info.isAnimation) { info.duration = IMAGE_MAX; info.hasAudio = false; }
  return info;
}

// Импорт файлов по путям. Возвращает id добавленных медиа.
export async function importPaths(paths) {
  const ids = [];
  for (const p of paths) {
    try {
      const info = normalizeInfo(await api.probe(p));
      if (!info.hasVideo && !info.hasAudio) { toast(t('{name}: нет видео и звука', { name: info.name }), 'error'); continue; }
      if (!(info.duration > 0)) { toast(t('{name}: не удалось определить длительность', { name: info.name }), 'error'); continue; }
      const id = store.addMedia(info);
      ids.push(id);
      prepare(id);
    } catch (e) {
      toast(t('Не удалось открыть файл: {name}', { name: p.split(/[\\/]/).pop() }), 'error', 5000);
      console.error(e);
    }
  }
  return ids;
}

export async function pickAndImport() {
  const paths = await api.pickMedia();
  if (paths.length) return importPaths(paths);
  return [];
}

// При открытии проекта: перепроверить файлы и подготовить кэш
export async function restoreMedia() {
  store.runtime = {};
  const all = Object.values(store.project.media);
  const keep = (m, info) => Object.assign(m, normalizeInfo(info), { id: m.id, hidden: m.hidden, derived: m.derived, anim: m.anim, name: m.anim ? m.name : normalizeInfo(info).name });
  // Сначала исходные файлы
  await Promise.all(all.filter((m) => !m.derived).map(async (m) => {
    try {
      const info = await api.probe(m.path);
      // Файл мог измениться — обновляем сведения, но сохраняем id
      keep(m, info);
      prepare(m.id);
    } catch {
      store.setRuntime(m.id, { missing: true, status: 'missing' });
    }
  }));
  // Потом сделанные программой (реверс, стоп-кадр): если кэш очистили — пересоздаём
  await Promise.all(all.filter((m) => m.derived).map(async (m) => {
    try {
      keep(m, await api.probe(m.path));
      prepare(m.id);
    } catch {
      store.setRuntime(m.id, { status: 'rebuild' });
      try {
        const info = await rebuildDerived(m);
        keep(m, info);
        store.setRuntime(m.id, { status: 'ready', missing: false });
        prepare(m.id);
      } catch (e) {
        store.setRuntime(m.id, { missing: true, status: 'missing' });
        console.warn('rebuild derived', e);
      }
    }
  }));
  store.emit('project');
}

// ---------------------------------------------------------------------------
// Панель медиа
// ---------------------------------------------------------------------------
let onAddToTimeline = null;
export function initMediaPanel({ addToTimeline }) {
  onAddToTimeline = addToTimeline;
  const panel = $('#media-panel');
  panel.append(
    h('div', { class: 'panel-head' }, h('h2', {}, t('Ваши медиа'))),
    h('button', { class: 'btn primary wide', id: 'btn-import', onclick: () => pickAndImport() },
      iconEl('upload', 18), t('Импорт медиа')),
    h('div', { class: 'media-grid', id: 'media-grid' }),
  );
  store.on('project', renderGrid);
  store.on('media', renderGrid);
  renderGrid();
}

function renderGrid() {
  const grid = $('#media-grid');
  if (!grid) return;
  const items = Object.values(store.project.media).filter((m) => !m.hidden);
  grid.innerHTML = '';
  if (!items.length) {
    grid.append(h('div', { class: 'media-empty' },
      iconEl('media', 40),
      h('p', {}, t('Перетащите сюда видео и музыку')),
      h('p', { class: 'muted small' }, t('или нажмите «Импорт медиа». Записи NVIDIA (H.264, HEVC, AV1) открываются как есть.'))));
    return;
  }
  for (const m of items) grid.append(card(m));
}

function card(m) {
  const rt = store.runtime[m.id] || {};
  const used = store.usageCount(m.id);
  const thumb = h('div', { class: 'media-thumb' });
  if (m.hasVideo && rt.thumbs && rt.thumbs.urls.length) {
    const idx = Math.min(rt.thumbs.urls.length - 1, Math.floor(rt.thumbs.urls.length * 0.15));
    thumb.append(h('img', { src: rt.thumbs.urls[idx], draggable: 'false' }));
  } else if (!m.hasVideo) {
    thumb.classList.add('audio');
    thumb.append(iconEl('music', 34));
  } else {
    thumb.append(h('div', { class: 'spinner' }));
  }
  thumb.append(h('span', { class: 'badge dur' }, m.isImage && !m.isAnimation ? t('фото') : m.isAnimation ? `GIF ${fmtTime(m.duration, { ms: false })}` : fmtTime(m.duration, { ms: false })));
  if (used) thumb.append(h('span', { class: 'badge used', title: t('Используется на таймлайне') }, `${used}×`));
  if (rt.status === 'proxy') {
    thumb.append(h('div', { class: 'media-progress' },
      h('div', { class: 'bar', style: { width: `${Math.round((rt.progress || 0) * 100)}%` } }),
      h('span', {}, t('Подготовка {p}%', { p: Math.round((rt.progress || 0) * 100) }))));
  }
  if (rt.missing) thumb.append(h('div', { class: 'media-missing' }, iconEl('warning', 18), t('Файл не найден')));

  const add = h('button', { class: 'icon-btn add', title: t('Добавить на таймлайн'), onclick: (e) => { e.stopPropagation(); onAddToTimeline(m.id); } });
  add.innerHTML = iconEl('plus', 18).innerHTML;
  const del = h('button', {
    class: 'icon-btn del', title: t('Убрать из проекта'),
    onclick: async (e) => {
      e.stopPropagation();
      if (used && !(await confirmDialog(t('Убрать файл из проекта?'), t('Файл используется на таймлайне ({n}×). Клипы с ним тоже будут удалены. Сам файл на диске не трогается.', { n: used }), t('Убрать'), t('Отмена'), true))) return;
      store.removeMedia(m.id);
    },
  });
  del.innerHTML = iconEl('close', 16).innerHTML;
  thumb.append(add, del);

  const details = [m.hasVideo ? `${m.width}×${m.height}` : null, m.hasVideo && m.fps ? `${Math.round(m.fps)} fps` : null,
    (m.vcodec || m.acodec || '').toUpperCase(), fmtBytes(m.size)].filter(Boolean).join(' · ');
  const el = h('div', {
    class: `media-card${rt.missing ? ' missing' : ''}`,
    title: `${m.path}\n${details}`,
    ondblclick: () => onAddToTimeline(m.id),
  }, thumb, h('div', { class: 'media-name' }, m.name), h('div', { class: 'media-meta' }, details));
  if (!rt.missing) el.addEventListener('pointerdown', (e) => startMediaDrag(e, m, rt));
  return el;
}

// Перетаскивание карточки на таймлайн (указателем: в Tauri HTML5 drag&drop занят файлами из Проводника)
function startMediaDrag(e, m, rt) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const x0 = e.clientX; const y0 = e.clientY;
  let ghost = null;
  const tl = () => window.__ffm && window.__ffm.timeline;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      const img = m.hasVideo && rt.thumbs && rt.thumbs.urls.length ? h('img', { src: rt.thumbs.urls[Math.floor(rt.thumbs.urls.length * 0.15)] }) : null;
      ghost = h('div', { class: 'media-ghost' }, img, h('span', {}, m.name));
      document.body.append(ghost);
      document.body.classList.add('dragging-media');
      window.__ffmDragMedia = m.id;
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    if (tl()) tl().dragHover(ev.clientX, ev.clientY, m.id);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove('dragging-media');
    window.__ffmDragMedia = null;
    if (tl()) {
      if (ev.type === 'pointerup') tl().dropAt(ev.clientX, ev.clientY, { ids: [m.id], alt: ev.altKey });
      else tl().dragLeave();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
