'use strict';
// Хост аудиоплагинов (src-tauri/src/vst): сканирование, сведения, офлайн-рендер через VST3 и CLAP — без окна.
//   node tests/vst-host-test.js            — тестовые плагины (cargo build --profile fast --example vst3_test_gain --example clap_test_gain)
//   node tests/vst-host-test.js <plugin…>  — плюс сторонние .vst3/.clap: найден, info, рендер не падает и даёт звук нужной длины
// Проверяется: кэш сканирования (второй проход ничего не запускает), сбойный файл попадает в failed,
// усиление из params и из сохранённого состояния, длина выхода = длине входа, повторный рендер — из кэша.
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const BASE = path.join(APP, '.test-cache', 'vst-host');
const PLUG = path.join(BASE, 'plugins');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(PLUG, { recursive: true });
// Своя папка данных и кэша: список плагинов и рендеры не смешиваются с другими тестами
const cfg = path.join(BASE, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ version: 1, cacheDir: path.join(BASE, 'cache'), outputDir: path.join(BASE, 'out'), projectsDir: path.join(BASE, 'projects'), ffmpegDir: '' }));
process.env.FFM_CONFIG = cfg;
process.env.FFM_AUDIO_PLUGIN_PATH = PLUG;
const ff = require('./engine.js');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`FAIL ${m}`); } };

function exampleDll(name) {
  for (const prof of ['fast', 'release', 'debug']) {
    const p = path.join(APP, 'src-tauri', 'target', prof, 'examples', `${name}.dll`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`нет ${name}.dll — соберите: cd src-tauri && cargo build --profile fast --example ${name}`);
}

/** WAV float32 стерео → {frames, peak, rms} */
function wavStats(file) {
  const b = fs.readFileSync(file);
  let p = 12; let data = -1; let size = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4); const sz = b.readUInt32LE(p + 4);
    if (id === 'data') { data = p + 8; size = Math.min(sz, b.length - data); break; }
    p += 8 + sz + (sz % 2);
  }
  const n = Math.floor(size / 4);
  let peak = 0; let sum = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(b.readFloatLE(data + i * 4)); peak = Math.max(peak, v); sum += v * v; }
  return { frames: n / 2, peak, rms: Math.sqrt(sum / Math.max(1, n)) };
}

