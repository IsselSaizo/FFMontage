#!/usr/bin/env node
'use strict';
// MCP-сервер FF Montage: позволяет ИИ-ассистенту (Claude Desktop, Cursor, VS Code…) монтировать в программе.
//
// Транспорт — stdio, JSON-RPC 2.0 по одной строке на сообщение, без npm-зависимостей.
// Запуск: electron с ELECTRON_RUN_AS_NODE=1 (тот же, что у программы) или node ≥ 18:
//   ELECTRON_RUN_AS_NODE=1 <electron> mcp/ff-montage-mcp.js
// В stdout пишутся только сообщения JSON-RPC, журнал — в stderr.
//
// Сервер сам ничего не монтирует: он передаёт вызовы инструментов в окно программы через локальный
// канал (src/main/control.js). Адрес канала и секретный ключ — в <кэш>/app/mcp-endpoint.json.
// Если программа не запущена — сервер запускает её и ждёт до 45 с.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = process.env.FFM_CONFIG ? path.resolve(process.env.FFM_CONFIG) : path.join(APP_DIR, 'config.json');
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL = '2025-06-18';
const LAUNCH_WAIT_MS = 45000;
const CALL_TIMEOUT_MS = 16 * 60 * 1000;

const log = (...a) => { try { process.stderr.write(`[ff-montage-mcp] ${a.join(' ')}\n`); } catch { /* ignore */ } };

