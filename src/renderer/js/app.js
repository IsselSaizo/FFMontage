// Точка входа интерфейса: собирает панели, горячие клавиши, сохранение проекта.
import { store, emptyProject } from './store.js';
import { $, h, icon, toast, confirmDialog, debounce } from './util.js';
import { initMediaPanel, importPaths, pickAndImport, restoreMedia } from './media.js';
import { Preview, initTransport } from './preview.js';
import { Timeline } from './timeline.js';
import { initInspector } from './inspector.js';
import { initBrowser } from './browser.js';
import { openExport } from './exportDialog.js';
import { copyClip, pasteClip, reverseClip, freezeFrame } from './actions.js';
import { closeMenu, menuOpen } from './contextMenu.js';

// Мост для ИИ-ассистента грузим отдельно: если с ним что-то не так, редактор всё равно запустится
const mcpReady = import('./mcpBridge.js').catch((e) => { console.error('mcpBridge', e); return null; });
const showMcpDialog = async () => { const m = await mcpReady; if (m) m.showMcpDialog(); else toast('Модуль ИИ-ассистента не загрузился', 'error'); };

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
    item('Настройки папок…', '', () => api.openSettings()),
    item('ИИ-ассистент (MCP)…', '', () => showMcpDialog()),
    h('div', { class: 'dd-sep' }),
    item('Проверить обновления…', '', () => checkUpdates()),
    item('О программе', '', about));
  function item(label, key, fn) {
    return h('button', { class: 'dd-item', onclick: () => { menu.classList.remove('open'); fn(); } }, h('span', {}, label), h('kbd', {}, key));
  }
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open'); });

  const saved = h('span', { class: 'save-state', id: 'save-state', 'data-tauri-drag-region': '' });
  // Рамка окна своя: перетаскивание за пустое место панели, двойной щелчок — развернуть
  const maxBtn = h('button', { title: 'Развернуть', onclick: () => api.winToggleMaximize() });
  const updMax = async () => {
    const m = await api.winIsMaximized().catch(() => false);
    maxBtn.innerHTML = icon(m ? 'wrestore' : 'wmax', 11);
    maxBtn.title = m ? 'Свернуть в окно' : 'Развернуть';
  };
  updMax();
  api.onWinResize(updMax);
  bar.setAttribute('data-tauri-drag-region', '');
  bar.append(
    h('div', { class: 'tb-left', 'data-tauri-drag-region': '' },
      h('div', { class: 'logo', html: icon('logo', 26), 'data-tauri-drag-region': '' }),
      h('span', { class: 'app-name', 'data-tauri-drag-region': '' }, 'FF Montage'),
      h('div', { class: 'menu-wrap' }, menuBtn, menu),
      nameInput, saved),
    h('div', { class: 'tb-drag', 'data-tauri-drag-region': '' }),
    h('div', { class: 'tb-right' },
      h('button', { class: 'btn primary export-btn', onclick: () => openExport() }, h('span', { html: icon('export', 18) }), 'Экспорт'),
      h('div', { class: 'win-ctl' },
        h('button', { title: 'Свернуть', html: icon('wmin', 11), onclick: () => api.winMinimize() }),
        maxBtn,
        h('button', { class: 'close', title: 'Закрыть', html: icon('wclose', 11), onclick: () => api.winClose() }))));
}

