// «Библиотека» (вкладка левой панели рядом с «Ваши медиа»): готовые графические клипы — фигуры, таймеры и другие
// виды из реестра graphics.js (поле library вида). Щелчок — клип в месте курсора на свободной верхней видеодорожке;
// перетаскивание — на дорожку под мышью (как файл из «Ваши медиа»). Миниатюра — тот же рисунок, что в плеере.
import { store } from './store.js';
import { h, t, toast } from './util.js';
import { graphicKinds, onGraphicsChange } from './graphicKinds.js';
import { dragPoint } from './uidoc.js';

const TW = 160; const TH = 90;

// Миниатюры на экране: перерисовываются, когда виды догрузили картинки (слои таймера — onGraphicsChange)
let THUMBS = [];
onGraphicsChange(() => { THUMBS = THUMBS.filter((x) => x.cv.isConnected); for (const x of THUMBS) paintThumb(x); });

function paintThumb({ cv, g, item, data }) {
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const grad = ctx.createLinearGradient(0, 0, TW * 2, TH * 2);
  grad.addColorStop(0, '#3a4660'); grad.addColorStop(1, '#1b2030');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, TW * 2, TH * 2);
  const clip = { id: 'thumb', kind: g.kind, in: 0, out: 5, start: 0, [g.field]: data, ...(item.thumbTransform ? { transform: item.thumbTransform } : {}) };
  try { if (g.draw) g.draw(ctx, clip, TW * 2, TH * 2, item.thumbAt ? item.thumbAt(data) : 0); } catch (e) { console.warn('library thumb', e); }
}

function thumb(g, item, data) {
  const cv = h('canvas', { class: 'lib-thumb', width: String(TW * 2), height: String(TH * 2) });
  const x = { cv, g, item, data };
  paintThumb(x);
  THUMBS.push(x);
  return cv;
}

/** Добавить плитку библиотеки в месте курсора (или в at / lane). null — дорожки заняты или под замком. */
export function addLibraryItem(item, opts = {}) {
  const c = store.addGraphicClip(item.kind, item.data(), opts);
  if (!c) { toast(t('Нет свободной дорожки — клип не добавлен'), 'error'); return null; }
  store.emit('focus-inspector', item.kind);
  return c;
}

// Перетаскивание плитки на таймлайн (указателем, как карточка медиа: HTML5 drag&drop в Tauri занят файлами)
function startDrag(e, item, title) {
  if (e.button !== 0) return;
  const x0 = e.clientX; const y0 = e.clientY;
  const doc = e.currentTarget.ownerDocument;
  let ghost = null;
  const tl = () => window.__ffm && window.__ffm.timeline;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      ghost = h('div', { class: 'media-ghost' }, h('span', {}, title));
      doc.body.append(ghost);
      doc.body.classList.add('dragging-media');
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    if (!tl()) return;
    const p = dragPoint(ev, tl().scroll.ownerDocument);
    if (p) tl().dragHover(p[0], p[1], null); else tl().dragLeave();
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove();
    doc.body.classList.remove('dragging-media');
    // Щелчок после перетаскивания не должен добавить второй клип
    dragged = true; setTimeout(() => { dragged = false; }, 0);
    if (!tl()) return;
    const p = ev.type === 'pointerup' ? dragPoint(ev, tl().scroll.ownerDocument) : null;
    if (!p) { tl().dragLeave(); return; }
    const c = tl().dropGraphic(p[0], p[1], item.kind, item.data());
    if (c) store.emit('focus-inspector', item.kind);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
let dragged = false;

export function renderLibrary(root) {
  if (!root || root.hidden) return;
  root.innerHTML = '';
  THUMBS = [];
  root.append(h('p', { class: 'muted small' }, t('Щелчок — в месте курсора на верхней видеодорожке, или перетащите на нужную дорожку. Цвета, размер и время — в «Свойствах».')));
  for (const g of graphicKinds()) {
    const items = (g.library || []);
    if (!items.length) continue;
    const sec = h('div', { class: 'insp-section', dataset: { section: `lib-${g.kind}` } },
      h('h3', {}, g.libraryTitle ? g.libraryTitle() : (g.title ? g.title() : g.kind)));
    // Плитки с group() — подзаголовками (стили таймера), каждая группа — своя сетка
    let grid = null; let group = null;
    for (const it of items) {
      const gname = it.group ? it.group() : null;
      if (!grid || gname !== group) {
        group = gname;
        if (gname) sec.append(h('div', { class: 'lib-group' }, gname));
        grid = h('div', { class: 'lib-grid' });
        sec.append(grid);
      }
      const item = { ...it, kind: g.kind };
      const title = it.title ? it.title() : g.kind;
      const tile = h('button', {
        class: 'lib-tile', dataset: { lib: it.id }, title: gname ? `${gname} · ${title}` : title,
        onclick: () => { if (!dragged) addLibraryItem(item); },
      }, thumb(g, item, it.data()), h('span', {}, title));
      tile.addEventListener('pointerdown', (e) => startDrag(e, item, title));
      grid.append(tile);
    }
    root.append(sec);
  }
}

/** Плитка библиотеки по id (MCP, автотесты) */
export function libraryItem(id) {
  for (const g of graphicKinds()) {
    const it = (g.library || []).find((x) => x.id === id);
    if (it) return { ...it, kind: g.kind };
  }
  return null;
}
