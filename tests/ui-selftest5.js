// Тест 5 (0.3, вид): вкладки справа (переходы/эффекты), показ перехода и эффекта при наведении,
// формат кадра 9:16, цвет фона, «заполнить», картинки и GIF.
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
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const tab = (id) => document.querySelector(`#rp-tabs [data-tab="${id}"]`);
  const enter = (el) => el.dispatchEvent(new MouseEvent('mouseenter'));
  const leave = (el) => el.dispatchEvent(new MouseEvent('mouseleave'));
  try {
    const [b, p, g] = await importPaths([dir + 'b_h264_1080p30.mp4', dir + 'f_photo.png', dir + 'g_anim.gif']);
    timeline.addMedia(b); timeline.addMedia(b);
    await sleep(200);
    let v = vids();
    ok(v.length === 2 && Math.abs(v[1].start - v[0].start - 8) < 1e-6, 'два клипа встык');

    // --- Вкладки ---
    ok(document.querySelectorAll('#rp-tabs .rp-tab').length === 3, 'три вкладки справа');
    tab('transitions').click(); await sleep(50);
    const trRoot = document.querySelector('#browse-transitions');
    ok(!trRoot.hidden && document.querySelector('#inspector').hidden, 'вкладка «Переходы» открыта');
    const tiles = trRoot.querySelectorAll('.tr-tile');
    ok(tiles.length >= 15, `переходов в списке: ${tiles.length}`);

    // Наведение на переход — показ в плеере на стыке
    const wl = trRoot.querySelector('.tr-tile[data-type="circleopen"]');
    enter(wl);
    await sleep(60);
    ok(preview.override && preview.override.type === 'circleopen' && preview.override.b.id === v[1].id, 'наведение: переход играет в плеере');
    ok(preview.slots.filter((s) => s.classList.contains('on')).length === 2, 'в плеере оба клипа стыка');
    leave(wl); await sleep(30);
    ok(!preview.override, 'мышь ушла — плеер вернулся к курсору');
    ok(!store.project.videoClips.some((c) => c.transition), 'наведение не меняет проект');
    // Щелчок — поставить
    trRoot.querySelector('.tr-tile[data-type="wipeleft"]').click(); await sleep(50);
    ok(vids()[1].transition && vids()[1].transition.type === 'wipeleft', 'щелчок ставит переход на стык');
    // Наведение на значок перехода на таймлайне
    const jb = document.querySelector(`.junction.has[data-clip="${vids()[1].id}"]`);
    enter(jb); await sleep(40);
    ok(preview.override && preview.override.type === 'wipeleft', 'наведение на переход на таймлайне — показ в плеере');
    leave(jb); await sleep(30);

    // --- Эффекты ---
    store.select({ kind: 'video', id: v[0].id });
    store.setTime(2);
    tab('effects').click(); await sleep(50);
    const fxRoot = document.querySelector('#browse-effects');
    const bw = fxRoot.querySelector('.fx-tile[data-fx="bw"]');
    ok(!!bw && !bw.disabled, 'эффект «Чёрно-белое» в списке');
    enter(bw); await sleep(50);
    const shown = () => preview.slots.find((s) => s.classList.contains('on'));
    ok(/grayscale/.test(shown().style.filter), `наведение: эффект в плеере (${shown().style.filter})`);
    ok(!store.findClip(v[0].id).clip.effects, 'наведение не меняет клип');
    leave(bw); await sleep(30);
    ok(!/grayscale/.test(shown().style.filter), 'мышь ушла — эффект снят');
    fxRoot.querySelector('.fx-tile[data-fx="bw"]').click(); await sleep(80);
    ok(JSON.stringify(store.findClip(v[0].id).clip.effects) === '["bw"]', 'щелчок включает эффект');
    ok(/grayscale/.test(shown().style.filter), 'эффект виден в плеере');
    ok(!!document.querySelector(`.clip[data-id="${v[0].id}"] .ci.fxb`), 'значок fx на клипе');
    store.undo(); await sleep(50);
    ok(!store.findClip(v[0].id).clip.effects, 'отмена снимает эффект');
    store.redo();

    // --- Кадр: заполнить ---
    tab('props').click(); await sleep(50);
    document.querySelector('#fit-cover').click(); await sleep(50);
    ok(store.findClip(v[0].id).clip.fit === 'cover' && shown().classList.contains('cover'), '«Заполнить»: клип и плеер');

    // --- Формат 9:16 и фон ---
    store.select(null); await sleep(50);
    document.querySelector('[data-aspect="9:16"]').click(); await sleep(150);
    const f = store.sourceFormat();
    ok(f.width === 1080 && f.height === 1920, `9:16: ${f.width}×${f.height}`);
    const st = preview.stage.getBoundingClientRect();
    ok(st.height > st.width * 1.6, `плеер вертикальный ${Math.round(st.width)}×${Math.round(st.height)}`);
    document.querySelector('.swatch[title="Белый"]').click(); await sleep(80);
    ok(store.project.background === '#ffffff' && /255, 255, 255/.test(preview.stage.style.background), 'фон белый');
    const plan = await import('./js/exportPlan.js');
    let cmd = plan.buildExport(store.project, { width: 1080, height: 1920, fps: 30 });
    ok(/color=0xffffff/.test(cmd.filter) && /crop=1080:1920/.test(cmd.filter) && /hue=s=0/.test(cmd.filter), 'экспорт: фон, заполнение, ч/б');

    // --- Картинка и GIF ---
    timeline.addMedia(p); await sleep(100);
    const pc = vids().find((c) => c.mediaId === p);
    ok(pc && Math.abs(pc.out - pc.in - 5) < 1e-6 && !pc.link && !pc.noAudio, 'картинка: клип 5 с, без звука');
    store.setClip(pc.id, { out: 12 });
    ok(Math.abs(store.findClip(pc.id).clip.out - 12) < 1e-6, 'картинку можно растянуть');
    store.setTime(pc.start + 1); await sleep(150);
    ok(preview.imgSlots[0].classList.contains('on') && /media\.localhost/.test(preview.imgSlots[0].src), 'картинка в плеере');
    cmd = plan.buildExport(store.project, { width: 1080, height: 1920, fps: 30 });
    ok(cmd.inputs.includes('-loop'), 'экспорт: картинка с -loop 1');
    timeline.addMedia(g); await sleep(100);
    for (let i = 0; i < 100 && !(store.runtime[g] && store.runtime[g].proxyUrl); i++) await sleep(100);
    const gc = vids().find((c) => c.mediaId === g);
    ok(gc && Math.abs(gc.out - 2) < 0.2, `GIF: клип ${gc && gc.out} с`);
    store.setTime(gc.start + 0.5); await sleep(400);
    ok(shown() && /media\.localhost/.test(shown().src), 'GIF играет в плеере (через видео)');
  } catch (err) { errors.push(String(err && err.stack || err)); }
  await window.api.testShot('ui-selftest5');
  return { log, errors };
})();
