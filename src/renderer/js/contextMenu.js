// Контекстное меню (правая кнопка мыши) в стиле программы.
// items: [{ label, icon, key, onClick, disabled, danger }] | 'sep' | { header: 'Текст' }
import { h, icon } from './util.js';
import { uiDoc } from './uidoc.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.el.remove();
  const { doc, win } = current;
  doc.removeEventListener('pointerdown', current.onDown, true);
  doc.removeEventListener('keydown', current.onKey, true);
  win.removeEventListener('blur', closeMenu);
  win.removeEventListener('resize', closeMenu);
  current = null;
}

export function openMenu(x, y, items) {
  closeMenu();
  const el = h('div', { class: 'ctx-menu', role: 'menu' });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { el.append(h('div', { class: 'ctx-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'ctx-header' }, it.header)); continue; }
    const b = h('button', {
      class: `ctx-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: !!it.disabled,
      onclick: () => { closeMenu(); it.onClick && it.onClick(); },
    },
    h('span', { class: 'ctx-ic', html: it.icon ? icon(it.icon, 17) : '' }),
    h('span', { class: 'ctx-label' }, it.label),
    it.key ? h('span', { class: 'ctx-key' }, it.key) : null);
    if (it.id) b.dataset.action = it.id;
    buttons.push(b);
    el.append(b);
  }
  // Меню — в окне, где щёлкнули (главное или отдельное окно панели, 0.5.0)
  const doc = uiDoc();
  const win = doc.defaultView || window;
  doc.body.append(el);
  // Не даём меню вылезти за край окна
  const r = el.getBoundingClientRect();
  const left = Math.min(x, win.innerWidth - r.width - 6);
  const top = y + r.height > win.innerHeight - 6 ? Math.max(6, y - r.height) : y;
  Object.assign(el.style, { left: `${Math.max(6, left)}px`, top: `${top}px` });

  const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(doc.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (enabled[i + 1] || enabled[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); (enabled[i - 1] || enabled[enabled.length - 1])?.focus(); }
  };
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('blur', closeMenu);
  win.addEventListener('resize', closeMenu);
  current = { el, onDown, onKey, doc, win };
  return el;
}

export const menuOpen = () => !!current;
