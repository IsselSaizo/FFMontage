// Сборка проекта в одну команду FFmpeg (без окна и без Node — используется окном и автотестами).
// Запуск команды, прогресс и отмена — в программе (src-tauri/src/export.rs).
//
// Модель проекта (то, что присылает интерфейс, версия 2):
//   project.media       { [id]: { path, hasVideo, hasAudio, duration, ... } }
//   project.videoClips  [ { mediaId, in, out, start, volume, muted, fadeIn, fadeOut, transition?, speed? } ]
//                       — in/out — время файла; на таймлайне клип длится (out − in) / speed
//                       — основная дорожка: клипы по времени, без наложений, могут быть пустоты
//   project.audioTracks [ { muted, clips: [ { mediaId, in, out, start, volume, muted, fadeIn, fadeOut } ] } ]
//
// Настройки экспорта:
//   { width, height, fps, codec, quality, output }

import { ffEffects, unknownEffects } from './effects.js';
import { speedOf, atempoChain } from './clipTime.js';
import { ffAudioFx, unknownFx } from './audioFx.js';
import { TRANSITIONS } from './transitions.js';
import { t } from './i18n.js';
import { tfOf, isIdentity } from './transform.js';
import { ffPath } from './core/ffEscape.js';

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
// Кадрирование: crop { l, t, r, b } — доли кадра, срезанные с каждой стороны; потом обычная подгонка
export function cropChain(c) {
  const cr = c.crop;
  if (!cr || !(cr.l || cr.t || cr.r || cr.b)) return '';
  const f = (x) => Math.max(0, Math.min(0.95, Number(x) || 0));
  const w = Math.max(0.05, 1 - f(cr.l) - f(cr.r)).toFixed(6); const hh = Math.max(0.05, 1 - f(cr.t) - f(cr.b)).toFixed(6);
  return `crop=w=trunc(iw*${w}/2)*2:h=trunc(ih*${hh}/2)*2:x=iw*${f(cr.l).toFixed(6)}:y=ih*${f(cr.t).toFixed(6)},`;
}

