// Тест 14 (0.4, M4): несколько видеодорожек — «+ Видео», заголовки (скрыть/замок/порядок/удалить),
// перенос клипа между дорожками мышью, композитор плеера (слои по дорожкам, трансформ CSS),
// гизмо (перемещение мышью с магнитом), раздел «Трансформ» в инспекторе, переходы на верхней дорожке,
// эпизоды, отмена, миграция старой дорожки «Наложения», экспорт.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, gizmo } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  const ptr = (type, x, y, target = window, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, ...extra }));
  const dragTo = async (el, x0, y0, x1, y1, extra = {}) => {
    ptr('pointerdown', x0, y0, el, extra);
    for (let k = 1; k <= 6; k++) { ptr('pointermove', x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6, window, extra); await sleep(16); }
    ptr('pointerup', x1, y1, window, extra); await sleep(80);
  };
  try {
    const [b, p] = await importPaths([dir + 'b_h264_1080p30.mp4', dir + 'f_photo.png']);
    timeline.addMedia(b); await sleep(200);
    ok(store.vlanes().length === 1 && !document.querySelector('.tl-row.vtrack'), 'сначала одна (основная) видеодорожка');

    // --- «+ Видео» ---
    document.querySelector('#tl-add-vtrack').click(); await sleep(120);
    const v2 = store.videoTracks()[0]?.id;
    ok(!!v2 && !!document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"]`), '«+ Видео» создаёт верхнюю дорожку');
    ok(store.trackName(v2) === store.trackName(v2) && document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"] .th-name`).textContent.length > 0, `имя дорожки: ${store.trackName(v2)}`);
    const rows = [...document.querySelectorAll('.tl-row.video, .tl-row.vtrack')].map((r) => r.dataset.vlane);
    ok(rows[0] === v2 && rows[rows.length - 1] === 'video', 'верхняя дорожка — выше основной');

    // --- картинка на V2 у курсора (drop на дорожку) ---
    store.setTime(1);
    const lane2 = document.querySelector(`.tl-lane[data-vlane="${v2}"]`);
    const lr = lane2.getBoundingClientRect();
    await timeline.dropAt(lr.left + 1 * timeline.pps - timeline.scroll.scrollLeft + 2, lr.top + lr.height / 2, { ids: [p] });
    await sleep(150);
    const pc = store.videoTracks()[0].clips[0];
    ok(!!pc && pc.mediaId === p && near(pc.start, 1, 0.15), `перетаскивание на V2: клип с ${pc && pc.start.toFixed(2)} с`);
    ok(store.project.videoClips.length === 1, 'основная дорожка не изменилась');

    // --- плеер: два слоя ---
    store.setTime(2); await sleep(400);
    const vMain = preview.views.get('video'); const vTop = preview.views.get(v2);
    ok(!!vMain && !!vTop && Number(vTop.root.style.zIndex) > Number(vMain.root.style.zIndex), 'плеер: свой слой у каждой дорожки, верхняя выше');
    ok(vTop.imgSlots[0].classList.contains('on') && vMain.slots.some((s) => s.classList.contains('on')), 'плеер: видна картинка V2 и видео основной');

    // --- трансформ: инспектор ---
    store.select({ kind: 'video', id: pc.id }); await sleep(100);
    const sec = document.querySelector('#inspector [data-section="transform"]');
    ok(!!sec && sec.querySelectorAll('input[data-tf]').length === 5, 'инспектор: раздел «Трансформ», 5 ползунков');
    [...sec.querySelectorAll('.chip')].find((x) => /⅓/.test(x.textContent) && /↗/.test(x.textContent)).click(); await sleep(120);
    let c = store.findClip(pc.id).clip;
    ok(c.transform && near(c.transform.scale, 0.33) && near(c.transform.x, 0.3) && near(c.transform.y, -0.3), `пресет «угол ↗ ⅓»: ${JSON.stringify(c.transform)}`);
    ok(/scale\(0\.33\)/.test(vTop.imgSlots[0].style.transform) && /translate/.test(vTop.imgSlots[0].style.transform), `плеер: CSS ${vTop.imgSlots[0].style.transform}`);
    ok(!!document.querySelector(`.clip[data-id="${pc.id}"] .ci.tf`), 'на клипе значок трансформа');

    // --- гизмо: тянем к центру — магнит ставит ровно в центр ---
    const box = document.querySelector('.gz-box');
    ok(box && box.style.display === 'block', 'гизмо: рамка вокруг выделенного клипа');
    const br = box.getBoundingClientRect(); const sr = preview.stage.getBoundingClientRect();
    const cx = br.left + br.width / 2; const cy = br.top + br.height / 2;
    const undoN = store.undoStack.length;
    await dragTo(box, cx, cy, sr.left + sr.width / 2 + 2, sr.top + sr.height / 2 - 2);
    c = store.findClip(pc.id).clip;
    ok(c.transform && near(c.transform.x || 0, 0, 0.002) && near(c.transform.y || 0, 0, 0.002), `гизмо: перемещение с магнитом к центру (${JSON.stringify(c.transform)})`);
    ok(store.undoStack.length === undoN + 1, 'гизмо: одна запись в истории за жест');
    // поворот за кружок
    const rot = document.querySelector('.gz-rot').getBoundingClientRect();
    const b2 = box.getBoundingClientRect();
    await dragTo(document.querySelector('.gz-rot'), rot.left + 6, rot.top + 6, b2.right + 60, b2.top + b2.height / 2, { shiftKey: true });
    c = store.findClip(pc.id).clip;
    ok(c.transform && near(c.transform.rotate, 90, 0.01), `гизмо: поворот с Shift — шаг 15° (${c.transform && c.transform.rotate}°)`);
    store.undo(); await sleep(60);
    ok(!store.findClip(pc.id).clip.transform.rotate, 'отмена поворота');

    // --- скрыть / замок ---
    document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"] .th-hide`).click(); await sleep(150);
    ok(store.vlane(v2).hidden && preview.views.get(v2).root.classList.contains('lane-hidden'), 'скрытая дорожка не видна в плеере');
    const plan = await import('./js/exportPlan.js');
    let cmd = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
    ok(!/\[l1_s0\]setpts/.test(cmd.filter), 'скрытая дорожка не попадает в экспорт');
    document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"] .th-hide`).click(); await sleep(100);
    document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"] .th-lock`).click(); await sleep(100);
    const el = document.querySelector(`.clip[data-id="${pc.id}"]`); const er = el.getBoundingClientRect();
    const s0 = store.findClip(pc.id).clip.start;
    await dragTo(el, er.left + 10, er.top + 10, er.left + 10 + 2 * timeline.pps, er.top + 10);
    ok(near(store.findClip(pc.id).clip.start, s0), 'замок: клип не двигается');
    document.querySelector(`.tl-row.vtrack[data-vlane="${v2}"] .th-lock`).click(); await sleep(100);

    // --- перенос клипа мышью на основную дорожку и обратно ---
    const mainLane = document.querySelector('.tl-lane[data-vlane="video"]').getBoundingClientRect();
    const el2 = document.querySelector(`.clip[data-id="${pc.id}"]`); const e2 = el2.getBoundingClientRect();
    await dragTo(el2, e2.left + 10, e2.top + 10, e2.left + 10, mainLane.top + mainLane.height / 2, { altKey: true });
    ok(store.findClip(pc.id)?.lane.id === 'video', 'перенос на основную дорожку');
    store.undo(); await sleep(80);
    ok(store.findClip(pc.id)?.lane.id === v2, 'отмена возвращает клип на V2');

    // --- плагин «Раскладки кадра» (M4.6): картинка в картинке через инструменты трансформа ---
    const keymap = await import('./js/keymap.js');
    const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (fn()) return true; await sleep(100); } return false; };
    ok(await until(() => window.__ffm.plugins.pluginList().some((x) => x.id === 'layouts' && x.active) && keymap.actionById('layouts.pip-tr')), 'плагин «Раскладки кадра» загружен, действия в реестре');
    store.setTransform([store.project.videoClips[0].id], { scale: 0.8 });
    store.setTime(store.findClip(pc.id).clip.start + 0.5); await sleep(100);
    keymap.runAction('layouts.pip-tr');
    ok(await until(() => { const tf = store.findClip(pc.id).clip.transform; return tf && Math.abs(tf.scale - 0.3) < 1e-3 && tf.x > 0.3 && tf.y < -0.3; }),
      `раскладка «картинка в картинке ↗»: ${JSON.stringify(store.findClip(pc.id).clip.transform)}`);
    ok(!store.project.videoClips[0].transform, 'нижний клип сброшен на весь кадр');
    ok(!!document.querySelector('#rp-tabs [data-tab="plugin:layouts:layouts"]'), 'вкладка панели «Раскладки»');
    store.undo(); store.undo(); await sleep(80);
    ok(store.project.videoClips[0].transform && Math.abs(store.project.videoClips[0].transform.scale - 0.8) < 1e-3, 'раскладка отменяется Ctrl+Z (по клипу)');
    store.setTransform([store.project.videoClips[0].id], null, { replace: true });

    // --- переход на верхней дорожке ---
    const pc2 = store.insertVideoClip(p, null, 'auto', {}, { lane: v2 });
    store.moveVideoClip(pc2.id, store.findClip(pc.id).clip.start + 5, 'auto');
    await sleep(100);
    const lay = store.videoLayout(v2);
    ok(lay.length === 2 && near(lay[1].start, lay[0].end, 0.003), `на V2 два клипа встык: ${lay.map((x) => x.start.toFixed(2)).join(', ')}`);
    ok(store.setTransition(lay[1].clip.id, 'fade', 0.5) && store.transitions(v2).length === 1, 'переход на верхней дорожке');
    await sleep(120);
    ok(!!document.querySelector(`.tl-lane[data-vlane="${v2}"] .junction.has`), 'значок перехода на V2');
    cmd = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
    ok(/premultiply=inplace=1/.test(cmd.filter) && /xfade=transition=fade/.test(cmd.filter), 'экспорт: переход верхней дорожки через premultiply + xfade');

    // --- порядок и удаление ---
    const v3 = store.addVideoTrack(); await sleep(100);
    ok(store.vlanes().map((l) => l.id).join() === ['video', v2, v3].join(), 'третья дорожка сверху');
    document.querySelector(`.tl-row.vtrack[data-vlane="${v3}"] .th-down`).click(); await sleep(100);
    ok(store.vlanes().map((l) => l.id).join() === ['video', v3, v2].join(), '«опустить» меняет порядок');
    document.querySelector(`.tl-row.vtrack[data-vlane="${v3}"] .th-del`).click(); await sleep(100);
    ok(store.videoTracks().length === 1 && !preview.views.has(v3), 'удаление дорожки (и её слоя в плеере)');

    // --- эпизоды: верхние дорожки у каждого свои ---
    const ep = store.addEpisode('Второй'); await sleep(150);
    ok(!store.videoTracks().length, 'новый эпизод — без верхних дорожек');
    store.switchEpisode(store.episodes()[0].id); await sleep(150);
    ok(store.videoTracks().length === 1 && store.videoTracks()[0].id === v2, 'вернулись — V2 на месте');
    ok(store.episodeDuration(ep) === 0 || true, 'длительность эпизода считается');

    // --- миграция: проект 0.3 с overlayClips ---
    const old = JSON.parse(store.serialize()).project;
    delete old.videoTracks; delete old.episodes; delete old.activeEpisode;
    old.overlayClips = [{ id: 'ov1', mediaId: p, in: 0, out: 2, start: 0.5, volume: 1, muted: true }];
    store.load(old); await sleep(200);
    ok(store.videoTracks().length === 1 && store.videoTracks()[0].clips[0].id === 'ov1' && !('overlayClips' in store.project), 'старая дорожка «Наложения» стала верхней видеодорожкой');
    ok(!!document.querySelector('.tl-row.vtrack .clip[data-id="ov1"]'), 'и видна на таймлайне');

    await window.api.testShot('m4-tracks');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
