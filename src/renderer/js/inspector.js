// Правая панель: свойства выделенного клипа / перехода или сведения о проекте.
import { store, MAX_FADE } from './store.js';
import { h, $, fmtTime, fmtDur, fmtBytes, icon, iconEl } from './util.js';
import { TRANSITIONS, transitionById, applyTransition, DEFAULT_DURATION, MIN_DURATION } from './transitions.js';
import { maxTransition } from './store.js';
import { reverseClip, freezeFrame, renameClip, changeDuration, copyClip } from './actions.js';
import { isReversed, isFreeze } from './fx.js';

const num = (x, d = 1) => String(Math.round(x * 10 ** d) / 10 ** d).replace('.', ',');

export function initInspector({ onSplit, onDelete }) {
  const root = $('#inspector');
  let liveBefore = null; // снимок для слайдеров (одна запись в истории за жест)
  let focusSection = null;

  // Слайдер, который меняет проект «вживую» и пишет в историю один раз за жест
  function liveSlider({ min, max, step, value, onLive, onCommit, format }) {
    const val = h('span', { class: 'vol-val' }, format(value));
    const slider = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'slider' });
    slider.addEventListener('pointerdown', () => { liveBefore = store.snapshot(); });
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      val.textContent = format(v);
      if (liveBefore) store.live(() => onLive(v));
      else onCommit(v);
    });
    const finish = () => { if (liveBefore) { const b = liveBefore; liveBefore = null; store.commitFrom(b); render(); } };
    slider.addEventListener('pointerup', finish);
    slider.addEventListener('change', finish);
    return { slider, val };
  }

  // Числовое поле «0,8 с» рядом со слайдером
  function secInput(value, max, onSet) {
    const inp = h('input', { class: 'input sec', type: 'text', value: num(value), title: 'Секунды' });
    const apply = () => {
      const v = Number(String(inp.value).replace(',', '.'));
      if (isFinite(v)) onSet(Math.max(0, Math.min(max, v))); else inp.value = num(value);
    };
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } e.stopPropagation(); });
    return h('label', { class: 'sec-wrap' }, inp, h('span', {}, 'с'));
  }

  const render = () => {
    // Не перерисовываем, пока пользователь тянет слайдер — иначе он «отпустится»
    if (liveBefore) return;
    root.innerHTML = '';
    const s = store.selection;
    if (s && s.kind === 'transition') return renderTransition(s.id);
    const sel = s ? store.findClip(s.id) : null;
    if (!sel) return renderProject();
    const { kind, clip } = sel;
    const m = store.media(clip.mediaId) || {};
    const srcMedia = m.derived ? store.media(m.derived.from) || m : m;
    const dur = clip.out - clip.in;

    root.append(h('div', { class: 'panel-head' }, h('h2', {}, kind === 'video' ? 'Видеоклип' : 'Аудиоклип')));
    root.append(h('div', { class: 'insp-file', title: srcMedia.path },
      iconEl(kind === 'video' ? 'film' : 'music', 18), h('span', {}, store.clipName(clip)),
      isReversed(clip) ? h('span', { class: 'tag', title: 'Играет задом наперёд' }, 'реверс') : null,
      isFreeze(clip) ? h('span', { class: 'tag' }, 'стоп-кадр') : null));
    if (store.busy[clip.id]) root.append(h('p', { class: 'muted small' }, `${store.busy[clip.id].label}… подождите`));

    // --- Звук ---
    const sec = h('div', { class: 'insp-section', dataset: { section: 'audio' } }, h('h3', {}, 'Звук'));
    if (!m.hasAudio) {
      sec.append(h('p', { class: 'muted small' }, isFreeze(clip) ? 'У стоп-кадра нет звука.' : 'В этом файле нет звуковой дорожки.'));
    } else if (kind === 'video' && clip.noAudio) {
      const partners = store.linkedOf(clip.id).filter((x) => x.kind === 'audio');
      sec.append(
        h('p', { class: 'muted small' }, partners.length
          ? `Звук этого клипа — на аудиодорожке (${partners.map((x) => store.trackName(x.track.id)).join(', ')}): громкость и затухание — у аудиоклипа.`
          : 'Звук этого клипа удалён с аудиодорожки.'),
        h('button', { class: 'btn', onclick: () => store.restoreOwnAudio(clip.id) }, h('span', { html: icon('speaker', 17) }), 'Вернуть звук в видеоклип'));
    } else {
      const pct = Math.round(clip.volume * 100);
      const { slider, val } = liveSlider({
        min: 0, max: 200, step: 1, value: pct, format: (v) => `${v}%`,
        onLive: (v) => { store.findClip(clip.id).clip.volume = v / 100; },
        onCommit: (v) => store.setClip(clip.id, { volume: v / 100 }),
      });
      slider.addEventListener('dblclick', () => store.setClip(clip.id, { volume: 1 }));
      const muteBtn = h('button', { class: `btn toggle${clip.muted ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { muted: !clip.muted }) },
        h('span', { html: icon(clip.muted ? 'mute' : 'speaker', 17) }), clip.muted ? 'Звук выключен' : 'Выключить звук');
      sec.append(
        h('div', { class: 'row between' }, h('label', {}, 'Громкость'), val),
        slider,
        h('div', { class: 'presets' },
          ...[0, 50, 100, 150, 200].map((p) => h('button', { class: `chip${pct === p ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { volume: p / 100 }) }, `${p}%`))),
        muteBtn);
      if (kind === 'video') {
        sec.append(h('button', { class: 'btn', onclick: () => store.detachAudio(clip.id) }, h('span', { html: icon('music', 17) }), 'Вынести звук на аудиодорожку'));
      } else {
        const tr = sel.track;
        sec.append(h('p', { class: 'muted small' }, `Дорожка «${store.trackName(tr.id)}»: громкость ${Math.round((tr.volume ?? 1) * 100)}% (умножается на громкость клипа; ползунок — в заголовке дорожки).`));
        if (clip.link) sec.append(h('button', { class: 'btn', onclick: () => store.unlink(clip.id) }, h('span', { html: icon('link', 17) }), 'Отвязать от видео'));
      }
    }
    root.append(sec);

    // --- Затухание ---
    const maxFade = Math.min(MAX_FADE, dur);
    const fade = h('div', { class: 'insp-section', dataset: { section: 'fade' } }, h('h3', {}, 'Затухание'));
    const fadeRow = (label, key, other) => {
      const lim = () => Math.max(0, Math.min(maxFade, dur - (clip[other] || 0)));
      const { slider } = liveSlider({
        min: 0, max: Math.round(maxFade * 10) / 10, step: 0.1, value: clip[key] || 0, format: (v) => num(v),
        onLive: (v) => { store.findClip(clip.id).clip[key] = Math.min(v, lim()); },
        onCommit: (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }),
      });
      return [h('div', { class: 'row between' }, h('label', {}, label), secInput(clip[key] || 0, maxFade, (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }))), slider];
    };
    fade.append(
      ...fadeRow('Постепенное возникновение', 'fadeIn', 'fadeOut'),
      ...fadeRow('Постепенное исчезание', 'fadeOut', 'fadeIn'),
      h('p', { class: 'muted small' }, kind === 'video'
        ? 'Картинка проявляется из чёрного и уходит в чёрный, звук клипа — плавно. Можно тянуть кружки в углах выделенного клипа.'
        : 'Звук плавно нарастает и затихает. Можно тянуть кружки в углах выделенного клипа.'));
    root.append(fade);

    // --- Обрезка ---
    const trim = h('div', { class: 'insp-section', dataset: { section: 'trim' } }, h('h3', {}, 'Обрезка'));
    const info = [
      ['Длительность', fmtTime(dur)],
      ['На таймлайне', `${fmtTime(clip.start)} – ${fmtTime(clip.start + dur)}`],
    ];
    if (!m.derived) info.push(['Из файла', `${fmtTime(clip.in)} – ${fmtTime(clip.out)}`]);
    trim.append(h('dl', { class: 'kv' }, ...info.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    trim.append(h('p', { class: 'muted small' }, 'Тяните края клипа на таймлайне, чтобы обрезать. Клавиша S разрезает клип по курсору.'));
    trim.append(h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost small', onclick: () => changeDuration(clip.id) }, h('span', { html: icon('clock', 15) }), 'Длительность…'),
      h('button', { class: 'btn ghost small', disabled: m.derived || (clip.in === 0 && Math.abs(clip.out - m.duration) < 0.001),
        onclick: () => store.setClip(clip.id, { in: 0, out: m.duration }) }, 'Исходная длина')));
    root.append(trim);

    // --- Эффекты и действия ---
    const busy = !!store.busy[clip.id];
    root.append(h('div', { class: 'insp-section actions', dataset: { section: 'actions' } }, h('h3', {}, 'Действия'),
      h('button', { class: `btn${isReversed(clip) ? ' toggle-on' : ''}`, disabled: busy || isFreeze(clip), onclick: () => reverseClip(clip.id) },
        h('span', { html: icon('reverse', 17) }), isReversed(clip) ? 'Убрать отзеркаливание (R)' : 'Отзеркалить — задом наперёд (R)'),
      kind === 'video' ? h('button', { class: 'btn', disabled: busy || isFreeze(clip), onclick: () => freezeFrame(clip.start <= store.time && store.time < clip.start + dur ? store.time : clip.start) },
        h('span', { html: icon('freeze', 17) }), 'Стоп-кадр в позиции курсора (F)') : null,
      h('button', { class: 'btn', onclick: onSplit }, h('span', { html: icon('split', 17) }), 'Разрезать (S)'),
      h('button', { class: 'btn', onclick: () => store.duplicateClip(clip.id) }, h('span', { html: icon('duplicate', 17) }), 'Дублировать (Ctrl+D)'),
      h('button', { class: 'btn', onclick: () => copyClip(clip.id) }, h('span', { html: icon('copy', 17) }), 'Копировать (Ctrl+C)'),
      h('button', { class: 'btn', onclick: () => renameClip(clip.id) }, h('span', { html: icon('rename', 17) }), 'Переименовать'),
      h('button', { class: 'btn danger-ghost', onclick: onDelete }, h('span', { html: icon('trash', 17) }), 'Удалить (Del)')));

    // --- Исходный файл ---
    root.append(fileInfo(srcMedia));
    applyFocus();
  };

  // ---------------- Переход ----------------
  function renderTransition(clipId) {
    const j = store.junctionBefore(clipId);
    if (!j) return renderProject();
    const tr = j.b.transition;
    const mx = maxTransition(j.a, j.b);
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Переход')));
    root.append(h('p', { class: 'muted small' },
      `Между «${store.clipName(j.a)}» и «${store.clipName(j.b)}» на ${fmtTime(j.seam)}. Переход идёт поровну до и после стыка — длина ролика не меняется.`));

    if (tr) {
      const d = h('div', { class: 'insp-section', dataset: { section: 'transition' } }, h('h3', {}, 'Длительность'));
      const { slider } = liveSlider({
        min: MIN_DURATION, max: Math.max(MIN_DURATION, Math.floor(mx * 10) / 10), step: 0.1, value: tr.duration, format: (v) => num(v),
        onLive: (v) => { const b = store.findClip(clipId).clip; if (b.transition) b.transition.duration = v; },
        onCommit: (v) => store.setTransition(clipId, tr.type, v),
      });
      d.append(h('div', { class: 'row between' }, h('label', {}, transitionById(tr.type).name),
        secInput(tr.duration, mx, (v) => store.setTransition(clipId, tr.type, Math.max(MIN_DURATION, v)))), slider,
      h('button', { class: 'btn danger-ghost small', onclick: () => store.setTransition(clipId, null) }, h('span', { html: icon('trash', 15) }), 'Убрать переход'));
      root.append(d);
    } else {
      root.append(h('p', { class: 'muted small' }, 'Выберите переход — он сразу появится на стыке.'));
    }

    const grid = h('div', { class: 'tr-grid', dataset: { section: tr ? 'list' : 'transition' } });
    for (const t of TRANSITIONS) {
      const a = h('div', { class: 'tp-a' }); const b = h('div', { class: 'tp-b' }); const ov = h('div', { class: 'tp-ov' });
      const thumb = h('div', { class: 'tp-thumb' }, a, b, ov);
      const tile = h('button', {
        class: `tr-tile${tr && tr.type === t.id ? ' on' : ''}`, dataset: { type: t.id }, title: t.name,
        onclick: () => store.setTransition(clipId, t.id, tr ? tr.duration : Math.min(DEFAULT_DURATION, mx)),
      }, thumb, h('span', {}, t.name));
      applyTransition(t.id, 0.5, a, b, ov);
      let raf = null; let t0 = 0;
      const anim = (now) => { const p = ((now - t0) / 1400) % 1; applyTransition(t.id, Math.min(1, p * 1.25), a, b, ov); raf = requestAnimationFrame(anim); };
      tile.addEventListener('mouseenter', () => { t0 = performance.now(); raf = requestAnimationFrame(anim); });
      tile.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); applyTransition(t.id, 0.5, a, b, ov); });
      grid.append(tile);
    }
    root.append(h('div', { class: 'insp-section' }, h('h3', {}, tr ? 'Другой переход' : 'Переходы'), grid));
    applyFocus();
  }

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
    const files = Object.values(store.project.media).filter((m) => !m.hidden).length;
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Проект')));
    root.append(h('div', { class: 'insp-section' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Формат'), h('dd', {}, f.fromClip ? `${f.width}×${f.height}, ${f.fps} fps` : 'по видео на таймлайне'),
        h('dt', {}, 'Длительность'), h('dd', {}, fmtTime(store.duration())),
        h('dt', {}, 'Клипов'), h('dd', {}, String(nClips)),
        h('dt', {}, 'Переходов'), h('dd', {}, String(store.transitions().length)),
        h('dt', {}, 'Файлов'), h('dd', {}, String(files))),
      h('p', { class: 'muted small' }, 'Формат проекта берётся из самого крупного видео на таймлайне. При экспорте можно выбрать другой.')));
    root.append(h('div', { class: 'insp-section' }, h('h3', {}, 'Подсказки'),
      h('p', { class: 'muted small' }, 'Правая кнопка мыши на клипе — меню действий. «+» на стыке клипов — переход. Корзина на пустом месте дорожки убирает пустоту.')));
    root.append(h('div', { class: 'insp-section' }, h('h3', {}, 'Горячие клавиши'),
      h('dl', { class: 'kv keys' }, ...[
        ['Пробел', 'Пуск / пауза'], ['S', 'Разрезать клип'], ['Alt+S', 'Разрезать всё под курсором'], ['B / A', 'Лезвие / выделение'], ['Delete', 'Удалить клип'], ['Shift+Delete', 'Удалить и сдвинуть'],
        ['Ctrl+C / Ctrl+V', 'Копировать / вставить'], ['Ctrl+D', 'Дублировать клип'], ['F', 'Стоп-кадр'], ['R', 'Отзеркалить (реверс)'],
        ['Ctrl+Z / Ctrl+Y', 'Отменить / повторить'], ['← →', 'На кадр (с Shift — на 1 с)'], ['Home / End', 'В начало / конец'],
        ['Ctrl + колесо', 'Масштаб таймлайна'], ['Alt при перетаскивании', 'Без магнита и без наложения (раздвинуть)'], ['Shift+F', 'Плеер во весь экран'],
        ['Ctrl+S', 'Сохранить проект'], ['Ctrl+E', 'Экспорт'], ['Ctrl+I', 'Импорт медиа'],
      ].flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))));
  }

  // Прокрутить к нужному разделу и подсветить его
  function applyFocus() {
    if (!focusSection) return;
    const el = root.querySelector(`[data-section="${focusSection}"]`) || root.querySelector('.insp-section');
    focusSection = null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
  }

  store.on('selection', render);
  store.on('project', render);
  store.on('busy', render);
  store.on('media', () => { if (!store.selection) render(); });
  store.on('focus-inspector', (section) => { focusSection = section || 'actions'; render(); });
  render();
}
