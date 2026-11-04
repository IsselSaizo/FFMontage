// Связь окна с программой (Tauri): window.api — все вызовы команд Rust и подписки на события.
// Подключается первым модулем (index.html, setup.html), до остальных скриптов.
// window.__TAURI__ в окне нет (withGlobalTauri: false) — вызовы идут через js/tauri.js.
import { exportCommand } from './exportPlan.js';
import { invoke, listen, appWindow, webview } from './tauri.js';

const on = (event, fn) => {
  let off = null; let dead = false;
  listen(event, (e) => fn(e.payload)).then((u) => { if (dead) u(); else off = u; }).catch((e) => console.warn('listen', event, e));
  return () => { dead = true; if (off) off(); };
};

// Журнал окна → <кэш>/app/logs/renderer.log
const log = (level, args) => {
  try {
    const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    invoke('log_line', { level, message: msg.slice(0, 20000) }).catch(() => {});
  } catch { /* ignore */ }
};
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { orig(...a); if (level !== 'log' && level !== 'info') log(level, a); };
}
window.addEventListener('error', (e) => log('error', [`${e.message} (${e.filename}:${e.lineno})`]));
window.addEventListener('unhandledrejection', (e) => log('error', ['unhandled:', e.reason]));

let infoCache = null;
const info = async () => {
  const i = await invoke('app_info');
  infoCache = i;
  return i;
};

// Перетаскивание файлов из Проводника: Tauri сообщает пути и позицию курсора
const dropListeners = new Set();
try {
  webview.onDragDropEvent((p) => {
    const dpr = window.devicePixelRatio || 1;
    const pos = p.position ? { x: p.position.x / dpr, y: p.position.y / dpr } : null;
    for (const fn of dropListeners) fn({ type: p.type, paths: p.paths || [], x: pos ? pos.x : 0, y: pos ? pos.y : 0 });
  }).catch((e) => console.warn('drag-drop', e));
} catch (e) { console.warn('drag-drop', e); }

const win = appWindow;

