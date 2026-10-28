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
const isBlue = ([r, g, b]) => b > 150 && r < 80 && g < 80;

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

(async () => {
  await ff.ready;
  DIR = path.join(ff.paths().temp, 'engine-test');
  fs.mkdirSync(DIR, { recursive: true });
  console.log('Программа:', ff.EXE);
  console.log('FFmpeg:', ff.findBinaries().ffmpeg);
  console.log(await ff.version());

  const enc = await ff.detectEncoders();
  console.log('Кодировщики:', enc);

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

  const ia = await ff.probe(a); const ib = await ff.probe(b); const ic = await ff.probe(c); const id = await ff.probe(d);
  console.log('Анализ:');
  assert(ia.vcodec === 'av1' && ia.width === 2560 && ia.fps === 60 && ia.hasAudio && !ia.needsProxy, 'AV1 1440p60 распознан, прокси не нужен');
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
  console.log('\nВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
