'use strict';
// Аудиоплагины VST3 / CLAP — JS-часть (контракт .agent/vst3-contract.md), без окна: node tests/vst-test.js
// 1) audioFx.js: записи 'vst3' / 'clap', splitStages, ненайденные плагины;
// 2) vstJobs.js: задания vst_render для клипа и дорожки (граф микса — exportPlan.trackGraph);
// 3) exportPlan.js: клип/дорожка с плагином берёт звук из WAV рендера (без эффектов и atempo), остальное — как раньше;
// 4) если программа собрана (src-tauri/target/release): план проходит --engine checkplan, граф дорожки и экспорт
//    с подменой на WAV реально запускаются в FFmpeg.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const JS = path.join(__dirname, '..', 'src', 'renderer', 'js');
const load = (f) => import(pathToFileURL(path.join(JS, f)).href);

let failed = 0; let passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++; console.log(`  ПРОВАЛ: ${msg}`);
}
const section = (s) => console.log(s);
const okLog = (cond, msg) => { ok(cond, msg); if (cond) console.log(`  ok  ${msg}`); };

const UID_A = '0123456789ABCDEF0123456789ABCDEF';
const UID_C = 'FEDCBA9876543210FEDCBA9876543210';   // нет на компьютере
const UID_D = 'clap:com.example.gain';
const vstFx = (uid, name, extra = {}) => ({ type: /^clap:/.test(uid) ? 'clap' : 'vst3', on: true, p: {}, vst: { uid, name, vendor: 'Test', state: 'U1RBVEU=', ctrl: /^clap:/.test(uid) ? '' : 'Q1RSTA==', params: {} }, ...extra });

