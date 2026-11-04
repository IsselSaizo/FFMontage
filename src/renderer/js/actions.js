// Действия над клипами: общие для контекстного меню, горячих клавиш и инспектора.
import { store, MIN_CLIP } from './store.js';
import { toast, promptDialog, parseDuration, fmtTime, errText, t } from './util.js';
import { getLang } from './i18n.js';
import { keyHint } from './keymap.js';
import { openMenu } from './contextMenu.js';
import { toggleReverse, freezeFrameAt, isReversed, isFreeze } from './fx.js';
import { speedOf, tlLen, clipEnd } from './clipTime.js';
const inside = (c, time) => time > c.start + MIN_CLIP && time < clipEnd(c) - MIN_CLIP;
// Число как есть, но с десятичным разделителем языка (0.1 → «0,1» / «0.1»)
const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));

export function splitClip(id, time = store.time) {
  const f = store.findClip(id);
  if (!f || !inside(f.clip, time)) { toast(t('Поставьте курсор внутрь клипа, чтобы разрезать'), 'info', 2200); return false; }
  return store.splitAt(time, id) > 0;
}

export function deleteClip(id, ripple = false) {
  if (!store.findClip(id)) return;
  store.deleteClip(id, { ripple });
}

export function copyClip(id) {
  if (store.copyClip(id)) toast(t('Клип скопирован'), 'info', 1400);
}

export function pasteClip(at = store.time, lane = null) {
  if (!store.clipboard) { toast(t('Сначала скопируйте клип ({key})', { key: keyHint('clip.copy') }), 'info', 2000); return; }
  if (!store.paste(at, lane)) toast(t('Файл скопированного клипа убран из проекта'), 'error');
}

export async function reverseClip(id) {
  try { await toggleReverse(id); } catch (e) { toast(t('Реверс не получился: {err}', { err: errText(e) }), 'error', 5000); }
}

export async function freezeFrame(time = store.time) {
  try { await freezeFrameAt(time, 3); } catch (e) { toast(t('Стоп-кадр: {err}', { err: errText(e) }), 'error', 4000); }
}

export async function renameClip(id) {
  const f = store.findClip(id);
  if (!f) return;
  const v = await promptDialog(t('Переименовать клип'), t('Название на таймлайне'), store.clipName(f.clip), {
    okText: t('Переименовать'), hint: t('Оставьте пустым, чтобы вернуть имя файла. Файл на диске не меняется.'),
  });
  if (v === null) return;
  store.mutate(() => {
    const c = store.findClip(id)?.clip;
    if (!c) return;
    if (v) c.name = v; else delete c.name;
  });
}

export async function changeDuration(id) {
  const f = store.findClip(id);
  if (!f) return;
  const m = store.media(f.clip.mediaId);
  const max = (m ? m.duration - f.clip.in : f.clip.out - f.clip.in) / speedOf(f.clip);
  const cur = tlLen(f.clip);
  const v = await promptDialog(t('Изменить длительность'), t('Длительность в секундах (или мин:сек)'), dec(Math.round(cur * 100) / 100), {
    okText: t('Применить'),
    hint: t('Можно от {min} до {max} — дальше в файле нет кадров. Видео справа сдвинется, если не хватит места.', { min: dec(MIN_CLIP), max: fmtTime(max) }),
    validate: (s) => {
      const d = parseDuration(s);
      if (!isFinite(d)) return t('Введите число, например 5 или 1:30');
      if (d < MIN_CLIP) return t('Слишком коротко');
      return null;
    },
  });
  if (v === null) return;
  const d = parseDuration(v);
  const got = store.setClipDuration(id, d);
  if (got !== false && got < d - 0.01) toast(t('В файле хватило кадров только на {time}', { time: fmtTime(got) }), 'info', 3000);
}

export function toggleMute(id) {
  const f = store.findClip(id);
  if (f) store.setClip(id, { muted: !f.clip.muted });
}

