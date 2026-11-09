// Точка входа интерфейса: собирает панели, горячие клавиши, сохранение проекта.
import { store, emptyProject } from './store.js';
import { $, h, icon, toast, confirmDialog, debounce, errText } from './util.js';
import { t } from './i18n.js';
import { bindAction, dispatchKey, keyHint, onKeymapChange } from './keymap.js';
import { initSettings, openSettings, maybeAskLanguage, getSetting } from './settings.js';
import { getPref, setPref, flushPrefs } from './prefs.js';
import { initMediaPanel, importPaths, pickAndImport, restoreMedia } from './media.js';
import { Preview, initTransport } from './preview.js';
import { Timeline } from './timeline.js';
import { initInspector } from './inspector.js';
import { initBrowser } from './browser.js';
import { initEpisodes } from './episodes.js';
import { openExport } from './exportDialog.js';
import { copyClip, pasteClip, reverseClip, freezeFrame } from './actions.js';
import { closeMenu, menuOpen } from './contextMenu.js';
import { initViewbar } from './viewbar.js';
import { initCropMode } from './cropMode.js';
import { initGizmo } from './gizmo.js';
import { initAudioRack } from './audioRack.js';
import { initAnim } from './anim.js';
import { modeTabs, initModes } from './modes.js';
import { closePopover, popoverOpen } from './popover.js';
import { initFonts } from './fonts.js';
import { initSubtitleOverlay, importSubtitles } from './subtitlesUi.js';
import { installDropped } from './vst.js';
import * as edit from './edit.js';
import { initShuttle } from './shuttle.js';
import { initTrimPreview } from './trimPreview.js';
import { initGamepad } from './gamepad.js';
import { initPopouts, onPopout, popOut, dock, poppedOut, setExperimental } from './popout.js';

// Мост для ИИ-ассистента грузим отдельно: если с ним что-то не так, редактор всё равно запустится
const mcpReady = import('./mcpBridge.js').catch((e) => { console.error('mcpBridge', e); return null; });
const showMcpDialog = async () => { const m = await mcpReady; if (m) m.showMcpDialog(); else toast(t('Модуль ИИ-ассистента не загрузился'), 'error'); };
// Хост плагинов — тоже отдельно: сбой в нём (или в плагине) не мешает запуску редактора
const pluginsReady = import('./plugins/host.js').catch((e) => { console.error('plugins host', e); return null; });
let pluginHost = null;

const api = window.api;
let preview; let timeline; let transport; let shuttle;

// ---------------------------------------------------------------------------
// Верхняя панель
// ---------------------------------------------------------------------------
function initTopbar() {
  const bar = $('#topbar');
  const nameInput = h('input', { class: 'project-name', value: store.project.name, spellcheck: 'false', title: t('Название проекта') });
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim() || t('Мой ролик');
    store.mutate((p) => { p.name = v; });
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
  store.on('project', () => { if (document.activeElement !== nameInput) nameInput.value = store.project.name; updateTitle(); });

  const menuBtn = h('button', { class: 'icon-btn', title: t('Меню'), html: icon('menu', 20) });
  const menu = h('div', { class: 'dropdown' },
    item(t('Новый проект'), 'project.new', newProject),
    item(t('Открыть проект…'), 'project.open', openProject),
    item(t('Сохранить'), 'project.save', () => saveProject(false)),
    item(t('Сохранить как…'), 'project.saveAs', () => saveProject(true)),
    h('div', { class: 'dd-sep' }),
    item(t('Импорт медиа…'), 'media.import', () => pickAndImport()),
    item(t('Открыть папку экспорта'), '', async () => api.openPath((await api.info()).outputDir)),
    h('div', { class: 'dd-sep' }),
    item(t('Настройки…'), 'app.settings', () => openSettings()),
    item(t('Горячие клавиши'), '', () => openSettings('hotkeys')),
    item(t('ИИ-ассистент (MCP)…'), '', () => showMcpDialog()),
    h('div', { class: 'dd-sep' }),
    item(t('Проверить обновления…'), '', () => checkUpdates()),
    item(t('О программе'), '', () => openSettings('about')));
  function item(label, action, fn) {
    const k = h('kbd', { dataset: { action } }, action ? keyHint(action) : '');
    return h('button', { class: 'dd-item', onclick: () => { menu.classList.remove('open'); fn(); } }, h('span', {}, label), k);
  }
  onKeymapChange(() => { for (const k of menu.querySelectorAll('kbd[data-action]')) k.textContent = k.dataset.action ? keyHint(k.dataset.action) : ''; });
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.classList.remove('open'); });

  const saved = h('span', { class: 'save-state', id: 'save-state', 'data-tauri-drag-region': '' });
  // Рамка окна своя: перетаскивание за пустое место панели, двойной щелчок — развернуть
  const maxBtn = h('button', { title: t('Развернуть'), onclick: () => api.winToggleMaximize() });
  const updMax = async () => {
    const m = await api.winIsMaximized().catch(() => false);
    maxBtn.innerHTML = icon(m ? 'wrestore' : 'wmax', 11);
    maxBtn.title = m ? t('Свернуть в окно') : t('Развернуть');
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
    h('div', { class: 'tb-center' }, modeTabs()),
    h('div', { class: 'tb-right' },
      h('button', { class: 'icon-btn', id: 'settings-btn', tip: [t('Настройки'), 'app.settings'], html: icon('gear', 19), onclick: () => openSettings() }),
      h('button', { class: 'btn primary export-btn', tip: [t('Экспорт'), 'export.open'], onclick: () => openExport() }, h('span', { html: icon('export', 18) }), t('Экспорт')),
      h('div', { class: 'win-ctl' },
        h('button', { title: t('Свернуть'), html: icon('wmin', 11), onclick: () => api.winMinimize() }),
        maxBtn,
        h('button', { class: 'close', title: t('Закрыть'), html: icon('wclose', 11), onclick: () => api.winClose() }))));
}

