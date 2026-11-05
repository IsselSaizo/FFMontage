// Индикаторы уровня (0.5.0): дорожки (L / R в заголовке дорожки) и общий микс по каналам (под плеером).
// Плеер (preview.js) каждый кадр воспроизведения отдаёт пики (readMeters) в updateMeters; элементы находятся по
// data-meter="<id дорожки>" | "master" — таймлайн перерисовывается когда угодно, индикаторы подхватываются сами.
// Шкала: −60…0 dBFS; спад 24 дБ/с; выше −1 dBFS — красный (перегруз, в экспорте сработает лимитер).
import { h } from './util.js';
import { t } from './i18n.js';

const FLOOR = -60;
const FALL = 24;        // дБ в секунду
const HOLD_MS = 1200;   // держать отметку перегруза
const state = new Map(); // ключ (id:канал) -> { db, clipAt }
let last = 0;

const toDb = (p) => (p > 1e-6 ? 20 * Math.log10(p) : FLOOR);
const frac = (db) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR));

function setBar(el, key, peak, now, dt) {
  const s = state.get(key) || { db: FLOOR, clipAt: 0 };
  const db = toDb(peak);
  s.db = db >= s.db ? db : Math.max(db, s.db - FALL * dt);
  if (db > -1) s.clipAt = now;
  state.set(key, s);
  el.style.setProperty('--lvl', frac(s.db).toFixed(3));
  el.classList.toggle('clip', now - s.clipAt < HOLD_MS);
}

/** Общий индикатор каналов (под плеером): столбики создаются по числу каналов при первом обновлении */
export function masterMeterEl() {
  return h('div', { class: 'meter master-meter', dataset: { meter: 'master' }, title: t('Уровень общего микса по каналам (при воспроизведении)') });
}
/** Индикатор дорожки: два столбика L / R */
export function trackMeterEl(trackId) {
  return h('div', { class: 'meter th-meter', dataset: { meter: trackId }, title: t('Уровень дорожки L / R (при воспроизведении)') }, h('i'), h('i'));
}

/** levels: { tracks: { id: [L, R] }, master: [...], labels: [...] } | null */
export function updateMeters(levels) {
  if (!levels || typeof document === 'undefined') return;
  const now = performance.now();
  const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  for (const el of document.querySelectorAll('[data-meter]')) {
    const id = el.dataset.meter;
    const vals = id === 'master' ? levels.master : levels.tracks[id];
    if (!vals) continue;
    if (id === 'master' && el.children.length !== vals.length) {
      el.innerHTML = '';
      for (let k = 0; k < vals.length; k++) el.append(h('i', { title: (levels.labels || [])[k] || String(k + 1) }));
      el.classList.toggle('multi', vals.length > 2);
    }
    [...el.children].forEach((bar, k) => setBar(bar, `${id}:${k}`, vals[k] || 0, now, dt));
  }
}

/** Остановка: все индикаторы — в ноль */
export function resetMeters() {
  state.clear();
  last = 0;
  if (typeof document === 'undefined') return;
  for (const bar of document.querySelectorAll('[data-meter] > i')) { bar.style.setProperty('--lvl', '0'); bar.classList.remove('clip'); }
}
