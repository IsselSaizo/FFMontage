// ИИ-ассистент (MCP): выполняет в окне команды, которые присылает MCP-сервер (ff-montage --mcp, src-tauri/src/mcp.rs)
// через программу (src-tauri/src/control.rs), и окно «ИИ-ассистент» с готовыми настройками для клиентов.
//
// Все правки идут через store — с историей, поэтому пользователь видит их сразу и может отменить Ctrl+Z.
import { store, placeVideo, MIN_CLIP, newTrack } from './store.js';
import { importPaths } from './media.js';
import { toggleReverse, freezeFrameAt, isReversed, isFreeze } from './fx.js';
import { TRANSITIONS, MIN_DURATION as TR_MIN, MAX_DURATION as TR_MAX } from './transitions.js';
import { h, icon, toast, uid } from './util.js';

const api = window.api;

let hooks = null;        // { loadProjectText, newProject, saveProject } из app.js
let inited = false;
let encoders = null;

// ---------------------------------------------------------------------------
// Помощники
// ---------------------------------------------------------------------------
const r3 = (x) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const len = (c) => c.out - c.in;
const end = (c) => c.start + c.out - c.in;
const EPS = 1e-3;
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const isAbs = (p) => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };

function numArg(args, key, { min = -Infinity, max = Infinity, required = false, def } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) fail(`"${key}" is required (number).`);
    return def;
  }
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !isFinite(n)) fail(`"${key}" must be a number, got ${JSON.stringify(v)}.`);
  if (n < min - 1e-9 || n > max + 1e-9) fail(`"${key}" must be between ${min} and ${max}, got ${n}.`);
  return n;
}
function strArg(args, key, { required = false, max = 4000 } = {}) {
  const v = args[key];
  if (v === undefined || v === null) { if (required) fail(`"${key}" is required (string).`); return undefined; }
  if (typeof v !== 'string') fail(`"${key}" must be a string.`);
  if (required && !v.trim()) fail(`"${key}" must not be empty.`);
  if (v.length > max) fail(`"${key}" is too long.`);
  return v;
}
function boolArg(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return fail(`"${key}" must be true or false.`);
}
function enumArg(args, key, values, def) {
  const v = args[key];
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase();
  if (!values.includes(s)) fail(`"${key}" must be one of: ${values.join(', ')}.`);
  return s;
}

function mediaArg(id, key = 'media_id') {
  if (typeof id !== 'string' || !id) fail(`"${key}" is required. Media ids are listed by get_project.`);
  const m = store.media(id);
  if (!m) fail(`Media "${id}" not found. Use get_project to see media ids (or import_media first).`);
  return m;
}
function clipArg(id) {
  if (typeof id !== 'string' || !id) fail('"clip_id" is required. Clip ids are listed by get_project.');
  const f = store.findClip(id);
  if (!f) fail(`Clip "${id}" not found (ids change after split/undo — call get_project).`);
  return f;
}
function audioTrackArg(id) {
  if (id === undefined) return undefined;
  if (id === 'new') return 'new';
  if (!store.project.audioTracks.find((t) => t.id === id)) {
    fail(`Audio track "${id}" not found. Existing: ${store.project.audioTracks.map((t) => t.id).join(', ')}, or "new".`);
  }
  return id;
}

const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ai(msg) { toast(`ИИ: ${msg}`, 'info', 2200); }

// ---------------------------------------------------------------------------
// Описание проекта для ассистента
// ---------------------------------------------------------------------------
function visibleMediaId(m) { return m && m.derived ? m.derived.from : m && m.id; }

function describeMedia(m) {
  const rt = store.runtime[m.id] || {};
  const o = {
    id: m.id, name: m.name, path: m.path, duration: r3(m.duration),
    has_video: !!m.hasVideo, has_audio: !!m.hasAudio,
  };
  if (m.hasVideo) { o.width = m.width; o.height = m.height; o.fps = r3(m.fps); o.video_codec = m.vcodec; }
  if (m.hasAudio) o.audio_codec = m.acodec;
  o.used_on_timeline = store.usageCount(m.id);
  if (rt.missing) o.missing = true;
  if (rt.status === 'proxy') o.preparing = r3(rt.progress || 0);
  return o;
}

function describeClip(c, kind, track = null) {
  const m = store.media(c.mediaId);
  const src = m && m.derived ? store.media(m.derived.from) : m;
  const o = {
    id: c.id, kind,
    media_id: visibleMediaId(m),
    media_name: src ? src.name : '(missing)',
    start: r3(c.start), end: r3(end(c)), duration: r3(len(c)),
    source_in: r3(c.in), source_out: r3(c.out),
    volume: r3(c.volume), muted: !!c.muted,
    fade_in: r3(c.fadeIn || 0), fade_out: r3(c.fadeOut || 0),
  };
  if (c.name) o.name = c.name;
  if (isReversed(c)) {
    const b = m.derived.out;
    o.reversed = true;
    o.source_in = r3(b - c.out); o.source_out = r3(b - c.in);
    o.reversed_range = [r3(m.derived.in), r3(b)];
  } else if (isFreeze(c)) {
    o.freeze = true;
    o.freeze_source_time = r3(m.derived.at);
    delete o.source_in; delete o.source_out;
  }
  if (kind === 'video' && c.transition) o.transition_in = { type: c.transition.type, duration: r3(c.transition.duration) };
  if (track) o.audio_track_id = track.id;
  if (c.link) o.link = c.link;                       // видео и его звук (связаны, двигаются вместе)
  if (kind === 'video' && c.noAudio) o.sound_on_audio_track = true;
  if (kind === 'audio' && c.stream) o.audio_stream = c.stream;
  if (kind === 'video' && Array.isArray(c.effects) && c.effects.length) o.effects = c.effects;
  if (kind === 'video' && c.fit === 'cover') o.fit = 'cover';
  if (store.busy[c.id]) o.processing = store.busy[c.id].label;
  return o;
}

