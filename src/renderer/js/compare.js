// Шторка «ДО / ПОСЛЕ» в плеере (план fx-restore, этап 2). Эффекты, которые CSS не показывает честно
// (описание с preview: 'frame' — шумодав, виньетка), видно только в экспорте; кнопка «Сравнить» в инспекторе
// открывает здесь два кадра FFmpeg одного момента файла клипа: ДО — без эффектов, ПОСЛЕ — вся цепочка эффектов
// (Rust compare.rs, запрос — effects.js compareRequest). Кадры лежат поверх плеера в рамке клипа (contentRect —
// та же математика, что у гизмо: сдвиг, масштаб, поворот, «вписать/заполнить/растянуть»), граница разреза тянется
// мышью, разрез вертикальный или горизонтальный.
//   • Перемотка внутри клипа / смена параметров → пересчёт через 0,3 с (старый запрос отменяется в Rust);
//     воспроизведение, курсор вне клипа, удаление клипа, кадрирование, другой режим, Esc, «×» → шторка закрывается.
//   • Ограничения: показывается только этот клип — дорожки над ним шторка закрывает; прозрачность клипа,
//     обводка, затухания и переходы в кадрах не учитываются (кадр — сам клип с эффектами, без композиции).
import { store } from './store.js';
import { h, t, toast, errText, icon } from './util.js';
import { contentRect, contentAspect } from './transform.js';
import { compareRequest } from './effects.js';
import { getPref, setPref } from './prefs.js';

const DELAY = 300;
const CACHE_MAX = 8;
const DIR_PREF = 'ui.compareDir';

let P = null;        // Preview
let S = null;        // открытая шторка: { clipId, dir, pos, sig, seq, timer, busy, shown }
let seqN = 0;
const cache = new Map(); // sig → { before, after } (data: URL)
let ui = null;

