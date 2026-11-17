'use strict';
// Оформление фрагментов текста (textModel.js runs: цвет, жирный, курсив выделенного):
//   cleanRuns / applyRun / remapRuns / selectionStyle / runStyle, раскладка textRender.layoutText с фрагментами
//   (холст — заглушка: ширина = число символов × размер × множитель начертания) и рисование кусками.
// Запуск: node tests/textruns-test.js
const path = require('path');
const { pathToFileURL } = require('url');

let fails = 0; let n = 0;
const ok = (c, msg) => { n++; if (!c) fails++; console.log(`${c ? '  ok ' : '  FAIL'} ${msg}`); };
const J = (x) => JSON.stringify(x);
const ROOT = path.join(__dirname, '..');
const mod = (p) => import(pathToFileURL(path.join(ROOT, 'src/renderer/js', p)).href);

// Заглушка холста: font «[italic ]<weight> <px>px …»; жирный (≥700) шире в 1.25 раза, курсив — в 1.1
const drawn = [];
class Ctx {
  constructor() { this.font = '400 10px x'; this.fillStyle = '#000'; this.canvas = { height: 100 }; }
  measureText(s) {
    const m = /(italic )?(\d+) ([\d.]+)px/.exec(this.font);
    const k = (Number(m[2]) >= 700 ? 1.25 : 1) * (m[1] ? 1.1 : 1);
    return { width: [...s].length * Number(m[3]) * k, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 };
  }
  fillText(s, x, y) { drawn.push({ s, x: Math.round(x * 100) / 100, y, font: this.font, color: this.fillStyle }); }
  strokeText() {} save() {} restore() {} translate() {} rotate() {} scale() {} beginPath() {} rect() {} fill() {} roundRect() {}
}
globalThis.OffscreenCanvas = class { constructor() {} getContext() { return new Ctx(); } };

