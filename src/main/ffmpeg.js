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

function findBinaries() {
  if (BIN) return BIN;
  const candidates = [];
  if (process.env.FFMONTAGE_FFMPEG_DIR) candidates.push(process.env.FFMONTAGE_FFMPEG_DIR);
  // Папки вида F:\FFmpeg\ffmpeg-*\bin рядом с программой
  try {
    for (const name of fs.readdirSync(PATHS.ROOT_DIR)) {
      if (/^ffmpeg/i.test(name)) candidates.push(path.join(PATHS.ROOT_DIR, name, 'bin'));
    }
  } catch { /* ignore */ }
  candidates.push(path.join(PATHS.APP_DIR, 'ffmpeg', 'bin'));
  for (const dir of candidates) {
    const ff = path.join(dir, 'ffmpeg.exe');
    const fp = path.join(dir, 'ffprobe.exe');
    if (fs.existsSync(ff) && fs.existsSync(fp)) {
      BIN = { ffmpeg: ff, ffprobe: fp, dir };
      return BIN;
    }
  }
  // Последний шанс — PATH
  BIN = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', dir: null };
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
// Какие кодировщики реально работают (NVENC может быть в сборке, но без драйвера)
// ---------------------------------------------------------------------------
let encodersCache = null;
async function detectEncoders() {
  if (encodersCache) return encodersCache;
  const { ffmpeg } = findBinaries();
  const list = ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc', 'libx264', 'libx265', 'libsvtav1'];
  const res = {};
  await Promise.all(list.map(async (enc) => {
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=320x240:r=30:d=0.2', '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 15000 });
      res[enc] = true;
    } catch {
      res[enc] = false;
    }
  }));
  encodersCache = res;
  return res;
}

async function version() {
  const { ffmpeg } = findBinaries();
  try {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-version']);
    return stdout.split('\n')[0].trim();
  } catch (e) {
    return null;
  }
}

module.exports = { findBinaries, run, probe, thumbs, peaks, proxy, detectEncoders, version, mediaCacheDir };
