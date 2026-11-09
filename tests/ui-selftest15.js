// Тест 15 (0.4, M5): текст и субтитры — вкладка «Текст» (стили), текстовый клип на верхней дорожке,
// холст в плеере, инспектор (ввод текста — одна запись в истории), рамка гизмо, обрезка/разрез текста,
// дорожка субтитров (импорт SRT, реплики на таймлайне, перетаскивание, разрез, удаление), показ реплик в плеере,
// сохранение проекта, экспорт с текстом и вшитыми субтитрами (проверка пикселей кадра) и с мягкими (поток mov_text).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, preview, browser } = window.__ffm;
  const info = await window.api.info();
  const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
  const ptr = (type, x, y, target = window, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, ...extra }));
  const dragTo = async (el, x0, y0, x1, y1) => {
    ptr('pointerdown', x0, y0, el);
    for (let k = 1; k <= 6; k++) { ptr('pointermove', x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6); await sleep(16); }
    ptr('pointerup', x1, y1); await sleep(80);
  };
  // Кадр файла (JPEG base64) → функция px(x, y) в долях кадра
  const frameOf = async (file, at) => {
    const data = await window.api.fxFrame(file, at, 320);
    const img = new Image(); img.src = `data:image/jpeg;base64,${data}`; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const px = (fx, fy) => { const x = Math.round(fx * (cv.width - 1)); const y = Math.round(fy * (cv.height - 1)); const i = (y * cv.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const count = (x0, y0, x1, y1, fn) => { let n = 0; for (let y = y0; y < y1; y += 0.01) for (let x = x0; x < x1; x += 0.01) if (fn(px(x, y))) n++; return n; };
    return { px, count };
  };
  const isRed = ([r, g, b]) => r > 170 && g < 90 && b < 90;
  const isYellow = ([r, g, b]) => r > 170 && g > 170 && b < 100;
  try {
    await window.__ffm.fontsReady;
    // --- вкладка «Текст» ---
    browser.show('text'); await sleep(200);
    const tiles = [...document.querySelectorAll('#browse-text .ts-tile')];
    ok(tiles.length >= 5 && tiles.some((x) => x.dataset.style === 'credits'), `вкладка «Текст»: стилей ${tiles.length}`);
    store.setTime(1);
    tiles.find((x) => x.dataset.style === 'title').click(); await sleep(250);
    const tr = store.videoTracks()[0];
    let tc = tr && tr.clips[0];
    // В пустом проекте курсор стоит на 0 (дальше конца не уходит) — текст встаёт туда же; переносим на 1 с
    ok(!!tc && tc.kind === 'text' && near(tc.start, 0) && tc.text.style === 'title', `клип «Заголовок» на верхней дорожке у курсора: ${tc && tc.id} ${tc && tc.text.style}`);
    store.moveVideoClip(tc.id, 1, 'overwrite'); await sleep(100);
    tc = store.findClip(tc.id).clip;
    ok(near(tc.start, 1), `перенос текста на 1 с: ${tc.start}`);
    ok(!!document.querySelector(`.clip.text[data-id="${tc.id}"] .text-strip`), 'на таймлайне — фиолетовый клип с текстом');
    ok(!!document.querySelector('#inspector [data-section="text"] textarea'), 'инспектор: раздел «Текст»');

    // --- плеер: холст текста ---
    store.setTime(2); await sleep(300);
    const v = preview.views.get(tr.id);
    const cv = v && v.textSlots.find((s) => s.classList.contains('on'));
    let painted = 0;
    if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 200) painted++; }
    ok(!!cv && painted > 50, `плеер: текст нарисован на холсте (${painted} точек)`);
    ok(!!document.querySelector('.gz-box') && document.querySelector('.gz-box').style.display === 'block', 'рамка гизмо вокруг текста');

    // --- ввод текста: одна запись в истории ---
    const ta = document.querySelector('#text-content');
    const undo0 = store.undoStack.length;
    ta.focus(); ta.value = 'Привет'; ta.dispatchEvent(new Event('input')); ta.value = 'Привет, мир'; ta.dispatchEvent(new Event('input'));
    // Окно без фокуса системы (другое окно на переднем плане) не получает focus/blur от ta.focus()/blur() — шлём сами
    const hadFocus = document.hasFocus();
    ta.blur();
    if (!hadFocus) ta.dispatchEvent(new FocusEvent('blur'));
    await sleep(150);
    ok(store.findClip(tc.id).clip.text.content === 'Привет, мир' && store.undoStack.length === undo0 + 1, `ввод текста: одна запись в истории (${store.findClip(tc.id).clip.text.content}, ${undo0} → ${store.undoStack.length}, ta ${!!ta} ${ta && ta.isConnected})`);
    ok(document.querySelector(`.clip[data-id="${tc.id}"] .text-strip`).textContent.includes('Привет, мир'), 'таймлайн показывает новый текст');
    // оформление: красная подложка
    store.setText([tc.id], { box: true, boxColor: '#ff0000', boxOpacity: 1, color: '#ffffff' }); await sleep(100);
    ok(store.findClip(tc.id).clip.text.box === true, 'подложка включена');

    // --- разрез и длительность текста (нет файла — длина любая) ---
    store.setTime(2); store.select({ kind: 'video', id: tc.id });
    timeline.splitAction(); await sleep(100);
    const parts = store.videoTracks()[0].clips.filter((c) => c.kind === 'text');
    ok(parts.length === 2 && parts.every((c) => c.in === 0) && parts.every((c) => c.text.content === 'Привет, мир'), `разрез текста: 2 части, обе с in=0 (${parts.map((c) => c.in).join(',')})`);
    store.undo(); await sleep(80);
    store.setClipDuration(tc.id, 60); await sleep(80);
    ok(near(store.findClip(tc.id).clip.out, 60), 'текст можно растянуть на 60 с (файла нет)');
    store.setClipDuration(tc.id, 2);

    // --- субтитры: импорт SRT из текста ---
    const { importSubtitleText } = await import('./js/subtitlesUi.js');
    const srt = '1\r\n00:00:00,500 --> 00:00:02,500\r\nПервая реплика\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nВторая\r\nв две строки\r\n';
    const sid = importSubtitleText(srt, { name: 'Русские' }); await sleep(200);
    const st = store.subtitleTrack(sid);
    ok(!!st && st.cues.length === 2 && st.cues[1].text === 'Вторая\nв две строки', `импорт SRT: ${st && st.cues.length} реплики`);
    const lane = document.querySelector(`.sub-lane[data-strack="${sid}"]`);
    ok(!!lane && lane.querySelectorAll('.cue').length === 2, 'на таймлайне — дорожка субтитров с 2 репликами');
    // плеер показывает реплику
    store.setTime(1); await sleep(150);
    ok((document.querySelector('.sub-overlay').textContent || '').includes('Первая реплика'), 'плеер: реплика поверх кадра');
    store.setTime(2.7); await sleep(150);
    ok(!document.querySelector('.sub-overlay').textContent.trim(), 'между репликами — пусто');

    // перетаскивание реплики мышью
    timeline.autoFit = false; timeline.setZoom(100); await sleep(150);
    let cue = document.querySelector(`.sub-lane[data-strack="${sid}"] .cue[data-id="${st.cues[1].id}"]`);
    let r = cue.getBoundingClientRect();
    const undo1 = store.undoStack.length;
    await dragTo(cue, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 100, r.top + r.height / 2);
    const c2 = store.findCue(st.cues[1].id).cue;
    ok(near(c2.start, 4, 0.12) && near(c2.end - c2.start, 1, 0.001) && store.undoStack.length === undo1 + 1, `перетаскивание реплики: ${c2.start.toFixed(2)}–${c2.end.toFixed(2)}`);
    // правый край
    cue = document.querySelector(`.cue[data-id="${c2.id}"]`); r = cue.getBoundingClientRect();
    await dragTo(cue.querySelector('.handle.r'), r.right - 2, r.top + r.height / 2, r.right + 50, r.top + r.height / 2);
    ok(store.findCue(c2.id).cue.end > c2.start + 1.3, `правый край реплики: до ${store.findCue(c2.id).cue.end.toFixed(2)}`);
    // разрез и удаление
    store.select({ kind: 'cue', id: c2.id }); store.setTime(store.findCue(c2.id).cue.start + 0.5);
    timeline.splitAction(); await sleep(80);
    ok(store.subtitleTrack(sid).cues.length === 3, 'разрез реплики по курсору');
    store.select({ kind: 'cue', id: store.subtitleTrack(sid).cues[2].id });
    timeline.deleteAction(false); await sleep(80);
    ok(store.subtitleTrack(sid).cues.length === 2, 'удаление реплики');
    // двойной щелчок по пустому месту дорожки — новая реплика
    const l2 = document.querySelector(`.sub-lane[data-strack="${sid}"]`).getBoundingClientRect();
    const x8 = l2.left + 8 * timeline.pps - timeline.scroll.scrollLeft;
    document.querySelector(`.sub-lane[data-strack="${sid}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x8, clientY: l2.top + l2.height / 2 }));
    await sleep(100);
    ok(store.subtitleTrack(sid).cues.length === 3 && store.selection && store.selection.kind === 'cue', 'двойной щелчок — новая реплика');
    store.undo(); await sleep(80);
    // оформление дорожки: жёлтый текст
    store.setSubtitleTrack(sid, { style: { color: '#ffff00', size: 0.08 } }); await sleep(80);
    store.select({ kind: 'strack', id: sid }); await sleep(100);
    ok(!!document.querySelector('#inspector [data-section="strack"]'), 'инспектор: оформление дорожки субтитров');

    // --- сохранение / загрузка ---
    const text = store.serialize();
    store.load(JSON.parse(text).project); await sleep(200);
    ok(store.subtitleTracks().length === 1 && store.allVideo().some((c) => c.kind === 'text' && c.text.box), 'проект сохраняется и загружается с текстом и субтитрами');

    // --- экспорт: текст + вшитые субтитры ---
    const enc = await window.api.encoders();
    const codec = enc.h264_nvenc ? 'h264_nvenc' : 'libx264';
    const out = [info.cacheDir, 'tmp', 'ui15-burn.mp4'].join(info.sep);
    let res = await window.api.startExport(JSON.parse(JSON.stringify(store.project)), { width: 640, height: 360, fps: 30, codec, quality: 'medium', output: out });
    ok(res.ok, `экспорт с текстом и вшитыми субтитрами: ${res.ok ? `${(res.size / 1e3).toFixed(0)} КБ` : res.error}`);
    if (res.ok) {
      const f = await frameOf(out, 1.5);
      const red = f.count(0.2, 0.3, 0.8, 0.7, isRed); const yel = f.count(0.1, 0.75, 0.9, 1, isYellow);
      ok(red > 30, `в кадре 1,5 с красная подложка текста (${red})`);
      ok(yel > 3, `и жёлтые субтитры внизу (${yel})`);
      const f0 = await frameOf(out, 0.2);
      ok(f0.count(0.2, 0.3, 0.8, 0.7, isRed) === 0 && f0.count(0.1, 0.75, 0.9, 1, isYellow) === 0, 'до начала — пустой кадр');
    }
    // --- мягкие субтитры ---
    const out2 = [info.cacheDir, 'tmp', 'ui15-soft.mp4'].join(info.sep);
    res = await window.api.startExport(JSON.parse(JSON.stringify(store.project)), { width: 640, height: 360, fps: 30, codec, quality: 'medium', output: out2, subtitles: 'soft' });
    ok(res.ok, `экспорт с мягкими субтитрами: ${res.ok ? 'ok' : res.error}`);
    if (res.ok) {
      const f = await frameOf(out2, 1.5);
      ok(f.count(0.1, 0.75, 0.9, 1, isYellow) === 0 && f.count(0.2, 0.3, 0.8, 0.7, isRed) > 30, 'мягкие: в кадре только текст, субтитры — не вшиты');
    }

    // финальный вид
    store.setTime(1.5); timeline.autoFit = true; timeline.fit();
    store.select({ kind: 'video', id: tc.id }); await sleep(600);
    await window.api.testShot('m5-text');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
