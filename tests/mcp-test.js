'use strict';
// Сквозная проверка ИИ-ассистента (MCP): MCP-сервер по stdio → программа FF Montage → результат.
//
// Запуск:  node tests/mcp-test.js            (или electron с ELECTRON_RUN_AS_NODE=1)
// Нужны тестовые файлы tests/engine-test.js (папка <кэш>/tmp/engine-test).
//
// Программа запускается с ОТДЕЛЬНЫМ config.json (FFM_CONFIG) и отдельным кэшем в <кэш>/tmp/mcp-test,
// поэтому ваш проект и автосохранение не затрагиваются. В конце программа закрывается.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');

// Папки: рядом с тестовыми файлами engine-test (в кэше из основного config.json)
function realCacheDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8'));
    if (cfg.cacheDir) return path.resolve(APP_DIR, cfg.cacheDir);
  } catch { /* программа не настроена */ }
  return path.join(APP_DIR, '.test-cache');
}
const REAL_CACHE = realCacheDir();
const MEDIA_DIR = process.env.MCP_TEST_MEDIA || path.join(REAL_CACHE, 'tmp', 'engine-test');
const BASE = process.env.MCP_TEST_DIR || path.join(REAL_CACHE, 'tmp', 'mcp-test');
const CACHE = path.join(BASE, 'cache');
const OUT = path.join(BASE, 'out');
const PROJ = path.join(BASE, 'proj');
const CONFIG = path.join(BASE, 'config.json');
const ENDPOINT = path.join(CACHE, 'app', 'mcp-endpoint.json');