function build(stage) {
  const imgA = h('img', { class: 'cmp-img before', alt: '', draggable: 'false' });
  const imgB = h('img', { class: 'cmp-img after', alt: '', draggable: 'false' });
  const tagA = h('div', { class: 'cmp-tag before' }, t('ДО'));
  const tagB = h('div', { class: 'cmp-tag after' }, t('ПОСЛЕ'));
  const line = h('div', { class: 'cmp-line', title: t('Тяните, чтобы сдвинуть границу') }, h('div', { class: 'cmp-knob' }));
  const box = h('div', { class: 'cmp-box' }, imgA, imgB, tagA, tagB, line);
  const busy = h('span', { class: 'cmp-busy' }, t('Считаю кадр…'));
  const dirV = h('button', { class: 'btn tiny', dataset: { dir: 'v' }, title: t('Вертикальный разрез: ДО слева, ПОСЛЕ справа'), onclick: () => setDir('v') }, t('Вертикально'));
  const dirH = h('button', { class: 'btn tiny', dataset: { dir: 'h' }, title: t('Горизонтальный разрез: ДО сверху, ПОСЛЕ снизу'), onclick: () => setDir('h') }, t('Горизонтально'));
  const close = h('button', { class: 'btn tiny cmp-close', title: t('Закрыть сравнение (Esc)'), html: icon('close', 14), onclick: () => closeCompare() });
  const bar = h('div', { class: 'cmp-bar' }, h('b', {}, t('Сравнение')), busy, dirV, dirH, close);
  const layer = h('div', { class: 'cmp-layer' }, box, bar);
  // Клики по шторке не должны выделять клип и начинать перетаскивание гизмо (gizmo.js слушает stage)
  for (const el of [line, bar]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  line.addEventListener('pointerdown', startDrag);
  stage.append(layer);
  return { layer, box, imgA, imgB, line, busy, bar, dirV, dirH, tagA, tagB };
}

// Где клип в плеере (CSS-пиксели «экрана»)
function rectOf(clip) {
  return contentRect(clip, store.media(clip.mediaId), P.stage.clientWidth, P.stage.clientHeight);
}

// Ширина кадра от FFmpeg: сколько пикселей картинки видно на экране (у «заполнить» картинка шире рамки), ≤ 1920
function wantWidth(clip, r) {
  const ar = contentAspect(clip, store.media(clip.mediaId));
  const shown = clip.fit === 'cover' ? Math.max(r.w, r.h * ar) : r.w;
  const px = shown * (window.devicePixelRatio || 1);
  return Math.min(1920, Math.max(64, Math.ceil(px / 64) * 64));
}

function layout() {
  if (!S) return;
  const f = store.findClip(S.clipId);
  if (!f) return;
  const r = rectOf(f.clip);
  Object.assign(ui.box.style, {
    left: `${r.cx - r.w / 2}px`, top: `${r.cy - r.h / 2}px`, width: `${r.w}px`, height: `${r.h}px`,
    transform: r.rot ? `rotate(${r.rot}deg)` : '',
  });
  const fit = f.clip.fit === 'cover' ? 'cover' : 'fill';
  ui.imgA.style.objectFit = fit; ui.imgB.style.objectFit = fit;
  const p = `${(S.pos * 100).toFixed(3)}%`;
  ui.layer.dataset.dir = S.dir;
  ui.imgB.style.clipPath = S.dir === 'v' ? `inset(0 0 0 ${p})` : `inset(${p} 0 0 0)`;
  ui.imgA.style.clipPath = S.dir === 'v' ? `inset(0 calc(100% - ${p}) 0 0)` : `inset(0 0 calc(100% - ${p}) 0)`;
  Object.assign(ui.line.style, S.dir === 'v' ? { left: p, top: '0', width: '', height: '100%' } : { top: p, left: '0', height: '', width: '100%' });
  ui.dirV.classList.toggle('on', S.dir === 'v');
  ui.dirH.classList.toggle('on', S.dir === 'h');
  ui.busy.style.visibility = S.busy ? 'visible' : 'hidden';
  ui.box.classList.toggle('empty', !S.shown);
  ui.box.classList.toggle('stale', !!S.busy && !!S.shown);
}

function setDir(dir) {
  if (!S || (dir !== 'v' && dir !== 'h')) return;
  S.dir = dir;
  setPref(DIR_PREF, dir);
  layout();
}

// Граница разреза мышью: точка экрана → координаты рамки клипа (с учётом поворота)
function posAt(ev) {
  const f = S && store.findClip(S.clipId);
  if (!f) return null;
  const r = rectOf(f.clip);
  const sr = P.stage.getBoundingClientRect();
  const dx = ev.clientX - sr.left - r.cx; const dy = ev.clientY - sr.top - r.cy;
  const a = (-r.rot * Math.PI) / 180;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  const v = S.dir === 'v' ? (lx + r.w / 2) / r.w : (ly + r.h / 2) / r.h;
  return Math.max(0, Math.min(1, v));
}
function startDrag(e) {
  if (e.button !== 0 || !S) return;
  e.preventDefault();
  const move = (ev) => { const v = posAt(ev); if (v !== null && S) { S.pos = v; layout(); } };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ui.layer.classList.remove('dragging'); };
  ui.layer.classList.add('dragging');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Запрос для текущего состояния (null — показывать нечего: клип пропал или курсор вне клипа)
function request() {
  const f = store.findClip(S.clipId);
  if (!f || f.kind !== 'video') return null;
  const m = store.media(f.clip.mediaId);
  return compareRequest(f.clip, m, store.time, wantWidth(f.clip, rectOf(f.clip)));
}

function show(pair) {
  ui.imgA.src = pair.before;
  ui.imgB.src = pair.after;
  S.shown = true;
}

// Пересчитать кадры, если что-то поменялось (now — без задержки)
function refresh(now = false) {
  if (!S) return;
  const req = request();
  if (!req) { closeCompare(); return; }
  const sig = JSON.stringify(req);
  if (sig === S.sig) return;
  S.sig = sig;
  clearTimeout(S.timer);
  const hit = cache.get(sig);
  if (hit) { S.busy = false; show(hit); layout(); return; }
  S.busy = true;
  layout();
  S.timer = setTimeout(() => run(req, sig), now ? 0 : DELAY);
}

async function run(req, sig) {
  if (!S || S.sig !== sig) return;
  const my = ++seqN; S.seq = my;
  let r;
  try {
    r = await window.api.compareFrames(req);
  } catch (e) {
    if (!S || S.seq !== my) return;
    S.busy = false; layout();
    toast(t('Не удалось сделать кадры для сравнения: {err}', { err: errText(e) }), 'error', 7000);
    return;
  }
  if (!S || S.seq !== my || !r || r.cancelled) return;
  const pair = { before: `data:image/jpeg;base64,${r.before}`, after: `data:image/jpeg;base64,${r.after}` };
  cache.set(sig, pair);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  if (S.sig !== sig) return;
  S.busy = false;
  show(pair);
  layout();
  store.emit('compare', 'ready');
}

/** Открыть шторку для видеоклипа (плеер встаёт на паузу) */
export function openCompare(clipId) {
  if (!P) return false;
  const f = store.findClip(clipId);
  if (!f || f.kind !== 'video' || P.cropEdit) return false;
  if (P.playing) P.pause();
  // Уже открыта для этого клипа — только проверить, не устарели ли кадры
  if (S && S.clipId === clipId) { refresh(true); return true; }
  if (S) closeCompare();
  const dir = getPref(DIR_PREF, 'v') === 'h' ? 'h' : 'v';
  S = { clipId, dir, pos: 0.5, sig: '', seq: 0, timer: 0, busy: false, shown: false };
  ui.layer.classList.add('on');
  const req = request();
  if (!req) { closeCompare(); toast(t('Поставьте курсор на клип, чтобы сравнить кадры'), 'info'); return false; }
  layout();
  refresh(true);
  store.emit('compare', 'open');
  return true;
}

/** Закрыть шторку (запрос в Rust отменяется) */
export function closeCompare() {
  if (!S) return;
  clearTimeout(S.timer);
  const busy = S.busy;
  S = null;
  if (busy) window.api.compareCancel();
  ui.layer.classList.remove('on');
  ui.imgA.removeAttribute('src'); ui.imgB.removeAttribute('src');
  store.emit('compare', 'close');
}

/** Состояние для автотестов и инспектора */
export const compareState = () => (S ? { clipId: S.clipId, dir: S.dir, pos: S.pos, busy: S.busy, shown: S.shown } : null);

/** Подключение к плееру (preview.js) */
export function initCompare(preview) {
  P = preview;
  ui = build(preview.stage);
  store.on('time', () => { if (S) { if (P.playing) closeCompare(); else refresh(); } });
  store.on('project', () => { if (S) { layout(); refresh(); } });
  store.on('media', () => { if (S) refresh(); });
  store.on('playstate', (on) => { if (on) closeCompare(); });
  for (const ev of ['mode', 'crop-mode-changed']) store.on(ev, () => closeCompare());
  new ResizeObserver(() => { if (S) { layout(); refresh(); } }).observe(preview.stage);
  // Esc — раньше остальных клавиш (снятие выделения и т. п.), только когда шторка открыта
  window.addEventListener('keydown', (e) => {
    if (!S || e.key !== 'Escape' || e.defaultPrevented) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    closeCompare();
  }, true);
  return { open: openCompare, close: closeCompare, state: compareState, ui: () => ui };
}
