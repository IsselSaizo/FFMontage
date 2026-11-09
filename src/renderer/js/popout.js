// Панели в отдельных окнах (0.5.0): медиафайлы, плеер, правая колонка (свойства / переходы / эффекты / текст),
// таймлайн — кнопка ⧉ у панели открывает её в своём окне, которое можно унести на второй монитор.
//
// Как устроено: window.open('about:blank') — окно того же источника (Rust: windows.rs, on_new_window создаёт для
// него настоящее окно Tauri). Панель переносится туда как есть (тот же DOM-узел, те же обработчики, тот же store):
// ничего не перерисовывается заново и не синхронизируется. В главном окне на её месте — заглушка «Вернуть».
//   • стили главного окна копируются в отдельное (в т.ч. появившиеся позже — шрифты, плагины);
//   • классы и data-атрибуты <body>/<html> главного окна повторяются в отдельном (режим, курсоры перетаскивания);
//   • клавиши из отдельного окна передаются главному (горячие клавиши), кроме ввода в поля;
//   • движения мыши при перетаскивании (pointermove/up) передаются главному окну — там слушают перетаскивания;
//   • меню, всплывающие панели, диалоги и уведомления открываются в окне последнего действия (uidoc.js);
//   • свёрнутое главное окно не останавливает анимацию плеера: requestAnimationFrame идёт через видимое окно панели.
// Окно закрыли — панель возвращается на место. Положение и размер окон — settings.json → ui.popouts.<id>;
// какие панели были вынесены — восстанавливаются при следующем запуске.
import { h, icon, t, toast } from './util.js';
import { addPopDoc, removePopDoc, setUiDoc, popDocs } from './uidoc.js';
import { getPref, setPref } from './prefs.js';
import { closePopover } from './popover.js';
import { closeMenu } from './contextMenu.js';

export const POPOUT_PANELS = {
  media: { sel: '#media-panel', title: () => t('Медиафайлы'), area: 'left', size: [420, 780] },
  preview: { sel: '#center', title: () => t('Плеер'), area: 'center', size: [1280, 820] },
  right: { sel: '#right-side', title: () => t('Свойства'), area: 'right', size: [440, 880] },
  timeline: { sel: '#timeline', title: () => t('Таймлайн'), area: null, size: [1600, 460] },
};

const opened = new Map(); // id → { win, el, ph, poll, obs }
const hooks = [];
/** fn(id, event): event — 'out' (панель ушла в окно), 'in' (вернулась), 'resize' (окно панели изменило размер) */
export const onPopout = (fn) => { hooks.push(fn); };
const fire = (id, ev) => { for (const fn of hooks) { try { fn(id, ev); } catch (e) { console.warn('popout hook', e); } } };

export const isPoppedOut = (id) => opened.has(id);
export const poppedOut = () => [...opened.keys()];

const typingTarget = (el) => {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return el.isContentEditable || tag === 'textarea' || tag === 'select'
    || (tag === 'input' && !['range', 'checkbox', 'button', 'radio', 'color'].includes(el.type));
};

// --- стили и атрибуты главного окна → отдельное ---
function syncHead(d) {
  for (const n of [...d.head.querySelectorAll('[data-po-copy]')]) n.remove();
  for (const n of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const c = n.cloneNode(true);
    if (n.tagName === 'LINK') c.href = n.href; // абсолютный адрес: у about:blank своей базы нет
    c.dataset.poCopy = '1';
    d.head.append(c);
  }
}
function syncAttrs(d) {
  d.documentElement.lang = document.documentElement.lang;
  d.documentElement.setAttribute('style', document.documentElement.getAttribute('style') || '');
  d.documentElement.className = document.documentElement.className;
  const b = document.body;
  for (const a of [...d.body.attributes]) if (a.name !== 'class' && !b.hasAttribute(a.name)) d.body.removeAttribute(a.name);
  for (const a of b.attributes) if (a.name !== 'class') d.body.setAttribute(a.name, a.value);
  d.body.className = `${b.className} popout`.trim();
}

// --- кнопки ---
function popBtn(id) {
  const b = h('button', { class: 'po-btn', dataset: { popout: id }, title: t('Открыть в отдельном окне (например, на втором мониторе)'), html: icon('popout', 15) });
  b.addEventListener('click', (e) => { e.stopPropagation(); if (isPoppedOut(id)) dock(id); else popOut(id); });
  return b;
}

