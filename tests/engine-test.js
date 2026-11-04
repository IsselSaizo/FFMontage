'use strict';
// Проверка движка без интерфейса: создаёт тестовые файлы, анализирует их,
// строит миниатюры/волну и экспортирует проект в несколько кодеков.
const path = require('path');
const fs = require('fs');
// Движок — сама программа (ff-montage --engine), папки — из её config.json
// (если программа ещё не настроена — временная папка .test-cache внутри проекта)
const ff = require('./engine');
const { startExport } = ff;

let DIR = null;

async function make(name, args) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  }
  return file;
}

function assert(cond, msg) {
  if (!cond) throw new Error('ПРОВАЛ: ' + msg);
  console.log('  ok  ' + msg);
}

// Кадр в виде RGB 64×36 (для проверок цвета)
async function rgb(file, t) {
  const { stdout } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', 'scale=64:36:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { binaryStdout: true });
  const px = (x, y) => { const i = (y * 64 + x) * 3; return [stdout[i], stdout[i + 1], stdout[i + 2]]; };
  let sum = 0; for (let i = 0; i < stdout.length; i++) sum += stdout[i];
  return { px, mean: sum / stdout.length };
}
const isRed = ([r, g, b]) => r > 150 && g < 80 && b < 80;
const isGreen = ([r, g, b]) => g > 150 && r < 80 && b < 80;

