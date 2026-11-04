// Операции «Режима нарезания 2.0» (0.4.3) над моделью проекта — без окна и без store (проверяются в Node: tests/edit-test.js).
// Все функции меняют проект p на месте; после них store вызывает fixup (сортировка, связи, переходы).
//
// «Строки» таймлайна (rows): видеодорожки, аудиодорожки и дорожки субтитров — у всех есть locked и элементы со start.
// Ripple (сдвиг) идёт по всем незакрытым замком строкам (B-5). Строка, где сдвинуть нельзя — элемент до точки правки
// перекрыл бы сдвинутые (например, длинная музыка лежит поперёк), — остаётся на месте и попадает в skipped.
// Связанный звук всегда следует за своим видео (syncLinks в fixup), поэтому отдельно его не двигаем.
//
// Время — секунды таймлайна. mediaDur(c) — длина файла клипа (текст — TEXT_MAX).
import { vlanes, carve, splitLink, ADJ, MIN_CLIP, MIN_CUE } from './store.js';
import { speedOf, tlLen, clipEnd, srcAt, tlAt } from './clipTime.js';
import { isText, TEXT_MAX } from './textModel.js';
import { uid } from './util.js';

const end = clipEnd;

/** Привязка ко кадрам: время на ближайший кадр (fps — частота проекта) */
export const snapFrame = (t, fps) => (fps > 0 ? Math.round(t * fps) / fps : t);
/** Сдвиг на целое число кадров */
export const snapDelta = snapFrame;

/** Все строки таймлайна: { kind: 'video'|'audio'|'sub', id, locked, items } (items — чтение и запись) */
export function rows(p) {
  const out = [];
  for (const l of vlanes(p)) out.push({ kind: 'video', id: l.id, locked: l.locked, get items() { return l.clips; }, set items(v) { l.clips = v; } });
  for (const tr of p.audioTracks || []) out.push({ kind: 'audio', id: tr.id, locked: !!tr.locked, get items() { return tr.clips; }, set items(v) { tr.clips = v; } });
  for (const s of p.subtitleTracks || []) out.push({ kind: 'sub', id: s.id, locked: !!s.locked, get items() { return s.cues; }, set items(v) { s.cues = v; } });
  return out;
}
const itemEnd = (x, kind) => (kind === 'sub' ? x.end : end(x));

/** Строка и элемент по id клипа */
export function rowOf(p, id) {
  for (const r of rows(p)) { const x = r.items.find((c) => c.id === id); if (x) return { row: r, item: x }; }
  return null;
}

/** Клип и связанные с ним (видео + его звук): [{ row, clip }] */
export function groupOf(p, id) {
  const f = rowOf(p, id);
  if (!f || f.row.kind === 'sub') return [];
  const out = [{ row: f.row, clip: f.item }];
  const L = f.item.link;
  if (L) for (const r of rows(p)) if (r.kind !== 'sub') for (const c of r.items) if (c !== f.item && c.link === L) out.push({ row: r, clip: c });
  return out;
}

/** Связи видеоклипов на дорожках с замком: их звук тоже нельзя трогать */
function lockedLinks(p) {
  const s = new Set();
  for (const l of vlanes(p)) if (l.locked) for (const c of l.clips) if (c.link) s.add(c.link);
  return s;
}

/**
 * Сдвиг всего, что начинается не раньше at, на delta (с) по всем незакрытым строкам.
 * Отрицательный сдвиг строка принимает, только если ничего не наедет на элементы до at; иначе строка пропускается.
 * exclude — id, которые не двигать. → { skipped: [id строк] }
 */
export function rippleShift(p, at, delta, { exclude = null } = {}) {
  const skipped = [];
  if (Math.abs(delta) < 1e-9) return { skipped };
  const locked = lockedLinks(p);
  for (const r of rows(p)) {
    if (r.locked) continue;
    const moving = (x) => x.start >= at - ADJ && !(exclude && exclude.has(x.id)) && !(r.kind === 'audio' && x.link && locked.has(x.link));
    const after = r.items.filter(moving);
    if (!after.length) continue;
    if (delta < 0) {
      const s1 = Math.min(...after.map((x) => x.start));
      // Связанный звук двигается вместе с видео — препятствием считаем только то, что остаётся на месте
      const prevEnd = r.items.filter((x) => !moving(x)).reduce((e, x) => (x.start < s1 + ADJ ? Math.max(e, itemEnd(x, r.kind)) : e), 0);
      if (r.kind !== 'sub' && s1 + delta < prevEnd - ADJ) { skipped.push(r.id); continue; }
      if (s1 + delta < -ADJ) { skipped.push(r.id); continue; }
    }
    for (const x of after) {
      if (r.kind === 'sub') { const d = x.end - x.start; x.start = Math.max(0, x.start + delta); x.end = x.start + d; } else x.start = Math.max(0, x.start + delta);
    }
  }
  return { skipped };
}