/** Кнопки ⧉ на панелях: заголовок медиафайлов, вкладки правой колонки, панель над плеером, панель таймлайна */
export function initPopouts() {
  const put = (sel, id, where = 'append') => {
    const host = document.querySelector(sel);
    if (!host) return;
    host[where](popBtn(id));
  };
  const mh = document.querySelector('#media-panel .panel-head');
  if (mh) mh.classList.add('with-po');
  put('#media-panel .panel-head', 'media');
  put('#rp-tabs', 'right');
  put('#viewbar .vb-side.right', 'preview');
  put('#timeline .tl-toolbar', 'timeline');
  installRaf();
  // Главное окно закрывается или перезагружается — окна панелей закрываются вместе с ним
  window.addEventListener('pagehide', () => { for (const x of opened.values()) { try { x.win.close(); } catch { /* уже закрыто */ } } });
  // Последний документ действия — главный
  document.addEventListener('pointerdown', () => setUiDoc(document), true);
  document.addEventListener('keydown', () => setUiDoc(document), true);
  // Панели, вынесенные в прошлый раз (не в автотестах — им нужно одно окно)
  const boot = window.__FFM_BOOT || {};
  const was = boot.selftest ? [] : getPref('ui.popoutOpen', []);
  if (Array.isArray(was)) for (const id of was) if (POPOUT_PANELS[id]) setTimeout(() => popOut(id, { restore: true }), 300);
}

function remember() {
  setPref('ui.popoutOpen', poppedOut());
}

/** Вынести панель id в отдельное окно. false — окно не открылось. */
export function popOut(id, { restore = false } = {}) {
  const P = POPOUT_PANELS[id];
  if (!P || opened.has(id)) return false;
  const el = document.querySelector(P.sel);
  if (!el) return false;
  closeMenu(); closePopover();
  const saved = getPref(`ui.popouts.${id}`, null);
  const [w0, h0] = P.size;
  const geo = saved && saved.w > 100 && saved.h > 80
    ? { left: saved.x, top: saved.y, width: saved.w, height: saved.h }
    : { left: (window.screenX || 0) + 80, top: (window.screenY || 0) + 80, width: w0, height: h0 };
  const feat = `popup=1,left=${Math.round(geo.left)},top=${Math.round(geo.top)},width=${Math.round(geo.width)},height=${Math.round(geo.height)}`;
  let win = null;
  try { win = window.open('about:blank', `ffm_panel_${id}`, feat); } catch (e) { console.warn('popout', e); }
  if (!win) {
    if (!restore) toast(t('Не удалось открыть отдельное окно'), 'error', 4000);
    return false;
  }
  const d = win.document;
  if (!d.head) d.documentElement.prepend(d.createElement('head'));
  if (!d.body) d.documentElement.append(d.createElement('body'));
  d.title = `${P.title()} — FF Montage`;
  const meta = d.createElement('meta'); meta.setAttribute('charset', 'utf-8'); d.head.prepend(meta);
  syncHead(d);
  syncAttrs(d);
  const root = d.createElement('div');
  root.className = `popout-root po-${id}`;
  d.body.append(root);

  // Заглушка в главном окне
  const ph = h('div', { class: `popout-ph${P.area === 'left' || P.area === 'right' ? ' narrow' : ''}`, dataset: { po: id }, style: P.area ? { gridArea: P.area } : {} },
    h('button', { class: 'btn ghost small', title: t('Вернуть панель в главное окно'), onclick: () => dock(id) },
      h('span', { html: icon('dock', 15) }), h('span', { class: 'po-ph-name' }, t('{name} — в отдельном окне', { name: P.title() }))));
  el.replaceWith(ph);
  root.append(el);
  document.getElementById('app')?.classList.add(`po-${id}`);
  addPopDoc(d);

  // Стили / атрибуты главного окна меняются — повторяем
  const obs = new MutationObserver((list) => {
    if (list.some((m) => m.target === document.head)) syncHead(d);
    if (list.some((m) => m.type === 'attributes')) syncAttrs(d);
  });
  obs.observe(document.head, { childList: true });
  obs.observe(document.body, { attributes: true });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang'] });

  // События отдельного окна
  d.addEventListener('pointerdown', () => setUiDoc(d), true);
  // Щелчок мимо закрывает всплывающие панели (как в главном окне; кнопка и сама панель останавливают всплытие)
  d.addEventListener('pointerdown', () => closePopover());
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); }, true);
  const fwdKey = (e) => {
    setUiDoc(d);
    if (e.defaultPrevented || typingTarget(e.target) || d.querySelector('.modal-overlay')) return;
    const ev = new KeyboardEvent(e.type, {
      key: e.key, code: e.code, location: e.location, repeat: e.repeat,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
    });
    if (!document.dispatchEvent(ev)) e.preventDefault();
  };
  win.addEventListener('keydown', fwdKey);
  win.addEventListener('keyup', fwdKey);
  // Перетаскивания слушают pointermove/pointerup у главного окна
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    win.addEventListener(type, (e) => {
      try { document.dispatchEvent(new PointerEvent(type, e)); } catch (err) { console.warn('popout fwd', err); }
    });
  }
  // Файлы, брошенные из Проводника на отдельное окно, обработать нечем — не даём WebView открыть их как страницу
  win.addEventListener('dragover', (e) => e.preventDefault());
  win.addEventListener('drop', (e) => e.preventDefault());
  let rz = 0;
  win.addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); fire(id, 'resize'); saveGeo(id, win); });
  });
  win.addEventListener('pagehide', () => dock(id, { closing: true }));
  // Окно Tauri закрыли крестиком — pagehide приходит не всегда: проверяем и так
  const poll = setInterval(() => {
    if (win.closed) dock(id, { closing: true });
    else saveGeo(id, win);
  }, 1000);

  opened.set(id, { win, el, ph, poll, obs });
  for (const b of document.querySelectorAll(`.po-btn[data-popout="${id}"]`)) setBtn(b, true);
  for (const b of d.querySelectorAll(`.po-btn[data-popout="${id}"]`)) setBtn(b, true);
  remember();
  fire(id, 'out');
  win.focus();
  return true;
}

