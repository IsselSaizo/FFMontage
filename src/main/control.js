'use strict';
// Канал управления для ИИ-ассистента (MCP).
//
// Программа слушает локальный канал (Windows — именованный канал, Linux — unix-сокет) и принимает
// команды от MCP-сервера mcp/ff-montage-mcp.js, который запускает ИИ-клиент (Claude Desktop, Cursor…).
// Сеть не используется. Каждый запрос должен содержать секретный ключ: он лежит в
// <кэш>/app/mcp-endpoint.json, доступном только вашей учётной записи.
//
// Протокол: JSON по одной строке на сообщение.
//   запрос  { id, token, method, params }
//   ответ   { id, result } | { id, error }
// Методы: ping → { ok, version, pid, ready }; call { tool, args } → результат инструмента из окна;
//         quit (только если программа запущена с FFM_ALLOW_QUIT=1 — для автотестов).
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ipcMain } = require('electron');

const CALL_TIMEOUT_MS = 15 * 60 * 1000;   // долгие операции: реверс, импорт больших файлов
const READY_TIMEOUT_MS = 60 * 1000;       // сколько ждать, пока окно загрузится
const MAX_LINE = 64 * 1024 * 1024;        // защита от мусора в канале

let ctx = null;           // { PATHS, getWindow, app }
let server = null;
let pipePath = null;
let endpointFile = null;
let token = null;
let ready = false;        // окно сообщило, что обработчик MCP подключён
let readyWaiters = [];
let seq = 0;
const pending = new Map(); // id → { resolve, reject, timer }
const sockets = new Set();
let ipcRegistered = false;

function userName() {
  try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || ''; }
}

function makePipePath(PATHS) {
  const hash = crypto.createHash('sha1').update(`${PATHS.APP_CACHE}|${userName()}`).digest('hex').slice(0, 12);
  if (process.platform === 'win32') return `\\\\.\\pipe\\ffmontage-${hash}`;
  // Путь unix-сокета ограничен ~104 символами; os.tmpdir() у нас уже указывает в кэш (TMPDIR), он может быть длинным
  const name = `ffmontage-${hash}.sock`;
  for (const dir of [process.env.XDG_RUNTIME_DIR, os.tmpdir(), '/tmp']) {
    if (dir && path.join(dir, name).length < 100) return path.join(dir, name);
  }
  return path.join('/tmp', name);
}

function serverScript() {
  return path.join(ctx.PATHS.APP_DIR, 'mcp', 'ff-montage-mcp.js');
}

function version() {
  try { return ctx.app.getVersion(); } catch { return '0'; }
}

// ---------------------------------------------------------------------------
// Связь с окном
// ---------------------------------------------------------------------------
function liveWindow() {
  const w = ctx && ctx.getWindow ? ctx.getWindow() : null;
  return w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed() ? w : null;
}

function setReady(v) {
  ready = v;
  if (v) { const list = readyWaiters; readyWaiters = []; list.forEach((r) => r.resolve()); }
}

function waitReady() {
  if (ready && liveWindow()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const entry = { resolve: () => { clearTimeout(entry.timer); resolve(); }, reject };
    entry.timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((x) => x !== entry);
      reject(new Error(liveWindow()
        ? 'Интерфейс FF Montage не отвечает: окно ещё загружается или в нём произошла ошибка (см. logs/renderer.log).'
        : 'Окно FF Montage не открыто.'));
    }, READY_TIMEOUT_MS);
    readyWaiters.push(entry);
  });
}

function failAll(message) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(message)); pending.delete(id); }
}

// Следим за окном: после перезагрузки страницы обработчик нужно подключить заново
let watchedContents = null;
function watchWindow() {
  const w = liveWindow();
  if (!w || w.webContents === watchedContents) return;
  watchedContents = w.webContents;
  const wc = w.webContents;
  wc.on('did-start-navigation', (e, _url, isInPlace, isMainFrame) => {
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
    const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace;
    if (main && !same) { setReady(false); failAll('Окно FF Montage перезагрузилось — повторите команду.'); }
  });
  wc.on('render-process-gone', () => { setReady(false); failAll('Окно FF Montage упало — повторите команду.'); });
  wc.once('destroyed', () => {
    if (watchedContents === wc) watchedContents = null;
    setReady(false);
    failAll('Окно FF Montage закрыто.');
  });
}

