// Тест 17: аудиоплагины VST3 / CLAP в окне — сканирование, стойка (меню, запись, общий ползунок), рендер для плеера,
// плеер играет WAV рендера, эффекты дорожки, сессия без окна, ложных «пропавших плагинов» нет.
// Запуск: tests\run-ui.ps1 ui-selftest17 (кладёт тестовые плагины, собранные cargo build --profile fast --example …)
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, timeline, importPaths, preview } = window.__ffm;
  const vst = await import('./js/vst.js');
  const reg = await import('./js/registry.js');
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  const rack = () => document.querySelector('#audio-rack');
  try {
    const list = await vst.scanVst(false);
    const all = vst.vstPlugins();
    const pv = all.find((p) => p.format === 'vst3' && p.name === 'FFM Test Gain');
    const pc = all.find((p) => p.format === 'clap' && p.uid === 'clap:ffmontage.test.gain');
    ok(pv && pc, `сканирование: ${all.map((p) => `${p.format}:${p.name}`).join(', ')} ${JSON.stringify(list && list.failed)}`);

    const [b] = await importPaths([dir + 'b_h264_1080p30.mp4']);
    timeline.addMedia(b);
    await sleep(250);
    const tr = store.project.audioTracks[0];
    const ac = tr.clips[0];
    document.querySelector('.mode-tab[data-mode="audio"]').click(); await sleep(80);
    store.select({ kind: 'audio', id: ac.id }); await sleep(120);

    // Меню «VST3 / CLAP…» → тестовый VST3
    rack().querySelector('#rack-add-vst').click(); await sleep(200);
    const item = await until(() => document.querySelector(`.vst-pop [data-vst-uid="${pv.uid}"]`), 3000);
    ok(!!item && /VST3/.test(item.textContent), 'меню плагинов: пункт с меткой VST3');
    ok(!!document.querySelector(`.vst-pop [data-vst-uid="${pc.uid}"]`), 'меню плагинов: CLAP тоже есть');
    await window.api.testShot('vst-menu').catch(() => {});
    item.click();
    const fx = await until(() => { const f = store.findClip(ac.id).clip.afx; return f && f[0] && f[0].type === 'vst3' && f[0].vst.state ? f[0] : null; }, 15000);
    ok(!!fx && fx.vst.uid === pv.uid && fx.vst.name === 'FFM Test Gain', `запись стойки: ${JSON.stringify(fx && { ...fx.vst, state: !!fx.vst.state })}`);
    ok(reg.missingIds(store.project).audioEffects.length === 0, 'VST3 не считается пропавшим плагином');

    // Общий ползунок (у тестового плагина нет окна) → params → новый рендер
    const sl = await until(() => rack().querySelector('.fx-card.vst input[data-vst-param="0"]'), 10000);
    ok(!!sl, 'плагин без окна: общий ползунок Gain');
    if (sl) {
      sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      sl.value = '0.5'; sl.dispatchEvent(new Event('input'));
      sl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      sl.dispatchEvent(new Event('change'));
      await sleep(100);
      ok(Number(store.findClip(ac.id).clip.afx[0].vst.params?.[0]) === 0.5, 'ползунок записан в fx.vst.params');
    }

    // Рендер для плеера
    const r = await until(() => { const x = vst.clipRender(store.findClip(ac.id).clip, true); return x && (x.status === 'ready' || x.status === 'error') ? x : null; }, 60000);
    ok(r && r.status === 'ready' && /audio-fx/.test(r.path || r.url || ''), `рендер клипа: ${JSON.stringify(r && { status: r.status, error: r.error, url: r.url })}`);
    store.setTime(1);
    preview.play(); await sleep(900); preview.pause();
    const rec = preview.audio.get(ac.id);
    ok(rec && /audio-fx/.test(decodeURIComponent(rec.el.src || '')), `плеер играет WAV рендера: ${rec && rec.el.src}`);
    await window.api.testShot('vst-rack').catch(() => {});

    // CLAP на дорожку
    store.select({ kind: 'track', id: tr.id }); await sleep(120);
    rack().querySelector('#rack-add-vst').click(); await sleep(200);
    const ci = await until(() => document.querySelector(`.vst-pop [data-vst-uid="${pc.uid}"]`), 3000);
    ci && ci.click();
    const tfx = await until(() => { const f = store.project.audioTracks[0].afx; return f && f[0] && f[0].type === 'clap' && f[0].vst.state ? f[0] : null; }, 15000);
    ok(!!tfx, 'CLAP на дорожке');
    const trr = await until(() => { const x = vst.trackRender(store.project.audioTracks[0]); return x && (x.status === 'ready' || x.status === 'error') ? x : null; }, 60000);
    ok(trr && trr.status === 'ready', `рендер дорожки: ${JSON.stringify(trr && { status: trr.status, error: trr.error })}`);

    // Сессия плагина без окна: открывается, пока открыта — цепочка «живая», закрывается
    store.select({ kind: 'audio', id: ac.id }); await sleep(120);
    const s = await vst.openEditor({ kind: 'clip', id: ac.id }, 0, 'test').catch((e) => ({ error: String(e) }));
    ok(s && !s.error && vst.liveCount() === 1 && vst.isLive({ kind: 'clip', id: ac.id }), `сессия открыта: ${JSON.stringify(s)}`);
    const sess = vst.sessionOf({ kind: 'clip', id: ac.id }, 0);
    if (sess) await vst.closeEditor(sess.id);
    ok(await until(() => vst.liveCount() === 0, 10000), 'сессия закрыта');

    // Экспорт: подготовка рендеров и план
    const assets = await import('./js/exportAssets.js');
    const plan = await import('./js/exportPlan.js');
    const st = { width: 640, height: 360, fps: 30, subtitles: 'none' };
    const prep = await assets.prepareExportAssets(store.project, st, window.api);
    ok(Object.keys(prep.vst.clips).length === 1 && Object.keys(prep.vst.tracks).length === 1, `рендеры экспорта: ${JSON.stringify(prep.vst)}`);
    const cmd = plan.buildExport(store.project, { ...st, assets: prep });
    const s2 = JSON.stringify(cmd);
    ok(/audio-fx/.test(s2), 'экспорт: вход — WAV рендера');
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
