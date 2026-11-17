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

// M0.4 / M0.2 / M0.9: кодировщики видеокарты (nvenc → qsv → amf → vaapi), кэш проверки на диске,
// параметры качества qsv/amf/vaapi в плане, проверка плана движком, очередь, реверс при b<a
async function encodersTest(enc) {
  console.log('Кодировщики и проверка плана:');
  const hw = ['h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf'];
  if (process.platform !== 'darwin') {
    for (const k of ['h264_nvenc', ...hw]) assert(typeof enc[k] === 'boolean', `кодировщик ${k} проверен: ${enc[k]}`);
  }
  assert(process.platform === 'linux' ? typeof enc.h264_vaapi === 'boolean' : enc.h264_vaapi === undefined, 'VAAPI проверяется только на Linux');
  // Выбор как в exportDialog.js / mcpBridge.js: первый доступный из nvenc → qsv → amf → vaapi
  const order = (c) => ['nvenc', 'qsv', 'amf', 'vaapi'].map((f) => `${c}_${f}`).find((e) => enc[e]) || null;
  const h264 = order('h264');
  if (enc.h264_nvenc) assert(h264 === 'h264_nvenc', 'есть NVENC — выбирается он');
  console.log(`  выбор для H.264: ${h264 || 'процессор'}; qsv=${enc.h264_qsv}, amf=${enc.h264_amf}`);
  // Кэш проверки на диске: <cache>/app/encoders.json, ключ — путь, размер и время ffmpeg
  const P = ff.paths();
  const file = path.join(P.app_cache || path.join(P.cache_dir, 'app'), 'encoders.json');
  assert(fs.existsSync(file), `кэш проверки кодировщиков: ${file}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(j.version === 2 && j.entries.some((e) => e.size > 0 && e.mtime > 0 && e.encoders.libx264 === true), 'в кэше — ключ (размер, время) и результат');
  let t0 = Date.now();
  const again = await ff.detectEncoders();
  const cached = Date.now() - t0;
  assert(JSON.stringify(again) === JSON.stringify(enc), `повторная проверка берётся из кэша (${cached} мс)`);
  t0 = Date.now();
  const fresh = await ff.engine('encoders', { reset: true });
  assert(fresh.libx264 === true && fresh.h264_nvenc === enc.h264_nvenc, `сброс кэша — проверка заново (${Date.now() - t0} мс)`);
  const q = await ff.engine('queue');
  assert(q.cpu.limit >= 2 && q.gpu.limit === 3, `очередь: процессор ${q.cpu.limit}, видеокарта ${q.gpu.limit}`);

  // План с параметрами каждого аппаратного кодировщика проходит проверку движка (plancheck)
  const src = await make('t_enc.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const im = await ff.probe(src);
  const pr = { media: { m: im }, videoClips: [{ mediaId: 'm', in: 0, out: 2, start: 0, volume: 1 }], audioTracks: [] };
  const planMod = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'exportPlan.js')).href);
  const out = path.join(DIR, 'out_hw.mp4');
  for (const codec of [...hw, 'h264_vaapi', 'hevc_vaapi']) {
    for (const quality of ['high', 'compact']) {
      const plan = planMod.exportCommand(pr, { width: 320, height: 180, fps: 30, codec, quality, output: out });
      assert(plan.args.includes(codec), `${codec}/${quality}: ${plan.args.slice(plan.args.indexOf('-c:v'), plan.args.indexOf('-fps_mode')).join(' ')}`);
      if (codec.endsWith('_vaapi')) assert(plan.args.includes('-vaapi_device') && /hwupload\[vhw\]$/.test(plan.filter) && plan.args.includes('[vhw]'), 'VAAPI: hwupload и -vaapi_device');
      assert(await ff.engine('checkplan', { plan }) === true, `${codec}: план проходит проверку`);
    }
  }
  // Реальный экспорт на доступной видеокарте Intel/AMD (на машине с NVIDIA обычно их нет)
  for (const codec of hw.filter((c) => enc[c])) {
    const o = path.join(DIR, `out_${codec}.mp4`);
    await startExport(pr, { width: 320, height: 180, fps: 30, codec, quality: 'medium', output: o });
    const io = await ff.probe(o);
    assert(Math.abs(io.duration - 2) < 0.15, `экспорт ${codec}: ${io.vcodec}, ${io.duration} с`);
  }
  // Подделанные планы движок тоже отклоняет: протоколы во входе и выходе, movie во вложенном виде
  const base = planMod.exportCommand(pr, { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'medium', output: out });
  const bad = async (name, f) => {
    const plan = JSON.parse(JSON.stringify(base)); f(plan);
    let err = null;
    try { await ff.engine('checkplan', { plan }); } catch (e) { err = e.message; }
    assert(err && /План экспорта отклонён|Export plan rejected/.test(err), `${name}: ${err}`);
  };
  const iIn = base.args.indexOf('-i') + 1;
  await bad('вход concat:', (p) => { p.args[iIn] = `concat:${src}|${src}`; });
  await bad('вход subfile,,', (p) => { p.args[iIn] = `subfile,,start,0,end,0,,:${src}`; });
  await bad('вход file:', (p) => { p.args[iIn] = `file:${src}`; });
  await bad('-f concat', (p) => { p.args[p.args.indexOf('-f') + 1] = 'concat'; });
  await bad('выход http:', (p) => { p.output = 'http://127.0.0.1/x.mp4'; });
  await bad('movie в значении', (p) => { p.filter = p.filter.replace('setpts=PTS-STARTPTS', 'hue=s=1\\,movie=x.mp4,setpts=PTS-STARTPTS'); });
  await bad('-filter_script', (p) => { p.args.splice(1, 0, '-filter_script', src); });
  // M0.9: реверс при b < a — понятная ошибка, а не отрицательная длительность
  let rerr = null;
  try { await ff.reverse(im, 1.5, 0.5); } catch (e) { rerr = e.message; }
  assert(rerr && /реверс|reverse/i.test(rerr), `реверс 1,5 → 0,5 отклонён: ${rerr}`);
}

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
  // 0.5.x: картинка текста — один кадр (без -loop) + фильтр loop; наложение в формате кадра (yuv420, не auto)
  const bp = plan.buildExport(pr, { width: W, height: H, fps: 30, assets });
  assert(!bp.inputs.includes('-loop') && /\[1:v\]loop=loop=\d+:size=1:start=0,setpts=N\/\(30\)\/TB,/.test(bp.filter) && /overlay=[^;]*:format=yuv420:eof_action/.test(bp.filter),
    'план: PNG одним кадром (loop), overlay=format=yuv420');
  // Аппаратное декодирование: -hwaccel только у видеофайлов, не у картинок
  const bh = plan.buildExport(pr, { width: W, height: H, fps: 30, assets, hwDecode: 'd3d11va' });
  const hwAt = bh.inputs.indexOf('-hwaccel');
  assert(hwAt >= 0 && bh.inputs.filter((x) => x === '-hwaccel').length === 1 && bh.inputs[hwAt + 1] === 'd3d11va' && bh.inputs.indexOf(blue) > hwAt, 'план: -hwaccel у видео, у PNG — нет');
  assert(!plan.buildExport(pr, { width: W, height: H, fps: 30, assets, hwDecode: 'opencl' }).inputs.includes('-hwaccel'), 'неизвестный способ декодирования не попадает в план');
  assert(plan.hwDecodeFor('auto', { platform: 'windows', hwaccels: ['cuda', 'd3d11va'] }, { h264_nvenc: true }) === 'cuda' &&
    plan.hwDecodeFor('auto', { platform: 'windows', hwaccels: ['cuda', 'd3d11va'] }, { h264_nvenc: false }) === 'd3d11va' &&
    plan.hwDecodeFor('auto', { platform: 'linux', hwaccels: ['vaapi'] }, {}) === null && plan.hwDecodeFor('off', { platform: 'windows', hwaccels: ['d3d11va'] }, {}) === null,
  'hwDecodeFor: NVIDIA → cuda, Windows → d3d11va, Linux/выкл. → процессор');
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
  // Надпись одним кадром стоит ровно своё время: 1–3 с (кадр 30 к/с)
  const fEnd = await rgb(out, 3.05); const fIn = await rgb(out, 2.95);
  assert(isWhite(fIn.px(32, 6)) && isBlue(fEnd.px(32, 6)), `надпись видна до 2,95 с и пропадает к 3,05 с: ${fIn.px(32, 6)} / ${fEnd.px(32, 6)}`);
  // Аппаратное декодирование (NVIDIA): тот же кадр
  if (enc.h264_nvenc) {
    const outHw = path.join(DIR, 'out_text_hw.mp4');
    await startExport(pr, { width: W, height: H, fps: 30, codec, quality: 'high', output: outHw, assets: { texts: assets.texts }, hwDecode: 'cuda' });
    const fh = await rgb(outHw, 1.5);
    assert(isWhite(fh.px(32, 6)) && isBlue(fh.px(32, 18)), `экспорт с -hwaccel cuda: текст ${fh.px(32, 6)}, видео ${fh.px(32, 18)}`);
  }

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

// 0.5.0: обводка и скругление видео (PNG обводки и маски — как их рисует окно), фигуры (PNG кадра, как текст)
async function borderTest(enc) {
  console.log('Обводка, углы и фигуры:');
  const { pathToFileURL } = require('url');
  const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
  const plan = await js('exportPlan.js');
  const border = await js('border.js');
  const shapes = await js('shapes.js');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  const W = 640; const H = 360;
  const col = (n, c) => make(`bd_${n}.mp4`, ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=30`, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const [ib, ir, ig] = await Promise.all([col('blue', 'blue'), col('red', 'red'), col('green', 'green')].map(async (p) => ff.probe(await p)));
  const clip = (mediaId, start, len, extra = {}) => ({ id: `c_${mediaId}_${start}`, mediaId, in: 0, out: len, start, volume: 1, muted: true, fadeIn: 0, fadeOut: 0, ...extra });

  // Модель: пустая обводка — null, пределы, у текста и фигур обводки клипа нет
  assert(border.cleanBorder({ width: 0, radius: 0 }) === null && border.cleanBorder({ width: 1, color: 'red' }).width === 0.05
    && border.cleanBorder({ width: 0.01, color: '#ABCDEF' }).color === '#abcdef', 'cleanBorder: пустая → null, пределы, цвет');
  assert(border.borderOf({ kind: 'shape', border: { width: 0.01 } }) === null && border.borderOf({ mediaId: 'x', border: { radius: 0.02 } }).radius === 0.02, 'borderOf: только у клипов с файлом');
  const sh = shapes.cleanShape({ type: 'star', w: 5, fill: 'zzz', strokeWidth: -1 });
  assert(sh.type === 'rect' && sh.w === 2 && sh.fill === '#3b82f6' && sh.strokeWidth === 0, `cleanShape: ${JSON.stringify(sh)}`);
  assert(shapes.newShape('chamfer').corner > 0 && shapes.newShape('ellipse').type === 'ellipse', 'newShape: у скошенной фигуры срез углов виден сразу');
  const r = shapes.shapeRect({ shape: { w: 0.5, h: 0.5 }, transform: { scale: 2, x: 0.1 } }, W, H);
  assert(r.w === 640 && r.h === 360 && r.cx === 384, `shapeRect: ${JSON.stringify(r)}`);

  // Размер слоя (по нему рисуются PNG): PiP ½ — 320×180, весь кадр — 640×360, «вписать» 4:3 — по высоте
  const pip = clip('r', 0, 2, { transform: { x: 0.25, scale: 0.5 }, border: { width: 24 / H, color: '#ffffff' } });
  const ls = plan.layerSize(pip, ir, W, H);
  assert(ls.w === 320 && ls.h === 180, `layerSize PiP ${ls.w}×${ls.h}`);
  const ls43 = plan.layerSize({ mediaId: 'q' }, { width: 400, height: 300 }, W, H);
  assert(ls43.w === 480 && ls43.h === 360, `layerSize 4:3 ${ls43.w}×${ls43.h}`);

  // PNG: обводка 24 px (белая рамка), маска — прозрачные углы 40×40
  const ring = (w, h) => make(`bd_ring_${w}x${h}.png`, ['-f', 'lavfi', '-i', `color=c=black@0:s=${w}x${h},format=rgba,drawbox=x=0:y=0:w=${w}:h=${h}:t=24:color=white@1:replace=1`, '-frames:v', '1']);
  const mask = await make('bd_mask.png', ['-f', 'lavfi', '-i', 'color=c=white@1:s=320x180,format=rgba,geq=r=255:g=255:b=255:a=if((lt(X\\,40)+gt(X\\,279))*(lt(Y\\,40)+gt(Y\\,139))\\,0\\,255)', '-frames:v', '1']);
  const shapePng = await make('bd_shape.png', ['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba,drawbox=x=20:y=280:w=60:h=60:color=yellow@1:t=fill:replace=1`, '-frames:v', '1']);
  const rounded = clip('r', 2, 2, { transform: { x: 0.25, scale: 0.5 }, border: { width: 0, radius: 0.1 } });
  const shapeClip = { id: 'shp', kind: 'shape', in: 0, out: 6, start: 0, volume: 1, muted: true, fadeIn: 0, fadeOut: 0, shape: { type: 'rect' } };
  const pr = {
    media: { b: ib, r: ir, g: ig }, background: '#000000',
    // Основная дорожка: синий 0–4, зелёный с обводкой 4–6 (без трансформа — тоже слоем)
    videoClips: [clip('b', 0, 4), clip('g', 4, 2, { border: { width: 24 / H, color: '#ffffff' } })],
    videoTracks: [{ id: 'vtk_p', clips: [pip, rounded] }, { id: 'vtk_s', clips: [shapeClip] }],
    audioTracks: [],
  };
  // Без подготовленных файлов: обводки и фигура пропускаются с предупреждениями, экспорт не ломается
  const b0 = plan.buildExport(pr, { width: W, height: H, fps: 30, assets: { texts: {}, borders: {} } });
  // (два красных клипа — одно предупреждение: имя файла то же)
  assert(b0.warnings.length === 3 && !/blend/.test(b0.filter), `без PNG — предупреждения: ${b0.warnings.join(' | ')}`);
  const assets = {
    texts: { shp: { path: shapePng, w: W, h: H, roll: false } },
    borders: {
      [pip.id]: { w: 320, h: 180, ring: await ring(320, 180) },
      [rounded.id]: { w: 320, h: 180, mask },
      [pr.videoClips[1].id]: { w: 640, h: 360, ring: await ring(640, 360) },
    },
  };
  const b1 = plan.buildExport(pr, { width: W, height: H, fps: 30, assets });
  assert(b1.warnings.length === 0 && /blend=c3_mode=multiply/.test(b1.filter) && (b1.filter.match(/\[bdr\d+\]overlay/g) || []).length === 2, 'план: маска через blend, две обводки через overlay');
  const out = path.join(DIR, 'out_border.mp4');
  await startExport(pr, { width: W, height: H, fps: 30, codec, quality: 'high', output: out, assets });
  const io = await ff.probe(out);
  assert(Math.abs(io.duration - 6) < 0.15, `длительность ${io.duration}`);
  const isYellow = ([r2, g, b]) => r2 > 180 && g > 180 && b < 90;
  // rgb(): кадр 64×36, PiP — x 32…64, y 9…27 (обводка 24 px = 2,4 точки)
  let f = await rgb(out, 1);
  assert(isWhite(f.px(33, 18)) && isWhite(f.px(48, 10)) && isRed(f.px(48, 18)) && isBlue(f.px(16, 18)), `обводка PiP: край ${f.px(33, 18)}, верх ${f.px(48, 10)}, центр ${f.px(48, 18)}`);
  assert(isYellow(f.px(5, 31)), `фигура на верхней дорожке ${f.px(5, 31)}`);
  f = await rgb(out, 3);
  assert(isBlue(f.px(33, 10)) && isBlue(f.px(63, 26)) && isRed(f.px(33, 18)) && isRed(f.px(48, 10)), `скруглённые углы: угол ${f.px(33, 10)} / ${f.px(63, 26)}, край ${f.px(33, 18)}`);
  f = await rgb(out, 5);
  // (green у lavfi — 0x008000)
  const g0 = f.px(32, 18);
  assert(isWhite(f.px(1, 18)) && isWhite(f.px(32, 1)) && g0[1] > 100 && g0[0] < 60 && g0[2] < 60, `обводка на основной дорожке: край ${f.px(1, 18)}, центр ${f.px(32, 18)}`);
}

// 0.5.0: таймер — модель, моменты кадров, сборка APNG (makeApng) и его наложение в экспорте (кадры меняются по времени)
async function timerTest(enc) {
  console.log('Таймер:');
  const { pathToFileURL } = require('url');
  const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
  const timer = await js('timer.js');
  const plan = await js('exportPlan.js');
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  const styles = await js('timerStyles.js');
  const tm = timer.cleanTimer({ duration: 0.2, mode: 'sideways', size: 9, style: 'neon', ring: 'x', colors: { case: 'x', fill: '#ABCDEF' } });
  assert(tm.duration === 1 && tm.mode === 'down' && tm.size === 1.5 && tm.style === 'classic' && tm.ring === 'once' && tm.progress === 'elapsed'
    && tm.colors.case === styles.stylePalette('classic').case && tm.colors.fill === '#abcdef', `cleanTimer: ${JSON.stringify(tm)}`);
  // Смена стиля без цветов — цвета нового стиля; со своими цветами — они
  const tr = timer.cleanTimer({ style: 'retro' }, tm);
  assert(tr.style === 'retro' && tr.colors.case === styles.stylePalette('retro').case, `стиль ретро — его цвета: ${tr.colors.case}`);
  assert(timer.cleanTimer({ colors: { ...tr.colors, fill: '#123456' } }, tr).colors.fill === '#123456', 'свой цвет сектора сохраняется');
  const s = (d, mode, l, ring = 'once') => timer.timerState(timer.cleanTimer({ duration: d, mode, ring }), l);
  assert(s(10, 'down', 0).text === '0:10' && s(10, 'down', 0.5).text === '0:10' && s(10, 'down', 9.5).text === '0:01' && s(10, 'down', 10).text === '0:00' && s(10, 'down', 10).ringing,
    'обратный отсчёт 10 → 1 → 0, в конце — звонок');
  assert(s(90, 'up', 0).text === '0:00' && s(90, 'up', 65.4).text === '1:05' && s(90, 'up', 95).text === '1:30' && !s(90, 'up', 89).ringing, 'прямой отсчёт 0:00 → 1:30');
  assert(s(600, 'down', 0).text === '10:00' && s(600, 'down', 1).text === '09:59' && s(3600, 'down', 0).text === '1:00:00' && s(3600, 'down', 3599.5).text === '0:00:01', 'формат по длительности: mm:ss, h:mm:ss');
  // Звонок: один раз / повторять / нет
  const R = timer.RING_DUR;
  assert(s(10, 'down', 10 + R + 0.1).ringing === false && s(10, 'down', 10 + R + 0.1, 'loop').ringing && Math.abs(s(10, 'down', 10 + R + 0.1, 'loop').u - 0.1) < 1e-6
    && s(10, 'down', 10.2, 'none').ringing === false && s(10, 'down', 10.2, 'none').text === '0:00', 'звонок: один раз, повтор, без звонка');
  const L = (ring, cur) => timer.timerClipLen({ duration: 10, ring }, cur);
  assert(Math.abs(L('once') - (10 + R)) < 1e-6 && L('none') === 10 && Math.abs(L('loop') - (10 + 3 * R)) < 1e-6 && L('loop', 30) === 30 && Math.abs(L('loop', 11) - (10 + 3 * R)) < 1e-6,
    `длина клипа: ${L('once')} / ${L('none')} / ${L('loop')} / ${L('loop', 30)}`);
  // Слои стилей: SVG у всех трёх, половинки сектора и стрелка — в квадрате spin
  for (const id of styles.TIMER_STYLES) {
    const x = styles.layerSvgs(id, styles.stylePalette(id), { fmt: 'm:ss', progress: 'elapsed', digits: true });
    assert(['back', 'front', 'hand', 'halfL', 'halfR', 'rightOv'].every((k) => typeof x[k] === 'string' && x[k].startsWith('<svg')) && x.digits && x.digits.fs > 0, `слои стиля ${id}`);
    const rg = styles.ringSvgs(id, styles.stylePalette(id), { fmt: 'm:ss', progress: 'elapsed', digits: true }, 0.5);
    assert(rg.under.startsWith('<svg') && Array.isArray(rg.pose) && rg.pose.length > 0, `звонок стиля ${id}`);
  }
  const ft = timer.timerFrameTimes(timer.cleanTimer({ duration: 10 }), 10 + timer.RING_DUR, 30);
  const sum = ft.reduce((a, x) => a + x.d, 0);
  assert(Math.abs(sum - 11.6) < 1e-6 && ft.length <= 900 + 60 && ft[0].t === 0, `кадры экспорта: ${ft.length}, сумма ${sum}`);
  const ftLong = timer.timerFrameTimes(timer.cleanTimer({ duration: 3600 }), 3600 + timer.RING_DUR, 60);
  assert(ftLong.length < 3600 + 60 && ftLong.length > 3600, `длинный таймер — кадр в секунду: ${ftLong.length}`);

  // APNG из трёх кадров: красный 1 с, зелёный 1 с, синий 0,6 с (как кадры таймера в рамке 160×160)
  const W = 640; const H = 360;
  const fr = async (c) => fs.readFileSync(await make(`tm_${c}.png`, ['-f', 'lavfi', '-i', `color=c=${c}:s=160x160,format=rgba`, '-frames:v', '1']));
  const apng = timer.makeApng([await fr('red'), await fr('green'), await fr('blue')], [1, 1, 0.6]);
  const apngFile = path.join(DIR, 'tm_anim.apng');
  fs.writeFileSync(apngFile, apng);
  const pa = await ff.probe(apngFile);
  assert(pa && pa.hasVideo && pa.width === 160, `APNG читается FFmpeg: ${pa && pa.width}×${pa && pa.height}, ${pa && pa.duration} с`);
  const bg = await make('tm_bg.mp4', ['-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:r=30`, '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const ib = await ff.probe(bg);
  const tclip = { id: 'tmr', kind: 'timer', in: 0, out: 2.6, start: 0.5, volume: 1, muted: true, fadeIn: 0, fadeOut: 0, timer: { duration: 1 } };
  const pr = { media: { w: ib }, videoClips: [{ id: 'v', mediaId: 'w', in: 0, out: 4, start: 0, volume: 1, muted: true }], videoTracks: [{ id: 'vtk_t', clips: [tclip] }], audioTracks: [] };
  const b0 = plan.buildExport(pr, { width: W, height: H, fps: 30, assets: { texts: {} } });
  assert(b0.warnings.length === 1, `без APNG — предупреждение: ${b0.warnings[0]}`);
  const assets = { texts: { tmr: { path: apngFile, w: 160, h: 160, x: 400, y: 100, roll: false, anim: true } } };
  const b1 = plan.buildExport(pr, { width: W, height: H, fps: 30, assets });
  assert(!b1.inputs.includes('-loop') && /overlay=x=400:y=100/.test(b1.filter), 'план: APNG — видео (без -loop), в своей рамке');
  const out = path.join(DIR, 'out_timer.mp4');
  await startExport(pr, { width: W, height: H, fps: 30, codec, quality: 'high', output: out, assets });
  // Рамка 400…560 × 100…260 → в кадре 64×36: x 40…56, y 10…26; центр (48, 18)
  const at = async (t) => (await rgb(out, t)).px(48, 18);
  const p0 = await at(0.3); const p1 = await at(1.0); const p2 = await at(2.0); const p3 = await at(2.8); const p4 = await at(3.5);
  const g = ([r2, g2, b2]) => g2 > 90 && r2 < 80 && b2 < 80;
  assert(isWhite(p0) && isRed(p1) && g(p2) && isBlue(p3) && isWhite(p4), `кадры APNG по времени: ${p0} / ${p1} / ${p2} / ${p3} / ${p4}`);
  assert(isWhite((await rgb(out, 1.0)).px(10, 18)), 'вне рамки таймера — видео под ним');
}

// Шторка «ДО / ПОСЛЕ» (compare.rs, --engine compare): кадр нужного момента, ДО = исходник, ПОСЛЕ — с цепочкой
// эффектов клипа (effects.js compareRequest, как в экспорте), кадрирование, картинка, кэш, проверка цепочки
async function compareTest() {
  console.log('Шторка «ДО / ПОСЛЕ»:');
  const { pathToFileURL } = require('url');
  const fxm = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'effects.js')).href);
  // 0–2 с красный, 2–4 зелёный, 4–6 синий (25 кадров/с: кадр 2,00 с — первый зелёный)
  const rgbFile = await make('cmp_rgb.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=2', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50']);
  const halves = await make('cmp_halves.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=25:d=4', '-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=25:d=4',
    '-filter_complex', '[0:v][1:v]hstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const png = await make('cmp_photo.png', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=400x300', '-frames:v', '1']);
  const im = await ff.probe(rgbFile); const ih = await ff.probe(halves); const ip = await ff.probe(png);
  const gray = ([r, g, b]) => Math.abs(r - g) < 20 && Math.abs(g - b) < 20;
  const cmp = (clip, m, tl, width = 320) => ff.engine('compare', fxm.compareRequest(clip, m, tl, width));
  const clip = { mediaId: 'm', in: 0, out: 6, start: 10, volume: 1, effects: ['bw'] };

  let r = await cmp(clip, im, 13);
  let a = await rgb(r.beforePath, 0); let b = await rgb(r.afterPath, 0);
  assert(isGreen(a.px(32, 18)) && gray(b.px(32, 18)) && b.px(32, 18)[1] > 60, `момент 3 с: ДО зелёный ${a.px(32, 18)}, ПОСЛЕ серый ${b.px(32, 18)} (эффект bw)`);
  const src = await rgb(rgbFile, 3);
  let d = 0; for (let y = 0; y < 36; y += 5) for (let x = 0; x < 64; x += 5) { const p = a.px(x, y); const q = src.px(x, y); d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); }
  assert(d / (13 * 8 * 3) < 6, `ДО совпадает с исходником (разница ${(d / (13 * 8 * 3)).toFixed(2)})`);
  const info = await ff.run(ff.findBinaries().ffprobe || ff.findBinaries().ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.afterPath]);
  assert(info.stdout.trim() === '320,180', `размер кадра по запросу: ${info.stdout.trim()}`);
  // Граница кадров: 11,99 с таймлайна = 1,99 с файла — ещё красный кадр, 12,02 — уже зелёный
  r = await cmp({ ...clip, effects: [] }, im, 11.99);
  assert(isRed((await rgb(r.beforePath, 0)).px(32, 18)), 'кадр 1,99 с — красный (последний до границы)');
  r = await cmp({ ...clip, effects: [] }, im, 12.02);
  assert(isGreen((await rgb(r.beforePath, 0)).px(32, 18)), 'кадр 2,02 с — зелёный');
  // Скорость и начало отрезка: in 4, ×2 — момент 10,5 с таймлайна = 5 с файла (синий); прогон — не раньше in
  r = await cmp({ ...clip, in: 4, speed: 2 }, im, 10.5);
  assert(r.before && (await rgb(r.beforePath, 0)).px(32, 18)[2] > 150, 'скорость ×2: кадр 5 с файла (синий)');
  // Кэш: тот же запрос — из файлов
  r = await cmp(clip, im, 13);
  assert(r.cached === true, 'повтор того же запроса — из кэша');
  // Временной шумодав (hqdn3d + atadenoise) — прогон с запасом, кадр получается
  const reg = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'registry.js')).href);
  const owner = { id: 'cmptest', filters: new Set(['hqdn3d', 'atadenoise']) };
  const did = reg.registerEffect({ id: 'dn', name: 'DN', preview: 'frame', ffmpeg: [{ filter: 'hqdn3d', args: ['4', '3', '6', '4'] }, { filter: 'atadenoise' }] }, owner);
  r = await cmp({ ...clip, effects: [did] }, im, 13.5);
  assert(isGreen((await rgb(r.afterPath, 0)).px(32, 18)), 'временные фильтры: кадр с шумодавом получен');
  reg.unregisterPlugin('cmptest');
  // Кадрирование — одинаково у обоих кадров: срезана левая половина → синий
  r = await cmp({ ...clip, crop: { l: 0.5 } }, ih, 11);
  a = await rgb(r.beforePath, 0); b = await rgb(r.afterPath, 0);
  assert(a.px(4, 18)[2] > 150 && a.px(4, 18)[0] < 80 && gray(b.px(4, 18)), `кадрирование: ДО ${a.px(4, 18)}, ПОСЛЕ ${b.px(4, 18)}`);
  // Картинка
  r = await cmp({ mediaId: 'p', in: 0, out: 5, start: 0, effects: ['invert'] }, ip, 1);
  a = await rgb(r.beforePath, 0); b = await rgb(r.afterPath, 0);
  assert(isGreen(a.px(32, 18)) && b.px(32, 18)[0] > 150 && b.px(32, 18)[2] > 150 && b.px(32, 18)[1] < 80, `картинка: ДО ${a.px(32, 18)}, ПОСЛЕ (негатив) ${b.px(32, 18)}`);
  // Проверка цепочки (как plancheck): метки/«;», фильтры вне списка, файловые опции; момент за концом файла
  const bad = async (fx, re, msg) => {
    try { await ff.engine('compare', { ...fxm.compareRequest(clip, im, 13, 320), fx }); assert(false, msg); } catch (e) { assert(re.test(e.message), `${msg}: ${e.message.slice(0, 90)}`); }
  };
  await bad('hue=s=0[x];[x]negate', /;|label|мет/i, 'отказ: цепочка с метками');
  await bad('movie=C\\:/x.mp4', /movie/, 'отказ: movie');
  await bad('drawtext=textfile=C\\:/x.txt', /drawtext/, 'отказ: drawtext');
  await bad('ass=C\\:/x.ass', /ass/, 'отказ: ass');
  try { await ff.engine('compare', { ...fxm.compareRequest(clip, im, 13, 320), t: 60 }); assert(false, 'за концом файла — ошибка'); } catch (e) { assert(/кадр|frame/i.test(e.message), `за концом файла — понятная ошибка: ${e.message.slice(0, 90)}`); }
  try { await ff.engine('compare', { ...fxm.compareRequest(clip, im, 13, 320), file: path.join(DIR, 'нет-такого.mp4') }); assert(false, 'нет файла'); } catch (e) { assert(/не разрешён|not allowed/.test(e.message), 'нет файла — отказ'); }
}