// Картинки, GIF, вертикальный кадр 9:16, цвет фона, «заполнить», чёрно-белое
async function viewTest(enc, ib) {
  console.log('Картинки, формат кадра, фон, эффекты:');
  const photo = await make('f_photo.png', ['-f', 'lavfi', '-i', 'color=c=red:s=640x480', '-frames:v', '1']);
  const gif = await make('g_anim.gif', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2']);
  const ip = await ff.probe(photo); const ig = await ff.probe(gif);
  assert(ip.isImage && !ip.isAnimation && !ip.needsProxy && ip.width === 640, 'PNG — картинка');
  assert(!ig.isImage && ig.isAnimation && ig.needsProxy && Math.abs(ig.duration - 2) < 0.2, `GIF — анимация ${ig.duration} с`);
  const gp = await ff.proxy(ig, null, enc);
  assert(fs.existsSync(gp), 'GIF: видео для предпросмотра');
  const out = path.join(DIR, 'out_view.mp4');
  const clip = (mediaId, start, inn, outT, extra = {}) => ({ mediaId, in: inn, out: outT, start, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra });
  const pr = {
    media: { p: ip, g: ig, b: ib }, background: '#00ff00', aspect: '9:16',
    videoClips: [clip('p', 0, 0, 2), clip('p', 2, 0, 2, { fit: 'cover' }), clip('b', 4, 0, 2, { effects: ['bw'], noAudio: true }), clip('g', 6, 0, 2)],
    audioTracks: [],
  };
  await startExport(pr, { width: 720, height: 1280, fps: 30, codec: enc.h264_nvenc ? 'h264_nvenc' : 'libx264', quality: 'compact', output: out });
  const io = await ff.probe(out);
  assert(io.width === 720 && io.height === 1280 && Math.abs(io.duration - 8) < 0.15, `9:16: ${io.width}×${io.height}, ${io.duration} с`);
  const f1 = await rgb(out, 1);
  assert(isGreen(f1.px(32, 2)) && isRed(f1.px(32, 18)), `вписать: сверху фон ${f1.px(32, 2)}, в центре картинка ${f1.px(32, 18)}`);
  const f2 = await rgb(out, 3);
  assert(isRed(f2.px(32, 2)) && isRed(f2.px(32, 18)), `заполнить: красное до краёв ${f2.px(32, 2)}`);
  const f3 = await rgb(out, 5);
  let maxDiff = 0;
  for (let y = 14; y < 22; y += 2) for (let x = 2; x < 62; x += 3) { const [r, g, b] = f3.px(x, y); maxDiff = Math.max(maxDiff, Math.abs(r - g), Math.abs(g - b)); }
  assert(maxDiff < 24, `чёрно-белое: разница каналов ${maxDiff}`);
  const f4 = await rgb(out, 7);
  assert(!isGreen(f4.px(32, 18)) && isGreen(f4.px(32, 2)), 'GIF в кадре, по краям фон');
}
const isBlue = ([r, g, b]) => b > 150 && r < 80 && g < 80;

// Эффект плагина (декларативное описание с параметром) реально экспортируется FFmpeg'ом:
// виньетка затемняет углы, середина кадра остаётся красной; неизвестный эффект пропускается с предупреждением
async function pluginTest(enc) {
  console.log('Эффект плагина:');
  const { pathToFileURL } = require('url');
  const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
  const reg = await js('registry.js');
  const plan = await js('exportPlan.js');
  const id = reg.registerEffect({
    id: 'soft', name: { ru: 'Виньетка', en: 'Vignette' },
    params: [{ k: 'angle', name: 'Сила', min: 0.1, max: 1.5, step: 0.05, def: 0.6 }],
    ffmpeg: [{ filter: 'vignette', args: { angle: '{angle:4}' } }],
  }, { id: 'vignette', filters: new Set(['vignette']) });
  const red = await make('e_red.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const ir = await ff.probe(red);
  const pr = {
    media: { r: ir },
    videoClips: [{ mediaId: 'r', in: 0, out: 2, start: 0, volume: 1, muted: false, effects: [id, 'gone.effect'], fxp: { [id]: { angle: 1.4 } } }],
    audioTracks: [],
  };
  const b = plan.buildExport(pr, { width: 640, height: 360, fps: 30 });
  assert(b.filter.includes('vignette=angle=1.4000,') && !b.filter.includes('gone'), 'в графе vignette=angle=1.4000, неизвестный эффект пропущен');
  assert(b.warnings.length === 1 && b.warnings[0].includes('gone.effect'), `предупреждение: ${b.warnings[0]}`);
  const out = path.join(DIR, 'out_plugin.mp4');
  await startExport(pr, { width: 640, height: 360, fps: 30, codec: enc.h264_nvenc ? 'h264_nvenc' : 'libx264', quality: 'high', output: out });
  const f = await rgb(out, 1);
  const c = f.px(32, 18); const k = f.px(1, 1);
  assert(isRed(c) && k[0] < c[0] * 0.6, `виньетка: в центре ${c}, в углу темнее ${k}`);
  reg.unregisterPlugin('vignette');
}

// Скорость клипа: ×2 (видео + звук), ×0.5, звук ×0.25 (цепочка atempo), длина на таймлайне = (out − in) / speed
async function speedTest(enc) {
  console.log('Скорость:');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  // Первые 3 с красный, потом 3 с синий, со звуком
  const rb = await make('s_redblue.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const im = await ff.probe(rb);
  const { pathToFileURL } = require('url');
  const plan = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'exportPlan.js')).href);
  const pr = {
    media: { m: im },
    videoClips: [
      { mediaId: 'm', in: 0, out: 6, start: 0, volume: 1, muted: false, speed: 2 },      // 0–3 с: красный до 1,5 с, потом синий
      { mediaId: 'm', in: 0, out: 1, start: 3, volume: 1, muted: true, speed: 0.5 },     // 3–5 с: красный, замедленный
    ],
    audioTracks: [{ muted: false, clips: [{ mediaId: 'm', in: 0, out: 1, start: 0, volume: 1, muted: false, speed: 0.25 }] }], // 0–4 с
  };
  const b = plan.buildExport(pr, { width: 640, height: 360, fps: 30 });
  assert(Math.abs(b.duration - 5) < 1e-6, `длина ${b.duration} = 3 + 2`);
  assert(/setpts=\(PTS-STARTPTS\)\/2\.0+/.test(b.filter) && /atempo=2\.0+/.test(b.filter), 'видео ×2: setpts и atempo');
  assert(/atempo=0\.50+,atempo=0\.50+/.test(b.filter), 'звук ×0,25: две ступени atempo по 0,5');
  const out = path.join(DIR, 'out_speed.mp4');
  await startExport(pr, { width: 640, height: 360, fps: 30, codec, quality: 'high', output: out });
  const io = await ff.probe(out);
  assert(Math.abs(io.duration - 5) < 0.15, `файл ${io.duration.toFixed(2)} с ≈ 5`);
  const f1 = await rgb(out, 1.0); const f2 = await rgb(out, 2.2); const f3 = await rgb(out, 4.5);
  assert(isRed(f1.px(32, 18)) && isBlue(f2.px(32, 18)), '×2: на 1 с ещё красный (2 с файла), на 2,2 с уже синий (4,4 с файла)');
  assert(isRed(f3.px(32, 18)), '×0,5: второй клип красный до конца');

  // Кадрирование: слева красная половина, справа синяя; срезаем правую половину и растягиваем
  console.log('Кадрирование:');
  const half = await make('s_halves.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=30:d=2',
    '-filter_complex', '[0:v][1:v]hstack[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const ih = await ff.probe(half);
  const pc = {
    media: { h: ih },
    videoClips: [
      { mediaId: 'h', in: 0, out: 1, start: 0, volume: 1, muted: false, crop: { l: 0, t: 0, r: 0.5, b: 0 }, fit: 'stretch' },
      { mediaId: 'h', in: 0, out: 1, start: 1, volume: 1, muted: false, crop: { l: 0.5, t: 0, r: 0, b: 0 } },
    ],
    audioTracks: [],
  };
  const bc = plan.buildExport(pc, { width: 640, height: 360, fps: 30 });
  assert(/crop=w=trunc\(iw\*0\.500000\/2\)\*2:h=trunc\(ih\*1\.000000\/2\)\*2:x=iw\*0\.000000:y=ih\*0\.000000,fps=/.test(bc.filter), 'crop перед подгонкой');
  const outc = path.join(DIR, 'out_crop.mp4');
  await startExport(pc, { width: 640, height: 360, fps: 30, codec, quality: 'high', output: outc });
  const c1 = await rgb(outc, 0.5); const c2 = await rgb(outc, 1.5);
  assert(isRed(c1.px(4, 18)) && isRed(c1.px(60, 18)), `правая половина срезана, красное на весь кадр ${c1.px(60, 18)}`);
  assert(isBlue(c2.px(32, 18)) && c2.px(2, 18).every((x) => x < 30), `левая половина срезана, синий квадрат вписан с полями ${c2.px(2, 18)}`);

  // Аудиоэффекты: клип 0–2 с без эффектов, клип 2–4 с на дорожке с компрессором (+12 дБ) и эквалайзером/шумодавом у клипа
  console.log('Аудиоэффекты:');
  const afx = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'audioFx.js')).href);
  const comp = afx.newAudioFx('comp'); comp.p.threshold = 0; comp.p.makeup = 12;
  const eq = afx.newAudioFx('eq'); eq.p.mid = 3; eq.p.midF = 440;
  const dn = afx.newAudioFx('denoise');
  const pa = {
    media: { m: im },
    videoClips: [],
    audioTracks: [
      { muted: false, clips: [{ mediaId: 'm', in: 0, out: 2, start: 0, volume: 1, muted: false }] },
      { muted: false, afx: [comp], clips: [{ mediaId: 'm', in: 0, out: 2, start: 2, volume: 1, muted: false, afx: [eq, dn] }] },
    ],
  };
  const ba = plan.buildExport(pa, { width: 320, height: 180, fps: 30 });
  assert(/equalizer=f=440\.0:t=q:w=1:g=3\.00/.test(ba.filter) && /afftdn=nr=12\.0:nf=-50\.0/.test(ba.filter) && /acompressor=threshold=1\.000000/.test(ba.filter), 'фильтры EQ, шумодав, компрессор в графе');
  const outa = path.join(DIR, 'out_afx.mp4');
  await startExport(pa, { width: 320, height: 180, fps: 30, codec, quality: 'compact', output: outa });
  const vd = async (ss, tt) => {
    const { stderr } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-ss', String(ss), '-t', String(tt), '-i', outa, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    return parseFloat(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]);
  };
  const a1 = await vd(0.3, 1.4); const a2 = await vd(2.3, 1.4);
  // Анимация «Дождь»: запекание в WebM с прозрачностью и наложение поверх видео
  console.log('Анимация «Дождь»:');
  const sprite = await make('s_sprite.png', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=60x30', '-frames:v', '1']);
  const isp = await ff.probe(sprite);
  const rain = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'animRain.js')).href);
  const rp = { count: 12, speed: 0.6, size: 0.15, spread: 0.3, rotation: 90, wind: 0.1, duration: 2, loop: true, seed: 7 };
  const outr = path.join(DIR, 'out_rain.webm');
  const bp = rain.rainBakePlan(rp, isp, { width: 320, height: 180, fps: 30 }, outr, ff.findBinaries().version ? ff.findBinaries().version[1] : 99);
  const pts2 = rain.rainParticles(rp, 320, 180, 2);
  assert(JSON.stringify(pts2) === JSON.stringify(bp.particles) && pts2.every((q) => Math.abs(q.v * 2 - Math.round(q.v * 2)) < 0.01), 'частицы одинаковы для предпросмотра и запекания; круги целые (зацикливание)');
  await ff.engine('export', { plan: { args: bp.args, filter: bp.filter, duration: bp.duration, output: outr } });
  const ir = await ff.probe(outr);
  assert(ir.vcodec === 'vp9' && Math.abs(ir.duration - 2) < 0.15 && ir.width === 320, `запечено: ${ir.vcodec} ${ir.width}×${ir.height}, ${ir.duration} с`);
  const { stdout: rgba } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', outr, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { binaryStdout: true });
  let clear = 0; let solid = 0;
  for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] < 10) clear++; else if (rgba[i] > 245) solid++; }
  assert(clear > rgba.length / 8 && solid > 50, `прозрачность: пустых ${clear}, непрозрачных ${solid} точек`);
  const po = {
    media: { h: ih, r: { ...ir, path: outr } },
    videoClips: [{ mediaId: 'h', in: 0, out: 2, start: 0, volume: 1, muted: false, crop: { l: 0.5, t: 0, r: 0, b: 0 }, fit: 'stretch' }],
    videoTracks: [{ id: 'vtk_ov', clips: [{ mediaId: 'r', in: 0, out: 2, start: 1, volume: 1, muted: true }] }],
    audioTracks: [],
  };
  const bo = plan.buildExport(po, { width: 320, height: 180, fps: 30 });
  assert(Math.abs(bo.duration - 3) < 1e-6 && bo.inputs.join(' ').includes('-c:v libvpx-vp9 -ss') && /overlay=x=/.test(bo.filter), `верхняя видеодорожка: длина ${bo.duration} = 1 + 2, декодер VP9 перед -i`);
  const outo = path.join(DIR, 'out_overlay.mp4');
  await startExport(po, { width: 320, height: 180, fps: 30, codec, quality: 'high', output: outo });
  const countGreen = async (tt) => { const fr = await rgb(outo, tt); let g = 0; for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) if (isGreen(fr.px(x, y))) g++; return { g, fr }; };
  const before0 = await countGreen(0.5); const during = await countGreen(1.6);
  assert(before0.g === 0 && isBlue(before0.fr.px(32, 18)), 'до наложения — только видео');
  assert(during.g > 3 && isBlue(during.fr.px(1, 1)) || during.g > 3, `во время наложения видны картинки: ${during.g} зелёных точек`);

  assert(a2 - a1 > 10 && a2 - a1 < 17, `дорожка с усилением компрессора громче на ${(a2 - a1).toFixed(1)} дБ (≈ 12–15)`);
}