function describeById(id) {
  const f = store.findClip(id);
  return f ? describeClip(f.clip, f.kind, f.track) : null;
}

const gapsR = (g) => g.map(([a, b]) => [r3(a), r3(b)]);

function projectSummary() {
  return {
    name: store.project.name, file_path: store.filePath, unsaved_changes: !!store.dirty,
    duration: r3(store.duration()), video_clips: store.project.videoClips.length,
    audio_clips: store.project.audioTracks.reduce((s, t) => s + t.clips.length, 0),
    media: Object.values(store.project.media).filter((m) => !m.hidden).length,
  };
}

function getProject() {
  const v = store.videoLayout().map((s) => describeClip(s.clip, 'video'));
  return {
    name: store.project.name,
    file_path: store.filePath,
    unsaved_changes: !!store.dirty,
    duration: r3(store.duration()),
    playhead: r3(store.time),
    aspect: store.project.aspect || 'auto', background: store.background(),
    can_undo: store.undoStack.length > 0,
    can_redo: store.redoStack.length > 0,
    media: Object.values(store.project.media).filter((m) => !m.hidden).map(describeMedia),
    video_track: { clips: v, gaps: gapsR(store.gaps('video')) },
    audio_tracks: store.project.audioTracks.map((t, i) => ({
      id: t.id, index: i + 1, name: store.trackName(t.id), muted: !!t.muted, volume: r3(t.volume ?? 1), solo: !!t.solo,
      clips: [...t.clips].sort((a, b) => a.start - b.start).map((c) => describeClip(c, 'audio', t)),
      gaps: gapsR(store.gaps(t.id)),
    })),
    transitions: store.transitions().map((x) => ({ from_clip: x.a.id, to_clip: x.b.id, type: x.type, duration: r3(x.d), at: r3(x.seam) })),
    transition_types: TRANSITIONS.map((t) => t.id),
    format: (() => { const f = store.sourceFormat(); return { width: f.width, height: f.height, fps: r3(f.fps) }; })(),
    export: exportStatus(),
  };
}

// ---------------------------------------------------------------------------
// Экспорт (идёт в фоне, состояние — здесь)
// ---------------------------------------------------------------------------
const CODECS = {
  av1: { gpu: 'av1_nvenc', cpu: 'libsvtav1' },
  hevc: { gpu: 'hevc_nvenc', cpu: 'libx265' },
  h264: { gpu: 'h264_nvenc', cpu: 'libx264' },
};
let exp = { state: 'idle' };
let expWaiters = [];

function exportStatus() {
  const e = exp;
  const o = { state: e.state };
  if (e.state === 'idle') return o;
  o.output = e.output;
  if (e.settings) {
    o.settings = { width: e.settings.width, height: e.settings.height, fps: e.settings.fps, encoder: e.settings.codec, quality: e.settings.quality };
  }
  if (e.state === 'running') {
    o.fraction = r3(e.fraction || 0);
    o.percent = Math.floor((e.fraction || 0) * 100);
    o.rendered_seconds = r3(e.time || 0);
    o.total_seconds = r3(e.duration);
    if (e.eta !== null && e.eta !== undefined) o.eta_seconds = Math.round(e.eta);
    if (e.speed) o.speed = e.speed;
    if (e.size) o.size_bytes = e.size;
    o.elapsed_seconds = r3((Date.now() - e.started) / 1000);
  } else if (e.state === 'done') {
    o.size_bytes = e.size; o.duration = r3(e.duration); o.elapsed_seconds = r3(e.elapsed);
  } else if (e.state === 'error') {
    o.error = e.error;
  }
  return o;
}

function finishExport(patch) {
  exp = { ...exp, ...patch };
  const w = expWaiters; expWaiters = [];
  w.forEach((fn) => fn());
}

