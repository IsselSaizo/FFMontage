'use strict';
// «Режим нарезания 2.0» (0.4.3) — операции над моделью без окна: node tests/edit-test.js
// ripple-сдвиг по всем дорожкам (B-5), Lift/Extract, Q/W, ripple/roll/slip/slide, удаление пауз, привязка ко кадрам.
const path = require('path');
const { pathToFileURL } = require('url');

const JS = path.join(__dirname, '..', 'src', 'renderer', 'js');
const load = (f) => import(pathToFileURL(path.join(JS, f)).href);

let failed = 0; let passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++; console.log(`  ПРОВАЛ: ${msg}`);
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const section = (s) => console.log(s);

(async () => {
  const st = await load('store.js');
  const op = await load('editOps.js');
  const ct = await load('clipTime.js');
  const media = { m: { id: 'm', duration: 100, hasVideo: true, hasAudio: true }, a: { id: 'a', duration: 200, hasAudio: true } };
  const V = (id, start, inn, out, extra = {}) => ({ id, mediaId: 'm', in: inn, out, start, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra });
  const A = (id, start, inn, out, extra = {}) => ({ id, mediaId: extra.mediaId || 'm', in: inn, out, start, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra });
  // Видео: v1 [0,10) v2 [10,20) v3 [25,30); звук v1/v2 связан; музыка на второй дорожке [0,40); реплика 22–24
  const base = () => st.normalizeProject({
    version: 2, media: JSON.parse(JSON.stringify(media)),
    videoClips: [V('v1', 0, 0, 10, { link: 'L1', noAudio: true }), V('v2', 10, 20, 30, { link: 'L2', noAudio: true }), V('v3', 25, 50, 55)],
    audioTracks: [
      { id: 't1', clips: [A('a1', 0, 0, 10, { link: 'L1' }), A('a2', 10, 20, 30, { link: 'L2' })] },
      { id: 't2', clips: [A('mus', 0, 0, 40, { mediaId: 'a' })] },
      { id: 't3', clips: [A('sfx', 26, 0, 2, { mediaId: 'a' })] },
    ],
    subtitleTracks: [{ id: 's1', cues: [{ id: 'q1', start: 22, end: 24, text: 'x' }, { id: 'q2', start: 27, end: 29, text: 'y' }] }],
  });
  const fix = (p) => { st.fixup(p); return p; };
  const clip = (p, id) => op.rowOf(p, id).item;
  const E = ct.clipEnd;

  section('rippleShift: все дорожки, кроме перекрытых');
  {
    const p = base();
    const r = op.rippleShift(p, 21, -3); fix(p);
    ok(near(clip(p, 'v3').start, 22), `v3 сдвинут: ${clip(p, 'v3').start}`);
    ok(near(clip(p, 'sfx').start, 23), 'звук на другой дорожке сдвинут');
    ok(near(clip(p, 'mus').start, 0), 'музыка поперёк точки — на месте');
    ok(near(p.subtitleTracks[0].cues[0].start, 19) && near(p.subtitleTracks[0].cues[0].end, 21), 'реплики сдвинуты');
    ok(r.skipped.length === 0, `пропусков нет: ${r.skipped}`);
    const p2 = base();
    const r2 = op.rippleShift(p2, 25, -10); fix(p2);
    ok(r2.skipped.includes('video') && near(clip(p2, 'v3').start, 25), `наезд на v2 — видеодорожка пропущена: ${r2.skipped}`);
    const p3 = base(); p3.audioTracks[2].locked = true;
    op.rippleShift(p3, 21, -3); fix(p3);
    ok(near(clip(p3, 'sfx').start, 26), 'дорожка с замком не двигается');
  }

  section('Lift / Extract');
  {
    const p = base();
    op.liftRange(p, 5, 15); fix(p);
    ok(near(E(clip(p, 'v1')), 5) && p.videoClips.some((c) => near(c.start, 15) && near(c.in, 25)), `lift: видео вырезано [5,15): ${JSON.stringify(p.videoClips.map((c) => [c.start, c.in, c.out]))}`);
    ok(p.audioTracks[1].clips.length === 2, 'lift режет и музыку');
    const p2 = base();
    op.extractRange(p2, 5, 15); fix(p2);
    const starts = p2.videoClips.map((c) => +c.start.toFixed(3));
    ok(JSON.stringify(starts) === '[0,5,15]', `extract: видео без пустоты ${JSON.stringify(starts)}`);
    const a2 = p2.audioTracks[0].clips.find((c) => c.link && c.link.startsWith('L2'));
    const v2 = p2.videoClips.find((c) => c.link && c.link.startsWith('L2'));
    ok(a2 && v2 && near(a2.start, v2.start) && near(a2.in, v2.in) && a2.link === v2.link, 'связанный звук разрезан и стоит с видео');
    ok(near(Math.max(...p2.audioTracks[1].clips.map(E)), 30), 'музыка: конец сдвинут на 10');
    ok(near(p2.subtitleTracks[0].cues[0].start, 12), 'реплика после диапазона сдвинута');
    const p3 = base(); p3.videoLocked = true;
    op.liftRange(p3, 5, 15); fix(p3);
    ok(p3.videoClips.length === 3 && p3.audioTracks[0].clips.length === 2, 'видео с замком: и его звук не трогаем');
  }

  section('Q / W — обрезать до курсора');
  {
    const p = base();
    op.trimToTime(p, 'v2', 'start', 14); fix(p);
    ok(near(clip(p, 'v2').start, 10) && near(clip(p, 'v2').in, 24) && near(clip(p, 'a2').in, 24) && near(clip(p, 'a2').start, 10), 'Q: начало v2 до 14, сдвиг влево, звук тоже');
    ok(near(clip(p, 'v3').start, 21), `Q: v3 сдвинут на 4: ${clip(p, 'v3').start}`);
    const p2 = base();
    op.trimToTime(p2, 'v1', 'end', 6); fix(p2);
    ok(near(E(clip(p2, 'v1')), 6) && near(clip(p2, 'v2').start, 6) && near(E(clip(p2, 'a1')), 6), 'W: конец v1 до 6, v2 встал впритык');
    const p3 = base();
    op.trimToTime(p3, 'v1', 'end', 6, { ripple: false }); fix(p3);
    ok(near(E(clip(p3, 'v1')), 6) && near(clip(p3, 'v2').start, 10), 'Shift+W: без сдвига');
    ok(op.trimToTime(base(), 'v1', 'end', 0.05) === null, 'курсор у края — нечего обрезать');
  }

  section('Ripple / Roll / Slip / Slide');
  {
    const p = base();
    const d = op.rippleTrim(p, 'v1', 'r', -2); fix(p);
    ok(near(d, -2) && near(E(clip(p, 'v1')), 8) && near(clip(p, 'v2').start, 8) && near(E(clip(p, 'a1')), 8), 'ripple правый край −2');
    const p2 = base();
    op.rippleTrim(p2, 'v2', 'l', 3); fix(p2);
    ok(near(clip(p2, 'v2').start, 10) && near(clip(p2, 'v2').in, 23) && near(clip(p2, 'v3').start, 22), 'ripple левый край +3');
    const p2b = base();
    const dl = op.rippleTrim(p2b, 'v1', 'l', -5); fix(p2b);
    ok(near(dl, 0), `ripple: левее начала файла не удлинить: ${dl}`);
    const p3 = base();
    const r = op.rollEdit(p3, 'v1', 2); fix(p3);
    ok(near(r, 2) && near(E(clip(p3, 'v1')), 12) && near(clip(p3, 'v2').start, 12) && near(clip(p3, 'v2').in, 22) && near(E(clip(p3, 'v2')), 20), 'roll +2');
    ok(near(clip(p3, 'a2').start, 12) && near(clip(p3, 'a2').in, 22) && near(E(clip(p3, 'a1')), 12), 'roll: звук следом');
    const rl = op.rollEdit(base(), 'v1', 50);
    ok(near(rl, 10 - st.MIN_CLIP), `roll ограничен длиной правого клипа: ${rl}`);
    ok(op.rollEdit(base(), 'v2', 1) === 0, 'roll без соседа впритык — 0');
    const p4 = base();
    const s = op.slipClip(p4, 'v2', 5); fix(p4);
    ok(near(s, 5) && near(clip(p4, 'v2').in, 25) && near(clip(p4, 'v2').start, 10) && near(clip(p4, 'a2').in, 25), 'slip +5');
    ok(near(op.slipClip(base(), 'v1', -3), 0), 'slip: in не меньше 0');
    const p5 = base();
    const sl = op.slideClip(p5, 'v2', 2); fix(p5);
    ok(near(sl, 2) && near(clip(p5, 'v2').start, 12) && near(E(clip(p5, 'v1')), 12) && near(clip(p5, 'a2').start, 12), `slide +2: ${sl}`);
    const sl2 = op.slideClip(base(), 'v2', 9);
    ok(near(sl2, 5), `slide: в пределах пустоты до v3: ${sl2}`);
    ok(op.trimFrames(base(), 'roll', 'v1').length === 2, 'кадры для двойного предпросмотра');
  }

  section('Удалить паузы');
  {
    const c = V('x', 10, 20, 30);
    const r = op.silenceRanges(c, [{ start: 18, end: 21 }, { start: 24, end: 26 }, { start: 29, end: null }], { margin: 0.2, mediaDur: 100, fps: 25 });
    ok(r.length === 3 && near(r[0][0], 10) && near(r[0][1], 10.8) && near(r[1][0], 14.2) && near(r[1][1], 15.8) && near(r[2][0], 19.2) && near(r[2][1], 20), `промежутки: ${JSON.stringify(r)}`);
    const p = base();
    const res = op.removeRanges(p, 'v2', [[12, 13], [15, 17]]); fix(p);
    ok(near(res.removed, 3), `убрано 3 с: ${res.removed}`);
    const vs = p.videoClips.map((x) => [+x.start.toFixed(3), +x.in.toFixed(3), +x.out.toFixed(3)]);
    ok(JSON.stringify(vs) === '[[0,0,10],[10,20,22],[12,23,25],[14,27,30],[22,50,55]]', `видео после удаления пауз: ${JSON.stringify(vs)}`);
    const as = [...p.audioTracks[0].clips].sort((x, y) => x.start - y.start).map((x) => [+x.start.toFixed(3), +x.in.toFixed(3)]);
    ok(JSON.stringify(as) === '[[0,0],[10,20],[12,23],[14,27]]', `звук тоже: ${JSON.stringify(as)}`);
    ok(near(clip(p, 'mus').start, 0) && near(E(clip(p, 'mus')), 40), 'музыка поперёк — не тронута');
  }

  section('Привязка ко кадрам');
  ok(near(op.snapFrame(1.013, 25), 1.0) && near(op.snapFrame(1.03, 25), 1.04) && op.snapFrame(1.013, 0) === 1.013, 'snapFrame');

  console.log(`\nedit-test: ${passed} ok, ${failed} fail`);
  if (failed) process.exit(1);
  console.log('ВСЁ ОК');
})().catch((e) => { console.error(e); process.exit(1); });
