'use strict';
// Встроенные плагины (plugins-bundled/<id>/plugin.json; Rust встраивает их в exe — src-tauri/src/bundled.rs):
//   node tests/bundled-test.js [--no-ffmpeg]
// 1) манифесты: id = папка, версия, названия ru/en, фильтры ⊆ SAFE_FILTERS (+ фильтры хоста у эффектов с prepare),
//    у эффектов "preview": "frame" (шторка) или "proxy" со "stage": "source" (стабилизация);
// 2) эффекты регистрируются реестром окна (js/registry.js) и дают ожидаемые графы (по умолчанию, 0 — ступень выключена);
// 3) реальный FFmpeg: графы по умолчанию, с минимумами и максимумами работают на коротком клипе lavfi;
//    если собрана программа — ещё и экспорт через движок (проверка плана в Rust, plancheck.rs).
// Файлы — только в .test-cache (через tests/engine.js или .test-cache/bundled-test).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'plugins-bundled');
const JS = path.join(ROOT, 'src', 'renderer', 'js');
const load = (f) => import(pathToFileURL(path.join(JS, f)).href);
const NO_FFMPEG = process.argv.includes('--no-ffmpeg');

let failed = 0; let passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++; console.log(`  ПРОВАЛ: ${msg}`);
}
const both = (v) => !!v && typeof v === 'object' && typeof v.ru === 'string' && v.ru.trim() && typeof v.en === 'string' && v.en.trim();

function readPlugins() {
  return fs.readdirSync(BUNDLED, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const file = path.join(BUNDLED, e.name, 'plugin.json');
      const raw = fs.readFileSync(file);
      return { dir: e.name, bom: raw[0] === 0xef && raw[1] === 0xbb, m: JSON.parse(raw.toString('utf8')) };
    });
}

// Значения параметров эффекта: def | min | max | все «выключено» (0, где это min)
const valuesOf = (fx, edge) => Object.fromEntries((fx.params || []).map((p) => [p.k, p[edge]]));

function findFfmpeg(engineBin) {
  const c = [engineBin, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const x of c) {
    const r = spawnSync(x, ['-hide_banner', '-version'], { windowsHide: true });
    if (r.status === 0) return x;
  }
  return null;
}