/** Освободить [a, b) в репликах субтитров (как carve у клипов) */
export function carveCues(cues, a, b) {
  const out = [];
  for (const q of cues) {
    if (q.end <= a + ADJ || q.start >= b - ADJ) { out.push(q); continue; }
    if (q.start < a - ADJ && a - q.start >= MIN_CUE) out.push({ ...q, end: a });
    if (q.end > b + ADJ && q.end - b >= MIN_CUE) out.push({ ...q, id: q.start < a - ADJ ? uid('cue') : q.id, start: b });
  }
  return out;
}

/**
 * Lift (поднять): убрать всё в [a, b) на незакрытых строках, оставив пустоту.
 * Extract (извлечь) — то же со сдвигом следующего влево. → { skipped }
 */
export function liftRange(p, a, b) {
  if (!(b - a > ADJ)) return { removed: 0 };
  const locked = lockedLinks(p);
  let removed = 0; // сколько строк задето
  for (const r of rows(p)) {
    if (r.locked) continue;
    const hit = r.items.some((x) => x.start < b - ADJ && itemEnd(x, r.kind) > a + ADJ);
    if (!hit) continue;
    if (r.kind === 'sub') r.items = carveCues(r.items, a, b);
    else r.items = carve(r.items, a, b, (c) => r.kind === 'audio' && !!c.link && locked.has(c.link));
    removed++;
  }
  return { removed };
}
export function extractRange(p, a, b) {
  if (!(b - a > ADJ)) return { removed: 0, skipped: [] };
  const { removed } = liftRange(p, a, b);
  return { removed, ...rippleShift(p, b, -(b - a)) };
}

/** Вырезать [a, b) только у клипа id и связанных с ним (по их строкам) — без сдвига */
function carveGroup(p, id, a, b) {
  const g = groupOf(p, id);
  if (!g.length) return false;
  const ids = new Set(g.map((x) => x.clip.id));
  const touched = new Set(g.map((x) => x.row));
  for (const r of touched) r.items = carve(r.items, a, b, (c) => !ids.has(c.id));
  return true;
}

/**
 * Q / W: обрезать начало (side 'start') или конец ('end') клипа id до момента t.
 * ripple — сдвинуть следующее на освободившееся место (Q/W), иначе остаётся пустота. → { removed, skipped }
 */
export function trimToTime(p, id, side, t, { ripple = true } = {}) {
  const f = rowOf(p, id);
  if (!f || f.row.kind === 'sub') return null;
  const c = f.item;
  const s = c.start; const e = end(c);
  if (!(t > s + MIN_CLIP - 1e-6 && t < e - MIN_CLIP + 1e-6)) return null;
  const [a, b] = side === 'start' ? [s, t] : [t, e];
  carveGroup(p, id, a, b);
  if (!ripple) return { removed: b - a, skipped: [] };
  return { removed: b - a, ...rippleShift(p, b, -(b - a)) };
}

/** Удалить у клипа id (и его связанных) промежутки ranges [[a, b], …] (время таймлайна) со сдвигом. → { removed, count, skipped } */
export function removeRanges(p, id, ranges) {
  const f = rowOf(p, id);
  if (!f) return { removed: 0, count: 0, skipped: [] };
  const list = [...ranges].filter(([a, b]) => b - a > ADJ).sort((x, y) => y[0] - x[0]); // справа налево: левая часть клипа сохраняет id
  let removed = 0; const skipped = new Set();
  for (const [a, b] of list) {
    const cur = rowOf(p, id);
    if (!cur) break;
    const c = cur.item;
    const lo = Math.max(a, c.start); const hi = Math.min(b, end(c));
    if (hi - lo < ADJ) continue;
    carveGroup(p, id, lo, hi);
    const r = rippleShift(p, hi, -(hi - lo));
    for (const x of r.skipped) skipped.add(x);
    removed += hi - lo;
  }
  return { removed, count: list.length, skipped: [...skipped] };
}

// ---------------------------------------------------------------------------
// Инструменты обрезки: ripple, roll, slip, slide. Каждая функция получает исходный проект (окно восстанавливает его
// из снимка на каждом шаге перетаскивания) и полный сдвиг d (с таймлайна), сама ограничивает его и возвращает итоговый.
// ---------------------------------------------------------------------------

/** Длина файла клипа (текст — без файла) */
export const mediaDurOf = (p, c) => (isText(c) ? TEXT_MAX : ((p.media && p.media[c.mediaId]) || {}).duration || c.out);

