// Правая колонка: вкладки «Свойства» (инспектор), «Переходы» и «Фильтры» (id вкладки — 'effects'),
// за ними — вкладки панелей плагинов (addTab/removeTab из js/plugins/host.js, iframe-песочница внутри).
// Наведение на переход/эффект показывает его в плеере (проект не меняется), щелчок — применяет.
// Списки перерисовываются и при изменении реестра (плагин добавил/убрал эффект или переход).
import { store } from './store.js';
import { h, $, icon, toast, t } from './util.js';
import { getLang } from './i18n.js';
import { TRANSITIONS, applyTransition, DEFAULT_DURATION } from './transitions.js';
import { maxTransition } from './store.js';
import { EFFECTS, clipEffects } from './effects.js';
import { keyHint } from './keymap.js';
import * as registry from './registry.js';
import { renderTextPanel } from './textPanel.js';
import { onFontsChange } from './fonts.js';
import { getPref, setPref } from './prefs.js';

const TABS = [
  { id: 'props', name: t('Свойства'), el: '#inspector' },
  { id: 'transitions', name: t('Переходы'), el: '#browse-transitions' },
  { id: 'effects', name: t('Фильтры'), el: '#browse-effects' },
  { id: 'text', name: t('Текст'), el: '#browse-text' },
];

// Название из реестра: строка или { ru, en } (у плагинов)
const label = (v, fb = '') => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v[getLang()] || v.ru || v.en || fb;
  return fb;
};
const cssOf = (e, w) => { try { return typeof e.css === 'function' ? e.css(w) || '' : ''; } catch { return ''; } };

