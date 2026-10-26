'use strict';
// Проверка движка без интерфейса: создаёт тестовые файлы, анализирует их,
// строит миниатюры/волну и экспортирует проект в несколько кодеков.
const path = require('path');
const fs = require('fs');
const ff = require('../src/main/ffmpeg');
const { startExport } = require('../src/main/exporter');
const { PATHS, ensureDirs, applyConfig, loadConfig } = require('../src/main/paths');

// Берём папки из config.json; если программа ещё не настроена — временная папка внутри проекта
applyConfig(loadConfig() || { cacheDir: '.test-cache', outputDir: '.test-cache/out', projectsDir: '.test-cache/projects' });

const DIR = path.join(PATHS.TEMP, 'engine-test');

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

(async () => {
  ensureDirs();
  fs.mkdirSync(DIR, { recursive: true });
  console.log('FFmpeg:', ff.findBinaries().ffmpeg);
  console.log(await ff.version());

  const enc = await ff.detectEncoders();
  console.log('Кодировщики:', enc);

  const a = await make('a_av1_1440p60.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60', '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:v', 'av1_nvenc', '-cq', '30', '-c:a', 'aac']);
  const b = await make('b_h264_1080p30.mp4', ['-f', 'lavfi', '-i', 'smptehdbars=size=1920x1080:rate=30', '-f', 'lavfi',
    '-i', 'sine=frequency=880:sample_rate=44100', '-t', '8', '-c:v', 'h264_nvenc', '-c:a', 'aac']);
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

  for (const codec of ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc']) {
    if (!enc[codec]) { console.log(`  --  ${codec} недоступен, пропускаю`); continue; }
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
    assert(io.vcodec === codec.split('_')[0].replace('h264', 'h264'), `кодек ${io.vcodec}`);
    assert(io.acodec === 'aac' && io.sampleRate === 48000, 'звук AAC 48 кГц');
  }

  // Проверка звука: 2-я часть (4..8 c) — клип без звука, но с музыкой 220 Гц;
  // 13..17 c — только музыка; до 2 c — только 440 Гц.
  const out = path.join(DIR, 'out_h264_nvenc.mp4');
  const vol = async (ss, t) => {
    const { stderr } = await ff.run(ff.findBinaries().ffmpeg, ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', out,
      '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    return parseFloat(/mean_volume: (-?[\d.]+)/.exec(stderr)[1]);
  };
  const v1 = await vol(0.2, 1.5); const v2 = await vol(4.5, 1); const v3 = await vol(13, 3);
  console.log(`Громкость: начало ${v1} дБ, клип без звука + музыка ${v2} дБ, только музыка ${v3} дБ`);
  assert(v2 < v1 && v3 < v1, 'музыка на 50% тише основного звука, отключённый клип не звучит');
  console.log('\nВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