// Стабилизация (plugins-bundled/stabilize, stab.rs, exportPlan.js stabPart): синтетический «трясущийся» клип
// (testsrc2 + crop со сдвигом по sin), красный кадр-метка на 4,00 с файла. Быстрая (deshake) — без анализа;
// Баланс / Максимум (vidstab) — анализ движком (--engine stab-analyze) в кэш теста, экспорт проходит plancheck,
// тряска заметно меньше, метка — тем же кадром, что без стабилизации; прокси превью; отказы plancheck.
async function stabTest(enc) {
  console.log('Стабилизация:');
  const { pathToFileURL } = require('url');
  const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
  const reg = await js('registry.js');
  const fxm = await js('effects.js');
  const sp = await js('stabPlan.js');
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugins-bundled', 'stabilize', 'plugin.json'), 'utf8'));
  reg.unregisterPlugin('stabilize');
  for (const e of man.contributes.effects) reg.registerEffect(JSON.parse(JSON.stringify(e)), { id: man.id, filters: new Set(man.ffmpeg.filters) });
  const shaky = await make('stab_shaky.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=25:d=8',
    '-vf', "crop=800:450:x='80+60*sin(n*0.9)*cos(n*0.37)':y='45+35*sin(n*1.7+1)',drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='eq(n,100)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '50', '-pix_fmt', 'yuv420p']);
  const m = await ff.probe(shaky);
  const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
  // Кадры видео: серые 128×72 (тряска) и доля красного в каждом кадре (метка)
  const frames = async (file) => {
    const { stdout } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=128:72:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1'], { binaryStdout: true });
    const n = stdout.length / (128 * 72); const out = [];
    for (let i = 0; i < n; i++) out.push(stdout.subarray(i * 128 * 72, (i + 1) * 128 * 72));
    return out;
  };
  const redIdx = async (file) => {
    const { stdout } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=16:9:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { binaryStdout: true });
    const fsz = 16 * 9 * 3; const n = stdout.length / fsz;
    for (let i = 0; i < n; i++) {
      let red = 0;
      for (let k = i * fsz; k < (i + 1) * fsz; k += 3) if (stdout[k] > 180 && stdout[k + 1] < 80 && stdout[k + 2] < 80) red++;
      if (red > 16 * 9 * 0.8) return { at: i, n };
    }
    return { at: -1, n };
  };
  // Средний сдвиг между соседними кадрами (перебор ±12 пикселей 128×72, середина кадра)
  const shake = (fr) => {
    let tot = 0; const W = 128; const R = 12;
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1]; const b = fr[i]; let best = Infinity; let bx = 0; let by = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        let s = 0;
        for (let y = 16; y < 56; y += 2) for (let x = 20; x < 108; x += 2) { const d = a[y * W + x] - b[(y + dy) * W + x + dx]; s += d * d; }
        if (s < best) { best = s; bx = dx; by = dy; }
      }
      tot += Math.hypot(bx, by);
    }
    return tot / (fr.length - 1);
  };
  const clip = (fx, fxp) => ({ mediaId: 'm', in: 2, out: 6, start: 0, volume: 1, muted: true, effects: fx ? [fx] : [], ...(fxp ? { fxp } : {}) });
  const exportOf = async (name, c, stab = {}) => {
    const out = path.join(DIR, name);
    try { fs.unlinkSync(out); } catch { /* нет файла */ }
    await startExport({ media: { m }, videoClips: [c], audioTracks: [] }, { width: 320, height: 180, fps: 25, codec, quality: 'high', output: out, assets: { stab } });
    return out;
  };
  const plain = await exportOf('stab_plain.mp4', clip(null));
  const fp = await frames(plain); const rp = await redIdx(plain);
  const s0 = shake(fp);
  assert(rp.at === 50 && rp.n === 100, `без стабилизации: метка — кадр ${rp.at} из ${rp.n} (ждём 50 из 100), тряска ${s0.toFixed(2)}`);
  // Быстрая: deshake, без анализа, первой в цепочке (до setpts)
  const fastPlan = (await js('exportPlan.js')).exportCommand({ media: { m }, videoClips: [clip('stabilize.fast')], audioTracks: [] }, { width: 320, height: 180, fps: 25, codec, quality: 'high', output: path.join(DIR, 'x.mp4') });
  assert(/\[0:v\]deshake=rx=32:ry=32:edge=mirror,scale=[^,]+,crop=[^,]+,setpts=PTS-STARTPTS/.test(fastPlan.filter), 'быстрая: deshake первым, до скорости (setpts)');
  const fast = await exportOf('stab_fast.mp4', clip('stabilize.fast', { 'stabilize.fast': { range: 64, zoom: 0 } }));
  const rf = await redIdx(fast); const s1 = shake(await frames(fast));
  assert(rf.at === 50 && rf.n === 100, `быстрая: метка тем же кадром (${rf.at} из ${rf.n}), тряска ${s1.toFixed(2)} (было ${s0.toFixed(2)})`);
  assert(s1 < s0, 'быстрая: тряска меньше');
  // Баланс / Максимум — только если в сборке FFmpeg есть vidstab
  const caps = await ff.engine('filters');
  if (!caps.vidstab) {
    console.log('  (в этой сборке FFmpeg нет vidstab — проверки «Баланс» / «Максимум» пропущены)');
    fxm.setHostCaps({ vidstab: false });
    const p = (await js('exportPlan.js')).buildExport({ media: { m }, videoClips: [clip('stabilize.max')], audioTracks: [] }, { width: 320, height: 180, fps: 25, codec, assets: { stab: {} } });
    assert(p.warnings.some((w) => /vidstab/.test(w)) && !/vidstab/.test(p.filter), 'без vidstab: эффект пропущен с предупреждением');
    fxm.setHostCaps({ vidstab: null });
    reg.unregisterPlugin('stabilize');
    return;
  }
  const c2 = clip('stabilize.balanced', { 'stabilize.balanced': { smooth: 20 } });
  const req = sp.analyzeReq(c2, m);
  assert(req && req.args.shakiness === 5 && req.args.stepsize === 12 && req.args.accuracy === 9, `запрос анализа: ${JSON.stringify(req && req.args)}`);
  const t0 = Date.now();
  const a = await ff.engine('stab-analyze', req);
  const media = path.resolve(ff.paths().media_cache);
  assert(a.state === 'ready' && fs.existsSync(a.trf) && /[\\/]stab[\\/][0-9a-f]+\.trf$/.test(a.trf) && path.resolve(a.trf).toLowerCase().startsWith(media.toLowerCase()),
    `анализ: ${path.basename(a.trf)} в stab-кэше (${Date.now() - t0} мс)`);
  assert(a.start === 1 && a.end === 7, `отрезок анализа с запасом 1 с: ${a.start}…${a.end}`);
  const a2 = await ff.engine('stab-analyze', req);
  assert(a2.trf === a.trf && a2.cached !== false, 'повтор — готовый анализ из кэша');
  const a3 = await ff.engine('stab-analyze', { ...req, in: 2.5, out: 6.5 });
  assert(a3.trf === a.trf, 'клип обрезан в пределах запаса — тот же анализ');
  const a4 = await ff.engine('stab-analyze', { ...req, in: 0.5 });
  assert(a4.trf !== a.trf && a4.start === 0, 'обрезан за пределы запаса — новый анализ');
  const a5 = await ff.engine('stab-analyze', { ...req, args: { ...req.args, shakiness: 9 } });
  assert(a5.trf !== a.trf, 'другие параметры анализа — новый анализ');
  const stab = { trf: a.trf, start: a.start, end: a.end };
  c2.id = 'c2';
  const bal = await exportOf('stab_balanced.mp4', c2, { c2: stab });
  const rb = await redIdx(bal); const s2 = shake(await frames(bal));
  assert(rb.at === 50 && rb.n === 100, `баланс: метка тем же кадром (${rb.at} из ${rb.n}) — кадры анализа и экспорта совпадают`);
  assert(s2 < s0 * 0.7, `баланс: тряска ${s2.toFixed(2)} заметно меньше (было ${s0.toFixed(2)})`);
  // Скорость ×2: стабилизация до setpts, метка — кадр 25
  const c3 = { ...c2, id: 'c3', speed: 2 };
  const fastSp = await exportOf('stab_speed.mp4', c3, { c3: stab });
  const rs = await redIdx(fastSp);
  assert(rs.at === 25 && rs.n === 50, `баланс ×2: метка — кадр ${rs.at} из ${rs.n}`);
  // Без готового анализа экспорт пропускает стабилизацию с предупреждением
  const pm = (await js('exportPlan.js')).buildExport({ media: { m }, videoClips: [c2], audioTracks: [] }, { width: 320, height: 180, fps: 25, codec, assets: { stab: {} } });
  assert(pm.warnings.some((w) => /Анализ движения|motion analysis/i.test(w)) && !/vidstab/.test(pm.filter), 'анализ не готов — стабилизация пропущена с предупреждением');
  // Максимум: прокси превью (тот же отрезок, что анализ)
  const c4 = { ...clip('stabilize.max', { 'stabilize.max': { showPreview: true } }), id: 'c4' };
  const am = await ff.engine('stab-analyze', sp.analyzeReq(c4, m));
  const preq = sp.proxyReq(c4, m, am);
  assert(preq && preq.fixed && preq.fixed.start === am.start && /^vidstabtransform=input=.*:smoothing=30:optzoom=1:zoom=0\.0:interpol=bicubic:tripod=0,unsharp=/.test(preq.chain), `прокси: цепочка «Максимум» ${preq && preq.chain.slice(-60)}`);
  const px = await ff.engine('stab-proxy', preq);
  const ip = await ff.probe(px.path);
  assert(fs.existsSync(px.path) && /[\\/]stab[\\/]/.test(px.path) && Math.abs(ip.duration - (am.end - am.start)) < 0.15 && ip.height <= 720,
    `прокси: ${path.basename(px.path)} ${ip.width}×${ip.height}, ${ip.duration.toFixed(2)} с (отрезок ${am.start}…${am.end})`);
  const rx = await redIdx(px.path);
  assert(rx.at === Math.round((4 - am.start) * 25), `прокси: метка — кадр ${rx.at} (время файла − начало отрезка)`);
  const pd = await ff.engine('stab-proxy', sp.proxyReq({ ...clip('stabilize.fast', { 'stabilize.fast': { showPreview: true } }) }, m));
  assert(fs.existsSync(pd.path) && pd.start === 1, `прокси быстрой (без анализа): ${pd.start}…${pd.end}`);
  // plancheck: vidstabtransform только с .trf из stab-кэша; vidstabdetect — никогда
  const okPlan = (await js('exportPlan.js')).exportCommand({ media: { m }, videoClips: [c2], audioTracks: [] }, { width: 320, height: 180, fps: 25, codec, quality: 'high', output: path.join(DIR, 'chk.mp4'), assets: { stab: { c2: stab } } });
  const chk = (filter) => ff.engine('checkplan', { plan: { ...okPlan, filter } });
  await chk(okPlan.filter);
  assert(true, 'план с vidstabtransform из stab-кэша проходит plancheck');
  const foreign = path.join(DIR, 'foreign.trf');
  fs.copyFileSync(a.trf, foreign);
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\\\:');
  const bad = async (filter, msg) => { try { await chk(filter); assert(false, msg); } catch (e) { assert(/отклон|rejected|не разрешён|not allowed/i.test(e.message), `${msg}: ${e.message.slice(0, 100)}`); } };
  await bad(okPlan.filter.replace(esc(a.trf), esc(foreign)), 'отказ: чужой input=');
  await bad(okPlan.filter.replace(esc(a.trf), esc(`${path.dirname(a.trf)}/../stab/${path.basename(a.trf)}`)), 'отказ: путь с ..');
  await bad(okPlan.filter.replace(/vidstabtransform=input=[^:]+/, `vidstabdetect=result=${esc(foreign)}`), 'отказ: vidstabdetect');
  await bad(okPlan.filter.replace(/vidstabtransform=input=[^:]+/, `vidstabtransform=input=${esc(a.trf)}:debug=1`), 'отказ: debug');
  reg.unregisterPlugin('stabilize');
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
    await ({ tracks: tracksTest, effects: effectsTest, speed: speedTest, plugin: pluginTest, text: textTest, border: borderTest, timer: timerTest, encoders: encodersTest, compare: compareTest, stab: stabTest })[only](enc);
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
  await borderTest(enc);
  await timerTest(enc);
  await compareTest(enc);
  await stabTest(enc);
  await encodersTest(enc);
  console.log('\nВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