async function exportVideo(args) {
  if (exp.state === 'running') fail('An export is already running. Use export_status or cancel_export.');
  if (store.duration() <= 0.01) fail('The timeline is empty — add clips first.');
  const missing = Object.values(store.project.media).filter((m) => (store.runtime[m.id] || {}).missing);
  if (missing.length) fail(`Some files are missing on disk: ${missing.map((m) => m.path).join('; ')}`);

  const codec = enumArg(args, 'codec', Object.keys(CODECS), 'av1');
  const quality = enumArg(args, 'quality', ['high', 'medium', 'compact'], 'high');
  const resolution = enumArg(args, 'resolution', ['source', '2160', '1440', '1080', '720'], 'source');
  const src = store.sourceFormat();
  const fps = numArg(args, 'fps', { min: 1, max: 240, def: src.fps });
  let output = strArg(args, 'path');
  if (output) {
    if (!isAbs(output)) fail('"path" must be an absolute path.');
    if (!/\.mp4$/i.test(output)) output += '.mp4';
  } else {
    output = await api.defaultExportPath(store.project.name || 'Видео');
  }
  if (!encoders) encoders = await api.encoders();
  const c = CODECS[codec];
  const enc = encoders && encoders[c.gpu] ? c.gpu : c.cpu;
  let width = src.width; let height = src.height;
  if (resolution !== 'source') { height = Number(resolution); width = even(height * (src.width / src.height)); }
  width = even(width); height = even(height);
  const settings = { width, height, fps, codec: enc, quality, output };

  if (store.playing) store.emit('request-pause');
  exp = { state: 'running', output, settings, started: Date.now(), fraction: 0, duration: store.duration() };
  const off = api.onExportProgress((p) => {
    if (exp.state !== 'running') return;
    Object.assign(exp, { fraction: p.fraction, time: p.time, duration: p.duration, eta: p.eta, speed: p.speed, size: p.size });
  });
  ai(`экспорт видео → ${fileName(output)}`);
  api.startExport(JSON.parse(JSON.stringify(store.project)), settings).then((r) => {
    off();
    if (r && r.ok) {
      finishExport({ state: 'done', output: r.output, size: r.size, duration: r.duration, elapsed: r.elapsed });
      toast(`ИИ: экспорт завершён — ${fileName(r.output)}`, 'success', 4000);
    } else if (r && r.cancelled) {
      finishExport({ state: 'cancelled' });
      toast('ИИ: экспорт отменён', 'info');
    } else {
      finishExport({ state: 'error', error: (r && r.error) || 'Unknown export error' });
      toast('ИИ: ошибка экспорта', 'error', 4000);
    }
  }).catch((e) => { off(); finishExport({ state: 'error', error: cleanErr(e) }); });
  return { started: true, ...exportStatus(), hint: 'Poll export_status (use wait: 60) until state is "done".' };
}

async function exportStatusTool(args) {
  const wait = numArg(args, 'wait', { min: 0, max: 120, def: 0 });
  if (exp.state === 'running' && wait > 0) {
    await Promise.race([new Promise((r) => expWaiters.push(r)), sleep(wait * 1000)]);
  }
  return exportStatus();
}

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------
function unsavedGuard(force) {
  const hasContent = store.duration() > 0 || Object.keys(store.project.media).length > 0;
  if (hasContent && (store.dirty || !store.filePath) && !force) {
    fail('The current project has unsaved changes (or was never saved to a file). Call save_project first, '
      + 'or pass force: true — but ask the user before discarding their work.');
  }
}

function needHooks(name) {
  if (!hooks || typeof hooks[name] !== 'function') fail(`This FF Montage window does not support ${name} yet.`);
  return hooks[name];
}