let APP_VERSION = '0.0.0';
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || APP_VERSION; } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------
const TRANSITION_IDS = ['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'zoomin', 'hblur', 'blinds'];

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'get_project',
    title: 'Get project',
    description: 'Return the whole project state: media library (ids, paths, durations, resolution, fps), the main video track '
      + '(clips with timeline start/end and source in/out, volume, fades, transitions, reversed/freeze flags), audio tracks, '
      + 'gaps, playhead, undo/redo availability and export status. All times are in seconds. Call this first and after edits.',
    inputSchema: obj(),
    annotations: RO,
  },
  {
    name: 'import_media',
    title: 'Import media files',
    description: 'Add video/audio files from disk to the project media library (does not put them on the timeline). '
      + 'Paths must be absolute. Returns media ids with duration (seconds), resolution, fps and whether the file has video/audio. '
      + 'Importing the same file twice returns the existing id.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' } }, ['paths']),
    annotations: EDIT,
  },
  {
    name: 'add_clip',
    title: 'Add clip to timeline',
    description: 'Place a media file (or a part of it) on the timeline. track "video" = the single main video track '
      + '(the clip also carries the file\'s own sound); track "audio" = an audio track (music, voice-over). '
      + 'Video without start is appended to the end of the video track. If start is given and the place is occupied, the clip snaps '
      + 'to a nearby gap or is inserted before/after the clip it hits (later clips move right); with insert=true it is placed exactly '
      + 'at start and later clips are pushed right. Audio without start goes to 0 s; if the chosen track is busy, a free or new '
      + 'track is used. source_in/source_out select the fragment of the file (seconds, default whole file).',
    inputSchema: obj({
      media_id: str('Media id from import_media/get_project'),
      track: { type: 'string', enum: ['video', 'audio'], description: 'Target track kind' },
      start: num('Timeline position of the clip start, seconds', { minimum: 0 }),
      source_in: num('Fragment start inside the file, seconds (default 0)', { minimum: 0 }),
      source_out: num('Fragment end inside the file, seconds (default = file duration)', { minimum: 0 }),
      audio_track_id: str('For track "audio": audio track id from get_project, or "new" for a new track'),
      insert: bool('Video only: place exactly at start and push later clips right (default false)'),
    }, ['media_id', 'track']),
    annotations: EDIT,
  },
  {
    name: 'update_clip',
    title: 'Update clip',
    description: 'Change a clip: trim (source_in/source_out or duration, seconds), move (start, seconds; video clips push the '
      + 'following clips right if needed, unless the place is free), volume (0..2, 1 = original), muted, fades (fade_in/fade_out, '
      + 'seconds), name, or move an audio clip to another audio track (audio_track_id or "new"). Trimming leaves a gap — use '
      + 'close_gaps to remove it. For reversed clips source_in/source_out are in the ORIGINAL file time and must stay within '
      + 'the reversed fragment.',
    inputSchema: obj({
      clip_id: str('Clip id'),
      start: num('New timeline start, seconds', { minimum: 0 }),
      source_in: num('New fragment start inside the file, seconds', { minimum: 0 }),
      source_out: num('New fragment end inside the file, seconds', { minimum: 0 }),
      duration: num('New clip length, seconds (changes source_out; useful for freeze frames)', { minimum: 0.1 }),
      volume: num('Clip volume 0..2 (1 = original, 0 = silent)', { minimum: 0, maximum: 2 }),
      muted: bool('Mute the clip sound'),
      fade_in: num('Fade-in length, seconds (0 = none)', { minimum: 0 }),
      fade_out: num('Fade-out length, seconds (0 = none)', { minimum: 0 }),
      name: str('Display name ("" = file name)'),
      audio_track_id: str('Audio clips only: move to this audio track id, or "new"'),
      insert: bool('Video only, with start: place exactly at start and push later clips right'),
    }, ['clip_id']),
    annotations: EDIT,
  },
  {
    name: 'split_clip',
    title: 'Split clip',
    description: 'Cut a clip into two at a timeline time (seconds). Without clip_id the video clip under that time is split; '
      + 'pass clip_id to split an audio clip. The cut must be at least 0.1 s from the clip edges. Returns both halves.',
    inputSchema: obj({ time: num('Timeline time of the cut, seconds', { minimum: 0 }), clip_id: str('Clip to split (optional)') }, ['time']),
    annotations: EDIT,
  },
  {
    name: 'delete_clip',
    title: 'Delete clip',
    description: 'Remove a clip from the timeline (the file stays in the media library). ripple=true shifts the following clips '
      + 'of the same track left by the clip length, so no gap remains.',
    inputSchema: obj({ clip_id: str('Clip id'), ripple: bool('Close the resulting gap (default false)') }, ['clip_id']),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'reverse_clip',
    title: 'Reverse clip',
    description: 'Toggle reverse playback of a video clip fragment (plays backwards). FFmpeg renders the reversed fragment, which may '
      + 'take a while for long clips. Calling again restores normal direction.',
    inputSchema: obj({ clip_id: str('Video clip id') }, ['clip_id']),
    annotations: EDIT,
  },
  {
    name: 'freeze_frame',
    title: 'Freeze frame',
    description: 'Insert a still frame of the video at a timeline time: the clip is split there, a freeze-frame clip of the given '
      + 'duration is inserted and everything to the right moves right by that duration.',
    inputSchema: obj({
      time: num('Timeline time, seconds (default: playhead)', { minimum: 0 }),
      duration: num('Freeze length, seconds (default 3)', { minimum: 0.1 }),
    }),
    annotations: EDIT,
  },
  {
    name: 'set_transition',
    title: 'Set transition',
    description: 'Set the transition between two adjacent video clips. clip_id is the SECOND clip of the junction (the one the '
      + 'transition leads into); it must start exactly where the previous clip ends (no gap — use close_gaps first). '
      + `type: one of ${TRANSITION_IDS.join(', ')}, or "none" to remove. duration in seconds (0.1..3, default 0.5; limited by clip lengths). `
      + 'The transition is centred on the cut and does not change the total length.',
    inputSchema: obj({
      clip_id: str('Id of the second clip of the junction'),
      type: { type: 'string', enum: [...TRANSITION_IDS, 'none'], description: 'Transition id or "none"' },
      duration: num('Transition length, seconds (0.1..3)', { minimum: 0.1, maximum: 3 }),
    }, ['clip_id', 'type']),
    annotations: EDIT,
  },
  {
    name: 'close_gaps',
    title: 'Close gaps',
    description: 'Remove empty space on a track by shifting clips left. track: "video" or an audio track id. With time (seconds) only '
      + 'the gap containing that time is closed; otherwise all gaps on the track (including the one at the start). '
      + 'Other tracks are not moved.',
    inputSchema: obj({ track: str('"video" or audio track id'), time: num('A time inside the gap to close, seconds', { minimum: 0 }) }, ['track']),
    annotations: EDIT,
  },
  { name: 'undo', title: 'Undo', description: 'Undo the last edit (same as Ctrl+Z in the app).', inputSchema: obj(), annotations: EDIT },
  { name: 'redo', title: 'Redo', description: 'Redo the last undone edit (same as Ctrl+Y).', inputSchema: obj(), annotations: EDIT },
  {
    name: 'set_playhead',
    title: 'Set playhead',
    description: 'Move the playhead (preview position) to a timeline time in seconds, so the user sees that moment.',
    inputSchema: obj({ time: num('Timeline time, seconds', { minimum: 0 }) }, ['time']),
    annotations: { ...EDIT, idempotentHint: true },
  },
  {
    name: 'new_project',
    title: 'New project',
    description: 'Start a new empty project. Fails if the current project has unsaved changes unless force=true '
      + '(ask the user before forcing; or save_project first).',
    inputSchema: obj({ name: str('Project name'), force: bool('Discard unsaved changes') }),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'open_project',
    title: 'Open project',
    description: 'Open a saved .ffproj project file (absolute path). Fails if the current project has unsaved changes unless force=true.',
    inputSchema: obj({ path: str('Absolute path to .ffproj'), force: bool('Discard unsaved changes') }, ['path']),
    annotations: DESTRUCTIVE,
  },
  {
    name: 'save_project',
    title: 'Save project',
    description: 'Save the project as a .ffproj file. Without path: saves to the current file, or to the projects folder with the '
      + 'project name if it was never saved. Returns the path.',
    inputSchema: obj({ path: str('Absolute path (.ffproj is appended if missing)') }),
    annotations: EDIT,
  },
  {
    name: 'export_video',
    title: 'Export video',
    description: 'Render the timeline to an MP4 file in the background and return immediately; poll export_status. '
      + 'codec: av1 (smallest, default), hevc, h264 (most compatible); NVIDIA GPU is used when available. quality: high (default), '
      + 'medium, compact. resolution: source (default) or 2160/1440/1080/720 (height, keeps aspect). fps: frames per second '
      + '(default: as source). Without path the file goes to the output folder named after the project.',
    inputSchema: obj({
      path: str('Absolute output path (.mp4 is appended if missing); existing file is replaced'),
      codec: { type: 'string', enum: ['av1', 'hevc', 'h264'], description: 'Video codec' },
      quality: { type: 'string', enum: ['high', 'medium', 'compact'], description: 'Quality / size trade-off' },
      resolution: { type: 'string', enum: ['source', '2160', '1440', '1080', '720'], description: 'Output height or "source"' },
      fps: num('Output frame rate (e.g. 30, 60)', { minimum: 1, maximum: 240 }),
    }),
    annotations: EDIT,
  },
  {
    name: 'export_status',
    title: 'Export status',
    description: 'State of the current/last export: idle, running (fraction 0..1, eta seconds), done (output path, size), error or '
      + 'cancelled. wait (seconds, up to 120) blocks until the export finishes or the time passes, to avoid frequent polling.',
    inputSchema: obj({ wait: num('Wait up to N seconds for completion (0..120)', { minimum: 0, maximum: 120 }) }),
    annotations: RO,
  },
  { name: 'cancel_export', title: 'Cancel export', description: 'Stop the running export (the partial file is deleted).', inputSchema: obj(), annotations: DESTRUCTIVE },
  {
    name: 'get_frame',
    title: 'Get frame',
    description: 'Look at the video: returns a JPEG image of one frame. Either time (timeline seconds; shows the source frame of the '
      + 'video clip there, without fades/transitions; in a gap the result is a black frame) or media_id + source_time '
      + '(seconds inside the file). width: image width in pixels (default 640, max 1920).',
    inputSchema: obj({
      time: num('Timeline time, seconds', { minimum: 0 }),
      media_id: str('Media id (instead of time)'),
      source_time: num('Time inside the media file, seconds (with media_id)', { minimum: 0 }),
      width: num('Image width, pixels (64..1920, default 640)', { minimum: 64, maximum: 1920 }),
    }),
    annotations: RO,
  },
  {
    name: 'detect_silence',
    title: 'Detect silence',
    description: 'Find quiet parts of the sound (pauses in speech, silence) with FFmpeg silencedetect. Give media_id (times in the file) '
      + 'or clip_id (only inside the clip fragment; also returns timeline times). threshold_db: loudness below which is silence '
      + '(default -35 dB; -50 stricter, -25 looser). min_duration: shortest pause to report, seconds (default 0.5).',
    inputSchema: obj({
      media_id: str('Media id'),
      clip_id: str('Clip id (instead of media_id)'),
      threshold_db: num('Silence threshold, dB (default -35)', { minimum: -90, maximum: 0 }),
      min_duration: num('Minimum silence length, seconds (default 0.5)', { minimum: 0.05, maximum: 60 }),
    }),
    annotations: RO,
  },
];

