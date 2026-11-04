// Мелкие помощники для интерфейса
import { t, num } from './i18n.js';
import { withKey } from './keymap.js';

export { t };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // tip: [текст, id действия] — подсказка с текущей клавишей действия, обновляется при смене клавиш
    else if (k === 'tip' && Array.isArray(v)) { el.dataset.tip = v[0]; if (v[1]) el.dataset.tipAction = v[1]; el.title = v[1] ? withKey(v[0], v[1]) : v[0]; }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// Текст ошибки: Tauri отклоняет invoke строкой (не Error), JS-код бросает Error
export const errText = (e) => String((e && e.message) || e || t('неизвестная ошибка'));
export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

// 75.5 -> "1:15.5"; with frames=false -> "1:15"
export function fmtTime(sec, { ms = true } = {}) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  let s = hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  if (ms) s += '.' + String(Math.floor((sec % 1) * 100)).padStart(2, '0');
  return s;
}

export function fmtDur(sec) {
  if (!isFinite(sec)) return '—';
  if (sec < 60) return t('{s} с', { s: num(sec, 1) });
  const m = Math.floor(sec / 60); const s = Math.round(sec % 60);
  return s ? t('{m} мин {s} с', { m, s }) : t('{m} мин', { m });
}

export function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  if (b < 1024 * 1024) return t('{n} КБ', { n: (b / 1024).toFixed(0) });
  if (b < 1024 ** 3) return t('{n} МБ', { n: num(b / 1024 / 1024, 1) });
  return t('{n} ГБ', { n: num(b / 1024 ** 3, 2) });
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function rafThrottle(fn) {
  let pending = false;
  return (...a) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...a); });
  };
}

export function snapFps(fps) {
  if (!fps) return 30;
  const std = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 144, 165, 240];
  let best = fps; let d = Infinity;
  for (const s of std) { const dd = Math.abs(s - fps); if (dd < d) { d = dd; best = s; } }
  // Записи с плавающей частотой (59.87 и т.п.) приводим к ближайшей стандартной
  return d / fps < 0.03 ? best : Math.round(fps);
}

// ---------------------------------------------------------------------------
// Уведомления
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

// Простое модальное подтверждение
export function confirmDialog(title, text, okText = 'OK', cancelText = t('Отмена'), danger = false) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'modal-overlay' },
      h('div', { class: 'modal small' },
        h('div', { class: 'modal-head' }, h('h2', {}, title)),
        h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, text)),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, cancelText),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okText))));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.body.append(overlay);
    overlay.querySelector('.btn.primary, .btn.danger').focus();
  });
}

// Модальный ввод одного значения. Возвращает строку или null (отмена).
export function promptDialog(title, label, value = '', { okText = t('Готово'), hint = '', type = 'text', validate = null } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type, value: String(value), spellcheck: 'false' });
    const err = h('p', { class: 'setup-error' });
    const close = (v) => { overlay.remove(); resolve(v); };
    const ok = () => {
      const v = input.value.trim();
      const e = validate ? validate(v) : null;
      if (e) { err.textContent = e; input.focus(); return; }
      close(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      e.stopPropagation();
    });
    const overlay = h('div', { class: 'modal-overlay' },
      h('div', { class: 'modal small' },
        h('div', { class: 'modal-head' }, h('h2', {}, title)),
        h('div', { class: 'modal-body prompt' }, h('label', { class: 'muted' }, label), input, hint ? h('p', { class: 'muted small' }, hint) : null, err),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: () => close(null) }, t('Отмена')),
          h('button', { class: 'btn primary', onclick: ok }, okText))));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

// Разбор длительности: «5», «2,5», «1:30», «0:02.5»
export function parseDuration(s) {
  const t = String(s || '').trim().replace(',', '.');
  if (!t) return NaN;
  if (t.includes(':')) {
    const parts = t.split(':').map(Number);
    if (parts.some((x) => !isFinite(x) || x < 0)) return NaN;
    return parts.reduce((acc, x) => acc * 60 + x, 0);
  }
  const v = Number(t);
  return isFinite(v) && v >= 0 ? v : NaN;
}

