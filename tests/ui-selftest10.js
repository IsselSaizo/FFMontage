// Тест 10 (0.4): вкладка «Анимации» — пресет «Дождь», предпросмотр на холсте, запекание WebM с прозрачностью,
// медиатека, дорожка «Наложения», двойной щелчок → правка, экспорт поверх видео.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, anim } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const visible = (el) => !!el && el.offsetParent !== null;
  const ovs = () => store.project.overlayClips || [];
  const waitFor = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(150); } return false; };
  try {
    const [b, sp] = await importPaths([dir + 'b_h264_1080p30.mp4', dir + 's_sprite.png']);
    timeline.addMedia(b);
    document.querySelector('.mode-tab[data-mode="video"]').click();
    await sleep(250);
    ok(!document.querySelector('.tl-row.overlay'), 'на «Видео» без наложений дорожки «Наложения» нет');

    document.querySelector('.mode-tab[data-mode="anim"]').click(); await sleep(150);
    ok(document.body.dataset.mode === 'anim' && visible(document.querySelector('#anim-params')) && visible(document.querySelector('#anim-presets')), 'вкладка «Анимации»: пресеты слева, параметры справа');
    ok(!!document.querySelector('.anim-preset[data-preset="rain"].on'), 'пресет «Дождь»');
    ok(!!document.querySelector('.tl-row.overlay'), 'на таймлайне видна дорожка «Наложения»');
    ok(!!document.querySelector('.stage .anim-canvas'), 'холст предпросмотра в плеере');
    ok(anim.state.params.image === sp && !!document.querySelector(`.anim-img.on[data-image="${sp}"]`), 'картинка выбрана из медиатеки');
    ok(document.querySelectorAll('#anim-params input[data-param]').length === 7 && !!document.querySelector('#anim-loop') && !!document.querySelector('#anim-seed'), 'параметры: 7 ползунков, зацикливание, узор');
    const r = document.querySelector('#anim-params input[data-param="count"]');
    r.value = '10'; r.dispatchEvent(new Event('input'));
    const rd = document.querySelector('#anim-params input[data-param="duration"]');
    rd.value = '2'; rd.dispatchEvent(new Event('input'));
    ok(anim.state.params.count === 10 && anim.state.params.duration === 2, 'ползунки меняют параметры');
    await sleep(300);
    await window.api.testShot('anim-tab');

    // Сохранить
    store.setTime(1);
    document.querySelector('#anim-save').click();
    ok(await waitFor(() => ovs().length === 1 && !anim.state.busy), 'запекание: клип на «Наложениях»');
    const oc = ovs()[0];
    const om = oc && store.media(oc.mediaId);
    ok(om && om.anim && om.anim.preset === 'rain' && /\.webm$/i.test(om.path) && Math.abs(om.duration - 2) < 0.2, `файл: ${om && om.name}, ${om && om.duration} с`);
    ok(oc && Math.abs(oc.start - 1) < 0.01 && Math.abs(oc.out - oc.in - 2) < 0.2, 'наложение с позиции курсора, 2 с');
    await sleep(200);
    ok(!!document.querySelector(`.ov-clip[data-id="${oc.id}"]`), 'клип виден на дорожке');
    ok(!!document.querySelector(`.media-item[data-id="${oc.mediaId}"], [data-media-id="${oc.mediaId}"]`) || Object.values(store.project.media).some((m) => m.id === oc.mediaId && !m.hidden), 'файл анимации в «Ваши медиа»');

    // Экспорт
    const plan = await import('./js/exportPlan.js');
    const cmd = plan.buildExport(store.project, { width: 1280, height: 720, fps: 30 });
    ok(/overlay=0:0/.test(cmd.filter) && cmd.inputs.join(' ').includes('-c:v libvpx-vp9'), 'экспорт: наложение и декодер VP9 с прозрачностью');

    // Плеер на «Видео»
    document.querySelector('.mode-tab[data-mode="video"]').click(); await sleep(100);
    ok(!document.querySelector('.stage .anim-canvas') && !preview.hideOverlay, 'на «Видео» холста нет');
    ok(!!document.querySelector('.tl-row.overlay'), 'дорожка «Наложения» видна, пока на ней есть клипы');
    store.setTime(1.5); await sleep(500);
    ok(preview.ovEl.classList.contains('on') && Math.abs(preview.ovEl.currentTime - 0.5) < 0.1, `плеер: наложение показано, ${preview.ovEl.currentTime.toFixed(2)} с файла`);
    store.setTime(0.5); await sleep(150);
    ok(!preview.ovEl.classList.contains('on'), 'до начала наложения его не видно');

    // Двойной щелчок → правка
    document.querySelector(`.ov-clip[data-id="${oc.id}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(150);
    ok(document.body.dataset.mode === 'anim' && anim.state.editing === oc.id && anim.state.params.count === 10, 'двойной щелчок открывает анимацию с её параметрами');
    anim.state.params.count = 20;
    const oldMedia = oc.mediaId;
    document.querySelector('#anim-save').click();
    ok(await waitFor(() => !anim.state.busy && ovs()[0] && ovs()[0].mediaId !== oldMedia), 'сохранение правки заменяет файл у того же клипа');
    ok(ovs().length === 1 && store.media(ovs()[0].mediaId).anim.params.count === 20, 'клип один, новые параметры');

    // Перенос: тянем вправо на 2 с
    document.querySelector('.mode-tab[data-mode="video"]').click(); await sleep(100);
    const el = document.querySelector(`.ov-clip[data-id="${oc.id}"]`); const rc = el.getBoundingClientRect();
    const ptr = (type, x, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: rc.y + 5, button: 0, pointerId: 1, isPrimary: true }));
    ptr('pointerdown', rc.x + 10, el);
    for (let k = 1; k <= 5; k++) { ptr('pointermove', rc.x + 10 + (2 * timeline.pps * k) / 5); await sleep(16); }
    ptr('pointerup', rc.x + 10 + 2 * timeline.pps);
    await sleep(80);
    ok(Math.abs(ovs()[0].start - 3) < 0.05, `перенос: начало ${ovs()[0].start.toFixed(2)} с`);

    // Delete
    store.select({ kind: 'overlay', id: oc.id }); await sleep(50);
    timeline.deleteAction(); await sleep(80);
    ok(ovs().length === 0, 'Delete убирает наложение');
    store.undo(); await sleep(80);
    ok(ovs().length === 1, 'отмена возвращает его');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
