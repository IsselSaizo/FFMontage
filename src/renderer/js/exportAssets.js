// Подготовка файлов для экспорта (M5.4–M5.5), до сборки команды FFmpeg (exportPlan.js):
//   • текстовые клипы — рисуются на холсте той же функцией, что и в плеере (textRender.js) → PNG в кэше программы;
//   • субтитры — вшить: один .ass на все видимые дорожки (libass, шрифты — папка fonts_export_dir);
//               мягкие: .srt на каждую дорожку → потоки mov_text в MP4.
// Результат кладётся в settings.assets (см. buildExport). Файлы сохраняет Rust (export_asset_save) — по содержимому,
// повторный экспорт того же текста не пишет файл заново.
import { graphicOf } from './graphicKinds.js';
import './textRender.js';   // экспорт текста (graphics.js)
import { borderOf, renderBorderImages } from './border.js';
import { layerSize } from './exportPlan.js';
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

async function pngBytes(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
function bytesBase64(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
async function pngBase64(canvas) {
  return bytesBase64(await pngBytes(canvas));
}
async function digest(buf) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
const canvasOf = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** Видимые дорожки субтитров с репликами */
export const exportableSubs = (p) => (p.subtitleTracks || []).filter((tr) => !tr.hidden && tr.cues && tr.cues.length);

/**
 * settings.subtitles: 'burn' | 'soft' | 'none' (по умолчанию — 'burn', если есть видимые субтитры).
 * Возвращает объект assets для buildExport.
 */
export async function prepareExportAssets(project, settings, api) {
  const W = Math.max(2, Math.round(settings.width / 2) * 2);
  const H = Math.max(2, Math.round(settings.height / 2) * 2);
  const assets = { texts: {}, borders: {}, subtitles: null, vst: await prepareVstAssets(project, api) };
  // «Только звук» (0.4.1): картинки текстов и субтитры не нужны
  if (/^(mp3|m4a|wav|ogg)$/.test(String(settings.container || ''))) return assets;
  const shown = visibleLanes(project).filter((l) => !l.hidden).flatMap((l) => l.clips);
  // Графические клипы (текст, фигуры, таймеры — graphics.js): каждый вид готовит свой файл (exportAsset);
  // в плане экспорта он — картинка с альфой (кадр W×H или рамка x, y, w×h; anim — анимация)
  const env = {
    W, H, fps: settings.fps || 30,
    save: (kind, b64) => api.exportAssetSave(kind, b64),
    pngBytes, pngBase64, bytesBase64, digest, canvas: canvasOf,
  };
  for (const c of shown) {
    const g = graphicOf(c);
    if (!g || !g.exportAsset) continue;
    const a = await g.exportAsset(c, env);
    if (a && a.path) assets.texts[c.id] = a;
  }
  // Обводка и скруглённые углы видео / картинок (0.5.0): PNG точно размера слоя (exportPlan.layerSize)
  for (const c of shown) {
    const b = borderOf(c);
    const m = b && (project.media || {})[c.mediaId];
    if (!m || m.hasVideo === false) continue;
    const { w, h } = layerSize(c, m, W, H);
    const imgs = renderBorderImages(b, w, h, H);
    const a = { w, h };
    if (imgs.ring) a.ring = await api.exportAssetSave('png', await pngBase64(imgs.ring));
    if (imgs.mask) a.mask = await api.exportAssetSave('png', await pngBase64(imgs.mask));
    if (a.ring || a.mask) assets.borders[c.id] = a;
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
