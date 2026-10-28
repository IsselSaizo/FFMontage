// Контекстное меню (правая кнопка мыши) в стиле программы.
// items: [{ label, icon, key, onClick, disabled, danger }] | 'sep' | { header: 'Текст' }
import { h, icon } from './util.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener('pointerdown', current.onDown, true);
  document.removeEventListener('keydown', current.onKey, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
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
  document.body.append(el);
  // Не даём меню вылезти за край окна
  const r = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 6);
  const top = y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y;
  Object.assign(el.style, { left: `${Math.max(6, left)}px`, top: `${top}px` });

  const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (enabled[i + 1] || enabled[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); (enabled[i - 1] || enabled[enabled.length - 1])?.focus(); }
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  current = { el, onDown, onKey };
  return el;
}

export const menuOpen = () => !!current;
