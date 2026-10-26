// Правая панель: свойства выделенного клипа или сведения о проекте.
import { store } from './store.js';
import { h, $, fmtTime, fmtDur, fmtBytes, icon, iconEl } from './util.js';

export function initInspector({ onSplit, onDelete }) {
  const root = $('#inspector');
  let liveBefore = null; // снимок для слайдера громкости (одна запись в истории за жест)

  const render = () => {
    // Не перерисовываем, пока пользователь тянет слайдер — иначе он «отпустится»
    if (liveBefore) return;
    root.innerHTML = '';
    const sel = store.selection ? store.findClip(store.selection.id) : null;
    if (!sel) return renderProject();
    const { kind, clip } = sel;
    const m = store.media(clip.mediaId) || {};
    const dur = clip.out - clip.in;

    root.append(h('div', { class: 'panel-head' }, h('h2', {}, kind === 'video' ? 'Видеоклип' : 'Аудиоклип')));
    root.append(h('div', { class: 'insp-file', title: m.path },
      iconEl(kind === 'video' ? 'film' : 'music', 18), h('span', {}, m.name || '?')));

    // --- Звук ---
    const sec = h('div', { class: 'insp-section' }, h('h3', {}, 'Звук'));
    if (!m.hasAudio) {
      sec.append(h('p', { class: 'muted small' }, 'В этом файле нет звуковой дорожки.'));
    } else {
      const pct = Math.round(clip.volume * 100);
      const val = h('span', { class: 'vol-val' }, `${pct}%`);
      const slider = h('input', { type: 'range', min: '0', max: '200', step: '1', value: String(pct), class: 'slider' });
      slider.addEventListener('pointerdown', () => { liveBefore = store.snapshot(); });
      slider.addEventListener('input', () => {
        const v = Number(slider.value) / 100;
        val.textContent = `${slider.value}%`;
        if (liveBefore) store.live(() => { store.findClip(clip.id).clip.volume = v; });
        else store.setClip(clip.id, { volume: v });
      });
      const finish = () => { if (liveBefore) { const b = liveBefore; liveBefore = null; store.commitFrom(b); render(); } };
      slider.addEventListener('pointerup', finish);
      slider.addEventListener('change', finish);
      slider.addEventListener('dblclick', () => store.setClip(clip.id, { volume: 1 }));
      const muteBtn = h('button', { class: `btn toggle${clip.muted ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { muted: !clip.muted }) },
        h('span', { html: icon(clip.muted ? 'mute' : 'speaker', 17) }), clip.muted ? 'Звук выключен' : 'Выключить звук');
      sec.append(
        h('div', { class: 'row between' }, h('label', {}, 'Громкость'), val),
        slider,
        h('div', { class: 'presets' },
          ...[0, 50, 100, 150, 200].map((p) => h('button', { class: `chip${pct === p ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { volume: p / 100 }) }, `${p}%`))),
        muteBtn);
    }
    root.append(sec);

    // --- Обрезка ---
    const trim = h('div', { class: 'insp-section' }, h('h3', {}, 'Обрезка'));
    const info = [
      ['Длительность', fmtTime(dur)],
      ['Из файла: начало', fmtTime(clip.in)],
      ['Из файла: конец', fmtTime(clip.out)],
    ];
    if (kind === 'audio') info.push(['На таймлайне с', fmtTime(clip.start)]);
    else {
      const seg = store.videoLayout().find((s) => s.clip.id === clip.id);
      if (seg) info.push(['На таймлайне', `${fmtTime(seg.start)} – ${fmtTime(seg.end)}`]);
    }
    trim.append(h('dl', { class: 'kv' }, ...info.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    trim.append(h('p', { class: 'muted small' }, 'Тяните края клипа на таймлайне, чтобы обрезать. Клавиша S разрезает клип по курсору.'));
    const resetBtn = h('button', { class: 'btn ghost small', disabled: clip.in === 0 && Math.abs(clip.out - m.duration) < 0.001,
      onclick: () => store.setClip(clip.id, { in: 0, out: m.duration }) }, 'Вернуть исходную длину');
    trim.append(resetBtn);
    root.append(trim);

    // --- Действия ---
    root.append(h('div', { class: 'insp-section actions' },
      h('button', { class: 'btn', onclick: onSplit }, h('span', { html: icon('split', 17) }), 'Разрезать (S)'),
      h('button', { class: 'btn', onclick: () => store.duplicateClip(clip.id) }, 'Дублировать (Ctrl+D)'),
      h('button', { class: 'btn danger-ghost', onclick: onDelete }, h('span', { html: icon('trash', 17) }), 'Удалить (Del)')));

    // --- Исходный файл ---
    root.append(fileInfo(m));
  };

  function fileInfo(m) {
    const rows = [];
    if (m.hasVideo) {
      rows.push(['Разрешение', `${m.width}×${m.height}`], ['Частота', `${Math.round(m.fps * 100) / 100} fps`],
        ['Видеокодек', `${(m.vcodec || '').toUpperCase()}${m.pixFmt && /10/.test(m.pixFmt) ? ' 10 бит' : ''}`]);
      if (m.vbitrate || m.bitrate) rows.push(['Битрейт', `${((m.vbitrate || m.bitrate) / 1e6).toFixed(1).replace('.', ',')} Мбит/с`]);
    }
    if (m.hasAudio) rows.push(['Звук', `${(m.acodec || '').toUpperCase()}, ${Math.round((m.sampleRate || 0) / 1000)} кГц, ${m.channels === 1 ? 'моно' : m.channels === 2 ? 'стерео' : `${m.channels} кан.`}`]);
    rows.push(['Длительность', fmtDur(m.duration)], ['Размер', fmtBytes(m.size)]);
    return h('div', { class: 'insp-section' }, h('h3', {}, 'Исходный файл'),
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('p', { class: 'muted small path' }, m.path || ''));
  }

  function renderProject() {
    const f = store.sourceFormat();
    const nClips = store.project.videoClips.length + store.project.audioTracks.reduce((s, t) => s + t.clips.length, 0);
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Проект')));
    root.append(h('div', { class: 'insp-section' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Формат'), h('dd', {}, f.fromClip ? `${f.width}×${f.height}, ${f.fps} fps` : 'по видео на таймлайне'),
        h('dt', {}, 'Длительность'), h('dd', {}, fmtTime(store.duration())),
        h('dt', {}, 'Клипов'), h('dd', {}, String(nClips)),
        h('dt', {}, 'Файлов'), h('dd', {}, String(Object.keys(store.project.media).length))),
      h('p', { class: 'muted small' }, 'Формат проекта берётся из самого крупного видео на таймлайне. При экспорте можно выбрать другой.')));
    root.append(h('div', { class: 'insp-section' }, h('h3', {}, 'Горячие клавиши'),
      h('dl', { class: 'kv keys' }, ...[
        ['Пробел', 'Пуск / пауза'], ['S', 'Разрезать'], ['Delete', 'Удалить клип'], ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'],
        ['← →', 'На кадр (с Shift — на 1 с)'], ['Home / End', 'В начало / конец'], ['Ctrl + колесо', 'Масштаб таймлайна'],
        ['Ctrl+D', 'Дублировать клип'], ['Ctrl+S', 'Сохранить проект'], ['Ctrl+E', 'Экспорт'], ['Ctrl+I', 'Импорт медиа'],
      ].flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))));
  }

  store.on('selection', render);
  store.on('project', render);
  store.on('media', () => { if (!store.selection) render(); });
  render();
}
