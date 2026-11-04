// Всплывающая панелька у кнопки (формат кадра, фон, подгонка…).
// Открывается щелчком; на устройствах с мышью — ещё и наведением (с задержкой), на тачскрине / Steam Deck —
// только щелчком. Щелчок по кнопке «закрепляет» панель: тогда она не закрывается, когда мышь уходит.
import { h } from './util.js';

const canHover = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
let current = null; // открытая панель (одна на всё окно)

export function closePopover() { if (current) current.close(); }
export const popoverOpen = () => !!current;

/**
 * btn — кнопка; build() → содержимое панели (вызывается при каждом открытии и refresh()).
 * opts.hover — разрешить открытие наведением (по умолчанию да); opts.align — 'left' | 'center' | 'right'.
 */
export function attachPopover(btn, build, { hover = true, align = 'center', className = '' } = {}) {
  const pop = h('div', { class: `popover ${className}`.trim(), role: 'dialog' });
  let pinned = false;
  let openTimer = null; let closeTimer = null;

  const place = () => {
    const r = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    let x = align === 'left' ? r.left : align === 'right' ? r.right - pw : r.left + r.width / 2 - pw / 2;
    x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
  };
  const refresh = () => {
    if (!pop.isConnected) return;
    pop.replaceChildren(build(api));
    place();
  };
  const open = (pin) => {
    clearTimeout(closeTimer); clearTimeout(openTimer);
    if (btn.disabled) return;
    if (current && current !== api) current.close();
    pinned = pinned || pin;
    if (!pop.isConnected) {
      document.body.append(pop);
      current = api;
      btn.classList.add('open');
      refresh();
    }
  };
  const close = () => {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    pinned = false;
    if (pop.isConnected) pop.remove();
    btn.classList.remove('open');
    if (current === api) current = null;
  };
  const api = { open, close, refresh, el: pop, get isOpen() { return pop.isConnected; } };

  btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // иначе «щелчок мимо» закроет и тут же откроет
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.isConnected && pinned) close(); else open(true);
  });
  if (hover) {
    const hoverIn = () => { if (!canHover()) return; clearTimeout(closeTimer); if (!pop.isConnected) openTimer = setTimeout(() => open(false), 220); };
    const hoverOut = () => { clearTimeout(openTimer); if (!pinned && pop.isConnected) closeTimer = setTimeout(close, 280); };
    btn.addEventListener('mouseenter', hoverIn);
    btn.addEventListener('mouseleave', hoverOut);
    pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    pop.addEventListener('mouseleave', hoverOut);
  }
  // Щелчок внутри панели закрепляет её (например, открыт системный выбор цвета — мышь «ушла»)
  pop.addEventListener('pointerdown', (e) => { e.stopPropagation(); pinned = true; });
  return api;
}

// Щелчок мимо и Escape закрывают панель; размер окна — тоже
document.addEventListener('pointerdown', () => closePopover());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) { e.stopPropagation(); closePopover(); } }, true);
window.addEventListener('resize', () => closePopover());
