'use strict';
// Сборка проекта в одну команду FFmpeg и запуск экспорта.
//
// Модель проекта (то, что присылает интерфейс):
//   project.media       { [id]: { path, hasVideo, hasAudio, duration, ... } }
//   project.videoClips  [ { mediaId, in, out, volume, muted } ]       — основная дорожка, клипы встык
//   project.audioTracks [ { muted, clips: [ { mediaId, in, out, start, volume, muted } ] } ]
//
// Настройки экспорта:
//   { width, height, fps, codec, quality, output }
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBinaries } = require('./ffmpeg');
const { PATHS } = require('./paths');

const QUALITY = {
  // Значение CQ: меньше — лучше качество и больше файл
  av1_nvenc: { high: 28, medium: 33, compact: 38 },
  hevc_nvenc: { high: 22, medium: 26, compact: 30 },
  h264_nvenc: { high: 20, medium: 23, compact: 27 },
  libx264: { high: 18, medium: 21, compact: 24 },
  libx265: { high: 20, medium: 24, compact: 28 },
  libsvtav1: { high: 28, medium: 33, compact: 38 },
};

const n6 = (x) => Number(x).toFixed(6);
const even = (x) => Math.max(2, Math.round(x / 2) * 2);

function clipDuration(c) {
  return Math.max(0, c.out - c.in);
}

function encoderArgs(codec, quality, fps) {
  const q = (QUALITY[codec] || QUALITY.h264_nvenc)[quality] ?? QUALITY.h264_nvenc.medium;
  const gop = String(Math.max(1, Math.round(fps * 2)));
  switch (codec) {
    case 'av1_nvenc':
      return ['-c:v', 'av1_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
        '-spatial-aq', '1', '-rc-lookahead', '20', '-g', gop];
    case 'hevc_nvenc':
      return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
        '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '20', '-g', gop, '-tag:v', 'hvc1'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
        '-spatial-aq', '1', '-temporal-aq', '1', '-rc-lookahead', '20', '-profile:v', 'high', '-g', gop];
    case 'libx265':
      return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q), '-g', gop, '-tag:v', 'hvc1'];
    case 'libsvtav1':
      return ['-c:v', 'libsvtav1', '-preset', '8', '-crf', String(q), '-g', gop];
    case 'libx264':
    default:
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q), '-profile:v', 'high', '-g', gop];
  }
}

// Возвращает { args, filter, duration }
function buildExport(project, settings) {
  const W = even(settings.width);
  const H = even(settings.height);
  const F = Number(settings.fps) || 30;
  const media = project.media || {};
  const inputs = [];
  const filters = [];
  const segs = [];

  const addInput = (m, inPoint, dur) => {
    inputs.push('-ss', n6(inPoint), '-t', n6(dur + 0.25), '-i', m.path);
    return inputs.filter((x) => x === '-i').length - 1;
  };

  const videoFilterTail = (dur) =>
    `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=2,trim=duration=${n6(dur)},setpts=PTS-STARTPTS`;
  const audioFmt = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const silence = (dur) => `anullsrc=r=48000:cl=stereo,atrim=duration=${n6(dur)}`;
  const black = (dur) => `color=c=black:s=${W}x${H}:r=${F},format=yuv420p,setsar=1,trim=duration=${n6(dur)}`;

  // --- Основная дорожка ---
  let videoEnd = 0;
  const vclips = (project.videoClips || []).filter((c) => clipDuration(c) > 0.001 && media[c.mediaId]);
  vclips.forEach((c, i) => {
    const m = media[c.mediaId];
    const dur = clipDuration(c);
    videoEnd += dur;
    const needInput = m.hasVideo || (m.hasAudio && !c.muted && c.volume > 0);
    const k = needInput ? addInput(m, c.in, dur) : -1;
    if (m.hasVideo) filters.push(`[${k}:v]setpts=PTS-STARTPTS,${videoFilterTail(dur)}[v${i}]`);
    else filters.push(`${black(dur)}[v${i}]`);
    if (m.hasAudio && !c.muted && c.volume > 0) {
      filters.push(`[${k}:a]${audioFmt},volume=${n6(c.volume)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(dur)}[a${i}]`);
    } else {
      filters.push(`${silence(dur)}[a${i}]`);
    }
    segs.push(`[v${i}][a${i}]`);
  });

  // --- Аудиодорожки (музыка, голос и т.п.) ---
  let audioEnd = 0;
  const music = [];
  (project.audioTracks || []).forEach((t) => {
    if (t.muted) return;
    (t.clips || []).forEach((c) => {
      const m = media[c.mediaId];
      const dur = clipDuration(c);
      if (!m || !m.hasAudio || dur <= 0.001) return;
      audioEnd = Math.max(audioEnd, c.start + dur);
      if (c.muted || !(c.volume > 0)) return;
      const k = addInput(m, c.in, dur);
      const j = music.length;
      const delayMs = Math.max(0, Math.round(c.start * 1000));
      filters.push(`[${k}:a]${audioFmt},volume=${n6(c.volume)},asetpts=PTS-STARTPTS,atrim=duration=${n6(dur)},` +
        `adelay=delays=${delayMs}:all=1[m${j}]`);
      music.push(`[m${j}]`);
    });
  });

  const total = Math.max(videoEnd, audioEnd);
  if (total <= 0.01) throw new Error('Таймлайн пуст — нечего экспортировать.');

  // Если музыка длиннее видео — добиваем чёрным кадром
  if (total - videoEnd > 0.001) {
    const g = total - videoEnd;
    filters.push(`${black(g)}[vgap]`);
    filters.push(`${silence(g)}[agap]`);
    segs.push('[vgap][agap]');
  }

  filters.push(`${segs.join('')}concat=n=${segs.length}:v=1:a=1[vout][acat]`);
  if (music.length) {
    filters.push(`[acat]${music.join('')}amix=inputs=${music.length + 1}:duration=first:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.98:attack=5:release=50:level=0[aout]`);
  } else {
    filters.push('[acat]anull[aout]');
  }

  const filter = filters.join(';\n');
  return { inputs, filter, duration: total, W, H, F };
}

