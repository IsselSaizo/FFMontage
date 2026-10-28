'use strict';
// Работа с FFmpeg: поиск бинарников, анализ файлов, миниатюры, волна звука, прокси, проверка кодеков.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PATHS } = require('./paths');

// ---------------------------------------------------------------------------
// Поиск ffmpeg / ffprobe
// ---------------------------------------------------------------------------
let BIN = null;
const EXE = process.platform === 'win32' ? '.exe' : '';

function binIn(dir) {
  if (!dir) return null;
  for (const d of [dir, path.join(dir, 'bin')]) {
    const ff = path.join(d, 'ffmpeg' + EXE);
    const fp = path.join(d, 'ffprobe' + EXE);
    if (fs.existsSync(ff) && fs.existsSync(fp)) return { ffmpeg: ff, ffprobe: fp, dir: d };
  }
  return null;
}

// Порядок поиска: папка из настроек → vendor/ffmpeg (скачан setup-скриптом) →
// папка ffmpeg рядом/внутри программы → ffmpeg-* рядом с программой → PATH
function searchBinaries(configured = PATHS.FFMPEG_DIR) {
  const candidates = [];
  if (configured) return binIn(configured);
  if (process.env.FFMONTAGE_FFMPEG_DIR) candidates.push(process.env.FFMONTAGE_FFMPEG_DIR);
  candidates.push(path.join(PATHS.VENDOR_DIR, 'ffmpeg'), path.join(PATHS.APP_DIR, 'ffmpeg'));
  const parent = path.dirname(PATHS.APP_DIR);
  try {
    for (const name of fs.readdirSync(parent)) {
      if (/^ffmpeg/i.test(name)) candidates.push(path.join(parent, name));
    }
  } catch { /* ignore */ }
  for (const dir of candidates) {
    const b = binIn(dir);
    if (b) return b;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const b = dir && binIn(dir.replace(/^"|"$/g, ''));
    if (b) return b;
  }
  return null;
}

function findBinaries() {
  if (BIN) return BIN;
  BIN = searchBinaries() || { ffmpeg: 'ffmpeg' + EXE, ffprobe: 'ffprobe' + EXE, dir: null, missing: true };
  return BIN;
}

