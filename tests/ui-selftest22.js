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

    // --- «Библиотека» (вкладка левой панели): плитки фигур и таймеров, щелчок — клип в месте курсора ---
    ok(!document.querySelector('#browse-text [data-section="shapes"]') && !document.querySelector('#browse-text [data-section="timers"]'), 'во вкладке «Текст» больше нет фигур и таймеров');
    document.querySelector('#mp-tabs [data-mtab="library"]').click();
    await sleep(200);
    const lib = document.querySelector('#library');
    ok(lib && !lib.hidden && document.querySelector('#media-pane').hidden, 'вкладка «Библиотека» открылась');
    await window.api.testShot('library').catch(() => {});
    ok(lib.querySelectorAll('[data-section="lib-shape"] .lib-tile').length === 4 && lib.querySelectorAll('[data-section="lib-timer"] .lib-tile').length >= 1, `плитки: ${lib.querySelectorAll('.lib-tile').length}`);
    const nBefore = store.allVideo().length;
    store.setTime(2);
    lib.querySelector('[data-lib="shape.ellipse"]').click();
    await sleep(200);
    const added = store.allVideo().find((c) => c.kind === 'shape' && c.shape.type === 'ellipse' && Math.abs(c.start - 2) < 1e-6);
    ok(store.allVideo().length === nBefore + 1 && !!added && store.selection && store.selection.id === added.id, 'щелчок по плитке — фигура в месте курсора, выделена');
    // Перетаскивание плитки на основную дорожку
    // Основная дорожка — под пятью верхними: прокрутить к ней (точка вне видимой части таймлайна — не на таймлайне)
    timeline.render();
    await sleep(200);
    timeline.scroll.querySelector('[data-lane="video"]').scrollIntoView({ block: 'center' });
    await sleep(300);
    // Таймлайн перерисовывается по прокрутке — берём элемент дорожки заново
    const r = timeline.scroll.querySelector('[data-lane="video"]').getBoundingClientRect();
    // x — правее колонки заголовков дорожек (она поверх дорожек)
    const sr = timeline.scroll.getBoundingClientRect();
    const dropped = timeline.dropGraphic(sr.left + 168 + 80, r.top + r.height / 2, 'timer', { duration: 5 });
    const df = dropped && store.findClip(dropped.id);
    ok(df && dropped.kind === 'timer' && df.lane && df.lane.main, `таймер из библиотеки брошен на основную дорожку: ${dropped && dropped.kind} → ${df && df.lane && df.lane.id}; lane ${[r.left, r.top, r.width, r.height].map(Math.round)} scroll ${[sr.left, sr.top, sr.width, sr.height].map(Math.round)}`);
    store.undo();
    document.querySelector('#mp-tabs [data-mtab="media"]').click();

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

    // Стили и звонок (0.5.0): три рисунка, смена стиля — цвета стиля; звонок «повторять» / «нет» меняет длину клипа
    const { timerReady } = await import('./js/timer.js');
    const { stylePalette } = await import('./js/timerStyles.js');
    const canvasOf = () => [...document.querySelectorAll('#preview canvas')].find((cv) => cv.width > 50 && cv.dataset.sig && cv.dataset.sig.includes('|timer|'));
    const painted = (cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 200) n++; return n; };
    for (const style of ['classic', 'digital', 'retro']) {
      store.setTimer([tc.id], { style });
      const cur = store.findClip(tc.id).clip.timer;
      ok(cur.style === style && cur.colors.case === stylePalette(style).case, `стиль ${style}: цвета стиля`);
      ok(!!document.querySelector(`#inspector [data-timer-style="${style}"].on`), `стиль ${style} отмечен в инспекторе`);
      await timerReady(cur, { ring: true });
      store.setTime(1.2); preview.seek(1.2); await sleep(350);
      const cv = await until(() => { const c = canvasOf(); return c && painted(c) > 50 ? c : null; }, 5000);
      ok(!!cv, `стиль ${style}: таймер нарисован в плеере (${cv ? painted(cv) : 0} точек)`);
      await window.api.testShot(`timer-${style}`).catch(() => {});
      store.setTime(3.6); preview.seek(3.6); await sleep(350);
      await window.api.testShot(`timer-${style}-ring`).catch(() => {});
    }
    store.setTimer([tc.id], { ring: 'none' });
    ok(Math.abs(store.findClip(tc.id).clip.out - 3) < 1e-6, `без звонка — клип ${store.findClip(tc.id).clip.out} с`);
    store.setTimer([tc.id], { ring: 'loop' });
    ok(Math.abs(store.findClip(tc.id).clip.out - (3 + 1.6 * 3)) < 1e-6, `звонок повторяется — клип ${store.findClip(tc.id).clip.out} с`);
    store.setTimer([tc.id], { ring: 'once', style: 'classic' });
    ok(Math.abs(store.findClip(tc.id).clip.out - 4.6) < 1e-6, 'звонок один раз — снова 4,6 с');
    const { prepareExportAssets } = await import('./js/exportAssets.js');
    const t0 = performance.now();
    const assets = await prepareExportAssets(store.project, { width: 1280, height: 720, fps: 30, container: 'mp4' }, window.api);
    const ta = assets.texts[tc.id];
    ok(ta && /\.apng$/i.test(ta.path) && ta.anim && ta.w > 50, `таймер к экспорту: ${ta && ta.path} ${ta && ta.w}×${ta && ta.h}, ${Math.round(performance.now() - t0)} мс`);
    ok(['rect', 'chamfer', 'triangle', 'ellipse'].every((ty) => store.allVideo().some((c) => c.kind === 'shape' && c.shape.type === ty && assets.texts[c.id])), 'фигуры к экспорту');

    // --- Панели в отдельных окнах (экспериментальная функция, по умолчанию выключена) ---
    const btnShown = () => [...document.querySelectorAll('.po-btn')].filter((b) => getComputedStyle(b).display !== 'none').length;
    ok(btnShown() === 0 && popout.popOut('media') === false && popout.poppedOut().length === 0, 'по умолчанию отдельных окон нет: кнопки ⧉ скрыты');
    popout.setExperimental(true);
    ok(btnShown() >= 4, `экспериментальные функции включены — кнопок ⧉: ${btnShown()}`);

    // Перетаскивание из окна медиафайлов на таймлайн главного окна
    const { popQuery, mapPoint } = await import('./js/uidoc.js');
    ok(popout.popOut('media'), 'media: окно открылось');
    await sleep(700);
    const card = popQuery('.media-card');
    const pw = card && card.ownerDocument.defaultView;
    try { pw.moveTo(window.screenX + window.innerWidth - 470, window.screenY + 40); } catch { /* окно Tauri может не двигаться */ }
    await sleep(300);
    timeline.render(); await sleep(150);
    timeline.scroll.querySelector('[data-lane="video"]').scrollIntoView({ block: 'center' }); await sleep(300);
    const lr = timeline.scroll.querySelector('[data-lane="video"]').getBoundingClientRect();
    const tr0 = timeline.scroll.getBoundingClientRect();
    const [px, py] = mapPoint(tr0.left + 168 + 120, lr.top + lr.height / 2, window, pw);
    const insidePw = px >= 0 && py >= 0 && px < pw.innerWidth && py < pw.innerHeight;
    const drag = async (x1, y1) => {
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 30, clientY: 30 }));
      pw.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: px, clientY: py, buttons: 1 }));
      pw.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x1, clientY: y1 }));
      await sleep(400);
    };
    if (insidePw) log.push(`skip перетаскивание между окнами: окно медиа закрывает таймлайн (${Math.round(px)}, ${Math.round(py)})`);
    else {
      const n0 = store.project.videoClips.length;
      await drag(px, py);
      ok(store.project.videoClips.length === n0 + 1, `карточка из окна медиа легла на основную дорожку: ${n0} → ${store.project.videoClips.length}`);
      const n1 = store.allVideo().length;
      await drag(20, 20);
      ok(store.allVideo().length === n1, 'отпустили в окне медиа — клип не добавился');
      store.undo();
    }
    popout.dock('media'); await sleep(300);

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
    store.addShapeClip({ type: 'rect', at: 0, select: false });   // последнее действие — новый клип
    const before = store.allVideo().length;
    tl.ownerDocument.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(200);
    ok(store.allVideo().length === before - 1, `Ctrl+Z в отдельном окне — отмена: клипов ${before} → ${store.allVideo().length}`);
    // Выключение экспериментальных функций возвращает все панели и проверяет, что они на местах
    const off = popout.setExperimental(false);
    await sleep(400);
    ok(off.ok && !document.querySelector('.popout-ph') && document.querySelector('#inspector').ownerDocument === document && popout.poppedOut().length === 0, `выключили — все панели вернулись (${off.missing.join(', ')})`);
    ok(document.querySelector('#workspace > #right-side') && document.querySelector('#app > #timeline') && document.querySelector('#media-panel').ownerDocument === document, 'панели на своих местах');
    ok(btnShown() === 0, 'кнопки ⧉ снова скрыты');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
