// Вкладка «Текст» правой колонки (M5.3): стили текстовых блоков из реестра (встроенные core + плагины),
// субтитры (новая дорожка, импорт файла) и шрифты (свои файлы .ttf/.otf).
// Щелчок по стилю — текстовый клип в месте курсора на свободной верхней видеодорожке.
import { store } from './store.js';
import { h, icon, t, toast, errText } from './util.js';
import { getLang } from './i18n.js';
import { listTextStyles } from './registry.js';
import './core/textStyles.js';
import { drawText } from './textRender.js';
import { fontList, addFonts, removeFont } from './fonts.js';
import { importSubtitles } from './subtitlesUi.js';

const label = (v, fb = '') => (typeof v === 'string' ? v : v && typeof v === 'object' ? v[getLang()] || v.ru || v.en || fb : fb);

// Миниатюра стиля: образец текста на тёмном фоне, кадр 16:9
function thumb(style) {
  const W = 192; const H = 108;
  const cv = h('canvas', { class: 'ts-thumb', width: String(W * 2), height: String(H * 2) });
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W * 2, H * 2);
  g.addColorStop(0, '#3a4660'); g.addColorStop(1, '#1b2030');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W * 2, H * 2);
  const clip = { id: 'thumb', kind: 'text', in: 0, out: style.duration, start: 0, text: { ...style.text }, transform: style.transform || undefined };
  // Титры — показываем середину проезда
  try { drawText(ctx, clip, W * 2, H * 2, { local: style.duration * 0.55 }); } catch (e) { console.warn('text thumb', e); }
  return cv;
}

export function addTextFromStyle(style) {
  const c = store.addTextClip({ style });
  if (!c) { toast(t('Нет свободной дорожки для текста'), 'error'); return null; }
  store.emit('focus-inspector', 'text');
  return c;
}

export function renderTextPanel(root) {
  if (!root || root.hidden) return;
  root.innerHTML = '';
  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Текст'))),
    h('p', { class: 'muted small' }, t('Щелчок — текст в месте курсора, на верхней видеодорожке. Двигать, масштабировать и поворачивать — рамкой в плеере, оформление — в «Свойствах».')));
  const grid = h('div', { class: 'ts-grid' });
  for (const st of listTextStyles()) {
    const name = label(st.name, st.id);
    grid.append(h('button', { class: 'ts-tile', dataset: { style: st.id }, title: name, onclick: () => addTextFromStyle(st) }, thumb(st), h('span', {}, name)));
  }
  root.append(grid);

  // --- Субтитры ---
  const subs = store.subtitleTracks();
  root.append(h('div', { class: 'insp-section' }, h('h3', {}, t('Субтитры')),
    h('p', { class: 'muted small' }, subs.length
      ? t('Дорожек: {n}, реплик: {c}. Реплики — на таймлайне под видео; оформление — щелчок по заголовку дорожки.', { n: subs.length, c: subs.reduce((s, x) => s + x.cues.length, 0) })
      : t('Субтитры лежат на своей дорожке под видео: каждая реплика — время и текст. Можно открыть SRT, VTT или ASS.')),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn small', id: 'subs-new', onclick: () => { const id = store.addSubtitleTrack(); store.addCue(id, { start: store.time, text: t('Новая реплика') }); store.select({ kind: 'strack', id }); } },
        h('span', { html: icon('plus', 15) }), t('Новая дорожка')),
      h('button', { class: 'btn ghost small', id: 'subs-import', onclick: () => importSubtitles() }, h('span', { html: icon('upload', 15) }), t('Открыть файл…')))));

  // --- Шрифты ---
  const fonts = fontList();
  const user = fonts.filter((f) => !f.builtin);
  const fsec = h('div', { class: 'insp-section' }, h('h3', {}, t('Шрифты')),
    h('p', { class: 'muted small' }, t('Встроены Inter и Open Sans (с кириллицей). Свои шрифты (.ttf, .otf) копируются в папку программы user-fonts и попадают и в плеер, и в экспорт.')));
  for (const f of user) {
    const del = h('button', { class: 'icon-btn tiny', title: t('Убрать шрифт'), onclick: async () => { try { await removeFont(f.file); } catch (e) { toast(errText(e), 'error'); } } });
    del.innerHTML = icon('close', 13);
    fsec.append(h('div', { class: 'row between font-row' }, h('span', { style: { fontFamily: `"${f.name}"` } }, f.name), del));
  }
  fsec.append(h('div', { class: 'row gap wrap' },
    h('button', { class: 'btn ghost small', onclick: async () => {
      try { const added = await addFonts(); if (added.length) toast(t('Добавлены шрифты: {list}', { list: added.join(', ') }), 'success', 3000); } catch (e) { toast(t('Шрифт не добавлен: {err}', { err: errText(e) }), 'error', 5000); }
    } }, h('span', { html: icon('plus', 15) }), t('Добавить шрифт…')),
    h('button', { class: 'btn ghost small', onclick: () => window.api.fontsOpenDir() }, t('Открыть папку'))));
  root.append(fsec);
}
