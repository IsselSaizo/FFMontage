// Тест 6 (0.3): эпизоды — несколько таймлайнов в проекте, добавление эпизода в основной.
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
  const end = (c) => c.start + c.out - c.in;
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const auds = () => store.project.audioTracks.flatMap((t) => t.clips);
  const tabs = () => [...document.querySelectorAll('#episodes .ep-tab')];
  try {
    const [b, e] = await importPaths([dir + 'b_h264_1080p30.mp4', dir + 'e_2audio.mp4']);
    ok(tabs().length === 1 && tabs()[0].textContent.includes('Основной'), 'одна вкладка «Основной»');
    timeline.addMedia(b); await sleep(100);
    store.setTime(3);
    const mainSnap = JSON.stringify(store.project.videoClips);

    // --- Новый эпизод ---
    document.querySelector('#ep-add').click(); await sleep(150);
    const ep = store.activeEpisode();
    ok(ep !== 'main' && tabs().length === 2 && tabs()[1].classList.contains('on'), `новый эпизод открыт (${store.episodeName(ep)})`);
    ok(store.project.videoClips.length === 0 && store.time === 0, 'таймлайн эпизода пустой');
    timeline.addMedia(e); await sleep(100);
    ok(store.project.videoClips.length === 1 && auds().length === 2, 'в эпизоде видео + 2 звуковых клипа');

    // --- Добавить в основной ---
    document.querySelector('#ep-join').click(); await sleep(150);
    ok(store.activeEpisode() === ep && store.project.videoClips.length === 1, 'эпизод остался как был');
    tabs()[0].click(); await sleep(150);
    ok(store.activeEpisode() === 'main' && Math.abs(store.time - 3) < 1e-6, 'вернулись в основной, курсор на месте');
    let v = vids();
    ok(v.length === 2 && Math.abs(v[1].start - 8) < 1e-6 && v[1].mediaId === e, `эпизод добавлен в конец: ${v.map((c) => `${c.start}-${end(c)}`).join(', ')}`);
    ok(store.linkedOf(v[1].id).length === 2 && store.linkedOf(v[1].id).every((x) => Math.abs(x.clip.start - 8) < 1e-6), 'звук эпизода связан с его видео, на месте');
    const epIds = new Set(store.episodeContent(ep).videoClips.map((c) => c.id));
    ok(!epIds.has(v[1].id), 'в основном — копии клипов (новые id)');

    // --- Переименование ---
    tabs()[1].querySelector('.ep-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(50);
    const inp = document.querySelector('.ep-rename');
    inp.value = 'Сцена 1'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(100);
    ok(store.episodeName(ep) === 'Сцена 1' && tabs()[1].textContent.includes('Сцена 1'), 'эпизод переименован');

    // --- Вставить по курсору (разрезает клип под курсором и раздвигает) ---
    store.setTime(4);
    tabs()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 600 })); await sleep(80);
    document.querySelector('.ctx-menu [data-action="ep-here"]').click(); await sleep(100);
    v = vids();
    ok(v.length === 4 && Math.abs(end(v[0]) - 4) < 1e-6 && v[1].mediaId === e && Math.abs(v[1].start - 4) < 1e-6
      && Math.abs(v[2].start - 10) < 1e-6 && v[2].mediaId === b && Math.abs(v[3].start - 14) < 1e-6,
    `вставка по курсору: ${v.map((c) => `${c.start}-${end(c)}`).join(', ')}`);
    ok(store.duration() === 20, `длительность 20: ${store.duration()}`);

    // --- Сохранение и загрузка ---
    const text = store.serialize();
    store.load(JSON.parse(text).project, null); await sleep(100);
    ok(store.episodes().length === 2 && store.episodeName(ep) === 'Сцена 1' && store.project.videoClips.length === 4, 'эпизоды сохраняются в проект');
    store.switchEpisode(ep); await sleep(100);
    ok(store.project.videoClips.length === 1 && store.project.videoClips[0].mediaId === e, 'содержимое эпизода после загрузки');
    ok(store.usageCount(b) === 4 && store.usageCount(e) === 9, `использование файлов по всем эпизодам: b ${store.usageCount(b)}, e ${store.usageCount(e)}`);

    // --- Удаление и отмена ---
    store.removeEpisode(ep); await sleep(100);
    ok(store.activeEpisode() === 'main' && store.episodes().length === 1 && tabs().length === 1, 'эпизод удалён, открыт основной');
    store.undo(); await sleep(100);
    ok(store.episodes().length === 2, 'отмена возвращает эпизод');
    void mainSnap;
  } catch (err) { errors.push(String(err && err.stack || err)); }
  await window.api.testShot('ui-selftest6');
  return { log, errors };
})();
