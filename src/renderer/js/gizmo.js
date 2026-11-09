// Гизмо трансформа в плеере (M4.4): рамка вокруг выделенного видеоклипа.
//   тянуть рамку — двигать; углы — масштаб (от центра); кружок сверху — поворот (Shift — шагом 15°);
//   щелчок по картинке в плеере выделяет самый верхний видимый клип под мышью.
// Магнит: центр клипа — к центру кадра, края — к краям кадра (Alt — без магнита).
// Перетаскивание идёт «вживую» (store.live) и пишет в историю одну запись за жест.
import { store } from './store.js';
import { h, t } from './util.js';
import { contentRect, hitContent, tfOf } from './transform.js';
import { clipEnd } from './clipTime.js';
import { graphicOf } from './graphicKinds.js';
import './textRender.js';   // рисунок и рамка текста (graphics.js)

const SNAP_PX = 7;
const CORNERS = ['nw', 'ne', 'se', 'sw'];

export function initGizmo(preview) {
  const stage = preview.stage;
  const box = h('div', { class: 'gz-box' },
    ...CORNERS.map((k) => h('div', { class: `gz-h ${k}`, dataset: { h: k } })),
    h('div', { class: 'gz-rot', dataset: { h: 'rot' } }),
    h('div', { class: 'gz-stem' }));
  const guideV = h('div', { class: 'gz-guide v' });
  const guideH = h('div', { class: 'gz-guide h' });
  const layer = h('div', { class: 'gz-layer' }, guideV, guideH, box);
  stage.append(layer);
  let drag = null;

  // Выделенный видеоклип, который сейчас виден в плеере (на своей дорожке, в момент курсора)
  const selected = () => {
    const s = store.selection;
    if (!s || s.kind !== 'video') return null;
    const f = store.findClip(s.id);
    if (!f || f.kind !== 'video') return null;
    if (store.time < f.clip.start - 0.004 || store.time >= clipEnd(f.clip) - 0.004) return null;
    return f;
  };
  // Графические клипы (graphics.js): рамка вида — у текста по раскладке, у титров «roll» — по текущему положению
  const rectOf = (clip) => {
    const g = graphicOf(clip);
    if (g && g.rect) return g.rect(clip, stage.clientWidth, stage.clientHeight, store.time - clip.start);
    return contentRect(clip, store.media(clip.mediaId), stage.clientWidth, stage.clientHeight);
  };
  const active = () => !preview.cropEdit && document.body.dataset.mode !== 'anim' && document.body.dataset.mode !== 'audio';

  function draw() {
    const f = active() ? selected() : null;
    if (!f || (f.lane.hidden && !drag)) { box.style.display = 'none'; return; }
    const r = rectOf(f.clip);
    Object.assign(box.style, {
      display: 'block', left: `${r.cx - r.w / 2}px`, top: `${r.cy - r.h / 2}px`, width: `${r.w}px`, height: `${r.h}px`,
      transform: r.rot ? `rotate(${r.rot}deg)` : '',
    });
    box.classList.toggle('locked', !!f.lane.locked);
  }

  function guides(gx, gy) {
    guideV.style.display = gx === null ? 'none' : 'block';
    guideH.style.display = gy === null ? 'none' : 'block';
    if (gx !== null) guideV.style.left = `${gx}px`;
    if (gy !== null) guideH.style.top = `${gy}px`;
  }

  function start(e, f, kind) {
    if (f.lane.locked) return;
    e.preventDefault(); e.stopPropagation();
    if (preview.playing) preview.pause();
    const W = stage.clientWidth; const H = stage.clientHeight;
    const r0 = rectOf(f.clip);
    const tf0 = tfOf(f.clip);
    const sr = stage.getBoundingClientRect();
    const p0 = { x: e.clientX - sr.left, y: e.clientY - sr.top };
    drag = { id: f.clip.id, before: store.snapshot(), moved: false };
    const move = (ev) => {
      const p = { x: ev.clientX - sr.left, y: ev.clientY - sr.top };
      if (!drag.moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 3) return;
      drag.moved = true;
      const snap = !ev.altKey;
      let patch; let gx = null; let gy = null;
      if (kind === 'move') {
        let cx = r0.cx + (p.x - p0.x); let cy = r0.cy + (p.y - p0.y);
        if (snap) {
          // ширина/высота рамки с учётом поворота (для краёв)
          const a = (r0.rot * Math.PI) / 180;
          const bw = Math.abs(r0.w * Math.cos(a)) + Math.abs(r0.h * Math.sin(a));
          const bh = Math.abs(r0.w * Math.sin(a)) + Math.abs(r0.h * Math.cos(a));
          const xs = [[W / 2, W / 2, 0], [bw / 2, 0, 0], [W - bw / 2, W, 0]];
          const ys = [[H / 2, H / 2, 0], [bh / 2, 0, 0], [H - bh / 2, H, 0]];
          for (const [want, line] of xs) if (Math.abs(cx - want) < SNAP_PX) { cx = want; gx = line; break; }
          for (const [want, line] of ys) if (Math.abs(cy - want) < SNAP_PX) { cy = want; gy = line; break; }
        }
        patch = { x: (cx - W / 2) / W, y: (cy - H / 2) / H };
      } else if (kind === 'rot') {
        const ang = (Math.atan2(p.y - r0.cy, p.x - r0.cx) * 180) / Math.PI + 90;
        let rot = ((ang + 540) % 360) - 180;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        else if (snap) for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(rot - s) < 3) rot = s;
        patch = { rotate: rot };
      } else {
        // угол: масштаб от центра по расстоянию до мыши
        const d0 = Math.hypot(p0.x - r0.cx, p0.y - r0.cy) || 1;
        const d1 = Math.hypot(p.x - r0.cx, p.y - r0.cy);
        let sc = tf0.scale * (d1 / d0);
        if (snap && Math.abs(sc - 1) < 0.03) sc = 1;
        if (snap && Math.abs(sc - 0.5) < 0.015) sc = 0.5;
        patch = { scale: sc };
      }
      guides(gx, gy);
      store.setTransform([drag.id], patch, { live: true });
      draw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      guides(null, null);
      const d = drag; drag = null;
      if (d && d.moved) store.commitFrom(d.before);
      draw();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const f = selected();
    if (!f) return;
    const k = e.target.dataset && e.target.dataset.h;
    start(e, f, k === 'rot' ? 'rot' : k ? 'scale' : 'move');
  });

  // Щелчок по картинке: выделить самый верхний видимый клип под мышью и сразу его тянуть
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !active() || e.target.closest('.gz-box, .crop-layer, .stage-msg button')) return;
    const sr = stage.getBoundingClientRect();
    const x = e.clientX - sr.left; const y = e.clientY - sr.top;
    const lanes = store.vlanes().filter((l) => !l.hidden).reverse();
    for (const lane of lanes) {
      const c = lane.clips.find((x2) => store.time >= x2.start - 0.004 && store.time < clipEnd(x2) - 0.004);
      if (!c || !hitContent(rectOf(c), x, y)) continue;
      if (!store.selection || store.selection.id !== c.id) store.select({ kind: 'video', id: c.id });
      start(e, { clip: c, lane }, 'move');
      return;
    }
  });

  for (const ev of ['project', 'selection', 'time', 'mode', 'crop-mode-changed']) store.on(ev, () => { if (!drag || ev !== 'project') draw(); });
  new ResizeObserver(() => draw()).observe(stage);
  draw();
  return { draw, get dragging() { return !!drag; } };
}
