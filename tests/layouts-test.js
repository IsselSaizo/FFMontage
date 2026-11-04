'use strict';
// M4.6: плагин «Раскладки кадра» (examples/plugins/layouts/layouts.js) — план вызовов set_transform
// по ответу get_project. Запуск: node tests/layouts-test.js
const path = require('path');
const { pathToFileURL } = require('url');

let fails = 0; let n = 0;
const ok = (c, msg) => { n++; if (!c) fails++; console.log(`${c ? '  ok ' : '  FAIL'} ${msg}`); };
const near = (a, b) => Math.abs(a - b) < 1e-3;

(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '..', 'examples', 'plugins', 'layouts', 'layouts.js')).href);
  const clip = (id, start, end) => ({ id, start, end });
  const proj = (upper, t = 2, main = [clip('m1', 0, 10)]) => ({ playhead: t, video_track: { clips: main }, upper_video_tracks: upper });
  const up = (id, clips, extra = {}) => ({ id, clips, ...extra });

  let p = L.planLayout(proj([up('vtk_a', [clip('a1', 1, 5)])]), 'pip-tr');
  ok(p.calls.length === 2 && p.calls[0].clip_id === 'm1' && p.calls[0].reset && p.calls[0].scale === undefined, 'PiP: нижний клип — сброс на весь кадр');
  ok(p.calls[1].clip_id === 'a1' && near(p.calls[1].scale, 0.3) && p.calls[1].x > 0.3 && p.calls[1].y < -0.3, `PiP ↗: ${JSON.stringify(p.calls[1])}`);
  const pip = p.calls[1];
  ok(near(0.5 + pip.x + pip.scale / 2, 0.97) && near(0.5 + pip.y - pip.scale / 2, 0.03), 'PiP ↗: поле 3% от правого и верхнего края');

  // Три дорожки: PiP берёт самую верхнюю, средняя не трогается
  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)]), up('vtk_b', [clip('b1', 0, 5)])]), 'pip-bl');
  ok(p.calls.map((c) => c.clip_id).join() === 'm1,b1' && p.calls[1].x < 0 && p.calls[1].y > 0, 'PiP ↙ с тремя дорожками: верхний клип в угол');

  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)]), up('vtk_b', [clip('b1', 0, 5)]), up('vtk_c', [clip('c1', 0, 5)])]), 'grid');
  ok(p.calls.length === 4 && p.calls.every((c) => near(c.scale, 0.5) && near(Math.abs(c.x), 0.25) && near(Math.abs(c.y), 0.25)), 'сетка 2×2: четыре четверти');
  ok(new Set(p.calls.map((c) => `${c.x},${c.y}`)).size === 4, 'сетка 2×2: все четверти разные');

  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)]), up('vtk_b', [clip('b1', 0, 5)])]), 'one-two');
  const [big, s1, s2] = p.calls;
  ok(near(big.scale, 2 / 3) && near(0.5 + big.x - big.scale / 2, 0) && near(0.5 + s1.x + s1.scale / 2, 1) && near(s1.y + s1.scale / 2, s2.y - s2.scale / 2), '«один большой и два»: большой слева, два маленьких столбиком справа встык');

  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)])]), 'side');
  ok(p.calls.length === 2 && near(p.calls[0].x, -0.25) && near(p.calls[1].x, 0.25), 'два рядом');

  ok(L.planLayout(proj([]), 'pip-tr').error === 'need-more', 'один клип — нужна вторая дорожка');
  ok(L.planLayout(proj([], 20), 'grid').error === 'nothing', 'пусто под курсором');
  ok(L.planLayout(proj([up('vtk_a', [clip('a1', 3, 5)])]), 'pip-tr').error === 'need-more', 'клип верхней дорожки ещё не начался');
  ok(L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)], { hidden: true })]), 'side').error === 'need-more', 'скрытая дорожка не считается');
  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)], { locked: true })]), 'side');
  ok(p.calls.length === 1 && p.skipped === 1, 'дорожка с замком пропускается');
  p = L.planLayout(proj([up('vtk_a', [clip('a1', 0, 5)])]), 'reset');
  ok(p.calls.length === 2 && p.calls.every((c) => c.reset && c.scale === undefined), 'сброс раскладки');
  ok(L.planLayout(proj([]), 'nope').error === 'unknown-layout', 'неизвестная раскладка');

  console.log(`\nпроверок: ${n}, провалов: ${fails}`);
  console.log(fails ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ОК');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
