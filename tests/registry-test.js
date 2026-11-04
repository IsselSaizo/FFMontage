'use strict';
// Реестр эффектов и выражения (без программы и FFmpeg): node tests/registry-test.js
// 1) expr.js: арифметика, функции, шаблоны, отказ на мусор;
// 2) встроенные описания (js/core/*.js) дают те же строки, что прежняя реализация (её копия — ниже);
// 3) регистрация эффектов плагинов: проверки фильтров, ключей, значений; unregisterPlugin; missingIds; предупреждения экспорта.
const path = require('path');
const { pathToFileURL } = require('url');

const JS = path.join(__dirname, '..', 'src', 'renderer', 'js');
const load = (f) => import(pathToFileURL(path.join(JS, f)).href);

let failed = 0; let passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++; console.log(`  ПРОВАЛ: ${msg}`);
}
function throws(fn, re, msg) {
  try { fn(); } catch (e) { ok(!re || re.test(e.message), `${msg} — сообщение: ${e.message}`); return; }
  ok(false, `${msg} — ошибки не было`);
}
const section = (s) => console.log(s);

// ---------------- прежняя реализация (копия до перевода на реестр) ----------------
const OLD = (() => {
  const pct = (x) => `${(x * 100).toFixed(3)}%`;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const effects = [
    { id: 'bw', ff: () => 'hue=s=0', css: () => 'grayscale(1)' },
    { id: 'sepia', ff: () => 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131', css: () => 'sepia(1)' },
    { id: 'invert', ff: () => 'negate', css: () => 'invert(1)' },
    { id: 'contrast', ff: () => 'eq=contrast=1.35', css: () => 'contrast(1.35)' },
    { id: 'bright', ff: () => 'eq=brightness=0.1', css: () => 'brightness(1.25)' },
    { id: 'saturate', ff: () => 'eq=saturation=1.7', css: () => 'saturate(1.7)' },
    { id: 'fade', ff: () => 'eq=saturation=0.45:contrast=0.85', css: () => 'saturate(0.45) contrast(0.85)' },
    { id: 'blur', ff: (w) => `gblur=sigma=${Math.max(1, (w || 1920) * 0.006).toFixed(2)}`, css: (w) => `blur(${Math.max(0.5, (w || 640) * 0.006).toFixed(2)}px)` },
  ];
  const transitions = [
    { id: 'fade', style: (p) => ({ b: { opacity: p } }) },
    { id: 'fadeblack', style: (p) => ({ a: { opacity: clamp01(1 - 2 * p) }, b: { opacity: clamp01(2 * p - 1) } }) },
    { id: 'fadewhite', style: (p) => ({ a: { opacity: p < 0.5 ? 1 : 0 }, b: { opacity: p < 0.5 ? 0 : 1 }, overlay: { color: '#fff', opacity: 1 - Math.abs(2 * p - 1) } }) },
    { id: 'wipeleft', style: (p) => ({ b: { clipPath: `inset(0 0 0 ${pct(1 - p)})` } }) },
    { id: 'wiperight', style: (p) => ({ b: { clipPath: `inset(0 ${pct(1 - p)} 0 0)` } }) },
    { id: 'wipeup', style: (p) => ({ b: { clipPath: `inset(${pct(1 - p)} 0 0 0)` } }) },
    { id: 'wipedown', style: (p) => ({ b: { clipPath: `inset(0 0 ${pct(1 - p)} 0)` } }) },
    { id: 'smoothleft', style: (p) => ({ b: { mask: `linear-gradient(to right, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
    { id: 'smoothright', style: (p) => ({ b: { mask: `linear-gradient(to left, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
    { id: 'smoothup', style: (p) => ({ b: { mask: `linear-gradient(to bottom, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
    { id: 'smoothdown', style: (p) => ({ b: { mask: `linear-gradient(to top, transparent ${pct(1 - 2 * p)}, black ${pct(2 - 2 * p)})` } }) },
    { id: 'slideleft', style: (p) => ({ a: { transform: `translateX(${pct(-p)})` }, b: { transform: `translateX(${pct(1 - p)})` } }) },
    { id: 'slideright', style: (p) => ({ a: { transform: `translateX(${pct(p)})` }, b: { transform: `translateX(${pct(p - 1)})` } }) },
    { id: 'slideup', style: (p) => ({ a: { transform: `translateY(${pct(-p)})` }, b: { transform: `translateY(${pct(1 - p)})` } }) },
    { id: 'slidedown', style: (p) => ({ a: { transform: `translateY(${pct(p)})` }, b: { transform: `translateY(${pct(p - 1)})` } }) },
    { id: 'circleopen', style: (p) => { const r = (p - 0.5) * 3; return { b: { mask: `radial-gradient(circle farthest-corner at 50% 50%, black ${pct(r)}, transparent ${pct(r + 1)})` } }; } },
    { id: 'circleclose', style: (p) => { const r = (0.5 - p) * 3; return { top: 'a', a: { mask: `radial-gradient(circle farthest-corner at 50% 50%, black ${pct(r)}, transparent ${pct(r + 1)})` } }; } },
    { id: 'zoomin', style: (p) => ({ a: { transform: `scale(${1 + 1.2 * clamp01(p * 2)})` }, b: { opacity: clamp01(2 * p - 1) } }) },
    { id: 'hblur', style: (p) => { const b = 14 * (1 - Math.abs(2 * p - 1)); return { a: { filter: `blur(${b.toFixed(1)}px)` }, b: { opacity: p, filter: `blur(${b.toFixed(1)}px)` } }; } },
    { id: 'blinds', style: (p) => ({ b: { mask: `repeating-linear-gradient(to right, black 0, black ${(p * 10).toFixed(3)}%, transparent ${(p * 10).toFixed(3)}%, transparent 10%)` } }) },
  ];
  const XFADE = new Set(['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
    'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'slideleft', 'slideright', 'slideup', 'slidedown',
    'circleopen', 'circleclose', 'zoomin', 'hblur']);
  const xfade = (type) => (type === 'blinds' ? "transition=custom:expr='if(lt(mod(X,W/10),(1-P)*W/10),B,A)'" : `transition=${XFADE.has(type) ? type : 'fade'}`);
  const AFX = {
    eq: [['low', -15, 15, 0], ['mid', -15, 15, 0], ['midF', 200, 5000, 1000], ['high', -15, 15, 0]],
    comp: [['threshold', -60, 0, -18], ['ratio', 1, 20, 4], ['attack', 1, 200, 20], ['release', 10, 1000, 250], ['makeup', 0, 24, 0]],
    denoise: [['strength', 3, 40, 12], ['floor', -80, -20, -50]],
  };
  const fxParam = (fx, k) => {
    const pd = (AFX[fx.type] || []).find((x) => x[0] === k);
    if (!pd) return 0;
    const v = Number(fx.p && fx.p[k]);
    return Number.isFinite(v) ? Math.min(pd[2], Math.max(pd[1], v)) : pd[3];
  };
  const dB = (x) => 10 ** (x / 20);
  const n = (x, d = 6) => Number(x).toFixed(d);
  function ffAudioFx(list) {
    const out = [];
    for (const fx of list.filter((x) => x && x.on !== false && AFX[x.type])) {
      const p = (k) => fxParam(fx, k);
      if (fx.type === 'eq') {
        if (p('low')) out.push(`bass=g=${n(p('low'), 2)}:f=120:t=q:w=0.7`);
        if (p('mid')) out.push(`equalizer=f=${n(p('midF'), 1)}:t=q:w=1:g=${n(p('mid'), 2)}`);
        if (p('high')) out.push(`treble=g=${n(p('high'), 2)}:f=8000:t=q:w=0.7`);
      } else if (fx.type === 'comp') {
        out.push(`acompressor=threshold=${n(Math.max(0.000977, dB(p('threshold'))))}:ratio=${n(p('ratio'), 2)}` +
          `:attack=${n(p('attack'), 1)}:release=${n(p('release'), 1)}:makeup=${n(Math.max(1, dB(p('makeup'))))}:knee=2.8`);
      } else if (fx.type === 'denoise') {
        out.push(`afftdn=nr=${n(p('strength'), 1)}:nf=${n(p('floor'), 1)}`);
      }
    }
    return out.length ? `,${out.join(',')}` : '';
  }
  // preview.js fxNodes: те же узлы, только описанием вместо createBiquadFilter/createDynamicsCompressor/createGain
  function webAudio(list) {
    const nodes = [];
    for (const fx of list.filter((x) => x && x.on !== false && AFX[x.type])) {
      const p = (k) => fxParam(fx, k);
      if (fx.type === 'eq') {
        const mk = (type, f, gain, q) => { const b = { node: 'biquad', type, frequency: f, gain }; if (q) b.Q = q; return b; };
        nodes.push(mk('lowshelf', 120, p('low')), mk('peaking', p('midF'), p('mid'), 1.4), mk('highshelf', 8000, p('high')));
      } else if (fx.type === 'comp') {
        nodes.push({ node: 'compressor', threshold: p('threshold'), ratio: p('ratio'), knee: 6, attack: p('attack') / 1000, release: p('release') / 1000 },
          { node: 'gain', gain: 10 ** (p('makeup') / 20) });
      }
    }
    return nodes;
  }
  return { effects, transitions, xfade, ffAudioFx, webAudio };
})();

// Сравнение объектов: строки — точно; числа внутри строк — точно, кроме допусков (tol) для CSS transform
function sameStyle(a, b, tol = 0) {
  const ka = Object.keys(a || {}).sort(); const kb = Object.keys(b || {}).sort();
  if (ka.join() !== kb.join()) return false;
  for (const k of ka) {
    const x = a[k]; const y = b[k];
    if (x && typeof x === 'object') { if (!sameStyle(x, y, tol)) return false; continue; }
    if (typeof x === 'number' || typeof y === 'number') { if (x !== y) return false; continue; }
    if (x === y) continue;
    if (!tol) return false;
    // одинаковый текст вокруг чисел, числа — с допуском
    const re = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
    if (x.replace(re, '#') !== y.replace(re, '#')) return false;
    const nx = x.match(re).map(Number); const ny = y.match(re).map(Number);
    if (nx.some((v, i) => Math.abs(v - ny[i]) > tol)) return false;
  }
  return true;
}

(async () => {
  const expr = await load('expr.js');
  const reg = await load('registry.js');
  const fxm = await load('effects.js');
  const trm = await load('transitions.js');
  const afm = await load('audioFx.js');
  const plan = await load('exportPlan.js');
  await load('core/index.js');

  // ---------------- 1. выражения ----------------
  section('Выражения:');
  const E = expr.evalExpr;
  ok(E('1 + 2 * 3') === 7 && E('(1 + 2) * 3') === 9 && E('10 % 4') === 2 && E('-2 * -3') === 6 && E('7 / 2') === 3.5, 'арифметика и приоритеты');
  ok(E('-p*100', { p: 0.25 }) === -25 && E('2 - -1') === 3 && E('.5 + 1e1') === 10.5, 'унарный минус, числа .5 и 1e1');
  ok(E('1 < 2') === 1 && E('2 <= 1') === 0 && E('1 == 1 && 2 != 3') === 1 && E('0 || 0') === 0 && E('!0') === 1 && E('!5') === 0, 'сравнения и логика дают 1/0');
  ok(E('min(3, 1, 2)') === 1 && E('max(1, 4)') === 4 && E('clamp(5, 0, 1)') === 1 && E('clamp(-1, 0, 1)') === 0, 'min / max / clamp');
  ok(E('abs(-2)') === 2 && E('round(2.5)') === 3 && E('floor(2.7)') === 2 && E('ceil(2.1)') === 3 && E('pow(2, 10)') === 1024 && E('sqrt(16)') === 4, 'abs round floor ceil pow sqrt');
  ok(Math.abs(E('db(6)') - 10 ** 0.3) < 1e-12 && E('db(0)') === 1, 'db(x) = 10^(x/20)');
  ok(E('w * 0.006', { w: 1920 }) === 1920 * 0.006, 'переменные');
  ok(expr.fillTemplate('g={x:2}:f={y}', { x: 1.005, y: 2 }) === `g=${(1.005).toFixed(2)}:f=2.000000`, 'шаблон: знаки и toFixed(6) по умолчанию');
  ok(expr.fillTemplate('plain') === 'plain' && expr.fillTemplate('{1+1:0}%') === '2%', 'шаблон: текст без выражений, :0');
  ok(expr.compileTemplate('{p}').single && expr.compileTemplate('{p}').num({ p: 0.123456789 }) === 0.123456789, 'шаблон из одного выражения — число без округления');
  ok(expr.compileExpr('a + b').vars.has('a') && expr.compileExpr('a + b').vars.has('b'), 'список переменных');
  ok(expr.compileExpr('1 + x') === expr.compileExpr('1 + x'), 'кэш разобранных выражений');
  for (const bad of ['constructor', '__proto__', 'x.constructor', 'p["a"]', "'a'", 'alert(1)', 'Math.max(1)', '1 +', '(1', '1)', '', 'a = 1',
    'this', '`x`', '1;2', 'x => x', 'eval("1")', 'toString', 'prototype', 'min()', 'clamp(1, 2)', '1 ? 2 : 3']) {
    throws(() => E(bad, { x: 1, p: 1, a: 1 }), null, `отказ: ${JSON.stringify(bad)}`);
  }
  throws(() => E('y', { x: 1 }), /y/, 'неизвестная переменная');
  throws(() => E('constructor', {}), /constructor/, 'constructor — запрещённое имя');
  throws(() => E('hasOwnProperty', { hasOwnProperty: 1 }), null, 'hasOwnProperty — запрещённое имя');
  throws(() => expr.fillTemplate('{1/0}'), null, 'бесконечность в шаблоне — ошибка');
  throws(() => expr.fillTemplate('{x'), null, 'незакрытая { в шаблоне');
  throws(() => expr.fillTemplate('x}'), null, 'лишняя } в шаблоне');
  throws(() => E('1'.repeat(600)), null, 'слишком длинное выражение');
  throws(() => E('('.repeat(60) + '1' + ')'.repeat(60)), null, 'слишком глубокая вложенность');
  ok(Object.prototype.polluted === undefined, 'прототип не тронут');

  // ---------------- 2. равенство со старой реализацией ----------------
  section('Встроенные описания = прежние строки:');
  ok(reg.CORE.id === 'core' && reg.CORE.filters === null && reg.API_VERSION === 1, 'CORE и API_VERSION');
  ok(fxm.EFFECTS === reg.EFFECTS && trm.TRANSITIONS === reg.TRANSITIONS && afm.AUDIO_FX === reg.AUDIO_FX, 'живые массивы — те же объекты');
  ok(fxm.EFFECTS.length === 8 && trm.TRANSITIONS.length === 20 && afm.AUDIO_FX.length === 3, `встроенных: эффектов ${fxm.EFFECTS.length}, переходов ${trm.TRANSITIONS.length}, аудио ${afm.AUDIO_FX.length}`);
  ok(OLD.effects.map((e) => e.id).join() === fxm.EFFECTS.map((e) => e.id).join(), 'порядок эффектов');
  ok(OLD.transitions.map((e) => e.id).join() === trm.TRANSITIONS.map((e) => e.id).join(), 'порядок переходов');
  const widths = [undefined, 0, 1, 100, 120, 640, 853.33, 1280, 1920, 2560, 3840];
  for (const o of OLD.effects) {
    const e = fxm.effectById(o.id);
    for (const w of widths) {
      ok(e.ff(w) === o.ff(w), `ff ${o.id} w=${w}: ${e.ff(w)} / ${o.ff(w)}`);
      ok(e.css(w) === o.css(w), `css ${o.id} w=${w}: ${e.css(w)} / ${o.css(w)}`);
    }
  }
  const oldFfEffects = (c, w) => { const l = (c.effects || []).filter((id) => OLD.effects.find((e) => e.id === id)).map((id) => OLD.effects.find((e) => e.id === id).ff(w)); return l.length ? `${l.join(',')},` : ''; };
  for (const effects of [[], ['bw'], ['blur', 'sepia', 'fade'], OLD.effects.map((e) => e.id), ['bw', 'nope', 'blur']]) {
    for (const w of [640, 1920, 3840]) ok(fxm.ffEffects({ effects }, w) === oldFfEffects({ effects }, w), `ffEffects ${effects.join('+')} w=${w}`);
  }
  ok(fxm.cssEffects({ effects: ['bw', 'blur'] }, 500, ['blur(3px)']) === `grayscale(1) blur(${(500 * 0.006).toFixed(2)}px) blur(3px)`, 'cssEffects с extra');

  const ps = [0, 0.001, 0.1, 0.123456789, 0.25, 1 / 3, 0.4999, 0.5, 0.5001, 0.6, 2 / 3, 0.75, 0.9, 0.999, 1];
  let zoomTol = 0;
  for (const o of OLD.transitions) {
    const tr = trm.TRANSITIONS.find((x) => x.id === o.id);
    ok(tr.xfadeArg === OLD.xfade(o.id), `xfade ${o.id}: ${tr.xfadeArg}`);
    for (const p of ps) {
      const a = tr.style(p); const b = o.style(p);
      // zoomin: scale() раньше печатался как есть (1.7199999999999998), теперь toFixed(6) — только CSS предпросмотра
      const exact = sameStyle(a, b);
      if (!exact && o.id === 'zoomin' && sameStyle(a, b, 1e-6)) { zoomTol++; continue; }
      ok(exact, `style ${o.id} p=${p}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
  if (zoomTol) console.log(`  (zoomin: ${zoomTol} кадров отличаются только округлением scale() до 6 знаков)`);
  for (const ty of ['fade', 'blinds', 'zoomin', 'unknown.plugin', undefined]) ok(plan.xfadeTransition(ty) === OLD.xfade(ty), `xfadeTransition(${ty})`);

  const afxCases = [];
  const vals = {
    eq: [{}, { low: 3 }, { mid: -2.5, midF: 440 }, { low: -15, mid: 15, midF: 5000, high: 7.5 }, { low: 0, mid: 0, high: 0 }, { low: 99, high: -99 }, { low: '2', mid: null, midF: 'x' }],
    comp: [{}, { threshold: 0, makeup: 12 }, { threshold: -60, ratio: 20, attack: 1, release: 1000, makeup: 24 }, { threshold: -100 }, { ratio: 1.5, attack: 7, release: 55, makeup: 0.5 }],
    denoise: [{}, { strength: 40, floor: -20 }, { strength: 3, floor: -80 }, { strength: 17 }],
  };
  for (const [type, list] of Object.entries(vals)) for (const p of list) afxCases.push([{ type, on: true, p }]);
  afxCases.push([{ type: 'eq', on: false, p: { low: 5 } }], [{ type: 'eq', p: { high: 2 } }, { type: 'comp', p: {} }, { type: 'denoise', p: {} }],
    [{ type: 'missing.fx', p: {} }, { type: 'comp', p: { makeup: 6 } }], [], null);
  for (const list of afxCases) {
    const a = afm.ffAudioFx(list); const b = OLD.ffAudioFx(list || []);
    ok(a === b, `ffAudioFx ${JSON.stringify(list)}: ${a} / ${b}`);
    const wa = afm.webAudioChain(list); const wb = OLD.webAudio(list || []);
    ok(JSON.stringify(wa) === JSON.stringify(wb), `Web Audio ${JSON.stringify(list)}: ${JSON.stringify(wa)} / ${JSON.stringify(wb)}`);
  }
  ok(afm.fxDef('eq').params.length === 4 && afm.fxDef('denoise').previewOnlyExport === true && !afm.fxDef('eq').previewOnlyExport && afm.fxDef('comp').hint, 'описания аудиоэффектов: параметры, hint, previewOnlyExport');
  ok(JSON.stringify(afm.newAudioFx('comp')) === JSON.stringify({ type: 'comp', on: true, p: { threshold: -18, ratio: 4, attack: 20, release: 250, makeup: 0 } }), 'newAudioFx');
  ok(afm.fxParam({ type: 'eq', p: { low: 40 } }, 'low') === 15 && afm.fxParam({ type: 'eq', p: {} }, 'midF') === 1000 && afm.fxParam({ type: 'eq', p: {} }, 'zzz') === 0, 'fxParam: границы и значения по умолчанию');

  // ---------------- 3. плагины ----------------
  section('Плагины:');
  const owner = { id: 'vignette', filters: new Set(['vignette']) };
  const changes = [];
  const off = reg.onRegistryChange((ev) => changes.push(ev));
  const vigDesc = {
    id: 'soft', name: { ru: 'Виньетка', en: 'Vignette' },
    params: [{ k: 'angle', name: { ru: 'Сила', en: 'Strength' }, min: 0.1, max: 1.5, step: 0.05, def: 0.6 }],
    ffmpeg: [{ filter: 'vignette', args: { angle: '{angle:4}' } }],
    css: 'brightness({1 - angle*0.1:3})',
  };
  const vid = reg.registerEffect(vigDesc, owner);
  ok(vid === 'vignette.soft' && fxm.effectById(vid) && fxm.EFFECTS.length === 9, `полный id ${vid}, эффект в живом массиве`);
  ok(fxm.effectById(vid).name === 'Виньетка', 'имя по языку (ru)');
  ok(changes.length === 1 && changes[0].kind === 'effect' && changes[0].id === vid && changes[0].action === 'register', 'onRegistryChange: register');
  const clip = { effects: ['bw', vid], fxp: { [vid]: { angle: 1.2 } } };
  ok(fxm.ffEffects(clip, 1920) === 'hue=s=0,vignette=angle=1.2000,', `ffEffects с плагином: ${fxm.ffEffects(clip, 1920)}`);
  ok(fxm.ffEffects({ effects: [vid] }, 1920) === 'vignette=angle=0.6000,', 'значение по умолчанию (def)');
  ok(fxm.ffEffects({ effects: [vid], fxp: { [vid]: { angle: 99 } } }, 1920) === 'vignette=angle=1.5000,', 'значение ограничено max');
  ok(fxm.cssEffects(clip, 640) === 'grayscale(1) brightness(0.880)', `css плагина: ${fxm.cssEffects(clip, 640)}`);
  ok(fxm.effectValues(clip, vid).angle === 1.2, 'effectValues');
  ok(reg.listEffects().some((e) => e.id === vid) && reg.listEffects() !== reg.EFFECTS, 'listEffects — копия');

  const base = (over) => ({ id: 'x', name: 'X', ffmpeg: [{ filter: 'vignette', args: { angle: '0.5' } }], ...over });
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'movie', args: { filename: 'a.mp4' } }] }), { id: 'evil', filters: new Set(['movie']) }), /movie/, 'отказ: movie');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'eq', args: { contrast: '2' } }] }), owner), /eq/, 'отказ: фильтр вне owner.filters');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'hue' }] }), { id: 'nofilters' }), /hue/, 'отказ: у плагина без ffmpeg.filters');
  for (const v of ["0.5'", '0.5;movie', '0.5[x]', '0.5,negate', '0.5"', '0.5\\', '0.5\nx', '0.5:filename=a']) {
    throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: { angle: v } }] }), owner), null, `отказ: значение ${JSON.stringify(v)}`);
  }
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: ['filename=x'] }] }), owner), /filename/, 'отказ: позиционное filename=…');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: { filename: 'x' } }] }), owner), /filename/, 'отказ: ключ filename');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: { 'a-b': '1' } }] }), owner), null, 'отказ: ключ не идентификатор');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: { angle: '{constructor}' } }] }), owner), /constructor/, 'отказ: constructor в шаблоне');
  throws(() => reg.registerEffect(base({ ffmpeg: [{ filter: 'vignette', args: { angle: '{zzz}' } }] }), owner), /zzz/, 'отказ: неизвестная переменная в шаблоне');
  throws(() => reg.registerEffect(base({ css: 'url(http://evil/x.svg#f)' }), owner), null, 'отказ: url() в CSS');
  throws(() => reg.registerEffect(base({ id: '../x' }), owner), null, 'отказ: неверный id');
  throws(() => reg.registerEffect(base({ name: '' }), owner), null, 'отказ: нет названия');
  throws(() => reg.registerEffect(base({ params: [{ k: 'w', min: 0, max: 1 }] }), owner), null, 'отказ: параметр w занят');
  throws(() => reg.registerEffect(base({ params: [{ k: 'a', min: 1, max: 0 }] }), owner), null, 'отказ: min > max');
  throws(() => reg.registerEffect(base({ ffmpeg: [] }), owner), null, 'отказ: пустой список фильтров');
  throws(() => reg.registerEffect(base(), { id: 'core', filters: null }), null, 'отказ: чужой «core»');
  throws(() => reg.registerEffect(base(), { id: 'Bad Id' }), null, 'отказ: неверный id плагина');
  let err = null;
  try { reg.registerEffect(base({ ffmpeg: [{ filter: 'movie' }] }), owner); } catch (e) { err = e; }
  ok(err && err.pluginId === 'vignette' && err.kind === 'effect' && err.descId === 'x' && /vignette\.x/.test(err.message), `ошибка: ${err && err.message}`);
  ok(fxm.EFFECTS.length === 9, 'неудачные регистрации ничего не добавили');
  // повторная регистрация тем же плагином заменяет описание
  reg.registerEffect({ ...vigDesc, name: 'Виньетка 2' }, owner);
  ok(fxm.EFFECTS.length === 9 && fxm.effectById(vid).name === 'Виньетка 2', 'повторная регистрация заменяет');
  ok(reg.registerEffect({ ...vigDesc, name: 'Чужая' }, { id: 'other', filters: new Set(['vignette']) }) === 'other.soft', 'другой плагин получает свой id (other.soft)');
  reg.unregisterPlugin('other');

  // переход и аудиоэффект плагина
  const tid = reg.registerTransition({ id: 'diag', name: 'Диагональ', xfade: 'diagtl', preview: { b: { opacity: '{p}', clipPath: 'inset(0 0 0 {(1-p)*100:1}%)' } } }, owner);
  ok(tid === 'vignette.diag' && plan.xfadeTransition(tid) === 'transition=diagtl' && JSON.stringify(trm.transitionById(tid).style(0.25)) === '{"b":{"opacity":0.25,"clipPath":"inset(0 0 0 75.0%)"}}', 'переход плагина');
  const t2 = reg.registerTransition({ id: 'stripes', name: 'Полосы', xfade: { expr: 'if(lt(mod(Y,H/8),P*H/8),A,B)' } }, owner);
  ok(plan.xfadeTransition(t2) === "transition=custom:expr='if(lt(mod(Y,H/8),P*H/8),A,B)'" && trm.transitionById(t2).style(0.3).b.opacity === 0.3, 'переход с xfade.expr и предпросмотром по умолчанию');
  throws(() => reg.registerTransition({ id: 'bad', name: 'B', xfade: { expr: "if(1,A,B)';movie=x" } }, owner), null, 'отказ: кавычка в xfade.expr');
  throws(() => reg.registerTransition({ id: 'bad', name: 'B', xfade: 'nosuch' }, owner), null, 'отказ: неизвестный xfade');
  throws(() => reg.registerTransition({ id: 'bad', name: 'B', xfade: 'fade', preview: { b: { background: 'red' } } }, owner), null, 'отказ: неизвестное поле стиля');
  throws(() => reg.registerTransition({ id: 'bad', name: 'B', xfade: 'fade', preview: { b: { mask: 'url(x.png)' } } }, owner), null, 'отказ: url() в маске');
  const ownerA = { id: 'echo', filters: ['aecho', 'movie'] };
  const aid = reg.registerAudioEffect({
    id: 'echo', name: 'Эхо', params: [{ k: 'delay', name: 'Задержка', min: 10, max: 1000, step: 10, def: 200 }],
    ffmpeg: [{ filter: 'aecho', args: ['0.8', '0.7', '{delay:0}', '0.4'] }],
    webaudio: [{ node: 'gain', gain: 1 }, { node: 'biquad', type: 'lowpass', frequency: '{delay*10}', when: 'delay > 500' }],
  }, ownerA);
  ok(afm.ffAudioFx([{ type: aid, p: { delay: 300 } }]) === ',aecho=0.8:0.7:300:0.4', `аудиоэффект плагина: ${afm.ffAudioFx([{ type: aid, p: { delay: 300 } }])}`);
  ok(JSON.stringify(afm.webAudioChain([{ type: aid, p: { delay: 600 } }])) === '[{"node":"gain","gain":1},{"node":"biquad","type":"lowpass","frequency":6000}]', 'webaudio плагина с when');
  throws(() => reg.registerAudioEffect({ id: 'x', name: 'X', ffmpeg: [{ filter: 'aecho' }], webaudio: [{ node: 'script' }] }, ownerA), null, 'отказ: неизвестный узел Web Audio');
  const pid = reg.registerExportPreset({ id: 'sq', name: 'Квадрат', width: 1080, height: 1080, fps: 30, codec: 'h264', quality: 'medium' }, owner);
  ok(pid === 'vignette.sq' && reg.listExportPresets().some((p) => p.id === pid), 'пресет экспорта плагина');
  throws(() => reg.registerExportPreset({ id: 'odd', name: 'O', width: 1081, height: 1080, fps: 30 }, owner), null, 'отказ: нечётная ширина');
  throws(() => reg.registerExportPreset({ id: 'c', name: 'C', width: 1080, height: 1080, fps: 30, codec: 'prores' }, owner), null, 'отказ: неизвестный кодек');
  ok(reg.listExportPresets().filter((p) => p.plugin === 'core').length === 3, 'встроенные пресеты экспорта');

  // missingIds и предупреждения экспорта
  const project = {
    media: { m: { path: 'C:/x.mp4', hasVideo: true, hasAudio: true, width: 1920, height: 1080, duration: 10 } },
    videoClips: [
      { mediaId: 'm', in: 0, out: 2, start: 0, volume: 1, effects: ['bw', vid, 'gone.fx'], afx: [{ type: 'gone.eq', p: {} }] },
      { mediaId: 'm', in: 0, out: 2, start: 2, volume: 1, transition: { type: 'gone.wipe', duration: 1 } },
    ],
    audioTracks: [{ afx: [{ type: aid, p: {} }, { type: 'gone.reverb', p: {} }], clips: [{ mediaId: 'm', in: 0, out: 1, start: 0, volume: 1, afx: [{ type: 'eq', p: {} }] }] }],
    episodes: [{ id: 'e2', videoClips: [{ mediaId: 'm', in: 0, out: 1, start: 0, effects: ['gone.ep'] }], audioTracks: [] }],
  };
  const m1 = reg.missingIds(project);
  ok(JSON.stringify(m1) === JSON.stringify({ effects: ['gone.fx', 'gone.ep'], transitions: ['gone.wipe'], audioEffects: ['gone.eq', 'gone.reverb'] }), `missingIds: ${JSON.stringify(m1)}`);
  const b1 = plan.buildExport(project, { width: 640, height: 360, fps: 30 });
  ok(/xfade=transition=fade:/.test(b1.filter) && b1.filter.includes('hue=s=0,vignette=angle=0.6000,') && b1.filter.includes('aecho=0.8:0.7:200:0.4') && !b1.filter.includes('gone'), 'экспорт: неизвестное пропущено, переход — растворение');
  ok(b1.warnings.length === 4 && b1.warnings.some((w) => w.includes('gone.wipe')) && b1.warnings.some((w) => w.includes('gone.fx')) && b1.warnings.some((w) => w.includes('gone.eq')) && b1.warnings.some((w) => w.includes('gone.reverb')), `предупреждения: ${JSON.stringify(b1.warnings)}`);
  ok(JSON.stringify(project.videoClips[0].effects) === JSON.stringify(['bw', vid, 'gone.fx']), 'данные проекта не тронуты');

  // unregisterPlugin
  changes.length = 0;
  const removed = reg.unregisterPlugin('vignette');
  ok(removed === 4 && !fxm.effectById(vid) && fxm.EFFECTS.length === 8 && trm.TRANSITIONS.length === 20 && !reg.listExportPresets().some((p) => p.id === pid), `unregisterPlugin убрал ${removed}`);
  ok(changes.length === 4 && changes.every((c) => c.action === 'unregister' && c.plugin === 'vignette'), 'onRegistryChange: unregister');
  ok(reg.unregisterPlugin('core') === 0 && fxm.EFFECTS.length === 8, 'core не выгружается');
  const m2 = reg.missingIds(project);
  ok(m2.effects.includes(vid) && m2.transitions.length === 1, 'после выгрузки эффект плагина — в missingIds');
  ok(fxm.ffEffects(project.videoClips[0], 1920) === 'hue=s=0,', 'после выгрузки эффект плагина пропускается');
  off();
  reg.unregisterPlugin('echo');
  reg.registerEffect({ id: 'z', name: 'Z', ffmpeg: [{ filter: 'vignette' }] }, owner);
  ok(changes.length === 4, 'после отписки события не приходят');
  reg.unregisterPlugin('vignette');

  // store.fixup: неизвестный переход не удаляется (если store.js грузится без окна)
  try {
    const st = await load('store.js');
    const p = { videoClips: [{ id: 'a', mediaId: 'm', in: 0, out: 2, start: 0 }, { id: 'b', mediaId: 'm', in: 0, out: 2, start: 2, transition: { type: 'gone.wipe', duration: 1 } }], audioTracks: [{ id: 't', clips: [] }] };
    st.fixup(p);
    ok(p.videoClips[1].transition && p.videoClips[1].transition.type === 'gone.wipe', 'store.fixup сохраняет переход неизвестного типа');
  } catch (e) {
    console.log(`  (store.js в Node не загрузился — пропуск: ${e.message.split('\n')[0]})`);
  }

  console.log(`\nпроверок: ${passed + failed}, провалов: ${failed}`);
  if (failed) process.exit(1);
  console.log('ВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
