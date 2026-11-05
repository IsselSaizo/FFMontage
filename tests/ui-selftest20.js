// Тест 20 (0.5.x): звук в окне — индикаторы уровня дорожек и микса, раскладка 5.1 в плеере (ChannelMerger),
// «Разложить по каналам» (моно-файл канала для плеера), окно «Каналы и маршруты», общий элемент звука на поток,
// окно экспорта: «Громкость» и «Мастер-копия».
// Запуск: tests\run-ui.ps1 ui-selftest20 (файлы — node tests\engine-test.js и node tests\audio-test.js --only layout)
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
  const lvl = (el) => Number(getComputedStyle(el).getPropertyValue('--lvl')) || 0;
  const play = async (ms) => {
    store.setTime(0.2);
    preview.play(); await sleep(ms);
    const r = { tracks: {}, master: [] };
    for (const el of document.querySelectorAll('[data-meter]')) {
      const v = [...el.children].map(lvl);
      if (el.dataset.meter === 'master') r.master = v; else r.tracks[el.dataset.meter] = v;
    }
    preview.pause(); await sleep(100);
    return r;
  };
  try {
    const [m] = await importPaths([dir + 'c_music.mp3']);
    const [six] = await importPaths([dir + 'six.wav']);
    ok(m && six, `импорт: ${m} ${six}`);
    await until(() => store.runtime[m] && store.runtime[m].status === 'ready' && store.runtime[six] && store.runtime[six].status === 'ready', 30000);
    store.mutate((p) => { p.videoClips = []; p.videoTracks = []; p.audioTracks = [p.audioTracks[0]]; p.audioTracks[0].clips = []; });
    store.addAudioClip(m, 0, store.project.audioTracks[0].id, { forceTrack: true });
    timeline.autoFit = true; timeline.fit();
    await sleep(200);

    // --- Индикаторы в стерео ---
    const trk = store.project.audioTracks[0].id;
    ok(!!document.querySelector(`[data-meter="${trk}"]`) && !!document.querySelector('[data-meter="master"]'), 'индикаторы: у дорожки и под плеером');
    let r = await play(1500);
    ok(r.tracks[trk] && r.tracks[trk].length === 2 && r.tracks[trk].some((x) => x > 0.2), `уровень дорожки при воспроизведении: ${JSON.stringify(r.tracks[trk])}`);
    ok(r.master.length === 2 && r.master.every((x) => x > 0.2), `микс: 2 канала ${JSON.stringify(r.master)}`);
    await sleep(200);
    ok([...document.querySelectorAll('[data-meter] > i')].every((i) => lvl(i) === 0), 'после паузы индикаторы в нуле');

    // --- Общий элемент на поток: разрез не создаёт второй элемент ---
    const before = preview.audio.size;
    store.splitAt(1.0, store.project.audioTracks[0].clips[0].id);
    await sleep(100);
    await play(1500);
    ok(store.project.audioTracks[0].clips.length === 2 && preview.audio.size === before, `после разреза элементов звука столько же: ${before} → ${preview.audio.size}`);

    // --- 5.1 и «Разложить по каналам» ---
    store.setAudioLayout({ kind: '5.1' });
    const k = store.addAudioClip(six, 0, 'new');
    const ids = store.splitChannels(k.id);
    ok(ids.length === 6, `разложено по каналам: ${ids.length}`);
    await sleep(200);
    const chips = [...document.querySelectorAll('.th-route')].map((b) => b.textContent);
    ok(chips.includes('C') && chips.includes('LFE') && chips.includes('L·R'), `кнопки маршрута: ${chips.join(' ')}`);
    r = await play(2500);
    ok(preview.mix && preview.mix.n === 6 && r.master.length === 6, `плеер: микс 6 каналов, индикаторов ${r.master.length}`);
    const chUrl = await until(() => { const x = (store.runtime[six] || {}).channelUrl || {}; return Object.keys(x).length >= 6 ? x : null; }, 30000);
    ok(!!chUrl, `моно-файлы каналов для плеера: ${chUrl ? Object.keys(chUrl).length : 0}`);
    r = await play(2000);
    ok(r.master[2] > 0.1 && r.master[4] > 0.1, `уровни по каналам 5.1: ${r.master.map((x) => x.toFixed(2)).join(' ')}`);

    // --- Окно «Каналы и маршруты» ---
    document.querySelector('.th-route').click();
    const dlg = await until(() => document.querySelector('#routing-dialog'), 3000);
    ok(!!dlg && dlg.querySelectorAll('.rg-head').length === 6, 'окно маршрутов: 6 столбцов');
    const firstTrack = store.project.audioTracks[0].id;
    dlg.querySelector(`[data-route="${firstTrack}:2"]`).click(); await sleep(100);
    ok(JSON.stringify(store.project.audioTracks[0].route) === '[2]', `щелчок по ячейке: пара → моно в C ${JSON.stringify(store.project.audioTracks[0].route)}`);
    document.querySelector('#routing-add-channel').click(); await sleep(100);
    ok(store.project.audioLayout.kind === 'multi' && store.project.audioLayout.channels === 7 && document.querySelectorAll('#routing-dialog .rg-head').length === 7, '«+ канал»: 7 отдельных каналов');
    await window.api.testShot('routing').catch(() => {});
    store.undo(); await sleep(100);
    ok(store.project.audioLayout.kind === '5.1', 'отмена «+ канал»');
    document.querySelector('#routing-dialog .btn.primary').click();

    // --- Окно экспорта ---
    const { openExport } = await import('./js/exportDialog.js');
    openExport();
    const lsel = await until(() => document.querySelector('#export-loudness'), 5000);
    ok(lsel && lsel.options.length >= 4, `«Громкость»: ${lsel ? [...lsel.options].map((o) => o.value || '—').join(', ') : 'нет'}`);
    ok(!!document.querySelector('#export-audio-out'), 'выбор «одна дорожка / N моно / стерео» при 5.1');
    document.querySelector('[data-container="pro"]').click(); await sleep(150);
    const bsel = document.querySelector('#export-broadcast');
    ok(bsel && bsel.options.length === 7 && !!document.querySelector('#export-timecode'), 'мастер-копия: 7 пресетов и таймкод');
    bsel.value = 'xdcam_hd422'; bsel.dispatchEvent(new Event('change')); await sleep(150);
    ok(/\.mxf$/.test(document.querySelector('.out-path').textContent), `XDCAM → файл .mxf: ${document.querySelector('.out-path').textContent}`);
    await window.api.testShot('export-pro').catch(() => {});
    document.querySelector('.modal.export .modal-foot .btn.ghost').click();
    await sleep(100);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
