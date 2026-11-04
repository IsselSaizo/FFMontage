'use strict';
// M1.7: экранирование для графа фильтров FFmpeg (src/renderer/js/core/ffEscape.js).
//   1) обратный разбор (как av_get_token: граф, потом опция) возвращает исходную строку;
//   2) настоящий FFmpeg открывает файл с «:», «'», «%», «,», «[», «]», «;» в пути через movie= в графе
//      и рисует drawtext с таким же текстом (шрифт — тоже через ffPath).
// Запуск: node tests/ffescape-test.js
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ff = require('./engine');

let fails = 0; let n = 0;
const ok = (c, msg) => { n++; if (!c) fails++; console.log(`${c ? '  ok ' : '  FAIL'} ${msg}`); };

(async () => {
  const E = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'core', 'ffEscape.js')).href);
  // Значение опции в графе → как его увидит фильтр: граф-уровень до «[],;», затем опция до «:»
  const roundTrip = (escaped) => {
    const g = E.unescapeToken(escaped, '[],;');
    const o = E.unescapeToken(g.value, ':');
    return { value: o.value, restGraph: g.rest, restOpt: o.rest };
  };
  console.log('Обратный разбор:');
  const samples = [
    "C:\\Users\\Иван\\It's a [test], 50%; v2:final.png",
    "D:/a'b'c/x:y\\z.mov", "\\\\server\\share\\[1];2.mp4", 'простой текст', "50% off: it's {cool}, [ok]; done\\",
    "'''", ':::', '\\\\\\', '[]]],,;;',
  ];
  for (const s of samples) {
    const r = roundTrip(E.ffValue(s));
    ok(r.value === s && !r.restGraph && !r.restOpt, `ffValue ${JSON.stringify(s)}`);
  }
  for (const s of samples.slice(0, 3)) {
    const r = roundTrip(E.ffPath(s));
    const want = s.replace(/\\/g, '/');
    ok(r.value === want, `ffPath ${JSON.stringify(s)} → ${JSON.stringify(r.value)}`);
  }
  // Тот же вектор проверяет Rust (src-tauri/src/plancheck.rs, тест ffescape_vectors)
  const vec = E.ffValue("C:/a'b/[x],y;z\\w.png");
  ok(vec === "C\\\\:/a\\\\\\'b/\\[x\\]\\,y\\;z\\\\\\\\w.png", `вектор для Rust: ${vec}`);
  ok(E.ffPath('\\\\?\\C:\\x\\y.png') === 'C\\\\:/x/y.png', `ffPath снимает \\\\?\\: ${E.ffPath('\\\\?\\C:\\x\\y.png')}`);
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(throws(() => E.ffPath('rel/x.png')) && throws(() => E.ffPath('')) && throws(() => E.ffPath('C:/a\nb.png')), 'ffPath: относительный, пустой и с переводом строки — ошибка');
  // drawtext: текст проходит три уровня — граф, опция, сам drawtext (\ и %)
  const txt = "Цена: 50% [скидка], it's; C:\\";
  const r3 = roundTrip(E.ffText(txt));
  ok(r3.value === txt.replace(/[\\%]/g, (c) => `\\${c}`), 'ffText: после графа и опции остаётся уровень drawtext (\\ и %)');

  console.log('Настоящий FFmpeg:');
  await ff.ready;
  const bin = ff.findBinaries().ffmpeg;
  const dir = path.join(__dirname, '..', '.test-cache', 'tmp', "esc it's [a],b;c 50%");
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, "кадр: [1], it's; 50%.png");
  await ff.run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', png]);
  ok(fs.existsSync(png), `тестовый файл: ${png}`);
  // movie= в -filter_complex: граф разбирает FFmpeg, путь — значение опции
  const graph = `movie=${E.ffPath(png)},scale=32:18,format=rgb24[v]`;
  let res = await ff.run(bin, ['-hide_banner', '-loglevel', 'error', '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { binaryStdout: true }).catch((e) => ({ error: e }));
  const px = res.stdout && Buffer.isBuffer(res.stdout) ? [...res.stdout.slice(0, 3)] : null;
  ok(!res.error && px && px[0] > 200 && px[1] < 40 && px[2] < 40, `movie=ffPath(...) читает файл (пиксель ${px})`);
  // drawtext: и шрифт (путь с «C:»), и текст со спецсимволами
  const font = ['C:\\Windows\\Fonts\\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
  if (font) {
    const g2 = `color=c=black:s=320x60,drawtext=fontfile=${E.ffPath(font)}:text=${E.ffText(txt)}:fontcolor=white:fontsize=20:x=4:y=20,format=gray[v]`;
    res = await ff.run(bin, ['-hide_banner', '-loglevel', 'error', '-filter_complex', g2, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { binaryStdout: true }).catch((e) => ({ error: e }));
    const lit = res.stdout && Buffer.isBuffer(res.stdout) ? [...res.stdout].filter((x) => x > 128).length : 0;
    ok(!res.error && lit > 200, `drawtext: шрифт через ffPath и текст через ffText (${lit} светлых пикселей)${res.error ? ' ' + String(res.error.message || res.error).slice(0, 200) : ''}`);
  } else {
    console.log('  (нет шрифта для drawtext — пропуск)');
  }

  console.log(`\nпроверок: ${n}, провалов: ${fails}`);
  console.log(fails ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ОК');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
