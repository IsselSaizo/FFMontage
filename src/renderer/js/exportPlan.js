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
import { ffAudioFx, unknownFx, hasVst, missingVst } from './audioFx.js';
import { TRANSITIONS } from './transitions.js';
import { t } from './i18n.js';
import { tfOf, isIdentity, contentAspect } from './transform.js';
import { ffPath } from './core/ffEscape.js';
import { borderOf } from './border.js';
import { layoutOf, ffLayout, routeOf, routePan, downmixPan, clipChannel, channelPick, channelLabels, outputMode } from './audioLayout.js';

export const QUALITY = {
  // Значение CQ: меньше — лучше качество и больше файл
  av1_nvenc: { high: 28, medium: 33, compact: 38 },
  hevc_nvenc: { high: 22, medium: 26, compact: 30 },
  h264_nvenc: { high: 20, medium: 23, compact: 27 },
  libx264: { high: 18, medium: 21, compact: 24 },
  libx265: { high: 20, medium: 24, compact: 28 },
  libsvtav1: { high: 28, medium: 33, compact: 38 },
  // Intel Quick Sync: ICQ (-global_quality), 1–51
  h264_qsv: { high: 20, medium: 23, compact: 27 },
  hevc_qsv: { high: 22, medium: 25, compact: 29 },
  av1_qsv: { high: 24, medium: 28, compact: 33 },
  // AMD AMF: постоянный QP (-rc cqp); у av1_amf шкала QP 0–255
  h264_amf: { high: 20, medium: 23, compact: 27 },
  hevc_amf: { high: 22, medium: 26, compact: 30 },
  av1_amf: { high: 100, medium: 130, compact: 160 },
  // VAAPI (Linux, Steam Deck): постоянный QP (-rc_mode CQP)
  h264_vaapi: { high: 20, medium: 24, compact: 28 },
  hevc_vaapi: { high: 22, medium: 26, compact: 30 },
};

// Кодировщики видеокарты по производителям (порядок выбора: NVIDIA → Intel → AMD → VAAPI)
export const GPU_FAMILIES = ['nvenc', 'qsv', 'amf', 'vaapi'];
export const gpuFamily = (enc) => GPU_FAMILIES.find((f) => String(enc || '').endsWith(`_${f}`)) || null;
// VAAPI кодирует кадры из памяти видеокарты: граф заканчивается format=nv12,hwupload, устройство — -vaapi_device
export const VAAPI_DEVICE = '/dev/dri/renderD128';
const isVaapi = (codec) => gpuFamily(codec) === 'vaapi';

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

// Размер слоя клипа в экспорте (как layerChain: рамка W·scale × H·scale, «вписать» — по пропорциям картинки),
// чётные числа. По нему exportAssets.js рисует обводку и маску углов, а layerChain приводит слой точно к нему.
export function layerSize(c, m, W, H) {
  const tf = tfOf(c);
  const bw = even(even(W) * tf.scale); const bh = even(even(H) * tf.scale);
  if (c.fit === 'cover' || c.fit === 'stretch') return { w: bw, h: bh };
  const ar = contentAspect(c, m);
  return bw / bh > ar ? { w: Math.min(bw, even(bh * ar)), h: bh } : { w: bw, h: Math.min(bh, even(bw / ar)) };
}

