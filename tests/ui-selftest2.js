// Тест 2: восстановление автосохранения, мышь (обрезка, перестановка), экспорт через окно.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  await sleep(1500);
  const { store, timeline } = window.__ffm;
  log.push(`restored: media=${Object.keys(store.project.media).length} video=${store.project.videoClips.length} audioClips=${store.project.audioTracks[0].clips.length}`);
  log.push(`format: ${JSON.stringify(store.sourceFormat())}`);

  const ptr = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
  const clipEl = (id) => document.querySelector(`.clip[data-id="${id}"]`);

  // Обрезка правого края 2-го клипа на 120 px
  const c1 = store.project.videoClips[1];
  const out0 = c1.out;
  let hd = clipEl(c1.id).querySelector('.handle.r').getBoundingClientRect();
  ptr('pointerdown', hd.x + 4, hd.y + hd.height / 2, clipEl(c1.id).querySelector('.handle.r'));
  for (let k = 1; k <= 6; k++) { ptr('pointermove', hd.x + 4 - 20 * k, hd.y + 10); await sleep(16); }
  ptr('pointerup', hd.x + 4 - 120, hd.y + 10);
  await sleep(100);
  const c1b = store.findClip(c1.id).clip;
  log.push(`trim right: out ${out0.toFixed(2)} -> ${c1b.out.toFixed(2)} (ожидалось ≈ ${(out0 - 120 / timeline.pps).toFixed(2)})`);

  // Перестановка: первый клип тянем за третий
  const order0 = store.project.videoClips.map((c) => c.id);
  const r0 = clipEl(order0[0]).getBoundingClientRect();
  const r2 = clipEl(order0[2]).getBoundingClientRect();
  ptr('pointerdown', r0.x + r0.width / 2, r0.y + 20, clipEl(order0[0]));
  for (let k = 1; k <= 10; k++) { ptr('pointermove', r0.x + r0.width / 2 + (r2.right - 10 - r0.x - r0.width / 2) * k / 10, r0.y + 20); await sleep(16); }
  ptr('pointerup', r2.right - 10, r0.y + 20);
  await sleep(100);
  const order1 = store.project.videoClips.map((c) => c.id);
  log.push(`reorder: first clip moved to index ${order1.indexOf(order0[0])}`);

  // Перемещение музыки на +2 с
  const mc = store.project.audioTracks[0].clips[0];
  const s0 = mc.start;
  const rm = clipEl(mc.id).getBoundingClientRect();
  ptr('pointerdown', rm.x + 60, rm.y + 20, clipEl(mc.id));
  for (let k = 1; k <= 5; k++) { ptr('pointermove', rm.x + 60 + (2 * timeline.pps) * k / 5, rm.y + 20); await sleep(16); }
  ptr('pointerup', rm.x + 60 + 2 * timeline.pps, rm.y + 20);
  await sleep(100);
  log.push(`music move: start ${s0.toFixed(2)} -> ${store.findClip(mc.id).clip.start.toFixed(2)}`);

  store.undo(); store.undo(); store.undo();
  log.push(`after 3x undo: out=${store.findClip(c1.id).clip.out.toFixed(2)} order restored=${store.project.videoClips.map((c) => c.id).join() === order0.join()} music start=${store.findClip(mc.id).clip.start.toFixed(2)}`);

  // Экспорт через окно
  window.__ffm.openExport();
  for (let i = 0; i < 50 && !document.querySelector('#export-go'); i++) await sleep(100);
  const name = document.querySelector('.modal input.input');
  name.value = 'selftest'; name.dispatchEvent(new Event('input'));
  log.push(`export options: ${[...document.querySelectorAll('.modal select')].map((s) => s.options[s.selectedIndex].text).join(' | ')}; codec: ${document.querySelector('.codec-card.on .cc-title').textContent}`);
  document.querySelector('#export-go').click();
  let pctSeen = [];
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    const p = document.querySelector('.big-pct');
    if (p && !pctSeen.includes(p.textContent)) pctSeen.push(p.textContent);
    if (document.querySelector('.done-icon') || document.querySelector('.error-box')) break;
  }
  log.push(`progress seen: ${pctSeen.slice(0, 8).join(' ')} … (${pctSeen.length} шагов)`);
  const body = document.querySelector('.modal-body');
  log.push(`result: ${body ? body.innerText.replace(/\s+/g, ' ') : 'нет окна'}`);
  return { log, errors };
})();
