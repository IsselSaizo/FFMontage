// Тест 4 (0.3, таймлайн): звук видео отдельными клипами (2 потока), моно/стерео волны, наложение при переносе,
// Alt+S, лезвие, соло, громкость и имя дорожки, громкость предпросмотра.
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
  const ptr = (type, x, y, target = window, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, ...extra }));
  const clipEl = (id) => document.querySelector(`.clip[data-id="${id}"]`);
  const end = (c) => c.start + c.out - c.in;
  const r2 = (x) => Math.round(x * 100) / 100;
  const vids = () => store.project.videoClips.slice().sort((a, b) => a.start - b.start);
  const auds = () => store.project.audioTracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.id })));
  const key = (code, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key: opts.key || code, bubbles: true, ...opts }));
  const tx = (t) => { const r = timeline.content.getBoundingClientRect(); return r.left + 168 + t * timeline.pps; };
  const drag = async (el, fromX, y, toX, steps = 8, extra = {}) => {
    ptr('pointerdown', fromX, y, el, extra);
    for (let k = 1; k <= steps; k++) { ptr('pointermove', fromX + (toX - fromX) * k / steps, y, window, extra); await sleep(30); if (window.__trace) window.__trace(); }
    ptr('pointerup', toX, y, window, extra);
    await sleep(150);
  };

  try {
  // --- 1. Звук видео отдельными клипами ---
  const [e, b] = await importPaths([dir + 'e_2audio.mp4', dir + 'b_h264_1080p30.mp4']);
  ok(store.media(e).audioStreams.length === 2, 'в файле 2 звуковых потока');
  timeline.addMedia(e);
  await sleep(100);
  let v = vids();
  let a = auds();
  ok(v.length === 1 && v[0].noAudio && v[0].link, 'видео без своего звука, со связью');
  ok(a.length === 2 && a.every((x) => x.link === v[0].link) && a[0].track !== a[1].track
    && a.map((x) => x.stream || 0).sort().join() === '0,1', `звук: 2 клипа на разных дорожках, потоки ${a.map((x) => x.stream || 0).join(',')}`);
  for (let i = 0; i < 100 && !(store.runtime[e]?.peaks && store.runtime[e]?.streamPeaks?.[1] && store.runtime[e]?.streamUrl?.[1]); i++) await sleep(100);
  timeline.autoFit = true; timeline.fit(); await sleep(200);
  const a0 = a.find((x) => !x.stream); const a1 = a.find((x) => x.stream === 1);
  ok(clipEl(a0.id).classList.contains('stereo') && clipEl(a0.id).querySelectorAll('canvas.wave').length === 2, 'стерео: две полосы волны');
  ok(!clipEl(a1.id).classList.contains('stereo') && clipEl(a1.id).querySelectorAll('canvas.wave').length === 1, 'моно: одна полоса волны');
  ok(/audio-a1\.m4a/.test(store.runtime[e].streamUrl[1]), 'второй поток для предпросмотра извлечён');

  // --- 2. Перенос видео — звук едет за ним ---
  let vr = clipEl(v[0].id).getBoundingClientRect();
  await drag(clipEl(v[0].id), vr.x + 30, vr.y + 30, vr.x + 30 + 2 * timeline.pps);
  v = vids(); a = auds();
  ok(Math.abs(v[0].start - 2) < 0.05 && a.every((x) => Math.abs(x.start - v[0].start) < 1e-6), `видео и звук перенесены вместе на ${r2(v[0].start)}`);
  // Перенос звукового клипа тянет и видео
  const ar = clipEl(a1.id).getBoundingClientRect();
  await drag(clipEl(a1.id), ar.x + 30, ar.y + 20, ar.x + 30 - 1 * timeline.pps);
  v = vids(); a = auds();
  ok(Math.abs(v[0].start - 1) < 0.05 && a.every((x) => Math.abs(x.start - v[0].start) < 1e-6), `перенос звука сдвинул и видео: ${r2(v[0].start)}`);
  store.moveVideoClip(v[0].id, 2);
  ok(auds().every((x) => Math.abs(x.start - 2) < 1e-6), 'moveVideoClip: звук синхронен');

  // --- 3. Наложение: b (8 с) переносим на 4 с — e (2–8) обрезается до 2–4, его звук тоже ---
  timeline.addMedia(b);
  await sleep(100);
  v = vids();
  const vb = v.find((x) => x.mediaId === b);
  const ve = v.find((x) => x.mediaId === e);
  ok(Math.abs(vb.start - 8) < 1e-6, `b добавлен в конец: ${vb.start}`);
  timeline.autoFit = true; timeline.fit(); await sleep(150);
  vr = clipEl(vb.id).getBoundingClientRect();
  const before = store.snapshot();
  window.__trace = () => !store.findClip(vb.id) ? 'no b' : `b=${r2(store.findClip(vb.id).clip.start)} drag=${JSON.stringify(timeline.drag)} pps=${timeline.pps}`;
  await drag(clipEl(vb.id), vr.x + 40, vr.y + 30, vr.x + 40 - 4 * timeline.pps);
  v = vids();
  const ve2 = store.findClip(ve.id)?.clip;
  ok(ve2 && Math.abs(end(ve2) - 4) < 0.05 && Math.abs(store.findClip(vb.id).clip.start - 4) < 0.05, `наложение: e ${ve2 && `${r2(ve2.start)}–${r2(end(ve2))}`}, b с ${r2(store.findClip(vb.id).clip.start)}`);
  const eAud = auds().filter((x) => x.link === ve.link);
  ok(eAud.length === 2 && eAud.every((x) => Math.abs(end(x) - 4) < 0.05), `звук e подрезан до 4 с: ${eAud.map((x) => `${r2(x.start)}–${r2(end(x))}`).join(', ')}`);
  const bAud = auds().filter((x) => x.link === vb.link);
  ok(bAud.length >= 1 && bAud.every((x) => Math.abs(x.start - 4) < 0.05), 'звук b переехал вместе с ним');
  store.undo();
  ok(store.snapshot() === before, 'отмена наложения возвращает всё как было');
  // С Alt — как раньше: e не обрезается
  window.__trace = null;
  const undoN = store.undoStack.length;
  vr = clipEl(vb.id).getBoundingClientRect();
  await drag(clipEl(vb.id), vr.x + 40, vr.y + 30, vr.x + 40 - 4 * timeline.pps, 8, { altKey: true });
  ok(Math.abs(end(store.findClip(ve.id).clip) - 8) < 0.05, 'с Alt клип не затирает соседа');
  if (store.undoStack.length > undoN) store.undo();

  // --- 4. Alt+S: разрезать всё под курсором ---
  store.select(null);
  store.setTime(5);
  const nv = store.project.videoClips.length; const na = auds().length;
  key('KeyS', { key: 's', altKey: true });
  await sleep(100);
  ok(store.project.videoClips.length === nv + 1 && auds().length === na + 2, `Alt+S: видео ${nv}→${store.project.videoClips.length}, звук ${na}→${auds().length}`);
  const rightV = vids().find((x) => Math.abs(x.start - 5) < 1e-6 && x.mediaId === e);
  ok(rightV && auds().filter((x) => x.link === rightV.link).length === 2, 'правая половина видео связана с правыми половинами звука');
  ok(store.time === 5, 'курсор не сдвинулся');

  // --- 5. Лезвие ---
  timeline.setTool('blade');
  ok(timeline.root.classList.contains('blade-mode'), 'режим лезвия включён');
  const lv = vids().find((x) => x.mediaId === e && x.start < 3);
  const lr = clipEl(lv.id).getBoundingClientRect();
  ptr('pointermove', tx(3), lr.y + 20, clipEl(lv.id));
  ok(timeline.bladeLine.style.display === 'block', 'красная линия лезвия следует за мышью');
  const nv2 = store.project.videoClips.length; const na2 = auds().length;
  ptr('pointerdown', tx(3), lr.y + 20, clipEl(lv.id)); ptr('pointerup', tx(3), lr.y + 20);
  await sleep(100);
  ok(store.project.videoClips.length === nv2 + 1 && auds().length === na2 + 2, 'лезвие разрезало видео и его звук');
  ok(store.time === 5, 'курсор воспроизведения на месте');
  key('KeyB', { key: 'b' });
  ok(timeline.tool === 'select', 'B — обратно к выделению');

  // --- 6. Соло, громкость и имя дорожки ---
  const t0 = store.project.audioTracks[0]; const t1 = store.project.audioTracks[1];
  document.querySelector(`.tl-row.audio[data-track="${t1.id}"] .th-solo`).click();
  await sleep(50);
  ok(store.project.audioTracks[1].solo && preview.trackGain(store.project.audioTracks[0]) === 0 && preview.trackGain(store.project.audioTracks[1]) > 0, 'соло: слышно только эту дорожку');
  document.querySelector(`.tl-row.audio[data-track="${t1.id}"] .th-solo`).click();
  await sleep(50);
  ok(!store.anySolo(), 'соло снято');
  const vol = document.querySelector(`.tl-row.audio[data-track="${t0.id}"] .th-vol`);
  vol.value = '50'; vol.dispatchEvent(new Event('input')); vol.dispatchEvent(new Event('change'));
  ok(Math.abs(store.project.audioTracks[0].volume - 0.5) < 1e-6, 'громкость дорожки 50%');
  const plan = await import('./js/exportPlan.js');
  const cmd = plan.buildExport(store.project, { width: 640, height: 360, fps: 30 });
  ok(/\[\d+:a:1\]/.test(cmd.filter) && /volume=0\.500000/.test(cmd.filter), 'экспорт: второй поток и громкость дорожки в команде');
  const nameEl = document.querySelector(`.tl-row.audio[data-track="${t0.id}"] .th-name`);
  nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(50);
  const inp = document.querySelector('.th-rename');
  ok(!!inp, 'двойной щелчок по имени — поле ввода');
  inp.value = 'Игра'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(100);
  ok(store.trackName(t0.id) === 'Игра' && document.querySelector(`.tl-row.audio[data-track="${t0.id}"] .th-name`).textContent === 'Игра', 'дорожка переименована');
  document.querySelector('.tl-row.video .th-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(50);
  const vin = document.querySelector('.th-rename');
  vin.value = 'Камера'; vin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(100);
  ok(store.trackName('video') === 'Камера', 'видеодорожка переименована');

  // --- 7. Громкость предпросмотра ---
  const ms = document.querySelector('#monitor-vol');
  ms.value = '30'; ms.dispatchEvent(new Event('input'));
  ok(localStorage.getItem('ffm.monitorVol') === '0.3' && preview.monitor() === 0.3, 'громкость предпросмотра 30%');
  ok(!/0\.3/.test(JSON.stringify(store.project.audioTracks.map((t) => t.volume))), 'на проект (экспорт) не влияет');
  ms.value = '100'; ms.dispatchEvent(new Event('input'));

  // --- 8. Воспроизведение со звуком из второго потока ---
  store.setTime(2.2);
  preview.play();
  await sleep(1200);
  preview.pause();
  const recs = [...preview.audio.values()].map((r) => r.url || '');
  ok(recs.some((u) => /audio-a1\.m4a/.test(u)), 'плеер играет второй поток из извлечённого файла');

  // --- 9. Удаление видео удаляет и его звук ---
  const vdel = vids().find((x) => x.mediaId === b);
  const L = vdel.link;
  store.deleteClip(vdel.id);
  ok(!auds().some((x) => x.link === L), 'удаление видео удаляет связанный звук');
  // Вынести/вернуть звук
  const vx = vids()[0];
  store.restoreOwnAudio(vx.id);
  ok(!store.findClip(vx.id).clip.noAudio && !auds().some((x) => x.link && x.link === vx.link), 'звук возвращён в видеоклип');
  store.detachAudio(vx.id);
  ok(store.findClip(vx.id).clip.noAudio && store.linkedOf(vx.id).length === 2, 'звук снова вынесен на дорожки');

  } catch (err) { errors.push(String(err && err.stack || err)); }
  await window.api.testShot('ui-selftest4');
  return { log, errors };
})();
