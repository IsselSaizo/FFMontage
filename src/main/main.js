'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { PATHS, applyConfig, applyFirstRun, loadConfig, saveConfig, suggestDefaults, ensureDirs } = require('./paths');

// ---------------------------------------------------------------------------
// 1. Настройки и пути. Всё хранилище Electron — в выбранной папке кэша (до готовности приложения!)
// ---------------------------------------------------------------------------
const config = loadConfig();
const FIRST_RUN = !config;
if (FIRST_RUN) applyFirstRun(); else applyConfig(config);
ensureDirs();
app.setPath('userData', PATHS.USER_DATA);
app.setPath('sessionData', PATHS.SESSION_DATA);
app.setPath('logs', PATHS.LOGS);
app.setPath('crashDumps', PATHS.CRASH);
app.setPath('temp', PATHS.TEMP);
process.env.TEMP = PATHS.TEMP;
process.env.TMP = PATHS.TEMP;
process.env.TMPDIR = PATHS.TEMP;
app.commandLine.appendSwitch('disk-cache-dir', path.join(PATHS.SESSION_DATA, 'Cache'));
app.setName('FF Montage');
if (process.platform === 'win32') app.setAppUserModelId('FFMontage.Editor');

// Временная папка окна первой настройки больше не нужна
if (!FIRST_RUN) fs.rm(PATHS.FIRSTRUN_DIR, { recursive: true, force: true }, () => {});

const ff = require('./ffmpeg');
const exporter = require('./exporter');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;       // главное окно
let setupWin = null;  // окно настроек / первого запуска
const RENDERER_DIR = path.join(PATHS.APP_DIR, 'src', 'renderer');
const ICON = path.join(RENDERER_DIR, 'assets', 'icon.png');
const PRELOAD = path.join(PATHS.APP_DIR, 'src', 'preload', 'preload.js');
const allowed = new Set(); // файлы, которые разрешено отдавать окну

const isWin = process.platform === 'win32';
const norm = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
const allow = (p) => { if (p) allowed.add(norm(p)); };
const isAllowed = (p) => {
  const n = norm(p);
  return allowed.has(n) || n.startsWith(norm(PATHS.MEDIA_CACHE) + path.sep);
};
const mediaUrl = (p) => `app://local/media/${encodeURIComponent(p)}`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.woff2': 'font/woff2',
};