const INSTRUCTIONS = [
  'FF Montage is a desktop video editor; these tools edit the project open in its window (the user sees every change and can undo with Ctrl+Z).',
  'Model: one main video track (clips in time order, gaps allowed, transitions only between adjacent clips) plus audio tracks for music/voice. All times are seconds.',
  'Workflow: get_project → import_media (absolute paths) → add_clip (track "video"/"audio") → trim/move with update_clip, split_clip, delete_clip (ripple), close_gaps → set_transition (clip_id = second clip of the cut) → get_frame / detect_silence to inspect → save_project → export_video, then export_status with wait.',
  'Ids come from get_project; re-read it after edits because splitting creates new clip ids.',
  'Do not use force=true in new_project/open_project without asking the user.',
].join('\n');

// ---------------------------------------------------------------------------
// Связь с программой
// ---------------------------------------------------------------------------
function readConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { cfg = null; }
  if (!cfg || typeof cfg.cacheDir !== 'string' || !cfg.cacheDir) {
    throw new Error(`FF Montage is not set up yet (${CONFIG_FILE} not found). First start FF Montage and choose the folders `
      + '(сначала запустите FF Montage и выберите папки), then try again.');
  }
  return cfg;
}

function endpointPath() {
  const cfg = readConfig();
  return path.join(path.resolve(APP_DIR, cfg.cacheDir), 'app', 'mcp-endpoint.json');
}

