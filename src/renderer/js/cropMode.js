// Режим кадрирования в плеере: рамка с ручками поверх всего кадра клипа.
// Enter — применить, Esc — отменить. Галочка «ко всем клипам этого файла» — по желанию (по умолчанию выключена).
import { store } from './store.js';
import { h, toast, t } from './util.js';
import { clipEnd } from './clipTime.js';

const MIN = 0.05;          // самая маленькая рамка — 5% кадра
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function initCropMode(preview) {
  let st = null; // { id, crop: {l,t,r,b}, box, ui, all }

  const frameRect = () => {
    // Где на «экране» нарисован весь кадр клипа (вписан целиком)
    const f = store.findClip(st.id);
    const m = f && store.media(f.clip.mediaId);
    const W = preview.stage.clientWidth; const H = preview.stage.clientHeight;
    const ar = m && m.width && m.height ? m.width / m.height : W / H;
    let w = W; let hh = W / ar;
    if (hh > H) { hh = H; w = H * ar; }
    return { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh };
  };

  const draw = () => {
    if (!st) return;
    const r = frameRect();
    const { l, t, r: rr, b } = st.crop;
    Object.assign(st.box.style, {
      left: `${r.x + l * r.w}px`, top: `${r.y + t * r.h}px`,
      width: `${(1 - l - rr) * r.w}px`, height: `${(1 - t - b) * r.h}px`,
    });
    const pct = (x) => `${Math.round(x * 100)}%`;
    st.size.textContent = `${pct(1 - l - rr)} × ${pct(1 - t - b)}`;
  };

  const drag = (kind) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = frameRect();
    const x0 = e.clientX; const y0 = e.clientY;
    const c0 = { ...st.crop };
    const move = (ev) => {
      const dx = (ev.clientX - x0) / r.w; const dy = (ev.clientY - y0) / r.h;
      const c = { ...c0 };
      const clampL = (v) => Math.max(0, Math.min(1 - MIN - c.r, v));
      const clampR = (v) => Math.max(0, Math.min(1 - MIN - c.l, v));
      const clampT = (v) => Math.max(0, Math.min(1 - MIN - c.b, v));
      const clampB = (v) => Math.max(0, Math.min(1 - MIN - c.t, v));
      if (kind === 'move') {
        const w = 1 - c0.l - c0.r; const hh = 1 - c0.t - c0.b;
        c.l = Math.max(0, Math.min(1 - w, c0.l + dx)); c.r = 1 - w - c.l;
        c.t = Math.max(0, Math.min(1 - hh, c0.t + dy)); c.b = 1 - hh - c.t;
      } else {
        if (kind.includes('w')) c.l = clampL(c0.l + dx);
        if (kind.includes('e')) c.r = clampR(c0.r - dx);
        if (kind.includes('n')) c.t = clampT(c0.t + dy);
        if (kind.includes('s')) c.b = clampB(c0.b - dy);
      }
      st.crop = c;
      draw();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  function exit() {
    if (!st) return;
    st.ui.remove();
    document.removeEventListener('keydown', onKey, true);
    preview.cropEdit = null;
    document.body.classList.remove('cropping');
    st = null;
    store.emit('crop-mode-changed', false);
    preview.seek(store.time);
  }

  function apply() {
    if (!st) return;
    const f = store.findClip(st.id);
    if (!f) { exit(); return; }
    const ids = st.allCheck.checked
      ? store.project.videoClips.filter((c) => c.mediaId === f.clip.mediaId).map((c) => c.id)
      : [st.id];
    const crop = st.crop;
    exit();
    store.setCrop(ids, crop);
    if (ids.length > 1) toast(t('Кадрирование — для {n} клипов этого файла', { n: ids.length }), 'success', 2200);
  }

  function onKey(e) {
    if (!st) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === 'Enter' && tag !== 'button') { e.preventDefault(); e.stopImmediatePropagation(); apply(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); exit(); }
    else if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation(); // остальные клавиши монтажа в режиме кадрирования не работают
  }

  function enter(id) {
    if (st) exit();
    const f = store.findClip(id);
    if (!f || f.kind !== 'video') return;
    if (preview.playing) preview.pause();
    // Курсор — внутрь клипа, чтобы был виден его кадр
    if (store.time < f.clip.start || store.time >= clipEnd(f.clip) - 0.01) store.setTime(Math.min(clipEnd(f.clip) - 0.05, f.clip.start + 0.05));
    const cr = f.clip.crop || {};
    st = { id, crop: { l: cr.l || 0, t: cr.t || 0, r: cr.r || 0, b: cr.b || 0 } };
    preview.cropEdit = id;
    preview.seek(store.time);

    st.size = h('span', { class: 'crop-size' });
    st.box = h('div', { class: 'crop-box' }, st.size, ...HANDLES.map((k) => {
      const hd = h('div', { class: `crop-h ${k}`, dataset: { h: k } });
      hd.addEventListener('pointerdown', drag(k));
      return hd;
    }));
    st.box.addEventListener('pointerdown', drag('move'));
    st.allCheck = h('input', { type: 'checkbox', id: 'crop-all' });
    const same = store.project.videoClips.filter((c) => c.mediaId === f.clip.mediaId).length;
    st.ui = h('div', { class: 'crop-layer' }, st.box,
      h('div', { class: 'crop-bar', onpointerdown: (e) => e.stopPropagation() },
        same > 1 ? h('label', { class: 'check-row', title: t('Необязательно: та же рамка у всех клипов, вырезанных из этого файла') },
          st.allCheck, h('span', {}, t('Ко всем клипам этого файла ({n})', { n: same }))) : null,
        h('button', { class: 'btn ghost small', id: 'crop-reset', onclick: () => { st.crop = { l: 0, t: 0, r: 0, b: 0 }; draw(); } }, t('Сбросить')),
        h('button', { class: 'btn ghost small', id: 'crop-cancel', title: 'Esc', onclick: exit }, t('Отмена')),
        h('button', { class: 'btn primary small', id: 'crop-apply', title: 'Enter', onclick: apply }, t('Применить'))));
    preview.stage.append(st.ui);
    document.body.classList.add('cropping');
    document.addEventListener('keydown', onKey, true);
    draw();
    store.emit('crop-mode-changed', true);
  }

  store.on('crop-mode', (id) => { if (st && st.id === id) exit(); else enter(id); });
  // Клип пропал / выбрали другой / сменили вкладку — выходим без изменений
  store.on('selection', () => { if (st && (!store.selection || store.selection.id !== st.id)) exit(); });
  store.on('project', () => { if (st && !store.findClip(st.id)) exit(); else draw(); });
  store.on('mode', () => exit());
  new ResizeObserver(() => draw()).observe(preview.stage);
  return { enter, exit, apply, get active() { return st ? { id: st.id, crop: { ...st.crop } } : null; }, set(crop) { if (st) { st.crop = { ...crop }; draw(); } } };
}
