// Состояние проекта: данные, отмена/повтор, производные значения и операции монтажа.
import { uid, clamp, snapFps } from './util.js';
import { t } from './i18n.js';
import { speedOf, tlLen, clipEnd, srcAt, tlAt, MIN_SPEED, MAX_SPEED } from './clipTime.js';
import { newAudioFx } from './audioFx.js';
import { MIN_DURATION as TR_MIN, MAX_DURATION as TR_MAX, DEFAULT_DURATION as TR_DEFAULT } from './transitions.js';
import { cleanTransform } from './transform.js';
import { isText, cleanText, textTitle, TEXT_MAX, TEXT_DEFAULT_DUR } from './textModel.js';
import { cleanSubStyle } from './subtitles.js';
import { cleanLayout, cleanRoute, isDefaultRoute, streamChannels, channelCount } from './audioLayout.js';
// Циклический импорт безопасен: editOps использует экспорты store.js только при вызове функций
import { rippleShift, snapFrame } from './editOps.js';

export const MIN_CLIP = 0.1;   // минимальная длина клипа, с
export const ADJ = 0.002;      // допуск «стоят впритык», с
export const MAX_FADE = 10;    // максимум затухания, с

// Форматы кадра проекта: ширина / высота ('auto' — как у видео)
export const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };
const even2 = (x) => Math.max(2, Math.round(x / 2) * 2);

// Длина и конец клипа НА ТАЙМЛАЙНЕ (с учётом скорости). in/out — время файла.
const len = tlLen;
const end = clipEnd;
const byStart = (a, b) => a.start - b.start;

// Модель проекта (версия 2):
//   media        { [id]: сведения о файле из ffprobe; derived — файл, сделанный программой (реверс, стоп-кадр) }
//   videoClips   [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name?, transition?, speed? }]
//                in/out — фрагмент файла; на таймлайне клип длится (out − in) / speed (см. clipTime.js)
//                основная дорожка: клипы по времени, без наложений, между ними могут быть пустоты.
//                transition = { type, duration } — переход из предыдущего клипа (если стоят впритык)
//   audioTracks  [{ id, name?, muted, solo?, volume?, route?, clips: [{ id, mediaId, in, out, start, volume, muted, fadeIn, fadeOut, name?, stream?, channel?, link? }] }]
//   videoName    имя видеодорожки (по умолчанию «Видео»)
//   audioLayout? раскладка каналов проекта { kind: 'mono'|'5.1'|'7.1'|'multi', channels } (0.5.1; нет — стерео)
//   videoRoute?  каналы проекта для звука видеоклипов; route дорожки — [L, R] или [моно] (номера с 0; нет — по умолчанию)
//   channel      клип играет один канал потока файла (моно; «Разложить по каналам») — см. audioLayout.js
//
// Связь видео и звука: при добавлении видео его звук (каждый звуковой поток файла) ложится отдельными клипами
// на аудиодорожки с тем же link, а у видеоклипа ставится noAudio. Связанный звук всегда синхронен видео
// по времени файла (syncLinks): двигаем видео — едет и звук; разрезаем/удаляем — вместе.
// stream — номер звукового потока файла (0 — первый).
export const newTrack = (extra = {}) => ({ id: uid('trk'), muted: false, solo: false, volume: 1, clips: [], ...extra });

// Видеодорожки (M4). Основная V1 — p.videoClips (снизу; под ней фон проекта, у неё videoName/videoHidden/videoLocked).
// Верхние — p.videoTracks [{ id, name?, hidden?, locked?, clips }]: порядок = z, последняя — сверху; пустоты прозрачные.
// Правила у всех одинаковые: клипы по времени без наложений, переходы — только внутри дорожки.
// У клипа любой видеодорожки: transform { x, y, scale, rotate, opacity } (transform.js) и crop { l, t, r, b }.
// hidden — дорожку не видно (в плеере и в экспорте; звук её клипов остаётся), locked — клипы нельзя двигать и менять мышью.
export const MAIN_LANE = 'video';
export const newVideoTrack = (extra = {}) => ({ id: uid('vtk'), clips: [], ...extra });

// Все видеодорожки снизу вверх: { id, main, track, clips (чтение и запись), hidden, locked }
export function vlanes(p) {
  const main = {
    id: MAIN_LANE, main: true, track: null,
    get clips() { return p.videoClips; }, set clips(v) { p.videoClips = v; },
    get hidden() { return !!p.videoHidden; }, get locked() { return !!p.videoLocked; },
  };
  return [main, ...(p.videoTracks || []).map((tr) => ({
    id: tr.id, main: false, track: tr,
    get clips() { return tr.clips; }, set clips(v) { tr.clips = v; },
    get hidden() { return !!tr.hidden; }, get locked() { return !!tr.locked; },
  }))];
}
export const vlane = (p, id) => vlanes(p).find((l) => l.id === (id || MAIN_LANE)) || null;
// Дорожка, на которой лежит клип (объект клипа или его id)
export function vlaneOf(p, clip) {
  const id = typeof clip === 'string' ? clip : clip && clip.id;
  return vlanes(p).find((l) => l.clips.some((c) => c === clip || c.id === id)) || null;
}
export const allVideo = (p) => [...(p.videoClips || []), ...(p.videoTracks || []).flatMap((tr) => tr.clips || [])];