/** Соседи клипа на его строке: { prev, next } (adjacent — стоят впритык) */
export function neighbours(p, id) {
  const f = rowOf(p, id);
  if (!f) return null;
  const list = [...f.row.items].sort((x, y) => x.start - y.start);
  const i = list.indexOf(f.item);
  const prev = i > 0 ? list[i - 1] : null; const next = i < list.length - 1 ? list[i + 1] : null;
  return {
    row: f.row, clip: f.item, prev, next,
    prevAdj: !!prev && Math.abs(end(prev) - f.item.start) <= ADJ,
    nextAdj: !!next && Math.abs(next.start - end(f.item)) <= ADJ,
  };
}

// Партнёры (связанные клипы на других строках), кроме самого клипа
const partnersOf = (p, c) => groupOf(p, c.id).slice(1).map((x) => x.clip);

/** Сдвиг конца клипа на d (с таймлайна) с ограничениями файла и MIN_CLIP — сам клип и партнёры (in/out) */
function moveOut(p, c, d) {
  const sp = speedOf(c);
  c.out = Math.max(c.in + MIN_CLIP * sp, Math.min(mediaDurOf(p, c), c.out + d * sp));
  for (const x of partnersOf(p, c)) { const s2 = speedOf(x); x.out = Math.max(x.in + MIN_CLIP * s2, Math.min(mediaDurOf(p, x), x.out + d * s2)); }
}
function moveIn(p, c, d) {
  const sp = speedOf(c);
  c.in = Math.min(c.out - MIN_CLIP * sp, Math.max(isText(c) ? -Infinity : 0, c.in + d * sp));
  for (const x of partnersOf(p, c)) { const s2 = speedOf(x); x.in = Math.min(x.out - MIN_CLIP * s2, Math.max(0, x.in + d * s2)); }
}

/**
 * Ripple trim: край side ('l' | 'r') клипа id сдвигается на d, всё правее клипа едет следом (пустоты не появляются).
 * Левый край: начало клипа на месте, меняется in (d > 0 — укоротить). Правый: меняется out (d > 0 — удлинить).
 * → итоговый d
 */
export function rippleTrim(p, id, side, d, { linked = true } = {}) {
  const f = rowOf(p, id);
  if (!f || f.row.kind === 'sub') return 0;
  const c = f.item; const sp = speedOf(c);
  const oldEnd = end(c);
  const mdur = mediaDurOf(p, c);
  // Ограничения: длина ≥ MIN_CLIP, кадры есть в файле
  if (side === 'l') {
    const lo = isText(c) ? -(TEXT_MAX - tlLen(c)) : -c.in / sp; // удлинить влево — пока есть кадры до in
    d = Math.max(lo, Math.min(tlLen(c) - MIN_CLIP, d));
  } else {
    d = Math.min((mdur - c.out) / sp, Math.max(-(tlLen(c) - MIN_CLIP), d));
  }
  // Укорачивание: на строках группы место освобождает сам клип; строка, где сдвинуть нельзя (поперёк лежит
  // другой клип), просто не поедет — rippleShift её пропустит
  if (side === 'l') {
    if (linked) moveIn(p, c, d); else c.in = Math.min(c.out - MIN_CLIP * sp, Math.max(isText(c) ? -Infinity : 0, c.in + d * sp));
  } else if (linked) moveOut(p, c, d); else c.out = Math.max(c.in + MIN_CLIP * sp, Math.min(mdur, c.out + d * sp));
  const newEnd = c.start + (c.out - c.in) / sp;
  const shift = newEnd - oldEnd;
  if (Math.abs(shift) > 1e-9) rippleShift(p, oldEnd, shift, { exclude: new Set([c.id, ...(linked ? partnersOf(p, c).map((x) => x.id) : [])]) });
  return d;
}

/**
 * Roll: стык между клипом id (слева) и следующим впритык сдвигается на d — левый удлиняется, правый укорачивается
 * (и наоборот), общая длина и всё остальное не меняются. → итоговый d (0 — стыка нет)
 */
export function rollEdit(p, id, d) {
  const n = neighbours(p, id);
  if (!n || !n.next || !n.nextAdj || n.row.kind === 'sub') return 0;
  const a = n.clip; const b = n.next;
  const spA = speedOf(a); const spB = speedOf(b);
  const hi = Math.min((mediaDurOf(p, a) - a.out) / spA, tlLen(b) - MIN_CLIP);
  const lo = Math.max(-(tlLen(a) - MIN_CLIP), isText(b) ? -Infinity : -b.in / spB, isText(b) ? -(TEXT_MAX - tlLen(b)) : -Infinity);
  d = Math.max(lo, Math.min(hi, d));
  if (Math.abs(d) < 1e-9) return 0;
  moveOut(p, a, d);
  b.start += d;
  moveIn(p, b, d);
  return d;
}

