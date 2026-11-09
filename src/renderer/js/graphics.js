// Графические клипы (0.5.0): реестр видов видеоклипов без файла — текст, фигура, таймер (и будущие виды).
// Клип такого вида: { kind, in: 0, out: длина, muted: true, [field]: данные, transform? } — без mediaId, звука и
// скорости, длина на таймлайне — out − in (in всегда 0). Остальной код спрашивает о виде реестр, а не сравнивает kind.
//
// Вид регистрируется по частям (registerGraphic сливает поля): модель — в своём модуле (textModel.js, shapes.js,
// timer.js), рисунок и экспорт — там, где рисуется (textRender.js…), интерфейс — graphicsUi.js.
//   kind        — значение clip.kind; field — поле клипа с данными (clip.text, clip.shape, clip.timer)
//   title()     — название вида («Текст», «Фигура», «Таймер»)
//   clean(patch, base) — данные в пределах: patch поверх base (или умолчаний); неизвестные поля отбрасываются
//   name(clip)  — название клипа на таймлайне (если у клипа нет своего clip.name)
//   defaultDur  — длина нового клипа, с; length(data, clip) — длина, которую задают сами данные (таймер), иначе null
//               (clip — текущий клип с out/in или заготовка без них)
//   describe(data) — данные для MCP (по умолчанию — как есть)
//   rect(clip, W, H) → { cx, cy, w, h, rot, opacity } — рамка гизмо в кадре W×H
//   draw(ctx, clip, W, H, local) — рисунок кадра W×H на холсте (local — с от начала клипа)
//   animated(clip) — рисунок зависит от local (плеер перерисовывает холст по времени)
//   exportAsset(clip, env) — файл для экспорта (exportAssets.js): { path, w, h, x?, y?, roll?, anim? } или null
//   library     — плитки «Библиотеки» (library.js): [{ id, title(), data(), thumbAt?(data) — момент миниатюры, с,
//                 thumbTransform? — трансформ клипа миниатюры, group?() — подзаголовок (подряд идущие — одна группа) }];
//   libraryTitle() — заголовок раздела библиотеки («Фигуры», «Таймеры»)
//   ui          — { badge(clip) → { text | icon, tip }, strip(clip) → { background } | элемент, inspector(ui, sel),
//                   edit → { label(), icon } } (graphicsUi.js)
// Без DOM и без импортов: модуль используется окном, экспортом и автотестами.

export const GRAPHIC_MAX = 24 * 3600;   // наибольшая длина графического клипа, с

const KINDS = new Map();
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Добавить вид или дополнить уже зарегистрированный (поля сливаются, ui — тоже) */
export function registerGraphic(kind, part) {
  if (!KIND_RE.test(String(kind))) throw new Error(`graphic kind: ${kind}`);
  const old = KINDS.get(kind) || { kind, field: kind, defaultDur: 5, library: [], ui: {} };
  const next = { ...old, ...part, kind, ui: { ...old.ui, ...((part && part.ui) || {}) } };
  if (!next.field || typeof next.field !== 'string') throw new Error(`graphic ${kind}: field`);
  KINDS.set(kind, next);
  return next;
}

/** Вид графического клипа или null (клип с файлом) */
export const graphicOf = (c) => (c && typeof c.kind === 'string' ? KINDS.get(c.kind) || null : null);
export const graphicKind = (kind) => KINDS.get(kind) || null;
export const isGraphic = (c) => !!graphicOf(c);
export const graphicKinds = () => [...KINDS.values()];
/** Поля данных всех видов (у клипа остаётся только поле своего вида) */
export const graphicFields = () => [...new Set([...KINDS.values()].map((g) => g.field))];

/** Данные клипа в пределах (clean вида) */
export function graphicData(c, patch = undefined) {
  const g = graphicOf(c);
  if (!g) return null;
  const cur = c[g.field];
  return typeof g.clean === 'function' ? (patch === undefined ? g.clean(cur) : g.clean(patch, cur)) : cur;
}

/** Длина клипа, которую задают данные (таймер: отсчёт + звонок), или null */
export function graphicLength(c) {
  const g = graphicOf(c);
  if (!g || typeof g.length !== 'function') return null;
  const v = g.length(c[g.field], c);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Версия рисунков: виды, которые грузят картинки асинхронно (таймер — слои из SVG), зовут bumpGraphics, когда
// картинка готова; плеер и «Библиотека» перерисовываются (подписка onGraphicsChange), версия входит в подпись холста.
let VERSION = 0;
let pending = false;
const LISTENERS = new Set();
export const graphicsVersion = () => VERSION;
export function onGraphicsChange(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }
export function bumpGraphics() {
  VERSION++;
  if (pending) return;
  pending = true;
  const run = () => { pending = false; for (const fn of LISTENERS) { try { fn(VERSION); } catch (e) { console.warn('graphics listener', e); } } };
  if (typeof setTimeout === 'function') setTimeout(run, 16); else run();
}

/** Все плитки «Библиотеки»: [{ id, kind, title(), icon, data() }] */
export function libraryItems() {
  const out = [];
  for (const g of KINDS.values()) for (const it of g.library || []) out.push({ ...it, kind: g.kind });
  return out;
}
