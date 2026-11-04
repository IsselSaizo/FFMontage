// Настройки, пути и кэш (M0.5–M0.7):
//   • paths_info: с FFM_CONFIG (run-ui.ps1) — режим custom, все папки в тестовой папке, а не в %APPDATA% / %LOCALAPPDATA%;
//   • prefs.js ↔ settings.json: отложенная запись, перенос localStorage ffm.* (после перезагрузки окна ключей уже нет);
//   • кэш: категории в cache_stats, LRU-автоочистка (медиа открытого проекта не удаляются, даже если они больше лимита),
//     ползунок лимита 1..50 ГБ в «Настройки → Кэш» (settings.json → cache.limitGb, Rust зажимает в 1..50),
//     cache_clear с keep, относительные имена в thumbs.json (B-9).
//   powershell -ExecutionPolicy Bypass -File tests\run-ui.ps1 ui-selftest16
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, openSettings } = window.__ffm;
  const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const fetch = (url) => window.fetch(url, { cache: 'no-store' }); // без кэша WebView: файл мог исчезнуть
  const prefs = await import('./js/prefs.js');
  const phase = sessionStorage.getItem('test16.phase');

  if (!phase) {
    // Фаза 1: старые значения в localStorage → перезагрузка окна → prefs.js переносит их в settings.json.
    // Перенос не перезаписывает сохранённое — поэтому сначала убираем ui (его могли заполнить прошлые запуски).
    await prefs.setPrefs({ ui: null });
    localStorage.setItem('ffm.tlHeight', '333');
    localStorage.setItem('ffm.magnet', '0');
    localStorage.setItem('ffm.rightTab', 'effects');
    sessionStorage.setItem('test16.phase', '1');
    location.reload();
    await sleep(8000);
    return { error: 'window did not reload' };
  }

  const log = []; const errors = [];
  const check = (ok, msg) => { if (ok) log.push(`ok: ${msg}`); else errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  sessionStorage.removeItem('test16.phase');

  // --- M0.5: пути ---
  const p = await invoke('paths_info');
  log.push(`mode ${p.mode} (${p.reason}), config ${p.configDir}`);
  check(p.mode === 'custom', `FFM_CONFIG → custom mode: ${p.mode}`);
  const testDir = p.configFile.replace(/[\\/][^\\/]+$/, '');
  check(p.configDir === testDir && p.dataDir === testDir, `config/data dir = test dir: ${p.configDir}`);
  check(p.settingsFile.startsWith(testDir) && /settings\.json$/.test(p.settingsFile), `settings.json next to config.json: ${p.settingsFile}`);
  const sysDirs = /[\\/]AppData[\\/](Roaming|Local)[\\/]FF Montage|[\\/]\.config[\\/]ff-montage|[\\/]Library[\\/]/i;
  const all = [p.configDir, p.dataDir, p.settingsFile, p.fontsDir, p.pluginsDir, p.cacheDir, p.logsDir];
  check(!all.some((x) => sysDirs.test(x)), `no system folders used: ${all.filter((x) => sysDirs.test(x)).join(', ')}`);
  check(p.fontsDir.startsWith(testDir) || /user-fonts/.test(p.fontsDir), `fonts dir: ${p.fontsDir}`);

  // --- M0.6: перенос localStorage и prefs ---
  check(localStorage.getItem('ffm.tlHeight') === null && localStorage.getItem('ffm.magnet') === null && localStorage.getItem('ffm.rightTab') === null, 'localStorage ffm.* removed after migration');
  let s = await window.api.settingsGet();
  check(s.settings.ui?.tlHeight === 333 && s.settings.ui?.magnet === false && s.settings.ui?.rightTab === 'effects', `migrated to settings.json: ${JSON.stringify(s.settings.ui)}`);
  check(timeline.magnet === false, `timeline magnet from prefs: ${timeline.magnet}`);
  check(prefs.getPref('ui.tlHeight') === 333, 'getPref ui.tlHeight');
  prefs.setPref('ui.rightTab', 'text');
  prefs.setPref('export', { codec: 'h264', quality: 'medium' });
  check(prefs.getPref('ui.rightTab') === 'text', 'setPref is visible at once');
  await sleep(900);
  s = await window.api.settingsGet();
  check(s.settings.ui?.rightTab === 'text' && s.settings.ui?.tlHeight === 333 && s.settings.export?.codec === 'h264', `debounced write: ${JSON.stringify(s.settings.ui)} ${JSON.stringify(s.settings.export)}`);
  check(!!s.file && s.file === p.settingsFile, `settings_get file: ${s.file}`);
  // Rust зажимает лимит кэша
  await window.api.settingsSet({ cache: { limitGb: 500 } });
  check((await window.api.cacheStats()).limitGb === 50, 'limit 500 → 50');
  await window.api.settingsSet({ cache: { limitGb: 0 } });
  check((await window.api.cacheStats()).limitGb === 1, 'limit 0 → 1');
  await window.api.settingsSet({ cache: null });
  await prefs.loadPrefs();
  check((await window.api.cacheStats()).limitGb === 1, 'default limit 1 GB');

  // --- M0.7: кэш ---
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const [vb, ac, ve] = await window.__ffm.importPaths([dir + 'b_h264_1080p30.mp4', dir + 'c_music.mp3', dir + 'e_2audio.mp4']);
  check(vb && ac && ve, `imported: ${[vb, ac, ve].join(',')}`);
  timeline.addMedia(vb);
  for (let i = 0; i < 150 && !(store.runtime[vb]?.thumbs && store.runtime[ve]?.thumbs && store.runtime[ac]?.peaks); i++) await sleep(100);
  check(!!store.runtime[vb]?.thumbs?.urls?.length && !!store.runtime[ve]?.thumbs?.urls?.length, 'thumbnails ready');
  const bKey = store.media(vb).key; const eKey = store.media(ve).key;
  const bThumb = store.runtime[vb].thumbs.urls[0];
  const eThumb = store.runtime[ve].thumbs.urls[0];
  check(bThumb.includes(bKey), 'thumb url is in the current cache dir');
  // thumbs.json (B-9) окну не отдаётся (media:// — только медиафайлы); имена файлов проверяет cargo test cache::tests
  let st = await window.api.cacheStats();
  log.push(`stats: ${JSON.stringify({ thumbs: st.thumbs, peaks: st.peaks, proxy: st.proxy, fx: st.fx, temp: st.temp, items: st.mediaItems, auto: st.auto })}`);
  check(st.thumbs > 0 && st.peaks > 0 && st.mediaItems >= 3 && st.auto > 0, 'cache_stats categories');
  for (const k of ['thumbs', 'peaks', 'proxy', 'fx', 'anim', 'assets', 'fonts', 'temp', 'logs', 'webview', 'total']) {
    if (typeof st[k] !== 'number') errors.push(`cache_stats.${k} missing`);
  }

  // e_2audio убираем из проекта → его кэш — «старый»; ждём автосохранение (программа защищает и его медиа)
  store.removeMedia(ve);
  await sleep(2500);
  const { projectCacheKeep } = await import('./js/settings.js');
  const keep = projectCacheKeep();
  check(keep.includes(bKey) && !keep.includes(eKey), 'keep list = project media');
  // Лимит 1 байт: всё незащищённое уходит, файлы открытого проекта (больше лимита) остаются
  const ac1 = await invoke('cache_autoclean', { keep, test: { limitBytes: 1, recentSecs: 0 } });
  log.push(`autoclean: ${JSON.stringify(ac1)}`);
  check(ac1.removed >= 1 && ac1.freed > 0, `LRU removed old cache: ${ac1.removed}`);
  check(ac1.protected > 1, `project media protected although > limit: ${ac1.protected}`);
  check((await fetch(bThumb)).ok, 'project thumbnails kept');
  check(!(await fetch(eThumb)).ok, 'removed media thumbnails gone');
  // Без test-параметров (лимит 1 ГБ) — ничего не удаляется
  const ac2 = await invoke('cache_autoclean', { keep });
  check(ac2.removed === 0, `normal limit: nothing removed (${ac2.removed})`);

  // Очистка по категориям: миниатюры открытого проекта не трогаем
  const cl = await window.api.cacheClear(['thumbs', 'assets'], keep);
  check(cl.kept >= 1 && (await fetch(bThumb)).ok, `cache_clear keeps project: kept ${cl.kept}`);

  // --- Окно настроек: ползунок лимита ---
  openSettings('cache');
  await sleep(1500);
  const slider = document.querySelector('#cache-limit');
  check(!!slider && slider.min === '1' && slider.max === '50' && slider.step === '1' && slider.value === '1', `slider 1..50 step 1, value ${slider?.value}`);
  check(/1/.test(document.querySelector('#cache-limit-val')?.textContent || '') && !!document.querySelector('#cache-used')?.textContent, `limit label: ${document.querySelector('#cache-limit-val')?.textContent} · ${document.querySelector('#cache-used')?.textContent}`);
  check(document.querySelectorAll('.cache-row').length === 11, // + «Звук после аудиоплагинов»
    `cache rows: ${document.querySelectorAll('.cache-row').length}`);
  slider.value = '3';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  check(/3/.test(document.querySelector('#cache-limit-val').textContent), 'label follows slider');
  await sleep(1800);
  s = await window.api.settingsGet();
  check(s.settings.cache?.limitGb === 3, `cache.limitGb saved: ${JSON.stringify(s.settings.cache)}`);
  check((await window.api.cacheStats()).limitGb === 3, 'Rust reads the new limit');
  await window.api.testShot('settings-cache-16').catch(() => {});
  document.querySelector('.set-tab[data-section="folders"]').click();
  await sleep(1500);
  check(document.querySelector('#data-places')?.dataset.mode === 'custom', 'folders: data places block');
  document.querySelector('#data-places')?.scrollIntoView();
  await sleep(200);
  await window.api.testShot('settings-folders-16').catch(() => {});
  for (const o of document.querySelectorAll('.modal-overlay')) o.remove();
  await prefs.setPrefs({ ui: null, export: null, cache: null });
  return { log, errors };
})();