/** Slip: содержимое клипа id сдвигается внутри него на d (с файла в масштабе таймлайна), место и длина те же. → итоговый d */
export function slipClip(p, id, d) {
  const f = rowOf(p, id);
  if (!f || f.row.kind === 'sub' || isText(f.item)) return 0;
  const c = f.item; const sp = speedOf(c);
  // d > 0 — показать более поздние кадры (in и out вперёд)
  d = Math.max(-c.in / sp, Math.min((mediaDurOf(p, c) - c.out) / sp, d));
  if (Math.abs(d) < 1e-9) return 0;
  c.in += d * sp; c.out += d * sp;
  for (const x of partnersOf(p, c)) { const s2 = speedOf(x); const dd = Math.max(-x.in / s2, Math.min((mediaDurOf(p, x) - x.out) / s2, d)); x.in += dd * s2; x.out += dd * s2; }
  return d;
}

/**
 * Slide: клип id едет по дорожке на d, соседи впритык подстраиваются (левый удлиняется/укорачивается концом,
 * правый — началом); если сосед не впритык — клип едет в пределах пустоты. → итоговый d
 */
export function slideClip(p, id, d) {
  const n = neighbours(p, id);
  if (!n || n.row.kind === 'sub') return 0;
  const c = n.clip; const { prev, next } = n;
  let lo = -c.start; let hi = Infinity;
  if (prev) {
    if (n.prevAdj) lo = Math.max(lo, -(tlLen(prev) - MIN_CLIP)); else lo = Math.max(lo, end(prev) - c.start);
    if (n.prevAdj) hi = Math.min(hi, (mediaDurOf(p, prev) - prev.out) / speedOf(prev));
  }
  if (next) {
    if (n.nextAdj) {
      hi = Math.min(hi, tlLen(next) - MIN_CLIP);
      if (!isText(next)) lo = Math.max(lo, -next.in / speedOf(next));
    } else hi = Math.min(hi, next.start - end(c));
  }
  d = Math.max(lo, Math.min(hi, d));
  if (Math.abs(d) < 1e-9) return 0;
  if (prev && n.prevAdj) moveOut(p, prev, d);
  if (next && n.nextAdj) { next.start += d; moveIn(p, next, d); }
  c.start += d;
  return d;
}

/** Кадры для двойного предпросмотра при обрезке: [{ clip, src (время файла), side }] — что показывать слева и справа */
export function trimFrames(p, op, id) {
  const n = neighbours(p, id);
  if (!n) return null;
  const c = n.clip;
  const last = (x) => ({ clip: x, src: Math.max(x.in, x.out - 0.001 * speedOf(x)) });
  const first = (x) => ({ clip: x, src: x.in });
  switch (op) {
    case 'roll': return n.next && n.nextAdj ? [last(c), first(n.next)] : null;
    case 'slip': return [first(c), last(c)];
    case 'slide': return [n.prev && n.prevAdj ? last(n.prev) : first(c), n.next && n.nextAdj ? first(n.next) : last(c)];
    case 'ripple-l': return [n.prev ? last(n.prev) : null, first(c)];
    case 'ripple-r': return [last(c), n.next ? first(n.next) : null];
    default: return null;
  }
}

/** Паузы из silencedetect (время файла [{ start, end }]) → промежутки таймлайна клипа c для удаления */
export function silenceRanges(c, silences, { margin = 0.15, minLen = 0.05, fps = 0, mediaDur = Infinity } = {}) {
  const out = [];
  for (const s of silences || []) {
    const s0 = Math.max(Number(s.start) || 0, c.in);
    const s1 = Math.min(s.end === null || s.end === undefined ? mediaDur : Number(s.end), c.out);
    if (!(s1 > s0)) continue;
    let a = tlAt(c, s0); let b = tlAt(c, s1);
    // У краёв клипа запас не нужен: пауза в начале или в конце убирается целиком
    if (s0 > c.in + 1e-6) a += margin;
    if (s1 < c.out - 1e-6) b -= margin;
    if (fps) { a = snapFrame(a, fps); b = snapFrame(b, fps); }
    a = Math.max(c.start, a); b = Math.min(end(c), b);
    if (b - a >= minLen) out.push([a, b]);
  }
  return out;
}

/** Время t внутри клипа (для разрезов и Q/W) */
export const insideClip = (c, t) => t > c.start + MIN_CLIP - 1e-6 && t < end(c) - MIN_CLIP + 1e-6;
export { srcAt, splitLink };