// ---------------------------------------------------------------------------
// Обновления: git-клон — git fetch/pull (+ пересборка), готовая сборка — последний релиз GitHub
// ---------------------------------------------------------------------------
async function checkUpdates() {
  const overlay = h('div', { class: 'modal-overlay' });
  const body = h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, t('Проверяю…')));
  const foot = h('div', { class: 'modal-foot' });
  const close = () => overlay.remove();
  overlay.append(h('div', { class: 'modal small', style: { width: '560px' } },
    h('div', { class: 'modal-head' }, h('h2', {}, t('Обновления')), h('button', { class: 'icon-btn', html: icon('close', 18), onclick: close })),
    body, foot));
  document.body.append(overlay);
  const closeBtn = h('button', { class: 'btn ghost', onclick: close }, t('Закрыть'));
  let r;
  try { r = await api.updateCheck(); } catch (e) {
    body.innerHTML = '';
    body.append(h('p', {}, t('Не удалось проверить обновления.')), h('pre', { class: 'error-box' }, String(e)));
    foot.append(closeBtn);
    return;
  }
  body.innerHTML = '';
  const logBox = h('div', { class: 'update-log', style: { display: 'none' } });
  const apply = h('button', { class: 'btn primary' }, h('span', { html: icon('refresh', 17) }), t('Обновить'));
  apply.addEventListener('click', async () => {
    apply.disabled = true; closeBtn.disabled = true;
    logBox.style.display = '';
    const off = api.onUpdateLog(({ text }) => { logBox.textContent += `${text}\n`; logBox.scrollTop = 1e9; });
    if (store.dirty) await saveProject(false).catch(() => {});
    try {
      const res = await api.updateApply();
      logBox.textContent += `${res.message || t('Готово.')}\n`;
    } catch (e) {
      logBox.textContent += `${t('Ошибка: {e}', { e })}\n`;
    }
    off(); closeBtn.disabled = false;
  });
  if (r.mode === 'git') {
    body.append(
      h('p', {}, t('Версия {v} · git-клон, ветка {branch} ({head})', { v: r.current, branch: r.branch, head: r.head })),
      r.behind
        ? h('p', {}, t('Доступно новых изменений: {n}', { n: r.behind }))
        : h('p', { class: 'muted' }, t('У вас последняя версия.')),
      r.commits && r.commits.length ? h('pre', { class: 'update-log' }, r.commits.join('\n')) : null,
      r.ahead ? h('p', { class: 'muted small' }, t('Локальных коммитов, которых нет на GitHub: {n}', { n: r.ahead })) : null,
      r.dirty ? h('p', { class: 'muted small' }, t('Есть изменённые файлы — git pull может отказаться обновлять. Сохраните или откатите их.')) : null,
      r.behind && !r.cargo ? h('p', { class: 'muted small' }, t('Rust (cargo) не найден: исходники обновятся, но программу нужно будет пересобрать или скачать готовую сборку.')) : null,
      logBox);
  } else {
    const hotfixes = r.hotfixes || {};
    const hotfix = r.available && r.asset && r.asset.hotfix;
    body.append(
      h('p', {}, t('Установлена версия {v}. Последний релиз: {latest}', { v: r.current, latest: r.latest || '—' })),
      hotfix ? h('p', {}, t('Доступен хотфикс {v} — исправления, которые войдут в следующий релиз.', { v: r.asset.version })) : null,
      r.available ? h('p', {}, t('Будет скачан {name}. Настройки и проекты не затрагиваются.', { name: r.asset.name }))
        // r.message — причина от Rust (нет сборки для системы, релиз без подписи, неверный тег), уже на языке интерфейса
        : h('p', { class: 'muted' }, r.newer ? (r.message || t('Для этой системы в релизе нет готовой сборки.')) : t('У вас последняя версия.')),
      r.notes ? h('pre', { class: 'update-log' }, r.notes) : null,
      // Хотфиксы — пре-релизы GitHub vX.Y.Z-hotfix.N (settings.json → update.hotfixes, по умолчанию включено)
      h('label', { class: 'check-row', title: t('Подписанные предварительные выпуски GitHub с исправлениями между релизами. Подпись проверяется так же, как у релизов.') },
        h('input', { type: 'checkbox', id: 'update-hotfixes', checked: hotfixes.enabled !== false, onchange: (e) => setPref('update.hotfixes', e.target.checked) }),
        h('span', {}, t('Получать хотфиксы (предварительные выпуски с исправлениями)'))),
      logBox);
  }
  foot.append(closeBtn);
  if (r.available) foot.append(apply);
}