// Защита: тест никогда не работает с настоящим кэшем программы
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (same(CACHE, REAL_CACHE) || same(path.join(CACHE, 'app'), path.join(REAL_CACHE, 'app'))) {
  console.error('Тестовый кэш совпадает с настоящим — отказ.');
  process.exit(2);
}

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { failures++; console.log(`  ПРОВАЛ  ${msg}`); }
  return cond;
}
function must(cond, msg) { if (!ok(cond, msg)) throw new Error(`ПРОВАЛ: ${msg}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------------------------------------------------------------------------
// Подготовка
// ---------------------------------------------------------------------------
function readEndpoint() { try { return JSON.parse(fs.readFileSync(ENDPOINT, 'utf8')); } catch { return null; } }

async function killOldInstance() {
  const ep = readEndpoint();
  if (ep && ep.pid && alive(ep.pid)) {
    console.log(`Закрываю оставшуюся тестовую копию программы (pid ${ep.pid})`);
    try { process.kill(ep.pid); } catch { /* ignore */ }
    for (let i = 0; i < 40 && alive(ep.pid); i++) await sleep(250);
  }
}

function prepareDirs() {
  for (const d of [CACHE, OUT, PROJ]) fs.mkdirSync(d, { recursive: true });
  // Чистый старт: автосохранение и окно — только в тестовом кэше
  const autosave = path.join(CACHE, 'app', 'autosave.ffproj');
  if (autosave.startsWith(path.resolve(BASE))) fs.rmSync(autosave, { force: true });
  // mcp-endpoint.json от прошлого запуска не удаляем: сервер должен сам понять, что он устарел
  fs.writeFileSync(CONFIG, JSON.stringify({
    _comment: 'Автотест MCP (tests/mcp-test.js). Можно удалить.',
    version: 1, cacheDir: CACHE, outputDir: OUT, projectsDir: PROJ, ffmpegDir: '',
  }, null, 2));
}

// Чем запускать MCP-сервер: так же, как предлагает окно «ИИ-ассистент» — сама программа с ключом --mcp
function serverCommand() {
  const name = process.platform === 'win32' ? 'ff-montage.exe' : 'ff-montage';
  const c = [process.env.FFM_EXE, path.join(APP_DIR, 'src-tauri', 'target', 'release', name), path.join(APP_DIR, 'src-tauri', 'target', 'debug', name)].filter(Boolean);
  const exe = c.find((p) => fs.existsSync(p));
  if (!exe) { console.error('Программа не собрана (cargo build --release в src-tauri)'); process.exit(2); }
  return exe;
}

// ---------------------------------------------------------------------------
// JSON-RPC клиент по stdio
// ---------------------------------------------------------------------------
class Client {
  constructor() {
    const cmd = serverCommand();
    console.log(`MCP-сервер: ${path.basename(cmd)} --mcp`);
    this.proc = spawn(cmd, ['--mcp'], {
      cwd: BASE,
      stdio: ['pipe', 'pipe', 'pipe'],
      // FFM_SELFTEST мог остаться от run-ui.ps1 в той же консоли — тогда программа выполнила бы автотест и закрылась
      env: { ...process.env, FFM_CONFIG: CONFIG, FFM_ALLOW_QUIT: '1', FFM_SELFTEST: '', FFM_SHOT: '', FFM_KEEP_OPEN: '' },
      windowsHide: true,
    });
    this.seq = 0;
    this.waiting = new Map();
    this.badLines = [];
    this.stderr = '';
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { this.badLines.push(line); continue; }
        if (msg.jsonrpc !== '2.0') this.badLines.push(line);
        const w = this.waiting.get(msg.id);
        if (w) { this.waiting.delete(msg.id); w(msg); }
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d; if (process.env.MCP_TEST_VERBOSE) process.stderr.write(d); });
    this.exited = new Promise((r) => this.proc.on('exit', r));
  }

  rpc(method, params, timeoutMs = 120000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error(`нет ответа на ${method}`)); }, timeoutMs);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }

  // Вызов инструмента: { raw, isError, text, json, content }
  async tool(name, args = {}, timeoutMs = 180000) {
    const m = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
    if (m.error) throw new Error(`${name}: JSON-RPC ошибка ${m.error.code} ${m.error.message}`);
    const content = m.result.content || [];
    const textItem = content.find((c) => c.type === 'text');
    const text = textItem ? textItem.text : '';
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { raw: m, isError: !!m.result.isError, text, json, content };
  }

  async ok(name, args, timeoutMs) {
    const r = await this.tool(name, args, timeoutMs);
    if (r.isError) throw new Error(`${name} вернул ошибку: ${r.text}`);
    return r.json !== null ? r.json : r;
  }
}

// Закрыть программу через канал управления (метод quit разрешён только с FFM_ALLOW_QUIT=1)
function quitApp(ep) {
  return new Promise((resolve) => {
    const s = net.createConnection(ep.pipe, () => s.write(`${JSON.stringify({ id: 1, token: ep.token, method: 'quit' })}\n`));
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', (e) => resolve({ error: e.message }));
    setTimeout(() => { s.destroy(); resolve({ error: 'timeout' }); }, 5000);
  });
}

// ---------------------------------------------------------------------------
// Тест
// ---------------------------------------------------------------------------
async function main() {
  const files = {
    a: path.join(MEDIA_DIR, 'a_av1_1440p60.mp4'),
    b: path.join(MEDIA_DIR, 'b_h264_1080p30.mp4'),
    c: path.join(MEDIA_DIR, 'c_music.mp3'),
  };
  for (const f of Object.values(files)) {
    if (!fs.existsSync(f)) { console.error(`Нет тестового файла ${f}. Сначала запустите: node tests/engine-test.js`); process.exit(2); }
  }
  await killOldInstance();
  prepareDirs();
  console.log(`Тестовая папка: ${BASE}`);

  const cl = new Client();
  let appPid = null;
  try {
    console.log('Протокол:');
    const init = await cl.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1' } });
    must(init.result && init.result.protocolVersion === '2025-06-18', 'initialize: версия протокола 2025-06-18');
    ok(init.result.capabilities && init.result.capabilities.tools, 'initialize: есть capabilities.tools');
    ok(init.result.serverInfo && init.result.serverInfo.name === 'ff-montage', 'initialize: serverInfo');
    const init2 = await cl.rpc('initialize', { protocolVersion: '1999-01-01' });
    ok(init2.result.protocolVersion === '2025-06-18', 'initialize: неизвестная версия → 2025-06-18');
    cl.notify('notifications/initialized');
    const list = await cl.rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    const expected = ['get_project', 'import_media', 'add_clip', 'update_clip', 'split_clip', 'delete_clip', 'reverse_clip',
      'freeze_frame', 'set_transition', 'close_gaps', 'undo', 'redo', 'set_playhead', 'new_project', 'open_project',
      'save_project', 'export_video', 'export_status', 'cancel_export', 'get_frame', 'detect_silence'];
    ok(expected.every((n) => names.includes(n)), `tools/list: ${names.length} инструментов`);
    ok(list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'у всех инструментов есть описание и схема');
    const unk = await cl.rpc('no/such/method', {});
    ok(unk.error && unk.error.code === -32601, 'неизвестный метод → -32601');
    ok((await cl.rpc('ping')).result !== undefined, 'ping');

    console.log('Запуск программы и проект (до 45 с):');
    const t0 = Date.now();
    const np = await cl.ok('new_project', { name: 'MCP тест', force: true }, 120000);
    console.log(`     программа ответила через ${((Date.now() - t0) / 1000).toFixed(1)} с`);
    ok(np.name === 'MCP тест' && np.video_clips === 0, 'new_project: пустой проект с именем');
    const ep = readEndpoint();
    must(ep && ep.pid && ep.token && ep.pipe, 'файл mcp-endpoint.json в тестовом кэше');
    appPid = ep.pid;

    console.log('Монтаж:');
    const imp = await cl.ok('import_media', { paths: [files.a, files.b, files.c, path.join(BASE, 'нет-такого.mp4')] }, 120000);
    must(imp.imported.length === 3, `import_media: импортировано 3 файла (${imp.imported.map((m) => m.name).join(', ')})`);
    ok(imp.failed.length === 1 && /not found/.test(imp.failed[0].reason), 'import_media: несуществующий файл в failed');
    const [ma, mb, mc] = [files.a, files.b, files.c].map((f) => imp.imported.find((m) => m.path.toLowerCase() === f.toLowerCase()));
    ok(ma.has_video && ma.width === 2560 && mc.has_audio && !mc.has_video, 'import_media: сведения о файлах');

    const bad = await cl.tool('add_clip', { media_id: 'med_nope', track: 'video' });
    ok(bad.isError && /not found/.test(bad.text), 'ошибка инструмента → isError с понятным текстом');
    const bad2 = await cl.tool('add_clip', { media_id: mc.id, track: 'video' });
    ok(bad2.isError && /no video/.test(bad2.text), 'add_clip: музыку нельзя на видеодорожку');

    const ca = (await cl.ok('add_clip', { media_id: ma.id, track: 'video', source_in: 0, source_out: 4 })).clip;
    ok(ca.start === 0 && ca.duration === 4, `add_clip A: 0–4 с (${ca.start}–${ca.end})`);
    const cb = (await cl.ok('add_clip', { media_id: mb.id, track: 'video', source_in: 0, source_out: 3 })).clip;
    ok(cb.start === 4 && cb.end === 7, `add_clip B в конец: ${cb.start}–${cb.end}`);
    const cm = (await cl.ok('add_clip', { media_id: mc.id, track: 'audio', start: 0, source_out: 7 })).clip;
    ok(cm.kind === 'audio' && cm.audio_track_id && cm.duration === 7, 'add_clip музыки на аудиодорожку');

    const sp = await cl.ok('split_clip', { time: 2 });
    ok(sp.left.id === ca.id && sp.left.end === 2 && sp.right && sp.right.start === 2 && sp.right.source_in === 2, 'split_clip на 2 с: две половины');

    // Пустота: сдвигаем B на 6 с, затем close_gaps
    const mv = (await cl.ok('update_clip', { clip_id: cb.id, start: 6, volume: 0.5, fade_out: 0.5 })).clip;
    ok(mv.start === 6 && mv.volume === 0.5 && mv.fade_out === 0.5, 'update_clip: перенос на 6 с, громкость, затухание');
    let pj = await cl.ok('get_project');
    ok(pj.video_track.gaps.some(([a, b]) => a === 4 && b === 6), `get_project: пустота 4–6 с (${JSON.stringify(pj.video_track.gaps)})`);
    const trBad = await cl.tool('set_transition', { clip_id: cb.id, type: 'fade' });
    ok(trBad.isError && /gap/.test(trBad.text), 'set_transition через пустоту → понятная ошибка');
    const cg = await cl.ok('close_gaps', { track: 'video' });
    ok(cg.closed === 1 && cg.gaps_left.length === 0, 'close_gaps: пустота убрана');

    const tr = await cl.ok('set_transition', { clip_id: cb.id, type: 'wipeleft', duration: 0.8 });
    ok(tr.transition && tr.transition.type === 'wipeleft' && tr.transition.duration === 0.8 && tr.transition.at === 4, 'set_transition wipeleft 0.8 с на 4 с');
    const trBad2 = await cl.tool('set_transition', { clip_id: cb.id, type: 'spin' });
    ok(trBad2.isError, 'set_transition: неизвестный тип → ошибка');

    pj = await cl.ok('get_project');
    ok(pj.video_track.clips.length === 3 && pj.audio_tracks[0].clips.length === 1, 'get_project: 3 видеоклипа и 1 аудиоклип');
    ok(pj.transitions.length === 1 && pj.duration === 7, `get_project: 1 переход, длительность ${pj.duration} = 7`);
    ok(pj.media.length === 3 && pj.can_undo, 'get_project: 3 файла, есть отмена');

    const un = await cl.ok('undo');
    pj = await cl.ok('get_project');
    ok(un.done && pj.transitions.length === 0, 'undo убирает переход');
    await cl.ok('redo');
    pj = await cl.ok('get_project');
    ok(pj.transitions.length === 1, 'redo возвращает переход');

    const ph = await cl.ok('set_playhead', { time: 3 });
    ok(ph.playhead === 3, 'set_playhead');

    console.log('Взгляд на видео и звук:');
    const fr = await cl.tool('get_frame', { time: 1, width: 320 });
    const img = fr.content.find((c) => c.type === 'image');
    ok(!fr.isError && img && img.mimeType === 'image/jpeg' && img.data.length > 1000 && Buffer.from(img.data, 'base64').slice(0, 2).toString('hex') === 'ffd8',
      `get_frame(time): JPEG ${img ? Math.round(img.data.length * 0.75 / 1024) : 0} КБ`);
    if (img) fs.writeFileSync(path.join(OUT, 'frame.jpg'), Buffer.from(img.data, 'base64'));
    const fr2 = await cl.tool('get_frame', { media_id: mb.id, source_time: 1 });
    ok(!fr2.isError && fr2.content.some((c) => c.type === 'image'), 'get_frame(media_id, source_time)');
    const fr3 = await cl.tool('get_frame', { time: 100 });
    ok(fr3.isError, 'get_frame за концом ролика → ошибка');

    const sil = await cl.ok('detect_silence', { media_id: mc.id, threshold_db: -35, min_duration: 0.3 }, 120000);
    ok(Array.isArray(sil.silences) && typeof sil.total_silence === 'number', `detect_silence(media): найдено пауз ${sil.count}`);
    const sil2 = await cl.ok('detect_silence', { clip_id: cm.id }, 120000);
    ok(Array.isArray(sil2.silences), `detect_silence(clip): найдено пауз ${sil2.count}`);

    console.log('Сохранение и экспорт:');
    const sv = await cl.ok('save_project', { path: path.join(PROJ, 'mcp-test') });
    ok(sv.path && fs.existsSync(sv.path) && /\.ffproj$/.test(sv.path), `save_project → ${path.basename(sv.path)}`);
    const saved = JSON.parse(fs.readFileSync(sv.path, 'utf8'));
    ok(saved.project && saved.project.videoClips.length === 3, 'файл проекта содержит 3 видеоклипа');

    const outFile = path.join(OUT, 'mcp-test.mp4');
    fs.rmSync(outFile, { force: true });
    const ex = await cl.ok('export_video', { path: outFile, codec: 'h264', quality: 'compact', resolution: '720', fps: 30 });
    ok(ex.started && ex.state === 'running' && ex.settings.height === 720 && ex.settings.width === 1280, `export_video запущен (${ex.settings.encoder}, ${ex.settings.width}×${ex.settings.height})`);
    const exBusy = await cl.tool('export_video', {});
    ok(exBusy.isError && /already running/.test(exBusy.text), 'второй экспорт одновременно → ошибка');
    let st = ex;
    const tEnd = Date.now() + 10 * 60 * 1000;
    while (st.state === 'running' && Date.now() < tEnd) {
      st = await cl.ok('export_status', { wait: 20 });
      if (st.state === 'running') console.log(`     … ${st.percent}%`);
    }
    must(st.state === 'done', `export_status: готово (${st.state}${st.error ? `: ${st.error}` : ''})`);
    ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 10000, `файл ${path.basename(outFile)}: ${(fs.statSync(outFile).size / 1024).toFixed(0)} КБ`);
    ok(Math.abs(st.duration - 7) < 0.05, `длительность экспорта ${st.duration} с`);

    console.log('Эффекты:');
    const rv = await cl.ok('reverse_clip', { clip_id: cb.id }, 300000);
    ok(rv.reversed && rv.clip.reversed && rv.clip.source_in === 0 && rv.clip.source_out === 3, `reverse_clip: реверс (исходник ${rv.clip.source_in}–${rv.clip.source_out} с)`);
    pj = await cl.ok('get_project');
    ok(pj.media.length === 3, 'get_project: производный файл реверса не показан как отдельное медиа');
    const rv2 = await cl.ok('reverse_clip', { clip_id: cb.id }, 300000);
    ok(!rv2.reversed && !rv2.clip.reversed, 'reverse_clip повторно: обычное направление');
    const fz = await cl.ok('freeze_frame', { time: 1, duration: 1.5 }, 300000);
    ok(fz.clip && fz.clip.freeze && fz.clip.start === 1 && fz.clip.duration === 1.5, 'freeze_frame: стоп-кадр 1,5 с на 1 с');
    pj = await cl.ok('get_project');
    ok(pj.video_track.clips.length === 5 && Math.abs(pj.duration - 8.5) < 0.01, `после стоп-кадра 5 клипов, ${pj.duration} с`);
    const dl = await cl.ok('delete_clip', { clip_id: fz.clip.id, ripple: true });
    pj = await cl.ok('get_project');
    ok(dl.ripple && pj.video_track.gaps.length === 0 && pj.video_track.clips.length === 4, 'delete_clip ripple: без пустоты');
    const fd = await cl.tool('get_frame', { time: 0.5 });
    ok(!fd.isError, 'get_frame после правок');

    console.log('Открытие проекта:');
    await cl.ok('new_project', { force: true });
    const op = await cl.ok('open_project', { path: sv.path });
    ok(op.video_clips === 3 && op.file_path && same(op.file_path, sv.path), 'open_project: проект открыт заново');
    await cl.ok('update_clip', { clip_id: cm.id, volume: 0.3 });
    const guard = await cl.tool('new_project', {});
    ok(guard.isError && /unsaved/.test(guard.text), 'new_project без force при несохранённых изменениях → отказ');

    ok(cl.badLines.length === 0, `в stdout только JSON-RPC (${cl.badLines.length} посторонних строк)`);
  } finally {
    const ep = readEndpoint();
    if (ep) {
      const q = await quitApp(ep);
      ok(q.result && q.result.ok, 'программа закрыта командой quit');
      for (let i = 0; i < 40 && alive(ep.pid); i++) await sleep(250);
      ok(!alive(ep.pid), 'процесс программы завершился');
      await sleep(300);
      ok(!fs.existsSync(ENDPOINT), 'mcp-endpoint.json удалён при выходе');
      if (alive(ep.pid)) { try { process.kill(ep.pid); } catch { /* ignore */ } }
    } else if (appPid && alive(appPid)) {
      try { process.kill(appPid); } catch { /* ignore */ }
    }
    cl.proc.stdin.end();
    await Promise.race([cl.exited, sleep(3000)]);
    if (failures && cl.stderr) console.log(`--- stderr MCP-сервера ---\n${cl.stderr.trim()}`);
  }
  // Программа не настроена (нет config.json) → понятная ошибка, приложение не запускается
  {
    const p = spawn(serverCommand(), ['--mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, FFM_CONFIG: path.join(BASE, 'no-such-config.json') } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } })}\n`);
    for (let i = 0; i < 40 && !out.includes('\n'); i++) await sleep(100);
    p.stdin.end();
    let msg = null; try { msg = JSON.parse(out.split('\n')[0]); } catch { /* ignore */ }
    ok(msg && msg.result && msg.result.isError && /not set up/.test(msg.result.content[0].text), 'без config.json → «сначала запустите FF Montage и выберите папки»');
  }
  console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nВсе проверки MCP пройдены.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
