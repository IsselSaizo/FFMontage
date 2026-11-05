'use strict';
// 0.5.0–0.5.1 — звук: нормализация громкости в 2 прохода (loudnorm), раскладка каналов проекта (стерео / 5.1 / 7.1 / N моно),
// маршрутизация дорожек по каналам, разложение многоканального клипа по каналам, N моно-дорожек в файле.
// node tests/audio-test.js [--only unit|loudness|layout]
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ff = require('./engine.js');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const js = (f) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', f)).href);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const near = (a, b, eps) => Math.abs(a - b) <= eps;

async function unit() {
  console.log('Модель каналов (audioLayout.js):');
  const L = await js('audioLayout.js');
  const p51 = { audioLayout: { kind: '5.1' } };
  ok(L.channelCount({}) === 2 && L.isStereo({}), 'нет поля — стерео');
  ok(L.channelCount(p51) === 6 && L.ffLayout(p51) === '5.1' && L.channelLabels(p51).join(' ') === 'L R C LFE Ls Rs', '5.1: 6 каналов, подписи');
  ok(L.channelCount({ audioLayout: { kind: 'multi', channels: 8 } }) === 8 && L.ffLayout({ audioLayout: { kind: 'multi', channels: 8 } }) === '8c', 'N моно: 8c');
  ok(L.channelCount({ audioLayout: { kind: 'multi', channels: 99 } }) === L.MAX_CHANNELS, `N моно ограничено ${L.MAX_CHANNELS}`);
  ok(L.cleanLayout({ kind: 'stereo' }) === null && L.cleanLayout({ kind: 'bogus' }) === null, 'стерео и мусор — без поля');
  ok(JSON.stringify(L.cleanRoute([2], p51)) === '[2]' && JSON.stringify(L.cleanRoute([4, 5], p51)) === '[4,5]', 'маршрут: канал и пара');
  ok(JSON.stringify(L.cleanRoute([7], p51)) === '[0,1]' && JSON.stringify(L.cleanRoute([3, 3], p51)) === '[3]' && JSON.stringify(L.cleanRoute('x', p51)) === '[0,1]', 'маршрут: вне раскладки → по умолчанию, пара из одного канала → канал');
  ok(L.routePan([0, 1], {}) === '', 'стерео → стерео: без pan');
  ok(L.routePan([2], p51) === 'pan=5.1|c0=0*c0|c1=0*c0|c2=0.5*c0+0.5*c1|c3=0*c0|c4=0*c0|c5=0*c0', `в центр 5.1: ${L.routePan([2], p51)}`);
  ok(L.routePan([4, 5], p51).includes('c4=c0|c5=c1'), 'пара в тылы');
  ok(L.downmixPan({}) === '' && /^pan=stereo\|c0=1\*c0\+0\.7071\*c2\+0\.7071\*c4\|c1=1\*c1\+0\.7071\*c2\+0\.7071\*c5$/.test(L.downmixPan(p51)), `даунмикс 5.1 (LFE не слушаем): ${L.downmixPan(p51)}`);
  const m6 = { channels: 6, audioStreams: [{ channels: 6 }] };
  ok(L.clipChannel({ channel: 3 }, m6) === 3 && L.clipChannel({ channel: 6 }, m6) === undefined && L.clipChannel({}, m6) === undefined, 'канал клипа в пределах потока');
  ok(L.outputMode({}, {}).mode === 'mix', 'стерео: как есть');
  ok(L.outputMode(p51, { codec: 'aac', container: 'mp4' }).mode === 'mix', '5.1 AAC в MP4 — одна дорожка 5.1');
  ok(L.outputMode(p51, { codec: 'mp3', container: 'mp3' }).mode === 'stereo', '5.1 в MP3 — даунмикс');
  const p8 = { audioLayout: { kind: 'multi', channels: 8 } };
  ok(L.outputMode(p8, { codec: 'aac', container: 'mp4' }).mode === 'mono', '8 моно AAC в MP4 — моно-дорожки (у раскладки нет имён)');
  ok(L.outputMode(p8, { codec: 'pcm_s24le', container: 'mov' }).mode === 'mix' && L.outputMode(p8, { mode: 'mono', codec: 'pcm_s24le', container: 'mov' }).mode === 'mono', '8 моно PCM в MOV: одна дорожка или N моно по выбору');
  ok(L.outputMode(p8, { codec: 'pcm_s24le', container: 'wav' }).mode === 'mix', 'WAV — одна дорожка 8 каналов');

  console.log('Проект (store.js):');
  const S = await js('store.js');
  const p = S.normalizeProject({ audioLayout: { kind: '5.1' }, videoRoute: [0, 1], audioTracks: [{ id: 'a', clips: [], route: [2] }, { id: 'b', clips: [], route: [9] }, { id: 'c', clips: [{ id: 'x', mediaId: 'm', in: 0, out: 1, start: 0, channel: -1 }] }], media: {} });
  ok(p.audioLayout.kind === '5.1' && p.videoRoute === undefined, 'маршрут по умолчанию не хранится');
  ok(JSON.stringify(p.audioTracks[0].route) === '[2]' && p.audioTracks[1].route === undefined, 'маршрут дорожки чистится (неверный → по умолчанию, без поля)');
  ok(p.audioTracks[2].clips[0].channel === undefined, 'неверный канал клипа убран');
  const st = S.store;
  st.load(S.normalizeProject({
    media: { m: { id: 'm', name: 'six.wav', path: 'C:\\x\\six.wav', hasAudio: true, duration: 4, channels: 6, audioStreams: [{ channels: 6 }] } },
    audioLayout: { kind: '5.1' },
    audioTracks: [{ id: 'a', clips: [{ id: 'k', mediaId: 'm', in: 0, out: 4, start: 1, volume: 1 }] }],
  }), null);
  const ids = st.splitChannels('k');
  const tr = st.project.audioTracks;
  ok(ids.length === 6 && tr.length === 6, `разложить 5.1-клип: ${ids.length} клипов на ${tr.length} дорожках`);
  ok(tr.every((x, k) => x.clips.length === 1 && x.clips[0].channel === k && x.clips[0].start === 1 && JSON.stringify(x.route) === `[${k}]`), 'каждый канал — своя дорожка с маршрутом в свой канал');
  ok(st.splitChannels(ids[1]).length === 0, 'клип одного канала повторно не раскладывается');
  st.undo();
  ok(st.project.audioTracks.length === 1 && st.project.audioTracks[0].clips[0].channel === undefined, 'отмена');
  st.setAudioLayout({ kind: 'stereo' });
  st.setTrackRoute('a', [1]);
  ok(JSON.stringify(st.project.audioTracks[0].route) === '[1]', 'setTrackRoute: правый канал стерео');
  st.setAudioLayout({ kind: 'mono' });
  ok(st.project.audioTracks[0].route === undefined, 'смена раскладки: маршрут вне раскладки сброшен');

  console.log('Цели громкости (реестр):');
  await js('core/loudness.js');
  const R = await js('registry.js');
  const ids2 = R.listLoudnessTargets().map((x) => `${x.id}:${x.i}`);
  ok(ids2.includes('web:-14') && ids2.includes('broadcast:-23') && ids2.includes('podcast:-16'), `встроенные: ${ids2.join(', ')}`);
  let err = '';
  try { R.registerLoudnessTarget({ id: 'bad', name: 'x', i: 3 }, { id: 'demo-plugin', filters: [] }); } catch (e) { err = e.message; }
  ok(!!err, `неверная цель отклонена: ${err}`);
  const id = R.registerLoudnessTarget({ id: 'atsc', name: 'ATSC A/85', i: -24, tp: -2 }, { id: 'demo-plugin', filters: [] });
  ok(R.loudnessTargetById(id) && R.loudnessTargetById(id).lra === 11, `цель плагина: ${id}`);

  console.log('План громкости (exportPlan.js):');
  const P = await js('exportPlan.js');
  ok(P.cleanLoudness(null) === null && P.cleanLoudness({ i: -100 }).i === -70, 'cleanLoudness: границы');
  const pr = { media: { m: { path: 'C:\\x\\a.wav', hasAudio: true, duration: 3 } }, videoClips: [], audioTracks: [{ id: 'a', clips: [{ mediaId: 'm', in: 0, out: 3, start: 0, volume: 1 }] }] };
  const lp = P.loudnessPlan(pr, { width: 320, height: 180, fps: 30, output: 'C:\\x\\o.mp4', loudness: { i: -14, tp: -1, lra: 11 } });
  ok(/loudnorm=I=-14\.00:TP=-1\.00:LRA=11\.00:print_format=json\[aout\]/.test(lp.filter) && lp.args.at(-1) === '@@OUT@@', 'проход 1: loudnorm print_format=json');
  const c2 = P.exportCommand(pr, { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'compact', output: 'C:\\x\\o.mp4', loudness: { i: -14, tp: -1, lra: 11, measured: { input_i: -30, input_tp: -10, input_lra: 3, input_thresh: -40, target_offset: 0.2 } } });
  ok(/measured_I=-30\.00:measured_TP=-10\.00:measured_LRA=3\.00:measured_thresh=-40\.00:offset=0\.20:linear=true/.test(c2.filter), 'проход 2: measured_* и linear=true');
  const c3 = P.buildExport(pr, { width: 320, height: 180, fps: 30, loudness: { i: -14, measured: { input_i: null } } });
  ok(!/loudnorm/.test(c3.filter) && c3.warnings.some((w) => /тихий|quiet/i.test(w)), 'тишина: нормализация пропущена с предупреждением');
}

