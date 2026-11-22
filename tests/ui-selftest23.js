// Тест 23 (fx-restore, этап 2): шторка «ДО / ПОСЛЕ» в плеере (js/compare.js, Rust compare.rs).
// Эффект с preview: 'frame' регистрируется тестом через реестр; в инспекторе — пометка и «Сравнить»;
// два кадра FFmpeg (ДО цветной, ПОСЛЕ — чёрно-белый), перетаскивание границы, вертикальный/горизонтальный разрез,
// пересчёт при перемотке, закрытие по Esc / «×» / воспроизведению, понятная ошибка FFmpeg, гизмо после закрытия.
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
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  const until = async (fn, ms = 20000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
  const ptr = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
  const dragTo = async (el, x0, y0, x1, y1) => {
    ptr('pointerdown', x0, y0, el);
    for (let k = 1; k <= 6; k++) { ptr('pointermove', x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6); await sleep(16); }
    ptr('pointerup', x1, y1); await sleep(60);
  };
  // Средняя насыщенность картинки (|r−g|+|g−b| по сетке) — цветные полосы против чёрно-белого
  const sat = async (img) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]);
    return s / (d.length / 4);
  };
  try {
    const cmp = await import('./js/compare.js');
    const reg = await import('./js/registry.js');
    const owner = { id: 'uitest-cmp', filters: new Set(['hqdn3d']) };
    const fxId = reg.registerEffect({ id: 'dn', name: { ru: 'Шумодав (тест)', en: 'Denoise (test)' }, preview: 'frame',
      params: [{ k: 's', name: 'S', min: 0, max: 10, step: 1, def: 4 }],
      ffmpeg: [{ filter: 'hqdn3d', args: ['{s:0}', '3', '6', '4'] }] }, owner);
    ok(fxId === 'uitest-cmp.dn', `эффект с preview: frame зарегистрирован: ${fxId}`);

    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b); await sleep(300);
    const clip = store.project.videoClips[0];
    ok(!!clip, 'клип на таймлайне');
    store.select({ kind: 'video', id: clip.id }); await sleep(100);
    ok(!document.querySelector('#fx-compare'), 'без такого эффекта кнопки «Сравнить» нет');
    store.setClip(clip.id, { effects: [fxId, 'bw'] }); await sleep(150);
    store.setTime(2); await sleep(300);
    const btn = document.querySelector('#inspector #fx-compare');
    const note = document.querySelector('#inspector .fx-frame-note');
    ok(!!btn && !!note && /экспорт|export/i.test(note.textContent), `инспектор: пометка «${note && note.textContent.trim()}» и кнопка`);

    // --- «Сравнить»: пауза, «Считаю кадр…», два кадра ---
    preview.play(); await sleep(200);
    btn.click();
    ok(!preview.playing, 'видео встало на паузу');
    const layer = document.querySelector('.cmp-layer');
    ok(layer && layer.classList.contains('on') && cmp.compareState().busy, 'шторка открыта, индикатор «Считаю кадр…»');
    ok(await until(() => cmp.compareState() && cmp.compareState().shown && !cmp.compareState().busy), 'оба кадра пришли');
    const [imgA, imgB] = [layer.querySelector('.cmp-img.before'), layer.querySelector('.cmp-img.after')];
    ok(imgA.naturalWidth > 0 && imgB.naturalWidth > 0 && imgA.naturalWidth <= 1920, `кадры ${imgA.naturalWidth}×${imgA.naturalHeight}`);
    const sA = await sat(imgA); const sB = await sat(imgB);
    ok(sA > 40 && sB < 12, `ДО цветной (${sA.toFixed(1)}), ПОСЛЕ чёрно-белый (${sB.toFixed(1)})`);
    ok(document.querySelector('#inspector #fx-compare').classList.contains('on'), 'кнопка подсвечена, пока шторка открыта');
    const box = layer.querySelector('.cmp-box');
    const br = box.getBoundingClientRect(); const sr = preview.stage.getBoundingClientRect();
    ok(near(br.width, sr.width, 2) && near(br.height, sr.height, 2), `кадры — в рамке клипа (на весь кадр ${br.width.toFixed(0)}×${br.height.toFixed(0)})`);
    ok([...layer.querySelectorAll('.cmp-tag')].map((x) => x.textContent).join('/').length > 3, 'подписи «ДО» / «ПОСЛЕ»');

    // --- граница мышью ---
    const line = layer.querySelector('.cmp-line');
    let lr = line.getBoundingClientRect();
    const sel0 = store.selection && store.selection.id;
    await dragTo(line, lr.left + lr.width / 2, lr.top + lr.height / 2, br.left + br.width * 0.25, lr.top + lr.height / 2);
    ok(near(cmp.compareState().pos, 0.25, 0.02) && /inset\(0(px)? 0(px)? 0(px)? 25(\.\d+)?%\)/.test(imgB.style.clipPath), `граница перетащена: ${cmp.compareState().pos.toFixed(3)}, ${imgB.style.clipPath}`);
    ok(!clip.transform && (store.selection && store.selection.id) === sel0, 'перетаскивание границы не двигает клип (гизмо не перехватило)');
    await window.api.testShot('compare-v');

    // --- горизонтальный разрез ---
    layer.querySelector('.cmp-bar [data-dir="h"]').click(); await sleep(60);
    ok(cmp.compareState().dir === 'h' && layer.dataset.dir === 'h' && /^inset\(25(\.\d+)?% 0/.test(imgB.style.clipPath), `горизонтальный: ${imgB.style.clipPath}`);
    lr = line.getBoundingClientRect();
    ok(lr.width > lr.height * 5, 'линия разреза горизонтальная');
    await dragTo(line, lr.left + lr.width / 2, lr.top + lr.height / 2, lr.left + lr.width / 2, br.top + br.height * 0.7);
    ok(near(cmp.compareState().pos, 0.7, 0.02), `граница сверху вниз: ${cmp.compareState().pos.toFixed(3)}`);
    await window.api.testShot('compare-h');
    layer.querySelector('.cmp-bar [data-dir="v"]').click(); await sleep(30);
    ok(cmp.compareState().dir === 'v', 'обратно вертикальный');

    // --- перемотка внутри клипа → пересчёт; смена параметра → пересчёт ---
    const srcBefore = imgA.src;
    store.setTime(4); await sleep(50);
    ok(cmp.compareState() && cmp.compareState().busy, 'перемотка: пересчёт (с задержкой)');
    const fresh = await until(() => cmp.compareState() && !cmp.compareState().busy && imgA.src !== srcBefore, 40000);
    const why = fresh ? '' : ` (${JSON.stringify(cmp.compareState())}, тост: «${[...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ')}»)`;
    ok(fresh, `новые кадры после перемотки${why}`);
    const srcB2 = imgB.src;
    store.setClip(clip.id, { fxp: { [fxId]: { s: 8 } } }); await sleep(50);
    ok(await until(() => cmp.compareState() && !cmp.compareState().busy && imgB.src !== srcB2), 'смена параметра эффекта — пересчёт ПОСЛЕ');

    // --- Esc закрывает ---
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    await sleep(60);
    ok(!cmp.compareState() && !layer.classList.contains('on'), 'Esc закрывает шторку');
    ok(!document.querySelector('#inspector #fx-compare').classList.contains('on'), 'кнопка больше не подсвечена');
    ok(store.selection && store.selection.id === clip.id, 'Esc шторки не снял выделение клипа');

    // --- воспроизведение закрывает, «×» закрывает ---
    cmp.openCompare(clip.id); await sleep(30);
    preview.play(); await sleep(150);
    ok(!cmp.compareState(), 'воспроизведение закрывает шторку');
    preview.pause(); await sleep(100);
    cmp.openCompare(clip.id); await sleep(30);
    layer.querySelector('.cmp-close').click(); await sleep(30);
    ok(!cmp.compareState(), '«×» закрывает шторку');

    // --- ошибка FFmpeg → понятное сообщение ---
    const badId = reg.registerEffect({ id: 'bad', name: 'Bad', preview: 'frame', ffmpeg: [{ filter: 'hqdn3d', args: ['-50'] }] }, owner);
    store.setClip(clip.id, { effects: [badId] }); await sleep(100);
    cmp.openCompare(clip.id);
    ok(await until(() => [...document.querySelectorAll('.toast.error')].some((x) => /сравнения|comparison/i.test(x.textContent))), 'ошибка FFmpeg — тост');
    ok(cmp.compareState() && !cmp.compareState().busy, 'после ошибки индикатор погас');
    cmp.closeCompare();

    // --- гизмо после закрытия на месте ---
    await sleep(100);
    const gz = document.querySelector('.gz-box');
    ok(gz && gz.style.display === 'block', 'гизмо трансформа работает (рамка видна)');
    reg.unregisterPlugin('uitest-cmp');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