// Длина клипа на таймлайне (с учётом скорости)
const clipDuration = (c) => Math.max(0, (c.out - c.in) / speedOf(c));
// Скорость в графе: кадры — setpts (потом fps= выравнивает частоту), звук — atempo (тон сохраняется)
const vSpeed = (sp) => (sp === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${n6(sp)}`);
const aSpeed = (sp) => (sp === 1 ? '' : `,${atempoChain(sp)}`);

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

// Переходы: id в проекте -> параметры фильтра xfade (из реестра; неизвестный тип — растворение)
export function xfadeTransition(type) {
  const tr = TRANSITIONS.find((x) => x.id === type);
  return tr ? tr.xfadeArg : 'transition=fade';
}
const ADJ = 0.002;

// Возвращает { inputs, filter, duration, W, H, F, warnings }.
// warnings — что пришлось пропустить: эффекты/аудиоэффекты пропавших плагинов, неизвестный переход (заменён растворением).
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
  const warnings = new Set();
  // (внутри цикла по клипам имя t занято — поэтому сообщения собираются здесь)
  const warnAfx = (list) => { for (const id of unknownFx(list)) warnings.add(t('Аудиоэффект «{id}» не найден (нет плагина) — пропущен', { id })); };
  const warnFx = (c) => { for (const id of unknownEffects(c)) warnings.add(t('Эффект «{id}» не найден (нет плагина) — пропущен', { id })); };
  const warnTr = (type) => {
    if (!TRANSITIONS.some((x) => x.id === type)) warnings.add(t('Переход «{id}» не найден (нет плагина) — заменён растворением', { id: String(type) }));
  };

  // Подготовленные окном файлы (js/exportAssets.js): картинки текстов { [clipId]: { path, w, h, roll } }, субтитры
  const assets = settings.assets || null;
  const textImg = (assets && assets.texts) || {};
  const warnText = (c) => { if (assets) warnings.add(t('Текст «{name}» не подготовлен к экспорту — пропущен', { name: String((c.text && c.text.content) || '').split('\n')[0].slice(0, 30) })); };
  // Текстовый клип → картинка PNG W×H (или полоса титров W×h) с альфой; трансформ уже нарисован в ней
  const asMedia = (c) => {
    if (c.kind !== 'text') return media[c.mediaId];
    const a = textImg[c.id];
    return a && a.path ? { path: a.path, isImage: true, hasVideo: true, hasAudio: false, width: a.w, height: a.h, _text: a } : null;
  };
  const still = (m) => m.isImage && !m.isAnimation;
  // alpha — видео с прозрачностью (WebM VP9 alpha читает только libvpx-vp9 — он ставится перед -i)
  const addInput = (m, ss, dur, alpha = false) => {
    if (alpha && /\.webm$/i.test(m.path || '')) inputs.push('-c:v', 'libvpx-vp9');
    // Картинка: один кадр, повторяется нужное время
    if (still(m)) inputs.push('-loop', '1', '-framerate', String(F), '-t', n6(dur + 0.5), '-i', m.path);
    else inputs.push('-ss', n6(Math.max(0, ss)), '-t', n6(dur + 0.5), '-i', m.path);
    return inputs.filter((x) => x === '-i').length - 1;
  };

  // Цвет фона: поля вокруг вписанного видео, пустоты, затухания
  const bg = /^#[0-9a-f]{6}$/i.test(project.background || '') ? project.background.slice(1).toLowerCase() : '000000';
  // fit 'cover' — заполнить кадр (лишнее обрезается), 'stretch' — растянуть без сохранения пропорций,
  // иначе вписать целиком с полями цвета фона
  const scaleChain = (c) => cropChain(c) + (c.fit === 'cover'
    ? `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=yuv420p`
    : c.fit === 'stretch'
      ? `fps=${F},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`
      : `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${bg},setsar=1,format=yuv420p`);
  // Слой клипа с трансформом (transform.js): кадрирование → подгонка в рамку W·scale × H·scale → прозрачность → поворот.
  // На выходе — картинка с альфой своего размера; где она стоит в кадре — решает overlay (центр + сдвиг).
  const layerChain = (c) => {
    const tf = tfOf(c);
    const bw = even(W * tf.scale); const bh = even(H * tf.scale);
    const fit = c.fit === 'cover'
      ? `scale=${bw}:${bh}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${bw}:${bh}`
      : c.fit === 'stretch'
        ? `scale=${bw}:${bh}:flags=lanczos`
        : `scale=${bw}:${bh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
    const rad = (tf.rotate * Math.PI) / 180;
    return cropChain(c) + `fps=${F},${fit},setsar=1,format=yuva420p` +
      (tf.opacity < 1 ? `,colorchannelmixer=aa=${n6(tf.opacity)}` : '') +
      (Math.abs(rad) > 1e-6 ? `,rotate=a=${n6(rad)}:c=none:ow=rotw(${n6(rad)}):oh=roth(${n6(rad)})` : '');
  };
  // Где центр слоя: overlay=x=…:y=… (overlay_w/overlay_h — размер слоя после поворота)
  const layerPos = (c) => {
    const tf = tfOf(c);
    return `x=${n6(W / 2 + tf.x * W)}-overlay_w/2:y=${n6(H / 2 + tf.y * H)}-overlay_h/2`;
  };
  const audioFmt = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const black = (dur) => `color=c=0x${bg}:s=${W}x${H}:r=${F},format=yuv420p,setsar=1,trim=duration=${n6(dur)},setpts=PTS-STARTPTS`;
  // alpha — на верхних дорожках клип проявляется из прозрачности, а не из цвета фона
  const vFades = (c, head, len, alpha = false) => {
    const how = alpha ? ':alpha=1' : `:color=0x${bg}`;
    let s = '';
    if (c.fadeIn > 0.001) s += `,fade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}${how}`;
    if (c.fadeOut > 0.001) s += `,fade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}${how}`;
    return s;
  };
  const aFades = (c, head, len) => {
    let s = '';
    if (c.fadeIn > 0.001) s += `,afade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}`;
    if (c.fadeOut > 0.001) s += `,afade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}`;
    return s;
  };

  // --- Видеодорожки: основная (снизу, на цвете фона) и верхние (прозрачные, накладываются по порядку) ---
  // Старые проекты 0.3.x: overlayClips — одна верхняя дорожка
  const lanes = [
    { clips: project.videoClips || [], main: true, hidden: !!project.videoHidden },
    ...(Array.isArray(project.videoTracks) ? project.videoTracks : []).map((tr) => ({ clips: tr.clips || [], main: false, hidden: !!tr.hidden })),
    ...(Array.isArray(project.overlayClips) && project.overlayClips.length ? [{ clips: project.overlayClips, main: false, hidden: false }] : []),
  ];
  const pieces = [];   // основная дорожка: куски по порядку (пустоты — цвет фона) → concat
  const runs = [];     // верхние дорожки: { label, start, len, pos? } — накладываются overlay (pos — свой x/y у одиночного клипа)
  let videoEnd = 0;    // конец основной дорожки
  let upperEnd = 0;
  lanes.forEach((L, li) => {
    // Метки основной дорожки — без префикса (как в 0.3), у верхних — свой префикс
    const P = li ? `l${li}_` : '';
    const alpha = !L.main;
    for (const c of L.clips) if (c.kind === 'text' && !L.hidden && clipDuration(c) > 0.001 && !asMedia(c)) warnText(c);
    const vclips = L.clips
      .filter((c) => clipDuration(c) > 0.001 && asMedia(c))
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

    let chain = null; let chainLen = 0; let cursor = 0; let runStart = 0; let runN = 0; let runPos = null;
    const endRun = () => {
      if (!chain) return;
      if (L.main) pieces.push(chain);
      else runs.push({ label: chain, start: runStart, len: chainLen, pos: runN === 1 ? runPos : null });
      chain = null;
    };
    vclips.forEach((c, i) => {
      const m = asMedia(c);
      const len = clipDuration(c);
      const sp = still(m) ? 1 : speedOf(c);   // время таймлайна × sp = время файла
      const h = tin[i] / 2; const t = tout[i] / 2;
      if (!tin[i]) {
        endRun();
        const gap = c.start - cursor;
        if (L.main && gap > 0.0005) { filters.push(`${black(gap)}[g${i}]`); pieces.push(`[g${i}]`); }
      }
      const ss = still(m) ? c.in - h : Math.max(0, c.in - h * sp);
      const head = (c.in - ss) / sp;       // сколько кадров «до» реально есть в файле (в секундах таймлайна)
      const freezeHead = h - head;         // недостающее — повтор первого кадра
      const S = h + len + t;
      // noAudio — звук клипа вынесен на аудиодорожки (связанные клипы)
      const hasSound = m.hasAudio && !c.noAudio && !c.muted && c.volume > 0;
      const showVideo = m.hasVideo && !L.hidden;
      const k = (showVideo || hasSound) ? addInput(m, ss, (head + len + t) * sp, alpha && showVideo) : -1;
      // Одиночный клип верхней дорожки (без переходов) накладывается сам, со своим x/y — без холста во весь кадр
      const direct = alpha && !tin[i] && !tout[i];
      const tail = (freezeHead > 0.0005 ? `,tpad=start_mode=clone:start_duration=${n6(freezeHead)}` : '') +
        `,tpad=stop_mode=clone:stop_duration=${n6(t + 2)},trim=duration=${n6(S)},setpts=PTS-STARTPTS` +
        `${vFades(c, h, len, alpha)}[${P}s${i}]`;
      // Текст: картинка уже нужного размера и на своём месте; титры «roll» — полоса, которая едет снизу вверх
      // (y — выражение overlay по времени: у одиночного клипа верхней дорожки t — время ролика, иначе — время клипа)
      const tx = m._text;
      const rollY = (t0) => `y=${H}-(t-${n6(t0)})/${n6(len)}*${H + tx.h}`;
      const chainOf = (cc) => (tx ? `fps=${F},setsar=1,format=yuva420p` : layerChain(cc));
      const posOf = (cc, local) => (tx ? (tx.roll ? `x=0:${rollY(local ? h : cc.start)}` : 'x=0:y=0') : layerPos(cc));
      if (showVideo) {
        warnFx(c);
        const src = `[${k}:v]${vSpeed(sp)},${tx ? '' : ffEffects(c, m.width)}`;
        if (!alpha && !tx && isIdentity(tfOf(c))) {
          filters.push(`${src}${scaleChain(c)}${tail}`);
        } else if (direct) {
          filters.push(`${src}${chainOf(c)}${tail}`);
        } else {
          // Слой на холсте во весь кадр: цвет фона (основная дорожка) или прозрачный (верхние, для переходов)
          const cv = alpha ? `color=c=black@0:s=${W}x${H}:r=${F},format=yuva420p` : `color=c=0x${bg}:s=${W}x${H}:r=${F},format=yuv420p`;
          filters.push(`${src}${chainOf(c)}[${P}ly${i}]`);
          filters.push(`${cv}[${P}cv${i}]`);
          filters.push(`[${P}cv${i}][${P}ly${i}]overlay=${posOf(c, true)}:shortest=1:format=auto,format=${alpha ? 'yuva420p' : 'yuv420p'},setsar=1${tail}`);
        }
      } else if (L.main) {
        filters.push(`${black(S)}[${P}s${i}]`);
      }
      if (!showVideo && !L.main) {
        // Верхняя дорожка скрыта (или в клипе нет картинки) — видео нет, остаётся только звук
        endRun();
      } else if (tin[i] && chain) {
        warnTr(c.transition.type);
        const xf = `xfade=${xfadeTransition(c.transition.type)}:duration=${n6(tin[i])}:offset=${n6(chainLen - tin[i])}`;
        if (alpha) {
          // С прозрачностью смешивать можно только premultiplied: иначе из прозрачного чёрного проступает серая кайма
          filters.push(`${chain}premultiply=inplace=1[${P}pa${i}]`, `[${P}s${i}]premultiply=inplace=1[${P}pb${i}]`,
            `[${P}pa${i}][${P}pb${i}]${xf},unpremultiply=inplace=1[${P}x${i}]`);
        } else {
          filters.push(`${chain}[${P}s${i}]${xf}[${P}x${i}]`);
        }
        chain = `[${P}x${i}]`;
        chainLen = chainLen + S - tin[i];
        runN++;
      } else {
        chain = `[${P}s${i}]`;
        chainLen = S;
        runStart = c.start; runN = 1;
        runPos = direct && showVideo ? posOf(c, false) : null;
      }
      cursor = c.start + len;
      if (L.main) videoEnd = Math.max(videoEnd, cursor); else upperEnd = Math.max(upperEnd, cursor);

      // Звук клипа: со «ступеньками» для перехода, на своём месте
      if (hasSound) {
        warnAfx(c.afx);
        const L2 = head + len + t;
        let af = `[${k}:a]${audioFmt}${aSpeed(sp)},volume=${n6(c.volume)}${ffAudioFx(c.afx)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(L2)}`;
        if (tin[i]) af += `,afade=t=in:st=0:d=${n6(head + h)}`;
        af += aFades(c, head, len);
        if (t > 0) af += `,afade=t=out:st=${n6(head + len - t)}:d=${n6(2 * t)}`;
        const delay = Math.max(0, Math.round((c.start - head) * 1000));
        af += `,adelay=delays=${delay}:all=1[${P}va${i}]`;
        filters.push(af);
        audio.push(`[${P}va${i}]`);
      }
    });
    endRun();
  });

  // --- Аудиодорожки (музыка, голос и т.п.) ---
  let audioEnd = 0;
  let j = 0;
  (project.audioTracks || []).forEach((tr) => {
    // Громкость дорожки умножается на громкость клипа; «Соло» — только для предпросмотра
    const tv = tr.volume === undefined ? 1 : Number(tr.volume);
    // Эффекты дорожки: её клипы сначала смешиваются между собой, потом — общая цепочка эффектов
    const trFx = tr.muted ? '' : ffAudioFx(tr.afx);
    if (!tr.muted) warnAfx(tr.afx);
    const trLabels = [];
    (tr.clips || []).forEach((c) => {
      const m = media[c.mediaId];
      const dur = clipDuration(c);
      if (!m || !m.hasAudio || dur <= 0.001) return;
      audioEnd = Math.max(audioEnd, c.start + dur);
      if (tr.muted || c.muted || !(c.volume > 0) || !(tv > 0)) return;
      const sp = speedOf(c);
      const k = addInput(m, c.in, dur * sp);
      warnAfx(c.afx);
      const delayMs = Math.max(0, Math.round(c.start * 1000));
      const nStreams = (m.audioStreams && m.audioStreams.length) || 1;
      const st = Math.min(Math.max(0, c.stream | 0), nStreams - 1);
      filters.push(`[${k}:a:${st}]${audioFmt}${aSpeed(sp)},volume=${n6(c.volume * tv)}${ffAudioFx(c.afx)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(dur)}` +
        `${aFades(c, 0, dur)},adelay=delays=${delayMs}:all=1[m${j}]`);
      (trFx ? trLabels : audio).push(`[m${j}]`);
      j++;
    });
    if (trLabels.length) {
      const tk = `[tk${audio.length}_${j}]`;
      filters.push(trLabels.length === 1
        ? `[${trLabels[0].slice(1, -1)}]${trFx.slice(1)}${tk}`
        : `[${trLabels.map((x) => x.slice(1, -1)).join('][')}]amix=inputs=${trLabels.length}:duration=longest:dropout_transition=0:normalize=0${trFx}${tk}`);
      audio.push(tk);
    }
  });

  // --- Субтитры (M5.5): вшить — один .ass через libass (фильтр ass), мягкие — отдельные потоки mov_text ---
  const subs = (assets && assets.subtitles) || null;
  const burn = subs && subs.mode === 'burn' && subs.ass ? subs : null;
  const soft = subs && subs.mode === 'soft' && Array.isArray(subs.tracks) ? subs.tracks.filter((x) => x && x.path) : [];
  const subsEnd = subs && Number.isFinite(subs.end) ? subs.end : 0;
  const subInputs = soft.map((s) => { inputs.push('-i', s.path); return { ...s, k: inputs.filter((x) => x === '-i').length - 1 }; });

  const total = Math.max(videoEnd, audioEnd, upperEnd, subsEnd);
  if (total <= 0.01) throw new Error(t('Таймлайн пуст — нечего экспортировать.'));
  const VOUT = burn ? '[vsub]' : '[vout]';

  // Если звук длиннее видео — добиваем чёрным кадром
  if (total - videoEnd > 0.0005) {
    filters.push(`${black(total - videoEnd)}[vtail]`);
    pieces.push('[vtail]');
  }
  // xfade может отдать 4:4:4 (FFmpeg 9) — high-профиль H.264 его не принимает, поэтому на выходе всегда 4:2:0
  // Верхние видеодорожки: каждый кусок (одиночный клип или цепочка клипов с переходами) ставится на своё время
  // и накладывается overlay снизу вверх; до начала и после конца куска видно то, что под ним (eof_action=pass)
  const vbase = runs.length ? '[vbase]' : VOUT;
  if (pieces.length === 1) filters.push(`${pieces[0]}format=yuv420p${vbase}`);
  else filters.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=0,format=yuv420p${vbase}`);
  let cur = vbase;
  runs.forEach((r, i) => {
    const out = i === runs.length - 1 ? VOUT : `[vo${i}]`;
    const a = r.start; const b = Math.min(total, r.start + r.len);
    filters.push(`${r.label}setpts=PTS-STARTPTS+${n6(a)}/TB[ov${i}]`);
    filters.push(`${cur}[ov${i}]overlay=${r.pos || '0:0'}:format=auto:eof_action=pass:enable='between(t,${n6(a)},${n6(b)})',format=yuv420p${out}`);
    cur = out;
  });
  if (burn) {
    // Шрифты — из папки, которую готовит программа (встроенные + свои); размер холста ASS = кадр экспорта
    filters.push(`[vsub]ass=filename=${ffPath(burn.ass)}${burn.fontsdir ? `:fontsdir=${ffPath(burn.fontsdir)}` : ''}:original_size=${W}x${H},format=yuv420p[vout]`);
  }

  const tail = `apad,atrim=duration=${n6(total)},alimiter=limit=0.98:attack=5:release=50:level=0[aout]`;
  if (!audio.length) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n6(total)}[aout]`);
  else if (audio.length === 1) filters.push(`${audio[0]}${tail}`);
  else filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,${tail}`);

  const filter = filters.join(';\n');
  return { inputs, filter, duration: total, W, H, F, warnings: [...warnings], subtitles: subInputs };
}

// Мягкие субтитры: -map k:s, кодек mov_text (MP4), язык и название потока
function subtitleArgs(list) {
  if (!list || !list.length) return [];
  const out = [];
  list.forEach((s) => out.push('-map', `${s.k}:s`));
  out.push('-c:s', 'mov_text');
  list.forEach((s, i) => {
    if (/^[a-z]{2,3}$/.test(s.lang || '')) out.push(`-metadata:s:s:${i}`, `language=${s.lang}`);
    const title = String(s.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
    if (title) out.push(`-metadata:s:s:${i}`, `title=${title}`);
  });
  out.push('-disposition:s:0', 'default');
  return out;
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
    ...subtitleArgs(plan.subtitles),
    ...encoderArgs(settings.codec, settings.quality, plan.F),
    ...cfrArgs,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', n6(plan.duration),
    '-movflags', '+faststart', '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
  return { args, filter: plan.filter, duration: plan.duration, output: settings.output };
}
