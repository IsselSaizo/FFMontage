// Выполняется внутри окна программы (через FFM_SELFTEST). Возвращает отчёт.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, preview, timeline, importPaths } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep); // файлы создаёт tests/engine-test.js
  const ids = await importPaths([dir + 'a_av1_1440p60.mp4', dir + 'b_h264_1080p30.mp4', dir + 'c_music.mp3', dir + 'd_old.avi']);
  log.push(`imported ${ids.length}`);
  const [a, b, c, d] = ids;
  timeline.addMedia(a);
  timeline.addMedia(b);
  timeline.addMedia(d);
  store.addAudioClip(c, 2);
  // ждём миниатюры, волну и прокси
  for (let i = 0; i < 100; i++) {
    const rt = store.runtime;
    if (rt[a]?.thumbs && rt[b]?.thumbs && rt[c]?.peaks && rt[d]?.proxyUrl) break;
    await sleep(100);
  }
  log.push(`runtime ready: a.thumbs=${!!store.runtime[a]?.thumbs} c.peaks=${!!store.runtime[c]?.peaks} d.proxy=${!!store.runtime[d]?.proxyUrl}`);

  // Разрезаем первый клип на 3 с, второй кусок делаем тише, клип b без звука
  store.select(null);
  store.setTime(3);
  timeline.splitAction();
  const vc = store.project.videoClips;
  log.push(`after split: ${vc.length} video clips: ${vc.map((x) => (x.out - x.in).toFixed(2)).join(', ')}`);
  store.setClip(vc[1].id, { volume: 0.6 });
  store.setClip(vc[2].id, { muted: true });
  // Переставляем AVI в начало
  store.moveVideoClip(vc[3].id, 0);
  log.push(`order: ${store.project.videoClips.map((x) => store.media(x.mediaId).name).join(' | ')}`);
  log.push(`duration ${store.duration().toFixed(2)}`);

  // Воспроизведение через границу клипов
  store.setTime(2.2);
  await sleep(300);
  const t0 = store.time;
  preview.play();
  await sleep(2500);
  const t1 = store.time;
  const act = preview.active;
  log.push(`playback: ${t0.toFixed(2)} -> ${t1.toFixed(2)}, active video ${act ? act.videoWidth + 'x' + act.videoHeight : 'none'}, readyState ${act && act.readyState}, url ${act && decodeURIComponent(act.dataset.url).split('\\').pop()}`);
  const musicEls = [...preview.audio.values()].map((r) => `${r.el.paused ? 'paused' : 'playing'}@${r.el.currentTime.toFixed(2)}`);
  log.push(`music: ${musicEls.join(', ')}`);
  preview.pause();

  // Отмена/повтор
  const n = store.project.videoClips.length;
  store.deleteClip(store.project.videoClips[0].id);
  const afterDel = store.project.videoClips.length;
  store.undo();
  log.push(`undo: ${n} -> ${afterDel} -> ${store.project.videoClips.length}`);

  store.select({ kind: 'video', id: store.project.videoClips[2].id });
  store.setTime(5.2);
  await sleep(900);
  return { log, errors, time: store.time };
})();
