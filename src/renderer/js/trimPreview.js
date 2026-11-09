// Двойной кадр в плеере во время обрезки (0.4.3, как в Resolve): слева и справа — кадры по обе стороны правки
// (roll — конец левого и начало правого клипа, slip — первый и последний кадр клипа, slide — соседи, ripple — край).
// Таймлайн шлёт store.emit('trim-preview', { op, frames: [{ clip, src } | null, …] }) и null, когда закончил.
import { store } from './store.js';
import { h, fmtTime } from './util.js';
import { t } from './i18n.js';
import { playUrl } from './media.js';
import { isText, isGraphic, textTitle } from './textModel.js';

const OP_TITLE = {
  roll: () => t('Roll — стык двух клипов'),
  slip: () => t('Slip — содержимое внутри клипа'),
  slide: () => t('Slide — клип между соседями'),
  'ripple-l': () => t('Ripple — начало клипа'),
  'ripple-r': () => t('Ripple — конец клипа'),
};

export function initTrimPreview(preview) {
  const pane = (side) => {
    const video = h('video', { muted: true, preload: 'auto', playsinline: true });
    video.muted = true;
    const img = h('img', { draggable: 'false' });
    const note = h('div', { class: 'tp-note' });
    const tc = h('div', { class: 'tp-tc' });
    return { side, video, img, note, tc, el: h('div', { class: `tp-pane ${side}` }, video, img, note, tc) };
  };
  const L = pane('l'); const R = pane('r');
  const title = h('div', { class: 'tp-title' });
  const box = h('div', { class: 'trim-preview', id: 'trim-preview' }, title, h('div', { class: 'tp-panes' }, L.el, R.el));
  preview.stage.append(box);

  const show = (p, f) => {
    p.el.classList.toggle('empty', !f);
    p.video.style.display = 'none'; p.img.style.display = 'none'; p.note.textContent = ''; p.tc.textContent = '';
    if (!f) { p.note.textContent = t('пусто'); return; }
    const c = f.clip;
    // Время файла: при roll / slip видно, какой именно кадр станет краем клипа
    p.tc.textContent = `${store.clipName(c)} · ${fmtTime(Math.max(0, f.src))}`;
    if (isText(c)) { p.note.textContent = textTitle(c) || t('Текст'); return; }
    if (isGraphic(c)) { p.note.textContent = store.clipName(c); return; }
    const m = store.media(c.mediaId) || {};
    const url = playUrl(c.mediaId);
    if (!url) { p.note.textContent = t('Подготовка файла…'); return; }
    if (m.isImage && !m.isAnimation) {
      if (p.img.dataset.url !== url) { p.img.dataset.url = url; p.img.src = url; }
      p.img.style.display = 'block';
      return;
    }
    p.video.style.display = 'block';
    if (p.video.dataset.url !== url) { p.video.dataset.url = url; p.video.src = url; }
    const want = Math.max(0, Math.min((m.duration || f.src + 1) - 0.04, f.src));
    // Перемотка по последнему запросу: пока элемент ищет кадр, следующий запрос ждёт (без очереди перемоток)
    p.want = want;
    if (!p.video.seeking && Math.abs(p.video.currentTime - want) > 0.01) p.video.currentTime = want;
  };
  for (const p of [L, R]) p.video.addEventListener('seeked', () => { if (p.want !== undefined && Math.abs(p.video.currentTime - p.want) > 0.01) p.video.currentTime = p.want; });

  store.on('trim-preview', (info) => {
    if (!info || !info.frames) { box.classList.remove('on'); return; }
    if (preview.playing) preview.pause();
    title.textContent = (OP_TITLE[info.op] || (() => ''))();
    show(L, info.frames[0]); show(R, info.frames[1]);
    box.classList.add('on');
  });
}
