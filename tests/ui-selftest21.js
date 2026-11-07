// Тест 21 (0.4.8): прокрутка таймлайна по вертикали (колесо с Shift, полоса прокрутки — scrollTop не сбрасывается
// перерисовкой), колесо без модификаторов — по времени; плеер оживает после ошибки <video> (перезапуск элемента).
// Запуск: tests\run-ui.ps1 ui-selftest21 (файлы — node tests\engine-test.js)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return null; };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const wheel = (opts) => {
    const r = timeline.scroll.getBoundingClientRect();
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaMode: 0, ...opts });
    timeline.content.dispatchEvent(e);
    return e.defaultPrevented;
  };
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    ok(!!b, `импорт: ${b}`);
    await until(() => store.runtime[b] && store.runtime[b].status === 'ready', 30000);
    store.mutate((p) => { p.videoClips = []; p.videoTracks = []; p.audioTracks = [p.audioTracks[0]]; p.audioTracks[0].clips = []; });
    for (let i = 0; i < 4; i++) timeline.addMedia(b);
    for (let i = 0; i < 8; i++) store.addAudioTrack();
    store.addVideoTrack(); store.addVideoTrack();
    timeline.setZoom(400, null, true);
    await sleep(300);

    // --- Вертикальная прокрутка ---
    const s = timeline.scroll;
    ok(s.scrollHeight > s.clientHeight + 100, `дорожки не помещаются: ${s.scrollHeight} > ${s.clientHeight}`);
    s.scrollTop = 150;
    await sleep(150); // событие scroll → render()
    ok(s.scrollTop === 150, `scrollTop после перерисовки по scroll: ${s.scrollTop}`);
    timeline.render();
    ok(s.scrollTop === 150, `scrollTop после render(): ${s.scrollTop}`);
    store.setTime(0.5); store.select(null); await sleep(150);
    ok(s.scrollTop === 150, `scrollTop после смены выделения/времени: ${s.scrollTop}`);

    // --- Колесо ---
    s.scrollTop = 0; s.scrollLeft = 0; await sleep(100);
    const pv = wheel({ deltaY: 120, shiftKey: true }); await sleep(150);
    ok(pv && s.scrollTop === 120 && s.scrollLeft === 0, `Shift + колесо вниз — дорожки: top ${s.scrollTop}, left ${s.scrollLeft}`);
    wheel({ deltaX: 60, shiftKey: true }); await sleep(150); // так WebView отдаёт колесо с Shift на части систем
    ok(s.scrollTop === 180, `Shift + колесо (deltaX) — тоже дорожки: top ${s.scrollTop}`);
    wheel({ deltaY: -400, shiftKey: true }); await sleep(150);
    ok(s.scrollTop === 0, `Shift + колесо вверх: top ${s.scrollTop}`);
    const pps = timeline.pps;
    wheel({ deltaY: 100 }); await sleep(150);
    ok(s.scrollLeft === 100 && s.scrollTop === 0 && timeline.pps === pps, `колесо без модификаторов — по времени: left ${s.scrollLeft}, top ${s.scrollTop}`);
    wheel({ deltaY: 3, deltaMode: 1 }); await sleep(150);
    ok(s.scrollLeft === 220, `колесо в строках (deltaMode 1): left ${s.scrollLeft}`);
    wheel({ deltaY: -100, ctrlKey: true }); await sleep(150);
    ok(timeline.pps > pps, `Ctrl + колесо — масштаб: ${pps.toFixed(1)} → ${timeline.pps.toFixed(1)}`);
    await window.api.testShot('scroll').catch(() => {});

    // --- Плеер: ошибка <video> посреди воспроизведения ---
    store.mutate((p) => { p.videoTracks = []; p.audioTracks = [p.audioTracks[0]]; });
    store.setTime(0.3);
    preview.play(); await sleep(800);
    const el = preview.master && preview.master.el;
    ok(!!el && el.okUrl === el.dataset.url && !el.paused, 'плеер играет');
    // Подменяем src, не трогая dataset.url: элемент получает ошибку, как при сбое декодера
    el.src = 'data:video/mp4;base64,AAAAAA==';
    const failed = await until(() => el.failed || el.error, 5000);
    ok(!!failed, `ошибка элемента: код ${el.error && el.error.code}`);
    const back = await until(() => !el.error && !el.failed && el.src === el.dataset.url && el.readyState >= 2 && !el.paused, 8000);
    const t0 = el.currentTime; await sleep(600);
    ok(!!back && el.currentTime > t0, `после ошибки плеер снова играет: ${t0.toFixed(2)} → ${el.currentTime.toFixed(2)}`);
    ok(!preview.msg.textContent, `сообщения нет: «${preview.msg.textContent}»`);
    preview.pause(); await sleep(100);

    // Три сбоя подряд — дальше сообщение, без бесконечных перезапусков
    preview.seek(0.5); await sleep(400);
    const el2 = preview.master && preview.master.el;
    for (let i = 0; i < 4; i++) {
      el2.src = 'data:video/mp4;base64,AAAAAA==';
      await until(() => el2.error, 3000);
      await sleep(1200);
    }
    ok(el2.failed && /не воспроизводится|not play/i.test(preview.msg.textContent), `после 4 сбоев за 30 с — сообщение: «${preview.msg.textContent}»`);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
