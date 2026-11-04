// Вкладки сверху: Видео · Аудио · Анимации. Режим — атрибут body[data-mode], раскладку меняет CSS,
// а модули режимов (аудиостойка, анимации) подписываются на событие 'mode'.
import { store } from './store.js';
import { h } from './util.js';

export const MODES = [
  { id: 'video', name: 'Видео', title: 'Монтаж' },
  { id: 'audio', name: 'Аудио', title: 'Звук: эффекты клипов и дорожек' },
  { id: 'anim', name: 'Анимации', title: 'Лёгкие анимации по пресетам' },
];
const KEY = 'ffm.mode';
let mode = 'video';
export const currentMode = () => mode;

export function setMode(id) {
  if (!MODES.some((m) => m.id === id)) id = 'video';
  if (id === mode && document.body.dataset.mode === id) return;
  mode = id;
  document.body.dataset.mode = id;
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  for (const b of document.querySelectorAll('.mode-tab')) b.classList.toggle('on', b.dataset.mode === id);
  store.emit('mode', id);
}

export function modeTabs() {
  const wrap = h('nav', { class: 'mode-tabs', role: 'tablist' }, ...MODES.map((m) => h('button', {
    class: 'mode-tab', role: 'tab', dataset: { mode: m.id }, title: m.title, onclick: () => setMode(m.id),
  }, m.name)));
  return wrap;
}

export function initModes() {
  let saved = 'video';
  try { saved = localStorage.getItem(KEY) || 'video'; } catch { /* ignore */ }
  mode = null;
  setMode(saved);
}