window.api = {
  info,
  pickMedia: () => invoke('media_pick'),
  probe: (file) => invoke('media_probe', { file }),
  thumbs: (info) => invoke('media_thumbs', { info }),
  peaks: (info, stream = 0) => invoke('media_peaks', { info, stream }),
  audioStream: (info, stream) => invoke('media_audio_stream', { info, stream }),
  proxy: (info) => invoke('media_proxy', { info }),
  onProxyProgress: (fn) => on('media:proxy-progress', fn),
  encoders: () => invoke('enc_detect'),
  fxReverse: (info, a, b) => invoke('fx_reverse', { info, a, b }),
  fxFreeze: (info, at) => invoke('fx_freeze', { info, at }),
  onFxProgress: (fn) => on('fx:progress', fn),
  fxFrame: (file, t, width) => invoke('fx_frame', { file, t, width }),
  fxSilence: (file, thresholdDb, minDur) => invoke('fx_silence', { file, thresholdDb, minDur }),
  readProject: (path) => invoke('project_read', { path }),
  // ИИ-ассистент (MCP): программа присылает вызовы инструментов, окно отвечает
  onMcpCall: (fn) => on('mcp:call', fn),
  mcpResult: (id, payload) => invoke('mcp_result', { id, payload }).catch(() => {}),
  mcpInfo: () => invoke('mcp_info'),
  testShot: (name) => invoke('test_shot', { name }),
  pickExportPath: (suggested) => invoke('export_pick', { suggested }),
  defaultExportPath: (base) => invoke('export_default_path', { base }),
  startExport: async (project, settings) => {
    const i = infoCache || await info();
    let plan;
    try {
      // Тексты (картинки PNG) и субтитры (.ass / .srt) — готовятся окном до сборки команды (exportAssets.js)
      const { prepareExportAssets } = await import('./exportAssets.js');
      const assets = await prepareExportAssets(project, settings, window.api);
      plan = exportCommand(project, { ...settings, assets }, i.ffMajor);
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    return invoke('export_start', { plan });
  },
  // Готовый план FFmpeg (запекание анимаций): { args, filter, duration, output }
  runPlan: (plan) => invoke('export_start', { plan: { args: plan.args, filter: plan.filter, duration: plan.duration, output: plan.output } }),
  cancelExport: () => invoke('export_cancel'),
  onExportProgress: (fn) => on('export:progress', fn),
  saveProject: (args) => invoke('project_save', { args }),
  openProject: () => invoke('project_open'),
  autosaveWrite: (text) => invoke('autosave_write', { text }),
  autosaveRead: () => invoke('autosave_read'),
  showInFolder: (path) => invoke('shell_show', { path }),
  openPath: (path) => invoke('shell_open', { path }),
  devtools: () => invoke('win_devtools'),
  setTitle: (title) => invoke('win_title', { title }),
  exists: (path) => invoke('fs_exists', { path }),
  // Файлы, брошенные на окно: fn({ type: 'enter'|'over'|'drop'|'leave', paths, x, y })
  onFileDrop: (fn) => { dropListeners.add(fn); return () => dropListeners.delete(fn); },
  // Кнопки окна (рамка своя)
  winMinimize: () => win.minimize(),
  winToggleMaximize: () => win.toggleMaximize(),
  winClose: () => win.close(),
  winIsMaximized: () => win.isMaximized(),
  onWinResize: (fn) => win.onResized(() => fn()).catch((e) => console.warn('resize', e)),
  // Обновления
  updateCheck: () => invoke('update_check'),
  updateApply: () => invoke('update_apply'),
  onUpdateLog: (fn) => on('update:log', fn),
  // окно настроек папок / первого запуска
  setupInfo: () => invoke('setup_info'),
  pickFolder: (current) => invoke('setup_pick_folder', { current }),
  checkFfmpeg: (dir) => invoke('setup_check_ffmpeg', { dir }),
  setupEncoders: (dir) => invoke('setup_encoders', { dir }),
  saveSetup: (cfg) => invoke('setup_save', { cfg }),
  openSettings: () => invoke('setup_open'),
  cancelSetup: () => invoke('setup_cancel'),
  restart: () => invoke('app_restart'),
  // Настройки интерфейса (config.json → settings) и кэш
  settingsGet: () => invoke('settings_get'),
  settingsSet: (patch) => invoke('settings_set', { patch }),
  cacheStats: () => invoke('cache_stats'),
  cacheClear: (cats, keep) => invoke('cache_clear', { cats, keep }),
  // Плагины (js/plugins/host.js, раздел настроек «Плагины»)
  pluginsList: () => invoke('plugins_list'),
  pluginsPick: (kind) => invoke('plugins_pick', { kind }),
  pluginsInstall: (source) => invoke('plugins_install', { source }),
  pluginsInstallGithub: (repo) => invoke('plugins_install_github', { repo }),
  pluginsRemove: (id) => invoke('plugins_remove', { id }),
  pluginsOpenDir: (id = null) => invoke('plugins_open_dir', { id }),
  pluginStorageGet: (id) => invoke('plugin_storage_get', { id }),
  pluginStorageSet: (id, data) => invoke('plugin_storage_set', { id, data }),
  pluginNetFetch: (id, request) => invoke('plugin_net_fetch', { id, request }),
  // Шрифты (M5.2): встроенные + свои (папка user-fonts); для экспорта субтитров — папка fontsExportDir
  fontsList: () => invoke('fonts_list'),
  fontsAdd: (paths = null) => invoke('fonts_add', { paths }),
  fontsRemove: (file) => invoke('fonts_remove', { file }),
  fontsOpenDir: () => invoke('fonts_open_dir'),
  fontsExportDir: () => invoke('fonts_export_dir'),
  // Файлы для экспорта (картинки текстов, субтитры): kind 'png' (base64) | 'ass' | 'srt' | 'vtt' → путь
  exportAssetSave: (kind, data) => invoke('export_asset_save', { kind, data }),
  // Субтитры: открыть (null — окно выбора) → { path, name, text } | null; сохранить → путь | null
  subtitleRead: (path = null) => invoke('subtitle_file_read', { path }),
  subtitleWrite: (path, defaultName, text) => invoke('subtitle_file_write', { path, defaultName, text }),
  // Аудиоплагины VST3 / CLAP (.agent/vst3-contract.md; js/vst.js — список, рендер, окна плагинов)
  vstSupported: () => invoke('vst_supported'),
  vstList: () => invoke('vst_list'),
  vstScan: (force = false) => invoke('vst_scan', { force: !!force }),
  vstFoldersSet: (folders) => invoke('vst_folders_set', { folders }),
  vstPickFolder: () => invoke('vst_pick_folder'),
  vstInstall: (path = null) => invoke('vst_install', { path }),
  vstInfo: (uid, state = null, ctrl = null) => invoke('vst_info', { uid, state, ctrl }),
  // tag — метка задания (в ключ кэша не входит): события прогресса vst:render { tag, fraction }
  vstRender: (job, tag = null) => invoke('vst_render', { job: tag ? { ...job, tag } : job }),
  vstEditorOpen: (args) => invoke('vst_editor_open', args),
  vstEditorCmd: (session, cmd) => invoke('vst_editor_cmd', { session, cmd }),
  onVstScan: (fn) => on('vst:scan', fn),
  onVstRender: (fn) => on('vst:render', fn),
  onVstState: (fn) => on('vst:state', fn),
  onVstClosed: (fn) => on('vst:closed', fn),
  onVstEditor: (fn) => on('vst:editor', fn),
  onVstError: (fn) => on('vst:error', fn),
};