// ---------------------------------------------------------------------------
// Обновления: git-клон — git fetch/pull (+ пересборка), готовая сборка — последний релиз GitHub
// ---------------------------------------------------------------------------
async function checkUpdates() {
  const overlay = h('div', { class: 'modal-overlay' });
  const body = h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, 'Проверяю…'));
  const foot = h('div', { class: 'modal-foot' });
  const close = () => overlay.remove();
  overlay.append(h('div', { class: 'modal small', style: { width: '560px' } },
    h('div', { class: 'modal-head' }, h('h2', {}, 'Обновления'), h('button', { class: 'icon-btn', html: icon('close', 18), onclick: close })),
    body, foot));
  document.body.append(overlay);
  const closeBtn = h('button', { class: 'btn ghost', onclick: close }, 'Закрыть');
  let r;
  try { r = await api.updateCheck(); } catch (e) {
    body.innerHTML = '';
    body.append(h('p', {}, 'Не удалось проверить обновления.'), h('pre', { class: 'error-box' }, String(e)));
    foot.append(closeBtn);
    return;
  }
  body.innerHTML = '';
  const logBox = h('div', { class: 'update-log', style: { display: 'none' } });
  const apply = h('button', { class: 'btn primary' }, h('span', { html: icon('refresh', 17) }), 'Обновить');
  apply.addEventListener('click', async () => {
    apply.disabled = true; closeBtn.disabled = true;
    logBox.style.display = '';
    const off = api.onUpdateLog(({ text }) => { logBox.textContent += `${text}\n`; logBox.scrollTop = 1e9; });
    if (store.dirty) await saveProject(false).catch(() => {});
    try {
      const res = await api.updateApply();
      logBox.textContent += `${res.message || 'Готово.'}\n`;
    } catch (e) {
      logBox.textContent += `Ошибка: ${e}\n`;
    }
    off(); closeBtn.disabled = false;
  });
  if (r.mode === 'git') {
    body.append(
      h('p', {}, `Версия ${r.current} · git-клон, ветка ${r.branch} (${r.head})`),
      r.behind
        ? h('p', {}, `Доступно новых изменений: ${r.behind}`)
        : h('p', { class: 'muted' }, 'У вас последняя версия.'),
      r.commits && r.commits.length ? h('pre', { class: 'update-log' }, r.commits.join('\n')) : null,
      r.ahead ? h('p', { class: 'muted small' }, `Локальных коммитов, которых нет на GitHub: ${r.ahead}`) : null,
      r.dirty ? h('p', { class: 'muted small' }, 'Есть изменённые файлы — git pull может отказаться обновлять. Сохраните или откатите их.') : null,
      r.behind && !r.cargo ? h('p', { class: 'muted small' }, 'Rust (cargo) не найден: исходники обновятся, но программу нужно будет пересобрать или скачать готовую сборку.') : null,
      logBox);
  } else {
    body.append(
      h('p', {}, `Установлена версия ${r.current}. Последний релиз: ${r.latest || '—'}`),
      r.available ? h('p', {}, `Будет скачан ${r.asset.name}. Настройки и проекты не затрагиваются.`)
        : h('p', { class: 'muted' }, r.newer ? 'Для этой системы в релизе нет готовой сборки.' : 'У вас последняя версия.'),
      r.notes ? h('pre', { class: 'update-log' }, r.notes) : null,
      logBox);
  }
  foot.append(closeBtn);
  if (r.available) foot.append(apply);
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
          h('p', {}, `Версия ${i.version} · Tauri ${i.tauri} · WebView ${i.webview}`),
          h('p', { class: 'muted small' }, i.ffmpegVersion || 'FFmpeg не найден!'),
          h('p', { class: 'muted small' }, `FFmpeg: ${i.ffmpeg}`),
          h('p', { class: 'muted small' }, `Кэш: ${i.cacheDir}`),
          h('p', { class: 'muted small' }, `Экспорт: ${i.outputDir}`),
          h('p', { class: 'muted small' }, `Проекты: ${i.projectsDir}`),
          h('p', { class: 'muted small' }, `Настройки: ${i.configFile}`))));
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
    if (menuOpen()) { if (e.key !== 'Escape' && !e.key.startsWith('Arrow')) closeMenu(); else return; }
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
    const clipSel = store.selection && store.selection.kind !== 'transition' ? store.selection.id : null;
    if (ctrl && code === 'KeyD') { e.preventDefault(); if (clipSel) store.duplicateClip(clipSel); return; }
    if (ctrl && code === 'KeyC') { e.preventDefault(); if (clipSel) copyClip(clipSel); return; }
    if (ctrl && code === 'KeyV') { e.preventDefault(); pasteClip(store.time); return; }
    if (ctrl && (code === 'Digit0' || code === 'Numpad0')) { e.preventDefault(); timeline.autoFit = true; timeline.fit(); return; }
    if (ctrl && (k === '=' || k === '+' || code === 'NumpadAdd')) { e.preventDefault(); timeline.setZoom(timeline.pps * 1.4, null, true); return; }
    if (ctrl && (k === '-' || code === 'NumpadSubtract')) { e.preventDefault(); timeline.setZoom(timeline.pps / 1.4, null, true); return; }
    if (ctrl) return;

    const step = 1 / (store.sourceFormat().fps || 30);
    switch (code) {
      case 'Space': e.preventDefault(); preview.toggle(); break;
      case 'KeyK': preview.toggle(); break;
      // S — разрезать выделенный клип (или видео под курсором); Alt+S — всё под курсором: видео и звук
      case 'KeyS': e.preventDefault(); if (e.altKey) timeline.splitAllAction(); else timeline.splitAction(); break;
      case 'KeyB': timeline.setTool(timeline.tool === 'blade' ? 'select' : 'blade'); break;
      case 'KeyA': timeline.setTool('select'); break;
      case 'Delete': case 'Backspace': timeline.deleteAction(e.shiftKey); break;
      case 'KeyR': if (clipSel) reverseClip(clipSel); break;
      case 'ArrowLeft': e.preventDefault(); store.setTime(store.time - (e.shiftKey ? 1 : step)); break;
      case 'ArrowRight': e.preventDefault(); store.setTime(store.time + (e.shiftKey ? 1 : step)); break;
      case 'KeyJ': store.setTime(store.time - 5); break;
      case 'KeyL': store.setTime(store.time + 5); break;
      case 'Home': store.setTime(0); break;
      case 'End': store.setTime(store.duration()); break;
      case 'KeyF': if (e.shiftKey) preview.fullscreen(); else freezeFrame(store.time); break;
      case 'Escape': if (timeline.tool === 'blade') timeline.setTool('select'); else store.select(null); break;
      default: break;
    }
  });
}