async function callTool(tool, args) {
  if (typeof tool !== 'string' || !tool) throw new Error('Не указан инструмент.');
  if (!liveWindow()) throw new Error('Окно FF Montage не открыто.');
  watchWindow();
  await waitReady();
  const w = liveWindow();
  if (!w) throw new Error('Окно FF Montage закрыто.');
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Нет ответа от окна за ${CALL_TIMEOUT_MS / 60000} мин.`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.webContents.send('mcp:call', { id, tool, args: args && typeof args === 'object' ? args : {} });
    } catch (e) {
      clearTimeout(timer); pending.delete(id); reject(e);
    }
  });
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on('mcp:result', (e, id, payload) => {
    const w = liveWindow();
    if (!w || e.sender !== w.webContents) return; // только главное окно
    if (id === '__ready__') { watchWindow(); setReady(!!(payload && payload.ready !== false)); return; }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (payload && payload.error !== undefined && payload.error !== null) p.reject(new Error(String(payload.error)));
    else p.resolve(payload ? payload.result : null);
  });
  ipcMain.handle('mcp:info', async () => info());
}

// Всё, что нужно окну «ИИ-ассистент»: готовые настройки для MCP-клиентов
function info() {
  const script = serverScript();
  const command = process.execPath;
  const args = [script];
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  if (process.env.FFM_CONFIG) env.FFM_CONFIG = path.resolve(process.env.FFM_CONFIG);
  const entry = { command, args, env };
  const configJson = JSON.stringify({ mcpServers: { 'ff-montage': entry } }, null, 2);
  // VS Code (.vscode/mcp.json) использует ключ "servers" и тип транспорта
  const vscodeJson = JSON.stringify({ servers: { 'ff-montage': { type: 'stdio', ...entry } } }, null, 2);
  const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${q(v)}`).join(' ');
  const claudeCodeCommand = `claude mcp add ff-montage ${envFlags} -- ${q(command)} ${q(script)}`;
  return {
    serverScript: script,
    serverExists: fs.existsSync(script),
    command, args, env,
    configJson, vscodeJson, claudeCodeCommand,
    endpoint: endpointFile,
    pipe: pipePath,
    running: !!server,
    ready,
  };
}

// ---------------------------------------------------------------------------
// Сервер
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function handleSocket(sock) {
  sockets.add(sock);
  sock.setEncoding('utf8');
  let buf = '';
  const reply = (msg) => { if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`); };

  const handle = async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { reply({ id: null, error: 'Неверный JSON' }); return; }
    const id = req && req.id !== undefined ? req.id : null;
    if (!req || !safeEqual(req.token, token)) { reply({ id, error: 'Неверный ключ доступа' }); sock.destroy(); return; }
    try {
      let result;
      switch (req.method) {
        case 'ping':
          result = { ok: true, version: version(), pid: process.pid, ready: !!(ready && liveWindow()), window: !!liveWindow() };
          break;
        case 'call': {
          const params = req.params || {};
          result = await callTool(params.tool, params.args);
          break;
        }
        case 'quit':
          if (process.env.FFM_ALLOW_QUIT !== '1') throw new Error('Метод quit запрещён');
          reply({ id, result: { ok: true } });
          setTimeout(() => { stop(); ctx.app.exit(0); }, 100);
          return;
        default:
          throw new Error(`Неизвестный метод: ${req.method}`);
      }
      reply({ id, result: result === undefined ? null : result });
    } catch (e) {
      reply({ id, error: String((e && e.message) || e) });
    }
  };

  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => sockets.delete(sock));
}

function writeEndpoint() {
  const data = { pipe: pipePath, token, pid: process.pid, version: version(), appDir: ctx.PATHS.APP_DIR, started: new Date().toISOString() };
  fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
  const tmp = `${endpointFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ } }
  fs.renameSync(tmp, endpointFile);
}

function start({ PATHS, getWindow, app }) {
  if (server) return;
  ctx = { PATHS, getWindow, app };
  registerIpc();
  token = crypto.randomBytes(32).toString('hex');
  pipePath = makePipePath(PATHS);
  endpointFile = path.join(PATHS.APP_CACHE, 'mcp-endpoint.json');

  // Устаревший сокет от упавшего процесса (второй экземпляр программы с тем же кэшем не запустится)
  if (process.platform !== 'win32') { try { fs.unlinkSync(pipePath); } catch { /* нет файла */ } }

  const srv = net.createServer(handleSocket);
  srv.on('error', (e) => {
    console.error('[mcp] control server error:', e && e.message);
    if (server === srv) server = null;
  });
  srv.listen(pipePath, () => {
    server = srv;
    if (process.platform !== 'win32') { try { fs.chmodSync(pipePath, 0o600); } catch { /* ignore */ } }
    try { writeEndpoint(); } catch (e) { console.error('[mcp] endpoint file:', e.message); }
  });
  server = srv;
}

function stop() {
  failAll('FF Montage закрывается.');
  for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
  sockets.clear();
  if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
  if (endpointFile) {
    try {
      const cur = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(endpointFile);
    } catch { /* нет файла */ }
  }
  if (pipePath && process.platform !== 'win32') { try { fs.unlinkSync(pipePath); } catch { /* ignore */ } }
}

module.exports = { start, stop, info };