function ffmpeg(bin, args) {
  const r = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' });
  return { ok: r.status === 0, err: String(r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
}

(async () => {
  const { SAFE_FILTERS, HOST_FILTERS } = await load('core/safeFilters.js');
  const reg = await load('registry.js');
  const fxm = await load('effects.js');

  console.log('Манифесты:');
  const plugins = readPlugins();
  ok(['vignette', 'restore', 'stabilize'].every((d) => plugins.some((p) => p.dir === d)), `есть vignette, restore и stabilize: ${plugins.map((p) => p.dir)}`);
  const ids = [];
  for (const { dir, bom, m } of plugins) {
    ok(!bom, `${dir}: plugin.json без BOM`);
    ok(m.id === dir, `${dir}: id = имя папки (${m.id})`);
    ok(/^\d+\.\d+\.\d+$/.test(m.version || ''), `${dir}: версия x.y.z (${m.version})`);
    ok(m.apiVersion === 1, `${dir}: apiVersion 1`);
    ok(both(m.name) && both(m.description), `${dir}: name и description на ru и en`);
    ok(!m.entry && (!m.permissions || !m.permissions.length), `${dir}: без кода и прав`);
    const filters = (m.ffmpeg && m.ffmpeg.filters) || [];
    ok(filters.every((f) => SAFE_FILTERS.includes(f) || HOST_FILTERS.includes(f)), `${dir}: фильтры в SAFE_FILTERS: ${filters.filter((f) => !SAFE_FILTERS.includes(f))}`);
    ok(!filters.includes('vidstabdetect'), `${dir}: vidstabdetect плагину не даётся`);
    const owner = { id: m.id, filters: new Set(filters) };
    for (const fx of (m.contributes && m.contributes.effects) || []) {
      ok(fx.preview === 'frame' || (fx.preview === 'proxy' && fx.stage === 'source'), `${dir}.${fx.id}: "preview": "frame" или "proxy" + stage source`);
      ok(!(fx.ffmpeg || []).some((f) => HOST_FILTERS.includes(f.filter)) || (fx.prepare && fx.prepare.kind === 'vidstab'), `${dir}.${fx.id}: фильтр хоста — только с prepare`);
      ok(both(fx.name), `${dir}.${fx.id}: название ru/en`);
      ok((fx.params || []).every((p) => both(p.name)), `${dir}.${fx.id}: названия параметров ru/en`);
      ok((fx.ffmpeg || []).every((f) => filters.includes(f.filter)), `${dir}.${fx.id}: фильтры объявлены в ffmpeg.filters`);
      let id = null;
      try { id = reg.registerEffect(JSON.parse(JSON.stringify(fx)), owner); } catch (e) { ok(false, `${dir}.${fx.id}: регистрация — ${e.message}`); continue; }
      ok(id === `${m.id}.${fx.id}`, `${dir}.${fx.id}: полный id ${id}`);
      ids.push({ id, fx, plugin: m.id });
    }
  }

  console.log('Графы:');
  const ffOf = (id, values) => fxm.effectById(id).ff(1920, values);
  const byId = (id) => ids.find((x) => x.id === id);
  ok(ffOf('vignette.vignette', null) === 'vignette=angle=0.5250', `виньетка по умолчанию: ${ffOf('vignette.vignette', null)}`);
  ok(ffOf('vignette.vignette', { strength: 0 }) === '', 'виньетка 0 — выключена');
  const deb = 'deblock=filter=strong:block=8:alpha=0.0980:beta=0.0500:gamma=0.0500:delta=0.0500';
  const dn = ffOf('restore.denoise', null);
  ok(dn === `${deb},hqdn3d=luma_spatial=4.00:chroma_spatial=3.00:luma_tmp=6.00:chroma_tmp=4.00,atadenoise=0.0200:0.0400:0.0200:0.0400:0.0200:0.0400`,
    `шумодав по умолчанию (мягко, ~4:3:6:4, без резкости): ${dn}`);
  ok(ffOf('restore.denoise', valuesOf(byId('restore.denoise').fx, 'min')) === '', 'шумодав: все ползунки на 0 — граф пуст');
  const sp0 = ffOf('restore.denoise', { deblock: 0, spatial: 0, temporal: 6, average: 0 });
  ok(sp0 === 'hqdn3d=luma_spatial=0.01:chroma_spatial=0.01:luma_tmp=6.00:chroma_tmp=4.00', `пространственная 0 — не «по умолчанию 4» у hqdn3d: ${sp0}`);
  const mx = ffOf('restore.denoise', valuesOf(byId('restore.denoise').fx, 'max'));
  ok(/luma_tmp=30\.00/.test(mx) && /block=32/.test(mx) && /unsharp=lx=5:ly=5:la=2\.00$/.test(mx), `шумодав максимум: ${mx}`);
  const hq = ffOf('restore.denoise-hq', null);
  ok(hq === `${deb},nlmeans=s=3.00:p=7:r=15`, `качественный по умолчанию: ${hq}`);
  ok(ffOf('restore.denoise-hq', { deblock: 0, strength: 0.5 }) === 'nlmeans=s=1.00:p=7:r=15', 'nlmeans: сила меньше 1 — минимум FFmpeg (1)');
  ok(ffOf('restore.denoise-hq', valuesOf(byId('restore.denoise-hq').fx, 'min')) === '', 'качественный: все 0 — граф пуст');
  // Стабилизация: deshake без подготовки; vidstab — файл .trf подставляет программа (без него — ошибка, эффект пропускается)
  const fast = ffOf('stabilize.fast', null);
  ok(fast === 'deshake=rx=32:ry=32:edge=mirror,scale=w=trunc(iw*1.0400/2)*2:h=-2,crop=w=trunc(iw/1.0400/2)*2:h=trunc(ih/1.0400/2)*2', `быстрая по умолчанию: ${fast}`);
  ok(ffOf('stabilize.fast', { zoom: 0, range: 64 }) === 'deshake=rx=64:ry=64:edge=mirror', 'быстрая без зума');
  const TRF = 'C\\\\:/c/media/k/stab/x.trf';
  const bal = fxm.effectById('stabilize.balanced');
  ok(bal.ff(1920, null, TRF) === `vidstabtransform=input=${TRF}:smoothing=15:optzoom=1:zoom=0.0:interpol=bilinear:tripod=0`, `баланс: ${bal.ff(1920, null, TRF)}`);
  let threw = false; try { bal.ff(1920, null); } catch { threw = true; }
  ok(threw, 'баланс без файла анализа — ошибка');
  ok(JSON.stringify(bal.prepare.args(null)) === JSON.stringify({ shakiness: 5, accuracy: 9, stepsize: 12, mincontrast: 0.3, tripod: 0 }), `баланс: анализ ${JSON.stringify(bal.prepare.args(null))}`);
  const mxs = fxm.effectById('stabilize.max');
  ok(mxs.ff(1920, null, TRF) === `vidstabtransform=input=${TRF}:smoothing=30:optzoom=1:zoom=0.0:interpol=bicubic:tripod=0,unsharp=lx=5:ly=5:la=0.50:cx=5:cy=5:ca=0.50`, `максимум: ${mxs.ff(1920, null, TRF)}`);
  ok(JSON.stringify(mxs.prepare.args({ tripod: 1 })) === JSON.stringify({ shakiness: 10, accuracy: 15, stepsize: 6, mincontrast: 0.1, tripod: 1 }), 'максимум: анализ shakiness=10:accuracy=15:stepsize=6:mincontrast=0.1');
  ok(fxm.ffEffects({ effects: ['stabilize.fast', 'vignette.vignette'] }, 1920) === 'vignette=angle=0.5250,', 'стабилизация не входит в ffEffects (она первой, до скорости)');
  ok(fxm.sourceEffect({ effects: ['vignette.vignette', 'stabilize.max', 'stabilize.fast'] }).id === 'stabilize.max', 'у клипа действует первая стабилизация');
  // Нет vidstab в сборке FFmpeg: Баланс/Максимум недоступны, экспорт пропускает с предупреждением; быстрая работает
  {
    const plan = await load('exportPlan.js');
    const m = { path: 'C:/x.mp4', hasVideo: true, hasAudio: false, width: 640, height: 360, duration: 10 };
    const proj = (fx) => ({ media: { m }, videoClips: [{ id: 'c', mediaId: 'm', in: 2, out: 6, start: 0, volume: 1, muted: true, effects: [fx] }], audioTracks: [] });
    const st = { width: 320, height: 180, fps: 25, codec: 'libx264', assets: { stab: { c: { trf: 'C:/c/app/media/k/stab/a.trf', start: 1, end: 7 } } } };
    fxm.setHostCaps({ vidstab: false });
    ok(!fxm.effectAvailable(fxm.effectById('stabilize.max')) && fxm.effectAvailable(fxm.effectById('stabilize.fast')), 'без vidstab: «Максимум» недоступен, «Быстрая» доступна');
    const p1 = plan.buildExport(proj('stabilize.max'), st);
    ok(p1.warnings.some((w) => /vidstab/.test(w)) && !/vidstab/.test(p1.filter), `без vidstab: экспорт пропускает с предупреждением (${p1.warnings})`);
    ok(/deshake=/.test(plan.buildExport(proj('stabilize.fast'), st).filter), 'без vidstab: быстрая стабилизация в экспорте');
    fxm.setHostCaps({ vidstab: null });
    const p2 = plan.buildExport(proj('stabilize.balanced'), st);
    ok(/-ss 1\.000000 -t 6\.000000 -i C:\/x\.mp4/.test(p2.inputs.join(' ')) && /\[0:v\]vidstabtransform=input=C\\\\:\/c\/app\/media\/k\/stab\/a\.trf:[^,]+,trim=start=1\.000000,setpts=PTS-STARTPTS,/.test(p2.filter),
      `vidstab: вход ровно отрезок анализа, после трансформа — trim запаса: ${p2.inputs.join(' ')} | ${p2.filter.split('\n')[0].slice(0, 160)}`);
  }
  // фильтр хоста без prepare, плейсхолдер не тот, vidstabdetect — отказ реестра
  const bad = (desc) => { try { reg.registerEffect(desc, { id: 'stab-bad', filters: new Set(['vidstabtransform', 'vidstabdetect']) }); return false; } catch { return true; } };
  ok(bad({ id: 'a', name: 'a', stage: 'source', ffmpeg: [{ filter: 'vidstabtransform', args: { input: '{trf}' } }] }), 'vidstabtransform без prepare — отказ');
  ok(bad({ id: 'b', name: 'b', stage: 'source', prepare: { kind: 'vidstab' }, ffmpeg: [{ filter: 'vidstabtransform', args: { input: 'C:/x.trf' } }] }), 'свой путь в input — отказ');
  ok(bad({ id: 'c', name: 'c', stage: 'source', prepare: { kind: 'vidstab' }, ffmpeg: [{ filter: 'vidstabdetect', args: { result: '{trf}' } }] }), 'vidstabdetect — отказ');
  ok(bad({ id: 'd', name: 'd', prepare: { kind: 'vidstab' }, ffmpeg: [{ filter: 'vidstabtransform', args: { input: '{trf}' } }] }), 'prepare без stage source — отказ');
  ok(bad({ id: 'e', name: 'e', stage: 'source', prepare: { kind: 'vidstab', args: { result: '1' } }, ffmpeg: [{ filter: 'vidstabtransform', args: { input: '{trf}' } }] }), 'prepare: чужой параметр — отказ');

  // --- FFmpeg ---
  let engine = null;
  if (!NO_FFMPEG) {
    try { engine = require('./engine'); await engine.ready; } catch (e) { console.log(`  (движок недоступен: ${String(e.message).split('\n')[0]})`); engine = null; }
  }
  const bin = NO_FFMPEG ? null : findFfmpeg(engine && engine.findBinaries().ffmpeg);
  if (!bin) {
    console.log('FFmpeg: пропущено (нет ffmpeg)');
  } else {
    console.log(`FFmpeg (${bin}):`);
    const dir = engine ? path.join(engine.paths().temp, 'bundled-test') : path.join(ROOT, '.test-cache', 'bundled-test');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'noisy.mp4');
    // шумный клип с движением и сильным сжатием (видны квадраты)
    const mk = ffmpeg(bin, ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1.2,noise=alls=30:allf=t+u', '-c:v', 'libx264', '-crf', '40', '-pix_fmt', 'yuv420p', src]);
    ok(mk.ok, `тестовый клип: ${mk.err}`);
    // Анализ для эффектов vidstab — тем же FFmpeg (в программе его делает только stab.rs); нет vidstab — пропуск
    const hasVidstab = /vidstabdetect/.test(String(spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true }).stdout || ''));
    const trf = path.join(dir, 'noisy.trf');
    if (hasVidstab) ok(ffmpeg(bin, ['-i', src, '-vf', `vidstabdetect=result=${trf.replace(/\\/g, '/').replace(/:/g, '\\\\:')}`, '-f', 'null', '-']).ok, 'vidstabdetect для теста');
    else console.log('  (в этой сборке FFmpeg нет vidstab — эффекты «Баланс» / «Максимум» не прогоняются)');
    for (const { id, fx } of ids) {
      const prep = !!fx.prepare;
      if (prep && !hasVidstab) continue;
      for (const edge of ['def', 'min', 'max']) {
        const g = prep ? fxm.effectById(id).ff(1920, valuesOf(fx, edge), trf.replace(/\\/g, '/').replace(/:/g, '\\\\:')) : ffOf(id, valuesOf(fx, edge));
        if (!g) continue;
        const r = ffmpeg(bin, ['-i', src, '-vf', g, '-f', 'null', '-']);
        ok(r.ok, `${id} (${edge}): ${g} — ${r.err}`);
      }
    }
    if (engine) {
      // Экспорт через движок: план проверяет Rust (фильтры из SAFE_FILTERS, позиционные опции atadenoise)
      const info = await engine.probe(src);
      const project = {
        media: { n: info },
        videoClips: [
          { mediaId: 'n', in: 0, out: 0.6, start: 0, volume: 1, muted: true, effects: ['restore.denoise', 'vignette.vignette'] },
          { mediaId: 'n', in: 0.6, out: 1.2, start: 0.6, volume: 1, muted: true, effects: ['restore.denoise-hq'], fxp: { 'restore.denoise-hq': { sharpen: 0.5 } } },
        ],
        audioTracks: [],
      };
      const out = path.join(dir, 'restored.mp4');
      try { fs.unlinkSync(out); } catch { /* нет файла */ }
      try {
        await engine.startExport(project, { width: 320, height: 240, fps: 25, codec: 'libx264', quality: 'high', output: out });
        const io = await engine.probe(out);
        ok(io && io.duration > 1, `экспорт с эффектами встроенных плагинов: ${io && io.duration} с`);
      } catch (e) { ok(false, `экспорт через движок: ${e.message}`); }
    }
  }

  console.log(failed ? `ИТОГ: ${failed} провалов, ${passed} проверок прошло` : `ИТОГ: всё прошло (${passed} проверок)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