// Текстовые клипы (M5.1) лежат на видеодорожках: { id, kind: 'text', in: 0, out: длина, start, fadeIn, fadeOut, text, transform?, transition? }
// (без mediaId, звука и скорости). Оформление — textModel.js, отрисовка — textRender.js.
// Дорожки субтитров (M5.5): p.subtitleTracks [{ id, name?, hidden?, locked?, style, cues: [{ id, start, end, text }] }] —
// реплики по времени (могут перекрываться), стиль — subtitles.js cleanSubStyle; на экспорт — один .ass (libass) или мягкие субтитры.
export const newSubtitleTrack = (extra = {}) => ({ id: uid('stk'), style: cleanSubStyle({}), cues: [], ...extra });
export const MIN_CUE = 0.1;
const cueTime = (x) => Math.round(Math.max(0, Number(x) || 0) * 1000) / 1000;
export function fixCues(cues) {
  const out = [];
  for (const c of Array.isArray(cues) ? cues : []) {
    if (!c || typeof c !== 'object') continue;
    const start = cueTime(c.start);
    const end = Math.max(start + MIN_CUE, cueTime(c.end));
    const text = String(c.text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000);
    out.push({ id: typeof c.id === 'string' && c.id ? c.id : uid('cue'), start, end: Math.round(end * 1000) / 1000, text });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
function fixSubTracks(s) {
  const list = Array.isArray(s.subtitleTracks) ? s.subtitleTracks.filter((x) => x && typeof x === 'object') : [];
  for (const tr of list) {
    if (!tr.id) tr.id = uid('stk');
    tr.style = cleanSubStyle(tr.style || {});
    tr.cues = fixCues(tr.cues);
    if (tr.hidden) tr.hidden = true; else delete tr.hidden;
    if (tr.locked) tr.locked = true; else delete tr.locked;
    if (typeof tr.name !== 'string' || !tr.name.trim()) delete tr.name;
    if (!/^[a-z]{2,3}$/.test(tr.lang || '')) delete tr.lang;
  }
  if (list.length) s.subtitleTracks = list; else delete s.subtitleTracks;
}
export const subsEnd = (p) => (p.subtitleTracks || []).reduce((e, tr) => tr.cues.reduce((x, c) => Math.max(x, c.end), e), 0);

export function emptyProject() {
  return {
    version: 2,
    name: t('Мой ролик'),
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
    if (c.kind === 'text') {
      c.text = cleanText(c.text);
      const d = Math.min(TEXT_MAX, Math.max(MIN_CLIP, (Number(c.out) || 0) - (Number(c.in) || 0)) || TEXT_DEFAULT_DUR);
      c.in = 0; c.out = d; c.muted = true;
      delete c.mediaId; delete c.speed; delete c.link; delete c.noAudio; delete c.crop; delete c.fit; delete c.effects; delete c.afx;
    } else if (c.kind !== undefined) delete c.kind;
  };
  const fixTracks = (tracks) => {
    for (const t of tracks) {
      if (!t.id) t.id = uid('trk');
      t.muted = !!t.muted; t.solo = !!t.solo;
      if (t.locked) t.locked = true; else delete t.locked;
      t.volume = isFinite(t.volume) ? Number(t.volume) : 1;
      t.clips = t.clips || []; t.clips.forEach(fix);
      // 0.5.1: каналы проекта, куда идёт дорожка (audioLayout.js); по умолчанию — без поля
      if (t.route !== undefined && isDefaultRoute(t.route, p)) delete t.route;
      else if (t.route !== undefined) t.route = cleanRoute(t.route, p);
      for (const c of t.clips) if (c.channel !== undefined && !(Number.isInteger(c.channel) && c.channel >= 0 && c.channel < 64)) delete c.channel;
    }
  };
  // 0.5.1: раскладка каналов проекта и маршрут звука видео
  const lay = cleanLayout(p.audioLayout);
  if (lay) p.audioLayout = lay; else delete p.audioLayout;
  if (p.videoRoute !== undefined && isDefaultRoute(p.videoRoute, p)) delete p.videoRoute;
  else if (p.videoRoute !== undefined) p.videoRoute = cleanRoute(p.videoRoute, p);
  // Верхние видеодорожки; бывшая дорожка «Наложения» (0.3.x, overlayClips) становится верхней видеодорожкой
  const fixVTracks = (s) => {
    const list = Array.isArray(s.videoTracks) ? s.videoTracks : [];
    if (Array.isArray(s.overlayClips) && s.overlayClips.length) list.push({ id: uid('vtk'), name: t('Наложения'), clips: s.overlayClips });
    delete s.overlayClips;
    s.videoTracks = list.filter((tr) => tr && typeof tr === 'object');
    for (const tr of s.videoTracks) {
      if (!tr.id) tr.id = uid('vtk');
      tr.clips = Array.isArray(tr.clips) ? tr.clips : [];
      tr.clips.forEach(fix);
      if (tr.hidden) tr.hidden = true; else delete tr.hidden;
      if (tr.locked) tr.locked = true; else delete tr.locked;
    }
    if (!s.videoTracks.length) delete s.videoTracks;
  };
  // Метки In/Out (0.4.3): { in?, out? } — секунды таймлайна открытого эпизода
  const fixMarks = (s) => {
    const m = s.marks && typeof s.marks === 'object' ? s.marks : {};
    const ok = (x) => typeof x === 'number' && isFinite(x) && x >= 0;
    const out = {};
    if (ok(m.in)) out.in = m.in;
    if (ok(m.out)) out.out = m.out;
    if (out.in !== undefined && out.out !== undefined && out.out < out.in) [out.in, out.out] = [out.out, out.in];
    if (Object.keys(out).length) s.marks = out; else delete s.marks;
  };
  p.videoClips.forEach(fix);
  fixVTracks(p);
  fixTracks(p.audioTracks);
  fixSubTracks(p);
  fixMarks(p);
  // Эпизоды (кроме открытого) хранят своё содержимое сами
  if (Array.isArray(p.episodes) && p.episodes.length) {
    if (!p.episodes.some((e) => e.id === p.activeEpisode)) p.activeEpisode = p.episodes[0].id;
    for (const e of p.episodes) {
      if (e.id === p.activeEpisode) { delete e.videoClips; delete e.audioTracks; delete e.videoTracks; delete e.overlayClips; delete e.subtitleTracks; continue; }
      e.videoClips = e.videoClips || []; e.videoClips.forEach(fix);
      fixVTracks(e);
      fixSubTracks(e);
      fixMarks(e);
      e.audioTracks = e.audioTracks && e.audioTracks.length ? e.audioTracks : [newTrack()];
      fixTracks(e.audioTracks);
    }
  } else { delete p.episodes; delete p.activeEpisode; }
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
  const fades = (c) => {
    const d = len(c);
    c.fadeIn = clamp(c.fadeIn || 0, 0, Math.min(MAX_FADE, d));
    c.fadeOut = clamp(c.fadeOut || 0, 0, Math.min(MAX_FADE, d - c.fadeIn));
  };
  for (const t of p.audioTracks) t.clips.forEach(fades);
  for (const lane of vlanes(p)) {
    const list = lane.clips;
    list.sort(byStart);
    list.forEach(fades);
    list.forEach((c, i) => {
      // Текст: in всегда 0 (обрезка слева у текста просто укорачивает/удлиняет клип)
      if (isText(c) && c.in) { c.out = Math.max(MIN_CLIP, c.out - c.in); c.in = 0; }
      if (c.transform) { const tf = cleanTransform(c.transform); if (tf) c.transform = tf; else delete c.transform; }
      if (!c.transition) return;
      const prev = list[i - 1];
      // Неизвестный тип не удаляем: это может быть переход пропавшего (выключенного) плагина — экспорт заменит его растворением
      if (!prev || Math.abs(end(prev) - c.start) > ADJ || typeof c.transition.type !== 'string' || !c.transition.type) { delete c.transition; return; }
      const mx = maxTransition(prev, c);
      if (mx < TR_MIN) { delete c.transition; return; }
      c.transition.duration = clamp(Number(c.transition.duration) || TR_DEFAULT, TR_MIN, mx);
    });
  }
}

// Связанный звук ставится по видео: тот же момент файла — тот же момент таймлайна
export function syncLinks(p) {
  const vmap = new Map();
  for (const v of allVideo(p)) if (v.link) vmap.set(v.link, v);
  for (const t of p.audioTracks) {
    for (const c of t.clips) {
      if (!c.link) continue;
      const v = vmap.get(c.link);
      if (!v || v.mediaId !== c.mediaId) { delete c.link; continue; }
      // Скорость у связанного звука та же, что у видео
      if (speedOf(v) !== 1) c.speed = speedOf(v); else delete c.speed;
      const sv = speedOf(v);
      let s = tlAt(v, c.in);
      if (s < 0) { c.in = Math.min(c.out - MIN_CLIP * sv, c.in - s * sv); s = tlAt(v, c.in); }
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
        const right = { ...JSON.parse(JSON.stringify(c)), id: uid('clp'), in: srcAt(c, e), start: e, fadeIn: 0 };
        delete right.transition;
        if (c.link) right.link = splitLink(c.link, e);
        out.push(right);
      }
      if (s - cs >= MIN_CLIP / 2) { c.out = srcAt(c, s); c.fadeOut = 0; out.push(c); }
    } else if (ce > e + ADJ && ce - e >= MIN_CLIP / 2) {
      c.in = srcAt(c, e); c.start = e; c.fadeIn = 0; delete c.transition; out.push(c);
    }
  }
  return out;
}

// Наложение: клип clip (уже лежит на своей видеодорожке) ставится в start и «затирает» то, что под ним, —
// и на этой видеодорожке, и звук под ним (звук затёртых видео и свой связанный звук на его дорожках)
export function overwriteVideo(p, clip, start) {
  clip.start = Math.max(0, start);
  const s = clip.start; const e = end(clip);
  const lane = vlaneOf(p, clip) || vlane(p, MAIN_LANE);
  if (!lane.clips.includes(clip)) lane.clips.push(clip);
  const hitLinks = new Set(lane.clips.filter((c) => c !== clip && c.link && c.start < e - ADJ && end(c) > s + ADJ).map((c) => c.link));
  lane.clips = carve(lane.clips, s, e, (c) => c === clip);
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
// laneId — видеодорожка (по умолчанию та, где клип уже лежит, иначе основная); клип с другой дорожки переносится.
export function placeVideo(p, clip, desired, mode = 'auto', laneId = null) {
  const lane = (laneId && vlane(p, laneId)) || vlaneOf(p, clip) || vlane(p, MAIN_LANE);
  for (const l of vlanes(p)) if (l.id !== lane.id && l.clips.some((c) => c === clip || c.id === clip.id)) l.clips = l.clips.filter((c) => c !== clip && c.id !== clip.id);
  const others = lane.clips.filter((c) => c !== clip && c.id !== clip.id).sort(byStart);
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
  if (!lane.clips.includes(clip)) lane.clips.push(clip);
  lane.clips.sort(byStart);
  return clip.start;
}

// Перенести клип на другую видеодорожку (объект клипа остаётся тем же)
export function moveToLane(p, clip, laneId) {
  const to = vlane(p, laneId);
  if (!to) return false;
  for (const l of vlanes(p)) if (l.id !== to.id && l.clips.includes(clip)) l.clips = l.clips.filter((c) => c !== clip);
  if (!to.clips.includes(clip)) to.clips.push(clip);
  return true;
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
  select(sel) { this.selection = sel && sel.kind === 'overlay' ? { ...sel, kind: 'video' } : sel; this.emit('selection'); }
  validateSelection() {
    const s = this.selection;
    if (!s) return;
    let ok = s.kind === 'track' ? this.project.audioTracks.some((t) => t.id === s.id)
      : s.kind === 'vtrack' ? !!vlane(this.project, s.id)
        : s.kind === 'cue' ? !!this.findCue(s.id)
          : s.kind === 'strack' ? !!this.subtitleTrack(s.id) : !!this.findClip(s.id);
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

  // Видеодорожки снизу вверх (см. vlanes): основная — id 'video'
  vlanes() { return vlanes(this.project); }
  vlane(id) { return vlane(this.project, id); }
  videoTracks() { return this.project.videoTracks || []; }
  allVideo() { return allVideo(this.project); }

  // Клипы видеодорожки по времени: [{ clip, index, start, end }] (по умолчанию — основной)
  videoLayout(laneId = MAIN_LANE) {
    const lane = vlane(this.project, laneId);
    return lane ? [...lane.clips].sort(byStart).map((c, index) => ({ clip: c, index, start: c.start, end: end(c) })) : [];
  }
  // Конец основной видеодорожки (новые клипы по умолчанию встают туда)
  videoEnd() { return this.project.videoClips.reduce((s, c) => Math.max(s, end(c)), 0); }
  // Конец верхних видеодорожек
  upperEnd() { return this.videoTracks().reduce((s, tr) => tr.clips.reduce((x, c) => Math.max(x, end(c)), s), 0); }
  audioEnd() {
    let e = 0;
    for (const t of this.project.audioTracks) for (const c of t.clips) e = Math.max(e, end(c));
    return e;
  }
  duration() { return Math.max(this.videoEnd(), this.audioEnd(), this.upperEnd(), subsEnd(this.project)); }

  // --- Клипы поверх ролика (анимации и т.п.): на верхнюю видеодорожку, где в этом месте свободно ---
  laneFree(laneId, start, dur, exclude = null) {
    const lane = vlane(this.project, laneId);
    if (!lane) return false;
    return lane.clips.every((c) => c.id === exclude || end(c) <= start + ADJ || c.start >= start + dur - ADJ);
  }
  findOverlay(id) { const f = this.findClip(id); return f && f.kind === 'video' ? f.clip : null; }
  addOverlayClip(mediaId, at = this.time) {
    const m = this.media(mediaId);
    if (!m) return null;
    const clip = { ...this.newClip(mediaId), muted: true, start: Math.max(0, at) };
    const d = len(clip);
    this.mutate((p) => {
      const tracks = p.videoTracks || [];
      let tr = [...tracks].reverse().find((x) => !x.locked && x.clips.every((c) => end(c) <= clip.start + ADJ || c.start >= clip.start + d - ADJ));
      if (!tr) { tr = newVideoTrack(); p.videoTracks = [...tracks, tr]; }
      tr.clips.push(clip);
    });
    this.select({ kind: 'video', id: clip.id });
    return clip;
  }
  setOverlay(id, patch, opts) { this.setClip(id, patch, opts); }
  removeOverlay(id) { this.deleteClip(id); }

  // --- видеодорожки ---
  // Новая верхняя видеодорожка (над всеми или над дорожкой below); возвращает id
  addVideoTrack(below = null, extra = {}) {
    const tr = newVideoTrack(extra);
    this.mutate((p) => {
      const list = [...(p.videoTracks || [])];
      const i = below && below !== MAIN_LANE ? list.findIndex((x) => x.id === below) : (below === MAIN_LANE ? -1 : list.length - 1);
      list.splice(i + 1, 0, tr);
      p.videoTracks = list;
    });
    return tr.id;
  }
  // Удалить верхнюю видеодорожку (вместе с клипами и их связанным звуком)
  removeVideoTrack(id) {
    const tr = this.videoTracks().find((x) => x.id === id);
    if (!tr) return false;
    const links = new Set(tr.clips.map((c) => c.link).filter(Boolean));
    this.mutate((p) => {
      p.videoTracks = (p.videoTracks || []).filter((x) => x.id !== id);
      if (!p.videoTracks.length) delete p.videoTracks;
      if (links.size) for (const t of p.audioTracks) t.clips = t.clips.filter((c) => !c.link || !links.has(c.link));
    });
    return true;
  }
  // Поднять (+1) / опустить (−1) верхнюю видеодорожку; основная всегда снизу
  moveVideoTrack(id, dir) {
    const list = this.videoTracks();
    const i = list.findIndex((x) => x.id === id);
    const j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    this.mutate((p) => { const l = [...p.videoTracks]; [l[i], l[j]] = [l[j], l[i]]; p.videoTracks = l; });
    return true;
  }
  // hidden / locked / name у видеодорожки (основная — 'video')
  setVideoTrack(id, patch, opts) {
    this.mutate((p) => {
      const put = (o, k, v) => { if (v) o[k] = /name$/i.test(k) ? String(v) : true; else delete o[k]; };
      if (id === MAIN_LANE) {
        if (patch.name !== undefined) put(p, 'videoName', patch.name);
        if (patch.hidden !== undefined) put(p, 'videoHidden', patch.hidden);
        if (patch.locked !== undefined) put(p, 'videoLocked', patch.locked);
        return;
      }
      const tr = (p.videoTracks || []).find((x) => x.id === id);
      if (!tr) return;
      for (const k of ['name', 'hidden', 'locked']) if (patch[k] !== undefined) put(tr, k, patch[k]);
    }, opts);
  }

  // Название клипа для показа: своё имя → имя исходного файла (у реверса/стоп-кадра — имя оригинала)
  clipName(c) {
    if (c.name) return c.name;
    if (isText(c)) return textTitle(c) || t('Текст');
    const m = this.media(c.mediaId);
    if (!m) return '?';
    if (m.derived) { const src = this.media(m.derived.from); return src ? src.name : m.name; }
    return m.name;
  }

  // { kind: 'video', clip, lane } (lane — видеодорожка) или { kind: 'audio', clip, track }
  findClip(id) {
    for (const lane of vlanes(this.project)) {
      const v = lane.clips.find((c) => c.id === id);
      if (v) return { kind: 'video', clip: v, lane };
    }
    for (const t of this.project.audioTracks) {
      const a = t.clips.find((c) => c.id === id);
      if (a) return { kind: 'audio', clip: a, track: t };
    }
    return null;
  }

  // Стык перед видеоклипом id (на его дорожке): { a, b, seam, laneId } если предыдущий клип стоит впритык
  junctionBefore(id) {
    const lane = vlaneOf(this.project, id);
    if (!lane) return null;
    const list = lane.clips;
    const i = list.findIndex((c) => c.id === id);
    if (i <= 0) return null;
    const a = list[i - 1]; const b = list[i];
    return Math.abs(end(a) - b.start) <= ADJ ? { a, b, seam: b.start, laneId: lane.id } : null;
  }

  // Действующие переходы дорожки (по умолчанию — основной): [{ a, b, type, d, seam, from, to }]; laneId '*' — всех
  transitions(laneId = MAIN_LANE) {
    const out = [];
    for (const lane of laneId === '*' ? vlanes(this.project) : [vlane(this.project, laneId)].filter(Boolean)) {
      const list = lane.clips;
      for (let i = 1; i < list.length; i++) {
        const b = list[i];
        if (!b.transition) continue;
        const a = list[i - 1];
        const d = b.transition.duration;
        out.push({ a, b, type: b.transition.type, d, seam: b.start, from: b.start - d / 2, to: b.start + d / 2, laneId: lane.id });
      }
    }
    return out;
  }

  // Формат проекта по умолчанию — по самому крупному видео на таймлайне
  // (чтобы короткая заставка в 480p не уменьшила весь ролик), частота — максимальная
  sourceFormat() {
    // Сначала основная дорожка; если на ней пусто — верхние; иначе — все видео в медиатеке
    const ofClips = (clips) => clips.map((c) => this.media(c.mediaId)).filter((m) => m && m.hasVideo);
    let list = ofClips(this.project.videoClips);
    if (!list.length) list = ofClips(this.videoTracks().flatMap((tr) => tr.clips));
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
      for (const s of [p, ...(p.episodes || []).filter((e) => e.videoClips)]) {
        s.videoClips = s.videoClips.filter((c) => !ids.has(c.mediaId));
        for (const t of s.audioTracks || []) t.clips = t.clips.filter((c) => !ids.has(c.mediaId));
        for (const tr of s.videoTracks || []) tr.clips = tr.clips.filter((c) => !ids.has(c.mediaId));
      }
    });
  }

  usageCount(mediaId) {
    const ids = this.familyOf(mediaId);
    let n = 0;
    for (const s of [this.project, ...(this.project.episodes || []).filter((e) => e.videoClips)]) {
      n += s.videoClips.filter((c) => ids.has(c.mediaId)).length;
      for (const t of s.audioTracks || []) n += t.clips.filter((c) => ids.has(c.mediaId)).length;
      for (const tr of s.videoTracks || []) n += tr.clips.filter((c) => ids.has(c.mediaId)).length;
    }
    return n;
  }

  // ------------------------------------------------------------------------
  // Эпизоды: несколько таймлайнов в одном проекте (как вкладки таймлайнов в DaVinci).
  // Открытый эпизод лежит прямо в project.videoClips/audioTracks (весь остальной код работает с ним),
  // остальные хранят своё содержимое в project.episodes[i]. Первый — «Основной» (id 'main').
  // ------------------------------------------------------------------------
  episodes() { return this.project.episodes && this.project.episodes.length ? this.project.episodes : [{ id: 'main', name: t('Основной') }]; }
  activeEpisode() { return this.project.activeEpisode || 'main'; }
  episodeName(id) { const e = this.episodes().find((x) => x.id === id); return e ? e.name : ''; }

  ensureEpisodes(p) {
    if (!p.episodes || !p.episodes.length) p.episodes = [{ id: 'main', name: t('Основной') }];
    if (!p.activeEpisode) p.activeEpisode = 'main';
  }

  // Убрать открытый эпизод в хранилище, достать другой
  swapIn(p, id) {
    const cur = p.episodes.find((e) => e.id === p.activeEpisode);
    // Поля открытого эпизода, кроме клипов: имя и флаги основной видеодорожки, верхние видеодорожки
    const OWN = ['videoTracks', 'videoName', 'videoHidden', 'videoLocked', 'subtitleTracks', 'marks'];
    if (cur) {
      cur.videoClips = p.videoClips; cur.audioTracks = p.audioTracks; cur.time = this.time;
      for (const k of OWN) { if (p[k] !== undefined) cur[k] = p[k]; else delete cur[k]; }
    }
    const next = p.episodes.find((e) => e.id === id);
    p.videoClips = next.videoClips || [];
    p.audioTracks = next.audioTracks && next.audioTracks.length ? next.audioTracks : [newTrack()];
    for (const k of OWN) { if (next[k] !== undefined) p[k] = next[k]; else delete p[k]; }
    const t = next.time || 0;
    delete next.videoClips; delete next.audioTracks; delete next.time;
    for (const k of OWN) delete next[k];
    p.activeEpisode = id;
    return t;
  }

  switchEpisode(id) {
    if (id === this.activeEpisode() || !this.episodes().some((e) => e.id === id)) return false;
    this.emit('request-pause');
    let t = 0;
    this.mutate((p) => { this.ensureEpisodes(p); t = this.swapIn(p, id); }, { history: false });
    this.selection = null; this.emit('selection');
    this.setTime(t);
    this.emit('episodes');
    return true;
  }

  addEpisode(name = null) {
    const id = uid('ep');
    this.mutate((p) => {
      this.ensureEpisodes(p);
      const n = p.episodes.length;
      p.episodes.push({ id, name: name || t('Эпизод {n}', { n }), videoClips: [], audioTracks: [newTrack()] });
    });
    this.switchEpisode(id);
    return id;
  }

  renameEpisode(id, name) {
    name = String(name || '').trim();
    if (!name) return false;
    this.mutate((p) => { this.ensureEpisodes(p); const e = p.episodes.find((x) => x.id === id); if (e) e.name = name; });
    this.emit('episodes');
    return true;
  }

  removeEpisode(id) {
    if (id === 'main' || !this.episodes().some((e) => e.id === id)) return false;
    if (this.activeEpisode() === id) this.switchEpisode('main');
    this.mutate((p) => { p.episodes = p.episodes.filter((e) => e.id !== id); });
    this.emit('episodes');
    return true;
  }

  // Содержимое эпизода (копия): { videoClips, videoTracks, audioTracks }
  episodeContent(id) {
    const src = id === this.activeEpisode() ? this.project : this.episodes().find((e) => e.id === id);
    return JSON.parse(JSON.stringify({ videoClips: (src && src.videoClips) || [], videoTracks: (src && src.videoTracks) || [], audioTracks: (src && src.audioTracks) || [] }));
  }

  // Длительность эпизода
  episodeDuration(id) {
    const c = this.episodeContent(id);
    let e = 0;
    for (const v of allVideo(c)) e = Math.max(e, end(v));
    for (const t of c.audioTracks) for (const a of t.clips) e = Math.max(e, end(a));
    return e;
  }

  // Вставить эпизод src в эпизод dst (по умолчанию — в основной) начиная с at (по умолчанию — после конца
  // его видео). Клипы копируются с новыми id; звуковые дорожки — по порядку (1-я к 1-й…).
  // Видео, на место которого ложится эпизод, раздвигается вправо, чтобы ничего не затереть.
  insertEpisode(srcId, dstId = 'main', at = null) {
    if (srcId === dstId) return false;
    const content = this.episodeContent(srcId);
    if (!allVideo(content).length && !content.audioTracks.some((t) => t.clips.length)) return false;
    const linkMap = new Map();
    const reid = (c) => {
      c.id = uid('clp');
      if (c.link) { if (!linkMap.has(c.link)) linkMap.set(c.link, uid('lnk')); c.link = linkMap.get(c.link); }
      return c;
    };
    this.mutate((p) => {
      this.ensureEpisodes(p);
      const dst = dstId === p.activeEpisode ? p : p.episodes.find((e) => e.id === dstId);
      if (!dst) return;
      dst.videoClips = dst.videoClips || [];
      dst.audioTracks = dst.audioTracks && dst.audioTracks.length ? dst.audioTracks : [newTrack()];
      const vEnd = dst.videoClips.reduce((s, c) => Math.max(s, end(c)), 0);
      const start = at === null ? vEnd : Math.max(0, at);
      let dur = 0;
      for (const v of allVideo(content)) dur = Math.max(dur, end(v));
      for (const t of content.audioTracks) for (const a of t.clips) dur = Math.max(dur, end(a));
      dst.videoTracks = dst.videoTracks || [];
      // Раздвигаем то, что правее точки вставки (клип, на который попала точка, сначала разрезается)
      if (at !== null) {
        const cut = (list) => {
          const out = [];
          for (const c of list) {
            out.push(c);
            if (c.start < start - MIN_CLIP && end(c) > start + MIN_CLIP) {
              const right = { ...JSON.parse(JSON.stringify(c)), id: uid('clp'), in: srcAt(c, start), start, fadeIn: 0 };
              delete right.transition;
              if (c.link) right.link = splitLink(c.link, start);
              c.out = srcAt(c, start); c.fadeOut = 0;
              out.push(right);
            }
          }
          return out;
        };
        dst.videoClips = cut(dst.videoClips);
        for (const tr of dst.videoTracks) tr.clips = cut(tr.clips);
        for (const t of dst.audioTracks) t.clips = cut(t.clips);
        for (const c of allVideo(dst)) if (c.start >= start - ADJ) c.start += dur;
        for (const t of dst.audioTracks) for (const c of t.clips) if (c.start >= start - ADJ) c.start += dur;
      }
      for (const v of content.videoClips) { reid(v); v.start += start; dst.videoClips.push(v); }
      // Верхние видеодорожки — по порядку (1-я к 1-й…); если там в этом месте занято — новая дорожка над ними
      content.videoTracks.forEach((vt, i) => {
        if (!vt.clips.length) return;
        const s = Math.min(...vt.clips.map((a) => a.start)) + start; const e = Math.max(...vt.clips.map(end)) + start;
        let tr = dst.videoTracks[i];
        if (!tr || !tr.clips.every((c) => end(c) <= s + ADJ || c.start >= e - ADJ)) { tr = newVideoTrack(vt.name ? { name: vt.name } : {}); dst.videoTracks.push(tr); }
        for (const v of vt.clips) { reid(v); v.start += start; tr.clips.push(v); }
      });
      if (!dst.videoTracks.length) delete dst.videoTracks;
      // Звуковые дорожки: по порядку, но если там уже что-то звучит в этом месте (музыка) — на свободную или новую
      const used = new Set();
      const free = (tr, s, e) => tr.clips.every((c) => end(c) <= s + ADJ || c.start >= e - ADJ);
      content.audioTracks.forEach((t, i) => {
        if (!t.clips.length) return;
        const s = Math.min(...t.clips.map((a) => a.start)) + start; const e = Math.max(...t.clips.map(end)) + start;
        let tr = dst.audioTracks[i] && !used.has(dst.audioTracks[i]) && free(dst.audioTracks[i], s, e) ? dst.audioTracks[i] : null;
        if (!tr) tr = dst.audioTracks.find((x) => !used.has(x) && free(x, s, e));
        if (!tr) { tr = newTrack({ name: t.name, volume: t.volume ?? 1 }); dst.audioTracks.push(tr); }
        used.add(tr);
        for (const a of t.clips) { reid(a); a.start += start; tr.clips.push(a); }
      });
      if (dst !== p) {
        dst.videoClips.sort(byStart);
        for (const tr of dst.videoTracks || []) tr.clips.sort(byStart);
        syncLinks({ videoClips: dst.videoClips, videoTracks: dst.videoTracks, audioTracks: dst.audioTracks });
      }
    });
    return true;
  }

  newClip(mediaId, extra = {}) {
    const m = this.media(mediaId);
    const out = m.isImage && !m.isAnimation ? Math.min(5, m.duration) : m.duration;
    return { id: uid('clp'), mediaId, in: 0, out, start: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...extra };
  }

  // Видео на видеодорожку lane (по умолчанию — основная): на основную — в конец, на верхнюю — к курсору; иначе около времени at.
  //   mode 'auto' — «магнит» в пустоту или раздвинуть соседей; 'insert' — ровно в at, раздвинуть; 'overwrite' — затереть то, что под ним.
  //   linkAudio — звук файла отдельными связанными клипами на аудиодорожках (каждый звуковой поток — свой клип)
  insertVideoClip(mediaId, at = null, mode = 'auto', extra = {}, { linkAudio = true, lane = MAIN_LANE } = {}) {
    const m = this.media(mediaId);
    if (!m || !m.hasVideo) return null;
    const ln = vlane(this.project, lane) || vlane(this.project, MAIN_LANE);
    if (at === null && !ln.main) at = this.time;
    const clip = this.newClip(mediaId, extra);
    const split = linkAudio && m.hasAudio && !m.isImage;
    if (split) { clip.link = uid('lnk'); clip.noAudio = true; }
    this.mutate((p) => {
      const L = vlane(p, ln.id);
      if (mode === 'overwrite' && at !== null) { L.clips.push(clip); overwriteVideo(p, clip, at); } else placeVideo(p, clip, at === null ? this.videoEnd() : at, at === null ? 'insert' : mode, ln.id);
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
      if (speedOf(v) !== 1) a.speed = speedOf(v);
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
    for (const v of allVideo(this.project)) if (v.link === f.clip.link && v.id !== id) out.push({ kind: 'video', clip: v });
    for (const t of this.project.audioTracks) for (const c of t.clips) if (c.link === f.clip.link && c.id !== id) out.push({ kind: 'audio', clip: c, track: t });
    return out;
  }

  // Отвязать звук от видео (клипы останутся на местах, но будут двигаться отдельно)
  unlink(id) {
    const f = this.findClip(id);
    if (!f || !f.clip.link) return false;
    const L = f.clip.link;
    this.mutate((p) => {
      for (const v of allVideo(p)) if (v.link === L) delete v.link;
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
      const v = allVideo(p).find((x) => x.id === id);
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
      const v = allVideo(p).find((x) => x.id === id);
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

  // --- Многоканальный звук (0.5.1, audioLayout.js) ---
  /** Раскладка проекта: { kind: 'stereo'|'mono'|'5.1'|'7.1'|'multi', channels? }; маршруты за пределами раскладки сбрасываются */
  setAudioLayout(layout) {
    this.mutate((p) => {
      const lay = cleanLayout(layout);
      if (lay) p.audioLayout = lay; else delete p.audioLayout;
      const fixR = (o) => { if (o.route !== undefined) { if (isDefaultRoute(o.route, p)) delete o.route; else o.route = cleanRoute(o.route, p); } };
      for (const tr of p.audioTracks) fixR(tr);
      if (p.videoRoute !== undefined) { if (isDefaultRoute(p.videoRoute, p)) delete p.videoRoute; else p.videoRoute = cleanRoute(p.videoRoute, p); }
      for (const e of p.episodes || []) for (const tr of e.audioTracks || []) fixR(tr);
    });
  }
  /** Маршрут дорожки: trackId — id аудиодорожки или 'video' (звук видеоклипов); route — [k] | [k1, k2] (номера каналов с 0) */
  setTrackRoute(trackId, route) {
    this.mutate((p) => {
      const r = cleanRoute(route, p);
      const def = isDefaultRoute(r, p);
      if (trackId === 'video') { if (def) delete p.videoRoute; else p.videoRoute = r; return; }
      const tr = p.audioTracks.find((x) => x.id === trackId);
      if (!tr) return;
      if (def) delete tr.route; else tr.route = r;
    });
  }
  /**
   * Разложить многоканальный клип по каналам: каждый канал его потока — отдельным моно-клипом (clip.channel) на своей
   * дорожке (новые дорожки по необходимости); дорожка k-го клипа получает маршрут в k-й канал проекта, если он есть.
   * Возвращает id новых клипов. Связь с видео (link) сохраняется — каналы едут вместе с видео.
   */
  splitChannels(clipId) {
    const f = this.findClip(clipId);
    if (!f || f.kind !== 'audio') return [];
    const m = this.media(f.clip.mediaId);
    const n = streamChannels(m, f.clip.stream || 0);
    if (n < 2 || f.clip.channel !== undefined) return [];
    const ids = [];
    this.mutate((p) => {
      const src = p.audioTracks.flatMap((x) => x.clips).find((c) => c.id === clipId);
      const home = p.audioTracks.find((x) => x.clips.includes(src));
      if (!src || !home) return;
      const nch = channelCount(p);
      const s = src.start; const d = len(src);
      const free = (tr) => tr.clips.every((c) => c === src || end(c) <= s + 1e-6 || c.start >= s + d - 1e-6);
      let at = p.audioTracks.indexOf(home);
      const used = new Set();
      for (let k = 0; k < n; k++) {
        const c = k === 0 ? src : { ...JSON.parse(JSON.stringify(src)), id: uid('clp') };
        c.channel = k;
        c.name = `${(m && m.name) || ''} · ${k + 1}`.trim();
        let tr = k === 0 ? home : null;
        if (!tr) {
          tr = p.audioTracks.slice(at + 1).find((x) => !used.has(x) && !x.clips.length && free(x)) || null;
          if (!tr) { tr = newTrack(); p.audioTracks.splice(at + 1, 0, tr); }
          tr.clips.push(c);
        }
        at = p.audioTracks.indexOf(tr);
        used.add(tr);
        // Маршрут: k-й канал проекта (если каналов меньше — остаётся по умолчанию)
        if (nch > 2 && k < nch && tr.clips.every((x) => x === c || x.channel === k)) tr.route = [k];
        if (!tr.name) tr.name = t('Канал {n}', { n: k + 1 });
        ids.push(c.id);
      }
    });
    return ids;
  }

  // name, volume, …; trackId 'video' или id верхней видеодорожки — видеодорожка (name, hidden, locked)
  setTrack(trackId, patch, opts) {
    if (vlane(this.project, trackId) && (trackId === MAIN_LANE || trackId.startsWith('vtk'))) { this.setVideoTrack(trackId, patch, opts); return; }
    this.mutate((p) => {
      const t = p.audioTracks.find((x) => x.id === trackId);
      if (t) Object.assign(t, patch);
    }, opts);
  }
  trackName(trackId) {
    if (trackId === MAIN_LANE) return this.project.videoName || t('Видео');
    const vi = this.videoTracks().findIndex((x) => x.id === trackId);
    if (vi >= 0) return this.videoTracks()[vi].name || t('Видео {n}', { n: vi + 2 });
    const i = this.project.audioTracks.findIndex((x) => x.id === trackId);
    const tk = this.project.audioTracks[i];
    return (tk && tk.name) || t('Аудио {n}', { n: i + 1 });
  }

  // Переместить видеоклип к времени start (с размещением как при перетаскивании); laneId — на другую видеодорожку
  moveVideoClip(id, start, mode = 'auto', laneId = null) {
    this.mutate((p) => {
      const c = allVideo(p).find((x) => x.id === id);
      if (!c) return;
      if (mode === 'overwrite') { if (laneId) moveToLane(p, c, laneId); overwriteVideo(p, c, start); } else placeVideo(p, c, start, mode, laneId);
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

  // Скорость клипа (×0.1…×16) вместе со связанными клипами (видео + его звук).
  // Фрагмент файла (in/out) не меняется — меняется длина на таймлайне.
  //   ripple = false: клип становится короче/длиннее на месте; если удлинился и наехал на соседа —
  //                   сосед подрезается (как при наложении), остальное стоит на месте.
  //   ripple = true:  всё, что начинается не раньше старого конца клипа (на всех дорожках), сдвигается на разницу.
  setSpeed(id, speed, { ripple = false } = {}, opts) {
    const f = this.findClip(id);
    if (!f || isText(f.clip)) return false;
    const m = this.media(f.clip.mediaId);
    if (m && m.isImage && !m.isAnimation) return false;   // у картинки скорости нет — только длительность
    const s = clamp(Number(speed) || 1, MIN_SPEED, MAX_SPEED);
    const ids = new Set([id, ...this.linkedOf(id).map((x) => x.clip.id)]);
    const oldEnd = end(f.clip);
    this.mutate((p) => {
      const all = [...allVideo(p), ...p.audioTracks.flatMap((t) => t.clips)];
      const targets = all.filter((c) => ids.has(c.id));
      for (const c of targets) { if (Math.abs(s - 1) < 1e-6) delete c.speed; else c.speed = s; }
      const newEnd = end(targets.find((c) => c.id === id));
      const delta = newEnd - oldEnd;
      if (ripple && Math.abs(delta) > 1e-6) {
        for (const c of all) if (!ids.has(c.id) && c.start >= oldEnd - ADJ) c.start = Math.max(0, c.start + delta);
      } else if (delta > 1e-6) {
        const vids = allVideo(p);
        const v = targets.find((c) => vids.includes(c));
        if (v) overwriteVideo(p, v, v.start);
        else for (const t of p.audioTracks) for (const a of t.clips.filter((c) => ids.has(c.id))) overwriteAudio(t, a);
      }
    }, opts);
    return true;
  }

  // --- Звуковые эффекты: target = { kind: 'clip' | 'track', id } ---
  fxOwner(target, p = this.project) {
    if (!target) return null;
    if (target.kind === 'track') return p.audioTracks.find((t) => t.id === target.id) || null;
    for (const c of allVideo(p)) if (c.id === target.id) return c;
    for (const t of p.audioTracks) for (const c of t.clips) if (c.id === target.id) return c;
    return null;
  }
  addAudioFx(target, type) {
    const fx = newAudioFx(type);
    if (!fx || !this.fxOwner(target)) return -1;
    let idx = -1;
    this.mutate((p) => { const o = this.fxOwner(target, p); o.afx = [...(o.afx || []), fx]; idx = o.afx.length - 1; });
    return idx;
  }
  // patch: { on?, p?: { ...параметры } }; live — без записи в историю (для ползунков)
  setAudioFx(target, index, patch, { live = false } = {}) {
    const fn = (p) => {
      const o = this.fxOwner(target, p);
      const fx = o && o.afx && o.afx[index];
      if (!fx) return;
      if (patch.on !== undefined) fx.on = !!patch.on;
      if (patch.p) fx.p = { ...fx.p, ...patch.p };
    };
    if (live) this.live(fn); else this.mutate(fn);
  }
  removeAudioFx(target, index) {
    this.mutate((p) => {
      const o = this.fxOwner(target, p);
      if (!o || !o.afx) return;
      o.afx = o.afx.filter((_, i) => i !== index);
      if (!o.afx.length) delete o.afx;
    });
  }

  // Кадрирование видеоклипов: crop { l, t, r, b } — доли кадра, срезанные слева/сверху/справа/снизу.
  // null или все нули — без кадрирования. ids — список клипов (один шаг отмены).
  setCrop(ids, crop) {
    const set = new Set(ids);
    const q = (x) => Math.round(clamp(Number(x) || 0, 0, 0.95) * 10000) / 10000;
    let cr = crop ? { l: q(crop.l), t: q(crop.t), r: q(crop.r), b: q(crop.b) } : null;
    if (cr && (cr.l + cr.r > 0.95 || cr.t + cr.b > 0.95)) return false;
    if (cr && !(cr.l || cr.t || cr.r || cr.b)) cr = null;
    this.mutate((p) => {
      for (const c of allVideo(p)) {
        if (!set.has(c.id)) continue;
        if (cr) c.crop = { ...cr }; else delete c.crop;
      }
    });
    return true;
  }

  // Подгонка кадра видеоклипов: 'contain' (вписать, по умолчанию) | 'cover' (заполнить) | 'stretch' (растянуть).
  // ids — список клипов (один шаг отмены на всех)
  setFit(ids, fit) {
    const set = new Set(ids);
    this.mutate((p) => {
      for (const c of allVideo(p)) {
        if (!set.has(c.id)) continue;
        if (!fit || fit === 'contain') delete c.fit; else c.fit = fit;
      }
    });
  }

  // Трансформ видеоклипов (transform.js): patch накладывается на текущий трансформ каждого клипа;
  // null — сбросить. live — без записи в историю (перетаскивание гизмо, ползунки).
  setTransform(ids, patch, { live = false, replace = false } = {}) {
    const set = new Set(ids);
    const fn = (p) => {
      for (const c of allVideo(p)) {
        if (!set.has(c.id)) continue;
        const tf = patch ? cleanTransform(patch, replace ? null : c.transform) : null;
        if (tf) c.transform = tf; else delete c.transform;
      }
    };
    if (live) this.live(fn); else this.mutate(fn);
  }

  // Изменить длительность клипа (видео раздвигает следующие клипы, если не хватает места)
  setClipDuration(id, dur) {
    const f = this.findClip(id);
    if (!f) return false;
    const m = this.media(f.clip.mediaId);
    const sp = speedOf(f.clip);
    const nout = clamp(f.clip.in + dur * sp, f.clip.in + MIN_CLIP * sp, isText(f.clip) ? TEXT_MAX : m ? m.duration : f.clip.out);
    this.mutate((p) => {
      const c = this.findClip(id).clip;
      const oldEnd = end(c);
      c.out = nout;
      if (f.kind === 'video' && end(c) > oldEnd) pushFrom((vlaneOf(p, c) || vlane(p, MAIN_LANE)).clips, oldEnd, end(c), c);
    });
    return (nout - f.clip.in) / sp;
  }

  // Разрезать клип по времени таймлайна t. withLinked (по умолчанию) — вместе со связанными
  // (видео + его звук), иначе связь половин рвётся: удаление левой половины убрало бы весь звук.
  // Частота проекта — для привязки точек правки ко кадрам (B-6)
  fps() { return this.sourceFormat().fps || 30; }
  frameT(t) { return snapFrame(t, this.fps()); }

  splitAt(t, id = null, { withLinked = true } = {}) {
    t = this.frameT(t);
    const hit = (c) => t > c.start + MIN_CLIP - 1e-6 && t < end(c) - MIN_CLIP + 1e-6;
    // Без id — клип основной дорожки под курсором, иначе самый верхний
    if (!id) id = [...vlanes(this.project)].map((l) => l.clips.find(hit)).filter(Boolean)[0]?.id || null;
    if (!id) return 0;
    const targets = [id];
    if (withLinked) for (const x of this.linkedOf(id)) if (hit(x.clip)) targets.push(x.clip.id);
    return this.splitClips(t, targets);
  }

  // Alt+S: разрезать всё, что под курсором, на всех дорожках
  splitAll(t) {
    t = this.frameT(t);
    const ids = [];
    // Тот же допуск, что у splitAt (B-6); дорожки с замком не режем
    const hit = (c) => t > c.start + MIN_CLIP - 1e-6 && t < end(c) - MIN_CLIP + 1e-6;
    for (const l of vlanes(this.project)) if (!l.locked) for (const c of l.clips) if (hit(c)) ids.push(c.id);
    for (const tr of this.project.audioTracks) if (!tr.locked) for (const c of tr.clips) if (hit(c)) ids.push(c.id);
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
        const local = srcAt(c, t);
        if (t - c.start < MIN_CLIP - 1e-6 || end(c) - t < MIN_CLIP - 1e-6) continue;
        const right = { ...JSON.parse(JSON.stringify(c)), id: uid('clp'), in: local, start: t, fadeIn: 0 };
        delete right.transition;
        if (c.link) right.link = splitLink(c.link, t);
        c.out = local;
        c.fadeOut = 0;
        if (f.kind === 'video') f.lane.clips.push(right);
        else f.track.clips.push(right);
        done++;
      }
    });
    return done;
  }

  // Удалить клип; ripple — сдвинуть следующее на место удалённого — на всех дорожках без замка (B-5):
  // дорожка, где сдвиг упёрся бы в другой клип (например, музыка лежит поперёк), остаётся на месте.
  // → { skipped: [id дорожек] }
  deleteClip(id, { ripple = false } = {}) {
    const f = this.findClip(id);
    if (!f) return { skipped: [] };
    // Видео удаляется вместе со своим звуком
    const L = f.kind === 'video' ? f.clip.link : null;
    let res = { skipped: [] };
    this.mutate((p) => {
      const d = len(f.clip);
      const s = f.clip.start;
      const e = end(f.clip);
      const list = f.kind === 'video' ? f.lane.clips : f.track.clips;
      const rest = list.filter((c) => c.id !== id);
      if (f.kind === 'video') f.lane.clips = rest; else f.track.clips = rest;
      if (L) for (const t of p.audioTracks) t.clips = t.clips.filter((c) => c.link !== L);
      // Сдвиг — только если на месте клипа стало пусто на его дорожке (рядом нет другого клипа поперёк)
      if (ripple) res = rippleShift(p, e, -Math.min(d, e - s));
    });
    return res;
  }

  // Клипы дорожки: 'video', id верхней видеодорожки или id аудиодорожки
  laneClips(p, lane) {
    const v = vlane(p, lane);
    if (v && (lane === MAIN_LANE || v.id === lane)) return v;
    return p.audioTracks.find((x) => x.id === lane) || { clips: [] };
  }
  // Пустоты дорожки: 'video', id верхней видеодорожки или id аудиодорожки
  gaps(lane) {
    const l = this.laneClips(this.project, lane);
    return l.clips.length ? gapsOf(l.clips) : [];
  }

  // Убрать пустоту, в которую попадает время at (сдвигает все клипы дорожки правее неё)
  closeGap(lane, at) {
    const g = this.gaps(lane).find(([a, b]) => at >= a - ADJ && at <= b + ADJ);
    if (!g) return 0;
    const shift = g[1] - g[0];
    // Вместе с дорожкой едут и остальные (B-5): звук и титры не съезжают относительно видео
    this.mutate((p) => { rippleShift(p, g[1], -shift); });
    return shift;
  }

  closeAllGaps(lane) {
    const gaps = this.gaps(lane);
    if (!gaps.length) return 0;
    // Справа налево: каждая пустота закрывается сдвигом всех дорожек, где это возможно
    this.mutate((p) => {
      for (const [g0, g1] of [...gaps].reverse()) rippleShift(p, g1, -(g1 - g0));
    });
    return gaps.length;
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
        placeVideo(p, copy, end(f.clip), 'insert', f.lane.id);
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
      const a = { ...clip, id: uid('clp'), link: v.link, start: tlAt(v, clip.in) };
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
    this.clipboard = { kind: f.kind, clip: c, trackId: f.track ? f.track.id : f.lane.id, partners };
    this.emit('clipboard');
    return true;
  }

  // Вставить скопированный клип в позицию курсора
  paste(at = this.time, lane = null) {
    const cb = this.clipboard;
    if (!cb || (!isText(cb.clip) && !this.media(cb.clip.mediaId))) return null;
    const copy = { ...JSON.parse(JSON.stringify(cb.clip)), id: uid('clp'), start: Math.max(0, at) };
    this.mutate((p) => {
      if (cb.kind === 'video') {
        const vl = lane && vlane(p, lane) && vlane(p, lane).id === lane ? lane : (cb.trackId && vlane(p, cb.trackId) && vlane(p, cb.trackId).id === cb.trackId ? cb.trackId : MAIN_LANE);
        placeVideo(p, copy, copy.start, 'auto', vl);
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
      const b = allVideo(this.project).find((c) => c.id === id);
      if (!type) { delete b.transition; return; }
      const d = duration ?? (b.transition ? b.transition.duration : TR_DEFAULT);
      b.transition = { type, duration: clamp(d, TR_MIN, Math.max(TR_MIN, maxTransition(j.a, b))) };
    });
    return true;
  }

  // ------------------------------------------------------------------------
  // Текст (M5.1)
  // ------------------------------------------------------------------------
  // Новый текстовый клип. style — стиль из реестра (registry.textStyleById) или null; text — поля оформления поверх стиля.
  //   at — время (по умолчанию курсор), lane — видеодорожка ('new' — новая верхняя; по умолчанию — верхняя, где свободно).
  addTextClip({ style = null, text = {}, at = this.time, duration = null, lane = null, transform = null, select = true } = {}) {
    const st = style || null;
    const d = clamp(Number(duration) || (st && st.duration) || TEXT_DEFAULT_DUR, MIN_CLIP, TEXT_MAX);
    const clip = {
      id: uid('clp'), kind: 'text', in: 0, out: d, start: Math.max(0, Number(at) || 0), volume: 1, muted: true, fadeIn: 0, fadeOut: 0,
      text: cleanText({ ...(st ? { style: st.id } : {}), ...(text || {}) }, st ? st.text : null),
    };
    if (!clip.text.content) clip.text.content = t('Текст');
    const tf = cleanTransform(transform || (st && st.transform) || null);
    if (tf) clip.transform = tf;
    let ok = true;
    this.mutate((p) => {
      const tracks = p.videoTracks || [];
      let tr = null;
      if (lane && lane !== 'new') {
        const L = vlane(p, lane);
        if (!L || L.locked) { ok = false; return; }
        L.clips.push(clip);
        overwriteVideo(p, clip, clip.start);
        return;
      }
      if (lane !== 'new') tr = [...tracks].reverse().find((x) => !x.locked && x.clips.every((c) => end(c) <= clip.start + ADJ || c.start >= clip.start + d - ADJ));
      if (!tr) { tr = newVideoTrack(); p.videoTracks = [...tracks, tr]; }
      tr.clips.push(clip);
    });
    if (!ok) return null;
    if (select) this.select({ kind: 'video', id: clip.id });
    return clip;
  }

  // Оформление текстовых клипов: patch поверх текущего (textModel.cleanText). live — без записи в историю.
  setText(ids, patch, { live = false } = {}) {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    const fn = (p) => { for (const c of allVideo(p)) if (set.has(c.id) && isText(c)) c.text = cleanText(patch, c.text); };
    if (live) this.live(fn); else this.mutate(fn);
  }

  // ------------------------------------------------------------------------
  // Субтитры (M5.5)
  // ------------------------------------------------------------------------
  subtitleTracks() { return this.project.subtitleTracks || []; }
  subtitleTrack(id) { return this.subtitleTracks().find((x) => x.id === id) || null; }
  findCue(id) {
    for (const track of this.subtitleTracks()) { const cue = track.cues.find((c) => c.id === id); if (cue) return { cue, track }; }
    return null;
  }
  subtitleTrackName(id) {
    const i = this.subtitleTracks().findIndex((x) => x.id === id);
    const tr = this.subtitleTracks()[i];
    return (tr && tr.name) || t('Субтитры {n}', { n: i + 1 });
  }
  // Новая дорожка субтитров; возвращает id
  addSubtitleTrack(extra = {}) {
    const tr = newSubtitleTrack();
    if (extra.name) tr.name = String(extra.name).slice(0, 60);
    if (extra.style) tr.style = cleanSubStyle(extra.style);
    if (extra.cues) tr.cues = fixCues(extra.cues);
    this.mutate((p) => { p.subtitleTracks = [...(p.subtitleTracks || []), tr]; fixSubTracks(p); });
    return tr.id;
  }
  removeSubtitleTrack(id) {
    if (!this.subtitleTrack(id)) return false;
    this.mutate((p) => { p.subtitleTracks = (p.subtitleTracks || []).filter((x) => x.id !== id); fixSubTracks(p); });
    return true;
  }
  // name / hidden / locked / style (style — patch поверх текущего)
  setSubtitleTrack(id, patch, opts) {
    this.mutate((p) => {
      const tr = (p.subtitleTracks || []).find((x) => x.id === id);
      if (!tr) return;
      if (patch.name !== undefined) { const n = String(patch.name || '').trim().slice(0, 60); if (n) tr.name = n; else delete tr.name; }
      if (patch.hidden !== undefined) { if (patch.hidden) tr.hidden = true; else delete tr.hidden; }
      if (patch.locked !== undefined) { if (patch.locked) tr.locked = true; else delete tr.locked; }
      if (patch.style) tr.style = cleanSubStyle({ ...tr.style, ...patch.style });
      if (patch.lang !== undefined) { if (/^[a-z]{2,3}$/.test(patch.lang || '')) tr.lang = patch.lang; else delete tr.lang; }
    }, opts);
  }
  // Реплика на дорожке (нет дорожки — создаётся); возвращает id реплики
  addCue(trackId, { start = this.time, end: e = null, text = '' } = {}) {
    let tid = trackId && this.subtitleTrack(trackId) ? trackId : null;
    if (!tid) tid = this.subtitleTracks()[0] ? this.subtitleTracks()[0].id : this.addSubtitleTrack();
    const s = cueTime(start);
    const cue = { id: uid('cue'), start: s, end: e === null ? s + 2 : Number(e), text: String(text ?? '') };
    this.mutate((p) => {
      const tr = p.subtitleTracks.find((x) => x.id === tid);
      tr.cues = fixCues([...tr.cues, cue]);
    });
    return cue.id;
  }
  // patch: { start?, end?, text? }; live — без истории (перетаскивание)
  setCue(id, patch, { live = false } = {}) {
    const fn = (p) => {
      for (const tr of p.subtitleTracks || []) {
        const c = tr.cues.find((x) => x.id === id);
        if (!c) continue;
        if (patch.start !== undefined) c.start = patch.start;
        if (patch.end !== undefined) c.end = patch.end;
        if (patch.text !== undefined) c.text = String(patch.text ?? '');
        tr.cues = fixCues(tr.cues);
      }
    };
    if (live) this.live(fn); else this.mutate(fn);
  }
  deleteCue(id) {
    if (!this.findCue(id)) return false;
    this.mutate((p) => { for (const tr of p.subtitleTracks || []) tr.cues = tr.cues.filter((c) => c.id !== id); });
    return true;
  }
  // Разрезать реплику по времени: левая часть — до t, правая — после, текст копируется
  splitCue(id, at) {
    const f = this.findCue(id);
    if (!f || at <= f.cue.start + MIN_CUE || at >= f.cue.end - MIN_CUE) return false;
    this.mutate((p) => {
      const tr = p.subtitleTracks.find((x) => x.id === f.track.id);
      const c = tr.cues.find((x) => x.id === id);
      tr.cues = fixCues([...tr.cues, { id: uid('cue'), start: at, end: c.end, text: c.text }]);
      tr.cues.find((x) => x.id === id).end = cueTime(at);
    });
    return true;
  }
  // Импорт реплик: на новую дорожку (trackId null) или заменить содержимое дорожки trackId; shift — сдвиг по времени
  importCues(cues, { trackId = null, name = null, style = null, shift = 0 } = {}) {
    const list = fixCues((cues || []).map((c) => ({ start: c.start + shift, end: c.end + shift, text: c.text })));
    if (trackId && this.subtitleTrack(trackId)) {
      this.mutate((p) => {
        const tr = p.subtitleTracks.find((x) => x.id === trackId);
        tr.cues = list;
        if (style) tr.style = cleanSubStyle({ ...tr.style, ...style });
      });
      return trackId;
    }
    return this.addSubtitleTrack({ name, style: style ? cleanSubStyle(style) : null, cues: list });
  }

  serialize() {
    // appVersion — какой версией программы сохранено: по ней 0.4+ делает резервную копию проектов 0.3 (commands.rs)
    // и предупреждает, если проект сохранён более новой версией
    return JSON.stringify({ app: 'FF Montage', version: 2, appVersion: this.appVersion || undefined, savedAt: new Date().toISOString(), project: this.project }, null, 1);
  }
}

export const store = new Store();
