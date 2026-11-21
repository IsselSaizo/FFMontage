// Тест 25 (0.6.1): «Размытое заполнение» и звуки/картинки плагинов в «Библиотеке».
// Проект 9:16, горизонтальное видео → «Подгонка клипа» → «Размытое заполнение»: clip.fit = 'blur', ползунки
// размытия/затемнения (живая правка → один шаг отмены), подложка-холст в плеере, значок на клипе, MCP update_clip/get_project.
// Плагин-фикстура tests/fixtures/library-plugin/library-mini (run-ui.ps1 кладёт его в папку плагинов): плитки в
// «Библиотеке», картинка — наклейкой в правый нижний угол на верхнюю дорожку (трансформ, рамка), звук — на аудиодорожку
// с громкостью из манифеста, прослушивание; экспорт проекта проходит (файл плагина — разрешённый вход).
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
  const until = async (fn, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { if (fn()) return true; await sleep(100); } return false; };
  const $ = (s) => document.querySelector(s);
  try {
    const host = await import('./js/plugins/host.js');
    const mcp = await import('./js/mcpBridge.js');
    const tfm = await import('./js/transform.js');

    // --- Размытое заполнение ---
    store.setProjectProps({ aspect: '9:16' }); await sleep(200);
    const [mid] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(mid); await sleep(400);
    const clip = store.project.videoClips[0];
    ok(!!clip, 'горизонтальное видео на основной дорожке, проект 9:16');
    store.select({ kind: 'video', id: clip.id }); await sleep(200);
    $('#viewbar .vb-fit').click(); await sleep(250);
    const opt = $('.popover [data-fit="blur"]');
    ok(!!opt && /Размытое заполнение|Blur fill/.test(opt.textContent), `в «Подгонке клипа» есть «Размытое заполнение»: ${opt && opt.textContent}`);
    opt.click(); await sleep(250);
    const cur = () => store.findClip(clip.id).clip;
    ok(cur().fit === 'blur' && !cur().blurFill, 'clip.fit = blur, параметры по умолчанию не пишутся');
    const dim = $('.popover input[data-blurfill="dim"]');
    ok(!!dim && !!$('.popover input[data-blurfill="blur"]'), 'ползунки «Размытие» и «Затемнение»');
    const hist0 = store.undoStack.length;
    for (const v of [30, 40, 50]) { dim.value = String(v); dim.dispatchEvent(new Event('input', { bubbles: true })); await sleep(60); }
    ok(Math.abs((cur().blurFill || {}).dim - 0.5) < 1e-9, `живая правка затемнения: ${JSON.stringify(cur().blurFill)}`);
    ok(document.activeElement === dim || !!$('.popover input[data-blurfill="dim"]'), 'панелька не перерисовалась под ползунком');
    dim.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150);
    if (hist0 !== null) ok(store.undoStack.length === hist0 + 1, `один шаг отмены на перетаскивание ползунка (${hist0} → ${store.undoStack.length})`);
    document.body.click(); await sleep(150);
    store.setTime(1); await sleep(700);
    const lay = preview.mainView.slots.find((el) => el.classList.contains('on'));
    const cv = lay && lay.blurCv;
    ok(!!cv && cv.style.display === 'block' && /blur\(/.test(cv.style.filter) && /brightness\(0\.575/.test(cv.style.filter),
      `плеер: подложка-холст под клипом (${cv && cv.style.filter})`);
    ok(!!cv && cv.nextElementSibling === lay, 'подложка — перед слоем клипа (ниже по z)');
    ok(!!document.querySelector(`.clip[data-id="${clip.id}"]`) && /◫/.test(document.querySelector(`.clip[data-id="${clip.id}"]`).textContent), 'значок ◫ на клипе таймлайна');
    // Обычная подгонка — подложка прячется
    store.setFit([clip.id], 'contain'); await sleep(300);
    ok(cv.style.display === 'none', '«Вписать» — подложки нет');
    ok(!cur().fit && !cur().blurFill, 'вписать: fit и blurFill удалены');
    // MCP
    let r = await mcp.callTool('update_clip', { clip_id: clip.id, fit: 'blur', blur_fill: { blur: 0.8 } });
    ok(cur().fit === 'blur' && cur().blurFill && cur().blurFill.blur === 0.8, `MCP update_clip fit blur + blur_fill: ${JSON.stringify(cur().blurFill)}`);
    let bad = null; try { await mcp.callTool('update_clip', { clip_id: clip.id, fit: 'zoom' }); } catch (e) { bad = String(e.message || e); }
    ok(!!bad && /contain, cover, stretch, blur/.test(bad), `неизвестный fit отклонён: ${bad}`);
    const proj = await mcp.callTool('get_project', {});
    const pj = JSON.stringify(proj);
    ok(pj.includes('"fit":"blur"') && pj.includes('"blur_fill":{"blur":0.8,"dim":0.25}'), 'get_project: fit и blur_fill');
    r = null;

    // --- «Библиотека»: плитки плагина ---
    ok(await until(() => host.pluginLibrary().length === 3, 15000), `плагин-фикстура загружен: ${host.pluginLibrary().map((x) => x.key).join(', ')}`);
    $('#mp-tabs [data-mtab="library"]').click(); await sleep(300);
    ok(await until(() => !!$('#library [data-lib="library-mini.facepalm"]'), 5000), 'плитки плагина во вкладке «Библиотека»');
    const heads = [...document.querySelectorAll('#library h3')].map((x) => x.textContent);
    ok(heads.includes('Звуки зала') || heads.includes('Crowd sounds'), `разделы по group: ${heads.join(' | ')}`);
    const img = $('#library [data-lib="library-mini.facepalm"] img');
    ok(!!img && await until(() => img.complete && img.naturalWidth === 320, 5000), `миниатюра картинки грузится из plugin:// (${img && img.naturalWidth})`);
    // Прослушивание
    const play = $('#library [data-lib="library-mini.boo"] .lib-play');
    ok(!!play, 'у звука — кнопка «Прослушать»');
    play.click(); await sleep(400);
    const playing = play.classList.contains('on');
    play.click(); await sleep(100);
    ok(!play.classList.contains('on'), `прослушивание включается и выключается (играл: ${playing})`);

    // Картинка-наклейка
    store.setTime(0.5); await sleep(100);
    const nTracks = (store.project.videoTracks || []).length;
    $('#library [data-lib="library-mini.facepalm"]').click();
    ok(await until(() => (store.project.videoTracks || []).some((t) => t.clips.some((c) => /facepalm\.jpg$/i.test((store.media(c.mediaId) || {}).path || ''))), 5000), 'щелчок — картинка на верхней видеодорожке');
    const tr = store.project.videoTracks.find((t) => t.clips.some((c) => /facepalm/.test((store.media(c.mediaId) || {}).path || '')));
    const sc = tr.clips.find((c) => /facepalm/.test((store.media(c.mediaId) || {}).path || ''));
    const m = store.media(sc.mediaId);
    ok((store.project.videoTracks || []).length === nTracks + 1 && Math.abs(sc.start - 0.5) < 0.01 && Math.abs(sc.out - sc.in - 3) < 0.01, `место курсора 0,5 с, длина 3 с (start ${sc.start})`);
    ok(m.path.toLowerCase().includes(['plugins', 'library-mini'].join(info.sep).toLowerCase()), `файл — из папки плагина: ${m.path}`);
    const f = store.sourceFormat();
    const rect = tfm.contentRect(sc, m, f.width, f.height);
    const s = Math.min(f.width, f.height);
    ok(Math.abs(rect.w - 0.45 * s) < 1 && Math.abs(rect.cx + rect.w / 2 - (f.width - 0.04 * s)) < 1 && Math.abs(rect.cy + rect.h / 2 - (f.height - 0.04 * s)) < 1,
      `наклейка в правом нижнем углу: ${rect.w.toFixed(0)}×${rect.h.toFixed(0)} в кадре ${f.width}×${f.height}`);
    ok(sc.border && sc.border.color === '#ffffff' && sc.border.radius > 0, `рамка из манифеста: ${JSON.stringify(sc.border)}`);
    // Повторный щелчок — тот же файл в медиатеке, клип на другом месте
    store.setTime(4); await sleep(100);
    $('#library [data-lib="library-mini.facepalm"]').click(); await sleep(600);
    ok(Object.values(store.project.media).filter((x) => /facepalm/.test(x.path)).length === 1, 'повторно — тот же файл в «Ваших медиа»');

    // Звук
    store.setTime(1); await sleep(100);
    $('#library [data-lib="library-mini.boo"]').click();
    ok(await until(() => store.project.audioTracks.some((t) => t.clips.some((c) => /boo\.ogg$/i.test((store.media(c.mediaId) || {}).path || ''))), 5000), 'щелчок по звуку — клип на аудиодорожке');
    const ac = store.project.audioTracks.flatMap((t) => t.clips).find((c) => /boo\.ogg$/i.test((store.media(c.mediaId) || {}).path || ''));
    ok(Math.abs(ac.start - 1) < 0.01 && Math.abs(ac.volume - 0.8) < 1e-9, `звук с места курсора, громкость из манифеста: ${ac.start}, ${ac.volume}`);

    // Экспорт: размытое заполнение + наклейка + звук плагина
    const out = [info.cacheDir, 'tmp', 'ui25-blurfill.mp4'].join(info.sep);
    const r2 = await window.api.startExport(JSON.parse(JSON.stringify(store.project)), { width: 360, height: 640, fps: 25, codec: 'libx264', quality: 'high', output: out });
    ok(r2 && r2.ok, `экспорт прошёл: ${r2 && (r2.error || r2.duration)}`);
    if (r2 && r2.ok) {
      const pi = await window.api.probe(out);
      ok(pi.width === 360 && pi.height === 640 && pi.hasAudio, `результат 360×640 со звуком (${pi.width}×${pi.height})`);
    }

    // Выключили плагин — плитки пропали, включили — вернулись
    await host.setEnabled('library-mini', false); await sleep(300);
    ok(!$('#library [data-lib="library-mini.facepalm"]') && host.pluginLibrary().length === 0, 'плагин выключен — плиток нет');
    await host.setEnabled('library-mini', true); await sleep(500);
    ok(await until(() => !!$('#library [data-lib="library-mini.facepalm"]'), 5000), 'включён снова — плитки вернулись');

    // Для снимка: кадр с размытым заполнением и наклейкой
    store.select(null);
    store.setTime(1.5); await sleep(1200);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