const TOOLS = {
  get_project: () => getProject(),

  async import_media(args) {
    const paths = args.paths;
    if (!Array.isArray(paths) || !paths.length) fail('"paths" must be a non-empty array of absolute file paths.');
    if (paths.length > 500) fail('Too many files at once (max 500).');
    const bad = paths.filter((p) => typeof p !== 'string' || !isAbs(p));
    if (bad.length) fail(`Paths must be absolute: ${bad.map((p) => JSON.stringify(p)).join(', ')}`);
    const failed = [];
    const exist = [];
    for (const p of paths) { if (await api.exists(p)) exist.push(p); else failed.push({ path: p, reason: 'file not found' }); }
    ai(`импорт файлов (${exist.length})`);
    if (exist.length) await importPaths(exist);
    const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
    const imported = [];
    for (const p of exist) {
      const m = Object.values(store.project.media).find((x) => !x.hidden && (norm(x.path) === norm(p)));
      if (m) imported.push(describeMedia(m));
      else failed.push({ path: p, reason: 'not a supported video/audio file (or unreadable)' });
    }
    return { imported, failed };
  },

  add_clip(args) {
    const m = mediaArg(args.media_id);
    if (m.hidden) fail('This media is an internal derived file; use the original media id.');
    const track = enumArg(args, 'track', ['video', 'audio']);
    if (!track) fail('"track" is required: "video" or "audio".');
    const sin = numArg(args, 'source_in', { min: 0, def: 0 });
    let sout = numArg(args, 'source_out', { min: 0, def: m.duration });
    if (sout > m.duration + 0.05) fail(`source_out ${sout} is beyond the file duration ${r3(m.duration)} s.`);
    sout = Math.min(sout, m.duration);
    if (sout - sin < MIN_CLIP - 1e-6) fail(`The fragment must be at least ${MIN_CLIP} s long (source_in < source_out ≤ ${r3(m.duration)}).`);
    const start = numArg(args, 'start', { min: 0 });
    let clip;
    if (track === 'video') {
      if (!m.hasVideo) fail(`"${m.name}" has no video — use track "audio".`);
      clip = store.insertVideoClip(m.id, start === undefined ? null : start, boolArg(args, 'insert') ? 'insert' : 'auto', { in: sin, out: sout }, { linkAudio: boolArg(args, 'separate_audio') === true });
    } else {
      if (!m.hasAudio) fail(`"${m.name}" has no sound — use track "video".`);
      const tid = audioTrackArg(strArg(args, 'audio_track_id'));
      clip = store.addAudioClip(m.id, start === undefined ? 0 : start, tid || null, { extra: { in: sin, out: sout } });
    }
    if (!clip) fail('Could not add the clip.');
    ai(`добавлен клип «${m.name}»`);
    const d = describeById(clip.id);
    const out = { clip: d };
    if (start !== undefined && Math.abs(d.start - start) > EPS) out.note = `The requested place was occupied; the clip was placed at ${d.start} s.`;
    return out;
  },

  update_clip(args) {
    const f = clipArg(args.clip_id);
    const c = f.clip;
    const m = store.media(c.mediaId);
    if (!m) fail('The clip media is missing.');
    if (store.busy[c.id]) fail('The clip is being processed (reverse/freeze), try again later.');
    let nin = c.in; let nout = c.out;
    const sIn = numArg(args, 'source_in', { min: 0 });
    const sOut = numArg(args, 'source_out', { min: 0 });
    if (sIn !== undefined || sOut !== undefined) {
      if (isFreeze(c)) fail('This is a freeze frame: change its length with "duration".');
      if (isReversed(c)) {
        const a = m.derived.in; const b = m.derived.out;
        const x = sIn ?? (b - c.out); const y = sOut ?? (b - c.in);
        if (x < a - EPS || y > b + EPS) fail(`Reversed clip can only be trimmed within the reversed range ${r3(a)}..${r3(b)} s (original file time).`);
        nin = Math.max(0, b - y); nout = Math.min(m.duration, b - x);
      } else {
        nin = sIn ?? c.in; nout = sOut ?? c.out;
        if (nout > m.duration + 0.05) fail(`source_out ${nout} is beyond the file duration ${r3(m.duration)} s.`);
        nout = Math.min(nout, m.duration);
      }
      if (nout - nin < MIN_CLIP - 1e-6) fail(`The clip must stay at least ${MIN_CLIP} s long (source_in < source_out).`);
    }
    const dur = numArg(args, 'duration', { min: MIN_CLIP });
    if (dur !== undefined) {
      if (nin + dur > m.duration + 0.01) fail(`Maximum duration for this clip is ${r3(m.duration - nin)} s (file length minus source_in).`);
      nout = Math.min(m.duration, nin + dur);
    }
    const volume = numArg(args, 'volume', { min: 0, max: 2 });
    const fadeIn = numArg(args, 'fade_in', { min: 0, max: 10 });
    const fadeOut = numArg(args, 'fade_out', { min: 0, max: 10 });
    const muted = boolArg(args, 'muted');
    const name = strArg(args, 'name', { max: 200 });
    const start = numArg(args, 'start', { min: 0 });
    const insert = boolArg(args, 'insert');
    let tid = strArg(args, 'audio_track_id');
    if (tid !== undefined && f.kind !== 'audio') fail('"audio_track_id" applies only to audio clips.');
    tid = audioTrackArg(tid);
    const lengthChanged = Math.abs(nin - c.in) > 1e-9 || Math.abs(nout - c.out) > 1e-9;

    // Аудио: на дорожке клипы не должны накладываться
    if (f.kind === 'audio' && (start !== undefined || lengthChanged || tid)) {
      const s = start ?? c.start; const e = s + (nout - nin);
      const target = tid === 'new' ? null : store.project.audioTracks.find((t) => t.id === (tid || f.track.id));
      const hit = target && target.clips.find((o) => o.id !== c.id && o.start < e - 1e-6 && end(o) > s + 1e-6);
      if (hit) fail(`The clip would overlap clip ${hit.id} (${r3(hit.start)}–${r3(end(hit))} s) on that audio track. Choose another start, trim it, or use audio_track_id "new".`);
    }

    store.mutate((p) => {
      const cur = store.findClip(c.id);
      if (!cur) return;
      const cc = cur.clip;
      cc.in = nin; cc.out = nout;
      if (volume !== undefined) cc.volume = volume;
      if (muted !== undefined) cc.muted = muted;
      if (fadeIn !== undefined) cc.fadeIn = fadeIn;
      if (fadeOut !== undefined) cc.fadeOut = fadeOut;
      if (name !== undefined) { if (name.trim()) cc.name = name.trim(); else delete cc.name; }
      if (cur.kind === 'video') {
        if (start !== undefined) placeVideo(p, cc, start, insert ? 'insert' : 'auto');
        else if (lengthChanged) placeVideo(p, cc, cc.start, 'insert'); // длиннее — следующие сдвигаются вправо
      } else {
        if (start !== undefined) cc.start = start;
        if (tid && tid !== cur.track.id) {
          let t = tid === 'new' ? null : p.audioTracks.find((x) => x.id === tid);
          if (!t) { t = newTrack(); p.audioTracks.push(t); }
          cur.track.clips = cur.track.clips.filter((x) => x.id !== cc.id);
          t.clips.push(cc);
        }
      }
    });
    ai('изменён клип');
    const d = describeById(c.id);
    const out = { clip: d };
    if (start !== undefined && Math.abs(d.start - start) > EPS) out.note = `The requested place was occupied; the clip is at ${d.start} s.`;
    if (lengthChanged && f.kind === 'video') {
      const g = store.gaps('video').find(([a]) => Math.abs(a - d.end) < 0.01);
      if (g) out.note = `${out.note ? `${out.note} ` : ''}A gap ${r3(g[0])}–${r3(g[1])} s follows the clip (close_gaps to remove).`;
    }
    return out;
  },

  split_clip(args) {
    const t = numArg(args, 'time', { min: 0, required: true });
    const cid = strArg(args, 'clip_id');
    let target;
    if (cid) {
      const f = clipArg(cid);
      target = f.clip;
      if (!(t > f.clip.start + MIN_CLIP - 1e-6 && t < end(f.clip) - MIN_CLIP + 1e-6)) {
        fail(`Time ${t} s is not inside clip ${cid} (${r3(f.clip.start)}–${r3(end(f.clip))} s) or is closer than ${MIN_CLIP} s to its edge.`);
      }
    } else {
      const seg = store.videoLayout().find((s) => t > s.start + MIN_CLIP / 2 && t < s.end - MIN_CLIP / 2);
      if (!seg) fail(`No video clip under ${t} s (or the time is too close to a clip edge). Pass clip_id to split an audio clip.`);
      target = seg.clip;
    }
    const before = new Set(store.project.videoClips.map((c) => c.id));
    for (const tr of store.project.audioTracks) for (const c of tr.clips) before.add(c.id);
    const n = store.splitAt(t, cid || null);
    if (!n) fail('Nothing was split (the cut is too close to the clip edge).');
    let right = store.project.videoClips.find((c) => !before.has(c.id));
    if (!right) for (const tr of store.project.audioTracks) right = right || tr.clips.find((c) => !before.has(c.id));
    ai(`разрез на ${r3(t)} с`);
    return { left: describeById(target.id), right: right ? describeById(right.id) : null };
  },

  delete_clip(args) {
    const f = clipArg(args.clip_id);
    if (store.busy[f.clip.id]) fail('The clip is being processed, try again later.');
    const ripple = !!boolArg(args, 'ripple');
    store.deleteClip(f.clip.id, { ripple });
    ai(ripple ? 'клип удалён со сдвигом' : 'клип удалён');
    return { deleted: f.clip.id, ripple, duration: r3(store.duration()) };
  },

  async reverse_clip(args) {
    const f = clipArg(args.clip_id);
    if (f.kind !== 'video') fail('Reverse works for video clips only.');
    if (isFreeze(f.clip)) fail('A freeze frame does not need reversing.');
    ai(isReversed(f.clip) ? 'обычное направление клипа' : 'реверс клипа');
    try {
      const r = await toggleReverse(f.clip.id);
      return { reversed: !!(r && r.reversed), clip: describeById(f.clip.id) };
    } catch (e) { return fail(cleanErr(e)); }
  },

  async freeze_frame(args) {
    const t = numArg(args, 'time', { min: 0, def: store.time });
    const d = numArg(args, 'duration', { min: MIN_CLIP, max: 60, def: 3 });
    if (t > store.videoEnd() + 0.02) fail(`Time ${t} s is after the end of the video track (${r3(store.videoEnd())} s).`);
    ai(`стоп-кадр на ${r3(t)} с`);
    let id;
    try { id = await freezeFrameAt(t, d); } catch (e) { fail(cleanErr(e)); }
    if (!id) fail('The freeze frame could not be inserted.');
    const clip = describeById(id);
    const out = { clip };
    if (Math.abs(clip.duration - d) > 0.01) out.note = `Duration was limited to ${clip.duration} s.`;
    return out;
  },

  set_transition(args) {
    const f = clipArg(args.clip_id);
    if (f.kind !== 'video') fail('Transitions exist only between video clips.');
    const ids = TRANSITIONS.map((t) => t.id);
    const type = enumArg(args, 'type', [...ids, 'none']);
    if (!type) fail(`"type" is required: one of ${ids.join(', ')} or "none".`);
    if (type === 'none') {
      store.setTransition(f.clip.id, null);
      ai('переход убран');
      return { removed: true, clip_id: f.clip.id };
    }
    const j = store.junctionBefore(f.clip.id);
    if (!j) {
      const list = store.project.videoClips;
      const i = list.findIndex((c) => c.id === f.clip.id);
      if (i <= 0) fail('This is the first video clip — a transition needs a previous clip. clip_id must be the SECOND clip of the junction.');
      const prev = list[i - 1];
      fail(`There is a gap of ${r3(f.clip.start - end(prev))} s between clip ${prev.id} and this clip. Close it first (close_gaps track "video").`);
    }
    const dur = numArg(args, 'duration', { min: TR_MIN, max: TR_MAX });
    store.setTransition(f.clip.id, type, dur ?? null);
    const b = store.project.videoClips.find((c) => c.id === f.clip.id);
    if (!b || !b.transition) fail(`The clips are too short for a transition (each must be at least ${TR_MIN} s).`);
    ai(`переход «${(TRANSITIONS.find((t) => t.id === type) || {}).name || type}»`);
    const out = { transition: { from_clip: j.a.id, to_clip: b.id, type: b.transition.type, duration: r3(b.transition.duration), at: r3(b.start) } };
    if (dur !== undefined && Math.abs(b.transition.duration - dur) > EPS) out.note = `Duration limited to ${r3(b.transition.duration)} s by the clip lengths.`;
    return out;
  },

  close_gaps(args) {
    const lane = strArg(args, 'track', { required: true });
    if (lane !== 'video' && !store.project.audioTracks.find((t) => t.id === lane)) {
      fail(`"track" must be "video" or an audio track id (${store.project.audioTracks.map((t) => t.id).join(', ')}).`);
    }
    const t = numArg(args, 'time', { min: 0 });
    if (t !== undefined) {
      const shift = store.closeGap(lane, t);
      if (!shift) fail(`No gap at ${t} s on this track. Gaps: ${JSON.stringify(gapsR(store.gaps(lane)))}`);
      ai('пустота убрана');
      return { closed: 1, shift: r3(shift), gaps_left: gapsR(store.gaps(lane)), duration: r3(store.duration()) };
    }
    const n = store.closeAllGaps(lane);
    if (n) ai(`убрано пустот: ${n}`);
    return { closed: n, gaps_left: gapsR(store.gaps(lane)), duration: r3(store.duration()) };
  },

  undo() {
    const ok = store.undo();
    if (ok) ai('отмена');
    return { done: ok, ...(ok ? {} : { note: 'Nothing to undo.' }), can_undo: store.undoStack.length > 0, can_redo: store.redoStack.length > 0 };
  },

  redo() {
    const ok = store.redo();
    if (ok) ai('повтор');
    return { done: ok, ...(ok ? {} : { note: 'Nothing to redo.' }), can_undo: store.undoStack.length > 0, can_redo: store.redoStack.length > 0 };
  },

  set_playhead(args) {
    const t = numArg(args, 'time', { min: 0, required: true });
    if (store.playing) store.emit('request-pause');
    store.setTime(t);
    return { playhead: r3(store.time), duration: r3(store.duration()) };
  },

  async new_project(args) {
    const name = strArg(args, 'name', { max: 200 });
    unsavedGuard(!!boolArg(args, 'force'));
    ai('новый проект');
    await needHooks('newProject')(name && name.trim() ? name.trim() : undefined);
    if (name && name.trim() && store.project.name !== name.trim()) { store.project.name = name.trim(); store.emit('project'); }
    return projectSummary();
  },

  async open_project(args) {
    const p = strArg(args, 'path', { required: true });
    if (!isAbs(p)) fail('"path" must be an absolute path to a .ffproj file.');
    unsavedGuard(!!boolArg(args, 'force'));
    let r;
    try { r = await api.readProject(p); } catch (e) { fail(`Cannot read ${p}: ${cleanErr(e)}`); }
    ai(`открывается проект ${fileName(p)}`);
    try { await needHooks('loadProjectText')(r.text, r.filePath); } catch (e) { if (e instanceof ToolError) throw e; fail(`Not a valid FF Montage project: ${cleanErr(e)}`); }
    const missing = Object.values(store.project.media).filter((m) => !m.hidden && (store.runtime[m.id] || {}).missing).map((m) => m.path);
    return { ...projectSummary(), ...(missing.length ? { missing_files: missing } : {}) };
  },

  async save_project(args) {
    let p = strArg(args, 'path');
    if (p) {
      if (!isAbs(p)) fail('"path" must be an absolute path.');
      if (!/\.ffproj$/i.test(p)) p += '.ffproj';
    } else if (store.filePath) {
      p = store.filePath;
    } else {
      const info = await api.info();
      const safe = String(store.project.name || 'Проект').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Проект';
      const base = `${info.projectsDir}${info.sep}${safe}`;
      p = `${base}.ffproj`;
      for (let i = 2; await api.exists(p); i++) p = `${base} (${i}).ffproj`;
    }
    let saved;
    try { saved = await needHooks('saveProject')(p); } catch (e) { if (e instanceof ToolError) throw e; fail(`Save failed: ${cleanErr(e)}`); }
    if (!saved) fail('The project was not saved.');
    ai(`проект сохранён: ${fileName(saved)}`);
    return { path: saved };
  },

  export_video: exportVideo,
  export_status: exportStatusTool,

  async cancel_export() {
    const ok = await api.cancelExport();
    return { cancelled: !!ok, ...(ok ? {} : { note: 'No export was running.' }) };
  },

  async get_frame(args) {
    const width = Math.round(numArg(args, 'width', { min: 64, max: 1920, def: 640 }));
    let file; let at; let text;
    if (args.media_id !== undefined && args.media_id !== null) {
      const m = mediaArg(args.media_id);
      if (!m.hasVideo) fail(`"${m.name}" has no video.`);
      if ((store.runtime[m.id] || {}).missing) fail(`File not found on disk: ${m.path}`);
      const st = numArg(args, 'source_time', { min: 0, def: 0 });
      if (st > m.duration + 0.05) fail(`source_time ${st} is beyond the file duration ${r3(m.duration)} s.`);
      file = m.path; at = Math.min(st, Math.max(0, m.duration - 0.02));
      text = `Media ${m.id} "${m.name}" at ${r3(at)} s (${m.width}×${m.height}).`;
    } else {
      const t = numArg(args, 'time', { min: 0, required: true });
      const total = store.duration();
      if (t > total + 0.05) fail(`time ${t} s is after the end of the timeline (${r3(total)} s).`);
      const lay = store.videoLayout();
      let seg = lay.find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6);
      if (!seg && lay.length && Math.abs(t - lay[lay.length - 1].end) < 0.05) seg = lay[lay.length - 1];
      if (!seg) {
        return { __content: [{ type: 'text', text: `Timeline ${r3(t)} s: black frame — this is a gap on the video track (no video clip here).` }] };
      }
      const c = seg.clip;
      const m = store.media(c.mediaId);
      if (!m || (store.runtime[m.id] || {}).missing) fail('The file of this clip is missing on disk.');
      file = m.path;
      at = Math.min(Math.max(c.in + (t - c.start), c.in), c.out - 0.02);
      const src = m.derived ? store.media(m.derived.from) : m;
      const tr = store.transitions().find((x) => t >= x.from && t <= x.to);
      text = `Timeline ${r3(t)} s → video clip ${c.id}${c.name ? ` "${c.name}"` : ''} from "${src ? src.name : m.name}"`
        + `${isReversed(c) ? ' (reversed)' : ''}${isFreeze(c) ? ' (freeze frame)' : ''}, frame at ${r3(at)} s of the clip file. `
        + 'Raw source frame: fades and transitions are not applied.'
        + (tr ? ` Note: this moment is inside a ${tr.type} transition (${r3(tr.from)}–${r3(tr.to)} s).` : '');
    }
    let data;
    try { data = await api.fxFrame(file, at, width); } catch (e) { fail(`Could not decode the frame: ${cleanErr(e)}`); }
    return { __content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text }] };
  },

  async detect_silence(args) {
    const th = numArg(args, 'threshold_db', { min: -90, max: 0, def: -35 });
    const md = numArg(args, 'min_duration', { min: 0.05, max: 60, def: 0.5 });
    if (args.clip_id !== undefined && args.clip_id !== null) {
      const f = clipArg(args.clip_id);
      const c = f.clip;
      const m = store.media(c.mediaId);
      if (!m || !m.hasAudio) fail('This clip has no sound.');
      let list;
      try { list = await api.fxSilence(m.path, th, md); } catch (e) { fail(`Silence detection failed: ${cleanErr(e)}`); }
      const out = [];
      for (const s of list) {
        const a = Math.max(s.start, c.in);
        const b = Math.min(s.end === null || s.end === undefined ? m.duration : s.end, c.out);
        if (b - a < Math.min(md, 0.05)) continue;
        const o = { timeline_start: r3(c.start + (a - c.in)), timeline_end: r3(c.start + (b - c.in)), duration: r3(b - a) };
        if (!m.derived) { o.source_start = r3(a); o.source_end = r3(b); }
        out.push(o);
      }
      return {
        clip_id: c.id, threshold_db: th, min_duration: md, count: out.length,
        total_silence: r3(out.reduce((s, x) => s + x.duration, 0)), clip_duration: r3(len(c)), silences: out,
      };
    }
    const m = mediaArg(args.media_id, 'media_id (or clip_id)');
    if (!m.hasAudio) fail(`"${m.name}" has no sound.`);
    let list;
    try { list = await api.fxSilence(m.path, th, md); } catch (e) { fail(`Silence detection failed: ${cleanErr(e)}`); }
    const out = list.map((s) => {
      const e = s.end === null || s.end === undefined ? m.duration : s.end;
      return { start: r3(s.start), end: r3(e), duration: r3(e - s.start) };
    });
    return {
      media_id: m.id, threshold_db: th, min_duration: md, count: out.length,
      total_silence: r3(out.reduce((s, x) => s + x.duration, 0)), media_duration: r3(m.duration), silences: out,
    };
  },
};