// Стык для перехода: выделенный переход → стык у выделенного видеоклипа → ближайший к курсору
export function targetJunction() {
  const s = store.selection;
  if (s && s.kind === 'transition' && store.junctionBefore(s.id)) return s.id;
  const list = store.allVideo();
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
  const tabs = TABS.map((x) => ({ ...x }));
  const elOf = (tab) => (typeof tab.el === 'string' ? $(tab.el) : tab.el);
  // Сохранённая вкладка может быть вкладкой плагина, который загрузится позже — тогда откроем её при появлении
  let wanted = getPref('ui.rightTab', 'props') || 'props';
  let current = wanted;
  const show = (id, remember = true) => {
    if (!tabs.some((x) => x.id === id)) id = 'props';
    current = id;
    if (remember) { wanted = id; setPref('ui.rightTab', id); }
    for (const tab of tabs) {
      const el = elOf(tab);
      if (el) el.hidden = tab.id !== id;
      tabsEl.querySelector(`[data-tab="${CSS.escape(tab.id)}"]`)?.classList.toggle('on', tab.id === id);
    }
    if (id === 'transitions') renderTransitions();
    if (id === 'effects') renderEffects();
    if (id === 'text') renderTextPanel($('#browse-text'));
  };
  const tabButton = (tab) => h('button', {
    class: `rp-tab${tab.plugin ? ' plugin' : ''}`, dataset: { tab: tab.id, ...(tab.plugin ? { plugin: tab.plugin } : {}) },
    title: tab.title || null, onclick: () => show(tab.id),
  }, tab.name);
  for (const tab of TABS) tabsEl.append(tabButton(tab));

  // Вкладки плагинов: { id, name, el (элемент панели в #right-side), title?, plugin? }
  function addTab(tab) {
    if (!tab || !tab.id || tabs.some((x) => x.id === tab.id)) return false;
    tabs.push(tab);
    tabsEl.append(tabButton(tab));
    if (tab.el) tab.el.hidden = current !== tab.id;
    if (wanted === tab.id && current !== tab.id) show(tab.id, false);
    return true;
  }
  function removeTab(id) {
    const i = tabs.findIndex((x) => x.id === id);
    if (i < TABS.length) return false; // встроенные не убираются
    tabs.splice(i, 1);
    tabsEl.querySelector(`[data-tab="${CSS.escape(id)}"]`)?.remove();
    if (current === id) show('props', false);
    return true;
  }

  // --- Переходы ---
  const trRoot = $('#browse-transitions');
  function renderTransitions() {
    if (trRoot.hidden) return;
    trRoot.innerHTML = '';
    const bId = targetJunction();
    const j = bId ? store.junctionBefore(bId) : null;
    const cur = j && j.b.transition;
    trRoot.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Переходы'))),
      h('p', { class: 'muted small' }, j
        ? t('Наведите — переход покажется в плеере на стыке «{a}» → «{b}». Щелчок — поставить.', { a: store.clipName(j.a), b: store.clipName(j.b) })
        : t('Поставьте два видеоклипа впритык — тогда сюда можно будет выбрать переход для стыка. Наведение показывает переход на образце.')));
    const grid = h('div', { class: 'tr-grid' });
    for (const tr of TRANSITIONS) {
      const a = h('div', { class: 'tp-a' }); const b = h('div', { class: 'tp-b' }); const ov = h('div', { class: 'tp-ov' });
      const name = label(tr.name, tr.id);
      const tile = h('button', {
        class: `tr-tile${cur && cur.type === tr.id ? ' on' : ''}`, dataset: { type: tr.id }, title: name,
        onclick: () => {
          const id = targetJunction();
          if (!id) { toast(t('Нет стыка: поставьте два видеоклипа впритык'), 'info', 2400); return; }
          const jj = store.junctionBefore(id);
          const d = jj.b.transition ? jj.b.transition.duration : Math.min(DEFAULT_DURATION, maxTransition(jj.a, jj.b));
          store.setTransition(id, tr.id, d);
          store.select({ kind: 'transition', id });
        },
      }, h('div', { class: 'tp-thumb' }, a, b, ov), h('span', {}, name));
      // Ошибка в описании перехода плагина не должна ломать весь список
      const apply = (p) => { try { applyTransition(tr.id, p, a, b, ov); } catch (e) { console.warn('transition preview', tr.id, e); } };
      apply(0.5);
      let raf = null; let t0 = 0;
      const anim = (now) => { const p = ((now - t0) / 1400) % 1; apply(Math.min(1, p * 1.25)); raf = requestAnimationFrame(anim); };
      tile.addEventListener('mouseenter', () => {
        t0 = performance.now(); raf = requestAnimationFrame(anim);
        const id = targetJunction();
        if (id) store.emit('preview-transition', { bId: id, type: tr.id, el: tile });
      });
      tile.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); apply(0.5); store.emit('preview-transition', null); });
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
    fxRoot.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Фильтры'))),
      h('p', { class: 'muted small' }, c
        ? t('Клип «{name}». Наведите — фильтр покажется в плеере, щелчок — включить или выключить. Чтобы фильтр был только на части клипа, сначала разрежьте его ({split} или лезвие {blade}).', { name: store.clipName(c), split: keyHint('clip.split'), blade: keyHint('tool.blade') })
        : t('Выделите видеоклип (или поставьте курсор на него). Фильтр действует на весь клип — для фрагмента разрежьте клип ({split} или лезвие {blade}).', { split: keyHint('clip.split'), blade: keyHint('tool.blade') })));
    const grid = h('div', { class: 'fx-grid' });
    for (const e of EFFECTS) {
      const name = label(e.name, e.id);
      const sw = h('div', { class: 'fx-sample', style: { filter: cssOf(e, 120) } });
      const tile = h('button', {
        class: `fx-tile${on.includes(e.id) ? ' on' : ''}`, dataset: { fx: e.id }, title: name, disabled: !c,
        onclick: () => {
          const cid = targetClip();
          if (!cid) return;
          store.emit('preview-effect', null);
          store.toggleEffect(cid, e.id);
        },
      }, sw, h('span', {}, name), on.includes(e.id) ? h('span', { class: 'fx-check', html: icon('check', 13) }) : null);
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
  // Панель «Текст» не зависит от курсора — только от реестра стилей, шрифтов и дорожек субтитров
  const refreshText = () => { if (current === 'text') renderTextPanel($('#browse-text')); };
  onFontsChange(refreshText);
  let subSig = '';
  store.on('project', () => { const s = store.subtitleTracks().map((x) => `${x.id}:${x.cues.length}`).join(); if (s !== subSig) { subSig = s; refreshText(); } });
  if (typeof registry.onRegistryChange === 'function') registry.onRegistryChange((ev) => { if (!ev || ev.kind === 'textStyle') refreshText(); });
  store.on('project', refresh);
  store.on('selection', refresh);
  // Курсор двигается (в т. ч. при воспроизведении) — перерисовываем, только если сменился клип/стык под ним
  let lastKey = '';
  store.on('time', () => {
    if (current === 'props') return;
    const k = `${targetClip()}|${targetJunction()}`;
    if (k !== lastKey) { lastKey = k; refresh(); }
  });
  // «+» на стыке без перехода — сразу список переходов; иначе — свойства
  store.on('focus-inspector', (sec) => {
    if (sec === 'transition') {
      const s = store.selection;
      const j = s && s.kind === 'transition' ? store.junctionBefore(s.id) : null;
      if (j && !j.b.transition) { show('transitions'); return; }
    }
    show('props');
  });
  store.on('show-tab', (id) => show(id));
  // Плагин добавил или убрал эффекты/переходы
  if (typeof registry.onRegistryChange === 'function') {
    let pending = false;
    registry.onRegistryChange(() => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; refresh(); });
    });
  }
  show(current, false);
  return { show, addTab, removeTab, current: () => current };
}