// Длина клипа на таймлайне (с учётом скорости)
const clipDuration = (c) => Math.max(0, (c.out - c.in) / speedOf(c));
// Скорость в графе: кадры — setpts (потом fps= выравнивает частоту), звук — atempo (тон сохраняется)
const vSpeed = (sp) => (sp === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${n6(sp)}`);
const aSpeed = (sp) => (sp === 1 ? '' : `,${atempoChain(sp)}`);
const AUDIO_FMT = 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const aFades = (c, head, len) => {
  let s = '';
  if (c.fadeIn > 0.001) s += `,afade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}`;
  if (c.fadeOut > 0.001) s += `,afade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}`;
  return s;
};
const nInputs = (inputs) => inputs.filter((x) => x === '-i').length;

// Звук клипов одной аудиодорожки (общий код экспорта и графа дорожки для vst_render):
//   громкость клипа × gain, эффекты клипа (или WAV рендера VST3/CLAP — эффекты и скорость в нём уже есть),
//   затухания, adelay на своё место. o = { media, gain, addInput(m, ss, dur) → k, addWav(path) → k,
//   clipWav(c) → путь | null, warn(c), label() → '[m0]' }. Возвращает { list: [{ label, filter }], end }.
function trackClips(tr, o) {
  const list = [];
  let end = 0;
  for (const c of tr.clips || []) {
    const m = o.media[c.mediaId];
    const dur = clipDuration(c);
    if (!m || !m.hasAudio || dur <= 0.001) continue;
    end = Math.max(end, c.start + dur);
    if (tr.muted || c.muted || !(c.volume > 0) || !(o.gain > 0)) continue;
    o.warn(c);
    const delayMs = Math.max(0, Math.round(c.start * 1000));
    const label = o.label();
    const wav = o.clipWav(c);
    const tail = `,asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(dur)}${aFades(c, 0, dur)},adelay=delays=${delayMs}:all=1${label}`;
    if (wav) {
      const k = o.addWav(wav);
      list.push({ label, filter: `[${k}:a]${AUDIO_FMT},volume=${n6(c.volume * o.gain)}${tail}` });
      continue;
    }
    const sp = speedOf(c);
    const k = o.addInput(m, c.in, dur * sp);
    const nStreams = (m.audioStreams && m.audioStreams.length) || 1;
    const st = Math.min(Math.max(0, c.stream | 0), nStreams - 1);
    // 0.5.1: клип одного канала многоканального потока — этот канал двойным моно
    const ch = clipChannel(c, m);
    const pick = ch === undefined ? '' : `,${channelPick(ch)}`;
    list.push({ label, filter: `[${k}:a:${st}]${pick.slice(1)}${pick ? ',' : ''}${AUDIO_FMT}${aSpeed(sp)},volume=${n6(c.volume * o.gain)}${ffAudioFx(c.afx)}${tail}` });
  }
  return { list, end };
}

/**
 * Граф микса клипов одной аудиодорожки — вход kind:'graph' для vst_render (эффекты дорожки сюда не входят:
 * они — стадии рендера). Громкости и затухания клипов — в графе; громкость дорожки — нет (её применяет
 * экспорт/плеер после рендера). Выход [aout] (48 кГц стерео) → '@@OUT@@' последним аргументом — формат вывода
 * (-f f32le -ar 48000 -ac 2 pipe:1) подставляет Rust; длина = конец последнего клипа.
 * clipWavs: { [clipId]: путь } — готовые рендеры клипов с VST3/CLAP. null — на дорожке нет звука.
 */
export function trackGraph(project, trackId, { clipWavs = {}, ffMajor = 99 } = {}) {
  const tr = (project.audioTracks || []).find((x) => x.id === trackId);
  if (!tr) return null;
  const media = project.media || {};
  const inputs = [];
  const filters = [];
  let j = 0;
  const r = trackClips({ ...tr, muted: false }, {
    media, gain: 1,
    addInput: (m, ss, dur) => { inputs.push('-ss', n6(Math.max(0, ss)), '-t', n6(dur + 0.5), '-i', m.path); return nInputs(inputs) - 1; },
    addWav: (p) => { inputs.push('-i', p); return nInputs(inputs) - 1; },
    clipWav: (c) => (hasVst(c.afx) && clipWavs[c.id]) || null,
    warn: () => {},
    label: () => `[m${j++}]`,
  });
  const D = r.end;
  if (D <= 0.001) return null;
  for (const x of r.list) filters.push(x.filter);
  const tail = `apad,atrim=duration=${n6(D)}[aout]`;
  if (!r.list.length) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n6(D)}[aout]`);
  else if (r.list.length === 1) filters.push(`${r.list[0].label}${tail}`);
  else filters.push(`${r.list.map((x) => x.label).join('')}amix=inputs=${r.list.length}:duration=longest:dropout_transition=0:normalize=0,${tail}`);
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  // Формат выхода (-f f32le -ar 48000 -ac 2 pipe:1) ставит Rust (vst_render) вместо @@OUT@@
  const args = ['-hide_banner', '-nostdin', ...inputs, ...filterArgs, '-map', '[aout]', '@@OUT@@'];
  return { args, filter: filters.join(';\n'), duration: Number(D.toFixed(6)) };
}

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
    // Intel Quick Sync: ICQ — -global_quality без битрейта и без look_ahead
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', String(q), '-profile:v', 'high', '-g', gop];
    case 'hevc_qsv':
      return ['-c:v', 'hevc_qsv', '-preset', 'slow', '-global_quality', String(q), '-g', gop, '-tag:v', 'hvc1'];
    case 'av1_qsv':
      return ['-c:v', 'av1_qsv', '-preset', 'slow', '-global_quality', String(q), '-g', gop];
    // AMD AMF: постоянный QP для I/P(/B) кадров
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp',
        '-qp_i', String(q), '-qp_p', String(q + 2), '-qp_b', String(q + 4), '-profile:v', 'high', '-g', gop];
    case 'hevc_amf':
      return ['-c:v', 'hevc_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp',
        '-qp_i', String(q), '-qp_p', String(q + 2), '-g', gop, '-tag:v', 'hvc1'];
    case 'av1_amf':
      return ['-c:v', 'av1_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp',
        '-qp_i', String(q), '-qp_p', String(q + 8), '-g', gop];
    // VAAPI (Linux): постоянный QP; кадры приходят из графа уже в памяти видеокарты (hwupload, см. exportCommand)
    case 'h264_vaapi':
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', String(q), '-profile:v', 'high', '-g', gop];
    case 'hevc_vaapi':
      return ['-c:v', 'hevc_vaapi', '-rc_mode', 'CQP', '-qp', String(q), '-g', gop, '-tag:v', 'hvc1'];
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
  // Точная частота для фильтра fps (мастер-копии: 30000/1001 вместо 29.97 — MXF принимает только стандартные)
  const FX = settings.fpsExpr || F;
  // Формат кадров в графе: обычно 4:2:0; вещательные пресеты (0.5.2) — 4:2:2 / 4:4:4 10 бит без промежуточного 4:2:0
  const PF = /^yuv4[24][024]p(10le)?$/.test(settings.pixFmt || '') ? settings.pixFmt : 'yuv420p';
  const media = project.media || {};
  const inputs = [];
  const filters = [];
  const audio = [];
  // Группа каждой метки звука: 'video' (звук видеоклипов) или id аудиодорожки — для отдельных потоков (settings.stems)
  const audioGroup = [];
  const pushA = (label, group) => { audio.push(label); audioGroup.push(group); };
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
  // Рендеры VST3/CLAP (exportAssets.js → vst_render): { clips: { [clipId]: { path } }, tracks: { [trackId]: { path } } }.
  // WAV рендера уже содержит эффекты цепочки и скорость клипа; громкость, затухания и место на таймлайне — как обычно.
  const vstA = (assets && assets.vst) || {};
  const warnVst = (list) => { for (const name of missingVst(list)) warnings.add(t('Аудиоплагин «{name}» не найден — пропущен', { name })); };
  const vstWav = (kind, id, list) => {
    if (!hasVst(list)) return null;
    const a = vstA[kind] && vstA[kind][id];
    if (a && a.path) return a.path;
    if (assets) warnings.add(t('Звук с аудиоплагинами не подготовлен к экспорту — плагины пропущены'));
    return null;
  };
  const addWav = (p) => { inputs.push('-i', p); return nInputs(inputs) - 1; };
  const warnText = (c) => {
    if (!assets) return;
    if (c.kind === 'shape') warnings.add(t('Фигура не подготовлена к экспорту — пропущена'));
    else if (c.kind === 'timer') warnings.add(t('Таймер не подготовлен к экспорту — пропущен'));
    else warnings.add(t('Текст «{name}» не подготовлен к экспорту — пропущен', { name: String((c.text && c.text.content) || '').split('\n')[0].slice(0, 30) }));
  };
  // Текстовый клип или фигура → картинка PNG W×H (или полоса титров W×h) с альфой; трансформ уже нарисован в ней
  const asMedia = (c) => {
    if (c.kind !== 'text' && c.kind !== 'shape' && c.kind !== 'timer') return media[c.mediaId];
    const a = textImg[c.id];
    // Таймер (0.5.0): анимированный PNG (apng) в рамке a.x, a.y — читается как видео
    return a && a.path ? { path: a.path, isImage: true, isAnimation: !!a.anim, hasVideo: true, hasAudio: false, width: a.w, height: a.h, _text: a } : null;
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
    ? `fps=${FX},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=${PF}`
    : c.fit === 'stretch'
      ? `fps=${FX},scale=${W}:${H}:flags=lanczos,setsar=1,format=${PF}`
      : `fps=${FX},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${bg},setsar=1,format=${PF}`);
  // Слой клипа с трансформом (transform.js): кадрирование → подгонка в рамку W·scale × H·scale → прозрачность → поворот.
  // На выходе — картинка с альфой своего размера; где она стоит в кадре — решает overlay (центр + сдвиг).
  // Обводка и скругление (0.5.0, border.js): PNG обводки и маски размера слоя (exportAssets.js) →
  // слой приводится точно к этому размеру, альфа × маска (blend), сверху — обводка (overlay); до прозрачности и поворота
  const bordersA = (assets && assets.borders) || {};
  let bdN = 0;
  const borderAsset = (c) => {
    if (!borderOf(c)) return null;
    const a = bordersA[c.id];
    if (a && (a.ring || a.mask) && a.w > 0 && a.h > 0) return a;
    if (assets) warnings.add(t('Обводка клипа «{name}» не подготовлена к экспорту — пропущена', { name: String(c.name || (media[c.mediaId] && media[c.mediaId].name) || c.id).slice(0, 40) }));
    return null;
  };
  const borderChain = (a, dur) => {
    const n = bdN++;
    let s = `,scale=${a.w}:${a.h}:flags=lanczos,setsar=1,format=yuva420p`;
    const png = (path) => addInput({ path, isImage: true }, 0, dur);
    if (a.mask) {
      const k = png(a.mask);
      s += `[bdl${n}];[${k}:v]fps=${FX},format=yuva420p,setsar=1[bdm${n}];[bdl${n}][bdm${n}]blend=c3_mode=multiply,format=yuva420p`;
    }
    if (a.ring) {
      const k = png(a.ring);
      s += `[bdo${n}];[${k}:v]fps=${FX},format=yuva420p,setsar=1[bdr${n}];[bdo${n}][bdr${n}]overlay=0:0:format=auto,format=yuva420p`;
    }
    return s;
  };
  const layerChain = (c, dur = 0) => {
    const tf = tfOf(c);
    const bw = even(W * tf.scale); const bh = even(H * tf.scale);
    const fit = c.fit === 'cover'
      ? `scale=${bw}:${bh}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=${bw}:${bh}`
      : c.fit === 'stretch'
        ? `scale=${bw}:${bh}:flags=lanczos`
        : `scale=${bw}:${bh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
    const rad = (tf.rotate * Math.PI) / 180;
    const bd = borderAsset(c);
    return cropChain(c) + `fps=${FX},${fit},setsar=1,format=yuva420p` +
      (bd ? borderChain(bd, dur + 1) : '') +
      (tf.opacity < 1 ? `,colorchannelmixer=aa=${n6(tf.opacity)}` : '') +
      (Math.abs(rad) > 1e-6 ? `,rotate=a=${n6(rad)}:c=none:ow=rotw(${n6(rad)}):oh=roth(${n6(rad)})` : '');
  };
  // Где центр слоя: overlay=x=…:y=… (overlay_w/overlay_h — размер слоя после поворота)
  const layerPos = (c) => {
    const tf = tfOf(c);
    return `x=${n6(W / 2 + tf.x * W)}-overlay_w/2:y=${n6(H / 2 + tf.y * H)}-overlay_h/2`;
  };
  const audioFmt = AUDIO_FMT;
  const black = (dur) => `color=c=0x${bg}:s=${W}x${H}:r=${FX},format=${PF},setsar=1,trim=duration=${n6(dur)},setpts=PTS-STARTPTS`;
  // alpha — на верхних дорожках клип проявляется из прозрачности, а не из цвета фона
  const vFades = (c, head, len, alpha = false) => {
    const how = alpha ? ':alpha=1' : `:color=0x${bg}`;
    let s = '';
    if (c.fadeIn > 0.001) s += `,fade=t=in:st=${n6(head)}:d=${n6(Math.min(c.fadeIn, len))}${how}`;
    if (c.fadeOut > 0.001) s += `,fade=t=out:st=${n6(head + len - Math.min(c.fadeOut, len))}:d=${n6(Math.min(c.fadeOut, len))}${how}`;
    return s;
  };

  // --- Видеодорожки: основная (снизу, на цвете фона) и верхние (прозрачные, накладываются по порядку) ---
  // Старые проекты 0.3.x: overlayClips — одна верхняя дорожка
  // «Только звук» (0.4.1): картинка не собирается — клипы дают только звук
  const audioOnly = !!settings.audioOnly;
  const lanes = [
    { clips: project.videoClips || [], main: true, hidden: audioOnly || !!project.videoHidden },
    ...(Array.isArray(project.videoTracks) ? project.videoTracks : []).map((tr) => ({ clips: tr.clips || [], main: false, hidden: audioOnly || !!tr.hidden })),
    ...(Array.isArray(project.overlayClips) && project.overlayClips.length ? [{ clips: project.overlayClips, main: false, hidden: audioOnly }] : []),
  ];
  const pieces = [];   // основная дорожка: куски по порядку (пустоты — цвет фона) → concat
  const runs = [];     // верхние дорожки: { label, start, len, pos? } — накладываются overlay (pos — свой x/y у одиночного клипа)
  let videoEnd = 0;    // конец основной дорожки
  let upperEnd = 0;
  lanes.forEach((L, li) => {
    // Метки основной дорожки — без префикса (как в 0.3), у верхних — свой префикс
    const P = li ? `l${li}_` : '';
    const alpha = !L.main;
    for (const c of L.clips) if ((c.kind === 'text' || c.kind === 'shape' || c.kind === 'timer') && !L.hidden && clipDuration(c) > 0.001 && !asMedia(c)) warnText(c);
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
      // Звук клипа с VST3/CLAP — из WAV рендера (в нём только сам клип: in…out, без «запаса» для перехода)
      const wav = hasSound ? vstWav('clips', c.id, c.afx) : null;
      const k = (showVideo || (hasSound && !wav)) ? addInput(m, ss, (head + len + t) * sp, alpha && showVideo) : -1;
      // Одиночный клип верхней дорожки (без переходов) накладывается сам, со своим x/y — без холста во весь кадр
      const direct = alpha && !tin[i] && !tout[i];
      const tail = (freezeHead > 0.0005 ? `,tpad=start_mode=clone:start_duration=${n6(freezeHead)}` : '') +
        `,tpad=stop_mode=clone:stop_duration=${n6(t + 2)},trim=duration=${n6(S)},setpts=PTS-STARTPTS` +
        `${vFades(c, h, len, alpha)}[${P}s${i}]`;
      // Текст: картинка уже нужного размера и на своём месте; титры «roll» — полоса, которая едет снизу вверх
      // (y — выражение overlay по времени: у одиночного клипа верхней дорожки t — время ролика, иначе — время клипа)
      const tx = m._text;
      const rollY = (t0) => `y=${H}-(t-${n6(t0)})/${n6(len)}*${H + tx.h}`;
      const chainOf = (cc) => (tx ? `fps=${FX},setsar=1,format=yuva420p` : layerChain(cc, S));
      const posOf = (cc, local) => (tx ? (tx.roll ? `x=0:${rollY(local ? h : cc.start)}` : `x=${Math.round(tx.x || 0)}:y=${Math.round(tx.y || 0)}`) : layerPos(cc));
      if (showVideo) {
        warnFx(c);
        const src = `[${k}:v]${vSpeed(sp)},${tx ? '' : ffEffects(c, m.width)}`;
        if (!alpha && !tx && isIdentity(tfOf(c)) && !borderAsset(c)) {
          filters.push(`${src}${scaleChain(c)}${tail}`);
        } else if (direct) {
          filters.push(`${src}${chainOf(c)}${tail}`);
        } else {
          // Слой на холсте во весь кадр: цвет фона (основная дорожка) или прозрачный (верхние, для переходов)
          const cv = alpha ? `color=c=black@0:s=${W}x${H}:r=${FX},format=yuva420p` : `color=c=0x${bg}:s=${W}x${H}:r=${FX},format=${PF}`;
          filters.push(`${src}${chainOf(c)}[${P}ly${i}]`);
          filters.push(`${cv}[${P}cv${i}]`);
          filters.push(`[${P}cv${i}][${P}ly${i}]overlay=${posOf(c, true)}:shortest=1:format=auto,format=${alpha ? 'yuva420p' : PF},setsar=1${tail}`);
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
      if (hasSound && wav) {
        warnAfx(c.afx); warnVst(c.afx);
        // Переход: появление за половину перехода от начала клипа, уход — за половину до конца
        let af = `[${addWav(wav)}:a]${audioFmt},volume=${n6(c.volume)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(len)}`;
        if (tin[i]) af += `,afade=t=in:st=0:d=${n6(h)}`;
        af += aFades(c, 0, len);
        if (t > 0) af += `,afade=t=out:st=${n6(len - t)}:d=${n6(t)}`;
        af += `,adelay=delays=${Math.max(0, Math.round(c.start * 1000))}:all=1[${P}va${i}]`;
        filters.push(af);
        pushA(`[${P}va${i}]`, 'video');
      } else if (hasSound) {
        warnAfx(c.afx); warnVst(c.afx);
        const L2 = head + len + t;
        let af = `[${k}:a]${audioFmt}${aSpeed(sp)},volume=${n6(c.volume)}${ffAudioFx(c.afx)},asetpts=PTS-STARTPTS,apad,atrim=duration=${n6(L2)}`;
        if (tin[i]) af += `,afade=t=in:st=0:d=${n6(head + h)}`;
        af += aFades(c, head, len);
        if (t > 0) af += `,afade=t=out:st=${n6(head + len - t)}:d=${n6(2 * t)}`;
        const delay = Math.max(0, Math.round((c.start - head) * 1000));
        af += `,adelay=delays=${delay}:all=1[${P}va${i}]`;
        filters.push(af);
        pushA(`[${P}va${i}]`, 'video');
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
    if (!tr.muted) { warnAfx(tr.afx); warnVst(tr.afx); }
    // VST3/CLAP в эффектах дорожки: один WAV всей дорожки (микс клипов с их громкостями и эффектами →
    // эффекты дорожки), стоит с нуля таймлайна; громкость дорожки — после рендера (как фейдер)
    const trWav = !tr.muted && tv > 0 ? vstWav('tracks', tr.id, tr.afx) : null;
    if (trWav) {
      const r = trackClips(tr, { media, gain: tv, addInput: () => -1, addWav: () => -1, clipWav: () => null, warn: (c) => { warnAfx(c.afx); warnVst(c.afx); }, label: () => '' });
      audioEnd = Math.max(audioEnd, r.end);
      if (r.list.length) {
        const tk = `[tk${audio.length}_${j}]`;
        filters.push(`[${addWav(trWav)}:a]${audioFmt},volume=${n6(tv)},asetpts=PTS-STARTPTS,adelay=delays=0:all=1${tk}`);
        pushA(tk, tr.id);
      }
      return;
    }
    // Эффекты дорожки: её клипы сначала смешиваются между собой, потом — общая цепочка эффектов
    const trFx = tr.muted ? '' : ffAudioFx(tr.afx);
    const trLabels = [];
    const r = trackClips(tr, {
      media, gain: tv, addInput: (m, ss, dur) => addInput(m, ss, dur), addWav,
      clipWav: (c) => vstWav('clips', c.id, c.afx),
      warn: (c) => { warnAfx(c.afx); warnVst(c.afx); },
      label: () => `[m${j++}]`,
    });
    audioEnd = Math.max(audioEnd, r.end);
    for (const x of r.list) { filters.push(x.filter); if (trFx) trLabels.push(x.label); else pushA(x.label, tr.id); }
    if (trLabels.length) {
      const tk = `[tk${audio.length}_${j}]`;
      filters.push(trLabels.length === 1
        ? `[${trLabels[0].slice(1, -1)}]${trFx.slice(1)}${tk}`
        : `[${trLabels.map((x) => x.slice(1, -1)).join('][')}]amix=inputs=${trLabels.length}:duration=longest:dropout_transition=0:normalize=0${trFx}${tk}`);
      pushA(tk, tr.id);
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
  if (pieces.length === 1) filters.push(`${pieces[0]}format=${PF}${vbase}`);
  else filters.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=0,format=${PF}${vbase}`);
  let cur = vbase;
  runs.forEach((r, i) => {
    const out = i === runs.length - 1 ? VOUT : `[vo${i}]`;
    const a = r.start; const b = Math.min(total, r.start + r.len);
    filters.push(`${r.label}setpts=PTS-STARTPTS+${n6(a)}/TB[ov${i}]`);
    filters.push(`${cur}[ov${i}]overlay=${r.pos || '0:0'}:format=auto:eof_action=pass:enable='between(t,${n6(a)},${n6(b)})',format=${PF}${out}`);
    cur = out;
  });
  if (burn) {
    // Шрифты — из папки, которую готовит программа (встроенные + свои); размер холста ASS = кадр экспорта
    filters.push(`[vsub]ass=filename=${ffPath(burn.ass)}${burn.fontsdir ? `:fontsdir=${ffPath(burn.fontsdir)}` : ''}:original_size=${W}x${H},format=${PF}[vout]`);
  }

  // 0.5.1: раскладка каналов. Каждая дорожка (и звук видео) — стерео; на выходе дорожки pan раскладывает её по каналам
  // проекта (маршрут), общий микс — N каналов. out.mode: 'mix' — одна N-канальная дорожка, 'stereo' — даунмикс,
  // 'mono' — N моно-дорожек (asplit + pan=mono)
  const lay = layoutOf(project);
  const out0 = settings.audioMode || { mode: 'mix' };
  const out = settings.loudnessMeasure && out0.mode === 'mono' ? { mode: 'mix' } : out0;
  // pad — не меньше стольких моно-дорожек (MXF: 8), лишние — тишина
  const pad = Math.min(32, Math.max(0, Math.round(Number(out.pad) || 0)));
  const monoOut = out.mode === 'mono' && (lay.channels > 1 || pad > 1);
  const MAIN = monoOut ? '[amain]' : '[aout]';
  const down = out.mode === 'stereo' ? downmixPan(project) : '';
  // Нормализация громкости (0.5.0) — только общий микс: замер (loudnessMeasure) или второй проход по замеру.
  // loudnorm верно взвешивает только моно / стерео / 5.1 (каналы с 7-го не слышит) — иначе замер по даунмиксу
  const lnSafe = !!down || ['stereo', 'mono', '5.1'].includes(lay.kind) || lay.channels <= 2;
  const ln = loudnessChain(settings, (m) => warnings.add(m), lnSafe ? '' : downmixPan(project));
  // Даунмикс — до лимитера: сумма каналов (5.1: L + 0,7·C + 0,7·Ls) иначе перегружала бы стерео
  const tailTo = (o) => `apad,atrim=duration=${n6(total)}${down ? `,${down}` : ''},alimiter=limit=0.98:attack=5:release=50:level=0${o === MAIN ? ln : ''}${o}`;
  const routeLabel = (label, group, i) => {
    const tr = group === 'video' ? 'video' : (project.audioTracks || []).find((x) => x.id === group);
    const pan = routePan(routeOf(project, tr), project);
    if (!pan) return label;
    filters.push(`${label}${pan}[arte${i}]`);
    return `[arte${i}]`;
  };
  for (let i = 0; i < audio.length; i++) audio[i] = routeLabel(audio[i], audioGroup[i], i);
  const mixTo = (labels, out) => filters.push(labels.length === 1 ? `${labels[0]}${tailTo(out)}`
    : `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,${tailTo(out)}`);
  // 0.4.1: аудиодорожки отдельными потоками (MKV/MOV): поток 0 — общий микс, дальше — звук видео и каждая дорожка
  const groups = [...new Set(audioGroup)];
  const stems = [];
  const silentCl = out.mode === 'stereo' ? 'stereo' : ffLayout(project);
  if (!audio.length) filters.push(`anullsrc=r=48000:cl=${silentCl},atrim=duration=${n6(total)}${ln}${MAIN}`);
  else if (settings.stems && !monoOut && groups.length > 1) {
    const mix = []; const parts = new Map(groups.map((g) => [g, []]));
    audio.forEach((l, i) => { filters.push(`${l}asplit=2[amx${i}][ast${i}]`); mix.push(`[amx${i}]`); parts.get(audioGroup[i]).push(`[ast${i}]`); });
    mixTo(mix, MAIN);
    groups.forEach((g, i) => {
      const tr = g === 'video' ? null : (project.audioTracks || []).find((x) => x.id === g);
      const n = (project.audioTracks || []).indexOf(tr) + 1;
      mixTo(parts.get(g), `[astem${i}]`);
      stems.push({ label: `[astem${i}]`, title: tr ? String(tr.name || t('Аудио {n}', { n })) : t('Звук видео') });
    });
  } else mixTo(audio, MAIN);
  // N моно-дорожек: общий микс делится по каналам
  let audioMaps = null;
  if (monoOut) {
    const labels = channelLabels(project);
    const n = lay.channels;
    filters.push(`[amain]asplit=${n}${Array.from({ length: n }, (_, k) => `[amsp${k}]`).join('')}`);
    audioMaps = [];
    for (let k = 0; k < n; k++) {
      filters.push(`[amsp${k}]pan=mono|c0=c${k}[amono${k}]`);
      const nm = labels[k] === String(k + 1) ? t('Канал {n}', { n: k + 1 }) : t('Канал {n} ({name})', { n: k + 1, name: labels[k] });
      audioMaps.push({ label: `[amono${k}]`, title: nm });
    }
    for (let k = n; k < pad; k++) {
      filters.push(`anullsrc=r=48000:cl=mono,atrim=duration=${n6(total)}[amono${k}]`);
      audioMaps.push({ label: `[amono${k}]`, title: t('Канал {n}', { n: k + 1 }) });
    }
  }

  const filter = filters.join(';\n');
  return { inputs, filter, duration: total, W, H, F, warnings: [...warnings], subtitles: subInputs, stems, audioMaps };
}

