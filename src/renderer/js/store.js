// Состояние проекта: данные, отмена/повтор, производные значения и операции монтажа.
import { uid, clamp, snapFps } from './util.js';
import { MIN_DURATION as TR_MIN, MAX_DURATION as TR_MAX, DEFAULT_DURATION as TR_DEFAULT, TRANSITIONS } from './transitions.js';

export const MIN_CLIP = 0.1;   // минимальная длина клипа, с
export const ADJ = 0.002;      // допуск «стоят впритык», с
export const MAX_FADE = 10;    // максимум затухания, с

// Форматы кадра проекта: ширина / высота ('auto' — как у видео)
export const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };
const even2 = (x) => Math.max(2, Math.round(x / 2) * 2);

const len = (c) => c.out - c.in;
const end = (c) => c.start + c.out - c.in;
const byStart = (a, b) => a.start - b.start;

// Модель проекта (версия 2):
//   media        { [id]: сведения о файле из ffprobe; derived — файл, сделанный программой (реверс, стоп-кадр) }
//   videoClips   [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name?, transition? }]
//                основная дорожка: клипы по времени, без наложений, между ними могут быть пустоты.
//                transition = { type, duration } — переход из предыдущего клипа (если стоят впритык)
//   audioTracks  [{ id, name?, muted, solo?, volume?, clips: [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name?, stream?, link? }] }]
//   videoName    имя видеодорожки (по умолчанию «Видео»)
//
// Связь видео и звука: при добавлении видео его звук (каждый звуковой поток файла) ложится отдельными клипами
// на аудиодорожки с тем же link, а у видеоклипа ставится noAudio. Связанный звук всегда синхронен видео
// по времени файла (syncLinks): двигаем видео — едет и звук; разрезаем/удаляем — вместе.
// stream — номер звукового потока файла (0 — первый).
export const newTrack = (extra = {}) => ({ id: uid('trk'), muted: false, solo: false, volume: 1, clips: [], ...extra });

export function emptyProject() {
  return {
    version: 2,
    name: 'Мой ролик',
    media: {},
    videoClips: [],
    audioTracks: [newTrack()],
  };
}

// Приводит проект любой версии к текущей (старые проекты: клипы видео шли встык без start)
export function normalizeProject(p) {
  p.media = p.media || {};
  p.videoClips = p.videoClips || [];
  p.audioTracks = p.audioTracks && p.audioTracks.length ? p.audioTracks : [newTrack()];
  if (!(p.version >= 2)) {
    let t = 0;
    for (const c of p.videoClips) { c.start = t; t += len(c); }
  }
  const fix = (c) => {
    if (!c.id) c.id = uid('clp');
    if (!isFinite(c.start)) c.start = 0;
    if (!isFinite(c.volume)) c.volume = 1;
    c.muted = !!c.muted;
    c.fadeIn = Math.max(0, Number(c.fadeIn) || 0);
    c.fadeOut = Math.max(0, Number(c.fadeOut) || 0);
  };
  p.videoClips.forEach(fix);
  for (const t of p.audioTracks) {
    if (!t.id) t.id = uid('trk');
    t.muted = !!t.muted; t.solo = !!t.solo;
    t.volume = isFinite(t.volume) ? Number(t.volume) : 1;
    t.clips = t.clips || []; t.clips.forEach(fix);
  }
  p.version = 2;
  fixup(p);
  return p;
}

// Наибольшая допустимая длительность перехода между a и b
export function maxTransition(a, b) {
  return Math.max(0, Math.min(TR_MAX, len(a), len(b)));
}

// Наводит порядок после любого изменения: сортировка, затухания, переходы только у стоящих впритык клипов
export function fixup(p) {
  syncLinks(p);
  p.videoClips.sort(byStart);
  const fades = (c) => {
    const d = len(c);
    c.fadeIn = clamp(c.fadeIn || 0, 0, Math.min(MAX_FADE, d));
    c.fadeOut = clamp(c.fadeOut || 0, 0, Math.min(MAX_FADE, d - c.fadeIn));
  };
  p.videoClips.forEach(fades);
  for (const t of p.audioTracks) t.clips.forEach(fades);
  p.videoClips.forEach((c, i) => {
    if (!c.transition) return;
    const prev = p.videoClips[i - 1];
    if (!prev || Math.abs(end(prev) - c.start) > ADJ || !TRANSITIONS.find((x) => x.id === c.transition.type)) { delete c.transition; return; }
    const mx = maxTransition(prev, c);
    if (mx < TR_MIN) { delete c.transition; return; }
    c.transition.duration = clamp(Number(c.transition.duration) || TR_DEFAULT, TR_MIN, mx);
  });
}

