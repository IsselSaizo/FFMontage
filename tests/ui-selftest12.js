// Смена языка в настройках: окно перезагружается, проект, позиция курсора и история отмен сохраняются.
// Скрипт выполняется после каждой загрузки окна, пока не вернёт результат (selftest.rs) — фаза хранится в sessionStorage.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, openSettings } = window.__ffm;
  const i18n = await import('./js/i18n.js');
  const phase = sessionStorage.getItem('test12.phase');

  if (!phase) {
    // Фаза 1: проект, разрез (история отмен), курсор → переключаем язык на английский
    const info = await window.api.info();
    const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
    const [v] = await window.__ffm.importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(v);
    await sleep(500);
    store.select(null); store.setTime(2); timeline.splitAction();
    store.setTime(1.5);
    sessionStorage.setItem('test12.before', JSON.stringify({
      clips: store.project.videoClips.length, undo: store.undoStack.length, lang: i18n.getLang(),
    }));
    // Окно выбора языка (при первом запуске) рисуется и закрывается
    const st = await import('./js/settings.js');
    st.askLanguage();
    await sleep(100);
    const ask = [...document.querySelectorAll('.lang-ask .lang-choice button')].map((b) => b.dataset.lang).join();
    sessionStorage.setItem('test12.ask', ask);
    document.querySelector('.lang-ask')?.remove();
    sessionStorage.setItem('test12.phase', '1');
    openSettings('general');
    await sleep(200);
    document.querySelector('.set-body [data-lang="en"]').click();
    await sleep(5000); // окно перезагрузится раньше
    return { error: 'window did not reload after switching language' };
  }

  // Фаза 2: после перезагрузки
  const log = []; const errors = [];
  const check = (ok, msg) => { if (ok) log.push(`ok: ${msg}`); else errors.push(msg); };
  const before = JSON.parse(sessionStorage.getItem('test12.before') || '{}');
  for (let i = 0; i < 50 && store.project.videoClips.length < before.clips; i++) await sleep(100);
  await sleep(300);
  check(before.lang === 'ru', `language before: ${before.lang}`);
  check(i18n.getLang() === 'en' && document.documentElement.lang === 'en', `language after reload: ${i18n.getLang()}`);
  check(sessionStorage.getItem('test12.ask') === 'ru,en' || sessionStorage.getItem('test12.ask') === 'en,ru', `language prompt buttons: ${sessionStorage.getItem('test12.ask')}`);
  check(document.querySelector('.export-btn')?.textContent.includes('Export'), `export button: ${document.querySelector('.export-btn')?.textContent}`);
  check(document.querySelector('.mode-tab[data-mode="audio"]')?.textContent === 'Audio', 'mode tabs in English');
  check(store.project.videoClips.length === before.clips && before.clips === 2, `clips kept: ${store.project.videoClips.length}/${before.clips}`);
  check(Math.abs(store.time - 1.5) < 0.05, `playhead kept: ${store.time}`);
  check(store.undoStack.length === before.undo && before.undo > 0, `undo history kept: ${store.undoStack.length}/${before.undo}`);
  const s = await window.api.settingsGet();
  check(s.settings.lang === 'en' && s.lang === 'en', `settings.lang saved: ${s.settings.lang}`);
  store.undo();
  check(store.project.videoClips.length === 1, 'undo after reload works');
  // вернуть русский для следующих запусков
  await window.api.settingsSet({ lang: null });
  sessionStorage.clear();
  return { log, errors };
})();
