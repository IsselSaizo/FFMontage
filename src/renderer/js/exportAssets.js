// Подготовка файлов для экспорта (M5.4–M5.5), до сборки команды FFmpeg (exportPlan.js):
//   • текстовые клипы — рисуются на холсте той же функцией, что и в плеере (textRender.js) → PNG в кэше программы;
//   • субтитры — вшить: один .ass на все видимые дорожки (libass, шрифты — папка fonts_export_dir);
//               мягкие: .srt на каждую дорожку → потоки mov_text в MP4.
// Результат кладётся в settings.assets (см. buildExport). Файлы сохраняет Rust (export_asset_save) — по содержимому,
// повторный экспорт того же текста не пишет файл заново.
import { isText } from './textModel.js';
import { renderTextImage, ensureFonts } from './textRender.js';
import { toAss, toSrt } from './subtitles.js';
import { fontFile } from './fonts.js';
import { hasVst } from './audioFx.js';
import { allVideoClips, videoSoundOn, clipJob, trackJob, trackVstClips } from './vstJobs.js';
import { t } from './i18n.js';
import { errText } from './util.js';

/**
 * Звук с аудиоплагинами VST3 / CLAP (контракт .agent/vst3-contract.md): рендер каждой такой цепочки — WAV в кэше
 * (vst_render, готовый файл возвращается сразу). → { clips: { [clipId]: { path } }, tracks: { [trackId]: { path } } }.
 * Клипы дорожки с плагинами рендерятся первыми — их WAV входят в граф дорожки. Ошибка рендера — ошибка экспорта.
 */
export async function prepareVstAssets(project, api) {
  const out = { clips: {}, tracks: {} };
  const vst = await import('./vst.js');
  if (!vst.projectUsesVst(project)) return out;
  await vst.initVst();
  await vst.refreshVst().catch(() => {});
  const info = await api.info().catch(() => null);
  const ffMajor = (info && Number(info.ffMajor)) || 99;
  const media = project.media || {};
  const nameOf = (c) => String(c.name || (media[c.mediaId] && media[c.mediaId].name) || c.id);
  const run = async (job, name) => {
    try { return { path: (await vst.render(job)).path }; } catch (e) {
      throw new Error(t('Аудиоплагины: не удалось обработать звук «{name}»: {e}', { name, e: errText(e) }));
    }
  };
  for (const c of allVideoClips(project)) {
    if (!videoSoundOn(project, c) || !hasVst(c.afx)) continue;
    const job = clipJob(project, c, { audio: false });
    if (job) out.clips[c.id] = await run(job, nameOf(c));
  }
  for (const tr of project.audioTracks || []) {
    const tv = tr.volume === undefined ? 1 : Number(tr.volume);
    if (tr.muted || !(tv > 0)) continue;
    for (const c of trackVstClips(project, tr)) {
      const job = clipJob(project, c, { audio: true });
      if (job) out.clips[c.id] = await run(job, nameOf(c));
    }
    if (!hasVst(tr.afx)) continue;
    const clipWavs = Object.fromEntries((tr.clips || []).filter((c) => out.clips[c.id]).map((c) => [c.id, out.clips[c.id].path]));
    const job = trackJob(project, tr.id, { clipWavs, ffMajor });
    if (job) out.tracks[tr.id] = await run(job, String(tr.name || t('Аудиодорожка')));
  }
  return out;
}

const visibleLanes = (p) => [
  { clips: p.videoClips || [], hidden: !!p.videoHidden },
  ...(p.videoTracks || []).map((tr) => ({ clips: tr.clips || [], hidden: !!tr.hidden })),
];

async function pngBase64(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Видимые дорожки субтитров с репликами */
export const exportableSubs = (p) => (p.subtitleTracks || []).filter((tr) => !tr.hidden && tr.cues && tr.cues.length);

/**
 * settings.subtitles: 'burn' | 'soft' | 'none' (по умолчанию — 'burn', если есть видимые субтитры).
 * Возвращает объект assets для buildExport.
 */
export async function prepareExportAssets(project, settings, api) {
  const W = Math.max(2, Math.round(settings.width / 2) * 2);
  const H = Math.max(2, Math.round(settings.height / 2) * 2);
  const assets = { texts: {}, subtitles: null, vst: await prepareVstAssets(project, api) };
  const texts = visibleLanes(project).filter((l) => !l.hidden).flatMap((l) => l.clips.filter(isText));
  if (texts.length) {
    await ensureFonts(texts);
    for (const c of texts) {
      const img = renderTextImage(c, W, H);
      const path = await api.exportAssetSave('png', await pngBase64(img.canvas));
      assets.texts[c.id] = { path, w: img.w, h: img.h, roll: img.roll };
    }
  }
  const subs = exportableSubs(project);
  const mode = settings.subtitles || 'burn';
  if (subs.length && mode !== 'none') {
    const end = Math.max(...subs.flatMap((tr) => tr.cues.map((c) => c.end)));
    if (mode === 'soft') {
      const tracks = [];
      for (const tr of subs) {
        const path = await api.exportAssetSave('srt', toSrt(tr.cues));
        tracks.push({ path, lang: tr.lang || '', title: tr.name || '' });
      }
      assets.subtitles = { mode: 'soft', tracks, end };
    } else {
      const ass = toAss(subs.map((tr) => ({ name: tr.name, style: tr.style, cues: tr.cues })), { W, H, fontName: (f) => fontFile(f).family });
      const path = await api.exportAssetSave('ass', ass);
      const fontsdir = await api.fontsExportDir();
      assets.subtitles = { mode: 'burn', ass: path, fontsdir, end };
    }
  }
  return assets;
}