function setBtn(b, out) {
  b.classList.toggle('on', out);
  b.innerHTML = icon(out ? 'dock' : 'popout', 15);
  b.title = out ? t('Вернуть панель в главное окно') : t('Открыть в отдельном окне (например, на втором мониторе)');
}

function saveGeo(id, win) {
  try {
    if (win.closed) return;
    const g = { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight };
    const old = getPref(`ui.popouts.${id}`, null);
    if (!old || old.x !== g.x || old.y !== g.y || old.w !== g.w || old.h !== g.h) setPref(`ui.popouts.${id}`, g);
  } catch { /* окно закрывается */ }
}

/** Вернуть панель в главное окно (и закрыть её окно) */
export function dock(id, { closing = false } = {}) {
  const x = opened.get(id);
  if (!x) return;
  opened.delete(id);
  clearInterval(x.poll);
  x.obs.disconnect();
  closeMenu(); closePopover();
  if (!closing) saveGeo(id, x.win);
  try { removePopDoc(x.win.document); } catch { /* окно уже уничтожено */ }
  // Панель — обратно в главный документ, на место заглушки
  if (x.ph.isConnected) x.ph.replaceWith(x.el);
  else document.getElementById('app')?.append(x.el);
  document.getElementById('app')?.classList.remove(`po-${id}`);
  for (const b of document.querySelectorAll(`.po-btn[data-popout="${id}"]`)) setBtn(b, false);
  if (!closing) { try { x.win.close(); } catch { /* уже закрыто */ } }
  setUiDoc(document);
  remember();
  fire(id, 'in');
  window.dispatchEvent(new Event('resize'));
}

// Главное окно свёрнуто: его requestAnimationFrame стоит — анимация плеера и таймлайна идёт через окно панели
let rafInstalled = false;
function installRaf() {
  if (rafInstalled || typeof window.requestAnimationFrame !== 'function') return;
  rafInstalled = true;
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const map = new Map();
  let seq = 0;
  window.requestAnimationFrame = (cb) => {
    const w = document.hidden ? popDocs().map((d) => d.defaultView).find((v) => v && !v.document.hidden) : null;
    if (!w) return raf(cb);
    const id = -(++seq);
    map.set(id, { w, rid: w.requestAnimationFrame((ts) => { map.delete(id); cb(ts); }) });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (id < 0) { const x = map.get(id); if (x) { try { x.w.cancelAnimationFrame(x.rid); } catch { /* окно закрыто */ } map.delete(id); } } else caf(id);
  };
}
