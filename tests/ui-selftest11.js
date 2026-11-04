// Окно настроек, горячие клавиши (пресеты, переназначение, конфликты), кэш и перевод интерфейса.
//   tests\run-ui.ps1 ui-selftest11            — русский интерфейс
//   tests\run-ui.ps1 ui-selftest11 -Lang en   — английский: в видимом тексте и подсказках не должно остаться кириллицы
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const errors = [];
  const check = (ok, msg) => { if (ok) log.push(`ok: ${msg}`); else errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  for (let i = 0; i < 80 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, openSettings } = window.__ffm;
  const km = await import('./js/keymap.js');
  const i18n = await import('./js/i18n.js');
  const lang = i18n.getLang();
  log.push(`lang ${lang}`);
  const key = (code, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key: opts.key || code, bubbles: true, ...opts }));
  const closeAll = () => { for (const o of document.querySelectorAll('.modal-overlay')) o.remove(); };

  // Кириллица в видимом тексте и подсказках (только для английского интерфейса)
  const CYR = /[А-Яа-яЁё]/;
  const leftovers = new Set();
  const scan = (root = document.body) => {
    if (lang !== 'en') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent.trim();
      if (s && s !== 'Русский' && CYR.test(s) && n.parentElement && n.parentElement.closest('[hidden]') === null) leftovers.add(s.slice(0, 80));
    }
    for (const el of root.querySelectorAll('[title],[placeholder]')) {
      for (const a of ['title', 'placeholder']) { const v = el.getAttribute(a); if (v && CYR.test(v)) leftovers.add(`${a}: ${v.slice(0, 80)}`); }
    }
  };

  // Немного содержимого, чтобы панели были не пустыми
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const media = await window.__ffm.importPaths([dir + 'b_h264_1080p30.mp4', dir + 'c_music.mp3']);
  if (media[0]) timeline.addMedia(media[0]);
  if (media[1]) store.addAudioClip(media[1], 0);
  await sleep(800);
  store.select({ kind: 'video', id: store.project.videoClips[0]?.id });
  await sleep(300);
  scan();
  for (const mode of ['audio', 'anim', 'video']) { document.querySelector(`.mode-tab[data-mode="${mode}"]`)?.click(); await sleep(300); scan(); }
  for (const tab of document.querySelectorAll('#rp-tabs button')) { tab.click(); await sleep(150); scan(); }
  // Контекстное меню клипа
  const clipEl = document.querySelector('.clip');
  if (clipEl) { const r = clipEl.getBoundingClientRect(); clipEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 })); await sleep(200); scan(); key('Escape', { key: 'Escape' }); document.body.click(); }
  // Окно экспорта
  window.__ffm.openExport(); await sleep(600); scan(); closeAll();

  // --- Окно настроек: все разделы ---
  openSettings('general');
  await sleep(200);
  check(!!document.querySelector('#settings'), 'settings window opens');
  const sections = [...document.querySelectorAll('.set-tab')].map((b) => b.dataset.section);
  check(sections.join() === 'general,hotkeys,folders,cache,mcp,plugins,about', `sections: ${sections.join()}`);
  for (const s of sections) {
    document.querySelector(`.set-tab[data-section="${s}"]`).click();
    await sleep(s === 'cache' || s === 'folders' ? 1500 : 300);
    check(document.querySelector('.set-body').dataset.section === s && document.querySelector('.set-body').childElementCount > 1, `section ${s} renders`);
    if (s === 'cache' || s === 'general') await window.api.testShot(`settings-${s}-${lang}`).catch(() => {});
    if (s === 'cache') check(document.querySelectorAll('.cache-row').length === 10 && !!document.querySelector('#cache-limit'), `cache rows: ${document.querySelectorAll('.cache-row').length}`);
    scan(document.querySelector('#settings'));
  }

  // --- Горячие клавиши ---
  document.querySelector('.set-tab[data-section="hotkeys"]').click(); await sleep(200);
  const rows = document.querySelectorAll('.hk-row').length;
  check(rows === km.ACTIONS.length, `hotkey rows ${rows} = actions ${km.ACTIONS.length}`);
  const sel = document.querySelector('#hk-preset');
  sel.value = 'premiere'; sel.dispatchEvent(new Event('change')); await sleep(300);
  check(km.keysOf('clip.split').join() === 'Ctrl+KeyK' && km.keysOf('tool.blade').join() === 'KeyC', `premiere preset: split=${km.keysOf('clip.split')} blade=${km.keysOf('tool.blade')}`);
  // поиск
  const search = document.querySelector('#hk-search');
  search.value = 'Ctrl+K'; search.dispatchEvent(new Event('input')); await sleep(100);
  check([...document.querySelectorAll('.hk-row')].some((r) => r.dataset.action === 'clip.split'), 'search by key finds split');
  search.value = ''; search.dispatchEvent(new Event('input'));
  // запись своего сочетания: + у «Разрезать», нажимаем Shift+X
  document.querySelector('.hk-row[data-action="clip.split"] .hk-tools button').click(); await sleep(100);
  check(!!document.querySelector('.hk-row.recording'), 'recording mode');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'X', shiftKey: true, bubbles: true }));
  await sleep(200);
  check(km.keysOf('clip.split').join() === 'Ctrl+KeyK,Shift+KeyX' && km.isCustom('clip.split'), `custom split keys: ${km.keysOf('clip.split')}`);
  // конфликт: та же клавиша у «Лезвия»
  document.querySelector('.hk-row[data-action="tool.blade"] .hk-tools button').click(); await sleep(100);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'X', shiftKey: true, bubbles: true }));
  await sleep(200);
  check(km.conflicts().has('Shift+KeyX') && document.querySelectorAll('.hk-key.conflict').length >= 2, 'conflict highlighted');
  await window.api.testShot(`settings-hotkeys-${lang}`).catch(() => {});
  const saved = await window.api.settingsGet();
  check(saved.settings.keymap?.preset === 'premiere' && saved.settings.keymap.keys['clip.split']?.includes('Shift+KeyX'), 'keymap saved to settings.json');
  closeAll();
  // Срабатывание по новой клавише: C (Premiere) — лезвие
  timeline.setTool('select');
  key('KeyC', { key: 'c' }); await sleep(50);
  check(timeline.tool === 'blade', `C → blade (tool=${timeline.tool})`);
  key('KeyV', { key: 'v' }); await sleep(50);
  check(timeline.tool === 'select', `V → select (tool=${timeline.tool})`);
  // подсказки кнопок обновились
  const undoTip = document.querySelector('[data-tip-action="edit.undo"]')?.title || '';
  check(/Ctrl\+Z/.test(undoTip), `undo tooltip: ${undoTip}`);
  // Сброс
  km.configureKeymap({});
  await window.api.settingsSet({ keymap: null });
  check(km.keysOf('clip.split').join() === 'KeyS', 'reset to native');

  // Окно настроек открывается по Ctrl+,
  key('Comma', { key: ',', ctrlKey: true }); await sleep(200);
  check(!!document.querySelector('#settings'), 'Ctrl+, opens settings');
  closeAll();

  if (lang === 'en') check(leftovers.size === 0, `no Cyrillic in UI (${leftovers.size}): ${[...leftovers].slice(0, 25).join(' | ')}`);
  return { log, errors };
})();