// ---------------------------------------------------------------------------
// Иконки (простые SVG в стиле Fluent)
// ---------------------------------------------------------------------------
const P = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/>',
  back5: '<path d="M11 7V4L6 8l5 4V9a5 5 0 1 1-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  fwd5: '<path d="M13 7V4l5 4-5 4V9a5 5 0 1 0 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  start: '<path d="M6 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18 5.5v13a.8.8 0 0 1-1.2.7L8.5 12.7a.8.8 0 0 1 0-1.4l8.3-6.5a.8.8 0 0 1 1.2.7z" fill="currentColor"/>',
  end: '<path d="M18 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 5.5v13a.8.8 0 0 0 1.2.7l8.3-6.5a.8.8 0 0 0 0-1.4L7.2 4.8A.8.8 0 0 0 6 5.5z" fill="currentColor"/>',
  undo: '<path d="M9 14L4 9l5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  redo: '<path d="M15 14l5-5-5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  split: '<circle cx="6" cy="6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="6" cy="18" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.2 7.5L20 18M8.2 16.5L20 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  minus: '<path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
  music: '<path d="M9 18V6l11-2v12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  mute: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  film: '<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4" stroke="currentColor" stroke-width="1.4"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  warning: '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v4.5M12 17v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  logo: '<rect x="2" y="2" width="20" height="20" rx="6" fill="url(#lg)"/><path d="M9.5 7.8v8.4l7-4.2z" fill="#fff"/><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b7bff"/><stop offset="1" stop-color="#5b3df5"/></linearGradient></defs>',
  export: '<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14 11v6M11 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  paste: '<rect x="5" y="5" width="14" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="9" y="3" width="6" height="4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  reverse: '<path d="M4 9h12.5a3.5 3.5 0 0 1 0 7H13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 5L4 9l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  freeze: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 3.5h6M12 9.5v6M9.4 11l5.2 3M14.6 11l-5.2 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  rename: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 8l2.5 2.5" stroke="currentColor" stroke-width="1.7"/>',
  more: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
  transition: '<path d="M4 5l8 7-8 7zM20 5l-8 7 8 7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  fade: '<path d="M3 19L10 6h4l7 13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 19h18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 8h4M14 8h4" stroke="currentColor" stroke-width="1.7"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  blade: '<path d="M4 20L15.5 8.5M14 4l6 6-3 3-6-6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><path d="M3 21l2.5-.8L3.8 18.5z" fill="currentColor"/>',
  pointer: '<path d="M6 3l12 9-5.5 1L15 19l-2.5 1.2L10 14.5 6 18z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  wmin: '<path d="M3 12h18" stroke="currentColor" stroke-width="2"/>',
  wmax: '<rect x="3.5" y="3.5" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"/>',
  wrestore: '<rect x="3.5" y="7.5" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.5 7.5V3.5h13v13h-4" fill="none" stroke="currentColor" stroke-width="2"/>',
  wclose: '<path d="M3 3l18 18M21 3L3 21" stroke="currentColor" stroke-width="2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  gapclose: '<path d="M4 6v12M20 6v12M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  fitframe: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.5 2"/><rect x="7" y="8" width="10" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 12h2M17.5 12h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  aspect: '<rect x="3" y="6" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="11" y="3" width="10" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7" opacity=".65"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.7-.8 1.7-1.6 0-1.2-1-1.4-1-2.4 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="7.5" cy="11" r="1.3" fill="currentColor"/><circle cx="10" cy="7" r="1.3" fill="currentColor"/><circle cx="14.5" cy="7" r="1.3" fill="currentColor"/>',
  speed: '<path d="M4.5 17a8 8 0 1 1 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 15l4-5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.8l1.6 2.3 2.7-.7.5 2.8 2.5 1.2-1 2.6 1 2.6-2.5 1.2-.5 2.8-2.7-.7L12 21.2l-1.6-2.3-2.7.7-.5-2.8-2.5-1.2 1-2.6-1-2.6 2.5-1.2.5-2.8 2.7.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 10h.5M9 10h.5M12 10h.5M15 10h.5M18 10h.5M6 13h.5M18 13h.5M8.5 14.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  eyeoff: '<path d="M4 4l16 16M9.9 6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3 3.6M6.3 7.6A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  up: '<path d="M6 14l6-6 6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6.5 15h5M13.5 15h4M6.5 11.5h3M11.5 11.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  transform: '<rect x="6" y="6" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.5 2"/><path d="M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z" fill="currentColor"/>',
  // 0.4.3: инструмент обрезки (ripple/roll/slip/slide), метки In/Out, паузы
  trim: '<path d="M9 4v16M15 4v16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 9l-3 3 3 3M18 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  markin: '<path d="M10 4H7v16h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 12h7M17 9l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  markout: '<path d="M14 4h3v16h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 12h7M7 9l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  silence: '<path d="M3 12h3l2-5 3 10 2-5h1M17 12h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 9.5v5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.5 1.5"/>',
};
export function icon(name, size = 20) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}
export function iconEl(name, size = 20) {
  const s = document.createElement('span');
  s.className = 'ic-wrap';
  s.innerHTML = icon(name, size);
  return s;
}
