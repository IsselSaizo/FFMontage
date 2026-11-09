// Документ, в котором сейчас работает пользователь (0.5.0): главное окно или отдельное окно панели (popout.js).
// Меню, всплывающие панели, диалоги и уведомления открываются там, где был последний щелчок или нажатие клавиши.
// Отдельные окна — window.open('about:blank') того же источника: тот же JS, панели переносятся туда как есть.
const docs = new Set();   // документы отдельных окон
let last = null;

const alive = (d) => !!d && !!d.defaultView && !d.defaultView.closed;

/** Документ последнего действия пользователя (по умолчанию — главный) */
export function uiDoc() {
  return alive(last) ? last : document;
}
export function setUiDoc(d) { last = d; }

export function addPopDoc(d) { docs.add(d); }
export function removePopDoc(d) { docs.delete(d); if (last === d) last = null; }
export const popDocs = () => [...docs].filter(alive);

/** Поиск по селектору в отдельных окнах (если в главном документе элемента нет — панель вынесена) */
export function popQuery(sel) {
  for (const d of popDocs()) {
    const el = d.querySelector(sel);
    if (el) return el;
  }
  return null;
}
