// Задания vst_render (контракт .agent/vst3-contract.md) — без DOM и без store: их собирают окно (js/vst.js)
// и подготовка экспорта (js/exportAssets.js), проверяют автотесты (tests/vst-test.js).
//   клип:    { input: { kind:'clip', file, stream, in, dur, speed }, stages, dur }
//            — кусок исходника: с in, длиной dur·speed секунд файла; результат — dur секунд (скорость — atempo)
//   дорожка: { input: { kind:'graph', plan: { args, filter, duration } }, stages, dur }
//            — граф микса клипов дорожки (exportPlan.trackGraph), стадии — эффекты дорожки
// Громкость и затухания клипа в задание клипа не входят (их применяют плеер и экспорт после рендера) —
// поэтому правка громкости не запускает новый рендер.
import { speedOf, tlLen } from './clipTime.js';
import { hasVst, splitStages } from './audioFx.js';
import { trackGraph } from './exportPlan.js';
import { clipChannel } from './audioLayout.js';
import { isGraphic } from './graphicKinds.js';

const r6 = (x) => Number(Number(x).toFixed(6));
const isTextClip = (c) => isGraphic(c);

/** Все видеоклипы проекта (основная и верхние дорожки, старые overlayClips) */
export const allVideoClips = (p) => [
  ...(p.videoClips || []),
  ...(Array.isArray(p.videoTracks) ? p.videoTracks.flatMap((tr) => tr.clips || []) : []),
  ...(Array.isArray(p.overlayClips) ? p.overlayClips : []),
];

/** Звук видеоклипа идёт в экспорт (как в buildExport: hasSound) */
export function videoSoundOn(p, c) {
  if (isTextClip(c)) return false;
  const m = p.media && p.media[c.mediaId];
  return !!(m && m.hasAudio && !(m.isImage && !m.isAnimation) && !c.noAudio && !c.muted && c.volume > 0);
}

/**
 * Задание для клипа. audio — клип аудиодорожки (поток c.stream; у видеоклипа — первый звуковой поток).
 * upto — сколько записей стойки взять (для прослушивания плагина: всё до него). null — нет звука.
 */
export function clipJob(project, clip, { audio = true, upto = Infinity, warn = null } = {}) {
  if (!clip || isTextClip(clip)) return null;
  const m = project.media && project.media[clip.mediaId];
  if (!m || !m.hasAudio || !m.path) return null;
  const dur = tlLen(clip);
  if (!(dur > 0.001)) return null;
  const nStreams = (m.audioStreams && m.audioStreams.length) || 1;
  const stream = audio ? Math.min(Math.max(0, clip.stream | 0), nStreams - 1) : 0;
  const list = Array.isArray(clip.afx) ? clip.afx.slice(0, upto) : [];
  const input = { kind: 'clip', file: m.path, stream, in: r6(Math.max(0, clip.in)), dur: r6(dur), speed: r6(speedOf(clip)) };
  // 0.5.1: клип одного канала (clip.channel) — в ключе задания только если задан (старые рендеры не пересчитываются)
  const ch = audio ? clipChannel(clip, m) : undefined;
  if (ch !== undefined) input.channel = ch;
  return {
    input,
    stages: splitStages(list, warn),
    dur: r6(dur),
  };
}

/** Клипы дорожки, которым нужен свой рендер до рендера дорожки (VST3/CLAP в эффектах клипа) */
export const trackVstClips = (project, track) => (track.clips || []).filter((c) => {
  const m = project.media && project.media[c.mediaId];
  return m && m.hasAudio && !c.muted && c.volume > 0 && tlLen(c) > 0.001 && hasVst(c.afx);
});

/**
 * Задание для всей дорожки: граф микса её клипов (clipWavs — { [clipId]: путь WAV } готовых рендеров клипов
 * с плагинами) + эффекты дорожки стадиями. null — на дорожке нет звука.
 */
export function trackJob(project, trackId, { clipWavs = {}, ffMajor = 99, upto = Infinity, warn = null } = {}) {
  const tr = (project.audioTracks || []).find((x) => x.id === trackId);
  if (!tr) return null;
  const plan = trackGraph(project, trackId, { clipWavs, ffMajor });
  if (!plan) return null;
  const list = Array.isArray(tr.afx) ? tr.afx.slice(0, upto) : [];
  return { input: { kind: 'graph', plan }, stages: splitStages(list, warn), dur: plan.duration };
}

/** Ключ задания (дедупликация в окне; Rust считает свой ключ — sha1) */
export const jobKey = (job) => JSON.stringify(job);