// Связанный звук ставится по видео: тот же момент файла — тот же момент таймлайна
export function syncLinks(p) {
  const vmap = new Map();
  for (const v of p.videoClips) if (v.link) vmap.set(v.link, v);
  for (const t of p.audioTracks) {
    for (const c of t.clips) {
      if (!c.link) continue;
      const v = vmap.get(c.link);
      if (!v || v.mediaId !== c.mediaId) { delete c.link; continue; }
      let s = v.start - v.in + c.in;
      if (s < 0) { c.in = Math.min(c.out - MIN_CLIP, c.in - s); s = v.start - v.in + c.in; }
      c.start = Math.max(0, s);
    }
  }
}

// id связи для правой половины разрезанного клипа: одинаковый у видео и его звука, разрезанных в одном месте
export const splitLink = (link, t) => (link ? `${link.split('@')[0]}@${t.toFixed(3)}` : undefined);

// Освобождает [s, e) в списке клипов: накрытые целиком удаляет, частично — подрезает, а если клип
// шире промежутка с обеих сторон — разрезает. keep(c) — клипы, которые не трогать. Возвращает новый список.
export function carve(list, s, e, keep = () => false) {
  const out = [];
  for (const c of list) {
    const cs = c.start; const ce = end(c);
    if (keep(c) || ce <= s + ADJ || cs >= e - ADJ) { out.push(c); continue; }
    if (cs < s - ADJ) {
      if (ce > e + ADJ && ce - e >= MIN_CLIP / 2) {
        const right = { ...JSON.parse(JSON.stringify(c)), id: uid('clp'), in: c.in + (e - cs), start: e, fadeIn: 0 };
        delete right.transition;
        if (c.link) right.link = splitLink(c.link, e);
        out.push(right);
      }
      if (s - cs >= MIN_CLIP / 2) { c.out = c.in + (s - cs); c.fadeOut = 0; out.push(c); }
    } else if (ce > e + ADJ && ce - e >= MIN_CLIP / 2) {
      c.in += e - cs; c.start = e; c.fadeIn = 0; delete c.transition; out.push(c);
    }
  }
  return out;
}

// Наложение: клип clip (уже в p.videoClips) ставится в start и «затирает» то, что под ним, —
// и на видеодорожке, и звук под ним (звук затёртых видео и свой связанный звук на его дорожках)
export function overwriteVideo(p, clip, start) {
  clip.start = Math.max(0, start);
  const s = clip.start; const e = end(clip);
  const hitLinks = new Set(p.videoClips.filter((c) => c !== clip && c.link && c.start < e - ADJ && end(c) > s + ADJ).map((c) => c.link));
  p.videoClips = carve(p.videoClips, s, e, (c) => c === clip);
  syncLinks(p);
  const own = clip.link;
  for (const t of p.audioTracks) {
    t.clips = carve(t.clips, s, e, (c) => !c.link || !hitLinks.has(c.link));
    for (const a of t.clips.filter((c) => own && c.link === own)) {
      t.clips = carve(t.clips, a.start, end(a), (c) => c.link === own);
    }
  }
}

// То же для аудиоклипа на его дорожке
export function overwriteAudio(track, clip) {
  track.clips = carve(track.clips, clip.start, end(clip), (c) => c === clip);
}

// Пустоты на дорожке: [[начало, конец], …], включая пустоту от 0 до первого клипа
export function gapsOf(clips) {
  const list = [...clips].sort(byStart);
  const gaps = [];
  let prevEnd = 0;
  for (const c of list) {
    if (c.start - prevEnd > ADJ * 5) gaps.push([prevEnd, c.start]);
    prevEnd = Math.max(prevEnd, end(c));
  }
  return gaps;
}

// Сдвигает клипы, начинающиеся не раньше from, чтобы первый из них начинался не раньше cursor
// (сдвиг «по цепочке», только насколько нужно — дальние пустоты поглощают сдвиг)
function pushFrom(list, from, cursor, exclude = null) {
  for (const o of [...list].sort(byStart)) {
    if (o === exclude || o.start < from - ADJ) continue;
    if (o.start < cursor - ADJ) o.start = cursor;
    cursor = Math.max(cursor, end(o));
  }
}