function readEndpoint() {
  try {
    const e = JSON.parse(fs.readFileSync(endpointPath(), 'utf8'));
    return e && e.pipe && e.token ? e : null;
  } catch (err) {
    if (err && /not set up/.test(err.message)) throw err;
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function electronPath() {
  if (process.versions.electron) return process.execPath;
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const list = [path.join(APP_DIR, 'vendor', 'electron', exe), path.join(APP_DIR, 'node_modules', 'electron', 'dist', exe)];
  if (process.platform === 'darwin') {
    list.push(path.join(APP_DIR, 'vendor', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  }
  return list.find((p) => fs.existsSync(p)) || null;
}

let launchedAt = 0;
function launchApp() {
  const exe = electronPath();
  if (!exe) throw new Error('Electron not found next to FF Montage (vendor/electron or node_modules/electron). Run setup first.');
  const args = [APP_DIR];
  if (process.platform === 'linux') {
    let sandboxOk = false;
    try { const st = fs.statSync(path.join(path.dirname(exe), 'chrome-sandbox')); sandboxOk = st.uid === 0 && (st.mode & 0o4000) !== 0; } catch { /* нет файла */ }
    if (!sandboxOk) args.push('--no-sandbox');
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  log(`starting FF Montage: ${exe} ${args.join(' ')}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', env, cwd: APP_DIR, windowsHide: false });
  child.on('error', (e) => log(`launch failed: ${e.message}`));
  child.unref();
  launchedAt = Date.now();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AppLink {
  constructor() {
    this.sock = null;
    this.endpoint = null;
    this.pending = new Map();
    this.seq = 0;
    this.connecting = null;
  }

  // Одна попытка: открыть канал и проверить ключ
  connectOnce(ep, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(ep.pipe);
      let buf = '';
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('timeout')); } }, timeoutMs);
      sock.setEncoding('utf8');
      sock.on('connect', () => {
        sock.write(`${JSON.stringify({ id: 'hello', token: ep.token, method: 'ping' })}\n`);
      });
      sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (!done && msg.id === 'hello') {
            done = true; clearTimeout(timer);
            if (msg.error) { sock.destroy(); reject(new Error(msg.error)); return; }
            this.attach(sock, ep, buf);
            resolve(msg.result);
            return;
          }
          this.onMessage(msg);
        }
      });
      sock.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      sock.on('close', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('closed')); } });
    });
  }

  attach(sock, ep, rest) {
    this.sock = sock;
    this.endpoint = ep;
    let buf = rest || '';
    sock.removeAllListeners('data');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        this.onMessage(msg);
      }
    });
    sock.removeAllListeners('close');
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Connection to FF Montage was lost (the app was closed?).')); }
      this.pending.clear();
    });
  }

  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
  }

  async tryExisting() {
    const ep = readEndpoint();
    if (!ep || !alive(ep.pid)) return { ok: false, ep, running: false };
    try {
      await this.connectOnce(ep);
      return { ok: true };
    } catch (e) {
      // Канала нет — файл остался от упавшей программы (номер процесса мог достаться другой программе)
      const gone = e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
      return { ok: false, ep, running: !gone, error: e };
    }
  }

  async ensure() {
    if (this.sock && !this.sock.destroyed) return;
    if (!this.connecting) this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async doConnect() {
    let r = await this.tryExisting();
    if (r.ok) return;
    if (!r.running && Date.now() - launchedAt > LAUNCH_WAIT_MS) launchApp();
    const deadline = Date.now() + LAUNCH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      r = await this.tryExisting();
      if (r.ok) return;
    }
    throw new Error(r.running
      ? `FF Montage is running but does not answer (${r.error ? r.error.message : 'no connection'}). Restart FF Montage and try again.`
      : 'Could not start or reach FF Montage within 45 s. Open FF Montage manually (if a folder setup window is shown, finish it) and try again.');
  }

  async request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    await this.ensure();
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('FF Montage did not answer in time.')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(`${JSON.stringify({ id, token: this.endpoint.token, method, params })}\n`);
    });
  }
}

const link = new AppLink();

async function callTool(name, args) {
  if (!TOOLS.find((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
  let result;
  try {
    result = await link.request('call', { tool: name, args: args || {} });
  } catch (e) {
    // Канал оборвался (программу закрыли/перезапустили) — одна повторная попытка для безопасных инструментов
    if (/Connection to FF Montage was lost/.test(e.message) && (name === 'get_project' || name === 'export_status')) {
      result = await link.request('call', { tool: name, args: args || {} });
    } else throw e;
  }
  if (result && typeof result === 'object' && Array.isArray(result.__content)) return { content: result.__content };
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }] };
}

// ---------------------------------------------------------------------------
// JSON-RPC по stdio
// ---------------------------------------------------------------------------
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    // Ответ клиента на наш запрос (мы их не шлём) — игнорируем
    return null;
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ff-montage', title: 'FF Montage', version: APP_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
      if (!TOOLS.find((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        return rpcResult(id, await callTool(name, params.arguments));
      } catch (e) {
        log(`tool ${name} failed: ${e.message}`);
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { send(rpcError(null, -32700, 'Parse error')); return; }
  if (Array.isArray(msg)) {
    if (!msg.length) { send(rpcError(null, -32600, 'Invalid Request')); return; }
    const out = (await Promise.all(msg.map((m) => handle(m).catch((e) => rpcError(m && m.id, -32603, e.message))))).filter(Boolean);
    if (out.length) send(out);
    return;
  }
  let res;
  try { res = await handle(msg); } catch (e) { res = rpcError(msg && msg.id !== undefined ? msg.id : null, -32603, e.message); }
  if (res) send(res);
}

function main() {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '').trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim()) onLine(buf.trim());
    // Даём дописать ответы и выходим
    setTimeout(() => process.exit(0), 200);
  });
  process.stdout.on('error', () => process.exit(0));
  log(`ready (app ${APP_VERSION}, config ${CONFIG_FILE})`);
}

if (require.main === module) main();

module.exports = { TOOLS, TRANSITION_IDS, handle };
