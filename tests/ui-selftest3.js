// Тест 3 (обновление 0.2): контекстное меню, магнит, пустоты, переходы, затухания, реверс, стоп-кадр, копирование.
// Запускается внутри окна через FFM_SELFTEST; файлы делает tests/engine-test.js (в том же кэше).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const ptr = (type, x, y, target = window, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, ...extra }));
  const clipEl = (id) => document.querySelector(`.clip[data-id="${id}"]`);
  const end = (c) => c.start + c.out - c.in;
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const key = (code, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key: opts.key || code, bubbles: true, ...opts }));
  const drag = async (el, fromX, y, toX, steps = 8, extra = {}) => {
    ptr('pointerdown', fromX, y, el, extra);
    for (let k = 1; k <= steps; k++) { ptr('pointermove', fromX + (toX - fromX) * k / steps, y, window, extra); await sleep(16); }
    ptr('pointerup', toX, y, window, extra);
    await sleep(120);
  };

  // --- подготовка ---
  const [a, b, c] = await importPaths([dir + 'a_av1_1440p60.mp4', dir + 'b_h264_1080p30.mp4', dir + 'c_music.mp3']);
  timeline.addMedia(a); timeline.addMedia(b);
  store.addAudioClip(c, 0);
  for (let i = 0; i < 80 && !(store.runtime[a]?.thumbs && store.runtime[b]?.thumbs); i++) await sleep(100);
  timeline.autoFit = true; timeline.fit();
  await sleep(200);
  let v = vids();
  ok(v.length === 2 && Math.abs(v[1].start - 10) < 1e-6, `два клипа встык: ${v.map((x) => `${x.start}-${end(x)}`).join(', ')}`);

  // --- контекстное меню ---
  store.setTime(13);
  const rb = clipEl(v[1].id).getBoundingClientRect();
  clipEl(v[1].id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rb.x + 40, clientY: rb.y + 30, button: 2 }));
  await sleep(100);
  const items = [...document.querySelectorAll('.ctx-menu .ctx-item')].map((x) => x.querySelector('.ctx-label').textContent);
  ok(items.includes('Создать стоп-кадр') && items.includes('Отзеркалить (задом наперёд)') && items.includes('Дублировать'), `меню видео: ${items.join(' | ')}`);
  await window.api.testShot('ctx-video');
  document.querySelector('.ctx-menu [data-action="split"]').click();
  await sleep(100);
  v = vids();
  ok(v.length === 3 && Math.abs(v[2].start - 13) < 1e-6, `«Разделить» из меню: ${v.length} клипа, третий с ${v[2].start}`);
  // меню аудио — без стоп-кадра
  const mc = store.project.audioTracks[0].clips[0];
  const ra = clipEl(mc.id).getBoundingClientRect();
  clipEl(mc.id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ra.x + 40, clientY: ra.y + 20, button: 2 }));
  await sleep(80);
  const aitems = [...document.querySelectorAll('.ctx-menu .ctx-item')].map((x) => x.querySelector('.ctx-label').textContent);
  ok(!aitems.includes('Создать стоп-кадр') && aitems.includes('Отзеркалить (задом наперёд)'), `меню аудио: ${aitems.join(' | ')}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  await sleep(50);
  ok(!document.querySelector('.ctx-menu'), 'Esc закрывает меню');

  // --- обрезка оставляет пустоту, корзина её убирает ---
  v = vids();
  let hd = clipEl(v[0].id).querySelector('.handle.r').getBoundingClientRect();
  await drag(clipEl(v[0].id).querySelector('.handle.r'), hd.x + 4, hd.y + 30, hd.x + 4 - 2 * timeline.pps);
  v = vids();
  ok(v[1].start - end(v[0]) > 1.5, `после обрезки пустота ${(v[1].start - end(v[0])).toFixed(2)} с`);
  const gapBtn = document.querySelector('.video-lane .tl-gap .gap-del');
  ok(!!gapBtn, 'на пустоте есть корзина');
  await window.api.testShot('gap');
  gapBtn && gapBtn.click();
  await sleep(80);
  v = vids();
  ok(Math.abs(v[1].start - end(v[0])) < 1e-6 && Math.abs(v[2].start - end(v[1])) < 1e-6, 'пустота удалена, клипы сдвинулись');

  // --- магнит: уносим третий клип вправо и подводим обратно «почти впритык» ---
  const third = v[2].id;
  let r3 = clipEl(third).getBoundingClientRect();
  await drag(clipEl(third), r3.x + 30, r3.y + 30, r3.x + 30 + 3 * timeline.pps);
  const away = store.findClip(third).clip.start;
  r3 = clipEl(third).getBoundingClientRect();
  const target = end(vids()[1]) + 6 / timeline.pps; // на 6 px правее конца соседа
  await drag(clipEl(third), r3.x + 30, r3.y + 30, r3.x + 30 + (target - away) * timeline.pps);
  v = vids();
  ok(Math.abs(store.findClip(third).clip.start - end(v[1])) < 1e-6, `магнит: клип унесли на ${away.toFixed(2)} и он прилип к соседу (${store.findClip(third).clip.start.toFixed(3)} = ${end(v[1]).toFixed(3)})`);
  // с Alt — без магнита
  r3 = clipEl(third).getBoundingClientRect();
  await drag(clipEl(third), r3.x + 30, r3.y + 30, r3.x + 30 + 6, 4, { altKey: true });
  ok(store.findClip(third).clip.start - end(vids()[1]) > 0.01, 'с Alt клип не прилипает');
  store.undo();
  await sleep(50);

  // --- наезд на соседа: клипы раздвигаются ---
  v = vids();
  const r1 = clipEl(v[0].id).getBoundingClientRect();
  const firstLen = end(v[0]) - v[0].start;
  await drag(clipEl(v[0].id), r1.x + 20, r1.y + 30, r1.x + 20 + (end(v[2]) - 0.2) * timeline.pps);
  v = vids();
  const noOverlap = v.every((x, i) => i === 0 || x.start >= end(v[i - 1]) - 1e-6);
  ok(noOverlap, `после переноса первого клипа в конец наложений нет: ${v.map((x) => `${x.start.toFixed(2)}-${end(x).toFixed(2)}`).join(', ')}`);
  ok(Math.abs((end(v[2]) - v[2].start) - firstLen) < 1e-6, 'длина перенесённого клипа не изменилась');
  store.undo();
  await sleep(50);

  // --- переход: «+» на стыке → плитка → длительность ---
  v = vids();
  const jn = document.querySelector(`.junction[data-clip="${v[1].id}"]`);
  ok(!!jn, 'на стыке клипов есть «+»');
  jn.click();
  await sleep(100);
  ok(store.selection && store.selection.kind === 'transition', 'клик по «+» выбирает стык');
  const tiles = document.querySelectorAll('.tr-tile');
  ok(tiles.length >= 18, `в панели ${tiles.length} переходов`);
  document.querySelector('.tr-tile[data-type="wipeleft"]').click();
  await sleep(100);
  ok(store.findClip(v[1].id).clip.transition?.type === 'wipeleft', 'переход «шторка справа налево» добавлен');
  await window.api.testShot('transition-panel');
  // предпросмотр в середине перехода: видны оба видео, у верхнего обрезка
  const seam = v[1].start;
  store.setTime(seam + 0.1);
  await sleep(600);
  const on = [...document.querySelectorAll('.stage video.on')];
  ok(on.length === 2 && on.some((x) => x.style.clipPath.startsWith('inset')), `плеер на переходе: видно ${on.length} видео, clip-path ${on.map((x) => x.style.clipPath).join(' / ')}`);
  await window.api.testShot('transition-preview');

  // --- затухание: инспектор и предпросмотр ---
  store.select({ kind: 'video', id: v[0].id });
  store.setClip(v[0].id, { fadeIn: 2 });
  await sleep(100);
  ok(!!clipEl(v[0].id).querySelector('.fade-zone.in'), 'на клипе видно затухание');
  ok(!!document.querySelector('[data-section="fade"]'), 'в инспекторе есть раздел «Затухание»');
  store.setTime(0.5);
  await sleep(400);
  const op = Number(document.querySelector('.stage video.on')?.style.opacity);
  ok(op > 0.15 && op < 0.35, `плеер: на 0,5 с из 2 с появления прозрачность ${op}`);
  // кружок затухания на клипе тянется
  const knob = clipEl(v[0].id).querySelector('.fade-knob.out');
  const kr = knob.getBoundingClientRect();
  await drag(knob, kr.x + 5, kr.y + 5, kr.x + 5 - 1 * timeline.pps);
  ok(Math.abs(store.findClip(v[0].id).clip.fadeOut - 1) < 0.05, `кружок исчезания: ${store.findClip(v[0].id).clip.fadeOut.toFixed(2)} с`);

  // --- копировать / вставить ---
  store.select({ kind: 'video', id: v[0].id });
  store.setTime(end(vids()[2]) + 2);
  key('KeyC', { ctrlKey: true, key: 'c' });
  key('KeyV', { ctrlKey: true, key: 'v' });
  await sleep(80);
  ok(store.project.videoClips.length === 4, `Ctrl+C / Ctrl+V: клипов ${store.project.videoClips.length}`);
  store.undo();

  // --- реверс (R) ---
  store.select({ kind: 'video', id: v[0].id });
  key('KeyR', { key: 'r' });
  for (let i = 0; i < 300 && !store.media(store.findClip(v[0].id).clip.mediaId)?.derived; i++) await sleep(100);
  const rm = store.media(store.findClip(v[0].id).clip.mediaId);
  ok(rm && rm.derived && rm.derived.kind === 'reverse', 'реверс: клип переключён на развёрнутый файл');
  ok(document.querySelectorAll('.media-card').length === 3, 'развёрнутый файл не показан в медиатеке');
  await sleep(500);
  await window.api.testShot('reversed');

  // --- стоп-кадр (F) ---
  const n0 = store.project.videoClips.length;
  const lastStart0 = vids()[vids().length - 1].start;
  store.setTime(1.5);
  key('KeyF', { key: 'f' });
  for (let i = 0; i < 300 && store.project.videoClips.length < n0 + 2; i++) await sleep(100);
  v = vids();
  const fz = v.find((x) => store.media(x.mediaId)?.derived?.kind === 'freeze');
  ok(!!fz && Math.abs(fz.start - 1.5) < 0.02 && Math.abs(end(fz) - fz.start - 3) < 1e-3, `стоп-кадр 3 с на 1,5 с: ${fz && fz.start}`);
  ok(Math.abs(v[v.length - 1].start - lastStart0 - 3) < 0.01, 'клипы правее сдвинулись на 3 с');

  // --- экспорт получившегося проекта (маленький, быстрый) ---
  const out = [info.cacheDir, 'tmp', 'ui3-export.mp4'].join(info.sep);
  const enc = await window.api.encoders();
  const r = await window.api.startExport(JSON.parse(JSON.stringify(store.project)), { width: 640, height: 360, fps: 30, codec: enc.h264_nvenc ? 'h264_nvenc' : 'libx264', quality: 'medium', output: out });
  ok(r.ok && Math.abs(r.duration - store.duration()) < 0.01, `экспорт проекта с переходом, затуханием, реверсом и стоп-кадром: ${r.ok ? `${(r.size / 1e6).toFixed(1)} МБ` : r.error}`);

  // Финальный вид: выделенный клип с затуханием и меню
  timeline.autoFit = true; timeline.fit();
  store.select({ kind: 'video', id: v[0].id });
  const tr = store.transitions()[0];
  store.setTime(tr.seam + tr.d * 0.18);
  await sleep(1500);
  const vs = [...document.querySelectorAll('.stage video')].map((x) => `${x.classList.contains('on') ? 'ON' : 'off'} rs=${x.readyState} op=${x.style.opacity} cp=${x.style.clipPath} z=${x.style.zIndex} t=${x.currentTime.toFixed(2)} ${decodeURIComponent(x.dataset.url || '').split(/[\\/]/).pop()}`);
  const L = window.__ffm.preview.current;
  log.push(`финал: переход ${tr.type} ${tr.from.toFixed(2)}–${tr.to.toFixed(2)}, слои ${L ? Object.keys(L).join(',') : 'нет'}; ${vs.join(' | ')}`);
  ok(document.querySelectorAll('.stage video.on').length === 2, 'на переходе после всех правок видны оба клипа');
  return { log, errors };
})();