// ---------------------------------------------------------------------------
// Нормализация громкости (0.5.0): loudnorm в 2 прохода. settings.loudness = { i, tp, lra, measured? }:
//   1-й проход — loudnessPlan(): тот же звук, в конце loudnorm=…:print_format=json, вывод в никуда (export_loudness);
//   2-й проход — экспорт с measured (input_i, input_tp, input_lra, input_thresh, target_offset) и linear=true:
//   громкость меняется одним множителем, без «дыхания» динамического режима (если пик позволяет).
// ---------------------------------------------------------------------------
const LN_LIMITS = { i: [-70, -5, -14], tp: [-9, 0, -1], lra: [1, 20, 11] };
/** Цель громкости из настроек: { i, tp, lra, measured } (числа в границах) или null */
export function cleanLoudness(x) {
  if (!x || typeof x !== 'object' || !Number.isFinite(Number(x.i))) return null;
  const out = {};
  for (const [k, [lo, hi, def]] of Object.entries(LN_LIMITS)) {
    const v = Number(x[k] ?? def);
    out[k] = Math.round(Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : def)) * 10) / 10;
  }
  const m = x.measured;
  if (m && typeof m === 'object') {
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
    const vals = keys.map((k) => (m[k] === null || m[k] === undefined || m[k] === '' ? NaN : Number(m[k])));
    out.measured = Object.fromEntries(keys.map((k, i) => [k, Number.isFinite(vals[i]) ? vals[i] : null]));
  }
  return out;
}
const f2 = (x) => Number(x).toFixed(2);
// Звено графа после лимитера: '' | ',loudnorm=…'. fold — pan даунмикса для замера (7.1, N моно: loudnorm не видит
// каналы с 7-го); тогда второй проход — volume на разницу и лимитер пика, а не loudnorm по N каналам
function loudnessChain(settings, warn, fold = '') {
  const L = cleanLoudness(settings.loudness);
  if (!L) return '';
  const base = `loudnorm=I=${f2(L.i)}:TP=${f2(L.tp)}:LRA=${f2(L.lra)}`;
  if (settings.loudnessMeasure) return `,${fold ? `${fold},` : ''}${base}:print_format=json`;
  const m = L.measured;
  if (!m) { warn(t('Нормализация громкости пропущена: нет замера')); return ''; }
  // Тишина (−inf) или почти тишина: поднимать нечего
  if (m.input_i === null || m.input_i < -69 || m.input_thresh === null) { warn(t('Звук слишком тихий — нормализация громкости пропущена')); return ''; }
  // Замер по даунмиксу или громче 0 LUFS (loudnorm принимает measured_I только −99…0): одним множителем + лимитер
  if (fold || m.input_i > 0 || m.input_thresh > 0) {
    const lim = Math.min(1, Math.max(0.0625, 10 ** (L.tp / 20)));
    return `,volume=${f2(L.i - m.input_i)}dB,alimiter=limit=${lim.toFixed(4)}:attack=5:release=50:level=0`;
  }
  const mtp = m.input_tp === null ? -99 : Math.max(-99, m.input_tp);
  const mlra = m.input_lra === null ? 0 : Math.max(0, m.input_lra);
  // loudnorm считает на 192 кГц — назад к 48 кГц
  return `,${base}:measured_I=${f2(m.input_i)}:measured_TP=${f2(mtp)}:measured_LRA=${f2(mlra)}:measured_thresh=${f2(m.input_thresh)}`
    + `:offset=${f2(m.target_offset ?? 0)}:linear=true:print_format=none,aresample=48000`;
}