// Запуск процесса с захватом вывода
function run(cmd, args, { onStdout, binaryStdout = false, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => { if (onStdout) onStdout(d); else out.push(d); });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-100000); });
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = binaryStdout ? Buffer.concat(out) : Buffer.concat(out).toString();
      if (code === 0) resolve({ stdout, stderr: err });
      else {
        const e = new Error(`${path.basename(cmd)} завершился с кодом ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`);
        e.stderr = err;
        reject(e);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Анализ файла
// ---------------------------------------------------------------------------
const BROWSER_VIDEO_CODECS = new Set(['h264', 'av1', 'hevc', 'vp8', 'vp9']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac',
  'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);
const BROWSER_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac']);

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

async function probe(file) {
  const { ffprobe } = findBinaries();
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  let duration = parseFloat(fmt.duration);
  if (!isFinite(duration)) duration = parseFloat((v && v.duration) || (a && a.duration) || '0');
  const stat = fs.statSync(file);
  let fps = v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) : 0;
  if (fps > 240) fps = parseRate(v.r_frame_rate) || 60;
  // Поворот (запись с телефона): меняем местами ширину и высоту
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  const rot = v && v.side_data_list && v.side_data_list.find((s) => s.rotation !== undefined);
  if (rot && Math.abs(rot.rotation) % 180 === 90) [width, height] = [height, width];

  const ext = path.extname(file).toLowerCase();
  const vcodec = v ? v.codec_name : null;
  const acodec = a ? a.codec_name : null;
  const pixFmt = v ? v.pix_fmt : null;
  let needsProxy = !BROWSER_CONTAINERS.has(ext);
  if (v && !BROWSER_VIDEO_CODECS.has(vcodec)) needsProxy = true;
  if (a && !BROWSER_AUDIO_CODECS.has(acodec)) needsProxy = true;
  // На Linux окно (Chromium) аппаратно декодирует HEVC только через VA-API (Intel), на NVIDIA — нет
  if (vcodec === 'hevc' && process.platform !== 'win32' && process.platform !== 'darwin') needsProxy = true;
  // 10-битный H.264 и 4:2:2/4:4:4 браузер не играет
  if (vcodec === 'h264' && pixFmt && !/^(yuv420p|yuvj420p|nv12)$/.test(pixFmt)) needsProxy = true;

  return {
    path: file,
    name: path.basename(file),
    size: stat.size,
    mtime: stat.mtimeMs,
    duration: duration || 0,
    hasVideo: !!v,
    hasAudio: !!a,
    width, height, fps: Math.round(fps * 1000) / 1000,
    vcodec, acodec, pixFmt,
    vbitrate: v && v.bit_rate ? Number(v.bit_rate) : null,
    bitrate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
    sampleRate: a ? Number(a.sample_rate) : null,
    channels: a ? a.channels : null,
    needsProxy,
    key: cacheKey(file, stat),
  };
}

function cacheKey(file, stat) {
  return crypto.createHash('sha1')
    .update(`${path.resolve(file).toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest('hex').slice(0, 16);
}

function mediaCacheDir(info) {
  const dir = path.join(PATHS.MEDIA_CACHE, info.key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Миниатюры для таймлайна: кадр каждые `interval` секунд, только ключевые кадры (быстро)
// ---------------------------------------------------------------------------
const THUMB_HEIGHT = 90;
const MAX_THUMBS = 240;
const inflight = new Map();

function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function thumbs(info) {
  return once(`thumbs:${info.key}`, async () => {
    const dir = path.join(mediaCacheDir(info), 'thumbs');
    const meta = path.join(dir, 'thumbs.json');
    if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (!info.hasVideo) return null;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const interval = Math.max(1, info.duration / MAX_THUMBS);
    const { ffmpeg } = findBinaries();
    const common = ['-hide_banner', '-loglevel', 'error', '-y'];
    const outArgs = ['-an', '-sn', '-vf', `fps=1/${interval.toFixed(4)}:round=near,scale=-2:${THUMB_HEIGHT}`,
      '-q:v', '6', path.join(dir, '%04d.jpg')];
    try {
      // Быстрый путь: декодируем только ключевые кадры
      await run(ffmpeg, [...common, '-skip_frame', 'nokey', '-i', info.path, ...outArgs]);
    } catch {
      await run(ffmpeg, [...common, '-i', info.path, ...outArgs]);
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    const result = { interval, height: THUMB_HEIGHT, files: files.map((f) => path.join(dir, f)) };
    fs.writeFileSync(meta, JSON.stringify(result));
    return result;
  });
}

// ---------------------------------------------------------------------------
// Волна звука: пики (0..1), PEAKS_PER_SEC значений в секунду
// ---------------------------------------------------------------------------
const PEAKS_PER_SEC = 50;
const PEAK_SR = 4000;

function peaks(info) {
  return once(`peaks:${info.key}`, async () => {
    const file = path.join(mediaCacheDir(info), 'peaks.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!info.hasAudio) return null;
    const { ffmpeg } = findBinaries();
    const per = PEAK_SR / PEAKS_PER_SEC;
    const out = [];
    let cur = 0; let n = 0; let rest = Buffer.alloc(0);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', info.path, '-vn', '-sn',
      '-ac', '1', '-ar', String(PEAK_SR), '-f', 'f32le', 'pipe:1'], {
      onStdout: (chunk) => {
        const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const usable = buf.length - (buf.length % 4);
        for (let i = 0; i < usable; i += 4) {
          const s = Math.abs(buf.readFloatLE(i));
          if (s > cur) cur = s;
          if (++n >= per) { out.push(cur); cur = 0; n = 0; }
        }
        rest = buf.subarray(usable);
      },
    });
    if (n) out.push(cur);
    const max = out.reduce((m, x) => (x > m ? x : m), 0) || 1;
    // Немного «сжимаем» динамику, чтобы тихие места были видны
    const data = out.map((x) => Math.round(Math.sqrt(Math.min(1, x / max)) * 100) / 100);
    const result = { rate: PEAKS_PER_SEC, data };
    fs.writeFileSync(file, JSON.stringify(result));
    return result;
  });
}

// ---------------------------------------------------------------------------
// Прокси для форматов, которые не воспроизводятся в окне (AVI, WMV и т.п.)
// ---------------------------------------------------------------------------
function proxy(info, onProgress, encoders) {
  return once(`proxy:${info.key}`, async () => {
    const file = path.join(mediaCacheDir(info), info.hasVideo ? 'proxy.mp4' : 'proxy.m4a');
    if (fs.existsSync(file)) return file;
    const tmp = file + '.part.mp4';
    const { ffmpeg } = findBinaries();
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', info.path, '-sn'];
    if (info.hasVideo) {
      args.push('-vf', "scale=-2:'min(720,ih)':flags=bicubic,format=yuv420p");
      if (encoders && encoders.h264_nvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p2', '-rc', 'vbr', '-cq', '27', '-b:v', '0');
      else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26');
      args.push('-g', '30');
    } else {
      args.push('-vn');
    }
    if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
    args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', tmp);
    let buf = '';
    await run(ffmpeg, args, {
      onStdout: (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) {
          const m = /^out_time_us=(\d+)/.exec(l);
          if (m && onProgress && info.duration) onProgress(Math.min(1, Number(m[1]) / 1e6 / info.duration));
        }
      },
    });
    fs.renameSync(tmp, file);
    return file;
  });
}

// ---------------------------------------------------------------------------
// Файлы-заготовки для эффектов: реверс фрагмента и стоп-кадр.
// Делаются один раз в кэш в высоком качестве (H.264, играет в окне), экспорт берёт их как обычные клипы.
// ---------------------------------------------------------------------------
function fxVideoArgs(encoders, fps) {
  const gop = String(Math.max(1, Math.round(fps || 30)));
  if (encoders && encoders.h264_nvenc) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'constqp', '-qp', '16', '-profile:v', 'high', '-g', gop, '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-profile:v', 'high', '-g', gop, '-pix_fmt', 'yuv420p'];
}

const n3 = (x) => Number(x).toFixed(3);

// Реверс фрагмента [a, b] исходного файла. Видео разворачивается кусками по нескольку секунд
// (фильтр reverse держит весь кусок в памяти), куски склеиваются в обратном порядке, звук — areverse целиком.
function reverse(info, a, b, onProgress, encoders) {
  a = Math.max(0, a); b = Math.min(info.duration || b, b);
  const key = `reverse:${info.key}:${n3(a)}:${n3(b)}`;
  return once(key, async () => {
    const dir = path.join(mediaCacheDir(info), 'fx');
    fs.mkdirSync(dir, { recursive: true });
    const base = `reverse_${n3(a)}_${n3(b)}`.replace(/\./g, '_');
    const file = path.join(dir, base + (info.hasVideo ? '.mp4' : '.flac'));
    if (fs.existsSync(file)) return file;
    const { ffmpeg } = findBinaries();
    const dur = b - a;
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
    const work = path.join(dir, `${base}_work`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      if (!info.hasVideo) {
        await run(ffmpeg, [...common, '-ss', n3(a), '-t', n3(dur), '-i', info.path, '-vn', '-sn', '-af', 'areverse', '-c:a', 'flac', path.join(work, 'out.flac')]);
        onProgress && onProgress(1);
        fs.renameSync(path.join(work, 'out.flac'), file);
        return file;
      }
      // Длина куска: чтобы в памяти было не больше ~1,2 ГБ кадров
      const bytesPerSec = Math.max(1, (info.width || 1920) * (info.height || 1080) * 3 * (info.fps || 30));
      const chunk = Math.max(0.5, Math.min(20, 1.2e9 / bytesPerSec));
      const n = Math.max(1, Math.ceil(dur / chunk - 1e-6));
      const parts = [];
      const steps = n + (info.hasAudio ? 2 : 1);
      for (let k = 0; k < n; k++) {
        const i = n - 1 - k;                // с конца фрагмента
        const ss = a + i * chunk;
        const d = Math.min(chunk, b - ss);
        const out = path.join(work, `part_${String(k).padStart(4, '0')}.mp4`);
        await run(ffmpeg, [...common, '-ss', n3(ss), '-t', n3(d), '-i', info.path, '-an', '-sn', '-dn',
          '-vf', 'reverse', ...fxVideoArgs(encoders, info.fps), out]);
        parts.push(out);
        onProgress && onProgress((k + 1) / steps);
      }
      const list = path.join(work, 'list.txt');
      fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const args = [...common, '-f', 'concat', '-safe', '0', '-i', list];
      if (info.hasAudio) {
        const wav = path.join(work, 'audio.wav');
        await run(ffmpeg, [...common, '-ss', n3(a), '-t', n3(dur), '-i', info.path, '-vn', '-sn', '-af', 'areverse', '-c:a', 'pcm_s16le', wav]);
        onProgress && onProgress((n + 1) / steps);
        args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k');
      }
      const tmp = path.join(work, 'out.mp4');
      args.push('-c:v', 'copy', '-t', n3(dur), '-movflags', '+faststart', tmp);
      await run(ffmpeg, args);
      fs.renameSync(tmp, file);
      onProgress && onProgress(1);
      return file;
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => {});
    }
  });
}

// Стоп-кадр: кадр исходника в момент at, растянутый в ролик длиной dur секунд (без звука)
const FREEZE_FILE_SEC = 20;
function freeze(info, at, encoders) {
  at = Math.max(0, Math.min(at, (info.duration || at)));
  const key = `freeze:${info.key}:${n3(at)}`;
  return once(key, async () => {
    const dir = path.join(mediaCacheDir(info), 'fx');
    fs.mkdirSync(dir, { recursive: true });
    const base = `freeze${FREEZE_FILE_SEC}_${n3(at)}`.replace(/\./g, '_');
    const file = path.join(dir, `${base}.mp4`);
    if (fs.existsSync(file)) return file;
    const { ffmpeg } = findBinaries();
    const png = path.join(dir, `${base}.png`);
    const common = ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
    // У самого конца файла кадра может не оказаться — отступаем назад
    for (const t of [at, at - 0.05, at - 0.25, at - 1]) {
      if (t < 0) continue;
      await run(ffmpeg, [...common, '-ss', n3(t), '-i', info.path, '-frames:v', '1', '-an', '-sn', png]).catch(() => {});
      if (fs.existsSync(png) && fs.statSync(png).size > 0) break;
    }
    if (!fs.existsSync(png)) throw new Error('Не удалось взять кадр из файла');
    // Кадр один и тот же, поэтому 10 кадров/с хватает: при экспорте FFmpeg сам доведёт частоту до нужной
    const fps = 10;
    const tmp = path.join(dir, `${base}.part.mp4`);
    await run(ffmpeg, [...common, '-loop', '1', '-framerate', String(fps), '-i', png, '-t', String(FREEZE_FILE_SEC),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', ...fxVideoArgs(encoders, fps), '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, file);
    fs.rm(png, { force: true }, () => {});
    return file;
  });
}

// Один кадр в JPEG (для ИИ-ассистента: «посмотреть» на видео)
async function frameJpeg(file, t, width = 640) {
  const { ffmpeg } = findBinaries();
  const w = Math.max(64, Math.min(1920, Math.round(width / 2) * 2));
  for (const tt of [t, t - 0.1, t - 0.5]) {
    if (tt < 0) continue;
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', n3(tt), '-i', file,
      '-frames:v', '1', '-an', '-sn', '-vf', `scale=${w}:-2`, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { binaryStdout: true });
    if (stdout && stdout.length) return stdout;
  }
  throw new Error('Не удалось получить кадр');
}

// Поиск тишины: [{ start, end }] в секундах файла
async function silence(file, thresholdDb = -35, minDur = 0.5) {
  const { ffmpeg } = findBinaries();
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-sn',
    '-af', `silencedetect=noise=${Number(thresholdDb)}dB:d=${Number(minDur)}`, '-f', 'null', '-']);
  const out = [];
  let cur = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) { cur = { start: Math.max(0, Number(m[1])) }; continue; }
    m = /silence_end:\s*([\d.]+)/.exec(line);
    if (m && cur) { cur.end = Number(m[1]); out.push(cur); cur = null; }
  }
  if (cur) cur.end = null; // тишина до конца файла
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Какие кодировщики реально работают (NVENC может быть в сборке, но без драйвера)
// ---------------------------------------------------------------------------
const encodersCache = new Map();
async function detectEncoders(bin = findBinaries()) {
  if (encodersCache.has(bin.ffmpeg)) return encodersCache.get(bin.ffmpeg);
  const list = ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc', 'libx264', 'libx265', 'libsvtav1'];
  const res = {};
  await Promise.all(list.map(async (enc) => {
    try {
      await run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=320x240:r=30:d=0.2', '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 15000 });
      res[enc] = true;
    } catch {
      res[enc] = false;
    }
  }));
  encodersCache.set(bin.ffmpeg, res);
  return res;
}

// Версия FFmpeg: { line, major }. major нужен для совместимости со старыми сборками (Linux-дистрибутивы).
const versionCache = new Map();
async function versionInfo(bin = findBinaries()) {
  if (versionCache.has(bin.ffmpeg)) return versionCache.get(bin.ffmpeg);
  let info = null;
  try {
    const { stdout } = await run(bin.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    const line = stdout.split('\n')[0].trim();
    let major = 99; // сборки из master («N-12345-g…») считаем самыми новыми
    const m = /version\s+n?(\d+)\./i.exec(line);
    if (m) major = Number(m[1]);
    info = { line, major };
  } catch { /* не запускается */ }
  versionCache.set(bin.ffmpeg, info);
  return info;
}

async function version() {
  const v = await versionInfo();
  return v ? v.line : null;
}

// Для окна настроек: проверить конкретную папку (или автопоиск, если пусто)
async function checkDir(dir) {
  const bin = dir ? binIn(dir) : searchBinaries('');
  if (!bin) return { ok: false, error: dir ? 'В этой папке нет ffmpeg и ffprobe' : 'FFmpeg не найден' };
  const v = await versionInfo(bin);
  if (!v) return { ok: false, error: 'ffmpeg найден, но не запускается', path: bin.ffmpeg };
  return { ok: true, path: bin.ffmpeg, dir: bin.dir, version: v.line, major: v.major };
}

function resetBinaries() { BIN = null; }

module.exports = {
  findBinaries, searchBinaries, resetBinaries, checkDir, run, probe, thumbs, peaks, proxy,
  detectEncoders, version, versionInfo, mediaCacheDir, reverse, freeze, frameJpeg, silence, FREEZE_FILE_SEC,
};
