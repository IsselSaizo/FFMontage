// Тест 13 (M0.1 + M3): плагины. Нужна фикстура tests/fixtures/plugins/selftest-plugin — run-ui.ps1 кладёт её
// в FFM_PLUGINS_DIR (<T>\plugins). Проверяет: плагин в списке, его эффект в «Фильтрах» и в плане экспорта,
// переход и аудиоэффект в реестре, действие по клавише, пресет клавиш, storage, отказ без project:write,
// песочницу панели (нет доступа к окну, IPC и сети), выключение плагина и проект с пропавшим плагином.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 100; i++) { try { const v = await fn(); if (v) return v; } catch { /* ещё нет */ } await sleep(100); } return null; };
  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${String(e.reason && e.reason.message || e.reason)}`));
  const PID = 'selftest-plugin';
  const FX = `${PID}.vig`;

  // Все уведомления (тосты), включая те, что уже исчезли
  const toasts = [];
  const grab = (el) => { if (el && el.classList && el.classList.contains('toast')) toasts.push(el.textContent); };
  document.querySelectorAll('.toast').forEach(grab);
  new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach(grab); }).observe(document.body, { childList: true, subtree: true });
  const toastWith = (s) => until(() => toasts.find((x) => x.includes(s)), 8000);

  await until(() => window.__ffm, 8000);
  const { store, timeline, importPaths, plugins, loadProjectText, openSettings } = window.__ffm;
  const keymap = await import('./js/keymap.js');
  const registry = await import('./js/registry.js');
  const plan = await import('./js/exportPlan.js');
  const tab = (id) => document.querySelector(`#rp-tabs [data-tab="${CSS.escape(id)}"]`);
  try {
    ok(!window.__TAURI__, 'window.__TAURI__ нет (withGlobalTauri: false)');
    ok(!!plugins, 'хост плагинов загружен');

    // --- Плагин в списке ---
    const item = await until(() => plugins.pluginList().find((p) => p.id === PID && p.active), 6000);
    ok(!!item, `плагин в списке и включён: ${JSON.stringify(plugins.pluginList().map((p) => [p.id, p.active, p.error]))}`);
    ok(item && !item.error && !item.problems.length, `без ошибок регистрации: ${item && JSON.stringify([item.error, item.problems])}`);
    ok(item && item.name === 'Самопроверка плагинов', `имя по языку: ${item && item.name}`);
    ok(item && item.permissions.some((p) => p.id === 'project:read') && !item.permissions.some((p) => p.id === 'project:write'), 'права из манифеста');
    ok(plugins.pluginList().some((p) => p.id === 'core' && p.builtin), 'встроенный core в списке');

    // --- Раздел настроек ---
    openSettings('plugins'); await sleep(400);
    const card = document.querySelector(`.plg-item[data-plugin="${PID}"]`);
    ok(!!card && !!card.querySelector('.plg-toggle') && !!card.querySelector('.plg-remove'), 'настройки: карточка плагина с переключателем и «Удалить»');
    const coreCard = document.querySelector('.plg-item[data-plugin="core"]');
    ok(!coreCard || !coreCard.querySelector('.plg-remove'), 'настройки: core без удаления');
    document.querySelector('.settings-overlay .modal-head .icon-btn')?.click(); await sleep(100);

    // --- Реестр: эффект, переход, аудиоэффект, эффект из кода ---
    const ids = (list) => (typeof list === 'function' ? list() : []).map((x) => x.id);
    ok(ids(registry.listEffects).includes(FX), 'эффект плагина в реестре');
    ok(ids(registry.listTransitions).includes(`${PID}.fadeblack`), 'переход плагина в реестре');
    ok(ids(registry.listAudioEffects).includes(`${PID}.quiet`), 'аудиоэффект плагина в реестре');

    // --- Логика плагина: проверки API и прав (итог в storage) ---
    const st = await until(async () => { const s = await window.api.pluginStorageGet(PID); return s && s.entry ? s : null; }, 6000);
    ok(!!st, 'логика плагина записала итог в storage');
    const en = (st && st.entry) || { checks: {} };
    const c = en.checks || {};
    log.push(`entry: ${JSON.stringify(en)}`);
    ok(en.pluginId === PID && en.lang === 'ru' && en.apiVersion === 1, `ffm.pluginId/lang/apiVersion: ${en.pluginId}/${en.lang}/${en.apiVersion}`);
    ok(c['project.get'] === 'ok' && en.projectShape, 'project.get с project:read');
    ok(/^denied/.test(c['commands.execute'] || ''), `commands.execute без project:write — отказ (${c['commands.execute']})`);
    ok(/^denied/.test(c['tools.split_clip'] || ''), `tools.call split_clip без project:write — отказ (${c['tools.split_clip']})`);
    ok(/^denied/.test(c['tools.export_video'] || '') && /^denied/.test(c['tools.import_media'] || ''), 'файловые и экспортные инструменты запрещены');
    ok(c['tools.get_project'] === 'ok', `tools.call get_project с project:read (${c['tools.get_project']})`);
    ok(/^denied/.test(c['net.fetch'] || ''), `net.fetch без net: — отказ (${c['net.fetch']})`);
    ok(c['register.effect'] === 'ok' && ids(registry.listEffects).includes(`${PID}.dyn`), `register.effect из кода (${c['register.effect']})`);
    ok(/^denied/.test(c['register.effect.badFilter'] || ''), `фильтр вне manifest.ffmpeg.filters — отказ (${c['register.effect.badFilter']})`);
    ok(en.listHasFileActions === false && en.commandsCount > 0, 'commands.list без файловых действий');
    // итог storage.set в сам сохранённый объект попасть не может — достаточно, что запись дошла до диска
    ok(!!st && st.runs >= 1 && c['storage.get'] === 'ok', 'storage.set сохраняет');

    // --- Эффект плагина в «Фильтрах» и на клипе ---
    const info = await window.api.info();
    const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b); timeline.addMedia(b);
    await sleep(300);
    const v = store.project.videoClips.slice().sort((x, y) => x.start - y.start);
    store.select({ kind: 'video', id: v[0].id }); store.setTime(1);
    tab('effects').click(); await sleep(100);
    const tile = document.querySelector(`#browse-effects .fx-tile[data-fx="${CSS.escape(FX)}"]`);
    ok(!!tile && !tile.disabled, 'эффект плагина виден в «Фильтрах»');
    ok(tile && /виньетка/i.test(tile.textContent), `название эффекта по языку: ${tile && tile.textContent}`);
    tile?.click(); await sleep(100);
    ok((store.findClip(v[0].id).clip.effects || []).includes(FX), 'щелчок применяет эффект плагина к клипу');
    let cmd = plan.buildExport(store.project, { width: 1280, height: 720, fps: 30 });
    ok(/vignette=/.test(cmd.filter), 'план экспорта содержит фильтр vignette');
    tab('transitions').click(); await sleep(100);
    ok(!!document.querySelector(`#browse-transitions .tr-tile[data-type="${CSS.escape(`${PID}.fadeblack`)}"]`), 'переход плагина виден в «Переходах»');

    // --- Действие плагина по клавише и пресет клавиш ---
    const act = keymap.actionById(`${PID}.ping`);
    ok(!!act && act.cat === 'plugins', 'действие плагина в реестре клавиш, категория «Плагины»');
    ok(keymap.keysOf(`${PID}.ping`).includes('Ctrl+Alt+KeyP'), 'клавиша действия из манифеста');
    const pr = keymap.PRESETS[`${PID}.test`];
    ok(!!pr && JSON.stringify(pr.keys[`${PID}.ping`]) === '["Ctrl+Alt+KeyO"]' && !!pr.keys['clip.split'], 'пресет клавиш плагина');
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', key: 'p', ctrlKey: true, altKey: true, bubbles: true }));
    ok(!!(await toastWith('SELFTEST:pong 1')), 'Ctrl+Alt+P выполняет действие плагина (уведомление)');
    const st2 = await until(async () => { const s = await window.api.pluginStorageGet(PID); return s && s.pings >= 1 ? s : null; }, 4000);
    ok(!!st2 && st2.entry && st2.runs >= 1, 'storage: данные действия сохранились рядом с прежними');

    // --- Песочница панели ---
    const ptab = tab(`plugin:${PID}:sandbox`);
    ok(!!ptab, 'вкладка панели плагина справа');
    ptab?.click(); await sleep(200);
    const panel = document.querySelector(`.plugin-panel[data-plugin="${PID}"]`);
    const frame = panel && panel.querySelector('iframe');
    ok(!!panel && !panel.hidden && !!frame, 'панель плагина открыта');
    ok(frame && frame.getAttribute('sandbox') === 'allow-scripts', `iframe sandbox="${frame && frame.getAttribute('sandbox')}"`);
    ok([...document.querySelectorAll('iframe')].every((f) => f.getAttribute('sandbox') === 'allow-scripts'), 'у всех фреймов плагинов только allow-scripts');
    ok(!!(await until(() => keymap.actionById(`${PID}.report`), 15000)), 'панель зарегистрировала действие (register.action)');
    keymap.runAction(`${PID}.report`);
    const rep = await toastWith('SANDBOX:');
    let sb = null;
    try { sb = JSON.parse(rep.slice(rep.indexOf('SANDBOX:') + 8)); } catch { /* ниже FAIL */ }
    log.push(`sandbox: ${rep}`);
    ok(!!sb && Object.keys(sb).length >= 6, 'панель сообщила итог проверки песочницы');
    for (const k of ['parentDocument', 'topLocation', 'tauriInternals', 'tauriGlobal', 'ipcFetch', 'internet', 'localStorage', 'popup']) {
      ok(sb && sb[k] === 'blocked', `песочница: ${k} — ${sb && sb[k]}`);
    }

    // --- Выключение плагина ---
    await plugins.setEnabled(PID, false);
    await sleep(300);
    ok(!ids(registry.listEffects).includes(FX) && !ids(registry.listEffects).includes(`${PID}.dyn`), 'выключение убирает эффекты из реестра');
    tab('effects').click(); await sleep(100);
    ok(!document.querySelector(`#browse-effects .fx-tile[data-fx="${CSS.escape(FX)}"]`), 'выключение убирает эффект из «Фильтров»');
    ok(!tab(`plugin:${PID}:sandbox`) && !document.querySelector(`.plugin-panel[data-plugin="${PID}"]`), 'выключение убирает вкладку панели');
    ok(!keymap.actionById(`${PID}.ping`) && !keymap.PRESETS[`${PID}.test`], 'выключение убирает действия и пресет');
    ok(!document.querySelectorAll('iframe').length, 'фреймы плагина удалены');
    ok((store.findClip(v[0].id).clip.effects || []).includes(FX), 'id эффекта выключенного плагина остался в клипе');
    cmd = plan.buildExport(store.project, { width: 1280, height: 720, fps: 30 });
    ok(!/vignette/.test(cmd.filter), 'без плагина эффект не попадает в экспорт');
    const s = await window.api.settingsGet();
    ok(s.settings.plugins && s.settings.plugins.disabled.includes(PID), 'settings.plugins.disabled запомнен');

    // --- Проект с эффектом пропавшего плагина ---
    const j = JSON.parse(store.serialize());
    j.project.videoClips[0].effects = ['ghostplug.glow'];
    await loadProjectText(JSON.stringify(j), null);
    await sleep(200);
    ok(!!(await toastWith('ghostplug')), 'при открытии — предупреждение о пропавшем плагине');
    const c0 = store.project.videoClips.slice().sort((x, y) => x.start - y.start)[0];
    ok(JSON.stringify(c0.effects) === '["ghostplug.glow"]', `id пропавшего эффекта сохранился: ${JSON.stringify(c0.effects)}`);
    ok(store.serialize().includes('ghostplug.glow'), 'и попадает в сохранённый проект');
    const miss = registry.missingIds(store.project);
    ok(miss && miss.effects.includes('ghostplug.glow'), 'registry.missingIds находит его');

    // --- Включение обратно ---
    await plugins.setEnabled(PID, true);
    ok(!!(await until(() => ids(registry.listEffects).includes(FX), 3000)), 'включение возвращает эффект');
    ok(!!(await until(() => tab(`plugin:${PID}:sandbox`), 3000)), 'и вкладку панели');
  } catch (err) { errors.push(String(err && err.stack || err)); }
  await window.api.testShot('ui-selftest13').catch(() => {});
  return { log, errors };
})();
