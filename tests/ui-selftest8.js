// Тест 8 (0.4): кадрирование в плеере — рамка с ручками, Enter/Esc, «ко всем клипам этого файла», экспорт.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, crop } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const near = (a, b, e = 0.02) => Math.abs(a - b) < e;
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true }));
  const ptr = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
  const shown = () => preview.slots.find((s) => s.classList.contains('on'));
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b); timeline.addMedia(b);
    await sleep(250);
    const [v0, v1] = vids().map((c) => c.id);
    const cropBtn = document.querySelector('#viewbar .vb-crop');
    store.select(null); await sleep(40);
    ok(cropBtn.disabled, 'без выбранного клипа кадрирование неактивно');

    store.select({ kind: 'video', id: v0 }); store.setTime(1); await sleep(80);
    ok(!cropBtn.disabled, 'с клипом — активно');
    cropBtn.click(); await sleep(150);
    const layer = document.querySelector('.crop-layer');
    ok(!!layer && !!document.querySelector('.crop-box') && document.querySelectorAll('.crop-h').length === 8, 'рамка с 8 ручками в плеере');
    ok(document.body.classList.contains('cropping') && preview.cropEdit === v0, 'режим кадрирования');
    await window.api.testShot('crop-mode');

    // Тянем правую ручку влево на четверть кадра (кадр 16:9 = весь экран 16:9)
    const box = document.querySelector('.crop-box').getBoundingClientRect();
    const he = document.querySelector('.crop-h.e'); const hr = he.getBoundingClientRect();
    const sx = hr.x + hr.width / 2; const sy = hr.y + hr.height / 2;
    ptr('pointerdown', sx, sy, he);
    for (let k = 1; k <= 5; k++) { ptr('pointermove', sx - (box.width / 4) * k / 5, sy); await sleep(16); }
    ptr('pointerup', sx - box.width / 4, sy);
    await sleep(40);
    ok(near(crop.active.crop.r, 0.25) && crop.active.crop.l === 0, `ручка: справа срезано ${crop.active.crop.r.toFixed(3)}`);
    ok(!store.findClip(v0).clip.crop, 'до Enter проект не меняется');
    // Пробел в режиме кадрирования не запускает воспроизведение
    key(' '); await sleep(60);
    ok(!preview.playing, 'горячие клавиши монтажа в режиме кадрирования не работают');
    key('Enter'); await sleep(120);
    const c0 = store.findClip(v0).clip;
    ok(c0.crop && near(c0.crop.r, 0.25) && !document.querySelector('.crop-layer'), 'Enter применяет и закрывает рамку');
    ok(!store.findClip(v1).clip.crop, 'второй клип того же файла не тронут (галочка выключена)');
    await sleep(100);
    const vb = shown() && shown().style.objectViewBox;
    ok(CSS.supports('object-view-box', 'inset(1%)') ? /inset\(0% 25% 0% 0%\)/.test(vb) : true, `плеер: object-view-box ${vb}`);
    ok(cropBtn.classList.contains('active'), 'кнопка кадрирования подсвечена');

    // Esc отменяет
    cropBtn.click(); await sleep(120);
    ok(near(crop.active.crop.r, 0.25), 'повторный вход: рамка с прежним кадрированием');
    crop.set({ l: 0.1, t: 0.1, r: 0.1, b: 0.1 });
    key('Escape'); await sleep(100);
    ok(!document.querySelector('.crop-layer') && near(store.findClip(v0).clip.crop.r, 0.25) && !store.findClip(v0).clip.crop.l, 'Esc отменяет изменения');

    // Галочка «ко всем клипам этого файла»
    cropBtn.click(); await sleep(120);
    crop.set({ l: 0.1, t: 0, r: 0, b: 0.2 });
    document.querySelector('#crop-all').click();
    document.querySelector('#crop-apply').click(); await sleep(100);
    ok(near(store.findClip(v0).clip.crop.l, 0.1) && store.findClip(v1).clip.crop && near(store.findClip(v1).clip.crop.b, 0.2), 'с галочкой — оба клипа файла');
    store.undo(); await sleep(50);
    ok(near(store.findClip(v0).clip.crop.r, 0.25) && !store.findClip(v1).clip.crop, 'одна отмена возвращает оба');

    // Экспорт
    const plan = await import('./js/exportPlan.js');
    const cmd = plan.buildExport(store.project, { width: 1280, height: 720, fps: 30 });
    ok(/crop=w=trunc\(iw\*0\.750000\/2\)\*2/.test(cmd.filter), 'экспорт: crop в графе');

    // «Сбросить» в режиме
    cropBtn.click(); await sleep(120);
    document.querySelector('#crop-reset').click();
    document.querySelector('#crop-apply').click(); await sleep(100);
    ok(!store.findClip(v0).clip.crop, '«Сбросить» + «Применить» убирают кадрирование');

    // Смена выделения выходит из режима
    cropBtn.click(); await sleep(100);
    store.select({ kind: 'video', id: v1 }); await sleep(80);
    ok(!document.querySelector('.crop-layer') && !preview.cropEdit, 'выбор другого клипа закрывает рамку');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
