// Импорт файлов, подготовка миниатюр/волны/прокси и панель «Ваши медиа».
import { store } from './store.js';
import { h, $, fmtTime, toast, iconEl, confirmDialog, fmtBytes } from './util.js';
import { rebuildDerived } from './fx.js';

const api = window.api;

export function playUrl(mediaId) {
  const m = store.media(mediaId);
  const rt = store.runtime[mediaId] || {};
  if (!m || rt.missing) return null;
  if (rt.proxyUrl) return rt.proxyUrl;
  return m.needsProxy ? null : m.url;
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
  }
  if (m.needsProxy) {
    store.setRuntime(mediaId, { status: 'proxy', progress: 0 });
    jobs.push(api.proxy(m).then((url) => store.setRuntime(mediaId, { proxyUrl: url, status: 'ready' }))
      .catch((e) => { store.setRuntime(mediaId, { status: 'error', error: e.message }); toast(`Не удалось подготовить ${m.name}`, 'error'); }));
  } else {
    store.setRuntime(mediaId, { status: 'ready' });
  }
  await Promise.all(jobs);
}

api.onProxyProgress(({ key, fraction }) => {
  const m = Object.values(store.project.media).find((x) => x.key === key);
  if (m) store.setRuntime(m.id, { progress: fraction });
});

// Импорт файлов по путям. Возвращает id добавленных медиа.
export async function importPaths(paths) {
  const ids = [];
  for (const p of paths) {
    try {
      const info = await api.probe(p);
      if (!info.hasVideo && !info.hasAudio) { toast(`${info.name}: нет видео и звука`, 'error'); continue; }
      if (!(info.duration > 0)) { toast(`${info.name}: не удалось определить длительность`, 'error'); continue; }
      const id = store.addMedia(info);
      ids.push(id);
      prepare(id);
    } catch (e) {
      toast(`Не удалось открыть файл: ${p.split(/[\\/]/).pop()}`, 'error', 5000);
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
  const keep = (m, info) => Object.assign(m, info, { id: m.id, hidden: m.hidden, derived: m.derived });
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
    h('div', { class: 'panel-head' }, h('h2', {}, 'Ваши медиа')),
    h('button', { class: 'btn primary wide', id: 'btn-import', onclick: () => pickAndImport() },
      iconEl('upload', 18), 'Импорт медиа'),
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
      h('p', {}, 'Перетащите сюда видео и музыку'),
      h('p', { class: 'muted small' }, 'или нажмите «Импорт медиа». Записи NVIDIA (H.264, HEVC, AV1) открываются как есть.')));
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
  thumb.append(h('span', { class: 'badge dur' }, fmtTime(m.duration, { ms: false })));
  if (used) thumb.append(h('span', { class: 'badge used', title: 'Используется на таймлайне' }, `${used}×`));
  if (rt.status === 'proxy') {
    thumb.append(h('div', { class: 'media-progress' },
      h('div', { class: 'bar', style: { width: `${Math.round((rt.progress || 0) * 100)}%` } }),
      h('span', {}, `Подготовка ${Math.round((rt.progress || 0) * 100)}%`)));
  }
  if (rt.missing) thumb.append(h('div', { class: 'media-missing' }, iconEl('warning', 18), 'Файл не найден'));

  const add = h('button', { class: 'icon-btn add', title: 'Добавить на таймлайн', onclick: (e) => { e.stopPropagation(); onAddToTimeline(m.id); } });
  add.innerHTML = iconEl('plus', 18).innerHTML;
  const del = h('button', {
    class: 'icon-btn del', title: 'Убрать из проекта',
    onclick: async (e) => {
      e.stopPropagation();
      if (used && !(await confirmDialog('Убрать файл из проекта?', `Файл используется на таймлайне (${used}×). Клипы с ним тоже будут удалены. Сам файл на диске не трогается.`, 'Убрать', 'Отмена', true))) return;
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
      if (ev.type === 'pointerup') tl().dropAt(ev.clientX, ev.clientY, { ids: [m.id] });
      else tl().dragLeave();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
