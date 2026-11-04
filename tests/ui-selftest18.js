// Тест 18 (0.4.1): MKV/TS в окне — играет напрямую или через прокси без перекодирования; окно экспорта — выбор контейнера.
// Нужны файлы: node tests\container-test.js, затем tests\run-ui.ps1 ui-selftest18
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  try {
    for (const name of ['in_h264_aac.mkv', 'in_h264_flac.mkv', 'in_h264_aac.ts']) {
      const [id] = await importPaths([dir + name]);
      ok(!!id, `${name}: импорт`);
      if (!id) continue;
      const rt = await until(() => { const r = store.runtime[id]; return r && (r.status === 'ready' || r.status === 'error') ? r : null; }, 30000);
      const how = rt && rt.proxyUrl ? (rt.remuxed ? 'ремукс' : 'прокси') : 'напрямую';
      ok(rt && rt.status === 'ready' && !(rt.proxyUrl && !rt.remuxed), `${name}: готов (${how})`);
      // Проигрывание: клип на пустой таймлайн, кадр идёт
      store.mutate((p) => { p.videoClips = []; p.audioTracks.forEach((tr) => { tr.clips = []; }); });
      timeline.addMedia(id); await sleep(300);
      store.setTime(0.5);
      preview.play(); await sleep(1500); preview.pause(); await sleep(300);
      const r2 = store.runtime[id] || {};
      const vids = [...document.querySelectorAll('#preview video')].filter((v) => v.videoWidth > 0 && v.currentTime > 0.6);
      ok(vids.length > 0, `${name}: кадр в плеере (${r2.proxyUrl ? (r2.remuxed ? 'ремукс' : 'прокси') : 'напрямую'}), время ${vids[0] && vids[0].currentTime.toFixed(2)}`);
      log.push(`info ${name}: ${how} → ${r2.proxyUrl ? (r2.remuxed ? 'ремукс' : 'прокси') : 'напрямую'}`);
    }

    // Окно экспорта: MKV → путь .mkv, FLAC доступен, флажок отдельных потоков
    store.mutate((p) => { p.audioTracks[0].name = 'Музыка'; });
    const { openExport } = await import('./js/exportDialog.js');
    openExport(); await until(() => document.querySelector('#export-container'), 5000);
    const outPath = () => document.querySelector('.modal.export .out-path').textContent;
    ok(/\.mp4$/.test(outPath()), `по умолчанию MP4: ${outPath()}`);
    document.querySelector('#export-container [data-container="mkv"]').click(); await sleep(100);
    ok(/\.mkv$/.test(outPath()), `MKV: путь ${outPath()}`);
    const opts = [...document.querySelectorAll('#export-audio-codec option')].map((o) => o.value);
    ok(opts.join() === 'aac,aac256,opus,flac,pcm', `MKV: кодеки звука ${opts.join()}`);
    ok(!!document.querySelector('#export-stems'), 'MKV: флажок «Аудиодорожки отдельными потоками»');
    await window.api.testShot('export-mkv').catch(() => {});
    document.querySelector('#export-container [data-container="mp4"]').click(); await sleep(100);
    ok([...document.querySelectorAll('#export-audio-codec option')].map((o) => o.value).join() === 'aac,aac256' && !document.querySelector('#export-stems'), 'MP4: только AAC, без отдельных потоков');
    const resVals = () => [...document.querySelectorAll('.modal.export select')].flatMap((s) => [...s.options].map((o) => o.value));
    ok(resVals().includes('480'), 'разрешение 480p в списке');
    // GIF: нет кодека, качества и звука; частота — свой список; путь .gif
    document.querySelector('#export-container [data-container="gif"]').click(); await sleep(100);
    ok(/\.gif$/.test(outPath()) && !!document.querySelector('#export-gif-fps') && !document.querySelector('.codec-cards') && !document.querySelector('#export-audio-codec'), `GIF: форма ${outPath()}`);
    // Только звук: нет разрешения и кодека видео, кодеки MP3
    document.querySelector('#export-container [data-container="mp3"]').click(); await sleep(100);
    const mp3 = [...document.querySelectorAll('#export-audio-codec option')].map((o) => o.value);
    ok(/\.mp3$/.test(outPath()) && mp3.join() === 'mp3,mp3_192,mp3_128' && !document.querySelector('.codec-cards') && !document.querySelector('#export-gif-fps'), `MP3: ${mp3.join()}`);
    await window.api.testShot('export-mp3').catch(() => {});
    const rows = [...document.querySelectorAll('#export-container .segmented')].map((sg) => new Set([...sg.children].map((b) => Math.round(b.getBoundingClientRect().top))).size);
    ok(rows.every((n) => n === 1), `кнопки форматов — в один ряд: ${rows.join(',')}`);
    // Настоящий экспорт MP3 и GIF из окна
    for (const fmt of ['mp3', 'gif']) {
      document.querySelector(`#export-container [data-container="${fmt}"]`).click(); await sleep(100);
      document.querySelector('#export-go').click();
      await until(() => document.querySelector('.modal.export.busy'), 10000);
      const done = await until(() => { const hh = document.querySelector('.modal.export .modal-head h2'); return hh && !/Экспорт…/.test(hh.textContent) && !document.querySelector('.modal.export.busy') ? hh.textContent : null; }, 60000);
      const name = document.querySelector('.modal.export .export-target') && document.querySelector('.modal.export .export-target').textContent;
      ok(done === 'Готово!' && new RegExp(`\\.${fmt}$`).test(name || ''), `экспорт ${fmt.toUpperCase()}: ${done} ${name} ${(document.querySelector('.modal.export .error-box') || {}).textContent || ''}`);
      document.querySelector('.modal.export .modal-head .icon-btn')?.click(); await sleep(150);
      openExport(); await until(() => document.querySelector('#export-container'), 5000);
    }
    document.querySelector('.modal.export .modal-head .icon-btn').click(); await sleep(100);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