function updateTitle() {
  const name = store.project.name || t('Мой ролик');
  api.setTitle(`${name}${store.dirty ? ' •' : ''} — FF Montage`);
  const s = $('#save-state');
  if (s) s.textContent = store.filePath ? (store.dirty ? t('Есть несохранённые изменения') : t('Сохранено')) : t('Автосохранение');
}

// ---------------------------------------------------------------------------
// Проект: сохранение, открытие, автосохранение
// ---------------------------------------------------------------------------
async function saveProject(as) {
  const p = await api.saveProject({ filePath: as ? null : store.filePath, text: store.serialize(), suggested: store.project.name });
  if (p) { store.filePath = p; store.dirty = false; updateTitle(); autosave(); toast(t('Проект сохранён'), 'success', 2000); }
}

// a новее b (версии вида 0.4.0); если какой-то нет — false
function newerVersion(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const p = (x) => x.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function loadFromText(text, filePath) {
  const j = JSON.parse(text);
  const project = j.project || j;
  if (!project.videoClips || !project.audioTracks) throw new Error(t('Это не проект FF Montage'));
  const newer = newerVersion(j.appVersion, store.appVersion);
  store.load(project, filePath);
  if (newer) toast(t('Проект сохранён в FF Montage {v} — новее этой версии. Что-то из него может не показаться или потеряться при сохранении.', { v: j.appVersion }), 'error', 9000);
  else if (filePath && (!j.appVersion || newerVersion('0.4.0', j.appVersion))) toast(t('Проект из прежней версии программы. При первом сохранении рядом останется копия «… (0.3).ffproj».'), 'info', 6000);
  await restoreMedia();
  timeline.autoFit = true; timeline.fit();
  updateTitle();
  // Эффекты/переходы пропавших (или выключенных) плагинов: предупреждаем, данные проекта не трогаем
  if (pluginHost) pluginHost.warnMissing(store.project);
}

async function openProject() {
  if (store.dirty && store.filePath && !(await confirmDialog(t('Открыть другой проект?'), t('Несохранённые изменения текущего проекта будут потеряны (автосохранение тоже перезапишется).'), t('Открыть')))) return;
  const r = await api.openProject();
  if (!r) return;
  try { await loadFromText(r.text, r.filePath); toast(t('Проект открыт'), 'success', 2000); } catch (e) { toast(t('Не удалось открыть проект: {e}', { e: errText(e) }), 'error', 5000); }
}

async function newProject() {
  const hasContent = store.duration() > 0 || Object.keys(store.project.media).length;
  if (hasContent && !(await confirmDialog(t('Новый проект?'), store.filePath && !store.dirty
    ? t('Текущий проект сохранён, его можно будет открыть снова.')
    : t('Текущий проект не сохранён в файл и будет закрыт. Сохраните его ({key}), если он ещё нужен.', { key: keyHint('project.save') }), t('Создать'), t('Отмена'), !store.filePath || store.dirty))) return;
  store.load(emptyProject(), null);
  store.runtime = {};
  timeline.autoFit = true; timeline.fit();
  updateTitle();
}

const autosaveText = () => JSON.stringify({ filePath: store.filePath, dirty: store.dirty, data: store.serialize() });
const autosave = debounce(() => { api.autosaveWrite(autosaveText()).catch(() => {}); }, 1200);

async function restoreAutosave() {
  try {
    // После перезагрузки окна (смена языка) проект восстанавливаем всегда; при обычном запуске — по настройке
    const reloaded = !!sessionStorage.getItem('ffm.reloadState');
    if (!reloaded && getSetting('restoreSession', true) === false) return;
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

// Перезагрузка окна (смена языка): проект — в автосохранение, вид и история отмен — в sessionStorage
async function reloadUi() {
  try { await api.autosaveWrite(autosaveText()); } catch (e) { console.warn('autosave before reload', e); }
  await flushPrefs().catch(() => {});
  const state = {
    time: store.time,
    pps: timeline.pps, autoFit: timeline.autoFit,
    undo: store.undoStack.slice(-50), redo: store.redoStack.slice(-50),
  };
  try { sessionStorage.setItem('ffm.reloadState', JSON.stringify(state)); } catch {
    try { sessionStorage.setItem('ffm.reloadState', JSON.stringify({ ...state, undo: [], redo: [] })); } catch { /* ignore */ }
  }
  location.reload();
}

function restoreUiState() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('ffm.reloadState') || 'null'); sessionStorage.removeItem('ffm.reloadState'); } catch { /* ignore */ }
  if (!s) return;
  if (Array.isArray(s.undo)) store.undoStack = s.undo;
  if (Array.isArray(s.redo)) store.redoStack = s.redo;
  if (!s.autoFit && s.pps) { timeline.autoFit = false; timeline.setZoom(s.pps); }
  if (isFinite(s.time)) store.setTime(s.time);
}

