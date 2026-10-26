// Точка входа интерфейса: собирает панели, горячие клавиши, сохранение проекта.
import { store, emptyProject } from './store.js';
import { $, h, icon, toast, confirmDialog, debounce } from './util.js';
import { initMediaPanel, importPaths, pickAndImport, restoreMedia } from './media.js';
import { Preview, initTransport } from './preview.js';
import { Timeline } from './timeline.js';
import { initInspector } from './inspector.js';
import { openExport } from './exportDialog.js';

const api = window.api;
let preview; let timeline; let transport;

// ---------------------------------------------------------------------------
// Верхняя панель
// ---------------------------------------------------------------------------
function initTopbar() {
  const bar = $('#topbar');
  const nameInput = h('input', { class: 'project-name', value: store.project.name, spellcheck: 'false', title: 'Название проекта' });
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim() || 'Мой ролик';
    store.mutate((p) => { p.name = v; });
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
  store.on('project', () => { if (document.activeElement !== nameInput) nameInput.value = store.project.name; updateTitle(); });

  const menuBtn = h('button', { class: 'icon-btn', title: 'Меню', html: icon('menu', 20) });
  const menu = h('div', { class: 'dropdown' },
    item('Новый проект', 'Ctrl+N', newProject),
    item('Открыть проект…', 'Ctrl+O', openProject),
    item('Сохранить', 'Ctrl+S', () => saveProject(false)),
    item('Сохранить как…', 'Ctrl+Shift+S', () => saveProject(true)),
    h('div', { class: 'dd-sep' }),
    item('Импорт медиа…', 'Ctrl+I', () => pickAndImport()),
    item('Открыть папку экспорта', '', async () => api.openPath((await api.info()).outputDir)),
    h('div', { class: 'dd-sep' }),
    item('О программе', '', about));
  function item(label, key, fn) {
    return h('button', { class: 'dd-item', onclick: () => { menu.classList.remove('open'); fn(); } }, h('span', {}, label), h('kbd', {}, key));
  }
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open'); });

  const saved = h('span', { class: 'save-state', id: 'save-state' });
  bar.append(
    h('div', { class: 'tb-left' },
      h('div', { class: 'logo', html: icon('logo', 26) }),
      h('span', { class: 'app-name' }, 'FF Montage'),
      h('div', { class: 'menu-wrap' }, menuBtn, menu),
      nameInput, saved),
    h('div', { class: 'tb-right' },
      h('button', { class: 'btn primary export-btn', onclick: () => openExport() }, h('span', { html: icon('export', 18) }), 'Экспорт')));
}

function updateTitle() {
  const name = store.project.name || 'Мой ролик';
  api.setTitle(`${name}${store.dirty ? ' •' : ''} — FF Montage`);
  const s = $('#save-state');
  if (s) s.textContent = store.filePath ? (store.dirty ? 'Есть несохранённые изменения' : 'Сохранено') : 'Автосохранение';
}

// ---------------------------------------------------------------------------
// Проект: сохранение, открытие, автосохранение
// ---------------------------------------------------------------------------
async function saveProject(as) {
  const p = await api.saveProject({ filePath: as ? null : store.filePath, text: store.serialize(), suggested: store.project.name });
  if (p) { store.filePath = p; store.dirty = false; updateTitle(); autosave(); toast('Проект сохранён', 'success', 2000); }
}

async function loadFromText(text, filePath) {
  const j = JSON.parse(text);
  const project = j.project || j;
  if (!project.videoClips || !project.audioTracks) throw new Error('Это не проект FF Montage');
  store.load(project, filePath);
  await restoreMedia();
  timeline.autoFit = true; timeline.fit();
  updateTitle();
}

async function openProject() {
  if (store.dirty && store.filePath && !(await confirmDialog('Открыть другой проект?', 'Несохранённые изменения текущего проекта будут потеряны (автосохранение тоже перезапишется).', 'Открыть'))) return;
  const r = await api.openProject();
  if (!r) return;
  try { await loadFromText(r.text, r.filePath); toast('Проект открыт', 'success', 2000); } catch (e) { toast(`Не удалось открыть проект: ${e.message}`, 'error', 5000); }
}

async function newProject() {
  const hasContent = store.duration() > 0 || Object.keys(store.project.media).length;
  if (hasContent && !(await confirmDialog('Новый проект?', store.filePath && !store.dirty
    ? 'Текущий проект сохранён, его можно будет открыть снова.'
    : 'Текущий проект не сохранён в файл и будет закрыт. Сохраните его (Ctrl+S), если он ещё нужен.', 'Создать', 'Отмена', !store.filePath || store.dirty))) return;
  store.load(emptyProject(), null);
  store.runtime = {};
  timeline.autoFit = true; timeline.fit();
  updateTitle();
}

const autosave = debounce(() => {
  api.autosaveWrite(JSON.stringify({ filePath: store.filePath, dirty: store.dirty, data: store.serialize() })).catch(() => {});
}, 1200);

async function restoreAutosave() {
  try {
    const raw = await api.autosaveRead();
    if (!raw) return;
    const a = JSON.parse(raw);
    await loadFromText(a.data, a.filePath || null);
    store.dirty = !!a.dirty;
    updateTitle();
  } catch (e) {
    console.warn('autosave restore failed', e);
  }
}