// M4: несколько видеодорожек, трансформ, кадрирование, переход на верхней дорожке, скрытая дорожка, альфа (PNG)
async function tracksTest(enc) {
  console.log('Видеодорожки и трансформ:');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  const col = (n, c) => make(`t_${n}.mp4`, ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=30`, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const [ir, ig, ib, iw] = await Promise.all([col('red', 'red'), col('green', 'green'), col('blue', 'blue'), col('white', 'white')].map(async (p) => ff.probe(await p)));
  // PNG с прозрачностью: левая половина — непрозрачная белая, правая — прозрачная
  const png = await make('t_half.png', ['-f', 'lavfi', '-i', 'color=c=white@1:s=64x64,format=rgba,geq=r=255:g=255:b=255:a=if(lt(X\\,32)\\,255\\,0)', '-frames:v', '1']);
  const ip = await ff.probe(png);
  const clip = (mediaId, start, len, extra = {}) => ({ mediaId, in: 0, out: len, start, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra });
  const W = 320; const H = 180;
  const project = {
    media: { r: ir, g: ig, b: ib, w: iw, p: ip },
    videoClips: [clip('b', 0, 6)],
    videoTracks: [
      // V2: PiP в правом верхнем углу (0,5–1,5 с); повёрнутый полупрозрачный (2–3,5); переход на V2 (3,5) к кадрированному
      { id: 'vtk_a', clips: [
        clip('r', 0.5, 1, { transform: { x: 0.25, y: -0.25, scale: 0.5 } }),
        clip('g', 2, 1.5, { transform: { scale: 0.5, rotate: 90, opacity: 0.5 } }),
        clip('w', 3.5, 1.5, { transition: { type: 'fade', duration: 0.5 }, crop: { l: 0.5, t: 0, r: 0, b: 0 }, transform: { x: -0.25, scale: 0.5 } }),
      ] },
      // V3: картинка с прозрачностью на весь кадр (5–5,8 с); скрытая V4 не видна
      { id: 'vtk_b', clips: [clip('p', 5, 0.8, { fit: 'stretch' })] },
      { id: 'vtk_c', hidden: true, clips: [clip('r', 0, 6)] },
    ],
    audioTracks: [],
  };
  const out = path.join(DIR, 'out_tracks.mp4');
  const r = await startExport(project, { width: W, height: H, fps: 30, codec, quality: 'high', output: out });
  assert(Math.abs(r.duration - 6) < 0.01, `длина ${r.duration} = 6 (верхние дорожки внутри основной)`);
  // rgb() даёт кадр 64×36: x·5, y·5 в координатах 320×180
  const at = async (t) => await rgb(out, t);
  let f = await at(0.2);
  assert(isBlue(f.px(32, 18)) && isBlue(f.px(56, 6)), 'до PiP — только основная дорожка (скрытая V4 не видна)');
  f = await at(1.0);
  assert(isRed(f.px(48, 9)) && isBlue(f.px(16, 27)) && isBlue(f.px(30, 20)), `PiP: справа сверху красный ${f.px(48, 9)}, слева снизу синий ${f.px(16, 27)}`);
  f = await at(2.5);
  // Поворот на 90°: прямоугольник 160×90 становится 90×160 — по центру сверху вниз есть зелёный, по краям — синий
  const c = f.px(32, 18); const top = f.px(32, 3); const side = f.px(20, 18);
  // (green у lavfi — 0x008000: половина прозрачности над синим даёт ≈ 0,64,128)
  assert(c[1] > 40 && c[2] > 90 && c[2] < 200 && c[0] < 40 && top[1] > 40 && isBlue(side), `поворот 90° и прозрачность 50%: центр ${c}, верх ${top}, сбоку ${side}`);
  f = await at(4.6);
  // Кадрирование левой половины белого + сдвиг влево: белое 80×90 в центре (80, 90)
  assert(isWhite(f.px(16, 18)) && isBlue(f.px(32, 18)) && isBlue(f.px(3, 18)), `кадрирование + сдвиг: ${f.px(16, 18)} / ${f.px(32, 18)}`);
  f = await at(3.5); // середина перехода 3,25–3,75
  const mid = f.px(16, 18);
  assert(mid[0] > 60 && mid[0] < 220, `переход на верхней дорожке: в середине белый наполовину ${mid}`);
  f = await at(5.4);
  assert(isWhite(f.px(10, 18)) && isBlue(f.px(54, 18)), `PNG с альфой: левая половина белая ${f.px(10, 18)}, правая — видно основную ${f.px(54, 18)}`);
}
const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;

// Пустоты, переходы, затухания, реверс и стоп-кадр
async function effectsTest(enc) {
  console.log('Эффекты:');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  const red = await make('e_red.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const blue = await make('e_blue.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30', '-f', 'lavfi',
    '-i', 'sine=frequency=660:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const ir = await ff.probe(red); const ib = await ff.probe(blue);
  const media = { r: ir, b: ib };
  const out = (n) => path.join(DIR, `fx_${n}.mp4`);
  const exp = (name, project) => startExport(project, { width: 640, height: 360, fps: 30, codec, quality: 'high', output: out(name) });

  // 1) Переход «шторка справа налево» 1 с на стыке 3 с; пустота 6–7 с; затухание 1 с у третьего клипа
  const p1 = {
    media,
    videoClips: [
      { mediaId: 'r', in: 1, out: 4, start: 0, volume: 1, muted: false },
      { mediaId: 'b', in: 1, out: 4, start: 3, volume: 1, muted: false, transition: { type: 'wipeleft', duration: 1 } },
      { mediaId: 'r', in: 0, out: 3, start: 7, volume: 1, muted: false, fadeIn: 1, fadeOut: 1 },
    ],
    audioTracks: [{ muted: false, clips: [] }],
  };
  const r1 = await exp('wipe', p1);
  assert(Math.abs(r1.duration - 10) < 0.01, `длительность с пустотой и переходом не меняется: ${r1.duration} = 10`);
  const pr1 = await ff.probe(out('wipe'));
  assert(Math.abs(pr1.duration - 10) < 0.1, `файл ${pr1.duration.toFixed(2)} с ≈ 10`);
  let f = await rgb(out('wipe'), 2.75); // 25% перехода: правая четверть уже синяя
  assert(isRed(f.px(5, 18)) && isBlue(f.px(60, 18)), 'шторка справа налево: слева красный, справа синий');
  f = await rgb(out('wipe'), 6.5);
  assert(f.mean < 8, `в пустоте чёрный кадр (яркость ${f.mean.toFixed(1)})`);
  const fIn = await rgb(out('wipe'), 7.25); const fMid = await rgb(out('wipe'), 8.5); const fOut = await rgb(out('wipe'), 9.8);
  assert(fIn.mean < fMid.mean * 0.6 && fOut.mean < fMid.mean * 0.5, `появление/исчезание: ${fIn.mean.toFixed(0)} < ${fMid.mean.toFixed(0)} > ${fOut.mean.toFixed(0)}`);

  // 2) Жалюзи (своё выражение xfade): на 40% перехода в каждой полосе слева синий, справа красный
  const p2 = JSON.parse(JSON.stringify(p1));
  p2.videoClips[1].transition = { type: 'blinds', duration: 1 };
  await exp('blinds', p2);
  f = await rgb(out('blinds'), 2.9);
  assert(isBlue(f.px(1, 18)) && isRed(f.px(5, 18)), 'жалюзи: полосы открываются слева направо');

  // 3) Все переходы собираются без ошибок
  for (const type of ['fade', 'fadeblack', 'fadewhite', 'smoothup', 'slideright', 'circleopen', 'circleclose', 'zoomin', 'hblur']) {
    const p = JSON.parse(JSON.stringify(p1));
    p.videoClips[1].transition = { type, duration: 0.6 };
    p.videoClips[1].in = 0; // нет кадров «до» — должен повториться первый кадр
    const r = await exp(`t_${type}`, p);
    assert(Math.abs(r.duration - 10) < 0.01, `переход ${type} собран`);
  }

  // 4) Реверс: кадр t в развёрнутом файле = кадр (b - t) в исходнике
  const ia = await ff.probe(path.join(DIR, 'a_av1_1440p60.mp4'));
  let t0 = Date.now();
  const rev = await ff.reverse(ia, 2, 5, null, enc);
  const irev = await ff.probe(rev);
  assert(Math.abs(irev.duration - 3) < 0.1 && irev.hasAudio && irev.vcodec === 'h264', `реверс 3 с создан за ${Date.now() - t0} мс`);
  const diff = async (x, y) => {
    const A = await rgb(rev, x); const B = await rgb(path.join(DIR, 'a_av1_1440p60.mp4'), y);
    let s = 0; for (let yy = 0; yy < 36; yy += 3) for (let xx = 0; xx < 64; xx += 3) { const p = A.px(xx, yy); const q = B.px(xx, yy); s += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
    return s / (22 * 12 * 3);
  };
  const dSame = await diff(0.5, 4.5); const dOther = await diff(0.5, 2.5);
  assert(dSame < dOther / 2, `реверс: кадры совпадают (${dSame.toFixed(1)} против ${dOther.toFixed(1)})`);
  // 5) Стоп-кадр
  t0 = Date.now();
  const fr = await ff.freeze(ia, 3, enc);
  const ifr = await ff.probe(fr);
  assert(Math.abs(ifr.duration - ff.FREEZE_FILE_SEC) < 0.2 && !ifr.hasAudio, `стоп-кадр создан за ${Date.now() - t0} мс`);
  // 6) Тишина
  const sil = await ff.silence(out('wipe'), -40, 0.4);
  assert(sil.some((s) => s.start > 6 && s.start < 6.2), `тишина в пустоте найдена: ${JSON.stringify(sil)}`);
}

// M5: текст (картинка PNG с альфой, как её готовит окно — exportAssets.js) поверх видео, титры «roll»,
// вшитые субтитры (.ass через libass со шрифтами программы) и мягкие (mov_text).
async function textTest(enc) {
  console.log('Текст и субтитры:');
  const { pathToFileURL } = require('url');
  const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
  const subs = await js('subtitles.js');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  const W = 640; const H = 360;
  const blue = await make('t_blue.mp4', ['-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:r=30`, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const ib = await ff.probe(blue);
  // «Текст»: прозрачный кадр, белый прямоугольник в верхней трети (так выглядит PNG, который рисует окно)
  const png = await make('t_text.png', ['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba,drawbox=x=220:y=40:w=200:h=60:color=white@1:t=fill:replace=1`, '-frames:v', '1']);
  // Титры: полоса W×80 с белой полосой посередине
  const strip = await make('t_strip.png', ['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x80,format=rgba,drawbox=x=100:y=20:w=440:h=40:color=white@1:t=fill:replace=1`, '-frames:v', '1']);
  const text = (id, start, dur, extra = {}) => ({ id, kind: 'text', in: 0, out: dur, start, volume: 1, muted: true, fadeIn: 0, fadeOut: 0, text: { content: id }, ...extra });
  const pr = {
    media: { b: ib }, background: '#000000',
    videoClips: [{ mediaId: 'b', in: 0, out: 6, start: 0, volume: 1, muted: true }],
    videoTracks: [{ id: 'vtk_t', clips: [text('t1', 1, 2), text('roll', 3, 3, { text: { content: 'credits', motion: 'roll' } })] }],
    audioTracks: [],
    subtitleTracks: [{ id: 'stk_1', style: subs.cleanSubStyle({ position: 'bottom', size: 0.09, color: '#ffff00' }), cues: [{ id: 'c1', start: 0.5, end: 2.5, text: 'Привет, мир!' }] }],
  };
  const plan = await js('exportPlan.js');
  // Без подготовленных файлов текст пропускается с предупреждением
  const b0 = plan.buildExport(pr, { width: W, height: H, fps: 30, assets: { texts: {} } });
  assert(b0.warnings.length === 2 && b0.inputs.filter((x) => x === '-i').length === 1, `без PNG текст пропущен: ${b0.warnings[0]}`);
  const fontsdir = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'fonts');
  const assFile = path.join(DIR, 't_subs.ass');
  fs.writeFileSync(assFile, subs.toAss([{ style: pr.subtitleTracks[0].style, cues: pr.subtitleTracks[0].cues }], { W, H, fontName: (f) => (f === 'Inter' ? 'Inter Variable' : f) }));
  const assets = {
    texts: { t1: { path: png, w: W, h: H, roll: false }, roll: { path: strip, w: W, h: 80, roll: true } },
    subtitles: { mode: 'burn', ass: assFile, fontsdir, end: 2.5 },
  };
  const out = path.join(DIR, 'out_text.mp4');
  await startExport(pr, { width: W, height: H, fps: 30, codec, quality: 'high', output: out, assets });
  const io = await ff.probe(out);
  assert(Math.abs(io.duration - 6) < 0.15, `длительность ${io.duration}`);
  const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
  // Тонкие жёлтые буквы при уменьшении до 64×36 смешиваются с синим: ищем заметные красный и зелёный (у синего фона их нет)
  const isYellow = ([r, g]) => r > 70 && g > 70;
  const bright = (f, y0, y1, fn) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 64; x++) if (fn(f.px(x, y))) n++; return n; };
  const f1 = await rgb(out, 1.5);
  assert(isWhite(f1.px(32, 6)) && isBlue(f1.px(32, 18)), `текст в верхней трети ${f1.px(32, 6)}, ниже — видео ${f1.px(32, 18)}`);
  assert(bright(f1, 28, 36, isYellow) > 8, `субтитр жёлтым внизу: ${bright(f1, 28, 36, isYellow)} точек`);
  const f0 = await rgb(out, 0.2);
  assert(isBlue(f0.px(32, 6)) && bright(f0, 28, 36, isYellow) === 0, 'до начала текста и реплики — только видео');
  const f3 = await rgb(out, 2.8);
  assert(isWhite(f3.px(32, 6)) && bright(f3, 28, 36, isYellow) === 0, 'после конца реплики субтитра нет, текст ещё виден');
  // Титры едут снизу вверх: в начале клипа (3 с) полоса внизу, к середине (4,5 с) — около центра
  const rowOf = (f) => { let best = -1; let n = 0; for (let y = 0; y < 36; y++) { let k = 0; for (let x = 0; x < 64; x++) if (isWhite(f.px(x, y))) k++; if (k > n) { n = k; best = y; } } return best; };
  const r1 = rowOf(await rgb(out, 3.4)); const r2 = rowOf(await rgb(out, 4.5)); const r3 = rowOf(await rgb(out, 5.6));
  assert(r1 > r2 && r2 > r3 && r1 >= 24 && Math.abs(r2 - 16) <= 5, `титры едут вверх: строка ${r1} → ${r2} → ${r3}`);

  // Мягкие субтитры: отдельный поток mov_text с языком
  const srt = path.join(DIR, 't_subs.srt');
  fs.writeFileSync(srt, subs.toSrt(pr.subtitleTracks[0].cues));
  const out2 = path.join(DIR, 'out_softsubs.mp4');
  await startExport(pr, { width: W, height: H, fps: 30, codec, quality: 'compact', output: out2,
    assets: { texts: assets.texts, subtitles: { mode: 'soft', tracks: [{ path: srt, lang: 'rus', title: 'Русские' }], end: 2.5 } } });
  const { stderr } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-i', out2, '-map', '0:s:0', '-f', 'srt', '-'], {}).catch((e) => ({ stderr: e.stderr }));
  assert(/Subtitle: mov_text/.test(stderr) && /\(rus\)/.test(stderr), 'в MP4 поток субтитров mov_text (rus)');
  const back = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', out2, '-map', '0:s:0', '-f', 'srt', '-']);
  assert(back.stdout.includes('Привет, мир!'), 'текст реплики читается из файла');
  const f4 = await rgb(out2, 1.5);
  assert(bright(f4, 28, 36, isYellow) === 0, 'мягкие субтитры не вшиты в кадр');
}

(async () => {
  await ff.ready;
  DIR = path.join(ff.paths().temp, 'engine-test');
  fs.mkdirSync(DIR, { recursive: true });
  console.log('Программа:', ff.EXE);
  console.log('FFmpeg:', ff.findBinaries().ffmpeg);
  console.log(await ff.version());

  const enc = await ff.detectEncoders();
  console.log('Кодировщики:', enc);
  // node tests/engine-test.js --only tracks — только одна группа проверок (для отладки)
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  if (only) {
    await ({ tracks: tracksTest, effects: effectsTest, speed: speedTest, plugin: pluginTest, text: textTest })[only](enc);
    console.log('\nВСЁ ОК');
    return;
  }

  // Без видеокарты NVIDIA тестовые файлы и экспорт делаются на процессоре
  const av1 = enc.av1_nvenc ? ['-c:v', 'av1_nvenc', '-cq', '30'] : ['-c:v', 'libsvtav1', '-preset', '10', '-crf', '35'];
  const h264 = enc.h264_nvenc ? ['-c:v', 'h264_nvenc'] : ['-c:v', 'libx264', '-preset', 'veryfast'];
  const a = await make('a_av1_1440p60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', ...av1, '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const b = await make('b_h264_1080p30.mp4', ['-f', 'lavfi', '-i', 'smptehdbars=size=1920x1080:rate=30', '-f', 'lavfi',
    '-i', 'sine=frequency=880:sample_rate=44100', '-t', '8', ...h264, '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const c = await make('c_music.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=20',
    '-c:a', 'libmp3lame', '-b:a', '192k']);
  const d = await make('d_old.avi', ['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25', '-t', '3',
    '-c:v', 'mpeg4', '-q:v', '5']);

  // Запись «как у NVIDIA/OBS»: два звуковых потока — стерео (игра) и моно (микрофон)
  const e2 = await make('e_2audio.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '6',
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=0*c0[st]', '-map', '0:v', '-map', '[st]', '-map', '2:a',
    ...h264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata:s:a:1', 'title=Микрофон']);

  const ia = await ff.probe(a); const ib = await ff.probe(b); const ic = await ff.probe(c); const id = await ff.probe(d);
  const ie = await ff.probe(e2);
  console.log('Звуковые потоки:');
  assert(ie.audioStreams && ie.audioStreams.length === 2 && ie.audioStreams[0].channels === 2 && ie.audioStreams[1].channels === 1,
    `два потока: ${JSON.stringify(ie.audioStreams)}`);
  assert(ie.audioStreams[1].title === 'Микрофон', 'название второго потока');
  const pk0 = await ff.peaks(ie); const pk1 = await ff.engine('peaks', { info: ie, stream: 1 });
  assert(pk0.channels && pk0.channels.length === 2 && !pk1.channels, 'волна: стерео — 2 канала, моно — 1');
  // В левом канале синус, правый пустой
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  assert(avg(pk0.channels[0]) > 0.5 && avg(pk0.channels[1]) < 0.05, `левый ${avg(pk0.channels[0]).toFixed(2)}, правый ${avg(pk0.channels[1]).toFixed(2)}`);
  const as1 = await ff.engine('astream', { info: ie, stream: 1 });
  const ias = await ff.probe(as1);
  assert(!ias.hasVideo && ias.hasAudio && Math.abs(ias.duration - 6) < 0.15, 'второй поток извлечён для предпросмотра');
  {
    // Экспорт: видео без своего звука (noAudio) + только второй поток (1000 Гц) на дорожке с громкостью 50%
    const out2 = path.join(DIR, 'out_stream1.mp4');
    const pr = { media: { e: ie }, videoClips: [{ mediaId: 'e', in: 0, out: 6, start: 0, volume: 1, noAudio: true, link: 'L' }],
      audioTracks: [{ volume: 0.5, clips: [{ mediaId: 'e', in: 0, out: 6, start: 0, volume: 1, stream: 1, link: 'L' }] }] };
    await startExport(pr, { width: 1280, height: 720, fps: 30, codec: enc.h264_nvenc ? 'h264_nvenc' : 'libx264', quality: 'compact', output: out2 });
    const vd = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-i', out2, '-af', 'bandpass=f=1000:width_type=q:width=30,bandpass=f=1000:width_type=q:width=30,volumedetect', '-f', 'null', '-']);
    const hp = Number((vd.stderr.match(/mean_volume: (-?[\d.]+)/) || [])[1]);
    const vd2 = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-i', out2, '-af', 'bandpass=f=440:width_type=q:width=30,bandpass=f=440:width_type=q:width=30,volumedetect', '-f', 'null', '-']);
    const lp = Number((vd2.stderr.match(/mean_volume: (-?[\d.]+)/) || [])[1]);
    assert(hp > lp + 15, `в экспорте звучит второй поток (1000 Гц ${hp} дБ), первого (440 Гц ${lp} дБ) нет`);
  }
  console.log('Анализ:');
  // На Linux окно (WebKitGTK) не всегда играет AV1/HEVC — там для предпросмотра делается прокси
  const linux = process.platform === 'linux';
  assert(ia.vcodec === 'av1' && ia.width === 2560 && ia.fps === 60 && ia.hasAudio && ia.needsProxy === linux,
    `AV1 1440p60 распознан, прокси ${linux ? 'нужен (Linux)' : 'не нужен'}`);
  assert(ib.vcodec === 'h264' && ib.fps === 30 && !ib.needsProxy, 'H.264 1080p30 распознан');
  assert(!ic.hasVideo && ic.hasAudio && Math.abs(ic.duration - 20) < 0.2, 'MP3 распознан как аудио');
  assert(id.needsProxy, 'AVI (mpeg4) требует прокси');

  let t0 = Date.now();
  const th = await ff.thumbs(ia);
  assert(th.files.length >= 5, `миниатюры AV1: ${th.files.length} шт. за ${Date.now() - t0} мс`);
  t0 = Date.now();
  const pk = await ff.peaks(ic);
  assert(Math.abs(pk.data.length - 20 * pk.rate) < 5, `волна MP3: ${pk.data.length} точек за ${Date.now() - t0} мс`);
  t0 = Date.now();
  const px = await ff.proxy(id, null, enc);
  assert(fs.existsSync(px), `прокси для AVI создан за ${Date.now() - t0} мс`);

  const project = {
    media: { a: ia, b: ib, c: ic },
    videoClips: [
      { mediaId: 'a', in: 1, out: 5, volume: 1, muted: false },
      { mediaId: 'b', in: 0, out: 4, volume: 1, muted: true },
      { mediaId: 'a', in: 6, out: 9, volume: 1.5, muted: false },
    ],
    audioTracks: [{ muted: false, clips: [{ mediaId: 'c', in: 0, out: 15, start: 2, volume: 0.5, muted: false }] }],
  };
  // Ожидаемо: видео 4+4+3 = 11 c, музыка до 17 c → итог 17 c (в конце 6 c чёрного)

  const pick = (gpu, cpu) => (enc[gpu] ? gpu : cpu);
  const codecs = { av1: pick('av1_nvenc', 'libsvtav1'), hevc: pick('hevc_nvenc', 'libx265'), h264: pick('h264_nvenc', 'libx264') };
  for (const [vcodec, codec] of Object.entries(codecs)) {
    const out = path.join(DIR, `out_${codec}.mp4`);
    t0 = Date.now();
    let last = 0;
    const r = await startExport(project, { width: 2560, height: 1440, fps: 60, codec, quality: 'medium', output: out },
      { onProgress: (p) => { last = p.fraction; } });
    const io = await ff.probe(out);
    console.log(`Экспорт ${codec}: ${(r.size / 1e6).toFixed(1)} МБ, ${((Date.now() - t0) / 1000).toFixed(1)} с, прогресс ${Math.round(last * 100)}%`);
    assert(Math.abs(io.duration - 17) < 0.15, `длительность ${io.duration.toFixed(3)} ≈ 17`);
    assert(io.width === 2560 && io.height === 1440, 'разрешение 2560×1440');
    assert(io.fps === 60, `частота ${io.fps} fps`);
    assert(io.vcodec === vcodec, `кодек ${io.vcodec}`);
    assert(io.acodec === 'aac' && io.sampleRate === 48000, 'звук AAC 48 кГц');
  }

  // Проверка звука: 2-я часть (4..8 c) — клип без звука, но с музыкой 220 Гц;
  // 13..17 c — только музыка; до 2 c — только 440 Гц.
  const out = path.join(DIR, `out_${codecs.h264}.mp4`);
  const vol = async (ss, t) => {
    const { stderr } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', out,
      '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    return parseFloat(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]);
  };
  const v1 = await vol(0.2, 1.5); const v2 = await vol(4.5, 1); const v3 = await vol(13, 3);
  console.log(`Громкость: начало ${v1} дБ, клип без звука + музыка ${v2} дБ, только музыка ${v3} дБ`);
  assert(v2 < v1 && v3 < v1, 'музыка на 50% тише основного звука, отключённый клип не звучит');

  await effectsTest(enc);
  await viewTest(enc, ib);
  await speedTest(enc);
  await pluginTest(enc);
  await tracksTest(enc);
  await textTest(enc);
  console.log('\nВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
