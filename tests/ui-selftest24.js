// Тест 24 (fx-restore, этапы 4–5): стабилизация (встроенный плагин plugins-bundled/stabilize, js/stab.js, stab.rs).
// Клип «трясущегося» видео (stab_shaky.mp4 из node tests/engine-test.js) → «Стабилизация: максимум»: в инспекторе
// пометка «Видно только в экспорте», статус анализа движения доходит до «готово»; чекбокс «Показывать превью» →
// прокси готов, плеер играет его (src слоя — прокси, время сдвинуто на начало отрезка); смена уровня → новое задание;
// выключение — плеер снова на исходнике; get_project отдаёт поле stabilization; вторая стабилизация заменяет первую.
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
  const until = async (fn, ms = 60000) => { for (let i = 0; i < ms / 100; i++) { if (fn()) return true; await sleep(100); } return false; };
  const $ = (s) => document.querySelector(s);
  try {
    const fxm = await import('./js/effects.js');
    const stab = await import('./js/stab.js');
    const media = await import('./js/media.js');
    const mcp = await import('./js/mcpBridge.js');
    ok(await until(() => !!fxm.effectById('stabilize.max'), 15000), 'встроенный плагин «Стабилизация» загружен');
    ok(['stabilize.fast', 'stabilize.balanced', 'stabilize.max'].every((id) => fxm.effectById(id)), 'три уровня: быстрая, баланс, максимум');
    if (!info.vidstab) log.push('note в этой сборке FFmpeg нет vidstab — проверяется только быстрая');

    const [m] = await importPaths([dir + 'stab_shaky.mp4']);
    timeline.addMedia(m); await sleep(300);
    let clip = store.project.videoClips[0];
    ok(!!clip, 'клип на таймлайне');
    // Отрезок 2…6 с файла: анализ — с запасом 1…7 с, прокси начинается с 1 с файла
    store.setClip(clip.id, { in: 2, out: 6 }); await sleep(100);
    clip = store.findClip(clip.id).clip;
    store.select({ kind: 'video', id: clip.id }); await sleep(100);
    const level = info.vidstab ? 'stabilize.max' : 'stabilize.fast';
    store.toggleEffect(clip.id, level); await sleep(200);
    ok(fxm.sourceEffect(store.findClip(clip.id).clip).id === level, `эффект ${level} на клипе`);
    ok(!!$('#inspector #stab-export-only') && /экспорт|export/i.test($('#inspector #stab-export-only').textContent), 'превью выключено — пометка «Видно только в экспорте»');
    ok(!!$('#inspector #stab-preview') && !$('#inspector #stab-preview').checked, 'чекбокс «Показывать превью» выключен по умолчанию');
    ok(!$('#inspector #fx-compare'), 'кнопки «Сравнить» нет (шторка не для стабилизации)');
    if (info.vidstab) {
      const st0 = stab.stabStatus(store.findClip(clip.id).clip);
      ok(st0 && st0.analysis, `анализ запущен: ${st0 && st0.analysis && st0.analysis.state}`);
      ok(await until(() => { const e = $('#inspector [data-stab="analysis"]'); return e && e.dataset.state === 'ready'; }), `анализ движения: «${($('#inspector [data-stab="analysis"]') || {}).textContent}»`);
    }
    const proj = await mcp.callTool('get_project', {});
    const pc = (proj.video_clips || proj.videoClips || []).find((c) => c.id === clip.id) || JSON.stringify(proj).includes('"stabilization"');
    ok(pc && JSON.stringify(proj).includes(`"effect":"${level}"`), 'get_project: поле stabilization');

    // --- превью: прокси со стабилизацией ---
    const src = () => preview.mainView.slots.map((el) => el.dataset.url || '');
    const orig = media.playUrl(clip.mediaId);
    store.setTime(1); await sleep(300);
    ok(src().includes(orig), 'до превью плеер играет исходник');
    $('#inspector #stab-preview').click(); await sleep(200);
    ok(store.findClip(clip.id).clip.fxp[level].showPreview === true, 'чекбокс сохранён в параметрах эффекта клипа');
    ok(!$('#inspector #stab-export-only'), 'пометки «только в экспорте» больше нет');
    ok(await until(() => !!stab.stabPreview(store.findClip(clip.id).clip), 120000), 'прокси превью готов');
    const sp = stab.stabPreview(store.findClip(clip.id).clip);
    ok(sp && /stab/.test(decodeURIComponent(sp.url)) && sp.off === 1, `прокси в stab-кэше, начало отрезка ${sp && sp.off} с`);
    ok(await until(() => { const e = $('#inspector [data-stab="proxy"]'); return e && e.dataset.state === 'ready'; }, 10000), 'инспектор: «Превью: готово»');
    ok(await until(() => src().includes(sp.url), 5000), 'плеер подменил источник на прокси');
    // Момент 1 с таймлайна = 3 с файла = 2 с прокси
    store.setTime(1); await sleep(600);
    const el = preview.mainView.slots.find((x) => x.dataset.url === sp.url);
    ok(el && Math.abs(el.currentTime - 2) < 0.06, `время прокси = время файла − начало отрезка: ${el && el.currentTime.toFixed(3)}`);
    // CSS остальных эффектов — поверх прокси
    store.toggleEffect(clip.id, 'bw'); await sleep(300);
    ok(el && /grayscale/.test(el.style.filter), `остальные эффекты — CSS поверх прокси: ${el && el.style.filter}`);
    store.toggleEffect(clip.id, 'bw'); await sleep(200);
    // Воспроизведение идёт по прокси
    preview.play(); await sleep(1200); preview.pause();
    ok(store.time > 1.5 && store.time < 3.5, `воспроизведение по прокси: время ${store.time.toFixed(2)}`);

    // --- смена уровня → новое задание, чекбокс сохраняется ---
    const other = info.vidstab ? 'stabilize.balanced' : 'stabilize.fast';
    if (info.vidstab) {
      store.toggleEffect(clip.id, other); await sleep(300);
      const c2 = store.findClip(clip.id).clip;
      ok(c2.effects.filter((x) => x.startsWith('stabilize.')).length === 1 && fxm.sourceEffect(c2).id === other, 'вторая стабилизация заменила первую');
      ok(c2.fxp[other] && c2.fxp[other].showPreview === true, 'чекбокс превью перенесён на новый уровень');
      ok(!stab.stabPreview(c2) || stab.stabPreview(c2).url !== sp.url, 'старый прокси больше не показывается');
      ok(await until(() => !!stab.stabPreview(store.findClip(clip.id).clip), 120000), 'новый прокси готов');
      ok(stab.stabPreview(store.findClip(clip.id).clip).url !== sp.url, 'у нового уровня свой прокси');
    }

    // --- экспорт: анализ для нового отрезка не готов — экспорт сначала доделывает его (прогресс «Подготовка») ---
    if (info.vidstab) {
      const out = [info.cacheDir, 'tmp', 'ui24-stab.mp4'].join(info.sep);
      const settings = { width: 320, height: 180, fps: 25, codec: 'libx264', quality: 'high', output: out };
      // отмена во время подготовки
      store.setClip(clip.id, { in: 0.2, out: 5.5 }); await sleep(50);
      const prog = [];
      const off = window.api.onStabPrepare((p) => prog.push(p));
      const run1 = window.api.startExport(JSON.parse(JSON.stringify(store.project)), settings);
      await sleep(30); window.api.cancelExport();
      const r1 = await run1;
      ok(r1 && !r1.ok && r1.cancelled, `отмена экспорта во время анализа: ${JSON.stringify(r1).slice(0, 120)}`);
      store.setClip(clip.id, { in: 0.3, out: 5.4 }); await sleep(50);
      const r2 = await window.api.startExport(JSON.parse(JSON.stringify(store.project)), settings);
      off();
      ok(r2 && r2.ok && Math.abs(r2.duration - 5.1) < 0.2, `экспорт дождался анализа и прошёл: ${r2 && (r2.error || r2.duration)}`);
      ok(prog.some((p) => p.done), `прогресс подготовки (${prog.length} событий)`);
      store.setClip(clip.id, { in: 2, out: 6 }); await sleep(100);
    }

    // --- выключили превью — снова исходник ---
    store.select({ kind: 'video', id: clip.id }); await sleep(200);
    $('#inspector #stab-preview').click(); await sleep(300);
    ok(!stab.stabPreview(store.findClip(clip.id).clip), 'превью выключено — прокси не используется');
    ok(await until(() => src().includes(orig) && !src().some((u) => /stab/.test(decodeURIComponent(u)) && u !== orig), 5000) || src().includes(orig), 'плеер вернулся к исходнику');
    ok(!!$('#inspector #stab-export-only'), 'снова пометка «Видно только в экспорте»');
    // Выключили эффект — статус пропал
    store.toggleEffect(clip.id, fxm.sourceEffect(store.findClip(clip.id).clip).id); await sleep(300);
    ok(!stab.stabStatus(store.findClip(clip.id).clip) && !$('#inspector .fx-stab'), 'эффект выключен — блока стабилизации нет');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
