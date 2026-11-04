// Эффекты, которым нужен новый файл: реверс фрагмента и стоп-кадр.
// FFmpeg делает файл в кэш, он добавляется в проект как скрытое «производное» медиа (derived),
// а клип переключается на него. Так предпросмотр и экспорт работают с ним как с обычным видео.
import { store, placeVideo, MIN_CLIP } from './store.js';
import { uid, clamp, toast, t } from './util.js';
import { prepareMedia } from './media.js';
import { srcAt, tlAt, clipEnd } from './clipTime.js';
import { getLang } from './i18n.js';

const api = window.api;
// Число как есть, но с десятичным разделителем языка (3 → «3», 2.5 → «2,5» / «2.5»)
const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));

// Добавить (или найти уже добавленное) производное медиа
function ensureDerived(info, derived) {
  const same = Object.values(store.project.media).find((m) => m.derived
    && m.derived.kind === derived.kind && m.derived.from === derived.from
    && Math.abs((m.derived.in ?? m.derived.at) - (derived.in ?? derived.at)) < 1e-3
    && Math.abs((m.derived.out ?? 0) - (derived.out ?? 0)) < 1e-3);
  if (same) {
    if (same.path !== info.path) Object.assign(same, info, { id: same.id, hidden: true, derived: same.derived });
    return same.id;
  }
  const id = uid('med');
  store.project.media[id] = { ...info, id, hidden: true, derived };
  return id;
}

// Пересоздать файл производного медиа (если кэш очистили). Возвращает свежие сведения о файле.
export async function rebuildDerived(m) {
  const src = store.media(m.derived.from);
  if (!src) throw new Error(t('исходный файл убран из проекта'));
  if (m.derived.kind === 'reverse') return api.fxReverse(src, m.derived.in, m.derived.out);
  if (m.derived.kind === 'freeze') return api.fxFreeze(src, m.derived.at);
  throw new Error(t('неизвестный эффект'));
}

export function isReversed(clip) {
  const m = store.media(clip.mediaId);
  return !!(m && m.derived && m.derived.kind === 'reverse');
}
export function isFreeze(clip) {
  const m = store.media(clip.mediaId);
  return !!(m && m.derived && m.derived.kind === 'freeze');
}

// «Отзеркалить»: проиграть фрагмент задом наперёд. Повторный вызов возвращает обычное направление.
export async function toggleReverse(clipId) {
  const f = store.findClip(clipId);
  if (!f) throw new Error(t('Клип не найден'));
  const c = f.clip;
  const m = store.media(c.mediaId);
  if (!m) throw new Error(t('Файл клипа не найден'));
  if (store.busy[clipId]) throw new Error(t('Клип уже обрабатывается'));

  // Уже развёрнут — возвращаем исходный файл с тем же фрагментом
  if (m.derived && m.derived.kind === 'reverse') {
    const { from, out: b } = m.derived;
    store.setClip(clipId, { mediaId: from, in: b - c.out, out: b - c.in });
    toast(t('Обычное направление воспроизведения'), 'info', 1800);
    return { reversed: false };
  }
  if (m.derived) throw new Error(t('Для стоп-кадра реверс не нужен'));

  const a = c.in; const b = c.out;
  store.setBusy(clipId, { label: t('Реверс'), progress: 0 });
  const off = api.onFxProgress((p) => {
    if (p.key === `reverse:${m.key}:${a.toFixed(3)}:${b.toFixed(3)}`) store.setBusy(clipId, { label: t('Реверс'), progress: p.fraction });
  });
  try {
    const info = await api.fxReverse(m, a, b);
    const cur = store.findClip(clipId);
    if (!cur) return { reversed: false, cancelled: true };
    store.mutate((p) => {
      const id = ensureDerived(info, { kind: 'reverse', from: m.id, in: a, out: b });
      const cc = store.findClip(clipId).clip;
      // Развёрнутый файл — со своим развёрнутым звуком: связанный звук на дорожках больше не нужен
      if (cc.link && f.kind === 'video') {
        const L = cc.link;
        for (const trk of p.audioTracks) trk.clips = trk.clips.filter((x) => x.link !== L);
        delete cc.link; delete cc.noAudio;
      }
      // Если клип успели подрезать — переводим его границы в координаты развёрнутого файла
      const x = clamp(cc.in, a, b); const y = clamp(cc.out, a, b);
      const total = Math.min(store.media(id).duration || (b - a), b - a);
      cc.mediaId = id;
      cc.in = clamp(b - y, 0, total - MIN_CLIP);
      cc.out = clamp(b - x, cc.in + MIN_CLIP, total);
    });
    prepareMedia(store.findClip(clipId).clip.mediaId);
    toast(t('Фрагмент развёрнут: играет задом наперёд'), 'success', 2200);
    return { reversed: true };
  } finally {
    off();
    store.setBusy(clipId, null);
  }
}

// Стоп-кадр в момент time на основной дорожке: клип разрезается, вставляется неподвижный кадр длиной dur,
// всё, что правее, сдвигается.
export async function freezeFrameAt(time = store.time, dur = 3) {
  const seg = store.videoLayout().find((s) => time >= s.start - 1e-6 && time < s.end - 1e-6)
    || store.videoLayout().find((s) => Math.abs(time - s.end) < 0.02);
  if (!seg) throw new Error(t('Поставьте курсор на видеоклип'));
  const c = seg.clip;
  const m = store.media(c.mediaId);
  if (!m || !m.hasVideo) throw new Error(t('В клипе нет видео'));
  const local = clamp(srcAt(c, time), c.in, c.out - 0.001);
  store.setBusy(c.id, { label: t('Стоп-кадр'), progress: 0.5 });
  try {
    const info = await api.fxFreeze(m, local);
    const fdur = clamp(dur, MIN_CLIP, (info.duration || 20) - 0.05);
    let newId = null;
    store.mutate((p) => {
      const id = ensureDerived(info, { kind: 'freeze', from: m.id, at: local });
      const lane = store.findClip(c.id) && store.findClip(c.id).lane;
      const cc = lane && lane.clips.find((x) => x.id === c.id);
      if (!cc) return;
      const at = tlAt(cc, local);
      // Разрезаем, если курсор внутри клипа
      if (at - cc.start >= MIN_CLIP && clipEnd(cc) - at >= MIN_CLIP) {
        const right = { ...JSON.parse(JSON.stringify(cc)), id: uid('clp'), in: local, start: at, fadeIn: 0 };
        delete right.transition;
        cc.out = local; cc.fadeOut = 0;
        lane.clips.push(right);
      }
      const fz = { id: uid('clp'), mediaId: id, in: 0, out: fdur, start: at, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, name: t('Стоп-кадр') };
      const insertAt = at - cc.start < MIN_CLIP ? cc.start : (clipEnd(cc) - at < MIN_CLIP ? clipEnd(cc) : at);
      placeVideo(p, fz, insertAt, 'insert', lane.id);
      newId = fz.id;
    });
    if (newId) {
      prepareMedia(store.findClip(newId).clip.mediaId);
      store.select({ kind: 'video', id: newId });
    }
    toast(t('Стоп-кадр {n} с добавлен', { n: dec(fdur) }), 'success', 2000);
    return newId;
  } finally {
    store.setBusy(c.id, null);
  }
}
