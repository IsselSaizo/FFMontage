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

// --- Координаты между окнами ---
// Перетаскивание, начатое в одном окне, продолжается в нём же (окно держит мышь), даже если курсор над другим окном:
// clientX/Y тогда — относительно окна, где нажали. Переводим через экранные координаты (CSS-пиксели; на мониторах
// с разным масштабом — приблизительно). У окон без рамки (главное) клиентская область = окно.
function clientOrigin(w) {
  const bx = Math.max(0, (w.outerWidth - w.innerWidth) / 2);
  const by = Math.max(0, w.outerHeight - w.innerHeight - bx);
  return { x: w.screenX + bx, y: w.screenY + by };
}
/** Точка (x, y) окна from → в координаты окна to */
export function mapPoint(x, y, from, to) {
  if (!from || !to || from === to) return [x, y];
  try {
    const a = clientOrigin(from); const b = clientOrigin(to);
    return [x + a.x - b.x, y + a.y - b.y];
  } catch { return [x, y]; }
}

/**
 * Точка перетаскивания для цели в документе doc (таймлайн): ev — pointermove/up у главного окна, в т.ч. пересланное
 * из окна панели (popout.js ставит ev.ffmWin — окно, где нажали; clientX/Y — его координаты).
 * [x, y] — в координатах главного окна; null — курсор над окном-источником, а цель в другом окне (отпустили «у себя»).
 */
export function dragPoint(ev, doc = document) {
  const src = ev.ffmWin || window;
  const target = (doc && doc.defaultView) || window;
  if (src !== window && src !== target) {
    const inside = ev.clientX >= 0 && ev.clientY >= 0 && ev.clientX < src.innerWidth && ev.clientY < src.innerHeight;
    if (inside) return null;
  }
  return mapPoint(ev.clientX, ev.clientY, src, window);
}

/** Поиск по селектору в отдельных окнах (если в главном документе элемента нет — панель вынесена) */
export function popQuery(sel) {
  for (const d of popDocs()) {
    const el = d.querySelector(sel);
    if (el) return el;
  }
  return null;
}
