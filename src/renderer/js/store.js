// Состояние проекта: данные, отмена/повтор, производные значения.
import { uid, clamp, snapFps } from './util.js';

export const MIN_CLIP = 0.1; // минимальная длина клипа, с

export function emptyProject() {
  return {
    version: 1,
    name: 'Мой ролик',
    media: {},          // id -> сведения о файле (из ffprobe)
    videoClips: [],     // основная дорожка, клипы встык: { id, mediaId, in, out, volume, muted }
    audioTracks: [{ id: uid('trk'), muted: false, clips: [] }], // { id, muted, clips: [{ id, mediaId, in, out, start, volume, muted }] }
  };
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.filePath = null;      // где сохранён проект
    this.dirty = false;
    this.selection = null;     // { kind: 'video'|'audio', id }
    this.time = 0;             // позиция курсора, с
    this.playing = false;
    this.runtime = {};         // mediaId -> { thumbs, peaks, proxyUrl, status, progress, error }
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
    if (history) this.pushHistory(before);
    this.afterChange();
    return r;
  }

  // Для перетаскиваний: меняем «вживую», а в историю кладём один раз по окончании
  live(fn) { const r = fn(this.project); this.afterChange(false); return r; }
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
    this.project = project;
    this.filePath = filePath;
    this.undoStack = []; this.redoStack = [];
    this.selection = null; this.time = 0; this.dirty = false;
    this.emit('project'); this.emit('selection'); this.emit('time');
  }

  // --- выделение и время ---
  select(sel) { this.selection = sel; this.emit('selection'); }
  validateSelection() {
    if (this.selection && !this.findClip(this.selection.id)) { this.selection = null; this.emit('selection'); }
  }
  setTime(t, src) {
    this.time = clamp(t, 0, Math.max(0, this.duration()));
    this.emit('time', src);
  }

  setRuntime(mediaId, patch) {
    this.runtime[mediaId] = { ...(this.runtime[mediaId] || {}), ...patch };
    this.emit('media', mediaId);
  }

  // --- производные ---
  media(id) { return this.project.media[id]; }

  videoLayout() {
    let t = 0;
    return this.project.videoClips.map((c, index) => {
      const d = c.out - c.in;
      const seg = { clip: c, index, start: t, end: t + d };
      t += d;
      return seg;
    });
  }
  videoEnd() { return this.project.videoClips.reduce((s, c) => s + (c.out - c.in), 0); }
  audioEnd() {
    let e = 0;
    for (const t of this.project.audioTracks) for (const c of t.clips) e = Math.max(e, c.start + c.out - c.in);
    return e;
  }
  duration() { return Math.max(this.videoEnd(), this.audioEnd()); }

  findClip(id) {
    const v = this.project.videoClips.find((c) => c.id === id);
    if (v) return { kind: 'video', clip: v };
    for (const t of this.project.audioTracks) {
      const a = t.clips.find((c) => c.id === id);
      if (a) return { kind: 'audio', clip: a, track: t };
    }
    return null;
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

  removeMedia(mediaId) {
    this.mutate((p) => {
      delete p.media[mediaId];
      p.videoClips = p.videoClips.filter((c) => c.mediaId !== mediaId);
      for (const t of p.audioTracks) t.clips = t.clips.filter((c) => c.mediaId !== mediaId);
    });
  }

  usageCount(mediaId) {
    let n = this.project.videoClips.filter((c) => c.mediaId === mediaId).length;
    for (const t of this.project.audioTracks) n += t.clips.filter((c) => c.mediaId === mediaId).length;
    return n;
  }

  insertVideoClip(mediaId, index = this.project.videoClips.length) {
    const m = this.media(mediaId);
    if (!m || !m.hasVideo) return null;
    const clip = { id: uid('clp'), mediaId, in: 0, out: m.duration, volume: 1, muted: false };
    this.mutate((p) => { p.videoClips.splice(clamp(index, 0, p.videoClips.length), 0, clip); });
    this.select({ kind: 'video', id: clip.id });
    return clip;
  }

  // Подбирает дорожку, где интервал свободен; если нет — создаёт новую
  freeTrackFor(start, dur, preferTrackId) {
    const fits = (t) => t.clips.every((c) => c.start + (c.out - c.in) <= start + 1e-6 || c.start >= start + dur - 1e-6);
    const pref = this.project.audioTracks.find((t) => t.id === preferTrackId);
    if (pref && fits(pref)) return pref.id;
    const t = this.project.audioTracks.find(fits);
    return t ? t.id : null;
  }

  addAudioClip(mediaId, start, trackId = null, { forceTrack = false } = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasAudio) return null;
    const clip = { id: uid('clp'), mediaId, in: 0, out: m.duration, start: Math.max(0, start), volume: 1, muted: false };
    this.mutate((p) => {
      let tid = forceTrack && trackId ? trackId : this.freeTrackFor(clip.start, m.duration, trackId);
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

  moveVideoClip(id, newIndex) {
    this.mutate((p) => {
      const i = p.videoClips.findIndex((c) => c.id === id);
      if (i < 0) return;
      const [c] = p.videoClips.splice(i, 1);
      p.videoClips.splice(clamp(newIndex, 0, p.videoClips.length), 0, c);
    });
  }

  setClip(id, patch, opts) {
    this.mutate(() => { const f = this.findClip(id); if (f) Object.assign(f.clip, patch); }, opts);
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
        if (f.kind === 'video') {
          const seg = this.videoLayout().find((s) => s.clip.id === cid);
          const local = f.clip.in + (t - seg.start);
          if (local - f.clip.in < MIN_CLIP || f.clip.out - local < MIN_CLIP) continue;
          const right = { ...f.clip, id: uid('clp'), in: local };
          f.clip.out = local;
          p.videoClips.splice(seg.index + 1, 0, right);
          done++;
        } else {
          const c = f.clip;
          const local = c.in + (t - c.start);
          if (local - c.in < MIN_CLIP || c.out - local < MIN_CLIP) continue;
          const right = { ...c, id: uid('clp'), in: local, start: t };
          c.out = local;
          f.track.clips.push(right);
          done++;
        }
      }
    });
    return done;
  }

  deleteClip(id) {
    this.mutate((p) => {
      p.videoClips = p.videoClips.filter((c) => c.id !== id);
      for (const t of p.audioTracks) t.clips = t.clips.filter((c) => c.id !== id);
    });
  }

  duplicateClip(id) {
    const f = this.findClip(id);
    if (!f) return;
    this.mutate((p) => {
      const copy = { ...f.clip, id: uid('clp') };
      if (f.kind === 'video') {
        const i = p.videoClips.findIndex((c) => c.id === id);
        p.videoClips.splice(i + 1, 0, copy);
      } else {
        copy.start = f.clip.start + (f.clip.out - f.clip.in);
        f.track.clips.push(copy);
      }
      this.selection = { kind: f.kind, id: copy.id };
    });
    this.emit('selection');
  }

  serialize() {
    return JSON.stringify({ app: 'FF Montage', version: 1, savedAt: new Date().toISOString(), project: this.project }, null, 1);
  }
}

export const store = new Store();
