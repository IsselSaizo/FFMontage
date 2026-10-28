// Связь окна с программой (Tauri): window.api — те же функции, что были в preload Electron-версии.
// Подключается первым модулем (index.html, setup.html), до остальных скриптов.
import { exportCommand } from './exportPlan.js';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const on = (event, fn) => {
  let off = null; let dead = false;
  T.event.listen(event, (e) => fn(e.payload)).then((u) => { if (dead) u(); else off = u; });
  return () => { dead = true; if (off) off(); };
};

// Журнал окна → <кэш>/app/logs/renderer.log (как раньше в Electron)
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
  i.platform = i.platform === 'windows' ? 'win32' : i.platform;
  i.electron = undefined;
  infoCache = i;
  return i;
};

// Перетаскивание файлов из Проводника: Tauri сообщает пути и позицию курсора
const dropListeners = new Set();
try {
  T.webview.getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    const dpr = window.devicePixelRatio || 1;
    const pos = p.position ? { x: p.position.x / dpr, y: p.position.y / dpr } : null;
    for (const fn of dropListeners) fn({ type: p.type, paths: p.paths || [], x: pos ? pos.x : 0, y: pos ? pos.y : 0 });
  });
} catch (e) { console.warn('drag-drop', e); }

const win = T.window.getCurrentWindow();

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
    try { plan = exportCommand(project, settings, i.ffMajor); } catch (e) { return { ok: false, error: e.message }; }
    return invoke('export_start', { plan });
  },
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
  onWinResize: (fn) => win.onResized(() => fn()),
  // Обновления
  updateCheck: () => invoke('update_check'),
  updateApply: () => invoke('update_apply'),
  onUpdateLog: (fn) => on('update:log', fn),
  // окно настроек папок / первого запуска
  setupInfo: async () => { const i = await invoke('setup_info'); i.platform = i.platform === 'windows' ? 'win32' : i.platform; return i; },
  pickFolder: (current) => invoke('setup_pick_folder', { current }),
  checkFfmpeg: (dir) => invoke('setup_check_ffmpeg', { dir }),
  setupEncoders: (dir) => invoke('setup_encoders', { dir }),
  saveSetup: (cfg) => invoke('setup_save', { cfg }),
  openSettings: () => invoke('setup_open'),
  cancelSetup: () => invoke('setup_cancel'),
};
