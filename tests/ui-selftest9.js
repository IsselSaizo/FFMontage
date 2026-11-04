// Тест 9 (0.4): вкладка «Аудио» — стойка эффектов клипа и дорожки, Web Audio в плеере, экспорт.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const rack = () => document.querySelector('#audio-rack');
  const visible = (el) => !!el && el.offsetParent !== null;
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b);
    await sleep(250);
    const tr = store.project.audioTracks[0];
    const ac = tr.clips[0];
    ok(!!ac && ac.link, 'звук видео на первой дорожке');

    // --- Переключение вкладки ---
    store.select(null);
    document.querySelector('.mode-tab[data-mode="audio"]').click(); await sleep(80);
    ok(document.body.dataset.mode === 'audio' && visible(rack()) && !visible(document.querySelector('#right-side')), 'вкладка «Аудио»: стойка справа вместо свойств');
    ok(/Выберите звуковой клип/.test(rack().textContent), 'без выбора — подсказка');

    // --- Дорожка ---
    const head = document.querySelector(`[data-track-head="${tr.id}"]`);
    head.click(); await sleep(80);
    ok(store.selection && store.selection.kind === 'track' && document.querySelector(`[data-track-head="${tr.id}"]`).classList.contains('selected'), 'щелчок по заголовку выбирает дорожку');
    ok(/Дорожка/.test(rack().textContent), 'стойка: эффекты дорожки');
    rack().querySelector('[data-add-fx="comp"]').click(); await sleep(80);
    ok(store.project.audioTracks[0].afx && store.project.audioTracks[0].afx[0].type === 'comp', 'компрессор на дорожке');
    ok(!!document.querySelector(`[data-track-head="${tr.id}"] .th-fx`), 'значок ƒx у дорожки');
    ok(document.querySelector('#tb-delete').disabled, 'Delete не удаляет дорожку');

    // --- Клип ---
    store.select({ kind: 'audio', id: ac.id }); await sleep(80);
    ok(/Клип/.test(rack().textContent), 'стойка: эффекты клипа');
    rack().querySelector('[data-add-fx="eq"]').click(); await sleep(80);
    ok(store.findClip(ac.id).clip.afx && store.findClip(ac.id).clip.afx[0].type === 'eq', 'эквалайзер на клипе');
    ok(!!document.querySelector(`.clip[data-id="${ac.id}"] .ci.fxb`), 'значок ƒx на клипе');

    // Ползунок: одна запись в истории за жест
    const undo0 = store.undoStack.length;
    const sl = rack().querySelector('.fx-card[data-fx="eq"] input[data-param="low"]');
    sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    for (const v of [2, 4, 6]) { sl.value = String(v); sl.dispatchEvent(new Event('input')); await sleep(20); }
    sl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await sleep(60);
    ok(store.findClip(ac.id).clip.afx[0].p.low === 6 && store.undoStack.length === undo0 + 1, `ползунок: низкие +6 дБ, шагов отмены ${store.undoStack.length - undo0}`);

    // Экспорт: EQ клипа и компрессор дорожки
    const plan = await import('./js/exportPlan.js');
    let cmd = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
    ok(/bass=g=6\.00/.test(cmd.filter) && /acompressor=/.test(cmd.filter) && /\[tk/.test(cmd.filter), 'экспорт: EQ клипа, компрессор после смешивания дорожки');

    // Выключить — эффект остаётся в списке, но не действует
    rack().querySelector('[data-fx-on="0"]').click(); await sleep(80);
    cmd = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
    ok(store.findClip(ac.id).clip.afx[0].on === false && !/bass=g=/.test(cmd.filter), 'выключенный эффект не попадает в экспорт');

    // Плеер: эффекты в Web Audio
    rack().querySelector('[data-fx-on="0"]').click(); await sleep(60);
    store.setTime(1);
    preview.play(); await sleep(700); preview.pause();
    const recA = preview.audio.get(ac.id);
    const route = recA && preview.routes.get(recA.el);
    ok(route && route.nodes.length === 3 && preview.buses.has(tr.id) && preview.buses.get(tr.id).nodes.length === 2, 'плеер: EQ (3 фильтра) у клипа и компрессор на шине дорожки');

    // Удалить
    rack().querySelector('[data-fx-del="0"]').click(); await sleep(80);
    ok(!store.findClip(ac.id).clip.afx, 'эффект убран');
    store.undo(); await sleep(50);
    ok(store.findClip(ac.id).clip.afx && store.findClip(ac.id).clip.afx.length === 1, 'отмена возвращает эффект');

    // Шумоподавление: только в экспорте
    rack().querySelector('[data-add-fx="denoise"]').click(); await sleep(80);
    ok(/только в готовом видео/.test(rack().textContent), 'шумоподавление: пометка «только в готовом видео»');
    await window.api.testShot('audio-tab');

    // Обратно на «Видео»
    document.querySelector('.mode-tab[data-mode="video"]').click(); await sleep(80);
    ok(visible(document.querySelector('#right-side')) && !visible(rack()), 'вкладка «Видео»: снова свойства');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
