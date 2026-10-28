// Действия над клипами: общие для контекстного меню, горячих клавиш и инспектора.
import { store, MIN_CLIP } from './store.js';
import { toast, promptDialog, parseDuration, fmtTime } from './util.js';
import { openMenu } from './contextMenu.js';
import { toggleReverse, freezeFrameAt, isReversed, isFreeze } from './fx.js';

const clipEnd = (c) => c.start + c.out - c.in;
const inside = (c, t) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2;

export function splitClip(id, t = store.time) {
  const f = store.findClip(id);
  if (!f || !inside(f.clip, t)) { toast('Поставьте курсор внутрь клипа, чтобы разрезать', 'info', 2200); return false; }
  return store.splitAt(t, id) > 0;
}

export function deleteClip(id, ripple = false) {
  if (!store.findClip(id)) return;
  store.deleteClip(id, { ripple });
}

export function copyClip(id) {
  if (store.copyClip(id)) toast('Клип скопирован', 'info', 1400);
}

export function pasteClip(at = store.time, lane = null) {
  if (!store.clipboard) { toast('Сначала скопируйте клип (Ctrl+C)', 'info', 2000); return; }
  if (!store.paste(at, lane)) toast('Файл скопированного клипа убран из проекта', 'error');
}

export async function reverseClip(id) {
  try { await toggleReverse(id); } catch (e) { toast(`Реверс не получился: ${e.message}`, 'error', 5000); }
}

export async function freezeFrame(t = store.time) {
  try { await freezeFrameAt(t, 3); } catch (e) { toast(`Стоп-кадр: ${e.message}`, 'error', 4000); }
}

export async function renameClip(id) {
  const f = store.findClip(id);
  if (!f) return;
  const v = await promptDialog('Переименовать клип', 'Название на таймлайне', store.clipName(f.clip), {
    okText: 'Переименовать', hint: 'Оставьте пустым, чтобы вернуть имя файла. Файл на диске не меняется.',
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
  const max = m ? m.duration - f.clip.in : f.clip.out - f.clip.in;
  const cur = f.clip.out - f.clip.in;
  const v = await promptDialog('Изменить длительность', 'Длительность в секундах (или мин:сек)', String(Math.round(cur * 100) / 100).replace('.', ','), {
    okText: 'Применить',
    hint: `Можно от ${String(MIN_CLIP).replace('.', ',')} до ${fmtTime(max)} — дальше в файле нет кадров. Видео справа сдвинется, если не хватит места.`,
    validate: (s) => {
      const d = parseDuration(s);
      if (!isFinite(d)) return 'Введите число, например 5 или 1:30';
      if (d < MIN_CLIP) return 'Слишком коротко';
      return null;
    },
  });
  if (v === null) return;
  const d = parseDuration(v);
  const got = store.setClipDuration(id, d);
  if (got !== false && got < d - 0.01) toast(`В файле хватило кадров только на ${fmtTime(got)}`, 'info', 3000);
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
    { id: 'duplicate', label: 'Дублировать', icon: 'duplicate', key: 'Ctrl+D', onClick: () => store.duplicateClip(id) },
    { id: 'copy', label: 'Копировать', icon: 'copy', key: 'Ctrl+C', onClick: () => copyClip(id) },
    { id: 'paste', label: 'Вставить', icon: 'paste', key: 'Ctrl+V', disabled: !store.clipboard, onClick: () => pasteClip(store.time, video ? 'video' : f.track.id) },
    { id: 'delete', label: 'Удалить', icon: 'trash', key: 'Del', onClick: () => deleteClip(id) },
    { id: 'ripple-delete', label: 'Удалить и сдвинуть', icon: 'gapclose', key: 'Shift+Del', onClick: () => deleteClip(id, true) },
    'sep',
    { id: 'split', label: 'Разделить', icon: 'split', key: 'S', disabled: at === null, onClick: () => splitClip(id, at) },
    video ? { id: 'freeze', label: 'Создать стоп-кадр', icon: 'freeze', key: 'F', disabled: busy || isFreeze(c), onClick: () => freezeFrame(freezeAt) } : null,
    { id: 'duration', label: 'Изменить длительность', icon: 'clock', onClick: () => changeDuration(id) },
    { id: 'rename', label: 'Переименовать', icon: 'rename', onClick: () => renameClip(id) },
    { id: 'reverse', label: rev ? 'Убрать отзеркаливание' : 'Отзеркалить (задом наперёд)', icon: 'reverse', key: 'R', disabled: busy || isFreeze(c), onClick: () => reverseClip(id) },
    'sep',
    hasSound ? { id: 'mute', label: c.muted ? 'Включить звук' : 'Выключить звук', icon: c.muted ? 'speaker' : 'mute', onClick: () => toggleMute(id) } : null,
    { id: 'fade', label: 'Затухание и появление…', icon: 'fade', onClick: () => { store.select({ kind: f.kind, id }); focusInspector('fade'); } },
    { id: 'more', label: 'Дополнительные варианты', icon: 'more', onClick: () => { store.select({ kind: f.kind, id }); focusInspector(); } },
  ]);
}

// Меню пустого места дорожки
export function openLaneMenu(lane, x, y, t) {
  const gap = store.gaps(lane).find(([a, b]) => t >= a && t <= b);
  openMenu(x, y, [
    { id: 'paste', label: 'Вставить сюда', icon: 'paste', key: 'Ctrl+V', disabled: !store.clipboard, onClick: () => pasteClip(t, lane) },
    gap ? { id: 'close-gap', label: 'Удалить пустоту', icon: 'gapclose', onClick: () => store.closeGap(lane, t) } : null,
    store.gaps(lane).length ? { id: 'close-all-gaps', label: 'Убрать все пустоты на дорожке', icon: 'gapclose', onClick: () => store.closeAllGaps(lane) } : null,
  ]);
}