export function focusInspector(section = null) {
  store.emit('focus-inspector', section);
}

// Контекстное меню клипа. clickTime — время под курсором мыши (для разреза/стоп-кадра, если курсор не на клипе)
export function openClipMenu(id, x, y, clickTime = null) {
  const f = store.findClip(id);
  if (!f) return;
  const c = f.clip;
  const m = store.media(c.mediaId) || {};
  const video = f.kind === 'video';
  const at = inside(c, store.time) ? store.time : (clickTime !== null && inside(c, clickTime) ? clickTime : null);
  const freezeAt = c.start <= store.time && store.time < clipEnd(c) ? store.time : (clickTime ?? c.start);
  const rev = isReversed(c);
  const busy = !!store.busy[id];
  const hasSound = video ? m.hasAudio : true;
  openMenu(x, y, [
    { id: 'duplicate', label: t('Дублировать'), icon: 'duplicate', key: keyHint('clip.duplicate'), onClick: () => store.duplicateClip(id) },
    { id: 'copy', label: t('Копировать'), icon: 'copy', key: keyHint('clip.copy'), onClick: () => copyClip(id) },
    { id: 'paste', label: t('Вставить'), icon: 'paste', key: keyHint('clip.paste'), disabled: !store.clipboard, onClick: () => pasteClip(store.time, video ? 'video' : f.track.id) },
    { id: 'delete', label: t('Удалить'), icon: 'trash', key: keyHint('clip.delete'), onClick: () => deleteClip(id) },
    { id: 'ripple-delete', label: t('Удалить и сдвинуть'), icon: 'gapclose', key: keyHint('clip.rippleDelete'), onClick: () => deleteClip(id, true) },
    'sep',
    { id: 'split', label: t('Разделить'), icon: 'split', key: keyHint('clip.split'), disabled: at === null, onClick: () => splitClip(id, at) },
    video ? { id: 'freeze', label: t('Создать стоп-кадр'), icon: 'freeze', key: keyHint('clip.freeze'), disabled: busy || isFreeze(c), onClick: () => freezeFrame(freezeAt) } : null,
    { id: 'duration', label: t('Изменить длительность'), icon: 'clock', onClick: () => changeDuration(id) },
    { id: 'rename', label: t('Переименовать'), icon: 'rename', onClick: () => renameClip(id) },
    { id: 'reverse', label: rev ? t('Убрать отзеркаливание') : t('Отзеркалить (задом наперёд)'), icon: 'reverse', key: keyHint('clip.reverse'), disabled: busy || isFreeze(c), onClick: () => reverseClip(id) },
    'sep',
    hasSound ? { id: 'mute', label: c.muted ? t('Включить звук') : t('Выключить звук'), icon: c.muted ? 'speaker' : 'mute', onClick: () => toggleMute(id) } : null,
    { id: 'fade', label: t('Затухание и появление…'), icon: 'fade', onClick: () => { store.select({ kind: f.kind, id }); focusInspector('fade'); } },
    { id: 'more', label: t('Дополнительные варианты'), icon: 'more', onClick: () => { store.select({ kind: f.kind, id }); focusInspector(); } },
  ]);
}

// Меню пустого места дорожки
export function openLaneMenu(lane, x, y, time) {
  const gap = store.gaps(lane).find(([a, b]) => time >= a && time <= b);
  openMenu(x, y, [
    { id: 'paste', label: t('Вставить сюда'), icon: 'paste', key: keyHint('clip.paste'), disabled: !store.clipboard, onClick: () => pasteClip(time, lane) },
    gap ? { id: 'close-gap', label: t('Удалить пустоту'), icon: 'gapclose', onClick: () => store.closeGap(lane, time) } : null,
    store.gaps(lane).length ? { id: 'close-all-gaps', label: t('Убрать все пустоты на дорожке'), icon: 'gapclose', onClick: () => store.closeAllGaps(lane) } : null,
  ]);
}