async function setup() {
  await ff.ready;
  const bin = ff.findBinaries();
  const ffprobe = path.join(path.dirname(bin.ffmpeg), path.basename(bin.ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const DIR = path.join(ff.paths().temp, 'audio-test');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const make = async (name, args) => { const p = path.join(DIR, name); await ff.run(bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, p]); return p; };
  const streams = async (file) => JSON.parse((await ff.run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])).stdout).streams;
  // Громкость по каналам: astats → RMS каждого канала (дБ)
  const rms = async (file, stream = 0) => {
    const r = await ff.run(bin.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', `0:a:${stream}`, '-af', 'astats=measure_perchannel=RMS_level:measure_overall=none', '-f', 'null', '-']);
    return [...r.stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((x) => (x[1] === '-inf' ? -200 : Number(x[1])));
  };
  const lufs = async (file) => {
    const r = await ff.run(bin.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-']);
    const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.stderr);
    return m ? Number(m[1]) : NaN;
  };
  return { bin, DIR, make, streams, rms, lufs };
}

async function loudness(E) {
  console.log('Нормализация громкости (2 прохода, движок):');
  const P = await js('exportPlan.js');
  // Тихий шум (−35 dBFS) — после нормализации −14 LUFS ± 1
  const wav = await E.make('quiet.wav', ['-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.02:d=6:r=48000', '-ac', '2']);
  const pr = { media: { m: { path: wav, hasAudio: true, duration: 6 } }, videoClips: [], audioTracks: [{ id: 'a', clips: [{ mediaId: 'm', in: 0, out: 6, start: 0, volume: 1 }] }] };
  const before = await E.lufs(wav);
  for (const target of [-14, -23]) {
    const s = { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'compact', output: path.join(E.DIR, `ln${-target}.m4a`), loudness: { i: target, tp: -1, lra: 11 } };
    const meas = await ff.engine('loudness', { plan: P.loudnessPlan(pr, s) });
    ok(Number.isFinite(meas.input_i) && near(meas.input_i, before, 1.5), `замер: ${meas.input_i} LUFS (ebur128: ${before})`);
    s.loudness.measured = meas;
    await ff.engine('export', { plan: P.exportCommand(pr, s) });
    const after = await E.lufs(s.output);
    ok(near(after, target, 1), `экспорт → ${after} LUFS (цель ${target})`);
  }
  const bad = await ff.engine('loudness', { plan: { args: ['-hide_banner', '-i', wav, '-/filter_complex', '@@FILTER@@', '-map', '[aout]', '@@OUT@@'], filter: '[0:a]anull[aout]', duration: 6 } }).then(() => 'ok', (e) => e.message);
  ok(bad !== 'ok', `замер без loudnorm отклонён: ${bad}`);
}

async function layout(E) {
  console.log('Каналы в экспорте (движок):');
  const P = await js('exportPlan.js');
  // Источник 5.1: каналы — синусы 200…700 Гц разной громкости (канал k: −(6+3k) dBFS)
  const amps = [0, 1, 2, 3, 4, 5].map((k) => (10 ** (-(6 + 3 * k) / 20)).toFixed(4));
  const six = await E.make('six.wav', ['-f', 'lavfi', '-i', `aevalsrc=${amps.map((a, k) => `${a}*sin(2*PI*${200 + 100 * k}*t)`).join('|')}:c=5.1:s=48000:d=3`]);
  const stereo = await E.make('st.wav', ['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):c=stereo:s=48000:d=3']);
  const info6 = await ff.probe(six); const infoS = await ff.probe(stereo);
  const base = { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'compact' };
  const proj = (extra) => ({ media: { s6: info6, st: infoS }, videoClips: [], ...extra });

  // 1) Проект 5.1: стерео-дорожка в тылы (Ls Rs), второй канал источника — в центр
  const p1 = proj({
    audioLayout: { kind: '5.1' },
    audioTracks: [
      { id: 'a', route: [4, 5], clips: [{ mediaId: 'st', in: 0, out: 3, start: 0, volume: 1 }] },
      { id: 'b', route: [2], clips: [{ mediaId: 's6', in: 0, out: 3, start: 0, volume: 1, channel: 1 }] },
    ],
  });
  const o1 = path.join(E.DIR, 'r51.mov');
  await ff.engine('export', { plan: P.exportCommand(p1, { ...base, output: o1, audioCodec: 'pcm' }) });
  const s1 = (await E.streams(o1)).filter((s) => s.codec_type === 'audio');
  ok(s1.length === 1 && s1[0].channels === 6, `MOV PCM: одна дорожка, каналов ${s1[0] && s1[0].channels} (${s1[0] && s1[0].channel_layout})`);
  const r1 = await E.rms(o1);
  ok(r1[0] < -90 && r1[1] < -90 && r1[3] < -90, `L R LFE тихие: ${r1.map((x) => x.toFixed(1)).join(' ')}`);
  ok(near(r1[4], -9, 1) && near(r1[5], -15, 1), 'Ls = левый (−9 дБ RMS), Rs = правый (−15)');
  ok(near(r1[2], -12, 1), `C = канал 2 источника (−9 dBFS пик → −12 RMS): ${r1[2].toFixed(1)}`);

  // 2) MP4/AAC 5.1 и даунмикс в стерео
  const o2 = path.join(E.DIR, 'r51.mp4');
  await ff.engine('export', { plan: P.exportCommand(p1, { ...base, output: o2 }) });
  const s2 = (await E.streams(o2)).filter((s) => s.codec_type === 'audio');
  ok(s2.length === 1 && s2[0].channels === 6 && s2[0].codec_name === 'aac', `MP4: AAC ${s2[0] && s2[0].channels} каналов`);
  const o3 = path.join(E.DIR, 'down.mp4');
  await ff.engine('export', { plan: P.exportCommand(p1, { ...base, output: o3, audioOut: 'stereo' }) });
  const s3 = (await E.streams(o3)).filter((s) => s.codec_type === 'audio');
  const r3 = await E.rms(o3);
  ok(s3[0].channels === 2 && r3[0] > -30 && r3[1] > -30, `даунмикс: 2 канала, RMS ${r3.map((x) => x.toFixed(1)).join(' ')}`);

  // 3) 8 моно: N моно-дорожек в MOV (PCM) и в MP4 (AAC — у раскладки без имён иначе нельзя)
  const p8 = proj({
    audioLayout: { kind: 'multi', channels: 8 },
    audioTracks: [
      { id: 'a', route: [0, 1], clips: [{ mediaId: 'st', in: 0, out: 3, start: 0, volume: 1 }] },
      { id: 'b', route: [7], clips: [{ mediaId: 's6', in: 0, out: 3, start: 0, volume: 1, channel: 0 }] },
    ],
  });
  const o4 = path.join(E.DIR, 'm8.mov');
  await ff.engine('export', { plan: P.exportCommand(p8, { ...base, output: o4, audioCodec: 'pcm', audioOut: 'mono' }) });
  const s4 = (await E.streams(o4)).filter((s) => s.codec_type === 'audio');
  ok(s4.length === 8 && s4.every((s) => s.channels === 1 && s.codec_name === 'pcm_s24le'), `MOV: ${s4.length} моно-дорожек PCM 24`);
  const title0 = s4[0].tags && (s4[0].tags.title || s4[0].tags.name);
  ok(/^(Канал|Channel) 1$/.test(title0 || ''), `название дорожки: ${title0}`);
  const r4 = [await E.rms(o4, 0), await E.rms(o4, 1), await E.rms(o4, 3), await E.rms(o4, 7)].map((x) => x[0]);
  ok(near(r4[0], -9, 1) && near(r4[1], -15, 1) && r4[2] < -90 && near(r4[3], -9, 1), `каналы 1, 2, 4, 8: ${r4.map((x) => x.toFixed(1)).join(' ')}`);
  const o5 = path.join(E.DIR, 'm8.mp4');
  await ff.engine('export', { plan: P.exportCommand(p8, { ...base, output: o5 }) });
  const s5 = (await E.streams(o5)).filter((s) => s.codec_type === 'audio');
  ok(s5.length === 8 && s5.every((s) => s.channels === 1 && s.codec_name === 'aac'), `MP4 8 моно: ${s5.length} дорожек AAC`);
  const o6 = path.join(E.DIR, 'm8.wav');
  await ff.engine('export', { plan: P.exportCommand(p8, { ...base, output: o6, audioCodec: 'pcm' }) });
  const s6 = (await E.streams(o6)).filter((s) => s.codec_type === 'audio');
  ok(s6.length === 1 && s6[0].channels === 8, `WAV: одна дорожка, ${s6[0] && s6[0].channels} каналов`);
  // Пустой проект 5.1 без звука: тишина в 5.1
  const o7 = path.join(E.DIR, 'silent.mov');
  const vid = await E.make('v.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const pv = { media: { v: await ff.probe(vid) }, audioLayout: { kind: '5.1' }, videoClips: [{ mediaId: 'v', in: 0, out: 1, start: 0, volume: 1 }], audioTracks: [{ id: 'a', clips: [] }] };
  const r7 = await ff.engine('export', { plan: P.exportCommand(pv, { ...base, output: o7, audioCodec: 'pcm' }) }).then(() => 'ok', (e) => e.message);
  ok(r7 === 'ok' && (await E.streams(o7)).find((s) => s.codec_type === 'audio').channels === 6, `без звука: тишина 5.1 (${r7})`);
}

async function broadcast(E) {
  console.log('Вещательный экспорт (0.5.2, движок):');
  const P = await js('exportPlan.js');
  ok(P.cleanTimecode('01:02:03:04', 25) === '01:02:03:04' && P.cleanTimecode('01:02:03:25', 25) === '10:00:00:00' && P.cleanTimecode('x') === '10:00:00:00', 'таймкод: проверка');
  const vid = await E.make('bc_src.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const info = await ff.probe(vid);
  const pr = { media: { v: info }, videoClips: [{ mediaId: 'v', in: 0, out: 2, start: 0, volume: 1 }], audioTracks: [{ id: 'a', clips: [] }] };
  const base = { width: 640, height: 360, fps: 25, codec: 'libx264', quality: 'compact', timecode: '01:00:00:00' };
  const probe = async (file) => JSON.parse((await ff.run(E.bin.ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, x) => `ffprobe${x || ''}`), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])).stdout);
  const cases = [
    { id: 'prores_hq', ext: 'mov', vc: 'prores', prof: /HQ/i, pix: 'yuv422p10le', audio: 1 },
    { id: 'prores4444', ext: 'mov', vc: 'prores', prof: /4444/, pix: /yuv444p1[02]le/, audio: 1 },
    { id: 'dnxhr_hq', ext: 'mxf', vc: 'dnxhd', prof: /DNXHR HQ/i, pix: 'yuv422p', audio: 8 },
    { id: 'xdcam_hd422', ext: 'mxf', vc: 'mpeg2video', prof: /4:2:2/, pix: 'yuv422p', audio: 8, w: 1920, field: 'tt' },
  ];
  for (const c of cases) {
    const out = path.join(E.DIR, `bc_${c.id}.${c.ext}`);
    const r = await ff.engine('export', { plan: P.exportCommand(pr, { ...base, output: out, broadcast: c.id }) }).then(() => 'ok', (e) => e.message);
    if (r !== 'ok') { ok(false, `${c.id}: ${r}`); continue; }
    const j = await probe(out);
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const pixOk = c.pix instanceof RegExp ? c.pix.test(v.pix_fmt) : v.pix_fmt === c.pix;
    ok(v.codec_name === c.vc && c.prof.test(v.profile || '') && pixOk, `${c.id}: ${v.codec_name} ${v.profile} ${v.pix_fmt}`);
    ok(a.length === c.audio && a.every((s) => s.codec_name === 'pcm_s24le' && Number(s.sample_rate) === 48000), `${c.id}: звук ${a.length} × ${a[0] && a[0].codec_name} ${a[0] && a[0].channels} кан.`);
    const tc = (j.format.tags && j.format.tags.timecode) || (v.tags && v.tags.timecode);
    ok(tc === '01:00:00:00', `${c.id}: таймкод ${tc}`);
    if (c.w) ok(v.width === c.w && v.height === 1080 && (!c.field || v.field_order === c.field), `${c.id}: ${v.width}×${v.height} ${v.field_order}`);
  }
}

(async () => {
  if (!only || only === 'unit') await unit();
  if (!only || only !== 'unit') {
    const E = await setup();
    if (!only || only === 'loudness') await loudness(E);
    if (!only || only === 'layout') await layout(E);
    if (!only || only === 'broadcast') await broadcast(E);
  }
  console.log(`\n${pass} ok, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
