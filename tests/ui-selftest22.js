// Тест 22 (0.5.0): фигуры, обводка видео, таймер (плеер, инспектор, подготовка APNG к экспорту) и панели в отдельных
// окнах (кнопка ⧉: панель уходит в окно и возвращается, заглушка в главном окне, уведомления/меню там же).
// Запуск: tests\run-ui.ps1 ui-selftest22 (файлы — node tests\engine-test.js)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return null; };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, popout } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    ok(!!b, `импорт: ${b}`);
    await until(() => store.runtime[b] && store.runtime[b].status === 'ready', 30000);
    store.mutate((p) => { p.videoClips = []; p.videoTracks = []; p.audioTracks = [p.audioTracks[0]]; p.audioTracks[0].clips = []; });
    timeline.addMedia(b);
    const v = store.project.videoClips[0];
    ok(!!v, 'видео на основной дорожке');

    // --- Обводка ---
    store.select({ kind: 'video', id: v.id });
    await sleep(200);
    ok(!!document.querySelector('#inspector [data-border]'), 'в инспекторе видео есть «Обводка и углы»');
    store.setBorder([v.id], { width: 0.01, color: '#ff8800', radius: 0.05 });
    const vb = store.findClip(v.id).clip.border;
    ok(vb && vb.width === 0.01 && vb.color === '#ff8800' && vb.radius === 0.05, `обводка в модели: ${JSON.stringify(vb)}`);
    store.setTime(1); preview.seek(1); await sleep(500);
    const ring = document.querySelector('#preview .slot-ring');
    ok(!!ring && getComputedStyle(ring).display !== 'none', 'в плеере — рамка обводки');
    store.setBorder([v.id], null);
    ok(!store.findClip(v.id).clip.border, 'обводку можно убрать');

    // --- Фигуры ---
    for (const type of ['rect', 'chamfer', 'triangle', 'ellipse']) {
      const c = store.addShapeClip({ type, at: 0 });
      ok(!!c && c.kind === 'shape' && c.shape.type === type, `фигура ${type}`);
    }
    await sleep(300);
    ok(document.querySelectorAll('#timeline .shape-strip').length >= 4, 'фигуры на таймлайне');

    // --- Таймер ---
    const tc = store.addTimerClip({ timer: { duration: 3, mode: 'down' }, at: 0 });
    ok(!!tc && tc.kind === 'timer' && Math.abs(tc.out - 4.6) < 1e-6, `таймер: клип ${tc && tc.out} с (3 + звонок)`);
    await sleep(300);
    ok(!!document.querySelector('#inspector [data-section="timer"]') && !!document.querySelector('#timer-duration'), 'инспектор таймера');
    store.setTimer([tc.id], { duration: 5 });
    ok(Math.abs(store.findClip(tc.id).clip.out - 6.6) < 1e-6, `время 5 с → клип ${store.findClip(tc.id).clip.out}`);
    store.undo();
    ok(Math.abs(store.findClip(tc.id).clip.out - 4.6) < 1e-6, 'отмена возвращает время');
    store.setTime(4); preview.seek(4); await sleep(400);
    await window.api.testShot('timer-ring').catch(() => {});
    const { prepareExportAssets } = await import('./js/exportAssets.js');
    const t0 = performance.now();
    const assets = await prepareExportAssets(store.project, { width: 1280, height: 720, fps: 30, container: 'mp4' }, window.api);
    const ta = assets.texts[tc.id];
    ok(ta && /\.apng$/i.test(ta.path) && ta.anim && ta.w > 50, `таймер к экспорту: ${ta && ta.path} ${ta && ta.w}×${ta && ta.h}, ${Math.round(performance.now() - t0)} мс`);
    ok(['rect', 'chamfer', 'triangle', 'ellipse'].every((ty) => store.allVideo().some((c) => c.kind === 'shape' && c.shape.type === ty && assets.texts[c.id])), 'фигуры к экспорту');

    // --- Панели в отдельных окнах ---
    ok(document.querySelectorAll('.po-btn').length >= 4, `кнопок ⧉: ${document.querySelectorAll('.po-btn').length}`);
    for (const id of ['right', 'media', 'timeline', 'preview']) {
      const opened = popout.popOut(id);
      ok(opened, `${id}: окно открылось`);
      if (!opened) continue;
      await sleep(600);
      ok(!!document.querySelector(`.popout-ph[data-po="${id}"]`) && popout.poppedOut().includes(id), `${id}: в главном окне — заглушка`);
    }
    await window.api.testShot('popouts').catch(() => {});
    // Вынесенные панели продолжают работать: выделение → инспектор в отдельном окне
    store.select({ kind: 'video', id: tc.id }); await sleep(300);
    const { popQuery } = await import('./js/uidoc.js');
    const insp = popQuery('#inspector');
    ok(!document.querySelector('#inspector') && !!insp && insp.ownerDocument !== document && !!insp.querySelector('[data-section="timer"]'), 'инспектор в отдельном окне перерисовывается');
    timeline.render();
    const tl = popQuery('#timeline');
    ok(!!tl && tl.querySelectorAll('.shape-strip').length >= 5 && tl.getBoundingClientRect().width > 300, `таймлайн — в отдельном окне: ширина ${tl && Math.round(tl.getBoundingClientRect().width)}`);
    // Уведомление — в окне последнего действия
    tl.ownerDocument.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const { toast } = await import('./js/util.js');
    toast('popout toast');
    ok(!!tl.ownerDocument.querySelector('#toasts .toast'), 'уведомление — в окне таймлайна');
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // Горячая клавиша из отдельного окна доходит до главного: Ctrl+Z
    const before = store.allVideo().length;
    tl.ownerDocument.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(200);
    ok(store.allVideo().length === before - 1, `Ctrl+Z в отдельном окне — отмена: клипов ${before} → ${store.allVideo().length}`);
    for (const id of popout.poppedOut()) popout.dock(id);
    await sleep(400);
    ok(!document.querySelector('.popout-ph') && document.querySelector('#inspector').ownerDocument === document && popout.poppedOut().length === 0, 'все панели вернулись');
    ok(document.querySelector('#workspace > #right-side') && document.querySelector('#app > #timeline'), 'панели на своих местах');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
