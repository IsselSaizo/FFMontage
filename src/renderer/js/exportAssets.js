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
  const assets = { texts: {}, subtitles: null };
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