// Размещение видеоклипа на основной дорожке около желаемого времени.
//  - если место свободно — ставим как есть;
//  - если рядом есть подходящая пустота (сдвиг не больше половины клипа) — «примагничиваем» в неё;
//  - иначе вставляем перед/после клипа, на который попали, и раздвигаем следующие.
// mode 'insert' — ставим ровно в at и раздвигаем следующие.
export function placeVideo(p, clip, desired, mode = 'auto') {
  const others = p.videoClips.filter((c) => c !== clip && c.id !== clip.id).sort(byStart);
  const d = len(clip);
  let s = Math.max(0, desired);
  const overlap = (st) => others.find((o) => st < end(o) - ADJ && st + d > o.start + ADJ);
  if (mode === 'insert') {
    clip.start = s;
    pushFrom(others, s, s + d);
  } else if (!overlap(s)) {
    clip.start = s;
  } else {
    let best = null;
    let prevEnd = 0;
    const gaps = [];
    for (const o of others) { gaps.push([prevEnd, o.start]); prevEnd = Math.max(prevEnd, end(o)); }
    gaps.push([prevEnd, Infinity]);
    for (const [g0, g1] of gaps) {
      if (g1 - g0 < d - ADJ) continue;
      const st = clamp(s, g0, g1 - d);
      const dist = Math.abs(st - s);
      if (!best || dist < best.dist) best = { st, dist };
    }
    if (best && best.dist <= Math.max(d * 0.5, 0.05)) {
      clip.start = best.st;
    } else {
      const hit = overlap(s);
      const at = s < hit.start + len(hit) / 2 ? hit.start : end(hit);
      clip.start = at;
      pushFrom(others, at, at + d);
    }
  }
  if (!p.videoClips.includes(clip)) p.videoClips.push(clip);
  p.videoClips.sort(byStart);
  return clip.start;
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.filePath = null;      // где сохранён проект
    this.dirty = false;
    this.selection = null;     // { kind: 'video'|'audio'|'transition', id }
    this.time = 0;             // позиция курсора, с
    this.playing = false;
    this.runtime = {};         // mediaId -> { thumbs, peaks, proxyUrl, status, progress, error }
    this.busy = {};            // clipId -> { label, progress } — идёт обработка (реверс, стоп-кадр)
    this.clipboard = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Map();
  }

  // --- события ---
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) || []) fn(payload);
    if (type !== '*') for (const fn of this.listeners.get('*') || []) fn(type, payload);
  }

  // --- изменения с историей ---
  snapshot() { return JSON.stringify(this.project); }

  mutate(fn, { history = true } = {}) {
    const before = history ? this.snapshot() : null;
    const r = fn(this.project);
    fixup(this.project);
    if (history && before !== this.snapshot()) this.pushHistory(before);
    this.afterChange();
    return r;
  }

  // Для перетаскиваний: меняем «вживую», а в историю кладём один раз по окончании
  live(fn) { const r = fn(this.project); fixup(this.project); this.afterChange(false); return r; }
  commitFrom(before) {
    if (before && before !== this.snapshot()) { this.pushHistory(before); this.afterChange(); }
  }

  pushHistory(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  afterChange(markDirty = true) {
    this.validateSelection();
    if (markDirty) this.dirty = true;
    this.time = clamp(this.time, 0, Math.max(0, this.duration()));
    this.emit('project');
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.project = JSON.parse(this.undoStack.pop());
    this.afterChange();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.project = JSON.parse(this.redoStack.pop());
    this.afterChange();
    return true;
  }

  load(project, filePath = null) {
    this.project = normalizeProject(project);
    this.filePath = filePath;
    this.undoStack = []; this.redoStack = [];
    this.selection = null; this.time = 0; this.dirty = false;
    this.busy = {};
    this.emit('project'); this.emit('selection'); this.emit('time');
  }

  // --- выделение и время ---
  select(sel) { this.selection = sel; this.emit('selection'); }
  validateSelection() {
    const s = this.selection;
    if (!s) return;
    let ok = !!this.findClip(s.id);
    if (ok && s.kind === 'transition') ok = !!this.junctionBefore(s.id);
    if (!ok) { this.selection = null; this.emit('selection'); }
  }
  setTime(t, src) {
    this.time = clamp(t, 0, Math.max(0, this.duration()));
    this.emit('time', src);
  }

  setRuntime(mediaId, patch) {
    this.runtime[mediaId] = { ...(this.runtime[mediaId] || {}), ...patch };
    this.emit('media', mediaId);
  }

  setBusy(clipId, info) {
    if (info) this.busy[clipId] = info; else delete this.busy[clipId];
    this.emit('busy', clipId);
  }

  // --- производные ---
  media(id) { return this.project.media[id]; }

  videoLayout() {
    return [...this.project.videoClips].sort(byStart).map((c, index) => ({ clip: c, index, start: c.start, end: end(c) }));
  }
  videoEnd() { return this.project.videoClips.reduce((s, c) => Math.max(s, end(c)), 0); }
  audioEnd() {
    let e = 0;
    for (const t of this.project.audioTracks) for (const c of t.clips) e = Math.max(e, end(c));
    return e;
  }
  duration() { return Math.max(this.videoEnd(), this.audioEnd()); }

  // Название клипа для показа: своё имя → имя исходного файла (у реверса/стоп-кадра — имя оригинала)
  clipName(c) {
    if (c.name) return c.name;
    const m = this.media(c.mediaId);
    if (!m) return '?';
    if (m.derived) { const src = this.media(m.derived.from); return src ? src.name : m.name; }
    return m.name;
  }

  findClip(id) {
    const v = this.project.videoClips.find((c) => c.id === id);
    if (v) return { kind: 'video', clip: v };
    for (const t of this.project.audioTracks) {
      const a = t.clips.find((c) => c.id === id);
      if (a) return { kind: 'audio', clip: a, track: t };
    }
    return null;
  }

  // Стык перед видеоклипом id: { a, b } если предыдущий клип стоит впритык
  junctionBefore(id) {
    const list = this.project.videoClips;
    const i = list.findIndex((c) => c.id === id);
    if (i <= 0) return null;
    const a = list[i - 1]; const b = list[i];
    return Math.abs(end(a) - b.start) <= ADJ ? { a, b, seam: b.start } : null;
  }

  // Все действующие переходы: [{ a, b, type, d, seam, from, to }]
  transitions() {
    const out = [];
    const list = this.project.videoClips;
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      if (!b.transition) continue;
      const a = list[i - 1];
      const d = b.transition.duration;
      out.push({ a, b, type: b.transition.type, d, seam: b.start, from: b.start - d / 2, to: b.start + d / 2 });
    }
    return out;
  }

  // Формат проекта по умолчанию — по самому крупному видео на таймлайне
  // (чтобы короткая заставка в 480p не уменьшила весь ролик), частота — максимальная
  sourceFormat() {
    let list = this.project.videoClips.map((c) => this.media(c.mediaId)).filter((m) => m && m.hasVideo);
    if (!list.length) list = Object.values(this.project.media).filter((m) => m.hasVideo);
    if (!list.length) return { width: 1920, height: 1080, fps: 30, fromClip: false };
    const best = list.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const vids = list.filter((m) => !m.isImage || m.isAnimation);
    const fps = vids.length ? Math.max(...vids.map((m) => snapFps(m.fps))) : 30;
    // Формат кадра проекта (16:9, 9:16, 1:1, 3:4): короткая сторона — как у самого крупного видео
    const ar = ASPECTS[this.project.aspect];
    if (ar) {
      const s = Math.min(best.width, best.height);
      const even = (x) => Math.max(2, Math.round(x / 2) * 2);
      const [w, hh] = ar >= 1 ? [even(s * ar), s] : [s, even(s / ar)];
      return { width: w, height: hh, fps, fromClip: true, aspect: this.project.aspect };
    }
    return { width: even2(best.width), height: even2(best.height), fps, fromClip: true };
  }

  // Настройки проекта: aspect ('auto' | '16:9' | '9:16' | '1:1' | '3:4'), background ('#rrggbb')
  setProjectProps(patch) {
    this.mutate((p) => {
      for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === 'auto') delete p[k]; else p[k] = v; }
    });
  }

  // Включить/выключить эффект у клипа
  toggleEffect(clipId, effectId, on = null) {
    const f = this.findClip(clipId);
    if (!f || f.kind !== 'video') return false;
    const cur = Array.isArray(f.clip.effects) ? f.clip.effects : [];
    const has = cur.includes(effectId);
    const want = on === null ? !has : on;
    if (want === has) return true;
    const next = want ? [...cur, effectId] : cur.filter((x) => x !== effectId);
    this.mutate(() => { const c = this.findClip(clipId).clip; if (next.length) c.effects = next; else delete c.effects; });
    return true;
  }

  // Цвет фона под видео (поля при «вписать», пустоты)
  background() { return /^#[0-9a-f]{6}$/i.test(this.project.background || '') ? this.project.background : '#000000'; }

  // ------------------------------------------------------------------------
  // Операции монтажа
  // ------------------------------------------------------------------------
  addMedia(info) {
    // Один и тот же файл не добавляем дважды
    const existing = Object.values(this.project.media).find((m) => m.path.toLowerCase() === info.path.toLowerCase());
    if (existing) return existing.id;
    const id = uid('med');
    this.mutate((p) => { p.media[id] = { ...info, id }; });
    return id;
  }

  // id исходного файла и всех сделанных из него (реверс, стоп-кадр)
  familyOf(mediaId) {
    const ids = new Set([mediaId]);
    for (const m of Object.values(this.project.media)) if (m.derived && ids.has(m.derived.from)) ids.add(m.id);
    return ids;
  }

  removeMedia(mediaId) {
    const ids = this.familyOf(mediaId);
    this.mutate((p) => {
      for (const id of ids) delete p.media[id];
      p.videoClips = p.videoClips.filter((c) => !ids.has(c.mediaId));
      for (const t of p.audioTracks) t.clips = t.clips.filter((c) => !ids.has(c.mediaId));
    });
  }

  usageCount(mediaId) {
    const ids = this.familyOf(mediaId);
    let n = this.project.videoClips.filter((c) => ids.has(c.mediaId)).length;
    for (const t of this.project.audioTracks) n += t.clips.filter((c) => ids.has(c.mediaId)).length;
    return n;
  }

  newClip(mediaId, extra = {}) {
    const m = this.media(mediaId);
    const out = m.isImage && !m.isAnimation ? Math.min(5, m.duration) : m.duration;
    return { id: uid('clp'), mediaId, in: 0, out, start: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra };
  }

  // Видео на основную дорожку: по умолчанию в конец, иначе около времени at.
  //   mode 'auto' — «магнит» в пустоту или раздвинуть соседей; 'insert' — ровно в at, раздвинуть; 'overwrite' — затереть то, что под ним.
  //   linkAudio — звук файла отдельными связанными клипами на аудиодорожках (каждый звуковой поток — свой клип)
  insertVideoClip(mediaId, at = null, mode = 'auto', extra = {}, { linkAudio = true } = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasVideo) return null;
    const clip = this.newClip(mediaId, extra);
    const split = linkAudio && m.hasAudio && !m.isImage;
    if (split) { clip.link = uid('lnk'); clip.noAudio = true; }
    this.mutate((p) => {
      if (mode === 'overwrite' && at !== null) { p.videoClips.push(clip); overwriteVideo(p, clip, at); } else placeVideo(p, clip, at === null ? this.videoEnd() : at, at === null ? 'insert' : mode);
      if (split) this.addLinkedAudio(p, clip, mode === 'overwrite');
    });
    this.select({ kind: 'video', id: clip.id });
    return clip;
  }

  // Звук видеоклипа отдельными клипами (по одному на звуковой поток) на аудиодорожках
  addLinkedAudio(p, v, overwrite = false) {
    const m = this.media(v.mediaId);
    const n = m && m.hasAudio ? Math.max(1, (m.audioStreams || []).length) : 0;
    const used = new Set();
    for (let s = 0; s < n; s++) {
      const a = { ...this.newClip(v.mediaId), in: v.in, out: v.out, start: v.start, link: v.link, stream: s, volume: 1 };
      const t = this.trackForStream(p, s, a.start, len(a), used, overwrite);
      used.add(t.id);
      t.clips.push(a);
      if (overwrite) overwriteAudio(t, a);
    }
  }

  // Дорожка для звука видео (поток s): та, где уже лежит звук этого потока других видео, иначе свободная
  // без музыки, иначе новая. overwrite — свободной быть не обязана (под клипом всё затрётся).
  trackForStream(p, s, start, dur, used = new Set(), overwrite = false) {
    const fits = (t) => t.clips.every((c) => end(c) <= start + ADJ || c.start >= start + dur - ADJ);
    const ok = (t) => !used.has(t.id) && (overwrite || fits(t));
    const withStream = p.audioTracks.filter((t) => t.clips.some((c) => c.link && (c.stream || 0) === s));
    let t = withStream.find(ok);
    if (!t) t = p.audioTracks.find((x) => ok(x) && x.clips.every((c) => c.link) && (x.clips.length || !withStream.length));
    if (!t && !overwrite) t = p.audioTracks.find((x) => ok(x) && !x.clips.length);
    if (!t) { t = newTrack(); p.audioTracks.push(t); }
    return t;
  }

  // Клипы, связанные с клипом id (без него самого): [{ kind, clip, track? }]
  linkedOf(id) {
    const f = this.findClip(id);
    if (!f || !f.clip.link) return [];
    const out = [];
    for (const v of this.project.videoClips) if (v.link === f.clip.link && v.id !== id) out.push({ kind: 'video', clip: v });
    for (const t of this.project.audioTracks) for (const c of t.clips) if (c.link === f.clip.link && c.id !== id) out.push({ kind: 'audio', clip: c, track: t });
    return out;
  }

  // Отвязать звук от видео (клипы останутся на местах, но будут двигаться отдельно)
  unlink(id) {
    const f = this.findClip(id);
    if (!f || !f.clip.link) return false;
    const L = f.clip.link;
    this.mutate((p) => {
      for (const v of p.videoClips) if (v.link === L) delete v.link;
      for (const t of p.audioTracks) for (const c of t.clips) if (c.link === L) delete c.link;
    });
    return true;
  }

  // Вернуть звук внутрь видеоклипа: связанные аудиоклипы удаляются, у видео снова свой звук
  restoreOwnAudio(id) {
    const f = this.findClip(id);
    if (!f || f.kind !== 'video') return false;
    const L = f.clip.link;
    this.mutate((p) => {
      const v = p.videoClips.find((x) => x.id === id);
      delete v.noAudio; delete v.link;
      if (L) for (const t of p.audioTracks) t.clips = t.clips.filter((c) => c.link !== L);
    });
    return true;
  }

  // Вынести звук видеоклипа на аудиодорожки
  detachAudio(id) {
    const f = this.findClip(id);
    if (!f || f.kind !== 'video' || f.clip.noAudio) return false;
    const m = this.media(f.clip.mediaId);
    if (!m || !m.hasAudio) return false;
    this.mutate((p) => {
      const v = p.videoClips.find((x) => x.id === id);
      v.link = uid('lnk'); v.noAudio = true;
      const vol = v.volume; const muted = v.muted;
      this.addLinkedAudio(p, v);
      for (const t of p.audioTracks) for (const c of t.clips) if (c.link === v.link) { c.volume = vol; c.muted = muted; c.fadeIn = v.fadeIn; c.fadeOut = v.fadeOut; }
      v.volume = 1; v.muted = false;
    });
    return true;
  }

  // Подбирает дорожку, где интервал свободен; если нет — null
  freeTrackFor(start, dur, preferTrackId, excludeId = null) {
    const fits = (t) => t.clips.every((c) => c.id === excludeId || end(c) <= start + 1e-6 || c.start >= start + dur - 1e-6);
    const pref = this.project.audioTracks.find((t) => t.id === preferTrackId);
    if (pref && fits(pref)) return pref.id;
    const t = this.project.audioTracks.find(fits);
    return t ? t.id : null;
  }

  addAudioClip(mediaId, start, trackId = null, { forceTrack = false, extra = {}, overwrite = false } = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasAudio) return null;
    const clip = this.newClip(mediaId, { start: Math.max(0, start), ...extra });
    this.mutate((p) => {
      let tid = (forceTrack || overwrite) && trackId ? trackId : this.freeTrackFor(clip.start, len(clip), trackId);
      if (trackId === 'new' || !tid || !p.audioTracks.find((t) => t.id === tid)) {
        const t = newTrack();
        p.audioTracks.push(t);
        tid = t.id;
      }
      const t = p.audioTracks.find((x) => x.id === tid);
      t.clips.push(clip);
      if (overwrite) overwriteAudio(t, clip);
    });
    this.select({ kind: 'audio', id: clip.id });
    return clip;
  }

  addAudioTrack() {
    this.mutate((p) => { p.audioTracks.push(newTrack()); });
  }

  removeAudioTrack(trackId) {
    this.mutate((p) => {
      p.audioTracks = p.audioTracks.filter((t) => t.id !== trackId);
      if (!p.audioTracks.length) p.audioTracks.push(newTrack());
    });
  }

  toggleTrackMute(trackId) {
    this.mutate((p) => { const t = p.audioTracks.find((x) => x.id === trackId); if (t) t.muted = !t.muted; });
  }

  // «Соло»: слышно только дорожки с соло (только в предпросмотре — на экспорт не влияет)
  toggleTrackSolo(trackId) {
    this.mutate((p) => { const t = p.audioTracks.find((x) => x.id === trackId); if (t) t.solo = !t.solo; }, { history: false });
  }
  anySolo() { return this.project.audioTracks.some((t) => t.solo); }

  // name, volume, …; trackId 'video' — видеодорожка (только name)
  setTrack(trackId, patch, opts) {
    this.mutate((p) => {
      if (trackId === 'video') { if (patch.name !== undefined) p.videoName = patch.name || undefined; return; }
      const t = p.audioTracks.find((x) => x.id === trackId);
      if (t) Object.assign(t, patch);
    }, opts);
  }
  trackName(trackId) {
    if (trackId === 'video') return this.project.videoName || 'Видео';
    const i = this.project.audioTracks.findIndex((x) => x.id === trackId);
    const t = this.project.audioTracks[i];
    return (t && t.name) || `Аудио ${i + 1}`;
  }

  // Переместить видеоклип к времени start (с размещением как при перетаскивании)
  moveVideoClip(id, start, mode = 'auto') {
    this.mutate((p) => {
      const c = p.videoClips.find((x) => x.id === id);
      if (c) placeVideo(p, c, start, mode);
    });
  }

  // Переместить аудиоклип (и, если нужно, на другую дорожку; trackId 'new' — новая дорожка)
  moveAudioClip(id, start, trackId = null) {
    this.mutate((p) => {
      const f = this.findClip(id);
      if (!f || f.kind !== 'audio') return;
      f.clip.start = Math.max(0, start);
      if (trackId && trackId !== f.track.id) {
        let t = trackId === 'new' ? null : p.audioTracks.find((x) => x.id === trackId);
        if (!t) { t = newTrack(); p.audioTracks.push(t); }
        f.track.clips = f.track.clips.filter((x) => x.id !== id);
        t.clips.push(f.clip);
      }
    });
  }

  setClip(id, patch, opts) {
    this.mutate(() => { const f = this.findClip(id); if (f) Object.assign(f.clip, patch); }, opts);
  }

  // Изменить длительность клипа (видео раздвигает следующие клипы, если не хватает места)
  setClipDuration(id, dur) {
    const f = this.findClip(id);
    if (!f) return false;
    const m = this.media(f.clip.mediaId);
    const nout = clamp(f.clip.in + dur, f.clip.in + MIN_CLIP, m ? m.duration : f.clip.out);
    this.mutate((p) => {
      const c = this.findClip(id).clip;
      const oldEnd = end(c);
      c.out = nout;
      if (f.kind === 'video' && end(c) > oldEnd) pushFrom(p.videoClips, oldEnd, end(c), c);
    });
    return nout - f.clip.in;
  }

  // Разрезать клип по времени таймлайна t. withLinked — вместе со связанными (видео + его звук).
  splitAt(t, id = null, { withLinked = false } = {}) {
    const targets = [];
    if (id) {
      targets.push(id);
      if (withLinked) for (const x of this.linkedOf(id)) targets.push(x.clip.id);
    } else {
      const seg = this.videoLayout().find((s) => t > s.start + MIN_CLIP / 2 && t < s.end - MIN_CLIP / 2);
      if (seg) targets.push(seg.clip.id);
    }
    return this.splitClips(t, targets);
  }

  // Alt+S: разрезать всё, что под курсором, на всех дорожках
  splitAll(t) {
    const ids = [];
    const hit = (c) => t > c.start + MIN_CLIP && t < end(c) - MIN_CLIP;
    for (const c of this.project.videoClips) if (hit(c)) ids.push(c.id);
    for (const tr of this.project.audioTracks) for (const c of tr.clips) if (hit(c)) ids.push(c.id);
    return this.splitClips(t, ids);
  }

  splitClips(t, targets) {
    let done = 0;
    if (!targets.length) return 0;
    this.mutate((p) => {
      for (const cid of targets) {
        const f = this.findClip(cid);
        if (!f) continue;
        const c = f.clip;
        const local = c.in + (t - c.start);
        if (local - c.in < MIN_CLIP || c.out - local < MIN_CLIP) continue;
        const right = { ...c, id: uid('clp'), in: local, start: t, fadeIn: 0 };
        delete right.transition;
        if (c.link) right.link = splitLink(c.link, t);
        c.out = local;
        c.fadeOut = 0;
        if (f.kind === 'video') p.videoClips.push(right);
        else f.track.clips.push(right);
        done++;
      }
    });
    return done;
  }

  // Удалить клип; ripple — сдвинуть следующие клипы дорожки на место удалённого
  deleteClip(id, { ripple = false } = {}) {
    const f = this.findClip(id);
    if (!f) return;
    // Видео удаляется вместе со своим звуком
    const L = f.kind === 'video' ? f.clip.link : null;
    this.mutate((p) => {
      const d = len(f.clip);
      const e = end(f.clip);
      const list = f.kind === 'video' ? p.videoClips : f.track.clips;
      const rest = list.filter((c) => c.id !== id);
      if (ripple) for (const c of rest) if (c.start >= e - ADJ) c.start = Math.max(0, c.start - d);
      if (f.kind === 'video') p.videoClips = rest; else f.track.clips = rest;
      if (L) for (const t of p.audioTracks) t.clips = t.clips.filter((c) => c.link !== L);
    });
  }

  // Пустоты дорожки: kind 'video' или id аудиодорожки
  gaps(lane) {
    if (lane === 'video') return gapsOf(this.project.videoClips);
    const t = this.project.audioTracks.find((x) => x.id === lane);
    return t ? gapsOf(t.clips) : [];
  }

  // Убрать пустоту, в которую попадает время at (сдвигает все клипы дорожки правее неё)
  closeGap(lane, at) {
    const g = this.gaps(lane).find(([a, b]) => at >= a - ADJ && at <= b + ADJ);
    if (!g) return 0;
    const shift = g[1] - g[0];
    this.mutate((p) => {
      const list = lane === 'video' ? p.videoClips : (p.audioTracks.find((x) => x.id === lane) || { clips: [] }).clips;
      for (const c of list) if (c.start >= g[1] - ADJ) c.start = Math.max(0, c.start - shift);
    });
    return shift;
  }

  closeAllGaps(lane) {
    const n = this.gaps(lane).length;
    if (!n) return 0;
    this.mutate((p) => {
      const list = lane === 'video' ? p.videoClips : (p.audioTracks.find((x) => x.id === lane) || { clips: [] }).clips;
      let t = 0;
      for (const c of [...list].sort(byStart)) { c.start = Math.min(c.start, t); t = Math.max(t, end(c)); }
    });
    return n;
  }

  duplicateClip(id) {
    const f = this.findClip(id);
    if (!f) return null;
    const copy = { ...JSON.parse(JSON.stringify(f.clip)), id: uid('clp') };
    delete copy.transition;
    const partners = f.kind === 'video' ? this.linkedOf(id).filter((x) => x.kind === 'audio').map((x) => ({ clip: JSON.parse(JSON.stringify(x.clip)), trackId: x.track.id })) : [];
    if (f.kind === 'audio') delete copy.link;
    this.mutate((p) => {
      if (f.kind === 'video') {
        placeVideo(p, copy, end(f.clip), 'insert');
        this.pastePartners(p, copy, partners);
      } else {
        copy.start = end(f.clip);
        const tid = this.freeTrackFor(copy.start, len(copy), f.track.id, null);
        let t = tid ? p.audioTracks.find((x) => x.id === tid) : null;
        if (!t) { t = newTrack(); p.audioTracks.push(t); }
        t.clips.push(copy);
      }
    });
    this.select({ kind: f.kind, id: copy.id });
    return copy;
  }

  // Звук скопированного видео: новые клипы с новой связью
  pastePartners(p, v, partners) {
    if (!v.link) return;
    if (!partners.length) { delete v.link; return; }
    v.link = uid('lnk');
    for (const { clip, trackId } of partners) {
      const a = { ...clip, id: uid('clp'), link: v.link, start: v.start - v.in + clip.in };
      let t = p.audioTracks.find((x) => x.id === trackId && x.clips.every((c) => end(c) <= a.start + ADJ || c.start >= end(a) - ADJ));
      if (!t) t = this.trackForStream(p, a.stream || 0, a.start, len(a));
      t.clips.push(a);
    }
  }

  copyClip(id) {
    const f = this.findClip(id);
    if (!f) return false;
    const c = JSON.parse(JSON.stringify(f.clip));
    delete c.transition;
    if (f.kind === 'audio') delete c.link;
    const partners = f.kind === 'video' ? this.linkedOf(id).filter((x) => x.kind === 'audio').map((x) => ({ clip: JSON.parse(JSON.stringify(x.clip)), trackId: x.track.id })) : [];
    this.clipboard = { kind: f.kind, clip: c, trackId: f.track ? f.track.id : null, partners };
    this.emit('clipboard');
    return true;
  }

  // Вставить скопированный клип в позицию курсора
  paste(at = this.time, lane = null) {
    const cb = this.clipboard;
    if (!cb || !this.media(cb.clip.mediaId)) return null;
    const copy = { ...JSON.parse(JSON.stringify(cb.clip)), id: uid('clp'), start: Math.max(0, at) };
    this.mutate((p) => {
      if (cb.kind === 'video') {
        placeVideo(p, copy, copy.start, 'auto');
        this.pastePartners(p, copy, cb.partners || []);
      } else {
        const want = lane && lane !== 'video' ? lane : cb.trackId;
        const tid = this.freeTrackFor(copy.start, len(copy), want, null);
        let t = tid ? p.audioTracks.find((x) => x.id === tid) : null;
        if (!t) { t = newTrack(); p.audioTracks.push(t); }
        t.clips.push(copy);
      }
    });
    this.select({ kind: cb.kind, id: copy.id });
    return copy;
  }

  // Переход перед видеоклипом id (из предыдущего, стоящего впритык). type null — убрать.
  setTransition(id, type, duration = null) {
    const j = this.junctionBefore(id);
    if (!j) return false;
    this.mutate(() => {
      const b = this.project.videoClips.find((c) => c.id === id);
      if (!type) { delete b.transition; return; }
      const d = duration ?? (b.transition ? b.transition.duration : TR_DEFAULT);
      b.transition = { type, duration: clamp(d, TR_MIN, Math.max(TR_MIN, maxTransition(j.a, b))) };
    });
    return true;
  }

  serialize() {
    return JSON.stringify({ app: 'FF Montage', version: 2, savedAt: new Date().toISOString(), project: this.project }, null, 1);
  }
}

export const store = new Store();