// ---------------------------------------------------------------------------
// Запуск экспорта
// ---------------------------------------------------------------------------
let current = null;

function startExport(project, settings, { onProgress, onLog } = {}) {
  if (current) throw new Error('Экспорт уже идёт.');
  const { ffmpeg } = findBinaries();
  const plan = buildExport(project, settings);
  fs.mkdirSync(path.dirname(settings.output), { recursive: true });
  fs.mkdirSync(PATHS.TEMP, { recursive: true });
  const filterFile = path.join(PATHS.TEMP, `export-${Date.now()}.filter.txt`);
  fs.writeFileSync(filterFile, plan.filter);
  const partFile = settings.output + '.part';

  const args = ['-hide_banner', '-y', '-nostdin', ...plan.inputs,
    '-/filter_complex', filterFile,
    '-map', '[vout]', '-map', '[aout]',
    ...encoderArgs(settings.codec, settings.quality, plan.F),
    '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', n6(plan.duration),
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', partFile];

  const logFile = path.join(PATHS.LOGS, 'last-export.log');
  fs.mkdirSync(PATHS.LOGS, { recursive: true });
  fs.writeFileSync(logFile, `ffmpeg ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n\n--- filter ---\n${plan.filter}\n\n--- stderr ---\n`);

  const started = Date.now();
  const proc = spawn(ffmpeg, args, { windowsHide: true });
  let cancelled = false;
  let stderrTail = '';
  let buf = '';
  let state = {};

  const promise = new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) {
        const i = l.indexOf('=');
        if (i > 0) state[l.slice(0, i)] = l.slice(i + 1).trim();
        if (l.startsWith('progress=')) {
          const t = Number(state.out_time_us || state.out_time_ms || 0) / 1e6;
          const frac = Math.max(0, Math.min(1, t / plan.duration));
          const elapsed = (Date.now() - started) / 1000;
          const eta = frac > 0.01 ? elapsed * (1 - frac) / frac : null;
          onProgress && onProgress({
            fraction: frac, time: t, duration: plan.duration, elapsed, eta,
            speed: state.speed || '', fps: Number(state.fps || 0), size: Number(state.total_size || 0),
          });
        }
      }
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      fs.appendFile(logFile, s, () => {});
      stderrTail = (stderrTail + s).slice(-4000);
      onLog && onLog(s);
    });
    proc.on('error', (e) => { current = null; reject(e); });
    proc.on('close', (code) => {
      current = null;
      fs.rm(filterFile, { force: true }, () => {});
      if (cancelled) {
        fs.rm(partFile, { force: true }, () => {});
        const e = new Error('Экспорт отменён.'); e.cancelled = true; reject(e); return;
      }
      if (code !== 0) {
        fs.rm(partFile, { force: true }, () => {});
        const lines = stderrTail.trim().split(/\r?\n/).filter((l) => !/^\s*$/.test(l));
        reject(new Error(`FFmpeg завершился с ошибкой (код ${code}).\n${lines.slice(-6).join('\n')}`));
        return;
      }
      try {
        fs.rmSync(settings.output, { force: true });
        fs.renameSync(partFile, settings.output);
      } catch (e) { reject(e); return; }
      const size = fs.statSync(settings.output).size;
      resolve({ output: settings.output, size, duration: plan.duration, elapsed: (Date.now() - started) / 1000 });
    });
  });

  current = {
    cancel: () => { cancelled = true; try { proc.kill('SIGKILL'); } catch { /* ignore */ } },
  };
  return promise;
}

function cancelExport() {
  if (current) { current.cancel(); return true; }
  return false;
}

module.exports = { buildExport, startExport, cancelExport, QUALITY };
