// Тест 7 (0.4): скорость клипа ×0.1–×16, «Сдвигать следующие клипы», связанный звук, плеер, разрез, экспорт.
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
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const auds = () => store.project.audioTracks.flatMap((t) => t.clips);
  const end = (c) => c.start + (c.out - c.in) / (c.speed || 1);
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  const tab = (id) => document.querySelector(`#rp-tabs [data-tab="${id}"]`);
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b); timeline.addMedia(b);
    await sleep(250);
    let v = vids();
    ok(v.length === 2 && near(v[1].start, 8), 'два клипа по 8 с встык');
    const v0 = v[0].id; const v1 = v[1].id;
    const partner = () => auds().find((a) => a.link && a.link === store.findClip(v0).clip.link);

    // --- Правая панель: раздел «Скорость» ---
    tab('props').click();
    store.select({ kind: 'video', id: v0 }); await sleep(80);
    const sec = document.querySelector('#inspector [data-section="speed"]');
    ok(!!sec, 'раздел «Скорость» в свойствах видеоклипа');
    ok(sec && !document.querySelector('#speed-ripple').checked, '«Сдвигать следующие клипы» по умолчанию выключено');

    // ×2 без сдвига: клип 4 с, сосед стоит, пустота 4–8
    sec.querySelector('[data-speed="2"]').click(); await sleep(80);
    let c0 = store.findClip(v0).clip;
    ok(c0.speed === 2 && near(end(c0), 4) && c0.in === 0 && c0.out === 8, `×2: клип 0–${end(c0).toFixed(2)}, фрагмент файла тот же`);
    ok(near(store.findClip(v1).clip.start, 8), 'без сдвига следующий клип на месте');
    const pa = partner();
    ok(pa && pa.speed === 2 && near(pa.start, 0) && near(end(pa), 4), 'связанный звук тоже ×2');
    ok(!!document.querySelector(`.clip[data-id="${v0}"] .ci.speed`), 'на клипе значок ×2');

    // Плеер: на 1 с таймлайна — 2 с файла, playbackRate 2
    store.setTime(1); await sleep(300);
    const shown = preview.slots.find((s) => s.classList.contains('on'));
    ok(shown && near(shown.currentTime, 2, 0.1) && shown.playbackRate === 2, `плеер: файл ${shown && shown.currentTime.toFixed(2)} с, скорость ${shown && shown.playbackRate}`);

    // Экспорт: setpts и atempo
    const plan = await import('./js/exportPlan.js');
    const cmd = plan.buildExport(store.project, { width: 1280, height: 720, fps: 30 });
    ok(/setpts=\(PTS-STARTPTS\)\/2\.0+/.test(cmd.filter) && /atempo=2\.0+/.test(cmd.filter) && near(cmd.duration, 16), `экспорт: setpts/atempo, длина ${cmd.duration}`);

    // Разрез ускоренного клипа: на 2 с таймлайна = 4 с файла
    store.select({ kind: 'video', id: v0 }); store.setTime(2); await sleep(50);
    timeline.splitAction(); await sleep(80);
    v = vids();
    const left = store.findClip(v0).clip; const right = v.find((x) => near(x.start, 2) && x.id !== v0);
    ok(right && near(left.out, 4) && near(right.in, 4) && right.speed === 2, 'разрез ×2: граница на 4 с файла, у правой половины та же скорость');
    ok(auds().filter((a) => a.speed === 2).length === 2, 'звук разрезан вместе с видео, скорость сохранена');
    store.undo(); await sleep(50);
    store.undo(); await sleep(50);
    ok(!store.findClip(v0).clip.speed && near(end(store.findClip(v0).clip), 8), 'отмена возвращает ×1');

    // ×2 со сдвигом: следующий клип переезжает на 4 с
    store.select({ kind: 'video', id: v0 }); await sleep(60);
    document.querySelector('#speed-ripple').click(); await sleep(30);
    // С M0.6 настройки окна — в settings.json (js/prefs.js), не в localStorage
    const prefs = await import('./js/prefs.js');
    ok(prefs.getPref('ui.speedRipple', false) === true, 'галочка запоминается');
    document.querySelector('#inspector [data-speed="2"]').click(); await sleep(80);
    ok(near(store.findClip(v1).clip.start, 4) && near(store.duration(), 12), `со сдвигом: следующий клип с ${store.findClip(v1).clip.start}, ролик ${store.duration()} с`);
    store.undo(); await sleep(50);
    document.querySelector('#speed-ripple').click(); await sleep(30);

    // ×0,5 без сдвига: клип 16 с накрывает соседа целиком
    store.select({ kind: 'video', id: v0 }); await sleep(60);
    document.querySelector('#inspector [data-speed="0.5"]').click(); await sleep(80);
    ok(store.project.videoClips.length === 1 && near(end(store.findClip(v0).clip), 16), 'замедление без сдвига затирает соседа');
    store.undo(); await sleep(50);
    ok(store.project.videoClips.length === 2, 'отмена возвращает соседа');

    // Поле ввода: 16 — максимум, 40 — обрезается до 16; 0,1 — минимум
    store.select({ kind: 'video', id: v0 }); await sleep(60);
    const inp = document.querySelector('#speed-input');
    inp.value = '40'; inp.dispatchEvent(new Event('change')); await sleep(80);
    ok(store.findClip(v0).clip.speed === 16, 'ввод 40 → ×16');
    const inp2 = document.querySelector('#speed-input');
    inp2.value = '0,1'; inp2.dispatchEvent(new Event('change')); await sleep(80);
    ok(store.findClip(v0).clip.speed === 0.1, 'ввод 0,1 → ×0,1');
    const cmd2 = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
    ok(/atempo=0\.50+,atempo=0\.50+,atempo=0\.50+,atempo=0\.80+/.test(cmd2.filter), 'звук ×0,1: цепочка atempo 0,5·0,5·0,5·0,8');
    store.undo(); store.undo(); await sleep(50);

    // Аудиоклип отдельно (без связи) — у него тоже есть «Скорость»
    const pa2 = partner();
    store.select({ kind: 'audio', id: pa2.id }); await sleep(60);
    ok(!!document.querySelector('#inspector [data-section="speed"]'), 'раздел «Скорость» у аудиоклипа');
    document.querySelector('#inspector [data-speed="1.5"]').click(); await sleep(80);
    ok(store.findClip(v0).clip.speed === 1.5 && partner().speed === 1.5, 'скорость звука меняет и связанное видео');
    store.undo();
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