function about() {
  api.info().then((i) => {
    const overlay = h('div', { class: 'modal-overlay' },
      h('div', { class: 'modal small' },
        h('div', { class: 'modal-head' }, h('h2', {}, 'FF Montage'), h('button', { class: 'icon-btn', html: icon('close', 18), onclick: () => overlay.remove() })),
        h('div', { class: 'modal-body' },
          h('p', {}, `Версия ${i.version} · Electron ${i.electron}`),
          h('p', { class: 'muted small' }, i.ffmpegVersion || 'FFmpeg не найден!'),
          h('p', { class: 'muted small' }, `FFmpeg: ${i.ffmpeg}`),
          h('p', { class: 'muted small' }, `Кэш: ${i.cacheDir}`),
          h('p', { class: 'muted small' }, `Экспорт: ${i.outputDir}`))));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.append(overlay);
  });
}

// ---------------------------------------------------------------------------
// Клавиатура
// ---------------------------------------------------------------------------
function initKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = (tag === 'input' && !['range', 'checkbox', 'button'].includes(e.target.type)) || tag === 'textarea' || tag === 'select';
    if (document.querySelector('.modal-overlay')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const code = e.code;

    if (ctrl && code === 'KeyS') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if (ctrl && code === 'KeyO') { e.preventDefault(); openProject(); return; }
    if (ctrl && code === 'KeyN') { e.preventDefault(); newProject(); return; }
    if (ctrl && code === 'KeyE') { e.preventDefault(); openExport(); return; }
    if (ctrl && code === 'KeyI') { e.preventDefault(); pickAndImport(); return; }
    if (e.key === 'F12') { api.devtools(); return; }
    if (typing) return;

    if (ctrl && code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
    if (ctrl && (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
    if (ctrl && code === 'KeyD') { e.preventDefault(); if (store.selection) store.duplicateClip(store.selection.id); return; }
    if (ctrl && (code === 'Digit0' || code === 'Numpad0')) { e.preventDefault(); timeline.autoFit = true; timeline.fit(); return; }
    if (ctrl && (k === '=' || k === '+' || code === 'NumpadAdd')) { e.preventDefault(); timeline.setZoom(timeline.pps * 1.4, null, true); return; }
    if (ctrl && (k === '-' || code === 'NumpadSubtract')) { e.preventDefault(); timeline.setZoom(timeline.pps / 1.4, null, true); return; }
    if (ctrl) return;

    const step = 1 / (store.sourceFormat().fps || 30);
    switch (code) {
      case 'Space': e.preventDefault(); preview.toggle(); break;
      case 'KeyK': preview.toggle(); break;
      case 'KeyS': timeline.splitAction(); break;
      case 'Delete': case 'Backspace': timeline.deleteAction(); break;
      case 'ArrowLeft': e.preventDefault(); store.setTime(store.time - (e.shiftKey ? 1 : step)); break;
      case 'ArrowRight': e.preventDefault(); store.setTime(store.time + (e.shiftKey ? 1 : step)); break;
      case 'KeyJ': store.setTime(store.time - 5); break;
      case 'KeyL': store.setTime(store.time + 5); break;
      case 'Home': store.setTime(0); break;
      case 'End': store.setTime(store.duration()); break;
      case 'KeyF': preview.fullscreen(); break;
      case 'Escape': store.select(null); break;
      default: break;
    }
  });
}

// Файлы из Проводника, брошенные на окно (не на таймлайн) — просто импорт
function initWindowDrop() {
  const shade = h('div', { class: 'drop-shade' }, h('div', {}, h('span', { html: icon('upload', 40) }), h('p', {}, 'Отпустите, чтобы импортировать')));
  document.body.append(shade);
  let depth = 0;
  const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFiles(e)) { depth++; shade.classList.add('on'); } });
  window.addEventListener('dragleave', (e) => { if (isFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) shade.classList.remove('on'); } });
  window.addEventListener('dragover', (e) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', async (e) => {
    depth = 0; shade.classList.remove('on');
    if (!isFiles(e)) return;
    e.preventDefault();
    const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) {
      const ids = await importPaths(paths);
      if (ids.length) toast(`Импортировано файлов: ${ids.length}`, 'success', 2000);
    }
  });
  // таймлайн обрабатывает drop сам — гасим подсветку
  document.addEventListener('drop', () => { depth = 0; shade.classList.remove('on'); }, true);
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
async function main() {
  initTopbar();
  timeline = new Timeline($('#timeline'));
  preview = new Preview($('#preview'));
  transport = initTransport(preview);
  initMediaPanel({ addToTimeline: (id) => timeline.addMedia(id) });
  initInspector({ onSplit: () => timeline.splitAction(), onDelete: () => timeline.deleteAction() });
  initKeys();
  initWindowDrop();
  store.on('request-pause', () => preview.pause());
  store.on('project', () => { autosave(); updateTitle(); });
  initResizers();
  await restoreAutosave();
  updateTitle();
  window.__ffm = { store, preview, timeline, importPaths, openExport };
  document.body.classList.add('ready');
}

// Перетаскиваемая граница между плеером и таймлайном
function initResizers() {
  const grip = $('#tl-resizer');
  const app = $('#app');
  const saved = Number(localStorage.getItem('ffm.tlHeight'));
  if (saved) app.style.setProperty('--tl-h', `${saved}px`);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = $('#timeline').offsetHeight;
    const move = (ev) => {
      const v = Math.max(170, Math.min(window.innerHeight - 300, start - (ev.clientY - startY)));
      app.style.setProperty('--tl-h', `${v}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      localStorage.setItem('ffm.tlHeight', String($('#timeline').offsetHeight));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

main().catch((e) => { console.error(e); toast(`Ошибка запуска: ${e.message}`, 'error', 10000); });
