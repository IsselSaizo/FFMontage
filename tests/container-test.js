'use strict';
// 0.4.1 — контейнеры: импорт MKV/TS (прокси без перекодирования, H3) и экспорт MP4/MKV/MOV
// (кодеки звука, аудиодорожки отдельными потоками с названиями, мягкие субтитры srt в MKV). node tests/container-test.js
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ff = require('./engine.js');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);

(async () => {
  await ff.ready;
  const bin = ff.findBinaries();
  const ffprobe = path.join(path.dirname(bin.ffmpeg), path.basename(bin.ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const DIR = path.join(ff.paths().temp, 'container-test');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const make = async (name, args) => { const p = path.join(DIR, name); await ff.run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, p]); return p; };
  const streams = async (file) => JSON.parse((await ff.run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])).stdout);
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3'];

  console.log('Импорт:');
  // MKV: H.264 + FLAC + второй звуковой поток Opus
  const mkv = await make('in_h264_flac.mkv', [...src, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a:0', 'flac', '-c:a:1', 'libopus', '-metadata:s:a:1', 'title=Микрофон']);
  // Как запись OBS: H.264 + AAC в MKV (для ui-selftest18)
  await make('in_h264_aac.mkv', [...src, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const im = await ff.probe(mkv);
  ok(im.vcodec === 'h264' && im.acodec === 'flac' && im.audioStreams.length === 2 && im.audioStreams[1].title === 'Микрофон', `MKV: ${im.vcodec}/${im.acodec}, потоков звука ${im.audioStreams.length}`);
  let t0 = Date.now();
  const p1 = await ff.engine('proxy', { info: { ...im, remux: true } });
  const remuxMs = Date.now() - t0;
  const p1f = decodeURIComponent(String(p1.url || p1.path || p1)).replace(/^https?:\/\/[^/]+\//, '');
  ok(/proxy\.remux\.mp4$/i.test(p1f), `MKV → прокси без перекодирования: ${p1f} (${remuxMs} мс)`);
  const s1 = await streams(p1f);
  const v1 = s1.streams.find((s) => s.codec_type === 'video'); const a1 = s1.streams.find((s) => s.codec_type === 'audio');
  ok(v1 && v1.codec_name === 'h264' && v1.width === 640 && a1 && a1.codec_name === 'aac' && Math.abs(Number(s1.format.duration) - 3) < 0.1,
    `ремукс: видео ${v1 && v1.codec_name} ${v1 && v1.width}p, звук ${a1 && a1.codec_name}, ${s1.format.duration} с`);
  // TS: H.264 + AAC — звук копируется
  const ts = await make('in_h264_aac.ts', [...src, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts']);
  const it = await ff.probe(ts);
  ok(it.needsProxy === true, 'TS требует прокси');
  const p2 = String(await ff.engine('proxy', { info: { ...it, remux: true } }));
  ok(/proxy\.remux\.mp4/i.test(decodeURIComponent(p2)), 'TS → ремукс');
  const s2 = await streams(decodeURIComponent(p2).replace(/^https?:\/\/[^/]+\//, ''));
  ok(Number(s2.streams.find((s) => s.codec_type === 'video').start_time || 0) < 0.1, `TS: время начинается с нуля (${s2.streams[0].start_time})`);
  // MPEG-4 Part 2 в AVI окно не декодирует — обычный прокси
  const avi = await make('in_mpeg4.avi', [...src, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'mp3']);
  const ia = await ff.probe(avi);
  const p3 = String(await ff.engine('proxy', { info: { ...ia, remux: true } }));
  ok(/proxy\.mp4/i.test(decodeURIComponent(p3)) && !/remux/.test(p3), 'AVI (MPEG-4) → перекодирование, не ремукс');

  console.log('Экспорт:');
  const plan = await js('exportPlan.js');
  const codec = 'libx264';
  const pr = {
    media: { m: im },
    videoClips: [{ mediaId: 'm', in: 0, out: 3, start: 0, volume: 1 }],
    audioTracks: [
      { id: 'a1', name: 'Музыка', clips: [{ mediaId: 'm', in: 0, out: 3, start: 0, volume: 0.5 }] },
      { id: 'a2', name: 'Голос', clips: [{ mediaId: 'm', in: 0, out: 2, start: 1, volume: 1, stream: 1 }] },
    ],
  };
  const exp = async (name, extra) => {
    const out = path.join(DIR, name);
    await ff.startExport(pr, { width: 320, height: 180, fps: 30, codec, quality: 'compact', output: out, ...extra });
    return { out, info: await streams(out) };
  };
  // Команда: у MKV нет -movflags и -tag:v, у MP4 есть
  const cMkv = plan.exportCommand(pr, { width: 320, height: 180, fps: 30, codec: 'libx265', quality: 'compact', output: 'C:\\x\\a.mkv' });
  ok(cMkv.container === 'mkv' && !cMkv.args.includes('-movflags') && !cMkv.args.includes('-tag:v') && cMkv.args.join(' ').includes('-f matroska'), 'MKV: -f matroska без -movflags и -tag:v');
  const cMp4 = plan.exportCommand(pr, { width: 320, height: 180, fps: 30, codec: 'libx265', quality: 'compact', output: 'C:\\x\\a.mp4', audioCodec: 'flac', stems: true });
  ok(cMp4.args.includes('-movflags') && cMp4.args.includes('hvc1') && cMp4.args.join(' ').includes('-c:a aac') && cMp4.args.filter((x) => x === '-map').length === 2, 'MP4: FLAC и отдельные потоки не допускаются (AAC, один поток)');
  const chk = await ff.engine('checkplan', { plan: { ...plan.exportCommand(pr, { width: 320, height: 180, fps: 30, codec, quality: 'compact', output: path.join(DIR, 'chk.mkv'), audioCodec: 'flac', stems: true }) } }).then(() => 'ok', (e) => e.message);
  ok(chk === 'ok' || /не выбран|not chosen/.test(chk), `checkplan MKV+FLAC+потоки: ${chk}`);

  // MKV, FLAC, отдельные потоки
  const e1 = await exp('out.mkv', { audioCodec: 'flac', stems: true });
  const au = e1.info.streams.filter((s) => s.codec_type === 'audio');
  ok(/matroska/.test(e1.info.format.format_name), `MKV: ${e1.info.format.format_name}`);
  ok(au.length === 4 && au.every((s) => s.codec_name === 'flac'), `MKV: 4 потока FLAC (микс, видео, 2 дорожки): ${au.map((s) => s.codec_name).join(',')}`);
  const titles = au.map((s) => (s.tags && (s.tags.title || s.tags.TITLE)) || '');
  ok(titles[0] === 'Общий микс' && titles[1] === 'Звук видео' && titles[2] === 'Музыка' && titles[3] === 'Голос', `названия потоков: ${titles.join(' | ')}`);
  ok(au[0].disposition.default === 1 && au[1].disposition.default === 0, 'поток по умолчанию — общий микс');
  // Громкость: дорожка «Голос» звучит только с 1 с — в первой секунде её поток тихий
  const vol = async (file, map, ss, tt) => {
    const { stderr } = await ff.run(bin.ffmpeg, ['-hide_banner', '-ss', String(ss), '-t', String(tt), '-i', file, '-map', map, '-af', 'volumedetect', '-f', 'null', '-']);
    return parseFloat(/max_volume: (-?[\d.]+|-inf)/.exec(stderr)[1]);
  };
  const vq = await vol(e1.out, '0:a:3', 0.1, 0.7); const vl = await vol(e1.out, '0:a:3', 1.3, 1);
  ok((Number.isNaN(vq) || vq < -60) && vl > -30, `поток «Голос»: тишина ${vq} дБ до 1 с, потом ${vl} дБ`);

  // MOV + PCM
  const e2 = await exp('out.mov', { audioCodec: 'pcm' });
  const a2 = e2.info.streams.filter((s) => s.codec_type === 'audio');
  ok(/mov/.test(e2.info.format.format_name) && a2.length === 1 && a2[0].codec_name === 'pcm_s24le', `MOV: ${e2.info.format.format_name}, звук ${a2.map((s) => s.codec_name)}`);
  // MKV + Opus + мягкие субтитры srt
  const subs = await js('subtitles.js');
  const srt = path.join(DIR, 's.srt');
  fs.writeFileSync(srt, subs.toSrt([{ id: 'c1', start: 0.5, end: 2, text: 'Привет' }]));
  const e3 = await exp('out_subs.mkv', { audioCodec: 'opus', assets: { subtitles: { mode: 'soft', tracks: [{ path: srt, lang: 'rus', title: 'Русские' }], end: 2 } } });
  const sub = e3.info.streams.find((s) => s.codec_type === 'subtitle');
  ok(sub && sub.codec_name === 'subrip' && sub.tags && sub.tags.language === 'rus', `MKV: субтитры ${sub && sub.codec_name} (${sub && sub.tags && sub.tags.language})`);
  ok(e3.info.streams.find((s) => s.codec_type === 'audio').codec_name === 'opus', 'MKV: звук Opus');
  // GIF: без звука, палитра, 15 кадров/с по умолчанию
  const g = await exp('out.gif', { width: 320, height: 180 });
  const gv = g.info.streams.filter((s) => s.codec_type === 'video');
  ok(/gif/.test(g.info.format.format_name) && gv.length === 1 && gv[0].codec_name === 'gif' && !g.info.streams.some((s) => s.codec_type === 'audio'), `GIF: ${g.info.format.format_name}, ${gv.map((s) => s.codec_name)}`);
  const gd = Number(g.info.format.duration);
  ok(Math.abs(gd - 3) < 0.25 && gv[0].width === 320, `GIF: ${gd} с, ${gv[0].width}×${gv[0].height}, ${gv[0].r_frame_rate}`);
  const g10 = plan.exportCommand(pr, { width: 320, height: 180, fps: 10, codec, output: 'C:\\x\\a.gif' });
  ok(/fps=10|r=10/.test(g10.filter) && /palettegen/.test(g10.filter) && g10.args.includes('-loop'), 'GIF 10 fps: палитра и повтор');
  // Только звук
  for (const [ext, fmt, ac] of [['mp3', /mp3/, 'mp3'], ['m4a', /mp4|m4a/, 'aac'], ['wav', /wav/, 'pcm_s16le'], ['ogg', /ogg/, 'vorbis']]) {
    const r = await exp(`out.${ext}`, {});
    const a = r.info.streams.filter((s) => s.codec_type === 'audio');
    const hasV = r.info.streams.some((s) => s.codec_type === 'video');
    ok(fmt.test(r.info.format.format_name) && a.length === 1 && a[0].codec_name === ac && !hasV && Math.abs(Number(r.info.format.duration) - 3) < 0.15,
      `${ext.toUpperCase()}: ${r.info.format.format_name}, ${a.map((s) => s.codec_name)}, видео ${hasV}, ${Number(r.info.format.duration).toFixed(2)} с, ${fs.statSync(r.out).size} Б`);
  }
  const w24 = await exp('out24.wav', { audioCodec: 'pcm' });
  ok(w24.info.streams[0].codec_name === 'pcm_s24le', 'WAV 24 бит');
  const am = await exp('out128.mp3', { audioCodec: 'mp3_128' });
  ok(Math.abs(Number(am.info.format.bit_rate) - 128000) < 8000, `MP3 128: ${am.info.format.bit_rate}`);
  const cA = plan.exportCommand(pr, { width: 640, height: 360, fps: 30, codec, output: 'C:\\x\\a.mp3' });
  ok(/nullsink/.test(cA.filter) && !cA.args.includes('[vout]') && /s=16x16/.test(cA.filter), 'только звук: картинка 16×16 уходит в nullsink');
  // MP4 по-прежнему
  const e4 = await exp('out.mp4', {});
  ok(/mp4/.test(e4.info.format.format_name) && e4.info.streams.filter((s) => s.codec_type === 'audio').length === 1, 'MP4: один поток AAC');

  console.log(`\ncontainer-test: ${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