// Файлы из Проводника, брошенные на окно (не на таймлайн) — просто импорт
function initWindowDrop() {
  const shade = h('div', { class: 'drop-shade' }, h('div', {}, h('span', { html: icon('upload', 40) }), h('p', {}, 'Отпустите, чтобы импортировать')));
  document.body.append(shade);
  // Над таймлайном — маркер места вставки, в остальной части окна — затемнение «импорт»
  api.onFileDrop(async ({ type, paths, x, y }) => {
    if (type === 'enter' || type === 'over') {
      const onTl = timeline.dragHover(x, y);
      shade.classList.toggle('on', !onTl);
      return;
    }
    shade.classList.remove('on');
    if (type !== 'drop') { timeline.dragLeave(); return; }
    if (!paths.length) return;
    if (await timeline.dropAt(x, y, { paths })) return;
    const ids = await importPaths(paths);
    if (ids.length) toast(`Импортировано файлов: ${ids.length}`, 'success', 2000);
  });
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
  const browser = initBrowser();
  initKeys();
  initWindowDrop();
  store.on('request-pause', () => preview.pause());
  store.on('project', () => { autosave(); updateTitle(); });
  initResizers();
  await restoreAutosave();
  updateTitle();
  window.__ffm = { store, preview, timeline, importPaths, openExport, browser };
  const bridge = await mcpReady;
  if (bridge) bridge.initMcpBridge({
    loadProjectText: (text, filePath) => loadFromText(text, filePath),
    newProject: (name) => {
      store.load(emptyProject(), null);
      if (name) { store.project.name = name; store.emit('project'); }
      store.runtime = {};
      timeline.autoFit = true; timeline.fit();
      updateTitle();
    },
    saveProject: async (filePath) => {
      const p = await api.saveProject({ filePath: filePath || store.filePath, text: store.serialize(), suggested: store.project.name });
      if (p) { store.filePath = p; store.dirty = false; updateTitle(); autosave(); }
      return p;
    },
  });
  document.body.classList.add('ready');
  const info = await api.info();
  if (info.ffmpegMissing || !info.ffmpegVersion) {
    toast('FFmpeg не найден — без него не будет миниатюр и экспорта. Укажите папку: меню ☰ → «Настройки папок».', 'error', 15000);
  }
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
