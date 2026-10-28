// Состояние проекта: данные, отмена/повтор, производные значения и операции монтажа.
import { uid, clamp, snapFps } from './util.js';
import { MIN_DURATION as TR_MIN, MAX_DURATION as TR_MAX, DEFAULT_DURATION as TR_DEFAULT, TRANSITIONS } from './transitions.js';

export const MIN_CLIP = 0.1;   // минимальная длина клипа, с
export const ADJ = 0.002;      // допуск «стоят впритык», с
export const MAX_FADE = 10;    // максимум затухания, с

const len = (c) => c.out - c.in;
const end = (c) => c.start + c.out - c.in;
const byStart = (a, b) => a.start - b.start;

// Модель проекта (версия 2):
//   media        { [id]: сведения о файле из ffprobe; derived — файл, сделанный программой (реверс, стоп-кадр) }
//   videoClips   [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name?, transition? }]
//                основная дорожка: клипы по времени, без наложений, между ними могут быть пустоты.
//                transition = { type, duration } — переход из предыдущего клипа (если стоят впритык)
//   audioTracks  [{ id, muted, clips: [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name? }] }]
export function emptyProject() {
  return {
    version: 2,
    name: 'Мой ролик',
    media: {},
    videoClips: [],
    audioTracks: [{ id: uid('trk'), muted: false, clips: [] }],
  };
}

// Приводит проект любой версии к текущей (старые проекты: клипы видео шли встык без start)
export function normalizeProject(p) {
  p.media = p.media || {};
  p.videoClips = p.videoClips || [];
  p.audioTracks = p.audioTracks && p.audioTracks.length ? p.audioTracks : [{ id: uid('trk'), muted: false, clips: [] }];
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
  for (const t of p.audioTracks) { if (!t.id) t.id = uid('trk'); t.muted = !!t.muted; t.clips = t.clips || []; t.clips.forEach(fix); }
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
    const fps = Math.max(...list.map((m) => snapFps(m.fps)));
    return { width: best.width, height: best.height, fps, fromClip: true };
  }

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
    return { id: uid('clp'), mediaId, in: 0, out: m.duration, start: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra };
  }

  // Видео на основную дорожку: по умолчанию в конец, иначе около времени at (с «магнитом»)
  insertVideoClip(mediaId, at = null, mode = 'auto', extra = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasVideo) return null;
    const clip = this.newClip(mediaId, extra);
    this.mutate((p) => { placeVideo(p, clip, at === null ? this.videoEnd() : at, at === null ? 'insert' : mode); });
    this.select({ kind: 'video', id: clip.id });
    return clip;
  }

  // Подбирает дорожку, где интервал свободен; если нет — null
  freeTrackFor(start, dur, preferTrackId, excludeId = null) {
    const fits = (t) => t.clips.every((c) => c.id === excludeId || end(c) <= start + 1e-6 || c.start >= start + dur - 1e-6);
    const pref = this.project.audioTracks.find((t) => t.id === preferTrackId);
    if (pref && fits(pref)) return pref.id;
    const t = this.project.audioTracks.find(fits);
    return t ? t.id : null;
  }

  addAudioClip(mediaId, start, trackId = null, { forceTrack = false, extra = {} } = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasAudio) return null;
    const clip = this.newClip(mediaId, { start: Math.max(0, start), ...extra });
    this.mutate((p) => {
      let tid = forceTrack && trackId ? trackId : this.freeTrackFor(clip.start, len(clip), trackId);
      if (trackId === 'new' || !tid || !p.audioTracks.find((t) => t.id === tid)) {
        const t = { id: uid('trk'), muted: false, clips: [] };
        p.audioTracks.push(t);
        tid = t.id;
      }
      p.audioTracks.find((t) => t.id === tid).clips.push(clip);
    });
    this.select({ kind: 'audio', id: clip.id });
    return clip;
  }

  addAudioTrack() {
    this.mutate((p) => { p.audioTracks.push({ id: uid('trk'), muted: false, clips: [] }); });
  }

  removeAudioTrack(trackId) {
    this.mutate((p) => {
      p.audioTracks = p.audioTracks.filter((t) => t.id !== trackId);
      if (!p.audioTracks.length) p.audioTracks.push({ id: uid('trk'), muted: false, clips: [] });
    });
  }

  toggleTrackMute(trackId) {
    this.mutate((p) => { const t = p.audioTracks.find((x) => x.id === trackId); if (t) t.muted = !t.muted; });
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
        if (!t) { t = { id: uid('trk'), muted: false, clips: [] }; p.audioTracks.push(t); }
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

  // Разрезать клип по времени таймлайна t
  splitAt(t, id = null) {
    const targets = [];
    if (id) {
      targets.push(id);
    } else {
      const seg = this.videoLayout().find((s) => t > s.start + MIN_CLIP / 2 && t < s.end - MIN_CLIP / 2);
      if (seg) targets.push(seg.clip.id);
    }
    let done = 0;
    this.mutate((p) => {
      for (const cid of targets) {
        const f = this.findClip(cid);
        if (!f) continue;
        const c = f.clip;
        const local = c.in + (t - c.start);
        if (local - c.in < MIN_CLIP || c.out - local < MIN_CLIP) continue;
        const right = { ...c, id: uid('clp'), in: local, start: t, fadeIn: 0 };
        delete right.transition;
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
    this.mutate((p) => {
      const d = len(f.clip);
      const e = end(f.clip);
      const list = f.kind === 'video' ? p.videoClips : f.track.clips;
      const rest = list.filter((c) => c.id !== id);
      if (ripple) for (const c of rest) if (c.start >= e - ADJ) c.start = Math.max(0, c.start - d);
      if (f.kind === 'video') p.videoClips = rest; else f.track.clips = rest;
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
    this.mutate((p) => {
      if (f.kind === 'video') {
        placeVideo(p, copy, end(f.clip), 'insert');
      } else {
        copy.start = end(f.clip);
        const tid = this.freeTrackFor(copy.start, len(copy), f.track.id, null);
        let t = tid ? p.audioTracks.find((x) => x.id === tid) : null;
        if (!t) { t = { id: uid('trk'), muted: false, clips: [] }; p.audioTracks.push(t); }
        t.clips.push(copy);
      }
    });
    this.select({ kind: f.kind, id: copy.id });
    return copy;
  }

  copyClip(id) {
    const f = this.findClip(id);
    if (!f) return false;
    const c = JSON.parse(JSON.stringify(f.clip));
    delete c.transition;
    this.clipboard = { kind: f.kind, clip: c, trackId: f.track ? f.track.id : null };
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
      } else {
        const want = lane && lane !== 'video' ? lane : cb.trackId;
        const tid = this.freeTrackFor(copy.start, len(copy), want, null);
        let t = tid ? p.audioTracks.find((x) => x.id === tid) : null;
        if (!t) { t = { id: uid('trk'), muted: false, clips: [] }; p.audioTracks.push(t); }
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
