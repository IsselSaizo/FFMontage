// Правая колонка: вкладки «Свойства» (инспектор), «Переходы» и «Эффекты».
// Наведение на переход/эффект показывает его в плеере (проект не меняется), щелчок — применяет.
import { store } from './store.js';
import { h, $, icon, toast } from './util.js';
import { TRANSITIONS, applyTransition, DEFAULT_DURATION } from './transitions.js';
import { maxTransition } from './store.js';
import { EFFECTS, clipEffects } from './effects.js';

const TABS = [
  { id: 'props', name: 'Свойства', el: '#inspector' },
  { id: 'transitions', name: 'Переходы', el: '#browse-transitions' },
  { id: 'effects', name: 'Эффекты', el: '#browse-effects' },
];

// Стык для перехода: выделенный переход → стык у выделенного видеоклипа → ближайший к курсору
export function targetJunction() {
  const s = store.selection;
  if (s && s.kind === 'transition' && store.junctionBefore(s.id)) return s.id;
  const list = store.project.videoClips;
  const joints = list.map((c) => ({ id: c.id, j: store.junctionBefore(c.id) })).filter((x) => x.j);
  if (!joints.length) return null;
  if (s && s.kind === 'video') {
    const sel = store.findClip(s.id);
    if (sel) {
      const near = joints.filter((x) => x.j.a.id === s.id || x.j.b.id === s.id)
        .sort((a, b) => Math.abs(a.j.seam - store.time) - Math.abs(b.j.seam - store.time));
      if (near.length) return near[0].id;
    }
  }
  joints.sort((a, b) => Math.abs(a.j.seam - store.time) - Math.abs(b.j.seam - store.time));
  return joints[0].id;
}

// Клип для эффекта: выделенный видеоклип, иначе видео под курсором
export function targetClip() {
  const s = store.selection;
  if (s && s.kind === 'video' && store.findClip(s.id)) return s.id;
  const seg = store.videoLayout().find((x) => store.time >= x.start && store.time < x.end);
  return seg ? seg.clip.id : null;
}

export function initBrowser() {
  const tabsEl = $('#rp-tabs');
  let current = localStorage.getItem('ffm.rightTab') || 'props';
  const show = (id) => {
    current = id;
    localStorage.setItem('ffm.rightTab', id);
    for (const t of TABS) {
      $(t.el).hidden = t.id !== id;
      tabsEl.querySelector(`[data-tab="${t.id}"]`).classList.toggle('on', t.id === id);
    }
    if (id === 'transitions') renderTransitions();
    if (id === 'effects') renderEffects();
  };
  for (const t of TABS) tabsEl.append(h('button', { class: 'rp-tab', dataset: { tab: t.id }, onclick: () => show(t.id) }, t.name));

  // --- Переходы ---
  const trRoot = $('#browse-transitions');
  function renderTransitions() {
    if (trRoot.hidden) return;
    trRoot.innerHTML = '';
    const bId = targetJunction();
    const j = bId ? store.junctionBefore(bId) : null;
    const cur = j && j.b.transition;
    trRoot.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Переходы')),
      h('p', { class: 'muted small' }, j
        ? `Наведите — переход покажется в плеере на стыке «${store.clipName(j.a)}» → «${store.clipName(j.b)}». Щелчок — поставить.`
        : 'Поставьте два видеоклипа впритык — тогда сюда можно будет выбрать переход для стыка. Наведение показывает переход на образце.'));
    const grid = h('div', { class: 'tr-grid' });
    for (const t of TRANSITIONS) {
      const a = h('div', { class: 'tp-a' }); const b = h('div', { class: 'tp-b' }); const ov = h('div', { class: 'tp-ov' });
      const tile = h('button', {
        class: `tr-tile${cur && cur.type === t.id ? ' on' : ''}`, dataset: { type: t.id }, title: t.name,
        onclick: () => {
          const id = targetJunction();
          if (!id) { toast('Нет стыка: поставьте два видеоклипа впритык', 'info', 2400); return; }
          const jj = store.junctionBefore(id);
          const d = jj.b.transition ? jj.b.transition.duration : Math.min(DEFAULT_DURATION, maxTransition(jj.a, jj.b));
          store.setTransition(id, t.id, d);
          store.select({ kind: 'transition', id });
        },
      }, h('div', { class: 'tp-thumb' }, a, b, ov), h('span', {}, t.name));
      applyTransition(t.id, 0.5, a, b, ov);
      let raf = null; let t0 = 0;
      const anim = (now) => { const p = ((now - t0) / 1400) % 1; applyTransition(t.id, Math.min(1, p * 1.25), a, b, ov); raf = requestAnimationFrame(anim); };
      tile.addEventListener('mouseenter', () => {
        t0 = performance.now(); raf = requestAnimationFrame(anim);
        const id = targetJunction();
        if (id) store.emit('preview-transition', { bId: id, type: t.id, el: tile });
      });
      tile.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); applyTransition(t.id, 0.5, a, b, ov); store.emit('preview-transition', null); });
      grid.append(tile);
    }
    trRoot.append(grid);
  }

  // --- Эффекты ---
  const fxRoot = $('#browse-effects');
  function renderEffects() {
    if (fxRoot.hidden) return;
    fxRoot.innerHTML = '';
    const id = targetClip();
    const c = id ? store.findClip(id).clip : null;
    const on = c ? clipEffects(c) : [];
    fxRoot.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Эффекты')),
      h('p', { class: 'muted small' }, c
        ? `Клип «${store.clipName(c)}». Наведите — эффект покажется в плеере, щелчок — включить или выключить. Чтобы эффект был только на части клипа, сначала разрежьте его (S или лезвие B).`
        : 'Выделите видеоклип (или поставьте курсор на него). Эффект действует на весь клип — для фрагмента разрежьте клип (S или лезвие B).'));
    const grid = h('div', { class: 'fx-grid' });
    for (const e of EFFECTS) {
      const sw = h('div', { class: 'fx-sample', style: { filter: e.css(120) } });
      const tile = h('button', {
        class: `fx-tile${on.includes(e.id) ? ' on' : ''}`, dataset: { fx: e.id }, title: e.name, disabled: !c,
        onclick: () => {
          const cid = targetClip();
          if (!cid) return;
          store.emit('preview-effect', null);
          store.toggleEffect(cid, e.id);
        },
      }, sw, h('span', {}, e.name), on.includes(e.id) ? h('span', { class: 'fx-check', html: icon('check', 13) }) : null);
      tile.addEventListener('mouseenter', () => {
        const cid = targetClip();
        if (!cid) return;
        const cc = store.findClip(cid).clip;
        const cur = clipEffects(cc);
        store.emit('preview-effect', { clipId: cid, effects: cur.includes(e.id) ? cur.filter((x) => x !== e.id) : [...cur, e.id] });
      });
      tile.addEventListener('mouseleave', () => store.emit('preview-effect', null));
      grid.append(tile);
    }
    fxRoot.append(grid);
  }

  const refresh = () => { if (current === 'transitions') renderTransitions(); if (current === 'effects') renderEffects(); };
  store.on('project', refresh);
  store.on('selection', refresh);
  // Курсор двигается (в т. ч. при воспроизведении) — перерисовываем, только если сменился клип/стык под ним
  let lastKey = '';
  store.on('time', () => {
    if (current === 'props') return;
    const k = `${targetClip()}|${targetJunction()}`;
    if (k !== lastKey) { lastKey = k; refresh(); }
  });
  store.on('focus-inspector', () => show('props'));
  show(current);
  return { show };
}