// Быстрые и безопасные — без очереди (export_status может ждать, cancel_export должен сработать сразу)
const UNQUEUED = new Set(['export_status', 'cancel_export']);
let chain = Promise.resolve();
function queued(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function runTool(tool, args) {
  const fn = TOOLS[tool];
  if (!fn) fail(`Unknown tool: ${tool}`);
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return UNQUEUED.has(tool) ? fn(a) : queued(() => fn(a));
}

// ---------------------------------------------------------------------------
// Подключение
// ---------------------------------------------------------------------------
export function isMcpBridgeReady() { return inited; }

export function initMcpBridge({ loadProjectText, newProject, saveProject } = {}) {
  hooks = { loadProjectText, newProject, saveProject };
  if (inited) return;
  if (!api || typeof api.onMcpCall !== 'function') { console.warn('MCP: preload API missing'); return; }
  inited = true;
  api.onMcpCall(async ({ id, tool, args }) => {
    try {
      const result = await runTool(tool, args);
      api.mcpResult(id, { result: result === undefined ? null : result });
    } catch (e) {
      if (!(e instanceof ToolError)) console.error('MCP tool', tool, e);
      api.mcpResult(id, { error: cleanErr(e) });
    }
  });
  // Сообщаем главному процессу, что окно готово принимать команды
  api.mcpResult('__ready__', { ready: true });
}

// ---------------------------------------------------------------------------
// Окно «ИИ-ассистент (MCP)»
// ---------------------------------------------------------------------------
async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px' } });
    ta.value = text; document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? 'Скопировано' : 'Не удалось';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
  if (!ok) toast('Не удалось скопировать — выделите текст и нажмите Ctrl+C', 'error');
}