(async () => {
  const fx = await load('audioFx.js');
  const jobs = await load('vstJobs.js');
  const plan = await load('exportPlan.js');
  fx.setVstPlugins([{ uid: UID_A.toLowerCase(), name: 'A', format: 'vst3' }, { uid: UID_D, name: 'D', format: 'clap' }]);

  section('audioFx: записи VST3 / CLAP');
  ok(fx.fxDef('vst3') && fx.fxDef('vst3').name === 'VST3' && fx.fxDef('vst3').params.length === 0, 'fxDef(vst3) — псевдоописание');
  ok(fx.fxDef('clap') && fx.fxDef('clap').name === 'CLAP', 'fxDef(clap)');
  ok(fx.isNativeFx('vst3') && fx.isNativeFx('clap') && !fx.isNativeFx('eq'), 'isNativeFx');
  ok(fx.newAudioFx('vst3') === null, 'newAudioFx(vst3) — null (нужен newPluginFx)');
  const nf = fx.newPluginFx({ uid: UID_D, name: 'D', vendor: 'V', format: 'clap' }, { state: 'S', ctrl: 'X' });
  ok(nf.type === 'clap' && nf.vst.uid === UID_D && nf.vst.state === 'S' && nf.vst.ctrl === '' && nf.on === true, 'newPluginFx: CLAP, ctrl пустой');
  const nv = fx.newPluginFx({ uid: UID_A, name: 'A', vendor: 'V' }, { state: 'S', ctrl: 'C' });
  ok(nv.type === 'vst3' && nv.vst.ctrl === 'C' && JSON.stringify(nv.vst.params) === '{}', 'newPluginFx: VST3 c ctrl');

  const eq = { type: 'eq', on: true, p: { low: 3, mid: 0, midF: 1000, high: 0 } };
  const comp = { type: 'comp', on: true, p: { threshold: -18, ratio: 4, attack: 20, release: 250, makeup: 0 } };
  const den = { type: 'denoise', on: true, p: { strength: 12, floor: -50 } };
  const chain = [eq, comp, vstFx(UID_A, 'Alpha', { vst: { uid: UID_A, name: 'Alpha', state: 'U1RBVEU=', ctrl: 'Q1RSTA==', params: { 7: 0.5, 3: 2 } } }),
    den, vstFx(UID_A, 'Off', { on: false }), vstFx(UID_C, 'Ghost'), vstFx(UID_D, 'Delta')];
  const warned = [];
  const st = fx.splitStages(chain, (n) => warned.push(n));
  ok(st.length === 4, `splitStages: 4 стадии (${st.length})`);
  ok(st[0].af && /bass=/.test(st[0].af) && /acompressor=/.test(st[0].af) && !st[0].vst, `стадия 1 — eq+comp одним af: ${st[0].af}`);
  ok(st[1].vst && st[1].vst.uid === UID_A && st[1].vst.state === 'U1RBVEU=' && st[1].vst.ctrl === 'Q1RSTA==', 'стадия 2 — VST3 с состоянием');
  ok(JSON.stringify(st[1].vst.params) === '{"3":1,"7":0.5}', `params: только 0..1, ключи по порядку: ${JSON.stringify(st[1].vst.params)}`);
  ok(st[2].af && /afftdn=/.test(st[2].af), 'стадия 3 — шумоподавление');
  ok(st[3].vst && st[3].vst.uid === UID_D && st[3].vst.ctrl === '', 'стадия 4 — CLAP (выключенный и ненайденный пропущены)');
  ok(warned.length === 1 && warned[0] === 'Ghost', `ненайденный плагин — предупреждение: ${warned.join(',')}`);
  ok(fx.splitStages([eq, comp]).length === 1 && fx.splitStages([]).length === 0, 'без плагинов — одна стадия af; пустой список — без стадий');
  ok(!/vst|undefined/.test(fx.ffAudioFx(chain)) && fx.ffAudioFx(chain).includes('afftdn'), 'ffAudioFx пропускает VST3/CLAP');
  ok(fx.webAudioChain(chain).every((n) => n.node), 'webAudioChain пропускает VST3/CLAP');
  ok(fx.hasVst(chain) && !fx.hasVst([eq, vstFx(UID_C, 'Ghost')]) && !fx.hasVst([vstFx(UID_A, 'Off', { on: false })]), 'hasVst — только включённые найденные');
  ok(JSON.stringify(fx.missingVst(chain)) === '["Ghost"]', 'missingVst');
  ok(fx.vstEntries(chain).length === 3, 'vstEntries — включённые записи плагинов (найденные и нет)');
  ok(fx.unknownFx(chain).length === 0, 'unknownFx не считает VST3/CLAP пропавшими эффектами');
  ok(/Alpha/.test(fx.fxSummary(chain)) && /Delta/.test(fx.fxSummary(chain)), `fxSummary с именами плагинов: ${fx.fxSummary(chain)}`);
  ok(fx.normUid('0123456789abcdef0123456789abcdef') === UID_A && fx.normUid('clap:Com.X') === 'clap:Com.X', 'normUid: hex без регистра, CLAP как есть');

  section('vstJobs: задания vst_render');
  const media = {
    v: { path: 'C:/m/v.mp4', hasVideo: true, hasAudio: true, duration: 20, width: 320, height: 180 },
    a: { path: 'C:/m/a.wav', hasVideo: false, hasAudio: true, duration: 30, audioStreams: [{}, {}] },
  };
  const project = {
    media,
    videoClips: [{ id: 'vc1', mediaId: 'v', in: 1, out: 5, start: 0, volume: 0.8, afx: [vstFx(UID_A, 'Alpha')] }],
    audioTracks: [
      { id: 'tk1', clips: [{ id: 'ac1', mediaId: 'a', in: 3, out: 7, start: 2, volume: 0.5, speed: 2, stream: 5, fadeIn: 0.3, afx: [eq, vstFx(UID_D, 'Delta')] }] },
      { id: 'tk2', volume: 0.7, afx: [comp, vstFx(UID_A, 'Bus')], clips: [
        { id: 'ac2', mediaId: 'a', in: 0, out: 2, start: 1, volume: 1, afx: [vstFx(UID_A, 'Alpha')] },
        { id: 'ac3', mediaId: 'a', in: 4, out: 6, start: 4, volume: 0.6, afx: [den] },
      ] },
    ],
  };
  const cj = jobs.clipJob(project, project.audioTracks[0].clips[0], { audio: true });
  ok(cj.input.kind === 'clip' && cj.input.file === 'C:/m/a.wav' && cj.input.stream === 1 && cj.input.in === 3 && cj.input.dur === 2 && cj.input.speed === 2,
    `клип: ${JSON.stringify(cj.input)}`);
  ok(cj.dur === 2 && cj.stages.length === 2 && cj.stages[0].af && cj.stages[1].vst.uid === UID_D, 'клип: длина на таймлайне, стадии eq → CLAP');
  ok(!('volume' in cj.input) && !JSON.stringify(cj).includes('afade'), 'громкость и затухания не входят в задание');
  const cj0 = jobs.clipJob(project, project.audioTracks[0].clips[0], { audio: true, upto: 1 });
  ok(cj0.stages.length === 1 && cj0.stages[0].af, 'upto: прослушивание — только стадии до плагина');
  ok(jobs.clipJob(project, project.audioTracks[0].clips[0], { upto: 0 }).stages.length === 0, 'upto=0 — сухой звук (пустые стадии)');
  const vj = jobs.clipJob(project, project.videoClips[0], { audio: false });
  ok(vj.input.stream === 0 && vj.input.in === 1 && vj.input.dur === 4 && vj.input.speed === 1, 'звук видеоклипа — первый поток');
  ok(jobs.clipJob({ media: {} }, project.videoClips[0]) === null, 'нет файла — нет задания');
  ok(jobs.jobKey(cj) === jobs.jobKey(jobs.clipJob(project, project.audioTracks[0].clips[0])), 'ключ стабилен');
  ok(jobs.trackVstClips(project, project.audioTracks[1]).map((c) => c.id).join() === 'ac2', 'клипы дорожки, которым нужен свой рендер');

  const tj = jobs.trackJob(project, 'tk2', { clipWavs: { ac2: 'C:/cache/vst/ac2.wav' }, ffMajor: 7 });
  ok(tj.input.kind === 'graph' && tj.dur === 6 && tj.input.plan.duration === 6, `дорожка: граф, длина до конца последнего клипа (${tj.dur})`);
  ok(tj.stages.length === 2 && /acompressor/.test(tj.stages[0].af) && tj.stages[1].vst.uid === UID_A, 'стадии — эффекты дорожки');
  const ga = tj.input.plan.args;
  const gi = ga.map((x, i) => (x === '-i' ? ga[i + 1] : null)).filter(Boolean);
  ok(gi[0] === 'C:/cache/vst/ac2.wav' && ga[ga.indexOf('C:/cache/vst/ac2.wav') - 2] !== '-ss', `вход клипа с плагином — WAV без -ss: ${gi.join(' | ')}`);
  ok(gi[1] === 'C:/m/a.wav', 'второй клип — исходник');
  ok(ga.slice(-3).join(' ') === '-map [aout] @@OUT@@' && ga.includes('-/filter_complex') && !ga.includes('-f') && !ga.includes('-c:a'),
    `выход графа (формат ставит Rust): ${ga.slice(ga.indexOf('-map')).join(' ')}`);
  const gf = tj.input.plan.filter;
  ok(/^\[0:a\]aresample=48000[^;]*,volume=1\.000000,asetpts/.test(gf) && !/\[0:a\][^;]*atempo/.test(gf), `WAV клипа: формат + громкость клипа, без atempo/эффектов: ${gf.split(';')[0]}`);
  ok(/\[1:a:0\][^;]*volume=0\.600000,afftdn/.test(gf), 'клип без плагина: свои эффекты в графе, громкость клипа без громкости дорожки');
  ok(/amix=inputs=2[^;]*apad,atrim=duration=6\.000000\[aout\]$/.test(gf), 'микс → [aout]');
  ok(!/acompressor/.test(gf), 'эффектов дорожки в графе нет');
  ok(jobs.trackJob(project, 'tk2', { ffMajor: 6 }).input.plan.args.includes('-filter_complex_script'), 'старый FFmpeg — -filter_complex_script');

  section('exportPlan: подмена на WAV рендера');
  const S = { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'medium', output: 'C:/out/x.mp4' };
  const assets = { texts: {}, subtitles: null, vst: { clips: { vc1: { path: 'C:/cache/vst/vc1.wav' }, ac1: { path: 'C:/cache/vst/ac1.wav' }, ac2: { path: 'C:/cache/vst/ac2.wav' } }, tracks: { tk2: { path: 'C:/cache/vst/tk2.wav' } } } };
  const b = plan.buildExport(JSON.parse(JSON.stringify(project)), { ...S, assets });
  const ins = b.inputs.map((x, i) => (x === '-i' ? b.inputs[i + 1] : null)).filter(Boolean);
  const idx = (p) => ins.indexOf(p);
  ok(ins.includes('C:/cache/vst/vc1.wav') && ins.includes('C:/cache/vst/ac1.wav') && ins.includes('C:/cache/vst/tk2.wav'), `входы: ${ins.join(' | ')}`);
  ok(!ins.includes('C:/cache/vst/ac2.wav'), 'клип дорожки с плагинами в эффектах дорожки — уже в WAV дорожки');
  ok(ins.filter((x) => x === 'C:/m/a.wav').length === 0, 'исходники клипов с рендером не открываются');
  ok(ins.includes('C:/m/v.mp4'), 'видео клипа открывается для картинки');
  const fl = b.filter.split(';\n');
  const vca = fl.find((x) => x.startsWith(`[${idx('C:/cache/vst/vc1.wav')}:a]`));
  ok(vca && /volume=0\.800000,asetpts=PTS-STARTPTS,apad,atrim=duration=4\.000000,adelay=delays=0:all=1\[va0\]$/.test(vca), `звук видеоклипа из WAV: ${vca}`);
  const a1 = fl.find((x) => x.startsWith(`[${idx('C:/cache/vst/ac1.wav')}:a]`));
  ok(a1 && !/atempo|bass=/.test(a1) && /volume=0\.500000/.test(a1) && /afade=t=in:st=0\.000000:d=0\.300000/.test(a1) && /adelay=delays=2000:all=1\[m0\]$/.test(a1),
    `аудиоклип из WAV: без atempo и эффектов, громкость, затухание, место: ${a1}`);
  const t2 = fl.find((x) => x.startsWith(`[${idx('C:/cache/vst/tk2.wav')}:a]`));
  ok(t2 && /volume=0\.700000,asetpts=PTS-STARTPTS,adelay=delays=0:all=1\[tk\d+_\d+\]$/.test(t2), `дорожка из WAV: громкость дорожки, adelay 0: ${t2}`);
  ok(!/acompressor|afftdn/.test(b.filter), 'эффекты цепочек с рендером в граф экспорта не попадают');
  ok(b.duration === 6 && b.warnings.length === 0, `длина ролика и предупреждения: ${b.duration}, ${JSON.stringify(b.warnings)}`);

  // Без подготовленных файлов (оценка в окне экспорта до подготовки) — как раньше, без предупреждения «не подготовлен»
  const nb = plan.buildExport(JSON.parse(JSON.stringify(project)), S);
  ok(/atempo/.test(nb.filter) && /acompressor/.test(nb.filter) && nb.warnings.length === 0, 'без assets — встроенные эффекты, плагины пропущены молча');
  const pb = plan.buildExport(JSON.parse(JSON.stringify(project)), { ...S, assets: { texts: {}, subtitles: null, vst: { clips: {}, tracks: {} } } });
  ok(pb.warnings.some((w) => /не подготовлен/.test(w)), 'assets без рендера — предупреждение');
  const gp = JSON.parse(JSON.stringify(project)); gp.audioTracks[0].clips[0].afx.push(vstFx(UID_C, 'Ghost'));
  ok(plan.buildExport(gp, { ...S, assets }).warnings.some((w) => /Ghost/.test(w)), 'ненайденный плагин — предупреждение экспорта');
  // Проект без плагинов: assets.vst не меняет план
  const plain = JSON.parse(JSON.stringify(project));
  for (const c of [...plain.videoClips, ...plain.audioTracks.flatMap((x) => x.clips)]) c.afx = (c.afx || []).filter((x) => !fx.isVst(x));
  for (const tr of plain.audioTracks) tr.afx = (tr.afx || []).filter((x) => !fx.isVst(x));
  const p1 = plan.buildExport(JSON.parse(JSON.stringify(plain)), S); const p2 = plan.buildExport(JSON.parse(JSON.stringify(plain)), { ...S, assets });
  ok(p1.filter === p2.filter && JSON.stringify(p1.inputs) === JSON.stringify(p2.inputs), 'без плагинов план не зависит от assets.vst');
  // Переход на видеодорожке: WAV клипа без «запаса» — появление за половину перехода
  const tp = { media, audioTracks: [], videoClips: [
    { id: 'x1', mediaId: 'v', in: 0, out: 3, start: 0, volume: 1 },
    { id: 'x2', mediaId: 'v', in: 5, out: 8, start: 3, volume: 1, transition: { type: 'fade', duration: 1 }, afx: [vstFx(UID_A, 'Alpha')] }] };
  const tb = plan.buildExport(tp, { ...S, assets: { vst: { clips: { x2: { path: 'C:/cache/vst/x2.wav' } }, tracks: {} } } });
  ok(/atrim=duration=3\.000000,afade=t=in:st=0:d=0\.500000,adelay=delays=3000:all=1\[va1\]/.test(tb.filter), 'переход: WAV ставится на начало клипа, появление за половину перехода');

  section('Движок (если программа собрана)');
  let ff = null;
  try { ff = require('./engine'); await ff.ready; } catch (e) { console.log(`  пропуск: ${e.message.split('\n')[0]}`); ff = null; }
  if (ff && ff.findBinaries().ffmpeg && !ff.findBinaries().missing) {
    const DIR = path.join(ff.paths().temp || path.join(__dirname, '..', '.test-cache'), 'vst-test');
    fs.mkdirSync(DIR, { recursive: true });
    const bin = ff.findBinaries().ffmpeg;
    const ffMajor = ff.findBinaries().version ? ff.findBinaries().version[1] : 99;
    const make = async (name, args) => { const f = path.join(DIR, name); if (!fs.existsSync(f)) await ff.run(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args, f]); return f; };
    const src = await make('src.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '8', '-ac', '2']);
    const wavA = await make('render_a.wav', ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-ac', '2', '-c:a', 'pcm_f32le']);
    const wavT = await make('render_t.wav', ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '6', '-ac', '2', '-c:a', 'pcm_f32le']);
    const im = await ff.probe(src);
    const pr = { media: { a: im }, videoClips: [], audioTracks: [
      { id: 'tk1', clips: [{ id: 'ac1', mediaId: 'a', in: 1, out: 5, start: 1, volume: 0.5, speed: 2, afx: [vstFx(UID_A, 'Alpha')] }] },
      { id: 'tk2', volume: 0.8, afx: [vstFx(UID_A, 'Bus')], clips: [
        { id: 'ac2', mediaId: 'a', in: 0, out: 2, start: 1, volume: 1, afx: [vstFx(UID_A, 'Alpha')] },
        { id: 'ac3', mediaId: 'a', in: 4, out: 6, start: 4, volume: 0.6, afx: [eq] }] }] };
    // Граф дорожки — настоящий запуск FFmpeg (как его запустит vst_render: @@FILTER@@ — файл, @@OUT@@ — выход f32le)
    const g = jobs.trackJob(pr, 'tk2', { clipWavs: { ac2: wavA }, ffMajor }).input.plan;
    const ffile = path.join(DIR, 'graph.txt');
    fs.writeFileSync(ffile, g.filter);
    const raw = path.join(DIR, 'graph.f32');
    try {
      // @@OUT@@ → формат вывода, как его ставит Rust (vst_render)
      await ff.run(bin, ['-y', ...g.args.flatMap((x) => (x === '@@FILTER@@' ? [ffile] : x === '@@OUT@@' ? ['-f', 'f32le', '-ar', '48000', '-ac', '2', raw] : [x]))]);
      const n = fs.statSync(raw).size / 8; // f32 × 2 канала
      okLog(Math.abs(n / 48000 - g.duration) < 0.05, `граф дорожки в FFmpeg: ${(n / 48000).toFixed(3)} с (ожидалось ${g.duration})`);
    } catch (e) { okLog(false, `граф дорожки в FFmpeg: ${e.message}`); }
    // Экспорт с подменой на WAV: план проходит checkplan и реально собирается
    const out = path.join(DIR, 'out_vst.mp4');
    const set = { width: 320, height: 180, fps: 30, codec: 'libx264', quality: 'medium', output: out,
      assets: { texts: {}, subtitles: null, vst: { clips: { ac1: { path: wavA } }, tracks: { tk2: { path: wavT } } } } };
    const cmd = plan.exportCommand(pr, set, ffMajor);
    try { okLog(await ff.engine('checkplan', { plan: cmd }) === true, 'план с WAV рендера проходит checkplan'); } catch (e) { okLog(false, `checkplan: ${e.message}`); }
    try {
      await ff.startExport(pr, set);
      const io = await ff.probe(out);
      okLog(io.hasAudio && Math.abs(io.duration - 6) < 0.15, `экспорт с WAV рендера: ${io.duration} с, звук ${io.hasAudio}`);
    } catch (e) { okLog(false, `экспорт с WAV рендера: ${e.message}`); }
  } else if (ff) console.log('  пропуск: FFmpeg не найден');

  console.log(`\nпроверок: ${passed + failed}, провалов: ${failed}`);
  console.log(failed ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ОК');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
