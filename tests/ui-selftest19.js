// Тест 19 (0.4.3): режим нарезания 2.0 в окне — Q/W, метки In/Out + Lift/Extract, инструмент обрезки (ripple/roll/slip/slide
// мышью, двойной кадр в плеере), JKL-шаттл, «Удалить паузы», лезвие Shift+щелчок, замок аудиодорожки, ripple-удаление по всем дорожкам.
// Запуск: tests\run-ui.ps1 ui-selftest19 (файлы — node tests\engine-test.js; p_pauses.mp4 делает run-ui.ps1)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };
  const near = (a, b, e = 0.002) => Math.abs(a - b) <= e;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview, shuttle } = window.__ffm;
  const { clipEnd } = await import('./js/clipTime.js');
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const key = (code, opts = {}) => {
    const k = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, ...opts }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code, key: k, bubbles: true, ...opts }));
  };
  const vids = () => [...store.project.videoClips].sort((a, b) => a.start - b.start);
  const span = (c) => [+c.start.toFixed(3), +clipEnd(c).toFixed(3)];
  const reset = async (ids) => {
    store.mutate((p) => { p.videoClips = []; p.videoTracks = []; p.audioTracks = [p.audioTracks[0]]; p.audioTracks[0].clips = []; delete p.audioTracks[0].locked; delete p.marks; });
    for (const id of ids) timeline.addMedia(id);
    await sleep(250);
    timeline.autoFit = true; timeline.fit();
    await sleep(100);
  };
  try {
    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    const [m] = await importPaths([dir + 'c_music.mp3']);
    const [pz] = await importPaths([dir + 'p_pauses.mp4']);
    ok(b && m && pz, `импорт: ${b} ${m} ${pz}`);
    await until(() => store.runtime[b] && store.runtime[b].status === 'ready', 30000);
    const fps = store.fps();

    // --- Q / W ---
    await reset([b, b]);
    const [v1, v2] = vids();
    const L = clipEnd(v1);
    store.select({ kind: 'video', id: v2.id });
    store.setTime(v2.start + 1); key('KeyQ'); await sleep(80);
    let vs = vids();
    ok(vs.length === 2 && near(vs[1].start, L) && near(clipEnd(vs[1]), 2 * L - 1, 1 / fps), `Q: начало второго клипа обрезано, сдвинут: ${JSON.stringify(vs.map(span))}`);
    const a2 = store.project.audioTracks[0].clips.find((c) => c.link === vs[1].link);
    ok(a2 && near(a2.start, vs[1].start) && near(a2.in, vs[1].in), 'Q: связанный звук обрезан вместе');
    ok(near(store.time, L), `Q: курсор на месте правки ${store.time}`);
    store.setTime(1); key('KeyW'); await sleep(80);
    vs = vids();
    ok(near(clipEnd(vs[0]), 1, 1 / fps) && near(vs[1].start, clipEnd(vs[0])), `W: конец первого до курсора, второй встал впритык: ${JSON.stringify(vs.map(span))}`);
    key('KeyZ', { ctrlKey: true }); await sleep(50);
    ok(near(clipEnd(vids()[0]), L), 'Ctrl+Z отменяет W');
    store.setTime(1); key('KeyW', { shiftKey: true }); await sleep(80);
    vs = vids();
    ok(near(clipEnd(vs[0]), 1, 1 / fps) && vs[1].start > 1.5, 'Shift+W: без сдвига (пустота)');

    // --- In / Out, Lift, Extract ---
    await reset([b, b]);
    store.setTime(1); key('KeyI'); store.setTime(3); key('KeyO'); await sleep(80);
    ok(store.project.marks && near(store.project.marks.in, 1, 1 / fps) && near(store.project.marks.out, 3, 1 / fps), `метки: ${JSON.stringify(store.project.marks)}`);
    ok(!!document.querySelector('.mark-flag.in') && !!document.querySelector('.mark-flag.out') && !!document.querySelector('.tl-markband'), 'метки на линейке и полоса');
    await window.api.testShot('marks').catch(() => {});
    const dur0 = store.duration();
    key('Semicolon'); await sleep(80);
    ok(near(store.duration(), dur0) && store.project.videoClips.length === 3 && !store.project.marks, `Lift: длина та же, пустота: ${JSON.stringify(vids().map(span))}`);
    key('KeyZ', { ctrlKey: true }); await sleep(50);
    store.project.marks = { in: 1, out: 3 }; store.emit('marks');
    key('Quote'); await sleep(80);
    ok(near(store.duration(), dur0 - 2, 2 / fps) && store.gaps('video').length === 0, `Extract: на 2 с короче, без пустот: ${store.duration()}`);
    store.setTime(L - 1); key('KeyX'); await sleep(50);
    const mk = store.project.marks || {};
    const under = vids().find((c) => c.start <= L - 1 && clipEnd(c) > L - 1);
    ok(under && near(mk.in, under.start) && near(mk.out, clipEnd(under)), `X: метки по клипу ${JSON.stringify(mk)}`);
    key('KeyX', { altKey: true }); await sleep(50);
    ok(!store.project.marks, 'Alt+X: метки убраны');

    // --- Инструмент обрезки мышью ---
    await reset([b, b]);
    timeline.setTool('trim');
    ok(document.querySelector('#tb-trim').classList.contains('on'), 'кнопка инструмента обрезки');
    const elOf = (id) => document.querySelector(`.clip[data-id="${id}"]`);
    const drag = async (el, fx, fy, dx, during = null) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * fx; const y = r.top + r.height * fy;
      const opt = { bubbles: true, button: 0, pointerId: 1 };
      el.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: x, clientY: y }));
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opt, clientX: x, clientY: y }));
      for (let i = 1; i <= 5; i++) { window.dispatchEvent(new PointerEvent('pointermove', { ...opt, clientX: x + (dx * i) / 5, clientY: y })); await sleep(30); }
      if (during) await during();
      window.dispatchEvent(new PointerEvent('pointerup', { ...opt, clientX: x + dx, clientY: y }));
      await sleep(120);
    };
    // Клипы с запасом кадров: первый — 0…6 с файла, второй — со 2 с (иначе roll/slip упираются в края файла)
    store.mutate(() => { const [x1, x2] = vids(); x1.out = 6; x2.in = 2; x2.out = 8; x2.start = 6; });
    await sleep(150);
    let [c1, c2] = vids();
    const px = timeline.pps;
    // Roll: правый край первого (в 2 px от стыка)
    {
      const el = elOf(c1.id); const r = el.getBoundingClientRect();
      await drag(el, 1 - 2 / r.width, 0.7, 1 * px, async () => {
        ok(document.querySelector('#trim-preview').classList.contains('on'), 'двойной кадр в плеере во время обрезки');
        const vl = document.querySelector('#trim-preview .tp-pane.l video'); const vr = document.querySelector('#trim-preview .tp-pane.r video');
        const loaded = await until(() => vl.readyState >= 2 && vr.readyState >= 2 && !vl.seeking && !vr.seeking && vl.videoWidth > 0, 10000);
        ok(!!loaded && vl.currentTime > 5 && vr.currentTime > 2, `двойной кадр: слева ${vl.currentTime.toFixed(2)} с, справа ${vr.currentTime.toFixed(2)} с`);
        await window.api.testShot('trim-roll').catch(() => {});
      });
      [c1, c2] = vids();
      ok(near(clipEnd(c1), 7, 2 / fps) && near(c2.start, clipEnd(c1)) && near(c2.in, 3, 2 / fps) && near(clipEnd(c2), 12, 2 / fps), `roll мышью: ${JSON.stringify([span(c1), span(c2)])}`);
      ok(!document.querySelector('#trim-preview').classList.contains('on'), 'двойной кадр убран после обрезки');
    }
    // Ripple: правый край второго, влево на 1 с — укорачивается, длина ролика меньше
    {
      const before = store.duration();
      const el = elOf(c2.id); const r = el.getBoundingClientRect();
      await drag(el, 1 - 8 / r.width, 0.7, -1 * px);
      ok(near(store.duration(), before - 1, 2 / fps), `ripple мышью: длина ${before} → ${store.duration()}`);
    }
    // Slip: нижняя часть второго, вправо на 0,5 с — содержимое едет за мышью (in уменьшается)
    {
      [c1, c2] = vids();
      const in0 = c2.in; const s0 = c2.start;
      await drag(elOf(c2.id), 0.5, 0.8, 0.5 * px);
      [c1, c2] = vids();
      ok(near(c2.in, in0 - 0.5, 2 / fps) && near(c2.start, s0), `slip мышью: in ${in0} → ${c2.in}`);
    }
    // Slide: верхняя часть второго, влево на 0,5 с — первый укорачивается
    {
      [c1, c2] = vids();
      const e0 = clipEnd(c1);
      await drag(elOf(c2.id), 0.5, 0.2, -0.5 * px);
      [c1, c2] = vids();
      ok(near(clipEnd(c1), e0 - 0.5, 2 / fps) && near(c2.start, clipEnd(c1)), `slide мышью: стык ${e0} → ${clipEnd(c1)}`);
    }
    timeline.setTool('select');

    // --- Лезвие: Shift+щелчок режет все дорожки, замок аудиодорожки ---
    await reset([b]);
    store.addAudioClip(m, 0); await sleep(150);
    const musTrack = store.project.audioTracks.find((tr) => tr.clips.some((c) => c.mediaId === m));
    timeline.setTool('blade');
    {
      const lane = document.querySelector('.audio-lane');
      const r = lane.getBoundingClientRect();
      const x = r.left + 2 * timeline.pps - timeline.scroll.scrollLeft;
      lane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true, clientX: x, clientY: r.top + 10 }));
      await sleep(100);
      const total = store.project.videoClips.length + store.project.audioTracks.reduce((s, tr) => s + tr.clips.length, 0);
      ok(store.project.videoClips.length === 2 && total >= 6, `Shift+лезвие: разрезано всё (${total} клипов)`);
    }
    timeline.setTool('select');
    key('KeyZ', { ctrlKey: true }); await sleep(50);
    store.setTrack(musTrack.id, { locked: true }); await sleep(100);
    ok(!!document.querySelector(`.tl-row.audio.lane-locked[data-track="${musTrack.id}"] .th-lock.on`), 'замок аудиодорожки в заголовке');
    store.splitAll(2); await sleep(50);
    ok(store.project.audioTracks.find((x) => x.id === musTrack.id).clips.length === 1, 'Alt+S не режет дорожку с замком');
    store.setTrack(musTrack.id, { locked: false });

    // --- Ripple-удаление сдвигает и другие дорожки (B-5) ---
    await reset([b, b]);
    store.addAudioClip(m, clipEnd(vids()[0]) + 0.5, 'new', { forceTrack: true }); await sleep(100);
    const mus = store.project.audioTracks.flatMap((tr) => tr.clips).find((c) => c.mediaId === m);
    const ms0 = mus.start;
    store.select({ kind: 'video', id: vids()[0].id });
    key('Delete', { shiftKey: true }); await sleep(80);
    const mus2 = store.project.audioTracks.flatMap((tr) => tr.clips).find((c) => c.mediaId === m);
    ok(vids().length === 1 && near(vids()[0].start, 0) && near(mus2.start, ms0 - L), `ripple-удаление сдвинуло и музыку: ${ms0} → ${mus2.start}`);

    // --- JKL-шаттл ---
    await reset([b, b]);
    store.setTime(1);
    key('KeyL'); await sleep(50); key('KeyL'); await sleep(400);
    ok(shuttle.rate === 2 && preview.playing && preview.rate === 2, `L L: ×2 (${shuttle.rate}, ${preview.rate})`);
    ok(document.querySelector('#shuttle-badge').classList.contains('on'), 'значок скорости шаттла');
    await window.api.testShot('shuttle').catch(() => {});
    key('KeyK'); await sleep(100);
    ok(shuttle.rate === 0 && !preview.playing && preview.rate === 1, 'K: стоп');
    const t0 = store.time;
    key('KeyJ'); await sleep(500); key('KeyK'); await sleep(50);
    ok(store.time < t0 - 0.2, `J: назад ${t0.toFixed(2)} → ${store.time.toFixed(2)}`);
    // K удерживается + L — кадр вперёд
    const t1 = store.time;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }));
    key('KeyL'); await sleep(30);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyK', key: 'k', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyK', key: 'k' }));
    ok(near(store.time, t1 + 1 / fps, 0.005) && !preview.playing, `K+L: на кадр вперёд ${t1.toFixed(3)} → ${store.time.toFixed(3)}`);
    key('Space'); await sleep(300); key('Space'); await sleep(50);
    ok(preview.rate === 1 && !preview.playing, 'пробел — обычное воспроизведение ×1');

    // --- Удалить паузы ---
    await reset([pz]);
    const vp = vids()[0];
    const dp = store.duration();
    const { openPausesDialog } = await import('./js/edit.js');
    openPausesDialog(vp.id);
    const okBtn = await until(() => { const x = document.querySelector('#pauses-ok'); return x && !x.disabled ? x : null; }, 30000);
    ok(!!okBtn, `окно «Удалить паузы»: ${(document.querySelector('#pauses-info') || {}).textContent}`);
    await window.api.testShot('pauses').catch(() => {});
    okBtn && okBtn.click(); await sleep(150);
    const removed = dp - store.duration();
    ok(removed > 1.5 && removed < 2.5 && vids().length === 3, `паузы удалены: −${removed.toFixed(2)} с, клипов ${vids().length}`);
    const au = store.project.audioTracks[0].clips;
    ok(au.length === 3 && au.every((a) => vids().some((v) => v.link === a.link && near(v.start, a.start) && near(v.in, a.in))), 'звук разрезан вместе с видео');
    ok(store.gaps('video').length === 0, 'пустот нет');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