function codeBlock(text, wrap = false) {
  const btn = h('button', { class: 'btn ghost small', onclick: () => copyText(text, btn) }, 'Скопировать');
  return h('div', { style: { position: 'relative', margin: '6px 0 14px' } },
    h('pre', {
      style: {
        margin: 0, padding: '10px 12px', paddingRight: '110px', background: 'rgba(0,0,0,.35)', border: '1px solid var(--line-2, #333)',
        borderRadius: '8px', fontSize: '12px', lineHeight: '1.45', overflow: 'auto', maxHeight: '320px',
        whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-all' : 'normal',
        userSelect: 'text', fontFamily: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace',
      },
    }, text),
    h('div', { style: { position: 'absolute', top: '8px', right: '8px' } }, btn));
}

const section = (title) => h('h3', { style: { margin: '16px 0 4px', fontSize: '14px', fontWeight: '600' } }, title);

export async function showMcpDialog() {
  if (document.getElementById('mcp-dialog')) return;
  let info;
  try { info = await api.mcpInfo(); } catch (e) { toast(`ИИ-ассистент недоступен: ${cleanErr(e)}`, 'error', 5000); return; }

  const overlay = h('div', { class: 'modal-overlay', id: 'mcp-dialog' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };

  const status = info.running
    ? h('p', { class: 'small', style: { color: '#7ee2a8' } }, '● Канал управления включён — ассистент сможет подключиться к этому окну.')
    : h('p', { class: 'small', style: { color: '#ff9aa4' } }, '● Канал управления не запущен — перезапустите FF Montage.');

  const examples = [
    'Импортируй все видео из папки D:\\Записи\\Отпуск и собери из них ролик по порядку, между клипами — растворение.',
    'Найди паузы длиннее секунды в клипе с интервью и вырежи их.',
    'Положи музыку C:\\Music\\track.mp3 на всю длину ролика, громкость 40 %, затухание в конце 3 секунды.',
    'Покажи, что на 1:20, и сделай там стоп-кадр на 2 секунды.',
    'Сохрани проект и экспортируй в 1080p H.264.',
  ];

  overlay.append(h('div', { class: 'modal', style: { width: '760px' } },
    h('div', { class: 'modal-head' }, h('h2', {}, 'ИИ-ассистент (MCP)'),
      h('button', { class: 'icon-btn', title: 'Закрыть', onclick: close, html: icon('close', 18) })),
    h('div', { class: 'modal-body' },
      h('p', {}, 'MCP (Model Context Protocol) — открытый стандарт, по которому ИИ-ассистенты подключают внешние программы. '
        + 'Подключите FF Montage к Claude Desktop, Cursor, VS Code или Claude Code — и ассистент сможет по вашей просьбе '
        + 'импортировать файлы, резать и переставлять клипы, ставить переходы, «смотреть» кадры, искать паузы и экспортировать ролик.'),
      status,
      section('Claude Desktop, Cursor и другие клиенты'),
      h('p', { class: 'muted small' }, 'Claude Desktop: Settings → Developer → Edit Config (файл claude_desktop_config.json). '
        + 'Cursor: файл ~/.cursor/mcp.json (или .cursor/mcp.json в папке проекта). '
        + 'Если в файле уже есть "mcpServers" — добавьте внутрь только блок "ff-montage". После правки перезапустите клиент.'),
      codeBlock(info.configJson),
      section('VS Code (.vscode/mcp.json)'),
      codeBlock(info.vscodeJson),
      section('Claude Code (командная строка)'),
      codeBlock(info.claudeCodeCommand, true),
      h('p', { class: 'muted small' }, `Сервер: ${info.serverScript}${info.serverExists ? '' : ' — файл не найден!'}`),
      h('p', { class: 'muted small' }, 'Если FF Montage закрыт, ассистент запустит программу сам.'),
      section('Что можно попросить'),
      h('ul', { class: 'muted small', style: { margin: '4px 0 0', paddingLeft: '20px', lineHeight: '1.6' } }, ...examples.map((x) => h('li', {}, `«${x}»`))),
      h('div', {
        style: {
          marginTop: '16px', padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px', lineHeight: '1.5',
          background: 'rgba(255,190,80,.08)', border: '1px solid rgba(255,190,80,.35)', color: '#f3d7a2',
        },
      },
      h('b', {}, 'Важно. '),
      'Ассистент меняет открытый проект: добавляет и удаляет клипы, может открыть другой проект или запустить экспорт. '
        + 'Каждое его действие видно на таймлайне и отмечается уведомлением «ИИ: …»; любую правку можно отменить Ctrl+Z. '
        + 'Несохранённый проект ассистент без явного разрешения не закроет. Команды принимаются только с этого компьютера '
        + 'и только с секретным ключом, который лежит в папке кэша программы.')),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn primary', onclick: close }, 'Готово'))));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}