// ---------------------------------------------------------------------------
// Клавиатура: действия из реестра (keymap.js); клавиши настраиваются в «Настройки → Горячие клавиши»
// ---------------------------------------------------------------------------
function initKeys() {
  const clipSel = () => (store.selection && !['transition', 'cue', 'strack', 'track', 'vtrack'].includes(store.selection.kind) ? store.selection.id : null);
  const step = () => 1 / (store.sourceFormat().fps || 30);
  const bind = {
    'project.new': () => newProject(),
    'project.open': () => openProject(),
    'project.save': () => saveProject(false),
    'project.saveAs': () => saveProject(true),
    'media.import': () => pickAndImport(),
    'export.open': () => openExport(),
    'app.settings': () => openSettings(),
    'edit.undo': () => store.undo(),
    'edit.redo': () => store.redo(),
    'clip.copy': () => { if (clipSel()) copyClip(clipSel()); },
    'clip.paste': () => pasteClip(store.time),
    'clip.duplicate': () => { if (clipSel()) store.duplicateClip(clipSel()); },
    'clip.delete': () => timeline.deleteAction(false),
    'clip.rippleDelete': () => timeline.deleteAction(true),
    'clip.split': () => timeline.splitAction(),
    'clip.splitAll': () => timeline.splitAllAction(),
    'clip.freeze': () => freezeFrame(store.time),
    'clip.reverse': () => { if (clipSel()) reverseClip(clipSel()); },
    'tool.select': () => timeline.setTool('select'),
    'tool.blade': () => timeline.setTool(timeline.tool === 'blade' ? 'select' : 'blade'),
    'timeline.magnet': () => timeline.toggleMagnet(),
    'play.toggle': () => preview.toggle(),
    'play.shuttleBack': (e) => shuttle.back(e),
    'play.shuttleStop': (e) => shuttle.stop(e),
    'play.shuttleFwd': (e) => shuttle.forward(e),
    'tool.trim': () => timeline.setTool(timeline.tool === 'trim' ? 'select' : 'trim'),
    'clip.trimStartRipple': () => edit.trimToPlayhead('start', true),
    'clip.trimEndRipple': () => edit.trimToPlayhead('end', true),
    'clip.trimStart': () => edit.trimToPlayhead('start', false),
    'clip.trimEnd': () => edit.trimToPlayhead('end', false),
    'clip.removePauses': () => { const id = clipSel() || edit.clipAtTime(store.time, { inside: false }); if (id) edit.openPausesDialog(id); },
    'mark.in': () => edit.markIn(),
    'mark.out': () => edit.markOut(),
    'mark.clip': () => edit.markClip(),
    'mark.clear': () => edit.clearMarks(),
    'mark.goIn': () => edit.goToMark('in'),
    'mark.goOut': () => edit.goToMark('out'),
    'edit.lift': () => edit.liftOrExtract(false),
    'edit.extract': () => edit.liftOrExtract(true),
    'play.frameBack': () => store.setTime(store.time - step()),
    'play.frameFwd': () => store.setTime(store.time + step()),
    'play.secBack': () => store.setTime(store.time - 1),
    'play.secFwd': () => store.setTime(store.time + 1),
    'play.back5': () => store.setTime(store.time - 5),
    'play.fwd5': () => store.setTime(store.time + 5),
    'play.start': () => store.setTime(0),
    'play.end': () => store.setTime(store.duration()),
    'view.fullscreen': () => preview.fullscreen(),
    'view.zoomIn': () => timeline.setZoom(timeline.pps * 1.4, null, true),
    'view.zoomOut': () => timeline.setZoom(timeline.pps / 1.4, null, true),
    'view.zoomFit': () => { timeline.autoFit = true; timeline.fit(); },
  };
  for (const [id, fn] of Object.entries(bind)) bindAction(id, fn);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = (tag === 'input' && !['range', 'checkbox', 'button'].includes(e.target.type)) || tag === 'textarea' || tag === 'select';
    if (document.querySelector('.modal-overlay')) return;
    if (menuOpen()) { if (e.key !== 'Escape' && !e.key.startsWith('Arrow')) closeMenu(); else return; }
    if (popoverOpen() && e.key !== 'Escape') closePopover();
    if (e.key === 'F12') { api.devtools(); return; }
    if (dispatchKey(e, typing)) return;
    if (typing) return;
    // Esc не переназначается: выйти из лезвия или снять выделение
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) { if (timeline.tool !== 'select') timeline.setTool('select'); else store.select(null); return; }
    // Не отдаём WebView его собственные сочетания (Ctrl+S «сохранить страницу» и т.п.)
    if ((e.ctrlKey || e.metaKey) && ['KeyS', 'KeyO', 'KeyN', 'KeyP', 'KeyF', 'KeyG', 'KeyU', 'KeyR'].includes(e.code)) e.preventDefault();
  });
}

