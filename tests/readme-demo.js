// Кадры для docs/media/demo.gif (README): импорт, клипы на таймлайн, музыка, переходы, заголовок, проигрывание, экспорт.
// Не тест: запускается из tools/readme-gif.ps1 (там же синтетические клипы и сборка GIF). Возвращает список кадров
// [имя снимка, длительность показа, с] в log.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return null; };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, openExport } = window.__ffm;
  const { textStyleById } = await import('./js/registry.js');
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'demo', ''].join(info.sep);
  // Окно на большом мониторе: интерфейс крупнее (как окно ~1600 px), чтобы в GIF шириной ~1000 px читались подписи.
  // zoom у body, а размер #app — в px «до увеличения» (100vh/100vw zoom не делит)
  const W = 1600;
  if (window.innerWidth > W) {
    const z = window.innerWidth / W;
    document.body.style.zoom = String(z);
    const app = document.querySelector('#app');
    app.style.width = `${window.innerWidth / z}px`; app.style.height = `${window.innerHeight / z}px`;
    app.style.setProperty('--tl-h', `${Math.round(window.innerHeight / z * 0.36)}px`);
    window.dispatchEvent(new Event('resize'));
  }
  await sleep(800);
  let n = 0;
  const shot = async (dur) => {
    await sleep(350); // миниатюры, волна, перерисовка
    const name = `demo_${String(n++).padStart(4, '0')}`;
    await window.api.testShot(name);
    log.push(`${name}.png ${dur}`);
  };
  // Кадр видео в плеере готов (после перемотки)
  const frameReady = () => until(() => preview.allSlots().filter((s) => s.classList.contains('on')).every((s) => s.readyState >= 2 && !s.seeking), 1500);
  try {
    const ids = await importPaths(['Aurora.mp4', 'Fractal.mp4', 'Spiral.mp4', 'Music.mp3'].map((f) => dir + f));
    await until(() => ids.every((id) => store.runtime[id] && store.runtime[id].status === 'ready'), 60000);
    await sleep(1500);
    const [aurora, fractal, spiral, music] = ids;
    store.select(null);
    await shot(1.2);

    for (const id of [aurora, fractal, spiral]) { timeline.addMedia(id); await shot(0.45); }
    store.addAudioClip(music, 0, store.project.audioTracks[0].id, { forceTrack: true });
    timeline.autoFit = true; timeline.fit();
    await shot(0.6);

    const v = store.project.videoClips;
    store.setTransition(v[1].id, 'circleopen', 1);
    store.select({ kind: 'transition', id: v[1].id });
    await shot(0.7);
    store.setTransition(v[2].id, 'slideleft', 1);
    store.select({ kind: 'transition', id: v[2].id });
    await shot(0.7);

    store.setTime(0.6);
    const c = store.addTextClip({ style: textStyleById('title'), text: { content: 'FF Montage' }, at: 0.3, duration: 4.2 });
    if (c) store.select({ kind: 'video', id: c.id });
    timeline.fit();
    await frameReady();
    await shot(1.3);

    // «Воспроизведение»: перемотка по шагам — кадры точные, а скорость показа задаёт GIF
    store.select(null);
    const dur = store.duration();
    for (let t = 0; t < dur - 0.05; t += 0.4) {
      store.setTime(t);
      await frameReady();
      await shot(0.16);
    }

    openExport();
    await until(() => document.querySelector('.modal.export'), 5000);
    await shot(1.8);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