/**
 * План первого прохода нормализации: звук проекта как в экспорте (картинка 16×16 → nullsink), в конце —
 * loudnorm=…:print_format=json; '@@OUT@@' программа заменяет на «-f null -» (export_loudness / --engine loudness).
 */
export function loudnessPlan(project, settings, ffMajor = 99) {
  const plan = buildExport(project, {
    ...settings, audioMode: resolveAudioMode(project, settings), width: 16, height: 16, fps: 10, audioOnly: true, stems: false, loudnessMeasure: true,
    assets: { ...(settings.assets || {}), subtitles: null },
  });
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  return {
    args: ['-hide_banner', '-nostdin', ...plan.inputs, ...filterArgs, '-map', '[aout]', '@@OUT@@'],
    filter: `${plan.filter};\n[vout]nullsink`, duration: plan.duration,
  };
}

// Название потока для -metadata: без управляющих символов, до 64 знаков (plancheck.rs is_sub_meta)
const streamTitle = (x) => String(x || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);

// Мягкие субтитры: -map k:s, кодек mov_text (MP4/MOV) или srt (MKV), язык и название потока
function subtitleArgs(list, container = 'mp4') {
  if (!list || !list.length) return [];
  const out = [];
  list.forEach((s) => out.push('-map', `${s.k}:s`));
  out.push('-c:s', container === 'mkv' ? 'srt' : 'mov_text');
  list.forEach((s, i) => {
    if (/^[a-z]{2,3}$/.test(s.lang || '')) out.push(`-metadata:s:s:${i}`, `language=${s.lang}`);
    const title = streamTitle(s.title);
    if (title) out.push(`-metadata:s:s:${i}`, `title=${title}`);
  });
  out.push('-disposition:s:0', 'default');
  return out;
}