(async () => {
  const tm = await mod('textModel.js');
  const tr = await mod('textRender.js');
  const { cleanRuns, applyRun, remapRuns, selectionStyle, runStyle, cleanText, textDiff } = tm;

  console.log('cleanRuns');
  ok(J(cleanRuns(null, 'abc')) === '[]' && J(cleanRuns([], 'abc')) === '[]', 'пусто');
  ok(J(cleanRuns([{ a: 0, b: 2, color: '#FF0000' }, { a: 2, b: 3, color: '#ff0000' }], 'abc')) === J([{ a: 0, b: 3, color: '#ff0000' }]), 'соседние одинаковые слиты, цвет в нижнем регистре');
  ok(J(cleanRuns([{ a: 0, b: 10, bold: true }, { a: 1, b: 2, color: '#00ff00' }], 'abcd')) === J([{ a: 0, b: 1, bold: true }, { a: 1, b: 2, color: '#00ff00', bold: true }, { a: 2, b: 4, bold: true }]), 'наложение: позже — главнее, конец обрезан по длине');
  ok(J(cleanRuns([{ a: 2, b: 1, bold: true }, { a: 0, b: 2 }, { a: 0, b: 2, color: 'red' }, 5], 'abc')) === '[]', 'пустые, без полей, неверный цвет — выброшены');
  ok(J(cleanText({ content: 'ab', runs: [{ a: 0, b: 9, italic: true }] }).runs) === J([{ a: 0, b: 2, italic: true }]), 'cleanText чистит runs по content');
  ok(!('runs' in textDiff({ content: 'x' })) && J(textDiff({ content: 'xy', runs: [{ a: 0, b: 1, bold: true }] }).runs) === J([{ a: 0, b: 1, bold: true }]), 'textDiff: runs только если есть');

  console.log('applyRun');
  const s = 'FREE ASSET PACK';
  let r = applyRun([], s, 0, 4, { color: '#ffcc00' });
  ok(J(r) === J([{ a: 0, b: 4, color: '#ffcc00' }]), 'цвет слова');
  r = applyRun(r, s, 2, 10, { bold: true });
  ok(J(r) === J([{ a: 0, b: 2, color: '#ffcc00' }, { a: 2, b: 4, color: '#ffcc00', bold: true }, { a: 4, b: 10, bold: true }]), 'жирный поверх части цветного');
  r = applyRun(r, s, 0, 15, { color: null });
  ok(J(r) === J([{ a: 2, b: 10, bold: true }]), 'снять цвет (null) у всего');
  r = applyRun(r, s, 5, 7, {}, { clear: true });
  ok(J(r) === J([{ a: 2, b: 5, bold: true }, { a: 7, b: 10, bold: true }]), 'clear — середина фрагмента');

  console.log('remapRuns');
  const w = [{ a: 5, b: 10, color: '#ff0000' }]; // ASSET
  ok(J(remapRuns(w, s, 'MY ' + s)) === J([{ a: 8, b: 13, color: '#ff0000' }]), 'вставка до — сдвиг');
  ok(J(remapRuns(w, s, s + '!')) === J(w), 'вставка после текста — без изменений');
  ok(J(remapRuns(w, s, 'FREE ASSETS PACK')) === J([{ a: 5, b: 11, color: '#ff0000' }]), 'набор сразу после слова продолжает его');
  ok(J(remapRuns(w, s, 'FREE XASSET PACK')) === J([{ a: 6, b: 11, color: '#ff0000' }]), 'набор прямо перед словом — не его');
  ok(J(remapRuns(w, s, 'FREE ASET PACK')) === J([{ a: 5, b: 9, color: '#ff0000' }]), 'удаление внутри — укоротился');
  ok(J(remapRuns(w, s, 'FREE PACK')) === '[]', 'слово удалено целиком — фрагмента нет');
  ok(J(remapRuns(w, s, 'FREE ASSET')) === J(w), 'удалено после слова');

  console.log('selectionStyle / runStyle');
  const tx = cleanText({ content: s, weight: 400, color: '#ffffff', runs: [{ a: 0, b: 4, bold: true, color: '#ffcc00' }] });
  ok(J(selectionStyle(tx, 0, 4)) === J({ color: '#ffcc00', bold: true, italic: false }), 'выделение внутри жирного');
  ok(selectionStyle(tx, 0, 6).bold === false, 'частично жирное — не жирное');
  ok(J(runStyle(tx, tx.runs[0])) === J({ color: '#ffcc00', weight: 700, italic: false }) && runStyle(cleanText({ weight: 700 }), { bold: true }).weight === 900 &&
    runStyle(cleanText({ weight: 800 }), { bold: false }).weight === 400 && runStyle(tx, null).weight === 400, 'runStyle: вес жирного/обычного');

  console.log('layoutText / drawText');
  const W = 1000; const H = 100; // px = size × H = 10
  const base = { kind: 'text', in: 0, out: 3, text: { content: 'ab cd', size: 0.1, weight: 400, wrap: 0, letterSpacing: 0 } };
  const L0 = tr.layoutText(base, W, H);
  ok(L0.lines.length === 1 && L0.lines[0].w === 50 && L0.lines[0].segs.length === 1 && L0.lines[0].segs[0].st === null, 'без фрагментов — одна строка одним куском');
  const L1 = tr.layoutText({ ...base, text: { ...base.text, runs: [{ a: 0, b: 2, bold: true }] } }, W, H);
  ok(L1.lines[0].w === 25 + 30 && L1.lines[0].segs.length === 2 && L1.lines[0].segs[0].st.weight === 700, `жирное слово шире: ${L1.lines[0].w}`);
  // Перенос считает ширину с начертаниями: строка 60 px, «ab cd» обычным = 50 (влезает), с жирным ab = 55 → тоже; с жирным всем = 62.5 → перенос
  const wrap = (runs) => tr.layoutText({ ...base, text: { ...base.text, wrap: 0.06, runs } }, W, H).lines.map((l) => l.text);
  ok(J(wrap([])) === J(['ab cd']) && J(wrap([{ a: 0, b: 5, bold: true }])) === J(['ab', 'cd']), 'перенос учитывает жирные фрагменты');
  const L2 = tr.layoutText({ ...base, text: { ...base.text, content: 'ab\ncd ef', wrap: 0, runs: [{ a: 4, b: 7, color: '#ff0000' }] } }, W, H);
  ok(J(L2.lines.map((l) => [l.a, l.b])) === J([[0, 2], [3, 8]]) && J(L2.lines[1].segs.map((x) => [x.a, x.b, x.st && x.st.color])) === J([[3, 4, null], [4, 7, '#ff0000'], [7, 8, null]]), 'места строк и куски по фрагментам');
  drawn.length = 0;
  const cv = new OffscreenCanvas(W, H).getContext('2d');
  tr.drawText(cv, { ...base, text: { ...base.text, color: '#ffffff', runs: [{ a: 0, b: 2, bold: true, color: '#ffcc00' }] } }, W, H);
  ok(drawn.length === 2 && drawn[0].s === 'ab' && drawn[0].color === '#ffcc00' && /^700 /.test(drawn[0].font) && drawn[1].s === ' cd' && drawn[1].color === '#ffffff' && /^400 /.test(drawn[1].font) && drawn[1].x === drawn[0].x + 25,
    `рисование кусками: ${J(drawn)}`);
  drawn.length = 0;
  tr.drawText(cv, base, W, H);
  ok(drawn.length === 1 && drawn[0].s === 'ab cd', 'без фрагментов — одна строка одним fillText (как раньше)');

  console.log(fails ? `\nFAIL: ${fails} из ${n}` : `\nOK: ${n} проверок`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