(async () => {
  await ff.ready;
  const { run, findBinaries } = ff;
  const bin = findBinaries();
  // Синус 1 кГц, амплитуда 0.25, 2 с, стерео
  const sine = path.join(BASE, 'sine.wav');
  await run(bin.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2', '-af', 'volume=0.5,aformat=channel_layouts=stereo', '-c:a', 'pcm_f32le', sine]);
  const dry = wavStats(sine);
  ok(dry.frames === 96000 && dry.peak > 0.01, `сухой: ${JSON.stringify(dry)}`);
  const near = (v, k) => Math.abs(v / dry.peak - k) < 0.02; // отношение к сухому пику

  fs.copyFileSync(exampleDll('vst3_test_gain'), path.join(PLUG, 'FFM Test Gain.vst3'));
  fs.copyFileSync(exampleDll('clap_test_gain'), path.join(PLUG, 'FFM Test Gain.clap'));
  fs.writeFileSync(path.join(PLUG, 'broken.vst3'), 'not a dll');
  const extra = process.argv.slice(2).filter((p) => fs.existsSync(p));
  for (const p of extra) fs.copyFileSync(p, path.join(PLUG, path.basename(p)));

  // --- сканирование ---
  let t0 = Date.now();
  const l1 = await ff.engine('vst-scan', {});
  const scanMs = Date.now() - t0;
  const vst = l1.plugins.find((x) => x.format === 'vst3' && x.name === 'FFM Test Gain');
  const clap = l1.plugins.find((x) => x.format === 'clap' && x.uid === 'clap:ffmontage.test.gain');
  ok(vst && /^[0-9A-F]{32}$/.test(vst.uid) && vst.vendor === 'FF Montage Tests', `VST3 найден: ${JSON.stringify(vst)}`);
  ok(clap && clap.vendor === 'FF Montage Tests' && /audio-effect/.test(clap.sub), `CLAP найден: ${JSON.stringify(clap)}`);
  ok(l1.failed.some((x) => /broken\.vst3$/.test(x.path) && x.error), `сбойный в failed: ${JSON.stringify(l1.failed)}`);
  t0 = Date.now();
  const l2 = await ff.engine('vst-scan', {});
  ok(l2.plugins.length === l1.plugins.length && l2.failed.length === l1.failed.length, 'второй проход — тот же список');
  console.log(`scan: ${scanMs} мс, повтор (кэш): ${Date.now() - t0} мс`);
  if (!vst || !clap) throw new Error('тестовые плагины не найдены');

  // --- info ---
  const iv = await ff.engine('vst-info', { uid: vst.uid });
  ok(iv.params.length === 1 && iv.params[0].title === 'Gain' && iv.state && iv.hasEditor === false, `VST3 info: ${JSON.stringify(iv).slice(0, 300)}`);
  const ic = await ff.engine('vst-info', { uid: clap.uid });
  ok(ic.params.length === 1 && ic.params[0].title === 'Gain' && Math.abs(ic.params[0].value - 0.5) < 1e-6 && ic.state, `CLAP info: ${JSON.stringify(ic).slice(0, 300)}`);
  // Состояние после params: у VST3 0..1 → усиление 0.5; у CLAP 0..1 → 0..2, т.е. 0.25 → 0.5
  const iv2 = await ff.engine('vst-info', { uid: vst.uid, params: { 0: 0.5 } });
  ok(Math.abs(iv2.params[0].value - 0.5) < 1e-6 && iv2.state !== iv.state, 'VST3: params меняют состояние');
  const ic2 = await ff.engine('vst-info', { uid: clap.uid, params: { 0: 0.25 } });
  ok(Math.abs(ic2.params[0].value - 0.25) < 1e-6 && ic2.state !== ic.state, `CLAP: params меняют состояние ${JSON.stringify(ic2.params)}`);
  const ic3 = await ff.engine('vst-info', { uid: clap.uid, state: ic2.state });
  ok(Math.abs(ic3.params[0].value - 0.25) < 1e-6, 'CLAP: состояние восстанавливается');

  // --- рендер ---
  const clipJob = (stages, dur = 2) => ({ input: { kind: 'clip', file: sine, stream: 0, in: 0, dur, speed: 1 }, stages, dur });
  const render = async (stages, name, dur = 2) => {
    const r = await ff.engine('vst-render', { job: clipJob(stages, dur) });
    const s = wavStats(r.path);
    console.log(`${name}: ${s.frames} кадров, пик ${s.peak.toFixed(4)}${r.cached ? ' (кэш)' : ''}`);
    return { r, s };
  };
  const a = await render([{ vst: { uid: vst.uid, state: iv2.state } }], 'VST3 ×0.5 (состояние)');
  ok(a.s.frames === 96000 && near(a.s.peak, 0.5), 'VST3: состояние даёт ×0.5 и длину 2 с');
  const b = await render([{ vst: { uid: vst.uid, params: { 0: 0.5 } } }], 'VST3 ×0.5 (params)');
  ok(near(b.s.peak, 0.5), 'VST3: params дают ×0.5');
  const c = await render([{ vst: { uid: clap.uid, params: { 0: 1 } } }], 'CLAP ×2');
  ok(c.s.frames === 96000 && near(c.s.peak, 2), 'CLAP: ×2');
  // VST3 ×0.5 → встроенный фильтр (+6 дБ ≈ ×2) → CLAP ×0.5 = ×0.5
  const d = await render([{ vst: { uid: vst.uid, params: { 0: 0.5 } } }, { af: 'volume=2' }, { vst: { uid: clap.uid, params: { 0: 0.25 } } }], 'цепочка');
  ok(near(d.s.peak, 0.5), 'цепочка VST3 → af → CLAP');
  const e = await render([{ vst: { uid: vst.uid, params: { 0: 0.5 } } }, { vst: { uid: clap.uid, params: { 0: 1 } } }], 'два плагина в одном хосте');
  ok(near(e.s.peak, 1), 'VST3 + CLAP в одном процессе');
  const a2 = await ff.engine('vst-render', { job: clipJob([{ vst: { uid: vst.uid, state: iv2.state } }]) });
  ok(a2.cached === true && a2.path === a.r.path, 'повторный рендер — из кэша');
  const f = await render([], 'сухой, 3 с (дольше исходника)', 3);
  ok(f.s.frames === 144000, 'длина результата = dur (тишина в конце)');
  // Запреты
  let denied = '';
  try { await ff.engine('vst-render', { job: clipJob([{ af: 'amovie=x.wav' }]) }); } catch (x) { denied = x.message; }
  ok(/отклон|reject|не разрешён|not allowed/i.test(denied), `опасный фильтр отклонён: ${denied}`);
  denied = '';
  try { await ff.engine('vst-render', { job: clipJob([{ vst: { uid: '00000000000000000000000000000000' } }]) }); } catch (x) { denied = x.message; }
  ok(/не найден|not found/.test(denied), `неизвестный uid: ${denied}`);

  // --- сторонние плагины ---
  for (const p of extra) {
    const name = path.basename(p);
    const list = (await ff.engine('vst-list', {})).plugins.filter((x) => path.basename(x.path) === name && !x.instrument);
    ok(list.length > 0, `${name}: найден (${JSON.stringify((await ff.engine('vst-list', {})).failed)})`);
    for (const pl of list) {
      t0 = Date.now();
      const inf = await ff.engine('vst-info', { uid: pl.uid });
      console.log(`${pl.format} ${pl.vendor} / ${pl.name} ${pl.version} [${pl.sub}] — параметров ${inf.params.length}, окно: ${inf.hasEditor}, задержка ${inf.latency}, состояние ${Buffer.from(inf.state, 'base64').length} Б, info ${Date.now() - t0} мс`);
      ok(typeof inf.state === 'string', `${pl.name}: info`);
      const r = await render([{ vst: { uid: pl.uid, state: inf.state, ctrl: inf.ctrl } }], pl.name);
      ok(r.s.frames === 96000, `${pl.name}: длина рендера`);
    }
  }

  console.log(`\nvst-host-test: ${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