// Отдача файла с поддержкой Range (нужно видеоплееру для перемотки)
async function serveFile(file, request) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const size = stat.size;
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = fs.createReadStream(file, { start, end, highWaterMark: 1024 * 1024 });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file, { highWaterMark: 1024 * 1024 })), {
    status: 200, headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
  });
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/media/')) {
      const file = decodeURIComponent(url.pathname.slice('/media/'.length));
      if (!isAllowed(file)) return new Response('Forbidden', { status: 403 });
      return serveFile(file, request);
    }
    if (url.pathname.startsWith('/ui/')) {
      const rel = decodeURIComponent(url.pathname.slice('/ui/'.length));
      const file = path.resolve(RENDERER_DIR, rel);
      if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
      return serveFile(file, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------------
function attachLogging(w, name) {
  const logFile = path.join(PATHS.LOGS, `${name}.log`);
  fs.writeFileSync(logFile, `--- ${new Date().toISOString()} ---\n`);
  w.webContents.on('console-message', (e) => {
    fs.appendFile(logFile, `[${e.level || ''}] ${e.message} (${e.sourceId || ''}:${e.lineNumber || ''})\n`, () => {});
  });
  w.webContents.on('render-process-gone', (_e, d) => fs.appendFile(logFile, `RENDER GONE ${JSON.stringify(d)}\n`, () => {}));
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1100, minHeight: 680,
    backgroundColor: '#121216',
    title: 'FF Montage',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16161b', symbolColor: '#e8e8ee', height: 44 },
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadURL('app://local/ui/index.html');
  attachLogging(win, 'renderer');
  win.on('closed', () => { win = null; });
  if (process.env.FFM_SELFTEST) runSelfTest(win);
}

// Окно выбора папок: при первом запуске — единственное окно, потом — из меню «Настройки папок»
function createSetupWindow() {
  if (setupWin) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 680, height: 700, resizable: false, minimizable: false, maximizable: false,
    parent: win || undefined, modal: !!win,
    backgroundColor: '#1d1d23',
    title: FIRST_RUN ? 'FF Montage — первый запуск' : 'FF Montage — настройки папок',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  setupWin.setMenu(null);
  setupWin.once('ready-to-show', () => setupWin.show());
  setupWin.loadURL('app://local/ui/setup.html');
  attachLogging(setupWin, 'setup');
  setupWin.on('closed', () => { setupWin = null; if (FIRST_RUN) app.quit(); });
  if (FIRST_RUN && process.env.FFM_SELFTEST) runSelfTest(setupWin);
}

// Автотест: выполняет скрипт в окне, делает снимок экрана и закрывается
function runSelfTest(w) {
  const script = fs.readFileSync(process.env.FFM_SELFTEST, 'utf8');
  const shot = process.env.FFM_SHOT || path.join(PATHS.TEMP, 'selftest.png');
  const resultFile = shot.replace(/\.png$/i, '.json');
  w.webContents.once('did-finish-load', async () => {
    let result;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      result = await w.webContents.executeJavaScript(script, true);
    } catch (e) {
      result = { error: String(e && e.stack || e) };
    }
    try {
      await new Promise((r) => setTimeout(r, 600));
      const img = await w.webContents.capturePage();
      fs.writeFileSync(shot, img.toPNG());
    } catch (e) { result = { ...(result || {}), shotError: String(e) }; }
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    if (!process.env.FFM_KEEP_OPEN) app.exit(0);
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma'];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender) || win;

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    ffmpeg: ff.findBinaries().ffmpeg,
    ffmpegMissing: !!ff.findBinaries().missing,
    ffmpegVersion: await ff.version(),
    outputDir: PATHS.OUTPUT_DIR,
    projectsDir: PATHS.PROJECTS_DIR,
    cacheDir: PATHS.CACHE_DIR,
    logsDir: PATHS.LOGS,
    configFile: PATHS.CONFIG_FILE,
    sep: path.sep,
    videoExt: VIDEO_EXT,
    audioExt: AUDIO_EXT,
  }));

  // --- окно настроек ---
  ipcMain.handle('setup:info', async () => ({
    firstRun: FIRST_RUN,
    platform: process.platform,
    appDir: PATHS.APP_DIR,
    configFile: PATHS.CONFIG_FILE,
    config: config || suggestDefaults({ videosDir: app.getPath('videos'), documentsDir: app.getPath('documents') }),
  }));
  ipcMain.handle('setup:pick-folder', async (e, current) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      title: 'Выберите папку', defaultPath: current || PATHS.APP_DIR, properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('setup:check-ffmpeg', async (_e, dir) => ff.checkDir(dir));
  ipcMain.handle('setup:encoders', async (_e, dir) => {
    const bin = dir ? ff.searchBinaries(dir) : ff.searchBinaries('');
    return bin ? ff.detectEncoders(bin) : null;
  });
  ipcMain.handle('setup:save', async (_e, cfg) => {
    const clean = {};
    for (const k of ['cacheDir', 'outputDir', 'projectsDir']) {
      const v = String(cfg[k] || '').trim();
      if (!v) return { ok: false, error: 'Укажите все папки.' };
      const abs = path.resolve(PATHS.APP_DIR, v);
      try { fs.mkdirSync(abs, { recursive: true }); fs.accessSync(abs, fs.constants.W_OK); } catch (err) {
        return { ok: false, error: `Не удалось создать папку или нет прав на запись:\n${abs}\n${err.message}` };
      }
      clean[k] = abs;
    }
    clean.ffmpegDir = String(cfg.ffmpegDir || '').trim();
    try { saveConfig(clean); } catch (err) {
      return { ok: false, error: `Не удалось записать ${PATHS.CONFIG_FILE}:\n${err.message}` };
    }
    // Новые пути применяются после перезапуска
    if (!process.env.FFM_SELFTEST) setTimeout(() => { app.relaunch(); app.exit(0); }, 150);
    return { ok: true };
  });
  ipcMain.handle('setup:open', async () => { createSetupWindow(); return true; });
  ipcMain.handle('setup:cancel', async () => { if (setupWin) setupWin.close(); return true; });

  // --- медиа ---
  ipcMain.handle('media:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Импорт медиа',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Видео и аудио', extensions: [...VIDEO_EXT, ...AUDIO_EXT] },
        { name: 'Видео', extensions: VIDEO_EXT },
        { name: 'Аудио', extensions: AUDIO_EXT },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('media:probe', async (_e, file) => {
    const info = await ff.probe(file);
    allow(file);
    info.url = mediaUrl(file);
    return info;
  });

  ipcMain.handle('media:thumbs', async (_e, info) => {
    const t = await ff.thumbs(info);
    if (!t) return null;
    return { interval: t.interval, height: t.height, urls: t.files.map(mediaUrl) };
  });

  ipcMain.handle('media:peaks', async (_e, info) => ff.peaks(info));

  ipcMain.handle('media:proxy', async (_e, info) => {
    const enc = await ff.detectEncoders();
    const file = await ff.proxy(info, (fraction) => send('media:proxy-progress', { key: info.key, fraction }), enc);
    return mediaUrl(file);
  });

  ipcMain.handle('enc:detect', async () => ff.detectEncoders());

  // --- экспорт ---
  ipcMain.handle('export:pick', async (_e, suggested) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Куда сохранить видео',
      defaultPath: path.join(PATHS.OUTPUT_DIR, suggested || 'Видео.mp4'),
      filters: [{ name: 'Видео MP4', extensions: ['mp4'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('export:default-path', async (_e, base) => {
    const safe = String(base || 'Видео').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Видео';
    let p = path.join(PATHS.OUTPUT_DIR, `${safe}.mp4`);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(PATHS.OUTPUT_DIR, `${safe} (${i}).mp4`);
    return p;
  });

  ipcMain.handle('export:start', async (_e, project, settings) => {
    win && win.setProgressBar(0);
    try {
      const v = await ff.versionInfo();
      const r = await exporter.startExport(project, settings, {
        ffMajor: v ? v.major : 99,
        onProgress: (p) => { send('export:progress', p); win && win.setProgressBar(p.fraction); },
      });
      win && win.setProgressBar(-1);
      if (win && !win.isFocused()) win.flashFrame(true);
      return { ok: true, ...r };
    } catch (e) {
      win && win.setProgressBar(-1);
      return { ok: false, cancelled: !!e.cancelled, error: e.message };
    }
  });

  ipcMain.handle('export:cancel', async () => exporter.cancelExport());

  // --- проект ---
  ipcMain.handle('project:save', async (_e, { filePath, text, suggested }) => {
    let p = filePath;
    if (!p) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Сохранить проект',
        defaultPath: path.join(PATHS.PROJECTS_DIR, `${suggested || 'Проект'}.ffproj`),
        filters: [{ name: 'Проект FF Montage', extensions: ['ffproj'] }],
      });
      if (r.canceled) return null;
      p = r.filePath;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  });

  ipcMain.handle('project:open', async () => {
    fs.mkdirSync(PATHS.PROJECTS_DIR, { recursive: true });
    const r = await dialog.showOpenDialog(win, {
      title: 'Открыть проект',
      defaultPath: PATHS.PROJECTS_DIR,
      properties: ['openFile'],
      filters: [{ name: 'Проект FF Montage', extensions: ['ffproj'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { filePath: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
  });

  ipcMain.handle('autosave:write', async (_e, text) => {
    fs.writeFileSync(PATHS.AUTOSAVE + '.tmp', text, 'utf8');
    fs.renameSync(PATHS.AUTOSAVE + '.tmp', PATHS.AUTOSAVE);
    return true;
  });
  ipcMain.handle('autosave:read', async () => (fs.existsSync(PATHS.AUTOSAVE) ? fs.readFileSync(PATHS.AUTOSAVE, 'utf8') : null));

  ipcMain.handle('shell:show', async (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('shell:open', async (_e, p) => {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) fs.mkdirSync(p, { recursive: true });
    return shell.openPath(p);
  });
  ipcMain.handle('win:devtools', async (e) => { senderWindow(e).webContents.toggleDevTools(); return true; });
  ipcMain.handle('win:title', async (_e, t) => { win && win.setTitle(t); return true; });
  ipcMain.handle('fs:exists', async (_e, p) => fs.existsSync(p));
}

app.whenReady().then(() => {
  registerProtocol();
  registerIpc();
  if (FIRST_RUN) {
    createSetupWindow();
  } else {
    fs.mkdirSync(PATHS.OUTPUT_DIR, { recursive: true });
    createWindow();
    ff.detectEncoders().catch(() => {});
  }
});

app.on('second-instance', () => {
  const w = setupWin || win;
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});
app.on('window-all-closed', () => { exporter.cancelExport(); app.quit(); });