// Файлы из Проводника, брошенные на окно (не на таймлайн) — просто импорт
function initWindowDrop() {
  const shade = h('div', { class: 'drop-shade' }, h('div', {}, h('span', { html: icon('upload', 40) }), h('p', {}, t('Отпустите, чтобы импортировать'))));
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
    // Файлы субтитров — сразу на новую дорожку субтитров
    const subs = paths.filter((p) => /\.(srt|vtt|ass|ssa)$/i.test(p));
    for (const p of subs) await importSubtitles(null, p);
    paths = paths.filter((p) => !subs.includes(p));
    // Аудиоплагины (.vst3, .clap) — установить, как «Добавить плагин…» в настройках
    paths = (await installDropped(paths)).rest;
    if (!paths.length) { timeline.dragLeave(); return; }
    if (await timeline.dropAt(x, y, { paths })) return;
    const ids = await importPaths(paths);
    if (ids.length) toast(t('Импортировано файлов: {n}', { n: ids.length }), 'success', 2000);
  });
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
async function main() {
  await initSettings({ reload: reloadUi, checkUpdates, showMcp: showMcpDialog, beforeRestart: () => api.autosaveWrite(autosaveText()) });
  initTopbar();
  api.info().then((i) => { store.appVersion = i.version; }).catch(() => {});
  timeline = new Timeline($('#timeline'));
  initEpisodes($('#timeline'));
  preview = new Preview($('#preview'));
  transport = initTransport(preview);
  shuttle = initShuttle(preview);
  initTrimPreview(preview);
  initViewbar();
  const crop = initCropMode(preview);
  const gizmo = initGizmo(preview);
  const subsOverlay = initSubtitleOverlay(preview);
  // Шрифты (встроенные и свои) — в фоне: тексты перерисуются, когда загрузятся
  const fontsReady = initFonts().catch((e) => console.warn('fonts', e));
  initAudioRack();
  const anim = initAnim(preview);
  initModes();
  initMediaPanel({ addToTimeline: (id) => timeline.addMedia(id) });
  initInspector({ onSplit: () => timeline.splitAction(), onDelete: () => timeline.deleteAction() });
  const browser = initBrowser();
  initKeys();
  initGamepad();
  initWindowDrop();
  store.on('request-pause', () => preview.pause());
  store.on('project', () => { autosave(); updateTitle(); });
  initResizers();
  // Плагины — до восстановления автосохранения: их эффекты и переходы должны быть уже в реестре
  pluginHost = await pluginsReady;
  if (pluginHost) {
    try {
      pluginHost.initPluginHost({ browser });
      await pluginHost.loadPlugins();
    } catch (e) { console.warn('plugins', e); }
  }
  await restoreAutosave();
  restoreUiState();
  updateTitle();
  // 0.5.0: панели в отдельных окнах (второй монитор). Перенос — тот же DOM, после него плеер и таймлайн
  // пересчитывают размеры, а <video> (браузер перезагружает его при смене документа) встают на текущий кадр.
  onPopout((id, ev) => {
    preview.layoutStage();
    if (ev !== 'resize' && !preview.playing) preview.seek(store.time);
    timeline.render();
    gizmo.draw();
  });
  initPopouts();
  window.__ffm = { store, preview, timeline, importPaths, openExport, browser, crop, gizmo, anim, openSettings, reloadUi, plugins: pluginHost, loadProjectText: loadFromText, subsOverlay, fontsReady, shuttle, edit, popout: { popOut, dock, poppedOut, setExperimental } };
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
  maybeAskLanguage();
  noticeCrashReports();
  const info = await api.info();
  if (info.ffmpegMissing || !info.ffmpegVersion) {
    toast(t('FFmpeg не найден — без него не будет миниатюр и экспорта. Укажите папку: меню ☰ → «Настройки» → «Папки».'), 'error', 15000);
  }
}

