'use strict';
// Отчёты об ошибках (src-tauri/src/crashlog.rs): паника пишет файл <logs>/reports/*-panic.txt с версией, ОС и стеком;
// неудачный экспорт — *-export-failed.txt с командой FFmpeg. Запуск: node tests/crashlog-test.js (нужна release-сборка).
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

(async () => {
  await E.ready;
  const before = await E.engine('reports');
  ok(typeof before.dir === 'string' && /reports$/.test(before.dir), `папка отчётов: ${before.dir}`);
  const names0 = new Set(fs.existsSync(before.dir) ? fs.readdirSync(before.dir) : []);

  const after = await E.engine('crash-test');
  const fresh = fs.readdirSync(after.dir).filter((n) => !names0.has(n));
  const panic = fresh.find((n) => /-panic\.txt$/.test(n));
  ok(!!panic, `паника → отчёт (${panic || fresh.join(', ') || 'нет новых'})`);
  if (panic) {
    const text = fs.readFileSync(path.join(after.dir, panic), 'utf8');
    ok(/^FF Montage \d+\.\d+\.\d+(-hotfix\.[1-9]\d*)? \(/.test(text), 'в отчёте версия и ОС');
    ok(text.includes('crash-test: intentional panic'), 'в отчёте текст паники');
    ok(/thread: crash-test/.test(text), 'в отчёте имя потока');
    ok(/Kind: panic/.test(text), 'в отчёте вид');
  }
  ok(after.total >= 1 && after.fresh.some((x) => x.kind === 'panic'), 'список: новый отчёт panic');

  // Неудачный экспорт: FFmpeg получает несуществующий кодировщик параметра → код ошибки, отчёт с командой
  const names1 = new Set(fs.readdirSync(after.dir));
  const dirOut = E.paths().output_dir;
  fs.mkdirSync(dirOut, { recursive: true });
  const src = path.join(dirOut, 'crashlog-src.mp4');
  await E.run(E.findBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.3', '-c:v', 'libx264', src]);
  const plan = {
    // Граф без выхода [vout] (проверку плана проходит, FFmpeg падает: «Output with label 'vout' does not exist»)
    args: ['-y', '-hide_banner', '-i', src, '-/filter_complex', '@@FILTER@@', '-map', '[vout]', '-c:v', 'libx264', '-f', 'mp4', '@@OUT@@'],
    filter: '[0:v]null[vx]', duration: 0.3, output: path.join(dirOut, 'crashlog-fail.mp4'),
  };
  let failed = false;
  try { await E.engine('export', { plan }); } catch (e) { failed = !/отклон|rejected/i.test(e.message); if (!failed) console.log(`skip план отклонён: ${e.message}`); }
  const ex = fs.readdirSync(after.dir).filter((n) => !names1.has(n)).find((n) => /-export-failed\.txt$/.test(n));
  if (failed) {
    ok(!!ex, `ошибка экспорта → отчёт (${ex || 'нет'})`);
    if (ex) ok(fs.readFileSync(path.join(after.dir, ex), 'utf8').includes('ffmpeg '), 'в отчёте экспорта — команда FFmpeg');
  } else {
    console.log('skip план экспорта не упал/не прошёл проверку — пропуск проверки export-failed');
  }

  console.log(fails ? `\nОШИБОК: ${fails}` : '\nвсе проверки прошли');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