// ---------------------------------------------------------------------------
// Контейнеры (0.4.1): MP4 — везде; MKV — любые кодеки звука, субтитры srt, несколько дорожек; MOV — монтажные программы
// ---------------------------------------------------------------------------
// Видео: MP4, MKV, MOV и анимация GIF (без звука); только звук: MP3, M4A (AAC), WAV, OGG (Vorbis)
export const VIDEO_CONTAINERS = ['mp4', 'mkv', 'mov', 'gif'];
export const AUDIO_CONTAINERS = ['mp3', 'm4a', 'wav', 'ogg'];
export const CONTAINERS = [...VIDEO_CONTAINERS, ...AUDIO_CONTAINERS];
export const isAudioOnly = (c) => AUDIO_CONTAINERS.includes(c);
// Мультиплексор FFmpeg для формата (m4a — тот же MP4)
const MUXER = { mp4: 'mp4', mov: 'mov', mkv: 'matroska', gif: 'gif', mp3: 'mp3', m4a: 'mp4', wav: 'wav', ogg: 'ogg' };
// Звук: где какой кодек можно (FLAC и Opus в MP4/MOV поддерживаются плохо — только MKV). Первый подходящий — по умолчанию
export const AUDIO_CODECS = [
  { id: 'aac', args: ['-c:a', 'aac', '-b:a', '192k'], in: ['mp4', 'mkv', 'mov'] },
  { id: 'aac256', args: ['-c:a', 'aac', '-b:a', '256k'], in: ['m4a', 'mp4', 'mkv', 'mov'] },
  { id: 'aac128', args: ['-c:a', 'aac', '-b:a', '128k'], in: ['m4a'] },
  { id: 'opus', args: ['-c:a', 'libopus', '-b:a', '160k'], in: ['mkv'] },
  { id: 'flac', args: ['-c:a', 'flac'], in: ['mkv'] },
  { id: 'pcm16', args: ['-c:a', 'pcm_s16le'], in: ['wav'] },
  { id: 'pcm', args: ['-c:a', 'pcm_s24le'], in: ['wav', 'mkv', 'mov'] },
  { id: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'], in: ['mp3'] },
  { id: 'mp3_192', args: ['-c:a', 'libmp3lame', '-b:a', '192k'], in: ['mp3'] },
  { id: 'mp3_128', args: ['-c:a', 'libmp3lame', '-b:a', '128k'], in: ['mp3'] },
  { id: 'vorbis', args: ['-c:a', 'libvorbis', '-b:a', '256k'], in: ['ogg'] },
  { id: 'vorbis_160', args: ['-c:a', 'libvorbis', '-b:a', '160k'], in: ['ogg'] },
];
/** Формат из настроек или расширения выходного файла */
export function containerOf(settings) {
  if (CONTAINERS.includes(settings.container)) return settings.container;
  const m = /\.(mp4|mkv|mov|gif|mp3|m4a|wav|ogg)$/i.exec(String(settings.output || ''));
  return m ? m[1].toLowerCase() : 'mp4';
}
/** Кодек звука, допустимый в формате (иначе — первый подходящий) */
export function audioCodecFor(container, id) {
  const c = AUDIO_CODECS.find((x) => x.id === id);
  return c && c.in.includes(container) ? c : (AUDIO_CODECS.find((x) => x.in.includes(container)) || AUDIO_CODECS[0]);
}
/** GIF: палитра на весь ролик (palettegen буферизует кадры — для коротких роликов) */
export const GIF_FPS = [10, 12, 15, 20, 25];
export const GIF_MAX_SEC = 120;
/** Можно ли в контейнере писать дорожки отдельными потоками */
export const stemsAllowed = (container) => container === 'mkv' || container === 'mov';

function audioStreamArgs(plan) {
  // 0.5.1: N моно-дорожек вместо общего микса
  if (plan.audioMaps && plan.audioMaps.length) {
    const out = [];
    plan.audioMaps.forEach((x) => out.push('-map', x.label));
    plan.audioMaps.forEach((x, i) => {
      const title = streamTitle(x.title);
      if (title) out.push(`-metadata:s:a:${i}`, `title=${title}`);
      out.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
    });
    return out;
  }
  const out = ['-map', '[aout]'];
  if (!plan.stems || !plan.stems.length) return out;
  plan.stems.forEach((x) => out.push('-map', x.label));
  out.push('-metadata:s:a:0', `title=${t('Общий микс')}`, '-disposition:a:0', 'default');
  plan.stems.forEach((x, i) => {
    const title = streamTitle(x.title);
    if (title) out.push(`-metadata:s:a:${i + 1}`, `title=${title}`);
    out.push(`-disposition:a:${i + 1}`, '0');
  });
  return out;
}

/**
 * Как писать звук при раскладке проекта (0.5.1): settings.audioOut — 'mix' (по умолчанию) | 'stereo' | 'mono';
 * формат и кодек могут не позволить (audioLayout.js outputMode). → { mode, note? }
 */
/** Режим звука для экспорта и для замера громкости — один и тот же (мастер-копия, GIF — свои правила) */
export function resolveAudioMode(project, settings) {
  const bc = broadcastById(settings.broadcast);
  if (bc) {
    if (bc.mono) return { mode: 'mono', pad: bc.mono };
    // ProRes: одна дорожка или N моно; «стерео» в мастер-копии не предлагается — сохранённый выбор не действует
    const out = settings.audioOut === 'stereo' ? 'mix' : settings.audioOut;
    return audioModeFor(project, { ...settings, audioOut: out, container: 'mov', audioCodec: 'pcm' });
  }
  // GIF: звука нет, [aout] уходит в anullsink — всегда один микс
  if (containerOf(settings) === 'gif') return { mode: 'mix' };
  return audioModeFor(project, settings);
}
export function audioModeFor(project, settings) {
  const container = containerOf(settings);
  const codec = audioCodecFor(container, settings.audioCodec);
  const cname = (codec.args[codec.args.indexOf('-c:a') + 1] || 'aac').replace('libmp3lame', 'mp3').replace('libopus', 'opus').replace('libvorbis', 'vorbis');
  return outputMode(project, { mode: settings.audioOut || 'mix', codec: cname, container });
}

// ---------------------------------------------------------------------------
// Вещательный экспорт (0.5.2): мастер-копии для монтажных программ и эфира. Кодирование — только процессор.
//   ProRes 422 / HQ / 4444 в MOV: звук PCM 24/48 — одна дорожка в раскладке проекта или N моно;
//   MXF OP1a: DNxHR (SQ/HQ/HQX) или XDCAM HD422 (MPEG-2 50 Мбит/с 4:2:2, 1920×1080 25 кадров, поле — верхнее первым)
//   + 8 моно-дорожек PCM 24/48 (каналы раскладки, остальные — тишина). Таймкод начала — settings.timecode.
// ---------------------------------------------------------------------------
export const BROADCAST = [
  { id: 'prores422', container: 'mov', pix: 'yuv422p10le', v: ['-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0'], label: 'Apple ProRes 422' },
  { id: 'prores_hq', container: 'mov', pix: 'yuv422p10le', v: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0'], label: 'Apple ProRes 422 HQ' },
  { id: 'prores4444', container: 'mov', pix: 'yuv444p10le', v: ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0'], label: 'Apple ProRes 4444' },
  { id: 'dnxhr_sq', container: 'mxf', pix: 'yuv422p', v: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq'], label: 'Avid DNxHR SQ (MXF OP1a)', mono: 8 },
  { id: 'dnxhr_hq', container: 'mxf', pix: 'yuv422p', v: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq'], label: 'Avid DNxHR HQ (MXF OP1a)', mono: 8 },
  { id: 'dnxhr_hqx', container: 'mxf', pix: 'yuv422p10le', v: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx'], label: 'Avid DNxHR HQX 10 bit (MXF OP1a)', mono: 8 },
  {
    id: 'xdcam_hd422', container: 'mxf', pix: 'yuv422p', label: 'Sony XDCAM HD422 50 Mbit/s (MXF OP1a)', mono: 8, width: 1920, height: 1080, fps: 25, field: 'tff',
    v: ['-c:v', 'mpeg2video', '-b:v', '50M', '-minrate', '50M', '-maxrate', '50M', '-bufsize', '36408333', '-g', '12', '-bf', '2',
      '-flags', '+ildct+ilme', '-dc', '10', '-intra_vlc', '1', '-non_linear_quant', '1', '-qmin', '1', '-qmax', '12'],
  },
];
export const broadcastById = (id) => BROADCAST.find((x) => x.id === id) || null;
// Стандартные частоты: MXF принимает только их, MOV пишет точную дробь (2997/100 у 29.97 уводил бы таймкод)
const STD_RATES = [[23.976, '24000/1001'], [24, '24'], [25, '25'], [29.97, '30000/1001'], [30, '30'], [50, '50'], [59.94, '60000/1001'], [60, '60']];
/** Частота мастер-копии: { fps, expr }. mxf — ближайшая стандартная; mov — дробь NTSC для 23.976 / 29.97 / 59.94 */
export function broadcastRate(fps, container) {
  const f = Number(fps) || 25;
  const near = STD_RATES.reduce((a, b) => (Math.abs(b[0] - f) < Math.abs(a[0] - f) ? b : a));
  if (container === 'mxf' || Math.abs(near[0] - f) < 0.01) return { fps: near[0], expr: near[1] };
  return { fps: f, expr: String(f) };
}
const isNtsc = (fps) => Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
/** Таймкод начала «ЧЧ:ММ:СС:КК» (кадры — меньше частоты; «;» — drop-frame, только у 29.97 / 59.94); неверный → 10:00:00:00 */
export function cleanTimecode(tc, fps = 25) {
  const m = /^(\d{2}):([0-5]\d):([0-5]\d)([:;])(\d{2})$/.exec(String(tc || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[5]) >= Math.ceil(fps)) return '10:00:00:00';
  return `${m[1]}:${m[2]}:${m[3]}${m[4] === ';' && isNtsc(fps) ? ';' : ':'}${m[5]}`;
}

function broadcastCommand(project, settings, b, ffMajor) {
  const W = b.width || settings.width; const H = b.height || settings.height;
  // DNxHR: кадр не меньше 256×120 — иначе кодировщик не откроется с невнятной ошибкой
  if (/^dnxhr/.test(b.id) && (W < 256 || H < 120)) throw new Error(t('DNxHR: кадр не меньше 256×120 (сейчас {w}×{h})', { w: W, h: H }));
  const rate = broadcastRate(b.fps || settings.fps, b.container);
  const fps = rate.fps;
  // ProRes: звук — одна дорожка или N моно (settings.audioOut); MXF — всегда 8 моно (дополняется тишиной)
  const audioMode = resolveAudioMode(project, settings);
  const plan = buildExport(project, { ...settings, width: W, height: H, fps, fpsExpr: rate.expr, pixFmt: b.pix, stems: false, audioMode });
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  const filter = b.field ? `${plan.filter};\n[vout]setfield=${b.field}[vbc]` : plan.filter;
  const args = ['-hide_banner', '-y', '-nostdin', ...plan.inputs, ...filterArgs,
    '-map', b.field ? '[vbc]' : '[vout]', ...audioStreamArgs(plan),
    ...b.v, '-pix_fmt', b.pix,
    ...(ffMajor >= 6 ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr']),
    '-c:a', 'pcm_s24le', '-ar', '48000',
    '-timecode', cleanTimecode(settings.timecode, fps),
    '-t', n6(plan.duration),
    '-f', b.container,
    '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
  return { args, filter, duration: plan.duration, output: settings.output, container: b.container, width: W, height: H, fps };
}

// Полная команда для программы: @@FILTER@@ и @@OUT@@ подставит export.rs
export function exportCommand(project, settings, ffMajor = 99) {
  const bc = broadcastById(settings.broadcast);
  if (bc) return broadcastCommand(project, settings, bc, ffMajor);
  const container = containerOf(settings);
  settings = { ...settings, audioMode: resolveAudioMode(project, settings) };
  const filterArgs0 = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  // Только звук: картинка не нужна — видеодорожки скрыты, кадр 16×16 (граф дешёвый), его выход уходит в nullsink
  if (isAudioOnly(container)) {
    const plan = buildExport(project, { ...settings, width: 16, height: 16, fps: 10, audioOnly: true, assets: { ...(settings.assets || {}), subtitles: null } });
    const ac = audioCodecFor(container, settings.audioCodec);
    const args = ['-hide_banner', '-y', '-nostdin', ...plan.inputs, ...filterArgs0, '-map', '[aout]', ...ac.args, '-ar', '48000',
      '-t', n6(plan.duration), ...(container === 'm4a' ? ['-movflags', '+faststart'] : []), '-f', MUXER[container],
      '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
    return { args, filter: `${plan.filter};\n[vout]nullsink`, duration: plan.duration, output: settings.output, container };
  }
  // GIF: палитра по всему ролику (palettegen → paletteuse), без звука, бесконечный повтор
  if (container === 'gif') {
    const fps = GIF_FPS.includes(Number(settings.fps)) ? Number(settings.fps) : 15;
    const plan = buildExport(project, { ...settings, fps, assets: { ...(settings.assets || {}), subtitles: settings.assets && settings.assets.subtitles && settings.assets.subtitles.mode === 'burn' ? settings.assets.subtitles : null } });
    const filter = `${plan.filter};\n[aout]anullsink;\n[vout]split[gifa][gifb];\n[gifa]palettegen=stats_mode=diff[gifp];\n[gifb][gifp]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vgif]`;
    const args = ['-hide_banner', '-y', '-nostdin', ...plan.inputs, ...filterArgs0, '-map', '[vgif]', '-loop', '0',
      '-t', n6(plan.duration), '-f', 'gif', '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
    return { args, filter, duration: plan.duration, output: settings.output, container };
  }
  const plan = buildExport(project, { ...settings, stems: !!settings.stems && stemsAllowed(container) });
  const acodec = audioCodecFor(container, settings.audioCodec);
  // В MKV у кодека нет «тега» (hvc1 нужен только плееру Apple в MP4/MOV) — FFmpeg отказался бы писать файл
  const venc = encoderArgs(settings.codec, settings.quality, plan.F);
  const vargs = container === 'mkv' ? venc.filter((x, i) => x !== '-tag:v' && venc[i - 1] !== '-tag:v') : venc;
  const muxArgs = container === 'mkv' ? ['-f', 'matroska'] : ['-movflags', '+faststart', '-f', container];
  // FFmpeg 7+: «-/filter_complex файл»; старые версии (Linux-дистрибутивы): -filter_complex_script
  const filterArgs = ffMajor >= 7 ? ['-/filter_complex', '@@FILTER@@'] : ['-filter_complex_script', '@@FILTER@@'];
  const cfrArgs = ffMajor >= 6 ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
  // VAAPI: кадры — в память видеокарты (устройство задаёт -vaapi_device, оно же — для hwupload)
  const vaapi = isVaapi(settings.codec);
  const filter = vaapi ? `${plan.filter};\n[vout]format=nv12,hwupload[vhw]` : plan.filter;
  const args = ['-hide_banner', '-y', '-nostdin', ...(vaapi ? ['-vaapi_device', VAAPI_DEVICE] : []), ...plan.inputs,
    ...filterArgs,
    '-map', vaapi ? '[vhw]' : '[vout]', ...audioStreamArgs(plan),
    ...subtitleArgs(plan.subtitles, container),
    ...vargs,
    ...cfrArgs,
    ...acodec.args, '-ar', '48000',
    '-t', n6(plan.duration),
    ...muxArgs,
    '-progress', 'pipe:1', '-nostats', '@@OUT@@'];
  return { args, filter, duration: plan.duration, output: settings.output, container };
}
