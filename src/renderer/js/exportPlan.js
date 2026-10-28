// Сборка проекта в одну команду FFmpeg (без окна и без Node — используется окном и автотестами).
// Запуск команды, прогресс и отмена — в программе (src-tauri/src/export.rs).
//
// Модель проекта (то, что присылает интерфейс, версия 2):
//   project.media       { [id]: { path, hasVideo, hasAudio, duration, ... } }
//   project.videoClips  [ { mediaId, in, out, start, volume, muted, fadeIn, fadeOut, transition? } ]
//                       — основная дорожка: клипы по времени, без наложений, могут быть пустоты
//   project.audioTracks [ { muted, clips: [ { mediaId, in, out, start, volume, muted, fadeIn, fadeOut } ] } ]
//
// Настройки экспорта:
//   { width, height, fps, codec, quality, output }

export const QUALITY = {
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
const clipDuration = (c) => Math.max(0, c.out - c.in);

export function encoderArgs(codec, quality, fps) {
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

// Переходы: id в проекте -> параметры фильтра xfade
const XFADE = new Set(['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'zoomin', 'hblur']);
function xfadeTransition(type) {
  // Жалюзи: 10 вертикальных полос, в каждой новый клип открывается слева направо (P идёт от 1 к 0)
  if (type === 'blinds') return "transition=custom:expr='if(lt(mod(X,W/10),(1-P)*W/10),B,A)'";
  return `transition=${XFADE.has(type) ? type : 'fade'}`;
}
const ADJ = 0.002;

// Возвращает { inputs, filter, duration, W, H, F }.
// Видео: клипы по времени (между ними чёрное), клипы с переходом склеиваются фильтром xfade.
//   Переход центрирован на стыке: уходящий клип продолжается на d/2 дальше своего конца,
//   следующий начинается на d/2 раньше (если в файле не хватает кадров — повторяется крайний кадр).
//   Поэтому длина ролика и положение клипов на таймлайне не меняются.
// Звук: каждый клип ставится на своё место (adelay) и всё смешивается (amix) — так же работают пустоты,
//   затухания и плавная смена звука на переходах.
export function buildExport(project, settings) {
  const W = even(settings.width);
  const H = even(settings.height);
  const F = Number(settings.fps) || 30;
  const media = project.media || {};
  const inputs = [];
  const filters = [];
  const audio = [];

  const addInput = (m, ss, dur) => {
    inputs.push('-ss', n6(Math.max(0, ss)), '-t', n6(dur + 0.5), '-i', m.path);
    return inputs.filter((x) => x === '-i').length - 1;
  };

  const scaleChain = `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  const audioFmt = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const black = (dur) => `color=c=black:s=${W}x${H}:r=${F},format=yuv420p,setsar=1,trim=duration=${n6(dur)},setpts=PTS-STARTPTS`;
  const vFades = (c, head, len) => {
    let s = '';
    if (c.fadeIn > 0.001) s += `,fade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}`;
    if (c.fadeOut > 0.001) s += `,fade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}`;
    return s;
  };
  const aFades = (c, head, len) => {
    let s = '';
    if (c.fadeIn > 0.001) s += `,afade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}`;
    if (c.fadeOut > 0.001) s += `,afade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}`;
    return s;
  };

  // --- Основная дорожка ---
  const vclips = (project.videoClips || [])
    .filter((c) => clipDuration(c) > 0.001 && media[c.mediaId])
    .map((c, i) => ({ ...c, start: Number.isFinite(c.start) ? c.start : NaN, _i: i }));
  // Старые проекты без start: встык
  if (vclips.some((c) => !Number.isFinite(c.start))) { let t = 0; for (const c of vclips) { c.start = t; t += clipDuration(c); } }
  vclips.sort((a, b) => a.start - b.start);

  // Длительности переходов (перед клипом i), с проверкой «впритык» и ограничением по длине
  const tin = vclips.map((c, i) => {
    if (!c.transition || i === 0) return 0;
    const p = vclips[i - 1];
    if (Math.abs(p.start + clipDuration(p) - c.start) > ADJ) return 0;
    const d = Math.min(Number(c.transition.duration) || 0, clipDuration(p), clipDuration(c), 3);
    return d >= 0.05 ? d : 0;
  });
  const tout = vclips.map((_c, i) => tin[i + 1] || 0);

  const pieces = [];
  let chain = null; let chainLen = 0; let cursor = 0; let videoEnd = 0;
  vclips.forEach((c, i) => {
    const m = media[c.mediaId];
    const len = clipDuration(c);
    const h = tin[i] / 2; const t = tout[i] / 2;
    if (!tin[i]) {
      if (chain) { pieces.push(chain); chain = null; }
      const gap = c.start - cursor;
      if (gap > 0.0005) { filters.push(`${black(gap)}[g${i}]`); pieces.push(`[g${i}]`); }
    }
    const ss = Math.max(0, c.in - h);
    const head = c.in - ss;              // сколько кадров «до» реально есть в файле
    const freezeHead = h - head;         // недостающее — повтор первого кадра
    const S = h + len + t;
    // noAudio — звук клипа вынесен на аудиодорожки (связанные клипы)
    const hasSound = m.hasAudio && !c.noAudio && !c.muted && c.volume > 0;
    const k = (m.hasVideo || hasSound) ? addInput(m, ss, head + len + t) : -1;
    if (m.hasVideo) {
      filters.push(`[${k}:v]setpts=PTS-STARTPTS,${scaleChain}` +
        (freezeHead > 0.0005 ? `,tpad=start_mode=clone:start_duration=${n6(freezeHead)}` : '') +
        `,tpad=stop_mode=clone:stop_duration=${n6(t + 2)},trim=duration=${n6(S)},setpts=PTS-STARTPTS` +
        `${vFades(c, h, len)}[s${i}]`);
    } else {
      filters.push(`${black(S)}[s${i}]`);
    }
    if (tin[i]) {
      filters.push(`${chain}[s${i}]xfade=${xfadeTransition(c.transition.type)}:duration=${n6(tin[i])}:offset=${n6(chainLen - tin[i])}[x${i}]`);
      chain = `[x${i}]`;
      chainLen = chainLen + S - tin[i];
    } else {
      chain = `[s${i}]`;
      chainLen = S;
    }
    cursor = c.start + len;
    videoEnd = Math.max(videoEnd, cursor);

    // Звук клипа: со «ступеньками» для перехода, на своём месте
    if (hasSound) {
      const L = head + len + t;
      let af = `[${k}:a]${audioFmt},volume=${n6(c.volume)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(L)}`;
      if (tin[i]) af += `,afade=t=in:st=0:d=${n6(head + h)}`;
      af += aFades(c, head, len);
      if (t > 0) af += `,afade=t=out:st=${n6(head + len - t)}:d=${n6(2 * t)}`;
      const delay = Math.max(0, Math.round((c.start - head) * 1000));
      af += `,adelay=delays=${delay}:all=1[va${i}]`;
      filters.push(af);
      audio.push(`[va${i}]`);
    }
  });
  if (chain) pieces.push(chain);

  // --- Аудиодорожки (музыка, голос и т.п.) ---
  let audioEnd = 0;
  let j = 0;
  (project.audioTracks || []).forEach((tr) => {
    // Громкость дорожки умножается на громкость клипа; «Соло» — только для предпросмотра
    const tv = tr.volume === undefined ? 1 : Number(tr.volume);
    (tr.clips || []).forEach((c) => {
      const m = media[c.mediaId];
      const dur = clipDuration(c);
      if (!m || !m.hasAudio || dur <= 0.001) return;
      audioEnd = Math.max(audioEnd, c.start + dur);
      if (tr.muted || c.muted || !(c.volume > 0) || !(tv > 0)) return;
      const k = addInput(m, c.in, dur);
      const delayMs = Math.max(0, Math.round(c.start * 1000));
      const nStreams = (m.audioStreams && m.audioStreams.length) || 1;
      const st = Math.min(Math.max(0, c.stream | 0), nStreams - 1);
      filters.push(`[${k}:a:${st}]${audioFmt},volume=${n6(c.volume * tv)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(dur)}` +
        `${aFades(c, 0, dur)},adelay=delays=${delayMs}:all=1[m${j}]`);
      audio.push(`[m${j}]`);
      j++;
    });
  });

  const total = Math.max(videoEnd, audioEnd);
  if (total <= 0.01) throw new Error('Таймлайн пуст — нечего экспортировать.');

  // Если звук длиннее видео — добиваем чёрным кадром
  if (total - videoEnd > 0.0005) {
    filters.push(`${black(total - videoEnd)}[vtail]`);
    pieces.push('[vtail]');
  }
  // xfade может отдать 4:4:4 (FFmpeg 9) — high-профиль H.264 его не принимает, поэтому на выходе всегда 4:2:0
  if (pieces.length === 1) filters.push(`${pieces[0]}format=yuv420p[vout]`);
  else filters.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=0,format=yuv420p[vout]`);

  const tail = `apad,atrim=duration=${n6(total)},alimiter=limit=0.98:attack=5:release=50:level=0[aout]`;
  if (!audio.length) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n6(total)}[aout]`);
  else if (audio.length === 1) filters.push(`${audio[0]}${tail}`);
  else filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,${tail}`);

  const filter = filters.join(';\n');
  return { inputs, filter, duration: total, W, H, F };
}

// Полная команда для программы: @@FILTER@@ и @@OUT@@ подставит export.rs
export function exportCommand(project, settings, ffMajor = 99) {
  const plan = buildExport(project, settings);
  // FFmpeg 7+: «-/filter_complex файл»; старые версии (Linux-дистрибутивы): -filter_complex_script
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  const cfrArgs = ffMajor >= 6 ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
  const args = ['-hide_banner', '-y', '-nostdin', ...plan.inputs,
    ...filterArgs,
    '-map', '[vout]', '-map', '[aout]',
    ...encoderArgs(settings.codec, settings.quality, plan.F),
    ...cfrArgs,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', n6(plan.duration),
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
  return { args, filter: plan.filter, duration: plan.duration, output: settings.output };
}