// С прошлого запуска появились отчёты об ошибках (crashlog.rs: падение, ошибка экспорта, ошибка в окне) —
// сказать, где они лежат. Никуда не отправляются. В автотестах молчим: тесты закрывают программу как попало.
async function noticeCrashReports() {
  if (window.__FFM_BOOT && window.__FFM_BOOT.selftest) return;
  try {
    const r = await api.crashReports(true);
    const fresh = (r && r.fresh) || [];
    if (!fresh.length) return;
    const crashed = fresh.some((x) => ['panic', 'native', 'unclean-exit', 'window-crash'].includes(x.kind));
    const msg = crashed
      ? t('В прошлый раз программа завершилась с ошибкой. Отчёт сохранён на этом компьютере — приложите его, когда будете сообщать об ошибке.')
      : t('Сохранены отчёты об ошибках ({n}). Они лежат на этом компьютере — приложите их, когда будете сообщать об ошибке.', { n: fresh.length });
    toast(h('span', { class: 'toast-crash' }, msg, ' ',
      h('button', { class: 'btn ghost small', onclick: () => api.openPath(r.dir).catch(() => {}) }, t('Открыть папку'))), crashed ? 'error' : 'info', 15000);
  } catch (e) { console.warn('crash reports', e); }
}

// Перетаскиваемая граница между плеером и таймлайном
function initResizers() {
  const grip = $('#tl-resizer');
  grip.title = t('Потяните, чтобы изменить высоту таймлайна');
  const app = $('#app');
  const saved = Number(getPref('ui.tlHeight', 0));
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
      setPref('ui.tlHeight', $('#timeline').offsetHeight);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

main().catch((e) => { console.error(e); toast(t('Ошибка запуска: {e}', { e: errText(e) }), 'error', 10000); });
